/**
 * Wiring Integrity Tests for Phase 8 (Real-Time Communication)
 *
 * Verifies that AgentBus, CoordinationProtocol, and ConflictNegotiator
 * connect correctly — types flow between modules, callbacks fire,
 * state propagates, and the system works as an integrated whole.
 *
 * Covers:
 *   - AgentBus <-> CoordinationProtocol wiring
 *   - AgentBus <-> ConflictNegotiator wiring
 *   - Two-agent simulation via shared JSONL transport
 *   - CoordinationProtocol <-> ConflictNegotiator integration
 *   - Export verification from src/index.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AgentBus } from '../../src/core/AgentBus.js';
import type { AgentMessage, AgentBusConfig } from '../../src/core/AgentBus.js';

import { CoordinationProtocol } from '../../src/core/CoordinationProtocol.js';
import type {
  FileAvoidanceRequest,
  FileAvoidanceResponse,
  WorkAnnouncement,
  CoordinationProtocolConfig,
} from '../../src/core/CoordinationProtocol.js';

import { ConflictNegotiator } from '../../src/core/ConflictNegotiator.js';
import type {
  NegotiationProposal,
  NegotiationResponse,
  ConflictNegotiatorConfig,
} from '../../src/core/ConflictNegotiator.js';

// ── Helpers ─────────────────────────────────────────────────────────

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeAgentBus(opts: {
  stateDir: string;
  machineId: string;
  transport?: 'jsonl' | 'http';
  defaultTtlMs?: number;
}): AgentBus {
  return new AgentBus({
    stateDir: opts.stateDir,
    machineId: opts.machineId,
    transport: opts.transport ?? 'jsonl',
    defaultTtlMs: opts.defaultTtlMs ?? 30 * 60 * 1000,
  });
}

// ── AgentBus <-> CoordinationProtocol Wiring ────────────────────────

describe('AgentBus <-> CoordinationProtocol wiring', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir('coord-wiring-');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('CoordinationProtocol registers handlers on AgentBus', () => {
    const bus = makeAgentBus({ stateDir: tmpDir, machineId: 'machine-a' });

    // Before creating CoordinationProtocol, the bus handler map should be empty
    // (handlers is private, so we test indirectly by verifying behavior)

    const coord = new CoordinationProtocol({
      bus,
      machineId: 'machine-a',
      stateDir: tmpDir,
    });

    // Verify the protocol instance was created and is wired
    expect(coord).toBeDefined();
    expect(coord).toBeInstanceOf(CoordinationProtocol);
    expect(coord.getMachineId()).toBe('machine-a');

    // The bus should now have handlers for at least:
    // file-avoidance-request, file-avoidance-response, work-announcement, status-update
    // We test this by sending a message and verifying the handler fires
    const workAnnouncement: WorkAnnouncement = {
      workId: 'work_test1',
      action: 'started',
      sessionId: 'AUT-100',
      task: 'Test task',
      files: ['src/index.ts'],
    };

    // Simulate receiving a work announcement from another machine
    bus.processIncoming([{
      id: 'msg_test1',
      type: 'work-announcement',
      from: 'machine-b',
      to: 'machine-a',
      timestamp: new Date().toISOString(),
      ttlMs: 60000,
      payload: workAnnouncement,
      status: 'pending',
    }]);

    // CoordinationProtocol should have tracked this peer work
    const peerWork = coord.getPeerWork('machine-b');
    expect(peerWork).toHaveLength(1);
    expect(peerWork[0].workId).toBe('work_test1');
    expect(peerWork[0].task).toBe('Test task');
  });

  it('file avoidance request through bus triggers handler and records avoidance', () => {
    const bus = makeAgentBus({ stateDir: tmpDir, machineId: 'machine-a' });
    let callbackInvoked = false;

    const coord = new CoordinationProtocol({
      bus,
      machineId: 'machine-a',
      stateDir: tmpDir,
      onAvoidanceRequest: (req, from) => {
        callbackInvoked = true;
        expect(req.files).toContain('lib/auth.ts');
        expect(from).toBe('machine-b');
        return { accepted: true, conflictingFiles: [] };
      },
    });

    const avoidReq: FileAvoidanceRequest = {
      files: ['lib/auth.ts'],
      durationMs: 600000,
      reason: 'Refactoring auth module',
    };

    bus.processIncoming([{
      id: 'msg_avoid1',
      type: 'file-avoidance-request',
      from: 'machine-b',
      to: 'machine-a',
      timestamp: new Date().toISOString(),
      ttlMs: 60000,
      payload: avoidReq,
      status: 'pending',
    }]);

    expect(callbackInvoked).toBe(true);

    // The avoidance should be recorded
    const avoidance = coord.isFileAvoided('lib/auth.ts');
    expect(avoidance).toBeDefined();
    expect(avoidance!.from).toBe('machine-b');
    expect(avoidance!.reason).toBe('Refactoring auth module');
  });

  it('work announcement through bus updates peer work tracking', () => {
    const bus = makeAgentBus({ stateDir: tmpDir, machineId: 'machine-a' });
    const announcements: WorkAnnouncement[] = [];

    const coord = new CoordinationProtocol({
      bus,
      machineId: 'machine-a',
      stateDir: tmpDir,
      onWorkAnnouncement: (announcement, from) => {
        announcements.push(announcement);
      },
    });

    // Send 'started' announcement
    bus.processIncoming([{
      id: 'msg_work1',
      type: 'work-announcement',
      from: 'machine-b',
      to: '*',
      timestamp: new Date().toISOString(),
      ttlMs: 60000,
      payload: {
        workId: 'work_alpha',
        action: 'started',
        sessionId: 'AUT-200',
        task: 'Implement feature X',
        files: ['src/feature.ts', 'src/feature.test.ts'],
      } as WorkAnnouncement,
      status: 'pending',
    }]);

    expect(announcements).toHaveLength(1);
    expect(coord.getPeerWork('machine-b')).toHaveLength(1);

    // Send 'completed' announcement for the same work ID
    bus.processIncoming([{
      id: 'msg_work2',
      type: 'work-announcement',
      from: 'machine-b',
      to: '*',
      timestamp: new Date().toISOString(),
      ttlMs: 60000,
      payload: {
        workId: 'work_alpha',
        action: 'completed',
        sessionId: 'AUT-200',
        task: '',
        files: ['src/feature.ts', 'src/feature.test.ts'],
      } as WorkAnnouncement,
      status: 'pending',
    }]);

    expect(announcements).toHaveLength(2);
    // Completed work should be removed from active tracking
    expect(coord.getPeerWork('machine-b')).toHaveLength(0);
  });

  it('status query through bus triggers response with active work', () => {
    const bus = makeAgentBus({ stateDir: tmpDir, machineId: 'machine-a' });
    const sentMessages: AgentMessage[] = [];

    bus.on('sent', (msg: AgentMessage) => {
      sentMessages.push(msg);
    });

    const coord = new CoordinationProtocol({
      bus,
      machineId: 'machine-a',
      stateDir: tmpDir,
    });

    // Simulate a status query from machine-b
    bus.processIncoming([{
      id: 'msg_status1',
      type: 'status-update',
      from: 'machine-b',
      to: 'machine-a',
      timestamp: new Date().toISOString(),
      ttlMs: 60000,
      payload: { queryType: 'active-work' },
      status: 'pending',
    }]);

    // CoordinationProtocol should have sent a response
    const statusResponses = sentMessages.filter(m =>
      m.type === 'status-update' && m.to === 'machine-b',
    );
    expect(statusResponses.length).toBeGreaterThanOrEqual(1);

    const responsePayload = statusResponses[0].payload as { machineId: string; status: string };
    expect(responsePayload.machineId).toBe('machine-a');
    expect(responsePayload.status).toBe('active');
  });

  it('leadership state persists to disk and survives re-read', () => {
    const bus = makeAgentBus({ stateDir: tmpDir, machineId: 'machine-a' });

    const coord = new CoordinationProtocol({
      bus,
      machineId: 'machine-a',
      stateDir: tmpDir,
      leaseTtlMs: 60000,
    });

    // Claim leadership
    const leadership = coord.claimLeadership();
    expect(leadership).not.toBeNull();
    expect(leadership!.leaderId).toBe('machine-a');
    expect(leadership!.fencingToken).toBe(1);
    expect(leadership!.role).toBe('awake');

    // Verify the file was written to disk
    const leadershipFile = path.join(tmpDir, 'state', 'coordination', 'leadership.json');
    expect(fs.existsSync(leadershipFile)).toBe(true);

    // Create a new CoordinationProtocol reading from the same state dir
    const bus2 = makeAgentBus({ stateDir: tmpDir, machineId: 'machine-b' });
    const coord2 = new CoordinationProtocol({
      bus: bus2,
      machineId: 'machine-b',
      stateDir: tmpDir,
    });

    // machine-b should see machine-a as leader
    const readLeadership = coord2.getLeadership();
    expect(readLeadership).not.toBeNull();
    expect(readLeadership!.leaderId).toBe('machine-a');
    expect(readLeadership!.fencingToken).toBe(1);

    // machine-b should not be able to claim leadership (lease not expired)
    const claimAttempt = coord2.claimLeadership();
    expect(claimAttempt).toBeNull();
  });
});

// ── AgentBus <-> ConflictNegotiator Wiring ──────────────────────────

describe('AgentBus <-> ConflictNegotiator wiring', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir('negotiator-wiring-');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ConflictNegotiator registers handlers on AgentBus', () => {
    const bus = makeAgentBus({ stateDir: tmpDir, machineId: 'machine-a' });

    const negotiator = new ConflictNegotiator({
      bus,
      machineId: 'machine-a',
    });

    expect(negotiator).toBeDefined();
    expect(negotiator).toBeInstanceOf(ConflictNegotiator);

    // Verify handler registration by sending a negotiation request
    // and checking that a session is created on the responder side
    const proposal: NegotiationProposal = {
      negotiationId: 'neg_test1',
      filePath: 'src/main.ts',
      strategy: 'take-ours',
      reasoning: 'My changes are more recent',
      round: 1,
    };

    bus.processIncoming([{
      id: 'msg_neg1',
      type: 'negotiation-request',
      from: 'machine-b',
      to: 'machine-a',
      timestamp: new Date().toISOString(),
      ttlMs: 60000,
      payload: proposal,
      status: 'pending',
    }]);

    // The negotiator should have created a session for this negotiation
    const session = negotiator.getSession('neg_test1');
    expect(session).toBeDefined();
    expect(session!.filePath).toBe('src/main.ts');
    expect(session!.initiator).toBe('machine-b');
    expect(session!.responder).toBe('machine-a');
  });

  it('negotiation proposal through bus triggers onProposalReceived callback and sends response', () => {
    const bus = makeAgentBus({ stateDir: tmpDir, machineId: 'machine-a' });
    const sentMessages: AgentMessage[] = [];
    let callbackInvoked = false;

    bus.on('sent', (msg: AgentMessage) => {
      sentMessages.push(msg);
    });

    const negotiator = new ConflictNegotiator({
      bus,
      machineId: 'machine-a',
      onProposalReceived: (proposal, from) => {
        callbackInvoked = true;
        expect(proposal.filePath).toBe('src/config.ts');
        expect(from).toBe('machine-b');
        return {
          negotiationId: proposal.negotiationId,
          decision: 'accept' as const,
          reason: 'Looks good to me',
        };
      },
    });

    bus.processIncoming([{
      id: 'msg_neg2',
      type: 'negotiation-request',
      from: 'machine-b',
      to: 'machine-a',
      timestamp: new Date().toISOString(),
      ttlMs: 60000,
      payload: {
        negotiationId: 'neg_test2',
        filePath: 'src/config.ts',
        strategy: 'merge-by-section',
        reasoning: 'Section-based merge is safest',
        round: 1,
      } as NegotiationProposal,
      status: 'pending',
    }]);

    expect(callbackInvoked).toBe(true);

    // A response should have been sent back
    const responses = sentMessages.filter(m =>
      m.type === 'negotiation-response' && m.to === 'machine-b',
    );
    expect(responses).toHaveLength(1);

    const respPayload = responses[0].payload as NegotiationResponse;
    expect(respPayload.decision).toBe('accept');
    expect(respPayload.reason).toBe('Looks good to me');

    // Session should be marked as agreed
    const session = negotiator.getSession('neg_test2');
    expect(session).toBeDefined();
    expect(session!.status).toBe('agreed');
  });

  it('negotiation session state tracks across multiple rounds', () => {
    const bus = makeAgentBus({ stateDir: tmpDir, machineId: 'machine-a' });

    const negotiator = new ConflictNegotiator({
      bus,
      machineId: 'machine-a',
      maxRounds: 3,
      onProposalReceived: (proposal, _from) => {
        // Counter on round 1, accept on round 2
        if (proposal.round === 1) {
          return {
            negotiationId: proposal.negotiationId,
            decision: 'counter' as const,
            counterProposal: {
              filePath: proposal.filePath,
              strategy: 'merge-by-line-range' as const,
              reasoning: 'Line-range merge is more precise',
              sections: [
                { claimedBy: 'responder' as const, startLine: 1, endLine: 50, description: 'Header section' },
                { claimedBy: 'proposer' as const, startLine: 51, endLine: 100, description: 'Body section' },
              ],
            },
            reason: 'I prefer a more precise split',
          };
        }
        return {
          negotiationId: proposal.negotiationId,
          decision: 'accept' as const,
          reason: 'This works',
        };
      },
    });

    // Round 1 proposal
    bus.processIncoming([{
      id: 'msg_round1',
      type: 'negotiation-request',
      from: 'machine-b',
      to: 'machine-a',
      timestamp: new Date().toISOString(),
      ttlMs: 60000,
      payload: {
        negotiationId: 'neg_multi',
        filePath: 'src/handler.ts',
        strategy: 'take-ours',
        reasoning: 'Initial proposal',
        round: 1,
      } as NegotiationProposal,
      status: 'pending',
    }]);

    const sessionAfterRound1 = negotiator.getSession('neg_multi');
    expect(sessionAfterRound1).toBeDefined();
    expect(sessionAfterRound1!.proposals).toHaveLength(1);
    expect(sessionAfterRound1!.responses).toHaveLength(1);
    expect(sessionAfterRound1!.responses[0].decision).toBe('counter');

    // Round 2 proposal (the counter-proposal from round 1 being sent back)
    bus.processIncoming([{
      id: 'msg_round2',
      type: 'negotiation-request',
      from: 'machine-b',
      to: 'machine-a',
      timestamp: new Date().toISOString(),
      ttlMs: 60000,
      payload: {
        negotiationId: 'neg_multi',
        filePath: 'src/handler.ts',
        strategy: 'merge-by-line-range',
        reasoning: 'Refined proposal',
        round: 2,
      } as NegotiationProposal,
      status: 'pending',
    }]);

    const sessionAfterRound2 = negotiator.getSession('neg_multi');
    expect(sessionAfterRound2!.proposals).toHaveLength(2);
    expect(sessionAfterRound2!.responses).toHaveLength(2);
    expect(sessionAfterRound2!.responses[1].decision).toBe('accept');
    expect(sessionAfterRound2!.status).toBe('agreed');
    expect(sessionAfterRound2!.currentRound).toBe(2);
  });
});

// ── Two-Agent Simulation ────────────────────────────────────────────

describe('Two-agent simulation via shared JSONL transport', () => {
  let sharedDir: string;

  beforeEach(() => {
    sharedDir = makeTmpDir('two-agent-');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(sharedDir, { recursive: true, force: true });
  });

  it('Machine A sends work-announcement, Machine B picks it up via processIncoming', () => {
    const busA = makeAgentBus({ stateDir: sharedDir, machineId: 'machine-a' });
    const busB = makeAgentBus({ stateDir: sharedDir, machineId: 'machine-b' });

    const coordB = new CoordinationProtocol({
      bus: busB,
      machineId: 'machine-b',
      stateDir: sharedDir,
    });

    // Machine A sends a work announcement (broadcast)
    busA.send({
      type: 'work-announcement',
      to: '*',
      payload: {
        workId: 'work_cross1',
        action: 'started',
        sessionId: 'AUT-300',
        task: 'Building auth module',
        files: ['src/auth.ts'],
      } as WorkAnnouncement,
    });

    // Read Machine A's outbox and feed to Machine B
    const outboxMessages = busA.readOutbox();
    expect(outboxMessages.length).toBeGreaterThan(0);

    busB.processIncoming(outboxMessages);

    // Machine B should now have peer work from Machine A
    const peerWork = coordB.getPeerWork('machine-a');
    expect(peerWork).toHaveLength(1);
    expect(peerWork[0].task).toBe('Building auth module');
    expect(peerWork[0].files).toContain('src/auth.ts');
  });

  it('Machine A sends file-avoidance-request, Machine B receives and processes', () => {
    const busA = makeAgentBus({ stateDir: sharedDir, machineId: 'machine-a' });
    const busB = makeAgentBus({ stateDir: sharedDir, machineId: 'machine-b' });

    let avoidanceReceived = false;
    const coordB = new CoordinationProtocol({
      bus: busB,
      machineId: 'machine-b',
      stateDir: sharedDir,
      onAvoidanceRequest: (req, from) => {
        avoidanceReceived = true;
        expect(from).toBe('machine-a');
        return { accepted: true, conflictingFiles: [] };
      },
    });

    // Machine A sends a file avoidance request to machine-b
    busA.send({
      type: 'file-avoidance-request',
      to: 'machine-b',
      payload: {
        files: ['lib/database.ts', 'prisma/schema.prisma'],
        durationMs: 300000,
        reason: 'Running schema migration',
      } as FileAvoidanceRequest,
    });

    // Transfer messages from A's outbox to B
    const outboxMessages = busA.readOutbox();
    busB.processIncoming(outboxMessages);

    expect(avoidanceReceived).toBe(true);

    // Machine B should have recorded the avoidance
    expect(coordB.isFileAvoided('lib/database.ts')).toBeDefined();
    expect(coordB.isFileAvoided('prisma/schema.prisma')).toBeDefined();
    expect(coordB.isFileAvoided('src/unrelated.ts')).toBeUndefined();
  });

  it('Machine A initiates negotiation, Machine B evaluates and responds', () => {
    const busA = makeAgentBus({ stateDir: sharedDir, machineId: 'machine-a' });
    const busB = makeAgentBus({ stateDir: sharedDir, machineId: 'machine-b' });

    // Set up negotiator on B that accepts proposals
    const negotiatorB = new ConflictNegotiator({
      bus: busB,
      machineId: 'machine-b',
      onProposalReceived: (proposal, from) => {
        return {
          negotiationId: proposal.negotiationId,
          decision: 'accept' as const,
          reason: 'Agreed to take-theirs strategy',
        };
      },
    });

    // Machine A sends a negotiation proposal
    const proposal: NegotiationProposal = {
      negotiationId: 'neg_cross1',
      filePath: 'src/shared.ts',
      strategy: 'take-theirs',
      reasoning: 'Your changes are more comprehensive',
      round: 1,
    };

    busA.send({
      type: 'negotiation-request',
      to: 'machine-b',
      payload: proposal,
    });

    // Transfer from A to B
    const outboxMessages = busA.readOutbox();
    busB.processIncoming(outboxMessages);

    // Machine B should have processed and responded
    const session = negotiatorB.getSession('neg_cross1');
    expect(session).toBeDefined();
    expect(session!.status).toBe('agreed');
    expect(session!.agreedStrategy).toBe('take-theirs');

    // Machine B should have sent a response back
    const bOutbox = busB.readOutbox();
    const responseMsg = bOutbox.find(m =>
      m.type === 'negotiation-response' && m.to === 'machine-a',
    );
    expect(responseMsg).toBeDefined();

    const respPayload = responseMsg!.payload as NegotiationResponse;
    expect(respPayload.decision).toBe('accept');
  });

  it('broadcast messages are received by peer but not by sender', () => {
    const busA = makeAgentBus({ stateDir: sharedDir, machineId: 'machine-a' });
    const busB = makeAgentBus({ stateDir: sharedDir, machineId: 'machine-b' });

    const receivedByB: AgentMessage[] = [];
    const receivedByA: AgentMessage[] = [];

    busB.on('message', (msg: AgentMessage) => receivedByB.push(msg));
    busA.on('message', (msg: AgentMessage) => receivedByA.push(msg));

    // Machine A broadcasts
    busA.send({
      type: 'heartbeat',
      to: '*',
      payload: { alive: true },
    });

    const outboxMessages = busA.readOutbox();

    // Feed to both — A should skip its own messages, B should receive
    busA.processIncoming(outboxMessages);
    busB.processIncoming(outboxMessages);

    expect(receivedByB).toHaveLength(1);
    expect(receivedByA).toHaveLength(0); // self-sent broadcasts are skipped
  });

  it('expired messages are not delivered', () => {
    const busA = makeAgentBus({ stateDir: sharedDir, machineId: 'machine-a' });
    const busB = makeAgentBus({ stateDir: sharedDir, machineId: 'machine-b' });

    const receivedByB: AgentMessage[] = [];
    const expiredByB: AgentMessage[] = [];

    busB.on('message', (msg: AgentMessage) => receivedByB.push(msg));
    busB.on('expired', (msg: AgentMessage) => expiredByB.push(msg));

    // Create a message with a timestamp in the past and short TTL
    const expiredMessage: AgentMessage = {
      id: 'msg_expired1',
      type: 'heartbeat',
      from: 'machine-a',
      to: 'machine-b',
      timestamp: new Date(Date.now() - 120000).toISOString(), // 2 minutes ago
      ttlMs: 60000, // 1 minute TTL — already expired
      payload: { alive: true },
      status: 'pending',
    };

    busB.processIncoming([expiredMessage]);

    expect(receivedByB).toHaveLength(0);
    expect(expiredByB).toHaveLength(1);
    expect(expiredByB[0].id).toBe('msg_expired1');
  });
});

// ── CoordinationProtocol <-> ConflictNegotiator Integration ─────────

describe('CoordinationProtocol <-> ConflictNegotiator integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir('coord-neg-integration-');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('agent detects file overlap via CoordinationProtocol, then initiates negotiation via ConflictNegotiator', () => {
    const busA = makeAgentBus({ stateDir: tmpDir, machineId: 'machine-a' });
    const busB = makeAgentBus({ stateDir: tmpDir, machineId: 'machine-b' });

    // Set up coordination on Machine A
    const coordA = new CoordinationProtocol({
      bus: busA,
      machineId: 'machine-a',
      stateDir: tmpDir,
    });

    // Set up negotiator on Machine B (will auto-accept)
    const negotiatorB = new ConflictNegotiator({
      bus: busB,
      machineId: 'machine-b',
      onProposalReceived: (proposal, from) => ({
        negotiationId: proposal.negotiationId,
        decision: 'accept' as const,
        reason: 'Accepted the merge strategy',
      }),
    });

    // Machine B announces work on a file
    const workAnnouncement: WorkAnnouncement = {
      workId: 'work_overlap1',
      action: 'started',
      sessionId: 'AUT-400',
      task: 'Refactoring utils',
      files: ['src/utils.ts', 'src/helpers.ts'],
    };

    busB.send({
      type: 'work-announcement',
      to: '*',
      payload: workAnnouncement,
    });

    // Transfer to Machine A
    const bOutbox = busB.readOutbox();
    busA.processIncoming(bOutbox);

    // Machine A should now see Machine B's work
    const peerWork = coordA.getPeerWork('machine-b');
    expect(peerWork).toHaveLength(1);

    // Machine A detects overlap: it also wants to work on src/utils.ts
    const overlappingFiles = peerWork[0].files.filter(f => f === 'src/utils.ts');
    expect(overlappingFiles).toHaveLength(1);

    // Machine A initiates negotiation about the overlapping file
    // (We simulate the negotiation request/response cycle manually)
    const proposal: NegotiationProposal = {
      negotiationId: 'neg_overlap1',
      filePath: 'src/utils.ts',
      strategy: 'merge-by-section',
      reasoning: 'We can split by function boundaries',
      round: 1,
      sections: [
        { claimedBy: 'proposer', startLine: 1, endLine: 30, description: 'Import section' },
        { claimedBy: 'responder', startLine: 31, endLine: 100, description: 'Utils functions' },
      ],
    };

    busA.send({
      type: 'negotiation-request',
      to: 'machine-b',
      payload: proposal,
    });

    // Transfer to Machine B
    const aOutbox = busA.readOutbox();
    // Filter to only the negotiation message (outbox may have other messages)
    const negMessages = aOutbox.filter(m => m.type === 'negotiation-request');
    busB.processIncoming(negMessages);

    // Machine B should have processed and agreed
    const session = negotiatorB.getSession('neg_overlap1');
    expect(session).toBeDefined();
    expect(session!.status).toBe('agreed');
    expect(session!.agreedStrategy).toBe('merge-by-section');
    expect(session!.agreedSections).toHaveLength(2);
  });

  it('negotiation result feeds back into coordination state', () => {
    const busA = makeAgentBus({ stateDir: tmpDir, machineId: 'machine-a' });

    const coordA = new CoordinationProtocol({
      bus: busA,
      machineId: 'machine-a',
      stateDir: tmpDir,
    });

    const negotiatorA = new ConflictNegotiator({
      bus: busA,
      machineId: 'machine-a',
    });

    // After a negotiation concludes, Machine A can record an avoidance
    // based on the agreed sections
    const negotiationResult = {
      negotiationId: 'neg_result1',
      status: 'agreed' as const,
      strategy: 'merge-by-section' as const,
      sections: [
        { claimedBy: 'responder' as const, startLine: 1, endLine: 50, description: 'Their section' },
      ],
    };

    // Based on the negotiation result, Machine A records a self-avoidance
    // for the sections claimed by the responder
    if (negotiationResult.status === 'agreed' && negotiationResult.sections) {
      const responderSections = negotiationResult.sections.filter(s => s.claimedBy === 'responder');
      if (responderSections.length > 0) {
        // Machine A should avoid the file for the negotiated duration
        // We verify coordination protocol can track avoidances from negotiation outcomes
        busA.processIncoming([{
          id: 'msg_post_neg',
          type: 'file-avoidance-request',
          from: 'machine-b',
          to: 'machine-a',
          timestamp: new Date().toISOString(),
          ttlMs: 60000,
          payload: {
            files: ['src/utils.ts'],
            durationMs: 600000,
            reason: 'Negotiated: responder owns lines 1-50',
          } as FileAvoidanceRequest,
          status: 'pending',
        }]);
      }
    }

    // Verify the avoidance is tracked
    const avoidance = coordA.isFileAvoided('src/utils.ts');
    expect(avoidance).toBeDefined();
    expect(avoidance!.reason).toContain('Negotiated');
  });
});

// ── Export Verification ─────────────────────────────────────────────

describe('Phase 8 export verification', () => {
  it('AgentBus class is exported from index', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.AgentBus).toBeDefined();
    expect(typeof mod.AgentBus).toBe('function');
  });

  it('CoordinationProtocol class is exported from index', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.CoordinationProtocol).toBeDefined();
    expect(typeof mod.CoordinationProtocol).toBe('function');
  });

  it('ConflictNegotiator class is exported from index', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.ConflictNegotiator).toBeDefined();
    expect(typeof mod.ConflictNegotiator).toBe('function');
  });

  it('AgentBus can be instantiated via index export', async () => {
    const mod = await import('../../src/index.js');
    const tmpDir = makeTmpDir('export-verify-');
    try {
      const bus = new mod.AgentBus({
        stateDir: tmpDir,
        machineId: 'export-test',
        transport: 'jsonl' as const,
      });
      expect(bus).toBeInstanceOf(mod.AgentBus);
      expect(bus.getMachineId()).toBe('export-test');
    } finally {
      // safe-git-allow: incremental-migration
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('CoordinationProtocol can be instantiated via index export', async () => {
    const mod = await import('../../src/index.js');
    const tmpDir = makeTmpDir('export-verify-coord-');
    try {
      const bus = new mod.AgentBus({
        stateDir: tmpDir,
        machineId: 'export-test',
        transport: 'jsonl' as const,
      });
      const coord = new mod.CoordinationProtocol({
        bus,
        machineId: 'export-test',
        stateDir: tmpDir,
      });
      expect(coord).toBeInstanceOf(mod.CoordinationProtocol);
    } finally {
      // safe-git-allow: incremental-migration
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('ConflictNegotiator can be instantiated via index export', async () => {
    const mod = await import('../../src/index.js');
    const tmpDir = makeTmpDir('export-verify-neg-');
    try {
      const bus = new mod.AgentBus({
        stateDir: tmpDir,
        machineId: 'export-test',
        transport: 'jsonl' as const,
      });
      const neg = new mod.ConflictNegotiator({
        bus,
        machineId: 'export-test',
      });
      expect(neg).toBeInstanceOf(mod.ConflictNegotiator);
    } finally {
      // safe-git-allow: incremental-migration
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
