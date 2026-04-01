/**
 * IMessageAdapter — Native iMessage messaging adapter for Instar.
 *
 * Implements the MessagingAdapter interface using the NativeBackend
 * (direct SQLite reads from chat.db + polling for new messages).
 *
 * Key design decisions:
 * - macOS-only (requires Messages.app + Full Disk Access on node)
 * - Read-only from server context (NativeBackend reads chat.db)
 * - Sending happens from Claude Code sessions via imessage-reply.sh
 * - authorizedSenders is required and fail-closed
 * - SessionChannelRegistry maps senders to sessions
 * - StallDetector monitors for unanswered messages
 */

import path from 'node:path';
import type { MessagingAdapter, Message, OutgoingMessage } from '../../core/types.js';
import { NativeBackend } from './NativeBackend.js';
import { MessageLogger, type LogEntry } from '../shared/MessageLogger.js';
import { MessagingEventBus } from '../shared/MessagingEventBus.js';
import { SessionChannelRegistry } from '../shared/SessionChannelRegistry.js';
import { StallDetector, type StallEvent, type IsSessionAliveCheck } from '../shared/StallDetector.js';
import type {
  IMessageConfig,
  IMessageIncoming,
  ConnectionState,
  ConnectionInfo,
} from './types.js';

const RECEIVED_IDS_MAX_SIZE = 1_000;

export class IMessageAdapter implements MessagingAdapter {
  readonly platform = 'imessage';

  // Config
  private config: IMessageConfig;
  private stateDir: string;

  // Components
  private backend: NativeBackend;
  private logger: MessageLogger;
  readonly eventBus: MessagingEventBus;
  private registry: SessionChannelRegistry;
  private stallDetector: StallDetector;

  // State
  private messageHandler: ((message: Message) => Promise<void>) | null = null;
  private started = false;
  private authorizedSenders: Set<string>;
  private receivedMessageIds = new Set<string>();

  // Callbacks (wired by server.ts)
  onMessageLogged: ((entry: LogEntry) => void) | null = null;
  onStallDetected: ((sender: string, sessionName: string, messageText: string) => void) | null = null;

  constructor(config: Record<string, unknown>, stateDir: string) {
    this.config = config as unknown as IMessageConfig;
    this.stateDir = stateDir;

    if (!Array.isArray(this.config.authorizedSenders)) {
      throw new Error('[imessage] authorizedSenders is required (array of phone numbers or email addresses)');
    }

    this.authorizedSenders = new Set(
      this.config.authorizedSenders.map((s) => s.trim().toLowerCase()),
    );

    if (this.authorizedSenders.size === 0) {
      console.warn('[imessage] authorizedSenders is empty — all messages will be rejected (fail-closed)');
    }

    // Initialize backend (read-only)
    this.backend = new NativeBackend({
      dbPath: this.config.dbPath,
      pollIntervalMs: this.config.pollIntervalMs,
      includeAttachments: this.config.includeAttachments,
    });

    // Initialize logger
    this.logger = new MessageLogger({
      logPath: path.join(stateDir, 'imessage-messages.jsonl'),
      maxLines: 100_000,
      keepLines: 75_000,
    });

    // Initialize event bus
    this.eventBus = new MessagingEventBus('imessage');

    // Initialize session-channel registry
    this.registry = new SessionChannelRegistry({
      registryPath: path.join(stateDir, 'imessage-sessions.json'),
    });

    // Initialize stall detector
    this.stallDetector = new StallDetector({
      stallTimeoutMinutes: this.config.stallTimeoutMinutes ?? 5,
      promiseTimeoutMinutes: this.config.promiseTimeoutMinutes ?? 10,
    });

    // Wire backend message events
    this.backend.on('message', (msg: IMessageIncoming) => this._handleIncomingMessage(msg));
    this.backend.on('stateChange', (state: ConnectionState) => {
      console.log(`[imessage] Connection state: ${state}`);
    });
  }

  // ── MessagingAdapter Interface ──

  async start(): Promise<void> {
    if (this.started) return;

    await this.backend.connect();
    this.started = true;

    // Start stall detection
    this.stallDetector.start();

    console.log('[imessage] Adapter started (backend: native)');
  }

  async stop(): Promise<void> {
    this.started = false;
    this.stallDetector.stop();
    await this.backend.disconnect();
    console.log('[imessage] Adapter stopped');
  }

  /**
   * Send is NOT supported from the server process.
   * iMessages must be sent from Claude Code sessions via imessage-reply.sh.
   */
  async send(_message: OutgoingMessage): Promise<void> {
    throw new Error(
      '[imessage] Cannot send from server process — AppleScript Automation permission ' +
      'does not propagate through LaunchAgent. Use imessage-reply.sh from session context.',
    );
  }

