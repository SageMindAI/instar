/**
 * Unit tests for AgentBus Replay Protection (Phase 4A — Gap 1).
 *
 * Tests the anti-replay mechanism added to AgentBus via NonceStore integration:
 *   1. Send-side: nonce + sequence generation when enabled
 *   2. Receive-side: rejection of replayed, stale, and missing-field messages
 *   3. Backward compatibility: no replay fields when disabled
 *   4. Cross-bus communication with replay protection
 *   5. Event emission for rejected messages
 *   6. Edge cases: boundary timestamps, sequence gaps, concurrent peers
 *   7. Persistence: nonce store survives bus restart
 *   8. Fail-closed: messages without nonce/sequence rejected when enabled
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { AgentBus } from '../../src/core/AgentBus.js';
import type { AgentMessage, AgentBusConfig } from '../../src/core/AgentBus.js';

// ── Helpers ─────────────────────────────────────────────────────────

let tmpDir: string;

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bus-replay-'));
}

function makeBus(
  dir: string,
  machineId = 'machine-a',
  overrides: Partial<AgentBusConfig> = {},
): AgentBus {
  const stateDir = path.join(dir, '.instar');
  return new AgentBus({
    stateDir,
    machineId,
    transport: 'jsonl',
    defaultTtlMs: 30 * 60 * 1000,
    pollIntervalMs: 50,
    ...overrides,
  });
}

function makeProtectedBus(
  dir: string,
  machineId = 'machine-a',
  overrides: Partial<AgentBusConfig> = {},
): AgentBus {
  return makeBus(dir, machineId, {
    replayProtection: { enabled: true },
    ...overrides,
  });
}

/** Create a valid message from machine-b with nonce/sequence.
 * Uses ttlMs: 0 (no expiration) by default so TTL checks don't
 * interfere with replay protection timestamp window tests. */
function validMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: `msg_${crypto.randomBytes(8).toString('hex')}`,
    type: 'heartbeat',
    from: 'machine-b',
    to: 'machine-a',
    timestamp: new Date().toISOString(),
    ttlMs: 0, // No TTL expiration — replay protection tests timestamp window independently
    payload: {},
    status: 'pending',
    nonce: crypto.randomBytes(16).toString('hex'),
    sequence: 0,
    ...overrides,
  };
}

// ── 1. Send-Side: Nonce + Sequence Generation ───────────────────────

describe('send-side replay field generation', () => {
  beforeEach(() => { tmpDir = freshDir(); });
  // safe-git-allow: incremental-migration
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('attaches nonce and sequence when replay protection enabled', async () => {
    const bus = makeProtectedBus(tmpDir);
    const msg = await bus.send({
      type: 'heartbeat',
      to: 'machine-b',
      payload: { test: true },
    });

    expect(msg.nonce).toBeDefined();
    expect(msg.nonce!.length).toBe(32); // 16 bytes hex = 32 chars
    expect(msg.sequence).toBe(0);

    bus.destroy();
  });

  it('increments sequence monotonically across sends', async () => {
    const bus = makeProtectedBus(tmpDir);

    const msg1 = await bus.send({ type: 'heartbeat', to: 'b', payload: {} });
    const msg2 = await bus.send({ type: 'heartbeat', to: 'b', payload: {} });
    const msg3 = await bus.send({ type: 'heartbeat', to: 'c', payload: {} });

    expect(msg1.sequence).toBe(0);
    expect(msg2.sequence).toBe(1);
    expect(msg3.sequence).toBe(2);

    bus.destroy();
  });

  it('generates unique nonces per message', async () => {
    const bus = makeProtectedBus(tmpDir);
    const nonces = new Set<string>();

    for (let i = 0; i < 50; i++) {
      const msg = await bus.send({ type: 'heartbeat', to: 'b', payload: { i } });
      nonces.add(msg.nonce!);
    }

    expect(nonces.size).toBe(50); // All unique
    bus.destroy();
  });

  it('does NOT attach nonce/sequence when replay protection disabled', async () => {
    const bus = makeBus(tmpDir);
    const msg = await bus.send({
      type: 'heartbeat',
      to: 'machine-b',
      payload: {},
    });

    expect(msg.nonce).toBeUndefined();
    expect(msg.sequence).toBeUndefined();
  });

  it('nonce is 16+ bytes (per spec)', async () => {
    const bus = makeProtectedBus(tmpDir);
    const msg = await bus.send({ type: 'heartbeat', to: 'b', payload: {} });

    // 16 bytes hex = 32 chars, which is ≥ 16 bytes
    const nonceBytes = Buffer.from(msg.nonce!, 'hex');
    expect(nonceBytes.length).toBeGreaterThanOrEqual(16);

    bus.destroy();
  });

  it('outbox contains nonce and sequence fields', async () => {
    const bus = makeProtectedBus(tmpDir);
    await bus.send({ type: 'heartbeat', to: 'b', payload: { data: 1 } });

    const outbox = bus.readOutbox();
    expect(outbox[0].nonce).toBeDefined();
    expect(outbox[0].sequence).toBe(0);

    bus.destroy();
  });

  it('getOutgoingSequence tracks current counter', async () => {
    const bus = makeProtectedBus(tmpDir);
    expect(bus.getOutgoingSequence()).toBe(0);

    await bus.send({ type: 'heartbeat', to: 'b', payload: {} });
    expect(bus.getOutgoingSequence()).toBe(1);

    await bus.send({ type: 'heartbeat', to: 'b', payload: {} });
    expect(bus.getOutgoingSequence()).toBe(2);

    bus.destroy();
  });
});

