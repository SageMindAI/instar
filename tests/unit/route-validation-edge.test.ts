/**
 * Route validation edge case tests — validates input constraints
 * on all API endpoints that accept user input.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { AgentKitConfig } from '../../src/core/types.js';

describe('Route validation edge cases', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let app: ReturnType<AgentServer['getApp']>;

  const fakeConfig: AgentKitConfig = {
    projectName: 'test-validation',
    projectDir: '/tmp/test',
    stateDir: '/tmp/test/.instar',
    port: 0,
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
      config: fakeConfig,
      sessionManager: mockSM as any,
      state: project.state,
    });
    app = server.getApp();
  });

  afterAll(() => {
    project.cleanup();
  });

  describe('POST /sessions/spawn', () => {
    it('rejects invalid model value', async () => {
      const res = await request(app)
        .post('/sessions/spawn')
        .send({ name: 'test', prompt: 'hello', model: 'gpt-4' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('model');
    });

    it('rejects name over 200 characters', async () => {
      const res = await request(app)
        .post('/sessions/spawn')
        .send({ name: 'x'.repeat(201), prompt: 'hello' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('200');
    });

    it('rejects non-string name', async () => {
      const res = await request(app)
        .post('/sessions/spawn')
        .send({ name: 123, prompt: 'hello' });
      expect(res.status).toBe(400);
    });

    it('rejects prompt over 500KB', async () => {
      const res = await request(app)
        .post('/sessions/spawn')
        .send({ name: 'test', prompt: 'x'.repeat(500_001) });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('500KB');
    });

    it('accepts valid model values', async () => {
      for (const model of ['opus', 'sonnet', 'haiku']) {
        const res = await request(app)
          .post('/sessions/spawn')
          .send({ name: `test-${model}`, prompt: 'hello', model });
        // Would be 201 if spawn succeeds, or 500 if tmux fails (expected in test env)
        // The important thing is it's NOT 400
        expect(res.status).not.toBe(400);
      }
    });
  });

  describe('POST /sessions/:name/input', () => {
    it('rejects non-string text', async () => {
      const res = await request(app)
        .post('/sessions/test/input')
        .send({ text: 42 });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('text');
    });

    it('rejects oversized input (>100KB)', async () => {
      const res = await request(app)
        .post('/sessions/test/input')
        .send({ text: 'x'.repeat(100_001) });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('100KB');
    });

    it('rejects empty text', async () => {
      const res = await request(app)
        .post('/sessions/test/input')
        .send({ text: '' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /sessions/:name/output', () => {
    it('parses lines query parameter', async () => {
      const res = await request(app)
        .get('/sessions/test-session/output?lines=50');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('output');
    });

    it('defaults lines when not specified', async () => {
      const res = await request(app)
        .get('/sessions/test-session/output');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /sessions with status filter', () => {
    it('accepts valid status values', async () => {
      for (const status of ['running', 'completed', 'failed', 'killed', 'starting']) {
        const res = await request(app)
          .get(`/sessions?status=${status}`);
        expect(res.status).toBe(200);
        expect(res.body).toBeInstanceOf(Array);
      }
    });

    it('ignores invalid status and returns all sessions', async () => {
      const res = await request(app)
        .get('/sessions?status=invalid');
      expect(res.status).toBe(200);
      expect(res.body).toBeInstanceOf(Array);
    });
  });

  describe('Optional service routes when not configured', () => {
    it('GET /relationships returns empty when not configured', async () => {
      const res = await request(app).get('/relationships');
      expect(res.status).toBe(200);
      expect(res.body.relationships).toEqual([]);
    });

    it('GET /relationships/stale returns empty when not configured', async () => {
      const res = await request(app).get('/relationships/stale');
      expect(res.status).toBe(200);
      expect(res.body.stale).toEqual([]);
    });

    it('GET /relationships/:id returns 503 when not configured', async () => {
      const res = await request(app).get('/relationships/some-id');
      expect(res.status).toBe(503);
    });

    it('GET /relationships/:id/context returns 503 when not configured', async () => {
      const res = await request(app).get('/relationships/some-id/context');
      expect(res.status).toBe(503);
    });

    it('POST /telegram/reply/:topicId returns 503 when not configured', async () => {
      const res = await request(app)
        .post('/telegram/reply/123')
        .send({ text: 'hello' });
      expect(res.status).toBe(503);
    });

    it('GET /quota returns not_configured when no tracker', async () => {
      const res = await request(app).get('/quota');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('not_configured');
    });

    it('GET /feedback returns empty when not configured', async () => {
      const res = await request(app).get('/feedback');
      expect(res.status).toBe(200);
      expect(res.body.feedback).toEqual([]);
    });

    it('POST /feedback returns 503 when not configured', async () => {
      const res = await request(app)
        .post('/feedback')
        .send({ title: 'test', description: 'test' });
      expect(res.status).toBe(503);
    });

    it('POST /feedback/retry returns 503 when not configured', async () => {
      const res = await request(app).post('/feedback/retry');
      expect(res.status).toBe(503);
    });

    it('GET /updates returns 503 when not configured', async () => {
      const res = await request(app).get('/updates');
      expect(res.status).toBe(503);
    });

    it('GET /updates/last returns 503 when not configured', async () => {
      const res = await request(app).get('/updates/last');
      expect(res.status).toBe(503);
    });
  });

  describe('GET /events', () => {
    it('respects limit parameter', async () => {
      // Add multiple events
      for (let i = 0; i < 5; i++) {
        project.state.appendEvent({
          type: 'test',
          summary: `Event ${i}`,
          timestamp: new Date().toISOString(),
        });
      }

      const res = await request(app).get('/events?limit=2');
      expect(res.status).toBe(200);
      expect(res.body.length).toBeLessThanOrEqual(2);
    });

    it('filters by type', async () => {
      project.state.appendEvent({
        type: 'special_type',
        summary: 'Special event',
        timestamp: new Date().toISOString(),
      });

      const res = await request(app).get('/events?type=special_type');
      expect(res.status).toBe(200);
      for (const event of res.body) {
        expect(event.type).toBe('special_type');
      }
    });

    it('filters by since hours', async () => {
      const res = await request(app).get('/events?since=1');
      expect(res.status).toBe(200);
      expect(res.body).toBeInstanceOf(Array);
    });
  });
});
