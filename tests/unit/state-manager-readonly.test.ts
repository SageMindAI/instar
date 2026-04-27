/**
 * Unit tests for StateManager read-only mode.
 *
 * Tests:
 * - Read-only mode blocks all write operations
 * - Read operations still work in read-only mode
 * - Mode can be toggled on and off
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateManager } from '../../src/core/StateManager.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-state-ro-test-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('StateManager read-only mode', () => {
  let tmpDir: string;
  let state: StateManager;

  beforeEach(() => {
    tmpDir = createTempDir();
    state = new StateManager(tmpDir);
  });

  afterEach(() => cleanup(tmpDir));

  // ── Mode toggle ────────────────────────────────────────────────

  describe('setReadOnly / readOnly', () => {
    it('starts in read-write mode', () => {
      expect(state.readOnly).toBe(false);
    });

    it('can be set to read-only', () => {
      state.setReadOnly(true);
      expect(state.readOnly).toBe(true);
    });

    it('can be toggled back to read-write', () => {
      state.setReadOnly(true);
      state.setReadOnly(false);
      expect(state.readOnly).toBe(false);
    });
  });

  // ── Write blocking ─────────────────────────────────────────────

  describe('write operations blocked in read-only', () => {
    beforeEach(() => {
      state.setReadOnly(true);
    });

    it('saveSession throws', () => {
      expect(() => state.saveSession({
        id: 'test-1',
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any)).toThrow('read-only');
    });

    it('saveJobState throws', () => {
      expect(() => state.saveJobState({
        slug: 'test-job',
        lastRun: new Date().toISOString(),
      } as any)).toThrow('read-only');
    });

    it('appendEvent throws', () => {
      expect(() => state.appendEvent({
        type: 'test',
        timestamp: new Date().toISOString(),
      } as any)).toThrow('read-only');
    });

    it('set throws', () => {
      expect(() => state.set('test-key', { foo: 'bar' })).toThrow('read-only');
    });

    it('delete throws', () => {
      expect(() => state.delete('test-key')).toThrow('read-only');
    });

    it('error message includes operation name', () => {
      expect(() => state.saveSession({
        id: 'test-1',
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any)).toThrow('saveSession');
    });

    it('error message mentions standby', () => {
      expect(() => state.set('key', 'val')).toThrow('standby');
    });
  });

  // ── Read operations still work ─────────────────────────────────

  describe('read operations work in read-only', () => {
    beforeEach(() => {
      // Write some data first (in read-write mode)
      state.set('test-data', { value: 42 });
      state.setReadOnly(true);
    });

    it('get works', () => {
      const result = state.get<{ value: number }>('test-data');
      expect(result).toEqual({ value: 42 });
    });

    it('getSession returns null for missing session', () => {
      expect(state.getSession('nonexistent')).toBeNull();
    });

    it('listSessions returns empty array', () => {
      expect(state.listSessions()).toEqual([]);
    });

    it('getJobState returns null for missing job', () => {
      expect(state.getJobState('nonexistent')).toBeNull();
    });

    it('queryEvents returns empty array', () => {
      expect(state.queryEvents({})).toEqual([]);
    });
  });

  // ── Toggle back to writable ────────────────────────────────────

  describe('recovery from read-only', () => {
    it('writes work again after disabling read-only', () => {
      state.setReadOnly(true);
      expect(() => state.set('key', 'val')).toThrow('read-only');

      state.setReadOnly(false);
      state.set('key', 'val');
      expect(state.get<string>('key')).toBe('val');
    });
  });
});
