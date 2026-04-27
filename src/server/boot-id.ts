/**
 * boot-id — manages the per-server boot identifier the Layer 3 sentinel
 * uses to detect stale lease ownership across restarts.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § 3b "Lock & lease".
 *
 * Why a boot id:
 *   - The sentinel writes `claimed_by = "<bootId>:<pid>:<leaseUntil>"` on
 *     each lease. PIDs are reused across reboots — so a row claimed by
 *     PID 4242 yesterday could match a freshly-spawned PID 4242 today
 *     and look "still owned." A bootId rules out that race: a row whose
 *     bootId differs from this server's is unconditionally reclaimable.
 *   - The id MUST be unguessable so an adversary with disk access cannot
 *     forge a `claimed_by` that locks rows. We use 16 bytes from
 *     `crypto.randomBytes` and store hex-encoded.
 *   - The id MUST be created BEFORE the listener binds, so the sentinel
 *     (which the spec wants to start ~5s after boot) doesn't race a
 *     half-initialized server.
 *
 * Persistence:
 *   - File: `<stateDir>/state/boot.id` (mode 0600)
 *   - Persists across restarts within the same instar minor version.
 *   - Rotates on minor-version bump — see `getOrCreateBootId(stateDir, currentVersion)`.
 *     The version envelope means an `instar update` that changes the
 *     queue schema (or sentinel semantics) gets a fresh boot id, so old
 *     in-flight leases from the prior version don't survive the upgrade.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

interface BootIdEnvelope {
  bootId: string;
  /** Major.Minor — patch ignored for rotation purposes. */
  minor: string;
  createdAt: string;
}

let cached: { path: string; bootId: string } | null = null;

export function bootIdPath(stateDir: string): string {
  return path.join(stateDir, 'state', 'boot.id');
}

/**
 * Synchronously load or create the boot id at `<stateDir>/state/boot.id`.
 *
 * Behavior:
 *   1. If the file exists and its envelope minor matches the current
 *      minor, reuse the existing bootId.
 *   2. Otherwise, generate a fresh 16-byte hex id and atomically write it
 *      (via `<file>.tmp` + rename), then chmod 0600.
 *
 * Atomicity: write to `<path>.tmp`, fsync, rename to `<path>`. The rename
 * is atomic on POSIX. Crash mid-write leaves `<path>.tmp` orphaned — a
 * subsequent boot will overwrite it. The envelope is JSON so a
 * partial-write garbage file fails parsing and triggers regeneration.
 *
 * `currentVersion` accepts any semver-shaped string ("0.28.66" or
 * "1.2.3-beta+build" — we extract major.minor and ignore the rest).
 * Pass `undefined` to disable version-bump rotation (tests / standalone
 * usage); the boot id will then persist forever once created.
 */
export function getOrCreateBootId(stateDir: string, currentVersion?: string): string {
  const target = bootIdPath(stateDir);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  const minor = currentVersion ? extractMinor(currentVersion) : '*';

  // Try to read existing envelope.
  if (fs.existsSync(target)) {
    try {
      const raw = fs.readFileSync(target, 'utf-8');
      const env = JSON.parse(raw) as BootIdEnvelope;
      if (
        env &&
        typeof env.bootId === 'string' &&
        /^[0-9a-f]{32}$/.test(env.bootId) &&
        (minor === '*' || env.minor === minor)
      ) {
        cached = { path: target, bootId: env.bootId };
        return env.bootId;
      }
    } catch {
      // Corrupt file → regenerate below.
    }
  }

  // Regenerate.
  const bootId = randomBytes(16).toString('hex');
  const envelope: BootIdEnvelope = {
    bootId,
    minor,
    createdAt: new Date().toISOString(),
  };
  const tmp = `${target}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(envelope));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // best-effort on platforms that don't honor mode bits
  }

  cached = { path: target, bootId };
  return bootId;
}

/**
 * Return the currently-cached boot id. `getOrCreateBootId` must have
 * been called first. Returns `null` if not yet initialized — never
 * raises so callers (sentinel, tests) can decide how to handle the
 * "server isn't fully up yet" case.
 */
export function getCurrentBootId(): string | null {
  return cached?.bootId ?? null;
}

/** Test-only — clear the in-memory cache. Does NOT touch the file. */
export function _resetCacheForTest(): void {
  cached = null;
}

function extractMinor(version: string): string {
  const m = /^(\d+)\.(\d+)/.exec(version);
  if (!m) return version;
  return `${m[1]}.${m[2]}`;
}
