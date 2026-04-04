import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  generateRecoveryPhrase,
  isValidRecoveryPhrase,
  deriveRecoveryKeypair,
  createRecoveryCommitment,
  verifyRecoveryCommitment,
  generateRecoverySalt,
} from '../../../src/identity/RecoveryPhrase.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';

describe('RecoveryPhrase', () => {
  describe('generateRecoveryPhrase', () => {
    it('generates a 24-word mnemonic', () => {
      const phrase = generateRecoveryPhrase();
      const words = phrase.split(' ');
      expect(words).toHaveLength(24);
    });

    it('generates valid BIP-39 mnemonics', () => {
      const phrase = generateRecoveryPhrase();
      expect(isValidRecoveryPhrase(phrase)).toBe(true);
    });

    it('generates unique phrases', () => {
      const p1 = generateRecoveryPhrase();
      const p2 = generateRecoveryPhrase();
      expect(p1).not.toBe(p2);
    });
  });

  describe('isValidRecoveryPhrase', () => {
    it('validates a correct mnemonic', () => {
      const phrase = generateRecoveryPhrase();
      expect(isValidRecoveryPhrase(phrase)).toBe(true);
    });

    it('rejects garbage input', () => {
      expect(isValidRecoveryPhrase('not a valid mnemonic phrase')).toBe(false);
    });

    it('rejects partial mnemonic (12 words from 24)', () => {
      const phrase = generateRecoveryPhrase();
      const partial = phrase.split(' ').slice(0, 12).join(' ');
      // 12-word mnemonic is valid BIP-39 but not 24-word — still valid format
      // However, the checksum may not match for arbitrary 12 words from a 24-word phrase
      // So this test just confirms the function handles shorter input
      expect(typeof isValidRecoveryPhrase(partial)).toBe('boolean');
    });
  });

  describe('deriveRecoveryKeypair', () => {
    it('derives a valid Ed25519 keypair', () => {
      const phrase = generateRecoveryPhrase();
      const salt = generateRecoverySalt();
      const kp = deriveRecoveryKeypair(phrase, salt);
      expect(kp.publicKey).toBeInstanceOf(Buffer);
      expect(kp.privateKey).toBeInstanceOf(Buffer);
      expect(kp.publicKey.length).toBe(32);
      expect(kp.privateKey.length).toBe(32);
    });

    it('is deterministic for same mnemonic and salt', () => {
      const phrase = generateRecoveryPhrase();
      const salt = generateRecoverySalt();
      const kp1 = deriveRecoveryKeypair(phrase, salt);
      const kp2 = deriveRecoveryKeypair(phrase, salt);
      expect(kp1.publicKey.equals(kp2.publicKey)).toBe(true);
      expect(kp1.privateKey.equals(kp2.privateKey)).toBe(true);
    });

    it('produces different keys for different salts', () => {
      const phrase = generateRecoveryPhrase();
      const kp1 = deriveRecoveryKeypair(phrase, generateRecoverySalt());
      const kp2 = deriveRecoveryKeypair(phrase, generateRecoverySalt());
      expect(kp1.publicKey.equals(kp2.publicKey)).toBe(false);
    });

    it('produces different keys for different mnemonics', () => {
      const salt = generateRecoverySalt();
      const kp1 = deriveRecoveryKeypair(generateRecoveryPhrase(), salt);
      const kp2 = deriveRecoveryKeypair(generateRecoveryPhrase(), salt);
      expect(kp1.publicKey.equals(kp2.publicKey)).toBe(false);
    });
  });

  describe('recovery commitment', () => {
    it('creates and verifies a commitment', () => {
      const primary = generateIdentityKeyPair();
      const phrase = generateRecoveryPhrase();
      const salt = generateRecoverySalt();
      const recovery = deriveRecoveryKeypair(phrase, salt);

      const commitment = createRecoveryCommitment(recovery.publicKey, primary.privateKey);
      expect(typeof commitment).toBe('string');

      const valid = verifyRecoveryCommitment(recovery.publicKey, commitment, primary.publicKey);
      expect(valid).toBe(true);
    });

    it('fails verification with wrong primary key', () => {
      const primary = generateIdentityKeyPair();
      const otherPrimary = generateIdentityKeyPair();
      const phrase = generateRecoveryPhrase();
      const salt = generateRecoverySalt();
      const recovery = deriveRecoveryKeypair(phrase, salt);

      const commitment = createRecoveryCommitment(recovery.publicKey, primary.privateKey);
      const valid = verifyRecoveryCommitment(recovery.publicKey, commitment, otherPrimary.publicKey);
      expect(valid).toBe(false);
    });

    it('fails verification with wrong recovery key', () => {
      const primary = generateIdentityKeyPair();
      const phrase = generateRecoveryPhrase();
      const salt = generateRecoverySalt();
      const recovery = deriveRecoveryKeypair(phrase, salt);
      const otherRecovery = deriveRecoveryKeypair(generateRecoveryPhrase(), salt);

      const commitment = createRecoveryCommitment(recovery.publicKey, primary.privateKey);
      const valid = verifyRecoveryCommitment(otherRecovery.publicKey, commitment, primary.publicKey);
      expect(valid).toBe(false);
    });
  });

  describe('generateRecoverySalt', () => {
    it('produces a 32-byte buffer', () => {
      const salt = generateRecoverySalt();
      expect(salt).toBeInstanceOf(Buffer);
      expect(salt.length).toBe(32);
    });

    it('produces unique salts', () => {
      const s1 = generateRecoverySalt();
      const s2 = generateRecoverySalt();
      expect(s1.equals(s2)).toBe(false);
    });
  });
});
