/**
 * E2E Lifecycle Tests for BranchManager
 *
 * Per TESTING-INTEGRITY-SPEC Category 3: "The full path from user action
 * to user-visible outcome works end-to-end, with controlled (but real)
 * intermediate components."
 *
 * Tests the complete branch lifecycle paths: create -> commit -> merge,
 * conflict detection, abandonment, multi-branch isolation, health
 * monitoring, and the shouldBranch -> createBranch decision integration.
 * Each test exercises a full user-facing path through real git repos.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BranchManager } from '../../src/core/BranchManager.js';
import type { TaskBranch, MergeResult } from '../../src/core/BranchManager.js';

// ── Helpers ──────────────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  // safe-git-allow: incremental-migration
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
    },
  }).trim();
}

/**
 * Create a real git repo with an initial commit. Returns the repo dir.
 */
function createGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-e2e-'));
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);

  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
  // Gitignore .instar so BranchManager state files don't cause
  // dirty-tree errors when switching branches
  fs.writeFileSync(path.join(dir, '.gitignore'), '.instar/\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'init'], dir);

  return dir;
}

/**
 * Create a BranchManager wired to a real git repo.
 */
function createBranchManager(
  projectDir: string,
  stateDir: string,
  overrides?: Partial<{
    machineId: string;
    maxLifetimeMs: number;
    fileCountThreshold: number;
    lineCountThreshold: number;
  }>,
): BranchManager {
  return new BranchManager({
    projectDir,
    stateDir,
    machineId: overrides?.machineId ?? 'test-machine',
    maxLifetimeMs: overrides?.maxLifetimeMs,
    fileCountThreshold: overrides?.fileCountThreshold,
    lineCountThreshold: overrides?.lineCountThreshold,
  });
}

/**
 * Directly manipulate the createdAt/updatedAt of a branch in the state file
 * to simulate time passing without actually waiting.
 */
function setBranchTimestamps(
  stateDir: string,
  branchName: string,
  opts: { createdAt?: Date; updatedAt?: Date },
): void {
  const stateFile = path.join(stateDir, 'state', 'branches', 'branches.json');
  const data = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  const branch = data.branches.find((b: TaskBranch) => b.name === branchName);
  if (!branch) throw new Error(`Branch ${branchName} not found in state file`);
  if (opts.createdAt) branch.createdAt = opts.createdAt.toISOString();
  if (opts.updatedAt) branch.updatedAt = opts.updatedAt.toISOString();
  fs.writeFileSync(stateFile, JSON.stringify(data, null, 2));
}

/**
 * Read the raw branch state file from disk.
 */
function readRawBranchState(stateDir: string): { branches: TaskBranch[] } {
  const stateFile = path.join(stateDir, 'state', 'branches', 'branches.json');
  return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
}

/**
 * List git branches in the repo.
 */
function listGitBranches(cwd: string): string[] {
  const output = git(['branch', '--list'], cwd);
  return output
    .split('\n')
    .map(l => l.replace(/^\*?\s+/, '').trim())
    .filter(l => l.length > 0);
}

/**
 * Get the current git branch.
 */
