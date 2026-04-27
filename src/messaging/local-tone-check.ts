/**
 * local-tone-check — in-process wrapper around the existing tone gate
 * authority, used by the Layer 3 DeliveryFailureSentinel during
 * recovery (spec § 3d step 3).
 *
 * Why a wrapper, not a direct call:
 *   - The sentinel runs in the same process as the tone gate. Going
 *     through `POST /messaging/tone-check` would require a localhost
 *     HTTP roundtrip + auth header. Calling the gate's `review()` method
 *     directly skips that entire stack.
 *   - The wrapper keeps the call site narrow: callers don't need to
 *     know about IntelligenceProvider, prompt construction, or the
 *     `ToneReviewSignals` shape. They get a boolean-shaped result and a
 *     reason string for telemetry.
 *   - When the tone gate is unconfigured (no IntelligenceProvider), the
 *     wrapper returns `{passed: true, reason: 'no-tone-gate-authority'}`
 *     — same fail-open behavior as the inline route check.
 */

import type { MessagingToneGate, ToneReviewResult } from '../core/MessagingToneGate.js';

export interface LocalToneCheckResult {
  /** True when the message is safe to send. */
  passed: boolean;
  /** When passed=false, the cited rule id (B1..B11). */
  rule?: string;
  /** Tone gate's diagnostic — surfaced in telemetry, not user-visible. */
  issue?: string;
  /** Proposed alternative — surfaced in telemetry only. */
  suggestion?: string;
  /** Latency of the gate call. */
  latencyMs: number;
  /** True when the gate failed open (provider unavailable, timeout, etc.). */
  failedOpen?: boolean;
  /** Reason / diagnostic the sentinel records in the queue's status_history. */
  reason: string;
}

export interface LocalToneCheckOptions {
  /** Channel — typically 'telegram' for the sentinel's path. */
  channel: string;
  /** Optional recent-message context. */
  recentMessages?: Array<{ role: 'user' | 'agent'; text: string }>;
  /** Style target (passes through to the gate's B11 rule). */
  targetStyle?: string;
}

/**
 * Run the tone gate against a queued message body.
 *
 * - When `gate` is null (no IntelligenceProvider configured), passes
 *   through with `passed=true, reason='no-tone-gate-authority'`. This
 *   matches the inline route's fail-open behavior.
 * - When the gate raises (provider transient failure), returns
 *   `passed=true, failedOpen=true, reason='gate-error'`. The sentinel
 *   logs but proceeds — never block message delivery on a flaky gate.
 * - When the gate cleanly returns `pass=false`, returns `passed=false`
 *   with the cited rule. The sentinel finalizes as `delivered-tone-gated`
 *   and emits the meta-notice template.
 */
export async function checkToneLocally(
  gate: MessagingToneGate | null,
  text: string,
  options: LocalToneCheckOptions,
): Promise<LocalToneCheckResult> {
  if (!gate) {
    return {
      passed: true,
      latencyMs: 0,
      reason: 'no-tone-gate-authority',
    };
  }

  let result: ToneReviewResult;
  const start = Date.now();
  try {
    result = await gate.review(text, {
      channel: options.channel,
      recentMessages: options.recentMessages,
      targetStyle: options.targetStyle,
      // Sentinel-side calls do not pass detector signals; the queued
      // text has already been published once, so junk/duplicate signals
      // would either be stale or wouldn't apply.
      signals: undefined,
    });
  } catch {
    return {
      passed: true,
      latencyMs: Date.now() - start,
      failedOpen: true,
      reason: 'gate-error',
    };
  }

  if (result.pass) {
    return {
      passed: true,
      latencyMs: result.latencyMs,
      failedOpen: result.failedOpen,
      reason: result.failedOpen ? 'gate-failed-open' : 'gate-passed',
    };
  }

  return {
    passed: false,
    rule: result.rule,
    issue: result.issue,
    suggestion: result.suggestion,
    latencyMs: result.latencyMs,
    reason: `gate-blocked:${result.rule || 'no-rule'}`,
  };
}
