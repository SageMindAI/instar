/**
 * `instar job add|list|handoff` — Manage scheduled jobs.
 */

import fs from 'node:fs';
import pc from 'picocolors';
import { loadConfig, ensureStateDir } from '../core/Config.js';
import { loadJobs, validateJob } from '../scheduler/JobLoader.js';
import { JobRunHistory } from '../scheduler/JobRunHistory.js';
import { StateManager } from '../core/StateManager.js';
import type { JobDefinition, JobPriority, ModelTier } from '../core/types.js';

interface JobAddOptions {
  slug: string;
  name: string;
  schedule: string;
  description?: string;
  priority?: string;
  model?: string;
  type?: string;
  execute?: string;
  enabled?: boolean;
}

export async function addJob(options: JobAddOptions): Promise<void> {
  const config = loadConfig();
  ensureStateDir(config.stateDir);

  const jobsFile = config.scheduler.jobsFile;
  let jobs: JobDefinition[] = [];

  if (fs.existsSync(jobsFile)) {
    jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf-8'));
  }

  // Check for duplicate slug
  if (jobs.some(j => j.slug === options.slug)) {
    console.log(pc.red(`Job with slug "${options.slug}" already exists.`));
    process.exit(1);
  }

  const newJob: JobDefinition = {
    slug: options.slug,
    name: options.name,
    description: options.description || options.name,
    schedule: options.schedule,
    priority: (options.priority || 'medium') as JobPriority,
    expectedDurationMinutes: 5,
    model: (options.model || 'opus') as ModelTier,
    enabled: options.enabled !== false,
    execute: {
      type: (options.type || 'prompt') as 'skill' | 'prompt' | 'script',
      value: options.execute || `Run the ${options.name} job`,
    },
  };

  // Validate before saving
  try {
    validateJob(newJob);
  } catch (err) {
    console.log(pc.red(`Invalid job: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  jobs.push(newJob);
  // Atomic write: unique temp filename prevents concurrent corruption
  const tmpPath = `${jobsFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(jobs, null, 2));
    fs.renameSync(tmpPath, jobsFile);
  } catch (err) {
    // safe-git-allow: incremental-migration
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  console.log(pc.green(`Job "${options.name}" (${options.slug}) added.`));
  console.log(`  Schedule: ${options.schedule}`);
  console.log(`  Priority: ${newJob.priority}`);
  console.log(`  Model:    ${newJob.model}`);
}

export async function listJobs(_options: { dir?: string }): Promise<void> {
  const config = loadConfig();

  let jobs: JobDefinition[];
  try {
    jobs = loadJobs(config.scheduler.jobsFile);
  } catch {
    console.log(pc.dim('No jobs configured.'));
    console.log(`Add one: ${pc.cyan("instar job add --slug health-check --name 'Health Check' --schedule '0 */4 * * *'")}`);
    return;
  }

  if (jobs.length === 0) {
    console.log(pc.dim('No jobs configured.'));
    return;
  }

  const state = new StateManager(config.stateDir);
  const enabled = jobs.filter(j => j.enabled);

  console.log(pc.bold(`Jobs (${enabled.length} enabled / ${jobs.length} total):\n`));

  for (const job of jobs) {
    const icon = job.enabled ? pc.green('●') : pc.dim('○');
    const jobState = state.getJobState(job.slug);
    const lastRun = jobState?.lastRun
      ? new Date(jobState.lastRun).toLocaleString()
      : pc.dim('never');
    const failures = jobState?.consecutiveFailures
      ? pc.red(` (${jobState.consecutiveFailures} failures)`)
      : '';

    console.log(`  ${icon} ${pc.bold(job.slug)} — ${job.name}`);
    console.log(`    Schedule: ${job.schedule} | Priority: ${job.priority} | Model: ${job.model}`);
    console.log(`    Last run: ${lastRun}${failures}`);
    console.log(`    Execute:  ${job.execute.type}:${job.execute.value}`);
  }
}

/**
 * Show job run history with handoff notes.
 */
export async function jobHistory(
  slug: string | undefined,
  options: { limit?: number; handoffOnly?: boolean; dir?: string },
): Promise<void> {
  const config = loadConfig();
  ensureStateDir(config.stateDir);

  const history = new JobRunHistory(config.stateDir);
  const limit = options.limit ?? 10;

  const { runs, total } = history.query({ slug, limit: limit * 2 }); // over-fetch for handoff filter

  let filtered = runs;
  if (options.handoffOnly) {
    filtered = runs.filter(r => r.handoffNotes);
  }
  filtered = filtered.slice(0, limit);

  if (filtered.length === 0) {
    console.log(pc.dim(slug ? `No runs found for "${slug}".` : 'No job runs recorded yet.'));
    return;
  }

  console.log(pc.bold(`Job Run History${slug ? ` — ${slug}` : ''} (${filtered.length} of ${total} total)\n`));

  for (const run of filtered) {
    const resultColor = run.result === 'success' ? pc.green : run.result === 'failure' ? pc.red : pc.yellow;
    const duration = run.durationSeconds ? `${Math.round(run.durationSeconds / 60)}m` : '?';

    console.log(`  ${resultColor(run.result.padEnd(8))} ${pc.bold(run.slug)} — ${run.sessionId}`);
    console.log(`    ${pc.dim(run.startedAt)} | ${duration} | trigger: ${run.trigger}`);

    if (run.handoffNotes) {
      const preview = run.handoffNotes.length > 120
        ? run.handoffNotes.slice(0, 120) + '...'
        : run.handoffNotes;
      console.log(`    ${pc.cyan('handoff:')} ${preview}`);
    }

    if (run.reflection?.summary) {
      const preview = run.reflection.summary.length > 100
        ? run.reflection.summary.slice(0, 100) + '...'
        : run.reflection.summary;
      console.log(`    ${pc.dim('reflect:')} ${preview}`);
    }

    console.log();
  }
}

/**
 * Show what the next execution of a job will inherit.
 */
export async function jobContinuity(slug: string): Promise<void> {
  const config = loadConfig();
  ensureStateDir(config.stateDir);

  const history = new JobRunHistory(config.stateDir);
  const handoff = history.getLastHandoff(slug);

  if (!handoff) {
    console.log(pc.dim(`No handoff notes found for "${slug}".`));
    console.log(pc.dim('The next execution will start fresh.'));
    return;
  }

  console.log(pc.bold(`Continuity for "${slug}"\n`));
  console.log(`  ${pc.dim('From session:')} ${handoff.fromSession}`);
  console.log(`  ${pc.dim('Completed:')}    ${handoff.completedAt}`);
  console.log(`  ${pc.dim('Run ID:')}       ${handoff.fromRunId}`);
  console.log();
  console.log(pc.cyan('  Handoff Notes:'));
  for (const line of handoff.handoffNotes.split('\n')) {
    console.log(`    ${line}`);
  }

  if (handoff.stateSnapshot) {
    console.log();
    console.log(pc.cyan('  State Snapshot:'));
    console.log(`    ${JSON.stringify(handoff.stateSnapshot, null, 2).split('\n').join('\n    ')}`);
  }

  console.log();
  console.log(pc.dim('This will be injected into the next execution\'s prompt.'));
}

/**
 * Write handoff notes for the next execution of a job.
 * Called by the agent at session end to leave context for the next run.
 */
export async function jobHandoff(
  slug: string,
  options: { notes: string; state?: string; runId?: string; dir?: string },
): Promise<void> {
  const config = loadConfig();
  ensureStateDir(config.stateDir);

  const history = new JobRunHistory(config.stateDir);

  // Parse state snapshot if provided
  let stateSnapshot: Record<string, unknown> | undefined;
  if (options.state) {
    try {
      stateSnapshot = JSON.parse(options.state);
    } catch {
      console.log(pc.red('Invalid JSON for --state'));
      process.exit(1);
    }
  }

  // Find the run ID — either specified or most recent for this slug
  let runId = options.runId;
  if (!runId) {
    const { runs } = history.query({ slug, limit: 1 });
    if (runs.length === 0) {
      console.log(pc.red(`No runs found for job "${slug}". Run the job first.`));
      process.exit(1);
    }
    runId = runs[0].runId;
  }

  history.recordHandoff(runId, options.notes, stateSnapshot);

  console.log(pc.green(`Handoff notes saved for job "${slug}" (run: ${runId})`));
  if (stateSnapshot) {
    console.log(pc.dim(`  State snapshot: ${Object.keys(stateSnapshot).length} keys`));
  }
  console.log(pc.dim('  These notes will be injected into the next execution\'s prompt.'));
}
