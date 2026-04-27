/**
 * Unit tests for SubagentTracker — tracks Claude Code subagent lifecycle.
 *
 * Tests:
 * - Start tracking: records subagent spawns
 * - Stop tracking: captures output, marks completion
 * - Active/completed queries: filters by state
 * - Session summaries: aggregated stats
 * - Event emission: typed start/stop events
 * - Limits: per-session record cap
 * - Persistence: survives reconstruction
 * - Edge cases: stop without start, path traversal
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SubagentTracker } from '../../src/monitoring/SubagentTracker.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-subagent-test-'));
}

// ── Tests ────────────────────────────────────────────────────────

describe('SubagentTracker', () => {
  let tmpDir: string;
  let tracker: SubagentTracker;

  beforeEach(() => {
    tmpDir = createTempDir();
    tracker = new SubagentTracker({ stateDir: tmpDir });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Start Tracking ────────────────────────────────────────────

  describe('onStart()', () => {
    it('records a subagent start', () => {
      tracker.onStart('agent-1', 'Explore', 'session-1');

      const records = tracker.getSessionRecords('session-1');
      expect(records).toHaveLength(1);
      expect(records[0].agentId).toBe('agent-1');
      expect(records[0].agentType).toBe('Explore');
      expect(records[0].sessionId).toBe('session-1');
      expect(records[0].startedAt).toBeTruthy();
      expect(records[0].stoppedAt).toBeNull();
    });

    it('records multiple subagents in the same session', () => {
      tracker.onStart('agent-1', 'Explore', 'session-1');
      tracker.onStart('agent-2', 'Plan', 'session-1');
      tracker.onStart('agent-3', 'general-purpose', 'session-1');

      const records = tracker.getSessionRecords('session-1');
      expect(records).toHaveLength(3);
      expect(records.map(r => r.agentType)).toEqual(['Explore', 'Plan', 'general-purpose']);
    });

    it('tracks subagents in different sessions separately', () => {
      tracker.onStart('agent-1', 'Explore', 'session-a');
      tracker.onStart('agent-2', 'Plan', 'session-b');

      expect(tracker.getSessionRecords('session-a')).toHaveLength(1);
      expect(tracker.getSessionRecords('session-b')).toHaveLength(1);
    });
  });

  // ── Stop Tracking ─────────────────────────────────────────────

  describe('onStop()', () => {
    it('marks a subagent as stopped', () => {
      tracker.onStart('agent-1', 'Explore', 'session-1');
      tracker.onStop('agent-1', 'session-1');

      const records = tracker.getSessionRecords('session-1');
      expect(records).toHaveLength(1);
      expect(records[0].stoppedAt).toBeTruthy();
    });

    it('captures last_assistant_message on stop', () => {
      tracker.onStart('agent-1', 'Explore', 'session-1');
      tracker.onStop('agent-1', 'session-1', 'Found 5 relevant files.');

      const records = tracker.getSessionRecords('session-1');
      expect(records[0].lastMessage).toBe('Found 5 relevant files.');
    });

    it('captures transcript path on stop', () => {
      tracker.onStart('agent-1', 'Explore', 'session-1');
      tracker.onStop('agent-1', 'session-1', 'Done.', '/tmp/transcript-123.jsonl');

      const records = tracker.getSessionRecords('session-1');
      expect(records[0].transcriptPath).toBe('/tmp/transcript-123.jsonl');
    });

    it('handles stop without matching start (orphan)', () => {
      tracker.onStop('unknown-agent', 'session-1', 'Orphan output');

      const records = tracker.getSessionRecords('session-1');
      expect(records).toHaveLength(1);
      expect(records[0].agentId).toBe('unknown-agent');
      expect(records[0].agentType).toBe('unknown');
      expect(records[0].lastMessage).toBe('Orphan output');
    });
  });

  // ── Active/Completed Queries ──────────────────────────────────

  describe('getActiveSubagents()', () => {
    it('returns only started-but-not-stopped subagents', () => {
      tracker.onStart('agent-1', 'Explore', 'session-1');
      tracker.onStart('agent-2', 'Plan', 'session-1');
      tracker.onStop('agent-1', 'session-1');

      const active = tracker.getActiveSubagents('session-1');
      expect(active).toHaveLength(1);
      expect(active[0].agentId).toBe('agent-2');
    });

    it('returns empty when all subagents stopped', () => {
      tracker.onStart('agent-1', 'Explore', 'session-1');
      tracker.onStop('agent-1', 'session-1');

      expect(tracker.getActiveSubagents('session-1')).toHaveLength(0);
    });

    it('returns empty for unknown session', () => {
      expect(tracker.getActiveSubagents('nonexistent')).toEqual([]);
    });
  });

  describe('getCompletedSubagents()', () => {
    it('returns only stopped subagents', () => {
      tracker.onStart('agent-1', 'Explore', 'session-1');
      tracker.onStart('agent-2', 'Plan', 'session-1');
      tracker.onStop('agent-1', 'session-1', 'Result from explore');

      const completed = tracker.getCompletedSubagents('session-1');
      expect(completed).toHaveLength(1);
      expect(completed[0].agentId).toBe('agent-1');
      expect(completed[0].lastMessage).toBe('Result from explore');
    });
  });

  // ── Session Summary ───────────────────────────────────────────

  describe('getSessionSummary()', () => {
    it('returns null for unknown session', () => {
      expect(tracker.getSessionSummary('nonexistent')).toBeNull();
    });

    it('generates accurate summary', () => {
      tracker.onStart('agent-1', 'Explore', 'session-1');
      tracker.onStart('agent-2', 'Plan', 'session-1');
      tracker.onStart('agent-3', 'Explore', 'session-1');
      tracker.onStop('agent-1', 'session-1', 'Found files');
      tracker.onStop('agent-2', 'session-1'); // no output

      const summary = tracker.getSessionSummary('session-1');
      expect(summary).not.toBeNull();
      expect(summary!.total).toBe(3);
      expect(summary!.active).toBe(1);
      expect(summary!.completed).toBe(2);
      expect(summary!.agentTypes).toEqual({ Explore: 2, Plan: 1 });
      expect(summary!.withOutput).toBe(1); // only agent-1 had lastMessage
    });
  });

  // ── Event Emission ────────────────────────────────────────────

  describe('event emission', () => {
    it('emits "start" event', () => {
      const starts: unknown[] = [];
      tracker.on('start', (r) => starts.push(r));

      tracker.onStart('agent-1', 'Explore', 'session-1');

      expect(starts).toHaveLength(1);
    });

    it('emits "stop" event with details', () => {
      const stops: unknown[] = [];
      tracker.on('stop', (r) => stops.push(r));

      tracker.onStart('agent-1', 'Explore', 'session-1');
      tracker.onStop('agent-1', 'session-1', 'Done', '/path/to/transcript');

      expect(stops).toHaveLength(1);
      expect((stops[0] as any).agentId).toBe('agent-1');
      expect((stops[0] as any).lastMessage).toBe('Done');
    });
  });

  // ── Limits ────────────────────────────────────────────────────

  describe('per-session limit', () => {
    it('trims old completed records when limit exceeded', () => {
      const limited = new SubagentTracker({
        stateDir: tmpDir,
        maxPerSession: 5,
      });

      for (let i = 0; i < 10; i++) {
        limited.onStart(`agent-${i}`, 'Explore', 'session-1');
        limited.onStop(`agent-${i}`, 'session-1', `output-${i}`);
      }

      const records = limited.getSessionRecords('session-1');
      expect(records.length).toBeLessThanOrEqual(5);
      // Should keep most recent
      expect(records[records.length - 1].lastMessage).toBe('output-9');
    });

    it('preserves active subagents when trimming', () => {
      const limited = new SubagentTracker({
        stateDir: tmpDir,
        maxPerSession: 3,
      });

      // Create active subagent
      limited.onStart('active-agent', 'Plan', 'session-1');

      // Fill up with completed
      for (let i = 0; i < 5; i++) {
        limited.onStart(`completed-${i}`, 'Explore', 'session-1');
        limited.onStop(`completed-${i}`, 'session-1');
      }

      const active = limited.getActiveSubagents('session-1');
      expect(active.some(r => r.agentId === 'active-agent')).toBe(true);
    });
  });

  // ── Session Management ────────────────────────────────────────

  describe('listSessions()', () => {
    it('returns empty when no data', () => {
      expect(tracker.listSessions()).toEqual([]);
    });

    it('lists all sessions with tracking data', () => {
      tracker.onStart('a-1', 'Explore', 'session-a');
      tracker.onStart('b-1', 'Plan', 'session-b');

      const sessions = tracker.listSessions();
      expect(sessions.sort()).toEqual(['session-a', 'session-b']);
    });
  });

  // ── Persistence ───────────────────────────────────────────────

  describe('persistence', () => {
    it('records survive reconstruction', () => {
      tracker.onStart('agent-1', 'Explore', 'session-1');
      tracker.onStop('agent-1', 'session-1', 'Persisted output');

      const tracker2 = new SubagentTracker({ stateDir: tmpDir });
      const records = tracker2.getSessionRecords('session-1');
      expect(records).toHaveLength(1);
      expect(records[0].lastMessage).toBe('Persisted output');
    });

    it('active index rebuilt on load', () => {
      tracker.onStart('agent-1', 'Explore', 'session-1');
      // agent-1 is still active (not stopped)

      const tracker2 = new SubagentTracker({ stateDir: tmpDir });
      const active = tracker2.getActiveSubagents('session-1');
      expect(active).toHaveLength(1);
      expect(active[0].agentId).toBe('agent-1');
    });
  });

  // ── Edge Cases ────────────────────────────────────────────────

  describe('edge cases', () => {
    it('sanitizes session IDs', () => {
      tracker.onStart('agent-1', 'Explore', '../../etc/passwd');
      const sessions = tracker.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).not.toContain('/');
    });

    it('handles empty session gracefully', () => {
      expect(tracker.getSessionRecords('empty')).toEqual([]);
      expect(tracker.getActiveSubagents('empty')).toEqual([]);
      expect(tracker.getCompletedSubagents('empty')).toEqual([]);
      expect(tracker.getSessionSummary('empty')).toBeNull();
    });
  });
});
