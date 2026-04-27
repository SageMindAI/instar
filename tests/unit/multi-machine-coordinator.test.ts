/**
 * Unit tests for MultiMachineCoordinator.
 *
 * Tests:
 * - Single-machine mode (no identity → always awake, not enabled)
 * - Startup role detection (awake when registered as awake)
 * - Startup role detection (standby when registered as standby)
 * - Startup auto-failover (standby promotes when heartbeat expired)
 * - Startup demote (awake demotes when another machine has valid heartbeat)
 * - StateManager read-only enforcement
 * - shouldSkipProcessing (hot-path check)
 * - promoteToAwake / demoteToStandby
 * - Event emissions
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { HeartbeatManager } from '../../src/core/HeartbeatManager.js';
import { StateManager } from '../../src/core/StateManager.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-coordinator-test-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Set up an identity for testing without the full async generateIdentity flow.
 */
function setupIdentity(stateDir: string, role: 'awake' | 'standby' = 'awake', machineId?: string) {
  const mgr = new MachineIdentityManager(stateDir);
  const id = machineId || `m_${require('crypto').randomBytes(16).toString('hex')}`;

  const identity = {
    machineId: id,
    signingPublicKey: 'test-key',
    encryptionPublicKey: 'test-enc-key',
    name: 'test-machine',
    platform: 'test',
    createdAt: new Date().toISOString(),
    capabilities: ['sessions'],
  };

  // Write identity file
  const machineDir = path.join(stateDir, 'machine');
  fs.mkdirSync(machineDir, { recursive: true });
  fs.writeFileSync(path.join(machineDir, 'identity.json'), JSON.stringify(identity));

  // Register in registry
  mgr.registerMachine(identity as any, role);

  return { mgr, identity, id };
}

