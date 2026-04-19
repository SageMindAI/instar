/**
 * PromiseBeacon — Follow-through heartbeats for open agent commitments.
 *
 * Implements the Phase 1 scope of docs/specs/PROMISE-BEACON-SPEC.md.
 *
 * When the agent says "I'll come back when X finishes" and then works silently
 * for 30+ minutes, the user has no signal whether the agent is alive,
 * progressing, or has forgotten. PromiseBeacon watches beacon-enabled
 * commitments (Commitment rows with `beaconEnabled: true` and a `topicId`)
 * and emits a short status line on a per-commitment cadence.
 *
 * Key properties:
 *  - setTimeout-based scheduling (not polling); durable across sleep by
 *    persisting `nextDueAt` (spec Round 3 #17).
 *  - Per-commitment hot state at .instar/state/promise-beacon/<id>.json
 *    (gitignored).
 *  - Snapshot-hash gate: unchanged tmux output emits a templated line
 *    without calling the LLM (≈70% of heartbeats on a quiet session).
 *  - Session-epoch check: if the Claude Code session UUID at declaration
 *    no longer matches the live session, transition to `violated` with
 *    reason `session-lost`.
 *  - Quiet hours + daily spend cap → `beaconSuppressed` (non-terminal).
 *  - Shares the LlmQueue and ProxyCoordinator with PresenceProxy so the
 *    two monitors can't double-post.
 *
 * Integration points:
 *  - `commitmentTracker.mutate(id, fn)` is the only write path.
 *  - `sendMessage(topicId, text, { source: 'promise-beacon', isProxy: true })`
 *    is what PresenceProxy's `isSystemOrProxyMessage` filters out.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EventEmitter } from 'node:events';
import type { CommitmentTracker, Commitment } from './CommitmentTracker.js';
import type { LlmQueue } from './LlmQueue.js';
import { LlmAbortedError } from './LlmQueue.js';
import type { ProxyCoordinator } from './ProxyCoordinator.js';
import { sanitizeTmuxOutput, guardProxyOutput } from './PresenceProxy.js';

// ─── Config & types ─────────────────────────────────────────────────────────

export interface PromiseBeaconConfig {
  stateDir: string;
  commitmentTracker: CommitmentTracker;
  llmQueue: LlmQueue;
  proxyCoordinator: ProxyCoordinator;

  // Callbacks
  captureSessionOutput: (sessionName: string, lines?: number) => string | null;
  getSessionForTopic: (topicId: number) => string | null;
  isSessionAlive: (sessionName: string) => boolean;
  getSessionEpoch?: (sessionName: string) => string | null;
  sendMessage: (
    topicId: number,
    text: string,
    metadata?: { source: 'promise-beacon'; isProxy: true; tier?: number },
  ) => Promise<void>;
  /** Haiku-class LLM call returning a short status line. */
  generateStatusLine?: (
    promiseText: string,
    tmuxOutput: string,
    signal: AbortSignal,
  ) => Promise<string>;

  // Settings (all spec-defaulted, per-agent overridable via config.json)
  prefix?: string;                   // Default: "⏳"
  maxDailyLlmSpendCents?: number;    // Default: 100
  sentinelAutoEnable?: boolean;      // Default: false
  quietHours?: { start: string; end: string; timezone?: string }; // "22:00-08:00" local
  /** Current machine id (ownership gate). */
  currentMachineId?: string;
  /** Floor for heartbeat cadence (ms). Default 60_000. */
  minCadenceMs?: number;
  /** Ceiling for heartbeat cadence (ms). Default 21_600_000 (6h). */
  maxCadenceMs?: number;
  /** Dev-only timer multiplier for tests. */
  __dev_timerMultiplier?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface HotState {
  lastHeartbeatAt?: string;
  heartbeatCount: number;
  lastSnapshotHash?: string;
  sessionEpoch?: string;
  consecutiveUnchanged: number;
  templatedVariantCursor: number;
}

// Rotating templated phrases (spec Round 3 #9).
const TEMPLATED_VARIANTS = [
  'still on it, no new output since last update',
  'still working — snapshot unchanged since last beat',
  'holding steady on this task — no fresh output yet',
  'continuing; terminal quiet since last check-in',
  'alive, working — no visible change since last heartbeat',
];

