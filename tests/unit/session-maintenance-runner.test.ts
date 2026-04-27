import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionMaintenanceRunner } from '../../src/core/SessionMaintenanceRunner.js';

describe('SessionMaintenanceRunner', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-maint-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty result when nothing needs maintenance', async () => {
    const runner = new SessionMaintenanceRunner({ stateDir: tmpDir });
    const result = await runner.run();

    expect(result.tasksRun).toEqual([]);
    expect(result.itemsProcessed).toBe(0);
    expect(result.summary).toContain('nothing needed');
  });

  it('trims stale execution journal entries', async () => {
    const journalPath = path.join(tmpDir, 'execution-journal.jsonl');
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago
    const recent = new Date().toISOString();

    fs.writeFileSync(journalPath, [
      JSON.stringify({ timestamp: old, job: 'old-job' }),
      JSON.stringify({ timestamp: recent, job: 'recent-job' }),
    ].join('\n') + '\n');

    const runner = new SessionMaintenanceRunner({
      stateDir: tmpDir,
      executionJournalRetentionDays: 30,
    });
    const result = await runner.run();

    expect(result.tasksRun).toContain('journal-trim(1)');
    expect(result.itemsProcessed).toBe(1);

    // Verify the old entry was removed but recent was kept
    const remaining = fs.readFileSync(journalPath, 'utf-8').trim().split('\n');
    expect(remaining).toHaveLength(1);
    expect(JSON.parse(remaining[0]).job).toBe('recent-job');
  });

  it('respects timeout', async () => {
    const runner = new SessionMaintenanceRunner({
      stateDir: tmpDir,
      timeoutMs: 50,
    });
    const result = await runner.run();

    // Should complete without error even with tight timeout
    expect(result.durationMs).toBeDefined();
  });

  it('does not fail on missing journal file', async () => {
    const runner = new SessionMaintenanceRunner({ stateDir: tmpDir });
    const result = await runner.run();

    expect(result.tasksRun).toEqual([]);
  });
});
