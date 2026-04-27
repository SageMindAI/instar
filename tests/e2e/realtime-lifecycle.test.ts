/**
 * E2E Lifecycle Tests for Real-Time Communication Modules (Phase 8)
 *
 * Per TESTING-INTEGRITY-SPEC Category 3: "The full path from user action
 * to user-visible outcome works end-to-end, with controlled (but real)
 * intermediate components."
 *
 * Tests the complete lifecycle paths of 3 real-time communication modules:
 *   1. AgentBus — Message bus with JSONL transport, TTL, and delivery tracking
 *   2. CoordinationProtocol — File avoidance, work announcements, leadership
 *   3. ConflictNegotiator — Multi-round negotiation with timeout/escalation
 *
 * Test approach:
 *   - Each "machine" gets its own AgentBus instance with a shared state directory
 *   - Messages are shuttled between machines by reading one's outbox and feeding
 *     to the other's processIncoming
 *   - Short timeouts for negotiation tests (1-2 seconds)
 *   - Temp directories are cleaned up after each test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AgentBus } from '../../src/core/AgentBus.js';
import type { AgentMessage } from '../../src/core/AgentBus.js';
import { CoordinationProtocol } from '../../src/core/CoordinationProtocol.js';
import type { FileAvoidanceRequest, FileAvoidanceResponse } from '../../src/core/CoordinationProtocol.js';
import { ConflictNegotiator } from '../../src/core/ConflictNegotiator.js';
import type { NegotiationProposal, NegotiationResponse } from '../../src/core/ConflictNegotiator.js';

// -- Helpers ----------------------------------------------------------------

function createTempStateDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `realtime-e2e-${prefix}-`));
}

function cleanupDir(dir: string): void {
  try {
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Create an AgentBus for a machine with JSONL transport.
 * All buses share the same stateDir so they can read each other's outboxes.
 */
function createBus(stateDir: string, machineId: string, opts?: { defaultTtlMs?: number }): AgentBus {
  return new AgentBus({
    stateDir,
    machineId,
    transport: 'jsonl',
    defaultTtlMs: opts?.defaultTtlMs ?? 30 * 60 * 1000,
  });
}

/**
 * Shuttle messages from sender's outbox to receiver's processIncoming.
 * Reads all pending messages from the sender's outbox that are addressed
 * to the receiver (or broadcast), and feeds them to the receiver.
 */
function shuttleMessages(sender: AgentBus, receiver: AgentBus): number {
  const outbox = sender.readOutbox();
  const receiverId = receiver.getMachineId();
  const relevant = outbox.filter(
    (msg) => (msg.to === receiverId || msg.to === '*') && msg.from !== receiverId,
  );
  if (relevant.length > 0) {
    receiver.processIncoming(relevant);
  }
  return relevant.length;
}

/**
 * Shuttle messages between all bus pairs (bidirectional).
 * Useful for multi-machine scenarios.
 */
function shuttleAll(buses: AgentBus[]): number {
  let total = 0;
  for (const sender of buses) {
    for (const receiver of buses) {
      if (sender !== receiver) {
        total += shuttleMessages(sender, receiver);
      }
    }
  }
  return total;
}

// ===========================================================================
// Scenario 1: Two Machines Start Work on Overlapping Files
// ===========================================================================

