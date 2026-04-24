/**
 * Inter-Agent Messaging type definitions.
 *
 * These types define the contracts for agent-to-agent communication
 * in the Instar ecosystem — same machine, cross-agent, cross-machine.
 *
 * Derived from: docs/specs/INTER-AGENT-MESSAGING-SPEC.md v3.1
 */

// ── Message Primitives ─────────────────────────────────────────────

/** Message classification — determines delivery TTL, retention, and response expectations */
export type MessageType =
  | 'info'      // Informational — no response expected
  | 'sync'      // State synchronization — here's what I'm doing
  | 'alert'     // Urgent notification — something happened you should know about
  | 'request'   // Action request — please do something
  | 'query'     // Question — please respond with information
  | 'response'  // Answer to a query
  | 'handoff'   // Session/machine handoff context
  | 'wellness'  // Health check ping
  | 'system';   // Infrastructure message from the Instar server

/** Priority level — affects delivery urgency, retry behavior, and throttling */
export type MessagePriority = 'critical' | 'high' | 'medium' | 'low';

/** Application-level message — the content agents send and receive */
export interface AgentMessage {
  /** Unique message ID (UUID v4) */
  id: string;

  /** Sender identification */
  from: {
    /** Agent name (e.g., "dawn-portal") */
    agent: string;
    /** Session ID or "server" for system messages */
    session: string;
    /** Machine ID (from machine identity) */
    machine: string;
  };

  /** Recipient targeting */
  to: {
    /** Target agent name. "*" for broadcast to all agents on machine. */
    agent: string;
    /** Target session ID, "best" for intelligent routing, "*" for broadcast */
    session: string;
    /** Target machine ID, "local" for same machine, "*" for all machines */
    machine: string;
  };

  /** Message classification */
  type: MessageType;

  /** Priority level — affects delivery urgency and retry behavior */
  priority: MessagePriority;

  /** Human-readable subject line (max 200 chars) */
  subject: string;

  /** Message body — plain text, interpreted by the receiving session (max 4KB) */
  body: string;

  /** Optional structured payload (JSON-serializable, max 16KB) */
  payload?: Record<string, unknown>;

  /** Thread ID for conversation continuity */
  threadId?: string;

  /** ID of the message this is replying to */
  inReplyTo?: string;

  /** ISO timestamp of creation */
  createdAt: string;

  /** Time-to-live in minutes — controls delivery attempts, NOT data retention */
  ttlMinutes: number;
}

// ── Delivery State Machine ─────────────────────────────────────────

/**
 * Canonical delivery phases — monotonic progression.
 *
 * Transitions can only advance forward with ONE exception:
 * the post-injection watchdog can regress `delivered → queued`
 * if the target session crashes within 10 seconds of injection.
 */
export type DeliveryPhase =
  | 'created'        // Message constructed, not yet sent
  | 'sent'           // Written to sender's store
  | 'received'       // Target server acknowledged receipt
  | 'queued'         // Received but awaiting delivery (editor active, session unavailable)
  | 'undelivered'    // SpawnRequestManager queued but process is disposing; hand off to DeliveryRetryManager
  | 'delivered'      // Injected into target session's tmux input buffer
  | 'read'           // Target session acknowledged processing
  | 'expired'        // Delivery TTL elapsed without reaching 'delivered'
  | 'dead-lettered'  // Moved to dead-letter queue
  | 'failed';        // Unrecoverable delivery failure

/** A recorded delivery phase transition */
export interface DeliveryTransition {
  from: DeliveryPhase;
  to: DeliveryPhase;
  at: string;
  reason?: string;
}

/** Delivery tracking — updated by each hop */
export interface DeliveryState {
  /** Current delivery phase — monotonic, can only advance (see transition rules) */
  phase: DeliveryPhase;
  /** ISO timestamps for each phase transition */
  transitions: DeliveryTransition[];
  /** Number of delivery attempts at the current phase */
  attempts: number;
  /** If delivery failed or expired, the reason */
  failureReason?: string;
  /** For broadcasts: aggregate delivery state (separate from per-message phase) */
  broadcastState?: BroadcastState;
}

/** Per-recipient broadcast tracking */
export interface BroadcastRecipientState {
  phase: DeliveryPhase;
  lastAttempt?: string;
  failureReason?: string;
}

/**
 * Broadcast-specific aggregate state.
 * The `aggregate` field is NOT a DeliveryPhase — it is a derived summary
 * computed from individual recipient phases.
 */
export interface BroadcastState {
  /** Total number of recipients */
  totalRecipients: number;
  /** Per-recipient delivery tracking */
  recipients: Record<string, BroadcastRecipientState>;
  /** Aggregate status — derived, not a DeliveryPhase */
  aggregate: 'pending' | 'partial' | 'complete' | 'failed';
}

