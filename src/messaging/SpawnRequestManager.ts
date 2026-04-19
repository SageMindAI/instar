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

import type { Session } from '../core/types.js';

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
}

// ── Constants ───────────────────────────────────────────────────

const DEFAULT_COOLDOWN_MS = 30_000; // 30 seconds (reduced from 5 min to allow multi-message agents)
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_RETRY_WINDOW_MS = 30 * 60_000;

/** §4.2: penalty kicks in after this many consecutive agent-attributable failures. */
const PENALTY_FAILURE_THRESHOLD = 3;
/** §4.2: penalty duration is this multiple of the configured cooldown. */
const PENALTY_COOLDOWN_MULTIPLIER = 2;

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
  readonly #pendingMessages = new Map<string, { context: string; threadId?: string; receivedAt: number }[]>();

  /** Max queued messages per agent before oldest are dropped */
  static readonly MAX_QUEUED_PER_AGENT = 10;

  /** Max age for queued messages (10 minutes) */
  static readonly QUEUE_MAX_AGE_MS = 10 * 60_000;

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
   */
  #applyFailureAttribution(agent: string, cause: SpawnFailureCause): void {
    if (!AGENT_ATTRIBUTABLE_CAUSES.has(cause)) return;
    const prior = this.#consecutiveSpawnFailures.get(agent) ?? 0;
    const next = prior + 1;
    this.#consecutiveSpawnFailures.set(agent, next);
    if (next >= PENALTY_FAILURE_THRESHOLD) {
      const cooldownMs = this.#config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
      this.#penaltyUntil.set(agent, this.#nowFn() + PENALTY_COOLDOWN_MULTIPLIER * cooldownMs);
    }
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

    if (queue.length >= SpawnRequestManager.MAX_QUEUED_PER_AGENT) {
      queue.shift();
    }

    queue.push({ context, threadId, receivedAt: now });
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

  /** Clear all state (for testing) */
  reset(): void {
    this.#lastSpawnByAgent.clear();
    this.#pendingRetries.clear();
    this.#pendingMessages.clear();
    this.#penaltyUntil.clear();
    this.#consecutiveSpawnFailures.clear();
  }
}
