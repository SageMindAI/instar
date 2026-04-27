/**
 * E2E test — Full Memory Stack lifecycle (cross-layer integration).
 *
 * THE GAP THIS FILLS:
 * Each memory subsystem has its own E2E test (semantic, episodic, working,
 * hybrid, exporter, topic). But none tests them TOGETHER as a unified system.
 * Production wires ALL layers simultaneously. This test exercises the full
 * memory stack as a single integrated system — the way it runs in production.
 *
 * Tests the complete PRODUCTION path across ALL memory layers:
 *   Phase 1: Server starts with ALL memory subsystems wired simultaneously
 *   Phase 2: Seed data across all layers (semantic entities, topic history, episodes)
 *   Phase 3: Working memory draws from ALL sources in a single assembly
 *   Phase 4: Hybrid search finds entities created through different paths
 *   Phase 5: Export MEMORY.md reflects the full knowledge graph
 *   Phase 6: Cross-layer data consistency (semantic ↔ episodic ↔ working)
 *   Phase 7: Mutation propagation (changes in one layer visible in others)
 *   Phase 8: Graceful degradation (remove one layer, others keep working)
 *   Phase 9: Large dataset behavior (100+ entities, search ranking stability)
 *   Phase 10: Concurrent read/write safety across layers
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';
import { EpisodicMemory } from '../../src/memory/EpisodicMemory.js';
import { WorkingMemoryAssembler } from '../../src/memory/WorkingMemoryAssembler.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { SessionActivitySentinel } from '../../src/monitoring/SessionActivitySentinel.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig, IntelligenceProvider, Session } from '../../src/core/types.js';

describe('Full Memory Stack E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let semanticMemory: SemanticMemory;
  let episodicMemory: EpisodicMemory;
  let topicMemory: TopicMemory;
  let workingMemory: WorkingMemoryAssembler;
  let activitySentinel: SessionActivitySentinel;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let mockSM: ReturnType<typeof createMockSessionManager>;
  const AUTH_TOKEN = 'full-stack-e2e-token';

  const intelligenceCalls: Array<{ prompt: string; options: any }> = [];
  // Track which sessions have been created (keep returning output even after kill)
  const createdSessions = new Set<string>();

  function createMockIntelligence(): IntelligenceProvider {
    return {
      evaluate: async (prompt: string, options?: any) => {
        intelligenceCalls.push({ prompt, options });
        if (prompt.includes('creating a coherent session synthesis')) {
          return JSON.stringify({
            summary: 'Built and tested the authentication microservice with JWT token rotation.',
            keyOutcomes: ['JWT rotation implemented', 'Integration tests passing'],
            significance: 8,
            followUp: 'Deploy to staging',
          });
        }
        return JSON.stringify({
          summary: 'Implemented JWT token rotation for the auth service.',
          actions: ['wrote JWT rotation logic', 'added refresh token endpoint'],
          learnings: ['Token rotation requires atomic DB writes'],
          significance: 8,
          themes: ['authentication', 'security', 'backend'],
        });
      },
    };
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-stack-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'full-stack-test', agentName: 'Full Stack Agent', authToken: AUTH_TOKEN }),
    );

    // ── Initialize ALL memory subsystems (mirrors production server.ts) ──

    // 1. SemanticMemory (SQLite knowledge graph)
    semanticMemory = new SemanticMemory({
      dbPath: path.join(stateDir, 'semantic.db'),
      decayHalfLifeDays: 30,
      lessonDecayHalfLifeDays: 90,
      staleThreshold: 0.2,
    });
    await semanticMemory.open();

    // 2. EpisodicMemory (session activity digests)
    episodicMemory = new EpisodicMemory({ stateDir });

    // 3. TopicMemory (conversation history)
    topicMemory = new TopicMemory(stateDir);
    await topicMemory.open();

    // 4. WorkingMemoryAssembler (context-aware retrieval)
    workingMemory = new WorkingMemoryAssembler({
      semanticMemory,
      episodicMemory,
    });

    // 5. SessionActivitySentinel (episodic digest generation)
    mockSM = createMockSessionManager();
    const intelligence = createMockIntelligence();

    // Session output must exceed 500 chars (ActivityPartitioner threshold)
    const SESSION_OUTPUT = [
      '$ implementing JWT token rotation for the authentication service',
      'Starting with the refresh token endpoint implementation...',
      'Writing the token rotation controller with atomic database operations.',
      'Added atomic DB write for token pairs to prevent race conditions during rotation.',
      'The old token remains valid for a 30-second grace period during transition.',
      'Running integration tests to verify the full authentication flow...',
      'Test 1: Token generation with RS256 signing — PASSED',
      'Test 2: Token refresh with valid refresh token — PASSED',
      'Test 3: Token rotation atomicity under concurrent requests — PASSED',
      'Test 4: Grace period expiration after 30 seconds — PASSED',
      'Test 5: Invalid refresh token rejection — PASSED',
      'All 12 integration tests passing.',
      '$ git commit -m "feat(auth): JWT rotation with atomic writes"',
      '[main abc1234] feat(auth): JWT rotation with atomic writes',
      ' 3 files changed, 245 insertions(+), 12 deletions(-)',
      '',
      'Now preparing deployment configuration for staging environment.',
    ].join('\n');

    activitySentinel = new SessionActivitySentinel({
      stateDir,
      intelligence,
      getActiveSessions: () => mockSM.listRunningSessions(),
      captureSessionOutput: (tmuxSession) => {
        // Return output for any session we've seen (even after kill, for synthesis)
        if (mockSM._aliveSet.has(tmuxSession) || createdSessions.has(tmuxSession)) {
          return SESSION_OUTPUT;
        }
        return null;
      },
    });

    // ── Start server with EVERYTHING wired ──

    const config: InstarConfig = {
      projectName: 'full-stack-test',
      agentName: 'Full Stack Agent',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      requestTimeoutMs: 10000,
      version: '0.10.2',
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
      semanticMemory,
      topicMemory,
      workingMemory,
      activitySentinel,
    });

    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    semanticMemory?.close();
    topicMemory?.close();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}`, Connection: 'close' });

  // ══════════════════════════════════════════════════════════════════
  // Phase 1: ALL subsystems alive simultaneously
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 1: All subsystems alive', () => {
    it('semantic memory stats returns 200', async () => {
      const res = await request(app).get('/semantic/stats').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.totalEntities).toBeDefined();
    });

    it('episodic memory stats returns 200', async () => {
      const res = await request(app).get('/episodes/stats').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.totalDigests).toBeDefined();
    });

    it('topic memory stats returns 200', async () => {
      const res = await request(app).get('/topic/stats').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.totalMessages).toBeDefined();
    });

    it('working memory returns 200', async () => {
      const res = await request(app)
        .get('/context/working-memory')
        .set(auth())
        .query({ prompt: 'test' });
      expect(res.status).toBe(200);
      expect(res.body.context).toBeDefined();
    });

    it('memory export returns 200', async () => {
      const res = await request(app)
        .post('/semantic/export-memory')
        .set(auth())
        .send({});
      expect(res.status).toBe(200);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 2: Seed data across ALL layers
  // ══════════════════════════════════════════════════════════════════

  let authEntityId: string;
  let justinEntityId: string;
  let spawnedSession: Session;

  describe('Phase 2: Cross-layer data seeding', () => {
    it('seeds semantic entities (knowledge layer)', async () => {
      const now = new Date().toISOString();

      // Technical knowledge
      const authRes = await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'pattern',
          name: 'JWT Authentication',
          content: 'API uses JSON Web Tokens with RS256 signing. Refresh tokens stored in HttpOnly cookies. Token rotation implemented with atomic DB writes.',
          confidence: 0.92,
          source: 'full-stack-test',
          domain: 'backend',
          tags: ['auth', 'jwt', 'security'],
        });
      expect(authRes.status).toBe(200);
      authEntityId = authRes.body.id;

      const dbRes = await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'fact',
          name: 'PostgreSQL Configuration',
          content: 'Production database is PostgreSQL on Xata cloud. Connection pooling enabled. Always use migrations, never db push.',
          confidence: 0.95,
          source: 'full-stack-test',
          domain: 'infrastructure',
          tags: ['database', 'postgresql'],
        });
      expect(dbRes.status).toBe(200);

      // Person entity
      const justinRes = await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'person',
          name: 'Justin Headley',
          content: 'Founder and primary collaborator. Sets technical and strategic direction. Prefers Telegram for quick messages.',
          confidence: 0.99,
          source: 'full-stack-test',
          domain: 'relationships',
          tags: ['founder', 'collaborator'],
        });
      expect(justinRes.status).toBe(200);
      justinEntityId = justinRes.body.id;

      // Lesson (different decay rate)
      await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'lesson',
          name: 'Silent Catch Blocks',
          content: 'Silent catch blocks are the #1 debugging suspect. They swallow errors and make the system appear healthy when it is not.',
          confidence: 0.88,
          source: 'full-stack-test',
          domain: 'development',
          tags: ['debugging', 'anti-pattern'],
        });

      // Decision
      await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'decision',
          name: 'SQLite for Semantic Memory',
          content: 'Chose SQLite over PostgreSQL extension for semantic memory to maintain file-based portability promise.',
          confidence: 0.95,
          source: 'full-stack-test',
          domain: 'architecture',
          tags: ['architecture', 'storage'],
        });

      const stats = await request(app).get('/semantic/stats').set(auth());
      expect(stats.body.totalEntities).toBe(5);
    });

    it('seeds topic history (conversation layer)', () => {
      // Simulate a realistic conversation
      const baseTime = Date.now() - 3600000; // 1 hour ago
      const messages = [
        { messageId: 1, topicId: 100, text: 'Justin: Can you implement JWT token rotation?', fromUser: true, timestamp: new Date(baseTime).toISOString() },
        { messageId: 2, topicId: 100, text: 'Agent: Yes, I will implement refresh token rotation with atomic DB writes to prevent race conditions.', fromUser: false, timestamp: new Date(baseTime + 60000).toISOString() },
        { messageId: 3, topicId: 100, text: 'Justin: Make sure to handle the case where the old token is still valid during rotation.', fromUser: true, timestamp: new Date(baseTime + 120000).toISOString() },
        { messageId: 4, topicId: 100, text: 'Agent: Good point. I will use a grace period of 30 seconds where both old and new tokens are valid.', fromUser: false, timestamp: new Date(baseTime + 180000).toISOString() },
        { messageId: 5, topicId: 200, text: 'Justin: How is the database migration going?', fromUser: true, timestamp: new Date(baseTime + 240000).toISOString() },
        { messageId: 6, topicId: 200, text: 'Agent: PostgreSQL migration is complete. All tables migrated with zero downtime.', fromUser: false, timestamp: new Date(baseTime + 300000).toISOString() },
      ];

      for (const msg of messages) {
        topicMemory.insertMessage({
          ...msg,
          sessionName: msg.fromUser ? null : 'auth-session',
        });
      }

      const stats = topicMemory.stats();
      expect(stats.totalMessages).toBe(6);
      expect(stats.totalTopics).toBe(2);
    });

    it('generates episodic digests (activity layer)', async () => {
      // Spawn a session
      spawnedSession = await mockSM.spawnSession({
        name: 'auth-builder',
        prompt: 'Implement JWT token rotation',
        jobSlug: 'auth-build',
      });
      // Track for captureSessionOutput persistence
      createdSessions.add(spawnedSession.tmuxSession);

      // Trigger scan to create digests
      const res = await request(app).post('/episodes/scan').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.digestsCreated).toBeGreaterThanOrEqual(1);
    });

    it('creates entity relationships (graph layer)', async () => {
      // Connect Justin to the JWT pattern
      const res = await request(app)
        .post('/semantic/connect')
        .set(auth())
        .send({
          fromId: justinEntityId,
          toId: authEntityId,
          relation: 'knows_about',
          context: 'Justin requested JWT token rotation implementation',
        });
      expect(res.status).toBe(200);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 3: Working memory draws from ALL sources
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 3: Cross-layer working memory assembly', () => {
    it('assembles context from both semantic AND episodic sources', async () => {
      const res = await request(app)
        .get('/context/working-memory')
        .set(auth())
        .query({ prompt: 'JWT authentication token rotation' });

      expect(res.status).toBe(200);

      // Should include knowledge from SemanticMemory
      const sources = res.body.sources.map((s: any) => s.name);
      expect(sources).toContain('knowledge');

      // Should include recent activity from EpisodicMemory
      expect(sources).toContain('episodes');

      // Knowledge should contain our JWT entity
      expect(res.body.context).toContain('JWT');
    });

    it('person entities appear in working memory for people queries', async () => {
      const res = await request(app)
        .get('/context/working-memory')
        .set(auth())
        .query({ prompt: 'Justin collaborator founder' });

      expect(res.status).toBe(200);
      expect(res.body.context).toContain('Justin');
    });

    it('working memory respects total token budget', async () => {
      const res = await request(app)
        .get('/context/working-memory')
        .set(auth())
        .query({ prompt: 'authentication database migration security architecture' });

      expect(res.status).toBe(200);
      expect(res.body.estimatedTokens).toBeLessThanOrEqual(2000);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 4: Search works across creation paths
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 4: Cross-path search', () => {
    it('semantic search finds entities from API creation', async () => {
      const res = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'JWT authentication token' });

      expect(res.status).toBe(200);
      expect(res.body.results.length).toBeGreaterThan(0);
      expect(res.body.results[0].name).toBe('JWT Authentication');
    });

    it('topic search finds conversation messages', async () => {
      const res = await request(app)
        .get('/topic/search')
        .set(auth())
        .query({ q: 'token rotation' });

      expect(res.status).toBe(200);
      expect(res.body.results.length).toBeGreaterThan(0);
    });

    it('semantic search filters by type across mixed entities', async () => {
      const res = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'database postgresql security', types: 'fact' });

      expect(res.status).toBe(200);
      for (const r of res.body.results) {
        expect(r.type).toBe('fact');
      }
    });

    it('graph exploration traverses cross-entity edges', async () => {
      const res = await request(app)
        .get(`/semantic/explore/${justinEntityId}`)
        .set(auth())
        .query({ maxDepth: 1 });

      expect(res.status).toBe(200);
      const names = res.body.results.map((e: any) => e.name);
      expect(names).toContain('JWT Authentication');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 5: Export reflects the full knowledge graph
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 5: Full-graph export', () => {
    it('MEMORY.md export includes entities from all domains', async () => {
      const outPath = path.join(tmpDir, 'MEMORY.md');
      const res = await request(app)
        .post('/semantic/export-memory')
        .set(auth())
        .send({ filePath: outPath, agentName: 'Full Stack Agent' });

      expect(res.status).toBe(200);
      expect(res.body.entityCount).toBe(5);
      expect(fs.existsSync(outPath)).toBe(true);

      const content = fs.readFileSync(outPath, 'utf-8');
      expect(content).toContain('# Full Stack Agent Memory');
      expect(content).toContain('JWT Authentication');
      expect(content).toContain('PostgreSQL Configuration');
      expect(content).toContain('Justin Headley');
      expect(content).toContain('Silent Catch Blocks');
      expect(content).toContain('SQLite for Semantic Memory');
    });

    it('export has correct domain grouping for multi-domain data', async () => {
      const res = await request(app)
        .post('/semantic/export-memory')
        .set(auth())
        .send({});

      const md = res.body.markdown as string;
      expect(md).toContain('## Infrastructure');
      expect(md).toContain('## Backend');
      expect(md).toContain('## Development');
      expect(md).toContain('## Architecture');
      expect(md).toContain('## Relationships');
      expect(res.body.domainCount).toBeGreaterThanOrEqual(5);
    });

    it('JSON export includes entities AND edges', async () => {
      const res = await request(app)
        .get('/semantic/export')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.entities.length).toBe(5);
      expect(res.body.edges.length).toBeGreaterThanOrEqual(1);

      // Verify the Justin → JWT edge exists
      const knowsEdge = res.body.edges.find(
        (e: any) => e.relation === 'knows_about',
      );
      expect(knowsEdge).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 6: Cross-layer data consistency
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 6: Cross-layer consistency', () => {
    it('entity count is consistent across stats and export', async () => {
      const statsRes = await request(app).get('/semantic/stats').set(auth());
      const exportRes = await request(app).get('/semantic/export').set(auth());

      // Stats and export should agree on total count
      expect(statsRes.body.totalEntities).toBe(exportRes.body.entities.length);
      expect(statsRes.body.totalEntities).toBe(5);
    });

    it('episodic stats reflect the scan we ran', async () => {
      const res = await request(app).get('/episodes/stats').set(auth());
      expect(res.body.totalDigests).toBeGreaterThanOrEqual(1);
      expect(res.body.sessionCount).toBeGreaterThanOrEqual(1);
    });

    it('topic stats reflect inserted messages', async () => {
      const res = await request(app).get('/topic/stats').set(auth());
      expect(res.body.totalMessages).toBe(6);
      expect(res.body.totalTopics).toBe(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 7: Mutation propagation across layers
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 7: Mutation propagation', () => {
    it('adding a semantic entity makes it visible in working memory', async () => {
      // Add a new entity
      await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'tool',
          name: 'Redis Cache',
          content: 'Redis for session caching and rate limiting.',
          confidence: 0.9,
          source: 'full-stack-test',
          domain: 'infrastructure',
          tags: ['redis', 'caching'],
        });

      // Verify it appears in working memory
      const res = await request(app)
        .get('/context/working-memory')
        .set(auth())
        .query({ prompt: 'Redis caching session' });

      expect(res.status).toBe(200);
      expect(res.body.context).toContain('Redis');
    });

    it('adding a semantic entity makes it visible in export', async () => {
      const res = await request(app)
        .post('/semantic/export-memory')
        .set(auth())
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.entityCount).toBe(6);
      expect(res.body.markdown).toContain('Redis Cache');
    });

    it('forgetting an entity removes it from search and export', async () => {
      // Create and then forget
      const createRes = await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'fact',
          name: 'Ephemeral Fact XYZ123',
          content: 'This will be forgotten.',
          confidence: 0.5,
          source: 'full-stack-test',
          domain: 'development',
          tags: [],
        });

      const entityId = createRes.body.id;

      // Forget it
      await request(app)
        .delete(`/semantic/forget/${entityId}`)
        .set(auth());

      // Gone from search
      const searchRes = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'XYZ123' });
      expect(searchRes.body.results.length).toBe(0);

      // Gone from export
      const exportRes = await request(app)
        .post('/semantic/export-memory')
        .set(auth())
        .send({});
      expect(exportRes.body.markdown).not.toContain('XYZ123');

      // Gone from recall
      const recallRes = await request(app)
        .get(`/semantic/recall/${entityId}`)
        .set(auth());
      expect(recallRes.status).toBe(404);
    });

    it('verifying an entity updates confidence visible in export', async () => {
      // Verify Justin with higher confidence
      await request(app)
        .post(`/semantic/verify/${justinEntityId}`)
        .set(auth())
        .send({ confidence: 1.0 });

      // Check via recall
      const recallRes = await request(app)
        .get(`/semantic/recall/${justinEntityId}`)
        .set(auth());
      expect(recallRes.body.entity.confidence).toBeCloseTo(1.0, 1);
    });

    it('completing a session creates synthesis visible in episodic layer', async () => {
      // Kill the session
      mockSM.killSession(spawnedSession.id);

      // Synthesize — use a sentinel that can still capture output for the killed session
      const localSentinel = new SessionActivitySentinel({
        stateDir,
        intelligence: createMockIntelligence(),
        getActiveSessions: () => [],
        captureSessionOutput: (tmuxSession) => {
          // Return output for the killed session (synthesis needs final digest)
          if (createdSessions.has(tmuxSession)) {
            return 'Final session output for synthesis processing with enough content to partition.';
          }
          return null;
        },
      });

      const report = await localSentinel.synthesizeSession(spawnedSession);
      // Synthesis requires existing digests — which we created in Phase 2 scan
      expect(report.digestCount).toBeGreaterThanOrEqual(1);
      expect(report.synthesisCreated).toBe(true);

      // Verify synthesis is queryable
      const res = await request(app)
        .get(`/episodes/sessions/${spawnedSession.id}`)
        .set(auth());
      expect(res.status).toBe(200);
      expect(res.body.summary).toBeTruthy();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 8: Graceful degradation
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 8: Graceful degradation', () => {
    it('server without semantic memory returns 503 for semantic routes only', async () => {
      const bareServer = new AgentServer({
        config: {
          projectName: 'bare-test',
          agentName: 'Bare Agent',
          projectDir: tmpDir,
          stateDir,
          port: 0,
          authToken: AUTH_TOKEN,
        },
        sessionManager: mockSM as any,
        state: new StateManager(stateDir),
        // No semanticMemory, no topicMemory, no workingMemory
      });

      const bareApp = bareServer.getApp();

      // Semantic routes return 503
      const semanticRes = await request(bareApp)
        .get('/semantic/stats')
        .set(auth())
        .set('Connection', 'close');
      expect(semanticRes.status).toBe(503);

      // Export returns 503
      const exportRes = await request(bareApp)
        .post('/semantic/export-memory')
        .set(auth())
        .set('Connection', 'close')
        .send({});
      expect(exportRes.status).toBe(503);

      // Health still works
      const healthRes = await request(bareApp)
        .get('/health')
        .set('Connection', 'close');
      expect(healthRes.status).toBe(200);
    });

    it('working memory without episodic still returns knowledge', async () => {
      // Create a server with semantic but no episodic
      const partialWorkingMemory = new WorkingMemoryAssembler({
        semanticMemory,
        // No episodicMemory
      });

      const partialServer = new AgentServer({
        config: {
          projectName: 'partial-test',
          agentName: 'Partial Agent',
          projectDir: tmpDir,
          stateDir,
          port: 0,
          authToken: AUTH_TOKEN,
        },
        sessionManager: mockSM as any,
        state: new StateManager(stateDir),
        semanticMemory,
        workingMemory: partialWorkingMemory,
      });

      const partialApp = partialServer.getApp();

      const res = await request(partialApp)
        .get('/context/working-memory')
        .set(auth())
        .set('Connection', 'close')
        .query({ prompt: 'JWT authentication' });

      expect(res.status).toBe(200);
      // Knowledge should still be present
      expect(res.body.context).toContain('JWT');
      // Episodes source might be empty or absent
      const episodeSource = res.body.sources.find((s: any) => s.name === 'episodes');
      if (episodeSource) {
        expect(episodeSource.count).toBe(0);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 9: Large dataset behavior
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 9: Large dataset behavior', () => {
    it('handles 100+ entities with stable search ranking', async () => {
      // Bulk insert 100 entities across domains
      const domains = ['infrastructure', 'backend', 'frontend', 'development', 'testing'];
      const types = ['fact', 'tool', 'pattern', 'lesson'] as const;

      for (let i = 0; i < 100; i++) {
        semanticMemory.remember({
          type: types[i % types.length],
          name: `Bulk Entity ${i}`,
          content: `This is bulk entity number ${i} about ${domains[i % domains.length]} topics.`,
          confidence: 0.5 + (i % 50) * 0.01, // 0.50 - 0.99
          lastVerified: new Date().toISOString(),
          source: 'bulk-test',
          domain: domains[i % domains.length],
          tags: [`bulk-${i}`, domains[i % domains.length]],
        });
      }

      // Verify stats reflect the bulk insert (6 existing + 100 bulk)
      const statsRes = await request(app).get('/semantic/stats').set(auth());
      expect(statsRes.body.totalEntities).toBe(106);

      // Search should still return relevant results (not overwhelmed)
      const searchRes = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'JWT authentication token', limit: 5 });

      expect(searchRes.status).toBe(200);
      // Our specific JWT entity should still rank highly
      expect(searchRes.body.results.length).toBeGreaterThan(0);
      expect(searchRes.body.results[0].name).toBe('JWT Authentication');
    });

    it('export handles 100+ entities without truncation', async () => {
      const res = await request(app)
        .post('/semantic/export-memory')
        .set(auth())
        .send({});

      expect(res.status).toBe(200);
      // Should include all entities above threshold
      expect(res.body.entityCount).toBeGreaterThanOrEqual(100);
      expect(res.body.domainCount).toBeGreaterThanOrEqual(5);
      expect(res.body.estimatedTokens).toBeGreaterThan(0);

      // Markdown structure should still be valid
      const lines = (res.body.markdown as string).split('\n');
      const h1Count = lines.filter((l: string) => l.startsWith('# ')).length;
      expect(h1Count).toBe(1); // Exactly one H1
    });

    it('working memory stays within token budget even with 100+ entities', async () => {
      const res = await request(app)
        .get('/context/working-memory')
        .set(auth())
        .query({ prompt: 'infrastructure backend authentication' });

      expect(res.status).toBe(200);
      expect(res.body.estimatedTokens).toBeLessThanOrEqual(2000);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 10: Concurrent read/write safety
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 10: Concurrent operations', () => {
    it('concurrent reads do not interfere with each other', async () => {
      // Fire 10 parallel reads across different subsystems
      const promises = [
        request(app).get('/semantic/stats').set(auth()),
        request(app).get('/semantic/search').set(auth()).query({ q: 'JWT' }),
        request(app).get('/semantic/search').set(auth()).query({ q: 'PostgreSQL' }),
        request(app).get('/episodes/stats').set(auth()),
        request(app).get('/topic/stats').set(auth()),
        request(app).get('/context/working-memory').set(auth()).query({ prompt: 'auth' }),
        request(app).get('/semantic/export').set(auth()),
        request(app).post('/semantic/export-memory').set(auth()).send({}),
        request(app).get('/topic/search').set(auth()).query({ q: 'rotation' }),
        request(app).get('/episodes/recent').set(auth()),
      ];

      const results = await Promise.all(promises);

      // ALL should succeed (no deadlocks, no corruption)
      for (const res of results) {
        expect(res.status).toBe(200);
      }
    });

    it('concurrent write + read is safe (WAL mode)', async () => {
      // Write while simultaneously reading
      const writePromise = request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'fact',
          name: 'Concurrent Write Test',
          content: 'Created during concurrent operation test.',
          confidence: 0.8,
          source: 'concurrent-test',
          domain: 'testing',
          tags: ['concurrent'],
        });

      const readPromise = request(app)
        .get('/semantic/stats')
        .set(auth());

      const [writeRes, readRes] = await Promise.all([writePromise, readPromise]);

      expect(writeRes.status).toBe(200);
      expect(readRes.status).toBe(200);
      // Both should complete without deadlock
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 11: Import/Export round-trip preserves full graph
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 11: Full graph round-trip', () => {
    it('export → import into fresh DB preserves entities and edges', async () => {
      // Export current state
      const exportRes = await request(app)
        .get('/semantic/export')
        .set(auth());

      expect(exportRes.status).toBe(200);
      const entityCount = exportRes.body.entities.length;
      const edgeCount = exportRes.body.edges.length;
      expect(entityCount).toBeGreaterThan(100);
      expect(edgeCount).toBeGreaterThanOrEqual(1);

      // Create a fresh SemanticMemory and import
      const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-import-'));
      const freshMemory = new SemanticMemory({
        dbPath: path.join(freshDir, 'fresh.db'),
        decayHalfLifeDays: 30,
        lessonDecayHalfLifeDays: 90,
        staleThreshold: 0.2,
      });
      await freshMemory.open();

      const importResult = freshMemory.import(exportRes.body);
      expect(importResult.entitiesImported).toBe(entityCount);
      expect(importResult.edgesImported).toBe(edgeCount);

      // Verify search works in the fresh DB
      const searchResults = freshMemory.search('JWT authentication');
      expect(searchResults.length).toBeGreaterThan(0);
      expect(searchResults[0].name).toBe('JWT Authentication');

      freshMemory.close();
      // safe-git-allow: incremental-migration
      fs.rmSync(freshDir, { recursive: true, force: true });
    });
  });
});
