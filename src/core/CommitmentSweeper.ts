/**
 * CommitmentSweeper — background sweepers for commitment lifecycle.
 *
 * Part of Integrated-Being v2 (docs/specs/integrated-being-ledger-v2.md §4).
 *
 * Two sweepers:
 *
 * - sweepExpired() — hourly. Scans recent ledger entries for commitments
 *   with status=open + deadline<now. For each, emits a note entry with
 *   supersedes pointing at the commitment and subject
 *   "expired: deadline passed without resolution". Bounded: max 100
 *   emissions per run (to avoid a large-backlog stampede after a
 *   downtime).
 *
 * - sweepStranded() — daily. Scans for commitments whose creator session
 *   has been purged from the registry for 24h+. For each, emits a note
 *   entry with subject "stranded: creating session no longer exists".
 *
 * Both are SIGNAL-shaped (per docs/signal-vs-authority.md): they
 * observe and record; they do NOT mutate commitment entries. The
 * original commitment stays kind=commitment with status=open; the
 * effective status is a render-time derivation. This lets readers
 * audit both the original utterance and the subsequent subsystem
 * observation independently.
 *
 * Degradation: each sweeper is try-caught; errors report to
 * DegradationReporter and the loop continues next tick.
 */

import type { SharedStateLedger } from './SharedStateLedger.js';
import type { LedgerSessionRegistry } from './LedgerSessionRegistry.js';
import type { LedgerEntry } from './types.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

export const DEFAULT_SWEEP_BATCH_LIMIT = 100;
export const DEFAULT_EXPIRED_INTERVAL_MS = 60 * 60 * 1000; // 1h
export const DEFAULT_STRANDED_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
/** Stranded sweep targets commitments whose creator session has been
 *  gone from the registry for at least this long. Spec §4. */
export const DEFAULT_STRANDED_AGE_MS = 24 * 60 * 60 * 1000;

export interface CommitmentSweeperOptions {
  ledger: SharedStateLedger;
  /** Registry — used to check whether a commitment's creator session is
   *  still known. */
  registry: LedgerSessionRegistry;
  /** Optional clock override for tests. */
  now?: () => number;
  /** Max emissions per run (default 100). */
  batchLimit?: number;
  /** Stranded-age threshold (default 24h). */
  strandedAgeMs?: number;
  /** Agent instance label used on emitted note entries. */
  instance: string;
  /** Optional degradation reporter. */
  degradationReporter?: DegradationReporter;
}

export interface SweepResult {
  /** Number of entries emitted. */
  emitted: number;
  /** Number of candidates scanned. */
  scanned: number;
  /** True if the batch limit was reached (more may be pending). */
  truncated: boolean;
}

export class CommitmentSweeper {
  private readonly ledger: SharedStateLedger;
  private readonly registry: LedgerSessionRegistry;
  private readonly now: () => number;
  private readonly batchLimit: number;
  private readonly strandedAgeMs: number;
  private readonly instance: string;
  private readonly degradation: DegradationReporter;

