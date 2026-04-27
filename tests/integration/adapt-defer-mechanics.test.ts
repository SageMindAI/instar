/**
 * Integration tests for Milestone 5: Adapt and Defer Mechanics.
 *
 * Tests the full lifecycle of adapted and deferred dispatches including:
 * - Post-adaptation scope enforcement (security-critical)
 * - Adaptation drift scoring and flagging
 * - Deferred dispatch tracking with bounded queue
 * - Re-evaluation of deferred dispatches
 * - Deferral loop detection
 * - Max deferral auto-rejection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ContextualEvaluator } from '../../src/core/ContextualEvaluator.js';
import { DeferredDispatchTracker } from '../../src/core/DeferredDispatchTracker.js';
import { AdaptationValidator } from '../../src/core/AdaptationValidator.js';
import { DispatchVerifier } from '../../src/core/DispatchVerifier.js';
import { RelevanceFilter } from '../../src/core/RelevanceFilter.js';
import { ContextSnapshotBuilder } from '../../src/core/ContextSnapshotBuilder.js';
import { DispatchDecisionJournal } from '../../src/core/DispatchDecisionJournal.js';
import type { Dispatch } from '../../src/core/DispatchManager.js';
import type { SignedDispatch } from '../../src/core/DispatchVerifier.js';
import type { IntelligenceProvider } from '../../src/core/types.js';
import type { ContextualEvaluation } from '../../src/core/ContextualEvaluator.js';

// ── Helpers ────────────────────────────────────────────────────────

function generateKeyPair() {
  return crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function makeDispatch(overrides?: Partial<Dispatch>): Dispatch {
  return {
    dispatchId: overrides?.dispatchId ?? `disp-${Math.random().toString(36).slice(2)}`,
    type: overrides?.type ?? 'lesson',
    title: overrides?.title ?? 'Test dispatch',
    content: overrides?.content ?? 'Improve logging in the feedback loop',
    priority: overrides?.priority ?? 'normal',
    createdAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    applied: false,
  };
}

function signDispatch(dispatch: Dispatch, privateKey: string, keyId: string): SignedDispatch {
  const signedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  const payload = JSON.stringify({
    content: dispatch.content,
    dispatchId: dispatch.dispatchId,
    expiresAt,
    priority: dispatch.priority,
    signedAt,
    title: dispatch.title,
    type: dispatch.type,
  });
  const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');
  return { ...dispatch, signature, signedAt, expiresAt, keyId };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('Adapt and Defer Mechanics (Milestone 5)', () => {
  let tmpDir: string;
  let stateDir: string;
  let keys: { publicKey: string; privateKey: string };
  let verifier: DispatchVerifier;
  let filter: RelevanceFilter;
  let snapshotBuilder: ContextSnapshotBuilder;
  let journal: DispatchDecisionJournal;
  let adaptValidator: AdaptationValidator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-int-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });

    keys = generateKeyPair();
    verifier = new DispatchVerifier({
      trustedKeys: { 'portal-key-1': keys.publicKey },
      required: true,
    });
    filter = new RelevanceFilter({ agentVersion: '0.12.0' });
    snapshotBuilder = new ContextSnapshotBuilder({
      projectName: 'TestAgent',
      projectDir: tmpDir,
      stateDir,
    });
    journal = new DispatchDecisionJournal(stateDir);
    adaptValidator = new AdaptationValidator();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Adaptation scope enforcement ─────────────────────────────────

  describe('adaptation scope enforcement', () => {
    it('allows clean adaptation through the pipeline', async () => {
      const provider: IntelligenceProvider = {
        evaluate: async () => JSON.stringify({
          decision: 'adapt',
          reasoning: 'Content needs agent-specific adjustment',
          adaptation: 'Enhanced logging in the feedback loop with better error context',
          confidenceScore: 0.85,
        }),
      };
      const evaluator = new ContextualEvaluator(provider);
      const dispatch = makeDispatch({ content: 'Improve logging in the feedback loop' });
      const signed = signDispatch(dispatch, keys.privateKey, 'portal-key-1');

      // Evaluate
      const snapshot = snapshotBuilder.build();
      const evaluation = await evaluator.evaluate(signed, snapshot);
      expect(evaluation.decision).toBe('adapt');

      // Validate adaptation
      const scopeCheck = adaptValidator.validate(dispatch, evaluation.adaptation!);
      expect(scopeCheck.withinScope).toBe(true);
      expect(scopeCheck.flagForReview).toBe(false);
    });

    it('blocks adaptation that introduces shell commands', async () => {
      const provider: IntelligenceProvider = {
        evaluate: async () => JSON.stringify({
          decision: 'adapt',
          reasoning: 'Need to restart the service',
          adaptation: 'Run sudo systemctl restart agent && rm -rf /tmp/cache',
          confidenceScore: 0.7,
        }),
      };
      const evaluator = new ContextualEvaluator(provider);
      const dispatch = makeDispatch({ content: 'Service needs updating' });
      const signed = signDispatch(dispatch, keys.privateKey, 'portal-key-1');

      const snapshot = snapshotBuilder.build();
      const evaluation = await evaluator.evaluate(signed, snapshot);

      const scopeCheck = adaptValidator.validate(dispatch, evaluation.adaptation!);
      expect(scopeCheck.withinScope).toBe(false);
      expect(scopeCheck.violations.length).toBeGreaterThan(0);

      // Log the scope violation
      journal.logDispatchDecision({
        sessionId: '',
        dispatchId: dispatch.dispatchId,
        dispatchType: dispatch.type,
        dispatchPriority: dispatch.priority,
        dispatchDecision: 'reject',
        reasoning: `Adaptation scope violation: ${scopeCheck.violations.join('; ')}`,
        evaluationMethod: 'contextual',
        tags: ['adaptation-scope-violation', 'security-signal'],
      });

      const entry = journal.getDecisionForDispatch(dispatch.dispatchId);
      expect(entry!.tags).toContain('security-signal');
    });

    it('flags high-drift adaptation for human review', async () => {
      const provider: IntelligenceProvider = {
        evaluate: async () => JSON.stringify({
          decision: 'adapt',
          reasoning: 'Completely different approach needed',
          adaptation: 'Deploy a new microservice architecture with Kubernetes orchestration',
          confidenceScore: 0.6,
        }),
      };
      const evaluator = new ContextualEvaluator(provider);
      const dispatch = makeDispatch({ content: 'Improve logging in the feedback loop' });
      const signed = signDispatch(dispatch, keys.privateKey, 'portal-key-1');

      const snapshot = snapshotBuilder.build();
      const evaluation = await evaluator.evaluate(signed, snapshot);

      const scopeCheck = adaptValidator.validate(dispatch, evaluation.adaptation!);
      expect(scopeCheck.driftScore).toBeGreaterThan(0.6);
      expect(scopeCheck.flagForReview).toBe(true);
    });
  });

  // ── Deferred dispatch lifecycle ──────────────────────────────────

  describe('deferred dispatch lifecycle', () => {
    it('tracks deferred dispatches and re-evaluates on schedule', async () => {
      let callCount = 0;
      const provider: IntelligenceProvider = {
        evaluate: async () => {
          callCount++;
          if (callCount === 1) {
            return JSON.stringify({
              decision: 'defer',
              reasoning: 'Agent is mid-job',
              deferCondition: 'When current job completes',
              confidenceScore: 0.6,
            });
          }
          // On re-evaluation, accept
          return JSON.stringify({
            decision: 'accept',
            reasoning: 'Agent is now idle, safe to apply',
            confidenceScore: 0.9,
          });
        },
      };
      const evaluator = new ContextualEvaluator(provider);
      const tracker = new DeferredDispatchTracker(stateDir, {
        reEvaluateEveryPolls: 2,
      });

      const dispatch = makeDispatch({ dispatchId: 'defer-lifecycle' });
      const signed = signDispatch(dispatch, keys.privateKey, 'portal-key-1');
      const snapshot = snapshotBuilder.build();

      // First evaluation: defer
      const eval1 = await evaluator.evaluate(signed, snapshot);
      expect(eval1.decision).toBe('defer');

      tracker.defer(dispatch, eval1.deferCondition!, eval1.reasoning);
      expect(tracker.isDeferred('defer-lifecycle')).toBe(true);

      // Not yet due
      tracker.advancePoll();
      expect(tracker.getDueForReEvaluation()).toHaveLength(0);

      // Now due
      tracker.advancePoll();
      const due = tracker.getDueForReEvaluation();
      expect(due).toHaveLength(1);

      // Re-evaluate
      const eval2 = await evaluator.evaluate(due[0].dispatch, snapshot);
      expect(eval2.decision).toBe('accept');

      // Remove from deferred queue
      tracker.remove('defer-lifecycle');
      expect(tracker.isDeferred('defer-lifecycle')).toBe(false);
    });

    it('auto-rejects after max deferrals with journal record', async () => {
      const provider: IntelligenceProvider = {
        evaluate: async () => JSON.stringify({
          decision: 'defer',
          reasoning: 'Not ready yet',
          deferCondition: 'Later',
          confidenceScore: 0.5,
        }),
      };
      const evaluator = new ContextualEvaluator(provider);
      const tracker = new DeferredDispatchTracker(stateDir, {
        maxDeferralCount: 3,
        reEvaluateEveryPolls: 1,
      });

      const dispatch = makeDispatch({ dispatchId: 'max-defer' });
      const snapshot = snapshotBuilder.build();

      // Defer 3 times
      for (let i = 0; i < 3; i++) {
        const evaluation = await evaluator.evaluate(dispatch, snapshot);
        const result = tracker.defer(dispatch, evaluation.deferCondition!, evaluation.reasoning);

        if (i < 2) {
          expect(result.action).toBe('deferred');
        } else {
          expect(result.action).toBe('auto-rejected');
        }

        tracker.advancePoll();
      }

      expect(tracker.isDeferred('max-defer')).toBe(false);
    });

    it('detects deferral loops and auto-rejects', () => {
      const tracker = new DeferredDispatchTracker(stateDir, {
        maxDeferralCount: 10,
        loopDetectionThreshold: 3,
      });

      const dispatch = makeDispatch({ dispatchId: 'loop-detect' });

      tracker.defer(dispatch, 'Cond', 'Agent is processing feedback');
      tracker.defer(dispatch, 'Cond', 'Agent is processing feedback');
      const result = tracker.defer(dispatch, 'Cond', 'Agent is processing feedback');

      expect(result.action).toBe('auto-rejected');
      expect(result.reason).toContain('loop detected');
      expect(tracker.isDeferred('loop-detect')).toBe(false);
    });

    it('handles queue overflow by evicting oldest', () => {
      const tracker = new DeferredDispatchTracker(stateDir, {
        maxDeferredDispatches: 2,
      });

      const d1 = makeDispatch({ dispatchId: 'overflow-1' });
      const d2 = makeDispatch({ dispatchId: 'overflow-2' });
      const d3 = makeDispatch({ dispatchId: 'overflow-3' });

      tracker.defer(d1, 'C', 'R');
      tracker.defer(d2, 'C', 'R');

      const result = tracker.defer(d3, 'C', 'R');
      expect(result.action).toBe('overflow-rejected');
      expect(result.evictedDispatchId).toBe('overflow-1');
      expect(tracker.isDeferred('overflow-1')).toBe(false);
      expect(tracker.isDeferred('overflow-3')).toBe(true);
    });
  });

  // ── Full pipeline with adapt/defer ───────────────────────────────

  describe('full pipeline integration', () => {
    it('processes mixed decisions through the complete pipeline', async () => {
      let callIdx = 0;
      const decisions = [
        { decision: 'accept', reasoning: 'Good lesson', confidenceScore: 0.9 },
        { decision: 'adapt', reasoning: 'Needs adjustment', adaptation: 'Adjusted logging for Telegram context', confidenceScore: 0.85 },
        { decision: 'defer', reasoning: 'Agent is busy', deferCondition: 'When idle', confidenceScore: 0.5 },
        { decision: 'reject', reasoning: 'Contradicts agent identity', confidenceScore: 0.95 },
      ];

      const provider: IntelligenceProvider = {
        evaluate: async () => JSON.stringify(decisions[callIdx++]),
      };
      const evaluator = new ContextualEvaluator(provider);
      const tracker = new DeferredDispatchTracker(stateDir);

      const dispatches = [
        makeDispatch({ dispatchId: 'mix-accept' }),
        makeDispatch({ dispatchId: 'mix-adapt' }),
        makeDispatch({ dispatchId: 'mix-defer' }),
        makeDispatch({ dispatchId: 'mix-reject' }),
      ];

      const snapshot = snapshotBuilder.build();

      for (const dispatch of dispatches) {
        const signed = signDispatch(dispatch, keys.privateKey, 'portal-key-1');
        const evaluation = await evaluator.evaluate(signed, snapshot);

        // Log to journal
        journal.logDispatchDecision({
          sessionId: '',
          dispatchId: dispatch.dispatchId,
          dispatchType: dispatch.type,
          dispatchPriority: dispatch.priority,
          dispatchDecision: evaluation.decision,
          reasoning: evaluation.reasoning,
          evaluationMethod: 'contextual',
          promptVersion: evaluation.promptVersion,
          confidence: evaluation.confidenceScore,
        });

        // Handle defer
        if (evaluation.decision === 'defer') {
          tracker.defer(dispatch, evaluation.deferCondition!, evaluation.reasoning);
        }

        // Handle adapt
        if (evaluation.decision === 'adapt' && evaluation.adaptation) {
          const scopeCheck = adaptValidator.validate(dispatch, evaluation.adaptation);
          expect(scopeCheck.withinScope).toBe(true);
        }
      }

      // Verify journal
      const stats = journal.stats();
      expect(stats.total).toBe(4);
      expect(stats.byDecision.accept).toBe(1);
      expect(stats.byDecision.adapt).toBe(1);
      expect(stats.byDecision.defer).toBe(1);
      expect(stats.byDecision.reject).toBe(1);

      // Verify deferred queue
      expect(tracker.size).toBe(1);
      expect(tracker.isDeferred('mix-defer')).toBe(true);
    });

    it('persists deferred state across tracker restarts', () => {
      const tracker1 = new DeferredDispatchTracker(stateDir);
      const dispatch = makeDispatch({ dispatchId: 'persist-test' });
      tracker1.defer(dispatch, 'Wait for idle', 'Busy right now');
      tracker1.advancePoll();
      tracker1.advancePoll();

      // Simulate restart
      const tracker2 = new DeferredDispatchTracker(stateDir);
      expect(tracker2.isDeferred('persist-test')).toBe(true);
      expect(tracker2.pollCount).toBe(2);

      const state = tracker2.getState('persist-test');
      expect(state!.deferCount).toBe(1);
      expect(state!.deferCondition).toBe('Wait for idle');
    });
  });
});
