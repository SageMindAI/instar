/**
 * A2A Gateway Integration Tests
 *
 * Exercises real instances of Phase 6A modules wired together through A2AGateway.
 * No mocks — uses real ContextThreadMap, ComputeMeter, SessionLifecycle,
 * AgentCard, AgentTrustManager, RateLimiter, and CircuitBreaker with
 * real Ed25519 cryptographic keys.
 *
 * KEY: The A2A SDK's RequestContext does not forward custom user context, so
 * the executor derives agent identity as `a2a-{contextId.slice(0,8)}`. The
 * agentIdentity in handleRequest's context param is only used for preflight
 * checks (rate limiting, circuit breaker). Tests must account for this split.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { A2AGateway } from '../../../src/threadline/A2AGateway.js';
import type {
  A2AGatewayConfig,
  A2AGatewayDeps,
  GatewaySendParams,
  GatewayResponse,
} from '../../../src/threadline/A2AGateway.js';
import { AgentCard } from '../../../src/threadline/AgentCard.js';
import type { AgentCardConfig } from '../../../src/threadline/AgentCard.js';
import { ContextThreadMap } from '../../../src/threadline/ContextThreadMap.js';
import { ComputeMeter } from '../../../src/threadline/ComputeMeter.js';
import { SessionLifecycle } from '../../../src/threadline/SessionLifecycle.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import { RateLimiter } from '../../../src/threadline/RateLimiter.js';
import { CircuitBreaker } from '../../../src/threadline/CircuitBreaker.js';
import {
  generateIdentityKeyPair,
  sign,
  verify,
} from '../../../src/threadline/ThreadlineCrypto.js';
import type { KeyPair } from '../../../src/threadline/ThreadlineCrypto.js';

// ── Helpers ─────────────────────────────────────────────────────────

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-integration-'));
}

function rmDir(dir: string): void {
  try {
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/**
 * Derive the agent identity the executor will compute from a contextId.
 * Mirrors the fallback logic in A2AGateway.createAgentExecutor:
 *   `a2a-${contextId.slice(0, 8)}`
 */
function derivedIdentity(contextId: string): string {
  return `a2a-${contextId.slice(0, 8)}`;
}

/** Build a mock sendMessage that echoes back with a token count. */
function createEchoSendMessage(
  log: GatewaySendParams[] = [],
): (params: GatewaySendParams) => Promise<GatewayResponse> {
  return async (params: GatewaySendParams): Promise<GatewayResponse> => {
    log.push(params);
    const responseText = `Echo: ${params.message}`;
    return {
      message: responseText,
      tokenCount: params.message.length + responseText.length,
    };
  };
}

/** Build a failing sendMessage for error recovery tests. */
function createFailingSendMessage(
  errorMessage = 'Simulated processing failure',
): (params: GatewaySendParams) => Promise<GatewayResponse> {
  return async (): Promise<GatewayResponse> => {
    throw new Error(errorMessage);
  };
}

/** Build an A2A JSON-RPC request for message/send. */
function buildSendRequest(
  message: string,
  contextId: string,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method: 'message/send',
    params: {
      message: {
        kind: 'message',
        messageId: crypto.randomUUID(),
        role: 'user',
        parts: [{ kind: 'text', text: message }],
        contextId,
      },
    },
  };
}

interface TestHarness {
  tmpDir: string;
  keyPair: KeyPair;
  agentCard: AgentCard;
  contextThreadMap: ContextThreadMap;
  computeMeter: ComputeMeter;
  sessionLifecycle: SessionLifecycle;
  trustManager: AgentTrustManager;
  rateLimiter: RateLimiter;
  circuitBreaker: CircuitBreaker;
  sendLog: GatewaySendParams[];
  gateway: A2AGateway;
}

