/**
 * Unit tests for DeferredDispatchTracker — bounded deferred dispatch lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DeferredDispatchTracker } from '../../src/core/DeferredDispatchTracker.js';
import type { Dispatch } from '../../src/core/DispatchManager.js';

function makeDispatch(overrides?: Partial<Dispatch>): Dispatch {
  return {
    dispatchId: overrides?.dispatchId ?? `disp-${Math.random().toString(36).slice(2)}`,
    type: overrides?.type ?? 'lesson',
    title: overrides?.title ?? 'Test dispatch',
    content: overrides?.content ?? 'Some content',
    priority: overrides?.priority ?? 'normal',
    createdAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    applied: false,
  };
}

describe('DeferredDispatchTracker', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddt-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Basic deferral ───────────────────────────────────────────────

  describe('basic deferral', () => {
    it('defers a dispatch successfully', () => {
      const tracker = new DeferredDispatchTracker(stateDir);
      const dispatch = makeDispatch({ dispatchId: 'def-1' });

      const result = tracker.defer(dispatch, 'Job in progress', 'Agent is busy');
      expect(result.action).toBe('deferred');
      expect(tracker.size).toBe(1);
      expect(tracker.isDeferred('def-1')).toBe(true);
    });

    it('tracks defer count on re-deferral', () => {
      const tracker = new DeferredDispatchTracker(stateDir);
      const dispatch = makeDispatch({ dispatchId: 'def-recount' });

      tracker.defer(dispatch, 'Busy', 'Reason 1');
      tracker.defer(dispatch, 'Still busy', 'Reason 2');

      const state = tracker.getState('def-recount');
      expect(state!.deferCount).toBe(2);
      expect(state!.deferReasonHistory).toHaveLength(2);
    });

    it('removes a dispatch from the queue', () => {
      const tracker = new DeferredDispatchTracker(stateDir);
      const dispatch = makeDispatch({ dispatchId: 'def-remove' });

      tracker.defer(dispatch, 'Condition', 'Reason');
      expect(tracker.size).toBe(1);

      const removed = tracker.remove('def-remove');
      expect(removed).toBe(true);
      expect(tracker.size).toBe(0);
    });

    it('returns false when removing non-existent dispatch', () => {
      const tracker = new DeferredDispatchTracker(stateDir);
      expect(tracker.remove('nonexistent')).toBe(false);
    });
  });

  // ── Max deferrals ────────────────────────────────────────────────

  describe('max deferrals', () => {
    it('auto-rejects after max deferrals reached', () => {
      const tracker = new DeferredDispatchTracker(stateDir, { maxDeferralCount: 3 });
      const dispatch = makeDispatch({ dispatchId: 'def-max' });

      tracker.defer(dispatch, 'Cond', 'Reason A');
      tracker.defer(dispatch, 'Cond', 'Reason B');
      const result = tracker.defer(dispatch, 'Cond', 'Reason C');

      expect(result.action).toBe('auto-rejected');
      expect(result.reason).toContain('max deferrals');
      expect(tracker.isDeferred('def-max')).toBe(false);
    });

    it('does not auto-reject before reaching max', () => {
      const tracker = new DeferredDispatchTracker(stateDir, { maxDeferralCount: 5 });
      const dispatch = makeDispatch({ dispatchId: 'def-below' });

      for (let i = 0; i < 4; i++) {
        const result = tracker.defer(dispatch, 'Cond', `Reason ${i}`);
        expect(result.action).toBe('deferred');
      }

      expect(tracker.isDeferred('def-below')).toBe(true);
    });
  });

  // ── Loop detection ───────────────────────────────────────────────

  describe('loop detection', () => {
    it('detects identical consecutive reasons as a loop', () => {
      const tracker = new DeferredDispatchTracker(stateDir, {
        maxDeferralCount: 10,
        loopDetectionThreshold: 3,
      });
      const dispatch = makeDispatch({ dispatchId: 'def-loop' });

      tracker.defer(dispatch, 'Cond', 'Agent is busy');
      tracker.defer(dispatch, 'Cond', 'Agent is busy');
      const result = tracker.defer(dispatch, 'Cond', 'Agent is busy');

      expect(result.action).toBe('auto-rejected');
      expect(result.reason).toContain('loop detected');
    });

    it('does not trigger loop for varying reasons', () => {
      const tracker = new DeferredDispatchTracker(stateDir, {
        maxDeferralCount: 10,
        loopDetectionThreshold: 3,
      });
      const dispatch = makeDispatch({ dispatchId: 'def-vary' });

      tracker.defer(dispatch, 'Cond', 'Reason A');
      tracker.defer(dispatch, 'Cond', 'Reason B');
      const result = tracker.defer(dispatch, 'Cond', 'Reason C');

      expect(result.action).toBe('deferred');
    });

    it('loop detection is case-insensitive', () => {
      const tracker = new DeferredDispatchTracker(stateDir, {
        maxDeferralCount: 10,
        loopDetectionThreshold: 3,
      });
      const dispatch = makeDispatch({ dispatchId: 'def-case' });

      tracker.defer(dispatch, 'Cond', 'Agent is busy');
      tracker.defer(dispatch, 'Cond', 'AGENT IS BUSY');
      const result = tracker.defer(dispatch, 'Cond', 'agent is busy');

      expect(result.action).toBe('auto-rejected');
    });
  });

  // ── Queue overflow ───────────────────────────────────────────────

  describe('queue overflow', () => {
    it('evicts oldest dispatch when queue is full', () => {
      const tracker = new DeferredDispatchTracker(stateDir, { maxDeferredDispatches: 3 });

      tracker.defer(makeDispatch({ dispatchId: 'old-1' }), 'Cond', 'R');
      tracker.defer(makeDispatch({ dispatchId: 'old-2' }), 'Cond', 'R');
      tracker.defer(makeDispatch({ dispatchId: 'old-3' }), 'Cond', 'R');

      // Queue is full — adding a new one should evict old-1
      const result = tracker.defer(makeDispatch({ dispatchId: 'new-1' }), 'Cond', 'R');
      expect(result.action).toBe('overflow-rejected');
      expect(result.evictedDispatchId).toBe('old-1');
      expect(tracker.size).toBe(3);
      expect(tracker.isDeferred('old-1')).toBe(false);
      expect(tracker.isDeferred('new-1')).toBe(true);
    });
  });

  // ── Re-evaluation scheduling ─────────────────────────────────────

  describe('re-evaluation scheduling', () => {
    it('returns dispatches due for re-evaluation', () => {
      const tracker = new DeferredDispatchTracker(stateDir, { reEvaluateEveryPolls: 2 });

      tracker.defer(makeDispatch({ dispatchId: 'reeval-1' }), 'Cond', 'R');

      // Not yet due
      expect(tracker.getDueForReEvaluation()).toHaveLength(0);

      // Advance 2 polls
      tracker.advancePoll();
      tracker.advancePoll();

      const due = tracker.getDueForReEvaluation();
      expect(due).toHaveLength(1);
      expect(due[0].dispatchId).toBe('reeval-1');
    });

    it('does not return non-due dispatches', () => {
      const tracker = new DeferredDispatchTracker(stateDir, { reEvaluateEveryPolls: 5 });

      tracker.defer(makeDispatch({ dispatchId: 'reeval-2' }), 'Cond', 'R');
      tracker.advancePoll();

      expect(tracker.getDueForReEvaluation()).toHaveLength(0);
    });
  });

  // ── Persistence ──────────────────────────────────────────────────

  describe('persistence', () => {
    it('persists and recovers deferred state', () => {
      const tracker1 = new DeferredDispatchTracker(stateDir);
      tracker1.defer(makeDispatch({ dispatchId: 'persist-1' }), 'Cond', 'R');
      tracker1.advancePoll();
      tracker1.advancePoll();

      // Create a new tracker — should load persisted state
      const tracker2 = new DeferredDispatchTracker(stateDir);
      expect(tracker2.isDeferred('persist-1')).toBe(true);
      expect(tracker2.pollCount).toBe(2);
    });

    it('survives missing state file', () => {
      const tracker = new DeferredDispatchTracker(stateDir);
      expect(tracker.size).toBe(0);
      expect(tracker.pollCount).toBe(0);
    });
  });

  // ── getAll ───────────────────────────────────────────────────────

  describe('getAll', () => {
    it('returns all deferred dispatches', () => {
      const tracker = new DeferredDispatchTracker(stateDir);
      tracker.defer(makeDispatch({ dispatchId: 'all-1' }), 'C', 'R');
      tracker.defer(makeDispatch({ dispatchId: 'all-2' }), 'C', 'R');
      tracker.defer(makeDispatch({ dispatchId: 'all-3' }), 'C', 'R');

      const all = tracker.getAll();
      expect(all).toHaveLength(3);
      expect(all.map(d => d.dispatchId).sort()).toEqual(['all-1', 'all-2', 'all-3']);
    });
  });
});
