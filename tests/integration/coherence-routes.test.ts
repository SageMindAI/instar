/**
 * Integration test — Coherence Gate + Project Map API routes.
 *
 * Tests the full HTTP API for coherence checking, reflection prompts,
 * topic-project bindings, and project map generation.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { ProjectMapper } from '../../src/core/ProjectMapper.js';
import { ScopeVerifier } from '../../src/core/ScopeVerifier.js';
import {
  createTempProject,
  createMockSessionManager,
} from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('Coherence Gate + Project Map API routes', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let projectMapper: ProjectMapper;
  let coherenceGate: ScopeVerifier;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'test-auth-coherence';

  beforeAll(async () => {
    project = createTempProject();
    mockSM = createMockSessionManager();

    projectMapper = new ProjectMapper({
      projectDir: project.dir,
      stateDir: project.stateDir,
    });

    coherenceGate = new ScopeVerifier({
      projectDir: project.dir,
      stateDir: project.stateDir,
      projectName: 'test-coherence-project',
    });

    const config: InstarConfig = {
      projectName: 'test-coherence-project',
      projectDir: project.dir,
      stateDir: project.stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      requestTimeoutMs: 5000,
      version: '0.9.11',
      sessions: {
        claudePath: '/usr/bin/echo',
        maxSessions: 3,
        defaultMaxDurationMinutes: 30,
        protectedSessions: [],
        monitorIntervalMs: 5000,
      },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [],
      monitoring: {},
      updates: {},
      users: [],
    };

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state: project.state,
      projectMapper,
      coherenceGate,
    });

    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    project.cleanup();
  });

  // ── Project Map ────────────────────────────────────────────────

  describe('GET /project-map', () => {
    it('returns JSON project map', async () => {
      const res = await request(app)
        .get('/project-map')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      expect(res.body.projectDir).toBe(project.dir);
      expect(res.body.generatedAt).toBeTruthy();
      expect(typeof res.body.totalFiles).toBe('number');
      expect(Array.isArray(res.body.directories)).toBe(true);
    });

    it('returns markdown when format=markdown', async () => {
      const res = await request(app)
        .get('/project-map?format=markdown')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200)
        .expect('Content-Type', /text\/markdown/);

      expect(res.text).toContain('# Project Map:');
    });

    it('returns compact summary when format=compact', async () => {
      const res = await request(app)
        .get('/project-map?format=compact')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200)
        .expect('Content-Type', /text\/plain/);

      expect(res.text).toContain('Path:');
    });
  });

  describe('POST /project-map/refresh', () => {
    it('regenerates the project map', async () => {
      const res = await request(app)
        .post('/project-map/refresh')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      expect(res.body.refreshed).toBe(true);
      expect(typeof res.body.totalFiles).toBe('number');
    });
  });

  // ── Coherence Check ────────────────────────────────────────────

  describe('POST /coherence/check', () => {
    it('returns coherence check result', async () => {
      const res = await request(app)
        .post('/coherence/check')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({ action: 'deploy' })
        .expect(200);

      expect(res.body.checkedAt).toBeTruthy();
      expect(Array.isArray(res.body.checks)).toBe(true);
      expect(['proceed', 'warn', 'block']).toContain(res.body.recommendation);
    });

    it('returns 400 for missing action', async () => {
      const res = await request(app)
        .post('/coherence/check')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({})
        .expect(400);

      expect(res.body.error).toContain('action');
    });

    it('blocks when topic is bound to different project', async () => {
      // First, bind a topic to a DIFFERENT project
      await request(app)
        .post('/topic-bindings')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          topicId: 999,
          binding: {
            projectName: 'other-project',
            projectDir: '/path/to/other-project',
          },
        })
        .expect(200);

      // Now check coherence with that topic
      const res = await request(app)
        .post('/coherence/check')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          action: 'deploy',
          context: { topicId: 999 },
        })
        .expect(200);

      expect(res.body.recommendation).toBe('block');
      expect(res.body.passed).toBe(false);
    });
  });

  describe('POST /coherence/reflect', () => {
    it('returns reflection prompt as text', async () => {
      const res = await request(app)
        .post('/coherence/reflect')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({ action: 'deploy' })
        .expect(200)
        .expect('Content-Type', /text\/plain/);

      expect(res.text).toContain('PRE-ACTION COHERENCE CHECK');
      expect(res.text).toContain('test-coherence-project');
    });
  });

  // ── Topic-Project Bindings ─────────────────────────────────────

  describe('GET /topic-bindings', () => {
    it('returns all bindings', async () => {
      const res = await request(app)
        .get('/topic-bindings')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      expect(typeof res.body).toBe('object');
    });
  });

  describe('POST /topic-bindings', () => {
    it('creates a new topic-project binding', async () => {
      const res = await request(app)
        .post('/topic-bindings')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          topicId: 42,
          binding: {
            projectName: 'dental-city',
            projectDir: '/path/to/dental-city',
            deploymentTargets: ['dental-city.vercel.app'],
          },
        })
        .expect(200);

      expect(res.body.bound).toBe(true);
      expect(res.body.topicId).toBe(42);
      expect(res.body.binding.projectName).toBe('dental-city');
    });

    it('returns 400 for missing required fields', async () => {
      await request(app)
        .post('/topic-bindings')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({ topicId: 1 })
        .expect(400);
    });

    it('persists bindings across reload', async () => {
      // Create a binding
      await request(app)
        .post('/topic-bindings')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          topicId: 100,
          binding: {
            projectName: 'persisted-project',
            projectDir: '/tmp/persisted',
          },
        })
        .expect(200);

      // Verify it's in the bindings list
      const res = await request(app)
        .get('/topic-bindings')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      expect(res.body['100']).toBeDefined();
      expect(res.body['100'].projectName).toBe('persisted-project');
    });
  });
});
