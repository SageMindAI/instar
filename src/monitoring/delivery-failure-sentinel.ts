/**
 * DeliveryFailureSentinel — Layer 3 of telegram-delivery-robustness.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § 4 Layer 3.
 *
 * Reads the SQLite queue created by Layer 2 (`pending-relay-store`),
 * runs the recovery state machine, and is feature-flag-gated default-OFF.
 *
 * State machine (per row):
 *
 *   queued ──claim──► claimed ──/whoami──► (mismatch → retry)
 *                                  │
 *                                  └──tone-gate──► (422 → delivered-tone-gated)
 *                                          │
 *                                          └──/telegram/reply──► (200 → delivered-recovered
 *                                                                  408 → delivered-ambiguous
 *                                                                  5xx/conn-refused → retry)
 *                                          │
 *                                          └──ttl/attempts exhausted ──► escalated
 *
 * The sentinel never overrides the tone-gate authority (§5 signal-vs-
 * authority compliance). On 422 it finalizes the entry as
 * `delivered-tone-gated` and emits the fixed-template meta-notice on the
 * original topic.
 *
 * Lifecycle: `start()` registers the watchdog tick + (when wsManager is
 * provided) an SSE handler for `delivery_failed` events. `stop()` clears
 * timers and detaches from the event stream. `tick()` is exposed for
 * tests so the recovery loop can be driven without waiting for the
 * 5-minute backstop interval.
 *
 * **Default-OFF.** The constructor enforces nothing; the AgentServer
 * gates instantiation on `config.monitoring.deliveryFailureSentinel.enabled`.
 * Layer 1 + Layer 2 ship unconditionally; Layer 3 is opt-in until the
 * canary criteria in spec § 3i are met.
 */

import { EventEmitter } from 'node:events';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { PendingRelayStore, PendingRelayRow } from '../messaging/pending-relay-store.js';
import { evaluatePolicy, reasonToCategory, MAX_ATTEMPTS, TTL_MS } from './delivery-failure-sentinel/recovery-policy.js';
import type { PolicyDecision } from './delivery-failure-sentinel/recovery-policy.js';
import { WhoamiCache } from '../messaging/whoami-cache.js';
import type { MessagingToneGate } from '../core/MessagingToneGate.js';
import { checkToneLocally } from '../messaging/local-tone-check.js';
import {
  TEMPLATES,
  renderEscalation,
  renderStampedeDigest,
  renderRecoveredMarker,
  verifyTemplateIntegrity,
} from '../messaging/system-templates.js';
import { redact } from '../messaging/secret-patterns.js';
import { DegradationReporter } from './DegradationReporter.js';

// ── Configuration ────────────────────────────────────────────────────

export interface SentinelConfig {
  /** Backstop watchdog tick interval. Default 5 minutes (spec §3a). */
  watchdogIntervalMs?: number;
  /** Per-entry lease duration. Default 90s (spec §3b). */
  leaseDurationMs?: number;
  /** Per-topic delivery rate cap. Default 30s (spec §3c). */
  perTopicRateMs?: number;
  /** Max parallel cross-topic recoveries. Default 4 (spec §3c). */
  maxConcurrent?: number;
  /** Stampede threshold — entries on same topic before digest fires. Default 5 (spec §3c). */
  stampedeThreshold?: number;
  /**
   * Circuit breaker — N consecutive escalation failures within window
   * trips the breaker. Defaults: N=5, window=1h (spec §3f).
   */
  circuitBreakerCount?: number;
  circuitBreakerWindowMs?: number;
  /**
   * Restore-purge threshold — entries older than this at startup are
   * dropped, not recovered (spec §3h). Default 5 minutes.
   */
  restorePurgeAgeMs?: number;
}

export interface SentinelDeps {
  store: PendingRelayStore;
  /** Path to .instar/config.json — used for whoami-cache mtime invalidation. */
  configPath: string;
  /** Live config accessor — re-read on every tick (spec §3d step 1). */
  readConfig: () => { port: number; authToken: string; agentId: string };
  /** This server's bootId (spec §3b). Required — sentinel exits if absent. */
  bootId: string;
  /** Tone gate authority for §3d step 3. Null = no gate configured. */
  toneGate: MessagingToneGate | null;
  /**
   * Subscribe to in-process `delivery_failed` events. Returns an
   * unsubscribe handle. The wsManager fan-out emits these events; the
   * sentinel reacts in <1s rather than waiting for the 5-min watchdog.
   */
  subscribeFailureEvents?: (
    listener: (event: { delivery_id: string; topic_id: number; agentId: string }) => void,
  ) => () => void;
  /** Override clock (tests). */
  now?: () => number;
  /** Override fetch (tests). Default uses node:http to localhost. */
  postReply?: (
    port: number,
    token: string,
    agentId: string,
    topicId: number,
    text: string,
    deliveryId: string,
    isSystem?: boolean,
  ) => Promise<{ status: number; body: string }>;
  /** Whoami cache — defaults to a fresh instance with default deps. */
  whoamiCache?: WhoamiCache;
}

