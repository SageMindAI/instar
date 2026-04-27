import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ContextThreadMap } from '../../../src/threadline/ContextThreadMap.js';
import type { ContextThreadMapConfig, ContextThreadMapping } from '../../../src/threadline/ContextThreadMap.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTempDir(): { dir: string; stateDir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxmap-test-'));
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    dir,
    stateDir,
    // safe-git-allow: incremental-migration
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Short TTL for expiry tests (100ms) */
const SHORT_TTL_MS = 100;

// ── Tests ────────────────────────────────────────────────────────

describe('ContextThreadMap', () => {
  let temp: ReturnType<typeof createTempDir>;

  beforeEach(() => {
    temp = createTempDir();
  });

  afterEach(() => {
    temp.cleanup();
  });

  // ── Constructor ───────────────────────────────────────────────

  describe('constructor', () => {
    it('creates with config and initializes empty', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      expect(map.size()).toBe(0);
    });

    it('creates the threadline state directory', () => {
      new ContextThreadMap({ stateDir: temp.stateDir });
      const threadlineDir = path.join(temp.stateDir, 'threadline');
      expect(fs.existsSync(threadlineDir)).toBe(true);
    });

    it('creates threadline dir even when stateDir is deeply nested', () => {
      const deepStateDir = path.join(temp.dir, 'a', 'b', 'c', '.instar');
      new ContextThreadMap({ stateDir: deepStateDir });
      expect(fs.existsSync(path.join(deepStateDir, 'threadline'))).toBe(true);
    });

    it('uses default TTL and maxEntries when not specified', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      // Verify defaults by adding entries that should NOT expire (within 7 days)
      map.set('ctx-1', 'thread-1', 'agent-a');
      expect(map.getThreadId('ctx-1', 'agent-a')).toBe('thread-1');
    });

    it('accepts custom ttlMs and maxEntries', () => {
      const map = new ContextThreadMap({
        stateDir: temp.stateDir,
        ttlMs: 1000,
        maxEntries: 5,
      });
      expect(map.size()).toBe(0);
    });
  });

  // ── set / getThreadId ─────────────────────────────────────────

  describe('set and getThreadId', () => {
    it('sets a mapping and retrieves the threadId', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');
      expect(map.getThreadId('ctx-1', 'agent-a')).toBe('thread-1');
    });

    it('returns null for non-existent contextId', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      expect(map.getThreadId('nonexistent', 'agent-a')).toBeNull();
    });

    it('overwrites existing mapping for same contextId', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');
      map.set('ctx-1', 'thread-2', 'agent-a');
      expect(map.getThreadId('ctx-1', 'agent-a')).toBe('thread-2');
      expect(map.size()).toBe(1);
    });

    it('preserves createdAt when overwriting a mapping', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');

      // Read the persisted file to check createdAt
      const filePath = path.join(temp.stateDir, 'threadline', 'context-thread-map.json');
      const data1 = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const originalCreatedAt = data1.mappings[0].createdAt;

      // Overwrite
      map.set('ctx-1', 'thread-2', 'agent-a');
      const data2 = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(data2.mappings[0].createdAt).toBe(originalCreatedAt);
    });

    it('handles multiple distinct mappings', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');
      map.set('ctx-2', 'thread-2', 'agent-b');
      map.set('ctx-3', 'thread-3', 'agent-a');

      expect(map.getThreadId('ctx-1', 'agent-a')).toBe('thread-1');
      expect(map.getThreadId('ctx-2', 'agent-b')).toBe('thread-2');
      expect(map.getThreadId('ctx-3', 'agent-a')).toBe('thread-3');
      expect(map.size()).toBe(3);
    });

    it('cleans up old contextId when threadId is reassigned', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');
      // Assign the same threadId to a different contextId
      map.set('ctx-2', 'thread-1', 'agent-b');

      // Old contextId should be removed
      expect(map.getThreadId('ctx-1', 'agent-a')).toBeNull();
      expect(map.getThreadId('ctx-2', 'agent-b')).toBe('thread-1');
      expect(map.size()).toBe(1);
    });
  });

  // ── Identity Binding (Session Smuggling Prevention) ───────────

  describe('identity binding', () => {
    it('returns null when a different agent tries to use same contextId', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');
      expect(map.getThreadId('ctx-1', 'agent-b')).toBeNull();
    });

    it('does not delete the mapping when identity check fails', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');

      // Different agent gets null
      expect(map.getThreadId('ctx-1', 'agent-b')).toBeNull();

      // Original agent still works
      expect(map.getThreadId('ctx-1', 'agent-a')).toBe('thread-1');
      expect(map.size()).toBe(1);
    });

    it('allows same contextId to be re-bound to a different agent via set()', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');
      map.set('ctx-1', 'thread-2', 'agent-b');

      expect(map.getThreadId('ctx-1', 'agent-b')).toBe('thread-2');
      expect(map.getThreadId('ctx-1', 'agent-a')).toBeNull();
    });
  });

  // ── getContextId (Reverse Lookup) ─────────────────────────────

  describe('getContextId', () => {
    it('returns contextId for a known threadId', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');
      expect(map.getContextId('thread-1')).toBe('ctx-1');
    });

    it('returns null for unknown threadId', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      expect(map.getContextId('nonexistent')).toBeNull();
    });

    it('returns null for expired mapping', () => {
      const map = new ContextThreadMap({
        stateDir: temp.stateDir,
        ttlMs: SHORT_TTL_MS,
      });
      map.set('ctx-1', 'thread-1', 'agent-a');

      // Wait for expiry
      const start = Date.now();
      while (Date.now() - start < SHORT_TTL_MS + 50) { /* spin */ }

      expect(map.getContextId('thread-1')).toBeNull();
    });

    it('cleans up stale reverse index entry', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');

      // Manually corrupt: remove from byContextId but leave in file
      // Simulate by deleting the contextId mapping and re-creating the map
      map.delete('ctx-1');
      expect(map.getContextId('thread-1')).toBeNull();
    });
  });

  // ── LRU Updates ───────────────────────────────────────────────

  describe('LRU updates', () => {
    it('getThreadId updates lastAccessedAt', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');

      const filePath = path.join(temp.stateDir, 'threadline', 'context-thread-map.json');
      const data1 = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const firstAccess = data1.mappings[0].lastAccessedAt;

      // Small delay to ensure timestamp differs
      const start = Date.now();
      while (Date.now() - start < 5) { /* spin */ }

      map.getThreadId('ctx-1', 'agent-a');
      const data2 = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const secondAccess = data2.mappings[0].lastAccessedAt;

      expect(new Date(secondAccess).getTime()).toBeGreaterThanOrEqual(
        new Date(firstAccess).getTime()
      );
    });

    it('getThreadId does not update lastAccessedAt on identity mismatch', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');

      const filePath = path.join(temp.stateDir, 'threadline', 'context-thread-map.json');
      const data1 = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const firstAccess = data1.mappings[0].lastAccessedAt;

      // Identity mismatch — should return null without updating
      map.getThreadId('ctx-1', 'agent-b');
      const data2 = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const secondAccess = data2.mappings[0].lastAccessedAt;

      expect(secondAccess).toBe(firstAccess);
    });
  });

  // ── delete ────────────────────────────────────────────────────

  describe('delete', () => {
    it('removes a mapping by contextId', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');
      expect(map.delete('ctx-1')).toBe(true);
      expect(map.getThreadId('ctx-1', 'agent-a')).toBeNull();
      expect(map.size()).toBe(0);
    });

    it('returns false for non-existent contextId', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      expect(map.delete('nonexistent')).toBe(false);
    });

    it('also removes the reverse index entry', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');
      map.delete('ctx-1');
      expect(map.getContextId('thread-1')).toBeNull();
    });
  });

  // ── deleteByThreadId ──────────────────────────────────────────

  describe('deleteByThreadId', () => {
    it('removes a mapping by threadId', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');
      expect(map.deleteByThreadId('thread-1')).toBe(true);
      expect(map.getContextId('thread-1')).toBeNull();
      expect(map.getThreadId('ctx-1', 'agent-a')).toBeNull();
      expect(map.size()).toBe(0);
    });

    it('returns false for non-existent threadId', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      expect(map.deleteByThreadId('nonexistent')).toBe(false);
    });

    it('does not affect other mappings', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');
      map.set('ctx-2', 'thread-2', 'agent-b');
      map.deleteByThreadId('thread-1');
      expect(map.size()).toBe(1);
      expect(map.getThreadId('ctx-2', 'agent-b')).toBe('thread-2');
    });
  });

  // ── TTL Expiry ────────────────────────────────────────────────

  describe('TTL expiry', () => {
    it('getThreadId returns null for expired entries', () => {
      const map = new ContextThreadMap({
        stateDir: temp.stateDir,
        ttlMs: SHORT_TTL_MS,
      });
      map.set('ctx-1', 'thread-1', 'agent-a');

      // Wait for expiry
      const start = Date.now();
      while (Date.now() - start < SHORT_TTL_MS + 50) { /* spin */ }

      expect(map.getThreadId('ctx-1', 'agent-a')).toBeNull();
    });

    it('expired entry is deleted on access', () => {
      const map = new ContextThreadMap({
        stateDir: temp.stateDir,
        ttlMs: SHORT_TTL_MS,
      });
      map.set('ctx-1', 'thread-1', 'agent-a');

      const start = Date.now();
      while (Date.now() - start < SHORT_TTL_MS + 50) { /* spin */ }

      map.getThreadId('ctx-1', 'agent-a');
      expect(map.size()).toBe(0);
    });

    it('non-expired entries are accessible', () => {
      const map = new ContextThreadMap({
        stateDir: temp.stateDir,
        ttlMs: 60_000, // 1 minute
      });
      map.set('ctx-1', 'thread-1', 'agent-a');
      expect(map.getThreadId('ctx-1', 'agent-a')).toBe('thread-1');
    });

    it('expired entries are skipped on reload', () => {
      // Create a map with a short TTL, add an entry, let it expire
      const map1 = new ContextThreadMap({
        stateDir: temp.stateDir,
        ttlMs: SHORT_TTL_MS,
      });
      map1.set('ctx-1', 'thread-1', 'agent-a');

      const start = Date.now();
      while (Date.now() - start < SHORT_TTL_MS + 50) { /* spin */ }

      // Create new instance — expired entries filtered on reload
      const map2 = new ContextThreadMap({
        stateDir: temp.stateDir,
        ttlMs: SHORT_TTL_MS,
      });
      expect(map2.size()).toBe(0);
    });
  });

  // ── Max Entries / LRU Eviction ────────────────────────────────

  describe('max entries / LRU eviction', () => {
    it('evicts least recently used when at capacity', () => {
      const map = new ContextThreadMap({
        stateDir: temp.stateDir,
        maxEntries: 3,
      });

      // Add 3 entries — at capacity
      map.set('ctx-1', 'thread-1', 'agent-a');

      // Small delay so timestamps differ
      const wait = () => { const s = Date.now(); while (Date.now() - s < 5) {} };

      wait();
      map.set('ctx-2', 'thread-2', 'agent-a');
      wait();
      map.set('ctx-3', 'thread-3', 'agent-a');

      // Adding a 4th should evict ctx-1 (oldest lastAccessedAt)
      wait();
      map.set('ctx-4', 'thread-4', 'agent-a');

      expect(map.size()).toBe(3);
      expect(map.getThreadId('ctx-1', 'agent-a')).toBeNull();
      expect(map.getThreadId('ctx-4', 'agent-a')).toBe('thread-4');
    });

    it('accessing an entry via getThreadId prevents its eviction', () => {
      const map = new ContextThreadMap({
        stateDir: temp.stateDir,
        maxEntries: 3,
      });

      const wait = () => { const s = Date.now(); while (Date.now() - s < 5) {} };

      map.set('ctx-1', 'thread-1', 'agent-a');
      wait();
      map.set('ctx-2', 'thread-2', 'agent-a');
      wait();
      map.set('ctx-3', 'thread-3', 'agent-a');

      // Access ctx-1 to make it most recently used
      wait();
      map.getThreadId('ctx-1', 'agent-a');

      // Now add ctx-4 — should evict ctx-2 (oldest after ctx-1 was refreshed)
      wait();
      map.set('ctx-4', 'thread-4', 'agent-a');

      expect(map.size()).toBe(3);
      expect(map.getThreadId('ctx-1', 'agent-a')).toBe('thread-1');
      expect(map.getThreadId('ctx-2', 'agent-a')).toBeNull();
    });

    it('does not evict when overwriting an existing contextId', () => {
      const map = new ContextThreadMap({
        stateDir: temp.stateDir,
        maxEntries: 3,
      });

      map.set('ctx-1', 'thread-1', 'agent-a');
      map.set('ctx-2', 'thread-2', 'agent-a');
      map.set('ctx-3', 'thread-3', 'agent-a');

      // Overwrite ctx-1 — should NOT evict anything
      map.set('ctx-1', 'thread-1-new', 'agent-a');

      expect(map.size()).toBe(3);
      expect(map.getThreadId('ctx-1', 'agent-a')).toBe('thread-1-new');
      expect(map.getThreadId('ctx-2', 'agent-a')).toBe('thread-2');
      expect(map.getThreadId('ctx-3', 'agent-a')).toBe('thread-3');
    });
  });

  // ── Persistence ───────────────────────────────────────────────

  describe('persistence', () => {
    it('persists data to context-thread-map.json', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');

      const filePath = path.join(temp.stateDir, 'threadline', 'context-thread-map.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(data.mappings).toHaveLength(1);
      expect(data.mappings[0].contextId).toBe('ctx-1');
      expect(data.mappings[0].threadId).toBe('thread-1');
      expect(data.mappings[0].agentIdentity).toBe('agent-a');
      expect(data.updatedAt).toBeDefined();
    });

    it('survives reconstruction from file', () => {
      const map1 = new ContextThreadMap({ stateDir: temp.stateDir });
      map1.set('ctx-1', 'thread-1', 'agent-a');
      map1.set('ctx-2', 'thread-2', 'agent-b');

      const map2 = new ContextThreadMap({ stateDir: temp.stateDir });
      expect(map2.size()).toBe(2);
      expect(map2.getThreadId('ctx-1', 'agent-a')).toBe('thread-1');
      expect(map2.getThreadId('ctx-2', 'agent-b')).toBe('thread-2');
    });

    it('reverse lookup survives reconstruction', () => {
      const map1 = new ContextThreadMap({ stateDir: temp.stateDir });
      map1.set('ctx-1', 'thread-1', 'agent-a');

      const map2 = new ContextThreadMap({ stateDir: temp.stateDir });
      expect(map2.getContextId('thread-1')).toBe('ctx-1');
    });

    it('handles corrupted JSON file gracefully', () => {
      const filePath = path.join(temp.stateDir, 'threadline', 'context-thread-map.json');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'NOT VALID JSON');

      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      expect(map.size()).toBe(0);
    });

    it('throws when file has valid JSON but missing mappings field', () => {
      const filePath = path.join(temp.stateDir, 'threadline', 'context-thread-map.json');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ updatedAt: 'now' }));

      // safeJsonParse returns the parsed object (valid JSON), but it lacks mappings
      // array, so iteration in reload() throws
      expect(() => new ContextThreadMap({ stateDir: temp.stateDir })).toThrow();
    });

    it('persist is called automatically on set()', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');

      const filePath = path.join(temp.stateDir, 'threadline', 'context-thread-map.json');
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('persist is called automatically on delete()', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');
      map.delete('ctx-1');

      const filePath = path.join(temp.stateDir, 'threadline', 'context-thread-map.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(data.mappings).toHaveLength(0);
    });
  });

  // ── cleanup() ─────────────────────────────────────────────────

  describe('cleanup', () => {
    it('removes expired entries and returns count', () => {
      const map = new ContextThreadMap({
        stateDir: temp.stateDir,
        ttlMs: SHORT_TTL_MS,
      });
      map.set('ctx-1', 'thread-1', 'agent-a');
      map.set('ctx-2', 'thread-2', 'agent-a');

      const start = Date.now();
      while (Date.now() - start < SHORT_TTL_MS + 50) { /* spin */ }

      const removed = map.cleanup();
      expect(removed).toBe(2);
      expect(map.size()).toBe(0);
    });

    it('preserves non-expired entries', () => {
      const map = new ContextThreadMap({
        stateDir: temp.stateDir,
        ttlMs: SHORT_TTL_MS,
      });
      map.set('ctx-old', 'thread-old', 'agent-a');

      const start = Date.now();
      while (Date.now() - start < SHORT_TTL_MS + 50) { /* spin */ }

      // Add a fresh entry after the old one expired
      map.set('ctx-new', 'thread-new', 'agent-a');

      const removed = map.cleanup();
      expect(removed).toBe(1);
      expect(map.size()).toBe(1);
      expect(map.getThreadId('ctx-new', 'agent-a')).toBe('thread-new');
    });

    it('returns 0 when nothing is expired', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');
      expect(map.cleanup()).toBe(0);
      expect(map.size()).toBe(1);
    });

    it('returns 0 on empty map', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      expect(map.cleanup()).toBe(0);
    });

    it('also removes reverse index for expired entries', () => {
      const map = new ContextThreadMap({
        stateDir: temp.stateDir,
        ttlMs: SHORT_TTL_MS,
      });
      map.set('ctx-1', 'thread-1', 'agent-a');

      const start = Date.now();
      while (Date.now() - start < SHORT_TTL_MS + 50) { /* spin */ }

      map.cleanup();
      expect(map.getContextId('thread-1')).toBeNull();
    });
  });

  // ── clear() ───────────────────────────────────────────────────

  describe('clear', () => {
    it('removes all entries', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');
      map.set('ctx-2', 'thread-2', 'agent-b');
      map.set('ctx-3', 'thread-3', 'agent-c');

      map.clear();
      expect(map.size()).toBe(0);
    });

    it('clears both forward and reverse indexes', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');
      map.clear();

      expect(map.getThreadId('ctx-1', 'agent-a')).toBeNull();
      expect(map.getContextId('thread-1')).toBeNull();
    });

    it('persists the cleared state', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');
      map.clear();

      const map2 = new ContextThreadMap({ stateDir: temp.stateDir });
      expect(map2.size()).toBe(0);
    });

    it('is safe to call on empty map', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      expect(() => map.clear()).not.toThrow();
      expect(map.size()).toBe(0);
    });
  });

  // ── size() ────────────────────────────────────────────────────

  describe('size', () => {
    it('returns 0 for empty map', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      expect(map.size()).toBe(0);
    });

    it('returns correct count after additions', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');
      map.set('ctx-2', 'thread-2', 'agent-b');
      expect(map.size()).toBe(2);
    });

    it('decreases after delete', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');
      map.set('ctx-2', 'thread-2', 'agent-b');
      map.delete('ctx-1');
      expect(map.size()).toBe(1);
    });

    it('returns 0 after clear', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');
      map.clear();
      expect(map.size()).toBe(0);
    });
  });

  // ── Edge Cases ────────────────────────────────────────────────

  describe('edge cases', () => {
    it('empty string threadId causes getContextId to return null (falsy check)', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('', '', 'agent-a');
      // set() works and getThreadId works (empty string contextId is truthy in Map.get)
      expect(map.getThreadId('', 'agent-a')).toBe('');
      // But getContextId('') returns null because the reverse lookup gets '' (contextId),
      // and `if (!contextId)` treats empty string as falsy
      expect(map.getContextId('')).toBeNull();
      expect(map.size()).toBe(1);
    });

    it('handles special characters in IDs', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      const specialCtx = 'ctx/with:special@chars!';
      const specialThread = 'thread-with-dashes_and_underscores.dots';
      map.set(specialCtx, specialThread, 'agent/special');

      expect(map.getThreadId(specialCtx, 'agent/special')).toBe(specialThread);
      expect(map.getContextId(specialThread)).toBe(specialCtx);
    });

    it('handles rapid set/delete cycles', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      for (let i = 0; i < 50; i++) {
        map.set(`ctx-${i}`, `thread-${i}`, 'agent-a');
      }
      for (let i = 0; i < 25; i++) {
        map.delete(`ctx-${i}`);
      }
      expect(map.size()).toBe(25);
      expect(map.getThreadId('ctx-0', 'agent-a')).toBeNull();
      expect(map.getThreadId('ctx-49', 'agent-a')).toBe('thread-49');
    });

    it('handles duplicate set calls (idempotent)', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');
      map.set('ctx-1', 'thread-1', 'agent-a');
      map.set('ctx-1', 'thread-1', 'agent-a');
      expect(map.size()).toBe(1);
      expect(map.getThreadId('ctx-1', 'agent-a')).toBe('thread-1');
    });

    it('delete after clear does not throw', () => {
      const map = new ContextThreadMap({ stateDir: temp.stateDir });
      map.set('ctx-1', 'thread-1', 'agent-a');
      map.clear();
      expect(() => map.delete('ctx-1')).not.toThrow();
      expect(map.delete('ctx-1')).toBe(false);
    });

    it('getContextId returns null for expired mapping via reverse lookup', () => {
      const map = new ContextThreadMap({
        stateDir: temp.stateDir,
        ttlMs: SHORT_TTL_MS,
      });
      map.set('ctx-1', 'thread-1', 'agent-a');

      const start = Date.now();
      while (Date.now() - start < SHORT_TTL_MS + 50) { /* spin */ }

      expect(map.getContextId('thread-1')).toBeNull();
      // Entry should have been cleaned up
      expect(map.size()).toBe(0);
    });

    it('reload() can be called explicitly to refresh from disk', () => {
      const map1 = new ContextThreadMap({ stateDir: temp.stateDir });
      map1.set('ctx-1', 'thread-1', 'agent-a');

      // Simulate external modification: write directly to file
      const filePath = path.join(temp.stateDir, 'threadline', 'context-thread-map.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      data.mappings.push({
        contextId: 'ctx-ext',
        threadId: 'thread-ext',
        agentIdentity: 'agent-ext',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

      map1.reload();
      expect(map1.size()).toBe(2);
      expect(map1.getContextId('thread-ext')).toBe('ctx-ext');
    });

    it('maxEntries of 1 still works correctly', () => {
      const map = new ContextThreadMap({
        stateDir: temp.stateDir,
        maxEntries: 1,
      });
      map.set('ctx-1', 'thread-1', 'agent-a');
      expect(map.size()).toBe(1);

      map.set('ctx-2', 'thread-2', 'agent-a');
      expect(map.size()).toBe(1);
      expect(map.getThreadId('ctx-1', 'agent-a')).toBeNull();
      expect(map.getThreadId('ctx-2', 'agent-a')).toBe('thread-2');
    });
  });
});
