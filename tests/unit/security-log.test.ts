/**
 * Unit tests for SecurityLog — hash-chain integrity log.
 *
 * Tests:
 * - Append entries with automatic hash chaining
 * - Genesis entry has prevHash "GENESIS"
 * - Chain verification (intact and tampered)
 * - Read all entries
 * - Persistence across instances
 * - Empty log handling
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SecurityLog } from '../../src/core/SecurityLog.js';

// ── Helpers ──────────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-seclog-test-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('SecurityLog', () => {
  let tmpDir: string;
  let logsDir: string;
  let log: SecurityLog;

  beforeEach(() => {
    tmpDir = createTempDir();
    logsDir = path.join(tmpDir, 'logs');
    log = new SecurityLog(logsDir);
  });

  afterEach(() => cleanup(tmpDir));

  describe('append', () => {
    it('creates the log file on first append', () => {
      log.append({ event: 'pairing_success', machineId: 'm_test' });
      expect(fs.existsSync(log.path)).toBe(true);
    });

    it('first entry has prevHash "GENESIS"', () => {
      const entry = log.append({ event: 'pairing_success', machineId: 'm_test' });
      expect(entry.prevHash).toBe('GENESIS');
    });

    it('second entry links to hash of first', () => {
      const first = log.append({ event: 'pairing_success', machineId: 'm_test' });
      const second = log.append({ event: 'role_transition', machineId: 'm_test' });

      expect(second.prevHash).not.toBe('GENESIS');
      expect(second.prevHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('includes timestamp', () => {
      const entry = log.append({ event: 'pairing_success', machineId: 'm_test' });
      expect(entry.timestamp).toBeTruthy();
      expect(new Date(entry.timestamp).getTime()).not.toBeNaN();
    });

    it('preserves additional event data', () => {
      const entry = log.append({
        event: 'pairing_success',
        machineId: 'm_test',
        remoteMachineId: 'm_remote',
        ip: '192.168.1.1',
      });

      expect((entry as any).remoteMachineId).toBe('m_remote');
      expect((entry as any).ip).toBe('192.168.1.1');
    });
  });

  describe('readAll', () => {
    it('returns empty array for non-existent log', () => {
      expect(log.readAll()).toEqual([]);
    });

    it('returns all appended entries', () => {
      log.append({ event: 'pairing_success', machineId: 'm_1' });
      log.append({ event: 'role_transition', machineId: 'm_1' });
      log.append({ event: 'machine_revoked', machineId: 'm_2' });

      const entries = log.readAll();
      expect(entries).toHaveLength(3);
      expect(entries[0].event).toBe('pairing_success');
      expect(entries[1].event).toBe('role_transition');
      expect(entries[2].event).toBe('machine_revoked');
    });
  });

  describe('verifyChain', () => {
    it('returns valid for empty log', () => {
      expect(log.verifyChain()).toEqual({ valid: true });
    });

    it('returns valid for intact chain', () => {
      log.append({ event: 'pairing_success', machineId: 'm_1' });
      log.append({ event: 'role_transition', machineId: 'm_1' });
      log.append({ event: 'secret_sync', machineId: 'm_1' });

      expect(log.verifyChain()).toEqual({ valid: true });
    });

    it('detects tampering at beginning of chain', () => {
      log.append({ event: 'pairing_success', machineId: 'm_1' });
      log.append({ event: 'role_transition', machineId: 'm_1' });
      log.append({ event: 'secret_sync', machineId: 'm_1' });

      // Tamper with the first entry
      const content = fs.readFileSync(log.path, 'utf-8');
      const lines = content.split('\n').filter(l => l);
      const first = JSON.parse(lines[0]);
      first.machineId = 'm_attacker';
      lines[0] = JSON.stringify(first);
      fs.writeFileSync(log.path, lines.join('\n') + '\n');

      // Chain should be broken at index 1 (because the hash of entry 0 changed)
      const result = log.verifyChain();
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.brokenAt).toBe(1);
      }
    });

    it('detects tampering in middle of chain', () => {
      log.append({ event: 'pairing_success', machineId: 'm_1' });
      log.append({ event: 'role_transition', machineId: 'm_1' });
      log.append({ event: 'secret_sync', machineId: 'm_1' });

      // Tamper with the second entry's event type
      const content = fs.readFileSync(log.path, 'utf-8');
      const lines = content.split('\n').filter(l => l);
      const second = JSON.parse(lines[1]);
      second.event = 'machine_revoked';
      lines[1] = JSON.stringify(second);
      fs.writeFileSync(log.path, lines.join('\n') + '\n');

      const result = log.verifyChain();
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.brokenAt).toBe(2);
      }
    });

    it('detects insertion of new entry', () => {
      log.append({ event: 'pairing_success', machineId: 'm_1' });
      log.append({ event: 'secret_sync', machineId: 'm_1' });

      // Insert a fake entry between the two
      const content = fs.readFileSync(log.path, 'utf-8');
      const lines = content.split('\n').filter(l => l);
      const fake = JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'role_transition',
        machineId: 'm_attacker',
        prevHash: 'sha256:fake',
      });
      lines.splice(1, 0, fake);
      fs.writeFileSync(log.path, lines.join('\n') + '\n');

      const result = log.verifyChain();
      expect(result.valid).toBe(false);
    });
  });

  describe('length', () => {
    it('returns 0 for non-existent log', () => {
      expect(log.length).toBe(0);
    });

    it('returns correct count', () => {
      log.append({ event: 'pairing_success', machineId: 'm_1' });
      log.append({ event: 'role_transition', machineId: 'm_1' });
      expect(log.length).toBe(2);
    });
  });

  describe('persistence', () => {
    it('new instance continues the hash chain correctly', () => {
      log.append({ event: 'pairing_success', machineId: 'm_1' });
      log.append({ event: 'role_transition', machineId: 'm_1' });

      // Create a new instance pointing to the same log
      const log2 = new SecurityLog(logsDir);
      log2.append({ event: 'secret_sync', machineId: 'm_1' });

      // Chain should still be valid
      expect(log2.verifyChain()).toEqual({ valid: true });
      expect(log2.length).toBe(3);
    });

    it('handles server restart (new instance reads last hash)', () => {
      log.append({ event: 'pairing_success', machineId: 'm_1' });

      // Simulate server restart
      const log2 = new SecurityLog(logsDir);
      const entry = log2.append({ event: 'role_transition', machineId: 'm_1' });

      // Should NOT have GENESIS as prevHash (should link to first entry)
      expect(entry.prevHash).not.toBe('GENESIS');
      expect(log2.verifyChain()).toEqual({ valid: true });
    });
  });
});
