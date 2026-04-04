/**
 * Migration — Bridge legacy Threadline identity to canonical identity.
 *
 * Legacy: {stateDir}/threadline/identity.json (unencrypted, fingerprint-based)
 * Canonical: {stateDir}/identity.json (encrypted, canonical ID + display fingerprint)
 *
 * Migration preserves the same Ed25519 keypair — only the storage location
 * and metadata format change. The agent's identity (public key) doesn't change.
 */

import fs from 'node:fs';
import path from 'node:path';
import { deriveX25519PublicKey } from '../threadline/client/MessageEncryptor.js';
import { encryptPrivateKey, generateSalt } from './KeyEncryption.js';
import {
  generateRecoveryPhrase,
  deriveRecoveryKeypair,
  createRecoveryCommitment,
  generateRecoverySalt,
} from './RecoveryPhrase.js';
import {
  computeCanonicalId,
  computeDisplayFingerprint,
  IDENTITY_SCHEMA_VERSION,
  type IdentityFile,
  type CanonicalIdentity,
} from './types.js';

// ── Types ────────────────────────────────────────────────────────────

/** Legacy identity.json format from Threadline */
interface LegacyIdentityFile {
  fingerprint: string;
  publicKey: string;       // base64
  privateKey: string;      // base64 (unencrypted)
  x25519PublicKey?: string; // base64
  createdAt: string;
}

export interface MigrationOptions {
  /** Passphrase to encrypt the private key in the new format. Omit for dev mode. */
  passphrase?: string;
  /** Skip recovery phrase generation. */
  skipRecovery?: boolean;
}

export interface MigrationResult {
  identity: CanonicalIdentity;
  /** The 24-word recovery phrase, if generated. Show to user once. */
  recoveryPhrase?: string;
  /** Path to the legacy file that was migrated from. */
  legacyPath: string;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Check if a legacy Threadline identity exists.
 */
export function hasLegacyIdentity(stateDir: string): boolean {
  return fs.existsSync(path.join(stateDir, 'threadline', 'identity.json'));
}

/**
 * Check if a canonical identity already exists.
 */
export function hasCanonicalIdentity(stateDir: string): boolean {
  return fs.existsSync(path.join(stateDir, 'identity.json'));
}

/**
 * Migrate a legacy Threadline identity to the canonical format.
 *
 * Reads the legacy identity, creates the canonical identity.json with the
 * same keypair, and optionally encrypts the private key. The legacy file
 * is NOT deleted (preserved for rollback per spec Section 3.10).
 *
 * @returns The migrated identity and optional recovery phrase.
 * @throws If no legacy identity exists or canonical already exists.
 */
export function migrateFromLegacy(
  stateDir: string,
  options: MigrationOptions = {},
): MigrationResult {
  const legacyPath = path.join(stateDir, 'threadline', 'identity.json');
  const canonicalPath = path.join(stateDir, 'identity.json');

  if (!fs.existsSync(legacyPath)) {
    throw new Error('No legacy identity found at ' + legacyPath);
  }

  if (fs.existsSync(canonicalPath)) {
    throw new Error('Canonical identity already exists — migration not needed');
  }

  // Read legacy identity
  const legacyRaw = JSON.parse(fs.readFileSync(legacyPath, 'utf-8')) as LegacyIdentityFile;
  const publicKey = Buffer.from(legacyRaw.publicKey, 'base64');
  const privateKey = Buffer.from(legacyRaw.privateKey, 'base64');

  // Compute new canonical identifiers
  const canonicalId = computeCanonicalId(publicKey);
  const displayFingerprint = computeDisplayFingerprint(canonicalId);

  // Recovery phrase
  let recoveryPhrase: string | undefined;
  let recoveryCommitment: string | undefined;
  let recoverySalt: string | undefined;

  if (!options.skipRecovery) {
    recoveryPhrase = generateRecoveryPhrase();
    const rSalt = generateRecoverySalt();
    const recoveryKeypair = deriveRecoveryKeypair(recoveryPhrase, rSalt);
    recoveryCommitment = createRecoveryCommitment(recoveryKeypair.publicKey, privateKey);
    recoverySalt = rSalt.toString('base64');
  }

  // Encrypt private key
  let privateKeyData: string;
  let keySalt: string | undefined;

  if (options.passphrase !== undefined) {
    const salt = generateSalt();
    privateKeyData = encryptPrivateKey(privateKey, options.passphrase, salt);
    keySalt = salt.toString('base64');
  } else {
    privateKeyData = legacyRaw.privateKey; // keep the same base64
  }

  // Build canonical identity file
  const file: IdentityFile = {
    version: IDENTITY_SCHEMA_VERSION,
    publicKey: legacyRaw.publicKey,
    privateKey: privateKeyData,
    privateKeyEncryption: options.passphrase !== undefined ? 'xchacha20-poly1305+argon2id' : 'none',
    ...(keySalt && { keySalt }),
    canonicalId,
    displayFingerprint,
    ...(recoveryCommitment && { recoveryCommitment }),
    ...(recoverySalt && { recoverySalt }),
    createdAt: legacyRaw.createdAt,
  };

  // Write canonical identity (legacy file preserved for rollback)
  fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
  const tmpPath = `${canonicalPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(file, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, canonicalPath);

  const identity: CanonicalIdentity = {
    version: IDENTITY_SCHEMA_VERSION,
    publicKey,
    privateKey,
    x25519PublicKey: deriveX25519PublicKey(privateKey),
    canonicalId,
    displayFingerprint,
    createdAt: legacyRaw.createdAt,
    recoveryCommitment,
  };

  return { identity, recoveryPhrase, legacyPath };
}

/**
 * Get the legacy Threadline fingerprint for backward compatibility mapping.
 *
 * Returns the old-style fingerprint (first 16 bytes of public key, hex)
 * so existing Threadline contacts can still find this agent during migration.
 */
export function getLegacyFingerprint(stateDir: string): string | null {
  const legacyPath = path.join(stateDir, 'threadline', 'identity.json');
  try {
    if (!fs.existsSync(legacyPath)) return null;
    const raw = JSON.parse(fs.readFileSync(legacyPath, 'utf-8')) as LegacyIdentityFile;
    return raw.fingerprint;
  } catch {
    return null;
  }
}