const DEFAULTS: Required<SentinelConfig> = {
  watchdogIntervalMs: 5 * 60 * 1000,
  leaseDurationMs: 90 * 1000,
  perTopicRateMs: 30 * 1000,
  maxConcurrent: 4,
  stampedeThreshold: 5,
  circuitBreakerCount: 5,
  circuitBreakerWindowMs: 60 * 60 * 1000,
  restorePurgeAgeMs: 5 * 60 * 1000,
};

// ── Sentinel ─────────────────────────────────────────────────────────

export interface SentinelEvents {
  'sentinel:started': [];
  'sentinel:stopped': [];
  'sentinel:tick-complete': [{ processed: number; recovered: number; escalated: number }];
  'sentinel:recovered': [{ delivery_id: string; topic_id: number }];
  'sentinel:tone-gated': [{ delivery_id: string; topic_id: number; rule?: string }];
  'sentinel:escalated': [{ delivery_id: string; topic_id: number; category: string }];
  'sentinel:circuit-breaker-tripped': [{ consecutiveFailures: number }];
  'sentinel:circuit-breaker-resumed': [];
}

export class DeliveryFailureSentinel extends EventEmitter {
  private readonly cfg: Required<SentinelConfig>;
  private readonly deps: Required<Omit<SentinelDeps, 'subscribeFailureEvents'>> & {
    subscribeFailureEvents?: SentinelDeps['subscribeFailureEvents'];
  };
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private running = false;
  private suspended = false;
  private escalationFailures: number[] = []; // ms timestamps
  private inFlight = 0;
  private lastTopicDelivery = new Map<number, number>(); // topic → last delivered ms
  /** Templates verified at start(). False disables escalation path. */
  private templatesValid = true;
  /** Restored on first start(); used to keep restore-purge a one-shot. */
  private restorePurged = false;

  constructor(deps: SentinelDeps, config: SentinelConfig = {}) {
    super();
    this.cfg = {
      watchdogIntervalMs: config.watchdogIntervalMs ?? DEFAULTS.watchdogIntervalMs,
      leaseDurationMs: config.leaseDurationMs ?? DEFAULTS.leaseDurationMs,
      perTopicRateMs: config.perTopicRateMs ?? DEFAULTS.perTopicRateMs,
      maxConcurrent: config.maxConcurrent ?? DEFAULTS.maxConcurrent,
      stampedeThreshold: config.stampedeThreshold ?? DEFAULTS.stampedeThreshold,
      circuitBreakerCount: config.circuitBreakerCount ?? DEFAULTS.circuitBreakerCount,
      circuitBreakerWindowMs: config.circuitBreakerWindowMs ?? DEFAULTS.circuitBreakerWindowMs,
      restorePurgeAgeMs: config.restorePurgeAgeMs ?? DEFAULTS.restorePurgeAgeMs,
    };
    this.deps = {
      store: deps.store,
      configPath: deps.configPath,
      readConfig: deps.readConfig,
      bootId: deps.bootId,
      toneGate: deps.toneGate,
      subscribeFailureEvents: deps.subscribeFailureEvents,
      now: deps.now ?? (() => Date.now()),
      postReply: deps.postReply ?? defaultPostReply,
      whoamiCache: deps.whoamiCache ?? new WhoamiCache(),
    };
  }

