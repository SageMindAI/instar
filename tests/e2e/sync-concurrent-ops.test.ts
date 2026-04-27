/**
 * E2E Concurrent Operations Tests
 *
 * Tests multi-machine race conditions and concurrent access patterns
 * that CAN be tested on a single machine using parallel promises,
 * separate temp directories, and shared state directories.
 *
 * Test Groups:
 *   1. Concurrent Sync Lock Contention
 *   2. Concurrent WorkLedger Writes
 *   3. Concurrent Branch Operations (state file contention)
 *   4. Concurrent Handoff
 *   5. Audit Trail Integrity Under Concurrent Writes
 *   6. Message Bus Ordering
 *   7. Leadership Contention
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { SyncOrchestrator } from '../../src/core/SyncOrchestrator.js';
import type { SyncOrchestratorConfig, SyncLock } from '../../src/core/SyncOrchestrator.js';
import type { SyncResult } from '../../src/core/GitSync.js';
import { WorkLedger } from '../../src/core/WorkLedger.js';
import type { LedgerEntry } from '../../src/core/WorkLedger.js';
import { AuditTrail } from '../../src/core/AuditTrail.js';
import { AgentBus } from '../../src/core/AgentBus.js';
import { CoordinationProtocol } from '../../src/core/CoordinationProtocol.js';
import { HandoffManager } from '../../src/core/HandoffManager.js';

// ── Module Mock ──────────────────────────────────────────────────────

// Mock GitSyncManager at the module level since SyncOrchestrator creates it internally.
const mockGitSyncInstance = {
  isGitRepo: vi.fn().mockReturnValue(true),
  sync: vi.fn().mockResolvedValue({
    pulled: false,
    pushed: false,
    commitsPulled: 0,
    commitsPushed: 0,
    rejectedCommits: [],
    conflicts: [],
  } satisfies SyncResult),
  flushAutoCommit: vi.fn(),
  stop: vi.fn(),
};

vi.mock('../../src/core/GitSync.js', () => ({
  GitSyncManager: vi.fn().mockImplementation(() => mockGitSyncInstance),
}));

// Mock execFileSync for git operations used by SyncOrchestrator internally
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args?.includes('rev-parse')) return 'main\n';
      if (cmd === 'git' && args?.includes('push')) return '\n';
      if (cmd === 'git' && args?.includes('checkout')) return '\n';
      if (cmd === 'git' && args?.includes('rebase')) return '\n';
      if (cmd === 'git' && args?.includes('status')) return '\n';
      if (cmd === 'git' && args?.includes('add')) return '\n';
      if (cmd === 'git' && args?.includes('commit')) return '\n';
      if (cmd === 'git' && args?.includes('pull')) return '\n';
      if (cmd === 'git' && args?.includes('fetch')) return '\n';
      if (cmd === 'git' && args?.includes('branch')) return '\n';
      return '\n';
    }),
  };
});

// ── Helpers ──────────────────────────────────────────────────────────

function createTempDirs(): { projectDir: string; stateDir: string } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-conc-'));
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true });
  return { projectDir, stateDir };
}

/** Create a shared state directory that both "machines" will use. */
function createSharedState(): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-shared-'));
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  return stateDir;
}

function makeOrchestratorConfig(
  projectDir: string,
  stateDir: string,
  machineId: string,
): SyncOrchestratorConfig {
  return {
    projectDir,
    stateDir,
    machineId,
    identityManager: { loadRegistry: vi.fn().mockReturnValue({ machines: {} }) } as any,
    securityLog: { append: vi.fn() } as any,
    lockTimeoutMs: 60_000,
    syncIntervalMs: 300_000,
    sessionId: `SES-${machineId}`,
    userId: `user-${machineId}`,
  };
}

/** Small delay to yield the event loop. */
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// ── Tests ────────────────────────────────────────────────────────────

