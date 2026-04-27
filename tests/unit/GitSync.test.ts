import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock child_process before importing GitSyncManager
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => ''),
}));

// Mock DegradationReporter to avoid side effects
vi.mock('../../src/monitoring/DegradationReporter.js', () => ({
  DegradationReporter: {
    getInstance: () => ({
      report: vi.fn(),
    }),
  },
}));

// Mock FileClassifier to avoid complex dependency chain
vi.mock('../../src/core/FileClassifier.js', () => ({
  FileClassifier: vi.fn().mockImplementation(() => ({
    classify: vi.fn(() => ({ strategy: 'programmatic' })),
    regenerateLockfile: vi.fn(() => ({ success: false })),
    resolveBinary: vi.fn(() => ({ resolution: 'conflict' })),
  })),
}));

// Mock LLMConflictResolver
vi.mock('../../src/core/LLMConflictResolver.js', () => ({
  LLMConflictResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn(),
  })),
}));

import { execFileSync } from 'node:child_process';
import { GitSyncManager, mergeRelationship, type GitSyncConfig, type RelationshipRecord } from '../../src/core/GitSync.js';

/**
 * GitSync tests — git-based state synchronization.
 *
 * Tests cover:
 * - Constructor config defaults and merging
 * - Auto-commit debounce logic
 * - Commit message generation (categorizePaths)
 * - mergeRelationship pure function
 * - Security log writes
 * - flushAutoCommit behavior
 * - isGitRepo detection
 */

// ── Mock Factories ──────────────────────────────────────────────

function createMockSecurityLog() {
  return {
    append: vi.fn(),
    query: vi.fn(() => []),
    getPath: vi.fn(() => '/tmp/security.jsonl'),
  };
}

function createMockIdentityManager() {
  return {
    loadRegistry: vi.fn(() => ({ machines: {} })),
    loadRemoteIdentity: vi.fn(() => null),
    getLocalIdentity: vi.fn(() => null),
    createIdentity: vi.fn(),
    registerMachine: vi.fn(),
  };
}

let tmpDir: string;

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitsync-test-'));
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  return dir;
}

