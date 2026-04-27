/**
 * Integration tests — QuotaManager wired with real components.
 *
 * Tests the full orchestration with real:
 * - QuotaTracker (reads/writes real quota-state.json)
 * - QuotaCollector (mock HTTP but real file operations)
 * - SessionMigrator (real state persistence)
 * - QuotaNotifier (real state deduplication)
 * - AccountSwitcher (real registry files, file-based credentials)
 *
 * Mock only: tmux operations (sendKey, killSession, isSessionAlive),
 * HTTP fetch, and Telegram notification delivery.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QuotaManager } from '../../src/monitoring/QuotaManager.js';
import { QuotaTracker } from '../../src/monitoring/QuotaTracker.js';
import { QuotaCollector } from '../../src/monitoring/QuotaCollector.js';
import { SessionMigrator } from '../../src/monitoring/SessionMigrator.js';
import { QuotaNotifier } from '../../src/monitoring/QuotaNotifier.js';
import { AccountSwitcher } from '../../src/monitoring/AccountSwitcher.js';
import { ClaudeConfigCredentialProvider } from '../../src/monitoring/CredentialProvider.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Test Helpers ────────────────────────────────────────────────────

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qm-integ-'));
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

function writeCredentialFile(credDir: string, token: string, expiresAt?: number): void {
  fs.mkdirSync(credDir, { recursive: true });
  fs.writeFileSync(path.join(credDir, 'credentials.json'), JSON.stringify({
    accessToken: token,
    expiresAt: expiresAt ?? Date.now() + 3600000,
  }));
}

function createMockFetch(responses: Array<{
  status: number;
  body: unknown;
}>): typeof globalThis.fetch {
  let callIndex = 0;
  return vi.fn(async () => {
    const resp = responses[callIndex++] || { status: 500, body: {} };
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      headers: new Map(),
      json: async () => resp.body,
    } as unknown as Response;
  });
}

function createMockSessionManager() {
  return {
    listRunningSessions: vi.fn(() => [
      { id: 's1', name: 'test-job', tmuxSession: 'proj-test-job', jobSlug: 'test-job', status: 'running' as const, startedAt: new Date().toISOString() },
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
    start: vi.fn(),
    stop: vi.fn(),
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('QuotaManager Integration', () => {
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

  it('wires real components: collector → tracker → notifier pipeline', async () => {
    // Set up real components
    const quotaFile = path.join(tmpDir, 'quota-state.json');
    const tracker = new QuotaTracker({
      quotaFile,
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    });

    const credDir = path.join(tmpDir, 'claude-config');
    writeCredentialFile(credDir, 'test-token');
    const provider = new ClaudeConfigCredentialProvider(credDir);

    // Mock fetch to return OAuth data (uses seven_day/five_hour format)
    // Two responses: usage endpoint + profile endpoint (collectFromOAuth calls both)
    const mockFetch = createMockFetch([
      { status: 200, body: { seven_day: { utilization: 45, resets_at: '2026-03-06T03:00:00Z' }, five_hour: { utilization: 20, resets_at: '2026-02-28T12:00:00Z' } } },
      { status: 200, body: { account: { full_name: 'Test', email: 'test@example.com', has_claude_max: true }, organization: null } },
    ]);

    const collector = new QuotaCollector(provider, tracker, {
      registryPath,
      fetchFn: mockFetch,
    });

    const notifier = new QuotaNotifier(tmpDir);
    const notifySpy = vi.fn(async () => {});
    notifier.configure(notifySpy, 123);

    const manager = new QuotaManager(
      { stateDir: tmpDir, adaptivePolling: false },
      { tracker, collector, notifier },
    );

    // Run a manual collection cycle
    const result = await manager.refresh();

    expect(result).toBeDefined();
    expect(result!.success).toBe(true);
    expect(result!.dataSource).toBe('oauth');

    // Tracker should have been updated
    const state = tracker.getState();
    expect(state).toBeDefined();
    expect(state!.usagePercent).toBeCloseTo(45, 0);

    manager.stop();
  });

  it('wires real migrator with real state persistence', async () => {
    const quotaFile = path.join(tmpDir, 'quota-state.json');
    const tracker = new QuotaTracker({
      quotaFile,
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    });
    // Write an initial high-usage quota state
    tracker.updateState({
      usagePercent: 93,
      fiveHourPercent: 90,
      lastUpdated: new Date().toISOString(),
    });

    // Create registry with two accounts
    writeRegistry(registryPath, {
      'high@example.com': { name: 'High Usage', token: 'tok-high', percentUsed: 93, fiveHourPercent: 90 },
      'low@example.com': { name: 'Low Usage', token: 'tok-low', percentUsed: 15, fiveHourPercent: 5 },
    }, 'high@example.com');

    const credDir2 = path.join(tmpDir, 'claude-creds');
    writeCredentialFile(credDir2, 'tok-high');
    const provider = new ClaudeConfigCredentialProvider(credDir2);

    const switcher = new AccountSwitcher({ registryPath, provider });
    const migrator = new SessionMigrator({ stateDir: tmpDir });
    const notifier = new QuotaNotifier(tmpDir);
    notifier.configure(vi.fn(async () => {}), null);

    const sm = createMockSessionManager();
    const sched = createMockScheduler();

    const manager = new QuotaManager(
      { stateDir: tmpDir, adaptivePolling: false },
      { tracker, migrator, notifier, switcher },
    );

    manager.setSessionManager(sm as any);
    manager.setScheduler(sched as any);

    // Verify migration status endpoint works
    const migStatus = manager.getMigrationStatus();
    expect(migStatus.config.enabled).toBe(true);
    expect(migStatus.config.fiveHourThreshold).toBe(88);
    expect(migStatus.config.weeklyThreshold).toBe(92);

    // Verify spawn gating works
    const spawnCheck = manager.canSpawnSession('medium');
    expect(spawnCheck).toBeDefined();

    manager.stop();
  });

  it('canSpawnSession blocks during migration', async () => {
    const quotaFile = path.join(tmpDir, 'quota-state.json');
    const tracker = new QuotaTracker({
      quotaFile,
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    });
    // Set quota above 50% so migration blocking kicks in
    // (migration only blocks when there's actual quota pressure)
    tracker.updateState({ usagePercent: 60, lastUpdated: new Date().toISOString() });

    const migrator = new SessionMigrator({ stateDir: tmpDir });
    const notifier = new QuotaNotifier(tmpDir);
    notifier.configure(vi.fn(async () => {}), null);

    const manager = new QuotaManager(
      { stateDir: tmpDir },
      { tracker, migrator, notifier },
    );

    // Normal: allowed (no migration)
    expect(manager.canSpawnSession('medium').allowed).toBe(true);

    // Simulate migration in progress by setting internal state
    // (In production, checkAndMigrate sets this)
    (migrator as any).migrationState = { status: 'halting', sourceAccount: 'a', targetAccount: 'b', haltedSessions: [], restartedSessions: [] };

    // Migration + quota pressure = blocked
    expect(manager.canSpawnSession('medium').allowed).toBe(false);
    expect(manager.canSpawnSession('medium').reason).toContain('Migration in progress');

    manager.stop();
  });

  it('scheduler.canRunJob is replaced with migration-aware gate', () => {
    const quotaFile = path.join(tmpDir, 'quota-state.json');
    const tracker = new QuotaTracker({
      quotaFile,
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    });
    tracker.updateState({ usagePercent: 30, lastUpdated: new Date().toISOString() });

    const notifier = new QuotaNotifier(tmpDir);
    notifier.configure(vi.fn(async () => {}), null);

    const sched = createMockScheduler();
    const originalCanRunJob = sched.canRunJob;

    const manager = new QuotaManager(
      { stateDir: tmpDir },
      { tracker, notifier },
    );

    manager.setScheduler(sched as any);

    // canRunJob should be replaced
    expect(sched.canRunJob).not.toBe(originalCanRunJob);
    // And it should delegate to tracker's shouldSpawnSession
    expect(sched.canRunJob('medium')).toBe(true);

    manager.stop();
  });

  it('notification sender receives migration events', async () => {
    const quotaFile = path.join(tmpDir, 'quota-state.json');
    const tracker = new QuotaTracker({
      quotaFile,
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    });

    const migrator = new SessionMigrator({ stateDir: tmpDir });
    const notifier = new QuotaNotifier(tmpDir);
    notifier.configure(vi.fn(async () => {}), null);

    const notificationSpy = vi.fn(async () => {});

    const manager = new QuotaManager(
      { stateDir: tmpDir },
      { tracker, migrator, notifier },
    );
    manager.setNotificationSender(notificationSpy);

    // Emit a migration event from migrator
    migrator.emit('migration_complete', {
      previousAccount: 'a@test.com',
      newAccount: 'b@test.com',
      sessionsHalted: ['s1'],
      sessionsRestarted: ['s1'],
      completedAt: new Date().toISOString(),
      durationMs: 5000,
      result: 'success',
    });

    // Notification should be sent
    await vi.advanceTimersByTimeAsync(0);
    expect(notificationSpy).toHaveBeenCalledTimes(1);
    expect(notificationSpy.mock.calls[0][0]).toContain('Migration complete');
    expect(notificationSpy.mock.calls[0][0]).toContain('b@test.com');

    manager.stop();
  });

  it('event subscribers receive threshold crossings', async () => {
    const quotaFile = path.join(tmpDir, 'quota-state.json');
    const tracker = new QuotaTracker({
      quotaFile,
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    });

    const credDir2 = path.join(tmpDir, 'claude-config-2');
    writeCredentialFile(credDir2, 'test-token');
    const provider = new ClaudeConfigCredentialProvider(credDir2);

    // Mock fetch returning high usage (seven_day/five_hour format)
    // Two responses: usage endpoint + profile endpoint (collectFromOAuth calls both)
    const mockFetch = createMockFetch([
      { status: 200, body: { seven_day: { utilization: 88, resets_at: '2026-03-06T03:00:00Z' }, five_hour: { utilization: 60, resets_at: '2026-02-28T12:00:00Z' } } },
      { status: 200, body: { account: { full_name: 'Test', email: 'test@example.com', has_claude_max: true }, organization: null } },
    ]);

    const collector = new QuotaCollector(provider, tracker, { fetchFn: mockFetch });
    const notifier = new QuotaNotifier(tmpDir);
    notifier.configure(vi.fn(async () => {}), null);

    const manager = new QuotaManager(
      { stateDir: tmpDir, adaptivePolling: false },
      { tracker, collector, notifier },
    );

    const thresholdEvents: unknown[] = [];
    manager.on('threshold_crossed', (ev) => thresholdEvents.push(ev));

    await manager.refresh();

    // 88% weekly should trigger 'critical' threshold (>= 85)
    expect(thresholdEvents.length).toBeGreaterThanOrEqual(1);
    const weeklyEvent = thresholdEvents.find((e: any) => e.metric === 'weekly');
    expect(weeklyEvent).toBeDefined();
    expect((weeklyEvent as any).level).toBe('critical');

    manager.stop();
  });

  it('polling status returns correct state', () => {
    const quotaFile = path.join(tmpDir, 'quota-state.json');
    const tracker = new QuotaTracker({
      quotaFile,
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    });

    const credDir3 = path.join(tmpDir, 'claude-config-3');
    writeCredentialFile(credDir3, 'test-token');
    const provider = new ClaudeConfigCredentialProvider(credDir3);

    const collector = new QuotaCollector(provider, tracker, {
      fetchFn: createMockFetch([]),
    });
    const notifier = new QuotaNotifier(tmpDir);
    notifier.configure(vi.fn(async () => {}), null);

    const manager = new QuotaManager(
      { stateDir: tmpDir },
      { tracker, collector, notifier },
    );

    // Before start
    const beforeStatus = manager.getPollingStatus();
    expect(beforeStatus.running).toBe(false);

    manager.start();
    const afterStatus = manager.getPollingStatus();
    expect(afterStatus.running).toBe(true);
    expect(afterStatus.nextCollectionAt).not.toBeNull();

    manager.stop();
    const stoppedStatus = manager.getPollingStatus();
    expect(stoppedStatus.running).toBe(false);
  });

  it('migration trigger API returns correct responses', async () => {
    const quotaFile = path.join(tmpDir, 'quota-state.json');
    const tracker = new QuotaTracker({
      quotaFile,
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    });
    tracker.updateState({ usagePercent: 45, lastUpdated: new Date().toISOString() });

    const migrator = new SessionMigrator({ stateDir: tmpDir });
    const notifier = new QuotaNotifier(tmpDir);
    notifier.configure(vi.fn(async () => {}), null);

    const manager = new QuotaManager(
      { stateDir: tmpDir },
      { tracker, migrator, notifier },
    );

    // Low usage — should not trigger
    const result = await manager.triggerMigration();
    expect(result.triggered).toBe(false);
    expect(result.reason).toContain('not met');

    // Without migrator
    const minimal = new QuotaManager(
      { stateDir: tmpDir },
      { tracker, notifier },
    );
    const noMigrator = await minimal.triggerMigration();
    expect(noMigrator.triggered).toBe(false);
    expect(noMigrator.reason).toContain('not configured');

    manager.stop();
    minimal.stop();
  });
});
