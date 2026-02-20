/**
 * Tests that the health endpoint only reveals detailed info
 * (project name, version, memory) to callers with a valid auth token.
 *
 * Regression: Previously, ANY Authorization header (even invalid)
 * would expose detailed info because authMiddleware skips /health.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('Health endpoint auth gating', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'test-secret-token-123';

  const config: InstarConfig = {
    projectName: 'auth-gating-test',
    projectDir: '/tmp/test',
    stateDir: '/tmp/test/.instar',
    port: 0,
    authToken: AUTH_TOKEN,
    sessions: {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/bin/claude',
      projectDir: '/tmp/test',
      maxSessions: 3,
      protectedSessions: [],
      completionPatterns: [],
    },
    scheduler: {
      jobsFile: '',
      enabled: false,
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
  };

  beforeAll(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();
    const server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state: project.state,
    });
    app = server.getApp();
  });

  afterAll(() => {
    project.cleanup();
  });

  it('returns basic info without auth header', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.uptime).toBeDefined();
    // Should NOT have detailed fields
    expect(res.body.project).toBeUndefined();
    expect(res.body.version).toBeUndefined();
    expect(res.body.memory).toBeUndefined();
  });

  it('returns basic info with invalid auth token', async () => {
    const res = await request(app)
      .get('/health')
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    // Should NOT have detailed fields
    expect(res.body.project).toBeUndefined();
    expect(res.body.version).toBeUndefined();
    expect(res.body.memory).toBeUndefined();
  });

  it('returns detailed info with valid auth token', async () => {
    const res = await request(app)
      .get('/health')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.project).toBe('auth-gating-test');
    expect(res.body.memory).toBeDefined();
  });

  it('returns basic info with non-Bearer auth header', async () => {
    const res = await request(app)
      .get('/health')
      .set('Authorization', 'Basic dXNlcjpwYXNz');
    expect(res.status).toBe(200);
    expect(res.body.project).toBeUndefined();
  });
});
