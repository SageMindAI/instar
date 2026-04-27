/**
 * Unit tests for AuditTrail — Tamper-evident logging for LLM merge operations.
 *
 * Tests:
 * - Logging: Each event type creates correct entry structure
 * - Chain integrity: Each entry's previousHash matches prior entry's entryHash, genesis hash
 * - Querying: Filter by type, machineId, sessionId, time range, limit
 * - Stats: Correct counts by type and machine
 * - Integrity verification: Intact chain passes, tampered entry detected, broken chain
 * - Rotation: Log rotates at max entries
 * - Edge cases: Empty log, single entry
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AuditTrail } from '../../src/core/AuditTrail.js';

// ── Test Helpers ─────────────────────────────────────────────────────

const GENESIS_HASH = '0'.repeat(64);

let tempDir: string;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-audit-test-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

function createTrail(maxEntries?: number): AuditTrail {
  return new AuditTrail({
    stateDir: tempDir,
    machineId: 'm_testmachine',
    maxEntriesPerFile: maxEntries,
  });
}

function readLogEntries(stateDir: string) {
  const logPath = path.join(stateDir, 'state', 'audit', 'current.jsonl');
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// ── Lifecycle ─────────────────────────────────────────────────────────

beforeEach(() => {
  tempDir = createTempDir();
});

afterEach(() => {
  cleanup(tempDir);
});

// ── Logging ──────────────────────────────────────────────────────────

describe('AuditTrail', () => {
  describe('Logging', () => {
    it('logLLMInvocation creates correct entry structure', () => {
      const trail = createTrail();
      const entry = trail.logLLMInvocation({
        promptHash: 'abc123',
        model: 'claude-3-sonnet',
        conflictFile: 'src/main.ts',
        tier: 1,
        tokenEstimate: 500,
        sessionId: 'AUT-100',
      });

      expect(entry.type).toBe('llm-invocation');
      expect(entry.machineId).toBe('m_testmachine');
      expect(entry.sessionId).toBe('AUT-100');
      expect(entry.data.promptHash).toBe('abc123');
      expect(entry.data.model).toBe('claude-3-sonnet');
      expect(entry.data.conflictFile).toBe('src/main.ts');
      expect(entry.data.tier).toBe(1);
      expect(entry.id).toMatch(/^audit_/);
      expect(entry.timestamp).toBeDefined();
      expect(entry.entryHash).toBeDefined();
      expect(entry.previousHash).toBeDefined();
    });

    it('logResolution creates correct entry', () => {
      const trail = createTrail();
      const entry = trail.logResolution({
        file: 'src/config.ts',
        chosenSide: 'ours',
        confidence: 0.95,
        tier: 0,
        conflictRegions: 2,
      });

      expect(entry.type).toBe('resolution');
      expect(entry.data.file).toBe('src/config.ts');
      expect(entry.data.chosenSide).toBe('ours');
      expect(entry.data.confidence).toBe(0.95);
    });

    it('logValidation creates correct entry', () => {
      const trail = createTrail();
      const entry = trail.logValidation({
        file: 'package.json',
        passed: true,
        checks: ['json-parse', 'schema-valid'],
      });

      expect(entry.type).toBe('validation');
      expect(entry.data.passed).toBe(true);
      expect(entry.data.checks).toEqual(['json-parse', 'schema-valid']);
    });

    it('logRedaction creates correct entry (no secret values)', () => {
      const trail = createTrail();
      const entry = trail.logRedaction({
        file: '.env',
        totalRedactions: 3,
        typeCounts: { 'api-key': 2, 'connection-string': 1 },
        entropyStringsFound: 0,
      });

      expect(entry.type).toBe('redaction');
      expect(entry.data.totalRedactions).toBe(3);
      // Verify no secret values are stored
      expect(JSON.stringify(entry)).not.toContain('sk-');
    });

    it('logSecurity creates correct entry', () => {
      const trail = createTrail();
      const entry = trail.logSecurity({
        event: 'injection-attempt',
        severity: 'high',
        details: 'System override pattern detected',
        sourceFile: 'README.md',
      });

      expect(entry.type).toBe('security');
      expect(entry.data.severity).toBe('high');
    });

    it('logHandoff creates correct entry', () => {
      const trail = createTrail();
      const entry = trail.logHandoff({
        fromMachine: 'm_laptop',
        toMachine: 'm_desktop',
        reason: 'Machine going offline',
        workItemCount: 5,
      });

      expect(entry.type).toBe('handoff');
      expect(entry.data.fromMachine).toBe('m_laptop');
      expect(entry.data.workItemCount).toBe(5);
    });

    it('logBranch creates correct entry', () => {
      const trail = createTrail();
      const entry = trail.logBranch({
        action: 'create',
        branch: 'feature/new-thing',
        result: 'success',
      });

      expect(entry.type).toBe('branch');
      expect(entry.data.action).toBe('create');
      expect(entry.data.branch).toBe('feature/new-thing');
    });

    it('logAccessDenied creates correct entry', () => {
      const trail = createTrail();
      const entry = trail.logAccessDenied({
        userId: 'user-bob',
        permission: 'config:modify',
        role: 'contributor',
        action: 'modify-config',
      });

      expect(entry.type).toBe('access-denied');
      expect(entry.data.userId).toBe('user-bob');
      expect(entry.data.permission).toBe('config:modify');
    });
  });

  // ── Chain Integrity ─────────────────────────────────────────────────

  describe('Chain Integrity', () => {
    it('first entry chains from genesis hash', () => {
      const trail = createTrail();
      const entry = trail.logSecurity({
        event: 'test',
        severity: 'low',
        details: 'first entry',
      });

      expect(entry.previousHash).toBe(GENESIS_HASH);
    });

    it('second entry previousHash matches first entry entryHash', () => {
      const trail = createTrail();
      const first = trail.logSecurity({
        event: 'test',
        severity: 'low',
        details: 'first',
      });
      const second = trail.logSecurity({
        event: 'test',
        severity: 'low',
        details: 'second',
      });

      expect(second.previousHash).toBe(first.entryHash);
    });

    it('chain of 5 entries has correct links', () => {
      const trail = createTrail();
      const entries = [];
      for (let i = 0; i < 5; i++) {
        entries.push(trail.logSecurity({
          event: `event-${i}`,
          severity: 'low',
          details: `Entry ${i}`,
        }));
      }

      expect(entries[0].previousHash).toBe(GENESIS_HASH);
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i].previousHash).toBe(entries[i - 1].entryHash);
      }
    });

    it('each entry has a unique entryHash', () => {
      const trail = createTrail();
      const hashes = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const entry = trail.logSecurity({
          event: `event-${i}`,
          severity: 'low',
          details: `Entry ${i}`,
        });
        hashes.add(entry.entryHash);
      }
      expect(hashes.size).toBe(10);
    });

    it('entryHash is a 64-char hex string (SHA-256)', () => {
      const trail = createTrail();
      const entry = trail.logSecurity({
        event: 'test',
        severity: 'low',
        details: 'hash format test',
      });
      expect(entry.entryHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ── Querying ────────────────────────────────────────────────────────

  describe('Querying', () => {
    it('filters by event type', () => {
      const trail = createTrail();
      trail.logSecurity({ event: 'sec1', severity: 'low', details: 'a' });
      trail.logResolution({ file: 'x.ts', chosenSide: 'ours', confidence: 0.9, tier: 0, conflictRegions: 1 });
      trail.logSecurity({ event: 'sec2', severity: 'high', details: 'b' });

      const results = trail.query({ type: 'security' });
      expect(results).toHaveLength(2);
      expect(results.every(r => r.type === 'security')).toBe(true);
    });

    it('filters by machineId', () => {
      const trail = createTrail();
      trail.logSecurity({ event: 'test', severity: 'low', details: 'a' });

      const results = trail.query({ machineId: 'm_testmachine' });
      expect(results.length).toBeGreaterThan(0);

      const noResults = trail.query({ machineId: 'm_nonexistent' });
      expect(noResults).toHaveLength(0);
    });

    it('filters by sessionId', () => {
      const trail = createTrail();
      trail.logSecurity({ event: 'a', severity: 'low', details: 'a', sessionId: 'AUT-100' });
      trail.logSecurity({ event: 'b', severity: 'low', details: 'b', sessionId: 'AUT-200' });
      trail.logSecurity({ event: 'c', severity: 'low', details: 'c', sessionId: 'AUT-100' });

      const results = trail.query({ sessionId: 'AUT-100' });
      expect(results).toHaveLength(2);
    });

    it('filters by time range (after)', () => {
      const trail = createTrail();
      trail.logSecurity({ event: 'early', severity: 'low', details: 'a' });

      // Small delay to ensure different timestamps
      const cutoff = new Date().toISOString();

      trail.logSecurity({ event: 'late', severity: 'low', details: 'b' });

      const results = trail.query({ after: cutoff });
      // Should get entries after cutoff — may be 0 or 1 depending on timing
      expect(results.every(r => r.timestamp > cutoff)).toBe(true);
    });

    it('filters by time range (before)', () => {
      const trail = createTrail();
      trail.logSecurity({ event: 'a', severity: 'low', details: 'a' });

      const future = '2099-12-31T23:59:59.999Z';
      const results = trail.query({ before: future });
      expect(results.length).toBeGreaterThan(0);
    });

    it('respects limit parameter', () => {
      const trail = createTrail();
      for (let i = 0; i < 10; i++) {
        trail.logSecurity({ event: `e-${i}`, severity: 'low', details: `d-${i}` });
      }

      const results = trail.query({ limit: 3 });
      expect(results).toHaveLength(3);
    });

    it('limit returns last N entries', () => {
      const trail = createTrail();
      for (let i = 0; i < 5; i++) {
        trail.logSecurity({ event: `e-${i}`, severity: 'low', details: `d-${i}`, sessionId: `s-${i}` });
      }

      const results = trail.query({ limit: 2 });
      expect(results).toHaveLength(2);
      // Last two entries
      expect(results[0].data.event).toBe('e-3');
      expect(results[1].data.event).toBe('e-4');
    });

    it('returns all entries with no filter', () => {
      const trail = createTrail();
      trail.logSecurity({ event: 'a', severity: 'low', details: 'x' });
      trail.logBranch({ action: 'create', branch: 'b', result: 'success' });

      const results = trail.query();
      expect(results).toHaveLength(2);
    });
  });

  // ── Stats ───────────────────────────────────────────────────────────

  describe('Stats', () => {
    it('returns correct counts by type', () => {
      const trail = createTrail();
      trail.logSecurity({ event: 'a', severity: 'low', details: 'x' });
      trail.logSecurity({ event: 'b', severity: 'low', details: 'y' });
      trail.logResolution({ file: 'x.ts', chosenSide: 'ours', confidence: 0.8, tier: 0, conflictRegions: 1 });

      const stats = trail.stats();
      expect(stats.totalEntries).toBe(3);
      expect(stats.byType['security']).toBe(2);
      expect(stats.byType['resolution']).toBe(1);
    });

    it('returns correct counts by machine', () => {
      const trail = createTrail();
      trail.logSecurity({ event: 'a', severity: 'low', details: 'x' });
      trail.logSecurity({ event: 'b', severity: 'low', details: 'y' });

      const stats = trail.stats();
      expect(stats.byMachine['m_testmachine']).toBe(2);
    });

    it('returns firstEntry and lastEntry timestamps', () => {
      const trail = createTrail();
      const first = trail.logSecurity({ event: 'a', severity: 'low', details: 'x' });
      const last = trail.logSecurity({ event: 'b', severity: 'low', details: 'y' });

      const stats = trail.stats();
      expect(stats.firstEntry).toBe(first.timestamp);
      expect(stats.lastEntry).toBe(last.timestamp);
    });

    it('returns empty stats for empty log', () => {
      const trail = createTrail();
      const stats = trail.stats();
      expect(stats.totalEntries).toBe(0);
      expect(stats.firstEntry).toBeUndefined();
      expect(stats.lastEntry).toBeUndefined();
    });
  });

  // ── Integrity Verification ──────────────────────────────────────────

  describe('Integrity Verification', () => {
    it('intact chain passes verification', () => {
      const trail = createTrail();
      for (let i = 0; i < 5; i++) {
        trail.logSecurity({ event: `e-${i}`, severity: 'low', details: `d-${i}` });
      }

      const result = trail.verifyIntegrity();
      expect(result.intact).toBe(true);
      expect(result.entriesChecked).toBe(5);
      expect(result.brokenAt).toBeUndefined();
    });

    it('detects tampered entry (modified data)', () => {
      const trail = createTrail();
      trail.logSecurity({ event: 'a', severity: 'low', details: 'x' });
      trail.logSecurity({ event: 'b', severity: 'low', details: 'y' });
      trail.logSecurity({ event: 'c', severity: 'low', details: 'z' });

      // Tamper with the second entry
      const logPath = path.join(tempDir, 'state', 'audit', 'current.jsonl');
      const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
      const entry = JSON.parse(lines[1]);
      entry.data.event = 'TAMPERED';
      lines[1] = JSON.stringify(entry);
      fs.writeFileSync(logPath, lines.join('\n') + '\n');

      // Reload trail to pick up tampered data
      const trail2 = createTrail();
      const result = trail2.verifyIntegrity();
      expect(result.intact).toBe(false);
      expect(result.brokenAt).toBe(1);
      expect(result.breakDetails).toContain('tampered');
    });

    it('detects broken chain link (previousHash mismatch)', () => {
      const trail = createTrail();
      trail.logSecurity({ event: 'a', severity: 'low', details: 'x' });
      trail.logSecurity({ event: 'b', severity: 'low', details: 'y' });
      trail.logSecurity({ event: 'c', severity: 'low', details: 'z' });

      // Break the chain by modifying the second entry's previousHash
      // and recalculating its entryHash to pass self-check but fail chain check
      const logPath = path.join(tempDir, 'state', 'audit', 'current.jsonl');
      const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
      const entry = JSON.parse(lines[1]);
      entry.previousHash = '0'.repeat(64); // Wrong previous hash
      // We need to also fix the entryHash so the self-check passes
      // but the chain link breaks
      const crypto = require('node:crypto');
      const hashable = {
        id: entry.id,
        type: entry.type,
        timestamp: entry.timestamp,
        machineId: entry.machineId,
        userId: entry.userId,
        sessionId: entry.sessionId,
        data: entry.data,
        previousHash: entry.previousHash,
      };
      entry.entryHash = crypto.createHash('sha256').update(JSON.stringify(hashable)).digest('hex');
      lines[1] = JSON.stringify(entry);
      fs.writeFileSync(logPath, lines.join('\n') + '\n');

      const trail2 = createTrail();
      const result = trail2.verifyIntegrity();
      expect(result.intact).toBe(false);
      expect(result.brokenAt).toBe(1);
      expect(result.breakDetails).toContain('Chain broken');
    });

    it('empty log passes verification', () => {
      const trail = createTrail();
      const result = trail.verifyIntegrity();
      expect(result.intact).toBe(true);
      expect(result.entriesChecked).toBe(0);
    });

    it('single entry passes verification', () => {
      const trail = createTrail();
      trail.logSecurity({ event: 'only', severity: 'low', details: 'x' });

      const result = trail.verifyIntegrity();
      expect(result.intact).toBe(true);
      expect(result.entriesChecked).toBe(1);
    });

    it('detects corrupted first entry (not chaining from genesis)', () => {
      const trail = createTrail();
      trail.logSecurity({ event: 'a', severity: 'low', details: 'x' });

      // Tamper with first entry's previousHash
      const logPath = path.join(tempDir, 'state', 'audit', 'current.jsonl');
      const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
      const entry = JSON.parse(lines[0]);
      entry.previousHash = 'badhash'.repeat(9) + 'b'; // 64 chars
      lines[0] = JSON.stringify(entry);
      fs.writeFileSync(logPath, lines.join('\n') + '\n');

      const trail2 = createTrail();
      const result = trail2.verifyIntegrity();
      expect(result.intact).toBe(false);
      expect(result.brokenAt).toBe(0);
    });
  });

  // ── Rotation ────────────────────────────────────────────────────────

  describe('Rotation', () => {
    it('rotates log when max entries reached', () => {
      const trail = createTrail(5); // Very low max for testing
      for (let i = 0; i < 6; i++) {
        trail.logSecurity({ event: `e-${i}`, severity: 'low', details: `d-${i}` });
      }

      // After rotation, the current log should have fewer entries than 6
      const auditDir = path.join(tempDir, 'state', 'audit');
      const files = fs.readdirSync(auditDir);

      // Should have current.jsonl and at least one archive
      const archives = files.filter(f => f.startsWith('audit-') && f.endsWith('.jsonl'));
      expect(archives.length).toBeGreaterThanOrEqual(1);
    });

    it('archive files are named with timestamp', () => {
      const trail = createTrail(3);
      for (let i = 0; i < 4; i++) {
        trail.logSecurity({ event: `e-${i}`, severity: 'low', details: `d-${i}` });
      }

      const auditDir = path.join(tempDir, 'state', 'audit');
      const files = fs.readdirSync(auditDir);
      const archives = files.filter(f => f.startsWith('audit-') && f.endsWith('.jsonl'));
      if (archives.length > 0) {
        expect(archives[0]).toMatch(/^audit-\d{4}-\d{2}-\d{2}T/);
      }
    });
  });

  // ── Persistence ─────────────────────────────────────────────────────

  describe('Persistence', () => {
    it('entries survive trail re-instantiation', () => {
      const trail1 = createTrail();
      trail1.logSecurity({ event: 'persistent', severity: 'low', details: 'x' });

      const trail2 = createTrail();
      const results = trail2.query();
      expect(results).toHaveLength(1);
      expect(results[0].data.event).toBe('persistent');
    });

    it('chain continues correctly after re-instantiation', () => {
      const trail1 = createTrail();
      const first = trail1.logSecurity({ event: 'first', severity: 'low', details: 'x' });

      const trail2 = createTrail();
      const second = trail2.logSecurity({ event: 'second', severity: 'low', details: 'y' });

      expect(second.previousHash).toBe(first.entryHash);

      // Verify full chain integrity
      const trail3 = createTrail();
      const result = trail3.verifyIntegrity();
      expect(result.intact).toBe(true);
      expect(result.entriesChecked).toBe(2);
    });
  });

  // ── Edge Cases ──────────────────────────────────────────────────────

  describe('Edge Cases', () => {
    it('creates audit directory if it does not exist', () => {
      const freshDir = createTempDir();
      try {
        const trail = new AuditTrail({
          stateDir: freshDir,
          machineId: 'm_fresh',
        });
        trail.logSecurity({ event: 'test', severity: 'low', details: 'x' });
        const auditDir = path.join(freshDir, 'state', 'audit');
        expect(fs.existsSync(auditDir)).toBe(true);
      } finally {
        cleanup(freshDir);
      }
    });

    it('handles entries without sessionId', () => {
      const trail = createTrail();
      const entry = trail.logSecurity({
        event: 'no-session',
        severity: 'low',
        details: 'test',
      });
      expect(entry.sessionId).toBeUndefined();
    });

    it('entry IDs are unique', () => {
      const trail = createTrail();
      const ids = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const entry = trail.logSecurity({ event: `e-${i}`, severity: 'low', details: `d-${i}` });
        ids.add(entry.id);
      }
      expect(ids.size).toBe(20);
    });

    it('entry IDs have audit_ prefix', () => {
      const trail = createTrail();
      const entry = trail.logSecurity({ event: 'test', severity: 'low', details: 'x' });
      expect(entry.id).toMatch(/^audit_[0-9a-f]+$/);
    });
  });
});
