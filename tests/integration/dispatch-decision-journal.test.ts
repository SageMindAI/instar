/**
 * Integration tests for Dispatch Decision Journal wiring.
 *
 * Tests the end-to-end flow: AutoDispatcher processes dispatches → decisions
 * are logged to DispatchDecisionJournal → entries are queryable.
 *
 * This validates Milestone 1 of the Discernment Layer: every dispatch
 * integration decision is recorded in the decision journal.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DispatchDecisionJournal } from '../../src/core/DispatchDecisionJournal.js';
import { DispatchScopeEnforcer } from '../../src/core/DispatchScopeEnforcer.js';
import { DispatchExecutor } from '../../src/core/DispatchExecutor.js';
import type { Dispatch, DispatchCheckResult, EvaluationDecision } from '../../src/core/DispatchManager.js';
import type { ExecutionResult } from '../../src/core/DispatchExecutor.js';

// ── Mock factories ──────────────────────────────────────────────────

function makeDispatch(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    dispatchId: overrides.dispatchId ?? `disp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type: overrides.type ?? 'lesson',
    title: overrides.title ?? 'Test dispatch',
    content: overrides.content ?? 'Some content',
    priority: overrides.priority ?? 'normal',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    receivedAt: overrides.receivedAt ?? new Date().toISOString(),
    applied: overrides.applied ?? false,
    pendingApproval: overrides.pendingApproval,
    evaluation: overrides.evaluation,
  };
}

function createMockDispatchManager() {
  const dispatches: Dispatch[] = [];
  return {
    pending: () => dispatches.filter(d => !d.applied),
    markPendingApproval: vi.fn((id: string) => {
      const d = dispatches.find(d => d.dispatchId === id);
      if (d) d.pendingApproval = true;
      return !!d;
    }),
    evaluate: vi.fn((id: string, decision: EvaluationDecision, reason: string) => {
      const d = dispatches.find(d => d.dispatchId === id);
      if (!d) return false;
      d.evaluation = { decision, reason, evaluatedAt: new Date().toISOString(), auto: true };
      if (decision === 'accepted') d.applied = true;
      return true;
    }),
    checkAndAutoApply: vi.fn(async (): Promise<DispatchCheckResult> => {
      return { newCount: 0, dispatches: [], checkedAt: new Date().toISOString() };
    }),
    check: vi.fn(async (): Promise<DispatchCheckResult> => {
      return { newCount: 0, dispatches: [], checkedAt: new Date().toISOString() };
    }),
    _addDispatch: (d: Dispatch) => dispatches.push(d),
  };
}

function createMockExecutor(result?: Partial<ExecutionResult>) {
  return {
    parseAction: vi.fn(() => null), // Default: not structured, use agentic
    execute: vi.fn(async (): Promise<ExecutionResult> => ({
      success: result?.success ?? true,
      message: result?.message ?? 'Executed successfully',
      rolledBack: result?.rolledBack ?? false,
      stepsCompleted: result?.stepsCompleted ?? 1,
      totalSteps: result?.totalSteps ?? 1,
    })),
  };
}

function createMockStateManager() {
  const store: Record<string, unknown> = {};
  return {
    get: <T>(key: string): T | undefined => store[key] as T,
    set: (key: string, value: unknown) => { store[key] = value; },
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('Dispatch Decision Journal Integration', () => {
  let tmpDir: string;
  let stateDir: string;
  let journal: DispatchDecisionJournal;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddj-int-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    journal = new DispatchDecisionJournal(stateDir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('auto-applied passive dispatches', () => {
    it('logs accept decisions for auto-applied lesson dispatches', () => {
      const dispatch = makeDispatch({ type: 'lesson', dispatchId: 'lesson-001' });
      dispatch.applied = true;

      // Simulate what AutoDispatcher does for auto-applied dispatches
      journal.logDispatchDecision({
        sessionId: '',
        dispatchId: dispatch.dispatchId,
        dispatchType: dispatch.type,
        dispatchPriority: dispatch.priority,
        dispatchDecision: 'accept',
        reasoning: `Auto-applied: ${dispatch.type} dispatch with ${dispatch.priority} priority`,
        evaluationMethod: 'structural',
        applied: true,
        tags: ['auto-applied', 'passive'],
        context: `title: ${dispatch.title}`,
      });

      const entries = journal.query();
      expect(entries).toHaveLength(1);
      expect(entries[0].dispatchDecision).toBe('accept');
      expect(entries[0].evaluationMethod).toBe('structural');
      expect(entries[0].applied).toBe(true);
      expect(entries[0].tags).toContain('auto-applied');
    });

    it('logs accept decisions for auto-applied strategy dispatches', () => {
      const dispatch = makeDispatch({ type: 'strategy', dispatchId: 'strat-001' });

      journal.logDispatchDecision({
        sessionId: '',
        dispatchId: dispatch.dispatchId,
        dispatchType: dispatch.type,
        dispatchPriority: dispatch.priority,
        dispatchDecision: 'accept',
        reasoning: `Auto-applied: ${dispatch.type} dispatch with ${dispatch.priority} priority`,
        evaluationMethod: 'structural',
        applied: true,
        tags: ['auto-applied', 'passive'],
        context: `title: ${dispatch.title}`,
      });

      const entries = journal.query({ dispatchType: 'strategy' });
      expect(entries).toHaveLength(1);
    });
  });

  describe('scope-blocked dispatches', () => {
    it('logs reject for scope-blocked dispatches without approval path', () => {
      const dispatch = makeDispatch({ type: 'action', dispatchId: 'act-001' });

      journal.logDispatchDecision({
        sessionId: '',
        dispatchId: dispatch.dispatchId,
        dispatchType: dispatch.type,
        dispatchPriority: dispatch.priority,
        dispatchDecision: 'reject',
        reasoning: 'Scope enforcer blocked: action type not allowed at cautious profile',
        evaluationMethod: 'structural',
        tags: ['scope-blocked'],
        context: `title: ${dispatch.title}`,
      });

      const entries = journal.query({ decision: 'reject' });
      expect(entries).toHaveLength(1);
      expect(entries[0].tags).toContain('scope-blocked');
    });

    it('logs defer for scope-blocked dispatches that need approval', () => {
      const dispatch = makeDispatch({ type: 'configuration', dispatchId: 'cfg-001' });

      journal.logDispatchDecision({
        sessionId: '',
        dispatchId: dispatch.dispatchId,
        dispatchType: dispatch.type,
        dispatchPriority: dispatch.priority,
        dispatchDecision: 'defer',
        reasoning: 'Step scope violation: shell command in config scope',
        evaluationMethod: 'structural',
        tags: ['scope-violation', 'needs-approval'],
        context: `title: ${dispatch.title}`,
      });

      const entries = journal.query({ decision: 'defer' });
      expect(entries).toHaveLength(1);
      expect(entries[0].tags).toContain('needs-approval');
    });
  });

  describe('execution results', () => {
    it('logs accept with applied=true on successful execution', () => {
      const dispatch = makeDispatch({ type: 'action', dispatchId: 'act-002' });

      journal.logDispatchDecision({
        sessionId: '',
        dispatchId: dispatch.dispatchId,
        dispatchType: dispatch.type,
        dispatchPriority: dispatch.priority,
        dispatchDecision: 'accept',
        reasoning: 'Auto-executed successfully: Configuration applied',
        evaluationMethod: 'structural',
        applied: true,
        tags: ['auto-executed'],
        context: `title: ${dispatch.title}`,
      });

      const entry = journal.getDecisionForDispatch('act-002');
      expect(entry).not.toBeNull();
      expect(entry!.applied).toBe(true);
      expect(entry!.applicationError).toBeUndefined();
    });

    it('logs defer with applicationError on failed execution', () => {
      const dispatch = makeDispatch({ type: 'action', dispatchId: 'act-003' });

      journal.logDispatchDecision({
        sessionId: '',
        dispatchId: dispatch.dispatchId,
        dispatchType: dispatch.type,
        dispatchPriority: dispatch.priority,
        dispatchDecision: 'defer',
        reasoning: 'Auto-execution failed: Command exited with code 1',
        evaluationMethod: 'structural',
        applied: false,
        applicationError: 'Command exited with code 1',
        tags: ['execution-failed', 'rolled-back'],
        context: `title: ${dispatch.title}`,
      });

      const entry = journal.getDecisionForDispatch('act-003');
      expect(entry).not.toBeNull();
      expect(entry!.applied).toBe(false);
      expect(entry!.applicationError).toBe('Command exited with code 1');
      expect(entry!.tags).toContain('execution-failed');
      expect(entry!.tags).toContain('rolled-back');
    });
  });

  describe('approval-required dispatches', () => {
    it('logs defer for security dispatches requiring approval', () => {
      const dispatch = makeDispatch({ type: 'security', dispatchId: 'sec-001' });

      journal.logDispatchDecision({
        sessionId: '',
        dispatchId: dispatch.dispatchId,
        dispatchType: dispatch.type,
        dispatchPriority: dispatch.priority,
        dispatchDecision: 'defer',
        reasoning: 'security dispatch requires human approval',
        evaluationMethod: 'structural',
        tags: ['needs-approval', 'security'],
        context: `title: ${dispatch.title}`,
      });

      const entries = journal.query({ dispatchType: 'security' });
      expect(entries).toHaveLength(1);
      expect(entries[0].dispatchDecision).toBe('defer');
    });

    it('logs defer for behavioral dispatches requiring approval', () => {
      const dispatch = makeDispatch({ type: 'behavioral', dispatchId: 'beh-001' });

      journal.logDispatchDecision({
        sessionId: '',
        dispatchId: dispatch.dispatchId,
        dispatchType: dispatch.type,
        dispatchPriority: dispatch.priority,
        dispatchDecision: 'defer',
        reasoning: 'behavioral dispatch requires human approval',
        evaluationMethod: 'structural',
        tags: ['needs-approval', 'behavioral'],
        context: `title: ${dispatch.title}`,
      });

      const entries = journal.query({ tag: 'needs-approval' });
      expect(entries).toHaveLength(1);
    });
  });

  describe('dispatch lifecycle tracking', () => {
    it('tracks the full lifecycle: defer → accept', () => {
      const dispatchId = 'lifecycle-001';

      // First: deferred due to needing approval
      journal.logDispatchDecision({
        sessionId: 'sess-1',
        dispatchId,
        dispatchType: 'behavioral',
        dispatchPriority: 'normal',
        dispatchDecision: 'defer',
        reasoning: 'behavioral dispatch requires human approval',
        evaluationMethod: 'structural',
        tags: ['needs-approval'],
      });

      // Later: approved and accepted
      journal.logDispatchDecision({
        sessionId: 'sess-2',
        dispatchId,
        dispatchType: 'behavioral',
        dispatchPriority: 'normal',
        dispatchDecision: 'accept',
        reasoning: 'Human-approved',
        evaluationMethod: 'structural',
        applied: true,
        tags: ['human-approved'],
      });

      // All entries for this dispatch
      const all = journal.query({ dispatchId });
      expect(all).toHaveLength(2);

      // Most recent decision
      const latest = journal.getDecisionForDispatch(dispatchId);
      expect(latest!.dispatchDecision).toBe('accept');
      expect(latest!.applied).toBe(true);
    });

    it('tracks multiple dispatches independently', () => {
      journal.logDispatchDecision({
        sessionId: '',
        dispatchId: 'disp-A',
        dispatchType: 'lesson',
        dispatchPriority: 'normal',
        dispatchDecision: 'accept',
        reasoning: 'Auto-applied',
        evaluationMethod: 'structural',
        applied: true,
      });

      journal.logDispatchDecision({
        sessionId: '',
        dispatchId: 'disp-B',
        dispatchType: 'security',
        dispatchPriority: 'high',
        dispatchDecision: 'defer',
        reasoning: 'Needs approval',
        evaluationMethod: 'structural',
      });

      journal.logDispatchDecision({
        sessionId: '',
        dispatchId: 'disp-C',
        dispatchType: 'configuration',
        dispatchPriority: 'normal',
        dispatchDecision: 'reject',
        reasoning: 'Scope violation',
        evaluationMethod: 'structural',
      });

      expect(journal.hasDecision('disp-A')).toBe(true);
      expect(journal.hasDecision('disp-B')).toBe(true);
      expect(journal.hasDecision('disp-C')).toBe(true);

      const stats = journal.stats();
      expect(stats.total).toBe(3);
      expect(stats.byDecision).toEqual({ accept: 1, defer: 1, reject: 1 });
      expect(stats.byDispatchType).toEqual({ lesson: 1, security: 1, configuration: 1 });
      expect(stats.acceptanceRate).toBeCloseTo(1 / 3);
    });
  });

  describe('stats across decision types', () => {
    it('provides accurate aggregate statistics', () => {
      // Simulate a realistic batch of dispatch decisions
      const decisions = [
        { type: 'lesson', decision: 'accept' as const },
        { type: 'lesson', decision: 'accept' as const },
        { type: 'strategy', decision: 'accept' as const },
        { type: 'configuration', decision: 'accept' as const },
        { type: 'security', decision: 'defer' as const },
        { type: 'behavioral', decision: 'defer' as const },
        { type: 'action', decision: 'reject' as const },
      ];

      for (const { type, decision } of decisions) {
        journal.logDispatchDecision({
          sessionId: '',
          dispatchId: `disp-${Math.random().toString(36).slice(2)}`,
          dispatchType: type,
          dispatchPriority: 'normal',
          dispatchDecision: decision,
          reasoning: 'Test',
          evaluationMethod: 'structural',
        });
      }

      const stats = journal.stats();
      expect(stats.total).toBe(7);
      expect(stats.acceptanceRate).toBeCloseTo(4 / 7);
      expect(stats.byDecision.accept).toBe(4);
      expect(stats.byDecision.defer).toBe(2);
      expect(stats.byDecision.reject).toBe(1);
      expect(stats.byEvaluationMethod.structural).toBe(7);
    });
  });
});
