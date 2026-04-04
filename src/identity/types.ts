/**
 * Identity types — Canonical agent identity schema.
 *
 * Implements the Unified Threadline spec (v0.6.0) Section 3.3:
 * - Single Ed25519 keypair shared across all systems
 * - Canonical Agent ID: SHA-256 with domain separation
 * - Display fingerprint: first 8 bytes of canonical ID
 */

import crypto from 'node:crypto';

// ── Constants ────────────────────────────────────────────────────────

/** Domain separation prefix for canonical agent ID derivation */
export const CANONICAL_ID_DOMAIN = 'instar-agent-id-v1';

/** Schema version for identity.json */
export const IDENTITY_SCHEMA_VERSION = 1;

/** Display fingerprint length in bytes (8 bytes = 16 hex chars) */
export const DISPLAY_FINGERPRINT_BYTES = 8;

/** Default TTL for authorization grants (4 hours in ms) */
export const DEFAULT_GRANT_TTL_MS = 4 * 60 * 60 * 1000;

/** Trust decay periods (Section 3.7) */
export const TRUST_DECAY = {
  trustedToVerifiedDays: 90,
  verifiedToUntrustedDays: 180,
} as const;

/** Key rotation grace period (72 hours in ms) */
export const KEY_ROTATION_GRACE_MS = 72 * 60 * 60 * 1000;

/** Recovery time-lock duration (24 hours in ms) */
export const RECOVERY_TIMELOCK_MS = 24 * 60 * 60 * 1000;

/** Max recovery attempts per 24h period */
export const MAX_RECOVERY_ATTEMPTS = 3;

/** Dual-key migration deadline (30 days in ms) */
export const MIGRATION_DEADLINE_MS = 30 * 24 * 60 * 60 * 1000;

// ── Types ────────────────────────────────────────────────────────────

/** Private key encryption methods */
export type PrivateKeyEncryption = 'xchacha20-poly1305+argon2id' | 'none';

/**
 * On-disk identity file schema (identity.json).
 * Private key is encrypted at rest unless in dev mode.
 */
export interface IdentityFile {
  version: typeof IDENTITY_SCHEMA_VERSION;
  publicKey: string;              // Ed25519 public key, base64
  privateKey: string;             // base64(nonce || ciphertext || auth_tag) when encrypted, or raw base64 when 'none'
  privateKeyEncryption: PrivateKeyEncryption;
  keySalt?: string;               // base64(32-byte CSPRNG salt) for Argon2id — present when encrypted
  canonicalId: string;            // SHA-256 hex, 64 chars
  displayFingerprint: string;     // first 8 bytes of canonicalId, hex, 16 chars
  recoveryCommitment?: string;    // recovery public key signed by primary key, base64
  recoverySalt?: string;          // base64(32-byte CSPRNG salt) for recovery key derivation
  createdAt: string;              // ISO-8601
  migrationComplete?: boolean;    // true when dual-key migration is done
  migrationCompletedAt?: string;  // ISO-8601
}

/**
 * In-memory identity with decrypted keys.
 */
export interface CanonicalIdentity {
  version: number;
  publicKey: Buffer;              // 32-byte Ed25519 public key
  privateKey: Buffer;             // 32-byte Ed25519 private key (decrypted)
  x25519PublicKey: Buffer;        // 32-byte X25519 public key (derived)
  canonicalId: string;            // 64-char hex
  displayFingerprint: string;     // 16-char hex
  createdAt: string;
  recoveryCommitment?: string;
  migrationComplete?: boolean;
}

/**
 * Key rotation proof — dual-signed by old and new keys.
 */
export interface RotationProof {
  oldPublicKey: string;           // base64
  newPublicKey: string;           // base64
  timestamp: string;              // ISO-8601
  reason: string;
  oldKeySignature: string;        // base64 — signed by old key
  newKeySignature: string;        // base64 — signed by new key
}

/**
 * Recovery revocation request.
 */
export interface RevocationRequest {
  targetCanonicalId: string;      // agent being revoked
  newPublicKey: string;           // base64 — the replacement key
  recoverySignature: string;      // base64 — signed by recovery keypair
  timestamp: string;              // ISO-8601
  status: 'pending' | 'active' | 'cancelled';
  expiresAt: string;              // ISO-8601 — end of time-lock window
}

// ── Derivation Functions ─────────────────────────────────────────────

/**
 * Compute the canonical agent ID from an Ed25519 public key.
 *
 * canonicalId = SHA-256("instar-agent-id-v1" || publicKey)
 *
 * This is the stable identifier used across all systems.
 */
export function computeCanonicalId(publicKey: Buffer): string {
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from(CANONICAL_ID_DOMAIN, 'utf-8'));
  hash.update(publicKey);
  return hash.digest('hex');
}

/**
 * Compute the display fingerprint from a canonical ID.
 *
 * First 8 bytes (16 hex chars) for human-readable display.
 * Never used for security-critical operations.
 */
export function computeDisplayFingerprint(canonicalId: string): string {
  return canonicalId.slice(0, DISPLAY_FINGERPRINT_BYTES * 2);
}
