/**
 * Unit tests for ConflictNegotiator — pre-merge conflict negotiation.
 *
 * Tests session creation and tracking, proposal acceptance, rejection,
 * counter-proposal flow, timeout handling, max rounds escalation,
 * and statistics.
 *
 * Uses a real AgentBus in JSONL mode for the dependency.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentBus } from '../../src/core/AgentBus.js';
import { ConflictNegotiator } from '../../src/core/ConflictNegotiator.js';
import type {
  NegotiationProposal,
  NegotiationResponse,
  NegotiationSession,
  ConflictNegotiatorConfig,
} from '../../src/core/ConflictNegotiator.js';

/**
 * Create a pair of AgentBus + ConflictNegotiator instances for an initiator and responder.
 * The responder's bus processes incoming messages, so the onProposalReceived callback fires.
 */
function makeNegotiatorPair(
  tmpDir: string,
  opts: {
    maxRounds?: number;
    roundTimeoutMs?: number;
    totalTimeoutMs?: number;
    responderCallback?: (proposal: NegotiationProposal, from: string) => NegotiationResponse;
  } = {},
) {
  const stateDir = path.join(tmpDir, '.instar');

  const busA = new AgentBus({
    stateDir,
    machineId: 'machine-a',
    transport: 'jsonl',
    defaultTtlMs: 60000,
  });

  const busB = new AgentBus({
    stateDir,
    machineId: 'machine-b',
    transport: 'jsonl',
    defaultTtlMs: 60000,
  });

  const negotiatorA = new ConflictNegotiator({
    bus: busA,
    machineId: 'machine-a',
    maxRounds: opts.maxRounds ?? 3,
    roundTimeoutMs: opts.roundTimeoutMs ?? 2000,
    totalTimeoutMs: opts.totalTimeoutMs ?? 10000,
  });

  const negotiatorB = new ConflictNegotiator({
    bus: busB,
    machineId: 'machine-b',
    maxRounds: opts.maxRounds ?? 3,
    roundTimeoutMs: opts.roundTimeoutMs ?? 2000,
    totalTimeoutMs: opts.totalTimeoutMs ?? 10000,
    onProposalReceived: opts.responderCallback,
  });

  /**
   * Bridge: when A sends to B, deliver to B's bus processIncoming.
   * This simulates the transport layer.
   */
  function deliverAtoB() {
    const outbox = busA.readOutbox();
    // Filter for messages to machine-b
    const forB = outbox.filter(m => m.to === 'machine-b' || m.to === '*');
    if (forB.length > 0) {
      busB.processIncoming(forB);
    }
  }

  function deliverBtoA() {
    const outbox = busB.readOutbox();
    // Filter for messages to machine-a
    const forA = outbox.filter(m => m.to === 'machine-a' || m.to === '*');
    if (forA.length > 0) {
      busA.processIncoming(forA);
    }
  }

  return { busA, busB, negotiatorA, negotiatorB, deliverAtoB, deliverBtoA };
}

/**
 * Create a standalone negotiator for simpler tests.
 */
function makeNegotiator(
  tmpDir: string,
  machineId = 'machine-a',
  overrides: Partial<ConflictNegotiatorConfig> = {},
) {
  const stateDir = path.join(tmpDir, '.instar');
  const bus = new AgentBus({
    stateDir,
    machineId,
    transport: 'jsonl',
    defaultTtlMs: 60000,
  });
  const negotiator = new ConflictNegotiator({
    bus,
    machineId,
    maxRounds: 3,
    roundTimeoutMs: 2000,
    totalTimeoutMs: 10000,
    ...overrides,
  });
  return { bus, negotiator };
}

