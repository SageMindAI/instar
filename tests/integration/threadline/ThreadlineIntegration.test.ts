/**
 * Threadline Integration Tests
 *
 * Exercises multiple Threadline modules working together. Each test involves
 * 2+ modules interacting to validate cross-module behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { ThreadResumeMap } from '../../../src/threadline/ThreadResumeMap.js';
import type { ThreadResumeEntry } from '../../../src/threadline/ThreadResumeMap.js';
import { ThreadlineRouter } from '../../../src/threadline/ThreadlineRouter.js';
import type { ThreadlineRouterConfig } from '../../../src/threadline/ThreadlineRouter.js';
import { AutonomyGate } from '../../../src/threadline/AutonomyGate.js';
import type { ThreadlineNotifier } from '../../../src/threadline/AutonomyGate.js';
import { ApprovalQueue } from '../../../src/threadline/ApprovalQueue.js';
import { DigestCollector } from '../../../src/threadline/DigestCollector.js';
import { HandshakeManager } from '../../../src/threadline/HandshakeManager.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import type { AgentTrustLevel, TrustChangeNotification } from '../../../src/threadline/AgentTrustManager.js';
import { CircuitBreaker } from '../../../src/threadline/CircuitBreaker.js';
import { RateLimiter } from '../../../src/threadline/RateLimiter.js';
import { AgentDiscovery } from '../../../src/threadline/AgentDiscovery.js';
import type { HttpFetcher, ThreadlineAgentInfo } from '../../../src/threadline/AgentDiscovery.js';
import type { MessageEnvelope } from '../../../src/messaging/types.js';

// ── Helpers ─────────────────────────────────────────────────────────

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-integration-'));
}

/** Build a valid MessageEnvelope for testing */
function makeEnvelope(overrides: {
  fromAgent?: string;
  toAgent?: string;
  threadId?: string;
  subject?: string;
  body?: string;
  type?: string;
  priority?: string;
  ttlMinutes?: number;
  id?: string;
} = {}): MessageEnvelope {
  return {
    schemaVersion: 1,
    message: {
      id: overrides.id ?? crypto.randomUUID(),
      from: {
        agent: overrides.fromAgent ?? 'remote-agent',
        session: 'test-session',
        machine: 'test-machine',
      },
      to: {
        agent: overrides.toAgent ?? 'local-agent',
        session: 'best',
        machine: 'local',
      },
      type: (overrides.type ?? 'request') as any,
      priority: (overrides.priority ?? 'medium') as any,
      subject: overrides.subject ?? 'Test subject',
      body: overrides.body ?? 'Test message body',
      threadId: overrides.threadId,
      createdAt: new Date().toISOString(),
      ttlMinutes: overrides.ttlMinutes ?? 60,
      tags: [],
    },
    transport: {
      protocol: 'local-bus',
      hops: [],
      origin: { agent: overrides.fromAgent ?? 'remote-agent', machine: 'test-machine' },
    } as any,
    delivery: {
      status: 'pending',
      attempts: 0,
    } as any,
  };
}

/** Create a mock AutonomyProfileManager */
function makeAutonomyManager(level: string = 'autonomous') {
  return {
    getProfile: vi.fn().mockReturnValue(level),
  } as any;
}

/** Create a mock MessageRouter */
function makeMockMessageRouter() {
  return {
    getThread: vi.fn().mockResolvedValue(null),
    send: vi.fn(),
    receive: vi.fn(),
    resolveThread: vi.fn(),
  } as any;
}

/** Create a mock SpawnRequestManager */
function makeMockSpawnManager(approved = true) {
  return {
    evaluate: vi.fn().mockResolvedValue({
      approved,
      sessionId: crypto.randomUUID(),
      tmuxSession: 'test-tmux-session',
      reason: approved ? undefined : 'Test denial',
    }),
    handleDenial: vi.fn(),
  } as any;
}

/** Create a mock MessageStore */
function makeMockMessageStore() {
  return {
    store: vi.fn(),
    getThread: vi.fn().mockResolvedValue(null),
    getMessage: vi.fn().mockResolvedValue(null),
    listMessages: vi.fn().mockResolvedValue([]),
  } as any;
}

/** Create a mock notifier */
function makeMockNotifier(): ThreadlineNotifier {
  return {
    notifyUser: vi.fn().mockResolvedValue(undefined),
    requestApproval: vi.fn().mockResolvedValue(undefined),
    sendDigest: vi.fn().mockResolvedValue(undefined),
  };
}

/** Create a mock HTTP fetcher for AgentDiscovery */
function makeMockFetcher(responses: Record<string, any> = {}): HttpFetcher {
  return vi.fn(async (url: string) => {
    const resp = responses[url];
    if (resp) {
      return {
        ok: true,
        status: 200,
        json: async () => resp,
      };
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({}),
    };
  }) as any;
}

// ── Test Suite ──────────────────────────────────────────────────────