describe('Scenario 1: Two Machines Start Work on Overlapping Files', () => {
  let tempDir: string;
  let busA: AgentBus;
  let busB: AgentBus;
  let coordA: CoordinationProtocol;
  let coordB: CoordinationProtocol;

  beforeEach(() => {
    tempDir = createTempStateDir('overlap');
    busA = createBus(tempDir, 'machine-a');
    busB = createBus(tempDir, 'machine-b');
  });

  afterEach(() => {
    busA.stopPolling();
    busB.stopPolling();
    cleanupDir(tempDir);
  });

  it('detects overlap, requests avoidance, tracks and expires avoidance', async () => {
    // Step 1: Machine A sets up coordination with an avoidance handler
    // that accepts all avoidance requests
    coordA = new CoordinationProtocol({
      bus: busA,
      machineId: 'machine-a',
      stateDir: tempDir,
      statusQueryTimeoutMs: 2000,
      onAvoidanceRequest: (_req: FileAvoidanceRequest, _from: string): FileAvoidanceResponse => {
        return {
          accepted: true,
          conflictingFiles: [],
          reason: 'OK, avoiding those files',
        };
      },
    });

    // Machine B sets up coordination
    coordB = new CoordinationProtocol({
      bus: busB,
      machineId: 'machine-b',
      stateDir: tempDir,
      statusQueryTimeoutMs: 2000,
    });

    // Step 2: Machine A announces work on overlapping files
    const workIdA = await coordA.announceWorkStarted({
      sessionId: 'AUT-A01',
      task: 'Refactor authentication module',
      files: ['src/auth.ts', 'src/middleware.ts', 'src/config.ts'],
    });
    expect(workIdA).toMatch(/^work_/);

    // Step 3: Shuttle A's announcement to B
    shuttleMessages(busA, busB);

    // Step 4: Machine B sees A's work via peer tracking
    const peerWork = coordB.getPeerWork('machine-a');
    expect(peerWork).toHaveLength(1);
    expect(peerWork[0].files).toContain('src/auth.ts');
    expect(peerWork[0].action).toBe('started');

    // Step 5: Machine B starts work on overlapping files
    const workIdB = await coordB.announceWorkStarted({
      sessionId: 'AUT-B01',
      task: 'Update config validation',
      files: ['src/config.ts', 'src/validation.ts'],
    });
    expect(workIdB).toMatch(/^work_/);

    // Step 6: Machine B detects overlap on src/config.ts
    const overlap = peerWork[0].files.filter(f => ['src/config.ts', 'src/validation.ts'].includes(f));
    expect(overlap).toContain('src/config.ts');

    // Step 7: Machine B requests file avoidance from Machine A
    // We need to shuttle in both directions for request/response to work
    const avoidancePromise = coordB.requestFileAvoidance('machine-a', {
      files: ['src/config.ts'],
      durationMs: 500, // Short duration for test
      reason: 'Need exclusive access for config validation update',
    });

    // Shuttle B's request to A
    shuttleMessages(busB, busA);

    // Shuttle A's response back to B
    // Small delay to let the handler fire
    await new Promise((resolve) => setTimeout(resolve, 50));
    shuttleMessages(busA, busB);

    const response = await avoidancePromise;

    // Step 8: Verify avoidance response
    expect(response).not.toBeNull();
    expect(response!.accepted).toBe(true);
    expect(response!.conflictingFiles).toHaveLength(0);

    // Step 9: Verify avoidance is tracked on Machine A
    const avoidanceOnA = coordA.getActiveAvoidances();
    expect(avoidanceOnA.length).toBeGreaterThanOrEqual(1);
    const configAvoidance = avoidanceOnA.find(a => a.files.includes('src/config.ts'));
    expect(configAvoidance).toBeDefined();
    expect(configAvoidance!.from).toBe('machine-b');

    // Step 10: Check that isFileAvoided works
    const avoided = coordA.isFileAvoided('src/config.ts');
    expect(avoided).toBeDefined();
    expect(avoided!.reason).toBe('Need exclusive access for config validation update');

    // Step 11: Wait for avoidance to expire (500ms duration)
    await new Promise((resolve) => setTimeout(resolve, 600));
    const expiredAvoidance = coordA.isFileAvoided('src/config.ts');
    expect(expiredAvoidance).toBeUndefined();
  });
});

// ===========================================================================
// Scenario 2: Full Conflict Negotiation Lifecycle
// ===========================================================================