function createConfig(overrides: Partial<GitSyncConfig> = {}): GitSyncConfig {
  return {
    projectDir: tmpDir,
    stateDir: path.join(tmpDir, '.instar'),
    identityManager: createMockIdentityManager() as any,
    securityLog: createMockSecurityLog() as any,
    machineId: 'test-machine-abc12345',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('GitSyncManager', () => {
  beforeEach(() => {
    tmpDir = makeTmpDir();
    vi.useFakeTimers();
    vi.mocked(execFileSync).mockReset();
    vi.mocked(execFileSync).mockReturnValue('');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    try {
      // safe-git-allow: incremental-migration
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* cleanup best-effort */ }
  });

  // ── Constructor & Config Defaults ───────────────────────────────

  describe('constructor and config defaults', () => {
    it('defaults autoPush to true', () => {
      const config = createConfig();
      const manager = new GitSyncManager(config);
      // Verify via commitAndPush behavior: when autoPush is true, it calls git push
      vi.mocked(execFileSync)
        .mockReturnValueOnce('') // git add
        .mockReturnValueOnce('some-file.json\n') // git diff --cached --name-only (staged files exist)
        .mockReturnValueOnce('') // git commit
        .mockReturnValueOnce(''); // git push (called because autoPush=true)

      manager.commitAndPush('test commit');

      const pushCalls = vi.mocked(execFileSync).mock.calls.filter(
        (call) => call[0] === 'git' && (call[1] as string[]).includes('push')
      );
      expect(pushCalls.length).toBe(1);
    });

    it('respects autoPush=false', () => {
      const config = createConfig({ autoPush: false });
      const manager = new GitSyncManager(config);

      vi.mocked(execFileSync)
        .mockReturnValueOnce('') // git add
        .mockReturnValueOnce('some-file.json\n') // git diff --cached
        .mockReturnValueOnce(''); // git commit

      manager.commitAndPush('test commit');

      const pushCalls = vi.mocked(execFileSync).mock.calls.filter(
        (call) => call[0] === 'git' && (call[1] as string[]).includes('push')
      );
      expect(pushCalls.length).toBe(0);
    });

    it('defaults debounceMs to 30000', () => {
      const config = createConfig();
      const manager = new GitSyncManager(config);

      // Mock: git add succeeds, git diff --cached returns staged files, commit succeeds, push succeeds
      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const a = args as string[];
        if (a[0] === 'diff' && a.includes('--cached')) return 'file.json\n';
        return '';
      });

      manager.queueAutoCommit('/some/file.json');

      // At 29s, nothing should have been committed
      vi.advanceTimersByTime(29_000);
      const commitCallsBefore = vi.mocked(execFileSync).mock.calls.filter(
        (call) => call[0] === 'git' && (call[1] as string[])[0] === 'commit'
      );
      expect(commitCallsBefore.length).toBe(0);

      // At 30s+, the debounce fires
      vi.advanceTimersByTime(2_000);
      const commitCallsAfter = vi.mocked(execFileSync).mock.calls.filter(
        (call) => call[0] === 'git' && (call[1] as string[])[0] === 'commit'
      );
      expect(commitCallsAfter.length).toBe(1);
    });

    it('respects custom debounceMs', () => {
      const config = createConfig({ debounceMs: 5_000 });
      const manager = new GitSyncManager(config);

      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const a = args as string[];
        if (a[0] === 'diff' && a.includes('--cached')) return 'file.json\n';
        return '';
      });

      manager.queueAutoCommit('/some/file.json');

      vi.advanceTimersByTime(4_000);
      const commitCallsBefore = vi.mocked(execFileSync).mock.calls.filter(
        (call) => call[0] === 'git' && (call[1] as string[])[0] === 'commit'
      );
      expect(commitCallsBefore.length).toBe(0);

      vi.advanceTimersByTime(2_000);
      const commitCallsAfter = vi.mocked(execFileSync).mock.calls.filter(
        (call) => call[0] === 'git' && (call[1] as string[])[0] === 'commit'
      );
      expect(commitCallsAfter.length).toBe(1);
    });
  });

  // ── isGitRepo ───────────────────────────────────────────────────

  describe('isGitRepo', () => {
    it('returns false when .git does not exist', () => {
      const manager = new GitSyncManager(createConfig());
      expect(manager.isGitRepo()).toBe(false);
    });

    it('returns true when .git exists', () => {
      fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
      const manager = new GitSyncManager(createConfig());
      expect(manager.isGitRepo()).toBe(true);
    });
  });

  // ── Auto-Commit Debounce ────────────────────────────────────────

  describe('auto-commit debounce', () => {
    it('resets debounce timer on subsequent calls', () => {
      const config = createConfig({ debounceMs: 10_000 });
      const manager = new GitSyncManager(config);
      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const a = args as string[];
        if (a[0] === 'diff' && a.includes('--cached')) return 'file.json\n';
        return '';
      });

      manager.queueAutoCommit('/file-a.json');

      // Advance 8s (before the 10s debounce)
      vi.advanceTimersByTime(8_000);

      // Queue another file — should reset the timer
      manager.queueAutoCommit('/file-b.json');

      // At 8s + 8s = 16s total, still before the RESET timer (10s from second call = 18s)
      vi.advanceTimersByTime(8_000);
      const commitCallsBefore = vi.mocked(execFileSync).mock.calls.filter(
        (call) => call[0] === 'git' && (call[1] as string[])[0] === 'commit'
      );
      expect(commitCallsBefore.length).toBe(0);

      // Advance past the reset timer
      vi.advanceTimersByTime(3_000);
      const commitCallsAfter = vi.mocked(execFileSync).mock.calls.filter(
        (call) => call[0] === 'git' && (call[1] as string[])[0] === 'commit'
      );
      expect(commitCallsAfter.length).toBe(1);
    });

    it('batches multiple queued paths into a single commit', () => {
      const config = createConfig({ debounceMs: 5_000 });
      const manager = new GitSyncManager(config);
      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const a = args as string[];
        if (a[0] === 'diff' && a.includes('--cached')) return 'file.json\n';
        return '';
      });

      manager.queueAutoCommit('/path/relationships/alice.json');
      manager.queueAutoCommit('/path/jobs.json');
      manager.queueAutoCommit('/path/evolution/proposal-1.json');

      vi.advanceTimersByTime(6_000);

      // Should have called git add for each path
      const addCalls = vi.mocked(execFileSync).mock.calls.filter(
        (call) => call[0] === 'git' && (call[1] as string[])[0] === 'add'
      );
      expect(addCalls.length).toBe(3);

      // Only one commit
      const commitCalls = vi.mocked(execFileSync).mock.calls.filter(
        (call) => call[0] === 'git' && (call[1] as string[])[0] === 'commit'
      );
      expect(commitCalls.length).toBe(1);
    });

    it('flushAutoCommit is a no-op when no paths are pending', () => {
      const manager = new GitSyncManager(createConfig());
      vi.mocked(execFileSync).mockReturnValue('');

      manager.flushAutoCommit();

      expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    });

    it('flushAutoCommit clears the debounce timer', () => {
      const config = createConfig({ debounceMs: 10_000 });
      const manager = new GitSyncManager(config);
      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const a = args as string[];
        if (a[0] === 'diff' && a.includes('--cached')) return 'file.json\n';
        return '';
      });

      manager.queueAutoCommit('/some/file.json');

      // Flush immediately
      manager.flushAutoCommit();

      const commitCalls1 = vi.mocked(execFileSync).mock.calls.filter(
        (call) => call[0] === 'git' && (call[1] as string[])[0] === 'commit'
      );
      expect(commitCalls1.length).toBe(1);

      // Advance past the original timer — should NOT double-commit
      vi.mocked(execFileSync).mockClear();
      vi.advanceTimersByTime(15_000);

      expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    });
  });

  // ── Commit Message Generation ───────────────────────────────────

  describe('commit message generation', () => {
    it('generates commit message with machine ID prefix and categories', () => {
      const stateDir = path.join(tmpDir, '.instar');
      const config = createConfig({ debounceMs: 1_000 });
      const manager = new GitSyncManager(config);
      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const a = args as string[];
        if (a[0] === 'diff' && a.includes('--cached')) return 'file.json\n';
        return '';
      });

      // Queue paths that map to different categories
      manager.queueAutoCommit(path.join(stateDir, 'relationships', 'alice.json'));
      manager.queueAutoCommit(path.join(stateDir, 'jobs.json'));

      vi.advanceTimersByTime(2_000);

      const commitCalls = vi.mocked(execFileSync).mock.calls.filter(
        (call) => call[0] === 'git' && (call[1] as string[])[0] === 'commit'
      );
      expect(commitCalls.length).toBe(1);

      const commitMessage = (commitCalls[0][1] as string[])[2]; // -m <message>
      // Should contain truncated machineId
      expect(commitMessage).toContain('sync(test-mac');
      // Should contain categorized labels
      expect(commitMessage).toContain('relationships');
      expect(commitMessage).toContain('jobs');
    });

    it('categorizes config.json paths as "config"', () => {
      const stateDir = path.join(tmpDir, '.instar');
      const config = createConfig({ debounceMs: 1_000 });
      const manager = new GitSyncManager(config);
      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const a = args as string[];
        if (a[0] === 'diff' && a.includes('--cached')) return 'file.json\n';
        return '';
      });

      manager.queueAutoCommit(path.join(stateDir, 'config.json'));
      vi.advanceTimersByTime(2_000);

      const commitCalls = vi.mocked(execFileSync).mock.calls.filter(
        (call) => call[0] === 'git' && (call[1] as string[])[0] === 'commit'
      );
      const commitMessage = (commitCalls[0][1] as string[])[2];
      expect(commitMessage).toContain('config');
    });

    it('categorizes evolution paths correctly', () => {
      const stateDir = path.join(tmpDir, '.instar');
      const config = createConfig({ debounceMs: 1_000 });
      const manager = new GitSyncManager(config);
      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const a = args as string[];
        if (a[0] === 'diff' && a.includes('--cached')) return 'file.json\n';
        return '';
      });

      manager.queueAutoCommit(path.join(stateDir, 'evolution', 'proposals.json'));
      vi.advanceTimersByTime(2_000);

      const commitCalls = vi.mocked(execFileSync).mock.calls.filter(
        (call) => call[0] === 'git' && (call[1] as string[])[0] === 'commit'
      );
      const commitMessage = (commitCalls[0][1] as string[])[2];
      expect(commitMessage).toContain('evolution');
    });

    it('falls back to "state" for unrecognized paths', () => {
      const stateDir = path.join(tmpDir, '.instar');
      const config = createConfig({ debounceMs: 1_000 });
      const manager = new GitSyncManager(config);
      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const a = args as string[];
        if (a[0] === 'diff' && a.includes('--cached')) return 'file.json\n';
        return '';
      });

      manager.queueAutoCommit(path.join(stateDir, 'some-unknown-file.txt'));
      vi.advanceTimersByTime(2_000);

      const commitCalls = vi.mocked(execFileSync).mock.calls.filter(
        (call) => call[0] === 'git' && (call[1] as string[])[0] === 'commit'
      );
      const commitMessage = (commitCalls[0][1] as string[])[2];
      expect(commitMessage).toContain('state');
    });
  });

  // ── commitAndPush ───────────────────────────────────────────────

  describe('commitAndPush', () => {
    it('returns false when nothing is staged', () => {
      const manager = new GitSyncManager(createConfig());
      vi.mocked(execFileSync)
        .mockReturnValueOnce('') // git add
        .mockReturnValueOnce(''); // git diff --cached --name-only (empty)

      const result = manager.commitAndPush('test');
      expect(result).toBe(false);
    });

    it('returns true on successful commit', () => {
      const manager = new GitSyncManager(createConfig());
      vi.mocked(execFileSync)
        .mockReturnValueOnce('') // git add
        .mockReturnValueOnce('file.json\n') // git diff --cached
        .mockReturnValueOnce('') // git commit
        .mockReturnValueOnce(''); // git push

      const result = manager.commitAndPush('test');
      expect(result).toBe(true);
    });

    it('returns false when git operations throw', () => {
      const manager = new GitSyncManager(createConfig());
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('git error');
      });

      const result = manager.commitAndPush('test');
      expect(result).toBe(false);
    });

    it('adds specific paths when provided', () => {
      const manager = new GitSyncManager(createConfig());
      vi.mocked(execFileSync).mockReturnValue('');

      manager.commitAndPush('test', ['/path/a', '/path/b']);

      const addCalls = vi.mocked(execFileSync).mock.calls.filter(
        (call) => call[0] === 'git' && (call[1] as string[])[0] === 'add'
      );
      expect(addCalls.length).toBe(2);
      expect((addCalls[0][1] as string[])[1]).toBe('/path/a');
      expect((addCalls[1][1] as string[])[1]).toBe('/path/b');
    });

    it('defaults to stateDir when no paths provided', () => {
      const config = createConfig();
      const manager = new GitSyncManager(config);
      vi.mocked(execFileSync).mockReturnValue('');

      manager.commitAndPush('test');

      const addCalls = vi.mocked(execFileSync).mock.calls.filter(
        (call) => call[0] === 'git' && (call[1] as string[])[0] === 'add'
      );
      expect(addCalls.length).toBe(1);
      expect((addCalls[0][1] as string[])[1]).toBe(path.join(tmpDir, '.instar'));
    });
  });

  // ── Security Log ────────────────────────────────────────────────

  describe('security log writes', () => {
    it('logs git_sync event after successful sync', async () => {
      fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
      const securityLog = createMockSecurityLog();
      const config = createConfig({ securityLog: securityLog as any, autoPush: false });
      const manager = new GitSyncManager(config);

      // Mock git operations for sync:
      // rev-parse HEAD (before pull), pull --rebase, rev-parse HEAD (after pull)
      vi.mocked(execFileSync)
        .mockReturnValueOnce('abc123') // git rev-parse HEAD (before)
        .mockReturnValueOnce('') // git pull --rebase --autostash
        .mockReturnValueOnce('abc123') // git rev-parse HEAD (after, same = no pull)
        .mockReturnValueOnce(''); // git status --porcelain

      await manager.sync();

      expect(securityLog.append).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'git_sync',
          machineId: 'test-machine-abc12345',
        })
      );
    });
  });

  // ── stop() lifecycle ────────────────────────────────────────────

  describe('stop', () => {
    it('flushes pending auto-commits on stop', () => {
      const config = createConfig({ debounceMs: 60_000 });
      const manager = new GitSyncManager(config);
      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const a = args as string[];
        if (a[0] === 'diff' && a.includes('--cached')) return 'file.json\n';
        return '';
      });

      manager.queueAutoCommit('/some/file.json');

      // Stop should flush immediately without waiting for debounce
      manager.stop();

      const commitCalls = vi.mocked(execFileSync).mock.calls.filter(
        (call) => call[0] === 'git' && (call[1] as string[])[0] === 'commit'
      );
      expect(commitCalls.length).toBe(1);
    });
  });

  // ── sync() pre-flight rebase/detached HEAD recovery ─────────────

  describe('sync pre-flight recovery', () => {
    it('aborts stuck rebase before pulling', async () => {
      fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
      const config = createConfig({ autoPush: false });
      const manager = new GitSyncManager(config);

      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const a = args as string[];
        // Pre-flight: git status returns stuck rebase
        if (a[0] === 'status' && a.length === 1) return 'interactive rebase in progress; onto abc123\n';
        // Pre-flight: git rebase --abort succeeds
        if (a[0] === 'rebase' && a[1] === '--abort') return '';
        // Pre-flight: git symbolic-ref --short HEAD succeeds (on branch after abort)
        if (a[0] === 'symbolic-ref') return 'main';
        // Sync: git rev-parse HEAD
        if (a[0] === 'rev-parse') return 'abc123';
        // Sync: git pull
        if (a[0] === 'pull') return '';
        // Sync: git status --porcelain
        if (a[0] === 'status' && a.includes('--porcelain')) return '';
        return '';
      });

      await manager.sync();

      // Verify rebase --abort was called
      const abortCalls = vi.mocked(execFileSync).mock.calls.filter(
        (call) => call[0] === 'git' && (call[1] as string[])[0] === 'rebase' && (call[1] as string[])[1] === '--abort'
      );
      expect(abortCalls.length).toBe(1);
    });

    it('recovers from detached HEAD by checking out main', async () => {
      fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
      const config = createConfig({ autoPush: false });
      const manager = new GitSyncManager(config);

      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const a = args as string[];
        // Pre-flight: git status is clean (no rebase)
        if (a[0] === 'status' && a.length === 1) return 'On branch main\n';
        // Pre-flight: git symbolic-ref fails (detached HEAD)
        if (a[0] === 'symbolic-ref') throw new Error('fatal: ref HEAD is not a symbolic ref');
        // Pre-flight: git checkout main succeeds
        if (a[0] === 'checkout' && a[1] === 'main') return '';
        // Sync: git rev-parse HEAD
        if (a[0] === 'rev-parse') return 'abc123';
        // Sync: git pull
        if (a[0] === 'pull') return '';
        // Sync: git status --porcelain
        if (a[0] === 'status' && a.includes('--porcelain')) return '';
        return '';
      });

      await manager.sync();

      // Verify checkout main was called
      const checkoutCalls = vi.mocked(execFileSync).mock.calls.filter(
        (call) => call[0] === 'git' && (call[1] as string[])[0] === 'checkout' && (call[1] as string[])[1] === 'main'
      );
      expect(checkoutCalls.length).toBe(1);
    });

    it('returns early with no pull when detached HEAD recovery fails', async () => {
      fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
      const config = createConfig({ autoPush: false });
      const manager = new GitSyncManager(config);

      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const a = args as string[];
        if (a[0] === 'status' && a.length === 1) return 'On branch main\n';
        if (a[0] === 'symbolic-ref') throw new Error('fatal: ref HEAD is not a symbolic ref');
        if (a[0] === 'checkout') throw new Error('error: pathspec not found');
        return '';
      });

      const result = await manager.sync();

      // Should return early with no pull — the preflight gave up
      expect(result.pulled).toBe(false);
      expect(result.pushed).toBe(false);
      // Should NOT have attempted git pull (early return)
      const pullCalls = vi.mocked(execFileSync).mock.calls.filter(
        (call) => call[0] === 'git' && (call[1] as string[])[0] === 'pull'
      );
      expect(pullCalls.length).toBe(0);
    });
  });

  // ── sync() no-op for non-git repos ──────────────────────────────

  describe('sync for non-git repos', () => {
    it('returns clean no-op result when not a git repo', async () => {
      const manager = new GitSyncManager(createConfig());

      const result = await manager.sync();

      expect(result.pulled).toBe(false);
      expect(result.pushed).toBe(false);
      expect(result.commitsPulled).toBe(0);
      expect(result.conflicts).toEqual([]);
      expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    });
  });
});

