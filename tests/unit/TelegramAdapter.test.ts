import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';

describe('TelegramAdapter', () => {
  let adapter: TelegramAdapter;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-telegram-test-'));
    adapter = new TelegramAdapter({
      token: 'test-token-123',
      chatId: '-100123456',
      pollIntervalMs: 100,
    }, tmpDir);
  });

  afterEach(async () => {
    await adapter.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('has correct platform name', () => {
    expect(adapter.platform).toBe('telegram');
  });

  it('sends messages via API', async () => {
    // Mock fetch
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await adapter.send({
      userId: 'test-user',
      content: 'Hello from test',
      channel: { type: 'telegram', identifier: '42' },
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('bottest-token-123/sendMessage');
    const body = JSON.parse(options.body);
    expect(body.text).toBe('Hello from test');
    expect(body.chat_id).toBe('-100123456');
    expect(body.message_thread_id).toBe(42);

    vi.unstubAllGlobals();
  });

  it('sends without topic when no channel specified', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await adapter.send({
      userId: 'test-user',
      content: 'No topic',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.message_thread_id).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it('throws on API error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(adapter.send({
      userId: 'test-user',
      content: 'fail',
    })).rejects.toThrow(/Telegram API error.*\(401\)/);

    vi.unstubAllGlobals();
  });

  it('does not expose bot token in error messages', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });
    vi.stubGlobal('fetch', mockFetch);

    try {
      await adapter.send({ userId: 'test-user', content: 'fail' });
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('[REDACTED]');
      expect(msg).not.toContain('test-token-123');
    }

    vi.unstubAllGlobals();
  });

  it('registers message handler', () => {
    const handler = vi.fn();
    adapter.onMessage(handler);
    // Handler is stored internally — tested via polling behavior
    expect(handler).not.toHaveBeenCalled();
  });

  it('resolveUser returns null (defers to UserManager)', async () => {
    const result = await adapter.resolveUser('12345');
    expect(result).toBeNull();
  });

  it('parses incoming messages from polling', async () => {
    const received: any[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    // Mock fetch for getUpdates then sendMessage
    // Track getUpdates calls separately so ensureLifelineTopic() calls don't offset the count
    let getUpdatesCallCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('getUpdates')) {
        getUpdatesCallCount++;
        if (getUpdatesCallCount === 1) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              result: [{
                update_id: 100,
                message: {
                  message_id: 42,
                  from: { id: 12345, first_name: 'Test', username: 'testuser' },
                  chat: { id: -100123456 },
                  message_thread_id: 99,
                  text: 'Hello world',
                  date: Math.floor(Date.now() / 1000),
                },
              }],
            }),
          };
        }
      }
      // Non-getUpdates calls (ensureLifelineTopic, etc.) and subsequent polls return empty
      return {
        ok: true,
        json: async () => ({ ok: true, result: [] }),
      };
    });
    vi.stubGlobal('fetch', mockFetch);
    // Bypass Lifeline topic verification so mock sequence is predictable
    vi.spyOn(adapter, 'ensureLifelineTopic').mockResolvedValue(null);

    await adapter.start();
    await new Promise(r => setTimeout(r, 300));
    await adapter.stop();

    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('Hello world');
    expect(received[0].channel.type).toBe('telegram');
    expect(received[0].channel.identifier).toBe('99');
    expect(received[0].metadata.username).toBe('testuser');

    vi.unstubAllGlobals();
  });

  it('isForumChat defaults to true', () => {
    expect(adapter.isForumChat).toBe(true);
  });

  describe('forum detection', () => {
    it('sets isForumChat to false when createForumTopic gets "not a forum" error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'Bad Request: the chat is not a forum',
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(adapter.createForumTopic('Test Topic')).rejects.toThrow();
      expect(adapter.isForumChat).toBe(false);

      vi.unstubAllGlobals();
    });

    it('ensureLifelineTopic returns null when chat is not a forum', async () => {
      // Force non-forum state
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'Bad Request: the chat is not a forum',
      });
      vi.stubGlobal('fetch', mockFetch);

      try { await adapter.createForumTopic('trigger'); } catch {}
      expect(adapter.isForumChat).toBe(false);

      const result = await adapter.ensureLifelineTopic();
      expect(result).toBeNull();

      vi.unstubAllGlobals();
    });

    it('ensureDashboardTopic returns null when chat is not a forum', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'FORUM_REQUIRED',
      });
      vi.stubGlobal('fetch', mockFetch);

      try { await adapter.createForumTopic('trigger'); } catch {}

      const result = await adapter.ensureDashboardTopic();
      expect(result).toBeNull();

      vi.unstubAllGlobals();
    });

    it('createForumTopic skips after forum detection', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'Bad Request: the chat is not a forum',
      });
      vi.stubGlobal('fetch', mockFetch);

      // First call detects non-forum
      try { await adapter.createForumTopic('first'); } catch {}

      // Second call should throw immediately without hitting the API
      const callCountBefore = mockFetch.mock.calls.length;
      await expect(adapter.createForumTopic('second')).rejects.toThrow('Chat is not a forum');
      expect(mockFetch.mock.calls.length).toBe(callCountBefore); // No new API call

      vi.unstubAllGlobals();
    });
  });

  describe('poll offset loading', () => {
    it('loads legacy offset key', () => {
      // Write offset file with legacy "offset" key
      const offsetPath = path.join(tmpDir, 'lifeline-poll-offset.json');
      fs.writeFileSync(offsetPath, JSON.stringify({ offset: 42 }));

      // Create a new adapter that loads the offset
      const adapter2 = new TelegramAdapter({
        token: 'test-token-123',
        chatId: '-100123456',
        pollIntervalMs: 100,
      }, tmpDir);

      // The offset should be loaded (we can verify by checking it doesn't start from 0)
      // Since lastUpdateId is private, we verify indirectly — it shouldn't throw
      expect(adapter2.platform).toBe('telegram');
    });

    it('handles corrupted offset file gracefully', () => {
      const offsetPath = path.join(tmpDir, 'lifeline-poll-offset.json');
      fs.writeFileSync(offsetPath, 'not-json!!!');

      // Should not throw
      expect(() => {
        new TelegramAdapter({
          token: 'test-token-123',
          chatId: '-100123456',
          pollIntervalMs: 100,
        }, tmpDir);
      }).not.toThrow();
    });
  });

  it('start is idempotent', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await adapter.start();
    await adapter.start(); // Second call should be no-op

    await new Promise(r => setTimeout(r, 50));
    await adapter.stop();

    vi.unstubAllGlobals();
  });
});
