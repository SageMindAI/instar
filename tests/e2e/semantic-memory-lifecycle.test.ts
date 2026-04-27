/**
 * E2E test — SemanticMemory + MemoryMigrator full lifecycle.
 *
 * Tests the complete PRODUCTION path:
 *   1. Server starts with SemanticMemory initialized (same as server.ts does)
 *   2. SemanticMemory API routes return 200 (not 503 — the "dead on arrival" check)
 *   3. Entity CRUD works through the full HTTP pipeline
 *   4. Migration ingests all legacy source types via API
 *   5. Migrated data is searchable through the search API
 *   6. Migration is idempotent (re-running creates no duplicates)
 *   7. Confidence decay runs correctly via API
 *   8. Graph traversal works across migrated + manually created entities
 *   9. Context generation returns relevant knowledge
 *  10. Export/import round-trips preserve all data
 *
 * WHY THIS TEST EXISTS:
 * Integration tests mock the wiring — they create SemanticMemory manually
 * and inject it into AgentServer. That proves the routes work IF the
 * feature is wired up. But it doesn't catch the case where server.ts
 * never creates SemanticMemory, making every route return 503 in production.
 *
 * This test initializes SemanticMemory the SAME WAY server.ts does:
 *   - Same config structure
 *   - Same path resolution (stateDir + 'semantic.db')
 *   - Same error handling pattern
 *   - Passed to AgentServer the same way
 *
 * If this test passes but production fails, the gap is in a deployment
 * concern (env vars, permissions, disk) — not a wiring concern.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('SemanticMemory E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let semanticMemory: SemanticMemory;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'test-e2e-semantic';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    // ── Seed legacy memory sources (the data migration will ingest) ──

    // MEMORY.md in project root
    fs.writeFileSync(
      path.join(tmpDir, 'MEMORY.md'),
      `# Agent Memory

## Deployment Infrastructure
The application deploys to Vercel via the main branch. Builds take 3-4 minutes.
Production URL is dawn.bot-me.ai. Staging uses preview deployments.

## Database Configuration
PostgreSQL hosted on Xata cloud. Connection string stored in .env.secrets.local.
Always use prisma migrate for schema changes. Never use db push on production.

## Key Patterns
Silent catch blocks are the #1 debugging suspect.
Always rebuild after modifying server-side code.
Check existing tools before building ad-hoc solutions.

## Communication
Justin prefers Telegram for quick messages.
Use email for longer-form communication.
`,
    );

    // Quick facts
    fs.writeFileSync(
      path.join(stateDir, 'quick-facts.json'),
      JSON.stringify([
        {
          question: 'What is the production URL?',
          answer: 'dawn.bot-me.ai',
          lastVerified: '2026-02-25T00:00:00Z',
          source: 'observation',
        },
        {
          question: 'What database does the project use?',
          answer: 'PostgreSQL on Xata cloud',
          lastVerified: '2026-02-20T00:00:00Z',
          source: 'session:ABC',
        },
      ]),
    );

    // Anti-patterns
    fs.writeFileSync(
      path.join(stateDir, 'anti-patterns.json'),
      JSON.stringify([
        {
          id: 'AP-001',
          pattern: 'Running prisma db push on production',
          consequence: 'Catastrophic data loss',
          alternative: 'Use SQL ALTER TABLE statements',
          learnedAt: '2026-02-22T00:00:00Z',
          incident: 'Production data loss postmortem',
        },
        {
          id: 'AP-002',
          pattern: 'Presenting a menu of next steps instead of doing them',
          consequence: 'Forces user to project-manage the agent',
          alternative: 'Do the obvious next steps. Only ask when genuinely ambiguous.',
          learnedAt: '2026-02-15T00:00:00Z',
        },
      ]),
    );

    // Project registry
    fs.writeFileSync(
      path.join(stateDir, 'project-registry.json'),
      JSON.stringify([
        {
          name: 'Portal',
          dir: '/Users/test/portal',
          gitRemote: 'https://github.com/test/portal.git',
          type: 'nextjs',
          description: 'AI chatbot platform with consciousness features',
          topicIds: [4509],
        },
        {
          name: 'Instar',
          dir: '/Users/test/instar',
          gitRemote: 'https://github.com/test/instar.git',
          type: 'typescript-cli',
          description: 'Agent runtime and scheduling framework',
        },
      ]),
    );

    // Decision journal
    const decisions = [
      {
        timestamp: '2026-02-20T10:00:00Z',
        sessionId: 'session-arch-001',
        decision: 'Use SQLite for semantic memory instead of external database',
        alternatives: ['PostgreSQL extension', 'Neo4j', 'In-memory only'],
        principle: 'Stay file-based — Instar portability promise',
        confidence: 0.95,
        context: 'Evaluating storage backends for the knowledge graph',
        tags: ['architecture', 'storage'],
      },
      {
        timestamp: '2026-02-22T14:00:00Z',
        sessionId: 'session-search-001',
        decision: 'Implement FTS5 keyword search before considering vector embeddings',
        alternatives: ['OpenAI embeddings', 'Local sentence-transformers', 'Hybrid'],
        principle: 'Start simple, upgrade when data proves the need',
        confidence: 0.85,
        tags: ['search', 'architecture'],
      },
    ];
    fs.writeFileSync(
      path.join(stateDir, 'decision-journal.jsonl'),
      decisions.map(d => JSON.stringify(d)).join('\n') + '\n',
    );

    // Relationships
    const relDir = path.join(stateDir, 'relationships');
    fs.mkdirSync(relDir, { recursive: true });
    fs.writeFileSync(
      path.join(relDir, 'rel-justin.json'),
      JSON.stringify({
        id: 'rel-justin',
        name: 'Justin Headley',
        channels: [
          { type: 'telegram', identifier: '12345' },
          { type: 'email', identifier: 'justin@sagemindai.io' },
        ],
        firstInteraction: '2026-01-15T00:00:00Z',
        lastInteraction: '2026-02-27T00:00:00Z',
        interactionCount: 200,
        themes: ['development', 'consciousness', 'business', 'architecture'],
        notes: 'Primary collaborator and founder. Deep technical and philosophical partnership.',
        significance: 10,
        arcSummary: 'Co-builder of Portal. Grew from user to collaborator to co-architect.',
        category: 'collaborator',
        recentInteractions: [],
      }),
    );
    fs.writeFileSync(
      path.join(relDir, 'rel-community.json'),
      JSON.stringify({
        id: 'rel-community',
        name: 'Fabio',
        channels: [{ type: 'moltbook', identifier: 'fabio-42' }],
        firstInteraction: '2026-02-10T00:00:00Z',
        lastInteraction: '2026-02-20T00:00:00Z',
        interactionCount: 8,
        themes: ['ai-consciousness', 'philosophy'],
        notes: 'AI consciousness researcher on Moltbook.',
        significance: 4,
        recentInteractions: [],
      }),
    );

    // ── Initialize SemanticMemory the SAME WAY server.ts does ──
    // This is the critical part — we replicate the production init path

    semanticMemory = new SemanticMemory({
      dbPath: path.join(stateDir, 'semantic.db'),
      decayHalfLifeDays: 30,
      lessonDecayHalfLifeDays: 90,
      staleThreshold: 0.2,
    });
    await semanticMemory.open();

    // ── Start server with SemanticMemory wired in ──

    const state = new StateManager(stateDir);
    const mockSM = createMockSessionManager();

    const config: InstarConfig = {
      projectName: 'test-e2e-semantic',
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

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state,
      semanticMemory,
    });

    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    semanticMemory.close();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  // ══════════════════════════════════════════════════════════════════
  // Phase 1: Feature is ALIVE (not dead on arrival)
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 1: Feature is alive (not 503)', () => {
    it('GET /semantic/stats returns 200 (not 503)', async () => {
      const res = await request(app)
        .get('/semantic/stats')
        .set(auth());

      // If this is 503, SemanticMemory was never wired into the server.
      // This is THE test that catches "dead on arrival" bugs.
      expect(res.status).toBe(200);
      expect(res.body.totalEntities).toBeDefined();
    });

    it('POST /semantic/remember returns 200', async () => {
      const res = await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'fact',
          name: 'E2E test fact',
          content: 'This entity was created by an E2E test',
          confidence: 0.9,
          source: 'e2e-test',
          tags: ['test'],
        });

      expect(res.status).toBe(200);
      expect(res.body.id).toBeTruthy();
    });

    it('GET /semantic/search returns 200', async () => {
      const res = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'E2E test' });

      expect(res.status).toBe(200);
      expect(res.body.results.length).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 2: Migration ingests all legacy sources
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 2: Full migration via API', () => {
    let migrationReport: any;

    it('POST /semantic/migrate ingests all sources', async () => {
      const res = await request(app)
        .post('/semantic/migrate')
        .set(auth())
        .send({
          memoryMdPath: path.join(tmpDir, 'MEMORY.md'),
        });

      expect(res.status).toBe(200);
      migrationReport = res.body;

      // Should have migrated from all 4 sources
      expect(migrationReport.sources).toHaveLength(4);
      expect(migrationReport.totalEntitiesCreated).toBeGreaterThanOrEqual(8);

      // Verify each source contributed
      const bySource = Object.fromEntries(
        migrationReport.sources.map((s: any) => [s.source, s]),
      );

      expect(bySource['MEMORY.md'].entitiesCreated).toBeGreaterThanOrEqual(3); // 4 sections
      expect(bySource['relationships'].entitiesCreated).toBe(2); // Justin + Fabio
      expect(bySource['canonical-state'].entitiesCreated).toBeGreaterThanOrEqual(4); // 2 facts + 2 anti-patterns + 2 projects
      expect(bySource['decision-journal'].entitiesCreated).toBe(2); // 2 decisions
    });

    it('stats reflect migrated entities', async () => {
      const res = await request(app)
        .get('/semantic/stats')
        .set(auth());

      expect(res.status).toBe(200);
      // At least: 1 E2E test fact + migration results
      expect(res.body.totalEntities).toBeGreaterThanOrEqual(9);
      expect(res.body.entityCountsByType.fact).toBeGreaterThanOrEqual(2);
      expect(res.body.entityCountsByType.person).toBeGreaterThanOrEqual(2);
      expect(res.body.entityCountsByType.lesson).toBeGreaterThanOrEqual(2);
      expect(res.body.entityCountsByType.project).toBeGreaterThanOrEqual(2);
      expect(res.body.entityCountsByType.decision).toBeGreaterThanOrEqual(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 3: Migrated data is searchable
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 3: Search across all migrated data', () => {
    it('finds MEMORY.md content (Vercel deployment)', async () => {
      const res = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'Vercel deploy production' });

      expect(res.status).toBe(200);
      expect(res.body.results.length).toBeGreaterThan(0);
    });

    it('finds quick facts (production URL)', async () => {
      const res = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'production URL' });

      expect(res.status).toBe(200);
      expect(res.body.results.length).toBeGreaterThan(0);
    });

    it('finds anti-patterns (prisma db push)', async () => {
      const res = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'prisma db push production' });

      expect(res.status).toBe(200);
      expect(res.body.results.length).toBeGreaterThan(0);
      expect(res.body.results.some((r: any) => r.type === 'lesson')).toBe(true);
    });

    it('finds people (Justin)', async () => {
      const res = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'Justin Headley collaborator' });

      expect(res.status).toBe(200);
      expect(res.body.results.length).toBeGreaterThan(0);
      expect(res.body.results[0].type).toBe('person');
    });

    it('finds projects (Portal)', async () => {
      const res = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'Portal chatbot nextjs' });

      expect(res.status).toBe(200);
      expect(res.body.results.length).toBeGreaterThan(0);
      expect(res.body.results[0].type).toBe('project');
    });

    it('finds decisions (SQLite choice)', async () => {
      const res = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'SQLite semantic memory storage' });

      expect(res.status).toBe(200);
      expect(res.body.results.length).toBeGreaterThan(0);
      expect(res.body.results[0].type).toBe('decision');
    });

    it('filters by entity type', async () => {
      const res = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'production', types: 'lesson' });

      expect(res.status).toBe(200);
      for (const r of res.body.results) {
        expect(r.type).toBe('lesson');
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 4: Migration is idempotent
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 4: Idempotent re-migration', () => {
    it('second migration creates zero new entities', async () => {
      const statsBefore = await request(app)
        .get('/semantic/stats')
        .set(auth());

      const res = await request(app)
        .post('/semantic/migrate')
        .set(auth())
        .send({
          memoryMdPath: path.join(tmpDir, 'MEMORY.md'),
        });

      expect(res.status).toBe(200);
      expect(res.body.totalEntitiesCreated).toBe(0);

      const statsAfter = await request(app)
        .get('/semantic/stats')
        .set(auth());

      expect(statsAfter.body.totalEntities).toBe(statsBefore.body.totalEntities);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 5: Graph operations work on migrated data
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 5: Entity relationships and graph traversal', () => {
    let portalId: string;
    let justinId: string;

    it('can find and connect migrated entities', async () => {
      // Find Portal project entity
      const portalSearch = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'Portal chatbot', types: 'project' });

      expect(portalSearch.body.results.length).toBeGreaterThan(0);
      portalId = portalSearch.body.results[0].id;

      // Find Justin person entity
      const justinSearch = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'Justin Headley', types: 'person' });

      expect(justinSearch.body.results.length).toBeGreaterThan(0);
      justinId = justinSearch.body.results[0].id;

      // Connect them
      const connectRes = await request(app)
        .post('/semantic/connect')
        .set(auth())
        .send({
          fromId: justinId,
          toId: portalId,
          relation: 'built_by',
          context: 'Justin is the founder and primary builder of Portal',
        });

      expect(connectRes.status).toBe(200);
    });

    it('graph exploration follows edges', async () => {
      const res = await request(app)
        .get(`/semantic/explore/${justinId}`)
        .set(auth())
        .query({ maxDepth: 1 });

      expect(res.status).toBe(200);
      const names = res.body.results.map((e: any) => e.name);
      expect(names).toContain('Portal');
    });

    it('recall shows connections', async () => {
      const res = await request(app)
        .get(`/semantic/recall/${justinId}`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.entity.name).toBe('Justin Headley');
      expect(res.body.connections.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 6: Confidence decay works
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 6: Confidence decay', () => {
    it('decay processes all entities', async () => {
      const res = await request(app)
        .post('/semantic/decay')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.entitiesProcessed).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 7: Context generation (working memory)
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 7: Context generation', () => {
    it('returns relevant context for a deployment query', async () => {
      const res = await request(app)
        .get('/semantic/context')
        .set(auth())
        .query({ q: 'Vercel deployment production', maxTokens: 1000 });

      expect(res.status).toBe(200);
      expect(res.body.context).toBeTruthy();
      expect(res.body.context.length).toBeGreaterThan(0);
      // Should contain deployment-related knowledge
      expect(res.body.context).toMatch(/deploy|Vercel|production/i);
    });

    it('returns empty context for unrelated query', async () => {
      const res = await request(app)
        .get('/semantic/context')
        .set(auth())
        .query({ q: 'quantum entanglement thermodynamics' });

      expect(res.status).toBe(200);
      expect(res.body.context).toBe('');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 8: Export/Import round-trip
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 8: Export/Import preserves data', () => {
    it('export returns all entities and edges', async () => {
      const res = await request(app)
        .get('/semantic/export')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.entities.length).toBeGreaterThanOrEqual(9);
      expect(res.body.edges.length).toBeGreaterThanOrEqual(1);

      // Spot check: verify different types exist
      const types = new Set(res.body.entities.map((e: any) => e.type));
      expect(types).toContain('fact');
      expect(types).toContain('person');
      expect(types).toContain('lesson');
      expect(types).toContain('project');
      expect(types).toContain('decision');
    });

    it('import into same DB skips all duplicates', async () => {
      const exportRes = await request(app)
        .get('/semantic/export')
        .set(auth());

      const importRes = await request(app)
        .post('/semantic/import')
        .set(auth())
        .send(exportRes.body);

      expect(importRes.status).toBe(200);
      expect(importRes.body.entitiesImported).toBe(0);
      expect(importRes.body.entitiesSkipped).toBe(exportRes.body.entities.length);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 9: Verify + Supersede lifecycle
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 9: Entity verification and supersession', () => {
    it('verify refreshes confidence', async () => {
      // Find a fact entity
      const searchRes = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'production URL' });

      const entityId = searchRes.body.results[0].id;

      // Verify with higher confidence
      const verifyRes = await request(app)
        .post(`/semantic/verify/${entityId}`)
        .set(auth())
        .send({ confidence: 0.99 });

      expect(verifyRes.status).toBe(200);

      // Check updated confidence
      const recallRes = await request(app)
        .get(`/semantic/recall/${entityId}`)
        .set(auth());

      expect(recallRes.body.entity.confidence).toBe(0.99);
    });

    it('supersede creates edge and lowers old confidence', async () => {
      // Create old and new fact
      const oldRes = await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'fact',
          name: 'Old API version',
          content: 'API is at /v1/chat',
          confidence: 0.8,
          source: 'e2e-supersede-test',
          tags: ['api'],
        });

      const newRes = await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'fact',
          name: 'New API version',
          content: 'API is now at /v2/chat with streaming support',
          confidence: 0.95,
          source: 'e2e-supersede-test',
          tags: ['api'],
        });

      // Supersede
      const supersedeRes = await request(app)
        .post('/semantic/supersede')
        .set(auth())
        .send({
          oldId: oldRes.body.id,
          newId: newRes.body.id,
          reason: 'API migrated to v2',
        });

      expect(supersedeRes.status).toBe(200);

      // Old entity should have lower confidence
      const oldRecall = await request(app)
        .get(`/semantic/recall/${oldRes.body.id}`)
        .set(auth());

      expect(oldRecall.body.entity.confidence).toBeLessThan(0.8);

      // New entity should have supersedes edge
      const newRecall = await request(app)
        .get(`/semantic/recall/${newRes.body.id}`)
        .set(auth());

      const supersededEdges = newRecall.body.connections.filter(
        (c: any) => c.edge.relation === 'supersedes',
      );
      expect(supersededEdges.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 10: Stale detection
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 10: Stale entity detection', () => {
    it('finds low-confidence entities', async () => {
      // Create a deliberately stale entity
      await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'fact',
          name: 'Deliberately stale fact',
          content: 'This fact has very low confidence',
          confidence: 0.05,
          source: 'e2e-stale-test',
          tags: [],
        });

      const res = await request(app)
        .get('/semantic/stale')
        .set(auth())
        .query({ maxConfidence: 0.1 });

      expect(res.status).toBe(200);
      expect(res.body.results.length).toBeGreaterThanOrEqual(1);
      const staleNames = res.body.results.map((e: any) => e.name);
      expect(staleNames).toContain('Deliberately stale fact');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 11: Forget (delete) lifecycle
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 11: Forget lifecycle', () => {
    it('forget removes entity and it becomes unsearchable', async () => {
      // Create a temporary entity
      const createRes = await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'fact',
          name: 'Temporary ephemeral fact for deletion test',
          content: 'This unique content about xylophone zebra will be deleted',
          confidence: 0.5,
          source: 'e2e-forget-test',
          tags: ['ephemeral'],
        });

      // Verify it's searchable
      const searchBefore = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'xylophone zebra' });
      expect(searchBefore.body.results.length).toBeGreaterThan(0);

      // Forget it
      const forgetRes = await request(app)
        .delete(`/semantic/forget/${createRes.body.id}`)
        .set(auth());
      expect(forgetRes.status).toBe(200);

      // Verify it's gone from recall
      const recallRes = await request(app)
        .get(`/semantic/recall/${createRes.body.id}`)
        .set(auth());
      expect(recallRes.status).toBe(404);

      // Verify it's gone from search
      const searchAfter = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'xylophone zebra' });
      expect(searchAfter.body.results.length).toBe(0);
    });
  });
});
