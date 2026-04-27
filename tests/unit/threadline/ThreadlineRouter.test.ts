import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ThreadlineRouter } from '../../../src/threadline/ThreadlineRouter.js';
import { ThreadResumeMap } from '../../../src/threadline/ThreadResumeMap.js';
import type { ThreadResumeEntry } from '../../../src/threadline/ThreadResumeMap.js';
import type { MessageEnvelope, AgentMessage, MessageThread } from '../../../src/messaging/types.js';
import type { SpawnResult } from '../../../src/messaging/SpawnRequestManager.js';

// ── Mock Factories ───────────────────────────────────────────────

function makeEnvelope(overrides: {
  threadId?: string;
  fromAgent?: string;
  subject?: string;
  body?: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
} = {}): MessageEnvelope {
  const now = new Date().toISOString();
  const messageId = crypto.randomUUID();
  return {
    schemaVersion: 1,
    message: {
      id: messageId,
      from: {
        agent: overrides.fromAgent ?? 'remote-agent',
        session: 'remote-session-1',
        machine: 'remote-machine',
      },
      to: {
        agent: 'local-agent',
        session: 'best',
        machine: 'local',
      },
      type: 'query',
      priority: overrides.priority ?? 'medium',
      subject: overrides.subject ?? 'Test Subject',
      body: overrides.body ?? 'Hello, this is a test message.',
      createdAt: now,
      ttlMinutes: 30,
      threadId: overrides.threadId,
    },
    transport: {
      relayChain: [],
      originServer: 'http://localhost:3001',
      nonce: `${crypto.randomUUID()}:${now}`,
      timestamp: now,
    },
    delivery: {
      phase: 'received',
      transitions: [{ from: 'sent', to: 'received', at: now }],
      attempts: 1,
    },
  };
}

function makeEntry(overrides: Partial<ThreadResumeEntry> = {}): ThreadResumeEntry {
  const now = new Date().toISOString();
  return {
    uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    sessionName: 'thread-test-session',
    createdAt: now,
    savedAt: now,
    lastAccessedAt: now,
    remoteAgent: 'remote-agent',
    subject: 'Existing Thread',
    state: 'idle',
    pinned: false,
    messageCount: 5,
    ...overrides,
  };
}

interface MockSpawnManager {
  evaluate: ReturnType<typeof vi.fn>;
  handleDenial: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
}

function createMockSpawnManager(approveByDefault = true): MockSpawnManager {
  return {
    evaluate: vi.fn().mockResolvedValue({
      approved: approveByDefault,
      sessionId: 'spawned-session-uuid',
      tmuxSession: 'spawned-tmux-session',
      reason: approveByDefault ? 'Session spawned' : 'Session limit reached',
    } as SpawnResult),
    handleDenial: vi.fn(),
    getStatus: vi.fn().mockReturnValue({ cooldowns: [], pendingRetries: 0 }),
    reset: vi.fn(),
  };
}

interface MockMessageRouter {
  getThread: ReturnType<typeof vi.fn>;
  relay: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  acknowledge: ReturnType<typeof vi.fn>;
  getMessage: ReturnType<typeof vi.fn>;
  getInbox: ReturnType<typeof vi.fn>;
  getOutbox: ReturnType<typeof vi.fn>;
  getDeadLetters: ReturnType<typeof vi.fn>;
  listThreads: ReturnType<typeof vi.fn>;
  resolveThread: ReturnType<typeof vi.fn>;
  getStats: ReturnType<typeof vi.fn>;
}

function createMockMessageRouter(): MockMessageRouter {
  return {
    getThread: vi.fn().mockResolvedValue(null),
    relay: vi.fn().mockResolvedValue(true),
    send: vi.fn(),
    acknowledge: vi.fn(),
    getMessage: vi.fn(),
    getInbox: vi.fn(),
    getOutbox: vi.fn(),
    getDeadLetters: vi.fn(),
    listThreads: vi.fn(),
    resolveThread: vi.fn(),
    getStats: vi.fn(),
  };
}

