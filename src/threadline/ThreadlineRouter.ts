/**
 * ThreadlineRouter — Wires ThreadResumeMap into the existing message receive pipeline.
 *
 * When a cross-agent message arrives for this agent:
 * 1. (Phase 2) Check the AutonomyGate for visibility/approval gating
 * 2. Check if a ThreadResumeMap entry exists for this threadId
 * 3. If yes → resume that Claude session (--resume UUID)
 * 4. If no → spawn a new session, save the mapping
 * 5. Inject thread history into the session context
 * 6. On session end → persist the UUID back to ThreadResumeMap
 *
 * The ThreadlineRouter hooks into the existing message pipeline — it does NOT
 * replace the MessageRouter. It handles the spawn/resume decision for threaded
 * cross-agent conversations specifically.
 */

import crypto from 'node:crypto';
import type { MessageRouter } from '../messaging/MessageRouter.js';
import type { SpawnRequestManager, SpawnResult } from '../messaging/SpawnRequestManager.js';
import type { MessageStore } from '../messaging/MessageStore.js';
import type { IMessageDelivery } from '../messaging/types.js';
import type { MessageEnvelope, AgentMessage } from '../messaging/types.js';
import type { ThreadResumeMap, ThreadResumeEntry, ThreadState } from './ThreadResumeMap.js';
import type { AutonomyGate } from './AutonomyGate.js';
import type { AgentTrustLevel } from './AgentTrustManager.js';
import { buildRelayGroundingPreamble, tagExternalMessage, RELAY_HISTORY_LIMITS } from './RelayGroundingPreamble.js';
import type { RelayGroundingContext } from './RelayGroundingPreamble.js';

// ── Types ───────────────────────────────────────────────────────

/** Configuration for the ThreadlineRouter */
export interface ThreadlineRouterConfig {
  /** Name of this agent */
  localAgent: string;
  /** Machine ID */
  localMachine: string;
  /** Max number of thread history messages to inject into context */
  maxHistoryMessages: number;
}

/**
 * Ledger event fired by the router on thread lifecycle transitions.
 * Consumed by the Integrated-Being SharedStateLedger via registerLedgerEmitters().
 *
 * SIGNAL-ONLY by design — the router never blocks on ledger write failures.
 */
export interface ThreadlineLedgerEvent {
  kind: 'thread-opened' | 'thread-closed' | 'thread-abandoned';
  threadId: string;
  remoteAgent: string;
  subject: string;
  /** Trust-tier source — autonomy level snapshot for trust mapping. */
  autonomyLevel?: string;
  /** ISO timestamp of the event. */
  timestamp: string;
}

/** Relay context passed from InboundMessageGate when message arrives via relay */
export interface RelayMessageContext {
  /** Sender's cryptographic fingerprint */
  senderFingerprint: string;
  /** Sender's display name */
  senderName: string;
  /** Trust level of the sender */
  trustLevel: AgentTrustLevel;
  /** Who granted trust */
  trustSource?: string;
  /** When trust was granted */
  trustDate?: string;
  /** Original source fingerprint (for multi-hop) */
  originFingerprint?: string;
  /** Original source name */
  originName?: string;
}

/** Result of handling an inbound threaded message */
export interface ThreadlineHandleResult {
  /** Whether this message was handled as a threadline message */
  handled: boolean;
  /** The thread ID (existing or newly created) */
  threadId?: string;
  /** Whether a new session was spawned (vs. resumed) */
  spawned?: boolean;
  /** Whether an existing session was resumed */
  resumed?: boolean;
  /** Whether the message was injected directly into a live session
   *  (PR-4: avoids the overhead of spawning/resuming when a session is
   *  already running for this thread). */
  injected?: boolean;
  /** The tmux session name handling this thread */
  sessionName?: string;
  /** Error message if handling failed */
  error?: string;
  /** Gate decision (if autonomy gate is active) */
  gateDecision?: string;
  /** Approval ID (if message was queued for approval) */
  approvalId?: string;
}

// ── Constants ───────────────────────────────────────────────────

const DEFAULT_MAX_HISTORY = 20;

