/**
 * Tests for /events endpoint parameter bounds.
 *
 * Behavioral test — drives actual HTTP requests to verify
 * limit and sinceHours are handled safely.
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

describe('Events endpoint — parameter bounds', () => {
  let app: express.Express;
  let server: AgentServer;
  let tmpDir: string;
  const authToken = 'test-events-token';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-events-'));
    // Ensure required directories exist
    fs.mkdirSync(path.join(tmpDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'logs'), { recursive: true });
    const state = new StateManager(tmpDir);

    // Seed some events
    for (let i = 0; i < 5; i++) {
      state.appendEvent({
        type: 'test',
        summary: `Event ${i}`,
        timestamp: new Date().toISOString(),
      });
    }

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
        maxSessions: 1,
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

  it('returns events with valid parameters', async () => {
    const res = await request(app).get('/events?limit=3').set(auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('handles extreme limit without crashing', async () => {
    const res = await request(app).get('/events?limit=999999').set(auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('handles extreme sinceHours without crashing', async () => {
    const res = await request(app).get('/events?since=999999').set(auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('handles negative values without crashing', async () => {
    const res = await request(app).get('/events?limit=-5&since=-10').set(auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