function currentGitBranch(cwd: string): string {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

// ── Tests ────────────────────────────────────────────────────────────

describe('BranchManager E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = createGitRepo();
    stateDir = path.join(tmpDir, '.instar');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Scenario 1: Full task branch lifecycle ─────────────────────────

  describe('full task branch lifecycle', () => {
    it('create branch -> commit -> complete (auto-merge) -> verify merged + deleted', () => {
      const bm = createBranchManager(tmpDir, stateDir);

      // Step 1: Start on main
      expect(currentGitBranch(tmpDir)).toBe('main');

      // Step 2: Create a task branch
      const branch = bm.createBranch({
        sessionId: 'AUT-100',
        task: 'Add user authentication',
        slug: 'add-auth',
      });

      expect(branch.name).toBe('task/test-machine/add-auth');
      expect(branch.status).toBe('active');
      expect(branch.sessionId).toBe('AUT-100');
      expect(branch.baseBranch).toBe('main');
      expect(branch.commitCount).toBe(0);

      // Verify git actually switched to the branch
      expect(currentGitBranch(tmpDir)).toBe('task/test-machine/add-auth');

      // Step 3: Make commits on the task branch
      fs.writeFileSync(path.join(tmpDir, 'auth.ts'), 'export function login() { return true; }\n');
      git(['add', 'auth.ts'], tmpDir);
      git(['commit', '-m', 'feat: add login function'], tmpDir);

      fs.writeFileSync(path.join(tmpDir, 'middleware.ts'), 'export function authMiddleware() {}\n');
      git(['add', 'middleware.ts'], tmpDir);
      git(['commit', '-m', 'feat: add auth middleware'], tmpDir);

      // Step 4: Update branch metadata to reflect commits
      bm.updateBranch(branch.name);

      // Verify commit count tracked
      const allBranches = bm.getAllBranches();
      const tracked = allBranches.find(b => b.name === branch.name);
      expect(tracked).toBeDefined();
      expect(tracked!.commitCount).toBe(2);

      // Step 5: Complete branch (auto-merge to main)
      const result = bm.completeBranch(branch.name);

      expect(result.success).toBe(true);
      expect(result.conflicts).toHaveLength(0);
      expect(result.mergeCommit).toBeDefined();

      // Step 6: Verify we're back on main
      expect(currentGitBranch(tmpDir)).toBe('main');

      // Step 7: Verify the branch was deleted from git
      const branches = listGitBranches(tmpDir);
      expect(branches).not.toContain('task/test-machine/add-auth');

      // Step 8: Verify merged content is on main
      expect(fs.existsSync(path.join(tmpDir, 'auth.ts'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'middleware.ts'))).toBe(true);

      // Step 9: Verify state updated to 'merged'
      const state = readRawBranchState(stateDir);
      const mergedBranch = state.branches.find(b => b.name === branch.name);
      expect(mergedBranch).toBeDefined();
      expect(mergedBranch!.status).toBe('merged');
    });
  });

  // ── Scenario 2: Merge with conflict detection ─────────────────────

  describe('merge with conflict detection', () => {
    it('fails merge on conflict and preserves branch for resolution', () => {
      const bm = createBranchManager(tmpDir, stateDir);

      // Step 1: Create a shared file on main
      fs.writeFileSync(path.join(tmpDir, 'config.ts'), 'export const PORT = 3000;\n');
      git(['add', 'config.ts'], tmpDir);
      git(['commit', '-m', 'add config'], tmpDir);

      // Step 2: Create a task branch
      const branch = bm.createBranch({
        sessionId: 'AUT-200',
        task: 'Update port configuration',
        slug: 'update-config',
      });
      expect(currentGitBranch(tmpDir)).toBe('task/test-machine/update-config');

      // Step 3: Modify the file on the task branch
      fs.writeFileSync(path.join(tmpDir, 'config.ts'), 'export const PORT = 8080;\nexport const HOST = "0.0.0.0";\n');
      git(['add', 'config.ts'], tmpDir);
      git(['commit', '-m', 'task: update port to 8080'], tmpDir);

      // Step 4: Switch to main and make a CONFLICTING change to the same file
      // safe-git-allow: incremental-migration
      execFileSync('git', ['checkout', 'main'], { cwd: tmpDir });
      fs.writeFileSync(path.join(tmpDir, 'config.ts'), 'export const PORT = 4000;\nexport const DEBUG = true;\n');
      git(['add', 'config.ts'], tmpDir);
      git(['commit', '-m', 'main: update port to 4000'], tmpDir);

      // Switch back to the task branch before completeBranch
      // safe-git-allow: incremental-migration
      execFileSync('git', ['checkout', 'task/test-machine/update-config'], { cwd: tmpDir });

      // Step 5: Try to complete the branch -- merge should fail
      const result = bm.completeBranch(branch.name);

      expect(result.success).toBe(false);
      // Note: BranchManager.performMerge detects conflicts via error message
      // pattern matching. Whether conflicts[] is populated depends on git's
      // error output format. The key invariant is success === false.
      expect(result.error || result.conflicts.length > 0).toBeTruthy();

      // Step 6: Verify the task branch was NOT deleted (preserved for tiered resolution)
      const branches = listGitBranches(tmpDir);
      expect(branches).toContain('task/test-machine/update-config');

      // Step 7: Verify state reverted to 'active' (not stuck in 'merging')
      const state = readRawBranchState(stateDir);
      const conflictedBranch = state.branches.find(b => b.name === branch.name);
      expect(conflictedBranch).toBeDefined();
      expect(conflictedBranch!.status).toBe('active');
    });
  });

  // ── Scenario 3: Branch abandonment lifecycle ──────────────────────

  describe('branch abandonment lifecycle', () => {
    it('abandon -> back on main -> branch deleted -> state is abandoned', () => {
      const bm = createBranchManager(tmpDir, stateDir);

      // Step 1: Create a task branch with some work
      const branch = bm.createBranch({
        sessionId: 'AUT-300',
        task: 'Experimental feature',
        slug: 'experiment',
      });
      expect(currentGitBranch(tmpDir)).toBe('task/test-machine/experiment');

      // Step 2: Make some commits (work that will be abandoned)
      fs.writeFileSync(path.join(tmpDir, 'experiment.ts'), 'export function risky() { throw new Error("nope"); }\n');
      git(['add', 'experiment.ts'], tmpDir);
      git(['commit', '-m', 'wip: experimental feature'], tmpDir);

      // Step 3: Abandon the branch
      const abandoned = bm.abandonBranch(branch.name);
      expect(abandoned).toBe(true);

      // Step 4: Verify we're back on main
      expect(currentGitBranch(tmpDir)).toBe('main');

      // Step 5: Verify branch deleted from git
      const branches = listGitBranches(tmpDir);
      expect(branches).not.toContain('task/test-machine/experiment');

      // Step 6: Verify the abandoned file is NOT on main
      expect(fs.existsSync(path.join(tmpDir, 'experiment.ts'))).toBe(false);

      // Step 7: Verify state updated to 'abandoned'
      const state = readRawBranchState(stateDir);
      const abandonedBranch = state.branches.find(b => b.name === branch.name);
      expect(abandonedBranch).toBeDefined();
      expect(abandonedBranch!.status).toBe('abandoned');
    });
  });

  // ── Scenario 4: Multi-branch scenario ─────────────────────────────

  describe('multi-branch scenario', () => {
    it('two branches created and completed independently without interference', () => {
      const bm = createBranchManager(tmpDir, stateDir);

      // Step 1: Create branch A
      const branchA = bm.createBranch({
        sessionId: 'AUT-400',
        task: 'Feature A',
        slug: 'feature-a',
      });
      expect(currentGitBranch(tmpDir)).toBe('task/test-machine/feature-a');

      // Step 2: Make a commit on branch A
      fs.writeFileSync(path.join(tmpDir, 'feature-a.ts'), 'export const featureA = true;\n');
      git(['add', 'feature-a.ts'], tmpDir);
      git(['commit', '-m', 'feat: add feature A'], tmpDir);

      // Step 3: Switch back to main to create branch B
      // safe-git-allow: incremental-migration
      execFileSync('git', ['checkout', 'main'], { cwd: tmpDir });

      const branchB = bm.createBranch({
        sessionId: 'AUT-401',
        task: 'Feature B',
        slug: 'feature-b',
      });
      expect(currentGitBranch(tmpDir)).toBe('task/test-machine/feature-b');

      // Step 4: Make a commit on branch B (different file -- no conflict)
      fs.writeFileSync(path.join(tmpDir, 'feature-b.ts'), 'export const featureB = true;\n');
      git(['add', 'feature-b.ts'], tmpDir);
      git(['commit', '-m', 'feat: add feature B'], tmpDir);

      // Step 5: Verify both branches exist in git
      const branchesBefore = listGitBranches(tmpDir);
      expect(branchesBefore).toContain('task/test-machine/feature-a');
      expect(branchesBefore).toContain('task/test-machine/feature-b');

      // Step 6: Complete branch A first
      // Need to switch to branch A before completing
      // safe-git-allow: incremental-migration
      execFileSync('git', ['checkout', 'task/test-machine/feature-a'], { cwd: tmpDir });
      const resultA = bm.completeBranch(branchA.name);
      expect(resultA.success).toBe(true);

      // Step 7: Verify branch B still exists after A is merged
      const branchesAfterA = listGitBranches(tmpDir);
      expect(branchesAfterA).not.toContain('task/test-machine/feature-a');
      expect(branchesAfterA).toContain('task/test-machine/feature-b');

      // Step 8: feature-a.ts should be on main now
      expect(currentGitBranch(tmpDir)).toBe('main');
      expect(fs.existsSync(path.join(tmpDir, 'feature-a.ts'))).toBe(true);

      // Step 9: Complete branch B
      // safe-git-allow: incremental-migration
      execFileSync('git', ['checkout', 'task/test-machine/feature-b'], { cwd: tmpDir });
      const resultB = bm.completeBranch(branchB.name);
      expect(resultB.success).toBe(true);

      // Step 10: Both features merged to main
      expect(currentGitBranch(tmpDir)).toBe('main');
      expect(fs.existsSync(path.join(tmpDir, 'feature-a.ts'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'feature-b.ts'))).toBe(true);

      // Step 11: No task branches remain
      const branchesAfterAll = listGitBranches(tmpDir);
      expect(branchesAfterAll).not.toContain('task/test-machine/feature-a');
      expect(branchesAfterAll).not.toContain('task/test-machine/feature-b');

      // Step 12: Both are marked merged in state
      const state = readRawBranchState(stateDir);
      const stateA = state.branches.find(b => b.name === branchA.name);
      const stateB = state.branches.find(b => b.name === branchB.name);
      expect(stateA!.status).toBe('merged');
      expect(stateB!.status).toBe('merged');
    });
  });

  // ── Scenario 5: Branch health monitoring ──────────────────────────

  describe('branch health monitoring', () => {
    it('reports lifetime-exceeded warning for old branches', () => {
      // Use a short maxLifetimeMs so we can test via timestamp manipulation
      const bm = createBranchManager(tmpDir, stateDir, {
        maxLifetimeMs: 4 * 60 * 60 * 1000, // 4 hours (the default)
      });

      // Step 1: Create a branch
      const branch = bm.createBranch({
        sessionId: 'AUT-500',
        task: 'Long-running refactor',
        slug: 'long-refactor',
      });

      // Step 2: No warnings yet -- branch is fresh
      const warningsBefore = bm.checkBranchHealth();
      const lifetimeWarnings = warningsBefore.filter(w => w.type === 'lifetime-exceeded');
      expect(lifetimeWarnings).toHaveLength(0);

      // Step 3: Manipulate createdAt to be >4 hours old
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
      setBranchTimestamps(stateDir, branch.name, {
        createdAt: fiveHoursAgo,
        updatedAt: new Date(), // Keep updatedAt fresh so it's not stale
      });

      // Step 4: Check health -- should report lifetime-exceeded
      const warningsAfter = bm.checkBranchHealth();
      const lifetimeAfter = warningsAfter.filter(w => w.type === 'lifetime-exceeded');
      expect(lifetimeAfter).toHaveLength(1);
      expect(lifetimeAfter[0].branch.name).toBe(branch.name);
      expect(lifetimeAfter[0].message).toContain('lifetime');
      expect(lifetimeAfter[0].ageMs).toBeGreaterThan(4 * 60 * 60 * 1000);
    });

    it('reports stale warning for branches with no recent activity', () => {
      const bm = createBranchManager(tmpDir, stateDir);

      // Step 1: Create a branch
      const branch = bm.createBranch({
        sessionId: 'AUT-501',
        task: 'Feature that gets abandoned',
        slug: 'stale-feature',
      });

      // Step 2: Manipulate updatedAt to be >2 hours old (stale threshold)
      // Keep createdAt recent so it doesn't trigger lifetime-exceeded
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000);
      setBranchTimestamps(stateDir, branch.name, {
        createdAt: oneHourAgo,  // Within lifetime
        updatedAt: threeHoursAgo,  // Past stale threshold
      });

      // Step 3: Check health -- should report stale
      const warnings = bm.checkBranchHealth();
      const staleWarnings = warnings.filter(w => w.type === 'stale');
      expect(staleWarnings).toHaveLength(1);
      expect(staleWarnings[0].branch.name).toBe(branch.name);
      expect(staleWarnings[0].message).toContain('no activity');
      expect(staleWarnings[0].ageMs).toBeGreaterThan(2 * 60 * 60 * 1000);
    });

    it('detects orphaned git branches with no state tracking', () => {
      const bm = createBranchManager(tmpDir, stateDir);

      // Step 1: Create a git branch directly (bypassing BranchManager)
      // so there's a task/ branch with no state file entry
      git(['checkout', '-b', 'task/test-machine/orphaned-work'], tmpDir);
      fs.writeFileSync(path.join(tmpDir, 'orphan.ts'), 'orphan\n');
      git(['add', 'orphan.ts'], tmpDir);
      git(['commit', '-m', 'orphaned work'], tmpDir);
      // safe-git-allow: incremental-migration
      execFileSync('git', ['checkout', 'main'], { cwd: tmpDir });

      // Step 2: Check health -- should detect orphan
      const warnings = bm.checkBranchHealth();
      const orphanWarnings = warnings.filter(w => w.type === 'orphaned');
      expect(orphanWarnings).toHaveLength(1);
      expect(orphanWarnings[0].branch.name).toBe('task/test-machine/orphaned-work');
      expect(orphanWarnings[0].message).toContain('orphaned');
    });
  });

  // ── Scenario 6: shouldBranch + createBranch integration ───────────

  describe('shouldBranch + createBranch decision-to-merge integration', () => {
    it('full decision-to-merge lifecycle: decide -> create -> work -> complete', () => {
      const bm = createBranchManager(tmpDir, stateDir, {
        fileCountThreshold: 2,
        lineCountThreshold: 10,
      });

      // Step 1: Small change -- should NOT branch
      expect(bm.shouldBranch({ fileCount: 1, lineCount: 5 })).toBe(false);

      // Step 2: Larger change -- should branch (file count exceeds threshold)
      expect(bm.shouldBranch({ fileCount: 3, lineCount: 5 })).toBe(true);

      // Step 3: Also branches when line count exceeds threshold
      expect(bm.shouldBranch({ fileCount: 1, lineCount: 15 })).toBe(true);

      // Step 4: Since shouldBranch says yes, create the branch
      const shouldCreate = bm.shouldBranch({ fileCount: 4, lineCount: 50 });
      expect(shouldCreate).toBe(true);

      const branch = bm.createBranch({
        sessionId: 'AUT-600',
        task: 'Multi-file refactor',
        slug: 'multi-refactor',
      });
      expect(branch.status).toBe('active');
      expect(currentGitBranch(tmpDir)).toBe('task/test-machine/multi-refactor');

      // Step 5: Do the work
      fs.writeFileSync(path.join(tmpDir, 'module-a.ts'), 'export const a = 1;\n');
      fs.writeFileSync(path.join(tmpDir, 'module-b.ts'), 'export const b = 2;\n');
      fs.writeFileSync(path.join(tmpDir, 'module-c.ts'), 'export const c = 3;\n');
      git(['add', '.'], tmpDir);
      git(['commit', '-m', 'refactor: split into modules'], tmpDir);

      // Step 6: Update branch metadata
      bm.updateBranch(branch.name);
      const updated = bm.getAllBranches().find(b => b.name === branch.name);
      expect(updated!.commitCount).toBe(1);

      // Step 7: Complete the branch
      const result = bm.completeBranch(branch.name);
      expect(result.success).toBe(true);

      // Step 8: Verify complete lifecycle
      expect(currentGitBranch(tmpDir)).toBe('main');
      expect(fs.existsSync(path.join(tmpDir, 'module-a.ts'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'module-b.ts'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'module-c.ts'))).toBe(true);

      const state = readRawBranchState(stateDir);
      const finalBranch = state.branches.find(b => b.name === branch.name);
      expect(finalBranch!.status).toBe('merged');

      // Task branch no longer in git
      const branches = listGitBranches(tmpDir);
      expect(branches).not.toContain('task/test-machine/multi-refactor');
    });

    it('skips branching for trivial changes and works directly on main', () => {
      const bm = createBranchManager(tmpDir, stateDir, {
        fileCountThreshold: 2,
        lineCountThreshold: 10,
      });

      // Trivial change -- stay on main
      expect(bm.shouldBranch({ fileCount: 1, lineCount: 3 })).toBe(false);

      // Work directly on main (no branch created)
      expect(currentGitBranch(tmpDir)).toBe('main');
      fs.writeFileSync(path.join(tmpDir, 'small-fix.ts'), 'export const fix = true;\n');
      git(['add', 'small-fix.ts'], tmpDir);
      git(['commit', '-m', 'fix: small patch'], tmpDir);

      // File is on main, no branches were created
      expect(fs.existsSync(path.join(tmpDir, 'small-fix.ts'))).toBe(true);
      expect(bm.getActiveBranches()).toHaveLength(0);
    });
  });

  // ── Cross-cutting: isOnTaskBranch and getCurrentBranch ─────────────

  describe('branch awareness helpers', () => {
    it('correctly reports whether we are on a task branch', () => {
      const bm = createBranchManager(tmpDir, stateDir);

      // On main -- not a task branch
      expect(bm.isOnTaskBranch()).toBe(false);
      expect(bm.getCurrentBranch()).toBe('main');

      // Create a task branch
      bm.createBranch({
        sessionId: 'AUT-700',
        task: 'Test branch awareness',
        slug: 'awareness-test',
      });

      expect(bm.isOnTaskBranch()).toBe(true);
      expect(bm.getCurrentBranch()).toBe('task/test-machine/awareness-test');

      // Switch back to main
      // safe-git-allow: incremental-migration
      execFileSync('git', ['checkout', 'main'], { cwd: tmpDir });
      expect(bm.isOnTaskBranch()).toBe(false);
      expect(bm.getCurrentBranch()).toBe('main');
    });
  });

  // ── Cross-cutting: completeBranch with uncommitted changes ─────────

  describe('completeBranch auto-commits pending changes', () => {
    it('auto-commits uncommitted work before merging', () => {
      const bm = createBranchManager(tmpDir, stateDir);

      const branch = bm.createBranch({
        sessionId: 'AUT-800',
        task: 'Work with uncommitted changes',
        slug: 'uncommitted',
      });

      // Make changes but do NOT commit them
      fs.writeFileSync(path.join(tmpDir, 'uncommitted.ts'), 'export const pending = true;\n');

      // completeBranch should auto-commit the pending changes, then merge
      const result = bm.completeBranch(branch.name);
      expect(result.success).toBe(true);

      // Verify the auto-committed file made it to main
      expect(currentGitBranch(tmpDir)).toBe('main');
      expect(fs.existsSync(path.join(tmpDir, 'uncommitted.ts'))).toBe(true);

      const content = fs.readFileSync(path.join(tmpDir, 'uncommitted.ts'), 'utf-8');
      expect(content).toContain('pending');
    });
  });

  // ── Cross-cutting: completeBranch for non-existent state ───────────

  describe('completeBranch error handling', () => {
    it('returns error for branch with no state tracking', () => {
      const bm = createBranchManager(tmpDir, stateDir);

      const result = bm.completeBranch('task/test-machine/nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });
});