const THREAD_SPAWN_PROMPT_TEMPLATE = `You are continuing a threaded conversation with {remote_agent}.

Thread: {thread_id}
Subject: {subject}
Messages in thread: {message_count}

{history_section}

The latest message from {remote_agent}:
Subject: {latest_subject}
---
{latest_body}
---

Respond to this message. Use the threadline_send MCP tool with the agentId set to "{remote_agent}" and include the threadId "{thread_id}" to send your reply.`;

// ── Implementation ──────────────────────────────────────────────

export class ThreadlineRouter {
  private readonly messageRouter: MessageRouter;
  private readonly spawnManager: SpawnRequestManager;
  private readonly threadResumeMap: ThreadResumeMap;
  private readonly messageStore: MessageStore;
  private readonly config: ThreadlineRouterConfig;
  private readonly autonomyGate: AutonomyGate | null;
  /** Optional live-session injection delivery (PR-4). When set, the router
   *  will try to inject inbound messages directly into an already-running
   *  session for the thread before falling back to spawn/resume. */
  private readonly messageDelivery: IMessageDelivery | null;

  /** Optional ledger-event sink (Integrated-Being v1). Signal-only. */
  private readonly onLedgerEvent: ((evt: ThreadlineLedgerEvent) => void) | null;

  /** Track in-flight spawn requests to prevent concurrent spawns for the same thread */
  private readonly pendingSpawns = new Set<string>();

  constructor(
    messageRouter: MessageRouter,
    spawnManager: SpawnRequestManager,
    threadResumeMap: ThreadResumeMap,
    messageStore: MessageStore,
    config: Partial<ThreadlineRouterConfig> & Pick<ThreadlineRouterConfig, 'localAgent' | 'localMachine'>,
    autonomyGate?: AutonomyGate | null,
    messageDelivery?: IMessageDelivery | null,
    onLedgerEvent?: (evt: ThreadlineLedgerEvent) => void,
  ) {
    this.messageRouter = messageRouter;
    this.spawnManager = spawnManager;
    this.threadResumeMap = threadResumeMap;
    this.messageStore = messageStore;
    this.config = {
      maxHistoryMessages: DEFAULT_MAX_HISTORY,
      ...config,
    };
    this.autonomyGate = autonomyGate ?? null;
    this.messageDelivery = messageDelivery ?? null;
    this.onLedgerEvent = onLedgerEvent ?? null;
  }

  /** Fire a ledger event swallowing any exception (signal-only). */
  private emitLedger(evt: ThreadlineLedgerEvent): void {
    if (!this.onLedgerEvent) return;
    try { this.onLedgerEvent(evt); } catch { /* signal-only */ }
  }

  /**
   * Sweep thread-resume entries older than the TTL and emit synthetic
   * `thread-abandoned` ledger events. Bounded, idempotent via dedupKey on
   * the ledger side.
   */
  sweepAbandonedThreads(ttlMs: number = 24 * 60 * 60 * 1000): number {
    if (!this.onLedgerEvent) return 0;
    let emitted = 0;
    try {
      const all = this.threadResumeMap.listActive?.() ?? [];
      const cutoff = Date.now() - ttlMs;
      for (const { threadId, entry } of all) {
        if (entry.state === 'active' || entry.state === 'idle') {
          const last = Date.parse(entry.lastAccessedAt);
          if (Number.isFinite(last) && last < cutoff) {
            this.emitLedger({
              kind: 'thread-abandoned',
              threadId,
              remoteAgent: entry.remoteAgent,
              subject: entry.subject,
              timestamp: new Date().toISOString(),
            });
            emitted += 1;
          }
        }
      }
    } catch { /* best effort */ }
    return emitted;
  }

