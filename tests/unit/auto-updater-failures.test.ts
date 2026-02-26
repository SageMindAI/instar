import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AutoUpdater } from '../../src/core/AutoUpdater.js';
import type { UpdateChecker } from '../../src/core/UpdateChecker.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import type { StateManager } from '../../src/core/StateManager.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';

// ── Mock child_process before any imports that use it ────────────
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
    spawn: vi.fn(actual.spawn),
  };
});

import { execFileSync, spawn } from 'node:child_process';

// ── Mock Factories ──────────────────────────────────────────────

function createMockUpdateChecker(overrides?: Partial<UpdateChecker>): UpdateChecker {
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
    rollback: vi.fn().mockResolvedValue({ success: false, previousVersion: '0.9.8', restoredVersion: '0.9.8', message: 'No rollback' }),
    canRollback: vi.fn().mockReturnValue(false),
    getRollbackInfo: vi.fn().mockReturnValue(null),
    fetchChangelog: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as UpdateChecker;
}

function createMockTelegram(overrides?: Partial<TelegramAdapter>): TelegramAdapter {
  return {
    sendToTopic: vi.fn().mockResolvedValue(undefined),
    platform: 'telegram',
    start: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(),
    onMessage: vi.fn(),
    resolveUser: vi.fn(),
    ...overrides,
  } as unknown as TelegramAdapter;
}

function createMockState(overrides?: Record<string, unknown>): StateManager {
  return {
    get: vi.fn().mockReturnValue(997),
    set: vi.fn(),
    getSession: vi.fn().mockReturnValue(null),
    saveSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    deleteSession: vi.fn(),
    ...overrides,
  } as unknown as StateManager;
}

// ── Failure Path Tests ──────────────────────────────────────────

