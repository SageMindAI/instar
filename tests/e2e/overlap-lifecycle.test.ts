/**
 * E2E Lifecycle Tests for OverlapGuard
 *
 * Per TESTING-INTEGRITY-SPEC Category 3: "The full path from user action
 * to user-visible outcome works end-to-end, with controlled (but real)
 * intermediate components."
 *
 * Tests the complete lifecycle paths of the OverlapGuard: no-conflict
 * collaboration, planned overlap with branch suggestion, active overlap
 * with alert callbacks, architectural conflict blocking, multi-user
 * notification routing, and custom notification policy. Each test
 * exercises a full user-facing path through real WorkLedger instances
 * backed by temp directories on disk.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkLedger } from '../../src/core/WorkLedger.js';
import { OverlapGuard } from '../../src/core/OverlapGuard.js';
import type { OverlapCheckResult } from '../../src/core/OverlapGuard.js';

// ── Helpers ──────────────────────────────────────────────────────────

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'overlap-guard-e2e-'));
}

/**
 * Create a WorkLedger for a given machine sharing the same stateDir
 * (simulating a synced .instar directory on a shared filesystem).
 */
function createLedger(
  stateDir: string,
  machineId: string,
  userId?: string,
): WorkLedger {
  return new WorkLedger({
    stateDir,
    machineId,
    userId,
  });
}

/**
 * Create an OverlapGuard wrapping a WorkLedger.
 */
