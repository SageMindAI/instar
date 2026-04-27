/**
 * Unit tests for JobClaimManager (Phase 4C — Gap 5).
 *
 * Tests the distributed job claiming protocol for multi-machine deduplication.
 *
 * Covers:
 *   1. Claim lifecycle: create, complete, expire
 *   2. Remote claim handling: receive, respect, prune
 *   3. Idempotency: same machine re-claim, duplicate claim IDs
 *   4. Claim expiry and timeout
 *   5. AgentBus message broadcasting
 *   6. Persistence: save/load across restarts
 *   7. Event emission: claim-received, complete-received, claim-expired
 *   8. Concurrent claiming: race conditions, first-writer-wins
 *   9. Edge cases: empty ledger, unknown jobs, destroy lifecycle
 *  10. Integration with SkipReason and skip ledger
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JobClaimManager } from '../../src/scheduler/JobClaimManager.js';
import { AgentBus } from '../../src/core/AgentBus.js';
import type { AgentMessage } from '../../src/core/AgentBus.js';
import type { JobClaim, JobClaimPayload, JobCompletePayload } from '../../src/scheduler/JobClaimManager.js';

// ── Helpers ─────────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-claim-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

function createBus(stateDir: string, machineId: string): AgentBus {
  return new AgentBus({
    stateDir,
    machineId,
    transport: 'jsonl',
    defaultTtlMs: 0, // No expiration for tests
  });
}

function createManager(
  bus: AgentBus,
  machineId: string,
  stateDir: string,
  overrides?: Partial<{ defaultClaimTimeoutMs: number; pruneIntervalMs: number }>,
): JobClaimManager {
  return new JobClaimManager({
    bus,
    machineId,
    stateDir,
    defaultClaimTimeoutMs: overrides?.defaultClaimTimeoutMs ?? 30 * 60_000,
    pruneIntervalMs: overrides?.pruneIntervalMs ?? 60 * 60_000, // Large interval to avoid test interference
  });
}

/** Simulate a remote machine sending a work-announcement message. */
function simulateRemoteClaim(
  bus: AgentBus,
  from: string,
  jobSlug: string,
  claimId: string,
  expiresAt?: string,
): void {
  const msg: AgentMessage<JobClaimPayload> = {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'work-announcement',
    from,
    to: '*',
    timestamp: new Date().toISOString(),
    ttlMs: 0,
    payload: {
      claimId,
      jobSlug,
      machineId: from,
      expiresAt: expiresAt ?? new Date(Date.now() + 30 * 60_000).toISOString(),
    },
    status: 'delivered',
  };
  bus.processIncoming([msg]);
}

/** Simulate a remote machine sending a work-complete message. */
function simulateRemoteComplete(
  bus: AgentBus,
  from: string,
  jobSlug: string,
  claimId: string,
  result: 'success' | 'failure' = 'success',
): void {
  const msg: AgentMessage<JobCompletePayload> = {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'work-complete',
    from,
    to: '*',
    timestamp: new Date().toISOString(),
    ttlMs: 0,
    payload: {
      claimId,
      jobSlug,
      machineId: from,
      result,
    },
    status: 'delivered',
  };
  bus.processIncoming([msg]);
}

// ── 1. Claim Lifecycle ──────────────────────────────────────────────

