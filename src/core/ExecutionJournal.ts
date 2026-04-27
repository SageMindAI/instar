/**
 * ExecutionJournal — Step-level execution tracking for Living Skills (PROP-229).
 *
 * Records what actually happens during job execution at the action level,
 * enabling cross-execution pattern detection and data-driven evolution proposals.
 *
 * Storage: JSONL files at {stateDir}/state/execution-journal/{agentId}/{jobSlug}.jsonl
 * Pending: Per-session temp files at {stateDir}/state/execution-journal/_pending.{sessionId}.jsonl
 * Creation: Lazy — directories and files created on first write.
 *
 * Two capture mechanisms:
 * - Hook-captured (source: "hook"): PostToolUse hook logs significant commands. Authoritative.
 * - Agent-reported (source: "agent"): Agent calls CLI at completion. Advisory.
 */

import fs from 'node:fs';
import path from 'node:path';
import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';
import type {
  ExecutionRecord,
  ExecutionStep,
  ExecutionDeviation,
  PendingStep,
} from './types.js';

export interface ExecutionJournalStats {
  /** Total number of execution records */
  count: number;
  /** Number of successful runs */
  successCount: number;
  /** Number of failed runs */
  failureCount: number;
  /** Average duration in minutes (null if no duration data) */
  avgDurationMinutes: number | null;
  /** ISO timestamp of earliest record */
  earliest: string | null;
  /** ISO timestamp of latest record */
  latest: string | null;
}

/** Regex patterns for common secret formats to redact from commands */
const REDACT_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /Authorization:\s*[^\s"']*/gi,
  /(api[_-]?key|apikey|api_secret)\s*[:=]\s*\S+/gi,
  /(password|passwd|secret|token)\s*[:=]\s*\S+/gi,
  /sk-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /gho_[A-Za-z0-9]{36}/g,
  /xox[baprs]-[A-Za-z0-9\-]+/g,
  /AKIA[0-9A-Z]{16}/g,
];

const MAX_COMMAND_LENGTH = 500;
const DEFAULT_AGENT_ID = 'default';

export class ExecutionJournal {
  private baseDir: string;

  constructor(stateDir: string) {
    this.baseDir = path.join(stateDir, 'state', 'execution-journal');
  }

  /**
   * Append a pending step captured by the hook during live execution.
   * Written to _pending.{sessionId}.jsonl — one line per hook invocation.
   */
  appendPendingStep(step: PendingStep): void {
    const sanitized: PendingStep = {
      ...step,
      command: ExecutionJournal.sanitizeCommand(step.command),
    };

    const pendingFile = path.join(this.baseDir, `_pending.${step.sessionId}.jsonl`);
    this.ensureDir(this.baseDir);
    fs.appendFileSync(pendingFile, JSON.stringify(sanitized) + '\n');
  }

  /**
   * Finalize a session's pending steps into a full ExecutionRecord.
   * Reads _pending.{sessionId}.jsonl, computes deviations, writes to the job's journal,
   * and removes the pending file.
   *
   * Returns the finalized record, or null if no pending data exists.
   */
  finalizeSession(opts: {
    sessionId: string;
    jobSlug: string;
    agentId?: string;
    definedSteps?: string[];
    outcome: ExecutionRecord['outcome'];
    startedAt: string;
    agentReportedSteps?: ExecutionStep[];
  }): ExecutionRecord | null {
    const agentId = opts.agentId || DEFAULT_AGENT_ID;
    const pendingFile = path.join(this.baseDir, `_pending.${opts.sessionId}.jsonl`);

    // Read pending steps from hook
    const hookSteps = this.readPendingSteps(pendingFile);

    // Merge agent-reported steps if provided
    const allSteps = [...hookSteps];
    if (opts.agentReportedSteps) {
      for (const agentStep of opts.agentReportedSteps) {
        allSteps.push({ ...agentStep, source: 'agent' as const });
      }
    }

    // If no steps at all, still record the execution (it ran, just captured nothing)
    const definedSteps = opts.definedSteps || [];
    const deviations = this.computeDeviations(definedSteps, allSteps);

    const now = new Date();
    const startTime = new Date(opts.startedAt);
    const durationMinutes = (now.getTime() - startTime.getTime()) / (1000 * 60);

    const record: ExecutionRecord = {
      executionId: `exec-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${opts.sessionId.slice(-6)}`,
      jobSlug: opts.jobSlug,
      sessionId: opts.sessionId,
      agentId,
      timestamp: opts.startedAt,
      definedSteps,
      actualSteps: allSteps,
      deviations,
      outcome: opts.outcome,
      durationMinutes: Math.round(durationMinutes * 10) / 10,
      finalized: true,
    };

    // Write to the job's journal
    const journalFile = this.journalPath(agentId, opts.jobSlug);
    this.ensureDir(path.dirname(journalFile));
    maybeRotateJsonl(journalFile);
    fs.appendFileSync(journalFile, JSON.stringify(record) + '\n');

    // Clean up pending file
    this.removeSafe(pendingFile);

    return record;
  }

