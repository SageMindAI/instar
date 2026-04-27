import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TrustAuditLog } from '../../../src/threadline/TrustAuditLog.js';

describe('TrustAuditLog', () => {
  let tmpDir: string;
  let log: TrustAuditLog;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
    log = new TrustAuditLog(tmpDir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('append', () => {
    it('creates an entry with all required fields', () => {
      const entry = log.append('trust-upgrade', 'agent-abc', 'user', { from: 'untrusted', to: 'verified' });
      expect(entry.timestamp).toBeDefined();
      expect(entry.action).toBe('trust-upgrade');
      expect(entry.subject).toBe('agent-abc');
      expect(entry.actor).toBe('user');
      expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.previousHash).toBe(''); // first entry
    });

    it('chains hashes correctly', () => {
      const e1 = log.append('trust-upgrade', 'a', 'user');
      const e2 = log.append('grant-create', 'a', 'user');
      expect(e2.previousHash).toBe(e1.hash);
      expect(e2.hash).not.toBe(e1.hash);
    });

    it('persists to disk', () => {
      log.append('trust-upgrade', 'a', 'user');
      const logFile = path.join(tmpDir, 'threadline', 'trust-audit-chain.jsonl');
      expect(fs.existsSync(logFile)).toBe(true);
      const content = fs.readFileSync(logFile, 'utf-8');
      expect(content.trim().split('\n')).toHaveLength(1);
    });
  });

  describe('verifyIntegrity', () => {
    it('verifies an empty log', () => {
      const result = log.verifyIntegrity();
      expect(result.valid).toBe(true);
      expect(result.entries).toBe(0);
    });

    it('verifies a valid chain', () => {
      log.append('trust-upgrade', 'a', 'user');
      log.append('grant-create', 'a', 'user');
      log.append('trust-downgrade', 'a', 'system');

      const result = log.verifyIntegrity();
      expect(result.valid).toBe(true);
      expect(result.entries).toBe(3);
    });

    it('detects tampered entry', () => {
      log.append('trust-upgrade', 'a', 'user');
      log.append('grant-create', 'a', 'user');

      // Tamper with the log file
      const logFile = path.join(tmpDir, 'threadline', 'trust-audit-chain.jsonl');
      const content = fs.readFileSync(logFile, 'utf-8');
      const lines = content.trim().split('\n');
      const entry = JSON.parse(lines[0]);
      entry.actor = 'attacker'; // modify content
      lines[0] = JSON.stringify(entry);
      fs.writeFileSync(logFile, lines.join('\n') + '\n');

      const result = log.verifyIntegrity();
      expect(result.valid).toBe(false);
      expect(result.error).toContain('hash mismatch');
    });

    it('detects broken chain (deleted entry)', () => {
      log.append('trust-upgrade', 'a', 'user');
      log.append('grant-create', 'a', 'user');
      log.append('trust-downgrade', 'a', 'system');

      // Remove the middle entry
      const logFile = path.join(tmpDir, 'threadline', 'trust-audit-chain.jsonl');
      const content = fs.readFileSync(logFile, 'utf-8');
      const lines = content.trim().split('\n');
      lines.splice(1, 1); // remove entry at index 1
      fs.writeFileSync(logFile, lines.join('\n') + '\n');

      const result = log.verifyIntegrity();
      expect(result.valid).toBe(false);
      expect(result.error).toContain('previousHash mismatch');
    });
  });

  describe('persistence across restarts', () => {
    it('continues chain after reload', () => {
      log.append('trust-upgrade', 'a', 'user');
      log.append('grant-create', 'a', 'user');

      // Simulate restart
      const log2 = new TrustAuditLog(tmpDir);
      log2.append('trust-downgrade', 'a', 'system');

      const result = log2.verifyIntegrity();
      expect(result.valid).toBe(true);
      expect(result.entries).toBe(3);
    });
  });

  describe('size', () => {
    it('tracks entry count', () => {
      expect(log.size).toBe(0);
      log.append('trust-upgrade', 'a', 'user');
      expect(log.size).toBe(1);
      log.append('grant-create', 'a', 'user');
      expect(log.size).toBe(2);
    });
  });
});
