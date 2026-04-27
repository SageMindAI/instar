/**
 * Wiring Integrity Tests for HandoffManager
 *
 * Per TESTING-INTEGRITY-SPEC Category 1: "For every dependency-injected function, test that:
 *   1. It is not null/undefined when the feature is enabled
 *   2. It is not a no-op (calling it produces observable side effects)
 *   3. It delegates to the real implementation (not a stub)"
 *
 * These tests verify HandoffManager produces real filesystem and git side effects:
 *   - Construction creates the state directory
 *   - initiateHandoff writes a handoff note to disk
 *   - initiateHandoff delegates to a real WorkLedger (pauses entries)
 *   - WIP commits appear in real git log
 *   - resume() reads a real handoff note from disk (cross-machine)
 *   - acceptHandoff() creates real ledger entries via WorkLedger
 *
 * All tests run against real temp directories with real git repos.
 * No mocks, no stubs — wiring integrity means real I/O.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HandoffManager } from '../../src/core/HandoffManager.js';
import { WorkLedger } from '../../src/core/WorkLedger.js';
import type { HandoffNote } from '../../src/core/HandoffManager.js';
import type { MachineLedger } from '../../src/core/WorkLedger.js';

// ── Helpers ─────────────────────────────────────────────────────────

/** Run a git command in the given directory. */
function git(cwd: string, ...args: string[]): string {
  // safe-git-allow: incremental-migration
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 10_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/** Initialize a real git repo with an initial commit so HEAD exists. */
function initGitRepo(dir: string): void {
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@test.local');
  git(dir, 'config', 'user.name', 'Test');
  // Create an initial commit so HEAD is valid
  const readmePath = path.join(dir, 'README.md');
  fs.writeFileSync(readmePath, '# Test repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'initial commit');
}

/** Path to the handoff note file on disk. */
function handoffFilePath(stateDir: string): string {
  return path.join(stateDir, 'state', 'handoff.json');
}

/** Path to a machine's ledger file on disk. */
function ledgerFilePath(stateDir: string, machineId: string): string {
  return path.join(stateDir, 'state', 'ledger', `${machineId}.json`);
}

// ── Tests ───────────────────────────────────────────────────────────

describe('HandoffManager wiring integrity', () => {
  let tmpDir: string;
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-wiring-'));
    projectDir = path.join(tmpDir, 'project');
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(projectDir, { recursive: true });
    initGitRepo(projectDir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. Construction — not null/undefined ──────────────────────────

  describe('construction', () => {
    it('HandoffManager is defined and not null when constructed with valid config', () => {
      const ledger = new WorkLedger({ stateDir, machineId: 'machine-A' });
      const manager = new HandoffManager({
        projectDir,
        stateDir,
        machineId: 'machine-A',
        workLedger: ledger,
      });

      expect(manager).toBeDefined();
      expect(manager).not.toBeNull();
      expect(manager).toBeInstanceOf(HandoffManager);
    });

    it('state directory is created on construction', () => {
      const stateDirPath = path.join(stateDir, 'state');
      expect(fs.existsSync(stateDirPath)).toBe(false);

      const ledger = new WorkLedger({ stateDir, machineId: 'machine-A' });
      new HandoffManager({
        projectDir,
        stateDir,
        machineId: 'machine-A',
        workLedger: ledger,
      });

      expect(fs.existsSync(stateDirPath)).toBe(true);
      expect(fs.statSync(stateDirPath).isDirectory()).toBe(true);
    });

    it('construction is idempotent (no error on second construction)', () => {
      const ledger = new WorkLedger({ stateDir, machineId: 'machine-A' });

      new HandoffManager({
        projectDir,
        stateDir,
        machineId: 'machine-A',
        workLedger: ledger,
      });

      const manager2 = new HandoffManager({
        projectDir,
        stateDir,
        machineId: 'machine-A',
        workLedger: ledger,
      });

      expect(manager2).toBeDefined();
    });
  });

  // ── 2. initiateHandoff is functional (not a no-op) ────────────────

  describe('initiateHandoff produces observable side effects', () => {
    it('creates a handoff note file on disk', () => {
      const ledger = new WorkLedger({ stateDir, machineId: 'machine-A' });
      const manager = new HandoffManager({
        projectDir,
        stateDir,
        machineId: 'machine-A',
        workLedger: ledger,
      });

      // Create some active work so the handoff has content
      ledger.startWork({ sessionId: 'AUT-500', task: 'Build feature X' });

      const notePath = handoffFilePath(stateDir);
      expect(fs.existsSync(notePath)).toBe(false);

      const result = manager.initiateHandoff({ reason: 'user-initiated' });

      expect(result.success).toBe(true);
      expect(fs.existsSync(notePath)).toBe(true);
    });

    it('handoff note file is valid JSON verified via raw fs.readFileSync', () => {
      const ledger = new WorkLedger({ stateDir, machineId: 'machine-A' });
      const manager = new HandoffManager({
        projectDir,
        stateDir,
        machineId: 'machine-A',
        workLedger: ledger,
      });

      ledger.startWork({ sessionId: 'AUT-501', task: 'Implement auth' });
      manager.initiateHandoff({ reason: 'shutdown' });

      const raw = fs.readFileSync(handoffFilePath(stateDir), 'utf-8');
      const parsed = JSON.parse(raw) as HandoffNote;

      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.from).toBe('machine-A');
      expect(parsed.reason).toBe('shutdown');
      expect(parsed.at).toBeTruthy();
      expect(parsed.activeWork).toBeInstanceOf(Array);
      expect(typeof parsed.allChangesPushed).toBe('boolean');
      expect(typeof parsed.gitHead).toBe('string');
    });

    it('result reflects the number of entries paused', () => {
      const ledger = new WorkLedger({ stateDir, machineId: 'machine-A' });
      const manager = new HandoffManager({
        projectDir,
        stateDir,
        machineId: 'machine-A',
        workLedger: ledger,
      });

      ledger.startWork({ sessionId: 'AUT-502', task: 'Task one' });
      ledger.startWork({ sessionId: 'AUT-503', task: 'Task two' });
      ledger.startWork({ sessionId: 'AUT-504', task: 'Task three' });

      const result = manager.initiateHandoff();
      expect(result.success).toBe(true);
      expect(result.entriesPaused).toBe(3);
    });

    it('handoff note activeWork contains descriptions matching ledger entries', () => {
      const ledger = new WorkLedger({ stateDir, machineId: 'machine-A' });
      const manager = new HandoffManager({
        projectDir,
        stateDir,
        machineId: 'machine-A',
        workLedger: ledger,
      });

      ledger.startWork({
        sessionId: 'AUT-505',
        task: 'Refactor database layer',
        filesPlanned: ['src/db.ts', 'src/models.ts'],
      });

      manager.initiateHandoff({ resumeInstructions: 'Continue the migration' });

      const raw = fs.readFileSync(handoffFilePath(stateDir), 'utf-8');
      const parsed = JSON.parse(raw) as HandoffNote;

      expect(parsed.activeWork).toHaveLength(1);
      expect(parsed.activeWork[0].description).toBe('Refactor database layer');
      expect(parsed.activeWork[0].sessionId).toBe('AUT-505');
      expect(parsed.activeWork[0].status).toBe('paused');
      expect(parsed.activeWork[0].resumeInstructions).toBe('Continue the migration');
      expect(parsed.activeWork[0].filesModified).toContain('src/db.ts');
      expect(parsed.activeWork[0].filesModified).toContain('src/models.ts');
    });
  });

  // ── 3. Delegates to real WorkLedger ───────────────────────────────

  describe('delegates to real WorkLedger', () => {
    it('initiateHandoff pauses entries written by a real WorkLedger instance', () => {
      const machineId = 'machine-delegator';
      const ledger = new WorkLedger({ stateDir, machineId });
      const manager = new HandoffManager({
        projectDir,
        stateDir,
        machineId,
        workLedger: ledger,
      });

      // Write active entries via the real WorkLedger
      const entry1 = ledger.startWork({ sessionId: 'AUT-600', task: 'Active task 1' });
      const entry2 = ledger.startWork({ sessionId: 'AUT-601', task: 'Active task 2' });

      // Verify they are active before handoff
      const beforeLedger = ledger.readOwnLedger();
      expect(beforeLedger.entries.filter(e => e.status === 'active')).toHaveLength(2);

      // Perform handoff
      const result = manager.initiateHandoff();
      expect(result.success).toBe(true);
      expect(result.entriesPaused).toBe(2);

      // Verify entries are paused via a SEPARATE WorkLedger read
      const verifyLedger = new WorkLedger({ stateDir, machineId });
      const afterEntries = verifyLedger.readOwnLedger();

      const pausedEntries = afterEntries.entries.filter(e => e.status === 'paused');
      expect(pausedEntries).toHaveLength(2);

      const pausedIds = pausedEntries.map(e => e.id).sort();
      expect(pausedIds).toContain(entry1.id);
      expect(pausedIds).toContain(entry2.id);

      // No active entries remain
      const activeEntries = afterEntries.entries.filter(e => e.status === 'active');
      expect(activeEntries).toHaveLength(0);
    });

    it('paused status is persisted on disk (verified via raw fs read)', () => {
      const machineId = 'machine-persist-check';
      const ledger = new WorkLedger({ stateDir, machineId });
      const manager = new HandoffManager({
        projectDir,
        stateDir,
        machineId,
        workLedger: ledger,
      });

      ledger.startWork({ sessionId: 'AUT-602', task: 'Will be paused' });
      manager.initiateHandoff();

      // Read raw file, bypass all WorkLedger/HandoffManager APIs
      const raw = fs.readFileSync(ledgerFilePath(stateDir, machineId), 'utf-8');
      const parsed = JSON.parse(raw) as MachineLedger;

      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0].status).toBe('paused');
      expect(parsed.entries[0].task).toBe('Will be paused');
    });
  });

  // ── 4. Delegates to real git ──────────────────────────────────────

  describe('delegates to real git', () => {
    it('WIP commit creates an actual git commit visible in git log', () => {
      const ledger = new WorkLedger({ stateDir, machineId: 'machine-git' });
      const manager = new HandoffManager({
        projectDir,
        stateDir,
        machineId: 'machine-git',
        workLedger: ledger,
      });

      // Create a dirty working tree so commitWip has something to commit
      const dirtyFile = path.join(projectDir, 'dirty.txt');
      fs.writeFileSync(dirtyFile, 'uncommitted work\n');

      ledger.startWork({ sessionId: 'AUT-700', task: 'Git wiring test' });

      const commitsBefore = git(projectDir, 'rev-list', '--count', 'HEAD');
      const result = manager.initiateHandoff({ reason: 'shutdown' });
      const commitsAfter = git(projectDir, 'rev-list', '--count', 'HEAD');

      expect(result.success).toBe(true);
      expect(result.wipCommits).toBe(1);
      expect(parseInt(commitsAfter)).toBeGreaterThan(parseInt(commitsBefore));

      // Verify the WIP commit message in git log
      const lastCommitMsg = git(projectDir, 'log', '-1', '--format=%s');
      expect(lastCommitMsg).toContain('wip(machine-git)');
      expect(lastCommitMsg).toContain('handoff');
    });

    it('handoff note reflects the real git HEAD', () => {
      const ledger = new WorkLedger({ stateDir, machineId: 'machine-head' });
      const manager = new HandoffManager({
        projectDir,
        stateDir,
        machineId: 'machine-head',
        workLedger: ledger,
      });

      ledger.startWork({ sessionId: 'AUT-701', task: 'HEAD check' });
      manager.initiateHandoff();

      const raw = fs.readFileSync(handoffFilePath(stateDir), 'utf-8');
      const parsed = JSON.parse(raw) as HandoffNote;

      // gitHead should match the actual current HEAD
      const realHead = git(projectDir, 'rev-parse', 'HEAD');
      expect(parsed.gitHead).toBe(realHead);
      // HEAD should be a valid 40-char SHA
      expect(parsed.gitHead).toMatch(/^[a-f0-9]{40}$/);
    });

    it('no WIP commit when working tree is clean', () => {
      const ledger = new WorkLedger({ stateDir, machineId: 'machine-clean' });
      const manager = new HandoffManager({
        projectDir,
        stateDir,
        machineId: 'machine-clean',
        workLedger: ledger,
      });

      ledger.startWork({ sessionId: 'AUT-702', task: 'Clean tree test' });

      const commitsBefore = git(projectDir, 'rev-list', '--count', 'HEAD');
      const result = manager.initiateHandoff();
      const commitsAfter = git(projectDir, 'rev-list', '--count', 'HEAD');

      expect(result.success).toBe(true);
      expect(result.wipCommits).toBe(0);
      expect(commitsBefore).toBe(commitsAfter);
    });
  });

  // ── 5. resume reads real handoff note from disk ───────────────────

  describe('resume reads real handoff note from disk', () => {
    it('machine B resumes from a handoff note written by machine A', () => {
      // Machine A: create ledger, work, handoff
      const ledgerA = new WorkLedger({ stateDir, machineId: 'machine-A' });
      const managerA = new HandoffManager({
        projectDir,
        stateDir,
        machineId: 'machine-A',
        workLedger: ledgerA,
      });

      ledgerA.startWork({
        sessionId: 'AUT-800',
        task: 'Cross-machine feature',
        filesPlanned: ['src/feature.ts'],
      });

      const handoffResult = managerA.initiateHandoff({
        reason: 'sleep',
        resumeInstructions: 'Pick up from the API integration',
      });
      expect(handoffResult.success).toBe(true);

      // Verify handoff note exists on disk before machine B reads it
      expect(fs.existsSync(handoffFilePath(stateDir))).toBe(true);

      // Machine B: new HandoffManager with different machineId, same stateDir
      const ledgerB = new WorkLedger({ stateDir, machineId: 'machine-B' });
      const managerB = new HandoffManager({
        projectDir,
        stateDir,
        machineId: 'machine-B',
        workLedger: ledgerB,
      });

      const resumeResult = managerB.resume();

      expect(resumeResult.success).toBe(true);
      expect(resumeResult.recoveryType).toBe('graceful');
      expect(resumeResult.note).toBeDefined();
      expect(resumeResult.note!.from).toBe('machine-A');
      expect(resumeResult.note!.reason).toBe('sleep');
      expect(resumeResult.resumableWork).toHaveLength(1);
      expect(resumeResult.resumableWork[0].description).toBe('Cross-machine feature');
      expect(resumeResult.resumableWork[0].resumeInstructions).toBe('Pick up from the API integration');
    });

    it('resume returns fresh-start when no handoff note exists', () => {
      const ledger = new WorkLedger({ stateDir, machineId: 'machine-fresh' });
      const manager = new HandoffManager({
        projectDir,
        stateDir,
        machineId: 'machine-fresh',
        workLedger: ledger,
      });

      expect(fs.existsSync(handoffFilePath(stateDir))).toBe(false);

      const result = manager.resume();

      expect(result.success).toBe(true);
      expect(result.recoveryType).toBe('fresh-start');
      expect(result.resumableWork).toHaveLength(0);
    });

    it('same machine resuming clears the handoff note', () => {
      const ledger = new WorkLedger({ stateDir, machineId: 'machine-self' });
      const manager = new HandoffManager({
        projectDir,
        stateDir,
        machineId: 'machine-self',
        workLedger: ledger,
      });

      ledger.startWork({ sessionId: 'AUT-801', task: 'Self resume test' });
      manager.initiateHandoff();

      expect(fs.existsSync(handoffFilePath(stateDir))).toBe(true);

      const result = manager.resume();

      expect(result.success).toBe(true);
      expect(result.recoveryType).toBe('graceful');
      expect(result.note!.from).toBe('machine-self');
      // Handoff note should be cleared after same-machine resume
      expect(fs.existsSync(handoffFilePath(stateDir))).toBe(false);
    });
  });

  // ── 6. acceptHandoff creates real ledger entries ──────────────────

  describe('acceptHandoff creates real ledger entries', () => {
    it('acceptHandoff creates entries readable via WorkLedger.getActiveEntries()', () => {
      // Machine A: create work and handoff
      const ledgerA = new WorkLedger({ stateDir, machineId: 'machine-A' });
      const managerA = new HandoffManager({
        projectDir,
        stateDir,
        machineId: 'machine-A',
        workLedger: ledgerA,
      });

      ledgerA.startWork({
        sessionId: 'AUT-900',
        task: 'Feature alpha',
        filesPlanned: ['src/alpha.ts'],
        branch: 'task/alpha',
      });
      ledgerA.startWork({
        sessionId: 'AUT-901',
        task: 'Feature beta',
        filesPlanned: ['src/beta.ts'],
      });

      const handoffResult = managerA.initiateHandoff({ reason: 'inactivity' });
      expect(handoffResult.success).toBe(true);

      // Machine B: resume and accept
      const ledgerB = new WorkLedger({ stateDir, machineId: 'machine-B' });
      const managerB = new HandoffManager({
        projectDir,
        stateDir,
        machineId: 'machine-B',
        workLedger: ledgerB,
      });

      const resumeResult = managerB.resume();
      expect(resumeResult.success).toBe(true);
      expect(resumeResult.resumableWork.length).toBeGreaterThan(0);

      const newEntries = managerB.acceptHandoff(resumeResult.resumableWork);

      // Verify entries were created
      expect(newEntries).toHaveLength(2);
      expect(newEntries[0].machineId).toBe('machine-B');
      expect(newEntries[1].machineId).toBe('machine-B');
      expect(newEntries[0].status).toBe('active');
      expect(newEntries[1].status).toBe('active');

      // Task descriptions should reference the original entry IDs
      expect(newEntries[0].task).toContain('[resumed from');
      expect(newEntries[0].task).toContain('Feature alpha');
      expect(newEntries[1].task).toContain('Feature beta');

      // Verify via WorkLedger.getActiveEntries() — the canonical read path
      const activeEntries = ledgerB.getActiveEntries();
      const machineBActive = activeEntries.filter(e => e.machineId === 'machine-B');

      expect(machineBActive).toHaveLength(2);
      const tasks = machineBActive.map(e => e.task);
      expect(tasks.some(t => t.includes('Feature alpha'))).toBe(true);
      expect(tasks.some(t => t.includes('Feature beta'))).toBe(true);
    });

    it('acceptHandoff clears the handoff note from disk', () => {
      const ledgerA = new WorkLedger({ stateDir, machineId: 'machine-A' });
      const managerA = new HandoffManager({
        projectDir,
        stateDir,
        machineId: 'machine-A',
        workLedger: ledgerA,
      });

      ledgerA.startWork({ sessionId: 'AUT-902', task: 'Clearable task' });
      managerA.initiateHandoff();

      expect(fs.existsSync(handoffFilePath(stateDir))).toBe(true);

      const ledgerB = new WorkLedger({ stateDir, machineId: 'machine-B' });
      const managerB = new HandoffManager({
        projectDir,
        stateDir,
        machineId: 'machine-B',
        workLedger: ledgerB,
      });

      const resumeResult = managerB.resume();
      managerB.acceptHandoff(resumeResult.resumableWork);

      // Handoff note should be cleared after accept
      expect(fs.existsSync(handoffFilePath(stateDir))).toBe(false);
    });

    it('accepted entries persist on disk (verified via raw fs read)', () => {
      const ledgerA = new WorkLedger({ stateDir, machineId: 'machine-A' });
      const managerA = new HandoffManager({
        projectDir,
        stateDir,
        machineId: 'machine-A',
        workLedger: ledgerA,
      });

      ledgerA.startWork({
        sessionId: 'AUT-903',
        task: 'Persist check',
        filesPlanned: ['src/persist.ts'],
      });
      managerA.initiateHandoff();

      const ledgerB = new WorkLedger({ stateDir, machineId: 'machine-B' });
      const managerB = new HandoffManager({
        projectDir,
        stateDir,
        machineId: 'machine-B',
        workLedger: ledgerB,
      });

      const resumeResult = managerB.resume();
      managerB.acceptHandoff(resumeResult.resumableWork);

      // Read machine B's ledger file directly with fs
      const raw = fs.readFileSync(ledgerFilePath(stateDir, 'machine-B'), 'utf-8');
      const parsed = JSON.parse(raw) as MachineLedger;

      expect(parsed.machineId).toBe('machine-B');
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0].status).toBe('active');
      expect(parsed.entries[0].task).toContain('Persist check');
      expect(parsed.entries[0].filesPlanned).toContain('src/persist.ts');
    });
  });

  // ── Full round-trip: handoff -> resume -> accept -> verify ────────

  describe('full round-trip integration', () => {
    it('complete handoff lifecycle: A works -> A hands off -> B resumes -> B accepts -> B works', () => {
      // Phase 1: Machine A does work
      const ledgerA = new WorkLedger({ stateDir, machineId: 'workstation' });
      const managerA = new HandoffManager({
        projectDir,
        stateDir,
        machineId: 'workstation',
        workLedger: ledgerA,
      });

      const entryA = ledgerA.startWork({
        sessionId: 'AUT-1000',
        task: 'Implement sync protocol',
        filesPlanned: ['src/sync.ts', 'src/protocol.ts'],
      });
      ledgerA.updateWork(entryA.id, { filesModified: ['src/sync.ts'] });

      // Phase 2: Machine A hands off (with dirty working tree)
      fs.writeFileSync(path.join(projectDir, 'wip.txt'), 'work in progress\n');
      const handoffResult = managerA.initiateHandoff({
        reason: 'sleep',
        resumeInstructions: 'Finish the protocol handler in src/protocol.ts',
      });

      expect(handoffResult.success).toBe(true);
      expect(handoffResult.entriesPaused).toBe(1);
      expect(handoffResult.wipCommits).toBe(1);

      // Phase 3: Machine B resumes
      const ledgerB = new WorkLedger({ stateDir, machineId: 'laptop' });
      const managerB = new HandoffManager({
        projectDir,
        stateDir,
        machineId: 'laptop',
        workLedger: ledgerB,
      });

      const resumeResult = managerB.resume();
      expect(resumeResult.success).toBe(true);
      expect(resumeResult.recoveryType).toBe('graceful');
      expect(resumeResult.note!.from).toBe('workstation');
      expect(resumeResult.resumableWork).toHaveLength(1);

      // Phase 4: Machine B accepts the handoff
      const newEntries = managerB.acceptHandoff(resumeResult.resumableWork);
      expect(newEntries).toHaveLength(1);
      expect(newEntries[0].machineId).toBe('laptop');
      expect(newEntries[0].task).toContain('Implement sync protocol');

      // Phase 5: Machine B continues work
      ledgerB.updateWork(newEntries[0].id, {
        filesModified: ['src/protocol.ts'],
      });

      // Phase 6: Verify final state
      // Machine A's entries are paused
      const aEntries = ledgerA.readOwnLedger().entries;
      expect(aEntries.every(e => e.status === 'paused')).toBe(true);

      // Machine B has an active entry
      const bEntries = ledgerB.readOwnLedger().entries;
      expect(bEntries).toHaveLength(1);
      expect(bEntries[0].status).toBe('active');
      expect(bEntries[0].filesModified).toContain('src/protocol.ts');

      // Handoff note is cleared
      expect(fs.existsSync(handoffFilePath(stateDir))).toBe(false);

      // Git log contains the WIP commit
      const log = git(projectDir, 'log', '--oneline');
      expect(log).toContain('wip(workstation)');
    });
  });
});
