/**
 * Unit tests for SecretStore (at-rest encryption + forward-secret sync).
 *
 * Tests:
 * - At-rest: write/read roundtrip
 * - At-rest: get/set/delete by dot-notation path
 * - At-rest: empty store returns {}
 * - At-rest: corrupted file throws
 * - At-rest: wrong key fails to decrypt
 * - At-rest: atomic write (no partial files)
 * - Wire: encryptForSync/decryptFromSync roundtrip
 * - Wire: forward secrecy (different ephemeral keys each time)
 * - Wire: wrong recipient key fails
 * - Wire: tampered ciphertext fails
 * - Wire: tampered tag fails
 * - MasterKeyManager: file-based key generation and retrieval
 * - MasterKeyManager: consistent key across calls
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  SecretStore,
  MasterKeyManager,
  encryptForSync,
  decryptFromSync,
} from '../../src/core/SecretStore.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-secret-test-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Generate an X25519 key pair for testing. */
function generateX25519KeyPair() {
  const kp = crypto.generateKeyPairSync('x25519');
  const publicRaw = kp.publicKey.export({ type: 'spki', format: 'der' });
  // Extract raw 32-byte key from SPKI DER
  const publicKeyBase64 = publicRaw.subarray(publicRaw.length - 32).toString('base64');
  return {
    publicKeyBase64,
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
  };
}

