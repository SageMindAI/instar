/**
 * PendingRelayStore — SQLite-backed durable queue of telegram-reply
 * delivery attempts that the script-side detector classified as
 * recoverable.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § Layer 2a.
 *
 * Path: `<stateDir>/state/pending-relay.<agentId>.sqlite` (mode 0600).
 *
 * The agentId infix exists because instar supports two install layouts:
 *   - per-agent: `~/.instar/agents/<id>/.instar/`
 *   - per-project (shared worktrees): `<project>/.instar/`
 * Two agents that share a project `.instar/` would otherwise collide
 * on a single queue file. The infix prevents that.
 *
 * Concurrency model:
 *   - WAL journaling — sentinel UPDATEs do not block script INSERTs.
 *   - synchronous=NORMAL — durable enough; we accept that the most
 *     recent few inserts MAY be lost on a power cut, which is fine
 *     because the sender's exit-1 keeps the agent-visible failure
 *     semantics (the agent can still see its send failed).
 *   - busy_timeout=5000 — handles transient contention without raising.
 *
 * Layer 2 owns ENQUEUE and lookup primitives. The actual claim/lease
 * lifecycle (Layer 3) layers on top of `transition()` — the store does
 * not opinion-ate on what counts as a legal state transition; it just
 * persists what its caller writes.
 */

import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

// ── Types ─────────────────────────────────────────────────────────────

export type DeliveryState =
  | 'queued'
  | 'claimed'
  | 'delivered-recovered'
  | 'delivered-tone-gated'
  | 'delivered-ambiguous'
  | 'escalated'
  | 'dead-letter';

export interface PendingRelayRow {
  delivery_id: string;
  topic_id: number;
  text_hash: string;
  text: Buffer;
  format: string | null;
  http_code: number | null;
  error_body: string | null;
  attempted_port: number | null;
  attempted_at: string;
  attempts: number;
  next_attempt_at: string | null;
  state: DeliveryState;
  claimed_by: string | null;
  status_history: string;
  truncated: 0 | 1;
}

export interface EnqueueInput {
  delivery_id: string;
  topic_id: number;
  text_hash: string;
  text: Buffer | string;
  format?: string | null;
  http_code: number;
  error_body?: string | null;
  attempted_port: number;
  attempted_at?: string;
  truncated?: boolean;
}

