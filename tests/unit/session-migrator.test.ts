/**
 * Unit tests for SessionMigrator.
 *
 * Tests the migration logic in isolation with mock deps.
 * No real file operations (uses tmp dirs), no real sessions.
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sm-unit-'));
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

describe('SessionMigrator', () => {
  let tmpDir: string;
  let migrator: SessionMigrator;

  beforeEach(() => {
    tmpDir = createTmpDir();
    migrator = new SessionMigrator({ stateDir: tmpDir });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Initialization ──

  describe('initialization', () => {
    it('creates state directory if missing', () => {
      const dir = path.join(tmpDir, 'nested', 'state');
      const m = new SessionMigrator({ stateDir: dir });
      expect(fs.existsSync(dir)).toBe(true);
    });

    it('starts with no migration in progress', () => {
      expect(migrator.isMigrating()).toBe(false);
    });

    it('returns empty status when no deps set', () => {
      const status = migrator.getMigrationStatus();
      expect(status.inProgress).toBe(false);
      expect(status.lastMigration).toBeNull();
      expect(status.history).toEqual([]);
    });

    it('returns configured thresholds', () => {
      const m = new SessionMigrator({
        stateDir: tmpDir,
        thresholds: { weeklyPercent: 90, fiveHourPercent: 85 },
      });
      expect(m.getThresholds().weeklyPercent).toBe(90);
      expect(m.getThresholds().fiveHourPercent).toBe(85);
      // Defaults still apply for unspecified thresholds
      expect(m.getThresholds().cooldownMs).toBe(10 * 60 * 1000);
    });
  });

  // ── Migration Triggering ──

  describe('shouldMigrate', () => {
    it('skips when no deps set', async () => {
      const result = await migrator.checkAndMigrate({
        percentUsed: 95,
        activeAccountEmail: 'test@example.com',
      });
      expect(result).toBe(false);
    });

    it('skips when below thresholds', async () => {
      const deps = createMockDeps();
      migrator.setDeps(deps);

      const result = await migrator.checkAndMigrate({
        percentUsed: 50,
        fiveHourPercent: 40,
        activeAccountEmail: 'test@example.com',
      });
      expect(result).toBe(false);
      expect(deps.pauseScheduler).not.toHaveBeenCalled();
    });

    it('triggers on weekly threshold', async () => {
      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'backup@test.io', weeklyPercent: 20 }),
        ]),
      });
      migrator.setDeps(deps);

      const result = await migrator.checkAndMigrate({
        percentUsed: 93,
        fiveHourPercent: 40,
        activeAccountEmail: 'active@test.io',
      });
      expect(result).toBe(true);
      expect(deps.pauseScheduler).toHaveBeenCalled();
      expect(deps.switchAccount).toHaveBeenCalledWith('backup@test.io');
    });

    it('triggers on 5-hour threshold', async () => {
      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'backup@test.io', weeklyPercent: 20 }),
        ]),
      });
      migrator.setDeps(deps);

      const result = await migrator.checkAndMigrate({
        percentUsed: 50,
        fiveHourPercent: 90,
        activeAccountEmail: 'active@test.io',
      });
      expect(result).toBe(true);
    });

    it('respects custom thresholds', async () => {
      const dir = path.join(tmpDir, 'custom');
      const m = new SessionMigrator({
        stateDir: dir,
        thresholds: { weeklyPercent: 80 },
      });

      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'backup@test.io', weeklyPercent: 20 }),
        ]),
      });
      m.setDeps(deps);

      const result = await m.checkAndMigrate({
        percentUsed: 82,
        activeAccountEmail: 'active@test.io',
      });
      expect(result).toBe(true);
    });
  });

  // ── Cooldown ──

  describe('cooldown', () => {
    it('respects cooldown after migration', async () => {
      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'backup@test.io', weeklyPercent: 20 }),
        ]),
      });
      migrator.setDeps(deps);

      // First migration
      await migrator.checkAndMigrate({
        percentUsed: 93,
        activeAccountEmail: 'active@test.io',
      });

      // Second migration attempt — should be blocked by cooldown
      const result = await migrator.checkAndMigrate({
        percentUsed: 93,
        activeAccountEmail: 'backup@test.io',
      });
      expect(result).toBe(false);
      // switchAccount only called once (from first migration)
      expect(deps.switchAccount).toHaveBeenCalledTimes(1);
    });
  });

  // ── Account Selection ──

  describe('selectMigrationTarget', () => {
    it('returns null with no deps', () => {
      expect(migrator.selectMigrationTarget()).toBeNull();
    });

    it('excludes active accounts', () => {
      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'active@test.io', isActive: true, weeklyPercent: 20 }),
        ]),
      });
      migrator.setDeps(deps);
      expect(migrator.selectMigrationTarget()).toBeNull();
    });

    it('excludes stale accounts', () => {
      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'stale@test.io', isStale: true, weeklyPercent: 10 }),
        ]),
      });
      migrator.setDeps(deps);
      expect(migrator.selectMigrationTarget()).toBeNull();
    });

    it('excludes accounts without tokens', () => {
      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'notoken@test.io', hasToken: false, weeklyPercent: 10 }),
        ]),
      });
      migrator.setDeps(deps);
      expect(migrator.selectMigrationTarget()).toBeNull();
    });

    it('excludes accounts with expired tokens', () => {
      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'expired@test.io', tokenExpired: true, weeklyPercent: 10 }),
        ]),
      });
      migrator.setDeps(deps);
      expect(migrator.selectMigrationTarget()).toBeNull();
    });

    it('excludes accounts without minimum headroom', () => {
      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'high@test.io', weeklyPercent: 85 }),
        ]),
      });
      migrator.setDeps(deps);
      expect(migrator.selectMigrationTarget()).toBeNull();
    });

    it('excludes accounts with high 5-hour rate', () => {
      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'rate@test.io', weeklyPercent: 30, fiveHourPercent: 75 }),
        ]),
      });
      migrator.setDeps(deps);
      expect(migrator.selectMigrationTarget()).toBeNull();
    });

    it('selects account with lowest usage', () => {
      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'high@test.io', weeklyPercent: 60 }),
          createAccountSnapshot({ email: 'low@test.io', weeklyPercent: 20 }),
          createAccountSnapshot({ email: 'mid@test.io', weeklyPercent: 40 }),
        ]),
      });
      migrator.setDeps(deps);
      expect(migrator.selectMigrationTarget()?.email).toBe('low@test.io');
    });

    it('tiebreaks by later reset time', () => {
      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({
            email: 'early@test.io',
            weeklyPercent: 30,
            weeklyResetsAt: '2026-03-01T00:00:00Z',
          }),
          createAccountSnapshot({
            email: 'late@test.io',
            weeklyPercent: 30,
            weeklyResetsAt: '2026-03-05T00:00:00Z',
          }),
        ]),
      });
      migrator.setDeps(deps);
      expect(migrator.selectMigrationTarget()?.email).toBe('late@test.io');
    });
  });

  // ── Migration Flow ──

  describe('executeMigration', () => {
    it('emits migration_no_target when no alternative', async () => {
      const events: string[] = [];
      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => []),
      });
      migrator.setDeps(deps);
      migrator.on('migration_no_target', () => events.push('no_target'));

      await migrator.checkAndMigrate({
        percentUsed: 95,
        activeAccountEmail: 'active@test.io',
      });

      expect(events).toContain('no_target');
      expect(deps.pauseScheduler).not.toHaveBeenCalled();
    });

    it('halts sessions, switches, and restarts on success', async () => {
      const session1 = createHaltableSession({ jobSlug: 'job-a' });
      const session2 = createHaltableSession({ jobSlug: 'job-b' });

      const deps = createMockDeps({
        listRunningSessions: vi.fn(() => [session1, session2]),
        isSessionAlive: vi.fn(() => false), // Sessions died from Ctrl+C
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'backup@test.io', weeklyPercent: 20 }),
        ]),
      });
      migrator.setDeps(deps);

      const events: MigrationEvent[] = [];
      migrator.on('migration_complete', (e: MigrationEvent) => events.push(e));

      await migrator.checkAndMigrate({
        percentUsed: 95,
        activeAccountEmail: 'active@test.io',
      });

      // Scheduler was paused and resumed
      expect(deps.pauseScheduler).toHaveBeenCalledTimes(1);
      expect(deps.resumeScheduler).toHaveBeenCalledTimes(1);

      // Ctrl+C sent to both sessions
      expect(deps.sendKey).toHaveBeenCalledTimes(2);

      // Account was switched
      expect(deps.switchAccount).toHaveBeenCalledWith('backup@test.io');

      // Jobs were respawned
      expect(deps.respawnJob).toHaveBeenCalledWith('job-a');
      expect(deps.respawnJob).toHaveBeenCalledWith('job-b');

      // Event emitted
      expect(events).toHaveLength(1);
      expect(events[0].result).toBe('success');
      expect(events[0].sessionsHalted).toEqual(['job-a', 'job-b']);
      expect(events[0].sessionsRestarted).toEqual(['job-a', 'job-b']);
    });

    it('kills sessions still alive after grace period', async () => {
      const session = createHaltableSession({ jobSlug: 'stubborn-job' });

      const deps = createMockDeps({
        listRunningSessions: vi.fn(() => [session]),
        isSessionAlive: vi.fn(() => true), // Still alive after Ctrl+C
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'backup@test.io', weeklyPercent: 20 }),
        ]),
      });
      migrator.setDeps(deps);

      // Use minimal grace period for fast test
      const m = new SessionMigrator({
        stateDir: path.join(tmpDir, 'grace'),
        thresholds: { gracePeriodMs: 10 },
      });
      m.setDeps(deps);

      await m.checkAndMigrate({
        percentUsed: 95,
        activeAccountEmail: 'active@test.io',
      });

      expect(deps.killSession).toHaveBeenCalledWith(session.id);
    });

    it('emits migration_partial when some restarts fail', async () => {
      const session1 = createHaltableSession({ jobSlug: 'job-ok' });
      const session2 = createHaltableSession({ jobSlug: 'job-fail' });

      const deps = createMockDeps({
        listRunningSessions: vi.fn(() => [session1, session2]),
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'backup@test.io', weeklyPercent: 20 }),
        ]),
        respawnJob: vi.fn(async (slug: string) => {
          if (slug === 'job-fail') throw new Error('respawn failed');
        }),
      });
      migrator.setDeps(deps);

      const events: MigrationEvent[] = [];
      migrator.on('migration_partial', (e: MigrationEvent) => events.push(e));

      await migrator.checkAndMigrate({
        percentUsed: 95,
        activeAccountEmail: 'active@test.io',
      });

      expect(events).toHaveLength(1);
      expect(events[0].result).toBe('partial');
      expect(events[0].sessionsRestarted).toEqual(['job-ok']);
    });

    it('rolls back when account switch fails', async () => {
      const session = createHaltableSession({ jobSlug: 'job-a' });

      const deps = createMockDeps({
        listRunningSessions: vi.fn(() => [session]),
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'backup@test.io', weeklyPercent: 20 }),
        ]),
        switchAccount: vi.fn(async () => ({
          success: false,
          message: 'Token expired',
        })),
      });
      migrator.setDeps(deps);

      const rollbackEvents: MigrationEvent[] = [];
      migrator.on('migration_rollback', (e: MigrationEvent) => rollbackEvents.push(e));

      await migrator.checkAndMigrate({
        percentUsed: 95,
        activeAccountEmail: 'active@test.io',
      });

      // Rollback: sessions restarted on original account
      expect(deps.respawnJob).toHaveBeenCalledWith('job-a');
      expect(deps.resumeScheduler).toHaveBeenCalled();

      // Rollback event emitted
      expect(rollbackEvents).toHaveLength(1);
      expect(rollbackEvents[0].result).toBe('rolled_back');
    });

    it('resumes scheduler even on error', async () => {
      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'backup@test.io', weeklyPercent: 20 }),
        ]),
        switchAccount: vi.fn(async () => { throw new Error('boom'); }),
      });
      migrator.setDeps(deps);

      const failEvents: MigrationEvent[] = [];
      migrator.on('migration_failed', (e: MigrationEvent) => failEvents.push(e));

      await migrator.checkAndMigrate({
        percentUsed: 95,
        activeAccountEmail: 'active@test.io',
      });

      expect(deps.resumeScheduler).toHaveBeenCalled();
      expect(failEvents).toHaveLength(1);
      expect(failEvents[0].result).toBe('failed');
    });
  });

  // ── File Lock ──

  describe('file lock', () => {
    it('prevents concurrent migrations', async () => {
      // Write a fresh lock file
      const lockPath = path.join(tmpDir, 'migration.lock');
      fs.writeFileSync(lockPath, JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }));

      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'backup@test.io', weeklyPercent: 20 }),
        ]),
      });
      migrator.setDeps(deps);

      const result = await migrator.checkAndMigrate({
        percentUsed: 95,
        activeAccountEmail: 'active@test.io',
      });

      expect(result).toBe(false);
      expect(deps.switchAccount).not.toHaveBeenCalled();
    });

    it('takes over stale locks', async () => {
      // Write a stale lock (> 10 min old)
      const lockPath = path.join(tmpDir, 'migration.lock');
      fs.writeFileSync(lockPath, JSON.stringify({
        pid: 99999,
        acquiredAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      }));

      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'backup@test.io', weeklyPercent: 20 }),
        ]),
      });
      migrator.setDeps(deps);

      const result = await migrator.checkAndMigrate({
        percentUsed: 95,
        activeAccountEmail: 'active@test.io',
      });

      expect(result).toBe(true);
    });

    it('releases lock after migration', async () => {
      const lockPath = path.join(tmpDir, 'migration.lock');

      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'backup@test.io', weeklyPercent: 20 }),
        ]),
      });
      migrator.setDeps(deps);

      await migrator.checkAndMigrate({
        percentUsed: 95,
        activeAccountEmail: 'active@test.io',
      });

      expect(fs.existsSync(lockPath)).toBe(false);
    });
  });

  // ── State Persistence ──

  describe('state persistence', () => {
    it('persists migration history to disk', async () => {
      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'backup@test.io', weeklyPercent: 20 }),
        ]),
      });
      migrator.setDeps(deps);

      await migrator.checkAndMigrate({
        percentUsed: 95,
        activeAccountEmail: 'active@test.io',
      });

      const historyPath = path.join(tmpDir, 'migration-history.json');
      expect(fs.existsSync(historyPath)).toBe(true);
      const history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      expect(history.migrations).toHaveLength(1);
      expect(history.lastMigration.result).toBe('success');
    });

    it('persists migration state during flow', async () => {
      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'backup@test.io', weeklyPercent: 20 }),
        ]),
      });
      migrator.setDeps(deps);

      await migrator.checkAndMigrate({
        percentUsed: 95,
        activeAccountEmail: 'active@test.io',
      });

      const statePath = path.join(tmpDir, 'migration-state.json');
      expect(fs.existsSync(statePath)).toBe(true);
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      expect(state.status).toBe('complete');
    });

    it('new instance reads history from previous', async () => {
      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'backup@test.io', weeklyPercent: 20 }),
        ]),
      });
      migrator.setDeps(deps);

      await migrator.checkAndMigrate({
        percentUsed: 95,
        activeAccountEmail: 'active@test.io',
      });

      // Create new instance reading same state dir
      const m2 = new SessionMigrator({ stateDir: tmpDir });
      const status = m2.getMigrationStatus();
      expect(status.lastMigration).not.toBeNull();
      expect(status.history).toHaveLength(1);
    });
  });

  // ── Crash Recovery ──

  describe('crash recovery', () => {
    it('detects incomplete migration on startup', () => {
      // Write an incomplete state
      fs.writeFileSync(
        path.join(tmpDir, 'migration-state.json'),
        JSON.stringify({
          status: 'switching',
          startedAt: new Date().toISOString(),
          sourceAccount: 'old@test.io',
          targetAccount: 'new@test.io',
          haltedSessions: [{ sessionId: 'abc', jobSlug: 'test-job', haltedAt: new Date().toISOString() }],
          restartedSessions: [],
        }),
      );

      const m = new SessionMigrator({ stateDir: tmpDir });
      // Should report as migrating (recovery pending)
      expect(m.isMigrating()).toBe(true);
    });

    it('completeRecovery restarts unfinished sessions', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'migration-state.json'),
        JSON.stringify({
          status: 'restarting',
          sourceAccount: 'old@test.io',
          targetAccount: 'new@test.io',
          haltedSessions: [
            { sessionId: 'a', jobSlug: 'job-a', haltedAt: new Date().toISOString() },
            { sessionId: 'b', jobSlug: 'job-b', haltedAt: new Date().toISOString() },
          ],
          restartedSessions: [
            { sessionId: 'a', jobSlug: 'job-a', startedAt: new Date().toISOString() },
          ],
        }),
      );

      const m = new SessionMigrator({ stateDir: tmpDir });
      const deps = createMockDeps();
      m.setDeps(deps);
      await m.completeRecovery();

      // Only job-b should be restarted (job-a already was)
      expect(deps.respawnJob).toHaveBeenCalledTimes(1);
      expect(deps.respawnJob).toHaveBeenCalledWith('job-b');

      // State should be complete now
      expect(m.isMigrating()).toBe(false);
    });

    it('does nothing for idle/complete/failed states', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'migration-state.json'),
        JSON.stringify({
          status: 'complete',
          sourceAccount: 'old@test.io',
          targetAccount: 'new@test.io',
          haltedSessions: [],
          restartedSessions: [],
        }),
      );

      const m = new SessionMigrator({ stateDir: tmpDir });
      const deps = createMockDeps();
      m.setDeps(deps);
      await m.completeRecovery();

      expect(deps.respawnJob).not.toHaveBeenCalled();
    });
  });

  // ── Events ──

  describe('events', () => {
    it('emits state_changed through migration lifecycle', async () => {
      const stateChanges: string[] = [];
      const deps = createMockDeps({
        listRunningSessions: vi.fn(() => [createHaltableSession()]),
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'backup@test.io', weeklyPercent: 20 }),
        ]),
      });

      // Use minimal grace period
      const m = new SessionMigrator({
        stateDir: path.join(tmpDir, 'events'),
        thresholds: { gracePeriodMs: 10 },
      });
      m.setDeps(deps);
      m.on('state_changed', (state: { status: string }) => {
        stateChanges.push(state.status);
      });

      await m.checkAndMigrate({
        percentUsed: 95,
        activeAccountEmail: 'active@test.io',
      });

      // Should see: halting → switching → restarting
      expect(stateChanges).toContain('halting');
      expect(stateChanges).toContain('switching');
      expect(stateChanges).toContain('restarting');
    });

    it('emits migration_started with correct info', async () => {
      const startEvents: Array<{ reason: string; sourceAccount: string; targetAccount: string }> = [];
      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'backup@test.io', weeklyPercent: 20 }),
        ]),
      });
      migrator.setDeps(deps);
      migrator.on('migration_started', (e) => startEvents.push(e));

      await migrator.checkAndMigrate({
        percentUsed: 95,
        activeAccountEmail: 'active@test.io',
      });

      expect(startEvents).toHaveLength(1);
      expect(startEvents[0].sourceAccount).toBe('active@test.io');
      expect(startEvents[0].targetAccount).toBe('backup@test.io');
      expect(startEvents[0].reason).toContain('weekly quota');
    });

    it('records duration in migration events', async () => {
      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'backup@test.io', weeklyPercent: 20 }),
        ]),
      });
      migrator.setDeps(deps);

      const events: MigrationEvent[] = [];
      migrator.on('migration_complete', (e: MigrationEvent) => events.push(e));

      await migrator.checkAndMigrate({
        percentUsed: 95,
        activeAccountEmail: 'active@test.io',
      });

      expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(events[0].durationMs).toBeLessThan(10000);
    });
  });
});
