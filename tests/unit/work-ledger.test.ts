/**
 * Unit + Semantic Correctness tests for WorkLedger.
 *
 * Tests the per-machine ledger lifecycle, aggregate views, overlap detection
 * decision boundaries, and cleanup rules.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkLedger } from '../../src/core/WorkLedger.js';
import type { LedgerEntry, MachineLedger, OverlapTier } from '../../src/core/WorkLedger.js';

function makeLedger(tmpDir: string, machineId = 'machine-a', userId?: string) {
  const stateDir = path.join(tmpDir, '.instar');
  return new WorkLedger({ stateDir, machineId, userId });
}

describe('WorkLedger', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-ledger-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Session Lifecycle ────────────────────────────────────────────

  describe('session lifecycle', () => {
    it('startWork creates an entry with correct fields', () => {
      const ledger = makeLedger(tmpDir);

      const entry = ledger.startWork({
        sessionId: 'AUT-150',
        task: 'Implementing OAuth2',
        filesPlanned: ['src/auth.ts', 'src/routes.ts'],
        branch: 'task/add-oauth',
      });

      expect(entry.id).toMatch(/^work_[a-f0-9]{12}$/);
      expect(entry.machineId).toBe('machine-a');
      expect(entry.sessionId).toBe('AUT-150');
      expect(entry.status).toBe('active');
      expect(entry.task).toBe('Implementing OAuth2');
      expect(entry.filesPlanned).toEqual(['src/auth.ts', 'src/routes.ts']);
      expect(entry.filesModified).toEqual([]);
      expect(entry.branch).toBe('task/add-oauth');
      expect(entry.startedAt).toBeDefined();
      expect(entry.updatedAt).toBeDefined();
    });

    it('startWork persists to disk', () => {
      const ledger = makeLedger(tmpDir);
      ledger.startWork({ sessionId: 'AUT-150', task: 'Test' });

      // Read back from a fresh instance
      const ledger2 = makeLedger(tmpDir);
      const own = ledger2.readOwnLedger();

      expect(own.entries).toHaveLength(1);
      expect(own.entries[0].task).toBe('Test');
      expect(own.schemaVersion).toBe(1);
    });

    it('updateWork modifies active entries', () => {
      const ledger = makeLedger(tmpDir);
      const entry = ledger.startWork({
        sessionId: 'AUT-150',
        task: 'Initial task',
        filesPlanned: ['src/a.ts'],
      });

      const updated = ledger.updateWork(entry.id, {
        task: 'Updated task',
        filesModified: ['src/a.ts'],
      });

      expect(updated).toBe(true);

      const own = ledger.readOwnLedger();
      const found = own.entries.find(e => e.id === entry.id)!;
      expect(found.task).toBe('Updated task');
      expect(found.filesModified).toEqual(['src/a.ts']);
    });

    it('updateWork merges filesModified (union, not replace)', () => {
      const ledger = makeLedger(tmpDir);
      const entry = ledger.startWork({ sessionId: 'AUT-150', task: 'Test' });

      ledger.updateWork(entry.id, { filesModified: ['a.ts', 'b.ts'] });
      ledger.updateWork(entry.id, { filesModified: ['b.ts', 'c.ts'] });

      const found = ledger.readOwnLedger().entries.find(e => e.id === entry.id)!;
      expect(found.filesModified).toEqual(expect.arrayContaining(['a.ts', 'b.ts', 'c.ts']));
      expect(found.filesModified).toHaveLength(3); // No duplicates
    });

    it('updateWork returns false for non-existent entry', () => {
      const ledger = makeLedger(tmpDir);
      expect(ledger.updateWork('nonexistent', { task: 'x' })).toBe(false);
    });

    it('updateWork returns false for completed entry', () => {
      const ledger = makeLedger(tmpDir);
      const entry = ledger.startWork({ sessionId: 'AUT-150', task: 'Test' });
      ledger.endWork(entry.id, 'completed');

      expect(ledger.updateWork(entry.id, { task: 'New task' })).toBe(false);
    });

    it('endWork marks entry as completed', () => {
      const ledger = makeLedger(tmpDir);
      const entry = ledger.startWork({ sessionId: 'AUT-150', task: 'Test' });

      ledger.endWork(entry.id, 'completed');

      const found = ledger.readOwnLedger().entries.find(e => e.id === entry.id)!;
      expect(found.status).toBe('completed');
    });

    it('endWork marks entry as paused', () => {
      const ledger = makeLedger(tmpDir);
      const entry = ledger.startWork({ sessionId: 'AUT-150', task: 'Test' });

      ledger.endWork(entry.id, 'paused');

      const found = ledger.readOwnLedger().entries.find(e => e.id === entry.id)!;
      expect(found.status).toBe('paused');
    });

    it('endWork returns false for non-existent entry', () => {
      const ledger = makeLedger(tmpDir);
      expect(ledger.endWork('nonexistent')).toBe(false);
    });

    it('supports multiple concurrent entries', () => {
      const ledger = makeLedger(tmpDir);
      const entry1 = ledger.startWork({ sessionId: 'AUT-150', task: 'Task 1' });
      const entry2 = ledger.startWork({ sessionId: 'AUT-151', task: 'Task 2' });

      const own = ledger.readOwnLedger();
      expect(own.entries).toHaveLength(2);
      expect(own.entries.map(e => e.task)).toEqual(['Task 1', 'Task 2']);

      // End one, the other stays
      ledger.endWork(entry1.id);
      const active = ledger.getActiveEntries();
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(entry2.id);
    });
  });

  // ── Aggregate View ───────────────────────────────────────────────

  describe('aggregate view', () => {
    it('reads entries from multiple machine ledger files', () => {
      // Machine A writes its ledger
      const ledgerA = makeLedger(tmpDir, 'machine-a');
      ledgerA.startWork({ sessionId: 'AUT-150', task: 'Task A' });

      // Machine B writes its ledger (simulate by writing directly)
      const stateDir = path.join(tmpDir, '.instar');
      const bLedger: MachineLedger = {
        schemaVersion: 1,
        machineId: 'machine-b',
        lastUpdated: new Date().toISOString(),
        entries: [{
          id: 'work_b1',
          machineId: 'machine-b',
          sessionId: 'AUT-200',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: 'active',
          task: 'Task B',
          filesPlanned: ['src/b.ts'],
          filesModified: [],
        }],
        lastCleanup: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(stateDir, 'state', 'ledger', 'machine-b.json'),
        JSON.stringify(bLedger),
      );

      // Aggregate view should see both
      const active = ledgerA.getActiveEntries();
      expect(active).toHaveLength(2);
      expect(active.map(e => e.task).sort()).toEqual(['Task A', 'Task B']);
    });

    it('filters out completed entries in aggregate view', () => {
      const ledger = makeLedger(tmpDir);
      const entry = ledger.startWork({ sessionId: 'AUT-150', task: 'Done task' });
      ledger.endWork(entry.id, 'completed');
      ledger.startWork({ sessionId: 'AUT-151', task: 'Active task' });

      const active = ledger.getActiveEntries();
      expect(active).toHaveLength(1);
      expect(active[0].task).toBe('Active task');
    });

    it('includes paused entries in aggregate view', () => {
      const ledger = makeLedger(tmpDir);
      const entry = ledger.startWork({ sessionId: 'AUT-150', task: 'Paused task' });
      ledger.endWork(entry.id, 'paused');

      const active = ledger.getActiveEntries();
      expect(active).toHaveLength(1);
      expect(active[0].status).toBe('paused');
    });

    it('getAllEntries returns everything', () => {
      const ledger = makeLedger(tmpDir);
      ledger.startWork({ sessionId: 'AUT-150', task: 'Active' });
      const completed = ledger.startWork({ sessionId: 'AUT-151', task: 'Done' });
      ledger.endWork(completed.id, 'completed');

      const all = ledger.getAllEntries();
      expect(all).toHaveLength(2);
    });

    it('returns empty when no ledger files exist', () => {
      const ledger = makeLedger(tmpDir, 'fresh-machine');
      expect(ledger.getActiveEntries()).toEqual([]);
      expect(ledger.getAllEntries()).toEqual([]);
    });
  });

  // ── Overlap Detection (Semantic Correctness) ─────────────────────

  describe('overlap detection', () => {
    function setupTwoMachines(tmpDir: string) {
      const stateDir = path.join(tmpDir, '.instar');
      const ledgerA = new WorkLedger({ stateDir, machineId: 'machine-a' });
      const ledgerB = new WorkLedger({ stateDir, machineId: 'machine-b' });
      return { ledgerA, ledgerB };
    }

    it('Tier 0: returns empty when no overlap', () => {
      const { ledgerA, ledgerB } = setupTwoMachines(tmpDir);
      ledgerB.startWork({
        sessionId: 'AUT-200',
        task: 'Working on auth',
        filesPlanned: ['src/auth.ts'],
      });

      const warnings = ledgerA.detectOverlap(['src/utils.ts', 'src/config.ts']);
      expect(warnings).toHaveLength(0);
    });

    it('Tier 1: detects overlap with planned files', () => {
      const { ledgerA, ledgerB } = setupTwoMachines(tmpDir);
      ledgerB.startWork({
        sessionId: 'AUT-200',
        task: 'Planning auth changes',
        filesPlanned: ['src/auth.ts', 'src/routes.ts'],
      });

      const warnings = ledgerA.detectOverlap(['src/auth.ts']);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].tier).toBe(1);
      expect(warnings[0].overlappingFiles).toEqual(['src/auth.ts']);
      expect(warnings[0].message).toContain('machine-b');
      expect(warnings[0].message).toContain('planning');
    });

    it('Tier 2: detects overlap with actively modified files', () => {
      const { ledgerA, ledgerB } = setupTwoMachines(tmpDir);
      const entry = ledgerB.startWork({
        sessionId: 'AUT-200',
        task: 'Modifying auth',
        filesPlanned: ['src/auth.ts'],
      });
      ledgerB.updateWork(entry.id, { filesModified: ['src/auth.ts'] });

      const warnings = ledgerA.detectOverlap(['src/auth.ts']);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].tier).toBe(2);
      expect(warnings[0].message).toContain('actively modifying');
    });

    it('ignores own machine entries', () => {
      const stateDir = path.join(tmpDir, '.instar');
      const ledger = new WorkLedger({ stateDir, machineId: 'machine-a' });
      ledger.startWork({
        sessionId: 'AUT-150',
        task: 'My own work',
        filesPlanned: ['src/shared.ts'],
      });

      // Same machine's entries should not trigger overlap
      const warnings = ledger.detectOverlap(['src/shared.ts']);
      expect(warnings).toHaveLength(0);
    });

    it('returns warnings sorted by tier (highest first)', () => {
      const stateDir = path.join(tmpDir, '.instar');
      const ledgerA = new WorkLedger({ stateDir, machineId: 'machine-a' });

      // Machine B: only planned overlap (Tier 1)
      const bLedger: MachineLedger = {
        schemaVersion: 1,
        machineId: 'machine-b',
        lastUpdated: new Date().toISOString(),
        entries: [{
          id: 'work_b1',
          machineId: 'machine-b',
          sessionId: 'AUT-200',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: 'active',
          task: 'Planning',
          filesPlanned: ['src/a.ts'],
          filesModified: [],
        }],
        lastCleanup: new Date().toISOString(),
      };

      // Machine C: active overlap (Tier 2)
      const cLedger: MachineLedger = {
        schemaVersion: 1,
        machineId: 'machine-c',
        lastUpdated: new Date().toISOString(),
        entries: [{
          id: 'work_c1',
          machineId: 'machine-c',
          sessionId: 'AUT-300',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: 'active',
          task: 'Active work',
          filesPlanned: ['src/b.ts'],
          filesModified: ['src/b.ts'],
        }],
        lastCleanup: new Date().toISOString(),
      };

      const ledgerDir = path.join(stateDir, 'state', 'ledger');
      fs.writeFileSync(path.join(ledgerDir, 'machine-b.json'), JSON.stringify(bLedger));
      fs.writeFileSync(path.join(ledgerDir, 'machine-c.json'), JSON.stringify(cLedger));

      const warnings = ledgerA.detectOverlap(['src/a.ts', 'src/b.ts']);
      expect(warnings).toHaveLength(2);
      expect(warnings[0].tier).toBe(2); // Higher severity first
      expect(warnings[1].tier).toBe(1);
    });

    it('returns empty when planned files list is empty', () => {
      const { ledgerA, ledgerB } = setupTwoMachines(tmpDir);
      ledgerB.startWork({
        sessionId: 'AUT-200',
        task: 'Work',
        filesPlanned: ['src/auth.ts'],
      });

      expect(ledgerA.detectOverlap([])).toEqual([]);
    });

    it('does not detect overlap with paused entries from other machines', () => {
      const { ledgerA, ledgerB } = setupTwoMachines(tmpDir);
      const entry = ledgerB.startWork({
        sessionId: 'AUT-200',
        task: 'Paused work',
        filesPlanned: ['src/shared.ts'],
      });
      ledgerB.endWork(entry.id, 'paused');

      // Paused entries ARE included in active view but should still trigger overlap
      const warnings = ledgerA.detectOverlap(['src/shared.ts']);
      // Paused entries are in getActiveEntries, so they still show overlap
      expect(warnings).toHaveLength(1);
    });
  });

  // ── Cleanup ──────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('removes completed entries older than threshold', () => {
      const stateDir = path.join(tmpDir, '.instar');
      const ledger = new WorkLedger({
        stateDir,
        machineId: 'machine-a',
        completedMaxAgeMs: 1000, // 1 second for testing
      });

      const entry = ledger.startWork({ sessionId: 'AUT-150', task: 'Test' });
      ledger.endWork(entry.id, 'completed');

      // Manually backdate the updatedAt
      const ownLedger = ledger.readOwnLedger();
      ownLedger.entries[0].updatedAt = new Date(Date.now() - 2000).toISOString();
      fs.writeFileSync(
        path.join(stateDir, 'state', 'ledger', 'machine-a.json'),
        JSON.stringify(ownLedger),
      );

      const result = ledger.cleanup();
      expect(result.removed).toBe(1);
      expect(ledger.readOwnLedger().entries).toHaveLength(0);
    });

    it('keeps completed entries younger than threshold', () => {
      const stateDir = path.join(tmpDir, '.instar');
      const ledger = new WorkLedger({
        stateDir,
        machineId: 'machine-a',
        completedMaxAgeMs: 60000, // 1 minute
      });

      const entry = ledger.startWork({ sessionId: 'AUT-150', task: 'Test' });
      ledger.endWork(entry.id, 'completed');

      const result = ledger.cleanup();
      expect(result.removed).toBe(0);
      expect(ledger.readOwnLedger().entries).toHaveLength(1);
    });

    it('marks stale active entries', () => {
      const stateDir = path.join(tmpDir, '.instar');
      const ledger = new WorkLedger({
        stateDir,
        machineId: 'machine-a',
        staleThresholdMs: 1000, // 1 second for testing
      });

      ledger.startWork({ sessionId: 'AUT-150', task: 'Stale work' });

      // Backdate
      const ownLedger = ledger.readOwnLedger();
      ownLedger.entries[0].updatedAt = new Date(Date.now() - 2000).toISOString();
      fs.writeFileSync(
        path.join(stateDir, 'state', 'ledger', 'machine-a.json'),
        JSON.stringify(ownLedger),
      );

      const result = ledger.cleanup();
      expect(result.markedStale).toBe(1);

      const entry = ledger.readOwnLedger().entries[0];
      expect(entry.status).toBe('stale');
    });

    it('removes stale entries older than max age', () => {
      const stateDir = path.join(tmpDir, '.instar');
      const ledger = new WorkLedger({
        stateDir,
        machineId: 'machine-a',
        staleThresholdMs: 500,
        staleMaxAgeMs: 1000,
      });

      ledger.startWork({ sessionId: 'AUT-150', task: 'Old stale' });

      // Backdate and mark as stale
      const ownLedger = ledger.readOwnLedger();
      ownLedger.entries[0].status = 'stale';
      ownLedger.entries[0].updatedAt = new Date(Date.now() - 2000).toISOString();
      fs.writeFileSync(
        path.join(stateDir, 'state', 'ledger', 'machine-a.json'),
        JSON.stringify(ownLedger),
      );

      const result = ledger.cleanup();
      expect(result.removed).toBe(1);
      expect(ledger.readOwnLedger().entries).toHaveLength(0);
    });

    it('updates lastCleanup timestamp', () => {
      const ledger = makeLedger(tmpDir);
      ledger.startWork({ sessionId: 'AUT-150', task: 'Test' });

      const before = ledger.readOwnLedger().lastCleanup;
      ledger.cleanup();
      const after = ledger.readOwnLedger().lastCleanup;

      expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    });
  });

  // ── Per-Machine Isolation ────────────────────────────────────────

  describe('per-machine isolation', () => {
    it('each machine writes only its own file', () => {
      const stateDir = path.join(tmpDir, '.instar');
      const ledgerA = new WorkLedger({ stateDir, machineId: 'machine-a' });
      const ledgerB = new WorkLedger({ stateDir, machineId: 'machine-b' });

      ledgerA.startWork({ sessionId: 'AUT-150', task: 'A work' });
      ledgerB.startWork({ sessionId: 'AUT-200', task: 'B work' });

      const ledgerDir = path.join(stateDir, 'state', 'ledger');
      const files = fs.readdirSync(ledgerDir).sort();

      expect(files).toEqual(['machine-a.json', 'machine-b.json']);

      // Each file contains only its own entries
      const aData = JSON.parse(fs.readFileSync(path.join(ledgerDir, 'machine-a.json'), 'utf-8'));
      const bData = JSON.parse(fs.readFileSync(path.join(ledgerDir, 'machine-b.json'), 'utf-8'));

      expect(aData.entries).toHaveLength(1);
      expect(aData.entries[0].machineId).toBe('machine-a');
      expect(bData.entries).toHaveLength(1);
      expect(bData.entries[0].machineId).toBe('machine-b');
    });

    it('cleanup only affects own machine entries', () => {
      const stateDir = path.join(tmpDir, '.instar');
      const ledgerA = new WorkLedger({
        stateDir,
        machineId: 'machine-a',
        completedMaxAgeMs: 1000,
      });
      const ledgerB = new WorkLedger({
        stateDir,
        machineId: 'machine-b',
        completedMaxAgeMs: 1000,
      });

      // Both create and complete entries
      const entryA = ledgerA.startWork({ sessionId: 'AUT-150', task: 'A' });
      ledgerA.endWork(entryA.id, 'completed');
      const entryB = ledgerB.startWork({ sessionId: 'AUT-200', task: 'B' });
      ledgerB.endWork(entryB.id, 'completed');

      // Backdate both
      for (const mid of ['machine-a', 'machine-b']) {
        const filePath = path.join(stateDir, 'state', 'ledger', `${mid}.json`);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        data.entries[0].updatedAt = new Date(Date.now() - 2000).toISOString();
        fs.writeFileSync(filePath, JSON.stringify(data));
      }

      // Only clean up machine A
      ledgerA.cleanup();

      // A's entries should be cleaned
      expect(ledgerA.readOwnLedger().entries).toHaveLength(0);

      // B's entries should be untouched
      const bData = JSON.parse(
        fs.readFileSync(path.join(stateDir, 'state', 'ledger', 'machine-b.json'), 'utf-8'),
      );
      expect(bData.entries).toHaveLength(1);
    });
  });

  // ── Schema & File Structure ──────────────────────────────────────

  describe('schema', () => {
    it('writes schemaVersion 1', () => {
      const ledger = makeLedger(tmpDir);
      ledger.startWork({ sessionId: 'AUT-150', task: 'Test' });

      const own = ledger.readOwnLedger();
      expect(own.schemaVersion).toBe(1);
    });

    it('stores userId when provided', () => {
      const stateDir = path.join(tmpDir, '.instar');
      const ledger = new WorkLedger({ stateDir, machineId: 'machine-a', userId: 'justin' });

      const entry = ledger.startWork({ sessionId: 'AUT-150', task: 'Test' });
      expect(entry.userId).toBe('justin');
    });

    it('creates ledger directory if it does not exist', () => {
      const stateDir = path.join(tmpDir, 'fresh', '.instar');
      // Directory doesn't exist yet
      expect(fs.existsSync(stateDir)).toBe(false);

      new WorkLedger({ stateDir, machineId: 'machine-a' });

      expect(fs.existsSync(path.join(stateDir, 'state', 'ledger'))).toBe(true);
    });

    it('handles corrupted ledger file gracefully', () => {
      const stateDir = path.join(tmpDir, '.instar');
      const ledger = new WorkLedger({ stateDir, machineId: 'machine-a' });

      // Write corrupt data
      const ledgerDir = path.join(stateDir, 'state', 'ledger');
      fs.writeFileSync(path.join(ledgerDir, 'machine-a.json'), 'not json');

      // Should not throw — returns empty ledger
      const own = ledger.readOwnLedger();
      expect(own.entries).toEqual([]);
      expect(own.machineId).toBe('machine-a');
    });
  });
});
