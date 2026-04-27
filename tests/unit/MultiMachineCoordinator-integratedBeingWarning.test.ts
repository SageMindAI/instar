/**
 * Integrated-Being v1 — multi-machine warning on coordinator start.
 *
 * Spec §Multi-machine: "on server start, if machines/registry.json shows >1
 * machine for this agent, emit a one-time log warning."
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { StateManager } from '../../src/core/StateManager.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-ib-test-'));
}

function seedIdentity(stateDir: string, machineId: string) {
  const identity = {
    machineId,
    signingPublicKey: 'k1',
    encryptionPublicKey: 'k2',
    name: 'test-machine',
    platform: 'test',
    createdAt: new Date().toISOString(),
    capabilities: ['sessions'],
  };
  fs.mkdirSync(path.join(stateDir, 'machine'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'machine', 'identity.json'), JSON.stringify(identity));
  return identity;
}

describe('MultiMachineCoordinator — Integrated-Being multi-machine warning', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does NOT warn with only one machine in the registry', () => {
    const machineId = `m_${crypto.randomBytes(8).toString('hex')}`;
    const identity = seedIdentity(dir, machineId);
    const mgr = new MachineIdentityManager(dir);
    mgr.registerMachine(identity as any, 'awake');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = new StateManager(dir);
    const coord = new MultiMachineCoordinator(state, { stateDir: dir });
    coord.start();

    const integratedBeingCalls = warnSpy.mock.calls.filter(
      (c) => String(c[0] ?? '').includes('[integrated-being]'),
    );
    expect(integratedBeingCalls.length).toBe(0);
    warnSpy.mockRestore();
    coord.stop();
  });

  it('warns exactly once when registry has >1 machine', () => {
    const machineId = `m_${crypto.randomBytes(8).toString('hex')}`;
    const otherId = `m_${crypto.randomBytes(8).toString('hex')}`;
    const identity = seedIdentity(dir, machineId);
    const mgr = new MachineIdentityManager(dir);
    mgr.registerMachine(identity as any, 'awake');
    mgr.registerMachine({ ...identity, machineId: otherId, name: 'other' } as any, 'standby');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = new StateManager(dir);
    const coord = new MultiMachineCoordinator(state, { stateDir: dir });
    coord.start();

    const calls = warnSpy.mock.calls.filter(
      (c) => String(c[0] ?? '').includes('[integrated-being]'),
    );
    expect(calls.length).toBe(1);
    expect(String(calls[0][0])).toContain('2 machines');
    expect(String(calls[0][0])).toContain('cross-machine visibility is not yet implemented');

    // Second start call should NOT re-emit (one-time per instance)
    coord.start();
    const callsAfter = warnSpy.mock.calls.filter(
      (c) => String(c[0] ?? '').includes('[integrated-being]'),
    );
    expect(callsAfter.length).toBe(1);
    warnSpy.mockRestore();
    coord.stop();
  });
});
