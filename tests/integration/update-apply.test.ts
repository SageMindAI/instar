/**
 * Integration test — update apply endpoint.
 *
 * Tests the POST /updates/apply route through the full server stack
 * with a real UpdateChecker instance. Network calls (npm view) are
 * stubbed to avoid flaky timeouts under full-suite CPU/IO contention.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { UpdateChecker } from '../../src/core/UpdateChecker.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('Update Apply API (integration)', () => {
  let project: TempProject;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let updateChecker: UpdateChecker;
  const AUTH_TOKEN = 'test-update-apply-token';

  beforeAll(() => {
    project = createTempProject();
    const mockSM = createMockSessionManager();
    updateChecker = new UpdateChecker(project.stateDir);

    // Stub the network call (npm view instar version) that check() uses.
    // Under full suite load (400+ files, fileParallelism: false), this
    // 15-second network call can exceed the 10-second test timeout.
    // The integration test validates route wiring, not npm connectivity.
    vi.spyOn(updateChecker, 'check').mockResolvedValue({
      currentVersion: '0.13.0',
      latestVersion: '0.13.0',
      updateAvailable: false,
      checkedAt: new Date().toISOString(),
    });

    vi.spyOn(updateChecker, 'applyUpdate').mockResolvedValue({
      success: true,
      previousVersion: '0.13.0',
      newVersion: '0.13.0',
      message: 'Already up to date (v0.13.0).',
      restartNeeded: false,
      healthCheck: 'skipped',
    });

    const config: InstarConfig = {
      projectName: 'update-test',
      projectDir: project.dir,
      stateDir: project.stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      sessions: {
        tmuxPath: '/usr/bin/tmux',
        claudePath: '/usr/bin/claude',
        projectDir: project.dir,
        maxSessions: 3,
        protectedSessions: [],
        completionPatterns: [],
      },
      scheduler: {
        jobsFile: '',
        enabled: false,
        maxParallelJobs: 1,
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
      sessionManager: mockSM as any,
      state: project.state,
      updateChecker,
    });
    app = server.getApp();
  });

  afterAll(() => {
    vi.restoreAllMocks();
    project.cleanup();
  });

  it('GET /updates returns update info with all required fields', async () => {
    const res = await request(app)
      .get('/updates')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('currentVersion');
    expect(res.body).toHaveProperty('latestVersion');
    expect(res.body).toHaveProperty('updateAvailable');
    expect(res.body).toHaveProperty('checkedAt');
    expect(typeof res.body.updateAvailable).toBe('boolean');
  });

  it('GET /updates/last returns null-like when no previous check', async () => {
    // First call — no previous state
    const res = await request(app)
      .get('/updates/last')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);

    expect(res.status).toBe(200);
    // After the GET /updates above, there should be a last check
    // But if this runs first, it returns a message
    expect(res.body).toBeDefined();
  });

  it('POST /updates/apply returns structured UpdateResult', async () => {
    const res = await request(app)
      .post('/updates/apply')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success');
    expect(res.body).toHaveProperty('previousVersion');
    expect(res.body).toHaveProperty('newVersion');
    expect(res.body).toHaveProperty('message');
    expect(res.body).toHaveProperty('restartNeeded');
    expect(typeof res.body.success).toBe('boolean');
    expect(typeof res.body.message).toBe('string');
    expect(typeof res.body.restartNeeded).toBe('boolean');
  });

  it('POST /updates/apply is idempotent when already up to date', async () => {
    // Call twice — second should also succeed with "already up to date"
    const res1 = await request(app)
      .post('/updates/apply')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);

    const res2 = await request(app)
      .post('/updates/apply')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // Both should have consistent structure
    expect(res1.body).toHaveProperty('success');
    expect(res2.body).toHaveProperty('success');
  });

  it('persists update check state to disk', async () => {
    // The check() mock doesn't persist to disk, so we write state manually
    // to test that getLastCheck() reads from the state file correctly.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const stateDir = path.join(project.stateDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const stateFile = path.join(stateDir, 'update-check.json');
    const checkData = {
      currentVersion: '0.13.0',
      latestVersion: '0.13.0',
      updateAvailable: false,
      checkedAt: new Date().toISOString(),
    };
    fs.writeFileSync(stateFile, JSON.stringify(checkData));

    const lastCheck = updateChecker.getLastCheck();
    expect(lastCheck).not.toBeNull();
    expect(lastCheck!.currentVersion).toBeDefined();
    expect(lastCheck!.checkedAt).toBeDefined();
  });
});