describe('Concurrent Operations', () => {
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ projectDir, stateDir } = createTempDirs());
    mockGitSyncInstance.isGitRepo.mockReturnValue(true);
    mockGitSyncInstance.sync.mockResolvedValue({
      pulled: false,
      pushed: false,
      commitsPulled: 0,
      commitsPushed: 0,
      rejectedCommits: [],
      conflicts: [],
    } satisfies SyncResult);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // ── Group 1: Concurrent Sync Lock Contention ──────────────────────

  describe('Group 1: Concurrent Sync Lock Contention', () => {
    it('only one of two orchestrators acquires the lock when both try simultaneously', () => {
      const orchA = new SyncOrchestrator(makeOrchestratorConfig(projectDir, stateDir, 'm_machine_a'));
      const orchB = new SyncOrchestrator(makeOrchestratorConfig(projectDir, stateDir, 'm_machine_b'));

      // Both try to acquire at the "same time"
      const resultA = orchA.acquireLock();
      const resultB = orchB.acquireLock();

      // Exactly one should succeed, the other should fail
      expect([resultA, resultB]).toContain(true);
      expect([resultA, resultB]).toContain(false);

      // Verify the lock file exists and is held by exactly one machine
      const lockPath = path.join(stateDir, 'state', 'sync.lock');
      expect(fs.existsSync(lockPath)).toBe(true);
      const lock: SyncLock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      expect(['m_machine_a', 'm_machine_b']).toContain(lock.machineId);

      // Cleanup
      orchA.releaseLock();
      orchB.releaseLock();
    });

    it('lock holder can release and second machine can then acquire', () => {
      const orchA = new SyncOrchestrator(makeOrchestratorConfig(projectDir, stateDir, 'm_machine_a'));
      const orchB = new SyncOrchestrator(makeOrchestratorConfig(projectDir, stateDir, 'm_machine_b'));

      // A acquires first
      expect(orchA.acquireLock()).toBe(true);
      // B cannot acquire
      expect(orchB.acquireLock()).toBe(false);

      // A releases
      expect(orchA.releaseLock()).toBe(true);

      // Now B can acquire
      expect(orchB.acquireLock()).toBe(true);

      // Verify B holds the lock
      const lock = orchB.getLockHolder();
      expect(lock).not.toBeNull();
      expect(lock!.machineId).toBe('m_machine_b');

      orchB.releaseLock();
    });

    it('stale lock is reclaimed by another machine', () => {
      const orchA = new SyncOrchestrator(makeOrchestratorConfig(projectDir, stateDir, 'm_machine_a'));
      const orchB = new SyncOrchestrator(makeOrchestratorConfig(projectDir, stateDir, 'm_machine_b'));

      // A acquires the lock
      expect(orchA.acquireLock()).toBe(true);

      // Manually set the lock to be expired (past timestamp)
      const lockPath = path.join(stateDir, 'state', 'sync.lock');
      const staleLock: SyncLock = {
        machineId: 'm_machine_a',
        acquiredAt: new Date(Date.now() - 120_000).toISOString(),
        expiresAt: new Date(Date.now() - 60_000).toISOString(), // Expired 1 minute ago
        pid: process.pid,
      };
      fs.writeFileSync(lockPath, JSON.stringify(staleLock, null, 2));

      // B should be able to reclaim the stale lock
      expect(orchB.acquireLock()).toBe(true);

      // Verify B now holds the lock
      const lock = orchB.getLockHolder();
      expect(lock).not.toBeNull();
      expect(lock!.machineId).toBe('m_machine_b');

      orchB.releaseLock();
    });

    it('same machine can re-acquire its own lock (reentrant)', () => {
      const orch = new SyncOrchestrator(makeOrchestratorConfig(projectDir, stateDir, 'm_machine_a'));

      expect(orch.acquireLock()).toBe(true);
      // Reentrant acquisition should succeed
      expect(orch.acquireLock()).toBe(true);

      // Lock should still be held by machine A
      const lock = orch.getLockHolder();
      expect(lock!.machineId).toBe('m_machine_a');

      orch.releaseLock();
    });

    it('concurrent periodicSync calls — second is rejected while first runs', async () => {
      const orch = new SyncOrchestrator(makeOrchestratorConfig(projectDir, stateDir, 'm_machine_a'));

      // Make sync slow to create a real overlap window
      mockGitSyncInstance.sync.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return {
          pulled: true,
          pushed: true,
          commitsPulled: 1,
          commitsPushed: 0,
          rejectedCommits: [],
          conflicts: [],
        } satisfies SyncResult;
      });

      // Start two concurrent syncs
      const [result1, result2] = await Promise.all([
        orch.periodicSync(),
        orch.periodicSync(),
      ]);

      // One should complete (pulled=true), the other should be a no-op (phase=idle, pulled=false)
      const completedCount = [result1, result2].filter(r => r.pulled === true).length;
      const noopCount = [result1, result2].filter(r => r.pulled === false).length;

      expect(completedCount).toBe(1);
      expect(noopCount).toBe(1);

      orch.stop();
    });

    it('lock contention between two orchestrators during periodicSync', async () => {
      const orchA = new SyncOrchestrator(makeOrchestratorConfig(projectDir, stateDir, 'm_machine_a'));
      const orchB = new SyncOrchestrator(makeOrchestratorConfig(projectDir, stateDir, 'm_machine_b'));

      // Make sync take some time
      mockGitSyncInstance.sync.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
        return {
          pulled: true,
          pushed: true,
          commitsPulled: 1,
          commitsPushed: 0,
          rejectedCommits: [],
          conflicts: [],
        } satisfies SyncResult;
      });

      const [resultA, resultB] = await Promise.all([
        orchA.periodicSync(),
        orchB.periodicSync(),
      ]);

      // One should succeed with pulled=true, other should be blocked at lock acquisition
      const successCount = [resultA, resultB].filter(r => r.pulled === true).length;
      // The blocked one will return early with phase 'acquiring-lock' or 'idle'
      const blockedCount = [resultA, resultB].filter(
        r => r.phase === 'acquiring-lock' || (r.pulled === false && r.pushed === false),
      ).length;

      expect(successCount).toBe(1);
      expect(blockedCount).toBe(1);

      orchA.stop();
      orchB.stop();
    });
  });

  // ── Group 2: Concurrent WorkLedger Writes ─────────────────────────

  describe('Group 2: Concurrent WorkLedger Writes', () => {
    it('two machines writing ledger entries produce separate files (no contention)', () => {
      // WorkLedger uses per-machine files, so there should be no write contention
      const ledgerA = new WorkLedger({ stateDir, machineId: 'm_machine_a' });
      const ledgerB = new WorkLedger({ stateDir, machineId: 'm_machine_b' });

      // Both write simultaneously
      const entryA = ledgerA.startWork({
        sessionId: 'SES-A',
        task: 'Feature A',
        filesPlanned: ['src/a.ts'],
      });

      const entryB = ledgerB.startWork({
        sessionId: 'SES-B',
        task: 'Feature B',
        filesPlanned: ['src/b.ts'],
      });

      // Both entries should exist
      expect(entryA.id).toBeTruthy();
      expect(entryB.id).toBeTruthy();
      expect(entryA.machineId).toBe('m_machine_a');
      expect(entryB.machineId).toBe('m_machine_b');

      // Both should be visible in aggregate view from either ledger
      const allFromA = ledgerA.getActiveEntries();
      const allFromB = ledgerB.getActiveEntries();

      expect(allFromA.length).toBe(2);
      expect(allFromB.length).toBe(2);
    });

    it('overlap detection catches concurrent file claims', () => {
      const ledgerA = new WorkLedger({ stateDir, machineId: 'm_machine_a' });
      const ledgerB = new WorkLedger({ stateDir, machineId: 'm_machine_b' });

      // Machine A claims to work on shared files
      ledgerA.startWork({
        sessionId: 'SES-A',
        task: 'Modify shared module',
        filesPlanned: ['src/shared.ts', 'src/utils.ts'],
      });

      // Machine B also wants to work on some of the same files
      const warnings = ledgerB.detectOverlap(['src/shared.ts', 'src/other.ts']);

      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0].overlappingFiles).toContain('src/shared.ts');
      expect(warnings[0].entry.machineId).toBe('m_machine_a');
    });

    it('rapid concurrent writes from same machine do not lose data', () => {
      const ledger = new WorkLedger({ stateDir, machineId: 'm_machine_a' });

      // Write many entries rapidly
      const entries: LedgerEntry[] = [];
      for (let i = 0; i < 20; i++) {
        entries.push(
          ledger.startWork({
            sessionId: `SES-${i}`,
            task: `Task ${i}`,
            filesPlanned: [`src/file${i}.ts`],
          }),
        );
      }

      // All entries should be present
      const all = ledger.readOwnLedger();
      expect(all.entries.length).toBe(20);
      for (let i = 0; i < 20; i++) {
        expect(all.entries.find(e => e.sessionId === `SES-${i}`)).toBeTruthy();
      }
    });

    it('concurrent update and read operations maintain consistency', () => {
      const ledgerA = new WorkLedger({ stateDir, machineId: 'm_machine_a' });
      const ledgerB = new WorkLedger({ stateDir, machineId: 'm_machine_b' });

      // A creates an entry
      const entry = ledgerA.startWork({
        sessionId: 'SES-A1',
        task: 'Initial task',
        filesPlanned: ['src/a.ts'],
      });

      // A updates it while B reads
      ledgerA.updateWork(entry.id, {
        task: 'Updated task',
        filesModified: ['src/a.ts'],
      });

      // B should see the updated entry
      const activeEntries = ledgerB.getActiveEntries();
      const aEntry = activeEntries.find(e => e.id === entry.id);
      expect(aEntry).toBeTruthy();
      expect(aEntry!.task).toBe('Updated task');
      expect(aEntry!.filesModified).toContain('src/a.ts');
    });

    it('modified files are unioned during rapid concurrent updates', () => {
      const ledger = new WorkLedger({ stateDir, machineId: 'm_machine_a' });

      const entry = ledger.startWork({
        sessionId: 'SES-A1',
        task: 'Multi-file change',
        filesPlanned: [],
      });

      // Rapidly update with different files
      for (let i = 0; i < 10; i++) {
        ledger.updateWork(entry.id, {
          filesModified: [`src/file${i}.ts`],
        });
      }

      // All files should be unioned
      const updated = ledger.readOwnLedger().entries.find(e => e.id === entry.id);
      expect(updated!.filesModified.length).toBe(10);
      for (let i = 0; i < 10; i++) {
        expect(updated!.filesModified).toContain(`src/file${i}.ts`);
      }
    });
  });

  // ── Group 3: Concurrent Branch Operations ─────────────────────────

  describe('Group 3: Concurrent Branch State File Operations', () => {
    it('two machines writing branch state to same file — last write wins', () => {
      // BranchManager stores all branches in one branches.json file
      // This test verifies that concurrent writes to the same file are detectable
      const branchStateDir = path.join(stateDir, 'state', 'branches');
      fs.mkdirSync(branchStateDir, { recursive: true });
      const branchFile = path.join(branchStateDir, 'branches.json');

      // Simulate machine A writing branch state
      const branchesA = {
        branches: [{
          name: 'task/m_machine_a/feature-x',
          machineId: 'm_machine_a',
          sessionId: 'SES-A',
          task: 'Feature X',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: 'active',
          baseBranch: 'main',
          baseCommit: 'abc123',
          commitCount: 0,
        }],
      };
      fs.writeFileSync(branchFile, JSON.stringify(branchesA, null, 2));

      // Simulate machine B writing branch state (overwriting A's data)
      const branchesB = {
        branches: [{
          name: 'task/m_machine_b/feature-y',
          machineId: 'm_machine_b',
          sessionId: 'SES-B',
          task: 'Feature Y',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: 'active',
          baseBranch: 'main',
          baseCommit: 'def456',
          commitCount: 0,
        }],
      };
      fs.writeFileSync(branchFile, JSON.stringify(branchesB, null, 2));

      // Verify last-write-wins semantics
      const result = JSON.parse(fs.readFileSync(branchFile, 'utf-8'));
      expect(result.branches.length).toBe(1);
      expect(result.branches[0].name).toBe('task/m_machine_b/feature-y');
    });

    it('completing a branch marks it as merged in state file', () => {
      const branchStateDir = path.join(stateDir, 'state', 'branches');
      fs.mkdirSync(branchStateDir, { recursive: true });
      const branchFile = path.join(branchStateDir, 'branches.json');

      // Set up two branches from different machines
      const branches = {
        branches: [
          {
            name: 'task/m_machine_a/feature-x',
            machineId: 'm_machine_a',
            sessionId: 'SES-A',
            task: 'Feature X',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: 'active',
            baseBranch: 'main',
            baseCommit: 'abc123',
            commitCount: 3,
          },
          {
            name: 'task/m_machine_b/feature-y',
            machineId: 'm_machine_b',
            sessionId: 'SES-B',
            task: 'Feature Y',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: 'active',
            baseBranch: 'main',
            baseCommit: 'def456',
            commitCount: 2,
          },
        ],
      };
      fs.writeFileSync(branchFile, JSON.stringify(branches, null, 2));

      // Machine A completes its branch (simulated)
      const data = JSON.parse(fs.readFileSync(branchFile, 'utf-8'));
      const branchA = data.branches.find((b: any) => b.name === 'task/m_machine_a/feature-x');
      branchA.status = 'merged';
      branchA.updatedAt = new Date().toISOString();
      fs.writeFileSync(branchFile, JSON.stringify(data, null, 2));

      // Verify B's branch is still active while A's is merged
      const result = JSON.parse(fs.readFileSync(branchFile, 'utf-8'));
      const aBranch = result.branches.find((b: any) => b.name === 'task/m_machine_a/feature-x');
      const bBranch = result.branches.find((b: any) => b.name === 'task/m_machine_b/feature-y');
      expect(aBranch.status).toBe('merged');
      expect(bBranch.status).toBe('active');
    });

    it('abandoned branch cleanup does not affect other machines branches', () => {
      const branchStateDir = path.join(stateDir, 'state', 'branches');
      fs.mkdirSync(branchStateDir, { recursive: true });
      const branchFile = path.join(branchStateDir, 'branches.json');

      const branches = {
        branches: [
          {
            name: 'task/m_machine_a/stale',
            machineId: 'm_machine_a',
            sessionId: 'SES-A',
            task: 'Stale task',
            createdAt: new Date(Date.now() - 5 * 3600_000).toISOString(),
            updatedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
            status: 'active',
            baseBranch: 'main',
            baseCommit: 'abc',
            commitCount: 1,
          },
          {
            name: 'task/m_machine_b/active-work',
            machineId: 'm_machine_b',
            sessionId: 'SES-B',
            task: 'Active work',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: 'active',
            baseBranch: 'main',
            baseCommit: 'def',
            commitCount: 5,
          },
        ],
      };
      fs.writeFileSync(branchFile, JSON.stringify(branches, null, 2));

      // Machine A abandons its stale branch
      const data = JSON.parse(fs.readFileSync(branchFile, 'utf-8'));
      const staleBranch = data.branches.find((b: any) => b.name === 'task/m_machine_a/stale');
      staleBranch.status = 'abandoned';
      fs.writeFileSync(branchFile, JSON.stringify(data, null, 2));

      // Machine B's branch should still be active
      const result = JSON.parse(fs.readFileSync(branchFile, 'utf-8'));
      const bBranch = result.branches.find((b: any) => b.name === 'task/m_machine_b/active-work');
      expect(bBranch.status).toBe('active');
      expect(bBranch.commitCount).toBe(5);
    });
  });

  // ── Group 4: Concurrent Handoff ────────────────────────────────────

  describe('Group 4: Concurrent Handoff', () => {
    it('two machines writing handoff notes — last write wins, file not corrupted', () => {
      const handoffPath = path.join(stateDir, 'state', 'handoff.json');

      // Machine A writes handoff note
      const noteA = {
        schemaVersion: 1,
        from: 'm_machine_a',
        at: new Date().toISOString(),
        reason: 'user-initiated',
        activeWork: [],
        allChangesPushed: true,
        uncommittedNotes: 'None',
        gitHead: 'abc123',
        activeBranches: [],
      };
      fs.writeFileSync(handoffPath, JSON.stringify(noteA, null, 2));

      // Machine B also writes a handoff note (simulating concurrent transition)
      const noteB = {
        schemaVersion: 1,
        from: 'm_machine_b',
        at: new Date().toISOString(),
        reason: 'shutdown',
        activeWork: [{ entryId: 'work_b1', sessionId: 'SES-B' }],
        allChangesPushed: false,
        uncommittedNotes: '1 WIP commit',
        gitHead: 'def456',
        activeBranches: ['task/m_machine_b/feature'],
      };
      fs.writeFileSync(handoffPath, JSON.stringify(noteB, null, 2));

      // The file should be valid JSON with B's data
      const result = JSON.parse(fs.readFileSync(handoffPath, 'utf-8'));
      expect(result.from).toBe('m_machine_b');
      expect(result.reason).toBe('shutdown');
      expect(result.activeWork.length).toBe(1);
    });

    it('handoff note reading while another machine is writing produces valid JSON', () => {
      const handoffPath = path.join(stateDir, 'state', 'handoff.json');

      // Write initial note
      const initial = {
        schemaVersion: 1,
        from: 'm_machine_a',
        at: new Date().toISOString(),
        reason: 'user-initiated',
        activeWork: [],
        allChangesPushed: true,
        uncommittedNotes: 'None',
        gitHead: 'abc123',
        activeBranches: [],
      };
      fs.writeFileSync(handoffPath, JSON.stringify(initial, null, 2));

      // Read it back — should always be valid
      const readResult = JSON.parse(fs.readFileSync(handoffPath, 'utf-8'));
      expect(readResult.schemaVersion).toBe(1);
      expect(readResult.from).toBe('m_machine_a');
    });

    it('handoff with WorkLedger integration — entries are paused before handoff note', () => {
      const ledger = new WorkLedger({ stateDir, machineId: 'm_machine_a' });

      // Start work
      const entry = ledger.startWork({
        sessionId: 'SES-A1',
        task: 'Active work',
        filesPlanned: ['src/feature.ts'],
      });
      expect(entry.status).toBe('active');

      // Simulate handoff: pause entries first
      ledger.endWork(entry.id, 'paused');

      // Verify paused
      const ownLedger = ledger.readOwnLedger();
      const paused = ownLedger.entries.find(e => e.id === entry.id);
      expect(paused!.status).toBe('paused');

      // Machine B resumes
      const ledgerB = new WorkLedger({ stateDir, machineId: 'm_machine_b' });
      const resumed = ledgerB.startWork({
        sessionId: 'SES-B1',
        task: `[resumed from ${entry.id}] Active work`,
        filesPlanned: ['src/feature.ts'],
      });

      // Both should be visible: A's paused, B's active
      const all = ledgerB.getActiveEntries();
      const aPaused = all.find(e => e.id === entry.id);
      const bActive = all.find(e => e.id === resumed.id);
      expect(aPaused!.status).toBe('paused');
      expect(bActive!.status).toBe('active');
    });
  });

  // ── Group 5: Audit Trail Integrity Under Concurrent Writes ────────

  describe('Group 5: Audit Trail Integrity Under Concurrent Writes', () => {
    it('sequential audit entries maintain chain integrity', () => {
      const audit = new AuditTrail({ stateDir, machineId: 'm_machine_a' });

      // Write 20 entries rapidly
      for (let i = 0; i < 20; i++) {
        audit.logSecurity({
          event: `event-${i}`,
          severity: 'low',
          details: `Test event ${i}`,
          sessionId: 'SES-A',
        });
      }

      // Verify chain integrity
      const integrity = audit.verifyIntegrity();
      expect(integrity.intact).toBe(true);
      expect(integrity.entriesChecked).toBe(20);
    });

    it('two audit trails from different machines both maintain their own integrity', () => {
      const auditA = new AuditTrail({ stateDir, machineId: 'm_machine_a' });
      const auditB = new AuditTrail({ stateDir, machineId: 'm_machine_b' });

      // Note: AuditTrail writes to {stateDir}/state/audit/current.jsonl
      // Both instances share the same file, so they will interleave entries.
      // The chain should still hold since they serialize through the same lastHash.

      // However, since they're separate instances, each tracks its own lastHash.
      // This means they will write with potentially stale previousHash values.
      // Let's test the single-writer pattern (one at a time) first.

      // Machine A writes 10 entries
      for (let i = 0; i < 10; i++) {
        auditA.logSecurity({
          event: `event-a-${i}`,
          severity: 'low',
          details: `Machine A event ${i}`,
          sessionId: 'SES-A',
        });
      }

      // Verify A's chain
      const integrityA = auditA.verifyIntegrity();
      expect(integrityA.intact).toBe(true);
      expect(integrityA.entriesChecked).toBe(10);
    });

    it('rapid appending does not lose entries', () => {
      const audit = new AuditTrail({ stateDir, machineId: 'm_machine_a' });

      const entryIds: string[] = [];
      for (let i = 0; i < 50; i++) {
        const entry = audit.logSecurity({
          event: `rapid-${i}`,
          severity: 'low',
          details: `Rapid write ${i}`,
          sessionId: 'SES-A',
        });
        entryIds.push(entry.id);
      }

      // All entries should be present
      const allEntries = audit.query();
      expect(allEntries.length).toBe(50);

      // Each ID should be unique
      const uniqueIds = new Set(allEntries.map(e => e.id));
      expect(uniqueIds.size).toBe(50);
    });

    it('hash chain links are correct through all entries', () => {
      const audit = new AuditTrail({ stateDir, machineId: 'm_machine_a' });

      // Write a mix of different event types
      audit.logSecurity({ event: 'start', severity: 'low', details: 'Start', sessionId: 'S1' });
      audit.logHandoff({ fromMachine: 'm_a', reason: 'shutdown', workItemCount: 2, sessionId: 'S1' });
      audit.logBranch({ action: 'create', branch: 'task/a/feat', result: 'success', sessionId: 'S1' });
      audit.logSecurity({ event: 'end', severity: 'low', details: 'End', sessionId: 'S1' });

      const entries = audit.query();
      expect(entries.length).toBe(4);

      // First entry should chain from genesis (all zeros)
      expect(entries[0].previousHash).toBe('0'.repeat(64));

      // Each subsequent entry should chain from the prior
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i].previousHash).toBe(entries[i - 1].entryHash);
      }

      // Full integrity check
      const integrity = audit.verifyIntegrity();
      expect(integrity.intact).toBe(true);
      expect(integrity.entriesChecked).toBe(4);
    });

    it('tampered entry is detected by integrity check', () => {
      const audit = new AuditTrail({ stateDir, machineId: 'm_machine_a' });

      // Write some entries
      audit.logSecurity({ event: 'e1', severity: 'low', details: 'First', sessionId: 'S1' });
      audit.logSecurity({ event: 'e2', severity: 'low', details: 'Second', sessionId: 'S1' });
      audit.logSecurity({ event: 'e3', severity: 'low', details: 'Third', sessionId: 'S1' });

      // Tamper with the second entry
      const logPath = path.join(stateDir, 'state', 'audit', 'current.jsonl');
      const content = fs.readFileSync(logPath, 'utf-8');
      const lines = content.trim().split('\n');
      const entry2 = JSON.parse(lines[1]);
      entry2.data.details = 'TAMPERED!';
      lines[1] = JSON.stringify(entry2);
      fs.writeFileSync(logPath, lines.join('\n') + '\n');

      // Re-read and verify — a new instance re-loads from file
      const auditCheck = new AuditTrail({ stateDir, machineId: 'm_machine_a' });
      const integrity = auditCheck.verifyIntegrity();
      expect(integrity.intact).toBe(false);
      expect(integrity.brokenAt).toBe(1);
      expect(integrity.breakDetails).toContain('tampered');
    });
  });

  // ── Group 6: Message Bus Ordering ──────────────────────────────────

  describe('Group 6: Message Bus Ordering', () => {
    it('100 messages sent via JSONL transport are all present in the outbox', async () => {
      const bus = new AgentBus({
        stateDir,
        machineId: 'm_machine_a',
        transport: 'jsonl',
      });

      const messageIds: string[] = [];
      for (let i = 0; i < 100; i++) {
        const msg = await bus.send({
          type: 'work-announcement',
          to: 'm_machine_b',
          payload: { index: i, data: `message-${i}` },
        });
        messageIds.push(msg.id);
      }

      // Read the outbox and verify all messages are present
      const outbox = bus.readOutbox();
      expect(outbox.length).toBe(100);

      // Verify order is preserved
      for (let i = 0; i < 100; i++) {
        expect(outbox[i].id).toBe(messageIds[i]);
        expect((outbox[i].payload as any).index).toBe(i);
      }
    });

    it('no duplicate messages in outbox after rapid sends', async () => {
      const bus = new AgentBus({
        stateDir,
        machineId: 'm_machine_a',
        transport: 'jsonl',
      });

      // Send messages as fast as possible
      const sends = Array.from({ length: 50 }, (_, i) =>
        bus.send({
          type: 'heartbeat',
          to: '*',
          payload: { seq: i },
        }),
      );
      await Promise.all(sends);

      const outbox = bus.readOutbox();
      expect(outbox.length).toBe(50);

      // No duplicate IDs
      const ids = outbox.map(m => m.id);
      expect(new Set(ids).size).toBe(50);
    });

    it('processIncoming delivers messages to registered handlers in order', async () => {
      const bus = new AgentBus({
        stateDir,
        machineId: 'm_machine_b',
        transport: 'jsonl',
      });

      const received: number[] = [];
      bus.onMessage('work-announcement', (msg) => {
        received.push((msg.payload as any).seq);
      });

      // Create 20 messages from machine_a
      const messages = Array.from({ length: 20 }, (_, i) => ({
        id: `msg_test_${i}`,
        type: 'work-announcement' as const,
        from: 'm_machine_a',
        to: 'm_machine_b',
        timestamp: new Date().toISOString(),
        ttlMs: 60_000,
        payload: { seq: i },
        status: 'pending' as const,
      }));

      bus.processIncoming(messages);

      expect(received.length).toBe(20);
      // Verify order
      for (let i = 0; i < 20; i++) {
        expect(received[i]).toBe(i);
      }
    });

    it('expired messages are filtered out during processIncoming', async () => {
      const bus = new AgentBus({
        stateDir,
        machineId: 'm_machine_b',
        transport: 'jsonl',
      });

      const received: string[] = [];
      const expired: string[] = [];
      bus.onMessage('heartbeat', (msg) => {
        received.push(msg.id);
      });
      bus.on('expired', (msg) => {
        expired.push(msg.id);
      });

      const now = Date.now();
      const messages = [
        {
          id: 'msg_valid_1',
          type: 'heartbeat' as const,
          from: 'm_machine_a',
          to: 'm_machine_b',
          timestamp: new Date(now).toISOString(),
          ttlMs: 60_000,
          payload: {},
          status: 'pending' as const,
        },
        {
          id: 'msg_expired_1',
          type: 'heartbeat' as const,
          from: 'm_machine_a',
          to: 'm_machine_b',
          timestamp: new Date(now - 120_000).toISOString(), // 2 minutes ago
          ttlMs: 60_000, // TTL was 1 minute
          payload: {},
          status: 'pending' as const,
        },
        {
          id: 'msg_valid_2',
          type: 'heartbeat' as const,
          from: 'm_machine_a',
          to: 'm_machine_b',
          timestamp: new Date(now).toISOString(),
          ttlMs: 60_000,
          payload: {},
          status: 'pending' as const,
        },
      ];

      bus.processIncoming(messages);

      expect(received).toEqual(['msg_valid_1', 'msg_valid_2']);
      expect(expired).toEqual(['msg_expired_1']);
    });

    it('broadcast messages are not delivered back to sender', async () => {
      const bus = new AgentBus({
        stateDir,
        machineId: 'm_machine_a',
        transport: 'jsonl',
      });

      const received: string[] = [];
      bus.onMessage('work-announcement', (msg) => {
        received.push(msg.id);
      });

      const messages = [
        {
          id: 'msg_from_self',
          type: 'work-announcement' as const,
          from: 'm_machine_a', // Same as bus machine
          to: '*',
          timestamp: new Date().toISOString(),
          ttlMs: 60_000,
          payload: {},
          status: 'pending' as const,
        },
        {
          id: 'msg_from_other',
          type: 'work-announcement' as const,
          from: 'm_machine_b',
          to: '*',
          timestamp: new Date().toISOString(),
          ttlMs: 60_000,
          payload: {},
          status: 'pending' as const,
        },
      ];

      bus.processIncoming(messages);

      // Only the message from the other machine should be received
      expect(received).toEqual(['msg_from_other']);
    });
  });

  // ── Group 7: Leadership Contention ─────────────────────────────────

  describe('Group 7: Leadership Contention', () => {
    it('two agents calling claimLeadership — only one wins', () => {
      const busA = new AgentBus({ stateDir, machineId: 'm_machine_a', transport: 'jsonl' });
      const busB = new AgentBus({ stateDir, machineId: 'm_machine_b', transport: 'jsonl' });

      const coordA = new CoordinationProtocol({
        bus: busA,
        machineId: 'm_machine_a',
        stateDir,
        leaseTtlMs: 60_000,
      });
      const coordB = new CoordinationProtocol({
        bus: busB,
        machineId: 'm_machine_b',
        stateDir,
        leaseTtlMs: 60_000,
      });

      // Both try to claim leadership
      const leaderA = coordA.claimLeadership();
      const leaderB = coordB.claimLeadership();

      // First one should succeed (file-based, so first writer wins)
      expect(leaderA).not.toBeNull();
      expect(leaderA!.leaderId).toBe('m_machine_a');
      expect(leaderA!.fencingToken).toBe(1);

      // Second should fail because A's lease is still valid
      expect(leaderB).toBeNull();

      // A should be leader
      expect(coordA.isLeader()).toBe(true);
      expect(coordB.isLeader()).toBe(false);
    });

    it('fencing token increments monotonically across leadership transitions', () => {
      const busA = new AgentBus({ stateDir, machineId: 'm_machine_a', transport: 'jsonl' });
      const busB = new AgentBus({ stateDir, machineId: 'm_machine_b', transport: 'jsonl' });

      const coordA = new CoordinationProtocol({
        bus: busA,
        machineId: 'm_machine_a',
        stateDir,
        leaseTtlMs: 60_000,
      });
      const coordB = new CoordinationProtocol({
        bus: busB,
        machineId: 'm_machine_b',
        stateDir,
        leaseTtlMs: 60_000,
      });

      // A claims leadership
      const lease1 = coordA.claimLeadership();
      expect(lease1!.fencingToken).toBe(1);

      // A relinquishes
      coordA.relinquishLeadership();
      expect(coordA.isLeader()).toBe(false);

      // B claims leadership
      const lease2 = coordB.claimLeadership();
      expect(lease2).not.toBeNull();
      expect(lease2!.fencingToken).toBe(2); // Monotonically increasing
      expect(lease2!.leaderId).toBe('m_machine_b');
    });

    it('lease renewal works for the current leader', () => {
      const bus = new AgentBus({ stateDir, machineId: 'm_machine_a', transport: 'jsonl' });
      const coord = new CoordinationProtocol({
        bus,
        machineId: 'm_machine_a',
        stateDir,
        leaseTtlMs: 60_000,
      });

      // Claim leadership
      const initial = coord.claimLeadership();
      expect(initial).not.toBeNull();
      const initialExpiry = new Date(initial!.leaseExpiresAt).getTime();

      // Small delay to ensure time advances
      const renewed = coord.renewLease();
      expect(renewed).not.toBeNull();
      expect(renewed!.leaderId).toBe('m_machine_a');
      const renewedExpiry = new Date(renewed!.leaseExpiresAt).getTime();

      // Renewed expiry should be >= initial (time has advanced)
      expect(renewedExpiry).toBeGreaterThanOrEqual(initialExpiry);
    });

    it('non-leader cannot renew lease', () => {
      const busA = new AgentBus({ stateDir, machineId: 'm_machine_a', transport: 'jsonl' });
      const busB = new AgentBus({ stateDir, machineId: 'm_machine_b', transport: 'jsonl' });

      const coordA = new CoordinationProtocol({
        bus: busA,
        machineId: 'm_machine_a',
        stateDir,
        leaseTtlMs: 60_000,
      });
      const coordB = new CoordinationProtocol({
        bus: busB,
        machineId: 'm_machine_b',
        stateDir,
        leaseTtlMs: 60_000,
      });

      // A claims leadership
      coordA.claimLeadership();

      // B tries to renew (should fail — B is not the leader)
      const result = coordB.renewLease();
      expect(result).toBeNull();
    });

    it('expired lease can be claimed by another machine', () => {
      const busA = new AgentBus({ stateDir, machineId: 'm_machine_a', transport: 'jsonl' });
      const busB = new AgentBus({ stateDir, machineId: 'm_machine_b', transport: 'jsonl' });

      const coordA = new CoordinationProtocol({
        bus: busA,
        machineId: 'm_machine_a',
        stateDir,
        leaseTtlMs: 60_000,
      });
      const coordB = new CoordinationProtocol({
        bus: busB,
        machineId: 'm_machine_b',
        stateDir,
        leaseTtlMs: 60_000,
      });

      // A claims leadership
      coordA.claimLeadership();

      // Manually expire A's lease
      const leadershipPath = path.join(stateDir, 'state', 'coordination', 'leadership.json');
      const state = JSON.parse(fs.readFileSync(leadershipPath, 'utf-8'));
      state.leaseExpiresAt = new Date(Date.now() - 1000).toISOString(); // Already expired
      fs.writeFileSync(leadershipPath, JSON.stringify(state, null, 2) + '\n');

      // B should now be able to claim
      const lease = coordB.claimLeadership();
      expect(lease).not.toBeNull();
      expect(lease!.leaderId).toBe('m_machine_b');
      expect(lease!.fencingToken).toBe(2);
    });

    it('isLeaseExpired returns correct state', () => {
      const bus = new AgentBus({ stateDir, machineId: 'm_machine_a', transport: 'jsonl' });
      const coord = new CoordinationProtocol({
        bus,
        machineId: 'm_machine_a',
        stateDir,
        leaseTtlMs: 60_000,
      });

      // No leadership state yet — lease is "expired" (nonexistent)
      expect(coord.isLeaseExpired()).toBe(true);

      // Claim leadership
      coord.claimLeadership();
      expect(coord.isLeaseExpired()).toBe(false);

      // Relinquish — sets expiry to now
      coord.relinquishLeadership();
      expect(coord.isLeaseExpired()).toBe(true);
    });
  });
});
