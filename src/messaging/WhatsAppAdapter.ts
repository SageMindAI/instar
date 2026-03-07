/**
 * WhatsApp Messaging Adapter — send/receive messages via WhatsApp.
 *
 * Supports two backends:
 * - Baileys (WhatsApp Web protocol): Free, personal use, QR auth
 * - Business API (Meta Cloud API): Paid, enterprise, webhook-based
 *
 * Phase 2 implements the Baileys backend only. Business API is Phase 3.
 *
 * Uses shared infrastructure: MessageLogger, SessionChannelRegistry,
 * StallDetector, CommandRouter, AuthGate, MessagingEventBus.
 */

import path from 'node:path';
import type { MessagingAdapter, Message, OutgoingMessage } from '../core/types.js';
import { MessageLogger } from './shared/MessageLogger.js';
import { SessionChannelRegistry } from './shared/SessionChannelRegistry.js';
import { StallDetector, type StallEvent } from './shared/StallDetector.js';
import { CommandRouter } from './shared/CommandRouter.js';
import { AuthGate } from './shared/AuthGate.js';
import { MessagingEventBus } from './shared/MessagingEventBus.js';
import { smartChunk } from './shared/SmartChunker.js';
import { normalizePhoneNumber, phoneToJid, jidToPhone } from './shared/PhoneUtils.js';
import { PrivacyConsent } from './shared/PrivacyConsent.js';

// ── Config types ──────────────────────────────────────────

export type WhatsAppBackend = 'baileys' | 'business-api';

export interface BaileysConfig {
  /** Path to store auth state (QR code session persistence). Defaults to {stateDir}/whatsapp-auth/ */
  authDir?: string;
  /** Whether to mark as "available" (suppresses phone notifications if true). Default: false */
  markOnline?: boolean;
  /** Reconnect attempts before circuit breaker trips. Default: 10 */
  maxReconnectAttempts?: number;
  /** Auth method: 'qr' (scan QR code) or 'pairing-code' (8-digit code for headless). Default: 'qr' */
  authMethod?: 'qr' | 'pairing-code';
  /** Phone number for pairing code auth (required when authMethod is 'pairing-code') */
  pairingPhoneNumber?: string;
}

export interface BusinessApiConfig {
  /** Phone Number ID from Meta */
  phoneNumberId: string;
  /** Access token */
  accessToken: string;
  /** Webhook verify token */
  webhookVerifyToken: string;
  /** Webhook port (if different from Instar server port) */
  webhookPort?: number;
}

export interface WhatsAppConfig {
  /** Which backend to use. Default: 'baileys' */
  backend?: WhatsAppBackend;

  /** Baileys-specific config */
  baileys?: BaileysConfig;

  /** Business API-specific config (Phase 3) */
  businessApi?: BusinessApiConfig;

  /** Authorized phone numbers (E.164 format: +1234567890). Empty = allow all. */
  authorizedNumbers?: string[];

  /** Voice transcription provider (shared with Telegram) */
  voiceProvider?: string;

  /** Stall detection timeout in minutes. Default: 5 */
  stallTimeoutMinutes?: number;

  /** Promise tracking timeout in minutes. Default: 10 */
  promiseTimeoutMinutes?: number;

  /** Max WhatsApp message length before chunking. Default: 4000 */
  maxMessageLength?: number;

  /** Busy-state handling mode. Default: 'queue' */
  busyMode?: 'queue' | 'interrupt' | 'reject-with-ack';

  /** Max queued messages per session. Default: 10 */
  maxQueuedMessages?: number;

  /** Per-user rate limit (messages per minute). Default: 20 */
  rateLimitPerMinute?: number;

  /** Whether privacy consent is required before processing messages. Default: true */
  requireConsent?: boolean;

  /** Custom privacy consent message */
  consentMessage?: string;
}

// ── Connection state ──────────────────────────────────────

export type ConnectionState = 'disconnected' | 'connecting' | 'qr-pending' | 'connected' | 'reconnecting' | 'closed';

export interface WhatsAppStatus {
  state: ConnectionState;
  phoneNumber: string | null;
  reconnectAttempts: number;
  lastConnected: string | null;
  pendingMessages: number;
  stalledChannels: number;
  registeredSessions: number;
  totalMessagesLogged: number;
}

// ── Adapter implementation ──────────────────────────────────

export class WhatsAppAdapter implements MessagingAdapter {
  readonly platform = 'whatsapp';