/**
 * Valid delivery phase transitions.
 * Used by the state machine to enforce monotonic progression.
 */
export const VALID_TRANSITIONS: ReadonlyArray<[DeliveryPhase, DeliveryPhase]> = [
  ['created', 'sent'],
  ['sent', 'received'],
  ['received', 'queued'],
  ['received', 'delivered'],
  ['queued', 'delivered'],
  ['delivered', 'queued'],      // Exception: post-injection crash watchdog
  ['delivered', 'read'],
  ['received', 'expired'],
  ['queued', 'expired'],
  ['expired', 'dead-lettered'],
  ['failed', 'dead-lettered'],
  // SpawnRequestManager dispose handoff: queued entries → undelivered for DeliveryRetryManager sweep.
  ['queued', 'undelivered'],
  ['received', 'undelivered'],
  ['undelivered', 'delivered'],
  ['undelivered', 'expired'],
  ['undelivered', 'queued'],    // DeliveryRetryManager may promote back to queued on pickup
  // Any phase can transition to 'failed' on unrecoverable error
  ['created', 'failed'],
  ['sent', 'failed'],
  ['received', 'failed'],
  ['queued', 'failed'],
  ['undelivered', 'failed'],
  ['delivered', 'failed'],
];

// ── Transport Layer ────────────────────────────────────────────────

/**
 * Fields included in cross-machine signature computation.
 * Signature = Ed25519.sign(canonicalJSON(signedPayload), signingKey)
 */
export interface SignedPayload {
  message: AgentMessage;
  relayChain: string[];
  originServer: string;
  nonce: string;
  timestamp: string;
}

/** Transport metadata — carried by every message envelope */
export interface TransportMetadata {
  /** Relay chain — machine IDs this envelope has passed through (loop prevention) */
  relayChain: string[];
  /** Origin server URL for ACK routing */
  originServer: string;
  /** Ed25519 signature of SignedPayload (cross-machine only) */
  signature?: string;
  /** Signing machine ID */
  signedBy?: string;
  /** HMAC-SHA256 of routing metadata using sender's agent token (same-machine drop only) */
  hmac?: string;
  /** HMAC signer — agent name */
  hmacBy?: string;
  /** Nonce for replay prevention (format: `{UUIDv4}:{ISO timestamp}`) */
  nonce: string;
  /** ISO timestamp — validated per transport type (see Clock Skew Tolerance) */
  timestamp: string;
  /**
   * Observability-only flag indicating the sender believed the message body
   * was already rendered to Telegram HTML. **The receiving (sending-to-Telegram)
   * machine IGNORES this flag** and re-runs its own formatter with its own
   * local config. Spec: "Multi-machine send-side-only".
   */
  alreadyFormatted?: boolean;
}

/**
 * Message envelope — the wire format for all inter-agent communication.
 * Separates transport concerns from application-level message data.
 */
export interface MessageEnvelope {
  /** Protocol version — must be checked on receipt */
  schemaVersion: 1;
  /** The application-level message */
  message: AgentMessage;
  /** Transport metadata */
  transport: TransportMetadata;
  /** Delivery tracking — updated by each hop */
  delivery: DeliveryState;
}

// ── Injection Safety ───────────────────────────────────────────────

/**
 * Pre-injection safety check state.
 * Determines whether it's safe to inject a message into a tmux session.
 */
export interface InjectionSafety {
  /** Current foreground process in the tmux pane */
  foregroundProcess: string;
  /** Whether the foreground process is on the whitelist */
  isSafeProcess: boolean;
  /** Whether a human client has recent activity (within 2 seconds) */
  hasHumanInput: boolean;
  /** Whether the session's context is near capacity */
  contextBudgetExceeded: boolean;
}

/**
 * Allowed foreground processes for injection.
 * Only inject if one of these is running — whitelist is strictly safer than blocklist.
 */
export const ALLOWED_INJECTION_PROCESSES: ReadonlyArray<string> = [
  'bash', 'zsh', 'fish', 'sh', 'dash', 'claude',
];

// ── Threads ────────────────────────────────────────────────────────

export type ThreadStatus = 'active' | 'resolved' | 'stale';

/** Multi-turn conversation thread between agents */
export interface MessageThread {
  id: string;
  subject: string;
  participants: ThreadParticipant[];
  createdAt: string;
  lastMessageAt: string;
  messageCount: number;
  status: ThreadStatus;
  /** All message IDs in chronological order */
  messageIds: string[];
}

export interface ThreadParticipant {
  agent: string;
  session: string;
  joinedAt: string;
  lastMessageAt: string;
}

// ── Configuration ──────────────────────────────────────────────────