describe('SecretStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── At-Rest Encryption ──────────────────────────────────────────

  describe('at-rest encryption', () => {
    it('write and read roundtrip', () => {
      const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
      const secrets = {
        telegram: { token: 'bot123:ABC', chatId: '-100123' },
        authToken: 'sk-secret-token',
        tunnel: { token: 'eyJhbGciOi...' },
      };

      store.write(secrets);
      const result = store.read();

      expect(result).toEqual(secrets);
    });

    it('empty store returns {}', () => {
      const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
      expect(store.read()).toEqual({});
      expect(store.exists).toBe(false);
    });

    it('store exists after write', () => {
      const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
      store.write({ key: 'value' });
      expect(store.exists).toBe(true);
    });

    it('handles nested objects', () => {
      const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
      const secrets = {
        level1: {
          level2: {
            level3: 'deep-secret',
          },
        },
      };

      store.write(secrets);
      expect(store.read()).toEqual(secrets);
    });

    it('overwrites existing secrets', () => {
      const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
      store.write({ old: 'value' });
      store.write({ new: 'value' });
      expect(store.read()).toEqual({ new: 'value' });
    });

    it('encrypted file is not readable as JSON', () => {
      const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
      store.write({ secret: 'data' });

      const encPath = path.join(tmpDir, 'secrets', 'config.secrets.enc');
      const raw = fs.readFileSync(encPath);

      // Should not be valid JSON
      expect(() => JSON.parse(raw.toString())).toThrow();
    });

    it('corrupted file throws on read', () => {
      const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
      store.write({ secret: 'data' });

      // Corrupt the file
      const encPath = path.join(tmpDir, 'secrets', 'config.secrets.enc');
      const raw = fs.readFileSync(encPath);
      raw[raw.length - 1] ^= 0xff; // Flip last byte
      fs.writeFileSync(encPath, raw);

      expect(() => store.read()).toThrow();
    });

    it('wrong key fails to decrypt', () => {
      const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
      store.write({ secret: 'data' });

      // Overwrite the key file with a different key
      const keyPath = path.join(tmpDir, 'machine', 'secrets-master.key');
      const wrongKey = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(keyPath, wrongKey);

      expect(() => store.read()).toThrow();
    });

    it('destroy removes the encrypted file', () => {
      const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
      store.write({ secret: 'data' });
      expect(store.exists).toBe(true);

      store.destroy();
      expect(store.exists).toBe(false);
    });
  });

  // ── Dot-Notation Access ─────────────────────────────────────────

  describe('dot-notation access', () => {
    it('get retrieves nested value', () => {
      const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
      store.write({
        telegram: { token: 'bot123:ABC', chatId: '-100' },
        authToken: 'sk-token',
      });

      expect(store.get('telegram.token')).toBe('bot123:ABC');
      expect(store.get('authToken')).toBe('sk-token');
    });

    it('get returns undefined for missing path', () => {
      const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
      store.write({ telegram: { token: 'abc' } });

      expect(store.get('telegram.missing')).toBeUndefined();
      expect(store.get('nonexistent.deep.path')).toBeUndefined();
    });

    it('set creates nested structure', () => {
      const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
      store.set('telegram.token', 'new-token');

      const result = store.read();
      expect(result).toEqual({ telegram: { token: 'new-token' } });
    });

    it('set preserves existing values', () => {
      const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
      store.write({ telegram: { token: 'old' }, other: 'value' });
      store.set('telegram.token', 'new');

      const result = store.read();
      expect(result.telegram).toEqual({ token: 'new' });
      expect(result.other).toBe('value');
    });

    it('delete removes nested value', () => {
      const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
      store.write({ telegram: { token: 'abc', chatId: '-100' } });
      store.delete('telegram.token');

      const result = store.read();
      expect(result.telegram).toEqual({ chatId: '-100' });
    });

    it('delete does nothing for missing path', () => {
      const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
      store.write({ key: 'value' });
      store.delete('nonexistent.path');

      expect(store.read()).toEqual({ key: 'value' });
    });
  });

  // ── MasterKeyManager ───────────────────────────────────────────

  describe('MasterKeyManager', () => {
    it('generates and retrieves file-based key', () => {
      const mgr = new MasterKeyManager(tmpDir, true);
      const key = mgr.getMasterKey();

      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it('returns same key on subsequent calls', () => {
      const mgr = new MasterKeyManager(tmpDir, true);
      const key1 = mgr.getMasterKey();
      const key2 = mgr.getMasterKey();

      expect(key1.equals(key2)).toBe(true);
    });

    it('key file has restrictive permissions', () => {
      const mgr = new MasterKeyManager(tmpDir, true);
      mgr.getMasterKey();

      const keyPath = path.join(tmpDir, 'machine', 'secrets-master.key');
      const stats = fs.statSync(keyPath);
      // Check owner-only read/write (0600)
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('persists across instances', () => {
      const mgr1 = new MasterKeyManager(tmpDir, true);
      const key1 = mgr1.getMasterKey();

      const mgr2 = new MasterKeyManager(tmpDir, true);
      const key2 = mgr2.getMasterKey();

      expect(key1.equals(key2)).toBe(true);
    });
  });

  // ── Forward-Secret Wire Encryption ─────────────────────────────

  describe('forward-secret wire encryption', () => {
    it('encryptForSync/decryptFromSync roundtrip', () => {
      const recipient = generateX25519KeyPair();
      const secrets = {
        telegram: { token: 'bot123:ABC' },
        authToken: 'sk-secret',
      };

      const payload = encryptForSync(secrets, recipient.publicKeyBase64);
      const result = decryptFromSync(payload, recipient.privateKey);

      expect(result).toEqual(secrets);
    });

    it('produces different ciphertext each time (fresh ephemeral key)', () => {
      const recipient = generateX25519KeyPair();
      const secrets = { token: 'same-data' };

      const payload1 = encryptForSync(secrets, recipient.publicKeyBase64);
      const payload2 = encryptForSync(secrets, recipient.publicKeyBase64);

      // Different ephemeral keys
      expect(payload1.ephemeralPublicKey).not.toBe(payload2.ephemeralPublicKey);
      // Different ciphertext (different IV and key)
      expect(payload1.ciphertext).not.toBe(payload2.ciphertext);

      // Both decrypt correctly
      expect(decryptFromSync(payload1, recipient.privateKey)).toEqual(secrets);
      expect(decryptFromSync(payload2, recipient.privateKey)).toEqual(secrets);
    });

    it('wrong recipient key fails to decrypt', () => {
      const recipient = generateX25519KeyPair();
      const wrongRecipient = generateX25519KeyPair();
      const secrets = { token: 'secret' };

      const payload = encryptForSync(secrets, recipient.publicKeyBase64);

      // Trying to decrypt with wrong private key should fail
      expect(() => decryptFromSync(payload, wrongRecipient.privateKey)).toThrow();
    });

    it('tampered ciphertext fails to decrypt', () => {
      const recipient = generateX25519KeyPair();
      const secrets = { token: 'secret' };

      const payload = encryptForSync(secrets, recipient.publicKeyBase64);

      // Tamper with ciphertext
      const ciphertextBuf = Buffer.from(payload.ciphertext, 'base64');
      ciphertextBuf[0] ^= 0xff;
      payload.ciphertext = ciphertextBuf.toString('base64');

      expect(() => decryptFromSync(payload, recipient.privateKey)).toThrow();
    });

    it('tampered auth tag fails to decrypt', () => {
      const recipient = generateX25519KeyPair();
      const secrets = { token: 'secret' };

      const payload = encryptForSync(secrets, recipient.publicKeyBase64);

      // Tamper with auth tag
      const tagBuf = Buffer.from(payload.tag, 'base64');
      tagBuf[0] ^= 0xff;
      payload.tag = tagBuf.toString('base64');

      expect(() => decryptFromSync(payload, recipient.privateKey)).toThrow();
    });

    it('tampered ephemeral key fails to decrypt', () => {
      const recipient = generateX25519KeyPair();
      const secrets = { token: 'secret' };

      const payload = encryptForSync(secrets, recipient.publicKeyBase64);

      // Replace ephemeral key with a different one (changes the derived key)
      const fakeEphemeral = generateX25519KeyPair();
      payload.ephemeralPublicKey = fakeEphemeral.publicKeyBase64;

      expect(() => decryptFromSync(payload, recipient.privateKey)).toThrow();
    });

    it('handles large secret payloads', () => {
      const recipient = generateX25519KeyPair();
      const secrets: Record<string, string> = {};
      for (let i = 0; i < 100; i++) {
        secrets[`key_${i}`] = crypto.randomBytes(256).toString('base64');
      }

      const payload = encryptForSync(secrets, recipient.publicKeyBase64);
      const result = decryptFromSync(payload, recipient.privateKey);

      expect(result).toEqual(secrets);
    });

    it('handles empty secrets', () => {
      const recipient = generateX25519KeyPair();
      const secrets = {};

      const payload = encryptForSync(secrets, recipient.publicKeyBase64);
      const result = decryptFromSync(payload, recipient.privateKey);

      expect(result).toEqual({});
    });

    it('accepts full SPKI DER base64 (as stored by pemToBase64)', () => {
      // pemToBase64 strips PEM headers and returns full DER base64 (44 bytes for X25519)
      const kp = crypto.generateKeyPairSync('x25519');
      const fullDerBase64 = kp.publicKey
        .export({ type: 'spki', format: 'der' })
        .toString('base64');

      const secrets = { token: 'works-with-full-der' };
      const payload = encryptForSync(secrets, fullDerBase64);
      const result = decryptFromSync(payload, kp.privateKey);

      expect(result).toEqual(secrets);
    });
  });
});
