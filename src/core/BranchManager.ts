/**
 * BranchManager — Short-lived task branches with auto-merge.
 *
 * Non-trivial work (>N files, >N lines) goes on a task branch.
 * Branches auto-merge when the task completes, using the tiered
 * resolution system for conflicts. Trivial changes stay on main.
 *
 * From INTELLIGENT_SYNC_SPEC Section 6 (Branch Strategy) and
 * Section 9 (Sync Lifecycle — Task Completion Merge).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { assertNotInstarSourceTree } from './SourceTreeGuard.js';

// ── Types ────────────────────────────────────────────────────────────

export type BranchStatus = 'active' | 'merging' | 'merged' | 'stale' | 'abandoned';

export interface TaskBranch {
  /** Branch name (task/<machineId>/<slug>). */
  name: string;
  /** Machine that created this branch. */
  machineId: string;
  /** Associated session ID. */
  sessionId: string;
  /** Human-readable task description. */
  task: string;
  /** Branch creation time. */
  createdAt: string;
  /** Last activity time. */
  updatedAt: string;
  /** Current branch status. */
  status: BranchStatus;
  /** Base branch this was created from (usually 'main'). */
  baseBranch: string;
  /** Commit hash at branch creation. */
  baseCommit: string;
  /** Number of commits on this branch. */
  commitCount: number;
}

export interface BranchManagerConfig {
  /** Project directory (repo root). */
  projectDir: string;
  /** State directory (.instar). */
  stateDir: string;
  /** This machine's ID. */
  machineId: string;
  /** Base branch name (default: 'main'). */
  baseBranch?: string;
  /** Branch prefix (default: 'task/'). */
  branchPrefix?: string;
  /** Max branch lifetime in ms (default: 4 hours). */
  maxLifetimeMs?: number;
  /** Branch creation threshold — file count (default: 2). */
  fileCountThreshold?: number;
  /** Branch creation threshold — line count (default: 10). */
  lineCountThreshold?: number;
  /** Auto-merge on task completion (default: true). */
  autoMergeOnComplete?: boolean;
  /** Merge strategy: 'no-ff' or 'rebase' (default: 'no-ff'). */
  mergeStrategy?: 'no-ff' | 'rebase';
}

export interface MergeResult {
  /** Whether the merge succeeded. */
  success: boolean;
  /** Files that had conflicts. */
  conflicts: string[];
  /** Merge commit hash (if successful). */
  mergeCommit?: string;
  /** Error message if failed. */
  error?: string;
  /** Whether post-merge validation passed. */
  validationPassed?: boolean;
}

export interface BranchWarning {
  /** The branch in question. */
  branch: TaskBranch;
  /** Warning type. */
  type: 'lifetime-exceeded' | 'stale' | 'orphaned';
  /** Human-readable message. */
  message: string;
  /** Branch age in ms. */
  ageMs: number;
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_BASE_BRANCH = 'main';
const DEFAULT_PREFIX = 'task/';
const DEFAULT_MAX_LIFETIME = 4 * 60 * 60 * 1000; // 4 hours
const DEFAULT_FILE_THRESHOLD = 2;
const DEFAULT_LINE_THRESHOLD = 10;
const STALE_THRESHOLD = 2 * 60 * 60 * 1000; // 2 hours without update
const BRANCH_STATE_FILE = 'branches.json';

// ── BranchManager ────────────────────────────────────────────────────

export class BranchManager {
  private projectDir: string;
  private stateDir: string;
  private machineId: string;
  private baseBranch: string;
  private branchPrefix: string;
  private maxLifetimeMs: number;
  private fileCountThreshold: number;
  private lineCountThreshold: number;
  private autoMergeOnComplete: boolean;
  private mergeStrategy: 'no-ff' | 'rebase';
  private branchStateDir: string;

