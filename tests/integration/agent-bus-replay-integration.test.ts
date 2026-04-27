/**
 * Integration tests for AgentBus Replay Protection (Phase 4A — Gap 1).
 *
 * End-to-end scenarios testing the full replay protection pipeline:
 *   1. Two protected buses communicating — send, deliver, reject replay
 *   2. Mixed-mode: protected receiver rejects unprotected sender
 *   3. Multi-machine scenario with isolated sequence tracking
 *   4. JSONL transport: write to outbox → poll → validate → deliver
 *   5. Persistence across bus restart (nonce store survives)
 *   6. Real attack scenarios: captured message replay, sequence regression
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bus-replay-integ-'));
}

function makeProtectedBus(
  dir: string,
  machineId: string,
  overrides: Partial<AgentBusConfig> = {},
): AgentBus {
  const stateDir = path.join(dir, '.instar');
  return new AgentBus({
    stateDir,
    machineId,
    transport: 'jsonl',
    defaultTtlMs: 30 * 60 * 1000,
    pollIntervalMs: 30,
    replayProtection: { enabled: true },
    ...overrides,
  });
}

function makeUnprotectedBus(
  dir: string,
  machineId: string,
): AgentBus {
  const stateDir = path.join(dir, '.instar');
  return new AgentBus({
    stateDir,
    machineId,
    transport: 'jsonl',
    defaultTtlMs: 30 * 60 * 1000,
    pollIntervalMs: 30,
  });
}

// ── 1. Full Send → Deliver → Reject Replay Cycle ───────────────────

describe('full send → deliver → reject replay cycle', () => {
  beforeEach(() => { tmpDir = freshDir(); });
  // safe-git-allow: incremental-migration
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('complete lifecycle: send, deliver, replay rejected', async () => {
    const sender = makeProtectedBus(tmpDir, 'workstation');
    const receiver = makeProtectedBus(tmpDir, 'dawn-macbook');

    // Track events on receiver
    const delivered: AgentMessage[] = [];
    const rejected: Array<{ msg: AgentMessage; reason: string }> = [];
    receiver.on('message', (msg: AgentMessage) => delivered.push(msg));
    receiver.on('replay-rejected', (msg: AgentMessage, reason: string) =>
      rejected.push({ msg, reason }));

    // Step 1: Sender creates a work announcement
    const sent = await sender.send({
      type: 'work-announcement',
      to: 'dawn-macbook',
      payload: { jobId: 'daily-sync', claimedBy: 'workstation' },
    });

    // Verify send-side fields
    expect(sent.nonce).toBeDefined();
    expect(sent.nonce!.length).toBe(32);
    expect(sent.sequence).toBe(0);

    // Step 2: Receiver processes the message (first delivery)
    const outbox = sender.readOutbox();
    receiver.processIncoming(outbox);

    expect(delivered).toHaveLength(1);
    expect(delivered[0].payload).toEqual({ jobId: 'daily-sync', claimedBy: 'workstation' });
    expect(delivered[0].nonce).toBe(sent.nonce);

    // Step 3: Attacker replays the exact same message
    receiver.processIncoming(outbox);

    expect(delivered).toHaveLength(1); // Still 1 — replay blocked
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain('replay');

    sender.destroy();
    receiver.destroy();
  });

  it('multiple messages in order all delivered, then batch replay blocked', async () => {
    const sender = makeProtectedBus(tmpDir, 'workstation');
    const receiver = makeProtectedBus(tmpDir, 'dawn-macbook');
    const delivered: AgentMessage[] = [];
    const rejected: string[] = [];
    receiver.on('message', (msg: AgentMessage) => delivered.push(msg));
    receiver.on('replay-rejected', (_msg: AgentMessage, reason: string) => rejected.push(reason));

    // Send 5 messages
    for (let i = 0; i < 5; i++) {
      await sender.send({
        type: 'status-update',
        to: 'dawn-macbook',
        payload: { step: i },
      });
    }

    const outbox = sender.readOutbox();
    expect(outbox).toHaveLength(5);

    // First processing — all delivered
    receiver.processIncoming(outbox);
    expect(delivered).toHaveLength(5);
    expect(rejected).toHaveLength(0);

    // Second processing — all rejected (replay)
    receiver.processIncoming(outbox);
    expect(delivered).toHaveLength(5); // No new deliveries
    expect(rejected).toHaveLength(5);  // All 5 rejected as replays

    sender.destroy();
    receiver.destroy();
  });
});

// ── 2. Mixed Mode: Protected Receiver vs Unprotected Sender ────────

describe('protected receiver rejects unprotected sender', () => {
  beforeEach(() => { tmpDir = freshDir(); });
  // safe-git-allow: incremental-migration
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('messages without nonce/sequence rejected (fail-closed)', async () => {
    const sender = makeUnprotectedBus(tmpDir, 'old-machine');
    const receiver = makeProtectedBus(tmpDir, 'new-machine');

    const delivered: AgentMessage[] = [];
    const rejected: string[] = [];
    receiver.on('message', (msg: AgentMessage) => delivered.push(msg));
    receiver.on('replay-rejected', (_msg: AgentMessage, reason: string) => rejected.push(reason));

    await sender.send({
      type: 'heartbeat',
      to: 'new-machine',
      payload: { alive: true },
    });

    const outbox = sender.readOutbox();
    // Unprotected sender's messages lack nonce/sequence
    expect(outbox[0].nonce).toBeUndefined();
    expect(outbox[0].sequence).toBeUndefined();

    receiver.processIncoming(outbox);

    expect(delivered).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain('Missing nonce or sequence');

    sender.destroy();
    receiver.destroy();
  });
});

// ── 3. Multi-Machine Isolation ──────────────────────────────────────

describe('multi-machine scenario with isolated tracking', () => {
  beforeEach(() => { tmpDir = freshDir(); });
  // safe-git-allow: incremental-migration
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('three machines communicate without interference', async () => {
    const busA = makeProtectedBus(tmpDir, 'machine-a');
    const busB = makeProtectedBus(tmpDir, 'machine-b');
    const busC = makeProtectedBus(tmpDir, 'machine-c');

    const receivedByA: AgentMessage[] = [];
    const receivedByB: AgentMessage[] = [];
    const receivedByC: AgentMessage[] = [];
    busA.on('message', (msg: AgentMessage) => receivedByA.push(msg));
    busB.on('message', (msg: AgentMessage) => receivedByB.push(msg));
    busC.on('message', (msg: AgentMessage) => receivedByC.push(msg));

    // A sends to B
    await busA.send({ type: 'heartbeat', to: 'machine-b', payload: { src: 'a' } });
    // B sends to C
    await busB.send({ type: 'heartbeat', to: 'machine-c', payload: { src: 'b' } });
    // C sends to A
    await busC.send({ type: 'heartbeat', to: 'machine-a', payload: { src: 'c' } });

    // Deliver
    busB.processIncoming(busA.readOutbox());
    busC.processIncoming(busB.readOutbox());
    busA.processIncoming(busC.readOutbox());

    expect(receivedByA).toHaveLength(1);
    expect(receivedByA[0].payload).toEqual({ src: 'c' });
    expect(receivedByB).toHaveLength(1);
    expect(receivedByB[0].payload).toEqual({ src: 'a' });
    expect(receivedByC).toHaveLength(1);
    expect(receivedByC[0].payload).toEqual({ src: 'b' });

    busA.destroy();
    busB.destroy();
    busC.destroy();
  });

  it('broadcast from A reaches B and C, replay rejected on both', async () => {
    const busA = makeProtectedBus(tmpDir, 'machine-a');
    const busB = makeProtectedBus(tmpDir, 'machine-b');
    const busC = makeProtectedBus(tmpDir, 'machine-c');

    const deliveredB: AgentMessage[] = [];
    const deliveredC: AgentMessage[] = [];
    const rejectedB: string[] = [];
    const rejectedC: string[] = [];
    busB.on('message', (msg: AgentMessage) => deliveredB.push(msg));
    busC.on('message', (msg: AgentMessage) => deliveredC.push(msg));
    busB.on('replay-rejected', (_msg: AgentMessage, reason: string) => rejectedB.push(reason));
    busC.on('replay-rejected', (_msg: AgentMessage, reason: string) => rejectedC.push(reason));

    await busA.send({
      type: 'work-announcement',
      to: '*',
      payload: { task: 'global-sync' },
    });

    const outbox = busA.readOutbox();

    // First delivery
    busB.processIncoming(outbox);
    busC.processIncoming(outbox);
    expect(deliveredB).toHaveLength(1);
    expect(deliveredC).toHaveLength(1);

    // Replay attempt
    busB.processIncoming(outbox);
    busC.processIncoming(outbox);
    expect(deliveredB).toHaveLength(1);
    expect(deliveredC).toHaveLength(1);
    expect(rejectedB).toHaveLength(1);
    expect(rejectedC).toHaveLength(1);

    busA.destroy();
    busB.destroy();
    busC.destroy();
  });
});

// ── 4. JSONL Polling with Replay Protection ─────────────────────────

describe('JSONL polling integration with replay protection', () => {
  beforeEach(() => { tmpDir = freshDir(); });
  // safe-git-allow: incremental-migration
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('polling delivers valid messages and rejects replays', async () => {
    const receiver = makeProtectedBus(tmpDir, 'machine-a');
    const delivered: AgentMessage[] = [];
    const rejected: string[] = [];
    receiver.on('message', (msg: AgentMessage) => delivered.push(msg));
    receiver.on('replay-rejected', (_msg: AgentMessage, reason: string) => rejected.push(reason));

    // Write a valid message to inbox
    const inboxPath = path.join(tmpDir, '.instar', 'state', 'messages', 'inbox.jsonl');
    const msg: AgentMessage = {
      id: 'msg_poll_valid',
      type: 'heartbeat',
      from: 'machine-b',
      to: 'machine-a',
      timestamp: new Date().toISOString(),
      ttlMs: 0,
      payload: { polled: true },
      status: 'pending',
      nonce: crypto.randomBytes(16).toString('hex'),
      sequence: 0,
    };
    fs.writeFileSync(inboxPath, JSON.stringify(msg) + '\n');

    receiver.startPolling();
    await new Promise(r => setTimeout(r, 100));
    receiver.stopPolling();

    expect(delivered).toHaveLength(1);
    expect(delivered[0].payload).toEqual({ polled: true });

    // Write the same message again (replay via JSONL)
    fs.writeFileSync(inboxPath, JSON.stringify(msg) + '\n');

    receiver.startPolling();
    await new Promise(r => setTimeout(r, 100));
    receiver.stopPolling();

    expect(delivered).toHaveLength(1); // No new delivery
    expect(rejected).toHaveLength(1); // Replay rejected

    receiver.destroy();
  });
});

// ── 5. Persistence Integration ──────────────────────────────────────

describe('nonce store persistence across bus lifecycle', () => {
  beforeEach(() => { tmpDir = freshDir(); });
  // safe-git-allow: incremental-migration
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('full lifecycle: bus1 receives → bus1 destroyed → bus2 rejects replay', async () => {
    const sender = makeProtectedBus(tmpDir, 'machine-a');
    const nonce = crypto.randomBytes(16).toString('hex');

    // Step 1: First receiver processes message
    const receiver1 = makeProtectedBus(tmpDir, 'machine-b');
    const msg = await sender.send({
      type: 'work-complete',
      to: 'machine-b',
      payload: { jobId: 'test-job' },
    });

    receiver1.processIncoming(sender.readOutbox());
    receiver1.destroy(); // Simulates process restart

    // Step 2: New receiver instance rejects the same message
    const receiver2 = makeProtectedBus(tmpDir, 'machine-b');
    const delivered: AgentMessage[] = [];
    const rejected: string[] = [];
    receiver2.on('message', (m: AgentMessage) => delivered.push(m));
    receiver2.on('replay-rejected', (_m: AgentMessage, reason: string) => rejected.push(reason));

    receiver2.processIncoming(sender.readOutbox()); // Same outbox = replay

    expect(delivered).toHaveLength(0);
    expect(rejected).toHaveLength(1);

    sender.destroy();
    receiver2.destroy();
  });
});

// ── 6. Real Attack Scenarios ────────────────────────────────────────

describe('real attack scenarios', () => {
  beforeEach(() => { tmpDir = freshDir(); });
  // safe-git-allow: incremental-migration
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('attack: re-execute claimed job via captured work-announcement', async () => {
    const legitimateMachine = makeProtectedBus(tmpDir, 'workstation');
    const target = makeProtectedBus(tmpDir, 'dawn-macbook');

    const delivered: AgentMessage[] = [];
    const rejected: string[] = [];
    target.on('message', (msg: AgentMessage) => delivered.push(msg));
    target.on('replay-rejected', (_msg: AgentMessage, reason: string) => rejected.push(reason));

    // Legitimate machine claims a job
    await legitimateMachine.send({
      type: 'work-announcement',
      to: '*',
      payload: { jobId: 'nightly-backup', status: 'claimed' },
    });

    const outbox = legitimateMachine.readOutbox();
    const capturedMessage = { ...outbox[0] }; // "Attacker captures the message"

    // Target receives legitimate message
    target.processIncoming(outbox);
    expect(delivered).toHaveLength(1);

    // Attacker replays the captured message to re-execute the job
    target.processIncoming([capturedMessage]);
    expect(delivered).toHaveLength(1); // Replay blocked
    expect(rejected).toHaveLength(1);

    legitimateMachine.destroy();
    target.destroy();
  });

  it('attack: fake heartbeat from dead machine', async () => {
    const target = makeProtectedBus(tmpDir, 'dawn-macbook');
    const rejected: string[] = [];
    target.on('replay-rejected', (_msg: AgentMessage, reason: string) => rejected.push(reason));

    // Attacker crafts a heartbeat with old timestamp (machine died 10 min ago)
    const fakeHeartbeat: AgentMessage = {
      id: 'msg_fake_hb',
      type: 'heartbeat',
      from: 'dead-machine',
      to: '*',
      timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min old
      ttlMs: 0,
      payload: { alive: true },
      status: 'pending',
      nonce: crypto.randomBytes(16).toString('hex'),
      sequence: 0,
    };

    target.processIncoming([fakeHeartbeat]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain('window');

    target.destroy();
  });

  it('attack: sequence regression to replay revoked authorization', async () => {
    const target = makeProtectedBus(tmpDir, 'dawn-macbook');
    const delivered: AgentMessage[] = [];
    const rejected: string[] = [];
    target.on('message', (msg: AgentMessage) => delivered.push(msg));
    target.on('replay-rejected', (_msg: AgentMessage, reason: string) => rejected.push(reason));

    // Legitimate message: grant admin
    target.processIncoming([{
      id: 'msg_grant',
      type: 'custom',
      from: 'workstation',
      to: 'dawn-macbook',
      timestamp: new Date().toISOString(),
      ttlMs: 0,
      payload: { action: 'grant-admin', userId: 12345 },
      status: 'pending',
      nonce: crypto.randomBytes(16).toString('hex'),
      sequence: 5,
    }]);

    // Legitimate message: revoke admin
    target.processIncoming([{
      id: 'msg_revoke',
      type: 'custom',
      from: 'workstation',
      to: 'dawn-macbook',
      timestamp: new Date().toISOString(),
      ttlMs: 0,
      payload: { action: 'revoke-admin', userId: 12345 },
      status: 'pending',
      nonce: crypto.randomBytes(16).toString('hex'),
      sequence: 6,
    }]);

    expect(delivered).toHaveLength(2);

    // Attacker replays the grant message with old sequence
    target.processIncoming([{
      id: 'msg_replay_grant',
      type: 'custom',
      from: 'workstation',
      to: 'dawn-macbook',
      timestamp: new Date().toISOString(),
      ttlMs: 0,
      payload: { action: 'grant-admin', userId: 12345 },
      status: 'pending',
      nonce: crypto.randomBytes(16).toString('hex'), // New nonce but...
      sequence: 5, // Old sequence → rejected
    }]);

    expect(delivered).toHaveLength(2); // No new delivery
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain('Sequence');

    target.destroy();
  });
});

// ── 7. Nonce Store Directory Configuration ──────────────────────────

describe('custom nonce store directory', () => {
  beforeEach(() => { tmpDir = freshDir(); });
  // safe-git-allow: incremental-migration
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('uses custom nonceStoreDir when specified', async () => {
    const customDir = path.join(tmpDir, 'custom-nonces');
    const bus = makeProtectedBus(tmpDir, 'machine-a', {
      replayProtection: {
        enabled: true,
        nonceStoreDir: customDir,
      },
    });

    // Process a message to trigger nonce persistence
    bus.processIncoming([{
      id: 'msg_custom_dir',
      type: 'heartbeat',
      from: 'machine-b',
      to: 'machine-a',
      timestamp: new Date().toISOString(),
      ttlMs: 0,
      payload: {},
      status: 'pending',
      nonce: crypto.randomBytes(16).toString('hex'),
      sequence: 0,
    }]);

    // Verify nonce file written to custom directory
    expect(fs.existsSync(path.join(customDir, 'nonces.jsonl'))).toBe(true);

    bus.destroy();
  });
});
