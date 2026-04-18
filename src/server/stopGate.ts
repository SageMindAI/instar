/**
 * stopGate.ts — UnjustifiedStopGate server infrastructure (PR0a).
 *
 * Provides the read-side API surface that the future stop-hook router
 * consumes (PR3). State is in-memory for PR0a; PR3 migrates to SQLite.
 *
 * Spec: docs/specs/context-death-pitfall-prevention.md
 *
 * PR0a deliverables:
 * - Hot-path batched state assembly: {mode, killSwitch, autonomousActive,
 *   compactionInFlight, sessionStartTs}
 * - Kill-switch local fast-path (set/clear/get)
 * - Compaction probe (P0.6): /tmp/claude-session-<id>/compacting OR
 *   compaction-recovery.sh mtime within 60s
 * - Version contract constants for /health
 *
 * Threat model: drift-correction, NOT security boundary. See spec §
 * "Threat model".
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Version contract (P0.7) ─────────────────────────────────────────────
//
// `GATE_ROUTE_VERSION` is the protocol version this server speaks on
// the /internal/stop-gate/* routes. Hook-lib reads it from /health and
// emits a one-time DegradationReport if its required minimum is greater
// than what the server exposes.
//
// `GATE_ROUTE_MINIMUM_VERSION` is the lowest hook-lib version this
// server will accept without degraded-mode warnings. Bump in lockstep
// with breaking changes to the hot-path schema.
export const GATE_ROUTE_VERSION = 1;
export const GATE_ROUTE_MINIMUM_VERSION = 1;

// ── Mode + kill-switch state (in-memory, PR0a) ───────────────────────────
//
// Mode is the operating mode of the gate. Default 'off' so PR0a ships
// completely inert — the spec's PR4 lands the CLI that flips to shadow.
//
// killSwitch overrides mode regardless of value. Drift-rollback semantic:
// any operator can flip it instantly via the local fast-path endpoint.
export type GateMode = 'off' | 'shadow' | 'enforce';

interface GateState {
  mode: GateMode;
  killSwitch: boolean;
  // sessionStartTs is keyed by sessionId; populated by SessionStart hook
  // events received via /hooks/events. PR3 migrates to a sessions(sessions
  // table) row.
  sessionStartTs: Map<string, number>;
}

const state: GateState = {
  mode: 'off',
  killSwitch: false,
  sessionStartTs: new Map(),
};

export function getMode(): GateMode {
  return state.mode;
}

export function setMode(mode: GateMode): void {
  state.mode = mode;
}

export function getKillSwitch(): boolean {
  return state.killSwitch;
}

/**
 * Set kill-switch state in-memory. Returns the prior value so the caller
 * can detect no-op flips for telemetry.
 *
 * PR0a does NOT propagate to the machine registry — that fanout lands in
 * PR4 alongside the CLI. The server can be killed via the local fast-path
 * endpoint immediately; remote machines catch up later.
 */
export function setKillSwitch(value: boolean): boolean {
  const prior = state.killSwitch;
  state.killSwitch = value;
  return prior;
}

/**
 * Record the SessionStart timestamp for a session id. Idempotent:
 * subsequent calls for the same id are no-ops (first SessionStart wins —
 * we track the original session boundary, not later resumes).
 *
 * Called by the /hooks/events handler when a SessionStart event arrives.
 */
export function recordSessionStart(sessionId: string, timestampMs: number): void {
  if (!sessionId) return;
  if (state.sessionStartTs.has(sessionId)) return;
  state.sessionStartTs.set(sessionId, timestampMs);
}

export function getSessionStartTs(sessionId: string): number | null {
  if (!sessionId) return null;
  return state.sessionStartTs.get(sessionId) ?? null;
}

/**
 * Test-only reset. Production code must not call this.
 */
export function _resetForTests(): void {
  state.mode = 'off';
  state.killSwitch = false;
  state.sessionStartTs.clear();
}