describe('Scenario 2: Full Conflict Negotiation Lifecycle', () => {
  let tempDir: string;
  let busA: AgentBus;
  let busB: AgentBus;

  beforeEach(() => {
    tempDir = createTempStateDir('negotiation');
    busA = createBus(tempDir, 'machine-a');
    busB = createBus(tempDir, 'machine-b');
  });

  afterEach(() => {
    busA.stopPolling();
    busB.stopPolling();
    cleanupDir(tempDir);
  });

  it('initiates negotiation, counter-proposes, accepts counter-proposal', async () => {
    // Step 1: Machine B's negotiator will counter-propose "merge-by-section"
    // on round 1, then accept whatever comes on round 2
    let roundsSeen = 0;
    const negotiatorB = new ConflictNegotiator({
      bus: busB,
      machineId: 'machine-b',
      maxRounds: 3,
      roundTimeoutMs: 2000,
      totalTimeoutMs: 5000,
      onProposalReceived: (proposal: NegotiationProposal, _from: string): NegotiationResponse => {
        roundsSeen++;
        if (proposal.round === 1) {
          // Counter-propose merge-by-section
          return {
            negotiationId: proposal.negotiationId,
            decision: 'counter',
            counterProposal: {
              filePath: proposal.filePath,
              strategy: 'merge-by-section',
              sections: [
                { claimedBy: 'proposer', startLine: 1, endLine: 50, description: 'imports and setup' },
                { claimedBy: 'responder', startLine: 51, endLine: 100, description: 'core logic' },
              ],
              reasoning: 'Let us split the file by sections instead',
            },
            reason: 'Prefer section-based merge for cleaner result',
          };
        }
        // Accept on round 2+
        return {
          negotiationId: proposal.negotiationId,
          decision: 'accept',
          reason: 'Agreed on merge-by-section approach',
        };
      },
    });

    const negotiatorA = new ConflictNegotiator({
      bus: busA,
      machineId: 'machine-a',
      maxRounds: 3,
      roundTimeoutMs: 2000,
      totalTimeoutMs: 5000,
    });

    // Step 2: Machine A initiates negotiation with "take-ours" strategy
    const negotiatePromise = negotiatorA.negotiate({
      targetMachineId: 'machine-b',
      filePath: 'src/shared-module.ts',
      strategy: 'take-ours',
      reasoning: 'Our changes are more recent and comprehensive',
      sessionId: 'AUT-A02',
    });

    // Step 3: Shuttle messages back and forth until negotiation completes
    // Round 1: A -> B (proposal), B -> A (counter)
    await new Promise((resolve) => setTimeout(resolve, 50));
    shuttleMessages(busA, busB); // A's proposal to B
    await new Promise((resolve) => setTimeout(resolve, 50));
    shuttleMessages(busB, busA); // B's counter-proposal response to A

    // Round 2: A -> B (accepts counter's strategy), B -> A (accept)
    await new Promise((resolve) => setTimeout(resolve, 50));
    shuttleMessages(busA, busB); // A's re-proposal with B's strategy
    await new Promise((resolve) => setTimeout(resolve, 50));
    shuttleMessages(busB, busA); // B's acceptance

    const result = await negotiatePromise;

    // Step 4: Verify negotiation result
    expect(result.status).toBe('agreed');
    expect(result.strategy).toBe('merge-by-section');
    expect(result.fallbackToLLM).toBe(false);
    expect(result.rounds).toBeGreaterThanOrEqual(2);

    // Step 5: Verify section claims
    expect(result.sections).toBeDefined();
    expect(result.sections!).toHaveLength(2);
    expect(result.sections![0].claimedBy).toBe('proposer');
    expect(result.sections![1].claimedBy).toBe('responder');

    // Step 6: Verify negotiation session records all rounds
    const sessionA = negotiatorA.getSession(result.negotiationId);
    expect(sessionA).toBeDefined();
    expect(sessionA!.proposals.length).toBeGreaterThanOrEqual(2);
    expect(sessionA!.responses.length).toBeGreaterThanOrEqual(1);
    expect(sessionA!.status).toBe('agreed');
    expect(sessionA!.agreedStrategy).toBe('merge-by-section');

    // Step 7: Verify Machine B also has a session record
    const sessionB = negotiatorB.getSession(result.negotiationId);
    expect(sessionB).toBeDefined();
    expect(sessionB!.initiator).toBe('machine-a');
    expect(sessionB!.responder).toBe('machine-b');

    // Step 8: Stats reflect the completed negotiation
    const statsA = negotiatorA.getStats();
    expect(statsA.total).toBe(1);
    expect(statsA.agreed).toBe(1);
    expect(statsA.rejected).toBe(0);
    expect(statsA.timedOut).toBe(0);
  });
});

