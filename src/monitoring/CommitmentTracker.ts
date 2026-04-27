/**
 * Commitment Tracker — durable promise enforcement for agent infrastructure.
 *
 * When a user asks an agent to change something, the agent says "done" — but
 * often the change doesn't stick. Sessions compact, configs revert, behavioral
 * promises get forgotten. This module closes that gap.
 *
 * Three commitment types:
 *   1. config-change  — enforced by code (auto-corrects config drift)
 *   2. behavioral     — injected into every session via hooks
 *   3. one-time-action — tracked until verified, then closed
 *
 * The CommitmentTracker runs as a server-side monitor. It does NOT depend on
 * the LLM following instructions — it enforces commitments independently.
 *
 * Lifecycle:
 *   record → verify → (auto-correct if needed) → monitor → resolve
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { LiveConfig } from '../config/LiveConfig.js';
import type { ComponentHealth } from '../core/types.js';
import { DegradationReporter } from './DegradationReporter.js';

// ── Types ─────────────────────────────────────────────────────────

export type CommitmentType = 'config-change' | 'behavioral' | 'one-time-action';
export type CommitmentStatus = 'pending' | 'verified' | 'violated' | 'expired' | 'withdrawn' | 'delivered';

export interface Commitment {
  /** Unique identifier (CMT-xxx) */
  id: string;
  /** What the user asked for, in their words */
  userRequest: string;
  /** What the agent committed to */
  agentResponse: string;
  /** Commitment type determines verification strategy */
  type: CommitmentType;
  /** Current status */
  status: CommitmentStatus;
  /** When the commitment was made */
  createdAt: string;
  /** When the commitment was last verified */
  lastVerifiedAt?: string;
  /** When the commitment was fulfilled or violated */
  resolvedAt?: string;
  /** Resolution details */
  resolution?: string;
  /** Number of consecutive successful verifications */
  verificationCount: number;
  /** Number of violations detected */
  violationCount: number;
  /** Telegram topic ID where the commitment was made */
  topicId?: number;
  /** Source: 'agent' (self-registered) or 'sentinel' (detected by LLM scanner) */
  source?: 'agent' | 'sentinel' | 'manual';

  // ── Type-specific fields ────────────────────────────────

  /** For config-change: the config path and expected value */
  configPath?: string;
  configExpectedValue?: unknown;

  /** For behavioral: the rule text injected into sessions */
  behavioralRule?: string;
  /** For behavioral/one-time: when this commitment expires (null = forever) */
  expiresAt?: string;

  /** For one-time-action: verification method */
  verificationMethod?: 'config-value' | 'file-exists' | 'manual';
  /** For one-time-action with file-exists: the path to check */
  verificationPath?: string;

  // ── Self-healing tracking ─────────────────────────────

  /** Number of times auto-correction has fired for this commitment */
  correctionCount: number;
  /** Timestamps of recent corrections (for pattern detection) */
  correctionHistory: string[];
  /** Whether this commitment has been escalated as a potential bug */
  escalated: boolean;
  /** Escalation details */
  escalationDetail?: string;

  // ── Concurrency ───────────────────────────────────────

  /**
   * Monotonically-increasing version for optimistic CAS in mutate().
   * Back-filled to 0 on records from store v1.
   */
  version: number;

  // ── Promise Beacon (Phase 1 — PROMISE-BEACON-SPEC.md) ──
  /** When set, this commitment is watched by PromiseBeacon. Requires topicId. */
  beaconEnabled?: boolean;
  /** Heartbeat cadence in ms. Server clamps to [60_000, 21_600_000]. */
  cadenceMs?: number;
  /**
   * Soft "I'll check in by X" marker. Past it, one atRisk notice is emitted
   * and cadence continues (see Round 3 clarification #4).
   */
  nextUpdateDueAt?: string;
  /** Soft deadline — past it, cadence doubles (no terminal transition). */
  softDeadlineAt?: string;
  /** Hard deadline — past it, commitment transitions to `expired`. */
  hardDeadlineAt?: string;
  /** Last heartbeat emission (ISO). */
  lastHeartbeatAt?: string;
  /** Count of heartbeats emitted so far. */
  heartbeatCount?: number;
  /**
   * Claude Code session UUID at declaration. On mismatch, commitment is
   * violated with reason `"session-lost"` (Round 3 #3).
   */
  sessionEpoch?: string;
  /**
   * Non-terminal flag — Tier-3 "stalled" verdicts set this; still heartbeating
   * with a softer tone. Only corroborated signals transition to `violated`.
   */
  atRisk?: boolean;
  /**
   * Non-terminal flag — boot-cap / daily-spend-cap suppression. Status stays
   * `pending`, no heartbeats fire (Round 3 #2).
   */
  beaconSuppressed?: boolean;
  /** Reason accompanying `beaconSuppressed`. */
  beaconSuppressionReason?: string;
  /** SHA-256 of the last tmux snapshot used for a heartbeat. */
  lastSnapshotHash?: string;
  /** Machine owning the beacon for this commitment. */
  ownerMachineId?: string;
  /** Provenance of the beacon-enabling mutation. */
  beaconCreatedBySource?: 'skill' | 'api-loopback' | 'sentinel' | 'manual';
  /** Idempotency key for skill retries. */
  externalKey?: string;
  /** Verified delivery message id (set by POST /commitments/:id/deliver). */
  deliveryMessageId?: string;
}

