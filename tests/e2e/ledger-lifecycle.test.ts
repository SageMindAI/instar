/**
 * E2E Lifecycle Tests for WorkLedger
 *
 * Per TESTING-INTEGRITY-SPEC Category 3: "The full path from user action
 * to user-visible outcome works end-to-end, with controlled (but real)
 * intermediate components."
 *
 * Tests the complete lifecycle paths of the WorkLedger: multi-machine
 * collaboration, stale detection/cleanup, session handoff, overlap
 * escalation, and corrupted ledger recovery. Each test exercises a
 * full user-facing path through real file-system state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkLedger } from '../../src/core/WorkLedger.js';
import type { LedgerEntry, MachineLedger } from '../../src/core/WorkLedger.js';

// ── Helpers ──────────────────────────────────────────────────────────

function createTempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-e2e-'));
  return dir;
}

/**
 * Create a WorkLedger instance for a given machine. Each machine gets
 * the same stateDir (simulating a shared .instar directory on a
 * synced filesystem), but writes only to its own file.
 */
function createLedger(
  stateDir: string,
  machineId: string,
  overrides?: Partial<{
    staleThresholdMs: number;
    staleMaxAgeMs: number;
    completedMaxAgeMs: number;
  }>,
): WorkLedger {
  return new WorkLedger({
    stateDir,
    machineId,
    ...overrides,
  });
}

/**
 * Directly manipulate the updatedAt timestamp of a ledger entry on disk
 * to simulate time passing without actually waiting.
 */
