/**
 * Unit tests for DecisionJournal — JSONL-backed decision journal.
 *
 * Tests cover:
 * - log(): appending entries, auto-timestamping, lazy directory creation
 * - read(): filtering by days/jobSlug/limit, newest-first ordering
 * - stats(): counts, date range, principle distribution, conflict counting
 * - Edge cases: empty file, corrupt JSONL lines, missing file
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DecisionJournal } from '../../src/core/DecisionJournal.js';
import type { DecisionJournalEntry } from '../../src/core/types.js';

describe('DecisionJournal', () => {
  let tmpDir: string;
  let stateDir: string;
  let journal: DecisionJournal;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dj-test-'));
    stateDir = path.join(tmpDir, '.instar');
    // Do NOT create stateDir — test lazy creation
    journal = new DecisionJournal(stateDir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ── log() ────────────────────────────────────────────────────────

  describe('log()', () => {
    it('creates the state directory lazily on first log', () => {
      expect(fs.existsSync(stateDir)).toBe(false);

      journal.log({
        sessionId: 'sess-1',
        decision: 'Use caching for performance',
      });

      expect(fs.existsSync(stateDir)).toBe(true);
      expect(fs.existsSync(path.join(stateDir, 'decision-journal.jsonl'))).toBe(true);
    });

    it('appends a JSONL line with auto-generated timestamp', () => {
      journal.log({
        sessionId: 'sess-1',
        decision: 'Chose REST over GraphQL',
      });

      const content = fs.readFileSync(path.join(stateDir, 'decision-journal.jsonl'), 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);

      const parsed = JSON.parse(lines[0]);
      expect(parsed.sessionId).toBe('sess-1');
      expect(parsed.decision).toBe('Chose REST over GraphQL');
      expect(parsed.timestamp).toBeTruthy();
      // Timestamp should be a valid ISO string
      expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
    });

    it('returns the full entry with timestamp', () => {
      const result = journal.log({
        sessionId: 'sess-2',
        decision: 'Deploy to staging first',
        principle: 'safety-first',
        confidence: 0.9,
      });

      expect(result.sessionId).toBe('sess-2');
      expect(result.decision).toBe('Deploy to staging first');
      expect(result.principle).toBe('safety-first');
      expect(result.confidence).toBe(0.9);
      expect(result.timestamp).toBeTruthy();
    });

    it('appends multiple entries without overwriting', () => {
      journal.log({ sessionId: 's1', decision: 'First decision' });
      journal.log({ sessionId: 's2', decision: 'Second decision' });
      journal.log({ sessionId: 's3', decision: 'Third decision' });

      const content = fs.readFileSync(path.join(stateDir, 'decision-journal.jsonl'), 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(3);

      expect(JSON.parse(lines[0]).decision).toBe('First decision');
      expect(JSON.parse(lines[1]).decision).toBe('Second decision');
      expect(JSON.parse(lines[2]).decision).toBe('Third decision');
    });

    it('preserves all optional fields', () => {
      const entry = journal.log({
        sessionId: 'sess-full',
        decision: 'Full entry',
        topicId: 42,
        jobSlug: 'health-check',
        alternatives: ['Option A', 'Option B'],
        principle: 'thoroughness',
        confidence: 0.75,
        context: 'During maintenance window',
        conflict: true,
        tags: ['infra', 'critical'],
      });

      expect(entry.topicId).toBe(42);
      expect(entry.jobSlug).toBe('health-check');
      expect(entry.alternatives).toEqual(['Option A', 'Option B']);
      expect(entry.principle).toBe('thoroughness');
      expect(entry.confidence).toBe(0.75);
      expect(entry.context).toBe('During maintenance window');
      expect(entry.conflict).toBe(true);
      expect(entry.tags).toEqual(['infra', 'critical']);
    });

    it('works when state directory already exists', () => {
      fs.mkdirSync(stateDir, { recursive: true });

      const entry = journal.log({
        sessionId: 'sess-x',
        decision: 'Works with existing dir',
      });

      expect(entry.decision).toBe('Works with existing dir');
    });
  });

  // ── read() ───────────────────────────────────────────────────────

  describe('read()', () => {
    it('returns empty array when journal file does not exist', () => {
      const entries = journal.read();
      expect(entries).toEqual([]);
    });

    it('returns empty array for empty file', () => {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'decision-journal.jsonl'), '');

      const entries = journal.read();
      expect(entries).toEqual([]);
    });

    it('returns entries newest-first', () => {
      // Write entries with explicit timestamps to control ordering
      fs.mkdirSync(stateDir, { recursive: true });
      const journalFile = path.join(stateDir, 'decision-journal.jsonl');

      const entries = [
        { timestamp: '2026-02-20T10:00:00.000Z', sessionId: 's1', decision: 'First' },
        { timestamp: '2026-02-22T10:00:00.000Z', sessionId: 's2', decision: 'Third' },
        { timestamp: '2026-02-21T10:00:00.000Z', sessionId: 's3', decision: 'Second' },
      ];
      fs.writeFileSync(journalFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

      const result = journal.read();
      expect(result).toHaveLength(3);
      expect(result[0].decision).toBe('Third');   // newest
      expect(result[1].decision).toBe('Second');
      expect(result[2].decision).toBe('First');    // oldest
    });

    it('filters by days', () => {
      fs.mkdirSync(stateDir, { recursive: true });
      const journalFile = path.join(stateDir, 'decision-journal.jsonl');

      const now = Date.now();
      const entries = [
        { timestamp: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(), sessionId: 's1', decision: 'Recent' },
        { timestamp: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(), sessionId: 's2', decision: 'Old' },
      ];
      fs.writeFileSync(journalFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

      const result = journal.read({ days: 5 });
      expect(result).toHaveLength(1);
      expect(result[0].decision).toBe('Recent');
    });

    it('filters by jobSlug', () => {
      fs.mkdirSync(stateDir, { recursive: true });
      const journalFile = path.join(stateDir, 'decision-journal.jsonl');

      const entries = [
        { timestamp: '2026-02-20T10:00:00.000Z', sessionId: 's1', decision: 'Deploy decision', jobSlug: 'deploy' },
        { timestamp: '2026-02-20T11:00:00.000Z', sessionId: 's2', decision: 'Health check decision', jobSlug: 'health' },
        { timestamp: '2026-02-20T12:00:00.000Z', sessionId: 's3', decision: 'Ad-hoc decision' },
      ];
      fs.writeFileSync(journalFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

      const result = journal.read({ jobSlug: 'deploy' });
      expect(result).toHaveLength(1);
      expect(result[0].decision).toBe('Deploy decision');
    });

    it('limits result count', () => {
      fs.mkdirSync(stateDir, { recursive: true });
      const journalFile = path.join(stateDir, 'decision-journal.jsonl');

      const entries = Array.from({ length: 10 }, (_, i) => ({
        timestamp: new Date(2026, 1, 20 + i).toISOString(),
        sessionId: `s${i}`,
        decision: `Decision ${i}`,
      }));
      fs.writeFileSync(journalFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

      const result = journal.read({ limit: 3 });
      expect(result).toHaveLength(3);
      // Should be the 3 most recent (newest first)
      expect(result[0].decision).toBe('Decision 9');
      expect(result[1].decision).toBe('Decision 8');
      expect(result[2].decision).toBe('Decision 7');
    });

    it('combines days + jobSlug + limit filters', () => {
      fs.mkdirSync(stateDir, { recursive: true });
      const journalFile = path.join(stateDir, 'decision-journal.jsonl');

      const now = Date.now();
      const entries = [
        { timestamp: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(), sessionId: 's1', decision: 'Recent deploy 1', jobSlug: 'deploy' },
        { timestamp: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(), sessionId: 's2', decision: 'Recent deploy 2', jobSlug: 'deploy' },
        { timestamp: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(), sessionId: 's3', decision: 'Recent deploy 3', jobSlug: 'deploy' },
        { timestamp: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(), sessionId: 's4', decision: 'Recent health', jobSlug: 'health' },
        { timestamp: new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString(), sessionId: 's5', decision: 'Old deploy', jobSlug: 'deploy' },
      ];
      fs.writeFileSync(journalFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

      const result = journal.read({ days: 7, jobSlug: 'deploy', limit: 2 });
      expect(result).toHaveLength(2);
      // Should be the 2 newest deploy entries from last 7 days
      expect(result[0].decision).toBe('Recent deploy 1');
      expect(result[1].decision).toBe('Recent deploy 2');
    });

    it('handles corrupt JSONL lines gracefully', () => {
      fs.mkdirSync(stateDir, { recursive: true });
      const journalFile = path.join(stateDir, 'decision-journal.jsonl');

      const lines = [
        JSON.stringify({ timestamp: '2026-02-20T10:00:00.000Z', sessionId: 's1', decision: 'Good line' }),
        'this is not valid JSON{{{',
        JSON.stringify({ timestamp: '2026-02-20T12:00:00.000Z', sessionId: 's3', decision: 'Another good line' }),
        '',
      ];
      fs.writeFileSync(journalFile, lines.join('\n'));

      const result = journal.read();
      expect(result).toHaveLength(2);
      expect(result[0].decision).toBe('Another good line');
      expect(result[1].decision).toBe('Good line');
    });

    it('returns empty for whitespace-only file', () => {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'decision-journal.jsonl'), '   \n  \n  ');

      const entries = journal.read();
      expect(entries).toEqual([]);
    });
  });

  // ── stats() ──────────────────────────────────────────────────────

  describe('stats()', () => {
    it('returns zero stats for empty/missing journal', () => {
      const stats = journal.stats();
      expect(stats).toEqual({
        count: 0,
        earliest: null,
        latest: null,
        topPrinciples: [],
        conflictCount: 0,
      });
    });

    it('counts total entries', () => {
      journal.log({ sessionId: 's1', decision: 'D1' });
      journal.log({ sessionId: 's2', decision: 'D2' });
      journal.log({ sessionId: 's3', decision: 'D3' });

      const stats = journal.stats();
      expect(stats.count).toBe(3);
    });

    it('finds earliest and latest timestamps', () => {
      fs.mkdirSync(stateDir, { recursive: true });
      const journalFile = path.join(stateDir, 'decision-journal.jsonl');

      const entries = [
        { timestamp: '2026-02-15T08:00:00.000Z', sessionId: 's1', decision: 'Early' },
        { timestamp: '2026-02-20T14:00:00.000Z', sessionId: 's2', decision: 'Late' },
        { timestamp: '2026-02-18T10:00:00.000Z', sessionId: 's3', decision: 'Middle' },
      ];
      fs.writeFileSync(journalFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

      const stats = journal.stats();
      expect(stats.earliest).toBe('2026-02-15T08:00:00.000Z');
      expect(stats.latest).toBe('2026-02-20T14:00:00.000Z');
    });

    it('counts principles by frequency, sorted descending', () => {
      fs.mkdirSync(stateDir, { recursive: true });
      const journalFile = path.join(stateDir, 'decision-journal.jsonl');

      const entries = [
        { timestamp: '2026-02-20T10:00:00.000Z', sessionId: 's1', decision: 'D1', principle: 'safety' },
        { timestamp: '2026-02-20T11:00:00.000Z', sessionId: 's2', decision: 'D2', principle: 'speed' },
        { timestamp: '2026-02-20T12:00:00.000Z', sessionId: 's3', decision: 'D3', principle: 'safety' },
        { timestamp: '2026-02-20T13:00:00.000Z', sessionId: 's4', decision: 'D4', principle: 'safety' },
        { timestamp: '2026-02-20T14:00:00.000Z', sessionId: 's5', decision: 'D5', principle: 'speed' },
        { timestamp: '2026-02-20T15:00:00.000Z', sessionId: 's6', decision: 'D6' }, // no principle
      ];
      fs.writeFileSync(journalFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

      const stats = journal.stats();
      expect(stats.topPrinciples).toHaveLength(2);
      expect(stats.topPrinciples[0]).toEqual({ principle: 'safety', count: 3 });
      expect(stats.topPrinciples[1]).toEqual({ principle: 'speed', count: 2 });
    });

    it('counts conflict entries', () => {
      fs.mkdirSync(stateDir, { recursive: true });
      const journalFile = path.join(stateDir, 'decision-journal.jsonl');

      const entries = [
        { timestamp: '2026-02-20T10:00:00.000Z', sessionId: 's1', decision: 'D1', conflict: true },
        { timestamp: '2026-02-20T11:00:00.000Z', sessionId: 's2', decision: 'D2', conflict: false },
        { timestamp: '2026-02-20T12:00:00.000Z', sessionId: 's3', decision: 'D3', conflict: true },
        { timestamp: '2026-02-20T13:00:00.000Z', sessionId: 's4', decision: 'D4' }, // no conflict field
      ];
      fs.writeFileSync(journalFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

      const stats = journal.stats();
      expect(stats.conflictCount).toBe(2);
    });

    it('handles single entry correctly', () => {
      journal.log({ sessionId: 's1', decision: 'Only entry', principle: 'caution', conflict: true });

      const stats = journal.stats();
      expect(stats.count).toBe(1);
      expect(stats.earliest).toBe(stats.latest);
      expect(stats.topPrinciples).toEqual([{ principle: 'caution', count: 1 }]);
      expect(stats.conflictCount).toBe(1);
    });

    it('ignores corrupt lines in stats', () => {
      fs.mkdirSync(stateDir, { recursive: true });
      const journalFile = path.join(stateDir, 'decision-journal.jsonl');

      const lines = [
        JSON.stringify({ timestamp: '2026-02-20T10:00:00.000Z', sessionId: 's1', decision: 'Good', principle: 'accuracy' }),
        'not-json!!!',
        JSON.stringify({ timestamp: '2026-02-21T10:00:00.000Z', sessionId: 's2', decision: 'Also good', principle: 'accuracy' }),
      ];
      fs.writeFileSync(journalFile, lines.join('\n') + '\n');

      const stats = journal.stats();
      expect(stats.count).toBe(2);
      expect(stats.topPrinciples).toEqual([{ principle: 'accuracy', count: 2 }]);
    });
  });

  // ── Error handling ───────────────────────────────────────────────

  describe('error handling', () => {
    it('returns empty array when file read fails', () => {
      // Create a directory where the file should be — fs.readFileSync will fail
      fs.mkdirSync(path.join(stateDir, 'decision-journal.jsonl'), { recursive: true });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = journal.read();
      expect(result).toEqual([]);
      expect(consoleSpy).toHaveBeenCalled();
    });
  });
});