export interface CommitmentStore {
  version: 2;
  commitments: Commitment[];
  lastModified: string;
}

export interface CommitmentVerificationReport {
  timestamp: string;
  active: number;
  verified: number;
  violated: number;
  pending: number;
  violations: Array<{
    id: string;
    userRequest: string;
    detail: string;
    autoCorrected: boolean;
  }>;
}

export interface CommitmentTrackerConfig {
  stateDir: string;
  liveConfig: LiveConfig;
  /** Check interval in ms. Default: 60_000 (1 minute) */
  checkIntervalMs?: number;
  /** Callback when a violation is detected */
  onViolation?: (commitment: Commitment, detail: string) => void;
  /** Callback when a commitment is verified for the first time */
  onVerified?: (commitment: Commitment) => void;
  /** Callback when repeated corrections suggest a bug. */
  onEscalation?: (commitment: Commitment, detail: string) => void;
  /** Number of corrections within the window that triggers escalation. Default: 3 */
  escalationThreshold?: number;
  /** Time window for counting corrections (ms). Default: 3_600_000 (1 hour) */
  escalationWindowMs?: number;
}

// ── Implementation ────────────────────────────────────────────────

/** Max depth of the per-id mutate queue. Enqueue beyond this rejects. */
const MUTATE_QUEUE_MAX_DEPTH = 256;
/** Max CAS retries when the version drifts under an apply. */
const MUTATE_CAS_MAX_RETRIES = 5;

type MutateFn = (c: Commitment) => Commitment | Promise<Commitment>;
interface MutateQueueEntry {
  fn: MutateFn;
  resolve: (c: Commitment) => void;
  reject: (err: Error) => void;
}

export class CommitmentTracker extends EventEmitter {
  private config: CommitmentTrackerConfig;
  private store: CommitmentStore;
  private storePath: string;
  private rulesPath: string;
  private interval: ReturnType<typeof setInterval> | null = null;
  private nextId: number;

  /**
   * Single-writer FIFO queues, keyed by commitment id. Every write path
   * (record/withdraw/verifyOne/expire/auto-correct/escalate) serialises
   * through mutate(), which CAS-retries on the commitment's `version`
   * field. p99 target for the caller-supplied fn is 50ms under load.
   */
  private mutateQueues: Map<string, MutateQueueEntry[]> = new Map();
  private mutateRunning: Set<string> = new Set();

  constructor(config: CommitmentTrackerConfig) {
    super();
    this.config = config;
    this.storePath = path.join(config.stateDir, 'state', 'commitments.json');
    this.rulesPath = path.join(config.stateDir, 'state', 'commitment-rules.md');
    this.store = this.loadStore();
    this.nextId = this.computeNextId();
    this.backfillUnverifiableOneTimeActions();
  }

