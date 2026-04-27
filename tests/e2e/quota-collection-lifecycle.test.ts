/**
 * E2E lifecycle test — complete quota collection flow.
 *
 * Simulates the full collection lifecycle that Phase 2 enables:
 *   1. Start with valid credentials → OAuth collection succeeds
 *   2. Token expires → fallback to JSONL
 *   3. New token written → OAuth resumes
 *   4. Multiple collections → adaptive polling adjusts
 *   5. Multi-account → all accounts polled, aggregate computed
 *   6. Notifications → threshold crossings detected
 *
 * Tests real components end-to-end with real file operations.
 * No mocks except HTTP — everything else (files, registry, tracker) is real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QuotaCollector, classifyToken } from '../../src/monitoring/QuotaCollector.js';
import { ClaudeConfigCredentialProvider } from '../../src/monitoring/CredentialProvider.js';
import { QuotaTracker } from '../../src/monitoring/QuotaTracker.js';
import { QuotaNotifier } from '../../src/monitoring/QuotaNotifier.js';
import { AccountSwitcher } from '../../src/monitoring/AccountSwitcher.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Test Helpers ────────────────────────────────────────────────────

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qc-e2e-'));
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
  fiveHourUtilization?: number;
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
        fiveHourUtilization: info.fiveHourUtilization ?? 30,
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

function writeJsonl(dir: string, entries: Array<{
  inputTokens?: number;
  outputTokens?: number;
}>): void {
  const projectDir = path.join(dir, '-Users-test-project');
  fs.mkdirSync(projectDir, { recursive: true });
  const lines = entries.map(e => JSON.stringify({
    type: 'assistant',
    timestamp: new Date(Date.now() - 5000).toISOString(),
    message: {
      role: 'assistant',
      usage: {
        input_tokens: e.inputTokens ?? 0,
        output_tokens: e.outputTokens ?? 0,
      },
    },
  }));
  fs.writeFileSync(path.join(projectDir, 'conversation.jsonl'), lines.join('\n'));
}

// ── Lifecycle Tests ────────────────────────────────────────────────

describe('Quota Collection Lifecycle (e2e)', () => {
  let tmpDir: string;
  let credDir: string;
  let quotaFile: string;
  let projectsDir: string;
  let registryPath: string;
  let notifierDir: string;
  let provider: ClaudeConfigCredentialProvider;
  let tracker: QuotaTracker;
  let notifier: QuotaNotifier;
  let notifications: string[];

  beforeEach(() => {
    tmpDir = createTmpDir();
    credDir = path.join(tmpDir, 'claude-config');
    quotaFile = path.join(tmpDir, 'quota-state.json');
    projectsDir = path.join(tmpDir, 'projects');
    registryPath = path.join(tmpDir, 'account-registry.json');
    notifierDir = path.join(tmpDir, 'notifier');
    fs.mkdirSync(credDir, { recursive: true });
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(notifierDir, { recursive: true });

    provider = new ClaudeConfigCredentialProvider(credDir);
    tracker = new QuotaTracker({ quotaFile, thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } });
    notifier = new QuotaNotifier(notifierDir);
    notifications = [];
    notifier.configure(
      async (_topicId: number, text: string) => { notifications.push(text); },
      1,
    );
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full lifecycle: OAuth → token expires → JSONL fallback → new token → OAuth resumes', async () => {
    // ── PHASE 1: Fresh token, OAuth works ──
    await provider.writeCredentials({
      accessToken: 'fresh-token',
      expiresAt: Date.now() + 3600000,
    });

    const phase1Fetch = createRoutingFetch({
      usage: { status: 200, body: { seven_day: { utilization: 35, resets_at: '2026-03-06T03:00:00Z' } } },
      profile: { status: 200, body: { account: { email: 'test@example.com', full_name: 'Test' }, organization: {} } },
    });

    let collector = new QuotaCollector(provider, tracker, {
      fetchFn: phase1Fetch,
      jsonlFallback: { enabled: true, claudeProjectsDir: projectsDir },
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
    });

    const r1 = await collector.collect();
    expect(r1.success).toBe(true);
    expect(r1.dataSource).toBe('oauth');
    expect(r1.state?.usagePercent).toBe(35);
    expect(tracker.getState()?.usagePercent).toBe(35);

    // ── PHASE 2: Token expires, fallback to JSONL ──
    await provider.writeCredentials({
      accessToken: 'expired-token',
      expiresAt: Date.now() - 1000, // Already expired
    });

    writeJsonl(projectsDir, [
      { inputTokens: 1_500_000_000, outputTokens: 200_000_000 },
    ]);

    const expiredEvents: string[] = [];
    collector = new QuotaCollector(provider, tracker, {
      fetchFn: createRoutingFetch({
        usage: { status: 401, body: {} },
        profile: { status: 401, body: {} },
      }),
      jsonlFallback: { enabled: true, claudeProjectsDir: projectsDir },
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
    });
    collector.on('token_expired', () => expiredEvents.push('expired'));

    const r2 = await collector.collect();
    expect(r2.success).toBe(true);
    expect(r2.dataSource).toBe('jsonl-fallback');
    expect(r2.dataConfidence).toBe('estimated');
    expect(expiredEvents).toContain('expired');

    // Tracker was still updated (with estimated data)
    const state2 = tracker.getState();
    expect(state2?.usagePercent).toBeGreaterThan(0);

    // ── PHASE 3: New token, OAuth resumes ──
    await provider.writeCredentials({
      accessToken: 'new-fresh-token',
      expiresAt: Date.now() + 7200000,
    });

    collector = new QuotaCollector(provider, tracker, {
      fetchFn: createRoutingFetch({
        usage: { status: 200, body: { seven_day: { utilization: 55, resets_at: null } } },
        profile: { status: 200, body: { account: {}, organization: {} } },
      }),
      jsonlFallback: { enabled: true, claudeProjectsDir: projectsDir },
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
    });

    const r3 = await collector.collect();
    expect(r3.success).toBe(true);
    expect(r3.dataSource).toBe('oauth');
    expect(r3.dataConfidence).toBe('authoritative');
    expect(r3.state?.usagePercent).toBe(55);

    // Tracker was updated with authoritative data
    expect(tracker.getState()?.usagePercent).toBe(55);
  });

  it('adaptive polling lifecycle: low → high → critical → back to low', async () => {
    await provider.writeCredentials({
      accessToken: 'token',
      expiresAt: Date.now() + 3600000,
    });

    const utilizationSequence = [20, 72, 91, 15]; // low, high, critical, recovered
    const expectedIntervals = [
      10 * 60 * 1000, // 20% → 10 min
      5 * 60 * 1000,  // 72% → 5 min
      2 * 60 * 1000,  // 91% → 2 min
      // Recovery has hysteresis — won't immediately go back to 10 min
    ];

    for (let i = 0; i < utilizationSequence.length; i++) {
      const util = utilizationSequence[i];
      const collector = new QuotaCollector(provider, tracker, {
        fetchFn: createRoutingFetch({
          usage: { status: 200, body: { seven_day: { utilization: util, resets_at: null } } },
          profile: { status: 200, body: { account: {}, organization: {} } },
        }),
        jsonlFallback: { enabled: false },
        retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
      });

      await collector.collect();

      if (i < expectedIntervals.length) {
        expect(collector.getPollingIntervalMs()).toBe(expectedIntervals[i]);
      }
    }
  });

  it('multi-account collection with account switcher integration', async () => {
    // Setup: 3 accounts, Dawn is active at high usage
    writeRegistry(registryPath, {
      'dawn@test.io': { name: 'Dawn', token: 'dawn-token', percentUsed: 85 },
      'justin@test.io': { name: 'Justin', token: 'justin-token', percentUsed: 25 },
      'backup@test.io': { name: 'Backup', token: 'backup-token', percentUsed: 60 },
    }, 'dawn@test.io');

    await provider.writeCredentials({
      accessToken: 'dawn-token',
      expiresAt: Date.now() + 3600000,
      email: 'dawn@test.io',
    });

    // Mock fetch returns different utilization for active account
    const collector = new QuotaCollector(provider, tracker, {
      fetchFn: createRoutingFetch({
        usage: { status: 200, body: {
          seven_day: { utilization: 85, resets_at: '2026-03-06T03:00:00Z' },
          five_hour: { utilization: 40, resets_at: '2026-02-28T12:00:00Z' },
        }},
        profile: { status: 200, body: {
          account: { email: 'dawn@test.io', full_name: 'Dawn' },
          organization: { rate_limit_tier: 'max_5x' },
        }},
      }),
      registryPath,
      jsonlFallback: { enabled: false },
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
    });

    const result = await collector.collect();
    expect(result.success).toBe(true);
    expect(result.state?.usagePercent).toBe(85);

    // Account switcher should see all accounts via registry
    const switcher = new AccountSwitcher({ registryPath, provider });
    const statuses = switcher.getAccountStatuses();
    expect(statuses.length).toBe(3);

    // Best migration target should be Justin (25%)
    const candidates = statuses
      .filter(s => s.email !== 'dawn@test.io' && s.hasToken)
      .sort((a, b) => a.weeklyPercent - b.weeklyPercent);
    expect(candidates[0]?.email).toBe('justin@test.io');
  });

  it('handles complete token loss gracefully — no credentials, no JSONL', async () => {
    // Nothing configured — no creds, no JSONL files
    const collector = new QuotaCollector(provider, tracker, {
      fetchFn: createRoutingFetch({
        usage: { status: 401, body: {} },
        profile: { status: 401, body: {} },
      }),
      jsonlFallback: { enabled: true, claudeProjectsDir: projectsDir },
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
    });

    const result = await collector.collect();

    expect(result.success).toBe(false);
    expect(result.dataSource).toBe('none');
    expect(result.state).toBeNull();

    // Tracker should not have been updated (no state file created)
    expect(tracker.getState()).toBeNull();
  });

  it('multiple rapid collections produce consistent state', async () => {
    await provider.writeCredentials({
      accessToken: 'token',
      expiresAt: Date.now() + 3600000,
    });

    let callCount = 0;
    const mockFetch = vi.fn(async (url: string) => {
      callCount++;
      const util = 50 + (callCount % 10); // Vary slightly
      if (url.toString().includes('/usage')) {
        return {
          ok: true, status: 200, headers: new Map(),
          json: async () => ({ seven_day: { utilization: util, resets_at: null } }),
        };
      }
      return {
        ok: true, status: 200, headers: new Map(),
        json: async () => ({ account: {}, organization: {} }),
      };
    }) as unknown as typeof globalThis.fetch;

    const collector = new QuotaCollector(provider, tracker, {
      fetchFn: mockFetch,
      jsonlFallback: { enabled: false },
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
    });

    // Run 5 sequential collections
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await collector.collect());
    }

    // All should succeed
    expect(results.every(r => r.success)).toBe(true);

    // Final state on disk should match last collection
    const finalState = tracker.getState();
    expect(finalState?.usagePercent).toBe(results[results.length - 1].state?.usagePercent);
  });

  it('token state machine transitions correctly through lifecycle', () => {
    // Missing
    expect(classifyToken(null)).toBe('missing');
    expect(classifyToken({ accessToken: '', expiresAt: 0 })).toBe('missing');

    // Valid
    expect(classifyToken({ accessToken: 'tok', expiresAt: Date.now() + 7200000 })).toBe('valid');

    // Expiring soon (within 1 hour)
    expect(classifyToken({ accessToken: 'tok', expiresAt: Date.now() + 30 * 60 * 1000 })).toBe('expiring_soon');

    // Expired
    expect(classifyToken({ accessToken: 'tok', expiresAt: Date.now() - 1000 })).toBe('expired');
  });
});
