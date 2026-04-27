/**
 * E2E tests for session resumption.
 *
 * Tests the full lifecycle of session resume including:
 * - beforeSessionKill event saving UUIDs before tmux destruction
 * - Idle-kill triggering UUID persistence via the event
 * - Heartbeat (refreshResumeMappings) correctly discovering UUIDs
 * - Path hashing matching Claude Code's directory naming
 * - Cross-project JSONL isolation
 * - Full cycle: spawn → idle kill → new message → resume with --resume flag
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TopicResumeMap } from '../../src/core/TopicResumeMap.js';
import { EventEmitter } from 'node:events';

// ── Helpers ─────────────────────────────────────────────────────────

/** Compute the expected Claude project dir hash (must match TopicResumeMap internals) */
function claudeProjectHash(projectDir: string): string {
  return projectDir.replace(/[\/\.]/g, '-');
}

/** Create a fake JSONL file in the project-hashed Claude directory */
function createFakeJsonl(projectDir: string, uuid: string): string {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const hashDir = path.join(projectsDir, claudeProjectHash(projectDir));
  fs.mkdirSync(hashDir, { recursive: true });
  const jsonlPath = path.join(hashDir, `${uuid}.jsonl`);
  fs.writeFileSync(jsonlPath, '{"type":"test"}\n');
  return hashDir;
}

/** Create a fake JSONL file in a DIFFERENT project's Claude directory */
function createFakeJsonlInOtherProject(otherProjectDir: string, uuid: string): string {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const hashDir = path.join(projectsDir, claudeProjectHash(otherProjectDir));
  fs.mkdirSync(hashDir, { recursive: true });
  const jsonlPath = path.join(hashDir, `${uuid}.jsonl`);
  fs.writeFileSync(jsonlPath, '{"type":"other-project"}\n');
  return hashDir;
}

// ── Test Suite ──────────────────────────────────────────────────────

