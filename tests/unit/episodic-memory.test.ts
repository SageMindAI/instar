/**
 * Unit tests for EpisodicMemory — Activity digest + session synthesis storage.
 *
 * Tests:
 * - Activity digest CRUD (save, get, list by session)
 * - Idempotency (duplicate detection via hash key)
 * - Session synthesis CRUD
 * - Query methods: time range, theme, significance, recent activity
 * - Sentinel state persistence
 * - Pending queue (save, get, remove, retry increment)
 * - Stats aggregation
 * - Edge cases: empty state, missing directories, corrupt files
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EpisodicMemory } from '../../src/memory/EpisodicMemory.js';
import type { ActivityDigest, SessionSynthesis, BoundarySignal } from '../../src/memory/EpisodicMemory.js';

// ─── Test Helpers ───────────────────────────────────────────────────

interface TestSetup {
  dir: string;
  stateDir: string;
  memory: EpisodicMemory;
  cleanup: () => void;
}

function createTestMemory(): TestSetup {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'episodic-mem-test-'));
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const memory = new EpisodicMemory({ stateDir });
  return {
    dir,
    stateDir,
    memory,
    // safe-git-allow: incremental-migration
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function makeDigest(overrides: Partial<Omit<ActivityDigest, 'id'>> = {}): Omit<ActivityDigest, 'id'> {
  return {
    sessionId: 'session-1',
    sessionName: 'test-session',
    startedAt: '2026-02-27T10:00:00Z',
    endedAt: '2026-02-27T10:30:00Z',
    summary: 'Did some work on the feature.',
    actions: ['committed code', 'ran tests'],
    entities: ['entity-1'],
    learnings: ['FTS5 needs sync triggers'],
    significance: 5,
    themes: ['development', 'testing'],
    boundarySignal: 'task_complete' as BoundarySignal,
    ...overrides,
  };
}

function makeSynthesis(overrides: Partial<SessionSynthesis> = {}): SessionSynthesis {
  return {
    sessionId: 'session-1',
    sessionName: 'test-session',
    startedAt: '2026-02-27T09:00:00Z',
    endedAt: '2026-02-27T12:00:00Z',
    activityDigestIds: ['digest-1', 'digest-2'],
    summary: 'Built the feature and ran tests successfully.',
    keyOutcomes: ['Feature implemented', 'All tests passing'],
    allEntities: ['entity-1'],
    allLearnings: ['FTS5 needs sync triggers'],
    significance: 7,
    themes: ['development', 'testing'],
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('EpisodicMemory', () => {
  let setup: TestSetup;

  beforeEach(() => {
    setup = createTestMemory();
  });

  afterEach(() => {
    setup?.cleanup();
  });

  // ─── Directory Setup ────────────────────────────────────────────

  describe('initialization', () => {
    it('creates episode directories on construction', () => {
      const episodesDir = path.join(setup.stateDir, 'episodes');
      expect(fs.existsSync(episodesDir)).toBe(true);
      expect(fs.existsSync(path.join(episodesDir, 'activities'))).toBe(true);
      expect(fs.existsSync(path.join(episodesDir, 'sessions'))).toBe(true);
      expect(fs.existsSync(path.join(episodesDir, 'pending'))).toBe(true);
    });
  });

  // ─── Activity Digest CRUD ───────────────────────────────────────

  describe('saveDigest', () => {
    it('saves and retrieves an activity digest', () => {
      const digest = makeDigest();
      const id = setup.memory.saveDigest(digest);

      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');

      const retrieved = setup.memory.getDigest('session-1', id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(id);
      expect(retrieved!.summary).toBe('Did some work on the feature.');
      expect(retrieved!.actions).toEqual(['committed code', 'ran tests']);
      expect(retrieved!.significance).toBe(5);
      expect(retrieved!.boundarySignal).toBe('task_complete');
    });

    it('is idempotent — same session+start+end returns same ID', () => {
      const digest = makeDigest();
      const id1 = setup.memory.saveDigest(digest);
      const id2 = setup.memory.saveDigest(digest);

      expect(id1).toBe(id2);

      // Only one file should exist
      const sessionDir = path.join(setup.stateDir, 'episodes', 'activities', 'session-1');
      const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.json'));
      expect(files).toHaveLength(1);
    });

    it('creates distinct digests for different time windows', () => {
      const id1 = setup.memory.saveDigest(makeDigest({
        startedAt: '2026-02-27T10:00:00Z',
        endedAt: '2026-02-27T10:30:00Z',
      }));
      const id2 = setup.memory.saveDigest(makeDigest({
        startedAt: '2026-02-27T10:30:00Z',
        endedAt: '2026-02-27T11:00:00Z',
      }));

      expect(id1).not.toBe(id2);
    });

    it('creates per-session directories', () => {
      setup.memory.saveDigest(makeDigest({ sessionId: 'session-A' }));
      setup.memory.saveDigest(makeDigest({ sessionId: 'session-B' }));

      const activitiesDir = path.join(setup.stateDir, 'episodes', 'activities');
      expect(fs.existsSync(path.join(activitiesDir, 'session-A'))).toBe(true);
      expect(fs.existsSync(path.join(activitiesDir, 'session-B'))).toBe(true);
    });
  });

  describe('getDigest', () => {
    it('returns null for non-existent digest', () => {
      expect(setup.memory.getDigest('session-1', 'fake-id')).toBeNull();
    });

    it('returns null for non-existent session', () => {
      expect(setup.memory.getDigest('no-such-session', 'any-id')).toBeNull();
    });
  });

  describe('getSessionActivities', () => {
    it('returns digests ordered by startedAt', () => {
      setup.memory.saveDigest(makeDigest({
        startedAt: '2026-02-27T12:00:00Z',
        endedAt: '2026-02-27T12:30:00Z',
        summary: 'Third',
      }));
      setup.memory.saveDigest(makeDigest({
        startedAt: '2026-02-27T10:00:00Z',
        endedAt: '2026-02-27T10:30:00Z',
        summary: 'First',
      }));
      setup.memory.saveDigest(makeDigest({
        startedAt: '2026-02-27T11:00:00Z',
        endedAt: '2026-02-27T11:30:00Z',
        summary: 'Second',
      }));

      const activities = setup.memory.getSessionActivities('session-1');
      expect(activities).toHaveLength(3);
      expect(activities[0].summary).toBe('First');
      expect(activities[1].summary).toBe('Second');
      expect(activities[2].summary).toBe('Third');
    });

    it('returns empty array for unknown session', () => {
      expect(setup.memory.getSessionActivities('no-session')).toEqual([]);
    });
  });

  // ─── Session Synthesis CRUD ─────────────────────────────────────

  describe('saveSynthesis / getSynthesis', () => {
    it('saves and retrieves a session synthesis', () => {
      const synthesis = makeSynthesis();
      setup.memory.saveSynthesis(synthesis);

      const retrieved = setup.memory.getSynthesis('session-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.summary).toBe('Built the feature and ran tests successfully.');
      expect(retrieved!.keyOutcomes).toEqual(['Feature implemented', 'All tests passing']);
      expect(retrieved!.significance).toBe(7);
    });

    it('overwrites existing synthesis for same session', () => {
      setup.memory.saveSynthesis(makeSynthesis({ summary: 'First version' }));
      setup.memory.saveSynthesis(makeSynthesis({ summary: 'Updated version' }));

      const retrieved = setup.memory.getSynthesis('session-1');
      expect(retrieved!.summary).toBe('Updated version');
    });

    it('returns null for non-existent synthesis', () => {
      expect(setup.memory.getSynthesis('no-session')).toBeNull();
    });
  });

  describe('listSyntheses', () => {
    it('lists syntheses ordered by startedAt descending', () => {
      setup.memory.saveSynthesis(makeSynthesis({
        sessionId: 'session-1',
        startedAt: '2026-02-25T09:00:00Z',
        summary: 'Old',
      }));
      setup.memory.saveSynthesis(makeSynthesis({
        sessionId: 'session-3',
        startedAt: '2026-02-27T09:00:00Z',
        summary: 'Newest',
      }));
      setup.memory.saveSynthesis(makeSynthesis({
        sessionId: 'session-2',
        startedAt: '2026-02-26T09:00:00Z',
        summary: 'Middle',
      }));

      const all = setup.memory.listSyntheses();
      expect(all).toHaveLength(3);
      expect(all[0].summary).toBe('Newest');
      expect(all[1].summary).toBe('Middle');
      expect(all[2].summary).toBe('Old');
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        setup.memory.saveSynthesis(makeSynthesis({
          sessionId: `session-${i}`,
          startedAt: `2026-02-2${i}T09:00:00Z`,
        }));
      }

      expect(setup.memory.listSyntheses(2)).toHaveLength(2);
    });

    it('returns empty array when no syntheses exist', () => {
      expect(setup.memory.listSyntheses()).toEqual([]);
    });
  });

  // ─── Query Methods ──────────────────────────────────────────────

  describe('getByTimeRange', () => {
    it('returns digests within the specified time range', () => {
      setup.memory.saveDigest(makeDigest({
        sessionId: 'session-1',
        startedAt: '2026-02-26T10:00:00Z',
        endedAt: '2026-02-26T10:30:00Z',
        summary: 'Day before',
      }));
      setup.memory.saveDigest(makeDigest({
        sessionId: 'session-2',
        startedAt: '2026-02-27T10:00:00Z',
        endedAt: '2026-02-27T10:30:00Z',
        summary: 'Target day',
      }));
      setup.memory.saveDigest(makeDigest({
        sessionId: 'session-3',
        startedAt: '2026-02-28T10:00:00Z',
        endedAt: '2026-02-28T10:30:00Z',
        summary: 'Day after',
      }));

      const results = setup.memory.getByTimeRange('2026-02-27T00:00:00Z', '2026-02-27T23:59:59Z');
      expect(results).toHaveLength(1);
      expect(results[0].summary).toBe('Target day');
    });

    it('spans across sessions', () => {
      setup.memory.saveDigest(makeDigest({
        sessionId: 'session-A',
        startedAt: '2026-02-27T10:00:00Z',
        endedAt: '2026-02-27T10:30:00Z',
      }));
      setup.memory.saveDigest(makeDigest({
        sessionId: 'session-B',
        startedAt: '2026-02-27T11:00:00Z',
        endedAt: '2026-02-27T11:30:00Z',
      }));

      const results = setup.memory.getByTimeRange('2026-02-27T00:00:00Z', '2026-02-27T23:59:59Z');
      expect(results).toHaveLength(2);
    });
  });

  describe('getByTheme', () => {
    it('matches themes case-insensitively', () => {
      setup.memory.saveDigest(makeDigest({
        themes: ['Development', 'Testing'],
        summary: 'Dev work',
      }));

      const results = setup.memory.getByTheme('development');
      expect(results).toHaveLength(1);
      expect(results[0].summary).toBe('Dev work');
    });

    it('matches partial theme strings', () => {
      setup.memory.saveDigest(makeDigest({
        themes: ['memory-architecture'],
        summary: 'Memory work',
      }));

      const results = setup.memory.getByTheme('memory');
      expect(results).toHaveLength(1);
    });

    it('returns results sorted by significance descending', () => {
      setup.memory.saveDigest(makeDigest({
        sessionId: 's1',
        startedAt: '2026-02-27T10:00:00Z',
        endedAt: '2026-02-27T10:30:00Z',
        themes: ['testing'],
        significance: 3,
        summary: 'Low',
      }));
      setup.memory.saveDigest(makeDigest({
        sessionId: 's2',
        startedAt: '2026-02-27T11:00:00Z',
        endedAt: '2026-02-27T11:30:00Z',
        themes: ['testing'],
        significance: 8,
        summary: 'High',
      }));

      const results = setup.memory.getByTheme('testing');
      expect(results[0].summary).toBe('High');
      expect(results[1].summary).toBe('Low');
    });
  });

  describe('getBySignificance', () => {
    it('returns only digests at or above the threshold', () => {
      setup.memory.saveDigest(makeDigest({
        sessionId: 's1',
        startedAt: '2026-02-27T10:00:00Z',
        endedAt: '2026-02-27T10:30:00Z',
        significance: 3,
        summary: 'Minor',
      }));
      setup.memory.saveDigest(makeDigest({
        sessionId: 's2',
        startedAt: '2026-02-27T11:00:00Z',
        endedAt: '2026-02-27T11:30:00Z',
        significance: 8,
        summary: 'Major',
      }));

      const results = setup.memory.getBySignificance(7);
      expect(results).toHaveLength(1);
      expect(results[0].summary).toBe('Major');
    });

    it('returns results sorted by significance descending', () => {
      for (let i = 1; i <= 5; i++) {
        setup.memory.saveDigest(makeDigest({
          sessionId: `s${i}`,
          startedAt: `2026-02-27T${10 + i}:00:00Z`,
          endedAt: `2026-02-27T${10 + i}:30:00Z`,
          significance: i * 2,
        }));
      }

      const results = setup.memory.getBySignificance(4);
      expect(results.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].significance).toBeGreaterThanOrEqual(results[i].significance);
      }
    });
  });

  describe('getRecentActivity', () => {
    it('returns digests from the last N hours', () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

      setup.memory.saveDigest(makeDigest({
        sessionId: 'recent',
        startedAt: oneHourAgo.toISOString(),
        endedAt: now.toISOString(),
        summary: 'Recent work',
      }));
      setup.memory.saveDigest(makeDigest({
        sessionId: 'old',
        startedAt: threeDaysAgo.toISOString(),
        endedAt: threeDaysAgo.toISOString(),
        summary: 'Old work',
      }));

      const results = setup.memory.getRecentActivity(24, 10);
      expect(results).toHaveLength(1);
      expect(results[0].summary).toBe('Recent work');
    });

    it('respects limit parameter', () => {
      const now = new Date();
      for (let i = 0; i < 5; i++) {
        const t = new Date(now.getTime() - i * 60 * 60 * 1000);
        setup.memory.saveDigest(makeDigest({
          sessionId: `s${i}`,
          startedAt: t.toISOString(),
          endedAt: t.toISOString(),
        }));
      }

      const results = setup.memory.getRecentActivity(24, 3);
      expect(results).toHaveLength(3);
    });
  });

  // ─── Sentinel State ─────────────────────────────────────────────

  describe('sentinel state', () => {
    it('returns default state when no file exists', () => {
      const state = setup.memory.getSentinelState();
      expect(state.sessions).toEqual({});
      expect(new Date(state.lastScanAt).getFullYear()).toBeLessThanOrEqual(1970);
    });

    it('persists and retrieves sentinel state', () => {
      const state = {
        lastScanAt: '2026-02-27T10:00:00Z',
        sessions: {
          'session-1': {
            lastDigestedAt: '2026-02-27T09:30:00Z',
            digestCount: 3,
          },
        },
      };

      setup.memory.saveSentinelState(state);
      const retrieved = setup.memory.getSentinelState();
      expect(retrieved).toEqual(state);
    });

    it('overwrites previous state', () => {
      setup.memory.saveSentinelState({
        lastScanAt: '2026-02-27T10:00:00Z',
        sessions: {},
      });
      setup.memory.saveSentinelState({
        lastScanAt: '2026-02-27T12:00:00Z',
        sessions: { 's1': { lastDigestedAt: '2026-02-27T12:00:00Z', digestCount: 1 } },
      });

      const state = setup.memory.getSentinelState();
      expect(state.lastScanAt).toBe('2026-02-27T12:00:00Z');
      expect(Object.keys(state.sessions)).toHaveLength(1);
    });
  });

  // ─── Pending Queue ──────────────────────────────────────────────

  describe('pending queue', () => {
    it('saves and retrieves pending items', () => {
      const id = setup.memory.savePending('session-1', 'raw activity content');

      const items = setup.memory.getPending('session-1');
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(id);
      expect(items[0].content).toBe('raw activity content');
      expect(items[0].retryCount).toBe(0);
    });

    it('removes a pending item', () => {
      const id = setup.memory.savePending('session-1', 'content');
      setup.memory.removePending('session-1', id);

      expect(setup.memory.getPending('session-1')).toHaveLength(0);
    });

    it('increments retry count', () => {
      const id = setup.memory.savePending('session-1', 'content');

      const count1 = setup.memory.incrementPendingRetry('session-1', id);
      expect(count1).toBe(1);

      const count2 = setup.memory.incrementPendingRetry('session-1', id);
      expect(count2).toBe(2);

      const items = setup.memory.getPending('session-1');
      expect(items[0].retryCount).toBe(2);
    });

    it('returns -1 for incrementing non-existent item', () => {
      expect(setup.memory.incrementPendingRetry('s1', 'fake')).toBe(-1);
    });

    it('returns empty array for unknown session', () => {
      expect(setup.memory.getPending('no-session')).toEqual([]);
    });

    it('isolates pending items per session', () => {
      setup.memory.savePending('session-A', 'content A');
      setup.memory.savePending('session-B', 'content B');

      expect(setup.memory.getPending('session-A')).toHaveLength(1);
      expect(setup.memory.getPending('session-B')).toHaveLength(1);
      expect(setup.memory.getPending('session-A')[0].content).toBe('content A');
    });
  });

  // ─── Stats ──────────────────────────────────────────────────────

  describe('stats', () => {
    it('returns zeroes for empty memory', () => {
      const stats = setup.memory.stats();
      expect(stats.totalDigests).toBe(0);
      expect(stats.totalSyntheses).toBe(0);
      expect(stats.totalPending).toBe(0);
      expect(stats.sessionCount).toBe(0);
    });

    it('counts digests, syntheses, pending, and sessions', () => {
      // 2 sessions with 3 total digests
      setup.memory.saveDigest(makeDigest({
        sessionId: 'session-1',
        startedAt: '2026-02-27T10:00:00Z',
        endedAt: '2026-02-27T10:30:00Z',
      }));
      setup.memory.saveDigest(makeDigest({
        sessionId: 'session-1',
        startedAt: '2026-02-27T11:00:00Z',
        endedAt: '2026-02-27T11:30:00Z',
      }));
      setup.memory.saveDigest(makeDigest({
        sessionId: 'session-2',
        startedAt: '2026-02-27T10:00:00Z',
        endedAt: '2026-02-27T10:30:00Z',
      }));

      // 1 synthesis
      setup.memory.saveSynthesis(makeSynthesis({ sessionId: 'session-1' }));

      // 2 pending items
      setup.memory.savePending('session-1', 'pending 1');
      setup.memory.savePending('session-2', 'pending 2');

      const stats = setup.memory.stats();
      expect(stats.totalDigests).toBe(3);
      expect(stats.totalSyntheses).toBe(1);
      expect(stats.totalPending).toBe(2);
      expect(stats.sessionCount).toBe(2);
    });
  });
});
