import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { createTempProject, createMockSessionManager, createSampleJobsFile } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { JobSchedulerConfig } from '../../src/core/types.js';

describe('JobScheduler.reapStuckRuns', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let scheduler: JobScheduler;
  let jobsFile: string;
  let runsFile: string;

  beforeEach(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();
    jobsFile = createSampleJobsFile(project.stateDir);
    runsFile = path.join(project.stateDir, 'ledger', 'job-runs.jsonl');
    fs.mkdirSync(path.dirname(runsFile), { recursive: true });
  });

  afterEach(() => {
    scheduler?.stop();
    project.cleanup();
  });

  function makeConfig(overrides?: Partial<JobSchedulerConfig>): JobSchedulerConfig {
    return {
      jobsFile,
      enabled: true,
      maxParallelJobs: 2,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      ...overrides,
    };
  }

  function createScheduler(configOverrides?: Partial<JobSchedulerConfig>): JobScheduler {
    scheduler = new JobScheduler(
      makeConfig(configOverrides),
      mockSM as any,
      project.state,
      project.stateDir,
    );
    scheduler.start();
    return scheduler;
  }

  // Inject a synthetic pending run into both the active-run map and the on-disk
  // ledger. Mirrors what `spawnJobSession` does end-to-end without actually
  // spawning a tmux session.
  function seedPendingRun(opts: {
    slug: string;
    runId: string;
    sessionName: string;
    startedAt: string;
  }): void {
    fs.appendFileSync(runsFile, JSON.stringify({
      runId: opts.runId,
      slug: opts.slug,
      sessionId: opts.sessionName,
      trigger: 'scheduled',
      startedAt: opts.startedAt,
      result: 'pending',
      model: 'haiku',
    }) + '\n');
    // Wire up the active-run map without going through spawnJobSession
    (scheduler as any).activeRunIds.set(opts.sessionName, opts.runId);
  }

  function readLedgerLines(): any[] {
    return fs.readFileSync(runsFile, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l));
  }

  it('does nothing when sleep is shorter than the minimum threshold', () => {
    createScheduler();
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
    seedPendingRun({
      slug: 'health-check',
      runId: 'health-check-test-1',
      sessionName: 'job-health-check-1',
      startedAt: fourHoursAgo,
    });

    const result = scheduler.reapStuckRuns({ sleepDurationSeconds: 30 });

    expect(result.reaped).toEqual([]);
    expect(result.skipped).toBe(0);
    expect((scheduler as any).activeRunIds.size).toBe(1);
  });

  it('skips a pending run whose elapsed time is under the 2× threshold', () => {
    createScheduler();
    // health-check has expectedDurationMinutes: 2 — threshold is 4 minutes.
    // Started 1 minute ago → still well within budget.
    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    seedPendingRun({
      slug: 'health-check',
      runId: 'health-check-test-2',
      sessionName: 'job-health-check-2',
      startedAt: oneMinuteAgo,
    });

    const result = scheduler.reapStuckRuns({ sleepDurationSeconds: 600 });

    expect(result.reaped).toEqual([]);
    expect(result.skipped).toBe(1);
    expect((scheduler as any).activeRunIds.size).toBe(1);
    // Ledger should still show only the original pending entry.
    const lines = readLedgerLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].result).toBe('pending');
  });

  it('reaps a pending run whose elapsed time exceeds the 2× threshold', () => {
    createScheduler();
    // health-check has expectedDurationMinutes: 2 — threshold is 4 minutes.
    // Started 4 hours ago — well past it.
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
    seedPendingRun({
      slug: 'health-check',
      runId: 'health-check-test-3',
      sessionName: 'job-health-check-3',
      startedAt: fourHoursAgo,
    });

    const result = scheduler.reapStuckRuns({ sleepDurationSeconds: 14400 });

    expect(result.reaped).toEqual(['health-check']);
    expect(result.skipped).toBe(0);
    expect((scheduler as any).activeRunIds.size).toBe(0);

    const lines = readLedgerLines();
    expect(lines).toHaveLength(2);
    const completion = lines[1];
    expect(completion.result).toBe('timeout');
    expect(completion.runId).toBe('health-check-test-3');
    expect(completion.error).toContain('Reaped on wake');
    expect(completion.error).toContain('14400s');
  });

  it('is idempotent — a second invocation finds nothing to reap', () => {
    createScheduler();
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
    seedPendingRun({
      slug: 'health-check',
      runId: 'health-check-test-4',
      sessionName: 'job-health-check-4',
      startedAt: fourHoursAgo,
    });

    const first = scheduler.reapStuckRuns({ sleepDurationSeconds: 14400 });
    expect(first.reaped).toEqual(['health-check']);

    const linesAfterFirst = readLedgerLines();
    const second = scheduler.reapStuckRuns({ sleepDurationSeconds: 14400 });

    expect(second.reaped).toEqual([]);
    expect(second.skipped).toBe(0);
    // No additional ledger entries.
    expect(readLedgerLines()).toHaveLength(linesAfterFirst.length);
  });

  it('handles multiple stuck runs in one pass', () => {
    createScheduler();
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
    seedPendingRun({
      slug: 'health-check',
      runId: 'health-check-test-5',
      sessionName: 'job-health-check-5',
      startedAt: fourHoursAgo,
    });
    seedPendingRun({
      slug: 'email-check',
      runId: 'email-check-test-5',
      sessionName: 'job-email-check-5',
      startedAt: fourHoursAgo,
    });

    const result = scheduler.reapStuckRuns({ sleepDurationSeconds: 14400 });

    expect(result.reaped.sort()).toEqual(['email-check', 'health-check']);
    expect(result.skipped).toBe(0);
    expect((scheduler as any).activeRunIds.size).toBe(0);
  });

  it('honors a custom thresholdMultiplier', () => {
    createScheduler({ wakeReaper: { thresholdMultiplier: 100 } });
    // 4 hours past start, but with multiplier 100 the threshold is 200 minutes
    // → 4h elapsed (240min) > 200min, so still reapable.
    // Use a tighter window to confirm the multiplier actually changes behavior:
    // health-check exp=2min, multiplier 100 → threshold 200min. 1h elapsed = 60min, under threshold.
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    seedPendingRun({
      slug: 'health-check',
      runId: 'health-check-test-6',
      sessionName: 'job-health-check-6',
      startedAt: oneHourAgo,
    });

    const result = scheduler.reapStuckRuns({ sleepDurationSeconds: 7200 });

    expect(result.reaped).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it('honors a custom minSleepSeconds', () => {
    createScheduler({ wakeReaper: { minSleepSeconds: 1 } });
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
    seedPendingRun({
      slug: 'health-check',
      runId: 'health-check-test-7',
      sessionName: 'job-health-check-7',
      startedAt: fourHoursAgo,
    });

    // 5s sleep — under default 60s, but allowed by override.
    const result = scheduler.reapStuckRuns({ sleepDurationSeconds: 5 });

    expect(result.reaped).toEqual(['health-check']);
  });
});
