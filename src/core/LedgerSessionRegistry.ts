/**
 * LedgerSessionRegistry — authenticates session-asserted writes to the
 * Integrated-Being shared-state ledger (v2).
 *
 * Part of Integrated-Being v2 (see docs/specs/integrated-being-ledger-v2.md §3).
 *
 * Responsibilities:
 * - Register a session id, issue a binding token, persist the hash.
 * - Verify a (sessionId, token) pair on each write, enforcing absolute
 *   and idle TTLs.
 * - Rotate binding tokens on explicit re-register / rotate calls.
 * - Revoke a session (dashboard "revoke binding" button).
 * - Purge expired / unused sessions on cleanup.
 * - Expose a list of active sessions for the dashboard.
 *
 * Distinct from the tmux `SessionManager` — this registry tracks
 * ledger-binding identity only, not process lifecycle.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  IntegratedBeingConfig,
  LedgerSessionRegistration,
} from './types.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

// ── Constants / defaults ───────────────────────────────────────────

const DEFAULT_ABSOLUTE_TTL_HOURS = 72;
const DEFAULT_IDLE_TTL_HOURS = 24;
const DEFAULT_RETENTION_DAYS = 7;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
/** Hook-in-progress flag TTL. Matches spec §3 attestation window. */
const HOOK_IN_PROGRESS_TTL_MS = 30 * 1000;

const SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TOKEN_HEX_RE = /^[0-9a-f]{64}$/;
const LABEL_MAX = 64;

// ── Options / results ──────────────────────────────────────────────

export interface LedgerSessionRegistryOptions {
  /** Agent state directory (.instar/). */
  stateDir: string;
  /** IntegratedBeing config — supplies TTL / retention knobs. */
  config: IntegratedBeingConfig;
  /** Optional clock override for tests. */
  now?: () => number;
  /** Degradation reporter for fail-open observability. */
  degradationReporter?: DegradationReporter;
}

export interface RotateResult {
  sessionId: string;
  /** Freshly-issued plaintext binding token. 32-byte hex. */
  token: string;
  absoluteExpiresAt: string;
  idleExpiresAt: string;
}

export type RotateFailureReason =
  | 'unknown-session'
  | 'token-mismatch'
  | 'revoked'
  | 'idle-expired'
  | 'absolute-expired'
  | 'malformed';

export type RotateResultOrFailure =
  | { ok: true; result: RotateResult }
  | { ok: false; reason: RotateFailureReason };

export interface RegisterResult {
  sessionId: string;
  /** Plaintext binding token — returned ONCE, never again. 32-byte hex. */
  token: string;
  /** ISO 8601. */
  absoluteExpiresAt: string;
  /** ISO 8601. */
  idleExpiresAt: string;
  /** True if this sessionId was already registered and the SAME token
   *  was returned (idempotent replay of hook). False if a new session. */
  idempotentReplay: boolean;
}

export type VerifyResult =
  | { ok: true; registration: LedgerSessionRegistration }
  | { ok: false; reason: VerifyFailureReason };

export type VerifyFailureReason =
  | 'unknown-session'
  | 'token-mismatch'
  | 'revoked'
  | 'idle-expired'
  | 'absolute-expired'
  | 'malformed';

export interface SessionSummary {
  sessionId: string;
  registeredAt: string;
  lastActiveAt: string;
  absoluteExpiresAt: string;
  idleExpiresAt: string;
  hasWritten: boolean;
  revoked: boolean;
  label?: string;
}

// ── Helpers ────────────────────────────────────────────────────────

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function sanitizeLabel(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.replace(/\p{C}/gu, '').trim().slice(0, LABEL_MAX);
  return trimmed.length > 0 ? trimmed : undefined;
}

// ── Class ──────────────────────────────────────────────────────────

export class LedgerSessionRegistry {
  private readonly stateDir: string;
  private readonly registryPath: string;
  private readonly config: IntegratedBeingConfig;
  private readonly now: () => number;

  private registrations: Map<string, LedgerSessionRegistration>;
  private readonly degradation: DegradationReporter;

