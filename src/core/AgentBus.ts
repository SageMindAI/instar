/**
 * AgentBus — Transport-agnostic message bus for inter-agent communication.
 *
 * Supports two transport modes:
 *   1. HTTP — Real-time messaging via agent HTTP servers (tunnel-exposed)
 *   2. JSONL — File-based messaging via shared JSONL log (git-synced)
 *
 * Messages have typed payloads, delivery tracking, and TTL expiration.
 *
 * From INTELLIGENT_SYNC_SPEC Section 7.4 and Phase 7 (Real-Time Communication).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';
import { NonceStore } from './NonceStore.js';

// ── Types ────────────────────────────────────────────────────────────

export type MessageType =
  | 'work-announcement'
  | 'work-complete'
  | 'file-avoidance-request'
  | 'file-avoidance-response'
  | 'status-update'
  | 'conflict-detected'
  | 'negotiation-request'
  | 'negotiation-response'
  | 'heartbeat'
  | 'custom';

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'expired';

export interface AgentMessage<T = unknown> {
  /** Unique message ID. */
  id: string;
  /** Message type. */
  type: MessageType;
  /** Sender machine ID. */
  from: string;
  /** Target machine ID (or '*' for broadcast). */
  to: string;
  /** ISO timestamp. */
  timestamp: string;
  /** Time-to-live in milliseconds (0 = no expiration). */
  ttlMs: number;
  /** Typed payload. */
  payload: T;
  /** ID of message this is replying to (for request/response). */
  replyTo?: string;
  /** Delivery status (local tracking). */
  status: DeliveryStatus;
  /** Anti-replay nonce (16+ bytes hex). Present when replay protection enabled. */
  nonce?: string;
  /** Monotonic sequence number per sender. Present when replay protection enabled. */
  sequence?: number;
}

export interface TransportAdapter {
  /** Send a message to a specific machine. */
  send(message: AgentMessage, targetUrl?: string): Promise<boolean>;
  /** Read pending messages for this machine. */
  receive(): Promise<AgentMessage[]>;
  /** Mark a message as delivered. */
  acknowledge(messageId: string): Promise<void>;
}

export interface ReplayProtectionConfig {
  /** Enable anti-replay validation on incoming messages (default: false). */
  enabled: boolean;
  /** Timestamp freshness window in ms (default: 5 min per spec). */
  timestampWindowMs?: number;
  /** Custom directory for nonce persistence. Defaults to stateDir + '/nonce-store'. */
  nonceStoreDir?: string;
}

export interface AgentBusConfig {
  /** State directory (.instar). */
  stateDir: string;
  /** This machine's ID. */
  machineId: string;
  /** Transport mode. */
  transport: 'jsonl' | 'http';
  /** For HTTP transport: this machine's URL. */
  selfUrl?: string;
  /** For HTTP transport: known machine URLs. */
  peerUrls?: Record<string, string>;
  /** Default TTL for messages in ms (default: 30 min). */
  defaultTtlMs?: number;
  /** Poll interval for JSONL transport in ms (default: 5000). */
  pollIntervalMs?: number;
  /** Anti-replay protection via NonceStore (Gap 1 — Replay Attack Defense). */
  replayProtection?: ReplayProtectionConfig;
}

export interface AgentBusEvents {
  message: (message: AgentMessage) => void;
  sent: (message: AgentMessage) => void;
  expired: (message: AgentMessage) => void;
  'replay-rejected': (message: AgentMessage, reason: string) => void;
  error: (error: Error) => void;
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_TTL = 30 * 60 * 1000; // 30 minutes
const DEFAULT_POLL_INTERVAL = 5000;
const MESSAGES_DIR = 'messages';
const OUTBOX_FILE = 'outbox.jsonl';
const INBOX_FILE = 'inbox.jsonl';
const AGENTBUS_TIMESTAMP_WINDOW = 5 * 60 * 1000; // 5 minutes per spec

// ── AgentBus ─────────────────────────────────────────────────────────

export class AgentBus extends EventEmitter {
  private stateDir: string;
  private machineId: string;
  private transportMode: 'jsonl' | 'http';
  private selfUrl?: string;
  private peerUrls: Record<string, string>;
  private defaultTtlMs: number;
  private pollIntervalMs: number;
  private messagesDir: string;
  private pollTimer?: ReturnType<typeof setInterval>;
  private handlers: Map<MessageType, Array<(msg: AgentMessage) => void>>;
  private nonceStore: NonceStore | null;
  private replayProtectionEnabled: boolean;
  private outgoingSequence: number;

