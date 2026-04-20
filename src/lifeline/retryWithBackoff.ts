/**
 * retryWithBackoff — small, policy-configurable retry helper.
 *
 * Used by the Telegram lifeline to give in-flight message handoffs a real
 * chance to succeed before falling into the drop/queue path. Kept generic
 * so it can be reused by other lifeline call sites that currently give up
 * on the first failure.
 *
 * Not a gate, not an authority — just mechanics. Signal-vs-authority:
 * retrying is deterministic policy; any "should we give up" judgment is
 * upstream.
 */

export interface RetryPolicy {
  /** Total number of attempts (not retries). 3 means "try, wait, retry, wait, retry". */
  attempts: number;
  /** Base delay in ms before the second attempt. Subsequent delays double. */
  baseMs: number;
  /** Optional callback invoked before each attempt. onAttempt(n, lastError). */
  onAttempt?: (attemptNumber: number, lastError: Error | undefined) => void;
  /**
   * Optional predicate — if it returns true for a thrown error, retry stops
   * immediately and the error is re-thrown. Used to short-circuit version-skew
   * (426) and malformed-request (400) responses that would be pointless to retry.
   */
  isTerminal?: (err: Error) => boolean;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    if (policy.onAttempt) {
      policy.onAttempt(attempt, lastError);
    }
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (policy.isTerminal?.(lastError)) throw lastError;
      if (attempt === policy.attempts) break;
      const delayMs = policy.baseMs * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastError ?? new Error('retryWithBackoff: exhausted with no recorded error');
}
