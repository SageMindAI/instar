/**
 * Integration test — POST /feedback with corrupted feedback.json.
 *
 * Regression test for #93: POST /feedback returned 500 when feedback.json
 * contained non-array data (e.g. `{}`). After the fix, the route should
 * handle corrupted data gracefully and never return 500.
 *
 * Tests the full HTTP pipeline: request → route → FeedbackManager → response.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { FeedbackManager } from '../../src/core/FeedbackManager.js';
import {
  createTempProject,
  createMockSessionManager,
} from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('POST /feedback with corrupted feedback.json (regression #93)', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'test-auth-feedback-corrupt';

  beforeAll(async () => {
    project = createTempProject();
    mockSM = createMockSessionManager();

    // Write corrupted feedback.json — object instead of array
    const feedbackFile = path.join(project.stateDir, 'feedback.json');
    fs.writeFileSync(feedbackFile, JSON.stringify({ corrupted: true }));

    const feedbackManager = new FeedbackManager({
      enabled: false,
      webhookUrl: '',
      feedbackFile,
    });

    const config: InstarConfig = {
      projectName: 'test-feedback-corrupt',
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
      feedback: feedbackManager,
    });

    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    project.cleanup();
  });

  it('does NOT return 500 when feedback.json contains a plain object', async () => {
    const res = await request(app)
      .post('/feedback')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({
        type: 'bug',
        title: 'Test feedback with corrupted backing file',
        description:
          'This submission should succeed or return a validation error, never an internal server error, even though feedback.json contains a non-array object.',
      });

    // The key assertion: must NOT be 500
    expect(res.status).not.toBe(500);

    // Should be a successful submission (201) or a handled error (4xx)
    expect([201, 400, 422, 429]).toContain(res.status);
  });

  it('returns 201 with a valid feedback id on successful submission', async () => {
    const res = await request(app)
      .post('/feedback')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({
        type: 'bug',
        title: 'Second test with corrupted backing store',
        description:
          'Even after the first request, the route should continue handling submissions correctly without crashing on the non-array feedback.json.',
      });

    // After the guard fix, loadFeedback returns [] for non-array data,
    // so the quality check and submit should proceed normally.
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('ok', true);
    expect(res.body).toHaveProperty('id');
    expect(typeof res.body.id).toBe('string');
  });
});
