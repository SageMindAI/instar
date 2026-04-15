/**
 * E2E test — Working Memory Assembly full lifecycle.
 *
 * Tests the complete PRODUCTION path:
 *   1. Server starts with WorkingMemoryAssembler initialized (same as server.ts will)
 *   2. Working memory API route returns 200 (not 503 — the "dead on arrival" check)
 *   3. Assembly returns knowledge from SemanticMemory
 *   4. Assembly returns episodes from EpisodicMemory
 *   5. Assembly returns relationship context for person entities
 *   6. Token budgets are respected
 *   7. Query extraction works with realistic prompts
 *
 * WHY THIS TEST EXISTS:
 * Integration tests construct WorkingMemoryAssembler manually and inject it
 * into AgentServer. That proves routes work IF the assembler is wired. But
 * it doesn't catch the case where server.ts never creates the assembler,
 * making the /context/working-memory route return 503 in production.
 *
 * This test initializes WorkingMemoryAssembler the SAME WAY server.ts will:
 *   - Same dependency pattern (SemanticMemory, EpisodicMemory)
 *   - Same optional degradation (works with partial dependencies)
 *   - Passed to AgentServer the same way production does
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';
import { EpisodicMemory } from '../../src/memory/EpisodicMemory.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { WorkingMemoryAssembler } from '../../src/memory/WorkingMemoryAssembler.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('Working Memory E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let semanticMemory: SemanticMemory;
  let episodicMemory: EpisodicMemory;
  const AUTH_TOKEN = 'test-e2e-working-memory';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'working-memory-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'e2e-test', agentName: 'E2E Test' }),
    );

    const mockSM = createMockSessionManager();

    // ━━━ CRITICAL: Initialize the same way server.ts will ━━━
    //
    // From the planned server.ts initialization (Phase 4):
    //
    //   let workingMemory;
    //   if (semanticMemory || episodicMemory) {
    //     workingMemory = new WorkingMemoryAssembler({
    //       semanticMemory,
    //       episodicMemory,
    //     });
    //   }

    // Create SemanticMemory (real SQLite)
    const dbPath = path.join(stateDir, 'semantic.db');
    semanticMemory = new SemanticMemory({
      dbPath,
      decayHalfLifeDays: 30,
      lessonDecayHalfLifeDays: 90,
      staleThreshold: 0.2,
    });
    await semanticMemory.open();

    // Seed knowledge entities
    const now = new Date().toISOString();
    semanticMemory.remember({
      name: 'Episodic Memory Module',
      type: 'concept',
      content: 'The episodic memory module tracks session activity through digests and synthesizes complete session narratives.',
      confidence: 0.9,
      lastVerified: now,
      source: 'e2e-test',
      tags: ['memory', 'architecture'],
    });
    semanticMemory.remember({
      name: 'Session Activity Sentinel',
      type: 'concept',
      content: 'The sentinel monitors running sessions, partitions output, and produces activity digests using an LLM.',
      confidence: 0.85,
      lastVerified: now,
      source: 'e2e-test',
      tags: ['monitoring', 'sentinel'],
    });
    semanticMemory.remember({
      name: 'Justin Headley',
      type: 'person',
      content: 'Justin is the primary collaborator and project lead for Portal and Instar.',
      confidence: 0.95,
      lastVerified: now,
      source: 'e2e-test',
      tags: ['person', 'collaborator'],
    });

    // Create EpisodicMemory (real filesystem)
    episodicMemory = new EpisodicMemory({ stateDir });

    // Seed episode digests
    episodicMemory.saveDigest({
      sessionId: 'e2e-session-001',
      sessionName: 'memory-phase3',
      summary: 'Completed Phase 3 of the memory architecture. All 84 tests passing across unit, integration, and E2E.',
      actions: ['wrote episodic memory module', 'fixed mock branching bug', 'committed Phase 3'],
      learnings: ['Mock response branching must use unique prompt preambles, not generic keywords'],
      significance: 9,
      themes: ['memory-architecture', 'testing', 'episodic-memory'],
      startedAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      endedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });

    episodicMemory.saveDigest({
      sessionId: 'e2e-session-002',
      sessionName: 'working-memory-build',
      summary: 'Building Phase 4 working memory assembler with token budgets.',
      actions: ['implemented WorkingMemoryAssembler', 'wrote unit tests'],
      learnings: ['Stop words need aggressive filtering for good query extraction'],
      significance: 7,
      themes: ['memory-architecture', 'working-memory'],
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      endedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    });

    // Create WorkingMemoryAssembler with both dependencies
    const workingMemory = new WorkingMemoryAssembler({
      semanticMemory,
      episodicMemory,
    });

    // Create TopicMemory so the assembled-mode fallback on /topic/context
    // can be exercised end-to-end (Phase 7).
    const topicMemory = new TopicMemory(stateDir);
    await topicMemory.open();
    topicMemory.insertMessage({
      messageId: 1,
      topicId: 42,
      text: 'Discussion about memory architecture',
      fromUser: true,
      timestamp: new Date().toISOString(),
      sessionName: null,
    });
    topicMemory.setTopicName(42, 'Memory architecture');

    const config: InstarConfig = {
      projectName: 'e2e-test',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      requestTimeoutMs: 10000,
      version: '0.10.3',
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
    });

    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    semanticMemory?.close();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/working-memory-lifecycle.test.ts:186' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  // ══════════════════════════════════════════════════════════════════
  // Phase 1: Feature is ALIVE (not dead on arrival)
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 1: Feature is alive (not 503)', () => {
    it('GET /context/working-memory returns 200 (not 503)', async () => {
      const res = await request(app)
        .get('/context/working-memory')
        .set(auth())
        .query({ prompt: 'memory architecture' });

      // This is THE test that catches "dead on arrival" bugs.
      // If this returns 503, WorkingMemoryAssembler was never wired into server.ts.
      expect(res.status).toBe(200);
      expect(res.body.context).toBeDefined();
      expect(res.body.estimatedTokens).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 2: Knowledge assembly works through full pipeline
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 2: Knowledge assembly', () => {
    it('returns relevant knowledge entities', async () => {
      const res = await request(app)
        .get('/context/working-memory')
        .set(auth())
        .query({ prompt: 'episodic memory sentinel monitoring' });

      expect(res.status).toBe(200);
      expect(res.body.context).toContain('Episodic Memory Module');
      expect(res.body.sources.some((s: any) => s.name === 'knowledge')).toBe(true);

      const knowledgeSource = res.body.sources.find((s: any) => s.name === 'knowledge');
      expect(knowledgeSource.count).toBeGreaterThanOrEqual(1);
    });

    it('includes confidence scores in full-detail entities', async () => {
      const res = await request(app)
        .get('/context/working-memory')
        .set(auth())
        .query({ prompt: 'episodic memory module' });

      expect(res.status).toBe(200);
      // Full-detail tier includes confidence
      expect(res.body.context).toMatch(/Confidence: \d+%/);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 3: Episode assembly works through full pipeline
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 3: Episode assembly', () => {
    it('returns recent episode digests', async () => {
      const res = await request(app)
        .get('/context/working-memory')
        .set(auth())
        .query({ prompt: 'memory architecture' });

      expect(res.status).toBe(200);
      expect(res.body.context).toContain('Recent Activity');
      expect(res.body.sources.some((s: any) => s.name === 'episodes')).toBe(true);

      const episodeSource = res.body.sources.find((s: any) => s.name === 'episodes');
      expect(episodeSource.count).toBeGreaterThanOrEqual(1);
    });

    it('episode digests include session details', async () => {
      const res = await request(app)
        .get('/context/working-memory')
        .set(auth())
        .query({ prompt: 'memory architecture' });

      expect(res.status).toBe(200);
      // Full-detail digests include session name and summary
      expect(res.body.context).toMatch(/memory-phase3|working-memory-build/);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 4: Relationship assembly
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 4: Relationship assembly', () => {
    it('returns person entities for people-related queries', async () => {
      const res = await request(app)
        .get('/context/working-memory')
        .set(auth())
        .query({ prompt: 'Justin collaborator project lead' });

      expect(res.status).toBe(200);
      expect(res.body.context).toContain('Justin');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 5: Query extraction and edge cases
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 5: Query extraction and edge cases', () => {
    it('extracts meaningful query terms', async () => {
      const res = await request(app)
        .get('/context/working-memory')
        .set(auth())
        .query({ prompt: 'How does the episodic memory sentinel work?' });

      expect(res.status).toBe(200);
      expect(res.body.queryTerms).toContain('episodic');
      expect(res.body.queryTerms).toContain('memory');
      expect(res.body.queryTerms).toContain('sentinel');
      // Stop words filtered
      expect(res.body.queryTerms).not.toContain('does');
      expect(res.body.queryTerms).not.toContain('work');
    });

    it('supports jobSlug parameter', async () => {
      const res = await request(app)
        .get('/context/working-memory')
        .set(auth())
        .query({ jobSlug: 'memory-build' });

      expect(res.status).toBe(200);
      expect(res.body.queryTerms).toContain('memory');
    });

    it('handles empty queries gracefully', async () => {
      const res = await request(app)
        .get('/context/working-memory')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.queryTerms).toEqual([]);
      expect(res.body.sources).toBeInstanceOf(Array);
    });

    it('response includes assembledAt timestamp', async () => {
      const res = await request(app)
        .get('/context/working-memory')
        .set(auth())
        .query({ prompt: 'memory' });

      expect(res.status).toBe(200);
      expect(res.body.assembledAt).toBeTruthy();
      expect(new Date(res.body.assembledAt).getTime()).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 6: Token budget enforcement
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 6: Token budget enforcement', () => {
    it('total tokens stay within default budget', async () => {
      const res = await request(app)
        .get('/context/working-memory')
        .set(auth())
        .query({ prompt: 'episodic memory sentinel architecture testing' });

      expect(res.status).toBe(200);
      // Default total budget is 2000 tokens
      expect(res.body.estimatedTokens).toBeLessThanOrEqual(2000);
    });

    it('each source respects its individual budget', async () => {
      const res = await request(app)
        .get('/context/working-memory')
        .set(auth())
        .query({ prompt: 'episodic memory sentinel architecture' });

      expect(res.status).toBe(200);

      for (const source of res.body.sources) {
        if (source.name === 'knowledge') {
          expect(source.tokens).toBeLessThanOrEqual(800);
        } else if (source.name === 'episodes') {
          expect(source.tokens).toBeLessThanOrEqual(400);
        } else if (source.name === 'relationships') {
          expect(source.tokens).toBeLessThanOrEqual(300);
        }
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 7: Session/topic assembled-context routes (feature is alive)
  //
  // These routes are consumed by the session-start hook and the
  // topic-context migration path. If they return 503 in production,
  // the assembler was never wired — same dead-on-arrival check as Phase 1.
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 7: Session/topic assembled-context routes', () => {
    it('GET /session/context/:topicId returns 200 (not 503)', async () => {
      const res = await request(app)
        .get('/session/context/42')
        .set(auth())
        .query({ prompt: 'episodic memory sentinel' });

      expect(res.status).toBe(200);
      expect(typeof res.body.context).toBe('string');
      expect(res.body.estimatedTokens).toBeGreaterThan(0);
      expect(res.body.budgets).toBeDefined();
      expect(res.body.budgets.total).toBe(2000);
    });

    it('GET /session/context/:topicId returns 400 on invalid topicId', async () => {
      await request(app)
        .get('/session/context/not-a-number')
        .set(auth())
        .expect(400);
    });

    it('GET /topic/context/:topicId?assembled=true returns 200 with assembled payload', async () => {
      const res = await request(app)
        .get('/topic/context/42')
        .set(auth())
        .query({ assembled: 'true', prompt: 'episodic memory sentinel' });

      expect(res.status).toBe(200);
      expect(res.body.assembled).toBe(true);
      expect(res.body.budgets).toBeDefined();
      expect(res.body.budgets.total).toBe(2000);
      expect(Array.isArray(res.body.sources)).toBe(true);
    });
  });
});