  /**
   * Hook-in-progress flags — tracks sessions that invoked session-bind but
   * have not yet completed the file-based handoff. Used to attest the
   * /shared-state/session-bind-interactive fallback (spec §3):
   * the caller must have a hook-in-progress flag set within the last 30s.
   * In-memory only; does not survive process restart (that would defeat
   * the attestation, since a restart equals a fresh lifecycle).
   */
  private hookInProgress: Map<string, number> = new Map();

  constructor(opts: LedgerSessionRegistryOptions) {
    this.stateDir = opts.stateDir;
    this.registryPath = path.join(opts.stateDir, 'ledger-sessions.json');
    this.config = opts.config;
    this.now = opts.now ?? Date.now;
    this.registrations = new Map();
    this.degradation = opts.degradationReporter ?? DegradationReporter.getInstance();
    this.ensureDir();
    this.hydrate();
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  private ensureDir(): void {
    try {
      if (!fs.existsSync(this.stateDir)) {
        fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
      }
    } catch {
      /* best effort */
    }
  }

  private hydrate(): void {
    try {
      if (!fs.existsSync(this.registryPath)) return;
      const raw = fs.readFileSync(this.registryPath, 'utf8');
      const parsed = JSON.parse(raw) as { sessions?: LedgerSessionRegistration[] };
      if (!parsed || !Array.isArray(parsed.sessions)) return;
      for (const s of parsed.sessions) {
        if (!s || typeof s !== 'object') continue;
        if (typeof s.sessionId !== 'string' || !SESSION_ID_RE.test(s.sessionId)) continue;
        if (typeof s.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(s.tokenHash)) continue;
        this.registrations.set(s.sessionId, {
          sessionId: s.sessionId,
          tokenHash: s.tokenHash,
          registeredAt: s.registeredAt,
          lastActiveAt: s.lastActiveAt,
          absoluteExpiresAt: s.absoluteExpiresAt,
          idleExpiresAt: s.idleExpiresAt,
          hasWritten: Boolean(s.hasWritten),
          revoked: Boolean(s.revoked),
          label: sanitizeLabel(s.label),
        });
      }
    } catch (err) {
      // Corrupt registry starts empty — all active tokens are invalidated.
      // Degradation reporter makes this loud so operators know every live
      // session just got bounced (carry-forward from slice 1 reviewer note).
      this.registrations.clear();
      try {
        this.degradation.report({
          feature: 'LedgerSessionRegistry',
          primary: 'hydrate persisted registrations from ledger-sessions.json',
          fallback: 'start with empty registry — all active tokens invalidated',
          reason: `parse failed: ${err instanceof Error ? err.message : String(err)}`,
          impact:
            'All currently-bound sessions lose write capability and must re-register on next write attempt.',
        });
      } catch {
        /* degradation reporter may not be initialized in some test contexts */
      }
    }
  }

  private persist(): void {
    const sessions = Array.from(this.registrations.values());
    const payload = JSON.stringify({ sessions }, null, 2);
    const tmp = `${this.registryPath}.tmp.${process.pid}`;
    try {
      fs.writeFileSync(tmp, payload, { mode: 0o600 });
      fs.chmodSync(tmp, 0o600); // Explicit — defend against umask.
      fs.renameSync(tmp, this.registryPath);
      try {
        fs.chmodSync(this.registryPath, 0o600);
      } catch {
        /* rename preserved mode */
      }
    } catch {
      try {
        // safe-git-allow: incremental-migration
        fs.unlinkSync(tmp);
      } catch {
        /* best effort */
      }
    }
  }

  // ── TTL helpers ──────────────────────────────────────────────────

  private absoluteTtlMs(): number {
    const hours = this.config.tokenAbsoluteTtlHours ?? DEFAULT_ABSOLUTE_TTL_HOURS;
    return Math.max(1, hours) * ONE_HOUR_MS;
  }

  private idleTtlMs(): number {
    const hours = this.config.tokenIdleTtlHours ?? DEFAULT_IDLE_TTL_HOURS;
    return Math.max(1, hours) * ONE_HOUR_MS;
  }

  private retentionMs(): number {
    const days = this.config.sessionBindingRetentionDays ?? DEFAULT_RETENTION_DAYS;
    return Math.max(1, days) * ONE_DAY_MS;
  }

  // ── Public surface ───────────────────────────────────────────────

  /**
   * Register a session and issue a binding token. Idempotent on duplicate
   * sessionId within the absolute TTL window: the SAME token is returned.
   * Metadata (label) from a duplicate call is NOT applied (spec §3 S1).
   */
  register(sessionId: string, label?: string): RegisterResult {
    if (!SESSION_ID_RE.test(sessionId)) {
      throw new Error('sessionId must be a UUIDv4-format string');
    }
    const nowMs = this.now();

    const existing = this.registrations.get(sessionId);
    if (
      existing &&
      !existing.revoked &&
      new Date(existing.absoluteExpiresAt).getTime() > nowMs
    ) {
      // Idempotent — return same token only if it's still cached in memory.
      // The hash is on disk but plaintext is not; we can't return a plaintext
      // token we don't have. For our purposes this path is reached by the
      // session-start hook re-running within a single process lifetime with
      // the plaintext already written to the token file; the server-side
      // register call returns the CACHED plaintext token.
      const cached = this.plaintextCache.get(sessionId);
      if (cached) {
        return {
          sessionId,
          token: cached,
          absoluteExpiresAt: existing.absoluteExpiresAt,
          idleExpiresAt: existing.idleExpiresAt,
          idempotentReplay: true,
        };
      }
      // Server-restart case — plaintext lost. Issue a new token but keep
      // the same sessionId; old hash is overwritten.
    }

    // Absolute expiry is ANCHORED to registeredAt, not recomputed from now.
    // This closes the "refresh-revive across server restart" hole: when the
    // plaintext cache is lost post-restart, a rebind with the same sessionId
    // would otherwise get a fresh `now + ttl` window even if registeredAt was
    // 70 hours ago. Spec §3: "A token is invalid past this age regardless
    // of session activity. Prevents a leaked token from being refresh-revived
    // indefinitely." For a fresh registration (no existing, or existing past
    // absolute TTL) the anchor is now.
    const registeredAtMs = existing?.registeredAt
      ? new Date(existing.registeredAt).getTime()
      : nowMs;
    const anchoredAbsoluteMs = registeredAtMs + this.absoluteTtlMs();
    if (anchoredAbsoluteMs <= nowMs) {
      // Anchored absolute TTL already elapsed — refuse same-sessionId rebind.
      // Caller must present a fresh sessionId (hook re-run on a new session).
      throw new Error(
        'sessionId absolute TTL exhausted; generate a new sessionId to rebind'
      );
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const absoluteExpiresAt = new Date(anchoredAbsoluteMs).toISOString();
    const idleExpiresAt = new Date(nowMs + this.idleTtlMs()).toISOString();
    const nowIso = new Date(nowMs).toISOString();

    const registration: LedgerSessionRegistration = {
      sessionId,
      tokenHash,
      registeredAt: existing?.registeredAt ?? nowIso,
      lastActiveAt: nowIso,
      absoluteExpiresAt,
      idleExpiresAt,
      hasWritten: false,
      revoked: false,
      label: sanitizeLabel(label),
    };
    this.registrations.set(sessionId, registration);
    this.plaintextCache.set(sessionId, token);
    this.persist();

    return {
      sessionId,
      token,
      absoluteExpiresAt,
      idleExpiresAt,
      idempotentReplay: false,
    };
  }

  /**
   * Verify a (sessionId, token) pair. On success, returns the registration;
   * on failure, returns the structured failure reason (never throws). Does
   * NOT update lastActiveAt — call touchActivity() on the success path from
   * the append handler when the write has been accepted.
   */
  verify(sessionId: string, token: string): VerifyResult {
    if (!SESSION_ID_RE.test(sessionId) || !TOKEN_HEX_RE.test(token)) {
      return { ok: false, reason: 'malformed' };
    }
    const registration = this.registrations.get(sessionId);
    if (!registration) return { ok: false, reason: 'unknown-session' };
    if (registration.revoked) return { ok: false, reason: 'revoked' };

    const nowMs = this.now();
    if (new Date(registration.absoluteExpiresAt).getTime() <= nowMs) {
      return { ok: false, reason: 'absolute-expired' };
    }
    if (new Date(registration.idleExpiresAt).getTime() <= nowMs) {
      return { ok: false, reason: 'idle-expired' };
    }

    const presented = hashToken(token);
    if (!constantTimeEqualHex(presented, registration.tokenHash)) {
      return { ok: false, reason: 'token-mismatch' };
    }

    return { ok: true, registration };
  }

  /**
   * Update lastActiveAt and extend idle TTL. Called after a successful
   * write. Persists. Does NOT extend absolute TTL.
   */
  touchActivity(sessionId: string): void {
    const registration = this.registrations.get(sessionId);
    if (!registration || registration.revoked) return;
    const nowMs = this.now();
    registration.lastActiveAt = new Date(nowMs).toISOString();
    registration.idleExpiresAt = new Date(nowMs + this.idleTtlMs()).toISOString();
    registration.hasWritten = true;
    this.persist();
  }

  /** Mark a session revoked. Subsequent verify() returns {ok:false, revoked}. */
  revoke(sessionId: string): boolean {
    const registration = this.registrations.get(sessionId);
    if (!registration) return false;
    if (registration.revoked) return true;
    registration.revoked = true;
    this.plaintextCache.delete(sessionId);
    this.persist();
    return true;
  }

  /**
   * Purge expired / retained-past-window sessions.
   * - Revoked sessions: purged immediately.
   * - Sessions past absolute TTL AND past retention window since last write: purged.
   * - Sessions that never wrote and past 1 day since register: purged.
   *
   * Returns count of purged sessions.
   */
  purgeExpired(nowMs?: number): number {
    const t = nowMs ?? this.now();
    const retention = this.retentionMs();
    const oneDay = ONE_DAY_MS;
    let purged = 0;
    for (const [id, reg] of this.registrations) {
      const lastActiveMs = new Date(reg.lastActiveAt).getTime();
      const absExpMs = new Date(reg.absoluteExpiresAt).getTime();
      const age = t - lastActiveMs;
      let remove = false;
      if (reg.revoked) remove = true;
      else if (!reg.hasWritten && age > oneDay) remove = true;
      else if (absExpMs <= t && age > retention) remove = true;
      if (remove) {
        this.registrations.delete(id);
        this.plaintextCache.delete(id);
        purged++;
      }
    }
    if (purged > 0) this.persist();
    return purged;
  }

  /** Dashboard surface: summary of all sessions, redacted (no token hash). */
  listSessions(): SessionSummary[] {
    return Array.from(this.registrations.values()).map((r) => ({
      sessionId: r.sessionId,
      registeredAt: r.registeredAt,
      lastActiveAt: r.lastActiveAt,
      absoluteExpiresAt: r.absoluteExpiresAt,
      idleExpiresAt: r.idleExpiresAt,
      hasWritten: r.hasWritten,
      revoked: r.revoked,
      label: r.label,
    }));
  }

  /** Count of active (non-revoked, non-expired) sessions. */
  activeCount(nowMs?: number): number {
    const t = nowMs ?? this.now();
    let n = 0;
    for (const reg of this.registrations.values()) {
      if (reg.revoked) continue;
      if (new Date(reg.absoluteExpiresAt).getTime() <= t) continue;
      if (new Date(reg.idleExpiresAt).getTime() <= t) continue;
      n++;
    }
    return n;
  }

  // ── Write rate + commitment counters (slice 3) ──────────────────
  //
  // Per-session sliding-window rate tracking for /shared-state/append.
  // In-memory only — a server restart resets the counters, which is
  // an acceptable soft-limit property (absolute protection is the
  // per-agent-global ceiling in slice 5).
  //
  // openCommitments and passiveWaitCommitments are incremented when a
  // commitment is accepted; slice 4's resolve path will decrement them.

  private writeTimestamps: Map<string, number[]> = new Map();
  private openCommitments: Map<string, number> = new Map();
  private passiveWaitCommitments: Map<string, number> = new Map();

  /**
   * Check write-rate. Returns null on ok, or the error reason if over.
   * Caller must invoke recordWrite() AFTER the write has been accepted
   * (so a failed write doesn't count against the quota).
   */
  checkWriteRate(sessionId: string, perMinuteLimit: number): 'over-session-rate' | null {
    const t = this.now();
    const cutoff = t - 60_000;
    const arr = this.writeTimestamps.get(sessionId) ?? [];
    const live = arr.filter((ts) => ts > cutoff);
    if (live.length >= perMinuteLimit) return 'over-session-rate';
    return null;
  }

  /** Record a successful write for rate tracking. */
  recordWrite(sessionId: string): void {
    const t = this.now();
    const cutoff = t - 60_000;
    const arr = (this.writeTimestamps.get(sessionId) ?? []).filter((ts) => ts > cutoff);
    arr.push(t);
    this.writeTimestamps.set(sessionId, arr);
  }

  /**
   * Check commitment-count limits. Returns null on ok, or the error
   * reason if over. Call recordOpenCommitment() on accept.
   */
  checkOpenCommitments(
    sessionId: string,
    mechanismType: string,
    openLimit: number,
    passiveWaitLimit: number,
  ): 'over-open-commitments' | 'over-passive-wait-commitments' | null {
    const open = this.openCommitments.get(sessionId) ?? 0;
    if (open >= openLimit) return 'over-open-commitments';
    if (mechanismType === 'passive-wait') {
      const pw = this.passiveWaitCommitments.get(sessionId) ?? 0;
      if (pw >= passiveWaitLimit) return 'over-passive-wait-commitments';
    }
    return null;
  }

  /** Increment open-commitment counters after a commitment is accepted. */
  recordOpenCommitment(sessionId: string, mechanismType: string): void {
    this.openCommitments.set(sessionId, (this.openCommitments.get(sessionId) ?? 0) + 1);
    if (mechanismType === 'passive-wait') {
      this.passiveWaitCommitments.set(
        sessionId,
        (this.passiveWaitCommitments.get(sessionId) ?? 0) + 1,
      );
    }
  }

  /**
   * Decrement open-commitment counters when a commitment transitions
   * to non-open (slice 4 resolve/cancel path). Clamped at zero.
   */
  recordCommitmentClosed(sessionId: string, mechanismType: string): void {
    const open = this.openCommitments.get(sessionId) ?? 0;
    this.openCommitments.set(sessionId, Math.max(0, open - 1));
    if (mechanismType === 'passive-wait') {
      const pw = this.passiveWaitCommitments.get(sessionId) ?? 0;
      this.passiveWaitCommitments.set(sessionId, Math.max(0, pw - 1));
    }
  }

  // ── Idempotency cache (slice 4 — dedupKey replay) ────────────────
  //
  // Caches (sessionId, commitmentId, dedupKey) → result for retries.
  // 24h TTL matches the dedup index's rolling window.
  //
  // CRITICAL: the cache is keyed on the full tuple, not dedupKey
  // alone, to prevent cross-session result leaks. Second-pass reviewer
  // (slice 4) caught: with dedupKey-only keys, session B presenting
  // session A's dedupKey would short-circuit and return A's cached
  // payload before authorization ran. Keying on the tuple means B's
  // cache lookup misses, it re-authorizes, and hits the creator-
  // mismatch 403 or dispute-cap check as intended.
  //
  // In-memory — a server restart drops the cache; callers that retry
  // across restart see v1 dedup (409), not idempotent replay.

  private idempotencyCache: Map<string, { at: number; payload: unknown }> = new Map();

  private idempotencyKey(
    sessionId: string,
    commitmentId: string,
    dedupKey: string,
  ): string {
    return `${sessionId}\x00${commitmentId}\x00${dedupKey}`;
  }

  rememberIdempotent(
    sessionId: string,
    commitmentId: string,
    dedupKey: string,
    payload: unknown,
  ): void {
    this.idempotencyCache.set(this.idempotencyKey(sessionId, commitmentId, dedupKey), {
      at: this.now(),
      payload,
    });
    this.pruneIdempotency();
  }

  getIdempotent(
    sessionId: string,
    commitmentId: string,
    dedupKey: string,
  ): unknown | null {
    const k = this.idempotencyKey(sessionId, commitmentId, dedupKey);
    const rec = this.idempotencyCache.get(k);
    if (!rec) return null;
    if (this.now() - rec.at > ONE_DAY_MS) {
      this.idempotencyCache.delete(k);
      return null;
    }
    return rec.payload;
  }

  private pruneIdempotency(): void {
    const t = this.now();
    for (const [k, v] of this.idempotencyCache) {
      if (t - v.at > ONE_DAY_MS) this.idempotencyCache.delete(k);
    }
  }

  // ── Per-session dispute-rate cap (slice 4) ───────────────────────
  private disputeTimestamps: Map<string, number[]> = new Map();

  checkDisputeRate(sessionId: string, perHourLimit: number): 'over-dispute-rate' | null {
    const t = this.now();
    const cutoff = t - ONE_HOUR_MS;
    const arr = (this.disputeTimestamps.get(sessionId) ?? []).filter((ts) => ts > cutoff);
    if (arr.length >= perHourLimit) return 'over-dispute-rate';
    return null;
  }

  recordDispute(sessionId: string): void {
    const t = this.now();
    const cutoff = t - ONE_HOUR_MS;
    const arr = (this.disputeTimestamps.get(sessionId) ?? []).filter((ts) => ts > cutoff);
    arr.push(t);
    this.disputeTimestamps.set(sessionId, arr);
  }

  /** Test-only: read rate-tracker state. */
  _getRateStateForTest(sessionId: string): {
    writesInLastMinute: number;
    openCommitments: number;
    passiveWaitCommitments: number;
  } {
    const t = this.now();
    const arr = (this.writeTimestamps.get(sessionId) ?? []).filter((ts) => ts > t - 60_000);
    return {
      writesInLastMinute: arr.length,
      openCommitments: this.openCommitments.get(sessionId) ?? 0,
      passiveWaitCommitments: this.passiveWaitCommitments.get(sessionId) ?? 0,
    };
  }

  // ── Hook-in-progress attestation (§3 iter 2 fallback) ────────────

  /**
   * Mark a session id as "hook invoked session-bind but has not yet
   * completed the file-based handoff". Called from the session-bind
   * endpoint. The flag expires after {@link HOOK_IN_PROGRESS_TTL_MS}.
   * This is the attestation that gates session-bind-interactive.
   */
  markHookInProgress(sessionId: string): void {
    if (!SESSION_ID_RE.test(sessionId)) return;
    this.hookInProgress.set(sessionId, this.now() + HOOK_IN_PROGRESS_TTL_MS);
    this.pruneHookInProgress();
  }

  /**
   * Called by /shared-state/session-bind-confirm when the hook has
   * completed the mode-verified handoff. Clears the flag.
   */
  confirmHookDone(sessionId: string): void {
    this.hookInProgress.delete(sessionId);
  }

  /**
   * Returns true if the session id has a non-expired hook-in-progress
   * flag. Pruning is lazy. Used by session-bind-interactive.
   */
  isHookInProgress(sessionId: string): boolean {
    this.pruneHookInProgress();
    const exp = this.hookInProgress.get(sessionId);
    return typeof exp === 'number' && exp > this.now();
  }

  /**
   * Returns true if this sessionId has already completed a successful
   * token handoff — either a normal hook confirm, or a prior interactive
   * re-issue. The presence of a registration alone does NOT qualify —
   * `/shared-state/session-bind` always registers, so that check would
   * dead-code the interactive fallback for its stated purpose (hook
   * minted a token but couldn't deliver it via the file path).
   *
   * Single-use is enforced via the hook-in-progress flag: a successful
   * session-bind-confirm OR session-bind-interactive clears the flag,
   * so the next `isHookInProgress(sid)` check returns false.
   */
  hasConfirmedHandoff(sessionId: string): boolean {
    const reg = this.registrations.get(sessionId);
    if (!reg) return false;
    // "Confirmed" means hook-in-progress has been cleared and at least
    // one successful flow ran. We infer this from the absence of a
    // pending flag for a registered session — a registered session
    // without a pending flag must have either (a) completed confirm,
    // or (b) been rebound interactively (which also clears the flag).
    return !this.hookInProgress.has(sessionId);
  }

  /**
   * Interactive rebind — used by POST /shared-state/session-bind-interactive.
   * Requires an existing registration AND a live hook-in-progress flag
   * (both enforced by the endpoint handler). Issues a fresh token bound
   * to the same registration, preserving the anchored absolute expiry,
   * refreshing idle TTL, and atomically replacing the token hash.
   *
   * Callers MUST verify `isHookInProgress(sid)` first and clear it via
   * `confirmHookDone(sid)` after a successful call — single-use is the
   * attestation contract.
   */
  reissueForInteractive(sessionId: string): RotateResultOrFailure {
    if (!SESSION_ID_RE.test(sessionId)) {
      return { ok: false, reason: 'malformed' };
    }
    const registration = this.registrations.get(sessionId);
    if (!registration) return { ok: false, reason: 'unknown-session' };
    if (registration.revoked) return { ok: false, reason: 'revoked' };

    const nowMs = this.now();
    const anchoredAbsoluteMs = new Date(registration.registeredAt).getTime()
      + this.absoluteTtlMs();
    if (anchoredAbsoluteMs <= nowMs) {
      return { ok: false, reason: 'absolute-expired' };
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const idleExpiresAt = new Date(nowMs + this.idleTtlMs()).toISOString();
    const absoluteExpiresAt = new Date(anchoredAbsoluteMs).toISOString();

    registration.tokenHash = tokenHash;
    registration.lastActiveAt = new Date(nowMs).toISOString();
    registration.idleExpiresAt = idleExpiresAt;
    registration.absoluteExpiresAt = absoluteExpiresAt;
    this.plaintextCache.set(sessionId, token);
    this.persist();

    return {
      ok: true,
      result: {
        sessionId,
        token,
        absoluteExpiresAt,
        idleExpiresAt,
      },
    };
  }

  private pruneHookInProgress(): void {
    const t = this.now();
    for (const [id, exp] of this.hookInProgress) {
      if (exp <= t) this.hookInProgress.delete(id);
    }
  }

  // ── Rotation (§3 iter 2 — grace window path) ─────────────────────

  /**
   * Rotate a session's binding token. Requires the current valid token;
   * the registration must not be past absolute TTL (since absolute-TTL
   * is anchored to registeredAt, rotation can extend idle-TTL but NOT
   * the absolute window — that's the whole point of the absolute cap).
   *
   * On success, the old token is invalidated immediately (hash replaced).
   */
  rotate(sessionId: string, currentToken: string): RotateResultOrFailure {
    const v = this.verify(sessionId, currentToken);
    if (!v.ok) return { ok: false, reason: v.reason };

    const nowMs = this.now();
    const registration = v.registration;
    // Absolute expiry unchanged — anchored to registeredAt.
    const anchoredAbsoluteMs = new Date(registration.registeredAt).getTime()
      + this.absoluteTtlMs();
    if (anchoredAbsoluteMs <= nowMs) {
      return { ok: false, reason: 'absolute-expired' };
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const idleExpiresAt = new Date(nowMs + this.idleTtlMs()).toISOString();
    const absoluteExpiresAt = new Date(anchoredAbsoluteMs).toISOString();

    registration.tokenHash = tokenHash;
    registration.lastActiveAt = new Date(nowMs).toISOString();
    registration.idleExpiresAt = idleExpiresAt;
    registration.absoluteExpiresAt = absoluteExpiresAt;
    this.plaintextCache.set(sessionId, token);
    this.persist();

    return {
      ok: true,
      result: {
        sessionId,
        token,
        absoluteExpiresAt,
        idleExpiresAt,
      },
    };
  }

  /** Test-only: raw registration accessor. Do NOT use in production code. */
  _getRegistrationForTest(sessionId: string): LedgerSessionRegistration | undefined {
    return this.registrations.get(sessionId);
  }

  // ── Plaintext token cache ────────────────────────────────────────
  //
  // The plaintext token is returned once by register(). For idempotent
  // hook replay within a single process lifetime, we keep a short-lived
  // in-memory cache so a duplicate register() call can return the same
  // plaintext. This is deliberately in-memory only — survives no restart.
  private plaintextCache: Map<string, string> = new Map();
}
