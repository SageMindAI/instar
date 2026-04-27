/**
 * Unit tests for AgentBus — transport-agnostic message bus.
 *
 * Tests JSONL transport (file I/O, outbox/inbox, polling),
 * message creation, processIncoming (TTL, routing, broadcast),
 * request/response pattern, cleanExpired, and event emission.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentBus } from '../../src/core/AgentBus.js';
import type { AgentMessage, AgentBusConfig } from '../../src/core/AgentBus.js';

function makeBus(tmpDir: string, machineId = 'machine-a', overrides: Partial<AgentBusConfig> = {}): AgentBus {
  const stateDir = path.join(tmpDir, '.instar');
  return new AgentBus({
    stateDir,
    machineId,
    transport: 'jsonl',
    defaultTtlMs: 30 * 60 * 1000,
    pollIntervalMs: 50,
    ...overrides,
  });
}

describe('AgentBus', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bus-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Construction ────────────────────────────────────────────────

  describe('construction', () => {
    it('creates messages directory on init', () => {
      makeBus(tmpDir);
      const messagesDir = path.join(tmpDir, '.instar', 'state', 'messages');
      expect(fs.existsSync(messagesDir)).toBe(true);
    });

    it('exposes machineId and transport mode', () => {
      const bus = makeBus(tmpDir, 'test-machine');
      expect(bus.getMachineId()).toBe('test-machine');
      expect(bus.getTransportMode()).toBe('jsonl');
    });

    it('defaults to jsonl transport', () => {
      const bus = makeBus(tmpDir);
      expect(bus.getTransportMode()).toBe('jsonl');
    });
  });

  // ── Message Creation (send) ─────────────────────────────────────

  describe('send', () => {
    it('creates a message with correct fields', async () => {
      const bus = makeBus(tmpDir);
      const msg = await bus.send({
        type: 'heartbeat',
        to: 'machine-b',
        payload: { alive: true },
      });

      expect(msg.id).toMatch(/^msg_[a-f0-9]{16}$/);
      expect(msg.type).toBe('heartbeat');
      expect(msg.from).toBe('machine-a');
      expect(msg.to).toBe('machine-b');
      expect(msg.timestamp).toBeDefined();
      expect(new Date(msg.timestamp).getTime()).toBeLessThanOrEqual(Date.now());
      expect(msg.ttlMs).toBe(30 * 60 * 1000);
      expect(msg.payload).toEqual({ alive: true });
      expect(msg.status).toBe('pending');
    });

    it('uses custom TTL when provided', async () => {
      const bus = makeBus(tmpDir);
      const msg = await bus.send({
        type: 'heartbeat',
        to: 'machine-b',
        payload: {},
        ttlMs: 5000,
      });
      expect(msg.ttlMs).toBe(5000);
    });

    it('sets replyTo when provided', async () => {
      const bus = makeBus(tmpDir);
      const msg = await bus.send({
        type: 'negotiation-response',
        to: 'machine-b',
        payload: {},
        replyTo: 'msg_original123',
      });
      expect(msg.replyTo).toBe('msg_original123');
    });

    it('writes message to outbox JSONL file', async () => {
      const bus = makeBus(tmpDir);
      await bus.send({
        type: 'heartbeat',
        to: 'machine-b',
        payload: { test: true },
      });

      const outbox = bus.readOutbox();
      expect(outbox).toHaveLength(1);
      expect(outbox[0].type).toBe('heartbeat');
      expect(outbox[0].payload).toEqual({ test: true });
    });

    it('appends multiple messages to outbox', async () => {
      const bus = makeBus(tmpDir);
      await bus.send({ type: 'heartbeat', to: 'machine-b', payload: { n: 1 } });
      await bus.send({ type: 'heartbeat', to: 'machine-b', payload: { n: 2 } });
      await bus.send({ type: 'heartbeat', to: 'machine-c', payload: { n: 3 } });

      const outbox = bus.readOutbox();
      expect(outbox).toHaveLength(3);
    });

    it('writes broadcast messages to outbox in jsonl mode', async () => {
      const bus = makeBus(tmpDir);
      const msg = await bus.send({
        type: 'work-announcement',
        to: '*',
        payload: { task: 'testing' },
      });

      expect(msg.to).toBe('*');
      const outbox = bus.readOutbox();
      expect(outbox).toHaveLength(1);
      expect(outbox[0].to).toBe('*');
    });

    it('emits "sent" event', async () => {
      const bus = makeBus(tmpDir);
      const sentMessages: AgentMessage[] = [];
      bus.on('sent', (msg: AgentMessage) => sentMessages.push(msg));

      await bus.send({ type: 'heartbeat', to: 'machine-b', payload: {} });

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].type).toBe('heartbeat');
    });
  });

  // ── Receiving (processIncoming) ────────────────────────────────

  describe('processIncoming', () => {
    it('processes messages addressed to this machine', () => {
      const bus = makeBus(tmpDir, 'machine-a');
      const received: AgentMessage[] = [];
      bus.on('message', (msg: AgentMessage) => received.push(msg));

      bus.processIncoming([
        {
          id: 'msg_001',
          type: 'heartbeat',
          from: 'machine-b',
          to: 'machine-a',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: { alive: true },
          status: 'pending',
        },
      ]);

      expect(received).toHaveLength(1);
      expect(received[0].status).toBe('delivered');
    });

    it('processes broadcast messages from others', () => {
      const bus = makeBus(tmpDir, 'machine-a');
      const received: AgentMessage[] = [];
      bus.on('message', (msg: AgentMessage) => received.push(msg));

      bus.processIncoming([
        {
          id: 'msg_002',
          type: 'work-announcement',
          from: 'machine-b',
          to: '*',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: { task: 'hello' },
          status: 'pending',
        },
      ]);

      expect(received).toHaveLength(1);
    });

    it('skips messages addressed to other machines', () => {
      const bus = makeBus(tmpDir, 'machine-a');
      const received: AgentMessage[] = [];
      bus.on('message', (msg: AgentMessage) => received.push(msg));

      bus.processIncoming([
        {
          id: 'msg_003',
          type: 'heartbeat',
          from: 'machine-b',
          to: 'machine-c',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {},
          status: 'pending',
        },
      ]);

      expect(received).toHaveLength(0);
    });

    it('skips own broadcast messages', () => {
      const bus = makeBus(tmpDir, 'machine-a');
      const received: AgentMessage[] = [];
      bus.on('message', (msg: AgentMessage) => received.push(msg));

      bus.processIncoming([
        {
          id: 'msg_004',
          type: 'work-announcement',
          from: 'machine-a',
          to: '*',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {},
          status: 'pending',
        },
      ]);

      expect(received).toHaveLength(0);
    });

    it('expires messages past TTL and emits expired event', () => {
      const bus = makeBus(tmpDir, 'machine-a');
      const expired: AgentMessage[] = [];
      const received: AgentMessage[] = [];
      bus.on('expired', (msg: AgentMessage) => expired.push(msg));
      bus.on('message', (msg: AgentMessage) => received.push(msg));

      const pastTimestamp = new Date(Date.now() - 10000).toISOString();
      bus.processIncoming([
        {
          id: 'msg_005',
          type: 'heartbeat',
          from: 'machine-b',
          to: 'machine-a',
          timestamp: pastTimestamp,
          ttlMs: 5000, // 5s TTL, but message is 10s old
          payload: {},
          status: 'pending',
        },
      ]);

      expect(expired).toHaveLength(1);
      expect(expired[0].status).toBe('expired');
      expect(received).toHaveLength(0);
    });

    it('does not expire messages with ttlMs=0 (no expiration)', () => {
      const bus = makeBus(tmpDir, 'machine-a');
      const received: AgentMessage[] = [];
      bus.on('message', (msg: AgentMessage) => received.push(msg));

      const pastTimestamp = new Date(Date.now() - 100000).toISOString();
      bus.processIncoming([
        {
          id: 'msg_006',
          type: 'heartbeat',
          from: 'machine-b',
          to: 'machine-a',
          timestamp: pastTimestamp,
          ttlMs: 0, // No expiration
          payload: {},
          status: 'pending',
        },
      ]);

      expect(received).toHaveLength(1);
    });

    it('fires type-specific handlers via onMessage', () => {
      const bus = makeBus(tmpDir, 'machine-a');
      const heartbeats: AgentMessage[] = [];
      const announcements: AgentMessage[] = [];

      bus.onMessage('heartbeat', (msg) => heartbeats.push(msg));
      bus.onMessage('work-announcement', (msg) => announcements.push(msg));

      bus.processIncoming([
        {
          id: 'msg_hb',
          type: 'heartbeat',
          from: 'machine-b',
          to: 'machine-a',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {},
          status: 'pending',
        },
        {
          id: 'msg_wa',
          type: 'work-announcement',
          from: 'machine-b',
          to: 'machine-a',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: { task: 'test' },
          status: 'pending',
        },
      ]);

      expect(heartbeats).toHaveLength(1);
      expect(announcements).toHaveLength(1);
    });

    it('supports multiple handlers for the same type', () => {
      const bus = makeBus(tmpDir, 'machine-a');
      let count = 0;
      bus.onMessage('heartbeat', () => count++);
      bus.onMessage('heartbeat', () => count++);

      bus.processIncoming([
        {
          id: 'msg_multi',
          type: 'heartbeat',
          from: 'machine-b',
          to: 'machine-a',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {},
          status: 'pending',
        },
      ]);

      expect(count).toBe(2);
    });
  });

  // ── Request/Response Pattern ────────────────────────────────────

  describe('request', () => {
    it('resolves with reply matching replyTo', async () => {
      const bus = makeBus(tmpDir, 'machine-a');

      // Set up to simulate a reply being emitted
      const requestPromise = bus.request<{ question: string }, { answer: string }>({
        type: 'status-update',
        to: 'machine-b',
        payload: { question: 'status?' },
        timeoutMs: 1000,
      });

      // Get the outgoing message id
      const outbox = bus.readOutbox();
      const requestMsg = outbox[outbox.length - 1];

      // Simulate receiving a reply
      setTimeout(() => {
        bus.processIncoming([
          {
            id: 'msg_reply',
            type: 'status-update',
            from: 'machine-b',
            to: 'machine-a',
            timestamp: new Date().toISOString(),
            ttlMs: 60000,
            payload: { answer: 'all good' },
            replyTo: requestMsg.id,
            status: 'pending',
          },
        ]);
      }, 50);

      const reply = await requestPromise;
      expect(reply).not.toBeNull();
      expect(reply!.payload).toEqual({ answer: 'all good' });
      expect(reply!.replyTo).toBe(requestMsg.id);
    });

    it('resolves null on timeout', async () => {
      const bus = makeBus(tmpDir, 'machine-a');

      const result = await bus.request({
        type: 'status-update',
        to: 'machine-b',
        payload: { question: 'status?' },
        timeoutMs: 100, // Short timeout
      });

      expect(result).toBeNull();
    });

    it('ignores replies to other messages', async () => {
      const bus = makeBus(tmpDir, 'machine-a');

      const requestPromise = bus.request({
        type: 'status-update',
        to: 'machine-b',
        payload: {},
        timeoutMs: 200,
      });

      // Send a reply for a different message
      setTimeout(() => {
        bus.processIncoming([
          {
            id: 'msg_wrong_reply',
            type: 'status-update',
            from: 'machine-b',
            to: 'machine-a',
            timestamp: new Date().toISOString(),
            ttlMs: 60000,
            payload: {},
            replyTo: 'msg_someone_else',
            status: 'pending',
          },
        ]);
      }, 50);

      const result = await requestPromise;
      expect(result).toBeNull(); // Should timeout, not match wrong reply
    });
  });

  // ── HTTP Transport Endpoint ─────────────────────────────────────

  describe('handleHttpMessage', () => {
    it('accepts messages addressed to this machine', () => {
      const bus = makeBus(tmpDir, 'machine-a', { transport: 'http' });
      const received: AgentMessage[] = [];
      bus.on('message', (msg: AgentMessage) => received.push(msg));

      const accepted = bus.handleHttpMessage({
        id: 'msg_http1',
        type: 'heartbeat',
        from: 'machine-b',
        to: 'machine-a',
        timestamp: new Date().toISOString(),
        ttlMs: 60000,
        payload: {},
        status: 'pending',
      });

      expect(accepted).toBe(true);
      expect(received).toHaveLength(1);
    });

    it('accepts broadcast messages', () => {
      const bus = makeBus(tmpDir, 'machine-a', { transport: 'http' });
      const received: AgentMessage[] = [];
      bus.on('message', (msg: AgentMessage) => received.push(msg));

      const accepted = bus.handleHttpMessage({
        id: 'msg_http2',
        type: 'work-announcement',
        from: 'machine-b',
        to: '*',
        timestamp: new Date().toISOString(),
        ttlMs: 60000,
        payload: {},
        status: 'pending',
      });

      expect(accepted).toBe(true);
    });

    it('rejects messages addressed to other machines', () => {
      const bus = makeBus(tmpDir, 'machine-a', { transport: 'http' });

      const accepted = bus.handleHttpMessage({
        id: 'msg_http3',
        type: 'heartbeat',
        from: 'machine-b',
        to: 'machine-c',
        timestamp: new Date().toISOString(),
        ttlMs: 60000,
        payload: {},
        status: 'pending',
      });

      expect(accepted).toBe(false);
    });
  });

  // ── Outbox / Inbox ─────────────────────────────────────────────

  describe('outbox and inbox', () => {
    it('readOutbox returns empty when no messages sent', () => {
      const bus = makeBus(tmpDir);
      expect(bus.readOutbox()).toEqual([]);
    });

    it('readInbox returns empty when no messages received', () => {
      const bus = makeBus(tmpDir);
      expect(bus.readInbox()).toEqual([]);
    });

    it('readOutbox returns all sent messages', async () => {
      const bus = makeBus(tmpDir);
      await bus.send({ type: 'heartbeat', to: 'machine-b', payload: { n: 1 } });
      await bus.send({ type: 'heartbeat', to: 'machine-c', payload: { n: 2 } });

      const outbox = bus.readOutbox();
      expect(outbox).toHaveLength(2);
      expect(outbox[0].payload).toEqual({ n: 1 });
      expect(outbox[1].payload).toEqual({ n: 2 });
    });
  });

  // ── getPendingMessages ─────────────────────────────────────────

  describe('getPendingMessages', () => {
    it('reads messages from other machines outboxes', async () => {
      const busA = makeBus(tmpDir, 'machine-a');
      const busB = makeBus(tmpDir, 'machine-b');

      // Machine B sends a message to machine A
      // For getPendingMessages to work, we need to simulate per-machine outbox directories
      // The default JSONL writes to a flat outbox — getPendingMessages reads subdirectories
      // Let's simulate a machine-b subdirectory
      const messagesDir = path.join(tmpDir, '.instar', 'state', 'messages');
      const bOutboxDir = path.join(messagesDir, 'machine-b');
      fs.mkdirSync(bOutboxDir, { recursive: true });
      const bOutboxPath = path.join(bOutboxDir, 'outbox.jsonl');
      const msg: AgentMessage = {
        id: 'msg_pending1',
        type: 'heartbeat',
        from: 'machine-b',
        to: 'machine-a',
        timestamp: new Date().toISOString(),
        ttlMs: 60000,
        payload: { hello: true },
        status: 'pending',
      };
      fs.writeFileSync(bOutboxPath, JSON.stringify(msg) + '\n');

      const pending = busA.getPendingMessages();
      expect(pending).toHaveLength(1);
      expect(pending[0].from).toBe('machine-b');
      expect(pending[0].to).toBe('machine-a');
    });

    it('filters out messages not addressed to this machine', async () => {
      const busA = makeBus(tmpDir, 'machine-a');
      const messagesDir = path.join(tmpDir, '.instar', 'state', 'messages');
      const bOutboxDir = path.join(messagesDir, 'machine-b');
      fs.mkdirSync(bOutboxDir, { recursive: true });

      const msgs: AgentMessage[] = [
        {
          id: 'msg_p1',
          type: 'heartbeat',
          from: 'machine-b',
          to: 'machine-c', // Not for machine-a
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {},
          status: 'pending',
        },
        {
          id: 'msg_p2',
          type: 'heartbeat',
          from: 'machine-b',
          to: 'machine-a', // For machine-a
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {},
          status: 'pending',
        },
      ];
      fs.writeFileSync(
        path.join(bOutboxDir, 'outbox.jsonl'),
        msgs.map(m => JSON.stringify(m)).join('\n') + '\n',
      );

      const pending = busA.getPendingMessages();
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe('msg_p2');
    });

    it('includes broadcast messages from others', async () => {
      const busA = makeBus(tmpDir, 'machine-a');
      const messagesDir = path.join(tmpDir, '.instar', 'state', 'messages');
      const bOutboxDir = path.join(messagesDir, 'machine-b');
      fs.mkdirSync(bOutboxDir, { recursive: true });

      const msg: AgentMessage = {
        id: 'msg_bcast',
        type: 'work-announcement',
        from: 'machine-b',
        to: '*',
        timestamp: new Date().toISOString(),
        ttlMs: 60000,
        payload: {},
        status: 'pending',
      };
      fs.writeFileSync(path.join(bOutboxDir, 'outbox.jsonl'), JSON.stringify(msg) + '\n');

      const pending = busA.getPendingMessages();
      expect(pending).toHaveLength(1);
    });

    it('excludes own messages from own outbox subdirectory', async () => {
      const busA = makeBus(tmpDir, 'machine-a');
      const messagesDir = path.join(tmpDir, '.instar', 'state', 'messages');
      const aOutboxDir = path.join(messagesDir, 'machine-a');
      fs.mkdirSync(aOutboxDir, { recursive: true });

      const msg: AgentMessage = {
        id: 'msg_own',
        type: 'work-announcement',
        from: 'machine-a',
        to: '*',
        timestamp: new Date().toISOString(),
        ttlMs: 60000,
        payload: {},
        status: 'pending',
      };
      fs.writeFileSync(path.join(aOutboxDir, 'outbox.jsonl'), JSON.stringify(msg) + '\n');

      const pending = busA.getPendingMessages();
      expect(pending).toHaveLength(0);
    });

    it('returns empty when no subdirectories exist', () => {
      const bus = makeBus(tmpDir);
      expect(bus.getPendingMessages()).toEqual([]);
    });
  });

  // ── cleanExpired ────────────────────────────────────────────────

  describe('cleanExpired', () => {
    it('removes expired messages from outbox', async () => {
      const bus = makeBus(tmpDir);

      // Send a message with very short TTL
      await bus.send({ type: 'heartbeat', to: 'machine-b', payload: {}, ttlMs: 1 });

      // Wait for expiration
      await new Promise(r => setTimeout(r, 10));

      const removed = bus.cleanExpired();
      expect(removed).toBe(1);
      expect(bus.readOutbox()).toHaveLength(0);
    });

    it('keeps non-expired messages', async () => {
      const bus = makeBus(tmpDir);

      await bus.send({ type: 'heartbeat', to: 'machine-b', payload: {}, ttlMs: 60000 });

      const removed = bus.cleanExpired();
      expect(removed).toBe(0);
      expect(bus.readOutbox()).toHaveLength(1);
    });

    it('keeps messages with ttlMs=0 (no expiration)', async () => {
      const bus = makeBus(tmpDir);

      await bus.send({ type: 'heartbeat', to: 'machine-b', payload: {}, ttlMs: 0 });

      // Even after time passes, ttlMs=0 should never expire
      const removed = bus.cleanExpired();
      expect(removed).toBe(0);
      expect(bus.readOutbox()).toHaveLength(1);
    });

    it('returns correct count of expired messages', async () => {
      const bus = makeBus(tmpDir);

      // 2 expired, 1 alive
      await bus.send({ type: 'heartbeat', to: 'b', payload: { n: 1 }, ttlMs: 1 });
      await bus.send({ type: 'heartbeat', to: 'b', payload: { n: 2 }, ttlMs: 1 });
      await bus.send({ type: 'heartbeat', to: 'b', payload: { n: 3 }, ttlMs: 60000 });

      await new Promise(r => setTimeout(r, 10));

      const removed = bus.cleanExpired();
      expect(removed).toBe(2);
      expect(bus.readOutbox()).toHaveLength(1);
      expect(bus.readOutbox()[0].payload).toEqual({ n: 3 });
    });

    it('returns 0 when outbox is empty', () => {
      const bus = makeBus(tmpDir);
      expect(bus.cleanExpired()).toBe(0);
    });
  });

  // ── Polling ─────────────────────────────────────────────────────

  describe('polling', () => {
    it('startPolling and stopPolling lifecycle', async () => {
      const bus = makeBus(tmpDir, 'machine-a', { pollIntervalMs: 30 });

      // Write a message to inbox manually
      const inboxPath = path.join(tmpDir, '.instar', 'state', 'messages', 'inbox.jsonl');
      const msg: AgentMessage = {
        id: 'msg_poll1',
        type: 'heartbeat',
        from: 'machine-b',
        to: 'machine-a',
        timestamp: new Date().toISOString(),
        ttlMs: 60000,
        payload: { polled: true },
        status: 'pending',
      };
      fs.writeFileSync(inboxPath, JSON.stringify(msg) + '\n');

      const received: AgentMessage[] = [];
      bus.on('message', (m: AgentMessage) => received.push(m));

      bus.startPolling();

      // Wait for at least one poll cycle
      await new Promise(r => setTimeout(r, 100));

      bus.stopPolling();

      expect(received).toHaveLength(1);
      expect(received[0].payload).toEqual({ polled: true });
    });

    it('startPolling is idempotent (no double timers)', () => {
      const bus = makeBus(tmpDir, 'machine-a', { pollIntervalMs: 50 });
      bus.startPolling();
      bus.startPolling(); // Should not create a second timer
      bus.stopPolling();
      // No assertion needed — just verify no errors and clean stop
    });

    it('stopPolling is safe when not polling', () => {
      const bus = makeBus(tmpDir);
      // Should not throw
      bus.stopPolling();
    });

    it('clears inbox after processing', async () => {
      const bus = makeBus(tmpDir, 'machine-a', { pollIntervalMs: 30 });

      const inboxPath = path.join(tmpDir, '.instar', 'state', 'messages', 'inbox.jsonl');
      const msg: AgentMessage = {
        id: 'msg_clear1',
        type: 'heartbeat',
        from: 'machine-b',
        to: 'machine-a',
        timestamp: new Date().toISOString(),
        ttlMs: 60000,
        payload: {},
        status: 'pending',
      };
      fs.writeFileSync(inboxPath, JSON.stringify(msg) + '\n');

      bus.startPolling();
      await new Promise(r => setTimeout(r, 100));
      bus.stopPolling();

      // Inbox should be cleared after processing
      const inboxContent = fs.readFileSync(inboxPath, 'utf-8').trim();
      expect(inboxContent).toBe('');
    });
  });

  // ── Peer Registration ──────────────────────────────────────────

  describe('registerPeer', () => {
    it('registers a peer URL', () => {
      const bus = makeBus(tmpDir, 'machine-a', { transport: 'http' });
      bus.registerPeer('machine-b', 'http://localhost:3001');
      // Peer registration is internal — verify via HTTP send behavior
      // (Just verify it doesn't throw)
      expect(bus.getMachineId()).toBe('machine-a');
    });
  });

  // ── Edge Cases ──────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty JSONL file gracefully', () => {
      const bus = makeBus(tmpDir);
      const outboxPath = path.join(tmpDir, '.instar', 'state', 'messages', 'outbox.jsonl');
      fs.writeFileSync(outboxPath, '');

      expect(bus.readOutbox()).toEqual([]);
    });

    it('handles non-existent inbox file gracefully', () => {
      const bus = makeBus(tmpDir);
      expect(bus.readInbox()).toEqual([]);
    });

    it('processes multiple messages in one batch', () => {
      const bus = makeBus(tmpDir, 'machine-a');
      const received: AgentMessage[] = [];
      bus.on('message', (msg: AgentMessage) => received.push(msg));

      const messages: AgentMessage[] = Array.from({ length: 5 }, (_, i) => ({
        id: `msg_batch_${i}`,
        type: 'heartbeat' as const,
        from: 'machine-b',
        to: 'machine-a',
        timestamp: new Date().toISOString(),
        ttlMs: 60000,
        payload: { index: i },
        status: 'pending' as const,
      }));

      bus.processIncoming(messages);
      expect(received).toHaveLength(5);
    });
  });
});