  private config: WhatsAppConfig;
  private stateDir: string;
  private messageHandler: ((message: Message) => Promise<void>) | null = null;

  // Connection state
  private connectionState: ConnectionState = 'disconnected';
  private phoneNumber: string | null = null;
  private reconnectAttempts = 0;
  private lastConnected: string | null = null;

  // Shared infrastructure
  private logger: MessageLogger;
  private registry: SessionChannelRegistry;
  private stallDetector: StallDetector;
  private commandRouter: CommandRouter;
  private authGate: AuthGate;
  private eventBus: MessagingEventBus;

  // Message deduplication
  private processedMessageIds = new Set<string>();
  private static readonly DEDUP_MAX_SIZE = 10000;

  // Rate limiting: userId -> timestamps[]
  private rateLimitMap = new Map<string, number[]>();

  // Outbound message queue (for offline periods)
  private outboundQueue: Array<{ channelId: string; text: string }> = [];

  // Privacy consent tracking
  private privacyConsent: PrivacyConsent;

  // Backend send function — injected by BaileysBackend or BusinessApiBackend
  private sendFunction: ((jid: string, text: string) => Promise<void>) | null = null;

  constructor(config: Record<string, unknown>, stateDir: string) {
    this.config = config as unknown as WhatsAppConfig;
    this.stateDir = stateDir;

    const whatsappStateDir = path.join(stateDir, 'whatsapp');

    this.logger = new MessageLogger({
      logPath: path.join(whatsappStateDir, 'messages.jsonl'),
    });

    this.registry = new SessionChannelRegistry({
      registryPath: path.join(whatsappStateDir, 'channel-registry.json'),
    });

    this.stallDetector = new StallDetector({
      stallTimeoutMinutes: this.config.stallTimeoutMinutes ?? 5,
      promiseTimeoutMinutes: this.config.promiseTimeoutMinutes ?? 10,
    });

    this.commandRouter = new CommandRouter('whatsapp');
    this.registerCommands();

    this.authGate = new AuthGate({
      authorizedUsers: (this.config.authorizedNumbers ?? []).map(n => normalizePhoneNumber(n)),
    });

    this.eventBus = new MessagingEventBus('whatsapp');

    this.privacyConsent = new PrivacyConsent({
      consentPath: path.join(whatsappStateDir, 'consent.json'),
      requireConsent: this.config.requireConsent ?? true,
      consentMessage: this.config.consentMessage,
    });

    // Wire stall detector to event bus
    this.stallDetector.setOnStall(async (event, alive) => {
      await this.handleStallEvent(event, alive);
    });
  }

  /** Get the event bus for external subscribers. */
  getEventBus(): MessagingEventBus {
    return this.eventBus;
  }

  /** Get the shared command router (for external command registration). */
  getCommandRouter(): CommandRouter {
    return this.commandRouter;
  }

  /** Get the shared auth gate (for runtime authorize/deauthorize). */
  getAuthGate(): AuthGate {
    return this.authGate;
  }

  /** Get the privacy consent tracker. */
  getPrivacyConsent(): PrivacyConsent {
    return this.privacyConsent;
  }

  /** Set the backend send function (called by BaileysBackend after connection). */
  setSendFunction(fn: (jid: string, text: string) => Promise<void>): void {
    this.sendFunction = fn;
  }

  /** Update connection state (called by backend). */
  async setConnectionState(state: ConnectionState, phoneNumber?: string): Promise<void> {
    this.connectionState = state;
    if (phoneNumber) this.phoneNumber = phoneNumber;
    if (state === 'connected') {
      this.lastConnected = new Date().toISOString();
      this.reconnectAttempts = 0;
      await this.flushOutboundQueue();
    }
  }

  // ── MessagingAdapter interface ──────────────────────────────

  async start(): Promise<void> {
    this.connectionState = 'connecting';
    this.stallDetector.start();
    // Backend connection is handled by BaileysBackend or BusinessApiBackend
    // which calls setConnectionState('connected') when ready
  }

  async stop(): Promise<void> {
    this.stallDetector.stop();
    this.connectionState = 'closed';
    this.eventBus.off();
  }

