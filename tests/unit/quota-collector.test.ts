/**
 * Unit tests for QuotaCollector (Phase 2).
 *
 * Tests the individual components:
 * - RetryHelper: exponential backoff, jitter, 401 bail-out
 * - RequestBudget: rate limiting
 * - ConcurrencyLimiter: parallel execution control
 * - AdaptivePoller: interval calculation, hysteresis
 * - JsonlParser: file finding, token parsing, utilization estimation
 * - classifyToken: token state classification
 * - QuotaCollector: OAuth collection, JSONL fallback, multi-account
 *
 * Uses mock fetch and temp directories — no real API calls or external services.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RetryHelper,
  RequestBudget,
  ConcurrencyLimiter,
  AdaptivePoller,
  JsonlParser,
  QuotaCollector,
  classifyToken,
} from '../../src/monitoring/QuotaCollector.js';
import { ClaudeConfigCredentialProvider } from '../../src/monitoring/CredentialProvider.js';
import { QuotaTracker } from '../../src/monitoring/QuotaTracker.js';
import type { RetryConfig, OAuthUsageResponse } from '../../src/monitoring/QuotaCollector.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Test Helpers ────────────────────────────────────────────────────

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qc-unit-'));
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

// ── classifyToken ───────────────────────────────────────────────────

describe('classifyToken', () => {
  it('returns "missing" for null credentials', () => {
    expect(classifyToken(null)).toBe('missing');
  });

  it('returns "missing" for empty access token', () => {
    expect(classifyToken({ accessToken: '', expiresAt: Date.now() + 3600000 })).toBe('missing');
  });

  it('returns "valid" for token with future expiry', () => {
    expect(classifyToken({ accessToken: 'abc', expiresAt: Date.now() + 7200000 })).toBe('valid');
  });

  it('returns "valid" for token with no expiry info', () => {
    expect(classifyToken({ accessToken: 'abc', expiresAt: 0 })).toBe('valid');
  });

  it('returns "expiring_soon" for token within 1 hour', () => {
    expect(classifyToken({ accessToken: 'abc', expiresAt: Date.now() + 1800000 })).toBe('expiring_soon');
  });

  it('returns "expired" for token past expiry', () => {
    expect(classifyToken({ accessToken: 'abc', expiresAt: Date.now() - 1000 })).toBe('expired');
  });
});

// ── RetryHelper ─────────────────────────────────────────────────────

describe('RetryHelper', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await RetryHelper.withRetry(fn, { ...DEFAULT_RETRY_CONFIG(), maxRetries: 3 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('500 Server Error'))
      .mockRejectedValueOnce(new Error('500 Server Error'))
      .mockResolvedValue('ok');

    const result = await RetryHelper.withRetry(fn, { ...DEFAULT_RETRY_CONFIG(), maxRetries: 3, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after max retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('500 Server Error'));
    await expect(
      RetryHelper.withRetry(fn, { ...DEFAULT_RETRY_CONFIG(), maxRetries: 2, baseDelayMs: 1 }),
    ).rejects.toThrow('500 Server Error');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('does NOT retry on 401', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('OAuth usage returned 401'));
    await expect(
      RetryHelper.withRetry(fn, { ...DEFAULT_RETRY_CONFIG(), maxRetries: 3, baseDelayMs: 1 }),
    ).rejects.toThrow('401');
    expect(fn).toHaveBeenCalledTimes(1); // No retry
  });

  it('calculates exponential backoff delay', () => {
    const config: RetryConfig = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, jitterFactor: 0 };
    expect(RetryHelper.calculateDelay(0, config, 0.5)).toBe(1000);
    expect(RetryHelper.calculateDelay(1, config, 0.5)).toBe(2000);
    expect(RetryHelper.calculateDelay(2, config, 0.5)).toBe(4000);
    expect(RetryHelper.calculateDelay(3, config, 0.5)).toBe(8000);
  });

  it('applies jitter to backoff delay', () => {
    const config: RetryConfig = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, jitterFactor: 0.3 };
    // jitterSeed=0 → jitter = 1000 * 0.3 * (0 * 2 - 1) = -300 → delay = 700
    expect(RetryHelper.calculateDelay(0, config, 0)).toBe(700);
    // jitterSeed=1 → jitter = 1000 * 0.3 * (1 * 2 - 1) = +300 → delay = 1300
    expect(RetryHelper.calculateDelay(0, config, 1)).toBe(1300);
  });

  it('caps delay at maxDelayMs', () => {
    const config: RetryConfig = { maxRetries: 10, baseDelayMs: 1000, maxDelayMs: 5000, jitterFactor: 0 };
    // Attempt 5: 1000 * 2^5 = 32000, capped to 5000
    expect(RetryHelper.calculateDelay(5, config, 0.5)).toBe(5000);
  });
});

function DEFAULT_RETRY_CONFIG(): RetryConfig {
  return { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, jitterFactor: 0.3 };
}

// ── RequestBudget ───────────────────────────────────────────────────

describe('RequestBudget', () => {
  it('allows requests within budget', () => {
    const budget = new RequestBudget(5);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(true);
    expect(budget.remaining).toBe(3);
  });

  it('denies requests when budget exhausted', () => {
    const budget = new RequestBudget(2);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(false);
    expect(budget.remaining).toBe(0);
  });

  it('canRequest checks without consuming', () => {
    const budget = new RequestBudget(1);
    expect(budget.canRequest()).toBe(true);
    expect(budget.canRequest()).toBe(true); // Still true — not consumed
    budget.consume();
    expect(budget.canRequest()).toBe(false);
  });

  it('reports used count', () => {
    const budget = new RequestBudget(10);
    budget.consume();
    budget.consume();
    budget.consume();
    expect(budget.used).toBe(3);
  });
});

// ── ConcurrencyLimiter ──────────────────────────────────────────────

describe('ConcurrencyLimiter', () => {
  it('runs tasks up to the concurrency limit', async () => {
    const limiter = new ConcurrencyLimiter(2);
    const running: number[] = [];
    const maxConcurrent: number[] = [];

    const task = (id: number) => limiter.run(async () => {
      running.push(id);
      maxConcurrent.push(running.length);
      await new Promise(r => setTimeout(r, 10));
      running.splice(running.indexOf(id), 1);
      return id;
    });

    const results = await Promise.all([task(1), task(2), task(3), task(4)]);
    expect(results).toEqual([1, 2, 3, 4]);
    expect(Math.max(...maxConcurrent)).toBeLessThanOrEqual(2);
  });

  it('returns task results correctly', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const result = await limiter.run(async () => 'hello');
    expect(result).toBe('hello');
  });

  it('releases slot on error', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await expect(limiter.run(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
    // Should be able to run another task after the error
    const result = await limiter.run(async () => 'recovered');
    expect(result).toBe('recovered');
  });
});

// ── AdaptivePoller ──────────────────────────────────────────────────

describe('AdaptivePoller', () => {
  describe('calculateInterval (static)', () => {
    it('returns 10 min for low utilization', () => {
      const { intervalMs, tier } = AdaptivePoller.calculateInterval(40);
      expect(intervalMs).toBe(10 * 60 * 1000);
      expect(tier).toBe('low');
    });

    it('returns 5 min for elevated weekly (70-85%)', () => {
      const { intervalMs, tier } = AdaptivePoller.calculateInterval(75);
      expect(intervalMs).toBe(5 * 60 * 1000);
      expect(tier).toBe('elevated');
    });

    it('returns 2 min for high weekly (85-92%)', () => {
      const { intervalMs, tier } = AdaptivePoller.calculateInterval(88);
      expect(intervalMs).toBe(2 * 60 * 1000);
      expect(tier).toBe('high');
    });

    it('returns 1 min for critical weekly (>92%)', () => {
      const { intervalMs, tier } = AdaptivePoller.calculateInterval(95);
      expect(intervalMs).toBe(1 * 60 * 1000);
      expect(tier).toBe('critical');
    });

    it('5-hour > 80% overrides to 1 min', () => {
      const { intervalMs } = AdaptivePoller.calculateInterval(40, 85);
      expect(intervalMs).toBe(1 * 60 * 1000);
    });

    it('5-hour 70-80% gives 3 min', () => {
      const { intervalMs } = AdaptivePoller.calculateInterval(40, 75);
      expect(intervalMs).toBe(3 * 60 * 1000);
    });

    it('uses shortest interval from both checks', () => {
      // Weekly says 5min (75%), 5-hour says 1min (85%) → 1min wins
      const { intervalMs } = AdaptivePoller.calculateInterval(75, 85);
      expect(intervalMs).toBe(1 * 60 * 1000);
    });
  });

  describe('hysteresis', () => {
    it('speeds up immediately', () => {
      const poller = new AdaptivePoller();
      // Start at 10 min (low utilization)
      poller.update(40);
      expect(poller.getState().currentIntervalMs).toBe(10 * 60 * 1000);

      // Jump to high utilization — should speed up immediately
      const interval = poller.update(90);
      expect(interval).toBe(2 * 60 * 1000);
    });

    it('slows down only after 3 consecutive below-threshold readings', () => {
      const poller = new AdaptivePoller();

      // Start fast (critical)
      poller.update(95);
      expect(poller.getState().currentIntervalMs).toBe(1 * 60 * 1000);

      // Drop to low — should NOT slow down yet (needs 3 consecutive)
      poller.update(40);
      expect(poller.getState().currentIntervalMs).toBe(1 * 60 * 1000);
      expect(poller.getState().consecutiveBelowThreshold).toBe(1);

      poller.update(40);
      expect(poller.getState().currentIntervalMs).toBe(1 * 60 * 1000);
      expect(poller.getState().consecutiveBelowThreshold).toBe(2);

      // Third consecutive low reading — NOW slow down
      poller.update(40);
      expect(poller.getState().currentIntervalMs).toBe(10 * 60 * 1000);
      expect(poller.getState().consecutiveBelowThreshold).toBe(0);
    });

    it('resets hysteresis counter on any speed-up', () => {
      const poller = new AdaptivePoller();

      // Start critical
      poller.update(95);

      // Two low readings (building up to slow down)
      poller.update(40);
      poller.update(40);
      expect(poller.getState().consecutiveBelowThreshold).toBe(2);

      // Spike back up — counter resets
      poller.update(90);
      expect(poller.getState().consecutiveBelowThreshold).toBe(0);
      expect(poller.getState().currentIntervalMs).toBe(2 * 60 * 1000);
    });
  });
});

// ── JsonlParser ─────────────────────────────────────────────────────

describe('JsonlParser', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('findFiles', () => {
    it('finds JSONL files in project directories', () => {
      const projectDir = path.join(tmpDir, '-Users-test-project');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'conversation.jsonl'), '');
      fs.writeFileSync(path.join(projectDir, 'other.jsonl'), '');

      const files = JsonlParser.findFiles(tmpDir, 0);
      expect(files).toHaveLength(2);
    });

    it('skips directories that don\'t start with -Users-', () => {
      const projectDir = path.join(tmpDir, 'some-other-dir');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'conversation.jsonl'), '');

      const files = JsonlParser.findFiles(tmpDir, 0);
      expect(files).toHaveLength(0);
    });

    it('returns empty array for non-existent directory', () => {
      const files = JsonlParser.findFiles('/nonexistent/path', 0);
      expect(files).toHaveLength(0);
    });
  });

  describe('parseFile', () => {
    it('extracts token counts from valid JSONL', () => {
      const jsonl = [
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date().toISOString(),
          message: {
            role: 'assistant',
            usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 20, cache_read_input_tokens: 10 },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date().toISOString(),
          message: {
            role: 'assistant',
            usage: { input_tokens: 200, output_tokens: 100 },
          },
        }),
      ].join('\n');

      const filePath = path.join(tmpDir, 'test.jsonl');
      fs.writeFileSync(filePath, jsonl);

      const counts = JsonlParser.parseFile(
        filePath,
        new Date(Date.now() - 86400000),
        new Date(Date.now() + 86400000),
      );

      expect(counts.inputTokens).toBe(300);
      expect(counts.outputTokens).toBe(150);
      expect(counts.cacheCreationTokens).toBe(20);
      expect(counts.cacheReadTokens).toBe(10);
      expect(counts.totalBilled).toBe(480);
    });

    it('skips entries outside time window', () => {
      const now = Date.now();
      const oldEntry = JSON.stringify({
        type: 'assistant',
        timestamp: new Date(now - 86400000 * 10).toISOString(), // 10 days ago
        message: { role: 'assistant', usage: { input_tokens: 999 } },
      });
      const recentEntry = JSON.stringify({
        type: 'assistant',
        timestamp: new Date(now - 1000).toISOString(), // 1 second ago
        message: { role: 'assistant', usage: { input_tokens: 100 } },
      });

      const filePath = path.join(tmpDir, 'test.jsonl');
      fs.writeFileSync(filePath, [oldEntry, recentEntry].join('\n'));

      const counts = JsonlParser.parseFile(
        filePath,
        new Date(now - 86400000), // Last 1 day
        new Date(now + 1000), // 1 second in the future to avoid race
      );

      expect(counts.inputTokens).toBe(100);
    });

    it('skips non-assistant entries', () => {
      const jsonl = [
        JSON.stringify({ type: 'user', message: { role: 'user', usage: { input_tokens: 999 } } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 50 } }, timestamp: new Date().toISOString() }),
      ].join('\n');

      const filePath = path.join(tmpDir, 'test.jsonl');
      fs.writeFileSync(filePath, jsonl);

      const counts = JsonlParser.parseFile(
        filePath,
        new Date(0),
        new Date(Date.now() + 86400000),
      );
      expect(counts.inputTokens).toBe(50);
    });

    it('handles malformed lines gracefully', () => {
      const jsonl = [
        'not json at all',
        '{"broken": true',
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date().toISOString(),
          message: { role: 'assistant', usage: { input_tokens: 42 } },
        }),
      ].join('\n');

      const filePath = path.join(tmpDir, 'test.jsonl');
      fs.writeFileSync(filePath, jsonl);

      const counts = JsonlParser.parseFile(
        filePath,
        new Date(0),
        new Date(Date.now() + 86400000),
      );
      expect(counts.inputTokens).toBe(42);
    });

    it('returns zeros for non-existent file', () => {
      const counts = JsonlParser.parseFile('/nonexistent', new Date(0), new Date());
      expect(counts.totalBilled).toBe(0);
    });
  });

  describe('estimateUtilization', () => {
    it('calculates percentage from token counts', () => {
      const percent = JsonlParser.estimateUtilization(
        { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalBilled: 3_750_000_000 },
        7_500_000_000,
      );
      expect(percent).toBe(50);
    });

    it('caps at 200%', () => {
      const percent = JsonlParser.estimateUtilization(
        { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalBilled: 20_000_000_000 },
        7_500_000_000,
      );
      expect(percent).toBe(200);
    });

    it('returns 0 for zero budget', () => {
      const percent = JsonlParser.estimateUtilization(
        { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalBilled: 1000 },
        0,
      );
      expect(percent).toBe(0);
    });
  });
});

// ── QuotaCollector ──────────────────────────────────────────────────

describe('QuotaCollector', () => {
  let tmpDir: string;
  let quotaFile: string;
  let credDir: string;
  let provider: ClaudeConfigCredentialProvider;
  let tracker: QuotaTracker;

  beforeEach(() => {
    tmpDir = createTmpDir();
    quotaFile = path.join(tmpDir, 'quota-state.json');
    credDir = path.join(tmpDir, 'claude-config');
    fs.mkdirSync(credDir, { recursive: true });
    provider = new ClaudeConfigCredentialProvider(credDir);
    tracker = new QuotaTracker({
      quotaFile,
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('collects via OAuth API and updates tracker', async () => {
    // Write credentials
    await provider.writeCredentials({
      accessToken: 'test-token-abc',
      expiresAt: Date.now() + 3600000,
      email: 'test@example.com',
    });

    const mockFetch = createMockFetch([
      // Usage response
      {
        status: 200,
        body: {
          seven_day: { utilization: 73.2, resets_at: '2026-03-01T00:00:00Z' },
          five_hour: { utilization: 42.1, resets_at: '2026-02-27T20:00:00Z' },
          seven_day_sonnet: { utilization: 68.5 },
          seven_day_opus: { utilization: 81.0 },
        } satisfies OAuthUsageResponse,
      },
      // Profile response
      {
        status: 200,
        body: {
          account: { email: 'test@example.com', full_name: 'Test User', has_claude_max: true },
          organization: { rate_limit_tier: 'max_5x', subscription_status: 'active' },
        },
      },
    ]);

    const collector = new QuotaCollector(provider, tracker, { fetchFn: mockFetch });
    const result = await collector.collect();

    expect(result.success).toBe(true);
    expect(result.dataSource).toBe('oauth');
    expect(result.dataConfidence).toBe('authoritative');
    expect(result.state?.usagePercent).toBe(73.2);
    expect(result.state?.fiveHourPercent).toBe(42.1);
    expect(result.oauth?.sonnetUtilization).toBe(68.5);
    expect(result.oauth?.opusUtilization).toBe(81.0);
    expect(result.account?.name).toBe('Test User');
    expect(result.account?.hasClaudeMax).toBe(true);

    // Tracker should have been updated
    const state = tracker.getState();
    expect(state?.usagePercent).toBe(73.2);
  });

  it('falls back to JSONL when OAuth fails', async () => {
    // Write credentials (will fail on OAuth)
    await provider.writeCredentials({
      accessToken: 'test-token',
      expiresAt: Date.now() + 3600000,
    });

    // Create JSONL data (timestamp slightly in the past to avoid timing race)
    const projectDir = path.join(tmpDir, 'projects', '-Users-test-project');
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonl = JSON.stringify({
      type: 'assistant',
      timestamp: new Date(Date.now() - 5000).toISOString(),
      message: { role: 'assistant', usage: { input_tokens: 3_750_000_000, output_tokens: 0 } },
    });
    fs.writeFileSync(path.join(projectDir, 'conversation.jsonl'), jsonl);

    const mockFetch = createMockFetch([
      { status: 500, body: {} }, // OAuth fails
    ]);

    const collector = new QuotaCollector(provider, tracker, {
      fetchFn: mockFetch,
      jsonlFallback: { enabled: true, claudeProjectsDir: path.join(tmpDir, 'projects') },
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
    });

    const result = await collector.collect();

    expect(result.success).toBe(true);
    expect(result.dataSource).toBe('jsonl-fallback');
    expect(result.dataConfidence).toBe('estimated');
    expect(result.state?.usagePercent).toBeGreaterThan(0);
  });

  it('returns none when both sources fail', async () => {
    // No credentials — no OAuth token
    const mockFetch = createMockFetch([]);
    const collector = new QuotaCollector(provider, tracker, {
      fetchFn: mockFetch,
      jsonlFallback: { enabled: false },
    });

    const result = await collector.collect();
    expect(result.success).toBe(false);
    expect(result.dataSource).toBe('none');
  });

  it('emits token_expired when token is expired', async () => {
    await provider.writeCredentials({
      accessToken: 'expired-token',
      expiresAt: Date.now() - 3600000,
      email: 'expired@example.com',
    });

    const events: unknown[] = [];
    const collector = new QuotaCollector(provider, tracker, {
      fetchFn: createMockFetch([]),
      jsonlFallback: { enabled: false },
    });
    collector.on('token_expired', (e) => events.push(e));

    await collector.collect();
    expect(events).toHaveLength(1);
    expect((events[0] as { email: string }).email).toBe('expired@example.com');
  });

  it('emits token_expiring when token expires soon', async () => {
    await provider.writeCredentials({
      accessToken: 'soon-token',
      expiresAt: Date.now() + 1800000, // 30 min
      email: 'soon@example.com',
    });

    const events: unknown[] = [];
    const mockFetch = createMockFetch([
      { status: 200, body: { seven_day: { utilization: 50, resets_at: null } } },
      { status: 200, body: { account: {}, organization: {} } },
    ]);

    const collector = new QuotaCollector(provider, tracker, { fetchFn: mockFetch });
    collector.on('token_expiring', (e) => events.push(e));

    await collector.collect();
    expect(events).toHaveLength(1);
  });

  it('updates adaptive polling interval based on collection', async () => {
    await provider.writeCredentials({
      accessToken: 'test-token',
      expiresAt: Date.now() + 3600000,
    });

    const mockFetch = createMockFetch([
      { status: 200, body: { seven_day: { utilization: 93, resets_at: null } } },
      { status: 200, body: { account: {}, organization: {} } },
    ]);

    const collector = new QuotaCollector(provider, tracker, { fetchFn: mockFetch });
    await collector.collect();

    // 93% weekly → 1 min interval
    expect(collector.getPollingIntervalMs()).toBe(1 * 60 * 1000);
  });

  it('respects request budget', async () => {
    await provider.writeCredentials({
      accessToken: 'test-token',
      expiresAt: Date.now() + 3600000,
    });

    const collector = new QuotaCollector(provider, tracker, {
      fetchFn: createMockFetch([]),
      requestBudgetPer5Min: 0, // No budget at all
      jsonlFallback: { enabled: false }, // Disable JSONL so both sources fail
    });

    const result = await collector.collect();
    expect(result.success).toBe(false);
    expect(result.errors.some(e => e.includes('budget'))).toBe(true);
  });

  it('reports collection duration', async () => {
    const collector = new QuotaCollector(provider, tracker, {
      fetchFn: createMockFetch([]),
      jsonlFallback: { enabled: false },
    });

    const result = await collector.collect();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(collector.getLastCollectionDurationMs()).toBeGreaterThanOrEqual(0);
  });

  it('getBudgetStatus returns current budget state', () => {
    const collector = new QuotaCollector(provider, tracker, {
      fetchFn: createMockFetch([]),
      requestBudgetPer5Min: 60,
    });

    const status = collector.getBudgetStatus();
    expect(status.limit).toBe(60);
    expect(status.remaining).toBe(60);
    expect(status.used).toBe(0);
    expect(status.oauthCircuitBreaker.open).toBe(false);
    expect(status.oauthCircuitBreaker.consecutive429s).toBe(0);
  });

  describe('OAuth circuit breaker', () => {
    it('trips after 3 consecutive 429 responses', async () => {
      await provider.writeCredentials({
        accessToken: 'test-token',
        expiresAt: Date.now() + 3600000,
      });

      // Return 429 on every call
      const mock429 = vi.fn(async () => ({
        ok: false,
        status: 429,
        headers: new Map([['retry-after', '0']]),
        json: async () => ({}),
      } as unknown as Response));

      const collector = new QuotaCollector(provider, tracker, {
        fetchFn: mock429,
        jsonlFallback: { enabled: false },
        retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
      });

      // 3 consecutive polls trigger the circuit breaker
      await collector.collect();
      expect(collector.getBudgetStatus().oauthCircuitBreaker.open).toBe(false);
      expect(collector.getBudgetStatus().oauthCircuitBreaker.consecutive429s).toBe(1);

      await collector.collect();
      expect(collector.getBudgetStatus().oauthCircuitBreaker.consecutive429s).toBe(2);

      await collector.collect();
      // Breaker trips on 3rd consecutive 429
      expect(collector.getBudgetStatus().oauthCircuitBreaker.open).toBe(true);
      expect(collector.getBudgetStatus().oauthCircuitBreaker.consecutive429s).toBe(3);
      expect(collector.getBudgetStatus().oauthCircuitBreaker.backoffUntil).not.toBeNull();
    });

    it('skips OAuth when circuit breaker is open', async () => {
      await provider.writeCredentials({
        accessToken: 'test-token',
        expiresAt: Date.now() + 3600000,
      });

      const fetchSpy = vi.fn(async () => ({
        ok: false,
        status: 429,
        headers: new Map([['retry-after', '0']]),
        json: async () => ({}),
      } as unknown as Response));

      const collector = new QuotaCollector(provider, tracker, {
        fetchFn: fetchSpy,
        jsonlFallback: { enabled: false },
        retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
      });

      // Trip the circuit breaker
      await collector.collect();
      await collector.collect();
      await collector.collect();
      expect(collector.getBudgetStatus().oauthCircuitBreaker.open).toBe(true);

      const callsBefore = fetchSpy.mock.calls.length;

      // With circuit open, subsequent collects should NOT attempt OAuth
      await collector.collect();
      expect(fetchSpy.mock.calls.length).toBe(callsBefore); // No new fetch calls
    });

    it('resets circuit breaker on successful OAuth response', async () => {
      await provider.writeCredentials({
        accessToken: 'test-token',
        expiresAt: Date.now() + 3600000,
      });

      let callCount = 0;
      const mockFetch = vi.fn(async () => {
        callCount++;
        if (callCount <= 2) {
          return {
            ok: false,
            status: 429,
            headers: new Map([['retry-after', '0']]),
            json: async () => ({}),
          } as unknown as Response;
        }
        // 3rd+ call returns success (with proper OAuthUsageResponse structure)
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          json: async () => ({
            seven_day: { utilization: 0.2, resets_at: null },
          }),
        } as unknown as Response;
      });

      const collector = new QuotaCollector(provider, tracker, {
        fetchFn: mockFetch,
        jsonlFallback: { enabled: false },
        retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 },
      });

      await collector.collect(); // 429 — count=1
      await collector.collect(); // 429 — count=2
      expect(collector.getBudgetStatus().oauthCircuitBreaker.consecutive429s).toBe(2);

      // Success — should reset counter
      await collector.collect();
      expect(collector.getBudgetStatus().oauthCircuitBreaker.consecutive429s).toBe(0);
      expect(collector.getBudgetStatus().oauthCircuitBreaker.open).toBe(false);
    });
  });
});
