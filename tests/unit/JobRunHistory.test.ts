/**
 * Unit tests for JobRunHistory
 *
 * Tests the JobRunHistory class directly:
 * permanent storage, output capture, reflection persistence,
 * compaction without data loss, query/stats.
 *
 * History is memory. Memory should never be lost.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JobRunHistory } from '../../src/scheduler/JobRunHistory.js';
import type { JobRun, JobRunReflection } from '../../src/scheduler/JobRunHistory.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// ── Helpers ──────────────────────────────────────────────────────────

function createTempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-history-e2e-'));
  fs.mkdirSync(path.join(dir, 'ledger'), { recursive: true });
  return dir;
}

function readRawJSONL(stateDir: string): JobRun[] {
  const file = path.join(stateDir, 'ledger', 'job-runs.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').trim().split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function writeRawJSONL(stateDir: string, runs: JobRun[]): void {
  const file = path.join(stateDir, 'ledger', 'job-runs.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, runs.map(r => JSON.stringify(r)).join('\n') + '\n');
}

// ── Tests ────────────────────────────────────────────────────────────

describe('JobRunHistory unit tests', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = createTempStateDir();
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/JobRunHistory.test.ts:51' });
  });

  // ── Scenario 1: Complete run lifecycle ──────────────────────────────

  describe('complete run lifecycle (start → complete → reflect)', () => {
    it('records the full lifecycle of a job run with all fields', () => {
      const history = new JobRunHistory(stateDir);

      // Step 1: Record job start
      const runId = history.recordStart({
        slug: 'health-check',
        sessionId: 'job-health-check-abc123',
        trigger: 'scheduled',
        model: 'haiku',
      });
      expect(runId).toContain('health-check');

      // Step 2: Verify pending state
      const pending = history.findRun(runId);
      expect(pending).not.toBeNull();
      expect(pending!.result).toBe('pending');
      expect(pending!.slug).toBe('health-check');
      expect(pending!.sessionId).toBe('job-health-check-abc123');
      expect(pending!.trigger).toBe('scheduled');
      expect(pending!.model).toBe('haiku');
      expect(pending!.completedAt).toBeUndefined();

      // Step 3: Record completion with output
      history.recordCompletion({
        runId,
        result: 'success',
        outputSummary: 'Health check passed. All systems operational.',
      });

      // Step 4: Verify completed state
      const completed = history.findRun(runId);
      expect(completed).not.toBeNull();
      expect(completed!.result).toBe('success');
      expect(completed!.completedAt).toBeDefined();
      expect(completed!.durationSeconds).toBeGreaterThanOrEqual(0);
      expect(completed!.outputSummary).toBe('Health check passed. All systems operational.');
      expect(completed!.error).toBeUndefined();

      // Step 5: Attach reflection
      const reflection: JobRunReflection = {
        summary: 'Health check completed successfully with all endpoints responsive.',
        strengths: ['Fast execution', 'All checks passed'],
        improvements: ['Could check disk space too'],
        deviationAnalysis: null,
        purposeDrift: null,
        suggestedChanges: ['Add disk space check to health-check job'],
      };
      history.recordReflection(runId, reflection);

      // Step 6: Verify reflection is stored
      const reflected = history.findRun(runId);
      expect(reflected!.reflection).toBeDefined();
      expect(reflected!.reflection!.summary).toContain('Health check completed successfully');
      expect(reflected!.reflection!.strengths).toHaveLength(2);
      expect(reflected!.reflection!.improvements).toHaveLength(1);
      expect(reflected!.reflection!.suggestedChanges).toHaveLength(1);

      // Step 7: Verify JSONL has 3 entries (pending + completed + reflected) for same runId
      const rawLines = readRawJSONL(stateDir);
      const runLines = rawLines.filter(r => r.runId === runId);
      expect(runLines).toHaveLength(3);
      expect(runLines[0].result).toBe('pending');
      expect(runLines[1].result).toBe('success');
      expect(runLines[2].reflection).toBeDefined();
    });

    it('records failure with error context', () => {
      const history = new JobRunHistory(stateDir);

      const runId = history.recordStart({
        slug: 'email-check',
        sessionId: 'job-email-check-def456',
        trigger: 'manual',
        model: 'sonnet',
      });

      history.recordCompletion({
        runId,
        result: 'failure',
        error: 'Session failed (job-email-check-def456)',
        outputSummary: 'Error: IMAP connection timed out after 30s',
      });

      const run = history.findRun(runId);
      expect(run!.result).toBe('failure');
      expect(run!.error).toContain('Session failed');
      expect(run!.outputSummary).toContain('IMAP connection timed out');
    });

    it('records timeout (killed session)', () => {
      const history = new JobRunHistory(stateDir);

      const runId = history.recordStart({
        slug: 'long-job',
        sessionId: 'job-long-job-ghi789',
        trigger: 'scheduled',
        model: 'opus',
      });

      history.recordCompletion({
        runId,
        result: 'timeout',
        error: 'Session killed (exceeded max duration)',
      });

      const run = history.findRun(runId);
      expect(run!.result).toBe('timeout');
    });

    it('is idempotent — late completion writes are dropped (wake-reaper race)', () => {
      // Phantom-completion race: reaper writes 'timeout' after wake, then the
      // session manager's late callback fires 'success' for the same runId.
      // First writer wins; the late call is a no-op.
      const history = new JobRunHistory(stateDir);

      const runId = history.recordStart({
        slug: 'racy-job',
        sessionId: 'job-racy-job-1',
        trigger: 'scheduled',
      });

      // Reaper writes first.
      history.recordCompletion({
        runId,
        result: 'timeout',
        error: 'Reaped on wake',
      });

      // Late completion arrives — must be ignored.
      history.recordCompletion({ runId, result: 'success', outputSummary: 'done' });

      const run = history.findRun(runId);
      expect(run!.result).toBe('timeout');
      expect(run!.error).toBe('Reaped on wake');
      // No 'success' or 'done' bled into the surviving record.
      expect(run!.outputSummary).toBeUndefined();
    });
  });

  // ── Scenario 2: Spawn error lifecycle ──────────────────────────────

  describe('spawn error lifecycle', () => {
    it('records spawn errors with full context', () => {
      const history = new JobRunHistory(stateDir);

      const runId = history.recordSpawnError({
        slug: 'health-check',
        trigger: 'scheduled',
        error: 'Max sessions (3) reached. Running: session-1, session-2, session-3',
        model: 'haiku',
      });

      const run = history.findRun(runId);
      expect(run).not.toBeNull();
      expect(run!.result).toBe('spawn-error');
      expect(run!.durationSeconds).toBe(0);
      expect(run!.sessionId).toBe('');
      expect(run!.error).toContain('Max sessions');
      expect(run!.startedAt).toBe(run!.completedAt);
    });
  });

  // ── Scenario 3: Permanent retention (no deletion) ──────────────────

  describe('permanent retention — nothing is ever deleted', () => {
    it('keeps all runs across constructor reinitializations', () => {
      // Phase 1: Create runs across multiple history instances
      const h1 = new JobRunHistory(stateDir);
      h1.recordSpawnError({ slug: 'job-a', trigger: 'scheduled', error: 'err1' });
      h1.recordSpawnError({ slug: 'job-b', trigger: 'manual', error: 'err2' });

      // Phase 2: Create new instance (triggers compaction on startup)
      const h2 = new JobRunHistory(stateDir);
      h2.recordSpawnError({ slug: 'job-c', trigger: 'scheduled', error: 'err3' });

      // Phase 3: Create yet another instance
      const h3 = new JobRunHistory(stateDir);

      // All 3 runs should exist
      const { runs, total } = h3.query();
      expect(total).toBe(3);
      expect(runs.map(r => r.slug).sort()).toEqual(['job-a', 'job-b', 'job-c']);
    });

    it('preserves runs from weeks ago without any rotation', () => {
      const history = new JobRunHistory(stateDir);

      // Manually write runs with old timestamps
      const oldRun: JobRun = {
        runId: 'old-run-1',
        slug: 'ancient-job',
        sessionId: 'session-old',
        trigger: 'scheduled',
        startedAt: '2025-01-01T00:00:00.000Z',
        completedAt: '2025-01-01T00:05:00.000Z',
        durationSeconds: 300,
        result: 'success',
        model: 'haiku',
        outputSummary: 'This ran a long time ago.',
        reflection: {
          summary: 'Ancient job completed normally.',
          strengths: ['Reliable'],
          improvements: [],
          deviationAnalysis: null,
          purposeDrift: null,
          suggestedChanges: [],
        },
      };
      writeRawJSONL(stateDir, [oldRun]);

      // Create new instance — this triggers compaction
      const h2 = new JobRunHistory(stateDir);

      // Old run must still exist
      const run = h2.findRun('old-run-1');
      expect(run).not.toBeNull();
      expect(run!.slug).toBe('ancient-job');
      expect(run!.startedAt).toBe('2025-01-01T00:00:00.000Z');
      expect(run!.outputSummary).toBe('This ran a long time ago.');
      expect(run!.reflection!.summary).toBe('Ancient job completed normally.');

      // Add a new run
      h2.recordSpawnError({ slug: 'new-job', trigger: 'manual', error: 'test' });

      // Both old and new exist
      const { total } = h2.query();
      expect(total).toBe(2);
    });
  });

  // ── Scenario 4: Compaction deduplicates without losing data ────────

  describe('compaction lifecycle', () => {
    it('deduplicates pending→completed pairs on startup', () => {
      const history = new JobRunHistory(stateDir);

      // Create a run with full lifecycle (3 JSONL lines: pending + completed + reflected)
      const runId = history.recordStart({
        slug: 'test-job',
        sessionId: 'sess-1',
        trigger: 'scheduled',
      });
      history.recordCompletion({ runId, result: 'success', outputSummary: 'done' });
      history.recordReflection(runId, {
        summary: 'All good.',
        strengths: ['Fast'],
        improvements: [],
        deviationAnalysis: null,
        purposeDrift: null,
        suggestedChanges: [],
      });

      // Before compaction: 3 raw lines
      const rawBefore = readRawJSONL(stateDir);
      expect(rawBefore).toHaveLength(3);

      // Create new instance (triggers compaction)
      const h2 = new JobRunHistory(stateDir);

      // After compaction: 1 raw line (the final state)
      const rawAfter = readRawJSONL(stateDir);
      expect(rawAfter).toHaveLength(1);

      // The surviving entry has ALL fields from the final state
      const entry = rawAfter[0];
      expect(entry.runId).toBe(runId);
      expect(entry.result).toBe('success');
      expect(entry.outputSummary).toBe('done');
      expect(entry.reflection!.summary).toBe('All good.');

      // Query still returns the run
      const found = h2.findRun(runId);
      expect(found).not.toBeNull();
      expect(found!.reflection).toBeDefined();
    });

    it('preserves multiple distinct runs during compaction', () => {
      const history = new JobRunHistory(stateDir);

      // Create 5 distinct runs
      for (let i = 0; i < 5; i++) {
        const runId = history.recordStart({
          slug: `job-${i}`,
          sessionId: `sess-${i}`,
          trigger: 'scheduled',
        });
        history.recordCompletion({ runId, result: 'success' });
      }

      // 10 raw lines before compaction (2 per run)
      expect(readRawJSONL(stateDir)).toHaveLength(10);

      // Compact
      const h2 = new JobRunHistory(stateDir);

      // 5 raw lines after compaction (1 per run)
      expect(readRawJSONL(stateDir)).toHaveLength(5);

      // All 5 runs are queryable
      const { total } = h2.query();
      expect(total).toBe(5);
    });
  });

  // ── Scenario 5: Query and filtering ────────────────────────────────

  describe('query and filtering', () => {
    let history: JobRunHistory;

    beforeEach(() => {
      history = new JobRunHistory(stateDir);

      // Create a mix of runs
      const r1 = history.recordStart({ slug: 'job-a', sessionId: 's1', trigger: 'scheduled', model: 'haiku' });
      history.recordCompletion({ runId: r1, result: 'success' });

      const r2 = history.recordStart({ slug: 'job-a', sessionId: 's2', trigger: 'manual', model: 'haiku' });
      history.recordCompletion({ runId: r2, result: 'failure', error: 'crashed' });

      const r3 = history.recordStart({ slug: 'job-b', sessionId: 's3', trigger: 'scheduled', model: 'sonnet' });
      history.recordCompletion({ runId: r3, result: 'success' });

      history.recordSpawnError({ slug: 'job-a', trigger: 'scheduled', error: 'max sessions', model: 'haiku' });
    });

    it('queries all runs without filters', () => {
      const { runs, total } = history.query();
      expect(total).toBe(4);
      // Verify all result types are present
      const results = runs.map(r => r.result).sort();
      expect(results).toEqual(['failure', 'spawn-error', 'success', 'success']);
    });

    it('filters by slug', () => {
      const { runs, total } = history.query({ slug: 'job-a' });
      expect(total).toBe(3);
      runs.forEach(r => expect(r.slug).toBe('job-a'));
    });

    it('filters by result', () => {
      const { runs, total } = history.query({ result: 'failure' });
      expect(total).toBe(1);
      expect(runs[0].error).toBe('crashed');
    });

    it('supports pagination with limit and offset', () => {
      const page1 = history.query({ limit: 2, offset: 0 });
      expect(page1.runs).toHaveLength(2);
      expect(page1.total).toBe(4);

      const page2 = history.query({ limit: 2, offset: 2 });
      expect(page2.runs).toHaveLength(2);

      // Different runs on different pages
      const page1Ids = page1.runs.map(r => r.runId);
      const page2Ids = page2.runs.map(r => r.runId);
      expect(page1Ids).not.toEqual(page2Ids);
    });

    it('returns results sorted by startedAt descending', () => {
      const { runs } = history.query();
      for (let i = 1; i < runs.length; i++) {
        expect(runs[i - 1].startedAt >= runs[i].startedAt).toBe(true);
      }
    });
  });

  // ── Scenario 6: Stats aggregation ──────────────────────────────────

  describe('stats aggregation', () => {
    it('computes correct stats for a job', () => {
      const history = new JobRunHistory(stateDir);

      // Create 3 successful runs and 1 failure
      for (let i = 0; i < 3; i++) {
        const r = history.recordStart({ slug: 'monitored-job', sessionId: `s${i}`, trigger: 'scheduled' });
        history.recordCompletion({ runId: r, result: 'success' });
      }
      const fail = history.recordStart({ slug: 'monitored-job', sessionId: 's-fail', trigger: 'scheduled' });
      history.recordCompletion({ runId: fail, result: 'failure', error: 'timeout' });

      const stats = history.stats('monitored-job');
      expect(stats.slug).toBe('monitored-job');
      expect(stats.totalRuns).toBe(4);
      expect(stats.successes).toBe(3);
      expect(stats.failures).toBe(1);
      expect(stats.successRate).toBe(75);
      expect(stats.lastRun).toBeDefined();
    });

    it('allStats returns stats for every job', () => {
      const history = new JobRunHistory(stateDir);

      history.recordSpawnError({ slug: 'job-x', trigger: 'scheduled', error: 'err' });
      history.recordSpawnError({ slug: 'job-y', trigger: 'scheduled', error: 'err' });
      history.recordSpawnError({ slug: 'job-y', trigger: 'scheduled', error: 'err' });

      const all = history.allStats();
      expect(all).toHaveLength(2);

      const jobX = all.find(s => s.slug === 'job-x');
      const jobY = all.find(s => s.slug === 'job-y');
      expect(jobX!.totalRuns).toBe(1);
      expect(jobY!.totalRuns).toBe(2);
    });

    it('returns zero stats for unknown job', () => {
      const history = new JobRunHistory(stateDir);
      const stats = history.stats('nonexistent');
      expect(stats.totalRuns).toBe(0);
      expect(stats.successRate).toBe(0);
      expect(stats.avgDurationSeconds).toBe(0);
    });
  });

  // ── Scenario 7: Machine ID tracking ────────────────────────────────

  describe('machine ID tracking', () => {
    it('stamps runs with machine ID when configured', () => {
      const history = new JobRunHistory(stateDir);
      history.setMachineId('m_abc123');

      const runId = history.recordStart({
        slug: 'test-job',
        sessionId: 'sess-1',
        trigger: 'scheduled',
      });

      const run = history.findRun(runId);
      expect(run!.machineId).toBe('m_abc123');
    });

    it('omits machine ID when not configured', () => {
      const history = new JobRunHistory(stateDir);

      const runId = history.recordStart({
        slug: 'test-job',
        sessionId: 'sess-1',
        trigger: 'scheduled',
      });

      const run = history.findRun(runId);
      expect(run!.machineId).toBeUndefined();
    });
  });

  // ── Scenario 8: Corrupted file recovery ────────────────────────────

  describe('corrupted file recovery', () => {
    it('skips corrupted JSONL lines and preserves valid ones', () => {
      const file = path.join(stateDir, 'ledger', 'job-runs.jsonl');
      const validRun: JobRun = {
        runId: 'valid-1',
        slug: 'good-job',
        sessionId: 's1',
        trigger: 'scheduled',
        startedAt: new Date().toISOString(),
        result: 'success',
        completedAt: new Date().toISOString(),
        durationSeconds: 10,
      };

      // Write mix of valid and corrupted lines
      fs.writeFileSync(file, [
        JSON.stringify(validRun),
        '{ this is not valid json !!!',
        '{"runId":"valid-2","slug":"good-job","sessionId":"s2","trigger":"manual","startedAt":"2026-01-01T00:00:00Z","result":"success"}',
      ].join('\n') + '\n');

      const history = new JobRunHistory(stateDir);
      const { runs, total } = history.query();

      // Should have 2 valid runs, corrupted line skipped
      expect(total).toBe(2);
      expect(runs.map(r => r.runId).sort()).toEqual(['valid-1', 'valid-2']);
    });

    it('handles empty file gracefully', () => {
      const file = path.join(stateDir, 'ledger', 'job-runs.jsonl');
      fs.writeFileSync(file, '');

      const history = new JobRunHistory(stateDir);
      const { runs, total } = history.query();
      expect(total).toBe(0);
      expect(runs).toHaveLength(0);
    });

    it('handles missing file gracefully', () => {
      const history = new JobRunHistory(stateDir);
      const { runs, total } = history.query();
      expect(total).toBe(0);
      expect(runs).toHaveLength(0);
    });
  });

  // ── Scenario 9: Handoff notes (execution-to-execution continuity) ──

  describe('handoff notes — execution-to-execution continuity', () => {
    it('records and retrieves handoff notes for the next execution', () => {
      const history = new JobRunHistory(stateDir);

      // Run 1: complete with handoff notes
      const runId = history.recordStart({
        slug: 'tracker',
        sessionId: 'sess-1',
        trigger: 'scheduled',
      });
      history.recordCompletion({ runId, result: 'success' });
      history.recordHandoff(runId, 'Check ERROR-128 next time — Safari WebSocket issue.', {
        lastScanned: '2026-03-17T04:00Z',
        errorsTriaged: 4,
      });

      // Retrieve handoff for next execution
      const handoff = history.getLastHandoff('tracker');
      expect(handoff).not.toBeNull();
      expect(handoff!.handoffNotes).toBe('Check ERROR-128 next time — Safari WebSocket issue.');
      expect(handoff!.stateSnapshot).toEqual({
        lastScanned: '2026-03-17T04:00Z',
        errorsTriaged: 4,
      });
      expect(handoff!.fromRunId).toBe(runId);
      expect(handoff!.fromSession).toBe('sess-1');
    });

    it('returns the most recent handoff when multiple exist', () => {
      const history = new JobRunHistory(stateDir);

      // Run 1
      const r1 = history.recordStart({ slug: 'tracker', sessionId: 's1', trigger: 'scheduled' });
      history.recordCompletion({ runId: r1, result: 'success' });
      history.recordHandoff(r1, 'Old notes');

      // Run 2
      const r2 = history.recordStart({ slug: 'tracker', sessionId: 's2', trigger: 'scheduled' });
      history.recordCompletion({ runId: r2, result: 'success' });
      history.recordHandoff(r2, 'Fresh notes');

      const handoff = history.getLastHandoff('tracker');
      expect(handoff!.handoffNotes).toBe('Fresh notes');
      expect(handoff!.fromSession).toBe('s2');
    });

    it('returns null when no handoff notes exist', () => {
      const history = new JobRunHistory(stateDir);

      const r = history.recordStart({ slug: 'tracker', sessionId: 's1', trigger: 'scheduled' });
      history.recordCompletion({ runId: r, result: 'success' });

      const handoff = history.getLastHandoff('tracker');
      expect(handoff).toBeNull();
    });

    it('skips pending runs when looking for handoff', () => {
      const history = new JobRunHistory(stateDir);

      // Completed run with handoff
      const r1 = history.recordStart({ slug: 'tracker', sessionId: 's1', trigger: 'scheduled' });
      history.recordCompletion({ runId: r1, result: 'success' });
      history.recordHandoff(r1, 'From completed run');

      // Pending run (should be skipped)
      history.recordStart({ slug: 'tracker', sessionId: 's2', trigger: 'scheduled' });

      const handoff = history.getLastHandoff('tracker');
      expect(handoff!.handoffNotes).toBe('From completed run');
    });

    it('survives compaction', () => {
      const h1 = new JobRunHistory(stateDir);

      const r = h1.recordStart({ slug: 'tracker', sessionId: 's1', trigger: 'scheduled' });
      h1.recordCompletion({ runId: r, result: 'success' });
      h1.recordHandoff(r, 'Survives compaction', { key: 'value' });

      // Create new instance (triggers compaction)
      const h2 = new JobRunHistory(stateDir);

      const handoff = h2.getLastHandoff('tracker');
      expect(handoff).not.toBeNull();
      expect(handoff!.handoffNotes).toBe('Survives compaction');
      expect(handoff!.stateSnapshot).toEqual({ key: 'value' });
    });

    it('handles handoff for non-existent runId gracefully', () => {
      const history = new JobRunHistory(stateDir);
      history.recordHandoff('nonexistent', 'Should not crash');
      const handoff = history.getLastHandoff('any-slug');
      expect(handoff).toBeNull();
    });
  });

  // ── Scenario 10: Reflection without prior run ─────────────────────

  describe('reflection edge cases', () => {
    it('handles reflection for non-existent runId gracefully', () => {
      const history = new JobRunHistory(stateDir);

      // Should warn but not crash
      history.recordReflection('nonexistent-run-id', {
        summary: 'Orphaned reflection',
        strengths: [],
        improvements: [],
        deviationAnalysis: null,
        purposeDrift: null,
        suggestedChanges: [],
      });

      // No runs should exist
      const { total } = history.query();
      expect(total).toBe(0);
    });

    it('handles completion for non-existent runId gracefully', () => {
      const history = new JobRunHistory(stateDir);

      // Should warn but not crash
      history.recordCompletion({
        runId: 'ghost-run',
        result: 'success',
      });

      const { total } = history.query();
      expect(total).toBe(0);
    });
  });
});