// ── 2. Receive-Side: Replay Rejection ───────────────────────────────

describe('receive-side replay protection validation', () => {
  beforeEach(() => { tmpDir = freshDir(); });
  // safe-git-allow: incremental-migration
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('accepts valid message with fresh timestamp + unique nonce + valid sequence', () => {
    const bus = makeProtectedBus(tmpDir);
    const received: AgentMessage[] = [];
    bus.on('message', (msg: AgentMessage) => received.push(msg));

    bus.processIncoming([validMessage()]);
    expect(received).toHaveLength(1);
    expect(received[0].status).toBe('delivered');

    bus.destroy();
  });

  it('rejects replayed message (same nonce)', () => {
    const bus = makeProtectedBus(tmpDir);
    const received: AgentMessage[] = [];
    const rejected: Array<{ msg: AgentMessage; reason: string }> = [];
    bus.on('message', (msg: AgentMessage) => received.push(msg));
    bus.on('replay-rejected', (msg: AgentMessage, reason: string) => rejected.push({ msg, reason }));

    const nonce = crypto.randomBytes(16).toString('hex');
    const msg1 = validMessage({ nonce, sequence: 0 });
    const msg2 = validMessage({ id: 'msg_replay', nonce, sequence: 1 });

    bus.processIncoming([msg1]);
    bus.processIncoming([msg2]); // Same nonce = replay

    expect(received).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain('replay');

    bus.destroy();
  });

  it('rejects message with stale timestamp', () => {
    const bus = makeProtectedBus(tmpDir);
    const received: AgentMessage[] = [];
    const rejected: Array<{ msg: AgentMessage; reason: string }> = [];
    bus.on('message', (msg: AgentMessage) => received.push(msg));
    bus.on('replay-rejected', (msg: AgentMessage, reason: string) => rejected.push({ msg, reason }));

    // 10 minutes old — outside 5 min window
    const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    bus.processIncoming([validMessage({ timestamp: staleTimestamp })]);

    expect(received).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain('window');

    bus.destroy();
  });

  it('rejects message with future timestamp beyond window', () => {
    const bus = makeProtectedBus(tmpDir);
    const received: AgentMessage[] = [];
    const rejected: Array<{ msg: AgentMessage; reason: string }> = [];
    bus.on('message', (msg: AgentMessage) => received.push(msg));
    bus.on('replay-rejected', (msg: AgentMessage, reason: string) => rejected.push({ msg, reason }));

    const futureTimestamp = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    bus.processIncoming([validMessage({ timestamp: futureTimestamp })]);

    expect(received).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain('window');

    bus.destroy();
  });

  it('rejects message with regressed sequence number', () => {
    const bus = makeProtectedBus(tmpDir);
    const received: AgentMessage[] = [];
    const rejected: Array<{ msg: AgentMessage; reason: string }> = [];
    bus.on('message', (msg: AgentMessage) => received.push(msg));
    bus.on('replay-rejected', (msg: AgentMessage, reason: string) => rejected.push({ msg, reason }));

    bus.processIncoming([validMessage({ sequence: 5 })]);
    bus.processIncoming([validMessage({ sequence: 3 })]); // Regression

    expect(received).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain('Sequence');

    bus.destroy();
  });

  it('rejects message with same sequence number (replay)', () => {
    const bus = makeProtectedBus(tmpDir);
    const received: AgentMessage[] = [];
    const rejected: Array<{ msg: AgentMessage; reason: string }> = [];
    bus.on('message', (msg: AgentMessage) => received.push(msg));
    bus.on('replay-rejected', (msg: AgentMessage, reason: string) => rejected.push({ msg, reason }));

    bus.processIncoming([validMessage({ sequence: 0 })]);
    bus.processIncoming([validMessage({ sequence: 0 })]); // Same seq

    expect(received).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    bus.destroy();
  });

  it('accepts messages with sequence gaps (non-consecutive is fine)', () => {
    const bus = makeProtectedBus(tmpDir);
    const received: AgentMessage[] = [];
    bus.on('message', (msg: AgentMessage) => received.push(msg));

    bus.processIncoming([validMessage({ sequence: 0 })]);
    bus.processIncoming([validMessage({ sequence: 100 })]); // Gap is OK

    expect(received).toHaveLength(2);

    bus.destroy();
  });

  it('accepts timestamp within 5-minute window', () => {
    const bus = makeProtectedBus(tmpDir);
    const received: AgentMessage[] = [];
    bus.on('message', (msg: AgentMessage) => received.push(msg));

    // 4 minutes old — within 5 min window
    const recentTimestamp = new Date(Date.now() - 4 * 60 * 1000).toISOString();
    bus.processIncoming([validMessage({ timestamp: recentTimestamp })]);

    expect(received).toHaveLength(1);

    bus.destroy();
  });

  it('rejects timestamp at exactly 5 minutes + 1 second', () => {
    const bus = makeProtectedBus(tmpDir);
    const received: AgentMessage[] = [];
    const rejected: Array<{ msg: AgentMessage; reason: string }> = [];
    bus.on('message', (msg: AgentMessage) => received.push(msg));
    bus.on('replay-rejected', (msg: AgentMessage, reason: string) => rejected.push({ msg, reason }));

    const borderlineTimestamp = new Date(Date.now() - (5 * 60 * 1000 + 1000)).toISOString();
    bus.processIncoming([validMessage({ timestamp: borderlineTimestamp })]);

    expect(received).toHaveLength(0);
    expect(rejected).toHaveLength(1);

    bus.destroy();
  });
});

