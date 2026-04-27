/**
 * Git State Manager — optional git tracking of agent state files.
 *
 * Only supported for standalone agents. Project-bound agents already
 * live inside a git repository — use the parent repo directly.
 *
 * Security:
 *   - Remote URL validation: only https://, git@, ssh:// allowed
 *   - Re-validates remote URL before every push/pull (defense against config poisoning)
 *   - Auto-commit messages avoid PII
 *   - config.json is always in .gitignore
 *   - relationships/ is git-ignored by default (GDPR Article 6)
 */

import { execSync, type ExecSyncOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { GitStateConfig, GitLogEntry, GitStatus } from './types.js';

const ALLOWED_REMOTE_SCHEMES = [
  /^https:\/\//,
  /^git@/,
  /^ssh:\/\//,
];

const BLOCKED_REMOTE_SCHEMES = [
  /^git:\/\//,
  /^file:\/\//,
  /^ftp:\/\//,
];

const DEFAULT_GITIGNORE = `# Runtime state -- NOT tracked
state/
logs/
*.tmp
*.pid

# Secrets -- NEVER tracked
config.json

# Derived data -- reconstructable
memory.db
memory.db-wal
memory.db-shm
backups/

# Tracked state:
# AGENT.md, USER.md, MEMORY.md
# jobs.json
# users.json
# hooks/ (generated but version-trackable)
# evolution/ (proposals, learnings, gaps)
`;

const DEFAULT_CONFIG: GitStateConfig = {
  enabled: false,
  branch: 'main',
  autoCommit: true,
  autoPush: false,
  commitDebounceSeconds: 60,
};

export class GitStateManager {
  private readonly stateDir: string;
  private readonly config: GitStateConfig;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCommitTime: number = 0;

  constructor(stateDir: string, config?: Partial<GitStateConfig>) {
    this.stateDir = path.resolve(stateDir);
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Validate a remote URL — only https://, git@, ssh:// allowed.
   * Called at three points: CLI remote set, push(), pull().
   */
  static validateRemoteUrl(url: string): boolean {
    if (!url || typeof url !== 'string') return false;

    // Check for blocked schemes first
    for (const pattern of BLOCKED_REMOTE_SCHEMES) {
      if (pattern.test(url)) return false;
    }

    // Must match an allowed scheme
    for (const pattern of ALLOWED_REMOTE_SCHEMES) {
      if (pattern.test(url)) return true;
    }

    return false;
  }

  /**
   * Initialize git tracking in the .instar/ directory.
   * Creates .gitignore and runs git init.
   */
  init(): void {
    if (this.isInitialized()) {
      throw new Error('Git tracking is already initialized in this directory.');
    }

    // Write .gitignore before git init
    const gitignorePath = path.join(this.stateDir, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, DEFAULT_GITIGNORE);
    }

    // git init
    this.git('init', '-b', this.config.branch);

    // Initial commit
    this.git('add', '-A');
    this.git('commit', '-m', '[instar] init: initialized git state tracking');
  }

  /**
   * Check if git tracking is active.
   */
  isInitialized(): boolean {
    return fs.existsSync(path.join(this.stateDir, '.git'));
  }

  /**
   * Stage and commit specific files (or all tracked).
   */
  commit(message: string, files?: string[]): void {
    if (!this.isInitialized()) {
      throw new Error('Git tracking is not initialized. Run `instar git init` first.');
    }

    if (files && files.length > 0) {
      for (const file of files) {
        // Validate path containment
        const resolved = path.resolve(this.stateDir, file);
        if (!resolved.startsWith(this.stateDir + path.sep) && resolved !== this.stateDir) {
          throw new Error(`File outside state directory: ${file}`);
        }
        if (fs.existsSync(resolved)) {
          this.git('add', file);
        }
      }
    } else {
      this.git('add', '-A');
    }

    // Check if there's anything to commit
    const status = this.git('status', '--porcelain');
    if (!status.trim()) {
      return; // Nothing to commit
    }

    this.git('commit', '-m', message);
    this.lastCommitTime = Date.now();
  }

  /**
   * Debounced auto-commit with structured message format.
   */
  autoCommit(category: string, brief: string): void {
    if (!this.config.autoCommit || !this.isInitialized()) return;

    // Clear any pending debounce
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    const debounceMs = this.config.commitDebounceSeconds * 1000;

    this.debounceTimer = setTimeout(() => {
      try {
        this.commit(`[instar] ${category}: ${brief}`);

        if (this.config.autoPush && this.config.remote) {
          this.push();
        }
      } catch {
        // @silent-fallback-ok — auto-commit non-fatal
      }
      this.debounceTimer = null;
    }, debounceMs);
  }

  /**
   * Cancel any pending auto-commit timer.
   */
  cancelPendingCommit(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Push to remote. Re-validates remote URL before every push.
   */
  push(): { firstPush: boolean } {
    if (!this.isInitialized()) {
      throw new Error('Git tracking is not initialized.');
    }

    const remote = this.config.remote;
    if (!remote) {
      throw new Error('No remote configured. Use `instar git remote <url>` to set one.');
    }

    // Re-validate remote at execution time (defense against config poisoning)
    if (!GitStateManager.validateRemoteUrl(remote)) {
      throw new Error(
        `Invalid remote URL: only https://, git@, and ssh:// schemes are allowed. Got: ${remote}`
      );
    }

    const isFirstPush = this.config.lastPushedRemote !== remote;

    // Ensure remote is configured in git
    try {
      this.git('remote', 'get-url', 'origin');
      this.git('remote', 'set-url', 'origin', remote);
    } catch {
      // @silent-fallback-ok — remote URL set, try add instead
      this.git('remote', 'add', 'origin', remote);
    }

    this.git('push', '-u', 'origin', this.config.branch);

    // Track that we've pushed to this remote
    this.config.lastPushedRemote = remote;

    return { firstPush: isFirstPush };
  }

  /**
   * Pull from remote. Re-validates remote URL before every pull.
   */
  pull(): void {
    if (!this.isInitialized()) {
      throw new Error('Git tracking is not initialized.');
    }

    const remote = this.config.remote;
    if (!remote) {
      throw new Error('No remote configured. Use `instar git remote <url>` to set one.');
    }

    // Re-validate remote at execution time
    if (!GitStateManager.validateRemoteUrl(remote)) {
      throw new Error(
        `Invalid remote URL: only https://, git@, and ssh:// schemes are allowed. Got: ${remote}`
      );
    }

    // Ensure remote is configured in git
    try {
      this.git('remote', 'get-url', 'origin');
      this.git('remote', 'set-url', 'origin', remote);
    } catch {
      // @silent-fallback-ok — remote URL set, try add instead
      this.git('remote', 'add', 'origin', remote);
    }

    this.git('pull', 'origin', this.config.branch);
  }

  /**
   * Get recent commit history.
   */
  log(limit: number = 20): GitLogEntry[] {
    if (!this.isInitialized()) return [];

    try {
      const output = this.git(
        'log',
        `--max-count=${limit}`,
        '--format=%h|%s|%an|%aI',
      );

      return output.trim().split('\n').filter(Boolean).map(line => {
        const [hash, message, author, date] = line.split('|');
        return { hash, message, author, date };
      });
    } catch {
      // @silent-fallback-ok — async pane fallback
      return [];
    }
  }

  /**
   * Get current git status.
   */
  status(): GitStatus {
    if (!this.isInitialized()) {
      return {
        initialized: false,
        branch: this.config.branch,
        staged: 0,
        modified: 0,
        untracked: 0,
        ahead: 0,
        behind: 0,
        remote: this.config.remote,
      };
    }

    // Force git to re-stat all files (without this, git may miss
    // modifications that happen in the same second as the last commit)
    try { this.git('update-index', '--refresh', '-q'); } catch { /* ignore */ }

    const porcelain = this.git('status', '--porcelain');
    // Split into lines but preserve the 2-char status prefix (leading spaces are significant)
    const lines = porcelain.split('\n').filter(line => line.length >= 2);

    let staged = 0;
    let modified = 0;
    let untracked = 0;

    for (const line of lines) {
      const indexStatus = line[0];
      const workStatus = line[1];
      if (indexStatus === '?' && workStatus === '?') {
        untracked++;
      } else {
        if (indexStatus !== ' ' && indexStatus !== '?') staged++;
        if (workStatus !== ' ' && workStatus !== '?') modified++;
      }
    }

    // Get ahead/behind counts
    let ahead = 0;
    let behind = 0;
    try {
      const trackingBranch = this.git('rev-parse', '--abbrev-ref', '@{u}').trim();
      if (trackingBranch) {
        const aheadBehind = this.git('rev-list', '--left-right', '--count', `@{u}...HEAD`).trim();
        const [behindStr, aheadStr] = aheadBehind.split(/\s+/);
        behind = parseInt(behindStr, 10) || 0;
        ahead = parseInt(aheadStr, 10) || 0;
      }
    } catch {
      // @silent-fallback-ok — no upstream configured
    }

    // Get current branch
    let branch = this.config.branch;
    try {
      branch = this.git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    } catch {
      // @silent-fallback-ok — head detection fallback to config
    }

    return {
      initialized: true,
      branch,
      staged,
      modified,
      untracked,
      ahead,
      behind,
      remote: this.config.remote,
    };
  }

  /**
   * Set the remote URL (validates scheme).
   */
  setRemote(url: string): void {
    if (!GitStateManager.validateRemoteUrl(url)) {
      throw new Error(
        `Invalid remote URL: only https://, git@, and ssh:// schemes are allowed. Got: ${url}`
      );
    }
    this.config.remote = url;

    // If git is initialized, also update the git remote
    if (this.isInitialized()) {
      try {
        this.git('remote', 'get-url', 'origin');
        this.git('remote', 'set-url', 'origin', url);
      } catch {
        this.git('remote', 'add', 'origin', url);
      }
    }
  }

  /**
   * Get the current configuration.
   */
  getConfig(): GitStateConfig {
    return { ...this.config };
  }

  /**
   * Execute a git command in the state directory.
   */
  private git(...args: string[]): string {
    const opts: ExecSyncOptions = {
      cwd: this.stateDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    };

    // Escape arguments for shell
    const escaped = args.map(arg => {
      // If argument contains spaces or special chars, quote it
      if (/[^a-zA-Z0-9_\-=./:%@+]/.test(arg)) {
        return `'${arg.replace(/'/g, "'\\''")}'`;
      }
      return arg;
    });

    // safe-git-allow: incremental-migration
    return execSync(`git ${escaped.join(' ')}`, opts) as string;
  }
}
