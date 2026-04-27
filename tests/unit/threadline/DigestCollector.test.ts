import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DigestCollector } from '../../../src/threadline/DigestCollector.js';
import type { MessageEnvelope } from '../../../src/messaging/types.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTempDir(): { stateDir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-test-'));
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
      body: 'Test body content',
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

describe('DigestCollector', () => {
  let temp: ReturnType<typeof createTempDir>;
  let collector: DigestCollector;

  beforeEach(() => {
    temp = createTempDir();
    collector = new DigestCollector(temp.stateDir);
  });

  afterEach(() => {
    temp.cleanup();
  });

  describe('addEntry', () => {
    it('should track a delivered message', () => {
      collector.addEntry(makeEnvelope({ subject: 'Hello' }));
      expect(collector.entryCount()).toBe(1);
    });

    it('should accumulate multiple entries', () => {
      collector.addEntry(makeEnvelope({ subject: 'First' }));
      collector.addEntry(makeEnvelope({ subject: 'Second' }));
      collector.addEntry(makeEnvelope({ subject: 'Third' }));
      expect(collector.entryCount()).toBe(3);
    });

    it('should truncate long body previews to 200 chars', () => {
      const longBody = 'a'.repeat(500);
      collector.addEntry(makeEnvelope({ body: longBody }));

      const filePath = path.join(temp.stateDir, 'threadline', 'digest.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(data.entries[0].bodyPreview.length).toBe(200);
    });

    it('should capture message metadata', () => {
      collector.addEntry(makeEnvelope({
        subject: 'Status Update',
        type: 'sync',
        threadId: 'thread-abc',
      }));

      const filePath = path.join(temp.stateDir, 'threadline', 'digest.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const entry = data.entries[0];

      expect(entry.subject).toBe('Status Update');
      expect(entry.type).toBe('sync');
      expect(entry.threadId).toBe('thread-abc');
      expect(entry.fromAgent).toBe('test-sender');
    });
  });

  describe('generateDigest', () => {
    it('should return null when no entries', () => {
      expect(collector.generateDigest()).toBeNull();
    });

    it('should generate a summary with message count', () => {
      collector.addEntry(makeEnvelope({ subject: 'First' }));
      collector.addEntry(makeEnvelope({ subject: 'Second' }));

      const digest = collector.generateDigest();
      expect(digest).toContain('2 messages');
    });

    it('should group messages by agent', () => {
      collector.addEntry(makeEnvelope({
        subject: 'From Alpha',
        from: { agent: 'alpha', session: 's1', machine: 'm1' },
      }));
      collector.addEntry(makeEnvelope({
        subject: 'From Beta',
        from: { agent: 'beta', session: 's2', machine: 'm2' },
      }));

      const digest = collector.generateDigest()!;
      expect(digest).toContain('From alpha');
      expect(digest).toContain('From beta');
    });

    it('should include thread tags when present', () => {
      collector.addEntry(makeEnvelope({
        subject: 'Threaded',
        threadId: 'abcdefgh-1234',
      }));

      const digest = collector.generateDigest()!;
      expect(digest).toContain('[thread:abcdefgh]');
    });

    it('should include message type tags', () => {
      collector.addEntry(makeEnvelope({
        subject: 'Alert Message',
        type: 'alert',
      }));

      const digest = collector.generateDigest()!;
      expect(digest).toContain('[alert]');
    });
  });

  describe('shouldSendDigest', () => {
    it('should return false when no entries', () => {
      expect(collector.shouldSendDigest()).toBe(false);
    });

    it('should return false when interval has not elapsed', () => {
      collector.addEntry(makeEnvelope());
      // Just created — interval hasn't elapsed
      expect(collector.shouldSendDigest()).toBe(false);
    });

    it('should return true when interval has elapsed and entries exist', () => {
      collector.addEntry(makeEnvelope());

      // Backdate the lastDigestSentAt
      const filePath = path.join(temp.stateDir, 'threadline', 'digest.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      data.lastDigestSentAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(filePath, JSON.stringify(data));

      // Re-create to pick up changes
      const collector2 = new DigestCollector(temp.stateDir);
      expect(collector2.shouldSendDigest()).toBe(true);
    });
  });

  describe('markDigestSent', () => {
    it('should clear entries after sending', () => {
      collector.addEntry(makeEnvelope());
      collector.addEntry(makeEnvelope());
      expect(collector.entryCount()).toBe(2);

      collector.markDigestSent();
      expect(collector.entryCount()).toBe(0);
    });

    it('should update lastDigestSentAt', () => {
      const before = Date.now();
      collector.markDigestSent();

      const filePath = path.join(temp.stateDir, 'threadline', 'digest.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const sentAt = new Date(data.lastDigestSentAt).getTime();
      expect(sentAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('digest interval', () => {
    it('should default to 60 minutes', () => {
      expect(collector.getDigestInterval()).toBe(60);
    });

    it('should allow setting custom interval', () => {
      collector.setDigestInterval(120);
      expect(collector.getDigestInterval()).toBe(120);
    });

    it('should enforce minimum of 1 minute', () => {
      collector.setDigestInterval(0);
      expect(collector.getDigestInterval()).toBe(1);
    });
  });

  describe('persistence', () => {
    it('should persist across instances', () => {
      collector.addEntry(makeEnvelope({ subject: 'Persistent' }));

      const collector2 = new DigestCollector(temp.stateDir);
      expect(collector2.entryCount()).toBe(1);
    });

    it('should handle corrupted file gracefully', () => {
      const filePath = path.join(temp.stateDir, 'threadline', 'digest.json');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'corrupt data!!!');

      const collector2 = new DigestCollector(temp.stateDir);
      expect(collector2.entryCount()).toBe(0);
    });
  });
});
