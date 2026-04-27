/**
 * E2E Lifecycle Tests for HandoffManager
 *
 * Per TESTING-INTEGRITY-SPEC Category 3: "The full path from user action
 * to user-visible outcome works end-to-end, with controlled (but real)
 * intermediate components."
 *
 * Tests the complete handoff lifecycle paths: graceful handoff between
 * machines, crash recovery, same-machine resume, multi-work-item handoff,
 * dirty/clean working tree handling. Each test exercises a full user-facing
 * path through real git repos and real WorkLedger state on disk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HandoffManager } from '../../src/core/HandoffManager.js';
import type { HandoffNote, HandoffWorkItem, HandoffResult, ResumeResult } from '../../src/core/HandoffManager.js';
import { WorkLedger } from '../../src/core/WorkLedger.js';
import type { LedgerEntry, MachineLedger } from '../../src/core/WorkLedger.js';

// ── Helpers ──────────────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  // safe-git-allow: incremental-migration
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
    },
  }).trim();
}

/**
 * Create a real git repo with an initial commit. Returns the repo dir.
 * The .instar directory is gitignored so state files don't interfere
 * with dirty-tree detection during handoff.
 */
function createGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-e2e-'));
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);

  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.instar/\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'init'], dir);

  return dir;
}

/**
 * Create a WorkLedger for a given machine, sharing the same stateDir.
 */
function createLedger(stateDir: string, machineId: string): WorkLedger {
  return new WorkLedger({
    stateDir,
    machineId,
  });
}

/**
 * Create a HandoffManager wired to a real git repo with a real WorkLedger.
 */
function createHandoffManager(
  projectDir: string,
  stateDir: string,
  machineId: string,
  workLedger: WorkLedger,
): HandoffManager {
  return new HandoffManager({
    projectDir,
    stateDir,
    machineId,
    workLedger,
  });
}

/**
 * Read the raw handoff note from disk (bypassing the manager).
 */
function readRawHandoffNote(stateDir: string): HandoffNote | null {
  const filePath = path.join(stateDir, 'state', 'handoff.json');
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as HandoffNote;
  } catch {
    return null;
  }
}

/**
 * Read the raw ledger JSON for a machine from disk.
 */
function readRawLedger(stateDir: string, machineId: string): MachineLedger {
  const ledgerPath = path.join(stateDir, 'state', 'ledger', `${machineId}.json`);
  return JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
}

/**
 * Get git log output (one-line per commit).
 */
function gitLog(cwd: string, count: number = 10): string[] {
  const output = git(['log', `--oneline`, `-${count}`], cwd);
  return output.split('\n').filter(l => l.length > 0);
}

/**
 * Get the current git branch.
 */
