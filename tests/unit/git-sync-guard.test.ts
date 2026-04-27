/**
 * Unit tests for GitSync repo guard — ensures sync() is a clean no-op
 * when the project directory is not a git repository.
 *
 * This prevents DEGRADATION errors on standalone agents that haven't
 * opted into git backup.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { GitSyncManager } from '../../src/core/GitSync.js';
import type { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import type { SecurityLog } from '../../src/core/SecurityLog.js';

function makeMockIdentityManager(): MachineIdentityManager {
  return {
    loadRegistry: () => ({ machines: {} }),
    loadRemoteIdentity: () => null,
  } as unknown as MachineIdentityManager;
}

function makeMockSecurityLog(): SecurityLog {
  const events: unknown[] = [];
  return {
    append: (event: unknown) => { events.push(event); },
    events,
  } as unknown as SecurityLog & { events: unknown[] };
}

describe('GitSyncManager.isGitRepo()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sync-guard-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when .git/ does not exist', () => {
    const gitSync = new GitSyncManager({
      projectDir: tmpDir,
      stateDir: path.join(tmpDir, '.instar'),
      identityManager: makeMockIdentityManager(),
      securityLog: makeMockSecurityLog(),
      machineId: 'test-machine-001',
    });

    expect(gitSync.isGitRepo()).toBe(false);
  });

  it('returns false when .git/ exists but repo has no commits', () => {
    fs.mkdirSync(path.join(tmpDir, '.git'));

    const gitSync = new GitSyncManager({
      projectDir: tmpDir,
      stateDir: path.join(tmpDir, '.instar'),
      identityManager: makeMockIdentityManager(),
      securityLog: makeMockSecurityLog(),
      machineId: 'test-machine-001',
    });

    expect(gitSync.isGitRepo()).toBe(false);
  });

  it('returns true when .git/ exists and repo has commits', () => {
    // safe-git-allow: incremental-migration
    execSync('git init && git commit --allow-empty -m "init"', { cwd: tmpDir, stdio: 'ignore' });

    const gitSync = new GitSyncManager({
      projectDir: tmpDir,
      stateDir: path.join(tmpDir, '.instar'),
      identityManager: makeMockIdentityManager(),
      securityLog: makeMockSecurityLog(),
      machineId: 'test-machine-001',
    });

    expect(gitSync.isGitRepo()).toBe(true);
  });
});

describe('GitSyncManager.sync() without git repo', () => {
  let tmpDir: string;
  let securityLog: SecurityLog & { events: unknown[] };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sync-guard-'));
    securityLog = makeMockSecurityLog();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a clean no-op result when no .git/ directory', async () => {
    const gitSync = new GitSyncManager({
      projectDir: tmpDir,
      stateDir: path.join(tmpDir, '.instar'),
      identityManager: makeMockIdentityManager(),
      securityLog,
      machineId: 'test-machine-001',
    });

    const result = await gitSync.sync();

    expect(result.pulled).toBe(false);
    expect(result.pushed).toBe(false);
    expect(result.commitsPulled).toBe(0);
    expect(result.commitsPushed).toBe(0);
    expect(result.rejectedCommits).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it('does not log a security event when no .git/ directory', async () => {
    const gitSync = new GitSyncManager({
      projectDir: tmpDir,
      stateDir: path.join(tmpDir, '.instar'),
      identityManager: makeMockIdentityManager(),
      securityLog,
      machineId: 'test-machine-001',
    });

    await gitSync.sync();

    // No security log entry — the sync was a no-op, not a real sync
    expect(securityLog.events).toHaveLength(0);
  });

  it('does not throw when no .git/ directory', async () => {
    const gitSync = new GitSyncManager({
      projectDir: tmpDir,
      stateDir: path.join(tmpDir, '.instar'),
      identityManager: makeMockIdentityManager(),
      securityLog,
      machineId: 'test-machine-001',
    });

    await expect(gitSync.sync()).resolves.not.toThrow();
  });
});
