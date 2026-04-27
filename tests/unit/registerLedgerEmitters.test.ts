/**
 * Unit tests for registerLedgerEmitters — the single wiring point that hooks
 * server-side subsystems into the Integrated-Being shared-state ledger.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SharedStateLedger } from '../../src/core/SharedStateLedger.js';
import { registerLedgerEmitters } from '../../src/core/registerLedgerEmitters.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rle-test-'));
}

describe('registerLedgerEmitters', () => {
  let dir: string;
  let ledger: SharedStateLedger;

  beforeEach(() => {
    DegradationReporter.resetForTesting();
    dir = tempDir();
    ledger = new SharedStateLedger({
      stateDir: dir,
      config: { enabled: true, classifierEnabled: false },
      salt: 'salt',
    });
  });

  afterEach(() => {
    ledger.shutdown();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('dispatch emitter appends a decision entry on successful execute', async () => {
    // Fake dispatch executor that just exposes the setter.
    const emitter = { sink: null as null | ((evt: any) => void) };
    const fakeExecutor = {
      setLedgerEventSink(s: any) { emitter.sink = s; },
    } as any;
    registerLedgerEmitters(ledger, {
      dispatchExecutor: fakeExecutor,
      config: { enabled: true, classifierEnabled: false },
    });
    expect(emitter.sink).not.toBeNull();
    await emitter.sink!({
      description: 'install plugin x',
      completedSteps: 2,
      totalSteps: 2,
      verified: true,
      timestamp: '2026-04-15T00:00:00Z',
    });
    const recent = await ledger.recent({ limit: 10 });
    expect(recent.length).toBe(1);
    expect(recent[0].kind).toBe('decision');
    expect(recent[0].counterparty.type).toBe('system');
    expect(recent[0].provenance).toBe('subsystem-asserted');
  });

  it('coherence gate emitter appends note with rule id ONLY (no context)', async () => {
    const emitter = { sink: null as null | ((evt: any) => void) };
    const fakeGate = {
      setLedgerEventSink(s: any) { emitter.sink = s; },
    } as any;
    registerLedgerEmitters(ledger, {
      coherenceGate: fakeGate,
      config: { enabled: true, classifierEnabled: false },
    });
    await emitter.sink!({
      ruleId: 'PEL_HARD_BLOCK',
      sessionId: 'sess-1',
      channel: 'telegram',
      timestamp: '2026-04-15T00:00:00Z',
    });
    const recent = await ledger.recent({ limit: 10 });
    expect(recent.length).toBe(1);
    expect(recent[0].kind).toBe('note');
    expect(recent[0].subject).toContain('PEL_HARD_BLOCK');
    // No rule context should leak — subject must not contain the message body.
    expect(recent[0].subject.length).toBeLessThanOrEqual(200);
    expect(recent[0].summary).toBeUndefined();
  });

  it('threadline sink installs when constructor-time onLedgerEvent is null', async () => {
    const tr: any = { onLedgerEvent: null };
    registerLedgerEmitters(ledger, {
      threadlineRouter: tr,
      config: { enabled: true, classifierEnabled: false },
    });
    expect(typeof tr.onLedgerEvent).toBe('function');
    await tr.onLedgerEvent({
      kind: 'thread-opened',
      threadId: 'th-1',
      remoteAgent: 'sagemind',
      subject: 'hello',
      timestamp: '2026-04-15T00:00:00Z',
    });
    const recent = await ledger.recent({ limit: 10 });
    expect(recent.length).toBe(1);
    expect(recent[0].kind).toBe('thread-opened');
    expect(recent[0].counterparty.type).toBe('agent');
  });

  it('classifier is NOT installed when classifierEnabled=false (default)', () => {
    // No-op: confirm no side effects when deps.config.classifierEnabled is off.
    // We simply run registration with no subsystems and no classifier flag.
    expect(() => registerLedgerEmitters(ledger, {
      config: { enabled: true, classifierEnabled: false },
    })).not.toThrow();
  });

  it('dedup prevents duplicate emits for the same threadId', async () => {
    const tr: any = { onLedgerEvent: null };
    registerLedgerEmitters(ledger, {
      threadlineRouter: tr,
      config: { enabled: true, classifierEnabled: false },
    });
    await tr.onLedgerEvent({
      kind: 'thread-opened',
      threadId: 'th-dupe',
      remoteAgent: 'sagemind',
      subject: 'hi',
      timestamp: '2026-04-15T00:00:00Z',
    });
    await tr.onLedgerEvent({
      kind: 'thread-opened',
      threadId: 'th-dupe',
      remoteAgent: 'sagemind',
      subject: 'hi again',
      timestamp: '2026-04-15T00:00:01Z',
    });
    const recent = await ledger.recent({ limit: 10 });
    expect(recent.length).toBe(1);
  });
});
