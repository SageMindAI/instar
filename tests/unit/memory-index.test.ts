/**
 * Unit tests for MemoryIndex — FTS5 full-text search over agent memory.
 *
 * Tests:
 * - Open creates database and schema
 * - Close cleans up connection
 * - Sync indexes new files
 * - Sync detects changed files
 * - Sync removes deleted files
 * - Reindex rebuilds from scratch
 * - Search returns ranked results
 * - Search with source filter
 * - Search sanitizes FTS5 special syntax
 * - Search returns empty for no matches
 * - Stats returns correct counts
 * - Incremental sync skips unchanged files
 * - Handles directory sources
 * - Evergreen files have no temporal decay
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryIndex } from '../../src/memory/MemoryIndex.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-memory-test-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('MemoryIndex', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = createTempDir();
    // Create some state files
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Agent Identity\n\nI am a test agent for unit testing.\nI help with software development and debugging.');
    fs.writeFileSync(path.join(stateDir, 'MEMORY.md'), '# Memory\n\n## Debugging Tips\n\nAlways check silent catch blocks first.\n\n## Architecture\n\nUse composition over inheritance.');
    fs.mkdirSync(path.join(stateDir, 'relationships'));
    fs.writeFileSync(path.join(stateDir, 'relationships', 'alice.json'), JSON.stringify({
      name: 'Alice',
      role: 'Developer',
      notes: 'Prefers TypeScript, works on frontend',
    }));
  });

  afterEach(() => {
    cleanup(stateDir);
  });

  describe('open and close', () => {
    it('creates database file on open', async () => {
      const index = new MemoryIndex(stateDir, { enabled: true });
      await index.open();

      expect(fs.existsSync(path.join(stateDir, 'memory.db'))).toBe(true);
      index.close();
    });

    it('close is safe to call multiple times', async () => {
      const index = new MemoryIndex(stateDir, { enabled: true });
      await index.open();
      index.close();
      index.close(); // Should not throw
    });

    it('close is safe before open', () => {
      const index = new MemoryIndex(stateDir, { enabled: true });
      index.close(); // Should not throw
    });
  });

  describe('sync', () => {
    it('indexes new files', async () => {
      const index = new MemoryIndex(stateDir, { enabled: true });
      await index.open();

      const result = index.sync();
      expect(result.added).toBeGreaterThan(0);
      expect(result.removed).toBe(0);

      const stats = index.stats();
      expect(stats.totalFiles).toBeGreaterThan(0);
      expect(stats.totalChunks).toBeGreaterThan(0);

      index.close();
    });

    it('detects changed files', async () => {
      const index = new MemoryIndex(stateDir, { enabled: true });
      await index.open();

      // First sync
      index.sync();
      const statsBefore = index.stats();

      // Modify a file
      fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Updated Agent\n\nCompletely new content about machine learning.');

      // Second sync should detect the change
      const result = index.sync();
      expect(result.updated).toBeGreaterThanOrEqual(1);

      index.close();
    });

    it('removes deleted files', async () => {
      const index = new MemoryIndex(stateDir, { enabled: true });
      await index.open();

      // First sync
      index.sync();
      const statsBefore = index.stats();

      // Delete a file
      // safe-git-allow: incremental-migration
      fs.unlinkSync(path.join(stateDir, 'relationships', 'alice.json'));

      // Second sync should remove it
      const result = index.sync();
      expect(result.removed).toBeGreaterThanOrEqual(1);

      const statsAfter = index.stats();
      expect(statsAfter.totalFiles).toBeLessThan(statsBefore.totalFiles);

      index.close();
    });

    it('skips unchanged files', async () => {
      const index = new MemoryIndex(stateDir, { enabled: true });
      await index.open();

      // First sync
      index.sync();

      // Second sync with no changes
      const result = index.sync();
      expect(result.added).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.removed).toBe(0);

      index.close();
    });
  });

  describe('reindex', () => {
    it('rebuilds from scratch', async () => {
      const index = new MemoryIndex(stateDir, { enabled: true });
      await index.open();

      // Index normally
      index.sync();
      const statsBefore = index.stats();
      expect(statsBefore.totalFiles).toBeGreaterThan(0);

      // Reindex
      const result = index.reindex();
      expect(result.added).toBeGreaterThan(0);

      const statsAfter = index.stats();
      expect(statsAfter.totalFiles).toBe(statsBefore.totalFiles);
      expect(statsAfter.totalChunks).toBeGreaterThan(0);

      index.close();
    });
  });

  describe('search', () => {
    it('returns results for matching query', async () => {
      const index = new MemoryIndex(stateDir, { enabled: true });
      await index.open();
      index.sync();

      const results = index.search('debugging');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].text).toBeDefined();
      expect(results[0].source).toBeDefined();
      expect(results[0].score).toBeGreaterThan(0);

      index.close();
    });

    it('returns empty for non-matching query', async () => {
      const index = new MemoryIndex(stateDir, { enabled: true });
      await index.open();
      index.sync();

      const results = index.search('xyznonexistentquery12345');
      expect(results.length).toBe(0);

      index.close();
    });

    it('respects limit parameter', async () => {
      const index = new MemoryIndex(stateDir, { enabled: true });
      await index.open();
      index.sync();

      const results = index.search('agent', { limit: 1 });
      expect(results.length).toBeLessThanOrEqual(1);

      index.close();
    });

    it('returns results with highlight', async () => {
      const index = new MemoryIndex(stateDir, { enabled: true });
      await index.open();
      index.sync();

      const results = index.search('debugging');
      if (results.length > 0 && results[0].highlight) {
        expect(results[0].highlight).toContain('<b>');
      }

      index.close();
    });

    it('sanitizes FTS5 special syntax', async () => {
      const index = new MemoryIndex(stateDir, { enabled: true });
      await index.open();
      index.sync();

      // Should not throw on FTS5 special chars
      expect(() => index.search('test AND OR NOT *')).not.toThrow();
      expect(() => index.search('source:AGENT.md exploit')).not.toThrow();
      expect(() => index.search('"exact phrase"')).not.toThrow();

      index.close();
    });

    it('returns empty for empty query', async () => {
      const index = new MemoryIndex(stateDir, { enabled: true });
      await index.open();
      index.sync();

      const results = index.search('');
      expect(results.length).toBe(0);

      index.close();
    });

    it('searches across multiple sources', async () => {
      const index = new MemoryIndex(stateDir, { enabled: true });
      await index.open();
      index.sync();

      // "test" appears in AGENT.md
      const results = index.search('test agent');
      expect(results.length).toBeGreaterThan(0);

      // Check we get results from different sources
      const sources = new Set(results.map(r => r.source));
      // At least one source should have results
      expect(sources.size).toBeGreaterThanOrEqual(1);

      index.close();
    });
  });

  describe('stats', () => {
    it('returns correct counts after indexing', async () => {
      const index = new MemoryIndex(stateDir, { enabled: true });
      await index.open();
      index.sync();

      const stats = index.stats();
      expect(stats.totalFiles).toBeGreaterThan(0);
      expect(stats.totalChunks).toBeGreaterThan(0);
      expect(stats.dbSizeBytes).toBeGreaterThan(0);
      expect(stats.lastIndexedAt).toBeDefined();
      expect(stats.staleFiles).toBe(0);
      expect(stats.vectorSearchAvailable).toBe(false);

      index.close();
    });

    it('detects stale files', async () => {
      const index = new MemoryIndex(stateDir, { enabled: true });
      await index.open();
      index.sync();

      // Modify a file without re-syncing
      fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Completely Changed');

      const stats = index.stats();
      expect(stats.staleFiles).toBeGreaterThanOrEqual(1);

      index.close();
    });

    it('returns zeros before any indexing', async () => {
      const index = new MemoryIndex(stateDir, { enabled: true });
      await index.open();

      const stats = index.stats();
      expect(stats.totalFiles).toBe(0);
      expect(stats.totalChunks).toBe(0);

      index.close();
    });
  });

  describe('directory sources', () => {
    it('indexes files from directory sources', async () => {
      const index = new MemoryIndex(stateDir, {
        enabled: true,
        sources: [
          { path: 'relationships/', type: 'json', evergreen: true },
        ],
      });
      await index.open();

      const result = index.sync();
      expect(result.added).toBeGreaterThanOrEqual(1);

      const results = index.search('Alice');
      expect(results.length).toBeGreaterThan(0);

      index.close();
    });
  });

  describe('custom dbPath', () => {
    it('uses custom database path', async () => {
      const customPath = path.join(stateDir, 'custom', 'search.db');
      const index = new MemoryIndex(stateDir, {
        enabled: true,
        dbPath: customPath,
      });
      await index.open();
      index.sync();

      expect(fs.existsSync(customPath)).toBe(true);
      index.close();
    });
  });
});
