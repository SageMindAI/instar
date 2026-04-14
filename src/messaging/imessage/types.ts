/**
 * iMessage adapter types — configuration, messages, and connection state.
 */

// ── Configuration ──

export interface IMessageConfig {
  /**
   * Path to the `imsg` CLI binary.
   * Defaults to 'imsg' (assumes it's in PATH).
   */
  cliPath?: string;

  /**
   * Path to the Messages database.
   * Defaults to ~/Library/Messages/chat.db
   */
  dbPath?: string;

  /**
   * Unified contact allowlist — gates BOTH inbound AND outbound.
   * Phone numbers should be in E.164 format (e.g., "+14081234567").
   * REQUIRED — fail-closed. Empty array = reject all messages AND block all sends.
   */
  authorizedContacts?: string[];

  /**
   * @deprecated Use `authorizedContacts` instead. If both are present, `authorizedContacts` takes precedence.
   */
  authorizedSenders?: string[];

  /**
   * Enable outbound sending (default: false — read-only mode).
   * When false, the adapter only receives messages.
   * ⚠️ Software-level guardrails only. See PROPOSAL-messaging-outbound-safety.md.
   */
  sendEnabled?: boolean;

  /**
   * Enable proactive (agent-initiated) sends to authorized contacts (default: false).
   * When false, the agent can only reply to contacts who messaged first (within reactiveWindowHours).
   * Requires sendEnabled: true.
   */
  proactiveSendEnabled?: boolean;

  /** Per-contact outbound rate limit per hour (default: 20) */
  maxOutboundPerHour?: number;

  /** Global outbound rate limit per day (default: 100) */
  maxOutboundPerDay?: number;

  /** Hours after last inbound before a reply counts as "proactive" (default: 24) */
  reactiveWindowHours?: number;

  /**
   * Trigger mode for incoming messages (default: "mention").
   * - "mention": only respond when message contains @{agentName}
   * - "all": respond to every message from authorized contacts
   */
  triggerMode?: 'mention' | 'all';

  /**
   * How to handle direct (1:1) messages when triggerMode is "mention".
   * - "mention": require @{agentName} even in 1:1 chats (default — safe, backward-compatible)
   * - "always": 1:1 chats bypass mention gating (opt-in to auto-trigger on DMs)
   * - "off": never trigger on 1:1 chats regardless of content
   *
   * Ignored when triggerMode is "all" (all messages trigger regardless).
   */
  directMessageTrigger?: 'mention' | 'always' | 'off';

  /**
   * Agent name for mention-based triggering (default: project name).
   * Used to detect @{agentName} in incoming messages.
   */
  agentName?: string;

  /** Include attachment metadata in incoming messages (default: true) */
  includeAttachments?: boolean;

  /** Poll interval for new messages in ms (default: 2000) */
  pollIntervalMs?: number;

  /** Stall detection timeout in minutes (default: 5) */
  stallTimeoutMinutes?: number;

  /** Promise follow-through timeout in minutes (default: 10) */
  promiseTimeoutMinutes?: number;

  /**
   * Send a brief text message when a message is received, before spawning a session.
   * Closes the feedback loop within seconds without cluttering the conversation.
   */
  immediateAck?: {
    /** Enable immediate acknowledgment (default: false) */
    enabled: boolean;
    /** Text message to send, e.g. "Got it, thinking..." (default: "Got it, thinking...") */
    message?: string;
    /** Cooldown in seconds — don't send again within this window (default: 30) */
    cooldownSeconds?: number;
  };
}

// ── JSON-RPC Protocol ──

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

// ── iMessage Domain Types ──

export interface IMessageIncoming {
  chatId: string;
  messageId: string;
  sender: string;
  senderName?: string;
  text: string;
  timestamp: number;
  isFromMe: boolean;
  attachments?: IMessageAttachment[];
  service?: string;
}

export interface IMessageAttachment {
  filename: string;
  mimeType: string;
  path: string;
  size?: number;
}

export interface IMessageChat {
  chatId: string;
  displayName?: string;
  participants: string[];
  lastMessageDate?: string;
  service?: string;
}

// ── Connection State ──

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectionInfo {
  state: ConnectionState;
  connectedAt?: string;
  lastError?: string;
  reconnectAttempts: number;
  pid?: number;
}