describe('claim lifecycle', () => {
  let tmpDir: string;
  let bus: AgentBus;
  let manager: JobClaimManager;

  beforeEach(() => {
    tmpDir = createTempDir();
    bus = createBus(tmpDir, 'm_workstation');
    manager = createManager(bus, 'm_workstation', tmpDir);
  });

  afterEach(() => {
    manager.destroy();
    bus.destroy();
    cleanup(tmpDir);
  });

  it('tryClaim returns a claimId on success', async () => {
    const claimId = await manager.tryClaim('daily-sync');
    expect(claimId).toBeTruthy();
    expect(claimId).toMatch(/^claim_/);
  });

  it('getClaim returns the active claim after tryClaim', async () => {
    const claimId = await manager.tryClaim('daily-sync');
    const claim = manager.getClaim('daily-sync');

    expect(claim).toBeDefined();
    expect(claim!.claimId).toBe(claimId);
    expect(claim!.jobSlug).toBe('daily-sync');
    expect(claim!.machineId).toBe('m_workstation');
    expect(claim!.completed).toBe(false);
  });

  it('completeClaim marks the claim as completed', async () => {
    await manager.tryClaim('daily-sync');
    await manager.completeClaim('daily-sync', 'success');

    const claim = manager.getClaim('daily-sync');
    // After completion, getClaim prunes completed claims
    // But the claim is completed, not expired, so it stays for 1 hour
    expect(claim).toBeDefined();
    expect(claim!.completed).toBe(true);
    expect(claim!.result).toBe('success');
    expect(claim!.completedAt).toBeTruthy();
  });

  it('completeClaim with failure result', async () => {
    await manager.tryClaim('daily-sync');
    await manager.completeClaim('daily-sync', 'failure');

    const claim = manager.getClaim('daily-sync');
    expect(claim!.completed).toBe(true);
    expect(claim!.result).toBe('failure');
  });

  it('tryClaim after completion allows re-claim', async () => {
    await manager.tryClaim('daily-sync');
    await manager.completeClaim('daily-sync', 'success');

    const newClaimId = await manager.tryClaim('daily-sync');
    expect(newClaimId).toBeTruthy();

    const claim = manager.getClaim('daily-sync');
    expect(claim!.claimId).toBe(newClaimId);
    expect(claim!.completed).toBe(false);
  });

  it('getActiveClaims returns only active claims', async () => {
    await manager.tryClaim('job-a');
    await manager.tryClaim('job-b');
    await manager.completeClaim('job-a', 'success');

    const active = manager.getActiveClaims();
    expect(active).toHaveLength(1);
    expect(active[0].jobSlug).toBe('job-b');
  });

  it('getAllClaims returns all claims including completed', async () => {
    await manager.tryClaim('job-a');
    await manager.tryClaim('job-b');
    await manager.completeClaim('job-a', 'success');

    const all = manager.getAllClaims();
    expect(all).toHaveLength(2);
  });
});

// ── 2. Remote Claim Handling ────────────────────────────────────────

describe('remote claim handling', () => {
  let tmpDir: string;
  let bus: AgentBus;
  let manager: JobClaimManager;

  beforeEach(() => {
    tmpDir = createTempDir();
    bus = createBus(tmpDir, 'm_workstation');
    manager = createManager(bus, 'm_workstation', tmpDir);
  });

  afterEach(() => {
    manager.destroy();
    bus.destroy();
    cleanup(tmpDir);
  });

  it('records a remote claim from another machine', () => {
    simulateRemoteClaim(bus, 'm_dawn_macbook', 'daily-sync', 'claim_remote_1');

    const claim = manager.getClaim('daily-sync');
    expect(claim).toBeDefined();
    expect(claim!.machineId).toBe('m_dawn_macbook');
    expect(claim!.claimId).toBe('claim_remote_1');
  });

  it('hasRemoteClaim returns true for remote claims', () => {
    simulateRemoteClaim(bus, 'm_dawn_macbook', 'daily-sync', 'claim_remote_1');
    expect(manager.hasRemoteClaim('daily-sync')).toBe(true);
  });

  it('hasRemoteClaim returns false for own claims', async () => {
    await manager.tryClaim('daily-sync');
    expect(manager.hasRemoteClaim('daily-sync')).toBe(false);
  });

  it('hasRemoteClaim returns false for unknown jobs', () => {
    expect(manager.hasRemoteClaim('unknown-job')).toBe(false);
  });

  it('tryClaim fails when remote machine holds active claim', async () => {
    simulateRemoteClaim(bus, 'm_dawn_macbook', 'daily-sync', 'claim_remote_1');

    const claimId = await manager.tryClaim('daily-sync');
    expect(claimId).toBeNull();
  });

  it('tryClaim succeeds after remote claim completes', async () => {
    simulateRemoteClaim(bus, 'm_dawn_macbook', 'daily-sync', 'claim_remote_1');
    simulateRemoteComplete(bus, 'm_dawn_macbook', 'daily-sync', 'claim_remote_1');

    const claimId = await manager.tryClaim('daily-sync');
    expect(claimId).toBeTruthy();
  });

  it('records remote work-complete', () => {
    simulateRemoteClaim(bus, 'm_dawn_macbook', 'daily-sync', 'claim_remote_1');
    simulateRemoteComplete(bus, 'm_dawn_macbook', 'daily-sync', 'claim_remote_1', 'failure');

    const claim = manager.getClaim('daily-sync');
    expect(claim!.completed).toBe(true);
    expect(claim!.result).toBe('failure');
  });

  it('ignores work-complete for unknown claimId', () => {
    simulateRemoteClaim(bus, 'm_dawn_macbook', 'daily-sync', 'claim_remote_1');
    simulateRemoteComplete(bus, 'm_dawn_macbook', 'daily-sync', 'claim_wrong_id');

    const claim = manager.getClaim('daily-sync');
    expect(claim!.completed).toBe(false);
  });
});