/** Default TTL per message type (in minutes) */
export const DEFAULT_TTL: Record<MessageType, number> = {
  info: 30,
  sync: 15,
  alert: 60,
  request: 120,
  query: 30,
  response: 15,
  handoff: 480,
  wellness: 5,
  system: 60,
};

/** Default data retention per message type (in days) */
export const DEFAULT_RETENTION_DAYS: Record<MessageType, number> = {
  info: 7,
  sync: 3,
  alert: 30,
  request: 30,
  query: 7,
  response: 7,
  handoff: 90,
  wellness: 1,
  system: 30,
};

/** Rate limit configuration */
export interface RateLimitConfig {
  /** Max messages per window */
  maxMessages: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

/** Default rate limits per scope */
export const DEFAULT_RATE_LIMITS: Record<string, RateLimitConfig> = {
  'session-send': { maxMessages: 20, windowMs: 5 * 60_000 },
  'session-receive': { maxMessages: 30, windowMs: 5 * 60_000 },
  'agent-total': { maxMessages: 100, windowMs: 5 * 60_000 },
  'broadcast': { maxMessages: 5, windowMs: 5 * 60_000 },
  'cross-machine': { maxMessages: 30, windowMs: 5 * 60_000 },
  'inbound-triggered': { maxMessages: 5, windowMs: 60_000 },
};

/** Thread limits */
export const THREAD_MAX_DEPTH = 50;
export const THREAD_STALE_MINUTES = 30;

/** Message body size limits */
export const MAX_BODY_SIZE = 4096;         // 4KB
export const MAX_PAYLOAD_SIZE = 16_384;    // 16KB
export const MAX_SUBJECT_LENGTH = 200;
export const PAYLOAD_INLINE_THRESHOLD = 2048; // 2KB — payloads larger than this are written to temp files

/** Clock skew tolerance per transport type (in milliseconds) */
export const CLOCK_SKEW_TOLERANCE: Record<string, number | null> = {
  'relay-machine': 5 * 60_000,   // 5 minutes for cross-machine relay
  'relay-agent': null,            // No check — same machine
  'drop': null,                   // No check — offline transport
  'git-sync': null,               // No check — offline transport
  'outbound-queue': null,         // No check — queued for later
};

// ── Messaging Module Interfaces ────────────────────────────────────

/** Options for sending a message */
export interface SendMessageOptions {
  /** Override default TTL */
  ttlMinutes?: number;
  /** Thread to continue */
  threadId?: string;
  /** Message this is replying to */
  inReplyTo?: string;
}

/** Result of a send operation */
export interface SendResult {
  /** The message ID assigned */
  messageId: string;
  /** The thread ID (created or continued) */
  threadId?: string;
  /** Current delivery phase */
  phase: DeliveryPhase;
}

/** Filter options for inbox/outbox queries */
export interface MessageFilter {
  /** Filter by message type */
  type?: MessageType;
  /** Filter by priority */
  priority?: MessagePriority;
  /** Only unread (not yet at 'read' phase) */
  unread?: boolean;
  /** Filter by sender agent */
  fromAgent?: string;
  /** Filter by thread */
  threadId?: string;
  /** Max results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

/** Summary statistics for the messaging system */
export interface MessagingStats {
  volume: {
    sent: { total: number; last5min: number; last1hr: number };
    received: { total: number; last5min: number; last1hr: number };
    deadLettered: { total: number; last5min: number; last1hr: number };
  };
  delivery: {
    avgLatencyMs: { layer1: number; layer2: number; layer3: number };
    successRate: { layer1: number; layer2: number; layer3: number };
  };
  rateLimiting: {
    sessionsThrottled: number;
    circuitBreakers: { open: number; recentTrips: number };
  };
  threads: {
    active: number;
    resolved: number;
    stale: number;
  };
}

/** Configuration for the messaging subsystem */
export interface MessagingConfig {
  /** Base path for message storage (default: ~/.instar/messages) */
  storagePath?: string;
  /** Rate limit overrides */
  rateLimits?: Partial<Record<string, RateLimitConfig>>;
  /** Maximum store size in MB before alerting */
  maxStoreSizeMB?: number;
  /** Custom retention overrides per message type (in days) */
  retentionDays?: Partial<Record<MessageType, number>>;
  /** Thread depth limit (default: 50) */
  threadMaxDepth?: number;
}

// ── Store Interface ────────────────────────────────────────────────

/** Interface for the message persistence layer */
export interface IMessageStore {
  /** Initialize the store (create dirs, rebuild indexes) */
  initialize(): Promise<void>;

  /** Write an envelope to the store */
  save(envelope: MessageEnvelope): Promise<void>;

  /** Read an envelope by message ID */
  get(messageId: string): Promise<MessageEnvelope | null>;

  /** Update the delivery state of an envelope */
  updateDelivery(messageId: string, delivery: DeliveryState): Promise<void>;

