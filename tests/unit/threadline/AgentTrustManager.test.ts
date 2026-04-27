import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import type {
  AgentTrustProfile,
  TrustChangeNotification,
  TrustAuditEntry,
} from '../../../src/threadline/AgentTrustManager.js';

describe('AgentTrustManager', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-mgr-test-'));
    stateDir = tmpDir;
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createManager(opts?: {
    onTrustChange?: (n: TrustChangeNotification) => void;
  }): AgentTrustManager {
    return new AgentTrustManager({
      stateDir,
      onTrustChange: opts?.onTrustChange,
    });
  }

  // ── Profile Access ──────────────────────────────────────────────

  describe('profile access', () => {
    it('returns null for unknown agent', () => {
      const mgr = createManager();
      expect(mgr.getProfile('unknown-agent')).toBeNull();
    });

    it('creates a profile on getOrCreateProfile', () => {
      const mgr = createManager();
      const profile = mgr.getOrCreateProfile('agent-a');
      expect(profile.agent).toBe('agent-a');
      expect(profile.level).toBe('untrusted');
      expect(profile.source).toBe('setup-default');
      expect(profile.history.messagesReceived).toBe(0);
      expect(profile.history.successfulInteractions).toBe(0);
    });

    it('returns existing profile on second getOrCreateProfile call', () => {
      const mgr = createManager();
      const p1 = mgr.getOrCreateProfile('agent-a');
      p1.history.messagesReceived = 5;
      const p2 = mgr.getOrCreateProfile('agent-a');
      expect(p2.history.messagesReceived).toBe(5);
    });

    it('getProfile returns profile after creation', () => {
      const mgr = createManager();
      mgr.getOrCreateProfile('agent-b');
      const profile = mgr.getProfile('agent-b');
      expect(profile).not.toBeNull();
      expect(profile!.agent).toBe('agent-b');
    });
  });

  // ── Trust Level Management ──────────────────────────────────────

  describe('trust level management', () => {
    it('sets trust level with user-granted source', () => {
      const mgr = createManager();
      const result = mgr.setTrustLevel('agent-a', 'trusted', 'user-granted', 'Trusted after demo');
      expect(result).toBe(true);
      expect(mgr.getProfile('agent-a')!.level).toBe('trusted');
    });

    it('sets trust level with paired-machine-granted source', () => {
      const mgr = createManager();
      const result = mgr.setTrustLevel('agent-a', 'verified', 'paired-machine-granted');
      expect(result).toBe(true);
      expect(mgr.getProfile('agent-a')!.level).toBe('verified');
    });

    it('rejects upgrade with setup-default source', () => {
      const mgr = createManager();
      mgr.getOrCreateProfile('agent-a'); // untrusted
      const result = mgr.setTrustLevel('agent-a', 'trusted', 'setup-default', 'Should fail');
      expect(result).toBe(false);
      expect(mgr.getProfile('agent-a')!.level).toBe('untrusted');
    });

    it('allows downgrade with any source', () => {
      const mgr = createManager();
      mgr.setTrustLevel('agent-a', 'autonomous', 'user-granted');
      const result = mgr.setTrustLevel('agent-a', 'verified', 'setup-default', 'Downgrade');
      expect(result).toBe(true);
      expect(mgr.getProfile('agent-a')!.level).toBe('verified');
    });

    it('allows setting same level with any source', () => {
      const mgr = createManager();
      mgr.getOrCreateProfile('agent-a'); // untrusted
      const result = mgr.setTrustLevel('agent-a', 'untrusted', 'setup-default');
      expect(result).toBe(true);
    });

    it('updates allowedOperations on trust level change', () => {
      const mgr = createManager();
      mgr.setTrustLevel('agent-a', 'trusted', 'user-granted');
      const profile = mgr.getProfile('agent-a')!;
      expect(profile.allowedOperations).toContain('task-request');
      expect(profile.allowedOperations).toContain('data-share');
    });

    it('cannot auto-escalate via setTrustLevel (no setup-default upgrade)', () => {
      const mgr = createManager();
      mgr.setTrustLevel('agent-a', 'verified', 'user-granted');
      const result = mgr.setTrustLevel('agent-a', 'autonomous', 'setup-default');
      expect(result).toBe(false);
      expect(mgr.getProfile('agent-a')!.level).toBe('verified');
    });
  });

  // ── Interaction Recording ───────────────────────────────────────

  describe('interaction recording', () => {
    it('records successful interaction and increments streak', () => {
      const mgr = createManager();
      mgr.recordInteraction('agent-a', true);
      mgr.recordInteraction('agent-a', true);
      const stats = mgr.getInteractionStats('agent-a');
      expect(stats!.successfulInteractions).toBe(2);
      expect(stats!.streakSinceIncident).toBe(2);
      expect(stats!.failedInteractions).toBe(0);
    });

    it('records failed interaction and resets streak', () => {
      const mgr = createManager();
      mgr.recordInteraction('agent-a', true);
      mgr.recordInteraction('agent-a', true);
      mgr.recordInteraction('agent-a', false);
      const stats = mgr.getInteractionStats('agent-a');
      expect(stats!.successfulInteractions).toBe(2);
      expect(stats!.failedInteractions).toBe(1);
      expect(stats!.streakSinceIncident).toBe(0);
    });

    it('records message received', () => {
      const mgr = createManager();
      mgr.recordMessageReceived('agent-a');
      mgr.recordMessageReceived('agent-a');
      expect(mgr.getInteractionStats('agent-a')!.messagesReceived).toBe(2);
    });

    it('records message responded', () => {
      const mgr = createManager();
      mgr.recordMessageResponded('agent-a');
      expect(mgr.getInteractionStats('agent-a')!.messagesResponded).toBe(1);
    });

    it('updates lastInteraction on interaction', () => {
      const mgr = createManager();
      mgr.recordInteraction('agent-a', true);
      const stats = mgr.getInteractionStats('agent-a');
      expect(stats!.lastInteraction).toBeTruthy();
    });

    it('returns null stats for unknown agent', () => {
      const mgr = createManager();
      expect(mgr.getInteractionStats('unknown')).toBeNull();
    });

    it('computes success rate correctly', () => {
      const mgr = createManager();
      mgr.recordInteraction('agent-a', true);
      mgr.recordInteraction('agent-a', true);
      mgr.recordInteraction('agent-a', true);
      mgr.recordInteraction('agent-a', false);
      const stats = mgr.getInteractionStats('agent-a')!;
      expect(stats.successRate).toBe(0.75);
    });

    it('success rate is 0 when no interactions', () => {
      const mgr = createManager();
      mgr.getOrCreateProfile('agent-a');
      const stats = mgr.getInteractionStats('agent-a')!;
      expect(stats.successRate).toBe(0);
    });
  });

  // ── Permission Checking ─────────────────────────────────────────

  describe('permission checking', () => {
    it('allows untrusted-level ops for unknown agents', () => {
      const mgr = createManager();
      expect(mgr.checkPermission('unknown', 'ping')).toBe(true);
      expect(mgr.checkPermission('unknown', 'health')).toBe(true);
      expect(mgr.checkPermission('unknown', 'message')).toBe(false);
    });

    it('allows operations based on trust level', () => {
      const mgr = createManager();
      mgr.setTrustLevel('agent-a', 'trusted', 'user-granted');
      expect(mgr.checkPermission('agent-a', 'message')).toBe(true);
      expect(mgr.checkPermission('agent-a', 'task-request')).toBe(true);
      expect(mgr.checkPermission('agent-a', 'spawn')).toBe(false);
    });

    it('blocked operations override allowed list', () => {
      const mgr = createManager();
      mgr.setTrustLevel('agent-a', 'trusted', 'user-granted');
      mgr.blockOperation('agent-a', 'message');
      expect(mgr.checkPermission('agent-a', 'message')).toBe(false);
    });

    it('unblock restores permission', () => {
      const mgr = createManager();
      mgr.setTrustLevel('agent-a', 'trusted', 'user-granted');
      mgr.blockOperation('agent-a', 'message');
      expect(mgr.checkPermission('agent-a', 'message')).toBe(false);
      mgr.unblockOperation('agent-a', 'message');
      expect(mgr.checkPermission('agent-a', 'message')).toBe(true);
    });

    it('autonomous level allows spawn and delegate', () => {
      const mgr = createManager();
      mgr.setTrustLevel('agent-a', 'autonomous', 'user-granted');
      expect(mgr.checkPermission('agent-a', 'spawn')).toBe(true);
      expect(mgr.checkPermission('agent-a', 'delegate')).toBe(true);
    });
  });

  // ── Auto-Downgrade ──────────────────────────────────────────────

  describe('auto-downgrade', () => {
    it('downgrades to untrusted', () => {
      const mgr = createManager();
      mgr.setTrustLevel('agent-a', 'trusted', 'user-granted');
      const result = mgr.autoDowngrade('agent-a', 'Circuit breaker triggered');
      expect(result).toBe(true);
      expect(mgr.getProfile('agent-a')!.level).toBe('untrusted');
    });

    it('returns false if already untrusted', () => {
      const mgr = createManager();
      mgr.getOrCreateProfile('agent-a');
      const result = mgr.autoDowngrade('agent-a', 'Already low');
      expect(result).toBe(false);
    });

    it('returns false for unknown agent', () => {
      const mgr = createManager();
      const result = mgr.autoDowngrade('unknown', 'No profile');
      expect(result).toBe(false);
    });

    it('fires trust change callback on downgrade', () => {
      const notifications: TrustChangeNotification[] = [];
      const mgr = createManager({ onTrustChange: n => notifications.push(n) });
      mgr.setTrustLevel('agent-a', 'autonomous', 'user-granted');
      notifications.length = 0; // clear setup notification

      mgr.autoDowngrade('agent-a', 'Crypto verification failed');
      expect(notifications).toHaveLength(1);
      expect(notifications[0].previousLevel).toBe('autonomous');
      expect(notifications[0].newLevel).toBe('untrusted');
      expect(notifications[0].userInitiated).toBe(false);
    });

    it('logs audit entry on downgrade', () => {
      const mgr = createManager();
      mgr.setTrustLevel('agent-a', 'trusted', 'user-granted');
      mgr.autoDowngrade('agent-a', 'Crypto failure');

      const audit = mgr.readAuditTrail();
      const downgradeEntry = audit.find(e => e.newLevel === 'untrusted' && e.agent === 'agent-a');
      expect(downgradeEntry).toBeDefined();
      expect(downgradeEntry!.source).toBe('system');
      expect(downgradeEntry!.userInitiated).toBe(false);
    });
  });

  // ── Staleness Downgrade ─────────────────────────────────────────

  describe('staleness downgrade', () => {
    it('downgrades one level after 90 days of inactivity', () => {
      const mgr = createManager();
      mgr.setTrustLevel('agent-a', 'autonomous', 'user-granted');
      mgr.recordInteraction('agent-a', true);

      // Simulate 91 days later
      const now = Date.now() + 91 * 24 * 60 * 60 * 1000;
      const result = mgr.checkStalenessDowngrade('agent-a', now);
      expect(result).toBe(true);
      expect(mgr.getProfile('agent-a')!.level).toBe('trusted');
    });

    it('does not downgrade if recent interaction', () => {
      const mgr = createManager();
      mgr.setTrustLevel('agent-a', 'trusted', 'user-granted');
      mgr.recordInteraction('agent-a', true);

      const result = mgr.checkStalenessDowngrade('agent-a');
      expect(result).toBe(false);
      expect(mgr.getProfile('agent-a')!.level).toBe('trusted');
    });

    it('does not downgrade if already untrusted', () => {
      const mgr = createManager();
      mgr.getOrCreateProfile('agent-a');
      mgr.recordInteraction('agent-a', true);

      const now = Date.now() + 91 * 24 * 60 * 60 * 1000;
      const result = mgr.checkStalenessDowngrade('agent-a', now);
      expect(result).toBe(false);
    });

    it('returns false for unknown agent', () => {
      const mgr = createManager();
      expect(mgr.checkStalenessDowngrade('unknown')).toBe(false);
    });

    it('returns false if no lastInteraction recorded', () => {
      const mgr = createManager();
      mgr.setTrustLevel('agent-a', 'trusted', 'user-granted');
      // No interactions recorded — lastInteraction is empty string
      const now = Date.now() + 91 * 24 * 60 * 60 * 1000;
      const result = mgr.checkStalenessDowngrade('agent-a', now);
      expect(result).toBe(false);
    });
  });

  // ── Profile Listing ─────────────────────────────────────────────

  describe('profile listing', () => {
    it('lists all profiles', () => {
      const mgr = createManager();
      mgr.getOrCreateProfile('agent-a');
      mgr.setTrustLevel('agent-b', 'trusted', 'user-granted');
      const profiles = mgr.listProfiles();
      expect(profiles).toHaveLength(2);
    });

    it('filters by trust level', () => {
      const mgr = createManager();
      mgr.getOrCreateProfile('agent-a');
      mgr.setTrustLevel('agent-b', 'trusted', 'user-granted');
      mgr.setTrustLevel('agent-c', 'trusted', 'user-granted');

      const trusted = mgr.listProfiles({ level: 'trusted' });
      expect(trusted).toHaveLength(2);
      expect(trusted.every(p => p.level === 'trusted')).toBe(true);
    });

    it('filters by source', () => {
      const mgr = createManager();
      mgr.getOrCreateProfile('agent-a'); // setup-default
      mgr.setTrustLevel('agent-b', 'trusted', 'user-granted');

      const userGranted = mgr.listProfiles({ source: 'user-granted' });
      expect(userGranted).toHaveLength(1);
      expect(userGranted[0].agent).toBe('agent-b');
    });

    it('filters by both level and source', () => {
      const mgr = createManager();
      mgr.getOrCreateProfile('agent-a');
      mgr.setTrustLevel('agent-b', 'trusted', 'user-granted');
      mgr.setTrustLevel('agent-c', 'trusted', 'paired-machine-granted');

      const result = mgr.listProfiles({ level: 'trusted', source: 'user-granted' });
      expect(result).toHaveLength(1);
      expect(result[0].agent).toBe('agent-b');
    });
  });

  // ── Audit Trail ─────────────────────────────────────────────────

  describe('audit trail', () => {
    it('logs trust level changes', () => {
      const mgr = createManager();
      mgr.setTrustLevel('agent-a', 'verified', 'user-granted', 'Initial verification');
      mgr.setTrustLevel('agent-a', 'trusted', 'user-granted', 'Promoted');

      const trail = mgr.readAuditTrail();
      expect(trail.length).toBeGreaterThanOrEqual(2);
    });

    it('supports limit parameter', () => {
      const mgr = createManager();
      mgr.setTrustLevel('agent-a', 'verified', 'user-granted');
      mgr.setTrustLevel('agent-a', 'trusted', 'user-granted');
      mgr.setTrustLevel('agent-a', 'autonomous', 'user-granted');

      const last2 = mgr.readAuditTrail(2);
      expect(last2).toHaveLength(2);
    });

    it('returns empty array when no audit file exists', () => {
      const mgr = createManager();
      expect(mgr.readAuditTrail()).toEqual([]);
    });

    it('records userInitiated correctly', () => {
      const mgr = createManager();
      mgr.setTrustLevel('agent-a', 'trusted', 'user-granted');
      mgr.autoDowngrade('agent-a', 'System downgrade');

      const trail = mgr.readAuditTrail();
      const userEntry = trail.find(e => e.userInitiated === true);
      const systemEntry = trail.find(e => e.userInitiated === false);
      expect(userEntry).toBeDefined();
      expect(systemEntry).toBeDefined();
    });
  });

  // ── Trust Change Callback ───────────────────────────────────────

  describe('trust change callback', () => {
    it('fires on setTrustLevel', () => {
      const notifications: TrustChangeNotification[] = [];
      const mgr = createManager({ onTrustChange: n => notifications.push(n) });
      mgr.setTrustLevel('agent-a', 'trusted', 'user-granted', 'Demo');

      expect(notifications).toHaveLength(1);
      expect(notifications[0].agent).toBe('agent-a');
      expect(notifications[0].newLevel).toBe('trusted');
      expect(notifications[0].userInitiated).toBe(true);
    });

    it('does not fire when upgrade is rejected', () => {
      const notifications: TrustChangeNotification[] = [];
      const mgr = createManager({ onTrustChange: n => notifications.push(n) });
      mgr.getOrCreateProfile('agent-a');
      mgr.setTrustLevel('agent-a', 'trusted', 'setup-default'); // rejected

      expect(notifications).toHaveLength(0);
    });
  });

  // ── Persistence ─────────────────────────────────────────────────

  describe('persistence', () => {
    it('persists profiles across instances', () => {
      const mgr1 = createManager();
      mgr1.setTrustLevel('agent-a', 'trusted', 'user-granted');
      mgr1.recordInteraction('agent-a', true);
      mgr1.recordInteraction('agent-a', true);

      const mgr2 = createManager();
      const profile = mgr2.getProfile('agent-a');
      expect(profile).not.toBeNull();
      expect(profile!.level).toBe('trusted');
      expect(profile!.history.successfulInteractions).toBe(2);
    });

    it('persists audit trail across instances', () => {
      const mgr1 = createManager();
      mgr1.setTrustLevel('agent-a', 'verified', 'user-granted');

      const mgr2 = createManager();
      const trail = mgr2.readAuditTrail();
      expect(trail.length).toBeGreaterThan(0);
    });

    it('reload refreshes from disk', () => {
      const mgr1 = createManager();
      const mgr2 = createManager();

      mgr1.setTrustLevel('agent-a', 'trusted', 'user-granted');

      // mgr2 has stale in-memory state
      expect(mgr2.getProfile('agent-a')).toBeNull();

      // After reload, sees the update
      mgr2.reload();
      expect(mgr2.getProfile('agent-a')!.level).toBe('trusted');
    });
  });

  // ── Blocked Operations ──────────────────────────────────────────

  describe('blocked operations', () => {
    it('blocks and unblocks operations', () => {
      const mgr = createManager();
      mgr.setTrustLevel('agent-a', 'autonomous', 'user-granted');
      expect(mgr.checkPermission('agent-a', 'spawn')).toBe(true);

      mgr.blockOperation('agent-a', 'spawn');
      expect(mgr.checkPermission('agent-a', 'spawn')).toBe(false);

      mgr.unblockOperation('agent-a', 'spawn');
      expect(mgr.checkPermission('agent-a', 'spawn')).toBe(true);
    });

    it('blocking same operation twice is idempotent', () => {
      const mgr = createManager();
      mgr.getOrCreateProfile('agent-a');
      mgr.blockOperation('agent-a', 'message');
      mgr.blockOperation('agent-a', 'message');
      const profile = mgr.getProfile('agent-a')!;
      expect(profile.blockedOperations.filter(o => o === 'message')).toHaveLength(1);
    });
  });
});
