/**
 * Integration tests — QuotaManager → SessionMigrator → notification wiring.
 *
 * Verifies that enforcement events (enforced_pause, enforced_kill, migration_no_target)
 * correctly trigger enqueueNotification via the QuotaManager's migrator event listeners.
 *
 * Uses real SessionMigrator with mock deps. QuotaManager is constructed with minimal
 * components (tracker + notifier stubs), with the migrator wired via constructor.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionMigrator } from '../../src/monitoring/SessionMigrator.js';
import { QuotaManager } from '../../src/monitoring/QuotaManager.js';
import type {
  SessionMigratorDeps,
  AccountSnapshot,
  HaltableSession,
} from '../../src/monitoring/SessionMigrator.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Helpers ──────────────────────────────────────────────────────────

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qe-integ-'));
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

function createHaltableSession(overrides?: Partial<HaltableSession>): HaltableSession {
  return {
    id: `session-${Math.random().toString(36).slice(2, 8)}`,
    tmuxSession: `test-session-${Math.random().toString(36).slice(2, 8)}`,
    jobSlug: 'test-job',
    name: 'test session',
    ...overrides,
  };
}

/** Minimal QuotaTracker stub that satisfies the QuotaManager constructor. */
function createMockTracker() {
  return {
    getState: vi.fn(() => null),
    update: vi.fn(),
    shouldSpawnSession: vi.fn(() => ({ allowed: true, reason: 'ok' })),
  } as any;
}

