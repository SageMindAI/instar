/**
 * RelaySpawnFailureHandler unit tests.
 *
 * Covers Component B authority-side invariants:
 *  - heartbeat-verified marks ledger 'verified' AND emits thread-opened
 *  - any failure-class signal marks ledger 'failed' AND quarantines envelope
 *  - thread-opened is NEVER emitted on failure (the original ghost-reply bug)
 *  - quarantine is called exactly once per terminal signal
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SpawnLedger } from '../../../src/threadline/SpawnLedger';
import { RelaySpawnFailureHandler } from '../../../src/threadline/RelaySpawnFailureHandler';
import type { HeartbeatSignal } from '../../../src/threadline/HeartbeatWatchdog';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

let tmpDir: string;
let ledger: SpawnLedger;
let quarantine: ReturnType<typeof vi.fn>;
let emitOpened: ReturnType<typeof vi.fn>;
let handler: RelaySpawnFailureHandler;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsfh-test-'));
  ledger = new SpawnLedger(path.join(tmpDir, 'ledger.db'));
  quarantine = vi.fn();
  emitOpened = vi.fn();
  handler = new RelaySpawnFailureHandler({
    ledger,
    quarantineToInbox: quarantine,
    emitThreadOpened: emitOpened,
  });
});

afterEach(() => {
  ledger.close();
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/threadline/RelaySpawnFailureHandler.test.ts' });
});

function sig(kind: HeartbeatSignal['kind'], eventId = 'e', threadId = 't'): HeartbeatSignal {
  return { kind, eventId, threadId, raisedAt: Date.now(), detail: 'test' };
}

describe('RelaySpawnFailureHandler.handle — verified', () => {
  it('marks the ledger verified and emits thread-opened', () => {
    ledger.tryReserve('e', 'p');
    const out = handler.handle(sig('heartbeat-verified'));
    expect(out.kind).toBe('verified');
    expect(ledger.get('e')?.status).toBe('verified');
    expect(emitOpened).toHaveBeenCalledWith('e', 't');
    expect(quarantine).not.toHaveBeenCalled();
  });

  it('does not double-emit thread-opened on repeat verified signals', () => {
    ledger.tryReserve('e', 'p');
    handler.handle(sig('heartbeat-verified'));
    handler.handle(sig('heartbeat-verified'));
    expect(emitOpened).toHaveBeenCalledTimes(1);
  });
});

describe('RelaySpawnFailureHandler.handle — failure classes', () => {
  for (const kind of [
    'heartbeat-missing',
    'heartbeat-forged',
    'heartbeat-stale',
    'heartbeat-pid-dead',
  ] as const) {
    it(`${kind}: marks failed, quarantines envelope, never emits thread-opened`, () => {
      ledger.tryReserve('e', 'p');
      const out = handler.handle(sig(kind));
      expect(out.kind).toBe('failed-quarantined');
      expect(out.failureReason).toBe(kind);
      expect(ledger.get('e')?.status).toBe('failed');
      expect(ledger.get('e')?.failureReason).toBe(kind);
      expect(quarantine).toHaveBeenCalledTimes(1);
      expect(emitOpened).not.toHaveBeenCalled();
    });
  }

  it('does not re-quarantine on a second signal for the same failed eventId', () => {
    ledger.tryReserve('e', 'p');
    handler.handle(sig('heartbeat-missing'));
    handler.handle(sig('heartbeat-missing'));
    expect(quarantine).toHaveBeenCalledTimes(1);
  });
});
