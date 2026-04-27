import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  encryptData,
  decryptData,
  isEncryptedFile,
  readAuthFile,
  writeAuthFile,
} from '../../../src/messaging/shared/EncryptedAuthStore.js';

describe('EncryptedAuthStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-auth-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('encryptData / decryptData', () => {
    it('round-trips data correctly', () => {
      const passphrase = 'test-passphrase-123';
      const original = Buffer.from('{"creds": "secret-session-data"}');

      const encrypted = encryptData(original, passphrase);
      const decrypted = decryptData(encrypted, passphrase);

      expect(decrypted.toString('utf-8')).toBe(original.toString('utf-8'));
    });

    it('produces different ciphertext each time (random IV/salt)', () => {
      const passphrase = 'same-passphrase';
      const data = Buffer.from('same data');

      const enc1 = encryptData(data, passphrase);
      const enc2 = encryptData(data, passphrase);

      expect(enc1.equals(enc2)).toBe(false);
    });

    it('fails with wrong passphrase', () => {
      const data = Buffer.from('secret');
      const encrypted = encryptData(data, 'correct-passphrase');

      expect(() => decryptData(encrypted, 'wrong-passphrase')).toThrow();
    });

    it('fails with corrupted data', () => {
      const data = Buffer.from('secret');
      const encrypted = encryptData(data, 'passphrase');

      // Corrupt a byte in the ciphertext area
      encrypted[encrypted.length - 5] ^= 0xff;

      expect(() => decryptData(encrypted, 'passphrase')).toThrow();
    });

    it('fails with truncated data', () => {
      expect(() => decryptData(Buffer.from('short'), 'passphrase')).toThrow('too short');
    });

    it('fails with wrong header', () => {
      const buf = Buffer.alloc(200, 0);
      buf.write('WRONG_HEADER!', 0);
      expect(() => decryptData(buf, 'passphrase')).toThrow('wrong header');
    });

    it('handles empty data', () => {
      const encrypted = encryptData(Buffer.alloc(0), 'passphrase');
      const decrypted = decryptData(encrypted, 'passphrase');
      expect(decrypted.length).toBe(0);
    });

    it('handles large data', () => {
      const largeData = Buffer.alloc(100_000, 0x42);
      const encrypted = encryptData(largeData, 'passphrase');
      const decrypted = decryptData(encrypted, 'passphrase');
      expect(decrypted.equals(largeData)).toBe(true);
    });

    it('handles unicode passphrases', () => {
      const data = Buffer.from('test');
      const encrypted = encryptData(data, 'passphrase-with-unicode-');
      const decrypted = decryptData(encrypted, 'passphrase-with-unicode-');
      expect(decrypted.toString()).toBe('test');
    });
  });

  describe('isEncryptedFile', () => {
    it('detects encrypted files', () => {
      const filePath = path.join(tmpDir, 'encrypted.json');
      const encrypted = encryptData(Buffer.from('test'), 'pass');
      fs.writeFileSync(filePath, encrypted);

      expect(isEncryptedFile(filePath)).toBe(true);
    });

    it('detects unencrypted files', () => {
      const filePath = path.join(tmpDir, 'plain.json');
      fs.writeFileSync(filePath, '{"key": "value"}');

      expect(isEncryptedFile(filePath)).toBe(false);
    });

    it('returns false for missing files', () => {
      expect(isEncryptedFile(path.join(tmpDir, 'nonexistent'))).toBe(false);
    });
  });

  describe('readAuthFile / writeAuthFile', () => {
    it('writes and reads encrypted files', () => {
      const filePath = path.join(tmpDir, 'creds.json');
      writeAuthFile(filePath, '{"session": "data"}', 'my-password');

      expect(isEncryptedFile(filePath)).toBe(true);

      const content = readAuthFile(filePath, 'my-password');
      expect(content).toBe('{"session": "data"}');
    });

    it('writes and reads unencrypted files (no passphrase)', () => {
      const filePath = path.join(tmpDir, 'creds.json');
      writeAuthFile(filePath, '{"session": "data"}');

      expect(isEncryptedFile(filePath)).toBe(false);

      const content = readAuthFile(filePath);
      expect(content).toBe('{"session": "data"}');
    });

    it('reads unencrypted file even with passphrase (backward-compatible)', () => {
      const filePath = path.join(tmpDir, 'creds.json');
      // Write unencrypted
      fs.writeFileSync(filePath, '{"old": "data"}');

      // Read with passphrase — should still work
      const content = readAuthFile(filePath, 'some-password');
      expect(content).toBe('{"old": "data"}');
    });

    it('creates directories as needed', () => {
      const filePath = path.join(tmpDir, 'deep', 'nested', 'creds.json');
      writeAuthFile(filePath, 'data', 'pass');

      expect(fs.existsSync(filePath)).toBe(true);
      expect(readAuthFile(filePath, 'pass')).toBe('data');
    });

    it('atomic write prevents corruption', () => {
      const filePath = path.join(tmpDir, 'creds.json');
      writeAuthFile(filePath, 'original', 'pass');

      // Write again — should atomically replace
      writeAuthFile(filePath, 'updated', 'pass');
      expect(readAuthFile(filePath, 'pass')).toBe('updated');
    });

    it('no leftover tmp files after write', () => {
      const filePath = path.join(tmpDir, 'creds.json');
      writeAuthFile(filePath, 'data', 'pass');

      const files = fs.readdirSync(tmpDir);
      expect(files).toEqual(['creds.json']);
    });
  });
});
