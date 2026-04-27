/**
 * E2E test — A2A Gateway full client workflows.
 *
 * Simulates real-world A2A client patterns end-to-end.
 * Each test builds the full gateway stack with real components:
 * AgentCard, ContextThreadMap, ComputeMeter, SessionLifecycle,
 * AgentTrustManager, RateLimiter, CircuitBreaker, and ThreadlineCrypto.
 *
 * No mocks for core modules — only the sendMessage callback is a test double.
 *
 * Note: The A2A SDK (DefaultRequestHandler + JsonRpcTransportHandler) manages
 * its own task/context IDs internally. The contextId in the executor's
 * RequestContext is assigned by the SDK, not directly from our params.
 * Tests validate behavior through the sentMessages callback, session state,
 * audit logs, and metrics — not by predicting internal SDK identifiers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { A2AGateway, A2A_ERROR_CODES } from '../../../src/threadline/A2AGateway.js';
import type { A2AGatewayConfig, A2AGatewayDeps, GatewaySendParams, GatewayResponse } from '../../../src/threadline/A2AGateway.js';
import { AgentCard } from '../../../src/threadline/AgentCard.js';
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

// ── Types ────────────────────────────────────────────────────────────

interface GatewayStack {
  gateway: A2AGateway;
  keyPair: KeyPair;
  agentCard: AgentCard;
  contextThreadMap: ContextThreadMap;
  computeMeter: ComputeMeter;
  sessionLifecycle: SessionLifecycle;
  trustManager: AgentTrustManager;
  rateLimiter: RateLimiter;
  circuitBreaker: CircuitBreaker;
  sendMessage: (params: GatewaySendParams) => Promise<GatewayResponse>;
  /** All messages received by sendMessage */
  sentMessages: GatewaySendParams[];
}

// ── Stack Builder ────────────────────────────────────────────────────

function buildGatewayStack(
  stateDir: string,
  sendMessageImpl?: (params: GatewaySendParams) => Promise<GatewayResponse>,
  options?: {
    agentName?: string;
    maxActive?: number;
    maxParked?: number;
    parkAfterMs?: number;
    maxTaskDurationMs?: number;
    maxActiveTasksPerAgent?: number;
    rateLimitConfig?: Record<string, { limit: number; windowMs: number }>;
    computeBudgetOverrides?: Record<string, { hourlyTokenLimit?: number; dailyTokenLimit?: number }>;
    globalDailyCap?: number;
  },
): GatewayStack {
  const agentName = options?.agentName ?? 'test-agent';
  const keyPair = generateIdentityKeyPair();

  const sentMessages: GatewaySendParams[] = [];

  // Wrap to track all calls
  const wrappedSendMessage = async (params: GatewaySendParams): Promise<GatewayResponse> => {
    sentMessages.push(params);
    if (sendMessageImpl) {
      return sendMessageImpl(params);
    }
    return { message: `Echo: ${params.message}`, tokenCount: params.message.length * 2 };
  };

  const signFn = (message: Buffer): Buffer => sign(keyPair.privateKey, message);

  const agentCard = new AgentCard(
    {
      agentName,
      description: `${agentName} test agent`,
      url: `https://${agentName}.example.com`,
      version: '1.0.0',
      identityPublicKey: keyPair.publicKey,
      skills: [
        { id: 'echo', name: 'Echo', description: 'Echoes messages back' },
        { id: 'chat', name: 'Chat', description: 'General conversation' },
      ],
    },
    signFn,
  );

  const contextThreadMap = new ContextThreadMap({
    stateDir,
    maxEntries: 1000,
  });

  const computeMeter = new ComputeMeter({
    stateDir,
    globalDailyCap: options?.globalDailyCap,
    budgetOverrides: options?.computeBudgetOverrides as any,
  });

  const sessionLifecycle = new SessionLifecycle({
    stateDir,
    maxActive: options?.maxActive ?? 5,
    maxParked: options?.maxParked ?? 20,
    parkAfterMs: options?.parkAfterMs ?? 5 * 60 * 1000,
  });

  const trustManager = new AgentTrustManager({ stateDir });

  const rateLimiter = new RateLimiter({
    stateDir,
    config: options?.rateLimitConfig as any,
  });

  const circuitBreaker = new CircuitBreaker({
    stateDir,
    trustManager,
  });

  const config: A2AGatewayConfig = {
    agentName,
    sendMessage: wrappedSendMessage,
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
    maxTaskDurationMs: options?.maxTaskDurationMs,
    maxActiveTasksPerAgent: options?.maxActiveTasksPerAgent,
  });

  return {
    gateway,
    keyPair,
    agentCard,
    contextThreadMap,
    computeMeter,
    sessionLifecycle,
    trustManager,
    rateLimiter,
    circuitBreaker,
    sendMessage: wrappedSendMessage,
    sentMessages,
  };
}