// ── 3. Idempotency ──────────────────────────────────────────────────

describe('idempotency', () => {
  let tmpDir: string;
  let bus: AgentBus;
  let manager: JobClaimManager;

  beforeEach(() => {
    tmpDir = createTempDir();
    bus = createBus(tmpDir, 'm_workstation');
    manager = createManager(bus, 'm_workstation', tmpDir);
  });

  afterEach(() => {
    manager.destroy();
    bus.destroy();
    cleanup(tmpDir);
  });

  it('re-claiming own job returns same claimId', async () => {
    const claimId1 = await manager.tryClaim('daily-sync');
    const claimId2 = await manager.tryClaim('daily-sync');

    expect(claimId1).toBe(claimId2);
  });

  it('different jobs get different claimIds', async () => {
    const claim1 = await manager.tryClaim('job-a');
    const claim2 = await manager.tryClaim('job-b');

    expect(claim1).not.toBe(claim2);
  });

  it('first-writer-wins: second remote claim does not overwrite first', () => {
    simulateRemoteClaim(bus, 'm_dawn_macbook', 'daily-sync', 'claim_first');
    simulateRemoteClaim(bus, 'm_third_machine', 'daily-sync', 'claim_second');

    const claim = manager.getClaim('daily-sync');
    // First claimer wins
    expect(claim!.claimId).toBe('claim_first');
    expect(claim!.machineId).toBe('m_dawn_macbook');
  });

  it('completeClaim is no-op for another machine\'s claim', async () => {
    simulateRemoteClaim(bus, 'm_dawn_macbook', 'daily-sync', 'claim_remote');

    // Trying to complete another machine's claim should be ignored
    await manager.completeClaim('daily-sync', 'success');

    const claim = manager.getClaim('daily-sync');
    expect(claim!.completed).toBe(false); // Still active
  });
});

// ── 4. Claim Expiry ─────────────────────────────────────────────────

