import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanonicalIdentityManager } from '../../../src/identity/IdentityManager.js';

describe('CanonicalIdentityManager', () => {
  let tmpDir: string;
  let manager: CanonicalIdentityManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-test-'));
    manager = new CanonicalIdentityManager(tmpDir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('create (unencrypted / dev mode)', () => {
    it('creates an identity with valid fields', () => {
      const { identity } = manager.create({ skipRecovery: true });
      expect(identity.publicKey).toBeInstanceOf(Buffer);
      expect(identity.publicKey.length).toBe(32);
      expect(identity.privateKey).toBeInstanceOf(Buffer);
      expect(identity.privateKey.length).toBe(32);
      expect(identity.x25519PublicKey).toBeInstanceOf(Buffer);
      expect(identity.x25519PublicKey.length).toBe(32);
      expect(identity.canonicalId).toMatch(/^[0-9a-f]{64}$/);
      expect(identity.displayFingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(identity.displayFingerprint).toBe(identity.canonicalId.slice(0, 16));
    });

    it('writes identity.json to disk', () => {
      manager.create({ skipRecovery: true });
      const filePath = path.join(tmpDir, 'identity.json');
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('sets file permissions to 0o600', () => {
      manager.create({ skipRecovery: true });
      const filePath = path.join(tmpDir, 'identity.json');
      const stat = fs.statSync(filePath);
      // Check owner-only read/write (masking off file type bits)
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it('stores unencrypted key with encryption=none', () => {
      manager.create({ skipRecovery: true });
      const raw = manager.readRaw();
      expect(raw).not.toBeNull();
      expect(raw!.privateKeyEncryption).toBe('none');
      expect(raw!.keySalt).toBeUndefined();
    });
  });

  describe('create (encrypted)', () => {
    it('encrypts private key with passphrase', () => {
      const { identity } = manager.create({ passphrase: 'test-pass', skipRecovery: true });
      const raw = manager.readRaw();
      expect(raw!.privateKeyEncryption).toBe('xchacha20-poly1305+argon2id');
      expect(raw!.keySalt).toBeDefined();
      // The raw privateKey in file should NOT be a simple base64 of the raw key
      const rawKeyBase64 = identity.privateKey.toString('base64');
      expect(raw!.privateKey).not.toBe(rawKeyBase64);
    });
  });

  describe('create with recovery', () => {
    it('returns a 24-word recovery phrase', () => {
      const { recoveryPhrase } = manager.create();
      expect(recoveryPhrase).toBeDefined();
      expect(recoveryPhrase!.split(' ')).toHaveLength(24);
    });

    it('stores recovery commitment in identity file', () => {
      manager.create();
      const raw = manager.readRaw();
      expect(raw!.recoveryCommitment).toBeDefined();
      expect(raw!.recoverySalt).toBeDefined();
    });
  });

  describe('load (unencrypted)', () => {
    it('loads an existing identity', () => {
      const { identity: created } = manager.create({ skipRecovery: true });

      // New manager instance (simulates restart)
      const manager2 = new CanonicalIdentityManager(tmpDir);
      const loaded = manager2.load();

      expect(loaded).not.toBeNull();
      expect(loaded!.canonicalId).toBe(created.canonicalId);
      expect(loaded!.publicKey.equals(created.publicKey)).toBe(true);
      expect(loaded!.privateKey.equals(created.privateKey)).toBe(true);
    });

    it('returns null when no identity exists', () => {
      const loaded = manager.load();
      expect(loaded).toBeNull();
    });
  });

  describe('load (encrypted)', () => {
    it('decrypts with correct passphrase', () => {
      const { identity: created } = manager.create({ passphrase: 'my-pass', skipRecovery: true });

      const manager2 = new CanonicalIdentityManager(tmpDir);
      const loaded = manager2.load({ passphrase: 'my-pass' });

      expect(loaded).not.toBeNull();
      expect(loaded!.privateKey.equals(created.privateKey)).toBe(true);
    });

    it('throws on wrong passphrase', () => {
      manager.create({ passphrase: 'my-pass', skipRecovery: true });

      const manager2 = new CanonicalIdentityManager(tmpDir);
      expect(() => manager2.load({ passphrase: 'wrong-pass' }))
        .toThrow('Decryption failed');
    });

    it('throws when passphrase is required but not provided', () => {
      manager.create({ passphrase: 'my-pass', skipRecovery: true });

      const manager2 = new CanonicalIdentityManager(tmpDir);
      expect(() => manager2.load())
        .toThrow('Passphrase required');
    });
  });

  describe('exists', () => {
    it('returns false before creation', () => {
      expect(manager.exists()).toBe(false);
    });

    it('returns true after creation', () => {
      manager.create({ skipRecovery: true });
      expect(manager.exists()).toBe(true);
    });
  });

  describe('get', () => {
    it('returns null before create/load', () => {
      expect(manager.get()).toBeNull();
    });

    it('returns identity after create', () => {
      manager.create({ skipRecovery: true });
      expect(manager.get()).not.toBeNull();
    });
  });

  describe('corrupted file handling', () => {
    it('returns null for corrupted JSON', () => {
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'identity.json'), 'not json');
      expect(manager.load()).toBeNull();
    });
  });
});
