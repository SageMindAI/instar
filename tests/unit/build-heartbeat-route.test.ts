/**
 * POST /build/heartbeat — BUILD-STALL-VISIBILITY-SPEC Fix 2.
 *
 * Validates: enum allowlists (phase, tool, status), runId regex,
 * exactly-one-of topicId/channelId routing, dispatch via
 * telegram/slack adapters, ProxyCoordinator integration, and the
 * 503 response when the requested transport isn't configured.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { ProxyCoordinator } from '../../src/monitoring/ProxyCoordinator.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

function baseConfig(stateDir: string): InstarConfig {
  return {
    projectName: 'test-project',
    projectDir: path.dirname(stateDir),
    stateDir,
    port: 0,
    version: '0.1.9',
    sessions: {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/bin/claude',
      projectDir: path.dirname(stateDir),
      maxSessions: 3,
      protectedSessions: [],
      completionPatterns: [],
    },
    scheduler: { jobsFile: '', enabled: false, maxParallelJobs: 1, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
    users: [],
    messaging: [],
    monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
    relationships: { relationshipsDir: stateDir + '/relationships', maxRecentInteractions: 20 },
    feedback: { enabled: false, webhookUrl: '', feedbackFile: stateDir + '/feedback.json' },
  };
}

interface FakeTelegram {
  sent: Array<{ topicId: number; text: string; opts?: any }>;
  sendToTopic: (topicId: number, text: string, opts?: any) => Promise<void>;
}

function makeFakeTelegram(): FakeTelegram {
  const t: FakeTelegram = {
    sent: [],
    sendToTopic: async (topicId, text, opts) => {
      t.sent.push({ topicId, text, opts });
    },
  };
  return t;
}

interface FakeSlack {
  sent: Array<{ channelId: string; text: string }>;
  sendToChannel: (channelId: string, text: string) => Promise<void>;
}

function makeFakeSlack(): FakeSlack {
  const s: FakeSlack = {
    sent: [],
    sendToChannel: async (channelId, text) => {
      s.sent.push({ channelId, text });
    },
  };
  return s;
}

describe('POST /build/heartbeat', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;

  beforeEach(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();
  });

  afterEach(() => {
    project.cleanup();
  });

  function buildServer(opts: { telegram?: FakeTelegram | null; slack?: FakeSlack | null } = {}) {
    const proxyCoordinator = new ProxyCoordinator();
    const server = new AgentServer({
      config: baseConfig(project.stateDir),
      sessionManager: mockSM as any,
      state: project.state,
      telegram: (opts.telegram as any) ?? undefined,
      slack: (opts.slack as any) ?? undefined,
      proxyCoordinator,
    });
    return { app: server.getApp(), proxyCoordinator };
  }

  const validBody = {
    runId: 'abc123_DEF',
    phase: 'executing',
    tool: 'Monitor',
    status: 'still-working',
    elapsedMs: 60_000,
    topicId: 12345,
  };

  describe('validation', () => {
    it('rejects missing runId with 400', async () => {
      const { app } = buildServer({ telegram: makeFakeTelegram() });
      const res = await request(app).post('/build/heartbeat').send({ ...validBody, runId: undefined });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('runId');
    });

    it('rejects runId failing the safe-char regex', async () => {
      const { app } = buildServer({ telegram: makeFakeTelegram() });
      const res = await request(app).post('/build/heartbeat').send({ ...validBody, runId: 'has spaces' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('runId');
    });

    it('rejects an unknown phase', async () => {
      const { app } = buildServer({ telegram: makeFakeTelegram() });
      const res = await request(app).post('/build/heartbeat').send({ ...validBody, phase: 'frobnicating' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('phase');
    });

    it('rejects an unknown tool (not on allowlist)', async () => {
      const { app } = buildServer({ telegram: makeFakeTelegram() });
      const res = await request(app).post('/build/heartbeat').send({ ...validBody, tool: 'rm -rf /' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('tool');
    });

    it('rejects an unknown status', async () => {
      const { app } = buildServer({ telegram: makeFakeTelegram() });
      const res = await request(app).post('/build/heartbeat').send({ ...validBody, status: 'panicking' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('status');
    });

    it('rejects when both topicId and channelId are present', async () => {
      const { app } = buildServer({ telegram: makeFakeTelegram(), slack: makeFakeSlack() });
      const res = await request(app).post('/build/heartbeat').send({ ...validBody, channelId: 'C123' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/exactly one/i);
    });

    it('rejects when neither topicId nor channelId is present', async () => {
      const { app } = buildServer({ telegram: makeFakeTelegram() });
      const { topicId: _omit, ...noTarget } = validBody;
      const res = await request(app).post('/build/heartbeat').send(noTarget);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/exactly one/i);
    });
  });

  describe('telegram dispatch', () => {
    it('dispatches via telegram and records the heartbeat in ProxyCoordinator', async () => {
      const fakeTelegram = makeFakeTelegram();
      const { app, proxyCoordinator } = buildServer({ telegram: fakeTelegram });

      const res = await request(app).post('/build/heartbeat').send(validBody);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      expect(fakeTelegram.sent.length).toBe(1);
      expect(fakeTelegram.sent[0].topicId).toBe(12345);
      expect(fakeTelegram.sent[0].text).toContain('phase=executing');
      expect(fakeTelegram.sent[0].text).toContain('tool=Monitor');

      expect(proxyCoordinator.hasRecentBuildHeartbeat(12345)).toBe(true);
    });

    it('returns 503 when telegram is not configured', async () => {
      const { app, proxyCoordinator } = buildServer({ telegram: null });
      const res = await request(app).post('/build/heartbeat').send(validBody);
      expect(res.status).toBe(503);
      expect(proxyCoordinator.hasRecentBuildHeartbeat(12345)).toBe(false);
    });
  });

  describe('slack dispatch', () => {
    it('dispatches via slack and records a synthetic heartbeat', async () => {
      const fakeSlack = makeFakeSlack();
      const { app, proxyCoordinator } = buildServer({ slack: fakeSlack });

      const slackBody = { ...validBody, channelId: 'C12345' } as any;
      delete slackBody.topicId;

      const res = await request(app).post('/build/heartbeat').send(slackBody);
      expect(res.status).toBe(200);
      expect(fakeSlack.sent.length).toBe(1);
      expect(fakeSlack.sent[0].channelId).toBe('C12345');

      // Slack uses synthetic negative topic IDs — not equal to any real topic,
      // but stable for the same channel string.
      const synthetics = (proxyCoordinator as any).lastBuildHeartbeatAt as Map<number, number>;
      expect(synthetics.size).toBe(1);
      const [syntheticId] = [...synthetics.keys()];
      expect(syntheticId).toBeLessThan(0);
    });

    it('returns 503 when slack is not configured', async () => {
      const { app } = buildServer({ slack: null });
      const slackBody = { ...validBody, channelId: 'C12345' } as any;
      delete slackBody.topicId;
      const res = await request(app).post('/build/heartbeat').send(slackBody);
      expect(res.status).toBe(503);
    });
  });
});