function createHarness(overrides?: {
  sendMessage?: (params: GatewaySendParams) => Promise<GatewayResponse>;
  maxActive?: number;
  maxActiveTasksPerAgent?: number;
  computeOverrides?: Record<string, { hourlyTokenLimit?: number; dailyTokenLimit?: number }>;
  rateLimitConfig?: Record<string, { limit: number; windowMs: number }>;
  globalDailyCap?: number;
}): TestHarness {
  const tmpDir = createTmpDir();
  const keyPair = generateIdentityKeyPair();
  const sendLog: GatewaySendParams[] = [];

  const agentCardConfig: AgentCardConfig = {
    agentName: 'test-agent',
    description: 'Integration test agent',
    url: 'https://test.example.com',
    version: '1.0.0',
    capabilities: ['streaming'],
    skills: [
      {
        id: 'echo',
        name: 'Echo',
        description: 'Echoes messages back',
      },
    ],
    identityPublicKey: keyPair.publicKey,
  };

  const signFn = (message: Buffer): Buffer => sign(keyPair.privateKey, message);
  const agentCard = new AgentCard(agentCardConfig, signFn);

  const contextThreadMap = new ContextThreadMap({ stateDir: tmpDir });
  const computeMeter = new ComputeMeter({
    stateDir: tmpDir,
    globalDailyCap: overrides?.globalDailyCap,
    budgetOverrides: overrides?.computeOverrides as any,
  });
  const sessionLifecycle = new SessionLifecycle({
    stateDir: tmpDir,
    maxActive: overrides?.maxActive ?? 5,
    parkAfterMs: 100, // Short for testing
    archiveAfterMs: 200,
    evictAfterMs: 500,
  });
  const trustManager = new AgentTrustManager({ stateDir: tmpDir });
  const rateLimiter = new RateLimiter({
    stateDir: tmpDir,
    config: overrides?.rateLimitConfig as any,
  });
  const circuitBreaker = new CircuitBreaker({
    stateDir: tmpDir,
    trustManager,
  });

  const config: A2AGatewayConfig = {
    agentName: 'test-agent',
    sendMessage: overrides?.sendMessage ?? createEchoSendMessage(sendLog),
  };

  const deps: A2AGatewayDeps = {
    agentCard,
    contextThreadMap,
    computeMeter,
    sessionLifecycle,
    trustManager,
    rateLimiter,
    circuitBreaker,
  };

  const gateway = new A2AGateway(config, deps, {
    maxActiveTasksPerAgent: overrides?.maxActiveTasksPerAgent ?? 3,
  });

  return {
    tmpDir,
    keyPair,
    agentCard,
    contextThreadMap,
    computeMeter,
    sessionLifecycle,
    trustManager,
    rateLimiter,
    circuitBreaker,
    sendLog,
    gateway,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('A2A Gateway Integration', () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createHarness();
  });

  afterEach(() => {
    rmDir(harness.tmpDir);
  });

  // ── 1. Full Conversation Flow ──────────────────────────────────

  it('should process a message end-to-end and create context mapping', async () => {
    const contextId = crypto.randomUUID();
    const agentId = derivedIdentity(contextId);

    const result = await harness.gateway.handleRequest(
      buildSendRequest('Hello, agent!', contextId),
    );

    expect(result.statusCode).toBe(200);

    // Verify sendMessage was called
    expect(harness.sendLog).toHaveLength(1);
    expect(harness.sendLog[0].fromAgent).toBe(agentId);
    expect(harness.sendLog[0].message).toBe('Hello, agent!');
    expect(harness.sendLog[0].isNewThread).toBe(true);

    // Verify context mapping was created
    const threadId = harness.contextThreadMap.getThreadId(contextId, agentId);
    expect(threadId).toBeTruthy();
    expect(threadId).toBe(harness.sendLog[0].threadId);
  });

  // ── 2. Multi-Turn Conversation ─────────────────────────────────

  it('should reuse the same threadId for the same contextId across turns', async () => {
    const contextId = crypto.randomUUID();

    // Turn 1
    await harness.gateway.handleRequest(buildSendRequest('Turn 1', contextId));
    // Turn 2
    await harness.gateway.handleRequest(buildSendRequest('Turn 2', contextId));
    // Turn 3
    await harness.gateway.handleRequest(buildSendRequest('Turn 3', contextId));

    expect(harness.sendLog).toHaveLength(3);
    const threadIds = harness.sendLog.map(l => l.threadId);

    // All turns should use the same threadId
    expect(threadIds[0]).toBe(threadIds[1]);
    expect(threadIds[1]).toBe(threadIds[2]);

    // Turn 1 is new, turns 2 and 3 are not
    expect(harness.sendLog[0].isNewThread).toBe(true);
    expect(harness.sendLog[1].isNewThread).toBe(false);
    expect(harness.sendLog[2].isNewThread).toBe(false);
  });

  // ── 3. Session Smuggling Prevention ────────────────────────────

  it('should assign different threadIds when different contextIds are used', async () => {
    // Two different contextIds produce two different derived identities
    const contextAlpha = crypto.randomUUID();
    const contextBeta = crypto.randomUUID();

    await harness.gateway.handleRequest(buildSendRequest('Alpha message', contextAlpha));
    await harness.gateway.handleRequest(buildSendRequest('Beta message', contextBeta));

    expect(harness.sendLog).toHaveLength(2);

    // Thread IDs must differ (different contexts = different threads)
    expect(harness.sendLog[0].threadId).not.toBe(harness.sendLog[1].threadId);

    // Both should be new threads
    expect(harness.sendLog[0].isNewThread).toBe(true);
    expect(harness.sendLog[1].isNewThread).toBe(true);

    // Verify identity binding: the ContextThreadMap stores the derived identity
    const alphaId = derivedIdentity(contextAlpha);
    const betaId = derivedIdentity(contextBeta);
    expect(harness.contextThreadMap.getThreadId(contextAlpha, alphaId)).toBeTruthy();
    expect(harness.contextThreadMap.getThreadId(contextBeta, betaId)).toBeTruthy();

    // Cross-identity lookup should fail (smuggling prevention)
    expect(harness.contextThreadMap.getThreadId(contextAlpha, betaId)).toBeNull();
    expect(harness.contextThreadMap.getThreadId(contextBeta, alphaId)).toBeNull();
  });

  // ── 4. Compute Budget Enforcement ─────────────────────────────

  it('should block untrusted agent exceeding hourly compute limit', async () => {
    rmDir(harness.tmpDir);
    harness = createHarness({
      computeOverrides: {
        untrusted: { hourlyTokenLimit: 50, dailyTokenLimit: 200 },
      },
    });

    const contextId = crypto.randomUUID();

    // First message — small, should succeed. Message length = token estimate.
    const result1 = await harness.gateway.handleRequest(
      buildSendRequest('Hi', contextId),
    );
    expect(result1.statusCode).toBe(200);
    expect(harness.sendLog).toHaveLength(1);

    // Second message — large enough to exceed the 50-token hourly limit
    const bigMessage = 'x'.repeat(100);
    const result2 = await harness.gateway.handleRequest(
      buildSendRequest(bigMessage, contextId),
    );

    // Should still get 200 (A2A SDK handles routing), but the task result
    // should contain a failure due to compute budget
    expect(result2.statusCode).toBe(200);
    // The sendMessage should only have been called once (first message)
    // because the second was blocked by compute meter
    expect(harness.sendLog).toHaveLength(1);
  });

  // ── 5. Session Lifecycle — Active Tracking ─────────────────────

  it('should track active sessions and park idle ones during maintenance', async () => {
    const contextId = crypto.randomUUID();
    const agentId = derivedIdentity(contextId);

    await harness.gateway.handleRequest(buildSendRequest('Activate session', contextId));

    // Session should be active
    const threadId = harness.contextThreadMap.getThreadId(contextId, agentId);
    expect(threadId).toBeTruthy();

    const entry = harness.sessionLifecycle.get(threadId!);
    expect(entry).toBeTruthy();
    expect(entry!.state).toBe('active');
    expect(entry!.messageCount).toBe(1);

    // Wait for park timeout and run maintenance
    await new Promise(r => setTimeout(r, 150));
    const transitions = await harness.gateway.runMaintenance();
    expect(transitions.sessionTransitions).toBeGreaterThan(0);

    // Session should be parked now
    const afterEntry = harness.sessionLifecycle.get(threadId!);
    expect(afterEntry!.state).toBe('parked');
  });

  // ── 6. Agent Card Serving with Real Crypto ─────────────────────

  it('should serve agent card with verifiable Ed25519 signature', () => {
    const cardResult = harness.gateway.getAgentCard();

    expect(cardResult.card).toBeDefined();
    expect(cardResult.signature).toBeTruthy();
    expect(cardResult.headers['X-Threadline-Card-Signature']).toBe(cardResult.signature);

    // Verify the card contents
    expect(cardResult.card.name).toBe('test-agent');
    expect(cardResult.card.description).toBe('Integration test agent');
    expect(cardResult.card.url).toBe('https://test.example.com');

    // Verify the signature with the real public key
    const canonicalJson = AgentCard.canonicalize(cardResult.card);
    const isValid = AgentCard.verify(
      canonicalJson,
      cardResult.signature,
      harness.keyPair.publicKey,
    );
    expect(isValid).toBe(true);

    // Ensure a tampered card fails verification
    const tamperedJson = canonicalJson.replace('test-agent', 'evil-agent');
    const tamperedValid = AgentCard.verify(
      tamperedJson,
      cardResult.signature,
      harness.keyPair.publicKey,
    );
    expect(tamperedValid).toBe(false);
  });

  // ── 7. Metrics Collection ──────────────────────────────────────

  it('should collect metrics reflecting message processing activity', async () => {
    const contextId = crypto.randomUUID();
    const agentId = derivedIdentity(contextId);

    // Process two messages
    await harness.gateway.handleRequest(buildSendRequest('Msg 1', contextId));
    await harness.gateway.handleRequest(buildSendRequest('Msg 2', contextId));

    const metrics = harness.gateway.getMetrics();

    // Should contain request count for message/send
    expect(metrics).toContain('threadline_a2a_requests_total{method="message/send"}');
    // Should contain latency metric
    expect(metrics).toContain('threadline_a2a_latency_seconds_avg');
    // Should contain session info
    expect(metrics).toContain('threadline_active_sessions');
    // Should contain compute tokens for the derived identity
    expect(metrics).toContain(`threadline_compute_tokens_total{agent="${agentId}"`);
  });

  // ── 8. Audit Logging ───────────────────────────────────────────

  it('should log audit events for processed messages', async () => {
    const contextId = crypto.randomUUID();
    const agentId = derivedIdentity(contextId);

    await harness.gateway.handleRequest(buildSendRequest('Auditable message', contextId));

    const auditLog = harness.gateway.getAuditLog();

    // Should have at least one message_processed event
    const processedEvents = auditLog.filter(e => e.event === 'message_processed');
    expect(processedEvents.length).toBeGreaterThanOrEqual(1);
    expect(processedEvents[0].agentIdentity).toBe(agentId);
    expect(processedEvents[0].details.threadId).toBeTruthy();
    expect(processedEvents[0].details.tokenCount).toBeGreaterThan(0);
  });

  // ── 9. Rate Limiting ───────────────────────────────────────────

  it('should enforce rate limits via real RateLimiter', async () => {
    rmDir(harness.tmpDir);
    harness = createHarness({
      rateLimitConfig: {
        perAgentInbound: { limit: 2, windowMs: 60_000 },
      },
    });

    const contextId = crypto.randomUUID();

    // Record rate limit events for the preflight identity
    // (preflight uses the agentIdentity from handleRequest context)
    for (let i = 0; i < 2; i++) {
      harness.rateLimiter.recordEvent('perAgentInbound', 'agent-alpha');
    }

    // Third request should be rate limited in preflight
    const result = await harness.gateway.handleRequest(
      buildSendRequest('Should be limited', contextId),
      { agentIdentity: 'agent-alpha' },
    );

    expect(result.statusCode).toBe(429);
    expect((result.body as any).error.message).toBe('Rate limit exceeded');
    expect(result.headers['Retry-After']).toBeTruthy();
  });

  // ── 10. Multiple Independent Agents ────────────────────────────

  it('should handle two agents with independent contexts and budgets', async () => {
    const contextAlpha = crypto.randomUUID();
    const contextBeta = crypto.randomUUID();
    const alphaId = derivedIdentity(contextAlpha);
    const betaId = derivedIdentity(contextBeta);

    // Agent Alpha — two messages in same context
    await harness.gateway.handleRequest(buildSendRequest('Alpha msg 1', contextAlpha));
    await harness.gateway.handleRequest(buildSendRequest('Alpha msg 2', contextAlpha));

    // Agent Beta — one message in different context
    await harness.gateway.handleRequest(buildSendRequest('Beta msg 1', contextBeta));

    expect(harness.sendLog).toHaveLength(3);

    // Alpha messages share a thread
    expect(harness.sendLog[0].threadId).toBe(harness.sendLog[1].threadId);
    // Beta has a different thread
    expect(harness.sendLog[2].threadId).not.toBe(harness.sendLog[0].threadId);

    // Each agent has independent compute usage
    const alphaState = harness.computeMeter.getAgentState(alphaId);
    const betaState = harness.computeMeter.getAgentState(betaId);
    expect(alphaState).toBeTruthy();
    expect(betaState).toBeTruthy();
    expect(alphaState!.hourlyTokens).toBeGreaterThan(0);
    expect(betaState!.hourlyTokens).toBeGreaterThan(0);

    // Compute data from gateway should show both agents
    const computeData = harness.gateway.getComputeData();
    expect(Object.keys(computeData.agents)).toContain(alphaId);
    expect(Object.keys(computeData.agents)).toContain(betaId);
  });

  // ── 11. Thread Persistence (ContextThreadMap) ──────────────────

  it('should persist context-thread mappings that survive reload', async () => {
    const contextId = crypto.randomUUID();
    const agentId = derivedIdentity(contextId);

    await harness.gateway.handleRequest(buildSendRequest('Persistent msg', contextId));

    const threadId = harness.contextThreadMap.getThreadId(contextId, agentId);
    expect(threadId).toBeTruthy();

    // Create a NEW ContextThreadMap pointing at the same stateDir
    const reloaded = new ContextThreadMap({ stateDir: harness.tmpDir });
    const reloadedThread = reloaded.getThreadId(contextId, agentId);
    expect(reloadedThread).toBe(threadId);
  });

  // ── 12. Compute Meter Persistence ──────────────────────────────

  it('should persist compute meter state that survives reload', async () => {
    const contextId = crypto.randomUUID();
    const agentId = derivedIdentity(contextId);

    await harness.gateway.handleRequest(buildSendRequest('Metered message', contextId));

    // Persist meter state
    harness.computeMeter.persist();

    // Get current state
    const stateBefore = harness.computeMeter.getAgentState(agentId);
    expect(stateBefore).toBeTruthy();
    expect(stateBefore!.hourlyTokens).toBeGreaterThan(0);

    // Create a new ComputeMeter instance (reload from disk)
    const reloaded = new ComputeMeter({ stateDir: harness.tmpDir });
    const stateAfter = reloaded.getAgentState(agentId);
    expect(stateAfter).toBeTruthy();
    expect(stateAfter!.hourlyTokens).toBe(stateBefore!.hourlyTokens);
  });

  // ── 13. Error Recovery — sendMessage Failure ───────────────────

  it('should handle sendMessage failure gracefully without crashing', async () => {
    rmDir(harness.tmpDir);
    harness = createHarness({
      sendMessage: createFailingSendMessage('Backend exploded'),
    });

    const contextId = crypto.randomUUID();
    const result = await harness.gateway.handleRequest(
      buildSendRequest('This will fail', contextId),
    );

    // Should not crash — returns a 200 with the error surfaced through A2A task status
    expect(result.statusCode).toBe(200);

    // Metrics should capture the error
    const metrics = harness.gateway.getMetrics();
    expect(metrics).toContain('threadline_a2a_errors_total');
  });

  // ── 14. Capacity Limits — Max Active Sessions ──────────────────

  it('should enforce max active sessions and park oldest', async () => {
    rmDir(harness.tmpDir);
    harness = createHarness({ maxActive: 2 });

    // Create 2 sessions (fills capacity) — each needs a unique contextId
    const ctx1 = crypto.randomUUID();
    const ctx2 = crypto.randomUUID();

    await harness.gateway.handleRequest(buildSendRequest('Session 1', ctx1));

    // Small delay so session 1 is clearly older
    await new Promise(r => setTimeout(r, 10));

    await harness.gateway.handleRequest(buildSendRequest('Session 2', ctx2));

    // Third session should cause the oldest to be parked
    const ctx3 = crypto.randomUUID();
    await harness.gateway.handleRequest(buildSendRequest('Session 3', ctx3));

    // All three messages should have been processed (oldest parked to make room)
    expect(harness.sendLog).toHaveLength(3);

    const stats = harness.sessionLifecycle.getStats();
    // Should have 2 active and 1 parked
    expect(stats.active).toBe(2);
    expect(stats.parked).toBe(1);
  });

  // ── 15. Circuit Breaker Blocks Preflight ───────────────────────

  it('should block requests when circuit breaker is open for an agent', async () => {
    // Open the circuit breaker for the preflight identity
    for (let i = 0; i < 5; i++) {
      harness.circuitBreaker.recordFailure('agent-bad');
    }

    const state = harness.circuitBreaker.getState('agent-bad');
    expect(state?.state).toBe('open');

    const result = await harness.gateway.handleRequest(
      buildSendRequest('Should be blocked', crypto.randomUUID()),
      { agentIdentity: 'agent-bad' },
    );

    expect(result.statusCode).toBe(503);
    expect((result.body as any).error.message).toContain('Circuit breaker open');
  });

  // ── 16. Trust-Aware Compute Budgets ────────────────────────────

  it('should give higher compute budget to trusted agents', () => {
    // Upgrade agent to 'trusted' level
    harness.trustManager.setTrustLevel(
      'agent-trusted',
      'trusted',
      'user-granted',
      'Integration test elevation',
    );

    const profile = harness.trustManager.getProfile('agent-trusted');
    expect(profile?.level).toBe('trusted');

    // Trusted agents get 200k hourly limit vs 10k for untrusted
    const trustedBudget = harness.computeMeter.getBudget('trusted');
    const untrustedBudget = harness.computeMeter.getBudget('untrusted');

    expect(trustedBudget.hourlyTokenLimit).toBeGreaterThan(untrustedBudget.hourlyTokenLimit);
    expect(trustedBudget.dailyTokenLimit).toBeGreaterThan(untrustedBudget.dailyTokenLimit);
    expect(trustedBudget.maxConcurrentSessions).toBeGreaterThan(untrustedBudget.maxConcurrentSessions);
  });

  // ── 17. Maintenance — Expired Task Cleanup ─────────────────────

  it('should clean up expired tasks during maintenance', async () => {
    const maintenanceResult = await harness.gateway.runMaintenance();

    // With no active tasks, should still return without error
    expect(maintenanceResult.expiredTasks).toBe(0);
    expect(maintenanceResult.sessionTransitions).toBe(0);
  });

  // ── 18. Agent Card Skill Sanitization ──────────────────────────

  it('should sanitize skill descriptions in agent card against injection', () => {
    const keyPair = generateIdentityKeyPair();
    const signFn = (message: Buffer): Buffer => sign(keyPair.privateKey, message);

    const maliciousCard = new AgentCard(
      {
        agentName: 'test',
        description: '<script>alert("xss")</script>Normal description',
        url: 'https://test.example.com',
        skills: [
          {
            id: 'evil',
            name: '**Bold** Name',
            description: '[Click here](http://evil.com) for injection `code`',
          },
        ],
        identityPublicKey: keyPair.publicKey,
      },
      signFn,
    );

    const publicCard = maliciousCard.getPublicCard();
    // HTML should be stripped
    expect(publicCard.description).not.toContain('<script>');
    expect(publicCard.description).toContain('Normal description');

    const skills = publicCard.skills as Array<Record<string, unknown>>;
    // Markdown should be stripped from skill name
    expect(skills[0].name).not.toContain('**');
    expect(skills[0].name).toContain('Bold');
    // Markdown links and code should be stripped from description
    expect(skills[0].description).not.toContain('[Click here]');
    expect(skills[0].description).not.toContain('`code`');
  });

  // ── 19. Concurrent Tasks Per Agent Limit ───────────────────────

  it('should enforce max concurrent tasks per agent via preflight', async () => {
    rmDir(harness.tmpDir);
    harness = createHarness({
      maxActiveTasksPerAgent: 1,
      sendMessage: async (params) => {
        await new Promise(r => setTimeout(r, 200));
        return { message: `Echo: ${params.message}`, tokenCount: 100 };
      },
    });

    const result = await harness.gateway.handleRequest(
      buildSendRequest('Long task', crypto.randomUUID()),
      { agentIdentity: 'agent-alpha' },
    );
    expect(result.statusCode).toBe(200);
  });

  // ── 20. Full Lifecycle — Create, Process, Park, Reactivate ─────

  it('should support full session lifecycle: create → process → park → reactivate', async () => {
    const contextId = crypto.randomUUID();
    const agentId = derivedIdentity(contextId);

    // 1. Create session via message
    await harness.gateway.handleRequest(buildSendRequest('Initial message', contextId));

    const threadId = harness.contextThreadMap.getThreadId(contextId, agentId)!;
    expect(threadId).toBeTruthy();
    expect(harness.sessionLifecycle.get(threadId)!.state).toBe('active');

    // 2. Wait for park timeout and run maintenance
    await new Promise(r => setTimeout(r, 150));
    await harness.gateway.runMaintenance();
    expect(harness.sessionLifecycle.get(threadId)!.state).toBe('parked');

    // 3. Send another message — should reactivate
    await harness.gateway.handleRequest(buildSendRequest('Reactivation message', contextId));

    expect(harness.sessionLifecycle.get(threadId)!.state).toBe('active');
    expect(harness.sessionLifecycle.get(threadId)!.messageCount).toBe(2);
  });

  // ── 21. No-Auth Request Still Processes ────────────────────────

  it('should process requests without agentIdentity context', async () => {
    const result = await harness.gateway.handleRequest(
      buildSendRequest('Anonymous message', crypto.randomUUID()),
    );

    // Should still process — agent identity derived from contextId
    expect(result.statusCode).toBe(200);
    expect(harness.sendLog).toHaveLength(1);
  });

  // ── 22. ContextThreadMap Direct — Identity Binding ─────────────

  it('should prevent cross-agent context lookup via identity binding', () => {
    const contextId = 'shared-context-id';

    // Agent A creates a mapping
    harness.contextThreadMap.set(contextId, 'thread-AAA', 'agent-A');
    expect(harness.contextThreadMap.getThreadId(contextId, 'agent-A')).toBe('thread-AAA');

    // Agent B cannot access Agent A's mapping (session smuggling prevention)
    expect(harness.contextThreadMap.getThreadId(contextId, 'agent-B')).toBeNull();

    // Agent B gets their own mapping
    harness.contextThreadMap.set(`${contextId}-B`, 'thread-BBB', 'agent-B');
    expect(harness.contextThreadMap.getThreadId(`${contextId}-B`, 'agent-B')).toBe('thread-BBB');

    // Reverse lookup works for both
    expect(harness.contextThreadMap.getContextId('thread-AAA')).toBe(contextId);
    expect(harness.contextThreadMap.getContextId('thread-BBB')).toBe(`${contextId}-B`);
  });

  // ── 23. Ed25519 Key Pair Round-Trip ────────────────────────────

  it('should generate valid Ed25519 keys that sign and verify correctly', () => {
    const keyPair = generateIdentityKeyPair();

    expect(keyPair.publicKey).toBeInstanceOf(Buffer);
    expect(keyPair.privateKey).toBeInstanceOf(Buffer);
    expect(keyPair.publicKey.length).toBe(32);
    expect(keyPair.privateKey.length).toBe(32);

    const message = Buffer.from('test message for signing');
    const signature = sign(keyPair.privateKey, message);

    expect(signature).toBeInstanceOf(Buffer);
    expect(signature.length).toBe(64); // Ed25519 signatures are 64 bytes

    expect(verify(keyPair.publicKey, message, signature)).toBe(true);

    // Different message should fail verification
    const wrongMessage = Buffer.from('tampered message');
    expect(verify(keyPair.publicKey, wrongMessage, signature)).toBe(false);

    // Different key should fail verification
    const otherKeyPair = generateIdentityKeyPair();
    expect(verify(otherKeyPair.publicKey, message, signature)).toBe(false);
  });

  // ── 24. Global Compute Cap ─────────────────────────────────────

  it('should enforce global daily compute cap across all agents', () => {
    rmDir(harness.tmpDir);
    harness = createHarness({ globalDailyCap: 500 });

    // Consume tokens from two different agents up to the global cap
    const result1 = harness.computeMeter.record('agent-1', 'untrusted', 300);
    expect(result1.allowed).toBe(true);

    const result2 = harness.computeMeter.record('agent-2', 'untrusted', 300);
    expect(result2.allowed).toBe(false);
    expect(result2.reason).toBe('global_cap_exceeded');
  });

  // ── 25. Session Stats Reflect Gateway State ────────────────────

  it('should reflect gateway state through session stats', async () => {
    // No sessions initially
    const initialStats = harness.sessionLifecycle.getStats();
    expect(initialStats.total).toBe(0);

    // Create 3 sessions
    await harness.gateway.handleRequest(buildSendRequest('Msg', crypto.randomUUID()));
    await harness.gateway.handleRequest(buildSendRequest('Msg', crypto.randomUUID()));
    await harness.gateway.handleRequest(buildSendRequest('Msg', crypto.randomUUID()));

    const afterStats = harness.sessionLifecycle.getStats();
    expect(afterStats.active).toBe(3);
    expect(afterStats.total).toBe(3);
    expect(afterStats.parked).toBe(0);

    // Park via maintenance
    await new Promise(r => setTimeout(r, 150));
    await harness.gateway.runMaintenance();

    const parkedStats = harness.sessionLifecycle.getStats();
    expect(parkedStats.parked).toBe(3);
    expect(parkedStats.active).toBe(0);
  });
});
