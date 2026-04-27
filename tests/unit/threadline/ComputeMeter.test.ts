import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComputeMeter } from '../../../src/threadline/ComputeMeter.js';
import type {
  ComputeMeterConfig,
  TrustLevel,
  MeterCheckResult,
} from '../../../src/threadline/ComputeMeter.js';

describe('ComputeMeter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compute-meter-test-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createMeter(overrides?: Partial<ComputeMeterConfig>): ComputeMeter {
    return new ComputeMeter({
      stateDir: tmpDir,
      ...overrides,
    });
  }

  // ── 1. Constructor ──────────────────────────────────────────────────

  describe('constructor', () => {
    it('creates a ComputeMeter with default config', () => {
      const meter = createMeter();
      expect(meter).toBeInstanceOf(ComputeMeter);
    });

    it('creates the threadline state directory', () => {
      createMeter();
      const threadlineDir = path.join(tmpDir, 'threadline');
      expect(fs.existsSync(threadlineDir)).toBe(true);
    });

    it('accepts a custom globalDailyCap', () => {
      const meter = createMeter({ globalDailyCap: 1_000 });
      // Verify by recording up to the cap
      const result = meter.check('agent-a', 'autonomous', 1_001);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('global_cap_exceeded');
    });
  });

  // ── 2. getBudget() ──────────────────────────────────────────────────

  describe('getBudget()', () => {
    it('returns correct budget for untrusted', () => {
      const meter = createMeter();
      const budget = meter.getBudget('untrusted');
      expect(budget.hourlyTokenLimit).toBe(10_000);
      expect(budget.dailyTokenLimit).toBe(50_000);
      expect(budget.maxConcurrentSessions).toBe(1);
    });

    it('returns correct budget for verified', () => {
      const meter = createMeter();
      const budget = meter.getBudget('verified');
      expect(budget.hourlyTokenLimit).toBe(50_000);
      expect(budget.dailyTokenLimit).toBe(250_000);
      expect(budget.maxConcurrentSessions).toBe(3);
    });

    it('returns correct budget for trusted', () => {
      const meter = createMeter();
      const budget = meter.getBudget('trusted');
      expect(budget.hourlyTokenLimit).toBe(200_000);
      expect(budget.dailyTokenLimit).toBe(1_000_000);
      expect(budget.maxConcurrentSessions).toBe(5);
    });

    it('returns correct budget for autonomous', () => {
      const meter = createMeter();
      const budget = meter.getBudget('autonomous');
      expect(budget.hourlyTokenLimit).toBe(500_000);
      expect(budget.dailyTokenLimit).toBe(2_000_000);
      expect(budget.maxConcurrentSessions).toBe(10);
    });
  });

  // ── 3. check() ──────────────────────────────────────────────────────

  describe('check()', () => {
    it('returns allowed for a request within budget', () => {
      const meter = createMeter();
      const result = meter.check('agent-a', 'trusted', 1_000);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(result.retryAfterSeconds).toBeUndefined();
    });

    it('does not consume tokens', () => {
      const meter = createMeter();
      meter.check('agent-a', 'untrusted', 5_000);
      meter.check('agent-a', 'untrusted', 5_000);
      // A third check should still pass — check doesn't consume
      const result = meter.check('agent-a', 'untrusted', 5_000);
      expect(result.allowed).toBe(true);
    });

    it('reports remaining tokens correctly', () => {
      const meter = createMeter({ globalDailyCap: 1_000_000 });
      // Record some tokens first so remaining is less
      meter.record('agent-a', 'trusted', 50_000);
      const result = meter.check('agent-a', 'trusted', 10_000);
      expect(result.allowed).toBe(true);
      // remaining should reflect check amount subtracted from what's left
      expect(result.remaining.hourlyTokens).toBe(200_000 - 50_000 - 10_000);
      expect(result.remaining.dailyTokens).toBe(1_000_000 - 50_000 - 10_000);
    });
  });

  // ── 4. record() ─────────────────────────────────────────────────────

  describe('record()', () => {
    it('records consumption and returns allowed result', () => {
      const meter = createMeter();
      const result = meter.record('agent-a', 'trusted', 1_000);
      expect(result.allowed).toBe(true);
    });

    it('consumes tokens on record', () => {
      const meter = createMeter();
      meter.record('agent-a', 'untrusted', 9_000);
      // Only 1_000 hourly tokens remain (limit 10_000)
      const result = meter.record('agent-a', 'untrusted', 2_000);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('hourly_limit_exceeded');
    });

    it('does not consume tokens when denied', () => {
      const meter = createMeter();
      meter.record('agent-a', 'untrusted', 9_000);
      // This should be denied
      meter.record('agent-a', 'untrusted', 2_000);
      // After denial, only 9_000 consumed, so 1_000 should still fit
      const result = meter.record('agent-a', 'untrusted', 1_000);
      expect(result.allowed).toBe(true);
    });
  });

  // ── 5. Hourly limits ────────────────────────────────────────────────

  describe('hourly limits', () => {
    it('denies when hourly limit is exceeded for untrusted', () => {
      const meter = createMeter();
      meter.record('agent-a', 'untrusted', 10_000);
      const result = meter.check('agent-a', 'untrusted', 1);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('hourly_limit_exceeded');
    });

    it('denies when hourly limit would be exceeded by the request', () => {
      const meter = createMeter();
      meter.record('agent-a', 'untrusted', 8_000);
      const result = meter.record('agent-a', 'untrusted', 3_000);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('hourly_limit_exceeded');
    });

    it('reports correct remaining hourly tokens on denial', () => {
      const meter = createMeter();
      meter.record('agent-a', 'untrusted', 8_000);
      const result = meter.check('agent-a', 'untrusted', 5_000);
      expect(result.remaining.hourlyTokens).toBe(2_000);
    });
  });

  // ── 6. Daily limits ─────────────────────────────────────────────────

  describe('daily limits', () => {
    it('denies when daily limit is exceeded for untrusted', () => {
      const meter = createMeter();
      // untrusted: hourly=10_000, daily=50_000
      // Need to consume over multiple "hours" — but since we can't easily
      // advance time, use a trust level with high hourly but low daily
      // Instead, use budget overrides
      const meter2 = createMeter({
        budgetOverrides: {
          untrusted: { hourlyTokenLimit: 100_000, dailyTokenLimit: 20_000 },
        },
      });
      meter2.record('agent-a', 'untrusted', 20_000);
      const result = meter2.record('agent-a', 'untrusted', 1);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('daily_limit_exceeded');
    });

    it('reports retryAfterSeconds for daily limit', () => {
      const meter = createMeter({
        budgetOverrides: {
          untrusted: { hourlyTokenLimit: 100_000, dailyTokenLimit: 20_000 },
        },
      });
      meter.record('agent-a', 'untrusted', 20_000);
      const result = meter.check('agent-a', 'untrusted', 1);
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
      // Should be seconds until next UTC midnight
      expect(result.retryAfterSeconds).toBeLessThanOrEqual(86_400);
    });
  });

  // ── 7. Global cap ───────────────────────────────────────────────────

  describe('global cap', () => {
    it('denies when global daily cap is exceeded', () => {
      const meter = createMeter({
        globalDailyCap: 5_000,
        budgetOverrides: {
          trusted: { hourlyTokenLimit: 100_000, dailyTokenLimit: 100_000 },
        },
      });
      meter.record('agent-a', 'trusted', 5_000);
      const result = meter.check('agent-b', 'trusted', 1);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('global_cap_exceeded');
    });

    it('tracks global tokens across multiple agents', () => {
      const meter = createMeter({
        globalDailyCap: 10_000,
        budgetOverrides: {
          trusted: { hourlyTokenLimit: 100_000, dailyTokenLimit: 100_000 },
        },
      });
      meter.record('agent-a', 'trusted', 4_000);
      meter.record('agent-b', 'trusted', 4_000);
      // 8_000 used globally, 2_000 remaining
      const result = meter.check('agent-c', 'trusted', 3_000);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('global_cap_exceeded');
    });

    it('allows when just under global cap', () => {
      const meter = createMeter({
        globalDailyCap: 10_000,
        budgetOverrides: {
          trusted: { hourlyTokenLimit: 100_000, dailyTokenLimit: 100_000 },
        },
      });
      meter.record('agent-a', 'trusted', 5_000);
      const result = meter.check('agent-b', 'trusted', 5_000);
      expect(result.allowed).toBe(true);
    });

    it('reports remaining global tokens', () => {
      const meter = createMeter({ globalDailyCap: 100_000 });
      meter.record('agent-a', 'trusted', 30_000);
      const result = meter.check('agent-a', 'trusted', 1_000);
      expect(result.remaining.globalDailyTokens).toBe(100_000 - 30_000 - 1_000);
    });
  });

  // ── 8. Session limits ───────────────────────────────────────────────

  describe('session limits', () => {
    it('increments sessions and returns true', () => {
      const meter = createMeter();
      const result = meter.incrementSessions('agent-a', 'untrusted');
      expect(result).toBe(true);
    });

    it('denies session increment at max concurrent for untrusted (1)', () => {
      const meter = createMeter();
      meter.incrementSessions('agent-a', 'untrusted');
      const result = meter.incrementSessions('agent-a', 'untrusted');
      expect(result).toBe(false);
    });

    it('decrements sessions correctly', () => {
      const meter = createMeter();
      meter.incrementSessions('agent-a', 'untrusted');
      meter.decrementSessions('agent-a');
      // Should be able to increment again
      const result = meter.incrementSessions('agent-a', 'untrusted');
      expect(result).toBe(true);
    });

    it('decrement clamps to zero — never goes negative', () => {
      const meter = createMeter();
      meter.decrementSessions('agent-a'); // agent doesn't exist yet
      // Should still be able to create sessions
      const result = meter.incrementSessions('agent-a', 'trusted');
      expect(result).toBe(true);
      const state = meter.getAgentState('agent-a');
      expect(state?.activeSessions).toBe(1);
    });

    it('reports remaining sessions in check result', () => {
      const meter = createMeter();
      meter.incrementSessions('agent-a', 'verified'); // max=3
      meter.incrementSessions('agent-a', 'verified');
      const result = meter.check('agent-a', 'verified', 1);
      expect(result.remaining.sessions).toBe(1);
    });
  });

  // ── 9. Rolling windows ──────────────────────────────────────────────

  describe('rolling windows', () => {
    it('resets hourly tokens when hour changes', () => {
      const meter = createMeter();
      meter.record('agent-a', 'untrusted', 9_000);

      // Manually mutate the agent's hourWindowStart to a past hour
      const state = meter.getAgentState('agent-a');
      expect(state).not.toBeNull();

      // Persist, then modify the file to simulate a past hour
      meter.persist();
      const filePath = path.join(tmpDir, 'threadline', 'compute-meters.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const pastHour = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      data.agents['agent-a'].hourWindowStart = pastHour;
      fs.writeFileSync(filePath, JSON.stringify(data));

      // Reload — windows should roll
      const meter2 = createMeter();
      const result = meter2.check('agent-a', 'untrusted', 9_000);
      expect(result.allowed).toBe(true);
    });

    it('resets daily tokens when day changes', () => {
      const meter = createMeter();
      meter.record('agent-a', 'untrusted', 9_000);
      meter.persist();

      const filePath = path.join(tmpDir, 'threadline', 'compute-meters.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const pastDay = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      data.agents['agent-a'].dayWindowStart = pastDay;
      data.agents['agent-a'].hourWindowStart = pastDay;
      fs.writeFileSync(filePath, JSON.stringify(data));

      const meter2 = createMeter();
      const state = meter2.getAgentState('agent-a');
      expect(state?.dailyTokens).toBe(0);
      expect(state?.hourlyTokens).toBe(0);
    });

    it('resets global daily window when day changes', () => {
      const meter = createMeter({ globalDailyCap: 10_000 });
      meter.record('agent-a', 'autonomous', 9_000);
      meter.persist();

      const filePath = path.join(tmpDir, 'threadline', 'compute-meters.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const pastDay = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      data.global.dayWindowStart = pastDay;
      fs.writeFileSync(filePath, JSON.stringify(data));

      const meter2 = createMeter({ globalDailyCap: 10_000 });
      const globalState = meter2.getGlobalState();
      expect(globalState.dailyTokens).toBe(0);
    });
  });

  // ── 10. Budget overrides ────────────────────────────────────────────

  describe('budget overrides', () => {
    it('applies partial budget override', () => {
      const meter = createMeter({
        budgetOverrides: {
          untrusted: { hourlyTokenLimit: 99_999 },
        },
      });
      const budget = meter.getBudget('untrusted');
      expect(budget.hourlyTokenLimit).toBe(99_999);
      // Other fields remain at defaults
      expect(budget.dailyTokenLimit).toBe(50_000);
      expect(budget.maxConcurrentSessions).toBe(1);
    });

    it('applies full budget override', () => {
      const meter = createMeter({
        budgetOverrides: {
          verified: {
            hourlyTokenLimit: 1,
            dailyTokenLimit: 2,
            maxConcurrentSessions: 3,
          },
        },
      });
      const budget = meter.getBudget('verified');
      expect(budget.hourlyTokenLimit).toBe(1);
      expect(budget.dailyTokenLimit).toBe(2);
      expect(budget.maxConcurrentSessions).toBe(3);
    });

    it('does not affect non-overridden trust levels', () => {
      const meter = createMeter({
        budgetOverrides: {
          untrusted: { hourlyTokenLimit: 1 },
        },
      });
      const budget = meter.getBudget('trusted');
      expect(budget.hourlyTokenLimit).toBe(200_000);
    });

    it('overrides are enforced in check()', () => {
      const meter = createMeter({
        budgetOverrides: {
          trusted: { hourlyTokenLimit: 100 },
        },
      });
      meter.record('agent-a', 'trusted', 100);
      const result = meter.check('agent-a', 'trusted', 1);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('hourly_limit_exceeded');
    });
  });

  // ── 11. Persistence ─────────────────────────────────────────────────

  describe('persistence', () => {
    it('persist creates the compute-meters.json file', () => {
      const meter = createMeter();
      meter.record('agent-a', 'trusted', 1_000);
      meter.persist();
      const filePath = path.join(tmpDir, 'threadline', 'compute-meters.json');
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('persist/reload round-trips agent state', () => {
      const meter = createMeter();
      meter.record('agent-a', 'trusted', 42_000);
      meter.incrementSessions('agent-a', 'trusted');
      meter.persist();

      const meter2 = createMeter();
      const state = meter2.getAgentState('agent-a');
      expect(state).not.toBeNull();
      expect(state!.hourlyTokens).toBe(42_000);
      expect(state!.dailyTokens).toBe(42_000);
      expect(state!.activeSessions).toBe(1);
    });

    it('persist/reload round-trips global state', () => {
      const meter = createMeter({ globalDailyCap: 500_000 });
      meter.record('agent-a', 'trusted', 100_000);
      meter.persist();

      const meter2 = createMeter({ globalDailyCap: 500_000 });
      const globalState = meter2.getGlobalState();
      expect(globalState.dailyTokens).toBe(100_000);
    });

    it('reload is a no-op when file does not exist', () => {
      const meter = createMeter();
      // No persist called, reload in constructor should be fine
      const state = meter.getAgentState('agent-a');
      expect(state).toBeNull();
    });

    it('reload handles corrupted file gracefully', () => {
      const filePath = path.join(tmpDir, 'threadline', 'compute-meters.json');
      fs.mkdirSync(path.join(tmpDir, 'threadline'), { recursive: true });
      fs.writeFileSync(filePath, 'NOT VALID JSON!!!');
      // Should not throw
      const meter = createMeter();
      expect(meter).toBeInstanceOf(ComputeMeter);
    });
  });

  // ── 12. reset() ─────────────────────────────────────────────────────

  describe('reset()', () => {
    it('resets a specific agent', () => {
      const meter = createMeter();
      meter.record('agent-a', 'trusted', 50_000);
      meter.record('agent-b', 'trusted', 30_000);
      meter.reset('agent-a');

      expect(meter.getAgentState('agent-a')).toBeNull();
      expect(meter.getAgentState('agent-b')).not.toBeNull();
    });

    it('resets all agents and global when no arg', () => {
      const meter = createMeter({ globalDailyCap: 1_000_000 });
      meter.record('agent-a', 'trusted', 50_000);
      meter.record('agent-b', 'trusted', 30_000);
      meter.reset();

      expect(meter.getAgentState('agent-a')).toBeNull();
      expect(meter.getAgentState('agent-b')).toBeNull();
      expect(meter.getGlobalState().dailyTokens).toBe(0);
    });

    it('reset specific agent does not affect global counter', () => {
      const meter = createMeter({ globalDailyCap: 1_000_000 });
      meter.record('agent-a', 'trusted', 50_000);
      meter.reset('agent-a');

      // Global still has those tokens
      const globalState = meter.getGlobalState();
      expect(globalState.dailyTokens).toBe(50_000);
    });
  });

  // ── 13. Multiple agents ─────────────────────────────────────────────

  describe('multiple agents', () => {
    it('tracks agents independently', () => {
      const meter = createMeter();
      meter.record('agent-a', 'untrusted', 8_000);
      meter.record('agent-b', 'untrusted', 3_000);

      const stateA = meter.getAgentState('agent-a');
      const stateB = meter.getAgentState('agent-b');
      expect(stateA!.hourlyTokens).toBe(8_000);
      expect(stateB!.hourlyTokens).toBe(3_000);
    });

    it('one agent hitting limit does not affect another', () => {
      const meter = createMeter();
      meter.record('agent-a', 'untrusted', 10_000);
      const result = meter.check('agent-b', 'untrusted', 5_000);
      expect(result.allowed).toBe(true);
    });

    it('agents can have different trust levels', () => {
      const meter = createMeter();
      meter.record('agent-untrusted', 'untrusted', 10_000);
      meter.record('agent-trusted', 'trusted', 10_000);

      const resultUntrusted = meter.check('agent-untrusted', 'untrusted', 1);
      const resultTrusted = meter.check('agent-trusted', 'trusted', 1);

      expect(resultUntrusted.allowed).toBe(false); // 10_000 = hourly limit
      expect(resultTrusted.allowed).toBe(true); // 10_000 < 200_000 hourly limit
    });
  });

  // ── 14. retryAfterSeconds ───────────────────────────────────────────

  describe('retryAfterSeconds', () => {
    it('provides retryAfterSeconds on hourly denial', () => {
      const meter = createMeter();
      meter.record('agent-a', 'untrusted', 10_000);
      const result = meter.check('agent-a', 'untrusted', 1);
      expect(result.retryAfterSeconds).toBeDefined();
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
      expect(result.retryAfterSeconds).toBeLessThanOrEqual(3_600);
    });

    it('provides retryAfterSeconds on daily denial', () => {
      const meter = createMeter({
        budgetOverrides: {
          untrusted: { hourlyTokenLimit: 100_000, dailyTokenLimit: 5_000 },
        },
      });
      meter.record('agent-a', 'untrusted', 5_000);
      const result = meter.check('agent-a', 'untrusted', 1);
      expect(result.retryAfterSeconds).toBeDefined();
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
      expect(result.retryAfterSeconds).toBeLessThanOrEqual(86_400);
    });

    it('provides retryAfterSeconds on global cap denial', () => {
      const meter = createMeter({
        globalDailyCap: 1_000,
        budgetOverrides: {
          trusted: { hourlyTokenLimit: 100_000, dailyTokenLimit: 100_000 },
        },
      });
      meter.record('agent-a', 'trusted', 1_000);
      const result = meter.check('agent-a', 'trusted', 1);
      expect(result.retryAfterSeconds).toBeDefined();
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('does not include retryAfterSeconds on allowed result', () => {
      const meter = createMeter();
      const result = meter.check('agent-a', 'trusted', 1);
      expect(result.retryAfterSeconds).toBeUndefined();
    });
  });

  // ── 15. Edge cases ──────────────────────────────────────────────────

  describe('edge cases', () => {
    it('zero token count is always allowed', () => {
      const meter = createMeter();
      meter.record('agent-a', 'untrusted', 10_000); // at limit
      const result = meter.check('agent-a', 'untrusted', 0);
      // 10_000 + 0 is NOT > 10_000, so allowed
      expect(result.allowed).toBe(true);
    });

    it('exactly at hourly limit is allowed', () => {
      const meter = createMeter();
      const result = meter.record('agent-a', 'untrusted', 10_000);
      expect(result.allowed).toBe(true);
    });

    it('one token over hourly limit is denied', () => {
      const meter = createMeter();
      meter.record('agent-a', 'untrusted', 10_000);
      const result = meter.check('agent-a', 'untrusted', 1);
      expect(result.allowed).toBe(false);
    });

    it('getAgentState returns null for unknown agent', () => {
      const meter = createMeter();
      expect(meter.getAgentState('nonexistent')).toBeNull();
    });

    it('getGlobalState returns valid state on fresh meter', () => {
      const meter = createMeter();
      const state = meter.getGlobalState();
      expect(state.dailyTokens).toBe(0);
      expect(state.dayWindowStart).toBeDefined();
      expect(state.lastUpdated).toBeDefined();
    });

    it('getAgentState returns a copy (not a reference)', () => {
      const meter = createMeter();
      meter.record('agent-a', 'trusted', 1_000);
      const state1 = meter.getAgentState('agent-a');
      state1!.hourlyTokens = 999_999;
      const state2 = meter.getAgentState('agent-a');
      expect(state2!.hourlyTokens).not.toBe(999_999);
    });

    it('getBudget returns a copy (not a reference)', () => {
      const meter = createMeter();
      const b1 = meter.getBudget('trusted');
      b1.hourlyTokenLimit = 0;
      const b2 = meter.getBudget('trusted');
      expect(b2.hourlyTokenLimit).toBe(200_000);
    });

    it('large token values do not cause issues', () => {
      const meter = createMeter({
        globalDailyCap: Number.MAX_SAFE_INTEGER,
        budgetOverrides: {
          autonomous: {
            hourlyTokenLimit: Number.MAX_SAFE_INTEGER,
            dailyTokenLimit: Number.MAX_SAFE_INTEGER,
          },
        },
      });
      const result = meter.record('agent-a', 'autonomous', 1_000_000_000);
      expect(result.allowed).toBe(true);
    });

    it('persist survives even with no agents recorded', () => {
      const meter = createMeter();
      meter.persist();
      const filePath = path.join(tmpDir, 'threadline', 'compute-meters.json');
      expect(fs.existsSync(filePath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(data.agents).toEqual({});
    });

    it('decrement on nonexistent agent is a no-op', () => {
      const meter = createMeter();
      // Should not throw
      meter.decrementSessions('nonexistent');
      expect(meter.getAgentState('nonexistent')).toBeNull();
    });

    it('priority order: hourly checked before daily before global', () => {
      // Set up a meter where all three limits are hit
      const meter = createMeter({
        globalDailyCap: 100,
        budgetOverrides: {
          untrusted: {
            hourlyTokenLimit: 100,
            dailyTokenLimit: 100,
          },
        },
      });
      meter.record('agent-a', 'untrusted', 100);
      const result = meter.check('agent-a', 'untrusted', 1);
      // Hourly is checked first
      expect(result.reason).toBe('hourly_limit_exceeded');
    });
  });
});