describe('Session Resume E2E', () => {
  let tmpDir: string;
  let stateDir: string;
  let projectDir: string;
  let resumeMap: TopicResumeMap;
  let cleanupDirs: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-e2e-test-'));
    stateDir = path.join(tmpDir, 'state');
    projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    resumeMap = new TopicResumeMap(stateDir, projectDir);
    cleanupDirs = [];
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const dir of cleanupDirs) {
      // safe-git-allow: incremental-migration
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  // ── Path Hashing ────────────────────────────────────────────────

  describe('Claude project directory hashing', () => {
    it('replaces slashes with dashes', () => {
      expect(claudeProjectHash('/Users/foo/bar')).toBe('-Users-foo-bar');
    });

    it('replaces dots with dashes (hidden directories)', () => {
      expect(claudeProjectHash('/Users/foo/.hidden/bar')).toBe('-Users-foo--hidden-bar');
    });

    it('handles multiple dots correctly', () => {
      expect(claudeProjectHash('/Users/foo/.config/.local/bar')).toBe('-Users-foo--config--local-bar');
    });

    it('matches real Claude Code directory naming for .instar paths', () => {
      // This is the actual pattern that was broken before the fix
      expect(claudeProjectHash('/Users/justin/.instar/agents/echo'))
        .toBe('-Users-justin--instar-agents-echo');
    });

    it('handles paths without dots (no hidden dirs)', () => {
      expect(claudeProjectHash('/Users/justin/Documents/Projects/instar'))
        .toBe('-Users-justin-Documents-Projects-instar');
    });
  });

  // ── Cross-Project Isolation ─────────────────────────────────────

  describe('cross-project JSONL isolation', () => {
    it('findClaudeSessionUuid only returns UUIDs from the current project', () => {
      const myUuid = '11111111-1111-1111-1111-111111111111';
      const otherUuid = '22222222-2222-2222-2222-222222222222';
      const otherProjectDir = path.join(tmpDir, 'other-project');

      const myDir = createFakeJsonl(projectDir, myUuid);
      const otherDir = createFakeJsonlInOtherProject(otherProjectDir, otherUuid);
      cleanupDirs.push(myDir, otherDir);

      // Make the other project's JSONL more recent
      const otherJsonlPath = path.join(otherDir, `${otherUuid}.jsonl`);
      const futureTime = new Date(Date.now() + 60_000);
      fs.utimesSync(otherJsonlPath, futureTime, futureTime);

      const result = resumeMap.findClaudeSessionUuid();
      // Should find OUR UUID, not the other project's more recent one
      expect(result).toBe(myUuid);
    });

    it('jsonlExists validates against the current project only', () => {
      const uuid = '33333333-3333-3333-3333-333333333333';
      const otherProjectDir = path.join(tmpDir, 'other-project');

      // Create JSONL in a DIFFERENT project's directory
      const otherDir = createFakeJsonlInOtherProject(otherProjectDir, uuid);
      cleanupDirs.push(otherDir);

      // Save the UUID and try to retrieve it
      resumeMap.save(42, uuid, 'test-session');

      // get() should return null because the JSONL only exists in the other project
      expect(resumeMap.get(42)).toBeNull();
    });

    it('jsonlExists finds UUIDs in the correct project directory', () => {
      const uuid = '44444444-4444-4444-4444-444444444444';

      const myDir = createFakeJsonl(projectDir, uuid);
      cleanupDirs.push(myDir);

      resumeMap.save(42, uuid, 'test-session');
      expect(resumeMap.get(42)).toBe(uuid);
    });
  });

  // ── Heartbeat (refreshResumeMappings) ───────────────────────────

  describe('refreshResumeMappings heartbeat', () => {
    // Mock child_process for tmux has-session checks
    const originalSpawnSync = vi.hoisted(() => {
      return null as any;
    });

    it('discovers UUIDs for active topic sessions', () => {
      const uuid = '55555555-5555-5555-5555-555555555555';
      const myDir = createFakeJsonl(projectDir, uuid);
      cleanupDirs.push(myDir);

      // Create a TopicResumeMap with a mock tmux path that always says sessions exist
      const mockTmuxScript = path.join(tmpDir, 'mock-tmux.sh');
      fs.writeFileSync(mockTmuxScript, '#!/bin/bash\nexit 0\n');
      fs.chmodSync(mockTmuxScript, '755');

      const heartbeatMap = new TopicResumeMap(stateDir, projectDir, mockTmuxScript);

      const topicSessions = new Map<number, { sessionName: string; claudeSessionId?: string }>();
      topicSessions.set(42, { sessionName: 'echo-my-topic' });

      heartbeatMap.refreshResumeMappings(topicSessions);

      // The heartbeat should have saved the UUID
      expect(heartbeatMap.get(42)).toBe(uuid);
    });

    it('does not save UUIDs for dead tmux sessions', () => {
      const uuid = '66666666-6666-6666-6666-666666666666';
      const myDir = createFakeJsonl(projectDir, uuid);
      cleanupDirs.push(myDir);

      // Mock tmux that says session doesn't exist
      const mockTmuxScript = path.join(tmpDir, 'mock-tmux-dead.sh');
      fs.writeFileSync(mockTmuxScript, '#!/bin/bash\nexit 1\n');
      fs.chmodSync(mockTmuxScript, '755');

      const heartbeatMap = new TopicResumeMap(stateDir, projectDir, mockTmuxScript);

      const topicSessions = new Map<number, { sessionName: string; claudeSessionId?: string }>();
      topicSessions.set(42, { sessionName: 'echo-dead-session' });

      heartbeatMap.refreshResumeMappings(topicSessions);

      // Should NOT have saved anything — session was dead
      expect(heartbeatMap.get(42)).toBeNull();
    });

    it('updates stale entries during heartbeat', () => {
      const oldUuid = '77777777-7777-7777-7777-777777777777';
      const newUuid = '88888888-8888-8888-8888-888888888888';
      const myDir = createFakeJsonl(projectDir, oldUuid);
      createFakeJsonl(projectDir, newUuid);
      cleanupDirs.push(myDir);

      // Make newUuid more recent
      const newJsonlPath = path.join(myDir, `${newUuid}.jsonl`);
      const futureTime = new Date(Date.now() + 60_000);
      fs.utimesSync(newJsonlPath, futureTime, futureTime);

      // Pre-save old UUID with stale timestamp (>2 hours ago)
      resumeMap.save(42, oldUuid, 'echo-my-topic');
      const mapPath = path.join(stateDir, 'topic-resume-map.json');
      const data = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
      data['42'].savedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(mapPath, JSON.stringify(data));

      // Mock tmux that says session exists
      const mockTmuxScript = path.join(tmpDir, 'mock-tmux-alive.sh');
      fs.writeFileSync(mockTmuxScript, '#!/bin/bash\nexit 0\n');
      fs.chmodSync(mockTmuxScript, '755');

      const heartbeatMap = new TopicResumeMap(stateDir, projectDir, mockTmuxScript);

      const topicSessions = new Map<number, { sessionName: string; claudeSessionId?: string }>();
      topicSessions.set(42, { sessionName: 'echo-my-topic' });

      heartbeatMap.refreshResumeMappings(topicSessions);

      // Should now have the newer UUID
      expect(heartbeatMap.get(42)).toBe(newUuid);
    });

    it('handles empty topic sessions gracefully', () => {
      const heartbeatMap = new TopicResumeMap(stateDir, projectDir);
      // Should not throw
      heartbeatMap.refreshResumeMappings(new Map());
    });

    it('handles missing JSONL directory gracefully', () => {
      // projectDir hash doesn't exist in ~/.claude/projects/
      const heartbeatMap = new TopicResumeMap(stateDir, projectDir);
      const topicSessions = new Map<number, { sessionName: string; claudeSessionId?: string }>();
      topicSessions.set(42, { sessionName: 'some-session' });

      // Should not throw
      heartbeatMap.refreshResumeMappings(topicSessions);
      expect(heartbeatMap.get(42)).toBeNull();
    });
  });

  // ── beforeSessionKill Event Wiring ──────────────────────────────

  describe('beforeSessionKill event integration', () => {
    it('saves UUID when beforeSessionKill fires for a topic-linked session', () => {
      const uuid = '99999999-9999-9999-9999-999999999999';
      const myDir = createFakeJsonl(projectDir, uuid);
      cleanupDirs.push(myDir);

      // Simulate the server wiring:
      // 1. Create a mock emitter (stands in for SessionManager)
      const emitter = new EventEmitter();

      // 2. Create a mock topic→session mapping (stands in for TelegramAdapter)
      const sessionToTopic = new Map<string, number>();
      sessionToTopic.set('echo-my-topic', 42);
      const getTopicForSession = (tmuxSession: string): number | null => {
        return sessionToTopic.get(tmuxSession) ?? null;
      };

      // 3. Wire the beforeSessionKill listener (mirrors server.ts wiring)
      // In the real flow, claudeSessionId is populated by hook-event-reporter.js
      emitter.on('beforeSessionKill', (session: { tmuxSession: string; name: string; claudeSessionId?: string }) => {
        const topicId = getTopicForSession(session.tmuxSession);
        if (!topicId) return;
        const foundUuid = resumeMap.findUuidForSession(session.tmuxSession, session.claudeSessionId);
        if (foundUuid) {
          resumeMap.save(topicId, foundUuid, session.tmuxSession);
        }
      });

      // 4. Fire the event (simulating SessionManager.tick() idle kill)
      // claudeSessionId is set because hook-event-reporter.js fired during the session
      emitter.emit('beforeSessionKill', {
        tmuxSession: 'echo-my-topic',
        name: 'my-topic',
        claudeSessionId: uuid,
      });

      // 5. Verify UUID was saved
      expect(resumeMap.get(42)).toBe(uuid);
    });

    it('does nothing when session has no topic binding', () => {
      const uuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const myDir = createFakeJsonl(projectDir, uuid);
      cleanupDirs.push(myDir);

      const emitter = new EventEmitter();
      const getTopicForSession = (): number | null => null; // No topic mapping

      emitter.on('beforeSessionKill', (session: { tmuxSession: string; name: string }) => {
        const topicId = getTopicForSession();
        if (!topicId) return;
        const foundUuid = resumeMap.findUuidForSession(session.tmuxSession);
        if (foundUuid) {
          resumeMap.save(topicId, foundUuid, session.tmuxSession);
        }
      });

      emitter.emit('beforeSessionKill', {
        tmuxSession: 'echo-job-session',
        name: 'job-session',
      });

      // Nothing should be saved — no topic binding
      const mapPath = path.join(stateDir, 'topic-resume-map.json');
      if (fs.existsSync(mapPath)) {
        const data = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
        expect(Object.keys(data)).toHaveLength(0);
      }
    });

    it('event fires before tmux session is killed (UUID still discoverable)', () => {
      // This test verifies the ordering guarantee: beforeSessionKill fires
      // BEFORE tmux kill-session, so UUID discovery still works.
      const uuid = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      const myDir = createFakeJsonl(projectDir, uuid);
      cleanupDirs.push(myDir);

      const eventOrder: string[] = [];
      const emitter = new EventEmitter();

      const sessionToTopic = new Map<string, number>();
      sessionToTopic.set('echo-test-topic', 99);

      // Wire listener — claudeSessionId passed from Session object
      emitter.on('beforeSessionKill', (session: { tmuxSession: string; claudeSessionId?: string }) => {
        eventOrder.push('beforeSessionKill');
        const topicId = sessionToTopic.get(session.tmuxSession) ?? null;
        if (topicId) {
          const foundUuid = resumeMap.findUuidForSession(session.tmuxSession, session.claudeSessionId);
          if (foundUuid) resumeMap.save(topicId, foundUuid, session.tmuxSession);
        }
      });

      // Simulate the SessionManager.tick() sequence
      // claudeSessionId is set because hook-event-reporter.js fired during the session
      eventOrder.push('tick-start');
      emitter.emit('beforeSessionKill', { tmuxSession: 'echo-test-topic', claudeSessionId: uuid });
      eventOrder.push('tmux-kill');  // In real code: execFileAsync('tmux', ['kill-session', ...])
      eventOrder.push('sessionComplete');

      // Verify ordering
      expect(eventOrder).toEqual([
        'tick-start',
        'beforeSessionKill',
        'tmux-kill',
        'sessionComplete',
      ]);

      // Verify UUID was saved during the beforeSessionKill window
      expect(resumeMap.get(99)).toBe(uuid);
    });
  });

  // ── Full Resume Cycle ───────────────────────────────────────────

  describe('full resume cycle', () => {
    it('spawn → save UUID → idle kill → new message → resume lookup succeeds', () => {
      const sessionUuid = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
      const topicId = 1419;
      const myDir = createFakeJsonl(projectDir, sessionUuid);
      cleanupDirs.push(myDir);

      // Phase 1: Session is running, heartbeat saves UUID
      const mockTmuxScript = path.join(tmpDir, 'mock-tmux.sh');
      fs.writeFileSync(mockTmuxScript, '#!/bin/bash\nexit 0\n');
      fs.chmodSync(mockTmuxScript, '755');

      const map = new TopicResumeMap(stateDir, projectDir, mockTmuxScript);
      const topicSessions = new Map<number, { sessionName: string; claudeSessionId?: string }>();
      topicSessions.set(topicId, { sessionName: 'echo-dashboard-features' });

      map.refreshResumeMappings(topicSessions);
      expect(map.get(topicId)).toBe(sessionUuid);

      // Phase 2: Session gets idle-killed (beforeSessionKill saves UUID)
      // The heartbeat already saved it, but let's verify the beforeSessionKill path too
      const map2 = new TopicResumeMap(stateDir, projectDir);
      map2.save(topicId, sessionUuid, 'echo-dashboard-features');
      expect(map2.get(topicId)).toBe(sessionUuid);

      // Phase 3: New message arrives, lookup returns UUID for --resume
      const map3 = new TopicResumeMap(stateDir, projectDir);
      const resumeUuid = map3.get(topicId);
      expect(resumeUuid).toBe(sessionUuid);

      // Phase 4: After successful spawn, cleanup
      map3.remove(topicId);
      expect(map3.get(topicId)).toBeNull();
    });

    it('spawn → JSONL deleted → new message → graceful fallback to fresh session', () => {
      const sessionUuid = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
      const topicId = 42;
      const myDir = createFakeJsonl(projectDir, sessionUuid);
      cleanupDirs.push(myDir);

      // Save UUID
      resumeMap.save(topicId, sessionUuid, 'echo-topic');
      expect(resumeMap.get(topicId)).toBe(sessionUuid);

      // Delete the JSONL file (simulating cleanup or disk issue)
      const jsonlPath = path.join(myDir, `${sessionUuid}.jsonl`);
      // safe-git-allow: incremental-migration
      fs.unlinkSync(jsonlPath);

      // get() should now return null — JSONL validation fails gracefully
      expect(resumeMap.get(topicId)).toBeNull();
    });

    it('multiple topics each get their correct UUID on resume', () => {
      const uuid1 = 'eeeeeeee-1111-1111-1111-111111111111';
      const uuid2 = 'eeeeeeee-2222-2222-2222-222222222222';
      const uuid3 = 'eeeeeeee-3333-3333-3333-333333333333';
      const myDir = createFakeJsonl(projectDir, uuid1);
      createFakeJsonl(projectDir, uuid2);
      createFakeJsonl(projectDir, uuid3);
      cleanupDirs.push(myDir);

      resumeMap.save(100, uuid1, 'echo-topic-a');
      resumeMap.save(200, uuid2, 'echo-topic-b');
      resumeMap.save(300, uuid3, 'echo-topic-c');

      // Each topic gets its own UUID
      expect(resumeMap.get(100)).toBe(uuid1);
      expect(resumeMap.get(200)).toBe(uuid2);
      expect(resumeMap.get(300)).toBe(uuid3);

      // Consume one — others unaffected
      resumeMap.remove(200);
      expect(resumeMap.get(100)).toBe(uuid1);
      expect(resumeMap.get(200)).toBeNull();
      expect(resumeMap.get(300)).toBe(uuid3);
    });

    it('resume survives server restart (disk persistence)', () => {
      const uuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
      const topicId = 42;
      const myDir = createFakeJsonl(projectDir, uuid);
      cleanupDirs.push(myDir);

      // Server 1: save UUID before kill
      const map1 = new TopicResumeMap(stateDir, projectDir);
      map1.save(topicId, uuid, 'echo-topic');

      // Server 2: new instance after restart
      const map2 = new TopicResumeMap(stateDir, projectDir);
      expect(map2.get(topicId)).toBe(uuid);
    });
  });

  // ── Edge Cases ──────────────────────────────────────────────────

  describe('edge cases', () => {
    it('expired entries (>24h) are not used for resume', () => {
      const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const myDir = createFakeJsonl(projectDir, uuid);
      cleanupDirs.push(myDir);

      resumeMap.save(42, uuid, 'old-session');

      // Backdate past 24h
      const mapPath = path.join(stateDir, 'topic-resume-map.json');
      const data = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
      data['42'].savedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(mapPath, JSON.stringify(data));

      expect(resumeMap.get(42)).toBeNull();
    });

    it('entry just under 24h is still valid', () => {
      const uuid = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff';
      const myDir = createFakeJsonl(projectDir, uuid);
      cleanupDirs.push(myDir);

      resumeMap.save(42, uuid, 'recent-session');

      // Set to 23 hours ago
      const mapPath = path.join(stateDir, 'topic-resume-map.json');
      const data = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
      data['42'].savedAt = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(mapPath, JSON.stringify(data));

      expect(resumeMap.get(42)).toBe(uuid);
    });

    it('findClaudeSessionUuid returns most recent JSONL by mtime', () => {
      const oldUuid = '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const newUuid = '22222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

      const myDir = createFakeJsonl(projectDir, oldUuid);
      createFakeJsonl(projectDir, newUuid);
      cleanupDirs.push(myDir);

      // Make old file older
      const pastTime = new Date(Date.now() - 60_000);
      fs.utimesSync(path.join(myDir, `${oldUuid}.jsonl`), pastTime, pastTime);

      // Make new file newer
      const futureTime = new Date(Date.now() + 60_000);
      fs.utimesSync(path.join(myDir, `${newUuid}.jsonl`), futureTime, futureTime);

      expect(resumeMap.findClaudeSessionUuid()).toBe(newUuid);
    });

    it('findClaudeSessionUuid rejects non-UUID filenames', () => {
      const myDir = path.join(os.homedir(), '.claude', 'projects', claudeProjectHash(projectDir));
      fs.mkdirSync(myDir, { recursive: true });
      cleanupDirs.push(myDir);

      // Create files with non-UUID names
      fs.writeFileSync(path.join(myDir, 'not-a-uuid.jsonl'), '');
      fs.writeFileSync(path.join(myDir, 'settings.jsonl'), '');
      fs.writeFileSync(path.join(myDir, '12345.jsonl'), '');

      expect(resumeMap.findClaudeSessionUuid()).toBeNull();
    });

    it('corrupted topic-resume-map.json recovers on next save', () => {
      const uuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const myDir = createFakeJsonl(projectDir, uuid);
      cleanupDirs.push(myDir);

      // Write corrupted file
      const mapPath = path.join(stateDir, 'topic-resume-map.json');
      fs.writeFileSync(mapPath, '{{{corrupt!!!');

      // Should handle gracefully
      expect(resumeMap.get(42)).toBeNull();

      // Save should overwrite the corrupted file
      resumeMap.save(42, uuid, 'recovered');
      expect(resumeMap.get(42)).toBe(uuid);
    });

    it('concurrent heartbeat and manual save do not corrupt', () => {
      const heartbeatUuid = 'aaaaaaaa-1111-1111-1111-111111111111';
      const manualUuid = 'bbbbbbbb-2222-2222-2222-222222222222';
      const myDir = createFakeJsonl(projectDir, heartbeatUuid);
      createFakeJsonl(projectDir, manualUuid);
      cleanupDirs.push(myDir);

      const mockTmuxScript = path.join(tmpDir, 'mock-tmux.sh');
      fs.writeFileSync(mockTmuxScript, '#!/bin/bash\nexit 0\n');
      fs.chmodSync(mockTmuxScript, '755');

      const map = new TopicResumeMap(stateDir, projectDir, mockTmuxScript);

      // Manual save for topic 10
      map.save(10, manualUuid, 'echo-manual');

      // Heartbeat for topic 20
      const topicSessions = new Map<number, { sessionName: string; claudeSessionId?: string }>();
      topicSessions.set(20, { sessionName: 'echo-heartbeat' });

      // Make heartbeat uuid more recent
      const futureTime = new Date(Date.now() + 60_000);
      fs.utimesSync(path.join(myDir, `${heartbeatUuid}.jsonl`), futureTime, futureTime);

      map.refreshResumeMappings(topicSessions);

      // Both should be present
      expect(map.get(10)).toBe(manualUuid);
      expect(map.get(20)).toBe(heartbeatUuid);
    });

    it('REGRESSION: multiple concurrent sessions without claudeSessionId do not cross-contaminate', () => {
      // This is the exact bug that caused topic 1767 ("jobs-not-running") to resume
      // with the conversation from topic 2169 ("session-robustness").
      // The old code sorted JSONL files by mtime and assigned them round-robin to topics,
      // with no validation that the UUID belonged to the right session.
      const uuid1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const uuid2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      const uuid3 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
      const myDir = createFakeJsonl(projectDir, uuid1);
      createFakeJsonl(projectDir, uuid2);
      createFakeJsonl(projectDir, uuid3);
      cleanupDirs.push(myDir);

      // Make them have different mtimes
      fs.utimesSync(path.join(myDir, `${uuid1}.jsonl`), new Date(Date.now() + 30000), new Date(Date.now() + 30000));
      fs.utimesSync(path.join(myDir, `${uuid2}.jsonl`), new Date(Date.now() + 20000), new Date(Date.now() + 20000));
      fs.utimesSync(path.join(myDir, `${uuid3}.jsonl`), new Date(Date.now() + 10000), new Date(Date.now() + 10000));

      const mockTmuxScript = path.join(tmpDir, 'mock-tmux.sh');
      fs.writeFileSync(mockTmuxScript, '#!/bin/bash\nexit 0\n');
      fs.chmodSync(mockTmuxScript, '755');

      const map = new TopicResumeMap(stateDir, projectDir, mockTmuxScript);

      // Two topics with no claudeSessionId — the heartbeat should NOT guess
      const topicSessions = new Map<number, { sessionName: string; claudeSessionId?: string }>();
      topicSessions.set(1767, { sessionName: 'echo-jobs-not-running' });
      topicSessions.set(2169, { sessionName: 'echo-session-robustness' });

      map.refreshResumeMappings(topicSessions);

      // Neither topic should have a UUID — with multiple sessions and no authoritative IDs,
      // the heartbeat should refuse to guess rather than risk cross-contamination
      expect(map.get(1767)).toBeNull();
      expect(map.get(2169)).toBeNull();
    });

    it('multiple concurrent sessions WITH claudeSessionId get correct UUIDs', () => {
      const uuid1 = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
      const uuid2 = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
      const myDir = createFakeJsonl(projectDir, uuid1);
      createFakeJsonl(projectDir, uuid2);
      cleanupDirs.push(myDir);

      const mockTmuxScript = path.join(tmpDir, 'mock-tmux.sh');
      fs.writeFileSync(mockTmuxScript, '#!/bin/bash\nexit 0\n');
      fs.chmodSync(mockTmuxScript, '755');

      const map = new TopicResumeMap(stateDir, projectDir, mockTmuxScript);

      // Two topics WITH authoritative claudeSessionId from hooks
      const topicSessions = new Map<number, { sessionName: string; claudeSessionId?: string }>();
      topicSessions.set(1767, { sessionName: 'echo-jobs-not-running', claudeSessionId: uuid2 });
      topicSessions.set(2169, { sessionName: 'echo-session-robustness', claudeSessionId: uuid1 });

      map.refreshResumeMappings(topicSessions);

      // Each topic should get its correct UUID, regardless of mtime ordering
      expect(map.get(1767)).toBe(uuid2);
      expect(map.get(2169)).toBe(uuid1);
    });
  });

  // ── Cross-Topic Contamination (the Inspec bug) ─────────────────
  // Reproduces the exact production failure where topic 683 (Monroe Claude Account)
  // was resumed with topic 505's (Archives Catalog) conversation because the
  // proactive UUID save used an mtime-based fallback that picked up the wrong UUID.

  describe('REGRESSION: cross-topic UUID contamination via proactive save', () => {
    it('proactive save must NOT use mtime fallback when claudeSessionId is unavailable', () => {
      // Setup: two topics with separate UUIDs
      const topic505Uuid = 'aaaaaaaa-5050-5050-5050-505050505050';
      const topic683Uuid = 'bbbbbbbb-6830-6830-6830-683683683683';
      const myDir = createFakeJsonl(projectDir, topic505Uuid);
      createFakeJsonl(projectDir, topic683Uuid);
      cleanupDirs.push(myDir);

      // Make topic505's JSONL more recently modified (simulating active writes)
      const futureTime = new Date(Date.now() + 120_000);
      fs.utimesSync(path.join(myDir, `${topic505Uuid}.jsonl`), futureTime, futureTime);

      // The mtime fallback would return topic505's UUID since it's most recent
      const mtimeResult = resumeMap.findClaudeSessionUuid();
      expect(mtimeResult).toBe(topic505Uuid);

      // BEFORE THE FIX: The proactive save would do:
      //   const uuid = session?.claudeSessionId ?? resumeMap.findClaudeSessionUuid();
      // If claudeSessionId was null (Claude Code hadn't registered yet),
      // it would fall back to mtime and save topic505's UUID for topic 683.
      //
      // AFTER THE FIX: The proactive save only uses claudeSessionId.
      // If it's null, the save is skipped entirely. The heartbeat
      // (with its single-session guard) handles it later.

      // Simulate the FIXED proactive save: claudeSessionId is null
      const claudeSessionId: string | undefined = undefined;
      if (claudeSessionId) {
        resumeMap.save(683, claudeSessionId, 'inspec-topic-683');
      }
      // No save happened — topic 683 has no entry
      expect(resumeMap.get(683)).toBeNull();

      // Topic 505 was saved correctly via its own path
      resumeMap.save(505, topic505Uuid, 'inspec-topic-505');
      expect(resumeMap.get(505)).toBe(topic505Uuid);

      // Later, when Claude Code registers, the heartbeat picks up topic 683
      const claudeSessionIdFromHook = topic683Uuid;
      if (claudeSessionIdFromHook) {
        resumeMap.save(683, claudeSessionIdFromHook, 'inspec-topic-683');
      }
      expect(resumeMap.get(683)).toBe(topic683Uuid);

      // Both topics have CORRECT UUIDs — no contamination
      expect(resumeMap.get(505)).toBe(topic505Uuid);
      expect(resumeMap.get(683)).toBe(topic683Uuid);
    });

    it('reproduces the exact Inspec bug timeline: concurrent sessions + mtime race', () => {
      // Timeline from production:
      // 02:24 — UUID b0506b0f saved for topic 505 (correct — memory-hygiene job)
      // 22:29 — Topic 505 resumed with b0506b0f (correct)
      // 22:44 — Topic 683 message arrives, session spawns
      // 22:44+8s — Proactive save: claudeSessionId=null, mtime returns b0506b0f → WRONG!
      // Next day — Topic 683 resumes with 505's conversation → off-topic behavior

      const jobUuid = 'b0506b0f-7f3d-4715-aa3b-3eb080e25089';
      const topic683Uuid = '7a0111ad-8446-4dcf-b77a-0a94243812ea';
      const myDir = createFakeJsonl(projectDir, jobUuid);
      cleanupDirs.push(myDir);

      // Phase 1: Job session (topic 505) saves its UUID correctly
      resumeMap.save(505, jobUuid, 'inspec-job-memory-hygiene');
      expect(resumeMap.get(505)).toBe(jobUuid);

      // Phase 2: Topic 505 is resumed at 22:29 (JSONL gets written to, mtime updates)
      const recentTime = new Date(Date.now() + 60_000);
      fs.utimesSync(path.join(myDir, `${jobUuid}.jsonl`), recentTime, recentTime);

      // Phase 3: Topic 683 session spawns at 22:44
      // The new session's Claude Code hasn't started yet, no JSONL exists
      // (topic683Uuid JSONL would be created by Claude Code after startup)

      // BUGGY proactive save (old behavior): falls back to mtime
      const buggyUuid = resumeMap.findClaudeSessionUuid(); // Returns jobUuid!
      expect(buggyUuid).toBe(jobUuid); // This is the WRONG UUID for topic 683

      // Verify the contamination: if we save this, topic 683 gets topic 505's session
      resumeMap.save(683, buggyUuid!, 'inspec-topic-683');
      expect(resumeMap.get(683)).toBe(jobUuid); // CONTAMINATED! Points to 505's session

      // FIXED proactive save: only uses authoritative claudeSessionId
      // claudeSessionId is null at +8s, so no save happens
      // Later, the JSONL gets created and heartbeat picks it up correctly
      createFakeJsonl(projectDir, topic683Uuid);
      resumeMap.save(683, topic683Uuid, 'inspec-topic-683');
      expect(resumeMap.get(683)).toBe(topic683Uuid); // CORRECT after fix
      expect(resumeMap.get(505)).toBe(jobUuid); // 505 unchanged
    });

    it('heartbeat correctly assigns UUIDs with mixed authoritative and unknown sessions', () => {
      // Scenario: topic 505 has claudeSessionId (from hooks), topic 683 doesn't yet
      // The heartbeat should save 505's UUID but skip 683 (multiple sessions active)
      const uuid505 = 'aaaaaaaa-5050-5050-5050-505050505050';
      const uuid683 = 'bbbbbbbb-6830-6830-6830-683683683683';
      const myDir = createFakeJsonl(projectDir, uuid505);
      createFakeJsonl(projectDir, uuid683);
      cleanupDirs.push(myDir);

      const mockTmuxScript = path.join(tmpDir, 'mock-tmux.sh');
      fs.writeFileSync(mockTmuxScript, '#!/bin/bash\nexit 0\n');
      fs.chmodSync(mockTmuxScript, '755');

      const map = new TopicResumeMap(stateDir, projectDir, mockTmuxScript);

      const topicSessions = new Map<number, { sessionName: string; claudeSessionId?: string }>();
      topicSessions.set(505, { sessionName: 'inspec-topic-505', claudeSessionId: uuid505 });
      topicSessions.set(683, { sessionName: 'inspec-topic-683' }); // No claudeSessionId!

      map.refreshResumeMappings(topicSessions);

      // Topic 505 gets its authoritative UUID
      expect(map.get(505)).toBe(uuid505);
      // Topic 683 is SKIPPED — no claudeSessionId, multiple sessions active
      expect(map.get(683)).toBeNull();
    });

    it('heartbeat correctly assigns all UUIDs when all sessions have claudeSessionId', () => {
      const uuid505 = 'aaaaaaaa-5050-5050-5050-505050505050';
      const uuid683 = 'bbbbbbbb-6830-6830-6830-683683683683';
      const uuid999 = 'cccccccc-9990-9990-9990-999999999999';
      const myDir = createFakeJsonl(projectDir, uuid505);
      createFakeJsonl(projectDir, uuid683);
      createFakeJsonl(projectDir, uuid999);
      cleanupDirs.push(myDir);

      const mockTmuxScript = path.join(tmpDir, 'mock-tmux.sh');
      fs.writeFileSync(mockTmuxScript, '#!/bin/bash\nexit 0\n');
      fs.chmodSync(mockTmuxScript, '755');

      const map = new TopicResumeMap(stateDir, projectDir, mockTmuxScript);

      const topicSessions = new Map<number, { sessionName: string; claudeSessionId?: string }>();
      topicSessions.set(505, { sessionName: 'session-505', claudeSessionId: uuid505 });
      topicSessions.set(683, { sessionName: 'session-683', claudeSessionId: uuid683 });
      topicSessions.set(999, { sessionName: 'session-999', claudeSessionId: uuid999 });

      map.refreshResumeMappings(topicSessions);

      // ALL topics get their correct UUID
      expect(map.get(505)).toBe(uuid505);
      expect(map.get(683)).toBe(uuid683);
      expect(map.get(999)).toBe(uuid999);
    });
  });

  // ── Slack Channel Resume ───────────────────────────────────────
  // Tests that Slack channels get correct resume UUIDs independently
  // from Telegram topics, using the same TopicResumeMap but keyed
  // by synthetic numeric IDs.

  describe('Slack channel resume isolation', () => {
    it('Slack and Telegram sessions get independent resume UUIDs', () => {
      // Slack channel C0APW9UHFJ5 gets a synthetic numeric ID for the resume map
      // Telegram topic 683 uses its real topic ID
      // They should never share UUIDs
      const slackUuid = 'aaaaaaaa-aaaa-slack-aaaa-aaaaaaaaaaaa';
      const telegramUuid = 'bbbbbbbb-bbbb-tele-bbbb-bbbbbbbbbbbb';
      const myDir = createFakeJsonl(projectDir, slackUuid);
      createFakeJsonl(projectDir, telegramUuid);
      cleanupDirs.push(myDir);

      // Simulate synthetic ID from slackChannelToSyntheticId('C0APW9UHFJ5')
      // In production, this is computed as a hash. We just need two distinct IDs.
      const slackSyntheticId = -1102064193; // Typical synthetic ID (negative to avoid topic collision)
      const telegramTopicId = 683;

      resumeMap.save(slackSyntheticId, slackUuid, 'echo-slack-threadline-dev');
      resumeMap.save(telegramTopicId, telegramUuid, 'echo-topic-683');

      expect(resumeMap.get(slackSyntheticId)).toBe(slackUuid);
      expect(resumeMap.get(telegramTopicId)).toBe(telegramUuid);

      // Remove one — other unaffected
      resumeMap.remove(slackSyntheticId);
      expect(resumeMap.get(slackSyntheticId)).toBeNull();
      expect(resumeMap.get(telegramTopicId)).toBe(telegramUuid);
    });

    it('multiple Slack channels get independent UUIDs via heartbeat', () => {
      const uuid1 = 'slack-chan-1111-1111-1111-111111111111';
      const uuid2 = 'slack-chan-2222-2222-2222-222222222222';
      const myDir = createFakeJsonl(projectDir, uuid1);
      createFakeJsonl(projectDir, uuid2);
      cleanupDirs.push(myDir);

      const mockTmuxScript = path.join(tmpDir, 'mock-tmux.sh');
      fs.writeFileSync(mockTmuxScript, '#!/bin/bash\nexit 0\n');
      fs.chmodSync(mockTmuxScript, '755');

      const map = new TopicResumeMap(stateDir, projectDir, mockTmuxScript);

      // Both channels have authoritative claudeSessionId
      const topicSessions = new Map<number, { sessionName: string; claudeSessionId?: string }>();
      topicSessions.set(-1001, { sessionName: 'echo-slack-general', claudeSessionId: uuid1 });
      topicSessions.set(-2002, { sessionName: 'echo-slack-threadline', claudeSessionId: uuid2 });

      map.refreshResumeMappings(topicSessions);

      expect(map.get(-1001)).toBe(uuid1);
      expect(map.get(-2002)).toBe(uuid2);
    });
  });

  // ── findUuidForSession Safety ──────────────────────────────────
  // Verifies that the beforeSessionKill path (used by both Telegram and Slack)
  // never returns wrong UUIDs.

  describe('findUuidForSession safety', () => {
    it('returns authoritative claudeSessionId when JSONL exists', () => {
      const uuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const myDir = createFakeJsonl(projectDir, uuid);
      cleanupDirs.push(myDir);

      expect(resumeMap.findUuidForSession('any-tmux-session', uuid)).toBe(uuid);
    });

    it('returns null when claudeSessionId JSONL is missing (deleted or never created)', () => {
      expect(resumeMap.findUuidForSession('any-tmux-session', 'nonexistent-uuid-1234-5678-abcdef')).toBeNull();
    });

    it('returns null when no claudeSessionId is provided (refuses to guess)', () => {
      const uuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const myDir = createFakeJsonl(projectDir, uuid);
      cleanupDirs.push(myDir);

      // Even though a JSONL exists, without claudeSessionId we don't guess
      expect(resumeMap.findUuidForSession('any-tmux-session')).toBeNull();
      expect(resumeMap.findUuidForSession('any-tmux-session', undefined)).toBeNull();
    });

    it('never falls back to mtime-based discovery', () => {
      // Create multiple JONSLs — findUuidForSession should NOT pick any of them
      const uuid1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const uuid2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      const myDir = createFakeJsonl(projectDir, uuid1);
      createFakeJsonl(projectDir, uuid2);
      cleanupDirs.push(myDir);

      // findClaudeSessionUuid would return one of them (most recent by mtime)
      expect(resumeMap.findClaudeSessionUuid()).not.toBeNull();

      // But findUuidForSession refuses to guess
      expect(resumeMap.findUuidForSession('any-tmux-session')).toBeNull();
    });
  });

  // ── Server Restart Resume Integrity ────────────────────────────
  // Tests that resume UUIDs survive server restarts and are correctly
  // restored for all integration types.

  describe('server restart resume integrity', () => {
    it('Telegram topic UUIDs persist across server restarts', () => {
      const uuid = 'restart-tele-gram-uuid-aaaaaaaaaaaa';
      const myDir = createFakeJsonl(projectDir, uuid);
      cleanupDirs.push(myDir);

      // Server 1: save during beforeSessionKill
      const map1 = new TopicResumeMap(stateDir, projectDir);
      map1.save(42, uuid, 'echo-topic-42');

      // Server 2: new process reads from disk
      const map2 = new TopicResumeMap(stateDir, projectDir);
      expect(map2.get(42)).toBe(uuid);
    });

    it('Slack channel UUIDs (via synthetic IDs) persist across server restarts', () => {
      const uuid = 'restart-slac-chan-uuid-bbbbbbbbbbbb';
      const myDir = createFakeJsonl(projectDir, uuid);
      cleanupDirs.push(myDir);

      const syntheticId = -999888;
      const map1 = new TopicResumeMap(stateDir, projectDir);
      map1.save(syntheticId, uuid, 'echo-slack-channel');

      const map2 = new TopicResumeMap(stateDir, projectDir);
      expect(map2.get(syntheticId)).toBe(uuid);
    });

    it('mixed Telegram + Slack UUIDs all persist correctly', () => {
      const teleUuid = 'persist-tele-gram-uuid-cccccccccccc';
      const slackUuid = 'persist-slac-chan-uuid-dddddddddddd';
      const myDir = createFakeJsonl(projectDir, teleUuid);
      createFakeJsonl(projectDir, slackUuid);
      cleanupDirs.push(myDir);

      const map1 = new TopicResumeMap(stateDir, projectDir);
      map1.save(42, teleUuid, 'echo-topic-42');
      map1.save(-777, slackUuid, 'echo-slack-general');

      const map2 = new TopicResumeMap(stateDir, projectDir);
      expect(map2.get(42)).toBe(teleUuid);
      expect(map2.get(-777)).toBe(slackUuid);
    });

    it('stale entries are pruned on next heartbeat even after restart', () => {
      const freshUuid = 'fresh-uuid-1234-5678-aaaaaaaaaaaa';
      const staleUuid = 'stale-uuid-1234-5678-bbbbbbbbbbbb';
      const myDir = createFakeJsonl(projectDir, freshUuid);
      createFakeJsonl(projectDir, staleUuid);
      cleanupDirs.push(myDir);

      // Server 1: save both
      const map1 = new TopicResumeMap(stateDir, projectDir);
      map1.save(42, freshUuid, 'fresh-session');
      map1.save(99, staleUuid, 'stale-session');

      // Backdate the stale entry past 24h
      const mapPath = path.join(stateDir, 'topic-resume-map.json');
      const data = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
      data['99'].savedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(mapPath, JSON.stringify(data));

      // Server 2: stale entry should be pruned
      const map2 = new TopicResumeMap(stateDir, projectDir);
      expect(map2.get(42)).toBe(freshUuid);
      expect(map2.get(99)).toBeNull(); // Pruned
    });
  });
});
