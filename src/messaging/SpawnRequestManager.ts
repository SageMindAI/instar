/**
 * SpawnRequestManager — handles on-demand session spawning for message delivery.
 *
 * Per Phase 5 of INTER-AGENT-MESSAGING-SPEC v3.1:
 * - Evaluates spawn requests against resource constraints
 * - Spawns sessions with full context about why they were created
 * - Delivers pending messages to newly spawned sessions
 * - Handles denials with retry and escalation
 * - Enforces cooldown, session limits, memory pressure checks
 *
 * §4.2 additions (Threadline Cooldown & Queue Drain spec v7):
 * - Failure-suppressive cooldown reservation: `lastSpawnByAgent.set` BEFORE
 *   async spawn, never rolled back on failure. Prevents a peer who triggers
 *   fast-failing spawn errors from beating the cooldown.
 * - Classified failure attribution: Phase 1 classifier treats only
 *   locally-generated typed errors as agent-attributable. Everything else is
 *   ambiguous and does NOT bump penalty.
 * - Penalty state in separate fields: `penaltyUntil` (timestamp), and
 *   `consecutiveSpawnFailures` (counter). Reset on success. After 3
 *   attributable failures, `penaltyUntil = now + 2 * cooldownMs`.
 * - Single cooldown-remaining read path: `cooldownRemainingMs(agent)`.
 *   No consumer computes `now - lastSpawn` directly — closes the alias bug.
 * - State stored as `#private` ECMAScript fields so external consumers can't
 *   bypass the helpers. tsconfig target is ES2022; private fields are native.
 */

import { createHash } from 'node:crypto';
import type { Session } from '../core/types.js';

/**
 * §4.3: hash version prefix. Stored on every queued entry's `envelopeHash`
 * so future algorithm upgrades can ship without invalidating queued entries
 * (forward-compat, matches subresource-integrity pattern).
 */
const ENVELOPE_HASH_PREFIX = 'sha256-v1:';

/**
 * Stable canonical-JSON serialization with sorted keys. Permuting input
 * object keys yields the same hash. Only handles plain objects, arrays,
 * primitives — no class instances, dates, or undefined values (which
 * JSON.stringify drops anyway).
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

/**
 * §4.3: compute the versioned envelope hash for a queue entry's payload.
 * Hashes a canonical JSON of `{ context, threadId }` so two requests with
 * the same payload but differently-ordered keys produce the same hash.
 */
export function computeEnvelopeHash(input: { context?: string; threadId?: string }): string {
  const payload = canonicalJson({ context: input.context ?? '', threadId: input.threadId ?? '' });
  const sha = createHash('sha256').update(payload, 'utf8').digest('hex');
  return ENVELOPE_HASH_PREFIX + sha;
}

// ── Types ───────────────────────────────────────────────────────

export interface SpawnRequest {
  requester: { agent: string; session: string; machine: string };
  target: { agent: string; machine: string };
  reason: string;
  context?: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  suggestedModel?: string;
  suggestedMaxDuration?: number;
  pendingMessages?: string[];
}

export interface SpawnResult {
  approved: boolean;
  sessionId?: string;
  tmuxSession?: string;
  reason?: string;
  retryAfterMs?: number;
}

/**
 * Classified cause of a spawn failure (§4.2).
 *
 * Callers that wrap `spawnSession` SHOULD emit a typed failure with one of
 * these `cause` values. Untagged errors default to `ambiguous` — fail-open
 * by design so legitimate infra flakes don't penalize a peer.
 *
 * Only `agent-attributable` causes count toward `consecutiveSpawnFailures`.
 */
export type SpawnFailureCause =
  | 'envelope-validation'            // agent-attributable
  | 'admission-cap'                  // agent-attributable
  | 'safety-refusal-on-payload'      // agent-attributable (autonomy gate explicit block)
  | 'memory-pressure'                // infrastructure
  | 'session-cap'                    // infrastructure
  | 'provider-5xx'                   // infrastructure
  | 'gate-llm-timeout'               // infrastructure
  | 'ambiguous';                     // neither — still emits breadcrumb, no penalty