describe('claim expiry', () => {
  let tmpDir: string;
  let bus: AgentBus;
  let manager: JobClaimManager;

  beforeEach(() => {
    tmpDir = createTempDir();
    bus = createBus(tmpDir, 'm_workstation');
    manager = createManager(bus, 'm_workstation', tmpDir);
  });

  afterEach(() => {
    manager.destroy();
    bus.destroy();
    cleanup(tmpDir);
  });

  it('expired remote claims are pruned', () => {
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    simulateRemoteClaim(bus, 'm_dawn_macbook', 'daily-sync', 'claim_expired', pastExpiry);

    // Claim should be pruned on access
    expect(manager.hasRemoteClaim('daily-sync')).toBe(false);
    expect(manager.getClaim('daily-sync')).toBeUndefined();
  });

  it('expired claims allow re-claim by any machine', async () => {
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    simulateRemoteClaim(bus, 'm_dawn_macbook', 'daily-sync', 'claim_expired', pastExpiry);

    const claimId = await manager.tryClaim('daily-sync');
    expect(claimId).toBeTruthy();
  });

  it('tryClaim with custom timeout', async () => {
    const claimId = await manager.tryClaim('daily-sync', 60_000); // 1 minute
    const claim = manager.getClaim('daily-sync');

    expect(claim).toBeDefined();
    const expiresAt = new Date(claim!.expiresAt).getTime();
    const expectedMin = Date.now() + 55_000;
    const expectedMax = Date.now() + 65_000;
    expect(expiresAt).toBeGreaterThan(expectedMin);
    expect(expiresAt).toBeLessThan(expectedMax);
  });

  it('pruneExpired returns count of pruned claims', () => {
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    simulateRemoteClaim(bus, 'm_dawn_macbook', 'job-a', 'claim_a', pastExpiry);
    simulateRemoteClaim(bus, 'm_dawn_macbook', 'job-b', 'claim_b', pastExpiry);

    const pruned = manager.pruneExpired();
    expect(pruned).toBe(2);
  });

  it('completed claims are retained for 1 hour then pruned', async () => {
    await manager.tryClaim('daily-sync');
    await manager.completeClaim('daily-sync', 'success');

    // Should still be present (completed recently)
    expect(manager.getAllClaims()).toHaveLength(1);

    // Manually set completedAt to over 1 hour ago
    const claim = manager.getClaim('daily-sync');
    claim!.completedAt = new Date(Date.now() - 61 * 60_000).toISOString();

    const pruned = manager.pruneExpired();
    expect(pruned).toBe(1);
    expect(manager.getAllClaims()).toHaveLength(0);
  });
});

// ── 5. AgentBus Message Broadcasting ────────────────────────────────

describe('AgentBus message broadcasting', () => {
  let tmpDir: string;
  let bus: AgentBus;
  let manager: JobClaimManager;

  beforeEach(() => {
    tmpDir = createTempDir();
    bus = createBus(tmpDir, 'm_workstation');
    manager = createManager(bus, 'm_workstation', tmpDir);
  });

  afterEach(() => {
    manager.destroy();
    bus.destroy();
    cleanup(tmpDir);
  });

  it('tryClaim broadcasts work-announcement via bus', async () => {
    const sentMessages: AgentMessage[] = [];
    bus.on('sent', (msg) => sentMessages.push(msg));

    await manager.tryClaim('daily-sync');

    const announcement = sentMessages.find(m => m.type === 'work-announcement');
    expect(announcement).toBeDefined();
    expect(announcement!.to).toBe('*');
    expect(announcement!.from).toBe('m_workstation');

    const payload = announcement!.payload as JobClaimPayload;
    expect(payload.jobSlug).toBe('daily-sync');
    expect(payload.machineId).toBe('m_workstation');
    expect(payload.claimId).toMatch(/^claim_/);
    expect(payload.expiresAt).toBeTruthy();
  });

  it('completeClaim broadcasts work-complete via bus', async () => {
    const sentMessages: AgentMessage[] = [];
    bus.on('sent', (msg) => sentMessages.push(msg));

    await manager.tryClaim('daily-sync');
    await manager.completeClaim('daily-sync', 'success');

    const completion = sentMessages.find(m => m.type === 'work-complete');
    expect(completion).toBeDefined();
    expect(completion!.to).toBe('*');

    const payload = completion!.payload as JobCompletePayload;
    expect(payload.jobSlug).toBe('daily-sync');
    expect(payload.result).toBe('success');
  });

  it('re-claiming own job does not broadcast additional message', async () => {
    const sentMessages: AgentMessage[] = [];
    bus.on('sent', (msg) => sentMessages.push(msg));

    await manager.tryClaim('daily-sync');
    await manager.tryClaim('daily-sync');

    const announcements = sentMessages.filter(m => m.type === 'work-announcement');
    expect(announcements).toHaveLength(1);
  });

  it('failed tryClaim (remote holds claim) does not broadcast', async () => {
    simulateRemoteClaim(bus, 'm_dawn_macbook', 'daily-sync', 'claim_remote');

    const sentMessages: AgentMessage[] = [];
    bus.on('sent', (msg) => sentMessages.push(msg));

    await manager.tryClaim('daily-sync');

    const announcements = sentMessages.filter(m => m.type === 'work-announcement');
    expect(announcements).toHaveLength(0);
  });
});

