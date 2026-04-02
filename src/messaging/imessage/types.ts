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
