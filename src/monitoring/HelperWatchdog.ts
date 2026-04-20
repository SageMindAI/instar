/**
 * HelperWatchdog — stall / failure detection for spawned subagents.
 *
 * The built-in SessionWatchdog notices when the top-level Claude Code
 * session hangs. It does NOT cover helper subagents spawned via the
 * Task tool: when one of those hits a rate limit or silently stalls,
 * the parent agent has no signal and goes quiet. This module closes
 * that gap.
 *
 * The watchdog subscribes to SubagentTracker's `start` and `stop`
 * events, schedules a per-agent stall timer on start, and inspects
 * the stop payload for failure markers. Two event types are emitted:
 *
 *   - `stall`         — a subagent has been running longer than the
 *                       configured stall timeout. Consumers should
 *                       surface this to the user so the parent agent
 *                       can decide whether to retry smaller.
 *   - `helper-failed` — a subagent stopped with a recognised failure
 *                       marker in its lastMessage (rate limit / 429 /
 *                       quota exhaustion / auth error). Payload
 *                       includes the original record and a reason.
 *
 * The watchdog is deliberately signal-only (see signal-vs-authority
 * discipline): it detects and emits. Retry-smaller logic and user
 * messaging live outside this module.
 */

import { EventEmitter } from 'node:events';
import type { SubagentTracker, SubagentRecord } from './SubagentTracker.js';

/** Default stall timeout: 5 minutes. */
export const DEFAULT_STALL_TIMEOUT_MS = 5 * 60 * 1000;

/** Patterns that identify a failure message from a stopped subagent. */
const FAILURE_PATTERNS: Array<{ reason: string; pattern: RegExp }> = [
  { reason: 'rate-limit', pattern: /\b(rate[\s-]?limit|too\s+many\s+requests?|429)\b/i },
  { reason: 'quota-exhausted', pattern: /\b(quota\s+(?:exhausted|exceeded)|out\s+of\s+(?:credits?|tokens?))\b/i },
  { reason: 'auth-error', pattern: /\b(unauthori[sz]ed|invalid\s+api\s+key|401|403)\b/i },
  { reason: 'timeout', pattern: /\b(timed?\s*out|timeout|request\s+timeout)\b/i },
  { reason: 'api-error', pattern: /\b(api[\s-]?error|anthropic[\s-]?error|internal[\s-]?server[\s-]?error|5\d{2})\b/i },
];

export interface HelperWatchdogConfig {
  subagentTracker: SubagentTracker;
  /** Stall timeout in ms. Default: 5 minutes. */
  stallTimeoutMs?: number;
  /** Injectable timer for tests. */
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
  /** Injectable clock. */
  now?: () => number;
}

export interface StallEvent {
  agentId: string;
  agentType: string;
  sessionId: string;
  startedAt: string;
  elapsedMs: number;
  reason: 'stall-timeout';
}

export interface HelperFailedEvent {
  record: SubagentRecord;
  reason: string;
  matchedPattern: string;
}

export class HelperWatchdog extends EventEmitter {
  private readonly tracker: SubagentTracker;
  private readonly stallTimeoutMs: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimeoutFn: (handle: NodeJS.Timeout) => void;
  private readonly now: () => number;

  /** Active stall timers, keyed by `${sessionId}:${agentId}`. */
  private readonly timers: Map<string, NodeJS.Timeout> = new Map();
  /** Start metadata, keyed by `${sessionId}:${agentId}`. */
  private readonly starts: Map<
    string,
    { agentId: string; agentType: string; sessionId: string; startedAt: string }
  > = new Map();

  private readonly onStart = (record: SubagentRecord): void => {
    this.handleStart(record);
  };
  private readonly onStop = (p: {
    agentId: string;
    sessionId: string;
    lastMessage?: string;
  }): void => {
    this.handleStop(p);
  };

  constructor(config: HelperWatchdogConfig) {
    super();
    this.tracker = config.subagentTracker;
    this.stallTimeoutMs = config.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.setTimeoutFn = config.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = config.clearTimeoutFn ?? ((h) => clearTimeout(h));
    this.now = config.now ?? Date.now;
  }

  /** Start subscribing to tracker events. */
  start(): void {
    this.tracker.on('start', this.onStart);
    this.tracker.on('stop', this.onStop);
  }

  /** Stop and clear all pending stall timers. */
  stop(): void {
    this.tracker.off('start', this.onStart);
    this.tracker.off('stop', this.onStop);
    for (const h of this.timers.values()) {
      this.clearTimeoutFn(h);
    }
    this.timers.clear();
    this.starts.clear();
  }

  /**
   * Inspect a stop message for a known failure pattern. Exposed as a
   * static method so callers that don't want the full watchdog wiring
   * (tests, post-mortem analyzers) can reuse the classifier.
   */
  static classifyStopMessage(
    lastMessage: string | null | undefined,
  ): { reason: string; matchedPattern: string } | null {
    if (!lastMessage) return null;
    for (const { reason, pattern } of FAILURE_PATTERNS) {
      if (pattern.test(lastMessage)) {
        return { reason, matchedPattern: pattern.source };
      }
    }
    return null;
  }

  // ── Internal handlers ────────────────────────────────────────────

  private handleStart(record: SubagentRecord): void {
    const key = `${record.sessionId}:${record.agentId}`;
    if (this.timers.has(key)) return; // idempotent
    this.starts.set(key, {
      agentId: record.agentId,
      agentType: record.agentType,
      sessionId: record.sessionId,
      startedAt: record.startedAt,
    });
    const handle = this.setTimeoutFn(() => {
      this.fireStall(key);
    }, this.stallTimeoutMs);
    this.timers.set(key, handle);
  }

  private handleStop(p: {
    agentId: string;
    sessionId: string;
    lastMessage?: string;
  }): void {
    const key = `${p.sessionId}:${p.agentId}`;
    const handle = this.timers.get(key);
    if (handle) {
      this.clearTimeoutFn(handle);
      this.timers.delete(key);
    }
    this.starts.delete(key);

    const failure = HelperWatchdog.classifyStopMessage(p.lastMessage);
    if (failure) {
      const records = this.tracker.getSessionRecords(p.sessionId);
      const record =
        records.find(
          (r: SubagentRecord) => r.agentId === p.agentId && r.stoppedAt !== null,
        ) ??
        ({
          agentId: p.agentId,
          agentType: 'unknown',
          sessionId: p.sessionId,
          startedAt: new Date().toISOString(),
          stoppedAt: new Date().toISOString(),
          lastMessage: p.lastMessage ?? null,
          transcriptPath: null,
        } as SubagentRecord);
      const event: HelperFailedEvent = {
        record,
        reason: failure.reason,
        matchedPattern: failure.matchedPattern,
      };
      this.emit('helper-failed', event);
    }
  }

  private fireStall(key: string): void {
    const meta = this.starts.get(key);
    this.timers.delete(key);
    this.starts.delete(key);
    if (!meta) return;
    const elapsedMs = Math.max(
      0,
      this.now() - Date.parse(meta.startedAt) || this.stallTimeoutMs,
    );
    const event: StallEvent = {
      agentId: meta.agentId,
      agentType: meta.agentType,
      sessionId: meta.sessionId,
      startedAt: meta.startedAt,
      elapsedMs,
      reason: 'stall-timeout',
    };
    this.emit('stall', event);
  }
}
