/**
 * Unit tests for NonceStore — triple-layer anti-replay.
 *
 * Tests:
 * - Timestamp window validation
 * - Nonce uniqueness (replay detection)
 * - Sequence number monotonicity per peer
 * - Persistence across instances
 * - Pruning (expired nonces removed)
 * - Edge cases (corrupt file, empty file)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { NonceStore } from '../../src/core/NonceStore.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-nonce-test-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

function randomNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

describe('NonceStore', () => {
  let tmpDir: string;
  let store: NonceStore;

  beforeEach(() => {
    tmpDir = createTempDir();
    store = new NonceStore(tmpDir);
  });

  afterEach(() => {
    store.destroy();
    cleanup(tmpDir);
  });

  // ── Timestamp Validation ─────────────────────────────────────────

  describe('timestamp window', () => {
    it('accepts timestamp within 30s window', () => {
      const result = store.validate(
        new Date().toISOString(),
        randomNonce(),
        0,
        'm_peer1',
      );
      expect(result.valid).toBe(true);
    });

    it('accepts timestamp a few seconds old', () => {
      const ts = new Date(Date.now() - 10_000).toISOString();
      const result = store.validate(ts, randomNonce(), 0, 'm_peer1');
      expect(result.valid).toBe(true);
    });

    it('rejects timestamp outside 30s window', () => {
      const ts = new Date(Date.now() - 60_000).toISOString();
      const result = store.validate(ts, randomNonce(), 0, 'm_peer1');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('window');
      }
    });

    it('rejects future timestamps beyond window', () => {
      const ts = new Date(Date.now() + 60_000).toISOString();
      const result = store.validate(ts, randomNonce(), 0, 'm_peer1');
      expect(result.valid).toBe(false);
    });

    it('accepts epoch millisecond format', () => {
      const result = store.validate(Date.now(), randomNonce(), 0, 'm_peer1');
      expect(result.valid).toBe(true);
    });
  });

  // ── Nonce Uniqueness ─────────────────────────────────────────────

  describe('nonce uniqueness', () => {
    it('accepts fresh nonce', () => {
      const nonce = randomNonce();
      const result = store.validate(Date.now(), nonce, 0, 'm_peer1');
      expect(result.valid).toBe(true);
    });

    it('rejects duplicate nonce (replay detection)', () => {
      const nonce = randomNonce();
      store.validate(Date.now(), nonce, 0, 'm_peer1');

      const result = store.validate(Date.now(), nonce, 1, 'm_peer1');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('replay');
      }
    });

    it('accepts different nonces from same peer', () => {
      const r1 = store.validate(Date.now(), randomNonce(), 0, 'm_peer1');
      const r2 = store.validate(Date.now(), randomNonce(), 1, 'm_peer1');
      expect(r1.valid).toBe(true);
      expect(r2.valid).toBe(true);
    });
  });

  // ── Sequence Numbers ─────────────────────────────────────────────

  describe('sequence numbers', () => {
    it('accepts increasing sequence', () => {
      const r1 = store.validate(Date.now(), randomNonce(), 0, 'm_peer1');
      const r2 = store.validate(Date.now(), randomNonce(), 1, 'm_peer1');
      const r3 = store.validate(Date.now(), randomNonce(), 2, 'm_peer1');
      expect(r1.valid).toBe(true);
      expect(r2.valid).toBe(true);
      expect(r3.valid).toBe(true);
    });

    it('rejects same sequence number (replay)', () => {
      store.validate(Date.now(), randomNonce(), 5, 'm_peer1');
      const result = store.validate(Date.now(), randomNonce(), 5, 'm_peer1');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('Sequence');
      }
    });

    it('rejects lower sequence number', () => {
      store.validate(Date.now(), randomNonce(), 10, 'm_peer1');
      const result = store.validate(Date.now(), randomNonce(), 5, 'm_peer1');
      expect(result.valid).toBe(false);
    });

    it('accepts gaps in sequence (non-consecutive is fine)', () => {
      store.validate(Date.now(), randomNonce(), 0, 'm_peer1');
      const result = store.validate(Date.now(), randomNonce(), 100, 'm_peer1');
      expect(result.valid).toBe(true);
    });

    it('tracks sequences independently per peer', () => {
      store.validate(Date.now(), randomNonce(), 10, 'm_peer1');
      const result = store.validate(Date.now(), randomNonce(), 0, 'm_peer2');
      expect(result.valid).toBe(true); // peer2's sequence starts fresh
    });
  });

  // ── getNextSequence ──────────────────────────────────────────────

  describe('getNextSequence', () => {
    it('returns 0 for unknown peer', () => {
      expect(store.getNextSequence('m_unknown')).toBe(0);
    });

    it('returns last seen + 1', () => {
      store.validate(Date.now(), randomNonce(), 42, 'm_peer1');
      expect(store.getNextSequence('m_peer1')).toBe(43);
    });
  });

  // ── Persistence ──────────────────────────────────────────────────

  describe('persistence', () => {
    it('nonces survive server restart', () => {
      const nonce = randomNonce();
      store.validate(Date.now(), nonce, 0, 'm_peer1');
      store.destroy();

      // New instance
      const store2 = new NonceStore(tmpDir);
      const result = store2.validate(Date.now(), nonce, 1, 'm_peer1');
      expect(result.valid).toBe(false); // nonce already seen
      store2.destroy();
    });

    it('nonce file is created', () => {
      store.validate(Date.now(), randomNonce(), 0, 'm_peer1');
      expect(fs.existsSync(path.join(tmpDir, 'nonces.jsonl'))).toBe(true);
    });
  });

  // ── Pruning ──────────────────────────────────────────────────────

  describe('pruning', () => {
    it('removes expired nonces on prune()', () => {
      // Write a nonce with an old timestamp directly to the file
      const filePath = path.join(tmpDir, 'nonces.jsonl');
      fs.mkdirSync(tmpDir, { recursive: true });
      const oldEntry = JSON.stringify({ nonce: 'old-nonce', timestamp: Date.now() - 120_000 });
      const freshEntry = JSON.stringify({ nonce: 'fresh-nonce', timestamp: Date.now() });
      fs.writeFileSync(filePath, oldEntry + '\n' + freshEntry + '\n');

      store.prune();

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).not.toContain('old-nonce');
      expect(content).toContain('fresh-nonce');
    });

    it('updates in-memory set after prune', () => {
      const filePath = path.join(tmpDir, 'nonces.jsonl');
      fs.mkdirSync(tmpDir, { recursive: true });
      const oldEntry = JSON.stringify({ nonce: 'prunable', timestamp: Date.now() - 120_000 });
      fs.writeFileSync(filePath, oldEntry + '\n');

      // Initialize loads the old nonce
      store.initialize();
      store.prune();

      // The nonce should no longer be in the set
      expect(store.size).toBe(0);
    });
  });

  // ── Edge Cases ───────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles non-existent state directory', () => {
      const store2 = new NonceStore(path.join(tmpDir, 'nonexistent'));
      const result = store2.validate(Date.now(), randomNonce(), 0, 'm_peer1');
      expect(result.valid).toBe(true);
      store2.destroy();
    });

    it('handles corrupt nonce file entries', () => {
      const filePath = path.join(tmpDir, 'nonces.jsonl');
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(filePath, 'not json\n{"nonce":"valid","timestamp":' + Date.now() + '}\n');

      store.initialize();
      // Should load "valid" nonce and skip corrupt line
      expect(store.size).toBe(1);
    });

    it('handles empty nonce file', () => {
      const filePath = path.join(tmpDir, 'nonces.jsonl');
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(filePath, '');

      store.initialize();
      expect(store.size).toBe(0);
    });
  });
});