/** Minimal QuotaNotifier stub. */
function createMockNotifier() {
  return {
    checkAndNotify: vi.fn(async () => {}),
  } as any;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('QuotaManager → SessionMigrator notification wiring', () => {
  let tmpDir: string;
  let migrator: SessionMigrator;
  let quotaManager: QuotaManager;
  let notificationsSent: string[];
  let mockSender: (message: string) => Promise<void>;

  beforeEach(() => {
    tmpDir = createTmpDir();
    migrator = new SessionMigrator({
      stateDir: tmpDir,
      thresholds: { gracePeriodMs: 10 },
    });

    const tracker = createMockTracker();
    const notifier = createMockNotifier();

    quotaManager = new QuotaManager(
      { stateDir: tmpDir },
      { tracker, notifier, migrator },
    );

    // Capture notifications
    notificationsSent = [];
    mockSender = vi.fn(async (message: string) => {
      notificationsSent.push(message);
    });
    quotaManager.setNotificationSender(mockSender);
  });

  afterEach(() => {
    quotaManager.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. enforced_pause notification ──

  it('sends notification on enforced_pause (90% quota, no alternative)', async () => {
    const session = createHaltableSession({ jobSlug: 'job-a' });
    const deps = createMockDeps({
      getAccountStatuses: vi.fn(() => []),
      listRunningSessions: vi.fn(() => [session]),
    });
    migrator.setDeps(deps);

    await migrator.checkAndMigrate({
      percentUsed: 50,
      fiveHourPercent: 92,
      activeAccountEmail: 'active@test.io',
    });

    // Wait for async notification
    await vi.waitFor(() => {
      expect(notificationsSent.length).toBeGreaterThanOrEqual(1);
    });

    const msg = notificationsSent.find(m => m.includes('PAUSE WARNING'));
    expect(msg).toBeDefined();
    expect(msg).toContain('92%');
    expect(msg).toContain('1 session');
    expect(msg).toContain('Scheduler paused');
  });

  // ── 2. enforced_kill notification ──

  it('sends notification on enforced_kill (95% quota, no alternative)', async () => {
    const sessions = [
      createHaltableSession({ id: 's1', jobSlug: 'alpha' }),
      createHaltableSession({ id: 's2', jobSlug: 'beta' }),
    ];
    const deps = createMockDeps({
      getAccountStatuses: vi.fn(() => []),
      listRunningSessions: vi.fn(() => sessions),
      isSessionAlive: vi.fn(() => true),
    });
    migrator.setDeps(deps);

    await migrator.checkAndMigrate({
      percentUsed: 50,
      fiveHourPercent: 97,
      activeAccountEmail: 'active@test.io',
    });

    await vi.waitFor(() => {
      expect(notificationsSent.length).toBeGreaterThanOrEqual(1);
    });

    const msg = notificationsSent.find(m => m.includes('EMERGENCY STOP'));
    expect(msg).toBeDefined();
    expect(msg).toContain('97%');
    expect(msg).toContain('Killed 2 session(s)');
    expect(msg).toContain('alpha');
    expect(msg).toContain('beta');
    expect(msg).toContain('Manual intervention required');
  });

  // ── 3. migration_no_target notification ──

  it('sends notification on migration_no_target (below 90%, no alternative)', async () => {
    const deps = createMockDeps({
      getAccountStatuses: vi.fn(() => []),
    });
    migrator.setDeps(deps);

    await migrator.checkAndMigrate({
      percentUsed: 50,
      fiveHourPercent: 89,
      activeAccountEmail: 'active@test.io',
    });

    await vi.waitFor(() => {
      expect(notificationsSent.length).toBeGreaterThanOrEqual(1);
    });

    const msg = notificationsSent.find(m => m.includes('no alternative account'));
    expect(msg).toBeDefined();
    expect(msg).toContain('Enforcement will activate at 90%');
  });

  // ── 4. Full escalation scenario ──

  it('full escalation: no_target → enforced_pause → enforced_kill', async () => {
    const session = createHaltableSession({ id: 's1', jobSlug: 'worker' });

    const deps = createMockDeps({
      getAccountStatuses: vi.fn(() => []),
      listRunningSessions: vi.fn(() => [session]),
      isSessionAlive: vi.fn(() => true),
    });
    migrator.setDeps(deps);

    // Step 1: 88% → migration_no_target
    await migrator.checkAndMigrate({
      percentUsed: 50,
      fiveHourPercent: 88,
      activeAccountEmail: 'active@test.io',
    });

    await vi.waitFor(() => {
      expect(notificationsSent.length).toBeGreaterThanOrEqual(1);
    });

    const noTargetMsg = notificationsSent.find(m => m.includes('no alternative'));
    expect(noTargetMsg).toBeDefined();

    // Step 2: 90% → enforced_pause (needs to bypass cooldown — it won't since
    // the last event was no_alternative, which is covered by cooldown. We need
    // to advance past the cooldown for the next call to work. Use a fresh migrator
    // with very short cooldown.)
    const tmpDir2 = createTmpDir();
    const migrator2 = new SessionMigrator({
      stateDir: tmpDir2,
      thresholds: { gracePeriodMs: 10, cooldownMs: 0 }, // No cooldown for test
    });

    const quotaManager2 = new QuotaManager(
      { stateDir: tmpDir2 },
      { tracker: createMockTracker(), notifier: createMockNotifier(), migrator: migrator2 },
    );
    const notifications2: string[] = [];
    quotaManager2.setNotificationSender(async (msg) => { notifications2.push(msg); });
    migrator2.setDeps(deps);

    // 88% → no_target
    await migrator2.checkAndMigrate({
      percentUsed: 50,
      fiveHourPercent: 88,
      activeAccountEmail: 'active@test.io',
    });

    // 90% → enforced_pause
    await migrator2.checkAndMigrate({
      percentUsed: 50,
      fiveHourPercent: 90,
      activeAccountEmail: 'active@test.io',
    });

    // 95% → enforced_kill (bypass cooldown since last was enforced_pause)
    await migrator2.checkAndMigrate({
      percentUsed: 50,
      fiveHourPercent: 96,
      activeAccountEmail: 'active@test.io',
    });

    await vi.waitFor(() => {
      expect(notifications2.length).toBeGreaterThanOrEqual(3);
    });

    // Check all three messages arrived in order
    expect(notifications2[0]).toContain('no alternative');
    expect(notifications2[1]).toContain('PAUSE WARNING');
    expect(notifications2[2]).toContain('EMERGENCY STOP');

    // Cleanup
    quotaManager2.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  });
});
