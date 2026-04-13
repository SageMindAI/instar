/**
 * CrashLoopPauser — detect jobs in crash-loop and auto-pause them.
 *
 * Cross-pollinated from Dawn's crash-loop-pauser (infrastructure-auto-fixer
 * Tier 0.5h). Stops runaway compute waste and signal pollution when a job
 * keeps crashing while root cause is investigated.
 *
 * Rationale: duration bumps and scope guards don't fix tool_use_incomplete,
 * API overload, or import errors. Those are different failure modes.
 * Pausing is NOT giving up — it's stopping the bleeding so the diagnosis
 * can happen without noise.
 *
 * Criteria (ANY triggers pause):
 *   - 3+ non-timeout failures in 24h (failure / spawn-error)
 *   - 5+ short-duration runs (<60s) in 24h — bootstrap crash signature
 *
 * Safety rails:
 *   - Never pauses priority=critical jobs
 *   - Never pauses jobs in the NEVER_PAUSE deny-list
 *   - Never pauses jobs already disabled
 *   - Dry-run mode by default — caller must opt-in to mutate
 */

import fs from 'node:fs';
import path from 'node:path';
import { JobRunHistory } from '../scheduler/JobRunHistory.js';
import type { JobDefinition } from '../core/types.js';

export interface CrashLoopCandidate {
  slug: string;
  reason: 'failures' | 'short-runs';
  failureCount: number;
  shortRunCount: number;
  evidence: {
    recentRunIds: string[];
    lastError?: string;
    windowHours: number;
  };
}

export interface CrashLoopPauseResult {
  candidates: CrashLoopCandidate[];
  paused: string[];
  skipped: Array<{ slug: string; reason: string }>;
  dryRun: boolean;
}

export interface CrashLoopPauserOptions {
  /** Jobs never auto-paused (observation layer, supervisors, etc.) */
  neverPause?: Set<string>;
  /** Window to look back for failures (hours). Default: 24 */
  windowHours?: number;
  /** Failures threshold (non-timeout). Default: 3 */
  failureThreshold?: number;
  /** Short-run threshold. Default: 5 */
  shortRunThreshold?: number;
  /** Max duration (seconds) considered a short/bootstrap-crash run. Default: 60 */
  shortRunMaxSeconds?: number;
}

const DEFAULT_NEVER_PAUSE = new Set<string>([
  'infrastructure-auto-fixer',
  'orphan-reaper',
  'session-reaper',
]);

export class CrashLoopPauser {
  private history: JobRunHistory;
  private neverPause: Set<string>;
  private windowHours: number;
  private failureThreshold: number;
  private shortRunThreshold: number;
  private shortRunMaxSeconds: number;

  constructor(history: JobRunHistory, opts: CrashLoopPauserOptions = {}) {
    this.history = history;
    this.neverPause = opts.neverPause ?? DEFAULT_NEVER_PAUSE;
    this.windowHours = opts.windowHours ?? 24;
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.shortRunThreshold = opts.shortRunThreshold ?? 5;
    this.shortRunMaxSeconds = opts.shortRunMaxSeconds ?? 60;
  }

  /**
   * Evaluate all jobs and return crash-loop candidates.
   */
  evaluate(jobs: JobDefinition[]): CrashLoopCandidate[] {
    const candidates: CrashLoopCandidate[] = [];
    for (const job of jobs) {
      if (!job.enabled) continue;
      if (job.priority === 'critical') continue;
      if (this.neverPause.has(job.slug)) continue;

      const { runs } = this.history.query({
        slug: job.slug,
        sinceHours: this.windowHours,
        limit: 1000,
      });

      const failures = runs.filter(
        (r) => r.result === 'failure' || r.result === 'spawn-error',
      );
      const shortRuns = runs.filter(
        (r) =>
          (r.result === 'failure' || r.result === 'spawn-error') &&
          typeof r.durationSeconds === 'number' &&
          r.durationSeconds < this.shortRunMaxSeconds,
      );

      let reason: CrashLoopCandidate['reason'] | null = null;
      if (failures.length >= this.failureThreshold) reason = 'failures';
      else if (shortRuns.length >= this.shortRunThreshold) reason = 'short-runs';
      if (!reason) continue;

      const lastError = failures[0]?.error;
      candidates.push({
        slug: job.slug,
        reason,
        failureCount: failures.length,
        shortRunCount: shortRuns.length,
        evidence: {
          recentRunIds: failures.slice(0, 5).map((r) => r.runId),
          lastError,
          windowHours: this.windowHours,
        },
      });
    }
    return candidates;
  }

  /**
   * Evaluate and optionally pause candidates by rewriting jobs.json.
   * Writes a `_crashPauseNote` onto each paused job so operators have
   * provenance for why the job was disabled.
   */
  run(opts: {
    jobs: JobDefinition[];
    jobsFile: string;
    dryRun?: boolean;
  }): CrashLoopPauseResult {
    const dryRun = opts.dryRun ?? true;
    const candidates = this.evaluate(opts.jobs);
    const skipped: Array<{ slug: string; reason: string }> = [];

    if (dryRun || candidates.length === 0) {
      return { candidates, paused: [], skipped, dryRun };
    }

    const raw = JSON.parse(fs.readFileSync(opts.jobsFile, 'utf-8')) as {
      jobs: Array<Record<string, unknown>>;
    };
    if (!Array.isArray(raw.jobs)) {
      throw new Error(
        `CrashLoopPauser: jobs file ${opts.jobsFile} missing 'jobs' array`,
      );
    }

    const paused: string[] = [];
    const candidateBySlug = new Map(candidates.map((c) => [c.slug, c]));
    const now = new Date().toISOString();

    for (const entry of raw.jobs) {
      const slug = entry.slug as string | undefined;
      if (!slug) continue;
      const c = candidateBySlug.get(slug);
      if (!c) continue;
      if (entry.enabled === false) {
        skipped.push({ slug, reason: 'already-disabled' });
        continue;
      }
      entry.enabled = false;
      entry._crashPauseNote = {
        pausedAt: now,
        reason: c.reason,
        failureCount: c.failureCount,
        shortRunCount: c.shortRunCount,
        windowHours: c.evidence.windowHours,
        lastError: c.evidence.lastError,
        recentRunIds: c.evidence.recentRunIds,
      };
      paused.push(slug);
    }

    const tmp = `${opts.jobsFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, opts.jobsFile);
    // Keep a sibling audit trail
    const auditPath = path.join(
      path.dirname(opts.jobsFile),
      'crash-loop-pauses.jsonl',
    );
    for (const slug of paused) {
      const c = candidateBySlug.get(slug)!;
      fs.appendFileSync(
        auditPath,
        JSON.stringify({ pausedAt: now, ...c }) + '\n',
        'utf-8',
      );
    }

    return { candidates, paused, skipped, dryRun };
  }
}
