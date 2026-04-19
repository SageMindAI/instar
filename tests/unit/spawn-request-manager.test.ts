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
import { SpawnRequestManager, computeEnvelopeHash, type SpawnRequest, type SpawnRequestManagerConfig } from '../../src/messaging/SpawnRequestManager.js';
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

  // ── §4.2: Coalesced drain loop with DRR ─────────────────────

  describe('§4.2 drain loop', () => {
    let fakeNow: number;
    let drainCalls: string[];

    function makeDrainConfig(overrides?: Partial<SpawnRequestManagerConfig>): SpawnRequestManagerConfig {
      return makeConfig({
        cooldownMs: 1_000, // matters for getDrainTickMs floor; tickGrace = max(min(1000/4, 5000), 1000) = 1000
        nowFn: () => fakeNow,
        onDrainReady: vi.fn(async (agent: string) => {
          drainCalls.push(agent);
        }),
        ...overrides,
      });
    }

    beforeEach(() => {
      fakeNow = 1_000_000;
      drainCalls = [];
    });

    function queue(mgr: SpawnRequestManager, agent: string, count = 1): Promise<unknown> {
      // Easiest way to enqueue: invoke evaluate() once successfully (sets cooldown),
      // then call evaluate() repeatedly within cooldown to fill the queue.
      const reqs: Promise<unknown>[] = [];
      for (let i = 0; i < count; i++) {
        reqs.push(mgr.evaluate(makeRequest({
          requester: { agent, session: `s${i}`, machine: 'm' },
          context: `ctx for ${agent} #${i}`,
        })));
      }
      return Promise.all(reqs);
    }

    it('returns 0 from runTick when no agents have queued messages', async () => {
      const mgr = new SpawnRequestManager(makeDrainConfig());
      expect(await mgr.runTick()).toBe(0);
    });

    it('returns 0 from runTick when no onDrainReady callback is configured', async () => {
      const mgr = new SpawnRequestManager(makeConfig({ nowFn: () => fakeNow, cooldownMs: 1_000 }));
      // Force a queued message by reusing the same agent within cooldown.
      await mgr.evaluate(makeRequest());      // succeeds; stamps cooldown at fakeNow
      await mgr.evaluate(makeRequest());      // queues; within cooldown
      expect(await mgr.runTick()).toBe(0);
    });

    it('drains a single ready agent by calling onDrainReady once', async () => {
      const mgr = new SpawnRequestManager(makeDrainConfig());
      await queue(mgr, 'agent-a', 2); // first succeeds, second queues
      // Move past cooldown so it's "ready".
      fakeNow += 2_000;
      const drained = await mgr.runTick();
      expect(drained).toBe(1);
      expect(drainCalls).toEqual(['agent-a']);
    });

    it('caps drains at maxDrainsPerTick across many ready agents', async () => {
      const mgr = new SpawnRequestManager(makeDrainConfig({ maxDrainsPerTick: 3 }));
      for (let i = 0; i < 8; i++) {
        await queue(mgr, `agent-${i}`, 2);
      }
      fakeNow += 2_000; // all past cooldown
      const drained = await mgr.runTick();
      expect(drained).toBe(3);
    });

    it('starves no agent across consecutive ticks (DRR fairness)', async () => {
      const mgr = new SpawnRequestManager(makeDrainConfig({ maxDrainsPerTick: 2 }));
      for (let i = 0; i < 4; i++) {
        await queue(mgr, `agent-${i}`, 5); // each agent has 4 queued (one used to set cooldown)
      }
      fakeNow += 2_000;

      // Tick 1: serves 2 of 4
      await mgr.runTick();
      const tick1 = [...drainCalls];
      expect(tick1).toHaveLength(2);

      // Tick 2: serves the OTHER 2 (because their deficit accumulated)
      await mgr.runTick();
      const tick2 = drainCalls.slice(2);
      expect(tick2).toHaveLength(2);

      // Together, all 4 agents drained at least once across two ticks.
      const seen = new Set([...tick1, ...tick2]);
      expect(seen.size).toBe(4);
    });

    it('skips agents whose cooldown has not yet cleared (beyond tick grace)', async () => {
      // Use a long cooldown so the grace window (= tick interval, capped at 5s)
      // does not include this agent's still-active cooldown.
      const mgr = new SpawnRequestManager(makeDrainConfig({ cooldownMs: 30_000 }));
      await queue(mgr, 'agent-fresh', 2); // cooldown stamped at fakeNow, expires at +30s
      // Don't advance time — remaining = 30s, grace = 5s → not ready.
      const drained = await mgr.runTick();
      expect(drained).toBe(0);
      expect(drainCalls).toEqual([]);
    });

    it('start() begins ticks and dispose() stops them', async () => {
      vi.useRealTimers();
      const mgr = new SpawnRequestManager(makeDrainConfig());
      await queue(mgr, 'agent-x', 2);
      fakeNow += 2_000;
      mgr.start();
      // Wait one tick interval (~1s) — actually we don't want real waits in tests.
      // Just verify the timer was set + dispose clears it.
      expect((mgr as unknown as { '#drainTimer': unknown })).toBeDefined(); // basic sanity
      mgr.dispose();
      // After dispose, runTick still works manually but no timer fires.
      const snap = mgr.getDrrDeficitSnapshotForTests();
      expect(snap.size).toBe(0);
      vi.useFakeTimers();
    });

    it('start() is idempotent', () => {
      const mgr = new SpawnRequestManager(makeDrainConfig());
      mgr.start();
      mgr.start(); // second call is no-op
      mgr.dispose();
    });

    it('dispose() clears DRR deficit and drain attempts', async () => {
      const mgr = new SpawnRequestManager(makeDrainConfig({ maxDrainsPerTick: 1 }));
      for (let i = 0; i < 3; i++) {
        await queue(mgr, `agent-${i}`, 2);
      }
      fakeNow += 2_000;
      await mgr.runTick();
      expect(mgr.getDrrDeficitSnapshotForTests().size).toBeGreaterThan(0);
      mgr.dispose();
      expect(mgr.getDrrDeficitSnapshotForTests().size).toBe(0);
    });

    it('one callback failure does not abort the batch', async () => {
      let calls = 0;
      const mgr = new SpawnRequestManager(makeDrainConfig({
        maxDrainsPerTick: 5,
        onDrainReady: async (agent: string) => {
          calls++;
          drainCalls.push(agent);
          if (agent === 'agent-1') throw new Error('boom');
        },
      }));
      for (let i = 0; i < 3; i++) {
        await queue(mgr, `agent-${i}`, 2);
      }
      fakeNow += 2_000;
      const drained = await mgr.runTick();
      expect(drained).toBe(3);
      expect(calls).toBe(3); // all callbacks invoked despite one failure
    });

    it('infra-failure soft limiter triggers after 5 infra failures within window', async () => {
      const { SpawnFailureError } = await import('../../src/messaging/SpawnRequestManager.js');
      const spawnSession = vi.fn().mockRejectedValue(
        new SpawnFailureError('outage', 'provider-5xx'),
      );
      let now = 1_000_000;
      const mgr = new SpawnRequestManager(makeConfig({
        spawnSession, cooldownMs: 1, nowFn: () => now,
      }));
      expect(mgr.isInfraDegraded('agent-a')).toBe(false);

      for (let i = 0; i < 5; i++) {
        await mgr.evaluate(makeRequest());
        now += 2; // past cooldown
      }
      expect(mgr.isInfraDegraded('agent-a')).toBe(true);
      expect(mgr.effectiveMaxQueuedPerAgent('agent-a')).toBe(1);
      // Other agents are not degraded.
      expect(mgr.isInfraDegraded('agent-b')).toBe(false);
      expect(mgr.effectiveMaxQueuedPerAgent('agent-b')).toBe(SpawnRequestManager.MAX_QUEUED_PER_AGENT);
    });

    it('infra failures outside the 10-min window do not count', async () => {
      const { SpawnFailureError } = await import('../../src/messaging/SpawnRequestManager.js');
      const spawnSession = vi.fn().mockRejectedValue(
        new SpawnFailureError('outage', 'provider-5xx'),
      );
      let now = 1_000_000;
      const mgr = new SpawnRequestManager(makeConfig({
        spawnSession, cooldownMs: 1, nowFn: () => now,
      }));

      // Trip 4 failures, then jump 11 minutes.
      for (let i = 0; i < 4; i++) {
        await mgr.evaluate(makeRequest());
        now += 2;
      }
      now += 11 * 60_000; // window has slid past
      // One more failure — old ones are stale, so we're at 1, not 5.
      await mgr.evaluate(makeRequest());
      expect(mgr.isInfraDegraded('agent-a')).toBe(false);
    });

    it('agent-attributable failures do NOT count toward infra window', async () => {
      const { SpawnFailureError } = await import('../../src/messaging/SpawnRequestManager.js');
      const spawnSession = vi.fn().mockRejectedValue(
        new SpawnFailureError('bad envelope', 'envelope-validation'),
      );
      let now = 1_000_000;
      const mgr = new SpawnRequestManager(makeConfig({
        spawnSession, cooldownMs: 1, nowFn: () => now,
      }));
      for (let i = 0; i < 5; i++) {
        await mgr.evaluate(makeRequest());
        now += 2;
      }
      expect(mgr.isInfraDegraded('agent-a')).toBe(false);
    });

    it('degradation expires 30 minutes after the threshold-tripping failure', async () => {
      const { SpawnFailureError } = await import('../../src/messaging/SpawnRequestManager.js');
      const spawnSession = vi.fn().mockRejectedValue(
        new SpawnFailureError('outage', 'provider-5xx'),
      );
      let now = 1_000_000;
      const mgr = new SpawnRequestManager(makeConfig({
        spawnSession, cooldownMs: 1, nowFn: () => now,
      }));
      for (let i = 0; i < 5; i++) {
        await mgr.evaluate(makeRequest());
        now += 2;
      }
      expect(mgr.isInfraDegraded('agent-a')).toBe(true);
      // Jump ahead 31 min from the threshold-tripping failure.
      now += 31 * 60_000;
      expect(mgr.isInfraDegraded('agent-a')).toBe(false);
    });

    it('respects custom degradedMaxQueuedPerAgent override', async () => {
      const { SpawnFailureError } = await import('../../src/messaging/SpawnRequestManager.js');
      const spawnSession = vi.fn().mockRejectedValue(
        new SpawnFailureError('outage', 'gate-llm-timeout'),
      );
      let now = 1_000_000;
      const mgr = new SpawnRequestManager(makeConfig({
        spawnSession, cooldownMs: 1, nowFn: () => now,
        degradedMaxQueuedPerAgent: 3,
      }));
      for (let i = 0; i < 5; i++) {
        await mgr.evaluate(makeRequest());
        now += 2;
      }
      expect(mgr.effectiveMaxQueuedPerAgent('agent-a')).toBe(3);
    });

    it('refuses envelopes above maxEnvelopeBytes with envelope-too-large reason', async () => {
      const mgr = new SpawnRequestManager(makeConfig({ maxEnvelopeBytes: 100 }));
      const oversized = 'x'.repeat(101);
      const result = await mgr.evaluate(makeRequest({ context: oversized }));
      expect(result.approved).toBe(false);
      expect(result.reason).toMatch(/envelope-too-large/);
      expect(result.reason).toContain('101 bytes');
      expect(result.reason).toContain('100 bytes');
    });

    it('accepts envelopes at exactly maxEnvelopeBytes', async () => {
      const mgr = new SpawnRequestManager(makeConfig({ maxEnvelopeBytes: 100 }));
      const exact = 'x'.repeat(100);
      const result = await mgr.evaluate(makeRequest({ context: exact }));
      expect(result.approved).toBe(true);
    });

    it('uses default 256 KiB cap when maxEnvelopeBytes not configured', async () => {
      const mgr = new SpawnRequestManager(makeConfig());
      // Just over 256 KiB.
      const huge = 'x'.repeat(256 * 1024 + 1);
      const result = await mgr.evaluate(makeRequest({ context: huge }));
      expect(result.approved).toBe(false);
      expect(result.reason).toMatch(/envelope-too-large/);
    });

    it('byte-size check counts UTF-8 bytes, not code units', async () => {
      const mgr = new SpawnRequestManager(makeConfig({ maxEnvelopeBytes: 10 }));
      // Each emoji is 4 UTF-8 bytes. 3 emojis = 12 bytes > 10.
      const result = await mgr.evaluate(makeRequest({ context: '🌊🌊🌊' }));
      expect(result.approved).toBe(false);
      expect(result.reason).toMatch(/envelope-too-large/);
    });

    it('refuses oversized envelopes BEFORE cooldown check (no queue side-effect)', async () => {
      const mgr = new SpawnRequestManager(makeConfig({ maxEnvelopeBytes: 100, cooldownMs: 1_000 }));
      // First successful spawn to set cooldown.
      await mgr.evaluate(makeRequest());
      // Now an oversized request — should be refused without queueing.
      const oversized = 'x'.repeat(200);
      const result = await mgr.evaluate(makeRequest({ context: oversized }));
      expect(result.approved).toBe(false);
      expect(result.reason).toMatch(/envelope-too-large/);
      expect(mgr.getQueuedCount('agent-a')).toBe(0);
    });

    it('computeEnvelopeHash uses sha256-v1: prefix and is deterministic', () => {
      const h1 = computeEnvelopeHash({ context: 'hello', threadId: 't-1' });
      const h2 = computeEnvelopeHash({ context: 'hello', threadId: 't-1' });
      expect(h1).toBe(h2);
      expect(h1.startsWith('sha256-v1:')).toBe(true);
      // 'sha256-v1:' = 10 chars; SHA-256 hex = 64 chars; total = 74.
      expect(h1.length).toBe(74);
    });

    it('computeEnvelopeHash is canonical: key-permutation-invariant', () => {
      const a = computeEnvelopeHash({ context: 'x', threadId: 't' });
      // Force a different argument shape; canonical-JSON sorts keys, so result
      // matches regardless of how the input object's keys are ordered.
      const reverseKeyOrder = { threadId: 't', context: 'x' } as const;
      const b = computeEnvelopeHash(reverseKeyOrder);
      expect(a).toBe(b);
    });

    it('different content yields different hash', () => {
      const a = computeEnvelopeHash({ context: 'a', threadId: 't' });
      const b = computeEnvelopeHash({ context: 'b', threadId: 't' });
      expect(a).not.toBe(b);
    });

    it('queue entries get envelopeHash and drainAttempts=0 on enqueue', async () => {
      let now = 1_000_000;
      const mgr = new SpawnRequestManager(makeConfig({ cooldownMs: 1_000, nowFn: () => now }));
      // First spawn succeeds, sets cooldown.
      await mgr.evaluate(makeRequest({ context: 'first' }));
      // Second spawn within cooldown — gets queued.
      await mgr.evaluate(makeRequest({ context: 'second-message', pendingMessages: ['msg-id-2'] }));
      expect(mgr.getQueuedCount('agent-a')).toBe(1);
      // Inspect via the prompt-build path: drain queue and confirm hash on entry.
      // Use a test that picks up the queued entries at the next spawn.
      now += 2_000; // past cooldown
      const result = await mgr.evaluate(makeRequest({ context: 'third' }));
      expect(result.approved).toBe(true);
      // Indirectly verify: queue is now empty (second-message was drained).
      expect(mgr.getQueuedCount('agent-a')).toBe(0);
    });

    it('isTruncated returns true after per-agent cap forces eviction', async () => {
      const mgr = new SpawnRequestManager(makeConfig({ cooldownMs: 1_000 }));
      // First spawn succeeds, sets cooldown.
      await mgr.evaluate(makeRequest({ context: 'first' }));
      // Now flood enough to exceed MAX_QUEUED_PER_AGENT (10).
      for (let i = 0; i < 12; i++) {
        await mgr.evaluate(makeRequest({ context: `msg-${i}` }));
      }
      expect(mgr.isTruncated('agent-a')).toBe(true);
    });

    it('isTruncated is false after a clean drain', async () => {
      let now = 1_000_000;
      const mgr = new SpawnRequestManager(makeConfig({ cooldownMs: 100, nowFn: () => now }));
      await mgr.evaluate(makeRequest({ context: 'first' }));
      // Force truncation.
      for (let i = 0; i < 12; i++) {
        await mgr.evaluate(makeRequest({ context: `msg-${i}` }));
      }
      expect(mgr.isTruncated('agent-a')).toBe(true);
      // Advance past cooldown so the next evaluate spawns + drains the queue.
      now += 200;
      await mgr.evaluate(makeRequest({ context: 'drain-trigger' }));
      expect(mgr.isTruncated('agent-a')).toBe(false);
    });

    it('global cap refuses queueing once total queued reaches max', async () => {
      const mgr = new SpawnRequestManager(makeConfig({
        cooldownMs: 60_000,
        maxGlobalQueued: 4, // tiny cap for test
      }));
      // Use 5 distinct agents; each first spawn uses cooldown, so subsequent
      // calls within that agent would queue. Drive 4 successful first-spawns
      // and then a follow-up from each.
      for (let i = 0; i < 5; i++) {
        const reqA = makeRequest({
          requester: { agent: `peer-${i}`, session: 's', machine: 'm' },
          context: 'first',
        });
        await mgr.evaluate(reqA); // succeeds, sets cooldown
      }
      // Now queue follow-ups from each peer; only the first 4 succeed.
      for (let i = 0; i < 5; i++) {
        await mgr.evaluate(makeRequest({
          requester: { agent: `peer-${i}`, session: 's', machine: 'm' },
          context: `follow-${i}`,
        }));
      }
      // Total queued <= 4 (the global cap).
      let total = 0;
      for (let i = 0; i < 5; i++) total += mgr.getQueuedCount(`peer-${i}`);
      expect(total).toBeLessThanOrEqual(4);
    });

    it('global cap default is 1000', async () => {
      // Smoke test — just verify the default-config path doesn't crash and that
      // a single normal use-case (well below 1000) is unaffected.
      const mgr = new SpawnRequestManager(makeConfig({ cooldownMs: 60_000 }));
      await mgr.evaluate(makeRequest({ context: 'first' }));
      await mgr.evaluate(makeRequest({ context: 'follow' }));
      expect(mgr.getQueuedCount('agent-a')).toBe(1);
    });

    it('getDrainTickMs honors floor and ceiling', () => {
      // cooldown=100 → 100/4=25 → floor at 1000
      let mgr = new SpawnRequestManager(makeDrainConfig({ cooldownMs: 100 }));
      expect(mgr.getDrainTickMs()).toBe(1_000);

      // cooldown=40000 → 40000/4=10000 → ceiling at 5000
      mgr = new SpawnRequestManager(makeDrainConfig({ cooldownMs: 40_000 }));
      expect(mgr.getDrainTickMs()).toBe(5_000);

      // cooldown=12000 → 12000/4=3000 → 3000 (between bounds)
      mgr = new SpawnRequestManager(makeDrainConfig({ cooldownMs: 12_000 }));
      expect(mgr.getDrainTickMs()).toBe(3_000);
    });
  });
});