/** Error class callers throw from inside `spawnSession` to tag attributable failures. */
export class SpawnFailureError extends Error {
  constructor(message: string, public readonly cause: SpawnFailureCause) {
    super(message);
    this.name = 'SpawnFailureError';
  }
}

const AGENT_ATTRIBUTABLE_CAUSES: ReadonlySet<SpawnFailureCause> = new Set([
  'envelope-validation',
  'admission-cap',
  'safety-refusal-on-payload',
]);

export interface SpawnRequestManagerConfig {
  /** Max concurrent sessions allowed */
  maxSessions: number;
  /** Function to list current running sessions */
  getActiveSessions: () => Session[];
  /** Function to spawn a new session. Returns the session ID. */
  spawnSession: (prompt: string, options?: { model?: string; maxDurationMinutes?: number }) => Promise<string>;
  /** Function to check memory pressure. Returns true if pressure is too high. */
  isMemoryPressureHigh?: () => boolean;
  /** Cooldown between spawn requests per agent (ms). Default: 30s */
  cooldownMs?: number;
  /** Max spawn retries before giving up. Default: 3 */
  maxRetries?: number;
  /** Max retry window (ms). Default: 30 min */
  maxRetryWindowMs?: number;
  /** Callback for escalation (e.g., Telegram notification) */
  onEscalate?: (request: SpawnRequest, reason: string) => void;
  /** Optional clock injection for deterministic tests. Defaults to Date.now(). */
  nowFn?: () => number;
  /**
   * §4.2: Called per ready agent during a drain tick. The consumer is
   * responsible for running a spawn/deliver cycle for that agent — typically
   * by constructing a synthetic `SpawnRequest` and calling back into
   * `evaluate`. Optional: if unset, the drain loop is a no-op and queued
   * messages only drain on the next inline `evaluate` call (legacy behavior).
   */
  onDrainReady?: (agent: string) => Promise<void>;
  /** §4.2: max drains per tick. Default 8. */
  maxDrainsPerTick?: number;
  /** §4.2: max queued messages per agent while in degraded admission. Default 1. */
  degradedMaxQueuedPerAgent?: number;
  /**
   * §4.3: max envelope size in bytes (UTF-8). Spawn requests with `context`
   * larger than this are refused at admission with an `envelope-too-large`
   * reason. Bounds drain-tick cost and prevents a peer from hogging budget
   * with bulk content. Default: 256 KiB.
   */
  maxEnvelopeBytes?: number;
}

// ── Constants ───────────────────────────────────────────────────

const DEFAULT_COOLDOWN_MS = 30_000; // 30 seconds (reduced from 5 min to allow multi-message agents)
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_RETRY_WINDOW_MS = 30 * 60_000;

/** §4.2: penalty kicks in after this many consecutive agent-attributable failures. */
const PENALTY_FAILURE_THRESHOLD = 3;
/** §4.2: penalty duration is this multiple of the configured cooldown. */
const PENALTY_COOLDOWN_MULTIPLIER = 2;

/**
 * §4.2 infra-failure soft limiter.
 *
 * Tracks infrastructure-attributable failures (provider-5xx, gate-llm-timeout,
 * etc.) over a sliding window. If a peer exceeds the threshold within the
 * window, their queue admission is **degraded** to `degradedMaxQueuedPerAgent`
 * for the degradation duration. No penalty, no blame — just gentle backpressure
 * on peers that reliably trigger infra paths.
 */
/** §4.3: default payload byte-size cap. */
const DEFAULT_MAX_ENVELOPE_BYTES = 256 * 1024; // 256 KiB

const INFRA_FAILURE_WINDOW_MS = 10 * 60_000;       // 10 min
const INFRA_FAILURE_THRESHOLD = 5;                  // failures within window to trigger
const INFRA_DEGRADATION_DURATION_MS = 30 * 60_000;  // 30 min degraded admission
const DEGRADED_MAX_QUEUED_PER_AGENT_DEFAULT = 1;

