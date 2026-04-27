/**
 * Integration tests for ExecutionJournal lifecycle.
 *
 * Tests the full path: sentinel file → hook capture → finalization → read.
 * Mimics the JobScheduler → hook → ExecutionJournal.finalizeSession() pipeline
 * without spawning real sessions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ExecutionJournal } from '../../src/core/ExecutionJournal.js';
import { PatternAnalyzer } from '../../src/core/PatternAnalyzer.js';

// Generate timestamps relative to now to stay within the 30-day analysis window.
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe('ExecutionJournal Lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let journal: ExecutionJournal;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ej-int-'));
    stateDir = path.join(tmpDir, '.instar');
    journal = new ExecutionJournal(stateDir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full lifecycle: capture → finalize → read → stats → retention', () => {
    // Phase 1: Simulate hook capturing steps during job execution
    const sessionId = 'sess-lifecycle-001';
    const jobSlug = 'health-check';

    journal.appendPendingStep({
      sessionId,
      jobSlug,
      timestamp: daysAgo(2),
      command: 'curl http://localhost:3000/health',
      source: 'hook',
      stepLabel: 'check-api',
    });
    journal.appendPendingStep({
      sessionId,
      jobSlug,
      timestamp: daysAgo(2),
      command: 'redis-cli ping',
      source: 'hook',
      stepLabel: 'check-redis',
    });
    journal.appendPendingStep({
      sessionId,
      jobSlug,
      timestamp: daysAgo(2),
      command: 'psql -c "SELECT 1"',
      source: 'hook',
      stepLabel: 'check-db',
    });

    // Phase 2: Finalize (simulating JobScheduler.notifyJobComplete)
    const record = journal.finalizeSession({
      sessionId,
      jobSlug,
      definedSteps: ['check-api', 'check-db', 'report'],
      outcome: 'success',
      startedAt: daysAgo(2),
    });

    expect(record).not.toBeNull();
    expect(record!.actualSteps).toHaveLength(3);
    expect(record!.deviations).toHaveLength(2); // addition: check-redis, omission: report

    // Phase 3: Read back the journal
    const records = journal.read(jobSlug);
    expect(records).toHaveLength(1);
    expect(records[0].executionId).toBe(record!.executionId);

    // Phase 4: Stats
    const stats = journal.stats(jobSlug);
    expect(stats.count).toBe(1);
    expect(stats.successCount).toBe(1);

    // Phase 5: Retention (should keep this recent record)
    const removed = journal.applyRetention(jobSlug, undefined, 30);
    expect(removed).toBe(0);

    // Verify still readable
    expect(journal.read(jobSlug)).toHaveLength(1);
  });

  it('multi-session accumulation for pattern visibility', () => {
    const jobSlug = 'deploy';

    // Simulate 5 executions, 4 of which add an extra "smoke-test" step
    for (let i = 0; i < 5; i++) {
      const sessionId = `sess-multi-${i}`;

      journal.appendPendingStep({
        sessionId,
        jobSlug,
        timestamp: new Date(2026, 2, 1 + i).toISOString(),
        command: 'npm run build',
        source: 'hook',
        stepLabel: 'build',
      });

      journal.appendPendingStep({
        sessionId,
        jobSlug,
        timestamp: new Date(2026, 2, 1 + i, 0, 1).toISOString(),
        command: 'npm publish',
        source: 'hook',
        stepLabel: 'publish',
      });

      // 4 out of 5 runs add smoke-test (consistent addition pattern)
      if (i < 4) {
        journal.appendPendingStep({
          sessionId,
          jobSlug,
          timestamp: new Date(2026, 2, 1 + i, 0, 2).toISOString(),
          command: 'curl http://prod/smoke',
          source: 'hook',
          stepLabel: 'smoke-test',
        });
      }

      journal.finalizeSession({
        sessionId,
        jobSlug,
        definedSteps: ['build', 'publish'],
        outcome: 'success',
        startedAt: new Date(2026, 2, 1 + i).toISOString(),
      });
    }

    // Read all records
    const records = journal.read(jobSlug);
    expect(records).toHaveLength(5);

    // Count how many runs have "smoke-test" as an addition deviation
    const smokeTestAdditions = records.filter(r =>
      r.deviations.some(d => d.type === 'addition' && d.step === 'smoke-test'),
    );
    expect(smokeTestAdditions).toHaveLength(4); // 4 of 5 runs

    // This is the data that Phase 2 (PatternAnalyzer) would consume to detect
    // "smoke-test appears in 80% of runs but isn't in the definition"
  });

  it('multi-agent namespacing keeps journals separate', () => {
    const jobSlug = 'health-check';

    // Agent 1 runs
    journal.appendPendingStep({
      sessionId: 'agent1-sess',
      jobSlug,
      timestamp: daysAgo(2),
      command: 'curl http://app1/health',
      source: 'hook',
      stepLabel: 'check',
    });
    journal.finalizeSession({
      sessionId: 'agent1-sess',
      jobSlug,
      agentId: 'agent-alpha',
      outcome: 'success',
      startedAt: daysAgo(2),
    });

    // Agent 2 runs the same job
    journal.appendPendingStep({
      sessionId: 'agent2-sess',
      jobSlug,
      timestamp: daysAgo(1),
      command: 'curl http://app2/health',
      source: 'hook',
      stepLabel: 'check',
    });
    journal.finalizeSession({
      sessionId: 'agent2-sess',
      jobSlug,
      agentId: 'agent-beta',
      outcome: 'failure',
      startedAt: daysAgo(1),
    });

    // Each agent sees only their own records
    const alphaRecords = journal.read(jobSlug, { agentId: 'agent-alpha' });
    const betaRecords = journal.read(jobSlug, { agentId: 'agent-beta' });

    expect(alphaRecords).toHaveLength(1);
    expect(alphaRecords[0].outcome).toBe('success');

    expect(betaRecords).toHaveLength(1);
    expect(betaRecords[0].outcome).toBe('failure');

    // listJobs respects agent namespacing
    expect(journal.listJobs('agent-alpha')).toEqual([jobSlug]);
    expect(journal.listJobs('agent-beta')).toEqual([jobSlug]);
    expect(journal.listJobs('agent-gamma')).toEqual([]);
  });

  it('secret sanitization persists through full lifecycle', () => {
    journal.appendPendingStep({
      sessionId: 'sess-secret',
      jobSlug: 'deploy',
      timestamp: daysAgo(2),
      command: 'curl -H "Authorization: Bearer sk-ant-api03-mysecretkey123456" http://api.anthropic.com/v1/messages',
      source: 'hook',
    });

    journal.finalizeSession({
      sessionId: 'sess-secret',
      jobSlug: 'deploy',
      outcome: 'success',
      startedAt: daysAgo(2),
    });

    // Read back and verify secret is not present anywhere
    const records = journal.read('deploy');
    expect(records).toHaveLength(1);

    const recordStr = JSON.stringify(records[0]);
    expect(recordStr).not.toContain('sk-ant-api03');
    expect(recordStr).not.toContain('mysecretkey');
    expect(recordStr).toContain('[REDACTED]');
  });

  it('PatternAnalyzer detects patterns from accumulated journal data', () => {
    const jobSlug = 'pattern-integration';
    const definedSteps = ['check-health', 'run-report'];

    // Simulate 5 runs where:
    // - 'check-health' always executes (defined, no pattern)
    // - 'run-report' is skipped 4/5 times (omission pattern)
    // - 'cleanup-logs' appears 4/5 times but isn't defined (addition pattern)
    for (let i = 0; i < 5; i++) {
      const sessionId = `sess-pattern-${i}`;
      journal.appendPendingStep({
        sessionId,
        jobSlug,
        timestamp: daysAgo(5 - i),
        command: 'curl http://localhost:3000/health',
        source: 'hook',
        stepLabel: 'check-health',
      });

      if (i === 0) {
        // Only first run does run-report
        journal.appendPendingStep({
          sessionId,
          jobSlug,
          timestamp: daysAgo(5 - i),
          command: 'node generate-report.js',
          source: 'hook',
          stepLabel: 'run-report',
        });
      }

      if (i < 4) {
        // 4 of 5 runs do cleanup-logs (80% — high confidence addition)
        journal.appendPendingStep({
          sessionId,
          jobSlug,
          timestamp: daysAgo(5 - i),
          command: 'find /var/log -mtime +7 -delete',
          source: 'hook',
          stepLabel: 'cleanup-logs',
        });
      }

      journal.finalizeSession({
        sessionId,
        jobSlug,
        definedSteps,
        outcome: 'success',
        startedAt: daysAgo(5 - i),
        completedAt: daysAgo(5 - i),
      });
    }

    // Now analyze
    const analyzer = new PatternAnalyzer(journal);
    const report = analyzer.analyze(jobSlug);

    expect(report.runsAnalyzed).toBe(5);
    expect(report.summary.definedSteps).toBe(2);
    expect(report.summary.successRate).toBe(1);

    // Should detect consistent addition: cleanup-logs (4/5 = 80%)
    const additions = report.patterns.filter(p => p.type === 'consistent-addition');
    expect(additions.length).toBe(1);
    expect(additions[0].step).toBe('cleanup-logs');
    expect(additions[0].confidence).toBe('high');

    // Should detect consistent omission: run-report (4/5 = 80% skipped)
    const omissions = report.patterns.filter(p => p.type === 'consistent-omission');
    expect(omissions.length).toBe(1);
    expect(omissions[0].step).toBe('run-report');

    // Should generate proposals for both
    const proposals = analyzer.toProposals(report);
    expect(proposals.length).toBeGreaterThanOrEqual(2);

    const addProposal = proposals.find(p => p.title.includes('cleanup-logs'));
    expect(addProposal).toBeDefined();
    expect(addProposal!.title).toContain('Add');

    const removeProposal = proposals.find(p => p.title.includes('run-report'));
    expect(removeProposal).toBeDefined();
    expect(removeProposal!.title).toContain('Remove');
  });
});
