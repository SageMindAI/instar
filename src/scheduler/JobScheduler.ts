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
import { loadJobs } from './JobLoader.js';
import type { SessionManager } from '../core/SessionManager.js';
import type { StateManager } from '../core/StateManager.js';
import type { MessagingAdapter } from '../core/types.js';
import type { JobDefinition, JobSchedulerConfig, JobState, JobPriority } from '../core/types.js';
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';

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

  constructor(
    config: JobSchedulerConfig,
    sessionManager: SessionManager,
    state: StateManager,
  ) {
    this.config = config;
    this.sessionManager = sessionManager;
    this.state = state;
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
      const task = new Cron(job.schedule, () => {
        this.triggerJob(job.slug, 'scheduled');
      });
      this.cronTasks.set(job.slug, task);
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
   * Trigger a job by slug. Checks quota, session limits, queues if at capacity.
   */
  triggerJob(slug: string, reason: string): 'triggered' | 'queued' | 'skipped' {
    const job = this.jobs.find(j => j.slug === slug);
    if (!job) {
      throw new Error(`Unknown job: ${slug}`);
    }

    if (this.paused) {
      return 'skipped';
    }

    if (!this.canRunJob(job.priority)) {
      this.state.appendEvent({
        type: 'job_skipped',
        summary: `Job "${slug}" skipped — quota check failed`,
        timestamp: new Date().toISOString(),
        metadata: { slug, reason, priority: job.priority },
      });
      return 'skipped';
    }

    // Check session capacity
    const runningSessions = this.sessionManager.listRunningSessions();
    const jobSessions = runningSessions.filter(s => s.jobSlug);
    if (jobSessions.length >= this.config.maxParallelJobs) {
      this.enqueue(slug, reason);
      return 'queued';
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

  private enqueue(slug: string, reason: string): void {
    // Don't queue duplicates
    if (this.queue.some(q => q.slug === slug)) return;

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

    this.sessionManager.spawnSession({
      name: sessionName,
      prompt,
      model: job.model,
      jobSlug: job.slug,
      triggeredBy: `scheduler:${reason}`,
      maxDurationMinutes: job.expectedDurationMinutes,
    }).then(() => {
      // Update job state on success
      const jobState: JobState = {
        slug: job.slug,
        lastRun: new Date().toISOString(),
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
      // Track failure
      const failures = this.getConsecutiveFailures(job.slug) + 1;
      const jobState: JobState = {
        slug: job.slug,
        lastRun: new Date().toISOString(),
        lastResult: 'failure',
        consecutiveFailures: failures,
        nextScheduled: this.getNextRun(job.slug),
      };
      this.state.saveJobState(jobState);

      this.state.appendEvent({
        type: 'job_error',
        summary: `Job "${job.slug}" failed to spawn: ${err}`,
        timestamp: new Date().toISOString(),
        metadata: { slug: job.slug, consecutiveFailures: failures },
      });
    });
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
   * Called when a job's session completes. Captures output and notifies via messenger.
   */
  async notifyJobComplete(sessionId: string, tmuxSession: string): Promise<void> {
    if (!this.messenger && !this.telegram) return;

    // Find which job this session belongs to by looking up session state
    const session = this.state.getSession(sessionId);
    if (!session?.jobSlug) return;

    const job = this.jobs.find(j => j.slug === session.jobSlug);
    if (!job) return;

    // Capture the last output from the tmux session
    let output = '';
    try {
      output = this.sessionManager.captureOutput(tmuxSession) ?? '';
    } catch {
      // Session may already be dead — that's fine
    }

    // Build a summary message
    const duration = session.startedAt
      ? Math.round((Date.now() - new Date(session.startedAt).getTime()) / 1000)
      : 0;

    const durationStr = duration > 60
      ? `${Math.floor(duration / 60)}m ${duration % 60}s`
      : `${duration}s`;

    let summary = `*Job Complete: ${job.name}*\n`;
    summary += `Status: ${session.status === 'failed' ? 'Failed' : 'Done'}\n`;
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

    // Try to drain the queue now that a slot is available
    this.processQueue();

    // Send to the job's dedicated topic if available, otherwise fall back to generic messenger
    if (this.telegram && job.topicId) {
      try {
        await this.telegram.sendToTopic(job.topicId, summary);
      } catch (err) {
        console.error(`[scheduler] Failed to send to job topic ${job.topicId}: ${err}`);
        // Topic may have been deleted — try to recreate
        try {
          const newTopic = await this.telegram.createForumTopic(
            `Job: ${job.name}`,
            7322096, // Blue for jobs
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
        const topic = await this.telegram.createForumTopic(
          `Job: ${job.name}`,
          7322096, // Blue for automated jobs
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
