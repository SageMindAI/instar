/**
 * Integration test: Shared infrastructure delegation from TelegramAdapter.
 *
 * Verifies that when SHARED_INFRA_FLAGS are enabled, TelegramAdapter
 * correctly delegates to the shared modules without changing observable behavior.
 *
 * This is the critical Phase 1 integration test — proving the extraction
 * doesn't change behavior when flags are toggled on.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SHARED_INFRA_FLAGS } from '../../src/messaging/shared/FeatureFlags.js';

// Save original flag values
const originalFlags = { ...SHARED_INFRA_FLAGS };

describe('Shared Infrastructure Delegation', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-shared-integ-'));
    stateDir = tmpDir;
    // Reset flags to known state
    Object.assign(SHARED_INFRA_FLAGS, originalFlags);
  });

  afterEach(() => {
    // Restore original flags
    Object.assign(SHARED_INFRA_FLAGS, originalFlags);
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Create a TelegramAdapter with a fake token (won't actually connect).
   * We test internal delegation, not Telegram API calls.
   */
  async function createAdapter(flags?: Partial<typeof SHARED_INFRA_FLAGS>) {
    if (flags) {
      Object.assign(SHARED_INFRA_FLAGS, flags);
    }

    // Dynamic import to pick up flag state at construction time
    const { TelegramAdapter } = await import('../../src/messaging/TelegramAdapter.js');
    const adapter = new TelegramAdapter(
      {
        token: 'fake-token-for-test',
        chatId: '-1001234567890',
        stallTimeoutMinutes: 5,
        promiseTimeoutMinutes: 10,
      },
      stateDir,
    );
    return adapter;
  }

  describe('MessageLogger delegation (Phase 1b)', () => {
    it('writes to JSONL when flag is disabled (legacy path)', async () => {
      const adapter = await createAdapter({ useSharedMessageLogger: false });
      const logPath = path.join(stateDir, 'telegram-messages.jsonl');

      // Use the public sendToTopic indirectly — we can test via the log file
      // Since we can't call Telegram API, we'll call the internal log methods via adapter
      // Access private method through type assertion for testing
      const adapterAny = adapter as any;
      adapterAny.appendToLog({
        messageId: 1,
        topicId: 42,
        text: 'legacy test',
        fromUser: true,
        timestamp: new Date().toISOString(),
        sessionName: null,
      });

      const content = fs.readFileSync(logPath, 'utf-8');
      const entry = JSON.parse(content.trim());
      expect(entry.topicId).toBe(42);
      expect(entry.text).toBe('legacy test');
    });

    it('writes to JSONL when flag is enabled (shared path)', async () => {
      const adapter = await createAdapter({ useSharedMessageLogger: true });
      const logPath = path.join(stateDir, 'telegram-messages.jsonl');

      const adapterAny = adapter as any;
      adapterAny.appendToLog({
        messageId: 1,
        topicId: 42,
        text: 'shared test',
        fromUser: true,
        timestamp: new Date().toISOString(),
        sessionName: null,
      });

      const content = fs.readFileSync(logPath, 'utf-8');
      const entry = JSON.parse(content.trim());
      // Shared logger writes channelId instead of topicId
      expect(entry.channelId).toBe(42);
      expect(entry.text).toBe('shared test');
      expect(entry.platform).toBe('telegram');
    });

    it('fires onMessageLogged callback in both paths', async () => {
      for (const useShared of [false, true]) {
        const adapter = await createAdapter({ useSharedMessageLogger: useShared });
        const logged: any[] = [];

        const adapterAny = adapter as any;
        adapterAny.onMessageLogged = (entry: any) => logged.push(entry);

        adapterAny.appendToLog({
          messageId: 1,
          topicId: 42,
          text: `callback test (shared=${useShared})`,
          fromUser: true,
          timestamp: new Date().toISOString(),
          sessionName: null,
        });

        expect(logged).toHaveLength(1);
        expect(logged[0].text).toContain('callback test');
      }
    });
  });

  describe('StallDetector delegation (Phase 1c)', () => {
    it('tracks message injection in legacy path', async () => {
      const adapter = await createAdapter({ useSharedStallDetector: false });
      adapter.trackMessageInjection(42, 'test-session', 'hello');

      const status = adapter.getStatus();
      expect(status.pendingStalls).toBe(1);
    });

    it('tracks message injection in shared path', async () => {
      const adapter = await createAdapter({ useSharedStallDetector: true });
      adapter.trackMessageInjection(42, 'test-session', 'hello');

      const status = adapter.getStatus();
      expect(status.pendingStalls).toBe(1);
    });

    it('clears stall tracking in both paths', async () => {
      for (const useShared of [false, true]) {
        const adapter = await createAdapter({ useSharedStallDetector: useShared });
        adapter.trackMessageInjection(42, 'test-session', 'hello');
        adapter.clearStallTracking(42);

        const status = adapter.getStatus();
        expect(status.pendingStalls).toBe(0);
      }
    });

    it('clears promise tracking in both paths', async () => {
      for (const useShared of [false, true]) {
        const adapter = await createAdapter({ useSharedStallDetector: useShared });
        const adapterAny = adapter as any;

        if (useShared) {
          adapterAny.sharedStallDetector.trackOutboundMessage('42', 'test-session', 'Working on it');
        } else {
          adapterAny.pendingPromises.set(42, {
            topicId: 42,
            sessionName: 'test-session',
            promiseText: 'Working on it',
            promisedAt: Date.now(),
            alerted: false,
          });
        }

        expect(adapter.getStatus().pendingPromises).toBe(1);
        adapter.clearPromiseTracking(42);
        expect(adapter.getStatus().pendingPromises).toBe(0);
      }
    });
  });

  describe('getStatus() consistency', () => {
    it('returns same shape regardless of flags', async () => {
      const legacy = await createAdapter({
        useSharedMessageLogger: false,
        useSharedStallDetector: false,
      });
      const shared = await createAdapter({
        useSharedMessageLogger: true,
        useSharedStallDetector: true,
      });

      const legacyStatus = legacy.getStatus();
      const sharedStatus = shared.getStatus();

      // Same keys
      expect(Object.keys(legacyStatus).sort()).toEqual(Object.keys(sharedStatus).sort());
      // Same types
      expect(typeof legacyStatus.started).toBe(typeof sharedStatus.started);
      expect(typeof legacyStatus.pendingStalls).toBe(typeof sharedStatus.pendingStalls);
      expect(typeof legacyStatus.pendingPromises).toBe(typeof sharedStatus.pendingPromises);
      expect(typeof legacyStatus.topicMappings).toBe(typeof sharedStatus.topicMappings);
    });
  });
});