// ── 6. Persistence ──────────────────────────────────────────────────

describe('persistence', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('claims persist to disk', async () => {
    const bus = createBus(tmpDir, 'm_workstation');
    const manager = createManager(bus, 'm_workstation', tmpDir);

    await manager.tryClaim('daily-sync');
    manager.destroy();
    bus.destroy();

    // Verify file exists
    const filePath = path.join(tmpDir, 'state', 'job-claims.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(content).toHaveLength(1);
    expect(content[0].jobSlug).toBe('daily-sync');
  });

  it('claims load from disk on restart', async () => {
    const bus1 = createBus(tmpDir, 'm_workstation');
    const manager1 = createManager(bus1, 'm_workstation', tmpDir);

    const claimId = await manager1.tryClaim('daily-sync');
    manager1.destroy();
    bus1.destroy();

    // Restart
    const bus2 = createBus(tmpDir, 'm_workstation');
    const manager2 = createManager(bus2, 'm_workstation', tmpDir);

    const claim = manager2.getClaim('daily-sync');
    expect(claim).toBeDefined();
    expect(claim!.claimId).toBe(claimId);

    manager2.destroy();
    bus2.destroy();
  });

  it('remote claims persist and survive restart', () => {
    const bus1 = createBus(tmpDir, 'm_workstation');
    const manager1 = createManager(bus1, 'm_workstation', tmpDir);

    simulateRemoteClaim(bus1, 'm_dawn_macbook', 'daily-sync', 'claim_remote');
    manager1.destroy();
    bus1.destroy();

    // Restart
    const bus2 = createBus(tmpDir, 'm_workstation');
    const manager2 = createManager(bus2, 'm_workstation', tmpDir);

    expect(manager2.hasRemoteClaim('daily-sync')).toBe(true);

    manager2.destroy();
    bus2.destroy();
  });
});

// ── 7. Event Emission ───────────────────────────────────────────────

describe('event emission', () => {
  let tmpDir: string;
  let bus: AgentBus;
  let manager: JobClaimManager;

  beforeEach(() => {
    tmpDir = createTempDir();
    bus = createBus(tmpDir, 'm_workstation');
    manager = createManager(bus, 'm_workstation', tmpDir);
  });

  afterEach(() => {
    manager.destroy();
    bus.destroy();
    cleanup(tmpDir);
  });

  it('emits claim-received for remote claims', () => {
    const received: JobClaim[] = [];
    manager.on('claim-received', (claim) => received.push(claim));

    simulateRemoteClaim(bus, 'm_dawn_macbook', 'daily-sync', 'claim_remote');

    expect(received).toHaveLength(1);
    expect(received[0].jobSlug).toBe('daily-sync');
    expect(received[0].machineId).toBe('m_dawn_macbook');
  });

  it('emits complete-received for remote completions', () => {
    const completions: JobCompletePayload[] = [];
    manager.on('complete-received', (payload) => completions.push(payload));

    simulateRemoteClaim(bus, 'm_dawn_macbook', 'daily-sync', 'claim_remote');
    simulateRemoteComplete(bus, 'm_dawn_macbook', 'daily-sync', 'claim_remote', 'success');

    expect(completions).toHaveLength(1);
    expect(completions[0].result).toBe('success');
  });

  it('emits claim-expired when expired claims are pruned', () => {
    const expired: JobClaim[] = [];
    manager.on('claim-expired', (claim) => expired.push(claim));

    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    simulateRemoteClaim(bus, 'm_dawn_macbook', 'daily-sync', 'claim_old', pastExpiry);

    manager.pruneExpired();

    expect(expired).toHaveLength(1);
    expect(expired[0].claimId).toBe('claim_old');
  });

  it('does not emit claim-received for own claims', async () => {
    const received: JobClaim[] = [];
    manager.on('claim-received', (claim) => received.push(claim));

    await manager.tryClaim('daily-sync');

    expect(received).toHaveLength(0);
  });
});

