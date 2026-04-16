/**
 * HTTP route tests for Integrated-Being /shared-state/* endpoints.
 *
 * Covers:
 *  - 200 OK with entries/render/chain/stats
 *  - 503 when config.integratedBeing.enabled === false
 *  - 400 on invalid chain id
 *  - auth (bearer-token) gating
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SharedStateLedger } from '../../src/core/SharedStateLedger.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

function baseConfig(stateDir: string): InstarConfig {
  return {
    projectName: 'test',
    projectDir: path.dirname(stateDir),
    stateDir,
    port: 0,
    authToken: 'test-bearer-token',
    sessions: {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/bin/claude',
      projectDir: path.dirname(stateDir),
      maxSessions: 1,
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
  };
}

describe('Shared-state routes (enabled)', () => {
  let project: TempProject;
  let ledger: SharedStateLedger;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;

  beforeAll(async () => {
    project = createTempProject();
    ledger = new SharedStateLedger({
      stateDir: project.stateDir,
      config: { enabled: true },
      salt: 'test-salt',
    });
    const cfg = baseConfig(project.stateDir);
    cfg.integratedBeing = { enabled: true };
    server = new AgentServer({
      config: cfg,
      sessionManager: createMockSessionManager() as any,
      state: project.state,
      sharedStateLedger: ledger,
    });
    app = server.getApp();

    // Seed with two entries
    await ledger.append({
      emittedBy: { subsystem: 'threadline', instance: 'server' },
      kind: 'thread-opened',
      subject: 'opened thread with sagemind',
      counterparty: { type: 'agent', name: 'sagemind', trustTier: 'trusted' },
      provenance: 'subsystem-asserted',
      dedupKey: 'threadline:opened:t1',
    });
    await ledger.append({
      emittedBy: { subsystem: 'dispatch', instance: 'server' },
      kind: 'decision',
      subject: 'dispatch executed',
      counterparty: { type: 'system', name: 'dispatch-manager', trustTier: 'trusted' },
      provenance: 'subsystem-asserted',
      dedupKey: 'dispatch:d1',
    });
  });

  afterAll(() => {
    ledger.shutdown();
    project.cleanup();
  });

  it('rejects requests without bearer token', async () => {
    const res = await request(app).get('/shared-state/recent');
    expect(res.status).toBe(401);
  });

  it('rejects wrong bearer token', async () => {
    const res = await request(app)
      .get('/shared-state/recent')
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(403);
  });

  it('GET /shared-state/recent returns entries', async () => {
    const res = await request(app)
      .get('/shared-state/recent')
      .set('Authorization', 'Bearer test-bearer-token');
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBe(2);
    expect(res.body.entries[0].kind).toBe('thread-opened');
  });

  it('GET /shared-state/recent filters by counterpartyType', async () => {
    const res = await request(app)
      .get('/shared-state/recent?counterpartyType=system')
      .set('Authorization', 'Bearer test-bearer-token');
    expect(res.status).toBe(200);
    expect(res.body.entries.every((e: any) => e.counterparty.type === 'system')).toBe(true);
  });

  it('GET /shared-state/render returns fenced block with warning header', async () => {
    const res = await request(app)
      .get('/shared-state/render?limit=5')
      .set('Authorization', 'Bearer test-bearer-token');
    expect(res.status).toBe(200);
    expect(res.text).toContain('[integrated-being] Entries below are OBSERVATIONS');
    expect(res.text).toContain('<integrated-being-entry');
  });

  it('GET /shared-state/chain/:id returns the chain', async () => {
    const recent = await ledger.recent({ limit: 10 });
    const entry = recent[0];
    const res = await request(app)
      .get(`/shared-state/chain/${entry.id}`)
      .set('Authorization', 'Bearer test-bearer-token');
    expect(res.status).toBe(200);
    expect(res.body.chain.length).toBeGreaterThan(0);
  });

  it('GET /shared-state/chain/:id rejects malformed id', async () => {
    const res = await request(app)
      .get('/shared-state/chain/NOT_HEX')
      .set('Authorization', 'Bearer test-bearer-token');
    expect(res.status).toBe(400);
  });

  it('GET /shared-state/stats returns stats with counts', async () => {
    const res = await request(app)
      .get('/shared-state/stats')
      .set('Authorization', 'Bearer test-bearer-token');
    expect(res.status).toBe(200);
    expect(res.body.counts).toBeDefined();
    expect(res.body.classifierFired).toBe(0);
  });

  it('GET /shared-state/stats?rebuild=1 rebuilds', async () => {
    const res = await request(app)
      .get('/shared-state/stats?rebuild=1')
      .set('Authorization', 'Bearer test-bearer-token');
    expect(res.status).toBe(200);
    expect(res.body.counts['thread-opened']).toBe(1);
    expect(res.body.counts.decision).toBe(1);
  });
});

describe('Shared-state routes (disabled)', () => {
  let project: TempProject;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;

  beforeAll(() => {
    project = createTempProject();
    const cfg = baseConfig(project.stateDir);
    cfg.integratedBeing = { enabled: false };
    server = new AgentServer({
      config: cfg,
      sessionManager: createMockSessionManager() as any,
      state: project.state,
      sharedStateLedger: null as any, // null when disabled
    });
    app = server.getApp();
  });

  afterAll(() => {
    project.cleanup();
  });

  it('returns 503 on /shared-state/recent', async () => {
    const res = await request(app)
      .get('/shared-state/recent')
      .set('Authorization', 'Bearer test-bearer-token');
    expect(res.status).toBe(503);
  });

  it('returns 503 on /shared-state/render', async () => {
    const res = await request(app)
      .get('/shared-state/render')
      .set('Authorization', 'Bearer test-bearer-token');
    expect(res.status).toBe(503);
  });

  it('returns 503 on /shared-state/chain/:id', async () => {
    const res = await request(app)
      .get('/shared-state/chain/abcdef012345')
      .set('Authorization', 'Bearer test-bearer-token');
    expect(res.status).toBe(503);
  });

  it('returns 503 on /shared-state/stats', async () => {
    const res = await request(app)
      .get('/shared-state/stats')
      .set('Authorization', 'Bearer test-bearer-token');
    expect(res.status).toBe(503);
  });
});
