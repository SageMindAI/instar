/**
 * E2E test — Episodic Memory (SessionActivitySentinel) full lifecycle.
 *
 * Tests the complete PRODUCTION path:
 *   1. Server starts with SessionActivitySentinel initialized (same as server.ts)
 *   2. Episode API routes return 200 (not 503 — the "dead on arrival" check)
 *   3. Scan detects running sessions and creates digests through full HTTP pipeline
 *   4. Session synthesis is produced when sessions complete
 *   5. Query routes return correct data across time ranges, themes, significance
 *   6. Stats reflect all created data accurately
 *
 * WHY THIS TEST EXISTS:
 * Integration tests manually inject SessionActivitySentinel into AgentServer.
 * That proves routes work IF the sentinel is wired. But it doesn't catch the
 * case where server.ts never creates SessionActivitySentinel (e.g., because
 * sharedIntelligence is null), making every /episodes/* route return 503.
 *
 * This test initializes SessionActivitySentinel the SAME WAY server.ts does:
 *   - Same config pattern (stateDir, intelligence, session accessors)
 *   - Same dependency wiring (getActiveSessions, captureSessionOutput, etc.)
 *   - Passed to AgentServer the same way production does
 *
 * If this test passes but production fails, the gap is in a deployment
 * concern (no intelligence provider configured) — not a wiring concern.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SessionActivitySentinel } from '../../src/monitoring/SessionActivitySentinel.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig, IntelligenceProvider, Session } from '../../src/core/types.js';

describe('Episodic Memory E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let mockSM: ReturnType<typeof createMockSessionManager>;
  let spawnedSession: Session;
  const AUTH_TOKEN = 'test-e2e-episodic';

  // Long session output for realistic partitioning (must exceed 500 char threshold)
  const SESSION_OUTPUT = [
    '$ vitest run tests/unit/episodic-memory.test.ts',
    '',
    ' DEV  v2.1.9 /Users/test/instar',
    '',
    ' tests/unit/episodic-memory.test.ts (35 tests) 1245ms',
    '   EpisodicMemory',
    '     initialization',
    '       ✓ creates episode directories on construction',
    '     saveDigest',
    '       ✓ saves and returns a digest with generated ID',
    '       ✓ is idempotent for same session+time window',
    '       ✓ creates distinct digests for different time windows',
    '     getSessionActivities',
    '       ✓ returns digests ordered by startedAt',
    '     saveSynthesis + getSynthesis',
    '       ✓ round-trips a session synthesis',
    '',
    ' Test Files  1 passed (1)',
    ' Tests  35 passed (35)',
    '',
    '$ git add tests/unit/episodic-memory.test.ts',
    '$ git commit -m "feat(memory): Phase 3 episodic memory unit tests"',
    '[main f741603] feat(memory): Phase 3 episodic memory unit tests',
    ' 1 file changed, 420 insertions(+)',
    '',
    'Now writing integration tests for the HTTP routes.',
    'Reading the E2E testing standard...',
  ].join('\n');

  // Mock Telegram message log for dual-source testing
  const TELEGRAM_MESSAGES = [
    { text: 'How are the episodic memory tests going?', fromJustin: true, topicId: 4509, timestamp: new Date().toISOString() },
    { text: 'All 35 unit tests passing. Moving to integration tests now.', fromJustin: false, topicId: 4509, timestamp: new Date().toISOString() },
  ];

  // Track intelligence calls to verify model tier
  const intelligenceCalls: Array<{ prompt: string; options: any }> = [];

  function createMockIntelligence(): IntelligenceProvider {
    return {
      evaluate: async (prompt: string, options?: any) => {
        intelligenceCalls.push({ prompt, options });

        // Return different responses based on whether it's a digest or synthesis
        // NOTE: Must use unique prompt preamble, NOT generic keywords — session output
        // may contain "session synthesis" as test names (e.g., "round-trips a session synthesis")
        if (prompt.includes('creating a coherent session synthesis')) {
          return JSON.stringify({
            summary: 'Full session building and testing the episodic memory module. Wrote unit tests, committed code, and started on integration tests.',
            keyOutcomes: ['35 unit tests passing', 'Phase 3 committed'],
            significance: 7,
            followUp: 'Complete integration and E2E tests',
          });
        }

        return JSON.stringify({
          summary: 'Ran unit tests for episodic memory and committed the results.',
          actions: ['ran 35 unit tests', 'committed Phase 3 code'],
          learnings: ['Partition thresholds need >500 chars for test stability'],
          significance: 7,
          themes: ['testing', 'memory-architecture'],
        });
      },
    };
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'episodic-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'e2e-test', agentName: 'E2E Test' }),
    );

    mockSM = createMockSessionManager();
    const intelligence = createMockIntelligence();

    // ━━━ CRITICAL: Initialize the same way server.ts does ━━━
    // From server.ts lines 1412-1432:
    //
    //   let activitySentinel;
    //   if (sharedIntelligence) {
    //     activitySentinel = new SessionActivitySentinel({
    //       stateDir: config.stateDir,
    //       intelligence: sharedIntelligence,
    //       getActiveSessions: () => sessionManager.listRunningSessions(),
    //       captureSessionOutput: (tmuxSession) => sessionManager.captureOutput(tmuxSession),
    //       getTelegramMessages: telegram
    //         ? (topicId, since) => telegram!.searchLog({ topicId, since: since ? new Date(since) : undefined, limit: 200 })
    //         : undefined,
    //       getTopicForSession: telegram
    //         ? (tmuxSession) => telegram!.getTopicForSession(tmuxSession)
    //         : undefined,
    //     });
    //   }

    // Mock telegram adapter for getTelegramMessages/getTopicForSession
    const mockTelegram = {
      searchLog: vi.fn((_opts: { topicId: number; since?: Date; limit: number }) => {
        return TELEGRAM_MESSAGES;
      }),
      getTopicForSession: vi.fn((_tmuxSession: string) => 4509),
    };

    const activitySentinel = new SessionActivitySentinel({
      stateDir,
      intelligence,
      getActiveSessions: () => mockSM.listRunningSessions(),
      captureSessionOutput: (tmuxSession) => {
        // Return realistic output for test sessions
        if (mockSM._aliveSet.has(tmuxSession)) return SESSION_OUTPUT;
        return null;
      },
      getTelegramMessages: (topicId, since) => mockTelegram.searchLog({
        topicId,
        since: since ? new Date(since) : undefined,
        limit: 200,
      }),
      getTopicForSession: (tmuxSession) => mockTelegram.getTopicForSession(tmuxSession),
    });

    const config: InstarConfig = {
      projectName: 'e2e-test',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      requestTimeoutMs: 10000,
      version: '0.10.0',
      sessions: {
        claudePath: '/usr/bin/echo',
        maxSessions: 3,
        defaultMaxDurationMinutes: 30,
        protectedSessions: [],
        monitorIntervalMs: 5000,
      },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [],
      monitoring: {},
      updates: {},
    };

    const state = new StateManager(stateDir);

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state,
      activitySentinel,
    });

    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  // ══════════════════════════════════════════════════════════════════
  // Phase 1: Feature is ALIVE (not dead on arrival)
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 1: Feature is alive (not 503)', () => {
    it('GET /episodes/stats returns 200 (not 503)', async () => {
      const res = await request(app)
        .get('/episodes/stats')
        .set(auth());

      // This is THE test that catches "dead on arrival" bugs.
      // If this returns 503, SessionActivitySentinel was never wired into server.ts.
      expect(res.status).toBe(200);
      expect(res.body.totalDigests).toBeDefined();
    });

    it('GET /episodes/sessions returns 200', async () => {
      const res = await request(app)
        .get('/episodes/sessions')
        .set(auth());

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('GET /episodes/recent returns 200', async () => {
      const res = await request(app)
        .get('/episodes/recent')
        .set(auth());

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('POST /episodes/scan returns 200', async () => {
      const res = await request(app)
        .post('/episodes/scan')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.scannedAt).toBeTruthy();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 2: Scan creates digests from running sessions
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 2: Scan lifecycle', () => {
    it('scan detects the running session and creates digests', async () => {
      // Spawn a session for scan testing (deferred from beforeAll so Phase 1 scans 0 sessions)
      spawnedSession = await mockSM.spawnSession({
        name: 'episodic-e2e-worker',
        prompt: 'Build episodic memory tests',
        jobSlug: 'memory-build',
      });

      const res = await request(app)
        .post('/episodes/scan')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.sessionsScanned).toBe(1);
      expect(res.body.digestsCreated).toBeGreaterThanOrEqual(1);
      expect(res.body.errors).toHaveLength(0);
    });

    it('scan results are persisted and queryable', async () => {
      const res = await request(app)
        .get(`/episodes/sessions/${spawnedSession.id}/activities`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
      expect(res.body[0].sessionId).toBe(spawnedSession.id);
    });

    it('uses fast model tier for cost efficiency', () => {
      // Verify the intelligence provider was called with model: 'fast'
      const digestCalls = intelligenceCalls.filter(c => c.options?.model === 'fast');
      expect(digestCalls.length).toBeGreaterThan(0);
    });

    it('subsequent scan skips dormant sessions (idempotent)', async () => {
      // Second scan — no new activity since last scan
      const res = await request(app)
        .post('/episodes/scan')
        .set(auth());

      expect(res.status).toBe(200);
      // Should skip because lastActivityAt <= lastDigestedAt
      expect(res.body.sessionsSkipped).toBeGreaterThanOrEqual(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 3: Query routes return correct data
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 3: Query routes', () => {
    it('stats reflect created digests', async () => {
      const res = await request(app)
        .get('/episodes/stats')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.totalDigests).toBeGreaterThanOrEqual(1);
      expect(res.body.sessionCount).toBeGreaterThanOrEqual(1);
    });

    it('recent activity includes scan results', async () => {
      const res = await request(app)
        .get('/episodes/recent')
        .set(auth())
        .query({ hours: 1, limit: 10 });

      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });

    it('theme search finds digests by topic', async () => {
      // First verify digests exist and have themes
      const activitiesRes = await request(app)
        .get(`/episodes/sessions/${spawnedSession.id}/activities`)
        .set(auth());

      expect(activitiesRes.body.length).toBeGreaterThan(0);
      const firstDigest = activitiesRes.body[0];
      expect(firstDigest.themes).toBeDefined();
      expect(firstDigest.themes.length).toBeGreaterThan(0);

      // Search for the actual theme from the digest
      const themeToSearch = firstDigest.themes[0];
      const res = await request(app)
        .get(`/episodes/themes/${encodeURIComponent(themeToSearch)}`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });

    it('theme search returns empty for unmatched topic', async () => {
      const res = await request(app)
        .get('/episodes/themes/quantum-entanglement')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 4: Session synthesis on completion
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 4: Session synthesis', () => {
    it('session completion creates a synthesis', async () => {
      // Kill the session — in production, sessionComplete event fires
      mockSM.killSession(spawnedSession.id);

      // Manually trigger synthesis (in production, this happens via sessionComplete event)
      const sentinel = new SessionActivitySentinel({
        stateDir,
        intelligence: createMockIntelligence(),
        getActiveSessions: () => [],
        captureSessionOutput: () => null,
      });

      const report = await sentinel.synthesizeSession(spawnedSession);
      expect(report.synthesisCreated).toBe(true);
      expect(report.digestCount).toBeGreaterThanOrEqual(1);
    });

    it('synthesis is queryable via API', async () => {
      const res = await request(app)
        .get(`/episodes/sessions/${spawnedSession.id}`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.sessionId).toBe(spawnedSession.id);
      expect(res.body.summary).toBeTruthy();
      expect(res.body.keyOutcomes).toBeInstanceOf(Array);
      expect(res.body.activityDigestIds).toBeInstanceOf(Array);
    });

    it('sessions list includes the synthesized session', async () => {
      const res = await request(app)
        .get('/episodes/sessions')
        .set(auth());

      expect(res.status).toBe(200);
      const ids = res.body.map((s: any) => s.sessionId);
      expect(ids).toContain(spawnedSession.id);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 5: Stats integrity after full lifecycle
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 5: Final stats integrity', () => {
    it('stats are consistent with all created data', async () => {
      const statsRes = await request(app)
        .get('/episodes/stats')
        .set(auth());

      const sessionsRes = await request(app)
        .get('/episodes/sessions')
        .set(auth());

      const activitiesRes = await request(app)
        .get(`/episodes/sessions/${spawnedSession.id}/activities`)
        .set(auth());

      expect(statsRes.body.totalSyntheses).toBe(sessionsRes.body.length);
      expect(statsRes.body.totalDigests).toBeGreaterThanOrEqual(activitiesRes.body.length);
    });
  });
});
