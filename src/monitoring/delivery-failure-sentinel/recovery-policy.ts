/**
 * recovery-policy — pure deterministic policy evaluator for the Layer 3
 * DeliveryFailureSentinel.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § 3c, § 3d.
 *
 * Given the result of a recovery attempt — `(http_code, response_body,
 * attempts, time_since_first_ms)` — the evaluator returns the next
 * action: retry (with `nextAttemptAt`), escalate, or finalize.
 *
 * This file is intentionally **pure**: no I/O, no logger, no clock —
 * `now` is passed in. Every branch is reachable from a unit test table,
 * and the §3c backoff schedule is the only stateful concept (it's a
 * static lookup keyed on attempt number).
 *
 * Why a separate file: the spec calls out signal-vs-authority compliance
 * — the sentinel's "judgment" is enumerable and deterministic. Putting
 * the policy in its own pure module makes that property obvious and
 * exhaustively testable. The sentinel class wraps the policy with the
 * messy stuff (locks, leases, network).
 */

// ── Types ────────────────────────────────────────────────────────────

export type RecoveryAction =
  | 'retry'
  | 'escalate'
  | 'finalize-success'
  | 'finalize-tone-gated'
  | 'finalize-ambiguous';

export interface PolicyDecision {
  action: RecoveryAction;
  /** ISO8601 timestamp; only set when action === 'retry'. */
  nextAttemptAt?: string;
  /** Always set — populates structured logs. */
  reason: string;
  /** Convenience for tests / telemetry. */
  attemptOrdinal?: number;
}

export interface PolicyInput {
  /** HTTP status code from the recovery POST. 0 indicates connection refused. */
  httpCode: number;
  /** Response body (sanitized error_body or 422 body shape, capped 1KB). */
  responseBody?: string | null;
  /** Number of recovery attempts so far INCLUDING the one that produced httpCode. */
  attempts: number;
  /** Milliseconds elapsed since the original `attempted_at` from Layer 2 enqueue. */
  timeSinceFirstMs: number;
  /** `Retry-After` header value, in seconds. Only honored on 403/rate_limited. */
  retryAfterSec?: number | null;
  /** Inject for tests; defaults to Date.now. */
  now?: () => number;
}

// ── Backoff schedule (spec § 3c) ─────────────────────────────────────

/** 9 steps; capped at 24h TTL from `attempted_at`. */
export const BACKOFF_SCHEDULE_MS: ReadonlyArray<number> = [
  30_000,        // 30s   (after attempt 1)
  60_000,        // 1m    (after attempt 2)
  2 * 60_000,    // 2m
  5 * 60_000,    // 5m
  15 * 60_000,   // 15m
  30 * 60_000,   // 30m
  60 * 60_000,   // 1h
  2 * 60 * 60_000, // 2h
  4 * 60 * 60_000, // 4h
];

export const TTL_MS = 24 * 60 * 60_000;

export const MAX_ATTEMPTS = BACKOFF_SCHEDULE_MS.length;

// ── HTTP-code classification helpers ─────────────────────────────────

/**
 * Recoverable transport — sentinel should retry per §3c.
 * 5xx and 0 (conn-refused / DNS) are always recoverable.
 */
function isRecoverableTransport(httpCode: number): boolean {
  if (httpCode === 0) return true; // conn refused / DNS / network error
  if (httpCode >= 500 && httpCode < 600) return true;
  return false;
}

/**
 * Parse a 403 body for the structured error code. Returns the error
 * string when present, null otherwise.
 *
 * Layer 1c contract: `agent_id_mismatch` is structured. Other 403s may
 * be `revoked` (terminal) or unstructured (default-deny: don't retry,
 * since we don't know what failed).
 */
function parse403(body: string | null | undefined): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // not JSON
  }
  return null;
}

// ── Public evaluator ─────────────────────────────────────────────────

/**
 * Evaluate the next action for a recovery attempt.
 *
 * Decision table (spec § 4 Layer 2b + § 3c + § 3d step 5):
 *
 *   200 / 2xx                     → finalize-success
 *   408                           → finalize-ambiguous (no retry)
 *   422                           → finalize-tone-gated (re-gate path
 *                                    in §3d step 3 already triggered)
 *   400 / 401 / 404               → escalate (terminal client error)
 *   403 / agent_id_mismatch       → retry (operator may have rotated
 *                                    config; respects §3c backoff)
 *   403 / rate_limited            → retry honoring Retry-After,
 *                                    does NOT consume the regular budget
 *   403 / revoked                 → escalate (terminal)
 *   403 unstructured              → escalate (default-deny — we don't
 *                                    know what failed, don't retry blind)
 *   5xx / 0 (conn-refused)        → retry per §3c
 *
 * Across all retries: if `attempts` reaches MAX_ATTEMPTS (9) OR
 * `timeSinceFirstMs` exceeds TTL_MS (24h), action is `escalate` even
 * if the underlying code would normally retry.
 */
