/**
 * E2E lifecycle test — complete session migration flow.
 *
 * Simulates realistic multi-account migration scenarios:
 * 1. Account exhaustion → migration → sessions restart on new account
 * 2. All accounts exhausted → no migration, user notified
 * 3. Migration + crash recovery → sessions restored
 * 4. Rapid quota fluctuations → cooldown prevents thrashing
 * 5. Multi-session halt ordering → all sessions properly cycled
 *
 * Uses real file operations, real AccountSwitcher, real CredentialProvider.
 * No mocks except tmux/session operations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionMigrator } from '../../src/monitoring/SessionMigrator.js';
import type { MigrationEvent, HaltableSession } from '../../src/monitoring/SessionMigrator.js';
import { AccountSwitcher } from '../../src/monitoring/AccountSwitcher.js';
import { ClaudeConfigCredentialProvider } from '../../src/monitoring/CredentialProvider.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Helpers ──────────────────────────────────────────────────────────

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sm-e2e-'));
}

function writeRegistry(registryPath: string, accounts: Record<string, {
  name: string;
  token: string;
  expiresAt?: number;
  percentUsed?: number;
  fiveHourPercent?: number;
  weeklyResetsAt?: string;
}>, activeEmail: string | null = null): void {
  const entries: Record<string, unknown> = {};
  for (const [email, info] of Object.entries(accounts)) {
    entries[email] = {
      email,
      name: info.name,
      rateLimitTier: 'max_5x',
      cachedOAuth: {
        accessToken: info.token,
        expiresAt: info.expiresAt ?? Date.now() + 3600000,
      },
      tokenCachedAt: new Date().toISOString(),
      staleSince: null,
      lastQuotaSnapshot: {
        collectedAt: new Date().toISOString(),
        weeklyUtilization: info.percentUsed ?? 50,
        fiveHourUtilization: info.fiveHourPercent ?? 30,
        weeklyResetsAt: info.weeklyResetsAt ?? new Date(Date.now() + 86400000).toISOString(),
        fiveHourResetsAt: new Date(Date.now() + 18000000).toISOString(),
        sonnetUtilization: info.percentUsed ?? 50,
        percentUsed: info.percentUsed ?? 50,
        canRunPriority: (info.percentUsed ?? 50) >= 95 ? 'none' : 'all',
      },
    };
  }
  fs.writeFileSync(registryPath, JSON.stringify({
    schemaVersion: 1,
    accounts: entries,
    activeAccountEmail: activeEmail,
    lastUpdated: new Date().toISOString(),
  }, null, 2), { mode: 0o600 });
}

function makeSessions(count: number): HaltableSession[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `sess-${i}`,
    tmuxSession: `portal-job-${i}`,
    jobSlug: `job-${i}`,
    name: `session-${i}`,
  }));
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Session Migration Lifecycle (e2e)', () => {
  let tmpDir: string;
  let stateDir: string;
  let credDir: string;
  let registryPath: string;
  let provider: ClaudeConfigCredentialProvider;
  let switcher: AccountSwitcher;

  beforeEach(() => {
    tmpDir = createTmpDir();
    stateDir = path.join(tmpDir, 'migration');
    credDir = path.join(tmpDir, 'creds');
    registryPath = path.join(tmpDir, 'registry.json');
    fs.mkdirSync(credDir, { recursive: true });

    provider = new ClaudeConfigCredentialProvider(credDir);
    switcher = new AccountSwitcher({ registryPath, provider });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full lifecycle: exhaustion → migrate → sessions restart on new account', async () => {
    // Setup: 3 accounts — Dawn at 95%, Justin at 25%, Backup at 55%
    writeRegistry(registryPath, {
      'dawn@test.io': { name: 'Dawn', token: 'dawn-tok', percentUsed: 95, fiveHourPercent: 50 },
      'justin@test.io': { name: 'Justin', token: 'justin-tok', percentUsed: 25, fiveHourPercent: 15 },
      'backup@test.io': { name: 'Backup', token: 'backup-tok', percentUsed: 55, fiveHourPercent: 30 },
    }, 'dawn@test.io');

    await provider.writeCredentials({
      accessToken: 'dawn-tok',
      expiresAt: Date.now() + 3600000,
    });

    const sessions = makeSessions(3);
    const respawned: string[] = [];
    const sendKeyCalls: string[] = [];
    let schedulerPaused = false;

    const migrator = new SessionMigrator({
      stateDir,
      thresholds: { gracePeriodMs: 50 },
    });

    migrator.setDeps({
      listRunningSessions: () => sessions,
      sendKey: (tmux, key) => { sendKeyCalls.push(`${tmux}:${key}`); return true; },
      killSession: vi.fn(() => true),
      isSessionAlive: vi.fn(() => false),
      pauseScheduler: () => { schedulerPaused = true; },
      resumeScheduler: () => { schedulerPaused = false; },
      respawnJob: async (slug) => { respawned.push(slug); },
      getAccountStatuses: () => switcher.getAccountStatuses(),
      switchAccount: async (email) => switcher.switchAccount(email),
    });

    const allEvents: MigrationEvent[] = [];
    migrator.on('migration_complete', (e: MigrationEvent) => allEvents.push(e));

    // Trigger migration
    const result = await migrator.checkAndMigrate({
      percentUsed: 95,
      fiveHourPercent: 50,
      activeAccountEmail: 'dawn@test.io',
    });

    expect(result).toBe(true);
    expect(allEvents).toHaveLength(1);

    const event = allEvents[0];
    // Selected Justin (lowest at 25%)
    expect(event.newAccount).toBe('justin@test.io');
    expect(event.previousAccount).toBe('dawn@test.io');
    expect(event.result).toBe('success');

    // All 3 sessions were halted (Ctrl+C sent)
    expect(sendKeyCalls).toHaveLength(3);
    expect(sendKeyCalls.every(c => c.endsWith(':C-c'))).toBe(true);

    // All 3 sessions were respawned
    expect(respawned).toEqual(['job-0', 'job-1', 'job-2']);

    // Credentials updated to Justin's
    const creds = await provider.readCredentials();
    expect(creds?.accessToken).toBe('justin-tok');

    // Scheduler was paused then resumed
    expect(schedulerPaused).toBe(false);

    // Duration was tracked
    expect(event.durationMs).toBeGreaterThan(0);
  });

  it('all accounts exhausted → no migration, user notified', async () => {
    writeRegistry(registryPath, {
      'dawn@test.io': { name: 'Dawn', token: 'dawn-tok', percentUsed: 96 },
      'justin@test.io': { name: 'Justin', token: 'justin-tok', percentUsed: 88 },
      'backup@test.io': { name: 'Backup', token: 'backup-tok', percentUsed: 82 },
    }, 'dawn@test.io');

    await provider.writeCredentials({
      accessToken: 'dawn-tok',
      expiresAt: Date.now() + 3600000,
    });

    const migrator = new SessionMigrator({ stateDir, thresholds: { gracePeriodMs: 10 } });
    const noTargetEvents: Array<{ reason: string; sourceAccount: string }> = [];
    migrator.on('migration_no_target', (e) => noTargetEvents.push(e));

    migrator.setDeps({
      listRunningSessions: () => [],
      sendKey: vi.fn(() => true),
      killSession: vi.fn(() => true),
      isSessionAlive: vi.fn(() => false),
      pauseScheduler: vi.fn(),
      resumeScheduler: vi.fn(),
      respawnJob: vi.fn(async () => {}),
      getAccountStatuses: () => switcher.getAccountStatuses(),
      switchAccount: async (email) => switcher.switchAccount(email),
    });

    const result = await migrator.checkAndMigrate({
      percentUsed: 96,
      activeAccountEmail: 'dawn@test.io',
    });

    expect(result).toBe(false);
    expect(noTargetEvents).toHaveLength(1);
    expect(noTargetEvents[0].sourceAccount).toBe('dawn@test.io');

    // History records the no_alternative event
    const status = migrator.getMigrationStatus();
    expect(status.lastMigration?.result).toBe('no_alternative');
  });

  it('crash recovery: interrupted migration → sessions restored on restart', async () => {
    writeRegistry(registryPath, {
      'dawn@test.io': { name: 'Dawn', token: 'dawn-tok', percentUsed: 95 },
      'justin@test.io': { name: 'Justin', token: 'justin-tok', percentUsed: 25 },
    }, 'dawn@test.io');

    // Simulate a crash during migration — state file left in 'switching' status
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'migration-state.json'),
      JSON.stringify({
        status: 'switching',
        startedAt: new Date(Date.now() - 60000).toISOString(),
        sourceAccount: 'dawn@test.io',
        targetAccount: 'justin@test.io',
        haltedSessions: [
          { sessionId: 'sess-a', jobSlug: 'critical-job', haltedAt: new Date(Date.now() - 55000).toISOString() },
          { sessionId: 'sess-b', jobSlug: 'monitoring-job', haltedAt: new Date(Date.now() - 55000).toISOString() },
        ],
        restartedSessions: [],
      }),
    );

    // Create migrator — should detect the crash
    const migrator = new SessionMigrator({ stateDir });
    expect(migrator.isMigrating()).toBe(true);

    const respawned: string[] = [];
    migrator.setDeps({
      listRunningSessions: () => [],
      sendKey: vi.fn(() => true),
      killSession: vi.fn(() => true),
      isSessionAlive: vi.fn(() => false),
      pauseScheduler: vi.fn(),
      resumeScheduler: vi.fn(),
      respawnJob: async (slug) => { respawned.push(slug); },
      getAccountStatuses: () => switcher.getAccountStatuses(),
      switchAccount: async (email) => switcher.switchAccount(email),
    });

    // Complete recovery
    await migrator.completeRecovery();

    // Both halted sessions should be restarted
    expect(respawned).toContain('critical-job');
    expect(respawned).toContain('monitoring-job');

    // Migration is no longer in progress
    expect(migrator.isMigrating()).toBe(false);
  });

  it('cooldown prevents thrashing from rapid quota fluctuations', async () => {
    writeRegistry(registryPath, {
      'dawn@test.io': { name: 'Dawn', token: 'dawn-tok', percentUsed: 93 },
      'justin@test.io': { name: 'Justin', token: 'justin-tok', percentUsed: 30 },
    }, 'dawn@test.io');

    await provider.writeCredentials({
      accessToken: 'dawn-tok',
      expiresAt: Date.now() + 3600000,
    });

    const migrator = new SessionMigrator({
      stateDir,
      thresholds: { gracePeriodMs: 10, cooldownMs: 60000 }, // 1 min cooldown
    });

    const switchCalls: string[] = [];
    migrator.setDeps({
      listRunningSessions: () => [],
      sendKey: vi.fn(() => true),
      killSession: vi.fn(() => true),
      isSessionAlive: vi.fn(() => false),
      pauseScheduler: vi.fn(),
      resumeScheduler: vi.fn(),
      respawnJob: vi.fn(async () => {}),
      getAccountStatuses: () => switcher.getAccountStatuses(),
      switchAccount: async (email) => { switchCalls.push(email); return switcher.switchAccount(email); },
    });

    // First migration succeeds
    const r1 = await migrator.checkAndMigrate({
      percentUsed: 93,
      activeAccountEmail: 'dawn@test.io',
    });
    expect(r1).toBe(true);
    expect(switchCalls).toHaveLength(1);

    // Immediate second attempt — blocked by cooldown
    const r2 = await migrator.checkAndMigrate({
      percentUsed: 93,
      activeAccountEmail: 'justin@test.io',
    });
    expect(r2).toBe(false);
    expect(switchCalls).toHaveLength(1); // No additional switch

    // Third attempt — still within cooldown
    const r3 = await migrator.checkAndMigrate({
      percentUsed: 95,
      activeAccountEmail: 'justin@test.io',
    });
    expect(r3).toBe(false);
    expect(switchCalls).toHaveLength(1);
  });

  it('5-hour rate limit triggers migration before weekly threshold', async () => {
    writeRegistry(registryPath, {
      'dawn@test.io': { name: 'Dawn', token: 'dawn-tok', percentUsed: 70, fiveHourPercent: 90 },
      'justin@test.io': { name: 'Justin', token: 'justin-tok', percentUsed: 30, fiveHourPercent: 15 },
    }, 'dawn@test.io');

    await provider.writeCredentials({
      accessToken: 'dawn-tok',
      expiresAt: Date.now() + 3600000,
    });

    const migrator = new SessionMigrator({ stateDir, thresholds: { gracePeriodMs: 10 } });
    const events: MigrationEvent[] = [];
    migrator.on('migration_complete', (e: MigrationEvent) => events.push(e));

    migrator.setDeps({
      listRunningSessions: () => [],
      sendKey: vi.fn(() => true),
      killSession: vi.fn(() => true),
      isSessionAlive: vi.fn(() => false),
      pauseScheduler: vi.fn(),
      resumeScheduler: vi.fn(),
      respawnJob: vi.fn(async () => {}),
      getAccountStatuses: () => switcher.getAccountStatuses(),
      switchAccount: async (email) => switcher.switchAccount(email),
    });

    // Weekly at 70% (below 92% threshold) but 5-hour at 90% (above 88%)
    const result = await migrator.checkAndMigrate({
      percentUsed: 70,
      fiveHourPercent: 90,
      activeAccountEmail: 'dawn@test.io',
    });

    expect(result).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toContain('5-hour');
  });

  it('migration with partial restart failure still completes', async () => {
    writeRegistry(registryPath, {
      'dawn@test.io': { name: 'Dawn', token: 'dawn-tok', percentUsed: 95 },
      'justin@test.io': { name: 'Justin', token: 'justin-tok', percentUsed: 25 },
    }, 'dawn@test.io');

    await provider.writeCredentials({
      accessToken: 'dawn-tok',
      expiresAt: Date.now() + 3600000,
    });

    const sessions = makeSessions(3);
    let respawnCount = 0;

    const migrator = new SessionMigrator({ stateDir, thresholds: { gracePeriodMs: 10 } });
    const partialEvents: MigrationEvent[] = [];
    migrator.on('migration_partial', (e: MigrationEvent) => partialEvents.push(e));

    migrator.setDeps({
      listRunningSessions: () => sessions,
      sendKey: vi.fn(() => true),
      killSession: vi.fn(() => true),
      isSessionAlive: vi.fn(() => false),
      pauseScheduler: vi.fn(),
      resumeScheduler: vi.fn(),
      respawnJob: async (slug) => {
        respawnCount++;
        if (slug === 'job-1') throw new Error('Respawn failed for job-1');
      },
      getAccountStatuses: () => switcher.getAccountStatuses(),
      switchAccount: async (email) => switcher.switchAccount(email),
    });

    const result = await migrator.checkAndMigrate({
      percentUsed: 95,
      activeAccountEmail: 'dawn@test.io',
    });

    expect(result).toBe(true);
    expect(partialEvents).toHaveLength(1);
    expect(partialEvents[0].result).toBe('partial');
    expect(partialEvents[0].sessionsRestarted).toEqual(['job-0', 'job-2']);
    expect(partialEvents[0].sessionsHalted).toEqual(['job-0', 'job-1', 'job-2']);
  });
});
