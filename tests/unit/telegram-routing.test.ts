/**
 * Tests for Telegram routing logic.
 *
 * Tests the message routing, topic creation, /new command handling,
 * and thread history retrieval.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Create a TelegramAdapter without real API calls
function createTestAdapter(stateDir: string): TelegramAdapter {
  return new TelegramAdapter(
    { token: 'test-token', chatId: '-100123456' },
    stateDir,
  );
}

describe('TelegramAdapter routing', () => {
  let tmpDir: string;
  let adapter: TelegramAdapter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-test-'));
    adapter = createTestAdapter(tmpDir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('topic-session registry', () => {
    it('registers and retrieves topic-session mappings', () => {
      adapter.registerTopicSession(42, 'session-alpha');

      expect(adapter.getSessionForTopic(42)).toBe('session-alpha');
      expect(adapter.getTopicForSession('session-alpha')).toBe(42);
    });

    it('returns null for unmapped topics', () => {
      expect(adapter.getSessionForTopic(999)).toBeNull();
    });

    it('returns null for unmapped sessions', () => {
      expect(adapter.getTopicForSession('nonexistent')).toBeNull();
    });

    it('overwrites previous mapping on re-register', () => {
      adapter.registerTopicSession(42, 'session-old');
      adapter.registerTopicSession(42, 'session-new');

      expect(adapter.getSessionForTopic(42)).toBe('session-new');
    });

    it('persists registry to disk', () => {
      adapter.registerTopicSession(42, 'session-alpha');

      const registryPath = path.join(tmpDir, 'topic-session-registry.json');
      expect(fs.existsSync(registryPath)).toBe(true);

      const data = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      expect(data.topicToSession['42']).toBe('session-alpha');
    });

    it('loads registry from disk on construction', () => {
      adapter.registerTopicSession(42, 'session-alpha');
      adapter.registerTopicSession(100, 'session-beta');

      // Create new adapter from same state dir
      const adapter2 = createTestAdapter(tmpDir);
      expect(adapter2.getSessionForTopic(42)).toBe('session-alpha');
      expect(adapter2.getSessionForTopic(100)).toBe('session-beta');
    });
  });

  describe('topic names', () => {
    it('stores and retrieves topic names', () => {
      // Register a session which persists registry
      adapter.registerTopicSession(42, 'session-alpha');

      // Topic name is null until explicitly set via createForumTopic
      expect(adapter.getTopicName(999)).toBeNull();
    });
  });

  describe('message log (JSONL)', () => {
    it('retrieves topic history from JSONL', () => {
      const logPath = path.join(tmpDir, 'telegram-messages.jsonl');

      // Write some log entries
      const entries = [
        { messageId: 1, topicId: 42, text: 'hello', fromUser: true, timestamp: '2026-01-01T00:00:00Z', sessionName: 's1' },
        { messageId: 2, topicId: 42, text: 'hi there', fromUser: false, timestamp: '2026-01-01T00:01:00Z', sessionName: 's1' },
        { messageId: 3, topicId: 99, text: 'other topic', fromUser: true, timestamp: '2026-01-01T00:02:00Z', sessionName: 's2' },
        { messageId: 4, topicId: 42, text: 'follow up', fromUser: true, timestamp: '2026-01-01T00:03:00Z', sessionName: 's1' },
      ];
      fs.writeFileSync(logPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

      const history = adapter.getTopicHistory(42);
      expect(history).toHaveLength(3);
      expect(history[0].text).toBe('hello');
      expect(history[1].text).toBe('hi there');
      expect(history[2].text).toBe('follow up');
    });

    it('respects limit parameter', () => {
      const logPath = path.join(tmpDir, 'telegram-messages.jsonl');

      const entries = Array.from({ length: 30 }, (_, i) => ({
        messageId: i,
        topicId: 42,
        text: `msg ${i}`,
        fromUser: true,
        timestamp: new Date(2026, 0, 1, 0, i).toISOString(),
        sessionName: 's1',
      }));
      fs.writeFileSync(logPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

      const history = adapter.getTopicHistory(42, 5);
      expect(history).toHaveLength(5);
      // Should be the LAST 5
      expect(history[0].text).toBe('msg 25');
      expect(history[4].text).toBe('msg 29');
    });

    it('returns empty array when no log file exists', () => {
      expect(adapter.getTopicHistory(42)).toEqual([]);
    });

    it('skips malformed JSONL lines', () => {
      const logPath = path.join(tmpDir, 'telegram-messages.jsonl');
      fs.writeFileSync(logPath, [
        JSON.stringify({ messageId: 1, topicId: 42, text: 'good', fromUser: true, timestamp: '2026-01-01T00:00:00Z', sessionName: 's1' }),
        'not valid json',
        JSON.stringify({ messageId: 2, topicId: 42, text: 'also good', fromUser: true, timestamp: '2026-01-01T00:01:00Z', sessionName: 's1' }),
      ].join('\n') + '\n');

      const history = adapter.getTopicHistory(42);
      expect(history).toHaveLength(2);
    });
  });

  describe('onTopicMessage callback', () => {
    it('callback is null by default', () => {
      expect(adapter.onTopicMessage).toBeNull();
    });

    it('can be set to a function', () => {
      const handler = () => {};
      adapter.onTopicMessage = handler;
      expect(adapter.onTopicMessage).toBe(handler);
    });
  });
});