function currentGitBranch(cwd: string): string {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

// ── Tests ────────────────────────────────────────────────────────────

describe('HandoffManager E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = createGitRepo();
    stateDir = path.join(tmpDir, '.instar');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Scenario 1: Graceful handoff lifecycle ──────────────────────────

  describe('graceful handoff lifecycle', () => {
    it('Machine A initiates handoff -> Machine B resumes and accepts -> handoff note cleared', () => {
      // === Machine A setup ===
      const ledgerA = createLedger(stateDir, 'machine-a');
      const handoffA = createHandoffManager(tmpDir, stateDir, 'machine-a', ledgerA);

      // Step 1: Machine A starts work (creates ledger entry, modifies files)
      const entryA = ledgerA.startWork({
        sessionId: 'AUT-100',
        task: 'Build authentication module',
        filesPlanned: ['src/auth.ts', 'src/middleware.ts'],
      });
      expect(entryA.status).toBe('active');

      // Machine A modifies a tracked file in git
      fs.writeFileSync(path.join(tmpDir, 'auth.ts'), 'export function login() { return true; }\n');
      git(['add', 'auth.ts'], tmpDir);
      git(['commit', '-m', 'feat: add login function'], tmpDir);

      // Update ledger to reflect modified files
      ledgerA.updateWork(entryA.id, {
        filesModified: ['src/auth.ts'],
      });

      // Step 2: Machine A initiates handoff
      const handoffResult = handoffA.initiateHandoff({
        reason: 'user-initiated',
        resumeInstructions: 'Continue with OAuth integration next',
      });

      expect(handoffResult.success).toBe(true);
      expect(handoffResult.entriesPaused).toBe(1);
      // Working tree was clean (committed above), so no WIP commit needed
      expect(handoffResult.note).toBeDefined();
      expect(handoffResult.note!.from).toBe('machine-a');
      expect(handoffResult.note!.reason).toBe('user-initiated');
      expect(handoffResult.note!.activeWork).toHaveLength(1);
      expect(handoffResult.note!.activeWork[0].status).toBe('paused');
      expect(handoffResult.note!.activeWork[0].description).toBe('Build authentication module');
      expect(handoffResult.note!.activeWork[0].resumeInstructions).toBe('Continue with OAuth integration next');

      // Verify handoff note exists on disk
      const noteOnDisk = readRawHandoffNote(stateDir);
      expect(noteOnDisk).not.toBeNull();
      expect(noteOnDisk!.from).toBe('machine-a');

      // Verify ledger entry was paused
      const rawLedgerA = readRawLedger(stateDir, 'machine-a');
      const pausedEntry = rawLedgerA.entries.find(e => e.id === entryA.id);
      expect(pausedEntry).toBeDefined();
      expect(pausedEntry!.status).toBe('paused');

      // === Machine B setup ===
      const ledgerB = createLedger(stateDir, 'machine-b');
      const handoffB = createHandoffManager(tmpDir, stateDir, 'machine-b', ledgerB);

      // Step 3: Machine B calls resume()
      const resumeResult = handoffB.resume();

      expect(resumeResult.success).toBe(true);
      expect(resumeResult.recoveryType).toBe('graceful');
      expect(resumeResult.note).toBeDefined();
      expect(resumeResult.note!.from).toBe('machine-a');
      expect(resumeResult.resumableWork).toHaveLength(1);
      expect(resumeResult.resumableWork[0].description).toBe('Build authentication module');
      expect(resumeResult.resumableWork[0].resumeInstructions).toBe('Continue with OAuth integration next');

      // Step 4: Machine B accepts the handoff
      const newEntries = handoffB.acceptHandoff(resumeResult.resumableWork);

      expect(newEntries).toHaveLength(1);
      expect(newEntries[0].machineId).toBe('machine-b');
      expect(newEntries[0].status).toBe('active');
      expect(newEntries[0].task).toContain('resumed from');
      expect(newEntries[0].task).toContain('Build authentication module');

      // Step 5: Verify Machine B has new ledger entries
      const rawLedgerB = readRawLedger(stateDir, 'machine-b');
      expect(rawLedgerB.entries).toHaveLength(1);
      expect(rawLedgerB.entries[0].status).toBe('active');

      // Step 6: Handoff note cleared after accept
      expect(handoffB.hasHandoffNote()).toBe(false);
      const noteAfterAccept = readRawHandoffNote(stateDir);
      expect(noteAfterAccept).toBeNull();
    });
  });

  // ── Scenario 2: Crash recovery lifecycle ────────────────────────────

  describe('crash recovery lifecycle', () => {
    it('Machine A crashes (no handoff note) -> Machine B detects stale entries -> crash-recovery', () => {
      // === Machine A starts work and "crashes" ===
      const ledgerA = createLedger(stateDir, 'machine-a');

      // Step 1: Machine A creates ledger entries (simulating active work)
      const entry1 = ledgerA.startWork({
        sessionId: 'AUT-200',
        task: 'Database migration',
        filesPlanned: ['prisma/schema.prisma', 'lib/db.ts'],
      });
      expect(entry1.status).toBe('active');

      const entry2 = ledgerA.startWork({
        sessionId: 'AUT-200',
        task: 'API route updates',
        filesPlanned: ['pages/api/users.ts'],
      });
      expect(entry2.status).toBe('active');

      // Step 2: Simulate crash -- Machine A disappears without initiating handoff.
      // No handoff note is written. Entries remain as active (will appear stale to others).

      // === Machine B tries to resume ===
      const ledgerB = createLedger(stateDir, 'machine-b');
      const handoffB = createHandoffManager(tmpDir, stateDir, 'machine-b', ledgerB);

      // Step 3: Machine B calls resume()
      const resumeResult = handoffB.resume();

      expect(resumeResult.success).toBe(true);
      // No handoff note found, but stale entries from Machine A detected
      expect(resumeResult.note).toBeUndefined();
      expect(resumeResult.recoveryType).toBe('crash-recovery');
      expect(resumeResult.resumableWork).toHaveLength(2);

      // Work items show as 'interrupted' (not 'paused')
      for (const item of resumeResult.resumableWork) {
        expect(item.status).toBe('interrupted');
      }

      // Verify the work items match Machine A's entries
      const descriptions = resumeResult.resumableWork.map(w => w.description).sort();
      expect(descriptions).toEqual(['API route updates', 'Database migration']);

      // Step 4: Machine B can accept the interrupted work
      const newEntries = handoffB.acceptHandoff(resumeResult.resumableWork);
      expect(newEntries).toHaveLength(2);

      for (const entry of newEntries) {
        expect(entry.machineId).toBe('machine-b');
        expect(entry.status).toBe('active');
        expect(entry.task).toContain('resumed from');
      }

      // Machine B now has its own entries in the ledger
      const rawLedgerB = readRawLedger(stateDir, 'machine-b');
      expect(rawLedgerB.entries).toHaveLength(2);
    });
  });

  // ── Scenario 3: Same-machine resume lifecycle ───────────────────────

  describe('same-machine resume lifecycle', () => {
    it('Machine A handoffs to itself (e.g., sleep) -> resumes on same machine -> note cleared', () => {
      const ledgerA = createLedger(stateDir, 'machine-a');
      const handoffA = createHandoffManager(tmpDir, stateDir, 'machine-a', ledgerA);

      // Step 1: Machine A starts work
      const entry = ledgerA.startWork({
        sessionId: 'AUT-300',
        task: 'Refactor utilities',
        filesPlanned: ['src/utils.ts'],
      });
      expect(entry.status).toBe('active');

      // Step 2: Machine A initiates handoff (going to sleep)
      const handoffResult = handoffA.initiateHandoff({ reason: 'sleep' });
      expect(handoffResult.success).toBe(true);
      expect(handoffResult.entriesPaused).toBe(1);
      expect(handoffResult.note!.reason).toBe('sleep');

      // Verify handoff note exists
      expect(handoffA.hasHandoffNote()).toBe(true);

      // Step 3: Same machine (Machine A) calls resume()
      const resumeResult = handoffA.resume();

      expect(resumeResult.success).toBe(true);
      expect(resumeResult.recoveryType).toBe('graceful');
      // The note's `from` matches this machine's ID
      expect(resumeResult.note).toBeDefined();
      expect(resumeResult.note!.from).toBe('machine-a');

      // Step 4: Handoff note is cleared automatically for same-machine resume
      expect(handoffA.hasHandoffNote()).toBe(false);

      // Step 5: Machine A has its own resumable work items
      expect(resumeResult.resumableWork).toHaveLength(1);
      expect(resumeResult.resumableWork[0].description).toBe('Refactor utilities');
      expect(resumeResult.resumableWork[0].status).toBe('paused');
    });
  });

  // ── Scenario 4: Multiple work items handoff ─────────────────────────

  describe('multiple work items handoff', () => {
    it('Machine A has 3 active entries -> handoff pauses all 3 -> Machine B resumes all 3', () => {
      const ledgerA = createLedger(stateDir, 'machine-a');
      const handoffA = createHandoffManager(tmpDir, stateDir, 'machine-a', ledgerA);

      // Step 1: Machine A starts 3 active ledger entries on different tasks
      const entry1 = ledgerA.startWork({
        sessionId: 'AUT-400',
        task: 'Auth module',
        filesPlanned: ['src/auth.ts'],
        branch: 'task/machine-a/auth',
      });

      const entry2 = ledgerA.startWork({
        sessionId: 'AUT-401',
        task: 'Database schema update',
        filesPlanned: ['prisma/schema.prisma', 'lib/db.ts'],
      });

      const entry3 = ledgerA.startWork({
        sessionId: 'AUT-402',
        task: 'Frontend dashboard',
        filesPlanned: ['pages/dashboard.tsx', 'components/Chart.tsx'],
      });

      // Verify all 3 are active
      const rawBefore = readRawLedger(stateDir, 'machine-a');
      const activeBefore = rawBefore.entries.filter(e => e.status === 'active');
      expect(activeBefore).toHaveLength(3);

      // Step 2: Machine A initiates handoff
      const handoffResult = handoffA.initiateHandoff({ reason: 'shutdown' });

      expect(handoffResult.success).toBe(true);
      expect(handoffResult.entriesPaused).toBe(3);
      expect(handoffResult.note!.activeWork).toHaveLength(3);

      // All 3 should be paused in the note
      for (const item of handoffResult.note!.activeWork) {
        expect(item.status).toBe('paused');
      }

      // Verify note has all 3 descriptions
      const noteDescriptions = handoffResult.note!.activeWork.map(w => w.description).sort();
      expect(noteDescriptions).toEqual(['Auth module', 'Database schema update', 'Frontend dashboard']);

      // Step 3: All 3 paused in the ledger
      const rawAfter = readRawLedger(stateDir, 'machine-a');
      const pausedAfter = rawAfter.entries.filter(e => e.status === 'paused');
      expect(pausedAfter).toHaveLength(3);

      // === Machine B ===
      const ledgerB = createLedger(stateDir, 'machine-b');
      const handoffB = createHandoffManager(tmpDir, stateDir, 'machine-b', ledgerB);

      // Step 4: Machine B resumes
      const resumeResult = handoffB.resume();
      expect(resumeResult.success).toBe(true);
      expect(resumeResult.resumableWork).toHaveLength(3);

      // Step 5: Machine B accepts all 3
      const newEntries = handoffB.acceptHandoff(resumeResult.resumableWork);
      expect(newEntries).toHaveLength(3);

      // Step 6: Machine B has 3 new ledger entries
      const rawLedgerB = readRawLedger(stateDir, 'machine-b');
      expect(rawLedgerB.entries).toHaveLength(3);

      for (const entry of rawLedgerB.entries) {
        expect(entry.machineId).toBe('machine-b');
        expect(entry.status).toBe('active');
        expect(entry.task).toContain('resumed from');
      }

      // Verify the branch field was carried over for the entry that had one
      const authEntry = rawLedgerB.entries.find(e => e.task.includes('Auth module'));
      expect(authEntry).toBeDefined();
      expect(authEntry!.branch).toBe('task/machine-a/auth');

      // Step 7: Handoff note is cleared
      expect(handoffB.hasHandoffNote()).toBe(false);
    });
  });

  // ── Scenario 5: Dirty working tree handoff ──────────────────────────

  describe('dirty working tree handoff', () => {
    it('Machine A has uncommitted changes -> handoff creates WIP commit -> wipCommits = 1', () => {
      const ledgerA = createLedger(stateDir, 'machine-a');
      const handoffA = createHandoffManager(tmpDir, stateDir, 'machine-a', ledgerA);

      // Step 1: Machine A starts work
      ledgerA.startWork({
        sessionId: 'AUT-500',
        task: 'Experimental feature',
        filesPlanned: ['src/experiment.ts'],
      });

      // Step 2: Machine A modifies files WITHOUT committing
      fs.writeFileSync(path.join(tmpDir, 'experiment.ts'), 'export function experiment() { return 42; }\n');
      fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'Work in progress notes\n');

      // Verify working tree is dirty
      const statusBefore = git(['status', '--porcelain'], tmpDir);
      expect(statusBefore.length).toBeGreaterThan(0);

      // Step 3: Machine A initiates handoff
      const handoffResult = handoffA.initiateHandoff({ reason: 'user-initiated' });

      expect(handoffResult.success).toBe(true);
      expect(handoffResult.wipCommits).toBe(1);

      // Step 4: Verify WIP commit was created (check git log)
      const log = gitLog(tmpDir, 3);
      const wipCommitLine = log.find(l => l.includes('wip(machine-a)'));
      expect(wipCommitLine).toBeDefined();

      // Step 5: Working tree should now be clean
      const statusAfter = git(['status', '--porcelain'], tmpDir);
      expect(statusAfter.trim()).toBe('');

      // Step 6: Handoff note reflects the WIP commit
      const note = readRawHandoffNote(stateDir);
      expect(note).not.toBeNull();
      expect(note!.uncommittedNotes).toContain('WIP commit');

      // Step 7: Committed files are in the repo
      expect(fs.existsSync(path.join(tmpDir, 'experiment.ts'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'notes.txt'))).toBe(true);
    });
  });

  // ── Scenario 6: Clean working tree handoff ──────────────────────────

  describe('clean working tree handoff', () => {
    it('Machine A has committed everything -> no WIP commit needed -> wipCommits = 0', () => {
      const ledgerA = createLedger(stateDir, 'machine-a');
      const handoffA = createHandoffManager(tmpDir, stateDir, 'machine-a', ledgerA);

      // Step 1: Machine A starts work
      ledgerA.startWork({
        sessionId: 'AUT-600',
        task: 'Clean refactor',
        filesPlanned: ['src/clean.ts'],
      });

      // Step 2: Machine A commits all changes properly
      fs.writeFileSync(path.join(tmpDir, 'clean.ts'), 'export function clean() { return "spotless"; }\n');
      git(['add', 'clean.ts'], tmpDir);
      git(['commit', '-m', 'feat: add clean module'], tmpDir);

      // Verify working tree is clean
      const statusBefore = git(['status', '--porcelain'], tmpDir);
      expect(statusBefore.trim()).toBe('');

      // Count commits before handoff
      const logBefore = gitLog(tmpDir, 10);
      const commitCountBefore = logBefore.length;

      // Step 3: Machine A initiates handoff
      const handoffResult = handoffA.initiateHandoff({ reason: 'inactivity' });

      expect(handoffResult.success).toBe(true);
      expect(handoffResult.wipCommits).toBe(0);

      // Step 4: No WIP commit was created (commit count unchanged)
      const logAfter = gitLog(tmpDir, 10);
      expect(logAfter.length).toBe(commitCountBefore);

      // No WIP commit message in the log
      const hasWipCommit = logAfter.some(l => l.includes('wip(machine-a)'));
      expect(hasWipCommit).toBe(false);

      // Step 5: Handoff note says "None" for uncommitted notes
      const note = readRawHandoffNote(stateDir);
      expect(note).not.toBeNull();
      expect(note!.uncommittedNotes).toContain('None');

      // Step 6: Note reason matches
      expect(note!.reason).toBe('inactivity');
    });
  });

  // ── Cross-cutting: Handoff note schema version ──────────────────────

  describe('handoff note metadata', () => {
    it('handoff note includes schema version and git HEAD', () => {
      const ledgerA = createLedger(stateDir, 'machine-a');
      const handoffA = createHandoffManager(tmpDir, stateDir, 'machine-a', ledgerA);

      ledgerA.startWork({
        sessionId: 'AUT-700',
        task: 'Metadata test',
        filesPlanned: ['src/meta.ts'],
      });

      const handoffResult = handoffA.initiateHandoff();
      expect(handoffResult.success).toBe(true);

      const note = handoffResult.note!;
      expect(note.schemaVersion).toBe(1);
      expect(note.gitHead).toBeDefined();
      expect(note.gitHead).not.toBe('unknown');
      // Git HEAD should be a valid SHA (at least 7 chars hex)
      expect(note.gitHead).toMatch(/^[0-9a-f]{7,40}$/);
      expect(note.at).toBeDefined();
      // ISO timestamp
      expect(new Date(note.at).getTime()).not.toBeNaN();
    });
  });

  // ── Cross-cutting: Fresh start when no work exists ──────────────────

  describe('fresh start when no prior work exists', () => {
    it('resume on a clean slate returns fresh-start with no resumable work', () => {
      const ledgerB = createLedger(stateDir, 'machine-b');
      const handoffB = createHandoffManager(tmpDir, stateDir, 'machine-b', ledgerB);

      // No handoff note, no stale entries from other machines
      const resumeResult = handoffB.resume();

      expect(resumeResult.success).toBe(true);
      expect(resumeResult.recoveryType).toBe('fresh-start');
      expect(resumeResult.resumableWork).toHaveLength(0);
      expect(resumeResult.note).toBeUndefined();
    });
  });

  // ── Cross-cutting: acceptHandoff is idempotent on note clearing ─────

  describe('acceptHandoff clears note exactly once', () => {
    it('calling acceptHandoff twice does not error (note already cleared)', () => {
      const ledgerA = createLedger(stateDir, 'machine-a');
      const handoffA = createHandoffManager(tmpDir, stateDir, 'machine-a', ledgerA);

      ledgerA.startWork({
        sessionId: 'AUT-800',
        task: 'Idempotent test',
        filesPlanned: ['src/idem.ts'],
      });

      handoffA.initiateHandoff();

      const ledgerB = createLedger(stateDir, 'machine-b');
      const handoffB = createHandoffManager(tmpDir, stateDir, 'machine-b', ledgerB);

      const resumeResult = handoffB.resume();
      expect(resumeResult.resumableWork.length).toBeGreaterThan(0);

      // First accept
      const entries1 = handoffB.acceptHandoff(resumeResult.resumableWork);
      expect(entries1).toHaveLength(1);
      expect(handoffB.hasHandoffNote()).toBe(false);

      // Second accept with same items -- should not throw
      const entries2 = handoffB.acceptHandoff(resumeResult.resumableWork);
      expect(entries2).toHaveLength(1);
      // Note was already cleared; clearHandoffNote handles missing file gracefully
      expect(handoffB.hasHandoffNote()).toBe(false);
    });
  });
});
