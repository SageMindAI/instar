/**
 * Tests for JobScheduler's Telegram notification and job-topic coupling.
 *
 * Covers:
 * - notifyJobComplete with Telegram adapter (sendToTopic path)
 * - notifyJobComplete topic recreation on failure
 * - notifyJobComplete with generic messenger fallback
 * - notifyJobComplete updates job state (lastResult, consecutiveFailures)
 * - notifyJobComplete always processes queue (even without messenger)
 * - Duration formatting in notification messages
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateManager } from '../../src/core/StateManager.js';
import type { Session, MessagingAdapter, JobDefinition, SessionManagerConfig } from '../../src/core/types.js';

// We need to test JobScheduler internals without starting cron.
// The approach: construct the scheduler with mock dependencies,
// manually set the jobs array, and call notifyJobComplete directly.

// Mock child_process to prevent real tmux calls
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn().mockImplementation(() => ''),
  execFile: vi.fn(),
}));

// Mock croner to prevent real cron scheduling
vi.mock('croner', () => ({
  Cron: vi.fn().mockImplementation(() => ({
    stop: vi.fn(),
  })),
}));

// Mock JobLoader to return our test jobs
vi.mock('../../src/scheduler/JobLoader.js', () => ({
  loadJobs: vi.fn().mockReturnValue([]),
}));

import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { SessionManager } from '../../src/core/SessionManager.js';

describe('JobScheduler Telegram notifications', () => {
  let tmpDir: string;
  let stateDir: string;
  let state: StateManager;
  let sessionManager: SessionManager;
  let scheduler: JobScheduler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-scheduler-tg-'));
    stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    state = new StateManager(stateDir);

    const smConfig: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir: tmpDir,
      maxSessions: 5,
      protectedSessions: [],
      completionPatterns: [],
    };
    sessionManager = new SessionManager(smConfig, state);

    // Mock captureOutput to return non-empty output (no real tmux in tests)
    vi.spyOn(sessionManager, 'captureOutput').mockReturnValue('Job completed successfully.');

    // Write an empty jobs file
    const jobsFile = path.join(tmpDir, 'jobs.json');
    fs.writeFileSync(jobsFile, '[]');

    scheduler = new JobScheduler(
      { jobsFile, projectDir: tmpDir },
      sessionManager,
      state,
      stateDir,
    );
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper to inject jobs into the scheduler (bypasses loadJobs).
   */
  function injectJobs(jobs: Partial<JobDefinition>[]): void {
    const fullJobs = jobs.map(j => ({
      slug: j.slug ?? 'test-job',
      name: j.name ?? 'Test Job',
      description: j.description ?? 'A test job',
      schedule: j.schedule ?? '0 * * * *',
      enabled: j.enabled ?? true,
      priority: j.priority ?? 'medium' as const,
      model: j.model ?? 'sonnet' as const,
      execute: j.execute ?? { type: 'prompt' as const, value: 'test' },
      topicId: j.topicId,
      telegramNotify: j.telegramNotify,
    }));
    // Access private field to inject jobs
    (scheduler as unknown as { jobs: JobDefinition[] }).jobs = fullJobs as JobDefinition[];
  }

  /**
   * Helper to create a session in state.
   */
  function createSession(overrides: Partial<Session> = {}): Session {
    const session: Session = {
      id: overrides.id ?? 'sess-123',
      name: overrides.name ?? 'test-session',
      status: overrides.status ?? 'completed',
      tmuxSession: overrides.tmuxSession ?? 'test-tmux',
      startedAt: overrides.startedAt ?? new Date(Date.now() - 60000).toISOString(),
      endedAt: overrides.endedAt ?? new Date().toISOString(),
      jobSlug: overrides.jobSlug ?? 'test-job',
      ...overrides,
    };
    state.saveSession(session);
    return session;
  }

  describe('notifyJobComplete', () => {
    it('updates job state with success result on completion', async () => {
      injectJobs([{ slug: 'my-job', name: 'My Job' }]);
      const session = createSession({ jobSlug: 'my-job', status: 'completed' });

      await scheduler.notifyJobComplete(session.id, session.tmuxSession);

      const jobState = state.getJobState('my-job');
      expect(jobState).not.toBeNull();
      expect(jobState!.lastResult).toBe('success');
      expect(jobState!.consecutiveFailures).toBe(0);
    });

    it('updates job state with failure result on killed session', async () => {
      injectJobs([{ slug: 'my-job', name: 'My Job' }]);
      const session = createSession({ jobSlug: 'my-job', status: 'killed' });

      await scheduler.notifyJobComplete(session.id, session.tmuxSession);

      const jobState = state.getJobState('my-job');
      expect(jobState!.lastResult).toBe('failure');
      expect(jobState!.consecutiveFailures).toBe(1);
    });

    it('increments consecutiveFailures on repeated failures', async () => {
      injectJobs([{ slug: 'my-job', name: 'My Job' }]);

      // Simulate existing state with 2 consecutive failures
      state.saveJobState({
        slug: 'my-job',
        lastRun: new Date().toISOString(),
        lastResult: 'failure',
        consecutiveFailures: 2,
      });

      const session = createSession({ jobSlug: 'my-job', status: 'killed' });
      await scheduler.notifyJobComplete(session.id, session.tmuxSession);

      const jobState = state.getJobState('my-job');
      expect(jobState!.consecutiveFailures).toBe(3);
    });

    it('resets consecutiveFailures on success', async () => {
      injectJobs([{ slug: 'my-job', name: 'My Job' }]);

      // Simulate existing state with 5 consecutive failures
      state.saveJobState({
        slug: 'my-job',
        lastRun: new Date().toISOString(),
        lastResult: 'failure',
        consecutiveFailures: 5,
      });

      const session = createSession({ jobSlug: 'my-job', status: 'completed' });
      await scheduler.notifyJobComplete(session.id, session.tmuxSession);

      const jobState = state.getJobState('my-job');
      expect(jobState!.consecutiveFailures).toBe(0);
      expect(jobState!.lastResult).toBe('success');
    });

    it('sends notification to Telegram topic when adapter is set', async () => {
      const mockTelegram = {
        sendToTopic: vi.fn().mockResolvedValue(undefined),
        createForumTopic: vi.fn(),
      };
      scheduler.setTelegram(mockTelegram as unknown as import('../../src/messaging/TelegramAdapter.js').TelegramAdapter);

      // captureOutput must return non-empty text — empty output is silently skipped
      vi.spyOn(sessionManager, 'captureOutput').mockReturnValue('Job completed successfully.');

      injectJobs([{ slug: 'tg-job', name: 'TG Job', topicId: 42, telegramNotify: true }]);
      const session = createSession({ jobSlug: 'tg-job', status: 'completed' });

      await scheduler.notifyJobComplete(session.id, session.tmuxSession);

      expect(mockTelegram.sendToTopic).toHaveBeenCalledWith(42, expect.stringContaining('TG Job'));
      expect(mockTelegram.sendToTopic).toHaveBeenCalledWith(42, expect.stringContaining('Done'));
    });

    it('recreates topic when sendToTopic fails', async () => {
      const mockTelegram = {
        sendToTopic: vi.fn()
          .mockRejectedValueOnce(new Error('topic deleted'))
          .mockResolvedValueOnce(undefined),
        findOrCreateForumTopic: vi.fn().mockResolvedValue({ topicId: 99, name: '⚙️ Job: Recreate Job', reused: false }),
      };
      scheduler.setTelegram(mockTelegram as unknown as import('../../src/messaging/TelegramAdapter.js').TelegramAdapter);

      vi.spyOn(sessionManager, 'captureOutput').mockReturnValue('Job completed successfully.');

      injectJobs([{ slug: 'recreate-job', name: 'Recreate Job', topicId: 42, telegramNotify: true }]);
      const session = createSession({ jobSlug: 'recreate-job', status: 'completed' });

      await scheduler.notifyJobComplete(session.id, session.tmuxSession);

      // Should have tried original topic first, then created a new one
      expect(mockTelegram.findOrCreateForumTopic).toHaveBeenCalledWith('⚙️ Job: Recreate Job', 13338331);
      // Second sendToTopic call should be to the new topic
      expect(mockTelegram.sendToTopic).toHaveBeenCalledTimes(2);
      expect(mockTelegram.sendToTopic).toHaveBeenLastCalledWith(99, expect.any(String));
    });

    it('falls back to generic messenger when no Telegram', async () => {
      const mockMessenger: MessagingAdapter = {
        send: vi.fn().mockResolvedValue(undefined),
      };
      scheduler.setMessenger(mockMessenger);

      vi.spyOn(sessionManager, 'captureOutput').mockReturnValue('Job completed successfully.');

      injectJobs([{ slug: 'msg-job', name: 'Msg Job', telegramNotify: true }]);
      const session = createSession({ jobSlug: 'msg-job', status: 'completed' });

      await scheduler.notifyJobComplete(session.id, session.tmuxSession);

      expect(mockMessenger.send).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'system',
          content: expect.stringContaining('Msg Job'),
        })
      );
    });

    it('skips notification when no messaging configured', async () => {
      // No messenger, no Telegram — should complete without error
      injectJobs([{ slug: 'silent-job', name: 'Silent Job' }]);
      const session = createSession({ jobSlug: 'silent-job', status: 'completed' });

      // Should not throw
      await scheduler.notifyJobComplete(session.id, session.tmuxSession);

      // State should still be updated
      const jobState = state.getJobState('silent-job');
      expect(jobState!.lastResult).toBe('success');
    });

    it('silently returns when session has no jobSlug', async () => {
      const session = createSession({ jobSlug: undefined });

      // Should not throw
      await scheduler.notifyJobComplete(session.id, session.tmuxSession);
    });

    it('silently returns when session ID is unknown', async () => {
      // Should not throw
      await scheduler.notifyJobComplete('nonexistent', 'nonexistent-tmux');
    });

    it('includes duration in notification message', async () => {
      const mockTelegram = {
        sendToTopic: vi.fn().mockResolvedValue(undefined),
        createForumTopic: vi.fn(),
      };
      scheduler.setTelegram(mockTelegram as unknown as import('../../src/messaging/TelegramAdapter.js').TelegramAdapter);

      vi.spyOn(sessionManager, 'captureOutput').mockReturnValue('Job completed successfully.');

      injectJobs([{ slug: 'dur-job', name: 'Duration Job', topicId: 10, telegramNotify: true }]);
      // Create session that started 5 minutes ago
      const session = createSession({
        jobSlug: 'dur-job',
        status: 'completed',
        startedAt: new Date(Date.now() - 300000).toISOString(),
      });

      await scheduler.notifyJobComplete(session.id, session.tmuxSession);

      const sentMessage = mockTelegram.sendToTopic.mock.calls[0][1];
      expect(sentMessage).toContain('Duration:');
      expect(sentMessage).toContain('m'); // minutes
    });
  });
});
