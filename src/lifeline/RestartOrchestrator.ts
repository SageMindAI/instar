/**
 * RestartOrchestrator — single-owner state machine for lifeline self-restart.
 *
 * Multiple initiators may fire concurrently:
 *   - LifelineHealthWatchdog (tick-based)
 *   - ForwardVersionSkewError handler (event-based)
 *   - SIGTERM handler (external, e.g., `instar lifeline restart`)
 *
 * All three route through `requestRestart()`. The orchestrator serializes
 * them: only the first transition from `idle` proceeds; subsequent requests
 * are logged and suppressed.
 *
 * State machine: idle → quiescing → persisting → exiting (terminal)
 *
 * Step 1 (quiesce) halts Telegram polling, replay loops, and the watchdog
 * BEFORE any persist, so the queue snapshot is causally consistent.
 *
 * The `exitFn` is injected so tests can assert the sequence without
 * terminating the test runner. Production injects `process.exit`.
 */

import { DegradationReporter } from '../monitoring/DegradationReporter.js';

export type RestartState = 'idle' | 'quiescing' | 'persisting' | 'exiting';

export interface RestartRequest {
  reason: string;              // e.g., 'noForwardStuck', 'version-skew', 'external-signal'
  bucket: 'watchdog' | 'versionSkew';
  context?: Record<string, unknown>;
}

export interface OrchestratorDeps {
  /** Halt polling, replay interval, watchdog timer; abort in-flight forwards. Returns when drained. */
  quiesce: () => Promise<void>;
  /** Persist all state files atomically. Returns when all writes complete. */
  persistAll: () => Promise<void>;
  /** Called to exit the process. Production: process.exit. Tests: spy. */
  exitFn: (code: number) => void;
  /** Whether this process runs under launchd (true) or dev (false). */
  isSupervised: boolean;
  /**
   * Returns true if a shadow-install update is in progress. The orchestrator
   * will defer the restart by one tick if so, per spec §Shadow-install coordination.
   * Tests can return a fixed value.
   */
  isShadowInstallUpdating?: () => boolean;
  /** Optional DegradationReporter override for tests. */
  reporter?: DegradationReporter;
  /** Maximum ms to wait for persistAll before hard-killing. */
  persistBudgetMs?: number;     // default 2000
  /** Hard-kill timeout — if persist hangs this long, call exitFn(1). */
  hardKillMs?: number;          // default 5000
  /** Defer duration if shadow-install lockfile is present. Default 30000 (one watchdog tick). */
  shadowInstallDeferMs?: number;
}

export class RestartOrchestrator {
  private _state: RestartState = 'idle';
  private readonly reporter: DegradationReporter;
  private readonly persistBudgetMs: number;
  private readonly hardKillMs: number;
  public lastSuppressed: { reason: string; currentState: RestartState } | null = null;

  constructor(private readonly deps: OrchestratorDeps) {
    this.reporter = deps.reporter ?? DegradationReporter.getInstance();
    this.persistBudgetMs = deps.persistBudgetMs ?? 2000;
    this.hardKillMs = deps.hardKillMs ?? 5000;
  }

  get state(): RestartState {
    return this._state;
  }

  /**
   * Attempt to initiate a restart. Only proceeds if currently idle.
   * Returns a promise that resolves only if the request was suppressed
   * (process didn't exit); otherwise the process exits before resolve.
   */
  async requestRestart(req: RestartRequest): Promise<'suppressed' | 'proceeded'> {
    // Synchronous guard — set BEFORE any await to prevent re-entry.
    if (this._state !== 'idle') {
      this.lastSuppressed = { reason: req.reason, currentState: this._state };
      console.log(
        `[RestartOrchestrator] restart-request-suppressed ` +
        `reason=${req.reason} currentState=${this._state}`
      );
      return 'suppressed';
    }
    this._state = 'quiescing';

    // Fire-and-forget degradation event (best-effort, budget 500ms).
    try {
      await Promise.race([
        Promise.resolve(
          this.reporter.report({
            feature: 'TelegramLifeline.selfRestart',
            primary: `exit-for-restart (${req.reason})`,
            fallback: 'launchd will respawn',
            reason: req.reason,
            impact: 'Lifeline process exits; message queue persisted; respawned by launchd.',
          }),
        ),
        new Promise<void>(resolve => setTimeout(resolve, 500)),
      ]);
    } catch {
      // best-effort; never block restart on telemetry failure
    }

    // Shadow-install coordination: if the updater is mid-`npm i`, defer by
    // one tick rather than respawn against a half-written tree. Spec §Shadow-
    // install coordination. A deferred restart re-enters idle and can be
    // re-requested on the next tick.
    if (this.deps.isShadowInstallUpdating?.()) {
      console.warn(
        `[RestartOrchestrator] restart-deferred-shadow-updating ` +
        `reason=${req.reason} — retry after tick`
      );
      this._state = 'idle';
      return 'suppressed';
    }

    // Unsupervised mode: log loud + stop here. Never call exitFn in dev/test.
    if (!this.deps.isSupervised) {
      console.warn(
        `[RestartOrchestrator] would restart (trigger=${req.reason}) but unsupervised; ` +
        `skipping exit. set INSTAR_SUPERVISED=1 to enable.`
      );
      this._state = 'idle';
      return 'suppressed';
    }

    // Step 1: quiesce — halt mutations before persist.
    try {
      await Promise.race([
        this.deps.quiesce(),
        new Promise<void>(resolve => setTimeout(resolve, 1000)),
      ]);
    } catch (err) {
      console.error(`[RestartOrchestrator] quiesce error (continuing): ${err}`);
    }

    // Step 2: persist. Budget 2s. Hard-kill fallback 5s from now.
    this._state = 'persisting';
    const hardKill = setTimeout(() => {
      console.error('[RestartOrchestrator] hard-kill: persist exceeded budget');
      this.deps.exitFn(1);
    }, this.hardKillMs);
    if (typeof hardKill.unref === 'function') hardKill.unref();

    try {
      await Promise.race([
        this.deps.persistAll(),
        new Promise<void>(resolve => setTimeout(resolve, this.persistBudgetMs)),
      ]);
    } catch (err) {
      console.error(`[RestartOrchestrator] persistAll error (continuing to exit): ${err}`);
    }

    // Step 3: exit.
    this._state = 'exiting';
    clearTimeout(hardKill);
    this.deps.exitFn(0);
    return 'proceeded';
  }

  /** Test helper: reset state to idle without exiting. Only safe in tests. */
  _resetForTesting(): void {
    this._state = 'idle';
    this.lastSuppressed = null;
  }
}