  onMessage(handler: (message: Message) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async resolveUser(channelIdentifier: string): Promise<string | null> {
    return channelIdentifier || null;
  }

  // ── Session Management ──

  /** Register a session for a sender identifier. */
  registerSession(sender: string, sessionName: string): void {
    this.registry.register(sender.toLowerCase(), sessionName, sender);
  }

  /** Get the session mapped to a sender, if any. */
  getSessionForSender(sender: string): string | null {
    return this.registry.getSessionForChannel(sender.toLowerCase());
  }

  /** Get the sender mapped to a session, if any. */
  getSenderForSession(sessionName: string): string | null {
    return this.registry.getChannelForSession(sessionName);
  }

  // ── Stall Detection ──

  /** Track a message injection for stall detection. */
  trackMessageInjection(sender: string, sessionName: string, text: string): void {
    this.stallDetector.trackMessageInjection(sender.toLowerCase(), sessionName, text);
  }

  /** Clear stall tracking for a sender (called when reply is received). */
  clearStallForSender(sender: string): void {
    this.stallDetector.clearStallForChannel(sender.toLowerCase());
  }

  /** Set session liveness checker for stall detection. */
  setIsSessionAlive(check: IsSessionAliveCheck): void {
    this.stallDetector.setIsSessionAlive(check);
  }

  /** Wire stall detection callback. */
  setOnStall(callback: (event: StallEvent, alive: boolean) => Promise<void>): void {
    this.stallDetector.setOnStall(callback);
  }

  // ── Context & History ──

  /** Get conversation context formatted for session bootstrap. */
  getConversationContext(sender: string, limit = 20): string {
    return this.backend.getConversationContext(sender, limit);
  }

  /** List recent chats. */
  listChats(limit = 20): unknown {
    return this.backend.listChats(limit);
  }

  /** Get message history for a chat. */
  getChatHistory(chatId: string, limit = 50): unknown {
    return this.backend.getChatHistory(chatId, limit);
  }

  // ── Connection Info ──

  /** Get current connection info. */
  getConnectionInfo(): ConnectionInfo {
    return {
      state: this.backend.state,
      connectedAt: this.started ? new Date().toISOString() : undefined,
      lastError: undefined,
      reconnectAttempts: 0,
    };
  }

  // ── Auth ──

  /** Check if a sender is authorized. */
  isAuthorized(sender: string): boolean {
    return this.authorizedSenders.has(sender.trim().toLowerCase());
  }

  // ── Logging ──

  /** Get the message logger (for routes/searching). */
  get messageLogger(): MessageLogger {
    return this.logger;
  }

  /** Log an outbound message (called by /imessage/reply endpoint). */
  logOutboundMessage(recipient: string, text: string): void {
    this._logMessage({
      messageId: `out-${Date.now()}`,
      channelId: recipient,
      text,
      fromUser: false,
      timestamp: new Date().toISOString(),
      sessionName: null,
      platform: 'imessage',
    });
  }

  /** Mask a phone number for logging (privacy). */
  static maskIdentifier(id: string): string {
    if (id.startsWith('+') && id.length > 6) {
      return id.slice(0, 4) + '***' + id.slice(-4);
    }
    if (id.includes('@')) {
      const [local, domain] = id.split('@');
      return local.slice(0, 2) + '***@' + domain;
    }
    return '***';
  }

  // ── Internal ──

  private async _handleIncomingMessage(msg: IMessageIncoming): Promise<void> {
    // Skip own outbound messages
    if (msg.isFromMe) return;

    // Skip duplicate notifications
    if (this.receivedMessageIds.has(msg.messageId)) return;
    this._trackReceivedId(msg.messageId);

    // Authorization check (fail-closed)
    const senderNormalized = msg.sender.trim().toLowerCase();
    if (!this.authorizedSenders.has(senderNormalized)) {
      console.log(`[imessage] Rejected message from unauthorized sender: ${IMessageAdapter.maskIdentifier(msg.sender)}`);
      return;
    }

    // Log inbound message
    this._logMessage({
      messageId: msg.messageId,
      channelId: msg.chatId,
      text: msg.text,
      fromUser: true,
      timestamp: new Date(msg.timestamp * 1000).toISOString(),
      sessionName: null,
      senderName: msg.senderName,
      platformUserId: msg.sender,
      platform: 'imessage',
    });

    // Emit on event bus
    await this.eventBus.emit('message:incoming', {
      channelId: msg.chatId,
      userId: msg.sender,
      text: msg.text,
      timestamp: new Date(msg.timestamp * 1000).toISOString(),
      raw: msg,
    });

    // Route to registered message handler
    if (this.messageHandler) {
      const message: Message = {
        id: msg.messageId,
        userId: msg.sender,
        content: msg.text,
        channel: { type: 'imessage', identifier: msg.sender },
        receivedAt: new Date(msg.timestamp * 1000).toISOString(),
        metadata: {
          chatId: msg.chatId,
          senderName: msg.senderName,
          service: msg.service,
          attachments: msg.attachments,
        },
      };

      try {
        await this.messageHandler(message);
      } catch (err) {
        console.error(`[imessage] Message handler error: ${(err as Error).message}`);
      }
    }
  }

  private _trackReceivedId(messageId: string): void {
    this.receivedMessageIds.add(messageId);
    if (this.receivedMessageIds.size > RECEIVED_IDS_MAX_SIZE) {
      const oldest = this.receivedMessageIds.values().next().value;
      if (oldest !== undefined) this.receivedMessageIds.delete(oldest);
    }
  }

  private _logMessage(entry: LogEntry): void {
    this.logger.append(entry);
    if (this.onMessageLogged) {
      this.onMessageLogged(entry);
    }
  }

}