  /**
   * Start the sentinel. Verifies template integrity, performs a one-shot
   * restore-purge of stale rows, registers the SSE listener (if available),
   * and arms the watchdog tick. Idempotent — calling start() while running
   * is a no-op.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Template integrity check (spec §3f). If templates have been
    // tampered with, disable the escalation path but keep the recovery
    // mainline running — pure 200 deliveries are safe even without
    // templates.
    const integrity = verifyTemplateIntegrity();
    if (!integrity.ok) {
      this.templatesValid = false;
      try {
        DegradationReporter.getInstance().report({
          feature: 'template-integrity-failed',
          primary: 'compiled-in system templates with build-time SHA-256',
          fallback: 'sentinel disables escalation path; recovery mainline still works',
          reason: `templates failed boot integrity check: ${integrity.mismatched.join(', ')}`,
          impact: 'Escalation messages and tone-gate-rejection notices are not sent until templates are restored.',
        });
      } catch {
        // best-effort
      }
    }

    if (!this.restorePurged) {
      try {
        this.purgeStaleRows();
      } catch (err) {
        console.warn('[delivery-sentinel] restore-purge raised:', err);
      }
      this.restorePurged = true;
    }

    if (this.deps.subscribeFailureEvents) {
      this.unsubscribe = this.deps.subscribeFailureEvents((event) => {
        // Best-effort: kick a tick when a delivery_failed event arrives.
        // We don't await; the tick runs async and emits its own events.
        this.tick().catch((err) => {
          console.warn('[delivery-sentinel] event-driven tick failed:', err);
        });
      });
    }

    this.watchdog = setInterval(() => {
      this.tick().catch((err) => {
        console.warn('[delivery-sentinel] watchdog tick failed:', err);
      });
    }, this.cfg.watchdogIntervalMs);
    // Don't keep the process alive just for this timer.
    if (typeof this.watchdog.unref === 'function') {
      this.watchdog.unref();
    }

    this.emit('sentinel:started');
  }

  /** Stop the sentinel, clearing the watchdog and detaching listeners. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    if (this.unsubscribe) {
      try {
        this.unsubscribe();
      } catch {
        // best-effort
      }
      this.unsubscribe = null;
    }
    this.emit('sentinel:stopped');
  }

  /** True iff the sentinel's circuit breaker is currently tripped. */
  isSuspended(): boolean {
    return this.suspended;
  }

  /**
   * Run one recovery tick. Public so tests can drive recovery without
   * waiting for the watchdog interval.
   *
   * Returns aggregate counters useful for assertions.
   */
  async tick(): Promise<{ processed: number; recovered: number; escalated: number }> {
    if (!this.running) {
      return { processed: 0, recovered: 0, escalated: 0 };
    }
    if (this.suspended) {
      this.maybeResume();
      if (this.suspended) {
        return { processed: 0, recovered: 0, escalated: 0 };
      }
    }

    const counters = { processed: 0, recovered: 0, escalated: 0 };

    // Pull rows that are ready (queued, or claimed-but-stale).
    const candidates = this.selectClaimable();
    if (candidates.length === 0) {
      this.emit('sentinel:tick-complete', counters);
      return counters;
    }

    // Stampede summarization (spec §3c). When a single topic has more
    // than N entries, pick the most recent and drop the rest with a
    // single digest message.
    const grouped = groupByTopic(candidates);
    const toProcess: PendingRelayRow[] = [];
    for (const [topicId, rows] of grouped.entries()) {
      if (rows.length > this.cfg.stampedeThreshold) {
        await this.handleStampede(topicId, rows);
        toProcess.push(rows[rows.length - 1]); // most recent
        continue;
      }
      // Per-topic rate cap: ≤1 delivery per topic per perTopicRateMs.
      // Drop all but the oldest queued row for this topic on this tick.
      const last = this.lastTopicDelivery.get(topicId) ?? 0;
      if (this.deps.now() - last < this.cfg.perTopicRateMs) {
        continue; // skip this topic this tick
      }
      // Otherwise process all rows on this topic up to maxConcurrent
      // total — most-recent first per stampede semantics.
      toProcess.push(rows[rows.length - 1]);
      // Also queue the older ones for next tick — they'll be re-selected
      // because we don't transition them on this pass.
    }

    for (const row of toProcess) {
      if (this.inFlight >= this.cfg.maxConcurrent) break;
      counters.processed += 1;
      this.inFlight += 1;
      try {
        const outcome = await this.processRow(row);
        if (outcome === 'recovered') counters.recovered += 1;
        if (outcome === 'escalated') counters.escalated += 1;
      } finally {
        this.inFlight -= 1;
      }
    }

    this.emit('sentinel:tick-complete', counters);
    return counters;
  }

  // ── Internals ──────────────────────────────────────────────────────

  private selectClaimable(): PendingRelayRow[] {
    const nowIso = new Date(this.deps.now()).toISOString();
    try {
      const rows = this.deps.store.selectClaimable(nowIso, 100);
      // Filter claimed rows whose lease has not expired AND whose bootId matches
      // (otherwise reclaimable).
      return rows.filter((row) => {
        if (row.state !== 'claimed') return true;
        return this.isLeaseStale(row);
      });
    } catch (err) {
      console.warn('[delivery-sentinel] selectClaimable raised:', err);
      return [];
    }
  }

