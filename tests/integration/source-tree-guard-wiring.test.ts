/**
 * Integration tests for SourceTreeGuard wire-in on the three destructive
 * managers (GitSyncManager, BranchManager, HandoffManager).
 *
 * These tests assert that:
 *   1. Constructing any of the three managers against the real instar
 *      source tree throws SourceTreeGuardError with the correct code.
 *   2. Constructing against a mkdtemp sandbox succeeds (the guard does
 *      not fire on legitimate targets).
 *   3. Constructing against an uncreated subdirectory INSIDE the instar
 *      source also fails (uncreated-subdirectory bypass closed).
 *   4. The throw happens BEFORE any collaborator touches anything (no
 *      observable side effect).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BranchManager } from '../../src/core/BranchManager.js';
import { HandoffManager } from '../../src/core/HandoffManager.js';
import { GitSyncManager } from '../../src/core/GitSync.js';
import type { WorkLedger } from '../../src/core/WorkLedger.js';
import type { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import type { SecurityLog } from '../../src/core/SecurityLog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// tests/integration/ → repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ── Minimal collaborator stubs ──────────────────────────────────────

function stubWorkLedger(): WorkLedger {
  return {} as unknown as WorkLedger;
}
function stubIdentityManager(): MachineIdentityManager {
  return {} as unknown as MachineIdentityManager;
}
function stubSecurityLog(): SecurityLog {
  return {} as unknown as SecurityLog;
}

// ── Guard against the real instar source ───────────────────────────

describe('SourceTreeGuard — instar source tree is blocked at construction', () => {
  it('BranchManager constructor throws SourceTreeGuardError for the instar source tree', () => {
    expect(() => {
      new BranchManager({
        projectDir: REPO_ROOT,
        stateDir: path.join(REPO_ROOT, '.instar-test-never-created'),
        machineId: 'test',
      });
    }).toThrow(/INSTAR_SOURCE_TREE_GUARD|instar source tree/);
  });

  it('HandoffManager constructor throws SourceTreeGuardError for the instar source tree', () => {
    expect(() => {
      new HandoffManager({
        projectDir: REPO_ROOT,
        stateDir: path.join(REPO_ROOT, '.instar-test-never-created'),
        machineId: 'test',
        workLedger: stubWorkLedger(),
      });
    }).toThrow(/INSTAR_SOURCE_TREE_GUARD|instar source tree/);
  });

  it('GitSyncManager constructor throws SourceTreeGuardError for the instar source tree', () => {
    expect(() => {
      new GitSyncManager({
        projectDir: REPO_ROOT,
        stateDir: path.join(REPO_ROOT, '.instar-test-never-created'),
        identityManager: stubIdentityManager(),
        securityLog: stubSecurityLog(),
        machineId: 'test',
      });
    }).toThrow(/INSTAR_SOURCE_TREE_GUARD|instar source tree/);
  });

  it('thrown error has code === "INSTAR_SOURCE_TREE_GUARD" and correct operation label', () => {
    let caught: unknown;
    try {
      new BranchManager({
        projectDir: REPO_ROOT,
        stateDir: path.join(REPO_ROOT, '.instar-test-never-created'),
        machineId: 'test',
      });
    } catch (err) {
      caught = err;
    }
    const e = caught as { code?: string; operation?: string };
    expect(e?.code).toBe('INSTAR_SOURCE_TREE_GUARD');
    expect(e?.operation).toBe('BranchManager');
  });

  it('guard fires BEFORE the state directory is created (no observable side effect)', () => {
    const stateDir = path.join(REPO_ROOT, '.instar-test-should-never-exist');
    expect(fs.existsSync(stateDir)).toBe(false);
    try {
      new BranchManager({
        projectDir: REPO_ROOT,
        stateDir,
        machineId: 'test',
      });
    } catch {
      // expected
    }
    // BranchManager normally creates stateDir/state/branches in its
    // constructor. If the guard fired first, this directory must still
    // not exist.
    expect(fs.existsSync(stateDir)).toBe(false);
  });
});

// ── Uncreated subdirectory inside the instar source ─────────────────

describe('SourceTreeGuard — uncreated-subdirectory bypass is closed', () => {
  it('passing an uncreated subdir of the instar source still throws', () => {
    const uncreated = path.join(REPO_ROOT, 'src', 'never_created_feature_' + Date.now());
    expect(fs.existsSync(uncreated)).toBe(false);
    expect(() => {
      new BranchManager({
        projectDir: uncreated,
        stateDir: path.join(os.tmpdir(), 'stg-wiring-should-not-matter'),
        machineId: 'test',
      });
    }).toThrow(/INSTAR_SOURCE_TREE_GUARD|instar source tree/);
  });
});

// ── Legitimate mkdtemp sandbox → construction succeeds ──────────────

describe('SourceTreeGuard — legitimate sandbox construction succeeds', () => {
  let sandbox: string;
  let stateDir: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'stg-wiring-'));
    stateDir = path.join(sandbox, '.instar');
    // Make it a real git repo so BranchManager has something to work with,
    // though the guard decision happens before git runs.
    execFileSync('git', ['init', '-b', 'main'], { cwd: sandbox });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: sandbox });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: sandbox });
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('BranchManager constructs successfully in a sandbox', () => {
    expect(() => {
      new BranchManager({
        projectDir: sandbox,
        stateDir,
        machineId: 'test',
      });
    }).not.toThrow();
  });

  it('HandoffManager constructs successfully in a sandbox', () => {
    expect(() => {
      new HandoffManager({
        projectDir: sandbox,
        stateDir,
        machineId: 'test',
        workLedger: stubWorkLedger(),
      });
    }).not.toThrow();
  });

  it('GitSyncManager constructs successfully in a sandbox', () => {
    expect(() => {
      new GitSyncManager({
        projectDir: sandbox,
        stateDir,
        identityManager: stubIdentityManager(),
        securityLog: stubSecurityLog(),
        machineId: 'test',
      });
    }).not.toThrow();
  });

  it('subdirectory of sandbox (when git root is sandbox, not instar) also succeeds', () => {
    const subdir = path.join(sandbox, 'src', 'nested');
    fs.mkdirSync(subdir, { recursive: true });
    expect(() => {
      new BranchManager({
        projectDir: subdir,
        stateDir,
        machineId: 'test',
      });
    }).not.toThrow();
  });
});
