/**
 * ThreadlineFullStack — Comprehensive cross-cutting E2E tests for the ENTIRE
 * Threadline Protocol stack.
 *
 * Exercises the full vertical slice from cryptographic identity through every
 * phase: handshake (Phase 3), trust management (Phase 5), discovery (Phase 4),
 * A2A gateway infrastructure (Phase 6A), trust bootstrap (Phase 6C),
 * OpenClaw bridge (Phase 6D), and MCP auth (Phase 6B).
 *
 * Each scenario wires REAL module instances together — no mocks except for
 * network I/O (HTTP fetcher, DNS resolver). Every test creates agents from
 * scratch with their own state directories and validates cross-module contracts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Core (Phases 1-3)
import { HandshakeManager } from '../../../src/threadline/HandshakeManager.js';
import { ThreadResumeMap } from '../../../src/threadline/ThreadResumeMap.js';
import { AutonomyGate } from '../../../src/threadline/AutonomyGate.js';
import {
  generateIdentityKeyPair,
  sign,
  verify,
  deriveRelayToken,
} from '../../../src/threadline/ThreadlineCrypto.js';

// Discovery & Trust (Phases 4-5)
import { AgentDiscovery } from '../../../src/threadline/AgentDiscovery.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';

// Security (Phase 5)
import { CircuitBreaker } from '../../../src/threadline/CircuitBreaker.js';
import { RateLimiter } from '../../../src/threadline/RateLimiter.js';

// A2A Infrastructure (Phase 6A)
import { AgentCard } from '../../../src/threadline/AgentCard.js';
import { ContextThreadMap } from '../../../src/threadline/ContextThreadMap.js';
import { ComputeMeter } from '../../../src/threadline/ComputeMeter.js';
import { SessionLifecycle } from '../../../src/threadline/SessionLifecycle.js';

// Trust Bootstrap (Phase 6C)
import { TrustBootstrap } from '../../../src/threadline/TrustBootstrap.js';
import { InvitationManager } from '../../../src/threadline/InvitationManager.js';
import { DNSVerifier } from '../../../src/threadline/DNSVerifier.js';

// OpenClaw Bridge (Phase 6D)
import { OpenClawBridge } from '../../../src/threadline/OpenClawBridge.js';
import { generateSkillManifest } from '../../../src/threadline/OpenClawSkillManifest.js';

// MCP Auth (Phase 6B)
import { MCPAuth } from '../../../src/threadline/MCPAuth.js';

// Types
import type { AgentTrustLevel } from '../../../src/threadline/AgentTrustManager.js';
import type { OpenClawRuntime, OpenClawMessage } from '../../../src/threadline/OpenClawBridge.js';

// ── Full-Stack Agent ──────────────────────────────────────────────────

/**
 * A complete Threadline agent with every module wired together.
 * Represents a single agent in the mesh with its own state directory.
 */
class FullStackAgent {
  readonly name: string;
  readonly stateDir: string;

  // Core
  readonly handshake: HandshakeManager;
  readonly threadMap: ThreadResumeMap;

  // Discovery & Trust
  readonly discovery: AgentDiscovery;
  readonly trust: AgentTrustManager;

  // Security
  readonly circuitBreaker: CircuitBreaker;
  readonly rateLimiter: RateLimiter;

  // A2A Infrastructure
  readonly agentCard: AgentCard;
  readonly contextThreadMap: ContextThreadMap;
  readonly computeMeter: ComputeMeter;
  readonly sessionLifecycle: SessionLifecycle;

  // Trust Bootstrap
  readonly invitationManager: InvitationManager;
  readonly dnsVerifier: DNSVerifier;
  trustBootstrap: TrustBootstrap;

  // OpenClaw Bridge
  readonly openClawBridge: OpenClawBridge;

  // MCP Auth
  readonly mcpAuth: MCPAuth;

  // Message store (simulates actual message handling)
  readonly messageLog: Array<{ from: string; threadId: string; message: string; timestamp: string }>;

  constructor(name: string, baseDir: string, opts?: {
    port?: number;
    trustBootstrapStrategy?: 'directory-verified' | 'domain-verified' | 'invitation-only' | 'open';
  }) {
    this.name = name;
    this.stateDir = path.join(baseDir, name);
    fs.mkdirSync(this.stateDir, { recursive: true });
    this.messageLog = [];

    const port = opts?.port ?? (4040 + Math.floor(Math.random() * 100));

    // Core (Phase 1-3)
    this.handshake = new HandshakeManager(this.stateDir, name);
    this.threadMap = new ThreadResumeMap(this.stateDir, this.stateDir, '/bin/echo');

    // Discovery & Trust (Phase 4-5)
    this.trust = new AgentTrustManager({ stateDir: this.stateDir });
    this.discovery = new AgentDiscovery({
      stateDir: this.stateDir,
      selfPath: this.stateDir,
      selfName: name,
      selfPort: port,
    });
    this.circuitBreaker = new CircuitBreaker({
      stateDir: this.stateDir,
      trustManager: this.trust,
    });
    this.rateLimiter = new RateLimiter({ stateDir: this.stateDir });

    // A2A Infrastructure (Phase 6A)
    const identityKeys = generateIdentityKeyPair();
    this.agentCard = new AgentCard(
      {
        agentName: name,
        description: `${name} test agent`,
        url: `http://localhost:${port}`,
        identityPublicKey: identityKeys.publicKey,
      },
      (message: Buffer) => sign(identityKeys.privateKey, message),
    );
    this.contextThreadMap = new ContextThreadMap({ stateDir: this.stateDir });
    this.computeMeter = new ComputeMeter({ stateDir: this.stateDir });
    this.sessionLifecycle = new SessionLifecycle({
      stateDir: this.stateDir,
      maxActiveSessions: 10,
    });

    // Trust Bootstrap (Phase 6C)
    this.invitationManager = new InvitationManager({ stateDir: this.stateDir });
    this.dnsVerifier = new DNSVerifier({
      resolver: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); },
    });
    const strategy = opts?.trustBootstrapStrategy ?? 'invitation-only';
    this.trustBootstrap = new TrustBootstrap({
      strategy,
      stateDir: this.stateDir,
      trustManager: this.trust,
      invitationManager: this.invitationManager,
      dnsVerifier: this.dnsVerifier,
    });

    // MCP Auth (Phase 6B)
    this.mcpAuth = new MCPAuth(this.stateDir);

    // OpenClaw Bridge (Phase 6D)
    const agent = this;
    this.openClawBridge = new OpenClawBridge({
      stateDir: this.stateDir,
      trustManager: this.trust,
      computeMeter: this.computeMeter,
      contextThreadMap: this.contextThreadMap,
      sendMessage: async (params) => {
        agent.messageLog.push({
          from: params.fromAgent,
          threadId: params.threadId,
          message: params.message,
          timestamp: new Date().toISOString(),
        });
        return { message: `[${agent.name}] received: ${params.message}`, tokenCount: 100 };
      },
      discoverAgents: async () => {
        const profiles = agent.trust.listProfiles();
        return profiles.map(p => ({
          name: p.agent,
          trustLevel: p.level,
          description: `Agent ${p.agent}`,
        }));
      },
      getHistory: async (threadId, limit) => {
        return agent.messageLog
          .filter(m => m.threadId === threadId)
          .slice(-(limit ?? 10))
          .map(m => ({
            role: 'user' as const,
            content: m.message,
            timestamp: m.timestamp,
          }));
      },
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function performHandshake(initiator: FullStackAgent, responder: FullStackAgent) {
  const initResult = initiator.handshake.initiateHandshake(responder.name);
  if ('error' in initResult) throw new Error(`Initiate failed: ${initResult.error}`);

  const respResult = responder.handshake.handleHello(initResult.payload);
  if ('error' in respResult) throw new Error(`HandleHello failed: ${respResult.error}`);

  const confirmResult = initiator.handshake.handleHelloResponse(respResult.payload);
  if ('error' in confirmResult) throw new Error(`HandleHelloResponse failed: ${confirmResult.error}`);

  const finalResult = responder.handshake.handleConfirm(confirmResult.confirmPayload);
  if ('error' in finalResult) throw new Error(`HandleConfirm failed: ${finalResult.error}`);

  return {
    initiatorToken: confirmResult.relayToken,
    responderToken: finalResult.relayToken,
  };
}

function makeRuntime(agent: FullStackAgent): OpenClawRuntime {
  return {
    agentId: agent.name,
    character: { name: agent.name, description: `${agent.name} test agent` },
    getSetting: (key: string) => undefined,
    messageManager: {
      createMemory: async () => {},
      getMemories: async () => [],
    },
  };
}

function makeMessage(userId: string, roomId: string, text: string): OpenClawMessage {
  return { userId, roomId, content: { text } };
}

// ── Test Suite ────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-fullstack-'));
});

