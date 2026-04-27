/**
 * Unit tests — OpenClawBridge.
 *
 * Tests the OpenClaw ↔ Threadline bridge adapter with mock sendMessage
 * callbacks and real AgentTrustManager / ComputeMeter / ContextThreadMap
 * instances backed by temp directories (file-based, lightweight).
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
  type OpenClawAction,
  type BridgeSendParams,
  type BridgeResponse,
  type BridgeAgentInfo,
  type BridgeHistoryMessage,
  type OpenClawBridgeMetrics,
} from '../../../src/threadline/OpenClawBridge.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import { ComputeMeter } from '../../../src/threadline/ComputeMeter.js';
import { ContextThreadMap } from '../../../src/threadline/ContextThreadMap.js';

// ── Helpers ──────────────────────────────────────────────────────────

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-bridge-test-'));
}

function createMockRuntime(overrides?: Partial<OpenClawRuntime>): OpenClawRuntime {
  return {
    agentId: 'test-agent',
    character: { name: 'Test Agent', description: 'A test agent' },
    getSetting: vi.fn(() => undefined),
    messageManager: {
      createMemory: vi.fn(async () => {}),
      getMemories: vi.fn(async () => []),
    },
    ...overrides,
  };
}

function createMockMessage(overrides?: Partial<OpenClawMessage>): OpenClawMessage {
  return {
    userId: 'user-1',
    roomId: 'room-1',
    content: { text: 'Hello Threadline agent' },
    ...overrides,
  };
}

function createSendMessage(): {
  fn: (params: BridgeSendParams) => Promise<BridgeResponse>;
  mock: ReturnType<typeof vi.fn>;
  calls: BridgeSendParams[];
} {
  const calls: BridgeSendParams[] = [];
  const mock = vi.fn(async (params: BridgeSendParams): Promise<BridgeResponse> => {
    calls.push(params);
    return { message: `Echo: ${params.message}`, tokenCount: params.message.length * 2 };
  });
  return { fn: mock, mock, calls };
}

function createBridge(
  overrides?: Partial<OpenClawBridgeConfig>,
): { bridge: OpenClawBridge; sendMock: ReturnType<typeof vi.fn> } {
  const send = createSendMessage();
  const bridge = new OpenClawBridge({
    stateDir: tmpDir,
    sendMessage: send.fn,
    ...overrides,
  });
  return { bridge, sendMock: send.mock };
}

// ── Setup / Teardown ─────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  // safe-git-allow: incremental-migration
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── 1. Constructor ───────────────────────────────────────────────────

describe('OpenClawBridge', () => {
  describe('constructor', () => {
    it('creates a bridge instance', () => {
      const { bridge } = createBridge();
      expect(bridge).toBeInstanceOf(OpenClawBridge);
    });

    it('initializes metrics at zero', () => {
      const { bridge } = createBridge();
      const metrics = bridge.getMetrics();
      expect(metrics.messagesProcessed).toBe(0);
      expect(metrics.threadsActive).toBe(0);
      expect(metrics.errors).toBe(0);
    });

    it('accepts optional dependencies', () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      const computeMeter = new ComputeMeter({ stateDir: tmpDir });
      const contextThreadMap = new ContextThreadMap({ stateDir: tmpDir });

      const { bridge } = createBridge({
        trustManager,
        computeMeter,
        contextThreadMap,
      });
      expect(bridge).toBeInstanceOf(OpenClawBridge);
    });
  });

  // ── 2. getActions ────────────────────────────────────────────────────

  describe('getActions', () => {
    it('returns 4 actions', () => {
      const { bridge } = createBridge();
      const actions = bridge.getActions();
      expect(actions).toHaveLength(4);
    });

    it('each action has name, description, validate, handler, examples', () => {
      const { bridge } = createBridge();
      const actions = bridge.getActions();
      for (const action of actions) {
        expect(action.name).toBeTruthy();
        expect(action.description).toBeTruthy();
        expect(typeof action.validate).toBe('function');
        expect(typeof action.handler).toBe('function');
        expect(Array.isArray(action.examples)).toBe(true);
        expect(action.examples.length).toBeGreaterThan(0);
      }
    });

    it('includes THREADLINE_SEND, THREADLINE_DISCOVER, THREADLINE_HISTORY, THREADLINE_STATUS', () => {
      const { bridge } = createBridge();
      const names = bridge.getActions().map(a => a.name);
      expect(names).toContain('THREADLINE_SEND');
      expect(names).toContain('THREADLINE_DISCOVER');
      expect(names).toContain('THREADLINE_HISTORY');
      expect(names).toContain('THREADLINE_STATUS');
    });

    it('actions have non-empty examples arrays', () => {
      const { bridge } = createBridge();
      for (const action of bridge.getActions()) {
        for (const example of action.examples) {
          expect(Array.isArray(example)).toBe(true);
          expect(example.length).toBeGreaterThan(0);
          expect(example[0]).toHaveProperty('user');
          expect(example[0]).toHaveProperty('content.text');
        }
      }
    });
  });

  // ── 3. THREADLINE_SEND action ────────────────────────────────────────

  describe('THREADLINE_SEND action', () => {
    let action: OpenClawAction;
    let bridge: OpenClawBridge;
    let sendMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      const result = createBridge();
      bridge = result.bridge;
      sendMock = result.sendMock;
      action = bridge.getActions().find(a => a.name === 'THREADLINE_SEND')!;
    });

    it('validate returns true for non-empty text', async () => {
      const runtime = createMockRuntime();
      const message = createMockMessage({ content: { text: 'Hello' } });
      expect(await action.validate(runtime, message)).toBe(true);
    });

    it('validate returns false for empty text', async () => {
      const runtime = createMockRuntime();
      const message = createMockMessage({ content: { text: '' } });
      expect(await action.validate(runtime, message)).toBe(false);
    });

    it('validate returns false for whitespace-only text', async () => {
      const runtime = createMockRuntime();
      const message = createMockMessage({ content: { text: '   ' } });
      expect(await action.validate(runtime, message)).toBe(false);
    });

    it('validate returns false for undefined content text', async () => {
      const runtime = createMockRuntime();
      const message = createMockMessage({ content: { text: undefined as any } });
      expect(await action.validate(runtime, message)).toBe(false);
    });

    it('handler processes messages and returns response', async () => {
      const runtime = createMockRuntime();
      const message = createMockMessage({ content: { text: 'Test message' } });
      const result = await action.handler(runtime, message) as { text: string };
      expect(result.text).toContain('Echo: Test message');
    });

    it('handler returns error message on sendMessage failure', async () => {
      const failingSend = vi.fn(async () => { throw new Error('Network error'); });
      const b = new OpenClawBridge({ stateDir: tmpDir, sendMessage: failingSend });
      const failAction = b.getActions().find(a => a.name === 'THREADLINE_SEND')!;

      const runtime = createMockRuntime();
      const message = createMockMessage();
      const result = await failAction.handler(runtime, message) as { text: string };
      expect(result.text).toContain('[bridge-error]');
      expect(result.text).toContain('Network error');
    });

    it('handler increments messagesProcessed on success', async () => {
      const runtime = createMockRuntime();
      const message = createMockMessage();
      await action.handler(runtime, message);
      expect(bridge.getMetrics().messagesProcessed).toBe(1);
    });

    it('handler increments errors on failure', async () => {
      const failingSend = vi.fn(async () => { throw new Error('fail'); });
      const b = new OpenClawBridge({ stateDir: tmpDir, sendMessage: failingSend });
      const failAction = b.getActions().find(a => a.name === 'THREADLINE_SEND')!;

      await failAction.handler(createMockRuntime(), createMockMessage());
      expect(b.getMetrics().errors).toBe(1);
    });
  });

  // ── 4. THREADLINE_DISCOVER action ────────────────────────────────────

  describe('THREADLINE_DISCOVER action', () => {
    it('validate returns false when no discoverAgents configured', async () => {
      const { bridge } = createBridge();
      const action = bridge.getActions().find(a => a.name === 'THREADLINE_DISCOVER')!;
      const result = await action.validate(createMockRuntime(), createMockMessage());
      expect(result).toBe(false);
    });

    it('validate returns true when discoverAgents is configured', async () => {
      const { bridge } = createBridge({ discoverAgents: async () => [] });
      const action = bridge.getActions().find(a => a.name === 'THREADLINE_DISCOVER')!;
      const result = await action.validate(createMockRuntime(), createMockMessage());
      expect(result).toBe(true);
    });

    it('handler returns agent list', async () => {
      const agents: BridgeAgentInfo[] = [
        { name: 'agent-a', description: 'Research agent', trustLevel: 'verified' },
        { name: 'agent-b', description: 'Analysis agent', capabilities: ['summarize', 'analyze'] },
      ];
      const { bridge } = createBridge({ discoverAgents: async () => agents });
      const action = bridge.getActions().find(a => a.name === 'THREADLINE_DISCOVER')!;

      const result = await action.handler(createMockRuntime(), createMockMessage()) as { text: string };
      expect(result.text).toContain('agent-a');
      expect(result.text).toContain('agent-b');
      expect(result.text).toContain('verified');
      expect(result.text).toContain('summarize');
    });

    it('handler returns message for empty agent list', async () => {
      const { bridge } = createBridge({ discoverAgents: async () => [] });
      const action = bridge.getActions().find(a => a.name === 'THREADLINE_DISCOVER')!;

      const result = await action.handler(createMockRuntime(), createMockMessage()) as { text: string };
      expect(result.text).toContain('No Threadline agents');
    });

    it('handler returns error on discovery failure', async () => {
      const { bridge } = createBridge({
        discoverAgents: async () => { throw new Error('Discovery timeout'); },
      });
      const action = bridge.getActions().find(a => a.name === 'THREADLINE_DISCOVER')!;

      const result = await action.handler(createMockRuntime(), createMockMessage()) as { text: string };
      expect(result.text).toContain('[bridge-error]');
      expect(result.text).toContain('Discovery timeout');
    });

    it('handler increments errors on failure', async () => {
      const { bridge } = createBridge({
        discoverAgents: async () => { throw new Error('fail'); },
      });
      const action = bridge.getActions().find(a => a.name === 'THREADLINE_DISCOVER')!;
      await action.handler(createMockRuntime(), createMockMessage());
      expect(bridge.getMetrics().errors).toBe(1);
    });

    it('handler returns not-configured message when no discoverAgents', async () => {
      const { bridge } = createBridge();
      const action = bridge.getActions().find(a => a.name === 'THREADLINE_DISCOVER')!;
      const result = await action.handler(createMockRuntime(), createMockMessage()) as { text: string };
      expect(result.text).toContain('not configured');
    });

    it('handler formats agent with trust level and capabilities', async () => {
      const agents: BridgeAgentInfo[] = [
        { name: 'agent-x', trustLevel: 'trusted', capabilities: ['code', 'review'], description: 'Code reviewer' },
      ];
      const { bridge } = createBridge({ discoverAgents: async () => agents });
      const action = bridge.getActions().find(a => a.name === 'THREADLINE_DISCOVER')!;
      const result = await action.handler(createMockRuntime(), createMockMessage()) as { text: string };
      expect(result.text).toContain('[trust: trusted]');
      expect(result.text).toContain('code, review');
      expect(result.text).toContain('Code reviewer');
    });
  });

  // ── 5. THREADLINE_HISTORY action ─────────────────────────────────────

  describe('THREADLINE_HISTORY action', () => {
    it('validate returns false when no getHistory configured', async () => {
      const { bridge } = createBridge();
      const action = bridge.getActions().find(a => a.name === 'THREADLINE_HISTORY')!;
      expect(await action.validate(createMockRuntime(), createMockMessage())).toBe(false);
    });

    it('validate returns true when getHistory is configured and roomId present', async () => {
      const { bridge } = createBridge({ getHistory: async () => [] });
      const action = bridge.getActions().find(a => a.name === 'THREADLINE_HISTORY')!;
      expect(await action.validate(createMockRuntime(), createMockMessage())).toBe(true);
    });

    it('handler returns formatted history', async () => {
      const history: BridgeHistoryMessage[] = [
        { role: 'user', content: 'What is Threadline?', timestamp: '2026-03-09T10:00:00Z' },
        { role: 'agent', content: 'Threadline is a protocol...', timestamp: '2026-03-09T10:00:01Z' },
      ];

      const { bridge, sendMock } = createBridge({ getHistory: async () => history });
      // First send a message to establish thread mapping
      await bridge.processMessage(createMockRuntime(), createMockMessage());

      const action = bridge.getActions().find(a => a.name === 'THREADLINE_HISTORY')!;
      const result = await action.handler(createMockRuntime(), createMockMessage()) as { text: string };
      expect(result.text).toContain('Thread history');
      expect(result.text).toContain('What is Threadline?');
      expect(result.text).toContain('Threadline is a protocol...');
    });

    it('handler returns message when no thread exists', async () => {
      const { bridge } = createBridge({ getHistory: async () => [] });
      const action = bridge.getActions().find(a => a.name === 'THREADLINE_HISTORY')!;
      const result = await action.handler(createMockRuntime(), createMockMessage()) as { text: string };
      expect(result.text).toContain('No active thread');
    });

    it('handler returns message for empty history', async () => {
      const { bridge } = createBridge({ getHistory: async () => [] });
      // Establish thread first
      await bridge.processMessage(createMockRuntime(), createMockMessage());

      const action = bridge.getActions().find(a => a.name === 'THREADLINE_HISTORY')!;
      const result = await action.handler(createMockRuntime(), createMockMessage()) as { text: string };
      expect(result.text).toContain('No messages found');
    });

    it('handler returns error on getHistory failure', async () => {
      const { bridge } = createBridge({
        getHistory: async () => { throw new Error('Storage unavailable'); },
      });
      await bridge.processMessage(createMockRuntime(), createMockMessage());

      const action = bridge.getActions().find(a => a.name === 'THREADLINE_HISTORY')!;
      const result = await action.handler(createMockRuntime(), createMockMessage()) as { text: string };
      expect(result.text).toContain('[bridge-error]');
      expect(result.text).toContain('Storage unavailable');
    });

    it('handler increments errors on failure', async () => {
      const { bridge } = createBridge({
        getHistory: async () => { throw new Error('fail'); },
      });
      await bridge.processMessage(createMockRuntime(), createMockMessage());

      const action = bridge.getActions().find(a => a.name === 'THREADLINE_HISTORY')!;
      await action.handler(createMockRuntime(), createMockMessage());
      // 1 error from the history failure (processMessage succeeded, so +0 errors from that)
      expect(bridge.getMetrics().errors).toBe(1);
    });

    it('handler returns not-configured message when no getHistory', async () => {
      const { bridge } = createBridge();
      // Force a thread mapping via processMessage
      await bridge.processMessage(createMockRuntime(), createMockMessage());

      const action = bridge.getActions().find(a => a.name === 'THREADLINE_HISTORY')!;
      const result = await action.handler(createMockRuntime(), createMockMessage()) as { text: string };
      expect(result.text).toContain('not configured');
    });

    it('handler uses metadata.limit when provided', async () => {
      const historyFn = vi.fn(async (_threadId: string, limit?: number) => {
        return Array.from({ length: limit ?? 10 }, (_, i) => ({
          role: 'user' as const,
          content: `Message ${i}`,
          timestamp: new Date().toISOString(),
        }));
      });
      const { bridge } = createBridge({ getHistory: historyFn });
      await bridge.processMessage(createMockRuntime(), createMockMessage());

      const action = bridge.getActions().find(a => a.name === 'THREADLINE_HISTORY')!;
      const message = createMockMessage({ metadata: { limit: 5 } });
      await action.handler(createMockRuntime(), message);
      expect(historyFn).toHaveBeenCalledWith(expect.any(String), 5);
    });
  });

  // ── 6. THREADLINE_STATUS action ──────────────────────────────────────

  describe('THREADLINE_STATUS action', () => {
    it('always validates', async () => {
      const { bridge } = createBridge();
      const action = bridge.getActions().find(a => a.name === 'THREADLINE_STATUS')!;
      expect(await action.validate(createMockRuntime(), createMockMessage())).toBe(true);
    });

    it('returns status with bridge metrics', async () => {
      const { bridge } = createBridge();
      const action = bridge.getActions().find(a => a.name === 'THREADLINE_STATUS')!;
      const result = await action.handler(createMockRuntime(), createMockMessage()) as { text: string };
      expect(result.text).toContain('Threadline Bridge Status');
      expect(result.text).toContain('Bridge metrics');
      expect(result.text).toContain('0 processed');
    });

    it('returns status showing no active thread initially', async () => {
      const { bridge } = createBridge();
      const action = bridge.getActions().find(a => a.name === 'THREADLINE_STATUS')!;
      const result = await action.handler(createMockRuntime(), createMockMessage()) as { text: string };
      expect(result.text).toContain('no active thread');
    });

    it('returns status with trust info when trust manager configured', async () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      trustManager.setTrustLevel('user-1', 'verified', 'user-granted');
      trustManager.recordInteraction('user-1', true);

      const { bridge } = createBridge({ trustManager });
      const action = bridge.getActions().find(a => a.name === 'THREADLINE_STATUS')!;
      const result = await action.handler(createMockRuntime(), createMockMessage()) as { text: string };
      expect(result.text).toContain('Trust level: verified');
      expect(result.text).toContain('Interactions:');
    });

    it('returns status with compute info when compute meter configured', async () => {
      const computeMeter = new ComputeMeter({ stateDir: tmpDir });
      const { bridge } = createBridge({ computeMeter });
      const action = bridge.getActions().find(a => a.name === 'THREADLINE_STATUS')!;
      const result = await action.handler(createMockRuntime(), createMockMessage()) as { text: string };
      expect(result.text).toContain('Compute remaining');
      expect(result.text).toContain('hourly');
      expect(result.text).toContain('daily');
    });

    it('shows active thread after processMessage', async () => {
      const { bridge } = createBridge();
      await bridge.processMessage(createMockRuntime(), createMockMessage());

      const action = bridge.getActions().find(a => a.name === 'THREADLINE_STATUS')!;
      const result = await action.handler(createMockRuntime(), createMockMessage()) as { text: string };
      expect(result.text).toContain('openclaw-');
      expect(result.text).not.toContain('no active thread');
    });

    it('includes updated metrics after processing messages', async () => {
      const { bridge } = createBridge();
      await bridge.processMessage(createMockRuntime(), createMockMessage());
      await bridge.processMessage(createMockRuntime(), createMockMessage());

      const action = bridge.getActions().find(a => a.name === 'THREADLINE_STATUS')!;
      const result = await action.handler(createMockRuntime(), createMockMessage()) as { text: string };
      expect(result.text).toContain('2 processed');
      expect(result.text).toContain('1 active threads');
    });
  });

  // ── 7. processMessage ────────────────────────────────────────────────

  describe('processMessage', () => {
    it('routes through sendMessage callback', async () => {
      const { bridge, sendMock } = createBridge();
      const runtime = createMockRuntime();
      const message = createMockMessage({ content: { text: 'Hello world' } });
      await bridge.processMessage(runtime, message);
      expect(sendMock).toHaveBeenCalledOnce();
      expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Hello world',
        fromAgent: 'user-1',
      }));
    });

    it('returns response message from sendMessage', async () => {
      const { bridge } = createBridge();
      const result = await bridge.processMessage(createMockRuntime(), createMockMessage({ content: { text: 'Hi' } }));
      expect(result).toBe('Echo: Hi');
    });

    it('records compute usage after successful message', async () => {
      const computeMeter = new ComputeMeter({ stateDir: tmpDir });
      const { bridge } = createBridge({ computeMeter });
      await bridge.processMessage(createMockRuntime(), createMockMessage({ content: { text: 'Test' } }));

      // The response tokenCount = text.length * 2 = 8, but the bridge records that
      const state = computeMeter.getAgentState('user-1');
      expect(state).not.toBeNull();
      expect(state!.hourlyTokens).toBeGreaterThan(0);
    });

    it('records trust interactions on success', async () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      trustManager.setTrustLevel('user-1', 'verified', 'user-granted');

      const { bridge } = createBridge({ trustManager });
      await bridge.processMessage(createMockRuntime(), createMockMessage());

      const stats = trustManager.getInteractionStats('user-1');
      expect(stats!.messagesReceived).toBe(1);
      expect(stats!.successfulInteractions).toBe(1);
    });

    it('returns error on trust check failure', async () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      // user-1 remains untrusted — no 'message' permission
      trustManager.getOrCreateProfile('user-1');

      const { bridge } = createBridge({ trustManager });
      const result = await bridge.processMessage(createMockRuntime(), createMockMessage());
      expect(result).toContain('[bridge-error]');
      expect(result).toContain('does not have permission');
    });

    it('returns error on compute budget exceeded', async () => {
      const computeMeter = new ComputeMeter({
        stateDir: tmpDir,
        budgetOverrides: { untrusted: { hourlyTokenLimit: 1, dailyTokenLimit: 1 } },
      });
      const { bridge } = createBridge({ computeMeter });

      const result = await bridge.processMessage(createMockRuntime(), createMockMessage());
      expect(result).toContain('[bridge-error]');
      expect(result).toContain('Compute budget exceeded');
    });

    it('returns error on sendMessage failure', async () => {
      const failingSend = vi.fn(async () => { throw new Error('Connection refused'); });
      const bridge = new OpenClawBridge({ stateDir: tmpDir, sendMessage: failingSend });

      const result = await bridge.processMessage(createMockRuntime(), createMockMessage());
      expect(result).toContain('[bridge-error]');
      expect(result).toContain('Connection refused');
    });

    it('records failed trust interaction on sendMessage error', async () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      trustManager.setTrustLevel('user-1', 'verified', 'user-granted');

      const failingSend = vi.fn(async () => { throw new Error('fail'); });
      const bridge = new OpenClawBridge({ stateDir: tmpDir, sendMessage: failingSend, trustManager });

      await bridge.processMessage(createMockRuntime(), createMockMessage());
      const stats = trustManager.getInteractionStats('user-1');
      expect(stats!.failedInteractions).toBe(1);
    });

    it('increments messagesProcessed count', async () => {
      const { bridge } = createBridge();
      await bridge.processMessage(createMockRuntime(), createMockMessage());
      await bridge.processMessage(createMockRuntime(), createMockMessage());
      await bridge.processMessage(createMockRuntime(), createMockMessage());
      expect(bridge.getMetrics().messagesProcessed).toBe(3);
    });

    it('increments errors count on failure', async () => {
      const failingSend = vi.fn(async () => { throw new Error('fail'); });
      const bridge = new OpenClawBridge({ stateDir: tmpDir, sendMessage: failingSend });
      await bridge.processMessage(createMockRuntime(), createMockMessage());
      await bridge.processMessage(createMockRuntime(), createMockMessage());
      expect(bridge.getMetrics().errors).toBe(2);
    });

    it('sets isNewThread=true on first message for a room', async () => {
      const { bridge, sendMock } = createBridge();
      await bridge.processMessage(createMockRuntime(), createMockMessage());
      expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ isNewThread: true }));
    });

    it('sets isNewThread=false on subsequent messages for same room', async () => {
      const { bridge, sendMock } = createBridge();
      await bridge.processMessage(createMockRuntime(), createMockMessage());
      await bridge.processMessage(createMockRuntime(), createMockMessage());
      expect(sendMock).toHaveBeenLastCalledWith(expect.objectContaining({ isNewThread: false }));
    });
  });

  // ── 8. Thread mapping (in-memory) ───────────────────────────────────

  describe('thread mapping (in-memory)', () => {
    it('resolves new roomId to new threadId', async () => {
      const { bridge, sendMock } = createBridge();
      await bridge.processMessage(createMockRuntime(), createMockMessage({ roomId: 'room-new' }));
      const threadId = sendMock.mock.calls[0][0].threadId;
      expect(threadId).toMatch(/^openclaw-room-new-/);
    });

    it('reuses existing mapping for same room and agent', async () => {
      const { bridge, sendMock } = createBridge();
      await bridge.processMessage(createMockRuntime(), createMockMessage({ roomId: 'room-1' }));
      await bridge.processMessage(createMockRuntime(), createMockMessage({ roomId: 'room-1' }));
      expect(sendMock.mock.calls[0][0].threadId).toBe(sendMock.mock.calls[1][0].threadId);
    });

    it('different agents get different threads for same room', async () => {
      const { bridge, sendMock } = createBridge();
      await bridge.processMessage(createMockRuntime(), createMockMessage({ userId: 'agent-a', roomId: 'room-1' }));
      // Small wait to ensure different Date.now() for threadId generation
      await new Promise(r => setTimeout(r, 2));
      await bridge.processMessage(createMockRuntime(), createMockMessage({ userId: 'agent-b', roomId: 'room-1' }));
      // Different agents produce different mapping keys (roomId::agentId),
      // so they get independent thread assignments
      const threadA = bridge.getThreadId('room-1', 'agent-a');
      const threadB = bridge.getThreadId('room-1', 'agent-b');
      expect(threadA).not.toBeNull();
      expect(threadB).not.toBeNull();
      expect(threadA).not.toBe(threadB);
    });

    it('getThreadId returns null when no mapping exists', () => {
      const { bridge } = createBridge();
      expect(bridge.getThreadId('nonexistent', 'agent')).toBeNull();
    });

    it('getThreadId returns threadId after processMessage', async () => {
      const { bridge } = createBridge();
      await bridge.processMessage(createMockRuntime(), createMockMessage({ roomId: 'room-x', userId: 'user-x' }));
      const threadId = bridge.getThreadId('room-x', 'user-x');
      expect(threadId).toMatch(/^openclaw-room-x-/);
    });

    it('increments threadsActive on new thread creation', async () => {
      const { bridge } = createBridge();
      await bridge.processMessage(createMockRuntime(), createMockMessage({ roomId: 'room-1' }));
      expect(bridge.getMetrics().threadsActive).toBe(1);
      await bridge.processMessage(createMockRuntime(), createMockMessage({ roomId: 'room-2' }));
      expect(bridge.getMetrics().threadsActive).toBe(2);
    });

    it('does not increment threadsActive for existing thread', async () => {
      const { bridge } = createBridge();
      await bridge.processMessage(createMockRuntime(), createMockMessage({ roomId: 'room-1' }));
      await bridge.processMessage(createMockRuntime(), createMockMessage({ roomId: 'room-1' }));
      expect(bridge.getMetrics().threadsActive).toBe(1);
    });
  });

  // ── 9. Thread mapping with ContextThreadMap ──────────────────────────

  describe('thread mapping with ContextThreadMap', () => {
    it('uses ContextThreadMap when configured', async () => {
      const ctm = new ContextThreadMap({ stateDir: tmpDir });
      const { bridge, sendMock } = createBridge({ contextThreadMap: ctm });

      await bridge.processMessage(createMockRuntime(), createMockMessage({ roomId: 'room-ctm', userId: 'user-ctm' }));
      const threadId = sendMock.mock.calls[0][0].threadId;

      // Verify persisted in ContextThreadMap
      const resolved = ctm.getThreadId('room-ctm', 'user-ctm');
      expect(resolved).toBe(threadId);
    });

    it('reuses ContextThreadMap mapping for same room/agent', async () => {
      const ctm = new ContextThreadMap({ stateDir: tmpDir });
      const { bridge, sendMock } = createBridge({ contextThreadMap: ctm });

      await bridge.processMessage(createMockRuntime(), createMockMessage({ roomId: 'room-1', userId: 'u1' }));
      await bridge.processMessage(createMockRuntime(), createMockMessage({ roomId: 'room-1', userId: 'u1' }));
      expect(sendMock.mock.calls[0][0].threadId).toBe(sendMock.mock.calls[1][0].threadId);
    });

    it('falls back to in-memory when ContextThreadMap not configured', async () => {
      const { bridge, sendMock } = createBridge();
      await bridge.processMessage(createMockRuntime(), createMockMessage({ roomId: 'room-fallback' }));
      const threadId = sendMock.mock.calls[0][0].threadId;
      expect(threadId).toMatch(/^openclaw-room-fallback-/);
    });

    it('ContextThreadMap enforces identity binding', async () => {
      const ctm = new ContextThreadMap({ stateDir: tmpDir });
      const { bridge } = createBridge({ contextThreadMap: ctm });

      await bridge.processMessage(createMockRuntime(), createMockMessage({ roomId: 'room-1', userId: 'agent-a' }));

      // Different agent cannot see the thread
      expect(bridge.getThreadId('room-1', 'agent-b')).toBeNull();
    });

    it('getThreadId checks ContextThreadMap first', async () => {
      const ctm = new ContextThreadMap({ stateDir: tmpDir });
      ctm.set('room-pre', 'thread-pre', 'user-pre');

      const { bridge } = createBridge({ contextThreadMap: ctm });
      expect(bridge.getThreadId('room-pre', 'user-pre')).toBe('thread-pre');
    });
  });

  // ── 10. Trust integration ────────────────────────────────────────────

  describe('trust integration', () => {
    it('checkPermission blocks untrusted agents from messaging', async () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      const { bridge, sendMock } = createBridge({ trustManager });

      const result = await bridge.processMessage(createMockRuntime(), createMockMessage());
      expect(result).toContain('[bridge-error]');
      expect(result).toContain('does not have permission');
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('verified agents can send messages', async () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      trustManager.setTrustLevel('user-1', 'verified', 'user-granted');
      const { bridge, sendMock } = createBridge({ trustManager });

      const result = await bridge.processMessage(createMockRuntime(), createMockMessage());
      expect(result).not.toContain('[bridge-error]');
      expect(sendMock).toHaveBeenCalledOnce();
    });

    it('records interactions on success', async () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      trustManager.setTrustLevel('user-1', 'verified', 'user-granted');
      const { bridge } = createBridge({ trustManager });

      await bridge.processMessage(createMockRuntime(), createMockMessage());

      const stats = trustManager.getInteractionStats('user-1');
      expect(stats!.successfulInteractions).toBe(1);
      expect(stats!.messagesReceived).toBe(1);
    });

    it('records interactions on failure', async () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      trustManager.setTrustLevel('user-1', 'verified', 'user-granted');

      const failingSend = vi.fn(async () => { throw new Error('fail'); });
      const bridge = new OpenClawBridge({ stateDir: tmpDir, sendMessage: failingSend, trustManager });

      await bridge.processMessage(createMockRuntime(), createMockMessage());
      const stats = trustManager.getInteractionStats('user-1');
      expect(stats!.failedInteractions).toBe(1);
    });

    it('trusted agents can send messages', async () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      trustManager.setTrustLevel('user-1', 'trusted', 'user-granted');
      const { bridge } = createBridge({ trustManager });

      const result = await bridge.processMessage(createMockRuntime(), createMockMessage());
      expect(result).not.toContain('[bridge-error]');
    });

    it('autonomous agents can send messages', async () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      trustManager.setTrustLevel('user-1', 'autonomous', 'user-granted');
      const { bridge } = createBridge({ trustManager });

      const result = await bridge.processMessage(createMockRuntime(), createMockMessage());
      expect(result).not.toContain('[bridge-error]');
    });

    it('error message includes trust level', async () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      const { bridge } = createBridge({ trustManager });

      const result = await bridge.processMessage(createMockRuntime(), createMockMessage());
      expect(result).toContain('untrusted');
    });
  });

  // ── 11. Compute integration ──────────────────────────────────────────

  describe('compute integration', () => {
    it('check blocks when budget exceeded', async () => {
      const computeMeter = new ComputeMeter({
        stateDir: tmpDir,
        budgetOverrides: { untrusted: { hourlyTokenLimit: 1, dailyTokenLimit: 1 } },
      });
      const { bridge, sendMock } = createBridge({ computeMeter });

      const result = await bridge.processMessage(createMockRuntime(), createMockMessage());
      expect(result).toContain('[bridge-error]');
      expect(result).toContain('Compute budget exceeded');
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('record called after successful message', async () => {
      const computeMeter = new ComputeMeter({ stateDir: tmpDir });
      const { bridge } = createBridge({ computeMeter });
      await bridge.processMessage(createMockRuntime(), createMockMessage({ content: { text: 'Hello' } }));

      const state = computeMeter.getAgentState('user-1');
      expect(state).not.toBeNull();
      expect(state!.hourlyTokens).toBeGreaterThan(0);
    });

    it('compute not recorded on sendMessage failure', async () => {
      const computeMeter = new ComputeMeter({ stateDir: tmpDir });
      const failingSend = vi.fn(async () => { throw new Error('fail'); });
      const bridge = new OpenClawBridge({ stateDir: tmpDir, sendMessage: failingSend, computeMeter });

      await bridge.processMessage(createMockRuntime(), createMockMessage());
      const state = computeMeter.getAgentState('user-1');
      // Agent state may exist from the check() call but tokens should be 0
      // since record() was never called (error before that point)
      if (state) {
        expect(state.hourlyTokens).toBe(0);
      }
    });

    it('retryAfterSeconds included in budget error', async () => {
      const computeMeter = new ComputeMeter({
        stateDir: tmpDir,
        budgetOverrides: { untrusted: { hourlyTokenLimit: 1, dailyTokenLimit: 1 } },
      });
      const { bridge } = createBridge({ computeMeter });

      const result = await bridge.processMessage(createMockRuntime(), createMockMessage());
      expect(result).toContain('Retry after');
    });

    it('allows messages within budget', async () => {
      const computeMeter = new ComputeMeter({ stateDir: tmpDir });
      const { bridge } = createBridge({ computeMeter });
      const result = await bridge.processMessage(createMockRuntime(), createMockMessage());
      expect(result).not.toContain('[bridge-error]');
    });
  });

  // ── 12. getMetrics ───────────────────────────────────────────────────

  describe('getMetrics', () => {
    it('tracks messagesProcessed independently', async () => {
      const { bridge } = createBridge();
      await bridge.processMessage(createMockRuntime(), createMockMessage());
      const metrics = bridge.getMetrics();
      expect(metrics.messagesProcessed).toBe(1);
      expect(metrics.errors).toBe(0);
    });

    it('tracks threadsActive independently', async () => {
      const { bridge } = createBridge();
      await bridge.processMessage(createMockRuntime(), createMockMessage({ roomId: 'r1' }));
      await bridge.processMessage(createMockRuntime(), createMockMessage({ roomId: 'r2' }));
      await bridge.processMessage(createMockRuntime(), createMockMessage({ roomId: 'r3' }));
      expect(bridge.getMetrics().threadsActive).toBe(3);
    });

    it('tracks errors independently', async () => {
      const failingSend = vi.fn(async () => { throw new Error('fail'); });
      const bridge = new OpenClawBridge({ stateDir: tmpDir, sendMessage: failingSend });

      await bridge.processMessage(createMockRuntime(), createMockMessage());
      expect(bridge.getMetrics().errors).toBe(1);
      expect(bridge.getMetrics().messagesProcessed).toBe(0);
    });

    it('returns a copy, not reference', () => {
      const { bridge } = createBridge();
      const m1 = bridge.getMetrics();
      m1.messagesProcessed = 999;
      expect(bridge.getMetrics().messagesProcessed).toBe(0);
    });
  });

  // ── 13. resolveAgentIdentity ─────────────────────────────────────────

  describe('resolveAgentIdentity', () => {
    it('prefers message.userId', async () => {
      const { bridge, sendMock } = createBridge();
      const runtime = createMockRuntime({ agentId: 'runtime-agent' });
      const message = createMockMessage({ userId: 'message-user' });
      await bridge.processMessage(runtime, message);
      expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ fromAgent: 'message-user' }));
    });

    it('falls back to runtime.agentId when userId is empty', async () => {
      const { bridge, sendMock } = createBridge();
      const runtime = createMockRuntime({ agentId: 'runtime-agent' });
      const message = createMockMessage({ userId: '' });
      await bridge.processMessage(runtime, message);
      expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ fromAgent: 'runtime-agent' }));
    });
  });

  // ── Additional edge cases ────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles non-Error thrown by sendMessage', async () => {
      const failingSend = vi.fn(async () => { throw 'string error'; });
      const bridge = new OpenClawBridge({ stateDir: tmpDir, sendMessage: failingSend });

      const result = await bridge.processMessage(createMockRuntime(), createMockMessage());
      expect(result).toContain('[bridge-error]');
      expect(result).toContain('string error');
    });

    it('handles combined trust + compute checks', async () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      trustManager.setTrustLevel('user-1', 'verified', 'user-granted');
      const computeMeter = new ComputeMeter({ stateDir: tmpDir });

      const { bridge } = createBridge({ trustManager, computeMeter });
      const result = await bridge.processMessage(createMockRuntime(), createMockMessage());
      expect(result).not.toContain('[bridge-error]');
    });

    it('trust check happens before compute check', async () => {
      const trustManager = new AgentTrustManager({ stateDir: tmpDir });
      // untrusted — no message permission
      const computeMeter = new ComputeMeter({
        stateDir: tmpDir,
        budgetOverrides: { untrusted: { hourlyTokenLimit: 1, dailyTokenLimit: 1 } },
      });

      const { bridge } = createBridge({ trustManager, computeMeter });
      const result = await bridge.processMessage(createMockRuntime(), createMockMessage());
      // Should fail on trust, not compute
      expect(result).toContain('does not have permission');
    });

    it('handles very long message text', async () => {
      const { bridge } = createBridge();
      const longText = 'x'.repeat(100_000);
      const result = await bridge.processMessage(
        createMockRuntime(),
        createMockMessage({ content: { text: longText } }),
      );
      expect(result).toContain('Echo: ');
    });

    it('multiple rooms create independent threads', async () => {
      const { bridge, sendMock } = createBridge();
      const runtime = createMockRuntime();
      await bridge.processMessage(runtime, createMockMessage({ roomId: 'a', userId: 'u' }));
      await bridge.processMessage(runtime, createMockMessage({ roomId: 'b', userId: 'u' }));
      await bridge.processMessage(runtime, createMockMessage({ roomId: 'c', userId: 'u' }));

      const threads = sendMock.mock.calls.map((c: any) => c[0].threadId);
      expect(new Set(threads).size).toBe(3);
    });
  });
});