/**
 * §4.2 drain-loop constants (DRR scheduling).
 *
 * The drain loop is a single shared `setInterval` that picks ready agents
 * (cooldown cleared AND queued messages present) and calls
 * `onDrainReady(agent)` so the consumer can run an actual spawn cycle.
 *
 * Fairness uses Deficit Round Robin with quantum=1, cost=1, at most one
 * drain per agent per tick. Agents not served this tick carry deficit for
 * next tick — prevents starvation when |ready| > MAX_DRAINS_PER_TICK.
 */
const DRAIN_TICK_FLOOR_MS = 1_000;
const DRAIN_TICK_CEILING_MS = 5_000;
const DRAIN_MAX_PER_TICK_DEFAULT = 8;
const DRR_QUANTUM = 1;
const DRR_COST = 1;
const DRR_AGE_BOOST_MULTIPLIER = 1.5;

const SPAWN_PROMPT_TEMPLATE = `You were spawned by an inter-agent message request.

Requester: {requester_agent}/{requester_session} on {requester_machine}
Reason: {reason}
{context_line}
You have {pending_count} pending message(s) to process.
After addressing these messages, you may continue with other work
or end your session if no further action is needed.

Use the threadline_send MCP tool to respond to messages. Include the threadId to maintain conversation context.
Use threadline_send with the target agentId to send new messages.`;

// ── Implementation ──────────────────────────────────────────────

export class SpawnRequestManager {
  readonly #config: SpawnRequestManagerConfig;
  readonly #nowFn: () => number;

  /** Track last spawn per agent for cooldown. Written BEFORE async spawn (§4.2 reservation). */
  readonly #lastSpawnByAgent = new Map<string, number>();

  /** §4.2: forbidden-until timestamp per agent regardless of cooldown elapsed. */
  readonly #penaltyUntil = new Map<string, number>();

  /** §4.2: consecutive agent-attributable failures per agent. Reset on success. */
  readonly #consecutiveSpawnFailures = new Map<string, number>();

