/**
 * Quota Exhaustion Detector — classifies WHY a session died.
 *
 * Pattern-matches tmux output from a dead session against known
 * failure signatures, cross-references with quota state to produce
 * a confidence-weighted classification.
 *
 * Use cases:
 * - Skip ledger: record quota_exhaustion vs crash vs normal_exit
 * - Telegram alerts: "session died because quota exhausted"
 * - Auto-recovery: trigger account switch on repeated quota deaths
 *
 * Ported from Dawn's dawn-server/src/quota/QuotaExhaustionDetector.ts,
 * simplified for general Instar use (no Telegram dependency).
 */

import type { QuotaState, SessionDeathCause, SessionDeathClassification } from '../core/types.js';

// Pattern groups for classification
const QUOTA_PATTERNS = [
  'overloaded_error',
  'rate_limit',
  '429',
  'quota.*exceeded',
  'usage.*limit',
  'too many requests',
  'resource_exhausted',
  'capacity',
  'throttl',
  'rate limit exceeded',
];

const CONTEXT_PATTERNS = [
  'context.*exhaust',
  'context.*limit',
  'context.*full',
  'token.*limit.*reached',
  'maximum.*context',
  'conversation is too long',
  'conversation too long',
  'error during compaction.*too long',
  'press esc twice to go up a few messages',
];

const CRASH_PATTERNS = [
  'SIGABRT',
  'SIGSEGV',
  'SIGKILL',
  'fatal error',
  'unhandled.*exception',
  'panic:',
  'stack overflow',
  'out of memory',
  'heap.*out',
];

const NORMAL_EXIT_PATTERNS = [
  'Session ended',
  'Goodbye!',
  'has been completed',
  'Auto-exit',
  '✓',
  'exited cleanly',
];

/**
 * Classify why a session died based on its terminal output and quota state.
 */
export function classifySessionDeath(
  tmuxOutput: string,
  quotaState?: QuotaState | null,
): SessionDeathClassification {
  if (!tmuxOutput || tmuxOutput.trim().length === 0) {
    return { cause: 'unknown', confidence: 'low', detail: 'No output captured' };
  }

  const output = tmuxOutput.toLowerCase();

  // Check each pattern group
  const quotaMatch = matchPatterns(output, QUOTA_PATTERNS);
  const contextMatch = matchPatterns(output, CONTEXT_PATTERNS);
  const crashMatch = matchPatterns(output, CRASH_PATTERNS);
  const normalMatch = matchPatterns(output, NORMAL_EXIT_PATTERNS);

  // Normal exit takes precedence if present
  if (normalMatch && !quotaMatch && !crashMatch) {
    return {
      cause: 'normal_exit',
      confidence: 'high',
      detail: `Matched normal exit pattern: "${normalMatch}"`,
    };
  }

  // Quota exhaustion — cross-reference with state for confidence
  if (quotaMatch) {
    let confidence: 'high' | 'medium' | 'low' = 'medium';

    // Cross-reference: if 5-hour is high, boost confidence
    if (quotaState) {
      const fiveHour = quotaState.fiveHourPercent;
      const weekly = quotaState.usagePercent;
      if (typeof fiveHour === 'number' && fiveHour > 90) {
        confidence = 'high';
      } else if (weekly > 85) {
        confidence = 'high';
      }
    }

    return {
      cause: 'quota_exhaustion',
      confidence,
      detail: `Matched quota pattern: "${quotaMatch}"` +
        (quotaState ? ` (weekly: ${quotaState.usagePercent}%, 5h: ${quotaState.fiveHourPercent ?? 'n/a'}%)` : ''),
    };
  }

  // Context exhaustion — boost confidence for strong signals
  if (contextMatch) {
    const strongSignals = ['conversation too long', 'conversation is too long', 'error during compaction'];
    const isStrong = strongSignals.some(s => output.includes(s));
    return {
      cause: 'context_exhausted',
      confidence: isStrong ? 'high' : 'medium',
      detail: `Matched context pattern: "${contextMatch}"`,
    };
  }

  // Crash
  if (crashMatch) {
    return {
      cause: 'crash',
      confidence: 'medium',
      detail: `Matched crash pattern: "${crashMatch}"`,
    };
  }

  return { cause: 'unknown', confidence: 'low', detail: 'No patterns matched' };
}

/**
 * Detect context exhaustion in tmux output from a LIVE session.
 * Unlike classifySessionDeath (which classifies after death),
 * this can be called on alive sessions to detect the error proactively.
 */
export function detectContextExhaustion(tmuxOutput: string): { matched: boolean; pattern: string | null; confidence: 'high' | 'medium' } {
  if (!tmuxOutput || tmuxOutput.trim().length === 0) {
    return { matched: false, pattern: null, confidence: 'medium' };
  }
  const output = tmuxOutput.toLowerCase();
  const match = matchPatterns(output, CONTEXT_PATTERNS);
  if (!match) {
    return { matched: false, pattern: null, confidence: 'medium' };
  }
  const strongSignals = ['conversation too long', 'conversation is too long', 'error during compaction'];
  const isStrong = strongSignals.some(s => output.includes(s));
  return { matched: true, pattern: match, confidence: isStrong ? 'high' : 'medium' };
}

/**
 * Check if output matches any pattern in a group.
 * Returns the first matching pattern string, or null.
 */
export function matchPatterns(output: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern, 'i').test(output)) {
        return pattern;
      }
    } catch {
      // @silent-fallback-ok — regex fallback to string match
      if (output.includes(pattern.toLowerCase())) {
        return pattern;
      }
    }
  }
  return null;
}