describe('ConflictNegotiator', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-neg-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Session Tracking ────────────────────────────────────────────

  describe('session tracking', () => {
    it('getActiveNegotiations returns empty initially', () => {
      const { negotiator } = makeNegotiator(tmpDir);
      expect(negotiator.getActiveNegotiations()).toEqual([]);
    });

    it('getSession returns undefined for unknown ID', () => {
      const { negotiator } = makeNegotiator(tmpDir);
      expect(negotiator.getSession('neg_nonexistent')).toBeUndefined();
    });

    it('getNegotiationsForFile returns empty for unknown file', () => {
      const { negotiator } = makeNegotiator(tmpDir);
      expect(negotiator.getNegotiationsForFile('unknown.ts')).toEqual([]);
    });

    it('getCompletedNegotiations returns empty initially', () => {
      const { negotiator } = makeNegotiator(tmpDir);
      expect(negotiator.getCompletedNegotiations()).toEqual([]);
    });
  });

  // ── Stats ──────────────────────────────────────────────────────

  describe('stats', () => {
    it('returns zero stats initially', () => {
      const { negotiator } = makeNegotiator(tmpDir);
      const stats = negotiator.getStats();

      expect(stats.total).toBe(0);
      expect(stats.agreed).toBe(0);
      expect(stats.rejected).toBe(0);
      expect(stats.timedOut).toBe(0);
      expect(stats.escalated).toBe(0);
      expect(stats.inProgress).toBe(0);
      expect(stats.averageRounds).toBe(0);
    });
  });

  // ── Proposal Acceptance ─────────────────────────────────────────

  describe('proposal acceptance', () => {
    it('resolves as agreed when responder accepts', async () => {
      const { busA, busB, negotiatorA, negotiatorB, deliverAtoB, deliverBtoA } =
        makeNegotiatorPair(tmpDir, {
          roundTimeoutMs: 2000,
          responderCallback: (proposal) => ({
            negotiationId: proposal.negotiationId,
            decision: 'accept',
            reason: 'Looks good',
          }),
        });

      // Start negotiation — will send proposal and wait
      const negotiatePromise = negotiatorA.negotiate({
        targetMachineId: 'machine-b',
        filePath: 'src/shared.ts',
        strategy: 'take-ours',
        reasoning: 'Our changes are more recent',
      });

      // Deliver proposal A -> B, then response B -> A
      await new Promise(r => setTimeout(r, 50));
      deliverAtoB();
      await new Promise(r => setTimeout(r, 50));
      deliverBtoA();

      const result = await negotiatePromise;
      expect(result.status).toBe('agreed');
      expect(result.strategy).toBe('take-ours');
      expect(result.fallbackToLLM).toBe(false);
      expect(result.rounds).toBe(1);
      expect(result.elapsedMs).toBeGreaterThan(0);
    });

    it('creates session on initiator side', async () => {
      const { negotiatorA, deliverAtoB, deliverBtoA } =
        makeNegotiatorPair(tmpDir, {
          roundTimeoutMs: 2000,
          responderCallback: (proposal) => ({
            negotiationId: proposal.negotiationId,
            decision: 'accept',
            reason: 'OK',
          }),
        });

      const negotiatePromise = negotiatorA.negotiate({
        targetMachineId: 'machine-b',
        filePath: 'src/file.ts',
        strategy: 'take-ours',
        reasoning: 'Test',
      });

      await new Promise(r => setTimeout(r, 50));
      deliverAtoB();
      await new Promise(r => setTimeout(r, 50));
      deliverBtoA();

      const result = await negotiatePromise;
      const session = negotiatorA.getSession(result.negotiationId);
      expect(session).toBeDefined();
      expect(session!.status).toBe('agreed');
      expect(session!.filePath).toBe('src/file.ts');
      expect(session!.initiator).toBe('machine-a');
      expect(session!.responder).toBe('machine-b');
      expect(session!.proposals).toHaveLength(1);
      expect(session!.responses).toHaveLength(1);
    });

    it('creates session on responder side', async () => {
      const { negotiatorA, negotiatorB, deliverAtoB, deliverBtoA } =
        makeNegotiatorPair(tmpDir, {
          roundTimeoutMs: 2000,
          responderCallback: (proposal) => ({
            negotiationId: proposal.negotiationId,
            decision: 'accept',
            reason: 'OK',
          }),
        });

      const negotiatePromise = negotiatorA.negotiate({
        targetMachineId: 'machine-b',
        filePath: 'src/file.ts',
        strategy: 'take-ours',
        reasoning: 'Test',
      });

      await new Promise(r => setTimeout(r, 50));
      deliverAtoB();
      await new Promise(r => setTimeout(r, 50));
      deliverBtoA();

      const result = await negotiatePromise;
      const session = negotiatorB.getSession(result.negotiationId);
      expect(session).toBeDefined();
      expect(session!.status).toBe('agreed');
      expect(session!.initiator).toBe('machine-a');
      expect(session!.responder).toBe('machine-b');
    });

    it('default behavior auto-accepts when no callback configured', async () => {
      const { busA, busB, negotiatorA, deliverAtoB, deliverBtoA } =
        makeNegotiatorPair(tmpDir, {
          roundTimeoutMs: 2000,
          // No responderCallback — should auto-accept
        });

      const negotiatePromise = negotiatorA.negotiate({
        targetMachineId: 'machine-b',
        filePath: 'src/auto.ts',
        strategy: 'merge-by-section',
        reasoning: 'Auto test',
      });

      await new Promise(r => setTimeout(r, 50));
      deliverAtoB();
      await new Promise(r => setTimeout(r, 50));
      deliverBtoA();

      const result = await negotiatePromise;
      expect(result.status).toBe('agreed');
    });
  });

  // ── Proposal Rejection ──────────────────────────────────────────

  describe('proposal rejection', () => {
    it('resolves as rejected when responder rejects', async () => {
      const { negotiatorA, deliverAtoB, deliverBtoA } =
        makeNegotiatorPair(tmpDir, {
          roundTimeoutMs: 2000,
          responderCallback: (proposal) => ({
            negotiationId: proposal.negotiationId,
            decision: 'reject',
            reason: 'Cannot accept this strategy',
          }),
        });

      const negotiatePromise = negotiatorA.negotiate({
        targetMachineId: 'machine-b',
        filePath: 'src/conflict.ts',
        strategy: 'take-ours',
        reasoning: 'Ours is newer',
      });

      await new Promise(r => setTimeout(r, 50));
      deliverAtoB();
      await new Promise(r => setTimeout(r, 50));
      deliverBtoA();

      const result = await negotiatePromise;
      expect(result.status).toBe('rejected');
      expect(result.fallbackToLLM).toBe(true);
      expect(result.strategy).toBeUndefined();
      expect(result.rounds).toBe(1);
    });

    it('updates stats after rejection', async () => {
      const { negotiatorA, deliverAtoB, deliverBtoA } =
        makeNegotiatorPair(tmpDir, {
          roundTimeoutMs: 2000,
          responderCallback: (proposal) => ({
            negotiationId: proposal.negotiationId,
            decision: 'reject',
            reason: 'No',
          }),
        });

      const negotiatePromise = negotiatorA.negotiate({
        targetMachineId: 'machine-b',
        filePath: 'src/stats.ts',
        strategy: 'take-ours',
        reasoning: 'Test',
      });

      await new Promise(r => setTimeout(r, 50));
      deliverAtoB();
      await new Promise(r => setTimeout(r, 50));
      deliverBtoA();

      await negotiatePromise;
      const stats = negotiatorA.getStats();
      expect(stats.total).toBe(1);
      expect(stats.rejected).toBe(1);
      expect(stats.agreed).toBe(0);
    });
  });

  // ── Timeout ─────────────────────────────────────────────────────

  describe('timeout', () => {
    it('resolves as timed-out when no response within roundTimeoutMs', async () => {
      const { negotiator } = makeNegotiator(tmpDir, 'machine-a', {
        roundTimeoutMs: 100, // Very short timeout
        totalTimeoutMs: 500,
      });

      const result = await negotiator.negotiate({
        targetMachineId: 'machine-b',
        filePath: 'src/timeout.ts',
        strategy: 'take-ours',
        reasoning: 'Testing timeout',
      });

      expect(result.status).toBe('timed-out');
      expect(result.fallbackToLLM).toBe(true);
      expect(result.rounds).toBe(1);
    });

    it('updates stats after timeout', async () => {
      const { negotiator } = makeNegotiator(tmpDir, 'machine-a', {
        roundTimeoutMs: 50,
        totalTimeoutMs: 200,
      });

      await negotiator.negotiate({
        targetMachineId: 'machine-b',
        filePath: 'src/timeout-stats.ts',
        strategy: 'take-ours',
        reasoning: 'Test',
      });

      const stats = negotiator.getStats();
      expect(stats.total).toBe(1);
      expect(stats.timedOut).toBe(1);
    });
  });

  // ── Counter-Proposal Flow ──────────────────────────────────────

  describe('counter-proposal flow', () => {
    it('handles a single counter then accept', async () => {
      let callCount = 0;
      const { negotiatorA, deliverAtoB, deliverBtoA } =
        makeNegotiatorPair(tmpDir, {
          maxRounds: 3,
          roundTimeoutMs: 2000,
          responderCallback: (proposal) => {
            callCount++;
            if (callCount === 1) {
              // First round: counter-propose
              return {
                negotiationId: proposal.negotiationId,
                decision: 'counter' as const,
                counterProposal: {
                  filePath: proposal.filePath,
                  strategy: 'merge-by-section' as const,
                  reasoning: 'Let us split by section',
                  sections: [
                    { claimedBy: 'proposer' as const, startLine: 1, endLine: 50, description: 'Header' },
                    { claimedBy: 'responder' as const, startLine: 51, endLine: 100, description: 'Body' },
                  ],
                },
                reason: 'I suggest a section split',
              };
            }
            // Second round: accept the re-sent counter
            return {
              negotiationId: proposal.negotiationId,
              decision: 'accept' as const,
              reason: 'OK, agreed on sections',
            };
          },
        });

      const negotiatePromise = negotiatorA.negotiate({
        targetMachineId: 'machine-b',
        filePath: 'src/counter.ts',
        strategy: 'take-ours',
        reasoning: 'Initial proposal',
      });

      // Round 1: deliver proposal, get counter
      await new Promise(r => setTimeout(r, 50));
      deliverAtoB();
      await new Promise(r => setTimeout(r, 50));
      deliverBtoA();

      // Round 2: deliver counter-counter-proposal, get accept
      await new Promise(r => setTimeout(r, 50));
      deliverAtoB();
      await new Promise(r => setTimeout(r, 50));
      deliverBtoA();

      const result = await negotiatePromise;
      expect(result.status).toBe('agreed');
      expect(result.strategy).toBe('merge-by-section');
      expect(result.sections).toHaveLength(2);
      expect(result.rounds).toBe(2);
      expect(result.fallbackToLLM).toBe(false);
    });
  });

  // ── Max Rounds Escalation ──────────────────────────────────────

  describe('max rounds escalation', () => {
    it('escalates when max rounds reached with all counters', async () => {
      const { negotiatorA, deliverAtoB, deliverBtoA } =
        makeNegotiatorPair(tmpDir, {
          maxRounds: 2,
          roundTimeoutMs: 2000,
          responderCallback: (proposal) => ({
            negotiationId: proposal.negotiationId,
            decision: 'counter' as const,
            counterProposal: {
              filePath: proposal.filePath,
              strategy: 'take-theirs' as const,
              reasoning: 'I always counter',
            },
            reason: 'Not acceptable',
          }),
        });

      const negotiatePromise = negotiatorA.negotiate({
        targetMachineId: 'machine-b',
        filePath: 'src/escalate.ts',
        strategy: 'take-ours',
        reasoning: 'My version',
      });

      // Round 1
      await new Promise(r => setTimeout(r, 50));
      deliverAtoB();
      await new Promise(r => setTimeout(r, 50));
      deliverBtoA();

      // Round 2 — max rounds reached, should escalate after this
      await new Promise(r => setTimeout(r, 50));
      deliverAtoB();
      await new Promise(r => setTimeout(r, 50));
      deliverBtoA();

      const result = await negotiatePromise;
      expect(result.status).toBe('escalated');
      expect(result.fallbackToLLM).toBe(true);
      expect(result.rounds).toBe(2);
    });

    it('updates stats after escalation', async () => {
      const { negotiatorA, deliverAtoB, deliverBtoA } =
        makeNegotiatorPair(tmpDir, {
          maxRounds: 2,
          roundTimeoutMs: 2000,
          responderCallback: (proposal) => ({
            negotiationId: proposal.negotiationId,
            decision: 'counter' as const,
            counterProposal: {
              filePath: proposal.filePath,
              strategy: 'take-theirs' as const,
              reasoning: 'Counter again',
            },
            reason: 'Keep countering',
          }),
        });

      const negotiatePromise = negotiatorA.negotiate({
        targetMachineId: 'machine-b',
        filePath: 'src/esc-stats.ts',
        strategy: 'take-ours',
        reasoning: 'Test escalation stats',
      });

      // Run 2 rounds
      for (let i = 0; i < 2; i++) {
        await new Promise(r => setTimeout(r, 50));
        deliverAtoB();
        await new Promise(r => setTimeout(r, 50));
        deliverBtoA();
      }

      await negotiatePromise;
      const stats = negotiatorA.getStats();
      expect(stats.escalated).toBe(1);
    });
  });

  // ── getNegotiationsForFile ──────────────────────────────────────

  describe('getNegotiationsForFile', () => {
    it('returns negotiations matching the file path', async () => {
      const { negotiator } = makeNegotiator(tmpDir, 'machine-a', {
        roundTimeoutMs: 50,
      });

      // Create two negotiations for different files
      await negotiator.negotiate({
        targetMachineId: 'machine-b',
        filePath: 'src/target.ts',
        strategy: 'take-ours',
        reasoning: 'Test',
      });

      await negotiator.negotiate({
        targetMachineId: 'machine-b',
        filePath: 'src/other.ts',
        strategy: 'take-ours',
        reasoning: 'Test',
      });

      const targetNegs = negotiator.getNegotiationsForFile('src/target.ts');
      expect(targetNegs).toHaveLength(1);
      expect(targetNegs[0].filePath).toBe('src/target.ts');

      const otherNegs = negotiator.getNegotiationsForFile('src/other.ts');
      expect(otherNegs).toHaveLength(1);
      expect(otherNegs[0].filePath).toBe('src/other.ts');
    });
  });

  // ── getCompletedNegotiations ────────────────────────────────────

  describe('getCompletedNegotiations', () => {
    it('returns only completed negotiations', async () => {
      const { negotiatorA, deliverAtoB, deliverBtoA } =
        makeNegotiatorPair(tmpDir, {
          roundTimeoutMs: 2000,
          responderCallback: (proposal) => ({
            negotiationId: proposal.negotiationId,
            decision: 'accept',
            reason: 'OK',
          }),
        });

      const negotiatePromise = negotiatorA.negotiate({
        targetMachineId: 'machine-b',
        filePath: 'src/complete.ts',
        strategy: 'take-ours',
        reasoning: 'Test',
      });

      await new Promise(r => setTimeout(r, 50));
      deliverAtoB();
      await new Promise(r => setTimeout(r, 50));
      deliverBtoA();

      await negotiatePromise;

      const completed = negotiatorA.getCompletedNegotiations();
      expect(completed).toHaveLength(1);
      expect(completed[0].status).toBe('agreed');
    });
  });

  // ── Stats After Multiple Negotiations ──────────────────────────

  describe('comprehensive stats', () => {
    it('tracks averageRounds correctly', async () => {
      const { negotiator } = makeNegotiator(tmpDir, 'machine-a', {
        roundTimeoutMs: 50,
      });

      // Two timeouts — both at round 1
      await negotiator.negotiate({
        targetMachineId: 'machine-b',
        filePath: 'src/s1.ts',
        strategy: 'take-ours',
        reasoning: 'Test 1',
      });

      await negotiator.negotiate({
        targetMachineId: 'machine-b',
        filePath: 'src/s2.ts',
        strategy: 'take-ours',
        reasoning: 'Test 2',
      });

      const stats = negotiator.getStats();
      expect(stats.total).toBe(2);
      expect(stats.timedOut).toBe(2);
      expect(stats.averageRounds).toBe(1);
    });
  });

  // ── Edge Cases ──────────────────────────────────────────────────

  describe('edge cases', () => {
    it('negotiate includes sessionId in proposal', async () => {
      const { negotiator, bus } = makeNegotiator(tmpDir, 'machine-a', {
        roundTimeoutMs: 50,
      });

      await negotiator.negotiate({
        targetMachineId: 'machine-b',
        filePath: 'src/session.ts',
        strategy: 'take-ours',
        reasoning: 'Test',
        sessionId: 'AUT-100',
      });

      const session = negotiator.getActiveNegotiations().length > 0
        ? negotiator.getActiveNegotiations()[0]
        : negotiator.getCompletedNegotiations()[0];

      // The first proposal should have the sessionId
      expect(session.proposals[0].sessionId).toBe('AUT-100');
    });

    it('negotiate sets negotiationId format', async () => {
      const { negotiator } = makeNegotiator(tmpDir, 'machine-a', {
        roundTimeoutMs: 50,
      });

      const result = await negotiator.negotiate({
        targetMachineId: 'machine-b',
        filePath: 'src/id-format.ts',
        strategy: 'take-ours',
        reasoning: 'Test',
      });

      expect(result.negotiationId).toMatch(/^neg_[a-f0-9]{16}$/);
    });

    it('negotiate records elapsed time', async () => {
      const { negotiator } = makeNegotiator(tmpDir, 'machine-a', {
        roundTimeoutMs: 50,
      });

      const result = await negotiator.negotiate({
        targetMachineId: 'machine-b',
        filePath: 'src/elapsed.ts',
        strategy: 'take-ours',
        reasoning: 'Test',
      });

      expect(result.elapsedMs).toBeGreaterThan(0);
    });

    it('rejection in counter loop stops negotiation', async () => {
      let callCount = 0;
      const { negotiatorA, deliverAtoB, deliverBtoA } =
        makeNegotiatorPair(tmpDir, {
          maxRounds: 5,
          roundTimeoutMs: 2000,
          responderCallback: (proposal) => {
            callCount++;
            if (callCount === 1) {
              return {
                negotiationId: proposal.negotiationId,
                decision: 'counter' as const,
                counterProposal: {
                  filePath: proposal.filePath,
                  strategy: 'take-theirs' as const,
                  reasoning: 'My version',
                },
                reason: 'Counter first',
              };
            }
            // Second round: reject
            return {
              negotiationId: proposal.negotiationId,
              decision: 'reject' as const,
              reason: 'Cannot agree',
            };
          },
        });

      const negotiatePromise = negotiatorA.negotiate({
        targetMachineId: 'machine-b',
        filePath: 'src/reject-in-loop.ts',
        strategy: 'take-ours',
        reasoning: 'Initial',
      });

      // Round 1: counter
      await new Promise(r => setTimeout(r, 50));
      deliverAtoB();
      await new Promise(r => setTimeout(r, 50));
      deliverBtoA();

      // Round 2: reject
      await new Promise(r => setTimeout(r, 50));
      deliverAtoB();
      await new Promise(r => setTimeout(r, 50));
      deliverBtoA();

      const result = await negotiatePromise;
      expect(result.status).toBe('rejected');
      expect(result.rounds).toBe(2);
    });
  });
});
