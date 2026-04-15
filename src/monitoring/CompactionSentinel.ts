/**
 * CompactionSentinel — Owns the full lifecycle of recovering a Claude session
 * after context compaction.
 *
 * Prior behavior (before this class): three independent triggers —
 * PreCompact hook event, SessionWatchdog 'compaction-idle' poll, and the
 * compaction-recovery.sh endpoint — each called `recoverCompactedSession`
 * fire-and-forget. If the injection didn't wake the session up (session
 * genuinely hung, injection silently dropped, Claude process dead), nobody
 * noticed. The idle-prompt zombie-killer then raced the recovery window
 * and killed the session 15 minutes later, wiping the conversation.
 *
 * What this class adds:
 *   1. Dedupe across triggers — once a session is in recovery, additional
 *      reports within the guard window are ignored.
 *   2. Verification — after each inject attempt, watch the session's JSONL
 *      file for size/mtime growth, which is the cheapest reliable signal
 *      that Claude actually processed the prompt and produced output.
 *   3. Retry with backoff — if verification fails within the window, try
 *      injecting again, up to `maxInjectAttempts`.
 *   4. Zombie-kill veto — while a recovery is in flight, SessionManager's
 *      idle-prompt cleanup is told to leave the session alone via the
 *      activeRecoveryChecker hook.
 *   5. Observable outcomes — emits `compaction:detected`,
 *      `compaction:inject-attempted`, `compaction:recovered`,
 *      `compaction:failed` events with a single `[Sentinel]` log prefix
 *      so the full lifecycle is greppable.
 *
 * Decoupling: the class takes a `recoverFn` in its deps rather than pulling
 * in server.ts. The existing `recoverCompactedSession` helper is passed
 * straight through, which keeps message-bus / topic-routing concerns out
 * of this file.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

export type CompactionTrigger = 'PreCompact' | 'watchdog-poll' | 'recovery-hook' | string;

export type CompactionStatus =
  | 'pending-inject'    // state created; first inject dispatched
  | 'verifying'         // inject done, waiting for verify-window to elapse
  | 'retrying'          // verification failed, scheduling next attempt
  | 'recovered'         // session produced output → success
  | 'failed';           // max attempts exhausted without recovery

export interface RecoveryState {
  sessionName: string;
  trigger: CompactionTrigger;
  detectedAt: number;
  attempts: number;
  lastInjectAt: number;
  baselineJsonlPath: string | null;
  baselineJsonlSize: number | null;
  baselineJsonlMtime: number | null;
  status: CompactionStatus;
}

export interface CompactionSentinelDeps {
  /**
   * Actually perform a recovery injection on a session. The sentinel uses this
   * rather than talking to SessionManager directly so topic/channel routing
   * stays in server.ts. Returns whether the injection was accepted.
   */
  recoverFn: (sessionName: string, triggerLabel: string) => Promise<boolean>;

  /**
   * Project directory, used to locate Claude Code's JSONL files for the
   * verification check. Usually `config.projectDir`.
   */
  projectDir: string;

  /**
   * Override for the JSONL lookup root. Primarily for tests. Defaults to
   * `$HOME/.claude/projects/<project-hash>`.
   */
  jsonlRoot?: string;

  /** Override for Date.now — for tests. */
  now?: () => number;

  /** Override timer setters — for tests. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface CompactionSentinelConfig {
  /** Ignore repeat reports for the same session within this window. */
  dedupeWindowMs?: number;
  /** How long to wait after injection before verifying output. */
  verifyWindowMs?: number;
  /** Max inject attempts before declaring failure. */
  maxInjectAttempts?: number;
  /** Max total time a recovery can block the zombie-killer. */
  recoveryGuardMs?: number;
}

const DEFAULTS = {
  dedupeWindowMs: 60_000,          // 1 minute — catch overlapping triggers
  verifyWindowMs: 25_000,          // 25s — enough for claude to boot past recovery hook and emit output
  maxInjectAttempts: 3,
  recoveryGuardMs: 10 * 60_000,    // 10 minutes — protection from zombie-killer
};

export interface CompactionSentinelEvents {
  'compaction:detected': [RecoveryState];
  'compaction:inject-attempted': [RecoveryState & { accepted: boolean }];
  'compaction:recovered': [RecoveryState & { jsonlDelta: number }];
  'compaction:failed': [RecoveryState & { reason: string }];
}

