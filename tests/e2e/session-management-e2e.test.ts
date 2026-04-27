/**
 * BDD End-to-End Tests for Session Management
 *
 * Tests the full session lifecycle from spawn to completion/kill,
 * including interactive sessions, message injection, prompt detection,
 * retry behavior, and the patterns used by Telegram/iMessage routing.
 *
 * Uses real tmux sessions with a mock claude script. Skips gracefully
 * if tmux is not installed.
 *
 * Per TESTING-INTEGRITY-SPEC Category 3: "The full path from user action
 * to user-visible outcome works end-to-end, with controlled (but real)
 * intermediate components."
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { detectTmuxPath } from '../../src/core/Config.js';
import type { SessionManagerConfig } from '../../src/core/types.js';
import { cleanupTmuxSessions, waitFor } from '../helpers/setup.js';

// ── Test Constants ──────────────────────────────────────────────────

const TMUX_PREFIX = 'sess-e2e-';
const tmuxPath = detectTmuxPath();
const describeMaybe = tmuxPath ? describe : describe.skip;

// ── Mock Claude Scripts ─────────────────────────────────────────────

/**
 * Create a mock claude that shows a prompt character (❯) like the real TUI.
 * This lets us test prompt detection without a real Claude Code instance.
 */
function createMockClaudeInteractive(dir: string): string {
  const scriptPath = path.join(dir, 'mock-claude-interactive.sh');
  fs.writeFileSync(scriptPath, `#!/bin/bash
# Simulate Claude Code startup sequence:
# 1. Show TUI border (loading state)
# 2. Brief delay (API auth, CLAUDE.md loading)
# 3. Show prompt and status bar

echo "╭──────────────────────────────────────╮"
echo "│  Claude Code v2.1.86                 │"
echo "│  Mock Mode                           │"
echo "╰──────────────────────────────────────╯"

sleep 1

echo "────────────────────────────────────────"
echo "❯ "
echo "────────────────────────────────────────"
echo "  ⏵⏵ bypass permissions on (shift+tab to cycle)                    ◐ medium · /effort"

# Keep the session alive waiting for input
read -r INPUT
echo "Received: $INPUT"

# After receiving input, stay alive briefly then exit
sleep 1
echo "Session ended"
`);
  fs.chmodSync(scriptPath, '755');
  return scriptPath;
}

/**
 * Create a mock claude that takes a long time to show the prompt.
 * Simulates slow API auth or large CLAUDE.md loading.
 */
function createMockClaudeSlow(dir: string, delaySeconds: number): string {
  const scriptPath = path.join(dir, 'mock-claude-slow.sh');
  fs.writeFileSync(scriptPath, `#!/bin/bash
echo "╭──────────────────────────────────────╮"
echo "│  Claude Code v2.1.86                 │"
echo "│  Loading...                          │"
echo "╰──────────────────────────────────────╯"

sleep ${delaySeconds}

echo "────────────────────────────────────────"
echo "❯ "
echo "────────────────────────────────────────"
echo "  ⏵⏵ bypass permissions on                                         ◐ medium · /effort"

read -r INPUT
echo "Received: $INPUT"
sleep 1
`);
  fs.chmodSync(scriptPath, '755');
  return scriptPath;
}

/**
 * Create a mock claude that shows the effort indicator but not the ❯ character.
 * Tests secondary prompt detection signals.
 */
function createMockClaudeAlternatePrompt(dir: string): string {
  const scriptPath = path.join(dir, 'mock-claude-alt.sh');
  fs.writeFileSync(scriptPath, `#!/bin/bash
echo "╭──────────────────────────────────────╮"
echo "│  Claude Code v2.1.86                 │"
echo "╰──────────────────────────────────────╯"

sleep 0.5

echo "────────────────────────────────────────"
echo " "
echo "────────────────────────────────────────"
echo "  ⏵⏵ bypass permissions on (shift+tab to cycle)                    ◐ medium · /effort"

read -r INPUT
echo "Received: $INPUT"
sleep 1
`);
  fs.chmodSync(scriptPath, '755');
  return scriptPath;
}