  constructor(config: AgentBusConfig) {
    super();
    this.stateDir = config.stateDir;
    this.machineId = config.machineId;
    this.transportMode = config.transport;
    this.selfUrl = config.selfUrl;
    this.peerUrls = config.peerUrls ?? {};
    this.defaultTtlMs = config.defaultTtlMs ?? DEFAULT_TTL;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL;
    this.handlers = new Map();
    this.outgoingSequence = 0;

    this.messagesDir = path.join(config.stateDir, 'state', MESSAGES_DIR);
    if (!fs.existsSync(this.messagesDir)) {
      fs.mkdirSync(this.messagesDir, { recursive: true });
    }

    // ── Replay Protection (Gap 1) ────────────────────────────────
    const rp = config.replayProtection;
    this.replayProtectionEnabled = rp?.enabled ?? false;
    if (this.replayProtectionEnabled) {
      const nonceDir = rp?.nonceStoreDir ?? path.join(config.stateDir, 'nonce-store');
      const timestampWindowMs = rp?.timestampWindowMs ?? AGENTBUS_TIMESTAMP_WINDOW;
      this.nonceStore = new NonceStore(nonceDir, {
        timestampWindowMs,
        // Nonces must survive at least as long as the timestamp window
        nonceMaxAgeMs: timestampWindowMs * 2,
        pruneIntervalMs: 5 * 60_000,
      });
      this.nonceStore.initialize();
    } else {
      this.nonceStore = null;
    }
  }

  // ── Sending ───────────────────────────────────────────────────────

  /**
   * Send a message to a specific machine or broadcast.
   */
  async send<T = unknown>(opts: {
    type: MessageType;
    to: string;
    payload: T;
    replyTo?: string;
    ttlMs?: number;
  }): Promise<AgentMessage<T>> {
    const message: AgentMessage<T> = {
      id: `msg_${crypto.randomBytes(8).toString('hex')}`,
      type: opts.type,
      from: this.machineId,
      to: opts.to,
      timestamp: new Date().toISOString(),
      ttlMs: opts.ttlMs ?? this.defaultTtlMs,
      payload: opts.payload,
      replyTo: opts.replyTo,
      status: 'pending',
    };

    // Attach anti-replay fields when replay protection is enabled
    if (this.replayProtectionEnabled) {
      message.nonce = crypto.randomBytes(16).toString('hex'); // 16 bytes = 32 hex chars
      message.sequence = this.outgoingSequence++;
    }

    if (this.transportMode === 'http' && opts.to !== '*') {
      // HTTP: send directly to target
      const targetUrl = this.peerUrls[opts.to];
      if (targetUrl) {
        const delivered = await this.httpSend(message, targetUrl);
        message.status = delivered ? 'delivered' : 'failed';
      } else {
        // Fall back to JSONL if no URL known for target
        this.appendToOutbox(message);
      }
    } else {
      // JSONL: write to outbox for file-based delivery
      this.appendToOutbox(message);
    }

    this.emit('sent', message);
    return message;
  }

