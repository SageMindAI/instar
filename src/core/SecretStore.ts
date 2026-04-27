/**
 * Encrypted secret storage and forward-secret sync protocol.
 *
 * At-rest encryption:
 *   - Master key stored in OS keychain (macOS Keychain, Linux Secret Service)
 *   - File fallback for headless servers (.instar/machine/secrets-master.key, 0600)
 *   - AES-256-GCM encryption of secret store
 *
 * Wire encryption (for sync between machines):
 *   - Ephemeral X25519 ECDH key exchange
 *   - HKDF-SHA256 key derivation
 *   - AES-256-GCM authenticated encryption
 *   - Forward secrecy: ephemeral keys discarded after each transfer
 *
 * Part of Phase 4 (secret sync via tunnel).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

// ── Constants ────────────────────────────────────────────────────────

const KEYCHAIN_SERVICE = 'instar-secret-store';
const KEYCHAIN_ACCOUNT = 'master-key';
const MASTER_KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // AES-256-GCM
const AUTH_TAG_LENGTH = 16;
const HKDF_INFO = 'instar-secret-sync-v1';

// ── Types ────────────────────────────────────────────────────────────

export interface SecretStoreConfig {
  /** State directory (.instar) */
  stateDir: string;
  /** Force file-based key storage (skip keychain) */
  forceFileKey?: boolean;
}

/** The decrypted secrets object (flat key-value or nested) */
export type Secrets = Record<string, unknown>;

/** Encrypted payload for wire transfer */
export interface EncryptedSecretPayload {
  /** Ephemeral X25519 public key (base64) */
  ephemeralPublicKey: string;
  /** AES-256-GCM initialization vector (base64) */
  iv: string;
  /** Encrypted ciphertext (base64) */
  ciphertext: string;
  /** AES-GCM authentication tag (base64) */
  tag: string;
}

// ── Master Key Management ────────────────────────────────────────────

/**
 * Store/retrieve the master key from the OS keychain.
 * Falls back to file-based storage if keychain is unavailable.
 */
export class MasterKeyManager {
  private stateDir: string;
  private forceFile: boolean;
  private keyFilePath: string;

  constructor(stateDir: string, forceFile = false) {
    this.stateDir = stateDir;
    this.forceFile = forceFile;
    this.keyFilePath = path.join(stateDir, 'machine', 'secrets-master.key');
  }

  /** Retrieve or generate the master key. */
  getMasterKey(): Buffer {
    if (!this.forceFile) {
      // Try keychain first
      const keychainKey = this.readKeychain();
      if (keychainKey) return keychainKey;
    }

    // File fallback
    return this.getFileKey();
  }

  /** Whether the master key is stored in the OS keychain (vs file fallback). */
  get isKeychainBacked(): boolean {
    if (this.forceFile) return false;
    try {
      return this.readKeychain() !== null;
    } catch {
      // @silent-fallback-ok — keychain unavailable, file fallback
      return false;
    }
  }

  // ── Keychain ────────────────────────────────────────────────────

  private readKeychain(): Buffer | null {
    if (process.platform === 'darwin') {
      return this.readMacKeychain();
    } else if (process.platform === 'linux') {
      return this.readLinuxKeychain();
    }
    return null; // Windows or unsupported — fall through to file
  }

  private writeKeychain(key: Buffer): boolean {
    if (process.platform === 'darwin') {
      return this.writeMacKeychain(key);
    } else if (process.platform === 'linux') {
      return this.writeLinuxKeychain(key);
    }
    return false;
  }

