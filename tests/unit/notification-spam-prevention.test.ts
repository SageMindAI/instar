/**
 * Regression tests for notification spam prevention (v0.12.6-0.12.8).
 *
 * Covers three fixes:
 * 1. Job quiet mode (on-alert default) — jobs don't notify unless failed or [ATTENTION]
 * 2. Update loop breaker — auto-updater doesn't re-apply lastAppliedVersion
 * 3. Lifeline rate limiting — "server went down" capped at 1 per 30 minutes
 *
 * These prevent the firehose of notifications that occurred on fresh installs
 * when all jobs fired at once, and the update→restart→detect→update loop.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateManager } from '../../src/core/StateManager.js';
import type { Session, JobDefinition, SessionManagerConfig } from '../../src/core/types.js';
import { AutoUpdater } from '../../src/core/AutoUpdater.js';
import type { UpdateChecker } from '../../src/core/UpdateChecker.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';

// ── Mock Factories ──────────────────────────────────────────────

function createMockUpdateChecker(overrides?: Partial<UpdateChecker>): UpdateChecker {
  return {
    check: vi.fn().mockResolvedValue({
      currentVersion: '0.9.8',
      latestVersion: '0.9.8',
      updateAvailable: false,
      checkedAt: new Date().toISOString(),
    }),
    applyUpdate: vi.fn().mockResolvedValue({
      success: true,
      previousVersion: '0.9.8',
      newVersion: '0.9.9',
      message: 'Updated',
      restartNeeded: true,
      healthCheck: 'skipped',
    }),
    getInstalledVersion: vi.fn().mockReturnValue('0.9.8'),
    getLastCheck: vi.fn().mockReturnValue(null),
    rollback: vi.fn().mockResolvedValue({ success: false, previousVersion: '0.9.8', restoredVersion: '0.9.8', message: 'No rollback' }),
    canRollback: vi.fn().mockReturnValue(false),
    getRollbackInfo: vi.fn().mockReturnValue(null),
    fetchChangelog: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as UpdateChecker;
}

function createMockTelegram(): TelegramAdapter & { sendToTopic: ReturnType<typeof vi.fn> } {
  return {
    sendToTopic: vi.fn().mockResolvedValue(undefined),
    platform: 'telegram',
    start: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(),
    onMessage: vi.fn(),
    resolveUser: vi.fn(),
    findOrCreateForumTopic: vi.fn().mockResolvedValue({ topicId: 999, name: 'test', reused: false }),
  } as unknown as TelegramAdapter & { sendToTopic: ReturnType<typeof vi.fn> };
}

function createMockState(): StateManager {
  return {
    get: vi.fn().mockReturnValue(997),
    set: vi.fn(),
    getSession: vi.fn().mockReturnValue(null),
    saveSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    deleteSession: vi.fn(),
  } as unknown as StateManager;
}

// ═══════════════════════════════════════════════════════════════
// 1. AUTO-UPDATER LOOP PREVENTION
// ═══════════════════════════════════════════════════════════════

describe('AutoUpdater loop prevention', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-updater-loop-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does NOT re-apply when lastAppliedVersion matches latest', async () => {
    // Simulate: we already applied v0.9.9 but the binary still reports v0.9.8
    const stateFile = path.join(tmpDir, 'state', 'auto-updater.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      lastAppliedVersion: '0.9.9',
      savedAt: new Date().toISOString(),
    }));

    const mockChecker = createMockUpdateChecker({
      check: vi.fn().mockResolvedValue({
        currentVersion: '0.9.8',   // Running binary is old
        latestVersion: '0.9.9',    // Registry says 0.9.9
        updateAvailable: true,
        checkedAt: new Date().toISOString(),
      }),
    });

    const updater = new AutoUpdater(
      mockChecker,
      createMockState(),
      tmpDir,
      { checkIntervalMinutes: 30, autoApply: true, applyDelayMinutes: 0 },
    );

    updater.start();

    // Advance past the initial 10s delay to trigger first tick
    await vi.advanceTimersByTimeAsync(15_000);

    // applyUpdate should NOT have been called — the loop breaker prevented it
    expect(mockChecker.applyUpdate).not.toHaveBeenCalled();

    updater.stop();
  });

  it('DOES apply when lastAppliedVersion is different from latest', async () => {
    // No prior apply — fresh install
    const mockChecker = createMockUpdateChecker({
      check: vi.fn().mockResolvedValue({
        currentVersion: '0.9.8',
        latestVersion: '0.9.9',
        updateAvailable: true,
        checkedAt: new Date().toISOString(),
      }),
    });

    const updater = new AutoUpdater(
      mockChecker,
      createMockState(),
      tmpDir,
      { checkIntervalMinutes: 30, autoApply: true, applyDelayMinutes: 0 },
    );

    updater.start();
    await vi.advanceTimersByTimeAsync(15_000);

    // applyUpdate SHOULD be called — no loop guard triggered
    expect(mockChecker.applyUpdate).toHaveBeenCalledTimes(1);

    updater.stop();
  });

  it('sends ONE mismatch notification, not repeated ones', async () => {
    const stateFile = path.join(tmpDir, 'state', 'auto-updater.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      lastAppliedVersion: '0.9.9',
      savedAt: new Date().toISOString(),
    }));

    const mockChecker = createMockUpdateChecker({
      check: vi.fn().mockResolvedValue({
        currentVersion: '0.9.8',
        latestVersion: '0.9.9',
        updateAvailable: true,
        checkedAt: new Date().toISOString(),
      }),
    });

    const telegram = createMockTelegram();

    const updater = new AutoUpdater(
      mockChecker,
      createMockState(),
      tmpDir,
      { checkIntervalMinutes: 1, autoApply: true, applyDelayMinutes: 0 },
      telegram,
    );

    updater.start();

    // First tick — should send mismatch notification
    await vi.advanceTimersByTimeAsync(15_000);
    const firstCallCount = telegram.sendToTopic.mock.calls.length;
    expect(firstCallCount).toBe(1);
    expect(telegram.sendToTopic.mock.calls[0][1]).toContain('still running v0.9.8');

    // Second tick — should NOT send duplicate mismatch notification
    await vi.advanceTimersByTimeAsync(65_000);
    expect(telegram.sendToTopic.mock.calls.length).toBe(firstCallCount);

    updater.stop();
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. JOB QUIET MODE (ON-ALERT)
// ═══════════════════════════════════════════════════════════════

// Mock child_process and croner for JobScheduler tests
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn().mockImplementation(() => ''),
  execFile: vi.fn(),
}));

vi.mock('croner', () => ({
  Cron: vi.fn().mockImplementation(() => ({
    stop: vi.fn(),
  })),
}));

vi.mock('../../src/scheduler/JobLoader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/scheduler/JobLoader.js')>();
  return {
    ...actual,
    loadJobs: vi.fn().mockReturnValue([]),
  };
});

import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { SessionManager } from '../../src/core/SessionManager.js';

describe('Job quiet mode (on-alert)', () => {
  let tmpDir: string;
  let stateDir: string;
  let state: StateManager;
  let sessionManager: SessionManager;
  let scheduler: JobScheduler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-quiet-jobs-'));
    stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'jobs'), { recursive: true });

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
      expectedDurationMinutes: 5,
      topicId: j.topicId,
      telegramNotify: j.telegramNotify,
    }));
    (scheduler as unknown as { jobs: JobDefinition[] }).jobs = fullJobs as JobDefinition[];
  }

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

  it('suppresses notification for routine success in on-alert mode (default)', async () => {
    const mockTelegram = {
      sendToTopic: vi.fn().mockResolvedValue(undefined),
      findOrCreateForumTopic: vi.fn().mockResolvedValue({ topicId: 42, name: 'test', reused: false }),
    };
    scheduler.setTelegram(mockTelegram as unknown as TelegramAdapter);

    // telegramNotify is undefined → defaults to on-alert
    injectJobs([{ slug: 'quiet-job', name: 'Quiet Job', topicId: 42 }]);

    // Mock output with no attention signal
    vi.spyOn(sessionManager, 'captureOutput').mockReturnValue('Everything is healthy. No issues found.');

    const session = createSession({ jobSlug: 'quiet-job', status: 'completed' });
    await scheduler.notifyJobComplete(session.id, session.tmuxSession);

    // Should NOT send — routine success, no [ATTENTION] marker
    expect(mockTelegram.sendToTopic).not.toHaveBeenCalled();
  });

  it('sends notification when session signals [ATTENTION]', async () => {
    const mockTelegram = {
      sendToTopic: vi.fn().mockResolvedValue(undefined),
      findOrCreateForumTopic: vi.fn().mockResolvedValue({ topicId: 42, name: 'test', reused: false }),
    };
    scheduler.setTelegram(mockTelegram as unknown as TelegramAdapter);

    injectJobs([{ slug: 'alert-job', name: 'Alert Job', topicId: 42 }]);

    // Mock output WITH attention signal
    vi.spyOn(sessionManager, 'captureOutput').mockReturnValue(
      'Checking email...\n[ATTENTION] Found 3 unread messages from VIP contacts\nDone.'
    );

    const session = createSession({ jobSlug: 'alert-job', status: 'completed' });
    await scheduler.notifyJobComplete(session.id, session.tmuxSession);

    // SHOULD send — attention signal present
    expect(mockTelegram.sendToTopic).toHaveBeenCalledWith(42, expect.stringContaining('Alert Job'));
  });

  it('sends notification on job failure even in on-alert mode', async () => {
    const mockTelegram = {
      sendToTopic: vi.fn().mockResolvedValue(undefined),
      findOrCreateForumTopic: vi.fn().mockResolvedValue({ topicId: 42, name: 'test', reused: false }),
    };
    scheduler.setTelegram(mockTelegram as unknown as TelegramAdapter);

    injectJobs([{ slug: 'fail-job', name: 'Fail Job', topicId: 42 }]);

    vi.spyOn(sessionManager, 'captureOutput').mockReturnValue('Error: something broke');

    const session = createSession({ jobSlug: 'fail-job', status: 'failed' });
    await scheduler.notifyJobComplete(session.id, session.tmuxSession);

    // SHOULD send — failures always notify
    expect(mockTelegram.sendToTopic).toHaveBeenCalledWith(42, expect.stringContaining('Failed'));
  });

  it('always notifies when telegramNotify is explicitly true', async () => {
    const mockTelegram = {
      sendToTopic: vi.fn().mockResolvedValue(undefined),
      findOrCreateForumTopic: vi.fn().mockResolvedValue({ topicId: 42, name: 'test', reused: false }),
    };
    scheduler.setTelegram(mockTelegram as unknown as TelegramAdapter);

    injectJobs([{ slug: 'loud-job', name: 'Loud Job', topicId: 42, telegramNotify: true }]);

    vi.spyOn(sessionManager, 'captureOutput').mockReturnValue('Everything is fine. Nothing to report.');

    const session = createSession({ jobSlug: 'loud-job', status: 'completed' });
    await scheduler.notifyJobComplete(session.id, session.tmuxSession);

    // SHOULD send — telegramNotify: true overrides on-alert
    expect(mockTelegram.sendToTopic).toHaveBeenCalledWith(42, expect.stringContaining('Loud Job'));
  });

  it('never notifies when telegramNotify is false', async () => {
    const mockTelegram = {
      sendToTopic: vi.fn().mockResolvedValue(undefined),
      findOrCreateForumTopic: vi.fn().mockResolvedValue({ topicId: 42, name: 'test', reused: false }),
    };
    scheduler.setTelegram(mockTelegram as unknown as TelegramAdapter);

    injectJobs([{ slug: 'silent-job', name: 'Silent Job', topicId: 42, telegramNotify: false }]);

    vi.spyOn(sessionManager, 'captureOutput').mockReturnValue('[ATTENTION] Something important!');

    const session = createSession({ jobSlug: 'silent-job', status: 'completed' });
    await scheduler.notifyJobComplete(session.id, session.tmuxSession);

    // Should NOT send — telegramNotify: false overrides everything
    expect(mockTelegram.sendToTopic).not.toHaveBeenCalled();
  });

  it('creates topic lazily for on-alert jobs when attention is signaled', async () => {
    const mockTelegram = {
      sendToTopic: vi.fn().mockResolvedValue(undefined),
      findOrCreateForumTopic: vi.fn().mockResolvedValue({ topicId: 555, name: '⚙️ Job: Lazy Job', reused: false }),
    };
    scheduler.setTelegram(mockTelegram as unknown as TelegramAdapter);

    // No topicId set — topic should be created lazily
    injectJobs([{ slug: 'lazy-job', name: 'Lazy Job' }]);

    vi.spyOn(sessionManager, 'captureOutput').mockReturnValue('[ATTENTION] Found something noteworthy');

    const session = createSession({ jobSlug: 'lazy-job', status: 'completed' });
    await scheduler.notifyJobComplete(session.id, session.tmuxSession);

    // Topic should have been created lazily
    expect(mockTelegram.findOrCreateForumTopic).toHaveBeenCalled();
    // And notification sent to the new topic
    expect(mockTelegram.sendToTopic).toHaveBeenCalledWith(555, expect.stringContaining('Lazy Job'));
  });

  it('[ATTENTION] detection is case-insensitive', async () => {
    const mockTelegram = {
      sendToTopic: vi.fn().mockResolvedValue(undefined),
      findOrCreateForumTopic: vi.fn().mockResolvedValue({ topicId: 42, name: 'test', reused: false }),
    };
    scheduler.setTelegram(mockTelegram as unknown as TelegramAdapter);

    injectJobs([{ slug: 'case-job', name: 'Case Job', topicId: 42 }]);

    vi.spyOn(sessionManager, 'captureOutput').mockReturnValue(
      'Running checks...\n[attention] something needs review\nDone.'
    );

    const session = createSession({ jobSlug: 'case-job', status: 'completed' });
    await scheduler.notifyJobComplete(session.id, session.tmuxSession);

    // Should match even with lowercase
    expect(mockTelegram.sendToTopic).toHaveBeenCalled();
  });

  it('injects attention protocol into job prompt for on-alert jobs', () => {
    injectJobs([{ slug: 'protocol-job', name: 'Protocol Job' }]);

    // Access private buildPrompt
    const buildPrompt = (scheduler as unknown as { buildPrompt: (job: JobDefinition) => string }).buildPrompt;
    const jobs = (scheduler as unknown as { jobs: JobDefinition[] }).jobs;
    const prompt = buildPrompt.call(scheduler, jobs[0]);

    expect(prompt).toContain('NOTIFICATION PROTOCOL');
    expect(prompt).toContain('[ATTENTION]');
    expect(prompt).toContain('quiet mode');
  });

  it('does NOT inject attention protocol for telegramNotify: true jobs', () => {
    injectJobs([{ slug: 'loud-job', name: 'Loud Job', telegramNotify: true }]);

    const buildPrompt = (scheduler as unknown as { buildPrompt: (job: JobDefinition) => string }).buildPrompt;
    const jobs = (scheduler as unknown as { jobs: JobDefinition[] }).jobs;
    const prompt = buildPrompt.call(scheduler, jobs[0]);

    expect(prompt).not.toContain('NOTIFICATION PROTOCOL');
  });

  it('preserves explicitly-configured topicId for on-alert jobs', async () => {
    const mockTelegram = {
      sendToTopic: vi.fn().mockResolvedValue(undefined),
      findOrCreateForumTopic: vi.fn().mockResolvedValue({ topicId: 42, name: 'test', reused: false }),
      closeForumTopic: vi.fn().mockResolvedValue(true),
    };
    scheduler.setTelegram(mockTelegram as unknown as TelegramAdapter);

    // Job has an explicitly-configured topicId — should NOT be closed
    injectJobs([{ slug: 'stale-job', name: 'Stale Job', topicId: 777 }]);

    const ensureJobTopics = (scheduler as unknown as {
      ensureJobTopics: (jobs: JobDefinition[]) => Promise<void>;
    }).ensureJobTopics;
    const jobs = (scheduler as unknown as { jobs: JobDefinition[] }).jobs;
    await ensureJobTopics.call(scheduler, jobs);

    // Should NOT close explicitly-configured topics
    expect(mockTelegram.closeForumTopic).not.toHaveBeenCalled();

    // topicId should be preserved
    expect(jobs[0].topicId).toBe(777);
  });

  it('cleans up dynamically-created topic mappings for on-alert jobs', async () => {
    const mockTelegram = {
      sendToTopic: vi.fn().mockResolvedValue(undefined),
      findOrCreateForumTopic: vi.fn().mockResolvedValue({ topicId: 42, name: 'test', reused: false }),
      closeForumTopic: vi.fn().mockResolvedValue(true),
    };
    scheduler.setTelegram(mockTelegram as unknown as TelegramAdapter);

    // Simulate stale dynamic mapping (no explicit topicId on job)
    state.set('job-topic-mappings', { 'stale-job': 777 });

    // Job without explicit topicId — the mapping is from a previous dynamic creation
    injectJobs([{ slug: 'stale-job', name: 'Stale Job' }]);

    const ensureJobTopics = (scheduler as unknown as {
      ensureJobTopics: (jobs: JobDefinition[]) => Promise<void>;
    }).ensureJobTopics;
    const jobs = (scheduler as unknown as { jobs: JobDefinition[] }).jobs;
    await ensureJobTopics.call(scheduler, jobs);

    // Should close the dynamically-created stale topic
    expect(mockTelegram.closeForumTopic).toHaveBeenCalledWith(777);

    // Should have removed the mapping
    const mappings = state.get<Record<string, number>>('job-topic-mappings');
    expect(mappings?.['stale-job']).toBeUndefined();
  });

  it('does NOT clean up topics for telegramNotify: true jobs', async () => {
    const mockTelegram = {
      sendToTopic: vi.fn().mockResolvedValue(undefined),
      findOrCreateForumTopic: vi.fn().mockResolvedValue({ topicId: 42, name: 'test', reused: false }),
      closeForumTopic: vi.fn().mockResolvedValue(true),
    };
    scheduler.setTelegram(mockTelegram as unknown as TelegramAdapter);

    state.set('job-topic-mappings', { 'loud-job': 888 });

    injectJobs([{ slug: 'loud-job', name: 'Loud Job', topicId: 888, telegramNotify: true }]);

    const ensureJobTopics = (scheduler as unknown as {
      ensureJobTopics: (jobs: JobDefinition[]) => Promise<void>;
    }).ensureJobTopics;
    const jobs = (scheduler as unknown as { jobs: JobDefinition[] }).jobs;
    await ensureJobTopics.call(scheduler, jobs);

    // Should NOT have closed the topic — it's an always-notify job
    expect(mockTelegram.closeForumTopic).not.toHaveBeenCalled();

    // Mapping should still exist
    const mappings = state.get<Record<string, number>>('job-topic-mappings');
    expect(mappings?.['loud-job']).toBe(888);
  });
});

