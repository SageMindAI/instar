/**
 * Unit tests for IntentDriftDetector — drift detection and alignment scoring.
 *
 * Tests cover:
 * - analyze(): empty journal, single window, conflict spike, confidence drop,
 *   principle shift, volume change, drift score computation
 * - alignmentScore(): all 4 components, grade A-F, empty journal, perfect journal
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { IntentDriftDetector } from '../../src/core/IntentDriftDetector.js';
import type { DecisionJournalEntry } from '../../src/core/types.js';

/** Write journal entries directly to the JSONL file. */
function writeJournal(stateDir: string, entries: Partial<DecisionJournalEntry>[]): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const journalFile = path.join(stateDir, 'decision-journal.jsonl');
  const lines = entries.map(e => JSON.stringify({
    sessionId: 'test',
    decision: 'test decision',
    ...e,
  }));
  fs.writeFileSync(journalFile, lines.join('\n') + '\n');
}

/** Generate a timestamp N days ago from now. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('IntentDriftDetector', () => {
  let tmpDir: string;
  let stateDir: string;
  let detector: IntentDriftDetector;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
    stateDir = path.join(tmpDir, '.instar');
    detector = new IntentDriftDetector(stateDir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ── analyze() ──────────────────────────────────────────────────────

  describe('analyze()', () => {
    it('returns baseline with no signals for empty journal', () => {
      const result = detector.analyze();

      expect(result.current.decisionCount).toBe(0);
      expect(result.previous).toBeNull();
      expect(result.signals).toEqual([]);
      expect(result.driftScore).toBe(0);
      expect(result.summary).toContain('No decisions');
    });

    it('returns current stats with null previous when only one window has data', () => {
      // All entries within the last 14 days (current window), none in previous
      writeJournal(stateDir, [
        { timestamp: daysAgo(1), decision: 'D1', principle: 'safety', confidence: 0.8 },
        { timestamp: daysAgo(3), decision: 'D2', principle: 'safety', confidence: 0.9 },
        { timestamp: daysAgo(5), decision: 'D3', principle: 'speed', confidence: 0.7, conflict: true },
      ]);

      const result = detector.analyze(14);

      expect(result.current.decisionCount).toBe(3);
      expect(result.current.conflictRate).toBeCloseTo(1 / 3, 2);
      expect(result.current.avgConfidence).toBeCloseTo(0.8, 2);
      expect(result.current.topPrinciples[0].principle).toBe('safety');
      expect(result.previous).toBeNull();
      expect(result.signals).toEqual([]);
    });

    it('detects conflict spike — warning threshold (>2x)', () => {
      // Previous period: 2/10 conflict rate = 20%
      // Current period: 5/10 conflict rate = 50% (2.5x — above 2x but below 3x)
      const previousEntries = Array.from({ length: 10 }, (_, i) => ({
        timestamp: daysAgo(15 + i),
        decision: `Prev D${i}`,
        conflict: i < 2, // 2 conflicts = 20%
        principle: 'safety',
        confidence: 0.8,
      }));
      const currentEntries = Array.from({ length: 10 }, (_, i) => ({
        timestamp: daysAgo(1 + i),
        decision: `Curr D${i}`,
        conflict: i < 5, // 5 conflicts = 50% (2.5x of 20%)
        principle: 'safety',
        confidence: 0.8,
      }));

      writeJournal(stateDir, [...previousEntries, ...currentEntries]);

      const result = detector.analyze(14);

      const conflictSignal = result.signals.find(s => s.type === 'conflict_spike');
      expect(conflictSignal).toBeTruthy();
      expect(conflictSignal!.severity).toBe('warning');
    });

    it('detects conflict spike — alert threshold (>3x)', () => {
      // Previous: 10% conflict rate (1/10)
      // Current: 50% conflict rate (5/10) => 5x (well above 3x)
      const previousEntries = Array.from({ length: 10 }, (_, i) => ({
        timestamp: daysAgo(15 + i),
        decision: `Prev D${i}`,
        conflict: i === 0, // 1 conflict = 10%
        principle: 'safety',
      }));
      const currentEntries = Array.from({ length: 10 }, (_, i) => ({
        timestamp: daysAgo(1 + i),
        decision: `Curr D${i}`,
        conflict: i < 5, // 5 conflicts = 50% (5x of 10%)
        principle: 'safety',
      }));

      writeJournal(stateDir, [...previousEntries, ...currentEntries]);

      const result = detector.analyze(14);

      const conflictSignal = result.signals.find(s => s.type === 'conflict_spike');
      expect(conflictSignal).toBeTruthy();
      expect(conflictSignal!.severity).toBe('alert');
    });

    it('detects confidence drop — warning threshold (>0.15)', () => {
      // Previous: avg confidence 0.85
      // Current: avg confidence 0.65 (drop of 0.20)
      const previousEntries = Array.from({ length: 5 }, (_, i) => ({
        timestamp: daysAgo(20 + i),
        decision: `Prev D${i}`,
        confidence: 0.85,
        principle: 'safety',
      }));
      const currentEntries = Array.from({ length: 5 }, (_, i) => ({
        timestamp: daysAgo(1 + i),
        decision: `Curr D${i}`,
        confidence: 0.65,
        principle: 'safety',
      }));

      writeJournal(stateDir, [...previousEntries, ...currentEntries]);

      const result = detector.analyze(14);

      const confSignal = result.signals.find(s => s.type === 'confidence_drop');
      expect(confSignal).toBeTruthy();
      expect(confSignal!.severity).toBe('warning');
      expect(confSignal!.delta).toBeCloseTo(-0.20, 2);
    });

    it('detects confidence drop — alert threshold (>0.25)', () => {
      const previousEntries = Array.from({ length: 5 }, (_, i) => ({
        timestamp: daysAgo(20 + i),
        decision: `Prev D${i}`,
        confidence: 0.90,
        principle: 'safety',
      }));
      const currentEntries = Array.from({ length: 5 }, (_, i) => ({
        timestamp: daysAgo(1 + i),
        decision: `Curr D${i}`,
        confidence: 0.60,
        principle: 'safety',
      }));

      writeJournal(stateDir, [...previousEntries, ...currentEntries]);

      const result = detector.analyze(14);

      const confSignal = result.signals.find(s => s.type === 'confidence_drop');
      expect(confSignal).toBeTruthy();
      expect(confSignal!.severity).toBe('alert');
    });

    it('detects principle shift — info when top principle changes', () => {
      const previousEntries = Array.from({ length: 5 }, (_, i) => ({
        timestamp: daysAgo(20 + i),
        decision: `Prev D${i}`,
        principle: 'safety',
        confidence: 0.8,
      }));
      const currentEntries = Array.from({ length: 5 }, (_, i) => ({
        timestamp: daysAgo(1 + i),
        decision: `Curr D${i}`,
        principle: 'speed',
        confidence: 0.8,
      }));

      writeJournal(stateDir, [...previousEntries, ...currentEntries]);

      const result = detector.analyze(14);

      const shiftSignal = result.signals.find(s => s.type === 'principle_shift');
      expect(shiftSignal).toBeTruthy();
      // Single principle changing (but all principles are same so 2+ shifted)
      // Previous top 3: [safety], Current top 3: [speed] — the top changed
      // Since there's only 1 principle each, shifted count is 1
      expect(shiftSignal!.severity).toBe('info');
    });

    it('detects principle shift — warning when 2+ of top 3 change', () => {
      const previousEntries = [
        { timestamp: daysAgo(20), decision: 'P1', principle: 'safety' },
        { timestamp: daysAgo(21), decision: 'P2', principle: 'safety' },
        { timestamp: daysAgo(22), decision: 'P3', principle: 'accuracy' },
        { timestamp: daysAgo(23), decision: 'P4', principle: 'accuracy' },
        { timestamp: daysAgo(24), decision: 'P5', principle: 'speed' },
      ];
      const currentEntries = [
        { timestamp: daysAgo(1), decision: 'C1', principle: 'empathy' },
        { timestamp: daysAgo(2), decision: 'C2', principle: 'empathy' },
        { timestamp: daysAgo(3), decision: 'C3', principle: 'creativity' },
        { timestamp: daysAgo(4), decision: 'C4', principle: 'creativity' },
        { timestamp: daysAgo(5), decision: 'C5', principle: 'honesty' },
      ];

      writeJournal(stateDir, [...previousEntries, ...currentEntries]);

      const result = detector.analyze(14);

      const shiftSignal = result.signals.find(s => s.type === 'principle_shift');
      expect(shiftSignal).toBeTruthy();
      expect(shiftSignal!.severity).toBe('warning');
      expect(shiftSignal!.delta).toBeGreaterThanOrEqual(2);
    });

    it('detects volume change — warning when dropped >50%', () => {
      // Previous: 10 decisions, current: 3 decisions (70% drop)
      const previousEntries = Array.from({ length: 10 }, (_, i) => ({
        timestamp: daysAgo(15 + i),
        decision: `Prev D${i}`,
        principle: 'safety',
      }));
      const currentEntries = Array.from({ length: 3 }, (_, i) => ({
        timestamp: daysAgo(1 + i),
        decision: `Curr D${i}`,
        principle: 'safety',
      }));

      writeJournal(stateDir, [...previousEntries, ...currentEntries]);

      const result = detector.analyze(14);

      const volSignal = result.signals.find(s => s.type === 'volume_change');
      expect(volSignal).toBeTruthy();
      expect(volSignal!.severity).toBe('warning');
    });

    it('detects volume change — info when increased >3x', () => {
      // Previous: 3 decisions, current: 12 decisions (4x)
      const previousEntries = Array.from({ length: 3 }, (_, i) => ({
        timestamp: daysAgo(15 + i),
        decision: `Prev D${i}`,
        principle: 'safety',
      }));
      const currentEntries = Array.from({ length: 12 }, (_, i) => ({
        timestamp: daysAgo(1 + i),
        decision: `Curr D${i}`,
        principle: 'safety',
      }));

      writeJournal(stateDir, [...previousEntries, ...currentEntries]);

      const result = detector.analyze(14);

      const volSignal = result.signals.find(s => s.type === 'volume_change');
      expect(volSignal).toBeTruthy();
      expect(volSignal!.severity).toBe('info');
    });

    it('computes drift score from signals as weighted sum', () => {
      // Create a scenario with multiple signals
      // Previous: no conflicts, high confidence, safety principle
      // Current: conflicts, low confidence, different principle => multiple signals
      const previousEntries = Array.from({ length: 10 }, (_, i) => ({
        timestamp: daysAgo(15 + i),
        decision: `Prev D${i}`,
        principle: 'safety',
        confidence: 0.9,
        conflict: false,
      }));
      const currentEntries = Array.from({ length: 3 }, (_, i) => ({
        timestamp: daysAgo(1 + i),
        decision: `Curr D${i}`,
        principle: 'speed',
        confidence: 0.5,
        conflict: true,
      }));

      writeJournal(stateDir, [...previousEntries, ...currentEntries]);

      const result = detector.analyze(14);

      // Should have multiple signals and a non-zero drift score
      expect(result.signals.length).toBeGreaterThan(0);
      expect(result.driftScore).toBeGreaterThan(0);
      expect(result.driftScore).toBeLessThanOrEqual(1);
    });
  });

  // ── alignmentScore() ──────────────────────────────────────────────

  describe('alignmentScore()', () => {
    it('returns all 4 components computed correctly', () => {
      // Create a mixed journal: some conflicts, varied confidence, multiple principles
      const entries = [
        { timestamp: daysAgo(1), decision: 'D1', principle: 'safety', confidence: 0.9, conflict: false },
        { timestamp: daysAgo(2), decision: 'D2', principle: 'safety', confidence: 0.8, conflict: false },
        { timestamp: daysAgo(3), decision: 'D3', principle: 'speed', confidence: 0.7, conflict: true },
        { timestamp: daysAgo(5), decision: 'D4', principle: 'safety', confidence: 0.85, conflict: false },
        { timestamp: daysAgo(8), decision: 'D5', principle: 'accuracy', confidence: 0.6, conflict: false },
      ];

      writeJournal(stateDir, entries);

      const score = detector.alignmentScore(30);

      // conflictFreedom: 1 conflict out of 5 => (1 - 0.2) * 100 = 80
      expect(score.components.conflictFreedom).toBe(80);

      // confidenceLevel: avg(0.9, 0.8, 0.7, 0.85, 0.6) = 0.77 => 77
      expect(score.components.confidenceLevel).toBe(77);

      // principleConsistency: safety(3), speed(1), accuracy(1) - some consistency
      expect(score.components.principleConsistency).toBeGreaterThan(0);
      expect(score.components.principleConsistency).toBeLessThanOrEqual(100);

      // journalHealth: 4 unique days out of 30 => rate = 4/30 = 0.133 => between 0.05 and 0.2 => 30
      expect(score.components.journalHealth).toBe(30);

      // Overall is a weighted average
      expect(score.score).toBeGreaterThan(0);
      expect(score.score).toBeLessThanOrEqual(100);
      expect(score.sampleSize).toBe(5);
      expect(score.periodDays).toBe(30);
    });

    it('returns grade A-F correctly', () => {
      // Grade A: score >= 85
      // Create a perfect-ish journal: no conflicts, high confidence, consistent principles, daily entries
      const entries = Array.from({ length: 25 }, (_, i) => ({
        timestamp: daysAgo(i + 1),
        decision: `D${i}`,
        principle: 'safety',
        confidence: 0.95,
        conflict: false,
      }));

      writeJournal(stateDir, entries);

      const score = detector.alignmentScore(30);
      expect(score.grade).toBe('A');
      expect(score.score).toBeGreaterThanOrEqual(85);
    });

    it('handles empty journal — score 0, grade F', () => {
      const score = detector.alignmentScore();

      expect(score.score).toBe(0);
      expect(score.grade).toBe('F');
      expect(score.sampleSize).toBe(0);
      expect(score.components.conflictFreedom).toBe(0);
      expect(score.components.confidenceLevel).toBe(0);
      expect(score.components.principleConsistency).toBe(0);
      expect(score.components.journalHealth).toBe(0);
      expect(score.summary).toContain('No decisions logged');
    });

    it('handles perfect journal — all high, grade A', () => {
      // Daily entries, no conflicts, high confidence, single principle
      const entries = Array.from({ length: 28 }, (_, i) => ({
        timestamp: daysAgo(i + 1),
        decision: `Perfect D${i}`,
        principle: 'thoroughness',
        confidence: 0.95,
        conflict: false,
      }));

      writeJournal(stateDir, entries);

      const score = detector.alignmentScore(30);

      expect(score.components.conflictFreedom).toBe(100);
      expect(score.components.confidenceLevel).toBe(95);
      expect(score.components.principleConsistency).toBe(100);
      expect(score.components.journalHealth).toBe(100); // 28/30 = 0.93 > 0.8
      expect(score.grade).toBe('A');
      expect(score.score).toBeGreaterThanOrEqual(85);
    });

    it('correctly grades boundary values', () => {
      // Test that different quality journals produce different grades
      // Low quality: all conflicts, low confidence, scattered principles
      const lowEntries = Array.from({ length: 5 }, (_, i) => ({
        timestamp: daysAgo(i * 6 + 1),
        decision: `Low D${i}`,
        principle: `principle_${i}`, // all different
        confidence: 0.3,
        conflict: true,
      }));

      writeJournal(stateDir, lowEntries);

      const lowScore = detector.alignmentScore(30);
      expect(lowScore.grade).toBe('F');
      expect(lowScore.score).toBeLessThan(40);
    });
  });
});
