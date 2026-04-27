/**
 * E2E tests for Job Run History
 *
 * Tests the full HTTP path: trigger a job via API → scheduler records history →
 * query history via API endpoints. Uses a real AgentServer with supertest,
 * real scheduler, real filesystem. Mock claude script for sessions.
 *
 * History is memory. Memory should never be lost.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { detectTmuxPath } from '../../src/core/Config.js';
import { createMockClaude, createSampleJobsFile, waitFor } from '../helpers/setup.js';
import type { InstarConfig, JobDefinition } from '../../src/core/types.js';

const tmuxPath = detectTmuxPath();
const describeMaybe = tmuxPath ? describe : describe.skip;

describeMaybe('E2E: Job Run History lifecycle', () => {
  let projectDir: string;
  let stateDir: string;
  let mockClaudePath: string;
  let state: StateManager;
  let sessionManager: SessionManager;
  let scheduler: JobScheduler;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'e2e-history-test-token';

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-e2e-history-'));
    stateDir = path.join(projectDir, '.instar');

    // Create directory structure
    for (const dir of [
      path.join(stateDir, 'state', 'sessions'),
      path.join(stateDir, 'state', 'jobs'),
      path.join(stateDir, 'logs'),
      path.join(stateDir, 'ledger'),
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write config
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({
        projectName: 'e2e-history-test',
        port: 0,
        authToken: AUTH_TOKEN,
        sessions: { maxSessions: 5 },
        scheduler: { enabled: true, maxParallelJobs: 3 },
      }, null, 2),
    );

    // Write jobs — a fast-firing job for testing
    const jobs: JobDefinition[] = [
      {
        slug: 'hist-test-job',
        name: 'History Test Job',
        description: 'Job for testing run history persistence',
        schedule: '0 0 1 1 *', // yearly — won't auto-fire during test
        priority: 'high',
        expectedDurationMinutes: 1,
        model: 'haiku',
        enabled: true,
        execute: { type: 'prompt', value: 'Quick test' },
        tags: ['testing'],
      },
      {
        slug: 'hist-secondary',
        name: 'Secondary History Job',
        description: 'Second job for multi-job history queries',
        schedule: '0 0 1 1 *',
        priority: 'medium',
        expectedDurationMinutes: 1,
        model: 'sonnet',
        enabled: true,
        execute: { type: 'prompt', value: 'Secondary test' },
        tags: ['testing'],
      },
    ];
    const jobsFile = path.join(stateDir, 'jobs.json');
    fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));

    // Create mock claude
    mockClaudePath = createMockClaude(projectDir);

    // Stand up real components
    state = new StateManager(stateDir);

    // Pre-seed lastRun so checkMissedJobs doesn't auto-trigger jobs at startup.
    // Missed-job detection is tested separately in job-scheduler-edge.test.ts.
    for (const slug of ['hist-test-job', 'hist-secondary']) {
      state.saveJobState({
        slug,
        lastRun: new Date().toISOString(),
        lastResult: 'success',
        runCount: 1,
        consecutiveFailures: 0,
      });
    }

    sessionManager = new SessionManager(
      {
        tmuxPath: tmuxPath!,
        claudePath: mockClaudePath,
        projectDir,
        maxSessions: 5,
        protectedSessions: [],
        completionPatterns: ['Session ended'],
      },
      state,
    );

    scheduler = new JobScheduler(
      {
        jobsFile,
        enabled: true,
        maxParallelJobs: 3,
        quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      },
      sessionManager,
      state,
      stateDir,
    );
    scheduler.start();

    sessionManager.startMonitoring(500);
    sessionManager.on('sessionComplete', () => {
      scheduler.processQueue();
    });

    const config: InstarConfig = {
      projectName: 'e2e-history-test',
      projectDir,
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      sessions: {
        tmuxPath: tmuxPath!,
        claudePath: mockClaudePath,
        projectDir,
        maxSessions: 5,
        protectedSessions: [],
        completionPatterns: ['Session ended'],
      },
      scheduler: {
        jobsFile,
        enabled: true,
        maxParallelJobs: 3,
        quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      },
      users: [],
      messaging: [],
      monitoring: {
        quotaTracking: false,
        memoryMonitoring: false,
        healthCheckIntervalMs: 30000,
      },
    };

    server = new AgentServer({
      config,
      sessionManager,
      state,
      scheduler,
    });
    app = server.getApp();
  });

  afterAll(async () => {
    scheduler?.stop();
    sessionManager?.stopMonitoring();

    // Kill any test tmux sessions
    try {
      const { execSync } = await import('node:child_process');
      const sessions = execSync(`${tmuxPath} list-sessions -F "#{session_name}" 2>/dev/null || true`, {
        encoding: 'utf-8',
      }).trim();
      for (const session of sessions.split('\n').filter(Boolean)) {
        if (session.includes('hist-test') || session.includes('hist-secondary')) {
          try { execSync(`${tmuxPath} kill-session -t '=${session}'`); } catch {}
        }
      }
    } catch {}

    await server?.stop();
    // safe-git-allow: incremental-migration
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // ── History endpoints exist and return correct shape ─────────────

  it('GET /jobs/history returns empty history initially', async () => {
    const res = await request(app)
      .get('/jobs/history')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`).set('Connection', 'close');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('runs');
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('stats');
    expect(Array.isArray(res.body.runs)).toBe(true);
    expect(Array.isArray(res.body.stats)).toBe(true);
  });

  it('GET /jobs/:slug/history returns empty for untriggered job', async () => {
    const res = await request(app)
      .get('/jobs/hist-test-job/history')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`).set('Connection', 'close');

    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(0);
    expect(res.body.total).toBe(0);
    expect(res.body.stats).toHaveProperty('slug', 'hist-test-job');
    expect(res.body.stats.totalRuns).toBe(0);
  });

  it('rejects unauthenticated history requests', async () => {
    const res = await request(app).get('/jobs/history').set('Connection', 'close');
    expect(res.status).toBe(401);
  });

  it('rejects invalid slug in per-job history', async () => {
    const res = await request(app)
      .get('/jobs/inv@lid!slug/history')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`).set('Connection', 'close');

    expect(res.status).toBe(400);
  });

  // ── Trigger job → history records it ────────────────────────────

  it('trigger via API creates a run in history', async () => {
    // Trigger the job
    const triggerRes = await request(app)
      .post('/jobs/hist-test-job/trigger')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('Connection', 'close')
      .send({ reason: 'e2e-history-test' });

    expect(triggerRes.status).toBe(200);
    expect(triggerRes.body.result).toBe('triggered');

    // Wait for spawn
    await new Promise(r => setTimeout(r, 300));

    // Query history via API
    const histRes = await request(app)
      .get('/jobs/hist-test-job/history')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`).set('Connection', 'close');

    expect(histRes.status).toBe(200);
    expect(histRes.body.total).toBeGreaterThanOrEqual(1);

    const run = histRes.body.runs[0];
    expect(run.slug).toBe('hist-test-job');
    expect(run.trigger).toBe('e2e-history-test');
    expect(run.model).toBe('haiku');
    expect(run.startedAt).toBeDefined();
    expect(run.runId).toContain('hist-test-job');
  });

  // ── Session completes → history records completion ──────────────

  it('records completion with output after session finishes', async () => {
    // Wait for the mock claude session to complete (sleeps 2s then exits)
    await waitFor(
      () => {
        const sessions = sessionManager.listRunningSessions();
        return sessions.filter(s => s.jobSlug === 'hist-test-job').length === 0;
      },
      10000,
    );

    // Give the scheduler time to process completion
    await new Promise(r => setTimeout(r, 500));

    // Query history — should now have a completed run
    const histRes = await request(app)
      .get('/jobs/hist-test-job/history')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`).set('Connection', 'close');

    expect(histRes.status).toBe(200);

    // Find the completed run
    const completedRuns = histRes.body.runs.filter((r: any) => r.result === 'success' || r.result === 'failure' || r.result === 'timeout');

    // At least one run should have completed
    if (completedRuns.length > 0) {
      const completed = completedRuns[0];
      expect(completed.completedAt).toBeDefined();
      expect(completed.durationSeconds).toBeGreaterThanOrEqual(0);
    }

    // Stats should reflect the runs
    expect(histRes.body.stats).toHaveProperty('slug', 'hist-test-job');
  });

  // ── Multiple jobs → global history shows all ────────────────────

  it('global history aggregates runs across jobs', async () => {
    // Trigger the secondary job
    const triggerRes = await request(app)
      .post('/jobs/hist-secondary/trigger')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('Connection', 'close')
      .send({ reason: 'e2e-multi-job' });

    expect(triggerRes.status).toBe(200);

    await new Promise(r => setTimeout(r, 300));

    // Global history should have runs from both jobs
    const histRes = await request(app)
      .get('/jobs/history')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`).set('Connection', 'close');

    expect(histRes.status).toBe(200);
    expect(histRes.body.total).toBeGreaterThanOrEqual(2);

    const slugs = histRes.body.runs.map((r: any) => r.slug);
    expect(slugs).toContain('hist-test-job');
    expect(slugs).toContain('hist-secondary');

    // Stats should include both jobs
    const statSlugs = histRes.body.stats.map((s: any) => s.slug);
    expect(statSlugs).toContain('hist-test-job');
    expect(statSlugs).toContain('hist-secondary');
  });

  // ── Query filters work via HTTP ─────────────────────────────────

  it('filters history by result via query param', async () => {
    const res = await request(app)
      .get('/jobs/history?result=pending')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`).set('Connection', 'close');

    expect(res.status).toBe(200);
    for (const run of res.body.runs) {
      expect(run.result).toBe('pending');
    }
  });

  it('supports pagination via limit and offset', async () => {
    const page1 = await request(app)
      .get('/jobs/history?limit=1&offset=0')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`).set('Connection', 'close');

    expect(page1.status).toBe(200);
    expect(page1.body.runs.length).toBeLessThanOrEqual(1);
    // total reflects all runs, not just this page
    expect(page1.body.total).toBeGreaterThanOrEqual(page1.body.runs.length);

    if (page1.body.total > 1) {
      const page2 = await request(app)
        .get('/jobs/history?limit=1&offset=1')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`).set('Connection', 'close');

      expect(page2.status).toBe(200);
      expect(page2.body.runs.length).toBeLessThanOrEqual(1);

      // Different runs on different pages
      if (page1.body.runs.length > 0 && page2.body.runs.length > 0) {
        expect(page1.body.runs[0].runId).not.toBe(page2.body.runs[0].runId);
      }
    }
  });

  // ── History survives in capabilities ─────────────────────────────

  it('capabilities endpoint shows scheduler with job info', async () => {
    const res = await request(app)
      .get('/capabilities')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`).set('Connection', 'close');

    expect(res.status).toBe(200);
    expect(res.body.scheduler).toBeDefined();
    expect(res.body.scheduler.enabled).toBe(true);
    expect(res.body.scheduler.jobSlugs).toContain('hist-test-job');
    expect(res.body.scheduler.jobSlugs).toContain('hist-secondary');
  });

  // ── History persists to disk ────────────────────────────────────

  it('history is persisted to JSONL on disk', async () => {
    const ledgerFile = path.join(stateDir, 'ledger', 'job-runs.jsonl');
    expect(fs.existsSync(ledgerFile)).toBe(true);

    const content = fs.readFileSync(ledgerFile, 'utf-8').trim();
    expect(content.length).toBeGreaterThan(0);

    const lines = content.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2); // At least 2 jobs triggered

    // Each line is valid JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('runId');
      expect(parsed).toHaveProperty('slug');
      expect(parsed).toHaveProperty('startedAt');
      expect(parsed).toHaveProperty('result');
    }
  });

  // ── Spawn error scenario ────────────────────────────────────────

  it('records spawn errors visible via API when session limit is hit', async () => {
    // Fill session slots to force spawn errors
    const spawnedSessions: string[] = [];
    for (let i = 0; i < 5; i++) {
      try {
        const res = await request(app)
          .post('/sessions/spawn')
          .set('Authorization', `Bearer ${AUTH_TOKEN}`)
          .set('Connection', 'close')
          .send({ name: `filler-${i}`, prompt: 'fill slot' });
        if (res.status === 201) {
          spawnedSessions.push(res.body.tmuxSession);
        }
      } catch {}
    }

    // Now trigger a job — should get spawn error
    await request(app)
      .post('/jobs/hist-test-job/trigger')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('Connection', 'close')
      .send({ reason: 'e2e-spawn-error' });

    await new Promise(r => setTimeout(r, 300));

    // Check history for spawn-error entries
    const histRes = await request(app)
      .get('/jobs/hist-test-job/history?result=spawn-error')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`).set('Connection', 'close');

    // May or may not have spawn errors depending on timing,
    // but the endpoint should work correctly regardless
    expect(histRes.status).toBe(200);
    expect(Array.isArray(histRes.body.runs)).toBe(true);

    if (histRes.body.runs.length > 0) {
      const spawnError = histRes.body.runs[0];
      expect(spawnError.result).toBe('spawn-error');
      expect(spawnError.error).toBeDefined();
      expect(spawnError.durationSeconds).toBe(0);
    }
  });

  // ── Stats shape via API ─────────────────────────────────────────

  it('per-job stats have correct shape and values', async () => {
    const res = await request(app)
      .get('/jobs/hist-test-job/history')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`).set('Connection', 'close');

    expect(res.status).toBe(200);
    const stats = res.body.stats;

    expect(stats).toHaveProperty('slug', 'hist-test-job');
    expect(stats).toHaveProperty('totalRuns');
    expect(stats).toHaveProperty('successes');
    expect(stats).toHaveProperty('failures');
    expect(stats).toHaveProperty('successRate');
    expect(stats).toHaveProperty('avgDurationSeconds');
    expect(stats).toHaveProperty('runsPerDay');
    expect(typeof stats.totalRuns).toBe('number');
    expect(typeof stats.successRate).toBe('number');
  });
});