  private expiredTimer: ReturnType<typeof setInterval> | null = null;
  private strandedTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: CommitmentSweeperOptions) {
    this.ledger = opts.ledger;
    this.registry = opts.registry;
    this.now = opts.now ?? Date.now;
    this.batchLimit = opts.batchLimit ?? DEFAULT_SWEEP_BATCH_LIMIT;
    this.strandedAgeMs = opts.strandedAgeMs ?? DEFAULT_STRANDED_AGE_MS;
    this.instance = opts.instance;
    this.degradation =
      opts.degradationReporter ?? DegradationReporter.getInstance();
  }

  // ── Schedulers ────────────────────────────────────────────────────

  /** Start periodic sweeps. Non-blocking; runs in the background. */
  start(options?: {
    expiredIntervalMs?: number;
    strandedIntervalMs?: number;
    runImmediately?: boolean;
  }): void {
    const expiredMs = options?.expiredIntervalMs ?? DEFAULT_EXPIRED_INTERVAL_MS;
    const strandedMs =
      options?.strandedIntervalMs ?? DEFAULT_STRANDED_INTERVAL_MS;
    if (this.expiredTimer === null) {
      this.expiredTimer = setInterval(() => {
        void this.sweepExpired().catch((err) => this.reportErr('expired', err));
      }, expiredMs);
      if (this.expiredTimer.unref) this.expiredTimer.unref();
    }
    if (this.strandedTimer === null) {
      this.strandedTimer = setInterval(() => {
        void this.sweepStranded().catch((err) => this.reportErr('stranded', err));
      }, strandedMs);
      if (this.strandedTimer.unref) this.strandedTimer.unref();
    }
    if (options?.runImmediately) {
      void this.sweepExpired().catch((err) => this.reportErr('expired', err));
      void this.sweepStranded().catch((err) => this.reportErr('stranded', err));
    }
  }

  stop(): void {
    if (this.expiredTimer !== null) {
      clearInterval(this.expiredTimer);
      this.expiredTimer = null;
    }
    if (this.strandedTimer !== null) {
      clearInterval(this.strandedTimer);
      this.strandedTimer = null;
    }
  }

  private reportErr(kind: 'expired' | 'stranded', err: unknown): void {
    try {
      this.degradation.report({
        feature: 'CommitmentSweeper',
        primary: `${kind}-sweep`,
        fallback: 'no entries emitted this tick',
        reason: err instanceof Error ? err.message : String(err),
        impact:
          kind === 'expired'
            ? 'Commitments past deadline not flagged in this tick.'
            : 'Stranded commitments not flagged in this tick.',
      });
    } catch {
      /* best-effort */
    }
  }

  // ── Scans ─────────────────────────────────────────────────────────

  /**
   * Expired sweep. Walks recent entries, finds commitments that:
   * - have kind === 'commitment'
   * - have status === 'open'
   * - have a deadline earlier than now
   * - are NOT already superseded by an entry (resolve/cancel already ran)
   * - are NOT already expired-flagged (the supersession chain isn't
   *   carrying a note with `subject: 'expired: ...'`)
   *
   * Emits one note entry per matching commitment (bounded batchLimit).
   */
  async sweepExpired(): Promise<SweepResult> {
    const recent = await this.ledger.recent({ limit: 200 });
    const bySupersedes = new Set<string>();
    for (const e of recent) {
      if (e.supersedes) bySupersedes.add(e.supersedes);
    }
    let emitted = 0;
    let scanned = 0;
    let truncated = false;
    const nowMs = this.now();
    for (const e of recent) {
      if (e.kind !== 'commitment') continue;
      if (!e.commitment) continue;
      if (e.commitment.status !== 'open') continue;
      const deadline = e.commitment.deadline;
      if (!deadline) continue;
      const dlMs = Date.parse(deadline);
      if (Number.isNaN(dlMs) || dlMs > nowMs) continue;
      if (bySupersedes.has(e.id)) continue; // already resolved/cancelled/expired
      scanned++;
      if (emitted >= this.batchLimit) {
        truncated = true;
        break;
      }
      const ok = await this.emitNoteFor(
        e,
        `expired: deadline passed without resolution`,
        `integrated-being-v2:expired:${e.id}`,
      );
      if (ok) emitted++;
    }
    return { emitted, scanned, truncated };
  }

  /**
   * Stranded sweep. Walks recent entries, finds open commitments whose
   * creator session is no longer in the registry AND whose last activity
   * was more than strandedAgeMs ago.
   */
  async sweepStranded(): Promise<SweepResult> {
    const recent = await this.ledger.recent({ limit: 200 });
    const bySupersedes = new Set<string>();
    const byDisputes = new Set<string>();
    for (const e of recent) {
      if (e.supersedes) bySupersedes.add(e.supersedes);
      if (e.disputes) byDisputes.add(e.disputes);
    }
    let emitted = 0;
    let scanned = 0;
    let truncated = false;
    const nowMs = this.now();
    const activeSessions = new Set(
      this.registry.listSessions().map((s) => s.sessionId),
    );
    for (const e of recent) {
      if (e.kind !== 'commitment') continue;
      if (!e.commitment || e.commitment.status !== 'open') continue;
      const creatorSid = e.emittedBy?.instance;
      if (!creatorSid) continue;
      if (activeSessions.has(creatorSid)) continue;
      // Age check: commitment created > strandedAgeMs ago.
      const created = Date.parse(e.t);
      if (Number.isNaN(created) || nowMs - created < this.strandedAgeMs) continue;
      if (bySupersedes.has(e.id)) continue; // already resolved
      // Don't re-emit stranded note if one already exists.
      // We check supersession chain — stranded notes are a supersedes pointer.
      // (The supersedes check above already covers this case.)
      scanned++;
      if (emitted >= this.batchLimit) {
        truncated = true;
        break;
      }
      const ok = await this.emitNoteFor(
        e,
        `stranded: creating session no longer exists`,
        `integrated-being-v2:stranded:${e.id}`,
      );
      if (ok) emitted++;
    }
    return { emitted, scanned, truncated };
  }

  private async emitNoteFor(
    commitment: LedgerEntry,
    subject: string,
    dedupKey: string,
  ): Promise<boolean> {
    const appended = await this.ledger.append({
      emittedBy: { subsystem: 'commitment-sweeper', instance: this.instance },
      kind: 'note',
      subject,
      counterparty: {
        type: commitment.counterparty.type,
        name: commitment.counterparty.name,
        trustTier: commitment.counterparty.trustTier,
      },
      supersedes: commitment.id,
      provenance: 'subsystem-asserted',
      dedupKey,
    });
    return !!appended;
  }
}
