/**
 * Integration tests for intent drift and alignment API routes.
 *
 * Tests the two endpoints:
 * - GET /intent/drift       — returns DriftAnalysis
 * - GET /intent/alignment   — returns AlignmentScore
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

/** Generate a timestamp N days ago from now. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Create a minimal RouteContext with only what the drift routes need.
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

describe('Drift & Alignment Routes (integration)', () => {
  let tmpDir: string;
  let stateDir: string;
  let app: express.Express;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-routes-test-'));
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

  // ── GET /intent/drift ─────────────────────────────────────────────

  describe('GET /intent/drift', () => {
    it('returns analysis for empty journal', async () => {
      const res = await request(app).get('/intent/drift');

      expect(res.status).toBe(200);
      expect(res.body.current).toBeTruthy();
      expect(res.body.current.decisionCount).toBe(0);
      expect(res.body.previous).toBeNull();
      expect(res.body.signals).toEqual([]);
      expect(res.body.driftScore).toBe(0);
      expect(res.body.summary).toBeTruthy();
    });

    it('returns analysis with populated journal', async () => {
      // Create entries spanning both windows (default 14 days)
      const entries = [
        // Previous window (15-28 days ago)
        ...Array.from({ length: 5 }, (_, i) => ({
          timestamp: daysAgo(15 + i),
          sessionId: `prev-${i}`,
          decision: `Previous decision ${i}`,
          principle: 'safety',
          confidence: 0.85,
        })),
        // Current window (1-13 days ago)
        ...Array.from({ length: 8 }, (_, i) => ({
          timestamp: daysAgo(1 + i),
          sessionId: `curr-${i}`,
          decision: `Current decision ${i}`,
          principle: 'safety',
          confidence: 0.8,
        })),
      ];

      fs.writeFileSync(
        path.join(stateDir, 'decision-journal.jsonl'),
        entries.map(e => JSON.stringify(e)).join('\n') + '\n',
      );

      const res = await request(app).get('/intent/drift');

      expect(res.status).toBe(200);
      expect(res.body.current.decisionCount).toBe(8);
      expect(res.body.previous).toBeTruthy();
      expect(res.body.previous.decisionCount).toBe(5);
      expect(typeof res.body.driftScore).toBe('number');
      expect(Array.isArray(res.body.signals)).toBe(true);
    });

    it('respects window query parameter', async () => {
      // Use entries clearly within window boundaries (avoid exact cutoff)
      // Current window (window=7): entries 0.5-6.5 days ago (6 entries clearly inside)
      // Previous window: entries 7.5-13.5 days ago (4 entries clearly inside)
      const currentEntries = Array.from({ length: 6 }, (_, i) => ({
        timestamp: daysAgo(i + 0.5),
        sessionId: `curr-${i}`,
        decision: `Current ${i}`,
        principle: 'safety',
        confidence: 0.8,
      }));
      const previousEntries = Array.from({ length: 4 }, (_, i) => ({
        timestamp: daysAgo(i + 7.5),
        sessionId: `prev-${i}`,
        decision: `Previous ${i}`,
        principle: 'safety',
        confidence: 0.8,
      }));

      fs.writeFileSync(
        path.join(stateDir, 'decision-journal.jsonl'),
        [...currentEntries, ...previousEntries].map(e => JSON.stringify(e)).join('\n') + '\n',
      );

      const res = await request(app).get('/intent/drift?window=7');

      expect(res.status).toBe(200);
      expect(res.body.current.decisionCount).toBe(6);
      expect(res.body.previous).toBeTruthy();
      expect(res.body.previous.decisionCount).toBe(4);
    });
  });

  // ── GET /intent/alignment ─────────────────────────────────────────

  describe('GET /intent/alignment', () => {
    it('returns score for empty journal', async () => {
      const res = await request(app).get('/intent/alignment');

      expect(res.status).toBe(200);
      expect(res.body.score).toBe(0);
      expect(res.body.grade).toBe('F');
      expect(res.body.sampleSize).toBe(0);
      expect(res.body.components).toBeTruthy();
      expect(res.body.components.conflictFreedom).toBe(0);
      expect(res.body.components.confidenceLevel).toBe(0);
      expect(res.body.components.principleConsistency).toBe(0);
      expect(res.body.components.journalHealth).toBe(0);
    });

    it('returns score for populated journal', async () => {
      const entries = Array.from({ length: 20 }, (_, i) => ({
        timestamp: daysAgo(i + 1),
        sessionId: `s${i}`,
        decision: `Decision ${i}`,
        principle: 'safety',
        confidence: 0.85,
        conflict: false,
      }));

      fs.writeFileSync(
        path.join(stateDir, 'decision-journal.jsonl'),
        entries.map(e => JSON.stringify(e)).join('\n') + '\n',
      );

      const res = await request(app).get('/intent/alignment');

      expect(res.status).toBe(200);
      expect(res.body.score).toBeGreaterThan(0);
      expect(['A', 'B', 'C', 'D', 'F']).toContain(res.body.grade);
      expect(res.body.sampleSize).toBe(20);
      expect(res.body.periodDays).toBe(30);
      expect(typeof res.body.components.conflictFreedom).toBe('number');
      expect(typeof res.body.components.confidenceLevel).toBe('number');
      expect(typeof res.body.components.principleConsistency).toBe('number');
      expect(typeof res.body.components.journalHealth).toBe('number');
      expect(typeof res.body.summary).toBe('string');
    });
  });

  // ── Round-trip: POST journal entries then GET drift/alignment ──────

  describe('POST then GET round-trip', () => {
    it('entries logged via POST are reflected in drift and alignment', async () => {
      // Log entries via the journal POST endpoint
      for (let i = 0; i < 5; i++) {
        await request(app)
          .post('/intent/journal')
          .send({
            sessionId: `s${i}`,
            decision: `Round-trip decision ${i}`,
            principle: 'accuracy',
            confidence: 0.8,
          });
      }

      // Check drift
      const driftRes = await request(app).get('/intent/drift');
      expect(driftRes.status).toBe(200);
      expect(driftRes.body.current.decisionCount).toBe(5);

      // Check alignment
      const alignRes = await request(app).get('/intent/alignment');
      expect(alignRes.status).toBe(200);
      expect(alignRes.body.sampleSize).toBe(5);
      expect(alignRes.body.score).toBeGreaterThan(0);
    });
  });
});