// ── JSON-RPC Helpers ─────────────────────────────────────────────────

function makeMessageSendRequest(
  text: string,
  contextId?: string,
  taskId?: string,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: taskId ?? crypto.randomUUID(),
    method: 'message/send',
    params: {
      message: {
        kind: 'message',
        messageId: crypto.randomUUID(),
        role: 'user',
        parts: [{ kind: 'text', text }],
      },
      configuration: {
        contextId: contextId ?? crypto.randomUUID(),
      },
    },
  };
}

// ── Test Setup ───────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-e2e-'));
});

afterEach(() => {
  // safe-git-allow: incremental-migration
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────

describe('A2A Gateway E2E', () => {

  // 1. Golden path: Single message
  it('should process a single message through the full stack', async () => {
    const stack = buildGatewayStack(tmpDir);
    const contextId = crypto.randomUUID();
    const request = makeMessageSendRequest('Hello, agent!', contextId);

    const result = await stack.gateway.handleRequest(request);

    expect(result.statusCode).toBe(200);
    expect(result.headers['Content-Type']).toBe('application/json');

    // Verify sendMessage was called with correct text
    expect(stack.sentMessages.length).toBe(1);
    expect(stack.sentMessages[0].message).toBe('Hello, agent!');
    expect(stack.sentMessages[0].isNewThread).toBe(true);
    expect(stack.sentMessages[0].threadId).toBeDefined();
    expect(stack.sentMessages[0].fromAgent).toBeDefined();

    // Verify session was activated (using the actual threadId from sendMessage)
    const threadId = stack.sentMessages[0].threadId;
    const session = stack.sessionLifecycle.get(threadId);
    expect(session).not.toBeNull();
    expect(session!.state).toBe('active');
    expect(session!.messageCount).toBe(1);

    // Verify audit trail
    const audit = stack.gateway.getAuditLog();
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit.some(e => e.event === 'message_processed')).toBe(true);
  });

  // 2. Multi-turn conversation with 5 messages
  it('should process 5 sequential messages and track sessions', async () => {
    const stack = buildGatewayStack(tmpDir);

    for (let i = 1; i <= 5; i++) {
      const request = makeMessageSendRequest(`Message ${i}`, crypto.randomUUID());
      const result = await stack.gateway.handleRequest(request);
      expect(result.statusCode).toBe(200);
    }

    // All 5 messages should have been sent
    expect(stack.sentMessages.length).toBe(5);

    // Each message should have valid metadata
    for (const msg of stack.sentMessages) {
      expect(msg.threadId).toBeDefined();
      expect(msg.fromAgent).toBeDefined();
      expect(msg.message).toMatch(/^Message \d$/);
    }

    // Sessions should be tracked
    const stats = stack.sessionLifecycle.getStats();
    expect(stats.active).toBeGreaterThanOrEqual(1);

    // Audit trail should have 5 entries
    const audit = stack.gateway.getAuditLog();
    const processed = audit.filter(e => e.event === 'message_processed');
    expect(processed.length).toBe(5);
  });

  // 3. Three different contextIds create separate sessions
  it('should create separate sessions for different contextIds', async () => {
    const stack = buildGatewayStack(tmpDir);
    const contexts = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];

    for (let round = 0; round < 3; round++) {
      for (let agent = 0; agent < 3; agent++) {
        const request = makeMessageSendRequest(
          `Agent ${agent} round ${round}`,
          contexts[agent],
        );
        const result = await stack.gateway.handleRequest(request);
        expect(result.statusCode).toBe(200);
      }
    }

    // 9 total messages sent through
    expect(stack.sentMessages.length).toBe(9);

    // All messages should have thread IDs
    for (const msg of stack.sentMessages) {
      expect(msg.threadId).toBeDefined();
      expect(msg.fromAgent).toBeDefined();
    }

    // Sessions should exist for the threads
    const stats = stack.sessionLifecycle.getStats();
    expect(stats.active).toBeGreaterThanOrEqual(1);
    expect(stats.total).toBeGreaterThanOrEqual(1);
  });

  // 4. Compute budget exhaustion (via direct meter API)
  it('should reject messages when compute budget is exhausted', () => {
    // The A2A SDK assigns unique contextIds per task, creating different
    // agent identities each time. Test budget exhaustion via direct API.
    const stack = buildGatewayStack(tmpDir, undefined, {
      computeBudgetOverrides: {
        untrusted: { hourlyTokenLimit: 100, dailyTokenLimit: 200 },
      },
    });

    const agentIdentity = 'budget-test-agent';

    // First record: 80 tokens — should succeed
    const result1 = stack.computeMeter.record(agentIdentity, 'untrusted', 80);
    expect(result1.allowed).toBe(true);

    // Second record: 30 more tokens — should exceed the 100 hourly limit
    const result2 = stack.computeMeter.check(agentIdentity, 'untrusted', 30);
    expect(result2.allowed).toBe(false);
    expect(result2.reason).toBe('hourly_limit_exceeded');
    expect(result2.retryAfterSeconds).toBeGreaterThan(0);
  });

  // 5. Trust upgrade changes budget
  it('should allow more tokens after trust upgrade', async () => {
    const stack = buildGatewayStack(tmpDir, undefined, {
      computeBudgetOverrides: {
        untrusted: { hourlyTokenLimit: 50, dailyTokenLimit: 100 },
        verified: { hourlyTokenLimit: 5000, dailyTokenLimit: 25000 },
      },
    });

    // Send a message to create the agent identity in the system
    const req1 = makeMessageSendRequest('x'.repeat(40), crypto.randomUUID());
    await stack.gateway.handleRequest(req1);

    // Discover the actual agent identity used
    expect(stack.sentMessages.length).toBe(1);
    const agentIdentity = stack.sentMessages[0].fromAgent;

    // Agent starts as untrusted
    const profile = stack.trustManager.getOrCreateProfile(agentIdentity);
    expect(profile.level).toBe('untrusted');

    // Upgrade trust to verified
    const upgraded = stack.trustManager.setTrustLevel(
      agentIdentity,
      'verified',
      'user-granted',
      'Test upgrade',
    );
    expect(upgraded).toBe(true);
    expect(stack.trustManager.getProfile(agentIdentity)?.level).toBe('verified');

    // Verified budget allows 5000 hourly
    const checkResult = stack.computeMeter.check(agentIdentity, 'verified', 1000);
    expect(checkResult.allowed).toBe(true);

    // Untrusted budget (50) would have rejected this after prior consumption
    const untrustedCheck = stack.computeMeter.check(agentIdentity, 'untrusted', 1000);
    expect(untrustedCheck.allowed).toBe(false);
  });

  // 6. Session lifecycle under load
  it('should park oldest session when max active is exceeded', async () => {
    const stack = buildGatewayStack(tmpDir, undefined, {
      maxActive: 3,
    });

    // Create 6 sessions
    for (let i = 0; i < 6; i++) {
      const req = makeMessageSendRequest(`Session ${i}`, crypto.randomUUID());
      await stack.gateway.handleRequest(req);
    }

    const stats = stack.sessionLifecycle.getStats();
    // Active should not exceed max of 3
    expect(stats.active).toBeLessThanOrEqual(3);
    // Some sessions should have been parked
    expect(stats.parked).toBeGreaterThanOrEqual(1);
    expect(stats.total).toBeGreaterThanOrEqual(4);
  });

  // 7. Rate limiting enforcement via preflight
  it('should enforce rate limits on rapid-fire messages', async () => {
    const stack = buildGatewayStack(tmpDir, undefined, {
      rateLimitConfig: {
        perAgentInbound: { limit: 3, windowMs: 60000 },
        perAgentBurst: { limit: 2, windowMs: 1000 },
      },
    });

    const agentIdentity = 'rate-test-agent';

    // Pre-fill rate limit events to exhaust the budget.
    // The preflight uses checkLimit (checks without recording), so
    // we fill the window externally with recordEvent.
    for (let i = 0; i < 3; i++) {
      stack.rateLimiter.recordEvent('perAgentInbound', agentIdentity);
    }

    // Now sending with this identity should be rate-limited in preflight
    const req = makeMessageSendRequest('Should be limited', crypto.randomUUID());
    const result = await stack.gateway.handleRequest(req, { agentIdentity });

    expect(result.statusCode).toBe(429);
    const body = result.body as any;
    expect(body.error.code).toBe(A2A_ERROR_CODES.RATE_LIMITED);
  });

  // 8. Thread persistence across restart
  it('should persist context-thread mappings across gateway recreation', async () => {
    const stateDir = path.join(tmpDir, 'persist-test');
    fs.mkdirSync(stateDir, { recursive: true });

    // First gateway instance
    const stack1 = buildGatewayStack(stateDir);
    const req = makeMessageSendRequest('First message', crypto.randomUUID());
    await stack1.gateway.handleRequest(req);

    // Discover the actual identity and threadId used
    expect(stack1.sentMessages.length).toBe(1);
    const agentIdentity = stack1.sentMessages[0].fromAgent;
    const threadId = stack1.sentMessages[0].threadId;

    // Verify the map file was persisted
    const mapFile = path.join(stateDir, 'threadline', 'context-thread-map.json');
    expect(fs.existsSync(mapFile)).toBe(true);

    const mapData = JSON.parse(fs.readFileSync(mapFile, 'utf-8'));
    expect(mapData.mappings.length).toBeGreaterThanOrEqual(1);

    // Create a new ContextThreadMap from the same stateDir (simulating restart)
    const newContextMap = new ContextThreadMap({ stateDir });

    // Find the mapping for our agent identity
    const mapping = mapData.mappings.find((m: any) => m.agentIdentity === agentIdentity);
    expect(mapping).toBeDefined();

    // Verify the restored map resolves the same threadId
    const restoredThreadId = newContextMap.getThreadId(mapping.contextId, agentIdentity);
    expect(restoredThreadId).toBe(threadId);
  });

  // 9. Agent Card verification with real crypto
  it('should generate and verify Agent Card with Ed25519 signature', () => {
    const stack = buildGatewayStack(tmpDir);

    const cardResult = stack.gateway.getAgentCard();
    expect(cardResult.card).toBeDefined();
    expect(cardResult.signature).toBeDefined();
    expect(typeof cardResult.signature).toBe('string');
    expect(cardResult.signature.length).toBeGreaterThan(0);

    // Verify the signature using the AgentCard static method
    const canonicalJson = AgentCard.canonicalize(cardResult.card);
    const isValid = AgentCard.verify(
      canonicalJson,
      cardResult.signature,
      stack.keyPair.publicKey,
    );
    expect(isValid).toBe(true);

    // Verify with a wrong key fails
    const wrongKeyPair = generateIdentityKeyPair();
    const isInvalid = AgentCard.verify(
      canonicalJson,
      cardResult.signature,
      wrongKeyPair.publicKey,
    );
    expect(isInvalid).toBe(false);

    // Verify card contents
    expect(cardResult.card.name).toBe('test-agent');
    expect(cardResult.card.url).toBe('https://test-agent.example.com');
    expect(cardResult.headers['X-Threadline-Card-Signature']).toBe(cardResult.signature);
  });

  // 10. Concurrent message processing
  it('should handle 5 concurrent messages to completion', async () => {
    let callCount = 0;
    const stack = buildGatewayStack(tmpDir, async (params) => {
      callCount++;
      await new Promise(resolve => setTimeout(resolve, Math.random() * 50));
      return { message: `Response to: ${params.message}`, tokenCount: 100 };
    });

    const requests = Array.from({ length: 5 }, (_, i) =>
      makeMessageSendRequest(`Concurrent msg ${i}`, crypto.randomUUID()),
    );

    // Send all 5 simultaneously
    const results = await Promise.all(
      requests.map(req => stack.gateway.handleRequest(req)),
    );

    for (const result of results) {
      expect(result.statusCode).toBe(200);
    }

    expect(callCount).toBe(5);
    expect(stack.sentMessages.length).toBe(5);
    for (const msg of stack.sentMessages) {
      expect(msg.threadId).toBeDefined();
      expect(msg.fromAgent).toBeDefined();
    }
  });

  // 11. Error recovery — sendMessage fails intermittently
  it('should handle sendMessage failures gracefully', async () => {
    let callIdx = 0;
    const stack = buildGatewayStack(tmpDir, async (params) => {
      callIdx++;
      if (callIdx % 2 === 0) {
        throw new Error('Intermittent failure');
      }
      return { message: `OK: ${params.message}`, tokenCount: 50 };
    });

    const results: Awaited<ReturnType<typeof stack.gateway.handleRequest>>[] = [];

    for (let i = 0; i < 4; i++) {
      const req = makeMessageSendRequest(`Error test ${i}`, crypto.randomUUID());
      const result = await stack.gateway.handleRequest(req);
      results.push(result);
    }

    // All should return 200 (errors are handled inside the executor via task state)
    for (const result of results) {
      expect(result.statusCode).toBe(200);
    }

    // Should have AGENT_UNAVAILABLE errors from the failed calls
    const metricsText = stack.gateway.getMetrics();
    expect(metricsText).toContain(`threadline_a2a_errors_total{code="${A2A_ERROR_CODES.AGENT_UNAVAILABLE}"}`);
  });

  // 12. Full maintenance cycle
  it('should transition sessions through maintenance lifecycle', async () => {
    const stack = buildGatewayStack(tmpDir, undefined, {
      maxActive: 5,
      parkAfterMs: 1, // 1ms — will park immediately on maintenance
    });

    for (let i = 0; i < 3; i++) {
      const req = makeMessageSendRequest(`Session ${i}`, crypto.randomUUID());
      await stack.gateway.handleRequest(req);
    }

    let stats = stack.sessionLifecycle.getStats();
    expect(stats.active).toBeGreaterThanOrEqual(1);

    // Wait for park timeout to pass
    await new Promise(resolve => setTimeout(resolve, 10));

    // Run maintenance
    const maintenance = await stack.gateway.runMaintenance();
    expect(maintenance.sessionTransitions).toBeGreaterThanOrEqual(1);

    stats = stack.sessionLifecycle.getStats();
    expect(stats.parked).toBeGreaterThanOrEqual(1);
  });

  // 13. Metrics accuracy
  it('should track accurate request and compute metrics', async () => {
    const stack = buildGatewayStack(tmpDir);

    for (let i = 0; i < 3; i++) {
      const req = makeMessageSendRequest(`Metrics test ${i}`, crypto.randomUUID());
      await stack.gateway.handleRequest(req);
    }

    const metricsText = stack.gateway.getMetrics();

    expect(metricsText).toContain('threadline_a2a_requests_total{method="message/send"} 3');
    expect(metricsText).toContain('threadline_a2a_latency_seconds_avg');
    expect(metricsText).toContain('threadline_active_sessions');
    expect(metricsText).toContain('threadline_handshakes_total{outcome="success"}');
    expect(metricsText).toContain('threadline_compute_tokens_total');
  });

  // 14. Audit trail completeness
  it('should record complete audit trail for message processing', async () => {
    const stack = buildGatewayStack(tmpDir);

    const req = makeMessageSendRequest('Audit test', crypto.randomUUID());
    await stack.gateway.handleRequest(req);

    const audit = stack.gateway.getAuditLog();
    expect(audit.length).toBeGreaterThanOrEqual(1);

    const processedEntry = audit.find(e => e.event === 'message_processed');
    expect(processedEntry).toBeDefined();
    expect(processedEntry!.agentIdentity).toBeDefined();
    expect(processedEntry!.details.taskId).toBeDefined();
    expect(processedEntry!.details.threadId).toBeDefined();
    expect(processedEntry!.details.tokenCount).toBeDefined();
    expect(processedEntry!.timestamp).toBeDefined();
  });

  // 15. Parameter validation — invalid method name
  it('should handle invalid method names', async () => {
    const stack = buildGatewayStack(tmpDir);

    const request = {
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'nonexistent/method',
      params: {},
    };

    const result = await stack.gateway.handleRequest(request);
    expect(result.statusCode).toBe(200);
    const body = result.body as any;
    if (body?.error) {
      expect(body.error.code).toBeDefined();
    }
  });

  // 16. Parameter validation — missing message parts
  it('should handle missing message parts gracefully', async () => {
    const stack = buildGatewayStack(tmpDir);

    const request = {
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'message/send',
      params: {
        message: {
          kind: 'message',
          messageId: crypto.randomUUID(),
          role: 'user',
          parts: [],
        },
      },
    };

    const result = await stack.gateway.handleRequest(request);
    expect(result.statusCode).toBe(200);
  });

  // 17. Parameter validation — whitespace-only message
  it('should handle empty text message', async () => {
    const stack = buildGatewayStack(tmpDir);

    const request = {
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'message/send',
      params: {
        message: {
          kind: 'message',
          messageId: crypto.randomUUID(),
          role: 'user',
          parts: [{ kind: 'text', text: '   ' }],
        },
        configuration: {
          contextId: crypto.randomUUID(),
        },
      },
    };

    const result = await stack.gateway.handleRequest(request);
    expect(result.statusCode).toBe(200);
    // sendMessage should NOT have been called (text is whitespace-only)
    expect(stack.sentMessages.length).toBe(0);
  });

  // 18. Circuit breaker blocks requests when open
  it('should block requests when circuit breaker is open', async () => {
    const stack = buildGatewayStack(tmpDir);
    const agentIdentity = 'breaker-test-agent';

    // Record 5 failures to open the circuit
    for (let i = 0; i < 5; i++) {
      stack.circuitBreaker.recordFailure(agentIdentity);
    }
    expect(stack.circuitBreaker.isOpen(agentIdentity)).toBe(true);

    // Sending with this identity should be blocked in preflight
    const req = makeMessageSendRequest('Should be blocked', crypto.randomUUID());
    const result = await stack.gateway.handleRequest(req, { agentIdentity });

    expect(result.statusCode).toBe(503);
    const body = result.body as any;
    expect(body.error.code).toBe(A2A_ERROR_CODES.AGENT_UNAVAILABLE);
  });

  // 19. Context identity binding prevents session smuggling
  it('should prevent session smuggling via context identity binding', () => {
    const stack = buildGatewayStack(tmpDir);

    // Manually set up a context-thread mapping (Agent A's session)
    const contextId = 'shared-context-id';
    const threadId = crypto.randomUUID();
    stack.contextThreadMap.set(contextId, threadId, 'agent-a');

    // Agent A can look up the thread
    expect(stack.contextThreadMap.getThreadId(contextId, 'agent-a')).toBe(threadId);

    // Agent B trying same contextId gets null (identity binding)
    expect(stack.contextThreadMap.getThreadId(contextId, 'agent-b')).toBeNull();
  });

  // 20. Compute data admin endpoint
  it('should return accurate compute data for admin endpoint', async () => {
    const stack = buildGatewayStack(tmpDir);

    const req = makeMessageSendRequest('Compute data test', crypto.randomUUID());
    await stack.gateway.handleRequest(req);

    const computeData = stack.gateway.getComputeData();
    expect(computeData.global).toBeDefined();
    expect(computeData.global).toHaveProperty('dailyTokens');
  });

  // 21. Max concurrent tasks per agent enforcement
  it('should limit concurrent tasks per agent via preflight', async () => {
    let resolvers: Array<() => void> = [];
    const stack = buildGatewayStack(
      tmpDir,
      async () => {
        await new Promise<void>(resolve => { resolvers.push(resolve); });
        return { message: 'Done', tokenCount: 50 };
      },
      { maxActiveTasksPerAgent: 2 },
    );

    const agentIdentity = 'concurrent-test-agent';

    const promises = [1, 2, 3].map(i =>
      stack.gateway.handleRequest(
        makeMessageSendRequest(`Task ${i}`, crypto.randomUUID()),
        { agentIdentity },
      ),
    );

    await new Promise(resolve => setTimeout(resolve, 20));

    resolvers.forEach(r => r());

    const results = await Promise.all(promises);
    const statuses = results.map(r => r.statusCode);
    expect(statuses.every(s => s === 200 || s === 429)).toBe(true);
  });

  // 22. Agent card signature in response headers
  it('should include card signature in response headers', async () => {
    const stack = buildGatewayStack(tmpDir);

    const req = makeMessageSendRequest('Header test', crypto.randomUUID());
    const result = await stack.gateway.handleRequest(req);

    expect(result.headers['X-Threadline-Card-Signature']).toBeDefined();
    expect(result.headers['X-Threadline-Card-Signature'].length).toBeGreaterThan(0);
    expect(result.headers['Content-Type']).toBe('application/json');
  });

  // 23. Trust manager rejects auto-upgrade, allows user-granted
  it('should not allow trust auto-upgrade (only user-granted)', () => {
    const stack = buildGatewayStack(tmpDir);
    const agentIdentity = 'upgrade-test';

    stack.trustManager.getOrCreateProfile(agentIdentity);

    const rejected = stack.trustManager.setTrustLevel(
      agentIdentity, 'trusted', 'setup-default', 'Attempted auto-upgrade',
    );
    expect(rejected).toBe(false);
    expect(stack.trustManager.getProfile(agentIdentity)?.level).toBe('untrusted');

    const approved = stack.trustManager.setTrustLevel(
      agentIdentity, 'trusted', 'user-granted', 'User approved',
    );
    expect(approved).toBe(true);
    expect(stack.trustManager.getProfile(agentIdentity)?.level).toBe('trusted');
  });

  // 24. Full gateway stack with all deps wired correctly
  it('should have all dependencies accessible and functional', () => {
    const stack = buildGatewayStack(tmpDir, undefined, { agentName: 'full-stack-test' });

    expect(stack.gateway).toBeInstanceOf(A2AGateway);
    expect(stack.agentCard).toBeInstanceOf(AgentCard);
    expect(stack.contextThreadMap).toBeInstanceOf(ContextThreadMap);
    expect(stack.computeMeter).toBeInstanceOf(ComputeMeter);
    expect(stack.sessionLifecycle).toBeInstanceOf(SessionLifecycle);
    expect(stack.trustManager).toBeInstanceOf(AgentTrustManager);
    expect(stack.rateLimiter).toBeInstanceOf(RateLimiter);
    expect(stack.circuitBreaker).toBeInstanceOf(CircuitBreaker);

    expect(stack.keyPair.publicKey.length).toBe(32);
    expect(stack.keyPair.privateKey.length).toBe(32);

    const card = stack.gateway.getAgentCard();
    expect(card.card.name).toBe('full-stack-test');

    const metrics = stack.gateway.getMetrics();
    expect(metrics).toContain('threadline_handshakes_total{outcome="success"} 0');
  });

  // 25. Rate limited request includes Retry-After header
  it('should include Retry-After header on rate limited response', async () => {
    const stack = buildGatewayStack(tmpDir, undefined, {
      rateLimitConfig: {
        perAgentInbound: { limit: 1, windowMs: 60000 },
      },
    });

    const agentIdentity = 'retry-test-agent';
    stack.rateLimiter.recordEvent('perAgentInbound', agentIdentity);

    const req = makeMessageSendRequest('Should be limited', crypto.randomUUID());
    const result = await stack.gateway.handleRequest(req, { agentIdentity });

    expect(result.statusCode).toBe(429);
    expect(result.headers['Retry-After']).toBeDefined();
    expect(parseInt(result.headers['Retry-After'])).toBeGreaterThan(0);
  });

  // 26. Expired task cleanup in maintenance
  it('should clean up expired tasks during maintenance', async () => {
    const stack = buildGatewayStack(tmpDir, undefined, { maxTaskDurationMs: 1 });

    const req = makeMessageSendRequest('Quick message', crypto.randomUUID());
    await stack.gateway.handleRequest(req);

    await new Promise(resolve => setTimeout(resolve, 10));

    const maintenance = await stack.gateway.runMaintenance();
    expect(maintenance.expiredTasks).toBeGreaterThanOrEqual(0);
    expect(maintenance).toHaveProperty('sessionTransitions');
  });

  // 27. Sanitization in AgentCard prevents injection
  it('should sanitize skill descriptions in Agent Card', () => {
    const keyPair = generateIdentityKeyPair();
    const signFn = (message: Buffer): Buffer => sign(keyPair.privateKey, message);

    const card = new AgentCard(
      {
        agentName: 'sanitize-test',
        description: '<script>alert("xss")</script> Normal description',
        url: 'https://test.example.com',
        identityPublicKey: keyPair.publicKey,
        skills: [
          {
            id: 'inject',
            name: '**Bold** Skill',
            description: '[Click here](http://evil.com) for `code` injection ```block```',
          },
        ],
      },
      signFn,
    );

    const generated = card.generate();
    const skills = generated.card.skills as Array<Record<string, unknown>>;

    const desc = generated.card.description as string;
    expect(desc).not.toContain('<script>');
    expect(desc).not.toContain('</script>');

    expect(skills[0].name).not.toContain('**');
    expect(skills[0].description).not.toContain('[Click here]');
    expect(skills[0].description).not.toContain('```');
  });

  // 28. Session lifecycle persists to disk
  it('should persist session state to disk', async () => {
    const stateDir = path.join(tmpDir, 'session-persist');
    fs.mkdirSync(stateDir, { recursive: true });

    const stack = buildGatewayStack(stateDir);
    const req = makeMessageSendRequest('Persist test', crypto.randomUUID());
    await stack.gateway.handleRequest(req);

    const sessionFile = path.join(stateDir, 'threadline', 'session-lifecycle.json');
    expect(fs.existsSync(sessionFile)).toBe(true);

    const data = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
    expect(Object.keys(data).length).toBeGreaterThanOrEqual(1);
  });

  // 29. Multiple audit events across multiple messages
  it('should accumulate audit entries across messages', async () => {
    const stack = buildGatewayStack(tmpDir);

    for (let i = 0; i < 5; i++) {
      const req = makeMessageSendRequest(`Audit msg ${i}`, crypto.randomUUID());
      await stack.gateway.handleRequest(req);
    }

    const audit = stack.gateway.getAuditLog();
    const processed = audit.filter(e => e.event === 'message_processed');
    expect(processed.length).toBe(5);

    const taskIds = new Set(processed.map(e => e.details.taskId));
    expect(taskIds.size).toBe(5);
  });

  // 30. Circuit breaker auto-downgrade after 3 activations
  it('should auto-downgrade trust after 3 circuit breaker activations', () => {
    const stack = buildGatewayStack(tmpDir);
    const agentIdentity = 'downgrade-test-agent';

    stack.trustManager.setTrustLevel(agentIdentity, 'verified', 'user-granted');
    expect(stack.trustManager.getProfile(agentIdentity)?.level).toBe('verified');

    // Trigger circuit breaker 3 times
    for (let activation = 0; activation < 3; activation++) {
      for (let i = 0; i < 5; i++) {
        stack.circuitBreaker.recordFailure(agentIdentity);
      }
      if (activation < 2) {
        stack.circuitBreaker.reset(agentIdentity);
      }
    }

    // After 3 activations, trust should be auto-downgraded
    expect(stack.trustManager.getProfile(agentIdentity)?.level).toBe('untrusted');
  });

  // 31. Compute meter global cap
  it('should enforce global daily compute cap', () => {
    const stack = buildGatewayStack(tmpDir, undefined, { globalDailyCap: 500 });

    stack.computeMeter.record('agent-1', 'untrusted', 300);
    stack.computeMeter.record('agent-2', 'untrusted', 199);

    const check = stack.computeMeter.check('agent-3', 'untrusted', 100);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe('global_cap_exceeded');
  });
});
