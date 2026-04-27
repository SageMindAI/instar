/**
 * Unit tests for DispatchDecisionJournal — dispatch-specific decision journal.
 *
 * Tests cover:
 * - logDispatchDecision(): appending entries, auto-timestamping, type discrimination
 * - query(): filtering by dispatchId/decision/dispatchType/evaluationMethod/tag/days/limit
 * - getDecisionForDispatch(): single-dispatch lookup, most-recent-wins
 * - hasDecision(): existence check
 * - stats(): aggregate statistics, acceptance rate, breakdowns
 * - Edge cases: empty file, corrupt lines, mixed entry types, missing file
 * - Coexistence with base DecisionJournal entries
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DispatchDecisionJournal } from '../../src/core/DispatchDecisionJournal.js';
import type { DispatchDecisionEntry } from '../../src/core/types.js';

describe('DispatchDecisionJournal', () => {
  let tmpDir: string;
  let stateDir: string;
  let journal: DispatchDecisionJournal;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddj-test-'));
    stateDir = path.join(tmpDir, '.instar');
    // Do NOT create stateDir — test lazy creation
    journal = new DispatchDecisionJournal(stateDir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // Helper to create a minimal dispatch decision entry
  function makeEntry(overrides: Partial<Omit<DispatchDecisionEntry, 'timestamp' | 'type' | 'decision'>> = {}) {
    return {
      sessionId: overrides.sessionId ?? 'sess-1',
      dispatchId: overrides.dispatchId ?? 'disp-001',
      dispatchType: overrides.dispatchType ?? 'lesson',
      dispatchPriority: overrides.dispatchPriority ?? 'normal',
      dispatchDecision: overrides.dispatchDecision ?? 'accept' as const,
      reasoning: overrides.reasoning ?? 'Auto-applied',
      evaluationMethod: overrides.evaluationMethod ?? 'structural' as const,
      applied: overrides.applied,
      applicationError: overrides.applicationError,
      adaptationSummary: overrides.adaptationSummary,
      adaptationScopeResult: overrides.adaptationScopeResult,
      promptVersion: overrides.promptVersion,
      tags: overrides.tags,
      context: overrides.context,
      confidence: overrides.confidence,
    };
  }

  // ── logDispatchDecision() ─────────────────────────────────────────

  describe('logDispatchDecision()', () => {
    it('creates the state directory lazily on first log', () => {
      expect(fs.existsSync(stateDir)).toBe(false);

      journal.logDispatchDecision(makeEntry());

      expect(fs.existsSync(stateDir)).toBe(true);
      expect(fs.existsSync(path.join(stateDir, 'decision-journal.jsonl'))).toBe(true);
    });

    it('appends a JSONL line with auto-generated timestamp', () => {
      journal.logDispatchDecision(makeEntry({ dispatchId: 'disp-123' }));

      const content = fs.readFileSync(path.join(stateDir, 'decision-journal.jsonl'), 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);

      const parsed = JSON.parse(lines[0]);
      expect(parsed.dispatchId).toBe('disp-123');
      expect(parsed.type).toBe('dispatch');
      expect(parsed.timestamp).toBeTruthy();
      expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
    });

    it('sets type discriminator to "dispatch"', () => {
      const entry = journal.logDispatchDecision(makeEntry());
      expect(entry.type).toBe('dispatch');
    });

    it('maps dispatchDecision to base decision field', () => {
      const entry = journal.logDispatchDecision(makeEntry({ dispatchDecision: 'reject' }));
      expect(entry.decision).toBe('dispatch:reject');
      expect(entry.dispatchDecision).toBe('reject');
    });

    it('returns the full entry with all fields', () => {
      const result = journal.logDispatchDecision(makeEntry({
        dispatchId: 'disp-456',
        dispatchType: 'configuration',
        dispatchPriority: 'high',
        dispatchDecision: 'defer',
        reasoning: 'Needs human review',
        evaluationMethod: 'structural',
        tags: ['needs-approval'],
      }));

      expect(result.dispatchId).toBe('disp-456');
      expect(result.dispatchType).toBe('configuration');
      expect(result.dispatchPriority).toBe('high');
      expect(result.dispatchDecision).toBe('defer');
      expect(result.reasoning).toBe('Needs human review');
      expect(result.evaluationMethod).toBe('structural');
      expect(result.tags).toEqual(['needs-approval']);
      expect(result.timestamp).toBeTruthy();
    });

    it('appends multiple entries without overwriting', () => {
      journal.logDispatchDecision(makeEntry({ dispatchId: 'disp-1' }));
      journal.logDispatchDecision(makeEntry({ dispatchId: 'disp-2' }));
      journal.logDispatchDecision(makeEntry({ dispatchId: 'disp-3' }));

      const content = fs.readFileSync(path.join(stateDir, 'decision-journal.jsonl'), 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(3);

      expect(JSON.parse(lines[0]).dispatchId).toBe('disp-1');
      expect(JSON.parse(lines[1]).dispatchId).toBe('disp-2');
      expect(JSON.parse(lines[2]).dispatchId).toBe('disp-3');
    });

    it('preserves optional fields when provided', () => {
      const result = journal.logDispatchDecision(makeEntry({
        adaptationSummary: 'Modified caching strategy',
        adaptationScopeResult: 'passed',
        promptVersion: 'v1.0',
        applied: true,
        confidence: 0.85,
      }));

      expect(result.adaptationSummary).toBe('Modified caching strategy');
      expect(result.adaptationScopeResult).toBe('passed');
      expect(result.promptVersion).toBe('v1.0');
      expect(result.applied).toBe(true);
      expect(result.confidence).toBe(0.85);
    });

    it('preserves applicationError for failed applications', () => {
      const result = journal.logDispatchDecision(makeEntry({
        dispatchDecision: 'defer',
        applied: false,
        applicationError: 'Shell command failed with exit code 1',
      }));

      expect(result.applied).toBe(false);
      expect(result.applicationError).toBe('Shell command failed with exit code 1');
    });
  });

  // ── query() ───────────────────────────────────────────────────────

  describe('query()', () => {
    beforeEach(() => {
      // Create state directory for pre-seeded tests
      fs.mkdirSync(stateDir, { recursive: true });
    });

    it('returns empty array when no entries exist', () => {
      expect(journal.query()).toEqual([]);
    });

    it('returns all dispatch entries in most-recent-first order', () => {
      journal.logDispatchDecision(makeEntry({ dispatchId: 'disp-1' }));
      // Small delay to ensure different timestamps
      journal.logDispatchDecision(makeEntry({ dispatchId: 'disp-2' }));

      const results = journal.query();
      expect(results).toHaveLength(2);
      // Most recent first
      expect(results[0].dispatchId).toBe('disp-2');
      expect(results[1].dispatchId).toBe('disp-1');
    });

    it('filters by dispatchId', () => {
      journal.logDispatchDecision(makeEntry({ dispatchId: 'disp-1' }));
      journal.logDispatchDecision(makeEntry({ dispatchId: 'disp-2' }));
      journal.logDispatchDecision(makeEntry({ dispatchId: 'disp-1', dispatchDecision: 'defer' }));

      const results = journal.query({ dispatchId: 'disp-1' });
      expect(results).toHaveLength(2);
      expect(results.every(r => r.dispatchId === 'disp-1')).toBe(true);
    });

    it('filters by decision', () => {
      journal.logDispatchDecision(makeEntry({ dispatchId: 'disp-1', dispatchDecision: 'accept' }));
      journal.logDispatchDecision(makeEntry({ dispatchId: 'disp-2', dispatchDecision: 'reject' }));
      journal.logDispatchDecision(makeEntry({ dispatchId: 'disp-3', dispatchDecision: 'accept' }));

      const results = journal.query({ decision: 'accept' });
      expect(results).toHaveLength(2);
      expect(results.every(r => r.dispatchDecision === 'accept')).toBe(true);
    });

    it('filters by dispatchType', () => {
      journal.logDispatchDecision(makeEntry({ dispatchType: 'lesson' }));
      journal.logDispatchDecision(makeEntry({ dispatchType: 'configuration' }));
      journal.logDispatchDecision(makeEntry({ dispatchType: 'lesson' }));

      const results = journal.query({ dispatchType: 'lesson' });
      expect(results).toHaveLength(2);
    });

    it('filters by evaluationMethod', () => {
      journal.logDispatchDecision(makeEntry({ evaluationMethod: 'structural' }));
      journal.logDispatchDecision(makeEntry({ evaluationMethod: 'contextual' }));

      const results = journal.query({ evaluationMethod: 'contextual' });
      expect(results).toHaveLength(1);
      expect(results[0].evaluationMethod).toBe('contextual');
    });

    it('filters by tag', () => {
      journal.logDispatchDecision(makeEntry({ tags: ['auto-applied', 'passive'] }));
      journal.logDispatchDecision(makeEntry({ tags: ['needs-approval'] }));
      journal.logDispatchDecision(makeEntry({ tags: ['auto-applied'] }));

      const results = journal.query({ tag: 'auto-applied' });
      expect(results).toHaveLength(2);
    });

    it('filters by days', () => {
      // Seed an old entry directly
      const oldTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const oldEntry = JSON.stringify({
        type: 'dispatch',
        timestamp: oldTimestamp,
        sessionId: 'old-sess',
        dispatchId: 'disp-old',
        dispatchType: 'lesson',
        dispatchPriority: 'normal',
        dispatchDecision: 'accept',
        decision: 'dispatch:accept',
        reasoning: 'Old entry',
        evaluationMethod: 'structural',
      });
      fs.appendFileSync(path.join(stateDir, 'decision-journal.jsonl'), oldEntry + '\n');

      // Add a recent entry
      journal.logDispatchDecision(makeEntry({ dispatchId: 'disp-recent' }));

      const results = journal.query({ days: 7 });
      expect(results).toHaveLength(1);
      expect(results[0].dispatchId).toBe('disp-recent');
    });

    it('applies limit', () => {
      for (let i = 0; i < 10; i++) {
        journal.logDispatchDecision(makeEntry({ dispatchId: `disp-${i}` }));
      }

      const results = journal.query({ limit: 3 });
      expect(results).toHaveLength(3);
    });

    it('combines multiple filters', () => {
      journal.logDispatchDecision(makeEntry({
        dispatchType: 'lesson',
        dispatchDecision: 'accept',
        tags: ['auto-applied'],
      }));
      journal.logDispatchDecision(makeEntry({
        dispatchType: 'lesson',
        dispatchDecision: 'reject',
        tags: ['auto-applied'],
      }));
      journal.logDispatchDecision(makeEntry({
        dispatchType: 'configuration',
        dispatchDecision: 'accept',
        tags: ['auto-applied'],
      }));

      const results = journal.query({
        dispatchType: 'lesson',
        decision: 'accept',
        tag: 'auto-applied',
      });
      expect(results).toHaveLength(1);
    });

    it('ignores non-dispatch entries in the journal', () => {
      // Write a base DecisionJournal entry (no type: 'dispatch')
      const baseEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        sessionId: 'sess-base',
        decision: 'Some non-dispatch decision',
      });
      fs.appendFileSync(path.join(stateDir, 'decision-journal.jsonl'), baseEntry + '\n');

      // Add a dispatch entry
      journal.logDispatchDecision(makeEntry({ dispatchId: 'disp-1' }));

      const results = journal.query();
      expect(results).toHaveLength(1);
      expect(results[0].dispatchId).toBe('disp-1');
    });

    it('handles corrupt JSONL lines gracefully', () => {
      fs.appendFileSync(
        path.join(stateDir, 'decision-journal.jsonl'),
        'not valid json\n',
      );
      journal.logDispatchDecision(makeEntry({ dispatchId: 'disp-valid' }));

      const results = journal.query();
      expect(results).toHaveLength(1);
      expect(results[0].dispatchId).toBe('disp-valid');
    });
  });

  // ── getDecisionForDispatch() ──────────────────────────────────────

  describe('getDecisionForDispatch()', () => {
    it('returns null when no decision exists', () => {
      expect(journal.getDecisionForDispatch('nonexistent')).toBeNull();
    });

    it('returns the most recent decision for a dispatch', () => {
      journal.logDispatchDecision(makeEntry({
        dispatchId: 'disp-1',
        dispatchDecision: 'defer',
        reasoning: 'First attempt',
      }));
      journal.logDispatchDecision(makeEntry({
        dispatchId: 'disp-1',
        dispatchDecision: 'accept',
        reasoning: 'Retried and accepted',
      }));

      const result = journal.getDecisionForDispatch('disp-1');
      expect(result).not.toBeNull();
      expect(result!.dispatchDecision).toBe('accept');
      expect(result!.reasoning).toBe('Retried and accepted');
    });

    it('does not return decisions for other dispatches', () => {
      journal.logDispatchDecision(makeEntry({ dispatchId: 'disp-1' }));
      journal.logDispatchDecision(makeEntry({ dispatchId: 'disp-2' }));

      const result = journal.getDecisionForDispatch('disp-1');
      expect(result!.dispatchId).toBe('disp-1');
    });
  });

  // ── hasDecision() ─────────────────────────────────────────────────

  describe('hasDecision()', () => {
    it('returns false when no decision exists', () => {
      expect(journal.hasDecision('nonexistent')).toBe(false);
    });

    it('returns true when a decision exists', () => {
      journal.logDispatchDecision(makeEntry({ dispatchId: 'disp-1' }));
      expect(journal.hasDecision('disp-1')).toBe(true);
    });

    it('returns false for empty journal', () => {
      expect(journal.hasDecision('any-id')).toBe(false);
    });
  });

  // ── stats() ───────────────────────────────────────────────────────

  describe('stats()', () => {
    it('returns zero stats for empty journal', () => {
      const stats = journal.stats();
      expect(stats.total).toBe(0);
      expect(stats.byDecision).toEqual({});
      expect(stats.byDispatchType).toEqual({});
      expect(stats.byEvaluationMethod).toEqual({});
      expect(stats.acceptanceRate).toBe(0);
      expect(stats.earliest).toBeNull();
      expect(stats.latest).toBeNull();
    });

    it('counts entries by decision type', () => {
      journal.logDispatchDecision(makeEntry({ dispatchDecision: 'accept' }));
      journal.logDispatchDecision(makeEntry({ dispatchDecision: 'accept' }));
      journal.logDispatchDecision(makeEntry({ dispatchDecision: 'reject' }));
      journal.logDispatchDecision(makeEntry({ dispatchDecision: 'defer' }));

      const stats = journal.stats();
      expect(stats.total).toBe(4);
      expect(stats.byDecision).toEqual({ accept: 2, reject: 1, defer: 1 });
    });

    it('counts entries by dispatch type', () => {
      journal.logDispatchDecision(makeEntry({ dispatchType: 'lesson' }));
      journal.logDispatchDecision(makeEntry({ dispatchType: 'lesson' }));
      journal.logDispatchDecision(makeEntry({ dispatchType: 'configuration' }));

      const stats = journal.stats();
      expect(stats.byDispatchType).toEqual({ lesson: 2, configuration: 1 });
    });

    it('counts entries by evaluation method', () => {
      journal.logDispatchDecision(makeEntry({ evaluationMethod: 'structural' }));
      journal.logDispatchDecision(makeEntry({ evaluationMethod: 'structural' }));
      journal.logDispatchDecision(makeEntry({ evaluationMethod: 'contextual' }));

      const stats = journal.stats();
      expect(stats.byEvaluationMethod).toEqual({ structural: 2, contextual: 1 });
    });

    it('calculates acceptance rate', () => {
      journal.logDispatchDecision(makeEntry({ dispatchDecision: 'accept' }));
      journal.logDispatchDecision(makeEntry({ dispatchDecision: 'accept' }));
      journal.logDispatchDecision(makeEntry({ dispatchDecision: 'reject' }));
      journal.logDispatchDecision(makeEntry({ dispatchDecision: 'defer' }));

      const stats = journal.stats();
      expect(stats.acceptanceRate).toBe(0.5); // 2 out of 4
    });

    it('tracks earliest and latest timestamps', () => {
      journal.logDispatchDecision(makeEntry({ dispatchId: 'disp-1' }));
      journal.logDispatchDecision(makeEntry({ dispatchId: 'disp-2' }));

      const stats = journal.stats();
      expect(stats.earliest).toBeTruthy();
      expect(stats.latest).toBeTruthy();
      expect(stats.earliest! <= stats.latest!).toBe(true);
    });

    it('filters by days when provided', () => {
      // Seed an old entry directly
      fs.mkdirSync(stateDir, { recursive: true });
      const oldTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const oldEntry = JSON.stringify({
        type: 'dispatch',
        timestamp: oldTimestamp,
        sessionId: 'old-sess',
        dispatchId: 'disp-old',
        dispatchType: 'lesson',
        dispatchPriority: 'normal',
        dispatchDecision: 'accept',
        decision: 'dispatch:accept',
        reasoning: 'Old entry',
        evaluationMethod: 'structural',
      });
      fs.appendFileSync(path.join(stateDir, 'decision-journal.jsonl'), oldEntry + '\n');

      journal.logDispatchDecision(makeEntry({ dispatchDecision: 'accept' }));
      journal.logDispatchDecision(makeEntry({ dispatchDecision: 'reject' }));

      const allStats = journal.stats();
      expect(allStats.total).toBe(3);

      const recentStats = journal.stats({ days: 7 });
      expect(recentStats.total).toBe(2);
    });

    it('ignores non-dispatch entries', () => {
      fs.mkdirSync(stateDir, { recursive: true });
      const baseEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        sessionId: 'base-sess',
        decision: 'Non-dispatch decision',
      });
      fs.appendFileSync(path.join(stateDir, 'decision-journal.jsonl'), baseEntry + '\n');

      journal.logDispatchDecision(makeEntry());

      const stats = journal.stats();
      expect(stats.total).toBe(1); // Only the dispatch entry
    });
  });

  // ── getBaseJournal() ──────────────────────────────────────────────

  describe('getBaseJournal()', () => {
    it('returns a DecisionJournal instance sharing the same file', () => {
      const base = journal.getBaseJournal();
      expect(base).toBeDefined();

      // Log a dispatch entry
      journal.logDispatchDecision(makeEntry({ dispatchId: 'disp-1' }));

      // Base journal should see it too (as a generic entry)
      const allEntries = base.read();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0].decision).toBe('dispatch:accept');
    });
  });

  // ── Coexistence ───────────────────────────────────────────────────

  describe('coexistence with base DecisionJournal', () => {
    it('dispatch and base entries share the same JSONL file', () => {
      const base = journal.getBaseJournal();

      // Log a base entry
      base.log({
        sessionId: 'sess-base',
        decision: 'Regular decision',
      });

      // Log a dispatch entry
      journal.logDispatchDecision(makeEntry({ dispatchId: 'disp-1' }));

      // Base journal sees both
      const baseEntries = base.read();
      expect(baseEntries).toHaveLength(2);

      // Dispatch journal sees only dispatch entries
      const dispatchEntries = journal.query();
      expect(dispatchEntries).toHaveLength(1);
      expect(dispatchEntries[0].dispatchId).toBe('disp-1');
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles missing journal file gracefully', () => {
      expect(journal.query()).toEqual([]);
      expect(journal.stats().total).toBe(0);
      expect(journal.hasDecision('any')).toBe(false);
      expect(journal.getDecisionForDispatch('any')).toBeNull();
    });

    it('handles empty journal file', () => {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'decision-journal.jsonl'), '');

      expect(journal.query()).toEqual([]);
    });

    it('handles journal file with only whitespace', () => {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'decision-journal.jsonl'), '  \n  \n');

      expect(journal.query()).toEqual([]);
    });

    it('handles read errors gracefully', () => {
      fs.mkdirSync(stateDir, { recursive: true });
      const journalPath = path.join(stateDir, 'decision-journal.jsonl');
      // Create a directory where the file should be (causes read error)
      fs.mkdirSync(journalPath, { recursive: true });

      // Should not throw, should return empty
      expect(journal.query()).toEqual([]);
      expect(journal.stats().total).toBe(0);
    });

    it('all four decision types are valid', () => {
      const decisions: Array<DispatchDecisionEntry['dispatchDecision']> = ['accept', 'adapt', 'defer', 'reject'];
      for (const d of decisions) {
        const result = journal.logDispatchDecision(makeEntry({ dispatchDecision: d }));
        expect(result.dispatchDecision).toBe(d);
        expect(result.decision).toBe(`dispatch:${d}`);
      }

      const stats = journal.stats();
      expect(stats.total).toBe(4);
      expect(stats.byDecision).toEqual({ accept: 1, adapt: 1, defer: 1, reject: 1 });
    });
  });
});
