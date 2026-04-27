/**
 * Unit tests for WorktreeMonitor — post-session worktree scanning
 * and orphan branch detection.
 *
 * Tests:
 * - Worktree listing: parses git worktree list --porcelain output
 * - Unmerged work detection: identifies commits ahead of default branch
 * - Orphan branch detection: finds worktree-* branches with no active worktree
 * - Post-session scan: alerts on worktree activity after session completion
 * - Periodic scan: detects stale worktrees
 * - Alert formatting: readable messages for Telegram
 * - State persistence: saves/loads reports
 * - Lifecycle: start/stop idempotent
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  WorktreeMonitor,
  type Worktree,
  type WorktreeMonitorConfig,
} from '../../src/monitoring/WorktreeMonitor.js';
import type { Session } from '../../src/core/types.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-worktree-test-'));
}

function makeSession(overrides?: Partial<Session>): Session {
  return {
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: 'test-session',
    status: 'completed',
    tmuxSession: 'test-tmux-session',
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
    endedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Run a shell command in a directory. All git helpers use this to avoid
 * space-splitting issues with commit messages and glob patterns.
 */
function shell(cmd: string, cwd: string): { stdout: string; stderr: string; status: number | null } {
  return spawnSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf-8' });
}

/**
 * Initialize a real git repo in a temp directory for integration-style unit tests.
 * Returns the repo path.
 */
function initGitRepo(dir: string): string {
  const repoDir = path.join(dir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });

  shell('git init --initial-branch main', repoDir);
  shell('git config user.email test@test.com', repoDir);
  shell('git config user.name Test', repoDir);

  // Create initial commit
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Project\n');
  shell('git add README.md', repoDir);
  shell('git commit -m "Initial commit"', repoDir);

  return repoDir;
}

/**
 * Create a worktree in the repo with optional commits.
 */
function createWorktree(
  repoDir: string,
  name: string,
  opts?: { addCommits?: number; files?: string[] }
): string {
  const wtPath = path.join(repoDir, 'worktrees', name);
  const branchName = `worktree-${name}`;

  // Create the worktree
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  const result = shell(`git worktree add "${wtPath}" -b "${branchName}"`, repoDir);
  if (result.status !== 0) {
    throw new Error(`git worktree add failed: ${result.stderr}`);
  }

  // Add commits if requested
  const commitCount = opts?.addCommits ?? 0;
  for (let i = 0; i < commitCount; i++) {
    const filename = opts?.files?.[i] ?? `file-${i}.txt`;
    fs.writeFileSync(path.join(wtPath, filename), `Content ${i}\n`);
    shell(`git add "${filename}"`, wtPath);
    shell(`git commit -m "Worktree commit ${i + 1}"`, wtPath);
  }

  return wtPath;
}

/**
 * Create an orphan branch (branch matching worktree-* but with no active worktree).
 */
function createOrphanBranch(repoDir: string, name: string): void {
  shell(`git branch worktree-${name}`, repoDir);
}

// ── Tests ────────────────────────────────────────────────────────