  /**
   * Read finalized execution records for a job (newest first).
   */
  read(jobSlug: string, opts?: {
    agentId?: string;
    days?: number;
    limit?: number;
  }): ExecutionRecord[] {
    const agentId = opts?.agentId || DEFAULT_AGENT_ID;
    const journalFile = this.journalPath(agentId, jobSlug);
    let entries = this.readJsonlFile<ExecutionRecord>(journalFile);

    if (opts?.days) {
      const cutoff = new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000).toISOString();
      entries = entries.filter(e => e.timestamp >= cutoff);
    }

    // Newest first
    entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    if (opts?.limit) {
      entries = entries.slice(0, opts.limit);
    }

    return entries;
  }

  /**
   * Aggregate statistics for a job's execution history.
   */
  stats(jobSlug: string, opts?: { agentId?: string; days?: number }): ExecutionJournalStats {
    const entries = this.read(jobSlug, { agentId: opts?.agentId, days: opts?.days });

    if (entries.length === 0) {
      return {
        count: 0,
        successCount: 0,
        failureCount: 0,
        avgDurationMinutes: null,
        earliest: null,
        latest: null,
      };
    }

    const durations = entries
      .map(e => e.durationMinutes)
      .filter((d): d is number => d != null);

    return {
      count: entries.length,
      successCount: entries.filter(e => e.outcome === 'success').length,
      failureCount: entries.filter(e => e.outcome === 'failure').length,
      avgDurationMinutes: durations.length > 0
        ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10
        : null,
      earliest: entries[entries.length - 1].timestamp,
      latest: entries[0].timestamp,
    };
  }

  /**
   * List all job slugs that have journal data for a given agent.
   */
  listJobs(agentId?: string): string[] {
    const agentDir = path.join(this.baseDir, agentId || DEFAULT_AGENT_ID);
    if (!fs.existsSync(agentDir)) return [];

    return fs.readdirSync(agentDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''))
      .sort();
  }

  /**
   * Delete pending steps file for a session (cleanup on unexpected completion).
   */
  clearPending(sessionId: string): void {
    const pendingFile = path.join(this.baseDir, `_pending.${sessionId}.jsonl`);
    this.removeSafe(pendingFile);
  }

  /**
   * Apply retention policy — prune entries older than maxDays.
   * Returns the number of entries removed.
   */
  applyRetention(jobSlug: string, agentId?: string, maxDays: number = 30): number {
    const aid = agentId || DEFAULT_AGENT_ID;
    const journalFile = this.journalPath(aid, jobSlug);
    const entries = this.readJsonlFile<ExecutionRecord>(journalFile);

    if (entries.length === 0) return 0;

    const cutoff = new Date(Date.now() - maxDays * 24 * 60 * 60 * 1000).toISOString();
    const kept = entries.filter(e => e.timestamp >= cutoff);
    const removed = entries.length - kept.length;

    if (removed > 0) {
      // Rewrite the file with only kept entries
      const content = kept.map(e => JSON.stringify(e)).join('\n') + (kept.length > 0 ? '\n' : '');
      fs.writeFileSync(journalFile, content);
    }

    return removed;
  }

  // ── Static Utilities ──────────────────────────────────────────────

  /**
   * Sanitize a command string by redacting common secret patterns.
   * Public static so the hook can also use this logic.
   */
  static sanitizeCommand(command: string): string {
    let sanitized = command;
    for (const pattern of REDACT_PATTERNS) {
      // Reset lastIndex for global patterns
      pattern.lastIndex = 0;
      sanitized = sanitized.replace(pattern, '[REDACTED]');
    }
    return sanitized.slice(0, MAX_COMMAND_LENGTH);
  }

  // ── Private Helpers ───────────────────────────────────────────────

  private journalPath(agentId: string, jobSlug: string): string {
    return path.join(this.baseDir, agentId, `${jobSlug}.jsonl`);
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private removeSafe(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        // safe-git-allow: incremental-migration
        fs.unlinkSync(filePath);
      }
    } catch {
      // @silent-fallback-ok — cleanup failure is non-critical
    }
  }

  private readPendingSteps(pendingFile: string): ExecutionStep[] {
    if (!fs.existsSync(pendingFile)) return [];

    const lines = this.readJsonlFile<PendingStep>(pendingFile);
    return lines.map(ps => ({
      step: ps.stepLabel || this.inferStepLabel(ps.command) || 'unknown',
      timestamp: ps.timestamp,
      source: 'hook' as const,
      command: ps.command,
    }));
  }

  private readJsonlFile<T>(filePath: string): T[] {
    if (!fs.existsSync(filePath)) return [];

    try {
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      if (!content) return [];

      return content.split('\n').map(line => {
        try {
          return JSON.parse(line) as T;
        } catch {
          // @silent-fallback-ok — skip corrupted JSONL lines
          return null;
        }
      }).filter(Boolean) as T[];
    } catch {
      return [];
    }
  }

  /**
   * Infer a human-readable step label from a command string.
   */
  private inferStepLabel(command: string): string | undefined {
    const patterns: Array<[RegExp, string]> = [
      [/\bcurl\b.*\/health/i, 'health-check'],
      [/\bcurl\b.*\/api/i, 'api-call'],
      [/\bcurl\b/i, 'http-request'],
      [/\bgit\s+push\b/i, 'git-push'],
      [/\bgit\s+pull\b/i, 'git-pull'],
      [/\bgit\s+commit\b/i, 'git-commit'],
      [/\bgit\s+clone\b/i, 'git-clone'],
      [/\bnpm\s+publish\b/i, 'npm-publish'],
      [/\bnpm\s+install\b/i, 'npm-install'],
      [/\bnpm\s+test\b/i, 'run-tests'],
      [/\bnpm\s+run\s+build\b/i, 'build'],
      [/\bpnpm\s+build\b/i, 'build'],
      [/\bdocker\b/i, 'docker'],
      [/\bprisma\b/i, 'database'],
      [/\bpsql\b/i, 'database'],
      [/\bdeploy\b/i, 'deploy'],
    ];

    for (const [regex, label] of patterns) {
      if (regex.test(command)) return label;
    }

    return undefined;
  }

  /**
   * Compute deviations between defined steps and actual steps.
   */
  private computeDeviations(
    definedSteps: string[],
    actualSteps: ExecutionStep[],
  ): ExecutionDeviation[] {
    const deviations: ExecutionDeviation[] = [];
    const actualStepNames = new Set(actualSteps.map(s => s.step));
    const definedSet = new Set(definedSteps);

    // Omissions: defined but not in actual
    for (const step of definedSteps) {
      if (!actualStepNames.has(step)) {
        deviations.push({ type: 'omission', step });
      }
    }

    // Additions: in actual but not defined
    for (const step of actualSteps) {
      if (!definedSet.has(step.step) && step.step !== 'unknown') {
        // Avoid duplicate addition entries for same step name
        if (!deviations.some(d => d.type === 'addition' && d.step === step.step)) {
          deviations.push({ type: 'addition', step: step.step });
        }
      }
    }

    return deviations;
  }
}
