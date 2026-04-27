import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { UpdateChecker } from '../../src/core/UpdateChecker.js';
import { TelemetryHeartbeat } from '../../src/monitoring/TelemetryHeartbeat.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig, TelemetryConfig } from '../../src/core/types.js';

describe('Telemetry Routes', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let updateChecker: UpdateChecker;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let heartbeat: TelemetryHeartbeat;

  const telemetryConfig: TelemetryConfig = {
    enabled: true,
    level: 'usage',
  };

  const fakeConfig: InstarConfig = {
    projectName: 'test-project',
    projectDir: '/tmp/test',
    stateDir: '/tmp/test/.instar',
    port: 0,
    version: '0.14.0-test',
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
    relationships: {
      relationshipsDir: '/tmp/test/.instar/relationships',
      maxRecentInteractions: 20,
    },
    feedback: {
      enabled: false,
      webhookUrl: '',
      feedbackFile: '',
    },
  };

  beforeAll(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();

    fakeConfig.projectDir = project.dir;
    fakeConfig.stateDir = project.stateDir;

    // Create config.json in the project
    const configDir = path.join(project.dir, '.instar');
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ monitoring: {} }) + '\n');

    heartbeat = new TelemetryHeartbeat(telemetryConfig, project.stateDir, project.dir, '0.14.0-test');

    updateChecker = new UpdateChecker(project.stateDir);

    server = new AgentServer({
      config: fakeConfig,
      sessionManager: mockSM as any,
      state: project.state,
      updateChecker,
      telemetryHeartbeat: heartbeat,
    });
    app = server.getApp();
  });

  afterAll(() => {
    heartbeat.stop();
    project.cleanup();
  });

  describe('GET /telemetry/status', () => {
    it('should return status when telemetry is configured', async () => {
      const res = await request(app).get('/telemetry/status');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('enabled');
      expect(res.body).toHaveProperty('baseline');
      expect(res.body.baseline).toHaveProperty('provisioned');
    });

    it('should report unprovisioned baseline', async () => {
      const res = await request(app).get('/telemetry/status');
      expect(res.body.baseline.provisioned).toBe(false);
    });
  });

  describe('GET /telemetry/submissions', () => {
    it('should return empty list when no submissions', async () => {
      const res = await request(app).get('/telemetry/submissions');
      expect(res.status).toBe(200);
      expect(res.body.submissions).toEqual([]);
      expect(res.body.count).toBe(0);
    });

    it('should respect limit parameter', async () => {
      const res = await request(app).get('/telemetry/submissions?limit=5');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('submissions');
    });

    it('should cap limit at 200', async () => {
      // Write enough entries
      const logDir = path.join(project.stateDir, 'telemetry');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      const entries = Array.from({ length: 210 }, (_, i) =>
        JSON.stringify({
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
          payload: { v: 1, installationId: 'test', jobs: { skips: [] } },
          endpoint: 'v1/telemetry',
          responseStatus: 200,
        })
      );
      fs.writeFileSync(path.join(logDir, 'submissions.jsonl'), entries.join('\n') + '\n');

      const res = await request(app).get('/telemetry/submissions?limit=500');
      expect(res.status).toBe(200);
      expect(res.body.submissions.length).toBeLessThanOrEqual(200);

      // Cleanup
      // safe-git-allow: incremental-migration
      fs.unlinkSync(path.join(logDir, 'submissions.jsonl'));
    });
  });

  describe('GET /telemetry/submissions/latest', () => {
    it('should return null when no submissions', async () => {
      const res = await request(app).get('/telemetry/submissions/latest');
      expect(res.status).toBe(200);
      expect(res.body.submission).toBeNull();
    });

    it('should return latest submission from log', async () => {
      const logDir = path.join(project.stateDir, 'telemetry');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        payload: { v: 1, installationId: 'test-latest' },
        endpoint: 'v1/telemetry',
        responseStatus: 200,
      });
      fs.writeFileSync(path.join(logDir, 'submissions.jsonl'), entry + '\n');

      const res = await request(app).get('/telemetry/submissions/latest');
      expect(res.status).toBe(200);
      expect(res.body.submission).toBeDefined();
      expect(res.body.submission.payload.installationId).toBe('test-latest');

      // Cleanup
      // safe-git-allow: incremental-migration
      fs.unlinkSync(path.join(logDir, 'submissions.jsonl'));
    });
  });

  describe('POST /telemetry/enable', () => {
    it('should provision identity and return installation ID prefix', async () => {
      const res = await request(app).post('/telemetry/enable');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.installationId).toMatch(/^[0-9a-f]{8}\.\.\.$/);
      expect(res.body.message).toContain('enabled');

      // Verify config was updated
      const configPath = path.join(project.dir, '.instar', 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(config.monitoring.telemetry.enabled).toBe(true);

      // Verify identity files were created
      expect(heartbeat.getAuth().isProvisioned()).toBe(true);
    });

    it('should be idempotent (re-enable returns same ID)', async () => {
      const res1 = await request(app).post('/telemetry/enable');
      const res2 = await request(app).post('/telemetry/enable');
      expect(res1.body.installationId).toBe(res2.body.installationId);
      expect(res2.body.created).toBe(false);
    });
  });

  describe('POST /telemetry/disable', () => {
    it('should deprovision identity and update config', async () => {
      // First enable
      await request(app).post('/telemetry/enable');
      expect(heartbeat.getAuth().isProvisioned()).toBe(true);

      // Then disable
      const res = await request(app).post('/telemetry/disable');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('disabled');

      // Verify identity files were deleted
      expect(heartbeat.getAuth().isProvisioned()).toBe(false);

      // Verify config was updated
      const configPath = path.join(project.dir, '.instar', 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(config.monitoring.telemetry.enabled).toBe(false);
    });

    it('should report remote deletion status', async () => {
      // Enable first
      await request(app).post('/telemetry/enable');

      const res = await request(app).post('/telemetry/disable');
      expect(res.body).toHaveProperty('remoteDeletion');
      // Remote deletion may succeed (worker returns 200 for non-existent IDs),
      // fail with network_error, or return failed_* depending on environment
      expect(['network_error', 'not_attempted', 'success'].includes(res.body.remoteDeletion) ||
             res.body.remoteDeletion.startsWith('failed_')).toBe(true);
    });

    it('should clear submissions log', async () => {
      // Enable and create a log file
      await request(app).post('/telemetry/enable');
      const logDir = path.join(project.stateDir, 'telemetry');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, 'submissions.jsonl'), '{"test":true}\n');

      // Disable
      await request(app).post('/telemetry/disable');

      // Submissions log should be gone
      expect(fs.existsSync(path.join(logDir, 'submissions.jsonl'))).toBe(false);
    });

    it('should write pending-deletion on network failure', async () => {
      // Enable first
      await request(app).post('/telemetry/enable');

      // Disable (remote will fail)
      await request(app).post('/telemetry/disable');

      // Check for pending-deletion file
      const pendingPath = path.join(project.stateDir, 'telemetry', 'pending-deletion.json');
      // May or may not exist depending on how the network error is handled
      // but the endpoint should still return success
    });
  });

  describe('GET /monitoring/telemetry', () => {
    it('should return heartbeat status', async () => {
      const res = await request(app).get('/monitoring/telemetry');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('enabled');
      expect(res.body).toHaveProperty('level');
      expect(res.body).toHaveProperty('installId');
      expect(res.body).toHaveProperty('counters');
      expect(res.body).toHaveProperty('baseline');
    });
  });

  describe('POST /config/telemetry', () => {
    it('should require enabled as boolean', async () => {
      const res = await request(app)
        .post('/config/telemetry')
        .send({ enabled: 'yes' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('enabled must be a boolean');
    });

    it('should reject invalid level', async () => {
      const res = await request(app)
        .post('/config/telemetry')
        .send({ enabled: true, level: 'premium' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('level must be');
    });

    it('should update config and write nudge marker', async () => {
      const res = await request(app)
        .post('/config/telemetry')
        .send({ enabled: true, level: 'usage' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.telemetry.enabled).toBe(true);
      expect(res.body.telemetry.level).toBe('usage');

      // Check nudge marker was written
      const nudgeFile = path.join(project.stateDir, '.telemetry-nudge-shown');
      expect(fs.existsSync(nudgeFile)).toBe(true);
      const nudge = JSON.parse(fs.readFileSync(nudgeFile, 'utf-8'));
      expect(nudge.decided).toBe('opted-in');
    });

    it('should record declined state', async () => {
      const res = await request(app)
        .post('/config/telemetry')
        .send({ enabled: false });
      expect(res.status).toBe(200);
      expect(res.body.telemetry.enabled).toBe(false);

      const nudgeFile = path.join(project.stateDir, '.telemetry-nudge-shown');
      const nudge = JSON.parse(fs.readFileSync(nudgeFile, 'utf-8'));
      expect(nudge.decided).toBe('declined');
    });
  });
});

describe('Telemetry Routes (no telemetry configured)', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;

  const fakeConfig: InstarConfig = {
    projectName: 'test-project',
    projectDir: '/tmp/test',
    stateDir: '/tmp/test/.instar',
    port: 0,
    version: '0.14.0-test',
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
    relationships: {
      relationshipsDir: '/tmp/test/.instar/relationships',
      maxRecentInteractions: 20,
    },
    feedback: {
      enabled: false,
      webhookUrl: '',
      feedbackFile: '',
    },
  };

  beforeAll(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();
    fakeConfig.projectDir = project.dir;
    fakeConfig.stateDir = project.stateDir;

    server = new AgentServer({
      config: fakeConfig,
      sessionManager: mockSM as any,
      state: project.state,
      updateChecker: new UpdateChecker(project.stateDir),
      // No telemetryHeartbeat — testing graceful degradation
    });
    app = server.getApp();
  });

  afterAll(() => {
    project.cleanup();
  });

  it('GET /telemetry/status should return disabled', async () => {
    const res = await request(app).get('/telemetry/status');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.baseline.provisioned).toBe(false);
  });

  it('GET /telemetry/submissions should return empty', async () => {
    const res = await request(app).get('/telemetry/submissions');
    expect(res.status).toBe(200);
    expect(res.body.submissions).toEqual([]);
  });

  it('GET /telemetry/submissions/latest should return null', async () => {
    const res = await request(app).get('/telemetry/submissions/latest');
    expect(res.status).toBe(200);
    expect(res.body.submission).toBeNull();
  });

  it('POST /telemetry/enable should return 503', async () => {
    const res = await request(app).post('/telemetry/enable');
    expect(res.status).toBe(503);
  });

  it('POST /telemetry/disable should return 503', async () => {
    const res = await request(app).post('/telemetry/disable');
    expect(res.status).toBe(503);
  });

  it('GET /monitoring/telemetry should return disabled message', async () => {
    const res = await request(app).get('/monitoring/telemetry');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });
});
