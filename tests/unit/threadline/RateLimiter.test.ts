import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RateLimiter, DEFAULT_RATE_LIMITS } from '../../../src/threadline/RateLimiter.js';
import type { RateLimitConfig } from '../../../src/threadline/RateLimiter.js';

describe('RateLimiter', () => {
  let tmpDir: string;
  let stateDir: string;
  let currentTime: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratelimit-test-'));
    stateDir = tmpDir;
    currentTime = Date.now();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createLimiter(opts?: {
    config?: Partial<RateLimitConfig>;
    nowFn?: () => number;
  }): RateLimiter {
    return new RateLimiter({
      stateDir,
      config: opts?.config,
      nowFn: opts?.nowFn ?? (() => currentTime),
    });
  }

  // ── Per-Agent Inbound ───────────────────────────────────────────

  describe('per-agent inbound limits', () => {
    it('allows events within limit', () => {
      const rl = createLimiter({ config: { perAgentInbound: { limit: 3, windowMs: 60000 } } });
      const r1 = rl.recordEvent('perAgentInbound', 'agent-a');
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(2);
    });

    it('blocks after limit exceeded', () => {
      const rl = createLimiter({ config: { perAgentInbound: { limit: 3, windowMs: 60000 } } });
      rl.recordEvent('perAgentInbound', 'agent-a');
      rl.recordEvent('perAgentInbound', 'agent-a');
      rl.recordEvent('perAgentInbound', 'agent-a');
      const check = rl.checkLimit('perAgentInbound', 'agent-a');
      expect(check.allowed).toBe(false);
      expect(check.remaining).toBe(0);
    });

    it('allows after window expires', () => {
      const rl = createLimiter({ config: { perAgentInbound: { limit: 2, windowMs: 60000 } } });
      rl.recordEvent('perAgentInbound', 'agent-a');
      rl.recordEvent('perAgentInbound', 'agent-a');

      // Advance past window
      currentTime += 61000;
      const check = rl.checkLimit('perAgentInbound', 'agent-a');
      expect(check.allowed).toBe(true);
      expect(check.remaining).toBe(2);
    });
  });

  // ── Per-Agent Outbound ──────────────────────────────────────────

  describe('per-agent outbound limits', () => {
    it('tracks outbound separately from inbound', () => {
      const rl = createLimiter({
        config: {
          perAgentInbound: { limit: 2, windowMs: 60000 },
          perAgentOutbound: { limit: 2, windowMs: 60000 },
        },
      });
      rl.recordEvent('perAgentInbound', 'agent-a');
      rl.recordEvent('perAgentInbound', 'agent-a');

      const outCheck = rl.checkLimit('perAgentOutbound', 'agent-a');
      expect(outCheck.allowed).toBe(true);
      expect(outCheck.remaining).toBe(2);
    });
  });

  // ── Per-Thread ──────────────────────────────────────────────────

  describe('per-thread limits', () => {
    it('tracks threads independently', () => {
      const rl = createLimiter({ config: { perThread: { limit: 2, windowMs: 60000 } } });
      rl.recordEvent('perThread', 'thread-1');
      rl.recordEvent('perThread', 'thread-1');

      expect(rl.checkLimit('perThread', 'thread-1').allowed).toBe(false);
      expect(rl.checkLimit('perThread', 'thread-2').allowed).toBe(true);
    });
  });

  // ── Global Inbound ──────────────────────────────────────────────

  describe('global inbound limits', () => {
    it('tracks all inbound messages under one key', () => {
      const rl = createLimiter({ config: { globalInbound: { limit: 3, windowMs: 60000 } } });
      rl.recordEvent('globalInbound', 'global');
      rl.recordEvent('globalInbound', 'global');
      rl.recordEvent('globalInbound', 'global');

      expect(rl.checkLimit('globalInbound', 'global').allowed).toBe(false);
    });
  });

  // ── Burst Protection ────────────────────────────────────────────

  describe('burst protection', () => {
    it('limits rapid fire messages within burst window', () => {
      const rl = createLimiter({ config: { perAgentBurst: { limit: 3, windowMs: 60000 } } });
      rl.recordEvent('perAgentBurst', 'agent-a');
      rl.recordEvent('perAgentBurst', 'agent-a');
      rl.recordEvent('perAgentBurst', 'agent-a');

      expect(rl.checkLimit('perAgentBurst', 'agent-a').allowed).toBe(false);
    });

    it('burst window is shorter than hourly window', () => {
      const rl = createLimiter({
        config: {
          perAgentBurst: { limit: 3, windowMs: 5000 },
          perAgentInbound: { limit: 30, windowMs: 3600000 },
        },
      });

      rl.recordEvent('perAgentBurst', 'agent-a');
      rl.recordEvent('perAgentBurst', 'agent-a');
      rl.recordEvent('perAgentBurst', 'agent-a');
      expect(rl.checkLimit('perAgentBurst', 'agent-a').allowed).toBe(false);

      // After burst window expires, burst is allowed again
      currentTime += 6000;
      expect(rl.checkLimit('perAgentBurst', 'agent-a').allowed).toBe(true);
    });
  });

  // ── Machine Aggregate ───────────────────────────────────────────

  describe('machine-level aggregate', () => {
    it('tracks machine-wide messages', () => {
      const rl = createLimiter({ config: { machineAggregate: { limit: 5, windowMs: 60000 } } });
      for (let i = 0; i < 5; i++) {
        rl.recordEvent('machineAggregate', 'machine-1');
      }
      expect(rl.checkLimit('machineAggregate', 'machine-1').allowed).toBe(false);
    });
  });

  // ── Spawn Requests ──────────────────────────────────────────────

  describe('spawn request limits', () => {
    it('limits spawn requests per agent', () => {
      const rl = createLimiter({ config: { spawnRequests: { limit: 2, windowMs: 60000 } } });
      rl.recordEvent('spawnRequests', 'agent-a');
      rl.recordEvent('spawnRequests', 'agent-a');

      expect(rl.checkLimit('spawnRequests', 'agent-a').allowed).toBe(false);
      expect(rl.checkLimit('spawnRequests', 'agent-b').allowed).toBe(true);
    });
  });

  // ── Sliding Window Accuracy ─────────────────────────────────────

  describe('sliding window accuracy', () => {
    it('evicts only expired events (not entire window)', () => {
      const rl = createLimiter({ config: { perAgentInbound: { limit: 3, windowMs: 10000 } } });

      // Record 2 events at time 0
      rl.recordEvent('perAgentInbound', 'agent-a');
      rl.recordEvent('perAgentInbound', 'agent-a');

      // Record 1 event at time 5s
      currentTime += 5000;
      rl.recordEvent('perAgentInbound', 'agent-a');

      // At time 11s: first 2 events expire, third still valid
      currentTime += 6000;
      const check = rl.checkLimit('perAgentInbound', 'agent-a');
      expect(check.allowed).toBe(true);
      expect(check.remaining).toBe(2); // limit 3, 1 active event
    });

    it('exactly at limit returns not allowed', () => {
      const rl = createLimiter({ config: { perAgentInbound: { limit: 2, windowMs: 60000 } } });
      rl.recordEvent('perAgentInbound', 'agent-a');
      rl.recordEvent('perAgentInbound', 'agent-a');

      const check = rl.checkLimit('perAgentInbound', 'agent-a');
      expect(check.allowed).toBe(false);
    });
  });

  // ── isRateLimited Quick Check ───────────────────────────────────

  describe('isRateLimited', () => {
    it('returns false when under limits', () => {
      const rl = createLimiter();
      expect(rl.isRateLimited('agent-a', 'inbound')).toBe(false);
    });

    it('returns true when per-agent inbound limit exceeded', () => {
      const rl = createLimiter({ config: { perAgentInbound: { limit: 2, windowMs: 60000 } } });
      rl.recordEvent('perAgentInbound', 'agent-a');
      rl.recordEvent('perAgentInbound', 'agent-a');
      expect(rl.isRateLimited('agent-a', 'inbound')).toBe(true);
    });

    it('returns true when burst limit exceeded', () => {
      const rl = createLimiter({ config: { perAgentBurst: { limit: 2, windowMs: 60000 } } });
      rl.recordEvent('perAgentBurst', 'agent-a');
      rl.recordEvent('perAgentBurst', 'agent-a');
      expect(rl.isRateLimited('agent-a', 'inbound')).toBe(true);
    });

    it('checks outbound direction', () => {
      const rl = createLimiter({ config: { perAgentOutbound: { limit: 1, windowMs: 60000 } } });
      rl.recordEvent('perAgentOutbound', 'agent-a');
      expect(rl.isRateLimited('agent-a', 'outbound')).toBe(true);
    });
  });

  // ── Status Reporting ────────────────────────────────────────────

  describe('status reporting', () => {
    it('returns per-agent statuses', () => {
      const rl = createLimiter();
      rl.recordEvent('perAgentInbound', 'agent-a');

      const statuses = rl.getStatus('agent-a');
      expect(statuses.length).toBeGreaterThan(0);
      const inbound = statuses.find(s => s.type === 'perAgentInbound');
      expect(inbound).toBeDefined();
      expect(inbound!.currentCount).toBe(1);
      expect(inbound!.isLimited).toBe(false);
    });

    it('returns all statuses when no agent specified', () => {
      const rl = createLimiter();
      rl.recordEvent('perAgentInbound', 'agent-a');
      rl.recordEvent('globalInbound', 'global');

      const statuses = rl.getStatus();
      expect(statuses.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Reset ───────────────────────────────────────────────────────

  describe('reset', () => {
    it('resets specific type+key', () => {
      const rl = createLimiter({ config: { perAgentInbound: { limit: 2, windowMs: 60000 } } });
      rl.recordEvent('perAgentInbound', 'agent-a');
      rl.recordEvent('perAgentInbound', 'agent-a');
      expect(rl.checkLimit('perAgentInbound', 'agent-a').allowed).toBe(false);

      rl.reset('perAgentInbound', 'agent-a');
      expect(rl.checkLimit('perAgentInbound', 'agent-a').allowed).toBe(true);
    });

    it('resets all keys for a type', () => {
      const rl = createLimiter({ config: { perAgentInbound: { limit: 1, windowMs: 60000 } } });
      rl.recordEvent('perAgentInbound', 'agent-a');
      rl.recordEvent('perAgentInbound', 'agent-b');

      rl.reset('perAgentInbound');
      expect(rl.checkLimit('perAgentInbound', 'agent-a').allowed).toBe(true);
      expect(rl.checkLimit('perAgentInbound', 'agent-b').allowed).toBe(true);
    });

    it('resets everything when no arguments', () => {
      const rl = createLimiter();
      rl.recordEvent('perAgentInbound', 'agent-a');
      rl.recordEvent('globalInbound', 'global');

      rl.reset();
      expect(rl.checkLimit('perAgentInbound', 'agent-a').remaining).toBe(DEFAULT_RATE_LIMITS.perAgentInbound.limit);
      expect(rl.checkLimit('globalInbound', 'global').remaining).toBe(DEFAULT_RATE_LIMITS.globalInbound.limit);
    });
  });

  // ── Persistence ─────────────────────────────────────────────────

  describe('persistence', () => {
    it('persists and loads state from disk', () => {
      const rl1 = createLimiter({ config: { perAgentInbound: { limit: 5, windowMs: 3600000 } } });
      rl1.recordEvent('perAgentInbound', 'agent-a');
      rl1.recordEvent('perAgentInbound', 'agent-a');
      rl1.persistToDisk();

      const rl2 = createLimiter({ config: { perAgentInbound: { limit: 5, windowMs: 3600000 } } });
      const check = rl2.checkLimit('perAgentInbound', 'agent-a');
      expect(check.remaining).toBe(3);
    });

    it('expired events are not loaded from disk', () => {
      const rl1 = createLimiter({ config: { perAgentInbound: { limit: 5, windowMs: 10000 } } });
      rl1.recordEvent('perAgentInbound', 'agent-a');
      rl1.persistToDisk();

      currentTime += 20000; // Past window
      const rl2 = createLimiter({ config: { perAgentInbound: { limit: 5, windowMs: 10000 } } });
      const check = rl2.checkLimit('perAgentInbound', 'agent-a');
      expect(check.remaining).toBe(5);
    });
  });

  // ── Edge Cases ──────────────────────────────────────────────────

  describe('edge cases', () => {
    it('checkLimit does not consume a slot', () => {
      const rl = createLimiter({ config: { perAgentInbound: { limit: 2, windowMs: 60000 } } });
      rl.checkLimit('perAgentInbound', 'agent-a');
      rl.checkLimit('perAgentInbound', 'agent-a');
      rl.checkLimit('perAgentInbound', 'agent-a');

      const check = rl.checkLimit('perAgentInbound', 'agent-a');
      expect(check.allowed).toBe(true);
      expect(check.remaining).toBe(2);
    });

    it('recordEvent returns allowed=true when AT the limit (event was recorded)', () => {
      const rl = createLimiter({ config: { perAgentInbound: { limit: 2, windowMs: 60000 } } });
      rl.recordEvent('perAgentInbound', 'agent-a');
      const result = rl.recordEvent('perAgentInbound', 'agent-a');
      // At exactly the limit: event was recorded but count == limit
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);
    });

    it('window boundary: event exactly at boundary is expired', () => {
      const rl = createLimiter({ config: { perAgentInbound: { limit: 2, windowMs: 10000 } } });
      rl.recordEvent('perAgentInbound', 'agent-a');

      currentTime += 10001; // Just past window
      const check = rl.checkLimit('perAgentInbound', 'agent-a');
      expect(check.allowed).toBe(true);
      expect(check.remaining).toBe(2);
    });

    it('default config uses standard limits', () => {
      const rl = createLimiter();
      const check = rl.checkLimit('perAgentInbound', 'agent-a');
      expect(check.remaining).toBe(DEFAULT_RATE_LIMITS.perAgentInbound.limit);
    });
  });
});
