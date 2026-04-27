/**
 * Wiring Integrity Tests for BranchManager
 *
 * Per TESTING-INTEGRITY-SPEC Category 1: "For every dependency-injected function, test that:
 *   1. It is not null/undefined when the feature is enabled
 *   2. It is not a no-op (calling it produces observable side effects)
 *   3. It delegates to the real implementation (not a stub)"
 *
 * These tests verify BranchManager produces real git and filesystem side effects:
 * - Construction creates state directories
 * - shouldBranch() produces different results for different inputs
 * - createBranch/completeBranch operate on real git repos
 * - Config propagation works for custom and default values
 * - Machine isolation filters branches correctly
 *
 * Every test uses a real temporary git repository to verify actual behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { BranchManager } from '../../src/core/BranchManager.js';
import type { BranchManagerConfig, TaskBranch } from '../../src/core/BranchManager.js';

// ── Helpers ─────────────────────────────────────────────────────────

function makeConfig(
  projectDir: string,
  stateDir: string,
  machineId = 'test-machine-001',
  overrides?: Partial<BranchManagerConfig>,
): BranchManagerConfig {
  return {
    projectDir,
    stateDir,
    machineId,
    ...overrides,
  };
}

function branchStateDir(stateDir: string): string {
  return path.join(stateDir, 'state', 'branches');
}

function branchStateFile(stateDir: string): string {
  return path.join(branchStateDir(stateDir), 'branches.json');
}

function git(cwd: string, ...args: string[]): string {
  // safe-git-allow: incremental-migration
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 10_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Create a commit with a dummy file change so branches have diverging history.
 */
function commitFile(cwd: string, filename: string, content: string, message: string): void {
  fs.writeFileSync(path.join(cwd, filename), content);
  git(cwd, 'add', filename);
  git(cwd, 'commit', '-m', message);
}

// ── Tests ───────────────────────────────────────────────────────────

