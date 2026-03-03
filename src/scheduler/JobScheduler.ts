/**
 * Job Scheduler — cron-based job execution engine.
 *
 * Schedules jobs via croner, respects session limits and quota,
 * queues jobs when at capacity, and drains when slots open.
 *
 * Simplified from Dawn's 1400-line scheduler — serial queue,
 * no JSONL discovery, no machine coordination.
 */

import { Cron } from 'croner';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { loadJobs } from './JobLoader.js';
import { SkipLedger } from './SkipLedger.js';
import { classifySessionDeath } from '../monitoring/QuotaExhaustionDetector.js';
import type { SessionManager } from '../core/SessionManager.js';
import type { StateManager } from '../core/StateManager.js';
import type { QuotaTracker } from '../monitoring/QuotaTracker.js';
import type { MessagingAdapter, SkipReason } from '../core/types.js';
import { TOPIC_STYLE } from '../messaging/TelegramAdapter.js';
import type { JobDefinition, JobSchedulerConfig, JobState, JobPriority } from '../core/types.js';
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import type { JobClaimManager } from './JobClaimManager.js';

interface QueuedJob {
  slug: string;
  reason: string;
  queuedAt: string;
}

interface SchedulerStatus {
  running: boolean;
  paused: boolean;
  jobCount: number;
  enabledJobs: number;
  queueLength: number;
  activeJobSessions: number;
}

