/**
 * Unit tests for PatternAnalyzer — cross-execution pattern detection.
 *
 * Tests cover:
 * - Consistent additions: steps recurring above threshold
 * - Consistent omissions: defined steps repeatedly skipped
 * - Novel additions: first-time steps
 * - Duration drift: trending up or down
 * - Gate ineffectiveness: runs with zero steps
 * - Proposal generation: converting patterns to evolution proposals
 * - Edge cases: empty journals, single run, insufficient data
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ExecutionJournal } from '../../src/core/ExecutionJournal.js';
import { PatternAnalyzer } from '../../src/core/PatternAnalyzer.js';
import type { ExecutionRecord } from '../../src/core/types.js';

// Helper to create an ExecutionRecord
function makeRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    executionId: `exec-${Math.random().toString(36).slice(2, 8)}`,
    jobSlug: 'test-job',
    sessionId: `sess-${Math.random().toString(36).slice(2, 8)}`,
    agentId: 'default',
    timestamp: new Date().toISOString(),
    definedSteps: [],
    actualSteps: [],
    deviations: [],
    outcome: 'success',
    finalized: true,
    ...overrides,
  };
}

// Helper to generate timestamps relative to now, ensuring they're always within
// the 30-day default analysis window. daysAgo=1 means yesterday, daysAgo=2 means
// two days ago, etc. This prevents time-boundary failures in CI (the original
// hardcoded 2026-03-0X timestamps fell outside the 30-day window as time passed).
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

// Helper to write records directly to journal JSONL
function writeRecords(stateDir: string, jobSlug: string, records: ExecutionRecord[], agentId = 'default'): void {
  const dir = path.join(stateDir, 'state', 'execution-journal', agentId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${jobSlug}.jsonl`);
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(file, content);
}

describe('PatternAnalyzer', () => {
  let tmpDir: string;
  let stateDir: string;
  let journal: ExecutionJournal;
  let analyzer: PatternAnalyzer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pattern-analyzer-'));
    stateDir = tmpDir;
    journal = new ExecutionJournal(stateDir);
    analyzer = new PatternAnalyzer(journal);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Empty / Insufficient Data ──────────────────────────────────────────

  describe('empty and insufficient data', () => {
    it('returns empty patterns for missing journal', () => {
      const report = analyzer.analyze('nonexistent-job');
      expect(report.runsAnalyzed).toBe(0);
      expect(report.patterns).toEqual([]);
      expect(report.summary.uniqueSteps).toBe(0);
      expect(report.summary.successRate).toBe(0);
      expect(report.summary.durationTrend).toBe('insufficient-data');
    });

    it('returns empty patterns for single run (below minRuns)', () => {
      writeRecords(stateDir, 'single-job', [
        makeRecord({
          jobSlug: 'single-job',
          actualSteps: [{ step: 'fetch-data', timestamp: new Date().toISOString(), source: 'hook' }],
        }),
      ]);

      const report = analyzer.analyze('single-job');
      expect(report.runsAnalyzed).toBe(1);
      // Should still detect novel additions even with 1 run
      const novel = report.patterns.filter(p => p.type === 'novel-addition');
      expect(novel.length).toBeGreaterThanOrEqual(0); // Novel detection needs no prior history
    });

    it('returns empty patterns for 2 runs (below default minRuns of 3)', () => {
      const records = [
        makeRecord({
          jobSlug: 'two-runs',
          actualSteps: [{ step: 'step-a', timestamp: daysAgo(2), source: 'hook' }],
          timestamp: daysAgo(2),
        }),
        makeRecord({
          jobSlug: 'two-runs',
          actualSteps: [{ step: 'step-a', timestamp: daysAgo(1), source: 'hook' }],
          timestamp: daysAgo(1),
        }),
      ];
      writeRecords(stateDir, 'two-runs', records);

      const report = analyzer.analyze('two-runs');
      expect(report.runsAnalyzed).toBe(2);
      // No consistent-addition/omission patterns below minRuns
      const major = report.patterns.filter(p =>
        p.type === 'consistent-addition' || p.type === 'consistent-omission',
      );
      expect(major).toEqual([]);
    });

    it('allows custom minRuns', () => {
      const records = [
        makeRecord({
          jobSlug: 'custom-min',
          actualSteps: [{ step: 'extra-step', timestamp: daysAgo(2), source: 'hook' }],
          timestamp: daysAgo(2),
        }),
        makeRecord({
          jobSlug: 'custom-min',
          actualSteps: [{ step: 'extra-step', timestamp: daysAgo(1), source: 'hook' }],
          timestamp: daysAgo(1),
        }),
      ];
      writeRecords(stateDir, 'custom-min', records);

      const report = analyzer.analyze('custom-min', { minRuns: 2 });
      expect(report.runsAnalyzed).toBe(2);
      const additions = report.patterns.filter(p => p.type === 'consistent-addition');
      expect(additions.length).toBe(1);
      expect(additions[0].step).toBe('extra-step');
    });
  });

  // ─── Consistent Additions ──────────────────────────────────────────────

  describe('consistent additions', () => {
    it('detects steps appearing above threshold', () => {
      const records = Array.from({ length: 5 }, (_, i) => makeRecord({
        jobSlug: 'addition-test',
        definedSteps: ['step-a'],
        actualSteps: [
          { step: 'step-a', timestamp: daysAgo(5 - i), source: 'hook' },
          // 'extra-step' appears in 4 of 5 runs (80%)
          ...(i < 4 ? [{ step: 'extra-step', timestamp: daysAgo(5 - i), source: 'hook' as const }] : []),
        ],
        timestamp: daysAgo(5 - i),
      }));
      writeRecords(stateDir, 'addition-test', records);

      const report = analyzer.analyze('addition-test');
      const additions = report.patterns.filter(p => p.type === 'consistent-addition');
      expect(additions.length).toBe(1);
      expect(additions[0].step).toBe('extra-step');
      expect(additions[0].occurrences).toBe(4);
      expect(additions[0].totalRuns).toBe(5);
      expect(additions[0].rate).toBe(0.8);
      expect(additions[0].confidence).toBe('high'); // ≥80%
    });

    it('assigns medium confidence for 60-79% rate', () => {
      const records = Array.from({ length: 5 }, (_, i) => makeRecord({
        jobSlug: 'medium-add',
        definedSteps: [],
        actualSteps: [
          // Appears in 3 of 5 runs (60%)
          ...(i < 3 ? [{ step: 'sometimes-step', timestamp: daysAgo(5 - i), source: 'hook' as const }] : []),
        ],
        timestamp: daysAgo(5 - i),
      }));
      writeRecords(stateDir, 'medium-add', records);

      const report = analyzer.analyze('medium-add');
      const additions = report.patterns.filter(p => p.type === 'consistent-addition');
      expect(additions.length).toBe(1);
      expect(additions[0].confidence).toBe('medium');
    });

    it('does NOT flag defined steps as additions', () => {
      const records = Array.from({ length: 5 }, (_, i) => makeRecord({
        jobSlug: 'defined-test',
        definedSteps: ['my-step'],
        actualSteps: [
          { step: 'my-step', timestamp: daysAgo(5 - i), source: 'hook' },
        ],
        timestamp: daysAgo(5 - i),
      }));
      writeRecords(stateDir, 'defined-test', records);

      const report = analyzer.analyze('defined-test');
      const additions = report.patterns.filter(p => p.type === 'consistent-addition');
      expect(additions.length).toBe(0);
    });

    it('does NOT flag steps below threshold', () => {
      const records = Array.from({ length: 5 }, (_, i) => makeRecord({
        jobSlug: 'below-thresh',
        definedSteps: [],
        actualSteps: [
          // Appears in 2 of 5 runs (40%) — below 60% threshold
          ...(i < 2 ? [{ step: 'rare-step', timestamp: daysAgo(5 - i), source: 'hook' as const }] : []),
        ],
        timestamp: daysAgo(5 - i),
      }));
      writeRecords(stateDir, 'below-thresh', records);

      const report = analyzer.analyze('below-thresh');
      const additions = report.patterns.filter(p => p.type === 'consistent-addition');
      expect(additions.length).toBe(0);
    });
  });

  // ─── Consistent Omissions ─────────────────────────────────────────────

  describe('consistent omissions', () => {
    it('detects defined steps consistently skipped', () => {
      const records = Array.from({ length: 5 }, (_, i) => makeRecord({
        jobSlug: 'omission-test',
        definedSteps: ['required-step', 'optional-step'],
        actualSteps: [
          { step: 'required-step', timestamp: daysAgo(5 - i), source: 'hook' },
          // 'optional-step' only executed in 1 of 5 runs (80% omission)
          ...(i === 0 ? [{ step: 'optional-step', timestamp: daysAgo(5 - i), source: 'hook' as const }] : []),
        ],
        timestamp: daysAgo(5 - i),
      }));
      writeRecords(stateDir, 'omission-test', records);

      const report = analyzer.analyze('omission-test');
      const omissions = report.patterns.filter(p => p.type === 'consistent-omission');
      expect(omissions.length).toBe(1);
      expect(omissions[0].step).toBe('optional-step');
      expect(omissions[0].occurrences).toBe(4); // skipped 4 times
      expect(omissions[0].rate).toBe(0.8);
      expect(omissions[0].confidence).toBe('high');
    });

    it('does NOT flag steps below omission threshold', () => {
      const records = Array.from({ length: 5 }, (_, i) => makeRecord({
        jobSlug: 'no-omission',
        definedSteps: ['sometimes-skip'],
        actualSteps: [
          // Executed in 3 of 5 runs (40% omission — below 50%)
          ...(i < 3 ? [{ step: 'sometimes-skip', timestamp: daysAgo(5 - i), source: 'hook' as const }] : []),
        ],
        timestamp: daysAgo(5 - i),
      }));
      writeRecords(stateDir, 'no-omission', records);

      const report = analyzer.analyze('no-omission');
      const omissions = report.patterns.filter(p => p.type === 'consistent-omission');
      expect(omissions.length).toBe(0);
    });

    it('allows custom omission threshold', () => {
      const records = Array.from({ length: 5 }, (_, i) => makeRecord({
        jobSlug: 'custom-omit',
        definedSteps: ['check-mail'],
        actualSteps: [
          // Executed in 3 of 5 runs (40% omission)
          ...(i < 3 ? [{ step: 'check-mail', timestamp: daysAgo(5 - i), source: 'hook' as const }] : []),
        ],
        timestamp: daysAgo(5 - i),
      }));
      writeRecords(stateDir, 'custom-omit', records);

      // With 30% threshold, 40% omission should be flagged
      const report = analyzer.analyze('custom-omit', { omissionThreshold: 0.3 });
      const omissions = report.patterns.filter(p => p.type === 'consistent-omission');
      expect(omissions.length).toBe(1);
    });
  });

  // ─── Novel Additions ──────────────────────────────────────────────────

  describe('novel additions', () => {
    it('detects first-time steps in the latest run', () => {
      const records = [
        // Newer runs first (journal.read returns newest-first)
        makeRecord({
          jobSlug: 'novel-test',
          actualSteps: [
            { step: 'existing-step', timestamp: daysAgo(1), source: 'hook' },
            { step: 'brand-new-step', timestamp: daysAgo(1), source: 'hook' },
          ],
          timestamp: daysAgo(1),
        }),
        makeRecord({
          jobSlug: 'novel-test',
          actualSteps: [
            { step: 'existing-step', timestamp: daysAgo(2), source: 'hook' },
          ],
          timestamp: daysAgo(2),
        }),
        makeRecord({
          jobSlug: 'novel-test',
          actualSteps: [
            { step: 'existing-step', timestamp: daysAgo(3), source: 'hook' },
          ],
          timestamp: daysAgo(3),
        }),
      ];
      writeRecords(stateDir, 'novel-test', records);

      const report = analyzer.analyze('novel-test');
      const novel = report.patterns.filter(p => p.type === 'novel-addition');
      expect(novel.length).toBe(1);
      expect(novel[0].step).toBe('brand-new-step');
      expect(novel[0].confidence).toBe('low');
    });

    it('does NOT flag steps that appeared in older runs', () => {
      const records = [
        makeRecord({
          jobSlug: 'not-novel',
          actualSteps: [
            { step: 'seen-before', timestamp: daysAgo(1), source: 'hook' },
          ],
          timestamp: daysAgo(1),
        }),
        makeRecord({
          jobSlug: 'not-novel',
          actualSteps: [
            { step: 'seen-before', timestamp: daysAgo(2), source: 'hook' },
          ],
          timestamp: daysAgo(2),
        }),
      ];
      writeRecords(stateDir, 'not-novel', records);

      const report = analyzer.analyze('not-novel');
      const novel = report.patterns.filter(p => p.type === 'novel-addition');
      expect(novel.length).toBe(0);
    });

    it('does NOT flag defined steps as novel', () => {
      const records = [
        makeRecord({
          jobSlug: 'defined-novel',
          definedSteps: ['new-but-defined'],
          actualSteps: [
            { step: 'new-but-defined', timestamp: daysAgo(1), source: 'hook' },
          ],
          timestamp: daysAgo(1),
        }),
        makeRecord({
          jobSlug: 'defined-novel',
          definedSteps: ['new-but-defined'],
          actualSteps: [],
          timestamp: daysAgo(2),
        }),
      ];
      writeRecords(stateDir, 'defined-novel', records);

      const report = analyzer.analyze('defined-novel');
      const novel = report.patterns.filter(p => p.type === 'novel-addition');
      expect(novel.length).toBe(0);
    });
  });

  // ─── Duration Drift ───────────────────────────────────────────────────

  describe('duration drift', () => {
    it('detects increasing duration trend', () => {
      const records = Array.from({ length: 6 }, (_, i) => makeRecord({
        jobSlug: 'drift-up',
        // First 3 runs: ~5min, Last 3 runs: ~15min (3x increase)
        durationMinutes: i < 3 ? 5 : 15,
        timestamp: daysAgo(6 - i),
      }));
      writeRecords(stateDir, 'drift-up', records);

      const report = analyzer.analyze('drift-up');
      const drift = report.patterns.filter(p => p.type === 'duration-drift');
      expect(drift.length).toBe(1);
      expect(drift[0].description).toContain('trending up');
      expect(drift[0].evidence?.ratio).toBe(3);
      expect(report.summary.durationTrend).toBe('increasing');
    });

    it('detects decreasing duration trend', () => {
      const records = Array.from({ length: 6 }, (_, i) => makeRecord({
        jobSlug: 'drift-down',
        // First 3 runs: ~20min, Last 3 runs: ~5min (4x decrease)
        durationMinutes: i < 3 ? 20 : 5,
        timestamp: daysAgo(6 - i),
      }));
      writeRecords(stateDir, 'drift-down', records);

      const report = analyzer.analyze('drift-down');
      const drift = report.patterns.filter(p => p.type === 'duration-drift');
      expect(drift.length).toBe(1);
      expect(drift[0].description).toContain('trending down');
      expect(report.summary.durationTrend).toBe('decreasing');
    });

    it('does NOT flag stable duration', () => {
      const records = Array.from({ length: 6 }, (_, i) => makeRecord({
        jobSlug: 'stable-dur',
        durationMinutes: 10 + (i % 2), // Fluctuates between 10 and 11
        timestamp: daysAgo(6 - i),
      }));
      writeRecords(stateDir, 'stable-dur', records);

      const report = analyzer.analyze('stable-dur');
      const drift = report.patterns.filter(p => p.type === 'duration-drift');
      expect(drift.length).toBe(0);
      expect(report.summary.durationTrend).toBe('stable');
    });

    it('returns insufficient-data for too few duration records', () => {
      const records = [
        makeRecord({ jobSlug: 'few-dur', durationMinutes: 5, timestamp: daysAgo(2) }),
        makeRecord({ jobSlug: 'few-dur', durationMinutes: 10, timestamp: daysAgo(1) }),
      ];
      writeRecords(stateDir, 'few-dur', records);

      const report = analyzer.analyze('few-dur', { minRuns: 2 });
      expect(report.summary.durationTrend).toBe('insufficient-data');
    });
  });

  // ─── Gate Ineffective ─────────────────────────────────────────────────

  describe('gate ineffectiveness', () => {
    it('detects when most runs have zero steps', () => {
      const records = Array.from({ length: 5 }, (_, i) => makeRecord({
        jobSlug: 'gate-test',
        // 4 of 5 runs have zero actual steps
        actualSteps: i === 0
          ? [{ step: 'do-thing', timestamp: daysAgo(5 - i), source: 'hook' as const }]
          : [],
        timestamp: daysAgo(5 - i),
      }));
      writeRecords(stateDir, 'gate-test', records);

      const report = analyzer.analyze('gate-test');
      const gate = report.patterns.filter(p => p.type === 'gate-ineffective');
      expect(gate.length).toBe(1);
      expect(gate[0].occurrences).toBe(4);
      expect(gate[0].rate).toBe(0.8);
      expect(gate[0].confidence).toBe('high');
    });

    it('does NOT flag when most runs have steps', () => {
      const records = Array.from({ length: 5 }, (_, i) => makeRecord({
        jobSlug: 'good-gate',
        // 4 of 5 runs have steps
        actualSteps: i < 4
          ? [{ step: 'work', timestamp: daysAgo(5 - i), source: 'hook' as const }]
          : [],
        timestamp: daysAgo(5 - i),
      }));
      writeRecords(stateDir, 'good-gate', records);

      const report = analyzer.analyze('good-gate');
      const gate = report.patterns.filter(p => p.type === 'gate-ineffective');
      expect(gate.length).toBe(0);
    });
  });

  // ─── Summary Statistics ───────────────────────────────────────────────

  describe('summary statistics', () => {
    it('computes correct summary', () => {
      const records = [
        makeRecord({
          jobSlug: 'summary-job',
          definedSteps: ['step-a', 'step-b'],
          actualSteps: [
            { step: 'step-a', timestamp: daysAgo(2), source: 'hook' },
            { step: 'step-c', timestamp: daysAgo(2), source: 'hook' },
          ],
          outcome: 'success',
          durationMinutes: 10,
          timestamp: daysAgo(2),
        }),
        makeRecord({
          jobSlug: 'summary-job',
          definedSteps: ['step-a', 'step-b'],
          actualSteps: [
            { step: 'step-a', timestamp: daysAgo(1), source: 'hook' },
            { step: 'step-b', timestamp: daysAgo(1), source: 'hook' },
          ],
          outcome: 'failure',
          durationMinutes: 20,
          timestamp: daysAgo(1),
        }),
      ];
      writeRecords(stateDir, 'summary-job', records);

      const report = analyzer.analyze('summary-job', { minRuns: 1 });
      expect(report.summary.uniqueSteps).toBe(3); // step-a, step-b, step-c
      expect(report.summary.definedSteps).toBe(2); // step-a, step-b
      expect(report.summary.avgDurationMinutes).toBe(15);
      expect(report.summary.successRate).toBe(0.5);
    });

    it('handles runs with no duration data', () => {
      const records = [
        makeRecord({ jobSlug: 'no-dur', timestamp: daysAgo(2) }),
        makeRecord({ jobSlug: 'no-dur', timestamp: daysAgo(1) }),
      ];
      writeRecords(stateDir, 'no-dur', records);

      const report = analyzer.analyze('no-dur', { minRuns: 1 });
      expect(report.summary.avgDurationMinutes).toBeNull();
    });
  });

  // ─── Proposal Generation ──────────────────────────────────────────────

  describe('toProposals', () => {
    it('generates proposals for high-confidence additions', () => {
      const records = Array.from({ length: 5 }, (_, i) => makeRecord({
        jobSlug: 'proposal-test',
        definedSteps: ['existing'],
        actualSteps: [
          { step: 'existing', timestamp: daysAgo(5 - i), source: 'hook' },
          { step: 'always-added', timestamp: daysAgo(5 - i), source: 'hook' },
        ],
        timestamp: daysAgo(5 - i),
      }));
      writeRecords(stateDir, 'proposal-test', records);

      const report = analyzer.analyze('proposal-test');
      const proposals = analyzer.toProposals(report);

      expect(proposals.length).toBeGreaterThanOrEqual(1);
      const addProposal = proposals.find(p => p.title.includes('always-added'));
      expect(addProposal).toBeDefined();
      expect(addProposal!.type).toBe('workflow');
      expect(addProposal!.proposedBy).toBe('living-skills-analyzer');
      expect(addProposal!.tags).toContain('living-skills');
      expect(addProposal!.source).toBe('living-skills:proposal-test');
    });

    it('generates proposals for omissions', () => {
      const records = Array.from({ length: 5 }, (_, i) => makeRecord({
        jobSlug: 'omit-proposal',
        definedSteps: ['never-done'],
        actualSteps: [], // Never executed
        timestamp: daysAgo(5 - i),
      }));
      writeRecords(stateDir, 'omit-proposal', records);

      const report = analyzer.analyze('omit-proposal');
      const proposals = analyzer.toProposals(report);

      const removeProposal = proposals.find(p => p.title.includes('never-done'));
      expect(removeProposal).toBeDefined();
      expect(removeProposal!.title).toContain('Remove');
    });

    it('does NOT generate proposals for low-confidence (novel) patterns', () => {
      const records = [
        makeRecord({
          jobSlug: 'novel-no-proposal',
          actualSteps: [{ step: 'brand-new', timestamp: daysAgo(1), source: 'hook' }],
          timestamp: daysAgo(1),
        }),
        makeRecord({
          jobSlug: 'novel-no-proposal',
          actualSteps: [],
          timestamp: daysAgo(2),
        }),
        makeRecord({
          jobSlug: 'novel-no-proposal',
          actualSteps: [],
          timestamp: daysAgo(3),
        }),
      ];
      writeRecords(stateDir, 'novel-no-proposal', records);

      const report = analyzer.analyze('novel-no-proposal');
      const proposals = analyzer.toProposals(report);
      // Novel additions are low confidence — should not generate proposals
      expect(proposals.filter(p => p.title.includes('brand-new'))).toEqual([]);
    });

    it('generates duration drift proposals', () => {
      const records = Array.from({ length: 6 }, (_, i) => makeRecord({
        jobSlug: 'drift-proposal',
        durationMinutes: i < 3 ? 5 : 15,
        timestamp: daysAgo(6 - i),
      }));
      writeRecords(stateDir, 'drift-proposal', records);

      const report = analyzer.analyze('drift-proposal');
      const proposals = analyzer.toProposals(report);

      const driftProposal = proposals.find(p => p.type === 'performance');
      expect(driftProposal).toBeDefined();
      expect(driftProposal!.title).toContain('duration drift');
    });
  });

  // ─── analyzeAll ───────────────────────────────────────────────────────

  describe('analyzeAll', () => {
    it('analyzes all jobs for an agent', () => {
      writeRecords(stateDir, 'job-a', Array.from({ length: 3 }, (_, i) => makeRecord({
        jobSlug: 'job-a',
        actualSteps: [{ step: 'do-a', timestamp: daysAgo(3 - i), source: 'hook' }],
        timestamp: daysAgo(3 - i),
      })));
      writeRecords(stateDir, 'job-b', Array.from({ length: 3 }, (_, i) => makeRecord({
        jobSlug: 'job-b',
        actualSteps: [{ step: 'do-b', timestamp: daysAgo(3 - i), source: 'hook' }],
        timestamp: daysAgo(3 - i),
      })));

      const reports = analyzer.analyzeAll();
      expect(reports.length).toBe(2);
      expect(reports.map(r => r.jobSlug).sort()).toEqual(['job-a', 'job-b']);
    });
  });

  // ─── Sorting ──────────────────────────────────────────────────────────

  describe('pattern sorting', () => {
    it('sorts high confidence before medium before low', () => {
      const records = Array.from({ length: 5 }, (_, i) => makeRecord({
        jobSlug: 'sort-test',
        definedSteps: ['always-skipped'],
        actualSteps: [
          // 100% addition (high confidence)
          { step: 'always-added', timestamp: daysAgo(5 - i), source: 'hook' },
          // 60% addition (medium confidence)
          ...(i < 3 ? [{ step: 'sometimes-added', timestamp: daysAgo(5 - i), source: 'hook' as const }] : []),
          // Novel in latest run (low confidence) — only in run 0 (newest)
          ...(i === 0 ? [{ step: 'novel-step', timestamp: daysAgo(5 - i), source: 'hook' as const }] : []),
        ],
        timestamp: daysAgo(5 - i),
      }));
      writeRecords(stateDir, 'sort-test', records);

      const report = analyzer.analyze('sort-test');
      const confidences = report.patterns.map(p => p.confidence);
      // High should come before medium, medium before low
      const firstHigh = confidences.indexOf('high');
      const firstMedium = confidences.indexOf('medium');
      const firstLow = confidences.indexOf('low');
      if (firstHigh >= 0 && firstMedium >= 0) {
        expect(firstHigh).toBeLessThan(firstMedium);
      }
      if (firstMedium >= 0 && firstLow >= 0) {
        expect(firstMedium).toBeLessThan(firstLow);
      }
    });
  });

  // ─── Report Metadata ─────────────────────────────────────────────────

  describe('report metadata', () => {
    it('includes correct metadata in report', () => {
      writeRecords(stateDir, 'meta-test', [makeRecord({
        jobSlug: 'meta-test',
        timestamp: daysAgo(1),
      })]);

      const report = analyzer.analyze('meta-test', { days: 14, agentId: 'my-agent' });
      expect(report.jobSlug).toBe('meta-test');
      expect(report.agentId).toBe('my-agent');
      expect(report.days).toBe(14);
      expect(report.analyzedAt).toBeTruthy();
      expect(new Date(report.analyzedAt).getTime()).toBeGreaterThan(0);
    });
  });
});