  /** Track pending spawn retries (legacy retry path — still used by handleDenial). */
  readonly #pendingRetries = new Map<string, {
    request: SpawnRequest;
    attempts: number;
    firstAttemptAt: number;
  }>();

  /** Queue messages that arrive during cooldown, keyed by agent */
  /**
   * Per-agent queue of pending messages.
   *
   * §4.3 entry shape:
   * - `context` / `threadId`: the payload (existing).
   * - `receivedAt`: enqueue timestamp (existing, used for TTL pruning).
   * - `envelopeHash`: SHA-256 of canonical JSON of payload, prefixed
   *   `sha256-v1:`. Computed at enqueue. Lets the drain loop verify
   *   integrity and lets future code dedupe identical re-sends.
   * - `drainAttempts`: count of times the drain loop has attempted to
   *   process this entry. Bumped before each drain; reset on success.
   *   Used by DRR's age-boost.
   */
  readonly #pendingMessages = new Map<string, {
    context: string;
    threadId?: string;
    receivedAt: number;
    envelopeHash: string;
    drainAttempts: number;
  }[]>();

  /** Max queued messages per agent before oldest are dropped */
  static readonly MAX_QUEUED_PER_AGENT = 10;

  /** Max age for queued messages (10 minutes) */
  static readonly QUEUE_MAX_AGE_MS = 10 * 60_000;

  /** §4.2: DRR deficit counter per agent. Survives across ticks. */
  readonly #drrDeficit = new Map<string, number>();

  /** §4.2: drain-attempt counter per agent. Reset on successful drain. */
  readonly #drainAttempts = new Map<string, number>();

  /** §4.2: shared drain-tick timer. null when not started. */
  #drainTimer: ReturnType<typeof setInterval> | null = null;

  /** §4.2: re-entrancy guard to prevent overlapping tick executions. */
  #tickInflight = false;

  /** §4.2: rolling timestamps of infra-attributable failures per agent. */
  readonly #infraFailureWindow = new Map<string, number[]>();

  constructor(config: SpawnRequestManagerConfig) {
    this.#config = config;
    this.#nowFn = config.nowFn ?? (() => Date.now());
  }

  // ── §4.2 helpers ────────────────────────────────────────────

  /**
   * Single read path for "how long until this agent may spawn again" (§4.2).
   *
   * Returns the MAX of (remaining cooldown, remaining penalty, 0). No external
   * consumer should compute `now - lastSpawn` — this closes the alias bug
   * where subtracting a fresh timestamp against a stale one could produce
   * a negative elapsed and grant an unintended spawn.
   */
  cooldownRemainingMs(agent: string): number {
    const now = this.#nowFn();
    const cooldownMs = this.#config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    const lastSpawn = this.#lastSpawnByAgent.get(agent) ?? 0;
    const cooldownRem = Math.max(cooldownMs - (now - lastSpawn), 0);
    const penaltyRem = Math.max((this.#penaltyUntil.get(agent) ?? 0) - now, 0);
    return Math.max(cooldownRem, penaltyRem);
  }

  /**
   * Classify a thrown error from `spawnSession` into a SpawnFailureCause.
   * Phase 1 (per spec): only locally-generated `SpawnFailureError` with an
   * attributable cause counts. Everything else is `ambiguous`. No regex on
   * third-party error strings — that's brittle across library upgrades.
   */
  #classifyFailure(err: unknown): SpawnFailureCause {
    if (err instanceof SpawnFailureError) return err.cause;
    return 'ambiguous';
  }

  /**
   * Apply a classified failure to penalty state. Only agent-attributable
   * causes increment `consecutiveSpawnFailures`; hitting the threshold stamps
   * `penaltyUntil`. Infrastructure + ambiguous causes do NOT bump the counter.
   *
   * §4.2 infra soft limiter: infrastructure-attributable causes ARE recorded
   * in `#infraFailureWindow` so peers that reliably trigger infra paths can
   * be gently throttled via `isInfraDegraded(agent)`.
   */
  #applyFailureAttribution(agent: string, cause: SpawnFailureCause): void {
    if (AGENT_ATTRIBUTABLE_CAUSES.has(cause)) {
      const prior = this.#consecutiveSpawnFailures.get(agent) ?? 0;
      const next = prior + 1;
      this.#consecutiveSpawnFailures.set(agent, next);
      if (next >= PENALTY_FAILURE_THRESHOLD) {
        const cooldownMs = this.#config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
        this.#penaltyUntil.set(agent, this.#nowFn() + PENALTY_COOLDOWN_MULTIPLIER * cooldownMs);
      }
      return;
    }
    // Non-attributable causes (infra + ambiguous) feed the soft limiter
    // window. Ambiguous is included because, from the limiter's perspective,
    // unknown is indistinguishable from infra — the signal is "this peer
    // reliably triggers things going wrong, but we can't blame them".
    this.#recordInfraFailure(agent);
  }

  /** Record an infra-attributable failure timestamp; prune stale entries. */
  #recordInfraFailure(agent: string): void {
    const now = this.#nowFn();
    const cutoff = now - INFRA_FAILURE_WINDOW_MS;
    const window = this.#infraFailureWindow.get(agent) ?? [];
    const fresh = window.filter(t => t > cutoff);
    fresh.push(now);
    this.#infraFailureWindow.set(agent, fresh);
  }

  /**
   * Returns true if the agent has exceeded `INFRA_FAILURE_THRESHOLD`
   * infra-attributable failures within `INFRA_FAILURE_WINDOW_MS` AND the
   * resulting degradation window (`INFRA_DEGRADATION_DURATION_MS` since the
   * threshold-tripping failure) has not yet elapsed.
   *
   * No penalty implied — degraded admission ONLY caps queue depth via
   * `effectiveMaxQueuedPerAgent(agent)`.
   */
  isInfraDegraded(agent: string): boolean {
    const window = this.#infraFailureWindow.get(agent);
    if (!window || window.length < INFRA_FAILURE_THRESHOLD) return false;
    const now = this.#nowFn();
    const cutoff = now - INFRA_FAILURE_WINDOW_MS;
    const fresh = window.filter(t => t > cutoff);
    if (fresh.length < INFRA_FAILURE_THRESHOLD) return false;
    // Threshold-tripping failure = the Nth-most-recent failure (where N = threshold).
    // Degradation lasts INFRA_DEGRADATION_DURATION_MS from that timestamp.
    const tripIdx = fresh.length - INFRA_FAILURE_THRESHOLD;
    const trippedAt = fresh[tripIdx];
    return now - trippedAt < INFRA_DEGRADATION_DURATION_MS;
  }

  /** Effective per-agent queue cap, accounting for soft-limiter degradation. */
  effectiveMaxQueuedPerAgent(agent: string): number {
    if (this.isInfraDegraded(agent)) {
      return this.#config.degradedMaxQueuedPerAgent ?? DEGRADED_MAX_QUEUED_PER_AGENT_DEFAULT;
    }
    return SpawnRequestManager.MAX_QUEUED_PER_AGENT;
  }

  /** Clear penalty counters on successful spawn. */
  #clearFailureAttribution(agent: string): void {
    this.#consecutiveSpawnFailures.delete(agent);
    this.#penaltyUntil.delete(agent);
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Evaluate and potentially approve a spawn request.
   * Returns the result with approval status and session info if spawned.
   */
  async evaluate(request: SpawnRequest): Promise<SpawnResult> {
    const agent = request.requester.agent;

    // §4.3: payload byte-size cap. Refuse oversized envelopes at admission so
    // bulk content can't hog drain-tick budget. Measured on the UTF-8 byte
    // length of `context` (the only payload field on this surface today).
    const maxBytes = this.#config.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE_BYTES;
    if (request.context !== undefined) {
      const bytes = Buffer.byteLength(request.context, 'utf8');
      if (bytes > maxBytes) {
        return {
          approved: false,
          reason: `envelope-too-large: ${bytes} bytes exceeds cap of ${maxBytes} bytes`,
        };
      }
    }

    // §4.2: single-source cooldown check (covers cooldown AND penalty).
    const remainingMs = this.cooldownRemainingMs(agent);
    if (remainingMs > 0) {
      if (request.context) {
        this.#queueMessage(agent, request.context, request.pendingMessages?.[0]);
      }
      return {
        approved: false,
        reason: `Cooldown: ${Math.ceil(remainingMs / 1000)}s remaining before next spawn for ${agent}`,
        retryAfterMs: remainingMs,
      };
    }

    // Check session limits
    const activeSessions = this.#config.getActiveSessions();
    if (activeSessions.length >= this.#config.maxSessions) {
      if (request.priority !== 'critical' && request.priority !== 'high') {
        return {
          approved: false,
          reason: `Session limit reached (${activeSessions.length}/${this.#config.maxSessions}). Priority ${request.priority} insufficient to override.`,
          retryAfterMs: 60_000,
        };
      }
    }

    // Check memory pressure
    if (this.#config.isMemoryPressureHigh?.()) {
      return {
        approved: false,
        reason: 'Memory pressure too high for new session',
        retryAfterMs: 120_000,
      };
    }

    // §4.2: failure-suppressive reservation. Stamp `lastSpawnByAgent` BEFORE
    // the async spawn, and do NOT roll back on failure. A peer that triggers
    // fast-failing spawns still pays the cooldown.
    this.#lastSpawnByAgent.set(agent, this.#nowFn());

    try {
      const queuedMessages = this.#drainQueue(agent);
      const prompt = this.#buildSpawnPrompt(request, queuedMessages);
      const sessionId = await this.#config.spawnSession(prompt, {
        model: request.suggestedModel,
        maxDurationMinutes: request.suggestedMaxDuration,
      });

      // Success — clear penalty state and pending retries.
      this.#clearFailureAttribution(agent);
      const retryKey = this.#getRetryKey(request);
      this.#pendingRetries.delete(retryKey);

      return {
        approved: true,
        sessionId,
        reason: `Session spawned for: ${request.reason}`,
      };
    } catch (err) {
      const cause = this.#classifyFailure(err);
      this.#applyFailureAttribution(agent, cause);
      return {
        approved: false,
        reason: `Spawn failed (${cause}): ${err instanceof Error ? err.message : 'unknown error'}`,
        retryAfterMs: 30_000,
      };
    }
  }

  /**
   * Handle a denied spawn request — track retries and escalate if needed.
   */
  handleDenial(request: SpawnRequest, result: SpawnResult): void {
    const retryKey = this.#getRetryKey(request);
    const maxRetries = this.#config.maxRetries ?? DEFAULT_MAX_RETRIES;
    const maxWindow = this.#config.maxRetryWindowMs ?? DEFAULT_MAX_RETRY_WINDOW_MS;

    const pending = this.#pendingRetries.get(retryKey) ?? {
      request,
      attempts: 0,
      firstAttemptAt: this.#nowFn(),
    };
    pending.attempts++;
    this.#pendingRetries.set(retryKey, pending);

    const elapsed = this.#nowFn() - pending.firstAttemptAt;

    if (pending.attempts >= maxRetries || elapsed >= maxWindow) {
      this.#pendingRetries.delete(retryKey);

      const hasCritical = request.priority === 'critical' ||
        request.pendingMessages?.length;

      if (hasCritical && this.#config.onEscalate) {
        this.#config.onEscalate(
          request,
          `Spawn request denied ${pending.attempts} times over ${Math.round(elapsed / 60_000)}min. ` +
          `Reason: ${result.reason}. Pending messages: ${request.pendingMessages?.length ?? 0}`,
        );
      }
    }
  }

  /** Build the prompt for a spawned session */
  #buildSpawnPrompt(request: SpawnRequest, queuedMessages?: { context: string; threadId?: string }[]): string {
    const queuedSection = queuedMessages && queuedMessages.length > 0
      ? `\n\nAdditional messages received while you were being set up (${queuedMessages.length} queued):\n${queuedMessages.map((m, i) => `--- Queued message ${i + 1} ---\n${m.context}`).join('\n')}\n`
      : '';

    const totalPending = (request.pendingMessages?.length ?? 0) + (queuedMessages?.length ?? 0);

    return SPAWN_PROMPT_TEMPLATE
      .replace('{requester_agent}', request.requester.agent)
      .replace('{requester_session}', request.requester.session)
      .replace('{requester_machine}', request.requester.machine)
      .replace('{reason}', request.reason)
      .replace('{context_line}', request.context ? `Context: ${request.context}\n` : '')
      .replace('{pending_count}', String(totalPending))
      + queuedSection;
  }

  /** Queue a message for an agent during cooldown */
  #queueMessage(agent: string, context: string, threadId?: string): void {
    let queue = this.#pendingMessages.get(agent);
    if (!queue) {
      queue = [];
      this.#pendingMessages.set(agent, queue);
    }

    const now = this.#nowFn();
    const maxAge = SpawnRequestManager.QUEUE_MAX_AGE_MS;
    while (queue.length > 0 && now - queue[0].receivedAt > maxAge) {
      queue.shift();
    }

    // §4.2 infra soft limiter: respect degraded admission cap if active.
    const cap = this.effectiveMaxQueuedPerAgent(agent);
    while (queue.length >= cap) {
      queue.shift();
    }

    queue.push({
      context,
      threadId,
      receivedAt: now,
      envelopeHash: computeEnvelopeHash({ context, threadId }),
      drainAttempts: 0,
    });
  }

  /** Drain all queued messages for an agent */
  #drainQueue(agent: string): { context: string; threadId?: string }[] {
    const queue = this.#pendingMessages.get(agent);
    if (!queue || queue.length === 0) return [];

    const now = this.#nowFn();
    const maxAge = SpawnRequestManager.QUEUE_MAX_AGE_MS;
    const valid = queue.filter(m => now - m.receivedAt < maxAge);
    this.#pendingMessages.delete(agent);
    return valid;
  }

  /** Get count of queued messages for an agent (for monitoring) */
  getQueuedCount(agent: string): number {
    return this.#pendingMessages.get(agent)?.length ?? 0;
  }

  /** Generate a unique key for retry tracking */
  #getRetryKey(request: SpawnRequest): string {
    return `${request.requester.agent}:${request.target.agent}:${request.reason.slice(0, 50)}`;
  }

  /** Get current spawn state for monitoring */
  getStatus(): {
    cooldowns: Array<{ agent: string; remainingMs: number }>;
    pendingRetries: number;
    queuedMessages: Array<{ agent: string; count: number }>;
    penalties: Array<{ agent: string; untilMs: number; consecutiveFailures: number }>;
  } {
    const cooldowns: Array<{ agent: string; remainingMs: number }> = [];
    for (const agent of this.#lastSpawnByAgent.keys()) {
      const remaining = this.cooldownRemainingMs(agent);
      if (remaining > 0) {
        cooldowns.push({ agent, remainingMs: remaining });
      }
    }

    const penalties: Array<{ agent: string; untilMs: number; consecutiveFailures: number }> = [];
    const now = this.#nowFn();
    for (const [agent, until] of this.#penaltyUntil) {
      if (until > now) {
        penalties.push({
          agent,
          untilMs: until - now,
          consecutiveFailures: this.#consecutiveSpawnFailures.get(agent) ?? 0,
        });
      }
    }

    const queuedMessages: Array<{ agent: string; count: number }> = [];
    for (const [agent, queue] of this.#pendingMessages) {
      if (queue.length > 0) {
        queuedMessages.push({ agent, count: queue.length });
      }
    }

    return {
      cooldowns,
      pendingRetries: this.#pendingRetries.size,
      queuedMessages,
      penalties,
    };
  }

  // ── §4.2 Drain loop ─────────────────────────────────────────

  /**
   * Compute the drain-tick interval from the configured cooldown (§4.2).
   *
   * Formula: `max(min(cooldownMs / 4, 5000), 1000)`. Floor at 1 s prevents
   * a tiny cooldown from producing a hot loop; ceiling at 5 s preserves
   * responsiveness under long cooldowns.
   */
  getDrainTickMs(): number {
    const cooldownMs = this.#config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    const tick = Math.min(Math.floor(cooldownMs / 4), DRAIN_TICK_CEILING_MS);
    return Math.max(tick, DRAIN_TICK_FLOOR_MS);
  }

  /**
   * Start the shared drain tick. Idempotent — safe to call twice; a second
   * call is a no-op. The tick runs on a real `setInterval` so consumers
   * can use vitest fake timers for test determinism.
   */
  start(): void {
    if (this.#drainTimer !== null) return;
    const intervalMs = this.getDrainTickMs();
    this.#drainTimer = setInterval(() => {
      // Fire-and-forget tick; any rejection is swallowed (logged inside tick).
      void this.runTick();
    }, intervalMs);
    // Node-only: `unref` so the timer doesn't keep the event loop alive.
    // Defensive type check because some runtimes don't expose unref.
    const maybeUnref = (this.#drainTimer as unknown as { unref?: () => void }).unref;
    if (typeof maybeUnref === 'function') {
      maybeUnref.call(this.#drainTimer);
    }
  }

  /**
   * Stop the drain tick and clear deficit/attempt state. Idempotent.
   * Use this OR `reset()` between tests — `reset()` also clears cooldown.
   */
  dispose(): void {
    if (this.#drainTimer !== null) {
      clearInterval(this.#drainTimer);
      this.#drainTimer = null;
    }
    this.#drrDeficit.clear();
    this.#drainAttempts.clear();
    this.#tickInflight = false;
  }

  /**
   * Run a single drain tick. Exposed for tests + for consumers who want
   * to drive ticks manually (e.g., drive-by-event rather than by timer).
   *
   * Behavior:
   * 1. O(1) early return if no agents have queued messages.
   * 2. Collect ready agents: those with `cooldownRemainingMs <= tickGraceMs`
   *    AND queued messages present.
   * 3. Add DRR quantum to each ready agent's deficit (with age boost for
   *    agents whose oldest queued message has been drain-attempted > 1 time).
   * 4. Select up to `maxDrainsPerTick` agents ordered by descending deficit;
   *    decrement deficit by cost for each selected agent.
   * 5. Fire `onDrainReady` for selected agents concurrently via allSettled.
   *
   * Returns the count of drain callbacks invoked this tick (useful for tests).
   */
  async runTick(): Promise<number> {
    if (this.#tickInflight) return 0;
    if (this.#pendingMessages.size === 0) return 0;
    const onDrainReady = this.#config.onDrainReady;
    if (!onDrainReady) return 0;

    this.#tickInflight = true;
    try {
      const tickGraceMs = this.getDrainTickMs();
      const readyAgents: string[] = [];
      for (const [agent, queue] of this.#pendingMessages) {
        if (queue.length === 0) continue;
        if (this.cooldownRemainingMs(agent) <= tickGraceMs) {
          readyAgents.push(agent);
        }
      }
      if (readyAgents.length === 0) return 0;

      // DRR: add quantum (with age boost) to each ready agent's deficit.
      for (const agent of readyAgents) {
        const attempts = this.#drainAttempts.get(agent) ?? 0;
        const quantum = attempts > 1 ? DRR_QUANTUM * DRR_AGE_BOOST_MULTIPLIER : DRR_QUANTUM;
        this.#drrDeficit.set(agent, (this.#drrDeficit.get(agent) ?? 0) + quantum);
      }

      // Select drainees: highest deficit first, stable by insertion order.
      // At most one drain per agent per tick, capped at maxDrainsPerTick.
      const max = this.#config.maxDrainsPerTick ?? DRAIN_MAX_PER_TICK_DEFAULT;
      const selected = [...readyAgents]
        .sort((a, b) => (this.#drrDeficit.get(b) ?? 0) - (this.#drrDeficit.get(a) ?? 0))
        .slice(0, max)
        .filter(a => (this.#drrDeficit.get(a) ?? 0) >= DRR_COST);

      for (const agent of selected) {
        this.#drrDeficit.set(agent, (this.#drrDeficit.get(agent) ?? 0) - DRR_COST);
        this.#drainAttempts.set(agent, (this.#drainAttempts.get(agent) ?? 0) + 1);
      }

      // Garbage-collect deficit for agents no longer ready AND at zero.
      for (const agent of this.#drrDeficit.keys()) {
        if (!readyAgents.includes(agent) && (this.#drrDeficit.get(agent) ?? 0) <= 0) {
          this.#drrDeficit.delete(agent);
          this.#drainAttempts.delete(agent);
        }
      }

      // Fire callbacks concurrently; one callback failure does not abort the batch.
      const results = await Promise.allSettled(
        selected.map(agent => onDrainReady(agent).then(() => {
          // Successful drain → reset attempt counter so next tick doesn't apply age-boost.
          this.#drainAttempts.delete(agent);
        })),
      );
      // Log but don't throw on individual callback failures.
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'rejected') {
          console.warn(`[SpawnRequestManager] drain callback failed for agent ${selected[i]}: ${String(r.reason)}`);
        }
      }
      return selected.length;
    } finally {
      this.#tickInflight = false;
    }
  }

  /** Test seam: snapshot of DRR deficit state. */
  getDrrDeficitSnapshotForTests(): ReadonlyMap<string, number> {
    return new Map(this.#drrDeficit);
  }

  /** Clear all state (for testing) */
  reset(): void {
    this.#lastSpawnByAgent.clear();
    this.#pendingRetries.clear();
    this.#pendingMessages.clear();
    this.#penaltyUntil.clear();
    this.#consecutiveSpawnFailures.clear();
    this.#drrDeficit.clear();
    this.#drainAttempts.clear();
    this.#infraFailureWindow.clear();
  }
}
