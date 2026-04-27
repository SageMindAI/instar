import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AutonomyGate } from '../../../src/threadline/AutonomyGate.js';
import { ApprovalQueue } from '../../../src/threadline/ApprovalQueue.js';
import { DigestCollector } from '../../../src/threadline/DigestCollector.js';
import type { ThreadlineNotifier } from '../../../src/threadline/AutonomyGate.js';
import type { MessageEnvelope } from '../../../src/messaging/types.js';
import type { AutonomyProfileLevel } from '../../../src/core/types.js';

// ── Mocks ────────────────────────────────────────────────────────

/** Minimal mock of AutonomyProfileManager */
function createMockAutonomyManager(level: AutonomyProfileLevel = 'collaborative') {
  return {
    getProfile: vi.fn(() => level),
    setProfile: vi.fn(),
    getResolvedState: vi.fn(),
    getNaturalLanguageSummary: vi.fn(),
    getNotificationPreferences: vi.fn(),
    setNotificationPreferences: vi.fn(),
    getPendingElevations: vi.fn(() => []),
    getDashboard: vi.fn(),
    getHistory: vi.fn(() => []),
  };
}

function createMockNotifier(): ThreadlineNotifier {
  return {
    notifyUser: vi.fn(async () => {}),
    requestApproval: vi.fn(async () => {}),
    sendDigest: vi.fn(async () => {}),
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function createTempDir(): { stateDir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-gate-test-'));
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
      from: { agent: 'remote-agent', session: 'sess-1', machine: 'mach-1' },
      to: { agent: 'local-agent', session: 'best', machine: 'local' },
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

describe('AutonomyGate', () => {
  let temp: ReturnType<typeof createTempDir>;

  beforeEach(() => {
    temp = createTempDir();
  });

  afterEach(() => {
    temp.cleanup();
  });

  function createGate(opts: {
    level?: AutonomyProfileLevel;
    notifier?: ThreadlineNotifier | null;
  } = {}) {
    const autonomyManager = createMockAutonomyManager(opts.level ?? 'collaborative');
    const approvalQueue = new ApprovalQueue(temp.stateDir);
    const digestCollector = new DigestCollector(temp.stateDir);

    const gate = new AutonomyGate({
      autonomyManager: autonomyManager as any,
      approvalQueue,
      digestCollector,
      notifier: opts.notifier ?? null,
      stateDir: temp.stateDir,
    });

    return { gate, autonomyManager, approvalQueue, digestCollector };
  }

  // ── Autonomy Level Behavior ────────────────────────────────────

  describe('cautious mode', () => {
    it('should queue all messages for approval', async () => {
      const { gate } = createGate({ level: 'cautious' });
      const result = await gate.evaluate(makeEnvelope());

      expect(result.decision).toBe('queue-for-approval');
      expect(result.approvalId).toBeDefined();
      expect(result.reason).toContain('Cautious');
    });

    it('should fire approval request notification', async () => {
      const notifier = createMockNotifier();
      const { gate } = createGate({ level: 'cautious', notifier });
      await gate.evaluate(makeEnvelope());

      expect(notifier.requestApproval).toHaveBeenCalledOnce();
    });
  });

  describe('supervised mode', () => {
    it('should deliver and notify', async () => {
      const notifier = createMockNotifier();
      const { gate } = createGate({ level: 'supervised', notifier });
      const result = await gate.evaluate(makeEnvelope());

      expect(result.decision).toBe('notify-and-deliver');
      expect(result.notificationSent).toBe(true);
      expect(notifier.notifyUser).toHaveBeenCalledOnce();
    });

    it('should still deliver when notification fails', async () => {
      const notifier = createMockNotifier();
      (notifier.notifyUser as any).mockRejectedValue(new Error('Network error'));

      const { gate } = createGate({ level: 'supervised', notifier });
      const result = await gate.evaluate(makeEnvelope());

      expect(result.decision).toBe('notify-and-deliver');
      expect(result.notificationSent).toBe(false);
    });

    it('should deliver with notificationSent=false when no notifier', async () => {
      const { gate } = createGate({ level: 'supervised', notifier: null });
      const result = await gate.evaluate(makeEnvelope());

      expect(result.decision).toBe('notify-and-deliver');
      expect(result.notificationSent).toBe(false);
    });
  });

  describe('collaborative mode', () => {
    it('should deliver silently and add to digest', async () => {
      const { gate, digestCollector } = createGate({ level: 'collaborative' });
      const result = await gate.evaluate(makeEnvelope());

      expect(result.decision).toBe('deliver');
      expect(result.reason).toContain('digest');
      expect(digestCollector.entryCount()).toBe(1);
    });
  });

  describe('autonomous mode', () => {
    it('should deliver silently without digest', async () => {
      const { gate, digestCollector } = createGate({ level: 'autonomous' });
      const result = await gate.evaluate(makeEnvelope());

      expect(result.decision).toBe('deliver');
      expect(result.reason).toContain('Autonomous');
      expect(digestCollector.entryCount()).toBe(0);
    });
  });

  // ── Agent Controls ─────────────────────────────────────────────

  describe('blocked agents', () => {
    it('should block messages from blocked agents', async () => {
      const { gate } = createGate({ level: 'autonomous' });
      gate.blockAgent('remote-agent');

      const result = await gate.evaluate(makeEnvelope());
      expect(result.decision).toBe('block');
      expect(result.reason).toContain('blocked');
    });

    it('should allow messages from non-blocked agents', async () => {
      const { gate } = createGate({ level: 'autonomous' });
      gate.blockAgent('other-agent');

      const result = await gate.evaluate(makeEnvelope());
      expect(result.decision).toBe('deliver');
    });

    it('should unblock agents', async () => {
      const { gate } = createGate({ level: 'autonomous' });
      gate.blockAgent('remote-agent');
      gate.unblockAgent('remote-agent');

      const result = await gate.evaluate(makeEnvelope());
      expect(result.decision).toBe('deliver');
    });
  });

  describe('paused agents', () => {
    it('should queue messages from paused agents for approval', async () => {
      const { gate } = createGate({ level: 'autonomous' });
      gate.pauseAgent('remote-agent');

      const result = await gate.evaluate(makeEnvelope());
      expect(result.decision).toBe('queue-for-approval');
      expect(result.approvalId).toBeDefined();
    });

    it('should resume paused agents', async () => {
      const { gate } = createGate({ level: 'autonomous' });
      gate.pauseAgent('remote-agent');
      gate.resumeAgent('remote-agent');

      const result = await gate.evaluate(makeEnvelope());
      expect(result.decision).toBe('deliver');
    });
  });

  describe('getControlledAgents', () => {
    it('should list all blocked and paused agents', () => {
      const { gate } = createGate();
      gate.blockAgent('blocked-one', 'spam');
      gate.pauseAgent('paused-one');

      const controlled = gate.getControlledAgents();
      expect(controlled).toHaveLength(2);

      const blocked = controlled.find(c => c.agent === 'blocked-one');
      expect(blocked?.status).toBe('blocked');
      expect(blocked?.reason).toBe('spam');

      const paused = controlled.find(c => c.agent === 'paused-one');
      expect(paused?.status).toBe('paused');
    });

    it('should return empty when no controls', () => {
      const { gate } = createGate();
      expect(gate.getControlledAgents()).toHaveLength(0);
    });
  });

  // ── Approval Queue Integration ─────────────────────────────────

  describe('approval queue methods', () => {
    it('should approve queued messages', async () => {
      const { gate } = createGate({ level: 'cautious' });
      const result = await gate.evaluate(makeEnvelope());

      const entry = gate.approveMessage(result.approvalId!);
      expect(entry).not.toBeNull();
      expect(entry!.status).toBe('approved');
    });

    it('should reject queued messages', async () => {
      const { gate } = createGate({ level: 'cautious' });
      const result = await gate.evaluate(makeEnvelope());

      const entry = gate.rejectMessage(result.approvalId!);
      expect(entry).not.toBeNull();
      expect(entry!.status).toBe('rejected');
    });

    it('should list approval queue', async () => {
      const { gate } = createGate({ level: 'cautious' });
      await gate.evaluate(makeEnvelope({ subject: 'Msg 1' }));
      await gate.evaluate(makeEnvelope({ subject: 'Msg 2' }));

      const queue = gate.getApprovalQueue('pending');
      expect(queue).toHaveLength(2);
    });
  });

  // ── Digest Integration ─────────────────────────────────────────

  describe('checkAndSendDigest', () => {
    it('should send digest when interval has elapsed', async () => {
      const notifier = createMockNotifier();
      const { gate, digestCollector } = createGate({ level: 'collaborative', notifier });

      // Add entry
      await gate.evaluate(makeEnvelope());

      // Backdate lastDigestSentAt
      const filePath = path.join(temp.stateDir, 'threadline', 'digest.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      data.lastDigestSentAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(filePath, JSON.stringify(data));

      // Re-create collector to pick up changes
      const gate2 = new AutonomyGate({
        autonomyManager: createMockAutonomyManager('collaborative') as any,
        approvalQueue: new ApprovalQueue(temp.stateDir),
        digestCollector: new DigestCollector(temp.stateDir),
        notifier,
        stateDir: temp.stateDir,
      });

      const sent = await gate2.checkAndSendDigest();
      expect(sent).toBe(true);
      expect(notifier.sendDigest).toHaveBeenCalledOnce();
    });

    it('should not send digest when no entries', async () => {
      const notifier = createMockNotifier();
      const { gate } = createGate({ level: 'collaborative', notifier });

      const sent = await gate.checkAndSendDigest();
      expect(sent).toBe(false);
      expect(notifier.sendDigest).not.toHaveBeenCalled();
    });

    it('should work without notifier', async () => {
      const { gate } = createGate({ level: 'collaborative', notifier: null });
      await gate.evaluate(makeEnvelope());

      // Backdate
      const filePath = path.join(temp.stateDir, 'threadline', 'digest.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      data.lastDigestSentAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(filePath, JSON.stringify(data));

      const gate2 = new AutonomyGate({
        autonomyManager: createMockAutonomyManager('collaborative') as any,
        approvalQueue: new ApprovalQueue(temp.stateDir),
        digestCollector: new DigestCollector(temp.stateDir),
        notifier: null,
        stateDir: temp.stateDir,
      });

      // Should still complete without error
      const sent = await gate2.checkAndSendDigest();
      expect(sent).toBe(true);
    });
  });

  // ── Gate Without Notifier ──────────────────────────────────────

  describe('gate with no notifier', () => {
    it('should still work in cautious mode', async () => {
      const { gate } = createGate({ level: 'cautious', notifier: null });
      const result = await gate.evaluate(makeEnvelope());

      expect(result.decision).toBe('queue-for-approval');
      expect(result.approvalId).toBeDefined();
    });

    it('should still deliver in supervised mode', async () => {
      const { gate } = createGate({ level: 'supervised', notifier: null });
      const result = await gate.evaluate(makeEnvelope());

      expect(result.decision).toBe('notify-and-deliver');
    });
  });

  // ── Persistence ────────────────────────────────────────────────

  describe('agent controls persistence', () => {
    it('should persist blocked agents across instances', () => {
      const { gate } = createGate();
      gate.blockAgent('persistent-agent');

      // Create new gate pointing to same dir
      const gate2 = new AutonomyGate({
        autonomyManager: createMockAutonomyManager() as any,
        approvalQueue: new ApprovalQueue(temp.stateDir),
        digestCollector: new DigestCollector(temp.stateDir),
        stateDir: temp.stateDir,
      });

      const controlled = gate2.getControlledAgents();
      expect(controlled).toHaveLength(1);
      expect(controlled[0].agent).toBe('persistent-agent');
      expect(controlled[0].status).toBe('blocked');
    });
  });
});
