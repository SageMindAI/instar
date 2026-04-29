/**
 * HeartbeatWatchdog unit tests.
 *
 * Covers Component B watchdog signal-producer invariants:
 *  - heartbeat-missing fires only after the first-heartbeat grace window
 *  - heartbeat-verified fires when HMAC checks AND eventId matches AND pid alive
 *  - heartbeat-forged fires for bad HMAC and for eventId mismatch
 *  - heartbeat-stale fires when heartbeat ts is older than 2× refresh
 *  - heartbeat-pid-dead fires when sessionPid is not running
 *  - verified-once: repeat ticks on a verified row do NOT re-emit
 *  - terminal-once: a row that emitted a failure signal is not re-evaluated
 *  - tick must never throw
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SpawnLedger } from '../../../src/threadline/SpawnLedger';
import {
  HeartbeatWatchdog,
  type HeartbeatSignal,
} from '../../../src/threadline/HeartbeatWatchdog';
import { HeartbeatWriter } from '../../../src/threadline/HeartbeatWriter';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

let tmpDir: string;
let sessionsDir: string;
let ledger: SpawnLedger;
let signals: HeartbeatSignal[];
let nowFn: () => number;
let now: number;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-watchdog-test-'));
  sessionsDir = path.join(tmpDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  ledger = new SpawnLedger(path.join(tmpDir, 'ledger.db'));
  signals = [];
  now = 1_000_000;
  nowFn = () => now;
});

afterEach(() => {
  ledger.close();
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/threadline/HeartbeatWatchdog.test.ts' });
});

function makeWatchdog(opts: Partial<{ checkPidLiveness: boolean }> = {}): HeartbeatWatchdog {
  return new HeartbeatWatchdog({
    sessionsDir,
    ledger,
    consumer: (s) => signals.push(s),
    now: nowFn,
    checkPidLiveness: opts.checkPidLiveness ?? false,
  });
}

describe('HeartbeatWatchdog.tick', () => {
  it('does not signal heartbeat-missing within grace window', () => {
    const r = ledger.tryReserve('e', 'p', now);
    if (!r.reserved) throw new Error('unreachable');
    now += 4_000; // < 5s default grace
    const w = makeWatchdog();
    w.tick();
    expect(signals).toEqual([]);
  });

  it('signals heartbeat-missing after grace window with no .alive file', () => {
    const r = ledger.tryReserve('e', 'p', now);
    if (!r.reserved) throw new Error('unreachable');
    now += 6_000;
    const w = makeWatchdog();
    w.tick();
    expect(signals.length).toBe(1);
    expect(signals[0].kind).toBe('heartbeat-missing');
    expect(signals[0].eventId).toBe('e');
  });

  it('signals heartbeat-verified for a fresh, well-signed heartbeat', () => {
    const r = ledger.tryReserve('e', 'p', now);
    if (!r.reserved) throw new Error('unreachable');
    new HeartbeatWriter({
      sessionsDir,
      spawnNonce: r.spawnNonce,
      eventId: 'e',
      threadId: 'thr',
      sessionPid: process.pid,
    }).write(now);
    const w = makeWatchdog();
    w.tick();
    expect(signals.map((s) => s.kind)).toEqual(['heartbeat-verified']);
    expect(signals[0].threadId).toBe('thr');
  });

  it('signals heartbeat-forged for a wrong-nonce heartbeat', () => {
    ledger.tryReserve('e', 'p', now);
    new HeartbeatWriter({
      sessionsDir,
      spawnNonce: Buffer.alloc(32, 0xff),
      eventId: 'e',
      threadId: 'thr',
      sessionPid: process.pid,
    }).write(now);
    now += 6_000; // past grace so the row is in scope
    const w = makeWatchdog();
    w.tick();
    expect(signals.map((s) => s.kind)).toEqual(['heartbeat-forged']);
  });

  it('signals heartbeat-stale when heartbeat ts is older than 2× refresh', () => {
    const r = ledger.tryReserve('e', 'p', now);
    if (!r.reserved) throw new Error('unreachable');
    new HeartbeatWriter({
      sessionsDir,
      spawnNonce: r.spawnNonce,
      eventId: 'e',
      threadId: 'thr',
      sessionPid: process.pid,
    }).write(now);
    now += 25_000; // > 2 × 10s
    const w = makeWatchdog();
    w.tick();
    expect(signals.map((s) => s.kind)).toEqual(['heartbeat-stale']);
  });

  it('signals heartbeat-pid-dead when checkPidLiveness=true and pid is gone', () => {
    const r = ledger.tryReserve('e', 'p', now);
    if (!r.reserved) throw new Error('unreachable');
    new HeartbeatWriter({
      sessionsDir,
      spawnNonce: r.spawnNonce,
      eventId: 'e',
      threadId: 'thr',
      sessionPid: 999_999_999, // implausible pid
    }).write(now);
    const w = makeWatchdog({ checkPidLiveness: true });
    w.tick();
    expect(signals.map((s) => s.kind)).toEqual(['heartbeat-pid-dead']);
  });

  it('does not re-emit heartbeat-verified on subsequent ticks', () => {
    const r = ledger.tryReserve('e', 'p', now);
    if (!r.reserved) throw new Error('unreachable');
    new HeartbeatWriter({
      sessionsDir,
      spawnNonce: r.spawnNonce,
      eventId: 'e',
      threadId: 'thr',
      sessionPid: process.pid,
    }).write(now);
    const w = makeWatchdog();
    w.tick();
    w.tick();
    w.tick();
    expect(signals.length).toBe(1);
  });

  it('does not re-emit a terminal failure signal', () => {
    ledger.tryReserve('e', 'p', now);
    now += 6_000;
    const w = makeWatchdog();
    w.tick();
    w.tick();
    expect(signals.length).toBe(1);
    expect(signals[0].kind).toBe('heartbeat-missing');
  });

  it('tick never throws even on malformed .alive files', () => {
    ledger.tryReserve('e', 'p', now);
    fs.writeFileSync(path.join(sessionsDir, 'thr.alive'), 'not json');
    const w = makeWatchdog();
    now += 6_000;
    expect(() => w.tick()).not.toThrow();
  });
});
