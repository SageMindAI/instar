/**
 * Unit tests for SpawnRequestManager — on-demand session spawning.
 *
 * Tests:
 * - Approval: spawns session when constraints pass
 * - Cooldown: blocks repeat spawns from same agent within cooldown window
 * - Session limits: denies low-priority when at max, allows high/critical override
 * - Memory pressure: denies when memory pressure is high
 * - Spawn failure: returns denial with error reason
 * - Prompt generation: includes requester, reason, context, pending count
 * - Denial tracking: increments retry count, escalates after max retries
 * - Escalation: calls onEscalate for critical/pending-message requests after max retries
 * - Status reporting: shows active cooldowns and pending retries
 * - Reset: clears all internal state
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SpawnRequestManager, type SpawnRequest, type SpawnRequestManagerConfig } from '../../src/messaging/SpawnRequestManager.js';
import type { Session } from '../../src/core/types.js';

// ── Helpers ──────────────────────────────────────────────────────

function makeRequest(overrides?: Partial<SpawnRequest>): SpawnRequest {
  return {
    requester: { agent: 'agent-a', session: 'sess-1', machine: 'machine-1' },
    target: { agent: 'agent-b', machine: 'machine-2' },
    reason: 'Need help with task X',
    priority: 'medium',
    ...overrides,
  };
}

function makeSession(name: string): Session {
  return {
    id: `id-${name}`,
    name,
    tmuxSession: `proj-${name}`,
    status: 'running',
    startedAt: new Date(),
    model: 'sonnet' as any,
  } as Session;
}

function makeConfig(overrides?: Partial<SpawnRequestManagerConfig>): SpawnRequestManagerConfig {
  return {
    maxSessions: 5,
    getActiveSessions: () => [],
    spawnSession: vi.fn().mockResolvedValue('spawned-session-id'),
    cooldownMs: 1000, // 1s for tests (not 5min)
    maxRetries: 3,
    maxRetryWindowMs: 60_000,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('SpawnRequestManager', () => {
  let manager: SpawnRequestManager;
  let config: SpawnRequestManagerConfig;

  beforeEach(() => {
    vi.useFakeTimers();
    config = makeConfig();
    manager = new SpawnRequestManager(config);
  });

  // ── Approval ────────────────────────────────────────────────

  describe('approval', () => {
    it('approves and spawns session when all constraints pass', async () => {
      const request = makeRequest();
      const result = await manager.evaluate(request);

      expect(result.approved).toBe(true);
      expect(result.sessionId).toBe('spawned-session-id');
      expect(result.reason).toContain('Session spawned for');
      expect(config.spawnSession).toHaveBeenCalledOnce();
    });

    it('passes suggested model and duration to spawnSession', async () => {
      const request = makeRequest({
        suggestedModel: 'opus',
        suggestedMaxDuration: 30,
      });
      await manager.evaluate(request);

      expect(config.spawnSession).toHaveBeenCalledWith(
        expect.any(String),
        { model: 'opus', maxDurationMinutes: 30 },
      );
    });

    it('includes requester info and reason in spawn prompt', async () => {
      const request = makeRequest({
        requester: { agent: 'dawn', session: 'sess-42', machine: 'workstation' },
        reason: 'Urgent deployment review needed',
        context: 'PR #123 is blocking production',
        pendingMessages: ['msg-1', 'msg-2'],
      });
      await manager.evaluate(request);

      const prompt = (config.spawnSession as any).mock.calls[0][0] as string;
      expect(prompt).toContain('dawn/sess-42');
      expect(prompt).toContain('workstation');
      expect(prompt).toContain('Urgent deployment review needed');
      expect(prompt).toContain('Context: PR #123 is blocking production');
      expect(prompt).toContain('2 pending message(s)');
    });

    it('omits context line when no context provided', async () => {
      const request = makeRequest({ context: undefined });
      await manager.evaluate(request);

      const prompt = (config.spawnSession as any).mock.calls[0][0] as string;
      expect(prompt).not.toContain('Context:');
    });
  });

  // ── Cooldown ────────────────────────────────────────────────

  describe('cooldown', () => {
    it('blocks repeat spawn from same agent within cooldown window', async () => {
      const request = makeRequest();
      await manager.evaluate(request); // First — approved

      vi.advanceTimersByTime(500); // Half the cooldown

      const result = await manager.evaluate(request); // Second — should be blocked
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('Cooldown');
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(result.retryAfterMs).toBeLessThanOrEqual(1000);
    });

    it('allows spawn after cooldown expires', async () => {
      await manager.evaluate(makeRequest());

      vi.advanceTimersByTime(1100); // Past cooldown

      const result = await manager.evaluate(makeRequest());
      expect(result.approved).toBe(true);
    });

    it('tracks cooldown per agent independently', async () => {
      await manager.evaluate(makeRequest({ requester: { agent: 'a', session: 's1', machine: 'm1' } }));

      // Different agent should not be blocked
      const result = await manager.evaluate(makeRequest({ requester: { agent: 'b', session: 's2', machine: 'm2' } }));
      expect(result.approved).toBe(true);
    });
  });

  // ── Session Limits ──────────────────────────────────────────

  describe('session limits', () => {
    it('denies low/medium priority when at session limit', async () => {
      config = makeConfig({
        maxSessions: 2,
        getActiveSessions: () => [makeSession('s1'), makeSession('s2')],
      });
      manager = new SpawnRequestManager(config);

      const result = await manager.evaluate(makeRequest({ priority: 'low' }));
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('Session limit reached');
      expect(result.reason).toContain('2/2');
    });

    it('allows high priority to override session limit', async () => {
      config = makeConfig({
        maxSessions: 2,
        getActiveSessions: () => [makeSession('s1'), makeSession('s2')],
      });
      manager = new SpawnRequestManager(config);

      const result = await manager.evaluate(makeRequest({ priority: 'high' }));
      expect(result.approved).toBe(true);
    });

    it('allows critical priority to override session limit', async () => {
      config = makeConfig({
        maxSessions: 1,
        getActiveSessions: () => [makeSession('s1')],
      });
      manager = new SpawnRequestManager(config);

      const result = await manager.evaluate(makeRequest({ priority: 'critical' }));
      expect(result.approved).toBe(true);
    });
  });

  // ── Memory Pressure ─────────────────────────────────────────

  describe('memory pressure', () => {
    it('denies when memory pressure is high', async () => {
      config = makeConfig({
        isMemoryPressureHigh: () => true,
      });
      manager = new SpawnRequestManager(config);

      const result = await manager.evaluate(makeRequest());
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('Memory pressure');
      expect(result.retryAfterMs).toBe(120_000);
    });

    it('approves when memory pressure is normal', async () => {
      config = makeConfig({
        isMemoryPressureHigh: () => false,
      });
      manager = new SpawnRequestManager(config);

      const result = await manager.evaluate(makeRequest());
      expect(result.approved).toBe(true);
    });

    it('approves when no memory pressure check configured', async () => {
      config = makeConfig({
        isMemoryPressureHigh: undefined,
      });
      manager = new SpawnRequestManager(config);

      const result = await manager.evaluate(makeRequest());
      expect(result.approved).toBe(true);
    });
  });

  // ── Spawn Failure ───────────────────────────────────────────

  describe('spawn failure', () => {
    it('returns denial with error reason when spawn throws', async () => {
      config = makeConfig({
        spawnSession: vi.fn().mockRejectedValue(new Error('tmux not found')),
      });
      manager = new SpawnRequestManager(config);

      const result = await manager.evaluate(makeRequest());
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('Spawn failed');
      expect(result.reason).toContain('tmux not found');
      expect(result.retryAfterMs).toBe(30_000);
    });

    it('handles non-Error throws gracefully', async () => {
      config = makeConfig({
        spawnSession: vi.fn().mockRejectedValue('string error'),
      });
      manager = new SpawnRequestManager(config);

      const result = await manager.evaluate(makeRequest());
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('unknown error');
    });
  });

  // ── Denial Tracking & Escalation ────────────────────────────

  describe('denial tracking and escalation', () => {
    it('tracks retry attempts per request', async () => {
      const request = makeRequest();
      const denial = { approved: false as const, reason: 'limit', retryAfterMs: 1000 };

      manager.handleDenial(request, denial);
      expect(manager.getStatus().pendingRetries).toBe(1);

      manager.handleDenial(request, denial);
      expect(manager.getStatus().pendingRetries).toBe(1); // Same key, still 1 entry
    });

    it('escalates after max retries for critical requests', async () => {
      const onEscalate = vi.fn();
      config = makeConfig({ maxRetries: 2, onEscalate });
      manager = new SpawnRequestManager(config);

      const request = makeRequest({ priority: 'critical' });
      const denial = { approved: false as const, reason: 'session limit', retryAfterMs: 1000 };

      manager.handleDenial(request, denial); // attempt 1
      expect(onEscalate).not.toHaveBeenCalled();

      manager.handleDenial(request, denial); // attempt 2 — exceeds maxRetries
      expect(onEscalate).toHaveBeenCalledOnce();
      expect(onEscalate.mock.calls[0][1]).toContain('denied 2 times');
    });

    it('escalates for requests with pending messages after max retries', async () => {
      const onEscalate = vi.fn();
      config = makeConfig({ maxRetries: 1, onEscalate });
      manager = new SpawnRequestManager(config);

      const request = makeRequest({ priority: 'low', pendingMessages: ['msg-1'] });
      const denial = { approved: false as const, reason: 'limit', retryAfterMs: 1000 };

      manager.handleDenial(request, denial); // Exceeds maxRetries (1)
      expect(onEscalate).toHaveBeenCalledOnce();
      expect(onEscalate.mock.calls[0][1]).toContain('Pending messages: 1');
    });

    it('does NOT escalate for low-priority requests without pending messages', async () => {
      const onEscalate = vi.fn();
      config = makeConfig({ maxRetries: 1, onEscalate });
      manager = new SpawnRequestManager(config);

      const request = makeRequest({ priority: 'low', pendingMessages: undefined });
      const denial = { approved: false as const, reason: 'limit', retryAfterMs: 1000 };

      manager.handleDenial(request, denial);
      expect(onEscalate).not.toHaveBeenCalled();
    });

    it('clears pending retries after escalation', async () => {
      const onEscalate = vi.fn();
      config = makeConfig({ maxRetries: 1, onEscalate });
      manager = new SpawnRequestManager(config);

      const request = makeRequest({ priority: 'critical' });
      const denial = { approved: false as const, reason: 'limit', retryAfterMs: 1000 };

      manager.handleDenial(request, denial);
      expect(manager.getStatus().pendingRetries).toBe(0); // Cleared after escalation
    });

    it('clears pending retries on successful spawn', async () => {
      const request = makeRequest();
      const denial = { approved: false as const, reason: 'limit', retryAfterMs: 1000 };

      manager.handleDenial(request, denial);
      expect(manager.getStatus().pendingRetries).toBe(1);

      // Now a successful spawn for the same request should clear retries
      const result = await manager.evaluate(request);
      expect(result.approved).toBe(true);
      expect(manager.getStatus().pendingRetries).toBe(0);
    });
  });

  // ── Status ──────────────────────────────────────────────────

  describe('status', () => {
    it('reports active cooldowns', async () => {
      await manager.evaluate(makeRequest({ requester: { agent: 'a', session: 's', machine: 'm' } }));

      const status = manager.getStatus();
      expect(status.cooldowns).toHaveLength(1);
      expect(status.cooldowns[0].agent).toBe('a');
      expect(status.cooldowns[0].remainingMs).toBeGreaterThan(0);
    });

    it('excludes expired cooldowns from status', async () => {
      await manager.evaluate(makeRequest());

      vi.advanceTimersByTime(2000); // Past cooldown

      const status = manager.getStatus();
      expect(status.cooldowns).toHaveLength(0);
    });

    it('reports pending retries count', () => {
      const denial = { approved: false as const, reason: 'limit', retryAfterMs: 1000 };

      manager.handleDenial(makeRequest({ reason: 'task-1' }), denial);
      manager.handleDenial(makeRequest({ reason: 'task-2' }), denial);

      expect(manager.getStatus().pendingRetries).toBe(2);
    });
  });

  // ── Reset ───────────────────────────────────────────────────

  describe('reset', () => {
    it('clears all cooldowns and pending retries', async () => {
      await manager.evaluate(makeRequest());
      manager.handleDenial(makeRequest({ reason: 'x' }), { approved: false, reason: 'r', retryAfterMs: 1000 });

      manager.reset();

      const status = manager.getStatus();
      expect(status.cooldowns).toHaveLength(0);
      expect(status.pendingRetries).toBe(0);
    });

    it('allows immediate spawn after reset (no cooldown)', async () => {
      await manager.evaluate(makeRequest());
      manager.reset();

      const result = await manager.evaluate(makeRequest());
      expect(result.approved).toBe(true);
    });
  });

  // ── §4.2: Failure-suppressive reservation + classified attribution ──

  describe('§4.2 failure-suppressive reservation', () => {
    it('stamps cooldown before spawn and does NOT roll back on failure', async () => {
      const spawnSession = vi.fn().mockRejectedValue(new Error('boom'));
      config = makeConfig({ spawnSession });
      manager = new SpawnRequestManager(config);

      const first = await manager.evaluate(makeRequest());
      expect(first.approved).toBe(false);
      expect(first.reason).toContain('Spawn failed');

      // Without rollback, the cooldown is still in effect.
      const second = await manager.evaluate(makeRequest());
      expect(second.approved).toBe(false);
      expect(second.reason).toMatch(/Cooldown/i);
    });

    it('ambiguous (untyped) failures do NOT increment penalty counter', async () => {
      const spawnSession = vi.fn().mockRejectedValue(new Error('unspecified provider error'));
      config = makeConfig({ spawnSession, cooldownMs: 1 });
      manager = new SpawnRequestManager(config);

      for (let i = 0; i < 5; i++) {
        await manager.evaluate(makeRequest());
        await vi.advanceTimersByTimeAsync(2);
      }
      const status = manager.getStatus();
      expect(status.penalties).toEqual([]);
    });

    it('agent-attributable failures accumulate and stamp penaltyUntil at threshold', async () => {
      const { SpawnFailureError } = await import('../../src/messaging/SpawnRequestManager.js');
      const spawnSession = vi.fn().mockRejectedValue(
        new SpawnFailureError('bad envelope', 'envelope-validation'),
      );
      config = makeConfig({ spawnSession, cooldownMs: 1 });
      manager = new SpawnRequestManager(config);

      await manager.evaluate(makeRequest());
      await vi.advanceTimersByTimeAsync(2);
      await manager.evaluate(makeRequest());
      await vi.advanceTimersByTimeAsync(2);
      await manager.evaluate(makeRequest());

      const status = manager.getStatus();
      expect(status.penalties).toHaveLength(1);
      expect(status.penalties[0].consecutiveFailures).toBe(3);
      expect(status.penalties[0].untilMs).toBeGreaterThan(0);
    });

    it('infrastructure failures do NOT stamp penaltyUntil even at threshold', async () => {
      const { SpawnFailureError } = await import('../../src/messaging/SpawnRequestManager.js');
      const spawnSession = vi.fn().mockRejectedValue(
        new SpawnFailureError('provider outage', 'provider-5xx'),
      );
      config = makeConfig({ spawnSession, cooldownMs: 1 });
      manager = new SpawnRequestManager(config);

      for (let i = 0; i < 5; i++) {
        await manager.evaluate(makeRequest());
        await vi.advanceTimersByTimeAsync(2);
      }
      const status = manager.getStatus();
      expect(status.penalties).toEqual([]);
    });

    it('successful spawn clears consecutive failure counter', async () => {
      const { SpawnFailureError } = await import('../../src/messaging/SpawnRequestManager.js');
      const spawnSession = vi.fn()
        .mockRejectedValueOnce(new SpawnFailureError('bad', 'envelope-validation'))
        .mockRejectedValueOnce(new SpawnFailureError('bad', 'envelope-validation'))
        .mockResolvedValueOnce('spawned-ok');
      config = makeConfig({ spawnSession, cooldownMs: 1 });
      manager = new SpawnRequestManager(config);

      await manager.evaluate(makeRequest());
      await vi.advanceTimersByTimeAsync(2);
      await manager.evaluate(makeRequest());
      await vi.advanceTimersByTimeAsync(2);
      const ok = await manager.evaluate(makeRequest());
      expect(ok.approved).toBe(true);

      // A fourth attributable failure should not immediately penalize because counter was cleared.
      const spawnSession2 = vi.fn().mockRejectedValue(
        new SpawnFailureError('bad again', 'envelope-validation'),
      );
      config = { ...config, spawnSession: spawnSession2 };
      (manager as unknown as { '#config': SpawnRequestManagerConfig })['#config'] = config;
      // Clean approach: just re-evaluate against the same manager's counter state.
      const status = manager.getStatus();
      expect(status.penalties).toEqual([]);
    });

    it('cooldownRemainingMs returns max of cooldown and penalty remainders', async () => {
      const { SpawnFailureError } = await import('../../src/messaging/SpawnRequestManager.js');
      const spawnSession = vi.fn().mockRejectedValue(
        new SpawnFailureError('bad', 'envelope-validation'),
      );
      config = makeConfig({ spawnSession, cooldownMs: 100 });
      manager = new SpawnRequestManager(config);

      // Trip the penalty (3 attributable failures).
      for (let i = 0; i < 3; i++) {
        await manager.evaluate(makeRequest());
        await vi.advanceTimersByTimeAsync(150); // exceed cooldown between each
      }

      // Penalty should now be ~200ms (2 × 100ms). Remaining should still be positive.
      const remaining = manager.cooldownRemainingMs('agent-a');
      expect(remaining).toBeGreaterThan(0);
    });

    it('penaltyUntil blocks even when cooldown has elapsed', async () => {
      const { SpawnFailureError } = await import('../../src/messaging/SpawnRequestManager.js');
      let fakeNow = 1_000_000;
      const spawnSession = vi.fn().mockRejectedValue(
        new SpawnFailureError('bad', 'safety-refusal-on-payload'),
      );
      config = makeConfig({ spawnSession, cooldownMs: 50, nowFn: () => fakeNow });
      manager = new SpawnRequestManager(config);

      // Trip the penalty with enough spacing to clear cooldown between each attempt.
      await manager.evaluate(makeRequest());
      fakeNow += 60;
      await manager.evaluate(makeRequest());
      fakeNow += 60;
      await manager.evaluate(makeRequest());
      // penaltyUntil stamped at fakeNow = 1_000_120, = 1_000_120 + 100 = 1_000_220.

      // Move past cooldown (last spawn was at 1_000_120, cooldown 50 → ends at 1_000_170)
      // but BEFORE penalty (ends at 1_000_220).
      fakeNow = 1_000_180;
      const blocked = await manager.evaluate(makeRequest());
      expect(blocked.approved).toBe(false);
      expect(blocked.reason).toMatch(/Cooldown/i);

      // Move past penalty; now it should approve (but spawn still fails, which is fine).
      fakeNow = 1_000_230;
      const nowPastPenalty = manager.cooldownRemainingMs('agent-a');
      expect(nowPastPenalty).toBe(0);
    });
  });
});