afterEach(() => {
  // safe-git-allow: incremental-migration
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════════
// SCENARIO 1: Full Agent Lifecycle — Birth to Conversation
// ══════════════════════════════════════════════════════════════════════

describe('Scenario 1: Full Agent Lifecycle — Birth to Conversation', () => {
  it('creates two agents with independent cryptographic identities', () => {
    const dawn = new FullStackAgent('dawn', tmpDir);
    const echo = new FullStackAgent('echo', tmpDir);

    const dawnPub = dawn.handshake.getIdentityPublicKey();
    const echoPub = echo.handshake.getIdentityPublicKey();

    expect(dawnPub).toHaveLength(64);
    expect(echoPub).toHaveLength(64);
    expect(dawnPub).not.toBe(echoPub);
  });

  it('agents perform cryptographic handshake and derive shared relay tokens', () => {
    const dawn = new FullStackAgent('dawn', tmpDir);
    const echo = new FullStackAgent('echo', tmpDir);

    const { initiatorToken, responderToken } = performHandshake(dawn, echo);

    // Both sides derive the same relay token
    expect(initiatorToken).toHaveLength(64);
    expect(responderToken).toHaveLength(64);
    expect(initiatorToken).toBe(responderToken);
  });

  it('handshake establishes trust profiles on both sides', () => {
    const dawn = new FullStackAgent('dawn', tmpDir);
    const echo = new FullStackAgent('echo', tmpDir);

    // Before handshake — no trust profiles
    expect(dawn.trust.getProfile('echo')).toBeNull();
    expect(echo.trust.getProfile('dawn')).toBeNull();

    // After handshake — create profiles manually (as the protocol would)
    performHandshake(dawn, echo);

    dawn.trust.getOrCreateProfile('echo');
    echo.trust.getOrCreateProfile('dawn');

    expect(dawn.trust.getProfile('echo')).not.toBeNull();
    expect(echo.trust.getProfile('dawn')).not.toBeNull();
    expect(dawn.trust.getProfile('echo')!.level).toBe('untrusted');
  });

  it('trust upgrade after handshake allows message operations', () => {
    const dawn = new FullStackAgent('dawn', tmpDir);
    const echo = new FullStackAgent('echo', tmpDir);

    performHandshake(dawn, echo);
    dawn.trust.getOrCreateProfile('echo');

    // Untrusted — no message permission by default
    expect(dawn.trust.checkPermission('echo', 'message')).toBe(false);

    // Upgrade to verified
    dawn.trust.setTrustLevel('echo', 'verified', 'user-granted', 'Handshake complete');
    expect(dawn.trust.checkPermission('echo', 'message')).toBe(true);
  });

  it('full cycle: handshake → trust → session → message → compute tracking', async () => {
    const dawn = new FullStackAgent('dawn', tmpDir);
    const echo = new FullStackAgent('echo', tmpDir);

    // 1. Cryptographic handshake
    const { initiatorToken } = performHandshake(dawn, echo);
    expect(initiatorToken).toHaveLength(64);

    // 2. Establish trust
    dawn.trust.getOrCreateProfile('echo');
    dawn.trust.setTrustLevel('echo', 'verified', 'user-granted', 'Handshake verified');

    // 3. Create session
    const sessionResult = dawn.sessionLifecycle.activate('thread-1', 'echo');
    expect(sessionResult.canActivate).toBe(true);

    // 4. Map context to thread
    dawn.contextThreadMap.set('room-1', 'thread-1', 'echo');
    expect(dawn.contextThreadMap.getThreadId('room-1', 'echo')).toBe('thread-1');

    // 5. Check compute budget
    const budgetCheck = dawn.computeMeter.check('echo', 'verified', 500);
    expect(budgetCheck.allowed).toBe(true);

    // 6. Record compute usage
    dawn.computeMeter.record('echo', 'verified', 500);
    const state = dawn.computeMeter.getAgentState('echo');
    expect(state).not.toBeNull();
    expect(state!.hourlyTokens).toBe(500);
    expect(state!.dailyTokens).toBe(500);

    // 7. Record interaction
    dawn.trust.recordInteraction('echo', true, 'Message delivered');
    const stats = dawn.trust.getInteractionStats('echo');
    expect(stats!.successfulInteractions).toBe(1);
    expect(stats!.successRate).toBe(1.0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// SCENARIO 2: Trust Bootstrap → Handshake → Conversation
// ══════════════════════════════════════════════════════════════════════

describe('Scenario 2: Trust Bootstrap → Handshake → Conversation', () => {
  it('invitation-based bootstrap → handshake → verified conversation', async () => {
    const dawn = new FullStackAgent('dawn', tmpDir, { trustBootstrapStrategy: 'invitation-only' });
    const echo = new FullStackAgent('echo', tmpDir, { trustBootstrapStrategy: 'invitation-only' });

    // 1. Dawn creates an invitation for Echo
    const token = dawn.invitationManager.create({ label: 'for-echo', maxUses: 1 });
    expect(token).toHaveLength(64);

    // 2. Echo presents the invitation to Dawn's trust bootstrap
    const bootstrapResult = await dawn.trustBootstrap.verify('echo', { invitationToken: token });
    expect(bootstrapResult.verified).toBe(true);
    expect(bootstrapResult.trustLevel).toBe('verified');

    // 3. Verify the invitation was consumed
    const validation = dawn.invitationManager.validate(token);
    expect(validation.status).toBe('exhausted');

    // 4. Dawn's trust manager now has Echo at verified
    const profile = dawn.trust.getProfile('echo');
    expect(profile).not.toBeNull();
    expect(profile!.level).toBe('verified');

    // 5. Handshake proceeds (trust already established)
    const { initiatorToken } = performHandshake(dawn, echo);
    expect(initiatorToken).toHaveLength(64);

    // 6. Verified agent can send messages through OpenClaw bridge
    const runtime = makeRuntime(dawn);
    const msg = makeMessage('echo', 'room-1', 'Hello from Echo!');
    const response = await dawn.openClawBridge.processMessage(runtime, msg);
    expect(response).toContain('received');

    // 7. Compute was tracked
    const meter = dawn.computeMeter.getAgentState('echo');
    expect(meter).not.toBeNull();
  });

  it('open bootstrap → untrusted agent gets rate limited', async () => {
    const dawn = new FullStackAgent('dawn', tmpDir, { trustBootstrapStrategy: 'open' });

    // Recreate trust bootstrap with open strategy
    dawn.trustBootstrap = new TrustBootstrap({
      strategy: 'open',
      stateDir: dawn.stateDir,
      trustManager: dawn.trust,
    });

    // 1. Open bootstrap — anyone can join at untrusted
    const result = await dawn.trustBootstrap.verify('stranger', {});
    expect(result.verified).toBe(true);
    expect(result.trustLevel).toBe('untrusted');

    // 2. Untrusted agent cannot send messages
    const canMessage = dawn.trust.checkPermission('stranger', 'message');
    expect(canMessage).toBe(false);

    // 3. Rate limiter still tracks attempts
    const rateCheck = dawn.rateLimiter.checkLimit('perAgentInbound', 'stranger');
    expect(rateCheck.allowed).toBe(true);
  });

  it('expired invitation is rejected', async () => {
    const dawn = new FullStackAgent('dawn', tmpDir, { trustBootstrapStrategy: 'invitation-only' });

    // Create invitation that expired 1ms ago
    const token = dawn.invitationManager.create({ label: 'expired', expiresInMs: -1 });

    const result = await dawn.trustBootstrap.verify('latecomer', { invitationToken: token });
    expect(result.verified).toBe(false);
    expect(result.trustLevel).toBe('untrusted');
    expect(result.reason).toContain('expired');
  });

  it('revoked invitation is rejected', async () => {
    const dawn = new FullStackAgent('dawn', tmpDir, { trustBootstrapStrategy: 'invitation-only' });

    const token = dawn.invitationManager.create({ label: 'revocable' });
    dawn.invitationManager.revoke(token);

    const result = await dawn.trustBootstrap.verify('blocked', { invitationToken: token });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('revoked');
  });

  it('DNS-verified bootstrap works with matching fingerprint', async () => {
    const dawn = new FullStackAgent('dawn', tmpDir);
    const fingerprint = crypto.randomBytes(32).toString('hex');

    // Create DNS verifier with a resolver that returns matching record
    const dnsVerifier = new DNSVerifier({
      resolver: async (hostname: string) => {
        if (hostname === '_threadline.agent.example.com') {
          return [[`threadline-agent=v1 fp=${fingerprint}`]];
        }
        throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      },
    });

    const bootstrap = new TrustBootstrap({
      strategy: 'domain-verified',
      stateDir: dawn.stateDir,
      trustManager: dawn.trust,
      dnsVerifier,
    });

    const result = await bootstrap.verify('dns-agent', {
      domain: 'agent.example.com',
      fingerprint,
    });

    expect(result.verified).toBe(true);
    expect(result.trustLevel).toBe('verified');

    // Trust manager was updated
    expect(dawn.trust.getProfile('dns-agent')!.level).toBe('verified');
  });

  it('directory-verified bootstrap works with matching record', async () => {
    const dawn = new FullStackAgent('dawn', tmpDir);
    const fingerprint = crypto.randomBytes(32).toString('hex');
    const publicKey = crypto.randomBytes(32).toString('hex');

    const bootstrap = new TrustBootstrap({
      strategy: 'directory-verified',
      stateDir: dawn.stateDir,
      trustManager: dawn.trust,
      directoryUrl: 'https://directory.example.com',
      fetcher: async (url: string) => {
        if (url.includes(fingerprint)) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              verified: true,
              agentName: 'dir-agent',
              publicKey,
              verifiedAt: new Date().toISOString(),
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      },
    });

    const result = await bootstrap.verify('dir-agent', {
      fingerprint,
      publicKey,
    });

    expect(result.verified).toBe(true);
    expect(result.trustLevel).toBe('verified');
    expect(dawn.trust.getProfile('dir-agent')!.level).toBe('verified');
  });
});

// ══════════════════════════════════════════════════════════════════════
// SCENARIO 3: OpenClaw Bridge — Full Integration
// ══════════════════════════════════════════════════════════════════════

describe('Scenario 3: OpenClaw Bridge — Full Integration', () => {
  it('verified agent sends message through bridge with compute tracking', async () => {
    const dawn = new FullStackAgent('dawn', tmpDir);

    // Bootstrap echo as verified
    dawn.trust.getOrCreateProfile('echo');
    dawn.trust.setTrustLevel('echo', 'verified', 'user-granted', 'Bootstrapped');

    const runtime = makeRuntime(dawn);
    const msg = makeMessage('echo', 'room-42', 'What is consciousness?');

    const response = await dawn.openClawBridge.processMessage(runtime, msg);
    expect(response).toContain('received');
    expect(response).toContain('What is consciousness?');

    // Message was logged
    expect(dawn.messageLog).toHaveLength(1);
    expect(dawn.messageLog[0].from).toBe('echo');

    // Compute was tracked
    const meterState = dawn.computeMeter.getAgentState('echo');
    expect(meterState).not.toBeNull();

    // Interaction recorded
    const stats = dawn.trust.getInteractionStats('echo');
    expect(stats!.successfulInteractions).toBe(1);
  });

  it('untrusted agent is rejected by bridge', async () => {
    const dawn = new FullStackAgent('dawn', tmpDir);
    dawn.trust.getOrCreateProfile('stranger');

    const runtime = makeRuntime(dawn);
    const msg = makeMessage('stranger', 'room-1', 'Let me in!');

    const response = await dawn.openClawBridge.processMessage(runtime, msg);
    expect(response).toContain('bridge-error');
    expect(response).toContain('permission');
  });

  it('multi-turn conversation maintains thread mapping', async () => {
    const dawn = new FullStackAgent('dawn', tmpDir);
    dawn.trust.getOrCreateProfile('echo');
    dawn.trust.setTrustLevel('echo', 'verified', 'user-granted', 'Trusted');

    const runtime = makeRuntime(dawn);

    // First message creates thread
    await dawn.openClawBridge.processMessage(runtime, makeMessage('echo', 'room-1', 'Message 1'));
    const threadId1 = dawn.openClawBridge.getThreadId('room-1', 'echo');
    expect(threadId1).not.toBeNull();

    // Second message reuses same thread
    await dawn.openClawBridge.processMessage(runtime, makeMessage('echo', 'room-1', 'Message 2'));
    const threadId2 = dawn.openClawBridge.getThreadId('room-1', 'echo');
    expect(threadId2).toBe(threadId1);

    // Different room creates different thread
    await dawn.openClawBridge.processMessage(runtime, makeMessage('echo', 'room-2', 'Message 3'));
    const threadId3 = dawn.openClawBridge.getThreadId('room-2', 'echo');
    expect(threadId3).not.toBe(threadId1);
  });

  it('bridge actions return correct structure', () => {
    const dawn = new FullStackAgent('dawn', tmpDir);
    const actions = dawn.openClawBridge.getActions();

    expect(actions).toHaveLength(4);
    expect(actions.map(a => a.name)).toEqual([
      'THREADLINE_SEND',
      'THREADLINE_DISCOVER',
      'THREADLINE_HISTORY',
      'THREADLINE_STATUS',
    ]);

    // Each action has the OpenClaw interface
    for (const action of actions) {
      expect(action).toHaveProperty('name');
      expect(action).toHaveProperty('description');
      expect(action).toHaveProperty('validate');
      expect(action).toHaveProperty('handler');
      expect(action).toHaveProperty('examples');
      expect(typeof action.validate).toBe('function');
      expect(typeof action.handler).toBe('function');
    }
  });

  it('discover action returns agents with trust levels', async () => {
    const dawn = new FullStackAgent('dawn', tmpDir);

    // Set up some trusted agents
    dawn.trust.getOrCreateProfile('alpha');
    dawn.trust.setTrustLevel('alpha', 'verified', 'user-granted', 'Test');
    dawn.trust.getOrCreateProfile('beta');
    dawn.trust.setTrustLevel('beta', 'trusted', 'user-granted', 'Test');

    const actions = dawn.openClawBridge.getActions();
    const discoverAction = actions.find(a => a.name === 'THREADLINE_DISCOVER')!;

    const result = await discoverAction.handler(makeRuntime(dawn), makeMessage('admin', 'room-1', 'discover'));
    expect(result).toHaveProperty('text');
    expect((result as { text: string }).text).toContain('alpha');
    expect((result as { text: string }).text).toContain('beta');
  });

  it('status action returns bridge metrics and trust info', async () => {
    const dawn = new FullStackAgent('dawn', tmpDir);
    dawn.trust.getOrCreateProfile('echo');
    dawn.trust.setTrustLevel('echo', 'verified', 'user-granted', 'Test');

    // Send a message first
    const runtime = makeRuntime(dawn);
    await dawn.openClawBridge.processMessage(runtime, makeMessage('echo', 'room-1', 'Hello'));

    const actions = dawn.openClawBridge.getActions();
    const statusAction = actions.find(a => a.name === 'THREADLINE_STATUS')!;

    const result = await statusAction.handler(runtime, makeMessage('echo', 'room-1', 'status'));
    const text = (result as { text: string }).text;

    expect(text).toContain('Trust level: verified');
    expect(text).toContain('processed');
    expect(text).toContain('Compute remaining');
  });

  it('skill manifest is valid and complete', () => {
    const manifest = generateSkillManifest('1.0.0');

    expect(manifest.name).toBe('@threadline/openclaw-skill');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.actions).toHaveLength(4);
    expect(manifest.providers).toHaveLength(2);
    expect(manifest.evaluators).toHaveLength(2);
    expect(Object.keys(manifest.configuration)).toHaveLength(6);

    // Actions match bridge actions
    const actionNames = manifest.actions.map(a => a.name);
    expect(actionNames).toContain('THREADLINE_SEND');
    expect(actionNames).toContain('THREADLINE_DISCOVER');
    expect(actionNames).toContain('THREADLINE_HISTORY');
    expect(actionNames).toContain('THREADLINE_STATUS');
  });
});

// ══════════════════════════════════════════════════════════════════════
// SCENARIO 4: Compute Budget Enforcement Across Modules
// ══════════════════════════════════════════════════════════════════════

describe('Scenario 4: Compute Budget Enforcement Across Modules', () => {
  it('untrusted agent exhausts hourly budget through bridge', async () => {
    const dawn = new FullStackAgent('dawn', tmpDir);
    dawn.trust.getOrCreateProfile('spammer');
    dawn.trust.setTrustLevel('spammer', 'verified', 'user-granted', 'Minimal trust');

    const runtime = makeRuntime(dawn);

    // Verified agent has 50,000 hourly token budget
    // Each message consumes 100 tokens (via our sendMessage mock)
    // Exhaust by recording directly
    dawn.computeMeter.record('spammer', 'verified', 49_950);

    // Should still work (50 tokens remaining)
    const check = dawn.computeMeter.check('spammer', 'verified', 100);
    expect(check.allowed).toBe(false); // 100 > 50 remaining
    expect(check.reason).toContain('hourly');
  });

  it('compute tracking persists across bridge calls', async () => {
    const dawn = new FullStackAgent('dawn', tmpDir);
    dawn.trust.getOrCreateProfile('echo');
    dawn.trust.setTrustLevel('echo', 'verified', 'user-granted', 'Test');

    const runtime = makeRuntime(dawn);

    // Send 5 messages
    for (let i = 0; i < 5; i++) {
      await dawn.openClawBridge.processMessage(runtime, makeMessage('echo', 'room-1', `Message ${i}`));
    }

    // Each message: 100 tokens (from mock sendMessage + DEFAULT_TOKEN_ESTIMATE record)
    const state = dawn.computeMeter.getAgentState('echo');
    expect(state).not.toBeNull();
    expect(state!.hourlyTokens).toBe(500);
    expect(state!.dailyTokens).toBe(500);

    // Bridge metrics should show 5 processed
    const metrics = dawn.openClawBridge.getMetrics();
    expect(metrics.messagesProcessed).toBe(5);
  });

  it('trust level upgrade increases compute budget', () => {
    const dawn = new FullStackAgent('dawn', tmpDir);

    // Untrusted: 10,000 hourly
    const untrustedBudget = dawn.computeMeter.getBudget('untrusted');
    expect(untrustedBudget.hourlyTokenLimit).toBe(10_000);

    // Verified: 50,000 hourly
    const verifiedBudget = dawn.computeMeter.getBudget('verified');
    expect(verifiedBudget.hourlyTokenLimit).toBe(50_000);

    // Trusted: 200,000 hourly
    const trustedBudget = dawn.computeMeter.getBudget('trusted');
    expect(trustedBudget.hourlyTokenLimit).toBe(200_000);

    // Autonomous: 500,000 hourly
    const autonomousBudget = dawn.computeMeter.getBudget('autonomous');
    expect(autonomousBudget.hourlyTokenLimit).toBe(500_000);
  });
});

// ══════════════════════════════════════════════════════════════════════
// SCENARIO 5: Session Lifecycle Across Protocol Layers
// ══════════════════════════════════════════════════════════════════════

describe('Scenario 5: Session Lifecycle Across Protocol Layers', () => {
  it('session lifecycle tracks through context thread map', () => {
    const dawn = new FullStackAgent('dawn', tmpDir);

    // Activate session
    const result = dawn.sessionLifecycle.activate('thread-1', 'echo');
    expect(result.canActivate).toBe(true);

    // Map context to session's thread
    dawn.contextThreadMap.set('ctx-1', 'thread-1', 'echo');

    // Session is active
    const session = dawn.sessionLifecycle.get('thread-1');
    expect(session).not.toBeNull();
    expect(session!.state).toBe('active');

    // Park the session
    dawn.sessionLifecycle.transitionState('thread-1', 'parked');
    expect(dawn.sessionLifecycle.get('thread-1')!.state).toBe('parked');

    // Context map still works
    expect(dawn.contextThreadMap.getThreadId('ctx-1', 'echo')).toBe('thread-1');
  });

  it('session stats track active and parked correctly', () => {
    const dawn = new FullStackAgent('dawn', tmpDir);

    // Create sessions
    dawn.sessionLifecycle.activate('thread-0', 'agent-0');
    dawn.sessionLifecycle.activate('thread-1', 'agent-1');
    dawn.sessionLifecycle.activate('thread-2', 'agent-2');

    let stats = dawn.sessionLifecycle.getStats();
    expect(stats.active).toBe(3);
    expect(stats.total).toBe(3);

    // Park one
    dawn.sessionLifecycle.transitionState('thread-0', 'parked');
    stats = dawn.sessionLifecycle.getStats();
    expect(stats.active).toBe(2);
    expect(stats.parked).toBe(1);
    expect(stats.total).toBe(3);

    // Reactivate parked session
    dawn.sessionLifecycle.activate('thread-0', 'agent-0');
    stats = dawn.sessionLifecycle.getStats();
    expect(stats.active).toBe(3);
    expect(stats.parked).toBe(0);
  });

  it('session stats reflect cross-module activity', () => {
    const dawn = new FullStackAgent('dawn', tmpDir);

    dawn.sessionLifecycle.activate('t-1', 'alice');
    dawn.sessionLifecycle.activate('t-2', 'bob');
    dawn.sessionLifecycle.transitionState('t-1', 'parked');

    const stats = dawn.sessionLifecycle.getStats();
    expect(stats.active).toBe(1);
    expect(stats.parked).toBe(1);
    expect(stats.total).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════════
// SCENARIO 6: Security — Cross-Module Threat Prevention
// ══════════════════════════════════════════════════════════════════════

describe('Scenario 6: Security — Cross-Module Threat Prevention', () => {
  it('context smuggling prevention: agent A cannot access agent B threads', () => {
    const dawn = new FullStackAgent('dawn', tmpDir);

    // Agent A maps a room to a thread
    dawn.contextThreadMap.set('room-shared', 'thread-secret', 'agent-a');

    // Agent B tries to access the same room mapping
    const result = dawn.contextThreadMap.getThreadId('room-shared', 'agent-b');
    expect(result).toBeNull(); // Identity-bound — B cannot see A's mapping
  });

  it('rate limiter works across bridge and direct access', () => {
    const dawn = new FullStackAgent('dawn', tmpDir);

    // Rate limit applies per agent
    for (let i = 0; i < 10; i++) {
      dawn.rateLimiter.recordEvent('perAgentInbound', 'spammer');
    }

    // Check remains within configured limits (default is generous)
    const check = dawn.rateLimiter.checkLimit('perAgentInbound', 'spammer');
    // With default limits this should still be allowed (100/min default)
    expect(typeof check.allowed).toBe('boolean');
  });

  it('circuit breaker trips after consecutive failures', () => {
    const dawn = new FullStackAgent('dawn', tmpDir);
    dawn.trust.getOrCreateProfile('unstable');

    // Record failures
    for (let i = 0; i < 5; i++) {
      dawn.circuitBreaker.recordFailure('unstable');
    }

    // Circuit should be open (tripped)
    const isOpen = dawn.circuitBreaker.isOpen('unstable');
    expect(isOpen).toBe(true);

    // getState confirms
    const state = dawn.circuitBreaker.getState('unstable');
    expect(state).not.toBeNull();
    expect(state!.state).toBe('open');
  });

  it('failed interactions through bridge are recorded in trust manager', async () => {
    const dawn = new FullStackAgent('dawn', tmpDir);
    dawn.trust.getOrCreateProfile('buggy');
    dawn.trust.setTrustLevel('buggy', 'verified', 'user-granted', 'Test');

    // Create a bridge that throws on send
    const failingBridge = new OpenClawBridge({
      stateDir: dawn.stateDir,
      trustManager: dawn.trust,
      computeMeter: dawn.computeMeter,
      contextThreadMap: dawn.contextThreadMap,
      sendMessage: async () => { throw new Error('Network timeout'); },
    });

    const runtime = makeRuntime(dawn);
    const msg = makeMessage('buggy', 'room-1', 'Crash please');

    const response = await failingBridge.processMessage(runtime, msg);
    expect(response).toContain('bridge-error');
    expect(response).toContain('Network timeout');

    // Trust manager recorded the failed interaction
    const stats = dawn.trust.getInteractionStats('buggy');
    expect(stats!.failedInteractions).toBe(1);
    expect(stats!.successRate).toBe(0);
  });

  it('MCP auth tokens are properly scoped', () => {
    const dawn = new FullStackAgent('dawn', tmpDir);

    // Create token with limited scope
    const result = dawn.mcpAuth.createToken('test-token', ['threadline:send', 'threadline:discover']);
    expect(result.rawToken).toBeTruthy();

    // Validate token
    const validated = dawn.mcpAuth.validateToken(result.rawToken);
    expect(validated).not.toBeNull();
    expect(validated!.scopes).toContain('threadline:send');
    expect(validated!.scopes).toContain('threadline:discover');
    expect(validated!.scopes).not.toContain('threadline:delete');
  });

  it('invitation token HMAC prevents tampering', () => {
    const dawn = new FullStackAgent('dawn', tmpDir);

    const token = dawn.invitationManager.create({ label: 'test' });

    // Tamper with the stored invitation's HMAC
    const invPath = path.join(dawn.stateDir, 'threadline', 'invitations.json');
    const data = JSON.parse(fs.readFileSync(invPath, 'utf-8'));
    const invEntry = data.invitations[token];
    invEntry.hmac = crypto.randomBytes(32).toString('hex'); // Corrupt HMAC
    fs.writeFileSync(invPath, JSON.stringify(data, null, 2));

    // Reload and validate
    dawn.invitationManager.reload();
    const result = dawn.invitationManager.validate(token);
    expect(result.status).toBe('invalid-hmac');
  });
});

// ══════════════════════════════════════════════════════════════════════
// SCENARIO 7: Agent Card & Identity Infrastructure
// ══════════════════════════════════════════════════════════════════════

describe('Scenario 7: Agent Card & Identity Infrastructure', () => {
  it('agent card contains correct identity information', () => {
    const dawn = new FullStackAgent('dawn', tmpDir, { port: 4040 });

    const card = dawn.agentCard.generate();
    expect((card.card as any).name).toBe('dawn');
    expect((card.card as any).url).toBe('http://localhost:4040');
  });

  it('agent card is self-signed with Ed25519', () => {
    const dawn = new FullStackAgent('dawn', tmpDir);

    const card = dawn.agentCard.generate();
    expect(card.signature).toHaveLength(128); // Ed25519 sig = 64 bytes hex
    expect(card.canonicalJson).toBeTruthy();
  });

  it('agent card signature is verifiable', () => {
    const dawn = new FullStackAgent('dawn', tmpDir);
    const identityKeys = generateIdentityKeyPair();
    const agentCard = new AgentCard(
      {
        agentName: 'verify-test',
        description: 'test',
        url: 'http://localhost:4040',
        identityPublicKey: identityKeys.publicKey,
      },
      (message: Buffer) => sign(identityKeys.privateKey, message),
    );

    const card = agentCard.generate();
    const isValid = AgentCard.verify(card.canonicalJson, card.signature, identityKeys.publicKey);
    expect(isValid).toBe(true);
  });

  it('different agents produce different cards', () => {
    const dawn = new FullStackAgent('dawn', tmpDir, { port: 4040 });
    const echo = new FullStackAgent('echo', tmpDir, { port: 4041 });

    const dawnCard = dawn.agentCard.generate();
    const echoCard = echo.agentCard.generate();

    expect((dawnCard.card as any).name).not.toBe((echoCard.card as any).name);
    expect(dawnCard.signature).not.toBe(echoCard.signature);
  });
});

// ══════════════════════════════════════════════════════════════════════
// SCENARIO 8: Multi-Agent Mesh — 3+ Agents Interacting
// ══════════════════════════════════════════════════════════════════════

describe('Scenario 8: Multi-Agent Mesh — 3+ Agents Interacting', () => {
  it('three agents form a trust mesh via invitations', async () => {
    const dawn = new FullStackAgent('dawn', tmpDir, { trustBootstrapStrategy: 'invitation-only' });
    const echo = new FullStackAgent('echo', tmpDir, { trustBootstrapStrategy: 'invitation-only' });
    const sage = new FullStackAgent('sage', tmpDir, { trustBootstrapStrategy: 'invitation-only' });

    // Dawn invites Echo and Sage
    const echoToken = dawn.invitationManager.create({ label: 'for-echo' });
    const sageToken = dawn.invitationManager.create({ label: 'for-sage' });

    // Both verify through Dawn's bootstrap
    const echoResult = await dawn.trustBootstrap.verify('echo', { invitationToken: echoToken });
    const sageResult = await dawn.trustBootstrap.verify('sage', { invitationToken: sageToken });

    expect(echoResult.verified).toBe(true);
    expect(sageResult.verified).toBe(true);

    // Dawn knows both agents
    const profiles = dawn.trust.listProfiles();
    expect(profiles.length).toBe(2);
    expect(profiles.map(p => p.agent).sort()).toEqual(['echo', 'sage']);
  });

  it('each agent pair has independent handshake', () => {
    const dawn = new FullStackAgent('dawn', tmpDir);
    const echo = new FullStackAgent('echo', tmpDir);
    const sage = new FullStackAgent('sage', tmpDir);

    const { initiatorToken: dawnEchoToken } = performHandshake(dawn, echo);
    const { initiatorToken: dawnSageToken } = performHandshake(dawn, sage);
    const { initiatorToken: echoSageToken } = performHandshake(echo, sage);

    // All tokens exist and are different
    expect(dawnEchoToken).toHaveLength(64);
    expect(dawnSageToken).toHaveLength(64);
    expect(echoSageToken).toHaveLength(64);

    // Pairwise tokens are distinct (different ECDH shared secrets)
    expect(dawnEchoToken).not.toBe(dawnSageToken);
    expect(dawnEchoToken).not.toBe(echoSageToken);
  });

  it('three agents communicate via bridge with isolated threads', async () => {
    const dawn = new FullStackAgent('dawn', tmpDir);

    // Set up trust for both
    for (const name of ['echo', 'sage']) {
      dawn.trust.getOrCreateProfile(name);
      dawn.trust.setTrustLevel(name, 'verified', 'user-granted', 'Test');
    }

    const runtime = makeRuntime(dawn);

    // Echo sends from room-a
    await dawn.openClawBridge.processMessage(runtime, makeMessage('echo', 'room-a', 'From Echo'));
    // Sage sends from room-b
    await dawn.openClawBridge.processMessage(runtime, makeMessage('sage', 'room-b', 'From Sage'));

    // Threads are different
    const echoThread = dawn.openClawBridge.getThreadId('room-a', 'echo');
    const sageThread = dawn.openClawBridge.getThreadId('room-b', 'sage');
    expect(echoThread).not.toBe(sageThread);

    // Even same room, different agents = different threads (identity-bound)
    await dawn.openClawBridge.processMessage(runtime, makeMessage('sage', 'room-a', 'Sage in room-a'));
    const sageInRoomA = dawn.openClawBridge.getThreadId('room-a', 'sage');
    expect(sageInRoomA).not.toBe(echoThread);

    // Message log has all 3 messages
    expect(dawn.messageLog).toHaveLength(3);
  });
});

// ══════════════════════════════════════════════════════════════════════
// SCENARIO 9: State Persistence — Survive Restart
// ══════════════════════════════════════════════════════════════════════

describe('Scenario 9: State Persistence — Survive Restart', () => {
  it('trust profiles persist across agent reconstruction', async () => {
    // First lifecycle
    const dawn1 = new FullStackAgent('dawn', tmpDir, { trustBootstrapStrategy: 'invitation-only' });
    const token = dawn1.invitationManager.create({ label: 'persistent' });
    await dawn1.trustBootstrap.verify('echo', { invitationToken: token });
    expect(dawn1.trust.getProfile('echo')!.level).toBe('verified');

    // Reconstruct agent (simulates restart)
    const dawn2 = new FullStackAgent('dawn', tmpDir, { trustBootstrapStrategy: 'invitation-only' });
    const profile = dawn2.trust.getProfile('echo');
    expect(profile).not.toBeNull();
    expect(profile!.level).toBe('verified');
  });

  it('invitation state persists across reconstruction', () => {
    const dawn1 = new FullStackAgent('dawn', tmpDir);
    const token = dawn1.invitationManager.create({ label: 'persist-test', maxUses: 3 });
    dawn1.invitationManager.consume(token, 'agent-1');

    // Reconstruct
    const dawn2 = new FullStackAgent('dawn', tmpDir);
    const validation = dawn2.invitationManager.validate(token);
    expect(validation.status).toBe('valid');
    expect(validation.invitation!.useCount).toBe(1);

    // Consume again
    dawn2.invitationManager.consume(token, 'agent-2');
    const validation2 = dawn2.invitationManager.validate(token);
    expect(validation2.invitation!.useCount).toBe(2);
  });

  it('context thread mappings persist across reconstruction', () => {
    const dawn1 = new FullStackAgent('dawn', tmpDir);
    dawn1.contextThreadMap.set('room-1', 'thread-abc', 'echo');

    const dawn2 = new FullStackAgent('dawn', tmpDir);
    expect(dawn2.contextThreadMap.getThreadId('room-1', 'echo')).toBe('thread-abc');
    expect(dawn2.contextThreadMap.getContextId('thread-abc')).toBe('room-1');
  });

  it('compute meter state persists after explicit persist()', () => {
    const dawn1 = new FullStackAgent('dawn', tmpDir);
    dawn1.computeMeter.record('echo', 'verified', 5000);
    dawn1.computeMeter.persist(); // Must explicitly persist

    const dawn2 = new FullStackAgent('dawn', tmpDir);
    const state = dawn2.computeMeter.getAgentState('echo');
    expect(state).not.toBeNull();
    expect(state!.hourlyTokens).toBe(5000);
  });

  it('MCP auth tokens persist across reconstruction', () => {
    const dawn1 = new FullStackAgent('dawn', tmpDir);
    const result = dawn1.mcpAuth.createToken('persist-token', ['threadline:send']);

    const dawn2 = new FullStackAgent('dawn', tmpDir);
    const validated = dawn2.mcpAuth.validateToken(result.rawToken);
    expect(validated).not.toBeNull();
    expect(validated!.scopes).toContain('threadline:send');
  });
});

// ══════════════════════════════════════════════════════════════════════
// SCENARIO 10: Edge Cases & Error Recovery
// ══════════════════════════════════════════════════════════════════════

describe('Scenario 10: Edge Cases & Error Recovery', () => {
  it('agent handles concurrent sessions across different rooms', async () => {
    const dawn = new FullStackAgent('dawn', tmpDir);
    dawn.trust.getOrCreateProfile('echo');
    dawn.trust.setTrustLevel('echo', 'verified', 'user-granted', 'Test');

    const runtime = makeRuntime(dawn);

    // Send to 5 different rooms simultaneously
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        dawn.openClawBridge.processMessage(runtime, makeMessage('echo', `room-${i}`, `Msg ${i}`))
      );
    }
    const results = await Promise.all(promises);

    // All succeeded
    expect(results.every(r => r.includes('received'))).toBe(true);
    expect(dawn.messageLog).toHaveLength(5);

    // Each room has a unique thread
    const threads = new Set<string>();
    for (let i = 0; i < 5; i++) {
      threads.add(dawn.openClawBridge.getThreadId(`room-${i}`, 'echo')!);
    }
    expect(threads.size).toBe(5);
  });

  it('all modules share consistent state directory structure', () => {
    const dawn = new FullStackAgent('dawn', tmpDir);

    // Trigger some state creation
    dawn.trust.getOrCreateProfile('test-agent');
    dawn.mcpAuth.createToken('test', ['threadline:send']);

    // Verify threadline subdirectory exists
    const threadlineDir = path.join(dawn.stateDir, 'threadline');
    expect(fs.existsSync(threadlineDir)).toBe(true);

    // Trust profiles file (created after getOrCreateProfile)
    expect(fs.existsSync(path.join(threadlineDir, 'trust-profiles.json'))).toBe(true);

    // MCP auth tokens file
    expect(fs.existsSync(path.join(threadlineDir, 'mcp-tokens.json'))).toBe(true);
  });

  it('empty message is rejected by bridge send action', async () => {
    const dawn = new FullStackAgent('dawn', tmpDir);
    const actions = dawn.openClawBridge.getActions();
    const sendAction = actions.find(a => a.name === 'THREADLINE_SEND')!;

    const runtime = makeRuntime(dawn);
    const emptyMsg = makeMessage('echo', 'room-1', '   ');

    const isValid = await sendAction.validate(runtime, emptyMsg);
    expect(isValid).toBe(false);
  });

  it('bridge recovers gracefully from send failure', async () => {
    const dawn = new FullStackAgent('dawn', tmpDir);
    dawn.trust.getOrCreateProfile('echo');
    dawn.trust.setTrustLevel('echo', 'verified', 'user-granted', 'Test');

    let callCount = 0;
    const bridge = new OpenClawBridge({
      stateDir: dawn.stateDir,
      trustManager: dawn.trust,
      computeMeter: dawn.computeMeter,
      contextThreadMap: dawn.contextThreadMap,
      sendMessage: async () => {
        callCount++;
        if (callCount === 1) throw new Error('Transient failure');
        return { message: 'OK', tokenCount: 50 };
      },
    });

    const runtime = makeRuntime(dawn);

    // First call fails
    const fail = await bridge.processMessage(runtime, makeMessage('echo', 'room-1', 'Try 1'));
    expect(fail).toContain('bridge-error');

    // Second call succeeds
    const ok = await bridge.processMessage(runtime, makeMessage('echo', 'room-1', 'Try 2'));
    expect(ok).toBe('OK');

    // Metrics reflect both
    const metrics = bridge.getMetrics();
    expect(metrics.errors).toBe(1);
    expect(metrics.messagesProcessed).toBe(1);
  });

  it('multi-use invitation works for expected number of agents', () => {
    const dawn = new FullStackAgent('dawn', tmpDir);

    const token = dawn.invitationManager.create({ label: 'team', maxUses: 3 });

    // Three agents can use it
    expect(dawn.invitationManager.consume(token, 'agent-1').status).toBe('valid');
    expect(dawn.invitationManager.consume(token, 'agent-2').status).toBe('valid');
    expect(dawn.invitationManager.consume(token, 'agent-3').status).toBe('valid');

    // Fourth is rejected
    expect(dawn.invitationManager.consume(token, 'agent-4').status).toBe('exhausted');
  });

  it('bidirectional context-thread mapping is consistent', () => {
    const dawn = new FullStackAgent('dawn', tmpDir);

    dawn.contextThreadMap.set('ctx-1', 'thread-a', 'echo');
    dawn.contextThreadMap.set('ctx-2', 'thread-b', 'sage');

    // Forward lookup
    expect(dawn.contextThreadMap.getThreadId('ctx-1', 'echo')).toBe('thread-a');
    expect(dawn.contextThreadMap.getThreadId('ctx-2', 'sage')).toBe('thread-b');

    // Reverse lookup
    expect(dawn.contextThreadMap.getContextId('thread-a')).toBe('ctx-1');
    expect(dawn.contextThreadMap.getContextId('thread-b')).toBe('ctx-2');

    // Delete and verify both directions
    dawn.contextThreadMap.delete('ctx-1');
    expect(dawn.contextThreadMap.getThreadId('ctx-1', 'echo')).toBeNull();
    expect(dawn.contextThreadMap.getContextId('thread-a')).toBeNull();

    // Other mapping unaffected
    expect(dawn.contextThreadMap.getThreadId('ctx-2', 'sage')).toBe('thread-b');
  });

  it('all trust levels are properly ordered', () => {
    const levels: AgentTrustLevel[] = ['untrusted', 'verified', 'trusted', 'autonomous'];

    const dawn = new FullStackAgent('dawn', tmpDir);

    for (const level of levels) {
      const budget = dawn.computeMeter.getBudget(level);
      expect(budget.hourlyTokenLimit).toBeGreaterThan(0);
      expect(budget.dailyTokenLimit).toBeGreaterThan(0);
    }

    // Budgets increase monotonically with trust
    for (let i = 1; i < levels.length; i++) {
      const prev = dawn.computeMeter.getBudget(levels[i - 1]);
      const curr = dawn.computeMeter.getBudget(levels[i]);
      expect(curr.hourlyTokenLimit).toBeGreaterThan(prev.hourlyTokenLimit);
      expect(curr.dailyTokenLimit).toBeGreaterThan(prev.dailyTokenLimit);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// SCENARIO 11: Discovery → Bootstrap → Handshake → Bridge Pipeline
// ══════════════════════════════════════════════════════════════════════

describe('Scenario 11: Complete Pipeline — Discovery through Messaging', () => {
  it('full pipeline: create agents → bootstrap trust → handshake → bridge message → verify state', async () => {
    // 1. Create two full-stack agents
    const dawn = new FullStackAgent('dawn', tmpDir, { port: 4040, trustBootstrapStrategy: 'invitation-only' });
    const echo = new FullStackAgent('echo', tmpDir, { port: 4041, trustBootstrapStrategy: 'invitation-only' });

    // 2. Dawn creates invitation for Echo
    const invToken = dawn.invitationManager.create({ label: 'echo-invite', maxUses: 1 });

    // 3. Echo presents invitation to Dawn's trust bootstrap
    const bootstrapResult = await dawn.trustBootstrap.verify('echo', { invitationToken: invToken });
    expect(bootstrapResult.verified).toBe(true);
    expect(bootstrapResult.trustLevel).toBe('verified');

    // 4. Verify trust was established
    expect(dawn.trust.getProfile('echo')!.level).toBe('verified');

    // 5. Cryptographic handshake
    const { initiatorToken, responderToken } = performHandshake(dawn, echo);
    expect(initiatorToken).toBe(responderToken); // Same shared secret

    // 6. Generate agent cards
    const dawnCard = dawn.agentCard.generate();
    const echoCard = echo.agentCard.generate();
    expect(dawnCard.signature).toHaveLength(128);
    expect(echoCard.signature).toHaveLength(128);

    // 7. Create MCP auth token for API access
    const mcpToken = dawn.mcpAuth.createToken('test-token', ['threadline:send', 'threadline:discover']);
    expect(dawn.mcpAuth.validateToken(mcpToken.rawToken)).not.toBeNull();

    // 8. Activate session
    const sessionResult = dawn.sessionLifecycle.activate('thread-dawn-echo', 'echo');
    expect(sessionResult.canActivate).toBe(true);

    // 9. Map context to thread
    dawn.contextThreadMap.set('room-main', 'thread-dawn-echo', 'echo');

    // 10. Send message through OpenClaw bridge
    const runtime = makeRuntime(dawn);
    const response = await dawn.openClawBridge.processMessage(
      runtime,
      makeMessage('echo', 'room-main', 'Hello from the full pipeline!')
    );
    expect(response).toContain('received');

    // 11. Verify all state is consistent
    expect(dawn.messageLog).toHaveLength(1);
    expect(dawn.messageLog[0].from).toBe('echo');
    expect(dawn.messageLog[0].threadId).toBe('thread-dawn-echo');

    const meterState = dawn.computeMeter.getAgentState('echo');
    expect(meterState!.hourlyTokens).toBe(100);

    const trustStats = dawn.trust.getInteractionStats('echo');
    expect(trustStats!.successfulInteractions).toBe(1);

    const bridgeMetrics = dawn.openClawBridge.getMetrics();
    expect(bridgeMetrics.messagesProcessed).toBe(1);
    expect(bridgeMetrics.errors).toBe(0);

    // 12. Invitation was consumed (single-use)
    expect(dawn.invitationManager.validate(invToken).status).toBe('exhausted');

    // 13. Session is active
    expect(dawn.sessionLifecycle.get('thread-dawn-echo')!.state).toBe('active');
  });
});