// ── Schema ────────────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS entries (
     delivery_id    TEXT PRIMARY KEY,
     topic_id       INTEGER NOT NULL,
     text_hash      TEXT NOT NULL,
     text           BLOB NOT NULL,
     format         TEXT,
     http_code      INTEGER,
     error_body     TEXT,
     attempted_port INTEGER,
     attempted_at   TEXT NOT NULL,
     attempts       INTEGER NOT NULL DEFAULT 1,
     next_attempt_at TEXT,
     state          TEXT NOT NULL,
     claimed_by     TEXT,
     status_history TEXT NOT NULL DEFAULT '[]',
     truncated      INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_state_next ON entries(state, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS idx_text_hash_topic ON entries(text_hash, topic_id)`,
];

// Idempotent column adds — matches what the spec calls "if column missing,
// ALTER TABLE ADD COLUMN". better-sqlite3 raises on a duplicate column;
// we catch and continue.
const COLUMN_ADDS: Array<{ name: string; ddl: string }> = [
  // truncated was added in the same commit that introduced this file, but
  // the ALTER path exists so older databases (e.g. someone who hand-bootstrapped
  // an entries table from an earlier dev branch) still upgrade cleanly.
  { name: 'truncated', ddl: 'ALTER TABLE entries ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0' },
];

// ── Path resolution ───────────────────────────────────────────────────

/**
 * Resolve the SQLite path. `stateDir` is the agent's `.instar/` directory.
 * The store lives under `<stateDir>/state/`, alongside other per-agent
 * runtime files.
 */
export function resolvePendingRelayPath(stateDir: string, agentId: string): string {
  return path.join(stateDir, 'state', `pending-relay.${sanitizeAgentId(agentId)}.sqlite`);
}

export function resolvePendingRelayLockPath(stateDir: string, agentId: string): string {
  return path.join(stateDir, 'state', `pending-relay.${sanitizeAgentId(agentId)}.sqlite.lock`);
}

/**
 * Defensive — the agentId comes from config.json which is operator-controlled
 * but should not contain path separators; if it ever does, we'd land in a
 * directory traversal. Replace anything outside [A-Za-z0-9._-] with '_'.
 */
function sanitizeAgentId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

// ── Store ─────────────────────────────────────────────────────────────

export class PendingRelayStore {
  private db: BetterSqliteDatabase;
  private path: string;

  private constructor(db: BetterSqliteDatabase, dbPath: string) {
    this.db = db;
    this.path = dbPath;
  }

  static open(agentId: string, stateDir: string): PendingRelayStore {
    const dbPath = resolvePendingRelayPath(stateDir, agentId);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    let db: BetterSqliteDatabase;
    try {
      db = new Database(dbPath);
    } catch (err) {
      throw new Error(
        `pending-relay-store: failed to open ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Mode 0600 — privacy & retention §3g. Only the owning user may read
    // queued message bodies. Race-free chmod after the file already exists.
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      // best-effort; some FS layouts (Windows, certain mounts) don't honor mode bits.
    }

    // Mandatory pragmas (spec § 2a). WAL + NORMAL + 5s busy timeout.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');

    for (const ddl of SCHEMA) {
      db.exec(ddl);
    }
    // Idempotent column adds.
    for (const col of COLUMN_ADDS) {
      try {
        db.exec(col.ddl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name/i.test(msg)) {
          throw err;
        }
      }
    }

    return new PendingRelayStore(db, dbPath);
  }

  /**
   * Enqueue a recoverable delivery failure.
   *
   * Idempotent on `delivery_id` — INSERT OR IGNORE so a script that
   * accidentally re-runs with the same delivery_id (e.g. a bash retry
   * loop in a misbehaving session) doesn't duplicate the row.
   *
   * Returns true if the row was newly inserted, false if it was already
   * present (idempotent no-op).
   */
  enqueue(input: EnqueueInput): boolean {
    const text = typeof input.text === 'string' ? Buffer.from(input.text, 'utf-8') : input.text;
    const attemptedAt = input.attempted_at ?? new Date().toISOString();
    const initialHistory = JSON.stringify([
      { state: 'queued', at: attemptedAt, http_code: input.http_code },
    ]);
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO entries (
         delivery_id, topic_id, text_hash, text, format,
         http_code, error_body, attempted_port,
         attempted_at, attempts, next_attempt_at,
         state, claimed_by, status_history, truncated
       ) VALUES (
         @delivery_id, @topic_id, @text_hash, @text, @format,
         @http_code, @error_body, @attempted_port,
         @attempted_at, 1, NULL,
         'queued', NULL, @status_history, @truncated
       )`,
    );
    const result = stmt.run({
      delivery_id: input.delivery_id,
      topic_id: input.topic_id,
      text_hash: input.text_hash,
      text,
      format: input.format ?? null,
      http_code: input.http_code,
      error_body: input.error_body ?? null,
      attempted_port: input.attempted_port,
      attempted_at: attemptedAt,
      status_history: initialHistory,
      truncated: input.truncated ? 1 : 0,
    });
    return result.changes === 1;
  }

  findByDeliveryId(deliveryId: string): PendingRelayRow | null {
    const stmt = this.db.prepare('SELECT * FROM entries WHERE delivery_id = ?');
    const row = stmt.get(deliveryId) as PendingRelayRow | undefined;
    return row ?? null;
  }

  /**
   * Dedup-window query (spec § 2b step 2). Returns the most-recently
   * inserted row whose (topic_id, text_hash) matches and whose
   * attempted_at is within `windowMs` of `now`. Used by the script to
   * suppress a tight-loop flood from a misbehaving session.
   */
  findByTopicAndHashWithin(
    topicId: number,
    textHash: string,
    windowMs: number,
    now: Date = new Date(),
  ): PendingRelayRow | null {
    const cutoff = new Date(now.getTime() - windowMs).toISOString();
    const stmt = this.db.prepare(
      `SELECT * FROM entries
         WHERE topic_id = ? AND text_hash = ? AND attempted_at >= ?
         ORDER BY attempted_at DESC LIMIT 1`,
    );
    const row = stmt.get(topicId, textHash, cutoff) as PendingRelayRow | undefined;
    return row ?? null;
  }

  /**
   * Update an entry's state and any additional fields. The spec calls
   * for "atomic state transitions" — we run the UPDATE in a single
   * statement and append a status-history row in the same transaction
   * so a sentinel crash mid-transition cannot leave a row in a torn
   * state.
   *
   * Returns true if a row was actually updated, false if no row matched
   * the delivery_id (caller race or stale id).
   */
  transition(
    deliveryId: string,
    newState: DeliveryState,
    additionalFields: Partial<{
      claimed_by: string | null;
      next_attempt_at: string | null;
      attempts: number;
      http_code: number | null;
      error_body: string | null;
    }> = {},
  ): boolean {
    const tx = this.db.transaction((id: string, state: DeliveryState, extra: typeof additionalFields) => {
      const current = this.db.prepare('SELECT status_history FROM entries WHERE delivery_id = ?').get(id) as
        | { status_history: string }
        | undefined;
      if (!current) return false;
      let history: unknown[];
      try {
        const parsed = JSON.parse(current.status_history);
        history = Array.isArray(parsed) ? parsed : [];
      } catch {
        history = [];
      }
      history.push({ state, at: new Date().toISOString() });

      const fields: string[] = ['state = @state', 'status_history = @status_history'];
      const params: Record<string, unknown> = {
        delivery_id: id,
        state,
        status_history: JSON.stringify(history),
      };
      for (const [k, v] of Object.entries(extra)) {
        if (v === undefined) continue;
        fields.push(`${k} = @${k}`);
        params[k] = v;
      }
      const sql = `UPDATE entries SET ${fields.join(', ')} WHERE delivery_id = @delivery_id`;
      const result = this.db.prepare(sql).run(params);
      return result.changes === 1;
    });
    return tx(deliveryId, newState, additionalFields) as boolean;
  }

  /** Diagnostic helper used by tests. */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number };
    return row.n;
  }

  /**
   * Layer 3 sentinel selector — returns rows whose `state` is in
   * (`queued`, `claimed`) and whose `next_attempt_at` (when set) is at
   * or before `nowIso`. Sorted by `attempted_at` ascending so the
   * sentinel can drain oldest-first within per-topic rate caps.
   *
   * The query is bounded at `limit` to prevent a runaway tick scan.
   * The sentinel handles its own batching above this layer.
   */
  selectClaimable(nowIso: string, limit = 100): PendingRelayRow[] {
    const stmt = this.db.prepare(
      `SELECT * FROM entries
         WHERE state IN ('queued', 'claimed')
           AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
         ORDER BY attempted_at ASC
         LIMIT @limit`,
    );
    return stmt.all({ now: nowIso, limit }) as PendingRelayRow[];
  }

  /**
   * Layer 3 restore-purge — drops queued/claimed rows whose
   * `attempted_at` is older than `cutoffIso`. Called once at sentinel
   * startup (spec §3h). Returns the number of rows deleted so the
   * caller can emit a one-line restore log.
   */
  purgeStaleClaimable(cutoffIso: string): number {
    const stmt = this.db.prepare(
      `DELETE FROM entries
         WHERE state IN ('queued', 'claimed')
           AND attempted_at < @cutoff`,
    );
    const result = stmt.run({ cutoff: cutoffIso });
    return result.changes ?? 0;
  }

  pathOnDisk(): string {
    return this.path;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // best-effort
    }
  }
}

// ── Boot self-check ───────────────────────────────────────────────────

/**
 * Verify the SQLite runtime substrate is usable.
 *
 * Spec § 2a "Runtime dependency": the `sqlite3` CLI is not universally
 * pre-installed (Alpine, minimal Debian). On boot, probe for it; if
 * absent, raise a `sqlite3-cli-missing` degradation event. The script
 * has a `node:sqlite` / `better-sqlite3` fallback path — this is purely
 * a "tell the operator" signal, not a fatal startup failure.
 *
 * We also confirm `better-sqlite3` itself can open an in-memory DB; if
 * that fails (e.g. node-gyp build was skipped on this platform), we
 * emit a `sqlite-runtime-broken` degradation. The server keeps running
 * — Layer 2 features are gracefully degraded; everything else continues
 * to work.
 *
 * Returns `{ok: true}` when the in-process driver works (independent of
 * CLI presence), so AgentServer can decide whether to stand up the
 * /events/delivery-failed endpoint at all.
 */
export function assertSqliteAvailable(): { ok: boolean; cliPresent: boolean; reason?: string } {
  let cliPresent = false;
  try {
    execFileSync('sqlite3', ['-version'], { stdio: 'ignore' });
    cliPresent = true;
  } catch {
    cliPresent = false;
    try {
      DegradationReporter.getInstance().report({
        feature: 'sqlite3-cli-missing',
        primary: 'sqlite3 CLI for shell-side queue operations',
        fallback: 'node:sqlite / better-sqlite3 in-process driver from script fallback path',
        reason: 'sqlite3 binary not found on PATH; the relay script will use its node-based fallback.',
        impact:
          'No user-visible impact under normal operation. The script-side ' +
          'queue path is slightly slower per insert (process startup cost) ' +
          'than with the CLI. Fix: install sqlite3 (apt install sqlite3 / apk add sqlite).',
      });
    } catch {
      // DegradationReporter is best-effort; never block boot on it.
    }
  }

  // Confirm the in-process driver works at all.
  try {
    const probe = new Database(':memory:');
    probe.exec('CREATE TABLE t (x INTEGER)');
    probe.close();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    try {
      DegradationReporter.getInstance().report({
        feature: 'sqlite-runtime-broken',
        primary: 'better-sqlite3 in-process driver',
        fallback: 'pending-relay queue disabled — recoverable failures will not be enqueued',
        reason: `better-sqlite3 failed to open an in-memory DB: ${reason}`,
        impact:
          'Layer 2 (durable queue + structured failure events) is disabled. ' +
          'Existing direct-send paths continue to work. Fix: rebuild ' +
          'better-sqlite3 for this platform (npm rebuild better-sqlite3).',
      });
    } catch {
      // best-effort
    }
    return { ok: false, cliPresent, reason };
  }

  return { ok: true, cliPresent };
}