export class CompactionSentinel extends EventEmitter {
  private readonly deps: CompactionSentinelDeps;
  private readonly cfg: Required<CompactionSentinelConfig>;
  private readonly active = new Map<string, RecoveryState>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly recentReports = new Map<string, number>(); // sessionName → lastReportedAt

  constructor(deps: CompactionSentinelDeps, config: CompactionSentinelConfig = {}) {
    super();
    this.deps = deps;
    this.cfg = {
      dedupeWindowMs: config.dedupeWindowMs ?? DEFAULTS.dedupeWindowMs,
      verifyWindowMs: config.verifyWindowMs ?? DEFAULTS.verifyWindowMs,
      maxInjectAttempts: config.maxInjectAttempts ?? DEFAULTS.maxInjectAttempts,
      recoveryGuardMs: config.recoveryGuardMs ?? DEFAULTS.recoveryGuardMs,
    };
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    return this.deps.setTimer ? this.deps.setTimer(fn, ms) : setTimeout(fn, ms);
  }

  private clearTimer(handle: ReturnType<typeof setTimeout>): void {
    if (this.deps.clearTimer) this.deps.clearTimer(handle);
    else clearTimeout(handle);
  }

  /**
   * Report a compaction event for a session. Called by all three trigger paths
   * (PreCompact hook, watchdog poll, recovery-hook endpoint). Deduped — if the
   * same session is already in active recovery or was reported within the
   * dedupe window, this is a no-op.
   */
  report(sessionName: string, trigger: CompactionTrigger): void {
    const now = this.now();

    if (this.active.has(sessionName)) {
      return; // Recovery already in flight — ignore duplicate trigger.
    }
    const lastReport = this.recentReports.get(sessionName);
    if (lastReport && now - lastReport < this.cfg.dedupeWindowMs) {
      return; // Already reported recently.
    }
    this.recentReports.set(sessionName, now);

    const baseline = this.readJsonlBaseline();
    const state: RecoveryState = {
      sessionName,
      trigger,
      detectedAt: now,
      attempts: 0,
      lastInjectAt: 0,
      baselineJsonlPath: baseline?.path ?? null,
      baselineJsonlSize: baseline?.size ?? null,
      baselineJsonlMtime: baseline?.mtime ?? null,
      status: 'pending-inject',
    };
    this.active.set(sessionName, state);

    console.log(
      `[Sentinel] detected compaction on "${sessionName}" via ${trigger}; ` +
      `baseline jsonl: ${state.baselineJsonlPath ? path.basename(state.baselineJsonlPath) : 'none'} ` +
      `size=${state.baselineJsonlSize ?? 'n/a'}`,
    );
    this.emit('compaction:detected', state);
    this.attemptInjection(state);
  }

  /**
   * Predicate for SessionManager's zombie-killer: is this session currently
   * being recovered? If yes, the zombie-killer should skip it.
   */
  isRecoveryActive(sessionName: string): boolean {
    const state = this.active.get(sessionName);
    if (!state) return false;
    // Don't claim active for terminal states (defense in depth).
    return state.status !== 'recovered' && state.status !== 'failed';
  }

  /**
   * Manually clear recovery state. Used when the session completes or is
   * explicitly reset. Exposed mainly for tests and edge cases.
   */
  clear(sessionName: string): void {
    const timer = this.timers.get(sessionName);
    if (timer) {
      this.clearTimer(timer);
      this.timers.delete(sessionName);
    }
    this.active.delete(sessionName);
  }

  /** Stop all pending timers. Safe to call multiple times. */
  stop(): void {
    for (const handle of this.timers.values()) this.clearTimer(handle);
    this.timers.clear();
    this.active.clear();
    this.recentReports.clear();
  }

  /** Get current active recovery state (test introspection). */
  getState(sessionName: string): RecoveryState | undefined {
    return this.active.get(sessionName);
  }