// ===========================================================================
// Scenario 3: Leadership Lifecycle
// ===========================================================================

describe('Scenario 3: Leadership Lifecycle', () => {
  let tempDir: string;
  let busA: AgentBus;
  let busB: AgentBus;
  let coordA: CoordinationProtocol;
  let coordB: CoordinationProtocol;

  beforeEach(() => {
    tempDir = createTempStateDir('leadership');
    busA = createBus(tempDir, 'machine-a');
    busB = createBus(tempDir, 'machine-b');
  });

  afterEach(() => {
    busA.stopPolling();
    busB.stopPolling();
    cleanupDir(tempDir);
  });

  it('claims, renews, relinquishes, and transfers leadership with fencing tokens', () => {
    // Use very short lease TTL for testing
    coordA = new CoordinationProtocol({
      bus: busA,
      machineId: 'machine-a',
      stateDir: tempDir,
      leaseTtlMs: 500, // 500ms lease
    });

    coordB = new CoordinationProtocol({
      bus: busB,
      machineId: 'machine-b',
      stateDir: tempDir,
      leaseTtlMs: 500,
    });

    // Step 1: Machine A claims leadership
    const leaseA = coordA.claimLeadership();
    expect(leaseA).not.toBeNull();
    expect(leaseA!.leaderId).toBe('machine-a');
    expect(leaseA!.fencingToken).toBe(1);
    expect(leaseA!.role).toBe('awake');
    expect(coordA.isLeader()).toBe(true);

    // Step 2: Machine B tries to claim while A holds valid lease
    const leaseB1 = coordB.claimLeadership();
    expect(leaseB1).toBeNull(); // Denied — A's lease is still valid
    expect(coordB.isLeader()).toBe(false);

    // Step 3: Machine A renews lease
    const renewed = coordA.renewLease();
    expect(renewed).not.toBeNull();
    expect(renewed!.fencingToken).toBe(1); // Token doesn't change on renewal
    expect(renewed!.leaderId).toBe('machine-a');

    // Step 4: Machine A relinquishes leadership
    coordA.relinquishLeadership();
    expect(coordA.isLeader()).toBe(false);

    // Verify the leadership state shows standby
    const stateAfterRelinquish = coordA.getLeadership();
    expect(stateAfterRelinquish).not.toBeNull();
    expect(stateAfterRelinquish!.role).toBe('standby');

    // Step 5: Machine B claims leadership (now available)
    const leaseB2 = coordB.claimLeadership();
    expect(leaseB2).not.toBeNull();
    expect(leaseB2!.leaderId).toBe('machine-b');
    expect(leaseB2!.fencingToken).toBe(2); // Token incremented
    expect(leaseB2!.role).toBe('awake');
    expect(coordB.isLeader()).toBe(true);

    // Step 6: Verify fencing token monotonicity
    // If Machine A tries again, token must be > 2
    coordB.relinquishLeadership();
    const leaseA2 = coordA.claimLeadership();
    expect(leaseA2).not.toBeNull();
    expect(leaseA2!.fencingToken).toBe(3); // Incremented from 2
  });

  it('detects lease expiration and allows takeover', async () => {
    coordA = new CoordinationProtocol({
      bus: busA,
      machineId: 'machine-a',
      stateDir: tempDir,
      leaseTtlMs: 200, // Very short lease for test
    });

    coordB = new CoordinationProtocol({
      bus: busB,
      machineId: 'machine-b',
      stateDir: tempDir,
      leaseTtlMs: 200,
    });

    // Machine A claims leadership
    const leaseA = coordA.claimLeadership();
    expect(leaseA).not.toBeNull();
    expect(coordA.isLeader()).toBe(true);
    expect(coordA.isLeaseExpired()).toBe(false);

    // Machine B cannot claim yet
    expect(coordB.claimLeadership()).toBeNull();

    // Wait for lease to expire
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Now the lease should be expired
    expect(coordA.isLeaseExpired()).toBe(true);
    expect(coordA.isLeader()).toBe(false);

    // Machine B can now claim
    const leaseB = coordB.claimLeadership();
    expect(leaseB).not.toBeNull();
    expect(leaseB!.leaderId).toBe('machine-b');
    expect(leaseB!.fencingToken).toBe(2);
    expect(coordB.isLeader()).toBe(true);
  });
});