function createGuard(
  ledger: WorkLedger,
  machineId: string,
  opts?: {
    userId?: string;
    notification?: Partial<{
      sameUser: 'log' | 'alert' | 'block';
      differentUsers: 'log' | 'alert' | 'block';
      architecturalConflict: 'log' | 'alert' | 'block';
    }>;
    onAlert?: (result: OverlapCheckResult) => void;
    onBlock?: (result: OverlapCheckResult) => void;
  },
): OverlapGuard {
  return new OverlapGuard({
    workLedger: ledger,
    machineId,
    userId: opts?.userId,
    notification: opts?.notification,
    onAlert: opts?.onAlert,
    onBlock: opts?.onBlock,
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('OverlapGuard E2E lifecycle', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = createTempStateDir();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  // ── Scenario 1: No-conflict collaboration lifecycle ────────────────

  describe('no-conflict collaboration lifecycle', () => {
    it('two machines working on disjoint files both get Tier 0 and canProceed true', () => {
      // Setup: two machines with their own ledgers and guards
      const ledgerA = createLedger(stateDir, 'machine-a');
      const ledgerB = createLedger(stateDir, 'machine-b');
      const guardA = createGuard(ledgerA, 'machine-a');
      const guardB = createGuard(ledgerB, 'machine-b');

      // Step 1: Machine A starts work on auth files
      ledgerA.startWork({
        sessionId: 'AUT-100',
        task: 'Build authentication module',
        filesPlanned: ['src/auth/login.ts', 'src/auth/session.ts'],
      });

      // Step 2: Machine B starts work on UI files (completely disjoint)
      ledgerB.startWork({
        sessionId: 'AUT-101',
        task: 'Build dashboard UI',
        filesPlanned: ['src/ui/Dashboard.tsx', 'src/ui/Sidebar.tsx'],
      });

      // Step 3: Machine A checks via OverlapGuard — no conflict
      const resultA = guardA.check({
        plannedFiles: ['src/auth/login.ts', 'src/auth/session.ts'],
        task: 'Build authentication module',
      });

      expect(resultA.maxTier).toBe(0);
      expect(resultA.canProceed).toBe(true);
      expect(resultA.action).toBe('log');
      expect(resultA.warnings).toHaveLength(0);
      expect(resultA.architecturalConflicts).toHaveLength(0);
      expect(resultA.suggestion).toContain('No overlap');

      // Step 4: Machine B checks via OverlapGuard — also no conflict
      const resultB = guardB.check({
        plannedFiles: ['src/ui/Dashboard.tsx', 'src/ui/Sidebar.tsx'],
        task: 'Build dashboard UI',
      });

      expect(resultB.maxTier).toBe(0);
      expect(resultB.canProceed).toBe(true);
      expect(resultB.action).toBe('log');
      expect(resultB.warnings).toHaveLength(0);
      expect(resultB.architecturalConflicts).toHaveLength(0);

      // Step 5: Both complete their work — lifecycle ends cleanly
      const entriesA = ledgerA.getActiveEntries();
      const ownA = entriesA.find(e => e.machineId === 'machine-a');
      expect(ownA).toBeDefined();
      ledgerA.endWork(ownA!.id, 'completed');

      const entriesB = ledgerB.getActiveEntries();
      const ownB = entriesB.find(e => e.machineId === 'machine-b');
      expect(ownB).toBeDefined();
      ledgerB.endWork(ownB!.id, 'completed');

      // Final verification: no active entries remain
      expect(ledgerA.getActiveEntries()).toHaveLength(0);
      expect(ledgerB.getActiveEntries()).toHaveLength(0);
    });
  });

  // ── Scenario 2: Planned overlap → branch suggestion lifecycle ──────

  describe('planned overlap → branch suggestion lifecycle', () => {
    it('detects Tier 1 with branch suggestion, clears to Tier 0 after completion', () => {
      const ledgerA = createLedger(stateDir, 'machine-a');
      const ledgerB = createLedger(stateDir, 'machine-b');
      const guardB = createGuard(ledgerB, 'machine-b');

      // Step 1: Machine A plans work on shared utility files
      const entryA = ledgerA.startWork({
        sessionId: 'AUT-200',
        task: 'Refactor shared utilities',
        filesPlanned: ['src/utils.ts', 'src/config.ts'],
      });

      // Step 2: Machine B checks — planning to touch same files
      const resultB1 = guardB.check({
        plannedFiles: ['src/utils.ts', 'src/config.ts'],
        task: 'Update configuration defaults',
      });

      // Should be Tier 1 (planned overlap) with branch suggestion
      expect(resultB1.maxTier).toBe(1);
      expect(resultB1.canProceed).toBe(true);
      expect(resultB1.action).not.toBe('block');
      expect(resultB1.warnings.length).toBeGreaterThan(0);
      expect(resultB1.warnings[0].tier).toBe(1);
      expect(resultB1.suggestion).toContain('branch');

      // Step 3: Machine B proceeds on a task branch (simulated by recording branch in ledger)
      ledgerB.startWork({
        sessionId: 'AUT-201',
        task: 'Update configuration defaults',
        filesPlanned: ['src/utils.ts', 'src/config.ts'],
        branch: 'task/config-defaults',
      });

      // Step 4: Machine A completes its work
      ledgerA.endWork(entryA.id, 'completed');

      // Step 5: Machine B re-checks — should now be Tier 0 (A is completed)
      const resultB2 = guardB.check({
        plannedFiles: ['src/utils.ts', 'src/config.ts'],
        task: 'Update configuration defaults',
      });

      expect(resultB2.maxTier).toBe(0);
      expect(resultB2.canProceed).toBe(true);
      expect(resultB2.action).toBe('log');
      expect(resultB2.warnings).toHaveLength(0);
      expect(resultB2.suggestion).toContain('No overlap');
    });
  });

  // ── Scenario 3: Active overlap → alert lifecycle ───────────────────

  describe('active overlap → alert lifecycle', () => {
    it('fires onAlert callback on Tier 2, clears after opposing work completes', () => {
      // Different userIds ensure the overlap routes to 'differentUsers' → 'alert'
      const ledgerA = createLedger(stateDir, 'machine-a', 'user-alice');
      const ledgerB = createLedger(stateDir, 'machine-b', 'user-bob');

      // Track alert callback invocations
      const alertCalls: OverlapCheckResult[] = [];
      const onAlert = vi.fn((result: OverlapCheckResult) => {
        alertCalls.push(result);
      });

      const guardB = createGuard(ledgerB, 'machine-b', {
        userId: 'user-bob',
        onAlert,
      });

      // Step 1: Machine A starts work and actively modifies src/api.ts
      const entryA = ledgerA.startWork({
        sessionId: 'AUT-300',
        task: 'Rewrite API handlers',
        filesPlanned: ['src/api.ts', 'src/routes.ts'],
      });
      ledgerA.updateWork(entryA.id, {
        filesModified: ['src/api.ts'],
      });

      // Step 2: Machine B plans to modify the same file
      const resultB = guardB.check({
        plannedFiles: ['src/api.ts'],
        task: 'Add rate limiting to API',
      });

      // Should be Tier 2 (active overlap) with alert action
      expect(resultB.maxTier).toBe(2);
      expect(resultB.canProceed).toBe(true); // alert doesn't block
      expect(resultB.action).toBe('alert');
      expect(resultB.warnings.length).toBeGreaterThan(0);
      expect(resultB.warnings[0].tier).toBe(2);
      expect(resultB.warnings[0].overlappingFiles).toContain('src/api.ts');
      expect(resultB.suggestion).toContain('branch');

      // Step 3: Verify the onAlert callback fired
      expect(onAlert).toHaveBeenCalledTimes(1);
      expect(alertCalls[0].maxTier).toBe(2);
      expect(alertCalls[0].warnings[0].overlappingFiles).toContain('src/api.ts');

      // Step 4: Machine A completes its work
      ledgerA.endWork(entryA.id, 'completed');

      // Step 5: Machine B re-checks — Tier 0 now
      const resultB2 = guardB.check({
        plannedFiles: ['src/api.ts'],
        task: 'Add rate limiting to API',
      });

      expect(resultB2.maxTier).toBe(0);
      expect(resultB2.canProceed).toBe(true);
      expect(resultB2.action).toBe('log');

      // onAlert should NOT have been called again (only 1 call total)
      expect(onAlert).toHaveBeenCalledTimes(1);
    });
  });

  // ── Scenario 4: Architectural conflict → block lifecycle ───────────

  describe('architectural conflict → block lifecycle', () => {
    it('detects opposing architectural assumptions with Tier 3 block and fires onBlock', () => {
      const ledgerA = createLedger(stateDir, 'machine-a');
      const ledgerB = createLedger(stateDir, 'machine-b');

      // Track block callback invocations
      const blockCalls: OverlapCheckResult[] = [];
      const onBlock = vi.fn((result: OverlapCheckResult) => {
        blockCalls.push(result);
      });

      const guardB = createGuard(ledgerB, 'machine-b', { onBlock });

      // Step 1: Machine A starts working on "switching auth from sessions to JWT"
      const entryA = ledgerA.startWork({
        sessionId: 'AUT-400',
        task: 'Switching auth from sessions to JWT',
        filesPlanned: ['src/auth/handler.ts', 'src/auth/middleware.ts'],
      });

      // Step 2: Machine B starts "adding session-based rate limiting" — architectural conflict
      // Both touch auth directory AND have opposing signals (session vs jwt)
      const resultB = guardB.check({
        plannedFiles: ['src/auth/limiter.ts', 'src/auth/middleware.ts'],
        task: 'Adding session-based rate limiting',
      });

      // Should be Tier 3 (architectural conflict) with block action
      expect(resultB.maxTier).toBe(3);
      expect(resultB.canProceed).toBe(false);
      expect(resultB.action).toBe('block');
      expect(resultB.architecturalConflicts.length).toBeGreaterThan(0);

      // Verify the conflict includes opposing signals and explanation
      const conflict = resultB.architecturalConflicts[0];
      expect(conflict.opposingSignals.length).toBeGreaterThan(0);
      expect(conflict.opposingSignals.some(s => s.includes('session') && s.includes('jwt'))).toBe(true);
      expect(conflict.message).toContain('Architectural conflict');
      expect(conflict.entryB.machineId).toBe('machine-a');

      // The overlapping files should show the shared directory
      expect(conflict.overlappingFiles.length).toBeGreaterThan(0);

      // Step 3: Verify the onBlock callback fired with full context
      expect(onBlock).toHaveBeenCalledTimes(1);
      expect(blockCalls[0].maxTier).toBe(3);
      expect(blockCalls[0].canProceed).toBe(false);
      expect(blockCalls[0].architecturalConflicts[0].opposingSignals.length).toBeGreaterThan(0);

      // Step 4: Suggestion should recommend coordination
      expect(resultB.suggestion).toContain('Architectural conflict');
      expect(resultB.suggestion).toContain('machine-a');
    });
  });

  // ── Scenario 5: Multi-user escalation lifecycle ────────────────────

  describe('multi-user escalation lifecycle', () => {
    it('routes same-user overlap to log, different-user overlap to alert', () => {
      // Setup: two machines with DIFFERENT userIds
      const ledgerA = createLedger(stateDir, 'machine-a', 'user-alice');
      const ledgerB = createLedger(stateDir, 'machine-b', 'user-bob');

      const alertCallsDiffUser: OverlapCheckResult[] = [];
      const onAlertDiffUser = vi.fn((result: OverlapCheckResult) => {
        alertCallsDiffUser.push(result);
      });

      // Guard B belongs to user-bob
      const guardB = createGuard(ledgerB, 'machine-b', {
        userId: 'user-bob',
        onAlert: onAlertDiffUser,
      });

      // Step 1: Machine A (user-alice) starts work
      ledgerA.startWork({
        sessionId: 'AUT-500',
        task: 'Refactor shared module',
        filesPlanned: ['src/shared.ts'],
      });

      // Step 2: Machine B (user-bob) checks — different users overlap
      const resultDiffUser = guardB.check({
        plannedFiles: ['src/shared.ts'],
        task: 'Update shared module exports',
      });

      // Different users default to 'alert' action
      expect(resultDiffUser.action).toBe('alert');
      expect(resultDiffUser.canProceed).toBe(true);
      expect(resultDiffUser.maxTier).toBe(1);
      expect(onAlertDiffUser).toHaveBeenCalledTimes(1);

      // ─── Now test same-user scenario ───

      // Setup: Machine C also belongs to user-bob (same user, different machine)
      const ledgerC = createLedger(stateDir, 'machine-c', 'user-bob');
      const alertCallsSameUser: OverlapCheckResult[] = [];
      const onAlertSameUser = vi.fn((result: OverlapCheckResult) => {
        alertCallsSameUser.push(result);
      });

      const guardC = createGuard(ledgerC, 'machine-c', {
        userId: 'user-bob',
        onAlert: onAlertSameUser,
      });

      // Machine C (also user-bob) starts work on same file as Machine B
      ledgerB.startWork({
        sessionId: 'AUT-501',
        task: 'Update shared module exports',
        filesPlanned: ['src/shared.ts'],
      });

      // Machine C checks — same user overlap (B and C are both user-bob)
      // Note: Machine A (user-alice) also has overlap but Machine B is same-user.
      // The isSameUserOverlap logic returns false if ANY entry has a different userId.
      // So the result depends on whether there's at least one different-user overlap.
      // Machine C sees: A (alice, planned shared.ts) and B (bob, planned shared.ts).
      // Since A is different user, action should be 'alert'.
      const resultMixed = guardC.check({
        plannedFiles: ['src/shared.ts'],
        task: 'Shared module cleanup',
      });

      expect(resultMixed.action).toBe('alert');
      expect(resultMixed.canProceed).toBe(true);

      // ─── Pure same-user scenario: only same-user entries in overlap ───

      // New temp dir for a clean scenario
      const stateDir2 = createTempStateDir();
      try {
        const ledgerD = createLedger(stateDir2, 'machine-d', 'user-same');
        const ledgerE = createLedger(stateDir2, 'machine-e', 'user-same');

        const alertCallsPure: OverlapCheckResult[] = [];
        const onAlertPure = vi.fn((result: OverlapCheckResult) => {
          alertCallsPure.push(result);
        });

        const guardE = createGuard(ledgerE, 'machine-e', {
          userId: 'user-same',
          onAlert: onAlertPure,
        });

        // Machine D (user-same) starts work
        ledgerD.startWork({
          sessionId: 'AUT-502',
          task: 'Refactoring config',
          filesPlanned: ['src/config.ts'],
        });

        // Machine E (same user) checks — should route to 'log' (sameUser default)
        const resultSameUser = guardE.check({
          plannedFiles: ['src/config.ts'],
          task: 'Config updates',
        });

        // Same-user default is 'log', not 'alert'
        expect(resultSameUser.action).toBe('log');
        expect(resultSameUser.canProceed).toBe(true);
        expect(resultSameUser.maxTier).toBe(1);
        // onAlert should NOT fire for 'log' action
        expect(onAlertPure).not.toHaveBeenCalled();
      } finally {
        // safe-git-allow: incremental-migration
        fs.rmSync(stateDir2, { recursive: true, force: true });
      }
    });
  });

  // ── Scenario 6: Custom notification policy lifecycle ───────────────

  describe('custom notification policy lifecycle', () => {
    it('all-block policy makes even Tier 1 non-proceedable; all-log makes Tier 2 proceedable', () => {
      // ─── Part A: All tiers configured to 'block' ───

      const ledgerA = createLedger(stateDir, 'machine-a');
      const ledgerB = createLedger(stateDir, 'machine-b');

      const blockCallsA: OverlapCheckResult[] = [];
      const onBlockA = vi.fn((result: OverlapCheckResult) => {
        blockCallsA.push(result);
      });

      const guardB_allBlock = createGuard(ledgerB, 'machine-b', {
        notification: {
          sameUser: 'block',
          differentUsers: 'block',
          architecturalConflict: 'block',
        },
        onBlock: onBlockA,
      });

      // Machine A plans work on a file
      ledgerA.startWork({
        sessionId: 'AUT-600',
        task: 'Update helpers',
        filesPlanned: ['src/helpers.ts'],
      });

      // Machine B checks with all-block policy — even Tier 1 should block
      const resultAllBlock = guardB_allBlock.check({
        plannedFiles: ['src/helpers.ts'],
        task: 'Refactor helpers',
      });

      expect(resultAllBlock.maxTier).toBe(1);
      expect(resultAllBlock.action).toBe('block');
      expect(resultAllBlock.canProceed).toBe(false);
      expect(onBlockA).toHaveBeenCalledTimes(1);

      // ─── Part B: All tiers configured to 'log' ───

      // New temp dir for clean state
      const stateDir2 = createTempStateDir();
      try {
        const ledgerC = createLedger(stateDir2, 'machine-c');
        const ledgerD = createLedger(stateDir2, 'machine-d');

        const alertCallsB: OverlapCheckResult[] = [];
        const onAlertB = vi.fn((result: OverlapCheckResult) => {
          alertCallsB.push(result);
        });
        const blockCallsB: OverlapCheckResult[] = [];
        const onBlockB = vi.fn((result: OverlapCheckResult) => {
          blockCallsB.push(result);
        });

        const guardD_allLog = createGuard(ledgerD, 'machine-d', {
          notification: {
            sameUser: 'log',
            differentUsers: 'log',
            architecturalConflict: 'log',
          },
          onAlert: onAlertB,
          onBlock: onBlockB,
        });

        // Machine C starts work and actively modifies a file (would normally be Tier 2 → alert)
        const entryC = ledgerC.startWork({
          sessionId: 'AUT-601',
          task: 'API rewrite',
          filesPlanned: ['src/api.ts'],
        });
        ledgerC.updateWork(entryC.id, {
          filesModified: ['src/api.ts'],
        });

        // Machine D checks with all-log policy — Tier 2 overlap still canProceed
        const resultAllLog = guardD_allLog.check({
          plannedFiles: ['src/api.ts'],
          task: 'API endpoint additions',
        });

        expect(resultAllLog.maxTier).toBe(2);
        expect(resultAllLog.action).toBe('log');
        expect(resultAllLog.canProceed).toBe(true);
        // Neither alert nor block callback should fire for 'log' action
        expect(onAlertB).not.toHaveBeenCalled();
        expect(onBlockB).not.toHaveBeenCalled();

        // Also verify architectural conflict with all-log policy
        // Machine C task is "API rewrite", Machine D will use opposing task
        ledgerC.updateWork(entryC.id, {
          filesPlanned: ['src/api.ts', 'src/auth/handler.ts'],
        });

        // Need Machine C working on auth + has "session" in task to trigger opposition
        // Start fresh entry with architecturally opposed task
        ledgerC.endWork(entryC.id, 'completed');
        ledgerC.startWork({
          sessionId: 'AUT-602',
          task: 'Add session-based authentication',
          filesPlanned: ['src/auth/handler.ts'],
        });

        const resultArchLog = guardD_allLog.check({
          plannedFiles: ['src/auth/limiter.ts'],
          task: 'Switch to JWT token authentication',
        });

        // Even architectural conflict (Tier 3) is demoted to 'log' under all-log policy
        expect(resultArchLog.maxTier).toBe(3);
        expect(resultArchLog.action).toBe('log');
        expect(resultArchLog.canProceed).toBe(true);
        expect(onBlockB).not.toHaveBeenCalled();
      } finally {
        // safe-git-allow: incremental-migration
        fs.rmSync(stateDir2, { recursive: true, force: true });
      }
    });
  });
});
