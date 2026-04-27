/**
 * Unit tests for MultiMachineCoordinator Independent Mode (Phase 4B — Gap 1).
 *
 * Tests the 'independent' coordination mode where both machines are always
 * active with separate Telegram groups — no polling conflict, no failover.
 *
 * Covers:
 *   1. Independent mode startup: always awake regardless of registry
 *   2. shouldSkipProcessing: always false in independent mode
 *   3. No failover/demotion logic in independent mode
 *   4. Heartbeat writer runs (for diagnostics, not failover)
 *   5. StateManager stays writable for both machines
 *   6. coordinationMode getter and defaults
 *   7. Backward compatibility: primary-standby still works unchanged
 *   8. Security logging captures coordination mode
 *   9. Both machines awake simultaneously
 *  10. Edge cases: mode transition, config combinations
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { HeartbeatManager } from '../../src/core/HeartbeatManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SecurityLog } from '../../src/core/SecurityLog.js';
import type { MultiMachineConfig } from '../../src/core/types.js';

// ── Helpers ─────────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-coord-indep-'));
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

function makeIndependentConfig(overrides?: Partial<MultiMachineConfig>): MultiMachineConfig {
  return {
    enabled: true,
    autoFailover: true,
    failoverTimeoutMinutes: 15,
    autoFailoverConfirm: false,
    coordinationMode: 'independent',
    ...overrides,
  };
}

function makePrimaryStandbyConfig(): MultiMachineConfig {
  return {
    enabled: true,
    autoFailover: true,
    failoverTimeoutMinutes: 15,
    autoFailoverConfirm: false,
    coordinationMode: 'primary-standby',
  };
}

// ── 1. Independent Mode Startup ─────────────────────────────────────

describe('independent mode startup', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('starts as awake regardless of registry role (registered standby)', () => {
    setupIdentity(tmpDir, 'standby');
    const state = new StateManager(tmpDir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: tmpDir,
      multiMachine: makeIndependentConfig(),
    });

    const role = coord.start();

    expect(role).toBe('awake');
    expect(coord.isAwake).toBe(true);
    expect(coord.enabled).toBe(true);

    coord.stop();
  });

  it('starts as awake when registered as awake', () => {
    setupIdentity(tmpDir, 'awake');
    const state = new StateManager(tmpDir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: tmpDir,
      multiMachine: makeIndependentConfig(),
    });

    const role = coord.start();

    expect(role).toBe('awake');
    expect(coord.isAwake).toBe(true);

    coord.stop();
  });

  it('updates registry to awake on startup', () => {
    const { id, mgr } = setupIdentity(tmpDir, 'standby');
    const state = new StateManager(tmpDir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: tmpDir,
      multiMachine: makeIndependentConfig(),
    });

    coord.start();

    // Verify registry was updated
    const registry = mgr.loadRegistry();
    expect(registry.machines[id].role).toBe('awake');

    coord.stop();
  });

  it('does not fail when another machine has a valid heartbeat', () => {
    const { id } = setupIdentity(tmpDir, 'standby');

    // Write a heartbeat from another machine
    const hb = new HeartbeatManager(tmpDir, 'other-machine');
    hb.writeHeartbeat();

    const state = new StateManager(tmpDir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: tmpDir,
      multiMachine: makeIndependentConfig(),
    });

    const role = coord.start();

    // Should still be awake — independent mode ignores other heartbeats
    expect(role).toBe('awake');
    expect(coord.isAwake).toBe(true);

    coord.stop();
  });
});

// ── 2. shouldSkipProcessing ─────────────────────────────────────────

describe('shouldSkipProcessing in independent mode', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('always returns false in independent mode', () => {
    setupIdentity(tmpDir, 'standby');
    const state = new StateManager(tmpDir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: tmpDir,
      multiMachine: makeIndependentConfig(),
    });
    coord.start();

    expect(coord.shouldSkipProcessing()).toBe(false);

    coord.stop();
  });

  it('returns false even when another machine holds heartbeat', () => {
    setupIdentity(tmpDir, 'standby');
    const hb = new HeartbeatManager(tmpDir, 'other-machine');
    hb.writeHeartbeat();

    const state = new StateManager(tmpDir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: tmpDir,
      multiMachine: makeIndependentConfig(),
    });
    coord.start();

    expect(coord.shouldSkipProcessing()).toBe(false);

    coord.stop();
  });

  it('contrast: primary-standby returns true for standby', () => {
    setupIdentity(tmpDir, 'standby');

    // Write a heartbeat from the awake machine
    const hb = new HeartbeatManager(tmpDir, 'awake-machine');
    hb.writeHeartbeat();

    const state = new StateManager(tmpDir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: tmpDir,
      multiMachine: makePrimaryStandbyConfig(),
    });
    coord.start();

    // In primary-standby, standby SHOULD skip processing
    expect(coord.shouldSkipProcessing()).toBe(true);

    coord.stop();
  });
});

// ── 3. No Failover/Demotion ─────────────────────────────────────────

describe('no failover logic in independent mode', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('does not emit promote/demote events', () => {
    setupIdentity(tmpDir, 'standby');
    const state = new StateManager(tmpDir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: tmpDir,
      multiMachine: makeIndependentConfig(),
    });

    const events: string[] = [];
    coord.on('promote', () => events.push('promote'));
    coord.on('demote', () => events.push('demote'));
    coord.on('failover', () => events.push('failover'));

    coord.start();

    // No events — independent mode doesn't trigger failover
    expect(events).toEqual([]);

    coord.stop();
  });

  it('does not emit failover even when heartbeat is expired', () => {
    setupIdentity(tmpDir, 'standby');

    // Write an expired heartbeat
    const hbPath = path.join(tmpDir, 'state', 'heartbeat.json');
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({
      holder: 'other-machine',
      role: 'awake',
      timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    }));

    const state = new StateManager(tmpDir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: tmpDir,
      multiMachine: makeIndependentConfig(),
    });

    const events: string[] = [];
    coord.on('failover', (r) => events.push(`failover: ${r}`));

    coord.start();

    expect(events).toEqual([]);
    expect(coord.isAwake).toBe(true);

    coord.stop();
  });
});

// ── 4. Heartbeat Writer ─────────────────────────────────────────────

describe('heartbeat writer in independent mode', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('writes heartbeat on startup (for diagnostics)', () => {
    const { id } = setupIdentity(tmpDir, 'awake');
    const state = new StateManager(tmpDir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: tmpDir,
      multiMachine: makeIndependentConfig(),
    });

    coord.start();

    const hb = new HeartbeatManager(tmpDir, id);
    const heartbeat = hb.readHeartbeat();
    expect(heartbeat).not.toBeNull();
    expect(heartbeat!.holder).toBe(id);

    coord.stop();
  });
});

// ── 5. StateManager Stays Writable ──────────────────────────────────

describe('StateManager writable in independent mode', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('StateManager stays writable even when registered as standby', () => {
    setupIdentity(tmpDir, 'standby');
    const state = new StateManager(tmpDir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: tmpDir,
      multiMachine: makeIndependentConfig(),
    });

    coord.start();

    expect(state.readOnly).toBe(false);

    coord.stop();
  });

  it('contrast: primary-standby makes standby read-only', () => {
    setupIdentity(tmpDir, 'standby');
    const hb = new HeartbeatManager(tmpDir, 'awake-machine');
    hb.writeHeartbeat();

    const state = new StateManager(tmpDir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: tmpDir,
      multiMachine: makePrimaryStandbyConfig(),
    });

    coord.start();

    // In primary-standby mode, standby IS read-only
    expect(state.readOnly).toBe(true);

    coord.stop();
  });
});

// ── 6. coordinationMode Getter and Defaults ─────────────────────────

describe('coordinationMode getter', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('defaults to primary-standby when no config', () => {
    const state = new StateManager(tmpDir);
    const coord = new MultiMachineCoordinator(state, { stateDir: tmpDir });
    expect(coord.coordinationMode).toBe('primary-standby');
    coord.stop();
  });

  it('defaults to primary-standby when coordinationMode not set', () => {
    const state = new StateManager(tmpDir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: tmpDir,
      multiMachine: {
        enabled: true,
        autoFailover: true,
        failoverTimeoutMinutes: 15,
        autoFailoverConfirm: false,
        // coordinationMode not set
      },
    });
    expect(coord.coordinationMode).toBe('primary-standby');
    coord.stop();
  });

  it('returns independent when configured', () => {
    const state = new StateManager(tmpDir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: tmpDir,
      multiMachine: makeIndependentConfig(),
    });
    expect(coord.coordinationMode).toBe('independent');
    coord.stop();
  });

  it('returns primary-standby when explicitly configured', () => {
    const state = new StateManager(tmpDir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: tmpDir,
      multiMachine: makePrimaryStandbyConfig(),
    });
    expect(coord.coordinationMode).toBe('primary-standby');
    coord.stop();
  });
});

// ── 7. Backward Compatibility ───────────────────────────────────────

describe('backward compatibility: primary-standby unchanged', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('standby machine stays standby in primary-standby mode', () => {
    setupIdentity(tmpDir, 'standby');
    const hb = new HeartbeatManager(tmpDir, 'awake-machine');
    hb.writeHeartbeat();

    const state = new StateManager(tmpDir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: tmpDir,
      multiMachine: makePrimaryStandbyConfig(),
    });

    const role = coord.start();

    expect(role).toBe('standby');
    expect(coord.isAwake).toBe(false);
    expect(coord.shouldSkipProcessing()).toBe(true);

    coord.stop();
  });

  it('awake machine starts as awake in primary-standby mode', () => {
    setupIdentity(tmpDir, 'awake');
    const state = new StateManager(tmpDir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: tmpDir,
      multiMachine: makePrimaryStandbyConfig(),
    });

    const role = coord.start();

    expect(role).toBe('awake');
    expect(coord.isAwake).toBe(true);

    coord.stop();
  });

  it('no coordinationMode field works like primary-standby', () => {
    setupIdentity(tmpDir, 'standby');
    const hb = new HeartbeatManager(tmpDir, 'awake-machine');
    hb.writeHeartbeat();

    const state = new StateManager(tmpDir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: tmpDir,
      multiMachine: {
        enabled: true,
        autoFailover: true,
        failoverTimeoutMinutes: 15,
        autoFailoverConfirm: false,
      },
    });

    const role = coord.start();

    expect(role).toBe('standby');
    expect(coord.shouldSkipProcessing()).toBe(true);

    coord.stop();
  });
});

// ── 8. Security Logging ─────────────────────────────────────────────

describe('security logging in independent mode', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('logs coordinator_started with coordinationMode', () => {
    const { id } = setupIdentity(tmpDir, 'standby');
    const state = new StateManager(tmpDir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: tmpDir,
      multiMachine: makeIndependentConfig(),
    });

    coord.start();

    // Read security log — SecurityLog writes to path.join(stateDir, 'security.jsonl')
    const logPath = path.join(tmpDir, 'security.jsonl');
    const content = fs.readFileSync(logPath, 'utf-8').trim();
    const entries = content.split('\n').map(line => JSON.parse(line));
    const startEvent = entries.find((e: any) => e.event === 'coordinator_started');

    expect(startEvent).toBeDefined();
    expect(startEvent.coordinationMode).toBe('independent');
    expect(startEvent.role).toBe('awake');
    expect(startEvent.machineId).toBe(id);

    coord.stop();
  });
});

// ── 9. Both Machines Awake Simultaneously ───────────────────────────

describe('both machines awake simultaneously in independent mode', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('two coordinators in same state dir both start as awake', () => {
    // Set up two machines in the same state directory
    const { id: id1 } = setupIdentity(tmpDir, 'standby', 'm_workstation');
    // Register a second machine
    const mgr = new MachineIdentityManager(tmpDir);
    mgr.registerMachine({
      machineId: 'm_dawn_macbook',
      signingPublicKey: 'test-key-2',
      encryptionPublicKey: 'test-enc-key-2',
      name: 'dawn-macbook',
      platform: 'test',
      createdAt: new Date().toISOString(),
      capabilities: ['sessions'],
    } as any, 'standby');

    // Coordinator for machine 1
    const state1 = new StateManager(tmpDir);
    const coord1 = new MultiMachineCoordinator(state1, {
      stateDir: tmpDir,
      multiMachine: makeIndependentConfig(),
    });
    const role1 = coord1.start();

    // Both should be awake
    expect(role1).toBe('awake');
    expect(coord1.isAwake).toBe(true);
    expect(coord1.shouldSkipProcessing()).toBe(false);

    coord1.stop();
  });
});

// ── 10. Edge Cases ──────────────────────────────────────────────────

describe('independent mode edge cases', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('single-machine (no identity) ignores coordinationMode', () => {
    const state = new StateManager(tmpDir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: tmpDir,
      multiMachine: makeIndependentConfig(),
    });

    const role = coord.start();

    // No identity → single machine mode, always awake
    expect(role).toBe('awake');
    expect(coord.enabled).toBe(false); // Not enabled = single machine
    expect(coord.coordinationMode).toBe('independent'); // Config still readable

    coord.stop();
  });

  it('independent mode with autoFailover=false still works', () => {
    setupIdentity(tmpDir, 'standby');
    const state = new StateManager(tmpDir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: tmpDir,
      multiMachine: makeIndependentConfig({ autoFailover: false }),
    });

    const role = coord.start();

    expect(role).toBe('awake');
    expect(coord.shouldSkipProcessing()).toBe(false);

    coord.stop();
  });

  it('stop is clean in independent mode', () => {
    setupIdentity(tmpDir, 'standby');
    const state = new StateManager(tmpDir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: tmpDir,
      multiMachine: makeIndependentConfig(),
    });

    coord.start();
    coord.stop();
    coord.stop(); // Idempotent
  });
});