const AT_RISK_VARIANTS = [
  'no observable progress — may be waiting on external input',
  'still watching; appears idle — flagging at-risk',
  'no recent output; continuing to monitor',
];

// ─── Helper: snapshot normalization before hashing (spec §P14 + #16a) ──────

function normalizeForHash(raw: string): string {
  let s = raw;
  // Strip ANSI CSI.
  s = s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  // Control chars except \n \t.
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  // Spinners → placeholder.
  s = s.replace(/[\u2807\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F]/g, '·');
  // Timestamps → [TS].
  s = s.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '[TS]');
  s = s.replace(/\b\d{1,2}:\d{2}:\d{2}\b/g, '[TS]');
  // Progress counters.
  s = s.replace(/\b\d+(?:\.\d+)?\s?%\b/g, '[PROG]');
  s = s.replace(/\b\d+\/\d+\s+bytes\b/g, '[PROG]');
  s = s.replace(/\biter[=\s]\d+\b/gi, '[CTR]');
  // Trailing whitespace + blank lines collapse.
  s = s.split('\n').map(l => l.replace(/\s+$/, '')).filter((_l, i, arr) => {
    // Collapse >1 consecutive blank lines.
    return !(i > 0 && arr[i] === '' && arr[i - 1] === '');
  }).join('\n');
  return s.trim();
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Cap tmux capture (spec #16b).
function capOutput(raw: string, maxBytes = 4096, maxLines = 200): string {
  const lines = raw.split('\n').slice(-maxLines);
  let out = lines.join('\n');
  if (Buffer.byteLength(out, 'utf8') > maxBytes) {
    out = out.slice(-maxBytes);
  }
  return out;
}

// ─── Main class ─────────────────────────────────────────────────────────────

export class PromiseBeacon extends EventEmitter {
  private config: PromiseBeaconConfig;
  private started = false;
  private stateDir: string;
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private prefix: string;
  private minCadenceMs: number;
  private maxCadenceMs: number;
  private timerMult: number;
  private now: () => number;

  constructor(config: PromiseBeaconConfig) {
    super();
    this.config = config;
    this.prefix = config.prefix ?? '⏳';
    this.minCadenceMs = config.minCadenceMs ?? 60_000;
    this.maxCadenceMs = config.maxCadenceMs ?? 21_600_000;
    this.timerMult = config.__dev_timerMultiplier ?? 1.0;
    this.now = config.now ?? (() => Date.now());
    this.stateDir = path.join(config.stateDir, 'state', 'promise-beacon');
    try { fs.mkdirSync(this.stateDir, { recursive: true }); } catch { /* ok */ }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // Re-arm any existing beacon-enabled pending commitments.
    const active = this.config.commitmentTracker
      .getActive()
      .filter(c => c.beaconEnabled && c.status === 'pending' && !c.beaconSuppressed);
    for (const c of active) {
      this.schedule(c);
    }
    // React to new beacon-enabled commitments as they're recorded.
    this.config.commitmentTracker.on('recorded', (c: Commitment) => {
      if (c.beaconEnabled && c.status === 'pending' && c.topicId) {
        this.schedule(c);
      }
    });
    this.config.commitmentTracker.on('delivered', (c: Commitment) => {
      this.stopFor(c.id);
    });
    this.config.commitmentTracker.on('withdrawn', (c: Commitment) => {
      this.stopFor(c.id);
    });
    console.log(`[PromiseBeacon] Started (${this.prefix})`);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    console.log('[PromiseBeacon] Stopped');
  }

  /** Public for tests + delivery race: cancel the timer for one commitment. */
  stopFor(id: string): void {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
  }

  /** Schedule (or re-schedule) the next heartbeat for a commitment. */
  schedule(c: Commitment): void {
    if (!this.started) return;
    if (!c.topicId) return;
    if (c.status !== 'pending' || c.beaconSuppressed) return;

    const cadence = this.clampCadence(c.cadenceMs ?? 10 * 60_000) * this.timerMult;
    const hot = this.loadHotState(c.id);
    const last = hot.lastHeartbeatAt ? new Date(hot.lastHeartbeatAt).getTime() : new Date(c.createdAt).getTime();
    const dueAt = last + cadence;
    const delay = Math.max(1_000, dueAt - this.now());

    const existing = this.timers.get(c.id);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(c.id);
      this.fire(c.id).catch(err => {
        console.error(`[PromiseBeacon] fire() error for ${c.id}:`, (err as Error).message);
      });
    }, delay);
    timer.unref?.();
    this.timers.set(c.id, timer);
  }

  /** Fire one heartbeat. Public for testing. */
  async fire(id: string): Promise<void> {
    const c = this.config.commitmentTracker.getAll().find(x => x.id === id);
    if (!c) return;
    if (c.status !== 'pending' || c.beaconSuppressed) return;
    if (!c.topicId) return;

    // ── Ownership gate ──
    if (this.config.currentMachineId && c.ownerMachineId && c.ownerMachineId !== this.config.currentMachineId) {
      // Not ours; skip silently + re-arm for liveness.
      this.schedule(c);
      return;
    }

    // ── Quiet hours ──
    if (this.inQuietHours()) {
      await this.suppress(c, 'quiet-hours');
      return;
    }

    // ── Daily spend cap (hard, via LlmQueue) ──
    // LlmQueue enforces this on enqueue; we additionally short-circuit here
    // so we emit beaconSuppressed (non-terminal) rather than fail-open.
    if (this.config.llmQueue.getDailySpendCents() >= (this.config.maxDailyLlmSpendCents ?? 100)) {
      await this.suppress(c, 'daily-spend-cap');
      return;
    }

    // ── Session-epoch check ──
    const sessionName = this.config.getSessionForTopic(c.topicId);
    if (sessionName && this.config.getSessionEpoch) {
      const live = this.config.getSessionEpoch(sessionName);
      if (c.sessionEpoch && live && c.sessionEpoch !== live) {
        await this.transitionViolated(c, 'session-lost');
        return;
      }
    }

    // ── Proxy coordinator: one proxy-class message per topic ──
    if (!this.config.proxyCoordinator.tryAcquire(c.topicId, 'promise-beacon')) {
      // PresenceProxy holds — re-arm and bow out.
      this.schedule(c);
      return;
    }

    try {
      // ── Capture & hash ──
      let snapshot = '';
      if (sessionName) {
        const raw = this.config.captureSessionOutput(sessionName, 200);
        if (raw) {
          snapshot = sanitizeTmuxOutput(capOutput(raw), []);
        }
      }
      const hash = snapshot ? sha256(normalizeForHash(snapshot)) : 'empty';
      const hot = this.loadHotState(c.id);
      const unchanged = hash === hot.lastSnapshotHash;

      let text: string;
      if (!snapshot || unchanged) {
        // Templated — no LLM call.
        const variants = hot.consecutiveUnchanged > 2 ? AT_RISK_VARIANTS : TEMPLATED_VARIANTS;
        const phrase = variants[hot.templatedVariantCursor % variants.length];
        text = `${this.prefix} ${phrase}`;
        hot.consecutiveUnchanged += 1;
        hot.templatedVariantCursor += 1;
      } else {
        // LLM call — background lane, with AbortController preemption.
        try {
          const line = await this.config.llmQueue.enqueue(
            'background',
            (signal) => {
              if (this.config.generateStatusLine) {
                return this.config.generateStatusLine(c.agentResponse || c.userRequest, snapshot, signal);
              }
              // No generator wired → templated.
              return Promise.resolve('working on it — recent output observed');
            },
            // Rough Haiku estimate (~3k tokens in/out).
            1,
          );
          const guard = guardProxyOutput(line);
          text = `${this.prefix} ${guard.safe ? line : 'working on it'}`;
          hot.consecutiveUnchanged = 0;
        } catch (err) {
          if (err instanceof LlmAbortedError || (err as Error).message.includes('cap exceeded') || (err as Error).message.includes('reserve')) {
            text = `${this.prefix} still working (update deferred)`;
          } else {
            text = `${this.prefix} still working (status fetch failed)`;
          }
        }
      }

      // ── Send ──
      await this.config.sendMessage(c.topicId, text, {
        source: 'promise-beacon',
        isProxy: true,
        tier: 1,
      });

      // ── Persist hot state + mutate cold ──
      const nowIso = new Date(this.now()).toISOString();
      hot.lastHeartbeatAt = nowIso;
      hot.heartbeatCount += 1;
      hot.lastSnapshotHash = hash;
      this.saveHotState(c.id, hot);

      await this.config.commitmentTracker.mutate(c.id, prev => ({
        ...prev,
        lastHeartbeatAt: nowIso,
        heartbeatCount: (prev.heartbeatCount ?? 0) + 1,
        lastSnapshotHash: hash,
      }));

      this.emit('heartbeat.fired', { id: c.id, topicId: c.topicId, templated: !snapshot || unchanged });
    } finally {
      this.config.proxyCoordinator.release(c.topicId, 'promise-beacon');
    }

    // Re-arm.
    const next = this.config.commitmentTracker.getAll().find(x => x.id === id);
    if (next) this.schedule(next);
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async suppress(c: Commitment, reason: string): Promise<void> {
    await this.config.commitmentTracker.mutate(c.id, prev => ({
      ...prev,
      beaconSuppressed: true,
      beaconSuppressionReason: reason,
    }));
    this.emit('heartbeat.skipped', { id: c.id, reason });
    // Re-arm for re-evaluation: 10min window for quiet-hours, 1h for cap.
    const reArmDelay = reason === 'quiet-hours' ? 10 * 60_000 : 60 * 60_000;
    const timer = setTimeout(() => {
      this.timers.delete(c.id);
      // Clear suppression flag on re-evaluation attempt.
      this.config.commitmentTracker
        .mutate(c.id, prev => ({ ...prev, beaconSuppressed: false, beaconSuppressionReason: undefined }))
        .then(updated => this.schedule(updated))
        .catch(() => { /* ok — commitment may be terminal */ });
    }, reArmDelay * this.timerMult);
    timer.unref?.();
    this.timers.set(c.id, timer);
  }

  private async transitionViolated(c: Commitment, reason: string): Promise<void> {
    await this.config.commitmentTracker.mutate(c.id, prev => ({
      ...prev,
      status: 'violated',
      resolvedAt: new Date().toISOString(),
      resolution: reason,
    }));
    if (c.topicId) {
      await this.config.sendMessage(
        c.topicId,
        `⚠️ [promise-beacon] commitment "${(c.agentResponse || c.userRequest).slice(0, 80)}" violated: ${reason}`,
        { source: 'promise-beacon', isProxy: true, tier: 1 },
      );
    }
    this.stopFor(c.id);
    this.emit('promise.violated', { id: c.id, reason });
  }

  private inQuietHours(): boolean {
    const qh = this.config.quietHours;
    if (!qh) return false;
    const [sH, sM] = (qh.start || '22:00').split(':').map(Number);
    const [eH, eM] = (qh.end || '08:00').split(':').map(Number);
    const d = new Date(this.now());
    const mins = d.getHours() * 60 + d.getMinutes();
    const startMin = sH * 60 + sM;
    const endMin = eH * 60 + eM;
    if (startMin < endMin) {
      return mins >= startMin && mins < endMin;
    }
    // Wraps midnight.
    return mins >= startMin || mins < endMin;
  }

  private clampCadence(ms: number): number {
    return Math.min(this.maxCadenceMs, Math.max(this.minCadenceMs, ms));
  }

  private loadHotState(id: string): HotState {
    const p = path.join(this.stateDir, `${id}.json`);
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        heartbeatCount: 0,
        consecutiveUnchanged: 0,
        templatedVariantCursor: 0,
        ...parsed,
      };
    } catch {
      return {
        heartbeatCount: 0,
        consecutiveUnchanged: 0,
        templatedVariantCursor: 0,
      };
    }
  }

  private saveHotState(id: string, hot: HotState): void {
    const p = path.join(this.stateDir, `${id}.json`);
    try {
      fs.writeFileSync(p, JSON.stringify(hot, null, 2));
    } catch (err) {
      console.error(`[PromiseBeacon] persist failed for ${id}:`, (err as Error).message);
    }
  }

  /** Test accessor. */
  getScheduledIds(): string[] {
    return [...this.timers.keys()];
  }
}
