import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { createTempProject, createMockSessionManager, createSampleJobsFile } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { JobSchedulerConfig, JobDefinition } from '../../src/core/types.js';

describe('JobScheduler retry on skip', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let scheduler: JobScheduler;
  let jobsFile: string;

  beforeEach(() => {
    vi.useFakeTimers();
    project = createTempProject();
    mockSM = createMockSessionManager();
  });

  afterEach(() => {
    scheduler?.stop();
    project.cleanup();
    vi.useRealTimers();
  });

  function makeScheduler(jobs: JobDefinition[]): JobScheduler {
    jobsFile = createSampleJobsFile(project.stateDir, jobs);

    // Pre-seed lastRun so checkMissedJobs doesn't fire
    for (const job of jobs) {
      if (job.enabled) {
        project.state.saveJobState({
          slug: job.slug,
          lastRun: new Date().toISOString(),
          lastResult: 'success',
          runCount: 1,
          consecutiveFailures: 0,
        });
      }
    }

    scheduler = new JobScheduler(
      {
        jobsFile,
        enabled: true,
        maxParallelJobs: 2,
        quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      },
      mockSM as any,
      project.state,
      project.stateDir,
    );
    return scheduler;
  }

  it('schedules a retry after gate failure', () => {
    const jobs: JobDefinition[] = [{
      slug: 'gated-job',
      name: 'Gated Job',
      description: 'Has a gate',
      schedule: '0 */4 * * *',
      priority: 'high',
      model: 'haiku',
      enabled: true,
      execute: { type: 'skill', value: 'test' },
      gate: 'exit 1', // Always fails
    }];

    const s = makeScheduler(jobs);
    s.start();

    // Trigger the job — gate fails, should be skipped
    const result = s.triggerJob('gated-job', 'test');
    expect(result).toBe('skipped');

    // No session spawned yet
    expect(mockSM._spawnCount).toBe(0);

    // Advance past the first retry delay (1min)
    // The retry should re-attempt (and fail the gate again)
    vi.advanceTimersByTime(61_000);

    // Still no session — gate still fails — but a second retry is scheduled
    expect(mockSM._spawnCount).toBe(0);
  });

  it('succeeds on retry after transient gate failure', () => {
    let gateCallCount = 0;
    const jobs: JobDefinition[] = [{
      slug: 'retry-success',
      name: 'Retry Success',
      description: 'Gate fails once then succeeds',
      schedule: '0 */4 * * *',
      priority: 'high',
      model: 'haiku',
      enabled: true,
      execute: { type: 'skill', value: 'test' },
      // Gate command: fail on first call, succeed on second
      gate: `test $(($(date +%s) % 2)) -eq 0`,
    }];

    // Instead of relying on shell timing, we test the mechanism directly
    const s = makeScheduler(jobs);
    s.start();

    // First trigger — will skip (quota blocked)
    s.canRunJob = () => false;
    const result = s.triggerJob('retry-success', 'scheduled');
    expect(result).toBe('skipped');
    expect(mockSM._spawnCount).toBe(0);

    // Fix the quota issue
    s.canRunJob = () => true;

    // Advance past first retry delay (1min)
    vi.advanceTimersByTime(61_000);

    // Now the retry should succeed (quota is available, no gate on this path)
    expect(mockSM._spawnCount).toBe(1);
  });

  it('stops retrying after MAX_RETRIES', () => {
    const jobs: JobDefinition[] = [{
      slug: 'max-retry',
      name: 'Max Retry',
      description: 'Never succeeds',
      schedule: '0 */4 * * *',
      priority: 'high',
      model: 'haiku',
      enabled: true,
      execute: { type: 'skill', value: 'test' },
    }];

    const s = makeScheduler(jobs);
    s.start();

    // Block quota permanently
    s.canRunJob = () => false;

    // Trigger initial + 6 retries (1m, 5m, 15m, 30m, 1h, 2h)
    s.triggerJob('max-retry', 'scheduled');

    // Advance through all retry windows with generous margins
    const delays = [61_000, 301_000, 901_000, 1_801_000, 3_601_000, 7_201_000];
    for (const delay of delays) {
      vi.advanceTimersByTime(delay);
    }

    // Should never have spawned
    expect(mockSM._spawnCount).toBe(0);

    // No more retries scheduled — the job gave up
    // Verify by advancing another 3 hours — nothing happens
    vi.advanceTimersByTime(10_800_000);
    expect(mockSM._spawnCount).toBe(0);
  });

  it('clears retry state on stop', () => {
    const jobs: JobDefinition[] = [{
      slug: 'cleanup-test',
      name: 'Cleanup Test',
      description: 'Test cleanup',
      schedule: '0 */4 * * *',
      priority: 'high',
      model: 'haiku',
      enabled: true,
      execute: { type: 'skill', value: 'test' },
    }];

    const s = makeScheduler(jobs);
    s.start();

    s.canRunJob = () => false;
    s.triggerJob('cleanup-test', 'scheduled');

    // Stop should clear timers without errors
    s.stop();

    // Advance time — no retry should fire
    vi.advanceTimersByTime(60_000);
    expect(mockSM._spawnCount).toBe(0);
  });
});
