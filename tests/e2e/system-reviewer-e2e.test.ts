/**
 * E2E tests for SystemReviewer.
 *
 * Tests the complete lifecycle from probe registration through review execution,
 * history building, trend analysis, and API route behavior. Uses real filesystem,
 * real HTTP server (via supertest), and real SystemReviewer instances.
 *
 * These tests verify the full user journey:
 * 1. Configure system reviewer
 * 2. Register probes
 * 3. Run reviews via API
 * 4. Query results via API
 * 5. Analyze trends across multiple reviews
 * 6. Verify persistence across "restarts"
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import request from 'supertest';
import { SystemReviewer } from '../../src/monitoring/SystemReviewer.js';
import type { Probe, ProbeResult, ReviewReport } from '../../src/monitoring/SystemReviewer.js';
import { createSessionProbes } from '../../src/monitoring/probes/SessionProbe.js';
import { createSchedulerProbes } from '../../src/monitoring/probes/SchedulerProbe.js';
import { createMessagingProbes } from '../../src/monitoring/probes/MessagingProbe.js';
import { createLifelineProbes } from '../../src/monitoring/probes/LifelineProbe.js';

// ── Helpers ─────────────────────────────────────────────────────────

function makePassingProbe(id: string, tier: 1 | 2 | 3 | 4 | 5 = 1): Probe {
  return {
    id,
    name: `Test Probe ${id}`,
    tier,
    feature: 'Test Feature',
    timeoutMs: 5000,
    prerequisites: () => true,
    async run(): Promise<ProbeResult> {
      return {
        probeId: this.id,
        name: this.name,
        tier: this.tier,
        passed: true,
        description: 'All good',
        durationMs: 1,
      };
    },
  };
}

function makeFailingProbe(id: string, tier: 1 | 2 | 3 | 4 | 5 = 1): Probe {
  return {
    id,
    name: `Failing Probe ${id}`,
    tier,
    feature: 'Test Feature',
    timeoutMs: 5000,
    prerequisites: () => true,
    async run(): Promise<ProbeResult> {
      return {
        probeId: this.id,
        name: this.name,
        tier: this.tier,
        passed: false,
        description: 'Something broke',
        durationMs: 1,
        error: 'Expected 42, got 0',
        remediation: ['Fix the thing'],
      };
    },
  };
}

/**
 * Create a minimal Express app that mirrors the SystemReviewer API routes
 * from routes.ts, but isolated for testing.
 */
function createTestApp(systemReviewer: SystemReviewer | null, authToken?: string) {
  const app = express();
  app.use(express.json());

  // Auth middleware (simplified from routes.ts)
  const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (authToken) {
      const header = req.headers.authorization;
      if (!header || header !== `Bearer ${authToken}`) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }
    next();
  };

  app.post('/system-reviews', requireAuth, async (req, res) => {
    if (!systemReviewer) {
      res.status(503).json({ error: 'SystemReviewer not available' });
      return;
    }
    try {
      const { tier, tiers, probeId, probeIds, dryRun } = req.body || {};
      const report = await systemReviewer.review({
        tiers: tiers ?? (tier != null ? [Number(tier)] : undefined),
        probeIds: probeIds ?? (probeId ? [probeId] : undefined),
        dryRun: dryRun === true,
      });
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Review failed' });
    }
  });

  app.get('/system-reviews/latest', requireAuth, (_req, res) => {
    if (!systemReviewer) {
      res.status(503).json({ error: 'SystemReviewer not available' });
      return;
    }
    const latest = systemReviewer.getLatest();
    res.json(latest ?? { message: 'No reviews yet' });
  });

  app.get('/system-reviews/history', requireAuth, (req, res) => {
    if (!systemReviewer) {
      res.status(503).json({ error: 'SystemReviewer not available' });
      return;
    }
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const history = systemReviewer.getHistory(limit);
    res.json({ count: history.length, reports: history });
  });

  app.get('/system-reviews/trend', requireAuth, (_req, res) => {
    if (!systemReviewer) {
      res.status(503).json({ error: 'SystemReviewer not available' });
      return;
    }
    const trend = systemReviewer.getTrend();
    res.json(trend);
  });

  return app;
}

