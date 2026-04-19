/**
 * DeliveryRetryManager — handles retry, watchdog, and TTL expiry for message delivery.
 *
 * Three responsibilities:
 * 1. Retry delivery for queued messages (Layer 2 retry with exponential backoff)
 * 2. Post-injection watchdog: after tmux injection, verify session is still alive
 * 3. TTL expiry: move expired messages to dead-letter, escalate critical/alert to Telegram
 *
 * Per spec Phase 3: Layer 1 retry (server unreachable) uses exponential backoff
 * with max 4-hour retry window. Layer 2 retry (session unavailable) retries
 * every 30s for up to 5 minutes. Layer 3 timeout varies by message type.
 */

import type {
  MessageEnvelope,
  MessageType,
  DeliveryPhase,
  MessagingStats,
} from './types.js';
import type { MessageStore } from './MessageStore.js';
import type { MessageDelivery } from './MessageDelivery.js';

/** Layer 3 ACK timeout by message type (in minutes). null = no timeout (fire-and-forget) */
const ACK_TIMEOUT: Record<MessageType, number | null> = {
  info: null,
  sync: null,
  alert: null,
  request: 10,
  query: 5,
  response: null,
  handoff: null,
  wellness: 2,
  system: null,
};

/** Layer 1 retry backoff schedule (seconds). Doubles after each attempt. */
const LAYER1_BACKOFF_BASE_MS = 5_000;
const LAYER1_MAX_INTERVAL_MS = 30 * 60_000; // 30 minutes
const LAYER1_MAX_WINDOW_MS = 4 * 60 * 60_000; // 4 hours

/** Layer 2 retry interval */
const LAYER2_RETRY_INTERVAL_MS = 30_000; // 30 seconds
const LAYER2_MAX_RETRIES = 10; // 5 minutes total

/** How often the manager runs its tick */
const TICK_INTERVAL_MS = 15_000; // 15 seconds

export interface DeliveryRetryManagerConfig {
  /** Agent name for filtering messages */
  agentName: string;
  /** Callback for escalation (e.g., send to Telegram) */
  onEscalate?: (envelope: MessageEnvelope, reason: string) => void;
}

export class DeliveryRetryManager {
  private readonly store: MessageStore;
  private readonly delivery: MessageDelivery;
  private readonly config: DeliveryRetryManagerConfig;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Track watchdog targets: messageId → injection timestamp */
  private readonly watchdogTargets = new Map<string, number>();

  /** Track retry state: messageId → { attempts, firstAttemptAt } */
  private readonly retryState = new Map<string, { attempts: number; firstAttemptAt: number; lastAttemptAt: number }>();

  constructor(store: MessageStore, delivery: MessageDelivery, config: DeliveryRetryManagerConfig) {
    this.store = store;
    this.delivery = delivery;
    this.config = config;
  }

