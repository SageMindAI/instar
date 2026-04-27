/**
 * E2E test — Inter-Agent Messaging lifecycle.
 *
 * Mirrors the production initialization path from server.ts:
 *   Initialize MessageStore → create dependencies → wire into AgentServer →
 *   start server → verify endpoints are alive (200, not 503)
 *
 * This is the Phase 1 "feature is alive" test — the single most important
 * test per the Testing Integrity Spec.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import { MessageFormatter } from '../../src/messaging/MessageFormatter.js';
import { MessageDelivery } from '../../src/messaging/MessageDelivery.js';
import { MessageRouter } from '../../src/messaging/MessageRouter.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { generateAgentToken } from '../../src/messaging/AgentTokenManager.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('E2E: Messaging lifecycle', () => {
  let projectDir: string;
  let stateDir: string;
  let server: AgentServer;
  let messageStore: MessageStore;
  let messageRouter: MessageRouter;
  let app: ReturnType<AgentServer['getApp']>;
  let agentToken: string;
  const AUTH_TOKEN = 'e2e-messaging-token';

  beforeAll(async () => {
    // ── Phase 1: Simulate project initialization ──────────
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-msg-e2e-'));
    stateDir = path.join(projectDir, '.instar');

    // Create directory structure (what init creates)
    const dirs = [
      path.join(stateDir, 'state', 'sessions'),
      path.join(stateDir, 'state', 'jobs'),
      path.join(stateDir, 'logs'),
    ];
    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // ── Phase 2: Initialize messaging subsystem ───────────
    const messagingDir = path.join(stateDir, 'messages');
    messageStore = new MessageStore(messagingDir);
    await messageStore.initialize();

    const formatter = new MessageFormatter();
    const mockTmux = {
      getForegroundProcess: () => 'bash',
      isSessionAlive: () => true,
      hasActiveHumanInput: () => false,
      sendKeys: () => true,
      getOutputLineCount: () => 100,
    };
    const delivery = new MessageDelivery(formatter, mockTmux);
    messageRouter = new MessageRouter(messageStore, delivery, {
      localAgent: 'e2e-agent',
      localMachine: 'e2e-machine',
      serverUrl: 'http://localhost:0',
    });

    // ── Phase 3: Wire into AgentServer ────────────────────
    const state = new StateManager(stateDir);
    const mockSM = createMockSessionManager();

    const config: InstarConfig = {
      projectName: 'e2e-messaging-project',
      projectDir,
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      requestTimeoutMs: 5000,
      version: '0.9.81',
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

    // Generate agent token for relay-agent auth (uses ~/.instar/agent-tokens/)
    agentToken = generateAgentToken(config.projectName);

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state,
      messageRouter,
    });

    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    await messageStore.destroy();
    // safe-git-allow: incremental-migration
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // ── Phase 1 Tests: "Feature is alive" ──────────────────────────

  it('messaging send endpoint returns 201, not 503', async () => {
    const res = await request(app)
      .post('/messages/send')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({
        from: { agent: 'e2e-agent', session: 'test', machine: 'e2e-machine' },
        to: { agent: 'other', session: 'best', machine: 'local' },
        type: 'info',
        priority: 'low',
        subject: 'E2E alive test',
        body: 'Verifying messaging is wired and alive',
      });

    // The critical assertion: 201 (Created), NOT 503 (feature not available)
    expect(res.status).toBe(201);
    expect(res.body.messageId).toBeDefined();
  });

  it('messaging stats endpoint returns 200, not 503', async () => {
    const res = await request(app)
      .get('/messages/stats')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.volume).toBeDefined();
  });

  it('messaging ack endpoint returns 200, not 503', async () => {
    // First send a message
    const sendRes = await request(app)
      .post('/messages/send')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({
        from: { agent: 'e2e-agent', session: 'test', machine: 'e2e-machine' },
        to: { agent: 'other', session: 'best', machine: 'local' },
        type: 'query',
        priority: 'medium',
        subject: 'E2E ack test',
        body: 'Testing ack lifecycle',
      });

    // Simulate delivery
    await messageStore.updateDelivery(sendRes.body.messageId, {
      phase: 'delivered',
      transitions: [
        { from: 'created', to: 'sent', at: new Date().toISOString() },
        { from: 'sent', to: 'delivered', at: new Date().toISOString() },
      ],
      attempts: 1,
    });

    // Ack it
    const ackRes = await request(app)
      .post('/messages/ack')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({
        messageId: sendRes.body.messageId,
        sessionId: 'test-session',
      });

    expect(ackRes.status).toBe(200);
    expect(ackRes.body.ok).toBe(true);
  });

  it('relay-agent endpoint returns 200, not 503', async () => {
    const res = await request(app)
      .post('/messages/relay-agent')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({
        schemaVersion: 1,
        message: {
          id: `e2e-relay-${Date.now()}`,
          from: { agent: 'remote', session: 'rs', machine: 'remote' },
          to: { agent: 'e2e-agent', session: 'best', machine: 'local' },
          type: 'info',
          priority: 'low',
          subject: 'Relay alive test',
          body: 'Testing relay is wired',
          createdAt: new Date().toISOString(),
          ttlMinutes: 30,
        },
        transport: {
          relayChain: [],
          originServer: 'http://remote:3000',
          nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
          timestamp: new Date().toISOString(),
        },
        delivery: { phase: 'sent', transitions: [], attempts: 0 },
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // ── Full Send-Ack Lifecycle ─────────────────────────────────────

  it('completes full send → store → ack lifecycle', async () => {
    // Send
    const sendRes = await request(app)
      .post('/messages/send')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({
        from: { agent: 'e2e-agent', session: 'lifecycle-test', machine: 'e2e-machine' },
        to: { agent: 'e2e-agent', session: 'other-session', machine: 'local' },
        type: 'request',
        priority: 'high',
        subject: 'Full lifecycle test',
        body: 'Please acknowledge receipt',
      });
    expect(sendRes.status).toBe(201);

    const messageId = sendRes.body.messageId;
    expect(messageId).toBeDefined();

    // Verify stored
    const stored = await messageStore.get(messageId);
    expect(stored).not.toBeNull();
    expect(stored!.message.type).toBe('request');
    expect(stored!.message.priority).toBe('high');
    expect(stored!.delivery.phase).toBe('sent');

    // Simulate delivery
    await messageStore.updateDelivery(messageId, {
      phase: 'delivered',
      transitions: [
        { from: 'created', to: 'sent', at: new Date().toISOString() },
        { from: 'sent', to: 'delivered', at: new Date().toISOString() },
      ],
      attempts: 1,
    });

    // Ack
    const ackRes = await request(app)
      .post('/messages/ack')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ messageId, sessionId: 'target-session' });
    expect(ackRes.status).toBe(200);

    // Verify final state
    const final = await messageStore.get(messageId);
    expect(final!.delivery.phase).toBe('read');
    expect(final!.delivery.transitions.length).toBeGreaterThanOrEqual(3);
  });

  // ── Wiring Integrity ────────────────────────────────────────────

  it('messageRouter is not null in route context', async () => {
    // If messageRouter were null, we'd get 503. Getting 201 proves it's wired.
    const res = await request(app)
      .post('/messages/send')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({
        from: { agent: 'e2e-agent', session: 'wiring', machine: 'e2e-machine' },
        to: { agent: 'other', session: 'best', machine: 'local' },
        type: 'wellness',
        priority: 'low',
        subject: 'Wiring check',
        body: 'Verifying dependency injection',
      });

    expect(res.status).not.toBe(503);
    expect(res.status).toBe(201);
  });

  it('messageStore persists messages to disk', async () => {
    const sendRes = await request(app)
      .post('/messages/send')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({
        from: { agent: 'e2e-agent', session: 'disk', machine: 'e2e-machine' },
        to: { agent: 'other', session: 'best', machine: 'local' },
        type: 'info',
        priority: 'low',
        subject: 'Disk persistence test',
        body: 'Verifying file on disk',
      });

    const filePath = path.join(
      stateDir, 'messages', 'store', `${sendRes.body.messageId}.json`,
    );
    expect(fs.existsSync(filePath)).toBe(true);
  });
});
