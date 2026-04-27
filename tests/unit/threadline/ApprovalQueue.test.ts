import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ApprovalQueue } from '../../../src/threadline/ApprovalQueue.js';
import type { MessageEnvelope } from '../../../src/messaging/types.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTempDir(): { stateDir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-queue-test-'));
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    stateDir,
    // safe-git-allow: incremental-migration
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function makeEnvelope(overrides: Partial<MessageEnvelope['message']> = {}): MessageEnvelope {
  return {
    schemaVersion: 1,
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 10)}`,
      from: { agent: 'test-sender', session: 'sess-1', machine: 'mach-1' },
      to: { agent: 'test-receiver', session: 'best', machine: 'local' },
      type: 'request',
      priority: 'medium',
      subject: 'Test Subject',
      body: 'Test body content for the message',
      createdAt: new Date().toISOString(),
      ttlMinutes: 30,
      ...overrides,
    },
    transport: {
      relayChain: [],
      originServer: 'http://localhost:3030',
      nonce: 'test-nonce',
      timestamp: new Date().toISOString(),
    },
    delivery: {
      phase: 'received',
      transitions: [],
      attempts: 0,
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('ApprovalQueue', () => {
  let temp: ReturnType<typeof createTempDir>;
  let queue: ApprovalQueue;

  beforeEach(() => {
    temp = createTempDir();
    queue = new ApprovalQueue(temp.stateDir);
  });

  afterEach(() => {
    temp.cleanup();
  });

  describe('enqueue', () => {
    it('should add a message to the queue and return an approval ID', () => {
      const envelope = makeEnvelope();
      const id = queue.enqueue(envelope);

      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('should store the message details correctly', () => {
      const envelope = makeEnvelope({
        subject: 'Important Request',
        body: 'Please process this',
        threadId: 'thread-123',
      });
      const id = queue.enqueue(envelope);

      const entry = queue.getEntry(id);
      expect(entry).not.toBeNull();
      expect(entry!.subject).toBe('Important Request');
      expect(entry!.body).toBe('Please process this');
      expect(entry!.threadId).toBe('thread-123');
      expect(entry!.fromAgent).toBe('test-sender');
      expect(entry!.status).toBe('pending');
      expect(entry!.ttlMinutes).toBe(30);
    });

    it('should truncate long message bodies', () => {
      const longBody = 'x'.repeat(1000);
      const envelope = makeEnvelope({ body: longBody });
      const id = queue.enqueue(envelope);

      const entry = queue.getEntry(id);
      expect(entry!.body.length).toBe(500);
    });

    it('should handle multiple enqueued messages', () => {
      queue.enqueue(makeEnvelope({ subject: 'First' }));
      queue.enqueue(makeEnvelope({ subject: 'Second' }));
      queue.enqueue(makeEnvelope({ subject: 'Third' }));

      const pending = queue.getQueue('pending');
      expect(pending).toHaveLength(3);
    });
  });

  describe('approve', () => {
    it('should mark a pending entry as approved', () => {
      const id = queue.enqueue(makeEnvelope());
      const entry = queue.approve(id);

      expect(entry).not.toBeNull();
      expect(entry!.status).toBe('approved');
      expect(entry!.decidedAt).toBeDefined();
      expect(entry!.decidedBy).toBe('user');
    });

    it('should return null for non-existent approval ID', () => {
      const result = queue.approve('nonexistent-id');
      expect(result).toBeNull();
    });

    it('should return null for already-approved entry', () => {
      const id = queue.enqueue(makeEnvelope());
      queue.approve(id);
      const result = queue.approve(id);
      expect(result).toBeNull();
    });

    it('should accept custom decidedBy', () => {
      const id = queue.enqueue(makeEnvelope());
      const entry = queue.approve(id, 'admin');
      expect(entry!.decidedBy).toBe('admin');
    });
  });

  describe('reject', () => {
    it('should mark a pending entry as rejected', () => {
      const id = queue.enqueue(makeEnvelope());
      const entry = queue.reject(id);

      expect(entry).not.toBeNull();
      expect(entry!.status).toBe('rejected');
      expect(entry!.decidedAt).toBeDefined();
      expect(entry!.decidedBy).toBe('user');
    });

    it('should return null for non-existent approval ID', () => {
      const result = queue.reject('nonexistent-id');
      expect(result).toBeNull();
    });

    it('should return null for already-rejected entry', () => {
      const id = queue.enqueue(makeEnvelope());
      queue.reject(id);
      const result = queue.reject(id);
      expect(result).toBeNull();
    });
  });

  describe('getQueue', () => {
    it('should return all entries when no status filter', () => {
      const id1 = queue.enqueue(makeEnvelope());
      queue.enqueue(makeEnvelope());
      queue.approve(id1);

      const all = queue.getQueue();
      expect(all).toHaveLength(2);
    });

    it('should filter by status', () => {
      const id1 = queue.enqueue(makeEnvelope());
      queue.enqueue(makeEnvelope());
      queue.approve(id1);

      expect(queue.getQueue('pending')).toHaveLength(1);
      expect(queue.getQueue('approved')).toHaveLength(1);
      expect(queue.getQueue('rejected')).toHaveLength(0);
    });
  });

  describe('pruneExpired', () => {
    it('should expire entries past their TTL', () => {
      // Create an envelope with a very short TTL
      const envelope = makeEnvelope({ ttlMinutes: 0 });
      const id = queue.enqueue(envelope);

      // Manually backdate the receivedAt
      const filePath = path.join(temp.stateDir, 'threadline', 'approval-queue.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      data.entries[0].receivedAt = new Date(Date.now() - 60 * 1000).toISOString();
      fs.writeFileSync(filePath, JSON.stringify(data));

      const expired = queue.pruneExpired();
      expect(expired).toContain(id);

      const entry = queue.getEntry(id);
      expect(entry!.status).toBe('expired');
      expect(entry!.decidedBy).toBe('system');
    });

    it('should not expire entries within their TTL', () => {
      const envelope = makeEnvelope({ ttlMinutes: 60 });
      queue.enqueue(envelope);

      const expired = queue.pruneExpired();
      expect(expired).toHaveLength(0);
    });

    it('should only expire pending entries', () => {
      const id = queue.enqueue(makeEnvelope({ ttlMinutes: 0 }));
      queue.approve(id);

      // Backdate
      const filePath = path.join(temp.stateDir, 'threadline', 'approval-queue.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      data.entries[0].receivedAt = new Date(Date.now() - 60 * 1000).toISOString();
      fs.writeFileSync(filePath, JSON.stringify(data));

      const expired = queue.pruneExpired();
      expect(expired).toHaveLength(0);
    });
  });

  describe('pendingCount', () => {
    it('should return count of pending entries', () => {
      expect(queue.pendingCount()).toBe(0);

      queue.enqueue(makeEnvelope());
      queue.enqueue(makeEnvelope());
      expect(queue.pendingCount()).toBe(2);

      const id = queue.enqueue(makeEnvelope());
      queue.approve(id);
      expect(queue.pendingCount()).toBe(2);
    });
  });

  describe('persistence', () => {
    it('should persist across instances', () => {
      const id = queue.enqueue(makeEnvelope({ subject: 'Persistent' }));

      // Create new instance pointing to same directory
      const queue2 = new ApprovalQueue(temp.stateDir);
      const entry = queue2.getEntry(id);
      expect(entry).not.toBeNull();
      expect(entry!.subject).toBe('Persistent');
    });

    it('should handle corrupted file gracefully', () => {
      const filePath = path.join(temp.stateDir, 'threadline', 'approval-queue.json');
      fs.writeFileSync(filePath, 'not valid json!!!');

      const queue2 = new ApprovalQueue(temp.stateDir);
      expect(queue2.getQueue()).toHaveLength(0);
    });
  });

  describe('queue ordering', () => {
    it('should maintain insertion order', () => {
      queue.enqueue(makeEnvelope({ subject: 'First' }));
      queue.enqueue(makeEnvelope({ subject: 'Second' }));
      queue.enqueue(makeEnvelope({ subject: 'Third' }));

      const entries = queue.getQueue();
      expect(entries[0].subject).toBe('First');
      expect(entries[1].subject).toBe('Second');
      expect(entries[2].subject).toBe('Third');
    });
  });
});
