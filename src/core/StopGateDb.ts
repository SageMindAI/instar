/**
 * StopGateDb — SQLite persistence for the UnjustifiedStopGate.
 *
 * Spec: docs/specs/context-death-pitfall-prevention.md § (d)
 *
 * Tables (per spec § (d), lines 373-377):
 *   - sessions(session_id, agent_id, started_at)
 *   - session_continue_counts(session_id, count, updated_at)
 *   - session_stuck_state(session_id, last_ceiling_hit_at)
 *   - agent_eval_aggregate(agent_id, day_key, triggered_count,
 *     shadow_count, continue_count, ...)    — hourly rollup
 *   - annotations(event_id, operator, verdict, rationale, dwell_ms,
 *     created_at)                           — operator review tool
 *   - events(event_id, session_id, ts, mode, decision, rule,
 *     invalidKind, evidence_pointer_json, latency_ms, reason_preview)
 *     — decision log
 *
 * Storage: `~/.instar/<agent-id>/server-data/stop-gate.db` per spec §
 * P0.8 (outside project tree, chmod 600). For in-process tests we
 * support `:memory:`.
 *
 * Threat model: drift-correction, not security boundary. Session tampering
 * with the DB file is out of scope.
 */

import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// ── Types ─────────────────────────────────────────────────────────────

export type EvalMode = 'off' | 'shadow' | 'enforce';
export type Decision = 'continue' | 'allow' | 'escalate' | 'force_allow';
export type InvalidKind =
  | null
  | 'timeout'
  | 'malformed'
  | 'invalidRule'
  | 'invalidEvidence'
  | 'missingPointer'
  | 'llmUnavailable'
  | 'queue_shed_overload'
  | 'staleCompaction';

export interface EvalEvent {
  eventId: string;
  sessionId: string;
  ts: number;
  mode: EvalMode;
  decision: Decision | null; // null for fail-open failures
  rule: string | null;
  invalidKind: InvalidKind;
  evidencePointerJson: string | null;
  latencyMs: number;
  reasonPreview: string; // first ~200 chars of stop_reason
  agentId: string;
}

export interface Annotation {
  eventId: string;
  operator: string;
  verdict: 'correct' | 'incorrect' | 'unclear';
  rationale: string;
  dwellMs: number;
  createdAt: number;
}

export interface ContinueCountState {
  sessionId: string;
  count: number;
  updatedAt: number;
}

