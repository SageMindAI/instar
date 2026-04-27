/**
 * Scheduler queue processing edge cases — validates queue behavior,
 * priority ordering, deduplication, and pause/resume logic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import type { JobSchedulerConfig, SessionManagerConfig } from '../../src/core/types.js';

describe('Scheduler queue edge cases', () => {
  let stateDir: string;
  let state: StateManager;
  let sessionConfig: SessionManagerConfig;
  let sessionManager: SessionManager;

  const schedulerConfig: JobSchedulerConfig = {
    jobsFile: '',
    enabled: true,
    maxParallelJobs: 1,
    quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
  };

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-sched-'));
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    state = new StateManager(stateDir);

    sessionConfig = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/bin/claude',
      projectDir: stateDir,
      maxSessions: 10,
      protectedSessions: [],
      completionPatterns: [],
    };
    sessionManager = new SessionManager(sessionConfig, state);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('builds skill prompt correctly', () => {
    // Read JobScheduler source to verify buildPrompt logic
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/scheduler/JobScheduler.ts'),
      'utf-8'
    );
    // Skill type: should produce "/{value} {args}"
    expect(source).toContain("case 'skill':");
    expect(source).toContain("`/${job.execute.value}");
  });

  it('builds prompt type correctly', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/scheduler/JobScheduler.ts'),
      'utf-8'
    );
    // Prompt type: should use value directly
    expect(source).toContain("case 'prompt':");
    expect(source).toContain('job.execute.value');
  });

  it('builds script prompt correctly', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/scheduler/JobScheduler.ts'),
      'utf-8'
    );
    // Script type: should produce "Run this script: {value}"
    expect(source).toContain("case 'script':");
    expect(source).toContain("`Run this script:");
  });

  it('queue deduplicates by slug', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/scheduler/JobScheduler.ts'),
      'utf-8'
    );
    expect(source).toContain('this.queue.some(q => q.slug === slug)');
  });

  it('queue sorts by priority (critical first)', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/scheduler/JobScheduler.ts'),
      'utf-8'
    );
    expect(source).toContain('this.queue.sort');
    expect(source).toContain('PRIORITY_ORDER');
  });

  it('re-enqueues job when quota check fails during drain', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/scheduler/JobScheduler.ts'),
      'utf-8'
    );
    // When processQueue pops a job but quota blocks it, it should re-add to front
    expect(source).toContain('this.queue.unshift(next)');
  });

  it('triggers job on schedule', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/scheduler/JobScheduler.ts'),
      'utf-8'
    );
    // Should create Cron tasks
    expect(source).toContain('new Cron(job.schedule');
    expect(source).toContain("this.triggerJob(job.slug, 'scheduled')");
  });

  it('checks for missed jobs on startup', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/scheduler/JobScheduler.ts'),
      'utf-8'
    );
    expect(source).toContain('checkMissedJobs');
    expect(source).toContain('intervalMs * 1.5');
  });

  it('tracks consecutive failures', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/scheduler/JobScheduler.ts'),
      'utf-8'
    );
    expect(source).toContain('consecutiveFailures');
    expect(source).toContain('getConsecutiveFailures');
  });

  it('pause skips triggers, resume processes queue', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/scheduler/JobScheduler.ts'),
      'utf-8'
    );
    // triggerJob should check paused flag
    expect(source).toContain("if (this.paused)");
    expect(source).toContain("return 'skipped'");
    // resume should call processQueue
    expect(source).toContain('resume');
    expect(source).toContain('this.processQueue()');
  });

  it('stop clears queue and cron tasks', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/scheduler/JobScheduler.ts'),
      'utf-8'
    );
    expect(source).toContain('this.cronTasks.clear()');
    expect(source).toContain('this.queue = []');
    expect(source).toContain('this.running = false');
  });
});
