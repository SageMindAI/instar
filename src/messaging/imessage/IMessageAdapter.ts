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
 * - authorizedContacts gates BOTH inbound AND outbound (unified allowlist)
 * - sendEnabled defaults to false (read-only mode)
 * - proactiveSendEnabled defaults to false (replies only)
 * - Config is cached at startup — runtime edits don't expand permissions
 * - SessionChannelRegistry maps senders to sessions
 * - StallDetector monitors for unanswered messages
 */

import path from 'node:path';
import crypto from 'node:crypto';
import type { MessagingAdapter, Message, OutgoingMessage } from '../../core/types.js';
import { NativeBackend } from './NativeBackend.js';
import { MessageLogger, type LogEntry } from '../shared/MessageLogger.js';
import { MessagingEventBus } from '../shared/MessagingEventBus.js';
import { SessionChannelRegistry } from '../shared/SessionChannelRegistry.js';
import { StallDetector, type StallEvent, type IsSessionAliveCheck } from '../shared/StallDetector.js';
import { OutboundRateLimiter } from './OutboundRateLimiter.js';
import { OutboundAuditLog } from './OutboundAuditLog.js';
import { normalizeIdentifier, normalizeIdentifierSet } from './normalize-phone.js';
import type {
  IMessageConfig,
  IMessageIncoming,
  ConnectionState,
  ConnectionInfo,
} from './types.js';

const RECEIVED_IDS_MAX_SIZE = 1_000;

/** Single-use send token for TOCTOU mitigation. */
interface SendToken {
  token: string;
  recipient: string;
  issuedAt: number;
  ttlMs: number;
}

export class IMessageAdapter implements MessagingAdapter {
  readonly platform = 'imessage';

  // Config (cached at startup — immutable at runtime)
  private config: IMessageConfig;
  private stateDir: string;
  private readonly sendEnabled: boolean;
  private readonly proactiveSendEnabled: boolean;
  private readonly reactiveWindowHours: number;
  private readonly triggerMode: 'mention' | 'all';
  private agentName: string | undefined;

  // Components
  private backend: NativeBackend;
  private logger: MessageLogger;
  readonly eventBus: MessagingEventBus;
  private registry: SessionChannelRegistry;
  private stallDetector: StallDetector;
  private rateLimiter: OutboundRateLimiter;
  private auditLog: OutboundAuditLog;

  // State
  private messageHandler: ((message: Message) => Promise<void>) | null = null;
  private started = false;
  private authorizedContacts: Set<string>;  // normalized E.164
  private receivedMessageIds = new Set<string>();
  private lastInboundFrom = new Map<string, number>();  // normalized contact → timestamp
  private pendingSendTokens = new Map<string, SendToken>();

  // Callbacks (wired by server.ts)
  onMessageLogged: ((entry: LogEntry) => void) | null = null;
  onStallDetected: ((sender: string, sessionName: string, messageText: string) => void) | null = null;

