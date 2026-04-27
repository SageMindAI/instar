import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';

describe('TelegramAdapter registry and message log', () => {
  let adapter: TelegramAdapter;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tg-reg-'));
    adapter = new TelegramAdapter({
      token: 'test-token',
      chatId: '-100123',
    }, tmpDir);
  });

  afterEach(async () => {
    await adapter.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('topic-session registry', () => {
    it('registers and retrieves topic-session mappings', () => {
      adapter.registerTopicSession(42, 'my-session');
      expect(adapter.getSessionForTopic(42)).toBe('my-session');
      expect(adapter.getTopicForSession('my-session')).toBe(42);
    });

    it('returns null for unknown topic/session', () => {
      expect(adapter.getSessionForTopic(999)).toBeNull();
      expect(adapter.getTopicForSession('nonexistent')).toBeNull();
    });

    it('persists registry to disk', () => {
      adapter.registerTopicSession(42, 'persisted-session');

      const registryPath = path.join(tmpDir, 'topic-session-registry.json');
      expect(fs.existsSync(registryPath)).toBe(true);

      const data = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      expect(data.topicToSession['42']).toBe('persisted-session');
    });

    it('loads registry from disk on construction', () => {
      // Write registry file
      const registryPath = path.join(tmpDir, 'topic-session-registry.json');
      fs.writeFileSync(registryPath, JSON.stringify({
        topicToSession: { '10': 'loaded-session' },
        topicToName: { '10': 'Test Topic' },
      }));

      // Create new adapter — should load the registry
      const adapter2 = new TelegramAdapter({
        token: 'test-token',
        chatId: '-100123',
      }, tmpDir);

      expect(adapter2.getSessionForTopic(10)).toBe('loaded-session');
      expect(adapter2.getTopicForSession('loaded-session')).toBe(10);
      expect(adapter2.getTopicName(10)).toBe('Test Topic');
    });

    it('getTopicName returns null for unknown topic', () => {
      expect(adapter.getTopicName(999)).toBeNull();
    });

    it('uses atomic write (tmp + rename) for registry', () => {
      const source = fs.readFileSync(
        path.join(process.cwd(), 'src/messaging/TelegramAdapter.ts'),
        'utf-8'
      );
      // Verify saveRegistry uses atomic write pattern (unique temp filenames)
      expect(source).toContain('this.registryPath + `.${process.pid}');
      expect(source).toContain('fs.renameSync(tmpPath, this.registryPath)');
    });
  });

  describe('message log', () => {
    it('getTopicHistory returns empty for nonexistent log', () => {
      const history = adapter.getTopicHistory(42);
      expect(history).toEqual([]);
    });

    it('getTopicHistory filters by topicId', () => {
      // Write some log entries directly
      const logPath = path.join(tmpDir, 'telegram-messages.jsonl');
      const entries = [
        { messageId: 1, topicId: 42, text: 'Hello', fromUser: true, timestamp: '2026-01-01T00:00:00Z', sessionName: null },
        { messageId: 2, topicId: 99, text: 'Other topic', fromUser: true, timestamp: '2026-01-01T00:01:00Z', sessionName: null },
        { messageId: 3, topicId: 42, text: 'World', fromUser: false, timestamp: '2026-01-01T00:02:00Z', sessionName: 'sess-1' },
      ];
      fs.writeFileSync(logPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

      const history = adapter.getTopicHistory(42);
      expect(history).toHaveLength(2);
      expect(history[0].text).toBe('Hello');
      expect(history[1].text).toBe('World');
    });

    it('getTopicHistory respects limit', () => {
      const logPath = path.join(tmpDir, 'telegram-messages.jsonl');
      const entries = Array.from({ length: 10 }, (_, i) => ({
        messageId: i,
        topicId: 42,
        text: `Message ${i}`,
        fromUser: true,
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        sessionName: null,
      }));
      fs.writeFileSync(logPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

      const history = adapter.getTopicHistory(42, 3);
      expect(history).toHaveLength(3);
      // Should return the LAST 3 (most recent)
      expect(history[0].text).toBe('Message 7');
      expect(history[2].text).toBe('Message 9');
    });

    it('getTopicHistory skips malformed lines', () => {
      const logPath = path.join(tmpDir, 'telegram-messages.jsonl');
      const content = [
        JSON.stringify({ messageId: 1, topicId: 42, text: 'OK', fromUser: true, timestamp: '', sessionName: null }),
        'not valid json',
        JSON.stringify({ messageId: 2, topicId: 42, text: 'Also OK', fromUser: false, timestamp: '', sessionName: null }),
      ].join('\n') + '\n';
      fs.writeFileSync(logPath, content);

      const history = adapter.getTopicHistory(42);
      expect(history).toHaveLength(2);
    });
  });

  describe('log rotation', () => {
    it('does not rotate log when under 20MB threshold', async () => {
      const logPath = path.join(tmpDir, 'telegram-messages.jsonl');

      // Generate 10,000 lines — well under the 20MB/100k-line threshold.
      // Message history is core agent memory, so rotation limits are intentionally high.
      const lines: string[] = [];
      for (let i = 0; i < 10_000; i++) {
        lines.push(JSON.stringify({
          messageId: i,
          topicId: 42,
          text: `Test message ${i} ${'x'.repeat(80)}`,
          fromUser: true,
          timestamp: `2026-01-01T00:00:00Z`,
          sessionName: `sess-${i}`,
        }));
      }
      fs.writeFileSync(logPath, lines.join('\n') + '\n');

      const lineCountBefore = lines.length;

      // Send a message to trigger maybeRotateLog check
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 99999 } }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await adapter.sendToTopic(42, 'should not trigger rotation');

      vi.unstubAllGlobals();

      // File should still have all lines + the new outbound message
      const content = fs.readFileSync(logPath, 'utf-8');
      const remaining = content.split('\n').filter(Boolean);
      expect(remaining.length).toBe(lineCountBefore + 1);
    });

    it('does not rotate when log is under 2MB', async () => {
      const logPath = path.join(tmpDir, 'telegram-messages.jsonl');

      // Write a small number of lines (well under 2MB)
      const lines: string[] = [];
      for (let i = 0; i < 100; i++) {
        lines.push(JSON.stringify({
          messageId: i, topicId: 42, text: `Message ${i}`,
          fromUser: true, timestamp: '2026-01-01T00:00:00Z', sessionName: null,
        }));
      }
      fs.writeFileSync(logPath, lines.join('\n') + '\n');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 200 } }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await adapter.sendToTopic(42, 'no rotation needed');

      vi.unstubAllGlobals();

      // All original lines should still be present, plus the new outbound one
      const content = fs.readFileSync(logPath, 'utf-8');
      const remaining = content.split('\n').filter(Boolean);
      expect(remaining.length).toBe(101); // 100 original + 1 new
    });
  });

  describe('createForumTopic', () => {
    it('saves topic name to registry', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          result: { message_thread_id: 77, name: 'Test Topic' },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await adapter.createForumTopic('Test Topic', 9367192);
      expect(result.topicId).toBe(77);
      expect(result.name).toBe('Test Topic');
      expect(adapter.getTopicName(77)).toBe('Test Topic');

      // Verify persisted
      const registryPath = path.join(tmpDir, 'topic-session-registry.json');
      const data = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      expect(data.topicToName['77']).toBe('Test Topic');

      vi.unstubAllGlobals();
    });
  });

  describe('sendToTopic', () => {
    it('logs outbound messages', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await adapter.sendToTopic(42, 'Reply text');

      const logPath = path.join(tmpDir, 'telegram-messages.jsonl');
      expect(fs.existsSync(logPath)).toBe(true);
      const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
      const entry = JSON.parse(lines[0]);
      expect(entry.topicId).toBe(42);
      expect(entry.text).toBe('Reply text');
      expect(entry.fromUser).toBe(false);

      vi.unstubAllGlobals();
    });

    it('omits message_thread_id for General topic (1)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await adapter.sendToTopic(1, 'General message');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.message_thread_id).toBeUndefined();

      vi.unstubAllGlobals();
    });

    it('falls back to plain text on Markdown parse error', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First call (with Markdown) fails
          return { ok: false, status: 400, text: async () => 'Bad Request: can\'t parse entities' };
        }
        // Second call (plain text) succeeds
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
      });
      vi.stubGlobal('fetch', mockFetch);

      await adapter.sendToTopic(42, 'Has *bad markdown');

      // Should have been called twice — once with Markdown, once without
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(firstBody.parse_mode).toBe('Markdown');
      const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(secondBody.parse_mode).toBeUndefined();

      vi.unstubAllGlobals();
    });
  });
});
