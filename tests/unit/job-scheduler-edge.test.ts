/**
 * Additional edge case tests for the JobScheduler.
 *
 * Covers: prompt building, queue priority ordering,
 * missed job detection, failure tracking persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { JobSchedulerConfig, JobDefinition } from '../../src/core/types.js';
import fs from 'node:fs';
import path from 'node:path';

describe('JobScheduler edge cases', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let scheduler: JobScheduler;

  beforeEach(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();
  });

  afterEach(() => {
    scheduler?.stop();
    project.cleanup();
  });

  function createJobsFile(jobs: any[]): string {
    const jobsFile = path.join(project.stateDir, 'test-jobs.json');
    fs.writeFileSync(jobsFile, JSON.stringify(jobs));
    return jobsFile;
  }

  function createScheduler(jobs: any[], configOverrides?: Partial<JobSchedulerConfig>): JobScheduler {
    const jobsFile = createJobsFile(jobs);
    scheduler = new JobScheduler(
      {
        jobsFile,
        enabled: true,
        maxParallelJobs: 3,
        quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
        ...configOverrides,
      },
      mockSM as any,
      project.state,
      project.stateDir,
    );
    return scheduler;
  }

  const makeJob = (slug: string, overrides?: Partial<JobDefinition>) => ({
    slug,
    name: slug,
    description: `Test job: ${slug}`,
    schedule: '0 * * * *',
    priority: 'medium',
    expectedDurationMinutes: 5,
    model: 'sonnet',
    enabled: true,
    execute: { type: 'prompt', value: 'do something' },
    ...overrides,
  });

  describe('prompt building', () => {
    it('builds prompt for "prompt" type job', async () => {
      createScheduler([
        makeJob('test', { execute: { type: 'prompt', value: 'Check the weather' } }),
      ]);
      scheduler.start();
      scheduler.triggerJob('test', 'manual');
      await new Promise(r => setTimeout(r, 50));

      expect(mockSM._lastSpawnArgs?.prompt).toContain('Check the weather');
    });

    it('builds prompt for "skill" type job', async () => {
      createScheduler([
        makeJob('test', { execute: { type: 'skill', value: 'scan' } }),
      ]);
      scheduler.start();
      scheduler.triggerJob('test', 'manual');
      await new Promise(r => setTimeout(r, 50));

      expect(mockSM._lastSpawnArgs?.prompt).toContain('/scan');
    });

    it('builds prompt for "skill" type with args', async () => {
      createScheduler([
        makeJob('test', { execute: { type: 'skill', value: 'scan', args: '--deep' } }),
      ]);
      scheduler.start();
      scheduler.triggerJob('test', 'manual');
      await new Promise(r => setTimeout(r, 50));

      expect(mockSM._lastSpawnArgs?.prompt).toContain('/scan --deep');
    });

    it('builds prompt for "script" type job', async () => {
      createScheduler([
        makeJob('test', { execute: { type: 'script', value: './check.sh' } }),
      ]);
      scheduler.start();
      scheduler.triggerJob('test', 'manual');
      await new Promise(r => setTimeout(r, 50));

      expect(mockSM._lastSpawnArgs?.prompt).toContain('Run this script: ./check.sh');
    });

    it('passes model tier to session', async () => {
      createScheduler([
        makeJob('test', { model: 'haiku' }),
      ]);
      scheduler.start();
      scheduler.triggerJob('test', 'manual');
      await new Promise(r => setTimeout(r, 50));

      expect(mockSM._lastSpawnArgs?.model).toBe('haiku');
    });

    it('passes job slug to session', async () => {
      createScheduler([
        makeJob('my-job'),
      ]);
      scheduler.start();
      scheduler.triggerJob('my-job', 'manual');
      await new Promise(r => setTimeout(r, 50));

      expect(mockSM._lastSpawnArgs?.jobSlug).toBe('my-job');
    });
  });

  describe('queue priority ordering', () => {
    it('sorts queued jobs by priority (critical first)', () => {
      createScheduler([
        makeJob('low-job', { priority: 'low' }),
        makeJob('critical-job', { priority: 'critical' }),
        makeJob('high-job', { priority: 'high' }),
      ], { maxParallelJobs: 0 }); // Slots full immediately
      scheduler.start();

      // Queue all three (maxParallelJobs = 0 means all get queued)
      scheduler.triggerJob('low-job', 'test');
      scheduler.triggerJob('critical-job', 'test');
      scheduler.triggerJob('high-job', 'test');

      const queue = scheduler.getQueue();
      expect(queue).toHaveLength(3);
      expect(queue[0].slug).toBe('critical-job');
      expect(queue[1].slug).toBe('high-job');
      expect(queue[2].slug).toBe('low-job');
    });
  });

  describe('disabled jobs', () => {
    it('does not create cron tasks for disabled jobs', () => {
      createScheduler([
        makeJob('enabled-job', { enabled: true }),
        makeJob('disabled-job', { enabled: false }),
      ]);
      scheduler.start();

      const status = scheduler.getStatus();
      expect(status.jobCount).toBe(2);
      expect(status.enabledJobs).toBe(1);
    });
  });

  describe('quota gating', () => {
    it('emits job_skipped event when quota fails', () => {
      createScheduler([makeJob('test')]);
      scheduler.start();
      scheduler.canRunJob = () => false;

      scheduler.triggerJob('test', 'test');

      const events = project.state.queryEvents({ type: 'job_skipped' });
      expect(events).toHaveLength(1);
      expect(events[0].summary).toContain('quota');
    });
  });

  describe('queue re-add on quota failure', () => {
    it('re-adds job to queue when quota check fails during processQueue', () => {
      createScheduler([
        makeJob('queued-job'),
      ], { maxParallelJobs: 1 });
      scheduler.start();

      // Fill the slot with a dummy session
      mockSM._sessions.push({
        id: 's-0', name: 'dummy', status: 'running',
        tmuxSession: 'tmux-dummy', startedAt: new Date().toISOString(),
        jobSlug: 'other',
      } as any);
      mockSM._aliveSet.add('tmux-dummy');

      // Queue a job (slot is full)
      const result = scheduler.triggerJob('queued-job', 'test');
      expect(result).toBe('queued');
      expect(scheduler.getQueue()).toHaveLength(1);

      // Clear the slot
      mockSM._sessions[0].status = 'completed';
      mockSM._aliveSet.delete('tmux-dummy');

      // But block on quota
      scheduler.canRunJob = () => false;
      scheduler.processQueue();

      // Job should still be in queue (not silently dropped)
      expect(scheduler.getQueue()).toHaveLength(1);
      expect(scheduler.getQueue()[0].slug).toBe('queued-job');
    });
  });

  describe('missed job detection', () => {
    it('triggers jobs that have never run on startup', async () => {
      // Jobs with no prior run history should be triggered at startup,
      // not silently skipped because checkMissedJobs requires lastRun.
      createScheduler([makeJob('never-ran', { schedule: '0 */4 * * *' })]);
      scheduler.start();
      await new Promise(r => setTimeout(r, 50));

      // The job should have been triggered as a "missed" job
      expect(mockSM._spawnCount).toBe(1);
      expect(mockSM._lastSpawnArgs?.name).toContain('never-ran');
    });
  });

  describe('consecutive failure tracking', () => {
    it('tracks multiple consecutive failures', async () => {
      createScheduler([makeJob('fail-job')]);
      scheduler.start();

      mockSM.spawnSession = async () => { throw new Error('boom'); };

      scheduler.triggerJob('fail-job', 'test-1');
      await new Promise(r => setTimeout(r, 50));
      expect(project.state.getJobState('fail-job')?.consecutiveFailures).toBe(1);

      scheduler.triggerJob('fail-job', 'test-2');
      await new Promise(r => setTimeout(r, 50));
      expect(project.state.getJobState('fail-job')?.consecutiveFailures).toBe(2);
    });

    it('resets consecutive failures on success', async () => {
      createScheduler([makeJob('recover-job')]);
      scheduler.start();

      // Fail first
      mockSM.spawnSession = async () => { throw new Error('boom'); };
      scheduler.triggerJob('recover-job', 'test-1');
      await new Promise(r => setTimeout(r, 50));
      expect(project.state.getJobState('recover-job')?.consecutiveFailures).toBe(1);

      // Then succeed
      mockSM.spawnSession = async (args: any) => {
        mockSM._spawnCount++;
        const session = { id: `s-${mockSM._spawnCount}`, name: args.name, status: 'running', tmuxSession: `tmux-${mockSM._spawnCount}`, startedAt: new Date().toISOString(), jobSlug: args.jobSlug };
        mockSM._sessions.push(session as any);
        mockSM._aliveSet.add(session.tmuxSession);
        return session;
      };
      scheduler.triggerJob('recover-job', 'test-2');
      await new Promise(r => setTimeout(r, 50));
      expect(project.state.getJobState('recover-job')?.consecutiveFailures).toBe(0);
    });
  });
});
