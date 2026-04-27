/**
 * Unit + Semantic Correctness tests for HandoffManager.
 *
 * Tests graceful handoff (WIP commit, ledger pausing, active work collection),
 * resume (graceful, crash recovery, same-machine), acceptHandoff, and
 * handoff note I/O. All tests use real git repos and real WorkLedger instances
 * in temp directories.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { HandoffManager } from '../../src/core/HandoffManager.js';
import { WorkLedger } from '../../src/core/WorkLedger.js';
import type { HandoffNote, HandoffWorkItem } from '../../src/core/HandoffManager.js';

// ── Helpers ────────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  // safe-git-allow: incremental-migration
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 10_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function makeManager(
  tmpDir: string,
  stateDir: string,
  ledger: WorkLedger,
  machineId = 'machine-a',
): HandoffManager {
  return new HandoffManager({
    projectDir: tmpDir,
    stateDir,
    machineId,
    workLedger: ledger,
  });
}

function makeLedger(stateDir: string, machineId = 'machine-a'): WorkLedger {
  return new WorkLedger({ stateDir, machineId });
}

/**
 * Write a ledger file for a different machine directly to disk.
 * This simulates entries from another machine for crash recovery tests.
 */
function injectOtherMachineLedger(
  stateDir: string,
  machineId: string,
  entries: Array<{
    sessionId: string;
    task: string;
    status: 'active' | 'paused' | 'stale' | 'completed';
    filesPlanned?: string[];
    filesModified?: string[];
    branch?: string;
  }>,
): void {
  const ledgerDir = path.join(stateDir, 'state', 'ledger');
  if (!fs.existsSync(ledgerDir)) {
    fs.mkdirSync(ledgerDir, { recursive: true });
  }

  const ledgerEntries = entries.map((e, i) => ({
    id: `work_other${String(i).padStart(6, '0')}`,
    machineId,
    sessionId: e.sessionId,
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
    updatedAt: new Date(Date.now() - 3600_000).toISOString(),
    status: e.status,
    task: e.task,
    filesPlanned: e.filesPlanned ?? [],
    filesModified: e.filesModified ?? [],
    branch: e.branch,
  }));

  const ledger = {
    schemaVersion: 1,
    machineId,
    lastUpdated: new Date().toISOString(),
    entries: ledgerEntries,
    lastCleanup: new Date().toISOString(),
  };

  fs.writeFileSync(
    path.join(ledgerDir, `${machineId}.json`),
    JSON.stringify(ledger, null, 2),
  );
}

// ── Test Suite ──────────────────────────────────────────────────────────

