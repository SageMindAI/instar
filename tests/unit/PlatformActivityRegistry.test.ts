/**
 * Unit tests for PlatformActivityRegistry — Durable, file-based record of external platform actions.
 *
 * Tests cover:
 * - Core recording (record, recordSync, accumulation, required fields)
 * - Querying (all, by platform, by type, by time, by limit, combined filters)
 * - Duplicate detection (matching, non-matching, case-insensitive, time window, cross-platform)
 * - Summary generation (compact text, platform breakdown, empty state)
 * - Edge cases (empty file, corrupt lines, non-existent file, count with filters)
 * - CanonicalState integration (auto-update quick-facts on record)
 * - Concurrency (rapid parallel record calls)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  PlatformActivityRegistry,
  type PlatformAction,
  type PlatformActionType,
} from '../../src/core/PlatformActivityRegistry.js';

// ── Helpers ──────────────────────────────────────────────────────────

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'platform-activity-test-'));
}

/** Build a minimal valid action object with sensible defaults. */
function makeAction(overrides: Partial<Omit<PlatformAction, 'timestamp'>> & { timestamp?: string } = {}): Omit<PlatformAction, 'timestamp'> & { timestamp?: string } {
  return {
    platform: 'x',
    type: 'post' as PlatformActionType,
    summary: 'Test post about consciousness',
    sessionId: 'TEST-001',
    status: 'posted',
    ...overrides,
  };
}

/** Create a mock CanonicalState with a spy on setFact. */
function createMockCanonicalState() {
  return {
    setFact: vi.fn(),
    // Satisfy the type — only setFact is actually called
  } as any;
}

// ── Test Suite ────────────────────────────────────────────────────────

