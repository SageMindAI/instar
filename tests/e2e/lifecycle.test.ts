/**
 * E2E test — full instar lifecycle from init to running server.
 *
 * Tests the complete user journey:
 *   instar init → configure → server start → health check →
 *   trigger job → relationship tracking → auth enforcement → shutdown
 *
 * Uses real filesystem, real HTTP server (ephemeral port), real scheduler.
 * Mocks tmux sessions via mock-claude script.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { RelationshipManager } from '../../src/core/RelationshipManager.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { loadConfig, ensureStateDir, detectTmuxPath } from '../../src/core/Config.js';
import { createMockClaude, createSampleJobsFile, waitFor } from '../helpers/setup.js';
import type { InstarConfig, JobDefinition } from '../../src/core/types.js';

const tmuxPath = detectTmuxPath();
const describeMaybe = tmuxPath ? describe : describe.skip;

describeMaybe('E2E: Instar lifecycle', () => {
  let projectDir: string;
  let stateDir: string;
  let mockClaudePath: string;
  let state: StateManager;
  let sessionManager: SessionManager;
  let relationships: RelationshipManager;
  let scheduler: JobScheduler;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'e2e-test-token';

  beforeAll(async () => {
    // ── Phase 1: Simulate `instar init` ─────────────────
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-e2e-'));
    stateDir = path.join(projectDir, '.instar');

    // Create directory structure (what init creates)
    const dirs = [
      path.join(stateDir, 'state', 'sessions'),
      path.join(stateDir, 'state', 'jobs'),
      path.join(stateDir, 'logs'),
      path.join(stateDir, 'relationships'),
      path.join(stateDir, 'hooks'),
    ];
    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write config.json (what init generates)
    const configJson = {
      projectName: 'e2e-test-project',
      port: 0, // Will use ephemeral port
      authToken: AUTH_TOKEN,
      sessions: {
        maxSessions: 3,
      },
      scheduler: {
        enabled: true,
        maxParallelJobs: 2,
      },
      relationships: {
        maxRecentInteractions: 20,
      },
    };
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify(configJson, null, 2),
    );

    // Write jobs.json with a fast-firing job
    const jobs: JobDefinition[] = [
      {
        slug: 'e2e-health',
        name: 'E2E Health Check',
        description: 'Fast health check for E2E testing',
        schedule: '* * * * * *', // Every second
        priority: 'high',
        expectedDurationMinutes: 1,
        model: 'haiku',
        enabled: true,
        execute: { type: 'prompt', value: 'Quick health check' },
        tags: ['monitoring'],
      },
    ];
    const jobsFile = path.join(stateDir, 'jobs.json');
    fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));

    // Create mock claude
    mockClaudePath = createMockClaude(projectDir);

    // ── Phase 2: Simulate `instar server start` ─────────
    state = new StateManager(stateDir);

    sessionManager = new SessionManager(
      {
        tmuxPath: tmuxPath!,
        claudePath: mockClaudePath,
        projectDir,
        maxSessions: 3,
        protectedSessions: [],
        completionPatterns: ['Session ended'],
      },
      state,
    );

    relationships = new RelationshipManager({
      relationshipsDir: path.join(stateDir, 'relationships'),
      maxRecentInteractions: 20,
    });

    scheduler = new JobScheduler(
      {
        jobsFile,
        enabled: true,
        maxParallelJobs: 2,
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
      projectName: 'e2e-test-project',
      projectDir,
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      sessions: {
        tmuxPath: tmuxPath!,
        claudePath: mockClaudePath,
        projectDir,
        maxSessions: 3,
        protectedSessions: [],
        completionPatterns: ['Session ended'],
      },
      scheduler: {
        jobsFile,
        enabled: true,
        maxParallelJobs: 2,
        quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      },
      users: [],
      messaging: [],
      monitoring: {
        quotaTracking: false,
        memoryMonitoring: false,
        healthCheckIntervalMs: 30000,
      },
      relationships: {
        relationshipsDir: path.join(stateDir, 'relationships'),
        maxRecentInteractions: 20,
      },
    };

    server = new AgentServer({
      config,
      sessionManager,
      state,
      scheduler,
      relationships,
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
        if (session.includes('e2e-') || session.includes('job-e2e-')) {
          try { execSync(`${tmuxPath} kill-session -t '=${session}'`); } catch {}
        }
      }
    } catch {}

    await server?.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // ── Phase 3: Verify server health ────────────────────────

  it('health endpoint returns project info', async () => {
    // project field is only included for authenticated callers
    const res = await request(app)
      .get('/health')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.project).toBe('e2e-test-project');
  });

  // ── Phase 4: Auth enforcement ────────────────────────────

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/status');
    expect(res.status).toBe(401);
  });

  it('accepts authenticated requests', async () => {
    const res = await request(app)
      .get('/status')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.sessions.max).toBe(3);
    expect(res.body.scheduler.running).toBe(true);
  });

  // ── Phase 5: Session spawn via API ───────────────────────

  it('spawns a session via API', async () => {
    const res = await request(app)
      .post('/sessions/spawn')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ name: 'e2e-test-session', prompt: 'Hello from E2E test' });

    expect(res.status).toBe(201);
    expect(res.body.tmuxSession).toContain('e2e-test-session');
    expect(res.body.status).toBe('running');

    // Verify session appears in list
    await new Promise(r => setTimeout(r, 500));
    const statusRes = await request(app)
      .get('/status')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(statusRes.body.sessions.running).toBeGreaterThanOrEqual(1);
  });

  // ── Phase 6: Job trigger via API ─────────────────────────

  it('triggers a job via API and verifies event log', async () => {
    // Pause the scheduler so cron-spawned sessions don't fill all job slots
    scheduler.pause();

    // Wait for any running job sessions to complete (mock-claude sleeps 2s)
    await waitFor(
      () => {
        const running = sessionManager.listRunningSessions().filter(s => s.jobSlug);
        return running.length === 0;
      },
      5000,
      'running job sessions to drain',
    );

    // Clear any queued jobs that accumulated while paused, then resume.
    // Without clearing, resume() calls processQueue() which may immediately
    // fill job slots before our trigger call (race condition).
    scheduler.clearQueue();
    scheduler.resume();

    const triggerRes = await request(app)
      .post('/jobs/e2e-health/trigger')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ reason: 'e2e-test' });

    expect(triggerRes.status).toBe(200);
    expect(triggerRes.body.result).toBe('triggered');

    // Wait for spawn to complete
    await new Promise(r => setTimeout(r, 200));

    // Verify event was logged
    const eventsRes = await request(app)
      .get('/events?since=1')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(eventsRes.status).toBe(200);
    const jobEvents = eventsRes.body.filter((e: any) => e.type === 'job_triggered');
    expect(jobEvents.length).toBeGreaterThanOrEqual(1);
  });

  // ── Phase 7: Cron-triggered job ──────────────────────────

  it('cron triggers jobs automatically', async () => {
    // The e2e-health job fires every second — wait for it
    await waitFor(
      () => {
        const events = state.queryEvents({ type: 'job_triggered' });
        return events.filter(e => e.summary?.includes('scheduled')).length > 0;
      },
      5000,
    );

    const events = state.queryEvents({ type: 'job_triggered' });
    const scheduledEvents = events.filter(e => e.summary?.includes('scheduled'));
    expect(scheduledEvents.length).toBeGreaterThan(0);
  });

  // ── Phase 8: Relationship tracking ───────────────────────

  it('creates and retrieves relationships through the full stack', async () => {
    // Create a relationship programmatically
    const record = relationships.findOrCreate('E2E User', {
      type: 'telegram',
      identifier: 'e2e-999',
    });
    relationships.recordInteraction(record.id, {
      timestamp: new Date().toISOString(),
      channel: 'telegram',
      summary: 'E2E lifecycle test interaction',
      topics: ['e2e', 'testing'],
    });

    // Verify via API
    const listRes = await request(app)
      .get('/relationships')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.relationships.some((r: any) => r.name === 'E2E User')).toBe(true);

    // Verify context generation
    const ctxRes = await request(app)
      .get(`/relationships/${record.id}/context`)
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(ctxRes.status).toBe(200);
    expect(ctxRes.body.context).toContain('<relationship_context person="E2E User">');
    expect(ctxRes.body.context).toContain('e2e');
    expect(ctxRes.body.context).toContain('E2E lifecycle test interaction');

    // Verify disk persistence
    const filePath = path.join(stateDir, 'relationships', `${record.id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(onDisk.name).toBe('E2E User');
    expect(onDisk.interactionCount).toBe(1);
  });

  // ── Phase 9: Session lifecycle (spawn → complete) ────────

  it('detects session completion and updates state', async () => {
    // Pause the scheduler so cron jobs don't fill session slots
    scheduler.pause();

    // Wait for existing job sessions to complete (mock claude exits after ~2s)
    await waitFor(
      () => sessionManager.listRunningSessions().length < 3,
      8000,
    );

    const session = await sessionManager.spawnSession({
      name: 'e2e-lifecycle-complete',
      prompt: 'echo done',
    });

    // Mock claude sleeps 2s then exits — wait for completion
    await waitFor(
      () => {
        const saved = state.getSession(session.id);
        return saved?.status === 'completed';
      },
      8000,
    );

    const saved = state.getSession(session.id);
    expect(saved?.status).toBe('completed');
    expect(saved?.endedAt).toBeTruthy();
  });

  // ── Phase 10: Verify state persistence ───────────────────

  it('all state survives to disk', () => {
    // Sessions persisted
    const sessionFiles = fs.readdirSync(path.join(stateDir, 'state', 'sessions'));
    expect(sessionFiles.length).toBeGreaterThan(0);

    // Job state persisted
    const jobState = state.getJobState('e2e-health');
    expect(jobState).not.toBeNull();
    expect(jobState!.lastRun).toBeTruthy();

    // Relationships persisted
    const relFiles = fs.readdirSync(path.join(stateDir, 'relationships'));
    expect(relFiles.length).toBeGreaterThan(0);

    // Events persisted
    const events = state.queryEvents({});
    expect(events.length).toBeGreaterThan(0);
  });
});
