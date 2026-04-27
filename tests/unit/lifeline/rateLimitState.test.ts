import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readRateLimitState,
  decide,
  writeRateLimitState,
  isRestartStorm,
  statePath,
  WATCHDOG_COOLDOWN_MS,
  VERSION_SKEW_DAILY_CAP,
  RESTART_STORM_THRESHOLD,
  RESTART_STORM_WINDOW_MS,
} from '../../../src/lifeline/rateLimitState.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rate-limit-test-'));
});
afterEach(() => {
  // safe-git-allow: incremental-migration
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('readRateLimitState', () => {
  it('missing file returns clear', () => {
    const r = readRateLimitState(tmp);
    expect(r.kind).toBe('clear');
  });

  it('malformed JSON returns corrupt + signal', () => {
    fs.writeFileSync(statePath(tmp), '{not json');
    const r = readRateLimitState(tmp);
    expect(r.kind).toBe('corrupt');
    if (r.kind === 'corrupt') expect(r.errorSignal).toBe('rateLimitFileCorrupt');
  });

  it('missing lastRestartAt returns corrupt', () => {
    fs.writeFileSync(statePath(tmp), JSON.stringify({ history: [] }));
    const r = readRateLimitState(tmp);
    expect(r.kind).toBe('corrupt');
  });

  it('future timestamp returns skew (allow-and-overwrite)', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    fs.writeFileSync(statePath(tmp), JSON.stringify({
      lastRestartAt: future,
      lastReason: 'test',
      history: [],
    }));
    const r = readRateLimitState(tmp);
    expect(r.kind).toBe('skew');
    if (r.kind === 'skew') expect(r.errorSignal).toBe('rateLimitFileSkew');
  });

  it('valid state in the past returns ok', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(statePath(tmp), JSON.stringify({
      lastRestartAt: past,
      lastReason: 'old',
      history: [{ at: past, reason: 'old', bucket: 'watchdog' }],
    }));
    const r = readRateLimitState(tmp);
    expect(r.kind).toBe('ok');
  });
});

describe('decide', () => {
  const now = Date.now();

  it('clear outcome allows restart', () => {
    expect(decide({ kind: 'clear', state: null }, 'watchdog', now).allowed).toBe(true);
  });

  it('corrupt outcome blocks (fail-closed)', () => {
    expect(decide({ kind: 'corrupt', state: null, errorSignal: 'rateLimitFileCorrupt' }, 'watchdog', now).allowed).toBe(false);
  });

  it('skew outcome allows (breaks deadlock)', () => {
    expect(decide({ kind: 'skew', state: null, errorSignal: 'rateLimitFileSkew' }, 'watchdog', now).allowed).toBe(true);
  });

  it('within cooldown blocks', () => {
    const lastRestartAt = new Date(now - WATCHDOG_COOLDOWN_MS + 1000).toISOString();
    const state = { lastRestartAt, lastReason: 'x', history: [{ at: lastRestartAt, reason: 'x', bucket: 'watchdog' as const }] };
    const r = decide({ kind: 'ok', state }, 'watchdog', now);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('cooldown-active');
  });

  it('past cooldown allows', () => {
    const lastRestartAt = new Date(now - WATCHDOG_COOLDOWN_MS - 1000).toISOString();
    const state = { lastRestartAt, lastReason: 'x', history: [{ at: lastRestartAt, reason: 'x', bucket: 'watchdog' as const }] };
    expect(decide({ kind: 'ok', state }, 'watchdog', now).allowed).toBe(true);
  });

  it('versionSkew bucket caps at 3 per 24h', () => {
    const oldEnough = new Date(now - WATCHDOG_COOLDOWN_MS - 1000).toISOString();
    const history = Array.from({ length: VERSION_SKEW_DAILY_CAP }, (_, i) => ({
      at: new Date(now - (i + 1) * 60 * 60 * 1000).toISOString(),
      reason: 'version-skew',
      bucket: 'versionSkew' as const,
    }));
    const state = { lastRestartAt: oldEnough, lastReason: 'x', history };
    const r = decide({ kind: 'ok', state }, 'versionSkew', now);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('version-skew-daily-cap');
  });

  it('storm detection: 6 restarts in 1h flags stormActive', () => {
    const oldEnough = new Date(now - WATCHDOG_COOLDOWN_MS - 1000).toISOString();
    const history = Array.from({ length: RESTART_STORM_THRESHOLD }, (_, i) => ({
      at: new Date(now - (i + 1) * 5 * 60 * 1000).toISOString(),
      reason: 'noForwardStuck',
      bucket: 'watchdog' as const,
    }));
    const state = { lastRestartAt: oldEnough, lastReason: 'x', history };
    const r = decide({ kind: 'ok', state }, 'watchdog', now);
    expect(r.allowed).toBe(true);
    expect(r.stormActive).toBe(true);
  });
});

describe('writeRateLimitState', () => {
  it('writes atomic with 0600 mode and appends history', () => {
    writeRateLimitState(tmp, 'noForwardStuck', 'watchdog', null);
    const raw = fs.readFileSync(statePath(tmp), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.lastReason).toBe('noForwardStuck');
    expect(parsed.history).toHaveLength(1);
    expect(parsed.history[0].bucket).toBe('watchdog');
    const stat = fs.statSync(statePath(tmp));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('appends to existing history up to HISTORY_CAP', () => {
    const prior = {
      lastRestartAt: new Date(Date.now() - 60000).toISOString(),
      lastReason: 'old',
      history: Array.from({ length: 55 }, (_, i) => ({
        at: new Date(Date.now() - (i + 1) * 1000).toISOString(),
        reason: 'old',
        bucket: 'watchdog' as const,
      })),
    };
    const next = writeRateLimitState(tmp, 'newer', 'watchdog', prior);
    expect(next.history.length).toBeLessThanOrEqual(50);
    expect(next.history[next.history.length - 1].reason).toBe('newer');
  });
});

describe('isRestartStorm', () => {
  it('false for no state', () => {
    expect(isRestartStorm(null)).toBe(false);
  });

  it('true at threshold within window', () => {
    const now = Date.now();
    const state = {
      lastRestartAt: new Date(now - 1000).toISOString(),
      lastReason: 'x',
      history: Array.from({ length: RESTART_STORM_THRESHOLD }, (_, i) => ({
        at: new Date(now - i * 1000).toISOString(),
        reason: 'x',
        bucket: 'watchdog' as const,
      })),
    };
    expect(isRestartStorm(state, now)).toBe(true);
  });

  it('false when older than window', () => {
    const now = Date.now();
    const state = {
      lastRestartAt: new Date(now - 1000).toISOString(),
      lastReason: 'x',
      history: Array.from({ length: RESTART_STORM_THRESHOLD }, (_, i) => ({
        at: new Date(now - RESTART_STORM_WINDOW_MS - (i + 1) * 1000).toISOString(),
        reason: 'x',
        bucket: 'watchdog' as const,
      })),
    };
    expect(isRestartStorm(state, now)).toBe(false);
  });
});