describe('BranchManager wiring integrity', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-wiring-'));
    stateDir = path.join(tmpDir, '.instar');

    // Initialize a real git repository
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
    // Ensure we're not on a branch that would block cleanup
    try {
      git(tmpDir, 'checkout', 'main');
    } catch {
      // Repo may already be cleaned up
    }
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Category 1: Construction — not null/undefined ─────────────────

  describe('construction', () => {
    it('BranchManager is defined and correct type when constructed with valid config', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir));
      expect(mgr).toBeDefined();
      expect(mgr).not.toBeNull();
      expect(mgr).toBeInstanceOf(BranchManager);
    });

    it('branch state directory is created on construction', () => {
      const dir = branchStateDir(stateDir);
      expect(fs.existsSync(dir)).toBe(false);

      new BranchManager(makeConfig(tmpDir, stateDir));

      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    });

    it('construction is idempotent (no error on second construction with same stateDir)', () => {
      new BranchManager(makeConfig(tmpDir, stateDir));
      const mgr2 = new BranchManager(makeConfig(tmpDir, stateDir));
      expect(mgr2).toBeDefined();
      expect(fs.existsSync(branchStateDir(stateDir))).toBe(true);
    });
  });

  // ── Category 2: shouldBranch() is functional (not a stub) ─────────

  describe('shouldBranch() is functional', () => {
    it('returns false when both counts are below thresholds', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir));
      // Default thresholds: fileCount >= 2, lineCount >= 10
      const result = mgr.shouldBranch({ fileCount: 1, lineCount: 5 });
      expect(result).toBe(false);
    });

    it('returns true when fileCount meets threshold', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir));
      const result = mgr.shouldBranch({ fileCount: 2, lineCount: 0 });
      expect(result).toBe(true);
    });

    it('returns true when lineCount meets threshold', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir));
      const result = mgr.shouldBranch({ fileCount: 0, lineCount: 10 });
      expect(result).toBe(true);
    });

    it('produces different results for different inputs (not a no-op)', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir));
      const belowThreshold = mgr.shouldBranch({ fileCount: 1, lineCount: 5 });
      const aboveThreshold = mgr.shouldBranch({ fileCount: 5, lineCount: 50 });

      expect(belowThreshold).toBe(false);
      expect(aboveThreshold).toBe(true);
      expect(belowThreshold).not.toBe(aboveThreshold);
    });

    it('returns false when no counts are provided', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir));
      const result = mgr.shouldBranch({});
      expect(result).toBe(false);
    });

    it('respects custom thresholds from config', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir, 'test-machine-001', {
        fileCountThreshold: 5,
        lineCountThreshold: 50,
      }));

      // Below custom thresholds but above defaults
      expect(mgr.shouldBranch({ fileCount: 3, lineCount: 20 })).toBe(false);
      // At custom thresholds
      expect(mgr.shouldBranch({ fileCount: 5 })).toBe(true);
      expect(mgr.shouldBranch({ lineCount: 50 })).toBe(true);
    });
  });

  // ── Category 3: Branch state file operations ──────────────────────

  describe('branch state file operations', () => {
    it('createBranch writes state to disk (verified via raw fs.readFileSync)', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir));

      mgr.createBranch({
        sessionId: 'AUT-500',
        task: 'Refactor auth module',
        slug: 'refactor-auth',
      });

      const filePath = branchStateFile(stateDir);
      expect(fs.existsSync(filePath)).toBe(true);

      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);

      expect(parsed).toHaveProperty('branches');
      expect(parsed.branches).toHaveLength(1);
      expect(parsed.branches[0].sessionId).toBe('AUT-500');
      expect(parsed.branches[0].task).toBe('Refactor auth module');
      expect(parsed.branches[0].status).toBe('active');
    });

    it('state file is valid JSON', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir));

      mgr.createBranch({
        sessionId: 'AUT-501',
        task: 'JSON validity test',
        slug: 'json-test',
      });

      const raw = fs.readFileSync(branchStateFile(stateDir), 'utf-8');
      // Should not throw — valid JSON
      const parsed = JSON.parse(raw);

      expect(parsed).toHaveProperty('branches');
      expect(Array.isArray(parsed.branches)).toBe(true);

      const branch = parsed.branches[0];
      expect(branch).toHaveProperty('name');
      expect(branch).toHaveProperty('machineId');
      expect(branch).toHaveProperty('sessionId');
      expect(branch).toHaveProperty('task');
      expect(branch).toHaveProperty('createdAt');
      expect(branch).toHaveProperty('updatedAt');
      expect(branch).toHaveProperty('status');
      expect(branch).toHaveProperty('baseBranch');
      expect(branch).toHaveProperty('baseCommit');
      expect(branch).toHaveProperty('commitCount');
    });

    it('multiple branches accumulate in same state file', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir));

      // Create first branch, then switch back to main for second
      mgr.createBranch({ sessionId: 'AUT-502', task: 'First task', slug: 'first' });
      git(tmpDir, 'checkout', 'main');

      mgr.createBranch({ sessionId: 'AUT-503', task: 'Second task', slug: 'second' });
      git(tmpDir, 'checkout', 'main');

      mgr.createBranch({ sessionId: 'AUT-504', task: 'Third task', slug: 'third' });

      const raw = fs.readFileSync(branchStateFile(stateDir), 'utf-8');
      const parsed = JSON.parse(raw);

      expect(parsed.branches).toHaveLength(3);
      const tasks = parsed.branches.map((b: TaskBranch) => b.task);
      expect(tasks).toContain('First task');
      expect(tasks).toContain('Second task');
      expect(tasks).toContain('Third task');
    });

    it('state file records correct branch name format', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir, 'machine-alpha'));

      mgr.createBranch({
        sessionId: 'AUT-505',
        task: 'Name format test',
        slug: 'my-feature',
      });

      const raw = fs.readFileSync(branchStateFile(stateDir), 'utf-8');
      const parsed = JSON.parse(raw);

      expect(parsed.branches[0].name).toBe('task/machine-alpha/my-feature');
      expect(parsed.branches[0].machineId).toBe('machine-alpha');
    });
  });

  // ── Category 4: Git operations are real (not no-op) ───────────────

  describe('git operations are real', () => {
    it('createBranch actually creates a git branch (verified via git branch --list)', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir, 'machine-beta'));

      mgr.createBranch({
        sessionId: 'AUT-600',
        task: 'Create branch test',
        slug: 'feature-x',
      });

      const branches = git(tmpDir, 'branch', '--list');
      expect(branches).toContain('task/machine-beta/feature-x');
    });

    it('createBranch switches the working tree to the new branch', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir));

      const branch = mgr.createBranch({
        sessionId: 'AUT-601',
        task: 'Switch test',
        slug: 'switch-test',
      });

      const currentBranch = git(tmpDir, 'rev-parse', '--abbrev-ref', 'HEAD');
      expect(currentBranch).toBe(branch.name);
    });

    it('getCurrentBranch returns real git branch name', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir));

      // Before creating a branch, should be on main
      expect(mgr.getCurrentBranch()).toBe('main');

      mgr.createBranch({
        sessionId: 'AUT-602',
        task: 'getCurrentBranch test',
        slug: 'current-branch',
      });

      expect(mgr.getCurrentBranch()).toBe('task/test-machine-001/current-branch');
    });

    it('completeBranch actually merges (verified via commits on main)', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir, 'machine-gamma'));

      // Create branch and add a commit
      const branch = mgr.createBranch({
        sessionId: 'AUT-603',
        task: 'Merge test',
        slug: 'merge-test',
      });

      commitFile(tmpDir, 'feature.ts', 'export const x = 1;\n', 'feat: add feature');

      // Record main's commit count before merge
      git(tmpDir, 'checkout', 'main');
      const mainLogBefore = git(tmpDir, 'log', '--oneline');
      const commitCountBefore = mainLogBefore.split('\n').length;
      git(tmpDir, 'checkout', branch.name);

      // Complete the branch (merge back to main)
      const result = mgr.completeBranch(branch.name);

      expect(result.success).toBe(true);
      expect(result.mergeCommit).toBeDefined();
      expect(result.conflicts).toHaveLength(0);

      // Verify we're back on main
      const currentBranch = git(tmpDir, 'rev-parse', '--abbrev-ref', 'HEAD');
      expect(currentBranch).toBe('main');

      // Verify main has more commits now
      const mainLogAfter = git(tmpDir, 'log', '--oneline');
      const commitCountAfter = mainLogAfter.split('\n').length;
      expect(commitCountAfter).toBeGreaterThan(commitCountBefore);

      // Verify the feature file exists on main after merge
      expect(fs.existsSync(path.join(tmpDir, 'feature.ts'))).toBe(true);
    });

    it('completeBranch deletes the task branch from git', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir, 'machine-delta'));

      const branch = mgr.createBranch({
        sessionId: 'AUT-604',
        task: 'Delete test',
        slug: 'delete-test',
      });

      commitFile(tmpDir, 'temp.ts', 'export const y = 2;\n', 'feat: temp file');

      const result = mgr.completeBranch(branch.name);
      expect(result.success).toBe(true);

      // Branch should be deleted from git
      const branches = git(tmpDir, 'branch', '--list');
      expect(branches).not.toContain('task/machine-delta/delete-test');
    });

    it('completeBranch updates state to merged', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir));

      const branch = mgr.createBranch({
        sessionId: 'AUT-605',
        task: 'State update test',
        slug: 'state-test',
      });

      commitFile(tmpDir, 'state.ts', 'export const z = 3;\n', 'feat: state file');

      mgr.completeBranch(branch.name);

      // Read state directly from disk
      const raw = fs.readFileSync(branchStateFile(stateDir), 'utf-8');
      const parsed = JSON.parse(raw);
      const branchState = parsed.branches.find((b: TaskBranch) => b.name === branch.name);

      expect(branchState).toBeDefined();
      expect(branchState.status).toBe('merged');
    });

    it('isOnTaskBranch() reflects actual git state', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir));

      expect(mgr.isOnTaskBranch()).toBe(false);

      mgr.createBranch({
        sessionId: 'AUT-606',
        task: 'isOnTaskBranch test',
        slug: 'on-task-check',
      });

      expect(mgr.isOnTaskBranch()).toBe(true);

      git(tmpDir, 'checkout', 'main');
      expect(mgr.isOnTaskBranch()).toBe(false);
    });

    it('abandonBranch removes the git branch and updates state', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir, 'machine-epsilon'));

      const branch = mgr.createBranch({
        sessionId: 'AUT-607',
        task: 'Abandon test',
        slug: 'abandon-test',
      });

      const result = mgr.abandonBranch(branch.name);
      expect(result).toBe(true);

      // Branch should be gone from git
      const branches = git(tmpDir, 'branch', '--list');
      expect(branches).not.toContain('task/machine-epsilon/abandon-test');

      // State should be updated
      const raw = fs.readFileSync(branchStateFile(stateDir), 'utf-8');
      const parsed = JSON.parse(raw);
      const branchState = parsed.branches.find((b: TaskBranch) => b.name === branch.name);
      expect(branchState.status).toBe('abandoned');

      // Should be back on main
      expect(mgr.getCurrentBranch()).toBe('main');
    });
  });

  // ── Category 5: Config propagation ────────────────────────────────

  describe('config propagation', () => {
    it('custom baseBranch is used correctly', () => {
      // Create a different base branch
      git(tmpDir, 'checkout', '-b', 'develop');
      commitFile(tmpDir, 'dev.md', '# Dev\n', 'init develop');

      const mgr = new BranchManager(makeConfig(tmpDir, stateDir, 'test-machine-001', {
        baseBranch: 'develop',
      }));

      const branch = mgr.createBranch({
        sessionId: 'AUT-700',
        task: 'Custom base test',
        slug: 'custom-base',
      });

      expect(branch.baseBranch).toBe('develop');

      // Add a commit and complete — should merge back to develop, not main
      commitFile(tmpDir, 'custom-base.ts', 'export const b = 1;\n', 'feat: custom base');
      const result = mgr.completeBranch(branch.name);
      expect(result.success).toBe(true);

      // Should be on develop after merge
      expect(mgr.getCurrentBranch()).toBe('develop');

      // The file should exist on develop
      expect(fs.existsSync(path.join(tmpDir, 'custom-base.ts'))).toBe(true);
    });

    it('custom branchPrefix is used in branch names', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir, 'test-machine-001', {
        branchPrefix: 'feature/',
      }));

      const branch = mgr.createBranch({
        sessionId: 'AUT-701',
        task: 'Custom prefix test',
        slug: 'my-feature',
      });

      expect(branch.name).toBe('feature/test-machine-001/my-feature');

      const branches = git(tmpDir, 'branch', '--list');
      expect(branches).toContain('feature/test-machine-001/my-feature');
    });

    it('custom fileCountThreshold is applied in shouldBranch()', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir, 'test-machine-001', {
        fileCountThreshold: 10,
      }));

      // Below custom threshold but above default (2)
      expect(mgr.shouldBranch({ fileCount: 5 })).toBe(false);
      // At custom threshold
      expect(mgr.shouldBranch({ fileCount: 10 })).toBe(true);
    });

    it('custom lineCountThreshold is applied in shouldBranch()', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir, 'test-machine-001', {
        lineCountThreshold: 100,
      }));

      // Below custom threshold but above default (10)
      expect(mgr.shouldBranch({ lineCount: 50 })).toBe(false);
      // At custom threshold
      expect(mgr.shouldBranch({ lineCount: 100 })).toBe(true);
    });

    it('default values are applied when not specified', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir));

      // Default fileCountThreshold is 2
      expect(mgr.shouldBranch({ fileCount: 1 })).toBe(false);
      expect(mgr.shouldBranch({ fileCount: 2 })).toBe(true);

      // Default lineCountThreshold is 10
      expect(mgr.shouldBranch({ lineCount: 9 })).toBe(false);
      expect(mgr.shouldBranch({ lineCount: 10 })).toBe(true);

      // Default baseBranch is 'main'
      const branch = mgr.createBranch({
        sessionId: 'AUT-702',
        task: 'Default base test',
        slug: 'default-base',
      });
      expect(branch.baseBranch).toBe('main');

      // Default branchPrefix is 'task/'
      expect(branch.name).toMatch(/^task\//);
    });
  });

  // ── Category 6: Isolation — machineId filtering ───────────────────

  describe('isolation', () => {
    it('getActiveBranches filters by machineId', () => {
      const mgrA = new BranchManager(makeConfig(tmpDir, stateDir, 'machine-A'));
      const mgrB = new BranchManager(makeConfig(tmpDir, stateDir, 'machine-B'));

      // Machine A creates a branch
      mgrA.createBranch({ sessionId: 'AUT-800', task: 'Task A', slug: 'task-a' });
      git(tmpDir, 'checkout', 'main');

      // Machine B creates a branch
      mgrB.createBranch({ sessionId: 'AUT-801', task: 'Task B', slug: 'task-b' });
      git(tmpDir, 'checkout', 'main');

      // Machine A should only see its own branches
      const activeBranchesA = mgrA.getActiveBranches();
      expect(activeBranchesA).toHaveLength(1);
      expect(activeBranchesA[0].machineId).toBe('machine-A');
      expect(activeBranchesA[0].task).toBe('Task A');

      // Machine B should only see its own branches
      const activeBranchesB = mgrB.getActiveBranches();
      expect(activeBranchesB).toHaveLength(1);
      expect(activeBranchesB[0].machineId).toBe('machine-B');
      expect(activeBranchesB[0].task).toBe('Task B');
    });

    it('getAllBranches returns branches across all machines', () => {
      const mgrA = new BranchManager(makeConfig(tmpDir, stateDir, 'machine-A'));
      const mgrB = new BranchManager(makeConfig(tmpDir, stateDir, 'machine-B'));

      mgrA.createBranch({ sessionId: 'AUT-802', task: 'Task A', slug: 'task-a2' });
      git(tmpDir, 'checkout', 'main');

      mgrB.createBranch({ sessionId: 'AUT-803', task: 'Task B', slug: 'task-b2' });
      git(tmpDir, 'checkout', 'main');

      // getAllBranches should return both
      const all = mgrA.getAllBranches();
      expect(all).toHaveLength(2);

      const machineIds = all.map(b => b.machineId).sort();
      expect(machineIds).toEqual(['machine-A', 'machine-B']);
    });

    it('getActiveBranches excludes merged and abandoned branches', () => {
      const mgr = new BranchManager(makeConfig(tmpDir, stateDir, 'machine-C'));

      // Create and complete a branch
      const completedBranch = mgr.createBranch({ sessionId: 'AUT-804', task: 'To complete', slug: 'complete-me' });
      commitFile(tmpDir, 'complete.ts', 'done\n', 'feat: complete');
      mgr.completeBranch(completedBranch.name);

      // Create and abandon a branch
      const abandonedBranch = mgr.createBranch({ sessionId: 'AUT-805', task: 'To abandon', slug: 'abandon-me' });
      mgr.abandonBranch(abandonedBranch.name);

      // Create an active branch
      mgr.createBranch({ sessionId: 'AUT-806', task: 'Still active', slug: 'active-one' });

      const active = mgr.getActiveBranches();
      expect(active).toHaveLength(1);
      expect(active[0].task).toBe('Still active');
      expect(active[0].status).toBe('active');
    });

    it('machine-specific branch names do not collide', () => {
      const mgrA = new BranchManager(makeConfig(tmpDir, stateDir, 'machine-A'));
      const mgrB = new BranchManager(makeConfig(tmpDir, stateDir, 'machine-B'));

      // Both machines use the same slug
      mgrA.createBranch({ sessionId: 'AUT-807', task: 'Shared slug A', slug: 'shared-slug' });
      git(tmpDir, 'checkout', 'main');

      mgrB.createBranch({ sessionId: 'AUT-808', task: 'Shared slug B', slug: 'shared-slug' });
      git(tmpDir, 'checkout', 'main');

      // Both branches should exist in git with different names
      const branches = git(tmpDir, 'branch', '--list');
      expect(branches).toContain('task/machine-A/shared-slug');
      expect(branches).toContain('task/machine-B/shared-slug');
    });
  });
});