  async send(message: OutgoingMessage): Promise<void> {
    const channelId = message.channel?.identifier;
    if (!channelId) {
      console.error('[whatsapp] Cannot send: no channel identifier');
      return;
    }

    const jid = channelId.includes('@') ? channelId : phoneToJid(channelId);
    const maxLen = this.config.maxMessageLength ?? 4000;
    const chunks = smartChunk(message.content, maxLen);

    for (const chunk of chunks) {
      if (this.connectionState !== 'connected' || !this.sendFunction) {
        this.outboundQueue.push({ channelId: jid, text: chunk });
        continue;
      }

      try {
        await this.sendFunction(jid, chunk);
      } catch (err) {
        console.error(`[whatsapp] Send failed to ${channelId}: ${err}`);
        this.outboundQueue.push({ channelId: jid, text: chunk });
      }
    }

    // Track outbound for stall detection (promise tracking)
    const sessionName = this.registry.getSessionForChannel(channelId);
    if (sessionName) {
      this.stallDetector.trackOutboundMessage(channelId, sessionName, message.content);
    }

    // Log outbound message
    this.logger.append({
      messageId: Date.now(),
      channelId,
      text: message.content,
      fromUser: false,
      timestamp: new Date().toISOString(),
      sessionName,
    });

    await this.eventBus.emit('message:logged', {
      messageId: Date.now(),
      channelId,
      text: message.content,
      fromUser: false,
      timestamp: new Date().toISOString(),
      sessionName,
    });
  }

