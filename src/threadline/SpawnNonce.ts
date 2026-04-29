/**
 * SpawnNonce — relay-side helpers for binding a SpawnLedger reservation
 * to a freshly-spawned session via FD 3 inheritance, and for deriving a
 * deterministic eventId from envelope material.
 *
 * Component A glue for RELAY-SPAWN-GHOST-REPLY-CONTAINMENT-SPEC. The
 * reader counterpart (`readSpawnNonceFromFd3`) lives in HeartbeatWriter
 * since it runs in the spawned session, not the relay.
 *
 * Why FD 3 and not env: round-1 review surfaced that env vars propagate
 * to every fork-helper a session may spawn (build tools, shells), giving
 * those processes the nonce. FD 3 is single-read by the spawned process
 * and is closed by the relay immediately after handoff.
 */

import crypto from 'node:crypto';
import type { SpawnOptions, StdioOptions } from 'node:child_process';

import type { MessageEnvelope } from '../messaging/types.js';

/**
 * Deterministic eventId from envelope material. Bound to:
 *   - sender identity (signedBy or hmacBy on transport metadata)
 *   - the transport-layer nonce (already used for replay prevention)
 *   - the application-level message id
 *
 * Why this triple: any one alone is insufficient. The transport nonce is
 * unique per delivery but not authenticated to a specific message body
 * (a relay or attacker could re-route the same nonce with a different
 * payload). Combining with the signed-by + message id binds the eventId
 * to "this exact message from this exact sender via this exact relay
 * delivery". Replays produce the same eventId → ledger CAS rejects.
 */
export function deriveEventId(envelope: MessageEnvelope): string {
  const t = envelope.transport;
  const signer = t.signedBy ?? t.hmacBy ?? '<unsigned>';
  const nonce = t.nonce ?? '<no-nonce>';
  const msgId = envelope.message?.id ?? '<no-msg-id>';
  return crypto
    .createHash('sha256')
    .update(`${signer}\x00${nonce}\x00${msgId}`)
    .digest('hex');
}

/**
 * Open a pipe, write the per-spawn nonce into it, return both ends so
 * the caller can hand the read end to child_process.spawn() via FD 3
 * and close the write end after spawn returns.
 *
 * Node's child_process does not expose POSIX pipe(2) directly, so we use
 * a tmpfile + open-for-read pattern as a portable substitute. The file
 * is unlinked immediately after open so even root cannot read it from
 * disk after the spawn returns.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export interface NonceFdHandle {
  /** Read FD to be passed as stdio[3] to child_process.spawn(). */
  readFd: number;
  /** Call after spawn returns to release the relay-side handle. */
  close: () => void;
}

export function prepareNonceFd(spawnNonce: Buffer): NonceFdHandle {
  if (spawnNonce.length !== 32) {
    throw new Error('SpawnNonce.prepareNonceFd requires a 32-byte nonce');
  }
  // tmpfile in os.tmpdir(); 0o600; immediately unlinked after open.
  const tmp = path.join(
    os.tmpdir(),
    `instar-spawn-nonce-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
  );
  fs.writeFileSync(tmp, spawnNonce, { mode: 0o600 });
  const readFd = fs.openSync(tmp, 'r');
  // Unlink immediately; the open FD keeps the inode alive only as long
  // as one of the processes holds it.
  try {
    SafeFsExecutor.safeUnlinkSync(tmp, { operation: 'SpawnNonce.prepareNonceFd' });
  } catch {
    /* best-effort */
  }
  return {
    readFd,
    close: () => {
      try {
        fs.closeSync(readFd);
      } catch {
        /* already closed */
      }
    },
  };
}

/**
 * Build a stdio array suitable for child_process.spawn() that inherits
 * stdin/stdout/stderr from the parent and binds FD 3 to the nonce read
 * end. Caller owns calling handle.close() AFTER spawn returns.
 */
export function stdioWithNonceFd(handle: NonceFdHandle): StdioOptions {
  return ['inherit', 'inherit', 'inherit', handle.readFd];
}

/**
 * Convenience: enrich a SpawnOptions with FD-3 nonce binding. Returns a
 * new options object plus the handle to close after spawn.
 */
export function withNonceFd(
  baseOpts: SpawnOptions,
  handle: NonceFdHandle,
): SpawnOptions {
  return {
    ...baseOpts,
    stdio: stdioWithNonceFd(handle),
  };
}
