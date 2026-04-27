/**
 * Tests for StateManager event querying.
 *
 * Verifies event persistence, time-based filtering,
 * type filtering, and limit enforcement.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateManager } from '../../src/core/StateManager.js';
import type { ActivityEvent } from '../../src/core/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('StateManager — event querying', () => {
  let tmpDir: string;
  let state: StateManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-events-'));
    fs.mkdirSync(path.join(tmpDir, 'logs'), { recursive: true });
    state = new StateManager(tmpDir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends events to daily log files', () => {
    const event: ActivityEvent = {
      type: 'test_event',
      summary: 'A test event',
      timestamp: new Date().toISOString(),
    };

    state.appendEvent(event);

    const today = new Date().toISOString().slice(0, 10);
    const logFile = path.join(tmpDir, 'logs', `activity-${today}.jsonl`);
    expect(fs.existsSync(logFile)).toBe(true);

    const content = fs.readFileSync(logFile, 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.type).toBe('test_event');
    expect(parsed.summary).toBe('A test event');
  });

  it('queries events by type', () => {
    state.appendEvent({ type: 'alpha', summary: 'Alpha event', timestamp: new Date().toISOString() });
    state.appendEvent({ type: 'beta', summary: 'Beta event', timestamp: new Date().toISOString() });
    state.appendEvent({ type: 'alpha', summary: 'Alpha event 2', timestamp: new Date().toISOString() });

    const alphas = state.queryEvents({ type: 'alpha' });
    expect(alphas).toHaveLength(2);
    expect(alphas.every(e => e.type === 'alpha')).toBe(true);

    const betas = state.queryEvents({ type: 'beta' });
    expect(betas).toHaveLength(1);
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      state.appendEvent({
        type: 'test',
        summary: `Event ${i}`,
        timestamp: new Date().toISOString(),
      });
    }

    const limited = state.queryEvents({ limit: 3 });
    expect(limited).toHaveLength(3);
  });

  it('filters by since timestamp', () => {
    // Write an old event manually
    const yesterday = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);
    const logFile = path.join(tmpDir, 'logs', `activity-${yesterdayStr}.jsonl`);
    fs.writeFileSync(logFile, JSON.stringify({
      type: 'old',
      summary: 'Old event',
      timestamp: yesterday.toISOString(),
    }) + '\n');

    // Write a recent event
    state.appendEvent({
      type: 'recent',
      summary: 'Recent event',
      timestamp: new Date().toISOString(),
    });

    // Query with 'since' within the last hour
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const recent = state.queryEvents({ since });
    expect(recent.every(e => e.type === 'recent')).toBe(true);
  });

  it('returns empty array when no log files exist', () => {
    const events = state.queryEvents({});
    expect(events).toEqual([]);
  });

  it('handles corrupted log lines gracefully', () => {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = path.join(tmpDir, 'logs', `activity-${today}.jsonl`);

    fs.writeFileSync(logFile, [
      JSON.stringify({ type: 'good', summary: 'Good event', timestamp: new Date().toISOString() }),
      'not-json-at-all',
      JSON.stringify({ type: 'also_good', summary: 'Also good', timestamp: new Date().toISOString() }),
    ].join('\n') + '\n');

    const events = state.queryEvents({});
    expect(events).toHaveLength(2);
  });
});
