/**
 * Wiring Integrity Tests for WorkLedger
 *
 * Per TESTING-INTEGRITY-SPEC Category 1: "For every dependency-injected function, test that:
 *   1. It is not null/undefined when the feature is enabled
 *   2. It is not a no-op (calling it produces observable side effects)
 *   3. It delegates to the real implementation (not a stub)"
 *
 * These tests verify the WorkLedger module produces real filesystem side effects,
 * creates the ledger directory on construction, writes JSON files per-machine,
 * and maintains isolation between machine instances.
 *
 * Note: WorkLedger is NOT yet wired into GitSyncManager. These tests verify
 * standalone wiring integrity. When GitSync integration lands, add a
 * "GitSyncManager.workLedger wiring" describe block here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkLedger } from '../../src/core/WorkLedger.js';
import type { WorkLedgerConfig, MachineLedger } from '../../src/core/WorkLedger.js';

// ── Helpers ─────────────────────────────────────────────────────────

function makeConfig(stateDir: string, machineId = 'test-machine-001', overrides?: Partial<WorkLedgerConfig>): WorkLedgerConfig {
  return {
    stateDir,
    machineId,
    ...overrides,
  };
}

function ledgerDir(stateDir: string): string {
  return path.join(stateDir, 'state', 'ledger');
}

function ledgerFilePath(stateDir: string, machineId: string): string {
  return path.join(ledgerDir(stateDir), `${machineId}.json`);
}

// ── Tests ───────────────────────────────────────────────────────────

describe('WorkLedger wiring integrity', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-wiring-'));
    stateDir = path.join(tmpDir, '.instar');
    // Do NOT pre-create stateDir — let WorkLedger handle it
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Category 1: WorkLedger is not null/undefined ──────────────────

  describe('construction', () => {
    it('WorkLedger is not null/undefined when constructed with valid config', () => {
      const ledger = new WorkLedger(makeConfig(stateDir));
      expect(ledger).toBeDefined();
      expect(ledger).not.toBeNull();
      expect(ledger).toBeInstanceOf(WorkLedger);
    });

    it('ledger directory is created on construction', () => {
      const dir = ledgerDir(stateDir);
      expect(fs.existsSync(dir)).toBe(false);

      new WorkLedger(makeConfig(stateDir));

      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    });

    it('ledger directory creation is idempotent (no error on second construction)', () => {
      new WorkLedger(makeConfig(stateDir));
      // Second construction with same stateDir should not throw
      const ledger2 = new WorkLedger(makeConfig(stateDir));
      expect(ledger2).toBeDefined();
      expect(fs.existsSync(ledgerDir(stateDir))).toBe(true);
    });
  });

  // ── Category 2: Methods are not no-ops ────────────────────────────

  describe('startWork produces observable side effects', () => {
    it('startWork() creates the machine ledger file on disk', () => {
      const machineId = 'machine-alpha';
      const ledger = new WorkLedger(makeConfig(stateDir, machineId));

      const filePath = ledgerFilePath(stateDir, machineId);
      expect(fs.existsSync(filePath)).toBe(false);

      ledger.startWork({
        sessionId: 'AUT-100',
        task: 'Refactor auth module',
      });

      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('startWork() returns an entry with a generated ID', () => {
      const ledger = new WorkLedger(makeConfig(stateDir));

      const entry = ledger.startWork({
        sessionId: 'AUT-101',
        task: 'Build ledger tests',
        filesPlanned: ['src/core/WorkLedger.ts'],
      });

      expect(entry).toBeDefined();
      expect(entry.id).toMatch(/^work_[a-f0-9]{12}$/);
      expect(entry.sessionId).toBe('AUT-101');
      expect(entry.task).toBe('Build ledger tests');
      expect(entry.status).toBe('active');
      expect(entry.filesPlanned).toEqual(['src/core/WorkLedger.ts']);
      expect(entry.filesModified).toEqual([]);
    });

    it('startWork() persists entry to disk (not just in-memory)', () => {
      const machineId = 'machine-beta';
      const ledger = new WorkLedger(makeConfig(stateDir, machineId));

      const entry = ledger.startWork({
        sessionId: 'AUT-102',
        task: 'Database migration',
      });

      // Read the file directly — bypass the WorkLedger API
      const filePath = ledgerFilePath(stateDir, machineId);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as MachineLedger;

      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0].id).toBe(entry.id);
      expect(parsed.entries[0].task).toBe('Database migration');
      expect(parsed.machineId).toBe(machineId);
      expect(parsed.schemaVersion).toBe(1);
    });
  });

  describe('updateWork produces observable side effects', () => {
    it('updateWork() modifies the entry on disk', () => {
      const machineId = 'machine-gamma';
      const ledger = new WorkLedger(makeConfig(stateDir, machineId));

      const entry = ledger.startWork({
        sessionId: 'AUT-103',
        task: 'Initial task',
        filesPlanned: ['src/a.ts'],
      });

      const result = ledger.updateWork(entry.id, {
        task: 'Updated task',
        filesModified: ['src/a.ts'],
        filesPlanned: ['src/a.ts', 'src/b.ts'],
      });

      expect(result).toBe(true);

      // Verify on disk
      const filePath = ledgerFilePath(stateDir, machineId);
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as MachineLedger;
      const updated = parsed.entries.find(e => e.id === entry.id);

      expect(updated).toBeDefined();
      expect(updated!.task).toBe('Updated task');
      expect(updated!.filesModified).toContain('src/a.ts');
      expect(updated!.filesPlanned).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('updateWork() returns false for non-existent entry ID', () => {
      const ledger = new WorkLedger(makeConfig(stateDir));
      const result = ledger.updateWork('work_nonexistent00', { task: 'nope' });
      expect(result).toBe(false);
    });

    it('updateWork() merges filesModified (union, not replace)', () => {
      const ledger = new WorkLedger(makeConfig(stateDir));

      const entry = ledger.startWork({
        sessionId: 'AUT-104',
        task: 'Merge test',
      });

      ledger.updateWork(entry.id, { filesModified: ['a.ts', 'b.ts'] });
      ledger.updateWork(entry.id, { filesModified: ['b.ts', 'c.ts'] });

      const own = ledger.readOwnLedger();
      const updated = own.entries.find(e => e.id === entry.id);

      expect(updated!.filesModified).toContain('a.ts');
      expect(updated!.filesModified).toContain('b.ts');
      expect(updated!.filesModified).toContain('c.ts');
      expect(updated!.filesModified).toHaveLength(3);
    });
  });

  describe('endWork produces observable side effects', () => {
    it('endWork() marks entry as completed on disk', () => {
      const machineId = 'machine-delta';
      const ledger = new WorkLedger(makeConfig(stateDir, machineId));

      const entry = ledger.startWork({
        sessionId: 'AUT-105',
        task: 'Completable task',
      });

      expect(entry.status).toBe('active');

      const result = ledger.endWork(entry.id, 'completed');
      expect(result).toBe(true);

      // Verify on disk
      const parsed = JSON.parse(
        fs.readFileSync(ledgerFilePath(stateDir, machineId), 'utf-8'),
      ) as MachineLedger;
      expect(parsed.entries[0].status).toBe('completed');
    });

    it('endWork() with paused status persists correctly', () => {
      const ledger = new WorkLedger(makeConfig(stateDir));

      const entry = ledger.startWork({
        sessionId: 'AUT-106',
        task: 'Pausable task',
      });

      ledger.endWork(entry.id, 'paused');
      const own = ledger.readOwnLedger();
      expect(own.entries[0].status).toBe('paused');
    });

    it('endWork() returns false for non-existent entry ID', () => {
      const ledger = new WorkLedger(makeConfig(stateDir));
      const result = ledger.endWork('work_nonexistent00');
      expect(result).toBe(false);
    });
  });

  // ── Category 3: Delegates to real filesystem (not a stub) ─────────

  describe('filesystem delegation', () => {
    it('ledger file is valid JSON that roundtrips through JSON.parse', () => {
      const machineId = 'machine-roundtrip';
      const ledger = new WorkLedger(makeConfig(stateDir, machineId));

      ledger.startWork({ sessionId: 'AUT-107', task: 'Roundtrip test' });

      const raw = fs.readFileSync(ledgerFilePath(stateDir, machineId), 'utf-8');
      const parsed = JSON.parse(raw);

      // Should not throw — valid JSON
      expect(parsed).toHaveProperty('schemaVersion');
      expect(parsed).toHaveProperty('machineId', machineId);
      expect(parsed).toHaveProperty('entries');
      expect(parsed).toHaveProperty('lastUpdated');
      expect(parsed).toHaveProperty('lastCleanup');
    });

    it('readOwnLedger() returns empty entries when no file exists yet', () => {
      const ledger = new WorkLedger(makeConfig(stateDir, 'fresh-machine'));
      const own = ledger.readOwnLedger();

      expect(own.entries).toEqual([]);
      expect(own.machineId).toBe('fresh-machine');
      expect(own.schemaVersion).toBe(1);
    });

    it('multiple startWork calls accumulate entries in the same file', () => {
      const machineId = 'machine-multi';
      const ledger = new WorkLedger(makeConfig(stateDir, machineId));

      ledger.startWork({ sessionId: 'AUT-108', task: 'First task' });
      ledger.startWork({ sessionId: 'AUT-109', task: 'Second task' });
      ledger.startWork({ sessionId: 'AUT-110', task: 'Third task' });

      const parsed = JSON.parse(
        fs.readFileSync(ledgerFilePath(stateDir, machineId), 'utf-8'),
      ) as MachineLedger;

      expect(parsed.entries).toHaveLength(3);
      expect(parsed.entries.map(e => e.task)).toEqual([
        'First task',
        'Second task',
        'Third task',
      ]);
    });
  });

  // ── Category 4: Multi-machine isolation ───────────────────────────

  describe('multi-machine isolation', () => {
    it('different machineIds write to separate files', () => {
      const ledgerA = new WorkLedger(makeConfig(stateDir, 'machine-A'));
      const ledgerB = new WorkLedger(makeConfig(stateDir, 'machine-B'));

      ledgerA.startWork({ sessionId: 'AUT-200', task: 'Task on A' });
      ledgerB.startWork({ sessionId: 'AUT-201', task: 'Task on B' });

      const fileA = ledgerFilePath(stateDir, 'machine-A');
      const fileB = ledgerFilePath(stateDir, 'machine-B');

      expect(fs.existsSync(fileA)).toBe(true);
      expect(fs.existsSync(fileB)).toBe(true);

      const parsedA = JSON.parse(fs.readFileSync(fileA, 'utf-8')) as MachineLedger;
      const parsedB = JSON.parse(fs.readFileSync(fileB, 'utf-8')) as MachineLedger;

      expect(parsedA.machineId).toBe('machine-A');
      expect(parsedB.machineId).toBe('machine-B');

      expect(parsedA.entries).toHaveLength(1);
      expect(parsedA.entries[0].task).toBe('Task on A');
      expect(parsedB.entries).toHaveLength(1);
      expect(parsedB.entries[0].task).toBe('Task on B');
    });

    it('readOwnLedger() only reads own machine file', () => {
      const ledgerA = new WorkLedger(makeConfig(stateDir, 'machine-A'));
      const ledgerB = new WorkLedger(makeConfig(stateDir, 'machine-B'));

      ledgerA.startWork({ sessionId: 'AUT-202', task: 'A only' });
      ledgerB.startWork({ sessionId: 'AUT-203', task: 'B only' });

      const ownA = ledgerA.readOwnLedger();
      const ownB = ledgerB.readOwnLedger();

      expect(ownA.entries).toHaveLength(1);
      expect(ownA.entries[0].task).toBe('A only');
      expect(ownB.entries).toHaveLength(1);
      expect(ownB.entries[0].task).toBe('B only');
    });

    it('getActiveEntries() aggregates across all machines', () => {
      const ledgerA = new WorkLedger(makeConfig(stateDir, 'machine-A'));
      const ledgerB = new WorkLedger(makeConfig(stateDir, 'machine-B'));

      ledgerA.startWork({ sessionId: 'AUT-204', task: 'Task A' });
      ledgerB.startWork({ sessionId: 'AUT-205', task: 'Task B' });

      // Either instance should see both entries
      const activeFromA = ledgerA.getActiveEntries();
      const activeFromB = ledgerB.getActiveEntries();

      expect(activeFromA).toHaveLength(2);
      expect(activeFromB).toHaveLength(2);

      const tasks = activeFromA.map(e => e.task).sort();
      expect(tasks).toEqual(['Task A', 'Task B']);
    });

    it('completed entries are excluded from getActiveEntries()', () => {
      const ledgerA = new WorkLedger(makeConfig(stateDir, 'machine-A'));
      const ledgerB = new WorkLedger(makeConfig(stateDir, 'machine-B'));

      const entryA = ledgerA.startWork({ sessionId: 'AUT-206', task: 'Active A' });
      ledgerB.startWork({ sessionId: 'AUT-207', task: 'Active B' });
      ledgerA.endWork(entryA.id, 'completed');

      const active = ledgerA.getActiveEntries();
      expect(active).toHaveLength(1);
      expect(active[0].task).toBe('Active B');
    });
  });

  // ── Category 5: Overlap detection ─────────────────────────────────

  describe('overlap detection (cross-machine awareness)', () => {
    it('detectOverlap() finds planned file conflicts across machines', () => {
      const ledgerA = new WorkLedger(makeConfig(stateDir, 'machine-A'));
      const ledgerB = new WorkLedger(makeConfig(stateDir, 'machine-B'));

      ledgerA.startWork({
        sessionId: 'AUT-300',
        task: 'Refactor auth',
        filesPlanned: ['src/auth.ts', 'src/middleware.ts'],
      });

      // Machine B checks for overlap before starting
      const warnings = ledgerB.detectOverlap(['src/auth.ts', 'src/utils.ts']);

      expect(warnings).toHaveLength(1);
      expect(warnings[0].tier).toBe(1); // Planned overlap
      expect(warnings[0].overlappingFiles).toEqual(['src/auth.ts']);
      expect(warnings[0].entry.machineId).toBe('machine-A');
    });

    it('detectOverlap() detects active modification overlap (tier 2)', () => {
      const ledgerA = new WorkLedger(makeConfig(stateDir, 'machine-A'));
      const ledgerB = new WorkLedger(makeConfig(stateDir, 'machine-B'));

      const entryA = ledgerA.startWork({
        sessionId: 'AUT-301',
        task: 'Modify config',
        filesPlanned: ['config.json'],
      });

      // Machine A has actively modified the file
      ledgerA.updateWork(entryA.id, { filesModified: ['config.json'] });

      const warnings = ledgerB.detectOverlap(['config.json']);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].tier).toBe(2); // Active overlap
    });

    it('detectOverlap() excludes own machine entries', () => {
      const ledgerA = new WorkLedger(makeConfig(stateDir, 'machine-A'));

      ledgerA.startWork({
        sessionId: 'AUT-302',
        task: 'Self check',
        filesPlanned: ['src/self.ts'],
      });

      // Same machine checking — should NOT flag its own work
      const warnings = ledgerA.detectOverlap(['src/self.ts']);
      expect(warnings).toHaveLength(0);
    });

    it('detectOverlap() returns empty array when no overlap exists', () => {
      const ledgerA = new WorkLedger(makeConfig(stateDir, 'machine-A'));
      const ledgerB = new WorkLedger(makeConfig(stateDir, 'machine-B'));

      ledgerA.startWork({
        sessionId: 'AUT-303',
        task: 'Work on X',
        filesPlanned: ['src/x.ts'],
      });

      const warnings = ledgerB.detectOverlap(['src/y.ts', 'src/z.ts']);
      expect(warnings).toHaveLength(0);
    });
  });

  // ── Category 6: Cleanup produces observable effects ───────────────

  describe('cleanup lifecycle', () => {
    it('cleanup() marks stale entries and removes old completed entries', async () => {
      const machineId = 'machine-cleanup';
      const ledger = new WorkLedger(makeConfig(stateDir, machineId, {
        staleThresholdMs: 0,       // Immediately stale (> 0ms age)
        completedMaxAgeMs: 0,      // Immediately removable
        staleMaxAgeMs: 0,          // Immediately removable
      }));

      // Create entries with different statuses
      const activeEntry = ledger.startWork({ sessionId: 'AUT-400', task: 'Active work' });
      const completedEntry = ledger.startWork({ sessionId: 'AUT-401', task: 'Done work' });
      ledger.endWork(completedEntry.id, 'completed');

      // Wait 5ms so updatedAge > 0 is guaranteed (strict inequality in cleanup logic)
      await new Promise(resolve => setTimeout(resolve, 5));

      // With zero thresholds and elapsed time, cleanup should mark active as stale and remove completed
      const result = ledger.cleanup();

      expect(result.markedStale).toBe(1);
      expect(result.removed).toBe(1); // completed entry removed

      const own = ledger.readOwnLedger();
      // Only the formerly-active (now stale) entry should remain
      expect(own.entries).toHaveLength(1);
      expect(own.entries[0].id).toBe(activeEntry.id);
      expect(own.entries[0].status).toBe('stale');
    });

    it('cleanup() writes lastCleanup timestamp to disk', () => {
      const machineId = 'machine-cleanup-ts';
      const ledger = new WorkLedger(makeConfig(stateDir, machineId));

      ledger.startWork({ sessionId: 'AUT-402', task: 'Timestamp check' });

      const beforeCleanup = new Date().toISOString();
      ledger.cleanup();

      const parsed = JSON.parse(
        fs.readFileSync(ledgerFilePath(stateDir, machineId), 'utf-8'),
      ) as MachineLedger;

      expect(parsed.lastCleanup).toBeDefined();
      // lastCleanup should be at or after our reference time
      expect(parsed.lastCleanup >= beforeCleanup).toBe(true);
    });
  });

  // ── Category 7: GitSyncManager integration (NOT YET WIRED) ───────

  describe('GitSyncManager integration (future)', () => {
    it.skip('GitSyncManager has a workLedger field when constructed with machineId', () => {
      // TODO: Enable when WorkLedger is wired into GitSyncManager.
      // Expected pattern:
      //   const gitSync = new GitSyncManager({ ... });
      //   const ledger = (gitSync as any).workLedger;
      //   expect(ledger).toBeDefined();
      //   expect(ledger).toBeInstanceOf(WorkLedger);
    });
  });
});