export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const now = input.now ?? (() => Date.now());

  // Success — record and finalize.
  if (input.httpCode >= 200 && input.httpCode < 300) {
    return {
      action: 'finalize-success',
      reason: `http_${input.httpCode}`,
      attemptOrdinal: input.attempts,
    };
  }

  // Tone gate — re-gate path triggered the 422; finalize as tone-gated.
  if (input.httpCode === 422) {
    return {
      action: 'finalize-tone-gated',
      reason: 'http_422_tone_gate',
      attemptOrdinal: input.attempts,
    };
  }

  // 408 ambiguous — script semantics: no retry, finalize as ambiguous.
  if (input.httpCode === 408) {
    return {
      action: 'finalize-ambiguous',
      reason: 'http_408_ambiguous',
      attemptOrdinal: input.attempts,
    };
  }

  // 403 — branch on structured error.
  if (input.httpCode === 403) {
    const code = parse403(input.responseBody ?? null);
    if (code === 'rate_limited' && input.retryAfterSec && input.retryAfterSec > 0) {
      // Honor Retry-After; does NOT consume the regular budget — we
      // emit the same attempt ordinal so the next call uses the same
      // schedule slot.
      const nextAt = new Date(now() + input.retryAfterSec * 1000).toISOString();
      return {
        action: 'retry',
        nextAttemptAt: nextAt,
        reason: `http_403_rate_limited_retry_after_${input.retryAfterSec}s`,
        attemptOrdinal: input.attempts,
      };
    }
    if (code === 'agent_id_mismatch') {
      return scheduleRetryOrEscalate(input, now, 'agent_id_mismatch');
    }
    // revoked / unstructured / anything else — escalate (default-deny).
    return {
      action: 'escalate',
      reason: code ? `http_403_${code}` : 'http_403_unstructured',
      attemptOrdinal: input.attempts,
    };
  }

  // Other 4xx — terminal client errors. Sentinel cannot fix these.
  if (input.httpCode >= 400 && input.httpCode < 500) {
    return {
      action: 'escalate',
      reason: `http_${input.httpCode}`,
      attemptOrdinal: input.attempts,
    };
  }

  // 5xx / 0 — recoverable transport.
  if (isRecoverableTransport(input.httpCode)) {
    return scheduleRetryOrEscalate(
      input,
      now,
      input.httpCode === 0 ? 'transport_network' : `transport_${input.httpCode}`,
    );
  }

  // Anything else (1xx, 3xx, weird codes) — escalate, surfacing the code.
  return {
    action: 'escalate',
    reason: `http_${input.httpCode}_unknown`,
    attemptOrdinal: input.attempts,
  };
}

function scheduleRetryOrEscalate(
  input: PolicyInput,
  now: () => number,
  reasonPrefix: string,
): PolicyDecision {
  // TTL exhausted?
  if (input.timeSinceFirstMs >= TTL_MS) {
    return {
      action: 'escalate',
      reason: `${reasonPrefix}_ttl_exhausted`,
      attemptOrdinal: input.attempts,
    };
  }
  // Attempts exhausted?
  if (input.attempts >= MAX_ATTEMPTS) {
    return {
      action: 'escalate',
      reason: `${reasonPrefix}_attempts_exhausted`,
      attemptOrdinal: input.attempts,
    };
  }
  // The schedule index is `attempts - 1` so attempt 1 → 30s wait,
  // attempt 2 → 60s wait, ..., attempt 9 → 4h wait. After attempt 9
  // returns, the NEXT decision goes to "exhausted" above.
  const waitMs = BACKOFF_SCHEDULE_MS[Math.min(input.attempts - 1, MAX_ATTEMPTS - 1)];
  // But cap nextAttemptAt to within the TTL — we don't schedule beyond
  // the wall-clock budget.
  const remainingTtlMs = TTL_MS - input.timeSinceFirstMs;
  const effectiveWait = Math.min(waitMs, remainingTtlMs);
  const nextAt = new Date(now() + effectiveWait).toISOString();
  return {
    action: 'retry',
    nextAttemptAt: nextAt,
    reason: `${reasonPrefix}_retry_${effectiveWait}ms`,
    attemptOrdinal: input.attempts,
  };
}

/**
 * Map a recovery reason / final state into the enumerated escalation
 * category surfaced in the user-visible escalation template (§3f).
 *
 * The set of categories MUST match `EscalationCategory` in
 * `src/messaging/system-templates.ts`; mismatch would mean rendering
 * an unrecognized `{category}` value.
 */
export function reasonToCategory(reason: string):
  | 'transport_5xx'
  | 'transport_conn_refused'
  | 'transport_dns'
  | 'agent_id_mismatch'
  | 'unstructured_403'
  | 'tone_gate_blocked' {
  if (reason.startsWith('transport_5')) return 'transport_5xx';
  if (reason.startsWith('transport_network')) return 'transport_conn_refused';
  if (reason.startsWith('agent_id_mismatch')) return 'agent_id_mismatch';
  if (reason.startsWith('http_403_unstructured') || reason === 'http_403_revoked') return 'unstructured_403';
  if (reason.startsWith('http_422')) return 'tone_gate_blocked';
  return 'unstructured_403';
}