// ── 8. Concurrent Claiming ──────────────────────────────────────────

describe('concurrent claiming (race conditions)', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('two managers: second machine loses race', async () => {
    // Machine A and Machine B both share the same state dir but have different IDs
    // Simulate the scenario where A claims first, then B's remote claim arrives at A
    const busA = createBus(tmpDir, 'm_workstation');
    const managerA = createManager(busA, 'm_workstation', tmpDir);

    // A claims the job
    const claimIdA = await managerA.tryClaim('daily-sync');
    expect(claimIdA).toBeTruthy();

    // B's claim arrives (but A already holds the claim)
    simulateRemoteClaim(busA, 'm_dawn_macbook', 'daily-sync', 'claim_b');

    // A should still hold the claim (first-writer-wins)
    const claim = managerA.getClaim('daily-sync');
    expect(claim!.claimId).toBe(claimIdA);
    expect(claim!.machineId).toBe('m_workstation');

    managerA.destroy();
    busA.destroy();
  });

  it('multiple jobs can be claimed concurrently by different managers', async () => {
    const busA = createBus(tmpDir, 'm_workstation');
    const managerA = createManager(busA, 'm_workstation', tmpDir);

    // A claims job-a
    const claimA = await managerA.tryClaim('job-a');
    expect(claimA).toBeTruthy();

    // B claims job-b (received via bus)
    simulateRemoteClaim(busA, 'm_dawn_macbook', 'job-b', 'claim_b');

    // A should own job-a, B should own job-b
    expect(managerA.hasRemoteClaim('job-a')).toBe(false);
    expect(managerA.hasRemoteClaim('job-b')).toBe(true);
    expect(managerA.getClaim('job-a')!.machineId).toBe('m_workstation');
    expect(managerA.getClaim('job-b')!.machineId).toBe('m_dawn_macbook');

    managerA.destroy();
    busA.destroy();
  });

  it('claim after expiry: partition recovery', async () => {
    const busA = createBus(tmpDir, 'm_workstation');
    const managerA = createManager(busA, 'm_workstation', tmpDir);

    // B had claimed it but their claim expired (crash/partition)
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    simulateRemoteClaim(busA, 'm_dawn_macbook', 'daily-sync', 'claim_old', pastExpiry);

    // A can now claim it
    const claimId = await managerA.tryClaim('daily-sync');
    expect(claimId).toBeTruthy();
    expect(managerA.getClaim('daily-sync')!.machineId).toBe('m_workstation');

    managerA.destroy();
    busA.destroy();
  });
});

// ── 9. Edge Cases ───────────────────────────────────────────────────

