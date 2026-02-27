/**
 * Unit tests for update config route and auto-apply behavior.
 *
 * Covers: GET /updates/config, autoApply defaults, config persistence.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('Update config route', () => {
  const AUTH_TOKEN = 'test-update-config-token';

  function createServer(project: TempProject, updates?: { autoApply: boolean }) {
    const mockSM = createMockSessionManager();
    const config: InstarConfig = {
      projectName: 'update-config-test',
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
      updates,
    };

    const server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state: project.state,
    });
    return server.getApp();
  }

  describe('GET /updates/config', () => {
    let project: TempProject;

    beforeAll(() => {
      project = createTempProject();
    });

    afterAll(() => {
      project.cleanup();
    });

    it('returns autoApply: true by default when updates config is not set', async () => {
      const app = createServer(project);
      const res = await request(app)
        .get('/updates/config')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.autoApply).toBe(true);
    });

    it('returns autoApply: false when explicitly set to false', async () => {
      const app = createServer(project, { autoApply: false });
      const res = await request(app)
        .get('/updates/config')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.autoApply).toBe(false);
    });

    it('returns autoApply: true when set to true', async () => {
      const app = createServer(project, { autoApply: true });
      const res = await request(app)
        .get('/updates/config')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.autoApply).toBe(true);
    });

    it('requires auth', async () => {
      const app = createServer(project);
      const res = await request(app).get('/updates/config');
      expect(res.status).toBe(401);
    });
  });
});