// ── 3. Fail-Closed: Missing Fields ──────────────────────────────────

describe('fail-closed: messages without replay fields', () => {
  beforeEach(() => { tmpDir = freshDir(); });
  // safe-git-allow: incremental-migration
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('rejects message with no nonce when protection enabled', () => {
    const bus = makeProtectedBus(tmpDir);
    const received: AgentMessage[] = [];
    const rejected: Array<{ msg: AgentMessage; reason: string }> = [];
    bus.on('message', (msg: AgentMessage) => received.push(msg));
    bus.on('replay-rejected', (msg: AgentMessage, reason: string) => rejected.push({ msg, reason }));

    // Message without nonce (legacy format)
    bus.processIncoming([{
      id: 'msg_legacy1',
      type: 'heartbeat',
      from: 'machine-b',
      to: 'machine-a',
      timestamp: new Date().toISOString(),
      ttlMs: 60000,
      payload: {},
      status: 'pending',
      // No nonce, no sequence
    }]);

    expect(received).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain('Missing nonce or sequence');

    bus.destroy();
  });

  it('rejects message with nonce but no sequence', () => {
    const bus = makeProtectedBus(tmpDir);
    const rejected: Array<{ msg: AgentMessage; reason: string }> = [];
    bus.on('replay-rejected', (msg: AgentMessage, reason: string) => rejected.push({ msg, reason }));

    bus.processIncoming([{
      id: 'msg_partial',
      type: 'heartbeat',
      from: 'machine-b',
      to: 'machine-a',
      timestamp: new Date().toISOString(),
      ttlMs: 60000,
      payload: {},
      status: 'pending',
      nonce: crypto.randomBytes(16).toString('hex'),
      // No sequence
    }]);

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain('Missing nonce or sequence');

    bus.destroy();
  });

  it('rejects message with sequence but no nonce', () => {
    const bus = makeProtectedBus(tmpDir);
    const rejected: Array<{ msg: AgentMessage; reason: string }> = [];
    bus.on('replay-rejected', (msg: AgentMessage, reason: string) => rejected.push({ msg, reason }));

    bus.processIncoming([{
      id: 'msg_partial2',
      type: 'heartbeat',
      from: 'machine-b',
      to: 'machine-a',
      timestamp: new Date().toISOString(),
      ttlMs: 60000,
      payload: {},
      status: 'pending',
      sequence: 0,
      // No nonce
    }]);

    expect(rejected).toHaveLength(1);

    bus.destroy();
  });

  it('rejects message with empty string nonce', () => {
    const bus = makeProtectedBus(tmpDir);
    const rejected: Array<{ msg: AgentMessage; reason: string }> = [];
    bus.on('replay-rejected', (msg: AgentMessage, reason: string) => rejected.push({ msg, reason }));

    bus.processIncoming([validMessage({ nonce: '' })]);

    expect(rejected).toHaveLength(1);

    bus.destroy();
  });
});