  private isLeaseStale(row: PendingRelayRow): boolean {
    if (!row.claimed_by) return true;
    // Format: "<bootId>:<pid>:<leaseUntilIso>"
    const parts = row.claimed_by.split(':');
    if (parts.length < 3) return true;
    const [bootId, , leaseUntilIso] = [parts[0], parts[1], parts.slice(2).join(':')];
    if (bootId !== this.deps.bootId) return true;
    const lease = Date.parse(leaseUntilIso);
    if (Number.isNaN(lease)) return true;
    return lease < this.deps.now();
  }

  private async processRow(row: PendingRelayRow): Promise<'recovered' | 'escalated' | 'tone-gated' | 'retry' | 'ambiguous'> {
    // Claim the row — write the lease.
    const leaseUntil = new Date(this.deps.now() + this.cfg.leaseDurationMs).toISOString();
    const claimedBy = `${this.deps.bootId}:${process.pid}:${leaseUntil}`;
    const claimed = this.deps.store.transition(row.delivery_id, 'claimed', { claimed_by: claimedBy });
    if (!claimed) {
      // Lost the race — another instance grabbed it (shared worktree case).
      return 'retry';
    }

    // Re-resolve config — operator may have rotated port/token since enqueue.
    const cfg = this.deps.readConfig();

    // Verify identity via /whoami before any send.
    let whoami: { agentId: string; port: number };
    try {
      whoami = await this.deps.whoamiCache.get(cfg.port, cfg.authToken, this.deps.configPath, cfg.agentId);
    } catch (err) {
      // Network / auth failure → schedule next retry.
      return this.handlePolicyDecision(row, evaluatePolicy({
        httpCode: 0,
        responseBody: err instanceof Error ? err.message.slice(0, 256) : null,
        attempts: row.attempts,
        timeSinceFirstMs: this.deps.now() - Date.parse(row.attempted_at),
        now: this.deps.now,
      }));
    }
    if (whoami.agentId !== cfg.agentId) {
      return this.handlePolicyDecision(row, evaluatePolicy({
        httpCode: 403,
        responseBody: JSON.stringify({ error: 'agent_id_mismatch' }),
        attempts: row.attempts,
        timeSinceFirstMs: this.deps.now() - Date.parse(row.attempted_at),
        now: this.deps.now,
      }));
    }

    // Re-tone-gate the queued text. Apply redaction first so secrets in
    // the queued body never reach the tone gate provider (defense-in-
    // depth — they shouldn't be there in the first place, but we don't
    // want to amplify a leak by sending it to a third-party LLM).
    const text = redact(row.text.toString('utf-8'));
    const toneResult = await checkToneLocally(this.deps.toneGate, text, {
      channel: 'telegram',
    });
    if (!toneResult.passed) {
      return this.finalizeToneGated(row, toneResult.rule);
    }

    // POST /telegram/reply with the delivery-id header for server-side dedup.
    let resp: { status: number; body: string };
    try {
      resp = await this.deps.postReply(
        cfg.port,
        cfg.authToken,
        cfg.agentId,
        row.topic_id,
        text,
        row.delivery_id,
      );
    } catch (err) {
      return this.handlePolicyDecision(row, evaluatePolicy({
        httpCode: 0,
        responseBody: err instanceof Error ? err.message.slice(0, 256) : null,
        attempts: row.attempts + 1,
        timeSinceFirstMs: this.deps.now() - Date.parse(row.attempted_at),
        now: this.deps.now,
      }));
    }

    const decision = evaluatePolicy({
      httpCode: resp.status,
      responseBody: resp.body.slice(0, 1024),
      attempts: row.attempts + 1,
      timeSinceFirstMs: this.deps.now() - Date.parse(row.attempted_at),
      now: this.deps.now,
    });

    if (decision.action === 'finalize-success') {
      // Update last-delivery time for per-topic rate cap.
      this.lastTopicDelivery.set(row.topic_id, this.deps.now());
      this.deps.store.transition(row.delivery_id, 'delivered-recovered', {
        attempts: row.attempts + 1,
        http_code: resp.status,
        error_body: null,
      });
      this.emit('sentinel:recovered', { delivery_id: row.delivery_id, topic_id: row.topic_id });
      // Fire-and-forget recovered-marker follow-up (~2s later, gated on 200).
      const shortId = row.delivery_id.slice(0, 8);
      setTimeout(() => {
        const marker = renderRecoveredMarker(shortId);
        // System-template send — bypass tone gate via header. Failure
        // is logged and dropped (spec §3e), never queued.
        this.deps.postReply(cfg.port, cfg.authToken, cfg.agentId, row.topic_id, marker, row.delivery_id, true)
          .catch((err) => {
            console.warn(`[delivery-sentinel] recovered-marker send failed for ${shortId}:`, err);
          });
      }, 2000).unref();
      return 'recovered';
    }

    return this.handlePolicyDecision(row, decision, resp.status);
  }

