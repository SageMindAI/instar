/**
 * Unit tests for --resume support in SessionManager.spawnInteractiveSession().
 *
 * Tests that the resumeSessionId option correctly adds `--resume <uuid>`
 * to the claude command arguments.
 *
 * Uses the same child_process mock pattern as session-manager-behavioral.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Track mock tmux sessions and capture spawned args at module scope
const mockTmuxSessions = new Set<string>();
const capturedExecFileSyncCalls: Array<{ cmd: string; args: string[] }> = [];

// Mock child_process to avoid needing real tmux
vi.mock('node:child_process', () => {
  return {
    execFileSync: vi.fn().mockImplementation((cmd: string, args?: string[]) => {
      if (!args) return '';

      capturedExecFileSyncCalls.push({ cmd, args: [...args] });

      // tmux has-session
      if (args[0] === 'has-session') {
        const target = args[2]?.replace(/^=/, '');
        if (!mockTmuxSessions.has(target)) {
          throw new Error(`session not found: ${target}`);
        }
        return '';
      }

      // tmux new-session
      if (args[0] === 'new-session') {
        const sIdx = args.indexOf('-s');
        if (sIdx >= 0 && args[sIdx + 1]) {
          mockTmuxSessions.add(args[sIdx + 1]);
        }
        return '';
      }

      // tmux kill-session
      if (args[0] === 'kill-session') {
        const target = args[2]?.replace(/^=/, '');
        mockTmuxSessions.delete(target);
        return '';
      }

      // tmux display-message (for isSessionAlive)
      if (args[0] === 'display-message') {
        return 'claude||claude';
      }

      // tmux capture-pane
      if (args[0] === 'capture-pane') {
        return '';
      }

      // tmux send-keys
      if (args[0] === 'send-keys') {
        return '';
      }

      return '';
    }),
    execFile: vi.fn().mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb?: (err: Error | null, result: { stdout: string }) => void) => {
        if (typeof _opts === 'function') {
          cb = _opts as (err: Error | null, result: { stdout: string }) => void;
        }
        if (args[0] === 'has-session') {
          const target = args[2]?.replace(/^=/, '');
          if (!mockTmuxSessions.has(target)) {
            if (cb) cb(new Error(`session not found: ${target}`), { stdout: '' });
          } else {
            if (cb) cb(null, { stdout: '' });
          }
        } else {
          if (cb) cb(null, { stdout: '' });
        }
      }
    ),
  };
});

// Import after mock
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Find the tmux new-session call from captured execFileSync calls
 * and return its args array.
 */
function findNewSessionCall(): string[] | undefined {
  const call = capturedExecFileSyncCalls.find(
    c => c.args[0] === 'new-session'
  );
  return call?.args;
}

/**
 * Get the last tmux new-session call (useful when multiple sessions spawned).
 */
function findLastNewSessionCall(): string[] | undefined {
  const calls = capturedExecFileSyncCalls.filter(
    c => c.args[0] === 'new-session'
  );
  return calls[calls.length - 1]?.args;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('SessionManager.spawnInteractiveSession --resume support', () => {
  let tmpDir: string;
  let stateDir: string;
  let state: StateManager;
  let config: SessionManagerConfig;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-resume-test-'));
    stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    state = new StateManager(stateDir);
    config = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir: tmpDir,
      maxSessions: 3,
      protectedSessions: [],
      completionPatterns: ['Session complete'],
    };
    manager = new SessionManager(config, state);

    // Clear tracking state
    mockTmuxSessions.clear();
    capturedExecFileSyncCalls.length = 0;
  });

  afterEach(() => {
    manager.stopMonitoring();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. Without resumeSessionId → --resume NOT in args ──

  it('does not include --resume when resumeSessionId is not provided', async () => {
    await manager.spawnInteractiveSession(undefined, 'no-resume');

    const args = findNewSessionCall();
    expect(args).toBeDefined();
    expect(args!.join(' ')).not.toContain('--resume');
  });

  it('does not include --resume when options object has no resumeSessionId', async () => {
    await manager.spawnInteractiveSession(undefined, 'no-resume-opts', { telegramTopicId: 42 });

    const args = findNewSessionCall();
    expect(args).toBeDefined();
    expect(args!.join(' ')).not.toContain('--resume');
  });

  // ── 2. With resumeSessionId → --resume <uuid> IS in args ──

  it('includes --resume <uuid> when resumeSessionId is provided', async () => {
    const resumeId = '550e8400-e29b-41d4-a716-446655440000';
    await manager.spawnInteractiveSession(undefined, 'with-resume', { resumeSessionId: resumeId });

    const args = findLastNewSessionCall();
    expect(args).toBeDefined();

    const resumeIdx = args!.indexOf('--resume');
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(args![resumeIdx + 1]).toBe(resumeId);
  });

  it('places --resume after --dangerously-skip-permissions', async () => {
    const resumeId = 'abc-def-123';
    await manager.spawnInteractiveSession(undefined, 'resume-order', { resumeSessionId: resumeId });

    const args = findLastNewSessionCall();
    expect(args).toBeDefined();

    const skipIdx = args!.indexOf('--dangerously-skip-permissions');
    const resumeIdx = args!.indexOf('--resume');
    expect(skipIdx).toBeGreaterThan(-1);
    expect(resumeIdx).toBeGreaterThan(skipIdx);
  });

  // ── 3. Resume + telegramTopicId → both flags present ──

  it('includes both --resume and telegram topic env when both provided', async () => {
    const resumeId = 'session-uuid-42';
    await manager.spawnInteractiveSession(undefined, 'resume-telegram', {
      resumeSessionId: resumeId,
      telegramTopicId: 123,
    });

    const args = findLastNewSessionCall();
    expect(args).toBeDefined();

    // --resume is present
    const resumeIdx = args!.indexOf('--resume');
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(args![resumeIdx + 1]).toBe(resumeId);

    // Telegram topic env is present (-e INSTAR_TELEGRAM_TOPIC=123)
    const envIdx = args!.indexOf(`INSTAR_TELEGRAM_TOPIC=123`);
    expect(envIdx).toBeGreaterThan(-1);
    // The -e flag should come before the value
    expect(args![envIdx - 1]).toBe('-e');
  });

  // ── 4. Resume ID format preserved ──

  it('passes UUID exactly as-is, not modified', async () => {
    const uuids = [
      '550e8400-e29b-41d4-a716-446655440000',
      'ABCDEF12-3456-7890-abcd-ef1234567890',
      'simple-string-id',
      '01HWKZNXSVM5ZBTA0WJ6KTZQRJ', // ULID format
    ];

    for (const uuid of uuids) {
      capturedExecFileSyncCalls.length = 0;

      await manager.spawnInteractiveSession(undefined, `resume-${uuid.slice(0, 8)}`, {
        resumeSessionId: uuid,
      });

      const args = findLastNewSessionCall();
      expect(args).toBeDefined();

      const resumeIdx = args!.indexOf('--resume');
      expect(resumeIdx).toBeGreaterThan(-1);
      expect(args![resumeIdx + 1]).toBe(uuid);
    }
  });
});