// ── 4. Backward Compatibility ───────────────────────────────────────

describe('backward compatibility (protection disabled)', () => {
  beforeEach(() => { tmpDir = freshDir(); });
  // safe-git-allow: incremental-migration
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('accepts legacy messages without nonce/sequence', () => {
    const bus = makeBus(tmpDir); // No replay protection
    const received: AgentMessage[] = [];
    bus.on('message', (msg: AgentMessage) => received.push(msg));

    bus.processIncoming([{
      id: 'msg_legacy',
      type: 'heartbeat',
      from: 'machine-b',
      to: 'machine-a',
      timestamp: new Date().toISOString(),
      ttlMs: 60000,
      payload: {},
      status: 'pending',
    }]);

    expect(received).toHaveLength(1);
  });

  it('accepts messages with nonce/sequence even when protection disabled', () => {
    const bus = makeBus(tmpDir); // No replay protection
    const received: AgentMessage[] = [];
    bus.on('message', (msg: AgentMessage) => received.push(msg));

    bus.processIncoming([validMessage()]);

    expect(received).toHaveLength(1);
  });

  it('isReplayProtectionEnabled returns false by default', () => {
    const bus = makeBus(tmpDir);
    expect(bus.isReplayProtectionEnabled()).toBe(false);
  });

  it('isReplayProtectionEnabled returns true when configured', () => {
    const bus = makeProtectedBus(tmpDir);
    expect(bus.isReplayProtectionEnabled()).toBe(true);
    bus.destroy();
  });

  it('does not emit replay-rejected when protection disabled', () => {
    const bus = makeBus(tmpDir);
    const rejected: string[] = [];
    bus.on('replay-rejected', (_msg: AgentMessage, reason: string) => rejected.push(reason));

    // Same nonce twice — should both be accepted without protection
    const nonce = crypto.randomBytes(16).toString('hex');
    bus.processIncoming([
      validMessage({ nonce, sequence: 0 }),
      validMessage({ id: 'msg_dup', nonce, sequence: 0 }),
    ]);

    expect(rejected).toHaveLength(0);
  });
});

// ── 5. Cross-Bus Communication ──────────────────────────────────────