describe('WorktreeMonitor', () => {
  let tmpDir: string;
  let repoDir: string;
  let stateDir: string;
  let monitor: WorktreeMonitor;
  let alerts: string[];

  beforeEach(() => {
    tmpDir = createTempDir();
    repoDir = initGitRepo(tmpDir);
    stateDir = path.join(tmpDir, 'state');
    alerts = [];

    monitor = new WorktreeMonitor({
      projectDir: repoDir,
      stateDir,
      pollIntervalMs: 0, // disable periodic scanning in tests
      alertCallback: async (msg) => { alerts.push(msg); },
    });
  });

  afterEach(() => {
    monitor.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Worktree Listing ─────────────────────────────────────────

  describe('listWorktrees()', () => {
    it('returns only main worktree when no extras exist', () => {
      const wts = monitor.listWorktrees();
      expect(wts).toHaveLength(1);
      expect(wts[0].isMain).toBe(true);
      expect(wts[0].branch).toBe('main');
    });

    it('detects a created worktree', () => {
      createWorktree(repoDir, 'feature-auth');

      const wts = monitor.listWorktrees();
      expect(wts).toHaveLength(2);

      const extra = wts.find(w => !w.isMain);
      expect(extra).toBeDefined();
      expect(extra!.branch).toBe('worktree-feature-auth');
      expect(extra!.path).toContain('feature-auth');
    });

    it('detects multiple worktrees', () => {
      createWorktree(repoDir, 'feature-a');
      createWorktree(repoDir, 'feature-b');
      createWorktree(repoDir, 'feature-c');

      const wts = monitor.listWorktrees();
      expect(wts).toHaveLength(4); // main + 3

      const nonMain = wts.filter(w => !w.isMain);
      expect(nonMain).toHaveLength(3);
      expect(nonMain.map(w => w.branch).sort()).toEqual([
        'worktree-feature-a',
        'worktree-feature-b',
        'worktree-feature-c',
      ]);
    });
  });

  // ── Unmerged Work Detection ──────────────────────────────────

  describe('checkUnmergedWork()', () => {
    it('returns null when worktree has no commits ahead', () => {
      createWorktree(repoDir, 'empty');

      const wts = monitor.listWorktrees();
      const wt = wts.find(w => w.branch === 'worktree-empty')!;
      const result = monitor.checkUnmergedWork(wt, 'main');
      expect(result).toBeNull();
    });

    it('detects commits ahead of main', () => {
      createWorktree(repoDir, 'with-work', {
        addCommits: 3,
        files: ['auth.ts', 'config.ts', 'test.ts'],
      });

      const wts = monitor.listWorktrees();
      const wt = wts.find(w => w.branch === 'worktree-with-work')!;
      const result = monitor.checkUnmergedWork(wt, 'main');

      expect(result).not.toBeNull();
      expect(result!.commitsAhead).toBe(3);
      expect(result!.filesChanged).toContain('auth.ts');
      expect(result!.filesChanged).toContain('config.ts');
      expect(result!.filesChanged).toContain('test.ts');
    });

    it('returns null for worktree with no branch', () => {
      const fakeBranchless: Worktree = {
        path: '/tmp/fake',
        head: 'abc123',
        branch: null,
        isMain: false,
        isBare: false,
      };
      const result = monitor.checkUnmergedWork(fakeBranchless, 'main');
      expect(result).toBeNull();
    });
  });

  // ── Orphan Branch Detection ──────────────────────────────────

  describe('findOrphanBranches()', () => {
    it('returns empty when no orphan branches exist', () => {
      const wts = monitor.listWorktrees();
      const orphans = monitor.findOrphanBranches(wts);
      expect(orphans).toEqual([]);
    });

    it('detects orphan worktree-* branches', () => {
      createOrphanBranch(repoDir, 'abandoned-feature');
      createOrphanBranch(repoDir, 'old-work');

      const wts = monitor.listWorktrees();
      const orphans = monitor.findOrphanBranches(wts);

      expect(orphans).toHaveLength(2);
      expect(orphans.sort()).toEqual([
        'worktree-abandoned-feature',
        'worktree-old-work',
      ]);
    });

    it('excludes branches that have active worktrees', () => {
      createWorktree(repoDir, 'active');
      createOrphanBranch(repoDir, 'orphaned');

      const wts = monitor.listWorktrees();
      const orphans = monitor.findOrphanBranches(wts);

      expect(orphans).toHaveLength(1);
      expect(orphans[0]).toBe('worktree-orphaned');
    });
  });

  // ── Full Scan ────────────────────────────────────────────────

  describe('scanWorktrees()', () => {
    it('returns clean report when no worktrees exist', () => {
      const report = monitor.scanWorktrees();

      expect(report.worktrees).toEqual([]);
      expect(report.withUnmergedWork).toEqual([]);
      expect(report.orphanBranches).toEqual([]);
      expect(report.timestamp).toBeTruthy();
    });

    it('detects worktrees with unmerged work', () => {
      createWorktree(repoDir, 'feature', { addCommits: 2, files: ['a.ts', 'b.ts'] });

      const report = monitor.scanWorktrees();

      expect(report.worktrees).toHaveLength(1);
      expect(report.withUnmergedWork).toHaveLength(1);
      expect(report.withUnmergedWork[0].commitsAhead).toBe(2);
    });

    it('detects orphan branches alongside active worktrees', () => {
      createWorktree(repoDir, 'active');
      createOrphanBranch(repoDir, 'orphaned');

      const report = monitor.scanWorktrees();

      expect(report.worktrees).toHaveLength(1); // active only (non-main)
      expect(report.orphanBranches).toHaveLength(1);
      expect(report.orphanBranches[0]).toBe('worktree-orphaned');
    });
  });

  // ── Post-Session Scan ────────────────────────────────────────

  describe('onSessionComplete()', () => {
    it('does not alert when no worktrees exist', async () => {
      const session = makeSession();
      const report = await monitor.onSessionComplete(session);

      expect(alerts).toHaveLength(0);
      expect(report.worktrees).toEqual([]);
      expect(report.actions).toEqual([]);
    });

    it('alerts when unmerged work is found', async () => {
      createWorktree(repoDir, 'stale-work', { addCommits: 1, files: ['important.ts'] });

      const session = makeSession({ name: 'job-build-feature' });
      const report = await monitor.onSessionComplete(session);

      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toContain('job-build-feature');
      expect(alerts[0]).toContain('UNMERGED WORK');
      expect(alerts[0]).toContain('worktree-stale-work');
      expect(alerts[0]).toContain('important.ts');
      expect(report.actions).toHaveLength(1);
    });

    it('alerts when orphan branches are found', async () => {
      createOrphanBranch(repoDir, 'forgotten');

      const session = makeSession();
      const report = await monitor.onSessionComplete(session);

      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toContain('ORPHAN BRANCHES');
      expect(alerts[0]).toContain('worktree-forgotten');
    });

    it('includes both unmerged and orphan info in one alert', async () => {
      createWorktree(repoDir, 'has-work', { addCommits: 2 });
      createOrphanBranch(repoDir, 'no-worktree');

      const session = makeSession();
      const report = await monitor.onSessionComplete(session);

      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toContain('UNMERGED WORK');
      expect(alerts[0]).toContain('ORPHAN BRANCHES');
      expect(report.withUnmergedWork).toHaveLength(1);
      expect(report.orphanBranches).toHaveLength(1);
    });
  });

  // ── State Persistence ────────────────────────────────────────

  describe('state persistence', () => {
    it('saves report after scan', async () => {
      createWorktree(repoDir, 'tracked');

      await monitor.onSessionComplete(makeSession());

      const stateFile = path.join(stateDir, 'worktree-monitor', 'last-report.json');
      expect(fs.existsSync(stateFile)).toBe(true);

      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      expect(saved.worktrees).toHaveLength(1);
      expect(saved.timestamp).toBeTruthy();
    });

    it('loads previous report on construction', async () => {
      createWorktree(repoDir, 'tracked');
      await monitor.onSessionComplete(makeSession());

      // Create new monitor instance — should load saved state
      const monitor2 = new WorktreeMonitor({
        projectDir: repoDir,
        stateDir,
        pollIntervalMs: 0,
      });

      const loaded = monitor2.getLastReport();
      expect(loaded).not.toBeNull();
      expect(loaded!.worktrees).toHaveLength(1);

      monitor2.stop();
    });
  });

  // ── Default Branch Detection ─────────────────────────────────

  describe('getDefaultBranch()', () => {
    it('detects main as default branch', () => {
      const branch = monitor.getDefaultBranch();
      expect(branch).toBe('main');
    });
  });

  // ── Lifecycle ────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('start/stop is idempotent', () => {
      const m = new WorktreeMonitor({
        projectDir: repoDir,
        stateDir,
        pollIntervalMs: 60_000,
      });

      m.start();
      m.start(); // second start should be no-op
      m.stop();
      m.stop(); // second stop should be no-op
    });

    it('emits scan events', async () => {
      const events: unknown[] = [];
      monitor.on('scan', (report) => events.push(report));

      await monitor.onSessionComplete(makeSession());

      expect(events).toHaveLength(1);
    });
  });

  // ── Alert Callback Error Handling ────────────────────────────

  describe('alert error handling', () => {
    it('emits error event when alert callback fails', async () => {
      const errorMonitor = new WorktreeMonitor({
        projectDir: repoDir,
        stateDir,
        pollIntervalMs: 0,
        alertCallback: async () => { throw new Error('Telegram down'); },
      });

      const errors: Error[] = [];
      errorMonitor.on('error', (err) => errors.push(err));

      createWorktree(repoDir, 'work', { addCommits: 1 });
      await errorMonitor.onSessionComplete(makeSession());

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('Telegram down');

      errorMonitor.stop();
    });
  });
});
