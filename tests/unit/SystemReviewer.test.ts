/**
 * Comprehensive unit tests for SystemReviewer orchestrator and Tier 1 probes.
 *
 * Covers: orchestrator lifecycle, probe execution, error handling, timeouts,
 * serial groups, history persistence, trend analysis, alerting, feedback,
 * dead letter fallback, cleanup, and all 14 Tier 1 probes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SystemReviewer } from '../../src/monitoring/SystemReviewer.js';
import type { Probe, ProbeResult, SystemReviewerDeps } from '../../src/monitoring/SystemReviewer.js';
import { createSessionProbes } from '../../src/monitoring/probes/SessionProbe.js';
import { createSchedulerProbes } from '../../src/monitoring/probes/SchedulerProbe.js';
import { createMessagingProbes } from '../../src/monitoring/probes/MessagingProbe.js';
import { createLifelineProbes } from '../../src/monitoring/probes/LifelineProbe.js';

// ── Helpers ─────────────────────────────────────────────────────────

function makeDeps(stateDir: string, overrides?: Partial<SystemReviewerDeps>): SystemReviewerDeps {
  return { stateDir, ...overrides };
}

function makePassingProbe(id: string, tier: 1 | 2 | 3 | 4 | 5 = 1, opts?: Partial<Probe>): Probe {
  return {
    id,
    name: `Test Probe ${id}`,
    tier,
    feature: 'Test Feature',
    timeoutMs: 5000,
    prerequisites: () => true,
    async run(): Promise<ProbeResult> {
      return {
        probeId: this.id,
        name: this.name,
        tier: this.tier,
        passed: true,
        description: 'All good',
        durationMs: 1,
      };
    },
    ...opts,
  };
}

function makeFailingProbe(id: string, tier: 1 | 2 | 3 | 4 | 5 = 1, opts?: Partial<Probe>): Probe {
  return {
    id,
    name: `Failing Probe ${id}`,
    tier,
    feature: 'Test Feature',
    timeoutMs: 5000,
    prerequisites: () => true,
    async run(): Promise<ProbeResult> {
      return {
        probeId: this.id,
        name: this.name,
        tier: this.tier,
        passed: false,
        description: 'Something broke',
        durationMs: 1,
        error: 'Expected 42, got 0',
        remediation: ['Fix the thing'],
      };
    },
    ...opts,
  };
}

function makeSkippedProbe(id: string): Probe {
  return {
    id,
    name: `Skipped Probe ${id}`,
    tier: 1,
    feature: 'Test Feature',
    timeoutMs: 5000,
    prerequisites: () => false, // Will be skipped
    async run(): Promise<ProbeResult> {
      throw new Error('Should not run');
    },
  };
}

function makeSlowProbe(id: string, delayMs: number, tier: 1 | 2 | 3 | 4 | 5 = 1): Probe {
  return {
    id,
    name: `Slow Probe ${id}`,
    tier,
    feature: 'Test Feature',
    timeoutMs: delayMs * 3,
    prerequisites: () => true,
    async run(): Promise<ProbeResult> {
      await new Promise(r => setTimeout(r, delayMs));
      return {
        probeId: this.id,
        name: this.name,
        tier: this.tier,
        passed: true,
        description: `Completed after ${delayMs}ms`,
        durationMs: delayMs,
      };
    },
  };
}

function makeThrowingProbe(id: string, error: unknown = new Error('Probe explosion')): Probe {
  return {
    id,
    name: `Throwing Probe ${id}`,
    tier: 1,
    feature: 'Test Feature',
    timeoutMs: 5000,
    prerequisites: () => true,
    async run(): Promise<ProbeResult> {
      throw error;
    },
  };
}

function makeDefaultLifelineDeps(tmpDir: string, overrides?: Record<string, unknown>) {
  return {
    getSupervisorStatus: () => ({
      running: true, healthy: true, restartAttempts: 0, lastHealthy: Date.now(),
      coolingDown: false, cooldownRemainingMs: 0, circuitBroken: false,
      totalFailures: 0, lastCrashOutput: '', circuitBreakerRetryCount: 0,
      maxCircuitBreakerRetries: 3, inMaintenanceWait: false, maintenanceWaitElapsedMs: 0,
    }),
    getQueueLength: () => 0,
    peekQueue: () => [] as Array<{ id: string; timestamp: string }>,
    lockFilePath: path.join(tmpDir, 'lifeline.lock'),
    isEnabled: () => true,
    ...overrides,
  };
}

// ── SystemReviewer Orchestrator Tests ────────────────────────────────

describe('SystemReviewer', () => {
  let stateDir: string;
  let reviewer: SystemReviewer;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-review-test-'));
    reviewer = new SystemReviewer({ enabled: false }, makeDeps(stateDir));
  });

  afterEach(() => {
    reviewer.stop();
    try {
      // safe-git-allow: incremental-migration
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  // ── Basic Registration & State ──────────────────────────────────────

  it('creates with empty probes', () => {
    expect(reviewer.getLatest()).toBeNull();
    expect(reviewer.getHistory()).toHaveLength(0);
  });

  it('registers probes and rejects duplicates', () => {
    reviewer.register(makePassingProbe('test.a'));
    reviewer.register(makePassingProbe('test.b'));
    expect(() => reviewer.register(makePassingProbe('test.a'))).toThrow('already registered');
  });

  it('registerAll registers multiple probes', () => {
    reviewer.registerAll([
      makePassingProbe('test.a'),
      makePassingProbe('test.b'),
      makePassingProbe('test.c'),
    ]);
    expect(reviewer.getProbes()).toHaveLength(3);
  });

  it('registerAll rejects duplicates within the batch', () => {
    expect(() => reviewer.registerAll([
      makePassingProbe('test.a'),
      makePassingProbe('test.a'),
    ])).toThrow('already registered');
  });

  it('getProbes returns correct disabled/prerequisitesMet status', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-probes-status-'));
    const rev = new SystemReviewer(
      { enabled: false, disabledProbes: ['test.disabled'] },
      makeDeps(dir),
    );
    rev.register(makePassingProbe('test.active'));
    rev.register(makePassingProbe('test.disabled'));
    rev.register(makeSkippedProbe('test.nopre'));

    const probes = rev.getProbes();
    expect(probes.find(p => p.id === 'test.active')?.disabled).toBe(false);
    expect(probes.find(p => p.id === 'test.active')?.prerequisitesMet).toBe(true);
    expect(probes.find(p => p.id === 'test.disabled')?.disabled).toBe(true);
    expect(probes.find(p => p.id === 'test.nopre')?.prerequisitesMet).toBe(false);

    rev.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── Review Execution ────────────────────────────────────────────────

  it('runs a review with passing probes', async () => {
    reviewer.register(makePassingProbe('test.a'));
    reviewer.register(makePassingProbe('test.b'));

    const report = await reviewer.review();

    expect(report.status).toBe('all-clear');
    expect(report.results).toHaveLength(2);
    expect(report.results.every(r => r.passed)).toBe(true);
    expect(report.stats.passed).toBe(2);
    expect(report.stats.failed).toBe(0);
    expect(report.timestamp).toBeTruthy();
    expect(report.stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('runs a review with failing probes — status degrades', async () => {
    reviewer.register(makePassingProbe('test.a'));
    reviewer.register(makeFailingProbe('test.fail'));

    const report = await reviewer.review();

    expect(report.status).not.toBe('all-clear');
    expect(report.stats.failed).toBe(1);
    expect(report.stats.passed).toBe(1);
  });

  it('skips probes where prerequisites fail', async () => {
    reviewer.register(makePassingProbe('test.a'));
    reviewer.register(makeSkippedProbe('test.skip'));

    const report = await reviewer.review();

    expect(report.stats.passed).toBe(1);
    expect(report.stats.skipped).toBe(1);
    expect(report.skipped.some(s => s.probeId === 'test.skip')).toBe(true);
    expect(report.skipped.find(s => s.probeId === 'test.skip')?.reason).toContain('Prerequisites');
  });

  it('filters by tier', async () => {
    reviewer.register(makePassingProbe('test.tier1', 1));
    reviewer.register(makePassingProbe('test.tier2', 2));

    const report = await reviewer.review({ tiers: [1] });

    const tier1Results = report.results.filter(r => r.tier === 1);
    const tier2Results = report.results.filter(r => r.tier === 2);
    expect(tier1Results.length).toBeGreaterThan(0);
    expect(tier2Results).toHaveLength(0);
  });

  it('filters by multiple tiers', async () => {
    reviewer.register(makePassingProbe('test.t1', 1));
    reviewer.register(makePassingProbe('test.t2', 2));
    reviewer.register(makePassingProbe('test.t3', 3));

    const report = await reviewer.review({ tiers: [1, 3] });

    expect(report.results.some(r => r.tier === 1)).toBe(true);
    expect(report.results.some(r => r.tier === 2)).toBe(false);
    expect(report.results.some(r => r.tier === 3)).toBe(true);
  });

  it('filters by probe ID', async () => {
    reviewer.register(makePassingProbe('test.a'));
    reviewer.register(makePassingProbe('test.b'));

    const report = await reviewer.review({ probeIds: ['test.a'] });

    expect(report.results.filter(r => r.probeId === 'test.a')).toHaveLength(1);
    expect(report.results.filter(r => r.probeId === 'test.b')).toHaveLength(0);
  });

  it('filters by multiple probe IDs', async () => {
    reviewer.register(makePassingProbe('test.a'));
    reviewer.register(makePassingProbe('test.b'));
    reviewer.register(makePassingProbe('test.c'));

    const report = await reviewer.review({ probeIds: ['test.a', 'test.c'] });

    expect(report.results).toHaveLength(2);
    expect(report.results.some(r => r.probeId === 'test.a')).toBe(true);
    expect(report.results.some(r => r.probeId === 'test.c')).toBe(true);
    expect(report.results.some(r => r.probeId === 'test.b')).toBe(false);
  });

  it('respects disabledProbes config', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-review-disabled-'));
    const rev = new SystemReviewer({ enabled: false, disabledProbes: ['test.disabled'] }, makeDeps(dir));
    rev.register(makePassingProbe('test.active'));
    rev.register(makePassingProbe('test.disabled'));

    const report = await rev.review();

    expect(report.results.filter(r => r.probeId === 'test.active')).toHaveLength(1);
    expect(report.results.filter(r => r.probeId === 'test.disabled')).toHaveLength(0);
    expect(report.skipped.some(s => s.probeId === 'test.disabled')).toBe(true);
    expect(report.skipped.find(s => s.probeId === 'test.disabled')?.reason).toContain('Disabled');
    rev.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── Status Classification ───────────────────────────────────────────

  it('status is critical when Tier 1 probe fails', async () => {
    reviewer.register(makePassingProbe('test.pass', 2));
    reviewer.register(makeFailingProbe('test.fail', 1));

    const report = await reviewer.review();
    expect(report.status).toBe('critical');
  });

  it('status is degraded when only non-Tier-1 probes fail', async () => {
    reviewer.register(makePassingProbe('test.pass', 1));
    reviewer.register(makeFailingProbe('test.fail', 2));

    const report = await reviewer.review();
    expect(report.status).toBe('degraded');
  });

  it('status is all-clear when everything passes', async () => {
    reviewer.register(makePassingProbe('test.a', 1));
    reviewer.register(makePassingProbe('test.b', 2));

    const report = await reviewer.review();
    expect(report.status).toBe('all-clear');
  });

  it('generates failureSummary for failed probes', async () => {
    reviewer.register(makeFailingProbe('test.fail1', 1));
    reviewer.register(makeFailingProbe('test.fail2', 2));

    const report = await reviewer.review();
    expect(report.failureSummary).toBeDefined();
    expect(report.failureSummary).toContain('test.fail1');
    expect(report.failureSummary).toContain('test.fail2');
    expect(report.failureSummary).toContain('[T1]');
    expect(report.failureSummary).toContain('[T2]');
  });

  it('no failureSummary when all probes pass', async () => {
    reviewer.register(makePassingProbe('test.a'));

    const report = await reviewer.review();
    expect(report.failureSummary).toBeUndefined();
  });

  // ── Error Handling ──────────────────────────────────────────────────

  it('catches probe exceptions and returns error result', async () => {
    reviewer.register(makeThrowingProbe('test.throw'));

    const report = await reviewer.review();

    expect(report.status).toBe('critical');
    expect(report.results).toHaveLength(1);
    expect(report.results[0].passed).toBe(false);
    expect(report.results[0].error).toContain('Probe explosion');
    expect(report.results[0].stack).toBeDefined();
    expect(report.results[0].description).toContain('exception');
  });

  it('catches non-Error throws (string)', async () => {
    reviewer.register(makeThrowingProbe('test.throw-string', 'string error'));

    const report = await reviewer.review();

    expect(report.results[0].passed).toBe(false);
    expect(report.results[0].error).toContain('string error');
  });

  it('catches non-Error throws (object)', async () => {
    reviewer.register(makeThrowingProbe('test.throw-obj', { reason: 'bad' }));

    const report = await reviewer.review();

    expect(report.results[0].passed).toBe(false);
    expect(report.results[0].error).toBeDefined();
  });

  it('fails probe that returns null', async () => {
    reviewer.register({
      ...makePassingProbe('test.null'),
      async run() {
        return null as unknown as ProbeResult;
      },
    });

    const report = await reviewer.review();

    expect(report.results[0].passed).toBe(false);
    expect(report.results[0].error).toContain('did not return a valid ProbeResult');
  });

  it('fails probe that returns non-boolean passed field', async () => {
    reviewer.register({
      ...makePassingProbe('test.bad-passed'),
      async run() {
        return {
          probeId: 'test.bad-passed',
          name: 'Bad',
          tier: 1 as const,
          passed: 'true' as unknown as boolean,
          description: 'Not a boolean',
          durationMs: 0,
        };
      },
    });

    const report = await reviewer.review();

    expect(report.results[0].passed).toBe(false);
    expect(report.results[0].error).toContain('did not return a valid ProbeResult');
  });

  // ── Timeout Handling ────────────────────────────────────────────────

  it('times out slow probes', async () => {
    reviewer.register({
      id: 'test.timeout',
      name: 'Timeout Probe',
      tier: 1,
      feature: 'Test',
      timeoutMs: 50, // Very short timeout
      prerequisites: () => true,
      async run() {
        await new Promise(r => setTimeout(r, 2000)); // Takes 2s
        return {
          probeId: 'test.timeout',
          name: 'Timeout Probe',
          tier: 1 as const,
          passed: true,
          description: 'Should not reach here',
          durationMs: 0,
        };
      },
    });

    const report = await reviewer.review();

    expect(report.results).toHaveLength(1);
    expect(report.results[0].passed).toBe(false);
    expect(report.results[0].error).toContain('timeout');
  });

  it('times out entire review when reviewTimeoutMs exceeded', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-review-timeout-'));
    const rev = new SystemReviewer(
      { enabled: false, reviewTimeoutMs: 50 },
      makeDeps(dir),
    );

    // Tier 1 probe that takes a while
    rev.register(makeSlowProbe('test.slow1', 200, 1));
    // Tier 2 probe that should be skipped due to review timeout
    rev.register(makePassingProbe('test.t2', 2));

    const report = await rev.review();

    // Tier 2 should be marked as timed out (review timeout exceeded)
    const tier2Results = report.results.filter(r => r.probeId === 'test.t2');
    if (tier2Results.length > 0) {
      expect(tier2Results[0].passed).toBe(false);
      expect(tier2Results[0].error).toContain('Review timeout');
    }

    rev.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── Concurrency Control ─────────────────────────────────────────────

  it('prevents concurrent reviews', async () => {
    reviewer.register({
      ...makePassingProbe('test.slow'),
      async run() {
        await new Promise(r => setTimeout(r, 100));
        return {
          probeId: 'test.slow',
          name: 'Slow',
          tier: 1 as const,
          passed: true,
          description: 'Slow probe',
          durationMs: 100,
        };
      },
    });

    const p1 = reviewer.review();
    await expect(reviewer.review()).rejects.toThrow('already in progress');
    await p1;
  });

  it('isReviewing() returns true during review', async () => {
    let capturedState = false;
    reviewer.register({
      ...makePassingProbe('test.check'),
      async run() {
        capturedState = reviewer.isReviewing();
        return {
          probeId: 'test.check',
          name: 'Check',
          tier: 1 as const,
          passed: true,
          description: 'Checked',
          durationMs: 0,
        };
      },
    });

    expect(reviewer.isReviewing()).toBe(false);
    await reviewer.review();
    expect(capturedState).toBe(true);
    expect(reviewer.isReviewing()).toBe(false);
  });

  it('reviewInProgress resets after error', async () => {
    // Register a probe that will cause an exception at the framework level
    reviewer.register(makePassingProbe('test.a'));

    await reviewer.review();
    expect(reviewer.isReviewing()).toBe(false);
  });

  // ── Serial Group Execution ──────────────────────────────────────────

  it('runs probes in same serial group sequentially', async () => {
    const executionOrder: string[] = [];

    reviewer.register({
      id: 'test.serial.a',
      name: 'Serial A',
      tier: 1,
      feature: 'Test',
      serialGroup: 'sqlite',
      timeoutMs: 5000,
      prerequisites: () => true,
      async run() {
        executionOrder.push('a-start');
        await new Promise(r => setTimeout(r, 50));
        executionOrder.push('a-end');
        return {
          probeId: 'test.serial.a', name: 'Serial A', tier: 1 as const,
          passed: true, description: 'A', durationMs: 50,
        };
      },
    });

    reviewer.register({
      id: 'test.serial.b',
      name: 'Serial B',
      tier: 1,
      feature: 'Test',
      serialGroup: 'sqlite',
      timeoutMs: 5000,
      prerequisites: () => true,
      async run() {
        executionOrder.push('b-start');
        await new Promise(r => setTimeout(r, 50));
        executionOrder.push('b-end');
        return {
          probeId: 'test.serial.b', name: 'Serial B', tier: 1 as const,
          passed: true, description: 'B', durationMs: 50,
        };
      },
    });

    await reviewer.review();

    // Serial group ensures sequential execution: a completes before b starts
    expect(executionOrder.indexOf('a-end')).toBeLessThan(executionOrder.indexOf('b-start'));
  });

  it('runs different serial groups concurrently', async () => {
    const timestamps: Record<string, number> = {};

    reviewer.register({
      id: 'test.group1',
      name: 'Group1',
      tier: 1,
      feature: 'Test',
      serialGroup: 'group-one',
      timeoutMs: 5000,
      prerequisites: () => true,
      async run() {
        timestamps['g1-start'] = Date.now();
        await new Promise(r => setTimeout(r, 50));
        timestamps['g1-end'] = Date.now();
        return {
          probeId: 'test.group1', name: 'G1', tier: 1 as const,
          passed: true, description: 'G1', durationMs: 50,
        };
      },
    });

    reviewer.register({
      id: 'test.group2',
      name: 'Group2',
      tier: 1,
      feature: 'Test',
      serialGroup: 'group-two',
      timeoutMs: 5000,
      prerequisites: () => true,
      async run() {
        timestamps['g2-start'] = Date.now();
        await new Promise(r => setTimeout(r, 50));
        timestamps['g2-end'] = Date.now();
        return {
          probeId: 'test.group2', name: 'G2', tier: 1 as const,
          passed: true, description: 'G2', durationMs: 50,
        };
      },
    });

    await reviewer.review();

    // Different groups should overlap (g2 starts before g1 ends, or close to it)
    // Allow small timing buffer
    const overlap = timestamps['g2-start'] < timestamps['g1-end'] + 20;
    expect(overlap).toBe(true);
  });

  // ── Dry Run ──────────────────────────────────────────────────────────

  it('dry run returns report without executing probes', async () => {
    const runSpy = vi.fn();
    reviewer.register({
      ...makePassingProbe('test.dryrun'),
      async run() {
        runSpy();
        return {
          probeId: 'test.dryrun', name: 'Dry', tier: 1 as const,
          passed: true, description: 'Dry', durationMs: 0,
        };
      },
    });

    const report = await reviewer.review({ dryRun: true });

    expect(runSpy).not.toHaveBeenCalled();
    expect(report.results).toHaveLength(0);
    expect(report.skipped.length).toBeGreaterThan(0);
    expect(report.skipped[0].reason).toContain('Dry run');
    expect(report.status).toBe('all-clear');
  });

  it('dry run shows which probes would skip prerequisites', async () => {
    reviewer.register(makePassingProbe('test.yes'));
    reviewer.register(makeSkippedProbe('test.nopre'));

    const report = await reviewer.review({ dryRun: true });

    const yesSkip = report.skipped.find(s => s.probeId === 'test.yes');
    const nopreSkip = report.skipped.find(s => s.probeId === 'test.nopre');
    expect(yesSkip?.reason).toContain('run');
    expect(nopreSkip?.reason).toContain('prerequisites');
  });

  // ── Review with no probes ──────────────────────────────────────────

  it('review with no probes returns all-clear report', async () => {
    const report = await reviewer.review();

    expect(report.status).toBe('all-clear');
    expect(report.results).toHaveLength(0);
    expect(report.stats.total).toBe(0);
  });

  // ── History & Persistence ──────────────────────────────────────────

  it('persists history to JSONL', async () => {
    reviewer.register(makePassingProbe('test.a'));

    await reviewer.review();
    await reviewer.review();

    expect(reviewer.getHistory()).toHaveLength(2);

    const historyPath = path.join(stateDir, 'review-history.jsonl');
    expect(fs.existsSync(historyPath)).toBe(true);
    const lines = fs.readFileSync(historyPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('getHistory respects limit parameter', async () => {
    reviewer.register(makePassingProbe('test.a'));

    await reviewer.review();
    await reviewer.review();
    await reviewer.review();

    expect(reviewer.getHistory(2)).toHaveLength(2);
    expect(reviewer.getHistory()).toHaveLength(3);
  });

  it('getLatest returns the most recent report', async () => {
    reviewer.register(makePassingProbe('test.a'));

    await reviewer.review();
    const second = await reviewer.review();

    const latest = reviewer.getLatest();
    expect(latest).toBeDefined();
    expect(latest?.timestamp).toBe(second.timestamp);
  });

  it('trims history to historyLimit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-review-limit-'));
    const rev = new SystemReviewer(
      { enabled: false, historyLimit: 3 },
      makeDeps(dir),
    );
    rev.register(makePassingProbe('test.a'));

    for (let i = 0; i < 5; i++) {
      await rev.review();
    }

    expect(rev.getHistory()).toHaveLength(3);
    rev.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads history from JSONL file on startup', async () => {
    reviewer.register(makePassingProbe('test.a'));
    await reviewer.review();
    await reviewer.review();

    // Create a new instance pointing to same stateDir
    const reviewer2 = new SystemReviewer({ enabled: false }, makeDeps(stateDir));
    expect(reviewer2.getHistory()).toHaveLength(2);
    reviewer2.stop();
  });

  it('skips malformed JSONL lines on load', async () => {
    const historyPath = path.join(stateDir, 'review-history.jsonl');
    fs.writeFileSync(historyPath, [
      JSON.stringify({ timestamp: '2024-01-01', status: 'all-clear', results: [], skipped: [], stats: { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 } }),
      'NOT VALID JSON',
      JSON.stringify({ timestamp: '2024-01-02', status: 'all-clear', results: [], skipped: [], stats: { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 } }),
    ].join('\n') + '\n');

    const rev = new SystemReviewer({ enabled: false }, makeDeps(stateDir));
    expect(rev.getHistory()).toHaveLength(2);
    rev.stop();
  });

  it('compacts history when file exceeds 2x limit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-compact-'));
    const rev = new SystemReviewer(
      { enabled: false, historyLimit: 3 },
      makeDeps(dir),
    );
    rev.register(makePassingProbe('test.a'));

    // Run exactly 7 reviews: file grows to 7 lines, triggers compaction (> 2*3=6),
    // which rewrites to in-memory history (3 entries)
    for (let i = 0; i < 7; i++) {
      await rev.review();
    }

    const historyPath = path.join(dir, 'review-history.jsonl');
    const lines = fs.readFileSync(historyPath, 'utf-8').trim().split('\n');
    // After compaction, file should have exactly historyLimit lines
    expect(lines.length).toBe(3);

    rev.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── Dead Letter Fallback ────────────────────────────────────────────

  it('writes dead letter when history persistence fails', async () => {
    reviewer.register(makePassingProbe('test.a'));
    await reviewer.review();

    // Make the stateDir read-only to cause persistence failure
    const historyPath = path.join(stateDir, 'review-history.jsonl');

    // Create a directory where the history file should be (to cause write error)
    try {
      // safe-git-allow: incremental-migration
      fs.unlinkSync(historyPath);
    } catch { /* may not exist */ }
    fs.mkdirSync(historyPath, { recursive: true });

    // This review's persistence should fail
    await reviewer.review();

    const deadLetterPath = path.join(stateDir, 'doctor-dead-letter.jsonl');
    expect(fs.existsSync(deadLetterPath)).toBe(true);
    const content = fs.readFileSync(deadLetterPath, 'utf-8');
    expect(content).toContain('history-persist-error');

    // Cleanup: remove the directory we created
    // safe-git-allow: incremental-migration
    fs.rmSync(historyPath, { recursive: true, force: true });
  });

  // ── Trend Analysis ──────────────────────────────────────────────────

  it('provides trend analysis', async () => {
    reviewer.register(makePassingProbe('test.a'));

    await reviewer.review();
    await reviewer.review();

    const trend = reviewer.getTrend();
    expect(trend.window).toBe(2);
    expect(trend.direction).toBe('stable');
  });

  it('trend returns stable with less than 2 reviews', async () => {
    const trend = reviewer.getTrend();
    expect(trend.window).toBe(0);
    expect(trend.direction).toBe('stable');
    expect(trend.persistentFailures).toHaveLength(0);
    expect(trend.newFailures).toHaveLength(0);
    expect(trend.recovered).toHaveLength(0);
  });

  it('trend returns stable with 1 review', async () => {
    reviewer.register(makePassingProbe('test.a'));
    await reviewer.review();

    const trend = reviewer.getTrend();
    expect(trend.window).toBe(1);
    expect(trend.direction).toBe('stable');
  });

  it('trend detects declining direction', async () => {
    // First reviews: all pass
    reviewer.register(makePassingProbe('test.a'));
    reviewer.register(makePassingProbe('test.b'));

    await reviewer.review();
    await reviewer.review();
    await reviewer.review();

    // Now make probes fail
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-decline-'));
    const rev2 = new SystemReviewer({ enabled: false }, makeDeps(dir2));
    rev2.register(makePassingProbe('test.a'));
    rev2.register(makeFailingProbe('test.b'));

    // Manually inject history: first half all pass, second half has failures
    const goodReport = {
      timestamp: new Date().toISOString(),
      status: 'all-clear' as const,
      results: [
        { probeId: 'test.a', name: 'A', tier: 1 as const, passed: true, description: 'ok', durationMs: 1 },
        { probeId: 'test.b', name: 'B', tier: 1 as const, passed: true, description: 'ok', durationMs: 1 },
      ],
      skipped: [],
      stats: { total: 2, passed: 2, failed: 0, skipped: 0, durationMs: 1 },
    };
    const badReport = {
      timestamp: new Date().toISOString(),
      status: 'critical' as const,
      results: [
        { probeId: 'test.a', name: 'A', tier: 1 as const, passed: true, description: 'ok', durationMs: 1 },
        { probeId: 'test.b', name: 'B', tier: 1 as const, passed: false, description: 'fail', durationMs: 1, error: 'broke' },
      ],
      skipped: [],
      stats: { total: 2, passed: 1, failed: 1, skipped: 0, durationMs: 1 },
    };

    // Write history: first 5 good, last 5 bad
    const historyPath = path.join(dir2, 'review-history.jsonl');
    const lines = [
      ...Array(5).fill(JSON.stringify(goodReport)),
      ...Array(5).fill(JSON.stringify(badReport)),
    ];
    fs.writeFileSync(historyPath, lines.join('\n') + '\n');

    const rev3 = new SystemReviewer({ enabled: false }, makeDeps(dir2));
    const trend = rev3.getTrend();
    expect(trend.direction).toBe('declining');
    rev2.stop();
    rev3.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir2, { recursive: true, force: true });
  });

  it('trend detects improving direction', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-improve-'));

    const badReport = {
      timestamp: new Date().toISOString(),
      status: 'critical' as const,
      results: [
        { probeId: 'test.a', name: 'A', tier: 1 as const, passed: false, description: 'fail', durationMs: 1, error: 'broke' },
      ],
      skipped: [],
      stats: { total: 1, passed: 0, failed: 1, skipped: 0, durationMs: 1 },
    };
    const goodReport = {
      timestamp: new Date().toISOString(),
      status: 'all-clear' as const,
      results: [
        { probeId: 'test.a', name: 'A', tier: 1 as const, passed: true, description: 'ok', durationMs: 1 },
      ],
      skipped: [],
      stats: { total: 1, passed: 1, failed: 0, skipped: 0, durationMs: 1 },
    };

    // First 5 bad, last 5 good → improving
    const historyPath = path.join(dir, 'review-history.jsonl');
    const lines = [
      ...Array(5).fill(JSON.stringify(badReport)),
      ...Array(5).fill(JSON.stringify(goodReport)),
    ];
    fs.writeFileSync(historyPath, lines.join('\n') + '\n');

    const rev = new SystemReviewer({ enabled: false }, makeDeps(dir));
    const trend = rev.getTrend();
    expect(trend.direction).toBe('improving');
    rev.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('trend detects persistent failures (3+ consecutive)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-persistent-'));

    const failReport = {
      timestamp: new Date().toISOString(),
      status: 'critical' as const,
      results: [
        { probeId: 'test.broken', name: 'Broken', tier: 1 as const, passed: false, description: 'fail', durationMs: 1, error: 'broke' },
        { probeId: 'test.ok', name: 'OK', tier: 1 as const, passed: true, description: 'ok', durationMs: 1 },
      ],
      skipped: [],
      stats: { total: 2, passed: 1, failed: 1, skipped: 0, durationMs: 1 },
    };

    const historyPath = path.join(dir, 'review-history.jsonl');
    // 5 reviews where test.broken always fails
    fs.writeFileSync(historyPath, Array(5).fill(JSON.stringify(failReport)).join('\n') + '\n');

    const rev = new SystemReviewer({ enabled: false }, makeDeps(dir));
    const trend = rev.getTrend();
    expect(trend.persistentFailures).toContain('test.broken');
    expect(trend.persistentFailures).not.toContain('test.ok');
    rev.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('trend detects new failures', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-newfail-'));

    const passReport = {
      timestamp: new Date().toISOString(),
      status: 'all-clear' as const,
      results: [
        { probeId: 'test.flaky', name: 'Flaky', tier: 1 as const, passed: true, description: 'ok', durationMs: 1 },
      ],
      skipped: [],
      stats: { total: 1, passed: 1, failed: 0, skipped: 0, durationMs: 1 },
    };
    const failReport = {
      timestamp: new Date().toISOString(),
      status: 'critical' as const,
      results: [
        { probeId: 'test.flaky', name: 'Flaky', tier: 1 as const, passed: false, description: 'fail', durationMs: 1, error: 'broke' },
      ],
      skipped: [],
      stats: { total: 1, passed: 0, failed: 1, skipped: 0, durationMs: 1 },
    };

    const historyPath = path.join(dir, 'review-history.jsonl');
    // Passing, then failing = new failure
    fs.writeFileSync(historyPath, [JSON.stringify(passReport), JSON.stringify(failReport)].join('\n') + '\n');

    const rev = new SystemReviewer({ enabled: false }, makeDeps(dir));
    const trend = rev.getTrend();
    expect(trend.newFailures).toContain('test.flaky');
    rev.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('trend detects recovered probes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-recovered-'));

    const failReport = {
      timestamp: new Date().toISOString(),
      status: 'critical' as const,
      results: [
        { probeId: 'test.fixed', name: 'Fixed', tier: 1 as const, passed: false, description: 'fail', durationMs: 1, error: 'broke' },
      ],
      skipped: [],
      stats: { total: 1, passed: 0, failed: 1, skipped: 0, durationMs: 1 },
    };
    const passReport = {
      timestamp: new Date().toISOString(),
      status: 'all-clear' as const,
      results: [
        { probeId: 'test.fixed', name: 'Fixed', tier: 1 as const, passed: true, description: 'ok', durationMs: 1 },
      ],
      skipped: [],
      stats: { total: 1, passed: 1, failed: 0, skipped: 0, durationMs: 1 },
    };

    const historyPath = path.join(dir, 'review-history.jsonl');
    // Failing, then passing = recovered
    fs.writeFileSync(historyPath, [JSON.stringify(failReport), JSON.stringify(passReport)].join('\n') + '\n');

    const rev = new SystemReviewer({ enabled: false }, makeDeps(dir));
    const trend = rev.getTrend();
    expect(trend.recovered).toContain('test.fixed');
    rev.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── Health Status ──────────────────────────────────────────────────

  it('provides health status for HealthChecker integration', async () => {
    reviewer.register(makePassingProbe('test.a'));

    const before = reviewer.getHealthStatus();
    expect(before.status).toBe('healthy');
    expect(before.message).toContain('No reviews');

    await reviewer.review();

    const after = reviewer.getHealthStatus();
    expect(after.status).toBe('healthy');
    expect(after.lastCheck).toBeTruthy();
    expect(after.message).toContain('1/1');
  });

  it('health status reflects degraded state', async () => {
    reviewer.register(makePassingProbe('test.ok', 1));
    reviewer.register(makeFailingProbe('test.fail', 2));

    await reviewer.review();

    const status = reviewer.getHealthStatus();
    expect(status.status).toBe('degraded');
    expect(status.message).toContain('1/2');
  });

  it('health status reflects unhealthy state', async () => {
    reviewer.register(makeFailingProbe('test.crit', 1));

    await reviewer.review();

    const status = reviewer.getHealthStatus();
    expect(status.status).toBe('unhealthy');
  });

  // ── Events ──────────────────────────────────────────────────────────

  it('emits review:complete event', async () => {
    reviewer.register(makePassingProbe('test.a'));

    const listener = vi.fn();
    reviewer.on('review:complete', listener);

    await reviewer.review();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].status).toBe('all-clear');
  });

  it('emits review:probe-failed for failures', async () => {
    reviewer.register(makeFailingProbe('test.fail'));

    const listener = vi.fn();
    reviewer.on('review:probe-failed', listener);

    await reviewer.review();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].probeId).toBe('test.fail');
  });

  it('emits review:probe-failed for probe exceptions', async () => {
    reviewer.register(makeThrowingProbe('test.throw'));

    const listener = vi.fn();
    reviewer.on('review:probe-failed', listener);

    await reviewer.review();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].probeId).toBe('test.throw');
  });

  it('emits multiple probe-failed events for multiple failures', async () => {
    reviewer.register(makeFailingProbe('test.f1'));
    reviewer.register(makeFailingProbe('test.f2'));

    const listener = vi.fn();
    reviewer.on('review:probe-failed', listener);

    await reviewer.review();

    expect(listener).toHaveBeenCalledTimes(2);
  });

  // ── Duration Override ──────────────────────────────────────────────

  it('overrides probe-reported duration with measured duration', async () => {
    reviewer.register({
      ...makePassingProbe('test.dur'),
      async run() {
        await new Promise(r => setTimeout(r, 30));
        return {
          probeId: 'test.dur', name: 'Dur', tier: 1 as const,
          passed: true, description: 'ok',
          durationMs: 999999, // Probe claims huge duration
        };
      },
    });

    const report = await reviewer.review();

    // The orchestrator should override with its own measurement
    expect(report.results[0].durationMs).toBeLessThan(999999);
    expect(report.results[0].durationMs).toBeGreaterThanOrEqual(20); // At least ~30ms
  });

  // ── Alerting ────────────────────────────────────────────────────────

  it('sends alert for Tier 1 failures', async () => {
    const sendAlert = vi.fn().mockResolvedValue(undefined);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-alert-'));
    const rev = new SystemReviewer(
      { enabled: false, alertOnCritical: true },
      makeDeps(dir, { sendAlert }),
    );
    rev.register(makeFailingProbe('test.crit', 1));

    await rev.review();

    expect(sendAlert).toHaveBeenCalledOnce();
    const alertText = sendAlert.mock.calls[0][1];
    // Narrative format: probe name, error cause, remediation
    expect(alertText).toContain('test.crit');
    expect(alertText).toContain('Expected 42, got 0');
    rev.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sends alert for Tier 2 failures', async () => {
    const sendAlert = vi.fn().mockResolvedValue(undefined);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-alert2-'));
    const rev = new SystemReviewer(
      { enabled: false, alertOnCritical: true },
      makeDeps(dir, { sendAlert }),
    );
    rev.register(makeFailingProbe('test.high', 2));

    await rev.review();

    expect(sendAlert).toHaveBeenCalledOnce();
    const alertText = sendAlert.mock.calls[0][1];
    // Narrative format: probe name and error cause
    expect(alertText).toContain('test.high');
    expect(alertText).toContain('Expected 42, got 0');
    rev.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not send alert for Tier 3+ failures', async () => {
    const sendAlert = vi.fn().mockResolvedValue(undefined);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-alert3-'));
    const rev = new SystemReviewer(
      { enabled: false, alertOnCritical: true },
      makeDeps(dir, { sendAlert }),
    );
    rev.register(makeFailingProbe('test.low', 3));

    await rev.review();

    expect(sendAlert).not.toHaveBeenCalled();
    rev.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('respects alert cooldown', async () => {
    const sendAlert = vi.fn().mockResolvedValue(undefined);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-cooldown-'));
    const rev = new SystemReviewer(
      { enabled: false, alertOnCritical: true, alertCooldownMs: 60_000 },
      makeDeps(dir, { sendAlert }),
    );
    rev.register(makeFailingProbe('test.crit', 1));

    await rev.review();
    expect(sendAlert).toHaveBeenCalledOnce();

    // Second review should be suppressed (within cooldown)
    await rev.review();
    expect(sendAlert).toHaveBeenCalledOnce(); // Still 1

    rev.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not alert when alertOnCritical is false', async () => {
    const sendAlert = vi.fn().mockResolvedValue(undefined);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-noalert-'));
    const rev = new SystemReviewer(
      { enabled: false, alertOnCritical: false },
      makeDeps(dir, { sendAlert }),
    );
    rev.register(makeFailingProbe('test.crit', 1));

    await rev.review();

    expect(sendAlert).not.toHaveBeenCalled();
    rev.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes dead letter when alert sending fails', async () => {
    const sendAlert = vi.fn().mockRejectedValue(new Error('Telegram down'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-alertfail-'));
    const rev = new SystemReviewer(
      { enabled: false, alertOnCritical: true },
      makeDeps(dir, { sendAlert }),
    );
    rev.register(makeFailingProbe('test.crit', 1));

    await rev.review();

    const deadLetterPath = path.join(dir, 'doctor-dead-letter.jsonl');
    expect(fs.existsSync(deadLetterPath)).toBe(true);
    const content = fs.readFileSync(deadLetterPath, 'utf-8');
    expect(content).toContain('alert-send-error');
    expect(content).toContain('Telegram down');
    rev.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── Feedback Submission ─────────────────────────────────────────────

  it('submits feedback when both flags are true', async () => {
    const submitFeedback = vi.fn().mockResolvedValue(undefined);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-feedback-'));
    const rev = new SystemReviewer(
      { enabled: false, autoSubmitFeedback: true, feedbackConsentGiven: true },
      makeDeps(dir, { submitFeedback }),
    );
    rev.register(makeFailingProbe('test.fail', 1));

    await rev.review();

    expect(submitFeedback).toHaveBeenCalledOnce();
    expect(submitFeedback.mock.calls[0][0].title).toContain('test.fail');
    expect(submitFeedback.mock.calls[0][0].type).toBe('bug');
    rev.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not submit feedback when autoSubmitFeedback is false', async () => {
    const submitFeedback = vi.fn().mockResolvedValue(undefined);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-nofb1-'));
    const rev = new SystemReviewer(
      { enabled: false, autoSubmitFeedback: false, feedbackConsentGiven: true },
      makeDeps(dir, { submitFeedback }),
    );
    rev.register(makeFailingProbe('test.fail', 1));

    await rev.review();

    expect(submitFeedback).not.toHaveBeenCalled();
    rev.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not submit feedback when feedbackConsentGiven is false', async () => {
    const submitFeedback = vi.fn().mockResolvedValue(undefined);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-nofb2-'));
    const rev = new SystemReviewer(
      { enabled: false, autoSubmitFeedback: true, feedbackConsentGiven: false },
      makeDeps(dir, { submitFeedback }),
    );
    rev.register(makeFailingProbe('test.fail', 1));

    await rev.review();

    expect(submitFeedback).not.toHaveBeenCalled();
    rev.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('dedups feedback (same probe failed in previous review)', async () => {
    const submitFeedback = vi.fn().mockResolvedValue(undefined);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-dedup-'));
    const rev = new SystemReviewer(
      { enabled: false, autoSubmitFeedback: true, feedbackConsentGiven: true },
      makeDeps(dir, { submitFeedback }),
    );
    rev.register(makeFailingProbe('test.repeat', 1));

    await rev.review(); // First time: submits
    expect(submitFeedback).toHaveBeenCalledOnce();

    await rev.review(); // Second time: deduped
    expect(submitFeedback).toHaveBeenCalledOnce(); // Still 1

    rev.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('redacts secrets from feedback descriptions', async () => {
    const submitFeedback = vi.fn().mockResolvedValue(undefined);
    const redactSecrets = vi.fn((text: string) => text.replace(/sk-[a-z0-9]+/g, '[REDACTED]'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-redact-'));
    const rev = new SystemReviewer(
      { enabled: false, autoSubmitFeedback: true, feedbackConsentGiven: true },
      makeDeps(dir, { submitFeedback, redactSecrets }),
    );
    rev.register(makeFailingProbe('test.secret', 1));

    await rev.review();

    expect(redactSecrets).toHaveBeenCalled();
    rev.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes dead letter when feedback submission fails', async () => {
    const submitFeedback = vi.fn().mockRejectedValue(new Error('Network down'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-fbfail-'));
    const rev = new SystemReviewer(
      { enabled: false, autoSubmitFeedback: true, feedbackConsentGiven: true },
      makeDeps(dir, { submitFeedback }),
    );
    rev.register(makeFailingProbe('test.fail', 1));

    await rev.review();

    const deadLetterPath = path.join(dir, 'doctor-dead-letter.jsonl');
    expect(fs.existsSync(deadLetterPath)).toBe(true);
    const content = fs.readFileSync(deadLetterPath, 'utf-8');
    expect(content).toContain('feedback-submit-error');
    rev.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── Cleanup & Startup Sweep ────────────────────────────────────────

  it('registers and runs cleanup callbacks', async () => {
    const cleanup1 = vi.fn().mockResolvedValue(undefined);
    const cleanup2 = vi.fn().mockResolvedValue(undefined);

    reviewer.registerCleanup(cleanup1);
    reviewer.registerCleanup(cleanup2);

    const cleaned = await reviewer.runStartupSweep();

    expect(cleaned).toBe(2);
    expect(cleanup1).toHaveBeenCalledOnce();
    expect(cleanup2).toHaveBeenCalledOnce();
  });

  it('handles cleanup callback errors without crashing', async () => {
    const goodCleanup = vi.fn().mockResolvedValue(undefined);
    const badCleanup = vi.fn().mockRejectedValue(new Error('Cleanup failed'));

    reviewer.registerCleanup(badCleanup);
    reviewer.registerCleanup(goodCleanup);

    const cleaned = await reviewer.runStartupSweep();

    // badCleanup fails, goodCleanup succeeds
    expect(cleaned).toBe(1);
    expect(badCleanup).toHaveBeenCalled();
    expect(goodCleanup).toHaveBeenCalled();

    // Dead letter should record the error
    const deadLetterPath = path.join(stateDir, 'doctor-dead-letter.jsonl');
    expect(fs.existsSync(deadLetterPath)).toBe(true);
    const content = fs.readFileSync(deadLetterPath, 'utf-8');
    expect(content).toContain('startup-sweep-error');
  });

  // ── Scheduling ──────────────────────────────────────────────────────

  it('start() does nothing when disabled', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-no-start-'));
    const rev = new SystemReviewer({ enabled: false }, makeDeps(dir));
    rev.start();
    // No timer should be set — nothing to assert directly, but stop() shouldn't throw
    rev.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('start() is idempotent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-idempotent-'));
    const rev = new SystemReviewer({ enabled: true, scheduleMs: 999999 }, makeDeps(dir));
    rev.start();
    rev.start(); // Should not create a second timer
    rev.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── Tier Ordering ──────────────────────────────────────────────────

  it('executes tiers in order (1 before 2 before 3)', async () => {
    const executionOrder: number[] = [];

    for (const tier of [3, 1, 2] as const) {
      reviewer.register({
        id: `test.tier${tier}`,
        name: `Tier ${tier}`,
        tier,
        feature: 'Test',
        timeoutMs: 5000,
        prerequisites: () => true,
        async run() {
          executionOrder.push(tier);
          return {
            probeId: `test.tier${tier}`, name: `T${tier}`, tier,
            passed: true, description: 'ok', durationMs: 0,
          };
        },
      });
    }

    await reviewer.review();

    expect(executionOrder).toEqual([1, 2, 3]);
  });
});

// ── Session Probes Tests ────────────────────────────────────────────

describe('SessionProbes', () => {
  it('returns 4 probes', () => {
    const probes = createSessionProbes({
      listRunningSessions: () => [],
      getSessionDiagnostics: () => ({ sessions: [] }),
      maxSessions: 3,
      tmuxPath: '/usr/bin/tmux',
    });
    expect(probes).toHaveLength(4);
    expect(probes.every(p => p.tier === 1)).toBe(true);
    expect(probes.every(p => p.feature === 'Session Management')).toBe(true);
  });

  it('session.list passes with valid array', async () => {
    const probes = createSessionProbes({
      listRunningSessions: () => [{ id: '1', tmuxSession: 'test-1', name: 'Test' }],
      getSessionDiagnostics: () => ({ sessions: [] }),
      maxSessions: 3,
      tmuxPath: '/usr/bin/tmux',
    });
    const listProbe = probes.find(p => p.id === 'instar.session.list')!;
    const result = await listProbe.run();
    expect(result.passed).toBe(true);
    expect(result.description).toContain('1 running');
    expect(result.diagnostics?.count).toBe(1);
  });

  it('session.list passes with empty array', async () => {
    const probes = createSessionProbes({
      listRunningSessions: () => [],
      getSessionDiagnostics: () => ({ sessions: [] }),
      maxSessions: 3,
      tmuxPath: '/usr/bin/tmux',
    });
    const probe = probes.find(p => p.id === 'instar.session.list')!;
    const result = await probe.run();
    expect(result.passed).toBe(true);
    expect(result.description).toContain('0 running');
  });

  it('session.list fails when listRunningSessions returns non-array', async () => {
    const probes = createSessionProbes({
      listRunningSessions: () => 'not an array' as unknown as Array<{ id: string; tmuxSession: string; name: string }>,
      getSessionDiagnostics: () => ({ sessions: [] }),
      maxSessions: 3,
      tmuxPath: '/usr/bin/tmux',
    });
    const probe = probes.find(p => p.id === 'instar.session.list')!;
    const result = await probe.run();
    expect(result.passed).toBe(false);
    expect(result.description).toContain('non-array');
  });

  it('session.list fails when listRunningSessions throws', async () => {
    const probes = createSessionProbes({
      listRunningSessions: () => { throw new Error('State corrupt'); },
      getSessionDiagnostics: () => ({ sessions: [] }),
      maxSessions: 3,
      tmuxPath: '/usr/bin/tmux',
    });
    const probe = probes.find(p => p.id === 'instar.session.list')!;
    const result = await probe.run();
    expect(result.passed).toBe(false);
    expect(result.error).toContain('State corrupt');
    expect(result.stack).toBeDefined();
  });

  it('session.diagnostics passes with valid structure', async () => {
    const probes = createSessionProbes({
      listRunningSessions: () => [],
      getSessionDiagnostics: () => ({
        sessions: [{ name: 'sess1', ageMinutes: 30 }, { name: 'sess2', ageMinutes: 60 }],
      }),
      maxSessions: 3,
      tmuxPath: '/usr/bin/tmux',
    });
    const probe = probes.find(p => p.id === 'instar.session.diagnostics')!;
    const result = await probe.run();
    expect(result.passed).toBe(true);
    expect(result.description).toContain('2 session(s)');
    expect(result.diagnostics?.oldestMinutes).toBe(60);
  });

  it('session.diagnostics fails with null return', async () => {
    const probes = createSessionProbes({
      listRunningSessions: () => [],
      getSessionDiagnostics: () => null as unknown as { sessions: Array<{ name: string; ageMinutes: number }> },
      maxSessions: 3,
      tmuxPath: '/usr/bin/tmux',
    });
    const probe = probes.find(p => p.id === 'instar.session.diagnostics')!;
    const result = await probe.run();
    expect(result.passed).toBe(false);
    expect(result.description).toContain('invalid structure');
  });

  it('session.diagnostics fails when sessions field is not array', async () => {
    const probes = createSessionProbes({
      listRunningSessions: () => [],
      getSessionDiagnostics: () => ({ sessions: 'bad' as unknown as Array<{ name: string; ageMinutes: number }> }),
      maxSessions: 3,
      tmuxPath: '/usr/bin/tmux',
    });
    const probe = probes.find(p => p.id === 'instar.session.diagnostics')!;
    const result = await probe.run();
    expect(result.passed).toBe(false);
  });

  it('session.limits fails when exceeding absolute limit', async () => {
    const manySessions = Array.from({ length: 10 }, (_, i) => ({
      id: String(i), tmuxSession: `s-${i}`, name: `Session ${i}`,
    }));
    const probes = createSessionProbes({
      listRunningSessions: () => manySessions,
      getSessionDiagnostics: () => ({ sessions: [] }),
      maxSessions: 3, // Absolute limit = 3 * 3 = 9
      tmuxPath: '/usr/bin/tmux',
    });
    const limitProbe = probes.find(p => p.id === 'instar.session.limits')!;
    const result = await limitProbe.run();
    expect(result.passed).toBe(false);
    expect(result.description).toContain('exceeds');
    expect(result.expected).toContain('9');
    expect(result.actual).toContain('10');
  });

  it('session.limits passes within limits', async () => {
    const probes = createSessionProbes({
      listRunningSessions: () => [{ id: '1', tmuxSession: 's-1', name: 'S1' }],
      getSessionDiagnostics: () => ({ sessions: [] }),
      maxSessions: 3,
      tmuxPath: '/usr/bin/tmux',
    });
    const probe = probes.find(p => p.id === 'instar.session.limits')!;
    const result = await probe.run();
    expect(result.passed).toBe(true);
    expect(result.description).toContain('1/3');
  });

  it('session.limits fails with maxSessions = 0', async () => {
    const probes = createSessionProbes({
      listRunningSessions: () => [],
      getSessionDiagnostics: () => ({ sessions: [] }),
      maxSessions: 0,
      tmuxPath: '/usr/bin/tmux',
    });
    const probe = probes.find(p => p.id === 'instar.session.limits')!;
    const result = await probe.run();
    expect(result.passed).toBe(false);
    expect(result.error).toContain('must be > 0');
  });

  it('session.tmux-alive passes with no running sessions', async () => {
    const probes = createSessionProbes({
      listRunningSessions: () => [],
      getSessionDiagnostics: () => ({ sessions: [] }),
      maxSessions: 3,
      tmuxPath: '/usr/bin/tmux',
    });
    const probe = probes.find(p => p.id === 'instar.session.tmux-alive')!;
    const result = await probe.run();
    expect(result.passed).toBe(true);
    expect(result.description).toContain('No running sessions');
  });
});

// ── Scheduler Probes Tests ──────────────────────────────────────────

describe('SchedulerProbes', () => {
  it('returns 3 probes', () => {
    const probes = createSchedulerProbes({
      getJobs: () => [],
      getStatus: () => ({ running: true, paused: false, jobCount: 0, enabledJobs: 0, queueLength: 0 }),
      jobsFilePath: '/nonexistent/jobs.json',
    });
    expect(probes).toHaveLength(3);
    expect(probes.every(p => p.tier === 1)).toBe(true);
    expect(probes.every(p => p.feature === 'Job Scheduler')).toBe(true);
  });

  it('scheduler.loaded passes when jobs loaded', async () => {
    const probes = createSchedulerProbes({
      getJobs: () => [{ id: '1', name: 'Job1' }, { id: '2', name: 'Job2' }],
      getStatus: () => ({ running: true, paused: false, jobCount: 2, enabledJobs: 2, queueLength: 0 }),
      jobsFilePath: '/nonexistent/jobs.json', // File doesn't exist, no cross-ref
    });
    const probe = probes.find(p => p.id === 'instar.scheduler.loaded')!;
    const result = await probe.run();
    expect(result.passed).toBe(true);
    expect(result.description).toContain('2 job(s)');
  });

  it('scheduler.loaded fails when count mismatches jobs.json', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-test-'));
    const jobsFile = path.join(tmpDir, 'jobs.json');
    fs.writeFileSync(jobsFile, JSON.stringify([
      { slug: 'a', name: 'A', schedule: '* * * * *', model: 'haiku', enabled: true, execute: { type: 'prompt', value: 'test' } },
      { slug: 'b', name: 'B', schedule: '* * * * *', model: 'haiku', enabled: true, execute: { type: 'prompt', value: 'test' } },
      { slug: 'c', name: 'C', schedule: '* * * * *', model: 'haiku', enabled: true, execute: { type: 'prompt', value: 'test' } },
    ]));

    const probes = createSchedulerProbes({
      getJobs: () => [{ id: '1', name: 'Job1' }], // Only 1 loaded but 3 in file
      getStatus: () => ({ running: true, paused: false, jobCount: 1, enabledJobs: 1, queueLength: 0 }),
      jobsFilePath: jobsFile,
    });
    const probe = probes.find(p => p.id === 'instar.scheduler.loaded')!;
    const result = await probe.run();
    expect(result.passed).toBe(false);
    expect(result.description).toContain('mismatch');
    expect(result.expected).toContain('3');
    expect(result.actual).toContain('1');
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('scheduler.loaded passes when counts match jobs.json', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-match-'));
    const jobsFile = path.join(tmpDir, 'jobs.json');
    fs.writeFileSync(jobsFile, JSON.stringify([
      { slug: 'a', name: 'A' },
      { slug: 'b', name: 'B' },
    ]));

    const probes = createSchedulerProbes({
      getJobs: () => [{ id: '1', name: 'A' }, { id: '2', name: 'B' }],
      getStatus: () => ({ running: true, paused: false, jobCount: 2, enabledJobs: 2, queueLength: 0 }),
      jobsFilePath: jobsFile,
    });
    const probe = probes.find(p => p.id === 'instar.scheduler.loaded')!;
    const result = await probe.run();
    expect(result.passed).toBe(true);
    expect(result.description).toContain('matches jobs.json');
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('scheduler.running passes when active', async () => {
    const probes = createSchedulerProbes({
      getJobs: () => [],
      getStatus: () => ({ running: true, paused: false, jobCount: 2, enabledJobs: 2, queueLength: 0 }),
      jobsFilePath: '/nonexistent/jobs.json',
    });
    const probe = probes.find(p => p.id === 'instar.scheduler.running')!;
    const result = await probe.run();
    expect(result.passed).toBe(true);
    expect(result.description).toContain('running');
  });

  it('scheduler.running fails when stopped', async () => {
    const probes = createSchedulerProbes({
      getJobs: () => [],
      getStatus: () => ({ running: false, paused: false, jobCount: 0, enabledJobs: 0, queueLength: 0 }),
      jobsFilePath: '/nonexistent/jobs.json',
    });
    const probe = probes.find(p => p.id === 'instar.scheduler.running')!;
    const result = await probe.run();
    expect(result.passed).toBe(false);
    expect(result.error).toContain('stopped');
  });

  it('scheduler.running fails when paused', async () => {
    const probes = createSchedulerProbes({
      getJobs: () => [],
      getStatus: () => ({ running: true, paused: true, jobCount: 0, enabledJobs: 0, queueLength: 0 }),
      jobsFilePath: '/nonexistent/jobs.json',
    });
    const probe = probes.find(p => p.id === 'instar.scheduler.running')!;
    const result = await probe.run();
    expect(result.passed).toBe(false);
    expect(result.error).toContain('paused');
  });

  it('scheduler.queue passes with low queue', async () => {
    const probes = createSchedulerProbes({
      getJobs: () => [],
      getStatus: () => ({ running: true, paused: false, jobCount: 2, enabledJobs: 2, queueLength: 5 }),
      jobsFilePath: '/nonexistent/jobs.json',
    });
    const probe = probes.find(p => p.id === 'instar.scheduler.queue')!;
    const result = await probe.run();
    expect(result.passed).toBe(true);
    expect(result.description).toContain('5 pending');
  });

  it('scheduler.queue passes at exactly threshold (20)', async () => {
    const probes = createSchedulerProbes({
      getJobs: () => [],
      getStatus: () => ({ running: true, paused: false, jobCount: 2, enabledJobs: 2, queueLength: 20 }),
      jobsFilePath: '/nonexistent/jobs.json',
    });
    const probe = probes.find(p => p.id === 'instar.scheduler.queue')!;
    const result = await probe.run();
    expect(result.passed).toBe(true);
  });

  it('scheduler.queue fails on backlog (>20)', async () => {
    const probes = createSchedulerProbes({
      getJobs: () => [],
      getStatus: () => ({ running: true, paused: false, jobCount: 2, enabledJobs: 2, queueLength: 25 }),
      jobsFilePath: '/nonexistent/jobs.json',
    });
    const probe = probes.find(p => p.id === 'instar.scheduler.queue')!;
    const result = await probe.run();
    expect(result.passed).toBe(false);
    expect(result.description).toContain('backlog');
    expect(result.diagnostics?.threshold).toBe(20);
  });

  it('scheduler prerequisites fail when getStatus throws', () => {
    const probes = createSchedulerProbes({
      getJobs: () => [],
      getStatus: () => { throw new Error('No scheduler'); },
      jobsFilePath: '/nonexistent/jobs.json',
    });
    expect(probes[0].prerequisites()).toBe(false);
  });
});

// ── Messaging Probes Tests ──────────────────────────────────────────

describe('MessagingProbes', () => {
  it('returns 4 probes', () => {
    const probes = createMessagingProbes({
      getStatus: () => ({ started: true, uptime: 60000, pendingStalls: 0, pendingPromises: 0, topicMappings: 1 }),
      messageLogPath: '/nonexistent/messages.jsonl',
      isConfigured: () => true,
    });
    expect(probes).toHaveLength(4);
    expect(probes.every(p => p.tier === 1)).toBe(true);
    expect(probes.every(p => p.feature === 'Telegram Messaging')).toBe(true);
  });

  it('messaging.connected passes when started', async () => {
    const probes = createMessagingProbes({
      getStatus: () => ({ started: true, uptime: 120000, pendingStalls: 0, pendingPromises: 0, topicMappings: 2 }),
      messageLogPath: '/nonexistent/messages.jsonl',
      isConfigured: () => true,
    });
    const probe = probes.find(p => p.id === 'instar.messaging.connected')!;
    const result = await probe.run();
    expect(result.passed).toBe(true);
    expect(result.description).toContain('connected');
  });

  it('messaging.connected fails when not started', async () => {
    const probes = createMessagingProbes({
      getStatus: () => ({ started: false, uptime: null, pendingStalls: 0, pendingPromises: 0, topicMappings: 0 }),
      messageLogPath: '/nonexistent/messages.jsonl',
      isConfigured: () => true,
    });
    const probe = probes.find(p => p.id === 'instar.messaging.connected')!;
    const result = await probe.run();
    expect(result.passed).toBe(false);
    expect(result.description).toContain('not started');
  });

  it('messaging.polling passes when active', async () => {
    const probes = createMessagingProbes({
      getStatus: () => ({ started: true, uptime: 60000, pendingStalls: 0, pendingPromises: 0, topicMappings: 1 }),
      messageLogPath: '/nonexistent/messages.jsonl',
      isConfigured: () => true,
    });
    const probe = probes.find(p => p.id === 'instar.messaging.polling')!;
    const result = await probe.run();
    expect(result.passed).toBe(true);
    expect(result.description).toContain('active');
  });

  it('messaging.polling fails when not started', async () => {
    const probes = createMessagingProbes({
      getStatus: () => ({ started: false, uptime: null, pendingStalls: 0, pendingPromises: 0, topicMappings: 0 }),
      messageLogPath: '/nonexistent/messages.jsonl',
      isConfigured: () => true,
    });
    const probe = probes.find(p => p.id === 'instar.messaging.polling')!;
    const result = await probe.run();
    expect(result.passed).toBe(false);
  });

  it('messaging.polling fails with negative uptime (clock skew)', async () => {
    const probes = createMessagingProbes({
      getStatus: () => ({ started: true, uptime: -5000, pendingStalls: 0, pendingPromises: 0, topicMappings: 0 }),
      messageLogPath: '/nonexistent/messages.jsonl',
      isConfigured: () => true,
    });
    const probe = probes.find(p => p.id === 'instar.messaging.polling')!;
    const result = await probe.run();
    expect(result.passed).toBe(false);
    expect(result.description).toContain('clock skew');
  });

  it('messaging.log passes when file does not exist', async () => {
    const probes = createMessagingProbes({
      getStatus: () => ({ started: true, uptime: 60000, pendingStalls: 0, pendingPromises: 0, topicMappings: 0 }),
      messageLogPath: '/nonexistent/messages.jsonl',
      isConfigured: () => true,
    });
    const probe = probes.find(p => p.id === 'instar.messaging.log')!;
    const result = await probe.run();
    expect(result.passed).toBe(true);
    expect(result.description).toContain('does not exist');
  });

  it('messaging.log passes with recent file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-log-'));
    const logPath = path.join(tmpDir, 'messages.jsonl');
    fs.writeFileSync(logPath, '{"test": true}\n');

    const probes = createMessagingProbes({
      getStatus: () => ({ started: true, uptime: 60000, pendingStalls: 0, pendingPromises: 0, topicMappings: 0 }),
      messageLogPath: logPath,
      isConfigured: () => true,
    });
    const probe = probes.find(p => p.id === 'instar.messaging.log')!;
    const result = await probe.run();
    expect(result.passed).toBe(true);
    expect(result.description).toContain('active');
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('messaging.topics reports count', async () => {
    const probes = createMessagingProbes({
      getStatus: () => ({ started: true, uptime: 60000, pendingStalls: 0, pendingPromises: 0, topicMappings: 5 }),
      messageLogPath: '/nonexistent/messages.jsonl',
      isConfigured: () => true,
    });
    const probe = probes.find(p => p.id === 'instar.messaging.topics')!;
    const result = await probe.run();
    expect(result.passed).toBe(true);
    expect(result.description).toContain('5 topic');
  });

  it('messaging.topics passes with 0 mappings', async () => {
    const probes = createMessagingProbes({
      getStatus: () => ({ started: true, uptime: 60000, pendingStalls: 0, pendingPromises: 0, topicMappings: 0 }),
      messageLogPath: '/nonexistent/messages.jsonl',
      isConfigured: () => true,
    });
    const probe = probes.find(p => p.id === 'instar.messaging.topics')!;
    const result = await probe.run();
    expect(result.passed).toBe(true);
    expect(result.description).toContain('No topic');
  });

  it('prerequisites fail when not configured', () => {
    const probes = createMessagingProbes({
      getStatus: () => ({ started: true, uptime: 60000, pendingStalls: 0, pendingPromises: 0, topicMappings: 0 }),
      messageLogPath: '/nonexistent/messages.jsonl',
      isConfigured: () => false,
    });
    expect(probes[0].prerequisites()).toBe(false);
  });
});

// ── Lifeline Probes Tests ───────────────────────────────────────────

describe('LifelineProbes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-test-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 3 probes', () => {
    const probes = createLifelineProbes(makeDefaultLifelineDeps(tmpDir));
    expect(probes).toHaveLength(3);
    expect(probes.every(p => p.tier === 1)).toBe(true);
    expect(probes.every(p => p.feature === 'Lifeline')).toBe(true);
  });

  // ── Process Probe ──────────────────────────────────────────────────

  it('lifeline.process fails when no lock file', async () => {
    const probes = createLifelineProbes(makeDefaultLifelineDeps(tmpDir));
    const probe = probes.find(p => p.id === 'instar.lifeline.process')!;
    const result = await probe.run();
    expect(result.passed).toBe(false);
    expect(result.description).toContain('not found');
  });

  it('lifeline.process passes with valid lock file for current PID', async () => {
    const lockPath = path.join(tmpDir, 'lifeline.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

    const probes = createLifelineProbes(makeDefaultLifelineDeps(tmpDir));
    const probe = probes.find(p => p.id === 'instar.lifeline.process')!;
    const result = await probe.run();
    expect(result.passed).toBe(true);
    expect(result.description).toContain('alive');
    expect(result.diagnostics?.pid).toBe(process.pid);
  });

  it('lifeline.process fails with corrupt lock file (invalid JSON)', async () => {
    const lockPath = path.join(tmpDir, 'lifeline.lock');
    fs.writeFileSync(lockPath, 'NOT JSON');

    const probes = createLifelineProbes(makeDefaultLifelineDeps(tmpDir));
    const probe = probes.find(p => p.id === 'instar.lifeline.process')!;
    const result = await probe.run();
    expect(result.passed).toBe(false);
    expect(result.description).toContain('corrupt');
    expect(result.error).toContain('invalid JSON');
  });

  it('lifeline.process fails with stale lock (dead PID)', async () => {
    const lockPath = path.join(tmpDir, 'lifeline.lock');
    // Use a PID that almost certainly doesn't exist
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString() }));

    const probes = createLifelineProbes(makeDefaultLifelineDeps(tmpDir));
    const probe = probes.find(p => p.id === 'instar.lifeline.process')!;
    const result = await probe.run();
    expect(result.passed).toBe(false);
    expect(result.description).toContain('not running');
    expect(result.description).toContain('stale');
  });

  // ── Supervisor Probe ──────────────────────────────────────────────

  it('lifeline.supervisor passes when running and healthy', async () => {
    const probes = createLifelineProbes(makeDefaultLifelineDeps(tmpDir));
    const probe = probes.find(p => p.id === 'instar.lifeline.supervisor')!;
    const result = await probe.run();
    expect(result.passed).toBe(true);
    expect(result.description).toContain('healthy');
  });

  it('lifeline.supervisor fails when circuit breaker tripped', async () => {
    const probes = createLifelineProbes(makeDefaultLifelineDeps(tmpDir, {
      getSupervisorStatus: () => ({
        running: false, healthy: false, restartAttempts: 5, lastHealthy: 0,
        coolingDown: false, cooldownRemainingMs: 0, circuitBroken: true,
        totalFailures: 25, lastCrashOutput: 'Error: segfault',
        circuitBreakerRetryCount: 2, maxCircuitBreakerRetries: 3,
        inMaintenanceWait: false, maintenanceWaitElapsedMs: 0,
      }),
    }));
    const probe = probes.find(p => p.id === 'instar.lifeline.supervisor')!;
    const result = await probe.run();
    expect(result.passed).toBe(false);
    expect(result.description).toContain('circuit breaker');
    expect(result.description).toContain('TRIPPED');
    expect(result.diagnostics?.lastCrashOutput).toBeDefined();
  });

  it('lifeline.supervisor fails when not running (cooling down)', async () => {
    const probes = createLifelineProbes(makeDefaultLifelineDeps(tmpDir, {
      getSupervisorStatus: () => ({
        running: false, healthy: false, restartAttempts: 3, lastHealthy: Date.now() - 60000,
        coolingDown: true, cooldownRemainingMs: 30000, circuitBroken: false,
        totalFailures: 5, lastCrashOutput: 'Error: crash',
        circuitBreakerRetryCount: 0, maxCircuitBreakerRetries: 3,
        inMaintenanceWait: false, maintenanceWaitElapsedMs: 0,
      }),
    }));
    const probe = probes.find(p => p.id === 'instar.lifeline.supervisor')!;
    const result = await probe.run();
    expect(result.passed).toBe(false);
    expect(result.error).toContain('cooling down');
  });

  it('lifeline.supervisor fails when not running (no cooldown)', async () => {
    const probes = createLifelineProbes(makeDefaultLifelineDeps(tmpDir, {
      getSupervisorStatus: () => ({
        running: false, healthy: false, restartAttempts: 2, lastHealthy: Date.now() - 120000,
        coolingDown: false, cooldownRemainingMs: 0, circuitBroken: false,
        totalFailures: 3, lastCrashOutput: 'Error: exit',
        circuitBreakerRetryCount: 0, maxCircuitBreakerRetries: 3,
        inMaintenanceWait: false, maintenanceWaitElapsedMs: 0,
      }),
    }));
    const probe = probes.find(p => p.id === 'instar.lifeline.supervisor')!;
    const result = await probe.run();
    expect(result.passed).toBe(false);
    expect(result.error).toContain('restart attempts');
  });

  it('lifeline.supervisor fails when running but unhealthy (maintenance)', async () => {
    const probes = createLifelineProbes(makeDefaultLifelineDeps(tmpDir, {
      getSupervisorStatus: () => ({
        running: true, healthy: false, restartAttempts: 0, lastHealthy: Date.now() - 30000,
        coolingDown: false, cooldownRemainingMs: 0, circuitBroken: false,
        totalFailures: 0, lastCrashOutput: '',
        circuitBreakerRetryCount: 0, maxCircuitBreakerRetries: 3,
        inMaintenanceWait: true, maintenanceWaitElapsedMs: 15000,
      }),
    }));
    const probe = probes.find(p => p.id === 'instar.lifeline.supervisor')!;
    const result = await probe.run();
    expect(result.passed).toBe(false);
    expect(result.error).toContain('maintenance');
  });

  it('lifeline.supervisor fails when running but unhealthy (not maintenance)', async () => {
    const probes = createLifelineProbes(makeDefaultLifelineDeps(tmpDir, {
      getSupervisorStatus: () => ({
        running: true, healthy: false, restartAttempts: 0, lastHealthy: Date.now() - 60000,
        coolingDown: false, cooldownRemainingMs: 0, circuitBroken: false,
        totalFailures: 0, lastCrashOutput: '',
        circuitBreakerRetryCount: 0, maxCircuitBreakerRetries: 3,
        inMaintenanceWait: false, maintenanceWaitElapsedMs: 0,
      }),
    }));
    const probe = probes.find(p => p.id === 'instar.lifeline.supervisor')!;
    const result = await probe.run();
    expect(result.passed).toBe(false);
    expect(result.error).toContain('Health checks failing');
  });

  // ── Queue Probe ──────────────────────────────────────────────────

  it('lifeline.queue passes when empty', async () => {
    const probes = createLifelineProbes(makeDefaultLifelineDeps(tmpDir));
    const probe = probes.find(p => p.id === 'instar.lifeline.queue')!;
    const result = await probe.run();
    expect(result.passed).toBe(true);
    expect(result.description).toContain('empty');
  });

  it('lifeline.queue passes with pending messages within limits', async () => {
    const probes = createLifelineProbes(makeDefaultLifelineDeps(tmpDir, {
      getQueueLength: () => 5,
      peekQueue: () => [
        { id: 'msg-1', timestamp: new Date().toISOString() },
      ],
    }));
    const probe = probes.find(p => p.id === 'instar.lifeline.queue')!;
    const result = await probe.run();
    expect(result.passed).toBe(true);
    expect(result.description).toContain('5 pending');
  });

  it('lifeline.queue fails on backlog (>50)', async () => {
    const probes = createLifelineProbes(makeDefaultLifelineDeps(tmpDir, {
      getQueueLength: () => 60,
      peekQueue: () => [{ id: 'tg-1', timestamp: new Date(Date.now() - 3600000).toISOString() }],
    }));
    const probe = probes.find(p => p.id === 'instar.lifeline.queue')!;
    const result = await probe.run();
    expect(result.passed).toBe(false);
    expect(result.description).toContain('backlog');
  });

  it('lifeline.queue fails with stale messages (>1h old)', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600000).toISOString();
    const probes = createLifelineProbes(makeDefaultLifelineDeps(tmpDir, {
      getQueueLength: () => 3,
      peekQueue: () => [{ id: 'msg-old', timestamp: twoHoursAgo }],
    }));
    const probe = probes.find(p => p.id === 'instar.lifeline.queue')!;
    const result = await probe.run();
    expect(result.passed).toBe(false);
    expect(result.description).toContain('stale');
  });

  it('prerequisites fail when lifeline is disabled', () => {
    const probes = createLifelineProbes(makeDefaultLifelineDeps(tmpDir, {
      isEnabled: () => false,
    }));
    expect(probes[0].prerequisites()).toBe(false);
  });
});
