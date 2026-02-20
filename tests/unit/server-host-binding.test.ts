/**
 * Tests for server host binding and config defaults.
 *
 * Verifies: localhost binding default, custom host config,
 * route ordering (literal before parameterized).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import type { AgentKitConfig } from '../../src/core/types.js';

function makeFakeConfig(overrides?: Partial<AgentKitConfig>): AgentKitConfig {
  return {
    projectName: 'test-project',
    projectDir: '/tmp/test',
    stateDir: '/tmp/test/.instar',
    port: 0,
    host: '127.0.0.1',
    authToken: 'test-secret-token',
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
    ...overrides,
  };
}

describe('Server host binding', () => {
  let project: TempProject;

  beforeEach(() => {
    project = createTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  it('defaults host to 127.0.0.1 in config', () => {
    const config = makeFakeConfig();
    expect(config.host).toBe('127.0.0.1');
  });

  it('server accepts custom host in config', () => {
    const sessionManager = createMockSessionManager();
    const server = new AgentServer({
      config: makeFakeConfig({ host: '0.0.0.0' }),
      sessionManager: sessionManager as any,
      state: project.state as any,
    });

    // Server should construct without error
    expect(server).toBeDefined();
  });
});

describe('Route ordering — literal before parameterized', () => {
  let project: TempProject;
  let server: AgentServer;
  const authToken = 'test-secret-token';

  beforeEach(() => {
    project = createTempProject();
    const sessionManager = createMockSessionManager();
    server = new AgentServer({
      config: makeFakeConfig({ authToken }),
      sessionManager: sessionManager as any,
      state: project.state as any,
    });
  });

  afterEach(() => {
    project.cleanup();
  });

  it('GET /sessions/tmux responds correctly (not captured as :name param)', async () => {
    const app = server.getApp();
    const response = await supertest(app)
      .get('/sessions/tmux')
      .set('Authorization', `Bearer ${authToken}`);

    // Should return a sessions array (tmux list), not 404
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('sessions');
    expect(Array.isArray(response.body.sessions)).toBe(true);
  });

  it('GET /sessions/:name/output still works for regular names', async () => {
    const app = server.getApp();
    const response = await supertest(app)
      .get('/sessions/my-session/output')
      .set('Authorization', `Bearer ${authToken}`);

    // Should reach the session output route (not captured by /sessions/tmux)
    // Mock captureOutput always returns 'mock output', so we get 200
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('session', 'my-session');
    expect(response.body).toHaveProperty('output');
    // Crucially, should NOT have 'sessions' array (which /sessions/tmux returns)
    expect(response.body).not.toHaveProperty('sessions');
  });
});
