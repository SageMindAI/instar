/**
 * Unit tests for HookEventReceiver — HTTP hook event storage and querying.
 *
 * Tests:
 * - Event reception: stores events in JSONL per session
 * - Event querying: retrieves events by session, generates summaries
 * - Session management: lists sessions, enforces limits
 * - Event emission: typed events for downstream consumers
 * - Limits: per-session event trimming, session count cap
 * - Persistence: survives construction/destruction cycle
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  HookEventReceiver,
  type HookEventPayload,
} from '../../src/monitoring/HookEventReceiver.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-hook-event-test-'));
}

function makePayload(overrides?: Partial<HookEventPayload>): HookEventPayload {
  return {
    event: 'PostToolUse',
    session_id: 'session-abc123',
    tool_name: 'Bash',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('HookEventReceiver', () => {
  let tmpDir: string;
  let receiver: HookEventReceiver;

  beforeEach(() => {
    tmpDir = createTempDir();
    receiver = new HookEventReceiver({ stateDir: tmpDir });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Event Reception ──────────────────────────────────────────

  describe('receive()', () => {
    it('stores an event and returns true', () => {
      const result = receiver.receive(makePayload());
      expect(result).toBe(true);
    });

    it('stores multiple events for the same session', () => {
      receiver.receive(makePayload({ tool_name: 'Bash' }));
      receiver.receive(makePayload({ tool_name: 'Read' }));
      receiver.receive(makePayload({ tool_name: 'Write' }));

      const events = receiver.getSessionEvents('session-abc123');
      expect(events).toHaveLength(3);
      expect(events.map(e => e.payload.tool_name)).toEqual(['Bash', 'Read', 'Write']);
    });

    it('stores events for different sessions separately', () => {
      receiver.receive(makePayload({ session_id: 'session-1' }));
      receiver.receive(makePayload({ session_id: 'session-2' }));
      receiver.receive(makePayload({ session_id: 'session-1' }));

      expect(receiver.getSessionEvents('session-1')).toHaveLength(2);
      expect(receiver.getSessionEvents('session-2')).toHaveLength(1);
    });

    it('handles missing session_id gracefully', () => {
      receiver.receive({ event: 'PostToolUse' });
      const events = receiver.getSessionEvents('unknown');
      expect(events).toHaveLength(1);
    });

    it('records receivedAt timestamp', () => {
      const before = new Date().toISOString();
      receiver.receive(makePayload());
      const after = new Date().toISOString();

      const events = receiver.getSessionEvents('session-abc123');
      expect(events[0].receivedAt >= before).toBe(true);
      expect(events[0].receivedAt <= after).toBe(true);
    });
  });

  // ── Event Querying ───────────────────────────────────────────

  describe('getSessionEvents()', () => {
    it('returns empty array for unknown session', () => {
      expect(receiver.getSessionEvents('nonexistent')).toEqual([]);
    });

    it('preserves full payload', () => {
      const payload = makePayload({
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
        agent_id: 'agent-xyz',
        agent_type: 'Explore',
      });
      receiver.receive(payload);

      const events = receiver.getSessionEvents('session-abc123');
      expect(events[0].payload.tool_name).toBe('Bash');
      expect(events[0].payload.tool_input).toEqual({ command: 'ls -la' });
      expect(events[0].payload.agent_id).toBe('agent-xyz');
      expect(events[0].payload.agent_type).toBe('Explore');
    });
  });

  describe('getSessionSummary()', () => {
    it('returns null for unknown session', () => {
      expect(receiver.getSessionSummary('nonexistent')).toBeNull();
    });

    it('generates accurate summary', () => {
      receiver.receive(makePayload({ event: 'PostToolUse', tool_name: 'Bash' }));
      receiver.receive(makePayload({ event: 'PostToolUse', tool_name: 'Read' }));
      receiver.receive(makePayload({ event: 'PostToolUse', tool_name: 'Bash' }));
      receiver.receive(makePayload({ event: 'SubagentStart', agent_type: 'Explore' }));
      receiver.receive(makePayload({
        event: 'Stop',
        last_assistant_message: 'Done with the task.',
      }));

      const summary = receiver.getSessionSummary('session-abc123');
      expect(summary).not.toBeNull();
      expect(summary!.eventCount).toBe(5);
      expect(summary!.eventTypes).toEqual({
        PostToolUse: 3,
        SubagentStart: 1,
        Stop: 1,
      });
      expect(summary!.toolsUsed.sort()).toEqual(['Bash', 'Read']);
      expect(summary!.subagentsSpawned).toEqual(['Explore']);
      expect(summary!.lastAssistantMessage).toBe('Done with the task.');
    });
  });

  // ── Session Management ───────────────────────────────────────

  describe('listSessions()', () => {
    it('returns empty array when no events stored', () => {
      expect(receiver.listSessions()).toEqual([]);
    });

    it('lists all sessions with events', () => {
      receiver.receive(makePayload({ session_id: 'session-a' }));
      receiver.receive(makePayload({ session_id: 'session-b' }));
      receiver.receive(makePayload({ session_id: 'session-c' }));

      const sessions = receiver.listSessions();
      expect(sessions).toHaveLength(3);
      expect(sessions.sort()).toEqual(['session-a', 'session-b', 'session-c']);
    });
  });

  describe('getIndex()', () => {
    it('tracks event counts per session', () => {
      receiver.receive(makePayload({ session_id: 'session-a' }));
      receiver.receive(makePayload({ session_id: 'session-a' }));
      receiver.receive(makePayload({ session_id: 'session-b' }));

      const index = receiver.getIndex();
      expect(index.get('session-a')).toBe(2);
      expect(index.get('session-b')).toBe(1);
    });
  });

  // ── Event Emission ───────────────────────────────────────────

  describe('event emission', () => {
    it('emits generic "event" for every payload', () => {
      const events: HookEventPayload[] = [];
      receiver.on('event', (p: HookEventPayload) => events.push(p));

      receiver.receive(makePayload({ event: 'PostToolUse' }));
      receiver.receive(makePayload({ event: 'SubagentStart' }));

      expect(events).toHaveLength(2);
    });

    it('emits typed events (e.g., "PostToolUse", "SubagentStart")', () => {
      const postToolUse: HookEventPayload[] = [];
      const subagentStart: HookEventPayload[] = [];

      receiver.on('PostToolUse', (p: HookEventPayload) => postToolUse.push(p));
      receiver.on('SubagentStart', (p: HookEventPayload) => subagentStart.push(p));

      receiver.receive(makePayload({ event: 'PostToolUse' }));
      receiver.receive(makePayload({ event: 'SubagentStart' }));
      receiver.receive(makePayload({ event: 'PostToolUse' }));

      expect(postToolUse).toHaveLength(2);
      expect(subagentStart).toHaveLength(1);
    });
  });

  // ── Limits ───────────────────────────────────────────────────

  describe('per-session event limit', () => {
    it('trims old events when limit exceeded', () => {
      const limited = new HookEventReceiver({
        stateDir: tmpDir,
        maxEventsPerSession: 5,
      });

      for (let i = 0; i < 10; i++) {
        limited.receive(makePayload({
          session_id: 'limited-session',
          tool_name: `tool-${i}`,
        }));
      }

      const events = limited.getSessionEvents('limited-session');
      expect(events.length).toBeLessThanOrEqual(5);
      // Should keep the most recent events
      expect(events[events.length - 1].payload.tool_name).toBe('tool-9');
    });
  });

  describe('session count limit', () => {
    it('removes oldest sessions when limit exceeded', () => {
      const limited = new HookEventReceiver({
        stateDir: tmpDir,
        maxSessions: 3,
      });

      for (let i = 0; i < 5; i++) {
        limited.receive(makePayload({ session_id: `session-${i.toString().padStart(3, '0')}` }));
      }

      const sessions = limited.listSessions();
      expect(sessions.length).toBeLessThanOrEqual(3);
    });
  });

  // ── Persistence ──────────────────────────────────────────────

  describe('persistence', () => {
    it('events survive construction/destruction cycle', () => {
      receiver.receive(makePayload({ session_id: 'persistent', tool_name: 'Bash' }));
      receiver.receive(makePayload({ session_id: 'persistent', tool_name: 'Read' }));

      // Create new instance pointing to same stateDir
      const receiver2 = new HookEventReceiver({ stateDir: tmpDir });
      const events = receiver2.getSessionEvents('persistent');
      expect(events).toHaveLength(2);
      expect(events[0].payload.tool_name).toBe('Bash');
      expect(events[1].payload.tool_name).toBe('Read');

      // Index is also restored
      const index = receiver2.getIndex();
      expect(index.get('persistent')).toBe(2);
    });
  });

  // ── Quality Gate Methods (M5/H6) ────────────────────────────

  describe('hasTaskCompleted()', () => {
    it('returns false when no TaskCompleted event', () => {
      receiver.receive(makePayload({ event: 'PostToolUse' }));
      expect(receiver.hasTaskCompleted('session-abc123')).toBe(false);
    });

    it('returns true when TaskCompleted event exists', () => {
      receiver.receive(makePayload({ event: 'PostToolUse' }));
      receiver.receive(makePayload({ event: 'TaskCompleted', task_id: 'task-1' }));
      expect(receiver.hasTaskCompleted('session-abc123')).toBe(true);
    });
  });

  describe('getLastAssistantMessage()', () => {
    it('returns null when no message found', () => {
      receiver.receive(makePayload({ event: 'PostToolUse' }));
      expect(receiver.getLastAssistantMessage('session-abc123')).toBeNull();
    });

    it('returns the last assistant message from Stop event', () => {
      receiver.receive(makePayload({ event: 'PostToolUse' }));
      receiver.receive(makePayload({
        event: 'Stop',
        last_assistant_message: 'Done with the task.',
      }));
      expect(receiver.getLastAssistantMessage('session-abc123')).toBe('Done with the task.');
    });

    it('returns the most recent message when multiple exist', () => {
      receiver.receive(makePayload({
        event: 'SubagentStop',
        last_assistant_message: 'Subagent result',
      }));
      receiver.receive(makePayload({
        event: 'Stop',
        last_assistant_message: 'Final output',
      }));
      expect(receiver.getLastAssistantMessage('session-abc123')).toBe('Final output');
    });
  });

  describe('getExitReason()', () => {
    it('returns null when no SessionEnd event', () => {
      receiver.receive(makePayload({ event: 'PostToolUse' }));
      expect(receiver.getExitReason('session-abc123')).toBeNull();
    });

    it('returns the exit reason from SessionEnd', () => {
      receiver.receive(makePayload({
        event: 'SessionEnd',
        reason: 'clear',
      }));
      expect(receiver.getExitReason('session-abc123')).toBe('clear');
    });
  });

  // ── Edge Cases ───────────────────────────────────────────────

  describe('edge cases', () => {
    it('sanitizes session IDs with special characters', () => {
      receiver.receive(makePayload({ session_id: '../../../etc/passwd' }));
      // Should store safely without path traversal
      const sessions = receiver.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).not.toContain('/');
    });

    it('handles various event types', () => {
      const eventTypes = [
        'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop',
        'SessionEnd', 'TaskCompleted', 'WorktreeCreate', 'WorktreeRemove',
        'InstructionsLoaded', 'PreCompact', 'ConfigChange',
      ];

      for (const event of eventTypes) {
        receiver.receive(makePayload({ event, session_id: 'multi-event' }));
      }

      const summary = receiver.getSessionSummary('multi-event');
      expect(summary!.eventCount).toBe(eventTypes.length);
      expect(Object.keys(summary!.eventTypes).sort()).toEqual(eventTypes.sort());
    });
  });
});