describe('edge cases', () => {
  let tmpDir: string;
  let bus: AgentBus;
  let manager: JobClaimManager;

  beforeEach(() => {
    tmpDir = createTempDir();
    bus = createBus(tmpDir, 'm_workstation');
    manager = createManager(bus, 'm_workstation', tmpDir);
  });

  afterEach(() => {
    manager.destroy();
    bus.destroy();
    cleanup(tmpDir);
  });

  it('completeClaim on unknown job is no-op', async () => {
    await manager.completeClaim('nonexistent', 'success');
    // Should not throw
    expect(manager.getAllClaims()).toHaveLength(0);
  });

  it('getClaim on unknown job returns undefined', () => {
    expect(manager.getClaim('nonexistent')).toBeUndefined();
  });

  it('destroy is idempotent', () => {
    manager.destroy();
    manager.destroy(); // Should not throw
  });

  it('destroy saves current state', async () => {
    await manager.tryClaim('daily-sync');
    manager.destroy();

    const filePath = path.join(tmpDir, 'state', 'job-claims.json');
    expect(fs.existsSync(filePath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(content).toHaveLength(1);
  });

  it('handles work-announcement with missing fields gracefully', () => {
    // Simulate a malformed message
    const msg: AgentMessage = {
      id: 'msg_bad',
      type: 'work-announcement',
      from: 'm_other',
      to: '*',
      timestamp: new Date().toISOString(),
      ttlMs: 0,
      payload: { /* missing claimId and jobSlug */ } as any,
      status: 'delivered',
    };
    bus.processIncoming([msg]);

    // Should not crash, should not create a claim
    expect(manager.getAllClaims()).toHaveLength(0);
  });

  it('handles work-complete with missing fields gracefully', () => {
    const msg: AgentMessage = {
      id: 'msg_bad',
      type: 'work-complete',
      from: 'm_other',
      to: '*',
      timestamp: new Date().toISOString(),
      ttlMs: 0,
      payload: {} as any,
      status: 'delivered',
    };
    bus.processIncoming([msg]);

    // Should not crash
    expect(manager.getAllClaims()).toHaveLength(0);
  });

  it('empty state dir creates required directories', () => {
    const freshDir = createTempDir();
    const freshBus = createBus(freshDir, 'm_test');
    const freshManager = createManager(freshBus, 'm_test', freshDir);

    expect(fs.existsSync(path.join(freshDir, 'state'))).toBe(true);

    freshManager.destroy();
    freshBus.destroy();
    cleanup(freshDir);
  });
});

// ── 10. Multi-Machine Simulation ────────────────────────────────────

describe('multi-machine simulation', () => {
  let tmpDirA: string;
  let tmpDirB: string;

  beforeEach(() => {
    tmpDirA = createTempDir();
    tmpDirB = createTempDir();
  });

  afterEach(() => {
    cleanup(tmpDirA);
    cleanup(tmpDirB);
  });

  it('full claim lifecycle across two machines', async () => {
    // Machine A: workstation
    const busA = createBus(tmpDirA, 'm_workstation');
    const managerA = createManager(busA, 'm_workstation', tmpDirA);

    // Machine B: dawn_macbook
    const busB = createBus(tmpDirB, 'm_dawn_macbook');
    const managerB = createManager(busB, 'm_dawn_macbook', tmpDirB);

    // A claims the job
    const claimId = await managerA.tryClaim('daily-sync');
    expect(claimId).toBeTruthy();

    // Simulate A's claim arriving at B
    simulateRemoteClaim(busB, 'm_workstation', 'daily-sync', claimId!);

    // B should see the remote claim and reject its own attempt
    expect(managerB.hasRemoteClaim('daily-sync')).toBe(true);
    const bClaim = await managerB.tryClaim('daily-sync');
    expect(bClaim).toBeNull();

    // A completes the job
    await managerA.completeClaim('daily-sync', 'success');

    // Simulate A's completion arriving at B
    simulateRemoteComplete(busB, 'm_workstation', 'daily-sync', claimId!);

    // B should now be able to claim it
    const newClaimId = await managerB.tryClaim('daily-sync');
    expect(newClaimId).toBeTruthy();

    managerA.destroy();
    managerB.destroy();
    busA.destroy();
    busB.destroy();
  });

  it('partition mode: both machines proceed when claims cannot propagate', async () => {
    // Machine A
    const busA = createBus(tmpDirA, 'm_workstation');
    const managerA = createManager(busA, 'm_workstation', tmpDirA);

    // Machine B (separate state dir, no message propagation)
    const busB = createBus(tmpDirB, 'm_dawn_macbook');
    const managerB = createManager(busB, 'm_dawn_macbook', tmpDirB);

    // Both claim the same job independently (partition scenario)
    const claimA = await managerA.tryClaim('daily-sync');
    const claimB = await managerB.tryClaim('daily-sync');

    // Both succeed (at-most-once per machine, but duplicated across partition)
    expect(claimA).toBeTruthy();
    expect(claimB).toBeTruthy();

    managerA.destroy();
    managerB.destroy();
    busA.destroy();
    busB.destroy();
  });
});