describe('HandoffManager', () => {
  let tmpDir: string;
  let stateDir: string;
  let ledger: WorkLedger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-'));
    stateDir = path.join(tmpDir, '.instar');
    // safe-git-allow: incremental-migration
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmpDir });
    // safe-git-allow: incremental-migration
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    // safe-git-allow: incremental-migration
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test\n');
    // safe-git-allow: incremental-migration
    execFileSync('git', ['add', '.'], { cwd: tmpDir });
    // safe-git-allow: incremental-migration
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });
    ledger = makeLedger(stateDir, 'machine-a');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. initiateHandoff — basic ────────────────────────────────────

  describe('initiateHandoff — basic', () => {
    it('creates handoff note on disk', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);
      mgr.initiateHandoff();

      expect(mgr.hasHandoffNote()).toBe(true);
    });

    it('returns success with correct HandoffResult', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);
      const result = mgr.initiateHandoff();

      expect(result.success).toBe(true);
      expect(result.note).toBeDefined();
      expect(typeof result.entriesPaused).toBe('number');
      expect(typeof result.wipCommits).toBe('number');
      expect(typeof result.pushed).toBe('boolean');
      expect(result.error).toBeUndefined();
    });

    it('note contains correct from (machineId)', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);
      const result = mgr.initiateHandoff();

      expect(result.note!.from).toBe('machine-a');
    });

    it('note contains correct reason', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);
      const result = mgr.initiateHandoff({ reason: 'shutdown' });

      expect(result.note!.reason).toBe('shutdown');
    });

    it('note has valid ISO timestamp', () => {
      const before = new Date();
      const mgr = makeManager(tmpDir, stateDir, ledger);
      const result = mgr.initiateHandoff();
      const after = new Date();

      const noteTime = new Date(result.note!.at);
      expect(noteTime.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(noteTime.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('default reason is user-initiated', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);
      const result = mgr.initiateHandoff();

      expect(result.note!.reason).toBe('user-initiated');
    });

    it('note has schemaVersion 1', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);
      const result = mgr.initiateHandoff();

      expect(result.note!.schemaVersion).toBe(1);
    });

    it('note has gitHead that matches actual HEAD', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);
      const result = mgr.initiateHandoff();

      // After handoff, HEAD may have advanced due to WIP commit, so
      // just verify it's a valid commit hash
      const head = git(tmpDir, 'rev-parse', 'HEAD');
      expect(result.note!.gitHead).toBe(head);
    });

    it('pushed is false when no remote is configured', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);
      const result = mgr.initiateHandoff();

      // No remote configured in test repos, so push should fail gracefully
      expect(result.pushed).toBe(false);
    });

    it('supports all valid HandoffReason values', () => {
      const reasons = ['user-initiated', 'inactivity', 'shutdown', 'sleep', 'crash-detected'] as const;

      for (const reason of reasons) {
        const mgr = makeManager(tmpDir, stateDir, ledger);
        const result = mgr.initiateHandoff({ reason });
        expect(result.note!.reason).toBe(reason);
      }
    });
  });

  // ── 2. initiateHandoff — WIP commit ──────────────────────────────

  describe('initiateHandoff — WIP commit', () => {
    it('commits dirty working tree as WIP', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);

      // Create an uncommitted file
      fs.writeFileSync(path.join(tmpDir, 'dirty.ts'), 'export const x = 1;\n');

      const result = mgr.initiateHandoff();

      expect(result.wipCommits).toBe(1);

      // Verify the WIP commit exists in git log
      const log = git(tmpDir, 'log', '--oneline', '-3');
      expect(log).toContain('wip(machine-a)');
    });

    it('WIP commit message includes machineId', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);

      fs.writeFileSync(path.join(tmpDir, 'dirty.ts'), 'content');

      mgr.initiateHandoff();

      const commitMsg = git(tmpDir, 'log', '-1', '--format=%s');
      expect(commitMsg).toContain('machine-a');
      expect(commitMsg).toContain('wip');
    });

    it('no WIP commit when working tree is clean', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);

      const result = mgr.initiateHandoff();

      expect(result.wipCommits).toBe(0);
    });

    it('wipCommits count is correct with dirty files', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);

      // Create multiple dirty files — they all go into one WIP commit
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'a');
      fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'b');
      fs.writeFileSync(path.join(tmpDir, 'c.ts'), 'c');

      const result = mgr.initiateHandoff();

      // All dirty files go into a single WIP commit
      expect(result.wipCommits).toBe(1);
    });

    it('uncommittedNotes reflects WIP commit creation', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);

      fs.writeFileSync(path.join(tmpDir, 'dirty.ts'), 'content');

      const result = mgr.initiateHandoff();
      expect(result.note!.uncommittedNotes).toContain('1 WIP commit');
    });

    it('uncommittedNotes says None when tree is clean', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);

      const result = mgr.initiateHandoff();
      expect(result.note!.uncommittedNotes).toContain('None');
    });
  });

  // ── 3. initiateHandoff — ledger pausing ──────────────────────────

  describe('initiateHandoff — ledger pausing', () => {
    it('pauses all active ledger entries', () => {
      // Create some active work
      ledger.startWork({ sessionId: 'S1', task: 'Task 1' });
      ledger.startWork({ sessionId: 'S2', task: 'Task 2' });

      const mgr = makeManager(tmpDir, stateDir, ledger);
      const result = mgr.initiateHandoff();

      expect(result.entriesPaused).toBe(2);
    });

    it('entriesPaused count matches active entries', () => {
      ledger.startWork({ sessionId: 'S1', task: 'Task 1' });
      ledger.startWork({ sessionId: 'S2', task: 'Task 2' });
      ledger.startWork({ sessionId: 'S3', task: 'Task 3' });

      const mgr = makeManager(tmpDir, stateDir, ledger);
      const result = mgr.initiateHandoff();

      expect(result.entriesPaused).toBe(3);
    });

    it('entries actually marked paused in ledger', () => {
      ledger.startWork({ sessionId: 'S1', task: 'Task 1' });
      ledger.startWork({ sessionId: 'S2', task: 'Task 2' });

      const mgr = makeManager(tmpDir, stateDir, ledger);
      mgr.initiateHandoff();

      // Read back the ledger and verify all entries are paused
      const ownLedger = ledger.readOwnLedger();
      const active = ownLedger.entries.filter(e => e.status === 'active');
      const paused = ownLedger.entries.filter(e => e.status === 'paused');

      expect(active).toHaveLength(0);
      expect(paused).toHaveLength(2);
    });

    it('already-paused entries not double-paused', () => {
      const entry1 = ledger.startWork({ sessionId: 'S1', task: 'Task 1' });
      ledger.startWork({ sessionId: 'S2', task: 'Task 2' });

      // Manually pause the first entry before handoff
      ledger.endWork(entry1.id, 'paused');

      const mgr = makeManager(tmpDir, stateDir, ledger);
      const result = mgr.initiateHandoff();

      // Only 1 entry was active at handoff time (S2), S1 was already paused
      expect(result.entriesPaused).toBe(1);

      // Both should still be paused
      const ownLedger = ledger.readOwnLedger();
      const paused = ownLedger.entries.filter(e => e.status === 'paused');
      expect(paused).toHaveLength(2);
    });

    it('entriesPaused is 0 when no active work', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);
      const result = mgr.initiateHandoff();

      expect(result.entriesPaused).toBe(0);
    });

    it('completed entries are not paused', () => {
      const entry = ledger.startWork({ sessionId: 'S1', task: 'Task 1' });
      ledger.endWork(entry.id, 'completed');
      ledger.startWork({ sessionId: 'S2', task: 'Task 2' });

      const mgr = makeManager(tmpDir, stateDir, ledger);
      const result = mgr.initiateHandoff();

      // Only S2 should be paused, S1 was already completed
      expect(result.entriesPaused).toBe(1);

      const ownLedger = ledger.readOwnLedger();
      const completed = ownLedger.entries.filter(e => e.status === 'completed');
      expect(completed).toHaveLength(1);
    });
  });

  // ── 4. initiateHandoff — active work collection ──────────────────

  describe('initiateHandoff — active work collection', () => {
    it('activeWork items include entry details', () => {
      ledger.startWork({
        sessionId: 'S1',
        task: 'Implement feature',
        filesPlanned: ['src/feature.ts'],
        branch: 'task/machine-a/feature',
      });

      const mgr = makeManager(tmpDir, stateDir, ledger);
      const result = mgr.initiateHandoff();

      expect(result.note!.activeWork).toHaveLength(1);
      const item = result.note!.activeWork[0];
      expect(item.sessionId).toBe('S1');
      expect(item.description).toBe('Implement feature');
      expect(item.status).toBe('paused');
      expect(item.entryId).toMatch(/^work_/);
    });

    it('resumeInstructions propagated when provided', () => {
      ledger.startWork({ sessionId: 'S1', task: 'Task 1' });

      const mgr = makeManager(tmpDir, stateDir, ledger);
      const result = mgr.initiateHandoff({
        resumeInstructions: 'Run tests first before continuing.',
      });

      expect(result.note!.activeWork[0].resumeInstructions).toBe(
        'Run tests first before continuing.',
      );
    });

    it('resumeInstructions is undefined when not provided', () => {
      ledger.startWork({ sessionId: 'S1', task: 'Task 1' });

      const mgr = makeManager(tmpDir, stateDir, ledger);
      const result = mgr.initiateHandoff();

      expect(result.note!.activeWork[0].resumeInstructions).toBeUndefined();
    });

    it('multiple work items collected correctly', () => {
      ledger.startWork({ sessionId: 'S1', task: 'Task 1', branch: 'task/a/t1' });
      ledger.startWork({ sessionId: 'S2', task: 'Task 2', branch: 'task/a/t2' });
      ledger.startWork({ sessionId: 'S3', task: 'Task 3' });

      const mgr = makeManager(tmpDir, stateDir, ledger);
      const result = mgr.initiateHandoff();

      expect(result.note!.activeWork).toHaveLength(3);

      const descriptions = result.note!.activeWork.map(w => w.description);
      expect(descriptions).toContain('Task 1');
      expect(descriptions).toContain('Task 2');
      expect(descriptions).toContain('Task 3');
    });

    it('filesModified is union of planned + modified', () => {
      const entry = ledger.startWork({
        sessionId: 'S1',
        task: 'File test',
        filesPlanned: ['src/a.ts', 'src/b.ts'],
      });

      // Simulate modifying some files (including one not planned)
      ledger.updateWork(entry.id, {
        filesModified: ['src/b.ts', 'src/c.ts'],
      });

      const mgr = makeManager(tmpDir, stateDir, ledger);
      const result = mgr.initiateHandoff();

      const files = result.note!.activeWork[0].filesModified;
      // Should be union of planned (a, b) and modified (b, c) = a, b, c
      expect(files).toContain('src/a.ts');
      expect(files).toContain('src/b.ts');
      expect(files).toContain('src/c.ts');
      // No duplicates
      expect(new Set(files).size).toBe(files.length);
    });

    it('activeWork is empty when no ledger entries', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);
      const result = mgr.initiateHandoff();

      expect(result.note!.activeWork).toEqual([]);
    });

    it('branch field is present when entry has a branch', () => {
      ledger.startWork({
        sessionId: 'S1',
        task: 'Branched task',
        branch: 'task/machine-a/feature-x',
      });

      const mgr = makeManager(tmpDir, stateDir, ledger);
      const result = mgr.initiateHandoff();

      expect(result.note!.activeWork[0].branch).toBe('task/machine-a/feature-x');
    });

    it('branch field is undefined when entry has no branch', () => {
      ledger.startWork({ sessionId: 'S1', task: 'No branch task' });

      const mgr = makeManager(tmpDir, stateDir, ledger);
      const result = mgr.initiateHandoff();

      expect(result.note!.activeWork[0].branch).toBeUndefined();
    });
  });

  // ── 5. resume — graceful (with handoff note) ─────────────────────

  describe('resume — graceful (with handoff note)', () => {
    it('reads handoff note successfully', () => {
      // Machine A initiates handoff
      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      ledger.startWork({ sessionId: 'S1', task: 'Task from A' });
      mgrA.initiateHandoff();

      // Machine B resumes
      const ledgerB = makeLedger(stateDir, 'machine-b');
      const mgrB = makeManager(tmpDir, stateDir, ledgerB, 'machine-b');
      const result = mgrB.resume();

      expect(result.success).toBe(true);
      expect(result.note).toBeDefined();
      expect(result.note!.from).toBe('machine-a');
    });

    it('returns resumableWork items', () => {
      ledger.startWork({ sessionId: 'S1', task: 'Resumable task' });

      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      mgrA.initiateHandoff();

      const ledgerB = makeLedger(stateDir, 'machine-b');
      const mgrB = makeManager(tmpDir, stateDir, ledgerB, 'machine-b');
      const result = mgrB.resume();

      expect(result.resumableWork).toHaveLength(1);
      expect(result.resumableWork[0].description).toBe('Resumable task');
      expect(result.resumableWork[0].status).toBe('paused');
    });

    it('recoveryType is graceful', () => {
      ledger.startWork({ sessionId: 'S1', task: 'Task' });

      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      mgrA.initiateHandoff();

      const ledgerB = makeLedger(stateDir, 'machine-b');
      const mgrB = makeManager(tmpDir, stateDir, ledgerB, 'machine-b');
      const result = mgrB.resume();

      expect(result.recoveryType).toBe('graceful');
    });

    it('changesAvailable reflects allChangesPushed from note', () => {
      ledger.startWork({ sessionId: 'S1', task: 'Task' });

      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      mgrA.initiateHandoff();

      // The note should have allChangesPushed = false since no remote
      const ledgerB = makeLedger(stateDir, 'machine-b');
      const mgrB = makeManager(tmpDir, stateDir, ledgerB, 'machine-b');
      const result = mgrB.resume();

      expect(result.changesAvailable).toBe(false);
    });

    it('only returns paused items as resumable (not interrupted)', () => {
      ledger.startWork({ sessionId: 'S1', task: 'Task 1' });
      ledger.startWork({ sessionId: 'S2', task: 'Task 2' });

      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      mgrA.initiateHandoff();

      // Manually modify the note to have one interrupted item
      const note = mgrA.readHandoffNote()!;
      note.activeWork[1].status = 'interrupted';
      // Write it back directly
      const handoffPath = path.join(stateDir, 'state', 'handoff.json');
      fs.writeFileSync(handoffPath, JSON.stringify(note, null, 2));

      const ledgerB = makeLedger(stateDir, 'machine-b');
      const mgrB = makeManager(tmpDir, stateDir, ledgerB, 'machine-b');
      const result = mgrB.resume();

      // Only the paused item should be in resumableWork
      expect(result.resumableWork).toHaveLength(1);
      expect(result.resumableWork[0].description).toBe('Task 1');
    });
  });

  // ── 6. resume — crash recovery (no handoff note) ─────────────────

  describe('resume — crash recovery (no handoff note)', () => {
    it('detects stale entries from other machines', () => {
      // Inject entries from machine-b directly into ledger directory
      injectOtherMachineLedger(stateDir, 'machine-b', [
        { sessionId: 'S1', task: 'Stale task from B', status: 'active' },
      ]);

      // Machine A resumes with no handoff note
      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      const result = mgrA.resume();

      expect(result.success).toBe(true);
      expect(result.resumableWork).toHaveLength(1);
      expect(result.resumableWork[0].description).toBe('Stale task from B');
      expect(result.resumableWork[0].status).toBe('interrupted');
    });

    it('returns interrupted work items', () => {
      injectOtherMachineLedger(stateDir, 'machine-b', [
        { sessionId: 'S1', task: 'Crash task', status: 'stale' },
      ]);

      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      const result = mgrA.resume();

      expect(result.resumableWork[0].status).toBe('interrupted');
    });

    it('recoveryType is crash-recovery', () => {
      injectOtherMachineLedger(stateDir, 'machine-b', [
        { sessionId: 'S1', task: 'Crash task', status: 'active' },
      ]);

      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      const result = mgrA.resume();

      expect(result.recoveryType).toBe('crash-recovery');
    });

    it('empty result when no stale work exists (fresh-start)', () => {
      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      const result = mgrA.resume();

      expect(result.success).toBe(true);
      expect(result.resumableWork).toEqual([]);
      expect(result.recoveryType).toBe('fresh-start');
    });

    it('ignores completed entries from other machines', () => {
      injectOtherMachineLedger(stateDir, 'machine-b', [
        { sessionId: 'S1', task: 'Completed task', status: 'completed' },
      ]);

      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      const result = mgrA.resume();

      expect(result.resumableWork).toEqual([]);
      expect(result.recoveryType).toBe('fresh-start');
    });

    it('ignores paused entries from other machines (only active/stale)', () => {
      injectOtherMachineLedger(stateDir, 'machine-b', [
        { sessionId: 'S1', task: 'Paused task', status: 'paused' },
      ]);

      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      const result = mgrA.resume();

      // Paused entries from other machines are NOT treated as crash-recovery
      // (only active/stale are), per the code logic
      expect(result.resumableWork).toEqual([]);
      expect(result.recoveryType).toBe('fresh-start');
    });

    it('collects filesModified as union of planned and modified', () => {
      injectOtherMachineLedger(stateDir, 'machine-b', [
        {
          sessionId: 'S1',
          task: 'File union test',
          status: 'active',
          filesPlanned: ['src/a.ts', 'src/b.ts'],
          filesModified: ['src/b.ts', 'src/c.ts'],
        },
      ]);

      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      const result = mgrA.resume();

      const files = result.resumableWork[0].filesModified;
      expect(files).toContain('src/a.ts');
      expect(files).toContain('src/b.ts');
      expect(files).toContain('src/c.ts');
    });

    it('multiple stale entries from multiple machines', () => {
      injectOtherMachineLedger(stateDir, 'machine-b', [
        { sessionId: 'S1', task: 'From B', status: 'active' },
      ]);
      injectOtherMachineLedger(stateDir, 'machine-c', [
        { sessionId: 'S2', task: 'From C-1', status: 'stale' },
        { sessionId: 'S3', task: 'From C-2', status: 'active' },
      ]);

      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      const result = mgrA.resume();

      expect(result.resumableWork).toHaveLength(3);
      expect(result.recoveryType).toBe('crash-recovery');
    });

    it('does not pick up own machine entries as crash recovery', () => {
      // Create active entries for machine-a itself
      ledger.startWork({ sessionId: 'S1', task: 'Own task' });

      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      const result = mgrA.resume();

      // Own active entries should NOT appear as crash recovery items
      expect(result.resumableWork).toEqual([]);
      expect(result.recoveryType).toBe('fresh-start');
    });
  });

  // ── 7. resume — same machine ─────────────────────────────────────

  describe('resume — same machine', () => {
    it('clears handoff note when resuming on same machine', () => {
      ledger.startWork({ sessionId: 'S1', task: 'Task 1' });

      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      mgrA.initiateHandoff();

      expect(mgrA.hasHandoffNote()).toBe(true);

      // Same machine resumes
      const mgrA2 = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      const result = mgrA2.resume();

      expect(result.success).toBe(true);
      expect(mgrA2.hasHandoffNote()).toBe(false);
    });

    it('returns own work items', () => {
      ledger.startWork({ sessionId: 'S1', task: 'Own task' });
      ledger.startWork({ sessionId: 'S2', task: 'Another own task' });

      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      mgrA.initiateHandoff();

      const mgrA2 = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      const result = mgrA2.resume();

      expect(result.resumableWork).toHaveLength(2);
      const descriptions = result.resumableWork.map(w => w.description);
      expect(descriptions).toContain('Own task');
      expect(descriptions).toContain('Another own task');
    });

    it('recoveryType is graceful for same-machine resume', () => {
      ledger.startWork({ sessionId: 'S1', task: 'Task' });

      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      mgrA.initiateHandoff();

      const mgrA2 = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      const result = mgrA2.resume();

      expect(result.recoveryType).toBe('graceful');
    });

    it('changesAvailable is true for same-machine resume', () => {
      ledger.startWork({ sessionId: 'S1', task: 'Task' });

      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      mgrA.initiateHandoff();

      const mgrA2 = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      const result = mgrA2.resume();

      // Same machine always has changes available (they're local)
      expect(result.changesAvailable).toBe(true);
    });
  });

  // ── 8. acceptHandoff ─────────────────────────────────────────────

  describe('acceptHandoff', () => {
    it('creates new ledger entries for resumed work', () => {
      ledger.startWork({ sessionId: 'S1', task: 'Original task' });

      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      mgrA.initiateHandoff();

      // Machine B accepts the handoff
      const ledgerB = makeLedger(stateDir, 'machine-b');
      const mgrB = makeManager(tmpDir, stateDir, ledgerB, 'machine-b');
      const resumeResult = mgrB.resume();
      const newEntries = mgrB.acceptHandoff(resumeResult.resumableWork);

      expect(newEntries).toHaveLength(1);
      expect(newEntries[0].machineId).toBe('machine-b');
      expect(newEntries[0].status).toBe('active');
    });

    it('task description includes [resumed from ...] prefix', () => {
      const entry = ledger.startWork({ sessionId: 'S1', task: 'Feature work' });

      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      mgrA.initiateHandoff();

      const ledgerB = makeLedger(stateDir, 'machine-b');
      const mgrB = makeManager(tmpDir, stateDir, ledgerB, 'machine-b');
      const resumeResult = mgrB.resume();
      const newEntries = mgrB.acceptHandoff(resumeResult.resumableWork);

      expect(newEntries[0].task).toContain('[resumed from');
      expect(newEntries[0].task).toContain('Feature work');
    });

    it('clears handoff note after accepting', () => {
      ledger.startWork({ sessionId: 'S1', task: 'Task' });

      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      mgrA.initiateHandoff();

      const ledgerB = makeLedger(stateDir, 'machine-b');
      const mgrB = makeManager(tmpDir, stateDir, ledgerB, 'machine-b');
      const resumeResult = mgrB.resume();
      mgrB.acceptHandoff(resumeResult.resumableWork);

      expect(mgrB.hasHandoffNote()).toBe(false);
    });

    it('returns correct new LedgerEntry array', () => {
      ledger.startWork({
        sessionId: 'S1',
        task: 'Task 1',
        filesPlanned: ['src/a.ts'],
        branch: 'task/a/branch-1',
      });
      ledger.startWork({
        sessionId: 'S2',
        task: 'Task 2',
        filesPlanned: ['src/b.ts'],
      });

      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      mgrA.initiateHandoff();

      const ledgerB = makeLedger(stateDir, 'machine-b');
      const mgrB = makeManager(tmpDir, stateDir, ledgerB, 'machine-b');
      const resumeResult = mgrB.resume();
      const newEntries = mgrB.acceptHandoff(resumeResult.resumableWork);

      expect(newEntries).toHaveLength(2);
      expect(newEntries.every(e => e.machineId === 'machine-b')).toBe(true);
      expect(newEntries.every(e => e.status === 'active')).toBe(true);
      expect(newEntries.every(e => e.id.startsWith('work_'))).toBe(true);
    });

    it('new entries inherit sessionId from work items', () => {
      ledger.startWork({ sessionId: 'S1', task: 'Task 1' });

      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      mgrA.initiateHandoff();

      const ledgerB = makeLedger(stateDir, 'machine-b');
      const mgrB = makeManager(tmpDir, stateDir, ledgerB, 'machine-b');
      const resumeResult = mgrB.resume();
      const newEntries = mgrB.acceptHandoff(resumeResult.resumableWork);

      expect(newEntries[0].sessionId).toBe('S1');
    });

    it('new entries inherit branch from work items', () => {
      ledger.startWork({
        sessionId: 'S1',
        task: 'Branched task',
        branch: 'task/a/feature',
      });

      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      mgrA.initiateHandoff();

      const ledgerB = makeLedger(stateDir, 'machine-b');
      const mgrB = makeManager(tmpDir, stateDir, ledgerB, 'machine-b');
      const resumeResult = mgrB.resume();
      const newEntries = mgrB.acceptHandoff(resumeResult.resumableWork);

      expect(newEntries[0].branch).toBe('task/a/feature');
    });

    it('new entries use filesModified as filesPlanned', () => {
      const entry = ledger.startWork({
        sessionId: 'S1',
        task: 'File inheritance',
        filesPlanned: ['src/a.ts'],
      });
      ledger.updateWork(entry.id, { filesModified: ['src/b.ts'] });

      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      mgrA.initiateHandoff();

      const ledgerB = makeLedger(stateDir, 'machine-b');
      const mgrB = makeManager(tmpDir, stateDir, ledgerB, 'machine-b');
      const resumeResult = mgrB.resume();
      const newEntries = mgrB.acceptHandoff(resumeResult.resumableWork);

      // filesPlanned on new entry should be the filesModified from the work item
      expect(newEntries[0].filesPlanned).toContain('src/a.ts');
      expect(newEntries[0].filesPlanned).toContain('src/b.ts');
    });

    it('accepting empty work items returns empty array', () => {
      const mgrB = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      const result = mgrB.acceptHandoff([]);

      expect(result).toEqual([]);
    });

    it('persists new entries to disk', () => {
      ledger.startWork({ sessionId: 'S1', task: 'Task 1' });

      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      mgrA.initiateHandoff();

      const ledgerB = makeLedger(stateDir, 'machine-b');
      const mgrB = makeManager(tmpDir, stateDir, ledgerB, 'machine-b');
      const resumeResult = mgrB.resume();
      mgrB.acceptHandoff(resumeResult.resumableWork);

      // Read from a fresh ledger instance
      const ledgerB2 = makeLedger(stateDir, 'machine-b');
      const ownLedger = ledgerB2.readOwnLedger();
      expect(ownLedger.entries).toHaveLength(1);
      expect(ownLedger.entries[0].task).toContain('[resumed from');
    });
  });

  // ── 9. Handoff note I/O ──────────────────────────────────────────

  describe('handoff note I/O', () => {
    it('hasHandoffNote returns true when note exists', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);
      mgr.initiateHandoff();

      expect(mgr.hasHandoffNote()).toBe(true);
    });

    it('hasHandoffNote returns false when no note exists', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);

      expect(mgr.hasHandoffNote()).toBe(false);
    });

    it('readHandoffNote returns null when no file exists', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);

      expect(mgr.readHandoffNote()).toBeNull();
    });

    it('readHandoffNote returns note when file exists', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);
      mgr.initiateHandoff({ reason: 'shutdown' });

      const note = mgr.readHandoffNote();
      expect(note).not.toBeNull();
      expect(note!.reason).toBe('shutdown');
      expect(note!.from).toBe('machine-a');
    });

    it('clearHandoffNote removes the file', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);
      mgr.initiateHandoff();

      expect(mgr.hasHandoffNote()).toBe(true);

      mgr.clearHandoffNote();

      expect(mgr.hasHandoffNote()).toBe(false);
      expect(mgr.readHandoffNote()).toBeNull();
    });

    it('clearHandoffNote is safe when no note exists', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);

      // Should not throw
      expect(() => mgr.clearHandoffNote()).not.toThrow();
    });

    it('note survives round-trip (write then read)', () => {
      ledger.startWork({
        sessionId: 'S1',
        task: 'Round trip task',
        filesPlanned: ['src/x.ts', 'src/y.ts'],
        branch: 'task/machine-a/round-trip',
      });

      const mgr = makeManager(tmpDir, stateDir, ledger);
      const handoffResult = mgr.initiateHandoff({
        reason: 'sleep',
        resumeInstructions: 'Continue from step 3',
      });

      // Read it back
      const note = mgr.readHandoffNote();

      expect(note).not.toBeNull();
      expect(note!.schemaVersion).toBe(handoffResult.note!.schemaVersion);
      expect(note!.from).toBe(handoffResult.note!.from);
      expect(note!.reason).toBe('sleep');
      expect(note!.activeWork).toHaveLength(1);
      expect(note!.activeWork[0].description).toBe('Round trip task');
      expect(note!.activeWork[0].resumeInstructions).toBe('Continue from step 3');
      expect(note!.gitHead).toBe(handoffResult.note!.gitHead);
    });

    it('note read by a different manager instance on same stateDir', () => {
      ledger.startWork({ sessionId: 'S1', task: 'Cross instance' });

      const mgr1 = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      mgr1.initiateHandoff();

      // A completely new manager instance (simulating machine-b)
      const ledgerB = makeLedger(stateDir, 'machine-b');
      const mgr2 = makeManager(tmpDir, stateDir, ledgerB, 'machine-b');

      expect(mgr2.hasHandoffNote()).toBe(true);
      const note = mgr2.readHandoffNote();
      expect(note!.from).toBe('machine-a');
    });

    it('readHandoffNote handles corrupted file gracefully', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);

      // Write corrupt data to the handoff file
      const handoffPath = path.join(stateDir, 'state', 'handoff.json');
      fs.writeFileSync(handoffPath, 'not valid json {{{');

      expect(mgr.readHandoffNote()).toBeNull();
    });

    it('activeBranches field is populated in note', () => {
      // Create a task branch that matches the detection pattern
      git(tmpDir, 'branch', 'task/machine-a/feature-1');

      const mgr = makeManager(tmpDir, stateDir, ledger);
      const result = mgr.initiateHandoff();

      expect(result.note!.activeBranches).toContain('task/machine-a/feature-1');
    });

    it('activeBranches is empty when no task branches exist', () => {
      const mgr = makeManager(tmpDir, stateDir, ledger);
      const result = mgr.initiateHandoff();

      expect(result.note!.activeBranches).toEqual([]);
    });
  });

  // ── 10. Full handoff cycle (semantic correctness) ─────────────────

  describe('full handoff cycle — end-to-end', () => {
    it('machine A hands off to machine B, B accepts and continues', () => {
      // Machine A does some work
      ledger.startWork({
        sessionId: 'S1',
        task: 'Implement auth',
        filesPlanned: ['src/auth.ts'],
        branch: 'task/machine-a/auth',
      });

      // Machine A creates a dirty file
      fs.writeFileSync(path.join(tmpDir, 'auth.ts'), 'export function login() {}');

      // Machine A initiates handoff
      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      const handoffResult = mgrA.initiateHandoff({
        reason: 'shutdown',
        resumeInstructions: 'Run auth tests after resuming',
      });

      expect(handoffResult.success).toBe(true);
      expect(handoffResult.wipCommits).toBe(1);
      expect(handoffResult.entriesPaused).toBe(1);

      // Machine B picks up
      const ledgerB = makeLedger(stateDir, 'machine-b');
      const mgrB = makeManager(tmpDir, stateDir, ledgerB, 'machine-b');

      const resumeResult = mgrB.resume();
      expect(resumeResult.success).toBe(true);
      expect(resumeResult.recoveryType).toBe('graceful');
      expect(resumeResult.resumableWork).toHaveLength(1);
      expect(resumeResult.resumableWork[0].resumeInstructions).toBe(
        'Run auth tests after resuming',
      );

      // Machine B accepts the work
      const newEntries = mgrB.acceptHandoff(resumeResult.resumableWork);
      expect(newEntries).toHaveLength(1);
      expect(newEntries[0].machineId).toBe('machine-b');
      expect(newEntries[0].task).toContain('[resumed from');
      expect(newEntries[0].task).toContain('Implement auth');

      // Handoff note should be cleared
      expect(mgrB.hasHandoffNote()).toBe(false);
    });

    it('machine A crashes, machine B recovers stale work', () => {
      // Simulate machine-b having active work that it left behind (crash)
      injectOtherMachineLedger(stateDir, 'machine-b', [
        {
          sessionId: 'CRASH-1',
          task: 'Database migration',
          status: 'active',
          filesPlanned: ['prisma/schema.prisma'],
          filesModified: ['prisma/migrations/001.sql'],
        },
      ]);

      // Machine A starts up — no handoff note exists
      const mgrA = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      const result = mgrA.resume();

      expect(result.success).toBe(true);
      expect(result.recoveryType).toBe('crash-recovery');
      expect(result.resumableWork).toHaveLength(1);
      expect(result.resumableWork[0].description).toBe('Database migration');
      expect(result.resumableWork[0].status).toBe('interrupted');

      // Accept the recovered work
      const newEntries = mgrA.acceptHandoff(result.resumableWork);
      expect(newEntries).toHaveLength(1);
      expect(newEntries[0].machineId).toBe('machine-a');
      expect(newEntries[0].task).toContain('Database migration');
    });

    it('same machine resumes its own handoff seamlessly', () => {
      ledger.startWork({ sessionId: 'S1', task: 'Before sleep' });
      ledger.startWork({ sessionId: 'S2', task: 'Also before sleep' });

      const mgr = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      mgr.initiateHandoff({ reason: 'sleep' });

      // Same machine wakes up
      const mgr2 = makeManager(tmpDir, stateDir, ledger, 'machine-a');
      const result = mgr2.resume();

      expect(result.success).toBe(true);
      expect(result.recoveryType).toBe('graceful');
      expect(result.changesAvailable).toBe(true);
      expect(result.resumableWork).toHaveLength(2);

      // Note was auto-cleared
      expect(mgr2.hasHandoffNote()).toBe(false);
    });
  });
});
