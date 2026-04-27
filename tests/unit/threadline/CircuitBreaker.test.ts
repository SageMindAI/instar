import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CircuitBreaker } from '../../../src/threadline/CircuitBreaker.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import type { TrustChangeNotification } from '../../../src/threadline/AgentTrustManager.js';

describe('CircuitBreaker', () => {
  let tmpDir: string;
  let stateDir: string;
  let currentTime: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'circuit-test-'));
    stateDir = tmpDir;
    currentTime = Date.now();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createBreaker(opts?: {
    trustManager?: AgentTrustManager;
    nowFn?: () => number;
  }): CircuitBreaker {
    return new CircuitBreaker({
      stateDir,
      trustManager: opts?.trustManager,
      nowFn: opts?.nowFn ?? (() => currentTime),
    });
  }

  function createTrustManager(): AgentTrustManager {
    return new AgentTrustManager({ stateDir });
  }

  // ── Initial State ───────────────────────────────────────────────

  describe('initial state', () => {
    it('returns null for unknown agent', () => {
      const cb = createBreaker();
      expect(cb.getState('unknown')).toBeNull();
    });

    it('isOpen returns false for unknown agent', () => {
      const cb = createBreaker();
      expect(cb.isOpen('unknown')).toBe(false);
    });

    it('creates closed circuit on first interaction', () => {
      const cb = createBreaker();
      cb.recordSuccess('agent-a');
      const state = cb.getState('agent-a');
      expect(state).not.toBeNull();
      expect(state!.state).toBe('closed');
    });
  });

  // ── Success Recording ───────────────────────────────────────────

  describe('success recording', () => {
    it('increments totalSuccesses', () => {
      const cb = createBreaker();
      cb.recordSuccess('agent-a');
      cb.recordSuccess('agent-a');
      const state = cb.getState('agent-a')!;
      expect(state.totalSuccesses).toBe(2);
    });

    it('resets consecutiveFailures', () => {
      const cb = createBreaker();
      cb.recordFailure('agent-a');
      cb.recordFailure('agent-a');
      cb.recordSuccess('agent-a');
      expect(cb.getState('agent-a')!.consecutiveFailures).toBe(0);
    });

    it('updates lastSuccess timestamp', () => {
      const cb = createBreaker();
      cb.recordSuccess('agent-a');
      expect(cb.getState('agent-a')!.lastSuccess).toBeTruthy();
    });
  });

  // ── Failure Recording ───────────────────────────────────────────

  describe('failure recording', () => {
    it('increments consecutiveFailures and totalFailures', () => {
      const cb = createBreaker();
      cb.recordFailure('agent-a');
      cb.recordFailure('agent-a');
      const state = cb.getState('agent-a')!;
      expect(state.consecutiveFailures).toBe(2);
      expect(state.totalFailures).toBe(2);
    });

    it('updates lastFailure timestamp', () => {
      const cb = createBreaker();
      cb.recordFailure('agent-a');
      expect(cb.getState('agent-a')!.lastFailure).toBeTruthy();
    });
  });

  // ── State Transitions: closed → open ────────────────────────────

  describe('closed → open transition', () => {
    it('opens after 5 consecutive failures', () => {
      const cb = createBreaker();
      for (let i = 0; i < 5; i++) {
        cb.recordFailure('agent-a');
      }
      expect(cb.getState('agent-a')!.state).toBe('open');
      expect(cb.isOpen('agent-a')).toBe(true);
    });

    it('does not open at 4 failures', () => {
      const cb = createBreaker();
      for (let i = 0; i < 4; i++) {
        cb.recordFailure('agent-a');
      }
      expect(cb.getState('agent-a')!.state).toBe('closed');
      expect(cb.isOpen('agent-a')).toBe(false);
    });

    it('success resets failure count — needs 5 new consecutive failures to open', () => {
      const cb = createBreaker();
      cb.recordFailure('agent-a');
      cb.recordFailure('agent-a');
      cb.recordFailure('agent-a');
      cb.recordFailure('agent-a');
      cb.recordSuccess('agent-a'); // Reset
      cb.recordFailure('agent-a');
      expect(cb.getState('agent-a')!.state).toBe('closed');
    });

    it('records openedAt timestamp when opening', () => {
      const cb = createBreaker();
      for (let i = 0; i < 5; i++) {
        cb.recordFailure('agent-a');
      }
      expect(cb.getState('agent-a')!.openedAt).toBeTruthy();
    });

    it('increments activationCount when opening', () => {
      const cb = createBreaker();
      for (let i = 0; i < 5; i++) {
        cb.recordFailure('agent-a');
      }
      expect(cb.getState('agent-a')!.activationCount).toBe(1);
    });
  });

  // ── State Transitions: open → half-open ─────────────────────────

  describe('open → half-open transition', () => {
    it('transitions to half-open after 1 hour', () => {
      const cb = createBreaker();
      for (let i = 0; i < 5; i++) {
        cb.recordFailure('agent-a');
      }
      expect(cb.getState('agent-a')!.state).toBe('open');

      // Advance time by 1 hour
      currentTime += 60 * 60 * 1000;
      expect(cb.isOpen('agent-a')).toBe(false);
      expect(cb.getState('agent-a')!.state).toBe('half-open');
    });

    it('remains open before 1 hour', () => {
      const cb = createBreaker();
      for (let i = 0; i < 5; i++) {
        cb.recordFailure('agent-a');
      }

      currentTime += 59 * 60 * 1000; // 59 minutes
      expect(cb.isOpen('agent-a')).toBe(true);
    });
  });

  // ── State Transitions: half-open → closed ───────────────────────

  describe('half-open → closed transition', () => {
    it('closes on success during half-open', () => {
      const cb = createBreaker();
      for (let i = 0; i < 5; i++) {
        cb.recordFailure('agent-a');
      }

      // Advance to half-open
      currentTime += 60 * 60 * 1000;
      cb.isOpen('agent-a'); // Triggers transition

      cb.recordSuccess('agent-a');
      expect(cb.getState('agent-a')!.state).toBe('closed');
    });

    it('reopens on failure during half-open', () => {
      const cb = createBreaker();
      for (let i = 0; i < 5; i++) {
        cb.recordFailure('agent-a');
      }

      // Advance to half-open
      currentTime += 60 * 60 * 1000;
      cb.isOpen('agent-a');

      cb.recordFailure('agent-a');
      expect(cb.getState('agent-a')!.state).toBe('open');
      expect(cb.getState('agent-a')!.activationCount).toBe(2);
    });
  });

  // ── 3-in-24h Auto-Downgrade ─────────────────────────────────────

  describe('3-in-24h auto-downgrade', () => {
    it('triggers auto-downgrade after 3 activations in 24h', () => {
      const notifications: TrustChangeNotification[] = [];
      const tm = new AgentTrustManager({
        stateDir,
        onTrustChange: n => notifications.push(n),
      });
      tm.setTrustLevel('agent-a', 'trusted', 'user-granted');
      notifications.length = 0;

      const cb = createBreaker({ trustManager: tm });

      // First activation
      for (let i = 0; i < 5; i++) cb.recordFailure('agent-a');
      expect(cb.getState('agent-a')!.activationCount).toBe(1);

      // Reset and second activation
      currentTime += 2 * 60 * 60 * 1000;
      cb.isOpen('agent-a'); // half-open
      cb.recordSuccess('agent-a'); // close
      for (let i = 0; i < 5; i++) cb.recordFailure('agent-a');
      expect(cb.getState('agent-a')!.activationCount).toBe(2);

      // Reset and third activation
      currentTime += 2 * 60 * 60 * 1000;
      cb.isOpen('agent-a'); // half-open
      cb.recordSuccess('agent-a');
      for (let i = 0; i < 5; i++) cb.recordFailure('agent-a');
      expect(cb.getState('agent-a')!.activationCount).toBe(3);

      // Trust should have been auto-downgraded
      expect(tm.getProfile('agent-a')!.level).toBe('untrusted');
      const downgradeNotif = notifications.find(n => n.newLevel === 'untrusted');
      expect(downgradeNotif).toBeDefined();
    });

    it('does not trigger if activations are spread over > 24h', () => {
      const tm = createTrustManager();
      tm.setTrustLevel('agent-a', 'trusted', 'user-granted');

      const cb = createBreaker({ trustManager: tm });

      // First activation
      for (let i = 0; i < 5; i++) cb.recordFailure('agent-a');

      // Second activation after 13h
      currentTime += 13 * 60 * 60 * 1000;
      cb.isOpen('agent-a');
      cb.recordSuccess('agent-a');
      for (let i = 0; i < 5; i++) cb.recordFailure('agent-a');

      // Third activation after another 13h (first is now > 24h ago)
      currentTime += 13 * 60 * 60 * 1000;
      cb.isOpen('agent-a');
      cb.recordSuccess('agent-a');
      for (let i = 0; i < 5; i++) cb.recordFailure('agent-a');

      // First activation should have aged out of the window
      expect(tm.getProfile('agent-a')!.level).toBe('trusted');
    });

    it('checkAutoDowngrade returns false without trust manager', () => {
      const cb = createBreaker();
      for (let i = 0; i < 5; i++) cb.recordFailure('agent-a');
      expect(cb.checkAutoDowngrade('agent-a')).toBe(false);
    });
  });

  // ── Manual Reset ────────────────────────────────────────────────

  describe('manual reset', () => {
    it('closes an open circuit', () => {
      const cb = createBreaker();
      for (let i = 0; i < 5; i++) cb.recordFailure('agent-a');
      expect(cb.getState('agent-a')!.state).toBe('open');

      cb.reset('agent-a');
      expect(cb.getState('agent-a')!.state).toBe('closed');
      expect(cb.getState('agent-a')!.consecutiveFailures).toBe(0);
    });

    it('returns false for unknown agent', () => {
      const cb = createBreaker();
      expect(cb.reset('unknown')).toBe(false);
    });

    it('records resetAt timestamp', () => {
      const cb = createBreaker();
      cb.recordSuccess('agent-a');
      for (let i = 0; i < 5; i++) cb.recordFailure('agent-a');
      cb.reset('agent-a');
      expect(cb.getState('agent-a')!.resetAt).toBeTruthy();
    });
  });

  // ── Multiple Agents ─────────────────────────────────────────────

  describe('multiple agents tracked independently', () => {
    it('opening one circuit does not affect another', () => {
      const cb = createBreaker();
      cb.recordSuccess('agent-b');
      for (let i = 0; i < 5; i++) cb.recordFailure('agent-a');

      expect(cb.isOpen('agent-a')).toBe(true);
      expect(cb.isOpen('agent-b')).toBe(false);
    });

    it('getAllStates returns all circuits', () => {
      const cb = createBreaker();
      cb.recordSuccess('agent-a');
      cb.recordSuccess('agent-b');
      cb.recordFailure('agent-c');

      const states = cb.getAllStates();
      expect(states).toHaveLength(3);
    });
  });

  // ── Persistence ─────────────────────────────────────────────────

  describe('persistence', () => {
    it('persists circuit state across instances', () => {
      const cb1 = createBreaker();
      for (let i = 0; i < 5; i++) cb1.recordFailure('agent-a');

      const cb2 = createBreaker();
      expect(cb2.getState('agent-a')!.state).toBe('open');
      expect(cb2.getState('agent-a')!.totalFailures).toBe(5);
    });

    it('reload refreshes from disk', () => {
      const cb1 = createBreaker();
      const cb2 = createBreaker();

      cb1.recordSuccess('agent-a');
      cb1.recordSuccess('agent-a');

      expect(cb2.getState('agent-a')).toBeNull();
      cb2.reload();
      expect(cb2.getState('agent-a')!.totalSuccesses).toBe(2);
    });
  });

  // ── Edge Cases ──────────────────────────────────────────────────

  describe('edge cases', () => {
    it('interleaved success and failure does not open circuit', () => {
      const cb = createBreaker();
      for (let i = 0; i < 10; i++) {
        cb.recordFailure('agent-a');
        cb.recordSuccess('agent-a');
      }
      expect(cb.getState('agent-a')!.state).toBe('closed');
    });

    it('rapid open/close/open tracks activations correctly', () => {
      const cb = createBreaker();

      // First open
      for (let i = 0; i < 5; i++) cb.recordFailure('agent-a');
      cb.reset('agent-a');

      // Second open
      for (let i = 0; i < 5; i++) cb.recordFailure('agent-a');
      cb.reset('agent-a');

      expect(cb.getState('agent-a')!.activationCount).toBe(2);
      expect(cb.getState('agent-a')!.activationsInWindow.length).toBe(2);
    });

    it('failure during half-open records new activation', () => {
      const cb = createBreaker();
      for (let i = 0; i < 5; i++) cb.recordFailure('agent-a');
      expect(cb.getState('agent-a')!.activationCount).toBe(1);

      currentTime += 60 * 60 * 1000;
      cb.isOpen('agent-a'); // → half-open
      cb.recordFailure('agent-a'); // → reopen
      expect(cb.getState('agent-a')!.activationCount).toBe(2);
    });
  });
});
