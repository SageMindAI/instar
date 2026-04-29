/**
 * HeartbeatWatchdog — single shared 1s poller for relay-spawned session
 * heartbeats.
 *
 * Component B of RELAY-SPAWN-GHOST-REPLY-CONTAINMENT-SPEC. Each tick it
 * reads `.instar/threadline/sessions/*.alive`, verifies the HMAC against
 * the SpawnLedger row, checks process liveness, and emits structured
 * signals to the registered consumer. Per round-2 review: ONE poller for
 * the whole relay (not per-session), or fan-out scales O(n²) on busy
 * peers.
 *
 * Authority classification (per docs/signal-vs-authority.md): pure
 * SIGNAL-PRODUCER. Emits typed signals; never blocks, never kills, never
 * decides retry-vs-suppress. The consumer (RelaySpawnFailureHandler) is
 * the smart authority that owns those decisions.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { SpawnLedger, SpawnLedgerRow } from './SpawnLedger.js';
import {
  canonicalHeartbeatPayload,
  type HeartbeatEnvelope,
} from './HeartbeatWriter.js';

// ── Signal types ─────────────────────────────────────────────────────

export type HeartbeatSignalKind =
  | 'heartbeat-verified'
  | 'heartbeat-missing'
  | 'heartbeat-forged'
  | 'heartbeat-stale'
  | 'heartbeat-pid-dead';

export interface HeartbeatSignal {
  kind: HeartbeatSignalKind;
  /** Spawn ledger eventId this signal is about. */
  eventId: string;
  /** Thread the heartbeat (or absence) was for. */
  threadId: string;
  /** Best-known peer for this row; undefined if ledger row missing. */
  peerId?: string;
  /** Epoch ms when the signal was raised. */
  raisedAt: number;
  /** Human-readable detail for logs. Stable strings, not free-form. */
  detail: string;
  /** Underlying ledger row at time of signal, if available. */
  row?: SpawnLedgerRow;
}

export type HeartbeatSignalConsumer = (sig: HeartbeatSignal) => void;

// ── Watchdog ─────────────────────────────────────────────────────────

export interface HeartbeatWatchdogOptions {
  /** Directory containing per-thread `.alive` files. */
  sessionsDir: string;
  /** Spawn ledger to look up nonces and current row state. */
  ledger: SpawnLedger;
  /** Where to send structured signals. Required. */
  consumer: HeartbeatSignalConsumer;
  /** First-heartbeat deadline (ms). Default 5000. Spec §Component B. */
  firstHeartbeatGraceMs?: number;
  /** Refresh cadence the writer is expected to honor (ms). Default 10000. */
  refreshCadenceMs?: number;
  /** Liveness check via kill(pid, 0). Default true. */
  checkPidLiveness?: boolean;
  /** Now-source for tests. */
  now?: () => number;
}

export class HeartbeatWatchdog {
  private readonly sessionsDir: string;
  private readonly ledger: SpawnLedger;
  private readonly consumer: HeartbeatSignalConsumer;
  private readonly firstHeartbeatGraceMs: number;
  private readonly refreshCadenceMs: number;
  private readonly checkPidLiveness: boolean;
  private readonly now: () => number;

  /** eventIds we've already emitted a 'heartbeat-verified' signal for. */
  private readonly verifiedOnce = new Set<string>();
  /** eventIds we've already emitted a terminal failure signal for. */
  private readonly terminalSignaled = new Set<string>();

  private timer: NodeJS.Timeout | null = null;

  constructor(opts: HeartbeatWatchdogOptions) {
    this.sessionsDir = opts.sessionsDir;
    this.ledger = opts.ledger;
    this.consumer = opts.consumer;
    this.firstHeartbeatGraceMs = opts.firstHeartbeatGraceMs ?? 5_000;
    this.refreshCadenceMs = opts.refreshCadenceMs ?? 10_000;
    this.checkPidLiveness = opts.checkPidLiveness ?? true;
    this.now = opts.now ?? Date.now;
    fs.mkdirSync(this.sessionsDir, { recursive: true });
  }

