/**
 * E2E tests — OpenClawBridge full-stack integration.
 *
 * Tests the OpenClaw ↔ Threadline bridge with real AgentTrustManager,
 * ComputeMeter, and ContextThreadMap instances backed by temp directories.
 * Only the sendMessage callback is a test double.
 *
 * Part of Threadline Protocol Phase 6D.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  OpenClawBridge,
  type OpenClawBridgeConfig,
  type OpenClawRuntime,
  type OpenClawMessage,
  type BridgeSendParams,
  type BridgeResponse,
  type BridgeAgentInfo,
  type BridgeHistoryMessage,
} from '../../../src/threadline/OpenClawBridge.js';
import { generateSkillManifest } from '../../../src/threadline/OpenClawSkillManifest.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import { ComputeMeter } from '../../../src/threadline/ComputeMeter.js';
import { ContextThreadMap } from '../../../src/threadline/ContextThreadMap.js';

// ── Helpers ──────────────────────────────────────────────────────────

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-e2e-'));
}

function createRuntime(overrides?: Partial<OpenClawRuntime>): OpenClawRuntime {
  return {
    agentId: 'e2e-agent',
    character: { name: 'E2E Agent', description: 'End-to-end test agent' },
    getSetting: vi.fn(() => undefined),
    messageManager: {
      createMemory: vi.fn(async () => {}),
      getMemories: vi.fn(async () => []),
    },
    ...overrides,
  };
}

function createMessage(overrides?: Partial<OpenClawMessage>): OpenClawMessage {
  return {
    userId: 'agent-alpha',
    roomId: 'room-main',
    content: { text: 'Hello from OpenClaw' },
    ...overrides,
  };
}

interface E2EStack {
  bridge: OpenClawBridge;
  trustManager: AgentTrustManager;
  computeMeter: ComputeMeter;
  contextThreadMap: ContextThreadMap;
  sendMock: ReturnType<typeof vi.fn>;
  sentMessages: BridgeSendParams[];
  historyStore: Map<string, BridgeHistoryMessage[]>;
  agentRegistry: BridgeAgentInfo[];
}

function buildStack(overrides?: Partial<OpenClawBridgeConfig>): E2EStack {
  const trustManager = new AgentTrustManager({ stateDir: tmpDir });
  const computeMeter = new ComputeMeter({ stateDir: tmpDir });
  const contextThreadMap = new ContextThreadMap({ stateDir: tmpDir });

  const sentMessages: BridgeSendParams[] = [];
  const historyStore = new Map<string, BridgeHistoryMessage[]>();

  const sendMock = vi.fn(async (params: BridgeSendParams): Promise<BridgeResponse> => {
    sentMessages.push(params);

    // Store in history
    const hist = historyStore.get(params.threadId) ?? [];
    hist.push({
      role: 'user',
      content: params.message,
      timestamp: new Date().toISOString(),
    });
    const responseText = `Response to: ${params.message}`;
    hist.push({
      role: 'agent',
      content: responseText,
      timestamp: new Date().toISOString(),
    });
    historyStore.set(params.threadId, hist);

    return { message: responseText, tokenCount: params.message.length + responseText.length };
  });

  const agentRegistry: BridgeAgentInfo[] = [
    { name: 'research-agent', description: 'Finds papers', trustLevel: 'verified', capabilities: ['search', 'summarize'] },
    { name: 'analysis-agent', description: 'Analyzes data', trustLevel: 'trusted', capabilities: ['analyze'] },
  ];

  const bridge = new OpenClawBridge({
    stateDir: tmpDir,
    sendMessage: sendMock,
    trustManager,
    computeMeter,
    contextThreadMap,
    discoverAgents: async () => agentRegistry,
    getHistory: async (threadId, limit) => {
      const hist = historyStore.get(threadId) ?? [];
      return limit ? hist.slice(-limit) : hist;
    },
    ...overrides,
  });

  return { bridge, trustManager, computeMeter, contextThreadMap, sendMock, sentMessages, historyStore, agentRegistry };
}

// ── Setup / Teardown ─────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  // safe-git-allow: incremental-migration
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────

describe('OpenClawBridge E2E', () => {
  // ── 1. Full message lifecycle ──────────────────────────────────────

  describe('full message lifecycle', () => {
    it('OpenClaw message flows through bridge to Threadline and back', async () => {
      const { bridge, trustManager, sentMessages } = buildStack();
      trustManager.setTrustLevel('agent-alpha', 'verified', 'user-granted');

      const result = await bridge.processMessage(createRuntime(), createMessage());

      expect(result).toContain('Response to: Hello from OpenClaw');
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].fromAgent).toBe('agent-alpha');
      expect(sentMessages[0].message).toBe('Hello from OpenClaw');
      expect(sentMessages[0].isNewThread).toBe(true);
      expect(sentMessages[0].threadId).toMatch(/^openclaw-room-main-/);
    });

    it('second message to same room reuses thread', async () => {
      const { bridge, trustManager, sentMessages } = buildStack();
      trustManager.setTrustLevel('agent-alpha', 'verified', 'user-granted');

      await bridge.processMessage(createRuntime(), createMessage({ content: { text: 'First' } }));
      await bridge.processMessage(createRuntime(), createMessage({ content: { text: 'Second' } }));

      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[0].threadId).toBe(sentMessages[1].threadId);
      expect(sentMessages[1].isNewThread).toBe(false);
    });

    it('trust and compute are both checked and recorded', async () => {
      const { bridge, trustManager, computeMeter } = buildStack();
      trustManager.setTrustLevel('agent-alpha', 'verified', 'user-granted');

      await bridge.processMessage(createRuntime(), createMessage());

      const stats = trustManager.getInteractionStats('agent-alpha');
      expect(stats!.successfulInteractions).toBe(1);
      expect(stats!.messagesReceived).toBe(1);

      const meterState = computeMeter.getAgentState('agent-alpha');
      expect(meterState).not.toBeNull();
      expect(meterState!.hourlyTokens).toBeGreaterThan(0);
    });
  });

  // ── 2. Multi-room conversations ───────────────────────────────────

  describe('multi-room conversations', () => {
    it('different rooms get different threads', async () => {
      const { bridge, trustManager, sentMessages } = buildStack();
      trustManager.setTrustLevel('agent-alpha', 'verified', 'user-granted');

      await bridge.processMessage(createRuntime(), createMessage({ roomId: 'room-A' }));
      await bridge.processMessage(createRuntime(), createMessage({ roomId: 'room-B' }));
      await bridge.processMessage(createRuntime(), createMessage({ roomId: 'room-C' }));

      const threads = sentMessages.map(m => m.threadId);
      expect(new Set(threads).size).toBe(3);
    });

    it('same room same agent reuses thread across messages', async () => {
      const { bridge, trustManager, sentMessages } = buildStack();
      trustManager.setTrustLevel('agent-alpha', 'verified', 'user-granted');

      for (let i = 0; i < 5; i++) {
        await bridge.processMessage(createRuntime(), createMessage({ content: { text: `Message ${i}` } }));
      }

      const threads = new Set(sentMessages.map(m => m.threadId));
      expect(threads.size).toBe(1);
      expect(bridge.getMetrics().threadsActive).toBe(1);
    });

    it('different agents in same room get different threads', async () => {
      const { bridge, trustManager, sentMessages } = buildStack();
      trustManager.setTrustLevel('agent-a', 'verified', 'user-granted');
      trustManager.setTrustLevel('agent-b', 'verified', 'user-granted');

      await bridge.processMessage(createRuntime(), createMessage({ userId: 'agent-a', roomId: 'room-shared' }));
      // Small wait to ensure different Date.now() for threadId generation
      await new Promise(r => setTimeout(r, 2));
      await bridge.processMessage(createRuntime(), createMessage({ userId: 'agent-b', roomId: 'room-shared' }));

      // Different agents produce different context mappings, so different threads
      expect(sentMessages[0].fromAgent).toBe('agent-a');
      expect(sentMessages[1].fromAgent).toBe('agent-b');
      expect(sentMessages[0].threadId).not.toBe(sentMessages[1].threadId);
    });
  });

  // ── 3. Trust enforcement ──────────────────────────────────────────

  describe('trust enforcement', () => {
    it('untrusted agent is blocked from sending messages', async () => {
      const { bridge } = buildStack();
      const result = await bridge.processMessage(createRuntime(), createMessage());
      expect(result).toContain('[bridge-error]');
      expect(result).toContain('does not have permission');
    });

    it('verified agent is allowed', async () => {
      const { bridge, trustManager } = buildStack();
      trustManager.setTrustLevel('agent-alpha', 'verified', 'user-granted');

      const result = await bridge.processMessage(createRuntime(), createMessage());
      expect(result).not.toContain('[bridge-error]');
    });

    it('downgraded agent gets blocked', async () => {
      const { bridge, trustManager } = buildStack();
      trustManager.setTrustLevel('agent-alpha', 'verified', 'user-granted');

      // First message succeeds
      const r1 = await bridge.processMessage(createRuntime(), createMessage());
      expect(r1).not.toContain('[bridge-error]');

      // Downgrade
      trustManager.autoDowngrade('agent-alpha', 'security incident');

      // Second message blocked
      const r2 = await bridge.processMessage(createRuntime(), createMessage());
      expect(r2).toContain('[bridge-error]');
      expect(r2).toContain('does not have permission');
    });

    it('trust interaction is recorded on both success and failure', async () => {
      const { bridge, trustManager } = buildStack();
      trustManager.setTrustLevel('agent-alpha', 'verified', 'user-granted');

      await bridge.processMessage(createRuntime(), createMessage());

      const stats = trustManager.getInteractionStats('agent-alpha');
      expect(stats!.successfulInteractions).toBe(1);
    });
  });

  // ── 4. Compute metering ───────────────────────────────────────────

  describe('compute metering', () => {
    it('tokens are tracked after messages', async () => {
      const { bridge, trustManager, computeMeter } = buildStack();
      trustManager.setTrustLevel('agent-alpha', 'verified', 'user-granted');

      await bridge.processMessage(createRuntime(), createMessage({ content: { text: 'A short message' } }));
      await bridge.processMessage(createRuntime(), createMessage({ content: { text: 'Another message here' } }));

      const state = computeMeter.getAgentState('agent-alpha');
      expect(state).not.toBeNull();
      expect(state!.hourlyTokens).toBeGreaterThan(0);
      expect(state!.dailyTokens).toBeGreaterThan(0);
    });

    it('budget exhaustion blocks further messages', async () => {
      const stateDir2 = makeTmpDir();
      try {
        const trustManager = new AgentTrustManager({ stateDir: stateDir2 });
        const computeMeter = new ComputeMeter({
          stateDir: stateDir2,
          // DEFAULT_TOKEN_ESTIMATE is 500. check() tests 500 against limit.
          // First: check(500) → 0+500=500 <= 550 passes. record(60) → 60 consumed.
          // Second: check(500) → 60+500=560 > 550 fails.
          budgetOverrides: { verified: { hourlyTokenLimit: 550, dailyTokenLimit: 550 } },
        });
        const contextThreadMap = new ContextThreadMap({ stateDir: stateDir2 });

        trustManager.setTrustLevel('agent-alpha', 'verified', 'user-granted');

        const bridge = new OpenClawBridge({
          stateDir: stateDir2,
          sendMessage: async (params) => ({
            message: `Echo: ${params.message}`,
            tokenCount: 60, // Each message uses 60 tokens
          }),
          trustManager,
          computeMeter,
          contextThreadMap,
        });

        // First message uses 60 tokens — should pass
        const r1 = await bridge.processMessage(createRuntime(), createMessage());
        expect(r1).not.toContain('[bridge-error]');

        // Second message would push to 120 tokens — exceeds 100 hourly limit
        const r2 = await bridge.processMessage(createRuntime(), createMessage({ content: { text: 'Second' } }));
        expect(r2).toContain('[bridge-error]');
        expect(r2).toContain('Compute budget exceeded');
      } finally {
        // safe-git-allow: incremental-migration
        fs.rmSync(stateDir2, { recursive: true, force: true });
      }
    });
  });

  // ── 5. Thread persistence ─────────────────────────────────────────

  describe('thread persistence', () => {
    it('thread mapping persists in ContextThreadMap', async () => {
      const { bridge, trustManager, contextThreadMap, sentMessages } = buildStack();
      trustManager.setTrustLevel('agent-alpha', 'verified', 'user-granted');

      await bridge.processMessage(createRuntime(), createMessage({ roomId: 'persistent-room' }));
      const threadId = sentMessages[0].threadId;

      // Verify the mapping persists in ContextThreadMap
      const resolved = contextThreadMap.getThreadId('persistent-room', 'agent-alpha');
      expect(resolved).toBe(threadId);
    });

    it('thread mapping survives across interactions', async () => {
      const { bridge, trustManager, sentMessages } = buildStack();
      trustManager.setTrustLevel('agent-alpha', 'verified', 'user-granted');

      await bridge.processMessage(createRuntime(), createMessage({ roomId: 'stable-room', content: { text: 'First' } }));
      await bridge.processMessage(createRuntime(), createMessage({ roomId: 'stable-room', content: { text: 'Second' } }));
      await bridge.processMessage(createRuntime(), createMessage({ roomId: 'stable-room', content: { text: 'Third' } }));

      // All should use the same threadId
      expect(sentMessages[0].threadId).toBe(sentMessages[1].threadId);
      expect(sentMessages[1].threadId).toBe(sentMessages[2].threadId);
    });

    it('getThreadId returns correct mapping after processMessage', async () => {
      const { bridge, trustManager, sentMessages } = buildStack();
      trustManager.setTrustLevel('agent-alpha', 'verified', 'user-granted');

      await bridge.processMessage(createRuntime(), createMessage({ roomId: 'lookup-room' }));
      const threadId = bridge.getThreadId('lookup-room', 'agent-alpha');
      expect(threadId).toBe(sentMessages[0].threadId);
    });
  });

  // ── 6. Agent discovery ────────────────────────────────────────────

  describe('agent discovery', () => {
    it('discover action returns real agent list', async () => {
      const { bridge } = buildStack();
      const action = bridge.getActions().find(a => a.name === 'THREADLINE_DISCOVER')!;

      const result = await action.handler(createRuntime(), createMessage()) as { text: string };
      expect(result.text).toContain('research-agent');
      expect(result.text).toContain('analysis-agent');
      expect(result.text).toContain('verified');
      expect(result.text).toContain('search, summarize');
    });

    it('discover validates when discoverAgents is configured', async () => {
      const { bridge } = buildStack();
      const action = bridge.getActions().find(a => a.name === 'THREADLINE_DISCOVER')!;
      expect(await action.validate(createRuntime(), createMessage())).toBe(true);
    });
  });

  // ── 7. History retrieval ──────────────────────────────────────────

  describe('history retrieval', () => {
    it('history action returns real messages after conversation', async () => {
      const { bridge, trustManager } = buildStack();
      trustManager.setTrustLevel('agent-alpha', 'verified', 'user-granted');

      // Send a message first to create the thread and history
      await bridge.processMessage(createRuntime(), createMessage({ content: { text: 'Tell me about Threadline' } }));

      const action = bridge.getActions().find(a => a.name === 'THREADLINE_HISTORY')!;
      const result = await action.handler(createRuntime(), createMessage()) as { text: string };
      expect(result.text).toContain('Thread history');
      expect(result.text).toContain('Tell me about Threadline');
      expect(result.text).toContain('Response to: Tell me about Threadline');
    });

    it('history shows multiple rounds of conversation', async () => {
      const { bridge, trustManager } = buildStack();
      trustManager.setTrustLevel('agent-alpha', 'verified', 'user-granted');

      await bridge.processMessage(createRuntime(), createMessage({ content: { text: 'First question' } }));
      await bridge.processMessage(createRuntime(), createMessage({ content: { text: 'Follow up question' } }));

      const action = bridge.getActions().find(a => a.name === 'THREADLINE_HISTORY')!;
      const result = await action.handler(createRuntime(), createMessage()) as { text: string };
      expect(result.text).toContain('4 messages'); // 2 user + 2 agent
      expect(result.text).toContain('First question');
      expect(result.text).toContain('Follow up question');
    });
  });

  // ── 8. Status reporting ───────────────────────────────────────────

  describe('status reporting', () => {
    it('includes real trust data', async () => {
      const { bridge, trustManager } = buildStack();
      trustManager.setTrustLevel('agent-alpha', 'verified', 'user-granted');
      trustManager.recordInteraction('agent-alpha', true);
      trustManager.recordInteraction('agent-alpha', true);

      const action = bridge.getActions().find(a => a.name === 'THREADLINE_STATUS')!;
      const result = await action.handler(createRuntime(), createMessage()) as { text: string };
      expect(result.text).toContain('Trust level: verified');
      expect(result.text).toContain('2 successful');
    });

    it('includes real compute data', async () => {
      const { bridge, trustManager } = buildStack();
      trustManager.setTrustLevel('agent-alpha', 'verified', 'user-granted');

      // Send a message to consume some compute
      await bridge.processMessage(createRuntime(), createMessage());

      const action = bridge.getActions().find(a => a.name === 'THREADLINE_STATUS')!;
      const result = await action.handler(createRuntime(), createMessage()) as { text: string };
      expect(result.text).toContain('Compute remaining');
      expect(result.text).toContain('hourly');
    });

    it('includes bridge metrics after activity', async () => {
      const { bridge, trustManager } = buildStack();
      trustManager.setTrustLevel('agent-alpha', 'verified', 'user-granted');

      await bridge.processMessage(createRuntime(), createMessage({ roomId: 'r1' }));
      await bridge.processMessage(createRuntime(), createMessage({ roomId: 'r2' }));

      const action = bridge.getActions().find(a => a.name === 'THREADLINE_STATUS')!;
      const result = await action.handler(createRuntime(), createMessage({ roomId: 'r1' })) as { text: string };
      expect(result.text).toContain('2 processed');
      expect(result.text).toContain('2 active threads');
    });
  });

  // ── 9. Error recovery ─────────────────────────────────────────────

  describe('error recovery', () => {
    it('bridge returns error messages, not exceptions', async () => {
      const { bridge, trustManager } = buildStack({
        sendMessage: async () => { throw new Error('Upstream failure'); },
      });
      trustManager.setTrustLevel('agent-alpha', 'verified', 'user-granted');

      const result = await bridge.processMessage(createRuntime(), createMessage());
      expect(typeof result).toBe('string');
      expect(result).toContain('[bridge-error]');
      expect(result).toContain('Upstream failure');
    });

    it('bridge continues working after error', async () => {
      let callCount = 0;
      const { bridge, trustManager } = buildStack({
        sendMessage: async (params) => {
          callCount++;
          if (callCount === 1) throw new Error('Transient failure');
          return { message: `OK: ${params.message}`, tokenCount: 10 };
        },
      });
      trustManager.setTrustLevel('agent-alpha', 'verified', 'user-granted');

      const r1 = await bridge.processMessage(createRuntime(), createMessage({ content: { text: 'Fail' } }));
      expect(r1).toContain('[bridge-error]');

      const r2 = await bridge.processMessage(createRuntime(), createMessage({ content: { text: 'Succeed' } }));
      expect(r2).toBe('OK: Succeed');

      expect(bridge.getMetrics().errors).toBe(1);
      expect(bridge.getMetrics().messagesProcessed).toBe(1);
    });

    it('trust error does not throw', async () => {
      const { bridge } = buildStack();
      // Agent is untrusted — trust check fails gracefully
      const result = await bridge.processMessage(createRuntime(), createMessage());
      expect(result).toContain('[bridge-error]');
      expect(result).toContain('does not have permission');
    });

    it('compute error does not throw', async () => {
      const stateDir2 = makeTmpDir();
      try {
        const computeMeter = new ComputeMeter({
          stateDir: stateDir2,
          budgetOverrides: { untrusted: { hourlyTokenLimit: 1, dailyTokenLimit: 1 } },
        });
        const bridge = new OpenClawBridge({
          stateDir: stateDir2,
          sendMessage: async () => ({ message: 'ok', tokenCount: 10 }),
          computeMeter,
        });

        const result = await bridge.processMessage(createRuntime(), createMessage());
        expect(typeof result).toBe('string');
        expect(result).toContain('[bridge-error]');
      } finally {
        // safe-git-allow: incremental-migration
        fs.rmSync(stateDir2, { recursive: true, force: true });
      }
    });
  });

  // ── 10. Concurrent messages ───────────────────────────────────────

  describe('concurrent messages', () => {
    it('multiple messages from different agents interleave correctly', async () => {
      const { bridge, trustManager, sentMessages } = buildStack();
      trustManager.setTrustLevel('agent-1', 'verified', 'user-granted');
      trustManager.setTrustLevel('agent-2', 'verified', 'user-granted');
      trustManager.setTrustLevel('agent-3', 'verified', 'user-granted');

      const results = await Promise.all([
        bridge.processMessage(createRuntime(), createMessage({ userId: 'agent-1', roomId: 'r1', content: { text: 'From 1' } })),
        bridge.processMessage(createRuntime(), createMessage({ userId: 'agent-2', roomId: 'r2', content: { text: 'From 2' } })),
        bridge.processMessage(createRuntime(), createMessage({ userId: 'agent-3', roomId: 'r3', content: { text: 'From 3' } })),
      ]);

      expect(results).toHaveLength(3);
      for (const r of results) {
        expect(r).toContain('Response to:');
      }

      expect(sentMessages).toHaveLength(3);
      expect(bridge.getMetrics().messagesProcessed).toBe(3);
      expect(bridge.getMetrics().threadsActive).toBe(3);
    });

    it('concurrent messages to same room from same agent work', async () => {
      const { bridge, trustManager, sentMessages } = buildStack();
      trustManager.setTrustLevel('agent-alpha', 'verified', 'user-granted');

      const results = await Promise.all([
        bridge.processMessage(createRuntime(), createMessage({ content: { text: 'Msg A' } })),
        bridge.processMessage(createRuntime(), createMessage({ content: { text: 'Msg B' } })),
      ]);

      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r).not.toContain('[bridge-error]');
      }

      // Both should use the same thread
      const threads = new Set(sentMessages.map(m => m.threadId));
      expect(threads.size).toBe(1);
    });
  });

  // ── 11. Manifest + bridge consistency ─────────────────────────────

  describe('manifest + bridge consistency', () => {
    it('manifest action names match bridge getActions() names', () => {
      const { bridge } = buildStack();
      const manifest = generateSkillManifest();

      const bridgeNames = bridge.getActions().map(a => a.name).sort();
      const manifestNames = manifest.actions.map(a => a.name).sort();

      expect(bridgeNames).toEqual(manifestNames);
    });

    it('manifest action count matches bridge action count', () => {
      const { bridge } = buildStack();
      const manifest = generateSkillManifest();

      expect(bridge.getActions().length).toBe(manifest.actions.length);
    });

    it('all 4 expected action names present in both', () => {
      const { bridge } = buildStack();
      const manifest = generateSkillManifest();

      const expected = ['THREADLINE_SEND', 'THREADLINE_DISCOVER', 'THREADLINE_HISTORY', 'THREADLINE_STATUS'];

      for (const name of expected) {
        expect(bridge.getActions().find(a => a.name === name)).toBeDefined();
        expect(manifest.actions.find(a => a.name === name)).toBeDefined();
      }
    });
  });

  // ── 12. Full workflow scenarios ───────────────────────────────────

  describe('full workflow scenarios', () => {
    it('new agent: discover → send → history → status', async () => {
      const { bridge, trustManager } = buildStack();
      trustManager.setTrustLevel('agent-alpha', 'verified', 'user-granted');

      const actions = bridge.getActions();
      const discover = actions.find(a => a.name === 'THREADLINE_DISCOVER')!;
      const send = actions.find(a => a.name === 'THREADLINE_SEND')!;
      const history = actions.find(a => a.name === 'THREADLINE_HISTORY')!;
      const status = actions.find(a => a.name === 'THREADLINE_STATUS')!;

      // Step 1: Discover agents
      const discoverResult = await discover.handler(createRuntime(), createMessage()) as { text: string };
      expect(discoverResult.text).toContain('research-agent');

      // Step 2: Send a message
      const sendResult = await send.handler(createRuntime(), createMessage({ content: { text: 'What papers are available?' } })) as { text: string };
      expect(sendResult.text).toContain('Response to:');

      // Step 3: Get history
      const historyResult = await history.handler(createRuntime(), createMessage()) as { text: string };
      expect(historyResult.text).toContain('What papers are available?');

      // Step 4: Check status
      const statusResult = await status.handler(createRuntime(), createMessage()) as { text: string };
      expect(statusResult.text).toContain('1 processed');
      expect(statusResult.text).toContain('Trust level: verified');
    });

    it('multi-agent conversation in shared room', async () => {
      const { bridge, trustManager, sentMessages } = buildStack();
      trustManager.setTrustLevel('alice', 'verified', 'user-granted');
      trustManager.setTrustLevel('bob', 'trusted', 'user-granted');

      // Alice sends in room-collab
      const r1 = await bridge.processMessage(createRuntime(), createMessage({ userId: 'alice', roomId: 'room-collab', content: { text: 'Alice here' } }));
      expect(r1).not.toContain('[bridge-error]');

      // Small wait so threadId timestamps differ
      await new Promise(r => setTimeout(r, 2));

      // Bob sends in same room — gets different thread
      const r2 = await bridge.processMessage(createRuntime(), createMessage({ userId: 'bob', roomId: 'room-collab', content: { text: 'Bob here' } }));
      expect(r2).not.toContain('[bridge-error]');

      // Verify via sentMessages that they got different threads
      const aliceThread = sentMessages[0].threadId;
      const bobThread = sentMessages[1].threadId;
      expect(aliceThread).toBeTruthy();
      expect(bobThread).toBeTruthy();
      expect(aliceThread).not.toBe(bobThread);
      expect(sentMessages[0].fromAgent).toBe('alice');
      expect(sentMessages[1].fromAgent).toBe('bob');

      // Both threads are active
      expect(bridge.getMetrics().threadsActive).toBe(2);
    });
  });
});