  private async attemptInjection(state: RecoveryState): Promise<void> {
    state.attempts += 1;
    state.lastInjectAt = this.now();
    state.status = 'pending-inject';

    let accepted = false;
    try {
      accepted = await this.deps.recoverFn(state.sessionName, state.trigger);
    } catch (err) {
      console.warn(`[Sentinel] recoverFn threw on "${state.sessionName}" (attempt ${state.attempts}):`, err);
    }

    console.log(
      `[Sentinel] inject-attempted on "${state.sessionName}" ` +
      `(attempt ${state.attempts}/${this.cfg.maxInjectAttempts}, accepted=${accepted})`,
    );
    this.emit('compaction:inject-attempted', { ...state, accepted });

    if (!accepted) {
      // recoverFn returned false — typically means no unanswered user message,
      // session not alive, or injection blocked. No point retrying; close out.
      this.finalize(state, 'failed', 'recoverFn declined (no pending work or session gone)');
      return;
    }

    state.status = 'verifying';
    const handle = this.setTimer(() => {
      this.verifyRecovery(state).catch(err => {
        console.warn(`[Sentinel] verify threw on "${state.sessionName}":`, err);
        this.finalize(state, 'failed', `verify threw: ${String(err)}`);
      });
    }, this.cfg.verifyWindowMs);
    this.timers.set(state.sessionName, handle);
  }

  private async verifyRecovery(state: RecoveryState): Promise<void> {
    this.timers.delete(state.sessionName);

    // Has the jsonl file grown? If so, claude processed the prompt and emitted.
    const current = this.readJsonlBaseline();
    const grew =
      state.baselineJsonlSize !== null &&
      current !== null &&
      (current.size > state.baselineJsonlSize ||
        (current.path === state.baselineJsonlPath &&
          state.baselineJsonlMtime !== null &&
          current.mtime > state.baselineJsonlMtime));

    if (grew) {
      const delta = (current?.size ?? 0) - (state.baselineJsonlSize ?? 0);
      console.log(
        `[Sentinel] recovered "${state.sessionName}" after ${state.attempts} attempt(s) ` +
        `(jsonl grew by ${delta} bytes)`,
      );
      this.emit('compaction:recovered', { ...state, jsonlDelta: delta });
      this.finalize(state, 'recovered');
      return;
    }

    // No growth — session didn't respond within the window.
    if (state.attempts >= this.cfg.maxInjectAttempts) {
      this.finalize(
        state,
        'failed',
        `no jsonl growth after ${state.attempts} attempts (${state.attempts * this.cfg.verifyWindowMs}ms total wait)`,
      );
      return;
    }

    // Retry.
    state.status = 'retrying';
    console.log(
      `[Sentinel] retry "${state.sessionName}" ` +
      `(attempt ${state.attempts}/${this.cfg.maxInjectAttempts} produced no output, re-injecting)`,
    );
    await this.attemptInjection(state);
  }

  private finalize(state: RecoveryState, status: 'recovered' | 'failed', reason?: string): void {
    state.status = status;
    if (status === 'failed') {
      console.warn(`[Sentinel] failed "${state.sessionName}": ${reason ?? 'unknown'}`);
      this.emit('compaction:failed', { ...state, reason: reason ?? 'unknown' });
    }
    // Keep the state around just long enough to exit the recovery-guard window
    // (so the zombie-killer won't race the next prompt). Then clean up.
    const keepFor = status === 'recovered' ? 5_000 : 30_000;
    const handle = this.setTimer(() => {
      this.timers.delete(state.sessionName);
      this.active.delete(state.sessionName);
    }, keepFor);
    this.timers.set(state.sessionName, handle);
  }

  /**
   * Look up the most recently-modified Claude Code JSONL file for this
   * project. Returns path/size/mtime, or null if none found.
   */
  private readJsonlBaseline(): { path: string; size: number; mtime: number } | null {
    try {
      const root = this.deps.jsonlRoot
        || path.join(process.env.HOME || '/tmp', '.claude', 'projects',
                     this.deps.projectDir.replace(/\//g, '-'));
      if (!fs.existsSync(root)) return null;
      const entries = fs.readdirSync(root).filter(f => f.endsWith('.jsonl'));
      if (entries.length === 0) return null;
      const latest = entries
        .map(f => {
          const full = path.join(root, f);
          const st = fs.statSync(full);
          return { path: full, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime)[0];
      return latest;
    } catch {
      return null;
    }
  }
}
