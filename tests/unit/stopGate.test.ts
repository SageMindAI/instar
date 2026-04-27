/**
 * Unit tests for src/server/stopGate.ts (PR0a — context-death-pitfall-
 * prevention spec). Covers in-memory state holders, the compaction probe
 * (P0.6), and the hot-path assembly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  GATE_ROUTE_VERSION,
  GATE_ROUTE_MINIMUM_VERSION,
  getMode,
  setMode,
  getKillSwitch,
  setKillSwitch,
  recordSessionStart,
  getSessionStartTs,
  compactionInFlight,
  getHotPathState,
  _resetForTests,
} from '../../src/server/stopGate.js';

describe('stopGate — version contract', () => {
  it('exports version constants as positive integers', () => {
    expect(Number.isInteger(GATE_ROUTE_VERSION)).toBe(true);
    expect(GATE_ROUTE_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(GATE_ROUTE_MINIMUM_VERSION)).toBe(true);
    expect(GATE_ROUTE_MINIMUM_VERSION).toBeGreaterThan(0);
    expect(GATE_ROUTE_MINIMUM_VERSION).toBeLessThanOrEqual(GATE_ROUTE_VERSION);
  });
});

describe('stopGate — mode + kill-switch', () => {
  beforeEach(() => _resetForTests());

  it('defaults mode to off so PR0a ships completely inert', () => {
    expect(getMode()).toBe('off');
  });

  it('round-trips mode set/get', () => {
    setMode('shadow');
    expect(getMode()).toBe('shadow');
    setMode('enforce');
    expect(getMode()).toBe('enforce');
    setMode('off');
    expect(getMode()).toBe('off');
  });

  it('defaults killSwitch to false', () => {
    expect(getKillSwitch()).toBe(false);
  });

  it('setKillSwitch returns prior value', () => {
    expect(setKillSwitch(true)).toBe(false);
    expect(getKillSwitch()).toBe(true);
    expect(setKillSwitch(true)).toBe(true);
    expect(setKillSwitch(false)).toBe(true);
    expect(getKillSwitch()).toBe(false);
  });
});

describe('stopGate — sessionStartTs', () => {
  beforeEach(() => _resetForTests());

  it('records and retrieves a session start timestamp', () => {
    recordSessionStart('sess-1', 1700000000000);
    expect(getSessionStartTs('sess-1')).toBe(1700000000000);
  });

  it('first SessionStart wins (idempotent — later resumes do not overwrite)', () => {
    recordSessionStart('sess-1', 1700000000000);
    recordSessionStart('sess-1', 1700000999999);
    expect(getSessionStartTs('sess-1')).toBe(1700000000000);
  });

  it('returns null for unknown session id', () => {
    expect(getSessionStartTs('never-seen')).toBeNull();
  });

  it('ignores empty session id (no crash, no record)', () => {
    recordSessionStart('', 1700000000000);
    expect(getSessionStartTs('')).toBeNull();
  });
});

describe('stopGate — compactionInFlight probe (P0.6)', () => {
  let tmpDir: string;
  let recoveryScript: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-gate-test-'));
    recoveryScript = path.join(tmpDir, 'compaction-recovery.sh');
    fs.writeFileSync(recoveryScript, '#!/bin/sh\n');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true when recovery script mtime is fresh (<60s)', () => {
    const now = Date.now();
    fs.utimesSync(recoveryScript, now / 1000, (now - 5_000) / 1000);
    expect(compactionInFlight({ recoveryScriptPath: recoveryScript, now })).toBe(true);
  });

  it('returns false when recovery script mtime is stale (>60s)', () => {
    const now = Date.now();
    fs.utimesSync(recoveryScript, now / 1000, (now - 120_000) / 1000);
    expect(compactionInFlight({ recoveryScriptPath: recoveryScript, now })).toBe(false);
  });

  it('returns false (fail-open) when recovery script does not exist', () => {
    const ghost = path.join(tmpDir, 'does-not-exist.sh');
    expect(compactionInFlight({ recoveryScriptPath: ghost })).toBe(false);
  });

  it('treats /tmp/claude-session-<id>/compacting marker as authoritative', () => {
    const sid = `unit-test-${process.pid}-${Date.now()}`;
    const markerDir = `/tmp/claude-session-${sid}`;
    const marker = `${markerDir}/compacting`;
    try {
      fs.mkdirSync(markerDir, { recursive: true });
      fs.writeFileSync(marker, '');
      expect(
        compactionInFlight({ sessionId: sid, recoveryScriptPath: '/no/such/path' })
      ).toBe(true);
    } finally {
      // safe-git-allow: incremental-migration
      fs.rmSync(markerDir, { recursive: true, force: true });
    }
  });
});

describe('stopGate — getHotPathState', () => {
  beforeEach(() => _resetForTests());

  it('returns all five fields plus routeVersion in one call', () => {
    const state = getHotPathState({
      sessionId: 'sess-h',
      autonomousActiveOverride: false,
      recoveryScriptPath: '/no/such/path',
    });
    expect(state).toMatchObject({
      mode: 'off',
      killSwitch: false,
      autonomousActive: false,
      compactionInFlight: false,
      sessionStartTs: null,
      routeVersion: GATE_ROUTE_VERSION,
    });
  });

  it('reflects mode + killSwitch from state', () => {
    setMode('shadow');
    setKillSwitch(true);
    const state = getHotPathState({
      sessionId: 'sess-h',
      autonomousActiveOverride: true,
      recoveryScriptPath: '/no/such/path',
    });
    expect(state.mode).toBe('shadow');
    expect(state.killSwitch).toBe(true);
    expect(state.autonomousActive).toBe(true);
  });

  it('returns sessionStartTs when SessionStart was previously recorded', () => {
    recordSessionStart('sess-h', 1700000000000);
    const state = getHotPathState({
      sessionId: 'sess-h',
      autonomousActiveOverride: false,
      recoveryScriptPath: '/no/such/path',
    });
    expect(state.sessionStartTs).toBe(1700000000000);
  });

  it('reads autonomousActive from autonomous-state file when override absent', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-gate-auto-'));
    const stateFile = path.join(tmp, 'autonomous-state.local.md');
    try {
      fs.writeFileSync(stateFile, 'topic: 6931\n');
      const present = getHotPathState({
        sessionId: 'sess-h',
        autonomousStateFile: stateFile,
        recoveryScriptPath: '/no/such/path',
      });
      expect(present.autonomousActive).toBe(true);

      // safe-git-allow: incremental-migration
      fs.unlinkSync(stateFile);
      const absent = getHotPathState({
        sessionId: 'sess-h',
        autonomousStateFile: stateFile,
        recoveryScriptPath: '/no/such/path',
      });
      expect(absent.autonomousActive).toBe(false);
    } finally {
      // safe-git-allow: incremental-migration
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
