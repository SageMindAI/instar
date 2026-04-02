/**
 * NativeBackend — Read-only macOS Messages database integration.
 *
 * Provides:
 * - SQLite reads from ~/Library/Messages/chat.db (via better-sqlite3)
 * - Polling for new messages (watches max ROWID)
 * - Conversation context formatting for session bootstrap
 *
 * Does NOT send messages. Sending happens from Claude Code sessions
 * via imessage-reply.sh → imsg send CLI, because AppleScript Automation
 * permission doesn't propagate through LaunchAgent process trees.
 *
 * Requires:
 * - Full Disk Access for the process reading chat.db
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { IMessageIncoming, IMessageChat, ConnectionState } from './types.js';

// Apple Cocoa epoch: 2001-01-01T00:00:00Z in Unix epoch seconds
const APPLE_EPOCH_OFFSET = 978307200;

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');

export interface NativeBackendOptions {
  /** Path to chat.db (default: ~/Library/Messages/chat.db) */
  dbPath?: string;
  /** Poll interval for new messages in ms (default: 2000) */
  pollIntervalMs?: number;
  /** Include attachment metadata (default: true) */
  includeAttachments?: boolean;
  /** Path to persist poll offset (lastRowId) across restarts */
  offsetPath?: string;
  /** Authorized contacts (normalized E.164) — scopes SQL queries for defense-in-depth */
  authorizedContacts?: string[];
}

export class NativeBackend extends EventEmitter {
  private db: import('better-sqlite3').Database | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastRowId = 0;
  private _state: ConnectionState = 'disconnected';
  private readonly dbPath: string;
  private readonly pollIntervalMs: number;
  private readonly includeAttachments: boolean;
  private readonly offsetPath: string | null;
  private readonly authorizedContacts: string[];

  // Prepared statements (cached for performance)
  private stmtNewMessages: import('better-sqlite3').Statement | null = null;
  private stmtChats: import('better-sqlite3').Statement | null = null;
  private stmtHistory: import('better-sqlite3').Statement | null = null;
  private stmtMaxRowId: import('better-sqlite3').Statement | null = null;
  private stmtContextHistory: import('better-sqlite3').Statement | null = null;

