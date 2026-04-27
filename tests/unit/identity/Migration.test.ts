import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  hasLegacyIdentity,
  hasCanonicalIdentity,
  migrateFromLegacy,
  getLegacyFingerprint,
} from '../../../src/identity/Migration.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { computeFingerprint } from '../../../src/threadline/client/MessageEncryptor.js';
import { computeCanonicalId, computeDisplayFingerprint } from '../../../src/identity/types.js';

describe('Migration', () => {
  let tmpDir: string;
  let keypair: { publicKey: Buffer; privateKey: Buffer };
  let legacyFingerprint: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-test-'));
    keypair = generateIdentityKeyPair();
    legacyFingerprint = computeFingerprint(keypair.publicKey);

    // Create legacy identity file
    const legacyDir = path.join(tmpDir, 'threadline');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'identity.json'), JSON.stringify({
      fingerprint: legacyFingerprint,
      publicKey: keypair.publicKey.toString('base64'),
      privateKey: keypair.privateKey.toString('base64'),
      createdAt: '2026-03-01T00:00:00.000Z',
    }, null, 2));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('hasLegacyIdentity', () => {
    it('returns true when legacy exists', () => {
      expect(hasLegacyIdentity(tmpDir)).toBe(true);
    });

    it('returns false when no legacy', () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'));
      expect(hasLegacyIdentity(emptyDir)).toBe(false);
      // safe-git-allow: incremental-migration
      fs.rmSync(emptyDir, { recursive: true });
    });
  });

  describe('hasCanonicalIdentity', () => {
    it('returns false before migration', () => {
      expect(hasCanonicalIdentity(tmpDir)).toBe(false);
    });

    it('returns true after migration', () => {
      migrateFromLegacy(tmpDir, { skipRecovery: true });
      expect(hasCanonicalIdentity(tmpDir)).toBe(true);
    });
  });

  describe('migrateFromLegacy', () => {
    it('creates canonical identity.json from legacy', () => {
      const result = migrateFromLegacy(tmpDir, { skipRecovery: true });
      expect(result.identity.publicKey.equals(keypair.publicKey)).toBe(true);
      expect(result.identity.privateKey.equals(keypair.privateKey)).toBe(true);
      expect(result.identity.canonicalId).toBe(computeCanonicalId(keypair.publicKey));
      expect(result.identity.displayFingerprint).toBe(
        computeDisplayFingerprint(computeCanonicalId(keypair.publicKey)),
      );
      expect(result.legacyPath).toContain('threadline/identity.json');
    });

    it('preserves legacy file (no deletion)', () => {
      migrateFromLegacy(tmpDir, { skipRecovery: true });
      expect(fs.existsSync(path.join(tmpDir, 'threadline', 'identity.json'))).toBe(true);
    });

    it('preserves original createdAt timestamp', () => {
      const result = migrateFromLegacy(tmpDir, { skipRecovery: true });
      expect(result.identity.createdAt).toBe('2026-03-01T00:00:00.000Z');
    });

    it('generates recovery phrase when not skipped', () => {
      const result = migrateFromLegacy(tmpDir);
      expect(result.recoveryPhrase).toBeDefined();
      expect(result.recoveryPhrase!.split(' ')).toHaveLength(24);
    });

    it('encrypts private key when passphrase provided', () => {
      migrateFromLegacy(tmpDir, { passphrase: 'test-pass', skipRecovery: true });
      const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'identity.json'), 'utf-8'));
      expect(raw.privateKeyEncryption).toBe('xchacha20-poly1305+argon2id');
      expect(raw.keySalt).toBeDefined();
    });

    it('sets file permissions to 0o600', () => {
      migrateFromLegacy(tmpDir, { skipRecovery: true });
      const stat = fs.statSync(path.join(tmpDir, 'identity.json'));
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it('throws if no legacy exists', () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'));
      expect(() => migrateFromLegacy(emptyDir)).toThrow('No legacy identity');
      // safe-git-allow: incremental-migration
      fs.rmSync(emptyDir, { recursive: true });
    });

    it('throws if canonical already exists', () => {
      migrateFromLegacy(tmpDir, { skipRecovery: true });
      expect(() => migrateFromLegacy(tmpDir, { skipRecovery: true }))
        .toThrow('Canonical identity already exists');
    });
  });

  describe('getLegacyFingerprint', () => {
    it('returns the legacy fingerprint', () => {
      expect(getLegacyFingerprint(tmpDir)).toBe(legacyFingerprint);
    });

    it('returns null when no legacy exists', () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'));
      expect(getLegacyFingerprint(emptyDir)).toBeNull();
      // safe-git-allow: incremental-migration
      fs.rmSync(emptyDir, { recursive: true });
    });
  });
});