  /** Start the 1s tick. Idempotent. */
  start(intervalMs: number = 1_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch {
        /* tick must never throw — single poller for the whole relay */
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  /** Stop the tick. Idempotent. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One pass: enumerate spawning rows, check each for heartbeat health.
   * Public so tests and integration code can drive deterministic ticks.
   */
  tick(): HeartbeatSignal[] {
    const emitted: HeartbeatSignal[] = [];
    const spawning = this.ledger.listSpawning();
    for (const row of spawning) {
      if (this.terminalSignaled.has(row.eventId)) continue;
      const sig = this.evaluateRow(row);
      if (sig) {
        // Suppress repeat 'verified' beyond the first.
        if (sig.kind === 'heartbeat-verified') {
          if (this.verifiedOnce.has(row.eventId)) continue;
          this.verifiedOnce.add(row.eventId);
        } else {
          this.terminalSignaled.add(row.eventId);
        }
        this.consumer(sig);
        emitted.push(sig);
      }
    }
    return emitted;
  }

  private evaluateRow(row: SpawnLedgerRow): HeartbeatSignal | null {
    const { eventId, peerId, spawnedAt } = row;
    const now = this.now();
    const ageMs = now - spawnedAt;

    // Locate the .alive file. We don't know threadId from the ledger
    // (intentionally — ledger is per-event, not per-thread). Scan once.
    const alive = this.findHeartbeatForEvent(eventId);

    if (!alive) {
      // No heartbeat yet. If still inside grace window, no signal.
      if (ageMs <= this.firstHeartbeatGraceMs) return null;
      return {
        kind: 'heartbeat-missing',
        eventId,
        threadId: '<unknown>',
        peerId,
        raisedAt: now,
        detail: `no .alive file after ${ageMs}ms (grace ${this.firstHeartbeatGraceMs}ms)`,
        row,
      };
    }

    const { envelope, threadId } = alive;

    // Verify HMAC against the ledger nonce.
    const payload = canonicalHeartbeatPayload({
      eventId: envelope.eventId,
      sessionPid: envelope.sessionPid,
      threadId: envelope.threadId,
      ts: envelope.ts,
    });
    const valid = this.ledger.verifyHeartbeatHmac(eventId, payload, envelope.hmac);
    if (!valid || envelope.eventId !== eventId) {
      return {
        kind: 'heartbeat-forged',
        eventId,
        threadId,
        peerId,
        raisedAt: now,
        detail: valid
          ? `eventId mismatch in payload (${envelope.eventId} vs ledger ${eventId})`
          : 'HMAC verification failed',
        row,
      };
    }

    // Heartbeat must be fresh (within 2× refresh cadence per spec).
    const heartbeatAge = now - envelope.ts;
    if (heartbeatAge > this.refreshCadenceMs * 2) {
      return {
        kind: 'heartbeat-stale',
        eventId,
        threadId,
        peerId,
        raisedAt: now,
        detail: `heartbeat ${heartbeatAge}ms old, max ${this.refreshCadenceMs * 2}ms`,
        row,
      };
    }

    // Pid must still be alive — caught the round-1 fork-and-crash case.
    if (this.checkPidLiveness && !this.isPidAlive(envelope.sessionPid)) {
      return {
        kind: 'heartbeat-pid-dead',
        eventId,
        threadId,
        peerId,
        raisedAt: now,
        detail: `pid ${envelope.sessionPid} not running`,
        row,
      };
    }

    return {
      kind: 'heartbeat-verified',
      eventId,
      threadId,
      peerId,
      raisedAt: now,
      detail: `heartbeat ok, age ${heartbeatAge}ms`,
      row,
    };
  }

  private findHeartbeatForEvent(
    eventId: string,
  ): { envelope: HeartbeatEnvelope; threadId: string } | null {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.sessionsDir);
    } catch {
      return null;
    }
    for (const name of entries) {
      if (!name.endsWith('.alive')) continue;
      const full = path.join(this.sessionsDir, name);
      try {
        const raw = fs.readFileSync(full, 'utf8');
        const env = JSON.parse(raw) as HeartbeatEnvelope;
        if (env.eventId === eventId) {
          return { envelope: env, threadId: name.replace(/\.alive$/, '') };
        }
      } catch {
        /* skip malformed */
      }
    }
    return null;
  }

  private isPidAlive(pid: number): boolean {
    if (!pid || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e: unknown) {
      // ESRCH = no such process. EPERM = exists but unsigned-able (alive).
      if (
        e instanceof Error &&
        'code' in e &&
        (e as { code?: string }).code === 'EPERM'
      ) {
        return true;
      }
      return false;
    }
  }
}