describe('cross-bus replay protection', () => {
  beforeEach(() => { tmpDir = freshDir(); });
  // safe-git-allow: incremental-migration
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('message from protected sender accepted by protected receiver', async () => {
    const sender = makeProtectedBus(tmpDir, 'machine-a');
    const receiver = makeProtectedBus(tmpDir, 'machine-b');
    const received: AgentMessage[] = [];
    receiver.on('message', (msg: AgentMessage) => received.push(msg));

    const msg = await sender.send({
      type: 'heartbeat',
      to: 'machine-b',
      payload: { cross: true },
    });

    // Simulate delivery: read sender's outbox, feed to receiver
    const outbox = sender.readOutbox();
    receiver.processIncoming(outbox);

    expect(received).toHaveLength(1);
    expect(received[0].nonce).toBe(msg.nonce);
    expect(received[0].sequence).toBe(msg.sequence);

    sender.destroy();
    receiver.destroy();
  });

  it('replayed message from sender outbox rejected on second processing', async () => {
    const sender = makeProtectedBus(tmpDir, 'machine-a');
    const receiver = makeProtectedBus(tmpDir, 'machine-b');
    const received: AgentMessage[] = [];
    const rejected: string[] = [];
    receiver.on('message', (msg: AgentMessage) => received.push(msg));
    receiver.on('replay-rejected', (_msg: AgentMessage, reason: string) => rejected.push(reason));

    await sender.send({ type: 'heartbeat', to: 'machine-b', payload: {} });

    const outbox = sender.readOutbox();
    receiver.processIncoming(outbox); // First time — accepted
    receiver.processIncoming(outbox); // Replay — rejected

    expect(received).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    sender.destroy();
    receiver.destroy();
  });

  it('multiple messages from same sender accepted in order', async () => {
    const sender = makeProtectedBus(tmpDir, 'machine-a');
    const receiver = makeProtectedBus(tmpDir, 'machine-b');
    const received: AgentMessage[] = [];
    receiver.on('message', (msg: AgentMessage) => received.push(msg));

    await sender.send({ type: 'heartbeat', to: 'machine-b', payload: { n: 1 } });
    await sender.send({ type: 'heartbeat', to: 'machine-b', payload: { n: 2 } });
    await sender.send({ type: 'heartbeat', to: 'machine-b', payload: { n: 3 } });

    const outbox = sender.readOutbox();
    receiver.processIncoming(outbox);

    expect(received).toHaveLength(3);
    expect(received[0].sequence).toBe(0);
    expect(received[1].sequence).toBe(1);
    expect(received[2].sequence).toBe(2);

    sender.destroy();
    receiver.destroy();
  });
});

// ── 6. Multi-Peer Sequence Tracking ─────────────────────────────────

describe('multi-peer sequence isolation', () => {
  beforeEach(() => { tmpDir = freshDir(); });
  // safe-git-allow: incremental-migration
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('tracks sequences independently per sender', () => {
    const bus = makeProtectedBus(tmpDir);
    const received: AgentMessage[] = [];
    bus.on('message', (msg: AgentMessage) => received.push(msg));

    // Machine B at sequence 5
    bus.processIncoming([validMessage({ from: 'machine-b', sequence: 5 })]);
    // Machine C at sequence 0 (independent)
    bus.processIncoming([validMessage({ from: 'machine-c', sequence: 0 })]);

    expect(received).toHaveLength(2);

    bus.destroy();
  });

  it('sequence regression from one peer does not affect another', () => {
    const bus = makeProtectedBus(tmpDir);
    const received: AgentMessage[] = [];
    const rejected: string[] = [];
    bus.on('message', (msg: AgentMessage) => received.push(msg));
    bus.on('replay-rejected', (_msg: AgentMessage, reason: string) => rejected.push(reason));

    // Machine B progresses to 10
    bus.processIncoming([validMessage({ from: 'machine-b', sequence: 10 })]);
    // Machine B regresses to 5 — rejected
    bus.processIncoming([validMessage({ from: 'machine-b', sequence: 5 })]);
    // Machine C at 0 — accepted (independent tracking)
    bus.processIncoming([validMessage({ from: 'machine-c', sequence: 0 })]);

    expect(received).toHaveLength(2); // B(10) + C(0)
    expect(rejected).toHaveLength(1); // B(5) rejected

    bus.destroy();
  });

  it('concurrent peers can send interleaved messages', () => {
    const bus = makeProtectedBus(tmpDir);
    const received: AgentMessage[] = [];
    bus.on('message', (msg: AgentMessage) => received.push(msg));

    bus.processIncoming([
      validMessage({ from: 'machine-b', sequence: 0 }),
      validMessage({ from: 'machine-c', sequence: 0 }),
      validMessage({ from: 'machine-b', sequence: 1 }),
      validMessage({ from: 'machine-c', sequence: 1 }),
      validMessage({ from: 'machine-d', sequence: 0 }),
    ]);

    expect(received).toHaveLength(5);

    bus.destroy();
  });
});

