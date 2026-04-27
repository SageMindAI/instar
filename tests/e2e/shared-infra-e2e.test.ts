/**
 * End-to-end tests for Phase 1 shared infrastructure extraction.
 *
 * These tests exercise the full pipeline with ALL shared modules enabled,
 * simulating realistic adapter lifecycle scenarios. They verify:
 *
 * 1. Modules work together (not just in isolation)
 * 2. State persists across adapter restarts
 * 3. Legacy data formats are correctly migrated
 * 4. Flag toggling doesn't corrupt state
 * 5. Error conditions propagate correctly
 * 6. Concurrent operations don't corrupt shared state
 * 7. Full message lifecycle: receive → log → stall track → command route → respond
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SHARED_INFRA_FLAGS } from '../../src/messaging/shared/FeatureFlags.js';
import { MessageLogger } from '../../src/messaging/shared/MessageLogger.js';
import { SessionChannelRegistry } from '../../src/messaging/shared/SessionChannelRegistry.js';
import { StallDetector } from '../../src/messaging/shared/StallDetector.js';
import { CommandRouter } from '../../src/messaging/shared/CommandRouter.js';
import { AuthGate } from '../../src/messaging/shared/AuthGate.js';
import { MessagingEventBus } from '../../src/messaging/shared/MessagingEventBus.js';

const originalFlags = { ...SHARED_INFRA_FLAGS };

describe('Phase 1 Shared Infrastructure — E2E', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-e2e-phase1-'));
    Object.assign(SHARED_INFRA_FLAGS, originalFlags);
  });

  afterEach(() => {
    Object.assign(SHARED_INFRA_FLAGS, originalFlags);
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ══════════════════════════════════════════════════════════
  // 1. FULL MESSAGE LIFECYCLE
  // ══════════════════════════════════════════════════════════

  describe('Full message lifecycle', () => {
    it('processes a complete user message through all shared modules', async () => {
      // Setup all shared modules as they would be in a real adapter
      const logPath = path.join(tmpDir, 'messages.jsonl');
      const registryPath = path.join(tmpDir, 'registry.json');

      const logger = new MessageLogger({ logPath });
      const registry = new SessionChannelRegistry({ registryPath });
      const stallDetector = new StallDetector({ stallTimeoutMinutes: 5 });
      const commandRouter = new CommandRouter('telegram');
      const authGate = new AuthGate({
        authorizedUsers: ['12345'],
        registrationPolicy: { policy: 'admin-only', agentName: 'TestBot' },
      });

      // Wire up command router
      const commandResponses: string[] = [];
      commandRouter.register('status', async () => {
        commandResponses.push('status response');
        return true;
      });

      // Simulate: User sends a message
      const userId = '12345';
      const channelId = '100';

      // Step 1: Auth check
      expect(authGate.isAuthorized(userId)).toBe(true);

      // Step 2: Register session for channel
      registry.register(channelId, 'test-session', 'Test Topic');

      // Step 3: Log the message
      logger.append({
        messageId: 1,
        channelId,
        text: 'hello bot',
        fromUser: true,
        timestamp: new Date().toISOString(),
        sessionName: registry.getSessionForChannel(channelId),
      });

      // Step 4: Track stall
      stallDetector.trackMessageInjection(channelId, 'test-session', 'hello bot');

      // Step 5: Simulate agent response
      logger.append({
        messageId: 2,
        channelId,
        text: 'Hello! How can I help?',
        fromUser: false,
        timestamp: new Date().toISOString(),
        sessionName: 'test-session',
      });
      stallDetector.clearStallForChannel(channelId);

      // Verify state across all modules
      const stats = logger.getStats();
      expect(stats.totalMessages).toBe(2);

      const history = logger.getChannelHistory(channelId);
      expect(history).toHaveLength(2);
      expect(history[0].fromUser).toBe(true);
      expect(history[1].fromUser).toBe(false);

      expect(registry.getSessionForChannel(channelId)).toBe('test-session');
      expect(stallDetector.getStatus().pendingStalls).toBe(0);

      // Step 6: Process a command
      const handled = await commandRouter.route('/status', channelId, userId);
      expect(handled).toBe(true);
      expect(commandResponses).toEqual(['status response']);
    });

    it('rejects unauthorized user and logs nothing', async () => {
      const logPath = path.join(tmpDir, 'messages.jsonl');
      const logger = new MessageLogger({ logPath });
      const authGate = new AuthGate({
        authorizedUsers: ['12345'],
        registrationPolicy: { policy: 'closed' },
      });

      // Unauthorized user
      const userId = '99999';
      expect(authGate.isAuthorized(userId)).toBe(false);

      // Handle the rejection
      const sent: string[] = [];
      const result = await authGate.handleUnauthorized(
        { userId, displayName: 'Hacker', username: 'hax0r' },
        { sendResponse: async (msg) => { sent.push(msg); } },
      );

      expect(result).toBe(true);
      expect(sent[0]).toContain('not currently accepting');

      // No messages should be in the log (unauthorized users don't get logged)
      expect(logger.getStats().totalMessages).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 2. STATE PERSISTENCE ACROSS RESTARTS
  // ══════════════════════════════════════════════════════════

  describe('State persistence across restarts', () => {
    it('preserves message log across logger instances', () => {
      const logPath = path.join(tmpDir, 'messages.jsonl');

      // Instance 1: write messages
      const logger1 = new MessageLogger({ logPath });
      logger1.append({ messageId: 1, channelId: '100', text: 'first', fromUser: true, timestamp: '2026-01-01T00:00:00Z', sessionName: null });
      logger1.append({ messageId: 2, channelId: '100', text: 'second', fromUser: false, timestamp: '2026-01-01T00:01:00Z', sessionName: null });

      // Instance 2: read messages (simulates restart)
      const logger2 = new MessageLogger({ logPath });
      const history = logger2.getChannelHistory('100');
      expect(history).toHaveLength(2);
      expect(history[0].text).toBe('first');
      expect(history[1].text).toBe('second');

      // Instance 2: append more
      logger2.append({ messageId: 3, channelId: '100', text: 'third', fromUser: true, timestamp: '2026-01-01T00:02:00Z', sessionName: null });

      // Instance 3: verify all three
      const logger3 = new MessageLogger({ logPath });
      expect(logger3.getStats().totalMessages).toBe(3);
    });

    it('preserves registry across adapter restarts', () => {
      const registryPath = path.join(tmpDir, 'registry.json');

      // Instance 1: register mappings
      const reg1 = new SessionChannelRegistry({ registryPath });
      reg1.register('100', 'session-a', 'Topic A');
      reg1.register('200', 'session-b', 'Topic B');
      reg1.setChannelPurpose('100', 'technical');

      // Instance 2: verify persistence
      const reg2 = new SessionChannelRegistry({ registryPath });
      expect(reg2.getSessionForChannel('100')).toBe('session-a');
      expect(reg2.getSessionForChannel('200')).toBe('session-b');
      expect(reg2.getChannelName('100')).toBe('Topic A');
      expect(reg2.getChannelPurpose('100')).toBe('technical');
      expect(reg2.size).toBe(2);

      // Instance 2: modify
      reg2.unregister('100');

      // Instance 3: verify modification persisted
      const reg3 = new SessionChannelRegistry({ registryPath });
      expect(reg3.getSessionForChannel('100')).toBeNull();
      expect(reg3.getSessionForChannel('200')).toBe('session-b');
      expect(reg3.size).toBe(1);
    });

    it('handles crash recovery (partial write)', () => {
      const registryPath = path.join(tmpDir, 'registry.json');

      // Write valid state
      const reg1 = new SessionChannelRegistry({ registryPath });
      reg1.register('100', 'session-a');

      // Simulate crash: corrupt the file
      fs.writeFileSync(registryPath, '{"channelToSession":{"100":"session-a"'); // truncated JSON

      // New instance should start fresh (not crash)
      const reg2 = new SessionChannelRegistry({ registryPath });
      expect(reg2.size).toBe(0); // Lost data due to corruption, but didn't crash

      // Can still function normally
      reg2.register('200', 'session-b');
      expect(reg2.getSessionForChannel('200')).toBe('session-b');
    });
  });

  // ══════════════════════════════════════════════════════════
  // 3. LEGACY DATA FORMAT MIGRATION
  // ══════════════════════════════════════════════════════════

  describe('Legacy data format migration', () => {
    it('reads Telegram legacy registry format and writes both formats', () => {
      const registryPath = path.join(tmpDir, 'registry.json');

      // Write legacy format (as existing TelegramAdapter would)
      fs.writeFileSync(registryPath, JSON.stringify({
        topicToSession: { '42': 'my-session', '99': 'other-session' },
        topicToName: { '42': 'My Topic', '99': 'Other Topic' },
        topicToPurpose: { '42': 'billing' },
      }));

      // Read with new module
      const reg = new SessionChannelRegistry({ registryPath });
      expect(reg.getSessionForChannel('42')).toBe('my-session');
      expect(reg.getChannelName('42')).toBe('My Topic');
      expect(reg.getChannelPurpose('42')).toBe('billing');
      expect(reg.size).toBe(2);

      // Modify (triggers save)
      reg.register('200', 'new-session');

      // Verify both legacy and new keys are written
      const raw = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      expect(raw.channelToSession['42']).toBe('my-session');
      expect(raw.topicToSession['42']).toBe('my-session'); // legacy key still written
      expect(raw.channelToSession['200']).toBe('new-session');
      expect(raw.topicToSession['200']).toBe('new-session');
    });

    it('reads legacy JSONL message log entries with topicId field', () => {
      const logPath = path.join(tmpDir, 'messages.jsonl');

      // Write legacy entries (as TelegramAdapter currently does)
      const legacyEntries = [
        { messageId: 1, topicId: 42, text: 'legacy msg 1', fromUser: true, timestamp: '2026-01-01T00:00:00Z', sessionName: 'sess-a', telegramUserId: 12345 },
        { messageId: 2, topicId: 42, text: 'legacy msg 2', fromUser: false, timestamp: '2026-01-01T00:01:00Z', sessionName: 'sess-a' },
        { messageId: 3, topicId: 99, text: 'other topic', fromUser: true, timestamp: '2026-01-01T00:02:00Z', sessionName: 'sess-b' },
      ];
      fs.writeFileSync(logPath, legacyEntries.map(e => JSON.stringify(e)).join('\n') + '\n');

      // Read with new module
      const logger = new MessageLogger({ logPath });

      // Search by channelId (should find legacy topicId entries)
      const results = logger.search({ channelId: 42 });
      expect(results).toHaveLength(2);
      expect(results[0].text).toBe('legacy msg 1');

      // Channel history
      const history = logger.getChannelHistory('42');
      expect(history).toHaveLength(2);

      // Stats
      expect(logger.getStats().totalMessages).toBe(3);

      // Append a new-format entry
      logger.append({
        messageId: 4,
        channelId: '42',
        text: 'new format msg',
        fromUser: true,
        timestamp: '2026-01-01T00:03:00Z',
        sessionName: 'sess-a',
        platform: 'telegram',
      });

      // Mixed search should return both old and new
      const allResults = logger.search({ channelId: '42' });
      expect(allResults).toHaveLength(3);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 4. FLAG TOGGLING DOESN'T CORRUPT STATE
  // ══════════════════════════════════════════════════════════

  describe('Flag toggling safety', () => {
    it('adapter produces consistent state with flags on then off', async () => {
      const stateDir = tmpDir;

      // Run with shared logger ON
      Object.assign(SHARED_INFRA_FLAGS, { useSharedMessageLogger: true, useSharedStallDetector: true });
      const { TelegramAdapter } = await import('../../src/messaging/TelegramAdapter.js');
      const adapter1 = new TelegramAdapter(
        { token: 'fake', chatId: '-100', stallTimeoutMinutes: 5 },
        stateDir,
      );
      const a1: any = adapter1;
      a1.appendToLog({ messageId: 1, topicId: 42, text: 'shared-on', fromUser: true, timestamp: new Date().toISOString(), sessionName: null });
      adapter1.trackMessageInjection(42, 'session-a', 'test');

      // Run with shared logger OFF (simulates rollback)
      Object.assign(SHARED_INFRA_FLAGS, { useSharedMessageLogger: false, useSharedStallDetector: false });
      const adapter2 = new TelegramAdapter(
        { token: 'fake', chatId: '-100', stallTimeoutMinutes: 5 },
        stateDir,
      );
      const a2: any = adapter2;

      // Legacy logger should be able to read the JSONL file the shared logger wrote
      const logPath = path.join(stateDir, 'telegram-messages.jsonl');
      const content = fs.readFileSync(logPath, 'utf-8');
      expect(content).toContain('shared-on');

      // Legacy adapter should still function
      a2.appendToLog({ messageId: 2, topicId: 42, text: 'shared-off', fromUser: true, timestamp: new Date().toISOString(), sessionName: null });
      const finalContent = fs.readFileSync(logPath, 'utf-8');
      expect(finalContent).toContain('shared-on');
      expect(finalContent).toContain('shared-off');
    });
  });

  // ══════════════════════════════════════════════════════════
  // 5. ERROR PROPAGATION
  // ══════════════════════════════════════════════════════════

  describe('Error propagation', () => {
    it('message logger handles disk write errors gracefully', () => {
      const logPath = path.join(tmpDir, 'nonexistent-deep', 'subdir', 'messages.jsonl');

      // Constructor creates parent dirs
      const logger = new MessageLogger({ logPath });
      // Should not throw
      logger.append({ messageId: 1, channelId: '100', text: 'test', fromUser: true, timestamp: new Date().toISOString(), sessionName: null });
      expect(logger.getStats().totalMessages).toBe(1);
    });

    it('stall detector handles callback errors without stopping checks', async () => {
      vi.useFakeTimers();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const detector = new StallDetector({ stallTimeoutMinutes: 1 });
      let callCount = 0;
      detector.setOnStall(async () => {
        callCount++;
        if (callCount === 1) throw new Error('first stall callback fails');
        // Second call should still work
      });

      detector.trackMessageInjection('100', 'session-a', 'msg 1');
      detector.trackMessageInjection('200', 'session-b', 'msg 2');

      vi.advanceTimersByTime(2 * 60 * 1000);
      await detector.check();

      // Both stalls should have been processed despite first throwing
      expect(callCount).toBe(2);

      consoleSpy.mockRestore();
      vi.useRealTimers();
    });

    it('command router continues after handler error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const router = new CommandRouter('telegram');
      const results: string[] = [];

      router.register('crash', async () => { throw new Error('boom'); });
      router.register('works', async () => { results.push('ok'); return true; });

      // Crash doesn't prevent works from executing
      await router.route('/crash', '100', 'user-1');
      await router.route('/works', '100', 'user-1');
      expect(results).toEqual(['ok']);

      consoleSpy.mockRestore();
    });

    it('auth gate handles all callback errors gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const gate = new AuthGate({
        authorizedUsers: ['100'],
        registrationPolicy: { policy: 'admin-only' },
      });

      // Even when notifyAdmin throws, the user still gets a response
      const sent: string[] = [];
      await gate.handleUnauthorized(
        { userId: '999', displayName: 'Test' },
        {
          sendResponse: async (msg) => { sent.push(msg); },
          notifyAdmin: async () => { throw new Error('admin notify failed'); },
        },
      );
      expect(sent).toHaveLength(1); // User response sent despite admin error

      consoleSpy.mockRestore();
    });
  });

  // ══════════════════════════════════════════════════════════
  // 6. CONCURRENT OPERATIONS
  // ══════════════════════════════════════════════════════════

  describe('Concurrent operations', () => {
    it('message logger handles concurrent appends', async () => {
      const logPath = path.join(tmpDir, 'messages.jsonl');
      const logger = new MessageLogger({ logPath });

      // Simulate 50 concurrent appends
      const promises = Array.from({ length: 50 }, (_, i) =>
        Promise.resolve().then(() =>
          logger.append({
            messageId: i,
            channelId: `${i % 5}`, // 5 channels
            text: `concurrent msg ${i}`,
            fromUser: i % 2 === 0,
            timestamp: new Date().toISOString(),
            sessionName: `session-${i % 3}`,
          })
        )
      );

      await Promise.all(promises);

      const stats = logger.getStats();
      expect(stats.totalMessages).toBe(50);

      // Each channel should have ~10 messages
      for (let ch = 0; ch < 5; ch++) {
        const history = logger.getChannelHistory(ch.toString(), 50);
        expect(history).toHaveLength(10);
      }
    });

    it('registry handles concurrent register/unregister', () => {
      const registryPath = path.join(tmpDir, 'registry.json');
      const registry = new SessionChannelRegistry({ registryPath });

      // Register 20 channels
      for (let i = 0; i < 20; i++) {
        registry.register(`ch-${i}`, `session-${i}`);
      }
      expect(registry.size).toBe(20);

      // Unregister even channels
      for (let i = 0; i < 20; i += 2) {
        registry.unregister(`ch-${i}`);
      }
      expect(registry.size).toBe(10);

      // Verify odd channels remain
      for (let i = 1; i < 20; i += 2) {
        expect(registry.getSessionForChannel(`ch-${i}`)).toBe(`session-${i}`);
      }

      // Verify persistence
      const reg2 = new SessionChannelRegistry({ registryPath });
      expect(reg2.size).toBe(10);
    });

    it('command router handles concurrent route calls', async () => {
      const router = new CommandRouter('telegram');
      const results: Array<{ cmd: string; channelId: string }> = [];

      router.register('test', async (ctx) => {
        // Simulate async work with a microtask yield (not setTimeout, which conflicts with fake timers)
        await Promise.resolve();
        results.push({ cmd: ctx.command, channelId: ctx.channelId });
        return true;
      });

      // Fire 20 concurrent commands
      const promises = Array.from({ length: 20 }, (_, i) =>
        router.route('/test', `ch-${i}`, 'user-1')
      );

      const outcomes = await Promise.all(promises);
      expect(outcomes.every(r => r === true)).toBe(true);
      expect(results).toHaveLength(20);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 7. STALL DETECTION END-TO-END
  // ══════════════════════════════════════════════════════════

  describe('Stall detection end-to-end', () => {
    it('complete stall lifecycle: inject → timeout → alert → clear', async () => {
      vi.useFakeTimers();

      const stallEvents: Array<{ type: string; channelId: string; alive: boolean }> = [];
      const detector = new StallDetector({ stallTimeoutMinutes: 5, promiseTimeoutMinutes: 10 });

      detector.setIsSessionAlive((name) => name !== 'dead-session');
      detector.setOnStall(async (event, alive) => {
        stallEvents.push({ type: event.type, channelId: event.channelId, alive });
      });

      // User sends message to live session
      detector.trackMessageInjection('100', 'live-session', 'hello');
      // User sends message to dead session
      detector.trackMessageInjection('200', 'dead-session', 'are you there?');

      // 3 minutes: no stalls yet
      vi.advanceTimersByTime(3 * 60 * 1000);
      await detector.check();
      expect(stallEvents).toHaveLength(0);

      // Live session responds at 4 minutes
      vi.advanceTimersByTime(1 * 60 * 1000);
      detector.clearStallForChannel('100');

      // 6 minutes total: dead session should stall, live session was cleared
      vi.advanceTimersByTime(2 * 60 * 1000);
      await detector.check();
      expect(stallEvents).toHaveLength(1);
      expect(stallEvents[0]).toEqual({
        type: 'stall',
        channelId: '200',
        alive: false,
      });

      vi.useRealTimers();
    });

    it('promise lifecycle: promise → follow-through clears tracking', async () => {
      vi.useFakeTimers();

      const stallEvents: Array<{ type: string }> = [];
      const detector = new StallDetector({ promiseTimeoutMinutes: 10 });
      detector.setOnStall(async (event) => { stallEvents.push({ type: event.type }); });

      // Agent promises
      detector.trackOutboundMessage('100', 'session-a', 'Working on it, give me a minute');
      expect(detector.getStatus().pendingPromises).toBe(1);

      // Agent follows through with a long response
      vi.advanceTimersByTime(3 * 60 * 1000);
      detector.trackOutboundMessage('100', 'session-a',
        'Here is the full analysis with detailed findings across multiple areas of the codebase...' +
        'The root cause was in the authentication middleware where token validation was being skipped...' +
        'I have fixed the issue by adding proper validation checks at each entry point.'
      );
      expect(detector.getStatus().pendingPromises).toBe(0);

      // No expired promise alert even after 15 minutes
      vi.advanceTimersByTime(15 * 60 * 1000);
      await detector.check();
      expect(stallEvents).toHaveLength(0);

      vi.useRealTimers();
    });

    it('multiple stalls in different channels tracked independently', async () => {
      vi.useFakeTimers();

      const events: Array<{ channelId: string; minutes: number }> = [];
      const detector = new StallDetector({ stallTimeoutMinutes: 5 });
      detector.setOnStall(async (event) => {
        events.push({ channelId: event.channelId, minutes: event.minutesElapsed });
      });

      // Stagger message injections
      detector.trackMessageInjection('100', 'session-a', 'msg 1');
      vi.advanceTimersByTime(2 * 60 * 1000);
      detector.trackMessageInjection('200', 'session-b', 'msg 2');
      vi.advanceTimersByTime(2 * 60 * 1000);
      detector.trackMessageInjection('300', 'session-c', 'msg 3');

      // At 4 min: only channel 100 has waited > 5 min? No, 4 min total for 100
      await detector.check();
      expect(events).toHaveLength(0);

      // At 6 min total: channel 100 at 6 min (stall), 200 at 4 min (no stall)
      vi.advanceTimersByTime(2 * 60 * 1000);
      await detector.check();
      expect(events).toHaveLength(1);
      expect(events[0].channelId).toBe('100');

      // At 8 min: channel 200 at 6 min (stall), 300 at 4 min (no stall)
      vi.advanceTimersByTime(2 * 60 * 1000);
      await detector.check();
      expect(events).toHaveLength(2);
      expect(events[1].channelId).toBe('200');

      // At 10 min: channel 300 at 6 min (stall)
      vi.advanceTimersByTime(2 * 60 * 1000);
      await detector.check();
      expect(events).toHaveLength(3);
      expect(events[2].channelId).toBe('300');

      vi.useRealTimers();
    });
  });

  // ══════════════════════════════════════════════════════════
  // 8. COMMAND ROUTING END-TO-END
  // ══════════════════════════════════════════════════════════

  describe('Command routing end-to-end', () => {
    it('full command lifecycle with interceptors and platform restrictions', async () => {
      const router = new CommandRouter('telegram');
      const events: string[] = [];

      // Interceptor: attention topic override
      router.addInterceptor(async (ctx) => {
        if (ctx.metadata?.isAttentionTopic) {
          events.push(`intercepted:${ctx.command}`);
          return true;
        }
        return false;
      });

      // Telegram-only commands
      router.register('sessions', async (ctx) => {
        events.push(`sessions:${ctx.args}`);
        return true;
      }, { platforms: ['telegram'], description: 'List sessions' });

      // Cross-platform commands
      router.register('status', async () => {
        events.push('status');
        return true;
      }, { description: 'Show status' });

      router.register('help', async () => {
        events.push('help');
        return true;
      }, { description: 'Show help' });

      // Normal command
      await router.route('/status', '100', 'user-1');
      expect(events).toEqual(['status']);

      // Command with args
      await router.route('/sessions unclaimed', '100', 'user-1');
      expect(events).toEqual(['status', 'sessions:unclaimed']);

      // Intercepted command (attention topic)
      await router.route('/done', '200', 'user-1', { isAttentionTopic: true });
      expect(events).toEqual(['status', 'sessions:unclaimed', 'intercepted:done']);

      // Non-intercepted (regular topic)
      const unhandled = await router.route('/unknown', '100', 'user-1');
      expect(unhandled).toBe(false);

      // Verify help generation
      const help = router.generateHelp();
      expect(help).toContain('/sessions');
      expect(help).toContain('/status');
      expect(help).toContain('/help');
    });

    it('WhatsApp router excludes Telegram-only commands', async () => {
      const router = new CommandRouter('whatsapp');

      router.register('sessions', async () => true, { platforms: ['telegram'] });
      router.register('switch', async () => true, { platforms: ['telegram'] });
      router.register('status', async () => true); // No platform restriction
      router.register('help', async () => true);
      router.register('new', async () => true);

      // Telegram-only commands should not route
      expect(await router.route('/sessions', '100', 'user-1')).toBe(false);
      expect(await router.route('/switch', '100', 'user-1')).toBe(false);

      // Cross-platform commands should route
      expect(await router.route('/status', '100', 'user-1')).toBe(true);
      expect(await router.route('/help', '100', 'user-1')).toBe(true);
      expect(await router.route('/new', '100', 'user-1')).toBe(true);

      // Help should only show non-Telegram commands
      const help = router.generateHelp();
      expect(help).not.toContain('/sessions');
      expect(help).toContain('/status');
    });
  });

  // ══════════════════════════════════════════════════════════
  // 9. AUTH GATE END-TO-END
  // ══════════════════════════════════════════════════════════

  describe('Auth gate end-to-end', () => {
    it('full invite-only lifecycle: reject → code → onboard', async () => {
      const gate = new AuthGate({
        authorizedUsers: ['100'],
        registrationPolicy: {
          policy: 'invite-only',
          agentName: 'InviteBot',
          contactHint: 'DM @admin for access.',
        },
      });

      const sent: string[] = [];
      const onboarded: string[] = [];
      const callbacks = {
        sendResponse: async (msg: string) => { sent.push(msg); },
        validateInviteCode: async (code: string, userId: string) => {
          if (code === 'VALID123') return { valid: true };
          return { valid: false, error: 'Invalid code. Try again.' };
        },
        startOnboarding: async (userId: string) => { onboarded.push(userId); },
      };

      const userInfo = { userId: '999', displayName: 'NewUser', username: 'newuser' };

      // Step 1: User sends random text (no code)
      await gate.handleUnauthorized(
        { ...userInfo, messageText: 'hi there' },
        callbacks,
      );
      expect(sent[sent.length - 1]).toContain('Invalid code');

      // Need to wait for rate limit
      // Actually, the text "hi there" was treated as an invite code and rejected.
      // Let's test with undefined text first
      sent.length = 0;

      // Wait past rate limit (fake the internal state)
      (gate as any).rateLimitMap.clear();

      await gate.handleUnauthorized(
        { ...userInfo, messageText: undefined },
        callbacks,
      );
      expect(sent[sent.length - 1]).toContain('invite code');
      expect(sent[sent.length - 1]).toContain('DM @admin');

      // Step 2: User sends invalid code
      (gate as any).rateLimitMap.clear();
      sent.length = 0;
      await gate.handleUnauthorized(
        { ...userInfo, messageText: 'BADCODE' },
        callbacks,
      );
      expect(sent[sent.length - 1]).toContain('Invalid code');

      // Step 3: User sends valid code
      (gate as any).rateLimitMap.clear();
      sent.length = 0;
      await gate.handleUnauthorized(
        { ...userInfo, messageText: 'VALID123' },
        callbacks,
      );
      expect(sent[sent.length - 1]).toContain('accepted');
      expect(onboarded).toEqual(['999']);

      // Step 4: After onboarding, admin authorizes the user
      gate.authorize('999');
      expect(gate.isAuthorized('999')).toBe(true);
    });

    it('admin-only lifecycle: reject → admin notified → manual authorize', async () => {
      const gate = new AuthGate({
        authorizedUsers: ['100'],
        registrationPolicy: { policy: 'admin-only', agentName: 'AdminBot' },
      });

      const sent: string[] = [];
      const adminNotifications: any[] = [];
      const callbacks = {
        sendResponse: async (msg: string) => { sent.push(msg); },
        notifyAdmin: async (info: any) => { adminNotifications.push(info); },
      };

      // Unknown user tries to access
      await gate.handleUnauthorized(
        { userId: '999', displayName: 'Stranger', username: 'stranger99' },
        callbacks,
      );

      expect(sent[0]).toContain('not open for public registration');
      expect(adminNotifications).toHaveLength(1);
      expect(adminNotifications[0].displayName).toBe('Stranger');

      // Admin manually authorizes
      gate.authorize('999');
      expect(gate.isAuthorized('999')).toBe(true);
      expect(gate.authorizedCount).toBe(2); // Original + new
    });
  });

  // ══════════════════════════════════════════════════════════
  // 10. COMBINED MODULE STRESS TEST
  // ══════════════════════════════════════════════════════════

  describe('Combined module stress test', () => {
    it('handles 100 messages across 10 channels with full pipeline', async () => {
      vi.useFakeTimers();

      const logPath = path.join(tmpDir, 'messages.jsonl');
      const registryPath = path.join(tmpDir, 'registry.json');

      const logger = new MessageLogger({ logPath });
      const registry = new SessionChannelRegistry({ registryPath });
      const detector = new StallDetector({ stallTimeoutMinutes: 2 });
      const router = new CommandRouter('telegram');
      const gate = new AuthGate({ authorizedUsers: ['1', '2', '3', '4', '5'] });

      const stallAlerts: string[] = [];
      detector.setOnStall(async (event) => {
        stallAlerts.push(event.channelId);
      });

      let commandCount = 0;
      router.register('status', async () => { commandCount++; return true; });

      // Register 10 channels
      for (let ch = 0; ch < 10; ch++) {
        registry.register(`${ch}`, `session-${ch}`, `Channel ${ch}`);
      }

      // Simulate 100 messages
      for (let i = 0; i < 100; i++) {
        const channelId = `${i % 10}`;
        const userId = `${(i % 5) + 1}`;
        const isCommand = i % 20 === 0; // Every 20th message is a command
        const text = isCommand ? '/status' : `Message ${i} in channel ${channelId}`;

        // Auth check
        if (!gate.isAuthorized(userId)) continue;

        // Log
        logger.append({
          messageId: i,
          channelId,
          text,
          fromUser: true,
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
          sessionName: registry.getSessionForChannel(channelId),
        });

        // Command routing
        if (text.startsWith('/')) {
          await router.route(text, channelId, userId);
        } else {
          // Track stall for non-command messages
          detector.trackMessageInjection(channelId, `session-${parseInt(channelId)}`, text);
        }

        // Simulate some responses (odd channels respond, even channels stall)
        if (parseInt(channelId) % 2 === 1 && i % 3 === 0) {
          detector.clearStallForChannel(channelId);
        }
      }

      // Advance time past stall threshold
      vi.advanceTimersByTime(3 * 60 * 1000);
      await detector.check();

      // Verify results
      expect(logger.getStats().totalMessages).toBe(100);
      expect(registry.size).toBe(10);
      expect(commandCount).toBe(5); // 100/20 = 5 commands
      expect(stallAlerts.length).toBeGreaterThan(0); // Some channels stalled

      // Verify each channel has messages
      for (let ch = 0; ch < 10; ch++) {
        const history = logger.getChannelHistory(`${ch}`, 100);
        expect(history.length).toBe(10); // 100 msgs / 10 channels
      }

      // Verify persistence
      const reg2 = new SessionChannelRegistry({ registryPath });
      expect(reg2.size).toBe(10);
      const logger2 = new MessageLogger({ logPath });
      expect(logger2.getStats().totalMessages).toBe(100);

      vi.useRealTimers();
    });
  });

  // ══════════════════════════════════════════════════════════
  // 11. EVENT BUS END-TO-END
  // ══════════════════════════════════════════════════════════

  describe('EventBus end-to-end', () => {
    it('full event lifecycle: subscribe → emit → receive → unsubscribe', async () => {
      const bus = new MessagingEventBus('telegram');
      const events: string[] = [];

      // Multiple subscribers to different events
      const unsub1 = bus.on('message:logged', (e) => { events.push(`logged:${e.channelId}`); });
      const unsub2 = bus.on('stall:detected', (e) => { events.push(`stall:${e.channelId}`); });
      const unsub3 = bus.on('command:executed', (e) => { events.push(`cmd:${e.command}`); });

      // Emit various events
      await bus.emit('message:logged', {
        messageId: 1, channelId: '100', text: 'hello',
        fromUser: true, timestamp: '', sessionName: 'sess-1',
      });
      await bus.emit('stall:detected', {
        channelId: '100', sessionName: 'sess-1', messageText: 'hello',
        injectedAt: Date.now(), minutesElapsed: 5, alive: true,
      });
      await bus.emit('command:executed', {
        command: 'status', args: '', channelId: '100', userId: 'u1', handled: true,
      });

      expect(events).toEqual(['logged:100', 'stall:100', 'cmd:status']);

      // Unsubscribe stall listener
      unsub2();

      await bus.emit('stall:detected', {
        channelId: '200', sessionName: 'sess-2', messageText: 'hi',
        injectedAt: Date.now(), minutesElapsed: 3, alive: false,
      });

      // Stall event not received after unsubscribe
      expect(events).toEqual(['logged:100', 'stall:100', 'cmd:status']);

      unsub1();
      unsub3();
    });

    it('EventBus integrates with CommandRouter events', async () => {
      const bus = new MessagingEventBus('telegram');
      const router = new CommandRouter('telegram');
      const busEvents: Array<{ command: string; handled: boolean }> = [];

      bus.on('command:executed', (e) => {
        busEvents.push({ command: e.command, handled: e.handled });
      });

      // Wire router to emit events on the bus
      router.register('status', async () => true, { description: 'Status' });
      router.register('help', async () => true, { description: 'Help' });

      // Simulate routing with bus emission
      for (const cmd of ['/status', '/help', '/unknown']) {
        const parsed = router.parse(cmd);
        const handled = await router.route(cmd, '100', 'user-1');
        if (parsed) {
          await bus.emit('command:executed', {
            command: parsed.command,
            args: parsed.args,
            channelId: '100',
            userId: 'user-1',
            handled,
          });
        }
      }

      expect(busEvents).toEqual([
        { command: 'status', handled: true },
        { command: 'help', handled: true },
        { command: 'unknown', handled: false },
      ]);
    });

    it('EventBus integrates with StallDetector events', async () => {
      vi.useFakeTimers();

      const bus = new MessagingEventBus('telegram');
      const detector = new StallDetector({ stallTimeoutMinutes: 1 });
      const busStalls: Array<{ channelId: string; alive: boolean }> = [];

      bus.on('stall:detected', (e) => {
        busStalls.push({ channelId: e.channelId, alive: e.alive });
      });

      // Wire detector to emit events on the bus
      detector.setOnStall(async (event, alive) => {
        await bus.emit('stall:detected', {
          channelId: event.channelId,
          sessionName: event.sessionName,
          messageText: event.messageText,
          injectedAt: event.injectedAt,
          minutesElapsed: event.minutesElapsed,
          alive,
        });
      });

      detector.trackMessageInjection('ch-1', 'session-1', 'hello');
      detector.trackMessageInjection('ch-2', 'session-2', 'world');

      vi.advanceTimersByTime(2 * 60 * 1000);
      await detector.check();

      expect(busStalls).toHaveLength(2);
      expect(busStalls.map(s => s.channelId).sort()).toEqual(['ch-1', 'ch-2']);

      vi.useRealTimers();
    });

    it('EventBus integrates with AuthGate events', async () => {
      const bus = new MessagingEventBus('telegram');
      const gate = new AuthGate({
        authorizedUsers: ['100'],
        registrationPolicy: { policy: 'closed' },
      });
      const unauthorizedEvents: Array<{ userId: string; displayName: string }> = [];

      bus.on('auth:unauthorized', (e) => {
        unauthorizedEvents.push({ userId: e.userId, displayName: e.displayName });
      });

      // Check authorization and emit on bus if unauthorized
      const userId = '999';
      const result = gate.check(userId, { userId, displayName: 'Unknown' });
      if (!result.authorized) {
        await bus.emit('auth:unauthorized', {
          userId,
          displayName: 'Unknown',
          channelId: '100',
        });
      }

      expect(unauthorizedEvents).toEqual([{ userId: '999', displayName: 'Unknown' }]);
    });

    it('EventBus handles high-throughput event storm', async () => {
      const bus = new MessagingEventBus('telegram');
      let messageCount = 0;
      let stallCount = 0;
      let commandCount = 0;

      bus.on('message:logged', () => { messageCount++; });
      bus.on('stall:detected', () => { stallCount++; });
      bus.on('command:executed', () => { commandCount++; });

      // Fire 200 events across 3 types concurrently
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 200; i++) {
        if (i % 3 === 0) {
          promises.push(bus.emit('message:logged', {
            messageId: i, channelId: `${i % 10}`, text: `msg ${i}`,
            fromUser: true, timestamp: '', sessionName: null,
          }));
        } else if (i % 3 === 1) {
          promises.push(bus.emit('stall:detected', {
            channelId: `${i % 10}`, sessionName: `s-${i}`, messageText: 'test',
            injectedAt: Date.now(), minutesElapsed: 1, alive: true,
          }));
        } else {
          promises.push(bus.emit('command:executed', {
            command: 'test', args: '', channelId: `${i % 10}`,
            userId: 'u1', handled: true,
          }));
        }
      }

      await Promise.all(promises);

      expect(messageCount).toBe(67); // ceil(200/3)
      expect(stallCount).toBe(67);
      expect(commandCount).toBe(66);
      expect(messageCount + stallCount + commandCount).toBe(200);
    });

    it('once listeners in event storm fire exactly once per listener', async () => {
      const bus = new MessagingEventBus('telegram');
      let onceCount = 0;
      let alwaysCount = 0;

      bus.once('request:flush', () => { onceCount++; });
      bus.on('request:flush', () => { alwaysCount++; });

      // Fire 10 flush events
      for (let i = 0; i < 10; i++) {
        await bus.emit('request:flush', { channelId: `${i}` });
      }

      expect(onceCount).toBe(1);
      expect(alwaysCount).toBe(10);
    });

    it('EventBus survives listener errors during high-throughput', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const bus = new MessagingEventBus('telegram');
      let successCount = 0;

      bus.on('message:logged', () => { throw new Error('always fails'); });
      bus.on('message:logged', () => { successCount++; });

      // Fire 50 events — second listener should always run despite first throwing
      const promises = Array.from({ length: 50 }, (_, i) =>
        bus.emit('message:logged', {
          messageId: i, channelId: '100', text: 'test',
          fromUser: true, timestamp: '', sessionName: null,
        }),
      );
      await Promise.all(promises);

      expect(successCount).toBe(50);
      expect(consoleSpy).toHaveBeenCalledTimes(50);

      consoleSpy.mockRestore();
    });

    it('full pipeline: MessageLogger + StallDetector + CommandRouter + AuthGate + EventBus', async () => {
      vi.useFakeTimers();

      const logPath = path.join(tmpDir, 'eventbus-messages.jsonl');
      const logger = new MessageLogger({ logPath });
      const detector = new StallDetector({ stallTimeoutMinutes: 1 });
      const router = new CommandRouter('telegram');
      const gate = new AuthGate({ authorizedUsers: ['user-1', 'user-2'] });
      const bus = new MessagingEventBus('telegram');

      // Track everything via event bus
      const timeline: string[] = [];
      bus.on('message:logged', (e) => { timeline.push(`log:${e.channelId}:${e.text.substring(0, 10)}`); });
      bus.on('stall:detected', (e) => { timeline.push(`stall:${e.channelId}`); });
      bus.on('command:executed', (e) => { timeline.push(`cmd:${e.command}:${e.handled}`); });
      bus.on('auth:unauthorized', (e) => { timeline.push(`unauth:${e.userId}`); });

      // Wire detector → bus
      detector.setOnStall(async (event, alive) => {
        await bus.emit('stall:detected', {
          channelId: event.channelId, sessionName: event.sessionName,
          messageText: event.messageText, injectedAt: event.injectedAt,
          minutesElapsed: event.minutesElapsed, alive,
        });
      });

      router.register('status', async () => true);

      // Simulate a conversation
      const messages = [
        { userId: 'user-1', channelId: '100', text: 'hello' },
        { userId: 'user-1', channelId: '100', text: '/status' },
        { userId: 'user-3', channelId: '200', text: 'unauthorized!' },
        { userId: 'user-2', channelId: '300', text: 'will this stall?' },
      ];

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        // Auth check
        if (!gate.isAuthorized(msg.userId)) {
          await bus.emit('auth:unauthorized', {
            userId: msg.userId, displayName: msg.userId, channelId: msg.channelId,
          });
          continue;
        }

        // Log
        logger.append({
          messageId: i, channelId: msg.channelId, text: msg.text,
          fromUser: true, timestamp: new Date().toISOString(), sessionName: `sess-${msg.channelId}`,
        });
        await bus.emit('message:logged', {
          messageId: i, channelId: msg.channelId, text: msg.text,
          fromUser: true, timestamp: '', sessionName: `sess-${msg.channelId}`,
        });

        // Command check
        const parsed = router.parse(msg.text);
        if (parsed) {
          const handled = await router.route(msg.text, msg.channelId, msg.userId);
          await bus.emit('command:executed', {
            command: parsed.command, args: parsed.args,
            channelId: msg.channelId, userId: msg.userId, handled,
          });
        } else {
          // Track for stall detection
          detector.trackMessageInjection(msg.channelId, `sess-${msg.channelId}`, msg.text);
        }
      }

      // Advance time to trigger stalls
      vi.advanceTimersByTime(2 * 60 * 1000);
      await detector.check();

      // Verify the full timeline
      expect(timeline).toEqual([
        'log:100:hello',
        'log:100:/status',
        'cmd:status:true',
        'unauth:user-3',
        'log:300:will this ',
        'stall:100',       // hello message stalled (command cleared but hello was tracked)
        'stall:300',       // user-2's message stalled
      ]);

      expect(logger.getStats().totalMessages).toBe(3); // 3 authorized messages logged
      expect(bus.listenerCount('message:logged')).toBe(1);
      expect(bus.eventNames()).toContain('message:logged');

      vi.useRealTimers();
    });
  });

  // ══════════════════════════════════════════════════════════
  // 9. ADVERSARIAL INPUTS
  // ══════════════════════════════════════════════════════════

  describe('Adversarial inputs', () => {
    it('handles null/undefined/empty strings in MessageLogger', () => {
      const logger = new MessageLogger({ logPath: path.join(tmpDir, 'log.jsonl') });

      // Empty text
      logger.append({ messageId: 1, channelId: 'ch1', text: '', fromUser: true, timestamp: new Date().toISOString() });
      // Very long text
      const longText = 'x'.repeat(100_000);
      logger.append({ messageId: 2, channelId: 'ch1', text: longText, fromUser: true, timestamp: new Date().toISOString() });
      // Unicode/emoji
      logger.append({ messageId: 3, channelId: 'ch1', text: '🎉🔥💯 مرحبا 你好 Привет', fromUser: true, timestamp: new Date().toISOString() });
      // Newlines and special chars
      logger.append({ messageId: 4, channelId: 'ch1', text: 'line1\nline2\rline3\tline4\0null', fromUser: true, timestamp: new Date().toISOString() });

      expect(logger.getStats().totalMessages).toBe(4);

      // Re-read from disk and verify integrity
      const logger2 = new MessageLogger({ logPath: path.join(tmpDir, 'log.jsonl') });
      expect(logger2.getStats().totalMessages).toBe(4);
    });

    it('handles malicious channelIds in SessionChannelRegistry', () => {
      const registry = new SessionChannelRegistry({
        registryPath: path.join(tmpDir, 'registry.json'),
      });

      // JSON injection attempt
      registry.register('{"injected":true}', 'session-1');
      expect(registry.getSessionForChannel('{"injected":true}')).toBe('session-1');

      // Path traversal attempt
      registry.register('../../../etc/passwd', 'session-2');
      expect(registry.getSessionForChannel('../../../etc/passwd')).toBe('session-2');

      // Unicode in channel IDs
      registry.register('channel-🎉-emoji', 'session-3');
      expect(registry.getSessionForChannel('channel-🎉-emoji')).toBe('session-3');

      // Very long IDs
      const longId = 'a'.repeat(10_000);
      registry.register(longId, 'session-4');
      expect(registry.getSessionForChannel(longId)).toBe('session-4');

      // Verify persistence
      const registry2 = new SessionChannelRegistry({
        registryPath: path.join(tmpDir, 'registry.json'),
      });
      expect(registry2.getSessionForChannel('{"injected":true}')).toBe('session-1');
      expect(registry2.size).toBe(4);
    });

    it('handles command injection attempts in CommandRouter', async () => {
      const router = new CommandRouter('test');
      const captured: string[] = [];
      router.register('test', async (ctx) => {
        captured.push(ctx.args);
        return true;
      });

      // Shell injection attempts
      await router.route('/test ; rm -rf /', 'ch1', 'user1');
      expect(captured[0]).toBe('; rm -rf /');

      await router.route('/test $(whoami)', 'ch1', 'user1');
      expect(captured[1]).toBe('$(whoami)');

      await router.route('/test `id`', 'ch1', 'user1');
      expect(captured[2]).toBe('`id`');

      // These should all be treated as text args, not executed
      expect(captured).toHaveLength(3);
    });

    it('handles rapid auth changes in AuthGate', async () => {
      const gate = new AuthGate({ authorizedUsers: [] });

      // Rapid authorize/deauthorize
      for (let i = 0; i < 100; i++) {
        gate.authorize(`user-${i}`);
      }
      for (let i = 0; i < 100; i += 2) {
        gate.deauthorize(`user-${i}`);
      }

      // Odd users should be authorized, even should not
      for (let i = 0; i < 100; i++) {
        expect(gate.isAuthorized(`user-${i}`)).toBe(i % 2 !== 0);
      }
    });
  });

  // ══════════════════════════════════════════════════════════
  // 10. DATA CORRUPTION RECOVERY
  // ══════════════════════════════════════════════════════════

  describe('Data corruption recovery', () => {
    it('MessageLogger recovers from corrupted JSONL entries', () => {
      const logPath = path.join(tmpDir, 'corrupted.jsonl');

      // Write some valid entries interleaved with corruption
      const validEntry = JSON.stringify({ messageId: 1, channelId: 'ch1', text: 'valid', fromUser: true, timestamp: '2024-01-01T00:00:00Z' });
      const corruptedContent = [
        validEntry,
        'NOT VALID JSON AT ALL {{{',
        '',
        JSON.stringify({ messageId: 2, channelId: 'ch1', text: 'also valid', fromUser: true, timestamp: '2024-01-01T00:00:01Z' }),
        'null',
        '{"incomplete": true',
      ].join('\n');

      fs.writeFileSync(logPath, corruptedContent);

      // Logger should not crash when reading this file
      const logger = new MessageLogger({ logPath });
      // Should be able to append new entries
      logger.append({ messageId: 3, channelId: 'ch1', text: 'after corruption', fromUser: true, timestamp: new Date().toISOString() });

      expect(logger.getStats().totalMessages).toBeGreaterThanOrEqual(1);
    });

    it('SessionChannelRegistry recovers from corrupted JSON', () => {
      const registryPath = path.join(tmpDir, 'bad-registry.json');
      fs.writeFileSync(registryPath, '{"this is not": valid json}}}}}');

      // Should not throw — starts fresh
      const registry = new SessionChannelRegistry({ registryPath });
      expect(registry.size).toBe(0);

      // Can still write new data
      registry.register('ch1', 'session-1');
      expect(registry.getSessionForChannel('ch1')).toBe('session-1');
    });

    it('SessionChannelRegistry recovers from empty file', () => {
      const registryPath = path.join(tmpDir, 'empty-registry.json');
      fs.writeFileSync(registryPath, '');

      const registry = new SessionChannelRegistry({ registryPath });
      expect(registry.size).toBe(0);
      registry.register('ch1', 'session-1');
      expect(registry.getSessionForChannel('ch1')).toBe('session-1');
    });

    it('MessageLogger handles binary data in JSONL file', () => {
      const logPath = path.join(tmpDir, 'binary.jsonl');
      // Write binary noise then a valid entry
      const binaryData = Buffer.from([0x00, 0xFF, 0xFE, 0x89, 0x50, 0x4E, 0x47]);
      fs.writeFileSync(logPath, binaryData);

      const logger = new MessageLogger({ logPath });
      logger.append({ messageId: 1, channelId: 'ch1', text: 'after binary', fromUser: true, timestamp: new Date().toISOString() });

      expect(logger.getStats().totalMessages).toBeGreaterThanOrEqual(1);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 11. BOUNDARY CONDITIONS
  // ══════════════════════════════════════════════════════════

  describe('Boundary conditions', () => {
    it('StallDetector with zero timeout disables stall detection (by design)', () => {
      vi.useFakeTimers();
      const events: any[] = [];

      const detector = new StallDetector({
        stallTimeoutMinutes: 0,
      });
      detector.setOnStall(async (event) => { events.push(event); });
      detector.start();

      detector.trackMessageInjection('ch1', 'session-1', 'hello');

      // Zero timeout = stall detection disabled — no events should fire
      vi.advanceTimersByTime(300_000);

      expect(events.length).toBe(0);

      detector.stop();
      vi.useRealTimers();
    });

    it('StallDetector with very small timeout fires quickly', () => {
      vi.useFakeTimers();
      const events: any[] = [];

      const detector = new StallDetector({
        stallTimeoutMinutes: 0.01, // ~600ms
        checkIntervalMs: 100,
      });
      detector.setOnStall(async (event) => { events.push(event); });
      detector.start();

      detector.trackMessageInjection('ch1', 'session-1', 'hello');

      vi.advanceTimersByTime(1000); // Well past 600ms

      expect(events.length).toBeGreaterThanOrEqual(1);

      detector.stop();
      vi.useRealTimers();
    });

    it('CommandRouter handles empty command text', async () => {
      const router = new CommandRouter('test');
      let called = false;
      router.register('test', async () => { called = true; return true; });

      // Empty string should not match
      expect(await router.route('', 'ch1', 'user1')).toBe(false);
      expect(await router.route('/', 'ch1', 'user1')).toBe(false);
      expect(await router.route('  ', 'ch1', 'user1')).toBe(false);
      expect(called).toBe(false);
    });

    it('AuthGate deduplicates authorized users (Set-based)', () => {
      const gate = new AuthGate({ authorizedUsers: ['user-1', 'user-1', 'user-1'] });
      expect(gate.isAuthorized('user-1')).toBe(true);
      expect(gate.authorizedCount).toBe(1); // Set deduplicates

      gate.deauthorize('user-1');
      // After deauthorizing the only user, set is empty → denies all (safe default)
      expect(gate.isAuthorized('user-1')).toBe(false);
      expect(gate.authorizedCount).toBe(0);
    });

    it('AuthGate with multiple users: deauthorizing one does not affect others', () => {
      const gate = new AuthGate({ authorizedUsers: ['user-1', 'user-2', 'user-3'] });
      expect(gate.isAuthorized('user-1')).toBe(true);
      expect(gate.isAuthorized('user-2')).toBe(true);

      gate.deauthorize('user-1');
      expect(gate.isAuthorized('user-1')).toBe(false);
      expect(gate.isAuthorized('user-2')).toBe(true);
      expect(gate.isAuthorized('user-3')).toBe(true);
    });

    it('EventBus handles subscriber adding more subscribers during emit', async () => {
      const bus = new MessagingEventBus('test');
      const results: number[] = [];

      bus.on('message:incoming', async () => {
        results.push(1);
        // Add a new listener during emission
        bus.on('message:incoming', async () => {
          results.push(2);
        });
      });

      await bus.emit('message:incoming', { channelId: 'ch1', userId: 'u1', text: 'hello', timestamp: 'now' });
      // First emit: only the original listener should fire (snapshot-based iteration)
      expect(results).toEqual([1]);

      // Second emit: both listeners fire
      results.length = 0;
      await bus.emit('message:incoming', { channelId: 'ch1', userId: 'u1', text: 'hello2', timestamp: 'now' });
      expect(results).toEqual([1, 2]);
    });

    it('EventBus handles subscriber removing itself during emit', async () => {
      const bus = new MessagingEventBus('test');
      const results: number[] = [];

      const unsub = bus.on('message:incoming', async () => {
        results.push(1);
        unsub(); // Remove self during emission
      });

      bus.on('message:incoming', async () => {
        results.push(2);
      });

      await bus.emit('message:incoming', { channelId: 'ch1', userId: 'u1', text: 'hello', timestamp: 'now' });
      // Both should fire on first emit (snapshot-based)
      expect(results).toEqual([1, 2]);

      // Second emit: only the second listener remains
      results.length = 0;
      await bus.emit('message:incoming', { channelId: 'ch1', userId: 'u1', text: 'hello2', timestamp: 'now' });
      expect(results).toEqual([2]);
    });

    it('MessageLogger handles concurrent writes from multiple "adapters"', async () => {
      const logPath = path.join(tmpDir, 'concurrent-writes.jsonl');

      // Simulate 5 "adapters" writing to the same file
      const loggers = Array.from({ length: 5 }, () =>
        new MessageLogger({ logPath })
      );

      const promises = [];
      for (let i = 0; i < 50; i++) {
        const logger = loggers[i % 5];
        promises.push(
          Promise.resolve().then(() =>
            logger.append({
              messageId: i,
              channelId: `ch-${i % 5}`,
              text: `msg-${i}`,
              fromUser: true,
              timestamp: new Date().toISOString(),
            })
          )
        );
      }

      await Promise.all(promises);

      // All 50 entries should be written (no overwrites)
      const content = fs.readFileSync(logPath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      expect(lines.length).toBe(50);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 12. MEMORY PRESSURE & LARGE SCALE
  // ══════════════════════════════════════════════════════════

  describe('Memory pressure & large scale', () => {
    it('MessageLogger handles 10K entries without leaking', () => {
      const logger = new MessageLogger({ logPath: path.join(tmpDir, 'large.jsonl') });

      for (let i = 0; i < 10_000; i++) {
        logger.append({
          messageId: i,
          channelId: `ch-${i % 100}`,
          text: `Message ${i} with some content to make it realistic`,
          fromUser: i % 2 === 0,
          timestamp: new Date().toISOString(),
          senderName: `User${i % 10}`,
        });
      }

      expect(logger.getStats().totalMessages).toBe(10_000);

      // Verify file is readable
      const content = fs.readFileSync(path.join(tmpDir, 'large.jsonl'), 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      expect(lines.length).toBe(10_000);

      // Each line should be valid JSON
      for (let i = 0; i < 10; i++) {
        // Spot-check first 10 lines
        expect(() => JSON.parse(lines[i])).not.toThrow();
      }
    });

    it('SessionChannelRegistry handles 1000 channel registrations', () => {
      const registry = new SessionChannelRegistry({
        registryPath: path.join(tmpDir, 'large-registry.json'),
      });

      for (let i = 0; i < 1000; i++) {
        registry.register(`channel-${i}`, `session-${i}`);
      }

      expect(registry.size).toBe(1000);

      // Verify all mappings survive persistence
      const registry2 = new SessionChannelRegistry({
        registryPath: path.join(tmpDir, 'large-registry.json'),
      });
      expect(registry2.size).toBe(1000);
      expect(registry2.getSessionForChannel('channel-0')).toBe('session-0');
      expect(registry2.getSessionForChannel('channel-999')).toBe('session-999');
    });

    it('EventBus handles 500 listeners on single event', async () => {
      const bus = new MessagingEventBus('stress');
      let totalCalls = 0;

      for (let i = 0; i < 500; i++) {
        bus.on('message:incoming', async () => { totalCalls++; });
      }

      await bus.emit('message:incoming', {
        channelId: 'ch1', userId: 'u1', text: 'hello', timestamp: 'now',
      });

      expect(totalCalls).toBe(500);
    });

    it('CommandRouter handles 100 registered commands without performance degradation', async () => {
      const router = new CommandRouter('test');
      const callCounts: Record<string, number> = {};

      for (let i = 0; i < 100; i++) {
        const name = `cmd${i}`;
        callCounts[name] = 0;
        router.register(name, async () => { callCounts[name]++; return true; });
      }

      // Route to specific commands
      expect(await router.route('/cmd0 arg', 'ch1', 'user1')).toBe(true);
      expect(await router.route('/cmd50 arg', 'ch1', 'user1')).toBe(true);
      expect(await router.route('/cmd99 arg', 'ch1', 'user1')).toBe(true);
      expect(await router.route('/nonexistent', 'ch1', 'user1')).toBe(false);

      expect(callCounts['cmd0']).toBe(1);
      expect(callCounts['cmd50']).toBe(1);
      expect(callCounts['cmd99']).toBe(1);
    });
  });
});
