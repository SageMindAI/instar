import { describe, it, expect } from 'vitest';
import {
  createRotation,
  verifyRotationProof,
  isWithinGracePeriod,
  computeRotatedCanonicalId,
} from '../../../src/identity/KeyRotation.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { KEY_ROTATION_GRACE_MS } from '../../../src/identity/types.js';

describe('KeyRotation', () => {
  const keypair = generateIdentityKeyPair();

  describe('createRotation', () => {
    it('generates a new keypair and dual-signed proof', () => {
      const { newKeypair, proof } = createRotation(keypair.privateKey, keypair.publicKey, 'routine rotation');
      expect(newKeypair.publicKey).toBeInstanceOf(Buffer);
      expect(newKeypair.publicKey.length).toBe(32);
      expect(proof.oldPublicKey).toBeDefined();
      expect(proof.newPublicKey).toBeDefined();
      expect(proof.oldKeySignature).toBeDefined();
      expect(proof.newKeySignature).toBeDefined();
      expect(proof.reason).toBe('routine rotation');
    });

    it('new key differs from old key', () => {
      const { newKeypair } = createRotation(keypair.privateKey, keypair.publicKey, 'test');
      expect(newKeypair.publicKey.equals(keypair.publicKey)).toBe(false);
    });
  });

  describe('verifyRotationProof', () => {
    it('verifies a valid proof', () => {
      const { proof } = createRotation(keypair.privateKey, keypair.publicKey, 'test');
      expect(verifyRotationProof(proof)).toBe(true);
    });

    it('rejects proof with tampered old key signature', () => {
      const { proof } = createRotation(keypair.privateKey, keypair.publicKey, 'test');
      const tampered = { ...proof, oldKeySignature: Buffer.alloc(64).toString('base64') };
      expect(verifyRotationProof(tampered)).toBe(false);
    });

    it('rejects proof with tampered new key signature', () => {
      const { proof } = createRotation(keypair.privateKey, keypair.publicKey, 'test');
      const tampered = { ...proof, newKeySignature: Buffer.alloc(64).toString('base64') };
      expect(verifyRotationProof(tampered)).toBe(false);
    });

    it('rejects proof with tampered reason', () => {
      const { proof } = createRotation(keypair.privateKey, keypair.publicKey, 'test');
      const tampered = { ...proof, reason: 'tampered' };
      expect(verifyRotationProof(tampered)).toBe(false);
    });

    it('rejects proof with swapped keys (impersonation)', () => {
      const other = generateIdentityKeyPair();
      const { proof } = createRotation(keypair.privateKey, keypair.publicKey, 'test');
      // Attacker replaces newPublicKey with their own — signature won't match
      const tampered = { ...proof, newPublicKey: other.publicKey.toString('base64') };
      expect(verifyRotationProof(tampered)).toBe(false);
    });
  });

  describe('isWithinGracePeriod', () => {
    it('returns true within grace period', () => {
      const now = new Date();
      const recent = new Date(now.getTime() - 1000).toISOString(); // 1 second ago
      expect(isWithinGracePeriod(recent, now)).toBe(true);
    });

    it('returns false after grace period', () => {
      const now = new Date();
      const old = new Date(now.getTime() - KEY_ROTATION_GRACE_MS - 1000).toISOString();
      expect(isWithinGracePeriod(old, now)).toBe(false);
    });

    it('returns true at the boundary', () => {
      const now = new Date();
      const boundary = new Date(now.getTime() - KEY_ROTATION_GRACE_MS + 1000).toISOString();
      expect(isWithinGracePeriod(boundary, now)).toBe(true);
    });
  });

  describe('computeRotatedCanonicalId', () => {
    it('computes new canonical ID for new key', () => {
      const { newKeypair } = createRotation(keypair.privateKey, keypair.publicKey, 'test');
      const { canonicalId, displayFingerprint } = computeRotatedCanonicalId(newKeypair.publicKey);
      expect(canonicalId).toMatch(/^[0-9a-f]{64}$/);
      expect(displayFingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(canonicalId.startsWith(displayFingerprint)).toBe(true);
    });
  });
});