  constructor(options: NativeBackendOptions = {}) {
    super();
    this.dbPath = options.dbPath || DEFAULT_DB_PATH;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.includeAttachments = options.includeAttachments ?? true;
    this.offsetPath = options.offsetPath ?? null;
    this.authorizedContacts = options.authorizedContacts ?? [];
  }

  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Open the Messages database and start polling for new messages.
   */
  async connect(): Promise<void> {
    if (this._state === 'connected') return;
    this._setState('connecting');

    try {
      const Database = (await import('better-sqlite3')).default;

      // Open without readonly flag — readonly mode cannot read the WAL (write-ahead log).
      // Messages.app writes to WAL continuously; new messages only appear in WAL until
      // a checkpoint flushes them to the main db file. query_only pragma prevents writes
      // while still allowing WAL reads.
      this.db = new Database(this.dbPath, { fileMustExist: true });
      this.db.pragma('query_only = ON');

      // Scope poll query to authorized contacts for defense-in-depth.
      // Even if the adapter's auth check is bypassed, the SQL itself won't return
      // unauthorized messages. Falls back to unscoped if no contacts configured.
      if (this.authorizedContacts.length > 0) {
        const placeholders = this.authorizedContacts.map(() => '?').join(', ');
        this.stmtNewMessages = this.db.prepare(`
          SELECT m.ROWID, m.guid, m.text, m.date, m.is_from_me, m.service,
                 m.associated_message_type,
                 h.id AS sender,
                 c.chat_identifier AS chat_id, c.display_name AS chat_name
          FROM message m
          LEFT JOIN handle h ON m.handle_id = h.ROWID
          LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
          LEFT JOIN chat c ON cmj.chat_id = c.ROWID
          WHERE m.ROWID > ?
            AND (m.is_from_me = 1 OR h.id IN (${placeholders}))
          ORDER BY m.ROWID ASC
        `);
      } else {
        this.stmtNewMessages = this.db.prepare(`
          SELECT m.ROWID, m.guid, m.text, m.date, m.is_from_me, m.service,
                 m.associated_message_type,
                 h.id AS sender,
                 c.chat_identifier AS chat_id, c.display_name AS chat_name
          FROM message m
          LEFT JOIN handle h ON m.handle_id = h.ROWID
          LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
          LEFT JOIN chat c ON cmj.chat_id = c.ROWID
          WHERE m.ROWID > ?
          ORDER BY m.ROWID ASC
        `);
      }

      // Scope chat listing to authorized contacts
      if (this.authorizedContacts.length > 0) {
        const placeholders = this.authorizedContacts.map(() => '?').join(', ');
        this.stmtChats = this.db.prepare(`
          SELECT c.ROWID AS id, c.chat_identifier, c.display_name, c.service_name,
                 c.guid, c.is_archived,
                 (SELECT MAX(m.date) FROM message m
                  JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
                  WHERE cmj.chat_id = c.ROWID) AS last_message_date
          FROM chat c
          WHERE c.chat_identifier IN (${placeholders})
          ORDER BY last_message_date DESC
          LIMIT ?
        `);
      } else {
        this.stmtChats = this.db.prepare(`
          SELECT c.ROWID AS id, c.chat_identifier, c.display_name, c.service_name,
                 c.guid, c.is_archived,
                 (SELECT MAX(m.date) FROM message m
                  JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
                  WHERE cmj.chat_id = c.ROWID) AS last_message_date
          FROM chat c
          ORDER BY last_message_date DESC
          LIMIT ?
        `);
      }

      this.stmtHistory = this.db.prepare(`
        SELECT m.ROWID, m.guid, m.text, m.date, m.is_from_me, m.service,
               h.id AS sender
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
        LEFT JOIN chat c ON cmj.chat_id = c.ROWID
        WHERE c.chat_identifier = ?
        ORDER BY m.date DESC
        LIMIT ?
      `);

      // Context history query — filters by sender handle (phone/email)
      this.stmtContextHistory = this.db.prepare(`
        SELECT m.ROWID, m.text, m.date, m.is_from_me, h.id AS sender
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
        LEFT JOIN chat c ON cmj.chat_id = c.ROWID
        WHERE (h.id = ? OR c.chat_identifier = ?)
          AND m.text IS NOT NULL
          AND m.associated_message_type = 0
        ORDER BY m.date DESC
        LIMIT ?
      `);

      this.stmtMaxRowId = this.db.prepare('SELECT MAX(ROWID) AS max_id FROM message');

      // Restore persisted poll offset if available; otherwise use a 50-message
      // lookback so messages received while the server was down are processed.
      const persistedOffset = this._loadOffset();
      if (persistedOffset !== null) {
        this.lastRowId = persistedOffset;
      } else {
        const maxRow = this.stmtMaxRowId.get() as { max_id: number } | undefined;
        const maxId = maxRow?.max_id ?? 0;
        this.lastRowId = Math.max(0, maxId - 50);
      }

      this._setState('connected');
      this._startPolling();
    } catch (err) {
      this._setState('error');
      throw new Error(`Failed to open Messages database: ${(err as Error).message}`);
    }
  }

  /**
   * Stop polling and close the database.
   */
  async disconnect(): Promise<void> {
    this._stopPolling();
    if (this.db) {
      try { this.db.close(); } catch { /* already closed */ }
      this.db = null;
    }
    this.stmtNewMessages = null;
    this.stmtChats = null;
    this.stmtHistory = null;
    this.stmtContextHistory = null;
    this.stmtMaxRowId = null;
    this._setState('disconnected');
  }

  /**
   * List recent chats.
   */
  listChats(limit = 20): IMessageChat[] {
    if (!this.db || !this.stmtChats) {
      throw new Error('Database not connected');
    }

    const chatBindParams = this.authorizedContacts.length > 0
      ? [...this.authorizedContacts, limit]
      : [limit];
    const rows = this.stmtChats.all(...chatBindParams) as Array<{
      id: number;
      chat_identifier: string;
      display_name: string | null;
      service_name: string;
      guid: string;
      is_archived: number;
      last_message_date: number | null;
    }>;

    return rows.map((row) => ({
      chatId: row.chat_identifier,
      displayName: row.display_name || undefined,
      participants: [row.chat_identifier],
      lastMessageDate: row.last_message_date
        ? this._cocoaToIso(row.last_message_date)
        : undefined,
      service: row.service_name,
    }));
  }

  /**
   * Get message history for a chat.
   */
  getChatHistory(chatId: string, limit = 50): IMessageIncoming[] {
    if (!this.db || !this.stmtHistory) {
      throw new Error('Database not connected');
    }

    // Defense-in-depth: only return history for authorized contacts
    if (this.authorizedContacts.length > 0 && !this.authorizedContacts.includes(chatId)) {
      return [];
    }

    const rows = this.stmtHistory.all(chatId, limit) as Array<{
      ROWID: number;
      guid: string;
      text: string | null;
      date: number;
      is_from_me: number;
      service: string;
      sender: string | null;
    }>;

    return rows.map((row) => ({
      chatId,
      messageId: row.guid,
      sender: row.sender || chatId,
      text: row.text || '',
      timestamp: this._cocoaToUnix(row.date),
      isFromMe: row.is_from_me === 1,
      service: row.service,
    }));
  }

