/**
 * Tests for Graceful Updates — Phase 2
 *
 * Covers:
 * - Phase 2A: Update coalescing (rapid publishes → single restart)
 * - Phase 2B: Session-aware restart gating (UpdateGate)
 * - Phase 2C: Notify-only mode (autoApply: false)
 * - Phase 2E: Pre-restart session notification
 * - E2E: Full update cycle across all phases
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AutoUpdater } from '../../src/core/AutoUpdater.js';
import { UpdateGate } from '../../src/core/UpdateGate.js';
import type { UpdateChecker } from '../../src/core/UpdateChecker.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import type { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerLike, SessionMonitorLike, SessionHealthEntry } from '../../src/core/UpdateGate.js';

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

function createMockSessionManager(sessions: Array<{ name: string; topicId?: number }> = []): SessionManagerLike {
  return {
    listRunningSessions: vi.fn().mockReturnValue(sessions),
  };
}

function createMockSessionMonitor(health: SessionHealthEntry[] = []): SessionMonitorLike {
  return {
    getStatus: vi.fn().mockReturnValue({ sessionHealth: health }),
  };
}

// ── Phase 2A: Update Coalescing ─────────────────────────────────

describe('Phase 2A: Update coalescing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coalescing-test-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rapid version bumps produce single apply (3 versions in 3 minutes)', async () => {
    let currentLatest = '0.9.9';
    const mockChecker = createMockUpdateChecker({
      check: vi.fn().mockImplementation(async () => ({
        currentVersion: '0.9.8',
        latestVersion: currentLatest,
        updateAvailable: true,
        checkedAt: new Date().toISOString(),
      })),
    });

    const updater = new AutoUpdater(
      mockChecker,
      createMockState(),
      tmpDir,
      { autoApply: true, applyDelayMinutes: 5 },
    );

    // Tick 1: detects 0.9.9 → starts 5-minute coalescing timer
    await (updater as any).tick();
    expect(updater.getStatus().coalescingUntil).not.toBeNull();
    expect(updater.getStatus().pendingUpdate).toBe('0.9.9');

    // 1 minute later: 0.9.10 published → timer resets
    currentLatest = '0.9.10';
    await vi.advanceTimersByTimeAsync(60_000);
    await (updater as any).tick();
    expect(updater.getStatus().pendingUpdate).toBe('0.9.10');

    // 2 minutes later: 0.9.11 published → timer resets again
    currentLatest = '0.9.11';
    await vi.advanceTimersByTimeAsync(120_000);
    await (updater as any).tick();
    expect(updater.getStatus().pendingUpdate).toBe('0.9.11');

    // applyUpdate should NOT have been called yet (still coalescing)
    expect(mockChecker.applyUpdate).not.toHaveBeenCalled();

    // Advance past the 5-minute coalescing delay → apply fires
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000);

    // Now applyUpdate should have been called exactly once
    expect(mockChecker.applyUpdate).toHaveBeenCalledTimes(1);

    const status = updater.getStatus();
    expect(status.lastAppliedVersion).toBe('0.9.11');
    expect(status.coalescingUntil).toBeNull();
  });

  it('coalescing timer resets correctly on each new version', async () => {
    let tickCount = 0;
    const mockChecker = createMockUpdateChecker({
      check: vi.fn().mockImplementation(async () => ({
        currentVersion: '0.9.8',
        latestVersion: `0.9.${9 + tickCount++}`,
        updateAvailable: true,
        checkedAt: new Date().toISOString(),
      })),
    });

    const updater = new AutoUpdater(
      mockChecker,
      createMockState(),
      tmpDir,
      { autoApply: true, applyDelayMinutes: 2 },
    );

    // Tick 1: starts timer
    await (updater as any).tick();
    const firstCoalescing = updater.getStatus().coalescingUntil;
    expect(firstCoalescing).not.toBeNull();

    // Tick 2: 1 minute later, new version → timer resets
    await vi.advanceTimersByTimeAsync(60_000);
    await (updater as any).tick();
    const secondCoalescing = updater.getStatus().coalescingUntil;
    expect(secondCoalescing).not.toBeNull();
    expect(new Date(secondCoalescing!).getTime()).toBeGreaterThan(new Date(firstCoalescing!).getTime());
  });

  it('applyDelayMinutes: 0 applies immediately (no coalescing)', async () => {
    const mockChecker = createMockUpdateChecker();

    const updater = new AutoUpdater(
      mockChecker,
      createMockState(),
      tmpDir,
      { autoApply: true, applyDelayMinutes: 0 },
    );

    await (updater as any).tick();

    // Should have applied immediately
    expect(mockChecker.applyUpdate).toHaveBeenCalledTimes(1);
    expect(updater.getStatus().lastAppliedVersion).toBe('0.9.9');
  });

  it('coalescing clears when update becomes unavailable', async () => {
    let updateAvailable = true;
    const mockChecker = createMockUpdateChecker({
      check: vi.fn().mockImplementation(async () => ({
        currentVersion: '0.9.8',
        latestVersion: '0.9.9',
        updateAvailable,
        checkedAt: new Date().toISOString(),
      })),
    });

    const updater = new AutoUpdater(
      mockChecker,
      createMockState(),
      tmpDir,
      { autoApply: true, applyDelayMinutes: 5 },
    );

    // Tick 1: starts coalescing
    await (updater as any).tick();
    expect(updater.getStatus().coalescingUntil).not.toBeNull();

    // Tick 2: update no longer available (already installed externally)
    updateAvailable = false;
    await (updater as any).tick();
    expect(updater.getStatus().coalescingUntil).toBeNull();
    expect(updater.getStatus().pendingUpdate).toBeNull();
  });

  it('pendingUpdateDetectedAt is set on first detection, not reset on new versions', async () => {
    let currentLatest = '0.9.9';
    const mockChecker = createMockUpdateChecker({
      check: vi.fn().mockImplementation(async () => ({
        currentVersion: '0.9.8',
        latestVersion: currentLatest,
        updateAvailable: true,
        checkedAt: new Date().toISOString(),
      })),
    });

    const updater = new AutoUpdater(
      mockChecker,
      createMockState(),
      tmpDir,
      { autoApply: true, applyDelayMinutes: 5 },
    );

    await (updater as any).tick();
    const firstDetected = updater.getStatus().pendingUpdateDetectedAt;
    expect(firstDetected).not.toBeNull();

    // New version but same detection time
    currentLatest = '0.9.10';
    await vi.advanceTimersByTimeAsync(60_000);
    await (updater as any).tick();
    expect(updater.getStatus().pendingUpdateDetectedAt).toBe(firstDetected);
  });
});

// ── Phase 2B: Session-Aware Restart Gating (UpdateGate) ─────────

describe('Phase 2B: UpdateGate', () => {
  it('allows restart when no sessions exist', () => {
    const gate = new UpdateGate();
    const sm = createMockSessionManager([]);
    const result = gate.canRestart(sm);
    expect(result.allowed).toBe(true);
  });

  it('allows restart when all sessions are idle', () => {
    const gate = new UpdateGate();
    const sm = createMockSessionManager([
      { name: 'session-1', topicId: 100 },
      { name: 'session-2', topicId: 200 },
    ]);
    const monitor = createMockSessionMonitor([
      { topicId: 100, sessionName: 'session-1', status: 'idle', idleMinutes: 30 },
      { topicId: 200, sessionName: 'session-2', status: 'idle', idleMinutes: 45 },
    ]);
    const result = gate.canRestart(sm, monitor);
    expect(result.allowed).toBe(true);
  });

  it('defers when active (healthy) sessions exist', () => {
    const gate = new UpdateGate();
    const sm = createMockSessionManager([
      { name: 'session-1', topicId: 100 },
    ]);
    const monitor = createMockSessionMonitor([
      { topicId: 100, sessionName: 'session-1', status: 'healthy', idleMinutes: 0 },
    ]);
    const result = gate.canRestart(sm, monitor);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('1 active session');
    expect(result.blockingSessions).toEqual(['session-1']);
    expect(result.retryInMs).toBeDefined();
  });

  it('allows restart when sessions are unresponsive (with warning)', () => {
    const gate = new UpdateGate();
    const sm = createMockSessionManager([
      { name: 'dead-session', topicId: 100 },
    ]);
    const monitor = createMockSessionMonitor([
      { topicId: 100, sessionName: 'dead-session', status: 'unresponsive', idleMinutes: 120 },
    ]);
    const result = gate.canRestart(sm, monitor);
    expect(result.allowed).toBe(true);
    expect(result.unresponsiveSessions).toEqual(['dead-session']);
  });

  it('allows restart when sessions are dead', () => {
    const gate = new UpdateGate();
    const sm = createMockSessionManager([
      { name: 'dead-session', topicId: 100 },
    ]);
    const monitor = createMockSessionMonitor([
      { topicId: 100, sessionName: 'dead-session', status: 'dead', idleMinutes: 999 },
    ]);
    const result = gate.canRestart(sm, monitor);
    expect(result.allowed).toBe(true);
  });

  it('treats sessions without health data as active (conservative)', () => {
    const gate = new UpdateGate();
    const sm = createMockSessionManager([
      { name: 'unknown-session', topicId: 100 },
    ]);
    // No health data for this session
    const monitor = createMockSessionMonitor([]);
    const result = gate.canRestart(sm, monitor);
    expect(result.allowed).toBe(false);
    expect(result.blockingSessions).toEqual(['unknown-session']);
  });

  it('works without session monitor (treats all as active)', () => {
    const gate = new UpdateGate();
    const sm = createMockSessionManager([
      { name: 'session-1', topicId: 100 },
    ]);
    const result = gate.canRestart(sm, null);
    expect(result.allowed).toBe(false);
    expect(result.blockingSessions).toEqual(['session-1']);
  });

  it('continues deferring past max deferral when healthy sessions exist (never kills healthy)', () => {
    const gate = new UpdateGate({ maxDeferralHours: 0.001 }); // ~3.6 seconds
    const sm = createMockSessionManager([
      { name: 'active-session', topicId: 100 },
    ]);
    const monitor = createMockSessionMonitor([
      { topicId: 100, sessionName: 'active-session', status: 'healthy', idleMinutes: 0 },
    ]);

    // First check: defers
    const r1 = gate.canRestart(sm, monitor);
    expect(r1.allowed).toBe(false);

    // Simulate time passing past max deferral
    (gate as any).deferralStartedAt = Date.now() - 4000; // 4 seconds ago > 3.6 second max

    // Second check: still defers — healthy sessions are never killed for an update
    const r2 = gate.canRestart(sm, monitor);
    expect(r2.allowed).toBe(false);
    expect(r2.blockingSessions).toEqual(['active-session']);
  });

  it('getStatus reports deferral state correctly', () => {
    const gate = new UpdateGate({ maxDeferralHours: 4 });
    const sm = createMockSessionManager([{ name: 's1' }]);
    const monitor = createMockSessionMonitor([
      { topicId: 100, sessionName: 's1', status: 'healthy', idleMinutes: 0 },
    ]);

    // Before any check
    expect(gate.getStatus().deferring).toBe(false);

    // After deferral
    gate.canRestart(sm, monitor);
    const status = gate.getStatus();
    expect(status.deferring).toBe(true);
    expect(status.deferralReason).toContain('active session');
    expect(status.maxDeferralHours).toBe(4);

    // After reset
    gate.reset();
    expect(gate.getStatus().deferring).toBe(false);
  });

  it('warning flags fire at correct thresholds', () => {
    const gate = new UpdateGate({
      maxDeferralHours: 1, // 60 min total
      firstWarningMinutes: 30, // T-30min
      finalWarningMinutes: 5,  // T-5min
    });
    const sm = createMockSessionManager([{ name: 's1' }]);
    const monitor = createMockSessionMonitor([
      { topicId: 100, sessionName: 's1', status: 'healthy', idleMinutes: 0 },
    ]);

    // Start deferral
    gate.canRestart(sm, monitor);
    expect(gate.shouldSendFirstWarning()).toBe(false);
    expect(gate.shouldSendFinalWarning()).toBe(false);

    // Fast-forward to T-30min (30 min elapsed of 60 min max)
    (gate as any).deferralStartedAt = Date.now() - 30 * 60_000;
    gate.canRestart(sm, monitor);
    expect(gate.shouldSendFirstWarning()).toBe(true);
    expect(gate.shouldSendFinalWarning()).toBe(false);

    // Fast-forward to T-5min (55 min elapsed of 60 min max)
    (gate as any).deferralStartedAt = Date.now() - 55 * 60_000;
    gate.canRestart(sm, monitor);
    expect(gate.shouldSendFinalWarning()).toBe(true);
  });

  it('mixed sessions: active blocks, idle does not', () => {
    const gate = new UpdateGate();
    const sm = createMockSessionManager([
      { name: 'active', topicId: 100 },
      { name: 'idle', topicId: 200 },
      { name: 'dead', topicId: 300 },
    ]);
    const monitor = createMockSessionMonitor([
      { topicId: 100, sessionName: 'active', status: 'healthy', idleMinutes: 0 },
      { topicId: 200, sessionName: 'idle', status: 'idle', idleMinutes: 60 },
      { topicId: 300, sessionName: 'dead', status: 'dead', idleMinutes: 999 },
    ]);
    const result = gate.canRestart(sm, monitor);
    expect(result.allowed).toBe(false);
    expect(result.blockingSessions).toEqual(['active']);
    // idle and dead don't appear as blocking
  });
});

// ── Phase 2B+E: Session-aware gating in AutoUpdater ─────────────

describe('Phase 2B+E: AutoUpdater with session gating', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gating-test-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defers restart when active sessions exist', async () => {
    const mockChecker = createMockUpdateChecker();
    const sm = createMockSessionManager([{ name: 'active-session' }]);
    const monitor = createMockSessionMonitor([
      { topicId: 100, sessionName: 'active-session', status: 'healthy', idleMinutes: 0 },
    ]);

    const updater = new AutoUpdater(
      mockChecker,
      createMockState(),
      tmpDir,
      { autoApply: true, applyDelayMinutes: 0, preRestartDelaySecs: 0 },
    );
    updater.setSessionDeps(sm, monitor);

    await (updater as any).tick();

    // Update was applied but restart should be deferred
    expect(updater.getStatus().lastAppliedVersion).toBe('0.9.9');
    // No restart-requested.json should exist (restart was deferred)
    const flagPath = path.join(tmpDir, 'state', 'restart-requested.json');
    expect(fs.existsSync(flagPath)).toBe(false);
  });

  it('proceeds with restart when no sessions exist', async () => {
    const mockChecker = createMockUpdateChecker();
    const sm = createMockSessionManager([]); // No sessions
    const monitor = createMockSessionMonitor([]);

    const updater = new AutoUpdater(
      mockChecker,
      createMockState(),
      tmpDir,
      { autoApply: true, applyDelayMinutes: 0, preRestartDelaySecs: 0 },
    );
    updater.setSessionDeps(sm, monitor);

    await (updater as any).tick();

    // Restart should have proceeded
    const flagPath = path.join(tmpDir, 'state', 'restart-requested.json');
    expect(fs.existsSync(flagPath)).toBe(true);
  });

  it('restarts without gating when no session manager is wired', async () => {
    const mockChecker = createMockUpdateChecker();

    const updater = new AutoUpdater(
      mockChecker,
      createMockState(),
      tmpDir,
      { autoApply: true, applyDelayMinutes: 0 },
    );
    // NOT calling setSessionDeps

    await (updater as any).tick();

    const flagPath = path.join(tmpDir, 'state', 'restart-requested.json');
    expect(fs.existsSync(flagPath)).toBe(true);
  });

  it('sends pre-restart notification when idle sessions exist', async () => {
    const telegram = createMockTelegram();
    const mockChecker = createMockUpdateChecker();
    const sm = createMockSessionManager([{ name: 'idle-session' }]);
    const monitor = createMockSessionMonitor([
      { topicId: 100, sessionName: 'idle-session', status: 'idle', idleMinutes: 30 },
    ]);

    const updater = new AutoUpdater(
      mockChecker,
      createMockState(),
      tmpDir,
      { autoApply: true, applyDelayMinutes: 0, preRestartDelaySecs: 0 },
      telegram,
    );
    updater.setSessionDeps(sm, monitor);

    await (updater as any).tick();

    // Should have notified about the upcoming restart
    const calls = (telegram.sendToTopic as any).mock.calls;
    const messages = calls.map((c: any[]) => c[1] as string);
    expect(messages.some((m: string) => m.includes('restarting in') || m.includes('will resume') || m.includes('Restarting to pick up') || m.includes('updated to'))).toBe(true);

    // Restart should have proceeded (idle sessions don't block)
    const flagPath = path.join(tmpDir, 'state', 'restart-requested.json');
    expect(fs.existsSync(flagPath)).toBe(true);
  });
});

// ── Phase 2C: Notify-only mode ──────────────────────────────────

describe('Phase 2C: Notify-only mode (autoApply: false)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-only-test-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not auto-apply when autoApply is false', async () => {
    const mockChecker = createMockUpdateChecker();
    const telegram = createMockTelegram();

    const updater = new AutoUpdater(
      mockChecker,
      createMockState(),
      tmpDir,
      { autoApply: false },
      telegram,
    );

    await (updater as any).tick();

    // Should NOT have applied
    expect(mockChecker.applyUpdate).not.toHaveBeenCalled();
    expect(updater.getStatus().pendingUpdate).toBe('0.9.9');

    // Should have sent notification with instructions
    const calls = (telegram.sendToTopic as any).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const msg = calls[0][1] as string;
    expect(msg).toContain('Auto-updates are off');
    expect(msg).toContain('apply the update');
  });

  it('does not re-notify on subsequent ticks for same version', async () => {
    const mockChecker = createMockUpdateChecker();
    const telegram = createMockTelegram();

    const updater = new AutoUpdater(
      mockChecker,
      createMockState(),
      tmpDir,
      { autoApply: false },
      telegram,
    );

    await (updater as any).tick();
    await (updater as any).tick();
    await (updater as any).tick();

    // Should have notified only once
    expect((telegram.sendToTopic as any).mock.calls.length).toBe(1);
  });

  it('manual apply via applyPendingUpdate() works', async () => {
    const mockChecker = createMockUpdateChecker();

    const updater = new AutoUpdater(
      mockChecker,
      createMockState(),
      tmpDir,
      { autoApply: false },
    );

    // tick detects the update but doesn't apply
    await (updater as any).tick();
    expect(mockChecker.applyUpdate).not.toHaveBeenCalled();

    // Manual trigger
    await updater.applyPendingUpdate();

    expect(mockChecker.applyUpdate).toHaveBeenCalledTimes(1);
    expect(updater.getStatus().lastAppliedVersion).toBe('0.9.9');
  });
});

// ── E2E: Full update cycle across all phases ────────────────────

describe('E2E: Full update cycle', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-update-test-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full cycle with active session: detect → coalesce → gate → defer → session ends → restart', async () => {
    const sessions = [{ name: 'user-session', topicId: 100 }];
    const health: SessionHealthEntry[] = [
      { topicId: 100, sessionName: 'user-session', status: 'healthy', idleMinutes: 0 },
    ];

    const sm = createMockSessionManager(sessions);
    const monitor = createMockSessionMonitor(health);
    const telegram = createMockTelegram();
    const mockChecker = createMockUpdateChecker();

    const updater = new AutoUpdater(
      mockChecker,
      createMockState(),
      tmpDir,
      { autoApply: true, applyDelayMinutes: 2, preRestartDelaySecs: 0 },
      telegram,
    );
    updater.setSessionDeps(sm, monitor);

    // Step 1: tick detects update → starts coalescing timer
    await (updater as any).tick();
    expect(updater.getStatus().coalescingUntil).not.toBeNull();
    expect(updater.getStatus().pendingUpdate).toBe('0.9.9');
    expect(mockChecker.applyUpdate).not.toHaveBeenCalled();

    // Step 2: coalescing timer expires → applies update
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 1000);
    expect(mockChecker.applyUpdate).toHaveBeenCalledTimes(1);
    expect(updater.getStatus().lastAppliedVersion).toBe('0.9.9');

    // Step 3: Gate checks sessions → defers (active session)
    const flagPath = path.join(tmpDir, 'state', 'restart-requested.json');
    expect(fs.existsSync(flagPath)).toBe(false); // Restart was deferred

    // Step 4: Session ends (simulate by making session manager return empty)
    (sm.listRunningSessions as any).mockReturnValue([]);
    (monitor.getStatus as any).mockReturnValue({ sessionHealth: [] });

    // Step 5: Deferral retry fires → gate allows → restart proceeds
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000);
    expect(fs.existsSync(flagPath)).toBe(true);

    // Verify restart request has plannedRestart: true (Phase 1A)
    const data = JSON.parse(fs.readFileSync(flagPath, 'utf-8'));
    expect(data.plannedRestart).toBe(true);
    expect(data.targetVersion).toBe('0.9.9');
  });

  it('full cycle with no sessions: detect → coalesce → immediate restart (silent)', async () => {
    const sm = createMockSessionManager([]);
    const monitor = createMockSessionMonitor([]);
    const mockChecker = createMockUpdateChecker();

    const updater = new AutoUpdater(
      mockChecker,
      createMockState(),
      tmpDir,
      { autoApply: true, applyDelayMinutes: 1, preRestartDelaySecs: 0 },
    );
    updater.setSessionDeps(sm, monitor);

    // Tick → coalescing
    await (updater as any).tick();
    expect(mockChecker.applyUpdate).not.toHaveBeenCalled();

    // Coalescing expires → apply + immediate restart (no sessions to gate)
    // Need extra time for the 2s notification delay inside gatedRestart
    await vi.advanceTimersByTimeAsync(60_000 + 5000);
    expect(mockChecker.applyUpdate).toHaveBeenCalledTimes(1);

    const flagPath = path.join(tmpDir, 'state', 'restart-requested.json');
    expect(fs.existsSync(flagPath)).toBe(true);

    const data = JSON.parse(fs.readFileSync(flagPath, 'utf-8'));
    expect(data.plannedRestart).toBe(true);
  });

  it('full cycle with rapid-fire publishes: 3 versions → single restart', async () => {
    let version = 9;
    const mockChecker = createMockUpdateChecker({
      check: vi.fn().mockImplementation(async () => ({
        currentVersion: '0.9.8',
        latestVersion: `0.9.${version}`,
        updateAvailable: true,
        checkedAt: new Date().toISOString(),
      })),
      applyUpdate: vi.fn().mockImplementation(async () => ({
        success: true,
        previousVersion: '0.9.8',
        newVersion: `0.9.${version}`,
        message: 'Updated',
        restartNeeded: true,
        healthCheck: 'skipped',
      })),
    });

    const sm = createMockSessionManager([]);
    const monitor = createMockSessionMonitor([]);

    const updater = new AutoUpdater(
      mockChecker,
      createMockState(),
      tmpDir,
      { autoApply: true, applyDelayMinutes: 3, preRestartDelaySecs: 0 },
    );
    updater.setSessionDeps(sm, monitor);

    // Version 0.9.9
    await (updater as any).tick();
    expect(updater.getStatus().pendingUpdate).toBe('0.9.9');

    // Version 0.9.10 (1 min later)
    version = 10;
    await vi.advanceTimersByTimeAsync(60_000);
    await (updater as any).tick();
    expect(updater.getStatus().pendingUpdate).toBe('0.9.10');

    // Version 0.9.11 (another minute later)
    version = 11;
    await vi.advanceTimersByTimeAsync(60_000);
    await (updater as any).tick();
    expect(updater.getStatus().pendingUpdate).toBe('0.9.11');

    // No apply yet
    expect(mockChecker.applyUpdate).not.toHaveBeenCalled();

    // Wait for coalescing to expire (3 min from last reset) + 5s for notification delay
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 5000);

    // Single apply
    expect(mockChecker.applyUpdate).toHaveBeenCalledTimes(1);

    // Restart happened
    const flagPath = path.join(tmpDir, 'state', 'restart-requested.json');
    expect(fs.existsSync(flagPath)).toBe(true);
  });

  it('state persists coalescing fields across save/load', async () => {
    const mockChecker = createMockUpdateChecker();

    const updater = new AutoUpdater(
      mockChecker,
      createMockState(),
      tmpDir,
      { autoApply: true, applyDelayMinutes: 5 },
    );

    await (updater as any).tick();

    // Check state file includes new fields
    const stateFile = path.join(tmpDir, 'state', 'auto-updater.json');
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(saved.pendingUpdateDetectedAt).toBeDefined();
    expect(saved.coalescingUntil).toBeDefined();
    expect(saved.pendingUpdate).toBe('0.9.9');

    // New instance loads persisted state
    const updater2 = new AutoUpdater(
      mockChecker,
      createMockState(),
      tmpDir,
      { autoApply: true, applyDelayMinutes: 5 },
    );

    const status = updater2.getStatus();
    expect(status.pendingUpdate).toBe('0.9.9');
    expect(status.pendingUpdateDetectedAt).toBeDefined();
  });

  it('getStatus includes all Phase 2 fields', async () => {
    const mockChecker = createMockUpdateChecker();

    const updater = new AutoUpdater(
      mockChecker,
      createMockState(),
      tmpDir,
      { autoApply: true, applyDelayMinutes: 5 },
    );

    const status = updater.getStatus();

    // Phase 2A fields
    expect(status).toHaveProperty('coalescingUntil');
    expect(status).toHaveProperty('pendingUpdateDetectedAt');

    // Phase 2B fields
    expect(status).toHaveProperty('deferralReason');
    expect(status).toHaveProperty('deferralElapsedMinutes');
    expect(status).toHaveProperty('maxDeferralHours');

    // Config includes new fields
    expect(status.config).toHaveProperty('applyDelayMinutes');
    expect(status.config).toHaveProperty('preRestartDelaySecs');
  });

  it('stop() cleans up all timers', async () => {
    const mockChecker = createMockUpdateChecker();

    const updater = new AutoUpdater(
      mockChecker,
      createMockState(),
      tmpDir,
      { autoApply: true, applyDelayMinutes: 5 },
    );

    // Start coalescing
    await (updater as any).tick();
    expect(updater.getStatus().coalescingUntil).not.toBeNull();

    // Stop clears everything
    updater.stop();
    expect(updater.getStatus().coalescingUntil).toBeNull();
  });
});