describe('Threadline Integration Tests', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ================================================================
  // Category 1: Full Handshake -> Trust -> Communication Flow
  // ================================================================
  describe('Full Handshake -> Trust -> Communication Flow', () => {
    it('two HandshakeManagers complete a full handshake and derive matching relay tokens', () => {
      const dirA = path.join(tmpDir, 'agent-a');
      const dirB = path.join(tmpDir, 'agent-b');
      fs.mkdirSync(dirA, { recursive: true });
      fs.mkdirSync(dirB, { recursive: true });

      const managerA = new HandshakeManager(dirA, 'agent-a');
      const managerB = new HandshakeManager(dirB, 'agent-b');

      // Step 1: A initiates handshake
      const helloResult = managerA.initiateHandshake('agent-b');
      expect('payload' in helloResult).toBe(true);
      const helloPayload = (helloResult as any).payload;
      expect(helloPayload.agent).toBe('agent-a');

      // Step 2: B receives hello, responds with hello (includes challenge response)
      const helloResponseResult = managerB.handleHello(helloPayload);
      expect('payload' in helloResponseResult).toBe(true);
      const helloResponse = (helloResponseResult as any).payload;
      expect(helloResponse.agent).toBe('agent-b');
      expect(helloResponse.challengeResponse).toBeDefined();

      // Step 3: A processes B's hello response, gets confirm payload + relay token
      const confirmResult = managerA.handleHelloResponse(helloResponse);
      expect('confirmPayload' in confirmResult).toBe(true);
      const { confirmPayload, relayToken: tokenA } = confirmResult as any;

      // Step 4: B processes A's confirm, gets relay token
      const finalResult = managerB.handleConfirm(confirmPayload);
      expect('relayToken' in finalResult).toBe(true);
      const tokenB = (finalResult as any).relayToken;

      // Both tokens should match
      expect(tokenA).toBe(tokenB);
      expect(tokenA.length).toBeGreaterThan(0);
    });

    it('after handshake, AgentTrustManager tracks the relationship and CircuitBreaker starts closed', () => {
      const dirA = path.join(tmpDir, 'agent-a');
      const dirB = path.join(tmpDir, 'agent-b');
      fs.mkdirSync(dirA, { recursive: true });
      fs.mkdirSync(dirB, { recursive: true });

      const managerA = new HandshakeManager(dirA, 'agent-a');
      const managerB = new HandshakeManager(dirB, 'agent-b');

      // Complete handshake
      const hello = (managerA.initiateHandshake('agent-b') as any).payload;
      const response = (managerB.handleHello(hello) as any).payload;
      const { confirmPayload, relayToken: tokenA } = managerA.handleHelloResponse(response) as any;
      managerB.handleConfirm(confirmPayload);

      // Now set up trust and circuit breaker
      const trustManager = new AgentTrustManager({ stateDir: dirA });
      const circuitBreaker = new CircuitBreaker({ stateDir: dirA, trustManager });

      // Set trust to verified after successful handshake
      trustManager.setTrustLevel('agent-b', 'verified', 'user-granted', 'Handshake completed');
      const profile = trustManager.getProfile('agent-b');
      expect(profile).not.toBeNull();
      expect(profile!.level).toBe('verified');

      // Circuit should be closed (no failures)
      expect(circuitBreaker.isOpen('agent-b')).toBe(false);

      // Record successful interaction
      trustManager.recordInteraction('agent-b', true, 'First message exchange');
      circuitBreaker.recordSuccess('agent-b');

      const stats = trustManager.getInteractionStats('agent-b');
      expect(stats!.successfulInteractions).toBe(1);
      expect(stats!.successRate).toBe(1);
    });

    it('relay tokens are persisted and can be validated across HandshakeManager instances', () => {
      const dirA = path.join(tmpDir, 'agent-a');
      const dirB = path.join(tmpDir, 'agent-b');
      fs.mkdirSync(dirA, { recursive: true });
      fs.mkdirSync(dirB, { recursive: true });

      const managerA = new HandshakeManager(dirA, 'agent-a');
      const managerB = new HandshakeManager(dirB, 'agent-b');

      // Complete handshake
      const hello = (managerA.initiateHandshake('agent-b') as any).payload;
      const response = (managerB.handleHello(hello) as any).payload;
      const { confirmPayload, relayToken } = managerA.handleHelloResponse(response) as any;
      managerB.handleConfirm(confirmPayload);

      // Validate relay token
      expect(managerA.validateRelayToken('agent-b', relayToken)).toBe(true);
      expect(managerA.validateRelayToken('agent-b', 'bad-token')).toBe(false);

      // Reload from disk - new instance should have the token
      const managerA2 = new HandshakeManager(dirA, 'agent-a');
      expect(managerA2.getRelayToken('agent-b')).toBe(relayToken);
      expect(managerA2.validateRelayToken('agent-b', relayToken)).toBe(true);
    });

    it('handshake rate limiter kicks in after 5 rapid attempts', () => {
      const dirA = path.join(tmpDir, 'agent-a');
      fs.mkdirSync(dirA, { recursive: true });
      const managerA = new HandshakeManager(dirA, 'agent-a');

      // 5 rapid initiations should succeed
      for (let i = 0; i < 5; i++) {
        const result = managerA.initiateHandshake('agent-b');
        expect('payload' in result).toBe(true);
      }

      // 6th should be rate limited
      const result = managerA.initiateHandshake('agent-b');
      expect('error' in result).toBe(true);
      expect((result as any).error).toContain('Rate limited');
    });

    it('glare resolution: both agents initiate simultaneously, lower pubkey wins', () => {
      const dirA = path.join(tmpDir, 'agent-a');
      const dirB = path.join(tmpDir, 'agent-b');
      fs.mkdirSync(dirA, { recursive: true });
      fs.mkdirSync(dirB, { recursive: true });

      const managerA = new HandshakeManager(dirA, 'agent-a');
      const managerB = new HandshakeManager(dirB, 'agent-b');

      // Both initiate simultaneously
      const helloFromA = (managerA.initiateHandshake('agent-b') as any).payload;
      const helloFromB = (managerB.initiateHandshake('agent-a') as any).payload;

      // Determine who has lower pubkey
      const pubA = helloFromA.identityPub;
      const pubB = helloFromB.identityPub;

      if (pubA < pubB) {
        // A wins - B should process A's hello, A should reject B's
        const bProcessesA = managerB.handleHello(helloFromA);
        expect('payload' in bProcessesA).toBe(true);

        const aProcessesB = managerA.handleHello(helloFromB);
        expect('error' in aProcessesB).toBe(true);
        expect((aProcessesB as any).error).toContain('glare');
      } else {
        // B wins - A should process B's hello, B should reject A's
        const aProcessesB = managerA.handleHello(helloFromB);
        expect('payload' in aProcessesB).toBe(true);

        const bProcessesA = managerB.handleHello(helloFromA);
        expect('error' in bProcessesA).toBe(true);
        expect((bProcessesA as any).error).toContain('glare');
      }
    });

    it('failed handshake records failure in trust manager via circuit breaker', () => {
      const dirA = path.join(tmpDir, 'agent-a');
      fs.mkdirSync(dirA, { recursive: true });

      const trustManager = new AgentTrustManager({ stateDir: dirA });
      trustManager.setTrustLevel('agent-b', 'verified', 'user-granted');
      const circuitBreaker = new CircuitBreaker({ stateDir: dirA, trustManager });

      const managerA = new HandshakeManager(dirA, 'agent-a');
      managerA.initiateHandshake('agent-b');

      // Simulate invalid confirm
      const confirmResult = managerA.handleConfirm({
        agent: 'agent-b',
        challengeResponse: crypto.randomBytes(64).toString('hex'),
      });
      expect('error' in confirmResult).toBe(true);

      // Record failure in circuit breaker
      circuitBreaker.recordFailure('agent-b');
      trustManager.recordInteraction('agent-b', false, 'Handshake failed');

      const stats = trustManager.getInteractionStats('agent-b');
      expect(stats!.failedInteractions).toBe(1);
      expect(stats!.streakSinceIncident).toBe(0);
    });

    it('successful handshake + trust upgrade enables message permission', () => {
      const dirA = path.join(tmpDir, 'agent-a');
      const dirB = path.join(tmpDir, 'agent-b');
      fs.mkdirSync(dirA, { recursive: true });
      fs.mkdirSync(dirB, { recursive: true });

      const managerA = new HandshakeManager(dirA, 'agent-a');
      const managerB = new HandshakeManager(dirB, 'agent-b');

      // Complete handshake
      const hello = (managerA.initiateHandshake('agent-b') as any).payload;
      const response = (managerB.handleHello(hello) as any).payload;
      const { confirmPayload } = managerA.handleHelloResponse(response) as any;
      managerB.handleConfirm(confirmPayload);

      const trustManager = new AgentTrustManager({ stateDir: dirA });

      // Initially untrusted - no message permission
      expect(trustManager.checkPermission('agent-b', 'message')).toBe(false);
      expect(trustManager.checkPermission('agent-b', 'ping')).toBe(true);

      // After user grants verified status
      trustManager.setTrustLevel('agent-b', 'verified', 'user-granted', 'Completed handshake');
      expect(trustManager.checkPermission('agent-b', 'message')).toBe(true);
      expect(trustManager.checkPermission('agent-b', 'task-request')).toBe(false);

      // After further upgrade to trusted
      trustManager.setTrustLevel('agent-b', 'trusted', 'user-granted');
      expect(trustManager.checkPermission('agent-b', 'task-request')).toBe(true);
    });

    it('rate limiter enforces limits during message exchange post-handshake', () => {
      const dirA = path.join(tmpDir, 'agent-a');
      fs.mkdirSync(dirA, { recursive: true });

      let currentTime = Date.now();
      const rateLimiter = new RateLimiter({
        stateDir: dirA,
        config: {
          perAgentBurst: { limit: 3, windowMs: 60_000 },
          perAgentInbound: { limit: 10, windowMs: 3600_000 },
        },
        nowFn: () => currentTime,
      });

      // Simulate message exchange with rate limiting
      for (let i = 0; i < 3; i++) {
        const result = rateLimiter.recordEvent('perAgentBurst', 'agent-b');
        expect(result.allowed).toBe(true);
      }

      // 4th burst message should be limited
      const limited = rateLimiter.checkLimit('perAgentBurst', 'agent-b');
      expect(limited.allowed).toBe(false);
      expect(limited.remaining).toBe(0);

      // After burst window passes, should be allowed again
      currentTime += 61_000;
      const afterWindow = rateLimiter.checkLimit('perAgentBurst', 'agent-b');
      expect(afterWindow.allowed).toBe(true);
    });

    it('handshake identity keys are persisted and reused across instances', () => {
      const dirA = path.join(tmpDir, 'agent-a');
      fs.mkdirSync(dirA, { recursive: true });

      const manager1 = new HandshakeManager(dirA, 'agent-a');
      const pubKey1 = manager1.getIdentityPublicKey();

      const manager2 = new HandshakeManager(dirA, 'agent-a');
      const pubKey2 = manager2.getIdentityPublicKey();

      expect(pubKey1).toBe(pubKey2);
    });

    it('re-handshake generates new relay token (different from old)', () => {
      const dirA = path.join(tmpDir, 'agent-a');
      const dirB = path.join(tmpDir, 'agent-b');
      fs.mkdirSync(dirA, { recursive: true });
      fs.mkdirSync(dirB, { recursive: true });

      // First handshake
      let managerA = new HandshakeManager(dirA, 'agent-a');
      let managerB = new HandshakeManager(dirB, 'agent-b');

      let hello = (managerA.initiateHandshake('agent-b') as any).payload;
      let response = (managerB.handleHello(hello) as any).payload;
      let { confirmPayload, relayToken: token1 } = managerA.handleHelloResponse(response) as any;
      managerB.handleConfirm(confirmPayload);

      // Second handshake (new ephemeral keys)
      managerA = new HandshakeManager(dirA, 'agent-a');
      managerB = new HandshakeManager(dirB, 'agent-b');

      hello = (managerA.initiateHandshake('agent-b') as any).payload;
      response = (managerB.handleHello(hello) as any).payload;
      const result2 = managerA.handleHelloResponse(response) as any;
      confirmPayload = result2.confirmPayload;
      const token2 = result2.relayToken;
      managerB.handleConfirm(confirmPayload);

      // Tokens should differ (different ephemeral keys)
      expect(token1).not.toBe(token2);

      // New token should be valid, old should not
      expect(managerA.validateRelayToken('agent-b', token2)).toBe(true);
    });

    it('listPairedAgents returns agents after successful handshake', () => {
      const dirA = path.join(tmpDir, 'agent-a');
      const dirB = path.join(tmpDir, 'agent-b');
      fs.mkdirSync(dirA, { recursive: true });
      fs.mkdirSync(dirB, { recursive: true });

      const managerA = new HandshakeManager(dirA, 'agent-a');
      const managerB = new HandshakeManager(dirB, 'agent-b');

      expect(managerA.listPairedAgents()).toHaveLength(0);

      const hello = (managerA.initiateHandshake('agent-b') as any).payload;
      const response = (managerB.handleHello(hello) as any).payload;
      const { confirmPayload } = managerA.handleHelloResponse(response) as any;
      managerB.handleConfirm(confirmPayload);

      const paired = managerA.listPairedAgents();
      expect(paired).toHaveLength(1);
      expect(paired[0].agent).toBe('agent-b');
    });
  });

  // ================================================================
  // Category 2: Router + Gate + Trust Integration
  // ================================================================
  describe('Router + Gate + Trust Integration', () => {
    it('autonomous mode: message delivered directly, session spawned', async () => {
      const autonomyManager = makeAutonomyManager('autonomous');
      const approvalQueue = new ApprovalQueue(tmpDir);
      const digestCollector = new DigestCollector(tmpDir);
      const notifier = makeMockNotifier();
      const gate = new AutonomyGate({
        autonomyManager, approvalQueue, digestCollector, notifier, stateDir: tmpDir,
      });

      const threadResumeMap = new ThreadResumeMap(tmpDir, '/test/project');
      const spawnManager = makeMockSpawnManager(true);
      const messageRouter = makeMockMessageRouter();
      const messageStore = makeMockMessageStore();

      const router = new ThreadlineRouter(
        messageRouter, spawnManager, threadResumeMap, messageStore,
        { localAgent: 'local-agent', localMachine: 'local-machine' },
        gate,
      );

      const envelope = makeEnvelope({ threadId: crypto.randomUUID(), fromAgent: 'remote-agent' });
      const result = await router.handleInboundMessage(envelope);

      expect(result.handled).toBe(true);
      expect(result.spawned).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('cautious mode: message queued for approval, not delivered until approved', async () => {
      const autonomyManager = makeAutonomyManager('cautious');
      const approvalQueue = new ApprovalQueue(tmpDir);
      const digestCollector = new DigestCollector(tmpDir);
      const notifier = makeMockNotifier();
      const gate = new AutonomyGate({
        autonomyManager, approvalQueue, digestCollector, notifier, stateDir: tmpDir,
      });

      const threadResumeMap = new ThreadResumeMap(tmpDir, '/test/project');
      const spawnManager = makeMockSpawnManager(true);
      const messageRouter = makeMockMessageRouter();
      const messageStore = makeMockMessageStore();

      const router = new ThreadlineRouter(
        messageRouter, spawnManager, threadResumeMap, messageStore,
        { localAgent: 'local-agent', localMachine: 'local-machine' },
        gate,
      );

      const threadId = crypto.randomUUID();
      const envelope = makeEnvelope({ threadId, fromAgent: 'remote-agent' });
      const result = await router.handleInboundMessage(envelope);

      expect(result.handled).toBe(true);
      expect(result.gateDecision).toBe('queue-for-approval');
      expect(result.approvalId).toBeDefined();
      expect(result.spawned).toBeUndefined();

      // Verify message is in the approval queue
      const pending = approvalQueue.getQueue('pending');
      expect(pending).toHaveLength(1);
      expect(pending[0].fromAgent).toBe('remote-agent');

      // Approve it
      const approved = approvalQueue.approve(result.approvalId!);
      expect(approved).not.toBeNull();
      expect(approved!.status).toBe('approved');
    });

    it('blocked agent: message rejected at gate, never reaches router spawn', async () => {
      const autonomyManager = makeAutonomyManager('autonomous');
      const approvalQueue = new ApprovalQueue(tmpDir);
      const digestCollector = new DigestCollector(tmpDir);
      const gate = new AutonomyGate({
        autonomyManager, approvalQueue, digestCollector, stateDir: tmpDir,
      });

      // Block an agent
      gate.blockAgent('evil-agent', 'Spam behavior');

      const threadResumeMap = new ThreadResumeMap(tmpDir, '/test/project');
      const spawnManager = makeMockSpawnManager(true);
      const messageRouter = makeMockMessageRouter();
      const messageStore = makeMockMessageStore();

      const router = new ThreadlineRouter(
        messageRouter, spawnManager, threadResumeMap, messageStore,
        { localAgent: 'local-agent', localMachine: 'local-machine' },
        gate,
      );

      const envelope = makeEnvelope({ threadId: crypto.randomUUID(), fromAgent: 'evil-agent' });
      const result = await router.handleInboundMessage(envelope);

      expect(result.handled).toBe(true);
      expect(result.gateDecision).toBe('block');
      expect(result.error).toContain('Blocked');
      expect(spawnManager.evaluate).not.toHaveBeenCalled();
    });

    it('supervised mode: message delivered with notification, session spawned', async () => {
      const autonomyManager = makeAutonomyManager('supervised');
      const approvalQueue = new ApprovalQueue(tmpDir);
      const digestCollector = new DigestCollector(tmpDir);
      const notifier = makeMockNotifier();
      const gate = new AutonomyGate({
        autonomyManager, approvalQueue, digestCollector, notifier, stateDir: tmpDir,
      });

      const threadResumeMap = new ThreadResumeMap(tmpDir, '/test/project');
      const spawnManager = makeMockSpawnManager(true);
      const messageRouter = makeMockMessageRouter();
      const messageStore = makeMockMessageStore();

      const router = new ThreadlineRouter(
        messageRouter, spawnManager, threadResumeMap, messageStore,
        { localAgent: 'local-agent', localMachine: 'local-machine' },
        gate,
      );

      const envelope = makeEnvelope({ threadId: crypto.randomUUID(), fromAgent: 'remote-agent' });
      const result = await router.handleInboundMessage(envelope);

      expect(result.handled).toBe(true);
      expect(result.spawned).toBe(true);
      expect(notifier.notifyUser).toHaveBeenCalled();
    });

    it('collaborative mode: message delivered silently with digest collection', async () => {
      const autonomyManager = makeAutonomyManager('collaborative');
      const approvalQueue = new ApprovalQueue(tmpDir);
      const digestCollector = new DigestCollector(tmpDir);
      const notifier = makeMockNotifier();
      const gate = new AutonomyGate({
        autonomyManager, approvalQueue, digestCollector, notifier, stateDir: tmpDir,
      });

      const threadResumeMap = new ThreadResumeMap(tmpDir, '/test/project');
      const spawnManager = makeMockSpawnManager(true);
      const messageRouter = makeMockMessageRouter();
      const messageStore = makeMockMessageStore();

      const router = new ThreadlineRouter(
        messageRouter, spawnManager, threadResumeMap, messageStore,
        { localAgent: 'local-agent', localMachine: 'local-machine' },
        gate,
      );

      const envelope = makeEnvelope({ threadId: crypto.randomUUID(), fromAgent: 'remote-agent' });
      const result = await router.handleInboundMessage(envelope);

      expect(result.handled).toBe(true);
      expect(result.spawned).toBe(true);
      // Should not notify
      expect(notifier.notifyUser).not.toHaveBeenCalled();
      // Should add to digest
      expect(digestCollector.entryCount()).toBe(1);
    });

    it('paused agent: message queued for approval regardless of autonomy level', async () => {
      const autonomyManager = makeAutonomyManager('autonomous');
      const approvalQueue = new ApprovalQueue(tmpDir);
      const digestCollector = new DigestCollector(tmpDir);
      const gate = new AutonomyGate({
        autonomyManager, approvalQueue, digestCollector, stateDir: tmpDir,
      });

      gate.pauseAgent('paused-agent', 'Manual pause');

      const threadResumeMap = new ThreadResumeMap(tmpDir, '/test/project');
      const spawnManager = makeMockSpawnManager(true);
      const messageRouter = makeMockMessageRouter();
      const messageStore = makeMockMessageStore();

      const router = new ThreadlineRouter(
        messageRouter, spawnManager, threadResumeMap, messageStore,
        { localAgent: 'local-agent', localMachine: 'local-machine' },
        gate,
      );

      const envelope = makeEnvelope({ threadId: crypto.randomUUID(), fromAgent: 'paused-agent' });
      const result = await router.handleInboundMessage(envelope);

      expect(result.gateDecision).toBe('queue-for-approval');
      expect(spawnManager.evaluate).not.toHaveBeenCalled();
    });

    it('unblocking an agent allows messages to flow through gate', async () => {
      const autonomyManager = makeAutonomyManager('autonomous');
      const approvalQueue = new ApprovalQueue(tmpDir);
      const digestCollector = new DigestCollector(tmpDir);
      const gate = new AutonomyGate({
        autonomyManager, approvalQueue, digestCollector, stateDir: tmpDir,
      });

      gate.blockAgent('agent-x');

      // Blocked
      const threadResumeMap = new ThreadResumeMap(tmpDir, '/test/project');
      const spawnManager = makeMockSpawnManager(true);
      const messageRouter = makeMockMessageRouter();
      const messageStore = makeMockMessageStore();

      const router = new ThreadlineRouter(
        messageRouter, spawnManager, threadResumeMap, messageStore,
        { localAgent: 'local-agent', localMachine: 'local-machine' },
        gate,
      );

      const envelope1 = makeEnvelope({ threadId: crypto.randomUUID(), fromAgent: 'agent-x' });
      const result1 = await router.handleInboundMessage(envelope1);
      expect(result1.gateDecision).toBe('block');

      // Unblock
      gate.unblockAgent('agent-x');

      const envelope2 = makeEnvelope({ threadId: crypto.randomUUID(), fromAgent: 'agent-x' });
      const result2 = await router.handleInboundMessage(envelope2);
      expect(result2.spawned).toBe(true);
    });

    it('no threadId (first-contact): mints a threadId and handles the message', async () => {
      const threadResumeMap = new ThreadResumeMap(tmpDir, '/test/project');
      const spawnManager = makeMockSpawnManager(true);
      const messageRouter = makeMockMessageRouter();
      const messageStore = makeMockMessageStore();

      const router = new ThreadlineRouter(
        messageRouter, spawnManager, threadResumeMap, messageStore,
        { localAgent: 'local-agent', localMachine: 'local-machine' },
      );

      const envelope = makeEnvelope({ fromAgent: 'remote-agent' }); // no threadId
      const result = await router.handleInboundMessage(envelope);

      expect(result.handled).toBe(true);
      expect(result.threadId).toBeDefined();
      expect(result.spawned).toBe(true);
      expect(result.threadId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(envelope.message.threadId).toBe(result.threadId);
    });

    it('self-sent message (from.agent === localAgent) is not handled', async () => {
      const threadResumeMap = new ThreadResumeMap(tmpDir, '/test/project');
      const spawnManager = makeMockSpawnManager(true);
      const messageRouter = makeMockMessageRouter();
      const messageStore = makeMockMessageStore();

      const router = new ThreadlineRouter(
        messageRouter, spawnManager, threadResumeMap, messageStore,
        { localAgent: 'local-agent', localMachine: 'local-machine' },
      );

      const envelope = makeEnvelope({ threadId: crypto.randomUUID(), fromAgent: 'local-agent' });
      const result = await router.handleInboundMessage(envelope);

      expect(result.handled).toBe(false);
    });

    it('spawn denial is propagated correctly through router', async () => {
      const autonomyManager = makeAutonomyManager('autonomous');
      const approvalQueue = new ApprovalQueue(tmpDir);
      const digestCollector = new DigestCollector(tmpDir);
      const gate = new AutonomyGate({
        autonomyManager, approvalQueue, digestCollector, stateDir: tmpDir,
      });

      const threadResumeMap = new ThreadResumeMap(tmpDir, '/test/project');
      const spawnManager = makeMockSpawnManager(false); // denied
      const messageRouter = makeMockMessageRouter();
      const messageStore = makeMockMessageStore();

      const router = new ThreadlineRouter(
        messageRouter, spawnManager, threadResumeMap, messageStore,
        { localAgent: 'local-agent', localMachine: 'local-machine' },
        gate,
      );

      const envelope = makeEnvelope({ threadId: crypto.randomUUID(), fromAgent: 'remote-agent' });
      const result = await router.handleInboundMessage(envelope);

      expect(result.handled).toBe(true);
      expect(result.error).toContain('Spawn denied');
      expect(spawnManager.handleDenial).toHaveBeenCalled();
    });
  });

  // ================================================================
  // Category 3: Discovery + Handshake + Trust Chain
  // ================================================================
  describe('Discovery + Handshake + Trust Chain', () => {
    it('discovered agent can be verified and trust established', async () => {
      const dirA = path.join(tmpDir, 'agent-a');
      fs.mkdirSync(dirA, { recursive: true });

      // We need to mock loadRegistry so AgentDiscovery doesn't try real registry
      vi.mock('../../../src/core/AgentRegistry.js', () => ({
        loadRegistry: () => ({
          entries: [
            { name: 'agent-b', path: '/test/agent-b', port: 4001, status: 'running', type: 'claude' },
          ],
        }),
      }));

      const handshakeA = new HandshakeManager(dirA, 'agent-a');
      const pubKeyA = handshakeA.getIdentityPublicKey();

      const fetcher = makeMockFetcher({
        'http://localhost:4001/threadline/health': {
          status: 'ok',
          protocol: 'threadline',
          version: '1.0',
          agent: 'agent-b',
          identityPub: crypto.randomBytes(32).toString('hex'),
          capabilities: ['message', 'task-request'],
          framework: 'instar',
        },
      });

      const discovery = new AgentDiscovery({
        stateDir: dirA,
        selfPath: '/test/agent-a',
        selfName: 'agent-a',
        selfPort: 4000,
        fetcher,
      });

      const verified = await discovery.verifyAgent('agent-b', 4001);
      expect(verified).not.toBeNull();
      expect(verified!.name).toBe('agent-b');
      expect(verified!.status).toBe('active');
      expect(verified!.threadlineEnabled).toBe(true);
      expect(verified!.capabilities).toContain('message');

      // Establish trust based on verification
      const trustManager = new AgentTrustManager({ stateDir: dirA });
      trustManager.setTrustLevel('agent-b', 'verified', 'user-granted', 'Verified via discovery');

      expect(trustManager.checkPermission('agent-b', 'message')).toBe(true);

      vi.restoreAllMocks();
    });

    it('verification failure results in null agent info', async () => {
      const dirA = path.join(tmpDir, 'agent-a');
      fs.mkdirSync(dirA, { recursive: true });

      const fetcher = makeMockFetcher({
        // Returns non-threadline protocol
        'http://localhost:4001/threadline/health': {
          status: 'ok',
          protocol: 'not-threadline',
        },
      });

      const discovery = new AgentDiscovery({
        stateDir: dirA,
        selfPath: '/test/agent-a',
        selfName: 'agent-a',
        selfPort: 4000,
        fetcher,
      });

      const result = await discovery.verifyAgent('agent-b', 4001);
      expect(result).toBeNull();
    });

    it('agent announces presence and self info is persisted', () => {
      const dirA = path.join(tmpDir, 'agent-a');
      fs.mkdirSync(dirA, { recursive: true });

      const discovery = new AgentDiscovery({
        stateDir: dirA,
        selfPath: '/test/agent-a',
        selfName: 'agent-a',
        selfPort: 4000,
        fetcher: makeMockFetcher(),
      });

      discovery.announcePresence({
        capabilities: ['message', 'task-request'],
        description: 'Test agent',
        threadlineVersion: '1.0',
        publicKey: crypto.randomBytes(32).toString('hex'),
        framework: 'instar',
      });

      const selfInfo = discovery.getSelfInfo();
      expect(selfInfo).not.toBeNull();
      expect(selfInfo!.name).toBe('agent-a');
      expect(selfInfo!.capabilities).toContain('message');
    });

    it('searchByCapability finds agents with matching capabilities', async () => {
      const dirA = path.join(tmpDir, 'agent-a');
      fs.mkdirSync(dirA, { recursive: true });

      const fetcher = makeMockFetcher({
        'http://localhost:4001/threadline/health': {
          status: 'ok',
          protocol: 'threadline',
          version: '1.0',
          agent: 'agent-b',
          identityPub: crypto.randomBytes(32).toString('hex'),
          capabilities: ['research', 'code-review'],
          framework: 'instar',
        },
      });

      const discovery = new AgentDiscovery({
        stateDir: dirA,
        selfPath: '/test/agent-a',
        selfName: 'agent-a',
        selfPort: 4000,
        fetcher,
      });

      // Verify the agent to populate known-agents
      await discovery.verifyAgent('agent-b', 4001);

      const researchers = discovery.searchByCapability('research');
      expect(researchers).toHaveLength(1);
      expect(researchers[0].name).toBe('agent-b');

      const empty = discovery.searchByCapability('nonexistent');
      expect(empty).toHaveLength(0);
    });

    it('discovered agents with trust stored persist across discovery instances', async () => {
      const dirA = path.join(tmpDir, 'agent-a');
      fs.mkdirSync(dirA, { recursive: true });

      const fetcher = makeMockFetcher({
        'http://localhost:4001/threadline/health': {
          status: 'ok',
          protocol: 'threadline',
          version: '1.0',
          agent: 'agent-b',
          identityPub: crypto.randomBytes(32).toString('hex'),
          capabilities: ['message'],
          framework: 'instar',
        },
      });

      const discovery1 = new AgentDiscovery({
        stateDir: dirA,
        selfPath: '/test/agent-a',
        selfName: 'agent-a',
        selfPort: 4000,
        fetcher,
      });

      await discovery1.verifyAgent('agent-b', 4001);

      // Create new instance, load from disk
      const discovery2 = new AgentDiscovery({
        stateDir: dirA,
        selfPath: '/test/agent-a',
        selfName: 'agent-a',
        selfPort: 4000,
        fetcher: makeMockFetcher(),
      });

      const known = discovery2.loadKnownAgents();
      expect(known.length).toBeGreaterThanOrEqual(1);
      expect(known.find(a => a.name === 'agent-b')).toBeDefined();
    });

    it('getVerifiedAgents only returns agents with lastVerified and active status', async () => {
      const dirA = path.join(tmpDir, 'agent-a');
      fs.mkdirSync(dirA, { recursive: true });

      const fetcher = makeMockFetcher({
        'http://localhost:4001/threadline/health': {
          status: 'ok',
          protocol: 'threadline',
          version: '1.0',
          agent: 'agent-b',
          identityPub: crypto.randomBytes(32).toString('hex'),
          capabilities: ['message'],
          framework: 'instar',
        },
      });

      const discovery = new AgentDiscovery({
        stateDir: dirA,
        selfPath: '/test/agent-a',
        selfName: 'agent-a',
        selfPort: 4000,
        fetcher,
      });

      await discovery.verifyAgent('agent-b', 4001);

      const verified = discovery.getVerifiedAgents();
      expect(verified).toHaveLength(1);
      expect(verified[0].lastVerified).toBeDefined();
    });

    it('unreachable agent during verification returns null', async () => {
      const dirA = path.join(tmpDir, 'agent-a');
      fs.mkdirSync(dirA, { recursive: true });

      const fetcher: HttpFetcher = vi.fn(async () => {
        throw new Error('Connection refused');
      }) as any;

      const discovery = new AgentDiscovery({
        stateDir: dirA,
        selfPath: '/test/agent-a',
        selfName: 'agent-a',
        selfPort: 4000,
        fetcher,
      });

      const result = await discovery.verifyAgent('agent-b', 4001);
      expect(result).toBeNull();
    });

    it('verification + trust + handshake: full discovery-to-communication chain', async () => {
      const dirA = path.join(tmpDir, 'agent-a');
      const dirB = path.join(tmpDir, 'agent-b');
      fs.mkdirSync(dirA, { recursive: true });
      fs.mkdirSync(dirB, { recursive: true });

      // Step 1: Discovery
      const handshakeB = new HandshakeManager(dirB, 'agent-b');
      const pubKeyB = handshakeB.getIdentityPublicKey();

      const fetcher = makeMockFetcher({
        'http://localhost:4001/threadline/health': {
          status: 'ok',
          protocol: 'threadline',
          version: '1.0',
          agent: 'agent-b',
          identityPub: pubKeyB,
          capabilities: ['message'],
          framework: 'instar',
        },
      });

      const discovery = new AgentDiscovery({
        stateDir: dirA,
        selfPath: '/test/agent-a',
        selfName: 'agent-a',
        selfPort: 4000,
        fetcher,
      });

      const verifiedAgent = await discovery.verifyAgent('agent-b', 4001);
      expect(verifiedAgent).not.toBeNull();

      // Step 2: Handshake
      const handshakeA = new HandshakeManager(dirA, 'agent-a');
      const hello = (handshakeA.initiateHandshake('agent-b') as any).payload;
      const response = (handshakeB.handleHello(hello) as any).payload;
      const { confirmPayload, relayToken } = handshakeA.handleHelloResponse(response) as any;
      handshakeB.handleConfirm(confirmPayload);

      // Step 3: Trust
      const trustManager = new AgentTrustManager({ stateDir: dirA });
      trustManager.setTrustLevel('agent-b', 'trusted', 'user-granted', 'Verified and handshaked');

      expect(trustManager.checkPermission('agent-b', 'message')).toBe(true);
      expect(trustManager.checkPermission('agent-b', 'task-request')).toBe(true);
      expect(handshakeA.validateRelayToken('agent-b', relayToken)).toBe(true);
    });
  });

  // ================================================================
  // Category 4: Circuit Breaker + Trust Auto-Downgrade
  // ================================================================
  describe('Circuit Breaker + Trust Auto-Downgrade', () => {
    it('5 consecutive failures open the circuit', () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      const cb = new CircuitBreaker({ stateDir: tmpDir, trustManager });

      for (let i = 0; i < 4; i++) {
        cb.recordFailure('agent-x');
        expect(cb.isOpen('agent-x')).toBe(false);
      }

      cb.recordFailure('agent-x'); // 5th
      expect(cb.isOpen('agent-x')).toBe(true);
    });

    it('half-open -> success -> circuit closes', () => {
      let currentTime = Date.now();
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      const cb = new CircuitBreaker({ stateDir: tmpDir, trustManager, nowFn: () => currentTime });

      // Open the circuit
      for (let i = 0; i < 5; i++) {
        cb.recordFailure('agent-x');
      }
      expect(cb.isOpen('agent-x')).toBe(true);

      // Advance past auto-reset time (1 hour)
      currentTime += 3600_001;

      // Circuit should transition to half-open
      expect(cb.isOpen('agent-x')).toBe(false);
      const state = cb.getState('agent-x');
      expect(state!.state).toBe('half-open');

      // Success closes it
      cb.recordSuccess('agent-x');
      const closedState = cb.getState('agent-x');
      expect(closedState!.state).toBe('closed');
      expect(closedState!.consecutiveFailures).toBe(0);
    });

    it('half-open -> failure -> circuit reopens', () => {
      let currentTime = Date.now();
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      const cb = new CircuitBreaker({ stateDir: tmpDir, trustManager, nowFn: () => currentTime });

      // Open
      for (let i = 0; i < 5; i++) cb.recordFailure('agent-x');
      expect(cb.isOpen('agent-x')).toBe(true);

      // Go to half-open
      currentTime += 3600_001;
      expect(cb.isOpen('agent-x')).toBe(false);

      // Failure during half-open reopens
      cb.recordFailure('agent-x');
      expect(cb.isOpen('agent-x')).toBe(true);
    });

    it('3 circuit activations in 24h triggers trust auto-downgrade to untrusted', () => {
      let currentTime = Date.now();
      const notifications: TrustChangeNotification[] = [];
      const trustManager = new AgentTrustManager({
        stateDir: tmpDir,
        onTrustChange: (n) => notifications.push(n),
      });
      trustManager.setTrustLevel('agent-x', 'trusted', 'user-granted');

      const cb = new CircuitBreaker({ stateDir: tmpDir, trustManager, nowFn: () => currentTime });

      // First activation
      for (let i = 0; i < 5; i++) cb.recordFailure('agent-x');
      expect(cb.isOpen('agent-x')).toBe(true);

      // Reset and second activation
      currentTime += 3600_001;
      cb.isOpen('agent-x'); // transition to half-open
      cb.recordSuccess('agent-x');
      for (let i = 0; i < 5; i++) cb.recordFailure('agent-x');

      // Reset and third activation
      currentTime += 3600_001;
      cb.isOpen('agent-x');
      cb.recordSuccess('agent-x');
      for (let i = 0; i < 5; i++) cb.recordFailure('agent-x');

      // Trust should be auto-downgraded
      const profile = trustManager.getProfile('agent-x');
      expect(profile!.level).toBe('untrusted');
      expect(notifications.some(n => n.newLevel === 'untrusted' && !n.userInitiated)).toBe(true);
    });

    it('circuit breaker + rate limiter both triggered simultaneously', () => {
      let currentTime = Date.now();
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      const cb = new CircuitBreaker({ stateDir: tmpDir, trustManager, nowFn: () => currentTime });
      const rateLimiter = new RateLimiter({
        stateDir: tmpDir,
        config: { perAgentBurst: { limit: 3, windowMs: 60_000 } },
        nowFn: () => currentTime,
      });

      // Hit burst limit
      for (let i = 0; i < 3; i++) {
        rateLimiter.recordEvent('perAgentBurst', 'agent-x');
      }
      expect(rateLimiter.isRateLimited('agent-x', 'inbound')).toBe(true);

      // Also open circuit breaker
      for (let i = 0; i < 5; i++) {
        cb.recordFailure('agent-x');
      }
      expect(cb.isOpen('agent-x')).toBe(true);

      // Both should be independently triggered
      expect(rateLimiter.isRateLimited('agent-x', 'inbound')).toBe(true);
      expect(cb.isOpen('agent-x')).toBe(true);
    });

    it('manual reset restores circuit to closed', () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      const cb = new CircuitBreaker({ stateDir: tmpDir, trustManager });

      for (let i = 0; i < 5; i++) cb.recordFailure('agent-x');
      expect(cb.isOpen('agent-x')).toBe(true);

      cb.reset('agent-x');
      expect(cb.isOpen('agent-x')).toBe(false);
      const state = cb.getState('agent-x');
      expect(state!.state).toBe('closed');
      expect(state!.consecutiveFailures).toBe(0);
    });

    it('trust auto-downgrade cannot auto-upgrade back', () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      trustManager.setTrustLevel('agent-x', 'trusted', 'user-granted');

      // Auto-downgrade
      trustManager.autoDowngrade('agent-x', 'Test downgrade');
      expect(trustManager.getProfile('agent-x')!.level).toBe('untrusted');

      // Try to auto-upgrade via setup-default (should fail)
      const result = trustManager.setTrustLevel('agent-x', 'verified', 'setup-default');
      expect(result).toBe(false);
      expect(trustManager.getProfile('agent-x')!.level).toBe('untrusted');

      // User-granted upgrade should work
      const result2 = trustManager.setTrustLevel('agent-x', 'verified', 'user-granted');
      expect(result2).toBe(true);
      expect(trustManager.getProfile('agent-x')!.level).toBe('verified');
    });

    it('staleness auto-downgrade: 90 days no interaction downgrades one level', () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      trustManager.setTrustLevel('agent-x', 'trusted', 'user-granted');
      trustManager.recordInteraction('agent-x', true);

      const now = Date.now();
      const ninetyOneDays = 91 * 24 * 60 * 60 * 1000;

      // Before 90 days: no change
      const result1 = trustManager.checkStalenessDowngrade('agent-x', now + 89 * 24 * 60 * 60 * 1000);
      expect(result1).toBe(false);

      // After 90 days: downgrade one level (trusted -> verified)
      const result2 = trustManager.checkStalenessDowngrade('agent-x', now + ninetyOneDays);
      expect(result2).toBe(true);
      expect(trustManager.getProfile('agent-x')!.level).toBe('verified');
    });
  });

  // ================================================================
  // Category 5: Session Lifecycle: Resume + Thread State
  // ================================================================
  describe('Session Lifecycle: Resume + Thread State', () => {
    it('new thread -> save -> message arrives -> resume same session', async () => {
      const projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });
      const threadResumeMap = new ThreadResumeMap(tmpDir, projectDir);
      const spawnManager = makeMockSpawnManager(true);
      const messageRouter = makeMockMessageRouter();
      const messageStore = makeMockMessageStore();

      const router = new ThreadlineRouter(
        messageRouter, spawnManager, threadResumeMap, messageStore,
        { localAgent: 'local-agent', localMachine: 'local-machine' },
      );

      const threadId = crypto.randomUUID();

      // First message spawns new session
      const envelope1 = makeEnvelope({ threadId, fromAgent: 'remote-agent', subject: 'Hello' });
      const result1 = await router.handleInboundMessage(envelope1);
      expect(result1.spawned).toBe(true);

      // Thread should be saved in resume map
      const entry = threadResumeMap.get(threadId);
      // Note: get() checks for JSONL existence which won't work in test env
      // So we check via the raw file instead
      const rawMap = JSON.parse(fs.readFileSync(
        path.join(tmpDir, 'threadline', 'thread-resume-map.json'), 'utf-8',
      ));
      expect(rawMap[threadId]).toBeDefined();
      expect(rawMap[threadId].state).toBe('active');
      expect(rawMap[threadId].remoteAgent).toBe('remote-agent');
    });

    it('thread resolved -> new message creates new session', async () => {
      const projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });
      const threadResumeMap = new ThreadResumeMap(tmpDir, projectDir);

      const threadId = crypto.randomUUID();
      const now = new Date().toISOString();

      // Save an active thread
      threadResumeMap.save(threadId, {
        uuid: crypto.randomUUID(),
        sessionName: 'test-session',
        createdAt: now,
        savedAt: now,
        lastAccessedAt: now,
        remoteAgent: 'remote-agent',
        subject: 'Old conversation',
        state: 'active',
        pinned: false,
        messageCount: 5,
      });

      // Resolve the thread
      threadResumeMap.resolve(threadId);
      const rawMap = JSON.parse(fs.readFileSync(
        path.join(tmpDir, 'threadline', 'thread-resume-map.json'), 'utf-8',
      ));
      expect(rawMap[threadId].state).toBe('resolved');
    });

    it('multiple threads with same agent each have own session', () => {
      const projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });
      const threadResumeMap = new ThreadResumeMap(tmpDir, projectDir);

      const now = new Date().toISOString();
      const thread1 = crypto.randomUUID();
      const thread2 = crypto.randomUUID();
      const uuid1 = crypto.randomUUID();
      const uuid2 = crypto.randomUUID();

      threadResumeMap.save(thread1, {
        uuid: uuid1, sessionName: 'session-1', createdAt: now, savedAt: now,
        lastAccessedAt: now, remoteAgent: 'agent-b', subject: 'Topic A',
        state: 'active', pinned: false, messageCount: 1,
      });

      threadResumeMap.save(thread2, {
        uuid: uuid2, sessionName: 'session-2', createdAt: now, savedAt: now,
        lastAccessedAt: now, remoteAgent: 'agent-b', subject: 'Topic B',
        state: 'active', pinned: false, messageCount: 1,
      });

      // Both threads for same agent
      const byAgent = threadResumeMap.getByRemoteAgent('agent-b');
      expect(byAgent).toHaveLength(2);
      expect(byAgent.map(a => a.entry.uuid).sort()).toEqual([uuid1, uuid2].sort());
    });

    it('pinned thread survives LRU eviction', () => {
      const projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });
      const threadResumeMap = new ThreadResumeMap(tmpDir, projectDir);

      const pinnedThreadId = 'pinned-thread';

      // Save a thread that is already pinned with an old timestamp.
      // Must set pinned: true at save time, because save() runs pruneMap()
      // internally and would evict an unpinned expired entry immediately.
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      threadResumeMap.save(pinnedThreadId, {
        uuid: 'pinned-uuid', sessionName: 'pinned-session', createdAt: oldDate,
        savedAt: oldDate, lastAccessedAt: oldDate, remoteAgent: 'agent-b',
        subject: 'Important thread', state: 'active', pinned: true, messageCount: 10,
      });

      // Run prune - pinned should survive even though it's expired by age
      threadResumeMap.prune();

      const rawMap = JSON.parse(fs.readFileSync(
        path.join(tmpDir, 'threadline', 'thread-resume-map.json'), 'utf-8',
      ));
      expect(rawMap[pinnedThreadId]).toBeDefined();
      expect(rawMap[pinnedThreadId].pinned).toBe(true);
    });

    it('unpinned expired thread is pruned', () => {
      const projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });
      const threadResumeMap = new ThreadResumeMap(tmpDir, projectDir);

      const threadId = 'old-thread';
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

      threadResumeMap.save(threadId, {
        uuid: 'old-uuid', sessionName: 'old-session', createdAt: oldDate,
        savedAt: oldDate, lastAccessedAt: oldDate, remoteAgent: 'agent-b',
        subject: 'Old thread', state: 'active', pinned: false, messageCount: 5,
      });

      threadResumeMap.prune();

      const rawMap = JSON.parse(fs.readFileSync(
        path.join(tmpDir, 'threadline', 'thread-resume-map.json'), 'utf-8',
      ));
      expect(rawMap[threadId]).toBeUndefined();
    });

    it('listActive returns only active and idle threads', () => {
      const projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });
      const threadResumeMap = new ThreadResumeMap(tmpDir, projectDir);
      const now = new Date().toISOString();

      threadResumeMap.save('active-thread', {
        uuid: 'uuid-1', sessionName: 's1', createdAt: now, savedAt: now,
        lastAccessedAt: now, remoteAgent: 'agent-b', subject: 'Active',
        state: 'active', pinned: false, messageCount: 1,
      });

      threadResumeMap.save('idle-thread', {
        uuid: 'uuid-2', sessionName: 's2', createdAt: now, savedAt: now,
        lastAccessedAt: now, remoteAgent: 'agent-c', subject: 'Idle',
        state: 'idle', pinned: false, messageCount: 3,
      });

      threadResumeMap.save('resolved-thread', {
        uuid: 'uuid-3', sessionName: 's3', createdAt: now, savedAt: now,
        lastAccessedAt: now, remoteAgent: 'agent-d', subject: 'Done',
        state: 'resolved', pinned: false, messageCount: 5,
      });

      threadResumeMap.save('failed-thread', {
        uuid: 'uuid-4', sessionName: 's4', createdAt: now, savedAt: now,
        lastAccessedAt: now, remoteAgent: 'agent-e', subject: 'Failed',
        state: 'failed', pinned: false, messageCount: 2,
      });

      const active = threadResumeMap.listActive();
      expect(active).toHaveLength(2);
      expect(active.map(a => a.entry.state).sort()).toEqual(['active', 'idle']);
    });

    it('onSessionEnd updates thread to idle with new UUID', () => {
      const projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });
      const threadResumeMap = new ThreadResumeMap(tmpDir, projectDir);
      const spawnManager = makeMockSpawnManager(true);
      const messageRouter = makeMockMessageRouter();
      const messageStore = makeMockMessageStore();

      const router = new ThreadlineRouter(
        messageRouter, spawnManager, threadResumeMap, messageStore,
        { localAgent: 'local-agent', localMachine: 'local-machine' },
      );

      const threadId = crypto.randomUUID();
      const now = new Date().toISOString();
      const originalUuid = crypto.randomUUID();

      // ThreadResumeMap.get() checks for JSONL file existence, so we need
      // to create a fake one under ~/.claude/projects/ for the UUID.
      const projectHash = projectDir.replace(/\//g, '-');
      const claudeProjectDir = path.join(os.homedir(), '.claude', 'projects', projectHash);
      fs.mkdirSync(claudeProjectDir, { recursive: true });
      const jsonlPath = path.join(claudeProjectDir, `${originalUuid}.jsonl`);
      fs.writeFileSync(jsonlPath, '');

      threadResumeMap.save(threadId, {
        uuid: originalUuid, sessionName: 'session-1', createdAt: now,
        savedAt: now, lastAccessedAt: now, remoteAgent: 'agent-b',
        subject: 'Test', state: 'active', pinned: false, messageCount: 3,
      });

      const newUuid = crypto.randomUUID();
      router.onSessionEnd(threadId, newUuid, 'session-1');

      const rawMap = JSON.parse(fs.readFileSync(
        path.join(tmpDir, 'threadline', 'thread-resume-map.json'), 'utf-8',
      ));
      expect(rawMap[threadId].uuid).toBe(newUuid);
      expect(rawMap[threadId].state).toBe('idle');

      // Clean up the fake JSONL file
      // safe-git-allow: incremental-migration
      fs.rmSync(jsonlPath, { force: true });
      // safe-git-allow: incremental-migration
      try { fs.rmdirSync(claudeProjectDir); } catch { /* may not be empty */ }
    });

    it('onThreadResolved marks the thread as resolved', () => {
      const projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });
      const threadResumeMap = new ThreadResumeMap(tmpDir, projectDir);
      const spawnManager = makeMockSpawnManager(true);
      const messageRouter = makeMockMessageRouter();
      const messageStore = makeMockMessageStore();

      const router = new ThreadlineRouter(
        messageRouter, spawnManager, threadResumeMap, messageStore,
        { localAgent: 'local-agent', localMachine: 'local-machine' },
      );

      const threadId = crypto.randomUUID();
      const now = new Date().toISOString();

      threadResumeMap.save(threadId, {
        uuid: crypto.randomUUID(), sessionName: 'session-1', createdAt: now,
        savedAt: now, lastAccessedAt: now, remoteAgent: 'agent-b',
        subject: 'Test', state: 'active', pinned: false, messageCount: 3,
      });

      router.onThreadResolved(threadId);

      const rawMap = JSON.parse(fs.readFileSync(
        path.join(tmpDir, 'threadline', 'thread-resume-map.json'), 'utf-8',
      ));
      expect(rawMap[threadId].state).toBe('resolved');
      expect(rawMap[threadId].resolvedAt).toBeDefined();
    });
  });

  // ================================================================
  // Category 6: Rate Limiting Under Load
  // ================================================================
  describe('Rate Limiting Under Load', () => {
    it('burst protection: limit of 5 messages/minute from single agent', () => {
      let currentTime = Date.now();
      const rateLimiter = new RateLimiter({
        stateDir: tmpDir,
        config: { perAgentBurst: { limit: 5, windowMs: 60_000 } },
        nowFn: () => currentTime,
      });

      for (let i = 0; i < 5; i++) {
        const result = rateLimiter.recordEvent('perAgentBurst', 'agent-x');
        expect(result.allowed).toBe(true);
      }

      const overLimit = rateLimiter.recordEvent('perAgentBurst', 'agent-x');
      expect(overLimit.allowed).toBe(false);
      expect(overLimit.remaining).toBe(0);
    });

    it('per-agent limit: 30 messages/hour', () => {
      let currentTime = Date.now();
      const rateLimiter = new RateLimiter({
        stateDir: tmpDir,
        config: { perAgentInbound: { limit: 30, windowMs: 3600_000 } },
        nowFn: () => currentTime,
      });

      for (let i = 0; i < 30; i++) {
        const result = rateLimiter.recordEvent('perAgentInbound', 'agent-x');
        expect(result.allowed).toBe(true);
      }

      const overLimit = rateLimiter.checkLimit('perAgentInbound', 'agent-x');
      expect(overLimit.allowed).toBe(false);
    });

    it('global limit: many agents hitting aggregate limit', () => {
      let currentTime = Date.now();
      const rateLimiter = new RateLimiter({
        stateDir: tmpDir,
        config: { globalInbound: { limit: 10, windowMs: 3600_000 } },
        nowFn: () => currentTime,
      });

      // 10 different agents each send 1 message to global counter
      for (let i = 0; i < 10; i++) {
        const result = rateLimiter.recordEvent('globalInbound', 'global');
        expect(result.allowed).toBe(true);
      }

      // 11th should be limited
      const limited = rateLimiter.checkLimit('globalInbound', 'global');
      expect(limited.allowed).toBe(false);
    });

    it('rate limited does NOT trigger circuit breaker', () => {
      let currentTime = Date.now();
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      const cb = new CircuitBreaker({ stateDir: tmpDir, trustManager, nowFn: () => currentTime });
      const rateLimiter = new RateLimiter({
        stateDir: tmpDir,
        config: { perAgentBurst: { limit: 3, windowMs: 60_000 } },
        nowFn: () => currentTime,
      });

      // Hit rate limit
      for (let i = 0; i < 4; i++) {
        rateLimiter.recordEvent('perAgentBurst', 'agent-x');
      }
      expect(rateLimiter.isRateLimited('agent-x', 'inbound')).toBe(true);

      // Circuit should still be closed - rate limiting is not a failure
      expect(cb.isOpen('agent-x')).toBe(false);
      const state = cb.getState('agent-x');
      expect(state).toBeNull(); // No circuit state at all
    });

    it('after rate limit window passes, messages flow again', () => {
      let currentTime = Date.now();
      const rateLimiter = new RateLimiter({
        stateDir: tmpDir,
        config: { perAgentBurst: { limit: 3, windowMs: 60_000 } },
        nowFn: () => currentTime,
      });

      // Hit limit
      for (let i = 0; i < 3; i++) {
        rateLimiter.recordEvent('perAgentBurst', 'agent-x');
      }
      expect(rateLimiter.isRateLimited('agent-x', 'inbound')).toBe(true);

      // Advance past window
      currentTime += 61_000;
      expect(rateLimiter.isRateLimited('agent-x', 'inbound')).toBe(false);

      // Can send again
      const result = rateLimiter.recordEvent('perAgentBurst', 'agent-x');
      expect(result.allowed).toBe(true);
    });

    it('reset clears rate limit for specific agent', () => {
      let currentTime = Date.now();
      const rateLimiter = new RateLimiter({
        stateDir: tmpDir,
        config: { perAgentBurst: { limit: 3, windowMs: 60_000 } },
        nowFn: () => currentTime,
      });

      for (let i = 0; i < 3; i++) {
        rateLimiter.recordEvent('perAgentBurst', 'agent-x');
      }
      expect(rateLimiter.isRateLimited('agent-x', 'inbound')).toBe(true);

      rateLimiter.reset('perAgentBurst', 'agent-x');
      expect(rateLimiter.isRateLimited('agent-x', 'inbound')).toBe(false);
    });
  });

  // ================================================================
  // Additional Cross-Module Integration Tests
  // ================================================================
  describe('Cross-Module: Approval Queue + Digest + Gate', () => {
    it('approval queue entries expire based on TTL', () => {
      const approvalQueue = new ApprovalQueue(tmpDir);
      const envelope = makeEnvelope({
        fromAgent: 'agent-x',
        threadId: crypto.randomUUID(),
        ttlMinutes: 1,
      });

      const id = approvalQueue.enqueue(envelope);
      expect(approvalQueue.pendingCount()).toBe(1);

      // Manually backdate the receivedAt to force expiry
      const filePath = path.join(tmpDir, 'threadline', 'approval-queue.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      data.entries[0].receivedAt = new Date(Date.now() - 120_000).toISOString(); // 2 minutes ago
      fs.writeFileSync(filePath, JSON.stringify(data));

      const expired = approvalQueue.pruneExpired();
      expect(expired).toContain(id);
      expect(approvalQueue.pendingCount()).toBe(0);
    });

    it('digest collector groups entries by agent and generates readable summary', () => {
      const digestCollector = new DigestCollector(tmpDir);

      const envelope1 = makeEnvelope({ fromAgent: 'agent-a', subject: 'Task update', type: 'info' });
      const envelope2 = makeEnvelope({ fromAgent: 'agent-b', subject: 'Query result', type: 'response' });
      const envelope3 = makeEnvelope({ fromAgent: 'agent-a', subject: 'Status report', type: 'sync' });

      digestCollector.addEntry(envelope1);
      digestCollector.addEntry(envelope2);
      digestCollector.addEntry(envelope3);

      expect(digestCollector.entryCount()).toBe(3);

      const digest = digestCollector.generateDigest();
      expect(digest).not.toBeNull();
      expect(digest).toContain('agent-a (2 messages)');
      expect(digest).toContain('agent-b (1 messages)');
      expect(digest).toContain('Task update');
    });

    it('digest markDigestSent clears entries and updates timestamp', () => {
      const digestCollector = new DigestCollector(tmpDir);

      digestCollector.addEntry(makeEnvelope({ fromAgent: 'agent-a' }));
      digestCollector.addEntry(makeEnvelope({ fromAgent: 'agent-b' }));
      expect(digestCollector.entryCount()).toBe(2);

      digestCollector.markDigestSent();
      expect(digestCollector.entryCount()).toBe(0);
      expect(digestCollector.generateDigest()).toBeNull();
    });

    it('gate checkAndSendDigest sends when interval elapsed', async () => {
      const autonomyManager = makeAutonomyManager('collaborative');
      const approvalQueue = new ApprovalQueue(tmpDir);
      const digestCollector = new DigestCollector(tmpDir);
      const notifier = makeMockNotifier();
      const gate = new AutonomyGate({
        autonomyManager, approvalQueue, digestCollector, notifier, stateDir: tmpDir,
      });

      // Add entries
      digestCollector.addEntry(makeEnvelope({ fromAgent: 'agent-a' }));

      // Set interval to 0 so it's always ready
      digestCollector.setDigestInterval(0);

      // Force lastDigestSentAt to be old enough
      const filePath = path.join(tmpDir, 'threadline', 'digest.json');
      const state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      state.lastDigestSentAt = new Date(Date.now() - 120_000).toISOString();
      fs.writeFileSync(filePath, JSON.stringify(state));

      const sent = await gate.checkAndSendDigest();
      expect(sent).toBe(true);
      expect(notifier.sendDigest).toHaveBeenCalled();
      expect(digestCollector.entryCount()).toBe(0);
    });

    it('getControlledAgents lists all paused and blocked agents', () => {
      const autonomyManager = makeAutonomyManager('autonomous');
      const approvalQueue = new ApprovalQueue(tmpDir);
      const digestCollector = new DigestCollector(tmpDir);
      const gate = new AutonomyGate({
        autonomyManager, approvalQueue, digestCollector, stateDir: tmpDir,
      });

      gate.pauseAgent('paused-1', 'Testing');
      gate.blockAgent('blocked-1', 'Spam');
      gate.pauseAgent('paused-2');

      const controlled = gate.getControlledAgents();
      expect(controlled).toHaveLength(3);
      expect(controlled.find(a => a.agent === 'blocked-1')?.status).toBe('blocked');
      expect(controlled.find(a => a.agent === 'paused-1')?.status).toBe('paused');
    });

    it('resumeAgent removes pause and allows messages through', async () => {
      const autonomyManager = makeAutonomyManager('autonomous');
      const approvalQueue = new ApprovalQueue(tmpDir);
      const digestCollector = new DigestCollector(tmpDir);
      const gate = new AutonomyGate({
        autonomyManager, approvalQueue, digestCollector, stateDir: tmpDir,
      });

      gate.pauseAgent('agent-x');

      // Paused -> queued
      const env1 = makeEnvelope({ fromAgent: 'agent-x', threadId: 'thread-1' });
      const result1 = await gate.evaluate(env1);
      expect(result1.decision).toBe('queue-for-approval');

      // Resume
      gate.resumeAgent('agent-x');

      // Should now deliver
      const env2 = makeEnvelope({ fromAgent: 'agent-x', threadId: 'thread-2' });
      const result2 = await gate.evaluate(env2);
      expect(result2.decision).toBe('deliver');
    });
  });

  describe('Cross-Module: Trust + Permission + Operations', () => {
    it('trust level determines allowed operations progressively', () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });

      // Untrusted: only ping/health
      trustManager.getOrCreateProfile('agent-x');
      expect(trustManager.checkPermission('agent-x', 'ping')).toBe(true);
      expect(trustManager.checkPermission('agent-x', 'message')).toBe(false);
      expect(trustManager.checkPermission('agent-x', 'task-request')).toBe(false);
      expect(trustManager.checkPermission('agent-x', 'spawn')).toBe(false);

      // Verified: + message, query
      trustManager.setTrustLevel('agent-x', 'verified', 'user-granted');
      expect(trustManager.checkPermission('agent-x', 'message')).toBe(true);
      expect(trustManager.checkPermission('agent-x', 'query')).toBe(true);
      expect(trustManager.checkPermission('agent-x', 'task-request')).toBe(false);

      // Trusted: + task-request, data-share
      trustManager.setTrustLevel('agent-x', 'trusted', 'user-granted');
      expect(trustManager.checkPermission('agent-x', 'task-request')).toBe(true);
      expect(trustManager.checkPermission('agent-x', 'data-share')).toBe(true);
      expect(trustManager.checkPermission('agent-x', 'spawn')).toBe(false);

      // Autonomous: + spawn, delegate
      trustManager.setTrustLevel('agent-x', 'autonomous', 'user-granted');
      expect(trustManager.checkPermission('agent-x', 'spawn')).toBe(true);
      expect(trustManager.checkPermission('agent-x', 'delegate')).toBe(true);
    });

    it('blocked operations override trust level permissions', () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      trustManager.setTrustLevel('agent-x', 'trusted', 'user-granted');
      expect(trustManager.checkPermission('agent-x', 'task-request')).toBe(true);

      trustManager.blockOperation('agent-x', 'task-request');
      expect(trustManager.checkPermission('agent-x', 'task-request')).toBe(false);

      trustManager.unblockOperation('agent-x', 'task-request');
      expect(trustManager.checkPermission('agent-x', 'task-request')).toBe(true);
    });

    it('audit trail records all trust changes', () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });

      trustManager.setTrustLevel('agent-x', 'verified', 'user-granted', 'Initial verify');
      trustManager.setTrustLevel('agent-x', 'trusted', 'user-granted', 'Proven reliable');
      trustManager.autoDowngrade('agent-x', 'Circuit breaker triggered');

      const audit = trustManager.readAuditTrail();
      expect(audit.length).toBe(3);
      expect(audit[0].newLevel).toBe('verified');
      expect(audit[1].newLevel).toBe('trusted');
      expect(audit[2].newLevel).toBe('untrusted');
      expect(audit[2].userInitiated).toBe(false);
    });

    it('interaction stats track success rate accurately', () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      trustManager.getOrCreateProfile('agent-x');

      trustManager.recordInteraction('agent-x', true);
      trustManager.recordInteraction('agent-x', true);
      trustManager.recordInteraction('agent-x', false);
      trustManager.recordInteraction('agent-x', true);

      const stats = trustManager.getInteractionStats('agent-x');
      expect(stats!.successfulInteractions).toBe(3);
      expect(stats!.failedInteractions).toBe(1);
      expect(stats!.successRate).toBe(0.75);
      expect(stats!.streakSinceIncident).toBe(1); // reset on failure, then +1
    });

    it('listProfiles filters by level and source', () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      trustManager.setTrustLevel('agent-a', 'verified', 'user-granted');
      trustManager.setTrustLevel('agent-b', 'trusted', 'user-granted');
      trustManager.setTrustLevel('agent-c', 'verified', 'paired-machine-granted');
      trustManager.getOrCreateProfile('agent-d'); // untrusted/setup-default

      const verified = trustManager.listProfiles({ level: 'verified' });
      expect(verified).toHaveLength(2);

      const userGranted = trustManager.listProfiles({ source: 'user-granted' });
      expect(userGranted).toHaveLength(2);
    });
  });

  describe('Cross-Module: Circuit Breaker Persistence', () => {
    it('circuit state persists to disk and survives reload', () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      const cb = new CircuitBreaker({ stateDir: tmpDir, trustManager });

      cb.recordSuccess('agent-x');
      cb.recordSuccess('agent-x');
      cb.recordFailure('agent-x');

      // Create new instance loading from disk
      const cb2 = new CircuitBreaker({ stateDir: tmpDir, trustManager });
      const state = cb2.getState('agent-x');
      expect(state).not.toBeNull();
      expect(state!.totalSuccesses).toBe(2);
      expect(state!.totalFailures).toBe(1);
    });

    it('rate limiter persists to disk', () => {
      let currentTime = Date.now();
      const rl = new RateLimiter({
        stateDir: tmpDir,
        config: { perAgentBurst: { limit: 10, windowMs: 60_000 } },
        nowFn: () => currentTime,
      });

      rl.recordEvent('perAgentBurst', 'agent-x');
      rl.recordEvent('perAgentBurst', 'agent-x');
      rl.persistToDisk();

      // New instance loads from disk
      const rl2 = new RateLimiter({
        stateDir: tmpDir,
        config: { perAgentBurst: { limit: 10, windowMs: 60_000 } },
        nowFn: () => currentTime,
      });

      const status = rl2.getStatus('agent-x');
      const burstStatus = status.find(s => s.type === 'perAgentBurst');
      expect(burstStatus).toBeDefined();
      expect(burstStatus!.currentCount).toBe(2);
    });
  });

  describe('Cross-Module: ThreadResumeMap + Router Session Management', () => {
    it('onThreadFailed marks thread as failed in resume map', () => {
      const projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });
      const threadResumeMap = new ThreadResumeMap(tmpDir, projectDir);
      const spawnManager = makeMockSpawnManager(true);
      const messageRouter = makeMockMessageRouter();
      const messageStore = makeMockMessageStore();

      const router = new ThreadlineRouter(
        messageRouter, spawnManager, threadResumeMap, messageStore,
        { localAgent: 'local-agent', localMachine: 'local-machine' },
      );

      const threadId = crypto.randomUUID();
      const now = new Date().toISOString();
      const entryUuid = crypto.randomUUID();

      // ThreadlineRouter.onThreadFailed calls threadResumeMap.get() which
      // checks JSONL existence. Create a fake JSONL file for the UUID.
      const projectHash = projectDir.replace(/\//g, '-');
      const claudeProjectDir = path.join(os.homedir(), '.claude', 'projects', projectHash);
      fs.mkdirSync(claudeProjectDir, { recursive: true });
      const jsonlPath = path.join(claudeProjectDir, `${entryUuid}.jsonl`);
      fs.writeFileSync(jsonlPath, '');

      threadResumeMap.save(threadId, {
        uuid: entryUuid, sessionName: 'session-1', createdAt: now,
        savedAt: now, lastAccessedAt: now, remoteAgent: 'agent-b',
        subject: 'Test', state: 'active', pinned: false, messageCount: 3,
      });

      router.onThreadFailed(threadId);

      const rawMap = JSON.parse(fs.readFileSync(
        path.join(tmpDir, 'threadline', 'thread-resume-map.json'), 'utf-8',
      ));
      expect(rawMap[threadId].state).toBe('failed');

      // Clean up
      // safe-git-allow: incremental-migration
      fs.rmSync(jsonlPath, { force: true });
      // safe-git-allow: incremental-migration
      try { fs.rmdirSync(claudeProjectDir); } catch { /* may not be empty */ }
    });

    it('concurrent spawns for same thread are blocked', async () => {
      const autonomyManager = makeAutonomyManager('autonomous');
      const approvalQueue = new ApprovalQueue(tmpDir);
      const digestCollector = new DigestCollector(tmpDir);
      const gate = new AutonomyGate({
        autonomyManager, approvalQueue, digestCollector, stateDir: tmpDir,
      });

      const projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });
      const threadResumeMap = new ThreadResumeMap(tmpDir, projectDir);

      // Slow spawn manager that takes time
      let resolveSpawn: (val: any) => void;
      const slowSpawnPromise = new Promise(resolve => { resolveSpawn = resolve; });
      const slowSpawnManager = {
        evaluate: vi.fn().mockImplementation(() => slowSpawnPromise),
        handleDenial: vi.fn(),
      } as any;

      const messageRouter = makeMockMessageRouter();
      const messageStore = makeMockMessageStore();

      const router = new ThreadlineRouter(
        messageRouter, slowSpawnManager, threadResumeMap, messageStore,
        { localAgent: 'local-agent', localMachine: 'local-machine' },
        gate,
      );

      const threadId = crypto.randomUUID();
      const env1 = makeEnvelope({ threadId, fromAgent: 'agent-x' });
      const env2 = makeEnvelope({ threadId, fromAgent: 'agent-x' });

      // Start first (will block on spawn)
      const promise1 = router.handleInboundMessage(env1);

      // Second should detect pending spawn
      const result2 = await router.handleInboundMessage(env2);
      expect(result2.error).toContain('Spawn already in progress');

      // Resolve first
      resolveSpawn!({
        approved: true,
        sessionId: crypto.randomUUID(),
        tmuxSession: 'test-session',
      });
      const result1 = await promise1;
      expect(result1.spawned).toBe(true);
    });

    it('size() returns correct count of entries', () => {
      const projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });
      const threadResumeMap = new ThreadResumeMap(tmpDir, projectDir);
      const now = new Date().toISOString();

      expect(threadResumeMap.size()).toBe(0);

      threadResumeMap.save('thread-1', {
        uuid: 'uuid-1', sessionName: 's1', createdAt: now, savedAt: now,
        lastAccessedAt: now, remoteAgent: 'agent-b', subject: 'A',
        state: 'active', pinned: false, messageCount: 1,
      });

      threadResumeMap.save('thread-2', {
        uuid: 'uuid-2', sessionName: 's2', createdAt: now, savedAt: now,
        lastAccessedAt: now, remoteAgent: 'agent-c', subject: 'B',
        state: 'active', pinned: false, messageCount: 1,
      });

      expect(threadResumeMap.size()).toBe(2);

      threadResumeMap.remove('thread-1');
      expect(threadResumeMap.size()).toBe(1);
    });
  });
});