  /**
   * Format conversation context for session bootstrap.
   * Returns a formatted string of recent messages suitable for injection
   * into a Claude Code session as conversation history.
   */
  getConversationContext(sender: string, limit = 20): string {
    if (!this.db || !this.stmtContextHistory) {
      return '';
    }

    try {
      const rows = this.stmtContextHistory.all(sender, sender, limit) as Array<{
        ROWID: number;
        text: string | null;
        date: number;
        is_from_me: number;
        sender: string | null;
      }>;

      if (rows.length === 0) return '';

      // Reverse to chronological order (query returns newest first)
      rows.reverse();

      const lines = rows.map((row) => {
        const time = new Date(this._cocoaToUnix(row.date) * 1000);
        const hh = time.getHours().toString().padStart(2, '0');
        const mm = time.getMinutes().toString().padStart(2, '0');
        const who = row.is_from_me ? 'Agent' : (row.sender || sender);
        const text = row.text || '(attachment)';
        return `[${hh}:${mm}] ${who}: ${text}`;
      });

      return `--- Conversation History (last ${rows.length} messages) ---\n${lines.join('\n')}\n--- End History ---`;
    } catch {
      return '';
    }
  }

  // ── Internal ──

  private _startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this._poll(), this.pollIntervalMs);
  }

  private _stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  _poll(): void {
    if (!this.db || !this.stmtNewMessages) return;

    try {
      // Pass authorized contacts as bind params when SQL is scoped
      const bindParams = this.authorizedContacts.length > 0
        ? [this.lastRowId, ...this.authorizedContacts]
        : [this.lastRowId];
      const rows = this.stmtNewMessages.all(...bindParams) as Array<{
        ROWID: number;
        guid: string;
        text: string | null;
        date: number;
        is_from_me: number;
        service: string;
        associated_message_type: number;
        sender: string | null;
        chat_id: string | null;
        chat_name: string | null;
      }>;

      const startRowId = this.lastRowId;
      for (const row of rows) {
        this.lastRowId = row.ROWID;

        // Skip non-text messages (reactions, edits, etc.)
        if (row.associated_message_type !== 0) continue;
        // Skip empty messages (typing indicators, read receipts)
        if (!row.text && !this.includeAttachments) continue;

        const msg: IMessageIncoming = {
          chatId: row.chat_id || row.sender || 'unknown',
          messageId: row.guid,
          sender: row.sender || 'unknown',
          senderName: row.chat_name || undefined,
          text: row.text || '',
          timestamp: this._cocoaToUnix(row.date),
          isFromMe: row.is_from_me === 1,
          service: row.service,
        };

        this.emit('message', msg);
      }
      // Persist offset if it advanced
      if (this.lastRowId > startRowId) {
        this._saveOffset(this.lastRowId);
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (!msg.includes('SQLITE_BUSY') && !msg.includes('database is locked')) {
        console.error(`[imessage-native] Poll error: ${msg}`);
      }
    }
  }

  private _setState(state: ConnectionState): void {
    const prev = this._state;
    this._state = state;
    if (prev !== state) {
      this.emit('stateChange', state, prev);
    }
  }

  /** Convert Apple Cocoa nanosecond timestamp to Unix epoch seconds. */
  _cocoaToUnix(cocoaNanos: number): number {
    return Math.floor(cocoaNanos / 1e9) + APPLE_EPOCH_OFFSET;
  }

  /** Load persisted poll offset from disk. */
  private _loadOffset(): number | null {
    if (!this.offsetPath) return null;
    try {
      const data = JSON.parse(fs.readFileSync(this.offsetPath, 'utf-8'));
      if (typeof data.lastRowId === 'number' && data.lastRowId > 0) {
        return data.lastRowId;
      }
    } catch { /* first run or corrupted — use lookback */ }
    return null;
  }

  /** Save poll offset to disk. */
  private _saveOffset(rowId: number): void {
    if (!this.offsetPath) return;
    try {
      fs.writeFileSync(this.offsetPath, JSON.stringify({ lastRowId: rowId, savedAt: new Date().toISOString() }) + '\n');
    } catch { /* non-critical */ }
  }

  /** Convert Apple Cocoa nanosecond timestamp to ISO string. */
  private _cocoaToIso(cocoaNanos: number): string {
    return new Date(this._cocoaToUnix(cocoaNanos) * 1000).toISOString();
  }
}
