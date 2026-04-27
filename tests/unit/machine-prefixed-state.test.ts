/**
 * Unit tests for Machine-Prefixed State (Phase 4D — Gap 6).
 *
 * Tests that StateManager auto-stamps activity events with machineId
 * for cross-machine state correlation and conflict avoidance.
 *
 * Covers:
 *   1. machineId auto-stamping on activity events
 *   2. Explicit machineId preserved (not overwritten)
 *   3. No machineId when not configured
 *   4. machineId getter/setter
 *   5. ActivityEvent type accepts machineId field
 *   6. Event queryability with machineId filter
 *   7. Read-only mode still enforced
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateManager } from '../../src/core/StateManager.js';
import type { ActivityEvent } from '../../src/core/types.js';

// ── Helpers ─────────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-state-prefix-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

function readEvents(stateDir: string): ActivityEvent[] {
  const logDir = path.join(stateDir, 'logs');
  if (!fs.existsSync(logDir)) return [];

  const files = fs.readdirSync(logDir).filter(f => f.startsWith('activity-'));
  const events: ActivityEvent[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(logDir, file), 'utf-8').trim();
    if (content) {
      for (const line of content.split('\n')) {
        events.push(JSON.parse(line));
      }
    }
  }
  return events;
}

// ── 1. machineId Auto-Stamping ──────────────────────────────────────

describe('machineId auto-stamping on activity events', () => {
  let tmpDir: string;
  let state: StateManager;

  beforeEach(() => {
    tmpDir = createTempDir();
    state = new StateManager(tmpDir);
  });

  afterEach(() => { cleanup(tmpDir); });

  it('stamps machineId when configured', () => {
    state.setMachineId('m_workstation');
    state.appendEvent({
      type: 'test_event',
      summary: 'A test event',
      timestamp: new Date().toISOString(),
    });

    const events = readEvents(tmpDir);
    expect(events).toHaveLength(1);
    expect(events[0].machineId).toBe('m_workstation');
  });

  it('stamps different machineIds for different machines', () => {
    state.setMachineId('m_dawn_macbook');
    state.appendEvent({
      type: 'test_event',
      summary: 'From dawn macbook',
      timestamp: new Date().toISOString(),
    });

    const events = readEvents(tmpDir);
    expect(events[0].machineId).toBe('m_dawn_macbook');
  });

  it('does not stamp when machineId not configured', () => {
    state.appendEvent({
      type: 'test_event',
      summary: 'No machine ID',
      timestamp: new Date().toISOString(),
    });

    const events = readEvents(tmpDir);
    expect(events).toHaveLength(1);
    expect(events[0].machineId).toBeUndefined();
  });
});

// ── 2. Explicit machineId Preserved ─────────────────────────────────

describe('explicit machineId preserved', () => {
  let tmpDir: string;
  let state: StateManager;

  beforeEach(() => {
    tmpDir = createTempDir();
    state = new StateManager(tmpDir);
    state.setMachineId('m_workstation');
  });

  afterEach(() => { cleanup(tmpDir); });

  it('does not overwrite explicit machineId', () => {
    state.appendEvent({
      type: 'test_event',
      summary: 'Explicit machine',
      machineId: 'm_custom_override',
      timestamp: new Date().toISOString(),
    });

    const events = readEvents(tmpDir);
    expect(events[0].machineId).toBe('m_custom_override');
  });

  it('auto-stamps only when event has no machineId', () => {
    state.appendEvent({
      type: 'event_a',
      summary: 'Auto-stamped',
      timestamp: new Date().toISOString(),
    });
    state.appendEvent({
      type: 'event_b',
      summary: 'Explicit',
      machineId: 'm_other',
      timestamp: new Date().toISOString(),
    });

    const events = readEvents(tmpDir);
    expect(events[0].machineId).toBe('m_workstation');
    expect(events[1].machineId).toBe('m_other');
  });
});

// ── 3. machineId Getter/Setter ──────────────────────────────────────

describe('machineId getter/setter', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('defaults to null', () => {
    const state = new StateManager(tmpDir);
    expect(state.machineId).toBeNull();
  });

  it('returns set machineId', () => {
    const state = new StateManager(tmpDir);
    state.setMachineId('m_test');
    expect(state.machineId).toBe('m_test');
  });

  it('can be changed after construction', () => {
    const state = new StateManager(tmpDir);
    state.setMachineId('m_first');
    expect(state.machineId).toBe('m_first');

    state.setMachineId('m_second');
    expect(state.machineId).toBe('m_second');
  });
});

// ── 4. Multiple Events Across Sessions ──────────────────────────────

describe('multiple events across sessions', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('all events from same machine get same machineId', () => {
    const state = new StateManager(tmpDir);
    state.setMachineId('m_workstation');

    for (let i = 0; i < 5; i++) {
      state.appendEvent({
        type: 'test_event',
        summary: `Event ${i}`,
        timestamp: new Date().toISOString(),
      });
    }

    const events = readEvents(tmpDir);
    expect(events).toHaveLength(5);
    expect(events.every(e => e.machineId === 'm_workstation')).toBe(true);
  });
});

// ── 5. Read-Only Mode Still Enforced ────────────────────────────────

describe('read-only mode with machineId', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('read-only mode blocks events even with machineId', () => {
    const state = new StateManager(tmpDir);
    state.setMachineId('m_workstation');
    state.setReadOnly(true);

    expect(() => {
      state.appendEvent({
        type: 'test_event',
        summary: 'Should fail',
        timestamp: new Date().toISOString(),
      });
    }).toThrow(/read-only/i);
  });
});

// ── 6. queryEvents Returns machineId ────────────────────────────────

describe('queryEvents returns machineId', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('queried events include machineId field', () => {
    const state = new StateManager(tmpDir);
    state.setMachineId('m_workstation');
    state.appendEvent({
      type: 'test_event',
      summary: 'Queryable',
      timestamp: new Date().toISOString(),
    });

    const events = state.queryEvents({ type: 'test_event' });
    expect(events).toHaveLength(1);
    expect(events[0].machineId).toBe('m_workstation');
  });
});

// ── 7. Backward Compatibility ───────────────────────────────────────

describe('backward compatibility', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('events without machineId are still readable', () => {
    const state = new StateManager(tmpDir);

    // Write event without machineId
    state.appendEvent({
      type: 'legacy_event',
      summary: 'No machine prefix',
      timestamp: new Date().toISOString(),
    });

    const events = readEvents(tmpDir);
    expect(events).toHaveLength(1);
    expect(events[0].machineId).toBeUndefined();
    expect(events[0].type).toBe('legacy_event');
  });

  it('mixed events (with and without machineId) coexist', () => {
    const state = new StateManager(tmpDir);

    // Write without machineId
    state.appendEvent({
      type: 'legacy',
      summary: 'Old event',
      timestamp: new Date().toISOString(),
    });

    // Configure machineId
    state.setMachineId('m_workstation');

    // Write with machineId
    state.appendEvent({
      type: 'modern',
      summary: 'New event',
      timestamp: new Date().toISOString(),
    });

    const events = readEvents(tmpDir);
    expect(events).toHaveLength(2);
    expect(events[0].machineId).toBeUndefined();
    expect(events[1].machineId).toBe('m_workstation');
  });
});
