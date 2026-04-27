/**
 * Unit tests for ExecutionJournal — JSONL-backed execution step tracking.
 *
 * Tests cover:
 * - appendPendingStep(): creates pending file, sanitizes secrets, truncates
 * - finalizeSession(): reads pending, computes deviations, writes journal, cleans up
 * - read(): filtering by days/limit, newest-first ordering, handles corrupt JSONL
 * - stats(): counts, durations, date range
 * - listJobs(): returns slugs from directory
 * - clearPending(): removes pending file, no-ops for missing
 * - applyRetention(): removes old entries
 * - sanitizeCommand(): secret redaction patterns
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ExecutionJournal } from '../../src/core/ExecutionJournal.js';
import type { PendingStep, ExecutionStep } from '../../src/core/types.js';

describe('ExecutionJournal', () => {
  let tmpDir: string;
  let stateDir: string;
  let journal: ExecutionJournal;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ej-test-'));
    stateDir = path.join(tmpDir, '.instar');
    // Do NOT create stateDir — test lazy creation
    journal = new ExecutionJournal(stateDir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ── appendPendingStep() ───────────────────────────────────────────

  describe('appendPendingStep()', () => {
    it('creates the base directory lazily on first write', () => {
      const baseDir = path.join(stateDir, 'state', 'execution-journal');
      expect(fs.existsSync(baseDir)).toBe(false);

      journal.appendPendingStep({
        sessionId: 'sess-1',
        jobSlug: 'health-check',
        timestamp: new Date().toISOString(),
        command: 'curl http://localhost/health',
        source: 'hook',
      });

      expect(fs.existsSync(baseDir)).toBe(true);
    });

    it('writes to per-session pending file', () => {
      journal.appendPendingStep({
        sessionId: 'sess-abc',
        jobSlug: 'health-check',
        timestamp: '2026-03-04T18:00:00Z',
        command: 'curl http://localhost/health',
        source: 'hook',
      });

      const pendingFile = path.join(stateDir, 'state', 'execution-journal', '_pending.sess-abc.jsonl');
      expect(fs.existsSync(pendingFile)).toBe(true);

      const content = fs.readFileSync(pendingFile, 'utf-8').trim();
      const parsed = JSON.parse(content);
      expect(parsed.sessionId).toBe('sess-abc');
      expect(parsed.jobSlug).toBe('health-check');
      expect(parsed.source).toBe('hook');
    });

    it('appends multiple steps to the same session file', () => {
      const step = (cmd: string): PendingStep => ({
        sessionId: 'sess-1',
        jobSlug: 'deploy',
        timestamp: new Date().toISOString(),
        command: cmd,
        source: 'hook',
      });

      journal.appendPendingStep(step('npm run build'));
      journal.appendPendingStep(step('npm publish'));
      journal.appendPendingStep(step('curl http://prod/health'));

      const pendingFile = path.join(stateDir, 'state', 'execution-journal', '_pending.sess-1.jsonl');
      const lines = fs.readFileSync(pendingFile, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(3);
    });

    it('sanitizes secrets in commands before writing', () => {
      journal.appendPendingStep({
        sessionId: 'sess-1',
        jobSlug: 'deploy',
        timestamp: new Date().toISOString(),
        command: 'curl -H "Authorization: Bearer sk-ant-api03-secret-key-123" http://api.example.com',
        source: 'hook',
      });

      const pendingFile = path.join(stateDir, 'state', 'execution-journal', '_pending.sess-1.jsonl');
      const content = fs.readFileSync(pendingFile, 'utf-8').trim();
      const parsed = JSON.parse(content);
      expect(parsed.command).not.toContain('sk-ant-api03');
      expect(parsed.command).toContain('[REDACTED]');
    });

    it('truncates commands at 500 characters', () => {
      const longCommand = 'echo ' + 'x'.repeat(600);

      journal.appendPendingStep({
        sessionId: 'sess-1',
        jobSlug: 'test',
        timestamp: new Date().toISOString(),
        command: longCommand,
        source: 'hook',
      });

      const pendingFile = path.join(stateDir, 'state', 'execution-journal', '_pending.sess-1.jsonl');
      const parsed = JSON.parse(fs.readFileSync(pendingFile, 'utf-8').trim());
      expect(parsed.command.length).toBeLessThanOrEqual(500);
    });
  });

  // ── finalizeSession() ─────────────────────────────────────────────

  describe('finalizeSession()', () => {
    it('reads pending steps and writes finalized record', () => {
      // Pre-populate pending steps
      journal.appendPendingStep({
        sessionId: 'sess-fin',
        jobSlug: 'health-check',
        timestamp: '2026-03-04T18:00:00Z',
        command: 'curl http://localhost/health',
        source: 'hook',
        stepLabel: 'check-api',
      });
      journal.appendPendingStep({
        sessionId: 'sess-fin',
        jobSlug: 'health-check',
        timestamp: '2026-03-04T18:00:05Z',
        command: 'psql -c "SELECT 1"',
        source: 'hook',
        stepLabel: 'check-db',
      });

      const record = journal.finalizeSession({
        sessionId: 'sess-fin',
        jobSlug: 'health-check',
        definedSteps: ['check-api', 'check-db', 'report'],
        outcome: 'success',
        startedAt: '2026-03-04T18:00:00Z',
      });

      expect(record).not.toBeNull();
      expect(record!.jobSlug).toBe('health-check');
      expect(record!.outcome).toBe('success');
      expect(record!.finalized).toBe(true);
      expect(record!.agentId).toBe('default');
      expect(record!.actualSteps).toHaveLength(2);
      expect(record!.actualSteps[0].step).toBe('check-api');
      expect(record!.actualSteps[0].source).toBe('hook');
    });

    it('computes omission deviations for missing defined steps', () => {
      journal.appendPendingStep({
        sessionId: 'sess-dev',
        jobSlug: 'deploy',
        timestamp: '2026-03-04T18:00:00Z',
        command: 'npm run build',
        source: 'hook',
        stepLabel: 'build',
      });

      const record = journal.finalizeSession({
        sessionId: 'sess-dev',
        jobSlug: 'deploy',
        definedSteps: ['build', 'test', 'deploy'],
        outcome: 'success',
        startedAt: '2026-03-04T18:00:00Z',
      });

      const omissions = record!.deviations.filter(d => d.type === 'omission');
      expect(omissions).toHaveLength(2);
      expect(omissions.map(d => d.step)).toContain('test');
      expect(omissions.map(d => d.step)).toContain('deploy');
    });

    it('computes addition deviations for extra steps', () => {
      journal.appendPendingStep({
        sessionId: 'sess-add',
        jobSlug: 'health-check',
        timestamp: '2026-03-04T18:00:00Z',
        command: 'curl http://localhost/health',
        source: 'hook',
        stepLabel: 'check-api',
      });
      journal.appendPendingStep({
        sessionId: 'sess-add',
        jobSlug: 'health-check',
        timestamp: '2026-03-04T18:00:01Z',
        command: 'redis-cli ping',
        source: 'hook',
        stepLabel: 'check-redis',
      });

      const record = journal.finalizeSession({
        sessionId: 'sess-add',
        jobSlug: 'health-check',
        definedSteps: ['check-api'],
        outcome: 'success',
        startedAt: '2026-03-04T18:00:00Z',
      });

      const additions = record!.deviations.filter(d => d.type === 'addition');
      expect(additions).toHaveLength(1);
      expect(additions[0].step).toBe('check-redis');
    });

    it('removes pending file after finalization', () => {
      journal.appendPendingStep({
        sessionId: 'sess-clean',
        jobSlug: 'test',
        timestamp: new Date().toISOString(),
        command: 'npm test',
        source: 'hook',
      });

      const pendingFile = path.join(stateDir, 'state', 'execution-journal', '_pending.sess-clean.jsonl');
      expect(fs.existsSync(pendingFile)).toBe(true);

      journal.finalizeSession({
        sessionId: 'sess-clean',
        jobSlug: 'test',
        outcome: 'success',
        startedAt: new Date().toISOString(),
      });

      expect(fs.existsSync(pendingFile)).toBe(false);
    });

    it('returns null-safe record when no pending data exists', () => {
      const record = journal.finalizeSession({
        sessionId: 'sess-empty',
        jobSlug: 'test',
        outcome: 'success',
        startedAt: new Date().toISOString(),
      });

      // Still creates a record (the job ran, just captured no steps)
      expect(record).not.toBeNull();
      expect(record!.actualSteps).toHaveLength(0);
    });

    it('uses custom agentId for journal path', () => {
      journal.finalizeSession({
        sessionId: 'sess-agent',
        jobSlug: 'health-check',
        agentId: 'my-agent',
        outcome: 'success',
        startedAt: new Date().toISOString(),
      });

      const journalFile = path.join(
        stateDir, 'state', 'execution-journal', 'my-agent', 'health-check.jsonl',
      );
      expect(fs.existsSync(journalFile)).toBe(true);
    });

    it('merges agent-reported steps with hook-captured steps', () => {
      journal.appendPendingStep({
        sessionId: 'sess-merge',
        jobSlug: 'deploy',
        timestamp: '2026-03-04T18:00:00Z',
        command: 'npm run build',
        source: 'hook',
        stepLabel: 'build',
      });

      const record = journal.finalizeSession({
        sessionId: 'sess-merge',
        jobSlug: 'deploy',
        definedSteps: ['build', 'deploy'],
        outcome: 'success',
        startedAt: '2026-03-04T18:00:00Z',
        agentReportedSteps: [
          {
            step: 'deploy',
            timestamp: '2026-03-04T18:01:00Z',
            source: 'agent',
            notes: 'Deployed to production',
          },
        ],
      });

      expect(record!.actualSteps).toHaveLength(2);
      const hookSteps = record!.actualSteps.filter(s => s.source === 'hook');
      const agentSteps = record!.actualSteps.filter(s => s.source === 'agent');
      expect(hookSteps).toHaveLength(1);
      expect(agentSteps).toHaveLength(1);
    });
  });

  // ── read() ────────────────────────────────────────────────────────

  describe('read()', () => {
    function writeRecords(records: Array<Partial<import('../../src/core/types.js').ExecutionRecord>>) {
      const agentDir = path.join(stateDir, 'state', 'execution-journal', 'default');
      fs.mkdirSync(agentDir, { recursive: true });

      const lines = records.map(r => JSON.stringify({
        executionId: r.executionId || `exec-${Math.random().toString(36).slice(2, 8)}`,
        jobSlug: r.jobSlug || 'test-job',
        sessionId: r.sessionId || 'sess-1',
        agentId: 'default',
        timestamp: r.timestamp || new Date().toISOString(),
        definedSteps: r.definedSteps || [],
        actualSteps: r.actualSteps || [],
        deviations: r.deviations || [],
        outcome: r.outcome || 'success',
        durationMinutes: r.durationMinutes,
        finalized: true,
      })).join('\n') + '\n';

      fs.writeFileSync(path.join(agentDir, 'test-job.jsonl'), lines);
    }

    it('returns empty array for missing file', () => {
      const result = journal.read('nonexistent');
      expect(result).toEqual([]);
    });

    it('returns records in newest-first order', () => {
      writeRecords([
        { executionId: 'exec-1', timestamp: '2026-03-01T00:00:00Z' },
        { executionId: 'exec-2', timestamp: '2026-03-03T00:00:00Z' },
        { executionId: 'exec-3', timestamp: '2026-03-02T00:00:00Z' },
      ]);

      const result = journal.read('test-job');
      expect(result).toHaveLength(3);
      expect(result[0].executionId).toBe('exec-2');
      expect(result[1].executionId).toBe('exec-3');
      expect(result[2].executionId).toBe('exec-1');
    });

    it('filters by limit', () => {
      writeRecords([
        { executionId: 'exec-1', timestamp: '2026-03-01T00:00:00Z' },
        { executionId: 'exec-2', timestamp: '2026-03-02T00:00:00Z' },
        { executionId: 'exec-3', timestamp: '2026-03-03T00:00:00Z' },
      ]);

      const result = journal.read('test-job', { limit: 2 });
      expect(result).toHaveLength(2);
      expect(result[0].executionId).toBe('exec-3');
    });

    it('filters by days', () => {
      const now = new Date();
      const recent = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 day ago
      const old = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000); // 60 days ago

      writeRecords([
        { executionId: 'exec-old', timestamp: old.toISOString() },
        { executionId: 'exec-recent', timestamp: recent.toISOString() },
      ]);

      const result = journal.read('test-job', { days: 7 });
      expect(result).toHaveLength(1);
      expect(result[0].executionId).toBe('exec-recent');
    });

    it('handles corrupt JSONL lines gracefully', () => {
      const agentDir = path.join(stateDir, 'state', 'execution-journal', 'default');
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentDir, 'test-job.jsonl'),
        '{"executionId":"exec-1","jobSlug":"test-job","timestamp":"2026-03-01T00:00:00Z","sessionId":"s","agentId":"default","definedSteps":[],"actualSteps":[],"deviations":[],"outcome":"success","finalized":true}\nNOT JSON\n{"executionId":"exec-2","jobSlug":"test-job","timestamp":"2026-03-02T00:00:00Z","sessionId":"s","agentId":"default","definedSteps":[],"actualSteps":[],"deviations":[],"outcome":"success","finalized":true}\n',
      );

      const result = journal.read('test-job');
      expect(result).toHaveLength(2); // Corrupt line skipped
    });
  });

  // ── stats() ───────────────────────────────────────────────────────

  describe('stats()', () => {
    it('returns empty stats for missing job', () => {
      const result = journal.stats('nonexistent');
      expect(result.count).toBe(0);
      expect(result.earliest).toBeNull();
      expect(result.avgDurationMinutes).toBeNull();
    });

    it('computes correct statistics', () => {
      // Directly write some records
      const agentDir = path.join(stateDir, 'state', 'execution-journal', 'default');
      fs.mkdirSync(agentDir, { recursive: true });

      const records = [
        { executionId: 'e1', jobSlug: 'hc', sessionId: 's1', agentId: 'default', timestamp: '2026-03-01T00:00:00Z', definedSteps: [], actualSteps: [], deviations: [], outcome: 'success', durationMinutes: 3.0, finalized: true },
        { executionId: 'e2', jobSlug: 'hc', sessionId: 's2', agentId: 'default', timestamp: '2026-03-02T00:00:00Z', definedSteps: [], actualSteps: [], deviations: [], outcome: 'failure', durationMinutes: 5.0, finalized: true },
        { executionId: 'e3', jobSlug: 'hc', sessionId: 's3', agentId: 'default', timestamp: '2026-03-03T00:00:00Z', definedSteps: [], actualSteps: [], deviations: [], outcome: 'success', durationMinutes: 2.0, finalized: true },
      ];

      fs.writeFileSync(
        path.join(agentDir, 'hc.jsonl'),
        records.map(r => JSON.stringify(r)).join('\n') + '\n',
      );

      const stats = journal.stats('hc');
      expect(stats.count).toBe(3);
      expect(stats.successCount).toBe(2);
      expect(stats.failureCount).toBe(1);
      expect(stats.avgDurationMinutes).toBeCloseTo(3.3, 1);
      expect(stats.earliest).toBe('2026-03-01T00:00:00Z');
      expect(stats.latest).toBe('2026-03-03T00:00:00Z');
    });
  });

  // ── listJobs() ────────────────────────────────────────────────────

  describe('listJobs()', () => {
    it('returns empty for missing agent directory', () => {
      expect(journal.listJobs()).toEqual([]);
    });

    it('returns sorted job slugs', () => {
      const agentDir = path.join(stateDir, 'state', 'execution-journal', 'default');
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, 'health-check.jsonl'), '');
      fs.writeFileSync(path.join(agentDir, 'deploy.jsonl'), '');
      fs.writeFileSync(path.join(agentDir, 'backup.jsonl'), '');

      const jobs = journal.listJobs();
      expect(jobs).toEqual(['backup', 'deploy', 'health-check']);
    });

    it('respects agentId parameter', () => {
      const agentDir = path.join(stateDir, 'state', 'execution-journal', 'my-agent');
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, 'my-job.jsonl'), '');

      expect(journal.listJobs('my-agent')).toEqual(['my-job']);
      expect(journal.listJobs('other-agent')).toEqual([]);
    });
  });

  // ── clearPending() ────────────────────────────────────────────────

  describe('clearPending()', () => {
    it('removes the pending file', () => {
      journal.appendPendingStep({
        sessionId: 'sess-clear',
        jobSlug: 'test',
        timestamp: new Date().toISOString(),
        command: 'echo hello',
        source: 'hook',
      });

      const pendingFile = path.join(stateDir, 'state', 'execution-journal', '_pending.sess-clear.jsonl');
      expect(fs.existsSync(pendingFile)).toBe(true);

      journal.clearPending('sess-clear');
      expect(fs.existsSync(pendingFile)).toBe(false);
    });

    it('does not throw for missing file', () => {
      expect(() => journal.clearPending('nonexistent')).not.toThrow();
    });
  });

  // ── applyRetention() ──────────────────────────────────────────────

  describe('applyRetention()', () => {
    it('removes entries older than maxDays', () => {
      const agentDir = path.join(stateDir, 'state', 'execution-journal', 'default');
      fs.mkdirSync(agentDir, { recursive: true });

      const now = new Date();
      const old = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
      const recent = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000); // 5 days ago

      const records = [
        { executionId: 'old-1', jobSlug: 'hc', sessionId: 's1', agentId: 'default', timestamp: old.toISOString(), definedSteps: [], actualSteps: [], deviations: [], outcome: 'success', finalized: true },
        { executionId: 'recent-1', jobSlug: 'hc', sessionId: 's2', agentId: 'default', timestamp: recent.toISOString(), definedSteps: [], actualSteps: [], deviations: [], outcome: 'success', finalized: true },
      ];

      fs.writeFileSync(
        path.join(agentDir, 'hc.jsonl'),
        records.map(r => JSON.stringify(r)).join('\n') + '\n',
      );

      const removed = journal.applyRetention('hc', undefined, 30);
      expect(removed).toBe(1);

      const remaining = journal.read('hc');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].executionId).toBe('recent-1');
    });

    it('returns 0 for missing job', () => {
      expect(journal.applyRetention('nonexistent')).toBe(0);
    });
  });

  // ── sanitizeCommand() ─────────────────────────────────────────────

  describe('sanitizeCommand()', () => {
    it('redacts Bearer tokens', () => {
      const result = ExecutionJournal.sanitizeCommand(
        'curl -H "Authorization: Bearer sk-ant-api03-abcdef123456789" http://api.example.com',
      );
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('sk-ant-api03');
    });

    it('redacts Anthropic API keys', () => {
      const result = ExecutionJournal.sanitizeCommand(
        'ANTHROPIC_API_KEY=sk-ant-api03-verylongsecretkey12345 node script.js',
      );
      expect(result).not.toContain('verylongsecretkey');
    });

    it('redacts GitHub PATs', () => {
      const result = ExecutionJournal.sanitizeCommand(
        'git clone https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/org/repo',
      );
      expect(result).not.toContain('ghp_abcdefghijklmnop');
    });

    it('redacts password= patterns', () => {
      const result = ExecutionJournal.sanitizeCommand(
        'mysql -u root password=my_secret_pass -h localhost',
      );
      expect(result).not.toContain('my_secret_pass');
    });

    it('redacts Slack tokens', () => {
      const result = ExecutionJournal.sanitizeCommand(
        'curl -H "Authorization: Bearer xoxb-1234-5678-abcdef" https://slack.com/api',
      );
      expect(result).not.toContain('xoxb-1234');
    });

    it('truncates at 500 characters', () => {
      const long = 'a'.repeat(600);
      expect(ExecutionJournal.sanitizeCommand(long)).toHaveLength(500);
    });

    it('passes through safe commands unchanged', () => {
      const cmd = 'curl http://localhost:3000/health';
      expect(ExecutionJournal.sanitizeCommand(cmd)).toBe(cmd);
    });
  });

  // ── Step label inference ──────────────────────────────────────────

  describe('step label inference (via finalize)', () => {
    it('infers labels from common command patterns', () => {
      journal.appendPendingStep({
        sessionId: 'sess-infer',
        jobSlug: 'deploy',
        timestamp: '2026-03-04T18:00:00Z',
        command: 'git push origin main',
        source: 'hook',
      });
      journal.appendPendingStep({
        sessionId: 'sess-infer',
        jobSlug: 'deploy',
        timestamp: '2026-03-04T18:01:00Z',
        command: 'npm run build',
        source: 'hook',
      });

      const record = journal.finalizeSession({
        sessionId: 'sess-infer',
        jobSlug: 'deploy',
        outcome: 'success',
        startedAt: '2026-03-04T18:00:00Z',
      });

      expect(record!.actualSteps[0].step).toBe('git-push');
      expect(record!.actualSteps[1].step).toBe('build');
    });

    it('uses stepLabel when provided instead of inferring', () => {
      journal.appendPendingStep({
        sessionId: 'sess-label',
        jobSlug: 'deploy',
        timestamp: '2026-03-04T18:00:00Z',
        command: 'curl http://localhost/health',
        source: 'hook',
        stepLabel: 'verify-deployment',
      });

      const record = journal.finalizeSession({
        sessionId: 'sess-label',
        jobSlug: 'deploy',
        outcome: 'success',
        startedAt: '2026-03-04T18:00:00Z',
      });

      expect(record!.actualSteps[0].step).toBe('verify-deployment');
    });
  });
});
