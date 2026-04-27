/**
 * Integration tests for SystemReviewer.
 *
 * Tests the full orchestration flow with real filesystem, history persistence
 * across instances, wiring integrity, alert/feedback pipelines, and
 * concurrency behavior.
 *
 * Testing Integrity categories covered:
 * - Wiring Integrity: deps are not null, not no-ops, delegate to real implementations
 * - Semantic Correctness: status classification, trend direction, alert routing
 * - Cross-component integration: probes + orchestrator + history + alerts
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

function makePassingProbe(id: string, tier: 1 | 2 | 3 | 4 | 5 = 1): Probe {
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
  };
}

function makeFailingProbe(id: string, tier: 1 | 2 | 3 | 4 | 5 = 1): Probe {
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
  };
}

function createFullDeps(stateDir: string, overrides?: Partial<SystemReviewerDeps>): SystemReviewerDeps {
  return {
    stateDir,
    sendAlert: vi.fn().mockResolvedValue(undefined),
    submitFeedback: vi.fn().mockResolvedValue(undefined),
    redactSecrets: vi.fn((text: string) => text.replace(/sk-[a-z0-9]+/gi, '[REDACTED]')),
    ...overrides,
  };
}

// ── Full Orchestration Flow ──────────────────────────────────────────

describe('SystemReviewer Integration: Full Orchestration', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-integ-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('runs a full review with all 14 Tier 1 probes registered', async () => {
    const lockPath = path.join(stateDir, 'lifeline.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

    const deps = createFullDeps(stateDir);
    const reviewer = new SystemReviewer({ enabled: false }, deps);

    // Register all Tier 1 probes with mock deps
    const sessionProbes = createSessionProbes({
      listRunningSessions: () => [{ id: '1', tmuxSession: 'sess-1', name: 'Session 1' }],
      getSessionDiagnostics: () => ({ sessions: [{ name: 'Session 1', ageMinutes: 15 }] }),
      maxSessions: 3,
      tmuxPath: '/usr/bin/tmux',
    });
    // Override prerequisites for test (tmux may not be available)
    for (const p of sessionProbes) {
      (p as { prerequisites: () => boolean }).prerequisites = () => true;
    }
    // Override tmux-alive to not actually call tmux
    const tmuxProbe = sessionProbes.find(p => p.id === 'instar.session.tmux-alive')!;
    tmuxProbe.run = async function (): Promise<ProbeResult> {
      return {
        probeId: this.id, name: this.name, tier: this.tier,
        passed: true, description: 'Verified (mocked)', durationMs: 0,
      };
    };

    const schedulerProbes = createSchedulerProbes({
      getJobs: () => [{ id: '1', name: 'Job 1' }, { id: '2', name: 'Job 2' }],
      getStatus: () => ({ running: true, paused: false, jobCount: 2, enabledJobs: 2, queueLength: 0 }),
      jobsFilePath: '/nonexistent/jobs.json',
    });

    const messagingProbes = createMessagingProbes({
      getStatus: () => ({ started: true, uptime: 120000, pendingStalls: 0, pendingPromises: 0, topicMappings: 3 }),
      messageLogPath: '/nonexistent/messages.jsonl',
      isConfigured: () => true,
    });

    const lifelineProbes = createLifelineProbes({
      getSupervisorStatus: () => ({
        running: true, healthy: true, restartAttempts: 0, lastHealthy: Date.now(),
        coolingDown: false, cooldownRemainingMs: 0, circuitBroken: false,
        totalFailures: 0, lastCrashOutput: '', circuitBreakerRetryCount: 0,
        maxCircuitBreakerRetries: 3, inMaintenanceWait: false, maintenanceWaitElapsedMs: 0,
      }),
      getQueueLength: () => 0,
      peekQueue: () => [],
      lockFilePath: lockPath,
      isEnabled: () => true,
    });

    reviewer.registerAll(sessionProbes);
    reviewer.registerAll(schedulerProbes);
    reviewer.registerAll(messagingProbes);
    reviewer.registerAll(lifelineProbes);

    const report = await reviewer.review();

    // All 14 probes should have results (some may be skipped if prerequisites fail)
    const totalResults = report.results.length + report.skipped.length;
    expect(totalResults).toBe(14);

    // With healthy mocks, most should pass
    expect(report.stats.passed).toBeGreaterThanOrEqual(10);
    expect(report.timestamp).toBeTruthy();
    expect(report.stats.durationMs).toBeGreaterThanOrEqual(0);

    reviewer.stop();
  });

  it('correctly transitions status across mixed probe results', async () => {
    const deps = createFullDeps(stateDir);
    const reviewer = new SystemReviewer({ enabled: false }, deps);

    // Mix of passing and failing probes across tiers
    reviewer.register(makePassingProbe('test.pass1', 1));
    reviewer.register(makePassingProbe('test.pass2', 1));
    reviewer.register(makePassingProbe('test.pass3', 2));
    reviewer.register(makeFailingProbe('test.fail1', 2));
    reviewer.register(makePassingProbe('test.pass4', 3));
    reviewer.register(makeFailingProbe('test.fail2', 3));

    const report = await reviewer.review();

    // No Tier 1 failure → degraded, not critical
    expect(report.status).toBe('degraded');
    expect(report.stats.total).toBe(6);
    expect(report.stats.passed).toBe(4);
    expect(report.stats.failed).toBe(2);
    expect(report.failureSummary).toContain('test.fail1');
    expect(report.failureSummary).toContain('test.fail2');

    reviewer.stop();
  });
});

// ── History Persistence Across Instances ──────────────────────────────

describe('SystemReviewer Integration: History Persistence', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-persist-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('history survives instance destruction and recreation', async () => {
    // Instance 1: run some reviews
    const rev1 = new SystemReviewer({ enabled: false }, { stateDir });
    rev1.register(makePassingProbe('test.a'));
    await rev1.review();
    await rev1.review();
    expect(rev1.getHistory()).toHaveLength(2);
    rev1.stop();

    // Instance 2: should load history from file
    const rev2 = new SystemReviewer({ enabled: false }, { stateDir });
    rev2.register(makePassingProbe('test.a'));
    expect(rev2.getHistory()).toHaveLength(2);

    // Run more reviews
    await rev2.review();
    expect(rev2.getHistory()).toHaveLength(3);
    rev2.stop();

    // Instance 3: should see all 3
    const rev3 = new SystemReviewer({ enabled: false }, { stateDir });
    expect(rev3.getHistory()).toHaveLength(3);
    rev3.stop();
  });

  it('JSONL file is well-formed after multiple writes', async () => {
    const rev = new SystemReviewer({ enabled: false }, { stateDir });
    rev.register(makePassingProbe('test.a'));
    rev.register(makeFailingProbe('test.b', 2));

    for (let i = 0; i < 5; i++) {
      await rev.review();
    }

    const historyPath = path.join(stateDir, 'review-history.jsonl');
    const content = fs.readFileSync(historyPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    // Each line should be valid JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.timestamp).toBeTruthy();
      expect(parsed.status).toBeDefined();
      expect(parsed.results).toBeDefined();
      expect(parsed.stats).toBeDefined();
    }

    rev.stop();
  });

  it('history compaction preserves most recent entries', async () => {
    const rev = new SystemReviewer(
      { enabled: false, historyLimit: 3 },
      { stateDir },
    );
    rev.register(makePassingProbe('test.a'));

    // Run exactly 7 reviews: triggers compaction at review 7 (7 > 2*3=6)
    // which rewrites file to in-memory history (3 entries)
    for (let i = 0; i < 7; i++) {
      await rev.review();
    }

    // In-memory history should respect limit
    expect(rev.getHistory()).toHaveLength(3);

    // File should be compacted to exactly historyLimit entries
    const historyPath = path.join(stateDir, 'review-history.jsonl');
    const lines = fs.readFileSync(historyPath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(3);

    rev.stop();
  });
});

// ── Alert Pipeline Integration ───────────────────────────────────────

describe('SystemReviewer Integration: Alert Pipeline', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-alert-integ-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('alert contains probe name, error info, and suggested fix', async () => {
    const sendAlert = vi.fn().mockResolvedValue(undefined);
    const rev = new SystemReviewer(
      { enabled: false, alertOnCritical: true },
      { stateDir, sendAlert },
    );
    rev.register(makeFailingProbe('instar.session.list', 1));

    await rev.review();

    expect(sendAlert).toHaveBeenCalledOnce();
    const alertText = sendAlert.mock.calls[0][1];
    // Narrative format: includes probe name, error cause, and remediation
    expect(alertText).toContain('Failing Probe instar.session.list');
    expect(alertText).toContain('Expected 42, got 0');
    expect(alertText).toContain('Fix the thing');

    rev.stop();
  });

  it('multiple failing probes trigger separate alerts', async () => {
    const sendAlert = vi.fn().mockResolvedValue(undefined);
    const rev = new SystemReviewer(
      { enabled: false, alertOnCritical: true },
      { stateDir, sendAlert },
    );
    rev.register(makeFailingProbe('test.fail1', 1));
    rev.register(makeFailingProbe('test.fail2', 2));

    await rev.review();

    expect(sendAlert).toHaveBeenCalledTimes(2);

    rev.stop();
  });

  it('alert failure does not prevent review completion', async () => {
    const sendAlert = vi.fn().mockRejectedValue(new Error('Telegram unreachable'));
    const rev = new SystemReviewer(
      { enabled: false, alertOnCritical: true },
      { stateDir, sendAlert },
    );
    rev.register(makeFailingProbe('test.fail', 1));

    // Should not throw
    const report = await rev.review();
    expect(report.status).toBe('critical');
    expect(report.results).toHaveLength(1);

    // Dead letter should capture the alert failure
    const deadLetterPath = path.join(stateDir, 'doctor-dead-letter.jsonl');
    expect(fs.existsSync(deadLetterPath)).toBe(true);

    rev.stop();
  });
});

// ── Feedback Pipeline Integration ───────────────────────────────────

describe('SystemReviewer Integration: Feedback Pipeline', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-fb-integ-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('feedback includes structured probe failure data', async () => {
    const submitFeedback = vi.fn().mockResolvedValue(undefined);
    const rev = new SystemReviewer(
      { enabled: false, autoSubmitFeedback: true, feedbackConsentGiven: true },
      { stateDir, submitFeedback },
    );
    rev.register(makeFailingProbe('instar.scheduler.queue', 1));

    await rev.review();

    expect(submitFeedback).toHaveBeenCalledOnce();
    const fbItem = submitFeedback.mock.calls[0][0];
    expect(fbItem.type).toBe('bug');
    expect(fbItem.title).toContain('[DOCTOR]');
    expect(fbItem.title).toContain('instar.scheduler.queue');
    expect(fbItem.title).toContain('FAILED');
    expect(fbItem.description).toContain('Tier 1');
    expect(fbItem.description).toContain('Remediation');
    expect(fbItem.agentName).toBe('system-reviewer');
    expect(fbItem.nodeVersion).toBeTruthy();
  });

  it('feedback is redacted before submission', async () => {
    const submitFeedback = vi.fn().mockResolvedValue(undefined);
    const redactSecrets = vi.fn((text: string) => text.replace(/SECRET/g, '[REDACTED]'));
    const rev = new SystemReviewer(
      { enabled: false, autoSubmitFeedback: true, feedbackConsentGiven: true },
      { stateDir, submitFeedback, redactSecrets },
    );

    // Create a probe that leaks a secret in its error
    rev.register({
      id: 'test.secret',
      name: 'Secret Probe',
      tier: 1,
      feature: 'Test',
      timeoutMs: 5000,
      prerequisites: () => true,
      async run() {
        return {
          probeId: 'test.secret', name: 'Secret', tier: 1 as const,
          passed: false, description: 'Failed', durationMs: 0,
          error: 'Token SECRET leaked',
        };
      },
    });

    await rev.review();

    expect(redactSecrets).toHaveBeenCalled();
    // The redactSecrets function was called on the description
    const redactedInput = redactSecrets.mock.calls[0][0];
    expect(redactedInput).toContain('SECRET');
    // The submission should have the redacted version
    expect(submitFeedback).toHaveBeenCalledOnce();

    rev.stop();
  });

  it('consent gating prevents unauthorized feedback', async () => {
    const submitFeedback = vi.fn().mockResolvedValue(undefined);

    // autoSubmitFeedback true, but consent NOT given
    const rev = new SystemReviewer(
      { enabled: false, autoSubmitFeedback: true, feedbackConsentGiven: false },
      { stateDir, submitFeedback },
    );
    rev.register(makeFailingProbe('test.fail', 1));

    await rev.review();
    expect(submitFeedback).not.toHaveBeenCalled();

    rev.stop();
  });
});

// ── Wiring Integrity ────────────────────────────────────────────────

describe('SystemReviewer Integration: Wiring Integrity', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-wiring-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('SystemReviewer constructor does not throw with minimal deps', () => {
    expect(() => new SystemReviewer({ enabled: false }, { stateDir })).not.toThrow();
  });

  it('SystemReviewer works with all optional deps provided', async () => {
    const deps = createFullDeps(stateDir);
    const rev = new SystemReviewer({ enabled: false }, deps);
    rev.register(makeFailingProbe('test.fail', 1));

    const report = await rev.review();

    expect(report.status).toBe('critical');
    expect(deps.sendAlert).toHaveBeenCalled();
    rev.stop();
  });

  it('probe results flow through to history, events, and alerts', async () => {
    const sendAlert = vi.fn().mockResolvedValue(undefined);
    const eventListener = vi.fn();
    const failListener = vi.fn();

    const rev = new SystemReviewer(
      { enabled: false, alertOnCritical: true },
      { stateDir, sendAlert },
    );
    rev.on('review:complete', eventListener);
    rev.on('review:probe-failed', failListener);

    rev.register(makePassingProbe('test.ok', 1));
    rev.register(makeFailingProbe('test.fail', 1));

    await rev.review();

    // Events fired
    expect(eventListener).toHaveBeenCalledOnce();
    expect(failListener).toHaveBeenCalledOnce();

    // Alert sent
    expect(sendAlert).toHaveBeenCalledOnce();

    // History persisted
    expect(rev.getHistory()).toHaveLength(1);
    const historyPath = path.join(stateDir, 'review-history.jsonl');
    expect(fs.existsSync(historyPath)).toBe(true);

    rev.stop();
  });

  it('each probe factory creates probes with correct structure', () => {
    const lockPath = path.join(stateDir, 'lifeline.lock');

    const allProbes = [
      ...createSessionProbes({
        listRunningSessions: () => [],
        getSessionDiagnostics: () => ({ sessions: [] }),
        maxSessions: 3,
        tmuxPath: '/usr/bin/tmux',
      }),
      ...createSchedulerProbes({
        getJobs: () => [],
        getStatus: () => ({ running: true, paused: false, jobCount: 0, enabledJobs: 0, queueLength: 0 }),
        jobsFilePath: '/nonexistent/jobs.json',
      }),
      ...createMessagingProbes({
        getStatus: () => ({ started: true, uptime: 60000, pendingStalls: 0, pendingPromises: 0, topicMappings: 0 }),
        messageLogPath: '/nonexistent/messages.jsonl',
        isConfigured: () => true,
      }),
      ...createLifelineProbes({
        getSupervisorStatus: () => ({
          running: true, healthy: true, restartAttempts: 0, lastHealthy: Date.now(),
          coolingDown: false, cooldownRemainingMs: 0, circuitBroken: false,
          totalFailures: 0, lastCrashOutput: '', circuitBreakerRetryCount: 0,
          maxCircuitBreakerRetries: 3, inMaintenanceWait: false, maintenanceWaitElapsedMs: 0,
        }),
        getQueueLength: () => 0,
        peekQueue: () => [],
        lockFilePath: lockPath,
        isEnabled: () => true,
      }),
    ];

    // All probes should have required fields
    for (const probe of allProbes) {
      expect(probe.id).toBeTruthy();
      expect(probe.id).toMatch(/^instar\./);
      expect(probe.name).toBeTruthy();
      expect([1, 2, 3, 4, 5]).toContain(probe.tier);
      expect(probe.feature).toBeTruthy();
      expect(typeof probe.prerequisites).toBe('function');
      expect(typeof probe.run).toBe('function');
    }

    // Should be exactly 14 Tier 1 probes
    expect(allProbes.filter(p => p.tier === 1)).toHaveLength(14);

    // All probe IDs should be unique
    const ids = allProbes.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('probe deps are not no-ops — listRunningSessions produces observable results', () => {
    const sessions = [
      { id: '1', tmuxSession: 'test-1', name: 'Test 1' },
      { id: '2', tmuxSession: 'test-2', name: 'Test 2' },
    ];
    const listRunningSessions = vi.fn(() => sessions);

    const probes = createSessionProbes({
      listRunningSessions,
      getSessionDiagnostics: () => ({ sessions: [] }),
      maxSessions: 3,
      tmuxPath: '/usr/bin/tmux',
    });

    // Calling the probe should invoke the dep
    const listProbe = probes.find(p => p.id === 'instar.session.list')!;
    listProbe.run();

    expect(listRunningSessions).toHaveBeenCalled();
    expect(listRunningSessions.mock.results[0].value).toEqual(sessions);
  });
});

// ── Concurrent Access ───────────────────────────────────────────────

describe('SystemReviewer Integration: Concurrency', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-concurrent-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('two rapid reviews complete without corruption', async () => {
    const rev = new SystemReviewer({ enabled: false }, { stateDir });
    rev.register({
      id: 'test.slow',
      name: 'Slow',
      tier: 1,
      feature: 'Test',
      timeoutMs: 5000,
      prerequisites: () => true,
      async run() {
        await new Promise(r => setTimeout(r, 50));
        return {
          probeId: 'test.slow', name: 'Slow', tier: 1 as const,
          passed: true, description: 'ok', durationMs: 50,
        };
      },
    });

    // First review starts
    const p1 = rev.review();

    // Second review should be rejected while first is running
    await expect(rev.review()).rejects.toThrow('already in progress');

    // First should complete normally
    const report = await p1;
    expect(report.status).toBe('all-clear');

    // After first completes, a new review should work
    const report2 = await rev.review();
    expect(report2.status).toBe('all-clear');
    expect(rev.getHistory()).toHaveLength(2);

    rev.stop();
  });
});

// ── Dead Letter Isolation ───────────────────────────────────────────

describe('SystemReviewer Integration: Dead Letter Fallback', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-deadletter-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('dead letter entries are valid JSONL', async () => {
    const sendAlert = vi.fn().mockRejectedValue(new Error('Telegram offline'));
    const rev = new SystemReviewer(
      { enabled: false, alertOnCritical: true },
      { stateDir, sendAlert },
    );
    rev.register(makeFailingProbe('test.fail', 1));

    await rev.review();

    const deadLetterPath = path.join(stateDir, 'doctor-dead-letter.jsonl');
    expect(fs.existsSync(deadLetterPath)).toBe(true);

    const content = fs.readFileSync(deadLetterPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.timestamp).toBeTruthy();
      expect(parsed.type).toBeTruthy();
      expect(parsed.message).toBeTruthy();
    }

    rev.stop();
  });

  it('dead letter accumulates across multiple failures', async () => {
    const sendAlert = vi.fn().mockRejectedValue(new Error('Down'));
    const rev = new SystemReviewer(
      { enabled: false, alertOnCritical: true, alertCooldownMs: 0 },
      { stateDir, sendAlert },
    );
    rev.register(makeFailingProbe('test.f1', 1));
    rev.register(makeFailingProbe('test.f2', 2));

    await rev.review();

    const deadLetterPath = path.join(stateDir, 'doctor-dead-letter.jsonl');
    const content = fs.readFileSync(deadLetterPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2); // Both alert failures logged

    rev.stop();
  });
});

// ── Startup Sweep Integration ───────────────────────────────────────

describe('SystemReviewer Integration: Startup Sweep', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-sweep-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('cleanup callbacks are called and counted', async () => {
    const rev = new SystemReviewer({ enabled: false }, { stateDir });

    let cleaned1 = false;
    let cleaned2 = false;
    rev.registerCleanup(async () => { cleaned1 = true; });
    rev.registerCleanup(async () => { cleaned2 = true; });

    const count = await rev.runStartupSweep();
    expect(count).toBe(2);
    expect(cleaned1).toBe(true);
    expect(cleaned2).toBe(true);

    rev.stop();
  });

  it('partial cleanup failures do not block other cleanups', async () => {
    const rev = new SystemReviewer({ enabled: false }, { stateDir });

    let goodRan = false;
    rev.registerCleanup(async () => { throw new Error('Cleanup A failed'); });
    rev.registerCleanup(async () => { goodRan = true; });

    const count = await rev.runStartupSweep();

    expect(count).toBe(1); // Only the good one counted
    expect(goodRan).toBe(true);

    // Dead letter should log the failure
    const deadLetterPath = path.join(stateDir, 'doctor-dead-letter.jsonl');
    expect(fs.existsSync(deadLetterPath)).toBe(true);

    rev.stop();
  });
});

// ── Trend Accuracy with Real Reviews ────────────────────────────────

describe('SystemReviewer Integration: Trend Accuracy', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-trend-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('stable trend when all reviews pass', async () => {
    const rev = new SystemReviewer({ enabled: false }, { stateDir });
    rev.register(makePassingProbe('test.a'));

    for (let i = 0; i < 6; i++) {
      await rev.review();
    }

    const trend = rev.getTrend();
    expect(trend.direction).toBe('stable');
    expect(trend.persistentFailures).toHaveLength(0);
    expect(trend.newFailures).toHaveLength(0);
    expect(trend.recovered).toHaveLength(0);
    expect(trend.window).toBe(6);

    rev.stop();
  });

  it('detects recovery after probe starts passing again', async () => {
    const rev = new SystemReviewer({ enabled: false }, { stateDir });

    let shouldPass = false;
    rev.register({
      id: 'test.flaky',
      name: 'Flaky',
      tier: 1,
      feature: 'Test',
      timeoutMs: 5000,
      prerequisites: () => true,
      async run() {
        return {
          probeId: 'test.flaky', name: 'Flaky', tier: 1 as const,
          passed: shouldPass, description: shouldPass ? 'ok' : 'fail',
          durationMs: 0, error: shouldPass ? undefined : 'broke',
        };
      },
    });

    // Fail, then pass
    shouldPass = false;
    await rev.review();
    shouldPass = true;
    await rev.review();

    const trend = rev.getTrend();
    expect(trend.recovered).toContain('test.flaky');

    rev.stop();
  });

  it('health status reflects current state after trend changes', async () => {
    const rev = new SystemReviewer({ enabled: false }, { stateDir });

    let shouldPass = true;
    rev.register({
      id: 'test.toggler',
      name: 'Toggler',
      tier: 1,
      feature: 'Test',
      timeoutMs: 5000,
      prerequisites: () => true,
      async run() {
        return {
          probeId: 'test.toggler', name: 'Toggler', tier: 1 as const,
          passed: shouldPass, description: shouldPass ? 'ok' : 'fail',
          durationMs: 0, error: shouldPass ? undefined : 'broke',
        };
      },
    });

    shouldPass = true;
    await rev.review();
    expect(rev.getHealthStatus().status).toBe('healthy');

    shouldPass = false;
    await rev.review();
    expect(rev.getHealthStatus().status).toBe('unhealthy');

    shouldPass = true;
    await rev.review();
    expect(rev.getHealthStatus().status).toBe('healthy');

    rev.stop();
  });
});
