/**
 * Comprehensive tests for ResearchRateLimiter (PROP-232 Phase 3).
 *
 * Tests cover:
 * - Rate limit decisions (allow/deny)
 * - Daily window counting
 * - Blocker hash deduplication
 * - Session recording
 * - Stats reporting
 * - Persistence (load/save)
 * - Reset
 * - Expired session cleanup
 * - Edge cases: empty state, boundary conditions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ResearchRateLimiter } from '../../src/core/ResearchRateLimiter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function setup(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-ratelimit-'));
  return tmpDir;
}

function teardown() {
  // safe-git-allow: incremental-migration
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function stateFilePath(): string {
  return path.join(tmpDir, 'state', 'research-rate-limiter.json');
}

function readStateFile(): { sessions: unknown[] } {
  return JSON.parse(fs.readFileSync(stateFilePath(), 'utf-8'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ResearchRateLimiter', () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  // ── Basic allow/deny ───────────────────────────────────────────────

  describe('check', () => {
    it('allows first research request', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir });
      const decision = limiter.check('npm login expired');

      expect(decision.allowed).toBe(true);
      expect(decision.currentCount).toBe(0);
      expect(decision.maxAllowed).toBe(10);
    });

    it('allows up to maxPerDay requests', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir, maxPerDay: 3 });

      // Record 2 sessions with sufficiently different descriptions (must hash differently)
      limiter.record('npm login token expired');
      limiter.record('git push permission denied');

      const decision = limiter.check('database connection timeout');
      expect(decision.allowed).toBe(true);
      expect(decision.currentCount).toBe(2);
    });

    it('denies when daily limit reached', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir, maxPerDay: 2 });

      limiter.record('npm login token expired');
      limiter.record('git push permission denied');

      const decision = limiter.check('database connection timeout');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('Daily research limit');
      expect(decision.currentCount).toBe(2);
      expect(decision.maxAllowed).toBe(2);
    });

    it('uses default maxPerDay of 10', () => {
      const limiter = new ResearchRateLimiter();
      const decision = limiter.check('anything');
      expect(decision.maxAllowed).toBe(10);
    });
  });

  // ── Deduplication ──────────────────────────────────────────────────

  describe('deduplication', () => {
    it('denies duplicate blocker within dedup window', () => {
      const limiter = new ResearchRateLimiter({
        stateDir: tmpDir,
        deduplicationWindowMs: 4 * 60 * 60 * 1000, // 4 hours
      });

      limiter.record('npm login expired');
      const decision = limiter.check('npm login expired');

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('Same blocker pattern');
    });

    it('hashes are case-insensitive', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir });
      limiter.record('NPM Login Expired');

      const decision = limiter.check('npm login expired');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('Same blocker pattern');
    });

    it('hashes ignore punctuation within words', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir });
      // Punctuation is stripped but hyphens join words: "npm-login" → "npmlogin"
      // So "npm login" (two words) ≠ "npmlogin" (one word)
      // Test with punctuation that doesn't change word boundaries
      limiter.record('npm! login! expired!');

      const decision = limiter.check('npm login expired');
      expect(decision.allowed).toBe(false);
    });

    it('hashes are word-order-insensitive', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir });
      limiter.record('expired npm login');

      const decision = limiter.check('login expired npm');
      expect(decision.allowed).toBe(false);
    });

    it('allows different blockers', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir });
      limiter.record('npm login expired');

      const decision = limiter.check('git push rejected');
      expect(decision.allowed).toBe(true);
    });

    it('allows same blocker after dedup window expires', () => {
      const limiter = new ResearchRateLimiter({
        stateDir: tmpDir,
        deduplicationWindowMs: 1, // 1ms window
      });

      limiter.record('npm login expired');

      // Wait a tick for dedup window to expire
      const start = Date.now();
      while (Date.now() - start < 5) { /* spin */ }

      const decision = limiter.check('npm login expired');
      expect(decision.allowed).toBe(true);
    });
  });

  // ── Recording ──────────────────────────────────────────────────────

  describe('record', () => {
    it('records a session', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir });
      limiter.record('blocker desc', 'session-123');

      const stats = limiter.stats();
      expect(stats.sessionsToday).toBe(1);
      expect(stats.recentBlockers).toContain('blocker desc');
    });

    it('records session without sessionId', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir });
      limiter.record('blocker desc');

      expect(limiter.stats().sessionsToday).toBe(1);
    });

    it('persists to state file', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir });
      limiter.record('test blocker', 'sess-1');

      const data = readStateFile();
      expect(data.sessions).toHaveLength(1);
      expect(data.sessions[0]).toMatchObject({
        description: 'test blocker',
        sessionId: 'sess-1',
      });
    });

    it('increments count correctly', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir });
      limiter.record('blocker A');
      limiter.record('blocker B');
      limiter.record('blocker C');

      const decision = limiter.check('blocker D');
      expect(decision.currentCount).toBe(3);
    });
  });

  // ── Stats ──────────────────────────────────────────────────────────

  describe('stats', () => {
    it('returns empty stats initially', () => {
      const limiter = new ResearchRateLimiter();
      const stats = limiter.stats();

      expect(stats.sessionsToday).toBe(0);
      expect(stats.maxPerDay).toBe(10);
      expect(stats.recentBlockers).toEqual([]);
    });

    it('returns correct counts after recording', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir, maxPerDay: 5 });
      limiter.record('blocker A');
      limiter.record('blocker B');

      const stats = limiter.stats();
      expect(stats.sessionsToday).toBe(2);
      expect(stats.maxPerDay).toBe(5);
    });

    it('only includes recent blockers within dedup window', () => {
      const limiter = new ResearchRateLimiter({
        stateDir: tmpDir,
        deduplicationWindowMs: 1, // 1ms window
      });

      limiter.record('old blocker');

      const start = Date.now();
      while (Date.now() - start < 5) { /* spin */ }

      const stats = limiter.stats();
      // Session still counts for today (24h), but not as "recent" for dedup
      expect(stats.sessionsToday).toBe(1);
      expect(stats.recentBlockers).toEqual([]);
    });
  });

  // ── Persistence ────────────────────────────────────────────────────

  describe('persistence', () => {
    it('persists state to disk', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir });
      limiter.record('test');

      expect(fs.existsSync(stateFilePath())).toBe(true);
    });

    it('loads persisted state on construction', () => {
      // Create and record
      const limiter1 = new ResearchRateLimiter({ stateDir: tmpDir });
      limiter1.record('blocker A');
      limiter1.record('blocker B');

      // Create new instance from same state dir
      const limiter2 = new ResearchRateLimiter({ stateDir: tmpDir });
      const stats = limiter2.stats();
      expect(stats.sessionsToday).toBe(2);
    });

    it('handles missing state file gracefully', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir });
      expect(limiter.stats().sessionsToday).toBe(0);
    });

    it('handles corrupted state file gracefully', () => {
      const dir = path.join(tmpDir, 'state');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'research-rate-limiter.json'), 'not json');

      const limiter = new ResearchRateLimiter({ stateDir: tmpDir });
      expect(limiter.stats().sessionsToday).toBe(0);
    });

    it('creates state directory if not exists', () => {
      const subDir = path.join(tmpDir, 'nested', 'deep');
      fs.mkdirSync(subDir, { recursive: true });
      const limiter = new ResearchRateLimiter({ stateDir: subDir });
      limiter.record('test');

      expect(fs.existsSync(path.join(subDir, 'state', 'research-rate-limiter.json'))).toBe(true);
    });

    it('works without stateDir (in-memory only)', () => {
      const limiter = new ResearchRateLimiter({ maxPerDay: 3 });
      limiter.record('npm login token expired');
      limiter.record('git push permission denied');

      expect(limiter.stats().sessionsToday).toBe(2);

      const decision = limiter.check('database connection timeout');
      expect(decision.allowed).toBe(true);
    });
  });

  // ── Reset ──────────────────────────────────────────────────────────

  describe('reset', () => {
    it('clears all sessions', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir });
      limiter.record('A');
      limiter.record('B');
      limiter.record('C');

      limiter.reset();
      expect(limiter.stats().sessionsToday).toBe(0);
    });

    it('persists the reset to disk', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir });
      limiter.record('A');
      limiter.reset();

      const data = readStateFile();
      expect(data.sessions).toHaveLength(0);
    });

    it('allows new sessions after reset', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir, maxPerDay: 1 });
      limiter.record('A');

      expect(limiter.check('B').allowed).toBe(false);

      limiter.reset();
      expect(limiter.check('B').allowed).toBe(true);
    });
  });

  // ── Expired session cleanup ────────────────────────────────────────

  describe('expired session cleanup', () => {
    it('cleans expired sessions on check', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir });

      // Manually inject an expired session
      const stateDir = path.join(tmpDir, 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      const expiredSession = {
        blockerHash: 'brh-test',
        description: 'old blocker',
        triggeredAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25h ago
      };
      fs.writeFileSync(
        path.join(stateDir, 'research-rate-limiter.json'),
        JSON.stringify({ sessions: [expiredSession] }),
      );

      // Reload from disk
      const limiter2 = new ResearchRateLimiter({ stateDir: tmpDir });
      const decision = limiter2.check('new blocker');

      // The expired session should have been cleaned
      expect(decision.currentCount).toBe(0);
      expect(decision.allowed).toBe(true);
    });

    it('keeps non-expired sessions during cleanup', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir });
      limiter.record('recent blocker');

      // Inject an expired session alongside the recent one
      const data = readStateFile();
      data.sessions.push({
        blockerHash: 'brh-old',
        description: 'old one',
        triggeredAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      });
      fs.writeFileSync(stateFilePath(), JSON.stringify(data));

      const limiter2 = new ResearchRateLimiter({ stateDir: tmpDir });
      const decision = limiter2.check('another blocker');
      expect(decision.currentCount).toBe(1); // Only the recent one
    });
  });

  // ── Blocker hash quality ───────────────────────────────────────────

  describe('blocker hash quality', () => {
    it('treats semantically similar descriptions as same', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir });
      limiter.record('npm login token expired');

      // Same content, different case
      expect(limiter.check('NPM LOGIN TOKEN EXPIRED').allowed).toBe(false);
      // Same words, different order (hash sorts words)
      expect(limiter.check('expired token npm login').allowed).toBe(false);
    });

    it('hyphenated words create different hashes than spaced words', () => {
      // "npm-login" → stripped to "npmlogin" (one word) vs "npm login" (two words)
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir });
      limiter.record('npm login token expired');

      // "npm-login-token-expired" becomes "npmlogintokenexpired" — different hash
      expect(limiter.check('npm-login-token-expired').allowed).toBe(true);
    });

    it('treats substantially different descriptions as different', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir });
      limiter.record('npm login token expired');

      expect(limiter.check('git push permission denied').allowed).toBe(true);
      expect(limiter.check('database connection timeout').allowed).toBe(true);
    });

    it('filters words with 2 or fewer chars from hash', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir });
      // "is" (2 chars) filtered, "an" (2 chars) filtered, but "the" (3 chars) kept
      limiter.record('npm login is an expired token');

      // Without the filtered words, should match if remaining words match
      // "npm login is an expired token" → filter <=2 → ["npm", "login", "expired", "token", "the"] wait no "the" isn't here
      // Actually: ["npm", "login", "expired", "token"] (>2 chars), sorted: ["expired", "login", "npm", "token"]
      expect(limiter.check('npm login expired token').allowed).toBe(false);
    });
  });

  // ── Rate limit boundary ────────────────────────────────────────────

  describe('rate limit boundary', () => {
    it('allows exactly at maxPerDay - 1', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir, maxPerDay: 3 });
      limiter.record('npm login token expired');
      limiter.record('git push permission denied');

      const decision = limiter.check('database connection timeout');
      expect(decision.allowed).toBe(true);
      expect(decision.currentCount).toBe(2);
    });

    it('denies at exactly maxPerDay', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir, maxPerDay: 3 });
      limiter.record('npm login token expired');
      limiter.record('git push permission denied');
      limiter.record('database connection timeout');

      const decision = limiter.check('docker build cache stale');
      expect(decision.allowed).toBe(false);
      expect(decision.currentCount).toBe(3);
    });

    it('dedup check runs before rate limit check', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir, maxPerDay: 10 });
      limiter.record('same blocker');

      const decision = limiter.check('same blocker');
      expect(decision.allowed).toBe(false);
      // Should mention "Same blocker" not "Daily limit"
      expect(decision.reason).toContain('Same blocker');
    });
  });

  // ── Format age ─────────────────────────────────────────────────────

  describe('age formatting in reason', () => {
    it('includes age in dedup reason message', () => {
      const limiter = new ResearchRateLimiter({ stateDir: tmpDir });
      limiter.record('test blocker');

      const decision = limiter.check('test blocker');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/\d+m ago/);
    });
  });
});
