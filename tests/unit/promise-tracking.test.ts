import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Promise tracking tests — validates that TelegramAdapter correctly
 * detects when an agent promises to follow up, tracks those promises,
 * and alerts when promises expire without follow-through.
 *
 * We test the promise detection and follow-through methods directly
 * by importing TelegramAdapter and exercising its internals.
 */

describe('Promise Tracking', () => {
  let adapter: any;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promise-tracking-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });

    // Import TelegramAdapter
    const { TelegramAdapter } = await import('../../src/messaging/TelegramAdapter.js');
    adapter = new TelegramAdapter(
      {
        token: 'fake-token',
        chatId: '-1001234567890',
        stallTimeoutMinutes: 5,
        promiseTimeoutMinutes: 10,
      },
      tmpDir,
    );
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('isPromiseMessage', () => {
    const promiseMessages = [
      'Give me a couple minutes',
      'give me a few minutes to check',
      'Give me a moment',
      'Working on it now',
      'Looking into this',
      'Let me check on that',
      'Let me investigate further',
      'Let me dig into this',
      'Let me research this',
      'Investigating the issue...',
      'Still on it',
      'Still working on this',
      'One moment please',
      'Be right back',
      'Hang on',
      'Bear with me while I check',
      "I'll get back to you on that",
      "I'll follow up shortly",
      "I'll check and report back",
      "I'll look into it",
      'Narrowing it down now',
      'Narrowing down the issue',
      'give me some more minutes',
    ];

    const nonPromiseMessages = [
      'Here is the answer to your question',
      'I found the bug in the code',
      'The solution is to update the config',
      'Hello! How can I help you?',
      'Done! The fix is deployed.',
      'Let me know if you need anything else',
    ];

    for (const msg of promiseMessages) {
      it(`detects promise: "${msg}"`, () => {
        // Access private method via bracket notation
        expect(adapter['isPromiseMessage'](msg)).toBe(true);
      });
    }

    for (const msg of nonPromiseMessages) {
      it(`does NOT flag as promise: "${msg}"`, () => {
        expect(adapter['isPromiseMessage'](msg)).toBe(false);
      });
    }
  });

  describe('isFollowThroughMessage', () => {
    it('detects long messages as follow-through', () => {
      const longMessage = 'A'.repeat(201);
      expect(adapter['isFollowThroughMessage'](longMessage)).toBe(true);
    });

    it('does not flag short non-completion messages', () => {
      expect(adapter['isFollowThroughMessage']('still checking')).toBe(false);
    });

    const completionMessages = [
      "Here's what I found about the issue",
      'Here is the solution',
      'Here are the results',
      'I found the root cause',
      'The issue is in the config file',
      'The problem was a missing import',
      'The fix is ready for deployment',
      'The solution involves updating the schema',
      'Done with the analysis',
      'Completed the migration',
      'Finished reviewing the code',
      'Resolved the conflict',
      'Summary of findings below',
      'Overview of the changes made',
      'Analysis complete',
      'The result is positive',
      'The answer to your question',
    ];

    for (const msg of completionMessages) {
      it(`detects follow-through: "${msg}"`, () => {
        expect(adapter['isFollowThroughMessage'](msg)).toBe(true);
      });
    }
  });

  describe('promise lifecycle via sendToTopic', () => {
    // We need to mock the Telegram API call to prevent actual HTTP requests
    let apiCallMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      apiCallMock = vi.fn(async () => ({ message_id: 1 }));
      adapter['apiCall'] = apiCallMock;

      // Register a session for topic 42
      adapter.registerTopicSession(42, 'test-session');
    });

    it('tracks promise when agent sends a promise message', async () => {
      await adapter.sendToTopic(42, 'Give me a couple minutes to look into this');

      // Check that pendingPromises has an entry for topic 42
      const promises = adapter['pendingPromises'] as Map<number, any>;
      expect(promises.has(42)).toBe(true);
      const promise = promises.get(42);
      expect(promise.sessionName).toBe('test-session');
      expect(promise.promiseText).toContain('Give me a couple minutes');
      expect(promise.alerted).toBe(false);
    });

    it('clears promise when agent sends a follow-through message', async () => {
      // First: agent sends a promise
      await adapter.sendToTopic(42, 'Working on it now');
      expect(adapter['pendingPromises'].has(42)).toBe(true);

      // Then: agent sends a substantive follow-up
      await adapter.sendToTopic(42, "Here's what I found about the issue: the config was misconfigured");
      expect(adapter['pendingPromises'].has(42)).toBe(false);
    });

    it('clears promise when agent sends a long message', async () => {
      // Promise
      await adapter.sendToTopic(42, 'Let me investigate');
      expect(adapter['pendingPromises'].has(42)).toBe(true);

      // Long follow-through (>200 chars)
      await adapter.sendToTopic(42, 'A'.repeat(250));
      expect(adapter['pendingPromises'].has(42)).toBe(false);
    });

    it('does not track promise for unregistered topics', async () => {
      // Topic 999 has no session registered
      await adapter.sendToTopic(999, 'Give me a minute');
      expect(adapter['pendingPromises'].has(999)).toBe(false);
    });

    it('replaces older promise with newer one for same topic', async () => {
      await adapter.sendToTopic(42, 'Give me a moment');
      const first = adapter['pendingPromises'].get(42);
      expect(first.promiseText).toContain('Give me a moment');

      // Small delay to ensure different timestamp
      await new Promise(r => setTimeout(r, 10));

      await adapter.sendToTopic(42, 'Still working on it');
      const second = adapter['pendingPromises'].get(42);
      expect(second.promiseText).toContain('Still working on it');
      expect(second.promisedAt).toBeGreaterThanOrEqual(first.promisedAt);
    });
  });

  describe('expired promise detection in checkForStalls', () => {
    let apiCallMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      apiCallMock = vi.fn(async () => ({ message_id: 1 }));
      adapter['apiCall'] = apiCallMock;
      adapter.registerTopicSession(42, 'test-session');
    });

    it('triggers stall callback when promise expires', async () => {
      const stallDetectedMock = vi.fn(async () => ({ resolved: true }));
      adapter.onStallDetected = stallDetectedMock;
      adapter.onIsSessionAlive = () => true;

      // Set up an expired promise (11 minutes ago, threshold is 10)
      adapter['pendingPromises'].set(42, {
        topicId: 42,
        sessionName: 'test-session',
        promiseText: 'Give me a couple minutes',
        promisedAt: Date.now() - 11 * 60 * 1000,
        alerted: false,
      });

      await adapter['checkForStalls']();

      expect(stallDetectedMock).toHaveBeenCalledWith(
        42, 'test-session',
        expect.stringContaining('[promise expired]'),
        expect.any(Number),
      );

      // Promise should be cleared since triage resolved it
      expect(adapter['pendingPromises'].has(42)).toBe(false);
    });

    it('sends user alert when no triage nurse and session is alive', async () => {
      adapter.onStallDetected = null;
      adapter.onIsSessionAlive = () => true;

      adapter['pendingPromises'].set(42, {
        topicId: 42,
        sessionName: 'test-session',
        promiseText: 'Investigating...',
        promisedAt: Date.now() - 11 * 60 * 1000,
        alerted: false,
      });

      await adapter['checkForStalls']();

      // Should have sent a "checking on it" message
      const sendCalls = apiCallMock.mock.calls.filter(
        (c: any[]) => c[0] === 'sendMessage'
      );
      expect(sendCalls.length).toBeGreaterThan(0);

      // Find the call that mentions minutes
      const alertCall = sendCalls.find(
        (c: any[]) => typeof c[1]?.text === 'string' && c[1].text.includes('minutes since')
      );
      expect(alertCall).toBeDefined();
    });

    it('sends dead session alert when session is not alive', async () => {
      adapter.onStallDetected = null;
      adapter.onIsSessionAlive = () => false;

      adapter['pendingPromises'].set(42, {
        topicId: 42,
        sessionName: 'test-session',
        promiseText: 'Give me a sec',
        promisedAt: Date.now() - 11 * 60 * 1000,
        alerted: false,
      });

      await adapter['checkForStalls']();

      const sendCalls = apiCallMock.mock.calls.filter(
        (c: any[]) => c[0] === 'sendMessage'
      );
      const alertCall = sendCalls.find(
        (c: any[]) => typeof c[1]?.text === 'string' && c[1].text.includes('stopped unexpectedly')
      );
      expect(alertCall).toBeDefined();
    });

    it('does not alert for promises within timeout window', async () => {
      adapter.onStallDetected = vi.fn(async () => ({ resolved: true }));

      adapter['pendingPromises'].set(42, {
        topicId: 42,
        sessionName: 'test-session',
        promiseText: 'Looking into it',
        promisedAt: Date.now() - 5 * 60 * 1000, // Only 5 min ago, threshold is 10
        alerted: false,
      });

      await adapter['checkForStalls']();

      expect(adapter.onStallDetected).not.toHaveBeenCalled();
    });

    it('does not re-alert for already alerted promises', async () => {
      adapter.onStallDetected = vi.fn(async () => ({ resolved: false }));
      adapter.onIsSessionAlive = () => true;

      adapter['pendingPromises'].set(42, {
        topicId: 42,
        sessionName: 'test-session',
        promiseText: 'Working on it',
        promisedAt: Date.now() - 11 * 60 * 1000,
        alerted: true, // Already alerted
      });

      await adapter['checkForStalls']();

      expect(adapter.onStallDetected).not.toHaveBeenCalled();
    });

    it('cleans up old alerted promises after 1 hour', async () => {
      adapter['pendingPromises'].set(42, {
        topicId: 42,
        sessionName: 'test-session',
        promiseText: 'Old promise',
        promisedAt: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
        alerted: true,
      });

      await adapter['checkForStalls']();

      expect(adapter['pendingPromises'].has(42)).toBe(false);
    });

    it('respects promiseTimeoutMinutes=0 to disable', async () => {
      // Recreate adapter with disabled promise tracking
      const { TelegramAdapter } = await import('../../src/messaging/TelegramAdapter.js');
      const disabledAdapter = new TelegramAdapter(
        {
          token: 'fake',
          chatId: '-100',
          promiseTimeoutMinutes: 0,
        },
        tmpDir,
      );
      disabledAdapter['apiCall'] = vi.fn(async () => ({ message_id: 1 }));
      disabledAdapter.onStallDetected = vi.fn(async () => ({ resolved: true }));

      disabledAdapter['pendingPromises'].set(42, {
        topicId: 42,
        sessionName: 'test-session',
        promiseText: 'test',
        promisedAt: Date.now() - 60 * 60 * 1000,
        alerted: false,
      });

      await disabledAdapter['checkForStalls']();

      expect(disabledAdapter.onStallDetected).not.toHaveBeenCalled();
    });
  });

  describe('clearPromiseTracking', () => {
    it('removes promise for specified topic', () => {
      adapter['pendingPromises'].set(42, {
        topicId: 42,
        sessionName: 'test-session',
        promiseText: 'test',
        promisedAt: Date.now(),
        alerted: false,
      });

      adapter.clearPromiseTracking(42);
      expect(adapter['pendingPromises'].has(42)).toBe(false);
    });

    it('is safe to call for non-existent topic', () => {
      expect(() => adapter.clearPromiseTracking(999)).not.toThrow();
    });
  });

  describe('getStatus includes promise count', () => {
    it('reports pendingPromises count', () => {
      adapter['pendingPromises'].set(42, {
        topicId: 42,
        sessionName: 'test',
        promiseText: 'test',
        promisedAt: Date.now(),
        alerted: false,
      });

      const status = adapter.getStatus();
      expect(status.pendingPromises).toBe(1);
    });
  });

  describe('getActiveTopicSessions', () => {
    it('returns a copy of topic-session mappings', () => {
      adapter.registerTopicSession(42, 'session-a');
      adapter.registerTopicSession(43, 'session-b');

      const mappings = adapter.getActiveTopicSessions();
      expect(mappings.size).toBe(2);
      expect(mappings.get(42)).toBe('session-a');
      expect(mappings.get(43)).toBe('session-b');

      // Verify it's a copy (modifying it doesn't affect the adapter)
      mappings.delete(42);
      expect(adapter.getActiveTopicSessions().size).toBe(2);
    });
  });

  describe('getMessageLog', () => {
    it('returns empty array when log does not exist', () => {
      const result = adapter.getMessageLog();
      expect(result).toEqual([]);
    });

    it('parses JSONL entries correctly', () => {
      const logPath = path.join(tmpDir, 'telegram-messages.jsonl');
      const entries = [
        JSON.stringify({ topicId: 42, text: 'hello', fromUser: true, timestamp: '2026-01-01T00:00:00Z' }),
        JSON.stringify({ topicId: 42, text: 'hi', fromUser: false, timestamp: '2026-01-01T00:01:00Z' }),
      ];
      fs.writeFileSync(logPath, entries.join('\n') + '\n');

      const result = adapter.getMessageLog(10);
      expect(result).toHaveLength(2);
      expect(result[0].text).toBe('hello');
      expect(result[0].fromUser).toBe(true);
      expect(result[1].text).toBe('hi');
      expect(result[1].fromUser).toBe(false);
    });

    it('respects limit parameter', () => {
      const logPath = path.join(tmpDir, 'telegram-messages.jsonl');
      const entries = Array.from({ length: 10 }, (_, i) =>
        JSON.stringify({ topicId: 1, text: `msg${i}`, fromUser: true, timestamp: new Date().toISOString() })
      );
      fs.writeFileSync(logPath, entries.join('\n') + '\n');

      const result = adapter.getMessageLog(3);
      expect(result).toHaveLength(3);
      // Should return the LAST 3 entries
      expect(result[0].text).toBe('msg7');
      expect(result[2].text).toBe('msg9');
    });

    it('handles malformed lines gracefully', () => {
      const logPath = path.join(tmpDir, 'telegram-messages.jsonl');
      fs.writeFileSync(logPath, 'not json\n{"topicId":1,"text":"valid","fromUser":true,"timestamp":"2026-01-01T00:00:00Z"}\n');

      const result = adapter.getMessageLog();
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('valid');
    });
  });
});
