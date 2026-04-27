/**
 * Integration tests for MultiMachineCoordinator + AgentServer wiring.
 *
 * Tests that the coordinator correctly gates server behavior:
 * - Single-machine: everything works normally
 * - Awake machine: machine routes mounted, processing active
 * - Standby machine: processing gated, state read-only
 * - Runtime role transitions: promote/demote affect server behavior
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { HeartbeatManager } from '../../src/core/HeartbeatManager.js';
import { StateManager } from '../../src/core/StateManager.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-coord-int-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

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

  const machineDir = path.join(stateDir, 'machine');
  fs.mkdirSync(machineDir, { recursive: true });
  fs.writeFileSync(path.join(machineDir, 'identity.json'), JSON.stringify(identity));
  mgr.registerMachine(identity as any, role);

  return { mgr, identity, id };
}

describe('Coordinator + Server Integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── Single-machine mode ──────────────────────────────────────

  describe('single-machine mode', () => {
    it('coordinator does not interfere with StateManager', () => {
      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      coord.start();

      // State should remain writable
      state.set('test-key', 'test-value');
      expect(state.get('test-key')).toBe('test-value');

      // No multi-machine overhead
      expect(coord.enabled).toBe(false);
      expect(coord.shouldSkipProcessing()).toBe(false);
      coord.stop();
    });
  });

  // ── Awake machine lifecycle ──────────────────────────────────

  describe('awake machine lifecycle', () => {
    it('state stays writable and processing is active', () => {
      setupIdentity(tmpDir, 'awake');
      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      coord.start();

      expect(coord.isAwake).toBe(true);
      expect(state.readOnly).toBe(false);
      expect(coord.shouldSkipProcessing()).toBe(false);

      // Can write state
      state.set('foo', 'bar');
      expect(state.get('foo')).toBe('bar');

      coord.stop();
    });

    it('heartbeat is maintained', () => {
      const { id } = setupIdentity(tmpDir, 'awake');
      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      coord.start();

      // Heartbeat should be written
      const hb = new HeartbeatManager(tmpDir, id);
      const heartbeat = hb.readHeartbeat();
      expect(heartbeat).not.toBeNull();
      expect(heartbeat!.holder).toBe(id);

      coord.stop();
    });

    it('demotes at runtime and blocks writes', () => {
      setupIdentity(tmpDir, 'awake');
      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      coord.start();

      expect(coord.isAwake).toBe(true);
      state.set('before', 'demotion');

      // Demote
      coord.demoteToStandby('runtime test');
      expect(coord.isAwake).toBe(false);
      expect(state.readOnly).toBe(true);
      expect(coord.shouldSkipProcessing()).toBe(true);

      // Writes blocked
      expect(() => state.set('after', 'demotion')).toThrow('read-only');

      coord.stop();
    });
  });

  // ── Standby machine lifecycle ────────────────────────────────

  describe('standby machine lifecycle', () => {
    it('blocks writes and gates processing', () => {
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

      expect(coord.isAwake).toBe(false);
      expect(state.readOnly).toBe(true);
      expect(coord.shouldSkipProcessing()).toBe(true);

      // Writes blocked
      expect(() => state.set('key', 'value')).toThrow('read-only');

      coord.stop();
    });

    it('promotes at runtime and enables writes', () => {
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

      expect(coord.isAwake).toBe(false);
      expect(state.readOnly).toBe(true);

      // Promote
      coord.promoteToAwake('runtime failover test');
      expect(coord.isAwake).toBe(true);
      expect(state.readOnly).toBe(false);
      expect(coord.shouldSkipProcessing()).toBe(false);

      // Can write now
      state.set('after', 'promotion');
      expect(state.get('after')).toBe('promotion');

      coord.stop();
    });
  });

  // ── Failover scenarios ───────────────────────────────────────

  describe('failover scenarios', () => {
    it('standby auto-promotes when awake machine disappears', () => {
      // Register standby with no active heartbeat → should failover
      setupIdentity(tmpDir, 'standby');
      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      const role = coord.start();

      expect(role).toBe('awake'); // Auto-promoted
      expect(coord.isAwake).toBe(true);
      expect(state.readOnly).toBe(false);
      coord.stop();
    });

    it('awake demotes when it discovers another machine took over', () => {
      const { id: myId } = setupIdentity(tmpDir, 'awake');
      const otherId = `m_${require('crypto').randomBytes(16).toString('hex')}`;

      // Another machine has a valid heartbeat
      new HeartbeatManager(tmpDir, otherId).writeHeartbeat();

      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      const role = coord.start();

      expect(role).toBe('standby'); // Auto-demoted
      expect(state.readOnly).toBe(true);
      coord.stop();
    });

    it('role change events fire correctly', () => {
      setupIdentity(tmpDir, 'awake');
      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      coord.start();

      const events: Array<{ type: string; from?: string; to?: string }> = [];
      coord.on('promote', () => events.push({ type: 'promote' }));
      coord.on('demote', () => events.push({ type: 'demote' }));
      coord.on('roleChange', (from, to) => events.push({ type: 'roleChange', from, to }));

      coord.demoteToStandby('test');
      coord.promoteToAwake('test');

      expect(events).toEqual([
        { type: 'demote' },
        { type: 'roleChange', from: 'awake', to: 'standby' },
        { type: 'promote' },
        { type: 'roleChange', from: 'standby', to: 'awake' },
      ]);

      coord.stop();
    });
  });

  // ── Security audit trail ─────────────────────────────────────

  describe('security audit trail', () => {
    it('records full lifecycle in security log', () => {
      setupIdentity(tmpDir, 'awake');
      const state = new StateManager(tmpDir);
      const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
      coord.start();

      // Demote then promote
      coord.demoteToStandby('test demotion');
      coord.promoteToAwake('test promotion');

      const log = coord.managers.securityLog.readAll();

      // Should have: coordinator_started, role_transition (demote), role_transition (promote)
      expect(log.filter(e => e.event === 'coordinator_started')).toHaveLength(1);
      expect(log.filter(e => e.event === 'role_transition')).toHaveLength(2);

      const demoteEvent = log.find(e => e.event === 'role_transition' && e.to === 'standby');
      expect(demoteEvent).toBeTruthy();
      expect(demoteEvent!.from).toBe('awake');
      expect(demoteEvent!.reason).toBe('test demotion');

      const promoteEvent = log.find(e => e.event === 'role_transition' && e.to === 'awake');
      expect(promoteEvent).toBeTruthy();
      expect(promoteEvent!.from).toBe('standby');
      expect(promoteEvent!.reason).toBe('test promotion');

      coord.stop();
    });
  });
});
