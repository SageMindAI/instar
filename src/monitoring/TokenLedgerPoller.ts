/**
 * TokenLedgerPoller — periodically calls TokenLedger.scanAll() to keep
 * the SQLite rollup up to date with whatever Claude Code has written.
 *
 * Read-only observability: never mutates the source JSONL files.
 */
import type { TokenLedger } from './TokenLedger.js';

export interface TokenLedgerPollerOptions {
  ledger: TokenLedger;
  /** Polling interval (ms). Defaults to 60_000. */
  intervalMs?: number;
  /** Optional logger (defaults to console.warn for errors only). */
  onError?: (err: unknown) => void;
}

export class TokenLedgerPoller {
  private ledger: TokenLedger;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private onError: (err: unknown) => void;

  constructor(opts: TokenLedgerPollerOptions) {
    this.ledger = opts.ledger;
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.onError = opts.onError ?? ((err) => {
      console.warn('[token-ledger] scan error:', err);
    });
  }

  start(): void {
    if (this.timer) return;
    // Immediate first tick (non-blocking) so the dashboard has data fast.
    queueMicrotask(() => this.tick());
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (this.running) return;
    this.running = true;
    // Fire-and-forget the async scan; reentry guard above prevents stacking.
    // We do NOT await — setInterval already drives cadence, and awaiting
    // here would block other interval callbacks in this microtask queue.
    this.ledger
      .scanAllAsync()
      .catch((err) => this.onError(err))
      .finally(() => {
        this.running = false;
      });
  }
}
