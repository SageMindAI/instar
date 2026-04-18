/**
 * Unit tests for StopGateDb persistence (PR3 — context-death spec § (d)).
 * Uses in-memory SQLite (via better-sqlite3 ':memory:') for fast, isolated
 * tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { StopGateDb, dayKeyFor, type EvalEvent } from '../../src/core/StopGateDb.js';

function fakeEvent(overrides: Partial<EvalEvent> = {}): EvalEvent {
  return {
    eventId: 'evt-' + Math.random().toString(36).slice(2, 10),
    sessionId: 'sess-1',
    agentId: 'echo',
    ts: Date.now(),
    mode: 'shadow',
    decision: 'continue',
    rule: 'U1_DURABLE_ARTIFACT_CONTINUATION_SAFE',
    invalidKind: null,
    evidencePointerJson: JSON.stringify({ plan_file: 'docs/plan.md' }),
    latencyMs: 320,
    reasonPreview: 'optimizing for context-death safety',
    ...overrides,
  };
}

describe('StopGateDb — schema + persistence', () => {
  let db: StopGateDb;

  beforeEach(() => {
    db = new StopGateDb({ db: new Database(':memory:') });
  });

  afterEach(() => {
    db.close();
  });

  it('records and reads back a single event', () => {
    const ev = fakeEvent();
    db.recordEvent(ev);
    const got = db.eventById(ev.eventId);
    expect(got).not.toBeNull();
    expect(got?.decision).toBe('continue');
    expect(got?.rule).toBe('U1_DURABLE_ARTIFACT_CONTINUATION_SAFE');
    expect(got?.reasonPreview).toBe(ev.reasonPreview);
  });

  it('returns recent events in ts-desc order respecting limit', () => {
    for (let i = 0; i < 5; i++) {
      db.recordEvent(fakeEvent({ ts: 1_000 + i * 10 }));
    }
    const recent = db.recentEvents(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].ts).toBeGreaterThan(recent[1].ts);
    expect(recent[1].ts).toBeGreaterThan(recent[2].ts);
  });

  it('stores fail-open records with invalidKind set and decision null', () => {
    const ev = fakeEvent({
      decision: null,
      rule: null,
      invalidKind: 'timeout',
      evidencePointerJson: null,
    });
    db.recordEvent(ev);
    const got = db.eventById(ev.eventId);
    expect(got?.decision).toBeNull();
    expect(got?.rule).toBeNull();
    expect(got?.invalidKind).toBe('timeout');
  });

  it('increments session continue counts atomically', () => {
    expect(db.incrementContinueCount('sess-1')).toBe(1);
    expect(db.incrementContinueCount('sess-1')).toBe(2);
    expect(db.incrementContinueCount('sess-1')).toBe(3);
    expect(db.getContinueCount('sess-1')?.count).toBe(3);
  });

  it('tracks stuck-state flag', () => {
    expect(db.isStuck('sess-x')).toBe(false);
    db.setStuck('sess-x');
    expect(db.isStuck('sess-x')).toBe(true);
  });

  it('records session start times idempotently (first wins)', () => {
    db.recordSessionStart('sess-1', 'echo', 1_700_000_000_000);
    db.recordSessionStart('sess-1', 'echo', 1_800_000_000_000);
    expect(db.getSessionStartedAt('sess-1')).toBe(1_700_000_000_000);
  });

  it('rolls up daily aggregate counts', () => {
    db.rollupAggregate({
      agentId: 'echo',
      dayKey: '2026-04-18',
      triggeredDelta: 3,
      shadowDelta: 3,
      continueDelta: 1,
      allowDelta: 1,
      escalateDelta: 1,
    });
    db.rollupAggregate({
      agentId: 'echo',
      dayKey: '2026-04-18',
      triggeredDelta: 2,
      shadowDelta: 2,
      allowDelta: 2,
      failureDelta: 1,
    });
    const agg = db.getAggregate('echo', '2026-04-18');
    expect(agg).not.toBeNull();
    expect(agg?.triggered).toBe(5);
    expect(agg?.shadow).toBe(5);
    expect(agg?.continueCount).toBe(1);
    expect(agg?.allowCount).toBe(3);
    expect(agg?.escalateCount).toBe(1);
    expect(agg?.failureCount).toBe(1);
  });
});

describe('StopGateDb — annotations', () => {
  let db: StopGateDb;

  beforeEach(() => {
    db = new StopGateDb({ db: new Database(':memory:') });
  });

  afterEach(() => {
    db.close();
  });

  it('records and reads back annotations for an event', () => {
    const ev = fakeEvent();
    db.recordEvent(ev);
    db.addAnnotation({
      eventId: ev.eventId,
      operator: 'justin',
      verdict: 'correct',
      rationale: 'plan file durable, continue is right',
      dwellMs: 32_000,
      createdAt: Date.now(),
    });
    const anns = db.annotationsFor(ev.eventId);
    expect(anns).toHaveLength(1);
    expect(anns[0].verdict).toBe('correct');
    expect(anns[0].dwellMs).toBe(32_000);
  });

  it('returns annotations in created_at ascending order', () => {
    const ev = fakeEvent();
    db.recordEvent(ev);
    const now = Date.now();
    db.addAnnotation({ eventId: ev.eventId, operator: 'a', verdict: 'correct', rationale: '', dwellMs: 20000, createdAt: now });
    db.addAnnotation({ eventId: ev.eventId, operator: 'b', verdict: 'incorrect', rationale: '', dwellMs: 18000, createdAt: now + 1_000 });
    db.addAnnotation({ eventId: ev.eventId, operator: 'a', verdict: 'unclear', rationale: '', dwellMs: 15000, createdAt: now + 2_000 });
    const anns = db.annotationsFor(ev.eventId);
    expect(anns.map(a => a.verdict)).toEqual(['correct', 'incorrect', 'unclear']);
  });

  it('rejects invalid verdicts at the SQL CHECK constraint layer', () => {
    const ev = fakeEvent();
    db.recordEvent(ev);
    expect(() =>
      db.addAnnotation({
        eventId: ev.eventId,
        operator: 'a',
        // @ts-expect-error — testing runtime CHECK constraint
        verdict: 'unsure',
        rationale: '',
        dwellMs: 20000,
        createdAt: Date.now(),
      })
    ).toThrow();
  });
});

describe('dayKeyFor', () => {
  it('returns UTC YYYY-MM-DD', () => {
    const k = dayKeyFor(Date.UTC(2026, 3, 18, 23, 59, 0));
    expect(k).toBe('2026-04-18');
  });

  it('handles day-rollover at UTC midnight', () => {
    expect(dayKeyFor(Date.UTC(2026, 3, 18, 0, 0, 0))).toBe('2026-04-18');
    expect(dayKeyFor(Date.UTC(2026, 3, 17, 23, 59, 59, 999))).toBe('2026-04-17');
  });
});
