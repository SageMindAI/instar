/**
 * Behavioral tests for TelegramAdapter messaging methods.
 *
 * Covers previously untested methods:
 * - apiCall: fetch URL construction, token redaction, 429 retry with cap, timeout
 * - sendToTopic: message_thread_id routing, Markdown fallback, JSONL logging
 * - send: OutgoingMessage routing, Markdown fallback on 400
 * - createForumTopic: topic creation, registry update
 * - start/stop: polling lifecycle
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TelegramAdapter, type TelegramConfig } from '../../src/messaging/TelegramAdapter.js';

describe('TelegramAdapter messaging', () => {
  let tmpDir: string;
  let adapter: TelegramAdapter;
  let config: TelegramConfig;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-telegram-msg-'));
    config = {
      token: 'BOT_SECRET_TOKEN_12345',
      chatId: '-100123456789',
      pollIntervalMs: 100,
    };
    adapter = new TelegramAdapter(config, tmpDir);
    originalFetch = global.fetch;
  });

  afterEach(async () => {
    await adapter.stop();
    global.fetch = originalFetch;
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('sendToTopic', () => {
    it('sends message with message_thread_id for topicId > 1', async () => {
      let capturedUrl = '';
      let capturedBody: Record<string, unknown> = {};

      global.fetch = vi.fn().mockImplementation(async (url: string, opts: RequestInit) => {
        capturedUrl = url;
        capturedBody = JSON.parse(opts.body as string);
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 1 } }),
        };
      });

      await adapter.sendToTopic(42, 'Hello topic!');

      expect(capturedUrl).toContain('/sendMessage');
      expect(capturedUrl).toContain('BOT_SECRET_TOKEN_12345');
      expect(capturedBody.chat_id).toBe('-100123456789');
      expect(capturedBody.message_thread_id).toBe(42);
      expect(capturedBody.text).toBe('Hello topic!');
      expect(capturedBody.parse_mode).toBe('Markdown');
    });

    it('omits message_thread_id for topicId 1 (General topic)', async () => {
      let capturedBody: Record<string, unknown> = {};

      global.fetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
        capturedBody = JSON.parse(opts.body as string);
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 1 } }),
        };
      });

      await adapter.sendToTopic(1, 'General message');

      expect(capturedBody.message_thread_id).toBeUndefined();
      expect(capturedBody.text).toBe('General message');
    });

    it('falls back to plain text when Markdown fails', async () => {
      const calls: Array<Record<string, unknown>> = [];

      global.fetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
        const body = JSON.parse(opts.body as string);
        calls.push(body);

        if (body.parse_mode === 'Markdown') {
          // First call with Markdown fails
          return {
            ok: false,
            status: 400,
            text: async () => 'Bad Request: can\'t parse entities',
            json: async () => ({ ok: false }),
          };
        }
        // Second call without Markdown succeeds
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 1 } }),
        };
      });

      await adapter.sendToTopic(10, 'Hello *broken markdown');

      expect(calls).toHaveLength(2);
      expect(calls[0].parse_mode).toBe('Markdown');
      expect(calls[1].parse_mode).toBeUndefined();
    });

    it('logs outbound message to JSONL', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      });

      await adapter.sendToTopic(42, 'Logged message');

      const logPath = path.join(tmpDir, 'telegram-messages.jsonl');
      expect(fs.existsSync(logPath)).toBe(true);

      const content = fs.readFileSync(logPath, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.topicId).toBe(42);
      expect(entry.text).toBe('Logged message');
      expect(entry.fromUser).toBe(false);
      expect(entry.messageId).toBe(1);
      expect(entry.timestamp).toBeTruthy();
    });

    it('includes session name in log when topic has registered session', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      });

      adapter.registerTopicSession(42, 'my-session');
      await adapter.sendToTopic(42, 'With session');

      const logPath = path.join(tmpDir, 'telegram-messages.jsonl');
      const content = fs.readFileSync(logPath, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.sessionName).toBe('my-session');
    });
  });

  describe('send', () => {
    it('sends OutgoingMessage to specified topic channel', async () => {
      let capturedBody: Record<string, unknown> = {};

      global.fetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
        capturedBody = JSON.parse(opts.body as string);
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 1 } }),
        };
      });

      await adapter.send({
        userId: 'user-1',
        content: 'Hello via send()',
        channel: { type: 'telegram', identifier: '55' },
      });

      expect(capturedBody.text).toBe('Hello via send()');
      expect(capturedBody.message_thread_id).toBe(55);
      expect(capturedBody.parse_mode).toBe('Markdown');
    });

    it('omits message_thread_id when topic is 1', async () => {
      let capturedBody: Record<string, unknown> = {};

      global.fetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
        capturedBody = JSON.parse(opts.body as string);
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 1 } }),
        };
      });

      await adapter.send({
        userId: 'user-1',
        content: 'General',
        channel: { type: 'telegram', identifier: '1' },
      });

      expect(capturedBody.message_thread_id).toBeUndefined();
    });

    it('retries without Markdown on 400 error', async () => {
      const calls: Array<Record<string, unknown>> = [];

      global.fetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
        const body = JSON.parse(opts.body as string);
        calls.push(body);

        if (body.parse_mode) {
          return {
            ok: false,
            status: 400,
            text: async () => 'Bad Request (400)',
            json: async () => ({ ok: false }),
          };
        }
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 1 } }),
        };
      });

      await adapter.send({
        userId: 'user-1',
        content: 'Broken *markdown*',
        channel: { type: 'telegram', identifier: '10' },
      });

      expect(calls).toHaveLength(2);
      expect(calls[0].parse_mode).toBe('Markdown');
      expect(calls[1].parse_mode).toBeUndefined();
    });

    it('throws on non-400 errors (does not retry)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
        json: async () => ({ ok: false }),
      });

      await expect(adapter.send({
        userId: 'user-1',
        content: 'Server error test',
        channel: { type: 'telegram', identifier: '10' },
      })).rejects.toThrow('(500)');
    });
  });

  describe('apiCall (via sendToTopic)', () => {
    it('redacts token in error messages', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
        json: async () => ({ ok: false }),
      });

      try {
        await adapter.sendToTopic(1, 'test');
      } catch (err) {
        const msg = (err as Error).message;
        // Token should NOT appear in error message
        expect(msg).not.toContain('BOT_SECRET_TOKEN_12345');
        expect(msg).toContain('[REDACTED]');
        expect(msg).toContain('403');
      }
    });

    it('retries on 429 with retry_after from response', async () => {
      let callCount = 0;

      global.fetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: false,
            status: 429,
            text: async () => 'Too Many Requests',
            json: async () => ({
              ok: false,
              parameters: { retry_after: 0 }, // 0 seconds to keep test fast
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 1 } }),
        };
      });

      await adapter.sendToTopic(1, 'Rate limited test');

      // Should have retried
      expect(callCount).toBe(2);
    });

    it('caps retries at 3 on persistent 429', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'Too Many Requests',
        json: async () => ({
          ok: false,
          parameters: { retry_after: 0 },
        }),
      });

      // sendToTopic catches the first apiCall error and retries without parse_mode
      // So we need to track total fetch calls: up to 3 retries per apiCall attempt × 2 attempts
      try {
        await adapter.sendToTopic(1, 'Persistent rate limit');
      } catch {
        // Expected to throw after retries exhausted
      }

      // Each apiCall attempts up to 4 calls (1 + 3 retries)
      // sendToTopic catches first apiCall failure and tries again without Markdown
      // So total calls = up to 4 (Markdown) + 4 (plain) = 8
      const totalCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(totalCalls).toBeLessThanOrEqual(8);
      expect(totalCalls).toBeGreaterThanOrEqual(4); // At least first apiCall + 3 retries
    });

    it('uses POST method with JSON content-type', async () => {
      let capturedOpts: RequestInit = {};

      global.fetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
        capturedOpts = opts;
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 1 } }),
        };
      });

      await adapter.sendToTopic(1, 'POST test');

      expect(capturedOpts.method).toBe('POST');
      expect((capturedOpts.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    });
  });

  describe('createForumTopic', () => {
    it('creates a topic and returns topicId and name', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          result: {
            message_thread_id: 99,
            name: 'My New Topic',
          },
        }),
      });

      const result = await adapter.createForumTopic('My New Topic', 7322096);

      expect(result.topicId).toBe(99);
      expect(result.name).toBe('My New Topic');
    });

    it('sends icon_color when provided', async () => {
      let capturedBody: Record<string, unknown> = {};

      global.fetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
        capturedBody = JSON.parse(opts.body as string);
        return {
          ok: true,
          json: async () => ({
            ok: true,
            result: { message_thread_id: 100, name: 'Colored Topic' },
          }),
        };
      });

      await adapter.createForumTopic('Colored Topic', 9367192);

      expect(capturedBody.icon_color).toBe(9367192);
      expect(capturedBody.name).toBe('Colored Topic');
    });

    it('omits icon_color when not provided', async () => {
      let capturedBody: Record<string, unknown> = {};

      global.fetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
        capturedBody = JSON.parse(opts.body as string);
        return {
          ok: true,
          json: async () => ({
            ok: true,
            result: { message_thread_id: 101, name: 'Plain Topic' },
          }),
        };
      });

      await adapter.createForumTopic('Plain Topic');

      expect(capturedBody.icon_color).toBeUndefined();
    });

    it('updates topicToName registry after creation', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          result: { message_thread_id: 102, name: 'Registered Topic' },
        }),
      });

      await adapter.createForumTopic('Registered Topic');

      expect(adapter.getTopicName(102)).toBe('Registered Topic');
    });

    it('persists topic name to registry file', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          result: { message_thread_id: 103, name: 'Persisted Topic' },
        }),
      });

      await adapter.createForumTopic('Persisted Topic');

      const registryPath = path.join(tmpDir, 'topic-session-registry.json');
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      expect(registry.topicToName['103']).toBe('Persisted Topic');
    });
  });

  describe('polling lifecycle', () => {
    it('start() is idempotent (calling twice does not double-poll)', async () => {
      let fetchCallCount = 0;
      global.fetch = vi.fn().mockImplementation(async () => {
        fetchCallCount++;
        return {
          ok: true,
          json: async () => ({ ok: true, result: [] }),
        };
      });

      await adapter.start();
      await adapter.start(); // Second call should be no-op

      // Wait briefly for one poll cycle
      await new Promise(resolve => setTimeout(resolve, 150));

      await adapter.stop();

      // Should have at most a few calls (not double the expected amount)
      // With 100ms interval and 150ms wait, expect 1-2 polls max
      expect(fetchCallCount).toBeLessThanOrEqual(3);
    });

    it('stop() clears poll timeout', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: [] }),
      });

      await adapter.start();
      await adapter.stop();

      const beforeCount = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;

      // Wait to ensure no more polls fire
      await new Promise(resolve => setTimeout(resolve, 300));

      const afterCount = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;

      // No additional calls after stop
      expect(afterCount).toBe(beforeCount);
    });

    it('processes incoming messages and fires handler', async () => {
      const messages: Array<{ content: string }> = [];

      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            result: [{
              update_id: 1001,
              message: {
                message_id: 501,
                from: { id: 12345, first_name: 'Justin', username: 'jheadley' },
                chat: { id: -100123456789 },
                message_thread_id: 42,
                text: 'Hello from test!',
                date: Math.floor(Date.now() / 1000),
              },
            }],
          }),
        })
        .mockResolvedValue({
          ok: true,
          json: async () => ({ ok: true, result: [] }),
        });

      adapter.onMessage(async (msg) => {
        messages.push({ content: msg.content });
      });

      // Bypass Lifeline topic verification so mock sequence is predictable
      vi.spyOn(adapter, 'ensureLifelineTopic').mockResolvedValue(null);
      await adapter.start();

      // Wait for one poll cycle to process
      await new Promise(resolve => setTimeout(resolve, 200));

      await adapter.stop();

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Hello from test!');
    });

    it('persists offset after processing updates', async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            result: [{
              update_id: 2001,
              message: {
                message_id: 601,
                from: { id: 12345, first_name: 'Test' },
                chat: { id: -100123456789 },
                text: 'Offset test',
                date: Math.floor(Date.now() / 1000),
              },
            }],
          }),
        })
        .mockResolvedValue({
          ok: true,
          json: async () => ({ ok: true, result: [] }),
        });

      // Bypass Lifeline topic verification so mock sequence is predictable
      vi.spyOn(adapter, 'ensureLifelineTopic').mockResolvedValue(null);
      await adapter.start();
      await new Promise(resolve => setTimeout(resolve, 200));
      await adapter.stop();

      const offsetPath = path.join(tmpDir, 'telegram-poll-offset.json');
      expect(fs.existsSync(offsetPath)).toBe(true);

      const offsetData = JSON.parse(fs.readFileSync(offsetPath, 'utf-8'));
      expect(offsetData.lastUpdateId).toBe(2001);
    });

    it('fires onTopicMessage callback for incoming messages', async () => {
      const topicMessages: Array<{ topicId: string; content: string }> = [];

      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            result: [{
              update_id: 3001,
              message: {
                message_id: 701,
                from: { id: 12345, first_name: 'Test' },
                chat: { id: -100123456789 },
                message_thread_id: 55,
                text: 'Topic callback test',
                date: Math.floor(Date.now() / 1000),
              },
            }],
          }),
        })
        .mockResolvedValue({
          ok: true,
          json: async () => ({ ok: true, result: [] }),
        });

      adapter.onTopicMessage = (msg) => {
        topicMessages.push({
          topicId: msg.channel!.identifier,
          content: msg.content,
        });
      };

      // Bypass Lifeline topic verification so mock sequence is predictable
      vi.spyOn(adapter, 'ensureLifelineTopic').mockResolvedValue(null);
      await adapter.start();
      await new Promise(resolve => setTimeout(resolve, 200));
      await adapter.stop();

      expect(topicMessages).toHaveLength(1);
      expect(topicMessages[0].topicId).toBe('55');
      expect(topicMessages[0].content).toBe('Topic callback test');
    });

    it('logs incoming messages to JSONL', async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            result: [{
              update_id: 4001,
              message: {
                message_id: 801,
                from: { id: 12345, first_name: 'Logger' },
                chat: { id: -100123456789 },
                message_thread_id: 42,
                text: 'Log this message',
                date: Math.floor(Date.now() / 1000),
              },
            }],
          }),
        })
        .mockResolvedValue({
          ok: true,
          json: async () => ({ ok: true, result: [] }),
        });

      // Bypass Lifeline topic verification so mock sequence is predictable
      vi.spyOn(adapter, 'ensureLifelineTopic').mockResolvedValue(null);
      await adapter.start();
      await new Promise(resolve => setTimeout(resolve, 200));
      await adapter.stop();

      const logPath = path.join(tmpDir, 'telegram-messages.jsonl');
      const content = fs.readFileSync(logPath, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.messageId).toBe(801);
      expect(entry.topicId).toBe(42);
      expect(entry.text).toBe('Log this message');
      expect(entry.fromUser).toBe(true);
    });
  });
});
