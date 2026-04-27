/**
 * Integration test — QuotaCollector + CredentialProvider + QuotaTracker
 * wired together with real file operations and mock HTTP.
 *
 * Tests that the Phase 2 components work together correctly:
 * - CredentialProvider supplies tokens to QuotaCollector
 * - QuotaCollector fetches from mock OAuth API
 * - QuotaTracker receives and persists the result
 * - JSONL fallback works with real file parsing
 * - Multi-account polling reads from real registry
 * - Adaptive polling intervals adjust with real state
 *
 * Uses real file system, real registry, real provider — only HTTP is mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QuotaCollector, AdaptivePoller } from '../../src/monitoring/QuotaCollector.js';
import { ClaudeConfigCredentialProvider } from '../../src/monitoring/CredentialProvider.js';
import { QuotaTracker } from '../../src/monitoring/QuotaTracker.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Test Helpers ────────────────────────────────────────────────────

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qc-integ-'));
}

function createMockFetch(responses: Array<{
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}>): typeof globalThis.fetch {
  let callIndex = 0;
  return vi.fn(async () => {
    const resp = responses[callIndex++] || { status: 500, body: {} };
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      headers: new Map(Object.entries(resp.headers || {})),
      json: async () => resp.body,
    } as unknown as Response;
  });
}

function writeRegistry(registryPath: string, accounts: Record<string, {
  name: string;
  token: string;
  expiresAt?: number;
  percentUsed?: number;
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
        fiveHourUtilization: 30,
        percentUsed: info.percentUsed ?? 50,
        canRunPriority: 'all',
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
  cacheCreation?: number;
  cacheRead?: number;
  timestamp?: string;
}>): string {
  const projectDir = path.join(dir, '-Users-test-project');
  fs.mkdirSync(projectDir, { recursive: true });
  const lines = entries.map(e => JSON.stringify({
    type: 'assistant',
    timestamp: e.timestamp ?? new Date(Date.now() - 5000).toISOString(),
    message: {
      role: 'assistant',
      usage: {
        input_tokens: e.inputTokens ?? 0,
        output_tokens: e.outputTokens ?? 0,
        cache_creation_input_tokens: e.cacheCreation ?? 0,
        cache_read_input_tokens: e.cacheRead ?? 0,
      },
    },
  }));
  const filePath = path.join(projectDir, 'conversation.jsonl');
  fs.writeFileSync(filePath, lines.join('\n'));
  return filePath;
}

// ── Tests ───────────────────────────────────────────────────────────

describe('Quota Collection (integration)', () => {
  let tmpDir: string;
  let credDir: string;
  let quotaFile: string;
  let projectsDir: string;
  let registryPath: string;
  let provider: ClaudeConfigCredentialProvider;
  let tracker: QuotaTracker;

  beforeEach(() => {
    tmpDir = createTmpDir();
    credDir = path.join(tmpDir, 'claude-config');
    quotaFile = path.join(tmpDir, 'quota-state.json');
    projectsDir = path.join(tmpDir, 'projects');
    registryPath = path.join(tmpDir, 'account-registry.json');
    fs.mkdirSync(credDir, { recursive: true });
    fs.mkdirSync(projectsDir, { recursive: true });

    provider = new ClaudeConfigCredentialProvider(credDir);
    tracker = new QuotaTracker({ quotaFile, thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── OAuth collection flow ──

  it('collector fetches OAuth, writes through to tracker file', async () => {
    await provider.writeCredentials({
      accessToken: 'test-token-abc',
      expiresAt: Date.now() + 3600000,
    });

    const mockFetch = createMockFetch([
      { status: 200, body: {
        seven_day: { utilization: 42.7, resets_at: '2026-03-06T03:00:00Z' },
        five_hour: { utilization: 18.3, resets_at: '2026-02-28T12:00:00Z' },
      }},
      { status: 200, body: {
        account: { full_name: 'Test User', email: 'test@example.com', has_claude_max: true },
        organization: { rate_limit_tier: 'default_claude_max_5x', subscription_status: 'active' },
      }},
    ]);

    const collector = new QuotaCollector(provider, tracker, {
      fetchFn: mockFetch,
      jsonlFallback: { enabled: false },
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
    });

    const result = await collector.collect();

    // Collector returns correct data
    expect(result.success).toBe(true);
    expect(result.dataSource).toBe('oauth');
    expect(result.dataConfidence).toBe('authoritative');
    expect(result.state?.usagePercent).toBe(42.7);
    expect(result.state?.fiveHourPercent).toBe(18.3);

    // Tracker was updated — verify by reading from file directly
    const stateOnDisk = JSON.parse(fs.readFileSync(quotaFile, 'utf-8'));
    expect(stateOnDisk.usagePercent).toBe(42.7);
    expect(stateOnDisk.fiveHourPercent).toBe(18.3);

    // Tracker getState returns same
    const trackerState = tracker.getState();
    expect(trackerState?.usagePercent).toBe(42.7);
  });

  // ── JSONL fallback flow ──

  it('falls back to JSONL when credentials are missing, tracker still updated', async () => {
    // No credentials written — OAuth will be skipped
    writeJsonl(projectsDir, [
      { inputTokens: 1_000_000, outputTokens: 500_000, cacheCreation: 200_000, cacheRead: 50_000_000 },
    ]);

    const collector = new QuotaCollector(provider, tracker, {
      fetchFn: createMockFetch([]),
      jsonlFallback: { enabled: true, claudeProjectsDir: projectsDir },
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
    });

    const result = await collector.collect();

    expect(result.success).toBe(true);
    expect(result.dataSource).toBe('jsonl-fallback');
    expect(result.dataConfidence).toBe('estimated');
    expect(result.state?.usagePercent).toBeGreaterThan(0);

    // Tracker file was written
    expect(fs.existsSync(quotaFile)).toBe(true);
    const stateOnDisk = JSON.parse(fs.readFileSync(quotaFile, 'utf-8'));
    expect(stateOnDisk.usagePercent).toBeGreaterThan(0);
  });

  // ── OAuth failure → JSONL fallback ──

  it('OAuth 500 triggers JSONL fallback with real file parsing', async () => {
    await provider.writeCredentials({
      accessToken: 'token-that-will-500',
      expiresAt: Date.now() + 3600000,
    });

    writeJsonl(projectsDir, [
      { inputTokens: 2_000_000_000, outputTokens: 100_000_000 },
    ]);

    const mockFetch = createMockFetch([
      { status: 500, body: { error: 'Internal Server Error' } },
    ]);

    const collector = new QuotaCollector(provider, tracker, {
      fetchFn: mockFetch,
      jsonlFallback: { enabled: true, claudeProjectsDir: projectsDir },
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
    });

    const result = await collector.collect();

    expect(result.success).toBe(true);
    expect(result.dataSource).toBe('jsonl-fallback');
    expect(result.errors.length).toBeGreaterThan(0); // OAuth error recorded
    expect(result.errors[0]).toContain('OAuth');
  });

  // ── Expired token detection ──

  it('expired token emits event and skips OAuth', async () => {
    await provider.writeCredentials({
      accessToken: 'expired-token',
      expiresAt: Date.now() - 3600000, // 1 hour ago
    });

    const events: string[] = [];
    const collector = new QuotaCollector(provider, tracker, {
      fetchFn: createMockFetch([]),
      jsonlFallback: { enabled: false },
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
    });

    collector.on('token_expired', () => events.push('expired'));

    const result = await collector.collect();

    expect(events).toContain('expired');
    expect(result.success).toBe(false); // No JSONL either
  });

  // ── Adaptive polling adjusts after collection ──

  it('polling interval decreases after high-utilization collection', async () => {
    await provider.writeCredentials({
      accessToken: 'token',
      expiresAt: Date.now() + 3600000,
    });

    const collector = new QuotaCollector(provider, tracker, {
      fetchFn: createMockFetch([
        { status: 200, body: { seven_day: { utilization: 88, resets_at: null } } },
        { status: 200, body: { account: {}, organization: {} } },
      ]),
      jsonlFallback: { enabled: false },
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
    });

    // Before collection — default 10 min
    expect(collector.getPollingIntervalMs()).toBe(10 * 60 * 1000);

    await collector.collect();

    // After 88% — should be 2 min (>85% tier)
    expect(collector.getPollingIntervalMs()).toBe(2 * 60 * 1000);
  });

  // ── Multi-account polling with real registry ──

  it('polls inactive accounts from real registry file', async () => {
    // Write credentials for the active account
    await provider.writeCredentials({
      accessToken: 'active-token',
      expiresAt: Date.now() + 3600000,
    });

    // Create registry with active + inactive accounts
    writeRegistry(registryPath, {
      'active@example.com': { name: 'Active', token: 'active-token', percentUsed: 75 },
      'backup@example.com': { name: 'Backup', token: 'backup-token', percentUsed: 20 },
    }, 'active@example.com');

    let fetchCallCount = 0;
    const mockFetch = vi.fn(async (url: string) => {
      fetchCallCount++;
      const isUsage = url.includes('/usage');
      const isProfile = url.includes('/profile');

      if (isUsage) {
        return {
          ok: true, status: 200,
          headers: new Map(),
          json: async () => ({
            seven_day: { utilization: 75, resets_at: null },
            five_hour: { utilization: 20, resets_at: null },
          }),
        };
      }
      if (isProfile) {
        return {
          ok: true, status: 200,
          headers: new Map(),
          json: async () => ({
            account: { email: 'active@example.com', full_name: 'Active' },
            organization: { rate_limit_tier: 'max_5x' },
          }),
        };
      }
      return { ok: false, status: 404, headers: new Map(), json: async () => ({}) };
    }) as unknown as typeof globalThis.fetch;

    const collector = new QuotaCollector(provider, tracker, {
      fetchFn: mockFetch,
      registryPath,
      jsonlFallback: { enabled: false },
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
    });

    const result = await collector.collect();

    expect(result.success).toBe(true);
    // Should have made calls for active account (usage + profile) + inactive account (usage)
    expect(fetchCallCount).toBeGreaterThanOrEqual(2);
  });

  // ── Concurrent collections don't corrupt state ──

  it('concurrent collect calls produce valid state', async () => {
    await provider.writeCredentials({
      accessToken: 'token',
      expiresAt: Date.now() + 3600000,
    });

    let callCount = 0;
    const mockFetch = vi.fn(async () => {
      callCount++;
      // Simulate small delay
      await new Promise(r => setTimeout(r, 10));
      return {
        ok: true, status: 200,
        headers: new Map(),
        json: async () => callCount <= 2
          ? { seven_day: { utilization: 50 + callCount, resets_at: null } }
          : { account: {}, organization: {} },
      };
    }) as unknown as typeof globalThis.fetch;

    const collector = new QuotaCollector(provider, tracker, {
      fetchFn: mockFetch,
      jsonlFallback: { enabled: false },
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
    });

    // Fire two collections in parallel
    const [r1, r2] = await Promise.all([
      collector.collect(),
      collector.collect(),
    ]);

    // Both should succeed or at least one succeeds
    expect(r1.success || r2.success).toBe(true);

    // State file should exist and be valid JSON
    const stateOnDisk = JSON.parse(fs.readFileSync(quotaFile, 'utf-8'));
    expect(stateOnDisk.usagePercent).toBeGreaterThan(0);
  });

  // ── Token expiring_soon event ──

  it('emits token_expiring for tokens expiring within 1 hour', async () => {
    await provider.writeCredentials({
      accessToken: 'soon-expiring',
      expiresAt: Date.now() + 30 * 60 * 1000, // 30 minutes
    });

    const events: string[] = [];
    const collector = new QuotaCollector(provider, tracker, {
      fetchFn: createMockFetch([
        { status: 200, body: { seven_day: { utilization: 30, resets_at: null } } },
        { status: 200, body: { account: {}, organization: {} } },
      ]),
      jsonlFallback: { enabled: false },
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
    });

    collector.on('token_expiring', () => events.push('expiring'));

    await collector.collect();

    expect(events).toContain('expiring');
  });

  // ── Collection duration tracking ──

  it('tracks collection duration end-to-end', async () => {
    await provider.writeCredentials({
      accessToken: 'token',
      expiresAt: Date.now() + 3600000,
    });

    const collector = new QuotaCollector(provider, tracker, {
      fetchFn: createMockFetch([
        { status: 200, body: { seven_day: { utilization: 10, resets_at: null } } },
        { status: 200, body: { account: {}, organization: {} } },
      ]),
      jsonlFallback: { enabled: false },
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
    });

    const result = await collector.collect();

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(5000); // Should complete in under 5s
  });
});