  constructor(config: BranchManagerConfig) {
    assertNotInstarSourceTree(config.projectDir, 'BranchManager');
    this.projectDir = config.projectDir;
    this.stateDir = config.stateDir;
    this.machineId = config.machineId;
    this.baseBranch = config.baseBranch ?? DEFAULT_BASE_BRANCH;
    this.branchPrefix = config.branchPrefix ?? DEFAULT_PREFIX;
    this.maxLifetimeMs = config.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME;
    this.fileCountThreshold = config.fileCountThreshold ?? DEFAULT_FILE_THRESHOLD;
    this.lineCountThreshold = config.lineCountThreshold ?? DEFAULT_LINE_THRESHOLD;
    this.autoMergeOnComplete = config.autoMergeOnComplete ?? true;
    this.mergeStrategy = config.mergeStrategy ?? 'no-ff';

    this.branchStateDir = path.join(config.stateDir, 'state', 'branches');
    if (!fs.existsSync(this.branchStateDir)) {
      fs.mkdirSync(this.branchStateDir, { recursive: true });
    }
  }

  // ── Decision ───────────────────────────────────────────────────────

  /**
   * Determine whether a task should use a branch or stay on main.
   */
  shouldBranch(opts: {
    fileCount?: number;
    lineCount?: number;
    description?: string;
  }): boolean {
    // If either threshold is exceeded, branch
    if (opts.fileCount !== undefined && opts.fileCount >= this.fileCountThreshold) {
      return true;
    }
    if (opts.lineCount !== undefined && opts.lineCount >= this.lineCountThreshold) {
      return true;
    }
    return false;
  }

  // ── Branch Lifecycle ───────────────────────────────────────────────

  /**
   * Create a new task branch from the current base branch.
   * Returns the branch metadata.
   */
  createBranch(opts: {
    sessionId: string;
    task: string;
    slug: string;
  }): TaskBranch {
    const branchName = `${this.branchPrefix}${this.machineId}/${opts.slug}`;

    // Get current HEAD on base branch
    const baseCommit = this.git('rev-parse', 'HEAD');

    // Create and switch to the new branch
    this.git('checkout', '-b', branchName);

    const branch: TaskBranch = {
      name: branchName,
      machineId: this.machineId,
      sessionId: opts.sessionId,
      task: opts.task,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'active',
      baseBranch: this.baseBranch,
      baseCommit,
      commitCount: 0,
    };

    this.saveBranchState(branch);
    return branch;
  }

  /**
   * Update branch metadata (e.g., after a commit).
   */
  updateBranch(branchName: string, updates?: { task?: string }): boolean {
    const branch = this.loadBranchState(branchName);
    if (!branch) return false;

    if (updates?.task !== undefined) branch.task = updates.task;
    branch.updatedAt = new Date().toISOString();

    // Count commits since base
    try {
      const log = this.git('log', '--oneline', `${branch.baseCommit}..${branchName}`);
      branch.commitCount = log.trim() ? log.trim().split('\n').length : 0;
    } catch {
      // Branch or commit might not exist in test scenarios
    }

    this.saveBranchState(branch);
    return true;
  }