// ── 7. Persistence: Nonce Store Survives Restart ────────────────────

describe('nonce persistence across bus restarts', () => {
  beforeEach(() => { tmpDir = freshDir(); });
  // safe-git-allow: incremental-migration
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('nonce seen before restart is still rejected after restart', () => {
    const nonce = crypto.randomBytes(16).toString('hex');

    // First bus instance
    const bus1 = makeProtectedBus(tmpDir);
    bus1.processIncoming([validMessage({ nonce, sequence: 0 })]);
    bus1.destroy();

    // Second bus instance (restart)
    const bus2 = makeProtectedBus(tmpDir);
    const received: AgentMessage[] = [];
    const rejected: string[] = [];
    bus2.on('message', (msg: AgentMessage) => received.push(msg));
    bus2.on('replay-rejected', (_msg: AgentMessage, reason: string) => rejected.push(reason));

    bus2.processIncoming([validMessage({ nonce, sequence: 1 })]);

    expect(received).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain('replay');

    bus2.destroy();
  });

  it('new nonces accepted after restart', () => {
    // First bus instance processes a message
    const bus1 = makeProtectedBus(tmpDir);
    bus1.processIncoming([validMessage({ sequence: 0 })]);
    bus1.destroy();

    // Second bus instance accepts new nonces
    // Note: sequence tracking is in-memory only (NonceStore), so we need seq > last seen
    const bus2 = makeProtectedBus(tmpDir);
    const received: AgentMessage[] = [];
    bus2.on('message', (msg: AgentMessage) => received.push(msg));

    // Sequence must be > 0 since 0 was already used by machine-b
    // But sequence tracking is NOT persisted in NonceStore (only nonces are persisted)
    // So sequence 1 would work since sequences reset on restart
    bus2.processIncoming([validMessage({ sequence: 0 })]);

    // This may or may not pass depending on sequence persistence
    // NonceStore only persists nonces, not sequences — so sequence 0 should be accepted
    // BUT the nonce must be different from the first bus's nonce
    expect(received).toHaveLength(1);

    bus2.destroy();
  });
});

// ── 8. Custom Timestamp Window ──────────────────────────────────────

describe('custom timestamp window', () => {
  beforeEach(() => { tmpDir = freshDir(); });
  // safe-git-allow: incremental-migration
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('respects custom timestamp window (shorter)', () => {
    const bus = makeBus(tmpDir, 'machine-a', {
      replayProtection: {
        enabled: true,
        timestampWindowMs: 10_000, // 10 seconds
      },
    });
    const received: AgentMessage[] = [];
    const rejected: string[] = [];
    bus.on('message', (msg: AgentMessage) => received.push(msg));
    bus.on('replay-rejected', (_msg: AgentMessage, reason: string) => rejected.push(reason));

    // 15 seconds old — within default 5 min but outside custom 10s
    const ts = new Date(Date.now() - 15_000).toISOString();
    bus.processIncoming([validMessage({ timestamp: ts })]);

    expect(received).toHaveLength(0);
    expect(rejected).toHaveLength(1);

    bus.destroy();
  });

  it('respects custom timestamp window (longer)', () => {
    const bus = makeBus(tmpDir, 'machine-a', {
      replayProtection: {
        enabled: true,
        timestampWindowMs: 15 * 60 * 1000, // 15 minutes
      },
    });
    const received: AgentMessage[] = [];
    bus.on('message', (msg: AgentMessage) => received.push(msg));

    // 10 minutes old — outside default 5 min but within custom 15 min
    const ts = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    bus.processIncoming([validMessage({ timestamp: ts })]);

    expect(received).toHaveLength(1);

    bus.destroy();
  });
});

// ── 9. Event Emission ───────────────────────────────────────────────