const PRIORITY_ORDER: Record<JobPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export class JobScheduler {
  private config: JobSchedulerConfig;
  private sessionManager: SessionManager;
  private state: StateManager;
  private skipLedger: SkipLedger;
  private jobs: JobDefinition[] = [];
  private cronTasks: Map<string, Cron> = new Map();
  private queue: QueuedJob[] = [];
  private running = false;
  private paused = false;

  /** Callback to check if quota allows running a job at the given priority */
  canRunJob: (priority: JobPriority) => boolean = () => true;

  /** Optional messenger for sending job notifications */
  private messenger: MessagingAdapter | null = null;

  /** Optional Telegram adapter for job-topic coupling */
  private telegram: TelegramAdapter | null = null;

  /** Optional quota tracker for death classification cross-reference */
  private quotaTracker: QuotaTracker | null = null;

  /** Optional job claim manager for multi-machine deduplication (Phase 4C) */
  private claimManager: JobClaimManager | null = null;

  constructor(
    config: JobSchedulerConfig,
    sessionManager: SessionManager,
    state: StateManager,
    stateDir: string,
  ) {
    this.config = config;
    this.sessionManager = sessionManager;
    this.state = state;
    this.skipLedger = new SkipLedger(stateDir);
  }

  /**
   * Set a messaging adapter for job completion notifications.
   */
  setMessenger(adapter: MessagingAdapter): void {
    this.messenger = adapter;
  }

  /**
   * Set the Telegram adapter for job-topic coupling.
   * Every job gets its own topic — the user's window into the job.
   */
  setTelegram(adapter: TelegramAdapter): void {
    this.telegram = adapter;

    // If scheduler already started, ensure job topics now that Telegram is available.
    // This fixes the startup race condition where start() runs before Telegram connects.
    if (this.running && this.jobs.length > 0) {
      const enabledJobs = this.jobs.filter(j => j.enabled);
      this.ensureJobTopics(enabledJobs).catch(err => {
        console.error(`[scheduler] Failed to ensure job topics (post-Telegram init): ${err}`);
      });
    }
  }

  /**
   * Set the quota tracker for session death classification.
   * When set, session deaths are cross-referenced with quota state
   * to determine if they died from quota exhaustion.
   */
  setQuotaTracker(tracker: QuotaTracker): void {
    this.quotaTracker = tracker;
  }

  /**
   * Set the job claim manager for multi-machine deduplication.
   * When set, the scheduler will broadcast claims before executing jobs
   * and skip jobs already claimed by other machines.
   */
  setJobClaimManager(manager: JobClaimManager): void {
    this.claimManager = manager;
  }

  /**
   * Start the scheduler — load jobs, set up cron tasks, check for missed jobs.
   */
  start(): void {
    if (this.running) return;

    this.jobs = loadJobs(this.config.jobsFile);
    this.running = true;

    const enabledJobs = this.jobs.filter(j => j.enabled);
    for (const job of enabledJobs) {
      try {
        const task = new Cron(job.schedule, () => {
          this.triggerJob(job.slug, 'scheduled');
        });
        this.cronTasks.set(job.slug, task);
      } catch (err) {
        console.error(`[scheduler] Invalid cron expression for job "${job.slug}": ${job.schedule} — ${err instanceof Error ? err.message : err}`);
      }
    }

    // Check for missed jobs — any enabled job overdue by >1.5x its interval
    this.checkMissedJobs(enabledJobs);

    // Ensure every job has a Telegram topic (job-topic coupling)
    if (this.telegram) {
      this.ensureJobTopics(enabledJobs).catch(err => {
        console.error(`[scheduler] Failed to ensure job topics: ${err}`);
      });
    }

    this.state.appendEvent({
      type: 'scheduler_start',
      summary: `Scheduler started with ${enabledJobs.length} enabled jobs`,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Stop the scheduler — cancel all cron tasks.
   */
  stop(): void {
    if (!this.running) return;

    for (const [, task] of this.cronTasks) {
      task.stop();
    }
    this.cronTasks.clear();
    this.queue = [];
    this.running = false;

    this.state.appendEvent({
      type: 'scheduler_stop',
      summary: 'Scheduler stopped',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Trigger a job by slug. Checks claims, quota, session limits, queues if at capacity.
   */
  triggerJob(slug: string, reason: string): 'triggered' | 'queued' | 'skipped' {
    const job = this.jobs.find(j => j.slug === slug);
    if (!job) {
      throw new Error(`Unknown job: ${slug}`);
    }

    if (this.paused) {
      this.skipLedger.recordSkip(slug, 'paused');
      return 'skipped';
    }

    // Multi-machine claim check (Phase 4C — Gap 5)
    // If another machine already claimed this job, skip it.
    if (this.claimManager?.hasRemoteClaim(slug)) {
      this.skipLedger.recordSkip(slug, 'claimed');
      this.state.appendEvent({
        type: 'job_skipped',
        summary: `Job "${slug}" skipped — claimed by another machine`,
        timestamp: new Date().toISOString(),
        metadata: { slug, reason, claimedBy: this.claimManager.getClaim(slug)?.machineId },
      });
      return 'skipped';
    }

    if (!this.canRunJob(job.priority)) {
      this.skipLedger.recordSkip(slug, 'quota');
      this.state.appendEvent({
        type: 'job_skipped',
        summary: `Job "${slug}" skipped — quota check failed`,
        timestamp: new Date().toISOString(),
        metadata: { slug, reason, priority: job.priority },
      });
      return 'skipped';
    }

    // Run gate command if configured — zero-token pre-screening
    if (job.gate) {
      if (!this.runGate(job)) {
        return 'skipped';
      }
    }

    // Check session capacity
    const runningSessions = this.sessionManager.listRunningSessions();
    const jobSessions = runningSessions.filter(s => s.jobSlug);
    if (jobSessions.length >= this.config.maxParallelJobs) {
      this.enqueue(slug, reason);
      return 'queued';
    }

    // Broadcast claim before spawning (async, best-effort)
    if (this.claimManager) {
      const timeoutMs = (job.expectedDurationMinutes ?? 30) * 2 * 60_000;
      this.claimManager.tryClaim(slug, timeoutMs).catch(err => {
        console.error(`[scheduler] Failed to broadcast claim for "${slug}": ${err}`);
      });
    }

    this.spawnJobSession(job, reason);
    return 'triggered';
  }

  /**
   * Process the queue — dequeue and run next job if a slot is available.
   */
  processQueue(): void {
    if (this.paused || this.queue.length === 0) return;

    const runningSessions = this.sessionManager.listRunningSessions();
    const jobSessions = runningSessions.filter(s => s.jobSlug);
    if (jobSessions.length >= this.config.maxParallelJobs) return;

    const next = this.queue.shift();
    if (!next) return;

    const job = this.jobs.find(j => j.slug === next.slug);
    if (!job) return;

    if (!this.canRunJob(job.priority)) {
      // Re-add to front of queue — don't silently drop
      this.queue.unshift(next);
      return;
    }

    this.spawnJobSession(job, `queued:${next.reason}`);
  }

  /**
   * Pause — cron tasks keep ticking but triggers are skipped.
   */
  pause(): void {
    this.paused = true;
  }

  /**
   * Resume — triggers start executing again.
   */
  resume(): void {
    this.paused = false;
    this.processQueue();
  }

  /**
   * Get scheduler status for the /status endpoint.
   */
  getStatus(): SchedulerStatus {
    const runningSessions = this.sessionManager.listRunningSessions();
    return {
      running: this.running,
      paused: this.paused,
      jobCount: this.jobs.length,
      enabledJobs: this.jobs.filter(j => j.enabled).length,
      queueLength: this.queue.length,
      activeJobSessions: runningSessions.filter(s => s.jobSlug).length,
    };
  }

  /**
   * Get loaded job definitions (for /jobs endpoint).
   */
  getJobs(): JobDefinition[] {
    return this.jobs;
  }

  /**
   * Get the current queue.
   */
  getQueue(): QueuedJob[] {
    return [...this.queue];
  }

  /**
   * Get the skip ledger instance (for API routes).
   */
  getSkipLedger(): SkipLedger {
    return this.skipLedger;
  }

  private enqueue(slug: string, reason: string): void {
    // Don't queue duplicates
    if (this.queue.some(q => q.slug === slug)) return;

    // Cap queue size to prevent unbounded growth
    if (this.queue.length >= 50) {
      console.warn(`[scheduler] Queue full (50 items), dropping enqueue for "${slug}"`);
      return;
    }

    this.queue.push({ slug, reason, queuedAt: new Date().toISOString() });

    // Sort by priority — critical first
    this.queue.sort((a, b) => {
      const jobA = this.jobs.find(j => j.slug === a.slug);
      const jobB = this.jobs.find(j => j.slug === b.slug);
      return (PRIORITY_ORDER[jobA?.priority ?? 'low']) - (PRIORITY_ORDER[jobB?.priority ?? 'low']);
    });
  }

  private spawnJobSession(job: JobDefinition, reason: string): void {
    const prompt = this.buildPrompt(job);
    const sessionName = `job-${job.slug}-${Date.now().toString(36)}`;

    // Check for gate-written model escalation (e.g., git-sync severity)
    const model = this.resolveModelTier(job);

    // Write active-job.json BEFORE spawning so the session-start and
    // compaction-recovery hooks can inject job-specific grounding context.
    this.state.set('active-job', {
      slug: job.slug,
      name: job.name,
      description: job.description,
      priority: job.priority,
      sessionName,
      triggeredBy: reason,
      startedAt: new Date().toISOString(),
      grounding: job.grounding ?? null,
    });

    this.sessionManager.spawnSession({
      name: sessionName,
      prompt,
      model,
      jobSlug: job.slug,
      triggeredBy: `scheduler:${reason}`,
      maxDurationMinutes: job.expectedDurationMinutes,
    }).then(() => {
      // Update job state on successful spawn (clear error, set pending result)
      const jobState: JobState = {
        slug: job.slug,
        lastRun: new Date().toISOString(),
        lastResult: 'pending',
        lastError: undefined,
        consecutiveFailures: 0,
        nextScheduled: this.getNextRun(job.slug),
      };
      this.state.saveJobState(jobState);

      this.state.appendEvent({
        type: 'job_triggered',
        summary: `Job "${job.slug}" triggered (${reason})`,
        sessionId: sessionName,
        timestamp: new Date().toISOString(),
        metadata: { slug: job.slug, reason, model: job.model },
      });
    }).catch((err) => {
      // Track failure with error message
      const failures = this.getConsecutiveFailures(job.slug) + 1;
      const errorMsg = err instanceof Error ? err.message : String(err);
      const jobState: JobState = {
        slug: job.slug,
        lastRun: new Date().toISOString(),
        lastResult: 'failure',
        lastError: errorMsg,
        consecutiveFailures: failures,
        nextScheduled: this.getNextRun(job.slug),
      };
      this.state.saveJobState(jobState);

      this.state.appendEvent({
        type: 'job_error',
        summary: `Job "${job.slug}" failed to spawn: ${errorMsg}`,
        timestamp: new Date().toISOString(),
        metadata: { slug: job.slug, consecutiveFailures: failures },
      });

      this.alertOnConsecutiveFailures(job, failures, errorMsg);
    });
  }

  /**
   * Resolve the model tier for a job. Normally uses the job's configured model,
   * but gates can write a severity file to escalate the model for complex work.
   *
   * The git-sync gate writes to /tmp/instar-git-sync-severity:
   * - "clean" → use configured model (haiku)
   * - "state" → escalate to sonnet (structured conflict resolution)
   * - "code"  → escalate to opus (semantic code merge)
   */
  private resolveModelTier(job: JobDefinition): typeof job.model {
    if (job.slug === 'git-sync') {
      try {
        const severity = fs.readFileSync('/tmp/instar-git-sync-severity', 'utf-8').trim();
        if (severity === 'code') return 'opus';
        if (severity === 'state') return 'sonnet';
      } catch {
        // @silent-fallback-ok — severity file missing, use default model
      }
    }
    return job.model;
  }

  private buildPrompt(job: JobDefinition): string {
    switch (job.execute.type) {
      case 'skill':
        return `/${job.execute.value}${job.execute.args ? ' ' + job.execute.args : ''}`;
      case 'prompt':
        return job.execute.value;
      case 'script':
        return `Run this script: ${job.execute.value}${job.execute.args ? ' ' + job.execute.args : ''}`;
    }
  }

  private getConsecutiveFailures(slug: string): number {
    return this.state.getJobState(slug)?.consecutiveFailures ?? 0;
  }

  private getNextRun(slug: string): string | undefined {
    const task = this.cronTasks.get(slug);
    if (!task) return undefined;
    const next = task.nextRun();
    return next ? next.toISOString() : undefined;
  }

  /**
   * Called when a job's session completes. Updates job state and notifies via messenger.
   */
  async notifyJobComplete(sessionId: string, tmuxSession: string): Promise<void> {
    // Find which job this session belongs to by looking up session state
    const session = this.state.getSession(sessionId);
    if (!session?.jobSlug) return;

    const job = this.jobs.find(j => j.slug === session.jobSlug);
    if (!job) return;

    // Update job state with completion result
    const failed = session.status === 'failed' || session.status === 'killed';

    // Signal claim completion (Phase 4C — Gap 5)
    if (this.claimManager) {
      this.claimManager.completeClaim(job.slug, failed ? 'failure' : 'success').catch(err => {
        console.error(`[scheduler] Failed to broadcast claim completion for "${job.slug}": ${err}`);
      });
    }

    // Clear active-job.json now that the job is done
    const activeJob = this.state.get<{ slug: string }>('active-job');
    if (activeJob?.slug === job.slug) {
      this.state.delete('active-job');
    }
    const existingState = this.state.getJobState(job.slug);
    const jobState: JobState = {
      slug: job.slug,
      lastRun: existingState?.lastRun ?? new Date().toISOString(),
      lastResult: failed ? 'failure' : 'success',
      lastError: failed ? `Session ${session.status} (${session.name})` : undefined,
      consecutiveFailures: failed ? (existingState?.consecutiveFailures ?? 0) + 1 : 0,
      nextScheduled: this.getNextRun(job.slug),
    };
    this.state.saveJobState(jobState);

    // Alert on consecutive failures
    if (failed && jobState.lastError) {
      this.alertOnConsecutiveFailures(job, jobState.consecutiveFailures, jobState.lastError);
    }

    // Try to drain the queue now that a slot is available
    this.processQueue();

    // Skip notifications if no messaging configured or job opted out
    if (!this.messenger && !this.telegram) return;
    if (job.telegramNotify === false) return;

    // Capture the last output from the tmux session
    let output = '';
    try {
      output = this.sessionManager.captureOutput(tmuxSession) ?? '';
    } catch {
      // Session may already be dead — that's fine
    }

    // Classify death cause if session failed/was killed
    let deathCause: string | undefined;
    if (failed && output) {
      const quotaState = this.quotaTracker?.getState() ?? null;
      const classification = classifySessionDeath(output, quotaState);
      deathCause = classification.cause;

      this.state.appendEvent({
        type: 'session_death_classified',
        summary: `Session for "${job.slug}" classified as ${classification.cause} (${classification.confidence}): ${classification.detail}`,
        timestamp: new Date().toISOString(),
        metadata: {
          slug: job.slug,
          cause: classification.cause,
          confidence: classification.confidence,
          detail: classification.detail,
        },
      });
    }

    // Build a summary message
    const duration = session.startedAt
      ? Math.round((Date.now() - new Date(session.startedAt).getTime()) / 1000)
      : 0;

    const durationStr = duration > 60
      ? `${Math.floor(duration / 60)}m ${duration % 60}s`
      : `${duration}s`;

    let summary = `*Job Complete: ${job.name}*\n`;
    summary += `Status: ${failed ? 'Failed' : 'Done'}`;
    if (deathCause && deathCause !== 'unknown') summary += ` (${deathCause})`;
    summary += '\n';
    if (duration > 0) summary += `Duration: ${durationStr}\n`;

    if (output) {
      // Trim to last ~500 chars to keep the message readable
      const trimmed = output.length > 500
        ? '...' + output.slice(-500)
        : output;
      summary += `\n\`\`\`\n${trimmed}\n\`\`\``;
    } else {
      summary += '\n_No output captured (session already closed)_';
    }

    // Skip Telegram notification for jobs with no meaningful output — applies regardless of status.
    // Failure alerts are already handled by alertOnConsecutiveFailures above.
    // Prevents "No output captured (session already closed)" spam on every failed cycle.
    if (!output || !output.trim()) {
      console.log(`[scheduler] Skipping notification for ${job.slug} — no meaningful output`);
      return;
    }

    // Send to the job's dedicated topic if available, otherwise fall back to generic messenger
    if (this.telegram && job.topicId) {
      try {
        await this.telegram.sendToTopic(job.topicId, summary);
      } catch (err) {
        console.error(`[scheduler] Failed to send to job topic ${job.topicId}: ${err}`);
        // Topic may have been deleted — try to recreate
        try {
          const newTopic = await this.telegram.findOrCreateForumTopic(
            `${TOPIC_STYLE.JOB.emoji} Job: ${job.name}`,
            TOPIC_STYLE.JOB.color,
          );
          job.topicId = newTopic.topicId;
          this.saveJobTopicMapping(job.slug, newTopic.topicId);
          await this.telegram.sendToTopic(newTopic.topicId, summary);
        } catch (recreateErr) {
          console.error(`[scheduler] Failed to recreate topic for ${job.slug}: ${recreateErr}`);
        }
      }
    } else if (this.messenger) {
      try {
        await this.messenger.send({
          userId: 'system',
          content: summary,
        });
      } catch (err) {
        console.error(`[scheduler] Failed to send job notification: ${err}`);
      }
    }
  }

  /**
   * Ensure every enabled job has a Telegram topic.
   * Creates topics for jobs that don't have one.
   * This is the "job-topic coupling" — every job lives in a topic.
   */
  private async ensureJobTopics(enabledJobs: JobDefinition[]): Promise<void> {
    if (!this.telegram) return;

    // Load existing topic mappings
    const mappings = this.state.get<Record<string, number>>('job-topic-mappings') ?? {};

    for (const job of enabledJobs) {
      // Opt-out: skip topic creation entirely when telegramNotify is explicitly false
      if (job.telegramNotify === false) continue;

      // If job already has a topicId (from jobs.json or previous mapping), use it
      if (job.topicId) {
        mappings[job.slug] = job.topicId;
        continue;
      }

      // Check if we have a saved mapping
      if (mappings[job.slug]) {
        job.topicId = mappings[job.slug];
        continue;
      }

      // Create a new topic for this job
      try {
        const topic = await this.telegram.findOrCreateForumTopic(
          `${TOPIC_STYLE.JOB.emoji} Job: ${job.name}`,
          TOPIC_STYLE.JOB.color,
        );
        job.topicId = topic.topicId;
        mappings[job.slug] = topic.topicId;

        await this.telegram.sendToTopic(topic.topicId,
          `*${job.name}*\n${job.description}\n\nSchedule: \`${job.schedule}\`\nPriority: ${job.priority}\n\nThis topic is the home for this job. Reports, status updates, and errors will appear here.`
        );
      } catch (err) {
        console.error(`[scheduler] Failed to create topic for job ${job.slug}: ${err}`);
      }
    }

    this.state.set('job-topic-mappings', mappings);
  }

  /**
   * Save a job-topic mapping (used when recreating a deleted topic).
   */
  private saveJobTopicMapping(slug: string, topicId: number): void {
    const mappings = this.state.get<Record<string, number>>('job-topic-mappings') ?? {};
    mappings[slug] = topicId;
    this.state.set('job-topic-mappings', mappings);
  }

  /**
   * Run a job's gate command. Returns true if the job should proceed, false to skip.
   * Gates are zero-token pre-screening — a bash command that exits 0 (proceed) or non-zero (skip).
   */
  private runGate(job: JobDefinition): boolean {
    try {
      execFileSync('/bin/sh', ['-c', job.gate!], {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      // @silent-fallback-ok — gate command non-zero exit means skip
      this.state.appendEvent({
        type: 'job_gate_skip',
        summary: `Job "${job.slug}" skipped — gate check returned nothing to do`,
        timestamp: new Date().toISOString(),
        metadata: { slug: job.slug },
      });
      return false;
    }
  }

  /**
   * Alert when a job hits consecutive failure thresholds.
   * Critical/high priority jobs alert after 2 failures.
   * Medium/low priority jobs alert after 3 failures.
   * Only alerts at the threshold (not every failure after).
   *
   * When the failure is a session limit issue (not a job execution error),
   * the notification is reframed as "Job Blocked" with intelligent diagnostics:
   * running session list with ages, stale session flags, memory pressure,
   * and actionable suggestions.
   */
  private alertOnConsecutiveFailures(job: JobDefinition, failures: number, error: string): void {
    const threshold = (job.priority === 'critical' || job.priority === 'high') ? 2 : 3;
    if (failures !== threshold) return;

    const isSessionBlocked = error.includes('Max sessions') && error.includes('reached');

    let alertText: string;

    if (isSessionBlocked) {
      alertText = this.buildSessionBlockedAlert(job, failures, error);
    } else {
      alertText = `*Job Alert: ${job.name}*\n\n${failures} consecutive failures.\nLast error: ${error}\nPriority: ${job.priority}`;
    }

    // Send to job's topic if available
    if (this.telegram && job.topicId) {
      this.telegram.sendToTopic(job.topicId, alertText).catch(err => {
        console.error(`[scheduler] Failed to send failure alert: ${err}`);
      });
    } else if (this.messenger) {
      this.messenger.send({ userId: 'system', content: alertText }).catch(err => {
        console.error(`[scheduler] Failed to send failure alert: ${err}`);
      });
    }
  }

  /**
   * Build an intelligent "Job Blocked" notification when a job can't start
   * because all session slots are occupied. Includes session diagnostics,
   * staleness detection, memory pressure, and actionable suggestions.
   */
  private buildSessionBlockedAlert(job: JobDefinition, failures: number, error: string): string {
    const diagnostics = this.sessionManager.getSessionDiagnostics();

    const lines: string[] = [];
    lines.push(`*Job Blocked: ${job.name}*`);
    lines.push('');
    lines.push(`Could not start — all ${diagnostics.maxSessions} session slots are in use.`);
    lines.push(`(${failures} consecutive attempts blocked)`);
    lines.push('');

    // Session list with ages
    lines.push('*Running sessions:*');
    for (const s of diagnostics.sessions) {
      const age = s.ageMinutes >= 60
        ? `${Math.floor(s.ageMinutes / 60)}h ${s.ageMinutes % 60}m`
        : `${s.ageMinutes}m`;
      const staleFlag = s.isStale ? ' ⚠️' : '';
      const jobTag = s.jobSlug ? ` (${s.jobSlug})` : '';
      lines.push(`• ${s.name}${jobTag} — ${age}${staleFlag}`);
      if (s.staleReason) {
        lines.push(`  └ ${s.staleReason}`);
      }
    }
    lines.push('');

    // Memory pressure
    const memEmoji = diagnostics.memoryPressure === 'critical' ? '🔴'
      : diagnostics.memoryPressure === 'high' ? '🟠'
      : diagnostics.memoryPressure === 'moderate' ? '🟡'
      : '🟢';
    lines.push(`Memory: ${memEmoji} ${diagnostics.memoryUsedPercent}% used (${diagnostics.freeMemoryMB} MB free)`);
    lines.push('');

    // Suggestions
    if (diagnostics.suggestions.length > 0) {
      lines.push('*Suggestions:*');
      for (const suggestion of diagnostics.suggestions) {
        lines.push(`→ ${suggestion}`);
      }
    }

    return lines.join('\n');
  }

  private checkMissedJobs(enabledJobs: JobDefinition[]): void {
    const now = Date.now();

    for (const job of enabledJobs) {
      const jobState = this.state.getJobState(job.slug);
      if (!jobState?.lastRun) continue;

      const lastRun = new Date(jobState.lastRun).getTime();
      const task = this.cronTasks.get(job.slug);
      if (!task) continue;

      // Get expected interval from next two runs
      const nextRun = task.nextRun();
      const nextNextRun = task.nextRuns(2)[1];
      if (!nextRun || !nextNextRun) continue;

      const intervalMs = nextNextRun.getTime() - nextRun.getTime();
      const timeSinceLastRun = now - lastRun;

      // If overdue by more than 1.5x the interval, trigger immediately
      if (timeSinceLastRun > intervalMs * 1.5) {
        this.triggerJob(job.slug, 'missed');
      }
    }
  }
}
