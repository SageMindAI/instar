/**
 * Module-level reproduction of the original ghost-reply incident the
 * spawn-guard infrastructure exists to prevent.
 *
 * Original incident shape (per RELAY-SPAWN-GHOST-REPLY-CONTAINMENT-SPEC):
 *  1. Inbound relay envelope arrives.
 *  2. Receiver "spawns" a session for it.
 *  3. The spawned session never actually came up — but a `thread-opened`
 *     ledger event fired anyway, and a synthesized reply was emitted.
 *  4. Sender saw a reply that no real session generated.
 *
 * This test wires the three Phase-1 foundation modules (SpawnLedger,
 * HeartbeatWatchdog, RelaySpawnFailureHandler) and asserts the
 * structural guarantees the spec promises:
 *  - Same envelope → exactly one ledger reservation.
 *  - Reserved-but-no-heartbeat → quarantine fires.
 *  - Quarantine fires → `thread-opened` is NEVER emitted.
 *  - A reserved-AND-heartbeat-verified row → `thread-opened` IS emitted, exactly once.
 *
 * If this test ever fails, the original incident has regressed at the
 * module layer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SpawnLedger } from '../../../src/threadline/SpawnLedger';
import { HeartbeatWatchdog } from '../../../src/threadline/HeartbeatWatchdog';
import { HeartbeatWriter } from '../../../src/threadline/HeartbeatWriter';
import { RelaySpawnFailureHandler } from '../../../src/threadline/RelaySpawnFailureHandler';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

let tmpDir: string;
let sessionsDir: string;
let ledger: SpawnLedger;
let quarantine: ReturnType<typeof vi.fn>;
let emitOpened: ReturnType<typeof vi.fn>;
let handler: RelaySpawnFailureHandler;
let now: number;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-incident-'));
  sessionsDir = path.join(tmpDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  ledger = new SpawnLedger(path.join(tmpDir, 'ledger.db'));
  quarantine = vi.fn();
  emitOpened = vi.fn();
  handler = new RelaySpawnFailureHandler({
    ledger,
    quarantineToInbox: quarantine,
    emitThreadOpened: emitOpened,
  });
  now = 1_000_000;
});

afterEach(() => {
  ledger.close();
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/threadline/spawn-guard-incident-repro.test.ts' });
});

function watchdog(checkPid = false): HeartbeatWatchdog {
  return new HeartbeatWatchdog({
    sessionsDir,
    ledger,
    consumer: (s) => handler.handle(s),
    now: () => now,
    checkPidLiveness: checkPid,
  });
}

describe('spawn-guard incident reproduction', () => {
  it('ghost session (reserved, no heartbeat): quarantines and never opens thread', () => {
    // Step 1: inbound envelope arrives, ledger reserves the spawn.
    const r = ledger.tryReserve('evt-incident', 'peer-A', now);
    expect(r.reserved).toBe(true);

    // Step 2: the "spawned session" never writes a heartbeat. Time passes
    // beyond the first-heartbeat grace window.
    now += 6_000;

    // Step 3: watchdog ticks. It should detect the missing heartbeat and
    // route through the failure handler.
    watchdog().tick();

    // Assertions: the original incident's two symptoms must NOT recur.
    expect(emitOpened).not.toHaveBeenCalled();
    expect(quarantine).toHaveBeenCalledTimes(1);
    expect(quarantine).toHaveBeenCalledWith(
      'evt-incident',
      'heartbeat-missing',
      expect.any(String),
    );
    // Ledger row reflects the failure for the audit trail.
    expect(ledger.get('evt-incident')?.status).toBe('failed');
    expect(ledger.get('evt-incident')?.failureReason).toBe('heartbeat-missing');
  });

  it('healthy session (reserved + verified heartbeat): opens thread exactly once', () => {
    const r = ledger.tryReserve('evt-good', 'peer-A', now);
    expect(r.reserved).toBe(true);

    new HeartbeatWriter({
      sessionsDir,
      spawnNonce: r.reserved ? r.spawnNonce : Buffer.alloc(32),
      eventId: 'evt-good',
      threadId: 'thr-good',
      sessionPid: process.pid,
    }).write(now);

    const w = watchdog();
    w.tick();
    w.tick();
    w.tick();

    expect(emitOpened).toHaveBeenCalledTimes(1);
    expect(emitOpened).toHaveBeenCalledWith('evt-good', 'thr-good');
    expect(quarantine).not.toHaveBeenCalled();
    expect(ledger.get('evt-good')?.status).toBe('verified');
  });

  it('forged heartbeat (wrong nonce): quarantines as forged, never opens thread', () => {
    ledger.tryReserve('evt-forged', 'peer-A', now);

    new HeartbeatWriter({
      sessionsDir,
      spawnNonce: Buffer.alloc(32, 0xff), // attacker nonce
      eventId: 'evt-forged',
      threadId: 'thr-forged',
      sessionPid: process.pid,
    }).write(now);

    now += 6_000;
    watchdog().tick();

    expect(emitOpened).not.toHaveBeenCalled();
    expect(quarantine).toHaveBeenCalledWith(
      'evt-forged',
      'heartbeat-forged',
      expect.any(String),
    );
  });

  it('replay attack: same eventId twice → second reservation rejected', () => {
    const first = ledger.tryReserve('evt-replay', 'peer-A', now);
    const second = ledger.tryReserve('evt-replay', 'peer-A', now);
    expect(first.reserved).toBe(true);
    expect(second.reserved).toBe(false);
    if (second.reserved) throw new Error('unreachable');
    expect(second.reason).toBe('duplicate-event');
  });
});