// ── E2E: Complete Review Lifecycle ──────────────────────────────────

describe('E2E: SystemReviewer Complete Lifecycle', () => {
  let stateDir: string;
  let reviewer: SystemReviewer;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-e2e-'));
    reviewer = new SystemReviewer({ enabled: false }, { stateDir });
  });

  afterEach(() => {
    reviewer.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('full lifecycle: register → review → history → trend', async () => {
    // Step 1: Register mixed probes
    reviewer.register(makePassingProbe('e2e.pass1', 1));
    reviewer.register(makePassingProbe('e2e.pass2', 1));
    reviewer.register(makePassingProbe('e2e.pass3', 2));
    reviewer.register(makeFailingProbe('e2e.fail1', 2));

    expect(reviewer.getProbes()).toHaveLength(4);
    expect(reviewer.getLatest()).toBeNull();

    // Step 2: First review
    const report1 = await reviewer.review();
    expect(report1.status).toBe('degraded'); // Tier 2 failure
    expect(report1.stats.total).toBe(4);
    expect(report1.stats.passed).toBe(3);
    expect(report1.stats.failed).toBe(1);
    expect(report1.stats.skipped).toBe(0);

    // Step 3: Verify history
    expect(reviewer.getHistory()).toHaveLength(1);
    expect(reviewer.getLatest()).toBe(report1);

    // Step 4: Second review
    const report2 = await reviewer.review();
    expect(reviewer.getHistory()).toHaveLength(2);

    // Step 5: Trend analysis
    const trend = reviewer.getTrend();
    expect(trend.window).toBe(2);
    expect(trend.direction).toBe('stable'); // Same probes failing both times

    // Step 6: Health status
    const health = reviewer.getHealthStatus();
    expect(health.status).toBe('degraded');
    expect(health.message).toContain('3/4');

    // Step 7: Verify file persistence
    const historyPath = path.join(stateDir, 'review-history.jsonl');
    expect(fs.existsSync(historyPath)).toBe(true);
    const fileLines = fs.readFileSync(historyPath, 'utf-8').trim().split('\n');
    expect(fileLines).toHaveLength(2);
  });

  it('multi-review trend with degradation and recovery', async () => {
    let failFlag = false;
    reviewer.register({
      id: 'e2e.flaky',
      name: 'Flaky Service',
      tier: 1,
      feature: 'E2E Test',
      timeoutMs: 5000,
      prerequisites: () => true,
      async run() {
        return {
          probeId: 'e2e.flaky', name: 'Flaky', tier: 1 as const,
          passed: !failFlag, description: failFlag ? 'fail' : 'ok',
          durationMs: 0, error: failFlag ? 'Service down' : undefined,
        };
      },
    });
    reviewer.register(makePassingProbe('e2e.stable', 1));

    // Reviews 1-3: all pass
    for (let i = 0; i < 3; i++) {
      await reviewer.review();
    }

    // Reviews 4-6: flaky fails
    failFlag = true;
    for (let i = 0; i < 3; i++) {
      await reviewer.review();
    }

    let trend = reviewer.getTrend();
    expect(trend.persistentFailures).toContain('e2e.flaky');

    // Reviews 7-8: recovered
    failFlag = false;
    await reviewer.review();

    trend = reviewer.getTrend();
    expect(trend.recovered).toContain('e2e.flaky');
  });
});

// ── E2E: API Routes ────────────────────────────────────────────────