interface MockMessageStore {
  initialize: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  updateDelivery: ReturnType<typeof vi.fn>;
  queryInbox: ReturnType<typeof vi.fn>;
  queryOutbox: ReturnType<typeof vi.fn>;
  deadLetter: ReturnType<typeof vi.fn>;
  queryDeadLetters: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
  saveThread: ReturnType<typeof vi.fn>;
  getThread: ReturnType<typeof vi.fn>;
  listThreads: ReturnType<typeof vi.fn>;
  archiveThread: ReturnType<typeof vi.fn>;
  getStats: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

function createMockMessageStore(): MockMessageStore {
  return {
    initialize: vi.fn(),
    save: vi.fn(),
    get: vi.fn(),
    updateDelivery: vi.fn(),
    queryInbox: vi.fn(),
    queryOutbox: vi.fn(),
    deadLetter: vi.fn(),
    queryDeadLetters: vi.fn(),
    exists: vi.fn(),
    saveThread: vi.fn(),
    getThread: vi.fn(),
    listThreads: vi.fn(),
    archiveThread: vi.fn(),
    getStats: vi.fn(),
    cleanup: vi.fn(),
    destroy: vi.fn(),
  };
}

// ── Test Setup ──────────────────────────────────────────────────

function createTempDir(): { dir: string; stateDir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-router-test-'));
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    dir,
    stateDir,
    // safe-git-allow: incremental-migration
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Create a fake JSONL file so ThreadResumeMap.get() passes the JSONL check.
 */
function createFakeJsonl(uuid: string): void {
  const testProjectDir = path.join(os.homedir(), '.claude', 'projects', 'threadline-router-test');
  fs.mkdirSync(testProjectDir, { recursive: true });
  fs.writeFileSync(path.join(testProjectDir, `${uuid}.jsonl`), '{"test": true}\n');
}

function cleanupFakeJsonl(): void {
  const testProjectDir = path.join(os.homedir(), '.claude', 'projects', 'threadline-router-test');
  try {
    // safe-git-allow: incremental-migration
    fs.rmSync(testProjectDir, { recursive: true, force: true });
  } catch {
    // May not exist
  }
}

// ── Tests ────────────────────────────────────────────────────────

describe('ThreadlineRouter', () => {
  let temp: ReturnType<typeof createTempDir>;
  let threadResumeMap: ThreadResumeMap;
  let mockRouter: MockMessageRouter;
  let mockSpawnManager: MockSpawnManager;
  let mockStore: MockMessageStore;
  let router: ThreadlineRouter;

  const existingUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  beforeEach(() => {
    temp = createTempDir();
    threadResumeMap = new ThreadResumeMap(temp.stateDir, '/test/project');
    mockRouter = createMockMessageRouter();
    mockSpawnManager = createMockSpawnManager(true);
    mockStore = createMockMessageStore();
    createFakeJsonl(existingUuid);

    router = new ThreadlineRouter(
      mockRouter as any,
      mockSpawnManager as any,
      threadResumeMap,
      mockStore as any,
      { localAgent: 'local-agent', localMachine: 'local-machine' },
    );
  });

  afterEach(() => {
    temp.cleanup();
    cleanupFakeJsonl();
  });

  // ── Live-session injection (PR-4) ────────────────────────────

  describe('live-session injection', () => {
    it('injects into live session when messageDelivery is provided and succeeds', async () => {
      const threadId = crypto.randomUUID();
      threadResumeMap.save(threadId, makeEntry({ uuid: existingUuid, sessionName: 'live-sess' }));

      const mockDelivery = {
        deliverToSession: vi.fn().mockResolvedValue({ success: true, phase: 'delivered', shouldRetry: false }),
        checkInjectionSafety: vi.fn(),
        formatInline: vi.fn(),
        formatPointer: vi.fn(),
      };

      const injectingRouter = new ThreadlineRouter(
        mockRouter as any,
        mockSpawnManager as any,
        threadResumeMap,
        mockStore as any,
        { localAgent: 'local-agent', localMachine: 'local-machine' },
        null,
        mockDelivery as any,
      );

      const envelope = makeEnvelope({ threadId });
      const result = await injectingRouter.handleInboundMessage(envelope);

      expect(result.handled).toBe(true);
      expect(result.injected).toBe(true);
      expect(result.resumed).toBeUndefined();
      expect(result.spawned).toBeUndefined();
      expect(mockDelivery.deliverToSession).toHaveBeenCalledWith('live-sess', envelope);
      expect(mockSpawnManager.evaluate).not.toHaveBeenCalled();
    });

    it('falls back to resume when injection fails', async () => {
      const threadId = crypto.randomUUID();
      threadResumeMap.save(threadId, makeEntry({ uuid: existingUuid, sessionName: 'dead-sess' }));

      const mockDelivery = {
        deliverToSession: vi.fn().mockResolvedValue({
          success: false, phase: 'queued', failureReason: 'Session not alive', shouldRetry: true,
        }),
        checkInjectionSafety: vi.fn(),
        formatInline: vi.fn(),
        formatPointer: vi.fn(),
      };

      const injectingRouter = new ThreadlineRouter(
        mockRouter as any,
        mockSpawnManager as any,
        threadResumeMap,
        mockStore as any,
        { localAgent: 'local-agent', localMachine: 'local-machine' },
        null,
        mockDelivery as any,
      );

      const envelope = makeEnvelope({ threadId });
      const result = await injectingRouter.handleInboundMessage(envelope);

      expect(result.handled).toBe(true);
      expect(result.injected).toBeUndefined();
      expect(result.resumed).toBe(true);
      expect(mockDelivery.deliverToSession).toHaveBeenCalled();
      expect(mockSpawnManager.evaluate).toHaveBeenCalled();
    });

    it('falls back to spawn when no resume entry exists even with messageDelivery', async () => {
      const threadId = crypto.randomUUID();

      const mockDelivery = {
        deliverToSession: vi.fn(),
        checkInjectionSafety: vi.fn(),
        formatInline: vi.fn(),
        formatPointer: vi.fn(),
      };

      const injectingRouter = new ThreadlineRouter(
        mockRouter as any,
        mockSpawnManager as any,
        threadResumeMap,
        mockStore as any,
        { localAgent: 'local-agent', localMachine: 'local-machine' },
        null,
        mockDelivery as any,
      );

      const envelope = makeEnvelope({ threadId });
      const result = await injectingRouter.handleInboundMessage(envelope);

      expect(result.handled).toBe(true);
      expect(result.spawned).toBe(true);
      expect(mockDelivery.deliverToSession).not.toHaveBeenCalled();
    });
  });

  // ── Messages without threadId ────────────────────────────────
  // PR-2: First-contact messages without a threadId used to be dropped
  // (handled: false). They are now minted a new UUID and routed through
  // the normal spawn flow so the recipient actually sees them.

  describe('messages without threadId (first contact)', () => {
    it('mints a new threadId and spawns a new session', async () => {
      const envelope = makeEnvelope({ threadId: undefined });
      const result = await router.handleInboundMessage(envelope);
      expect(result.handled).toBe(true);
      expect(result.spawned).toBe(true);
      expect(result.threadId).toBeDefined();
      expect(result.threadId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(envelope.message.threadId).toBe(result.threadId);
    });

    it('calls spawnManager for first-contact messages', async () => {
      const envelope = makeEnvelope({ threadId: undefined });
      await router.handleInboundMessage(envelope);
      expect(mockSpawnManager.evaluate).toHaveBeenCalledOnce();
    });
  });

  // ── Messages from self ───────────────────────────────────────

  describe('self-delivery prevention', () => {
    it('returns handled: false for messages from the local agent', async () => {
      const envelope = makeEnvelope({
        threadId: crypto.randomUUID(),
        fromAgent: 'local-agent',
      });
      const result = await router.handleInboundMessage(envelope);
      expect(result.handled).toBe(false);
    });
  });

  // ── New thread creation ──────────────────────────────────────

  describe('new thread creation', () => {
    it('spawns a new session for unknown threadId', async () => {
      const threadId = crypto.randomUUID();
      const envelope = makeEnvelope({ threadId, subject: 'New Conversation' });

      const result = await router.handleInboundMessage(envelope);

      expect(result.handled).toBe(true);
      expect(result.spawned).toBe(true);
      expect(result.threadId).toBe(threadId);
      expect(mockSpawnManager.evaluate).toHaveBeenCalledOnce();
    });

    it('saves the thread resume mapping after spawn', async () => {
      const threadId = crypto.randomUUID();
      const envelope = makeEnvelope({ threadId, subject: 'Saved Thread' });

      await router.handleInboundMessage(envelope);

      // The entry should be saved (though get() checks JSONL existence)
      // We check the file directly
      const filePath = path.join(temp.stateDir, 'threadline', 'thread-resume-map.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(data[threadId]).toBeDefined();
      expect(data[threadId].subject).toBe('Saved Thread');
      expect(data[threadId].state).toBe('active');
      expect(data[threadId].remoteAgent).toBe('remote-agent');
      expect(data[threadId].messageCount).toBe(1);
    });

    it('includes the spawn prompt with subject and body', async () => {
      const threadId = crypto.randomUUID();
      const envelope = makeEnvelope({
        threadId,
        subject: 'Important Question',
        body: 'What is the meaning of life?',
      });

      await router.handleInboundMessage(envelope);

      const call = mockSpawnManager.evaluate.mock.calls[0][0];
      expect(call.context).toContain('Important Question');
      expect(call.context).toContain('What is the meaning of life?');
      expect(call.context).toContain('remote-agent');
    });

    it('sets correct spawn priority for critical messages', async () => {
      const threadId = crypto.randomUUID();
      const envelope = makeEnvelope({ threadId, priority: 'critical' });

      await router.handleInboundMessage(envelope);

      const call = mockSpawnManager.evaluate.mock.calls[0][0];
      expect(call.priority).toBe('critical');
    });

    it('sets medium spawn priority for non-critical messages', async () => {
      const threadId = crypto.randomUUID();
      const envelope = makeEnvelope({ threadId, priority: 'low' });

      await router.handleInboundMessage(envelope);

      const call = mockSpawnManager.evaluate.mock.calls[0][0];
      expect(call.priority).toBe('medium');
    });
  });

  // ── Existing thread resume ───────────────────────────────────

  describe('existing thread resume', () => {
    it('resumes an existing thread session', async () => {
      const threadId = crypto.randomUUID();
      // Pre-populate the resume map
      threadResumeMap.save(threadId, makeEntry({ uuid: existingUuid }));

      const envelope = makeEnvelope({ threadId });
      const result = await router.handleInboundMessage(envelope);

      expect(result.handled).toBe(true);
      expect(result.resumed).toBe(true);
      expect(result.threadId).toBe(threadId);
      expect(mockSpawnManager.evaluate).toHaveBeenCalledOnce();
    });

    it('updates the resume entry on resume', async () => {
      const threadId = crypto.randomUUID();
      threadResumeMap.save(threadId, makeEntry({
        uuid: existingUuid,
        messageCount: 5,
        state: 'idle',
      }));

      const envelope = makeEnvelope({ threadId });
      await router.handleInboundMessage(envelope);

      const filePath = path.join(temp.stateDir, 'threadline', 'thread-resume-map.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(data[threadId].state).toBe('active');
      expect(data[threadId].messageCount).toBe(6); // 5 + 1
    });

    it('includes thread history in resume prompt when available', async () => {
      const threadId = crypto.randomUUID();
      threadResumeMap.save(threadId, makeEntry({ uuid: existingUuid }));

      // Set up mock to return thread history
      const historyEnvelope = makeEnvelope({
        threadId,
        body: 'Previous message in this thread',
      });
      mockRouter.getThread.mockResolvedValue({
        thread: {
          id: threadId,
          subject: 'Test Thread',
          participants: [],
          createdAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
          messageCount: 1,
          status: 'active',
          messageIds: [historyEnvelope.message.id],
        } as MessageThread,
        messages: [historyEnvelope],
      });

      const envelope = makeEnvelope({ threadId, body: 'New message' });
      await router.handleInboundMessage(envelope);

      const call = mockSpawnManager.evaluate.mock.calls[0][0];
      expect(call.context).toContain('Previous message in this thread');
      expect(call.context).toContain('Recent thread history');
    });
  });

  // ── Spawn failure handling ───────────────────────────────────

  describe('spawn failure handling', () => {
    it('returns error when spawn is denied', async () => {
      mockSpawnManager.evaluate.mockResolvedValue({
        approved: false,
        reason: 'Session limit reached',
        retryAfterMs: 60_000,
      } as SpawnResult);

      const threadId = crypto.randomUUID();
      const envelope = makeEnvelope({ threadId });

      const result = await router.handleInboundMessage(envelope);

      expect(result.handled).toBe(true);
      expect(result.error).toContain('Session limit reached');
      expect(result.spawned).toBeUndefined();
      expect(result.resumed).toBeUndefined();
    });

    it('calls handleDenial on spawn manager when denied', async () => {
      mockSpawnManager.evaluate.mockResolvedValue({
        approved: false,
        reason: 'Memory pressure',
        retryAfterMs: 120_000,
      } as SpawnResult);

      const threadId = crypto.randomUUID();
      const envelope = makeEnvelope({ threadId });

      await router.handleInboundMessage(envelope);

      expect(mockSpawnManager.handleDenial).toHaveBeenCalledOnce();
    });

    it('does not save resume mapping when spawn fails', async () => {
      mockSpawnManager.evaluate.mockResolvedValue({
        approved: false,
        reason: 'Cooldown active',
      } as SpawnResult);

      const threadId = crypto.randomUUID();
      const envelope = makeEnvelope({ threadId });

      await router.handleInboundMessage(envelope);

      expect(threadResumeMap.size()).toBe(0);
    });

    it('handles spawnManager.evaluate throwing an error', async () => {
      mockSpawnManager.evaluate.mockRejectedValue(new Error('Spawn system crashed'));

      const threadId = crypto.randomUUID();
      const envelope = makeEnvelope({ threadId });

      const result = await router.handleInboundMessage(envelope);

      expect(result.handled).toBe(true);
      expect(result.error).toContain('Spawn system crashed');
    });
  });

  // ── Concurrent message handling ──────────────────────────────

  describe('concurrent message handling', () => {
    it('prevents duplicate spawns for the same thread', async () => {
      const threadId = crypto.randomUUID();

      // Make evaluate slow so we can test concurrency
      mockSpawnManager.evaluate.mockImplementation(() =>
        new Promise<SpawnResult>(resolve =>
          setTimeout(() => resolve({
            approved: true,
            sessionId: 'session-1',
            tmuxSession: 'tmux-1',
          }), 50),
        ),
      );

      const envelope1 = makeEnvelope({ threadId, body: 'First message' });
      const envelope2 = makeEnvelope({ threadId, body: 'Second message' });

      // Fire both concurrently
      const [result1, result2] = await Promise.all([
        router.handleInboundMessage(envelope1),
        router.handleInboundMessage(envelope2),
      ]);

      // One should succeed, one should get the concurrency guard
      const results = [result1, result2];
      const spawned = results.filter(r => r.spawned);
      const blocked = results.filter(r => r.error?.includes('Spawn already in progress'));

      expect(spawned.length + blocked.length).toBe(2);
      expect(spawned).toHaveLength(1);
      expect(blocked).toHaveLength(1);
    });

    it('allows spawns for different threads concurrently', async () => {
      const threadId1 = crypto.randomUUID();
      const threadId2 = crypto.randomUUID();

      const envelope1 = makeEnvelope({ threadId: threadId1, body: 'Thread 1' });
      const envelope2 = makeEnvelope({ threadId: threadId2, body: 'Thread 2' });

      const [result1, result2] = await Promise.all([
        router.handleInboundMessage(envelope1),
        router.handleInboundMessage(envelope2),
      ]);

      expect(result1.handled).toBe(true);
      expect(result1.spawned).toBe(true);
      expect(result2.handled).toBe(true);
      expect(result2.spawned).toBe(true);
      expect(mockSpawnManager.evaluate).toHaveBeenCalledTimes(2);
    });
  });

  // ── Session lifecycle events ─────────────────────────────────

  describe('onSessionEnd', () => {
    it('updates resume map with latest UUID and sets state to idle', async () => {
      const threadId = crypto.randomUUID();
      threadResumeMap.save(threadId, makeEntry({
        uuid: existingUuid,
        state: 'active',
      }));

      const newUuid = 'newuuid1-2222-3333-4444-555555555555';
      createFakeJsonl(newUuid);

      router.onSessionEnd(threadId, newUuid, 'updated-tmux-session');

      const filePath = path.join(temp.stateDir, 'threadline', 'thread-resume-map.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(data[threadId].uuid).toBe(newUuid);
      expect(data[threadId].state).toBe('idle');
      expect(data[threadId].sessionName).toBe('updated-tmux-session');
    });

    it('does nothing for unknown thread', () => {
      expect(() => router.onSessionEnd('unknown-thread', 'some-uuid', 'some-session')).not.toThrow();
    });
  });

  describe('onThreadResolved', () => {
    it('marks thread as resolved', () => {
      const threadId = crypto.randomUUID();
      threadResumeMap.save(threadId, makeEntry({ uuid: existingUuid, state: 'active' }));

      router.onThreadResolved(threadId);

      const filePath = path.join(temp.stateDir, 'threadline', 'thread-resume-map.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(data[threadId].state).toBe('resolved');
      expect(data[threadId].resolvedAt).toBeDefined();
    });
  });

  describe('onThreadFailed', () => {
    it('marks thread as failed', () => {
      const threadId = crypto.randomUUID();
      threadResumeMap.save(threadId, makeEntry({ uuid: existingUuid, state: 'active' }));

      router.onThreadFailed(threadId);

      const filePath = path.join(temp.stateDir, 'threadline', 'thread-resume-map.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(data[threadId].state).toBe('failed');
    });

    it('does nothing for unknown thread', () => {
      expect(() => router.onThreadFailed('unknown-thread')).not.toThrow();
    });
  });

  // ── Thread history injection ─────────────────────────────────

  describe('thread history injection', () => {
    it('handles empty thread history gracefully', async () => {
      const threadId = crypto.randomUUID();
      mockRouter.getThread.mockResolvedValue(null);

      const envelope = makeEnvelope({ threadId });
      const result = await router.handleInboundMessage(envelope);

      expect(result.handled).toBe(true);
      expect(result.spawned).toBe(true);
      // The prompt should still work without history
      const call = mockSpawnManager.evaluate.mock.calls[0][0];
      expect(call.context).toContain('No previous history available');
    });

    it('handles getThread error gracefully', async () => {
      const threadId = crypto.randomUUID();
      mockRouter.getThread.mockRejectedValue(new Error('Store failure'));

      const envelope = makeEnvelope({ threadId });
      const result = await router.handleInboundMessage(envelope);

      // Should still handle the message, just without history
      expect(result.handled).toBe(true);
      expect(result.spawned).toBe(true);
    });

    it('limits history to maxHistoryMessages', async () => {
      const threadId = crypto.randomUUID();

      // Create 30 history messages
      const messages: MessageEnvelope[] = [];
      for (let i = 0; i < 30; i++) {
        messages.push(makeEnvelope({
          threadId,
          body: `History message ${i}`,
          fromAgent: i % 2 === 0 ? 'remote-agent' : 'local-agent',
        }));
      }

      mockRouter.getThread.mockResolvedValue({
        thread: {
          id: threadId,
          subject: 'Long Thread',
          participants: [],
          createdAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
          messageCount: 30,
          status: 'active',
          messageIds: messages.map(m => m.message.id),
        },
        messages,
      });

      const envelope = makeEnvelope({ threadId });
      await router.handleInboundMessage(envelope);

      const call = mockSpawnManager.evaluate.mock.calls[0][0];
      // Default maxHistoryMessages is 20, so only last 20 of 30 should appear
      expect(call.context).toContain('20 of 30 messages');
      // Message 10 (the 11th) should be the first one included (30 - 20 = 10)
      expect(call.context).toContain('History message 10');
      // Message 0 should NOT be included
      expect(call.context).not.toContain('History message 0\n');
    });

    it('respects custom maxHistoryMessages config', async () => {
      const customRouter = new ThreadlineRouter(
        mockRouter as any,
        mockSpawnManager as any,
        threadResumeMap,
        mockStore as any,
        { localAgent: 'local-agent', localMachine: 'local-machine', maxHistoryMessages: 5 },
      );

      const threadId = crypto.randomUUID();
      const messages: MessageEnvelope[] = [];
      for (let i = 0; i < 10; i++) {
        messages.push(makeEnvelope({ threadId, body: `Msg ${i}` }));
      }

      mockRouter.getThread.mockResolvedValue({
        thread: {
          id: threadId,
          subject: 'Custom Limit',
          participants: [],
          createdAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
          messageCount: 10,
          status: 'active',
          messageIds: messages.map(m => m.message.id),
        },
        messages,
      });

      const envelope = makeEnvelope({ threadId });
      await customRouter.handleInboundMessage(envelope);

      const call = mockSpawnManager.evaluate.mock.calls[0][0];
      expect(call.context).toContain('5 of 10 messages');
    });
  });

  // ── Edge cases ───────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles envelope with empty message body', async () => {
      const threadId = crypto.randomUUID();
      const envelope = makeEnvelope({ threadId, body: '' });

      const result = await router.handleInboundMessage(envelope);
      expect(result.handled).toBe(true);
      expect(result.spawned).toBe(true);
    });

    it('handles very long subject lines', async () => {
      const threadId = crypto.randomUUID();
      const longSubject = 'A'.repeat(200);
      const envelope = makeEnvelope({ threadId, subject: longSubject });

      const result = await router.handleInboundMessage(envelope);
      expect(result.handled).toBe(true);
      expect(result.spawned).toBe(true);

      const call = mockSpawnManager.evaluate.mock.calls[0][0];
      expect(call.context).toContain(longSubject);
    });

    it('cleans up pendingSpawns set even on error', async () => {
      const threadId = crypto.randomUUID();
      mockSpawnManager.evaluate.mockRejectedValue(new Error('Boom'));

      const envelope = makeEnvelope({ threadId });
      await router.handleInboundMessage(envelope);

      // Should be able to spawn again for the same thread (set was cleaned up)
      mockSpawnManager.evaluate.mockResolvedValue({
        approved: true,
        sessionId: 'retry-session',
        tmuxSession: 'retry-tmux',
      });

      const result = await router.handleInboundMessage(envelope);
      // Should not get "Spawn already in progress" error — either no error or a different one
      if (result.error) {
        expect(result.error).not.toContain('Spawn already in progress');
      } else {
        expect(result.spawned).toBe(true);
      }
    });
  });
});
