/**
 * LlmQueue — Shared priority-laned LLM call queue
 *
 * Extracted from PresenceProxy (per PROMISE-BEACON-SPEC.md Phase 1) so both
 * PresenceProxy and PromiseBeacon can share a single concurrency + daily
 * spend budget.
 *
 * Two lanes with a reservation rule:
 *   - interactive (default 40% reserve): PresenceProxy tiers, delivery verify
 *   - background: PromiseBeacon heartbeats, Sentinel shadow scans
 *
 * When the interactive lane has work and the provider concurrency limit is
 * hit, the queue aborts the lowest-priority in-flight background call via
 * AbortController, freeing a slot for the interactive arrival. Aborted
 * background callers see an `LlmAbortedError` and can fall back to a
 * templated response.
 */
export type LlmLane = 'interactive' | 'background';

export class LlmAbortedError extends Error {
  constructor() {
    super('LLM call aborted by higher-priority lane');
    this.name = 'LlmAbortedError';
  }
}

export interface LlmQueueOptions {
  /** Max concurrent in-flight calls (default 3). */
  maxConcurrent?: number;
  /** Fraction of `maxDailyCents` reserved for the interactive lane. Default 0.4. */
  interactiveReservePct?: number;
  /** Daily spend cap in cents across both lanes. Default 100. */
  maxDailyCents?: number;
  /** Provide `Date.now()` — injectable for tests. */
  now?: () => number;
}

interface InFlight {
  lane: LlmLane;
  controller: AbortController;
  reject: (err: Error) => void;
}

interface Waiter {
  lane: LlmLane;
  fn: (signal: AbortSignal) => Promise<string>;
  costCents: number;
  resolve: (v: string) => void;
  reject: (e: Error) => void;
}

export class LlmQueue {
  private maxConcurrent: number;
  private interactiveReservePct: number;
  private maxDailyCents: number;
  private now: () => number;

  private inFlight: Set<InFlight> = new Set();
  private waiters: Waiter[] = [];

  /** Daily spend ledger: { dateKey: 'YYYY-MM-DD', cents: number, interactive: number } */
  private dailySpendCents = 0;
  private dailyInteractiveCents = 0;
  private dailyDateKey = '';

  constructor(opts: LlmQueueOptions = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? 3;
    this.interactiveReservePct = opts.interactiveReservePct ?? 0.4;
    this.maxDailyCents = opts.maxDailyCents ?? 100;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Enqueue a call.
   *
   * `fn` receives an AbortSignal — callers MUST honor it. Aborted callers
   * should throw (the queue will reject with LlmAbortedError).
   *
   * `costCents` is the caller's best estimate of the call cost. Used only
   * for the daily cap — if the cap is already exceeded the call is rejected.
   */
  async enqueue(
    lane: LlmLane,
    fn: (signal: AbortSignal) => Promise<string>,
    costCents = 0,
  ): Promise<string> {
    this.rollDateIfNeeded();

    // Daily cap check.
    if (this.dailySpendCents + costCents > this.maxDailyCents) {
      throw new Error('LLM daily spend cap exceeded');
    }
    // Per-lane reserve: interactive lane is guaranteed ≥ reservePct; background
    // lane cannot push total into the reserved portion once interactive floor
    // is unmet.
    const reservedForInteractive = Math.floor(this.maxDailyCents * this.interactiveReservePct);
    if (lane === 'background') {
      const remainingAfter = this.maxDailyCents - (this.dailySpendCents + costCents);
      if (remainingAfter < reservedForInteractive - this.dailyInteractiveCents) {
        throw new Error('LLM background lane would breach interactive reserve');
      }
    }

    return new Promise<string>((resolve, reject) => {
      this.waiters.push({ lane, fn, costCents, resolve, reject });
      this.drain();
    });
  }

  /**
   * Try to start as many waiters as concurrency allows. Interactive waiters
   * that cannot start because the concurrency limit is hit will trigger
   * abort() of an in-flight background call.
   */
  private drain(): void {
    // Sort waiters so interactive comes first.
    this.waiters.sort((a, b) => (a.lane === b.lane ? 0 : a.lane === 'interactive' ? -1 : 1));

    while (this.waiters.length > 0) {
      const next = this.waiters[0];

      if (this.inFlight.size < this.maxConcurrent) {
        this.waiters.shift();
        this.start(next);
        continue;
      }

      // Full. If the waiter is interactive, try to preempt a background.
      if (next.lane === 'interactive') {
        const victim = [...this.inFlight].find(f => f.lane === 'background');
        if (victim) {
          victim.controller.abort();
          victim.reject(new LlmAbortedError());
          this.inFlight.delete(victim);
          // Loop again; next iteration starts the interactive waiter.
          continue;
        }
      }

      // Either the waiter is background and pool is full, or pool is full
      // of interactive calls. Wait for something to complete.
      break;
    }
  }

  private start(w: Waiter): void {
    const controller = new AbortController();
    const inflight: InFlight = {
      lane: w.lane,
      controller,
      reject: w.reject,
    };
    this.inFlight.add(inflight);

    w.fn(controller.signal)
      .then(result => {
        if (!this.inFlight.has(inflight)) return; // aborted
        this.inFlight.delete(inflight);
        this.dailySpendCents += w.costCents;
        if (w.lane === 'interactive') this.dailyInteractiveCents += w.costCents;
        w.resolve(result);
        this.drain();
      })
      .catch(err => {
        if (!this.inFlight.has(inflight)) return; // already rejected by abort
        this.inFlight.delete(inflight);
        w.reject(err);
        this.drain();
      });
  }

  private rollDateIfNeeded(): void {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.dailyDateKey) {
      this.dailyDateKey = today;
      this.dailySpendCents = 0;
      this.dailyInteractiveCents = 0;
    }
  }

  /** Test / diagnostic accessors. */
  getDailySpendCents(): number {
    this.rollDateIfNeeded();
    return this.dailySpendCents;
  }
  getInFlightCount(): number {
    return this.inFlight.size;
  }
  getWaitingCount(): number {
    return this.waiters.length;
  }
  getInFlightLanes(): LlmLane[] {
    return [...this.inFlight].map(f => f.lane);
  }
}
