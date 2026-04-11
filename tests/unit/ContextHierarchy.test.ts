/**
 * Unit tests for ContextHierarchy — Tiered context loading.
 *
 * Tests cover:
 * - Context directory initialization
 * - Default segment template creation
 * - Dispatch table generation
 * - Tier-based loading
 * - Segment listing with status
 * - Individual segment loading
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ContextHierarchy } from '../../src/core/ContextHierarchy.js';

function createTmpProject(): { projectDir: string; stateDir: string } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'));
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  return { projectDir, stateDir };
}

describe('ContextHierarchy', () => {
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    ({ projectDir, stateDir } = createTmpProject());
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  describe('initialize()', () => {
    it('creates context directory and default segment files', () => {
      const ctx = new ContextHierarchy({ stateDir, projectDir, projectName: 'test-project' });
      const result = ctx.initialize();

      expect(result.created.length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(stateDir, 'context'))).toBe(true);
    });

    it('creates all default segment files', () => {
      const ctx = new ContextHierarchy({ stateDir, projectDir, projectName: 'test-project' });
      ctx.initialize();

      const expectedFiles = [
        'identity.md', 'safety.md', 'project.md', 'session.md',
        'relationships.md', 'development.md', 'deployment.md', 'communication.md',
      ];

      for (const file of expectedFiles) {
        expect(fs.existsSync(path.join(stateDir, 'context', file))).toBe(true);
      }
    });

    it('creates DISPATCH.md', () => {
      const ctx = new ContextHierarchy({ stateDir, projectDir, projectName: 'test-project' });
      ctx.initialize();

      expect(fs.existsSync(path.join(stateDir, 'context', 'DISPATCH.md'))).toBe(true);
    });

    it('does not overwrite existing files', () => {
      const ctx = new ContextHierarchy({ stateDir, projectDir, projectName: 'test-project' });

      // Create a file first
      const contextDir = path.join(stateDir, 'context');
      fs.mkdirSync(contextDir, { recursive: true });
      fs.writeFileSync(path.join(contextDir, 'identity.md'), 'Custom content');

      const result = ctx.initialize();

      expect(result.skipped).toContain('identity.md');
      expect(fs.readFileSync(path.join(contextDir, 'identity.md'), 'utf-8')).toBe('Custom content');
    });
  });

  describe('getDispatchTable()', () => {
    it('returns dispatch entries for tier 2 segments', () => {
      const ctx = new ContextHierarchy({ stateDir, projectDir, projectName: 'test-project' });
      const table = ctx.getDispatchTable();

      expect(table.length).toBeGreaterThan(0);
      expect(table[0].trigger).toBeTruthy();
      expect(table[0].file).toContain('.instar/context/');
      expect(table[0].reason).toBeTruthy();
    });
  });

  describe('loadTier()', () => {
    it('loads tier 0 content (always-loaded)', () => {
      const ctx = new ContextHierarchy({ stateDir, projectDir, projectName: 'test-project' });
      ctx.initialize();

      const content = ctx.loadTier(0);
      expect(content).toContain('Identity');
      expect(content).toContain('Safety');
    });

    it('loads tier 1 content (includes tier 0)', () => {
      const ctx = new ContextHierarchy({ stateDir, projectDir, projectName: 'test-project' });
      ctx.initialize();

      const content = ctx.loadTier(1);
      expect(content).toContain('Identity');
      expect(content).toContain('Session');
    });

    it('returns empty string when no files exist', () => {
      const ctx = new ContextHierarchy({ stateDir, projectDir, projectName: 'test-project' });
      const content = ctx.loadTier(0);
      expect(content).toBe('');
    });
  });

  describe('loadSegment()', () => {
    it('loads a specific segment by ID', () => {
      const ctx = new ContextHierarchy({ stateDir, projectDir, projectName: 'test-project' });
      ctx.initialize();

      const content = ctx.loadSegment('safety');
      expect(content).not.toBeNull();
      expect(content).toContain('Safety');
    });

    it('returns null for unknown segment', () => {
      const ctx = new ContextHierarchy({ stateDir, projectDir, projectName: 'test-project' });
      expect(ctx.loadSegment('nonexistent')).toBeNull();
    });

    it('returns null when file does not exist', () => {
      const ctx = new ContextHierarchy({ stateDir, projectDir, projectName: 'test-project' });
      expect(ctx.loadSegment('identity')).toBeNull();
    });
  });

  describe('listSegments()', () => {
    it('lists all segments with status', () => {
      const ctx = new ContextHierarchy({ stateDir, projectDir, projectName: 'test-project' });
      ctx.initialize();

      const segments = ctx.listSegments();
      expect(segments.length).toBeGreaterThan(0);

      const identity = segments.find(s => s.id === 'identity');
      expect(identity).toBeDefined();
      expect(identity!.exists).toBe(true);
      expect(identity!.sizeBytes).toBeGreaterThan(0);
    });

    it('marks missing segments as not existing', () => {
      const ctx = new ContextHierarchy({ stateDir, projectDir, projectName: 'test-project' });
      // Don't initialize — no files

      const segments = ctx.listSegments();
      for (const s of segments) {
        expect(s.exists).toBe(false);
        expect(s.sizeBytes).toBe(0);
      }
    });

    it('returns absolute filePath for every segment for self-diagnosis', () => {
      const ctx = new ContextHierarchy({ stateDir, projectDir, projectName: 'test-project' });
      ctx.initialize();

      const segments = ctx.listSegments();
      for (const s of segments) {
        expect(path.isAbsolute(s.filePath)).toBe(true);
        expect(s.filePath).toBe(path.join(stateDir, 'context', s.file));
      }
    });

    it('does not set statError for a missing (ENOENT) segment', () => {
      const ctx = new ContextHierarchy({ stateDir, projectDir, projectName: 'test-project' });
      // Don't initialize — ENOENT is the normal "not created yet" state.

      const segments = ctx.listSegments();
      for (const s of segments) {
        expect(s.statError).toBeUndefined();
      }
    });

    it('reports exists and sizeBytes consistently (no existsSync/statSync race)', () => {
      const ctx = new ContextHierarchy({ stateDir, projectDir, projectName: 'test-project' });
      ctx.initialize();

      // Real bug signature from feedback: exists=true but sizeBytes=0 despite
      // files having content. With the atomic-stat implementation, `exists`
      // is only true when the stat succeeded — so size is the same stat's
      // result, not a second call that could race or silently fail.
      const segments = ctx.listSegments();
      for (const s of segments) {
        if (s.exists) {
          const actual = fs.statSync(s.filePath).size;
          expect(s.sizeBytes).toBe(actual);
        }
      }
    });
  });

  describe('template content', () => {
    it('identity template includes project name', () => {
      const ctx = new ContextHierarchy({ stateDir, projectDir, projectName: 'my-cool-app' });
      ctx.initialize();

      const content = fs.readFileSync(path.join(stateDir, 'context', 'identity.md'), 'utf-8');
      expect(content).toContain('my-cool-app');
    });

    it('safety template mentions coherence gate', () => {
      const ctx = new ContextHierarchy({ stateDir, projectDir, projectName: 'test-project' });
      ctx.initialize();

      const content = fs.readFileSync(path.join(stateDir, 'context', 'safety.md'), 'utf-8');
      expect(content).toContain('Coherence Gate');
      expect(content).toContain('/coherence/check');
    });

    it('deployment template mentions coherence check', () => {
      const ctx = new ContextHierarchy({ stateDir, projectDir, projectName: 'test-project' });
      ctx.initialize();

      const content = fs.readFileSync(path.join(stateDir, 'context', 'deployment.md'), 'utf-8');
      expect(content).toContain('coherence');
    });
  });
});