describe('MultiMachineCoordinator', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── Single-machine mode ────────────────────────────────────────

  describe('single-machine mode (no identity)', () => {
    it('is not enabled', () => {
      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      coord.start();
      expect(coord.enabled).toBe(false);
      coord.stop();
    });

    it('role is awake', () => {
      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      const role = coord.start();
      expect(role).toBe('awake');
      expect(coord.isAwake).toBe(true);
      coord.stop();
    });

    it('shouldSkipProcessing returns false', () => {
      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      coord.start();
      expect(coord.shouldSkipProcessing()).toBe(false);
      coord.stop();
    });

    it('StateManager stays writable', () => {
      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      coord.start();
      expect(state.readOnly).toBe(false);
      coord.stop();
    });
  });

  // ── Multi-machine: awake startup ───────────────────────────────

  describe('startup as awake machine', () => {
    it('detects awake role from registry', () => {
      const { id } = setupIdentity(tmpDir, 'awake');
      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      const role = coord.start();
      expect(role).toBe('awake');
      expect(coord.isAwake).toBe(true);
      expect(coord.enabled).toBe(true);
      coord.stop();
    });

    it('writes initial heartbeat', () => {
      const { id } = setupIdentity(tmpDir, 'awake');
      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      coord.start();

      const hb = new HeartbeatManager(tmpDir, id);
      const heartbeat = hb.readHeartbeat();
      expect(heartbeat).not.toBeNull();
      expect(heartbeat!.holder).toBe(id);
      coord.stop();
    });

    it('StateManager stays writable', () => {
      setupIdentity(tmpDir, 'awake');
      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      coord.start();
      expect(state.readOnly).toBe(false);
      coord.stop();
    });
  });

  // ── Multi-machine: standby startup ─────────────────────────────

  describe('startup as standby machine', () => {
    it('detects standby role from registry', () => {
      // Set up an awake machine with a valid heartbeat
      const awakeId = `m_${require('crypto').randomBytes(16).toString('hex')}`;
      const { id: standbyId } = setupIdentity(tmpDir, 'standby');

      // Register the awake machine and write its heartbeat
      const mgr = new MachineIdentityManager(tmpDir);
      mgr.registerMachine({
        machineId: awakeId,
        signingPublicKey: 'awake-key',
        encryptionPublicKey: 'awake-enc',
        name: 'awake-machine',
        platform: 'test',
        createdAt: new Date().toISOString(),
        capabilities: ['sessions'],
      } as any, 'awake');

      const hb = new HeartbeatManager(tmpDir, awakeId);
      hb.writeHeartbeat();

      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      const role = coord.start();
      expect(role).toBe('standby');
      expect(coord.isAwake).toBe(false);
      coord.stop();
    });

    it('sets StateManager to read-only', () => {
      // Write a valid heartbeat from another machine
      const awakeId = `m_${require('crypto').randomBytes(16).toString('hex')}`;
      setupIdentity(tmpDir, 'standby');
      const mgr = new MachineIdentityManager(tmpDir);
      mgr.registerMachine({
        machineId: awakeId, signingPublicKey: 'k', encryptionPublicKey: 'k',
        name: 'awake', platform: 'test', createdAt: new Date().toISOString(), capabilities: ['sessions'],
      } as any, 'awake');
      new HeartbeatManager(tmpDir, awakeId).writeHeartbeat();

      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      coord.start();
      expect(state.readOnly).toBe(true);
      coord.stop();
    });

    it('shouldSkipProcessing returns true', () => {
      const awakeId = `m_${require('crypto').randomBytes(16).toString('hex')}`;
      setupIdentity(tmpDir, 'standby');
      const mgr = new MachineIdentityManager(tmpDir);
      mgr.registerMachine({
        machineId: awakeId, signingPublicKey: 'k', encryptionPublicKey: 'k',
        name: 'awake', platform: 'test', createdAt: new Date().toISOString(), capabilities: ['sessions'],
      } as any, 'awake');
      new HeartbeatManager(tmpDir, awakeId).writeHeartbeat();

      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      coord.start();
      expect(coord.shouldSkipProcessing()).toBe(true);
      coord.stop();
    });
  });

  // ── Auto-failover on startup ───────────────────────────────────

  describe('startup failover', () => {
    it('promotes standby when no heartbeat exists', () => {
      setupIdentity(tmpDir, 'standby');
      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      const role = coord.start();
      // Should failover to awake because there's no heartbeat at all
      expect(role).toBe('awake');
      coord.stop();
    });

    it('promotes standby when heartbeat is expired', () => {
      const awakeId = `m_${require('crypto').randomBytes(16).toString('hex')}`;
      setupIdentity(tmpDir, 'standby');
      const mgr = new MachineIdentityManager(tmpDir);
      mgr.registerMachine({
        machineId: awakeId, signingPublicKey: 'k', encryptionPublicKey: 'k',
        name: 'awake', platform: 'test', createdAt: new Date().toISOString(), capabilities: ['sessions'],
      } as any, 'awake');

      // Write an expired heartbeat
      const hb = new HeartbeatManager(tmpDir, awakeId, { timeoutMs: 1 });
      hb.writeHeartbeat();
      // Wait for expiry
      const start = Date.now();
      while (Date.now() - start < 5) { /* spin */ }

      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      const role = coord.start();
      expect(role).toBe('awake');
      coord.stop();
    });
  });

  // ── Startup demote ─────────────────────────────────────────────

  describe('startup demote (someone else took over)', () => {
    it('demotes awake when another machine has valid heartbeat', () => {
      const { id: myId } = setupIdentity(tmpDir, 'awake');
      const otherId = `m_${require('crypto').randomBytes(16).toString('hex')}`;

      // Write a heartbeat from the other machine
      const hb = new HeartbeatManager(tmpDir, otherId);
      hb.writeHeartbeat();

      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      const role = coord.start();
      expect(role).toBe('standby');
      expect(state.readOnly).toBe(true);
      coord.stop();
    });
  });

  // ── Role transitions ───────────────────────────────────────────

  describe('role transitions', () => {
    it('promoteToAwake sets role and enables writes', () => {
      const awakeId = `m_${require('crypto').randomBytes(16).toString('hex')}`;
      setupIdentity(tmpDir, 'standby');
      const mgr = new MachineIdentityManager(tmpDir);
      mgr.registerMachine({
        machineId: awakeId, signingPublicKey: 'k', encryptionPublicKey: 'k',
        name: 'awake', platform: 'test', createdAt: new Date().toISOString(), capabilities: ['sessions'],
      } as any, 'awake');
      new HeartbeatManager(tmpDir, awakeId).writeHeartbeat();

      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      coord.start();
      expect(coord.role).toBe('standby');
      expect(state.readOnly).toBe(true);

      coord.promoteToAwake('test promotion');
      expect(coord.role).toBe('awake');
      expect(coord.isAwake).toBe(true);
      expect(state.readOnly).toBe(false);
      coord.stop();
    });

    it('demoteToStandby sets role and enables read-only', () => {
      setupIdentity(tmpDir, 'awake');
      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      coord.start();
      expect(coord.role).toBe('awake');

      coord.demoteToStandby('test demotion');
      expect(coord.role).toBe('standby');
      expect(state.readOnly).toBe(true);
      coord.stop();
    });

    it('emits events on role change', () => {
      setupIdentity(tmpDir, 'awake');
      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      coord.start();

      const events: string[] = [];
      coord.on('demote', () => events.push('demote'));
      coord.on('promote', () => events.push('promote'));
      coord.on('roleChange', (from, to) => events.push(`${from}->${to}`));

      coord.demoteToStandby('test');
      expect(events).toContain('demote');
      expect(events).toContain('awake->standby');

      coord.promoteToAwake('test');
      expect(events).toContain('promote');
      expect(events).toContain('standby->awake');
      coord.stop();
    });
  });

  // ── Security log ───────────────────────────────────────────────

  describe('security logging', () => {
    it('logs coordinator start', () => {
      setupIdentity(tmpDir, 'awake');
      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      coord.start();

      const events = coord.managers.securityLog.readAll();
      const startEvents = events.filter(e => e.event === 'coordinator_started');
      expect(startEvents.length).toBe(1);
      coord.stop();
    });

    it('logs role transitions', () => {
      setupIdentity(tmpDir, 'awake');
      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      coord.start();

      coord.demoteToStandby('test');

      const events = coord.managers.securityLog.readAll();
      const roleEvents = events.filter(e => e.event === 'role_transition');
      expect(roleEvents.length).toBe(1);
      expect(roleEvents[0].from).toBe('awake');
      expect(roleEvents[0].to).toBe('standby');
      coord.stop();
    });
  });
});
