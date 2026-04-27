/**
 * CrashLoopPauser Tests
 *
 * Verifies detection thresholds, safety rails (critical / never-pause /
 * already-disabled), and dry-run behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CrashLoopPauser } from '../../src/monitoring/CrashLoopPauser.js';
import { JobRunHistory } from '../../src/scheduler/JobRunHistory.js';
import type { JobDefinition } from '../../src/core/types.js';

function mkJob(over: Partial<JobDefinition>): JobDefinition {
  return {
    slug: 'sample',
    name: 'Sample',
    description: 'd',
    schedule: '0 * * * *',
    priority: 'medium',
    expectedDurationMinutes: 5,
    model: 'sonnet',
    enabled: true,
    execute: { type: 'prompt', prompt: 'noop' } as unknown as JobDefinition['execute'],
    ...over,
  };
}

describe('CrashLoopPauser', () => {
  let dir: string;
  let history: JobRunHistory;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clp-'));
    history = new JobRunHistory(dir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function recordFailures(slug: string, count: number, durationSeconds = 120) {
    for (let i = 0; i < count; i++) {
      const runId = history.recordStart({ slug, sessionId: `s-${i}`, trigger: 'scheduled' });
      history.recordCompletion({ runId, result: 'failure', error: 'boom' });
      // Patch duration by re-appending (durationSeconds is computed from timestamps
      // in recordCompletion, so we manually rewrite the last line for short-run tests)
      if (durationSeconds < 60) {
        const file = path.join(dir, 'ledger', 'job-runs.jsonl');
        const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
        const last = JSON.parse(lines[lines.length - 1]);
        last.durationSeconds = durationSeconds;
        lines[lines.length - 1] = JSON.stringify(last);
        fs.writeFileSync(file, lines.join('\n') + '\n');
      }
    }
  }

  it('flags job with 3+ failures in 24h', () => {
    recordFailures('runaway', 3);
    const pauser = new CrashLoopPauser(history);
    const candidates = pauser.evaluate([mkJob({ slug: 'runaway' })]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].reason).toBe('failures');
    expect(candidates[0].failureCount).toBe(3);
  });

  it('flags job with 5+ short-duration failures (bootstrap crashes)', () => {
    recordFailures('bootloop', 5, 10);
    // override thresholds so these 5 count as short-runs, not failures first
    const pauser = new CrashLoopPauser(history, { failureThreshold: 99 });
    const candidates = pauser.evaluate([mkJob({ slug: 'bootloop' })]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].reason).toBe('short-runs');
    expect(candidates[0].shortRunCount).toBe(5);
  });

  it('does not flag jobs under threshold', () => {
    recordFailures('fine', 2);
    const pauser = new CrashLoopPauser(history);
    expect(pauser.evaluate([mkJob({ slug: 'fine' })])).toHaveLength(0);
  });

  it('never pauses priority=critical jobs', () => {
    recordFailures('critical-job', 10);
    const pauser = new CrashLoopPauser(history);
    const candidates = pauser.evaluate([
      mkJob({ slug: 'critical-job', priority: 'critical' }),
    ]);
    expect(candidates).toHaveLength(0);
  });

  it('never pauses jobs in the never-pause deny-list', () => {
    recordFailures('protected', 10);
    const pauser = new CrashLoopPauser(history, {
      neverPause: new Set(['protected']),
    });
    expect(pauser.evaluate([mkJob({ slug: 'protected' })])).toHaveLength(0);
  });

  it('ignores already-disabled jobs during evaluate', () => {
    recordFailures('already-off', 10);
    const pauser = new CrashLoopPauser(history);
    expect(
      pauser.evaluate([mkJob({ slug: 'already-off', enabled: false })]),
    ).toHaveLength(0);
  });

  it('dry-run does not mutate jobs file', () => {
    recordFailures('rogue', 3);
    const jobsFile = path.join(dir, 'jobs.json');
    const original = { jobs: [{ slug: 'rogue', enabled: true }] };
    fs.writeFileSync(jobsFile, JSON.stringify(original));
    const pauser = new CrashLoopPauser(history);
    const result = pauser.run({
      jobs: [mkJob({ slug: 'rogue' })],
      jobsFile,
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.paused).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    const after = JSON.parse(fs.readFileSync(jobsFile, 'utf-8'));
    expect(after.jobs[0].enabled).toBe(true);
  });

  it('live run disables jobs and writes crash-pause note + audit trail', () => {
    recordFailures('rogue', 3);
    const jobsFile = path.join(dir, 'jobs.json');
    const original = { jobs: [{ slug: 'rogue', enabled: true, name: 'Rogue' }] };
    fs.writeFileSync(jobsFile, JSON.stringify(original));
    const pauser = new CrashLoopPauser(history);
    const result = pauser.run({
      jobs: [mkJob({ slug: 'rogue' })],
      jobsFile,
      dryRun: false,
    });
    expect(result.paused).toEqual(['rogue']);
    const after = JSON.parse(fs.readFileSync(jobsFile, 'utf-8'));
    expect(after.jobs[0].enabled).toBe(false);
    expect(after.jobs[0]._crashPauseNote).toBeDefined();
    expect(after.jobs[0]._crashPauseNote.reason).toBe('failures');
    expect(after.jobs[0]._crashPauseNote.failureCount).toBe(3);
    const auditPath = path.join(dir, 'crash-loop-pauses.jsonl');
    expect(fs.existsSync(auditPath)).toBe(true);
    const audit = fs
      .readFileSync(auditPath, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(audit).toHaveLength(1);
    expect(audit[0].slug).toBe('rogue');
  });
});
