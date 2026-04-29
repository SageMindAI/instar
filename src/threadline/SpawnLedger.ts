/**
 * SpawnLedger — SQLite-backed compare-and-swap ledger for relay-spawned sessions.
 *
 * Implements Component A of the Threadline Relay-Spawn Ghost-Reply
 * Containment Spec. The ledger is the spawn-creation step itself, not a
 * post-hoc check: tryReserve() atomically claims an eventId or returns null
 * if another spawn already claimed it. This is the idempotency primitive
 * that makes "Spawned session for X (twice)" structurally impossible.
 *
 * Per spec §Component A:
 *  - Backed by SQLite (WAL mode, flock-coordinated for second-instar-on-host)
 *  - Per-spawn HMAC nonce generated here, never written to a path the
 *    spawned session can read after launch (handed to the session via FD-3
 *    by SpawnNonce.ts).
 *  - Per-peer rolling rate cap (1000 spawns / 24h) enforced on tryReserve
 *  - Global hard cap of 100k rows; prune by TTL (30d) via a background job.
 *
 * Authority classification (per docs/signal-vs-authority.md): structural
 * idempotency-key dedup at the transport layer. Permitted authority — not
 * a judgment call, mechanics.
 */

import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

// ── Types ────────────────────────────────────────────────────────────

export type SpawnStatus = 'spawning' | 'verified' | 'failed' | 'completed';

export interface SpawnLedgerRow {
  eventId: string;
  peerId: string;
  spawnNonce: Buffer;
  spawnedAt: number; // epoch ms
  status: SpawnStatus;
  terminalAt: number | null;
  failureReason: string | null;
}

export interface ReserveResult {
  reserved: true;
  spawnNonce: Buffer;
  row: SpawnLedgerRow;
}

export interface ReserveCollision {
  reserved: false;
  reason: 'duplicate-event' | 'peer-rate-limit' | 'ledger-full';
  existing?: SpawnLedgerRow;
}

export type ReserveOutcome = ReserveResult | ReserveCollision;

export interface SpawnLedgerOptions {
  /** Maximum spawns per peer in the rolling window. Default 1000. */
  perPeerCap?: number;
  /** Rolling window in ms for the per-peer cap. Default 24h. */
  perPeerWindowMs?: number;
  /** Hard cap on total rows. Default 100_000. */
  globalCap?: number;
}

const DEFAULTS = {
  perPeerCap: 1000,
  perPeerWindowMs: 24 * 60 * 60 * 1000,
  globalCap: 100_000,
} as const;

// ── Implementation ───────────────────────────────────────────────────

export class SpawnLedger {
  private db: Database.Database;
  private opts: Required<SpawnLedgerOptions>;