// ── Schema ────────────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sessions (
     session_id TEXT PRIMARY KEY,
     agent_id   TEXT NOT NULL,
     started_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS session_continue_counts (
     session_id TEXT PRIMARY KEY,
     count      INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS session_stuck_state (
     session_id         TEXT PRIMARY KEY,
     last_ceiling_hit_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     event_id              TEXT PRIMARY KEY,
     session_id            TEXT NOT NULL,
     agent_id              TEXT NOT NULL,
     ts                    INTEGER NOT NULL,
     mode                  TEXT NOT NULL,
     decision              TEXT,
     rule                  TEXT,
     invalid_kind          TEXT,
     evidence_pointer_json TEXT,
     latency_ms            INTEGER NOT NULL,
     reason_preview        TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_mode_outcome ON events(mode, decision, invalid_kind)`,
  `CREATE TABLE IF NOT EXISTS annotations (
     event_id   TEXT NOT NULL,
     operator   TEXT NOT NULL,
     verdict    TEXT NOT NULL CHECK(verdict IN ('correct','incorrect','unclear')),
     rationale  TEXT NOT NULL,
     dwell_ms   INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (event_id, operator, created_at)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_annotations_event ON annotations(event_id)`,
  `CREATE TABLE IF NOT EXISTS agent_eval_aggregate (
     agent_id        TEXT NOT NULL,
     day_key         TEXT NOT NULL,
     triggered_count INTEGER NOT NULL DEFAULT 0,
     shadow_count    INTEGER NOT NULL DEFAULT 0,
     continue_count  INTEGER NOT NULL DEFAULT 0,
     allow_count     INTEGER NOT NULL DEFAULT 0,
     escalate_count  INTEGER NOT NULL DEFAULT 0,
     failure_count   INTEGER NOT NULL DEFAULT 0,
     updated_at      INTEGER NOT NULL,
     PRIMARY KEY (agent_id, day_key)
   )`,
];

// ── StopGateDb class ──────────────────────────────────────────────────

export class StopGateDb {
  private db: BetterSqliteDatabase;
  private stmts!: {
    insertEvent: Database.Statement;
    insertAnnotation: Database.Statement;
    recentEvents: Database.Statement;
    eventById: Database.Statement;
    annotationsFor: Database.Statement;
    incrementContinueCount: Database.Statement;
    getContinueCount: Database.Statement;
    setStuck: Database.Statement;
    getStuck: Database.Statement;
    recordSessionStart: Database.Statement;
    getSessionStartedAt: Database.Statement;
    upsertAggregate: Database.Statement;
    aggregateFor: Database.Statement;
  };

  constructor(opts: { dbPath: string } | { db: BetterSqliteDatabase }) {
    if ('db' in opts) {
      this.db = opts.db;
    } else {
      fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
      this.db = new Database(opts.dbPath);
      try {
        fs.chmodSync(opts.dbPath, 0o600);
      } catch {
        // chmod may fail on non-POSIX FS; not critical.
      }
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    for (const ddl of SCHEMA) this.db.exec(ddl);
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stmts = {
      insertEvent: this.db.prepare(`
        INSERT OR REPLACE INTO events
          (event_id, session_id, agent_id, ts, mode, decision, rule,
           invalid_kind, evidence_pointer_json, latency_ms, reason_preview)
        VALUES
          (@eventId, @sessionId, @agentId, @ts, @mode, @decision, @rule,
           @invalidKind, @evidencePointerJson, @latencyMs, @reasonPreview)
      `),
      insertAnnotation: this.db.prepare(`
        INSERT INTO annotations
          (event_id, operator, verdict, rationale, dwell_ms, created_at)
        VALUES
          (@eventId, @operator, @verdict, @rationale, @dwellMs, @createdAt)
      `),
      recentEvents: this.db.prepare(`
        SELECT * FROM events
        ORDER BY ts DESC
        LIMIT ?
      `),
      eventById: this.db.prepare(`SELECT * FROM events WHERE event_id = ?`),
      annotationsFor: this.db.prepare(
        `SELECT * FROM annotations WHERE event_id = ? ORDER BY created_at ASC`
      ),
      incrementContinueCount: this.db.prepare(`
        INSERT INTO session_continue_counts (session_id, count, updated_at)
        VALUES (@sessionId, 1, @updatedAt)
        ON CONFLICT(session_id) DO UPDATE SET
          count = count + 1,
          updated_at = excluded.updated_at
        RETURNING count
      `),
      getContinueCount: this.db.prepare(
        `SELECT count, updated_at FROM session_continue_counts WHERE session_id = ?`
      ),
      setStuck: this.db.prepare(`
        INSERT INTO session_stuck_state (session_id, last_ceiling_hit_at)
        VALUES (@sessionId, @ts)
        ON CONFLICT(session_id) DO UPDATE SET
          last_ceiling_hit_at = excluded.last_ceiling_hit_at
      `),
      getStuck: this.db.prepare(
        `SELECT last_ceiling_hit_at FROM session_stuck_state WHERE session_id = ?`
      ),
      recordSessionStart: this.db.prepare(`
        INSERT OR IGNORE INTO sessions (session_id, agent_id, started_at)
        VALUES (@sessionId, @agentId, @startedAt)
      `),
      getSessionStartedAt: this.db.prepare(
        `SELECT started_at FROM sessions WHERE session_id = ?`
      ),
      upsertAggregate: this.db.prepare(`
        INSERT INTO agent_eval_aggregate
          (agent_id, day_key, triggered_count, shadow_count, continue_count,
           allow_count, escalate_count, failure_count, updated_at)
        VALUES
          (@agentId, @dayKey, @triggeredCount, @shadowCount, @continueCount,
           @allowCount, @escalateCount, @failureCount, @updatedAt)
        ON CONFLICT(agent_id, day_key) DO UPDATE SET
          triggered_count = triggered_count + excluded.triggered_count,
          shadow_count    = shadow_count + excluded.shadow_count,
          continue_count  = continue_count + excluded.continue_count,
          allow_count     = allow_count + excluded.allow_count,
          escalate_count  = escalate_count + excluded.escalate_count,
          failure_count   = failure_count + excluded.failure_count,
          updated_at      = excluded.updated_at
      `),
      aggregateFor: this.db.prepare(
        `SELECT * FROM agent_eval_aggregate WHERE agent_id = ? AND day_key = ?`
      ),
    };
  }

  recordEvent(event: EvalEvent): void {
    this.stmts.insertEvent.run({
      eventId: event.eventId,
      sessionId: event.sessionId,
      agentId: event.agentId,
      ts: event.ts,
      mode: event.mode,
      decision: event.decision,
      rule: event.rule,
      invalidKind: event.invalidKind,
      evidencePointerJson: event.evidencePointerJson,
      latencyMs: event.latencyMs,
      reasonPreview: event.reasonPreview,
    });
  }

  addAnnotation(ann: Annotation): void {
    this.stmts.insertAnnotation.run(ann);
  }

  recentEvents(limit = 100): EvalEvent[] {
    const rows = this.stmts.recentEvents.all(Math.max(1, Math.min(1000, limit))) as Array<Record<string, unknown>>;
    return rows.map(toEvalEvent);
  }

  eventById(eventId: string): EvalEvent | null {
    const row = this.stmts.eventById.get(eventId) as Record<string, unknown> | undefined;
    return row ? toEvalEvent(row) : null;
  }

  annotationsFor(eventId: string): Annotation[] {
    const rows = this.stmts.annotationsFor.all(eventId) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      eventId: String(r.event_id),
      operator: String(r.operator),
      verdict: r.verdict as Annotation['verdict'],
      rationale: String(r.rationale),
      dwellMs: Number(r.dwell_ms),
      createdAt: Number(r.created_at),
    }));
  }

  /** Increment the continue-count for a session. Returns the new value. */
  incrementContinueCount(sessionId: string, now = Date.now()): number {
    const row = this.stmts.incrementContinueCount.get({ sessionId, updatedAt: now }) as
      | { count: number }
      | undefined;
    return row?.count ?? 1;
  }

  getContinueCount(sessionId: string): ContinueCountState | null {
    const row = this.stmts.getContinueCount.get(sessionId) as
      | { count: number; updated_at: number }
      | undefined;
    if (!row) return null;
    return { sessionId, count: row.count, updatedAt: row.updated_at };
  }

  setStuck(sessionId: string, ts = Date.now()): void {
    this.stmts.setStuck.run({ sessionId, ts });
  }

  isStuck(sessionId: string): boolean {
    const row = this.stmts.getStuck.get(sessionId) as { last_ceiling_hit_at: number } | undefined;
    return !!row;
  }

  recordSessionStart(sessionId: string, agentId: string, startedAt = Date.now()): void {
    this.stmts.recordSessionStart.run({ sessionId, agentId, startedAt });
  }

  getSessionStartedAt(sessionId: string): number | null {
    const row = this.stmts.getSessionStartedAt.get(sessionId) as { started_at: number } | undefined;
    return row?.started_at ?? null;
  }

  rollupAggregate(opts: {
    agentId: string;
    dayKey: string;
    triggeredDelta?: number;
    shadowDelta?: number;
    continueDelta?: number;
    allowDelta?: number;
    escalateDelta?: number;
    failureDelta?: number;
  }): void {
    this.stmts.upsertAggregate.run({
      agentId: opts.agentId,
      dayKey: opts.dayKey,
      triggeredCount: opts.triggeredDelta ?? 0,
      shadowCount: opts.shadowDelta ?? 0,
      continueCount: opts.continueDelta ?? 0,
      allowCount: opts.allowDelta ?? 0,
      escalateCount: opts.escalateDelta ?? 0,
      failureCount: opts.failureDelta ?? 0,
      updatedAt: Date.now(),
    });
  }

  getAggregate(
    agentId: string,
    dayKey: string
  ): {
    triggered: number;
    shadow: number;
    continueCount: number;
    allowCount: number;
    escalateCount: number;
    failureCount: number;
  } | null {
    const row = this.stmts.aggregateFor.get(agentId, dayKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      triggered: Number(row.triggered_count),
      shadow: Number(row.shadow_count),
      continueCount: Number(row.continue_count),
      allowCount: Number(row.allow_count),
      escalateCount: Number(row.escalate_count),
      failureCount: Number(row.failure_count),
    };
  }

  close(): void {
    this.db.close();
  }
}

function toEvalEvent(row: Record<string, unknown>): EvalEvent {
  return {
    eventId: String(row.event_id),
    sessionId: String(row.session_id),
    agentId: String(row.agent_id),
    ts: Number(row.ts),
    mode: row.mode as EvalMode,
    decision: (row.decision ?? null) as Decision | null,
    rule: (row.rule ?? null) as string | null,
    invalidKind: (row.invalid_kind ?? null) as InvalidKind,
    evidencePointerJson: (row.evidence_pointer_json ?? null) as string | null,
    latencyMs: Number(row.latency_ms),
    reasonPreview: String(row.reason_preview),
  };
}

export function dayKeyFor(ts = Date.now()): string {
  // UTC YYYY-MM-DD
  return new Date(ts).toISOString().slice(0, 10);
}
