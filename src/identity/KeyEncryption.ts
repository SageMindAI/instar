/**
 * KeyEncryption — Encrypt/decrypt Ed25519 private keys at rest.
 *
 * Uses Argon2id for key derivation and XChaCha20-Poly1305 for encryption,
 * matching the Threadline spec (Section 3.3.2):
 *
 *   encrypted = XChaCha20-Poly1305(
 *     key = Argon2id(passphrase, salt, t=3, m=65536, p=4),
 *     nonce = 24 bytes CSPRNG,
 *     data = private_key
 *   )
 *
 * Storage format: base64(nonce || ciphertext || auth_tag)
 */

import crypto from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

// ── Constants ────────────────────────────────────────────────────────

/** Argon2id parameters (spec Section 3.3.2) */
const ARGON2_TIME_COST = 3;
const ARGON2_MEMORY_KB = 65536;    // 64 MB
const ARGON2_PARALLELISM = 4;
const ARGON2_OUTPUT_LENGTH = 32;   // 256-bit key for XChaCha20-Poly1305

/** XChaCha20-Poly1305 nonce size */
const NONCE_BYTES = 24;

/** Salt size for Argon2id */
export const SALT_BYTES = 32;

// ── Public API ───────────────────────────────────────────────────────

/**
 * Encrypt an Ed25519 private key for at-rest storage.
 *
 * @param privateKey - Raw 32-byte Ed25519 private key
 * @param passphrase - User passphrase or keychain-derived secret
 * @param salt - 32-byte CSPRNG salt (unique per agent, stored alongside)
 * @returns base64-encoded string: nonce || ciphertext || tag
 */
export function encryptPrivateKey(
  privateKey: Buffer,
  passphrase: string,
  salt: Buffer,
): string {
  // Derive encryption key via Argon2id
  const key = deriveKey(passphrase, salt);

  // Generate random nonce
  const nonce = crypto.randomBytes(NONCE_BYTES);

  // Encrypt with XChaCha20-Poly1305
  const cipher = xchacha20poly1305(key, nonce);
  const ciphertext = cipher.encrypt(new Uint8Array(privateKey));

  // Pack: nonce || ciphertext (includes auth tag)
  const packed = Buffer.concat([nonce, Buffer.from(ciphertext)]);
  return packed.toString('base64');
}

/**
 * Decrypt an Ed25519 private key from at-rest storage.
 *
 * @param encrypted - base64-encoded string from encryptPrivateKey
 * @param passphrase - Same passphrase used for encryption
 * @param salt - Same salt used for encryption
 * @returns Raw 32-byte Ed25519 private key
 * @throws Error if passphrase is wrong or data is corrupted
 */
export function decryptPrivateKey(
  encrypted: string,
  passphrase: string,
  salt: Buffer,
): Buffer {
  const packed = Buffer.from(encrypted, 'base64');

  if (packed.length < NONCE_BYTES + 16) {
    throw new Error('Encrypted key data too short');
  }

  // Unpack: nonce || ciphertext (includes auth tag)
  const nonce = packed.subarray(0, NONCE_BYTES);
  const ciphertext = packed.subarray(NONCE_BYTES);

  // Derive the same key
  const key = deriveKey(passphrase, salt);

  // Decrypt
  const cipher = xchacha20poly1305(key, nonce);
  try {
    const plaintext = cipher.decrypt(new Uint8Array(ciphertext));
    return Buffer.from(plaintext);
  } catch {
    throw new Error('Decryption failed — wrong passphrase or corrupted data');
  }
}

/**
 * Generate a new random salt for Argon2id key derivation.
 */
export function generateSalt(): Buffer {
  return crypto.randomBytes(SALT_BYTES);
}

// ── Internal ─────────────────────────────────────────────────────────

function deriveKey(passphrase: string, salt: Buffer): Uint8Array {
  return argon2id(Buffer.from(passphrase, 'utf-8'), salt, {
    t: ARGON2_TIME_COST,
    m: ARGON2_MEMORY_KB,
    p: ARGON2_PARALLELISM,
    dkLen: ARGON2_OUTPUT_LENGTH,
  });
}