  constructor(config: Record<string, unknown>, stateDir: string) {
    this.config = config as unknown as IMessageConfig;
    this.stateDir = stateDir;

    // Resolve authorizedContacts with deprecation handling
    const contacts = this._resolveAuthorizedContacts();
    this.authorizedContacts = normalizeIdentifierSet(contacts);

    if (this.authorizedContacts.size === 0) {
      console.warn('[imessage] authorizedContacts is empty — all messages will be rejected and all sends blocked (fail-closed)');
    }

    // Cache config at startup — runtime edits to config.json don't take effect
    this.sendEnabled = this.config.sendEnabled ?? false;
    this.proactiveSendEnabled = this.config.proactiveSendEnabled ?? false;
    this.reactiveWindowHours = this.config.reactiveWindowHours ?? 24;
    this.triggerMode = this.config.triggerMode ?? 'mention';
    this.agentName = this.config.agentName;

    // Initialize backend (read-only)
    this.backend = new NativeBackend({
      dbPath: this.config.dbPath,
      pollIntervalMs: this.config.pollIntervalMs,
      includeAttachments: this.config.includeAttachments,
      offsetPath: path.join(stateDir, 'imessage-poll-offset.json'),
      authorizedContacts: Array.from(this.authorizedContacts),
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

    // Initialize rate limiter
    this.rateLimiter = new OutboundRateLimiter({
      maxPerHour: this.config.maxOutboundPerHour ?? 20,
      maxPerDay: this.config.maxOutboundPerDay ?? 100,
    });

    // Initialize audit log
    this.auditLog = new OutboundAuditLog(
      path.join(stateDir, 'imessage-outbound.jsonl'),
    );

    // Wire backend message events
    this.backend.on('message', (msg: IMessageIncoming) => this._handleIncomingMessage(msg));
    this.backend.on('stateChange', (state: ConnectionState) => {
      console.log(`[imessage] Connection state: ${state}`);
    });
  }

  // ── MessagingAdapter Interface ──

  async start(): Promise<void> {
    if (this.started) return;

    // Startup security warnings
    this._logStartupWarnings();

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

  registerSession(sender: string, sessionName: string): void {
    this.registry.register(normalizeIdentifier(sender), sessionName, sender);
  }

  getSessionForSender(sender: string): string | null {
    return this.registry.getSessionForChannel(normalizeIdentifier(sender));
  }

  getSenderForSession(sessionName: string): string | null {
    return this.registry.getChannelForSession(sessionName);
  }

  // ── Stall Detection ──

  trackMessageInjection(sender: string, sessionName: string, text: string): void {
    this.stallDetector.trackMessageInjection(normalizeIdentifier(sender), sessionName, text);
  }

  clearStallForSender(sender: string): void {
    this.stallDetector.clearStallForChannel(normalizeIdentifier(sender));
  }

  setIsSessionAlive(check: IsSessionAliveCheck): void {
    this.stallDetector.setIsSessionAlive(check);
  }

  setOnStall(callback: (event: StallEvent, alive: boolean) => Promise<void>): void {
    this.stallDetector.setOnStall(callback);
  }

  // ── Context & History ──

  getConversationContext(sender: string, limit = 20): string {
    return this.backend.getConversationContext(sender, limit);
  }

  listChats(limit = 20): unknown {
    return this.backend.listChats(limit);
  }

  getChatHistory(chatId: string, limit = 50): unknown {
    return this.backend.getChatHistory(chatId, limit);
  }

  // ── Connection Info ──

  getConnectionInfo(): ConnectionInfo {
    return {
      state: this.backend.state,
      connectedAt: this.started ? new Date().toISOString() : undefined,
      lastError: undefined,
      reconnectAttempts: 0,
    };
  }

  // ── Auth (unified — gates both directions) ──

  isAuthorized(sender: string): boolean {
    return this.authorizedContacts.has(normalizeIdentifier(sender));
  }

  // ── Outbound Safety ──

  /** Whether sending is enabled (cached from startup config). */
  isSendEnabled(): boolean {
    return this.sendEnabled;
  }

  /** Whether proactive (agent-initiated) sends are enabled. */
  isProactiveSendEnabled(): boolean {
    return this.proactiveSendEnabled;
  }

  /**
   * Check if a send to this recipient is a reactive reply (within reactive window)
   * or a proactive send (no recent inbound).
   */
  getSendMode(recipient: string): 'reactive' | 'proactive' {
    const normalized = normalizeIdentifier(recipient);
    const lastInbound = this.lastInboundFrom.get(normalized);
    if (!lastInbound) return 'proactive';

    const windowMs = this.reactiveWindowHours * 3_600_000;
    if (Date.now() - lastInbound > windowMs) return 'proactive';

    return 'reactive';
  }

  /**
   * Validate a send request. Returns either an approval with a single-use token,
   * or a rejection with reason.
   *
   * This is Layer 3 of the 5-layer defense-in-depth.
   */
  validateSend(recipient: string): {
    allowed: boolean;
    token?: string;
    reason?: string;
    sendMode?: 'reactive' | 'proactive';
  } {
    const normalized = normalizeIdentifier(recipient);

    // Check send enabled
    if (!this.sendEnabled) {
      this.auditLog.record({
        recipient: normalized,
        text: '',
        allowed: false,
        blockedBy: 'layer3:sendDisabled',
        rateStatus: this.rateLimiter.countsFor(normalized),
      });
      return { allowed: false, reason: 'sendEnabled is false (read-only mode)' };
    }

    // Check authorized
    if (!this.authorizedContacts.has(normalized)) {
      this.auditLog.record({
        recipient: normalized,
        text: '',
        allowed: false,
        blockedBy: 'layer3:unauthorized',
        rateStatus: this.rateLimiter.countsFor(normalized),
      });
      return { allowed: false, reason: 'recipient not in authorizedContacts' };
    }

    // Check proactive vs reactive
    const sendMode = this.getSendMode(normalized);
    if (sendMode === 'proactive' && !this.proactiveSendEnabled) {
      this.auditLog.record({
        recipient: normalized,
        text: '',
        allowed: false,
        blockedBy: 'layer3:proactiveDisabled',
        sendMode: 'proactive',
        rateStatus: this.rateLimiter.countsFor(normalized),
      });
      return { allowed: false, reason: 'proactive sends not enabled — no recent inbound from this contact' };
    }

    // Check rate limits
    const rateCheck = this.rateLimiter.check(normalized);
    if (!rateCheck.allowed) {
      this.auditLog.record({
        recipient: normalized,
        text: '',
        allowed: false,
        blockedBy: 'layer4:rateLimit',
        sendMode,
        rateStatus: this.rateLimiter.countsFor(normalized),
      });

      // Emit rate limit event for user notification
      this.eventBus.emit('rate:outbound-limited', {
        recipient: IMessageAdapter.maskIdentifier(normalized),
        reason: rateCheck.reason || 'rate limit exceeded',
      }).catch(() => {});

      return { allowed: false, reason: rateCheck.reason || 'rate limit exceeded' };
    }

    // Issue single-use send token (TOCTOU mitigation)
    const token = crypto.randomUUID();
    const sendToken: SendToken = {
      token,
      recipient: normalized,
      issuedAt: Date.now(),
      ttlMs: 30_000, // 30 seconds
    };
    this.pendingSendTokens.set(token, sendToken);

    // Clean up expired tokens
    this._cleanupExpiredTokens();

    return { allowed: true, token, sendMode };
  }

  /**
   * Confirm a send (called after the message is actually delivered).
   * Validates the send token and records the send for rate limiting + audit.
   */
  confirmSend(token: string, recipient: string, text: string): {
    ok: boolean;
    reason?: string;
  } {
    const normalized = normalizeIdentifier(recipient);
    const sendToken = this.pendingSendTokens.get(token);

    if (!sendToken) {
      this.auditLog.record({
        recipient: normalized,
        text,
        allowed: false,
        blockedBy: 'layer3:invalidToken',
        rateStatus: this.rateLimiter.countsFor(normalized),
      });
      return { ok: false, reason: 'invalid or expired send token' };
    }

    // Consume the token (single-use)
    this.pendingSendTokens.delete(token);

    // Verify token matches the recipient (prevents validate-for-A, send-to-B)
    if (sendToken.recipient !== normalized) {
      this.auditLog.record({
        recipient: normalized,
        text,
        allowed: false,
        blockedBy: 'layer3:tokenMismatch',
        sendToken: token,
        rateStatus: this.rateLimiter.countsFor(normalized),
      });
      return { ok: false, reason: 'send token was issued for a different recipient' };
    }

    // Check TTL
    if (Date.now() - sendToken.issuedAt > sendToken.ttlMs) {
      this.auditLog.record({
        recipient: normalized,
        text,
        allowed: false,
        blockedBy: 'layer3:tokenExpired',
        sendToken: token,
        rateStatus: this.rateLimiter.countsFor(normalized),
      });
      return { ok: false, reason: 'send token expired (30s TTL)' };
    }

    // Record for rate limiting
    this.rateLimiter.record(normalized);

    // Audit log — allowed
    const sendMode = this.getSendMode(normalized);
    this.auditLog.record({
      recipient: normalized,
      text,
      allowed: true,
      sendMode,
      sendToken: token,
      rateStatus: this.rateLimiter.countsFor(normalized),
    });

    return { ok: true };
  }

  /** Get rate limiter status (for debugging/admin endpoints). */
  getRateLimitStatus() {
    return this.rateLimiter.status();
  }

  // ── Trigger Mode ──

  /** Set the agent name for mention-based triggering. */
  setAgentName(name: string): void {
    this.agentName = name;
  }

  /** Get the current trigger mode. */
  getTriggerMode(): 'mention' | 'all' {
    return this.triggerMode;
  }

  /**
   * Check whether an incoming message triggers the agent.
   * In "mention" mode, requires @{agentName} in the message text.
   * In "all" mode, every message triggers.
   * Returns the stripped text (mention removed) if triggered.
   */
  _checkTrigger(text: string): { triggered: boolean; strippedText: string } {
    if (this.triggerMode === 'all') {
      return { triggered: true, strippedText: text };
    }

    // Mention mode — require @{agentName}
    if (!this.agentName) {
      // No agent name configured — fall back to triggering on all messages
      return { triggered: true, strippedText: text };
    }

    const escaped = this.agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mentionPattern = new RegExp(`@${escaped}\\b`, 'i');
    const match = text.match(mentionPattern);

    if (!match) {
      return { triggered: false, strippedText: text };
    }

    // Strip the mention from the message before routing
    const stripped = text.replace(mentionPattern, '').replace(/\s+/g, ' ').trim();
    return { triggered: true, strippedText: stripped || text };
  }

  // ── Logging ──

  get messageLogger(): MessageLogger {
    return this.logger;
  }

  logOutboundMessage(recipient: string, text: string): void {
    this._logMessage({
      messageId: `out-${Date.now()}`,
      channelId: normalizeIdentifier(recipient),
      text,
      fromUser: false,
      timestamp: new Date().toISOString(),
      sessionName: null,
      platform: 'imessage',
    });
  }

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

  /**
   * Resolve the contact allowlist from config, handling the
   * authorizedSenders → authorizedContacts migration.
   */
  private _resolveAuthorizedContacts(): string[] {
    const newKey = this.config.authorizedContacts;
    const oldKey = this.config.authorizedSenders;

    if (newKey && Array.isArray(newKey)) {
      if (oldKey && Array.isArray(oldKey)) {
        console.warn(
          '[imessage] Both authorizedContacts and authorizedSenders are present. ' +
          'Using authorizedContacts only. Rename authorizedSenders to authorizedContacts to suppress this warning.',
        );
      }
      return newKey;
    }

    if (oldKey && Array.isArray(oldKey)) {
      console.warn(
        '[imessage] authorizedSenders is deprecated — rename to authorizedContacts. ' +
        'Both gate inbound AND outbound messaging.',
      );
      return oldKey;
    }

    // Neither present — fail-closed
    throw new Error('[imessage] authorizedContacts is required (array of phone numbers or email addresses)');
  }

  private _logStartupWarnings(): void {
    if (this.sendEnabled) {
      console.warn(
        '[imessage] ⚠️  iMessage send is enabled with software-level guardrails. ' +
        'Read-only mode (sendEnabled: false) provides stronger security. ' +
        'Server-mediated sending (Phase 2) is planned.',
      );
    }
    if (this.proactiveSendEnabled) {
      console.warn(
        '[imessage] ⚠️  Proactive iMessage send is enabled. ' +
        'The agent can initiate messages to authorized contacts without them messaging first.',
      );
    }
  }

  private async _handleIncomingMessage(msg: IMessageIncoming): Promise<void> {
    // Skip own outbound messages
    if (msg.isFromMe) return;

    // Skip duplicate notifications
    if (this.receivedMessageIds.has(msg.messageId)) return;
    this._trackReceivedId(msg.messageId);

    // Authorization check (fail-closed) — uses normalized comparison
    const senderNormalized = normalizeIdentifier(msg.sender);
    if (!this.authorizedContacts.has(senderNormalized)) {
      console.log(`[imessage] Rejected message from unauthorized sender: ${IMessageAdapter.maskIdentifier(msg.sender)}`);
      return;
    }

    // Track last inbound time for reactive window
    this.lastInboundFrom.set(senderNormalized, Date.now());

    // Check trigger mode — in "mention" mode, only respond if @agentName is present
    const triggerResult = this._checkTrigger(msg.text);
    if (!triggerResult.triggered) {
      console.log(`[imessage] Message from ${IMessageAdapter.maskIdentifier(msg.sender)} logged but not triggered (mention mode, no @${this.agentName})`);
      // Still log the message for awareness, just don't route it
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
      return;
    }

    // Use the stripped text (mention removed) for downstream processing
    const processedText = triggerResult.strippedText;

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
      text: processedText,
      timestamp: new Date(msg.timestamp * 1000).toISOString(),
      raw: msg,
    });

    // Route to registered message handler
    if (this.messageHandler) {
      const message: Message = {
        id: msg.messageId,
        userId: msg.sender,
        content: processedText,
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

  private _cleanupExpiredTokens(): void {
    const now = Date.now();
    for (const [token, sendToken] of this.pendingSendTokens) {
      if (now - sendToken.issuedAt > sendToken.ttlMs) {
        this.pendingSendTokens.delete(token);
      }
    }
  }
}