  /**
   * Complete a task branch — merge back to base and clean up.
   *
   * Steps (per spec Section 9):
   * 1. Commit all changes on task branch
   * 2. Switch to base branch
   * 3. Fetch + rebase base from remote (if remote exists)
   * 4. Merge task branch into base (--no-ff or rebase)
   * 5. If conflicts → return them for tiered resolution
   * 6. Delete task branch
   */
  completeBranch(branchName: string, opts?: {
    commitMessage?: string;
    skipValidation?: boolean;
  }): MergeResult {
    const branch = this.loadBranchState(branchName);
    if (!branch) {
      return { success: false, conflicts: [], error: `Branch state not found: ${branchName}` };
    }

    branch.status = 'merging';
    this.saveBranchState(branch);

    try {
      // 1. Commit any pending changes on the task branch
      this.commitPending(opts?.commitMessage ?? `task: ${branch.task}`);

      // 2. Switch to base branch
      this.git('checkout', this.baseBranch);

      // 3. Try to update base from remote (non-fatal if no remote)
      try {
        this.git('fetch', 'origin');
        this.git('rebase', `origin/${this.baseBranch}`);
      } catch {
        // No remote or fetch failed — proceed with local merge
      }

      // 4. Merge task branch into base
      const mergeResult = this.performMerge(branchName);

      if (!mergeResult.success) {
        // Conflicts detected — leave branch intact for tiered resolution
        branch.status = 'active';
        this.saveBranchState(branch);
        return mergeResult;
      }

      // 5. Get merge commit
      mergeResult.mergeCommit = this.git('rev-parse', 'HEAD');

      // 6. Delete task branch
      this.deleteBranch(branchName);

      // Update state to merged
      branch.status = 'merged';
      branch.updatedAt = new Date().toISOString();
      this.saveBranchState(branch);

      return mergeResult;

    } catch (err) {
      // Something went wrong — try to restore state
      branch.status = 'active';
      this.saveBranchState(branch);

      try {
        // Try to get back to the task branch if merge failed midway
        const currentBranch = this.git('rev-parse', '--abbrev-ref', 'HEAD');
        if (currentBranch === this.baseBranch) {
          // Abort any in-progress merge
          try { this.git('merge', '--abort'); } catch { /* no merge in progress */ }
        }
      } catch { /* best effort */ }

      return {
        success: false,
        conflicts: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Abandon a task branch without merging.
   * Switches back to base and deletes the branch.
   */
  abandonBranch(branchName: string): boolean {
    const branch = this.loadBranchState(branchName);

    try {
      // Switch to base if we're on the task branch
      const current = this.getCurrentBranch();
      if (current === branchName) {
        this.git('checkout', this.baseBranch);
      }

      this.deleteBranch(branchName);

      if (branch) {
        branch.status = 'abandoned';
        branch.updatedAt = new Date().toISOString();
        this.saveBranchState(branch);
      }

      return true;
    } catch (err) {
      DegradationReporter.getInstance().report({
        feature: 'BranchManager.abandonBranch',
        primary: 'Abandon task branch and update state',
        fallback: 'Branch abandon failed silently',
        reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Stale branch may persist and not be cleaned up',
      });
      return false;
    }
  }

  // ── Monitoring ─────────────────────────────────────────────────────

  /**
   * Check for branches that exceed lifetime or are stale.
   */
  checkBranchHealth(): BranchWarning[] {
    const warnings: BranchWarning[] = [];
    const now = Date.now();
    const activeBranches = this.getActiveBranches();

    for (const branch of activeBranches) {
      const createdAge = now - new Date(branch.createdAt).getTime();
      const updatedAge = now - new Date(branch.updatedAt).getTime();

      if (createdAge > this.maxLifetimeMs) {
        warnings.push({
          branch,
          type: 'lifetime-exceeded',
          message: `Branch "${branch.name}" has exceeded the ${this.maxLifetimeMs / (60 * 60 * 1000)}h lifetime cap. Consider merging or abandoning.`,
          ageMs: createdAge,
        });
      } else if (updatedAge > STALE_THRESHOLD) {
        warnings.push({
          branch,
          type: 'stale',
          message: `Branch "${branch.name}" has had no activity for ${Math.round(updatedAge / (60 * 60 * 1000))}h. It may be abandoned.`,
          ageMs: updatedAge,
        });
      }
    }

    // Check for orphaned git branches (exist in git but not in state)
    try {
      const gitBranches = this.listGitBranches();
      const stateBranches = new Set(activeBranches.map(b => b.name));

      for (const gitBranch of gitBranches) {
        if (gitBranch.startsWith(this.branchPrefix) && !stateBranches.has(gitBranch)) {
          warnings.push({
            branch: {
              name: gitBranch,
              machineId: 'unknown',
              sessionId: 'unknown',
              task: 'unknown (orphaned)',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              status: 'active',
              baseBranch: this.baseBranch,
              baseCommit: '',
              commitCount: 0,
            },
            type: 'orphaned',
            message: `Git branch "${gitBranch}" exists but has no state tracking. It may be orphaned.`,
            ageMs: 0,
          });
        }
      }
    } catch {
      // @silent-fallback-ok — orphan detection is best-effort; git branch listing may fail in bare repos
    }

    return warnings;
  }

  /**
   * Get all active branches for this machine.
   */
  getActiveBranches(): TaskBranch[] {
    return this.loadAllBranchStates()
      .filter(b => b.status === 'active' && b.machineId === this.machineId);
  }

  /**
   * Get all tracked branches across all machines.
   */
  getAllBranches(): TaskBranch[] {
    return this.loadAllBranchStates();
  }

  /**
   * Get the current git branch name.
   */
  getCurrentBranch(): string {
    return this.git('rev-parse', '--abbrev-ref', 'HEAD');
  }

  /**
   * Check if we're currently on a task branch.
   */
  isOnTaskBranch(): boolean {
    return this.getCurrentBranch().startsWith(this.branchPrefix);
  }

  // ── Private: Git Operations ────────────────────────────────────────

  private performMerge(branchName: string): MergeResult {
    try {
      if (this.mergeStrategy === 'no-ff') {
        this.git('merge', '--no-ff', branchName, '-m', `merge: ${branchName}`);
      } else {
        // Rebase strategy
        this.git('rebase', branchName);
      }
      return { success: true, conflicts: [] };
    } catch (err) {
      // @silent-fallback-ok — merge failure is expected control flow; conflicts are returned to caller for resolution
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('CONFLICT') || errMsg.includes('Merge conflict')) {
        const conflicts = this.detectConflicts();
        return { success: false, conflicts };
      }
      return { success: false, conflicts: [], error: errMsg };
    }
  }

  private detectConflicts(): string[] {
    try {
      const status = this.git('diff', '--name-only', '--diff-filter=U');
      return status.split('\n').filter(l => l.trim());
    } catch {
      // @silent-fallback-ok — git diff for conflict detection is best-effort; empty list is safe default
      return [];
    }
  }

  private commitPending(message: string): void {
    try {
      const status = this.git('status', '--porcelain');
      if (status.trim()) {
        this.git('add', '-A');
        this.git('commit', '-m', message);
      }
    } catch {
      // @silent-fallback-ok — nothing to commit or git not available; commit is best-effort
    }
  }

  private deleteBranch(branchName: string): void {
    try {
      this.git('branch', '-D', branchName);
    } catch {
      // @silent-fallback-ok — branch may not exist; deletion is best-effort cleanup
    }

    // Also try to delete remote tracking branch (non-fatal)
    try {
      this.git('push', 'origin', '--delete', branchName);
    } catch {
      // @silent-fallback-ok — no remote configured or branch not pushed; remote cleanup is optional
    }
  }

  private listGitBranches(): string[] {
    try {
      const output = this.git('branch', '--list', `${this.branchPrefix}*`);
      return output.split('\n')
        .map(l => l.replace(/^\*?\s+/, '').trim())
        .filter(l => l.length > 0);
    } catch {
      // @silent-fallback-ok — git branch listing may fail if not in a repo; empty list is safe default
      return [];
    }
  }

  // ── Private: State Persistence ─────────────────────────────────────

  private branchStateFile(): string {
    return path.join(this.branchStateDir, BRANCH_STATE_FILE);
  }

  private loadAllBranchStates(): TaskBranch[] {
    const filePath = this.branchStateFile();
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      return data.branches ?? [];
    } catch {
      // @silent-fallback-ok — state file may not exist yet; empty array is the natural initial state
      return [];
    }
  }

  private loadBranchState(branchName: string): TaskBranch | null {
    const all = this.loadAllBranchStates();
    return all.find(b => b.name === branchName) ?? null;
  }

  private saveBranchState(branch: TaskBranch): void {
    const all = this.loadAllBranchStates();
    const idx = all.findIndex(b => b.name === branch.name);
    if (idx >= 0) {
      all[idx] = branch;
    } else {
      all.push(branch);
    }

    const filePath = this.branchStateFile();
    fs.writeFileSync(filePath, JSON.stringify({ branches: all }, null, 2));
  }

  // ── Private: Git Helper ────────────────────────────────────────────

  private git(...args: string[]): string {
    // safe-git-allow: incremental-migration
    return execFileSync('git', args, {
      cwd: this.projectDir,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  }
}
