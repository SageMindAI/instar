/**
 * Unit tests for quota enforcement tiers in SessionMigrator.
 *
 * When no alternative account is available, the migrator enforces tiered
 * protection based on 5-hour rate:
 * - Below 90%: emits migration_no_target (warning only)
 * - 90-94%: emits enforced_pause — Ctrl+C to all sessions, pause scheduler
 * - 95%+: emits enforced_kill — full halt (Ctrl+C + wait + kill), pause scheduler
 *
 * Cooldown bypass: if last event was enforced_pause and now at 95%+, cooldown is skipped.
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

// ── Helpers (copied from session-migrator.test.ts) ───────────────────

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qe-unit-'));
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

describe('Quota Enforcement Tiers', () => {
  let tmpDir: string;
  let migrator: SessionMigrator;

  beforeEach(() => {
    tmpDir = createTmpDir();
    migrator = new SessionMigrator({
      stateDir: tmpDir,
      thresholds: { gracePeriodMs: 10 }, // Minimal grace period for fast tests
    });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. Below 90%, no alternative → migration_no_target only ──

  describe('below 90% with no alternative', () => {
    it('emits migration_no_target, does NOT pause scheduler or kill sessions', async () => {
      const events: Array<{ reason: string; sourceAccount: string }> = [];
      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => []),
        listRunningSessions: vi.fn(() => [createHaltableSession()]),
      });
      migrator.setDeps(deps);
      migrator.on('migration_no_target', (e) => events.push(e));

      const result = await migrator.checkAndMigrate({
        percentUsed: 50,
        fiveHourPercent: 89, // Above 88% threshold but below 90% enforcement
        activeAccountEmail: 'active@test.io',
      });

      expect(result).toBe(false);
      expect(events).toHaveLength(1);
      expect(events[0].sourceAccount).toBe('active@test.io');
      expect(deps.pauseScheduler).not.toHaveBeenCalled();
      expect(deps.sendKey).not.toHaveBeenCalled();
      expect(deps.killSession).not.toHaveBeenCalled();
    });
  });

  // ── 2. At 90%, no alternative → enforced_pause ──

  describe('at 90% with no alternative', () => {
    it('emits enforced_pause, sends Ctrl+C to sessions, pauses scheduler, does NOT kill', async () => {
      const session1 = createHaltableSession({ id: 's1', tmuxSession: 'tmux-1', jobSlug: 'job-a' });
      const session2 = createHaltableSession({ id: 's2', tmuxSession: 'tmux-2', jobSlug: 'job-b' });
      const pauseEvents: Array<{ reason: string; fiveHourPercent: number; sessionsSignaled: number }> = [];

      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => []),
        listRunningSessions: vi.fn(() => [session1, session2]),
      });
      migrator.setDeps(deps);
      migrator.on('enforced_pause', (e) => pauseEvents.push(e));

      await migrator.checkAndMigrate({
        percentUsed: 50,
        fiveHourPercent: 90,
        activeAccountEmail: 'active@test.io',
      });

      // Ctrl+C sent to each session
      expect(deps.sendKey).toHaveBeenCalledTimes(2);
      expect(deps.sendKey).toHaveBeenCalledWith(session1.tmuxSession, 'C-c');
      expect(deps.sendKey).toHaveBeenCalledWith(session2.tmuxSession, 'C-c');

      // Scheduler paused
      expect(deps.pauseScheduler).toHaveBeenCalledTimes(1);

      // Sessions NOT killed (kill is for 95%+)
      expect(deps.killSession).not.toHaveBeenCalled();

      // Event emitted with correct payload
      expect(pauseEvents).toHaveLength(1);
      expect(pauseEvents[0].fiveHourPercent).toBe(90);
      expect(pauseEvents[0].sessionsSignaled).toBe(2);
    });
  });

  // ── 3. At 95%, no alternative → enforced_kill ──

  describe('at 95% with no alternative', () => {
    it('emits enforced_kill, pauses scheduler, performs full halt', async () => {
      const session1 = createHaltableSession({ id: 's1', tmuxSession: 'tmux-1', jobSlug: 'job-a' });
      const session2 = createHaltableSession({ id: 's2', tmuxSession: 'tmux-2', jobSlug: 'job-b' });
      const killEvents: Array<{ reason: string; fiveHourPercent: number; sessionsKilled: string[] }> = [];

      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => []),
        listRunningSessions: vi.fn(() => [session1, session2]),
        isSessionAlive: vi.fn(() => true), // Sessions survive Ctrl+C → must be killed
      });
      migrator.setDeps(deps);
      migrator.on('enforced_kill', (e) => killEvents.push(e));

      await migrator.checkAndMigrate({
        percentUsed: 50,
        fiveHourPercent: 95,
        activeAccountEmail: 'active@test.io',
      });

      // Scheduler paused
      expect(deps.pauseScheduler).toHaveBeenCalledTimes(1);

      // Full halt: Ctrl+C sent first, then kill for survivors
      expect(deps.sendKey).toHaveBeenCalledTimes(2);
      expect(deps.killSession).toHaveBeenCalledTimes(2);
      expect(deps.killSession).toHaveBeenCalledWith(session1.id);
      expect(deps.killSession).toHaveBeenCalledWith(session2.id);

      // Event emitted
      expect(killEvents).toHaveLength(1);
      expect(killEvents[0].fiveHourPercent).toBe(95);
      expect(killEvents[0].sessionsKilled).toEqual(['job-a', 'job-b']);
    });
  });

  // ── 4. At 100%, no alternative → same as 95% ──

  describe('at 100% with no alternative', () => {
    it('triggers enforced_kill same as 95%', async () => {
      const session = createHaltableSession({ id: 's1', tmuxSession: 'tmux-1', jobSlug: 'job-x' });
      const killEvents: Array<{ fiveHourPercent: number; sessionsKilled: string[] }> = [];

      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => []),
        listRunningSessions: vi.fn(() => [session]),
        isSessionAlive: vi.fn(() => true),
      });
      migrator.setDeps(deps);
      migrator.on('enforced_kill', (e) => killEvents.push(e));

      await migrator.checkAndMigrate({
        percentUsed: 50,
        fiveHourPercent: 100,
        activeAccountEmail: 'active@test.io',
      });

      expect(killEvents).toHaveLength(1);
      expect(killEvents[0].fiveHourPercent).toBe(100);
      expect(deps.pauseScheduler).toHaveBeenCalled();
      expect(deps.killSession).toHaveBeenCalledWith(session.id);
    });
  });

  // ── 5. With alternative available → normal migration, NOT enforcement ──

  describe('with alternative account available', () => {
    it('switches account instead of enforcing', async () => {
      const session = createHaltableSession({ jobSlug: 'job-a' });
      const pauseEvents: unknown[] = [];
      const killEvents: unknown[] = [];
      const noTargetEvents: unknown[] = [];

      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => [
          createAccountSnapshot({ email: 'backup@test.io', weeklyPercent: 20 }),
        ]),
        listRunningSessions: vi.fn(() => [session]),
      });
      migrator.setDeps(deps);
      migrator.on('enforced_pause', (e) => pauseEvents.push(e));
      migrator.on('enforced_kill', (e) => killEvents.push(e));
      migrator.on('migration_no_target', (e) => noTargetEvents.push(e));

      const result = await migrator.checkAndMigrate({
        percentUsed: 50,
        fiveHourPercent: 95,
        activeAccountEmail: 'active@test.io',
      });

      // Normal migration flow — switchAccount called
      expect(result).toBe(true);
      expect(deps.switchAccount).toHaveBeenCalledWith('backup@test.io');

      // No enforcement events
      expect(pauseEvents).toHaveLength(0);
      expect(killEvents).toHaveLength(0);
      expect(noTargetEvents).toHaveLength(0);
    });
  });

  // ── 6. Cooldown bypass: enforced_pause → enforced_kill within cooldown ──

  describe('cooldown bypass for escalation', () => {
    it('bypasses cooldown when escalating from enforced_pause to enforced_kill', async () => {
      const session = createHaltableSession({ id: 's1', tmuxSession: 'tmux-1', jobSlug: 'job-a' });
      const pauseEvents: unknown[] = [];
      const killEvents: unknown[] = [];

      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => []),
        listRunningSessions: vi.fn(() => [session]),
        isSessionAlive: vi.fn(() => true),
      });
      migrator.setDeps(deps);
      migrator.on('enforced_pause', (e) => pauseEvents.push(e));
      migrator.on('enforced_kill', (e) => killEvents.push(e));

      // First call at 90% → enforced_pause
      await migrator.checkAndMigrate({
        percentUsed: 50,
        fiveHourPercent: 90,
        activeAccountEmail: 'active@test.io',
      });
      expect(pauseEvents).toHaveLength(1);

      // Second call at 95% within cooldown → should STILL fire enforced_kill
      await migrator.checkAndMigrate({
        percentUsed: 50,
        fiveHourPercent: 95,
        activeAccountEmail: 'active@test.io',
      });
      expect(killEvents).toHaveLength(1);
    });
  });

  // ── 7. Cooldown NOT bypassed for same tier ──

  describe('cooldown blocks same-tier re-trigger', () => {
    it('blocks second enforced_pause within cooldown', async () => {
      const session = createHaltableSession({ tmuxSession: 'tmux-1', jobSlug: 'job-a' });
      const pauseEvents: unknown[] = [];

      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => []),
        listRunningSessions: vi.fn(() => [session]),
      });
      migrator.setDeps(deps);
      migrator.on('enforced_pause', (e) => pauseEvents.push(e));

      // First call at 90%
      await migrator.checkAndMigrate({
        percentUsed: 50,
        fiveHourPercent: 90,
        activeAccountEmail: 'active@test.io',
      });
      expect(pauseEvents).toHaveLength(1);

      // Second call at 91% within cooldown → blocked
      const result = await migrator.checkAndMigrate({
        percentUsed: 50,
        fiveHourPercent: 91,
        activeAccountEmail: 'active@test.io',
      });
      expect(result).toBe(false);
      expect(pauseEvents).toHaveLength(1); // No new event
    });
  });

  // ── 8. enforced_pause event payload ──

  describe('enforced_pause event payload', () => {
    it('includes correct fiveHourPercent and sessionsSignaled', async () => {
      const sessions = [
        createHaltableSession({ tmuxSession: 'tmux-a' }),
        createHaltableSession({ tmuxSession: 'tmux-b' }),
        createHaltableSession({ tmuxSession: 'tmux-c' }),
      ];
      const pauseEvents: Array<{ reason: string; fiveHourPercent: number; sessionsSignaled: number }> = [];

      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => []),
        listRunningSessions: vi.fn(() => sessions),
      });
      migrator.setDeps(deps);
      migrator.on('enforced_pause', (e) => pauseEvents.push(e));

      await migrator.checkAndMigrate({
        percentUsed: 50,
        fiveHourPercent: 92,
        activeAccountEmail: 'active@test.io',
      });

      expect(pauseEvents).toHaveLength(1);
      expect(pauseEvents[0].fiveHourPercent).toBe(92);
      expect(pauseEvents[0].sessionsSignaled).toBe(3);
      expect(pauseEvents[0].reason).toContain('5-hour');
    });
  });

  // ── 9. enforced_kill event payload ──

  describe('enforced_kill event payload', () => {
    it('includes correct fiveHourPercent and sessionsKilled list', async () => {
      const session1 = createHaltableSession({ id: 's1', tmuxSession: 'tmux-a', jobSlug: 'alpha' });
      const session2 = createHaltableSession({ id: 's2', tmuxSession: 'tmux-b', jobSlug: 'beta' });
      const killEvents: Array<{ reason: string; fiveHourPercent: number; sessionsKilled: string[] }> = [];

      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => []),
        listRunningSessions: vi.fn(() => [session1, session2]),
        isSessionAlive: vi.fn(() => false), // Sessions died from Ctrl+C
      });
      migrator.setDeps(deps);
      migrator.on('enforced_kill', (e) => killEvents.push(e));

      await migrator.checkAndMigrate({
        percentUsed: 50,
        fiveHourPercent: 97,
        activeAccountEmail: 'active@test.io',
      });

      expect(killEvents).toHaveLength(1);
      expect(killEvents[0].fiveHourPercent).toBe(97);
      expect(killEvents[0].sessionsKilled).toEqual(['alpha', 'beta']);
      expect(killEvents[0].reason).toContain('5-hour');
    });
  });

  // ── 10. Migration history records enforcement events ──

  describe('migration history', () => {
    it('records enforced_pause with correct result field', async () => {
      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => []),
        listRunningSessions: vi.fn(() => [createHaltableSession()]),
      });
      migrator.setDeps(deps);

      await migrator.checkAndMigrate({
        percentUsed: 50,
        fiveHourPercent: 90,
        activeAccountEmail: 'active@test.io',
      });

      const status = migrator.getMigrationStatus();
      expect(status.lastMigration).not.toBeNull();
      expect(status.lastMigration!.result).toBe('enforced_pause');
      expect(status.history).toHaveLength(1);
      expect(status.history[0].result).toBe('enforced_pause');
    });

    it('records enforced_kill with correct result field', async () => {
      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => []),
        listRunningSessions: vi.fn(() => [createHaltableSession()]),
        isSessionAlive: vi.fn(() => true),
      });
      migrator.setDeps(deps);

      await migrator.checkAndMigrate({
        percentUsed: 50,
        fiveHourPercent: 96,
        activeAccountEmail: 'active@test.io',
      });

      const status = migrator.getMigrationStatus();
      expect(status.lastMigration!.result).toBe('enforced_kill');
    });

    it('records no_alternative for below-90% with no target', async () => {
      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => []),
      });
      migrator.setDeps(deps);

      await migrator.checkAndMigrate({
        percentUsed: 50,
        fiveHourPercent: 89,
        activeAccountEmail: 'active@test.io',
      });

      const status = migrator.getMigrationStatus();
      expect(status.lastMigration!.result).toBe('no_alternative');
    });
  });

  // ── 11. Multiple sessions: Ctrl+C sent to ALL ──

  describe('multiple sessions', () => {
    it('sends Ctrl+C to ALL sessions (3+), not just first', async () => {
      const sessions = [
        createHaltableSession({ tmuxSession: 'tmux-1' }),
        createHaltableSession({ tmuxSession: 'tmux-2' }),
        createHaltableSession({ tmuxSession: 'tmux-3' }),
        createHaltableSession({ tmuxSession: 'tmux-4' }),
      ];

      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => []),
        listRunningSessions: vi.fn(() => sessions),
      });
      migrator.setDeps(deps);

      await migrator.checkAndMigrate({
        percentUsed: 50,
        fiveHourPercent: 92,
        activeAccountEmail: 'active@test.io',
      });

      // Each session should have received Ctrl+C
      expect(deps.sendKey).toHaveBeenCalledTimes(4);
      for (const session of sessions) {
        expect(deps.sendKey).toHaveBeenCalledWith(session.tmuxSession, 'C-c');
      }
    });

    it('enforced_kill sends Ctrl+C then kills ALL sessions at 95%', async () => {
      const sessions = [
        createHaltableSession({ id: 's1', tmuxSession: 'tmux-1', jobSlug: 'job-1' }),
        createHaltableSession({ id: 's2', tmuxSession: 'tmux-2', jobSlug: 'job-2' }),
        createHaltableSession({ id: 's3', tmuxSession: 'tmux-3', jobSlug: 'job-3' }),
      ];

      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => []),
        listRunningSessions: vi.fn(() => sessions),
        isSessionAlive: vi.fn(() => true), // All survive Ctrl+C
      });
      migrator.setDeps(deps);

      await migrator.checkAndMigrate({
        percentUsed: 50,
        fiveHourPercent: 98,
        activeAccountEmail: 'active@test.io',
      });

      // All 3 should be killed
      expect(deps.killSession).toHaveBeenCalledTimes(3);
      expect(deps.killSession).toHaveBeenCalledWith('s1');
      expect(deps.killSession).toHaveBeenCalledWith('s2');
      expect(deps.killSession).toHaveBeenCalledWith('s3');
    });
  });

  // ── 12. No sessions running at 95% → still pauses scheduler ──

  describe('no sessions running at 95%', () => {
    it('pauses scheduler even when no sessions to kill', async () => {
      const killEvents: Array<{ sessionsKilled: string[] }> = [];
      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => []),
        listRunningSessions: vi.fn(() => []), // No sessions
      });
      migrator.setDeps(deps);
      migrator.on('enforced_kill', (e) => killEvents.push(e));

      await migrator.checkAndMigrate({
        percentUsed: 50,
        fiveHourPercent: 96,
        activeAccountEmail: 'active@test.io',
      });

      // Scheduler still paused
      expect(deps.pauseScheduler).toHaveBeenCalledTimes(1);

      // Event still emitted, empty kill list
      expect(killEvents).toHaveLength(1);
      expect(killEvents[0].sessionsKilled).toEqual([]);
    });
  });

  // ── Edge: sendKey failure doesn't crash enforced_pause ──

  describe('resilience', () => {
    it('enforced_pause continues if sendKey throws for one session', async () => {
      const sessions = [
        createHaltableSession({ tmuxSession: 'tmux-1' }),
        createHaltableSession({ tmuxSession: 'tmux-2' }),
      ];
      let callCount = 0;

      const deps = createMockDeps({
        getAccountStatuses: vi.fn(() => []),
        listRunningSessions: vi.fn(() => sessions),
        sendKey: vi.fn(() => {
          callCount++;
          if (callCount === 1) throw new Error('tmux gone');
          return true;
        }),
      });
      migrator.setDeps(deps);

      const pauseEvents: unknown[] = [];
      migrator.on('enforced_pause', (e) => pauseEvents.push(e));

      await migrator.checkAndMigrate({
        percentUsed: 50,
        fiveHourPercent: 91,
        activeAccountEmail: 'active@test.io',
      });

      // Should still succeed — sendKey is best-effort
      expect(pauseEvents).toHaveLength(1);
      expect(deps.pauseScheduler).toHaveBeenCalled();
    });
  });
});
