import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  encryptPrivateKey,
  decryptPrivateKey,
  generateSalt,
  SALT_BYTES,
} from '../../../src/identity/KeyEncryption.js';

describe('KeyEncryption', () => {
  const testKey = crypto.randomBytes(32);
  const passphrase = 'test-passphrase-for-unit-tests';

  describe('encrypt/decrypt roundtrip', () => {
    it('decrypts to the original key', () => {
      const salt = generateSalt();
      const encrypted = encryptPrivateKey(testKey, passphrase, salt);
      const decrypted = decryptPrivateKey(encrypted, passphrase, salt);
      expect(decrypted).toEqual(testKey);
    });

    it('works with empty passphrase', () => {
      const salt = generateSalt();
      const encrypted = encryptPrivateKey(testKey, '', salt);
      const decrypted = decryptPrivateKey(encrypted, '', salt);
      expect(decrypted).toEqual(testKey);
    });

    it('works with unicode passphrase', () => {
      const salt = generateSalt();
      const phrase = '密码测试🔑';
      const encrypted = encryptPrivateKey(testKey, phrase, salt);
      const decrypted = decryptPrivateKey(encrypted, phrase, salt);
      expect(decrypted).toEqual(testKey);
    });
  });

  describe('wrong passphrase', () => {
    it('throws on wrong passphrase', () => {
      const salt = generateSalt();
      const encrypted = encryptPrivateKey(testKey, passphrase, salt);
      expect(() => decryptPrivateKey(encrypted, 'wrong-passphrase', salt))
        .toThrow('Decryption failed');
    });

    it('throws on wrong salt', () => {
      const salt = generateSalt();
      const encrypted = encryptPrivateKey(testKey, passphrase, salt);
      const wrongSalt = generateSalt();
      expect(() => decryptPrivateKey(encrypted, passphrase, wrongSalt))
        .toThrow('Decryption failed');
    });
  });

  describe('output format', () => {
    it('produces a base64 string', () => {
      const salt = generateSalt();
      const encrypted = encryptPrivateKey(testKey, passphrase, salt);
      // Should be valid base64
      expect(() => Buffer.from(encrypted, 'base64')).not.toThrow();
      // Should decode to nonce(24) + ciphertext(32) + tag(16) = 72 bytes
      const decoded = Buffer.from(encrypted, 'base64');
      expect(decoded.length).toBe(24 + 32 + 16);
    });

    it('produces different ciphertext each time (random nonce)', () => {
      const salt = generateSalt();
      const enc1 = encryptPrivateKey(testKey, passphrase, salt);
      const enc2 = encryptPrivateKey(testKey, passphrase, salt);
      expect(enc1).not.toBe(enc2);
    });
  });

  describe('generateSalt', () => {
    it('produces a buffer of correct size', () => {
      const salt = generateSalt();
      expect(salt).toBeInstanceOf(Buffer);
      expect(salt.length).toBe(SALT_BYTES);
    });

    it('produces unique salts', () => {
      const salt1 = generateSalt();
      const salt2 = generateSalt();
      expect(salt1.equals(salt2)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('rejects truncated encrypted data', () => {
      expect(() => decryptPrivateKey('AAAA', passphrase, generateSalt()))
        .toThrow('too short');
    });

    it('rejects corrupted ciphertext', () => {
      const salt = generateSalt();
      const encrypted = encryptPrivateKey(testKey, passphrase, salt);
      const decoded = Buffer.from(encrypted, 'base64');
      // Flip a byte in the ciphertext
      decoded[30] ^= 0xff;
      const corrupted = decoded.toString('base64');
      expect(() => decryptPrivateKey(corrupted, passphrase, salt))
        .toThrow('Decryption failed');
    });
  });
});