  /**
   * One-shot migration: any pre-existing one-time-action that is stuck
   * in `violated` with no real verification method (violationCount > 0,
   * verificationCount === 0, no verificationMethod) is retro-transitioned
   * to `delivered` with a clear resolution. This drains the ~270 noisy
   * rows that accumulated before this fix shipped. Idempotent — rows
   * already `delivered`/`withdrawn`/`expired` are skipped.
   */
  private backfillUnverifiableOneTimeActions(): void {
    let changed = 0;
    for (const c of this.store.commitments) {
      if (c.type !== 'one-time-action') continue;
      if (c.status === 'delivered' || c.status === 'withdrawn' || c.status === 'expired') continue;
      if (!CommitmentTracker.isUnverifiableOneTime(c)) continue;
      c.status = 'delivered';
      c.resolvedAt = c.resolvedAt ?? new Date().toISOString();
      c.resolution =
        c.resolution ??
        'Backfilled: no automated verification method — trusting agent acknowledgment.';
      c.version = (c.version ?? 0) + 1;
      changed++;
    }
    if (changed > 0) {
      try {
        this.saveStore();
        console.log(
          `[CommitmentTracker] Backfill: ${changed} unverifiable one-time-action(s) transitioned to delivered`,
        );
      } catch (err) {
        console.warn(
          `[CommitmentTracker] Backfill save failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  start(): void {
    if (this.interval) return;

    const intervalMs = this.config.checkIntervalMs ?? 60_000;

    // First verification after a short delay
    setTimeout(() => this.verify(), 15_000);

    this.interval = setInterval(() => this.verify(), intervalMs);
    this.interval.unref();

    const active = this.getActive().length;
    if (active > 0) {
      console.log(`[CommitmentTracker] Started (every ${Math.round(intervalMs / 1000)}s, ${active} active commitment(s))`);
    } else {
      console.log(`[CommitmentTracker] Started (every ${Math.round(intervalMs / 1000)}s, no active commitments)`);
    }
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  // ── Commitment CRUD ────────────────────────────────────────────

  /**
   * Record a new commitment. Returns the created commitment.
   */
  record(input: {
    userRequest: string;
    agentResponse: string;
    type: CommitmentType;
    topicId?: number;
    source?: 'agent' | 'sentinel' | 'manual';
    configPath?: string;
    configExpectedValue?: unknown;
    behavioralRule?: string;
    expiresAt?: string;
    verificationMethod?: 'config-value' | 'file-exists' | 'manual';
    verificationPath?: string;
    // Promise Beacon (Phase 1) — all optional & additive.
    beaconEnabled?: boolean;
    cadenceMs?: number;
    nextUpdateDueAt?: string;
    softDeadlineAt?: string;
    hardDeadlineAt?: string;
    sessionEpoch?: string;
    ownerMachineId?: string;
    externalKey?: string;
    beaconCreatedBySource?: 'skill' | 'api-loopback' | 'sentinel' | 'manual';
  }): Commitment {
    const id = `CMT-${String(this.nextId++).padStart(3, '0')}`;

    // Auto-enable PromiseBeacon on time-promise commitments. If the
    // caller didn't explicitly set beaconEnabled, sniff the agent's
    // response for a time marker like "back in 20 min" or "by EOD" —
    // when present AND a topicId is attached, opt the commitment in
    // with a conservative cadence and hard deadline. This closes the
    // "I said 'back in an hour' and went silent" gap without requiring
    // every record() call-site to plumb beacon flags.
    let autoBeaconEnabled = input.beaconEnabled;
    let autoCadenceMs = input.cadenceMs;
    let autoHardDeadlineAt = input.hardDeadlineAt;
    if (autoBeaconEnabled === undefined && input.topicId !== undefined) {
      const detected = CommitmentTracker.detectTimePromise(input.agentResponse);
      if (detected) {
        autoBeaconEnabled = true;
        autoCadenceMs = autoCadenceMs ?? detected.cadenceMs;
        autoHardDeadlineAt =
          autoHardDeadlineAt ??
          new Date(Date.now() + detected.hardDeadlineOffsetMs).toISOString();
      }
    }

    const commitment: Commitment = {
      id,
      userRequest: input.userRequest,
      agentResponse: input.agentResponse,
      type: input.type,
      status: 'pending',
      createdAt: new Date().toISOString(),
      verificationCount: 0,
      violationCount: 0,
      topicId: input.topicId,
      source: input.source ?? 'agent',
      configPath: input.configPath,
      configExpectedValue: input.configExpectedValue,
      behavioralRule: input.behavioralRule,
      expiresAt: input.expiresAt,
      verificationMethod: input.verificationMethod,
      verificationPath: input.verificationPath,
      correctionCount: 0,
      correctionHistory: [],
      escalated: false,
      version: 0,
      // Promise Beacon fields (Phase 1).
      beaconEnabled: autoBeaconEnabled,
      cadenceMs: autoCadenceMs,
      nextUpdateDueAt: input.nextUpdateDueAt,
      softDeadlineAt: input.softDeadlineAt,
      hardDeadlineAt: autoHardDeadlineAt,
      sessionEpoch: input.sessionEpoch,
      ownerMachineId: input.ownerMachineId,
      externalKey: input.externalKey,
      beaconCreatedBySource: input.beaconCreatedBySource,
      heartbeatCount: 0,
    };

    // Insert via the same discipline future writes use: under the single-
    // writer surface, initial version is 0 and future mutations CAS from there.
    this.insertNew(commitment);

    // Regenerate behavioral rules file if this is a behavioral commitment
    if (input.type === 'behavioral') {
      this.writeBehavioralRules();
    }

    console.log(`[CommitmentTracker] Recorded ${id}: "${input.userRequest}" (${input.type})`);
    this.emit('recorded', commitment);

    // Run immediate verification for config-change commitments.
    // verifyOne goes through mutateSync, which replaces the store entry
    // with a new object — return the freshest snapshot so callers see
    // the post-verification status.
    if (input.type === 'config-change') {
      this.verifyOne(id);
    }

    return this.get(id) ?? commitment;
  }

  /**
   * Withdraw a commitment (user changed their mind).
   */
  withdraw(id: string, reason: string): boolean {
    const existing = this.store.commitments.find(c => c.id === id);
    if (!existing || existing.status === 'withdrawn' || existing.status === 'expired') {
      return false;
    }

    const updated = this.mutateSync(id, c => ({
      ...c,
      status: 'withdrawn',
      resolvedAt: new Date().toISOString(),
      resolution: reason,
    }));

    if (updated.type === 'behavioral') {
      this.writeBehavioralRules();
    }

    console.log(`[CommitmentTracker] Withdrawn ${id}: ${reason}`);
    this.emit('withdrawn', updated);
    return true;
  }

  /**
   * Mark a beacon-enabled commitment as delivered (distinct from verified).
   * Per PROMISE-BEACON-SPEC.md Round 3 #18: `delivered` is terminal; no more
   * heartbeats, no more verify attempts.
   */
  deliver(id: string, deliveryMessageId?: string): Commitment | null {
    const existing = this.store.commitments.find(c => c.id === id);
    if (!existing) return null;
    // Terminal statuses reject.
    if (['verified', 'violated', 'expired', 'withdrawn', 'delivered'].includes(existing.status)) {
      return null;
    }
    const updated = this.mutateSync(id, c => ({
      ...c,
      status: 'delivered' as CommitmentStatus,
      resolvedAt: new Date().toISOString(),
      deliveryMessageId: deliveryMessageId ?? c.deliveryMessageId,
    }));
    console.log(`[CommitmentTracker] Delivered ${id}`);
    this.emit('delivered', updated);
    return updated;
  }

  /**
   * Get all active commitments (pending or verified, not expired).
   *
   * `delivered` is a terminal state for one-time-actions that have no
   * automated verification method — once transitioned, they are not
   * re-checked (Phase 1 of commitment signal-quality fix).
   */
  getActive(): Commitment[] {
    const now = new Date().toISOString();
    return this.store.commitments.filter(c => {
      if (c.status === 'withdrawn' || c.status === 'expired' || c.status === 'delivered') return false;
      if (c.expiresAt && c.expiresAt < now) return false;
      // Active = pending, verified, or violated (violated is still "active" — it needs attention)
      return c.status === 'pending' || c.status === 'verified' || c.status === 'violated';
    });
  }

  /**
   * True if a one-time-action commitment has no way to be verified
   * automatically — no verificationMethod at all, an unknown method, or
   * the `manual` method (which by design cannot self-resolve). Such
   * commitments should not keep accumulating violations on every sweep;
   * they transition to `delivered` on the first verify call.
   */
  private static isUnverifiableOneTime(c: Commitment): boolean {
    if (c.type !== 'one-time-action') return false;
    const m = c.verificationMethod;
    return m === undefined || m === null || m === 'manual';
  }

  /**
   * Sniff a commitment's agent-response text for an explicit time
   * promise — "back in 20 minutes", "in an hour", "by EOD", etc.
   * Returns a suggested beacon cadence and a hard-deadline offset when
   * a marker is found, null otherwise. Conservative by design: misses
   * are a no-op.
   *
   * Cadence heuristic: half of the promised duration, clamped to the
   * beacon's own [60_000, 21_600_000] ms range. Hard-deadline offset
   * is 3x the promised duration so a slow response isn't terminal,
   * just flagged.
   */
  static detectTimePromise(
    text: string,
  ): { cadenceMs: number; hardDeadlineOffsetMs: number } | null {
    if (!text) return null;
    const t = text.toLowerCase();

    // Explicit N-unit phrases: "back in 20 minutes", "in an hour", "in 2h".
    const numeric = t.match(
      /\b(?:back\s+)?in\s+(an?|\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|h|m|s)\b/,
    );
    if (numeric) {
      const raw = numeric[1];
      const n = raw === 'a' || raw === 'an' ? 1 : parseInt(raw, 10);
      const unit = numeric[2];
      let unitMs: number;
      if (unit === 's' || /^secs?$/.test(unit) || /^seconds?$/.test(unit)) {
        unitMs = 1000;
      } else if (unit === 'm' || /^mins?$/.test(unit) || /^minutes?$/.test(unit)) {
        unitMs = 60_000;
      } else {
        unitMs = 3_600_000; // h / hr / hour
      }
      const totalMs = n * unitMs;
      if (totalMs >= 60_000) {
        const half = Math.floor(totalMs / 2);
        const cadence = Math.max(60_000, Math.min(half, 21_600_000));
        return {
          cadenceMs: cadence,
          hardDeadlineOffsetMs: Math.min(totalMs * 3, 24 * 3_600_000),
        };
      }
    }

    // Softer markers — shorthand time promises.
    if (/\b(by\s+eod|end\s+of\s+(the\s+)?day)\b/.test(t)) {
      return { cadenceMs: 60 * 60_000, hardDeadlineOffsetMs: 12 * 3_600_000 };
    }
    if (/\b(tomorrow|by\s+morning|by\s+tomorrow)\b/.test(t)) {
      return { cadenceMs: 2 * 3_600_000, hardDeadlineOffsetMs: 24 * 3_600_000 };
    }
    if (
      /\b(i'?ll\s+(?:check\s+in|report\s+back|get\s+back|ping|update)|back\s+(?:shortly|soon|when)|shortly|soon)\b/
        .test(t)
    ) {
      return { cadenceMs: 30 * 60_000, hardDeadlineOffsetMs: 2 * 3_600_000 };
    }

    return null;
  }

  /**
   * Get all commitments (including resolved).
   */
  getAll(): Commitment[] {
    return [...this.store.commitments];
  }

  /**
   * Get a single commitment by ID.
   */
  get(id: string): Commitment | null {
    return this.store.commitments.find(c => c.id === id) ?? null;
  }

  // ── Verification ───────────────────────────────────────────────

  /**
   * Run verification on all active commitments.
   */
  verify(): CommitmentVerificationReport {
    const active = this.getActive();
    const violations: CommitmentVerificationReport['violations'] = [];
    let verified = 0;
    let pending = 0;

    // Expire old commitments first
    this.expireCommitments();

    for (const commitment of active) {
      const result = this.verifyOne(commitment.id);
      if (!result) continue;

      if (result.passed) {
        verified++;
      } else {
        // Attempt auto-correction for config-change commitments
        let autoCorrected = false;
        if (commitment.type === 'config-change' && commitment.configPath !== undefined) {
          autoCorrected = this.attemptAutoCorrection(commitment);
        }

        violations.push({
          id: commitment.id,
          userRequest: commitment.userRequest,
          detail: result.detail,
          autoCorrected,
        });
      }
    }

    pending = active.filter(c => c.status === 'pending').length;

    const report: CommitmentVerificationReport = {
      timestamp: new Date().toISOString(),
      active: active.length,
      verified,
      violated: violations.length,
      pending,
      violations,
    };

    this.emit('verification', report);
    return report;
  }

  /**
   * Verify a single commitment. Returns null if commitment not found or not active.
   */
  verifyOne(id: string): { passed: boolean; detail: string } | null {
    const commitment = this.store.commitments.find(c => c.id === id);
    if (!commitment) return null;
    if (
      commitment.status === 'withdrawn' ||
      commitment.status === 'expired' ||
      commitment.status === 'delivered'
    ) return null;

    // One-time-actions with no automated verification path cannot keep
    // being "violated" on every sweep — that's how a single commitment
    // accumulated 51,000+ violation ticks. Transition once to
    // `delivered` (terminal) with a clear resolution note, then skip.
    if (CommitmentTracker.isUnverifiableOneTime(commitment)) {
      const updated = this.mutateSync(id, c => ({
        ...c,
        status: 'delivered',
        resolvedAt: new Date().toISOString(),
        resolution:
          'No automated verification method — trusting agent acknowledgment. ' +
          'Use PATCH /commitments/:id or markDelivered() to change this.',
      }));
      if (this.config.onVerified) this.config.onVerified(updated);
      return { passed: true, detail: 'Trusted — no automated verification method' };
    }

    let result: { passed: boolean; detail: string };

    switch (commitment.type) {
      case 'config-change':
        result = this.verifyConfigChange(commitment);
        break;
      case 'behavioral':
        result = this.verifyBehavioral(commitment);
        break;
      case 'one-time-action':
        result = this.verifyOneTimeAction(commitment);
        break;
      default:
        result = { passed: false, detail: `Unknown commitment type: ${commitment.type}` };
    }

    // Update commitment status based on result — route through the
    // single-writer mutateSync surface so concurrent write paths can't
    // clobber each other.
    const wasFirstVerification = commitment.status === 'pending';
    const wasViolated = commitment.status === 'violated';
    const wasVerified = commitment.status === 'verified';

    const updated = this.mutateSync(id, c => {
      if (result.passed) {
        const next: Commitment = {
          ...c,
          status: 'verified',
          lastVerifiedAt: new Date().toISOString(),
          verificationCount: c.verificationCount + 1,
        };
        if (c.type === 'one-time-action') {
          next.resolvedAt = new Date().toISOString();
          next.resolution = 'Verified complete';
        }
        return next;
      }
      return {
        ...c,
        status: 'violated',
        violationCount: c.violationCount + 1,
      };
    });

    if (result.passed) {
      if (wasFirstVerification && this.config.onVerified) {
        this.config.onVerified(updated);
      }
      if (wasViolated) {
        console.log(`[CommitmentTracker] ${id} recovered: "${updated.userRequest}"`);
      }
    } else if (wasVerified) {
      // Regression — was verified, now violated
      console.warn(`[CommitmentTracker] VIOLATION ${id}: "${updated.userRequest}" — ${result.detail}`);
      if (this.config.onViolation) {
        this.config.onViolation(updated, result.detail);
      }
    }

    return result;
  }

  // ── Session Awareness ──────────────────────────────────────────

  /**
   * Get behavioral commitments formatted for session injection.
   * This is what hooks read and inject into new sessions.
   */
  getBehavioralContext(): string {
    const behavioral = this.getActive().filter(c =>
      c.type === 'behavioral' || c.type === 'config-change'
    );

    if (behavioral.length === 0) return '';

    const lines = [
      '# Active Commitments (user-requested rules)',
      '',
      'These rules were explicitly requested by the user. They override defaults.',
      '',
    ];

    for (const c of behavioral) {
      const since = c.createdAt.split('T')[0];
      const expires = c.expiresAt ? ` (expires ${c.expiresAt.split('T')[0]})` : '';

      if (c.type === 'behavioral' && c.behavioralRule) {
        lines.push(`- [${c.id}] ${c.behavioralRule}${expires} (Since ${since})`);
      } else if (c.type === 'config-change' && c.configPath) {
        lines.push(`- [${c.id}] Config: ${c.configPath} must be ${JSON.stringify(c.configExpectedValue)}. User request: "${c.userRequest}"${expires} (Since ${since})`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Get ComponentHealth for integration with HealthChecker.
   */
  getHealth(): ComponentHealth {
    const active = this.getActive();
    const violated = active.filter(c => c.status === 'violated');

    if (active.length === 0) {
      return { status: 'healthy', message: 'No active commitments', lastCheck: new Date().toISOString() };
    }

    if (violated.length > 0) {
      return {
        status: 'degraded',
        message: `${violated.length} violated commitment(s): ${violated.map(c => c.id).join(', ')}`,
        lastCheck: new Date().toISOString(),
      };
    }

    return {
      status: 'healthy',
      message: `${active.length} commitment(s) tracked, all verified`,
      lastCheck: new Date().toISOString(),
    };
  }

  // ── Type-specific Verification ─────────────────────────────────

  private verifyConfigChange(commitment: Commitment): { passed: boolean; detail: string } {
    if (!commitment.configPath) {
      return { passed: false, detail: 'Missing configPath on config-change commitment' };
    }

    const currentValue = this.config.liveConfig.get(commitment.configPath, undefined);
    const matches = this.deepEqual(currentValue, commitment.configExpectedValue);

    return {
      passed: matches,
      detail: matches
        ? `Config ${commitment.configPath} = ${JSON.stringify(currentValue)} (matches)`
        : `Config ${commitment.configPath} = ${JSON.stringify(currentValue)}, expected ${JSON.stringify(commitment.configExpectedValue)}`,
    };
  }

  private verifyBehavioral(commitment: Commitment): { passed: boolean; detail: string } {
    // Behavioral commitments are "verified" if the rule text exists in the rules file
    if (!commitment.behavioralRule) {
      return { passed: false, detail: 'Missing behavioralRule on behavioral commitment' };
    }

    try {
      if (!fs.existsSync(this.rulesPath)) {
        this.writeBehavioralRules();
      }
      const content = fs.readFileSync(this.rulesPath, 'utf-8');
      const hasRule = content.includes(commitment.id);
      return {
        passed: hasRule,
        detail: hasRule ? 'Behavioral rule present in injection file' : 'Behavioral rule missing from injection file — regenerating',
      };
    } catch {
      return { passed: false, detail: 'Failed to read behavioral rules file' };
    }
  }

  private verifyOneTimeAction(commitment: Commitment): { passed: boolean; detail: string } {
    switch (commitment.verificationMethod) {
      case 'config-value':
        return this.verifyConfigChange(commitment);

      case 'file-exists':
        if (!commitment.verificationPath) {
          return { passed: false, detail: 'Missing verificationPath for file-exists check' };
        }
        const exists = fs.existsSync(commitment.verificationPath);
        return {
          passed: exists,
          detail: exists ? `File exists: ${commitment.verificationPath}` : `File missing: ${commitment.verificationPath}`,
        };

      case 'manual':
        // Manual commitments stay pending until explicitly resolved
        return { passed: false, detail: 'Awaiting manual verification' };

      default:
        return { passed: false, detail: `Unknown verification method: ${commitment.verificationMethod}` };
    }
  }

  // ── Auto-correction ────────────────────────────────────────────

  private attemptAutoCorrection(commitment: Commitment): boolean {
    if (!commitment.configPath || commitment.configExpectedValue === undefined) return false;

    try {
      this.config.liveConfig.set(commitment.configPath, commitment.configExpectedValue);

      // Re-verify after correction
      const recheck = this.verifyConfigChange(commitment);
      if (recheck.passed) {
        const now = new Date().toISOString();
        const updated = this.mutateSync(commitment.id, c => ({
          ...c,
          status: 'verified',
          lastVerifiedAt: now,
          verificationCount: c.verificationCount + 1,
          correctionCount: (c.correctionCount ?? 0) + 1,
          correctionHistory: [...(c.correctionHistory ?? []), now],
        }));

        // Check for escalation: too many corrections in a time window suggests a bug
        this.checkForEscalation(updated);

        console.log(`[CommitmentTracker] Auto-corrected ${updated.id}: ${updated.configPath} → ${JSON.stringify(updated.configExpectedValue)} (correction #${updated.correctionCount})`);
        this.emit('corrected', updated);
        return true;
      }
    } catch (err) {
      DegradationReporter.getInstance().report({
        feature: 'CommitmentTracker.attemptAutoCorrection',
        primary: `Auto-correct config drift for commitment ${commitment.id}`,
        fallback: 'Config drift persists, violation remains unresolved',
        reason: `Auto-correction failed: ${err instanceof Error ? err.message : String(err)}`,
        impact: `Commitment "${commitment.userRequest}" remains violated until next cycle`,
      });
      console.error(`[CommitmentTracker] Auto-correction failed for ${commitment.id}:`, err);
    }

    return false;
  }

  /**
   * Check if a commitment has been auto-corrected too many times,
   * suggesting a bug rather than simple drift.
   */
  private checkForEscalation(commitment: Commitment): void {
    if (commitment.escalated) return; // Already escalated

    const threshold = this.config.escalationThreshold ?? 3;
    const windowMs = this.config.escalationWindowMs ?? 3_600_000; // 1 hour
    const now = Date.now();

    // Count corrections within the window
    const recentCorrections = (commitment.correctionHistory ?? []).filter(ts => {
      return (now - new Date(ts).getTime()) < windowMs;
    });

    if (recentCorrections.length >= threshold) {
      const detail = `Commitment ${commitment.id} ("${commitment.userRequest}") has been auto-corrected ${recentCorrections.length} times in the last ${Math.round(windowMs / 60_000)} minutes. Config path: ${commitment.configPath}. This pattern suggests something is actively overwriting the value — likely a bug in initialization, a conflicting process, or a default value that resets on restart.`;

      const updated = this.mutateSync(commitment.id, c => ({
        ...c,
        escalated: true,
        escalationDetail: detail,
      }));

      console.warn(`[CommitmentTracker] ESCALATION ${updated.id}: ${detail}`);
      this.emit('escalation', updated, detail);

      if (this.config.onEscalation) {
        this.config.onEscalation(updated, detail);
      }
    }
  }

  // ── Behavioral Rules File ──────────────────────────────────────

  /**
   * Write the commitment-rules.md file for hook injection.
   */
  private writeBehavioralRules(): void {
    const content = this.getBehavioralContext();
    try {
      const dir = path.dirname(this.rulesPath);
      fs.mkdirSync(dir, { recursive: true });

      if (content) {
        const tmpPath = `${this.rulesPath}.${process.pid}.tmp`;
        fs.writeFileSync(tmpPath, content + '\n');
        fs.renameSync(tmpPath, this.rulesPath);
      } else {
        // No active commitments — remove the file so hooks skip injection
        if (fs.existsSync(this.rulesPath)) {
          // safe-git-allow: incremental-migration
          fs.unlinkSync(this.rulesPath);
        }
      }
    } catch {
      // @silent-fallback-ok — rules file is nice-to-have, monitor catches violations anyway
    }
  }

  // ── Expiration ─────────────────────────────────────────────────

  private expireCommitments(): void {
    const now = new Date().toISOString();
    let changed = false;

    // Snapshot ids before mutating so we don't iterate a live array under
    // concurrent mutateSync() index-preserving writes.
    const targets = this.store.commitments
      .filter(c => c.expiresAt && c.expiresAt < now && c.status !== 'expired' && c.status !== 'withdrawn')
      .map(c => c.id);

    for (const id of targets) {
      this.mutateSync(id, c => ({
        ...c,
        status: 'expired',
        resolvedAt: now,
        resolution: 'Expired',
      }));
      changed = true;
      const c = this.get(id);
      if (c) console.log(`[CommitmentTracker] Expired ${c.id}: "${c.userRequest}"`);
    }

    if (changed) {
      this.writeBehavioralRules();
    }
  }

  // ── Single-writer mutation ─────────────────────────────────────

  /**
   * Single-writer mutate surface. Every write path routes through here so
   * concurrent writers (CommitmentSentinel, PresenceProxy, future
   * PromiseBeacon) can't clobber each other.
   *
   * Contract:
   *   - FIFO queue per commitment id, max depth 256.
   *   - Optimistic CAS on the `version` field: read → fn(clone) → write if
   *     version unchanged, else retry (max 5). On success, version is
   *     incremented and the store is persisted atomically.
   *   - Caller-supplied fn p99 target: 50ms. Long work belongs outside.
   *
   * Returns the persisted commitment snapshot (post-increment).
   */
  async mutate(id: string, fn: MutateFn): Promise<Commitment> {
    return new Promise<Commitment>((resolve, reject) => {
      let queue = this.mutateQueues.get(id);
      if (!queue) {
        queue = [];
        this.mutateQueues.set(id, queue);
      }
      if (queue.length >= MUTATE_QUEUE_MAX_DEPTH) {
        reject(new Error(
          `CommitmentTracker.mutate: queue full for ${id} (depth ${queue.length} >= ${MUTATE_QUEUE_MAX_DEPTH})`
        ));
        return;
      }
      queue.push({ fn, resolve, reject });
      // Fire-and-forget drain; errors already propagate via entry.reject.
      void this.drainMutateQueue(id);
    });
  }

  private async drainMutateQueue(id: string): Promise<void> {
    if (this.mutateRunning.has(id)) return;
    this.mutateRunning.add(id);
    try {
      const queue = this.mutateQueues.get(id);
      while (queue && queue.length > 0) {
        const entry = queue.shift()!;
        try {
          const result = await this.applyMutationWithCAS(id, entry.fn);
          entry.resolve(result);
        } catch (err) {
          entry.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
      // Clean up empty queue so Maps don't grow unbounded.
      if (queue && queue.length === 0) this.mutateQueues.delete(id);
    } finally {
      this.mutateRunning.delete(id);
    }
  }

  private async applyMutationWithCAS(id: string, fn: MutateFn): Promise<Commitment> {
    let attempt = 0;
    while (attempt <= MUTATE_CAS_MAX_RETRIES) {
      const idx = this.store.commitments.findIndex(c => c.id === id);
      if (idx === -1) {
        throw new Error(`CommitmentTracker.mutate: unknown commitment id ${id}`);
      }
      const current = this.store.commitments[idx];
      const observedVersion = current.version ?? 0;

      // Provide a shallow clone so fn mutations don't prematurely touch store.
      const draft: Commitment = { ...current };
      const next = await fn(draft);

      // CAS check: the record's version must not have drifted underneath us.
      const latestIdx = this.store.commitments.findIndex(c => c.id === id);
      if (latestIdx === -1) {
        throw new Error(`CommitmentTracker.mutate: commitment ${id} disappeared mid-apply`);
      }
      const latest = this.store.commitments[latestIdx];
      if ((latest.version ?? 0) !== observedVersion) {
        attempt++;
        continue;
      }

      const committed: Commitment = { ...next, version: observedVersion + 1 };
      this.store.commitments[latestIdx] = committed;
      this.saveStore();
      return committed;
    }
    throw new Error(
      `CommitmentTracker.mutate: CAS retry budget exhausted for ${id} after ${MUTATE_CAS_MAX_RETRIES} retries`
    );
  }

  /**
   * Synchronous mutation helper used by existing sync write paths
   * (withdraw, verifyOne, expireCommitments, attemptAutoCorrection,
   * checkForEscalation). Since JS is single-threaded, synchronous fn
   * bodies cannot race against each other — this path does a straight
   * read → apply → version++ → persist. Async callers must use
   * mutate() for proper queueing across awaits.
   */
  private mutateSync(id: string, fn: (c: Commitment) => Commitment): Commitment {
    const idx = this.store.commitments.findIndex(c => c.id === id);
    if (idx === -1) {
      throw new Error(`CommitmentTracker.mutateSync: unknown commitment id ${id}`);
    }
    const current = this.store.commitments[idx];
    const observedVersion = current.version ?? 0;
    const next = fn({ ...current });
    const committed: Commitment = { ...next, version: observedVersion + 1 };
    this.store.commitments[idx] = committed;
    this.saveStore();
    return committed;
  }

  /**
   * Insert a brand-new commitment under the mutate discipline. Used by
   * record(); creates an initial version-0 record, then serialises future
   * writes through mutate(id, fn).
   */
  private insertNew(commitment: Commitment): Commitment {
    const withVersion: Commitment = { ...commitment, version: commitment.version ?? 0 };
    this.store.commitments.push(withVersion);
    this.saveStore();
    return withVersion;
  }

  // ── Persistence ────────────────────────────────────────────────

  private loadStore(): CommitmentStore {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
        if ((data.version === 1 || data.version === 2) && Array.isArray(data.commitments)) {
          // Migrate: add self-healing fields to existing commitments
          for (const c of data.commitments) {
            if (c.correctionCount === undefined) c.correctionCount = 0;
            if (c.correctionHistory === undefined) c.correctionHistory = [];
            if (c.escalated === undefined) c.escalated = false;
            // v1 → v2: back-fill version field on every commitment.
            if (typeof c.version !== 'number') c.version = 0;
          }
          // Bump on-disk version tag; persisted on next saveStore().
          data.version = 2;
          return data as CommitmentStore;
        }
      }
    } catch {
      // Start fresh on corruption
    }
    return { version: 2, commitments: [], lastModified: new Date().toISOString() };
  }

  private saveStore(): void {
    this.store.lastModified = new Date().toISOString();
    try {
      const dir = path.dirname(this.storePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${this.storePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.store, null, 2) + '\n');
      fs.renameSync(tmpPath, this.storePath);
    } catch {
      // @silent-fallback-ok — state persistence failure, will retry next cycle
    }
  }

  private computeNextId(): number {
    if (this.store.commitments.length === 0) return 1;
    const maxId = Math.max(...this.store.commitments.map(c => {
      const match = c.id.match(/CMT-(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    }));
    return maxId + 1;
  }

  // ── Utility ────────────────────────────────────────────────────

  private deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return false;

    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);

    for (const key of keys) {
      if (!this.deepEqual(aObj[key], bObj[key])) return false;
    }

    return true;
  }
}
