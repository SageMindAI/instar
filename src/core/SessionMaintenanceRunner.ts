/**
 * SessionMaintenanceRunner — Lightweight housekeeping at session boundaries.
 *
 * Cross-pollinated from Dawn's Portal project (2026-04-09).
 * Dawn discovered that running cheap maintenance tasks at EVERY session boundary
 * keeps the system continuously healthy with minimal overhead per session.
 *
 * Design constraints:
 * - Must complete in <15 seconds total
 * - Must not fail loudly (session-end should always succeed)
 * - Fire-and-forget: if maintenance fails, the session still ends cleanly
 * - Produces a one-line summary for logs
 *
 * Current tasks:
 * 1. JSONL rotation — rotate oversized log files
 * 2. Stale execution journal trim — archive old execution entries
 *
 * Integration: SessionManager emits 'sessionComplete' → server wires this runner.
 */

import fs from 'node:fs';
import path from 'node:path';
import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';

export interface SessionMaintenanceConfig {
  /** The .instar state directory */
  stateDir: string;
  /** Max time for all tasks (ms). Default: 10000 */
  timeoutMs?: number;
  /** Max JSONL file size before rotation (bytes). Default: 5MB */
  jsonlMaxBytes?: number;
  /** Max age for execution journal entries (days). Default: 30 */
  executionJournalRetentionDays?: number;
}

export interface MaintenanceResult {
  tasksRun: string[];
  itemsProcessed: number;
  durationMs: number;
  summary: string;
}

export class SessionMaintenanceRunner {
  private readonly stateDir: string;
  private readonly timeoutMs: number;
  private readonly jsonlMaxBytes: number;
  private readonly retentionDays: number;

  constructor(config: SessionMaintenanceConfig) {
    this.stateDir = config.stateDir;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.jsonlMaxBytes = config.jsonlMaxBytes ?? 5 * 1024 * 1024; // 5MB
    this.retentionDays = config.executionJournalRetentionDays ?? 30;
  }

  /**
   * Run all maintenance tasks. Returns a summary.
   * Never throws — all errors are caught and logged.
   */
  async run(): Promise<MaintenanceResult> {
    const start = Date.now();
    const tasksRun: string[] = [];
    let itemsProcessed = 0;

    // Wrap in timeout
    const result = await Promise.race([
      this.runTasks(tasksRun, () => itemsProcessed++),
      new Promise<void>(resolve => setTimeout(resolve, this.timeoutMs)),
    ]);

    const durationMs = Date.now() - start;
    const summary = tasksRun.length > 0
      ? `Maintenance: ${tasksRun.join(', ')} (${itemsProcessed} items, ${durationMs}ms)`
      : `Maintenance: nothing needed (${durationMs}ms)`;

    return { tasksRun, itemsProcessed, durationMs, summary };
  }

  private async runTasks(tasksRun: string[], countItem: () => void): Promise<void> {
    // Task 1: Rotate oversized JSONL files
    try {
      const rotated = this.rotateJsonlFiles();
      if (rotated > 0) {
        tasksRun.push(`jsonl-rotation(${rotated})`);
        for (let i = 0; i < rotated; i++) countItem();
      }
    } catch (err) {
      console.error('[SessionMaintenance] JSONL rotation failed:', err);
    }

    // Task 2: Trim stale execution journal entries
    try {
      const trimmed = this.trimExecutionJournal();
      if (trimmed > 0) {
        tasksRun.push(`journal-trim(${trimmed})`);
        for (let i = 0; i < trimmed; i++) countItem();
      }
    } catch (err) {
      console.error('[SessionMaintenance] Journal trim failed:', err);
    }
  }

  /**
   * Rotate JSONL files that exceed the size limit.
   * Returns the number of files rotated.
   */
  private rotateJsonlFiles(): number {
    let rotated = 0;
    const jsonlFiles = [
      'platform-activity.jsonl',
      'hook-events.jsonl',
      'skill-telemetry.jsonl',
    ];

    for (const filename of jsonlFiles) {
      const filepath = path.join(this.stateDir, filename);
      try {
        if (!fs.existsSync(filepath)) continue;
        const stat = fs.statSync(filepath);
        if (stat.size > this.jsonlMaxBytes) {
          maybeRotateJsonl(filepath, { maxBytes: this.jsonlMaxBytes });
          rotated++;
        }
      } catch {
        // @silent-fallback-ok — rotation is best-effort
      }
    }

    return rotated;
  }

  /**
   * Remove execution journal entries older than retention period.
   * Returns the number of entries trimmed.
   */
  private trimExecutionJournal(): number {
    const journalPath = path.join(this.stateDir, 'execution-journal.jsonl');
    if (!fs.existsSync(journalPath)) return 0;

    try {
      const content = fs.readFileSync(journalPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      if (lines.length === 0) return 0;

      const cutoff = Date.now() - (this.retentionDays * 24 * 60 * 60 * 1000);
      const kept: string[] = [];
      let trimmed = 0;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const ts = new Date(entry.timestamp || entry.startedAt || entry.endedAt || 0).getTime();
          if (ts > cutoff) {
            kept.push(line);
          } else {
            trimmed++;
          }
        } catch {
          // Keep malformed lines (safer than discarding)
          kept.push(line);
        }
      }

      if (trimmed > 0) {
        fs.writeFileSync(journalPath, kept.join('\n') + '\n');
      }

      return trimmed;
    } catch {
      return 0;
    }
  }
}