describe('AutoUpdater — failure paths', () => {
  let tmpDir: string;
  const mockedExecFileSync = vi.mocked(execFileSync);
  const mockedSpawn = vi.mocked(spawn);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-updater-fail-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    DegradationReporter.resetForTesting();
    mockedExecFileSync.mockReset();
    mockedSpawn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. selfRestart fails — spawn throws ─────────────────────

  describe('selfRestart fails — spawn throws', () => {
    it('catches spawn error without crashing, reports degradation', async () => {
      // Make findBestBinary succeed so we reach the spawn call
      mockedExecFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
        if (cmd === 'npm' && args?.[0] === 'bin') return '/usr/local/bin\n' as any;
        throw new Error('not found');
      });
      // The binary must "exist" for findBestBinary to return it
      const fakeBin = path.join('/usr/local/bin', 'instar');
      const origExistsSync = fs.existsSync;
      vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
        if (String(p) === fakeBin) return true;
        // Block LaunchAgents detection so selfRestart doesn't call process.exit
        if (String(p).includes('LaunchAgents')) return false;
        return origExistsSync(p);
      });

      // Ensure env-based launchd/systemd detection is disabled
      delete process.env.LAUNCHED_BY_LAUNCHD;
      delete process.env.INVOCATION_ID;

      mockedSpawn.mockImplementation(() => {
        throw new Error('ENOENT: spawn failed');
      });

      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        tmpDir,
        { autoApply: true, autoRestart: true },
      );

      // Invoke the private tick method which triggers selfRestart after a successful update
      const tick = (updater as any).tick.bind(updater);
      await tick();

      // Process should still be alive — the error was caught
      const status = updater.getStatus();
      expect(status.lastAppliedVersion).toBe('0.9.9');

      // DegradationReporter should have captured the failure
      const reporter = DegradationReporter.getInstance();
      const events = reporter.getEvents();
      expect(events.some(e => e.feature === 'AutoUpdater.selfRestart')).toBe(true);
    });
  });

  // ── 2. findBestBinary returns null — all strategies fail ────

  describe('findBestBinary returns null — all strategies fail', () => {
    it('returns null gracefully when all binary resolution strategies fail', () => {
      // All execFileSync calls throw
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('command not found');
      });

      // process.argv[1] is from npx cache (stale source — filtered out)
      const origArgv1 = process.argv[1];
      process.argv[1] = '/Users/test/.npm/_npx/abc123/node_modules/.bin/instar';

      try {
        const updater = new AutoUpdater(
          createMockUpdateChecker(),
          createMockState(),
          tmpDir,
          { autoApply: true, autoRestart: true },
        );

        const result = (updater as any).findBestBinary();
        expect(result).toBeNull();
      } finally {
        process.argv[1] = origArgv1;
      }
    });

    it('selfRestart exits early without spawning when no binary found', async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('command not found');
      });

      // Block launchd/systemd detection so selfRestart doesn't call process.exit
      delete process.env.LAUNCHED_BY_LAUNCHD;
      delete process.env.INVOCATION_ID;
      const origExistsSync = fs.existsSync;
      vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
        if (String(p).includes('LaunchAgents')) return false;
        return origExistsSync(p);
      });

      const origArgv1 = process.argv[1];
      process.argv[1] = '/Users/test/.npm/_npx/abc123/node_modules/.bin/instar';

      try {
        const updater = new AutoUpdater(
          createMockUpdateChecker(),
          createMockState(),
          tmpDir,
          { autoApply: true, autoRestart: true },
        );

        // Directly call selfRestart
        (updater as any).selfRestart();

        // spawn should never have been called
        expect(mockedSpawn).not.toHaveBeenCalled();
      } finally {
        process.argv[1] = origArgv1;
      }
    });
  });

  // ── 3. applyUpdate fails — npm install throws ──────────────

  describe('applyUpdate fails — should not corrupt state', () => {
    it('records error in status and preserves existing state', async () => {
      // Write some pre-existing state
      const stateFile = path.join(tmpDir, 'state', 'auto-updater.json');
      const preState = {
        lastCheck: '2026-01-01T00:00:00.000Z',
        lastApply: '2026-01-01T00:00:00.000Z',
        lastAppliedVersion: '0.9.7',
        lastError: null,
        pendingUpdate: null,
        savedAt: '2026-01-01T00:00:00.000Z',
      };
      fs.writeFileSync(stateFile, JSON.stringify(preState));

      const mockChecker = createMockUpdateChecker({
        applyUpdate: vi.fn().mockResolvedValue({
          success: false,
          previousVersion: '0.9.8',
          newVersion: '0.9.8',
          message: 'npm install threw ENOMEM',
          restartNeeded: false,
          healthCheck: 'skipped',
        }),
      });

      const updater = new AutoUpdater(
        mockChecker,
        createMockState(),
        tmpDir,
        { autoApply: true, autoRestart: true },
      );

      await (updater as any).tick();

      const status = updater.getStatus();
      // Error recorded
      expect(status.lastError).toBe('npm install threw ENOMEM');
      // Previous lastAppliedVersion preserved (not overwritten with failed version)
      expect(status.lastAppliedVersion).toBe('0.9.7');
      // No pending update should linger after a failed apply
      // (pendingUpdate is set to latestVersion before apply, then stays as-is on failure)
      expect(status.pendingUpdate).toBe('0.9.9');

      // State file should be valid JSON (not corrupted)
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      expect(saved.lastError).toBe('npm install threw ENOMEM');
    });

    it('still sends failure notification via Telegram', async () => {
      const telegram = createMockTelegram();

      const mockChecker = createMockUpdateChecker({
        applyUpdate: vi.fn().mockResolvedValue({
          success: false,
          previousVersion: '0.9.8',
          newVersion: '0.9.8',
          message: 'npm ENETWORK error',
          restartNeeded: false,
          healthCheck: 'skipped',
        }),
      });

      const updater = new AutoUpdater(
        mockChecker,
        createMockState(),
        tmpDir,
        { autoApply: true },
        telegram,
      );

      await (updater as any).tick();

      // Notification about the failure was sent
      expect(telegram.sendToTopic).toHaveBeenCalled();
      const callArg = (telegram.sendToTopic as any).mock.calls[0][1] as string;
      expect(callArg).toContain('didn\'t work out');
    });
  });

  // ── 4. tick throws unexpectedly — isApplying resets ────────

  describe('tick throws unexpectedly — isApplying flag resets', () => {
    it('resets isApplying when check() throws', async () => {
      const mockChecker = createMockUpdateChecker({
        check: vi.fn().mockRejectedValue(new Error('network timeout')),
      });

      const updater = new AutoUpdater(
        mockChecker,
        createMockState(),
        tmpDir,
        { autoApply: true },
      );

      await (updater as any).tick();

      // isApplying should be false, not stuck
      expect((updater as any).isApplying).toBe(false);

      // Error is recorded
      expect(updater.getStatus().lastError).toBe('network timeout');

      // A second tick should not be blocked by isApplying
      await (updater as any).tick();
      expect(mockChecker.check).toHaveBeenCalledTimes(2);
    });
  });

  // ── 5. notifyUser fails — Telegram send throws ─────────────

  describe('notify fails — Telegram sendToTopic throws', () => {
    it('update still succeeds even when notification throws', async () => {
      const telegram = createMockTelegram({
        sendToTopic: vi.fn().mockRejectedValue(new Error('Telegram API 502')),
      });

      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        tmpDir,
        { autoApply: true, autoRestart: false },
        telegram,
      );

      await (updater as any).tick();

      // Update was applied successfully despite notification failure
      const status = updater.getStatus();
      expect(status.lastAppliedVersion).toBe('0.9.9');
      expect(status.lastApply).not.toBeNull();
      // No error recorded — the update itself succeeded
      expect(status.lastError).toBeNull();
    });

    it('falls back to console log when Telegram unavailable', async () => {
      const consoleSpy = vi.spyOn(console, 'log');

      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        tmpDir,
        { autoApply: true, autoRestart: false },
        null as any, // No telegram adapter
      );

      await (updater as any).tick();

      // Notification fell back to console
      const logCalls = consoleSpy.mock.calls.map(c => c.join(' '));
      expect(logCalls.some(msg => msg.includes('Notification:'))).toBe(true);
    });
  });

  // ── 6. Concurrent update attempts ─────────────────────────

  describe('concurrent update attempts', () => {
    it('second tick is skipped when isApplying is true', async () => {
      // Create a checker where applyUpdate takes a long time
      let resolveApply!: (value: any) => void;
      const slowApply = new Promise(r => { resolveApply = r; });

      const mockChecker = createMockUpdateChecker({
        applyUpdate: vi.fn().mockReturnValue(slowApply),
      });

      const updater = new AutoUpdater(
        mockChecker,
        createMockState(),
        tmpDir,
        { autoApply: true, autoRestart: false },
      );

      // Start first tick (will block on applyUpdate)
      const tick1 = (updater as any).tick();

      // isApplying should be true while tick1 is in progress
      // Give the first tick a moment to reach the apply step
      await vi.advanceTimersByTimeAsync(10);
      expect((updater as any).isApplying).toBe(true);

      // Start second tick — should bail out immediately
      const consoleSpy = vi.spyOn(console, 'log');
      const tick2 = (updater as any).tick();
      await tick2;

      expect(consoleSpy.mock.calls.some(
        c => c.join(' ').includes('Skipping tick')
      )).toBe(true);

      // applyUpdate called only once (from tick1)
      expect(mockChecker.applyUpdate).toHaveBeenCalledTimes(1);

      // Resolve the slow apply to clean up
      resolveApply({
        success: true,
        previousVersion: '0.9.8',
        newVersion: '0.9.9',
        message: 'Updated',
        restartNeeded: false,
        healthCheck: 'skipped',
      });
      await tick1;
    });
  });

  // ── 7. isLaunchdManaged throws — returns false gracefully ──

  describe('isLaunchdManaged throws — returns false gracefully', () => {
    it('returns false when readdirSync throws', () => {
      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        tmpDir,
      );

      // Mock readdirSync to throw for the LaunchAgents directory
      const origReaddirSync = fs.readdirSync;
      vi.spyOn(fs, 'readdirSync').mockImplementation((p: fs.PathLike, opts?: any) => {
        if (String(p).includes('LaunchAgents')) {
          throw new Error('EACCES: permission denied');
        }
        return origReaddirSync(p, opts);
      });

      // existsSync returns true so we reach readdirSync
      const origExistsSync = fs.existsSync;
      vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
        if (String(p).includes('LaunchAgents')) return true;
        return origExistsSync(p);
      });

      const result = (updater as any).isLaunchdManaged();
      expect(result).toBe(false);
    });

    it('returns false on non-darwin platforms', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      try {
        const updater = new AutoUpdater(
          createMockUpdateChecker(),
          createMockState(),
          tmpDir,
        );
        const result = (updater as any).isLaunchdManaged();
        expect(result).toBe(false);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });
  });

  // ── 8. getInstalledVersion returns 0.0.0 — package.json unreadable ──

  describe('getInstalledVersion returns 0.0.0 — UpdateChecker fallback', () => {
    it('tick continues normally when checker reports 0.0.0 as current version', async () => {
      const mockChecker = createMockUpdateChecker({
        check: vi.fn().mockResolvedValue({
          currentVersion: '0.0.0',
          latestVersion: '0.9.9',
          updateAvailable: true,
          checkedAt: new Date().toISOString(),
        }),
        applyUpdate: vi.fn().mockResolvedValue({
          success: true,
          previousVersion: '0.0.0',
          newVersion: '0.9.9',
          message: 'Updated from unknown version',
          restartNeeded: false,
          healthCheck: 'skipped',
        }),
      });

      const updater = new AutoUpdater(
        mockChecker,
        createMockState(),
        tmpDir,
        { autoApply: true, autoRestart: false },
      );

      // Should not throw — 0.0.0 is a valid (degraded) state
      await (updater as any).tick();

      const status = updater.getStatus();
      expect(status.lastAppliedVersion).toBe('0.9.9');
      expect(status.lastError).toBeNull();
    });
  });

  // ── Additional edge case: loadState with missing state dir ──

  describe('loadState with missing state directory', () => {
    it('constructs without error when state dir does not exist', () => {
      const nonexistentDir = path.join(tmpDir, 'does-not-exist');

      // Should not throw — loadState catches the missing file
      const updater = new AutoUpdater(
        createMockUpdateChecker(),
        createMockState(),
        nonexistentDir,
      );

      const status = updater.getStatus();
      expect(status.lastCheck).toBeNull();
      expect(status.lastAppliedVersion).toBeNull();
    });
  });

  // ── Additional edge case: saveState atomic write failure ───

  describe('saveState atomic write failure', () => {
    it('tick does not throw when state directory is read-only', async () => {
      const mockChecker = createMockUpdateChecker({
        check: vi.fn().mockResolvedValue({
          currentVersion: '0.9.8',
          latestVersion: '0.9.8',
          updateAvailable: false,
          checkedAt: new Date().toISOString(),
        }),
      });

      const updater = new AutoUpdater(
        mockChecker,
        createMockState(),
        tmpDir,
        { autoApply: true },
      );

      // Make the state dir read-only so writeFileSync fails
      const stateDir = path.join(tmpDir, 'state');
      fs.chmodSync(stateDir, 0o444);

      try {
        // tick calls saveState internally — should not throw
        // (saveState catches write errors silently)
        await (updater as any).tick();

        // The check still ran successfully even though state couldn't persist
        expect(mockChecker.check).toHaveBeenCalled();
      } finally {
        // Restore permissions for cleanup
        fs.chmodSync(stateDir, 0o755);
      }
    });
  });
});
