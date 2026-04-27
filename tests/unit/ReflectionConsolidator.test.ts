/**
 * Unit tests for ReflectionConsolidator — Living Skills Phase 3.
 *
 * Tests cover:
 * - Empty journal consolidation
 * - Pattern-to-proposal pipeline (creates proposals in EvolutionManager)
 * - Deduplication against existing proposals
 * - Learning registry population (novel additions → learnings)
 * - Dry-run mode (no writes)
 * - Consolidation report structure
 * - Telegram summary formatting
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ReflectionConsolidator } from '../../src/core/ReflectionConsolidator.js';
import { ExecutionJournal } from '../../src/core/ExecutionJournal.js';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';
import type { ExecutionRecord } from '../../src/core/types.js';

/** Return an ISO timestamp for N days ago */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

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

function writeRecords(stateDir: string, jobSlug: string, records: ExecutionRecord[], agentId = 'default'): void {
  const dir = path.join(stateDir, 'state', 'execution-journal', agentId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${jobSlug}.jsonl`);
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(file, content);
}

describe('ReflectionConsolidator', () => {
  let tmpDir: string;
  let stateDir: string;
  let consolidator: ReflectionConsolidator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidator-'));
    stateDir = tmpDir;
    consolidator = new ReflectionConsolidator(stateDir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Empty State ──────────────────────────────────────────────────

  describe('empty state', () => {
    it('returns empty result when no journals exist', () => {
      const result = consolidator.consolidate();
      expect(result.jobsAnalyzed).toBe(0);
      expect(result.totalRunsAnalyzed).toBe(0);
      expect(result.patternsDetected).toBe(0);
      expect(result.proposalsCreated).toEqual([]);
      expect(result.proposalsSkipped).toBe(0);
      expect(result.learningsCreated).toBe(0);
      expect(result.jobSummaries).toEqual([]);
    });

    it('returns no-patterns summary', () => {
      const result = consolidator.consolidate();
      const summary = consolidator.formatSummary(result);
      expect(summary).toContain('No patterns detected');
    });
  });

  // ─── Proposal Creation ────────────────────────────────────────────

  describe('proposal creation', () => {
    it('creates proposals for consistent patterns', () => {
      // 5 runs with consistent addition: "extra-step" in all runs
      const records = Array.from({ length: 5 }, (_, i) => {
        const ts = daysAgo(i + 1);
        return makeRecord({
          jobSlug: 'my-job',
          definedSteps: ['step-a'],
          actualSteps: [
            { step: 'step-a', timestamp: ts, source: 'hook' },
            { step: 'extra-step', timestamp: ts, source: 'hook' },
          ],
          timestamp: ts,
        });
      });
      writeRecords(stateDir, 'my-job', records);

      const result = consolidator.consolidate();

      expect(result.jobsAnalyzed).toBe(1);
      expect(result.patternsDetected).toBeGreaterThanOrEqual(1);
      expect(result.proposalsCreated.length).toBeGreaterThanOrEqual(1);

      const addProposal = result.proposalsCreated.find(p => p.title.includes('extra-step'));
      expect(addProposal).toBeDefined();
      expect(addProposal!.status).toBe('proposed');
      expect(addProposal!.id).toMatch(/^EVO-/);
    });

    it('writes proposals to EvolutionManager state', () => {
      const records = Array.from({ length: 5 }, (_, i) => {
        const ts = daysAgo(i + 1);
        return makeRecord({
          jobSlug: 'evo-job',
          definedSteps: [],
          actualSteps: [
            { step: 'always-here', timestamp: ts, source: 'hook' },
          ],
          timestamp: ts,
        });
      });
      writeRecords(stateDir, 'evo-job', records);

      consolidator.consolidate();

      // Verify EvolutionManager has the proposal
      const evo = new EvolutionManager({ stateDir });
      const proposals = evo.listProposals();
      expect(proposals.length).toBeGreaterThanOrEqual(1);
      const found = proposals.find(p => p.title.includes('always-here'));
      expect(found).toBeDefined();
    });
  });

  // ─── Deduplication ────────────────────────────────────────────────

  describe('deduplication', () => {
    it('skips proposals that already exist', () => {
      const records = Array.from({ length: 5 }, (_, i) => {
        const ts = daysAgo(i + 1);
        return makeRecord({
          jobSlug: 'dedup-job',
          definedSteps: [],
          actualSteps: [
            { step: 'repeated-step', timestamp: ts, source: 'hook' },
          ],
          timestamp: ts,
        });
      });
      writeRecords(stateDir, 'dedup-job', records);

      // Pre-create the proposal
      const evo = new EvolutionManager({ stateDir });
      evo.addProposal({
        title: 'Add "repeated-step" to dedup-job definition',
        source: 'living-skills:dedup-job',
        description: 'Already exists',
        type: 'workflow',
      });

      const result = consolidator.consolidate();

      expect(result.proposalsSkipped).toBeGreaterThanOrEqual(1);
      // Should not create a second proposal for same step
      const proposals = evo.listProposals();
      const matching = proposals.filter(p => p.title.includes('repeated-step'));
      expect(matching.length).toBe(1);
    });

    it('does not deduplicate against rejected proposals', () => {
      const records = Array.from({ length: 5 }, (_, i) => {
        const ts = daysAgo(i + 1);
        return makeRecord({
          jobSlug: 'rejected-job',
          definedSteps: [],
          actualSteps: [
            { step: 'try-again-step', timestamp: ts, source: 'hook' },
          ],
          timestamp: ts,
        });
      });
      writeRecords(stateDir, 'rejected-job', records);

      // Create and reject a proposal
      const evo = new EvolutionManager({ stateDir });
      const existing = evo.addProposal({
        title: 'Add "try-again-step" to rejected-job definition',
        source: 'living-skills:rejected-job',
        description: 'Was rejected before',
        type: 'workflow',
      });
      evo.updateProposalStatus(existing.id, 'rejected');

      const result = consolidator.consolidate();

      // Should create a new proposal since old one was rejected
      expect(result.proposalsCreated.length).toBeGreaterThanOrEqual(1);
      const newProposal = result.proposalsCreated.find(p => p.title.includes('try-again-step'));
      expect(newProposal).toBeDefined();
    });

    it('prevents self-duplication within a single consolidation run', () => {
      // Two jobs both with the same "deploy-check" step (different sources though)
      // Should not matter for self-dedup since sources differ

      const recordsA = Array.from({ length: 5 }, (_, i) => {
        const ts = daysAgo(i + 1);
        return makeRecord({
          jobSlug: 'job-a',
          definedSteps: [],
          actualSteps: [
            { step: 'common-step', timestamp: ts, source: 'hook' },
          ],
          timestamp: ts,
        });
      });
      const recordsB = Array.from({ length: 5 }, (_, i) => {
        const ts = daysAgo(i + 1);
        return makeRecord({
          jobSlug: 'job-b',
          definedSteps: [],
          actualSteps: [
            { step: 'common-step', timestamp: ts, source: 'hook' },
          ],
          timestamp: ts,
        });
      });
      writeRecords(stateDir, 'job-a', recordsA);
      writeRecords(stateDir, 'job-b', recordsB);

      const result = consolidator.consolidate();

      // Both jobs should get their own proposals (different sources)
      expect(result.proposalsCreated.length).toBe(2);
    });
  });

  // ─── Learnings ────────────────────────────────────────────────────

  describe('learning registry', () => {
    it('creates learnings for novel additions', () => {
      const records = [
        // Latest run has a novel step
        makeRecord({
          jobSlug: 'learn-job',
          actualSteps: [
            { step: 'existing', timestamp: daysAgo(1), source: 'hook' },
            { step: 'brand-new', timestamp: daysAgo(1), source: 'hook' },
          ],
          timestamp: daysAgo(1),
        }),
        makeRecord({
          jobSlug: 'learn-job',
          actualSteps: [
            { step: 'existing', timestamp: daysAgo(2), source: 'hook' },
          ],
          timestamp: daysAgo(2),
        }),
        makeRecord({
          jobSlug: 'learn-job',
          actualSteps: [
            { step: 'existing', timestamp: daysAgo(3), source: 'hook' },
          ],
          timestamp: daysAgo(3),
        }),
      ];
      writeRecords(stateDir, 'learn-job', records);

      const result = consolidator.consolidate();

      expect(result.learningsCreated).toBeGreaterThanOrEqual(1);

      // Verify learning was written to EvolutionManager
      const evo = new EvolutionManager({ stateDir });
      const learnings = evo.listLearnings({ category: 'pattern' });
      const novelLearning = learnings.find(l => l.title.includes('brand-new'));
      expect(novelLearning).toBeDefined();
      expect(novelLearning!.tags).toContain('living-skills');
      expect(novelLearning!.tags).toContain('novel-step');
    });
  });

  // ─── Dry Run ──────────────────────────────────────────────────────

  describe('dry run', () => {
    it('does not write to EvolutionManager in dry-run mode', () => {
      const records = Array.from({ length: 5 }, (_, i) => {
        const ts = daysAgo(i + 1);
        return makeRecord({
          jobSlug: 'dry-job',
          definedSteps: [],
          actualSteps: [
            { step: 'would-be-proposed', timestamp: ts, source: 'hook' },
          ],
          timestamp: ts,
        });
      });
      writeRecords(stateDir, 'dry-job', records);

      const result = consolidator.consolidate({ commit: false });

      // Should report proposals that WOULD be created
      expect(result.proposalsCreated.length).toBeGreaterThanOrEqual(1);

      // But EvolutionManager should have no proposals
      const evo = new EvolutionManager({ stateDir });
      expect(evo.listProposals()).toEqual([]);
    });

    it('dry-run proposals have DRY- prefix IDs', () => {
      const records = Array.from({ length: 5 }, (_, i) => {
        const ts = daysAgo(i + 1);
        return makeRecord({
          jobSlug: 'dry-id-job',
          definedSteps: [],
          actualSteps: [
            { step: 'test-step', timestamp: ts, source: 'hook' },
          ],
          timestamp: ts,
        });
      });
      writeRecords(stateDir, 'dry-id-job', records);

      const result = consolidator.consolidate({ commit: false });
      for (const p of result.proposalsCreated) {
        expect(p.id).toMatch(/^DRY-/);
      }
    });
  });

  // ─── Report Structure ─────────────────────────────────────────────

  describe('consolidation report', () => {
    it('includes correct metadata', () => {
      const result = consolidator.consolidate({ days: 14 });
      expect(result.consolidatedAt).toBeTruthy();
      expect(new Date(result.consolidatedAt).getTime()).toBeGreaterThan(0);
    });

    it('includes per-job summaries with highlights', () => {
      // Create a job with a high-confidence pattern
      const records = Array.from({ length: 5 }, (_, i) => makeRecord({
        jobSlug: 'highlight-job',
        definedSteps: ['never-done'],
        actualSteps: [],
        timestamp: daysAgo(i + 1),
      }));
      writeRecords(stateDir, 'highlight-job', records);

      const result = consolidator.consolidate();

      expect(result.jobSummaries.length).toBe(1);
      expect(result.jobSummaries[0].jobSlug).toBe('highlight-job');
      expect(result.jobSummaries[0].highlights.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Telegram Summary ─────────────────────────────────────────────

  describe('formatSummary', () => {
    it('formats no-patterns summary', () => {
      const result = consolidator.consolidate();
      const summary = consolidator.formatSummary(result);
      expect(summary).toContain('No patterns detected');
    });

    it('formats summary with proposals', () => {
      const records = Array.from({ length: 5 }, (_, i) => {
        const ts = daysAgo(i + 1);
        return makeRecord({
          jobSlug: 'summary-job',
          definedSteps: [],
          actualSteps: [
            { step: 'frequent-step', timestamp: ts, source: 'hook' },
          ],
          timestamp: ts,
        });
      });
      writeRecords(stateDir, 'summary-job', records);

      const result = consolidator.consolidate();
      const summary = consolidator.formatSummary(result);

      expect(summary).toContain('Living Skills Reflection');
      expect(summary).toContain('new proposal');
      expect(summary).toContain('frequent-step');
    });

    it('includes skip and learning counts', () => {
      // Create records with both a repeated pattern (for proposal) and novel step (for learning)
      const records = [
        makeRecord({
          jobSlug: 'mixed-job',
          actualSteps: [
            { step: 'old-step', timestamp: daysAgo(1), source: 'hook' },
            { step: 'novel-thing', timestamp: daysAgo(1), source: 'hook' },
          ],
          timestamp: daysAgo(1),
        }),
        ...Array.from({ length: 4 }, (_, i) => makeRecord({
          jobSlug: 'mixed-job',
          actualSteps: [
            { step: 'old-step', timestamp: daysAgo(i + 2), source: 'hook' },
          ],
          timestamp: daysAgo(i + 2),
        })),
      ];
      writeRecords(stateDir, 'mixed-job', records);

      const result = consolidator.consolidate();
      const summary = consolidator.formatSummary(result);

      expect(summary).toContain('patterns');
      if (result.learningsCreated > 0) {
        expect(summary).toContain('learning');
      }
    });
  });

  // ─── Multi-Job ────────────────────────────────────────────────────

  describe('multi-job consolidation', () => {
    it('consolidates across multiple jobs', () => {
      // Job A: consistent addition
      writeRecords(stateDir, 'job-alpha', Array.from({ length: 5 }, (_, i) => {
        const ts = daysAgo(i + 1);
        return makeRecord({
          jobSlug: 'job-alpha',
          definedSteps: [],
          actualSteps: [
            { step: 'alpha-step', timestamp: ts, source: 'hook' },
          ],
          timestamp: ts,
        });
      }));

      // Job B: consistent omission
      writeRecords(stateDir, 'job-beta', Array.from({ length: 5 }, (_, i) => makeRecord({
        jobSlug: 'job-beta',
        definedSteps: ['never-executed'],
        actualSteps: [],
        timestamp: daysAgo(i + 1),
      })));

      const result = consolidator.consolidate();

      expect(result.jobsAnalyzed).toBe(2);
      expect(result.jobSummaries.length).toBe(2);
      expect(result.proposalsCreated.length).toBeGreaterThanOrEqual(2);

      // Verify both job types are represented
      const alphaProp = result.proposalsCreated.find(p => p.title.includes('alpha-step'));
      const betaProp = result.proposalsCreated.find(p => p.title.includes('never-executed'));
      expect(alphaProp).toBeDefined();
      expect(betaProp).toBeDefined();
    });
  });
});
