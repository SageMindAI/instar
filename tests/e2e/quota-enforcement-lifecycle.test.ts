/**
 * E2E lifecycle tests — full quota enforcement scenarios.
 *
 * Tests the complete lifecycle from initial quota warning through
 * enforced pause to emergency kill, including recovery and race
 * condition safety.
 *
 * Uses real file operations and real SessionMigrator.
 * Mocks only tmux/session operations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionMigrator } from '../../src/monitoring/SessionMigrator.js';
import type {
  SessionMigratorDeps,
  AccountSnapshot,
  HaltableSession,
  MigrationEvent,
} from '../../src/monitoring/SessionMigrator.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Helpers ──────────────────────────────────────────────────────────

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qe-e2e-'));
}

function createMockDeps(overrides?: Partial<SessionMigratorDeps>): SessionMigratorDeps {
  return {
    listRunningSessions: vi.fn(() => []),
    sendKey: vi.fn(() => true),
    killSession: vi.fn(() => true),
    isSessionAlive: vi.fn(() => false),
    pauseScheduler: vi.fn(),
    resumeScheduler: vi.fn(),
    respawnJob: vi.fn(async () => {}),
    getAccountStatuses: vi.fn(() => []),
    switchAccount: vi.fn(async () => ({ success: true, message: 'ok' })),
    ...overrides,
  };
}

function createAccountSnapshot(overrides?: Partial<AccountSnapshot>): AccountSnapshot {
  return {
    email: 'test@example.com',
    name: 'Test',
    isActive: false,
    hasToken: true,
    tokenExpired: false,
    isStale: false,
    weeklyPercent: 30,
    fiveHourPercent: 20,
    weeklyResetsAt: null,
    ...overrides,
  };
}

function createHaltableSession(overrides?: Partial<HaltableSession>): HaltableSession {
  return {
    id: `session-${Math.random().toString(36).slice(2, 8)}`,
    tmuxSession: `test-session-${Math.random().toString(36).slice(2, 8)}`,
    jobSlug: 'test-job',
    name: 'test session',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Quota Enforcement Lifecycle (E2E)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. Full quota exhaustion scenario ──

  it('full lifecycle: 88% warning → 90% pause → 95% kill', async () => {
    const migrator = new SessionMigrator({
      stateDir: tmpDir,
      thresholds: {
        gracePeriodMs: 10,
        cooldownMs: 0, // No cooldown between steps for test
      },
    });

    const sessions = [
      createHaltableSession({ id: 's1', tmuxSession: 'tmux-1', jobSlug: 'worker-a' }),
      createHaltableSession({ id: 's2', tmuxSession: 'tmux-2', jobSlug: 'worker-b' }),
    ];

    const deps = createMockDeps({
      getAccountStatuses: vi.fn(() => []), // No alternatives
      listRunningSessions: vi.fn(() => sessions),
      isSessionAlive: vi.fn(() => true), // Sessions survive Ctrl+C
    });
    migrator.setDeps(deps);

    // Track all events in order
    const eventLog: Array<{ type: string; data: any }> = [];
    migrator.on('migration_no_target', (e) => eventLog.push({ type: 'no_target', data: e }));
    migrator.on('enforced_pause', (e) => eventLog.push({ type: 'enforced_pause', data: e }));
    migrator.on('enforced_kill', (e) => eventLog.push({ type: 'enforced_kill', data: e }));

    // Step 1: 88% → migration_no_target (warning)
    await migrator.checkAndMigrate({
      percentUsed: 50,
      fiveHourPercent: 88,
      activeAccountEmail: 'active@test.io',
    });
    expect(eventLog).toHaveLength(1);
    expect(eventLog[0].type).toBe('no_target');
    expect(deps.pauseScheduler).not.toHaveBeenCalled();

    // Step 2: 90% → enforced_pause (Ctrl+C + pause scheduler)
    await migrator.checkAndMigrate({
      percentUsed: 50,
      fiveHourPercent: 90,
      activeAccountEmail: 'active@test.io',
    });
    expect(eventLog).toHaveLength(2);
    expect(eventLog[1].type).toBe('enforced_pause');
    expect(eventLog[1].data.sessionsSignaled).toBe(2);
    expect(deps.pauseScheduler).toHaveBeenCalledTimes(1);
    expect(deps.sendKey).toHaveBeenCalledTimes(2);

    // Step 3: 95% → enforced_kill (kill all sessions)
    // Note: cooldown is bypassed because last event was enforced_pause
    await migrator.checkAndMigrate({
      percentUsed: 50,
      fiveHourPercent: 95,
      activeAccountEmail: 'active@test.io',
    });
    expect(eventLog).toHaveLength(3);
    expect(eventLog[2].type).toBe('enforced_kill');
    expect(eventLog[2].data.sessionsKilled).toEqual(['worker-a', 'worker-b']);

    // Scheduler was paused (pause called in both enforced_pause and enforced_kill)
    expect(deps.pauseScheduler).toHaveBeenCalledTimes(2);

    // All sessions killed
    expect(deps.killSession).toHaveBeenCalledWith('s1');
    expect(deps.killSession).toHaveBeenCalledWith('s2');

    // Scheduler NOT resumed (enforcement leaves it paused)
    expect(deps.resumeScheduler).not.toHaveBeenCalled();

    // Verify events emitted in correct order
    expect(eventLog.map(e => e.type)).toEqual([
      'no_target',
      'enforced_pause',
      'enforced_kill',
    ]);
  });

  // ── 2. Enforcement then recovery ──

  it('after enforced_kill, system can recover when new account becomes available', async () => {
    const migrator = new SessionMigrator({
      stateDir: tmpDir,
      thresholds: {
        gracePeriodMs: 10,
        cooldownMs: 0,
      },
    });

    const session = createHaltableSession({ id: 's1', tmuxSession: 'tmux-1', jobSlug: 'worker' });
    let accountsAvailable: AccountSnapshot[] = [];

    const deps = createMockDeps({
      getAccountStatuses: vi.fn(() => accountsAvailable),
      listRunningSessions: vi.fn(() => [session]),
      isSessionAlive: vi.fn(() => true),
    });
    migrator.setDeps(deps);

    // First: 95% with no alternative → enforced_kill
    const killEvents: unknown[] = [];
    migrator.on('enforced_kill', (e) => killEvents.push(e));

    await migrator.checkAndMigrate({
      percentUsed: 50,
      fiveHourPercent: 96,
      activeAccountEmail: 'active@test.io',
    });
    expect(killEvents).toHaveLength(1);
    expect(deps.pauseScheduler).toHaveBeenCalled();

    // Now simulate a new account becoming available
    accountsAvailable = [
      createAccountSnapshot({ email: 'backup@test.io', weeklyPercent: 10, fiveHourPercent: 5 }),
    ];

    // Create a fresh migrator to simulate system restart/recovery
    const recoveredMigrator = new SessionMigrator({
      stateDir: tmpDir,
      thresholds: {
        gracePeriodMs: 10,
        cooldownMs: 0,
      },
    });

    const newSessions = [
      createHaltableSession({ id: 's2', tmuxSession: 'tmux-2', jobSlug: 'new-worker' }),
    ];
    const recoveryDeps = createMockDeps({
      getAccountStatuses: vi.fn(() => accountsAvailable),
      listRunningSessions: vi.fn(() => newSessions),
    });
    recoveredMigrator.setDeps(recoveryDeps);

    const completeEvents: MigrationEvent[] = [];
    recoveredMigrator.on('migration_complete', (e) => completeEvents.push(e));

    // With a backup available and high quota → normal migration should work
    const result = await recoveredMigrator.checkAndMigrate({
      percentUsed: 95,
      fiveHourPercent: 96,
      activeAccountEmail: 'active@test.io',
    });

    expect(result).toBe(true);
    expect(recoveryDeps.switchAccount).toHaveBeenCalledWith('backup@test.io');
  });

  // ── 3. Race condition safety: two rapid calls at 95% ──

  it('lock prevents double enforcement from concurrent calls', async () => {
    const migrator = new SessionMigrator({
      stateDir: tmpDir,
      thresholds: {
        gracePeriodMs: 50, // Slightly longer to create overlap opportunity
        cooldownMs: 0,
      },
    });

    const session = createHaltableSession({ id: 's1', tmuxSession: 'tmux-1', jobSlug: 'worker' });
    const killEvents: unknown[] = [];

    const deps = createMockDeps({
      getAccountStatuses: vi.fn(() => []),
      listRunningSessions: vi.fn(() => [session]),
      isSessionAlive: vi.fn(() => true),
    });
    migrator.setDeps(deps);
    migrator.on('enforced_kill', (e) => killEvents.push(e));

    // Fire two calls simultaneously
    const [result1, result2] = await Promise.all([
      migrator.checkAndMigrate({
        percentUsed: 50,
        fiveHourPercent: 96,
        activeAccountEmail: 'active@test.io',
      }),
      migrator.checkAndMigrate({
        percentUsed: 50,
        fiveHourPercent: 97,
        activeAccountEmail: 'active@test.io',
      }),
    ]);

    // One should fire, one should be blocked by the lock
    const results = [result1, result2];
    expect(results).toContain(false);

    // Only one enforced_kill event should fire
    expect(killEvents).toHaveLength(1);
  });

  // ── 4. History preservation ──

  it('multiple enforcement events are all recorded in history', async () => {
    const migrator = new SessionMigrator({
      stateDir: tmpDir,
      thresholds: {
        gracePeriodMs: 10,
        cooldownMs: 0,
      },
    });

    const session = createHaltableSession({ id: 's1', tmuxSession: 'tmux-1', jobSlug: 'worker' });

    const deps = createMockDeps({
      getAccountStatuses: vi.fn(() => []),
      listRunningSessions: vi.fn(() => [session]),
      isSessionAlive: vi.fn(() => true),
    });
    migrator.setDeps(deps);

    // Event 1: 88% → no_alternative
    await migrator.checkAndMigrate({
      percentUsed: 50,
      fiveHourPercent: 88,
      activeAccountEmail: 'active@test.io',
    });

    // Event 2: 91% → enforced_pause
    await migrator.checkAndMigrate({
      percentUsed: 50,
      fiveHourPercent: 91,
      activeAccountEmail: 'active@test.io',
    });

    // Event 3: 96% → enforced_kill (cooldown bypassed — last was enforced_pause)
    await migrator.checkAndMigrate({
      percentUsed: 50,
      fiveHourPercent: 96,
      activeAccountEmail: 'active@test.io',
    });

    // Verify history
    const status = migrator.getMigrationStatus();
    expect(status.history).toHaveLength(3);
    expect(status.history[0].result).toBe('no_alternative');
    expect(status.history[1].result).toBe('enforced_pause');
    expect(status.history[2].result).toBe('enforced_kill');

    // lastMigration should be the most recent
    expect(status.lastMigration!.result).toBe('enforced_kill');

    // All events have timestamps
    for (const event of status.history) {
      expect(event.triggeredAt).toBeTruthy();
      expect(event.completedAt).toBeTruthy();
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }

    // Verify history persists across instances
    const migrator2 = new SessionMigrator({ stateDir: tmpDir });
    const status2 = migrator2.getMigrationStatus();
    expect(status2.history).toHaveLength(3);
    expect(status2.history.map(e => e.result)).toEqual([
      'no_alternative',
      'enforced_pause',
      'enforced_kill',
    ]);
  });

  // ── 5. enforced_kill records halted session slugs ──

  it('enforced_kill event records correct session slugs in sessionsHalted', async () => {
    const migrator = new SessionMigrator({
      stateDir: tmpDir,
      thresholds: {
        gracePeriodMs: 10,
        cooldownMs: 0,
      },
    });

    const sessions = [
      createHaltableSession({ id: 's1', tmuxSession: 'tmux-1', jobSlug: 'alpha-job' }),
      createHaltableSession({ id: 's2', tmuxSession: 'tmux-2', jobSlug: 'beta-job' }),
      createHaltableSession({ id: 's3', tmuxSession: 'tmux-3', jobSlug: undefined, name: 'unnamed-session' }),
    ];

    const deps = createMockDeps({
      getAccountStatuses: vi.fn(() => []),
      listRunningSessions: vi.fn(() => sessions),
      isSessionAlive: vi.fn(() => false), // Sessions died from Ctrl+C
    });
    migrator.setDeps(deps);

    await migrator.checkAndMigrate({
      percentUsed: 50,
      fiveHourPercent: 98,
      activeAccountEmail: 'active@test.io',
    });

    const status = migrator.getMigrationStatus();
    const lastEvent = status.lastMigration!;
    expect(lastEvent.result).toBe('enforced_kill');
    // Should use jobSlug when available, name as fallback
    expect(lastEvent.sessionsHalted).toEqual(['alpha-job', 'beta-job', 'unnamed-session']);
  });

  // ── 6. Sessions that die from Ctrl+C are not force-killed ──

  it('sessions that die from Ctrl+C during enforced_kill are not force-killed', async () => {
    const migrator = new SessionMigrator({
      stateDir: tmpDir,
      thresholds: { gracePeriodMs: 10, cooldownMs: 0 },
    });

    const session1 = createHaltableSession({ id: 's1', tmuxSession: 'tmux-1', jobSlug: 'job-1' });
    const session2 = createHaltableSession({ id: 's2', tmuxSession: 'tmux-2', jobSlug: 'job-2' });

    // Session 1 dies from Ctrl+C, session 2 survives
    const aliveMap = new Map<string, boolean>([
      [session1.tmuxSession, false],
      [session2.tmuxSession, true],
    ]);

    const deps = createMockDeps({
      getAccountStatuses: vi.fn(() => []),
      listRunningSessions: vi.fn(() => [session1, session2]),
      isSessionAlive: vi.fn((tmux) => aliveMap.get(tmux) ?? false),
    });
    migrator.setDeps(deps);

    await migrator.checkAndMigrate({
      percentUsed: 50,
      fiveHourPercent: 96,
      activeAccountEmail: 'active@test.io',
    });

    // Only session 2 (the survivor) should be force-killed
    expect(deps.killSession).toHaveBeenCalledTimes(1);
    expect(deps.killSession).toHaveBeenCalledWith('s2');
    // Session 1 was NOT force-killed (it died from Ctrl+C)
    expect(deps.killSession).not.toHaveBeenCalledWith('s1');
  });

  // ── 7. Normal migration path at 95% when backup exists (no enforcement) ──

  it('at 95% with backup account, normal migration runs instead of enforcement', async () => {
    const migrator = new SessionMigrator({
      stateDir: tmpDir,
      thresholds: { gracePeriodMs: 10, cooldownMs: 0 },
    });

    const session = createHaltableSession({ id: 's1', tmuxSession: 'tmux-1', jobSlug: 'worker' });
    const completeEvents: MigrationEvent[] = [];
    const killEvents: unknown[] = [];

    const deps = createMockDeps({
      getAccountStatuses: vi.fn(() => [
        createAccountSnapshot({ email: 'backup@test.io', weeklyPercent: 15, fiveHourPercent: 10 }),
      ]),
      listRunningSessions: vi.fn(() => [session]),
    });
    migrator.setDeps(deps);
    migrator.on('migration_complete', (e) => completeEvents.push(e));
    migrator.on('enforced_kill', (e) => killEvents.push(e));

    const result = await migrator.checkAndMigrate({
      percentUsed: 50,
      fiveHourPercent: 96,
      activeAccountEmail: 'active@test.io',
    });

    expect(result).toBe(true);
    expect(completeEvents).toHaveLength(1);
    expect(killEvents).toHaveLength(0);
    expect(deps.switchAccount).toHaveBeenCalledWith('backup@test.io');
    expect(deps.respawnJob).toHaveBeenCalledWith('worker');
  });
});
