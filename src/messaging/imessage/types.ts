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
   * Authorized sender identifiers (phone numbers or email addresses).
   * REQUIRED — fail-closed. Empty array = reject all messages.
   * Phone numbers should be in E.164 format (e.g., "+14081234567").
   */
  authorizedSenders: string[];

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
