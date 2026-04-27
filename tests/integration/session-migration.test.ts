/**
 * Integration tests — SessionMigrator wired with real AccountSwitcher
 * and file-based state management.
 *
 * Tests the full migration coordination with real:
 * - AccountSwitcher (reads/writes real registry files)
 * - File-based state persistence (migration state, history, lock)
 * - CredentialProvider (file-based, not Keychain)
 *
 * Mock only: SessionManager operations (tmux) and scheduler.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionMigrator } from '../../src/monitoring/SessionMigrator.js';
import type { SessionMigratorDeps, HaltableSession, MigrationEvent } from '../../src/monitoring/SessionMigrator.js';
import { AccountSwitcher } from '../../src/monitoring/AccountSwitcher.js';
import { ClaudeConfigCredentialProvider } from '../../src/monitoring/CredentialProvider.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Helpers ──────────────────────────────────────────────────────────

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sm-integ-'));
}

function writeRegistry(registryPath: string, accounts: Record<string, {
  name: string;
  token: string;
  expiresAt?: number;
  percentUsed?: number;
  fiveHourPercent?: number;
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
        weeklyResetsAt: new Date(Date.now() + 86400000).toISOString(),
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

// ── Tests ────────────────────────────────────────────────────────────

describe('Session Migration (integration)', () => {
  let tmpDir: string;
  let stateDir: string;
  let credDir: string;
  let registryPath: string;
  let provider: ClaudeConfigCredentialProvider;
  let switcher: AccountSwitcher;

  beforeEach(() => {
    tmpDir = createTmpDir();
    stateDir = path.join(tmpDir, 'migration-state');
    credDir = path.join(tmpDir, 'claude-config');
    registryPath = path.join(tmpDir, 'account-registry.json');
    fs.mkdirSync(credDir, { recursive: true });

    provider = new ClaudeConfigCredentialProvider(credDir);
    switcher = new AccountSwitcher({ registryPath, provider });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full migration: halt → switch → restart with real AccountSwitcher', async () => {
    // Setup: 2 accounts, dawn is active at high usage
    writeRegistry(registryPath, {
      'dawn@test.io': { name: 'Dawn', token: 'dawn-token', percentUsed: 93 },
      'justin@test.io': { name: 'Justin', token: 'justin-token', percentUsed: 25 },
    }, 'dawn@test.io');

    await provider.writeCredentials({
      accessToken: 'dawn-token',
      expiresAt: Date.now() + 3600000,
      email: 'dawn@test.io',
    });

    const session = {
      id: 'sess-1',
      tmuxSession: 'portal-job-test',
      jobSlug: 'test-job',
      name: 'test session',
    };

    const schedulerPaused = { value: false };
    const respawnedJobs: string[] = [];

    const migrator = new SessionMigrator({
      stateDir,
      thresholds: { gracePeriodMs: 10 },
    });

    migrator.setDeps({
      listRunningSessions: () => [session],
      sendKey: vi.fn(() => true),
      killSession: vi.fn(() => true),
      isSessionAlive: vi.fn(() => false),
      pauseScheduler: () => { schedulerPaused.value = true; },
      resumeScheduler: () => { schedulerPaused.value = false; },
      respawnJob: async (slug) => { respawnedJobs.push(slug); },
      getAccountStatuses: () => switcher.getAccountStatuses(),
      switchAccount: async (email) => switcher.switchAccount(email),
    });

    const events: MigrationEvent[] = [];
    migrator.on('migration_complete', (e: MigrationEvent) => events.push(e));

    const result = await migrator.checkAndMigrate({
      percentUsed: 93,
      fiveHourPercent: 40,
      activeAccountEmail: 'dawn@test.io',
    });

    expect(result).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].result).toBe('success');
    expect(events[0].previousAccount).toBe('dawn@test.io');
    expect(events[0].newAccount).toBe('justin@test.io');

    // Credentials were actually switched
    const creds = await provider.readCredentials();
    expect(creds?.accessToken).toBe('justin-token');

    // Registry was updated
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    expect(registry.activeAccountEmail).toBe('justin@test.io');

    // Job was respawned
    expect(respawnedJobs).toEqual(['test-job']);

    // Scheduler was paused then resumed
    expect(schedulerPaused.value).toBe(false);
  });

  it('migration selects lowest-usage account from real registry', async () => {
    writeRegistry(registryPath, {
      'active@test.io': { name: 'Active', token: 'active-tok', percentUsed: 95 },
      'medium@test.io': { name: 'Medium', token: 'medium-tok', percentUsed: 55 },
      'low@test.io': { name: 'Low', token: 'low-tok', percentUsed: 15 },
      'high@test.io': { name: 'High', token: 'high-tok', percentUsed: 78 },
    }, 'active@test.io');

    await provider.writeCredentials({
      accessToken: 'active-tok',
      expiresAt: Date.now() + 3600000,
    });

    const migrator = new SessionMigrator({ stateDir, thresholds: { gracePeriodMs: 10 } });
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

    // Account selection should prefer 'low' (15%)
    const target = migrator.selectMigrationTarget();
    expect(target?.email).toBe('low@test.io');
    expect(target?.weeklyPercent).toBe(15);
  });

  it('no migration target when all accounts are exhausted', async () => {
    writeRegistry(registryPath, {
      'active@test.io': { name: 'Active', token: 'active-tok', percentUsed: 95 },
      'other@test.io': { name: 'Other', token: 'other-tok', percentUsed: 88 },
    }, 'active@test.io');

    await provider.writeCredentials({
      accessToken: 'active-tok',
      expiresAt: Date.now() + 3600000,
    });

    const migrator = new SessionMigrator({ stateDir, thresholds: { gracePeriodMs: 10 } });
    const noTargetEvents: Array<{ reason: string }> = [];
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
      percentUsed: 95,
      activeAccountEmail: 'active@test.io',
    });

    expect(result).toBe(false);
    expect(noTargetEvents).toHaveLength(1);
  });

  it('rollback restores original credentials when switch fails', async () => {
    // Target account looks valid in the registry (has a token, low usage)
    // but the switchAccount call will fail (simulating a write failure)
    writeRegistry(registryPath, {
      'dawn@test.io': { name: 'Dawn', token: 'dawn-token', percentUsed: 95 },
      'target@test.io': { name: 'Target', token: 'target-token', percentUsed: 20 },
    }, 'dawn@test.io');

    await provider.writeCredentials({
      accessToken: 'dawn-token',
      expiresAt: Date.now() + 3600000,
    });

    const session: HaltableSession = {
      id: 'sess-1',
      tmuxSession: 'portal-test',
      jobSlug: 'my-job',
      name: 'test',
    };

    const respawned: string[] = [];
    const migrator = new SessionMigrator({ stateDir, thresholds: { gracePeriodMs: 10 } });
    migrator.setDeps({
      listRunningSessions: () => [session],
      sendKey: vi.fn(() => true),
      killSession: vi.fn(() => true),
      isSessionAlive: vi.fn(() => false),
      pauseScheduler: vi.fn(),
      resumeScheduler: vi.fn(),
      respawnJob: async (slug) => { respawned.push(slug); },
      getAccountStatuses: () => switcher.getAccountStatuses(),
      // Override switchAccount to simulate a failure after target is selected
      switchAccount: async () => ({
        success: false,
        message: 'Credential write failed: permission denied',
      }),
    });

    const rollbackEvents: MigrationEvent[] = [];
    migrator.on('migration_rollback', (e: MigrationEvent) => rollbackEvents.push(e));

    const result = await migrator.checkAndMigrate({
      percentUsed: 95,
      activeAccountEmail: 'dawn@test.io',
    });

    // Switch failed → rollback triggered
    expect(result).toBe(false);
    expect(rollbackEvents).toHaveLength(1);
    expect(rollbackEvents[0].result).toBe('rolled_back');

    // Session was restarted on original account (rollback)
    expect(respawned).toContain('my-job');
  });

  it('migration state survives restart', async () => {
    writeRegistry(registryPath, {
      'dawn@test.io': { name: 'Dawn', token: 'dawn-token', percentUsed: 95 },
      'justin@test.io': { name: 'Justin', token: 'justin-token', percentUsed: 25 },
    }, 'dawn@test.io');

    await provider.writeCredentials({
      accessToken: 'dawn-token',
      expiresAt: Date.now() + 3600000,
    });

    // Run a migration
    const m1 = new SessionMigrator({ stateDir, thresholds: { gracePeriodMs: 10 } });
    m1.setDeps({
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

    await m1.checkAndMigrate({
      percentUsed: 95,
      activeAccountEmail: 'dawn@test.io',
    });

    // "Restart" — create new instance
    const m2 = new SessionMigrator({ stateDir });
    const status = m2.getMigrationStatus();

    expect(status.lastMigration).not.toBeNull();
    expect(status.lastMigration?.result).toBe('success');
    expect(status.lastMigration?.previousAccount).toBe('dawn@test.io');
    expect(status.lastMigration?.newAccount).toBe('justin@test.io');
    expect(status.history).toHaveLength(1);

    // Cooldown should block immediate re-migration
    m2.setDeps({
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

    const result = await m2.checkAndMigrate({
      percentUsed: 95,
      activeAccountEmail: 'justin@test.io',
    });
    expect(result).toBe(false); // Blocked by cooldown
  });

  it('multiple sequential migrations build history', async () => {
    // Three accounts to cycle through
    writeRegistry(registryPath, {
      'a@test.io': { name: 'A', token: 'tok-a', percentUsed: 95 },
      'b@test.io': { name: 'B', token: 'tok-b', percentUsed: 25 },
      'c@test.io': { name: 'C', token: 'tok-c', percentUsed: 40 },
    }, 'a@test.io');

    await provider.writeCredentials({
      accessToken: 'tok-a',
      expiresAt: Date.now() + 3600000,
    });

    // Use 0 cooldown for testing
    const m = new SessionMigrator({
      stateDir,
      thresholds: { gracePeriodMs: 10, cooldownMs: 0 },
    });
    m.setDeps({
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

    // Migration 1: A → B
    await m.checkAndMigrate({
      percentUsed: 95,
      activeAccountEmail: 'a@test.io',
    });

    // Update registry to reflect B is now active and high
    writeRegistry(registryPath, {
      'a@test.io': { name: 'A', token: 'tok-a', percentUsed: 95 },
      'b@test.io': { name: 'B', token: 'tok-b', percentUsed: 92 },
      'c@test.io': { name: 'C', token: 'tok-c', percentUsed: 40 },
    }, 'b@test.io');

    // Migration 2: B → C
    await m.checkAndMigrate({
      percentUsed: 92,
      activeAccountEmail: 'b@test.io',
    });

    const status = m.getMigrationStatus();
    expect(status.history).toHaveLength(2);
    expect(status.history[0].previousAccount).toBe('a@test.io');
    expect(status.history[0].newAccount).toBe('b@test.io');
    expect(status.history[1].previousAccount).toBe('b@test.io');
    expect(status.history[1].newAccount).toBe('c@test.io');
  });
});
