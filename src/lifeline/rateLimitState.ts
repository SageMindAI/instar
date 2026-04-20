/**
 * Rate-limit state — `state/last-self-restart-at.json`.
 *
 * Tracks wall-clock of the last self-restart, ring-buffer history, and
 * rate-limit decisions across buckets. Atomic writes via tmp+rename.
 *
 * Fail-closed read semantics per spec:
 *   - missing → clear to restart
 *   - malformed / unreadable → block (treat as "just restarted")
 *   - future timestamp → ALLOW and overwrite (previous "block" was a deadlock)
 */

import fs from 'node:fs';
import path from 'node:path';

export type RestartBucket = 'watchdog' | 'versionSkew';

export interface RestartHistoryEntry {
  at: string;           // ISO
  reason: string;
  bucket: RestartBucket;
}

export interface RateLimitState {
  lastRestartAt: string; // ISO
  lastReason: string;
  history: RestartHistoryEntry[]; // newest-last, ring buffer
}

export const HISTORY_CAP = 50;
export const WATCHDOG_COOLDOWN_MS = 10 * 60 * 1000;        // 10 min
export const VERSION_SKEW_COOLDOWN_MS = 10 * 60 * 1000;    // 10 min between same-bucket
export const VERSION_SKEW_DAILY_CAP = 3;                   // max 3 per 24h
export const RESTART_STORM_WINDOW_MS = 60 * 60 * 1000;     // 1h window
export const RESTART_STORM_THRESHOLD = 6;                  // 6 restarts in 1h

export function statePath(stateDir: string): string {
  return path.join(stateDir, 'last-self-restart-at.json');
}

export type ReadOutcome =
  | { kind: 'clear'; state: null }
  | { kind: 'corrupt'; state: null; errorSignal: 'rateLimitFileCorrupt' }
  | { kind: 'skew'; state: RateLimitState | null; errorSignal: 'rateLimitFileSkew' }
  | { kind: 'ok'; state: RateLimitState };

/**
 * Read + classify the rate-limit file.
 *
 * - Missing            → { clear }
 * - Parse error / bad  → { corrupt } (signal + block)
 * - Future timestamp   → { skew } (signal + ALLOW — overwrite avoids deadlock)
 * - Otherwise          → { ok, state }
 */
export function readRateLimitState(stateDir: string, now = Date.now()): ReadOutcome {
  const p = statePath(stateDir);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'clear', state: null };
    }
    return { kind: 'corrupt', state: null, errorSignal: 'rateLimitFileCorrupt' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt', state: null, errorSignal: 'rateLimitFileCorrupt' };
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as RateLimitState).lastRestartAt !== 'string' ||
    !Array.isArray((parsed as RateLimitState).history)
  ) {
    return { kind: 'corrupt', state: null, errorSignal: 'rateLimitFileCorrupt' };
  }

  const state = parsed as RateLimitState;
  const t = Date.parse(state.lastRestartAt);
  if (Number.isNaN(t)) {
    return { kind: 'corrupt', state: null, errorSignal: 'rateLimitFileCorrupt' };
  }
  if (t > now) {
    return { kind: 'skew', state, errorSignal: 'rateLimitFileSkew' };
  }
  return { kind: 'ok', state };
}

export interface RateLimitDecision {
  allowed: boolean;
  reason?: string;   // why denied; undefined if allowed
  stormActive?: boolean; // true iff >= RESTART_STORM_THRESHOLD in window
}

/** Decide whether a restart in the given bucket is allowed right now. */
export function decide(
  outcome: ReadOutcome,
  bucket: RestartBucket,
  now = Date.now(),
): RateLimitDecision {
  if (outcome.kind === 'clear') return { allowed: true };
  if (outcome.kind === 'corrupt') return { allowed: false, reason: 'rate-limit-file-corrupt' };
  if (outcome.kind === 'skew') return { allowed: true };

  const state = outcome.state;
  const elapsed = Math.max(0, now - Date.parse(state.lastRestartAt));
  if (elapsed < WATCHDOG_COOLDOWN_MS) {
    return { allowed: false, reason: 'cooldown-active' };
  }

  if (bucket === 'versionSkew') {
    const recentSkew = state.history.filter(
      h => h.bucket === 'versionSkew' && now - Date.parse(h.at) < 24 * 60 * 60 * 1000
    ).length;
    if (recentSkew >= VERSION_SKEW_DAILY_CAP) {
      return { allowed: false, reason: 'version-skew-daily-cap' };
    }
  }

  const stormActive =
    state.history.filter(h => now - Date.parse(h.at) < RESTART_STORM_WINDOW_MS).length >=
    RESTART_STORM_THRESHOLD;
  return { allowed: true, stormActive };
}

export function writeRateLimitState(
  stateDir: string,
  reason: string,
  bucket: RestartBucket,
  prior: RateLimitState | null,
  now = Date.now(),
): RateLimitState {
  const nowIso = new Date(now).toISOString();
  const history = [...(prior?.history ?? []), { at: nowIso, reason, bucket }].slice(-HISTORY_CAP);
  const next: RateLimitState = {
    lastRestartAt: nowIso,
    lastReason: reason,
    history,
  };
  const p = statePath(stateDir);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
  return next;
}

export function isRestartStorm(state: RateLimitState | null, now = Date.now()): boolean {
  if (!state) return false;
  const recent = state.history.filter(h => now - Date.parse(h.at) < RESTART_STORM_WINDOW_MS);
  return recent.length >= RESTART_STORM_THRESHOLD;
}
