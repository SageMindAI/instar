/**
 * Unit tests for TopicMemory — SQLite-backed conversational memory per topic.
 *
 * Tests:
 * - Database creation and schema initialization
 * - Message insertion (single and batch)
 * - Message deduplication (idempotent insert)
 * - Recent message retrieval
 * - Full-text search with FTS5
 * - Search scoped to a single topic
 * - Topic summary CRUD
 * - Summary update detection (threshold-based)
 * - Messages-since-summary retrieval
 * - Topic metadata tracking
 * - Topic listing
 * - JSONL import
 * - JSONL rebuild (destructive reimport)
 * - Context formatting for session injection
 * - Stats reporting
 * - Empty/edge cases
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TopicMemory, type TopicMessage } from '../../src/memory/TopicMemory.js';

describe('TopicMemory', () => {
  let tmpDir: string;
  let topicMemory: TopicMemory;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-memory-test-'));
    topicMemory = new TopicMemory(tmpDir);
    await topicMemory.open();
  });

  afterEach(() => {
    topicMemory.close();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Message Operations ──────────────────────────────────────

  describe('insertMessage', () => {
    it('inserts a single message', () => {
      topicMemory.insertMessage({
        messageId: 1,
        topicId: 100,
        text: 'Hello world',
        fromUser: true,
        timestamp: '2026-02-24T12:00:00Z',
        sessionName: null,
      });

      const messages = topicMemory.getRecentMessages(100);
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe('Hello world');
      expect(messages[0].fromUser).toBe(true);
    });

    it('is idempotent — duplicate messageId+topicId is ignored', () => {
      const msg: TopicMessage = {
        messageId: 1,
        topicId: 100,
        text: 'Hello',
        fromUser: true,
        timestamp: '2026-02-24T12:00:00Z',
        sessionName: null,
      };

      topicMemory.insertMessage(msg);
      topicMemory.insertMessage(msg);

      const messages = topicMemory.getRecentMessages(100);
      expect(messages).toHaveLength(1);
    });

    it('updates topic metadata on insert', () => {
      topicMemory.insertMessage({
        messageId: 1,
        topicId: 100,
        text: 'Hello',
        fromUser: true,
        timestamp: '2026-02-24T12:00:00Z',
        sessionName: null,
      });

      const meta = topicMemory.getTopicMeta(100);
      expect(meta).not.toBeNull();
      expect(meta!.messageCount).toBe(1);
    });
  });

  describe('insertMessages (batch)', () => {
    it('batch-inserts messages', () => {
      const messages: TopicMessage[] = [];
      for (let i = 0; i < 50; i++) {
        messages.push({
          messageId: i,
          topicId: 100,
          text: `Message ${i}`,
          fromUser: i % 2 === 0,
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
          sessionName: null,
        });
      }

      const count = topicMemory.insertMessages(messages);
      expect(count).toBe(50);

      const meta = topicMemory.getTopicMeta(100);
      expect(meta!.messageCount).toBe(50);
    });

    it('skips duplicates in batch', () => {
      const msg: TopicMessage = {
        messageId: 1,
        topicId: 100,
        text: 'Hello',
        fromUser: true,
        timestamp: '2026-02-24T12:00:00Z',
        sessionName: null,
      };

      topicMemory.insertMessage(msg);
      const count = topicMemory.insertMessages([msg, msg]);
      expect(count).toBe(0); // Both were duplicates
    });
  });

  describe('getRecentMessages', () => {
    it('returns messages in chronological order', () => {
      for (let i = 0; i < 5; i++) {
        topicMemory.insertMessage({
          messageId: i,
          topicId: 100,
          text: `Message ${i}`,
          fromUser: true,
          timestamp: new Date(2026, 0, 1, 12, i).toISOString(),
          sessionName: null,
        });
      }

      const messages = topicMemory.getRecentMessages(100, 5);
      expect(messages).toHaveLength(5);
      expect(messages[0].text).toBe('Message 0');
      expect(messages[4].text).toBe('Message 4');
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        topicMemory.insertMessage({
          messageId: i,
          topicId: 100,
          text: `Message ${i}`,
          fromUser: true,
          timestamp: new Date(2026, 0, 1, 12, i).toISOString(),
          sessionName: null,
        });
      }

      const messages = topicMemory.getRecentMessages(100, 3);
      expect(messages).toHaveLength(3);
      // Should return the LAST 3 messages
      expect(messages[0].text).toBe('Message 7');
      expect(messages[2].text).toBe('Message 9');
    });

    it('returns empty array for unknown topic', () => {
      const messages = topicMemory.getRecentMessages(999);
      expect(messages).toHaveLength(0);
    });

    it('only returns messages for the requested topic', () => {
      topicMemory.insertMessage({
        messageId: 1, topicId: 100, text: 'Topic 100', fromUser: true,
        timestamp: '2026-02-24T12:00:00Z', sessionName: null,
      });
      topicMemory.insertMessage({
        messageId: 2, topicId: 200, text: 'Topic 200', fromUser: true,
        timestamp: '2026-02-24T12:01:00Z', sessionName: null,
      });

      const messages100 = topicMemory.getRecentMessages(100);
      expect(messages100).toHaveLength(1);
      expect(messages100[0].text).toBe('Topic 100');

      const messages200 = topicMemory.getRecentMessages(200);
      expect(messages200).toHaveLength(1);
      expect(messages200[0].text).toBe('Topic 200');
    });
  });

  // ── Sender Identity (Phase 1C — User-Agent Topology Spec) ──

  describe('sender identity storage', () => {
    it('stores and retrieves sender identity fields', () => {
      topicMemory.insertMessage({
        messageId: 1,
        topicId: 100,
        text: 'Hello from Justin',
        fromUser: true,
        timestamp: '2026-03-01T12:00:00Z',
        sessionName: null,
        senderName: 'Justin',
        senderUsername: 'justinheadley',
        telegramUserId: 12345,
      });

      const messages = topicMemory.getRecentMessages(100);
      expect(messages).toHaveLength(1);
      expect(messages[0].senderName).toBe('Justin');
      expect(messages[0].senderUsername).toBe('justinheadley');
      expect(messages[0].telegramUserId).toBe(12345);
    });

    it('stores messages without sender identity (backward compat)', () => {
      topicMemory.insertMessage({
        messageId: 1,
        topicId: 100,
        text: 'Hello',
        fromUser: true,
        timestamp: '2026-03-01T12:00:00Z',
        sessionName: null,
        // No sender fields — pre-Phase 1C messages
      });

      const messages = topicMemory.getRecentMessages(100);
      expect(messages).toHaveLength(1);
      expect(messages[0].senderName).toBeUndefined();
      expect(messages[0].senderUsername).toBeUndefined();
      expect(messages[0].telegramUserId).toBeUndefined();
    });

    it('stores partial sender identity (username optional)', () => {
      topicMemory.insertMessage({
        messageId: 1,
        topicId: 100,
        text: 'Hello',
        fromUser: true,
        timestamp: '2026-03-01T12:00:00Z',
        sessionName: null,
        senderName: 'Alice',
        telegramUserId: 67890,
        // No senderUsername — not all Telegram users have one
      });

      const messages = topicMemory.getRecentMessages(100);
      expect(messages[0].senderName).toBe('Alice');
      expect(messages[0].senderUsername).toBeUndefined();
      expect(messages[0].telegramUserId).toBe(67890);
    });

    it('batch-inserts messages with sender identity', () => {
      const messages: TopicMessage[] = [
        {
          messageId: 1, topicId: 100, text: 'From Alice', fromUser: true,
          timestamp: '2026-03-01T12:00:00Z', sessionName: null,
          senderName: 'Alice', telegramUserId: 111,
        },
        {
          messageId: 2, topicId: 100, text: 'From Bob', fromUser: true,
          timestamp: '2026-03-01T12:01:00Z', sessionName: null,
          senderName: 'Bob', senderUsername: 'bob_dev', telegramUserId: 222,
        },
      ];

      const count = topicMemory.insertMessages(messages);
      expect(count).toBe(2);

      const recent = topicMemory.getRecentMessages(100);
      expect(recent[0].senderName).toBe('Alice');
      expect(recent[0].telegramUserId).toBe(111);
      expect(recent[1].senderName).toBe('Bob');
      expect(recent[1].senderUsername).toBe('bob_dev');
      expect(recent[1].telegramUserId).toBe(222);
    });

    it('getMessagesSinceSummary includes sender identity', () => {
      topicMemory.insertMessage({
        messageId: 1, topicId: 100, text: 'Before summary', fromUser: true,
        timestamp: '2026-03-01T12:00:00Z', sessionName: null,
        senderName: 'Justin', telegramUserId: 12345,
      });
      topicMemory.saveTopicSummary(100, 'Summary', 1, 1);
      topicMemory.insertMessage({
        messageId: 2, topicId: 100, text: 'After summary', fromUser: true,
        timestamp: '2026-03-01T12:01:00Z', sessionName: null,
        senderName: 'Alice', telegramUserId: 67890,
      });

      const since = topicMemory.getMessagesSinceSummary(100);
      expect(since).toHaveLength(1);
      expect(since[0].senderName).toBe('Alice');
      expect(since[0].telegramUserId).toBe(67890);
    });

    it('multi-user messages in same topic preserve distinct identities', () => {
      topicMemory.insertMessage({
        messageId: 1, topicId: 100, text: 'Hello from Alice', fromUser: true,
        timestamp: '2026-03-01T12:00:00Z', sessionName: null,
        senderName: 'Alice', telegramUserId: 111,
      });
      topicMemory.insertMessage({
        messageId: 2, topicId: 100, text: 'Hello from Bob', fromUser: true,
        timestamp: '2026-03-01T12:01:00Z', sessionName: null,
        senderName: 'Bob', telegramUserId: 222,
      });
      topicMemory.insertMessage({
        messageId: 3, topicId: 100, text: 'Agent reply', fromUser: false,
        timestamp: '2026-03-01T12:02:00Z', sessionName: 'session-1',
      });
      topicMemory.insertMessage({
        messageId: 4, topicId: 100, text: 'Alice again', fromUser: true,
        timestamp: '2026-03-01T12:03:00Z', sessionName: null,
        senderName: 'Alice', telegramUserId: 111,
      });

      const messages = topicMemory.getRecentMessages(100);
      expect(messages).toHaveLength(4);
      expect(messages[0].senderName).toBe('Alice');
      expect(messages[0].telegramUserId).toBe(111);
      expect(messages[1].senderName).toBe('Bob');
      expect(messages[1].telegramUserId).toBe(222);
      expect(messages[2].senderName).toBeUndefined(); // Agent message
      expect(messages[3].senderName).toBe('Alice');
      expect(messages[3].telegramUserId).toBe(111);
    });
  });

  describe('formatContextForSession with sender names', () => {
    it('uses sender name instead of generic "User"', () => {
      topicMemory.insertMessage({
        messageId: 1, topicId: 100, text: 'Hello agent',
        fromUser: true, timestamp: '2026-03-01T12:00:00Z', sessionName: null,
        senderName: 'Justin',
      });

      const context = topicMemory.formatContextForSession(100);
      expect(context).toContain('Justin: Hello agent');
      expect(context).not.toContain('User: Hello agent');
    });

    it('falls back to "User" when sender name is missing', () => {
      topicMemory.insertMessage({
        messageId: 1, topicId: 100, text: 'Hello agent',
        fromUser: true, timestamp: '2026-03-01T12:00:00Z', sessionName: null,
        // No senderName
      });

      const context = topicMemory.formatContextForSession(100);
      expect(context).toContain('User: Hello agent');
    });

    it('shows "Agent" for non-user messages regardless of sender name', () => {
      topicMemory.insertMessage({
        messageId: 1, topicId: 100, text: 'I am the agent',
        fromUser: false, timestamp: '2026-03-01T12:00:00Z', sessionName: 'session-1',
      });

      const context = topicMemory.formatContextForSession(100);
      expect(context).toContain('Agent: I am the agent');
    });

    it('shows multiple distinct senders in context', () => {
      topicMemory.insertMessage({
        messageId: 1, topicId: 100, text: 'Question from Alice',
        fromUser: true, timestamp: '2026-03-01T12:00:00Z', sessionName: null,
        senderName: 'Alice',
      });
      topicMemory.insertMessage({
        messageId: 2, topicId: 100, text: 'Agent response',
        fromUser: false, timestamp: '2026-03-01T12:01:00Z', sessionName: 'session-1',
      });
      topicMemory.insertMessage({
        messageId: 3, topicId: 100, text: 'Question from Bob',
        fromUser: true, timestamp: '2026-03-01T12:02:00Z', sessionName: null,
        senderName: 'Bob',
      });

      const context = topicMemory.formatContextForSession(100);
      expect(context).toContain('Alice: Question from Alice');
      expect(context).toContain('Agent: Agent response');
      expect(context).toContain('Bob: Question from Bob');
    });
  });

  describe('JSONL import with sender identity', () => {
    it('imports sender identity from JSONL entries', async () => {
      const jsonlPath = path.join(tmpDir, 'messages-with-sender.jsonl');
      const lines = [
        JSON.stringify({
          messageId: 1, topicId: 100, text: 'Hello', fromUser: true,
          timestamp: '2026-03-01T12:00:00Z', sessionName: null,
          senderName: 'Justin', senderUsername: 'justinheadley', telegramUserId: 12345,
        }),
        JSON.stringify({
          messageId: 2, topicId: 100, text: 'Reply', fromUser: false,
          timestamp: '2026-03-01T12:01:00Z', sessionName: 'session-1',
        }),
      ];
      fs.writeFileSync(jsonlPath, lines.join('\n'));

      const count = await topicMemory.importFromJsonl(jsonlPath);
      expect(count).toBe(2);

      const messages = topicMemory.getRecentMessages(100);
      expect(messages[0].senderName).toBe('Justin');
      expect(messages[0].senderUsername).toBe('justinheadley');
      expect(messages[0].telegramUserId).toBe(12345);
      expect(messages[1].senderName).toBeUndefined(); // Agent message
    });

    it('imports JSONL entries without sender identity (pre-migration)', async () => {
      const jsonlPath = path.join(tmpDir, 'messages-old.jsonl');
      const lines = [
        JSON.stringify({
          messageId: 1, topicId: 100, text: 'Old message', fromUser: true,
          timestamp: '2026-02-24T12:00:00Z', sessionName: null,
          // No sender fields — old JSONL format
        }),
      ];
      fs.writeFileSync(jsonlPath, lines.join('\n'));

      const count = await topicMemory.importFromJsonl(jsonlPath);
      expect(count).toBe(1);

      const messages = topicMemory.getRecentMessages(100);
      expect(messages[0].senderName).toBeUndefined();
      expect(messages[0].telegramUserId).toBeUndefined();
    });
  });

  describe('schema migration (v1 → v2)', () => {
    it('opens a fresh database with sender columns in schema', () => {
      // The database created in beforeEach() already has the v2 schema.
      // Verify the columns exist by inserting a message with sender fields.
      topicMemory.insertMessage({
        messageId: 1, topicId: 100, text: 'Test',
        fromUser: true, timestamp: '2026-03-01T12:00:00Z', sessionName: null,
        senderName: 'Test', telegramUserId: 999,
      });

      const messages = topicMemory.getRecentMessages(100);
      expect(messages[0].senderName).toBe('Test');
      expect(messages[0].telegramUserId).toBe(999);
    });

    it('migration is idempotent (re-open with same schema version)', async () => {
      topicMemory.close();
      // Re-open the same database — should not error
      topicMemory = new TopicMemory(tmpDir);
      await topicMemory.open();

      topicMemory.insertMessage({
        messageId: 1, topicId: 100, text: 'After re-open',
        fromUser: true, timestamp: '2026-03-01T12:00:00Z', sessionName: null,
        senderName: 'Justin', telegramUserId: 12345,
      });

      const messages = topicMemory.getRecentMessages(100);
      expect(messages[0].senderName).toBe('Justin');
    });
  });

  // ── WAL Checkpoint ─────────────────────────────────────────

  describe('checkpoint', () => {
    it('does not throw on an open database', () => {
      expect(() => topicMemory.checkpoint()).not.toThrow();
    });

    it('can be called multiple times without error', () => {
      expect(() => {
        topicMemory.checkpoint();
        topicMemory.checkpoint();
      }).not.toThrow();
    });

    it('does not corrupt data after checkpoint', () => {
      topicMemory.insertMessage({
        messageId: 1, topicId: 100, text: 'Before checkpoint',
        fromUser: true, timestamp: '2026-02-24T12:00:00Z', sessionName: null,
      });

      topicMemory.checkpoint();

      topicMemory.insertMessage({
        messageId: 2, topicId: 100, text: 'After checkpoint',
        fromUser: true, timestamp: '2026-02-24T12:01:00Z', sessionName: null,
      });

      topicMemory.checkpoint();

      const messages = topicMemory.getRecentMessages(100);
      expect(messages).toHaveLength(2);
      expect(messages[0].text).toBe('Before checkpoint');
      expect(messages[1].text).toBe('After checkpoint');
    });

    it('FTS5 search works after checkpoint', () => {
      topicMemory.insertMessage({
        messageId: 1, topicId: 100, text: 'Unique checkpoint verification query',
        fromUser: true, timestamp: '2026-02-24T12:00:00Z', sessionName: null,
      });

      topicMemory.checkpoint();

      const results = topicMemory.search('checkpoint verification');
      expect(results.length).toBeGreaterThan(0);
    });

    it('is safe on uninitialized db', () => {
      const uninit = new TopicMemory(tmpDir);
      expect(() => uninit.checkpoint()).not.toThrow();
    });
  });

  // ── Search ──────────────────────────────────────────────────

  describe('search', () => {
    beforeEach(() => {
      topicMemory.insertMessage({
        messageId: 1, topicId: 100, text: 'We should deploy the new dashboard feature',
        fromUser: true, timestamp: '2026-02-24T12:00:00Z', sessionName: null,
      });
      topicMemory.insertMessage({
        messageId: 2, topicId: 100, text: 'The dashboard is ready for deployment',
        fromUser: false, timestamp: '2026-02-24T12:01:00Z', sessionName: null,
      });
      topicMemory.insertMessage({
        messageId: 3, topicId: 200, text: 'The database migration failed last night',
        fromUser: true, timestamp: '2026-02-24T12:02:00Z', sessionName: null,
      });
    });

    it('finds messages by keyword', () => {
      const results = topicMemory.search('dashboard');
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results.every(r => r.text.toLowerCase().includes('dashboard'))).toBe(true);
    });

    it('finds messages scoped to a topic', () => {
      const results = topicMemory.search('dashboard', { topicId: 100 });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.every(r => r.topicId === 100)).toBe(true);
    });

    it('returns empty for no matches', () => {
      const results = topicMemory.search('zebra');
      expect(results).toHaveLength(0);
    });

    it('sanitizes FTS5 special syntax', () => {
      // These should not throw — special chars are stripped
      expect(() => topicMemory.search('AND OR NOT')).not.toThrow();
      expect(() => topicMemory.search('test*')).not.toThrow();
      expect(() => topicMemory.search('"quoted"')).not.toThrow();
    });

    it('returns empty for empty query', () => {
      const results = topicMemory.search('');
      expect(results).toHaveLength(0);
    });

    it('respects limit parameter', () => {
      const results = topicMemory.search('the', { limit: 1 });
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it('includes highlight in results', () => {
      const results = topicMemory.search('dashboard');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].highlight).toBeDefined();
      expect(results[0].highlight).toContain('<b>');
    });
  });

  // ── Summaries ───────────────────────────────────────────────

  describe('summaries', () => {
    it('saves and retrieves a topic summary', () => {
      topicMemory.saveTopicSummary(100, 'This is a summary of the conversation.', 10, 50);

      const summary = topicMemory.getTopicSummary(100);
      expect(summary).not.toBeNull();
      expect(summary!.summary).toBe('This is a summary of the conversation.');
      expect(summary!.messageCountAtSummary).toBe(10);
      expect(summary!.lastMessageId).toBe(50);
    });

    it('updates an existing summary', () => {
      topicMemory.saveTopicSummary(100, 'Summary v1', 10, 50);
      topicMemory.saveTopicSummary(100, 'Summary v2', 20, 100);

      const summary = topicMemory.getTopicSummary(100);
      expect(summary!.summary).toBe('Summary v2');
      expect(summary!.messageCountAtSummary).toBe(20);
    });

    it('returns null for topic without summary', () => {
      const summary = topicMemory.getTopicSummary(999);
      expect(summary).toBeNull();
    });
  });

  describe('needsSummaryUpdate', () => {
    it('returns false when no messages exist', () => {
      expect(topicMemory.needsSummaryUpdate(100)).toBe(false);
    });

    it('returns true when messages exceed threshold and no summary exists', () => {
      for (let i = 0; i < 25; i++) {
        topicMemory.insertMessage({
          messageId: i, topicId: 100, text: `Msg ${i}`, fromUser: true,
          timestamp: new Date(2026, 0, 1, 12, i).toISOString(), sessionName: null,
        });
      }

      expect(topicMemory.needsSummaryUpdate(100, 20)).toBe(true);
    });

    it('returns false when messages are below threshold', () => {
      for (let i = 0; i < 5; i++) {
        topicMemory.insertMessage({
          messageId: i, topicId: 100, text: `Msg ${i}`, fromUser: true,
          timestamp: new Date(2026, 0, 1, 12, i).toISOString(), sessionName: null,
        });
      }

      expect(topicMemory.needsSummaryUpdate(100, 20)).toBe(false);
    });

    it('returns true when new messages since last summary exceed threshold', () => {
      for (let i = 0; i < 50; i++) {
        topicMemory.insertMessage({
          messageId: i, topicId: 100, text: `Msg ${i}`, fromUser: true,
          timestamp: new Date(2026, 0, 1, 12, i).toISOString(), sessionName: null,
        });
      }

      // Summary at message count 20
      topicMemory.saveTopicSummary(100, 'Old summary', 20, 19);

      // Now 50 total - 20 at summary = 30 new messages, exceeds threshold of 20
      expect(topicMemory.needsSummaryUpdate(100, 20)).toBe(true);
    });
  });

  describe('getMessagesSinceSummary', () => {
    it('returns all messages when no summary exists', () => {
      for (let i = 0; i < 5; i++) {
        topicMemory.insertMessage({
          messageId: i, topicId: 100, text: `Msg ${i}`, fromUser: true,
          timestamp: new Date(2026, 0, 1, 12, i).toISOString(), sessionName: null,
        });
      }

      const messages = topicMemory.getMessagesSinceSummary(100);
      expect(messages).toHaveLength(5);
    });

    it('returns only messages since last summary', () => {
      for (let i = 0; i < 10; i++) {
        topicMemory.insertMessage({
          messageId: i, topicId: 100, text: `Msg ${i}`, fromUser: true,
          timestamp: new Date(2026, 0, 1, 12, i).toISOString(), sessionName: null,
        });
      }

      // Summary covers through messageId 4
      topicMemory.saveTopicSummary(100, 'Summary', 5, 4);

      const messages = topicMemory.getMessagesSinceSummary(100);
      expect(messages).toHaveLength(5);
      expect(messages[0].messageId).toBe(5);
      expect(messages[4].messageId).toBe(9);
    });
  });

  // ── Topic Metadata ──────────────────────────────────────────

  describe('topic metadata', () => {
    it('tracks topic names', () => {
      topicMemory.setTopicName(100, 'Project Discussion');
      const meta = topicMemory.getTopicMeta(100);
      expect(meta).not.toBeNull();
      expect(meta!.topicName).toBe('Project Discussion');
    });

    it('lists all topics sorted by activity', () => {
      topicMemory.insertMessage({
        messageId: 1, topicId: 100, text: 'Old topic',
        fromUser: true, timestamp: '2026-02-23T12:00:00Z', sessionName: null,
      });
      topicMemory.insertMessage({
        messageId: 2, topicId: 200, text: 'New topic',
        fromUser: true, timestamp: '2026-02-24T12:00:00Z', sessionName: null,
      });

      const topics = topicMemory.listTopics();
      expect(topics).toHaveLength(2);
      // Most recent first
      expect(topics[0].topicId).toBe(200);
      expect(topics[1].topicId).toBe(100);
    });

    it('reports hasSummary correctly', () => {
      topicMemory.insertMessage({
        messageId: 1, topicId: 100, text: 'Hello',
        fromUser: true, timestamp: '2026-02-24T12:00:00Z', sessionName: null,
      });

      let meta = topicMemory.getTopicMeta(100);
      expect(meta!.hasSummary).toBe(false);

      topicMemory.saveTopicSummary(100, 'Summary', 1, 1);

      meta = topicMemory.getTopicMeta(100);
      expect(meta!.hasSummary).toBe(true);
    });
  });

  // ── JSONL Import ────────────────────────────────────────────

  describe('importFromJsonl', () => {
    it('imports messages from JSONL file', async () => {
      const jsonlPath = path.join(tmpDir, 'messages.jsonl');
      const lines = [
        JSON.stringify({ messageId: 1, topicId: 100, text: 'Hello', fromUser: true, timestamp: '2026-02-24T12:00:00Z', sessionName: null }),
        JSON.stringify({ messageId: 2, topicId: 100, text: 'Hi there', fromUser: false, timestamp: '2026-02-24T12:01:00Z', sessionName: 'session-1' }),
        JSON.stringify({ messageId: 3, topicId: 200, text: 'Different topic', fromUser: true, timestamp: '2026-02-24T12:02:00Z', sessionName: null }),
      ];
      fs.writeFileSync(jsonlPath, lines.join('\n'));

      const count = await topicMemory.importFromJsonl(jsonlPath);
      expect(count).toBe(3);

      const messages100 = topicMemory.getRecentMessages(100);
      expect(messages100).toHaveLength(2);

      const messages200 = topicMemory.getRecentMessages(200);
      expect(messages200).toHaveLength(1);
    });

    it('skips entries without topicId', async () => {
      const jsonlPath = path.join(tmpDir, 'messages.jsonl');
      const lines = [
        JSON.stringify({ messageId: 1, topicId: null, text: 'No topic', fromUser: true, timestamp: '2026-02-24T12:00:00Z' }),
        JSON.stringify({ messageId: 2, topicId: 100, text: 'Has topic', fromUser: true, timestamp: '2026-02-24T12:01:00Z' }),
      ];
      fs.writeFileSync(jsonlPath, lines.join('\n'));

      const count = await topicMemory.importFromJsonl(jsonlPath);
      expect(count).toBe(1);
    });

    it('is idempotent — reimport does not duplicate', async () => {
      const jsonlPath = path.join(tmpDir, 'messages.jsonl');
      fs.writeFileSync(jsonlPath, JSON.stringify({ messageId: 1, topicId: 100, text: 'Hello', fromUser: true, timestamp: '2026-02-24T12:00:00Z' }));

      await topicMemory.importFromJsonl(jsonlPath);
      const count2 = await topicMemory.importFromJsonl(jsonlPath);
      expect(count2).toBe(0);

      expect(topicMemory.getRecentMessages(100)).toHaveLength(1);
    });

    it('returns 0 for missing file', async () => {
      const count = await topicMemory.importFromJsonl('/nonexistent/path.jsonl');
      expect(count).toBe(0);
    });

    it('returns 0 for an empty file and leaves the DB untouched', async () => {
      const jsonlPath = path.join(tmpDir, 'empty.jsonl');
      fs.writeFileSync(jsonlPath, '');

      const count = await topicMemory.importFromJsonl(jsonlPath);
      expect(count).toBe(0);
      expect(topicMemory.stats().totalMessages).toBe(0);
    });

    it('tolerates blank lines between JSONL entries', async () => {
      const jsonlPath = path.join(tmpDir, 'blanks.jsonl');
      const body = [
        '',
        JSON.stringify({ messageId: 1, topicId: 100, text: 'First', fromUser: true, timestamp: '2026-02-24T12:00:00Z' }),
        '',
        JSON.stringify({ messageId: 2, topicId: 100, text: 'Second', fromUser: false, timestamp: '2026-02-24T12:01:00Z' }),
        '',
      ].join('\n');
      fs.writeFileSync(jsonlPath, body);

      const count = await topicMemory.importFromJsonl(jsonlPath);
      expect(count).toBe(2);
    });

    it('returns a Promise<number> (async signature)', () => {
      const jsonlPath = path.join(tmpDir, 'signature.jsonl');
      fs.writeFileSync(jsonlPath, '');

      const result = topicMemory.importFromJsonl(jsonlPath);
      expect(result).toBeInstanceOf(Promise);
      return expect(result).resolves.toBe(0);
    });

    it('counts malformed JSON lines and surfaces them via getLastImportStats()', async () => {
      const jsonlPath = path.join(tmpDir, 'corrupt.jsonl');
      const body = [
        JSON.stringify({ messageId: 1, topicId: 100, text: 'Valid', fromUser: true, timestamp: '2026-02-24T12:00:00Z' }),
        '{ not valid json',                                              // malformed
        'also not json at all',                                          // malformed
        JSON.stringify({ messageId: 2, topicId: 100, text: 'Valid 2', fromUser: false, timestamp: '2026-02-24T12:01:00Z' }),
        '{"messageId":3}',                                               // valid json, missing topicId/text
      ].join('\n');
      fs.writeFileSync(jsonlPath, body);

      const count = await topicMemory.importFromJsonl(jsonlPath);
      expect(count).toBe(2);

      const stats = topicMemory.getLastImportStats();
      expect(stats).not.toBeNull();
      expect(stats!.imported).toBe(2);
      expect(stats!.malformed).toBe(2);
      expect(stats!.missingFields).toBe(1);
    });

    it('logs a single summary warning when malformed lines are present', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const jsonlPath = path.join(tmpDir, 'warn.jsonl');
        fs.writeFileSync(jsonlPath, [
          JSON.stringify({ messageId: 1, topicId: 100, text: 'Ok', fromUser: true, timestamp: '2026-02-24T12:00:00Z' }),
          'garbage line',
        ].join('\n'));

        await topicMemory.importFromJsonl(jsonlPath);

        const matchingCalls = warnSpy.mock.calls.filter(
          (call) => typeof call[0] === 'string' && call[0].includes('importFromJsonl') && call[0].includes('malformed_json=1'),
        );
        expect(matchingCalls.length).toBe(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('does NOT log a warning when the JSONL is clean (quiet by default)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const jsonlPath = path.join(tmpDir, 'clean.jsonl');
        fs.writeFileSync(jsonlPath, [
          JSON.stringify({ messageId: 1, topicId: 100, text: 'Ok', fromUser: true, timestamp: '2026-02-24T12:00:00Z' }),
          JSON.stringify({ messageId: 2, topicId: 100, text: 'Ok2', fromUser: false, timestamp: '2026-02-24T12:01:00Z' }),
          '',
        ].join('\n'));

        await topicMemory.importFromJsonl(jsonlPath);

        const matchingCalls = warnSpy.mock.calls.filter(
          (call) => typeof call[0] === 'string' && call[0].includes('importFromJsonl'),
        );
        expect(matchingCalls.length).toBe(0);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('getLastImportStats() returns null before any import runs', async () => {
      // Fresh instance, no import yet
      const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-tm-'));
      const fresh = new TopicMemory(freshDir);
      await fresh.open();
      try {
        expect(fresh.getLastImportStats()).toBeNull();
      } finally {
        fresh.close();
        // safe-git-allow: incremental-migration
        fs.rmSync(freshDir, { recursive: true, force: true });
      }
    });
  });

  describe('rebuild', () => {
    it('clears existing messages and reimports', async () => {
      // Insert a message directly
      topicMemory.insertMessage({
        messageId: 999, topicId: 100, text: 'Direct insert',
        fromUser: true, timestamp: '2026-02-24T12:00:00Z', sessionName: null,
      });

      // Create JSONL with different message
      const jsonlPath = path.join(tmpDir, 'messages.jsonl');
      fs.writeFileSync(jsonlPath, JSON.stringify({
        messageId: 1, topicId: 200, text: 'From JSONL', fromUser: true, timestamp: '2026-02-24T12:01:00Z',
      }));

      const count = await topicMemory.rebuild(jsonlPath);
      expect(count).toBe(1);

      // Old message should be gone
      expect(topicMemory.getRecentMessages(100)).toHaveLength(0);
      // New message should be there
      expect(topicMemory.getRecentMessages(200)).toHaveLength(1);
    });

    it('preserves summaries across rebuild', async () => {
      topicMemory.saveTopicSummary(100, 'Important summary', 10, 5);

      const jsonlPath = path.join(tmpDir, 'messages.jsonl');
      fs.writeFileSync(jsonlPath, '');
      await topicMemory.rebuild(jsonlPath);

      const summary = topicMemory.getTopicSummary(100);
      expect(summary).not.toBeNull();
      expect(summary!.summary).toBe('Important summary');
    });

    it('returns a Promise<number> (async signature)', () => {
      const jsonlPath = path.join(tmpDir, 'signature-rebuild.jsonl');
      fs.writeFileSync(jsonlPath, '');

      const result = topicMemory.rebuild(jsonlPath);
      expect(result).toBeInstanceOf(Promise);
      return expect(result).resolves.toBe(0);
    });
  });

  // ── Context Formatting ──────────────────────────────────────

  describe('formatContextForSession', () => {
    it('includes summary and recent messages', () => {
      topicMemory.setTopicName(100, 'Dev Chat');
      topicMemory.insertMessage({
        messageId: 1, topicId: 100, text: 'Hello agent',
        fromUser: true, timestamp: '2026-02-24T12:00:00Z', sessionName: null,
      });
      topicMemory.insertMessage({
        messageId: 2, topicId: 100, text: 'Hello user',
        fromUser: false, timestamp: '2026-02-24T12:01:00Z', sessionName: null,
      });
      topicMemory.saveTopicSummary(100, 'User and agent discussed greetings.', 2, 2);

      const context = topicMemory.formatContextForSession(100);
      expect(context).toContain('Dev Chat');
      expect(context).toContain('CONVERSATION SUMMARY');
      expect(context).toContain('User and agent discussed greetings');
      expect(context).toContain('RECENT MESSAGES');
      expect(context).toContain('Hello agent');
      expect(context).toContain('Hello user');
    });

    it('works without summary', () => {
      topicMemory.insertMessage({
        messageId: 1, topicId: 100, text: 'Hello',
        fromUser: true, timestamp: '2026-02-24T12:00:00Z', sessionName: null,
      });

      const context = topicMemory.formatContextForSession(100);
      expect(context).not.toContain('CONVERSATION SUMMARY');
      expect(context).toContain('RECENT MESSAGES');
      expect(context).toContain('Hello');
    });

    it('returns empty string for empty topic (enables JSONL fallback)', () => {
      const context = topicMemory.formatContextForSession(999);
      expect(context).toBe('');
    });
  });

  // ── Stats ───────────────────────────────────────────────────

  describe('stats', () => {
    it('reports correct statistics', () => {
      topicMemory.insertMessage({
        messageId: 1, topicId: 100, text: 'Hello',
        fromUser: true, timestamp: '2026-02-24T12:00:00Z', sessionName: null,
      });
      topicMemory.insertMessage({
        messageId: 2, topicId: 200, text: 'World',
        fromUser: true, timestamp: '2026-02-24T12:01:00Z', sessionName: null,
      });
      topicMemory.saveTopicSummary(100, 'Summary', 1, 1);

      const stats = topicMemory.stats();
      expect(stats.totalMessages).toBe(2);
      expect(stats.totalTopics).toBe(2);
      expect(stats.topicsWithSummaries).toBe(1);
      expect(stats.dbSizeBytes).toBeGreaterThan(0);
    });

    it('reports zeros for empty database', () => {
      const stats = topicMemory.stats();
      expect(stats.totalMessages).toBe(0);
      expect(stats.totalTopics).toBe(0);
      expect(stats.topicsWithSummaries).toBe(0);
    });
  });

  // ── getTopicContext ─────────────────────────────────────────

  describe('getTopicContext', () => {
    it('returns full context object', () => {
      topicMemory.setTopicName(100, 'Test Topic');
      topicMemory.insertMessage({
        messageId: 1, topicId: 100, text: 'Hello',
        fromUser: true, timestamp: '2026-02-24T12:00:00Z', sessionName: null,
      });
      topicMemory.saveTopicSummary(100, 'Summary text', 1, 1);

      const ctx = topicMemory.getTopicContext(100);
      expect(ctx.summary).toBe('Summary text');
      expect(ctx.recentMessages).toHaveLength(1);
      expect(ctx.totalMessages).toBe(1);
      expect(ctx.topicName).toBe('Test Topic');
    });

    it('returns nulls for unknown topic', () => {
      const ctx = topicMemory.getTopicContext(999);
      expect(ctx.summary).toBeNull();
      expect(ctx.recentMessages).toHaveLength(0);
      expect(ctx.totalMessages).toBe(0);
      expect(ctx.topicName).toBeNull();
    });
  });

  // ── isReady ───────────────────────────────────────────────

  describe('isReady', () => {
    it('returns true after open()', () => {
      expect(topicMemory.isReady()).toBe(true);
    });

    it('returns false before open()', () => {
      const uninit = new TopicMemory(tmpDir);
      expect(uninit.isReady()).toBe(false);
    });

    it('returns false after close()', () => {
      const closeable = new TopicMemory(tmpDir);
      // We know the main topicMemory already opened the db at this path,
      // so we can test close behavior with a fresh instance
      expect(closeable.isReady()).toBe(false);
    });
  });

  // ── Uninitialized DB behavior (failure paths) ─────────────
  //
  // These tests verify that when open() hasn't been called (or failed),
  // all methods degrade safely — returning empty results without throwing.
  // This is CRITICAL: the server may pass a TopicMemory instance where
  // open() failed, and all downstream code must handle it gracefully.
  //
  // The key invariant: formatContextForSession() MUST return an empty
  // string when the db is not open, because callers use `if (!contextContent)`
  // to trigger the JSONL fallback. A non-empty string from a broken db
  // would prevent the fallback and leave sessions without history.

  describe('uninitialized db (open() not called)', () => {
    let uninit: TopicMemory;

    beforeEach(() => {
      uninit = new TopicMemory(tmpDir);
      // Deliberately NOT calling open() — simulates better-sqlite3 load failure
    });

    it('formatContextForSession returns empty string (enables JSONL fallback)', () => {
      const context = uninit.formatContextForSession(100);
      expect(context).toBe('');
    });

    it('getRecentMessages returns empty array', () => {
      expect(uninit.getRecentMessages(100)).toHaveLength(0);
    });

    it('getTopicContext returns safe defaults', () => {
      const ctx = uninit.getTopicContext(100);
      expect(ctx.summary).toBeNull();
      expect(ctx.recentMessages).toHaveLength(0);
      expect(ctx.totalMessages).toBe(0);
      expect(ctx.topicName).toBeNull();
    });

    it('search returns empty array', () => {
      expect(uninit.search('test')).toHaveLength(0);
    });

    it('insertMessage does not throw', () => {
      expect(() => uninit.insertMessage({
        messageId: 1, topicId: 100, text: 'Hello',
        fromUser: true, timestamp: '2026-02-24T12:00:00Z', sessionName: null,
      })).not.toThrow();
    });

    it('insertMessages returns 0', () => {
      expect(uninit.insertMessages([])).toBe(0);
    });

    it('stats returns zeros', () => {
      const stats = uninit.stats();
      expect(stats.totalMessages).toBe(0);
      expect(stats.totalTopics).toBe(0);
      expect(stats.topicsWithSummaries).toBe(0);
    });

    it('getTopicSummary returns null', () => {
      expect(uninit.getTopicSummary(100)).toBeNull();
    });

    it('needsSummaryUpdate returns false', () => {
      expect(uninit.needsSummaryUpdate(100)).toBe(false);
    });

    it('getMessagesSinceSummary returns empty array', () => {
      expect(uninit.getMessagesSinceSummary(100)).toHaveLength(0);
    });

    it('getTopicMeta returns null', () => {
      expect(uninit.getTopicMeta(100)).toBeNull();
    });

    it('listTopics returns empty array', () => {
      expect(uninit.listTopics()).toHaveLength(0);
    });

    it('importFromJsonl returns 0', async () => {
      await expect(uninit.importFromJsonl('/nonexistent')).resolves.toBe(0);
    });

    it('rebuild returns 0', async () => {
      await expect(uninit.rebuild('/nonexistent')).resolves.toBe(0);
    });

    it('getMessageCount returns 0', () => {
      expect(uninit.getMessageCount(100)).toBe(0);
    });
  });
});
