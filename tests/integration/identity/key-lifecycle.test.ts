/**
 * Integration test: Full key lifecycle.
 *
 * Tests the complete flow crossing module boundaries:
 * Generate → Encrypt → Persist → Reload → Decrypt → Use in signing
 * Migration from legacy → canonical → successful crypto operations
 * Rotation: create → verify → grace period
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanonicalIdentityManager } from '../../../src/identity/IdentityManager.js';
import { IdentityManager as ThreadlineIdentityManager } from '../../../src/threadline/client/IdentityManager.js';
import { sign, verify } from '../../../src/threadline/ThreadlineCrypto.js';
import {
  migrateFromLegacy,
  hasLegacyIdentity,
  hasCanonicalIdentity,
} from '../../../src/identity/Migration.js';
import {
  createRotation,
  verifyRotationProof,
} from '../../../src/identity/KeyRotation.js';
import {
  deriveRecoveryKeypair,
  verifyRecoveryCommitment,
} from '../../../src/identity/RecoveryPhrase.js';
import { computeFingerprint } from '../../../src/threadline/client/MessageEncryptor.js';

describe('Key Lifecycle Integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-lifecycle-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('create → persist → reload → sign/verify', () => {
    it('full lifecycle with encrypted key', () => {
      const pass = 'integration-test-passphrase';

      // Create
      const mgr1 = new CanonicalIdentityManager(tmpDir);
      const { identity: created, recoveryPhrase } = mgr1.create({ passphrase: pass });
      expect(recoveryPhrase).toBeDefined();

      // Sign something with the in-memory key
      const message = Buffer.from('test message');
      const signature = sign(created.privateKey, message);
      expect(verify(created.publicKey, message, signature)).toBe(true);

      // Reload from disk (new instance, simulating restart)
      const mgr2 = new CanonicalIdentityManager(tmpDir);
      const loaded = mgr2.load({ passphrase: pass });
      expect(loaded).not.toBeNull();

      // Verify the reloaded key produces the same results
      expect(loaded!.canonicalId).toBe(created.canonicalId);
      expect(loaded!.publicKey.equals(created.publicKey)).toBe(true);

      // Verify the signature with the reloaded key
      expect(verify(loaded!.publicKey, message, signature)).toBe(true);

      // Sign with reloaded key and verify with original
      const sig2 = sign(loaded!.privateKey, message);
      expect(verify(created.publicKey, message, sig2)).toBe(true);
    });
  });

  describe('legacy migration → Threadline compatibility', () => {
    it('migrated identity works with ThreadlineIdentityManager', () => {
      // Step 1: Create a legacy identity via ThreadlineIdentityManager
      const threadlineMgr = new ThreadlineIdentityManager(tmpDir);
      const legacyIdentity = threadlineMgr.getOrCreate();
      expect(hasLegacyIdentity(tmpDir)).toBe(true);

      // Step 2: Migrate to canonical
      const { identity: migrated } = migrateFromLegacy(tmpDir, { skipRecovery: true });
      expect(hasCanonicalIdentity(tmpDir)).toBe(true);

      // Step 3: Verify keys are the same
      expect(migrated.publicKey.equals(legacyIdentity.publicKey)).toBe(true);
      expect(migrated.privateKey.equals(legacyIdentity.privateKey)).toBe(true);

      // Step 4: New ThreadlineIdentityManager should find canonical
      const threadlineMgr2 = new ThreadlineIdentityManager(tmpDir);
      const reloaded = threadlineMgr2.getOrCreate();
      expect(reloaded.publicKey.equals(legacyIdentity.publicKey)).toBe(true);

      // Step 5: Threadline fingerprint still works
      expect(reloaded.fingerprint).toBe(computeFingerprint(legacyIdentity.publicKey));
    });
  });

  describe('canonical identity → Threadline fallback', () => {
    it('ThreadlineIdentityManager reads canonical when no legacy exists', () => {
      // Create canonical identity directly (no legacy)
      const canonMgr = new CanonicalIdentityManager(tmpDir);
      const { identity: canonical } = canonMgr.create({ skipRecovery: true });

      // ThreadlineIdentityManager should find it
      const threadlineMgr = new ThreadlineIdentityManager(tmpDir);
      const loaded = threadlineMgr.getOrCreate();
      expect(loaded.publicKey.equals(canonical.publicKey)).toBe(true);
      expect(loaded.privateKey.equals(canonical.privateKey)).toBe(true);
    });
  });

  describe('rotation → verify → re-sign', () => {
    it('rotated key produces valid proof and new signatures', () => {
      const mgr = new CanonicalIdentityManager(tmpDir);
      const { identity: original } = mgr.create({ skipRecovery: true });

      // Rotate
      const { newKeypair, proof } = createRotation(
        original.privateKey, original.publicKey, 'test rotation',
      );

      // Verify proof
      expect(verifyRotationProof(proof)).toBe(true);

      // New key can sign and verify
      const msg = Buffer.from('post-rotation message');
      const sig = sign(newKeypair.privateKey, msg);
      expect(verify(newKeypair.publicKey, msg, sig)).toBe(true);

      // Old key can still verify old signatures (grace period)
      const oldMsg = Buffer.from('pre-rotation message');
      const oldSig = sign(original.privateKey, oldMsg);
      expect(verify(original.publicKey, oldMsg, oldSig)).toBe(true);
    });
  });

  describe('recovery phrase → commitment verification', () => {
    it('recovery phrase can verify commitment from different session', () => {
      const mgr = new CanonicalIdentityManager(tmpDir);
      const { identity, recoveryPhrase } = mgr.create();
      expect(recoveryPhrase).toBeDefined();

      // Read back the recovery salt and commitment from disk
      const raw = mgr.readRaw()!;
      expect(raw.recoveryCommitment).toBeDefined();
      expect(raw.recoverySalt).toBeDefined();

      // Re-derive recovery keypair from phrase + salt (simulating recovery)
      const recoverySalt = Buffer.from(raw.recoverySalt!, 'base64');
      const recoveryKeypair = deriveRecoveryKeypair(recoveryPhrase!, recoverySalt);

      // Verify commitment
      const valid = verifyRecoveryCommitment(
        recoveryKeypair.publicKey,
        raw.recoveryCommitment!,
        identity.publicKey,
      );
      expect(valid).toBe(true);
    });
  });
});