  /** Start the periodic tick */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  /** Stop the periodic tick */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.watchdogTargets.clear();
    this.retryState.clear();
  }

  /** Register a message for post-injection watchdog monitoring */
  registerWatchdog(messageId: string): void {
    this.watchdogTargets.set(messageId, Date.now());
  }

  /** Main tick — runs every 15 seconds */
  async tick(): Promise<{ retried: number; expired: number; escalated: number }> {
    let retried = 0;
    let expired = 0;
    let escalated = 0;

    const inbox = await this.store.queryInbox(this.config.agentName);

    for (const envelope of inbox) {
      const phase = envelope.delivery.phase;
      const messageId = envelope.message.id;

      // ── TTL Expiry Check ──────────────────────────────────
      if (this.isExpired(envelope)) {
        if (phase !== 'read' && phase !== 'dead-lettered' && phase !== 'failed' && phase !== 'expired') {
          await this.store.deadLetter(messageId, 'TTL expired');
          expired++;

          // Escalate critical/alert to callback
          const priority = envelope.message.priority;
          const type = envelope.message.type;
          if ((priority === 'critical' || type === 'alert') && this.config.onEscalate) {
            this.config.onEscalate(envelope, `Message expired without delivery (type=${type}, priority=${priority})`);
            escalated++;
          }
        }
        continue;
      }

      // ── Layer 2 Retry: queued or undelivered messages ─────
      // 'undelivered' is entered by SpawnRequestManager.dispose() handoff.
      // It participates in Layer-2 retry identically to 'queued'.
      if (phase === 'queued' || phase === 'undelivered') {
        const state = this.retryState.get(messageId) ?? {
          attempts: 0,
          firstAttemptAt: Date.now(),
          lastAttemptAt: 0,
        };

        if (state.attempts >= LAYER2_MAX_RETRIES) {
          // Max retries exceeded — expire
          await this.store.deadLetter(messageId, `Layer 2 max retries exceeded (${LAYER2_MAX_RETRIES})`);
          expired++;
          this.retryState.delete(messageId);
          continue;
        }

        const timeSinceLastAttempt = Date.now() - state.lastAttemptAt;
        if (timeSinceLastAttempt < LAYER2_RETRY_INTERVAL_MS) {
          continue; // Not yet time to retry
        }

        // Attempt redelivery
        const targetSession = envelope.message.to.session;
        const result = await this.delivery.deliverToSession(targetSession, envelope);

        state.attempts++;
        state.lastAttemptAt = Date.now();
        this.retryState.set(messageId, state);

        if (result.success) {
          const fromPhase = phase;
          envelope.delivery.phase = 'delivered';
          envelope.delivery.transitions.push({
            from: fromPhase,
            to: 'delivered',
            at: new Date().toISOString(),
            reason: `Retry attempt ${state.attempts}`,
          });
          envelope.delivery.attempts = state.attempts;
          await this.store.updateEnvelope(envelope);
          // Keep retryState so interval is respected if watchdog regresses to queued
          this.registerWatchdog(messageId);
          retried++;
        }
      }

      // ── Layer 3 Timeout: unacknowledged delivered messages ─
      if (phase === 'delivered') {
        const timeout = ACK_TIMEOUT[envelope.message.type];
        if (timeout !== null) {
          const deliveredAt = envelope.delivery.transitions
            .filter(t => t.to === 'delivered')
            .pop()?.at;
          if (deliveredAt) {
            const elapsed = Date.now() - new Date(deliveredAt).getTime();
            if (elapsed > timeout * 60_000) {
              // ACK timeout — escalate
              if (this.config.onEscalate) {
                this.config.onEscalate(
                  envelope,
                  `Layer 3 ACK timeout: ${envelope.message.type} message not acknowledged after ${timeout} minutes`,
                );
                escalated++;
              }
              // Mark as expired
              envelope.delivery.phase = 'expired';
              envelope.delivery.transitions.push({
                from: 'delivered',
                to: 'expired',
                at: new Date().toISOString(),
                reason: `ACK timeout (${timeout}min) for type=${envelope.message.type}`,
              });
              await this.store.updateEnvelope(envelope);
              expired++;
            }
          }
        }
      }
    }

    // ── Watchdog: check injected messages ──────────────────
    for (const [messageId, injectedAt] of this.watchdogTargets) {
      const elapsed = Date.now() - injectedAt;
      if (elapsed < 10_000) continue; // Wait 10 seconds

      // Watchdog window has passed — check if session is still alive
      const envelope = await this.store.get(messageId);
      if (!envelope || envelope.delivery.phase !== 'delivered') {
        this.watchdogTargets.delete(messageId);
        continue;
      }

      const targetSession = envelope.message.to.session;
      const safety = await this.delivery.checkInjectionSafety(targetSession);

      // If session process changed to something unsafe (crash/restart),
      // regress to queued for retry
      if (!safety.isSafeProcess) {
        envelope.delivery.phase = 'queued';
        envelope.delivery.transitions.push({
          from: 'delivered',
          to: 'queued',
          at: new Date().toISOString(),
          reason: `Watchdog: session process changed to ${safety.foregroundProcess}`,
        });
        await this.store.updateEnvelope(envelope);
      } else {
        // Session healthy — delivery confirmed, clean up retry state
        this.retryState.delete(messageId);
      }

      this.watchdogTargets.delete(messageId);
    }

    return { retried, expired, escalated };
  }

  /** Check if a message's delivery TTL has expired */
  private isExpired(envelope: MessageEnvelope): boolean {
    const createdAt = new Date(envelope.message.createdAt).getTime();
    const ttlMs = envelope.message.ttlMinutes * 60_000;
    return Date.now() > createdAt + ttlMs;
  }
}
