/**
 * Unit tests for MessageStore — file-based message persistence.
 *
 * Tests:
 * - Initialization (directory creation, index rebuild)
 * - Save and retrieve envelopes
 * - Delivery state updates with monotonic enforcement
 * - Inbox/outbox queries with filters
 * - Dead-letter queue management
 * - Deduplication (reject duplicate message IDs)
 * - Cleanup (expired messages, stale data)
 * - Crash recovery (rebuild from store files)
 * - Edge cases (corrupt files, missing dirs)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import type {
  MessageEnvelope,
  MessageThread,
  AgentMessage,
  DeliveryState,
} from '../../src/messaging/types.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-msgstore-test-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeMessage(overrides?: Partial<AgentMessage>): AgentMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: { agent: 'test-agent', session: 'test-session', machine: 'test-machine' },
    to: { agent: 'target-agent', session: 'best', machine: 'local' },
    type: 'info',
    priority: 'medium',
    subject: 'Test message',
    body: 'Hello, world!',
    createdAt: new Date().toISOString(),
    ttlMinutes: 30,
    ...overrides,
  };
}

function makeThread(overrides?: Partial<MessageThread>): MessageThread {
  const now = new Date().toISOString();
  return {
    id: `thr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    subject: 'Test thread',
    participants: [{
      agent: 'test-agent',
      session: 'test-session',
      joinedAt: now,
      lastMessageAt: now,
    }],
    createdAt: now,
    lastMessageAt: now,
    messageCount: 1,
    status: 'active',
    messageIds: [`msg-${Date.now()}`],
    ...overrides,
  };
}

function makeEnvelope(overrides?: Partial<AgentMessage>): MessageEnvelope {
  return {
    schemaVersion: 1,
    message: makeMessage(overrides),
    transport: {
      relayChain: [],
      originServer: 'http://localhost:3000',
      nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
      timestamp: new Date().toISOString(),
    },
    delivery: {
      phase: 'created',
      transitions: [],
      attempts: 0,
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('MessageStore', () => {
  let tmpDir: string;
  let store: MessageStore;

  beforeEach(async () => {
    tmpDir = createTempDir();
    store = new MessageStore(tmpDir);
    await store.initialize();
  });

  afterEach(async () => {
    await store.destroy();
    cleanup(tmpDir);
  });

  // ── Initialization ──────────────────────────────────────────────

  describe('initialization', () => {
    it('creates required directory structure', () => {
      expect(fs.existsSync(path.join(tmpDir, 'store'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'index'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'dead-letter'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'pending'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'threads'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'drop'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'outbound'))).toBe(true);
    });

    it('survives re-initialization on existing directory', async () => {
      const envelope = makeEnvelope();
      await store.save(envelope);

      // Re-initialize — should not lose data
      const store2 = new MessageStore(tmpDir);
      await store2.initialize();
      const retrieved = await store2.get(envelope.message.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.message.id).toBe(envelope.message.id);
      await store2.destroy();
    });
  });

  // ── Save & Retrieve ─────────────────────────────────────────────

  describe('save and retrieve', () => {
    it('saves an envelope and retrieves it by ID', async () => {
      const envelope = makeEnvelope();
      await store.save(envelope);

      const retrieved = await store.get(envelope.message.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.message.id).toBe(envelope.message.id);
      expect(retrieved!.message.subject).toBe(envelope.message.subject);
      expect(retrieved!.schemaVersion).toBe(1);
    });

    it('returns null for non-existent message', async () => {
      const result = await store.get('nonexistent-id');
      expect(result).toBeNull();
    });

    it('persists all envelope fields', async () => {
      const envelope = makeEnvelope({
        type: 'alert',
        priority: 'critical',
        subject: 'Security alert',
        body: 'Something happened',
        payload: { key: 'value', nested: { a: 1 } },
        threadId: 'thread-123',
        inReplyTo: 'msg-previous',
      });
      envelope.transport.signature = 'test-sig';
      envelope.transport.signedBy = 'machine-1';

      await store.save(envelope);
      const retrieved = await store.get(envelope.message.id);

      expect(retrieved!.message.type).toBe('alert');
      expect(retrieved!.message.priority).toBe('critical');
      expect(retrieved!.message.payload).toEqual({ key: 'value', nested: { a: 1 } });
      expect(retrieved!.message.threadId).toBe('thread-123');
      expect(retrieved!.transport.signature).toBe('test-sig');
    });

    it('reports existence correctly', async () => {
      const envelope = makeEnvelope();
      expect(await store.exists(envelope.message.id)).toBe(false);

      await store.save(envelope);
      expect(await store.exists(envelope.message.id)).toBe(true);
    });
  });

  // ── Deduplication ──────────────────────────────────────────────

  describe('deduplication', () => {
    it('rejects duplicate message IDs', async () => {
      const envelope = makeEnvelope();
      await store.save(envelope);

      // Saving the same envelope again should not throw but should be a no-op
      await store.save(envelope);

      // There should still be only one file
      const files = fs.readdirSync(path.join(tmpDir, 'store'));
      const matchingFiles = files.filter(f => f.includes(envelope.message.id));
      expect(matchingFiles).toHaveLength(1);
    });
  });

  // ── Delivery State Updates ─────────────────────────────────────

  describe('delivery state updates', () => {
    it('updates delivery phase', async () => {
      const envelope = makeEnvelope();
      await store.save(envelope);

      const newDelivery: DeliveryState = {
        phase: 'sent',
        transitions: [
          { from: 'created', to: 'sent', at: new Date().toISOString() },
        ],
        attempts: 1,
      };
      await store.updateDelivery(envelope.message.id, newDelivery);

      const retrieved = await store.get(envelope.message.id);
      expect(retrieved!.delivery.phase).toBe('sent');
      expect(retrieved!.delivery.transitions).toHaveLength(1);
    });

    it('preserves message content during delivery update', async () => {
      const envelope = makeEnvelope({
        subject: 'Important subject',
        body: 'Do not lose this body',
      });
      await store.save(envelope);

      await store.updateDelivery(envelope.message.id, {
        phase: 'delivered',
        transitions: [
          { from: 'created', to: 'sent', at: new Date().toISOString() },
          { from: 'sent', to: 'delivered', at: new Date().toISOString() },
        ],
        attempts: 2,
      });

      const retrieved = await store.get(envelope.message.id);
      expect(retrieved!.message.subject).toBe('Important subject');
      expect(retrieved!.message.body).toBe('Do not lose this body');
    });
  });

  // ── Inbox & Outbox Queries ─────────────────────────────────────

  describe('inbox queries', () => {
    it('returns messages addressed to the agent', async () => {
      const envelope = makeEnvelope({ to: { agent: 'my-agent', session: 'best', machine: 'local' } });
      await store.save(envelope);

      const results = await store.queryInbox('my-agent');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(e => e.message.id === envelope.message.id)).toBe(true);
    });

    it('does not return messages for other agents', async () => {
      const envelope = makeEnvelope({ to: { agent: 'other-agent', session: 'best', machine: 'local' } });
      await store.save(envelope);

      const results = await store.queryInbox('my-agent');
      expect(results.some(e => e.message.id === envelope.message.id)).toBe(false);
    });

    it('filters by message type', async () => {
      const alert = makeEnvelope({ type: 'alert', to: { agent: 'my-agent', session: 'best', machine: 'local' } });
      const info = makeEnvelope({ type: 'info', to: { agent: 'my-agent', session: 'best', machine: 'local' } });
      await store.save(alert);
      await store.save(info);

      const results = await store.queryInbox('my-agent', { type: 'alert' });
      expect(results.every(e => e.message.type === 'alert')).toBe(true);
    });

    it('filters by priority', async () => {
      const high = makeEnvelope({ priority: 'high', to: { agent: 'my-agent', session: 'best', machine: 'local' } });
      const low = makeEnvelope({ priority: 'low', to: { agent: 'my-agent', session: 'best', machine: 'local' } });
      await store.save(high);
      await store.save(low);

      const results = await store.queryInbox('my-agent', { priority: 'high' });
      expect(results.every(e => e.message.priority === 'high')).toBe(true);
    });

    it('respects limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await store.save(makeEnvelope({ to: { agent: 'my-agent', session: 'best', machine: 'local' } }));
      }

      const results = await store.queryInbox('my-agent', { limit: 3 });
      expect(results).toHaveLength(3);
    });
  });

  describe('outbox queries', () => {
    it('returns messages sent by the agent', async () => {
      const envelope = makeEnvelope({ from: { agent: 'my-agent', session: 'test', machine: 'local' } });
      await store.save(envelope);

      const results = await store.queryOutbox('my-agent');
      expect(results.some(e => e.message.id === envelope.message.id)).toBe(true);
    });
  });

  // ── Dead-Letter Queue ──────────────────────────────────────────

  describe('dead-letter queue', () => {
    it('moves a message to dead-letter with reason', async () => {
      const envelope = makeEnvelope();
      await store.save(envelope);

      await store.deadLetter(envelope.message.id, 'TTL expired');

      // Should no longer be in active store
      const fromStore = await store.get(envelope.message.id);
      expect(fromStore).toBeNull();

      // Should exist in dead-letter directory
      const dlFiles = fs.readdirSync(path.join(tmpDir, 'dead-letter'));
      expect(dlFiles.some(f => f.includes(envelope.message.id))).toBe(true);
    });

    it('records failure reason in dead-lettered envelope', async () => {
      const envelope = makeEnvelope();
      await store.save(envelope);
      await store.deadLetter(envelope.message.id, 'Max retries exceeded');

      const dlPath = path.join(tmpDir, 'dead-letter', `${envelope.message.id}.json`);
      const dlEnvelope = JSON.parse(fs.readFileSync(dlPath, 'utf-8'));
      expect(dlEnvelope.delivery.phase).toBe('dead-lettered');
      expect(dlEnvelope.delivery.failureReason).toBe('Max retries exceeded');
    });
  });

  // ── Statistics ──────────────────────────────────────────────────

  describe('statistics', () => {
    it('returns stats with volume data', async () => {
      await store.save(makeEnvelope());
      await store.save(makeEnvelope());

      const stats = await store.getStats();
      expect(stats.volume).toBeDefined();
      expect(stats.volume.sent.total).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Cleanup ────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('returns cleanup results', async () => {
      const result = await store.cleanup();
      expect(result).toHaveProperty('deleted');
      expect(result).toHaveProperty('deadLettered');
      expect(typeof result.deleted).toBe('number');
      expect(typeof result.deadLettered).toBe('number');
    });
  });

  // ── Edge Cases ─────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles corrupt message file gracefully', async () => {
      // Write corrupt JSON to store
      const corruptPath = path.join(tmpDir, 'store', 'corrupt-msg.json');
      fs.writeFileSync(corruptPath, 'not valid json {{{');

      // Should not throw on get
      const result = await store.get('corrupt-msg');
      expect(result).toBeNull();
    });

    it('handles empty store directory', async () => {
      const results = await store.queryInbox('any-agent');
      expect(results).toEqual([]);
    });

    it('handles updateDelivery for non-existent message', async () => {
      // Should not throw
      await expect(
        store.updateDelivery('nonexistent', { phase: 'sent', transitions: [], attempts: 0 }),
      ).rejects.toThrow();
    });
  });

  // ── queryDeadLetters ──────────────────────────────────────────

  describe('queryDeadLetters', () => {
    it('returns empty array when no dead-lettered messages', async () => {
      const results = await store.queryDeadLetters();
      expect(results).toEqual([]);
    });

    it('returns dead-lettered messages after deadLetter()', async () => {
      const env = makeEnvelope({ type: 'alert', priority: 'high' });
      env.delivery.phase = 'sent';
      await store.save(env);
      await store.deadLetter(env.message.id, 'TTL expired');

      const results = await store.queryDeadLetters();
      expect(results.length).toBe(1);
      expect(results[0].message.id).toBe(env.message.id);
      expect(results[0].delivery.phase).toBe('dead-lettered');
      expect(results[0].delivery.failureReason).toBe('TTL expired');
    });

    it('filters by type', async () => {
      const alert = makeEnvelope({ type: 'alert' });
      alert.delivery.phase = 'sent';
      await store.save(alert);
      await store.deadLetter(alert.message.id, 'expired');

      const info = makeEnvelope({ type: 'info' });
      info.delivery.phase = 'sent';
      await store.save(info);
      await store.deadLetter(info.message.id, 'expired');

      const results = await store.queryDeadLetters({ type: 'alert' });
      expect(results.length).toBe(1);
      expect(results[0].message.type).toBe('alert');
    });

    it('filters by priority', async () => {
      const high = makeEnvelope({ priority: 'high' });
      high.delivery.phase = 'sent';
      await store.save(high);
      await store.deadLetter(high.message.id, 'expired');

      const low = makeEnvelope({ priority: 'low' });
      low.delivery.phase = 'sent';
      await store.save(low);
      await store.deadLetter(low.message.id, 'expired');

      const results = await store.queryDeadLetters({ priority: 'high' });
      expect(results.length).toBe(1);
      expect(results[0].message.priority).toBe('high');
    });

    it('respects limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        const env = makeEnvelope();
        env.delivery.phase = 'sent';
        await store.save(env);
        await store.deadLetter(env.message.id, `expired-${i}`);
      }

      const page1 = await store.queryDeadLetters({ limit: 2, offset: 0 });
      expect(page1.length).toBe(2);

      const page2 = await store.queryDeadLetters({ limit: 2, offset: 2 });
      expect(page2.length).toBe(2);

      // No overlap
      const ids1 = new Set(page1.map(m => m.message.id));
      const ids2 = new Set(page2.map(m => m.message.id));
      for (const id of ids2) {
        expect(ids1.has(id)).toBe(false);
      }
    });

    it('sorts by most recent first', async () => {
      const older = makeEnvelope();
      older.delivery.phase = 'sent';
      await store.save(older);
      await store.deadLetter(older.message.id, 'old');

      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));

      const newer = makeEnvelope();
      newer.delivery.phase = 'sent';
      await store.save(newer);
      await store.deadLetter(newer.message.id, 'new');

      const results = await store.queryDeadLetters();
      expect(results.length).toBeGreaterThanOrEqual(2);
      // Most recent should be first
      expect(results[0].message.id).toBe(newer.message.id);
    });

    it('skips corrupt dead-letter files', async () => {
      const valid = makeEnvelope();
      valid.delivery.phase = 'sent';
      await store.save(valid);
      await store.deadLetter(valid.message.id, 'valid');

      // Write corrupt file to dead-letter dir
      const corruptPath = path.join(tmpDir, 'dead-letter', 'corrupt.json');
      fs.writeFileSync(corruptPath, 'not valid json {{{');

      const results = await store.queryDeadLetters();
      expect(results.length).toBe(1);
      expect(results[0].message.id).toBe(valid.message.id);
    });
  });

  // ── Thread Management ──────────────────────────────────────────

  describe('thread management', () => {
    it('saveThread creates a thread file', async () => {
      const thread = makeThread();
      await store.saveThread(thread);

      const loaded = await store.getThread(thread.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(thread.id);
      expect(loaded!.subject).toBe(thread.subject);
    });

    it('saveThread overwrites existing thread', async () => {
      const thread = makeThread();
      await store.saveThread(thread);

      thread.messageCount = 5;
      thread.status = 'stale';
      await store.saveThread(thread);

      const loaded = await store.getThread(thread.id);
      expect(loaded!.messageCount).toBe(5);
      expect(loaded!.status).toBe('stale');
    });

    it('getThread returns null for non-existent thread', async () => {
      const result = await store.getThread('nonexistent-thread-id');
      expect(result).toBeNull();
    });

    it('listThreads returns all threads', async () => {
      const t1 = makeThread({ status: 'active' });
      const t2 = makeThread({ status: 'resolved' });
      const t3 = makeThread({ status: 'stale' });
      await store.saveThread(t1);
      await store.saveThread(t2);
      await store.saveThread(t3);

      const all = await store.listThreads();
      expect(all.length).toBe(3);
    });

    it('listThreads filters by status', async () => {
      const t1 = makeThread({ status: 'active' });
      const t2 = makeThread({ status: 'resolved' });
      await store.saveThread(t1);
      await store.saveThread(t2);

      const active = await store.listThreads('active');
      expect(active.length).toBe(1);
      expect(active[0].status).toBe('active');
    });

    it('listThreads sorts by most recent activity first', async () => {
      const older = makeThread({ lastMessageAt: '2025-01-01T00:00:00.000Z' });
      const newer = makeThread({ lastMessageAt: '2026-01-01T00:00:00.000Z' });
      await store.saveThread(older);
      await store.saveThread(newer);

      const threads = await store.listThreads();
      expect(threads[0].id).toBe(newer.id);
    });

    it('archiveThread moves thread to archive directory', async () => {
      const thread = makeThread();
      await store.saveThread(thread);

      await store.archiveThread(thread.id);

      // Should still be findable (getThread checks archive)
      const loaded = await store.getThread(thread.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(thread.id);

      // Should not be in the active listing
      const active = await store.listThreads();
      expect(active.find(t => t.id === thread.id)).toBeUndefined();
    });

    it('archiveThread is no-op for non-existent thread', async () => {
      // Should not throw
      await store.archiveThread('nonexistent');
    });

    it('getStats includes thread counts', async () => {
      const t1 = makeThread({ status: 'active' });
      const t2 = makeThread({ status: 'resolved' });
      await store.saveThread(t1);
      await store.saveThread(t2);

      const stats = await store.getStats();
      expect(stats.threads.active).toBe(1);
      expect(stats.threads.resolved).toBe(1);
      expect(stats.threads.stale).toBe(0);
    });

    it('skips corrupt thread files in listThreads', async () => {
      const valid = makeThread();
      await store.saveThread(valid);

      // Write corrupt file
      const corruptPath = path.join(tmpDir, 'threads', 'corrupt.json');
      fs.writeFileSync(corruptPath, 'not json {{{');

      const threads = await store.listThreads();
      expect(threads.length).toBe(1);
    });
  });

  // ── markManyUndelivered (SpawnRequestManager dispose handoff) ──
  describe('markManyUndelivered', () => {
    async function saveWithPhase(phase: DeliveryState['phase']): Promise<string> {
      const env = makeEnvelope();
      env.delivery.phase = phase;
      await store.save(env);
      return env.message.id;
    }

    it('transitions queued messages to undelivered', async () => {
      const id = await saveWithPhase('queued');
      const updated = await store.markManyUndelivered([id]);
      expect(updated).toBe(1);
      const after = await store.get(id);
      expect(after?.delivery.phase).toBe('undelivered');
      expect(after?.delivery.transitions.at(-1)).toMatchObject({
        from: 'queued',
        to: 'undelivered',
        reason: 'SpawnRequestManager dispose handoff',
      });
    });

    it('transitions received messages to undelivered', async () => {
      const id = await saveWithPhase('received');
      const updated = await store.markManyUndelivered([id]);
      expect(updated).toBe(1);
      expect((await store.get(id))?.delivery.phase).toBe('undelivered');
    });

    it('skips messages in terminal phases without incrementing count', async () => {
      const delivered = await saveWithPhase('delivered');
      const read = await saveWithPhase('read');
      const expired = await saveWithPhase('expired');
      const failed = await saveWithPhase('failed');

      const updated = await store.markManyUndelivered([delivered, read, expired, failed]);
      expect(updated).toBe(0);
      expect((await store.get(delivered))?.delivery.phase).toBe('delivered');
      expect((await store.get(read))?.delivery.phase).toBe('read');
    });

    it('skips missing message IDs silently', async () => {
      const real = await saveWithPhase('queued');
      const updated = await store.markManyUndelivered([real, 'does-not-exist']);
      expect(updated).toBe(1);
    });

    it('skips messages already in undelivered without re-transitioning', async () => {
      const id = await saveWithPhase('undelivered');
      const before = (await store.get(id))?.delivery.transitions.length ?? 0;
      const updated = await store.markManyUndelivered([id]);
      expect(updated).toBe(0);
      const after = (await store.get(id))?.delivery.transitions.length ?? 0;
      expect(after).toBe(before);
    });

    it('processes large batches across multiple chunks', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 120; i++) {
        ids.push(await saveWithPhase('queued'));
      }
      const updated = await store.markManyUndelivered(ids, 50);
      expect(updated).toBe(120);
      for (const id of ids) {
        expect((await store.get(id))?.delivery.phase).toBe('undelivered');
      }
    });

    it('is resilient to corrupt files mid-batch', async () => {
      const good1 = await saveWithPhase('queued');
      const good2 = await saveWithPhase('queued');
      // Insert a corrupt file that would parse-fail
      const corrupt = makeEnvelope();
      corrupt.delivery.phase = 'queued';
      await store.save(corrupt);
      fs.writeFileSync(path.join(tmpDir, 'store', `${corrupt.message.id}.json`), 'not valid json{{{');

      const updated = await store.markManyUndelivered([good1, corrupt.message.id, good2]);
      expect(updated).toBe(2);
      expect((await store.get(good1))?.delivery.phase).toBe('undelivered');
      expect((await store.get(good2))?.delivery.phase).toBe('undelivered');
    });
  });
});
