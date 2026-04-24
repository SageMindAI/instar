/**
 * Lightweight in-process counters for the Telegram formatter pipeline.
 *
 * Prometheus-style labels are modeled as nested maps. There is no scrape
 * endpoint yet — consumers call `getFormatMetricsSnapshot()` for test
 * assertions and dashboard/debug exposure. When a real metrics registry
 * lands, swap these functions to adapters without touching callers.
 *
 * Spec: docs/specs/TELEGRAM-MARKDOWN-RENDERER-SPEC.md ("Cost / monitoring").
 */

interface FormatMetricsState {
  formatAppliedTotal: Map<string, number>; // key = mode
  formatLintIssuesTotal: Map<string, number>; // key = issue code/message
  formatFallbackPlainRetryTotal: number;
}

const state: FormatMetricsState = {
  formatAppliedTotal: new Map(),
  formatLintIssuesTotal: new Map(),
  formatFallbackPlainRetryTotal: 0,
};

export function recordFormatApplied(mode: string): void {
  state.formatAppliedTotal.set(mode, (state.formatAppliedTotal.get(mode) ?? 0) + 1);
}

export function recordFormatLintIssue(issue: string): void {
  state.formatLintIssuesTotal.set(issue, (state.formatLintIssuesTotal.get(issue) ?? 0) + 1);
}

export function recordFormatFallbackPlainRetry(): void {
  state.formatFallbackPlainRetryTotal += 1;
}

export interface FormatMetricsSnapshot {
  formatAppliedTotal: Record<string, number>;
  formatLintIssuesTotal: Record<string, number>;
  formatFallbackPlainRetryTotal: number;
}

export function getFormatMetricsSnapshot(): FormatMetricsSnapshot {
  return {
    formatAppliedTotal: Object.fromEntries(state.formatAppliedTotal),
    formatLintIssuesTotal: Object.fromEntries(state.formatLintIssuesTotal),
    formatFallbackPlainRetryTotal: state.formatFallbackPlainRetryTotal,
  };
}

/** Testing-only: reset all counters. */
export function resetFormatMetrics(): void {
  state.formatAppliedTotal.clear();
  state.formatLintIssuesTotal.clear();
  state.formatFallbackPlainRetryTotal = 0;
}
