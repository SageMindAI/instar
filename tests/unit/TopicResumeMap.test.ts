/**
 * Unit tests for TopicResumeMap — persistent mapping from Telegram topic IDs
 * to Claude session UUIDs for session resume.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TopicResumeMap } from '../../src/core/TopicResumeMap.js';

describe('TopicResumeMap', () => {
  let tmpDir: string;
  let stateDir: string;
  let projectDir: string;
  let resumeMap: TopicResumeMap;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-map-test-'));
    stateDir = path.join(tmpDir, 'state');
    projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    resumeMap = new TopicResumeMap(stateDir, projectDir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── save() and get() ────────────────────────────────────────────

  describe('save() and get()', () => {
    it('saves and retrieves a resume entry', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      // Create a fake JSONL file so get() finds it
      setupFakeClaudeProject(uuid);

      resumeMap.save(42, uuid, 'test-session');
      const result = resumeMap.get(42);

      expect(result).toBe(uuid);
    });

    it('returns null for a topic that was never saved', () => {
      expect(resumeMap.get(999)).toBeNull();
    });

    it('overwrites previous entry for the same topic', () => {
      const uuid1 = '11111111-1111-1111-1111-111111111111';
      const uuid2 = '22222222-2222-2222-2222-222222222222';
      setupFakeClaudeProject(uuid2);

      resumeMap.save(42, uuid1, 'session-1');
      resumeMap.save(42, uuid2, 'session-2');

      expect(resumeMap.get(42)).toBe(uuid2);
    });

    it('stores multiple topics independently', () => {
      const uuid1 = '11111111-1111-1111-1111-111111111111';
      const uuid2 = '22222222-2222-2222-2222-222222222222';
      setupFakeClaudeProject(uuid1);
      setupFakeClaudeProject(uuid2);

      resumeMap.save(10, uuid1, 'session-a');
      resumeMap.save(20, uuid2, 'session-b');

      expect(resumeMap.get(10)).toBe(uuid1);
      expect(resumeMap.get(20)).toBe(uuid2);
    });

    it('persists to disk and survives re-instantiation', () => {
      const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      setupFakeClaudeProject(uuid);

      resumeMap.save(42, uuid, 'persistent-session');

      // Create a new instance pointing at the same state dir
      const newMap = new TopicResumeMap(stateDir, projectDir);
      expect(newMap.get(42)).toBe(uuid);
    });
  });

  // ── remove() ────────────────────────────────────────────────────

  describe('remove()', () => {
    it('removes an existing entry', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      setupFakeClaudeProject(uuid);

      resumeMap.save(42, uuid, 'test-session');
      expect(resumeMap.get(42)).toBe(uuid);

      resumeMap.remove(42);
      expect(resumeMap.get(42)).toBeNull();
    });

    it('is a no-op for non-existent topic', () => {
      // Should not throw
      resumeMap.remove(999);
    });

    it('does not affect other entries', () => {
      const uuid1 = '11111111-1111-1111-1111-111111111111';
      const uuid2 = '22222222-2222-2222-2222-222222222222';
      setupFakeClaudeProject(uuid1);
      setupFakeClaudeProject(uuid2);

      resumeMap.save(10, uuid1, 'session-a');
      resumeMap.save(20, uuid2, 'session-b');

      resumeMap.remove(10);

      expect(resumeMap.get(10)).toBeNull();
      expect(resumeMap.get(20)).toBe(uuid2);
    });
  });

  // ── Auto-pruning ────────────────────────────────────────────────

  describe('auto-pruning', () => {
    it('returns null for entries older than 24 hours', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      setupFakeClaudeProject(uuid);

      resumeMap.save(42, uuid, 'test-session');

      // Manually edit the file to backdate the entry
      const filePath = path.join(stateDir, 'topic-resume-map.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      data['42'].savedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(filePath, JSON.stringify(data));

      expect(resumeMap.get(42)).toBeNull();
    });

    it('prunes old entries when saving new ones', () => {
      const oldUuid = '11111111-1111-1111-1111-111111111111';
      const newUuid = '22222222-2222-2222-2222-222222222222';

      resumeMap.save(10, oldUuid, 'old-session');

      // Backdate the old entry
      const filePath = path.join(stateDir, 'topic-resume-map.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      data['10'].savedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(filePath, JSON.stringify(data));

      // Save a new entry — should prune the old one
      resumeMap.save(20, newUuid, 'new-session');

      const fileData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(fileData['10']).toBeUndefined();
      expect(fileData['20']).toBeDefined();
    });
  });

  // ── JSONL existence validation ──────────────────────────────────

  describe('JSONL existence validation', () => {
    it('returns null when JSONL file does not exist', () => {
      const uuid = 'deadbeef-dead-beef-dead-beefdeadbeef';
      // Save but do NOT create a fake JSONL file
      resumeMap.save(42, uuid, 'test-session');

      expect(resumeMap.get(42)).toBeNull();
    });

    it('returns the UUID when JSONL file exists', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      setupFakeClaudeProject(uuid);

      resumeMap.save(42, uuid, 'test-session');
      expect(resumeMap.get(42)).toBe(uuid);
    });
  });

  // ── Corrupted file handling ─────────────────────────────────────

  describe('corrupted file handling', () => {
    it('returns null when map file contains invalid JSON', () => {
      const filePath = path.join(stateDir, 'topic-resume-map.json');
      fs.writeFileSync(filePath, '{ broken json!!!');

      expect(resumeMap.get(42)).toBeNull();
    });

    it('overwrites corrupted file on next save', () => {
      const filePath = path.join(stateDir, 'topic-resume-map.json');
      fs.writeFileSync(filePath, '{ broken json!!!');

      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      setupFakeClaudeProject(uuid);

      resumeMap.save(42, uuid, 'recovered-session');
      expect(resumeMap.get(42)).toBe(uuid);
    });

    it('handles empty file gracefully', () => {
      const filePath = path.join(stateDir, 'topic-resume-map.json');
      fs.writeFileSync(filePath, '');

      expect(resumeMap.get(42)).toBeNull();
    });
  });

  // ── findClaudeSessionUuid() ─────────────────────────────────────

  describe('findClaudeSessionUuid()', () => {
    it('returns null when no JSONL files exist for the project', () => {
      // projectDir is a temp dir with no Claude JSONL files
      const result = resumeMap.findClaudeSessionUuid();
      expect(result).toBeNull();
    });

    it('finds JSONL files in the project-specific directory', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      setupFakeClaudeProject(uuid);

      const result = resumeMap.findClaudeSessionUuid();
      expect(result).toBe(uuid);
    });

    it('returns the most recently modified JSONL', () => {
      const uuid1 = '11111111-1111-1111-1111-111111111111';
      const uuid2 = '22222222-2222-2222-2222-222222222222';
      setupFakeClaudeProject(uuid1);
      // Create second file slightly later
      setupFakeClaudeProject(uuid2);

      const result = resumeMap.findClaudeSessionUuid();
      // Should be uuid2 since it was created last
      expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  // ── findUuidForSession() ────────────────────────────────────────

  describe('findUuidForSession()', () => {
    it('returns claudeSessionId when provided and JSONL exists', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      setupFakeClaudeProject(uuid);

      const result = resumeMap.findUuidForSession('any-tmux-session', uuid);
      expect(result).toBe(uuid);
    });

    it('returns null when claudeSessionId is not provided', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      setupFakeClaudeProject(uuid);

      const result = resumeMap.findUuidForSession('any-tmux-session');
      expect(result).toBeNull();
    });

    it('returns null when claudeSessionId JSONL does not exist', () => {
      const result = resumeMap.findUuidForSession('any-tmux-session', 'deadbeef-dead-beef-dead-beefdeadbeef');
      expect(result).toBeNull();
    });
  });

  // ── jsonlExistsPublic() ────────────────────────────────────────

  describe('jsonlExistsPublic()', () => {
    it('returns true when JSONL file exists', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      setupFakeClaudeProject(uuid);

      expect(resumeMap.jsonlExistsPublic(uuid)).toBe(true);
    });

    it('returns false when JSONL file does not exist', () => {
      expect(resumeMap.jsonlExistsPublic('deadbeef-dead-beef-dead-beefdeadbeef')).toBe(false);
    });
  });

  // ── Helpers ─────────────────────────────────────────────────────

  // Track test project dirs for cleanup
  const testProjectDirs: string[] = [];

  afterEach(() => {
    for (const dir of testProjectDirs) {
      // safe-git-allow: incremental-migration
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    testProjectDirs.length = 0;
  });

  /**
   * Create a fake JSONL file in the project-specific directory under
   * ~/.claude/projects/ so that the JSONL existence check passes.
   * Uses the same hashing that TopicResumeMap uses internally:
   * replace '/' and '.' with '-'.
   */
  function setupFakeClaudeProject(uuid: string): void {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    // Must match the hashing in TopicResumeMap.claudeProjectDirName()
    const projectHash = projectDir.replace(/[\/\.]/g, '-');
    const testProjectDir = path.join(projectsDir, projectHash);
    fs.mkdirSync(testProjectDir, { recursive: true });
    fs.writeFileSync(path.join(testProjectDir, `${uuid}.jsonl`), '');
    if (!testProjectDirs.includes(testProjectDir)) {
      testProjectDirs.push(testProjectDir);
    }
  }
});
