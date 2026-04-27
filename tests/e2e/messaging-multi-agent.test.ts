/**
 * E2E test — Multi-Agent Messaging (same machine).
 *
 * Exercises the REAL messaging paths with two independent AgentServer instances:
 *
 * - Agent A sends → HTTP relay → Agent B receives and stores
 * - Agent A sends → offline drop → Agent B starts → pickupDroppedMessages → ingested
 * - Full send → relay → receive → ack lifecycle across agents
 * - Security: wrong token rejected, tampered HMAC rejected, no-auth rejected
 * - Concurrent message delivery between agents
 * - Bidirectional: A→B and B→A relay
 * - Thread continuity across agents (query → response)
 * - Message type and priority routing
 * - Rate limiting behavior
 *
 * Uses real HTTP servers on ephemeral ports — no mocks for the routing layer.
 * The only mock is tmux operations (since tests run without tmux).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import { MessageFormatter } from '../../src/messaging/MessageFormatter.js';
import { MessageDelivery } from '../../src/messaging/MessageDelivery.js';
import { MessageRouter } from '../../src/messaging/MessageRouter.js';
import { createMockSessionManager } from '../helpers/setup.js';
import {
  generateAgentToken,
  deleteAgentToken,
  computeDropHmac,
} from '../../src/messaging/AgentTokenManager.js';
import { pickupDroppedMessages } from '../../src/messaging/DropPickup.js';
import { SessionSummarySentinel } from '../../src/messaging/SessionSummarySentinel.js';
import { SpawnRequestManager } from '../../src/messaging/SpawnRequestManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import type { MessageEnvelope } from '../../src/messaging/types.js';
import { registerAgent, unregisterAgent } from '../../src/core/AgentRegistry.js';

// ── Helpers ──────────────────────────────────────────────────────

const mockTmux = {
  getForegroundProcess: () => 'bash',
  isSessionAlive: () => true,
  hasActiveHumanInput: () => false,
  sendKeys: () => true,
  getOutputLineCount: () => 100,
};

interface TestAgent {
  name: string;
  port: number;
  authToken: string;
  agentToken: string;
  projectDir: string;
  stateDir: string;
  server: AgentServer;
  store: MessageStore;
  router: MessageRouter;
  app: ReturnType<AgentServer['getApp']>;
}

async function createTestAgent(name: string): Promise<TestAgent> {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `instar-e2e-${name}-`));
  const stateDir = path.join(projectDir, '.instar');

  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

  const messagingDir = path.join(stateDir, 'messages');
  const store = new MessageStore(messagingDir);
  await store.initialize();

  const formatter = new MessageFormatter();
  const delivery = new MessageDelivery(formatter, mockTmux);
  const authToken = `auth-${name}-${Date.now()}`;

  // We need port 0 to get ephemeral ports, but we need the actual port for routing
  const router = new MessageRouter(store, delivery, {
    localAgent: name,
    localMachine: 'test-machine',
    serverUrl: 'http://localhost:0', // Updated after server starts
  });

  const config: InstarConfig = {
    projectName: name,
    projectDir,
    stateDir,
    port: 0, // Ephemeral port
    authToken,
    requestTimeoutMs: 5000,
    version: '0.10.1',
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

  const agentToken = generateAgentToken(name);
  const state = new StateManager(stateDir);
  const mockSM = createMockSessionManager();

  const summarySentinel = new SessionSummarySentinel({
    stateDir,
    getActiveSessions: () => [],
    captureOutput: () => null,
  });

  const spawnManager = new SpawnRequestManager({
    maxSessions: 3,
    getActiveSessions: () => [],
    spawnSession: async (prompt) => `spawned-${name}-${Date.now()}`,
    cooldownMs: 500, // Short cooldown for E2E tests
  });

  const server = new AgentServer({
    config,
    sessionManager: mockSM as any,
    state,
    messageRouter: router,
    summarySentinel,
    spawnManager,
  });

  await server.start();
  const app = server.getApp();

  // Get the actual port
  const address = (server as any).server?.address();
  const port = typeof address === 'object' ? address.port : 0;

  // Update router config with actual port (use reflection since config is readonly)
  (router as any).config.serverUrl = `http://localhost:${port}`;

  return {
    name,
    port,
    authToken,
    agentToken,
    projectDir,
    stateDir,
    server,
    store,
    router,
    app,
  };
}

async function destroyTestAgent(agent: TestAgent): Promise<void> {
  await agent.server.stop();
  await agent.store.destroy();
  deleteAgentToken(agent.name);
  unregisterAgent(agent.projectDir);
  // safe-git-allow: incremental-migration
  fs.rmSync(agent.projectDir, { recursive: true, force: true });
}

function makeEnvelope(
  from: { agent: string; session?: string; machine?: string },
  to: { agent: string; session?: string; machine?: string },
  overrides?: Partial<{ type: string; priority: string; subject: string; body: string }>,
): MessageEnvelope {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    message: {
      id: crypto.randomUUID(),
      from: { agent: from.agent, session: from.session ?? 'test-session', machine: from.machine ?? 'test-machine' },
      to: { agent: to.agent, session: to.session ?? 'best', machine: to.machine ?? 'local' },
      type: (overrides?.type as any) ?? 'info',
      priority: (overrides?.priority as any) ?? 'medium',
      subject: overrides?.subject ?? 'E2E test message',
      body: overrides?.body ?? 'Test body content',
      createdAt: now,
      ttlMinutes: 30,
    },
    transport: {
      relayChain: [],
      originServer: 'http://localhost:0',
      nonce: `${crypto.randomUUID()}:${now}`,
      timestamp: now,
    },
    delivery: {
      phase: 'sent',
      transitions: [{ from: 'created', to: 'sent', at: now }],
      attempts: 0,
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('E2E: Multi-Agent Messaging (same machine)', () => {
  let agentA: TestAgent;
  let agentB: TestAgent;

  beforeAll(async () => {
    agentA = await createTestAgent('e2e-agent-alpha');
    agentB = await createTestAgent('e2e-agent-beta');

    // Register both agents in the global agent registry so they can discover each other
    registerAgent(agentA.projectDir, agentA.name, agentA.port, 'project-bound', process.pid);
    registerAgent(agentB.projectDir, agentB.name, agentB.port, 'project-bound', process.pid);
  });

  afterAll(async () => {
    await destroyTestAgent(agentA);
    await destroyTestAgent(agentB);
  });

  // ── Cross-Agent HTTP Relay ───────────────────────────────────

  describe('cross-agent HTTP relay', () => {
    it('Agent A sends → HTTP relay → Agent B receives', async () => {
      const sendRes = await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          from: { agent: agentA.name, session: 'sender-session', machine: 'test-machine' },
          to: { agent: agentB.name, session: 'best', machine: 'local' },
          type: 'info',
          priority: 'medium',
          subject: 'Hello from Alpha',
          body: 'Cross-agent relay test',
        })
        .expect(201);

      expect(sendRes.body.messageId).toBeDefined();
      expect(sendRes.body.phase).toBe('received');

      // Verify Agent B's store has the message
      const stored = await agentB.store.get(sendRes.body.messageId);
      expect(stored).not.toBeNull();
      expect(stored!.message.body).toBe('Cross-agent relay test');
      expect(stored!.delivery.phase).toBe('received');
    });

    it('Agent B sends → HTTP relay → Agent A receives (bidirectional)', async () => {
      const sendRes = await request(agentB.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .send({
          from: { agent: agentB.name, session: 'beta-session', machine: 'test-machine' },
          to: { agent: agentA.name, session: 'best', machine: 'local' },
          type: 'info',
          priority: 'high',
          subject: 'Reply from Beta',
          body: 'Bidirectional relay works',
        })
        .expect(201);

      expect(sendRes.body.phase).toBe('received');

      // Verify Agent A's store has the message
      const stored = await agentA.store.get(sendRes.body.messageId);
      expect(stored).not.toBeNull();
      expect(stored!.message.subject).toBe('Reply from Beta');
      expect(stored!.message.priority).toBe('high');
    });

    it('sends multiple messages in sequence — all received', async () => {
      const messageIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await request(agentA.app)
          .post('/messages/send')
          .set('Authorization', `Bearer ${agentA.authToken}`)
          .send({
            from: { agent: agentA.name, session: 'batch', machine: 'test-machine' },
            to: { agent: agentB.name, session: 'best', machine: 'local' },
            type: 'info',
            priority: 'low',
            subject: `Batch message ${i}`,
            body: `Message number ${i}`,
          })
          .expect(201);

        expect(res.body.phase).toBe('received');
        messageIds.push(res.body.messageId);
      }

      // Verify all messages arrived at Agent B
      for (const id of messageIds) {
        const stored = await agentB.store.get(id);
        expect(stored).not.toBeNull();
        expect(stored!.delivery.phase).toBe('received');
      }
    });
  });

  // ── Direct Relay Endpoint ────────────────────────────────────

  describe('relay-agent endpoint', () => {
    it('accepts envelope with correct agent token', async () => {
      const envelope = makeEnvelope(
        { agent: agentA.name },
        { agent: agentB.name },
        { subject: 'Direct relay test' },
      );

      const res = await request(agentB.app)
        .post('/messages/relay-agent')
        .set('Authorization', `Bearer ${agentB.agentToken}`)
        .send(envelope)
        .expect(200);

      expect(res.body.ok).toBe(true);

      const stored = await agentB.store.get(envelope.message.id);
      expect(stored).not.toBeNull();
    });

    it('rejects envelope with wrong agent token', async () => {
      const envelope = makeEnvelope(
        { agent: agentA.name },
        { agent: agentB.name },
      );

      await request(agentB.app)
        .post('/messages/relay-agent')
        .set('Authorization', 'Bearer wrong-token-value')
        .send(envelope)
        .expect(401);
    });

    it('rejects envelope with no auth header', async () => {
      const envelope = makeEnvelope(
        { agent: agentA.name },
        { agent: agentB.name },
      );

      await request(agentB.app)
        .post('/messages/relay-agent')
        .send(envelope)
        .expect(401);
    });

    it('rejects envelope with self in relay chain (loop prevention)', async () => {
      const envelope = makeEnvelope(
        { agent: agentA.name },
        { agent: agentB.name },
      );
      envelope.transport.relayChain = ['test-machine']; // B's machine is in chain

      const res = await request(agentB.app)
        .post('/messages/relay-agent')
        .set('Authorization', `Bearer ${agentB.agentToken}`)
        .send(envelope)
        .expect(409);

      expect(res.body.error).toContain('loop');
    });

    it('handles duplicate envelope gracefully (idempotent)', async () => {
      const envelope = makeEnvelope(
        { agent: agentA.name },
        { agent: agentB.name },
        { subject: 'Duplicate test' },
      );

      // First relay
      await request(agentB.app)
        .post('/messages/relay-agent')
        .set('Authorization', `Bearer ${agentB.agentToken}`)
        .send(envelope)
        .expect(200);

      // Second relay of same message — should be accepted (ACK) not error
      const res = await request(agentB.app)
        .post('/messages/relay-agent')
        .set('Authorization', `Bearer ${agentB.agentToken}`)
        .send(envelope)
        .expect(200);

      expect(res.body.ok).toBe(true);
    });

    it('rejects invalid/malformed envelope', async () => {
      await request(agentB.app)
        .post('/messages/relay-agent')
        .set('Authorization', `Bearer ${agentB.agentToken}`)
        .send({ not: 'an envelope' })
        .expect(400);
    });
  });

  // ── Offline Drop + Pickup ────────────────────────────────────

  describe('offline drop and pickup', () => {
    it('drops message when target agent is offline, picks up on startup', async () => {
      const offlineAgent = `e2e-offline-${Date.now()}`;
      const offlineToken = generateAgentToken(offlineAgent);

      try {
        // Agent A sends to an offline (unregistered) agent → should drop to filesystem
        const sendRes = await request(agentA.app)
          .post('/messages/send')
          .set('Authorization', `Bearer ${agentA.authToken}`)
          .send({
            from: { agent: agentA.name, session: 'drop-test', machine: 'test-machine' },
            to: { agent: offlineAgent, session: 'best', machine: 'local' },
            type: 'info',
            priority: 'medium',
            subject: 'Message for offline agent',
            body: 'You should find this when you wake up',
          })
          .expect(201);

        expect(sendRes.body.phase).toBe('queued');

        // Verify drop file exists
        const dropDir = path.join(os.homedir(), '.instar', 'messages', 'drop', offlineAgent);
        expect(fs.existsSync(dropDir)).toBe(true);
        const files = fs.readdirSync(dropDir).filter(f => f.endsWith('.json'));
        expect(files.length).toBeGreaterThanOrEqual(1);

        // Now simulate the offline agent starting up and picking up messages
        const pickupStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-pickup-'));
        const pickupStore = new MessageStore(pickupStoreDir);
        await pickupStore.initialize();

        const pickupResult = await pickupDroppedMessages(offlineAgent, pickupStore);

        expect(pickupResult.ingested).toBe(1);
        expect(pickupResult.rejected).toBe(0);

        // Verify the message was ingested
        const stored = await pickupStore.get(sendRes.body.messageId);
        expect(stored).not.toBeNull();
        expect(stored!.message.body).toBe('You should find this when you wake up');
        expect(stored!.delivery.phase).toBe('received');

        // Verify the drop file was cleaned up
        const remainingFiles = fs.readdirSync(dropDir).filter(f => f.endsWith('.json'));
        expect(remainingFiles.length).toBe(0);

        await pickupStore.destroy();
        // safe-git-allow: incremental-migration
        fs.rmSync(pickupStoreDir, { recursive: true, force: true });
      } finally {
        deleteAgentToken(offlineAgent);
        // Clean up drop directory
        const dropDir = path.join(os.homedir(), '.instar', 'messages', 'drop', offlineAgent);
        // safe-git-allow: incremental-migration
        try { fs.rmSync(dropDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    it('rejects tampered drop files (HMAC verification)', async () => {
      const offlineAgent = `e2e-tamper-${Date.now()}`;
      generateAgentToken(offlineAgent);

      try {
        // Agent A sends to offline agent
        await request(agentA.app)
          .post('/messages/send')
          .set('Authorization', `Bearer ${agentA.authToken}`)
          .send({
            from: { agent: agentA.name, session: 'tamper-test', machine: 'test-machine' },
            to: { agent: offlineAgent, session: 'best', machine: 'local' },
            type: 'info',
            priority: 'medium',
            subject: 'Tamper target',
            body: 'Original body',
          })
          .expect(201);

        // Tamper with the drop file
        const dropDir = path.join(os.homedir(), '.instar', 'messages', 'drop', offlineAgent);
        const files = fs.readdirSync(dropDir).filter(f => f.endsWith('.json'));
        expect(files.length).toBe(1);

        const filePath = path.join(dropDir, files[0]);
        const envelope = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        envelope.message.body = 'TAMPERED BODY'; // Change body after HMAC was computed
        fs.writeFileSync(filePath, JSON.stringify(envelope));

        // Pickup should reject the tampered message
        const pickupStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tamper-'));
        const pickupStore = new MessageStore(pickupStoreDir);
        await pickupStore.initialize();

        const result = await pickupDroppedMessages(offlineAgent, pickupStore);
        expect(result.rejected).toBe(1);
        expect(result.ingested).toBe(0);
        expect(result.rejections[0].reason).toContain('invalid HMAC');

        await pickupStore.destroy();
        // safe-git-allow: incremental-migration
        fs.rmSync(pickupStoreDir, { recursive: true, force: true });
      } finally {
        deleteAgentToken(offlineAgent);
        const dropDir = path.join(os.homedir(), '.instar', 'messages', 'drop', offlineAgent);
        // safe-git-allow: incremental-migration
        try { fs.rmSync(dropDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    it('handles multiple dropped messages for same agent', async () => {
      const offlineAgent = `e2e-multi-drop-${Date.now()}`;
      generateAgentToken(offlineAgent);

      try {
        // Send 3 messages to offline agent
        const messageIds: string[] = [];
        for (let i = 0; i < 3; i++) {
          const res = await request(agentA.app)
            .post('/messages/send')
            .set('Authorization', `Bearer ${agentA.authToken}`)
            .send({
              from: { agent: agentA.name, session: 'multi-drop', machine: 'test-machine' },
              to: { agent: offlineAgent, session: 'best', machine: 'local' },
              type: 'info',
              priority: 'medium',
              subject: `Multi-drop ${i}`,
              body: `Drop message ${i}`,
            })
            .expect(201);
          messageIds.push(res.body.messageId);
        }

        // Pickup all
        const pickupStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-multidrop-'));
        const pickupStore = new MessageStore(pickupStoreDir);
        await pickupStore.initialize();

        const result = await pickupDroppedMessages(offlineAgent, pickupStore);
        expect(result.ingested).toBe(3);
        expect(result.rejected).toBe(0);

        for (const id of messageIds) {
          const stored = await pickupStore.get(id);
          expect(stored).not.toBeNull();
        }

        await pickupStore.destroy();
        // safe-git-allow: incremental-migration
        fs.rmSync(pickupStoreDir, { recursive: true, force: true });
      } finally {
        deleteAgentToken(offlineAgent);
        const dropDir = path.join(os.homedir(), '.instar', 'messages', 'drop', offlineAgent);
        // safe-git-allow: incremental-migration
        try { fs.rmSync(dropDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });

  // ── Full Lifecycle ───────────────────────────────────────────

  describe('full message lifecycle', () => {
    it('send → relay → receive → deliver-simulated → ack → read', async () => {
      // Step 1: Agent A sends to Agent B
      const sendRes = await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          from: { agent: agentA.name, session: 'lifecycle', machine: 'test-machine' },
          to: { agent: agentB.name, session: 'best', machine: 'local' },
          type: 'query',
          priority: 'high',
          subject: 'Lifecycle test query',
          body: 'Please confirm receipt',
        })
        .expect(201);

      const messageId = sendRes.body.messageId;
      expect(sendRes.body.phase).toBe('received');
      expect(sendRes.body.threadId).toBeDefined(); // Auto-created for query type

      // Step 2: Verify Agent B received it
      const received = await agentB.store.get(messageId);
      expect(received).not.toBeNull();
      expect(received!.delivery.phase).toBe('received');

      // Step 3: Simulate delivery to Agent B's session
      await agentB.store.updateDelivery(messageId, {
        phase: 'delivered',
        transitions: [
          ...received!.delivery.transitions,
          { from: 'received', to: 'delivered', at: new Date().toISOString() },
        ],
        attempts: 1,
      });

      // Step 4: Agent B acknowledges
      const ackRes = await request(agentB.app)
        .post('/messages/ack')
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .send({
          messageId,
          sessionId: 'beta-session',
        })
        .expect(200);

      expect(ackRes.body.ok).toBe(true);

      // Step 5: Verify final state is 'read'
      const final = await agentB.store.get(messageId);
      expect(final!.delivery.phase).toBe('read');
      expect(final!.delivery.transitions.length).toBeGreaterThanOrEqual(3);
    });

    it('query → response thread continuity across agents', async () => {
      // Step 1: Agent A sends a query to Agent B
      const queryRes = await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          from: { agent: agentA.name, session: 'thread-test', machine: 'test-machine' },
          to: { agent: agentB.name, session: 'best', machine: 'local' },
          type: 'query',
          priority: 'medium',
          subject: 'What is your status?',
          body: 'Please report current state',
        })
        .expect(201);

      const threadId = queryRes.body.threadId;
      expect(threadId).toBeDefined();

      // Step 2: Agent B sends a response continuing the thread
      const responseRes = await request(agentB.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .send({
          from: { agent: agentB.name, session: 'beta-session', machine: 'test-machine' },
          to: { agent: agentA.name, session: 'thread-test', machine: 'local' },
          type: 'response',
          priority: 'medium',
          subject: 'Status report',
          body: 'All systems operational',
          options: {
            threadId,
            inReplyTo: queryRes.body.messageId,
          },
        })
        .expect(201);

      // Step 3: Verify Agent A received the response with correct thread
      const response = await agentA.store.get(responseRes.body.messageId);
      expect(response).not.toBeNull();
      expect(response!.message.threadId).toBe(threadId);
      expect(response!.message.inReplyTo).toBe(queryRes.body.messageId);
    });
  });

  // ── Message Types and Priority ───────────────────────────────

  describe('message types and priority', () => {
    const messageTypes = ['info', 'sync', 'alert', 'request', 'query', 'response', 'handoff', 'wellness', 'system'];

    for (const type of messageTypes) {
      it(`routes '${type}' type message successfully`, async () => {
        const opts: any = {
          from: { agent: agentA.name, session: 'type-test', machine: 'test-machine' },
          to: { agent: agentB.name, session: 'best', machine: 'local' },
          type,
          priority: 'medium',
          subject: `${type} message`,
          body: `Testing ${type} routing`,
        };
        // query and request auto-create threads — not relevant but need threadId for response
        if (type === 'response') {
          opts.options = {
            threadId: crypto.randomUUID(),
            inReplyTo: crypto.randomUUID(),
          };
        }

        const res = await request(agentA.app)
          .post('/messages/send')
          .set('Authorization', `Bearer ${agentA.authToken}`)
          .send(opts)
          .expect(201);

        expect(res.body.phase).toBe('received');
      });
    }

    it('routes all priority levels', async () => {
      for (const priority of ['low', 'medium', 'high', 'critical']) {
        const res = await request(agentA.app)
          .post('/messages/send')
          .set('Authorization', `Bearer ${agentA.authToken}`)
          .send({
            from: { agent: agentA.name, session: 'prio-test', machine: 'test-machine' },
            to: { agent: agentB.name, session: 'best', machine: 'local' },
            type: 'info',
            priority,
            subject: `Priority ${priority}`,
            body: `Testing ${priority} routing`,
          })
          .expect(201);

        const stored = await agentB.store.get(res.body.messageId);
        expect(stored!.message.priority).toBe(priority);
      }
    });
  });

  // ── Echo Prevention ──────────────────────────────────────────

  describe('echo prevention', () => {
    it('rejects sending to the same agent+session via API', async () => {
      const res = await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          from: { agent: agentA.name, session: 'echo-test', machine: 'test-machine' },
          to: { agent: agentA.name, session: 'echo-test', machine: 'local' },
          type: 'info',
          priority: 'low',
          subject: 'Self-send',
          body: 'Should be rejected',
        })
        .expect(400);

      expect(res.body.error).toContain('echo');
    });

    it('allows sending to same agent but different session', async () => {
      const res = await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          from: { agent: agentA.name, session: 'session-1', machine: 'test-machine' },
          to: { agent: agentA.name, session: 'session-2', machine: 'local' },
          type: 'info',
          priority: 'low',
          subject: 'Inter-session message',
          body: 'Same agent, different session',
        })
        .expect(201);

      expect(res.body.phase).toBe('sent');
    });
  });

  // ── Stats Endpoint ───────────────────────────────────────────

  describe('stats endpoint', () => {
    it('reflects messages sent and received across agents', async () => {
      const statsA = await request(agentA.app)
        .get('/messages/stats')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(200);

      const statsB = await request(agentB.app)
        .get('/messages/stats')
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .expect(200);

      // Agent A has been sending many messages
      expect(statsA.body.volume).toBeDefined();
      expect(statsA.body.delivery).toBeDefined();

      // Agent B has been receiving many messages
      expect(statsB.body.volume).toBeDefined();
    });
  });

  // ── Auth Enforcement ─────────────────────────────────────────

  describe('auth enforcement', () => {
    it('rejects unauthenticated send', async () => {
      await request(agentA.app)
        .post('/messages/send')
        .send({
          from: { agent: agentA.name, session: 's', machine: 'm' },
          to: { agent: agentB.name, session: 'best', machine: 'local' },
          type: 'info',
          priority: 'low',
          subject: 'No auth',
          body: 'Should fail',
        })
        .expect(401);
    });

    it('rejects wrong auth token on send', async () => {
      await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', 'Bearer wrong-token')
        .send({
          from: { agent: agentA.name, session: 's', machine: 'm' },
          to: { agent: agentB.name, session: 'best', machine: 'local' },
          type: 'info',
          priority: 'low',
          subject: 'Wrong auth',
          body: 'Should fail',
        })
        .expect(403); // Middleware returns 403 for incorrect token (vs 401 for missing header)
    });

    it('rejects unauthenticated ack', async () => {
      await request(agentA.app)
        .post('/messages/ack')
        .send({ messageId: 'any', sessionId: 'any' })
        .expect(401);
    });

    it('rejects unauthenticated stats', async () => {
      await request(agentA.app)
        .get('/messages/stats')
        .expect(401);
    });
  });

  // ── Validation ───────────────────────────────────────────────

  describe('input validation', () => {
    it('rejects send with missing fields', async () => {
      await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({ from: { agent: 'a', session: 's', machine: 'm' } })
        .expect(400);
    });

    it('rejects ack with missing sessionId', async () => {
      await request(agentA.app)
        .post('/messages/ack')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({ messageId: 'some-id' })
        .expect(400);
    });

    it('rejects ack with missing messageId', async () => {
      await request(agentA.app)
        .post('/messages/ack')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({ sessionId: 'some-session' })
        .expect(400);
    });
  });

  // ── Message Persistence ──────────────────────────────────────

  describe('message persistence', () => {
    it('messages survive store re-initialization', async () => {
      // Send a message
      const sendRes = await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          from: { agent: agentA.name, session: 'persist', machine: 'test-machine' },
          to: { agent: agentB.name, session: 'best', machine: 'local' },
          type: 'alert',
          priority: 'critical',
          subject: 'Persistence test',
          body: 'This must survive restarts',
        })
        .expect(201);

      // Re-initialize Agent B's store (simulates restart)
      const messagingDir = path.join(agentB.stateDir, 'messages');
      const freshStore = new MessageStore(messagingDir);
      await freshStore.initialize();

      const stored = await freshStore.get(sendRes.body.messageId);
      expect(stored).not.toBeNull();
      expect(stored!.message.subject).toBe('Persistence test');
      expect(stored!.message.priority).toBe('critical');

      await freshStore.destroy();
    });

    it('message file exists on disk with correct content', async () => {
      const sendRes = await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          from: { agent: agentA.name, session: 'disk-check', machine: 'test-machine' },
          to: { agent: agentB.name, session: 'best', machine: 'local' },
          type: 'info',
          priority: 'low',
          subject: 'Disk check',
          body: 'Verify file on disk',
        })
        .expect(201);

      const filePath = path.join(agentB.stateDir, 'messages', 'store', `${sendRes.body.messageId}.json`);
      expect(fs.existsSync(filePath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(content.message.subject).toBe('Disk check');
    });
  });

  // ── Inbox & Outbox ───────────────────────────────────────────

  describe('inbox and outbox queries', () => {
    it('Agent B inbox contains messages from Agent A', async () => {
      const uniqueSubject = `inbox-test-${Date.now()}`;
      await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          from: { agent: agentA.name, session: 'inbox-test', machine: 'test-machine' },
          to: { agent: agentB.name, session: 'best', machine: 'local' },
          type: 'info',
          priority: 'medium',
          subject: uniqueSubject,
          body: 'For inbox query test',
        })
        .expect(201);

      const inbox = await agentB.store.queryInbox(agentB.name);
      const found = inbox.find(e => e.message.subject === uniqueSubject);
      expect(found).toBeDefined();
    });

    it('Agent A outbox contains sent messages', async () => {
      const uniqueSubject = `outbox-test-${Date.now()}`;
      await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          from: { agent: agentA.name, session: 'outbox-test', machine: 'test-machine' },
          to: { agent: agentB.name, session: 'best', machine: 'local' },
          type: 'info',
          priority: 'medium',
          subject: uniqueSubject,
          body: 'For outbox query test',
        })
        .expect(201);

      const outbox = await agentA.store.queryOutbox(agentA.name);
      const found = outbox.find(e => e.message.subject === uniqueSubject);
      expect(found).toBeDefined();
    });
  });

  // ── Phase 6: Query endpoint E2E ────────────────────────────────

  describe('query endpoints — full HTTP lifecycle', () => {
    it('GET /messages/inbox returns messages via HTTP', async () => {
      const res = await request(agentB.app)
        .get('/messages/inbox')
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .expect(200);
      expect(res.body).toHaveProperty('messages');
      expect(res.body).toHaveProperty('count');
      expect(res.body.count).toBeGreaterThan(0);
    });

    it('GET /messages/outbox returns sent messages via HTTP', async () => {
      const res = await request(agentA.app)
        .get('/messages/outbox')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(200);
      expect(res.body).toHaveProperty('messages');
      expect(res.body.count).toBeGreaterThan(0);
    });

    it('GET /messages/:id returns a specific message', async () => {
      // Send a message and retrieve it by ID
      const sendRes = await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          from: { agent: agentA.name, session: 'getbyid-test', machine: 'test-machine' },
          to: { agent: agentA.name, session: 'getbyid-target', machine: 'local' },
          type: 'info',
          priority: 'low',
          subject: 'Get by ID E2E test',
          body: 'Testing the GET /:id endpoint in E2E',
        })
        .expect(201);

      const getRes = await request(agentA.app)
        .get(`/messages/${sendRes.body.messageId}`)
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(200);
      expect(getRes.body.message.id).toBe(sendRes.body.messageId);
      expect(getRes.body.message.subject).toBe('Get by ID E2E test');
    });

    it('GET /messages/:id returns 404 for non-existent message', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      await request(agentA.app)
        .get(`/messages/${fakeId}`)
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(404);
    });

    it('GET /messages/dead-letter returns empty initially', async () => {
      const res = await request(agentA.app)
        .get('/messages/dead-letter')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(200);
      expect(res.body).toHaveProperty('messages');
      expect(Array.isArray(res.body.messages)).toBe(true);
    });

    it('GET /messages/inbox supports filtering by type', async () => {
      const res = await request(agentB.app)
        .get('/messages/inbox?type=info')
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .expect(200);
      for (const msg of res.body.messages) {
        expect(msg.message.type).toBe('info');
      }
    });

    it('GET /messages/stats still works (not caught by /:id)', async () => {
      const res = await request(agentA.app)
        .get('/messages/stats')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(200);
      expect(res.body).toHaveProperty('volume');
      expect(res.body).toHaveProperty('delivery');
    });
  });

  // ── Phase 7: Thread lifecycle E2E ────────────────────────────

  describe('thread lifecycle — cross-agent E2E', () => {
    let threadId: string;

    it('query message auto-creates thread', async () => {
      const res = await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          from: { agent: agentA.name, session: 'thread-e2e', machine: 'test-machine' },
          to: { agent: agentA.name, session: 'thread-e2e-target', machine: 'local' },
          type: 'query',
          priority: 'medium',
          subject: 'E2E thread test',
          body: 'Testing full thread lifecycle',
        })
        .expect(201);
      expect(res.body.threadId).toBeDefined();
      threadId = res.body.threadId;
    });

    it('thread is queryable via GET /messages/thread/:id', async () => {
      const res = await request(agentA.app)
        .get(`/messages/thread/${threadId}`)
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(200);
      expect(res.body.thread.id).toBe(threadId);
      expect(res.body.thread.status).toBe('active');
      expect(res.body.thread.messageCount).toBe(1);
    });

    it('thread appears in GET /messages/threads listing', async () => {
      const res = await request(agentA.app)
        .get('/messages/threads')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(200);
      const found = res.body.threads.find((t: any) => t.id === threadId);
      expect(found).toBeDefined();
    });

    it('reply grows the thread', async () => {
      await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          from: { agent: agentA.name, session: 'thread-e2e-target', machine: 'test-machine' },
          to: { agent: agentA.name, session: 'thread-e2e', machine: 'local' },
          type: 'response',
          priority: 'medium',
          subject: 'Re: E2E thread test',
          body: 'Lifecycle confirmed',
          options: { threadId },
        })
        .expect(201);

      const res = await request(agentA.app)
        .get(`/messages/thread/${threadId}`)
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(200);
      expect(res.body.thread.messageCount).toBe(2);
    });

    it('resolve closes and archives the thread', async () => {
      await request(agentA.app)
        .post(`/messages/thread/${threadId}/resolve`)
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(200);

      // Still queryable but resolved
      const res = await request(agentA.app)
        .get(`/messages/thread/${threadId}`)
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(200);
      expect(res.body.thread.status).toBe('resolved');
    });

    it('stats include thread counts', async () => {
      const res = await request(agentA.app)
        .get('/messages/stats')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(200);
      expect(res.body.threads).toBeDefined();
      expect(typeof res.body.threads.active).toBe('number');
      expect(typeof res.body.threads.resolved).toBe('number');
    });
  });

  // ── Phase 3: Delivery Retry, Watchdog, Expiry ────────────────

  describe('delivery retry and expiry (E2E)', () => {
    it('expired messages sent cross-agent are dead-lettered by retry manager', async () => {
      // Send a message from A→B, then backdate it so it's expired
      const sendRes = await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          from: { agent: agentA.name, session: 'session-a', machine: 'test-machine' },
          to: { agent: agentB.name, session: 'session-b', machine: 'test-machine' },
          type: 'info',
          priority: 'low',
          subject: 'Will expire soon',
          body: 'Testing expiry in E2E',
          options: { ttlMinutes: 1 },
        })
        .expect(201);
      const messageId = sendRes.body.messageId;

      // Get the message on B's side and backdate it
      const envelope = await agentB.store.get(messageId);
      if (envelope) {
        // Backdate creation to 2 hours ago so TTL (1 min) is expired
        envelope.message.createdAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
        // Regress to queued so retry manager picks it up
        envelope.delivery.phase = 'queued';
        envelope.delivery.transitions.push({
          from: 'delivered',
          to: 'queued',
          at: new Date().toISOString(),
          reason: 'test: simulating stale message',
        });
        await agentB.store.updateEnvelope(envelope);
      }

      // Create retry manager for B and tick
      const { DeliveryRetryManager } = await import('../../src/messaging/DeliveryRetryManager.js');
      const formatter = new MessageFormatter();
      const delivery = new MessageDelivery(formatter, mockTmux);
      const retryMgr = new DeliveryRetryManager(agentB.store, delivery, {
        agentName: agentB.name,
      });
      const result = await retryMgr.tick();
      expect(result.expired).toBeGreaterThanOrEqual(1);
      retryMgr.stop();

      // Verify dead-letter via B's API
      const deadRes = await request(agentB.app)
        .get('/messages/dead-letter')
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .expect(200);
      const found = deadRes.body.messages.find((m: any) => m.message.id === messageId);
      expect(found).toBeDefined();
    });

    it('retry manager delivers queued messages and they become visible in inbox', async () => {
      // Create a queued message directly in B's store (simulates relay arrival)
      const msgId = crypto.randomUUID();
      const envelope = {
        schemaVersion: 1,
        message: {
          id: msgId,
          from: { agent: agentA.name, session: 'session-a', machine: 'test-machine' },
          to: { agent: agentB.name, session: 'session-b', machine: 'local' },
          type: 'info' as const,
          priority: 'medium' as const,
          subject: 'Retry test',
          body: 'Should be delivered by retry manager',
          createdAt: new Date().toISOString(),
          ttlMinutes: 30,
        },
        transport: {
          relayChain: [],
          originServer: 'http://localhost:0',
          nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
          timestamp: new Date().toISOString(),
        },
        delivery: {
          phase: 'queued' as const,
          transitions: [
            { from: 'created', to: 'sent', at: new Date().toISOString() },
            { from: 'sent', to: 'queued', at: new Date().toISOString() },
          ],
          attempts: 0,
        },
      };
      await agentB.store.save(envelope as any);

      // Tick the retry manager
      const { DeliveryRetryManager } = await import('../../src/messaging/DeliveryRetryManager.js');
      const formatter = new MessageFormatter();
      const delivery = new MessageDelivery(formatter, mockTmux);
      const retryMgr = new DeliveryRetryManager(agentB.store, delivery, {
        agentName: agentB.name,
      });
      const result = await retryMgr.tick();
      expect(result.retried).toBeGreaterThanOrEqual(1);
      retryMgr.stop();

      // Verify through B's HTTP API
      const res = await request(agentB.app)
        .get(`/messages/${msgId}`)
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .expect(200);
      expect(res.body.delivery.phase).toBe('delivered');
    });

    it('ACK timeout causes escalation for cross-agent query messages', async () => {
      const escalations: Array<{ reason: string }> = [];

      // Create a delivered query message backdated beyond 5-min ACK timeout
      const msgId = crypto.randomUUID();
      const sixMinAgo = new Date(Date.now() - 6 * 60_000).toISOString();
      const envelope = {
        schemaVersion: 1,
        message: {
          id: msgId,
          from: { agent: agentA.name, session: 'session-a', machine: 'test-machine' },
          to: { agent: agentB.name, session: 'session-b', machine: 'local' },
          type: 'query' as const,
          priority: 'medium' as const,
          subject: 'Unanswered query E2E',
          body: 'Waiting for ACK',
          createdAt: new Date().toISOString(),
          ttlMinutes: 60,
        },
        transport: {
          relayChain: [],
          originServer: 'http://localhost:0',
          nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
          timestamp: new Date().toISOString(),
        },
        delivery: {
          phase: 'delivered' as const,
          transitions: [
            { from: 'created', to: 'sent', at: sixMinAgo },
            { from: 'sent', to: 'queued', at: sixMinAgo },
            { from: 'queued', to: 'delivered', at: sixMinAgo },
          ],
          attempts: 1,
        },
      };
      await agentB.store.save(envelope as any);

      // Tick the retry manager with escalation callback
      const { DeliveryRetryManager } = await import('../../src/messaging/DeliveryRetryManager.js');
      const formatter = new MessageFormatter();
      const delivery = new MessageDelivery(formatter, mockTmux);
      const retryMgr = new DeliveryRetryManager(agentB.store, delivery, {
        agentName: agentB.name,
        onEscalate: (_env, reason) => escalations.push({ reason }),
      });
      const result = await retryMgr.tick();
      expect(result.escalated).toBe(1);
      expect(escalations[0].reason).toContain('ACK timeout');
      retryMgr.stop();
    });

    it('watchdog regresses delivered messages when session process changes', async () => {
      // Create a delivered message
      const msgId = crypto.randomUUID();
      const envelope = {
        schemaVersion: 1,
        message: {
          id: msgId,
          from: { agent: agentA.name, session: 'session-a', machine: 'test-machine' },
          to: { agent: agentB.name, session: 'session-b', machine: 'local' },
          type: 'info' as const,
          priority: 'medium' as const,
          subject: 'Watchdog test',
          body: 'Should regress to queued',
          createdAt: new Date().toISOString(),
          ttlMinutes: 30,
        },
        transport: {
          relayChain: [],
          originServer: 'http://localhost:0',
          nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
          timestamp: new Date().toISOString(),
        },
        delivery: {
          phase: 'delivered' as const,
          transitions: [
            { from: 'created', to: 'sent', at: new Date().toISOString() },
            { from: 'sent', to: 'queued', at: new Date().toISOString() },
            { from: 'queued', to: 'delivered', at: new Date().toISOString() },
          ],
          attempts: 1,
        },
      };
      await agentB.store.save(envelope as any);

      // Create retry manager with unsafe process simulation
      const { DeliveryRetryManager } = await import('../../src/messaging/DeliveryRetryManager.js');
      const formatter = new MessageFormatter();
      const unsafeTmux = {
        ...mockTmux,
        getForegroundProcess: () => 'python', // Session crashed
      };
      const delivery = new MessageDelivery(formatter, unsafeTmux);
      const retryMgr = new DeliveryRetryManager(agentB.store, delivery, {
        agentName: agentB.name,
      });

      // Register watchdog with past timestamp
      retryMgr.registerWatchdog(msgId);
      const watchdogMap = (retryMgr as any).watchdogTargets as Map<string, number>;
      watchdogMap.set(msgId, Date.now() - 11_000); // 11 seconds ago

      await retryMgr.tick();
      retryMgr.stop();

      // Verify regression via HTTP
      const res = await request(agentB.app)
        .get(`/messages/${msgId}`)
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .expect(200);
      expect(res.body.delivery.phase).toBe('queued');

      const lastTransition = res.body.delivery.transitions.at(-1);
      expect(lastTransition.from).toBe('delivered');
      expect(lastTransition.to).toBe('queued');
      expect(lastTransition.reason).toContain('Watchdog');
    });

    it('full retry lifecycle: send → expire → dead-letter → verify via stats', async () => {
      // Get initial stats
      const initialStats = await request(agentB.app)
        .get('/messages/stats')
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .expect(200);
      const initialDeadLetters = initialStats.body.volume?.deadLettered?.total ?? 0;

      // Create an already-expired message in B's store
      const msgId = crypto.randomUUID();
      const envelope = {
        schemaVersion: 1,
        message: {
          id: msgId,
          from: { agent: agentA.name, session: 'session-a', machine: 'test-machine' },
          to: { agent: agentB.name, session: 'session-b', machine: 'local' },
          type: 'info' as const,
          priority: 'low' as const,
          subject: 'Full lifecycle',
          body: 'Testing full retry lifecycle',
          createdAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(), // 3 hours ago
          ttlMinutes: 1,
        },
        transport: {
          relayChain: [],
          originServer: 'http://localhost:0',
          nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
          timestamp: new Date().toISOString(),
        },
        delivery: {
          phase: 'queued' as const,
          transitions: [
            { from: 'created', to: 'sent', at: new Date(Date.now() - 3 * 60 * 60_000).toISOString() },
            { from: 'sent', to: 'queued', at: new Date(Date.now() - 3 * 60 * 60_000).toISOString() },
          ],
          attempts: 0,
        },
      };
      await agentB.store.save(envelope as any);

      // Tick retry manager
      const { DeliveryRetryManager } = await import('../../src/messaging/DeliveryRetryManager.js');
      const formatter = new MessageFormatter();
      const delivery = new MessageDelivery(formatter, mockTmux);
      const retryMgr = new DeliveryRetryManager(agentB.store, delivery, {
        agentName: agentB.name,
      });
      const result = await retryMgr.tick();
      expect(result.expired).toBeGreaterThanOrEqual(1);
      retryMgr.stop();

      // Verify stats reflect new dead-letter
      const finalStats = await request(agentB.app)
        .get('/messages/stats')
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .expect(200);
      expect(finalStats.body.volume.deadLettered.total).toBeGreaterThan(initialDeadLetters);
    });
  });

  // ── Phase 2: Session Summaries & Intelligent Routing ──────

  describe('session summaries and routing (E2E)', () => {
    it('GET /messages/summaries returns from both agents', async () => {
      const resA = await request(agentA.app)
        .get('/messages/summaries')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(200);
      expect(resA.body.summaries).toBeDefined();
      expect(resA.body.status).toBeDefined();

      const resB = await request(agentB.app)
        .get('/messages/summaries')
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .expect(200);
      expect(resB.body.summaries).toBeDefined();
    });

    it('GET /messages/route-score scores sessions for targeted routing', async () => {
      const res = await request(agentA.app)
        .get('/messages/route-score')
        .query({ subject: 'Test routing', body: 'Does this work correctly?' })
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(200);
      expect(res.body.scores).toBeDefined();
      expect(Array.isArray(res.body.scores)).toBe(true);
      expect(typeof res.body.inFallback).toBe('boolean');
    });

    it('route-score returns 400 without required params', async () => {
      await request(agentA.app)
        .get('/messages/route-score')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(400);
    });

    it('summaries and route-score require auth', async () => {
      await request(agentA.app)
        .get('/messages/summaries')
        .expect(401);

      await request(agentA.app)
        .get('/messages/route-score')
        .query({ subject: 'Test', body: 'Test' })
        .expect(401);
    });
  });

  // ── On-Demand Session Spawning (Phase 5) ────────────────────

  describe('spawn request lifecycle', () => {
    it('agent A requests spawn on agent B server — approved', async () => {
      const res = await request(agentB.app)
        .post('/messages/spawn-request')
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .send({
          requester: { agent: agentA.name, session: 'e2e-sess-a', machine: 'test-machine' },
          target: { agent: agentB.name, machine: 'test-machine' },
          reason: 'Cross-agent task coordination',
          priority: 'medium',
        })
        .expect(201);

      expect(res.body.approved).toBe(true);
      expect(res.body.sessionId).toContain('spawned-');
      expect(res.body.reason).toContain('Session spawned');
    });

    // TODO: Flaky — intermittently returns 400 instead of 429. Investigate body parsing race.
    it.skip('repeated spawn request from same agent is cooldown-blocked', async () => {
      // First spawn — approved (use unique agent name to avoid prior cooldown)
      const uniqueAgent = `spawn-test-${Date.now()}`;
      await request(agentA.app)
        .post('/messages/spawn-request')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          requester: { agent: uniqueAgent, session: 's', machine: 'm' },
          target: { agent: agentA.name, machine: 'test-machine' },
          reason: 'First spawn',
          priority: 'medium',
        })
        .expect(201);

      // Immediate second — cooldown blocked
      const res = await request(agentA.app)
        .post('/messages/spawn-request')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          requester: { agent: uniqueAgent, session: 's', machine: 'm' },
          target: { agent: agentA.name, machine: 'test-machine' },
          reason: 'Second spawn',
          priority: 'medium',
        })
        .expect(429);

      expect(res.body.approved).toBe(false);
      expect(res.body.reason).toContain('Cooldown');
      expect(res.body.retryAfterMs).toBeGreaterThan(0);
    });

    it('spawn request with context and pending messages includes them in spawn', async () => {
      const res = await request(agentA.app)
        .post('/messages/spawn-request')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          requester: { agent: 'ctx-agent', session: 'ctx-s', machine: 'm' },
          target: { agent: agentA.name, machine: 'test-machine' },
          reason: 'Process urgent messages',
          context: 'Deployment pipeline stalled',
          priority: 'high',
          pendingMessages: ['msg-1', 'msg-2', 'msg-3'],
          suggestedModel: 'sonnet',
          suggestedMaxDuration: 15,
        })
        .expect(201);

      expect(res.body.approved).toBe(true);
    });

    it('spawn request without required fields returns 400', async () => {
      const res = await request(agentA.app)
        .post('/messages/spawn-request')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          requester: { agent: 'a', session: 's', machine: 'm' },
          // Missing target, reason, priority
        })
        .expect(400);

      expect(res.body.error).toContain('Missing required fields');
    });

    it('spawn request requires auth', async () => {
      await request(agentA.app)
        .post('/messages/spawn-request')
        .send({
          requester: { agent: 'a', session: 's', machine: 'm' },
          target: { agent: 'b', machine: 'm' },
          reason: 'test',
          priority: 'low',
        })
        .expect(401);
    });
  });

  // ── Cross-Machine Transport (Phase 4) ───────────────────────

  describe('cross-machine transport and agent discovery', () => {
    it('agent A queries outbound queue status', async () => {
      const res = await request(agentA.app)
        .get('/messages/outbound')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(200);

      expect(res.body).toHaveProperty('queues');
      expect(res.body).toHaveProperty('totalPending');
      expect(typeof res.body.totalPending).toBe('number');
    });

    it('agent B queries its agent list', async () => {
      const res = await request(agentB.app)
        .get('/messages/agents')
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .expect(200);

      expect(res.body).toHaveProperty('agents');
      expect(res.body).toHaveProperty('machine');
      expect(res.body.machine).toBe(agentB.name);
      expect(Array.isArray(res.body.agents)).toBe(true);
    });

    it('outbound cleanup returns false for non-existent messages', async () => {
      const res = await request(agentA.app)
        .delete('/messages/outbound/nonexistent-machine/nonexistent-msg')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(200);

      expect(res.body.cleaned).toBe(false);
    });

    it('cross-machine routes require auth on both agents', async () => {
      await request(agentA.app).get('/messages/outbound').expect(401);
      await request(agentB.app).get('/messages/agents').expect(401);
      await request(agentA.app).delete('/messages/outbound/m/id').expect(401);
    });
  });

  // ── Full Conversation Thread (Multi-Turn) ────────────────────

  describe('full multi-turn conversation thread', () => {
    it('send → reply → reply → resolve across two agents', async () => {
      // 1. Agent A sends initial query to Agent B
      const sendRes = await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          from: { agent: agentA.name, session: 'conv-a', machine: 'test-machine' },
          to: { agent: agentB.name, session: 'conv-b', machine: 'test-machine' },
          type: 'query',
          priority: 'medium',
          subject: 'Database migration impact?',
          body: 'How does the new column affect performance?',
        })
        .expect(201);
      const originalId = sendRes.body.messageId;
      const threadId = sendRes.body.threadId;
      expect(threadId).toBeDefined();

      // 2. Agent B replies via send (simulating response through its API)
      const reply1Res = await request(agentB.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .send({
          from: { agent: agentB.name, session: 'conv-b', machine: 'test-machine' },
          to: { agent: agentA.name, session: 'conv-a', machine: 'test-machine' },
          type: 'response',
          priority: 'medium',
          subject: 'Re: Database migration impact?',
          body: 'Minimal impact — column is nullable, no migration needed',
          options: { threadId, inReplyTo: originalId },
        })
        .expect(201);
      const reply1Id = reply1Res.body.messageId;

      // 3. Agent A follows up with another question
      const reply2Res = await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          from: { agent: agentA.name, session: 'conv-a', machine: 'test-machine' },
          to: { agent: agentB.name, session: 'conv-b', machine: 'test-machine' },
          type: 'query',
          priority: 'medium',
          subject: 'Re: Database migration impact?',
          body: 'What about index rebuild time?',
          options: { threadId, inReplyTo: reply1Id },
        })
        .expect(201);
      const reply2Id = reply2Res.body.messageId;

      // 4. Agent B resolves the thread
      const resolveRes = await request(agentB.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .send({
          from: { agent: agentB.name, session: 'conv-b', machine: 'test-machine' },
          to: { agent: agentA.name, session: 'conv-a', machine: 'test-machine' },
          type: 'response',
          priority: 'medium',
          subject: 'Re: Database migration impact? [resolved]',
          body: 'Index rebuild is sub-second. Thread resolved.',
          options: { threadId, inReplyTo: reply2Id },
        })
        .expect(201);

      // 5. Verify thread on Agent A side has all messages
      const threadRes = await request(agentA.app)
        .get(`/messages/thread/${threadId}`)
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(200);

      // Thread should have the original + at least the reply that came to A
      expect(threadRes.body.thread).toBeDefined();
      expect(threadRes.body.thread.messageIds.length).toBeGreaterThanOrEqual(2);

      // 6. Verify thread on Agent B side
      const threadResB = await request(agentB.app)
        .get(`/messages/thread/${threadId}`)
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .expect(200);
      expect(threadResB.body.thread.messageIds.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Offline Drop Fallback & Recovery ─────────────────────────

  describe('offline fallback and recovery', () => {
    it('messages queued when target agent offline are recovered on pickup', async () => {
      // Write messages directly to B's drop directory (simulating A dropping while B is offline)
      const dropDir = path.join(os.homedir(), '.instar', 'messages', 'drop', agentB.name);
      fs.mkdirSync(dropDir, { recursive: true });

      const msgIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const msgId = crypto.randomUUID();
        msgIds.push(msgId);
        const envelope = makeEnvelope(
          { agent: agentA.name },
          { agent: agentB.name },
          { subject: `Offline msg ${i + 1}`, body: `Message ${i + 1} while B was offline` },
        );
        envelope.message.id = msgId;
        // Add HMAC for drop verification
        const hmac = computeDropHmac(agentA.agentToken, {
          message: envelope.message,
          originServer: envelope.transport.originServer,
          nonce: envelope.transport.nonce,
          timestamp: envelope.transport.timestamp,
        });
        envelope.transport.hmac = hmac;
        envelope.transport.hmacBy = agentA.name;
        fs.writeFileSync(path.join(dropDir, `${msgId}.json`), JSON.stringify(envelope));
      }

      // Simulate B coming online — pick up drops
      const result = await pickupDroppedMessages(agentB.name, agentB.store);
      expect(result.ingested).toBe(3);
      expect(result.rejected).toBe(0);

      // Verify all 3 are now in B's inbox
      for (const msgId of msgIds) {
        const res = await request(agentB.app)
          .get(`/messages/${msgId}`)
          .set('Authorization', `Bearer ${agentB.authToken}`)
          .expect(200);
        expect(res.body.delivery.phase).toBe('received');
      }
    });

    it('tampered drops are rejected while valid ones are accepted in same batch', async () => {
      const dropDir = path.join(os.homedir(), '.instar', 'messages', 'drop', agentB.name);
      fs.mkdirSync(dropDir, { recursive: true });

      // Valid message
      const validId = crypto.randomUUID();
      const validEnvelope = makeEnvelope({ agent: agentA.name }, { agent: agentB.name });
      validEnvelope.message.id = validId;
      const hmac = computeDropHmac(agentA.agentToken, {
        message: validEnvelope.message,
        originServer: validEnvelope.transport.originServer,
        nonce: validEnvelope.transport.nonce,
        timestamp: validEnvelope.transport.timestamp,
      });
      validEnvelope.transport.hmac = hmac;
      validEnvelope.transport.hmacBy = agentA.name;
      fs.writeFileSync(path.join(dropDir, `${validId}.json`), JSON.stringify(validEnvelope));

      // Tampered message (wrong HMAC)
      const tamperedId = crypto.randomUUID();
      const tamperedEnvelope = makeEnvelope({ agent: agentA.name }, { agent: agentB.name });
      tamperedEnvelope.message.id = tamperedId;
      tamperedEnvelope.transport.hmac = 'definitely-wrong-hmac';
      tamperedEnvelope.transport.hmacBy = agentA.name;
      fs.writeFileSync(path.join(dropDir, `${tamperedId}.json`), JSON.stringify(tamperedEnvelope));

      const result = await pickupDroppedMessages(agentB.name, agentB.store);
      expect(result.ingested).toBe(1);
      expect(result.rejected).toBe(1);

      // Valid one should be in store
      const validRes = await request(agentB.app)
        .get(`/messages/${validId}`)
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .expect(200);
      expect(validRes.body.delivery.phase).toBe('received');

      // Tampered one should NOT be in store
      await request(agentB.app)
        .get(`/messages/${tamperedId}`)
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .expect(404);
    });
  });

  // ── Git-Sync Fallback Simulation ─────────────────────────────

  describe('git-sync fallback simulation', () => {
    it('simulates offline machine → git-sync → dedup on reconnect', async () => {
      const { pickupGitSyncMessages } = await import('../../src/messaging/GitSyncTransport.js');

      // 1. First, send a message from A→B normally (simulates real-time relay)
      const sendRes = await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          from: { agent: agentA.name, session: 'gs-a', machine: 'test-machine' },
          to: { agent: agentB.name, session: 'gs-b', machine: 'test-machine' },
          type: 'info',
          priority: 'medium',
          subject: 'Already delivered via relay',
          body: 'This should be deduped when git-sync arrives',
        })
        .expect(201);
      const relayedMsgId = sendRes.body.messageId;

      // 2. Simulate a git-sync arrival with the same message (duplicate)
      const gitSyncDir = path.join(agentB.stateDir, 'messages', 'outbound', 'remote-machine');
      fs.mkdirSync(gitSyncDir, { recursive: true });

      // Write the same message to git-sync inbound (as if remote synced it)
      const existingEnvelope = await agentB.store.get(relayedMsgId);
      if (existingEnvelope) {
        existingEnvelope.transport.signature = 'fake-sig-for-test';
        existingEnvelope.transport.signedBy = 'remote-machine';
        fs.writeFileSync(
          path.join(gitSyncDir, `${relayedMsgId}.json`),
          JSON.stringify(existingEnvelope),
        );
      }

      // 3. Also write a NEW message that only exists in git-sync
      const newMsgId = crypto.randomUUID();
      const newEnvelope = makeEnvelope(
        { agent: 'remote-agent', machine: 'remote-machine' },
        { agent: agentB.name, machine: 'remote-machine' },
        { subject: 'New via git-sync', body: 'Only in git-sync, not relayed' },
      );
      newEnvelope.message.id = newMsgId;
      newEnvelope.transport.signature = 'valid-sig-placeholder';
      newEnvelope.transport.signedBy = 'remote-machine';
      fs.writeFileSync(
        path.join(gitSyncDir, `${newMsgId}.json`),
        JSON.stringify(newEnvelope),
      );

      // 4. Run git-sync pickup
      const result = await pickupGitSyncMessages({
        localMachineId: 'remote-machine',
        stateDir: agentB.stateDir,
        store: agentB.store,
        verifySignature: () => ({ valid: true }), // Trust all sigs in test
      });

      // The relayed one should be deduped, the new one ingested
      expect(result.duplicates).toBeGreaterThanOrEqual(1);
      expect(result.ingested).toBe(1);

      // 5. Verify new message is accessible via API
      const newRes = await request(agentB.app)
        .get(`/messages/${newMsgId}`)
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .expect(200);
      expect(newRes.body.delivery.phase).toBe('received');
    });

    it('rejects expired git-sync messages', async () => {
      const { pickupGitSyncMessages } = await import('../../src/messaging/GitSyncTransport.js');

      const gitSyncDir = path.join(agentB.stateDir, 'messages', 'outbound', 'expired-machine');
      fs.mkdirSync(gitSyncDir, { recursive: true });

      const expiredId = crypto.randomUUID();
      const envelope = makeEnvelope(
        { agent: 'remote', machine: 'expired-machine' },
        { agent: agentB.name },
        { subject: 'Stale git-sync message' },
      );
      envelope.message.id = expiredId;
      envelope.message.ttlMinutes = 1; // 1 minute TTL
      // Backdate to 10 minutes ago
      const oldTime = new Date(Date.now() - 10 * 60_000).toISOString();
      envelope.message.createdAt = oldTime;
      envelope.transport.timestamp = oldTime;
      envelope.delivery.transitions = [{ from: 'created', to: 'sent', at: oldTime }];
      envelope.transport.signature = 'sig';
      envelope.transport.signedBy = 'expired-machine';

      fs.writeFileSync(
        path.join(gitSyncDir, `${expiredId}.json`),
        JSON.stringify(envelope),
      );

      const result = await pickupGitSyncMessages({
        localMachineId: 'expired-machine',
        stateDir: agentB.stateDir,
        store: agentB.store,
        verifySignature: () => ({ valid: true }),
      });

      expect(result.rejected).toBe(1);
      expect(result.rejections[0].reason).toContain('TTL expired');
    });
  });

  // ── Spawn Storm (Cooldown Prevents Resource Exhaustion) ──────

  describe('spawn storm protection', () => {
    it('rapid fire spawn requests from same agent are throttled after first', async () => {
      const uniqueAgent = `storm-agent-${Date.now()}`;
      const results: Array<{ status: number; approved: boolean }> = [];

      // Fire 5 rapid requests
      for (let i = 0; i < 5; i++) {
        const res = await request(agentA.app)
          .post('/messages/spawn-request')
          .set('Authorization', `Bearer ${agentA.authToken}`)
          .send({
            requester: { agent: uniqueAgent, session: `s${i}`, machine: 'm' },
            target: { agent: agentA.name, machine: 'test-machine' },
            reason: `Spawn storm test ${i}`,
            priority: 'medium',
          });
        results.push({ status: res.status, approved: res.body.approved });
      }

      // First should be approved, rest should be throttled
      expect(results[0].approved).toBe(true);
      expect(results[0].status).toBe(201);
      for (let i = 1; i < 5; i++) {
        expect(results[i].approved).toBe(false);
        expect(results[i].status).toBe(429);
      }
    });

    it('different agents can spawn concurrently without blocking each other', async () => {
      const results = await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          request(agentB.app)
            .post('/messages/spawn-request')
            .set('Authorization', `Bearer ${agentB.authToken}`)
            .send({
              requester: { agent: `independent-${i}-${Date.now()}`, session: 's', machine: 'm' },
              target: { agent: agentB.name, machine: 'test-machine' },
              reason: `Independent spawn ${i}`,
              priority: 'medium',
            }),
        ),
      );

      // All should be approved (different agents, no cooldown interference)
      for (const res of results) {
        expect(res.status).toBe(201);
        expect(res.body.approved).toBe(true);
      }
    });
  });

  // ── Concurrent Message Delivery ──────────────────────────────

  describe('concurrent message delivery', () => {
    it('handles 10 simultaneous sends from A to B without data loss', async () => {
      const messageIds: string[] = [];

      // Fire 10 concurrent sends
      const sends = Array.from({ length: 10 }, (_, i) =>
        request(agentA.app)
          .post('/messages/send')
          .set('Authorization', `Bearer ${agentA.authToken}`)
          .send({
            from: { agent: agentA.name, session: 'concurrent-a', machine: 'test-machine' },
            to: { agent: agentB.name, session: 'concurrent-b', machine: 'test-machine' },
            type: 'info',
            priority: 'medium',
            subject: `Concurrent msg ${i}`,
            body: `Message ${i} of 10 concurrent sends`,
          }),
      );

      const results = await Promise.all(sends);

      // All should succeed
      for (const res of results) {
        expect(res.status).toBe(201);
        expect(res.body.messageId).toBeDefined();
        messageIds.push(res.body.messageId);
      }

      // All 10 should be in B's store
      for (const msgId of messageIds) {
        const res = await request(agentB.app)
          .get(`/messages/${msgId}`)
          .set('Authorization', `Bearer ${agentB.authToken}`)
          .expect(200);
        expect(res.body.message.id).toBe(msgId);
      }
    });

    it('handles bidirectional concurrent sends (A→B and B→A simultaneously)', async () => {
      const aToBIds: string[] = [];
      const bToAIds: string[] = [];

      // Fire concurrent sends in both directions
      const sends = [
        ...Array.from({ length: 5 }, (_, i) =>
          request(agentA.app)
            .post('/messages/send')
            .set('Authorization', `Bearer ${agentA.authToken}`)
            .send({
              from: { agent: agentA.name, session: 'bidir-a', machine: 'test-machine' },
              to: { agent: agentB.name, session: 'bidir-b', machine: 'test-machine' },
              type: 'info',
              priority: 'medium',
              subject: `A→B concurrent ${i}`,
              body: `Bidirectional test A→B ${i}`,
            })
            .then(res => ({ dir: 'atob', res })),
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          request(agentB.app)
            .post('/messages/send')
            .set('Authorization', `Bearer ${agentB.authToken}`)
            .send({
              from: { agent: agentB.name, session: 'bidir-b', machine: 'test-machine' },
              to: { agent: agentA.name, session: 'bidir-a', machine: 'test-machine' },
              type: 'info',
              priority: 'medium',
              subject: `B→A concurrent ${i}`,
              body: `Bidirectional test B→A ${i}`,
            })
            .then(res => ({ dir: 'btoa', res })),
        ),
      ];

      const results = await Promise.all(sends);

      for (const { dir, res } of results) {
        expect(res.status).toBe(201);
        if (dir === 'atob') aToBIds.push(res.body.messageId);
        else bToAIds.push(res.body.messageId);
      }

      expect(aToBIds).toHaveLength(5);
      expect(bToAIds).toHaveLength(5);

      // Verify A→B messages are in B's store
      for (const id of aToBIds) {
        await request(agentB.app)
          .get(`/messages/${id}`)
          .set('Authorization', `Bearer ${agentB.authToken}`)
          .expect(200);
      }

      // Verify B→A messages are in A's store
      for (const id of bToAIds) {
        await request(agentA.app)
          .get(`/messages/${id}`)
          .set('Authorization', `Bearer ${agentA.authToken}`)
          .expect(200);
      }
    });
  });

  // ── Stats Comprehensive Validation ───────────────────────────

  describe('comprehensive stats validation', () => {
    it('stats reflect all message types and volumes accurately', async () => {
      // Send diverse message types
      const types = ['info', 'query', 'request', 'alert', 'sync'];
      for (const type of types) {
        await request(agentA.app)
          .post('/messages/send')
          .set('Authorization', `Bearer ${agentA.authToken}`)
          .send({
            from: { agent: agentA.name, session: 'stats-a', machine: 'test-machine' },
            to: { agent: agentB.name, session: 'stats-b', machine: 'test-machine' },
            type,
            priority: 'medium',
            subject: `Stats test: ${type}`,
            body: `Testing ${type} stats tracking`,
          })
          .expect(201);
      }

      // Check A's stats (sender side)
      const statsA = await request(agentA.app)
        .get('/messages/stats')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(200);

      expect(statsA.body.volume).toBeDefined();
      expect(statsA.body.volume.sent).toBeDefined();
      expect(statsA.body.volume.sent.total).toBeGreaterThanOrEqual(5);

      // Check B's stats (receiver side)
      const statsB = await request(agentB.app)
        .get('/messages/stats')
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .expect(200);

      expect(statsB.body.volume).toBeDefined();
      expect(statsB.body.volume.received).toBeDefined();
      expect(statsB.body.volume.received.total).toBeGreaterThanOrEqual(5);

      // Verify time-windowed stats exist
      expect(typeof statsB.body.volume.received.last5min).toBe('number');
      expect(typeof statsB.body.volume.received.last1hr).toBe('number');
    });

    it('stats track threads correctly', async () => {
      const statsRes = await request(agentA.app)
        .get('/messages/stats')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(200);

      expect(statsRes.body.threads).toBeDefined();
      expect(typeof statsRes.body.threads.active).toBe('number');
      expect(typeof statsRes.body.threads.resolved).toBe('number');
      expect(typeof statsRes.body.threads.stale).toBe('number');
    });
  });

  // ── Dead Letter Lifecycle ────────────────────────────────────

  describe('dead letter lifecycle', () => {
    it('dead-lettered messages appear in dead-letter queue with full history', async () => {
      // Create a message that will be dead-lettered
      const msgId = crypto.randomUUID();
      const envelope = {
        schemaVersion: 1,
        message: {
          id: msgId,
          from: { agent: agentA.name, session: 's', machine: 'test-machine' },
          to: { agent: agentB.name, session: 's', machine: 'local' },
          type: 'info' as const,
          priority: 'low' as const,
          subject: 'Dead letter test',
          body: 'This will be dead-lettered',
          createdAt: new Date(Date.now() - 3600_000).toISOString(), // 1 hour ago
          ttlMinutes: 1, // Already expired
        },
        transport: {
          relayChain: [],
          originServer: 'http://localhost:0',
          nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
          timestamp: new Date().toISOString(),
        },
        delivery: {
          phase: 'queued' as const,
          transitions: [
            { from: 'created', to: 'sent', at: new Date(Date.now() - 3600_000).toISOString() },
            { from: 'sent', to: 'queued', at: new Date(Date.now() - 3500_000).toISOString() },
          ],
          attempts: 5,
        },
      };
      await agentB.store.save(envelope as any);

      // Tick retry manager to expire it
      const { DeliveryRetryManager } = await import('../../src/messaging/DeliveryRetryManager.js');
      const formatter = new MessageFormatter();
      const delivery = new MessageDelivery(formatter, mockTmux);
      const retryMgr = new DeliveryRetryManager(agentB.store, delivery, { agentName: agentB.name });
      await retryMgr.tick();
      retryMgr.stop();

      // Verify it's in dead-letter queue
      const dlRes = await request(agentB.app)
        .get('/messages/dead-letter')
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .expect(200);

      const found = dlRes.body.messages.find((m: any) => m.message.id === msgId);
      expect(found).toBeDefined();
      expect(found.delivery.phase).toBe('dead-lettered');
      expect(found.delivery.transitions.length).toBeGreaterThanOrEqual(3); // created→sent→queued→dead-lettered

      // Verify stats reflect the dead letter
      const statsRes = await request(agentB.app)
        .get('/messages/stats')
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .expect(200);
      expect(statsRes.body.volume.deadLettered.total).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Message Persistence and Recovery ─────────────────────────

  describe('message persistence across store re-init', () => {
    it('messages, threads, and dead-letters all survive store re-initialization', async () => {
      // Send a fresh message
      const sendRes = await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          from: { agent: agentA.name, session: 'persist-a', machine: 'test-machine' },
          to: { agent: agentB.name, session: 'persist-b', machine: 'test-machine' },
          type: 'query',
          priority: 'medium',
          subject: 'Persistence test query',
          body: 'Will this survive re-init?',
        })
        .expect(201);
      const msgId = sendRes.body.messageId;
      const threadId = sendRes.body.threadId;

      // Record current stats
      const statsBefore = await request(agentB.app)
        .get('/messages/stats')
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .expect(200);
      const receivedBefore = statsBefore.body.volume.received.total;

      // Re-initialize B's store (simulates server restart)
      await agentB.store.destroy();
      const messagingDir = path.join(agentB.stateDir, 'messages');
      const newStore = new MessageStore(messagingDir);
      await newStore.initialize();

      // Verify message still exists
      const envelope = await newStore.get(msgId);
      expect(envelope).toBeDefined();
      expect(envelope!.message.subject).toBe('Persistence test query');

      // Verify thread still exists
      const thread = await newStore.getThread(threadId);
      expect(thread).toBeDefined();

      // Verify stats rebuilt correctly
      const stats = await newStore.getStats();
      expect(stats.volume.received.total).toBeGreaterThanOrEqual(receivedBefore);

      // Replace store reference for cleanup
      (agentB as any).store = newStore;
      await newStore.destroy();
      const finalStore = new MessageStore(messagingDir);
      await finalStore.initialize();
      (agentB as any).store = finalStore;
    });
  });

  // ── Priority-Based Behavior ──────────────────────────────────

  describe('priority-based behavior', () => {
    it('all priority levels are accepted and tracked in stats', async () => {
      const priorities = ['low', 'normal', 'medium', 'high', 'critical'];
      const ids: string[] = [];

      for (const priority of priorities) {
        const res = await request(agentA.app)
          .post('/messages/send')
          .set('Authorization', `Bearer ${agentA.authToken}`)
          .send({
            from: { agent: agentA.name, session: 'prio-a', machine: 'test-machine' },
            to: { agent: agentB.name, session: 'prio-b', machine: 'test-machine' },
            type: 'info',
            priority,
            subject: `Priority ${priority} message`,
            body: `Testing ${priority} priority`,
          })
          .expect(201);
        ids.push(res.body.messageId);
      }

      // Verify all arrived at B
      for (const id of ids) {
        await request(agentB.app)
          .get(`/messages/${id}`)
          .set('Authorization', `Bearer ${agentB.authToken}`)
          .expect(200);
      }

      // Verify stats volume reflects the priority messages
      const statsB = await request(agentB.app)
        .get('/messages/stats')
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .expect(200);
      expect(statsB.body.volume.received.total).toBeGreaterThanOrEqual(5);
    });
  });

  // ── Edge Cases and Error Boundaries ──────────────────────────

  describe('edge cases and error boundaries', () => {
    it('handles very large message body', async () => {
      const largeBody = 'X'.repeat(50_000); // 50KB body
      const res = await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          from: { agent: agentA.name, session: 'large-a', machine: 'test-machine' },
          to: { agent: agentB.name, session: 'large-b', machine: 'test-machine' },
          type: 'info',
          priority: 'low',
          subject: 'Large payload test',
          body: largeBody,
        })
        .expect(201);

      // Verify full body preserved at B
      const getRes = await request(agentB.app)
        .get(`/messages/${res.body.messageId}`)
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .expect(200);
      expect(getRes.body.message.body.length).toBe(50_000);
    });

    it('handles special characters in subject and body', async () => {
      const res = await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          from: { agent: agentA.name, session: 'special-a', machine: 'test-machine' },
          to: { agent: agentB.name, session: 'special-b', machine: 'test-machine' },
          type: 'info',
          priority: 'medium',
          subject: 'Test: "quotes" & <angles> & unicode: 日本語 🎯',
          body: 'Line1\nLine2\tTabbed\n\n{"json": "embedded"}\n```code block```',
        })
        .expect(201);

      const getRes = await request(agentB.app)
        .get(`/messages/${res.body.messageId}`)
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .expect(200);
      expect(getRes.body.message.subject).toContain('日本語');
      expect(getRes.body.message.body).toContain('{"json": "embedded"}');
    });

    it('rejects message with invalid UUID format for message ID', async () => {
      await request(agentA.app)
        .get('/messages/not-a-valid-uuid')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(400);
    });

    it('inbox/outbox filters work correctly', async () => {
      // Send a query and an info
      await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          from: { agent: agentA.name, session: 'filter-a', machine: 'test-machine' },
          to: { agent: agentB.name, session: 'filter-b', machine: 'test-machine' },
          type: 'alert',
          priority: 'high',
          subject: 'Alert for filter test',
          body: 'Filter test alert',
        })
        .expect(201);

      // Filter B's inbox by type=alert
      const alertRes = await request(agentB.app)
        .get('/messages/inbox')
        .query({ type: 'alert' })
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .expect(200);

      // All returned messages should be alerts
      for (const msg of alertRes.body.messages) {
        expect(msg.message.type).toBe('alert');
      }
    });

    it('ack with non-existent message ID returns appropriate response', async () => {
      const nonExistentId = crypto.randomUUID();
      const res = await request(agentB.app)
        .post('/messages/ack')
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .send({
          sessionId: 'session-b',
          messageId: nonExistentId,
        });
      // Should either 404 or handle gracefully (not 500)
      expect(res.status).toBeLessThan(500);
    });

    it('multiple ACKs for same message are idempotent', async () => {
      // Send a message
      const sendRes = await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          from: { agent: agentA.name, session: 'ack-a', machine: 'test-machine' },
          to: { agent: agentB.name, session: 'ack-b', machine: 'test-machine' },
          type: 'info',
          priority: 'medium',
          subject: 'Idempotent ACK test',
          body: 'Double-ack me',
        })
        .expect(201);
      const msgId = sendRes.body.messageId;

      // ACK twice
      await request(agentB.app)
        .post('/messages/ack')
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .send({ sessionId: 'ack-b', messageId: msgId })
        .expect(200);

      const secondAck = await request(agentB.app)
        .post('/messages/ack')
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .send({ sessionId: 'ack-b', messageId: msgId });
      // Second ACK should not cause error
      expect(secondAck.status).toBeLessThan(500);
    });
  });

  // ── Thread Lifecycle Deep ────────────────────────────────────

  describe('thread lifecycle deep', () => {
    it('threads listing shows all active threads', async () => {
      const res = await request(agentA.app)
        .get('/messages/threads')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(200);

      expect(res.body.threads).toBeDefined();
      expect(Array.isArray(res.body.threads)).toBe(true);
    });

    it('thread detail includes full message history', async () => {
      // Create a thread with a query
      const sendRes = await request(agentA.app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .send({
          from: { agent: agentA.name, session: 'td-a', machine: 'test-machine' },
          to: { agent: agentB.name, session: 'td-b', machine: 'test-machine' },
          type: 'query',
          priority: 'medium',
          subject: 'Thread detail test',
          body: 'Testing thread detail retrieval',
        })
        .expect(201);

      const threadId = sendRes.body.threadId;

      const threadRes = await request(agentA.app)
        .get(`/messages/thread/${threadId}`)
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(200);

      expect(threadRes.body.thread.id).toBe(threadId);
      expect(threadRes.body.thread.messageIds.length).toBeGreaterThanOrEqual(1);
      expect(threadRes.body.thread.status).toBeDefined();
      expect(threadRes.body.thread.subject).toBe('Thread detail test');
    });

    it('thread 404 for non-existent thread ID', async () => {
      await request(agentA.app)
        .get(`/messages/thread/${crypto.randomUUID()}`)
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(404);
    });
  });

  // ── Summary Sentinel Lifecycle ───────────────────────────────

  describe('session summary sentinel lifecycle', () => {
    it('summaries endpoint returns sentinel status on both agents', async () => {
      const resA = await request(agentA.app)
        .get('/messages/summaries')
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(200);

      expect(resA.body.status).toBeDefined();
      expect(resA.body.summaries).toBeDefined();
      expect(typeof resA.body.status.summaryCount).toBe('number');
      expect(typeof resA.body.status.staleCount).toBe('number');
      expect(typeof resA.body.status.inFallback).toBe('boolean');

      const resB = await request(agentB.app)
        .get('/messages/summaries')
        .set('Authorization', `Bearer ${agentB.authToken}`)
        .expect(200);
      expect(resB.body.status).toBeDefined();
    });

    it('route-score returns valid scores for subject/body query', async () => {
      const res = await request(agentA.app)
        .get('/messages/route-score')
        .query({ subject: 'Database migration', body: 'Schema changes for v2' })
        .set('Authorization', `Bearer ${agentA.authToken}`)
        .expect(200);

      expect(res.body).toHaveProperty('scores');
      expect(res.body).toHaveProperty('inFallback');
      expect(Array.isArray(res.body.scores)).toBe(true);
    });
  });
});
