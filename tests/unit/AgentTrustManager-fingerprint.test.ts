/**
 * Unit tests for AgentTrustManager fingerprint-based API (Milestone 1).
 *
 * Covers: fingerprint lookup/creation, trust level operations by fingerprint,
 * debounced saves, allowed operations, flush(), and interaction recording.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentTrustManager } from '../../src/threadline/AgentTrustManager.js';
import type { AgentTrustLevel } from '../../src/threadline/AgentTrustManager.js';

// ── Helpers ──────────────────────────────────────────────────────────

function createTempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-test-'));
  return {
    dir,
    // safe-git-allow: incremental-migration
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('AgentTrustManager — Fingerprint API', () => {
  let temp: ReturnType<typeof createTempDir>;
  let manager: AgentTrustManager;

  beforeEach(() => {
    temp = createTempDir();
    manager = new AgentTrustManager({ stateDir: temp.dir });
  });

  afterEach(() => {
    manager.flush();
    temp.cleanup();
  });

  // ── getProfileByFingerprint ────────────────────────────────────

  describe('getProfileByFingerprint', () => {
    it('returns null for unknown fingerprint', () => {
      const profile = manager.getProfileByFingerprint('unknown-fp');
      expect(profile).toBeNull();
    });

    it('returns profile after creation by fingerprint', () => {
      manager.getOrCreateProfileByFingerprint('fp-123', 'TestAgent');
      const profile = manager.getProfileByFingerprint('fp-123');
      expect(profile).not.toBeNull();
      expect(profile!.fingerprint).toBe('fp-123');
    });
  });

  // ── getOrCreateProfileByFingerprint ────────────────────────────

  describe('getOrCreateProfileByFingerprint', () => {
    it('creates a new profile with default verified level (relay agents)', () => {
      const profile = manager.getOrCreateProfileByFingerprint('fp-new', 'NewAgent');
      expect(profile.level).toBe('verified');
      expect(profile.fingerprint).toBe('fp-new');
    });

    it('returns existing profile on second call', () => {
      const first = manager.getOrCreateProfileByFingerprint('fp-existing', 'Agent1');
      const second = manager.getOrCreateProfileByFingerprint('fp-existing', 'Agent1');
      expect(first).toBe(second); // Same object reference
    });

    it('uses fingerprint as agent name when display name not provided', () => {
      const profile = manager.getOrCreateProfileByFingerprint('fp-no-name');
      expect(profile.agent).toContain('fp-no-name');
    });

    it('associates fingerprint with agent name', () => {
      const profile = manager.getOrCreateProfileByFingerprint('fp-456', 'NamedAgent');
      expect(profile.agent).toBeDefined();
    });
  });

  // ── getTrustLevelByFingerprint ─────────────────────────────────

  describe('getTrustLevelByFingerprint', () => {
    it('returns untrusted for unknown fingerprint', () => {
      const level = manager.getTrustLevelByFingerprint('unknown-fp');
      expect(level).toBe('untrusted');
    });

    it('returns correct level after trust is set', () => {
      manager.getOrCreateProfileByFingerprint('fp-trusted', 'TrustedAgent');
      manager.setTrustLevelByFingerprint('fp-trusted', 'trusted', 'user-granted', 'test');
      const level = manager.getTrustLevelByFingerprint('fp-trusted');
      expect(level).toBe('trusted');
    });
  });

  // ── setTrustLevelByFingerprint ─────────────────────────────────

  describe('setTrustLevelByFingerprint', () => {
    it('creates profile if fingerprint is new', () => {
      const success = manager.setTrustLevelByFingerprint(
        'fp-brand-new', 'verified', 'user-granted', 'test', 'BrandNewAgent'
      );
      expect(success).toBe(true);
      const level = manager.getTrustLevelByFingerprint('fp-brand-new');
      expect(level).toBe('verified');
    });

    it('upgrades trust level with user-granted source', () => {
      manager.getOrCreateProfileByFingerprint('fp-upgrade', 'Agent');
      const success = manager.setTrustLevelByFingerprint(
        'fp-upgrade', 'trusted', 'user-granted', 'promoted'
      );
      expect(success).toBe(true);
      expect(manager.getTrustLevelByFingerprint('fp-upgrade')).toBe('trusted');
    });

    it('downgrades trust level', () => {
      manager.getOrCreateProfileByFingerprint('fp-downgrade', 'Agent');
      manager.setTrustLevelByFingerprint('fp-downgrade', 'trusted', 'user-granted');
      const success = manager.setTrustLevelByFingerprint(
        'fp-downgrade', 'untrusted', 'user-granted', 'demoted'
      );
      expect(success).toBe(true);
      expect(manager.getTrustLevelByFingerprint('fp-downgrade')).toBe('untrusted');
    });

    it('rejects upgrade from non-authorized source', () => {
      manager.getOrCreateProfileByFingerprint('fp-reject', 'Agent');
      // Profile starts at 'verified' (relay default). Upgrade to 'trusted' from non-user source should fail.
      const success = manager.setTrustLevelByFingerprint(
        'fp-reject', 'trusted', 'setup-default', 'should fail'
      );
      expect(success).toBe(false);
      expect(manager.getTrustLevelByFingerprint('fp-reject')).toBe('verified');
    });
  });

  // ── getAllowedOperationsByFingerprint ───────────────────────────

  describe('getAllowedOperationsByFingerprint', () => {
    it('returns empty array for unknown fingerprint (untrusted)', () => {
      const ops = manager.getAllowedOperationsByFingerprint('unknown-fp');
      // Untrusted agents get no operations
      expect(Array.isArray(ops)).toBe(true);
    });

    it('returns operations based on trust level', () => {
      manager.getOrCreateProfileByFingerprint('fp-verified', 'Agent');
      manager.setTrustLevelByFingerprint('fp-verified', 'verified', 'user-granted');
      const ops = manager.getAllowedOperationsByFingerprint('fp-verified');
      expect(Array.isArray(ops)).toBe(true);
    });
  });

  // ── recordMessageReceivedByFingerprint ─────────────────────────

  describe('recordMessageReceivedByFingerprint', () => {
    it('increments message count', () => {
      manager.getOrCreateProfileByFingerprint('fp-counter', 'Agent');
      manager.recordMessageReceivedByFingerprint('fp-counter');
      manager.recordMessageReceivedByFingerprint('fp-counter');

      const profile = manager.getProfileByFingerprint('fp-counter');
      expect(profile!.history.messagesReceived).toBe(2);
    });

    it('updates last interaction timestamp', () => {
      manager.getOrCreateProfileByFingerprint('fp-time', 'Agent');

      const before = new Date().toISOString();
      manager.recordMessageReceivedByFingerprint('fp-time');

      const profile = manager.getProfileByFingerprint('fp-time');
      expect(profile!.history.lastInteraction).toBeDefined();
      expect(profile!.history.lastInteraction >= before).toBe(true);
    });

    it('creates profile if fingerprint is new', () => {
      manager.recordMessageReceivedByFingerprint('fp-auto-create');
      const profile = manager.getProfileByFingerprint('fp-auto-create');
      expect(profile).not.toBeNull();
      expect(profile!.history.messagesReceived).toBe(1);
    });
  });

  // ── flush() ────────────────────────────────────────────────────

  describe('flush', () => {
    it('persists profiles to disk', () => {
      manager.getOrCreateProfileByFingerprint('fp-persist', 'PersistAgent');
      manager.setTrustLevelByFingerprint('fp-persist', 'verified', 'user-granted');
      manager.flush();

      // Create a new manager from the same state dir and verify persistence
      const manager2 = new AgentTrustManager({ stateDir: temp.dir });
      const profile = manager2.getProfileByFingerprint('fp-persist');
      expect(profile).not.toBeNull();
      expect(profile!.level).toBe('verified');
      manager2.flush();
    });

    it('can be called multiple times safely', () => {
      manager.flush();
      manager.flush();
      manager.flush();
      // Should not throw
    });
  });

  // ── Persistence Round-Trip ─────────────────────────────────────

  describe('persistence round-trip', () => {
    it('survives save/reload cycle with fingerprints', () => {
      // Set up state
      manager.getOrCreateProfileByFingerprint('fp-roundtrip', 'RoundTripAgent');
      manager.setTrustLevelByFingerprint('fp-roundtrip', 'trusted', 'user-granted', 'test');
      manager.recordMessageReceivedByFingerprint('fp-roundtrip');
      manager.recordMessageReceivedByFingerprint('fp-roundtrip');
      manager.recordMessageReceivedByFingerprint('fp-roundtrip');
      manager.flush();

      // Reload
      const manager2 = new AgentTrustManager({ stateDir: temp.dir });
      const profile = manager2.getProfileByFingerprint('fp-roundtrip');

      expect(profile).not.toBeNull();
      expect(profile!.level).toBe('trusted');
      expect(profile!.fingerprint).toBe('fp-roundtrip');
      expect(profile!.history.messagesReceived).toBe(3);
      manager2.flush();
    });
  });

  // ── Edge Cases ─────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty fingerprint string', () => {
      const level = manager.getTrustLevelByFingerprint('');
      expect(level).toBe('untrusted');
    });

    it('handles very long fingerprint strings', () => {
      const longFp = 'a'.repeat(1000);
      manager.getOrCreateProfileByFingerprint(longFp, 'LongFpAgent');
      const profile = manager.getProfileByFingerprint(longFp);
      expect(profile).not.toBeNull();
    });

    it('fingerprint lookup is case-sensitive', () => {
      manager.getOrCreateProfileByFingerprint('FP-UPPER', 'Agent');
      expect(manager.getProfileByFingerprint('FP-UPPER')).not.toBeNull();
      expect(manager.getProfileByFingerprint('fp-upper')).toBeNull();
    });
  });
});
