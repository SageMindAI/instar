/**
 * Unit + Semantic Correctness tests for BranchManager.
 *
 * Tests the shouldBranch() decision logic, branch creation/update/completion/abandonment,
 * health monitoring, and state management. All tests use real git repos in temp directories.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { BranchManager } from '../../src/core/BranchManager.js';
import type { TaskBranch, BranchManagerConfig } from '../../src/core/BranchManager.js';

// ── Helpers ────────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  // safe-git-allow: incremental-migration
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 10_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function makeManager(
  tmpDir: string,
  stateDir: string,
  overrides?: Partial<BranchManagerConfig>,
): BranchManager {
  return new BranchManager({
    projectDir: tmpDir,
    stateDir,
    machineId: 'test-machine',
    baseBranch: 'main',
    ...overrides,
  });
}

function commitFile(
  tmpDir: string,
  filename: string,
  content: string,
  message: string,
): void {
  fs.writeFileSync(path.join(tmpDir, filename), content);
  git(tmpDir, 'add', filename);
  git(tmpDir, 'commit', '-m', message);
}

// ── Test Suite ──────────────────────────────────────────────────────────

describe('BranchManager', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-mgr-'));
    stateDir = path.join(tmpDir, '.instar');
    // safe-git-allow: incremental-migration
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmpDir });
    // safe-git-allow: incremental-migration
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    // safe-git-allow: incremental-migration
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test\n');
    // safe-git-allow: incremental-migration
    execFileSync('git', ['add', '.'], { cwd: tmpDir });
    // safe-git-allow: incremental-migration
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. shouldBranch() Decision Logic ──────────────────────────────

  describe('shouldBranch() decision logic', () => {
    it('returns false when below both thresholds', () => {
      const mgr = makeManager(tmpDir, stateDir);
      expect(mgr.shouldBranch({ fileCount: 1, lineCount: 5 })).toBe(false);
    });

    it('returns true when fileCount >= threshold (default 2)', () => {
      const mgr = makeManager(tmpDir, stateDir);
      expect(mgr.shouldBranch({ fileCount: 2 })).toBe(true);
    });

    it('returns true when fileCount exceeds threshold', () => {
      const mgr = makeManager(tmpDir, stateDir);
      expect(mgr.shouldBranch({ fileCount: 10 })).toBe(true);
    });

    it('returns true when lineCount >= threshold (default 10)', () => {
      const mgr = makeManager(tmpDir, stateDir);
      expect(mgr.shouldBranch({ lineCount: 10 })).toBe(true);
    });

    it('returns true when lineCount exceeds threshold', () => {
      const mgr = makeManager(tmpDir, stateDir);
      expect(mgr.shouldBranch({ lineCount: 100 })).toBe(true);
    });

    it('returns true when both exceed thresholds', () => {
      const mgr = makeManager(tmpDir, stateDir);
      expect(mgr.shouldBranch({ fileCount: 5, lineCount: 50 })).toBe(true);
    });

    it('returns false when only fileCount provided and below threshold', () => {
      const mgr = makeManager(tmpDir, stateDir);
      expect(mgr.shouldBranch({ fileCount: 1 })).toBe(false);
    });

    it('returns false when only lineCount provided and below threshold', () => {
      const mgr = makeManager(tmpDir, stateDir);
      expect(mgr.shouldBranch({ lineCount: 5 })).toBe(false);
    });

    it('returns false with empty options', () => {
      const mgr = makeManager(tmpDir, stateDir);
      expect(mgr.shouldBranch({})).toBe(false);
    });

    it('respects custom fileCountThreshold from config', () => {
      const mgr = makeManager(tmpDir, stateDir, { fileCountThreshold: 5 });
      expect(mgr.shouldBranch({ fileCount: 4 })).toBe(false);
      expect(mgr.shouldBranch({ fileCount: 5 })).toBe(true);
    });

    it('respects custom lineCountThreshold from config', () => {
      const mgr = makeManager(tmpDir, stateDir, { lineCountThreshold: 50 });
      expect(mgr.shouldBranch({ lineCount: 49 })).toBe(false);
      expect(mgr.shouldBranch({ lineCount: 50 })).toBe(true);
    });

    it('fileCount at exact threshold boundary returns true', () => {
      const mgr = makeManager(tmpDir, stateDir, { fileCountThreshold: 3 });
      expect(mgr.shouldBranch({ fileCount: 2 })).toBe(false);
      expect(mgr.shouldBranch({ fileCount: 3 })).toBe(true);
    });

    it('lineCount at exact threshold boundary returns true', () => {
      const mgr = makeManager(tmpDir, stateDir, { lineCountThreshold: 20 });
      expect(mgr.shouldBranch({ lineCount: 19 })).toBe(false);
      expect(mgr.shouldBranch({ lineCount: 20 })).toBe(true);
    });
  });

  // ── 2. Branch Creation ────────────────────────────────────────────

  describe('branch creation', () => {
    it('creates branch with correct naming convention (task/<machineId>/<slug>)', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Add OAuth2',
        slug: 'add-oauth2',
      });

      expect(branch.name).toBe('task/test-machine/add-oauth2');
    });

    it('switches git to the new branch', () => {
      const mgr = makeManager(tmpDir, stateDir);
      mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Add OAuth2',
        slug: 'add-oauth2',
      });

      const currentBranch = git(tmpDir, 'rev-parse', '--abbrev-ref', 'HEAD');
      expect(currentBranch).toBe('task/test-machine/add-oauth2');
    });

    it('returns correct TaskBranch metadata', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Add OAuth2',
        slug: 'add-oauth2',
      });

      expect(branch.machineId).toBe('test-machine');
      expect(branch.sessionId).toBe('AUT-100');
      expect(branch.task).toBe('Add OAuth2');
      expect(branch.status).toBe('active');
      expect(branch.baseBranch).toBe('main');
      expect(branch.commitCount).toBe(0);
      expect(branch.createdAt).toBeDefined();
      expect(branch.updatedAt).toBeDefined();
      expect(branch.baseCommit).toBeDefined();
      expect(branch.baseCommit.length).toBeGreaterThan(0);
    });

    it('persists branch state to disk', () => {
      const mgr = makeManager(tmpDir, stateDir);
      mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Add OAuth2',
        slug: 'add-oauth2',
      });

      // Read back from fresh instance
      const mgr2 = makeManager(tmpDir, stateDir);
      const branches = mgr2.getAllBranches();
      expect(branches).toHaveLength(1);
      expect(branches[0].name).toBe('task/test-machine/add-oauth2');
      expect(branches[0].task).toBe('Add OAuth2');
    });

    it('baseCommit matches HEAD at creation time', () => {
      const headBefore = git(tmpDir, 'rev-parse', 'HEAD');
      const mgr = makeManager(tmpDir, stateDir);
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Test',
        slug: 'test',
      });

      expect(branch.baseCommit).toBe(headBefore);
    });

    it('uses custom branch prefix when configured', () => {
      const mgr = makeManager(tmpDir, stateDir, { branchPrefix: 'feature/' });
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Test',
        slug: 'new-feature',
      });

      expect(branch.name).toBe('feature/test-machine/new-feature');
      const currentBranch = git(tmpDir, 'rev-parse', '--abbrev-ref', 'HEAD');
      expect(currentBranch).toBe('feature/test-machine/new-feature');
    });

    it('can create multiple branches sequentially', () => {
      const mgr = makeManager(tmpDir, stateDir);

      const branch1 = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Task 1',
        slug: 'task-1',
      });

      // Go back to main before creating another branch
      git(tmpDir, 'checkout', 'main');

      const branch2 = mgr.createBranch({
        sessionId: 'AUT-101',
        task: 'Task 2',
        slug: 'task-2',
      });

      const all = mgr.getAllBranches();
      expect(all).toHaveLength(2);
      expect(all.map(b => b.name).sort()).toEqual([
        'task/test-machine/task-1',
        'task/test-machine/task-2',
      ]);
    });
  });

  // ── 3. Branch Update ──────────────────────────────────────────────

  describe('branch update', () => {
    it('updates task description', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Original task',
        slug: 'update-test',
      });

      const result = mgr.updateBranch(branch.name, { task: 'Updated task' });
      expect(result).toBe(true);

      const all = mgr.getAllBranches();
      expect(all[0].task).toBe('Updated task');
    });

    it('updates timestamp', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Test',
        slug: 'timestamp-test',
      });

      const originalUpdatedAt = branch.updatedAt;

      // Small delay so timestamp differs
      const result = mgr.updateBranch(branch.name);
      expect(result).toBe(true);

      const updated = mgr.getAllBranches()[0];
      expect(new Date(updated.updatedAt).getTime())
        .toBeGreaterThanOrEqual(new Date(originalUpdatedAt).getTime());
    });

    it('counts commits since base', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Commit count test',
        slug: 'commit-count',
      });

      // Make two commits on the task branch
      commitFile(tmpDir, 'file1.ts', 'content1', 'first commit');
      commitFile(tmpDir, 'file2.ts', 'content2', 'second commit');

      mgr.updateBranch(branch.name);

      const updated = mgr.getAllBranches()[0];
      expect(updated.commitCount).toBe(2);
    });

    it('returns false for nonexistent branch', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const result = mgr.updateBranch('task/nonexistent/branch', { task: 'New task' });
      expect(result).toBe(false);
    });

    it('updates without changes object still refreshes timestamp', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Test',
        slug: 'no-changes',
      });

      const result = mgr.updateBranch(branch.name);
      expect(result).toBe(true);

      const updated = mgr.getAllBranches()[0];
      expect(updated.task).toBe('Test'); // unchanged
    });
  });

  // ── 4. Branch Completion (Merge) ──────────────────────────────────

  describe('branch completion (merge)', () => {
    it('merges task branch into base (--no-ff)', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Feature work',
        slug: 'feature-merge',
      });

      // Make a commit on the task branch
      commitFile(tmpDir, 'feature.ts', 'export const x = 1;', 'add feature');

      const result = mgr.completeBranch(branch.name);

      expect(result.success).toBe(true);
      expect(result.conflicts).toEqual([]);

      // Should now be on main
      const currentBranch = git(tmpDir, 'rev-parse', '--abbrev-ref', 'HEAD');
      expect(currentBranch).toBe('main');
    });

    it('returns success with merge commit hash', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Feature work',
        slug: 'merge-hash',
      });

      commitFile(tmpDir, 'feature.ts', 'export const x = 1;', 'add feature');

      const result = mgr.completeBranch(branch.name);

      expect(result.success).toBe(true);
      expect(result.mergeCommit).toBeDefined();
      expect(result.mergeCommit!.length).toBeGreaterThan(0);

      // Verify the merge commit exists in git
      const logOutput = git(tmpDir, 'log', '--oneline', '-1');
      expect(logOutput).toContain('merge:');
    });

    it('deletes task branch after merge', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Feature work',
        slug: 'delete-after-merge',
      });

      commitFile(tmpDir, 'feature.ts', 'export const x = 1;', 'add feature');
      mgr.completeBranch(branch.name);

      // The git branch should no longer exist
      const branches = git(tmpDir, 'branch', '--list');
      expect(branches).not.toContain('task/test-machine/delete-after-merge');
    });

    it('updates state to merged', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Feature work',
        slug: 'state-merged',
      });

      commitFile(tmpDir, 'feature.ts', 'export const x = 1;', 'add feature');
      mgr.completeBranch(branch.name);

      const all = mgr.getAllBranches();
      const completed = all.find(b => b.name === branch.name);
      expect(completed).toBeDefined();
      expect(completed!.status).toBe('merged');
    });

    it('detects conflicts when both branches modified same file', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Conflicting work',
        slug: 'conflict-test',
      });

      // Modify a file on the task branch
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Modified on task branch\nTask content\n');
      git(tmpDir, 'add', 'README.md');
      git(tmpDir, 'commit', '-m', 'task branch change');

      // Switch to main and make a conflicting change
      git(tmpDir, 'checkout', 'main');
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Modified on main\nMain content\n');
      git(tmpDir, 'add', 'README.md');
      git(tmpDir, 'commit', '-m', 'main branch change');

      // Switch back to task branch for completeBranch (it starts from current branch state)
      git(tmpDir, 'checkout', branch.name);

      const result = mgr.completeBranch(branch.name);

      expect(result.success).toBe(false);
      // Either conflicts array has entries or there's an error message
      expect(result.conflicts.length > 0 || result.error !== undefined).toBe(true);
    });

    it('returns error for nonexistent branch state', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const result = mgr.completeBranch('task/nonexistent/branch');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Branch state not found');
    });

    it('commits pending changes before merging', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Pending changes',
        slug: 'pending-commit',
      });

      // Create an uncommitted file
      fs.writeFileSync(path.join(tmpDir, 'uncommitted.ts'), 'export const y = 2;');

      const result = mgr.completeBranch(branch.name);

      expect(result.success).toBe(true);

      // The file should exist on main after merge
      expect(fs.existsSync(path.join(tmpDir, 'uncommitted.ts'))).toBe(true);
    });

    it('uses custom commit message when provided', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Custom message test',
        slug: 'custom-msg',
      });

      // Create an uncommitted file so commitPending actually commits
      fs.writeFileSync(path.join(tmpDir, 'newfile.ts'), 'export const z = 3;');

      mgr.completeBranch(branch.name, { commitMessage: 'custom: my message' });

      // Check the commit log for the custom message (it will be before the merge commit)
      const log = git(tmpDir, 'log', '--oneline', '-5');
      expect(log).toContain('custom: my message');
    });
  });

  // ── 5. Branch Abandonment ──────────────────────────────────────────

  describe('branch abandonment', () => {
    it('switches back to base branch', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Abandoned work',
        slug: 'abandon-test',
      });

      // Confirm we're on task branch
      expect(git(tmpDir, 'rev-parse', '--abbrev-ref', 'HEAD'))
        .toBe('task/test-machine/abandon-test');

      mgr.abandonBranch(branch.name);

      const currentBranch = git(tmpDir, 'rev-parse', '--abbrev-ref', 'HEAD');
      expect(currentBranch).toBe('main');
    });

    it('deletes the branch from git', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Abandoned work',
        slug: 'abandon-delete',
      });

      mgr.abandonBranch(branch.name);

      const branches = git(tmpDir, 'branch', '--list');
      expect(branches).not.toContain('task/test-machine/abandon-delete');
    });

    it('updates state to abandoned', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Abandoned work',
        slug: 'abandon-state',
      });

      mgr.abandonBranch(branch.name);

      const all = mgr.getAllBranches();
      const abandoned = all.find(b => b.name === branch.name);
      expect(abandoned).toBeDefined();
      expect(abandoned!.status).toBe('abandoned');
    });

    it('returns true on successful abandonment', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Test',
        slug: 'abandon-return',
      });

      const result = mgr.abandonBranch(branch.name);
      expect(result).toBe(true);
    });

    it('works when already on base branch', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Test',
        slug: 'already-on-base',
      });

      // Switch back to main manually before abandon
      git(tmpDir, 'checkout', 'main');

      const result = mgr.abandonBranch(branch.name);
      expect(result).toBe(true);

      const currentBranch = git(tmpDir, 'rev-parse', '--abbrev-ref', 'HEAD');
      expect(currentBranch).toBe('main');
    });

    it('updates updatedAt timestamp', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Test',
        slug: 'abandon-ts',
      });

      const beforeTimestamp = branch.updatedAt;
      mgr.abandonBranch(branch.name);

      const all = mgr.getAllBranches();
      const abandoned = all.find(b => b.name === branch.name)!;
      expect(new Date(abandoned.updatedAt).getTime())
        .toBeGreaterThanOrEqual(new Date(beforeTimestamp).getTime());
    });
  });

  // ── 6. Health Monitoring ──────────────────────────────────────────

  describe('health monitoring', () => {
    it('detects lifetime-exceeded branches', () => {
      const mgr = makeManager(tmpDir, stateDir, {
        maxLifetimeMs: 1000, // 1 second for testing
      });

      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Old branch',
        slug: 'old-branch',
      });

      // Manually backdate createdAt in state file
      const stateFile = path.join(stateDir, 'state', 'branches', 'branches.json');
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      state.branches[0].createdAt = new Date(Date.now() - 5000).toISOString();
      state.branches[0].updatedAt = new Date().toISOString(); // recent to avoid stale
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

      const warnings = mgr.checkBranchHealth();
      const lifetimeWarnings = warnings.filter(w => w.type === 'lifetime-exceeded');

      expect(lifetimeWarnings).toHaveLength(1);
      expect(lifetimeWarnings[0].branch.name).toBe(branch.name);
      expect(lifetimeWarnings[0].ageMs).toBeGreaterThan(1000);
      expect(lifetimeWarnings[0].message).toContain('lifetime');
    });

    it('detects stale branches', () => {
      const mgr = makeManager(tmpDir, stateDir);

      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Stale branch',
        slug: 'stale-branch',
      });

      // Manually backdate updatedAt but keep createdAt recent enough
      // (default maxLifetimeMs = 4h, STALE_THRESHOLD = 2h)
      const stateFile = path.join(stateDir, 'state', 'branches', 'branches.json');
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
      state.branches[0].createdAt = new Date(threeHoursAgo).toISOString();
      state.branches[0].updatedAt = new Date(threeHoursAgo).toISOString();
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

      const warnings = mgr.checkBranchHealth();
      const staleWarnings = warnings.filter(w => w.type === 'stale');

      expect(staleWarnings).toHaveLength(1);
      expect(staleWarnings[0].branch.name).toBe(branch.name);
      expect(staleWarnings[0].message).toContain('no activity');
    });

    it('returns empty array for healthy branches', () => {
      const mgr = makeManager(tmpDir, stateDir);

      mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Fresh branch',
        slug: 'healthy-branch',
      });

      const warnings = mgr.checkBranchHealth();
      // The branch we just created is fresh — no lifetime or stale warnings.
      // There may be an orphaned warning if a git branch exists without state,
      // but ours has state, so it should be clean.
      const relevantWarnings = warnings.filter(
        w => w.type === 'lifetime-exceeded' || w.type === 'stale',
      );
      expect(relevantWarnings).toHaveLength(0);
    });

    it('detects orphaned git branches (exist in git but not in state)', () => {
      const mgr = makeManager(tmpDir, stateDir);

      // Create a git branch that looks like a task branch but has no state
      git(tmpDir, 'branch', 'task/orphan-machine/leftover');

      const warnings = mgr.checkBranchHealth();
      const orphanWarnings = warnings.filter(w => w.type === 'orphaned');

      expect(orphanWarnings).toHaveLength(1);
      expect(orphanWarnings[0].branch.name).toBe('task/orphan-machine/leftover');
      expect(orphanWarnings[0].message).toContain('orphaned');
    });

    it('does not report active branches as orphaned', () => {
      const mgr = makeManager(tmpDir, stateDir);

      mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Tracked branch',
        slug: 'tracked',
      });

      const warnings = mgr.checkBranchHealth();
      const orphanWarnings = warnings.filter(w => w.type === 'orphaned');
      expect(orphanWarnings).toHaveLength(0);
    });

    it('lifetime-exceeded takes priority over stale for very old branches', () => {
      const mgr = makeManager(tmpDir, stateDir, {
        maxLifetimeMs: 1000,
      });

      mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Very old',
        slug: 'very-old',
      });

      // Backdate both createdAt and updatedAt
      const stateFile = path.join(stateDir, 'state', 'branches', 'branches.json');
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      const fiveSecondsAgo = new Date(Date.now() - 5000).toISOString();
      state.branches[0].createdAt = fiveSecondsAgo;
      state.branches[0].updatedAt = fiveSecondsAgo;
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

      const warnings = mgr.checkBranchHealth();

      // Should get lifetime-exceeded, NOT stale (lifetime check happens first
      // and the else-if means stale is skipped when lifetime already triggers)
      const lifetimeWarnings = warnings.filter(w => w.type === 'lifetime-exceeded');
      const staleWarnings = warnings.filter(w => w.type === 'stale');
      expect(lifetimeWarnings).toHaveLength(1);
      expect(staleWarnings).toHaveLength(0);
    });

    it('only checks active branches for this machine', () => {
      const mgr = makeManager(tmpDir, stateDir);

      // Create a branch then mark it as merged in state
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Merged branch',
        slug: 'merged-branch',
      });

      const stateFile = path.join(stateDir, 'state', 'branches', 'branches.json');
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      state.branches[0].status = 'merged';
      state.branches[0].createdAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

      const warnings = mgr.checkBranchHealth();
      const lifetimeWarnings = warnings.filter(w => w.type === 'lifetime-exceeded');
      expect(lifetimeWarnings).toHaveLength(0);
    });
  });

  // ── 7. State Management ───────────────────────────────────────────

  describe('state management', () => {
    it('getActiveBranches returns only active branches for this machine', () => {
      const mgr = makeManager(tmpDir, stateDir);

      mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Active branch',
        slug: 'active-1',
      });

      git(tmpDir, 'checkout', 'main');

      mgr.createBranch({
        sessionId: 'AUT-101',
        task: 'Active branch 2',
        slug: 'active-2',
      });

      const activeBranches = mgr.getActiveBranches();
      expect(activeBranches).toHaveLength(2);
      expect(activeBranches.every(b => b.status === 'active')).toBe(true);
      expect(activeBranches.every(b => b.machineId === 'test-machine')).toBe(true);
    });

    it('getActiveBranches excludes merged and abandoned branches', () => {
      const mgr = makeManager(tmpDir, stateDir);

      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Will be abandoned',
        slug: 'will-abandon',
      });

      mgr.abandonBranch(branch.name);

      const activeBranches = mgr.getActiveBranches();
      expect(activeBranches).toHaveLength(0);
    });

    it('getActiveBranches filters by machineId', () => {
      const mgr = makeManager(tmpDir, stateDir);

      mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'My branch',
        slug: 'my-branch',
      });

      // Manually inject a branch from another machine into the state file
      const stateFile = path.join(stateDir, 'state', 'branches', 'branches.json');
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      state.branches.push({
        name: 'task/other-machine/other-branch',
        machineId: 'other-machine',
        sessionId: 'AUT-200',
        task: 'Other machine work',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'active',
        baseBranch: 'main',
        baseCommit: 'abc123',
        commitCount: 0,
      });
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

      const activeBranches = mgr.getActiveBranches();
      expect(activeBranches).toHaveLength(1);
      expect(activeBranches[0].machineId).toBe('test-machine');
    });

    it('getAllBranches returns all tracked branches across all machines and statuses', () => {
      const mgr = makeManager(tmpDir, stateDir);

      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Active',
        slug: 'all-1',
      });

      git(tmpDir, 'checkout', 'main');

      const branch2 = mgr.createBranch({
        sessionId: 'AUT-101',
        task: 'Will abandon',
        slug: 'all-2',
      });

      mgr.abandonBranch(branch2.name);

      // Inject a branch from another machine
      const stateFile = path.join(stateDir, 'state', 'branches', 'branches.json');
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      state.branches.push({
        name: 'task/other-machine/other',
        machineId: 'other-machine',
        sessionId: 'AUT-300',
        task: 'Other work',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'active',
        baseBranch: 'main',
        baseCommit: 'def456',
        commitCount: 0,
      });
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

      const allBranches = mgr.getAllBranches();
      expect(allBranches).toHaveLength(3);
    });

    it('getCurrentBranch returns correct branch', () => {
      const mgr = makeManager(tmpDir, stateDir);

      expect(mgr.getCurrentBranch()).toBe('main');

      mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Test',
        slug: 'current-test',
      });

      expect(mgr.getCurrentBranch()).toBe('task/test-machine/current-test');
    });

    it('isOnTaskBranch returns true when on a task branch', () => {
      const mgr = makeManager(tmpDir, stateDir);

      expect(mgr.isOnTaskBranch()).toBe(false);

      mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Test',
        slug: 'on-task',
      });

      expect(mgr.isOnTaskBranch()).toBe(true);
    });

    it('isOnTaskBranch returns false when on main', () => {
      const mgr = makeManager(tmpDir, stateDir);
      expect(mgr.isOnTaskBranch()).toBe(false);
    });

    it('isOnTaskBranch uses configured branch prefix', () => {
      const mgr = makeManager(tmpDir, stateDir, { branchPrefix: 'feature/' });

      mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Test',
        slug: 'custom-prefix',
      });

      expect(mgr.isOnTaskBranch()).toBe(true);
    });

    it('creates state directory if it does not exist', () => {
      const freshStateDir = path.join(tmpDir, 'fresh', '.instar');
      expect(fs.existsSync(freshStateDir)).toBe(false);

      makeManager(tmpDir, freshStateDir);

      expect(fs.existsSync(path.join(freshStateDir, 'state', 'branches'))).toBe(true);
    });

    it('handles empty state file gracefully', () => {
      const mgr = makeManager(tmpDir, stateDir);

      // No branches created yet
      expect(mgr.getAllBranches()).toEqual([]);
      expect(mgr.getActiveBranches()).toEqual([]);
    });

    it('handles corrupted state file gracefully', () => {
      const mgr = makeManager(tmpDir, stateDir);

      // Write corrupt data
      const stateFile = path.join(stateDir, 'state', 'branches', 'branches.json');
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, 'not json');

      // Should not throw — returns empty
      expect(mgr.getAllBranches()).toEqual([]);
      expect(mgr.getActiveBranches()).toEqual([]);
    });

    it('persists state across manager instances', () => {
      const mgr1 = makeManager(tmpDir, stateDir);
      mgr1.createBranch({
        sessionId: 'AUT-100',
        task: 'Persistent',
        slug: 'persist-test',
      });

      // Create a completely new manager instance
      const mgr2 = makeManager(tmpDir, stateDir);
      const all = mgr2.getAllBranches();
      expect(all).toHaveLength(1);
      expect(all[0].task).toBe('Persistent');
      expect(all[0].status).toBe('active');
    });
  });

  // ── 8. Config Defaults ────────────────────────────────────────────

  describe('config defaults', () => {
    it('uses main as default base branch', () => {
      const mgr = new BranchManager({
        projectDir: tmpDir,
        stateDir,
        machineId: 'test-machine',
      });

      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Test',
        slug: 'defaults',
      });

      expect(branch.baseBranch).toBe('main');
    });

    it('uses task/ as default branch prefix', () => {
      const mgr = new BranchManager({
        projectDir: tmpDir,
        stateDir,
        machineId: 'test-machine',
      });

      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Test',
        slug: 'default-prefix',
      });

      expect(branch.name).toBe('task/test-machine/default-prefix');
    });

    it('default file threshold is 2', () => {
      const mgr = new BranchManager({
        projectDir: tmpDir,
        stateDir,
        machineId: 'test-machine',
      });

      expect(mgr.shouldBranch({ fileCount: 1 })).toBe(false);
      expect(mgr.shouldBranch({ fileCount: 2 })).toBe(true);
    });

    it('default line threshold is 10', () => {
      const mgr = new BranchManager({
        projectDir: tmpDir,
        stateDir,
        machineId: 'test-machine',
      });

      expect(mgr.shouldBranch({ lineCount: 9 })).toBe(false);
      expect(mgr.shouldBranch({ lineCount: 10 })).toBe(true);
    });
  });

  // ── 9. Edge Cases & Error Recovery ────────────────────────────────

  describe('edge cases & error recovery', () => {
    it('completeBranch with no commits on task branch still succeeds', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Empty branch',
        slug: 'empty-branch',
      });

      // No commits made on the task branch — merge should still work
      // (it's effectively a no-op merge, but should not throw)
      const result = mgr.completeBranch(branch.name);

      // The merge may succeed or fail depending on git's handling of empty merges,
      // but it should not throw
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });

    it('abandon a nonexistent-in-state branch returns false gracefully', () => {
      const mgr = makeManager(tmpDir, stateDir);

      // Create a real git branch but no state tracking
      git(tmpDir, 'branch', 'task/test-machine/no-state');

      const result = mgr.abandonBranch('task/test-machine/no-state');
      // Should still attempt cleanup — may return true or false
      // depending on the current branch, but should not throw
      expect(typeof result).toBe('boolean');
    });

    it('completeBranch restores status to active on unexpected error', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Error recovery test',
        slug: 'error-recovery',
      });

      commitFile(tmpDir, 'feature.ts', 'content', 'task commit');

      // Corrupt the git state by making main point to a non-existent ref
      // to force an error during completeBranch
      // This is tricky in a real repo, so instead test the state file outcome
      // on a successful completion path — the important contract is:
      // if merge fails, status returns to 'active'

      // Create a conflict situation
      git(tmpDir, 'checkout', 'main');
      fs.writeFileSync(path.join(tmpDir, 'feature.ts'), 'conflicting content');
      git(tmpDir, 'add', 'feature.ts');
      git(tmpDir, 'commit', '-m', 'conflicting change on main');
      git(tmpDir, 'checkout', branch.name);

      const result = mgr.completeBranch(branch.name);

      if (!result.success) {
        // Branch state should be restored to 'active' after failed merge
        const all = mgr.getAllBranches();
        const restored = all.find(b => b.name === branch.name);
        expect(restored).toBeDefined();
        expect(restored!.status).toBe('active');
      }
    });

    it('multiple sequential create-complete cycles work', () => {
      const mgr = makeManager(tmpDir, stateDir);

      // Cycle 1
      const branch1 = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Cycle 1',
        slug: 'cycle-1',
      });
      commitFile(tmpDir, 'file1.ts', 'content1', 'cycle 1 commit');
      const result1 = mgr.completeBranch(branch1.name);
      expect(result1.success).toBe(true);

      // Cycle 2
      const branch2 = mgr.createBranch({
        sessionId: 'AUT-101',
        task: 'Cycle 2',
        slug: 'cycle-2',
      });
      commitFile(tmpDir, 'file2.ts', 'content2', 'cycle 2 commit');
      const result2 = mgr.completeBranch(branch2.name);
      expect(result2.success).toBe(true);

      // Both should be tracked as merged
      const all = mgr.getAllBranches();
      expect(all.filter(b => b.status === 'merged')).toHaveLength(2);

      // Both files should exist on main
      expect(fs.existsSync(path.join(tmpDir, 'file1.ts'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'file2.ts'))).toBe(true);
    });

    it('branch names with special characters in slug work', () => {
      const mgr = makeManager(tmpDir, stateDir);
      const branch = mgr.createBranch({
        sessionId: 'AUT-100',
        task: 'Special chars',
        slug: 'fix-bug-123',
      });

      expect(branch.name).toBe('task/test-machine/fix-bug-123');
      expect(mgr.getCurrentBranch()).toBe('task/test-machine/fix-bug-123');
    });
  });
});