// ── Compaction probe (P0.6) ─────────────────────────────────────────────
//
// Best-effort signal that compaction is currently in flight. Two sources:
//
//   1. If Claude Code exposes `/tmp/claude-session-<id>/compacting`, the
//      file's existence is authoritative.
//   2. Heuristic fallback: `compaction-recovery.sh` mtime within last 60s.
//      Beyond 60s the signal is stale and ignored.
//
// Returning false on any error (fail-open) — drift-correction model, the
// gate's hot-path treats compactionInFlight as a routing hint, not a
// safety-critical assertion.
const COMPACTION_HEURISTIC_WINDOW_MS = 60_000;

export interface CompactionProbeOptions {
  /** Session id used to look up the per-session marker file. */
  sessionId?: string;
  /** Path to compaction-recovery.sh (for mtime heuristic). Defaults to
   *  the agent-local hook path. Tests inject a tmp path. */
  recoveryScriptPath?: string;
  /** Override "now" for tests. */
  now?: number;
}

export function compactionInFlight(opts: CompactionProbeOptions = {}): boolean {
  const now = opts.now ?? Date.now();

  // Source 1: authoritative marker file (if present).
  if (opts.sessionId) {
    const marker = `/tmp/claude-session-${opts.sessionId}/compacting`;
    try {
      if (fs.existsSync(marker)) return true;
    } catch {
      // fail-open
    }
  }

  // Source 2: recovery script mtime heuristic.
  const recoveryPath = opts.recoveryScriptPath
    ?? path.resolve(process.cwd(), '.instar/hooks/instar/compaction-recovery.sh');
  try {
    const st = fs.statSync(recoveryPath);
    const ageMs = now - st.mtimeMs;
    if (ageMs >= 0 && ageMs <= COMPACTION_HEURISTIC_WINDOW_MS) return true;
  } catch {
    // fail-open: missing recovery script is reported separately by
    // health probes, not by this gate.
  }

  return false;
}

// ── Hot-path batched state ──────────────────────────────────────────────
//
// Single read returning all five fields the stop-hook router needs in one
// HTTP round-trip. Hook caches the response in /tmp/instar-<agent>-stop-
// gate-hot-path.json with mtime-TTL 60s — server doesn't need to be
// involved in caching.

export interface HotPathState {
  mode: GateMode;
  killSwitch: boolean;
  autonomousActive: boolean;
  compactionInFlight: boolean;
  sessionStartTs: number | null;
  routeVersion: number;
}

export interface HotPathInputs {
  sessionId?: string;
  /** Whether the current agent is in autonomous mode. PR0a reads it from
   *  the autonomous-state.local.md file convention; PR3 may use a
   *  finer-grained source. Pass an explicit boolean to override (tests). */
  autonomousActiveOverride?: boolean;
  autonomousStateFile?: string;
  recoveryScriptPath?: string;
  now?: number;
}

/**
 * Heuristic for autonomousActive: existence of `.claude/autonomous-state
 * .local.md` is the existing convention agents use to signal autonomous
 * intent. Tests may override.
 */
function readAutonomousActive(opts: HotPathInputs): boolean {
  if (typeof opts.autonomousActiveOverride === 'boolean') {
    return opts.autonomousActiveOverride;
  }
  const file = opts.autonomousStateFile
    ?? path.resolve(process.cwd(), '.claude/autonomous-state.local.md');
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

export function getHotPathState(opts: HotPathInputs = {}): HotPathState {
  return {
    mode: state.mode,
    killSwitch: state.killSwitch,
    autonomousActive: readAutonomousActive(opts),
    compactionInFlight: compactionInFlight({
      sessionId: opts.sessionId,
      recoveryScriptPath: opts.recoveryScriptPath,
      now: opts.now,
    }),
    sessionStartTs: opts.sessionId ? getSessionStartTs(opts.sessionId) : null,
    routeVersion: GATE_ROUTE_VERSION,
  };
}