  /**
   * Mark many messages as 'undelivered' in batches.
   * Used by SpawnRequestManager.dispose() to hand off queued entries to
   * DeliveryRetryManager before process shutdown.
   *
   * Yields between chunks via setImmediate so the event loop stays
   * responsive during SIGTERM. Returns the count of messages updated.
   * Missing/already-terminal messages are skipped silently.
   */
  markManyUndelivered(messageIds: string[], chunkSize?: number): Promise<number>;

  /** Query inbox messages with filters */
  queryInbox(agentName: string, filter?: MessageFilter): Promise<MessageEnvelope[]>;

  /** Query outbox messages with filters */
  queryOutbox(agentName: string, filter?: MessageFilter): Promise<MessageEnvelope[]>;

  /** Move a message to the dead-letter queue */
  deadLetter(messageId: string, reason: string): Promise<void>;

  /** Query dead-lettered messages with optional filters */
  queryDeadLetters(filter?: MessageFilter): Promise<MessageEnvelope[]>;

  /** Check if a message ID exists in the store */
  exists(messageId: string): Promise<boolean>;

  /** Save or update a thread */
  saveThread(thread: MessageThread): Promise<void>;

  /** Get a thread by ID */
  getThread(threadId: string): Promise<MessageThread | null>;

  /** List all threads with optional status filter */
  listThreads(status?: ThreadStatus): Promise<MessageThread[]>;

  /** Archive a thread (move to threads/archive/) */
  archiveThread(threadId: string): Promise<void>;

  /** Get messaging statistics */
  getStats(): Promise<MessagingStats>;

  /** Clean up expired messages and stale data */
  cleanup(): Promise<{ deleted: number; deadLettered: number }>;

  /** Destroy the store (for testing) */
  destroy(): Promise<void>;
}

// ── Delivery Interface ─────────────────────────────────────────────

/** Result of a delivery attempt */
export interface DeliveryResult {
  /** Whether the delivery attempt succeeded */
  success: boolean;
  /** The phase the message is now in */
  phase: DeliveryPhase;
  /** Reason for failure, if any */
  failureReason?: string;
  /** Whether to retry delivery */
  shouldRetry: boolean;
}

/** Interface for the message delivery mechanism */
export interface IMessageDelivery {
  /** Deliver a message to a target session via tmux injection */
  deliverToSession(sessionId: string, envelope: MessageEnvelope): Promise<DeliveryResult>;

  /** Check injection safety for a session */
  checkInjectionSafety(tmuxSession: string): Promise<InjectionSafety>;

  /** Format a message for inline delivery */
  formatInline(message: AgentMessage, threadContext?: MessageThread): string;

  /** Format a message as a pointer (context-limited delivery) */
  formatPointer(message: AgentMessage): string;
}

// ── Router Interface ───────────────────────────────────────────────

/** Result of routing a message to its destination */
export interface RoutingResult {
  /** Target session ID (resolved from "best" or broadcast) */
  targetSession: string;
  /** Routing method used */
  method: 'direct' | 'intelligent' | 'keyword-fallback' | 'broadcast' | 'queued' | 'spawn-requested';
  /** Confidence score (0-1) for intelligent routing */
  confidence?: number;
}

/** Interface for the message router */
export interface IMessageRouter {
  /** Send a new message — the primary entry point */
  send(
    from: AgentMessage['from'],
    to: AgentMessage['to'],
    type: MessageType,
    priority: MessagePriority,
    subject: string,
    body: string,
    options?: SendMessageOptions,
  ): Promise<SendResult>;

  /** Acknowledge receipt of a message */
  acknowledge(messageId: string, sessionId: string): Promise<void>;

  /** Relay an envelope from another agent or machine */
  relay(envelope: MessageEnvelope, source: 'agent' | 'machine'): Promise<boolean>;

  /** Get a single message by ID */
  getMessage(messageId: string): Promise<MessageEnvelope | null>;

  /** Query inbox messages for an agent */
  getInbox(agentName: string, filter?: MessageFilter): Promise<MessageEnvelope[]>;

  /** Query outbox messages for an agent */
  getOutbox(agentName: string, filter?: MessageFilter): Promise<MessageEnvelope[]>;

  /** Query dead-lettered messages */
  getDeadLetters(filter?: MessageFilter): Promise<MessageEnvelope[]>;

  /** Get a thread and its messages */
  getThread(threadId: string): Promise<{ thread: MessageThread; messages: MessageEnvelope[] } | null>;

  /** List all threads with optional status filter */
  listThreads(status?: ThreadStatus): Promise<MessageThread[]>;

  /** Resolve (close) a thread */
  resolveThread(threadId: string): Promise<void>;

  /** Get messaging statistics */
  getStats(): Promise<MessagingStats>;
}
