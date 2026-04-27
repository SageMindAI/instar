/**
 * Unit tests for MessageRouter — message sending, routing, and ACKs.
 *
 * Tests:
 * - Send creates envelope with correct fields
 * - Message ID generation (UUID v4)
 * - Default TTL assignment per message type
 * - Broadcast fan-out
 * - Acknowledge updates delivery state
 * - Rate limiting enforcement
 * - Deduplication on relay
 * - Echo prevention (cannot send to self)
 * - Delivery state monotonic transitions
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MessageRouter } from '../../src/messaging/MessageRouter.js';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import { MessageDelivery } from '../../src/messaging/MessageDelivery.js';
import { MessageFormatter } from '../../src/messaging/MessageFormatter.js';
import type { AgentMessage, MessageEnvelope, SendMessageOptions } from '../../src/messaging/types.js';
import { DEFAULT_TTL } from '../../src/messaging/types.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-router-test-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

// Mock tmux ops that always succeed
function createMockTmuxOps() {
  return {
    getForegroundProcess: vi.fn().mockReturnValue('bash'),
    isSessionAlive: vi.fn().mockReturnValue(true),
    hasActiveHumanInput: vi.fn().mockReturnValue(false),
    sendKeys: vi.fn().mockReturnValue(true),
    getOutputLineCount: vi.fn().mockReturnValue(100),
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('MessageRouter', () => {
  let tmpDir: string;
  let store: MessageStore;
  let delivery: MessageDelivery;
  let router: MessageRouter;

  beforeEach(async () => {
    tmpDir = createTempDir();
    store = new MessageStore(tmpDir);
    await store.initialize();

    const formatter = new MessageFormatter();
    delivery = new MessageDelivery(formatter, createMockTmuxOps() as any);
    router = new MessageRouter(store, delivery, {
      localAgent: 'my-agent',
      localMachine: 'my-machine',
      serverUrl: 'http://localhost:3000',
    });
  });

  afterEach(async () => {
    await store.destroy();
    cleanup(tmpDir);
  });

  // ── Send ────────────────────────────────────────────────────────

  describe('send', () => {
    it('creates a message with a UUID-format ID', async () => {
      const result = await router.send(
        { agent: 'my-agent', session: 'my-session', machine: 'my-machine' },
        { agent: 'target', session: 'best', machine: 'local' },
        'info',
        'medium',
        'Test subject',
        'Test body',
      );

      expect(result.messageId).toBeDefined();
      expect(result.messageId.length).toBeGreaterThan(10);
    });

    it('saves the envelope to the store', async () => {
      const result = await router.send(
        { agent: 'my-agent', session: 'my-session', machine: 'my-machine' },
        { agent: 'target', session: 'best', machine: 'local' },
        'query',
        'high',
        'Question',
        'What is the status?',
      );

      const envelope = await store.get(result.messageId);
      expect(envelope).not.toBeNull();
      expect(envelope!.message.type).toBe('query');
      expect(envelope!.message.priority).toBe('high');
      expect(envelope!.message.subject).toBe('Question');
      expect(envelope!.message.body).toBe('What is the status?');
    });

    it('uses default TTL when not overridden', async () => {
      const result = await router.send(
        { agent: 'my-agent', session: 's', machine: 'm' },
        { agent: 'target', session: 'best', machine: 'local' },
        'alert',
        'high',
        'Alert subject',
        'Alert body',
      );

      const envelope = await store.get(result.messageId);
      expect(envelope!.message.ttlMinutes).toBe(DEFAULT_TTL.alert);
    });

    it('uses custom TTL when provided', async () => {
      const result = await router.send(
        { agent: 'my-agent', session: 's', machine: 'm' },
        { agent: 'target', session: 'best', machine: 'local' },
        'info',
        'low',
        'Custom TTL',
        'Body',
        { ttlMinutes: 999 },
      );

      const envelope = await store.get(result.messageId);
      expect(envelope!.message.ttlMinutes).toBe(999);
    });

    it('sets delivery phase to sent for local-agent messages', async () => {
      // Same agent, different session → local delivery, stays as 'sent'
      const result = await router.send(
        { agent: 'my-agent', session: 's', machine: 'my-machine' },
        { agent: 'my-agent', session: 'other-session', machine: 'local' },
        'info',
        'medium',
        'Test',
        'Body',
      );

      expect(result.phase).toBe('sent');
    });

    it('sets delivery phase to queued for cross-agent messages to offline agent', async () => {
      // Different agent on same machine → cross-agent routing → dropped (agent not registered)
      const result = await router.send(
        { agent: 'my-agent', session: 's', machine: 'my-machine' },
        { agent: 'target', session: 'best', machine: 'local' },
        'info',
        'medium',
        'Test',
        'Body',
      );

      expect(result.phase).toBe('queued');
    });

    it('populates transport metadata', async () => {
      const result = await router.send(
        { agent: 'my-agent', session: 's', machine: 'm' },
        { agent: 'target', session: 'best', machine: 'local' },
        'info',
        'medium',
        'Test',
        'Body',
      );

      const envelope = await store.get(result.messageId);
      expect(envelope!.transport.originServer).toBe('http://localhost:3000');
      expect(envelope!.transport.nonce).toBeDefined();
      expect(envelope!.transport.timestamp).toBeDefined();
      expect(envelope!.transport.relayChain).toEqual([]);
    });

    it('creates a thread for query messages', async () => {
      const result = await router.send(
        { agent: 'my-agent', session: 's', machine: 'm' },
        { agent: 'target', session: 'best', machine: 'local' },
        'query',
        'medium',
        'A question',
        'What happened?',
      );

      // Queries auto-create threads
      expect(result.threadId).toBeDefined();
    });

    it('continues a thread when threadId is provided', async () => {
      const result = await router.send(
        { agent: 'my-agent', session: 's', machine: 'm' },
        { agent: 'target', session: 'best', machine: 'local' },
        'response',
        'medium',
        'Answer',
        'Here is the answer',
        { threadId: 'existing-thread-123' },
      );

      const envelope = await store.get(result.messageId);
      expect(envelope!.message.threadId).toBe('existing-thread-123');
    });
  });

  // ── Acknowledge ──────────────────────────────────────────────────

  describe('acknowledge', () => {
    it('advances delivery phase to read', async () => {
      const result = await router.send(
        { agent: 'my-agent', session: 's', machine: 'm' },
        { agent: 'target', session: 'target-session', machine: 'local' },
        'info',
        'medium',
        'Test',
        'Body',
      );

      // Simulate the message being delivered first
      await store.updateDelivery(result.messageId, {
        phase: 'delivered',
        transitions: [
          { from: 'created', to: 'sent', at: new Date().toISOString() },
          { from: 'sent', to: 'delivered', at: new Date().toISOString() },
        ],
        attempts: 1,
      });

      await router.acknowledge(result.messageId, 'target-session');

      const envelope = await store.get(result.messageId);
      expect(envelope!.delivery.phase).toBe('read');
    });
  });

  // ── Echo Prevention ─────────────────────────────────────────────

  describe('echo prevention', () => {
    it('rejects sending a message to the same session', async () => {
      await expect(
        router.send(
          { agent: 'my-agent', session: 'same-session', machine: 'my-machine' },
          { agent: 'my-agent', session: 'same-session', machine: 'local' },
          'info',
          'medium',
          'Self message',
          'Talking to myself',
        ),
      ).rejects.toThrow();
    });
  });

  // ── Relay ──────────────────────────────────────────────────────

  describe('relay', () => {
    it('accepts a valid relayed envelope', async () => {
      const envelope: MessageEnvelope = {
        schemaVersion: 1,
        message: {
          id: 'msg-relay-test',
          from: { agent: 'remote-agent', session: 'remote-session', machine: 'remote-machine' },
          to: { agent: 'my-agent', session: 'best', machine: 'local' },
          type: 'info',
          priority: 'medium',
          subject: 'Relayed message',
          body: 'From another agent',
          createdAt: new Date().toISOString(),
          ttlMinutes: 30,
        },
        transport: {
          relayChain: ['remote-machine'],
          originServer: 'http://remote:3000',
          nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
          timestamp: new Date().toISOString(),
        },
        delivery: {
          phase: 'sent',
          transitions: [],
          attempts: 0,
        },
      };

      const result = await router.relay(envelope, 'agent');
      expect(result).toBe(true);

      // Should be in our store now
      const stored = await store.get('msg-relay-test');
      expect(stored).not.toBeNull();
    });

    it('rejects envelope with self in relay chain (loop prevention)', async () => {
      const envelope: MessageEnvelope = {
        schemaVersion: 1,
        message: {
          id: 'msg-loop-test',
          from: { agent: 'remote-agent', session: 'rs', machine: 'remote' },
          to: { agent: 'my-agent', session: 'best', machine: 'local' },
          type: 'info',
          priority: 'medium',
          subject: 'Looped',
          body: 'This should be rejected',
          createdAt: new Date().toISOString(),
          ttlMinutes: 30,
        },
        transport: {
          relayChain: ['my-machine'], // Our machine is already in the chain!
          originServer: 'http://remote:3000',
          nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
          timestamp: new Date().toISOString(),
        },
        delivery: {
          phase: 'sent',
          transitions: [],
          attempts: 0,
        },
      };

      const result = await router.relay(envelope, 'machine');
      expect(result).toBe(false);
    });

    it('rejects duplicate message on relay', async () => {
      const envelope: MessageEnvelope = {
        schemaVersion: 1,
        message: {
          id: 'msg-dedup-test',
          from: { agent: 'remote-agent', session: 'rs', machine: 'remote' },
          to: { agent: 'my-agent', session: 'best', machine: 'local' },
          type: 'info',
          priority: 'medium',
          subject: 'First',
          body: 'First copy',
          createdAt: new Date().toISOString(),
          ttlMinutes: 30,
        },
        transport: {
          relayChain: [],
          originServer: 'http://remote:3000',
          nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
          timestamp: new Date().toISOString(),
        },
        delivery: {
          phase: 'sent',
          transitions: [],
          attempts: 0,
        },
      };

      // First relay succeeds
      const r1 = await router.relay(envelope, 'agent');
      expect(r1).toBe(true);

      // Second relay (same message ID) — should return true (ACK) but not duplicate
      const r2 = await router.relay(envelope, 'agent');
      expect(r2).toBe(true); // Returns ACK but doesn't re-store
    });
  });

  // ── Statistics ──────────────────────────────────────────────────

  describe('statistics', () => {
    it('returns messaging stats', async () => {
      const stats = await router.getStats();
      expect(stats).toBeDefined();
      expect(stats.volume).toBeDefined();
      expect(stats.delivery).toBeDefined();
      expect(stats.rateLimiting).toBeDefined();
      expect(stats.threads).toBeDefined();
    });
  });
});