  private readMacKeychain(): Buffer | null {
    try {
      const result = execFileSync('security', [
        'find-generic-password',
        '-s', KEYCHAIN_SERVICE,
        '-a', KEYCHAIN_ACCOUNT,
        '-w', // Print password only
      ], { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      return Buffer.from(result, 'base64');
    } catch {
      // @silent-fallback-ok — platform keychain read
      return null;
    }
  }

  private writeMacKeychain(key: Buffer): boolean {
    try {
      // Delete existing entry first (ignore errors if it doesn't exist)
      try {
        execFileSync('security', [
          'delete-generic-password',
          '-s', KEYCHAIN_SERVICE,
          '-a', KEYCHAIN_ACCOUNT,
        ], { stdio: 'pipe', timeout: 5000 });
      } catch {
        // @silent-fallback-ok — entry may not exist
      }

      execFileSync('security', [
        'add-generic-password',
        '-s', KEYCHAIN_SERVICE,
        '-a', KEYCHAIN_ACCOUNT,
        '-w', key.toString('base64'),
      ], { stdio: 'pipe', timeout: 5000 });
      return true;
    } catch (err) {
      DegradationReporter.getInstance().report({
        feature: 'SecretStore.writeMacOSKeychain',
        primary: 'Persist master key to macOS keychain',
        fallback: 'Key only in memory — lost on restart',
        reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Master key not persisted, may be lost',
      });
      return false;
    }
  }

  private readLinuxKeychain(): Buffer | null {
    try {
      const result = execFileSync('secret-tool', [
        'lookup',
        'service', KEYCHAIN_SERVICE,
        'account', KEYCHAIN_ACCOUNT,
      ], { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      return Buffer.from(result, 'base64');
    } catch {
      // @silent-fallback-ok — linux keychain read
      return null;
    }
  }

  private writeLinuxKeychain(key: Buffer): boolean {
    try {
      execFileSync('secret-tool', [
        'store',
        '--label', 'Instar Secret Store Master Key',
        'service', KEYCHAIN_SERVICE,
        'account', KEYCHAIN_ACCOUNT,
      ], {
        input: key.toString('base64'),
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch (err) {
      DegradationReporter.getInstance().report({
        feature: 'SecretStore.writeLinuxKeychain',
        primary: 'Persist master key to Linux keychain',
        fallback: 'Key only in memory — lost on restart',
        reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Master key not persisted, may be lost',
      });
      return false;
    }
  }

  // ── File fallback ───────────────────────────────────────────────

  private getFileKey(): Buffer {
    if (fs.existsSync(this.keyFilePath)) {
      const hex = fs.readFileSync(this.keyFilePath, 'utf-8').trim();
      return Buffer.from(hex, 'hex');
    }

    // Generate new key
    const key = crypto.randomBytes(MASTER_KEY_LENGTH);

    // Try to store in keychain first
    if (!this.forceFile && this.writeKeychain(key)) {
      return key;
    }

    // Write to file with restrictive permissions
    const dir = path.dirname(this.keyFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.keyFilePath, key.toString('hex'), { mode: 0o600 });
    return key;
  }
}

// ── Secret Store (At-Rest) ───────────────────────────────────────────

export class SecretStore {
  private stateDir: string;
  private keyManager: MasterKeyManager;
  private encryptedPath: string;

  constructor(config: SecretStoreConfig) {
    this.stateDir = config.stateDir;
    this.keyManager = new MasterKeyManager(config.stateDir, config.forceFileKey);
    this.encryptedPath = path.join(config.stateDir, 'secrets', 'config.secrets.enc');
  }

  /** Read and decrypt secrets from the encrypted store. Returns empty object if no secrets exist. */
  read(): Secrets {
    if (!fs.existsSync(this.encryptedPath)) {
      return {};
    }

    const raw = fs.readFileSync(this.encryptedPath);
    const masterKey = this.keyManager.getMasterKey();
    return this.decryptAES(raw, masterKey);
  }

  /** Encrypt and write secrets to the store. */
  write(secrets: Secrets): void {
    const masterKey = this.keyManager.getMasterKey();
    const encrypted = this.encryptAES(secrets, masterKey);

    const dir = path.dirname(this.encryptedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Atomic write via temp file
    const tmpPath = this.encryptedPath + '.tmp';
    fs.writeFileSync(tmpPath, encrypted, { mode: 0o600 });
    fs.renameSync(tmpPath, this.encryptedPath);
  }

  /** Get a specific secret by dot-notation path (e.g., 'telegram.token'). */
  get(keyPath: string): unknown {
    const secrets = this.read();
    return getNestedValue(secrets, keyPath);
  }

  /** Set a specific secret by dot-notation path. */
  set(keyPath: string, value: unknown): void {
    const secrets = this.read();
    setNestedValue(secrets, keyPath, value);
    this.write(secrets);
  }

  /** Delete a specific secret by dot-notation path. */
  delete(keyPath: string): void {
    const secrets = this.read();
    deleteNestedValue(secrets, keyPath);
    this.write(secrets);
  }

  /** Whether the secret store file exists. */
  get exists(): boolean {
    return fs.existsSync(this.encryptedPath);
  }

  /** Whether the master key is in the OS keychain. */
  get isKeychainBacked(): boolean {
    return this.keyManager.isKeychainBacked;
  }

  /** Delete the encrypted store file. */
  destroy(): void {
    if (fs.existsSync(this.encryptedPath)) {
      // safe-git-allow: incremental-migration
      fs.unlinkSync(this.encryptedPath);
    }
  }

  // ── AES-256-GCM Helpers ────────────────────────────────────────

  private encryptAES(data: Secrets, key: Buffer): Buffer {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = Buffer.from(JSON.stringify(data), 'utf-8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Format: [iv (12)] [tag (16)] [ciphertext]
    return Buffer.concat([iv, tag, encrypted]);
  }

  private decryptAES(raw: Buffer, key: Buffer): Secrets {
    if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
      throw new Error('SecretStore: encrypted file is too short (corrupted?)');
    }

    const iv = raw.subarray(0, IV_LENGTH);
    const tag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf-8'));
  }
}

// ── Forward-Secret Wire Encryption ───────────────────────────────────

/**
 * Encrypt secrets for wire transfer using forward-secret ECDH.
 *
 * Protocol:
 * 1. Generate ephemeral X25519 key pair
 * 2. ECDH: ephemeral private + recipient's long-term public = shared secret
 * 3. HKDF-SHA256 to derive AES-256 key
 * 4. AES-256-GCM encrypt
 * 5. Return: { ephemeralPublicKey, iv, ciphertext, tag }
 *
 * The ephemeral private key is not retained — forward secrecy.
 */
export function encryptForSync(
  secrets: Secrets,
  recipientPublicKeyBase64: string,
): EncryptedSecretPayload {
  // Generate ephemeral X25519 key pair
  const ephemeral = crypto.generateKeyPairSync('x25519');
  const ephemeralPublicRaw = ephemeral.publicKey.export({ type: 'spki', format: 'der' });
  // X25519 SPKI DER: 12-byte header + 32-byte key
  const ephemeralPublicBytes = ephemeralPublicRaw.subarray(ephemeralPublicRaw.length - 32);

  // Reconstruct recipient's X25519 public key from base64
  // Handles both raw 32-byte keys and full SPKI DER (44 bytes)
  const recipientPublicBytes = Buffer.from(recipientPublicKeyBase64, 'base64');
  const recipientSpki = recipientPublicBytes.length === 32
    ? buildX25519Spki(recipientPublicBytes)
    : recipientPublicBytes; // Already SPKI DER
  const recipientKey = crypto.createPublicKey({
    key: recipientSpki,
    format: 'der',
    type: 'spki',
  });

  // ECDH: shared secret
  const sharedSecret = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipientKey,
  });

  // HKDF: derive AES-256 key
  const salt = ephemeralPublicBytes;
  const derivedKey = crypto.hkdfSync('sha256', sharedSecret, salt, HKDF_INFO, 32);

  // AES-256-GCM encrypt
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(derivedKey), iv);
  const plaintext = Buffer.from(JSON.stringify(secrets), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ephemeralPublicKey: ephemeralPublicBytes.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: encrypted.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/**
 * Decrypt secrets received via wire transfer.
 *
 * Protocol:
 * 1. ECDH: own private key + sender's ephemeral public = shared secret
 * 2. HKDF-SHA256 to derive AES-256 key
 * 3. AES-256-GCM decrypt
 */
export function decryptFromSync(
  payload: EncryptedSecretPayload,
  ownPrivateKey: crypto.KeyObject,
): Secrets {
  // Reconstruct sender's ephemeral public key
  const ephemeralPublicBytes = Buffer.from(payload.ephemeralPublicKey, 'base64');
  const ephemeralKey = crypto.createPublicKey({
    key: buildX25519Spki(ephemeralPublicBytes),
    format: 'der',
    type: 'spki',
  });

  // ECDH: shared secret
  const sharedSecret = crypto.diffieHellman({
    privateKey: ownPrivateKey,
    publicKey: ephemeralKey,
  });

  // HKDF: derive AES-256 key
  const salt = ephemeralPublicBytes;
  const derivedKey = crypto.hkdfSync('sha256', sharedSecret, salt, HKDF_INFO, 32);

  // AES-256-GCM decrypt
  const iv = Buffer.from(payload.iv, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(derivedKey), iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf-8'));
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Build X25519 SPKI DER from raw 32-byte public key. */
function buildX25519Spki(publicKeyRaw: Buffer): Buffer {
  // X25519 SPKI header (12 bytes): 30 2a 30 05 06 03 2b 65 6e 03 21 00
  const header = Buffer.from('302a300506032b656e032100', 'hex');
  return Buffer.concat([header, publicKeyRaw]);
}

/** Get nested value from object using dot notation. */
function getNestedValue(obj: Record<string, unknown>, keyPath: string): unknown {
  const parts = keyPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Set nested value in object using dot notation. */
function setNestedValue(obj: Record<string, unknown>, keyPath: string, value: unknown): void {
  const parts = keyPath.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

/** Delete nested value from object using dot notation. */
function deleteNestedValue(obj: Record<string, unknown>, keyPath: string): void {
  const parts = keyPath.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
      return; // Path doesn't exist
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  delete current[parts[parts.length - 1]];
}
