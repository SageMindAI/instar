/**
 * Unit tests for the Layer 3 recovery-policy evaluator.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § 3c, § 3d step 5.
 *
 * The evaluator is pure — given an HTTP code + attempts + elapsed time,
 * it returns retry / escalate / finalize. We exhaustively cover the
 * decision table here.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluatePolicy,
  reasonToCategory,
  BACKOFF_SCHEDULE_MS,
  TTL_MS,
  MAX_ATTEMPTS,
} from '../../src/monitoring/delivery-failure-sentinel/recovery-policy.js';

const FROZEN_NOW = 1_750_000_000_000;
const now = () => FROZEN_NOW;

describe('evaluatePolicy — success / non-recoverable', () => {
  it('200 → finalize-success', () => {
    const d = evaluatePolicy({ httpCode: 200, attempts: 1, timeSinceFirstMs: 1000, now });
    expect(d.action).toBe('finalize-success');
    expect(d.reason).toBe('http_200');
    expect(d.attemptOrdinal).toBe(1);
  });
  it('204 → finalize-success', () => {
    const d = evaluatePolicy({ httpCode: 204, attempts: 1, timeSinceFirstMs: 0, now });
    expect(d.action).toBe('finalize-success');
  });
  it('408 → finalize-ambiguous (no retry)', () => {
    const d = evaluatePolicy({ httpCode: 408, attempts: 1, timeSinceFirstMs: 0, now });
    expect(d.action).toBe('finalize-ambiguous');
    expect(d.reason).toBe('http_408_ambiguous');
  });
  it('422 → finalize-tone-gated', () => {
    const d = evaluatePolicy({ httpCode: 422, attempts: 1, timeSinceFirstMs: 0, now });
    expect(d.action).toBe('finalize-tone-gated');
  });
  it('400 → escalate', () => {
    const d = evaluatePolicy({ httpCode: 400, attempts: 1, timeSinceFirstMs: 0, now });
    expect(d.action).toBe('escalate');
  });
  it('401 → escalate', () => {
    expect(evaluatePolicy({ httpCode: 401, attempts: 1, timeSinceFirstMs: 0, now }).action).toBe('escalate');
  });
  it('404 → escalate', () => {
    expect(evaluatePolicy({ httpCode: 404, attempts: 1, timeSinceFirstMs: 0, now }).action).toBe('escalate');
  });
});

describe('evaluatePolicy — 403 branching', () => {
  it('403 / agent_id_mismatch → retry on first attempt', () => {
    const d = evaluatePolicy({
      httpCode: 403,
      responseBody: JSON.stringify({ error: 'agent_id_mismatch' }),
      attempts: 1,
      timeSinceFirstMs: 0,
      now,
    });
    expect(d.action).toBe('retry');
    expect(d.nextAttemptAt).toBeDefined();
    expect(new Date(d.nextAttemptAt!).getTime()).toBe(FROZEN_NOW + BACKOFF_SCHEDULE_MS[0]);
  });
  it('403 / rate_limited honors Retry-After', () => {
    const d = evaluatePolicy({
      httpCode: 403,
      responseBody: JSON.stringify({ error: 'rate_limited' }),
      attempts: 3,
      timeSinceFirstMs: 60_000,
      retryAfterSec: 17,
      now,
    });
    expect(d.action).toBe('retry');
    expect(new Date(d.nextAttemptAt!).getTime()).toBe(FROZEN_NOW + 17_000);
    expect(d.attemptOrdinal).toBe(3);
    expect(d.reason).toMatch(/rate_limited/);
  });
  it('403 / revoked → escalate', () => {
    const d = evaluatePolicy({
      httpCode: 403,
      responseBody: JSON.stringify({ error: 'revoked' }),
      attempts: 1,
      timeSinceFirstMs: 0,
      now,
    });
    expect(d.action).toBe('escalate');
  });
  it('403 unstructured → escalate (default-deny)', () => {
    const d = evaluatePolicy({
      httpCode: 403,
      responseBody: 'forbidden',
      attempts: 1,
      timeSinceFirstMs: 0,
      now,
    });
    expect(d.action).toBe('escalate');
    expect(d.reason).toBe('http_403_unstructured');
  });
});

describe('evaluatePolicy — 5xx and conn-refused', () => {
  it('500 → retry with backoff[0]', () => {
    const d = evaluatePolicy({ httpCode: 500, attempts: 1, timeSinceFirstMs: 0, now });
    expect(d.action).toBe('retry');
    expect(new Date(d.nextAttemptAt!).getTime()).toBe(FROZEN_NOW + BACKOFF_SCHEDULE_MS[0]);
  });
  it('502 / 503 / 504 all retry', () => {
    for (const code of [502, 503, 504]) {
      expect(evaluatePolicy({ httpCode: code, attempts: 1, timeSinceFirstMs: 0, now }).action).toBe('retry');
    }
  });
  it('0 (conn refused) → retry', () => {
    expect(evaluatePolicy({ httpCode: 0, attempts: 1, timeSinceFirstMs: 0, now }).action).toBe('retry');
  });
});

describe('evaluatePolicy — backoff schedule (§3c)', () => {
  // BACKOFF_SCHEDULE_MS has 9 entries; attempts 1..8 retry with the
  // corresponding schedule slot. Attempt 9 (i.e. the result of the 9th
  // recovery attempt) hits MAX_ATTEMPTS and escalates instead.
  it.each(BACKOFF_SCHEDULE_MS.slice(0, MAX_ATTEMPTS - 1).map((ms, i) => [i + 1, ms]))(
    'attempt %i → wait %i ms',
    (attempts, expectedMs) => {
      const d = evaluatePolicy({
        httpCode: 503,
        attempts: attempts as number,
        timeSinceFirstMs: 0,
        now,
      });
      expect(d.action).toBe('retry');
      expect(new Date(d.nextAttemptAt!).getTime()).toBe(FROZEN_NOW + (expectedMs as number));
    },
  );
  it('attempt at MAX_ATTEMPTS → escalate (budget exhausted)', () => {
    const d = evaluatePolicy({ httpCode: 503, attempts: MAX_ATTEMPTS, timeSinceFirstMs: 0, now });
    expect(d.action).toBe('escalate');
    expect(d.reason).toMatch(/attempts_exhausted/);
  });
  it('attempts > MAX → escalate', () => {
    const d = evaluatePolicy({
      httpCode: 503,
      attempts: MAX_ATTEMPTS + 1,
      timeSinceFirstMs: 0,
      now,
    });
    expect(d.action).toBe('escalate');
    expect(d.reason).toMatch(/attempts_exhausted/);
  });
  it('TTL exhausted → escalate even on early attempts', () => {
    const d = evaluatePolicy({
      httpCode: 503,
      attempts: 2,
      timeSinceFirstMs: TTL_MS + 1,
      now,
    });
    expect(d.action).toBe('escalate');
    expect(d.reason).toMatch(/ttl_exhausted/);
  });
  it('next-attempt is capped to remaining TTL', () => {
    // 1 minute of TTL remaining; backoff would normally be 2h on attempt 8.
    const remaining = 60_000;
    const d = evaluatePolicy({
      httpCode: 503,
      attempts: 8,
      timeSinceFirstMs: TTL_MS - remaining,
      now,
    });
    expect(d.action).toBe('retry');
    const wait = new Date(d.nextAttemptAt!).getTime() - FROZEN_NOW;
    expect(wait).toBeLessThanOrEqual(remaining);
  });
});

describe('reasonToCategory — enumerated mapping', () => {
  it('transport_503 → transport_5xx', () => {
    expect(reasonToCategory('transport_503_retry_30000ms')).toBe('transport_5xx');
  });
  it('transport_network → transport_conn_refused', () => {
    expect(reasonToCategory('transport_network_retry_30000ms')).toBe('transport_conn_refused');
  });
  it('agent_id_mismatch → agent_id_mismatch', () => {
    expect(reasonToCategory('agent_id_mismatch_retry_30000ms')).toBe('agent_id_mismatch');
  });
  it('http_403_unstructured → unstructured_403', () => {
    expect(reasonToCategory('http_403_unstructured')).toBe('unstructured_403');
  });
  it('http_422_tone_gate → tone_gate_blocked', () => {
    expect(reasonToCategory('http_422_tone_gate')).toBe('tone_gate_blocked');
  });
  it('unknown reason → unstructured_403 (default)', () => {
    expect(reasonToCategory('mystery_reason')).toBe('unstructured_403');
  });
});
