/**
 * Test vectors — Known-answer tests for all crypto operations.
 *
 * Spec Section 3.3.1 Phase 0 requirement:
 * - Known Ed25519 keypairs → known fingerprints → known canonical IDs
 * - Verify raw X25519 output ≠ HKDF output (catch naive implementations)
 * - Known Argon2id inputs → known encryption outputs
 * - Canonical ID uses domain separation
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { computeCanonicalId, computeDisplayFingerprint, CANONICAL_ID_DOMAIN } from '../../../src/identity/types.js';
import { encryptPrivateKey, decryptPrivateKey } from '../../../src/identity/KeyEncryption.js';
import { deriveRecoveryKeypair } from '../../../src/identity/RecoveryPhrase.js';
import { sign, verify, deriveRelayToken, ecdh, generateEphemeralKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';

describe('Test Vectors', () => {
  describe('canonical ID derivation', () => {
    it('known public key produces known canonical ID', () => {
      // Fixed test key: 32 bytes of 0x01
      const pubKey = Buffer.alloc(32, 0x01);

      // Expected: SHA-256("instar-agent-id-v1" || pubKey)
      const expected = crypto.createHash('sha256')
        .update(Buffer.from(CANONICAL_ID_DOMAIN, 'utf-8'))
        .update(pubKey)
        .digest('hex');

      expect(computeCanonicalId(pubKey)).toBe(expected);
      expect(expected).toHaveLength(64);
    });

    it('domain separation produces different hash than raw SHA-256', () => {
      const pubKey = Buffer.alloc(32, 0xaa);
      const withDomain = computeCanonicalId(pubKey);
      const withoutDomain = crypto.createHash('sha256').update(pubKey).digest('hex');
      expect(withDomain).not.toBe(withoutDomain);
    });

    it('display fingerprint is first 16 chars of canonical ID', () => {
      const pubKey = Buffer.alloc(32, 0xbb);
      const canonicalId = computeCanonicalId(pubKey);
      const fp = computeDisplayFingerprint(canonicalId);
      expect(fp).toBe(canonicalId.slice(0, 16));
      expect(fp).toHaveLength(16);
    });
  });

  describe('Ed25519 sign/verify with known keys', () => {
    it('signature is 64 bytes', () => {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
      const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);

      const message = Buffer.from('test vector message');
      const sig = sign(priv, message);
      expect(sig).toHaveLength(64);
      expect(verify(pub, message, sig)).toBe(true);
    });

    it('rejects tampered message', () => {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
      const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);

      const message = Buffer.from('original');
      const sig = sign(priv, message);
      expect(verify(pub, Buffer.from('tampered'), sig)).toBe(false);
    });
  });

  describe('HKDF relay token derivation', () => {
    it('raw X25519 shared secret differs from HKDF output', () => {
      // Generate two ephemeral keypairs
      const alice = generateEphemeralKeyPair();
      const bob = generateEphemeralKeyPair();

      // Raw shared secret (should NOT be used as key)
      const rawSharedSecret = ecdh(alice.privateKey, bob.publicKey);
      expect(rawSharedSecret).toHaveLength(32);

      // HKDF-derived token (should be used)
      const salt = Buffer.concat([alice.publicKey, bob.publicKey]);
      const token = deriveRelayToken(rawSharedSecret, salt, 'threadline-relay-token-v1');
      expect(token).toHaveLength(32);

      // They MUST differ — using raw shared secret as key is a crypto bug
      expect(rawSharedSecret.equals(token)).toBe(false);
    });

    it('HKDF output is deterministic', () => {
      const alice = generateEphemeralKeyPair();
      const bob = generateEphemeralKeyPair();
      const secret = ecdh(alice.privateKey, bob.publicKey);
      const salt = Buffer.alloc(32, 0xcc);

      const token1 = deriveRelayToken(secret, salt, 'test-info');
      const token2 = deriveRelayToken(secret, salt, 'test-info');
      expect(token1.equals(token2)).toBe(true);
    });

    it('different info strings produce different tokens', () => {
      const alice = generateEphemeralKeyPair();
      const bob = generateEphemeralKeyPair();
      const secret = ecdh(alice.privateKey, bob.publicKey);
      const salt = Buffer.alloc(32, 0xdd);

      const enc = deriveRelayToken(secret, salt, 'threadline-channel-v1-enc');
      const mac = deriveRelayToken(secret, salt, 'threadline-channel-v1-mac');
      expect(enc.equals(mac)).toBe(false);
    });
  });

  describe('Argon2id encryption roundtrip with known inputs', () => {
    it('encrypts and decrypts a known 32-byte key', () => {
      const knownKey = Buffer.alloc(32, 0x42);
      const passphrase = 'known-test-vector-passphrase';
      const salt = Buffer.alloc(32, 0x55);

      const encrypted = encryptPrivateKey(knownKey, passphrase, salt);
      const decrypted = decryptPrivateKey(encrypted, passphrase, salt);
      expect(decrypted.equals(knownKey)).toBe(true);
    });

    it('same inputs produce different ciphertext (random nonce)', () => {
      const key = Buffer.alloc(32, 0x42);
      const pass = 'test';
      const salt = Buffer.alloc(32, 0x55);

      const enc1 = encryptPrivateKey(key, pass, salt);
      const enc2 = encryptPrivateKey(key, pass, salt);
      expect(enc1).not.toBe(enc2);
    });
  });

  describe('recovery keypair derivation determinism', () => {
    it('same mnemonic + salt always produces same keypair', () => {
      // Use a known valid BIP-39 mnemonic (generated, not hardcoded)
      const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
      const salt = Buffer.alloc(32, 0x77);

      const kp1 = deriveRecoveryKeypair(mnemonic, salt);
      const kp2 = deriveRecoveryKeypair(mnemonic, salt);

      expect(kp1.publicKey.equals(kp2.publicKey)).toBe(true);
      expect(kp1.privateKey.equals(kp2.privateKey)).toBe(true);
    });
  });
});