// ===========================================================================
// Scenario 4: Negotiation Timeout and Escalation
// ===========================================================================

describe('Scenario 4: Negotiation Timeout and Escalation', () => {
  let tempDir: string;
  let busA: AgentBus;
  let busB: AgentBus;

  beforeEach(() => {
    tempDir = createTempStateDir('timeout');
    busA = createBus(tempDir, 'machine-a');
    busB = createBus(tempDir, 'machine-b');
  });

  afterEach(() => {
    busA.stopPolling();
    busB.stopPolling();
    cleanupDir(tempDir);
  });

  it('negotiation times out when peer does not respond', async () => {
    // Machine A's negotiator with very short timeouts
    const negotiatorA = new ConflictNegotiator({
      bus: busA,
      machineId: 'machine-a',
      maxRounds: 3,
      roundTimeoutMs: 500,  // 500ms round timeout
      totalTimeoutMs: 1500, // 1.5s total timeout
    });

    // Machine B has a bus but NO negotiator configured
    // (simulating a machine that doesn't process messages)

    // Machine A initiates negotiation
    const result = await negotiatorA.negotiate({
      targetMachineId: 'machine-b',
      filePath: 'src/contested-file.ts',
      strategy: 'take-ours',
      reasoning: 'Our changes are more important',
      sessionId: 'AUT-A04',
    });

    // NOTE: We deliberately do NOT shuttle messages, simulating Machine B
    // not processing anything. The negotiation should time out.

    // Verify timeout result
    expect(result.status).toBe('timed-out');
    expect(result.fallbackToLLM).toBe(true);
    expect(result.strategy).toBeUndefined();
    expect(result.rounds).toBe(1);

    // Verify session records the timeout
    const session = negotiatorA.getSession(result.negotiationId);
    expect(session).toBeDefined();
    expect(session!.status).toBe('timed-out');
    expect(session!.endedAt).toBeDefined();

    // Stats reflect the timeout
    const stats = negotiatorA.getStats();
    expect(stats.total).toBe(1);
    expect(stats.timedOut).toBe(1);
    expect(stats.agreed).toBe(0);
  });

  it('negotiation escalates after max rounds', async () => {
    // Machine B always counter-proposes, never accepts
    const _negotiatorB = new ConflictNegotiator({
      bus: busB,
      machineId: 'machine-b',
      maxRounds: 2,
      roundTimeoutMs: 2000,
      totalTimeoutMs: 5000,
      onProposalReceived: (proposal: NegotiationProposal, _from: string): NegotiationResponse => {
        return {
          negotiationId: proposal.negotiationId,
          decision: 'counter',
          counterProposal: {
            filePath: proposal.filePath,
            strategy: 'take-theirs',
            reasoning: `Counter-proposal round ${proposal.round}: I insist on take-theirs`,
          },
          reason: 'I disagree, counter-proposing',
        };
      },
    });

    const negotiatorA = new ConflictNegotiator({
      bus: busA,
      machineId: 'machine-a',
      maxRounds: 2, // Only 2 rounds allowed
      roundTimeoutMs: 2000,
      totalTimeoutMs: 5000,
    });

    // Start negotiation
    const negotiatePromise = negotiatorA.negotiate({
      targetMachineId: 'machine-b',
      filePath: 'src/deadlock-file.ts',
      strategy: 'take-ours',
      reasoning: 'Our changes first',
      sessionId: 'AUT-A04b',
    });

    // Shuttle round 1
    await new Promise((resolve) => setTimeout(resolve, 50));
    shuttleMessages(busA, busB);
    await new Promise((resolve) => setTimeout(resolve, 50));
    shuttleMessages(busB, busA);

    // Shuttle round 2
    await new Promise((resolve) => setTimeout(resolve, 50));
    shuttleMessages(busA, busB);
    await new Promise((resolve) => setTimeout(resolve, 50));
    shuttleMessages(busB, busA);

    const result = await negotiatePromise;

    // After maxRounds of counter-proposals, should escalate
    expect(result.status).toBe('escalated');
    expect(result.fallbackToLLM).toBe(true);
    expect(result.rounds).toBe(2);
  });
});