describe('E2E: SystemReviewer API Routes', () => {
  let stateDir: string;
  let reviewer: SystemReviewer;
  let app: express.Express;
  const AUTH_TOKEN = 'test-auth-token-12345';

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-api-e2e-'));
    reviewer = new SystemReviewer({ enabled: false }, { stateDir });
    reviewer.register(makePassingProbe('api.test1', 1));
    reviewer.register(makePassingProbe('api.test2', 2));
    reviewer.register(makeFailingProbe('api.fail', 3));
    app = createTestApp(reviewer, AUTH_TOKEN);
  });

  afterEach(() => {
    reviewer.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  // ── POST /system-reviews ──────────────────────────────────────────

  it('POST /system-reviews runs a full review', async () => {
    const res = await request(app)
      .post('/system-reviews')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded'); // Tier 3 failure
    expect(res.body.results).toHaveLength(3);
    expect(res.body.stats.total).toBe(3);
    expect(res.body.stats.passed).toBe(2);
    expect(res.body.stats.failed).toBe(1);
    expect(res.body.timestamp).toBeTruthy();
  });

  it('POST /system-reviews filters by tier', async () => {
    const res = await request(app)
      .post('/system-reviews')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ tier: 1 });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].probeId).toBe('api.test1');
    expect(res.body.status).toBe('all-clear');
  });

  it('POST /system-reviews filters by multiple tiers', async () => {
    const res = await request(app)
      .post('/system-reviews')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ tiers: [1, 2] });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.status).toBe('all-clear');
  });

  it('POST /system-reviews filters by probeId', async () => {
    const res = await request(app)
      .post('/system-reviews')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ probeId: 'api.fail' });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].probeId).toBe('api.fail');
    expect(res.body.results[0].passed).toBe(false);
  });

  it('POST /system-reviews filters by multiple probeIds', async () => {
    const res = await request(app)
      .post('/system-reviews')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ probeIds: ['api.test1', 'api.fail'] });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
  });

  it('POST /system-reviews supports dry run', async () => {
    const res = await request(app)
      .post('/system-reviews')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(0);
    expect(res.body.skipped.length).toBeGreaterThan(0);
    expect(res.body.status).toBe('all-clear');
  });

  it('POST /system-reviews returns 401 without auth', async () => {
    const res = await request(app)
      .post('/system-reviews')
      .send({});

    expect(res.status).toBe(401);
  });

  it('POST /system-reviews returns 500 on concurrent review', async () => {
    // Start a slow review
    const slowReviewer = new SystemReviewer({ enabled: false }, { stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'slow-')) });
    slowReviewer.register({
      id: 'slow.probe',
      name: 'Slow',
      tier: 1,
      feature: 'Test',
      timeoutMs: 5000,
      prerequisites: () => true,
      async run() {
        await new Promise(r => setTimeout(r, 200));
        return {
          probeId: 'slow.probe', name: 'Slow', tier: 1 as const,
          passed: true, description: 'ok', durationMs: 200,
        };
      },
    });

    const slowApp = createTestApp(slowReviewer, AUTH_TOKEN);

    // Fire two reviews simultaneously
    const [res1, res2] = await Promise.all([
      request(slowApp).post('/system-reviews').set('Authorization', `Bearer ${AUTH_TOKEN}`).send({}),
      request(slowApp).post('/system-reviews').set('Authorization', `Bearer ${AUTH_TOKEN}`).send({}),
    ]);

    // One should succeed, one should get 500
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 500]);

    slowReviewer.stop();
  });

  // ── GET /system-reviews/latest ────────────────────────────────────

  it('GET /system-reviews/latest returns "no reviews" initially', async () => {
    const freshReviewer = new SystemReviewer({ enabled: false }, { stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-')) });
    const freshApp = createTestApp(freshReviewer, AUTH_TOKEN);

    const res = await request(freshApp)
      .get('/system-reviews/latest')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('No reviews');
    freshReviewer.stop();
  });

  it('GET /system-reviews/latest returns last review after running one', async () => {
    // Run a review first
    await request(app)
      .post('/system-reviews')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({});

    const res = await request(app)
      .get('/system-reviews/latest')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.results).toBeDefined();
    expect(res.body.stats).toBeDefined();
  });

  // ── GET /system-reviews/history ───────────────────────────────────

  it('GET /system-reviews/history returns empty initially', async () => {
    const freshReviewer = new SystemReviewer({ enabled: false }, { stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hist-')) });
    const freshApp = createTestApp(freshReviewer, AUTH_TOKEN);

    const res = await request(freshApp)
      .get('/system-reviews/history')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.reports).toEqual([]);
    freshReviewer.stop();
  });

  it('GET /system-reviews/history returns all reviews', async () => {
    // Run 3 reviews
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/system-reviews')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({});
    }

    const res = await request(app)
      .get('/system-reviews/history')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.reports).toHaveLength(3);
  });

  it('GET /system-reviews/history respects limit parameter', async () => {
    // Run 5 reviews
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/system-reviews')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({});
    }

    const res = await request(app)
      .get('/system-reviews/history?limit=2')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.reports).toHaveLength(2);
  });

  // ── GET /system-reviews/trend ────────────────────────────────────

  it('GET /system-reviews/trend returns stable with few reviews', async () => {
    await request(app)
      .post('/system-reviews')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({});

    const res = await request(app)
      .get('/system-reviews/trend')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.direction).toBe('stable');
    expect(res.body.window).toBe(1);
  });

  it('GET /system-reviews/trend detects trends across reviews', async () => {
    // Run multiple reviews
    for (let i = 0; i < 4; i++) {
      await request(app)
        .post('/system-reviews')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({});
    }

    const res = await request(app)
      .get('/system-reviews/trend')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.window).toBe(4);
    expect(res.body.direction).toBeDefined();
    expect(res.body.persistentFailures).toBeDefined();
    expect(res.body.newFailures).toBeDefined();
    expect(res.body.recovered).toBeDefined();
  });

  // ── 503 when SystemReviewer is null ───────────────────────────────

  it('all routes return 503 when SystemReviewer is not available', async () => {
    const nullApp = createTestApp(null, AUTH_TOKEN);

    const endpoints = [
      { method: 'post', path: '/system-reviews' },
      { method: 'get', path: '/system-reviews/latest' },
      { method: 'get', path: '/system-reviews/history' },
      { method: 'get', path: '/system-reviews/trend' },
    ] as const;

    for (const ep of endpoints) {
      const res = ep.method === 'post'
        ? await request(nullApp).post(ep.path).set('Authorization', `Bearer ${AUTH_TOKEN}`).send({})
        : await request(nullApp).get(ep.path).set('Authorization', `Bearer ${AUTH_TOKEN}`);

      expect(res.status).toBe(503);
      expect(res.body.error).toContain('not available');
    }
  });
});