// ── mergeRelationship (pure function) ─────────────────────────────

describe('mergeRelationship', () => {
  function makeRecord(overrides: Partial<RelationshipRecord> = {}): RelationshipRecord {
    return {
      id: 'rel-1',
      name: 'Alice',
      channels: [{ type: 'telegram', identifier: '12345' }],
      firstInteraction: '2025-01-01T00:00:00Z',
      lastInteraction: '2025-06-01T00:00:00Z',
      interactionCount: 10,
      themes: ['development'],
      notes: 'Main collaborator',
      significance: 5,
      arcSummary: 'Working on project X',
      recentInteractions: [
        { timestamp: '2025-06-01T00:00:00Z', summary: 'Discussed X' },
      ],
      ...overrides,
    };
  }

  it('takes text fields from whichever record has newer lastInteraction', () => {
    const ours = makeRecord({ lastInteraction: '2025-07-01T00:00:00Z', notes: 'Newer notes' });
    const theirs = makeRecord({ lastInteraction: '2025-06-01T00:00:00Z', notes: 'Older notes' });

    const merged = mergeRelationship(ours, theirs);

    expect(merged.notes).toBe('Newer notes');
    expect(merged.arcSummary).toBe(ours.arcSummary);
  });

  it('unions channels by type:identifier', () => {
    const ours = makeRecord({
      channels: [{ type: 'telegram', identifier: '111' }],
    });
    const theirs = makeRecord({
      channels: [
        { type: 'telegram', identifier: '111' }, // duplicate
        { type: 'email', identifier: 'alice@example.com' }, // new
      ],
    });

    const merged = mergeRelationship(ours, theirs);

    expect(merged.channels.length).toBe(2);
    const channelKeys = merged.channels.map(c => `${c.type}:${c.identifier}`);
    expect(channelKeys).toContain('telegram:111');
    expect(channelKeys).toContain('email:alice@example.com');
  });

  it('unions themes (deduplicates)', () => {
    const ours = makeRecord({ themes: ['development', 'testing'] });
    const theirs = makeRecord({ themes: ['testing', 'deployment'] });

    const merged = mergeRelationship(ours, theirs);

    expect(merged.themes).toEqual(expect.arrayContaining(['development', 'testing', 'deployment']));
    expect(merged.themes.length).toBe(3);
  });

  it('takes earliest firstInteraction', () => {
    const ours = makeRecord({ firstInteraction: '2025-03-01T00:00:00Z' });
    const theirs = makeRecord({ firstInteraction: '2025-01-15T00:00:00Z' });

    const merged = mergeRelationship(ours, theirs);

    expect(merged.firstInteraction).toBe('2025-01-15T00:00:00Z');
  });

  it('takes max interactionCount and significance', () => {
    const ours = makeRecord({ interactionCount: 15, significance: 3 });
    const theirs = makeRecord({ interactionCount: 10, significance: 7 });

    const merged = mergeRelationship(ours, theirs);

    expect(merged.interactionCount).toBe(15);
    expect(merged.significance).toBe(7);
  });

  it('deduplicates and limits recentInteractions to 20', () => {
    const interactions = Array.from({ length: 25 }, (_, i) => ({
      timestamp: `2025-06-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      summary: `Event ${i}`,
    }));

    const ours = makeRecord({ recentInteractions: interactions.slice(0, 15) });
    const theirs = makeRecord({ recentInteractions: interactions.slice(10, 25) }); // overlap at 10-14

    const merged = mergeRelationship(ours, theirs);

    expect(merged.recentInteractions.length).toBe(20);
    // Should be sorted newest first
    expect(merged.recentInteractions[0].timestamp > merged.recentInteractions[1].timestamp).toBe(true);
  });

  it('always preserves ours.id', () => {
    const ours = makeRecord({ id: 'original-id', lastInteraction: '2020-01-01T00:00:00Z' });
    const theirs = makeRecord({ id: 'different-id', lastInteraction: '2025-12-01T00:00:00Z' });

    const merged = mergeRelationship(ours, theirs);

    expect(merged.id).toBe('original-id');
  });
});
