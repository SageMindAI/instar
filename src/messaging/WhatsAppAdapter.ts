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
  /** Override WhatsApp Web protocol version [major, minor, patch]. Auto-fetched if not set. */
  version?: [number, number, number];
  /** Browser identifier [platform, browser, version]. Default: ['Mac OS', 'Chrome', '14.4.1'] (MACOS platform). */
  browser?: [string, string, string];
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

  /** Send typing indicators when processing messages. Baileys only. Default: true */
  sendTypingIndicators?: boolean;

  /** Send read receipts (blue ticks) on message receive. Default: true */
  sendReadReceipts?: boolean;

  /** Emoji to react with on message receive (ack reaction). Set false to disable. Default: '👀' */
  ackReactionEmoji?: string | false;

  /** Prepend agent name to outbound messages for identity clarity. Default: true */
  prefixEnabled?: boolean;

  /** Custom prefix format. Supports WhatsApp markdown. Default: "*[{agentName}]* " */
  messagePrefix?: string;

  /** Agent display name, used in message prefix and group mentions. Default: 'Agent' */
  agentName?: string;

  /** Group messaging configuration */
  groups?: WhatsAppGroupConfig;
}

export interface WhatsAppGroupConfig {
  /** Enable group message handling. Default: false */
  enabled?: boolean;
  /** Authorized group JIDs (@g.us format). Empty = allow all groups the agent is in. */
  authorizedGroups?: string[];
  /** Default activation mode for groups. 'mention' = only respond when @mentioned. 'always' = respond to all messages. Default: 'mention' */
  defaultActivation?: 'mention' | 'always';
  /** Number of recent messages to buffer per group for context. Default: 50 */
  maxContextMessages?: number;
  /** Per-group overrides keyed by group JID */
  groupOverrides?: Record<string, { activation?: 'mention' | 'always' }>;
  /** Prefix agent responses with agent name for clarity (since Baileys uses the user's identity). Default: true */
  prefixResponses?: boolean;
  /** Agent display name for response prefixes. Defaults to the project name. */
  agentName?: string;
}

// ── Backend capabilities ──────────────────────────────────────
// Replaces the single sendFunction pattern. Backends inject their full
// capability set, and the adapter calls available capabilities as needed.

export interface BackendCapabilities {
  /** Send a text message. Required. */
  sendText: (jid: string, text: string) => Promise<void>;
  /** Send typing/composing indicator. Baileys only. */
  sendTyping?: (jid: string) => Promise<void>;
  /** Stop typing indicator. Baileys only. */
  stopTyping?: (jid: string) => Promise<void>;
  /** Mark messages as read (blue ticks). */
  sendReadReceipt?: (jid: string, messageId: string, msgKey?: unknown) => Promise<void>;
  /** React to a message with an emoji. */
  sendReaction?: (jid: string, messageId: string, emoji: string, msgKey?: unknown) => Promise<void>;
}

// ── Connection state ──────────────────────────────────────

export type ConnectionState = 'disconnected' | 'connecting' | 'qr-pending' | 'connected' | 'reconnecting' | 'closed';

export interface WhatsAppStatus {
  state: ConnectionState;
  phoneNumber: string | null;
  reconnectAttempts: number;
  lastConnected: string | null;
  lastError: string | null;
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
  private lastError: string | null = null;

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

  // Group message context buffers: groupJid -> CircularBuffer of recent messages
  private groupMessageBuffers = new Map<string, Array<{ sender: string; senderName?: string; text: string; timestamp: string }>>();
  private static readonly GROUP_BUFFER_MAX = 50;

  // Outbound message queue (for offline periods)
  private outboundQueue: Array<{ channelId: string; text: string }> = [];

  // Privacy consent tracking
  private privacyConsent: PrivacyConsent;

  // Backend capabilities — injected by BaileysBackend or BusinessApiBackend
  private capabilities: BackendCapabilities | null = null;
  // Backward compat alias
  private get sendFunction(): ((jid: string, text: string) => Promise<void>) | null {
    return this.capabilities?.sendText ?? null;
  }

