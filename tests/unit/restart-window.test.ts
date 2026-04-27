/**
 * Tests for the restart window feature (v0.24.9).
 * Verifies that the AutoUpdater defers restarts to the configured time window.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AutoUpdater } from '../../src/core/AutoUpdater.js';
import type { UpdateChecker } from '../../src/core/UpdateChecker.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import type { StateManager } from '../../src/core/StateManager.js';

// ── Mocks ──────────────────────────────────────────────────────────

function createMockUpdateChecker(): UpdateChecker {
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
  } as unknown as UpdateChecker;
}

function createMockState(): StateManager {
  return {
    listSessions: vi.fn().mockReturnValue([]),
    getSession: vi.fn().mockReturnValue(null),
    saveSession: vi.fn(),
    removeSession: vi.fn(),
    getJobState: vi.fn().mockReturnValue(null),
    saveJobState: vi.fn(),
    getValue: vi.fn().mockReturnValue(undefined),
    setValue: vi.fn(),
  } as unknown as StateManager;
}

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-window-test-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  return dir;
}

// ── Tests ──────────────────────────────────────────────────────────

describe('Restart window', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('isInRestartWindow returns true when no window is configured', () => {
    const au = new AutoUpdater(
      createMockUpdateChecker(),
      createMockState(),
      dir,
      { restartWindow: null },
    );

    expect((au as any).isInRestartWindow()).toBe(true);
  });

  it('isInRestartWindow returns true when current time is inside the window', () => {
    // Set time to 3:00 AM
    vi.setSystemTime(new Date('2026-03-27T03:00:00'));

    const au = new AutoUpdater(
      createMockUpdateChecker(),
      createMockState(),
      dir,
      { restartWindow: { start: '02:00', end: '05:00' } },
    );

    expect((au as any).isInRestartWindow()).toBe(true);
  });

  it('isInRestartWindow returns false when current time is outside the window', () => {
    // Set time to 2:00 PM
    vi.setSystemTime(new Date('2026-03-27T14:00:00'));

    const au = new AutoUpdater(
      createMockUpdateChecker(),
      createMockState(),
      dir,
      { restartWindow: { start: '02:00', end: '05:00' } },
    );

    expect((au as any).isInRestartWindow()).toBe(false);
  });

  it('isInRestartWindow handles midnight-wrapping windows (e.g., 23:00-05:00)', () => {
    const au = new AutoUpdater(
      createMockUpdateChecker(),
      createMockState(),
      dir,
      { restartWindow: { start: '23:00', end: '05:00' } },
    );

    // 11:30 PM — inside window
    vi.setSystemTime(new Date('2026-03-27T23:30:00'));
    expect((au as any).isInRestartWindow()).toBe(true);

    // 2:00 AM — inside window (after midnight)
    vi.setSystemTime(new Date('2026-03-28T02:00:00'));
    expect((au as any).isInRestartWindow()).toBe(true);

    // 2:00 PM — outside window
    vi.setSystemTime(new Date('2026-03-28T14:00:00'));
    expect((au as any).isInRestartWindow()).toBe(false);

    // 10:00 PM — outside window (just before start)
    vi.setSystemTime(new Date('2026-03-28T22:00:00'));
    expect((au as any).isInRestartWindow()).toBe(false);
  });

  it('msUntilRestartWindow calculates correct delay', () => {
    // Current time: 2:00 PM, window starts at 2:00 AM
    vi.setSystemTime(new Date('2026-03-27T14:00:00'));

    const au = new AutoUpdater(
      createMockUpdateChecker(),
      createMockState(),
      dir,
      { restartWindow: { start: '02:00', end: '05:00' } },
    );

    const ms = (au as any).msUntilRestartWindow();
    // Should be 12 hours = 43200000 ms
    expect(ms).toBe(12 * 60 * 60 * 1000);
  });

  it('msUntilRestartWindow wraps to next day when window start has passed', () => {
    // Current time: 3:00 AM (inside window), window starts at 2:00 AM
    vi.setSystemTime(new Date('2026-03-27T03:00:00'));

    const au = new AutoUpdater(
      createMockUpdateChecker(),
      createMockState(),
      dir,
      { restartWindow: { start: '02:00', end: '05:00' } },
    );

    const ms = (au as any).msUntilRestartWindow();
    // Window start already passed today, so should target tomorrow 2:00 AM = 23 hours
    expect(ms).toBe(23 * 60 * 60 * 1000);
  });

  it('gatedRestart with bypassWindow=true ignores the window', async () => {
    // Use real timers for this test since gatedRestart has internal awaits
    vi.useRealTimers();

    const au = new AutoUpdater(
      createMockUpdateChecker(),
      createMockState(),
      dir,
      { restartWindow: { start: '02:00', end: '05:00' } },
    );

    // Mock isInRestartWindow to return false (outside window)
    vi.spyOn(au as any, 'isInRestartWindow').mockReturnValue(false);

    // Spy on requestRestart to confirm it gets called
    const requestSpy = vi.spyOn(au as any, 'requestRestart').mockImplementation(() => {});

    await (au as any).gatedRestart('0.9.9', true);

    // With bypassWindow=true, should proceed even though outside window
    expect(requestSpy).toHaveBeenCalledWith('0.9.9');
  });

  it('gatedRestart without bypass defers when outside window', async () => {
    // Set time to 2 PM — outside window
    vi.setSystemTime(new Date('2026-03-27T14:00:00'));

    const au = new AutoUpdater(
      createMockUpdateChecker(),
      createMockState(),
      dir,
      { restartWindow: { start: '02:00', end: '05:00' } },
    );

    const requestSpy = vi.spyOn(au as any, 'requestRestart').mockImplementation(() => {});

    await (au as any).gatedRestart('0.9.9', false);

    // Should NOT have called requestRestart — deferred to window
    expect(requestSpy).not.toHaveBeenCalled();
  });
});