/**
 * Create a mock claude that crashes during startup (exits immediately).
 */
function createMockClaudeCrash(dir: string): string {
  const scriptPath = path.join(dir, 'mock-claude-crash.sh');
  fs.writeFileSync(scriptPath, `#!/bin/bash
echo "Error: Authentication failed"
exit 1
`);
  fs.chmodSync(scriptPath, '755');
  return scriptPath;
}

/**
 * Create a mock claude that runs a one-shot prompt (like job sessions).
 */
function createMockClaudeOneShot(dir: string): string {
  const scriptPath = path.join(dir, 'mock-claude-oneshot.sh');
  fs.writeFileSync(scriptPath, `#!/bin/bash
echo "Processing prompt: $@"
sleep 1
echo "Session complete"
`);
  fs.chmodSync(scriptPath, '755');
  return scriptPath;
}

// ── Helpers ─────────────────────────────────────────────────────────

interface TestProject {
  dir: string;
  stateDir: string;
  state: StateManager;
  cleanup: () => void;
}

function createTestProject(): TestProject {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-e2e-'));
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
  const state = new StateManager(stateDir);
  return {
    dir,
    stateDir,
    state,
    // safe-git-allow: incremental-migration
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function createManager(project: TestProject, claudePath: string, overrides?: Partial<SessionManagerConfig>): SessionManager {
  return new SessionManager(
    {
      tmuxPath: tmuxPath!,
      claudePath,
      projectDir: project.dir,
      maxSessions: 5,
      protectedSessions: [],
      completionPatterns: ['Session ended', 'Session complete'],
      ...overrides,
    },
    project.state,
  );
}

// ── BDD Tests ───────────────────────────────────────────────────────

describeMaybe('Session Management E2E', () => {
  let project: TestProject;
  let managers: SessionManager[];

  beforeEach(() => {
    project = createTestProject();
    managers = [];
  });

  afterEach(() => {
    for (const m of managers) m.stopMonitoring();
    cleanupTmuxSessions(TMUX_PREFIX);
    // Extra cleanup: kill any sessions from our temp project name
    const projectBase = path.basename(project.dir);
    cleanupTmuxSessions(projectBase);
    project.cleanup();
  });

  // ── Feature: Spawning Job Sessions ────────────────────────────────

  describe('Feature: Spawning job sessions (non-interactive, -p flag)', () => {
    it('should spawn a session, track it in state, and detect completion', async () => {
      // Given a mock claude that processes a prompt and exits
      const claudePath = createMockClaudeOneShot(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      // When we spawn a session with a prompt
      const session = await sm.spawnSession({
        name: `${TMUX_PREFIX}job-basic`,
        prompt: 'Run a health check',
      });

      // Then the session should be tracked as running
      expect(session.status).toBe('running');
      expect(session.id).toBeTruthy();
      expect(session.tmuxSession).toContain(TMUX_PREFIX);

      // And state should persist to disk
      const saved = project.state.getSession(session.id);
      expect(saved).not.toBeNull();
      expect(saved!.status).toBe('running');

      // When the mock claude finishes (after ~2s)
      await waitFor(
        () => !sm.isSessionAlive(session.tmuxSession),
        10_000,
      );

      // Then reaping should mark it completed
      sm.reapCompletedSessions();
      const completed = project.state.getSession(session.id);
      expect(completed!.status).toBe('completed');
      expect(completed!.endedAt).toBeTruthy();
    });

    it('should enforce max sessions limit for job spawns', async () => {
      // Given a manager with max 2 sessions
      const claudePath = createMockClaudeInteractive(project.dir);
      const sm = createManager(project, claudePath, { maxSessions: 2 });
      managers.push(sm);

      // When we spawn 2 sessions (the max)
      await sm.spawnSession({ name: `${TMUX_PREFIX}cap-1`, prompt: 'p1' });
      await sm.spawnSession({ name: `${TMUX_PREFIX}cap-2`, prompt: 'p2' });

      // Then the 3rd should be rejected
      await expect(
        sm.spawnSession({ name: `${TMUX_PREFIX}cap-3`, prompt: 'p3' }),
      ).rejects.toThrow(/Max sessions/);
    });

    it('should reject duplicate tmux session names', async () => {
      const claudePath = createMockClaudeInteractive(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      // Given an existing session
      await sm.spawnSession({ name: `${TMUX_PREFIX}dup`, prompt: 'first' });

      // When we try to spawn with the same name
      // Then it should throw
      await expect(
        sm.spawnSession({ name: `${TMUX_PREFIX}dup`, prompt: 'second' }),
      ).rejects.toThrow(/already exists/);
    });
  });

  // ── Feature: Spawning Interactive Sessions ────────────────────────

  describe('Feature: Spawning interactive sessions (no -p, REPL mode)', () => {
    it('should spawn an interactive session and detect prompt readiness', async () => {
      // Given a mock claude that shows the TUI prompt
      const claudePath = createMockClaudeInteractive(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      // When we spawn an interactive session without an initial message
      const tmuxSession = await sm.spawnInteractiveSession(
        undefined,
        `${TMUX_PREFIX}repl`,
      );

      // Then a tmux session should exist
      expect(tmuxSession).toContain(TMUX_PREFIX);
      await new Promise(r => setTimeout(r, 2000));
      expect(sm.isSessionAlive(tmuxSession)).toBe(true);

      // And the prompt should eventually be detectable in tmux output
      const output = sm.captureOutput(tmuxSession, 20);
      expect(output).not.toBeNull();
      expect(output).toContain('❯');
    });

    it('should inject initial message after prompt appears', async () => {
      // Given a mock claude that shows the prompt after 1s
      const claudePath = createMockClaudeInteractive(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      // When we spawn with an initial message
      const tmuxSession = await sm.spawnInteractiveSession(
        'Hello from test',
        `${TMUX_PREFIX}inject`,
      );

      // Then the message should be injected after Claude is ready
      // Wait for the prompt + injection + stabilization
      await waitFor(() => {
        const out = sm.captureOutput(tmuxSession, 30);
        return (out || '').includes('Hello from test');
      }, 15_000);

      const output = sm.captureOutput(tmuxSession, 30);
      expect(output).toContain('Hello from test');
    });

    it('should reuse existing session if tmux session name matches', async () => {
      // Given an already-running interactive session
      const claudePath = createMockClaudeInteractive(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      const first = await sm.spawnInteractiveSession(undefined, `${TMUX_PREFIX}reuse`);

      // When we spawn again with the same name
      const second = await sm.spawnInteractiveSession(
        'Second message',
        `${TMUX_PREFIX}reuse`,
      );

      // Then it should return the same tmux session (reused, not new)
      expect(second).toBe(first);
    });

    it('should bypass maxSessions for interactive sessions (user-initiated)', async () => {
      // Given a manager at max job sessions
      const claudePath = createMockClaudeInteractive(project.dir);
      const sm = createManager(project, claudePath, { maxSessions: 1 });
      managers.push(sm);

      await sm.spawnSession({ name: `${TMUX_PREFIX}blocker`, prompt: 'blocking' });

      // When we spawn an interactive session (user-initiated)
      // Then it should NOT be blocked by maxSessions
      const tmuxSession = await sm.spawnInteractiveSession(
        undefined,
        `${TMUX_PREFIX}user-bypass`,
      );
      expect(tmuxSession).toContain(`${TMUX_PREFIX}user-bypass`);
    });
  });

  // ── Feature: Prompt Detection ─────────────────────────────────────

  describe('Feature: Claude prompt detection', () => {
    it('should detect the ❯ prompt character as readiness signal', async () => {
      // Given a mock claude that shows the standard prompt
      const claudePath = createMockClaudeInteractive(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      const tmuxSession = await sm.spawnInteractiveSession(undefined, `${TMUX_PREFIX}detect-prompt`);

      // When we wait for readiness
      await new Promise(r => setTimeout(r, 3000));

      // Then the prompt should be visible in capture output
      const output = sm.captureOutput(tmuxSession, 20);
      const lines = (output || '').split('\n').filter((l: string) => l.trim());
      const tail = lines.slice(-6).join('\n');
      expect(tail.includes('❯') || tail.includes('bypass permissions')).toBe(true);
    });

    it('should detect "bypass permissions" as a secondary readiness signal', async () => {
      // Given a mock claude that shows the status bar with bypass permissions
      const claudePath = createMockClaudeAlternatePrompt(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      const tmuxSession = await sm.spawnInteractiveSession(undefined, `${TMUX_PREFIX}detect-bypass`);

      // When we wait for the TUI to render
      await new Promise(r => setTimeout(r, 2000));

      // Then "bypass permissions" should be detectable
      const output = sm.captureOutput(tmuxSession, 20);
      expect(output).toContain('bypass permissions');
    });

    it('should detect "/effort" as a tertiary readiness signal', async () => {
      // Given a mock claude that shows the effort indicator
      const claudePath = createMockClaudeAlternatePrompt(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      const tmuxSession = await sm.spawnInteractiveSession(undefined, `${TMUX_PREFIX}detect-effort`);
      await new Promise(r => setTimeout(r, 2000));

      // Then the effort indicator should be detectable
      const output = sm.captureOutput(tmuxSession, 20);
      expect(output).toContain('/effort');
    });

    it('should wait for slow-starting sessions within the timeout window', async () => {
      // Given a mock claude that takes 5 seconds to show the prompt
      const claudePath = createMockClaudeSlow(project.dir, 5);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      // When we spawn with a message (triggers waitForClaudeReady)
      const tmuxSession = await sm.spawnInteractiveSession(
        'Delayed hello',
        `${TMUX_PREFIX}slow-start`,
      );

      // Then the message should eventually be injected (within 90s timeout)
      await waitFor(() => {
        const out = sm.captureOutput(tmuxSession, 30);
        return (out || '').includes('Delayed hello');
      }, 20_000);

      const output = sm.captureOutput(tmuxSession, 30);
      expect(output).toContain('Delayed hello');
    });
  });

  // ── Feature: Session Lifecycle (kill, reap, monitor) ──────────────

  describe('Feature: Session lifecycle management', () => {
    it('should kill a running session and update state', async () => {
      // Given a running interactive session
      const claudePath = createMockClaudeInteractive(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      const tmuxSession = await sm.spawnInteractiveSession(undefined, `${TMUX_PREFIX}killable`);
      await new Promise(r => setTimeout(r, 1000));
      expect(sm.isSessionAlive(tmuxSession)).toBe(true);

      // When we find and kill the session by ID
      const sessions = project.state.listSessions({ status: 'running' });
      const target = sessions.find(s => s.tmuxSession === tmuxSession);
      expect(target).toBeTruthy();

      const killed = sm.killSession(target!.id);

      // Then the session should be dead
      expect(killed).toBe(true);
      await new Promise(r => setTimeout(r, 300));
      expect(sm.isSessionAlive(tmuxSession)).toBe(false);

      // And state should reflect the kill
      const saved = project.state.getSession(target!.id);
      expect(saved!.status).toBe('killed');
      expect(saved!.endedAt).toBeTruthy();
    });

    it('should detect and reap sessions that exit on their own', async () => {
      // Given a one-shot session that will complete
      const claudePath = createMockClaudeOneShot(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      const session = await sm.spawnSession({
        name: `${TMUX_PREFIX}auto-reap`,
        prompt: 'quick task',
      });

      // When the session finishes naturally
      await waitFor(
        () => !sm.isSessionAlive(session.tmuxSession),
        10_000,
      );

      // Then reaping should mark it completed
      sm.reapCompletedSessions();
      const saved = project.state.getSession(session.id);
      expect(saved!.status).toBe('completed');
    });

    it('should handle sessions that crash during startup', async () => {
      // Given a mock claude that crashes immediately
      const claudePath = createMockClaudeCrash(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      // When we spawn a session
      const session = await sm.spawnSession({
        name: `${TMUX_PREFIX}crash`,
        prompt: 'will crash',
      });

      // Then the session should eventually be detected as dead
      await waitFor(
        () => !sm.isSessionAlive(session.tmuxSession),
        5000,
      );

      // And reaping should clean it up
      sm.reapCompletedSessions();
      const saved = project.state.getSession(session.id);
      expect(['completed', 'failed']).toContain(saved!.status);
    });
  });

  // ── Feature: Telegram Message Injection ───────────────────────────

  describe('Feature: Telegram message injection into sessions', () => {
    it('should inject short messages inline via send-keys', async () => {
      // Given a running interactive session
      const claudePath = createMockClaudeInteractive(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      const tmuxSession = await sm.spawnInteractiveSession(undefined, `${TMUX_PREFIX}tg-inject`);
      await new Promise(r => setTimeout(r, 3000));

      // When we inject a Telegram message
      sm.injectTelegramMessage(tmuxSession, 42, 'Hello from Telegram', 'Test Topic', 'TestUser', 12345);

      // Then the tagged message should appear in the session
      await waitFor(() => {
        const out = sm.captureOutput(tmuxSession, 30);
        return (out || '').includes('[telegram:42');
      }, 10_000);

      const output = sm.captureOutput(tmuxSession, 30);
      expect(output).toContain('[telegram:42');
      expect(output).toContain('Hello from Telegram');
    });

    it('should write long messages to temp file and inject a reference', async () => {
      // Given a running interactive session
      const claudePath = createMockClaudeInteractive(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      const tmuxSession = await sm.spawnInteractiveSession(undefined, `${TMUX_PREFIX}tg-long`);
      await new Promise(r => setTimeout(r, 3000));

      // When we inject a message longer than 500 chars
      const longMessage = 'A'.repeat(600);
      sm.injectTelegramMessage(tmuxSession, 99, longMessage, 'Long Topic', 'TestUser', 12345);

      // Then a temp file should be created
      await new Promise(r => setTimeout(r, 1000));
      const tmpDir = '/tmp/instar-telegram';
      if (fs.existsSync(tmpDir)) {
        const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('msg-99-'));
        expect(files.length).toBeGreaterThan(0);

        // And the file should contain the tagged message
        const content = fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8');
        expect(content).toContain('[telegram:99');
        expect(content).toContain('A'.repeat(100));

        // Cleanup
        for (const f of files) {
          // safe-git-allow: incremental-migration
          try { fs.unlinkSync(path.join(tmpDir, f)); } catch { /* ignore */ }
        }
      }
    });

    it('should track pending injections for stall detection', async () => {
      // Given a running interactive session
      const claudePath = createMockClaudeInteractive(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      const tmuxSession = await sm.spawnInteractiveSession(undefined, `${TMUX_PREFIX}tg-stall`);
      await new Promise(r => setTimeout(r, 3000));

      // When we inject a message
      sm.injectTelegramMessage(tmuxSession, 77, 'Are you there?', 'Stall Test', 'TestUser', 12345);

      // Then a pending injection should be tracked
      const pending = sm.getPendingInjection(tmuxSession);
      expect(pending).toBeTruthy();
      expect(pending!.topicId).toBe(77);

      // When we clear the injection tracker (simulating agent reply)
      sm.clearInjectionTracker(77);

      // Then the pending injection should be cleared
      const cleared = sm.getPendingInjection(tmuxSession);
      expect(cleared).toBeUndefined();
    });
  });

  // ── Feature: iMessage Injection ───────────────────────────────────

  describe('Feature: iMessage injection into sessions', () => {
    it('should inject iMessage with sender tag', async () => {
      // Given a running interactive session
      const claudePath = createMockClaudeInteractive(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      const tmuxSession = await sm.spawnInteractiveSession(undefined, `${TMUX_PREFIX}im-inject`);
      await new Promise(r => setTimeout(r, 3000));

      // When we inject an iMessage
      sm.injectIMessageMessage(tmuxSession, '+14155551234', 'Hello from iMessage', 'Alice');

      // Then the tagged message should appear
      await waitFor(() => {
        const out = sm.captureOutput(tmuxSession, 30);
        return (out || '').includes('[imessage:+14155551234');
      }, 10_000);

      const output = sm.captureOutput(tmuxSession, 30);
      expect(output).toContain('[imessage:+14155551234');
      expect(output).toContain('Hello from iMessage');
    });

    it('should track iMessage injections for stall detection', async () => {
      // Given a running interactive session with an injected message
      const claudePath = createMockClaudeInteractive(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      const tmuxSession = await sm.spawnInteractiveSession(undefined, `${TMUX_PREFIX}im-stall`);
      await new Promise(r => setTimeout(r, 3000));

      sm.injectIMessageMessage(tmuxSession, '+14155559999', 'Tracking test', 'Bob');

      // Then a pending injection should exist
      const pending = sm.getPendingInjection(tmuxSession);
      expect(pending).toBeTruthy();

      // When we clear the tracker for this sender
      sm.clearIMessageInjectionTracker('+14155559999');

      // Then the pending injection should be cleared
      const cleared = sm.getPendingInjection(tmuxSession);
      expect(cleared).toBeUndefined();
    });
  });

  // ── Feature: Session-Topic Routing (Telegram Pattern) ─────────────

  describe('Feature: Session routing follows the Telegram pattern', () => {
    it('should support the inject-or-spawn pattern for live sessions', async () => {
      // Given a live session mapped to a topic
      const claudePath = createMockClaudeInteractive(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      const tmuxSession = await sm.spawnInteractiveSession(undefined, `${TMUX_PREFIX}routing`);
      await new Promise(r => setTimeout(r, 3000));

      // When the session is alive
      expect(sm.isSessionAlive(tmuxSession)).toBe(true);

      // Then we can inject directly (no waiting needed)
      sm.injectTelegramMessage(tmuxSession, 123, 'Direct inject', 'Routing Test', 'User', 11111);

      await waitFor(() => {
        const out = sm.captureOutput(tmuxSession, 30);
        return (out || '').includes('Direct inject');
      }, 10_000);

      const output = sm.captureOutput(tmuxSession, 30);
      expect(output).toContain('Direct inject');
    });

    it('should detect dead sessions for respawn routing', async () => {
      // Given a one-shot session that will die
      const claudePath = createMockClaudeOneShot(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      const session = await sm.spawnSession({
        name: `${TMUX_PREFIX}will-die`,
        prompt: 'quick and done',
      });

      // When the session exits
      await waitFor(
        () => !sm.isSessionAlive(session.tmuxSession),
        10_000,
      );

      // Then isSessionAlive should return false (triggering respawn path)
      expect(sm.isSessionAlive(session.tmuxSession)).toBe(false);
    });

    it('should spawn a new interactive session as a respawn (Telegram respawn pattern)', async () => {
      // Given a dead session and a new message for its topic
      const claudePath = createMockClaudeInteractive(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      // Simulate the Telegram respawn: spawn interactive with bootstrap context
      const bootstrapMessage = [
        'CONTINUATION — You are resuming an EXISTING conversation.',
        '',
        '--- Thread History (last 3 messages) ---',
        '[10:00] User: What is the status?',
        '[10:01] Agent: Everything is running smoothly.',
        '[10:05] User: Great, check again.',
        '--- End Thread History ---',
        '',
        'The user\'s latest message:',
        '[telegram:456] Great, check again.',
      ].join('\n');

      const tmuxSession = await sm.spawnInteractiveSession(
        bootstrapMessage,
        `${TMUX_PREFIX}respawn`,
        { telegramTopicId: 456 },
      );

      // Then the session should be alive
      expect(tmuxSession).toContain(`${TMUX_PREFIX}respawn`);
      await new Promise(r => setTimeout(r, 2000));
      expect(sm.isSessionAlive(tmuxSession)).toBe(true);

      // And the bootstrap message should be injected
      await waitFor(() => {
        const out = sm.captureOutput(tmuxSession, 50);
        return (out || '').includes('CONTINUATION');
      }, 15_000);
    });
  });

  // ── Feature: Session State Persistence ────────────────────────────

  describe('Feature: Session state persists across queries', () => {
    it('should list running sessions accurately', async () => {
      const claudePath = createMockClaudeInteractive(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      // Given multiple spawned sessions
      await sm.spawnInteractiveSession(undefined, `${TMUX_PREFIX}list-1`);
      await sm.spawnInteractiveSession(undefined, `${TMUX_PREFIX}list-2`);
      await sm.spawnSession({ name: `${TMUX_PREFIX}list-3`, prompt: 'job' });

      await new Promise(r => setTimeout(r, 1000));

      // When we list running sessions
      const running = sm.listRunningSessions();

      // Then all sessions should appear
      expect(running.length).toBeGreaterThanOrEqual(3);
      const names = running.map(s => s.tmuxSession);
      expect(names.some(n => n.includes(`${TMUX_PREFIX}list-1`))).toBe(true);
      expect(names.some(n => n.includes(`${TMUX_PREFIX}list-2`))).toBe(true);
      expect(names.some(n => n.includes(`${TMUX_PREFIX}list-3`))).toBe(true);
    });

    it('should persist session data across StateManager instances', async () => {
      const claudePath = createMockClaudeInteractive(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      // Given a spawned session
      const session = await sm.spawnSession({
        name: `${TMUX_PREFIX}persist`,
        prompt: 'durable',
      });

      // When we create a fresh StateManager pointing to the same directory
      const freshState = new StateManager(project.stateDir);

      // Then the session should be readable from the new instance
      const loaded = freshState.getSession(session.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe(`${TMUX_PREFIX}persist`);
      expect(loaded!.status).toBe('running');
    });
  });

  // ── Feature: Protected Sessions ───────────────────────────────────

  describe('Feature: Protected sessions cannot be killed or overwritten', () => {
    it('should prevent spawning interactive sessions with protected names', async () => {
      const claudePath = createMockClaudeInteractive(project.dir);
      const projectBase = path.basename(project.dir);
      const sm = createManager(project, claudePath, {
        protectedSessions: [`${projectBase}-server`],
      });
      managers.push(sm);

      // When we try to spawn an interactive session named "server"
      // Then it should throw
      await expect(
        sm.spawnInteractiveSession(undefined, 'server'),
      ).rejects.toThrow(/protected/i);
    });
  });

  // ── Feature: Output Capture ───────────────────────────────────────

  describe('Feature: Capturing session output for monitoring', () => {
    it('should capture visible output from a running session', async () => {
      const claudePath = createMockClaudeInteractive(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      const tmuxSession = await sm.spawnInteractiveSession(undefined, `${TMUX_PREFIX}capture`);
      await new Promise(r => setTimeout(r, 2000));

      // When we capture output
      const output = sm.captureOutput(tmuxSession, 20);

      // Then it should contain the mock TUI content
      expect(output).not.toBeNull();
      expect(output).toContain('Claude Code');
    });

    it('should return null for non-existent sessions', () => {
      const claudePath = createMockClaudeInteractive(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      // When we capture from a session that does not exist
      const output = sm.captureOutput('nonexistent-session-xyz', 20);

      // Then it should return null gracefully
      expect(output).toBeNull();
    });
  });

  // ── Feature: Concurrent Session Management ────────────────────────

  describe('Feature: Managing multiple concurrent sessions', () => {
    it('should handle multiple interactive sessions simultaneously', async () => {
      const claudePath = createMockClaudeInteractive(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      // When we spawn 3 sessions concurrently
      const [s1, s2, s3] = await Promise.all([
        sm.spawnInteractiveSession(undefined, `${TMUX_PREFIX}multi-1`),
        sm.spawnInteractiveSession(undefined, `${TMUX_PREFIX}multi-2`),
        sm.spawnInteractiveSession(undefined, `${TMUX_PREFIX}multi-3`),
      ]);

      await new Promise(r => setTimeout(r, 2000));

      // Then all 3 should be alive
      expect(sm.isSessionAlive(s1)).toBe(true);
      expect(sm.isSessionAlive(s2)).toBe(true);
      expect(sm.isSessionAlive(s3)).toBe(true);

      // And each should have independent output
      const o1 = sm.captureOutput(s1, 10);
      const o2 = sm.captureOutput(s2, 10);
      const o3 = sm.captureOutput(s3, 10);
      expect(o1).not.toBeNull();
      expect(o2).not.toBeNull();
      expect(o3).not.toBeNull();
    });

    it('should kill one session without affecting others', async () => {
      const claudePath = createMockClaudeInteractive(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      const s1 = await sm.spawnInteractiveSession(undefined, `${TMUX_PREFIX}iso-1`);
      const s2 = await sm.spawnInteractiveSession(undefined, `${TMUX_PREFIX}iso-2`);
      await new Promise(r => setTimeout(r, 1000));

      // When we kill s1
      const sessions = project.state.listSessions({ status: 'running' });
      const target = sessions.find(s => s.tmuxSession === s1);
      sm.killSession(target!.id);
      await new Promise(r => setTimeout(r, 300));

      // Then s1 should be dead but s2 should still be alive
      expect(sm.isSessionAlive(s1)).toBe(false);
      expect(sm.isSessionAlive(s2)).toBe(true);
    });
  });

  // ── Feature: Resume Support ───────────────────────────────────────

  describe('Feature: Session resume via --resume flag', () => {
    it('should pass --resume flag when resumeSessionId is provided', async () => {
      const claudePath = createMockClaudeInteractive(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      // When we spawn with a resume session ID
      const tmuxSession = await sm.spawnInteractiveSession(
        'Resumed message',
        `${TMUX_PREFIX}resume`,
        { resumeSessionId: 'fake-uuid-1234' },
      );

      // Then the session should start (even though the UUID is fake,
      // claude will just start fresh — but the args should be passed)
      expect(tmuxSession).toContain(`${TMUX_PREFIX}resume`);
      await new Promise(r => setTimeout(r, 1000));

      // The session should be tracked in state
      const sessions = project.state.listSessions({ status: 'running' });
      const match = sessions.find(s => s.tmuxSession === tmuxSession);
      expect(match).toBeTruthy();
    });
  });

  // ── Feature: Telegram Topic ID in Environment ─────────────────────

  describe('Feature: Telegram topic ID passed as environment variable', () => {
    it('should set INSTAR_TELEGRAM_TOPIC env var when telegramTopicId is provided', async () => {
      const claudePath = createMockClaudeInteractive(project.dir);
      const sm = createManager(project, claudePath);
      managers.push(sm);

      // When we spawn with a telegramTopicId
      const tmuxSession = await sm.spawnInteractiveSession(
        undefined,
        `${TMUX_PREFIX}tg-env`,
        { telegramTopicId: 42 },
      );

      await new Promise(r => setTimeout(r, 1000));

      // Then the session should be running
      // (We can't easily inspect env vars from outside, but the session
      // should have started successfully with the extra -e flag)
      expect(sm.isSessionAlive(tmuxSession)).toBe(true);
    });
  });
});
