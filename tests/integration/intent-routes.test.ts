/**
 * Integration tests for intent journal API routes.
 *
 * Tests the three endpoints:
 * - GET  /intent/journal       — read journal entries with query params
 * - GET  /intent/journal/stats — return journal statistics
 * - POST /intent/journal       — log a new decision entry
 *
 * Uses supertest with a minimal Express app wired to real file-based state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';

/**
 * Create a minimal RouteContext with only what the intent routes need.
 * Most fields are nulled out since intent routes only touch config.stateDir.
 */
function createMinimalContext(stateDir: string): RouteContext {
  return {
    config: {
      projectName: 'test-project',
      projectDir: path.dirname(stateDir),
      stateDir,
      port: 0,
      sessions: {} as any,
      scheduler: {} as any,
    } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: {
      getJobState: () => null,
      getSession: () => null,
    } as any,
    scheduler: null,
    telegram: null,
    relationships: null,
    feedback: null,
    dispatches: null,
    updateChecker: null,
    autoUpdater: null,
    autoDispatcher: null,
    quotaTracker: null,
    publisher: null,
    viewer: null,
    tunnel: null,
    evolution: null,
    watchdog: null,
    triageNurse: null,
    topicMemory: null,
    discoveryEvaluator: null,
    startTime: new Date(),
  };
}

