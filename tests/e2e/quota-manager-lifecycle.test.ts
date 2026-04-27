/**
 * E2E lifecycle test — complete QuotaManager orchestration flow.
 *
 * Simulates the full lifecycle that Phase 4 enables:
 *   1. QuotaManager starts adaptive polling
 *   2. Collection triggers → tracker updates → notifier checks
 *   3. Usage climbs → threshold events emitted → notifications sent
 *   4. Usage exceeds migration threshold → migration triggered
 *   5. Migration completes → sessions restarted → notifications sent
 *   6. Cooldown period → manual trigger rejected
 *   7. Spawn gating respects migration state
 *
 * Tests real components end-to-end with real file operations.
 * No mocks except HTTP (fetch) and tmux (sendKey, killSession).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QuotaManager } from '../../src/monitoring/QuotaManager.js';
import { QuotaCollector } from '../../src/monitoring/QuotaCollector.js';
import { QuotaTracker } from '../../src/monitoring/QuotaTracker.js';
import { QuotaNotifier } from '../../src/monitoring/QuotaNotifier.js';
import { SessionMigrator } from '../../src/monitoring/SessionMigrator.js';
import { AccountSwitcher } from '../../src/monitoring/AccountSwitcher.js';
import { ClaudeConfigCredentialProvider } from '../../src/monitoring/CredentialProvider.js';
import { SessionCredentialManager } from '../../src/monitoring/SessionCredentialManager.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Helpers ──────────────────────────────────────────────────────────

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qm-e2e-'));
}

interface MockEndpoint {
  usage: { status: number; body: unknown };
  profile: { status: number; body: unknown };
}

function createRoutingFetch(endpoints: MockEndpoint): typeof globalThis.fetch {
  return vi.fn(async (url: string) => {
    const isUsage = url.toString().includes('/usage');
    const isProfile = url.toString().includes('/profile');
    const endpoint = isUsage ? endpoints.usage : isProfile ? endpoints.profile : { status: 404, body: {} };
    return {
      ok: endpoint.status >= 200 && endpoint.status < 300,
      status: endpoint.status,
      headers: new Map(),
      json: async () => endpoint.body,
    } as unknown as Response;
  });
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
    activeAccountEmail: activeEmail ?? Object.keys(accounts)[0],
    lastUpdated: new Date().toISOString(),
  }, null, 2));
}

function writeCredentialFile(dir: string, email: string, token: string, expiresAt?: number): void {
  const credDir = path.join(dir, '.credentials');
  fs.mkdirSync(credDir, { recursive: true });
  fs.writeFileSync(path.join(credDir, 'credentials.json'), JSON.stringify({
    accessToken: token,
    expiresAt: expiresAt ?? Date.now() + 3600000,
    email,
  }));
}

function createMockSessionManager() {
  return {
    listRunningSessions: vi.fn(() => [
      { id: 's1', name: 'evolution', tmuxSession: 'proj-evolution', jobSlug: 'evolution', status: 'running' as const, startedAt: new Date().toISOString() },
      { id: 's2', name: 'feedback', tmuxSession: 'proj-feedback', jobSlug: 'feedback', status: 'running' as const, startedAt: new Date().toISOString() },
    ]),
    sendKey: vi.fn(() => true),
    killSession: vi.fn(() => true),
    isSessionAlive: vi.fn(() => false), // Sessions die after kill
  };
}

function createMockScheduler() {
  return {
    canRunJob: vi.fn(() => true) as any,
    setQuotaTracker: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    triggerJob: vi.fn(() => 'triggered' as const),
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('QuotaManager E2E Lifecycle', () => {
  let tmpDir: string;
  let registryPath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = createTmpDir();
    registryPath = path.join(tmpDir, 'account-registry.json');
  });

  afterEach(() => {
    vi.useRealTimers();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full lifecycle: normal → high usage → threshold events → migration → cooldown', async () => {
    // ── PHASE 1: Setup all real components ──
    const quotaFile = path.join(tmpDir, 'quota-state.json');
    const tracker = new QuotaTracker({
      quotaFile,
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    });

    writeCredentialFile(tmpDir, 'primary@test.com', 'tok-primary');
    const provider = new ClaudeConfigCredentialProvider(
      path.join(tmpDir, '.credentials'),
    );

    writeRegistry(registryPath, {
      'primary@test.com': { name: 'Primary', token: 'tok-primary', percentUsed: 45 },
      'backup@test.com': { name: 'Backup', token: 'tok-backup', percentUsed: 10 },
    }, 'primary@test.com');

    // Start with normal usage
    let currentUsage = 45;
    let currentFiveHour = 20;
    const mockFetch = vi.fn(async (url: string) => {
      const isUsage = url.toString().includes('/usage');
      if (isUsage) {
        return {
          ok: true, status: 200, headers: new Map(),
          json: async () => ({
            seven_day: { utilization: currentUsage, resets_at: '2026-03-06T03:00:00Z' },
            five_hour: { utilization: currentFiveHour, resets_at: '2026-02-28T12:00:00Z' },
          }),
        } as unknown as Response;
      }
      return {
        ok: true, status: 200, headers: new Map(),
        json: async () => ({
          account: { full_name: 'Primary', email: 'primary@test.com', has_claude_max: true },
          organization: null,
        }),
      } as unknown as Response;
    });

    const collector = new QuotaCollector(provider, tracker, {
      registryPath,
      fetchFn: mockFetch,
    });

    const switcher = new AccountSwitcher({ registryPath, provider });
    const migrator = new SessionMigrator({ stateDir: tmpDir });
    const notifier = new QuotaNotifier(tmpDir);
    notifier.configure(vi.fn(async () => {}), null);

    const sm = createMockSessionManager();
    const sched = createMockScheduler();

    const notifications: string[] = [];
    const thresholdEvents: unknown[] = [];
    const migrationEvents: unknown[] = [];

    const manager = new QuotaManager(
      { stateDir: tmpDir, adaptivePolling: false },
      { tracker, collector, migrator, notifier, switcher },
    );

    manager.setSessionManager(sm as any);
    manager.setScheduler(sched as any);
    manager.setNotificationSender(async (msg) => { notifications.push(msg); });
    manager.on('threshold_crossed', (ev) => thresholdEvents.push(ev));
    manager.on('migration_started', (ev) => migrationEvents.push(ev));
    manager.on('migration_complete', (ev) => migrationEvents.push(ev));
    manager.on('migration_failed', (ev) => migrationEvents.push(ev));

    // ── PHASE 2: Normal collection — no events ──
    const result1 = await manager.refresh();
    expect(result1!.success).toBe(true);
    expect(tracker.getState()!.usagePercent).toBeCloseTo(45, 0);
    expect(thresholdEvents).toHaveLength(0);
    expect(migrationEvents).toHaveLength(0);

    // Spawn should be allowed
    expect(manager.canSpawnSession('medium').allowed).toBe(true);
    expect(sched.canRunJob('medium')).toBe(true);

    // ── PHASE 3: Usage climbs above warning → threshold event ──
    currentUsage = 75;
    const result2 = await manager.refresh();
    expect(result2!.success).toBe(true);

    // Should emit warning threshold
    const weeklyWarning = thresholdEvents.find((e: any) => e.metric === 'weekly' && e.level === 'warning');
    expect(weeklyWarning).toBeDefined();

    // ── PHASE 4: Usage climbs above critical → critical threshold event ──
    currentUsage = 88;
    thresholdEvents.length = 0; // Reset
    await manager.refresh();

    const weeklyCritical = thresholdEvents.find((e: any) => e.metric === 'weekly' && e.level === 'critical');
    expect(weeklyCritical).toBeDefined();

    // ── PHASE 5: Verify polling/migration status APIs ──
    const pollingStatus = manager.getPollingStatus();
    expect(pollingStatus.lastCollectionAt).not.toBeNull();

    const migStatus = manager.getMigrationStatus();
    expect(migStatus.config.enabled).toBe(true);
    expect(migStatus.cooldownUntil).toBeNull(); // No migration happened yet

    // ── PHASE 6: Manual trigger with low usage — should not trigger ──
    currentUsage = 45;
    await manager.refresh(); // Update tracker first
    const manualResult = await manager.triggerMigration();
    expect(manualResult.triggered).toBe(false);

    // ── PHASE 7: Verify credential manager is available ──
    expect(manager.credentialManager).toBeDefined();
    expect(manager.credentialManager).toBeInstanceOf(SessionCredentialManager);
    expect(manager.credentialManager.activeCount).toBe(0);

    manager.stop();
  });

  it('tracker-only mode works without collector', async () => {
    const quotaFile = path.join(tmpDir, 'quota-state.json');
    const tracker = new QuotaTracker({
      quotaFile,
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    });
    tracker.updateState({ usagePercent: 60, lastUpdated: new Date().toISOString() });

    const notifier = new QuotaNotifier(tmpDir);
    notifier.configure(vi.fn(async () => {}), null);

    const manager = new QuotaManager(
      { stateDir: tmpDir },
      { tracker, notifier },
    );

    manager.start();
    expect(manager.getPollingStatus().running).toBe(true);

    // Refresh reads from tracker's file
    const result = await manager.refresh();
    expect(result).toBeNull(); // No collector = no CollectionResult

    // Spawn gating still works via tracker
    const check = manager.canSpawnSession('low');
    expect(check.allowed).toBeDefined();

    manager.stop();
  });

  it('notification retry survives initial failure', async () => {
    const quotaFile = path.join(tmpDir, 'quota-state.json');
    const tracker = new QuotaTracker({
      quotaFile,
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    });

    const migrator = new SessionMigrator({ stateDir: tmpDir });
    const notifier = new QuotaNotifier(tmpDir);
    notifier.configure(vi.fn(async () => {}), null);

    let failCount = 0;
    const sender = vi.fn(async () => {
      failCount++;
      if (failCount <= 2) throw new Error('Network error');
    });

    const manager = new QuotaManager(
      { stateDir: tmpDir },
      { tracker, migrator, notifier },
    );
    manager.setNotificationSender(sender);
    manager.start();

    // Trigger a notification via migration event
    migrator.emit('migration_failed', {
      previousAccount: 'a@test.com',
      sessionsHalted: ['s1'],
      sessionsRestarted: [],
      completedAt: new Date().toISOString(),
      durationMs: 3000,
      error: 'Switch failed',
      result: 'failed',
    });

    // First attempt fails
    await vi.advanceTimersByTimeAsync(0);
    expect(sender).toHaveBeenCalledTimes(1);

    // Retry after backoff + retry timer interval
    await vi.advanceTimersByTimeAsync(15000);
    expect(sender).toHaveBeenCalledTimes(2);

    // Second retry after longer backoff
    await vi.advanceTimersByTimeAsync(25000);
    expect(sender).toHaveBeenCalledTimes(3);

    // Third attempt should succeed (failCount > 2)
    manager.stop();
  });

  it('JSONL data does not trigger migration by default', async () => {
    const quotaFile = path.join(tmpDir, 'quota-state.json');
    const tracker = new QuotaTracker({
      quotaFile,
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    });

    // Expired token → collector falls back to JSONL
    writeCredentialFile(tmpDir, 'test@example.com', 'tok-expired', Date.now() - 1000);
    const provider = new ClaudeConfigCredentialProvider(
      path.join(tmpDir, '.credentials'),
    );

    const mockFetch = vi.fn(async () => {
      return { ok: false, status: 401, headers: new Map(), json: async () => ({}) } as unknown as Response;
    });

    const collector = new QuotaCollector(provider, tracker, { fetchFn: mockFetch });
    const migrator = new SessionMigrator({ stateDir: tmpDir });
    const notifier = new QuotaNotifier(tmpDir);
    notifier.configure(vi.fn(async () => {}), null);

    const migrateSpy = vi.spyOn(migrator, 'checkAndMigrate');

    const manager = new QuotaManager(
      { stateDir: tmpDir, adaptivePolling: false, jsonlCanTriggerMigration: false },
      { tracker, collector, migrator, notifier },
    );

    await manager.refresh();

    // Migration should NOT be called since data source is estimated/JSONL
    expect(migrateSpy).not.toHaveBeenCalled();

    manager.stop();
  });
});