  /**
   * Handle an inbound cross-agent message that has a threadId.
   *
   * Decision tree:
   * - No threadId → not a threadline message, return { handled: false }
   * - Has threadId + existing resume entry → resume session
   * - Has threadId + no resume entry → spawn new session
   */
  async handleInboundMessage(envelope: MessageEnvelope, relayContext?: RelayMessageContext): Promise<ThreadlineHandleResult> {
    const { message } = envelope;

    // Only handle messages from other agents (not self-delivery)
    if (message.from.agent === this.config.localAgent) {
      return { handled: false };
    }

    // First-contact: if the sender didn't provide a threadId, mint one so
    // both sides can agree on an identifier. Previously missing threadIds
    // caused us to drop the message entirely (`handled: false`), which
    // looked fine to the sender (HTTP 200) but silently abandoned the
    // message on the recipient side.
    if (!message.threadId) {
      const mintedThreadId = crypto.randomUUID();
      console.log(`[ThreadlineRouter] Minted new threadId ${mintedThreadId} for first-contact message from ${message.from.agent} (id: ${message.id})`);
      message.threadId = mintedThreadId;
    }

    const threadId = message.threadId;

    // Prevent concurrent spawns for the same thread
    if (this.pendingSpawns.has(threadId)) {
      return {
        handled: true,
        threadId,
        error: 'Spawn already in progress for this thread',
      };
    }

    try {
      this.pendingSpawns.add(threadId);

      // Phase 2: Check the autonomy gate before processing
      if (this.autonomyGate) {
        const gateResult = await this.autonomyGate.evaluate(envelope);

        switch (gateResult.decision) {
          case 'block':
            return {
              handled: true,
              threadId,
              gateDecision: 'block',
              error: `Blocked by autonomy gate: ${gateResult.reason}`,
            };

          case 'queue-for-approval':
            return {
              handled: true,
              threadId,
              gateDecision: 'queue-for-approval',
              approvalId: gateResult.approvalId,
            };

          case 'notify-and-deliver':
          case 'deliver':
            // Continue with normal spawn/resume flow
            break;
        }
      }

      // Check for existing resume entry
      const existingEntry = this.threadResumeMap.get(threadId);

      // PR-4: If we have a live-session delivery path AND the thread has a
      // resume entry pointing at a sessionName that is currently alive, try
      // to inject the message directly into the running session instead of
      // spawning a fresh Claude process. Fall through to resume/spawn on
      // failure.
      if (existingEntry && this.messageDelivery) {
        const injected = await this.tryInjectIntoLiveSession(threadId, existingEntry, envelope);
        if (injected) return injected;
      }

      if (existingEntry) {
        return await this.resumeThread(threadId, existingEntry, envelope, relayContext);
      } else {
        return await this.spawnNewThread(threadId, envelope, relayContext);
      }
    } catch (err) {
      console.error(`[ThreadlineRouter] Error handling inbound message for thread ${threadId}:`, err);
      return {
        handled: true,
        threadId,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    } finally {
      this.pendingSpawns.delete(threadId);
    }
  }

  /**
   * Notify the router that a thread's session has ended.
   * Persists the UUID back to ThreadResumeMap for future resume.
   */
  onSessionEnd(threadId: string, uuid: string, sessionName: string): void {
    const entry = this.threadResumeMap.get(threadId);
    if (!entry) return;

    // Update the entry with the latest UUID and mark as idle
    this.threadResumeMap.save(threadId, {
      ...entry,
      uuid,
      sessionName,
      state: 'idle',
      lastAccessedAt: new Date().toISOString(),
    });
  }

  /**
   * Notify the router that a thread has been resolved (conversation complete).
   *
   * Emits a `thread-closed` ledger event wrapped in try/finally so the ledger
   * emitter fires even if the resolve() call itself throws. Signal-only.
   */
  onThreadResolved(threadId: string): void {
    const entry = this.threadResumeMap.get(threadId);
    try {
      this.threadResumeMap.resolve(threadId);
    } finally {
      this.emitLedger({
        kind: 'thread-closed',
        threadId,
        remoteAgent: entry?.remoteAgent ?? 'unknown',
        subject: entry?.subject ?? '(unknown)',
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Notify the router that a thread has failed (unrecoverable error).
   */
  onThreadFailed(threadId: string): void {
    const entry = this.threadResumeMap.get(threadId);
    if (!entry) return;

    this.threadResumeMap.save(threadId, {
      ...entry,
      state: 'failed',
      lastAccessedAt: new Date().toISOString(),
    });
  }

  // ── Private: Resume an existing thread ──────────────────────

  private async resumeThread(
    threadId: string,
    entry: ThreadResumeEntry,
    envelope: MessageEnvelope,
    relayContext?: RelayMessageContext,
  ): Promise<ThreadlineHandleResult> {
    const { message } = envelope;

    // Build history context (trust-level-aware depth for relay)
    const maxHistory = relayContext
      ? RELAY_HISTORY_LIMITS[relayContext.trustLevel]
      : this.config.maxHistoryMessages;
    const historyContext = await this.buildHistoryContext(threadId, maxHistory);

    // Build the resume prompt (with grounding preamble if relay)
    const prompt = this.buildPrompt(
      message,
      threadId,
      entry.subject,
      entry.messageCount,
      entry.remoteAgent,
      historyContext,
      relayContext,
    );

    // Spawn with resume UUID
    const spawnResult = await this.spawnManager.evaluate({
      requester: message.from,
      target: { agent: this.config.localAgent, machine: this.config.localMachine },
      reason: `Resume thread ${threadId} with ${entry.remoteAgent}`,
      context: prompt,
      priority: message.priority === 'critical' ? 'critical' : 'medium',
      pendingMessages: [message.id],
    });

    if (!spawnResult.approved) {
      this.spawnManager.handleDenial(
        {
          requester: message.from,
          target: { agent: this.config.localAgent, machine: this.config.localMachine },
          reason: `Resume thread ${threadId}`,
          priority: message.priority === 'critical' ? 'critical' : 'medium',
        },
        spawnResult,
      );

      return {
        handled: true,
        threadId,
        error: `Spawn denied: ${spawnResult.reason}`,
      };
    }

    // Update the resume map entry
    this.threadResumeMap.save(threadId, {
      ...entry,
      state: 'active',
      lastAccessedAt: new Date().toISOString(),
      messageCount: entry.messageCount + 1,
      sessionName: spawnResult.tmuxSession || entry.sessionName,
    });

    return {
      handled: true,
      threadId,
      resumed: true,
      sessionName: spawnResult.tmuxSession || entry.sessionName,
    };
  }

  // ── Private: Spawn a new thread session ─────────────────────

  private async spawnNewThread(
    threadId: string,
    envelope: MessageEnvelope,
    relayContext?: RelayMessageContext,
  ): Promise<ThreadlineHandleResult> {
    const { message } = envelope;

    // Build history context (may be empty for brand new threads)
    const maxHistory = relayContext
      ? RELAY_HISTORY_LIMITS[relayContext.trustLevel]
      : this.config.maxHistoryMessages;
    const historyContext = await this.buildHistoryContext(threadId, maxHistory);

    // Build the spawn prompt (with grounding preamble if relay)
    const prompt = this.buildPrompt(
      message,
      threadId,
      message.subject,
      1,
      message.from.agent,
      historyContext,
      relayContext,
    );

    // Request spawn
    const spawnResult = await this.spawnManager.evaluate({
      requester: message.from,
      target: { agent: this.config.localAgent, machine: this.config.localMachine },
      reason: `New thread from ${message.from.agent}: ${message.subject}`,
      context: prompt,
      priority: message.priority === 'critical' ? 'critical' : 'medium',
      pendingMessages: [message.id],
    });

    if (!spawnResult.approved) {
      this.spawnManager.handleDenial(
        {
          requester: message.from,
          target: { agent: this.config.localAgent, machine: this.config.localMachine },
          reason: `New thread from ${message.from.agent}`,
          priority: message.priority === 'critical' ? 'critical' : 'medium',
        },
        spawnResult,
      );

      return {
        handled: true,
        threadId,
        error: `Spawn denied: ${spawnResult.reason}`,
      };
    }

    // Create the thread resume entry
    const now = new Date().toISOString();
    const newEntry: ThreadResumeEntry = {
      uuid: spawnResult.sessionId || crypto.randomUUID(),
      sessionName: spawnResult.tmuxSession || `thread-${threadId.slice(0, 8)}`,
      createdAt: now,
      savedAt: now,
      lastAccessedAt: now,
      remoteAgent: message.from.agent,
      subject: message.subject,
      state: 'active',
      pinned: false,
      messageCount: 1,
    };

    this.threadResumeMap.save(threadId, newEntry);

    // Integrated-Being: emit thread-opened ledger event (signal-only).
    this.emitLedger({
      kind: 'thread-opened',
      threadId,
      remoteAgent: message.from.agent,
      subject: message.subject,
      timestamp: new Date().toISOString(),
    });

    return {
      handled: true,
      threadId,
      spawned: true,
      sessionName: newEntry.sessionName,
    };
  }

  // ── Private: Inject into live session (PR-4) ────────────────

  /**
   * Attempt to deliver an inbound message directly into an already-running
   * session for this thread, avoiding the spawn/resume path entirely.
   * Returns a successful ThreadlineHandleResult on success, or null to
   * signal the caller should fall back to resume/spawn.
   */
  private async tryInjectIntoLiveSession(
    threadId: string,
    entry: ThreadResumeEntry,
    envelope: MessageEnvelope,
  ): Promise<ThreadlineHandleResult | null> {
    if (!this.messageDelivery) return null;
    if (!entry.sessionName) return null;

    try {
      const result = await this.messageDelivery.deliverToSession(entry.sessionName, envelope);
      if (!result.success) {
        console.log(`[ThreadlineRouter] Live-session injection failed for thread ${threadId} (${entry.sessionName}): ${result.failureReason}. Falling back to resume/spawn.`);
        return null;
      }

      // Injection succeeded — update the resume map entry
      this.threadResumeMap.save(threadId, {
        ...entry,
        state: 'active',
        lastAccessedAt: new Date().toISOString(),
        messageCount: entry.messageCount + 1,
      });

      console.log(`[ThreadlineRouter] Injected message into live session ${entry.sessionName} for thread ${threadId}`);
      return {
        handled: true,
        threadId,
        injected: true,
        sessionName: entry.sessionName,
      };
    } catch (err) {
      console.warn(`[ThreadlineRouter] Live-session injection threw for thread ${threadId}:`, err);
      return null;
    }
  }

  // ── Private: Build thread history context ───────────────────

  private async buildHistoryContext(threadId: string, maxMessages?: number): Promise<string> {
    try {
      const limit = maxMessages ?? this.config.maxHistoryMessages;
      if (limit <= 0) return '';

      // Fetch thread info from the messaging system's thread store
      const threadData = await this.messageRouter.getThread(threadId);
      if (!threadData || threadData.messages.length === 0) {
        return '';
      }

      // Take the last N messages for context
      const recentMessages = threadData.messages
        .slice(-limit)
        .map((env, i) => {
          const msg = env.message;
          return `[${i + 1}] ${msg.from.agent} (${msg.createdAt}):\n${msg.body}`;
        })
        .join('\n\n');

      return `Recent thread history (${Math.min(threadData.messages.length, limit)} of ${threadData.messages.length} messages):\n${recentMessages}`;
    } catch {
      // @silent-fallback-ok — thread history is supplementary context; missing it degrades but doesn't break
      return '';
    }
  }

  // ── Private: Build spawn/resume prompt ──────────────────────

  private buildPrompt(
    latestMessage: AgentMessage,
    threadId: string,
    subject: string,
    messageCount: number,
    remoteAgent: string,
    historyContext: string,
    relayContext?: RelayMessageContext,
  ): string {
    const historySection = historyContext
      ? `${historyContext}\n`
      : 'No previous history available.\n';

    const basePrompt = THREAD_SPAWN_PROMPT_TEMPLATE
      .replaceAll('{remote_agent}', remoteAgent)
      .replaceAll('{thread_id}', threadId)
      .replaceAll('{subject}', subject)
      .replaceAll('{message_count}', String(messageCount))
      .replaceAll('{history_section}', historySection)
      .replaceAll('{latest_subject}', latestMessage.subject)
      .replaceAll('{latest_body}', latestMessage.body);

    // If relay context is present, wrap with grounding preamble
    if (relayContext) {
      const grounding = buildRelayGroundingPreamble({
        agentName: this.config.localAgent,
        senderName: relayContext.senderName,
        senderFingerprint: relayContext.senderFingerprint,
        trustLevel: relayContext.trustLevel,
        trustSource: relayContext.trustSource,
        trustDate: relayContext.trustDate,
        originFingerprint: relayContext.originFingerprint,
        originName: relayContext.originName,
      });

      return `${grounding.header}\n\n${basePrompt}\n\n${grounding.footer}`;
    }

    return basePrompt;
  }
}