describe('Intent Journal Routes (integration)', () => {
  let tmpDir: string;
  let stateDir: string;
  let app: express.Express;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-routes-test-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });

    const ctx = createMinimalContext(stateDir);
    app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── POST /intent/journal ─────────────────────────────────────────

  describe('POST /intent/journal', () => {
    it('logs a decision entry and returns 201', async () => {
      const res = await request(app)
        .post('/intent/journal')
        .send({
          sessionId: 'sess-1',
          decision: 'Chose caching strategy A',
          principle: 'performance',
          confidence: 0.9,
        });

      expect(res.status).toBe(201);
      expect(res.body.sessionId).toBe('sess-1');
      expect(res.body.decision).toBe('Chose caching strategy A');
      expect(res.body.principle).toBe('performance');
      expect(res.body.confidence).toBe(0.9);
      expect(res.body.timestamp).toBeTruthy();

      // Verify it was persisted to disk
      const journalFile = path.join(stateDir, 'decision-journal.jsonl');
      expect(fs.existsSync(journalFile)).toBe(true);
      const content = fs.readFileSync(journalFile, 'utf-8').trim();
      const parsed = JSON.parse(content);
      expect(parsed.decision).toBe('Chose caching strategy A');
    });

    it('returns 400 when sessionId is missing', async () => {
      const res = await request(app)
        .post('/intent/journal')
        .send({ decision: 'No session ID provided' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('sessionId');
    });

    it('returns 400 when decision is missing', async () => {
      const res = await request(app)
        .post('/intent/journal')
        .send({ sessionId: 'sess-1' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('decision');
    });

    it('returns 400 when body is empty', async () => {
      const res = await request(app)
        .post('/intent/journal')
        .send({});

      expect(res.status).toBe(400);
    });

    it('preserves optional fields in logged entry', async () => {
      const res = await request(app)
        .post('/intent/journal')
        .send({
          sessionId: 'sess-full',
          decision: 'Full entry test',
          topicId: 42,
          jobSlug: 'deploy-job',
          alternatives: ['Alt A', 'Alt B'],
          principle: 'safety',
          confidence: 0.75,
          context: 'Production deployment',
          conflict: true,
          tags: ['deploy', 'critical'],
        });

      expect(res.status).toBe(201);
      expect(res.body.topicId).toBe(42);
      expect(res.body.jobSlug).toBe('deploy-job');
      expect(res.body.alternatives).toEqual(['Alt A', 'Alt B']);
      expect(res.body.conflict).toBe(true);
      expect(res.body.tags).toEqual(['deploy', 'critical']);
    });

    it('appends multiple entries without overwriting', async () => {
      await request(app)
        .post('/intent/journal')
        .send({ sessionId: 's1', decision: 'First' });
      await request(app)
        .post('/intent/journal')
        .send({ sessionId: 's2', decision: 'Second' });
      await request(app)
        .post('/intent/journal')
        .send({ sessionId: 's3', decision: 'Third' });

      const journalFile = path.join(stateDir, 'decision-journal.jsonl');
      const lines = fs.readFileSync(journalFile, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(3);
    });
  });

  // ── GET /intent/journal ──────────────────────────────────────────

  describe('GET /intent/journal', () => {
    it('returns empty entries when journal does not exist', async () => {
      const res = await request(app).get('/intent/journal');

      expect(res.status).toBe(200);
      expect(res.body.entries).toEqual([]);
      expect(res.body.count).toBe(0);
    });

    it('returns all entries (up to default limit)', async () => {
      // Seed journal entries
      const entries = [
        { timestamp: '2026-02-20T10:00:00.000Z', sessionId: 's1', decision: 'D1' },
        { timestamp: '2026-02-21T10:00:00.000Z', sessionId: 's2', decision: 'D2' },
        { timestamp: '2026-02-22T10:00:00.000Z', sessionId: 's3', decision: 'D3' },
      ];
      fs.writeFileSync(
        path.join(stateDir, 'decision-journal.jsonl'),
        entries.map(e => JSON.stringify(e)).join('\n') + '\n',
      );

      const res = await request(app).get('/intent/journal');

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(3);
      expect(res.body.entries).toHaveLength(3);
      // newest first
      expect(res.body.entries[0].decision).toBe('D3');
      expect(res.body.entries[2].decision).toBe('D1');
    });

    it('filters by days query param', async () => {
      const now = Date.now();
      const entries = [
        { timestamp: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(), sessionId: 's1', decision: 'Recent' },
        { timestamp: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(), sessionId: 's2', decision: 'Old' },
      ];
      fs.writeFileSync(
        path.join(stateDir, 'decision-journal.jsonl'),
        entries.map(e => JSON.stringify(e)).join('\n') + '\n',
      );

      const res = await request(app).get('/intent/journal?days=7');

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      expect(res.body.entries[0].decision).toBe('Recent');
    });

    it('filters by jobSlug query param', async () => {
      const entries = [
        { timestamp: '2026-02-20T10:00:00.000Z', sessionId: 's1', decision: 'Deploy', jobSlug: 'deploy' },
        { timestamp: '2026-02-20T11:00:00.000Z', sessionId: 's2', decision: 'Health', jobSlug: 'health' },
      ];
      fs.writeFileSync(
        path.join(stateDir, 'decision-journal.jsonl'),
        entries.map(e => JSON.stringify(e)).join('\n') + '\n',
      );

      const res = await request(app).get('/intent/journal?jobSlug=health');

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      expect(res.body.entries[0].decision).toBe('Health');
    });

    it('limits results with limit query param', async () => {
      const entries = Array.from({ length: 10 }, (_, i) => ({
        timestamp: new Date(2026, 1, 20 + i).toISOString(),
        sessionId: `s${i}`,
        decision: `Decision ${i}`,
      }));
      fs.writeFileSync(
        path.join(stateDir, 'decision-journal.jsonl'),
        entries.map(e => JSON.stringify(e)).join('\n') + '\n',
      );

      const res = await request(app).get('/intent/journal?limit=3');

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(3);
      expect(res.body.entries).toHaveLength(3);
    });

    it('defaults limit to 50 when not specified', async () => {
      const entries = Array.from({ length: 60 }, (_, i) => ({
        timestamp: new Date(2026, 0, 1 + i).toISOString(),
        sessionId: `s${i}`,
        decision: `Decision ${i}`,
      }));
      fs.writeFileSync(
        path.join(stateDir, 'decision-journal.jsonl'),
        entries.map(e => JSON.stringify(e)).join('\n') + '\n',
      );

      const res = await request(app).get('/intent/journal');

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(50);
      expect(res.body.entries).toHaveLength(50);
    });

    it('combines multiple query params', async () => {
      const now = Date.now();
      const entries = [
        { timestamp: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(), sessionId: 's1', decision: 'Recent deploy 1', jobSlug: 'deploy' },
        { timestamp: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(), sessionId: 's2', decision: 'Recent deploy 2', jobSlug: 'deploy' },
        { timestamp: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(), sessionId: 's3', decision: 'Recent deploy 3', jobSlug: 'deploy' },
        { timestamp: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(), sessionId: 's4', decision: 'Recent health', jobSlug: 'health' },
        { timestamp: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(), sessionId: 's5', decision: 'Old deploy', jobSlug: 'deploy' },
      ];
      fs.writeFileSync(
        path.join(stateDir, 'decision-journal.jsonl'),
        entries.map(e => JSON.stringify(e)).join('\n') + '\n',
      );

      const res = await request(app).get('/intent/journal?days=7&jobSlug=deploy&limit=2');

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
      expect(res.body.entries[0].decision).toBe('Recent deploy 1');
      expect(res.body.entries[1].decision).toBe('Recent deploy 2');
    });
  });

  // ── GET /intent/journal/stats ────────────────────────────────────

  describe('GET /intent/journal/stats', () => {
    it('returns zero stats when journal does not exist', async () => {
      const res = await request(app).get('/intent/journal/stats');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        count: 0,
        earliest: null,
        latest: null,
        topPrinciples: [],
        conflictCount: 0,
      });
    });

    it('returns correct stats for populated journal', async () => {
      const entries = [
        { timestamp: '2026-02-15T08:00:00.000Z', sessionId: 's1', decision: 'D1', principle: 'safety', conflict: true },
        { timestamp: '2026-02-18T10:00:00.000Z', sessionId: 's2', decision: 'D2', principle: 'speed' },
        { timestamp: '2026-02-20T14:00:00.000Z', sessionId: 's3', decision: 'D3', principle: 'safety' },
        { timestamp: '2026-02-22T09:00:00.000Z', sessionId: 's4', decision: 'D4', principle: 'safety', conflict: true },
      ];
      fs.writeFileSync(
        path.join(stateDir, 'decision-journal.jsonl'),
        entries.map(e => JSON.stringify(e)).join('\n') + '\n',
      );

      const res = await request(app).get('/intent/journal/stats');

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(4);
      expect(res.body.earliest).toBe('2026-02-15T08:00:00.000Z');
      expect(res.body.latest).toBe('2026-02-22T09:00:00.000Z');
      expect(res.body.topPrinciples[0]).toEqual({ principle: 'safety', count: 3 });
      expect(res.body.topPrinciples[1]).toEqual({ principle: 'speed', count: 1 });
      expect(res.body.conflictCount).toBe(2);
    });
  });

  // ── End-to-end: POST then GET ────────────────────────────────────

  describe('POST then GET round-trip', () => {
    it('entries logged via POST appear in GET', async () => {
      // Log two entries via POST (small delay ensures distinct timestamps for sort order)
      await request(app)
        .post('/intent/journal')
        .send({ sessionId: 's1', decision: 'First decision', principle: 'accuracy' });

      await new Promise(r => setTimeout(r, 10));

      await request(app)
        .post('/intent/journal')
        .send({ sessionId: 's2', decision: 'Second decision', principle: 'speed', conflict: true });

      // Read them back via GET
      const res = await request(app).get('/intent/journal');

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
      // Newest first
      expect(res.body.entries[0].decision).toBe('Second decision');
      expect(res.body.entries[1].decision).toBe('First decision');

      // Stats should reflect them too
      const statsRes = await request(app).get('/intent/journal/stats');
      expect(statsRes.body.count).toBe(2);
      expect(statsRes.body.conflictCount).toBe(1);
      expect(statsRes.body.topPrinciples).toHaveLength(2);
    });
  });
});
