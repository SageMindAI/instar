/**
 * Unit tests for ServerSupervisor — preflight self-heal and circuit breaker.
 *
 * Tests:
 * - Preflight detects and aborts stuck git rebase
 * - Preflight skips git heal when no rebase is stuck
 * - shellExec uses SHELL env var instead of hardcoded /bin/sh
 * - Slow retry window is wide enough to not miss retries
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock child_process
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawnSync: vi.fn(() => ({ stdout: '', stderr: '', status: 0, signal: null, pid: 0, output: [] })),
    execFileSync: vi.fn(() => ''),
  };
});

// Mock Config to avoid tmux detection side effects
vi.mock('../../src/core/Config.js', () => ({
  detectTmuxPath: () => '/usr/bin/tmux',
}));

// Mock SleepWakeDetector
vi.mock('../../src/core/SleepWakeDetector.js', () => ({
  SleepWakeDetector: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    on: vi.fn(),
  })),
}));

import { ServerSupervisor } from '../../src/lifeline/ServerSupervisor.js';

function createTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-test-'));
  fs.mkdirSync(path.join(dir, '.instar', 'state'), { recursive: true });
  return dir;
}

describe('ServerSupervisor preflight self-heal', () => {
  let tmpDir: string;
  let supervisor: ServerSupervisor;

  beforeEach(() => {
    tmpDir = createTmpDir();
    supervisor = new ServerSupervisor({
      projectDir: tmpDir,
      projectName: 'test-agent',
      port: 9999,
      stateDir: path.join(tmpDir, '.instar'),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // safe-git-allow: incremental-migration
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup */ }
  });

  it('detects and aborts stuck git rebase during preflight', () => {
    const mockSpawnSync = vi.mocked(spawnSync);
    mockSpawnSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      const argsArr = args as string[] | undefined;
      if (cmd === 'git' && argsArr?.[0] === 'status') {
        return {
          stdout: 'interactive rebase in progress; onto abc123\n',
          stderr: '', status: 0, signal: null, pid: 0, output: [],
        } as unknown as SpawnSyncReturns<string>;
      }
      if (cmd === 'git' && argsArr?.[0] === 'rebase' && argsArr?.[1] === '--abort') {
        return {
          stdout: '', stderr: '', status: 0, signal: null, pid: 0, output: [],
        } as unknown as SpawnSyncReturns<string>;
      }
      return {
        stdout: '', stderr: '', status: 0, signal: null, pid: 0, output: [],
      } as unknown as SpawnSyncReturns<string>;
    });

    // Call preflight via the private method (access for testing)
    const healed = (supervisor as any).preflightSelfHeal();

    expect(healed).toContain('stuck git rebase aborted');

    // Verify git rebase --abort was called
    const abortCalls = mockSpawnSync.mock.calls.filter(
      (call) => call[0] === 'git' && (call[1] as string[])?.[0] === 'rebase'
    );
    expect(abortCalls.length).toBe(1);
  });

  it('does not abort when no rebase is stuck', () => {
    const mockSpawnSync = vi.mocked(spawnSync);
    mockSpawnSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      const argsArr = args as string[] | undefined;
      if (cmd === 'git' && argsArr?.[0] === 'status') {
        return {
          stdout: 'On branch main\nnothing to commit\n',
          stderr: '', status: 0, signal: null, pid: 0, output: [],
        } as unknown as SpawnSyncReturns<string>;
      }
      return {
        stdout: '', stderr: '', status: 0, signal: null, pid: 0, output: [],
      } as unknown as SpawnSyncReturns<string>;
    });

    const healed = (supervisor as any).preflightSelfHeal();

    expect(healed).not.toContain('rebase');

    const abortCalls = mockSpawnSync.mock.calls.filter(
      (call) => call[0] === 'git' && (call[1] as string[])?.[0] === 'rebase'
    );
    expect(abortCalls.length).toBe(0);
  });
});

describe('shellExec shell detection', () => {
  it('uses SHELL env var when available', async () => {
    // The shellExec function is module-scoped, so we test it indirectly
    // by verifying the source code uses process.env.SHELL
    const supervisorSource = fs.readFileSync(
      path.join(process.cwd(), 'src/lifeline/ServerSupervisor.ts'),
      'utf-8'
    );
    expect(supervisorSource).toContain('process.env.SHELL');
    expect(supervisorSource).not.toMatch(/spawnSync\('\/bin\/sh'/);
  });
});

describe('slow retry window', () => {
  it('uses a 60-second window (not 10s) to avoid missed retries', () => {
    const supervisorSource = fs.readFileSync(
      path.join(process.cwd(), 'src/lifeline/ServerSupervisor.ts'),
      'utf-8'
    );
    // Verify the slow retry window is 60_000 (60 seconds), not 10_000
    expect(supervisorSource).toContain('slowElapsed < 60_000');
    expect(supervisorSource).not.toContain('slowElapsed < 10_000');
  });
});