// ── E2E: Persistence Across "Restarts" ─────────────────────────────

describe('E2E: SystemReviewer Persistence Across Restarts', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-restart-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('simulates server restart: reviews persist and trend continues', async () => {
    // ── "Boot 1" ──
    const rev1 = new SystemReviewer({ enabled: false }, { stateDir });
    rev1.register(makePassingProbe('persist.a', 1));
    rev1.register(makePassingProbe('persist.b', 2));

    await rev1.review();
    await rev1.review();
    expect(rev1.getHistory()).toHaveLength(2);
    rev1.stop();

    // ── "Boot 2" (simulates restart) ──
    const rev2 = new SystemReviewer({ enabled: false }, { stateDir });
    rev2.register(makePassingProbe('persist.a', 1));
    rev2.register(makeFailingProbe('persist.b', 2)); // Now failing

    // History should survive
    expect(rev2.getHistory()).toHaveLength(2);

    await rev2.review();
    expect(rev2.getHistory()).toHaveLength(3);

    // Trend should show the change
    const trend = rev2.getTrend();
    expect(trend.window).toBe(3);
    expect(trend.newFailures).toContain('persist.b');

    // Latest should be the new review
    const latest = rev2.getLatest();
    expect(latest?.status).toBe('degraded');
    rev2.stop();

    // ── "Boot 3" ──
    const rev3 = new SystemReviewer({ enabled: false }, { stateDir });
    expect(rev3.getHistory()).toHaveLength(3);
    rev3.stop();
  });

  it('API responds correctly after simulated restart', async () => {
    const AUTH = 'restart-test-token';

    // Boot 1: run reviews via API
    const rev1 = new SystemReviewer({ enabled: false }, { stateDir });
    rev1.register(makePassingProbe('restart.test', 1));
    const app1 = createTestApp(rev1, AUTH);

    await request(app1).post('/system-reviews').set('Authorization', `Bearer ${AUTH}`).send({});
    await request(app1).post('/system-reviews').set('Authorization', `Bearer ${AUTH}`).send({});
    rev1.stop();

    // Boot 2: new instance, should see old history
    const rev2 = new SystemReviewer({ enabled: false }, { stateDir });
    rev2.register(makePassingProbe('restart.test', 1));
    const app2 = createTestApp(rev2, AUTH);

    const histRes = await request(app2)
      .get('/system-reviews/history')
      .set('Authorization', `Bearer ${AUTH}`);

    expect(histRes.body.count).toBe(2);

    // Run another review
    await request(app2).post('/system-reviews').set('Authorization', `Bearer ${AUTH}`).send({});

    const latestRes = await request(app2)
      .get('/system-reviews/latest')
      .set('Authorization', `Bearer ${AUTH}`);

    expect(latestRes.body.status).toBe('all-clear');
    expect(latestRes.body.results).toHaveLength(1);

    rev2.stop();
  });
});