function setEntryUpdatedAt(
  stateDir: string,
  machineId: string,
  entryId: string,
  updatedAt: Date,
): void {
  const ledgerPath = path.join(stateDir, 'state', 'ledger', `${machineId}.json`);
  const ledger: MachineLedger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
  const entry = ledger.entries.find(e => e.id === entryId);
  if (!entry) throw new Error(`Entry ${entryId} not found in ${machineId} ledger`);
  entry.updatedAt = updatedAt.toISOString();
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

/**
 * Read the raw ledger JSON for a machine from disk.
 */
function readRawLedger(stateDir: string, machineId: string): MachineLedger {
  const ledgerPath = path.join(stateDir, 'state', 'ledger', `${machineId}.json`);
  return JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
}

// ── Tests ────────────────────────────────────────────────────────────

describe('WorkLedger E2E lifecycle', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = createTempStateDir();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  // ── Scenario 1: Multi-machine collaboration lifecycle ────────────

  describe('multi-machine collaboration lifecycle', () => {
    it('tracks overlap across machines from none → planned → modified → completed', () => {
      const ledgerA = createLedger(stateDir, 'machine-a');
      const ledgerB = createLedger(stateDir, 'machine-b');

      // Step 1: Machine A starts work on files [a.ts, b.ts]
      const entryA = ledgerA.startWork({
        sessionId: 'AUT-100',
        task: 'Refactor utilities',
        filesPlanned: ['a.ts', 'b.ts'],
      });
      expect(entryA.status).toBe('active');
      expect(entryA.filesPlanned).toEqual(['a.ts', 'b.ts']);

      // Step 2: Machine B starts work on files [c.ts, d.ts] — no overlap
      const entryB = ledgerB.startWork({
        sessionId: 'AUT-101',
        task: 'Add routes',
        filesPlanned: ['c.ts', 'd.ts'],
      });
      expect(entryB.status).toBe('active');

      // Step 3: Machine A checks for overlap — should be Tier 0 (none)
      const overlapsNone = ledgerA.detectOverlap(['a.ts', 'b.ts']);
      expect(overlapsNone).toHaveLength(0);

      // Step 4: Machine B updates to include b.ts (now overlapping with A)
      ledgerB.updateWork(entryB.id, {
        filesPlanned: ['c.ts', 'd.ts', 'b.ts'],
      });

      // Step 5: Machine A checks again — should detect Tier 1 (planned overlap)
      const overlapsPlanned = ledgerA.detectOverlap(['a.ts', 'b.ts']);
      expect(overlapsPlanned).toHaveLength(1);
      expect(overlapsPlanned[0].tier).toBe(1);
      expect(overlapsPlanned[0].overlappingFiles).toContain('b.ts');
      expect(overlapsPlanned[0].entry.machineId).toBe('machine-b');

      // Step 6: Machine B starts modifying b.ts — overlap escalates to Tier 2
      ledgerB.updateWork(entryB.id, {
        filesModified: ['b.ts'],
      });

      const overlapsModified = ledgerA.detectOverlap(['a.ts', 'b.ts']);
      expect(overlapsModified).toHaveLength(1);
      expect(overlapsModified[0].tier).toBe(2);
      expect(overlapsModified[0].overlappingFiles).toContain('b.ts');

      // Step 7: Machine A completes work
      ledgerA.endWork(entryA.id, 'completed');

      // Step 8: Machine B checks for overlap — Tier 0 (A is completed)
      // B's planned files don't overlap with a completed entry
      const overlapsBAfterComplete = ledgerB.detectOverlap(['c.ts', 'd.ts', 'b.ts']);
      expect(overlapsBAfterComplete).toHaveLength(0);

      // Verify A's entry shows as completed in the raw ledger
      const rawA = readRawLedger(stateDir, 'machine-a');
      expect(rawA.entries[0].status).toBe('completed');
    });
  });

  // ── Scenario 2: Stale detection and cleanup lifecycle ────────────

  describe('stale detection and cleanup lifecycle', () => {
    it('marks active entries stale after threshold, removes stale entries after max age', () => {
      // Use short thresholds for testing (the lifecycle manipulates timestamps directly)
      const ledger = createLedger(stateDir, 'machine-a', {
        staleThresholdMs: 2 * 60 * 60 * 1000,  // 2 hours
        staleMaxAgeMs: 6 * 60 * 60 * 1000,      // 6 hours
      });

      // Step 1: Machine A starts work
      const entry = ledger.startWork({
        sessionId: 'AUT-200',
        task: 'Long-running refactor',
        filesPlanned: ['src/big-module.ts'],
      });
      expect(entry.status).toBe('active');

      // Step 2: Simulate 3 hours passing (past 2h stale threshold)
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
      setEntryUpdatedAt(stateDir, 'machine-a', entry.id, threeHoursAgo);

      // Step 3: Run cleanup — entry should be marked stale
      const cleanup1 = ledger.cleanup();
      expect(cleanup1.markedStale).toBe(1);
      expect(cleanup1.removed).toBe(0);

      // Verify the entry is now stale
      const allEntries = ledger.getAllEntries();
      const staleEntry = allEntries.find(e => e.id === entry.id);
      expect(staleEntry?.status).toBe('stale');

      // Step 4: Simulate more time — set updatedAt to 7 hours ago (past 6h stale max)
      const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
      setEntryUpdatedAt(stateDir, 'machine-a', entry.id, sevenHoursAgo);

      // Step 5: Run cleanup — stale entry should be removed
      const cleanup2 = ledger.cleanup();
      expect(cleanup2.removed).toBe(1);
      expect(cleanup2.markedStale).toBe(0);

      // Verify the entry is gone
      const remainingEntries = ledger.getAllEntries();
      expect(remainingEntries).toHaveLength(0);
    });
  });

  // ── Scenario 3: Session handoff lifecycle ────────────────────────

  describe('session handoff lifecycle', () => {
    it('paused entries persist in active view, new entry resumes work', () => {
      const ledger = createLedger(stateDir, 'machine-a');

      // Step 1: Machine A starts session AUT-100, works on files
      const entry1 = ledger.startWork({
        sessionId: 'AUT-100',
        task: 'Build authentication',
        filesPlanned: ['src/auth.ts', 'src/middleware.ts'],
      });

      // Simulate some work being done
      ledger.updateWork(entry1.id, {
        filesModified: ['src/auth.ts'],
      });

      // Step 2: Machine A pauses the session
      const paused = ledger.endWork(entry1.id, 'paused');
      expect(paused).toBe(true);

      // Step 3: Verify paused entry still appears in getActiveEntries()
      const activeAfterPause = ledger.getActiveEntries();
      expect(activeAfterPause).toHaveLength(1);
      expect(activeAfterPause[0].id).toBe(entry1.id);
      expect(activeAfterPause[0].status).toBe('paused');
      expect(activeAfterPause[0].filesModified).toContain('src/auth.ts');

      // Step 4: Machine A resumes with a new entry (same session, new work unit)
      const entry2 = ledger.startWork({
        sessionId: 'AUT-100',
        task: 'Continue authentication — add OAuth',
        filesPlanned: ['src/auth.ts', 'src/middleware.ts', 'src/oauth.ts'],
      });
      expect(entry2.id).not.toBe(entry1.id);
      expect(entry2.status).toBe('active');

      // Step 5: Both entries visible — paused and new active
      const activeAfterResume = ledger.getActiveEntries();
      expect(activeAfterResume).toHaveLength(2);
      const statuses = activeAfterResume.map(e => e.status).sort();
      expect(statuses).toEqual(['active', 'paused']);

      // Step 6: Complete the new entry
      ledger.endWork(entry2.id, 'completed');

      // Step 7: Paused entry still persists (cleanup hasn't run)
      const activeAfterComplete = ledger.getActiveEntries();
      expect(activeAfterComplete).toHaveLength(1);
      expect(activeAfterComplete[0].id).toBe(entry1.id);
      expect(activeAfterComplete[0].status).toBe('paused');

      // The raw ledger has both entries
      const rawLedger = readRawLedger(stateDir, 'machine-a');
      expect(rawLedger.entries).toHaveLength(2);
    });
  });

  // ── Scenario 4: Concurrent work with overlap escalation ──────────

  describe('concurrent work with overlap escalation', () => {
    it('escalates from Tier 1 planned to Tier 2 modified, sorted by severity', () => {
      const ledgerA = createLedger(stateDir, 'machine-a');
      const ledgerB = createLedger(stateDir, 'machine-b');

      // Step 1: Machine A plans work on [src/index.ts, src/utils.ts, src/config.ts]
      ledgerA.startWork({
        sessionId: 'AUT-300',
        task: 'Core refactor',
        filesPlanned: ['src/index.ts', 'src/utils.ts', 'src/config.ts'],
      });

      // Step 2: Machine B plans work on [src/utils.ts, src/routes.ts]
      const entryB = ledgerB.startWork({
        sessionId: 'AUT-301',
        task: 'Route updates',
        filesPlanned: ['src/utils.ts', 'src/routes.ts'],
      });

      // Step 3: Machine A detects Tier 1 overlap on src/utils.ts (planned only)
      const overlaps1 = ledgerA.detectOverlap(['src/index.ts', 'src/utils.ts', 'src/config.ts']);
      expect(overlaps1).toHaveLength(1);
      expect(overlaps1[0].tier).toBe(1);
      expect(overlaps1[0].overlappingFiles).toEqual(['src/utils.ts']);
      expect(overlaps1[0].message).toContain('planning');

      // Step 4: Machine B modifies src/utils.ts
      ledgerB.updateWork(entryB.id, {
        filesModified: ['src/utils.ts'],
      });

      // Step 5: Machine A detects Tier 2 overlap on src/utils.ts (actively modified)
      const overlaps2 = ledgerA.detectOverlap(['src/index.ts', 'src/utils.ts', 'src/config.ts']);
      expect(overlaps2).toHaveLength(1);
      expect(overlaps2[0].tier).toBe(2);
      expect(overlaps2[0].overlappingFiles).toEqual(['src/utils.ts']);
      expect(overlaps2[0].message).toContain('actively modifying');

      // Step 6: Add a third machine with a different planned overlap to test sorting
      const ledgerC = createLedger(stateDir, 'machine-c');
      ledgerC.startWork({
        sessionId: 'AUT-302',
        task: 'Config updates',
        filesPlanned: ['src/config.ts', 'src/types.ts'],
      });

      // Machine A now has two overlaps: Tier 2 (B modifying utils) and Tier 1 (C planning config)
      const overlaps3 = ledgerA.detectOverlap(['src/index.ts', 'src/utils.ts', 'src/config.ts']);
      expect(overlaps3).toHaveLength(2);

      // Sorted by tier descending — Tier 2 first, then Tier 1
      expect(overlaps3[0].tier).toBe(2);
      expect(overlaps3[0].entry.machineId).toBe('machine-b');
      expect(overlaps3[1].tier).toBe(1);
      expect(overlaps3[1].entry.machineId).toBe('machine-c');
    });
  });

  // ── Scenario 5: Corrupted/missing ledger recovery ────────────────

  describe('corrupted/missing ledger recovery', () => {
    it('recovers gracefully from corrupted JSON, creates fresh ledger', () => {
      const ledger = createLedger(stateDir, 'machine-a');

      // Step 1: Machine A writes a valid ledger
      const entry1 = ledger.startWork({
        sessionId: 'AUT-400',
        task: 'Important work',
        filesPlanned: ['critical.ts'],
      });
      expect(entry1.status).toBe('active');

      // Verify ledger file exists with valid content
      const ledgerPath = path.join(stateDir, 'state', 'ledger', 'machine-a.json');
      expect(fs.existsSync(ledgerPath)).toBe(true);
      const validContent = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
      expect(validContent.entries).toHaveLength(1);

      // Step 2: Corrupt the JSON file manually
      fs.writeFileSync(ledgerPath, '{ this is not valid json !!!@#$');

      // Step 3: Machine A starts new work — should NOT crash
      // The constructor re-reads the ledger; readOwnLedger returns empty on parse failure
      const ledgerAfterCorruption = createLedger(stateDir, 'machine-a');
      const entry2 = ledgerAfterCorruption.startWork({
        sessionId: 'AUT-401',
        task: 'Recovery work',
        filesPlanned: ['recovery.ts'],
      });

      // Step 4: Verify the new entry exists and old data is lost (graceful recovery)
      expect(entry2.status).toBe('active');
      expect(entry2.filesPlanned).toEqual(['recovery.ts']);

      const recoveredLedger = readRawLedger(stateDir, 'machine-a');
      expect(recoveredLedger.entries).toHaveLength(1);
      expect(recoveredLedger.entries[0].id).toBe(entry2.id);
      expect(recoveredLedger.entries[0].sessionId).toBe('AUT-401');

      // Original entry is gone — the corrupted file was overwritten
      const hasOldEntry = recoveredLedger.entries.some(e => e.id === entry1.id);
      expect(hasOldEntry).toBe(false);
    });

    it('handles missing ledger directory gracefully', () => {
      // Create a stateDir but remove the ledger subdirectory
      const freshStateDir = createTempStateDir();

      try {
        // The constructor should create the ledger directory
        const ledger = createLedger(freshStateDir, 'new-machine');

        // Starting work on a fresh machine with no prior ledger should work
        const entry = ledger.startWork({
          sessionId: 'AUT-500',
          task: 'First task ever',
          filesPlanned: ['hello.ts'],
        });

        expect(entry.status).toBe('active');
        expect(entry.machineId).toBe('new-machine');

        // Reading all ledgers when only one machine exists
        const allEntries = ledger.getAllEntries();
        expect(allEntries).toHaveLength(1);
      } finally {
        // safe-git-allow: incremental-migration
        fs.rmSync(freshStateDir, { recursive: true, force: true });
      }
    });
  });

  // ── Cross-cutting: overlap ignores own machine ───────────────────

  describe('overlap self-exclusion', () => {
    it('does not report overlap with own machine entries', () => {
      const ledger = createLedger(stateDir, 'machine-a');

      // Machine A starts work on files
      ledger.startWork({
        sessionId: 'AUT-600',
        task: 'Refactoring',
        filesPlanned: ['src/index.ts', 'src/utils.ts'],
      });

      // Machine A checks overlap against its own planned files
      const overlaps = ledger.detectOverlap(['src/index.ts', 'src/utils.ts']);

      // Should be empty — a machine never conflicts with itself
      expect(overlaps).toHaveLength(0);
    });
  });

  // ── Cross-cutting: completed entry cleanup by age ────────────────

  describe('completed entry age-based cleanup', () => {
    it('removes completed entries older than the threshold', () => {
      const ledger = createLedger(stateDir, 'machine-a', {
        completedMaxAgeMs: 24 * 60 * 60 * 1000, // 24 hours
      });

      // Create and complete an entry
      const entry = ledger.startWork({
        sessionId: 'AUT-700',
        task: 'Quick task',
        filesPlanned: ['quick.ts'],
      });
      ledger.endWork(entry.id, 'completed');

      // Before aging: cleanup should not remove it
      const cleanup1 = ledger.cleanup();
      expect(cleanup1.removed).toBe(0);

      // Age the completed entry to 25 hours ago
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
      setEntryUpdatedAt(stateDir, 'machine-a', entry.id, twentyFiveHoursAgo);

      // Now cleanup should remove it
      const cleanup2 = ledger.cleanup();
      expect(cleanup2.removed).toBe(1);

      expect(ledger.getAllEntries()).toHaveLength(0);
    });
  });
});