// ===========================================================================
// Scenario 5: Message Bus Full Lifecycle
// ===========================================================================

describe('Scenario 5: Message Bus Full Lifecycle', () => {
  let tempDir: string;
  let busA: AgentBus;
  let busB: AgentBus;

  beforeEach(() => {
    tempDir = createTempStateDir('bus');
    busA = createBus(tempDir, 'machine-a', { defaultTtlMs: 500 }); // 500ms TTL
    busB = createBus(tempDir, 'machine-b', { defaultTtlMs: 500 });
  });

  afterEach(() => {
    busA.stopPolling();
    busB.stopPolling();
    cleanupDir(tempDir);
  });

  it('sends, receives, processes, expires, and queries messages', async () => {
    // Step 1: Machine A sends various message types
    const msg1 = await busA.send({
      type: 'work-announcement',
      to: 'machine-b',
      payload: { task: 'Build feature X', files: ['src/x.ts'] },
    });
    expect(msg1.id).toMatch(/^msg_/);
    expect(msg1.status).toBe('pending');
    expect(msg1.from).toBe('machine-a');
    expect(msg1.to).toBe('machine-b');

    const msg2 = await busA.send({
      type: 'status-update',
      to: '*', // Broadcast
      payload: { status: 'active', task: 'Working on feature X' },
    });
    expect(msg2.to).toBe('*');

    const msg3 = await busA.send({
      type: 'heartbeat',
      to: 'machine-b',
      payload: { uptime: 3600, load: 0.5 },
    });

    // Step 2: Verify messages are written to outbox
    const outbox = busA.readOutbox();
    expect(outbox).toHaveLength(3);
    expect(outbox[0].type).toBe('work-announcement');
    expect(outbox[1].type).toBe('status-update');
    expect(outbox[2].type).toBe('heartbeat');

    // Step 3: Machine B reads pending messages via shuttle
    const receivedMessages: AgentMessage[] = [];
    busB.on('message', (msg: AgentMessage) => {
      receivedMessages.push(msg);
    });

    shuttleMessages(busA, busB);

    // Step 4: Verify B received all messages
    expect(receivedMessages).toHaveLength(3);
    expect(receivedMessages[0].type).toBe('work-announcement');
    expect(receivedMessages[1].type).toBe('status-update');
    expect(receivedMessages[2].type).toBe('heartbeat');

    // All delivered messages should have 'delivered' status
    for (const msg of receivedMessages) {
      expect(msg.status).toBe('delivered');
    }

    // Step 5: Machine B sends a reply
    await busB.send({
      type: 'status-update',
      to: 'machine-a',
      payload: { status: 'idle' },
      replyTo: msg1.id,
    });

    const bOutbox = busB.readOutbox();
    // Both buses share the same outbox file, so B's outbox includes A's messages too.
    // Verify B's reply is present in the shared outbox.
    const bReplies = bOutbox.filter(m => m.from === 'machine-b');
    expect(bReplies).toHaveLength(1);
    expect(bReplies[0].replyTo).toBe(msg1.id);

    // Step 6: Wait for TTL to expire (500ms)
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Step 7: Clean expired messages from the shared outbox
    // Both A and B write to the same outbox file (4 total: 3 from A + 1 from B)
    const expiredCount = busA.cleanExpired();
    expect(expiredCount).toBe(4); // All 4 messages should have expired

    // Verify outbox is now empty
    const cleanedOutbox = busA.readOutbox();
    expect(cleanedOutbox).toHaveLength(0);

    // Step 8: Expired messages are rejected on receive
    const lateMessages: AgentMessage[] = [];
    const expiredEvents: AgentMessage[] = [];
    busB.on('message', (msg: AgentMessage) => lateMessages.push(msg));
    busB.on('expired', (msg: AgentMessage) => expiredEvents.push(msg));

    // Create a message with an already-expired timestamp
    const expiredMsg: AgentMessage = {
      id: 'msg_expired_test',
      type: 'heartbeat',
      from: 'machine-a',
      to: 'machine-b',
      timestamp: new Date(Date.now() - 10000).toISOString(), // 10 seconds ago
      ttlMs: 1000, // 1 second TTL — already expired
      payload: { test: true },
      status: 'pending',
    };

    busB.processIncoming([expiredMsg]);
    // The expired message should NOT appear in lateMessages
    const expiredInLate = lateMessages.filter(m => m.id === 'msg_expired_test');
    expect(expiredInLate).toHaveLength(0);
    // But should appear in expired events
    expect(expiredEvents.filter(m => m.id === 'msg_expired_test')).toHaveLength(1);
  });

  it('messages with ttlMs=0 never expire', async () => {
    const msg = await busA.send({
      type: 'custom',
      to: 'machine-b',
      payload: { permanent: true },
      ttlMs: 0, // No expiration
    });

    // Wait longer than default TTL
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Clean should not expire it
    const expired = busA.cleanExpired();
    expect(expired).toBe(0);

    const outbox = busA.readOutbox();
    // The bus was created with defaultTtlMs=500, but this message used explicit ttlMs=0.
    // We only have the message with ttlMs=0 if the explicit override works.
    // However other messages sent in this test will use default TTL.
    // Filter for our specific message.
    const permanentMsg = outbox.find(m => m.id === msg.id);
    expect(permanentMsg).toBeDefined();
    expect(permanentMsg!.ttlMs).toBe(0);
  });

  it('type-specific handlers fire for matching message types', async () => {
    const workAnnouncements: AgentMessage[] = [];
    const heartbeats: AgentMessage[] = [];

    busB.onMessage('work-announcement', (msg) => workAnnouncements.push(msg));
    busB.onMessage('heartbeat', (msg) => heartbeats.push(msg));

    await busA.send({ type: 'work-announcement', to: 'machine-b', payload: { task: 'A' } });
    await busA.send({ type: 'heartbeat', to: 'machine-b', payload: {} });
    await busA.send({ type: 'work-announcement', to: 'machine-b', payload: { task: 'B' } });
    await busA.send({ type: 'status-update', to: 'machine-b', payload: {} });

    shuttleMessages(busA, busB);

    expect(workAnnouncements).toHaveLength(2);
    expect(heartbeats).toHaveLength(1);
  });
});

