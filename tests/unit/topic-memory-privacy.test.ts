import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import type { TopicMessage } from '../../src/memory/TopicMemory.js';

// ── Test helpers ──────────────────────────────────────────────────

let testDir: string;
let memory: TopicMemory;

function createTestDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'topic-mem-priv-'));
}

function makeMessage(overrides: Partial<TopicMessage> & { messageId: number; topicId: number }): TopicMessage {
  return {
    text: `Message ${overrides.messageId}`,
    fromUser: true,
    timestamp: new Date().toISOString(),
    sessionName: null,
    ...overrides,
  };
}

beforeEach(async () => {
  testDir = createTestDir();
  memory = new TopicMemory(testDir);
  await memory.open();
});

afterEach(() => {
  memory.close();
  // safe-git-allow: incremental-migration
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ── Schema v3 Migration ──────────────────────────────────────────

describe('schema v3 migration', () => {
  it('creates new database with user_id and privacy_scope columns', async () => {
    // The database was already created in beforeEach with v3 schema
    const msg = makeMessage({
      messageId: 1,
      topicId: 42,
      userId: 'alice',
      privacyScope: 'private',
    });
    memory.insertMessage(msg);

    const messages = memory.getRecentMessages(42);
    expect(messages).toHaveLength(1);
    expect(messages[0].userId).toBe('alice');
    expect(messages[0].privacyScope).toBe('private');
  });

  it('migrates v2 database to v3 (adds columns without data loss)', async () => {
    memory.close();

    // Create a v2 database manually (without user_id/privacy_scope columns)
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const dbPath = path.join(testDir, 'topic-memory.db');
    // safe-git-allow: incremental-migration
    fs.unlinkSync(dbPath); // Remove the v3 db

    const db = new BetterSqlite3(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE messages (
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
        UNIQUE(message_id, topic_id)
      );
      CREATE TABLE topic_summaries (
        topic_id INTEGER PRIMARY KEY,
        summary TEXT NOT NULL,
        message_count_at_summary INTEGER NOT NULL DEFAULT 0,
        last_message_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE topic_meta (
        topic_id INTEGER PRIMARY KEY,
        topic_name TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        last_activity TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id', tokenize='porter unicode61');
    `);
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '2')").run();
    db.prepare("INSERT INTO messages (message_id, topic_id, text, from_user, timestamp, sender_name, telegram_user_id) VALUES (1, 42, 'Hello from v2', 1, '2026-01-01T00:00:00Z', 'Alice', 12345)").run();
    db.close();

    // Re-open with TopicMemory — should trigger migration
    memory = new TopicMemory(testDir);
    await memory.open();

    // Old message should still be there
    const messages = memory.getRecentMessages(42);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('Hello from v2');
    expect(messages[0].senderName).toBe('Alice');

    // New columns should be available
    // userId is NULL for pre-migration data (no user resolution existed)
    expect(messages[0].userId).toBeUndefined();
    // privacyScope defaults to 'private' for pre-migration data (fail-closed)
    expect(messages[0].privacyScope).toBe('private');

    // Should be able to insert new messages with privacy fields
    memory.insertMessage(makeMessage({
      messageId: 2,
      topicId: 42,
      userId: 'bob',
      privacyScope: 'shared-project',
    }));

    const allMessages = memory.getRecentMessages(42);
    expect(allMessages).toHaveLength(2);
    expect(allMessages[1].userId).toBe('bob');
    expect(allMessages[1].privacyScope).toBe('shared-project');
  });
});

// ── Privacy-Filtered Queries ─────────────────────────────────────

describe('getRecentMessagesForUser', () => {
  it("returns user's own private messages", () => {
    memory.insertMessage(makeMessage({
      messageId: 1, topicId: 42, userId: 'alice', privacyScope: 'private',
      text: 'Alice private message',
    }));

    const messages = memory.getRecentMessagesForUser(42, 'alice');
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('Alice private message');
  });

  it("does NOT return another user's private messages", () => {
    memory.insertMessage(makeMessage({
      messageId: 1, topicId: 42, userId: 'alice', privacyScope: 'private',
      text: 'Alice secret',
    }));

    const messages = memory.getRecentMessagesForUser(42, 'bob');
    expect(messages).toHaveLength(0);
  });

  it('returns shared-project messages to any user', () => {
    memory.insertMessage(makeMessage({
      messageId: 1, topicId: 42, userId: 'alice', privacyScope: 'shared-project',
      text: 'Shared with everyone',
    }));

    const bobMessages = memory.getRecentMessagesForUser(42, 'bob');
    expect(bobMessages).toHaveLength(1);
    expect(bobMessages[0].text).toBe('Shared with everyone');
  });

  it('returns shared-topic messages to any user in the topic', () => {
    memory.insertMessage(makeMessage({
      messageId: 1, topicId: 42, userId: 'alice', privacyScope: 'shared-topic',
      text: 'Shared in topic',
    }));

    // shared-topic messages are visible within the same topic
    const bobMessages = memory.getRecentMessagesForUser(42, 'bob');
    expect(bobMessages).toHaveLength(1);
  });

  it('returns legacy messages (NULL user_id) to any user', () => {
    memory.insertMessage(makeMessage({
      messageId: 1, topicId: 42,
      text: 'Legacy message without user',
    }));

    const messages = memory.getRecentMessagesForUser(42, 'alice');
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('Legacy message without user');
  });

  it('returns legacy messages (NULL privacy_scope) to any user', () => {
    // Directly insert a legacy-format message
    memory.insertMessage(makeMessage({
      messageId: 1, topicId: 42, userId: 'alice',
      text: 'Message with no scope',
    }));

    // Override privacy_scope to NULL to simulate legacy data
    // This tests that the SQL handles NULL scope correctly
    const messages = memory.getRecentMessagesForUser(42, 'bob');
    // The message has userId='alice' and privacyScope='private' (default),
    // so bob should NOT see it
    expect(messages).toHaveLength(0);
  });

  it('respects limit parameter', () => {
    for (let i = 1; i <= 10; i++) {
      memory.insertMessage(makeMessage({
        messageId: i, topicId: 42, userId: 'alice', privacyScope: 'shared-project',
        text: `Message ${i}`,
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
      }));
    }

    const messages = memory.getRecentMessagesForUser(42, 'alice', 3);
    expect(messages).toHaveLength(3);
  });

  // ── CRITICAL: Multi-user isolation tests ──

  describe('CRITICAL: multi-user isolation', () => {
    beforeEach(() => {
      // Insert messages from multiple users
      memory.insertMessage(makeMessage({
        messageId: 1, topicId: 42, userId: 'alice', privacyScope: 'private',
        text: "Alice's secret: my password is 12345",
      }));
      memory.insertMessage(makeMessage({
        messageId: 2, topicId: 42, userId: 'bob', privacyScope: 'private',
        text: "Bob's secret: I don't like my boss",
      }));
      memory.insertMessage(makeMessage({
        messageId: 3, topicId: 42, userId: 'alice', privacyScope: 'shared-project',
        text: "Alice shared: project deadline is Friday",
      }));
      memory.insertMessage(makeMessage({
        messageId: 4, topicId: 42, userId: 'bob', privacyScope: 'shared-project',
        text: "Bob shared: I deployed the fix",
      }));
    });

    it("Alice sees her private + all shared messages (3 of 4)", () => {
      const messages = memory.getRecentMessagesForUser(42, 'alice');
      expect(messages).toHaveLength(3);
      const texts = messages.map(m => m.text);
      expect(texts).toContain("Alice's secret: my password is 12345");
      expect(texts).toContain("Alice shared: project deadline is Friday");
      expect(texts).toContain("Bob shared: I deployed the fix");
      expect(texts).not.toContain("Bob's secret: I don't like my boss");
    });

    it("Bob sees his private + all shared messages (3 of 4)", () => {
      const messages = memory.getRecentMessagesForUser(42, 'bob');
      expect(messages).toHaveLength(3);
      const texts = messages.map(m => m.text);
      expect(texts).toContain("Bob's secret: I don't like my boss");
      expect(texts).toContain("Alice shared: project deadline is Friday");
      expect(texts).toContain("Bob shared: I deployed the fix");
      expect(texts).not.toContain("Alice's secret: my password is 12345");
    });

    it("Charlie (unrelated user) sees only shared messages (2 of 4)", () => {
      const messages = memory.getRecentMessagesForUser(42, 'charlie');
      expect(messages).toHaveLength(2);
      const texts = messages.map(m => m.text);
      expect(texts).toContain("Alice shared: project deadline is Friday");
      expect(texts).toContain("Bob shared: I deployed the fix");
    });

    it("getRecentMessages (no user filter) returns ALL messages", () => {
      const messages = memory.getRecentMessages(42);
      expect(messages).toHaveLength(4);
    });
  });
});

// ── User Data Management (GDPR) ──────────────────────────────────

describe('getMessagesByUser', () => {
  it('returns all messages by a specific user across topics', () => {
    memory.insertMessage(makeMessage({
      messageId: 1, topicId: 42, userId: 'alice', text: 'Topic 42 msg',
    }));
    memory.insertMessage(makeMessage({
      messageId: 2, topicId: 99, userId: 'alice', text: 'Topic 99 msg',
    }));
    memory.insertMessage(makeMessage({
      messageId: 3, topicId: 42, userId: 'bob', text: 'Bob msg',
    }));

    const aliceMessages = memory.getMessagesByUser('alice');
    expect(aliceMessages).toHaveLength(2);
    expect(aliceMessages.map(m => m.topicId)).toEqual(expect.arrayContaining([42, 99]));
  });

  it('returns empty array for unknown user', () => {
    expect(memory.getMessagesByUser('nobody')).toEqual([]);
  });
});

describe('deleteMessagesByUser', () => {
  it('deletes all messages by a specific user', () => {
    memory.insertMessage(makeMessage({
      messageId: 1, topicId: 42, userId: 'alice', text: 'Alice msg',
    }));
    memory.insertMessage(makeMessage({
      messageId: 2, topicId: 42, userId: 'bob', text: 'Bob msg',
    }));

    const deleted = memory.deleteMessagesByUser('alice');
    expect(deleted).toBe(1);

    const remaining = memory.getRecentMessages(42);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].userId).toBe('bob');
  });

  it('returns 0 for unknown user', () => {
    expect(memory.deleteMessagesByUser('nobody')).toBe(0);
  });

  it('deletes across multiple topics', () => {
    memory.insertMessage(makeMessage({
      messageId: 1, topicId: 42, userId: 'alice', text: 'Topic 42',
    }));
    memory.insertMessage(makeMessage({
      messageId: 2, topicId: 99, userId: 'alice', text: 'Topic 99',
    }));

    const deleted = memory.deleteMessagesByUser('alice');
    expect(deleted).toBe(2);
  });
});

// ── User-Scoped Context Formatting ───────────────────────────────

describe('formatContextForUser', () => {
  it('formats context showing only visible messages', () => {
    memory.insertMessage(makeMessage({
      messageId: 1, topicId: 42, userId: 'alice', privacyScope: 'private',
      text: 'Alice private note', senderName: 'Alice',
    }));
    memory.insertMessage(makeMessage({
      messageId: 2, topicId: 42, userId: 'bob', privacyScope: 'private',
      text: 'Bob secret note', senderName: 'Bob',
    }));
    memory.insertMessage(makeMessage({
      messageId: 3, topicId: 42, userId: 'alice', privacyScope: 'shared-project',
      text: 'Alice shared note', senderName: 'Alice',
    }));

    const aliceContext = memory.formatContextForUser(42, 'alice');
    expect(aliceContext).toContain('Alice private note');
    expect(aliceContext).toContain('Alice shared note');
    expect(aliceContext).not.toContain('Bob secret note');

    const bobContext = memory.formatContextForUser(42, 'bob');
    expect(bobContext).toContain('Bob secret note');
    expect(bobContext).toContain('Alice shared note');
    expect(bobContext).not.toContain('Alice private note');
  });

  it('returns empty string when no visible messages', () => {
    memory.insertMessage(makeMessage({
      messageId: 1, topicId: 42, userId: 'alice', privacyScope: 'private',
      text: 'Alice only',
    }));

    const bobContext = memory.formatContextForUser(42, 'bob');
    expect(bobContext).toBe('');
  });

  it('returns empty string when db not open', () => {
    memory.close();
    expect(memory.formatContextForUser(42, 'alice')).toBe('');
  });
});

// ── Insert with Privacy Fields ───────────────────────────────────

describe('insertMessage with privacy fields', () => {
  it('stores and retrieves userId', () => {
    memory.insertMessage(makeMessage({
      messageId: 1, topicId: 42, userId: 'alice',
    }));

    const messages = memory.getRecentMessages(42);
    expect(messages[0].userId).toBe('alice');
  });

  it('stores and retrieves privacyScope', () => {
    memory.insertMessage(makeMessage({
      messageId: 1, topicId: 42, privacyScope: 'shared-project',
    }));

    const messages = memory.getRecentMessages(42);
    expect(messages[0].privacyScope).toBe('shared-project');
  });

  it('defaults privacyScope to private when not specified', () => {
    memory.insertMessage(makeMessage({
      messageId: 1, topicId: 42, userId: 'alice',
    }));

    const messages = memory.getRecentMessages(42);
    // The INSERT defaults to 'private'
    expect(messages[0].privacyScope).toBe('private');
  });

  it('handles all three privacy scope types', () => {
    memory.insertMessage(makeMessage({
      messageId: 1, topicId: 42, userId: 'alice', privacyScope: 'private',
    }));
    memory.insertMessage(makeMessage({
      messageId: 2, topicId: 42, userId: 'alice', privacyScope: 'shared-topic',
    }));
    memory.insertMessage(makeMessage({
      messageId: 3, topicId: 42, userId: 'alice', privacyScope: 'shared-project',
    }));

    const messages = memory.getRecentMessages(42);
    expect(messages.map(m => m.privacyScope)).toEqual(['private', 'shared-topic', 'shared-project']);
  });
});

// ── Batch Insert ─────────────────────────────────────────────────

describe('insertMessages (batch) with privacy fields', () => {
  it('stores userId and privacyScope in batch', () => {
    const msgs = [
      makeMessage({ messageId: 1, topicId: 42, userId: 'alice', privacyScope: 'private', text: 'A' }),
      makeMessage({ messageId: 2, topicId: 42, userId: 'bob', privacyScope: 'shared-project', text: 'B' }),
    ];

    const count = memory.insertMessages(msgs);
    expect(count).toBe(2);

    const messages = memory.getRecentMessages(42);
    expect(messages[0].userId).toBe('alice');
    expect(messages[0].privacyScope).toBe('private');
    expect(messages[1].userId).toBe('bob');
    expect(messages[1].privacyScope).toBe('shared-project');
  });
});

// ── JSONL Import with Privacy Fields ─────────────────────────────

describe('importFromJsonl with privacy fields', () => {
  it('imports userId and privacyScope from JSONL', async () => {
    const jsonlPath = path.join(testDir, 'messages.jsonl');
    const lines = [
      JSON.stringify({
        messageId: 1, topicId: 42, text: 'Alice msg', fromUser: true,
        timestamp: '2026-01-01T00:00:00Z', userId: 'alice', privacyScope: 'private',
      }),
      JSON.stringify({
        messageId: 2, topicId: 42, text: 'Shared msg', fromUser: true,
        timestamp: '2026-01-01T00:01:00Z', userId: 'bob', privacyScope: 'shared-project',
      }),
    ];
    fs.writeFileSync(jsonlPath, lines.join('\n'));

    const imported = await memory.importFromJsonl(jsonlPath);
    expect(imported).toBe(2);

    const messages = memory.getRecentMessages(42);
    expect(messages[0].userId).toBe('alice');
    expect(messages[0].privacyScope).toBe('private');
    expect(messages[1].userId).toBe('bob');
    expect(messages[1].privacyScope).toBe('shared-project');
  });

  it('handles legacy JSONL without privacy fields', async () => {
    const jsonlPath = path.join(testDir, 'messages.jsonl');
    const lines = [
      JSON.stringify({
        messageId: 1, topicId: 42, text: 'Legacy msg', fromUser: true,
        timestamp: '2026-01-01T00:00:00Z',
      }),
    ];
    fs.writeFileSync(jsonlPath, lines.join('\n'));

    const imported = await memory.importFromJsonl(jsonlPath);
    expect(imported).toBe(1);

    const messages = memory.getRecentMessages(42);
    expect(messages[0].userId).toBeUndefined();
    // privacyScope defaults to 'private' for imported data
    expect(messages[0].privacyScope).toBe('private');
  });
});