  // QR code state (for dashboard display)
  private currentQrCode: string | null = null;

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
    // Backward compat — wraps into capabilities
    if (this.capabilities) {
      this.capabilities.sendText = fn;
    } else {
      this.capabilities = { sendText: fn };
    }
  }

  /** Set full backend capabilities (Phase 4: typing, read receipts, reactions). */
  setBackendCapabilities(caps: BackendCapabilities): void {
    this.capabilities = caps;
  }

  /** Set QR code for dashboard display (called by BaileysBackend). */
  setQrCode(qr: string | null): void {
    this.currentQrCode = qr;
    this.eventBus.emit('whatsapp:qr-update', { qr, timestamp: new Date().toISOString() }).catch(() => {});
  }

  /** Get current QR code (null if connected or not in QR state). */
  getQrCode(): string | null {
    return this.currentQrCode;
  }

  /** Update connection state (called by backend). */
  async setConnectionState(state: ConnectionState, phoneNumber?: string): Promise<void> {
    this.connectionState = state;
    if (phoneNumber) this.phoneNumber = phoneNumber;
    if (state === 'connected') {
      this.lastConnected = new Date().toISOString();
      this.reconnectAttempts = 0;
      this.lastError = null;
      this.setQrCode(null); // QR no longer needed
      await this.flushOutboundQueue();
    }
  }

  /** Record the last error message for status reporting. */
  setLastError(message: string): void {
    this.lastError = message;
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

    // Agent identity prefix — prepend agent name to outbound messages
    let content = message.content;
    if (this.config.prefixEnabled !== false) {
      const name = this.config.agentName ?? 'Agent';
      const prefix = this.config.messagePrefix ?? `*[${name}]* `;
      content = prefix + content;
    }

    const maxLen = this.config.maxMessageLength ?? 4000;
    const chunks = smartChunk(content, maxLen);

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

    // Clear stall tracking for this channel (agent responded)
    // Use both channelId and jid to ensure we match however the channel was tracked
    this.stallDetector.clearStallForChannel(jid);
    if (jid !== channelId) this.stallDetector.clearStallForChannel(channelId);

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
    msgKey?: unknown,
    participant?: string,
    mentionedJids?: string[],
  ): Promise<void> {
    // Dedup
    if (this.processedMessageIds.has(messageId)) return;
    this.processedMessageIds.add(messageId);
    if (this.processedMessageIds.size > WhatsAppAdapter.DEDUP_MAX_SIZE) {
      const excess = this.processedMessageIds.size - WhatsAppAdapter.DEDUP_MAX_SIZE;
      let count = 0;
      for (const id of this.processedMessageIds) {
        if (count >= excess) break;
        this.processedMessageIds.delete(id);
        count++;
      }
    }

    const isGroup = jid.endsWith('@g.us');

    // ── Group message handling ──
    if (isGroup) {
      await this.handleGroupMessage(jid, messageId, text, senderName, timestamp, msgKey, participant, mentionedJids);
      return;
    }

    // ── Direct message handling (existing logic) ──

    // UX signals: read receipt (fire-and-forget, before auth)
    if (this.config.sendReadReceipts !== false && this.capabilities?.sendReadReceipt) {
      this.capabilities.sendReadReceipt(jid, messageId, msgKey).catch(() => {});
    }

    let phoneNumber = jidToPhone(jid) ?? jid;

    // LID JID workaround: WhatsApp's Linked Identity format (e.g. 272404173598970@lid)
    // doesn't contain the real phone number. jidToPhone() returns null for these.
    // For self-chat messages (the primary personal-agent use case), the LID always
    // belongs to the connected user, so map it to the known phone number.
    if (jid.endsWith('@lid') && this.phoneNumber) {
      phoneNumber = '+' + this.phoneNumber;
    }

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
      await this.authGate.handleUnauthorized(
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
        this.privacyConsent.markPendingConsent(normalizedPhone);
        if (this.sendFunction) {
          await this.sendFunction(jid, this.privacyConsent.getConsentMessage()).catch(() => {});
        }
        return;
      } else {
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

    // UX signals: ack reaction + typing indicator (after auth, before processing)
    const ackEmoji = this.config.ackReactionEmoji;
    if (ackEmoji !== false && this.capabilities?.sendReaction) {
      this.capabilities.sendReaction(jid, messageId, ackEmoji ?? '👀', msgKey).catch(() => {});
    }
    if (this.config.sendTypingIndicators !== false && this.capabilities?.sendTyping) {
      this.capabilities.sendTyping(jid).catch(() => {});
    }

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

  // ── Group message handling ──────────────────────────────

  /** Handle an incoming group message. */
  private async handleGroupMessage(
    groupJid: string,
    messageId: string,
    text: string,
    senderName?: string,
    timestamp?: number,
    msgKey?: unknown,
    participant?: string,
    mentionedJids?: string[],
  ): Promise<void> {
    const groupConfig = this.config.groups;

    // Groups must be explicitly enabled
    if (!groupConfig?.enabled) return;

    // Group authorization check
    const authorizedGroups = groupConfig.authorizedGroups ?? [];
    if (authorizedGroups.length > 0 && !authorizedGroups.includes(groupJid)) {
      return; // Group not authorized — silently ignore
    }

    // Resolve sender identity from participant JID
    const senderJid = participant ?? groupJid;
    let senderPhone: string;
    try {
      const phone = jidToPhone(senderJid);
      senderPhone = phone ? normalizePhoneNumber(phone) : senderJid;
    } catch {
      senderPhone = senderJid;
    }

    const ts = timestamp ? new Date(timestamp * 1000).toISOString() : new Date().toISOString();

    // Buffer this message for group context (even if not activating agent)
    const maxBuffer = groupConfig.maxContextMessages ?? WhatsAppAdapter.GROUP_BUFFER_MAX;
    let buffer = this.groupMessageBuffers.get(groupJid);
    if (!buffer) {
      buffer = [];
      this.groupMessageBuffers.set(groupJid, buffer);
    }
    buffer.push({ sender: senderPhone, senderName, text, timestamp: ts });
    if (buffer.length > maxBuffer) {
      buffer.splice(0, buffer.length - maxBuffer);
    }

    // Rate limiting on sender
    if (!this.checkRateLimit(senderPhone)) return;

    // Determine activation mode for this group
    const activation = groupConfig.groupOverrides?.[groupJid]?.activation
      ?? groupConfig.defaultActivation
      ?? 'mention';

    // Check if agent should activate
    let shouldActivate = false;

    if (activation === 'always') {
      shouldActivate = true;
    } else {
      // 'mention' mode — check if bot was @mentioned
      if (mentionedJids && this.phoneNumber) {
        const botPhonePrefix = this.phoneNumber.replace(/^\\+/, '');
        shouldActivate = mentionedJids.some(m => m.includes(botPhonePrefix));
      }

      // Also check text-based triggers (agent name at start of message)
      const agentNameForMention = groupConfig.agentName ?? this.config.agentName;
      if (!shouldActivate && agentNameForMention) {
        const namePattern = new RegExp(`^@?${agentNameForMention}\\b`, 'i');
        shouldActivate = namePattern.test(text.trim());
      }
    }

    if (!shouldActivate) return;

    // UX signals
    if (this.config.sendReadReceipts !== false && this.capabilities?.sendReadReceipt) {
      this.capabilities.sendReadReceipt(groupJid, messageId, msgKey).catch(() => {});
    }
    if (this.config.sendTypingIndicators !== false && this.capabilities?.sendTyping) {
      this.capabilities.sendTyping(groupJid).catch(() => {});
    }
    const ackEmoji = this.config.ackReactionEmoji;
    if (ackEmoji !== false && this.capabilities?.sendReaction) {
      this.capabilities.sendReaction(groupJid, messageId, ackEmoji ?? '👀', msgKey).catch(() => {});
    }

    // Log inbound
    this.logger.append({
      messageId: Date.now(),
      channelId: groupJid,
      text,
      fromUser: true,
      timestamp: ts,
      sessionName: this.registry.getSessionForChannel(groupJid),
      senderName,
      platformUserId: senderPhone,
    });

    await this.eventBus.emit('message:logged', {
      messageId: Date.now(),
      channelId: groupJid,
      text,
      fromUser: true,
      timestamp: ts,
      sessionName: this.registry.getSessionForChannel(groupJid),
      senderName,
      platformUserId: senderPhone,
    });

    // Build context from recent group messages
    const recentContext = this.getGroupContext(groupJid);

    // Track for stall detection
    const sessionName = this.registry.getSessionForChannel(groupJid);
    if (sessionName) {
      this.stallDetector.trackMessageInjection(groupJid, sessionName, text);
    }

    // Forward to message handler
    if (this.messageHandler) {
      const message: Message = {
        id: messageId,
        content: text,
        channel: { type: 'whatsapp', identifier: groupJid },
        userId: senderPhone,
        receivedAt: ts,
        metadata: {
          senderName,
          platform: 'whatsapp',
          isGroup: true,
          groupJid,
          participant: senderJid,
          recentGroupContext: recentContext,
        },
      };

      await this.eventBus.emit('message:incoming', {
        channelId: groupJid,
        userId: senderPhone,
        text,
        timestamp: ts,
      });

      try {
        await this.messageHandler(message);
      } catch (err) {
        console.error(`[whatsapp] Group message handler error: ${err}`);
      }
    }
  }

  /** Get recent group context as formatted string for agent context. */
  getGroupContext(groupJid: string): string {
    const buffer = this.groupMessageBuffers.get(groupJid);
    if (!buffer || buffer.length === 0) return '';

    return buffer
      .map(m => `[${m.senderName ?? m.sender}]: ${m.text}`)
      .join('\n');
  }

  /** Get the group message buffer for a group (for testing/inspection). */
  getGroupBuffer(groupJid: string): Array<{ sender: string; senderName?: string; text: string; timestamp: string }> {
    return this.groupMessageBuffers.get(groupJid) ?? [];
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
      lastError: this.lastError,
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

  /** Get the Baileys config with defaults.
   * Falls back to top-level WhatsApp config values for authMethod and
   * pairingPhoneNumber, since users commonly place these at the top level
   * of the WhatsApp config object rather than nested under "baileys". */
  getBaileysConfig(): Required<BaileysConfig> {
    const bc = this.config.baileys ?? {};
    const topLevel = this.config as Record<string, unknown>;
    return {
      authDir: bc.authDir ?? path.join(this.stateDir, 'whatsapp-auth'),
      markOnline: bc.markOnline ?? false,
      maxReconnectAttempts: bc.maxReconnectAttempts ?? 10,
      authMethod: bc.authMethod ?? (topLevel.authMethod as BaileysConfig['authMethod']) ?? 'qr',
      pairingPhoneNumber: bc.pairingPhoneNumber ?? (topLevel.pairingPhoneNumber as string) ?? '',
      version: bc.version ?? (topLevel.version as BaileysConfig['version']) ?? undefined as unknown as [number, number, number],
      browser: bc.browser ?? (topLevel.browser as BaileysConfig['browser']) ?? undefined as unknown as [string, string, string],
    };
  }
}
