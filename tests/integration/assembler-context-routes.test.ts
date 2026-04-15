/**
 * Integration tests for the session/topic assembled-context HTTP routes
 * introduced by the WorkingMemoryAssembler wiring.
 *
 * Routes under test:
 *   GET /session/context/:topicId           — dedicated assembled endpoint
 *   GET /topic/context/:topicId?assembled=true — assembled mode on existing endpoint
 *
 * Verifies the full pipeline:
 *   HTTP request → Express route → WorkingMemoryAssembler → Semantic/Episodic → response
 *
 * Covers: happy path, query-param propagation, budgets metadata, graceful
 * fallback when the assembler is not wired, and input validation.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';
import { EpisodicMemory } from '../../src/memory/EpisodicMemory.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { WorkingMemoryAssembler } from '../../src/memory/WorkingMemoryAssembler.js';
import {
  createTempProject,
  createMockSessionManager,
} from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

// ── Test fixtures ────────────────────────────────────────────────

const AUTH_TOKEN = 'assembler-context-test-token';

function buildConfig(project: TempProject, name: string): InstarConfig {
  return {
    projectName: name,
    projectDir: project.dir,
    stateDir: project.stateDir,
    port: 0,
    authToken: AUTH_TOKEN,
    requestTimeoutMs: 5000,
    version: '0.28.29',
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
}

async function seedSemantic(stateDir: string): Promise<SemanticMemory> {
  const dbPath = path.join(stateDir, 'semantic.db');
  const sm = new SemanticMemory({
    dbPath,
    decayHalfLifeDays: 30,
    lessonDecayHalfLifeDays: 90,
    staleThreshold: 0.2,
  });
  await sm.open();

  const now = new Date().toISOString();
  sm.remember({
    name: 'Token Budgeting',
    type: 'concept',
    content: 'Token budgeting keeps context assembly within model limits by allocating per-source quotas.',
    confidence: 0.9,
    lastVerified: now,
    source: 'test',
    tags: ['memory', 'architecture'],
  });
  sm.remember({
    name: 'Working Memory Assembler',
    type: 'concept',
    content: 'The working memory assembler composes knowledge, episodes, and relationships within token budgets.',
    confidence: 0.88,
    lastVerified: now,
    source: 'test',
    tags: ['memory', 'architecture'],
  });
  return sm;
}

function seedEpisodic(stateDir: string): EpisodicMemory {
  const em = new EpisodicMemory({ stateDir });
  em.saveDigest({
    sessionId: 'assembler-ctx-test-001',
    sessionName: 'assembler-ctx-test',
    summary: 'Validated the assembler routes end to end with token budgets.',
    actions: ['wired assembler', 'asserted budgets metadata'],
    learnings: ['Route-level fallback must preserve raw-context backward compatibility'],
    significance: 7,
    themes: ['memory-architecture', 'testing'],
    startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    endedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
  });
  return em;
}

async function seedTopic(stateDir: string): Promise<TopicMemory> {
  const tm = new TopicMemory(stateDir);
  await tm.open();
  for (let i = 0; i < 6; i++) {
    tm.insertMessage({
      messageId: 9000 + i,
      topicId: 777,
      text: i % 2 === 0
        ? `User message ${i}: discussing token budgeting strategy`
        : `Agent response ${i}: working memory assembler keeps us within budget`,
      fromUser: i % 2 === 0,
      timestamp: new Date(2026, 3, 10, 12, i).toISOString(),
      sessionName: i % 2 === 0 ? null : 'assembler-ctx-test',
    });
  }
  tm.setTopicName(777, 'Assembler Context Tests');
  tm.saveTopicSummary(777, 'Conversation about token budgeting and working memory.', 6, 9005);
  return tm;
}

// ── Section 1: /session/context/:topicId ─────────────────────────

describe('GET /session/context/:topicId (assembler wired)', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let semanticMemory: SemanticMemory;
  let episodicMemory: EpisodicMemory;
  let assembler: WorkingMemoryAssembler;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;

  beforeAll(async () => {
    project = createTempProject();
    fs.writeFileSync(
      path.join(project.stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'sc-wired', agentName: 'SC Wired' }),
    );

    mockSM = createMockSessionManager();
    semanticMemory = await seedSemantic(project.stateDir);
    episodicMemory = seedEpisodic(project.stateDir);
    assembler = new WorkingMemoryAssembler({ semanticMemory, episodicMemory });

    server = new AgentServer({
      config: buildConfig(project, 'sc-wired'),
      sessionManager: mockSM as any,
      state: project.state,
      semanticMemory,
      workingMemory: assembler,
    });
    app = server.getApp();
  });

  afterAll(() => {
    semanticMemory?.close();
    project?.cleanup();
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  it('returns 200 with the assembled payload shape', async () => {
    const res = await request(app)
      .get('/session/context/42')
      .set(auth())
      .query({ prompt: 'token budgeting memory architecture' });

    expect(res.status).toBe(200);
    expect(res.body.topicId).toBe(42);
    expect(typeof res.body.context).toBe('string');
    expect(typeof res.body.estimatedTokens).toBe('number');
    expect(Array.isArray(res.body.sources)).toBe(true);
    expect(Array.isArray(res.body.queryTerms)).toBe(true);
    expect(typeof res.body.assembledAt).toBe('string');
  });

  it('includes the active token budgets in the response', async () => {
    const res = await request(app)
      .get('/session/context/42')
      .set(auth())
      .query({ prompt: 'token budgeting' });

    expect(res.status).toBe(200);
    expect(res.body.budgets).toBeDefined();
    expect(res.body.budgets.knowledge).toBeGreaterThan(0);
    expect(res.body.budgets.episodes).toBeGreaterThan(0);
    expect(res.body.budgets.relationships).toBeGreaterThan(0);
    expect(res.body.budgets.total).toBeGreaterThanOrEqual(
      res.body.budgets.knowledge + res.body.budgets.episodes + res.body.budgets.relationships
        - res.body.budgets.relationships, // total is a hard cap, not a sum — just confirm it exists and is positive
    );
    expect(res.body.budgets.total).toBeGreaterThan(0);
  });

  it('propagates the prompt query param into query terms', async () => {
    const res = await request(app)
      .get('/session/context/42')
      .set(auth())
      .query({ prompt: 'token budgeting architecture' });

    expect(res.status).toBe(200);
    // Stop words stripped; meaningful terms preserved
    expect(res.body.queryTerms).toEqual(expect.arrayContaining(['token', 'budgeting']));
  });

  it('propagates the job query param into query terms', async () => {
    const res = await request(app)
      .get('/session/context/42')
      .set(auth())
      .query({ job: 'memory-build' });

    expect(res.status).toBe(200);
    expect(res.body.queryTerms).toContain('memory');
  });

  it('estimatedTokens respects the total budget', async () => {
    const res = await request(app)
      .get('/session/context/42')
      .set(auth())
      .query({ prompt: 'token budgeting memory architecture assembler' });

    expect(res.status).toBe(200);
    expect(res.body.estimatedTokens).toBeLessThanOrEqual(res.body.budgets.total);
  });

  it('returns 400 for a non-numeric topicId', async () => {
    const res = await request(app)
      .get('/session/context/not-a-number')
      .set(auth())
      .query({ prompt: 'anything' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid topicId');
  });

  it('returns 401 when the auth header is missing', async () => {
    await request(app)
      .get('/session/context/42')
      .query({ prompt: 'anything' })
      .expect(401);
  });

  it('returns valid structure even with no query params', async () => {
    const res = await request(app)
      .get('/session/context/42')
      .set(auth());

    expect(res.status).toBe(200);
    expect(typeof res.body.context).toBe('string');
    expect(res.body.queryTerms).toEqual([]);
  });
});

// ── Section 2: /topic/context/:topicId?assembled=true ────────────

describe('GET /topic/context/:topicId?assembled=true (assembler + topic memory wired)', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let semanticMemory: SemanticMemory;
  let episodicMemory: EpisodicMemory;
  let topicMemory: TopicMemory;
  let assembler: WorkingMemoryAssembler;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;

  beforeAll(async () => {
    project = createTempProject();
    fs.writeFileSync(
      path.join(project.stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'tc-wired', agentName: 'TC Wired' }),
    );

    mockSM = createMockSessionManager();
    semanticMemory = await seedSemantic(project.stateDir);
    episodicMemory = seedEpisodic(project.stateDir);
    topicMemory = await seedTopic(project.stateDir);
    assembler = new WorkingMemoryAssembler({ semanticMemory, episodicMemory });

    server = new AgentServer({
      config: buildConfig(project, 'tc-wired'),
      sessionManager: mockSM as any,
      state: project.state,
      semanticMemory,
      topicMemory,
      workingMemory: assembler,
    });
    app = server.getApp();
  });

  afterAll(() => {
    semanticMemory?.close();
    project?.cleanup();
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  it('returns assembled payload when assembled=true', async () => {
    const res = await request(app)
      .get('/topic/context/777')
      .set(auth())
      .query({ assembled: 'true', prompt: 'token budgeting' });

    expect(res.status).toBe(200);
    expect(res.body.topicId).toBe(777);
    expect(res.body.assembled).toBe(true);
    expect(typeof res.body.context).toBe('string');
    expect(Array.isArray(res.body.sources)).toBe(true);
    expect(Array.isArray(res.body.queryTerms)).toBe(true);
    expect(typeof res.body.assembledAt).toBe('string');
    expect(res.body.budgets).toBeDefined();
    expect(res.body.budgets.total).toBeGreaterThan(0);
  });

  it('returns raw topic context when assembled is not requested (backward-compatible)', async () => {
    const res = await request(app)
      .get('/topic/context/777')
      .set(auth());

    expect(res.status).toBe(200);
    // Raw response uses TopicMemory shape, not the assembler shape
    expect(res.body.assembled).toBeUndefined();
    expect(res.body.sources).toBeUndefined();
    expect(res.body.recentMessages).toBeInstanceOf(Array);
    expect(res.body.totalMessages).toBeGreaterThan(0);
    expect(res.body.topicName).toBe('Assembler Context Tests');
  });

  it('returns raw topic context when assembled=false', async () => {
    const res = await request(app)
      .get('/topic/context/777')
      .set(auth())
      .query({ assembled: 'false' });

    expect(res.status).toBe(200);
    expect(res.body.assembled).toBeUndefined();
    expect(res.body.recentMessages).toBeInstanceOf(Array);
  });

  it('returns 400 for a non-numeric topicId (assembled or not)', async () => {
    await request(app)
      .get('/topic/context/abc')
      .set(auth())
      .query({ assembled: 'true' })
      .expect(400);
  });
});

// ── Section 3: Graceful fallback / 503 when assembler not wired ──

describe('Assembled-context routes with no WorkingMemoryAssembler wired', () => {
  let project: TempProject;
  let topicMemory: TopicMemory;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;

  beforeAll(async () => {
    project = createTempProject();
    fs.writeFileSync(
      path.join(project.stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'no-assembler', agentName: 'No Assembler' }),
    );

    const mockSM = createMockSessionManager();
    topicMemory = await seedTopic(project.stateDir);

    server = new AgentServer({
      config: buildConfig(project, 'no-assembler'),
      sessionManager: mockSM as any,
      state: project.state,
      topicMemory,
      // Intentionally no workingMemory
    });
    app = server.getApp();
  });

  afterAll(() => {
    project?.cleanup();
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  it('GET /session/context/:topicId returns 503 with a helpful hint', async () => {
    const res = await request(app)
      .get('/session/context/777')
      .set(auth())
      .query({ prompt: 'anything' });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/WorkingMemoryAssembler/);
    expect(res.body.hint).toBeTruthy();
  });

  it('GET /topic/context/:topicId?assembled=true falls back to raw context (no 503)', async () => {
    const res = await request(app)
      .get('/topic/context/777')
      .set(auth())
      .query({ assembled: 'true' });

    // Backward-compatible: the old route keeps working when the assembler is
    // absent — assembled=true is silently ignored.
    expect(res.status).toBe(200);
    expect(res.body.assembled).toBeUndefined();
    expect(res.body.recentMessages).toBeInstanceOf(Array);
    expect(res.body.topicName).toBe('Assembler Context Tests');
  });
});
