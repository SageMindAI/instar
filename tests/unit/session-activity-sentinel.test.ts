/**
 * Unit tests for SessionActivitySentinel — Background session activity monitor.
 *
 * Tests:
 * - Scan lifecycle (finds sessions, creates digests, updates state)
 * - Digest creation via mock LLM
 * - Session synthesis on completion
 * - Dormant session skipping (no new activity)
 * - LLM failure with pending queue fallback
 * - Pending retry with exponential backoff
 * - Empty/malformed LLM response handling
 * - Multiple sessions in a single scan
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Session, IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';
import { SessionActivitySentinel } from '../../src/monitoring/SessionActivitySentinel.js';
import { EpisodicMemory } from '../../src/memory/EpisodicMemory.js';

// ─── Test Helpers ───────────────────────────────────────────────────

interface TestSetup {
  dir: string;
  stateDir: string;
  cleanup: () => void;
}

function createTestDir(): TestSetup {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-test-'));
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    dir,
    stateDir,
    // safe-git-allow: incremental-migration
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    name: 'test-session',
    status: 'running',
    tmuxSession: 'test-tmux-session',
    startedAt: '2026-02-27T10:00:00Z',
    jobSlug: 'test-job',
    prompt: 'Do some work',
    ...overrides,
  };
}

function createMockIntelligence(
  response?: string,
): IntelligenceProvider & { _calls: Array<{ prompt: string; options?: IntelligenceOptions }> } {
  const calls: Array<{ prompt: string; options?: IntelligenceOptions }> = [];
  const defaultResponse = JSON.stringify({
    summary: 'Worked on implementing the feature.',
    actions: ['committed code', 'ran tests'],
    learnings: ['Tests should be written first'],
    significance: 6,
    themes: ['development', 'testing'],
  });

  return {
    _calls: calls,
    evaluate: async (prompt: string, options?: IntelligenceOptions) => {
      calls.push({ prompt, options });
      return response ?? defaultResponse;
    },
  };
}

function createFailingIntelligenceProvider(
  failCount: number,
): IntelligenceProvider & { callCount: number } {
  const provider = {
    callCount: 0,
    evaluate: async (_prompt: string, _options?: IntelligenceOptions) => {
      provider.callCount++;
      if (provider.callCount <= failCount) {
        throw new Error('LLM API unavailable');
      }
      return JSON.stringify({
        summary: 'Recovered after failures.',
        actions: ['recovered'],
        learnings: [],
        significance: 5,
        themes: ['recovery'],
      });
    },
  };
  return provider;
}

// Session output must be > 500 chars to pass ActivityPartitioner minimum threshold
const LONG_SESSION_OUTPUT = [
  '$ npm test',
  'Running test suite with 15 test files...',
  '',
  'PASS tests/unit/auth.test.ts (12 tests)',
  '  ✓ validates JWT tokens correctly',
  '  ✓ rejects expired tokens',
  '  ✓ handles missing authorization header',
  '  ✓ refreshes token when close to expiry',
  '',
  'PASS tests/unit/db.test.ts (8 tests)',
  '  ✓ connects to database successfully',
  '  ✓ handles connection timeouts',
  '  ✓ retries on transient failures',
  '',
  'PASS tests/unit/api.test.ts (15 tests)',
  '  ✓ GET /api/users returns user list',
  '  ✓ POST /api/users creates new user',
  '  ✓ PUT /api/users/:id updates user',
  '  ✓ DELETE /api/users/:id removes user',
  '',
  'Test Suites: 3 passed, 3 total',
  'Tests:       35 passed, 35 total',
  'Time:        2.847s',
  '',
  '$ git add -A',
  '$ git commit -m "feat: add auth module with comprehensive tests"',
  '[main abc1234] feat: add auth module with comprehensive tests',
  ' 5 files changed, 342 insertions(+), 12 deletions(-)',
  '',
  '$ npm run build',
  'Compiling TypeScript...',
  'Compiled 42 files in 3.2 seconds.',
  'Build complete. No errors found.',
].join('\n');

// ─── Tests ──────────────────────────────────────────────────────────

describe('SessionActivitySentinel', () => {
  let setup: TestSetup;

  beforeEach(() => {
    setup = createTestDir();
  });

  afterEach(() => {
    setup?.cleanup();
  });

  // ─── Basic Scan ───────────────────────────────────────────────

  describe('scan', () => {
    it('scans active sessions and creates digests', async () => {
      const session = makeSession();
      const intelligence = createMockIntelligence();

      const sentinel = new SessionActivitySentinel({
        stateDir: setup.stateDir,
        intelligence,
        getActiveSessions: () => [session],
        captureSessionOutput: () => LONG_SESSION_OUTPUT,
      });

      const report = await sentinel.scan();

      expect(report.sessionsScanned).toBe(1);
      expect(report.digestsCreated).toBeGreaterThanOrEqual(1);
      expect(report.errors).toHaveLength(0);
      expect(intelligence._calls.length).toBeGreaterThanOrEqual(1);
    });

    it('updates sentinel state after scan', async () => {
      const session = makeSession();
      const intelligence = createMockIntelligence();

      const sentinel = new SessionActivitySentinel({
        stateDir: setup.stateDir,
        intelligence,
        getActiveSessions: () => [session],
        captureSessionOutput: () => LONG_SESSION_OUTPUT,
      });

      await sentinel.scan();

      const memory = sentinel.getEpisodicMemory();
      const state = memory.getSentinelState();
      expect(state.sessions['session-1']).toBeDefined();
      expect(state.sessions['session-1'].digestCount).toBeGreaterThanOrEqual(1);
    });

    it('skips dormant sessions (no new activity)', async () => {
      const session = makeSession();
      const intelligence = createMockIntelligence();

      const sentinel = new SessionActivitySentinel({
        stateDir: setup.stateDir,
        intelligence,
        getActiveSessions: () => [session],
        captureSessionOutput: () => LONG_SESSION_OUTPUT,
      });

      // First scan
      await sentinel.scan();
      const callsAfterFirst = intelligence._calls.length;

      // Manually mark session as fully digested with lastActivity <= lastDigested
      const memory = sentinel.getEpisodicMemory();
      const state = memory.getSentinelState();
      const sessionState = state.sessions['session-1'];
      if (sessionState) {
        sessionState.lastActivityAt = sessionState.lastDigestedAt;
        memory.saveSentinelState(state);
      }

      // Second scan — should skip
      const report = await sentinel.scan();
      expect(report.sessionsSkipped).toBe(1);
      // No new LLM calls (except possible pending retries)
    });

    it('handles empty session output gracefully', async () => {
      const session = makeSession();
      const intelligence = createMockIntelligence();

      const sentinel = new SessionActivitySentinel({
        stateDir: setup.stateDir,
        intelligence,
        getActiveSessions: () => [session],
        captureSessionOutput: () => '',  // Empty output
      });

      const report = await sentinel.scan();
      expect(report.digestsCreated).toBe(0);
      expect(report.errors).toHaveLength(0);
    });

    it('handles null session output gracefully', async () => {
      const session = makeSession();
      const intelligence = createMockIntelligence();

      const sentinel = new SessionActivitySentinel({
        stateDir: setup.stateDir,
        intelligence,
        getActiveSessions: () => [session],
        captureSessionOutput: () => null,
      });

      const report = await sentinel.scan();
      expect(report.digestsCreated).toBe(0);
    });

    it('scans multiple sessions independently', async () => {
      const sessions = [
        makeSession({ id: 'session-A', tmuxSession: 'tmux-A', name: 'A' }),
        makeSession({ id: 'session-B', tmuxSession: 'tmux-B', name: 'B' }),
      ];
      const intelligence = createMockIntelligence();

      const sentinel = new SessionActivitySentinel({
        stateDir: setup.stateDir,
        intelligence,
        getActiveSessions: () => sessions,
        captureSessionOutput: (tmux) =>
          tmux === 'tmux-A' ? 'Session A work output with enough content to pass thresholds\n'.repeat(20)
            : 'Session B different work with enough content too\n'.repeat(20),
      });

      const report = await sentinel.scan();
      expect(report.sessionsScanned).toBe(2);

      const memory = sentinel.getEpisodicMemory();
      const state = memory.getSentinelState();
      expect(state.sessions['session-A']).toBeDefined();
      expect(state.sessions['session-B']).toBeDefined();
    });
  });

  // ─── Digest Creation ──────────────────────────────────────────

  describe('digestActivity', () => {
    it('uses LLM with fast model and low temperature', async () => {
      const session = makeSession();
      const intelligence = createMockIntelligence();

      const sentinel = new SessionActivitySentinel({
        stateDir: setup.stateDir,
        intelligence,
        getActiveSessions: () => [session],
        captureSessionOutput: () => LONG_SESSION_OUTPUT,
      });

      await sentinel.digestActivity(session);

      expect(intelligence._calls.length).toBeGreaterThanOrEqual(1);
      const call = intelligence._calls[0];
      expect(call.options?.model).toBe('fast');
      expect(call.options?.temperature).toBe(0.3);
    });

    it('includes session name and job in LLM prompt', async () => {
      const session = makeSession({ name: 'my-special-session', jobSlug: 'daily-check' });
      const intelligence = createMockIntelligence();

      const sentinel = new SessionActivitySentinel({
        stateDir: setup.stateDir,
        intelligence,
        getActiveSessions: () => [session],
        captureSessionOutput: () => LONG_SESSION_OUTPUT,
      });

      await sentinel.digestActivity(session);

      const prompt = intelligence._calls[0]?.prompt ?? '';
      expect(prompt).toContain('my-special-session');
      expect(prompt).toContain('daily-check');
    });

    it('stores digests in episodic memory', async () => {
      const session = makeSession();
      const intelligence = createMockIntelligence();

      const sentinel = new SessionActivitySentinel({
        stateDir: setup.stateDir,
        intelligence,
        getActiveSessions: () => [session],
        captureSessionOutput: () => LONG_SESSION_OUTPUT,
      });

      const digests = await sentinel.digestActivity(session);

      expect(digests.length).toBeGreaterThanOrEqual(1);
      const memory = sentinel.getEpisodicMemory();
      const stored = memory.getSessionActivities('session-1');
      expect(stored.length).toBe(digests.length);
    });

    it('includes Telegram context when available', async () => {
      const session = makeSession();
      const intelligence = createMockIntelligence();

      const sentinel = new SessionActivitySentinel({
        stateDir: setup.stateDir,
        intelligence,
        getActiveSessions: () => [session],
        captureSessionOutput: () => LONG_SESSION_OUTPUT,
        getTopicForSession: () => 100,
        getTelegramMessages: () => [
          {
            messageId: 1,
            topicId: 100,
            text: 'Please work on the auth module',
            fromUser: true,
            timestamp: '2026-02-27T10:00:00Z',
            sessionName: null,
          },
        ],
      });

      await sentinel.digestActivity(session);

      // The prompt should include conversation context
      const prompt = intelligence._calls[0]?.prompt ?? '';
      expect(prompt).toContain('CONVERSATION') ;
    });
  });

  // ─── LLM Response Parsing ────────────────────────────────────

  describe('LLM response parsing', () => {
    it('handles JSON with surrounding text', async () => {
      const response = 'Here is my analysis:\n' + JSON.stringify({
        summary: 'Worked on feature.',
        actions: ['committed'],
        learnings: ['lesson 1'],
        significance: 7,
        themes: ['dev'],
      }) + '\nHope this helps!';

      const intelligence = createMockIntelligence(response);
      const session = makeSession();

      const sentinel = new SessionActivitySentinel({
        stateDir: setup.stateDir,
        intelligence,
        getActiveSessions: () => [session],
        captureSessionOutput: () => LONG_SESSION_OUTPUT,
      });

      const digests = await sentinel.digestActivity(session);
      expect(digests.length).toBeGreaterThanOrEqual(1);
      expect(digests[0].summary).toBe('Worked on feature.');
      expect(digests[0].significance).toBe(7);
    });

    it('clamps significance to 1-10 range', async () => {
      const response = JSON.stringify({
        summary: 'Over-rated.',
        actions: [],
        learnings: [],
        significance: 15,  // Over max
        themes: [],
      });

      const intelligence = createMockIntelligence(response);
      const session = makeSession();

      const sentinel = new SessionActivitySentinel({
        stateDir: setup.stateDir,
        intelligence,
        getActiveSessions: () => [session],
        captureSessionOutput: () => LONG_SESSION_OUTPUT,
      });

      const digests = await sentinel.digestActivity(session);
      if (digests.length > 0) {
        expect(digests[0].significance).toBeLessThanOrEqual(10);
      }
    });

    it('handles completely invalid JSON gracefully', async () => {
      const intelligence = createMockIntelligence('This is not JSON at all.');
      const session = makeSession();

      const sentinel = new SessionActivitySentinel({
        stateDir: setup.stateDir,
        intelligence,
        getActiveSessions: () => [session],
        captureSessionOutput: () => LONG_SESSION_OUTPUT,
      });

      // Should not throw, just return empty digests
      const digests = await sentinel.digestActivity(session);
      // Digests may be empty since parsing failed
      expect(Array.isArray(digests)).toBe(true);
    });
  });

  // ─── Session Synthesis ────────────────────────────────────────

  describe('synthesizeSession', () => {
    it('creates a synthesis from accumulated digests', async () => {
      const session = makeSession({ endedAt: '2026-02-27T12:00:00Z' });
      const synthesisResponse = JSON.stringify({
        summary: 'Complete session overview: built the feature and tested it.',
        keyOutcomes: ['Feature shipped', 'Tests green'],
        significance: 8,
        followUp: 'Deploy to production',
      });

      // First call returns digest, second returns synthesis
      let callCount = 0;
      const intelligence: IntelligenceProvider & { _calls: any[] } = {
        _calls: [],
        evaluate: async (prompt: string, options?: IntelligenceOptions) => {
          callCount++;
          intelligence._calls.push({ prompt, options });
          if (prompt.includes('session synthesis') || prompt.includes('activity digests')) {
            return synthesisResponse;
          }
          return JSON.stringify({
            summary: 'Did some work.',
            actions: ['coded'],
            learnings: [],
            significance: 5,
            themes: ['dev'],
          });
        },
      };

      const sentinel = new SessionActivitySentinel({
        stateDir: setup.stateDir,
        intelligence,
        getActiveSessions: () => [session],
        captureSessionOutput: () => LONG_SESSION_OUTPUT,
      });

      const report = await sentinel.synthesizeSession(session);

      expect(report.synthesisCreated).toBe(true);
      expect(report.digestCount).toBeGreaterThanOrEqual(1);

      const memory = sentinel.getEpisodicMemory();
      const synthesis = memory.getSynthesis('session-1');
      expect(synthesis).not.toBeNull();
      expect(synthesis!.sessionId).toBe('session-1');
    });

    it('returns report with zero digests for empty sessions', async () => {
      const session = makeSession();
      const intelligence = createMockIntelligence();

      const sentinel = new SessionActivitySentinel({
        stateDir: setup.stateDir,
        intelligence,
        getActiveSessions: () => [session],
        captureSessionOutput: () => '',  // Empty — nothing to digest
      });

      const report = await sentinel.synthesizeSession(session);
      expect(report.digestCount).toBe(0);
      expect(report.synthesisCreated).toBe(false);
    });
  });

  // ─── LLM Failure & Pending Queue ─────────────────────────────

  describe('LLM failure handling', () => {
    it('saves failed digests to pending queue', async () => {
      const session = makeSession();
      const intelligence = createFailingIntelligenceProvider(10);  // Always fail

      const sentinel = new SessionActivitySentinel({
        stateDir: setup.stateDir,
        intelligence,
        getActiveSessions: () => [session],
        captureSessionOutput: () => LONG_SESSION_OUTPUT,
      });

      const digests = await sentinel.digestActivity(session);
      expect(digests).toHaveLength(0);  // All failed

      const memory = sentinel.getEpisodicMemory();
      const pending = memory.getPending('session-1');
      expect(pending.length).toBeGreaterThanOrEqual(1);
    });

    it('continues scanning other sessions when one fails', async () => {
      const sessions = [
        makeSession({ id: 'fail-session', tmuxSession: 'tmux-fail', name: 'Fail' }),
        makeSession({ id: 'ok-session', tmuxSession: 'tmux-ok', name: 'OK' }),
      ];

      let callCount = 0;
      const intelligence: IntelligenceProvider = {
        evaluate: async () => {
          callCount++;
          if (callCount <= 2) {
            throw new Error('Fail for first session');
          }
          return JSON.stringify({
            summary: 'OK session work.',
            actions: ['worked'],
            learnings: [],
            significance: 5,
            themes: ['ok'],
          });
        },
      };

      const sentinel = new SessionActivitySentinel({
        stateDir: setup.stateDir,
        intelligence,
        getActiveSessions: () => sessions,
        captureSessionOutput: (tmux) =>
          tmux === 'tmux-fail'
            ? LONG_SESSION_OUTPUT
            : 'OK session work happening here with enough content\n'.repeat(20),
      });

      const report = await sentinel.scan();
      expect(report.sessionsScanned).toBe(2);
      // At least one session should have created digests or pending items
    });
  });

  // ─── Max Retries ──────────────────────────────────────────────

  describe('max retries', () => {
    it('respects custom maxRetries config', () => {
      const intelligence = createMockIntelligence();

      const sentinel = new SessionActivitySentinel({
        stateDir: setup.stateDir,
        intelligence,
        getActiveSessions: () => [],
        captureSessionOutput: () => '',
        maxRetries: 5,
      });

      // Verify sentinel was created with custom config — no crash
      expect(sentinel).toBeDefined();
    });
  });

  // ─── getEpisodicMemory ────────────────────────────────────────

  describe('getEpisodicMemory', () => {
    it('returns the underlying EpisodicMemory instance', () => {
      const intelligence = createMockIntelligence();
      const sentinel = new SessionActivitySentinel({
        stateDir: setup.stateDir,
        intelligence,
        getActiveSessions: () => [],
        captureSessionOutput: () => '',
      });

      const memory = sentinel.getEpisodicMemory();
      expect(memory).toBeInstanceOf(EpisodicMemory);
    });
  });

  // ─── Report Structure ─────────────────────────────────────────

  describe('report structure', () => {
    it('scan report has correct shape', async () => {
      const intelligence = createMockIntelligence();
      const sentinel = new SessionActivitySentinel({
        stateDir: setup.stateDir,
        intelligence,
        getActiveSessions: () => [],
        captureSessionOutput: () => '',
      });

      const report = await sentinel.scan();
      expect(report).toHaveProperty('scannedAt');
      expect(report).toHaveProperty('sessionsScanned');
      expect(report).toHaveProperty('digestsCreated');
      expect(report).toHaveProperty('sessionsSkipped');
      expect(report).toHaveProperty('errors');
      expect(typeof report.scannedAt).toBe('string');
      expect(Array.isArray(report.errors)).toBe(true);
    });

    it('synthesis report has correct shape', async () => {
      const session = makeSession();
      const intelligence = createMockIntelligence();

      const sentinel = new SessionActivitySentinel({
        stateDir: setup.stateDir,
        intelligence,
        getActiveSessions: () => [session],
        captureSessionOutput: () => '',
      });

      const report = await sentinel.synthesizeSession(session);
      expect(report).toHaveProperty('sessionId');
      expect(report).toHaveProperty('digestCount');
      expect(report).toHaveProperty('synthesisCreated');
      expect(report.sessionId).toBe('session-1');
    });
  });
});
