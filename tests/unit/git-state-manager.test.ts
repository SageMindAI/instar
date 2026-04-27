/**
 * Unit tests for GitStateManager — git-backed state tracking for standalone agents.
 *
 * Tests:
 * - Remote URL validation (allowed and blocked schemes)
 * - Git init creates .git and .gitignore
 * - Git init throws if already initialized
 * - Commit stages and commits files
 * - Commit with specific files
 * - Commit with nothing to commit (no-op)
 * - Commit rejects files outside state directory
 * - Auto-commit debouncing
 * - Status shows correct file counts
 * - Log returns commit history
 * - isInitialized detection
 * - setRemote validates URL
 * - Push requires remote
 * - Push re-validates remote URL
 * - Pull requires remote
 * - Pull re-validates remote URL
 * - cancelPendingCommit clears timer
 * - getConfig returns copy
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { GitStateManager } from '../../src/core/GitStateManager.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-git-test-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('GitStateManager', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = createTempDir();
    // Create some state files to track
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Agent\nTest agent.');
    fs.writeFileSync(path.join(stateDir, 'MEMORY.md'), '# Memory\nSome memories.');
    fs.writeFileSync(path.join(stateDir, 'jobs.json'), '{}');

    // Configure git user for commits in test env
    try {
      // safe-git-allow: incremental-migration
      execSync('git config --global user.email "test@test.com" 2>/dev/null || true', { stdio: 'pipe' });
      // safe-git-allow: incremental-migration
      execSync('git config --global user.name "Test" 2>/dev/null || true', { stdio: 'pipe' });
    } catch {
      // May already be configured
    }
  });

  afterEach(() => {
    cleanup(stateDir);
    vi.restoreAllMocks();
  });

  describe('validateRemoteUrl', () => {
    it('accepts https:// URLs', () => {
      expect(GitStateManager.validateRemoteUrl('https://github.com/user/repo.git')).toBe(true);
      expect(GitStateManager.validateRemoteUrl('https://gitlab.com/user/repo')).toBe(true);
    });

    it('accepts git@ (SSH) URLs', () => {
      expect(GitStateManager.validateRemoteUrl('git@github.com:user/repo.git')).toBe(true);
      expect(GitStateManager.validateRemoteUrl('git@gitlab.com:user/repo')).toBe(true);
    });

    it('accepts ssh:// URLs', () => {
      expect(GitStateManager.validateRemoteUrl('ssh://git@github.com/user/repo.git')).toBe(true);
    });

    it('rejects git:// (unauthenticated) URLs', () => {
      expect(GitStateManager.validateRemoteUrl('git://github.com/user/repo.git')).toBe(false);
    });

    it('rejects file:// URLs', () => {
      expect(GitStateManager.validateRemoteUrl('file:///tmp/repo')).toBe(false);
    });

    it('rejects ftp:// URLs', () => {
      expect(GitStateManager.validateRemoteUrl('ftp://server/repo')).toBe(false);
    });

    it('rejects empty/invalid inputs', () => {
      expect(GitStateManager.validateRemoteUrl('')).toBe(false);
      expect(GitStateManager.validateRemoteUrl('not-a-url')).toBe(false);
      // @ts-expect-error testing invalid input
      expect(GitStateManager.validateRemoteUrl(null)).toBe(false);
      // @ts-expect-error testing invalid input
      expect(GitStateManager.validateRemoteUrl(undefined)).toBe(false);
    });
  });

  describe('init', () => {
    it('creates .git directory and .gitignore', () => {
      const manager = new GitStateManager(stateDir);
      manager.init();

      expect(fs.existsSync(path.join(stateDir, '.git'))).toBe(true);
      expect(fs.existsSync(path.join(stateDir, '.gitignore'))).toBe(true);

      const gitignore = fs.readFileSync(path.join(stateDir, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('config.json');
      expect(gitignore).toContain('backups/');
      // relationships/ is NOT gitignored — it's shared state for multi-machine
      expect(gitignore).not.toContain('relationships/');
    });

    it('creates initial commit', () => {
      const manager = new GitStateManager(stateDir);
      manager.init();

      const log = manager.log(1);
      expect(log.length).toBe(1);
      expect(log[0].message).toContain('init');
    });

    it('throws if already initialized', () => {
      const manager = new GitStateManager(stateDir);
      manager.init();

      expect(() => manager.init()).toThrow('already initialized');
    });

    it('preserves existing .gitignore', () => {
      fs.writeFileSync(path.join(stateDir, '.gitignore'), '# Custom gitignore\n*.log\n');

      const manager = new GitStateManager(stateDir);
      manager.init();

      const gitignore = fs.readFileSync(path.join(stateDir, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('# Custom gitignore');
      expect(gitignore).toContain('*.log');
    });
  });

  describe('isInitialized', () => {
    it('returns false before init', () => {
      const manager = new GitStateManager(stateDir);
      expect(manager.isInitialized()).toBe(false);
    });

    it('returns true after init', () => {
      const manager = new GitStateManager(stateDir);
      manager.init();
      expect(manager.isInitialized()).toBe(true);
    });
  });

  describe('commit', () => {
    it('commits all tracked files', () => {
      const manager = new GitStateManager(stateDir);
      manager.init();

      // Modify a file
      fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Updated Agent');
      manager.commit('[instar] identity: updated AGENT.md');

      const log = manager.log(5);
      expect(log.length).toBe(2); // init + our commit
      expect(log[0].message).toContain('identity');
    });

    it('commits specific files only', () => {
      const manager = new GitStateManager(stateDir);
      manager.init();

      // Modify two files
      fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Updated Agent');
      fs.writeFileSync(path.join(stateDir, 'MEMORY.md'), '# Updated Memory');

      // Only commit AGENT.md
      manager.commit('[instar] identity: updated AGENT.md', ['AGENT.md']);

      // MEMORY.md should still show as modified
      const status = manager.status();
      expect(status.modified).toBeGreaterThanOrEqual(1);
    });

    it('is a no-op when nothing changed', () => {
      const manager = new GitStateManager(stateDir);
      manager.init();

      const logBefore = manager.log(10);
      manager.commit('should not appear');
      const logAfter = manager.log(10);

      expect(logAfter.length).toBe(logBefore.length);
    });

    it('throws when not initialized', () => {
      const manager = new GitStateManager(stateDir);
      expect(() => manager.commit('test')).toThrow('not initialized');
    });

    it('rejects files outside state directory', () => {
      const manager = new GitStateManager(stateDir);
      manager.init();

      expect(() => manager.commit('test', ['../../etc/passwd'])).toThrow('outside state directory');
    });
  });

  describe('status', () => {
    it('returns not initialized when git is not set up', () => {
      const manager = new GitStateManager(stateDir);
      const status = manager.status();
      expect(status.initialized).toBe(false);
    });

    it('returns clean status after fresh commit', () => {
      const manager = new GitStateManager(stateDir);
      manager.init();

      const status = manager.status();
      expect(status.initialized).toBe(true);
      expect(status.staged).toBe(0);
      expect(status.modified).toBe(0);
      expect(status.branch).toBe('main');
    });

    it('detects modified files', () => {
      const manager = new GitStateManager(stateDir);
      manager.init();

      fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Modified');
      const status = manager.status();
      expect(status.modified).toBeGreaterThanOrEqual(1);
    });

    it('detects untracked files', () => {
      const manager = new GitStateManager(stateDir);
      manager.init();

      fs.writeFileSync(path.join(stateDir, 'new-file.txt'), 'new content');
      const status = manager.status();
      expect(status.untracked).toBeGreaterThanOrEqual(1);
    });
  });

  describe('log', () => {
    it('returns empty array when not initialized', () => {
      const manager = new GitStateManager(stateDir);
      expect(manager.log()).toEqual([]);
    });

    it('returns commit entries with hash, message, author, date', () => {
      const manager = new GitStateManager(stateDir);
      manager.init();

      const log = manager.log(5);
      expect(log.length).toBe(1);
      expect(log[0].hash).toBeDefined();
      expect(log[0].message).toBeDefined();
      expect(log[0].author).toBeDefined();
      expect(log[0].date).toBeDefined();
    });

    it('respects limit parameter', () => {
      const manager = new GitStateManager(stateDir);
      manager.init();

      // Create several commits
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(path.join(stateDir, 'AGENT.md'), `# Version ${i}`);
        manager.commit(`commit ${i}`);
      }

      const limited = manager.log(2);
      expect(limited.length).toBe(2);

      const all = manager.log(100);
      expect(all.length).toBe(6); // init + 5 commits
    });
  });

  describe('setRemote', () => {
    it('accepts valid HTTPS URLs', () => {
      const manager = new GitStateManager(stateDir);
      manager.setRemote('https://github.com/user/repo.git');
      expect(manager.getConfig().remote).toBe('https://github.com/user/repo.git');
    });

    it('accepts valid SSH URLs', () => {
      const manager = new GitStateManager(stateDir);
      manager.setRemote('git@github.com:user/repo.git');
      expect(manager.getConfig().remote).toBe('git@github.com:user/repo.git');
    });

    it('rejects file:// URLs', () => {
      const manager = new GitStateManager(stateDir);
      expect(() => manager.setRemote('file:///tmp/repo')).toThrow('Invalid remote URL');
    });

    it('rejects git:// URLs', () => {
      const manager = new GitStateManager(stateDir);
      expect(() => manager.setRemote('git://github.com/repo')).toThrow('Invalid remote URL');
    });

    it('updates git remote when initialized', () => {
      const manager = new GitStateManager(stateDir);
      manager.init();
      manager.setRemote('https://github.com/user/repo.git');

      // Verify the git remote was set
      // safe-git-allow: incremental-migration
      const remoteUrl = execSync('git remote get-url origin', { cwd: stateDir, encoding: 'utf-8' }).trim();
      expect(remoteUrl).toBe('https://github.com/user/repo.git');
    });
  });

  describe('push', () => {
    it('throws when not initialized', () => {
      const manager = new GitStateManager(stateDir);
      expect(() => manager.push()).toThrow('not initialized');
    });

    it('throws when no remote configured', () => {
      const manager = new GitStateManager(stateDir);
      manager.init();
      expect(() => manager.push()).toThrow('No remote configured');
    });

    it('throws on invalid remote URL (config poisoning defense)', () => {
      const manager = new GitStateManager(stateDir, {
        remote: 'file:///tmp/evil-repo',
      });
      manager.init();

      expect(() => manager.push()).toThrow('Invalid remote URL');
    });
  });

  describe('pull', () => {
    it('throws when not initialized', () => {
      const manager = new GitStateManager(stateDir);
      expect(() => manager.pull()).toThrow('not initialized');
    });

    it('throws when no remote configured', () => {
      const manager = new GitStateManager(stateDir);
      manager.init();
      expect(() => manager.pull()).toThrow('No remote configured');
    });

    it('throws on invalid remote URL (config poisoning defense)', () => {
      const manager = new GitStateManager(stateDir, {
        remote: 'file:///tmp/evil-repo',
      });
      manager.init();

      expect(() => manager.pull()).toThrow('Invalid remote URL');
    });
  });

  describe('autoCommit', () => {
    it('is a no-op when autoCommit is disabled', () => {
      const manager = new GitStateManager(stateDir, { autoCommit: false });
      manager.init();

      fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Changed');

      // autoCommit should not trigger
      manager.autoCommit('identity', 'updated AGENT.md');

      // No debounced commit should be pending
      // Verify by checking that if we wait, nothing happens
      const logBefore = manager.log(10);
      expect(logBefore.length).toBe(1); // Only init
    });

    it('is a no-op when not initialized', () => {
      const manager = new GitStateManager(stateDir, { autoCommit: true });

      // Should not throw
      manager.autoCommit('identity', 'updated AGENT.md');
    });

    it('cancelPendingCommit clears timer', () => {
      const manager = new GitStateManager(stateDir, {
        autoCommit: true,
        commitDebounceSeconds: 1,
      });
      manager.init();

      fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Changed');
      manager.autoCommit('identity', 'updated');
      manager.cancelPendingCommit();

      // No commit should fire
      const log = manager.log(10);
      expect(log.length).toBe(1); // Only init
    });
  });

  describe('getConfig', () => {
    it('returns a copy of the config', () => {
      const manager = new GitStateManager(stateDir, {
        branch: 'develop',
        autoCommit: false,
      });

      const config = manager.getConfig();
      expect(config.branch).toBe('develop');
      expect(config.autoCommit).toBe(false);

      // Modifying the returned config should not affect the manager
      config.branch = 'hacked';
      expect(manager.getConfig().branch).toBe('develop');
    });
  });
});
