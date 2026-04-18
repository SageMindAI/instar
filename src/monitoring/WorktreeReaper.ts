/**
 * WorktreeReaper — daily orphan reaper consuming the state reconciliation matrix.
 *
 * Per PARALLEL-DEV-ISOLATION-SPEC.md "State reconciliation matrix" + "Daily orphan-reaper job".
 *
 * Two-phase: quarantine first, then delete after `quarantineGraceMs` (default 14d).
 * Walks BOTH `git worktree list --porcelain -z` AND `readdir(.instar/worktrees/)`
 * AND `.snapshots/`.
 *
 * Refuses to operate on worktrees with an active session lock (live heartbeat).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { WorktreeManager } from '../core/WorktreeManager.js';

const DEFAULT_QUARANTINE_GRACE_MS = 14 * 24 * 3600 * 1000; // 14 days
const DEFAULT_REAP_INTERVAL_MS = 24 * 3600 * 1000;

export interface WorktreeReaperConfig {
  projectDir: string;
  worktreesRoot: string;
  worktreeManager: WorktreeManager;
  quarantineGraceMs?: number;
  reapIntervalMs?: number;
  /** Disk budget (GB). When exceeded, LRU evict merged/abandoned bindings first. */
  diskBudgetGb?: number;
  /** When false, reaper logs but does not move/delete files. */
  dryRun?: boolean;
}

export interface ReapPassResult {
  ts: string;
  rowsConsidered: number;
  quarantined: string[];
  deleted: string[];
  externals: string[];
  skippedActive: string[];
  errors: Array<{ path: string; error: string }>;
}

export class WorktreeReaper extends EventEmitter {
  private config: Required<Omit<WorktreeReaperConfig, 'worktreeManager'>> & { worktreeManager: WorktreeManager };
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastResult: ReapPassResult | null = null;
  private quarantineDir: string;
  private snapshotsDir: string;

  constructor(config: WorktreeReaperConfig) {
    super();
    this.config = {
      ...config,
      quarantineGraceMs: config.quarantineGraceMs ?? DEFAULT_QUARANTINE_GRACE_MS,
      reapIntervalMs: config.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS,
      diskBudgetGb: config.diskBudgetGb ?? 12,
      dryRun: config.dryRun ?? false,
    };
    this.quarantineDir = path.join(this.config.worktreesRoot, '.quarantine');
    this.snapshotsDir = path.join(this.config.worktreesRoot, '.snapshots');
  }

  start(): void {
    if (this.interval) return;
    fs.mkdirSync(this.quarantineDir, { recursive: true });
    fs.mkdirSync(this.snapshotsDir, { recursive: true });

    this.interval = setInterval(() => {
      this.reap().catch((err) => this.emit('error', err));
    }, this.config.reapIntervalMs);
    if (this.interval.unref) this.interval.unref();
  }

  stop(): void {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  async reap(): Promise<ReapPassResult> {
    const result: ReapPassResult = {
      ts: new Date().toISOString(),
      rowsConsidered: 0,
      quarantined: [],
      deleted: [],
      externals: [],
      skippedActive: [],
      errors: [],
    };

    // Phase 1: matrix-driven decisions
    let rows: ReturnType<WorktreeManager['reconcile']>;
    try { rows = this.config.worktreeManager.reconcile(); }
    catch (err) {
      result.errors.push({ path: this.config.worktreesRoot, error: (err as Error).message });
      this.lastResult = result;
      return result;
    }
    result.rowsConsidered = rows.length;

    for (const row of rows) {
      const targetPath = row.fsPath ?? row.binding?.worktreePath ?? row.gitWorktree?.path;
      if (!targetPath) continue;

      // Skip if there's a live lock (in-flight session)
      if (row.binding && this.hasLiveLock(row.binding.worktreePath)) {
        result.skippedActive.push(targetPath);
        continue;
      }

      try {
        switch (row.action) {
          case 'normal':
            // No action
            break;
          case 'repair-worktree-add':
            this.tryRepairWorktree(row.binding!.worktreePath, row.binding!.branch);
            break;
          case 'quarantine-binding':
          case 'quarantine-orphan':
            const q = this.quarantine(targetPath);
            if (q) result.quarantined.push(q);
            break;
          case 'adopt-binding':
            // Detected fs+git worktree without binding — adoption is a server-only flow
            // (would need to synthesize the binding via WorktreeManager.resolve).
            // Logged; not auto-adopted to avoid silent privilege grants.
            this.emit('warn', `unbound worktree at ${targetPath}; skipping auto-adopt`);
            break;
          case 'adopt-external-alert-once':
            result.externals.push(targetPath);
            break;
          default:
            this.emit('warn', `unknown matrix action: ${row.action}`);
        }
      } catch (err) {
        result.errors.push({ path: targetPath, error: (err as Error).message });
      }
    }

    // Phase 2: graduate quarantined entries past `quarantineGraceMs` to delete
    const cutoffMs = Date.now() - this.config.quarantineGraceMs;
    if (fs.existsSync(this.quarantineDir)) {
      for (const ent of fs.readdirSync(this.quarantineDir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const p = path.join(this.quarantineDir, ent.name);
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs < cutoffMs) {
            if (this.config.dryRun) {
              result.deleted.push(`(dry-run) ${p}`);
            } else {
              fs.rmSync(p, { recursive: true, force: true });
              result.deleted.push(p);
            }
          }
        } catch (err) {
          result.errors.push({ path: p, error: (err as Error).message });
        }
      }
    }

    // Phase 3: snapshot retention (.snapshots/ files older than grace → delete)
    if (fs.existsSync(this.snapshotsDir)) {
      for (const ent of fs.readdirSync(this.snapshotsDir, { withFileTypes: true })) {
        if (!ent.isFile()) continue;
        const p = path.join(this.snapshotsDir, ent.name);
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs < cutoffMs) {
            if (this.config.dryRun) result.deleted.push(`(dry-run) ${p}`);
            else { fs.unlinkSync(p); result.deleted.push(p); }
          }
        } catch (err) {
          result.errors.push({ path: p, error: (err as Error).message });
        }
      }
    }

    this.lastResult = result;
    this.emit('reap', result);
    return result;
  }

  private hasLiveLock(worktreePath: string): boolean {
    const lock = this.config.worktreeManager.getLock(worktreePath);
    if (!lock) return false;
    const ageMs = Date.now() - new Date(lock.heartbeatAt).getTime();
    return ageMs < 60_000;
  }

  private quarantine(originalPath: string): string | null {
    if (this.config.dryRun) return `(dry-run) ${originalPath}`;
    if (!fs.existsSync(originalPath)) return null;
    const safeName = path.basename(originalPath).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
    const target = path.join(this.quarantineDir, `${safeName}-${Date.now()}`);
    try {
      fs.renameSync(originalPath, target);
      return target;
    } catch (err) {
      this.emit('warn', `quarantine failed for ${originalPath}: ${(err as Error).message}`);
      return null;
    }
  }

  private tryRepairWorktree(worktreePath: string, branch: string): void {
    if (this.config.dryRun) return;
    try {
      execFileSync('git', ['-C', this.config.projectDir, 'worktree', 'add', worktreePath, branch], { timeout: 30_000 });
    } catch (err) {
      this.emit('warn', `repair failed for ${worktreePath}: ${(err as Error).message}`);
    }
  }

  getLastResult(): ReapPassResult | null { return this.lastResult; }
}