  onMessage(handler: (message: Message) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async resolveUser(channelIdentifier: string): Promise<string | null> {
    // WhatsApp: channelIdentifier is a phone number or JID
    try {
      const phone = jidToPhone(channelIdentifier);
      return phone ? normalizePhoneNumber(phone) : null;
    } catch {
      return null;
    }
  }

  // ── Inbound message handling ──────────────────────────────

  /** Called by backend when a message is received. */
  async handleIncomingMessage(
    jid: string,
    messageId: string,
    text: string,
    senderName?: string,
    timestamp?: number,
  ): Promise<void> {
    // Dedup
    if (this.processedMessageIds.has(messageId)) return;
    this.processedMessageIds.add(messageId);
    if (this.processedMessageIds.size > WhatsAppAdapter.DEDUP_MAX_SIZE) {
      // Trim oldest entries (Set preserves insertion order)
      const excess = this.processedMessageIds.size - WhatsAppAdapter.DEDUP_MAX_SIZE;
      let count = 0;
      for (const id of this.processedMessageIds) {
        if (count >= excess) break;
        this.processedMessageIds.delete(id);
        count++;
      }
    }

    const phoneNumber = jidToPhone(jid) ?? jid;
    let normalizedPhone: string;
    try {
      normalizedPhone = normalizePhoneNumber(phoneNumber);
    } catch {
      // Invalid phone number / JID — silently drop
      return;
    }

    // Rate limiting
    if (!this.checkRateLimit(normalizedPhone)) {
      if (this.sendFunction) {
        await this.sendFunction(jid, 'You\'re sending messages too quickly. Please wait a moment.').catch(() => {});
      }
      return;
    }

    // Auth check
    if (!this.authGate.isAuthorized(normalizedPhone)) {
      const result = await this.authGate.handleUnauthorized(
        {
          userId: normalizedPhone,
          displayName: senderName ?? normalizedPhone,
          messageText: text,
        },
        {
          sendResponse: async (msg) => {
            if (this.sendFunction) await this.sendFunction(jid, msg).catch(() => {});
          },
        },
      );

      await this.eventBus.emit('auth:unauthorized', {
        userId: normalizedPhone,
        displayName: senderName ?? normalizedPhone,
        channelId: jid,
        messageText: text,
      });
      return;
    }

    // Privacy consent check (after auth, before processing)
    if (!this.privacyConsent.hasConsent(normalizedPhone)) {
      // Check if this is a consent response
      const consentResult = this.privacyConsent.handleConsentResponse(normalizedPhone, text);
      if (consentResult === 'granted') {
        if (this.sendFunction) {
          await this.sendFunction(jid, 'Thank you! You can now send messages. Type /help to see available commands.').catch(() => {});
        }
        return;
      } else if (consentResult === 'denied') {
        if (this.sendFunction) {
          await this.sendFunction(jid, 'Understood. Your messages will not be processed. Contact us if you change your mind.').catch(() => {});
        }
        return;
      } else if (!this.privacyConsent.isPendingConsent(normalizedPhone)) {
        // First contact — send consent prompt
        this.privacyConsent.markPendingConsent(normalizedPhone);
        if (this.sendFunction) {
          await this.sendFunction(jid, this.privacyConsent.getConsentMessage()).catch(() => {});
        }
        return;
      } else {
        // Pending consent but not a valid response — remind them
        if (this.sendFunction) {
          await this.sendFunction(jid, 'Please reply "yes" to agree or "no" to decline before we can continue.').catch(() => {});
        }
        return;
      }
    }

    const ts = timestamp ? new Date(timestamp * 1000).toISOString() : new Date().toISOString();

    // Log inbound
    this.logger.append({
      messageId: Date.now(),
      channelId: jid,
      text,
      fromUser: true,
      timestamp: ts,
      sessionName: this.registry.getSessionForChannel(jid),
      senderName,
      platformUserId: normalizedPhone,
    });

    await this.eventBus.emit('message:logged', {
      messageId: Date.now(),
      channelId: jid,
      text,
      fromUser: true,
      timestamp: ts,
      sessionName: this.registry.getSessionForChannel(jid),
      senderName,
      platformUserId: normalizedPhone,
    });

    // Command routing
    const handled = await this.commandRouter.route(text, jid, normalizedPhone, { senderName });
    if (handled) {
      await this.eventBus.emit('command:executed', {
        command: this.commandRouter.parse(text)?.command ?? '',
        args: this.commandRouter.parse(text)?.args ?? '',
        channelId: jid,
        userId: normalizedPhone,
        handled: true,
      });
      return;
    }

    // Track for stall detection
    const sessionName = this.registry.getSessionForChannel(jid);
    if (sessionName) {
      this.stallDetector.trackMessageInjection(jid, sessionName, text);
    }

    // Forward to message handler
    if (this.messageHandler) {
      const message: Message = {
        id: messageId,
        content: text,
        channel: { type: 'whatsapp', identifier: jid },
        userId: normalizedPhone,
        receivedAt: ts,
        metadata: { senderName, platform: 'whatsapp' },
      };

      await this.eventBus.emit('message:incoming', {
        channelId: jid,
        userId: normalizedPhone,
        text,
        timestamp: ts,
      });

      try {
        await this.messageHandler(message);
      } catch (err) {
        console.error(`[whatsapp] Message handler error: ${err}`);
      }
    }
  }

  // ── Commands ──────────────────────────────────────────

  private registerCommands(): void {
    this.commandRouter.register(['new', 'reset'], async (ctx) => {
      // Reset session for this channel
      const currentSession = this.registry.getSessionForChannel(ctx.channelId);
      if (currentSession) {
        this.registry.unregister(ctx.channelId);
        this.stallDetector.clearStallForChannel(ctx.channelId);
      }
      if (this.sendFunction) {
        await this.sendFunction(ctx.channelId, 'Session reset. Send a message to start a new conversation.').catch(() => {});
      }
      return true;
    }, { description: 'Reset current session' });

    this.commandRouter.register('stop', async (ctx) => {
      const currentSession = this.registry.getSessionForChannel(ctx.channelId);
      if (currentSession) {
        this.registry.unregister(ctx.channelId);
        this.stallDetector.clearStallForChannel(ctx.channelId);
      }
      // Revoke consent (right to erasure)
      this.privacyConsent.revokeConsent(ctx.userId);
      if (this.sendFunction) {
        await this.sendFunction(ctx.channelId, 'Session stopped and consent revoked. Your data will no longer be processed.').catch(() => {});
      }
      return true;
    }, { description: 'Stop session and revoke consent' });

    this.commandRouter.register('status', async (ctx) => {
      const status = this.getStatus();
      const lines = [
        `*WhatsApp Adapter Status*`,
        `Connection: ${status.state}`,
        `Phone: ${status.phoneNumber ?? 'not connected'}`,
        `Sessions: ${status.registeredSessions}`,
        `Messages logged: ${status.totalMessagesLogged}`,
        `Stalled channels: ${status.stalledChannels}`,
      ];
      if (this.sendFunction) {
        await this.sendFunction(ctx.channelId, lines.join('\n')).catch(() => {});
      }
      return true;
    }, { description: 'Show adapter status' });

    this.commandRouter.register('help', async (ctx) => {
      const help = this.commandRouter.generateHelp();
      if (this.sendFunction) {
        await this.sendFunction(ctx.channelId, help).catch(() => {});
      }
      return true;
    }, { description: 'Show available commands' });

    this.commandRouter.register('whoami', async (ctx) => {
      const phone = jidToPhone(ctx.channelId) ?? ctx.channelId;
      const session = this.registry.getSessionForChannel(ctx.channelId);
      const lines = [
        `Phone: ${phone}`,
        `Session: ${session ?? 'none'}`,
        `Authorized: ${this.authGate.isAuthorized(ctx.userId) ? 'yes' : 'no'}`,
      ];
      if (this.sendFunction) {
        await this.sendFunction(ctx.channelId, lines.join('\n')).catch(() => {});
      }
      return true;
    }, { description: 'Show your identity' });
  }

  // ── Stall handling ──────────────────────────────────────

  private async handleStallEvent(event: StallEvent, alive: boolean): Promise<void> {
    await this.eventBus.emit(
      event.type === 'stall' ? 'stall:detected' : 'stall:promise-expired',
      event.type === 'stall'
        ? {
            channelId: event.channelId,
            sessionName: event.sessionName,
            messageText: event.messageText,
            injectedAt: event.injectedAt,
            minutesElapsed: event.minutesElapsed,
            alive,
          }
        : {
            channelId: event.channelId,
            sessionName: event.sessionName,
            promiseText: event.messageText,
            promisedAt: event.injectedAt,
            minutesElapsed: event.minutesElapsed,
            alive,
          },
    );

    if (!this.sendFunction) return;

    const status = alive ? 'running but not responding' : 'no longer running';
    const msg = event.type === 'stall'
      ? `No response after ${event.minutesElapsed} minutes. Session "${event.sessionName}" is ${status}.\n\nUse /new to start a fresh session.`
      : `The agent promised to follow up but hasn't responded in ${event.minutesElapsed} minutes.\n\nSession "${event.sessionName}" may need a reset. Use /new if needed.`;

    await this.sendFunction(event.channelId, msg).catch(err =>
      console.error(`[whatsapp] Stall alert failed: ${err}`),
    );
  }

  // ── Rate limiting ──────────────────────────────────────

  private checkRateLimit(userId: string): boolean {
    const limit = this.config.rateLimitPerMinute ?? 20;
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;

    const timestamps = this.rateLimitMap.get(userId) ?? [];
    const recent = timestamps.filter(t => t > oneMinuteAgo);
    recent.push(now);
    this.rateLimitMap.set(userId, recent);

    return recent.length <= limit;
  }

  // ── Outbound queue ──────────────────────────────────────

  private async flushOutboundQueue(): Promise<void> {
    if (!this.sendFunction || this.outboundQueue.length === 0) return;

    const queue = [...this.outboundQueue];
    this.outboundQueue = [];

    for (const { channelId, text } of queue) {
      try {
        await this.sendFunction(channelId, text);
      } catch (err) {
        console.error(`[whatsapp] Failed to flush queued message: ${err}`);
      }
    }
  }

  // ── Session management ──────────────────────────────────

  /** Register a channel to a session. */
  registerSession(channelId: string, sessionName: string): void {
    this.registry.register(channelId, sessionName);
  }

  /** Get the session for a channel. */
  getSessionForChannel(channelId: string): string | null {
    return this.registry.getSessionForChannel(channelId);
  }

  /** Get the channel for a session. */
  getChannelForSession(sessionName: string): string | null {
    return this.registry.getChannelForSession(sessionName);
  }

  // ── Status ──────────────────────────────────────────

  getStatus(): WhatsAppStatus {
    const detectorStatus = this.stallDetector.getStatus();
    return {
      state: this.connectionState,
      phoneNumber: this.phoneNumber,
      reconnectAttempts: this.reconnectAttempts,
      lastConnected: this.lastConnected,
      pendingMessages: detectorStatus.pendingStalls,
      stalledChannels: detectorStatus.pendingPromises,
      registeredSessions: this.registry.size,
      totalMessagesLogged: this.logger.getStats().totalMessages,
    };
  }

  /** Increment reconnect attempt counter. Returns current count. */
  incrementReconnectAttempts(): number {
    return ++this.reconnectAttempts;
  }

  /** Get the Baileys config with defaults. */
  getBaileysConfig(): Required<BaileysConfig> {
    const bc = this.config.baileys ?? {};
    return {
      authDir: bc.authDir ?? path.join(this.stateDir, 'whatsapp-auth'),
      markOnline: bc.markOnline ?? false,
      maxReconnectAttempts: bc.maxReconnectAttempts ?? 10,
      authMethod: bc.authMethod ?? 'qr',
      pairingPhoneNumber: bc.pairingPhoneNumber ?? '',
    };
  }
}
