/**
 * TopicMemory — SQLite-backed conversational memory per Telegram topic.
 *
 * Topic history is the HIGHEST priority context for any agent. It represents
 * what the user and agent have been working on — the living relationship.
 * All other context (identity, memory, relationships) supports this primary layer.
 *
 * Architecture:
 *   - Messages: Dual-written to JSONL (append log) AND SQLite (query layer)
 *   - Search: FTS5 full-text search over all messages, filterable by topic
 *   - Summaries: Rolling LLM-generated summaries per topic, updated on session end
 *   - Context: Session-start loads topic summary + recent messages as primary context
 *
 * The JSONL log remains the source of truth for disaster recovery.
 * SQLite is a derived query layer that can be rebuilt from JSONL at any time.
 *
 * Born from the insight: "Topic history represents the highest level of information
 * of what the user and the agent have been working on." — Justin, 2026-02-24
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// Dynamic import for better-sqlite3
type Database = import('better-sqlite3').Database;

export interface TopicMessage {
  messageId: number;
  topicId: number;
  text: string;
  fromUser: boolean;
  timestamp: string;
  sessionName: string | null;
  /** Sender display name (from Telegram first_name) */
  senderName?: string;
  /** Sender @username (optional — not all Telegram users have one) */
  senderUsername?: string;
  /** Telegram numeric user ID — authoritative identity */
  telegramUserId?: number;
  /** User ID from UserManager (resolved identity) */
  userId?: string;
  /** Privacy scope for this message (default: private to the sender) */
  privacyScope?: import('../core/types.js').PrivacyScopeType;
}

export interface TopicSummary {
  topicId: number;
  summary: string;
  /** One-line description of the topic's current focus (soft awareness, not a constraint) */
  purpose: string | null;
  messageCountAtSummary: number;
  lastMessageId: number;
  updatedAt: string;
}

export interface TopicMeta {
  topicId: number;
  topicName: string | null;
  messageCount: number;
  lastActivity: string;
  hasSummary: boolean;
}

export interface TopicSearchResult {
  text: string;
  topicId: number;
  fromUser: boolean;
  timestamp: string;
  messageId: number;
  rank: number;
  highlight?: string;
}

export interface TopicContext {
  /** Rolling summary of the full conversation (null if none generated yet) */
  summary: string | null;
  /** One-line description of the topic's current focus (null if not yet generated) */
  purpose: string | null;
  /** Recent messages (most recent N) */
  recentMessages: TopicMessage[];
  /** Total message count for this topic */
  totalMessages: number;
  /** Topic name if known */
  topicName: string | null;
}

const SCHEMA_VERSION = '4';

/**
 * Map a raw SQLite row to a TopicMessage with proper type coercion.
 */
function mapRow(row: any): TopicMessage {
  return {
    ...row,
    fromUser: !!row.fromUser,
    senderName: row.senderName ?? undefined,
    senderUsername: row.senderUsername ?? undefined,
    telegramUserId: row.telegramUserId ?? undefined,
    userId: row.userId ?? undefined,
    privacyScope: row.privacyScope ?? undefined,
  };
}

/**
 * Strip FTS5 special syntax characters from a query.
 */