  private async finalizeToneGated(row: PendingRelayRow, rule?: string): Promise<'tone-gated'> {
    this.deps.store.transition(row.delivery_id, 'delivered-tone-gated', {
      attempts: row.attempts + 1,
    });
    this.emit('sentinel:tone-gated', { delivery_id: row.delivery_id, topic_id: row.topic_id, rule });

    // Send the tone-gate-rejection meta-notice on the original topic.
    if (this.templatesValid) {
      try {
        const cfg = this.deps.readConfig();
        await this.deps.postReply(cfg.port, cfg.authToken, cfg.agentId, row.topic_id, TEMPLATES.toneGateRejection, row.delivery_id, true);
      } catch (err) {
        console.warn('[delivery-sentinel] tone-gate-rejection notice send failed:', err);
      }
    }
    return 'tone-gated';
  }

  private async handlePolicyDecision(
    row: PendingRelayRow,
    decision: PolicyDecision,
    httpCode?: number,
  ): Promise<'recovered' | 'escalated' | 'retry' | 'ambiguous' | 'tone-gated'> {
    switch (decision.action) {
      case 'finalize-success':
        // Handled inline in processRow.
        return 'recovered';

      case 'finalize-tone-gated':
        return this.finalizeToneGated(row);

      case 'finalize-ambiguous':
        this.deps.store.transition(row.delivery_id, 'delivered-ambiguous', {
          attempts: row.attempts + 1,
          http_code: httpCode ?? null,
        });
        return 'ambiguous';

      case 'retry':
        this.deps.store.transition(row.delivery_id, 'queued', {
          attempts: row.attempts + 1,
          next_attempt_at: decision.nextAttemptAt ?? null,
          claimed_by: null,
          http_code: httpCode ?? null,
        });
        return 'retry';

      case 'escalate':
        return this.escalate(row, decision);
    }
  }

  private async escalate(row: PendingRelayRow, decision: PolicyDecision): Promise<'escalated'> {
    const category = reasonToCategory(decision.reason);
    this.deps.store.transition(row.delivery_id, 'escalated', {
      attempts: row.attempts + 1,
    });
    this.emit('sentinel:escalated', { delivery_id: row.delivery_id, topic_id: row.topic_id, category });

    if (!this.templatesValid) {
      this.recordEscalationFailure();
      return 'escalated';
    }

    const duration = humanDuration(this.deps.now() - Date.parse(row.attempted_at));
    const shortId = row.delivery_id.slice(0, 8);
    const body = renderEscalation({ duration, category, shortId });

    const cfg = this.deps.readConfig();
    let topicSent = false;
    for (let attempt = 0; attempt < 2 && !topicSent; attempt++) {
      try {
        const r = await this.deps.postReply(cfg.port, cfg.authToken, cfg.agentId, row.topic_id, body, row.delivery_id, true);
        if (r.status >= 200 && r.status < 300) topicSent = true;
      } catch {
        // try once more
      }
    }

    if (!topicSent) {
      this.recordEscalationFailure();
    } else {
      // Successful escalation — don't count as a failure.
      this.escalationFailures = [];
    }

    return 'escalated';
  }

  private recordEscalationFailure(): void {
    const now = this.deps.now();
    this.escalationFailures.push(now);
    // Keep only failures within the window.
    const cutoff = now - this.cfg.circuitBreakerWindowMs;
    this.escalationFailures = this.escalationFailures.filter((t) => t >= cutoff);
    if (this.escalationFailures.length >= this.cfg.circuitBreakerCount && !this.suspended) {
      this.suspended = true;
      try {
        DegradationReporter.getInstance().report({
          feature: 'delivery-sentinel-suspended',
          primary: 'autonomous recovery via /telegram/reply',
          fallback: 'queue continues to grow; no retries until config rotates or operator resumes',
          reason: `circuit breaker tripped after ${this.escalationFailures.length} consecutive escalation failures within ${Math.round(this.cfg.circuitBreakerWindowMs / 60_000)}m`,
          impact: 'Recovery is paused. Operator may rotate config (auth-relevant fields: port, authToken, agentId) or run `instar sentinel resume` to attempt unsuspend.',
        });
      } catch {
        // best-effort
      }
      this.emit('sentinel:circuit-breaker-tripped', { consecutiveFailures: this.escalationFailures.length });
      this.lastConfigHash = this.computeConfigAuthHash();
    }
  }

