/**
 * Integration test — External Operation Safety API routes.
 *
 * Tests the full HTTP API for:
 * - ExternalOperationGate (classify, evaluate, log, permissions)
 * - MessageSentinel (classify, stats)
 * - AdaptiveTrust (profile, summary, grant, elevations, changelog)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { ExternalOperationGate, AUTONOMY_PROFILES } from '../../src/core/ExternalOperationGate.js';
import { MessageSentinel } from '../../src/core/MessageSentinel.js';
import { AdaptiveTrust } from '../../src/core/AdaptiveTrust.js';
import {
  createTempProject,
  createMockSessionManager,
} from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('External Operation Safety API routes', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let operationGate: ExternalOperationGate;
  let sentinel: MessageSentinel;
  let adaptiveTrust: AdaptiveTrust;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'test-auth-safety';

  beforeAll(async () => {
    project = createTempProject();
    mockSM = createMockSessionManager();

    operationGate = new ExternalOperationGate({
      stateDir: project.stateDir,
      autonomyDefaults: AUTONOMY_PROFILES.collaborative,
      services: {
        gmail: {
          permissions: ['read', 'write', 'modify'],
          blocked: ['delete'],
          requireApproval: ['write'],
        },
      },
      readOnlyServices: ['analytics'],
    });

    sentinel = new MessageSentinel({});
    adaptiveTrust = new AdaptiveTrust({ stateDir: project.stateDir });

    const config: InstarConfig = {
      projectName: 'test-safety-project',
      projectDir: project.dir,
      stateDir: project.stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      requestTimeoutMs: 5000,
      sessions: { maxSessions: 3 },
      scheduler: { enabled: false },
      users: [],
      messaging: [],
      monitoring: {},
    };

    server = new AgentServer({
      config,
      sessionManager: mockSM.manager,
      state: mockSM.state,
      operationGate,
      sentinel,
      adaptiveTrust,
    });

    app = server.getApp();
  });

  afterAll(() => {
    project.cleanup();
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  // ── ExternalOperationGate Routes ───────────────────────────────

  describe('POST /operations/classify', () => {
    it('classifies a read operation as low risk', async () => {
      const res = await request(app)
        .post('/operations/classify')
        .set(auth())
        .send({
          service: 'gmail',
          mutability: 'read',
          reversibility: 'reversible',
          description: 'Fetch inbox',
        });

      expect(res.status).toBe(200);
      expect(res.body.riskLevel).toBe('low');
      expect(res.body.scope).toBe('single');
      expect(res.body.service).toBe('gmail');
    });

    it('classifies bulk delete as critical', async () => {
      const res = await request(app)
        .post('/operations/classify')
        .set(auth())
        .send({
          service: 'gmail',
          mutability: 'delete',
          reversibility: 'irreversible',
          description: 'Delete old emails',
          itemCount: 200,
        });

      expect(res.status).toBe(200);
      expect(res.body.riskLevel).toBe('critical');
      expect(res.body.scope).toBe('bulk');
    });

    it('rejects missing fields', async () => {
      const res = await request(app)
        .post('/operations/classify')
        .set(auth())
        .send({ service: 'gmail' });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /operations/evaluate', () => {
    it('blocks deleted operations on gmail (per config)', async () => {
      const res = await request(app)
        .post('/operations/evaluate')
        .set(auth())
        .send({
          service: 'gmail',
          mutability: 'delete',
          reversibility: 'reversible',
          description: 'Delete an email',
        });

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('block');
      expect(res.body.reason).toContain('blocked');
    });

    it('allows read operations', async () => {
      const res = await request(app)
        .post('/operations/evaluate')
        .set(auth())
        .send({
          service: 'gmail',
          mutability: 'read',
          reversibility: 'reversible',
          description: 'Fetch emails',
        });

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('proceed');
    });

    it('blocks mutations on read-only services', async () => {
      const res = await request(app)
        .post('/operations/evaluate')
        .set(auth())
        .send({
          service: 'analytics',
          mutability: 'write',
          reversibility: 'reversible',
          description: 'Post event',
        });

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('block');
      expect(res.body.reason).toContain('read-only');
    });

    it('requires approval for gmail writes (per config)', async () => {
      const res = await request(app)
        .post('/operations/evaluate')
        .set(auth())
        .send({
          service: 'gmail',
          mutability: 'write',
          reversibility: 'reversible',
          description: 'Send an email',
        });

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('show-plan');
      expect(res.body.plan).toBeDefined();
    });

    it('includes checkpoint for batch operations', async () => {
      const res = await request(app)
        .post('/operations/evaluate')
        .set(auth())
        .send({
          service: 'gmail',
          mutability: 'modify',
          reversibility: 'reversible',
          description: 'Label emails',
          itemCount: 10,
        });

      expect(res.status).toBe(200);
      expect(res.body.checkpoint).toBeDefined();
      expect(res.body.checkpoint.afterCount).toBe(5);
    });
  });

  describe('GET /operations/log', () => {
    it('returns operation log after evaluations', async () => {
      const res = await request(app)
        .get('/operations/log')
        .set(auth());

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      // Should have entries from the evaluate calls above
      expect(res.body.length).toBeGreaterThan(0);
    });

    it('respects limit parameter', async () => {
      const res = await request(app)
        .get('/operations/log?limit=2')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.length).toBeLessThanOrEqual(2);
    });
  });

  describe('GET /operations/permissions/:service', () => {
    it('returns permissions for configured service', async () => {
      const res = await request(app)
        .get('/operations/permissions/gmail')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(true);
      expect(res.body.permissions).toContain('read');
      expect(res.body.blocked).toContain('delete');
    });

    it('returns unconfigured for unknown service', async () => {
      const res = await request(app)
        .get('/operations/permissions/unknown-service')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(false);
    });

    it('returns read-only for read-only services', async () => {
      const res = await request(app)
        .get('/operations/permissions/analytics')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(true);
      expect(res.body.permissions).toEqual(['read']);
    });
  });

  // ── MessageSentinel Routes ─────────────────────────────────────

  describe('POST /sentinel/classify', () => {
    it('classifies "stop" as emergency-stop', async () => {
      const res = await request(app)
        .post('/sentinel/classify')
        .set(auth())
        .send({ message: 'stop' });

      expect(res.status).toBe(200);
      expect(res.body.category).toBe('emergency-stop');
      expect(res.body.action.type).toBe('kill-session');
      expect(res.body.method).toBe('fast-path');
    });

    it('classifies "wait" as pause', async () => {
      const res = await request(app)
        .post('/sentinel/classify')
        .set(auth())
        .send({ message: 'wait' });

      expect(res.status).toBe(200);
      expect(res.body.category).toBe('pause');
      expect(res.body.action.type).toBe('pause-session');
    });

    it('classifies normal message as normal', async () => {
      const res = await request(app)
        .post('/sentinel/classify')
        .set(auth())
        .send({ message: 'Can you help me with the project?' });

      expect(res.status).toBe(200);
      expect(res.body.category).toBe('normal');
      expect(res.body.action.type).toBe('pass-through');
    });

    it('classifies "don\'t do that" as emergency-stop', async () => {
      const res = await request(app)
        .post('/sentinel/classify')
        .set(auth())
        .send({ message: "don't do that" });

      expect(res.status).toBe(200);
      expect(res.body.category).toBe('emergency-stop');
    });

    it('rejects missing message', async () => {
      const res = await request(app)
        .post('/sentinel/classify')
        .set(auth())
        .send({});

      expect(res.status).toBe(400);
    });
  });

  describe('GET /sentinel/stats', () => {
    it('returns sentinel stats', async () => {
      const res = await request(app)
        .get('/sentinel/stats')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.totalClassified).toBeGreaterThan(0);
      expect(res.body.byCategory).toBeDefined();
      expect(res.body.byMethod).toBeDefined();
    });
  });

  // ── AdaptiveTrust Routes ───────────────────────────────────────

  describe('GET /trust', () => {
    it('returns trust profile', async () => {
      const res = await request(app)
        .get('/trust')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.services).toBeDefined();
      expect(res.body.global).toBeDefined();
      expect(res.body.global.floor).toBe('collaborative');
    });
  });

  describe('GET /trust/summary', () => {
    it('returns compact summary', async () => {
      const res = await request(app)
        .get('/trust/summary')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.summary).toBeDefined();
      expect(typeof res.body.summary).toBe('string');
    });
  });

  describe('POST /trust/grant', () => {
    it('grants trust for a specific operation', async () => {
      const res = await request(app)
        .post('/trust/grant')
        .set(auth())
        .send({
          service: 'calendar',
          operation: 'read',
          level: 'autonomous',
          statement: "You don't need to ask me about reading calendar",
        });

      expect(res.status).toBe(200);
      expect(res.body.from).toBeDefined();
      expect(res.body.to).toBe('autonomous');
      expect(res.body.source).toBe('user-explicit');
      expect(res.body.service).toBe('calendar');
    });

    it('trust change persists in profile', async () => {
      const res = await request(app)
        .get('/trust')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.services.calendar).toBeDefined();
      expect(res.body.services.calendar.operations.read.level).toBe('autonomous');
    });

    it('rejects missing fields', async () => {
      const res = await request(app)
        .post('/trust/grant')
        .set(auth())
        .send({ service: 'gmail' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /trust/elevations', () => {
    it('returns pending elevation suggestions', async () => {
      const res = await request(app)
        .get('/trust/elevations')
        .set(auth());

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('GET /trust/changelog', () => {
    it('returns trust change log', async () => {
      const res = await request(app)
        .get('/trust/changelog')
        .set(auth());

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      // Should have the grant from above
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0].service).toBe('calendar');
    });
  });

  // ── Capabilities ───────────────────────────────────────────────

  describe('GET /capabilities', () => {
    it('includes external operation safety in capabilities', async () => {
      const res = await request(app)
        .get('/capabilities')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.externalOperationSafety).toBeDefined();
      expect(res.body.externalOperationSafety.enabled).toBe(true);
      expect(res.body.externalOperationSafety.sentinel).toBe(true);
      expect(res.body.externalOperationSafety.adaptiveTrust).toBe(true);
      expect(res.body.externalOperationSafety.endpoints.length).toBeGreaterThan(0);
    });
  });

  // ── Auth ───────────────────────────────────────────────────────

  describe('Auth enforcement', () => {
    it('rejects unauthenticated requests', async () => {
      const res = await request(app)
        .post('/operations/classify')
        .send({ service: 'gmail', mutability: 'read', reversibility: 'reversible', description: 'test' });

      expect(res.status).toBe(401);
    });
  });
});