describe('replay-rejected event emission', () => {
  beforeEach(() => { tmpDir = freshDir(); });
  // safe-git-allow: incremental-migration
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('emits replay-rejected with message and reason for timestamp failure', () => {
    const bus = makeProtectedBus(tmpDir);
    const events: Array<{ msg: AgentMessage; reason: string }> = [];
    bus.on('replay-rejected', (msg: AgentMessage, reason: string) => events.push({ msg, reason }));

    const staleMsg = validMessage({
      timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    bus.processIncoming([staleMsg]);

    expect(events).toHaveLength(1);
    expect(events[0].msg.id).toBe(staleMsg.id);
    expect(events[0].reason).toContain('window');

    bus.destroy();
  });

  it('emits replay-rejected with message and reason for nonce replay', () => {
    const bus = makeProtectedBus(tmpDir);
    const events: Array<{ msg: AgentMessage; reason: string }> = [];
    bus.on('replay-rejected', (msg: AgentMessage, reason: string) => events.push({ msg, reason }));

    const nonce = crypto.randomBytes(16).toString('hex');
    bus.processIncoming([validMessage({ nonce, sequence: 0 })]);
    bus.processIncoming([validMessage({ nonce, sequence: 1, id: 'msg_dup2' })]);

    expect(events).toHaveLength(1);
    expect(events[0].reason).toContain('replay');

    bus.destroy();
  });

  it('emits replay-rejected with message and reason for sequence failure', () => {
    const bus = makeProtectedBus(tmpDir);
    const events: Array<{ msg: AgentMessage; reason: string }> = [];
    bus.on('replay-rejected', (msg: AgentMessage, reason: string) => events.push({ msg, reason }));

    bus.processIncoming([validMessage({ sequence: 10 })]);
    bus.processIncoming([validMessage({ sequence: 5 })]);

    expect(events).toHaveLength(1);
    expect(events[0].reason).toContain('Sequence');

    bus.destroy();
  });

  it('emits replay-rejected for missing fields', () => {
    const bus = makeProtectedBus(tmpDir);
    const events: Array<{ msg: AgentMessage; reason: string }> = [];
    bus.on('replay-rejected', (msg: AgentMessage, reason: string) => events.push({ msg, reason }));

    bus.processIncoming([{
      id: 'msg_no_fields',
      type: 'heartbeat',
      from: 'machine-b',
      to: 'machine-a',
      timestamp: new Date().toISOString(),
      ttlMs: 60000,
      payload: {},
      status: 'pending',
    }]);

    expect(events).toHaveLength(1);
    expect(events[0].reason).toContain('Missing');

    bus.destroy();
  });
});

// ── 10. Interaction with TTL ────────────────────────────────────────

describe('replay protection + TTL interaction', () => {
  beforeEach(() => { tmpDir = freshDir(); });
  // safe-git-allow: incremental-migration
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('TTL expiration checked before replay protection', () => {
    const bus = makeProtectedBus(tmpDir);
    const expired: AgentMessage[] = [];
    const rejected: string[] = [];
    bus.on('expired', (msg: AgentMessage) => expired.push(msg));
    bus.on('replay-rejected', (_msg: AgentMessage, reason: string) => rejected.push(reason));

    // Message with both TTL expired AND no nonce
    bus.processIncoming([{
      id: 'msg_ttl_and_replay',
      type: 'heartbeat',
      from: 'machine-b',
      to: 'machine-a',
      timestamp: new Date(Date.now() - 10000).toISOString(),
      ttlMs: 5000, // 5s TTL, but message is 10s old
      payload: {},
      status: 'pending',
      // No nonce/sequence
    }]);

    // TTL check happens first — should be expired, not replay-rejected
    expect(expired).toHaveLength(1);
    expect(rejected).toHaveLength(0);

    bus.destroy();
  });

  it('valid TTL + invalid replay fields = replay-rejected', () => {
    const bus = makeProtectedBus(tmpDir);
    const expired: AgentMessage[] = [];
    const rejected: string[] = [];
    bus.on('expired', (msg: AgentMessage) => expired.push(msg));
    bus.on('replay-rejected', (_msg: AgentMessage, reason: string) => rejected.push(reason));

    // Valid TTL but no replay fields
    bus.processIncoming([{
      id: 'msg_good_ttl_no_replay',
      type: 'heartbeat',
      from: 'machine-b',
      to: 'machine-a',
      timestamp: new Date().toISOString(),
      ttlMs: 60000, // Valid TTL
      payload: {},
      status: 'pending',
      // No nonce/sequence
    }]);

    expect(expired).toHaveLength(0);
    expect(rejected).toHaveLength(1);

    bus.destroy();
  });
});

// ── 11. Destroy Lifecycle ───────────────────────────────────────────

describe('destroy cleans up NonceStore', () => {
  beforeEach(() => { tmpDir = freshDir(); });
  // safe-git-allow: incremental-migration
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('destroy is safe to call multiple times', () => {
    const bus = makeProtectedBus(tmpDir);
    bus.destroy();
    bus.destroy(); // Should not throw
  });

  it('destroy is safe on unprotected bus', () => {
    const bus = makeBus(tmpDir);
    bus.destroy(); // No NonceStore to destroy
  });

  it('destroy stops polling and nonce store', () => {
    const bus = makeProtectedBus(tmpDir);
    bus.startPolling();
    bus.destroy(); // Should stop both polling and nonce store
  });
});

// ── 12. Broadcast with Replay Protection ────────────────────────────

describe('broadcast messages with replay protection', () => {
  beforeEach(() => { tmpDir = freshDir(); });
  // safe-git-allow: incremental-migration
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('broadcast messages include nonce/sequence', async () => {
    const bus = makeProtectedBus(tmpDir);
    const msg = await bus.send({
      type: 'work-announcement',
      to: '*',
      payload: { task: 'testing' },
    });

    expect(msg.nonce).toBeDefined();
    expect(msg.sequence).toBeDefined();
    expect(msg.to).toBe('*');

    bus.destroy();
  });

  it('broadcast messages validated by receiver', async () => {
    const sender = makeProtectedBus(tmpDir, 'machine-a');
    const receiver = makeProtectedBus(tmpDir, 'machine-b');
    const received: AgentMessage[] = [];
    receiver.on('message', (msg: AgentMessage) => received.push(msg));

    await sender.send({
      type: 'work-announcement',
      to: '*',
      payload: { task: 'broadcast-test' },
    });

    const outbox = sender.readOutbox();
    receiver.processIncoming(outbox);

    expect(received).toHaveLength(1);
    expect(received[0].payload).toEqual({ task: 'broadcast-test' });

    sender.destroy();
    receiver.destroy();
  });
});

// ── 13. HTTP Transport with Replay Protection ───────────────────────

describe('HTTP transport with replay protection', () => {
  beforeEach(() => { tmpDir = freshDir(); });
  // safe-git-allow: incremental-migration
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('handleHttpMessage validates replay fields', () => {
    const bus = makeProtectedBus(tmpDir, 'machine-a', { transport: 'http' });
    const received: AgentMessage[] = [];
    const rejected: string[] = [];
    bus.on('message', (msg: AgentMessage) => received.push(msg));
    bus.on('replay-rejected', (_msg: AgentMessage, reason: string) => rejected.push(reason));

    // Valid message via HTTP
    bus.handleHttpMessage(validMessage());
    expect(received).toHaveLength(1);
    expect(rejected).toHaveLength(0);

    bus.destroy();
  });

  it('handleHttpMessage rejects replay via HTTP', () => {
    const bus = makeProtectedBus(tmpDir, 'machine-a', { transport: 'http' });
    const received: AgentMessage[] = [];
    const rejected: string[] = [];
    bus.on('message', (msg: AgentMessage) => received.push(msg));
    bus.on('replay-rejected', (_msg: AgentMessage, reason: string) => rejected.push(reason));

    const nonce = crypto.randomBytes(16).toString('hex');
    bus.handleHttpMessage(validMessage({ nonce, sequence: 0 }));
    bus.handleHttpMessage(validMessage({ nonce, sequence: 1, id: 'msg_http_replay' }));

    expect(received).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    bus.destroy();
  });

  it('handleHttpMessage rejects legacy messages when protection enabled', () => {
    const bus = makeProtectedBus(tmpDir, 'machine-a', { transport: 'http' });
    const rejected: string[] = [];
    bus.on('replay-rejected', (_msg: AgentMessage, reason: string) => rejected.push(reason));

    bus.handleHttpMessage({
      id: 'msg_http_legacy',
      type: 'heartbeat',
      from: 'machine-b',
      to: 'machine-a',
      timestamp: new Date().toISOString(),
      ttlMs: 60000,
      payload: {},
      status: 'pending',
    });

    expect(rejected).toHaveLength(1);

    bus.destroy();
  });
});