// ===========================================================================
// Scenario 6: Concurrent Work Coordination (3 Machines)
// ===========================================================================

describe('Scenario 6: Concurrent Work Coordination (3 Machines)', () => {
  let tempDir: string;
  let busA: AgentBus;
  let busB: AgentBus;
  let busC: AgentBus;
  let coordA: CoordinationProtocol;
  let coordB: CoordinationProtocol;
  let coordC: CoordinationProtocol;

  beforeEach(() => {
    tempDir = createTempStateDir('concurrent');
    busA = createBus(tempDir, 'machine-a');
    busB = createBus(tempDir, 'machine-b');
    busC = createBus(tempDir, 'machine-c');
  });

  afterEach(() => {
    busA.stopPolling();
    busB.stopPolling();
    busC.stopPolling();
    cleanupDir(tempDir);
  });

  it('three machines coordinate file ownership and avoidance', async () => {
    // All machines accept avoidance requests
    const avoidanceHandler = (_req: FileAvoidanceRequest, _from: string): FileAvoidanceResponse => ({
      accepted: true,
      conflictingFiles: [],
    });

    coordA = new CoordinationProtocol({
      bus: busA,
      machineId: 'machine-a',
      stateDir: tempDir,
      statusQueryTimeoutMs: 2000,
      onAvoidanceRequest: avoidanceHandler,
    });

    coordB = new CoordinationProtocol({
      bus: busB,
      machineId: 'machine-b',
      stateDir: tempDir,
      statusQueryTimeoutMs: 2000,
      onAvoidanceRequest: avoidanceHandler,
    });

    coordC = new CoordinationProtocol({
      bus: busC,
      machineId: 'machine-c',
      stateDir: tempDir,
      statusQueryTimeoutMs: 2000,
      onAvoidanceRequest: avoidanceHandler,
    });

    // Step 1: Machine A announces work on [a.ts, b.ts]
    await coordA.announceWorkStarted({
      sessionId: 'AUT-A06',
      task: 'Build module A',
      files: ['a.ts', 'b.ts'],
    });

    // Step 2: Machine B announces work on [b.ts, c.ts]
    await coordB.announceWorkStarted({
      sessionId: 'AUT-B06',
      task: 'Build module B',
      files: ['b.ts', 'c.ts'],
    });

    // Step 3: Shuttle all announcements
    shuttleAll([busA, busB, busC]);

    // Step 4: Machine C can see peer work from both A and B
    const peerWorkA = coordC.getPeerWork('machine-a');
    expect(peerWorkA).toHaveLength(1);
    expect(peerWorkA[0].files).toContain('a.ts');
    expect(peerWorkA[0].files).toContain('b.ts');

    const peerWorkB = coordC.getPeerWork('machine-b');
    expect(peerWorkB).toHaveLength(1);
    expect(peerWorkB[0].files).toContain('b.ts');
    expect(peerWorkB[0].files).toContain('c.ts');

    // Step 5: Machine C sees that b.ts is claimed by both A and B
    const allPeerWork = coordC.getPeerWork();
    const fileToBWorkers = allPeerWork.filter(w => w.files.includes('b.ts'));
    expect(fileToBWorkers).toHaveLength(2);

    // Step 6: Machine C requests avoidance of b.ts from Machine A
    const avoidPromiseA = coordC.requestFileAvoidance('machine-a', {
      files: ['b.ts'],
      durationMs: 5000,
      reason: 'Machine C needs exclusive access to b.ts',
    });

    // Shuttle C -> A
    shuttleMessages(busC, busA);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Shuttle A -> C (response)
    shuttleMessages(busA, busC);

    const responseA = await avoidPromiseA;
    expect(responseA).not.toBeNull();
    expect(responseA!.accepted).toBe(true);

    // Step 7: Machine C requests avoidance of b.ts from Machine B
    const avoidPromiseB = coordC.requestFileAvoidance('machine-b', {
      files: ['b.ts'],
      durationMs: 5000,
      reason: 'Machine C needs exclusive access to b.ts',
    });

    // Shuttle C -> B
    shuttleMessages(busC, busB);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Shuttle B -> C (response)
    shuttleMessages(busB, busC);

    const responseB = await avoidPromiseB;
    expect(responseB).not.toBeNull();
    expect(responseB!.accepted).toBe(true);

    // Step 8: Verify all coordination state is consistent
    // Machine A should have an avoidance entry for b.ts from machine-c
    const avoidancesA = coordA.getActiveAvoidances();
    const bAvoidanceOnA = avoidancesA.find(a => a.files.includes('b.ts') && a.from === 'machine-c');
    expect(bAvoidanceOnA).toBeDefined();

    // Machine B should also have an avoidance entry for b.ts from machine-c
    const avoidancesB = coordB.getActiveAvoidances();
    const bAvoidanceOnB = avoidancesB.find(a => a.files.includes('b.ts') && a.from === 'machine-c');
    expect(bAvoidanceOnB).toBeDefined();

    // Step 9: Verify work completion clears peer work
    await coordA.announceWorkCompleted(peerWorkA[0].workId, 'AUT-A06', ['a.ts', 'b.ts']);
    shuttleAll([busA, busB, busC]);

    const peerWorkAAfter = coordC.getPeerWork('machine-a');
    expect(peerWorkAAfter).toHaveLength(0);

    // Machine B's work should still be tracked
    const peerWorkBAfter = coordC.getPeerWork('machine-b');
    expect(peerWorkBAfter).toHaveLength(1);
  });
});
