/**
 * Shared test utilities for instar tests.
 *
 * Provides temp project creation, mock session managers,
 * mock claude scripts, and async polling helpers.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { StateManager } from '../../src/core/StateManager.js';
import type { Session, SessionManagerConfig, ModelTier, JobDefinition } from '../../src/core/types.js';

// ── Temp Project ──────────────────────────────────────────────────

export interface TempProject {
  dir: string;
  stateDir: string;
  state: StateManager;
  cleanup: () => void;
}

export function createTempProject(): TempProject {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-test-'));
  const stateDir = path.join(dir, '.instar');

  // Create instar directory structure
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

  const state = new StateManager(stateDir);

  return {
    dir,
    stateDir,
    state,
    // safe-git-allow: incremental-migration
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// ── Mock Session Manager ──────────────────────────────────────────

export interface MockSessionManager {
  spawnSession: (opts: {
    name: string;
    prompt: string;
    model?: ModelTier;
    jobSlug?: string;
    triggeredBy?: string;
  }) => Promise<Session>;
  isSessionAlive: (tmuxSession: string) => boolean;
  listRunningSessions: () => Session[];
  getCachedRunningSessions: () => { count: number; sessions: Session[] };
  killSession: (sessionId: string) => boolean;
  captureOutput: (tmuxSession: string, lines?: number) => string | null;
  sendInput: (tmuxSession: string, input: string) => boolean;

  // Test controls
  _sessions: Session[];
  _aliveSet: Set<string>;
  _spawnCount: number;
  _lastSpawnArgs: { name: string; prompt: string; model?: ModelTier; jobSlug?: string; triggeredBy?: string; maxDurationMinutes?: number } | null;
}

export function createMockSessionManager(): MockSessionManager {
  const mock: MockSessionManager = {
    _sessions: [],
    _aliveSet: new Set(),
    _spawnCount: 0,
    _lastSpawnArgs: null,

    spawnSession: async (opts) => {
      mock._spawnCount++;
      mock._lastSpawnArgs = opts;
      const session: Session = {
        id: `mock-${Date.now().toString(36)}-${mock._spawnCount}`,
        name: opts.name,
        status: 'running',
        tmuxSession: `test-${opts.name}`,
        startedAt: new Date().toISOString(),
        jobSlug: opts.jobSlug,
        triggeredBy: opts.triggeredBy,
        model: opts.model,
        prompt: opts.prompt,
      };
      mock._sessions.push(session);
      mock._aliveSet.add(session.tmuxSession);
      return session;
    },

    isSessionAlive: (tmuxSession: string) => mock._aliveSet.has(tmuxSession),

    listRunningSessions: () => mock._sessions.filter(s => s.status === 'running'),

    getCachedRunningSessions: () => {
      const running = mock._sessions.filter(s => s.status === 'running');
      return { count: running.length, sessions: running };
    },

    killSession: (sessionId: string) => {
      const session = mock._sessions.find(s => s.id === sessionId);
      if (!session) return false;
      session.status = 'killed';
      session.endedAt = new Date().toISOString();
      mock._aliveSet.delete(session.tmuxSession);
      return true;
    },

    captureOutput: () => 'mock output',

    sendInput: (tmuxSession: string) => mock._aliveSet.has(tmuxSession),
  };

  return mock;
}

// ── Mock Claude Script ────────────────────────────────────────────

/**
 * Create a shell script that mimics claude CLI — echoes the prompt and exits.
 * Returns the path to the script.
 */
export function createMockClaude(dir: string): string {
  const scriptPath = path.join(dir, 'mock-claude.sh');
  fs.writeFileSync(scriptPath, `#!/bin/bash
echo "Mock Claude session started"
echo "Prompt: $@"
# Sleep briefly to simulate work, then exit
sleep 2
echo "Session ended"
`);
  fs.chmodSync(scriptPath, '755');
  return scriptPath;
}

// ── Sample Jobs ───────────────────────────────────────────────────

export function createSampleJobsFile(dir: string, jobs?: JobDefinition[]): string {
  const filePath = path.join(dir, 'jobs.json');
  const defaultJobs: JobDefinition[] = jobs ?? [
    {
      slug: 'health-check',
      name: 'Health Check',
      description: 'Run a quick health check',
      schedule: '0 */4 * * *',
      priority: 'high',
      expectedDurationMinutes: 2,
      model: 'haiku',
      enabled: true,
      execute: { type: 'skill', value: 'scan' },
      tags: ['monitoring'],
    },
    {
      slug: 'email-check',
      name: 'Email Check',
      description: 'Check for new emails',
      schedule: '0 */2 * * *',
      priority: 'medium',
      expectedDurationMinutes: 5,
      model: 'sonnet',
      enabled: true,
      execute: { type: 'prompt', value: 'Check for new emails and respond' },
    },
    {
      slug: 'disabled-job',
      name: 'Disabled Job',
      description: 'This one is off',
      schedule: '0 0 * * *',
      priority: 'low',
      expectedDurationMinutes: 10,
      model: 'opus',
      enabled: false,
      execute: { type: 'script', value: './scripts/heavy-task.sh' },
    },
  ];

  fs.writeFileSync(filePath, JSON.stringify(defaultJobs, null, 2));
  return filePath;
}

// ── Async Helpers ─────────────────────────────────────────────────

/**
 * Poll a condition until it returns true or timeout.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number = 5000,
  intervalMs: number = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ── Tmux Cleanup ──────────────────────────────────────────────────

/**
 * Kill any tmux sessions matching a prefix. Use in afterAll for integration tests.
 */
export function cleanupTmuxSessions(prefix: string): void {
  try {
    const output = execSync('tmux list-sessions -F "#{session_name}"', { encoding: 'utf-8' });
    const sessions = output.trim().split('\n').filter(s => s.startsWith(prefix));
    for (const session of sessions) {
      try {
        execSync(`tmux kill-session -t '=${session}'`);
      } catch { /* already dead */ }
    }
  } catch {
    // No tmux server running — fine
  }
}
