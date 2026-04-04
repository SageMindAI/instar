/**
 * RecoveryPhrase — BIP-39 mnemonic generation and recovery keypair derivation.
 *
 * Spec Section 3.10:
 * - Recovery keypair is independently CSPRNG-generated, NOT derived from primary key
 * - Recovery phrase follows BIP-39 (24-word mnemonic, 256 bits of entropy)
 * - Recovery keypair derivation: Argon2id(mnemonic, per_agent_salt, t=3, m=65536, p=4) → seed → Ed25519
 * - Recovery commitment: recovery public key signed by primary key
 */

import crypto from 'node:crypto';
import { generateMnemonic, validateMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { argon2id } from '@noble/hashes/argon2.js';
import { sign, verify } from '../threadline/ThreadlineCrypto.js';

// ── Constants ────────────────────────────────────────────────────────

const ARGON2_TIME_COST = 3;
const ARGON2_MEMORY_KB = 65536;
const ARGON2_PARALLELISM = 4;
const ED25519_SEED_LENGTH = 32;

// Ed25519 PKCS#8 and SPKI prefixes for key wrapping
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// ── Public API ───────────────────────────────────────────────────────

/**
 * Generate a new 24-word BIP-39 mnemonic (256 bits of entropy).
 */
export function generateRecoveryPhrase(): string {
  return generateMnemonic(wordlist, 256);
}

/**
 * Validate a BIP-39 mnemonic phrase.
 */
export function isValidRecoveryPhrase(phrase: string): boolean {
  return validateMnemonic(phrase, wordlist);
}

/**
 * Derive an Ed25519 recovery keypair from a mnemonic and per-agent salt.
 *
 * Uses Argon2id for key stretching, then feeds the output as an Ed25519 seed.
 */
export function deriveRecoveryKeypair(
  mnemonic: string,
  salt: Buffer,
): { publicKey: Buffer; privateKey: Buffer } {
  // Derive seed via Argon2id
  const seed = argon2id(Buffer.from(mnemonic, 'utf-8'), salt, {
    t: ARGON2_TIME_COST,
    m: ARGON2_MEMORY_KB,
    p: ARGON2_PARALLELISM,
    dkLen: ED25519_SEED_LENGTH,
  });

  // Generate Ed25519 keypair from seed
  const privateKeyObj = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });

  const publicKeyObj = crypto.createPublicKey(privateKeyObj);

  return {
    publicKey: Buffer.from(publicKeyObj.export({ type: 'spki', format: 'der' }).subarray(-32)),
    privateKey: Buffer.from(seed),
  };
}

/**
 * Create a recovery commitment: the recovery public key signed by the primary key.
 *
 * This is stored in identity.json and registered with MoltBridge at creation time.
 * Later, during emergency revocation, the recovery key proves it matches the pre-committed key.
 */
export function createRecoveryCommitment(
  recoveryPublicKey: Buffer,
  primaryPrivateKey: Buffer,
): string {
  const message = Buffer.concat([
    Buffer.from('instar-recovery-commitment-v1', 'utf-8'),
    recoveryPublicKey,
  ]);
  const signature = sign(primaryPrivateKey, message);
  return signature.toString('base64');
}

/**
 * Verify a recovery commitment against a primary public key.
 */
export function verifyRecoveryCommitment(
  recoveryPublicKey: Buffer,
  commitment: string,
  primaryPublicKey: Buffer,
): boolean {
  const message = Buffer.concat([
    Buffer.from('instar-recovery-commitment-v1', 'utf-8'),
    recoveryPublicKey,
  ]);
  const signature = Buffer.from(commitment, 'base64');
  return verify(primaryPublicKey, message, signature);
}

/**
 * Generate a new per-agent salt for recovery key derivation.
 * This salt is stored in identity.json as recoverySalt.
 */
export function generateRecoverySalt(): Buffer {
  return crypto.randomBytes(32);
}
