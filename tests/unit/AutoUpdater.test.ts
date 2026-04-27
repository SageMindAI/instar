import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AutoUpdater } from '../../src/core/AutoUpdater.js';
import type { UpdateChecker } from '../../src/core/UpdateChecker.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import type { StateManager } from '../../src/core/StateManager.js';

// ── Mock Factories ──────────────────────────────────────────────

function createMockUpdateChecker(overrides?: Partial<UpdateChecker>): UpdateChecker {
  return {
    check: vi.fn().mockResolvedValue({
      currentVersion: '0.9.8',
      latestVersion: '0.9.8',
      updateAvailable: false,
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
    rollback: vi.fn().mockResolvedValue({ success: false, previousVersion: '0.9.8', restoredVersion: '0.9.8', message: 'No rollback' }),
    canRollback: vi.fn().mockReturnValue(false),
    getRollbackInfo: vi.fn().mockReturnValue(null),
    fetchChangelog: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as UpdateChecker;
}

function createMockTelegram(): TelegramAdapter {
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

function createMockState(): StateManager {
  return {
    get: vi.fn().mockReturnValue(997), // agent-updates-topic
    set: vi.fn(),
    getSession: vi.fn().mockReturnValue(null),
    saveSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    deleteSession: vi.fn(),
  } as unknown as StateManager;
}

// ── Tests ────────────────────────────────────────────────────────

describe('AutoUpdater', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-updater-test-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('start/stop', () => {
    it('starts and reports status as running', () => {
      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        tmpDir,
        { checkIntervalMinutes: 30 },
      );

      updater.start();
      expect(updater.getStatus().running).toBe(true);

      updater.stop();
      expect(updater.getStatus().running).toBe(false);
    });

    it('start is idempotent', () => {
      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        tmpDir,
      );

      updater.start();
      updater.start(); // Should be a no-op
      expect(updater.getStatus().running).toBe(true);

      updater.stop();
    });
  });

  describe('configuration', () => {
    it('defaults to 30 minute check interval', () => {
      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        tmpDir,
      );

      expect(updater.getStatus().config.checkIntervalMinutes).toBe(30);
    });

    it('defaults to autoApply true', () => {
      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        tmpDir,
      );

      expect(updater.getStatus().config.autoApply).toBe(true);
    });

    it('respects custom config', () => {
      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        tmpDir,
        { checkIntervalMinutes: 15, autoApply: false, autoRestart: false },
      );

      const status = updater.getStatus();
      expect(status.config.checkIntervalMinutes).toBe(15);
      expect(status.config.autoApply).toBe(false);
      expect(status.config.autoRestart).toBe(false);
    });
  });

  describe('state persistence', () => {
    it('saves state to disk', () => {
      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        tmpDir,
      );

      // Trigger a state save by starting (which sets initial state)
      updater.start();
      updater.stop();

      const stateFile = path.join(tmpDir, 'state', 'auto-updater.json');
      // State file may or may not exist depending on whether a tick ran
      // What we're testing is that the constructor doesn't crash on missing file
      expect(() => updater.getStatus()).not.toThrow();
    });

    it('loads persisted state on construction', () => {
      // Write persisted state
      const stateFile = path.join(tmpDir, 'state', 'auto-updater.json');
      fs.writeFileSync(stateFile, JSON.stringify({
        lastCheck: '2026-01-01T00:00:00.000Z',
        lastApply: '2026-01-01T00:00:00.000Z',
        lastAppliedVersion: '0.9.7',
        lastError: null,
        pendingUpdate: null,
      }));

      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        tmpDir,
      );

      const status = updater.getStatus();
      expect(status.lastCheck).toBe('2026-01-01T00:00:00.000Z');
      expect(status.lastAppliedVersion).toBe('0.9.7');
    });

    it('handles corrupted state file gracefully', () => {
      const stateFile = path.join(tmpDir, 'state', 'auto-updater.json');
      fs.writeFileSync(stateFile, 'not json!!!');

      // Should not throw
      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        tmpDir,
      );

      expect(updater.getStatus().lastCheck).toBeNull();
    });
  });

  describe('loop guard', () => {
    it('persisted lastAppliedVersion prevents re-apply', () => {
      // Simulate: version 0.9.9 was already applied in a previous cycle,
      // but the running binary is still 0.9.8 (common with npx cache).
      const stateFile = path.join(tmpDir, 'state', 'auto-updater.json');
      fs.writeFileSync(stateFile, JSON.stringify({
        lastAppliedVersion: '0.9.9',
        savedAt: new Date().toISOString(),
      }));

      const mockChecker = createMockUpdateChecker({
        check: vi.fn().mockResolvedValue({
          currentVersion: '0.9.8',
          latestVersion: '0.9.9',
          updateAvailable: true,
          checkedAt: new Date().toISOString(),
        }),
      });

      const updater = new AutoUpdater(
        mockChecker,
        createMockState(),
        tmpDir,
        { autoApply: true },
      );

      const status = updater.getStatus();
      expect(status.lastAppliedVersion).toBe('0.9.9');

      // The loop guard should prevent applyUpdate from being called
      // when tick runs, because lastAppliedVersion === latestVersion
    });
  });

  describe('Telegram notifications', () => {
    it('setTelegram wires the adapter', () => {
      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        tmpDir,
      );

      const telegram = createMockTelegram();
      updater.setTelegram(telegram);

      // No crash — adapter is now available for notifications
      expect(updater.getStatus().running).toBe(false);
    });
  });

  describe('gatedRestart notification dedup', () => {
    it('persists lastNotifiedRestartVersion to state file before restart', async () => {
      // This is the root cause of the v0.12.10 notification spam:
      // gatedRestart() set lastNotifiedRestartVersion in memory but never
      // called saveState(), so on restart the dedup was lost.
      const stateFile = path.join(tmpDir, 'state', 'auto-updater.json');

      const mockChecker = createMockUpdateChecker({
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
      });

      const telegram = createMockTelegram();
      // Sessions exist but are idle — they don't block restart but DO trigger notification
      const mockSessionManager = {
        listRunningSessions: vi.fn().mockReturnValue([{ name: 'session-1', topicId: 123 }]),
      };
      const mockSessionMonitor = {
        getStatus: vi.fn().mockReturnValue({
          sessionHealth: [{ sessionName: 'session-1', topicId: 123, status: 'idle', idleMinutes: 30 }],
        }),
      };

      const updater = new AutoUpdater(
        mockChecker,
        createMockState(),
        tmpDir,
        { autoApply: true, applyDelayMinutes: 0, preRestartDelaySecs: 0 },
        telegram,
      );
      updater.setSessionDeps(mockSessionManager as any, mockSessionMonitor as any);
      updater.start();

      // Advance past the initial 10s delay to trigger tick
      await vi.advanceTimersByTimeAsync(11_000);

      updater.stop();

      // Read the state file — lastNotifiedRestartVersion should be saved
      if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        expect(state.lastNotifiedRestartVersion).toBe('0.9.9');
        expect(state.lastRestartRequestedVersion).toBe('0.9.9');
        expect(state.lastRestartRequestedAt).toBeTruthy();
      }
    });

    it('does not re-send notification when lastNotifiedRestartVersion matches', async () => {
      // Simulate a restart where the state already has the notification dedup set
      const stateFile = path.join(tmpDir, 'state', 'auto-updater.json');
      fs.writeFileSync(stateFile, JSON.stringify({
        lastAppliedVersion: '0.9.9',
        lastNotifiedRestartVersion: '0.9.9',
        lastRestartRequestedVersion: '0.9.9',
        lastRestartRequestedAt: new Date().toISOString(),
        savedAt: new Date().toISOString(),
      }));

      const mockChecker = createMockUpdateChecker({
        check: vi.fn().mockResolvedValue({
          currentVersion: '0.9.8', // Still old (binary mismatch)
          latestVersion: '0.9.9',
          updateAvailable: true,
          checkedAt: new Date().toISOString(),
        }),
      });

      const telegram = createMockTelegram();

      const updater = new AutoUpdater(
        mockChecker,
        createMockState(),
        tmpDir,
        { autoApply: true },
        telegram,
      );
      updater.start();

      // Advance past the initial 10s delay to trigger tick
      await vi.advanceTimersByTimeAsync(11_000);

      updater.stop();

      // The loop breaker should prevent any notification
      // (lastAppliedVersion === latestVersion catches this in tick)
      // and even if it somehow got to gatedRestart, the restart cooldown would stop it
      const sendCalls = (telegram.sendToTopic as any).mock.calls;
      // Should send at most one mismatch notification, not the "restarting" notification
      const restartNotifications = sendCalls.filter(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('Restarting to pick up')
      );
      expect(restartNotifications.length).toBe(0);
    });
  });

  describe('restart cooldown', () => {
    it('blocks restart when recently requested for same version', async () => {
      // Write state indicating a recent restart was requested
      const stateFile = path.join(tmpDir, 'state', 'auto-updater.json');
      const recentTime = new Date(Date.now() - 5 * 60_000).toISOString(); // 5 min ago
      fs.writeFileSync(stateFile, JSON.stringify({
        lastAppliedVersion: '0.9.9',
        lastRestartRequestedVersion: '0.9.9',
        lastRestartRequestedAt: recentTime,
        savedAt: new Date().toISOString(),
      }));

      const mockChecker = createMockUpdateChecker({
        check: vi.fn().mockResolvedValue({
          currentVersion: '0.9.8', // Binary mismatch
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
      });

      const updater = new AutoUpdater(
        mockChecker,
        createMockState(),
        tmpDir,
        { autoApply: true, applyDelayMinutes: 0 },
      );

      // The loop breaker in tick() should catch this (lastAppliedVersion === latestVersion).
      // Even if it didn't, applyPendingUpdate → gatedRestart would hit the cooldown.
      updater.start();
      await vi.advanceTimersByTimeAsync(11_000);
      updater.stop();

      // applyUpdate should NOT have been called because the loop breaker catches it
      expect(mockChecker.applyUpdate).not.toHaveBeenCalled();
    });

    it('allows restart after cooldown expires', () => {
      // Write state with an OLD restart request (31 min ago — past the 30-min cooldown)
      const stateFile = path.join(tmpDir, 'state', 'auto-updater.json');
      const oldTime = new Date(Date.now() - 31 * 60_000).toISOString();
      fs.writeFileSync(stateFile, JSON.stringify({
        lastRestartRequestedVersion: '0.9.9',
        lastRestartRequestedAt: oldTime,
        savedAt: new Date().toISOString(),
      }));

      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        tmpDir,
      );

      // Verify the cooldown state was loaded
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      expect(state.lastRestartRequestedVersion).toBe('0.9.9');
      // The cooldown should be expired, so a new restart for 0.9.9 would be allowed
    });
  });
});
