/**
 * Integration test — iMessage HTTP routes through the full Express pipeline.
 *
 * Tests /imessage/status, /imessage/send, /imessage/chats, /imessage/search,
 * /imessage/log-stats endpoints with a real IMessageAdapter instance (no mocks
 * for adapter internals). The imsg RPC process is NOT started — only the
 * adapter's HTTP surface is tested.
 *
 * Tier 2: Full HTTP pipeline. Do the API routes work when the feature is available?
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { IMessageAdapter } from '../../src/messaging/imessage/IMessageAdapter.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('iMessage HTTP routes integration', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let imessageAdapter: IMessageAdapter;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'imessage-routes-test-token';

  beforeAll(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();

    // Create iMessage adapter (RPC process not started — tests HTTP surface only)
    imessageAdapter = new IMessageAdapter(
      { authorizedSenders: ['+14081234567', 'user@icloud.com'] },
      project.stateDir,
    );

    const config: InstarConfig = {
      projectName: 'imessage-routes-test',
      projectDir: project.dir,
      stateDir: project.stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      sessions: {
        tmuxPath: '/usr/bin/tmux',
        claudePath: '/usr/bin/claude',
        projectDir: project.dir,
        maxSessions: 5,
        protectedSessions: [],
        completionPatterns: [],
      },
      users: [],
      messaging: [{ type: 'imessage', enabled: true, config: { authorizedSenders: ['+14081234567'] } }],
      monitoring: {
        quotaTracking: false,
        memoryMonitoring: false,
        healthCheckIntervalMs: 30000,
      },
      scheduler: { enabled: false, timezone: 'UTC' },
    };

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state: project.state,
      imessage: imessageAdapter,
    });
    app = server.getApp();
  });

  afterAll(() => {
    project.cleanup();
  });

  // ── Auth enforcement ─────────────────────────────────────────

  describe('auth enforcement', () => {
    it('returns 401 for /imessage/status without Bearer token', async () => {
      const res = await request(app).get('/imessage/status');
      expect(res.status).toBe(401);
    });

    it('returns 401 for /imessage/chats without Bearer token', async () => {
      const res = await request(app).get('/imessage/chats');
      expect(res.status).toBe(401);
    });

    it('returns 401 for /imessage/search without Bearer token', async () => {
      const res = await request(app).get('/imessage/search?q=hello');
      expect(res.status).toBe(401);
    });

    it('returns 401 for /imessage/log-stats without Bearer token', async () => {
      const res = await request(app).get('/imessage/log-stats');
      expect(res.status).toBe(401);
    });
  });

  // ── /imessage/status ─────────────────────────────────────────

  describe('GET /imessage/status', () => {
    it('returns connection info with proper shape', async () => {
      const res = await request(app)
        .get('/imessage/status')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('state');
      expect(res.body).toHaveProperty('reconnectAttempts');
      expect(res.body.state).toBe('disconnected'); // RPC process not started
    });
  });

  // ── /imessage/reply ──────────────────────────────────────────

  describe('POST /imessage/reply/:recipient', () => {
    it('logs outbound message and returns 200', async () => {
      const res = await request(app)
        .post('/imessage/reply/+14081234567')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({ text: 'Response from agent' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.logged).toBe(true);
    });

    it('returns 400 when text field is missing', async () => {
      const res = await request(app)
        .post('/imessage/reply/+14081234567')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('text');
    });
  });

  // ── /imessage/log-stats ──────────────────────────────────────

  describe('GET /imessage/log-stats', () => {
    it('returns log statistics', async () => {
      const res = await request(app)
        .get('/imessage/log-stats')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('totalMessages');
      expect(res.body).toHaveProperty('logSizeBytes');
      expect(res.body).toHaveProperty('logPath');
      expect(typeof res.body.totalMessages).toBe('number');
    });
  });

  // ── /imessage/search ─────────────────────────────────────────

  describe('GET /imessage/search', () => {
    it('returns 400 when q parameter is missing', async () => {
      const res = await request(app)
        .get('/imessage/search')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('q parameter');
    });

    it('returns empty results for non-matching query', async () => {
      const res = await request(app)
        .get('/imessage/search?q=nonexistent')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([]);
      expect(res.body.count).toBe(0);
    });
  });

  // ── /capabilities includes iMessage ──────────────────────────

  describe('GET /capabilities', () => {
    it('includes iMessage section in capabilities', async () => {
      const res = await request(app)
        .get('/capabilities')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('imessage');
      expect(res.body.imessage.configured).toBe(true);
      expect(res.body.imessage.adapter).toBe(true);
      expect(Array.isArray(res.body.imessage.endpoints)).toBe(true);
      expect(res.body.imessage.endpoints.length).toBeGreaterThan(0);
    });
  });
});

// ── 503 behavior when adapter is not configured ────────────────

describe('iMessage routes — unconfigured adapter', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'imessage-unconfigured-test';

  beforeAll(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();

    const config: InstarConfig = {
      projectName: 'imessage-no-adapter-test',
      projectDir: project.dir,
      stateDir: project.stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      sessions: {
        tmuxPath: '/usr/bin/tmux',
        claudePath: '/usr/bin/claude',
        projectDir: project.dir,
        maxSessions: 5,
        protectedSessions: [],
        completionPatterns: [],
      },
      users: [],
      messaging: [],
      monitoring: {
        quotaTracking: false,
        memoryMonitoring: false,
        healthCheckIntervalMs: 30000,
      },
      scheduler: { enabled: false, timezone: 'UTC' },
    };

    // No imessage adapter passed
    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state: project.state,
    });
    app = server.getApp();
  });

  afterAll(() => {
    project.cleanup();
  });

  it('GET /imessage/status returns 503 when not configured', async () => {
    const res = await request(app)
      .get('/imessage/status')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('not configured');
  });

  it('POST /imessage/reply returns 503 when not configured', async () => {
    const res = await request(app)
      .post('/imessage/reply/+14081234567')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ text: 'hello' });
    expect(res.status).toBe(503);
  });

  it('GET /imessage/chats returns 503 when not configured', async () => {
    const res = await request(app)
      .get('/imessage/chats')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(res.status).toBe(503);
  });

  it('GET /imessage/search returns 503 when not configured', async () => {
    const res = await request(app)
      .get('/imessage/search?q=hello')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(res.status).toBe(503);
  });

  it('GET /imessage/log-stats returns 503 when not configured', async () => {
    const res = await request(app)
      .get('/imessage/log-stats')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(res.status).toBe(503);
  });

  it('GET /capabilities shows imessage as unconfigured', async () => {
    const res = await request(app)
      .get('/capabilities')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.imessage.configured).toBe(false);
    expect(res.body.imessage.adapter).toBe(false);
    expect(res.body.imessage.endpoints).toEqual([]);
  });
});