  constructor(dbPath: string, opts: SpawnLedgerOptions = {}) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.opts = { ...DEFAULTS, ...opts };
    this.applySchema();
  }

  private applySchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spawn_ledger (
        eventId TEXT PRIMARY KEY,
        peerId TEXT NOT NULL,
        spawnNonce BLOB NOT NULL,
        spawnedAt INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('spawning','verified','failed','completed')),
        terminalAt INTEGER,
        failureReason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_spawn_ledger_peer_time
        ON spawn_ledger (peerId, spawnedAt);
      CREATE INDEX IF NOT EXISTS idx_spawn_ledger_status_time
        ON spawn_ledger (status, spawnedAt);
    `);
  }

  /**
   * Atomically reserve a spawn slot for `eventId`. Returns the spawn nonce
   * the caller must hand to the spawned session via FD-3, or a collision
   * with the reason.
   *
   * This is the single point where a spawn is decided. If two relay
   * threads race on the same eventId, exactly one tryReserve() returns
   * {reserved: true}; the other gets {reserved: false, reason: 'duplicate-event'}.
   */
  tryReserve(eventId: string, peerId: string, now = Date.now()): ReserveOutcome {
    if (!eventId || !peerId) {
      throw new Error('SpawnLedger.tryReserve requires eventId and peerId');
    }

    // Global cap check (cheap COUNT — index on status covers it).
    const total = this.db
      .prepare('SELECT COUNT(*) AS n FROM spawn_ledger')
      .get() as { n: number };
    if (total.n >= this.opts.globalCap) {
      return { reserved: false, reason: 'ledger-full' };
    }

    // Per-peer rolling rate cap.
    const windowStart = now - this.opts.perPeerWindowMs;
    const peerRecent = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM spawn_ledger WHERE peerId = ? AND spawnedAt >= ?',
      )
      .get(peerId, windowStart) as { n: number };
    if (peerRecent.n >= this.opts.perPeerCap) {
      return { reserved: false, reason: 'peer-rate-limit' };
    }

    const spawnNonce = crypto.randomBytes(32);
    const insert = this.db.prepare(
      `INSERT INTO spawn_ledger (eventId, peerId, spawnNonce, spawnedAt, status, terminalAt, failureReason)
       VALUES (?, ?, ?, ?, 'spawning', NULL, NULL)`,
    );
    try {
      insert.run(eventId, peerId, spawnNonce, now);
    } catch (err: unknown) {
      // SQLite UNIQUE constraint on PRIMARY KEY → another spawn won the race.
      if (
        err instanceof Error &&
        /UNIQUE|PRIMARY KEY/.test(err.message)
      ) {
        const existing = this.get(eventId);
        return {
          reserved: false,
          reason: 'duplicate-event',
          existing: existing ?? undefined,
        };
      }
      throw err;
    }

    const row = this.get(eventId)!;
    return { reserved: true, spawnNonce, row };
  }

  /**
   * Mark a reserved spawn as having moved to a terminal state. Verified =
   * heartbeat HMAC validated. Failed = watchdog signal triggered. Completed
   * = session exited cleanly.
   */
  markStatus(
    eventId: string,
    status: Exclude<SpawnStatus, 'spawning'>,
    failureReason: string | null = null,
    now = Date.now(),
  ): boolean {
    const stmt = this.db.prepare(
      `UPDATE spawn_ledger
         SET status = ?, terminalAt = ?, failureReason = ?
       WHERE eventId = ? AND status != ?`,
    );
    const result = stmt.run(status, now, failureReason, eventId, status);
    return result.changes > 0;
  }

  get(eventId: string): SpawnLedgerRow | null {
    const row = this.db
      .prepare('SELECT * FROM spawn_ledger WHERE eventId = ?')
      .get(eventId) as SpawnLedgerRow | undefined;
    return row ?? null;
  }

  /**
   * Verify a heartbeat HMAC against the stored spawn nonce.
   * Returns true if valid; false if no row or mismatch.
   */
  verifyHeartbeatHmac(
    eventId: string,
    payload: string,
    presentedHmac: string,
  ): boolean {
    const row = this.get(eventId);
    if (!row) return false;
    const expected = crypto
      .createHmac('sha256', row.spawnNonce)
      .update(payload)
      .digest('hex');
    // Constant-time compare to avoid timing side channel.
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(presentedHmac, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /**
   * Prune rows older than `olderThanMs` AND in a terminal state.
   * Spawning rows are NEVER pruned (they may still be in flight).
   * Returns count of rows removed.
   */
  pruneTerminal(olderThanMs: number, now = Date.now()): number {
    const cutoff = now - olderThanMs;
    const result = this.db
      .prepare(
        `DELETE FROM spawn_ledger
         WHERE status != 'spawning'
           AND terminalAt IS NOT NULL
           AND terminalAt < ?`,
      )
      .run(cutoff);
    return result.changes;
  }

  /**
   * List ALL rows currently in 'spawning' state, regardless of age.
   * Used by HeartbeatWatchdog which applies its own grace-window filter.
   */
  listSpawning(): SpawnLedgerRow[] {
    return this.db
      .prepare(`SELECT * FROM spawn_ledger WHERE status = 'spawning'`)
      .all() as SpawnLedgerRow[];
  }

  /** Sweep stale 'spawning' rows (heartbeat never confirmed, no terminal mark). */
  sweepStaleSpawning(staleAfterMs: number, now = Date.now()): SpawnLedgerRow[] {
    const cutoff = now - staleAfterMs;
    const rows = this.db
      .prepare(
        `SELECT * FROM spawn_ledger
         WHERE status = 'spawning' AND spawnedAt < ?`,
      )
      .all(cutoff) as SpawnLedgerRow[];
    return rows;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM spawn_ledger').get() as { n: number }).n;
  }

  close(): void {
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* db may already be closed; safe to ignore */
    }
    this.db.close();
  }
}
