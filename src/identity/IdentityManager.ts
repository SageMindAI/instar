/**
 * CanonicalIdentityManager — Manages the agent's canonical Ed25519 identity.
 *
 * Stores identity at {stateDir}/identity.json with encrypted private key.
 * This is the single source of truth for agent identity across all systems
 * (Threadline, MoltBridge, A2A).
 *
 * Spec Section 3.3: Single keypair, managed by Instar, used by both systems.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateIdentityKeyPair } from '../threadline/ThreadlineCrypto.js';
import { deriveX25519PublicKey } from '../threadline/client/MessageEncryptor.js';
import { encryptPrivateKey, decryptPrivateKey, generateSalt } from './KeyEncryption.js';
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
  type CanonicalIdentity,
  type IdentityFile,
  type PrivateKeyEncryption,
} from './types.js';

// ── Types ────────────────────────────────────────────────────────────

export interface CreateIdentityOptions {
  /** Passphrase for encrypting the private key. If omitted, key stored unencrypted (dev mode). */
  passphrase?: string;
  /** Skip recovery phrase generation (for testing). */
  skipRecovery?: boolean;
}

export interface CreateIdentityResult {
  identity: CanonicalIdentity;
  /** The 24-word recovery phrase. Only returned on creation — never persisted by the manager. */
  recoveryPhrase?: string;
}

export interface LoadIdentityOptions {
  /** Passphrase for decrypting the private key. Required if key was encrypted. */
  passphrase?: string;
}

// ── Manager ──────────────────────────────────────────────────────────

export class CanonicalIdentityManager {
  private readonly stateDir: string;
  private readonly identityFile: string;
  private identity: CanonicalIdentity | null = null;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.identityFile = path.join(stateDir, 'identity.json');
  }

  /**
   * Create a new canonical identity.
   *
   * Generates Ed25519 keypair, optional recovery phrase, encrypts private key,
   * and writes identity.json.
   *
   * @returns The identity and (if generated) the recovery phrase.
   *          The recovery phrase is ONLY returned here — it must be shown to the user
   *          and never stored by the system.
   */
  create(options: CreateIdentityOptions = {}): CreateIdentityResult {
    const keypair = generateIdentityKeyPair();
    const canonicalId = computeCanonicalId(keypair.publicKey);
    const displayFingerprint = computeDisplayFingerprint(canonicalId);

    let recoveryPhrase: string | undefined;
    let recoveryCommitment: string | undefined;
    let recoverySalt: string | undefined;

    if (!options.skipRecovery) {
      recoveryPhrase = generateRecoveryPhrase();
      const rSalt = generateRecoverySalt();
      const recoveryKeypair = deriveRecoveryKeypair(recoveryPhrase, rSalt);
      recoveryCommitment = createRecoveryCommitment(recoveryKeypair.publicKey, keypair.privateKey);
      recoverySalt = rSalt.toString('base64');
    }

    // Encrypt private key (or store plaintext in dev mode)
    let privateKeyData: string;
    let encryption: PrivateKeyEncryption;
    let keySalt: string | undefined;

    if (options.passphrase !== undefined) {
      const salt = generateSalt();
      privateKeyData = encryptPrivateKey(keypair.privateKey, options.passphrase, salt);
      encryption = 'xchacha20-poly1305+argon2id';
      keySalt = salt.toString('base64');
    } else {
      privateKeyData = keypair.privateKey.toString('base64');
      encryption = 'none';
    }

    const file: IdentityFile = {
      version: IDENTITY_SCHEMA_VERSION,
      publicKey: keypair.publicKey.toString('base64'),
      privateKey: privateKeyData,
      privateKeyEncryption: encryption,
      ...(keySalt && { keySalt }),
      canonicalId,
      displayFingerprint,
      ...(recoveryCommitment && { recoveryCommitment }),
      ...(recoverySalt && { recoverySalt }),
      createdAt: new Date().toISOString(),
    };

    this.writeToDisk(file);

    const identity: CanonicalIdentity = {
      version: IDENTITY_SCHEMA_VERSION,
      publicKey: keypair.publicKey,
      privateKey: keypair.privateKey,
      x25519PublicKey: deriveX25519PublicKey(keypair.privateKey),
      canonicalId,
      displayFingerprint,
      createdAt: file.createdAt,
      recoveryCommitment,
    };

    this.identity = identity;
    return { identity, recoveryPhrase };
  }

  /**
   * Load an existing identity from disk.
   *
   * @param options.passphrase Required if the private key is encrypted.
   * @returns The decrypted identity, or null if no identity exists.
   * @throws Error if passphrase is wrong or file is corrupted.
   */
  load(options: LoadIdentityOptions = {}): CanonicalIdentity | null {
    if (this.identity) return this.identity;

    const file = this.readFromDisk();
    if (!file) return null;

    let privateKey: Buffer;

    if (file.privateKeyEncryption === 'none') {
      privateKey = Buffer.from(file.privateKey, 'base64');
    } else if (file.privateKeyEncryption === 'xchacha20-poly1305+argon2id') {
      if (!options.passphrase && options.passphrase !== '') {
        throw new Error('Passphrase required to decrypt identity');
      }
      if (!file.keySalt) {
        throw new Error('Identity file missing keySalt for encrypted key');
      }
      const salt = Buffer.from(file.keySalt, 'base64');
      privateKey = decryptPrivateKey(file.privateKey, options.passphrase!, salt);
    } else {
      throw new Error(`Unknown encryption method: ${file.privateKeyEncryption}`);
    }

    const identity: CanonicalIdentity = {
      version: file.version,
      publicKey: Buffer.from(file.publicKey, 'base64'),
      privateKey,
      x25519PublicKey: deriveX25519PublicKey(privateKey),
      canonicalId: file.canonicalId,
      displayFingerprint: file.displayFingerprint,
      createdAt: file.createdAt,
      recoveryCommitment: file.recoveryCommitment,
      migrationComplete: file.migrationComplete,
    };

    this.identity = identity;
    return identity;
  }

  /**
   * Get the current identity (must have been created or loaded first).
   */
  get(): CanonicalIdentity | null {
    return this.identity;
  }

  /**
   * Check if an identity file exists on disk.
   */
  exists(): boolean {
    return fs.existsSync(this.identityFile);
  }

  /**
   * Get the identity file path.
   */
  get filePath(): string {
    return this.identityFile;
  }

  /**
   * Read the raw identity file (without decrypting).
   * Useful for checking encryption status or migration state.
   */
  readRaw(): IdentityFile | null {
    return this.readFromDisk();
  }

  // ── Private ─────────────────────────────────────────────────────

  private readFromDisk(): IdentityFile | null {
    try {
      if (!fs.existsSync(this.identityFile)) return null;
      const raw = fs.readFileSync(this.identityFile, 'utf-8');
      return JSON.parse(raw) as IdentityFile;
    } catch {
      return null;
    }
  }

  private writeToDisk(file: IdentityFile): void {
    fs.mkdirSync(path.dirname(this.identityFile), { recursive: true });

    const data = JSON.stringify(file, null, 2);
    const tmpPath = `${this.identityFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, data, { mode: 0o600 });
    fs.renameSync(tmpPath, this.identityFile);
  }
}