  private lastConfigHash: string | null = null;

  private maybeResume(): void {
    // Resume if the auth-relevant config fields have changed since
    // suspension. mtime-based detection is forbidden by spec §3f
    // (forgeable, bumped by unrelated jobs); we hash port + token + agentId.
    const current = this.computeConfigAuthHash();
    if (this.lastConfigHash !== null && current !== this.lastConfigHash) {
      this.suspended = false;
      this.escalationFailures = [];
      this.emit('sentinel:circuit-breaker-resumed');
    }
  }

  private computeConfigAuthHash(): string {
    try {
      const cfg = this.deps.readConfig();
      return createHash('sha256')
        .update(`${cfg.port}\0${cfg.authToken}\0${cfg.agentId}`)
        .digest('hex');
    } catch {
      return '';
    }
  }

  /** Manual resume — used by `instar sentinel resume` CLI handler. */
  resume(): void {
    this.suspended = false;
    this.escalationFailures = [];
    this.emit('sentinel:circuit-breaker-resumed');
  }

  private async handleStampede(topicId: number, rows: PendingRelayRow[]): Promise<void> {
    const last = this.lastTopicDelivery.get(topicId) ?? 0;
    if (this.deps.now() - last < this.cfg.perTopicRateMs) return;

    if (!this.templatesValid) return;

    const cfg = this.deps.readConfig();
    const digest = renderStampedeDigest(rows.length);
    try {
      await this.deps.postReply(cfg.port, cfg.authToken, cfg.agentId, topicId, digest, rows[rows.length - 1].delivery_id, true);
      this.lastTopicDelivery.set(topicId, this.deps.now());
    } catch (err) {
      console.warn('[delivery-sentinel] stampede digest send failed:', err);
    }

    // Drop all but the latest with `delivered-ambiguous` (we don't know
    // if duplicate would have landed; dropping is intentional).
    for (let i = 0; i < rows.length - 1; i++) {
      this.deps.store.transition(rows[i].delivery_id, 'delivered-ambiguous', {});
    }
  }

  private purgeStaleRows(): void {
    const cutoff = new Date(this.deps.now() - this.cfg.restorePurgeAgeMs).toISOString();
    try {
      const deleted = this.deps.store.purgeStaleClaimable(cutoff);
      if (deleted > 0) {
        console.log(`[delivery-sentinel] restore-purged ${deleted} stale rows (older than ${this.cfg.restorePurgeAgeMs}ms)`);
      }
    } catch (err) {
      console.warn('[delivery-sentinel] purgeStaleRows raised:', err);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function groupByTopic(rows: PendingRelayRow[]): Map<number, PendingRelayRow[]> {
  const out = new Map<number, PendingRelayRow[]>();
  for (const row of rows) {
    const list = out.get(row.topic_id);
    if (list) list.push(row);
    else out.set(row.topic_id, [row]);
  }
  // Sort each topic's list by attempted_at ascending so [0] is oldest,
  // [length-1] is newest (matches spec §3c "most recent").
  for (const list of out.values()) {
    list.sort((a, b) => a.attempted_at.localeCompare(b.attempted_at));
  }
  return out;
}

function humanDuration(ms: number): string {
  if (ms < 60_000) return '<1m';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m`;
}

async function defaultPostReply(
  port: number,
  token: string,
  agentId: string,
  topicId: number,
  text: string,
  deliveryId: string,
  isSystem = false,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ text });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(payload, 'utf-8')),
      Authorization: `Bearer ${token}`,
      'X-Instar-AgentId': agentId,
      'X-Instar-DeliveryId': deliveryId,
    };
    if (isSystem) headers['X-Instar-System'] = 'true';

    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/telegram/reply/${topicId}`,
        method: 'POST',
        headers,
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('telegram-reply request timed out'));
    });
    req.write(payload);
    req.end();
  });
}

// Suppress unused warnings for path/fsp imports kept for future use.
void path;
void fsp;
