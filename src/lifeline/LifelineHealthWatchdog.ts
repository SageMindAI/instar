/**
 * LifelineHealthWatchdog — detects stuck-loop conditions and requests
 * self-restart via the RestartOrchestrator. Signal-vs-authority: the
 * watchdog emits deterministic signals; the RestartOrchestrator is the
 * sole authority that decides whether to actually exit.
 *
 * Three signals, fixed priority (highest first):
 *   1. conflict409Stuck   — consecutive 409s pinned >5 min
 *   2. noForwardStuck     — oldest queued message older than 10 min
 *                           (NOT "time since last success" — that would
 *                            crash-loop low-traffic agents)
 *   3. consecutiveFailures — >20 consecutive forward failures
 *
 * All three signals in one tick fire a single restart request whose
 * `reason` is the highest-priority tripped signal and whose `context`
 * carries all tripped signal names + snapshot values.
 *
 * Signal latching: if a signal crosses threshold during an active
 * rate-limit window, it is latched. At the next tick after cooldown
 * expires, still-above-threshold latched signals fire; de-crossed ones
 * are dropped.
 */

export interface WatchdogThresholds {
  tickIntervalMs: number;              // default 30_000
  noForwardStuckMs: number;            // default 600_000 (10 min)
  consecutiveFailureMax: number;       // default 20
  conflict409StuckMs: number;          // default 300_000 (5 min)
  starvationMultiplier: number;        // default 3 (→ 90s)
}

export const DEFAULT_WATCHDOG_THRESHOLDS: WatchdogThresholds = {
  tickIntervalMs: 30_000,
  noForwardStuckMs: 10 * 60 * 1000,
  consecutiveFailureMax: 20,
  conflict409StuckMs: 5 * 60 * 1000,
  starvationMultiplier: 3,
};

export type SignalName = 'conflict409Stuck' | 'noForwardStuck' | 'consecutiveFailures';

export const SIGNAL_PRIORITY: readonly SignalName[] = [
  'conflict409Stuck',
  'noForwardStuck',
  'consecutiveFailures',
] as const;

export interface WatchdogInputs {
  now: number;
  /** Timestamp (ms) of oldest queued message, or undefined if queue empty. */
  oldestQueueItemEnqueuedAt: number | undefined;
  /** Count of consecutive forward failures (reset on 2xx). */
  consecutiveForwardFailures: number;
  /** Timestamp when consecutive409s transitioned 0→>0, null otherwise. */
  conflict409StartedAt: number | null;
  /** Whether supervisor currently reports the server healthy. */
  serverHealthy: boolean;
}

export interface SignalSnapshot {
  oldestQueueItemAgeMs: number | null;
  consecutiveForwardFailures: number;
  conflict409AgeMs: number | null;
  serverHealthy: boolean;
}

export interface TripResult {
  tripped: SignalName[];
  primary: SignalName | null;      // highest-priority tripped
  snapshot: SignalSnapshot;
}

export function evaluate(inputs: WatchdogInputs, thresholds: WatchdogThresholds): TripResult {
  const tripped: SignalName[] = [];

  const conflict409AgeMs =
    inputs.conflict409StartedAt !== null ? inputs.now - inputs.conflict409StartedAt : null;
  if (conflict409AgeMs !== null && conflict409AgeMs > thresholds.conflict409StuckMs) {
    tripped.push('conflict409Stuck');
  }

  // noForwardStuck — ONLY fires when queue is non-empty AND the oldest
  // queued item has been waiting > threshold AND supervisor reports healthy.
  // The healthy gate prevents double-firing with "server is down" recovery.
  const oldestAgeMs =
    inputs.oldestQueueItemEnqueuedAt !== undefined
      ? inputs.now - inputs.oldestQueueItemEnqueuedAt
      : null;
  if (
    oldestAgeMs !== null &&
    oldestAgeMs > thresholds.noForwardStuckMs &&
    inputs.serverHealthy
  ) {
    tripped.push('noForwardStuck');
  }

  if (inputs.consecutiveForwardFailures > thresholds.consecutiveFailureMax) {
    tripped.push('consecutiveFailures');
  }

  const primary = SIGNAL_PRIORITY.find(s => tripped.includes(s)) ?? null;
  return {
    tripped,
    primary,
    snapshot: {
      oldestQueueItemAgeMs: oldestAgeMs,
      consecutiveForwardFailures: inputs.consecutiveForwardFailures,
      conflict409AgeMs,
      serverHealthy: inputs.serverHealthy,
    },
  };
}

export interface WatchdogOptions {
  thresholds?: Partial<WatchdogThresholds>;
  /** Read inputs fresh on each tick. */
  getInputs: () => WatchdogInputs;
  /** Invoked when watchdog wants a restart. Orchestrator decides if it happens. */
  onTrip: (result: TripResult) => void;
  /** Invoked when tick interval was delayed > starvationMultiplier × tickInterval. */
  onStarved?: (actualGapMs: number) => void;
  /** Disable auto-start; tests call tick() directly. */
  autoStart?: boolean;
}

export class LifelineHealthWatchdog {
  readonly thresholds: WatchdogThresholds;
  private timer: NodeJS.Timeout | null = null;
  private lastTickAt = 0;
  // Latches: signal name → true means we observed threshold cross while
  // another restart-blocker was active; re-evaluated on subsequent ticks.
  private latched = new Set<SignalName>();

  constructor(private readonly opts: WatchdogOptions) {
    this.thresholds = { ...DEFAULT_WATCHDOG_THRESHOLDS, ...(opts.thresholds ?? {}) };
    if (opts.autoStart !== false) this.start();
  }

  start(): void {
    if (this.timer) return;
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => this.tick(), this.thresholds.tickIntervalMs);
    // Prevent holding the event loop in dev/test mode.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Public for tests; internal tick. */
  tick(): void {
    const inputs = this.opts.getInputs();
    const gap = inputs.now - this.lastTickAt;
    if (
      this.lastTickAt > 0 &&
      gap > this.thresholds.starvationMultiplier * this.thresholds.tickIntervalMs
    ) {
      this.opts.onStarved?.(gap);
    }
    this.lastTickAt = inputs.now;

    const result = evaluate(inputs, this.thresholds);
    // Re-check latched signals: drop any that de-crossed.
    for (const sig of [...this.latched]) {
      if (!result.tripped.includes(sig)) this.latched.delete(sig);
    }
    // Add newly-tripped signals to the latch pool in case rate limit blocks.
    for (const sig of result.tripped) this.latched.add(sig);

    if (result.primary) this.opts.onTrip(result);
  }

  /** For tests: inspect the latched set. */
  _latchedForTesting(): Set<SignalName> {
    return new Set(this.latched);
  }
}
