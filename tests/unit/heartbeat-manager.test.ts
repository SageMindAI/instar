/**
 * Unit tests for HeartbeatManager — distributed coordination.
 *
 * Tests:
 * - Heartbeat write/read/check lifecycle
 * - Split-brain detection
 * - Auto-failover (trigger, cooldown, max attempts, disable)
 * - Incoming heartbeat processing
 * - shouldDemote hot-path check
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HeartbeatManager } from '../../src/core/HeartbeatManager.js';
import type { Heartbeat } from '../../src/core/HeartbeatManager.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-heartbeat-test-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('HeartbeatManager', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => cleanup(tmpDir));

  // ── Write / Read ─────────────────────────────────────────────────

  describe('writeHeartbeat / readHeartbeat', () => {
    it('writes and reads a heartbeat', () => {
      const mgr = new HeartbeatManager(tmpDir, 'm_machine_a');
      const heartbeat = mgr.writeHeartbeat();

      expect(heartbeat.holder).toBe('m_machine_a');
      expect(heartbeat.role).toBe('awake');
      expect(heartbeat.timestamp).toBeTruthy();
      expect(heartbeat.expiresAt).toBeTruthy();

      const loaded = mgr.readHeartbeat();
      expect(loaded).toEqual(heartbeat);
    });

    it('returns null when no heartbeat exists', () => {
      const mgr = new HeartbeatManager(tmpDir, 'm_machine_a');
      expect(mgr.readHeartbeat()).toBeNull();
    });

    it('creates state directory if missing', () => {
      const mgr = new HeartbeatManager(path.join(tmpDir, 'deep', 'path'), 'm_machine_a');
      mgr.writeHeartbeat();
      expect(fs.existsSync(mgr.heartbeatPath)).toBe(true);
    });

    it('expiresAt is timeoutMs in the future', () => {
      const mgr = new HeartbeatManager(tmpDir, 'm_machine_a', { timeoutMs: 60_000 });
      const heartbeat = mgr.writeHeartbeat();

      const ts = new Date(heartbeat.timestamp).getTime();
      const expires = new Date(heartbeat.expiresAt).getTime();
      expect(expires - ts).toBe(60_000);
    });
  });

  // ── checkHeartbeat ───────────────────────────────────────────────

  describe('checkHeartbeat', () => {
    it('returns missing when no heartbeat file', () => {
      const mgr = new HeartbeatManager(tmpDir, 'm_machine_a');
      const result = mgr.checkHeartbeat();
      expect(result.status).toBe('missing');
    });

    it('returns healthy for fresh own heartbeat', () => {
      const mgr = new HeartbeatManager(tmpDir, 'm_machine_a');
      mgr.writeHeartbeat();
      const result = mgr.checkHeartbeat();
      expect(result.status).toBe('healthy');
      if (result.status === 'healthy') {
        expect(result.holder).toBe('m_machine_a');
        expect(result.ageMs).toBeLessThan(5000);
      }
    });

    it('returns healthy when another machine has a valid heartbeat', () => {
      // Machine A writes heartbeat
      const mgrA = new HeartbeatManager(tmpDir, 'm_machine_a');
      mgrA.writeHeartbeat();

      // Machine B checks
      const mgrB = new HeartbeatManager(tmpDir, 'm_machine_b');
      const result = mgrB.checkHeartbeat();
      expect(result.status).toBe('healthy');
      if (result.status === 'healthy') {
        expect(result.holder).toBe('m_machine_a');
      }
    });

    it('returns expired for old heartbeat', () => {
      const mgr = new HeartbeatManager(tmpDir, 'm_machine_a', { timeoutMs: 1 });
      mgr.writeHeartbeat();
      // Wait for expiry
      const start = Date.now();
      while (Date.now() - start < 5) { /* spin */ }

      const result = mgr.checkHeartbeat();
      expect(result.status).toBe('expired');
    });
  });

  // ── shouldDemote (hot-path) ──────────────────────────────────────

  describe('shouldDemote', () => {
    it('returns false when no heartbeat exists', () => {
      const mgr = new HeartbeatManager(tmpDir, 'm_machine_a');
      expect(mgr.shouldDemote()).toBe(false);
    });

    it('returns false when we hold the heartbeat', () => {
      const mgr = new HeartbeatManager(tmpDir, 'm_machine_a');
      mgr.writeHeartbeat();
      expect(mgr.shouldDemote()).toBe(false);
    });

    it('returns true when another machine has valid heartbeat', () => {
      // Machine B writes heartbeat
      const mgrB = new HeartbeatManager(tmpDir, 'm_machine_b');
      mgrB.writeHeartbeat();

      // Machine A checks
      const mgrA = new HeartbeatManager(tmpDir, 'm_machine_a');
      expect(mgrA.shouldDemote()).toBe(true);
    });

    it('returns false when other machines heartbeat is expired', () => {
      // Machine B writes heartbeat with very short timeout
      const mgrB = new HeartbeatManager(tmpDir, 'm_machine_b', { timeoutMs: 1 });
      mgrB.writeHeartbeat();
      const start = Date.now();
      while (Date.now() - start < 5) { /* spin */ }

      // Machine A checks — should NOT demote because heartbeat expired
      const mgrA = new HeartbeatManager(tmpDir, 'm_machine_a');
      expect(mgrA.shouldDemote()).toBe(false);
    });
  });

  // ── processIncomingHeartbeat ──────────────────────────────────────

  describe('processIncomingHeartbeat', () => {
    it('ignores heartbeat from self', () => {
      const mgr = new HeartbeatManager(tmpDir, 'm_machine_a');
      mgr.writeHeartbeat();
      const incoming: Heartbeat = {
        holder: 'm_machine_a',
        role: 'awake',
        timestamp: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      };
      expect(mgr.processIncomingHeartbeat(incoming)).toBe('ignore');
    });

    it('demotes when no local heartbeat and incoming claims awake', () => {
      const mgr = new HeartbeatManager(tmpDir, 'm_machine_a');
      const incoming: Heartbeat = {
        holder: 'm_machine_b',
        role: 'awake',
        timestamp: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      };
      expect(mgr.processIncomingHeartbeat(incoming)).toBe('demote');
    });

    it('demotes when incoming heartbeat is newer (split-brain resolution)', () => {
      const mgr = new HeartbeatManager(tmpDir, 'm_machine_a');
      mgr.writeHeartbeat();

      // Incoming from machine B with a newer timestamp
      const incoming: Heartbeat = {
        holder: 'm_machine_b',
        role: 'awake',
        timestamp: new Date(Date.now() + 1000).toISOString(),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      };
      expect(mgr.processIncomingHeartbeat(incoming)).toBe('demote');
    });

    it('tells them to demote when our heartbeat is newer', () => {
      const mgr = new HeartbeatManager(tmpDir, 'm_machine_a');
      mgr.writeHeartbeat();

      // Incoming from machine B with an older timestamp
      const incoming: Heartbeat = {
        holder: 'm_machine_b',
        role: 'awake',
        timestamp: new Date(Date.now() - 10_000).toISOString(),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      };
      expect(mgr.processIncomingHeartbeat(incoming)).toBe('they-should-demote');
    });
  });

  // ── Failover ─────────────────────────────────────────────────────

  describe('shouldFailover', () => {
    it('returns false when disabled', () => {
      const mgr = new HeartbeatManager(tmpDir, 'm_standby', { enabled: false });
      const result = mgr.shouldFailover();
      expect(result.should).toBe(false);
      expect(result.reason).toContain('disabled');
    });

    it('returns false when heartbeat is still valid', () => {
      const mgrAwake = new HeartbeatManager(tmpDir, 'm_awake');
      mgrAwake.writeHeartbeat();

      const mgrStandby = new HeartbeatManager(tmpDir, 'm_standby');
      const result = mgrStandby.shouldFailover();
      expect(result.should).toBe(false);
      expect(result.reason).toContain('still valid');
    });

    it('returns true when heartbeat has expired', () => {
      const mgrAwake = new HeartbeatManager(tmpDir, 'm_awake', { timeoutMs: 1 });
      mgrAwake.writeHeartbeat();
      const start = Date.now();
      while (Date.now() - start < 5) { /* spin */ }

      const mgrStandby = new HeartbeatManager(tmpDir, 'm_standby');
      const result = mgrStandby.shouldFailover();
      expect(result.should).toBe(true);
      expect(result.reason).toContain('expired');
    });

    it('returns true when no heartbeat file exists', () => {
      const mgr = new HeartbeatManager(tmpDir, 'm_standby');
      const result = mgr.shouldFailover();
      expect(result.should).toBe(true);
      expect(result.reason).toContain('No heartbeat');
    });

    it('enforces cooldown between failovers', () => {
      const mgr = new HeartbeatManager(tmpDir, 'm_standby');
      mgr.recordFailover();

      const result = mgr.shouldFailover();
      expect(result.should).toBe(false);
      expect(result.reason).toContain('Cooldown');
    });

    it('disables after 3 failovers in 24 hours', () => {
      const mgr = new HeartbeatManager(tmpDir, 'm_standby');

      // Fake 3 recent failovers (bypass cooldown by setting timestamps apart)
      const state = mgr.getFailoverState();
      const now = Date.now();
      state.recentFailovers = [
        now - 12 * 60 * 60_000,
        now - 6 * 60 * 60_000,
        now - 2 * 60 * 60_000,
      ];
      // Inject the state (a bit hacky but tests the logic)
      (mgr as any).failoverState = state;

      const result = mgr.shouldFailover();
      expect(result.should).toBe(false);
      expect(result.reason).toContain('too many failovers');
    });

    it('resetFailoverState re-enables failover', () => {
      const mgr = new HeartbeatManager(tmpDir, 'm_standby');
      mgr.recordFailover();

      // Disable it
      (mgr as any).failoverState.disabled = true;
      expect(mgr.shouldFailover().should).toBe(false);

      // Reset
      mgr.resetFailoverState();
      expect(mgr.shouldFailover().should).toBe(true); // No heartbeat = should failover
    });
  });

  // ── recordFailover ───────────────────────────────────────────────

  describe('recordFailover', () => {
    it('records timestamp', () => {
      const mgr = new HeartbeatManager(tmpDir, 'm_standby');
      mgr.recordFailover();
      expect(mgr.getFailoverState().recentFailovers).toHaveLength(1);
    });

    it('prunes old entries beyond 24h', () => {
      const mgr = new HeartbeatManager(tmpDir, 'm_standby');
      const state = mgr.getFailoverState();
      state.recentFailovers = [Date.now() - 48 * 60 * 60_000]; // 48h ago
      (mgr as any).failoverState = state;

      mgr.recordFailover(); // Triggers prune

      expect(mgr.getFailoverState().recentFailovers).toHaveLength(1);
    });
  });
});
