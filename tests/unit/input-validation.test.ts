/**
 * Tests for input validation on HTTP endpoints.
 *
 * Behavioral tests that exercise actual HTTP validation.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';

describe('Input Validation — behavioral', () => {
  let app: express.Express;
  let server: AgentServer;
  let tmpDir: string;
  const authToken = 'test-validation-token';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-validation-'));
    fs.mkdirSync(path.join(tmpDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'logs'), { recursive: true });
    const state = new StateManager(tmpDir);

    const config = {
      projectName: 'test',
      projectDir: tmpDir,
      stateDir: tmpDir,
      port: 0,
      host: '127.0.0.1',
      version: '0.0.1',
      sessions: {
        tmuxPath: '/usr/bin/tmux',
        claudePath: '/usr/bin/false',
        projectDir: tmpDir,
        maxSessions: 3,
        protectedSessions: [],
        completionPatterns: [],
      },
      scheduler: {
        jobsFile: path.join(tmpDir, 'jobs.json'),
        enabled: false,
        maxParallelJobs: 1,
        quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      },
      users: [],
      messaging: [],
      monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
      authToken,
      relationships: { relationshipsDir: path.join(tmpDir, 'rel'), maxRecentInteractions: 20 },
      feedback: { enabled: false, webhookUrl: '', feedbackFile: path.join(tmpDir, 'fb.json') },
    };

    fs.writeFileSync(path.join(tmpDir, 'jobs.json'), '[]');
    const sm = new SessionManager(config.sessions as any, state);

    server = new AgentServer({
      config: config as any,
      sessionManager: sm,
      state,
    });

    app = server.getApp();
  });

  afterAll(async () => {
    try { await server?.stop(); } catch { /* ignore */ }
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const auth = { Authorization: `Bearer ${authToken}` };

  it('rejects session names over 200 characters', async () => {
    const res = await request(app)
      .post('/sessions/spawn')
      .set(auth)
      .send({ name: 'x'.repeat(201), prompt: 'hello' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/200/);
  });

  it('rejects prompts over 500KB', async () => {
    const res = await request(app)
      .post('/sessions/spawn')
      .set(auth)
      .send({ name: 'test', prompt: 'x'.repeat(500_001) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/500KB/);
  });

  it('rejects invalid model values', async () => {
    const res = await request(app)
      .post('/sessions/spawn')
      .set(auth)
      .send({ name: 'test', prompt: 'hello', model: 'gpt-4' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/model/);
  });

  it('rejects input text over 100KB', async () => {
    const res = await request(app)
      .post('/sessions/test-session/input')
      .set(auth)
      .send({ text: 'x'.repeat(100_001) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/length/);
  });

  it('telegram reply returns error when adapter not configured', async () => {
    const res = await request(app)
      .post('/telegram/reply/notanumber')
      .set(auth)
      .send({ text: 'hello' });
    // Returns 503 when no Telegram adapter is configured, or 400 for invalid topicId
    expect([400, 503]).toContain(res.status);
  });

  it('has a quota endpoint', async () => {
    const res = await request(app)
      .get('/quota')
      .set(auth);
    // Should return 200 (even if no quota data)
    expect(res.status).toBe(200);
  });
});
