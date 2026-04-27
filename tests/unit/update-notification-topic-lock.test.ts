/**
 * Regression tests for the "update announcements leak into non-Updates topics" bug.
 *
 * Prior behavior: AutoUpdater.notify() and AutoDispatcher.notify() would fall back
 * from `agent-updates-topic` to `agent-attention-topic` when the Updates topic
 * wasn't configured, silently routing update spam into the user-facing Attention
 * topic. This matched neither the /telegram/post-update endpoint contract nor the
 * user's expectation ("update messages belong in the Updates topic, period").
 *
 * New behavior: both classes route exclusively to `agent-updates-topic`. If that
 * topic isn't set, the send is skipped (drops to console log). Never Attention,
 * never any other topic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AutoUpdater } from '../../src/core/AutoUpdater.js';
import { AutoDispatcher } from '../../src/core/AutoDispatcher.js';
import type { UpdateChecker } from '../../src/core/UpdateChecker.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import type { StateManager } from '../../src/core/StateManager.js';
import type { DispatchManager } from '../../src/core/DispatchManager.js';
import type { DispatchExecutor } from '../../src/core/DispatchExecutor.js';

function mockChecker(): UpdateChecker {
  return {
    check: vi.fn().mockResolvedValue({
      currentVersion: '0.9.8',
      latestVersion: '0.9.9',
      updateAvailable: true,
      checkedAt: new Date().toISOString(),
    }),
    applyUpdate: vi.fn().mockResolvedValue({
      success: true,
      previousVersion: '0.9.8',
      newVersion: '0.9.9',
      message: 'Updated',
      restartNeeded: true,
      healthCheck: 'skipped',
    }),
    getInstalledVersion: vi.fn().mockReturnValue('0.9.8'),
    getLastCheck: vi.fn().mockReturnValue(null),
    rollback: vi.fn(),
    canRollback: vi.fn().mockReturnValue(false),
    getRollbackInfo: vi.fn().mockReturnValue(null),
    fetchChangelog: vi.fn().mockResolvedValue(undefined),
  } as unknown as UpdateChecker;
}

function mockTelegram(): TelegramAdapter {
  return {
    sendToTopic: vi.fn().mockResolvedValue(undefined),
    platform: 'telegram',
    start: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(),
    onMessage: vi.fn(),
    resolveUser: vi.fn(),
  } as unknown as TelegramAdapter;
}

function mockState(values: Record<string, unknown>): StateManager {
  return {
    get: vi.fn((key: string) => values[key]),
    set: vi.fn(),
    getSession: vi.fn().mockReturnValue(null),
    saveSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    deleteSession: vi.fn(),
  } as unknown as StateManager;
}

describe('update announcement topic lock', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-lock-test-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('AutoUpdater.notify', () => {
    it('sends to the Updates topic when it is configured', async () => {
      const telegram = mockTelegram();
      const state = mockState({ 'agent-updates-topic': 4242, 'agent-attention-topic': 9999 });

      const updater = new AutoUpdater(
        mockChecker(),
        state,
        tmpDir,
        { autoApply: false },
        telegram,
      );

      await (updater as any).notify('update available');

      expect(telegram.sendToTopic).toHaveBeenCalledTimes(1);
      expect(telegram.sendToTopic).toHaveBeenCalledWith(4242, 'update available');
    });

    it('does NOT fall back to Attention when Updates topic is missing', async () => {
      const telegram = mockTelegram();
      const state = mockState({
        'agent-updates-topic': undefined,
        'agent-attention-topic': 9999,
      });

      const updater = new AutoUpdater(
        mockChecker(),
        state,
        tmpDir,
        { autoApply: false },
        telegram,
      );

      await (updater as any).notify('update available');

      expect(telegram.sendToTopic).not.toHaveBeenCalled();
    });

    it('skips the send entirely when neither topic is configured', async () => {
      const telegram = mockTelegram();
      const state = mockState({});

      const updater = new AutoUpdater(
        mockChecker(),
        state,
        tmpDir,
        { autoApply: false },
        telegram,
      );

      await (updater as any).notify('update available');

      expect(telegram.sendToTopic).not.toHaveBeenCalled();
    });
  });

  describe('AutoDispatcher.notify', () => {
    function mockDispatchManager(): DispatchManager {
      return {
        fetchNew: vi.fn().mockResolvedValue([]),
        getPending: vi.fn().mockReturnValue([]),
        markApplied: vi.fn(),
        markRolledBack: vi.fn(),
        markFailed: vi.fn(),
      } as unknown as DispatchManager;
    }

    function mockExecutor(): DispatchExecutor {
      return {
        execute: vi.fn(),
      } as unknown as DispatchExecutor;
    }

    it('sends to the Updates topic when it is configured', async () => {
      const telegram = mockTelegram();
      const state = mockState({ 'agent-updates-topic': 4242, 'agent-attention-topic': 9999 });

      const dispatcher = new AutoDispatcher(
        mockDispatchManager(),
        mockExecutor(),
        state,
        tmpDir,
        {},
        telegram,
      );

      await (dispatcher as any).notify('dispatch applied');

      expect(telegram.sendToTopic).toHaveBeenCalledTimes(1);
      expect(telegram.sendToTopic).toHaveBeenCalledWith(4242, 'dispatch applied');
    });

    it('does NOT fall back to Attention when Updates topic is missing', async () => {
      const telegram = mockTelegram();
      const state = mockState({
        'agent-updates-topic': undefined,
        'agent-attention-topic': 9999,
      });

      const dispatcher = new AutoDispatcher(
        mockDispatchManager(),
        mockExecutor(),
        state,
        tmpDir,
        {},
        telegram,
      );

      await (dispatcher as any).notify('dispatch applied');

      expect(telegram.sendToTopic).not.toHaveBeenCalled();
    });
  });
});
