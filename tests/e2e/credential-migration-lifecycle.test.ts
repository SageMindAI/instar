/**
 * E2E lifecycle test — complete credential migration flow.
 *
 * Simulates the full migration scenario that Phase 1 enables:
 *   1. Multiple accounts registered with different utilization levels
 *   2. Active account hits quota threshold
 *   3. System selects best migration target
 *   4. Running sessions are halted and reassigned to new account
 *   5. All state remains consistent throughout
 *
 * Tests real components end-to-end with real file operations.
 * No mocks — only external services (Keychain, APIs) are absent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AccountSwitcher } from '../../src/monitoring/AccountSwitcher.js';
import { ClaudeConfigCredentialProvider } from '../../src/monitoring/CredentialProvider.js';
import { SessionCredentialManager } from '../../src/monitoring/SessionCredentialManager.js';
import { QuotaTracker } from '../../src/monitoring/QuotaTracker.js';
import { QuotaNotifier } from '../../src/monitoring/QuotaNotifier.js';
import type { QuotaState, JobSchedulerConfig } from '../../src/core/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Test Helpers ────────────────────────────────────────────────────

const thresholds: JobSchedulerConfig['quotaThresholds'] = {
  normal: 50,
  elevated: 70,
  critical: 85,
  shutdown: 95,
};

const MIGRATION_WEEKLY_THRESHOLD = 92;
const MIGRATION_FIVE_HOUR_THRESHOLD = 88;

interface TestAccount {
  name: string;
  token: string;
  percentUsed: number;
  fiveHourUtilization: number;
  expiresAt?: number;
}

function writeRegistry(
  registryPath: string,
  accounts: Record<string, TestAccount>,
  activeEmail: string | null,
): void {
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
        weeklyUtilization: info.percentUsed,
        fiveHourUtilization: info.fiveHourUtilization,
        weeklyResetsAt: new Date(Date.now() + 86400000).toISOString(),
        fiveHourResetsAt: new Date(Date.now() + 18000000).toISOString(),
        sonnetUtilization: info.percentUsed,
        percentUsed: info.percentUsed,
        canRunPriority: info.percentUsed >= 95 ? 'none' : info.percentUsed >= 85 ? 'critical-only' : 'all',
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

function shouldMigrate(quotaState: QuotaState): boolean {
  const weekly = quotaState.usagePercent;
  const fiveHour = quotaState.fiveHourPercent;
  if (weekly >= MIGRATION_WEEKLY_THRESHOLD) return true;
  if (typeof fiveHour === 'number' && fiveHour >= MIGRATION_FIVE_HOUR_THRESHOLD) return true;
  return false;
}

function selectBestTarget(
  switcher: AccountSwitcher,
  activeEmail: string,
): { email: string; accessToken: string; expiresAt: number } | null {
  const statuses = switcher.getAccountStatuses();
  const candidates = statuses
    .filter(s => s.email !== activeEmail && !s.isStale && !s.tokenExpired && s.hasToken && s.weeklyPercent <= 80)
    .sort((a, b) => a.weeklyPercent - b.weeklyPercent);

  if (candidates.length === 0) return null;

  const best = candidates[0];
  return switcher.getAccountCredentials(best.email);
}

// ── Lifecycle Test ──────────────────────────────────────────────────

describe('Credential Migration Lifecycle (e2e)', () => {
  let tmpDir: string;
  let registryPath: string;
  let credDir: string;
  let quotaFile: string;
  let notifierStateDir: string;
  let provider: ClaudeConfigCredentialProvider;
  let switcher: AccountSwitcher;
  let credManager: SessionCredentialManager;
  let quotaTracker: QuotaTracker;
  let notifier: QuotaNotifier;
  let notifications: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-e2e-'));
    registryPath = path.join(tmpDir, 'account-registry.json');
    credDir = path.join(tmpDir, 'claude-config');
    quotaFile = path.join(tmpDir, 'quota-state.json');
    notifierStateDir = path.join(tmpDir, 'notifier');
    fs.mkdirSync(credDir, { recursive: true });
    fs.mkdirSync(notifierStateDir, { recursive: true });

    provider = new ClaudeConfigCredentialProvider(credDir);
    switcher = new AccountSwitcher({ registryPath, provider });
    credManager = new SessionCredentialManager();
    quotaTracker = new QuotaTracker({ quotaFile, thresholds });
    notifier = new QuotaNotifier(notifierStateDir);

    // Capture notifications instead of sending to Telegram
    notifications = [];
    notifier.configure(
      async (_topicId: number, text: string) => { notifications.push(text); },
      1 // dummy topic ID
    );
  });

  afterEach(() => {
    credManager.clear();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('complete migration lifecycle: detect → select → halt → switch → verify', async () => {
    // ── SETUP: 3 accounts, Dawn is active and near quota ──
    writeRegistry(registryPath, {
      'dawn@sagemindai.io': {
        name: 'Dawn',
        token: 'dawn-token-original',
        percentUsed: 93,
        fiveHourUtilization: 45,
      },
      'justin@sagemindai.io': {
        name: 'Justin',
        token: 'justin-token-fresh',
        percentUsed: 25,
        fiveHourUtilization: 10,
      },
      'backup@sagemindai.io': {
        name: 'Backup',
        token: 'backup-token',
        percentUsed: 60,
        fiveHourUtilization: 30,
      },
    }, 'dawn@sagemindai.io');

    // Write quota state reflecting Dawn's utilization
    quotaTracker.updateState({
      usagePercent: 93,
      fiveHourPercent: 45,
      lastUpdated: new Date().toISOString(),
    });

    // ── STEP 1: Detect migration needed ──
    const state = quotaTracker.getState()!;
    expect(shouldMigrate(state)).toBe(true);

    // QuotaTracker should block most jobs at 93%
    expect(quotaTracker.canRunJob('low')).toBe(false);
    expect(quotaTracker.canRunJob('medium')).toBe(false);
    expect(quotaTracker.canRunJob('high')).toBe(false);
    expect(quotaTracker.canRunJob('critical')).toBe(true);

    // Notification should fire
    await notifier.checkAndNotify(state);
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications.some(n => n.includes('high-priority') || n.includes('quota limit'))).toBe(true);

    // ── STEP 2: Simulate running sessions on Dawn's account ──
    const dawnCreds = switcher.getAccountCredentials('dawn');
    expect(dawnCreds).not.toBeNull();

    credManager.assignAccount('job-session-1', dawnCreds!.email, {
      accessToken: dawnCreds!.accessToken,
      expiresAt: dawnCreds!.expiresAt,
    });
    credManager.assignAccount('job-session-2', dawnCreds!.email, {
      accessToken: dawnCreds!.accessToken,
      expiresAt: dawnCreds!.expiresAt,
    });
    credManager.assignAccount('interactive-session', dawnCreds!.email, {
      accessToken: dawnCreds!.accessToken,
      expiresAt: dawnCreds!.expiresAt,
    });

    expect(credManager.getSessionsForAccount('dawn@sagemindai.io')).toHaveLength(3);
    expect(credManager.activeCount).toBe(3);

    // ── STEP 3: Select migration target ──
    const target = selectBestTarget(switcher, 'dawn@sagemindai.io');
    expect(target).not.toBeNull();
    expect(target!.email).toBe('justin@sagemindai.io'); // Lowest at 25%
    expect(target!.accessToken).toBe('justin-token-fresh');

    // ── STEP 4: Halt all sessions (simulate graceful shutdown) ──
    const haltedSessions = credManager.getAllAssignments().map(a => ({
      sessionId: a.sessionId,
      email: a.email,
      haltedAt: new Date().toISOString(),
    }));
    expect(haltedSessions).toHaveLength(3);

    // Release all Dawn sessions
    for (const halted of haltedSessions) {
      credManager.releaseSession(halted.sessionId);
    }
    expect(credManager.activeCount).toBe(0);

    // ── STEP 5: Reassign all sessions to Justin's account ──
    for (const halted of haltedSessions) {
      credManager.assignAccount(halted.sessionId, target!.email, {
        accessToken: target!.accessToken,
        expiresAt: target!.expiresAt,
      });
    }

    // ── STEP 6: Verify all sessions are now on Justin's account ──
    expect(credManager.activeCount).toBe(3);
    expect(credManager.getSessionsForAccount('justin@sagemindai.io')).toHaveLength(3);
    expect(credManager.getSessionsForAccount('dawn@sagemindai.io')).toHaveLength(0);

    for (const halted of haltedSessions) {
      const env = credManager.getSessionEnv(halted.sessionId);
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('justin-token-fresh');
      expect(env.CLAUDE_ACCOUNT_EMAIL).toBe('justin@sagemindai.io');
    }

    // ── STEP 7: Global state integrity — registry untouched ──
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    expect(registry.activeAccountEmail).toBe('dawn@sagemindai.io'); // NOT switched globally

    // ── STEP 8: Update quota to reflect new account ──
    quotaTracker.updateState({
      usagePercent: 25,
      fiveHourPercent: 10,
      lastUpdated: new Date().toISOString(),
    });

    // Should now allow all jobs
    expect(quotaTracker.canRunJob('low')).toBe(true);
    expect(quotaTracker.canRunJob('critical')).toBe(true);
    expect(shouldMigrate(quotaTracker.getState()!)).toBe(false);
  });

  it('no migration when all alternatives are too high', async () => {
    writeRegistry(registryPath, {
      'dawn@sagemindai.io': {
        name: 'Dawn',
        token: 'dawn-token',
        percentUsed: 94,
        fiveHourUtilization: 50,
      },
      'justin@sagemindai.io': {
        name: 'Justin',
        token: 'justin-token',
        percentUsed: 85, // above 80% threshold — not a valid target
        fiveHourUtilization: 70,
      },
    }, 'dawn@sagemindai.io');

    quotaTracker.updateState({
      usagePercent: 94,
      lastUpdated: new Date().toISOString(),
    });

    // Migration IS needed
    expect(shouldMigrate(quotaTracker.getState()!)).toBe(true);

    // But no valid target exists (Justin at 85% > 80% max)
    const target = selectBestTarget(switcher, 'dawn@sagemindai.io');
    expect(target).toBeNull();

    // System continues running on exhausted account — load-shedding only
    expect(quotaTracker.canRunJob('low')).toBe(false);
    expect(quotaTracker.canRunJob('critical')).toBe(true);
  });

  it('migration triggered by 5-hour rate limit, not weekly', async () => {
    writeRegistry(registryPath, {
      'dawn@sagemindai.io': {
        name: 'Dawn',
        token: 'dawn-token',
        percentUsed: 60, // weekly is fine
        fiveHourUtilization: 90, // but 5-hour is critical
      },
      'justin@sagemindai.io': {
        name: 'Justin',
        token: 'justin-token',
        percentUsed: 20,
        fiveHourUtilization: 5,
      },
    }, 'dawn@sagemindai.io');

    quotaTracker.updateState({
      usagePercent: 60,
      fiveHourPercent: 90,
      lastUpdated: new Date().toISOString(),
    });

    // 5-hour at 90% triggers migration even though weekly is fine
    expect(shouldMigrate(quotaTracker.getState()!)).toBe(true);

    // 5-hour at 90% should block non-critical spawns
    expect(quotaTracker.canRunJob('low')).toBe(false);
    expect(quotaTracker.canRunJob('critical')).toBe(true);

    // Migration target exists
    const target = selectBestTarget(switcher, 'dawn@sagemindai.io');
    expect(target).not.toBeNull();
    expect(target!.email).toBe('justin@sagemindai.io');
  });

  it('expired tokens are excluded from migration targets', async () => {
    writeRegistry(registryPath, {
      'dawn@sagemindai.io': {
        name: 'Dawn',
        token: 'dawn-token',
        percentUsed: 95,
        fiveHourUtilization: 50,
      },
      'expired@example.com': {
        name: 'Expired Account',
        token: 'expired-token',
        percentUsed: 10,
        fiveHourUtilization: 5,
        expiresAt: Date.now() - 3600000, // expired 1 hour ago
      },
      'valid@example.com': {
        name: 'Valid Account',
        token: 'valid-token',
        percentUsed: 40,
        fiveHourUtilization: 20,
      },
    }, 'dawn@sagemindai.io');

    // Expired account would be best (10%) but is excluded
    const target = selectBestTarget(switcher, 'dawn@sagemindai.io');
    expect(target).not.toBeNull();
    expect(target!.email).toBe('valid@example.com'); // 40%, not expired
  });

  it('quota notifications fire correctly throughout migration', async () => {
    writeRegistry(registryPath, {
      'dawn@sagemindai.io': {
        name: 'Dawn',
        token: 'dawn-token',
        percentUsed: 93,
        fiveHourUtilization: 45,
      },
    }, 'dawn@sagemindai.io');

    // Check notifications at different levels
    const states: QuotaState[] = [
      { usagePercent: 65, lastUpdated: new Date().toISOString() },   // Below all thresholds
      { usagePercent: 78, lastUpdated: new Date().toISOString() },   // Warning (75%+)
      { usagePercent: 88, lastUpdated: new Date().toISOString() },   // Critical
      { usagePercent: 96, lastUpdated: new Date().toISOString() },   // Limit
    ];

    for (const state of states) {
      // Need new notifier instances to reset threshold tracking
      // (real notifier deduplicates, which is correct behavior)
      await notifier.checkAndNotify(state);
    }

    // Should have notifications for warning, critical, and limit crossings
    expect(notifications.length).toBe(3); // warning, critical, limit
    expect(notifications[0]).toContain('Low-priority jobs');
    expect(notifications[1]).toContain('high-priority');
    expect(notifications[2]).toContain('quota limit');
  });

  it('registry file permissions maintained throughout lifecycle', async () => {
    writeRegistry(registryPath, {
      'dawn@sagemindai.io': {
        name: 'Dawn',
        token: 'dawn-token',
        percentUsed: 50,
        fiveHourUtilization: 30,
      },
      'justin@sagemindai.io': {
        name: 'Justin',
        token: 'justin-token',
        percentUsed: 20,
        fiveHourUtilization: 10,
      },
    }, 'dawn@sagemindai.io');

    expect(fs.statSync(registryPath).mode & 0o777).toBe(0o600);

    // Switch account — registry gets rewritten
    await switcher.switchAccount('justin');
    expect(fs.statSync(registryPath).mode & 0o777).toBe(0o600);

    // Switch back
    await switcher.switchAccount('dawn');
    expect(fs.statSync(registryPath).mode & 0o777).toBe(0o600);

    // Credential file also enforced
    const credFile = path.join(credDir, 'credentials.json');
    if (fs.existsSync(credFile)) {
      expect(fs.statSync(credFile).mode & 0o777).toBe(0o600);
    }
  });
});