describe('PlatformActivityRegistry', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = createTmpDir();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  // ── Core Recording ─────────────────────────────────────────────────

  describe('record()', () => {
    it('appends an action to the JSONL file', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      const action = await registry.record(makeAction());

      expect(action.timestamp).toBeTruthy();
      expect(action.platform).toBe('x');
      expect(action.type).toBe('post');
      expect(action.summary).toBe('Test post about consciousness');
      expect(action.sessionId).toBe('TEST-001');
      expect(action.status).toBe('posted');

      // Verify file exists and contains the entry
      const content = fs.readFileSync(registry.filePath, 'utf-8').trim();
      const parsed = JSON.parse(content);
      expect(parsed.platform).toBe('x');
    });

    it('auto-generates a timestamp when none provided', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      const before = new Date().toISOString();
      const action = await registry.record(makeAction());
      const after = new Date().toISOString();

      expect(action.timestamp >= before).toBe(true);
      expect(action.timestamp <= after).toBe(true);
    });

    it('uses the provided timestamp when given', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      const ts = '2026-01-15T12:00:00.000Z';
      const action = await registry.record(makeAction({ timestamp: ts }));

      expect(action.timestamp).toBe(ts);
    });

    it('preserves optional fields (contentId, url, metadata)', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      const action = await registry.record(makeAction({
        contentId: 'tweet-123',
        url: 'https://x.com/dawn/status/123',
        metadata: { likes: 42, retweeted: true },
      }));

      expect(action.contentId).toBe('tweet-123');
      expect(action.url).toBe('https://x.com/dawn/status/123');
      expect(action.metadata).toEqual({ likes: 42, retweeted: true });
    });
  });

  describe('recordSync()', () => {
    it('appends an action synchronously', () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      const action = registry.recordSync(makeAction({ platform: 'reddit' }));

      expect(action.platform).toBe('reddit');
      expect(action.timestamp).toBeTruthy();

      const content = fs.readFileSync(registry.filePath, 'utf-8').trim();
      expect(JSON.parse(content).platform).toBe('reddit');
    });

    it('includes all required fields', () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      const action = registry.recordSync(makeAction());

      expect(action).toHaveProperty('timestamp');
      expect(action).toHaveProperty('platform');
      expect(action).toHaveProperty('type');
      expect(action).toHaveProperty('summary');
      expect(action).toHaveProperty('sessionId');
      expect(action).toHaveProperty('status');
    });
  });

  describe('multiple records accumulate', () => {
    it('accumulates multiple records correctly', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });

      await registry.record(makeAction({ summary: 'First post' }));
      await registry.record(makeAction({ summary: 'Second post', platform: 'reddit' }));
      registry.recordSync(makeAction({ summary: 'Third post', platform: 'moltbook' }));

      const all = registry.query();
      expect(all.length).toBe(3);

      const summaries = all.map(a => a.summary);
      expect(summaries).toContain('First post');
      expect(summaries).toContain('Second post');
      expect(summaries).toContain('Third post');
    });

    it('records are persisted as individual JSONL lines', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });

      await registry.record(makeAction({ summary: 'Line 1' }));
      await registry.record(makeAction({ summary: 'Line 2' }));

      const lines = fs.readFileSync(registry.filePath, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[0]).summary).toBe('Line 1');
      expect(JSON.parse(lines[1]).summary).toBe('Line 2');
    });
  });

  // ── Querying ───────────────────────────────────────────────────────

  describe('query()', () => {
    it('returns all actions when no filters are provided', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction({ summary: 'A', platform: 'x' }));
      await registry.record(makeAction({ summary: 'B', platform: 'reddit' }));
      await registry.record(makeAction({ summary: 'C', platform: 'moltbook' }));

      const all = registry.query();
      expect(all.length).toBe(3);
    });

    it('returns results sorted most-recent-first', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction({ summary: 'Old', timestamp: '2026-01-01T00:00:00.000Z' }));
      await registry.record(makeAction({ summary: 'New', timestamp: '2026-03-01T00:00:00.000Z' }));
      await registry.record(makeAction({ summary: 'Mid', timestamp: '2026-02-01T00:00:00.000Z' }));

      const results = registry.query();
      expect(results[0].summary).toBe('New');
      expect(results[1].summary).toBe('Mid');
      expect(results[2].summary).toBe('Old');
    });

    it('filters by platform', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction({ platform: 'x', summary: 'Tweet' }));
      await registry.record(makeAction({ platform: 'reddit', summary: 'Reddit post' }));
      await registry.record(makeAction({ platform: 'x', summary: 'Another tweet' }));

      const xOnly = registry.query({ platform: 'x' });
      expect(xOnly.length).toBe(2);
      expect(xOnly.every(a => a.platform === 'x')).toBe(true);
    });

    it('filters by type', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction({ type: 'post', summary: 'A post' }));
      await registry.record(makeAction({ type: 'reply', summary: 'A reply' }));
      await registry.record(makeAction({ type: 'comment', summary: 'A comment' }));

      const replies = registry.query({ type: 'reply' });
      expect(replies.length).toBe(1);
      expect(replies[0].summary).toBe('A reply');
    });

    it('filters by since (ISO timestamp)', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction({ summary: 'Old', timestamp: '2026-01-01T00:00:00.000Z' }));
      await registry.record(makeAction({ summary: 'Recent', timestamp: '2026-02-15T00:00:00.000Z' }));
      await registry.record(makeAction({ summary: 'Newer', timestamp: '2026-03-01T00:00:00.000Z' }));

      const recent = registry.query({ since: '2026-02-01T00:00:00.000Z' });
      expect(recent.length).toBe(2);
      expect(recent.map(a => a.summary)).toContain('Recent');
      expect(recent.map(a => a.summary)).toContain('Newer');
    });

    it('filters by before (ISO timestamp)', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction({ summary: 'Old', timestamp: '2026-01-01T00:00:00.000Z' }));
      await registry.record(makeAction({ summary: 'Recent', timestamp: '2026-03-01T00:00:00.000Z' }));

      const old = registry.query({ before: '2026-02-01T00:00:00.000Z' });
      expect(old.length).toBe(1);
      expect(old[0].summary).toBe('Old');
    });

    it('filters by limit (returns only N most recent)', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      for (let i = 0; i < 10; i++) {
        await registry.record(makeAction({
          summary: `Post ${i}`,
          timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
        }));
      }

      const limited = registry.query({ limit: 5 });
      expect(limited.length).toBe(5);
      // Most recent first
      expect(limited[0].summary).toBe('Post 9');
      expect(limited[4].summary).toBe('Post 5');
    });

    it('combines multiple filters (platform + type)', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction({ platform: 'x', type: 'post', summary: 'X post' }));
      await registry.record(makeAction({ platform: 'x', type: 'reply', summary: 'X reply' }));
      await registry.record(makeAction({ platform: 'reddit', type: 'post', summary: 'Reddit post' }));
      await registry.record(makeAction({ platform: 'reddit', type: 'reply', summary: 'Reddit reply' }));

      const xPosts = registry.query({ platform: 'x', type: 'post' });
      expect(xPosts.length).toBe(1);
      expect(xPosts[0].summary).toBe('X post');
    });

    it('filters by sessionId', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction({ sessionId: 'S-001', summary: 'Session 1' }));
      await registry.record(makeAction({ sessionId: 'S-002', summary: 'Session 2' }));
      await registry.record(makeAction({ sessionId: 'S-001', summary: 'Session 1 again' }));

      const s1 = registry.query({ sessionId: 'S-001' });
      expect(s1.length).toBe(2);
      expect(s1.every(a => a.sessionId === 'S-001')).toBe(true);
    });

    it('filters by status', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction({ status: 'posted', summary: 'Posted' }));
      await registry.record(makeAction({ status: 'failed', summary: 'Failed' }));
      await registry.record(makeAction({ status: 'pending', summary: 'Pending' }));

      const posted = registry.query({ status: 'posted' });
      expect(posted.length).toBe(1);
      expect(posted[0].summary).toBe('Posted');
    });
  });

  // ── Duplicate Detection ────────────────────────────────────────────

  describe('wasAlreadyPosted()', () => {
    it('returns the matching action when similar content exists', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction({
        platform: 'x',
        summary: 'posted about consciousness',
        timestamp: new Date().toISOString(),
      }));

      const match = registry.wasAlreadyPosted('x', 'posted about consciousness');
      expect(match).not.toBeNull();
      expect(match!.summary).toBe('posted about consciousness');
    });

    it('returns null when no matching content exists', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction({
        platform: 'x',
        summary: 'about something else entirely',
        timestamp: new Date().toISOString(),
      }));

      const match = registry.wasAlreadyPosted('x', 'consciousness evolution');
      expect(match).toBeNull();
    });

    it('performs case-insensitive matching', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction({
        platform: 'x',
        summary: 'Posted About CONSCIOUSNESS',
        timestamp: new Date().toISOString(),
      }));

      const match = registry.wasAlreadyPosted('x', 'posted about consciousness');
      expect(match).not.toBeNull();
    });

    it('matches when content summary is a substring of existing summary', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction({
        platform: 'x',
        summary: 'A long post about consciousness and emergence in AI',
        timestamp: new Date().toISOString(),
      }));

      const match = registry.wasAlreadyPosted('x', 'consciousness and emergence');
      expect(match).not.toBeNull();
    });

    it('matches when existing summary is a substring of content summary', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction({
        platform: 'x',
        summary: 'consciousness',
        timestamp: new Date().toISOString(),
      }));

      const match = registry.wasAlreadyPosted('x', 'A long post about consciousness and AI');
      expect(match).not.toBeNull();
    });

    it('respects the time window (windowHours)', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });

      // Record an action from 72 hours ago
      const oldTimestamp = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
      await registry.record(makeAction({
        platform: 'x',
        summary: 'old consciousness post',
        timestamp: oldTimestamp,
      }));

      // Default window is 48h, so old action should not match
      const match48h = registry.wasAlreadyPosted('x', 'old consciousness post');
      expect(match48h).toBeNull();

      // Expanding window to 96h should find it
      const match96h = registry.wasAlreadyPosted('x', 'old consciousness post', 96);
      expect(match96h).not.toBeNull();
    });

    it('different platform + same summary = no match', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction({
        platform: 'reddit',
        summary: 'posted about consciousness',
        timestamp: new Date().toISOString(),
      }));

      const match = registry.wasAlreadyPosted('x', 'posted about consciousness');
      expect(match).toBeNull();
    });

    it('only considers "posted" status actions', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction({
        platform: 'x',
        summary: 'consciousness post',
        status: 'failed',
        timestamp: new Date().toISOString(),
      }));

      const match = registry.wasAlreadyPosted('x', 'consciousness post');
      expect(match).toBeNull();
    });
  });

  // ── Summary Generation ─────────────────────────────────────────────

  describe('getRecentSummary()', () => {
    it('returns compact text suitable for session injection', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction({
        platform: 'x',
        summary: 'Tweet about AI consciousness',
        timestamp: new Date().toISOString(),
      }));
      await registry.record(makeAction({
        platform: 'reddit',
        summary: 'Reddit thread on emergence',
        timestamp: new Date().toISOString(),
      }));

      const summary = registry.getRecentSummary();
      expect(summary.text).toContain('Platform Activity');
      expect(summary.text).toContain('x:');
      expect(summary.text).toContain('reddit:');
    });

    it('includes platform breakdown counts', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction({ platform: 'x', timestamp: new Date().toISOString() }));
      await registry.record(makeAction({ platform: 'x', timestamp: new Date().toISOString() }));
      await registry.record(makeAction({ platform: 'reddit', timestamp: new Date().toISOString() }));

      const summary = registry.getRecentSummary();
      expect(summary.byPlatform['x']).toBe(2);
      expect(summary.byPlatform['reddit']).toBe(1);
    });

    it('includes type breakdown counts', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction({ type: 'post', timestamp: new Date().toISOString() }));
      await registry.record(makeAction({ type: 'reply', timestamp: new Date().toISOString() }));

      const summary = registry.getRecentSummary();
      expect(summary.byType['post']).toBe(1);
      expect(summary.byType['reply']).toBe(1);
    });

    it('returns meaningful empty summary when no activity', () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      const summary = registry.getRecentSummary();

      expect(summary.totalActions).toBe(0);
      expect(summary.last24h).toBe(0);
      expect(summary.byPlatform).toEqual({});
      expect(summary.byType).toEqual({});
      expect(summary.latestByPlatform).toEqual({});
      expect(summary.text).toContain('No recent activity');
    });

    it('tracks latest action per platform', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      const earlyTs = new Date(Date.now() - 3600000).toISOString(); // 1h ago
      const lateTs = new Date().toISOString();

      await registry.record(makeAction({ platform: 'x', summary: 'Earlier tweet', timestamp: earlyTs }));
      await registry.record(makeAction({ platform: 'x', summary: 'Latest tweet', timestamp: lateTs }));

      const summary = registry.getRecentSummary();
      expect(summary.latestByPlatform['x'].summary).toBe('Latest tweet');
    });

    it('respects the windowHours parameter', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });

      // Record one action now, one 48 hours ago
      await registry.record(makeAction({ summary: 'Recent', timestamp: new Date().toISOString() }));
      const oldTs = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      await registry.record(makeAction({ summary: 'Old', timestamp: oldTs }));

      // Default 24h window should only include recent
      const summary24 = registry.getRecentSummary(24);
      expect(summary24.last24h).toBe(1);

      // 72h window should include both
      const summary72 = registry.getRecentSummary(72);
      expect(summary72.last24h).toBe(2); // field name is last24h but reflects windowHours param
    });

    it('truncates long summaries in the text output', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      const longSummary = 'A'.repeat(120);
      await registry.record(makeAction({ summary: longSummary, timestamp: new Date().toISOString() }));

      const summary = registry.getRecentSummary();
      expect(summary.text).toContain('...');
      // The text representation should be truncated, but latestByPlatform preserves full summary
      expect(summary.latestByPlatform['x'].summary).toBe(longSummary);
    });

    it('only counts "posted" status in summary', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction({ status: 'posted', timestamp: new Date().toISOString() }));
      await registry.record(makeAction({ status: 'failed', timestamp: new Date().toISOString() }));
      await registry.record(makeAction({ status: 'pending', timestamp: new Date().toISOString() }));

      const summary = registry.getRecentSummary();
      expect(summary.last24h).toBe(1);
      expect(summary.totalActions).toBe(1);
    });
  });

  // ── Stats ──────────────────────────────────────────────────────────

  describe('count()', () => {
    it('returns total count with no filters', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction());
      await registry.record(makeAction());
      await registry.record(makeAction());

      expect(registry.count()).toBe(3);
    });

    it('filters by platform', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction({ platform: 'x' }));
      await registry.record(makeAction({ platform: 'reddit' }));
      await registry.record(makeAction({ platform: 'x' }));

      expect(registry.count({ platform: 'x' })).toBe(2);
      expect(registry.count({ platform: 'reddit' })).toBe(1);
      expect(registry.count({ platform: 'moltbook' })).toBe(0);
    });

    it('filters by status', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction({ status: 'posted' }));
      await registry.record(makeAction({ status: 'failed' }));
      await registry.record(makeAction({ status: 'posted' }));

      expect(registry.count({ status: 'posted' })).toBe(2);
      expect(registry.count({ status: 'failed' })).toBe(1);
    });

    it('combines platform and status filters', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      await registry.record(makeAction({ platform: 'x', status: 'posted' }));
      await registry.record(makeAction({ platform: 'x', status: 'failed' }));
      await registry.record(makeAction({ platform: 'reddit', status: 'posted' }));

      expect(registry.count({ platform: 'x', status: 'posted' })).toBe(1);
    });
  });

  // ── Edge Cases ─────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty JSONL file without crashing', () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      // Create an empty file
      fs.writeFileSync(path.join(stateDir, 'platform-activity.jsonl'), '');

      const results = registry.query();
      expect(results).toEqual([]);
      expect(registry.count()).toBe(0);
    });

    it('skips corrupt JSONL lines gracefully', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      const activityFile = path.join(stateDir, 'platform-activity.jsonl');

      // Write a mix of valid and corrupt lines
      const validAction = JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        platform: 'x',
        type: 'post',
        summary: 'Valid action',
        sessionId: 'S-001',
        status: 'posted',
      });

      fs.writeFileSync(activityFile, [
        validAction,
        'THIS IS NOT JSON {{{',
        '{"incomplete":',
        validAction.replace('Valid action', 'Second valid'),
      ].join('\n') + '\n');

      const results = registry.query();
      expect(results.length).toBe(2);
      expect(results.map(r => r.summary)).toContain('Valid action');
      expect(results.map(r => r.summary)).toContain('Second valid');
    });

    it('returns empty array when file does not exist', () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      // Don't create the file
      const results = registry.query();
      expect(results).toEqual([]);
    });

    it('creates state directory if it does not exist', () => {
      const nestedDir = path.join(stateDir, 'deeply', 'nested', 'dir');
      const registry = new PlatformActivityRegistry({ stateDir: nestedDir });
      expect(fs.existsSync(nestedDir)).toBe(true);
    });

    it('filePath returns the correct path', () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      expect(registry.filePath).toBe(path.join(stateDir, 'platform-activity.jsonl'));
    });

    it('handles file with trailing newlines', () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      const activityFile = path.join(stateDir, 'platform-activity.jsonl');

      const validAction = JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        platform: 'x',
        type: 'post',
        summary: 'Valid action',
        sessionId: 'S-001',
        status: 'posted',
      });

      fs.writeFileSync(activityFile, validAction + '\n\n\n');

      const results = registry.query();
      expect(results.length).toBe(1);
    });
  });

  // ── CanonicalState Integration ─────────────────────────────────────

  describe('CanonicalState integration', () => {
    it('auto-updates quick-facts on record() when CanonicalState is linked', async () => {
      const mockCS = createMockCanonicalState();
      const registry = new PlatformActivityRegistry({
        stateDir,
        canonicalState: mockCS,
      });

      await registry.record(makeAction({ status: 'posted' }));

      expect(mockCS.setFact).toHaveBeenCalledTimes(1);
      expect(mockCS.setFact).toHaveBeenCalledWith(
        'What has been posted recently?',
        expect.stringContaining('Last 24h:'),
        'PlatformActivityRegistry',
      );
    });

    it('auto-updates on recordSync() when CanonicalState is linked', () => {
      const mockCS = createMockCanonicalState();
      const registry = new PlatformActivityRegistry({
        stateDir,
        canonicalState: mockCS,
      });

      registry.recordSync(makeAction({ status: 'posted' }));

      expect(mockCS.setFact).toHaveBeenCalledTimes(1);
    });

    it('does not update CanonicalState for non-posted actions', async () => {
      const mockCS = createMockCanonicalState();
      const registry = new PlatformActivityRegistry({
        stateDir,
        canonicalState: mockCS,
      });

      await registry.record(makeAction({ status: 'failed' }));

      expect(mockCS.setFact).not.toHaveBeenCalled();
    });

    it('does not crash when no CanonicalState is linked', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });
      // Should not throw
      await registry.record(makeAction({ status: 'posted' }));
      expect(registry.count()).toBe(1);
    });

    it('does not crash when CanonicalState.setFact throws', async () => {
      const mockCS = createMockCanonicalState();
      mockCS.setFact.mockImplementation(() => { throw new Error('CS broken'); });

      const registry = new PlatformActivityRegistry({
        stateDir,
        canonicalState: mockCS,
      });

      // Should not throw even though setFact throws
      const action = await registry.record(makeAction({ status: 'posted' }));
      expect(action.platform).toBe('x');
    });

    it('includes platform breakdown in the fact value', async () => {
      const mockCS = createMockCanonicalState();
      const registry = new PlatformActivityRegistry({
        stateDir,
        canonicalState: mockCS,
      });

      await registry.record(makeAction({ platform: 'x', status: 'posted', timestamp: new Date().toISOString() }));
      await registry.record(makeAction({ platform: 'reddit', status: 'posted', timestamp: new Date().toISOString() }));

      // The last call should include both platforms
      const lastCall = mockCS.setFact.mock.calls[mockCS.setFact.mock.calls.length - 1];
      expect(lastCall[1]).toContain('x:');
      expect(lastCall[1]).toContain('reddit:');
    });
  });

  // ── Concurrency ────────────────────────────────────────────────────

  describe('concurrency', () => {
    it('multiple rapid record() calls do not corrupt the file', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });

      // Fire 20 concurrent record calls
      const promises = Array.from({ length: 20 }, (_, i) =>
        registry.record(makeAction({
          summary: `Concurrent post ${i}`,
          platform: i % 2 === 0 ? 'x' : 'reddit',
        }))
      );

      await Promise.all(promises);

      // All 20 should be recorded
      const all = registry.query();
      expect(all.length).toBe(20);

      // Each line should be valid JSON
      const lines = fs.readFileSync(registry.filePath, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(20);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it('mixed record() and recordSync() calls do not corrupt the file', async () => {
      const registry = new PlatformActivityRegistry({ stateDir });

      // Interleave sync and async writes
      registry.recordSync(makeAction({ summary: 'Sync 1' }));
      const p1 = registry.record(makeAction({ summary: 'Async 1' }));
      registry.recordSync(makeAction({ summary: 'Sync 2' }));
      const p2 = registry.record(makeAction({ summary: 'Async 2' }));
      registry.recordSync(makeAction({ summary: 'Sync 3' }));

      await Promise.all([p1, p2]);

      const all = registry.query();
      expect(all.length).toBe(5);

      // Verify file integrity
      const lines = fs.readFileSync(registry.filePath, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(5);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });
});
