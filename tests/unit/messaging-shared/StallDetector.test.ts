import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StallDetector, type StallEvent } from '../../../src/messaging/shared/StallDetector.js';

describe('StallDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Promise message detection ──────────────────────────

  describe('isPromiseMessage', () => {
    it('detects common promise patterns', () => {
      const detector = new StallDetector();
      const promises = [
        'Give me a minute',
        'Working on it now',
        'Looking into this',
        'Let me check that',
        "I'll get back to you",
        'One moment please',
        'Investigating the issue',
        'Still working on it',
        'Bear with me',
        'Hang on',
        'Narrowing it down',
        'Give me a couple more minutes',
      ];

      for (const msg of promises) {
        expect(detector.isPromiseMessage(msg)).toBe(true);
      }
    });

    it('does not match non-promise messages', () => {
      const detector = new StallDetector();
      const notPromises = [
        'Here is the result',
        'Done!',
        'The fix is deployed',
        'Hello world',
        'What do you think?',
      ];

      for (const msg of notPromises) {
        expect(detector.isPromiseMessage(msg)).toBe(false);
      }
    });
  });

  describe('isFollowThroughMessage', () => {
    it('detects long messages as follow-through', () => {
      const detector = new StallDetector();
      const longMsg = 'A'.repeat(201);
      expect(detector.isFollowThroughMessage(longMsg)).toBe(true);
    });

    it('detects completion signals in short messages', () => {
      const detector = new StallDetector();
      expect(detector.isFollowThroughMessage("Here's the result")).toBe(true);
      expect(detector.isFollowThroughMessage('I found the issue')).toBe(true);
      expect(detector.isFollowThroughMessage('Done and deployed')).toBe(true);
      expect(detector.isFollowThroughMessage('The fix is ready')).toBe(true);
    });

    it('does not match short non-completion messages', () => {
      const detector = new StallDetector();
      expect(detector.isFollowThroughMessage('ok')).toBe(false);
      expect(detector.isFollowThroughMessage('hmm')).toBe(false);
      expect(detector.isFollowThroughMessage('working...')).toBe(false);
    });
  });

  // ── Stall tracking ──────────────────────────────────────

  describe('stall detection', () => {
    it('fires stall callback after timeout', async () => {
      const events: Array<{ event: StallEvent; alive: boolean }> = [];

      const detector = new StallDetector({ stallTimeoutMinutes: 5 });
      detector.setOnStall(async (event, alive) => {
        events.push({ event, alive });
      });

      detector.trackMessageInjection('100', 'session-a', 'hello there');

      // Before timeout — no stall
      vi.advanceTimersByTime(4 * 60 * 1000);
      await detector.check();
      expect(events).toHaveLength(0);

      // After timeout — stall detected
      vi.advanceTimersByTime(2 * 60 * 1000);
      await detector.check();
      expect(events).toHaveLength(1);
      expect(events[0].event.type).toBe('stall');
      expect(events[0].event.channelId).toBe('100');
      expect(events[0].event.sessionName).toBe('session-a');
      expect(events[0].event.minutesElapsed).toBe(6);
      expect(events[0].alive).toBe(true); // default: assume alive
    });

    it('clears stall when agent responds', async () => {
      const events: StallEvent[] = [];

      const detector = new StallDetector({ stallTimeoutMinutes: 5 });
      detector.setOnStall(async (event) => { events.push(event); });

      detector.trackMessageInjection('100', 'session-a', 'hello');

      // Agent responds — clear stall
      detector.clearStallForChannel('100');

      vi.advanceTimersByTime(10 * 60 * 1000);
      await detector.check();
      expect(events).toHaveLength(0);
    });

    it('only alerts once per stall', async () => {
      const events: StallEvent[] = [];

      const detector = new StallDetector({ stallTimeoutMinutes: 1 });
      detector.setOnStall(async (event) => { events.push(event); });

      detector.trackMessageInjection('100', 'session-a', 'hello');

      vi.advanceTimersByTime(2 * 60 * 1000);
      await detector.check();
      await detector.check();
      await detector.check();
      expect(events).toHaveLength(1);
    });

    it('reports session as dead when isSessionAlive returns false', async () => {
      const events: Array<{ event: StallEvent; alive: boolean }> = [];

      const detector = new StallDetector({ stallTimeoutMinutes: 1 });
      detector.setIsSessionAlive(() => false);
      detector.setOnStall(async (event, alive) => {
        events.push({ event, alive });
      });

      detector.trackMessageInjection('100', 'session-a', 'hello');

      vi.advanceTimersByTime(2 * 60 * 1000);
      await detector.check();
      expect(events).toHaveLength(1);
      expect(events[0].alive).toBe(false);
    });

    it('clears stall when session is verified active', async () => {
      const events: StallEvent[] = [];

      const detector = new StallDetector({ stallTimeoutMinutes: 1 });
      detector.setIsSessionAlive(() => true);
      detector.setIsSessionActive(async () => true); // session is actively producing output
      detector.setOnStall(async (event) => { events.push(event); });

      detector.trackMessageInjection('100', 'session-a', 'hello');

      vi.advanceTimersByTime(2 * 60 * 1000);
      await detector.check();
      expect(events).toHaveLength(0); // Active session — false alarm cleared
    });
  });

  // ── Promise tracking ──────────────────────────────────

  describe('promise tracking', () => {
    it('fires promise-expired callback after timeout', async () => {
      const events: StallEvent[] = [];

      const detector = new StallDetector({ promiseTimeoutMinutes: 10 });
      detector.setOnStall(async (event) => { events.push(event); });

      detector.trackOutboundMessage('100', 'session-a', 'Working on it now');

      // Before timeout
      vi.advanceTimersByTime(8 * 60 * 1000);
      await detector.check();
      expect(events).toHaveLength(0);

      // After timeout
      vi.advanceTimersByTime(3 * 60 * 1000);
      await detector.check();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('promise-expired');
    });

    it('clears promise on follow-through', async () => {
      const events: StallEvent[] = [];

      const detector = new StallDetector({ promiseTimeoutMinutes: 10 });
      detector.setOnStall(async (event) => { events.push(event); });

      detector.trackOutboundMessage('100', 'session-a', 'Working on it now');
      detector.trackOutboundMessage('100', 'session-a', "Here's the result of my analysis and it's quite detailed");

      vi.advanceTimersByTime(15 * 60 * 1000);
      await detector.check();
      expect(events).toHaveLength(0);
    });

    it('clears promise when clearPromiseForChannel is called', async () => {
      const events: StallEvent[] = [];

      const detector = new StallDetector({ promiseTimeoutMinutes: 1 });
      detector.setOnStall(async (event) => { events.push(event); });

      detector.trackOutboundMessage('100', 'session-a', 'Working on it');
      detector.clearPromiseForChannel('100');

      vi.advanceTimersByTime(5 * 60 * 1000);
      await detector.check();
      expect(events).toHaveLength(0);
    });
  });

  // ── Health status ──────────────────────────────────────

  describe('getStatus', () => {
    it('reports correct pending counts', () => {
      const detector = new StallDetector();
      expect(detector.getStatus()).toEqual({ pendingStalls: 0, pendingPromises: 0 });

      detector.trackMessageInjection('100', 'session-a', 'hello');
      detector.trackMessageInjection('200', 'session-b', 'world');
      expect(detector.getStatus().pendingStalls).toBe(2);

      detector.trackOutboundMessage('100', 'session-a', 'Working on it');
      expect(detector.getStatus().pendingPromises).toBe(1);
    });
  });

  // ── Start/stop ──────────────────────────────────────

  describe('start/stop', () => {
    it('does not start interval when timeouts are 0', () => {
      const detector = new StallDetector({ stallTimeoutMinutes: 0, promiseTimeoutMinutes: 0 });
      detector.start();
      // Should not throw, and no interval should be created
      detector.stop();
    });

    it('starts and stops cleanly', () => {
      const detector = new StallDetector({ stallTimeoutMinutes: 5 });
      detector.start();
      detector.stop();
      // Double stop should not throw
      detector.stop();
    });
  });

  // ── Cleanup ──────────────────────────────────────────

  describe('cleanup', () => {
    it('cleans up old alerted entries', async () => {
      const detector = new StallDetector({ stallTimeoutMinutes: 1 });
      detector.setOnStall(async () => {});

      detector.trackMessageInjection('100', 'session-a', 'hello');

      // Trigger alert
      vi.advanceTimersByTime(2 * 60 * 1000);
      await detector.check();
      expect(detector.getStatus().pendingStalls).toBe(1);

      // After 30 min cleanup threshold
      vi.advanceTimersByTime(31 * 60 * 1000);
      await detector.check();
      expect(detector.getStatus().pendingStalls).toBe(0);
    });
  });
});
