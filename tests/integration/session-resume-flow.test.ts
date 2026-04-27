/**
 * Integration test for session resume flow.
 *
 * Tests the full lifecycle: save UUID before kill → lookup on next spawn →
 * pass resumeSessionId → remove after use.
 *
 * Uses the real TopicResumeMap with a temp state directory, and mocks
 * SessionManager to verify the resume ID flows through correctly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TopicResumeMap } from '../../src/core/TopicResumeMap.js';

// Track spawned session args
const spawnedSessions: Array<{
  message?: string;
  name?: string;
  options?: { telegramTopicId?: number; resumeSessionId?: string };
}> = [];

// Mock child_process so SessionManager doesn't need real tmux
const mockTmuxSessions = new Set<string>();
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn().mockImplementation((cmd: string, args?: string[]) => {
    if (!args) return '';
    if (args[0] === 'has-session') {
      const target = args[2]?.replace(/^=/, '');
      if (!mockTmuxSessions.has(target)) throw new Error('not found');
      return '';
    }
    if (args[0] === 'new-session') {
      const sIdx = args.indexOf('-s');
      if (sIdx >= 0 && args[sIdx + 1]) mockTmuxSessions.add(args[sIdx + 1]);
      return '';
    }
    if (args[0] === 'kill-session') {
      const target = args[2]?.replace(/^=/, '');
      mockTmuxSessions.delete(target);
      return '';
    }
    if (args[0] === 'display-message') return 'claude||claude';
    if (args[0] === 'capture-pane') return '';
    if (args[0] === 'send-keys') return '';
    return '';
  }),
  execFile: vi.fn().mockImplementation(
    (_cmd: string, args: string[], _opts: unknown, cb?: (err: Error | null, result: { stdout: string }) => void) => {
      if (typeof _opts === 'function') cb = _opts as typeof cb;
      if (args[0] === 'has-session') {
        const target = args[2]?.replace(/^=/, '');
        if (!mockTmuxSessions.has(target)) {
          if (cb) cb(new Error('not found'), { stdout: '' });
        } else {
          if (cb) cb(null, { stdout: '' });
        }
      } else {
        if (cb) cb(null, { stdout: '' });
      }
    }
  ),
}));

import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

describe('Session Resume Flow (integration)', () => {
  let tmpDir: string;
  let stateDir: string;
  let projectDir: string;
  let resumeMap: TopicResumeMap;
  let sessionManager: SessionManager;
  let testProjectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-flow-test-'));
    stateDir = path.join(tmpDir, 'state');
    projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    resumeMap = new TopicResumeMap(stateDir, projectDir);

    const config: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir: tmpDir,
      maxSessions: 3,
      protectedSessions: [],
      completionPatterns: ['Session complete'],
    };
    const state = new StateManager(stateDir);
    sessionManager = new SessionManager(config, state);

    // Create a fake JSONL file in the project-hashed directory for UUID validation.
    // Must match TopicResumeMap.claudeProjectDirName() which replaces '/' and '.' with '-'.
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    const projectHash = projectDir.replace(/[\/\.]/g, '-');
    testProjectDir = path.join(projectsDir, projectHash);
    fs.mkdirSync(testProjectDir, { recursive: true });

    mockTmuxSessions.clear();
    spawnedSessions.length = 0;
  });

  afterEach(() => {
    sessionManager.stopMonitoring();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // safe-git-allow: incremental-migration
    try { fs.rmSync(testProjectDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function createFakeJsonl(uuid: string): void {
    fs.writeFileSync(path.join(testProjectDir, `${uuid}.jsonl`), '');
  }

  // ── Full Flow Tests ─────────────────────────────────────────────

  it('full flow: save → lookup → spawn with resume → cleanup', async () => {
    const topicId = 42;
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    createFakeJsonl(uuid);

    // Step 1: Save UUID (simulating pre-kill save)
    resumeMap.save(topicId, uuid, 'old-session');

    // Step 2: Look up UUID (simulating new spawn)
    const resumeUuid = resumeMap.get(topicId);
    expect(resumeUuid).toBe(uuid);

    // Step 3: Spawn with resume ID
    const tmuxSession = await sessionManager.spawnInteractiveSession(
      'test message',
      'resume-test',
      { telegramTopicId: topicId, resumeSessionId: resumeUuid! },
    );
    expect(tmuxSession).toBeTruthy();

    // Step 4: Cleanup after successful spawn
    resumeMap.remove(topicId);
    expect(resumeMap.get(topicId)).toBeNull();
  });

  it('returns null when no UUID was saved for the topic', () => {
    expect(resumeMap.get(999)).toBeNull();
  });

  it('spawns without --resume when no UUID exists', async () => {
    const topicId = 99;
    const resumeUuid = resumeMap.get(topicId);
    expect(resumeUuid).toBeNull();

    // Should spawn fine without resume
    const tmuxSession = await sessionManager.spawnInteractiveSession(
      'fresh message',
      'fresh-session',
      { telegramTopicId: topicId },
    );
    expect(tmuxSession).toBeTruthy();
  });

  it('prevents stale reuse after cleanup', async () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    createFakeJsonl(uuid);

    resumeMap.save(42, uuid, 'session-a');
    expect(resumeMap.get(42)).toBe(uuid);

    // Simulate: spawn consumed the UUID, now cleanup
    resumeMap.remove(42);

    // Second spawn should NOT get a resume UUID
    expect(resumeMap.get(42)).toBeNull();
  });

  it('handles multiple topics independently', async () => {
    const uuid1 = '11111111-1111-1111-1111-111111111111';
    const uuid2 = '22222222-2222-2222-2222-222222222222';
    createFakeJsonl(uuid1);
    createFakeJsonl(uuid2);

    resumeMap.save(10, uuid1, 'session-a');
    resumeMap.save(20, uuid2, 'session-b');

    // Topic 10 spawns and consumes its UUID
    expect(resumeMap.get(10)).toBe(uuid1);
    resumeMap.remove(10);

    // Topic 20's UUID should be unaffected
    expect(resumeMap.get(20)).toBe(uuid2);

    // Topic 10 should not have a UUID anymore
    expect(resumeMap.get(10)).toBeNull();
  });

  it('overwrites UUID on consecutive saves (session killed multiple times)', () => {
    const uuid1 = '11111111-1111-1111-1111-111111111111';
    const uuid2 = '22222222-2222-2222-2222-222222222222';
    createFakeJsonl(uuid2);

    resumeMap.save(42, uuid1, 'first-death');
    resumeMap.save(42, uuid2, 'second-death');

    // Should get the most recent UUID
    expect(resumeMap.get(42)).toBe(uuid2);
  });

  it('survives server restart (persistence)', () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    createFakeJsonl(uuid);

    resumeMap.save(42, uuid, 'pre-restart');

    // Simulate server restart — new TopicResumeMap instance, same state dir
    const newResumeMap = new TopicResumeMap(stateDir, projectDir);
    expect(newResumeMap.get(42)).toBe(uuid);
  });

  it('expired entries are not used for resume', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    createFakeJsonl(uuid);

    resumeMap.save(42, uuid, 'old-session');

    // Backdate the entry past 24h
    const filePath = path.join(stateDir, 'topic-resume-map.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    data['42'].savedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(filePath, JSON.stringify(data));

    // Should return null — expired
    expect(resumeMap.get(42)).toBeNull();
  });
});