  /**
   * Send and wait for a reply (request/response pattern).
   */
  async request<TReq = unknown, TRes = unknown>(opts: {
    type: MessageType;
    to: string;
    payload: TReq;
    timeoutMs?: number;
  }): Promise<AgentMessage<TRes> | null> {
    const message = await this.send(opts);
    const timeoutMs = opts.timeoutMs ?? 30_000;

    return new Promise<AgentMessage<TRes> | null>((resolve) => {
      const timer = setTimeout(() => {
        this.off('message', handler);
        resolve(null);
      }, timeoutMs);

      const handler = (reply: AgentMessage) => {
        if (reply.replyTo === message.id) {
          clearTimeout(timer);
          this.off('message', handler);
          resolve(reply as AgentMessage<TRes>);
        }
      };

      this.on('message', handler);
    });
  }

  // ── Receiving ─────────────────────────────────────────────────────

  /**
   * Register a handler for a specific message type.
   */
  onMessage<T = unknown>(
    type: MessageType,
    handler: (msg: AgentMessage<T>) => void,
  ): void {
    const existing = this.handlers.get(type) ?? [];
    existing.push(handler as (msg: AgentMessage) => void);
    this.handlers.set(type, existing);
  }

  /**
   * Process incoming messages (call from poll loop or HTTP endpoint).
   */
  processIncoming(messages: AgentMessage[]): void {
    const now = Date.now();

    for (const msg of messages) {
      // Skip messages not for us
      if (msg.to !== this.machineId && msg.to !== '*') continue;
      // Skip our own broadcasts
      if (msg.from === this.machineId) continue;

      // Check TTL expiration
      if (msg.ttlMs > 0) {
        const expiresAt = new Date(msg.timestamp).getTime() + msg.ttlMs;
        if (now > expiresAt) {
          msg.status = 'expired';
          this.emit('expired', msg);
          continue;
        }
      }

      // ── Replay Protection Validation (Gap 1) ──────────────────
      if (this.replayProtectionEnabled && this.nonceStore) {
        // Reject messages without anti-replay fields (fail-closed)
        if (!msg.nonce || msg.sequence === undefined || msg.sequence === null) {
          this.emit('replay-rejected', msg, 'Missing nonce or sequence (replay protection required)');
          continue;
        }

        const validation = this.nonceStore.validate(
          msg.timestamp,
          msg.nonce,
          msg.sequence,
          msg.from,
        );

        if (!validation.valid) {
          this.emit('replay-rejected', msg, validation.reason);
          continue;
        }
      }

      msg.status = 'delivered';

      // Fire type-specific handlers
      const typeHandlers = this.handlers.get(msg.type) ?? [];
      for (const handler of typeHandlers) {
        handler(msg);
      }

      // Fire generic event
      this.emit('message', msg);
    }
  }

  // ── Polling (JSONL transport) ─────────────────────────────────────

