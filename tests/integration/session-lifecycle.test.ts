/**
 * Integration test — real tmux sessions with a mock claude script.
 *
 * Requires tmux to be installed. Skips if not available.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { SessionManager } from '../../src/core/SessionManager.js';
import { detectTmuxPath } from '../../src/core/Config.js';
import {
  createTempProject,
  createMockClaude,
  cleanupTmuxSessions,
  waitFor,
} from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';

const TMUX_PREFIX = 'akit-integ-';

// Skip entire suite if tmux is not available
const tmuxPath = detectTmuxPath();
const describeMaybe = tmuxPath ? describe : describe.skip;

describeMaybe('Session Lifecycle (integration)', () => {
  let project: TempProject;
  let mockClaudePath: string;
  let sm: SessionManager;

  beforeAll(() => {
    project = createTempProject();
    mockClaudePath = createMockClaude(project.dir);

    sm = new SessionManager(
      {
        tmuxPath: tmuxPath!,
        claudePath: mockClaudePath,
        projectDir: project.dir,
        maxSessions: 3,
        protectedSessions: [],
        completionPatterns: ['Session ended'],
      },
      project.state,
    );
  });

  afterAll(() => {
    sm.stopMonitoring();
    cleanupTmuxSessions(TMUX_PREFIX);
    project.cleanup();
  });

  it('spawns a session and tracks it', async () => {
    const session = await sm.spawnSession({
      name: `${TMUX_PREFIX}basic`,
      prompt: 'echo hello',
    });

    expect(session.status).toBe('running');
    expect(session.tmuxSession).toContain(TMUX_PREFIX);

    // Give tmux a moment to start
    await new Promise(r => setTimeout(r, 500));

    // Session should be alive
    expect(sm.isSessionAlive(session.tmuxSession)).toBe(true);

    // State should be persisted
    const saved = project.state.getSession(session.id);
    expect(saved).not.toBeNull();
    expect(saved!.status).toBe('running');
  });

  it('captures output from session', async () => {
    const session = await sm.spawnSession({
      name: `${TMUX_PREFIX}output`,
      prompt: 'echo hello',
    });

    await new Promise(r => setTimeout(r, 1000));

    const output = sm.captureOutput(session.tmuxSession);
    expect(output).not.toBeNull();
    // Mock claude echoes its prompt
    expect(output).toContain('Mock Claude session started');
  });

  it('detects completed sessions via reaping', async () => {
    const session = await sm.spawnSession({
      name: `${TMUX_PREFIX}complete`,
      prompt: 'echo done',
    });

    // Mock claude exits after ~2s — wait for tmux session to disappear
    await waitFor(
      () => !sm.isSessionAlive(session.tmuxSession),
      8000,
    );

    // Reap should detect and mark it completed
    const reaped = sm.reapCompletedSessions();
    // Session was already marked completed by listRunningSessions or monitor
    const saved = project.state.getSession(session.id);
    expect(saved!.status).toBe('completed');
    expect(saved!.endedAt).toBeTruthy();
  });

  it('kills a session', async () => {
    const session = await sm.spawnSession({
      name: `${TMUX_PREFIX}kill`,
      prompt: 'sleep 60', // Would run forever
    });

    await new Promise(r => setTimeout(r, 500));
    expect(sm.isSessionAlive(session.tmuxSession)).toBe(true);

    const killed = sm.killSession(session.id);
    expect(killed).toBe(true);

    // Give tmux a moment to clean up
    await new Promise(r => setTimeout(r, 200));
    expect(sm.isSessionAlive(session.tmuxSession)).toBe(false);

    const saved = project.state.getSession(session.id);
    expect(saved!.status).toBe('killed');
  });

  it('enforces max sessions', async () => {
    // Use a separate project to avoid interference from other tests
    const limitProject = createTempProject();
    const limitSM = new SessionManager(
      {
        tmuxPath: tmuxPath!,
        claudePath: mockClaudePath,
        projectDir: limitProject.dir,
        maxSessions: 1,
        protectedSessions: [],
        completionPatterns: [],
      },
      limitProject.state,
    );

    const s1 = await limitSM.spawnSession({
      name: `${TMUX_PREFIX}limit1`,
      prompt: 'sleep 30',
    });

    await expect(limitSM.spawnSession({
      name: `${TMUX_PREFIX}limit2`,
      prompt: 'sleep 30',
    })).rejects.toThrow('Max sessions');

    // Cleanup
    limitSM.killSession(s1.id);
    limitProject.cleanup();
  });

  it('emits sessionComplete via monitoring', { timeout: 30000 }, async () => {
    const completedSessions: string[] = [];
    sm.on('sessionComplete', (session) => {
      completedSessions.push(session.id);
    });

    const session = await sm.spawnSession({
      name: `${TMUX_PREFIX}monitor`,
      prompt: 'echo test',
    });

    // Start monitoring with fast interval
    // Note: SessionManager has a 15s grace period before checking new sessions,
    // so this test needs a timeout > 15s + monitoring interval + margin
    sm.startMonitoring(500);

    await waitFor(
      () => completedSessions.includes(session.id),
      25000,
    );

    expect(completedSessions).toContain(session.id);
    sm.stopMonitoring();
  });
});
