import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { createTempProject, createMockSessionManager, createSampleJobsFile } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { JobSchedulerConfig } from '../../src/core/types.js';

describe('JobScheduler', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let scheduler: JobScheduler;
  let jobsFile: string;

  beforeEach(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();
    jobsFile = createSampleJobsFile(project.stateDir);

    // Pre-seed lastRun so checkMissedJobs doesn't trigger jobs at startup.
    // Missed-job detection is tested separately in job-scheduler-edge.test.ts.
    for (const slug of ['health-check', 'email-check']) {
      project.state.saveJobState({
        slug,
        lastRun: new Date().toISOString(),
        lastResult: 'success',
        runCount: 1,
        consecutiveFailures: 0,
      });
    }
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
    return scheduler;
  }

  describe('start/stop', () => {
    it('starts and loads jobs', () => {
      createScheduler();
      scheduler.start();

      const status = scheduler.getStatus();
      expect(status.running).toBe(true);
      expect(status.jobCount).toBe(3); // 2 enabled + 1 disabled
      expect(status.enabledJobs).toBe(2);
    });

    it('stops cleanly', () => {
      createScheduler();
      scheduler.start();
      scheduler.stop();

      expect(scheduler.getStatus().running).toBe(false);
    });

    it('start is idempotent', () => {
      createScheduler();
      scheduler.start();
      scheduler.start(); // Should not throw
      expect(scheduler.getStatus().running).toBe(true);
    });
  });

  describe('triggerJob', () => {
    it('triggers a known job', () => {
      createScheduler();
      scheduler.start();

      const result = scheduler.triggerJob('health-check', 'test');
      expect(result).toBe('triggered');
      expect(mockSM._spawnCount).toBe(1);
    });

    it('throws for unknown job', () => {
      createScheduler();
      scheduler.start();

      expect(() => scheduler.triggerJob('nonexistent', 'test'))
        .toThrow('Unknown job: nonexistent');
    });

    it('queues when at max parallel jobs', () => {
      createScheduler({ maxParallelJobs: 1 });
      scheduler.start();

      // First trigger succeeds
      const r1 = scheduler.triggerJob('health-check', 'test');
      expect(r1).toBe('triggered');

      // Second trigger gets queued — at capacity
      const r2 = scheduler.triggerJob('email-check', 'test');
      expect(r2).toBe('queued');

      expect(scheduler.getStatus().queueLength).toBe(1);
    });

    it('skips when paused', () => {
      createScheduler();
      scheduler.start();
      scheduler.pause();

      const result = scheduler.triggerJob('health-check', 'test');
      expect(result).toBe('skipped');
      expect(mockSM._spawnCount).toBe(0);
    });

    it('skips when quota callback returns false', () => {
      createScheduler();
      scheduler.start();
      scheduler.canRunJob = () => false;

      const result = scheduler.triggerJob('health-check', 'test');
      expect(result).toBe('skipped');
      expect(mockSM._spawnCount).toBe(0);
    });
  });

  describe('queue processing', () => {
    it('drains queue when slot opens', () => {
      createScheduler({ maxParallelJobs: 1 });
      scheduler.start();

      // Fill the slot
      scheduler.triggerJob('health-check', 'test');
      expect(mockSM._spawnCount).toBe(1);

      // Queue a job
      scheduler.triggerJob('email-check', 'test');
      expect(scheduler.getStatus().queueLength).toBe(1);

      // Simulate session completion — mark the running session as completed
      const session = mockSM._sessions[0];
      session.status = 'completed';
      mockSM._aliveSet.delete(session.tmuxSession);

      // Process the queue
      scheduler.processQueue();
      expect(mockSM._spawnCount).toBe(2);
      expect(scheduler.getStatus().queueLength).toBe(0);
    });

    it('does not dequeue duplicates', () => {
      createScheduler({ maxParallelJobs: 1 });
      scheduler.start();

      scheduler.triggerJob('health-check', 'test');
      scheduler.triggerJob('email-check', 'test-1');
      scheduler.triggerJob('email-check', 'test-2'); // duplicate slug

      expect(scheduler.getStatus().queueLength).toBe(1);
    });

    it('does not process queue when paused', () => {
      createScheduler({ maxParallelJobs: 1 });
      scheduler.start();

      scheduler.triggerJob('health-check', 'test');
      scheduler.triggerJob('email-check', 'test');

      // Clear the slot
      mockSM._sessions[0].status = 'completed';
      mockSM._aliveSet.delete(mockSM._sessions[0].tmuxSession);

      scheduler.pause();
      scheduler.processQueue();
      expect(mockSM._spawnCount).toBe(1); // Only the first one
    });
  });

  describe('pause/resume', () => {
    it('resume processes pending queue', () => {
      createScheduler({ maxParallelJobs: 1 });
      scheduler.start();

      scheduler.triggerJob('health-check', 'test');
      scheduler.triggerJob('email-check', 'test');
      scheduler.pause();

      // Clear the slot
      mockSM._sessions[0].status = 'completed';
      mockSM._aliveSet.delete(mockSM._sessions[0].tmuxSession);

      scheduler.resume();
      expect(mockSM._spawnCount).toBe(2);
    });

    it('getStatus reflects paused state', () => {
      createScheduler();
      scheduler.start();

      expect(scheduler.getStatus().paused).toBe(false);
      scheduler.pause();
      expect(scheduler.getStatus().paused).toBe(true);
      scheduler.resume();
      expect(scheduler.getStatus().paused).toBe(false);
    });
  });

  describe('failure tracking', () => {
    it('increments consecutive failures on spawn error', async () => {
      createScheduler();
      scheduler.start();

      // Make spawnSession reject
      mockSM.spawnSession = async () => { throw new Error('tmux failed'); };

      scheduler.triggerJob('health-check', 'test');

      // Wait for the async rejection to be handled
      await new Promise(r => setTimeout(r, 50));

      const jobState = project.state.getJobState('health-check');
      expect(jobState?.lastResult).toBe('failure');
      expect(jobState?.consecutiveFailures).toBe(1);
    });
  });

  describe('getJobs', () => {
    it('returns loaded job definitions', () => {
      createScheduler();
      scheduler.start();

      const jobs = scheduler.getJobs();
      expect(jobs).toHaveLength(3);
      expect(jobs.map(j => j.slug)).toContain('health-check');
      expect(jobs.map(j => j.slug)).toContain('disabled-job');
    });
  });

  describe('activity events', () => {
    it('emits scheduler_start event', () => {
      createScheduler();
      scheduler.start();

      const events = project.state.queryEvents({ type: 'scheduler_start' });
      expect(events).toHaveLength(1);
    });

    it('emits job_triggered event', async () => {
      createScheduler();
      scheduler.start();
      scheduler.triggerJob('health-check', 'manual');

      // Wait for async spawn to complete
      await new Promise(r => setTimeout(r, 50));

      const events = project.state.queryEvents({ type: 'job_triggered' });
      expect(events).toHaveLength(1);
      expect(events[0].summary).toContain('health-check');
    });

    it('emits scheduler_stop event', () => {
      createScheduler();
      scheduler.start();
      scheduler.stop();

      const events = project.state.queryEvents({ type: 'scheduler_stop' });
      expect(events).toHaveLength(1);
    });
  });

  describe('machine scope filtering', () => {
    it('runs all jobs when no machine identity is set', () => {
      createScheduler();
      scheduler.start();

      // Both enabled jobs should be schedulable
      const result1 = scheduler.triggerJob('health-check', 'test');
      expect(result1).toBe('triggered');
    });

    it('runs unscoped jobs on any machine', () => {
      jobsFile = createSampleJobsFile(project.stateDir);
      createScheduler();
      scheduler.setMachineIdentity('m_abc123def456', 'justins-macbook');
      scheduler.start();

      // Default sample jobs have no machines field — should run
      const result = scheduler.triggerJob('health-check', 'test');
      expect(result).toBe('triggered');
    });

    it('runs jobs scoped to this machine by ID', () => {
      jobsFile = createSampleJobsFile(project.stateDir, [
        {
          slug: 'scoped-job',
          name: 'Scoped Job',
          description: 'Only on this machine',
          schedule: '0 */4 * * *',
          priority: 'medium',
          expectedDurationMinutes: 5,
          model: 'haiku',
          enabled: true,
          execute: { type: 'skill', value: 'scan' },
          machines: ['m_abc123def456'],
        },
      ]);
      createScheduler();
      scheduler.setMachineIdentity('m_abc123def456', 'justins-macbook');
      scheduler.start();

      const result = scheduler.triggerJob('scoped-job', 'test');
      expect(result).toBe('triggered');
    });

    it('runs jobs scoped to this machine by name (case-insensitive)', () => {
      jobsFile = createSampleJobsFile(project.stateDir, [
        {
          slug: 'name-scoped',
          name: 'Name Scoped',
          description: 'Scoped by machine name',
          schedule: '0 */4 * * *',
          priority: 'medium',
          expectedDurationMinutes: 5,
          model: 'haiku',
          enabled: true,
          execute: { type: 'skill', value: 'scan' },
          machines: ['Justins-MacBook'],
        },
      ]);
      createScheduler();
      scheduler.setMachineIdentity('m_abc123def456', 'justins-macbook');
      scheduler.start();

      const result = scheduler.triggerJob('name-scoped', 'test');
      expect(result).toBe('triggered');
    });

    it('skips jobs scoped to a different machine', () => {
      jobsFile = createSampleJobsFile(project.stateDir, [
        {
          slug: 'other-machine-job',
          name: 'Other Machine Job',
          description: 'Not for this machine',
          schedule: '0 */4 * * *',
          priority: 'medium',
          expectedDurationMinutes: 5,
          model: 'haiku',
          enabled: true,
          execute: { type: 'skill', value: 'scan' },
          machines: ['m_other_machine_id', 'adrianas-laptop'],
        },
      ]);
      createScheduler();
      scheduler.setMachineIdentity('m_abc123def456', 'justins-macbook');
      scheduler.start();

      const result = scheduler.triggerJob('other-machine-job', 'test');
      expect(result).toBe('skipped');
      expect(mockSM._spawnCount).toBe(0);
    });

    it('only schedules cron tasks for machine-scoped jobs', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      jobsFile = createSampleJobsFile(project.stateDir, [
        {
          slug: 'local-job',
          name: 'Local Job',
          description: 'Runs here',
          schedule: '0 */4 * * *',
          priority: 'medium',
          expectedDurationMinutes: 5,
          model: 'haiku',
          enabled: true,
          execute: { type: 'skill', value: 'scan' },
          machines: ['m_this_machine'],
        },
        {
          slug: 'remote-job',
          name: 'Remote Job',
          description: 'Runs elsewhere',
          schedule: '0 */4 * * *',
          priority: 'medium',
          expectedDurationMinutes: 5,
          model: 'haiku',
          enabled: true,
          execute: { type: 'skill', value: 'scan' },
          machines: ['m_other_machine'],
        },
      ]);
      createScheduler();
      scheduler.setMachineIdentity('m_this_machine', 'my-laptop');
      scheduler.start();

      // Should log that 1 job was skipped by machine scope
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('1 job(s) skipped (machine scope)')
      );
      logSpy.mockRestore();

      // Verify the start event mentions the scope filtering
      const events = project.state.queryEvents({ type: 'scheduler_start' });
      expect(events[0].summary).toContain('1 skipped by machine scope');
    });

    it('treats empty machines array as unscoped (runs everywhere)', () => {
      jobsFile = createSampleJobsFile(project.stateDir, [
        {
          slug: 'empty-scope',
          name: 'Empty Scope',
          description: 'No machine restriction',
          schedule: '0 */4 * * *',
          priority: 'medium',
          expectedDurationMinutes: 5,
          model: 'haiku',
          enabled: true,
          execute: { type: 'skill', value: 'scan' },
          machines: [],
        },
      ]);
      createScheduler();
      scheduler.setMachineIdentity('m_any_machine', 'any-name');
      scheduler.start();

      const result = scheduler.triggerJob('empty-scope', 'test');
      expect(result).toBe('triggered');
    });
  });

  describe('notifyJobComplete', () => {
    it('updates job state with success on completed session', async () => {
      createScheduler();
      scheduler.start();

      // Trigger a job to create session state
      scheduler.triggerJob('health-check', 'test');
      await new Promise(r => setTimeout(r, 50));

      // Get the spawned session
      const sessions = mockSM._sessions;
      expect(sessions.length).toBeGreaterThan(0);
      const session = sessions[sessions.length - 1];

      // Simulate session completion
      session.status = 'completed';
      project.state.saveSession(session);

      await scheduler.notifyJobComplete(session.id, session.tmuxSession);

      const jobState = project.state.getJobState('health-check');
      expect(jobState?.lastResult).toBe('success');
      expect(jobState?.consecutiveFailures).toBe(0);
    });

    it('updates job state with failure on failed session', async () => {
      createScheduler();
      scheduler.start();

      // Trigger a job to create session state
      scheduler.triggerJob('health-check', 'test');
      await new Promise(r => setTimeout(r, 50));

      const sessions = mockSM._sessions;
      const session = sessions[sessions.length - 1];

      // Simulate session failure
      session.status = 'failed';
      project.state.saveSession(session);

      await scheduler.notifyJobComplete(session.id, session.tmuxSession);

      const jobState = project.state.getJobState('health-check');
      expect(jobState?.lastResult).toBe('failure');
      expect(jobState?.consecutiveFailures).toBe(1);
    });

    it('updates job state with failure on killed session', async () => {
      createScheduler();
      scheduler.start();

      scheduler.triggerJob('health-check', 'test');
      await new Promise(r => setTimeout(r, 50));

      const sessions = mockSM._sessions;
      const session = sessions[sessions.length - 1];

      // Simulate session killed (e.g., timeout)
      session.status = 'killed';
      project.state.saveSession(session);

      await scheduler.notifyJobComplete(session.id, session.tmuxSession);

      const jobState = project.state.getJobState('health-check');
      expect(jobState?.lastResult).toBe('failure');
    });
  });

  // ── extractHandoff ──────────────────────────────────────────────

  describe('extractHandoff', () => {
    it('extracts handoff notes from output with [HANDOFF] markers', () => {
      const output = 'Some session output\n[HANDOFF]\nCheck ERROR-128 next time.\nAlso verify Safari fix.\n[/HANDOFF]\nMore output';
      expect(JobScheduler.extractHandoff(output)).toBe('Check ERROR-128 next time.\nAlso verify Safari fix.');
    });

    it('returns null when no handoff markers present', () => {
      expect(JobScheduler.extractHandoff('Normal output without markers')).toBeNull();
    });

    it('handles case-insensitive markers', () => {
      const output = '[handoff]\nLowercase notes\n[/handoff]';
      expect(JobScheduler.extractHandoff(output)).toBe('Lowercase notes');
    });

    it('handles empty handoff block', () => {
      const output = '[HANDOFF]\n   \n[/HANDOFF]';
      expect(JobScheduler.extractHandoff(output)).toBe('');
    });

    it('extracts only the first handoff block', () => {
      const output = '[HANDOFF]\nFirst block\n[/HANDOFF]\n[HANDOFF]\nSecond block\n[/HANDOFF]';
      expect(JobScheduler.extractHandoff(output)).toBe('First block');
    });
  });
});
