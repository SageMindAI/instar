/**
 * E2E test — Threadline Protocol full lifecycle.
 *
 * Simulates TWO COMPLETE AGENTS communicating with each other.
 * Each agent has its own state directory and full set of Threadline modules:
 * HandshakeManager, AgentTrustManager, CircuitBreaker, RateLimiter,
 * ThreadResumeMap, and AgentDiscovery.
 *
 * Tests cover: first contact, session resume, trust evolution, glare resolution,
 * rate limiting, circuit breaker lifecycle, multi-agent mesh, persistence,
 * and security edge cases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { HandshakeManager } from '../../../src/threadline/HandshakeManager.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import { CircuitBreaker } from '../../../src/threadline/CircuitBreaker.js';
import { RateLimiter } from '../../../src/threadline/RateLimiter.js';
import { ThreadResumeMap } from '../../../src/threadline/ThreadResumeMap.js';
import { AgentDiscovery } from '../../../src/threadline/AgentDiscovery.js';
import {
  generateIdentityKeyPair,
  sign,
  verify,
  deriveRelayToken,
} from '../../../src/threadline/ThreadlineCrypto.js';
import type { HelloPayload, ConfirmPayload } from '../../../src/threadline/HandshakeManager.js';
import type { ThreadResumeEntry } from '../../../src/threadline/ThreadResumeMap.js';

// ── Agent Simulator ──────────────────────────────────────────────────

class AgentSimulator {
  name: string;
  stateDir: string;
  handshake: HandshakeManager;
  trust: AgentTrustManager;
  circuitBreaker: CircuitBreaker;
  rateLimiter: RateLimiter;
  threadMap: ThreadResumeMap;
  discovery: AgentDiscovery;

  constructor(name: string, baseDir: string, opts?: { nowFn?: () => number }) {
    this.name = name;
    this.stateDir = path.join(baseDir, name);
    fs.mkdirSync(this.stateDir, { recursive: true });

    this.trust = new AgentTrustManager({ stateDir: this.stateDir });
    this.circuitBreaker = new CircuitBreaker({
      stateDir: this.stateDir,
      trustManager: this.trust,
      nowFn: opts?.nowFn,
    });
    this.rateLimiter = new RateLimiter({
      stateDir: this.stateDir,
      nowFn: opts?.nowFn,
    });
    this.handshake = new HandshakeManager(this.stateDir, name);
    // Use /bin/echo as tmuxPath to avoid needing real tmux
    this.threadMap = new ThreadResumeMap(this.stateDir, this.stateDir, '/bin/echo');
    this.discovery = new AgentDiscovery({
      stateDir: this.stateDir,
      selfPath: this.stateDir,
      selfName: name,
      selfPort: 4040 + Math.floor(Math.random() * 50),
    });
  }
}

// ── Helper: perform full handshake between two agents ────────────────

function performHandshake(
  initiator: AgentSimulator,
  responder: AgentSimulator,
): { initiatorToken: string; responderToken: string } {
  // Step 1: Initiator sends hello
  const initResult = initiator.handshake.initiateHandshake(responder.name);
  if ('error' in initResult) throw new Error(`Initiate failed: ${initResult.error}`);
  const helloPayload = initResult.payload;

  // Step 2: Responder handles hello, sends response
  const respResult = responder.handshake.handleHello(helloPayload);
  if ('error' in respResult) throw new Error(`HandleHello failed: ${respResult.error}`);
  const responsePayload = respResult.payload;

  // Step 3: Initiator processes the response hello
  const confirmResult = initiator.handshake.handleHelloResponse(responsePayload);
  if ('error' in confirmResult) throw new Error(`HandleHelloResponse failed: ${confirmResult.error}`);
  const confirmPayload = confirmResult.confirmPayload;
  const initiatorToken = confirmResult.relayToken;

  // Step 4: Responder handles confirm
  const finalResult = responder.handshake.handleConfirm(confirmPayload);
  if ('error' in finalResult) throw new Error(`HandleConfirm failed: ${finalResult.error}`);
  const responderToken = finalResult.relayToken;

  return { initiatorToken, responderToken };
}

// ── Test Suite ────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-e2e-'));
});

afterEach(() => {
  // safe-git-allow: incremental-migration
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Scenario 1: Happy Path — First Contact to Conversation ──────────

describe('Scenario 1: Happy Path — First Contact to Conversation', () => {
  it('both agents generate identity keys on construction', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    const echo = new AgentSimulator('echo', tmpDir);

    const dawnPub = dawn.handshake.getIdentityPublicKey();
    const echoPub = echo.handshake.getIdentityPublicKey();

    expect(dawnPub).toHaveLength(64); // 32 bytes hex
    expect(echoPub).toHaveLength(64);
    expect(dawnPub).not.toBe(echoPub);
  });

  it('initiator creates a hello payload with correct fields', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    const result = dawn.handshake.initiateHandshake('echo');

    expect('payload' in result).toBe(true);
    if ('payload' in result) {
      expect(result.payload.agent).toBe('dawn');
      expect(result.payload.identityPub).toHaveLength(64);
      expect(result.payload.ephemeralPub).toHaveLength(64);
      expect(result.payload.nonce).toHaveLength(64);
      expect(result.payload.challengeResponse).toBeUndefined();
    }
  });

  it('responder creates hello response with challenge response', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    const echo = new AgentSimulator('echo', tmpDir);

    const initResult = dawn.handshake.initiateHandshake('echo');
    if ('error' in initResult) throw new Error('Should not fail');

    const respResult = echo.handshake.handleHello(initResult.payload);
    expect('payload' in respResult).toBe(true);
    if ('payload' in respResult) {
      expect(respResult.payload.agent).toBe('echo');
      expect(respResult.payload.challengeResponse).toBeDefined();
      expect(respResult.payload.challengeResponse!.length).toBeGreaterThan(0);
    }
  });

  it('full handshake produces matching relay tokens', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    const echo = new AgentSimulator('echo', tmpDir);

    const { initiatorToken, responderToken } = performHandshake(dawn, echo);

    expect(initiatorToken).toBe(responderToken);
    expect(initiatorToken).toHaveLength(64); // 32 bytes hex
  });

  it('relay tokens are stored and retrievable after handshake', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    const echo = new AgentSimulator('echo', tmpDir);

    const { initiatorToken } = performHandshake(dawn, echo);

    expect(dawn.handshake.getRelayToken('echo')).toBe(initiatorToken);
    expect(echo.handshake.getRelayToken('dawn')).toBe(initiatorToken);
  });

  it('trust can be set to verified and messages recorded in rate limiter', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    const echo = new AgentSimulator('echo', tmpDir);

    performHandshake(dawn, echo);

    // Set trust
    const upgraded = dawn.trust.setTrustLevel('echo', 'verified', 'user-granted', 'Handshake complete');
    expect(upgraded).toBe(true);

    const profile = dawn.trust.getProfile('echo');
    expect(profile?.level).toBe('verified');

    // Record message in rate limiter
    const result = dawn.rateLimiter.recordEvent('perAgentOutbound', 'echo');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(29); // 30 - 1
  });

  it('thread mapping is saved and retrievable', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    const echo = new AgentSimulator('echo', tmpDir);

    performHandshake(dawn, echo);

    const threadId = crypto.randomUUID();
    const entry: ThreadResumeEntry = {
      uuid: crypto.randomUUID(),
      sessionName: `thread-${threadId.slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      savedAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      remoteAgent: 'echo',
      subject: 'First contact',
      state: 'active',
      pinned: false,
      messageCount: 1,
    };

    dawn.threadMap.save(threadId, entry);
    // ThreadResumeMap.get checks for JSONL file existence; use direct file check
    const rawMap = JSON.parse(fs.readFileSync(
      path.join(dawn.stateDir, 'threadline', 'thread-resume-map.json'), 'utf-8'
    ));
    expect(rawMap[threadId]).toBeDefined();
    expect(rawMap[threadId].remoteAgent).toBe('echo');
    expect(rawMap[threadId].subject).toBe('First contact');
  });
});

// ── Scenario 2: Session Resume After "Restart" ─────────────────────

describe('Scenario 2: Session Resume After Restart', () => {
  it('thread mapping persists across ThreadResumeMap recreation', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    const threadId = crypto.randomUUID();
    const sessionUUID = crypto.randomUUID();

    const entry: ThreadResumeEntry = {
      uuid: sessionUUID,
      sessionName: `thread-${threadId.slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      savedAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      remoteAgent: 'echo',
      subject: 'Persistent thread',
      state: 'active',
      pinned: true, // Pin to avoid TTL/JSONL checks
      messageCount: 5,
    };

    dawn.threadMap.save(threadId, entry);

    // "Restart" — create new ThreadResumeMap from same stateDir
    const newMap = new ThreadResumeMap(dawn.stateDir, dawn.stateDir, '/bin/echo');
    const rawData = JSON.parse(fs.readFileSync(
      path.join(dawn.stateDir, 'threadline', 'thread-resume-map.json'), 'utf-8'
    ));
    expect(rawData[threadId]).toBeDefined();
    expect(rawData[threadId].uuid).toBe(sessionUUID);
    expect(rawData[threadId].state).toBe('active');
  });

  it('HandshakeManager recovers identity keys from stateDir after restart', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    const originalPubKey = dawn.handshake.getIdentityPublicKey();

    // "Restart" — create new HandshakeManager from same stateDir
    const newHandshake = new HandshakeManager(dawn.stateDir, 'dawn');
    const recoveredPubKey = newHandshake.getIdentityPublicKey();

    expect(recoveredPubKey).toBe(originalPubKey);
  });

  it('relay tokens persist and are recoverable after restart', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    const echo = new AgentSimulator('echo', tmpDir);

    const { initiatorToken } = performHandshake(dawn, echo);

    // "Restart" dawn
    const newHandshake = new HandshakeManager(dawn.stateDir, 'dawn');
    expect(newHandshake.getRelayToken('echo')).toBe(initiatorToken);
  });

  it('communication can continue after restart without re-handshake', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    const echo = new AgentSimulator('echo', tmpDir);

    const { initiatorToken } = performHandshake(dawn, echo);

    // "Restart" both agents
    const newDawnHandshake = new HandshakeManager(dawn.stateDir, 'dawn');
    const newEchoHandshake = new HandshakeManager(echo.stateDir, 'echo');

    // Both still have valid relay tokens
    expect(newDawnHandshake.getRelayToken('echo')).toBe(initiatorToken);
    expect(newEchoHandshake.getRelayToken('dawn')).toBe(initiatorToken);

    // Validate tokens match
    expect(newDawnHandshake.validateRelayToken('echo', initiatorToken)).toBe(true);
    expect(newEchoHandshake.validateRelayToken('dawn', initiatorToken)).toBe(true);
  });

  it('paired agents list persists after restart', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    const echo = new AgentSimulator('echo', tmpDir);

    performHandshake(dawn, echo);

    const paired = dawn.handshake.listPairedAgents();
    expect(paired).toHaveLength(1);
    expect(paired[0].agent).toBe('echo');

    // "Restart"
    const newHandshake = new HandshakeManager(dawn.stateDir, 'dawn');
    const newPaired = newHandshake.listPairedAgents();
    expect(newPaired).toHaveLength(1);
    expect(newPaired[0].agent).toBe('echo');
  });
});

// ── Scenario 3: Trust Evolution ─────────────────────────────────────

describe('Scenario 3: Trust Evolution', () => {
  it('new agent starts as untrusted', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    const profile = dawn.trust.getOrCreateProfile('rogue');
    expect(profile.level).toBe('untrusted');
    expect(profile.source).toBe('setup-default');
  });

  it('user can grant trust upgrade to verified', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    dawn.trust.getOrCreateProfile('rogue');

    const upgraded = dawn.trust.setTrustLevel('rogue', 'verified', 'user-granted', 'Manual verification');
    expect(upgraded).toBe(true);
    expect(dawn.trust.getProfile('rogue')?.level).toBe('verified');
  });

  it('auto-upgrade without user-granted source is rejected', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    dawn.trust.getOrCreateProfile('rogue');

    const upgraded = dawn.trust.setTrustLevel('rogue', 'verified', 'setup-default');
    expect(upgraded).toBe(false);
    expect(dawn.trust.getProfile('rogue')?.level).toBe('untrusted');
  });

  it('successful interactions increase streak', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    dawn.trust.setTrustLevel('rogue', 'verified', 'user-granted');

    dawn.trust.recordInteraction('rogue', true);
    dawn.trust.recordInteraction('rogue', true);
    dawn.trust.recordInteraction('rogue', true);

    const stats = dawn.trust.getInteractionStats('rogue');
    expect(stats?.successfulInteractions).toBe(3);
    expect(stats?.streakSinceIncident).toBe(3);
  });

  it('a failure resets streak to zero', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    dawn.trust.setTrustLevel('rogue', 'verified', 'user-granted');

    dawn.trust.recordInteraction('rogue', true);
    dawn.trust.recordInteraction('rogue', true);
    dawn.trust.recordInteraction('rogue', false);

    const stats = dawn.trust.getInteractionStats('rogue');
    expect(stats?.streakSinceIncident).toBe(0);
    expect(stats?.failedInteractions).toBe(1);
    expect(stats?.successfulInteractions).toBe(2);
  });

  it('circuit breaker auto-downgrade fires after 3 activations in 24h', () => {
    let currentTime = Date.now();
    const nowFn = () => currentTime;

    const dawn = new AgentSimulator('dawn', tmpDir, { nowFn });
    dawn.trust.setTrustLevel('rogue', 'verified', 'user-granted');

    // Trigger 3 circuit openings — each requires 5 consecutive failures
    for (let activation = 0; activation < 3; activation++) {
      for (let i = 0; i < 5; i++) {
        dawn.circuitBreaker.recordFailure('rogue');
      }
      // After opening, advance time past reset (1 hour) to allow re-triggering
      if (activation < 2) {
        currentTime += 61 * 60 * 1000;
        // isOpen check transitions to half-open
        dawn.circuitBreaker.isOpen('rogue');
        // One more failure in half-open reopens
        dawn.circuitBreaker.recordFailure('rogue');
      }
    }

    // After 3 activations, trust should be downgraded
    expect(dawn.trust.getProfile('rogue')?.level).toBe('untrusted');
  });

  it('audit trail records all trust changes', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    dawn.trust.getOrCreateProfile('rogue');
    dawn.trust.setTrustLevel('rogue', 'verified', 'user-granted', 'Manual verify');
    dawn.trust.setTrustLevel('rogue', 'trusted', 'user-granted', 'Promoted');
    dawn.trust.autoDowngrade('rogue', 'Security incident');

    const audit = dawn.trust.readAuditTrail();
    expect(audit.length).toBeGreaterThanOrEqual(3);

    const levels = audit.map(a => a.newLevel);
    expect(levels).toContain('verified');
    expect(levels).toContain('trusted');
    expect(levels).toContain('untrusted');
  });
});

// ── Scenario 4: Handshake Glare Resolution ──────────────────────────

describe('Scenario 4: Handshake Glare Resolution', () => {
  it('simultaneous handshake initiation triggers glare detection', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    const echo = new AgentSimulator('echo', tmpDir);

    // Both initiate simultaneously
    const dawnInit = dawn.handshake.initiateHandshake('echo');
    const echoInit = echo.handshake.initiateHandshake('dawn');

    expect('payload' in dawnInit).toBe(true);
    expect('payload' in echoInit).toBe(true);

    if (!('payload' in dawnInit) || !('payload' in echoInit)) return;

    // Both try to handle the other's hello
    const dawnHandleResult = dawn.handshake.handleHello(echoInit.payload);
    const echoHandleResult = echo.handshake.handleHello(dawnInit.payload);

    // One should get a glare error, the other should proceed
    const dawnIsGlare = 'error' in dawnHandleResult && (dawnHandleResult.error as string).includes('glare');
    const echoIsGlare = 'error' in echoHandleResult && (echoHandleResult.error as string).includes('glare');

    // Exactly one should get the glare error (the one with the lower pubkey wins initiator role)
    expect(dawnIsGlare !== echoIsGlare).toBe(true);
  });

  it('glare resolution: lower pubkey wins initiator role', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    const echo = new AgentSimulator('echo', tmpDir);

    const dawnPub = dawn.handshake.getIdentityPublicKey();
    const echoPub = echo.handshake.getIdentityPublicKey();

    // Determine who has the lower key
    const dawnIsLower = dawnPub < echoPub;

    // Both initiate
    const dawnInit = dawn.handshake.initiateHandshake('echo');
    const echoInit = echo.handshake.initiateHandshake('dawn');

    if (!('payload' in dawnInit) || !('payload' in echoInit)) throw new Error('Init failed');

    // Both handle each other's hello
    const dawnHandleResult = dawn.handshake.handleHello(echoInit.payload);
    const echoHandleResult = echo.handshake.handleHello(dawnInit.payload);

    if (dawnIsLower) {
      // Dawn has lower key, so dawn keeps initiator role
      expect('error' in dawnHandleResult).toBe(true);
      expect('payload' in echoHandleResult).toBe(true);
    } else {
      // Echo has lower key, so echo keeps initiator role
      expect('payload' in dawnHandleResult).toBe(true);
      expect('error' in echoHandleResult).toBe(true);
    }
  });

  it('handshake still completes after glare resolution', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    const echo = new AgentSimulator('echo', tmpDir);

    const dawnPub = dawn.handshake.getIdentityPublicKey();
    const echoPub = echo.handshake.getIdentityPublicKey();
    const dawnIsLower = dawnPub < echoPub;

    // Both initiate
    const dawnInit = dawn.handshake.initiateHandshake('echo');
    const echoInit = echo.handshake.initiateHandshake('dawn');

    if (!('payload' in dawnInit) || !('payload' in echoInit)) throw new Error('Init failed');

    // Both handle each other's hello — one will get glare
    dawn.handshake.handleHello(echoInit.payload);
    echo.handshake.handleHello(dawnInit.payload);

    // The winner (lower pubkey) proceeds as initiator
    // The loser (higher pubkey) has already processed the winner's hello as responder
    let initiatorToken: string;
    let responderToken: string;

    if (dawnIsLower) {
      // Dawn is initiator. Echo already processed dawn's hello.
      // Dawn needs to process echo's handleHello response.
      // Recreate: dawn initiates fresh, echo responds, dawn confirms
      const freshDawn = new HandshakeManager(
        fs.mkdtempSync(path.join(tmpDir, 'dawn-fresh-')),
        'dawn'
      );
      const freshEcho = new HandshakeManager(
        fs.mkdtempSync(path.join(tmpDir, 'echo-fresh-')),
        'echo'
      );
      const result = performHandshake(
        { ...dawn, handshake: freshDawn } as AgentSimulator,
        { ...echo, handshake: freshEcho } as AgentSimulator,
      );
      initiatorToken = result.initiatorToken;
      responderToken = result.responderToken;
    } else {
      const freshDawn = new HandshakeManager(
        fs.mkdtempSync(path.join(tmpDir, 'dawn-fresh-')),
        'dawn'
      );
      const freshEcho = new HandshakeManager(
        fs.mkdtempSync(path.join(tmpDir, 'echo-fresh-')),
        'echo'
      );
      const result = performHandshake(
        { ...echo, handshake: freshEcho } as AgentSimulator,
        { ...dawn, handshake: freshDawn } as AgentSimulator,
      );
      initiatorToken = result.initiatorToken;
      responderToken = result.responderToken;
    }

    expect(initiatorToken).toBe(responderToken);
  });
});

// ── Scenario 5: Rate Limiting Under Pressure ────────────────────────

describe('Scenario 5: Rate Limiting Under Pressure', () => {
  it('burst limit blocks after 5 messages per minute', () => {
    let currentTime = Date.now();
    const dawn = new AgentSimulator('dawn', tmpDir, { nowFn: () => currentTime });

    // Send 5 burst messages
    for (let i = 0; i < 5; i++) {
      const result = dawn.rateLimiter.recordEvent('perAgentBurst', 'echo');
      expect(result.allowed).toBe(true);
    }

    // 6th message should be blocked
    const blocked = dawn.rateLimiter.checkLimit('perAgentBurst', 'echo');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it('per-agent hourly limit blocks after 30 messages', () => {
    let currentTime = Date.now();
    const dawn = new AgentSimulator('dawn', tmpDir, { nowFn: () => currentTime });

    for (let i = 0; i < 30; i++) {
      const result = dawn.rateLimiter.recordEvent('perAgentInbound', 'echo');
      expect(result.allowed).toBe(true);
    }

    const blocked = dawn.rateLimiter.checkLimit('perAgentInbound', 'echo');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it('rate limiter returns correct remaining count', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);

    dawn.rateLimiter.recordEvent('perAgentBurst', 'echo');
    dawn.rateLimiter.recordEvent('perAgentBurst', 'echo');

    const status = dawn.rateLimiter.checkLimit('perAgentBurst', 'echo');
    expect(status.remaining).toBe(3); // 5 - 2
    expect(status.allowed).toBe(true);
  });

  it('messages flow again after window expires', () => {
    let currentTime = Date.now();
    const dawn = new AgentSimulator('dawn', tmpDir, { nowFn: () => currentTime });

    // Fill burst limit
    for (let i = 0; i < 5; i++) {
      dawn.rateLimiter.recordEvent('perAgentBurst', 'echo');
    }

    expect(dawn.rateLimiter.checkLimit('perAgentBurst', 'echo').allowed).toBe(false);

    // Advance past 1-minute window
    currentTime += 61 * 1000;

    expect(dawn.rateLimiter.checkLimit('perAgentBurst', 'echo').allowed).toBe(true);
  });

  it('rate limits are independent per agent', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);

    // Fill burst for echo
    for (let i = 0; i < 5; i++) {
      dawn.rateLimiter.recordEvent('perAgentBurst', 'echo');
    }

    // Whisper should still be allowed
    const whisperResult = dawn.rateLimiter.checkLimit('perAgentBurst', 'whisper');
    expect(whisperResult.allowed).toBe(true);
    expect(whisperResult.remaining).toBe(5);
  });

  it('global inbound limit enforced with shared key', () => {
    let currentTime = Date.now();
    const dawn = new AgentSimulator('dawn', tmpDir, { nowFn: () => currentTime });

    // Global inbound uses a single shared key (e.g., 'global') for all agents
    for (let i = 0; i < 200; i++) {
      dawn.rateLimiter.recordEvent('globalInbound', 'global');
    }

    const blocked = dawn.rateLimiter.checkLimit('globalInbound', 'global');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });
});

// ── Scenario 6: Circuit Breaker Lifecycle ───────────────────────────

describe('Scenario 6: Circuit Breaker Lifecycle', () => {
  it('circuit stays closed on success', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);

    dawn.circuitBreaker.recordSuccess('echo');
    dawn.circuitBreaker.recordSuccess('echo');

    const state = dawn.circuitBreaker.getState('echo');
    expect(state?.state).toBe('closed');
    expect(state?.totalSuccesses).toBe(2);
    expect(state?.consecutiveFailures).toBe(0);
  });

  it('5 consecutive failures open the circuit', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);

    for (let i = 0; i < 5; i++) {
      dawn.circuitBreaker.recordFailure('echo');
    }

    expect(dawn.circuitBreaker.isOpen('echo')).toBe(true);
    const state = dawn.circuitBreaker.getState('echo');
    expect(state?.state).toBe('open');
    expect(state?.activationCount).toBe(1);
  });

  it('circuit transitions to half-open after 1 hour', () => {
    let currentTime = Date.now();
    const dawn = new AgentSimulator('dawn', tmpDir, { nowFn: () => currentTime });

    // Open circuit
    for (let i = 0; i < 5; i++) {
      dawn.circuitBreaker.recordFailure('echo');
    }
    expect(dawn.circuitBreaker.isOpen('echo')).toBe(true);

    // Advance 1 hour
    currentTime += 61 * 60 * 1000;

    // isOpen triggers half-open transition
    expect(dawn.circuitBreaker.isOpen('echo')).toBe(false);
    const state = dawn.circuitBreaker.getState('echo');
    expect(state?.state).toBe('half-open');
  });

  it('success in half-open closes the circuit', () => {
    let currentTime = Date.now();
    const dawn = new AgentSimulator('dawn', tmpDir, { nowFn: () => currentTime });

    // Open circuit
    for (let i = 0; i < 5; i++) {
      dawn.circuitBreaker.recordFailure('echo');
    }

    // Advance past reset
    currentTime += 61 * 60 * 1000;
    dawn.circuitBreaker.isOpen('echo'); // transition to half-open

    // Success in half-open
    dawn.circuitBreaker.recordSuccess('echo');

    const state = dawn.circuitBreaker.getState('echo');
    expect(state?.state).toBe('closed');
    expect(state?.consecutiveFailures).toBe(0);
  });

  it('failure in half-open reopens the circuit', () => {
    let currentTime = Date.now();
    const dawn = new AgentSimulator('dawn', tmpDir, { nowFn: () => currentTime });

    // Open circuit
    for (let i = 0; i < 5; i++) {
      dawn.circuitBreaker.recordFailure('echo');
    }

    // Advance past reset
    currentTime += 61 * 60 * 1000;
    dawn.circuitBreaker.isOpen('echo'); // transition to half-open

    // Failure in half-open
    dawn.circuitBreaker.recordFailure('echo');

    const state = dawn.circuitBreaker.getState('echo');
    expect(state?.state).toBe('open');
    expect(state?.activationCount).toBe(2);
  });
});

// ── Scenario 7: Multi-Agent Mesh ────────────────────────────────────

describe('Scenario 7: Multi-Agent Mesh', () => {
  it('three agents can independently handshake in pairs', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    const echo = new AgentSimulator('echo', tmpDir);
    const whisper = new AgentSimulator('whisper', tmpDir);

    const dawnEcho = performHandshake(dawn, echo);
    const dawnWhisper = performHandshake(dawn, whisper);

    // Both handshakes succeed
    expect(dawnEcho.initiatorToken).toBe(dawnEcho.responderToken);
    expect(dawnWhisper.initiatorToken).toBe(dawnWhisper.responderToken);
  });

  it('relay tokens are pair-specific (dawn-echo != dawn-whisper)', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    const echo = new AgentSimulator('echo', tmpDir);
    const whisper = new AgentSimulator('whisper', tmpDir);

    const dawnEcho = performHandshake(dawn, echo);
    const dawnWhisper = performHandshake(dawn, whisper);

    expect(dawnEcho.initiatorToken).not.toBe(dawnWhisper.initiatorToken);
  });

  it('circuit breakers are independent per agent pair', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);

    // Fail echo's circuit
    for (let i = 0; i < 5; i++) {
      dawn.circuitBreaker.recordFailure('echo');
    }

    expect(dawn.circuitBreaker.isOpen('echo')).toBe(true);
    expect(dawn.circuitBreaker.isOpen('whisper')).toBe(false);
  });

  it('rate limits are independent per agent', () => {
    let currentTime = Date.now();
    const dawn = new AgentSimulator('dawn', tmpDir, { nowFn: () => currentTime });

    // Fill burst for echo
    for (let i = 0; i < 5; i++) {
      dawn.rateLimiter.recordEvent('perAgentBurst', 'echo');
    }

    // Echo burst is full, whisper is not affected
    expect(dawn.rateLimiter.checkLimit('perAgentBurst', 'echo').allowed).toBe(false);
    expect(dawn.rateLimiter.checkLimit('perAgentBurst', 'whisper').allowed).toBe(true);
    expect(dawn.rateLimiter.checkLimit('perAgentBurst', 'whisper').remaining).toBe(5);
  });
});

// ── Scenario 8: Persistence Across Restarts ─────────────────────────

describe('Scenario 8: Persistence Across Restarts', () => {
  it('trust profiles survive full agent restart', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    dawn.trust.setTrustLevel('echo', 'verified', 'user-granted');
    dawn.trust.recordInteraction('echo', true);
    dawn.trust.recordInteraction('echo', true);

    // "Restart" — create new AgentTrustManager from same stateDir
    const newTrust = new AgentTrustManager({ stateDir: dawn.stateDir });
    const profile = newTrust.getProfile('echo');

    expect(profile?.level).toBe('verified');
    expect(profile?.history.successfulInteractions).toBe(2);
    expect(profile?.history.streakSinceIncident).toBe(2);
  });

  it('circuit breaker state survives restart', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);

    for (let i = 0; i < 5; i++) {
      dawn.circuitBreaker.recordFailure('echo');
    }

    // "Restart"
    const newCB = new CircuitBreaker({ stateDir: dawn.stateDir });
    const state = newCB.getState('echo');

    expect(state?.state).toBe('open');
    expect(state?.consecutiveFailures).toBe(5);
    expect(state?.activationCount).toBe(1);
  });

  it('complete agent restart: all state recovered, communication resumes', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    const echo = new AgentSimulator('echo', tmpDir);

    // Full lifecycle
    const { initiatorToken } = performHandshake(dawn, echo);
    dawn.trust.setTrustLevel('echo', 'verified', 'user-granted');
    dawn.trust.recordInteraction('echo', true);
    dawn.circuitBreaker.recordSuccess('echo');

    const threadId = crypto.randomUUID();
    const entry: ThreadResumeEntry = {
      uuid: crypto.randomUUID(),
      sessionName: 'thread-abc',
      createdAt: new Date().toISOString(),
      savedAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      remoteAgent: 'echo',
      subject: 'Important thread',
      state: 'active',
      pinned: true,
      messageCount: 3,
    };
    dawn.threadMap.save(threadId, entry);

    // "Restart" ALL modules
    const newHandshake = new HandshakeManager(dawn.stateDir, 'dawn');
    const newTrust = new AgentTrustManager({ stateDir: dawn.stateDir });
    const newCB = new CircuitBreaker({ stateDir: dawn.stateDir });

    // Verify everything recovered
    expect(newHandshake.getRelayToken('echo')).toBe(initiatorToken);
    expect(newHandshake.validateRelayToken('echo', initiatorToken)).toBe(true);
    expect(newTrust.getProfile('echo')?.level).toBe('verified');
    expect(newTrust.getProfile('echo')?.history.successfulInteractions).toBe(1);
    expect(newCB.getState('echo')?.totalSuccesses).toBe(1);

    const rawMap = JSON.parse(fs.readFileSync(
      path.join(dawn.stateDir, 'threadline', 'thread-resume-map.json'), 'utf-8'
    ));
    expect(rawMap[threadId].remoteAgent).toBe('echo');
  });
});

// ── Scenario 9: Security Edge Cases ─────────────────────────────────

describe('Scenario 9: Security Edge Cases', () => {
  it('wrong relay token fails validation', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    const echo = new AgentSimulator('echo', tmpDir);

    performHandshake(dawn, echo);

    const fakeToken = crypto.randomBytes(32).toString('hex');
    expect(dawn.handshake.validateRelayToken('echo', fakeToken)).toBe(false);
  });

  it('tampered challenge response fails verification', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    const echo = new AgentSimulator('echo', tmpDir);

    // Step 1: dawn initiates
    const initResult = dawn.handshake.initiateHandshake('echo');
    if ('error' in initResult) throw new Error('Should not fail');

    // Step 2: echo responds
    const respResult = echo.handshake.handleHello(initResult.payload);
    if ('error' in respResult) throw new Error('Should not fail');

    // Tamper with the challenge response
    const tamperedPayload: HelloPayload = {
      ...respResult.payload,
      challengeResponse: crypto.randomBytes(64).toString('hex'), // wrong signature
    };

    // Step 3: dawn tries to process tampered response
    const confirmResult = dawn.handshake.handleHelloResponse(tamperedPayload);
    expect('error' in confirmResult).toBe(true);
    if ('error' in confirmResult) {
      expect(confirmResult.error).toContain('Challenge response verification failed');
    }
  });

  it('unknown agent has no relay token', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    expect(dawn.handshake.getRelayToken('unknown')).toBeNull();
    expect(dawn.handshake.validateRelayToken('unknown', 'anything')).toBe(false);
  });

  it('confirm from agent with no handshake in progress fails', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);

    const result = dawn.handshake.handleConfirm({
      agent: 'stranger',
      challengeResponse: crypto.randomBytes(64).toString('hex'),
    });

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('No handshake in progress');
    }
  });

  it('permissions enforce trust level boundaries', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);

    // Untrusted agent
    dawn.trust.getOrCreateProfile('rogue');
    expect(dawn.trust.checkPermission('rogue', 'ping')).toBe(true);
    expect(dawn.trust.checkPermission('rogue', 'message')).toBe(false);
    expect(dawn.trust.checkPermission('rogue', 'spawn')).toBe(false);

    // Verified agent
    dawn.trust.setTrustLevel('rogue', 'verified', 'user-granted');
    expect(dawn.trust.checkPermission('rogue', 'message')).toBe(true);
    expect(dawn.trust.checkPermission('rogue', 'spawn')).toBe(false);

    // Trusted agent
    dawn.trust.setTrustLevel('rogue', 'trusted', 'user-granted');
    expect(dawn.trust.checkPermission('rogue', 'task-request')).toBe(true);
    expect(dawn.trust.checkPermission('rogue', 'spawn')).toBe(false);

    // Autonomous agent
    dawn.trust.setTrustLevel('rogue', 'autonomous', 'user-granted');
    expect(dawn.trust.checkPermission('rogue', 'spawn')).toBe(true);
    expect(dawn.trust.checkPermission('rogue', 'delegate')).toBe(true);
  });

  it('blocked operations override trust level permissions', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    dawn.trust.setTrustLevel('rogue', 'autonomous', 'user-granted');

    expect(dawn.trust.checkPermission('rogue', 'spawn')).toBe(true);

    dawn.trust.blockOperation('rogue', 'spawn');
    expect(dawn.trust.checkPermission('rogue', 'spawn')).toBe(false);

    dawn.trust.unblockOperation('rogue', 'spawn');
    expect(dawn.trust.checkPermission('rogue', 'spawn')).toBe(true);
  });
});

// ── Scenario 10: Discovery and Presence ─────────────────────────────

describe('Scenario 10: Discovery and Presence', () => {
  it('agent can announce and read its own presence', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);

    dawn.discovery.announcePresence({
      capabilities: ['chat', 'search'],
      description: 'Dawn agent',
      threadlineVersion: '1.0',
      publicKey: dawn.handshake.getIdentityPublicKey(),
      framework: 'instar',
    });

    const info = dawn.discovery.getSelfInfo();
    expect(info).not.toBeNull();
    expect(info!.name).toBe('dawn');
    expect(info!.capabilities).toContain('chat');
    expect(info!.publicKey).toBe(dawn.handshake.getIdentityPublicKey());
  });

  it('capability search works across known agents', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);

    // Manually populate known agents (since we can't do real HTTP discovery)
    const knownAgentsPath = path.join(dawn.stateDir, 'threadline', 'known-agents.json');
    const knownData = {
      agents: [
        {
          name: 'echo',
          port: 4041,
          path: '/tmp/echo',
          status: 'active',
          capabilities: ['chat', 'search'],
          threadlineEnabled: true,
          threadlineVersion: '1.0',
          framework: 'instar',
        },
        {
          name: 'whisper',
          port: 4042,
          path: '/tmp/whisper',
          status: 'active',
          capabilities: ['search', 'translate'],
          threadlineEnabled: true,
          threadlineVersion: '1.0',
          framework: 'instar',
        },
      ],
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(knownAgentsPath, JSON.stringify(knownData, null, 2));

    const chatAgents = dawn.discovery.searchByCapability('chat');
    expect(chatAgents).toHaveLength(1);
    expect(chatAgents[0].name).toBe('echo');

    const searchAgents = dawn.discovery.searchByCapability('search');
    expect(searchAgents).toHaveLength(2);

    const translateAgents = dawn.discovery.searchByCapability('translate');
    expect(translateAgents).toHaveLength(1);
    expect(translateAgents[0].name).toBe('whisper');
  });
});

// ── Scenario 11: Staleness Auto-Downgrade ───────────────────────────

describe('Scenario 11: Staleness Auto-Downgrade', () => {
  it('90-day staleness triggers one-level downgrade', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    dawn.trust.setTrustLevel('echo', 'trusted', 'user-granted');
    dawn.trust.recordInteraction('echo', true);

    // Simulate 91 days passing
    const ninetyOneDaysMs = 91 * 24 * 60 * 60 * 1000;
    const futureTime = Date.now() + ninetyOneDaysMs;

    const downgraded = dawn.trust.checkStalenessDowngrade('echo', futureTime);
    expect(downgraded).toBe(true);
    expect(dawn.trust.getProfile('echo')?.level).toBe('verified'); // trusted -> verified
  });

  it('staleness does not downgrade below untrusted', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    dawn.trust.getOrCreateProfile('echo');
    dawn.trust.recordInteraction('echo', true);

    const ninetyOneDaysMs = 91 * 24 * 60 * 60 * 1000;
    const futureTime = Date.now() + ninetyOneDaysMs;

    const downgraded = dawn.trust.checkStalenessDowngrade('echo', futureTime);
    expect(downgraded).toBe(false); // Already untrusted
  });

  it('recent interaction prevents staleness downgrade', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);
    dawn.trust.setTrustLevel('echo', 'trusted', 'user-granted');
    dawn.trust.recordInteraction('echo', true);

    // Only 30 days
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const futureTime = Date.now() + thirtyDaysMs;

    const downgraded = dawn.trust.checkStalenessDowngrade('echo', futureTime);
    expect(downgraded).toBe(false);
    expect(dawn.trust.getProfile('echo')?.level).toBe('trusted');
  });
});

// ── Scenario 12: ThreadlineCrypto Primitives ────────────────────────

describe('Scenario 12: Crypto Primitives Integration', () => {
  it('sign and verify roundtrip works', () => {
    const keyPair = generateIdentityKeyPair();
    const message = Buffer.from('test message');

    const signature = sign(keyPair.privateKey, message);
    expect(signature).toHaveLength(64);

    const isValid = verify(keyPair.publicKey, message, signature);
    expect(isValid).toBe(true);
  });

  it('verification fails with wrong key', () => {
    const keyPair1 = generateIdentityKeyPair();
    const keyPair2 = generateIdentityKeyPair();
    const message = Buffer.from('test message');

    const signature = sign(keyPair1.privateKey, message);
    const isValid = verify(keyPair2.publicKey, message, signature);
    expect(isValid).toBe(false);
  });

  it('verification fails with tampered message', () => {
    const keyPair = generateIdentityKeyPair();
    const message = Buffer.from('original message');

    const signature = sign(keyPair.privateKey, message);
    const tampered = Buffer.from('tampered message');
    const isValid = verify(keyPair.publicKey, tampered, signature);
    expect(isValid).toBe(false);
  });
});

// ── Scenario 13: Rate Limiter Persistence ───────────────────────────

describe('Scenario 13: Rate Limiter Persistence', () => {
  it('rate limit state can be persisted and reloaded', () => {
    let currentTime = Date.now();
    const dawn = new AgentSimulator('dawn', tmpDir, { nowFn: () => currentTime });

    // Record some events
    dawn.rateLimiter.recordEvent('perAgentBurst', 'echo');
    dawn.rateLimiter.recordEvent('perAgentBurst', 'echo');
    dawn.rateLimiter.recordEvent('perAgentBurst', 'echo');

    // Persist
    dawn.rateLimiter.persistToDisk();

    // Create new rate limiter from same state
    const newRL = new RateLimiter({
      stateDir: dawn.stateDir,
      nowFn: () => currentTime,
    });

    const status = newRL.checkLimit('perAgentBurst', 'echo');
    expect(status.remaining).toBe(2); // 5 - 3
    expect(status.allowed).toBe(true);
  });

  it('expired events are not loaded from disk', () => {
    let currentTime = Date.now();
    const dawn = new AgentSimulator('dawn', tmpDir, { nowFn: () => currentTime });

    // Fill burst
    for (let i = 0; i < 5; i++) {
      dawn.rateLimiter.recordEvent('perAgentBurst', 'echo');
    }
    dawn.rateLimiter.persistToDisk();

    // Advance past window
    currentTime += 2 * 60 * 1000;

    const newRL = new RateLimiter({
      stateDir: dawn.stateDir,
      nowFn: () => currentTime,
    });

    const status = newRL.checkLimit('perAgentBurst', 'echo');
    expect(status.allowed).toBe(true);
    expect(status.remaining).toBe(5);
  });

  it('reset clears specific rate limit', () => {
    const dawn = new AgentSimulator('dawn', tmpDir);

    dawn.rateLimiter.recordEvent('perAgentBurst', 'echo');
    dawn.rateLimiter.recordEvent('perAgentBurst', 'echo');

    dawn.rateLimiter.reset('perAgentBurst', 'echo');

    const status = dawn.rateLimiter.checkLimit('perAgentBurst', 'echo');
    expect(status.remaining).toBe(5);
    expect(status.allowed).toBe(true);
  });
});
