/**
 * Unit tests for HelperWatchdog — stall + failure detection for
 * spawned subagents. Sits on top of SubagentTracker's event stream.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SubagentTracker } from '../../src/monitoring/SubagentTracker.js';
import { HelperWatchdog } from '../../src/monitoring/HelperWatchdog.js';

function createTmpState(): { stateDir: string; cleanup: () => void } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-watchdog-test-'));
  return {
    stateDir,
    // safe-git-allow: incremental-migration
    cleanup: () => fs.rmSync(stateDir, { recursive: true, force: true }),
  };
}

interface MockTimer {
  fn: () => void;
  ms: number;
  handle: number;
  cleared: boolean;
}

function makeFakeTimers(): {
  setTimeoutFn: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn: (h: NodeJS.Timeout) => void;
  fireAll: () => void;
  pending: () => MockTimer[];
} {
  let nextId = 1;
  const timers: MockTimer[] = [];
  return {
    setTimeoutFn: (fn, ms) => {
      const t: MockTimer = { fn, ms, handle: nextId++, cleared: false };
      timers.push(t);
      return t.handle as unknown as NodeJS.Timeout;
    },
    clearTimeoutFn: (h) => {
      const t = timers.find((x) => x.handle === (h as unknown as number));
      if (t) t.cleared = true;
    },
    fireAll: () => {
      for (const t of timers) {
        if (!t.cleared) t.fn();
      }
    },
    pending: () => timers.filter((t) => !t.cleared),
  };
}

describe('HelperWatchdog', () => {
  let stateDir: string;
  let cleanup: () => void;
  let tracker: SubagentTracker;

  beforeEach(() => {
    ({ stateDir, cleanup } = createTmpState());
    tracker = new SubagentTracker({ stateDir });
  });

  afterEach(() => {
    cleanup();
  });

  // ── classifyStopMessage ────────────────────────────────

  describe('classifyStopMessage (static)', () => {
    it('detects rate-limit phrasing', () => {
      expect(HelperWatchdog.classifyStopMessage('Error: rate limit exceeded')?.reason).toBe(
        'rate-limit',
      );
      expect(HelperWatchdog.classifyStopMessage('429 Too Many Requests')?.reason).toBe(
        'rate-limit',
      );
    });

    it('detects quota exhaustion', () => {
      expect(HelperWatchdog.classifyStopMessage('Quota exhausted, try again later')?.reason).toBe(
        'quota-exhausted',
      );
      expect(HelperWatchdog.classifyStopMessage('Out of credits')?.reason).toBe(
        'quota-exhausted',
      );
    });

    it('detects auth errors', () => {
      expect(HelperWatchdog.classifyStopMessage('Unauthorized: invalid API key')?.reason).toBe(
        'auth-error',
      );
      expect(HelperWatchdog.classifyStopMessage('HTTP 403 Forbidden')?.reason).toBe('auth-error');
    });

    it('detects timeout markers', () => {
      expect(HelperWatchdog.classifyStopMessage('Request timed out after 60s')?.reason).toBe(
        'timeout',
      );
    });

    it('returns null for clean stop messages', () => {
      expect(HelperWatchdog.classifyStopMessage('Task complete')).toBeNull();
      expect(HelperWatchdog.classifyStopMessage('')).toBeNull();
      expect(HelperWatchdog.classifyStopMessage(null)).toBeNull();
      expect(HelperWatchdog.classifyStopMessage(undefined)).toBeNull();
    });
  });

  // ── Stall detection ────────────────────────────────────

  describe('stall detection', () => {
    it('emits `stall` after stallTimeoutMs with no stop event', () => {
      const timers = makeFakeTimers();
      const wd = new HelperWatchdog({
        subagentTracker: tracker,
        stallTimeoutMs: 5000,
        setTimeoutFn: timers.setTimeoutFn,
        clearTimeoutFn: timers.clearTimeoutFn,
      });
      wd.start();

      const events: unknown[] = [];
      wd.on('stall', (e) => events.push(e));

      tracker.onStart('agent-1', 'Explore', 'session-a');
      expect(timers.pending().length).toBe(1);

      timers.fireAll();
      expect(events.length).toBe(1);
      const ev = events[0] as { agentId: string; reason: string };
      expect(ev.agentId).toBe('agent-1');
      expect(ev.reason).toBe('stall-timeout');
    });

    it('does NOT emit stall if the subagent stops in time', () => {
      const timers = makeFakeTimers();
      const wd = new HelperWatchdog({
        subagentTracker: tracker,
        stallTimeoutMs: 5000,
        setTimeoutFn: timers.setTimeoutFn,
        clearTimeoutFn: timers.clearTimeoutFn,
      });
      wd.start();

      const stallEvents: unknown[] = [];
      wd.on('stall', (e) => stallEvents.push(e));

      tracker.onStart('agent-2', 'Plan', 'session-b');
      tracker.onStop('agent-2', 'session-b', 'Done');

      // Firing any remaining pending timers to prove the start-timer
      // was properly cleared (it should not fire).
      timers.fireAll();
      expect(stallEvents.length).toBe(0);
    });

    it('is idempotent on duplicate start events', () => {
      const timers = makeFakeTimers();
      const wd = new HelperWatchdog({
        subagentTracker: tracker,
        setTimeoutFn: timers.setTimeoutFn,
        clearTimeoutFn: timers.clearTimeoutFn,
      });
      wd.start();
      tracker.onStart('agent-3', 'Explore', 'session-c');
      tracker.onStart('agent-3', 'Explore', 'session-c');
      expect(timers.pending().length).toBe(1);
    });
  });

  // ── Failure detection via stop payload ─────────────────

  describe('helper-failed on rate-limit stop', () => {
    it('emits `helper-failed` when stop lastMessage contains a rate-limit marker', () => {
      const timers = makeFakeTimers();
      const wd = new HelperWatchdog({
        subagentTracker: tracker,
        setTimeoutFn: timers.setTimeoutFn,
        clearTimeoutFn: timers.clearTimeoutFn,
      });
      wd.start();

      const events: unknown[] = [];
      wd.on('helper-failed', (e) => events.push(e));

      tracker.onStart('agent-4', 'Explore', 'session-d');
      tracker.onStop('agent-4', 'session-d', '429 rate limit — please retry later');

      expect(events.length).toBe(1);
      const ev = events[0] as { reason: string; record: { agentId: string } };
      expect(ev.reason).toBe('rate-limit');
      expect(ev.record.agentId).toBe('agent-4');
    });

    it('does not emit `helper-failed` on a clean stop message', () => {
      const wd = new HelperWatchdog({ subagentTracker: tracker });
      wd.start();

      const events: unknown[] = [];
      wd.on('helper-failed', (e) => events.push(e));

      tracker.onStart('agent-5', 'Plan', 'session-e');
      tracker.onStop('agent-5', 'session-e', 'Task completed successfully');

      expect(events.length).toBe(0);
    });

    it('clears the stall timer when stop fires, even if the message is a failure', () => {
      const timers = makeFakeTimers();
      const wd = new HelperWatchdog({
        subagentTracker: tracker,
        stallTimeoutMs: 5000,
        setTimeoutFn: timers.setTimeoutFn,
        clearTimeoutFn: timers.clearTimeoutFn,
      });
      wd.start();

      const stallEvents: unknown[] = [];
      wd.on('stall', (e) => stallEvents.push(e));

      tracker.onStart('agent-6', 'Explore', 'session-f');
      tracker.onStop('agent-6', 'session-f', 'quota exhausted');
      timers.fireAll();
      expect(stallEvents.length).toBe(0);
    });
  });

  // ── Teardown ───────────────────────────────────────────

  describe('stop()', () => {
    it('unsubscribes and clears pending timers', () => {
      const timers = makeFakeTimers();
      const wd = new HelperWatchdog({
        subagentTracker: tracker,
        setTimeoutFn: timers.setTimeoutFn,
        clearTimeoutFn: timers.clearTimeoutFn,
      });
      wd.start();
      tracker.onStart('agent-7', 'Explore', 'session-g');
      expect(timers.pending().length).toBe(1);

      wd.stop();
      expect(timers.pending().length).toBe(0);

      const events: unknown[] = [];
      wd.on('stall', (e) => events.push(e));
      wd.on('helper-failed', (e) => events.push(e));

      // Further tracker events should be ignored after stop().
      tracker.onStart('agent-8', 'Plan', 'session-h');
      tracker.onStop('agent-8', 'session-h', '429 rate limit');
      expect(events.length).toBe(0);
    });
  });
});
