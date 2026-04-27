/**
 * Unit tests for InstructionsVerifier — tracks and verifies Claude Code
 * instruction file loading (InstructionsLoaded hook event).
 *
 * Tests:
 * - Recording: stores instruction load events per session
 * - Verification: checks expected files against loaded files
 * - Session management: clear, list, isolation
 * - Edge cases: no loads, multiple sessions, path patterns
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { InstructionsVerifier } from '../../src/monitoring/InstructionsVerifier.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-instructions-test-'));
}

// ── Tests ────────────────────────────────────────────────────────

describe('InstructionsVerifier', () => {
  let tmpDir: string;
  let verifier: InstructionsVerifier;

  beforeEach(() => {
    tmpDir = createTempDir();
    verifier = new InstructionsVerifier({ stateDir: tmpDir });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Recording ─────────────────────────────────────────────────

  describe('recordLoad()', () => {
    it('records a single instruction file load', () => {
      verifier.recordLoad({
        filePath: '/project/CLAUDE.md',
        memoryType: 'Project',
        sessionId: 'session-1',
      });

      const loads = verifier.getLoads('session-1');
      expect(loads).toHaveLength(1);
      expect(loads[0].filePath).toBe('/project/CLAUDE.md');
      expect(loads[0].memoryType).toBe('Project');
      expect(loads[0].timestamp).toBeTruthy();
    });

    it('records multiple files for the same session', () => {
      verifier.recordLoad({
        filePath: '/home/user/.claude/CLAUDE.md',
        memoryType: 'User',
        sessionId: 'session-1',
      });
      verifier.recordLoad({
        filePath: '/project/CLAUDE.md',
        memoryType: 'Project',
        sessionId: 'session-1',
      });
      verifier.recordLoad({
        filePath: '/project/.claude/settings.local.md',
        memoryType: 'Local',
        sessionId: 'session-1',
      });

      const loads = verifier.getLoads('session-1');
      expect(loads).toHaveLength(3);
      expect(loads.map(l => l.memoryType)).toEqual(['User', 'Project', 'Local']);
    });

    it('records load_reason when provided', () => {
      verifier.recordLoad({
        filePath: '/project/CLAUDE.md',
        memoryType: 'Project',
        loadReason: 'eager',
        sessionId: 'session-1',
      });

      const loads = verifier.getLoads('session-1');
      expect(loads[0].loadReason).toBe('eager');
    });

    it('stores events for different sessions separately', () => {
      verifier.recordLoad({
        filePath: '/project-a/CLAUDE.md',
        memoryType: 'Project',
        sessionId: 'session-a',
      });
      verifier.recordLoad({
        filePath: '/project-b/CLAUDE.md',
        memoryType: 'Project',
        sessionId: 'session-b',
      });

      expect(verifier.getLoads('session-a')).toHaveLength(1);
      expect(verifier.getLoads('session-b')).toHaveLength(1);
    });

    it('uses "current" as default session ID', () => {
      verifier.recordLoad({
        filePath: '/project/CLAUDE.md',
        memoryType: 'Project',
      });

      const loads = verifier.getLoads(); // no session ID = "current"
      expect(loads).toHaveLength(1);
    });
  });

  // ── Verification ──────────────────────────────────────────────

  describe('verify()', () => {
    it('passes when expected CLAUDE.md is loaded', () => {
      verifier.recordLoad({
        filePath: '/project/CLAUDE.md',
        memoryType: 'Project',
        sessionId: 'session-1',
      });

      const result = verifier.verify('session-1');
      expect(result.passed).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.summary).toContain('All');
    });

    it('fails when no files loaded', () => {
      const result = verifier.verify('empty-session');
      expect(result.passed).toBe(false);
      expect(result.missing).toContain('CLAUDE.md');
      expect(result.summary).toContain('MISSING');
    });

    it('fails when expected file not in loaded set', () => {
      verifier.recordLoad({
        filePath: '/home/user/.claude/CLAUDE.md',
        memoryType: 'User',
        sessionId: 'session-1',
      });

      // Custom expected patterns — looking for AGENT.md which didn't load
      const custom = new InstructionsVerifier({
        stateDir: tmpDir,
        expectedPatterns: ['AGENT.md'],
      });
      custom.recordLoad({
        filePath: '/home/user/.claude/CLAUDE.md',
        memoryType: 'User',
        sessionId: 'session-1',
      });

      const result = custom.verify('session-1');
      expect(result.passed).toBe(false);
      expect(result.missing).toContain('AGENT.md');
    });

    it('passes with substring matching on file paths', () => {
      verifier.recordLoad({
        filePath: '/Users/justin/Documents/Projects/my-project/CLAUDE.md',
        memoryType: 'Project',
        sessionId: 'session-1',
      });

      const result = verifier.verify('session-1');
      expect(result.passed).toBe(true);
    });

    it('supports multiple expected patterns', () => {
      const multi = new InstructionsVerifier({
        stateDir: tmpDir,
        expectedPatterns: ['CLAUDE.md', 'AGENT.md'],
      });

      multi.recordLoad({
        filePath: '/project/CLAUDE.md',
        memoryType: 'Project',
        sessionId: 'session-1',
      });

      // Only CLAUDE.md loaded, AGENT.md missing
      const result = multi.verify('session-1');
      expect(result.passed).toBe(false);
      expect(result.missing).toEqual(['AGENT.md']);
      expect(result.loaded).toHaveLength(1);
    });

    it('passes when all multiple expected patterns are satisfied', () => {
      const multi = new InstructionsVerifier({
        stateDir: tmpDir,
        expectedPatterns: ['CLAUDE.md', '.instar/AGENT.md'],
      });

      multi.recordLoad({
        filePath: '/project/CLAUDE.md',
        memoryType: 'Project',
        sessionId: 'session-1',
      });
      multi.recordLoad({
        filePath: '/project/.instar/AGENT.md',
        memoryType: 'Managed',
        sessionId: 'session-1',
      });

      const result = multi.verify('session-1');
      expect(result.passed).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it('includes loaded file paths in failure summary', () => {
      const custom = new InstructionsVerifier({
        stateDir: tmpDir,
        expectedPatterns: ['AGENT.md'],
      });
      custom.recordLoad({
        filePath: '/project/CLAUDE.md',
        memoryType: 'Project',
        sessionId: 'session-1',
      });

      const result = custom.verify('session-1');
      expect(result.summary).toContain('/project/CLAUDE.md');
      expect(result.summary).toContain('AGENT.md');
    });
  });

  // ── Session Management ────────────────────────────────────────

  describe('clearSession()', () => {
    it('removes tracking data for a session', () => {
      verifier.recordLoad({
        filePath: '/project/CLAUDE.md',
        memoryType: 'Project',
        sessionId: 'session-1',
      });

      expect(verifier.getLoads('session-1')).toHaveLength(1);
      verifier.clearSession('session-1');
      expect(verifier.getLoads('session-1')).toHaveLength(0);
    });

    it('does not affect other sessions', () => {
      verifier.recordLoad({
        filePath: '/project/CLAUDE.md',
        memoryType: 'Project',
        sessionId: 'session-a',
      });
      verifier.recordLoad({
        filePath: '/project/CLAUDE.md',
        memoryType: 'Project',
        sessionId: 'session-b',
      });

      verifier.clearSession('session-a');
      expect(verifier.getLoads('session-a')).toHaveLength(0);
      expect(verifier.getLoads('session-b')).toHaveLength(1);
    });

    it('handles clearing non-existent session gracefully', () => {
      expect(() => verifier.clearSession('nonexistent')).not.toThrow();
    });
  });

  describe('listSessions()', () => {
    it('returns empty array when no data', () => {
      expect(verifier.listSessions()).toEqual([]);
    });

    it('lists all sessions with tracking data', () => {
      verifier.recordLoad({
        filePath: '/project/CLAUDE.md',
        memoryType: 'Project',
        sessionId: 'session-a',
      });
      verifier.recordLoad({
        filePath: '/project/CLAUDE.md',
        memoryType: 'Project',
        sessionId: 'session-b',
      });

      const sessions = verifier.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.sort()).toEqual(['session-a', 'session-b']);
    });
  });

  // ── Persistence ───────────────────────────────────────────────

  describe('persistence', () => {
    it('survives reconstruction', () => {
      verifier.recordLoad({
        filePath: '/project/CLAUDE.md',
        memoryType: 'Project',
        sessionId: 'persistent',
      });

      const verifier2 = new InstructionsVerifier({ stateDir: tmpDir });
      const loads = verifier2.getLoads('persistent');
      expect(loads).toHaveLength(1);
      expect(loads[0].filePath).toBe('/project/CLAUDE.md');
    });

    it('verification works on persisted data', () => {
      verifier.recordLoad({
        filePath: '/project/CLAUDE.md',
        memoryType: 'Project',
        sessionId: 'persistent',
      });

      const verifier2 = new InstructionsVerifier({ stateDir: tmpDir });
      const result = verifier2.verify('persistent');
      expect(result.passed).toBe(true);
    });
  });

  // ── Edge Cases ────────────────────────────────────────────────

  describe('edge cases', () => {
    it('sanitizes session IDs with special characters', () => {
      verifier.recordLoad({
        filePath: '/project/CLAUDE.md',
        memoryType: 'Project',
        sessionId: '../../../etc/passwd',
      });
      const sessions = verifier.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).not.toContain('/');
    });

    it('handles all memory types', () => {
      const types = ['User', 'Project', 'Local', 'Managed'];
      for (const memoryType of types) {
        verifier.recordLoad({
          filePath: `/path/${memoryType}/CLAUDE.md`,
          memoryType,
          sessionId: 'types-test',
        });
      }

      const loads = verifier.getLoads('types-test');
      expect(loads).toHaveLength(4);
      expect(loads.map(l => l.memoryType).sort()).toEqual(types.sort());
    });

    it('empty expected patterns always passes', () => {
      const empty = new InstructionsVerifier({
        stateDir: tmpDir,
        expectedPatterns: [],
      });

      const result = empty.verify('no-session');
      expect(result.passed).toBe(true);
    });
  });
});
