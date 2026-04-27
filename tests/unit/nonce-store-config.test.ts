/**
 * Unit tests for NonceStore configurable parameters (Phase 4A).
 *
 * Tests the new NonceStoreConfig feature that allows custom
 * timestamp windows, nonce max age, and prune intervals.
 * This enables different security profiles for different use cases
 * (e.g., tight 30s for HTTP auth vs 5min for AgentBus).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { NonceStore } from '../../src/core/NonceStore.js';
import type { NonceStoreConfig } from '../../src/core/NonceStore.js';

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nonce-config-'));
}

function randomNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

describe('NonceStore configurable parameters', () => {
  let tmpDir: string;
  let store: NonceStore;

  beforeEach(() => {
    tmpDir = freshDir();
  });

  afterEach(() => {
    store?.destroy();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Timestamp Window Configuration ──────────────────────────────

  describe('custom timestampWindowMs', () => {
    it('default 30s window: accepts 20s-old timestamp', () => {
      store = new NonceStore(tmpDir); // Default config
      const ts = new Date(Date.now() - 20_000).toISOString();
      const result = store.validate(ts, randomNonce(), 0, 'peer1');
      expect(result.valid).toBe(true);
    });

    it('default 30s window: rejects 45s-old timestamp', () => {
      store = new NonceStore(tmpDir); // Default config
      const ts = new Date(Date.now() - 45_000).toISOString();
      const result = store.validate(ts, randomNonce(), 0, 'peer1');
      expect(result.valid).toBe(false);
    });

    it('5-minute window: accepts 3-minute-old timestamp', () => {
      store = new NonceStore(tmpDir, { timestampWindowMs: 5 * 60_000 });
      const ts = new Date(Date.now() - 3 * 60_000).toISOString();
      const result = store.validate(ts, randomNonce(), 0, 'peer1');
      expect(result.valid).toBe(true);
    });

    it('5-minute window: rejects 6-minute-old timestamp', () => {
      store = new NonceStore(tmpDir, { timestampWindowMs: 5 * 60_000 });
      const ts = new Date(Date.now() - 6 * 60_000).toISOString();
      const result = store.validate(ts, randomNonce(), 0, 'peer1');
      expect(result.valid).toBe(false);
    });

    it('10-second window: rejects 15-second-old timestamp', () => {
      store = new NonceStore(tmpDir, { timestampWindowMs: 10_000 });
      const ts = new Date(Date.now() - 15_000).toISOString();
      const result = store.validate(ts, randomNonce(), 0, 'peer1');
      expect(result.valid).toBe(false);
    });

    it('error message includes configured window', () => {
      store = new NonceStore(tmpDir, { timestampWindowMs: 5 * 60_000 });
      const ts = new Date(Date.now() - 10 * 60_000).toISOString();
      const result = store.validate(ts, randomNonce(), 0, 'peer1');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('300s window'); // 5 minutes = 300s
      }
    });
  });

  // ── Nonce Max Age Configuration ─────────────────────────────────

  describe('custom nonceMaxAgeMs', () => {
    it('prunes nonces older than custom max age', () => {
      store = new NonceStore(tmpDir, { nonceMaxAgeMs: 5_000 }); // 5 seconds

      // Write an "old" nonce entry (10s ago) directly to disk
      const filePath = path.join(tmpDir, 'nonces.jsonl');
      fs.mkdirSync(tmpDir, { recursive: true });
      const oldEntry = JSON.stringify({ nonce: 'old-nonce', timestamp: Date.now() - 10_000 });
      const freshEntry = JSON.stringify({ nonce: 'fresh-nonce', timestamp: Date.now() });
      fs.writeFileSync(filePath, oldEntry + '\n' + freshEntry + '\n');

      store.prune();

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).not.toContain('old-nonce');
      expect(content).toContain('fresh-nonce');
    });

    it('retains nonces within custom max age', () => {
      store = new NonceStore(tmpDir, { nonceMaxAgeMs: 60_000 }); // 60 seconds

      // Write a "recent" nonce entry (5s ago)
      const filePath = path.join(tmpDir, 'nonces.jsonl');
      fs.mkdirSync(tmpDir, { recursive: true });
      const recentEntry = JSON.stringify({ nonce: 'recent-nonce', timestamp: Date.now() - 5_000 });
      fs.writeFileSync(filePath, recentEntry + '\n');

      store.prune();

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('recent-nonce');
    });
  });

  // ── Config Defaults ─────────────────────────────────────────────

  describe('config defaults', () => {
    it('no config uses 30s timestamp window', () => {
      store = new NonceStore(tmpDir);
      // 25s old — within 30s
      const ts25 = new Date(Date.now() - 25_000).toISOString();
      expect(store.validate(ts25, randomNonce(), 0, 'peer1').valid).toBe(true);

      // 35s old — outside 30s
      const ts35 = new Date(Date.now() - 35_000).toISOString();
      expect(store.validate(ts35, randomNonce(), 1, 'peer1').valid).toBe(false);
    });

    it('empty config object uses defaults', () => {
      store = new NonceStore(tmpDir, {});
      // Should behave identically to no config
      const ts25 = new Date(Date.now() - 25_000).toISOString();
      expect(store.validate(ts25, randomNonce(), 0, 'peer1').valid).toBe(true);
    });

    it('partial config only overrides specified fields', () => {
      // Only override timestampWindowMs, leave nonceMaxAgeMs as default
      store = new NonceStore(tmpDir, { timestampWindowMs: 5 * 60_000 });

      // 3-minute-old timestamp should be valid with 5min window
      const ts3m = new Date(Date.now() - 3 * 60_000).toISOString();
      expect(store.validate(ts3m, randomNonce(), 0, 'peer1').valid).toBe(true);
    });
  });

  // ── AgentBus-Specific Configuration ─────────────────────────────

  describe('AgentBus configuration profile (5-minute window)', () => {
    it('5-minute window accepts messages delayed by git sync', () => {
      // Simulates the AgentBus use case where JSONL messages
      // may be delayed by git sync operations (1-3 minutes typical)
      store = new NonceStore(tmpDir, {
        timestampWindowMs: 5 * 60_000,
        nonceMaxAgeMs: 10 * 60_000, // 2x window
      });

      const delayedTimestamp = new Date(Date.now() - 2 * 60_000).toISOString(); // 2 min delay
      const result = store.validate(delayedTimestamp, randomNonce(), 0, 'remote-machine');
      expect(result.valid).toBe(true);
    });

    it('5-minute window rejects captured messages from 10 minutes ago', () => {
      store = new NonceStore(tmpDir, {
        timestampWindowMs: 5 * 60_000,
        nonceMaxAgeMs: 10 * 60_000,
      });

      const capturedTimestamp = new Date(Date.now() - 10 * 60_000).toISOString();
      const result = store.validate(capturedTimestamp, randomNonce(), 0, 'attacker');
      expect(result.valid).toBe(false);
    });
  });
});
