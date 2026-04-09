/**
 * Tests for JobScheduler queue cap.
 *
 * Verifies that the queue has a bounded size (50 items)
 * and silently drops new entries when full.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { JobSchedulerConfig, JobDefinition } from '../../src/core/types.js';
import fs from 'node:fs';

describe('JobScheduler — queue cap', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let scheduler: JobScheduler;
  let jobsFile: string;

  beforeEach(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();

    // Create a jobs file with many jobs to fill the queue
    const jobs: Partial<JobDefinition>[] = [];
    for (let i = 0; i < 60; i++) {
      jobs.push({
        slug: `job-${i}`,
        name: `Job ${i}`,
        enabled: true,
        schedule: '0 * * * *',
        priority: 'low',
        model: 'haiku',
        description: `Test job ${i}`,
        execute: { type: 'prompt', value: `Test ${i}` },
      });
    }
    jobsFile = `${project.stateDir}/many-jobs.json`;
    fs.writeFileSync(jobsFile, JSON.stringify(jobs));
  });

  afterEach(() => {
    scheduler?.stop();
    project.cleanup();
  });

  it('caps queue at 50 items', async () => {
    scheduler = new JobScheduler(
      { jobsFile, enabled: true, maxParallelJobs: 1, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
      mockSM as any,
      project.state,
      project.stateDir,
    );
    scheduler.start();

    // First trigger fills the slot
    await scheduler.triggerJob('job-0', 'test');
    expect(mockSM._spawnCount).toBe(1);

    // Queue 50 more — only 50 should be queued, rest dropped
    for (let i = 1; i <= 55; i++) {
      await scheduler.triggerJob(`job-${i}`, 'test');
    }

    // Queue should be capped at 50
    expect(scheduler.getQueue().length).toBe(50);
  });
});
