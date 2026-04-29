/**
 * HeartbeatWriter — utility used by relay-spawned sessions to emit signed
 * liveness pings the relay-side HeartbeatWatchdog can verify.
 *
 * Component B of RELAY-SPAWN-GHOST-REPLY-CONTAINMENT-SPEC. The spawned
 * session reads its per-spawn HMAC nonce from FD 3 once at boot, then
 * uses it to sign a heartbeat payload written via atomic-rename to
 * `.instar/threadline/sessions/<threadId>.alive` on a fixed cadence.
 *
 * Atomic-rename is mandatory: it eliminates the half-write race the
 * round-1 review found between writer-flushing and watchdog-reading.
 *
 * Authority classification: pure side-effect-only utility. No decisions,
 * no signals consumed. The session that imports this is the one being
 * watched; integrity comes from the signature, not from this code.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface HeartbeatPayloadFields {
  /** Spawn ledger eventId — must match the row this nonce was reserved for. */
  eventId: string;
  /** Process id of the session writing this heartbeat. */
  sessionPid: number;
  /** Thread id this session is servicing. */
  threadId: string;
  /** Epoch ms — used by watchdog to detect stale heartbeats. */
  ts: number;
}

export interface HeartbeatEnvelope extends HeartbeatPayloadFields {
  /** Hex SHA-256 HMAC of the canonical payload string under the spawn nonce. */
  hmac: string;
}

/**
 * Build the canonical signing string. The watchdog reconstructs this
 * EXACTLY when verifying, so any reordering or extra whitespace breaks
 * verification. Field order is locked: evt:pid:tid:ts.
 */
export function canonicalHeartbeatPayload(p: HeartbeatPayloadFields): string {
  return `evt:${p.eventId}:pid:${p.sessionPid}:tid:${p.threadId}:ts:${p.ts}`;
}

export interface HeartbeatWriterOptions {
  /** Directory containing per-thread `.alive` files. */
  sessionsDir: string;
  /** Per-spawn HMAC nonce, read once from FD 3 by the spawned session. */
  spawnNonce: Buffer;
  /** Spawn ledger eventId this session was reserved under. */
  eventId: string;
  /** Thread id this session is servicing. */
  threadId: string;
  /** Process id (defaults to current process). */
  sessionPid?: number;
}

export class HeartbeatWriter {
  private readonly opts: Required<HeartbeatWriterOptions>;
  private readonly targetPath: string;

  constructor(opts: HeartbeatWriterOptions) {
    if (!opts.spawnNonce || opts.spawnNonce.length !== 32) {
      throw new Error('HeartbeatWriter requires a 32-byte spawnNonce');
    }
    if (!opts.eventId || !opts.threadId || !opts.sessionsDir) {
      throw new Error(
        'HeartbeatWriter requires sessionsDir, eventId, threadId',
      );
    }
    this.opts = {
      sessionPid: process.pid,
      ...opts,
    };
    this.targetPath = path.join(this.opts.sessionsDir, `${opts.threadId}.alive`);
    fs.mkdirSync(this.opts.sessionsDir, { recursive: true });
  }

  /**
   * Write a heartbeat now. Atomic: writes to a tmp file in the same dir,
   * then renames over the target. Watchdog will only see complete files.
   */
  write(now = Date.now()): HeartbeatEnvelope {
    const fields: HeartbeatPayloadFields = {
      eventId: this.opts.eventId,
      sessionPid: this.opts.sessionPid,
      threadId: this.opts.threadId,
      ts: now,
    };
    const payload = canonicalHeartbeatPayload(fields);
    const hmac = crypto
      .createHmac('sha256', this.opts.spawnNonce)
      .update(payload)
      .digest('hex');
    const env: HeartbeatEnvelope = { ...fields, hmac };

    // Atomic write: tmp in same directory then rename.
    const tmp = `${this.targetPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(env), { mode: 0o600 });
    fs.renameSync(tmp, this.targetPath);
    return env;
  }

  /** Path the writer targets — exposed for diagnostics. */
  get path(): string {
    return this.targetPath;
  }
}

/**
 * Read the per-spawn nonce from FD 3 exactly once. Called by spawned
 * sessions at boot. Returns null if FD 3 is not a pipe or contains no
 * data — caller MUST treat null as "no spawn-guard active for this
 * session" and skip heartbeat writing (the watchdog will then mark it
 * heartbeat-missing, which is correct fail-closed behavior).
 *
 * Why FD 3 and not env: the round-1 review noted that env vars are
 * inherited by every fork-helper a session may spawn (build tools,
 * shells), giving them the nonce. FD 3 is single-read by design and
 * does not propagate.
 */
export function readSpawnNonceFromFd3(): Buffer | null {
  try {
    // FD 3 is the convention for inherited-pipe handoff per spec.
    const buf = fs.readFileSync(3);
    if (!buf || buf.length === 0) return null;
    // Nonce is exactly 32 bytes. If FD 3 carries anything else, treat
    // as absent rather than guessing — fail-closed.
    if (buf.length !== 32) return null;
    return buf;
  } catch {
    return null;
  }
}

/**
 * Default sessions-dir convention. Single source of truth used by both
 * the writer (in spawned sessions) and the watchdog (in the relay).
 */
export function defaultSessionsDir(stateDir: string = path.join(os.homedir(), '.instar')): string {
  return path.join(stateDir, 'threadline', 'sessions');
}