// ── E2E: Real Probe Integration ─────────────────────────────────────

describe('E2E: Real Probe Factories with SystemReviewer', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-realprobe-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('session probes report accurate diagnostics through full pipeline', async () => {
    const sessions = [
      { id: '1', tmuxSession: 'sess-1', name: 'Worker 1' },
      { id: '2', tmuxSession: 'sess-2', name: 'Worker 2' },
    ];
    const diagnostics = {
      sessions: [
        { name: 'Worker 1', ageMinutes: 45 },
        { name: 'Worker 2', ageMinutes: 120 },
      ],
    };

    const reviewer = new SystemReviewer({ enabled: false }, { stateDir });

    const probes = createSessionProbes({
      listRunningSessions: () => sessions,
      getSessionDiagnostics: () => diagnostics,
      maxSessions: 5,
      tmuxPath: '/usr/bin/tmux',
    });

    // Override prerequisites and tmux-alive for CI (no tmux)
    for (const p of probes) {
      (p as { prerequisites: () => boolean }).prerequisites = () => true;
    }
    const tmuxProbe = probes.find(p => p.id === 'instar.session.tmux-alive')!;
    tmuxProbe.run = async function (): Promise<ProbeResult> {
      return {
        probeId: this.id, name: this.name, tier: this.tier,
        passed: true, description: 'All verified (mocked)', durationMs: 0,
      };
    };

    reviewer.registerAll(probes);

    const report = await reviewer.review();
    expect(report.status).toBe('all-clear');

    // Verify diagnostics flow through
    const listResult = report.results.find(r => r.probeId === 'instar.session.list');
    expect(listResult?.passed).toBe(true);
    expect(listResult?.diagnostics?.count).toBe(2);

    const diagResult = report.results.find(r => r.probeId === 'instar.session.diagnostics');
    expect(diagResult?.passed).toBe(true);
    expect(diagResult?.diagnostics?.oldestMinutes).toBe(120);

    const limitResult = report.results.find(r => r.probeId === 'instar.session.limits');
    expect(limitResult?.passed).toBe(true);
    expect(limitResult?.description).toContain('2/5');

    reviewer.stop();
  });

  it('scheduler probes detect real issues through full pipeline', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-e2e-'));
    const jobsFile = path.join(tmpDir, 'jobs.json');
    fs.writeFileSync(jobsFile, JSON.stringify([
      { slug: 'a', name: 'Job A' },
      { slug: 'b', name: 'Job B' },
    ]));

    const reviewer = new SystemReviewer({ enabled: false }, { stateDir });

    const probes = createSchedulerProbes({
      getJobs: () => [{ id: '1', name: 'Job A' }, { id: '2', name: 'Job B' }],
      getStatus: () => ({ running: true, paused: true, jobCount: 2, enabledJobs: 2, queueLength: 5 }),
      jobsFilePath: jobsFile,
    });

    reviewer.registerAll(probes);

    const report = await reviewer.review();

    // scheduler.running should fail (paused)
    const runningResult = report.results.find(r => r.probeId === 'instar.scheduler.running');
    expect(runningResult?.passed).toBe(false);
    expect(runningResult?.error).toContain('paused');

    // scheduler.loaded should pass (counts match)
    const loadedResult = report.results.find(r => r.probeId === 'instar.scheduler.loaded');
    expect(loadedResult?.passed).toBe(true);

    // scheduler.queue should pass (5 < 20)
    const queueResult = report.results.find(r => r.probeId === 'instar.scheduler.queue');
    expect(queueResult?.passed).toBe(true);

    reviewer.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('messaging probes report connection state through full pipeline', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-e2e-'));
    const logPath = path.join(tmpDir, 'telegram-messages.jsonl');
    fs.writeFileSync(logPath, '{"id":1,"text":"hello"}\n{"id":2,"text":"world"}\n');

    const reviewer = new SystemReviewer({ enabled: false }, { stateDir });

    const probes = createMessagingProbes({
      getStatus: () => ({
        started: true, uptime: 300000, pendingStalls: 0,
        pendingPromises: 0, topicMappings: 3,
      }),
      messageLogPath: logPath,
      isConfigured: () => true,
    });

    reviewer.registerAll(probes);

    const report = await reviewer.review();

    expect(report.status).toBe('all-clear');

    const connResult = report.results.find(r => r.probeId === 'instar.messaging.connected');
    expect(connResult?.passed).toBe(true);
    expect(connResult?.description).toContain('5m'); // 300000ms = 5m

    const logResult = report.results.find(r => r.probeId === 'instar.messaging.log');
    expect(logResult?.passed).toBe(true);
    expect(logResult?.description).toContain('active');

    const topicResult = report.results.find(r => r.probeId === 'instar.messaging.topics');
    expect(topicResult?.passed).toBe(true);
    expect(topicResult?.description).toContain('3 topic');

    reviewer.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lifeline probes detect degraded state through full pipeline', async () => {
    const lockPath = path.join(stateDir, 'lifeline.lock');
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }));

    const reviewer = new SystemReviewer({ enabled: false }, { stateDir });

    const probes = createLifelineProbes({
      getSupervisorStatus: () => ({
        running: true, healthy: false, restartAttempts: 2,
        lastHealthy: Date.now() - 120000,
        coolingDown: false, cooldownRemainingMs: 0, circuitBroken: false,
        totalFailures: 5, lastCrashOutput: 'ENOMEM',
        circuitBreakerRetryCount: 0, maxCircuitBreakerRetries: 3,
        inMaintenanceWait: false, maintenanceWaitElapsedMs: 0,
      }),
      getQueueLength: () => 10,
      peekQueue: () => [
        { id: 'msg-1', timestamp: new Date().toISOString() },
      ],
      lockFilePath: lockPath,
      isEnabled: () => true,
    });

    reviewer.registerAll(probes);

    const report = await reviewer.review();
    expect(report.status).toBe('critical'); // Tier 1 failure

    // Process probe should pass (lock file valid, PID alive)
    const processResult = report.results.find(r => r.probeId === 'instar.lifeline.process');
    expect(processResult?.passed).toBe(true);

    // Supervisor probe should fail (unhealthy)
    const supervisorResult = report.results.find(r => r.probeId === 'instar.lifeline.supervisor');
    expect(supervisorResult?.passed).toBe(false);
    expect(supervisorResult?.error).toContain('Health checks failing');

    // Queue probe should pass (10 < 50 and recent)
    const queueResult = report.results.find(r => r.probeId === 'instar.lifeline.queue');
    expect(queueResult?.passed).toBe(true);

    reviewer.stop();
  });
});

// ── E2E: Event Flow ────────────────────────────────────────────────

describe('E2E: SystemReviewer Event Flow', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-events-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('events fire in correct order during review lifecycle', async () => {
    const events: string[] = [];

    const reviewer = new SystemReviewer({ enabled: false }, { stateDir });
    reviewer.register(makePassingProbe('evt.pass', 1));
    reviewer.register(makeFailingProbe('evt.fail', 2));

    reviewer.on('review:probe-failed', (result) => {
      events.push(`probe-failed:${result.probeId}`);
    });
    reviewer.on('review:complete', (report) => {
      events.push(`complete:${report.status}`);
    });

    await reviewer.review();

    // probe-failed should fire before complete
    expect(events).toContain('probe-failed:evt.fail');
    expect(events).toContain('complete:degraded');

    const failIdx = events.indexOf('probe-failed:evt.fail');
    const completeIdx = events.indexOf('complete:degraded');
    expect(failIdx).toBeLessThan(completeIdx);

    reviewer.stop();
  });
});