function sanitizeFtsQuery(query: string): string {
  return query
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, '')
    .replace(/[*:"^{}().]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class TopicMemory {
  private db: Database | null = null;
  private dbPath: string;
  private stateDir: string;
  /** Set after corruption auto-recovery — caller should reimport from JSONL */
  private _needsRebuild = false;
  /** Stats from the most recent importFromJsonl() / rebuild() call */
  private _lastImportStats: { imported: number; malformed: number; missingFields: number } | null = null;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.dbPath = path.join(stateDir, 'topic-memory.db');
  }

  /**
   * Check if the database is open and ready for queries.
   * Use this to verify TopicMemory is functional before relying on it.
   */
  isReady(): boolean {
    return this.db !== null;
  }

  /**
   * Open the database and create schema if needed.
   */
  async open(): Promise<void> {
    if (this.db) return;

    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });

    this.db = new BetterSqlite3(this.dbPath);

    // Integrity check — auto-recover from corruption (JSONL is source of truth)
    if (fs.existsSync(this.dbPath) && fs.statSync(this.dbPath).size > 0) {
      try {
        const result = this.db.pragma('integrity_check') as Array<{ integrity_check: string }>;
        if (result[0]?.integrity_check !== 'ok') {
          console.warn(`[TopicMemory] Database corrupt (${result[0]?.integrity_check}) — deleting and rebuilding`);
          this.db.close();
          this.db = null;
          // safe-git-allow: incremental-migration
          fs.unlinkSync(this.dbPath);
          for (const ext of ['-wal', '-shm']) {
            // safe-git-allow: incremental-migration
            try { fs.unlinkSync(this.dbPath + ext); } catch { /* may not exist */ }
          }
          this.db = new BetterSqlite3(this.dbPath);
          this._needsRebuild = true;
        }
      } catch (err) {
        // If even the integrity check fails, the db is severely corrupted
        console.warn(`[TopicMemory] Database unreadable — deleting and rebuilding:`, err);
        try { this.db?.close(); } catch { /* ignore */ }
        this.db = null;
        // safe-git-allow: incremental-migration
        try { fs.unlinkSync(this.dbPath); } catch { /* ignore */ }
        for (const ext of ['-wal', '-shm']) {
          // safe-git-allow: incremental-migration
          try { fs.unlinkSync(this.dbPath + ext); } catch { /* may not exist */ }
        }
        this.db = new BetterSqlite3(this.dbPath);
        this._needsRebuild = true;
      }
    }

    // WAL mode for concurrent reads during writes
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    this.createSchema();

    // Auto-rebuild from JSONL after corruption recovery
    if (this._needsRebuild) {
      const jsonlPath = path.join(this.stateDir, 'telegram-messages.jsonl');
      if (fs.existsSync(jsonlPath)) {
        const imported = await this.importFromJsonl(jsonlPath);
        console.log(`[TopicMemory] Auto-rebuilt from JSONL: ${imported} messages reimported`);
      } else {
        console.warn('[TopicMemory] No JSONL log found for rebuild — starting fresh');
      }
      this._needsRebuild = false;
    }
  }

  /**
   * Close the database cleanly.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Checkpoint the WAL file. Call after sleep/wake to flush stale WAL locks.
   * Uses PASSIVE mode (non-blocking) — safe to call at any time.
   */
  checkpoint(): void {
    if (this.db) {
      try { this.db.pragma('wal_checkpoint(PASSIVE)'); } catch { /* non-critical */ }
    }
  }

  /**
   * Create the schema if it doesn't exist, and run migrations.
   */
  private createSchema(): void {
    if (!this.db) throw new Error('Database not open');

    this.db.exec(`
      -- Schema version tracking
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      -- All messages, indexed by topic
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        topic_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        from_user INTEGER NOT NULL DEFAULT 0,
        timestamp TEXT NOT NULL,
        session_name TEXT,
        sender_name TEXT,
        sender_username TEXT,
        telegram_user_id INTEGER,
        user_id TEXT,
        privacy_scope TEXT DEFAULT 'private',
        UNIQUE(message_id, topic_id)
      );

      -- Indexes for efficient topic queries
      CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_topic_id ON messages(topic_id, message_id);

      -- FTS5 full-text search over messages
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text,
        content='messages',
        content_rowid='id',
        tokenize='porter unicode61'
      );

      -- Triggers to keep FTS5 in sync with messages table
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
      END;

      -- Rolling summaries per topic
      CREATE TABLE IF NOT EXISTS topic_summaries (
        topic_id INTEGER PRIMARY KEY,
        summary TEXT NOT NULL,
        purpose TEXT,
        message_count_at_summary INTEGER NOT NULL DEFAULT 0,
        last_message_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      -- Topic metadata
      CREATE TABLE IF NOT EXISTS topic_meta (
        topic_id INTEGER PRIMARY KEY,
        topic_name TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        last_activity TEXT NOT NULL
      );
    `);

    // Run migrations for existing databases
    this.migrateSchema();

    // Ensure indexes exist (safe for both new and migrated databases)
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(telegram_user_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_privacy ON messages(privacy_scope)');

    // Set schema version
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
  }

  /**
   * Run schema migrations for existing databases.
   * SQLite ALTER TABLE ADD COLUMN is safe — new columns default to NULL
   * for existing rows.
   */
  private migrateSchema(): void {
    if (!this.db) return;

    const versionRow = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
    const currentVersion = versionRow?.value ?? '0';

    if (currentVersion < '2') {
      // Migration v1 → v2: Add sender identity columns
      // (User-Agent Topology Spec, Phase 1C)
      const columns = this.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
      const columnNames = new Set(columns.map(c => c.name));

      if (!columnNames.has('sender_name')) {
        this.db.exec('ALTER TABLE messages ADD COLUMN sender_name TEXT');
      }
      if (!columnNames.has('sender_username')) {
        this.db.exec('ALTER TABLE messages ADD COLUMN sender_username TEXT');
      }
      if (!columnNames.has('telegram_user_id')) {
        this.db.exec('ALTER TABLE messages ADD COLUMN telegram_user_id INTEGER');
      }

      // Add sender index if missing
      try {
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(telegram_user_id)');
      } catch { /* index may already exist */ }
    }

    if (currentVersion < '3') {
      // Migration v2 → v3: Add privacy scoping columns
      // (User-Agent Topology Spec, Phase 2B)
      const columns = this.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
      const columnNames = new Set(columns.map(c => c.name));

      if (!columnNames.has('user_id')) {
        this.db.exec("ALTER TABLE messages ADD COLUMN user_id TEXT");
      }
      if (!columnNames.has('privacy_scope')) {
        this.db.exec("ALTER TABLE messages ADD COLUMN privacy_scope TEXT DEFAULT 'private'");
      }

      // Add user_id index for privacy-filtered queries
      try {
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id)');
      } catch { /* index may already exist */ }
      try {
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_privacy ON messages(privacy_scope)');
      } catch { /* index may already exist */ }
    }

    if (currentVersion < '4') {
      // Migration v3 → v4: Add purpose column to topic_summaries
      // Purpose tracks the topic's current focus for soft session awareness.
      const columns = this.db.prepare("PRAGMA table_info(topic_summaries)").all() as Array<{ name: string }>;
      const columnNames = new Set(columns.map(c => c.name));

      if (!columnNames.has('purpose')) {
        this.db.exec('ALTER TABLE topic_summaries ADD COLUMN purpose TEXT');
      }
    }
  }

  // ── Message Operations ──────────────────────────────────────

  /**
   * Insert a message into the database.
   * Idempotent — duplicate messageId+topicId pairs are ignored.
   */
  insertMessage(msg: TopicMessage): void {
    if (!this.db) return;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages (message_id, topic_id, text, from_user, timestamp, session_name, sender_name, sender_username, telegram_user_id, user_id, privacy_scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      msg.messageId, msg.topicId, msg.text, msg.fromUser ? 1 : 0,
      msg.timestamp, msg.sessionName,
      msg.senderName ?? null, msg.senderUsername ?? null, msg.telegramUserId ?? null,
      msg.userId ?? null, msg.privacyScope ?? 'private',
    );

    // Update topic metadata
    this.db.prepare(`
      INSERT INTO topic_meta (topic_id, message_count, last_activity)
      VALUES (?, 1, ?)
      ON CONFLICT(topic_id) DO UPDATE SET
        message_count = message_count + 1,
        last_activity = excluded.last_activity
    `).run(msg.topicId, msg.timestamp);
  }

  /**
   * Batch-insert messages (for JSONL import).
   */
  insertMessages(messages: TopicMessage[]): number {
    if (!this.db) return 0;

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO messages (message_id, topic_id, text, from_user, timestamp, session_name, sender_name, sender_username, telegram_user_id, user_id, privacy_scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let count = 0;
    const tx = this.db.transaction(() => {
      for (const msg of messages) {
        const result = insert.run(
          msg.messageId, msg.topicId, msg.text, msg.fromUser ? 1 : 0,
          msg.timestamp, msg.sessionName,
          msg.senderName ?? null, msg.senderUsername ?? null, msg.telegramUserId ?? null,
          msg.userId ?? null, msg.privacyScope ?? 'private',
        );
        if (result.changes > 0) count++;
      }
    });
    tx();

    // Rebuild topic_meta from messages after bulk import
    this.rebuildTopicMeta();

    return count;
  }

  /**
   * Get recent messages for a topic.
   */
  getRecentMessages(topicId: number, limit: number = 20): TopicMessage[] {
    if (!this.db) return [];

    return this.db.prepare(`
      SELECT message_id AS messageId, topic_id AS topicId, text, from_user AS fromUser,
             timestamp, session_name AS sessionName,
             sender_name AS senderName, sender_username AS senderUsername, telegram_user_id AS telegramUserId,
             user_id AS userId, privacy_scope AS privacyScope
      FROM messages
      WHERE topic_id = ?
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).all(topicId, limit).reverse().map(mapRow) as TopicMessage[];
  }

  /**
   * Get recent messages for a topic, filtered by user visibility.
   * Returns only messages the specified user is allowed to see.
   *
   * Visibility rules:
   *   - Messages with scope 'shared-project' or NULL are visible to everyone
   *   - Messages with scope 'private' are visible only to the owner
   *   - Messages with scope 'shared-topic' are visible to all users in that topic
   *
   * Phase 2B — User-Agent Topology Spec, Gap 9
   */
  getRecentMessagesForUser(topicId: number, userId: string, limit: number = 20): TopicMessage[] {
    if (!this.db) return [];

    return this.db.prepare(`
      SELECT message_id AS messageId, topic_id AS topicId, text, from_user AS fromUser,
             timestamp, session_name AS sessionName,
             sender_name AS senderName, sender_username AS senderUsername, telegram_user_id AS telegramUserId,
             user_id AS userId, privacy_scope AS privacyScope
      FROM messages
      WHERE topic_id = ?
        AND (
          privacy_scope IS NULL
          OR privacy_scope = 'shared-project'
          OR privacy_scope = 'shared-topic'
          OR (privacy_scope = 'private' AND user_id = ?)
          OR user_id IS NULL
        )
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).all(topicId, userId, limit).reverse().map(mapRow) as TopicMessage[];
  }

  /**
   * Get the full context for a topic: summary + recent messages.
   * This is the primary context loader for session spawning.
   */
  getTopicContext(topicId: number, recentLimit: number = 20): TopicContext {
    if (!this.db) return { summary: null, purpose: null, recentMessages: [], totalMessages: 0, topicName: null };

    const summary = this.getTopicSummary(topicId);
    const recentMessages = this.getRecentMessages(topicId, recentLimit);
    const meta = this.getTopicMeta(topicId);

    return {
      summary: summary?.summary ?? null,
      purpose: summary?.purpose ?? null,
      recentMessages,
      totalMessages: meta?.messageCount ?? 0,
      topicName: meta?.topicName ?? null,
    };
  }

  /**
   * Get message count for a topic.
   */
  getMessageCount(topicId: number): number {
    if (!this.db) return 0;
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE topic_id = ?').get(topicId) as any;
    return row?.count ?? 0;
  }

  /**
   * Get all messages by a specific user across all topics.
   * Used by /mydata export (GDPR Article 15).
   */
  getMessagesByUser(userId: string): TopicMessage[] {
    if (!this.db) return [];

    return this.db.prepare(`
      SELECT message_id AS messageId, topic_id AS topicId, text, from_user AS fromUser,
             timestamp, session_name AS sessionName,
             sender_name AS senderName, sender_username AS senderUsername, telegram_user_id AS telegramUserId,
             user_id AS userId, privacy_scope AS privacyScope
      FROM messages
      WHERE user_id = ?
      ORDER BY timestamp ASC
    `).all(userId).map(mapRow) as TopicMessage[];
  }

  /**
   * Delete all messages by a specific user.
   * Used by /forget erasure (GDPR Article 17).
   * Returns the number of messages deleted.
   */
  deleteMessagesByUser(userId: string): number {
    if (!this.db) return 0;

    const result = this.db.prepare('DELETE FROM messages WHERE user_id = ?').run(userId);
    this.rebuildTopicMeta();
    return result.changes;
  }

  // ── Search ──────────────────────────────────────────────────

  /**
   * Full-text search across topic messages.
   * Optionally scoped to a single topic.
   */
  search(query: string, opts?: { topicId?: number; limit?: number }): TopicSearchResult[] {
    if (!this.db) return [];

    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];

    const limit = Math.min(opts?.limit ?? 20, 100);

    let sql: string;
    let params: any[];

    if (opts?.topicId !== undefined) {
      sql = `
        SELECT m.message_id AS messageId, m.topic_id AS topicId, m.text, m.from_user AS fromUser,
               m.timestamp, rank,
               highlight(messages_fts, 0, '<b>', '</b>') AS highlight
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        WHERE messages_fts MATCH ?
          AND m.topic_id = ?
        ORDER BY rank
        LIMIT ?
      `;
      params = [sanitized, opts.topicId, limit];
    } else {
      sql = `
        SELECT m.message_id AS messageId, m.topic_id AS topicId, m.text, m.from_user AS fromUser,
               m.timestamp, rank,
               highlight(messages_fts, 0, '<b>', '</b>') AS highlight
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        WHERE messages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `;
      params = [sanitized, limit];
    }

    return this.db.prepare(sql).all(...params).map((row: any) => ({
      ...row,
      fromUser: !!row.fromUser,
    })) as TopicSearchResult[];
  }

  // ── Summaries ───────────────────────────────────────────────

  /**
   * Get the rolling summary for a topic.
   */
  getTopicSummary(topicId: number): TopicSummary | null {
    if (!this.db) return null;

    const row = this.db.prepare(`
      SELECT topic_id AS topicId, summary, purpose,
             message_count_at_summary AS messageCountAtSummary,
             last_message_id AS lastMessageId, updated_at AS updatedAt
      FROM topic_summaries
      WHERE topic_id = ?
    `).get(topicId) as TopicSummary | undefined;

    return row ?? null;
  }

  /**
   * Save or update a rolling summary for a topic.
   */
  saveTopicSummary(topicId: number, summary: string, messageCount: number, lastMessageId: number, purpose?: string | null): void {
    if (!this.db) return;

    this.db.prepare(`
      INSERT INTO topic_summaries (topic_id, summary, purpose, message_count_at_summary, last_message_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(topic_id) DO UPDATE SET
        summary = excluded.summary,
        purpose = excluded.purpose,
        message_count_at_summary = excluded.message_count_at_summary,
        last_message_id = excluded.last_message_id,
        updated_at = excluded.updated_at
    `).run(topicId, summary, purpose ?? null, messageCount, lastMessageId, new Date().toISOString());
  }

  /**
   * Get messages since the last summary for a topic.
   * Used to generate incremental summary updates.
   */
  getMessagesSinceSummary(topicId: number): TopicMessage[] {
    if (!this.db) return [];

    const summary = this.getTopicSummary(topicId);
    const lastMessageId = summary?.lastMessageId ?? -1;

    return this.db.prepare(`
      SELECT message_id AS messageId, topic_id AS topicId, text, from_user AS fromUser,
             timestamp, session_name AS sessionName,
             sender_name AS senderName, sender_username AS senderUsername, telegram_user_id AS telegramUserId,
             user_id AS userId, privacy_scope AS privacyScope
      FROM messages
      WHERE topic_id = ? AND message_id > ?
      ORDER BY timestamp ASC
    `).all(topicId, lastMessageId).map(mapRow) as TopicMessage[];
  }

  /**
   * Check if a topic needs its summary updated.
   * Returns true if there are more than `threshold` new messages since the last summary.
   */
  needsSummaryUpdate(topicId: number, threshold: number = 20): boolean {
    if (!this.db) return false;

    const summary = this.getTopicSummary(topicId);
    const totalMessages = this.getMessageCount(topicId);

    if (!summary) {
      // No summary yet — need one if there are enough messages
      return totalMessages >= threshold;
    }

    return (totalMessages - summary.messageCountAtSummary) >= threshold;
  }

  // ── Topic Metadata ──────────────────────────────────────────

  /**
   * Get metadata for a topic.
   */
  getTopicMeta(topicId: number): TopicMeta | null {
    if (!this.db) return null;

    const row = this.db.prepare(`
      SELECT topic_id AS topicId, topic_name AS topicName, message_count AS messageCount,
             last_activity AS lastActivity
      FROM topic_meta
      WHERE topic_id = ?
    `).get(topicId) as any;

    if (!row) return null;

    const hasSummary = !!this.db.prepare('SELECT 1 FROM topic_summaries WHERE topic_id = ?').get(topicId);
    return { ...row, hasSummary };
  }

  /**
   * Update topic name in metadata.
   */
  setTopicName(topicId: number, name: string): void {
    if (!this.db) return;

    this.db.prepare(`
      INSERT INTO topic_meta (topic_id, topic_name, message_count, last_activity)
      VALUES (?, ?, 0, ?)
      ON CONFLICT(topic_id) DO UPDATE SET topic_name = excluded.topic_name
    `).run(topicId, name, new Date().toISOString());
  }

  /**
   * List all topics with metadata.
   */
  listTopics(): TopicMeta[] {
    if (!this.db) return [];

    const rows = this.db.prepare(`
      SELECT tm.topic_id AS topicId, tm.topic_name AS topicName,
             tm.message_count AS messageCount, tm.last_activity AS lastActivity,
             CASE WHEN ts.topic_id IS NOT NULL THEN 1 ELSE 0 END AS hasSummary
      FROM topic_meta tm
      LEFT JOIN topic_summaries ts ON ts.topic_id = tm.topic_id
      ORDER BY tm.last_activity DESC
    `).all() as any[];

    return rows.map(r => ({ ...r, hasSummary: !!r.hasSummary }));
  }

  // ── Import / Rebuild ────────────────────────────────────────

  /**
   * Import messages from the JSONL log file using streaming reads.
   * Idempotent — only inserts messages not already in the database.
   * Returns the number of new messages imported.
   *
   * Uses readline.createInterface on a read stream instead of
   * fs.readFileSync to avoid OOM on large JSONL files (100K+ messages).
   */
  async importFromJsonl(jsonlPath: string): Promise<number> {
    if (!this.db) return 0;
    if (!fs.existsSync(jsonlPath)) return 0;

    const db = this.db;
    const insert = db.prepare(`
      INSERT OR IGNORE INTO messages (message_id, topic_id, text, from_user, timestamp, session_name, sender_name, sender_username, telegram_user_id, user_id, privacy_scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let count = 0;
    let malformed = 0;
    let missingFields = 0;
    const BATCH_SIZE = 500;
    let batch: TopicMessage[] = [];

    const flushBatch = () => {
      if (batch.length === 0) return;
      const tx = db.transaction(() => {
        for (const msg of batch) {
          const result = insert.run(
            msg.messageId, msg.topicId, msg.text, msg.fromUser ? 1 : 0,
            msg.timestamp, msg.sessionName,
            msg.senderName ?? null, msg.senderUsername ?? null, msg.telegramUserId ?? null,
            msg.userId ?? null, msg.privacyScope ?? 'private',
          );
          if (result.changes > 0) count++;
        }
      });
      tx();
      batch = [];
    };

    const rl = readline.createInterface({
      input: fs.createReadStream(jsonlPath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.topicId != null && entry.text) {
          batch.push({
            messageId: entry.messageId,
            topicId: entry.topicId,
            text: entry.text,
            fromUser: entry.fromUser ?? false,
            timestamp: entry.timestamp,
            sessionName: entry.sessionName ?? null,
            senderName: entry.senderName ?? undefined,
            senderUsername: entry.senderUsername ?? undefined,
            telegramUserId: entry.telegramUserId ?? undefined,
            userId: entry.userId ?? undefined,
            privacyScope: entry.privacyScope ?? undefined,
          });
          if (batch.length >= BATCH_SIZE) {
            flushBatch();
          }
        } else {
          // Valid JSON but missing the fields we need — count separately from malformed JSON.
          missingFields++;
        }
      } catch {
        // @silent-fallback-ok — JSONL parse error; count so we can surface it at end.
        malformed++;
      }
    }

    // Flush remaining
    flushBatch();

    // Rebuild topic_meta from messages after import
    this.rebuildTopicMeta();

    // Surface parse / schema problems at end of import so operators can
    // diagnose corrupted JSONL without tailing logs during the hot path.
    if (malformed > 0 || missingFields > 0) {
      console.warn(
        `[TopicMemory] importFromJsonl(${jsonlPath}): imported=${count} malformed_json=${malformed} missing_fields=${missingFields}`,
      );
    }

    this._lastImportStats = { imported: count, malformed, missingFields };
    return count;
  }

  /**
   * Returns stats from the most recent importFromJsonl() / rebuild() call.
   * Useful for tests and /topic/rebuild endpoints that want to surface
   * parse-error counts in the API response.
   */
  getLastImportStats(): { imported: number; malformed: number; missingFields: number } | null {
    return this._lastImportStats;
  }

  /**
   * Full rebuild — drop all data and reimport from JSONL.
   */
  async rebuild(jsonlPath: string): Promise<number> {
    if (!this.db) return 0;

    this.db.exec('DELETE FROM messages');
    this.db.exec('DELETE FROM topic_meta');
    // Keep summaries — they're LLM-generated and expensive to recreate
    this.db.exec(`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`);

    return this.importFromJsonl(jsonlPath);
  }

  /**
   * Rebuild topic_meta counts from messages table.
   */
  private rebuildTopicMeta(): void {
    if (!this.db) return;

    this.db.exec(`
      INSERT OR REPLACE INTO topic_meta (topic_id, topic_name, message_count, last_activity)
      SELECT
        topic_id,
        (SELECT topic_name FROM topic_meta WHERE topic_id = m.topic_id),
        COUNT(*),
        MAX(timestamp)
      FROM messages m
      GROUP BY topic_id
    `);
  }

  // ── Stats ───────────────────────────────────────────────────

  /**
   * Get database statistics.
   */
  stats(): {
    totalMessages: number;
    totalTopics: number;
    topicsWithSummaries: number;
    dbSizeBytes: number;
  } {
    if (!this.db) return { totalMessages: 0, totalTopics: 0, topicsWithSummaries: 0, dbSizeBytes: 0 };

    const msgCount = (this.db.prepare('SELECT COUNT(*) AS c FROM messages').get() as any)?.c ?? 0;
    const topicCount = (this.db.prepare('SELECT COUNT(*) AS c FROM topic_meta').get() as any)?.c ?? 0;
    const summaryCount = (this.db.prepare('SELECT COUNT(*) AS c FROM topic_summaries').get() as any)?.c ?? 0;

    let dbSize = 0;
    try {
      dbSize = fs.statSync(this.dbPath).size;
    } catch { /* @silent-fallback-ok — stat returns 0, non-critical */ }

    return {
      totalMessages: msgCount,
      totalTopics: topicCount,
      topicsWithSummaries: summaryCount,
      dbSizeBytes: dbSize,
    };
  }

  /**
   * Format topic context as readable text for session injection, filtered by user.
   * Returns only messages the specified user is allowed to see.
   *
   * Phase 2B — User-Agent Topology Spec, Gap 9
   */
  formatContextForUser(topicId: number, userId: string, recentLimit: number = 30): string {
    if (!this.db) return '';

    const recentMessages = this.getRecentMessagesForUser(topicId, userId, recentLimit);
    const summary = this.getTopicSummary(topicId);
    const meta = this.getTopicMeta(topicId);

    if (recentMessages.length === 0 && !summary) return '';

    const totalMessages = meta?.messageCount ?? 0;
    const topicName = meta?.topicName ?? null;

    const lines: string[] = [];
    lines.push(`--- TOPIC CONTEXT (${totalMessages} total messages) ---`);

    if (topicName) {
      lines.push(`Topic: ${topicName}`);
    }

    if (summary?.purpose) {
      lines.push(`Current focus: ${summary.purpose}`);
    }

    if (summary) {
      lines.push('');
      lines.push('CONVERSATION SUMMARY:');
      lines.push(summary.summary);
    }

    if (recentMessages.length > 0) {
      lines.push('');
      lines.push(`RECENT MESSAGES (last ${recentMessages.length}${summary ? ', since last summary' : ''}):`);
      lines.push('');
      for (const m of recentMessages) {
        const sender = m.fromUser
          ? (m.senderName || 'User')
          : 'Agent';
        const ts = m.timestamp ? new Date(m.timestamp).toISOString().slice(11, 19) : '??:??';
        const text = (m.text || '').slice(0, 2000);
        lines.push(`[${ts}] ${sender}: ${text}`);
      }
    }

    lines.push('');
    lines.push('--- END TOPIC CONTEXT ---');
    return lines.join('\n');
  }

  /**
   * Format topic context as readable text for session injection.
   * This is the primary interface for loading topic context into a session.
   */
  formatContextForSession(topicId: number, recentLimit: number = 50): string {
    // Return empty string when db is not open — callers use this as a falsy check
    // to trigger JSONL fallback. A non-empty string from a broken db would
    // prevent the fallback and leave the session without conversation history.
    if (!this.db) return '';

    const ctx = this.getTopicContext(topicId, recentLimit);

    // Also return empty if the db is open but has no data for this topic —
    // the JSONL might have messages that weren't imported yet.
    if (ctx.recentMessages.length === 0 && !ctx.summary) return '';

    const lines: string[] = [];

    lines.push(`--- TOPIC CONTEXT (${ctx.totalMessages} total messages) ---`);

    if (ctx.topicName) {
      lines.push(`Topic: ${ctx.topicName}`);
    }

    if (ctx.purpose) {
      lines.push(`Current focus: ${ctx.purpose}`);
    }

    if (ctx.summary) {
      lines.push('');
      lines.push('CONVERSATION SUMMARY:');
      lines.push(ctx.summary);
    }

    if (ctx.recentMessages.length > 0) {
      lines.push('');
      lines.push(`RECENT MESSAGES (last ${ctx.recentMessages.length}${ctx.summary ? ', since last summary' : ''}):`);
      lines.push('');
      for (const m of ctx.recentMessages) {
        // Use sender name when available, fall back to generic "User"
        const sender = m.fromUser
          ? (m.senderName || 'User')
          : 'Agent';
        const ts = m.timestamp ? new Date(m.timestamp).toISOString().slice(11, 19) : '??:??';
        const text = (m.text || '').slice(0, 2000);
        lines.push(`[${ts}] ${sender}: ${text}`);
      }
    }

    lines.push('');
    lines.push('To search conversation history: curl http://localhost:PORT/topic/search?topic=TOPIC_ID&q=QUERY');
    lines.push('--- END TOPIC CONTEXT ---');

    return lines.join('\n');
  }
}