  /**
   * Start polling for incoming messages (JSONL transport).
   */
  startPolling(): void {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(() => {
      try {
        const messages = this.readInbox();
        if (messages.length > 0) {
          this.processIncoming(messages);
          this.clearInbox();
        }
      } catch (err) {
        // @silent-fallback-ok — error is emitted to listeners; polling continues on next tick
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    }, this.pollIntervalMs);
  }

  /**
   * Stop polling.
   */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  // ── HTTP Transport Endpoint ───────────────────────────────────────

  /**
   * Handle an incoming HTTP message (call from Express route).
   * Returns true if the message was accepted.
   */
  handleHttpMessage(message: AgentMessage): boolean {
    if (message.to !== this.machineId && message.to !== '*') {
      return false;
    }

    this.processIncoming([message]);
    return true;
  }

  // ── Message History ───────────────────────────────────────────────

  /**
   * Read the outbox (sent messages).
   */
  readOutbox(): AgentMessage[] {
    return this.readJsonl(path.join(this.messagesDir, OUTBOX_FILE));
  }

  /**
   * Read the inbox (received messages).
   */
  readInbox(): AgentMessage[] {
    return this.readJsonl(path.join(this.messagesDir, INBOX_FILE));
  }

  /**
   * Get pending messages (from other machines' outboxes in shared state).
   * For JSONL transport: reads all machine outboxes and filters for messages to this machine.
   */
  getPendingMessages(): AgentMessage[] {
    const pending: AgentMessage[] = [];

    try {
      const dirs = fs.readdirSync(this.messagesDir);
      for (const dir of dirs) {
        const outboxPath = path.join(this.messagesDir, dir, OUTBOX_FILE);
        if (fs.existsSync(outboxPath)) {
          const messages = this.readJsonl(outboxPath);
          for (const msg of messages) {
            if ((msg.to === this.machineId || msg.to === '*') && msg.from !== this.machineId) {
              pending.push(msg);
            }
          }
        }
      }
    } catch {
      // Directory may not exist
    }

    return pending;
  }

  // ── Cleanup ───────────────────────────────────────────────────────

  /**
   * Expire old messages from outbox.
   */
  cleanExpired(): number {
    const outboxPath = path.join(this.messagesDir, OUTBOX_FILE);
    const messages = this.readJsonl(outboxPath);
    const now = Date.now();
    let expired = 0;

    const active = messages.filter(msg => {
      if (msg.ttlMs === 0) return true; // No expiration
      const expiresAt = new Date(msg.timestamp).getTime() + msg.ttlMs;
      if (now > expiresAt) {
        expired++;
        return false;
      }
      return true;
    });

    if (expired > 0) {
      this.writeJsonl(outboxPath, active);
    }

    return expired;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Clean up resources (NonceStore timers, poll timers).
   */
  destroy(): void {
    this.stopPolling();
    if (this.nonceStore) {
      this.nonceStore.destroy();
    }
  }

  // ── Accessors ─────────────────────────────────────────────────────

  getMachineId(): string {
    return this.machineId;
  }

  getTransportMode(): 'jsonl' | 'http' {
    return this.transportMode;
  }

  isReplayProtectionEnabled(): boolean {
    return this.replayProtectionEnabled;
  }

  getOutgoingSequence(): number {
    return this.outgoingSequence;
  }

  registerPeer(machineId: string, url: string): void {
    this.peerUrls[machineId] = url;
  }

  // ── Private: JSONL I/O ────────────────────────────────────────────

  private appendToOutbox(message: AgentMessage): void {
    const outboxPath = path.join(this.messagesDir, OUTBOX_FILE);
    maybeRotateJsonl(outboxPath, { maxBytes: 5 * 1024 * 1024, keepRatio: 0.5 });
    fs.appendFileSync(outboxPath, JSON.stringify(message) + '\n');
  }

  private appendToInbox(message: AgentMessage): void {
    const inboxPath = path.join(this.messagesDir, INBOX_FILE);
    maybeRotateJsonl(inboxPath, { maxBytes: 5 * 1024 * 1024, keepRatio: 0.5 });
    fs.appendFileSync(inboxPath, JSON.stringify(message) + '\n');
  }

  private clearInbox(): void {
    const inboxPath = path.join(this.messagesDir, INBOX_FILE);
    try { fs.writeFileSync(inboxPath, ''); } catch { /* @silent-fallback-ok — best-effort inbox cleanup */ }
  }

  private readJsonl(filePath: string): AgentMessage[] {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return content.trim().split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line) as AgentMessage);
    } catch {
      // @silent-fallback-ok — file may not exist yet; empty array is the natural default
      return [];
    }
  }

  private writeJsonl(filePath: string, messages: AgentMessage[]): void {
    const content = messages.map(m => JSON.stringify(m)).join('\n') + (messages.length > 0 ? '\n' : '');
    fs.writeFileSync(filePath, content);
  }

  // ── Private: HTTP Transport ───────────────────────────────────────

  private async httpSend(message: AgentMessage, targetUrl: string): Promise<boolean> {
    try {
      const url = `${targetUrl.replace(/\/$/, '')}/messages/receive`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    } catch {
      // @silent-fallback-ok — HTTP delivery failed; caller falls back to JSONL transport
      return false;
    }
  }
}
