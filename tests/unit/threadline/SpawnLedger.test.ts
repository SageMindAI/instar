/**
 * SpawnLedger unit tests.
 *
 * Covers the Component A invariants from
 * docs/specs/RELAY-SPAWN-GHOST-REPLY-CONTAINMENT-SPEC.md:
 *  - Atomic CAS prevents double-spawn for same eventId
 *  - Per-peer rolling rate cap engages
 *  - Global hard cap is enforced
 *  - HMAC verification with constant-time compare
 *  - Stale-spawning sweep finds rows whose heartbeat never confirmed
 *  - Pruning leaves in-flight rows alone
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SpawnLedger } from '../../../src/threadline/SpawnLedger';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

let tmpDir: string;
let ledger: SpawnLedger;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-ledger-test-'));
  ledger = new SpawnLedger(path.join(tmpDir, 'spawn-ledger.db'));
});

afterEach(() => {
  ledger.close();
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/threadline/SpawnLedger.test.ts' });
});

describe('SpawnLedger.tryReserve', () => {
  it('reserves a fresh eventId and returns a 32-byte nonce', () => {
    const out = ledger.tryReserve('evt-1', 'peer-A');
    expect(out.reserved).toBe(true);
    if (!out.reserved) throw new Error('unreachable');
    expect(out.spawnNonce.length).toBe(32);
    expect(out.row.status).toBe('spawning');
    expect(out.row.peerId).toBe('peer-A');
  });

  it('rejects a duplicate eventId with reason "duplicate-event"', () => {
    ledger.tryReserve('evt-1', 'peer-A');
    const out = ledger.tryReserve('evt-1', 'peer-A');
    expect(out.reserved).toBe(false);
    if (out.reserved) throw new Error('unreachable');
    expect(out.reason).toBe('duplicate-event');
    expect(out.existing?.eventId).toBe('evt-1');
  });

  it('returns the existing row on duplicate, even from a different peerId', () => {
    // Ledger is keyed on eventId — peer cannot circumvent by claiming a
    // different identity. The existing row reveals the original peer.
    ledger.tryReserve('evt-1', 'peer-A');
    const out = ledger.tryReserve('evt-1', 'peer-B');
    expect(out.reserved).toBe(false);
    if (out.reserved) throw new Error('unreachable');
    expect(out.existing?.peerId).toBe('peer-A');
  });

  it('engages per-peer rate cap at the configured threshold', () => {
    ledger.close();
    ledger = new SpawnLedger(path.join(tmpDir, 'spawn-ledger.db'), { perPeerCap: 3 });
    expect(ledger.tryReserve('e1', 'peer-X').reserved).toBe(true);
    expect(ledger.tryReserve('e2', 'peer-X').reserved).toBe(true);
    expect(ledger.tryReserve('e3', 'peer-X').reserved).toBe(true);
    const fourth = ledger.tryReserve('e4', 'peer-X');
    expect(fourth.reserved).toBe(false);
    if (fourth.reserved) throw new Error('unreachable');
    expect(fourth.reason).toBe('peer-rate-limit');
    // Other peer is unaffected.
    expect(ledger.tryReserve('e5', 'peer-Y').reserved).toBe(true);
  });

  it('engages global cap when total rows reach configured ceiling', () => {
    ledger.close();
    ledger = new SpawnLedger(path.join(tmpDir, 'spawn-ledger.db'), { globalCap: 2 });
    expect(ledger.tryReserve('a', 'p1').reserved).toBe(true);
    expect(ledger.tryReserve('b', 'p2').reserved).toBe(true);
    const third = ledger.tryReserve('c', 'p3');
    expect(third.reserved).toBe(false);
    if (third.reserved) throw new Error('unreachable');
    expect(third.reason).toBe('ledger-full');
  });

  it('throws on missing eventId or peerId', () => {
    expect(() => ledger.tryReserve('', 'peer-A')).toThrow();
    expect(() => ledger.tryReserve('e', '')).toThrow();
  });
});

describe('SpawnLedger.markStatus', () => {
  it('transitions spawning → verified', () => {
    ledger.tryReserve('e', 'p');
    expect(ledger.markStatus('e', 'verified')).toBe(true);
    expect(ledger.get('e')?.status).toBe('verified');
    expect(ledger.get('e')?.terminalAt).not.toBeNull();
  });

  it('records failureReason on failed transition', () => {
    ledger.tryReserve('e', 'p');
    ledger.markStatus('e', 'failed', 'heartbeat-missing');
    expect(ledger.get('e')?.status).toBe('failed');
    expect(ledger.get('e')?.failureReason).toBe('heartbeat-missing');
  });

  it('returns false when status would not change (idempotent)', () => {
    ledger.tryReserve('e', 'p');
    ledger.markStatus('e', 'verified');
    expect(ledger.markStatus('e', 'verified')).toBe(false);
  });
});

describe('SpawnLedger.verifyHeartbeatHmac', () => {
  it('verifies a correctly-signed payload', () => {
    const out = ledger.tryReserve('e', 'p');
    if (!out.reserved) throw new Error('unreachable');
    const payload = 'evt:e:pid:1234:ts:99';
    const hmac = crypto.createHmac('sha256', out.spawnNonce).update(payload).digest('hex');
    expect(ledger.verifyHeartbeatHmac('e', payload, hmac)).toBe(true);
  });

  it('rejects a mismatched HMAC', () => {
    const out = ledger.tryReserve('e', 'p');
    if (!out.reserved) throw new Error('unreachable');
    const wrong = crypto.createHmac('sha256', Buffer.alloc(32, 0xff)).update('x').digest('hex');
    expect(ledger.verifyHeartbeatHmac('e', 'x', wrong)).toBe(false);
  });

  it('rejects when eventId is unknown', () => {
    expect(ledger.verifyHeartbeatHmac('nonexistent', 'p', 'a'.repeat(64))).toBe(false);
  });

  it('rejects when HMAC length differs (constant-time guard)', () => {
    ledger.tryReserve('e', 'p');
    expect(ledger.verifyHeartbeatHmac('e', 'p', 'aa')).toBe(false);
  });
});

describe('SpawnLedger.pruneTerminal and sweepStaleSpawning', () => {
  it('prune removes terminal rows older than cutoff, never spawning rows', () => {
    const past = Date.now() - 60_000;
    // Spawning row from way in the past — must NOT be pruned.
    ledger.tryReserve('still-flying', 'p', past);
    // Failed row from way in the past — should be pruned.
    ledger.tryReserve('long-dead', 'p', past);
    ledger.markStatus('long-dead', 'failed', 'h-missing', past + 1);

    const removed = ledger.pruneTerminal(30_000); // older than 30s
    expect(removed).toBe(1);
    expect(ledger.get('still-flying')).not.toBeNull();
    expect(ledger.get('long-dead')).toBeNull();
  });

  it('sweep finds spawning rows past the staleness window', () => {
    const past = Date.now() - 60_000;
    ledger.tryReserve('zombie', 'p', past);
    const stale = ledger.sweepStaleSpawning(30_000);
    expect(stale.map((r) => r.eventId)).toEqual(['zombie']);
  });
});
