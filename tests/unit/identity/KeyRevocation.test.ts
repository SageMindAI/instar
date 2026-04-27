import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RevocationManager } from '../../../src/identity/KeyRevocation.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import {
  generateRecoveryPhrase,
  deriveRecoveryKeypair,
  createRecoveryCommitment,
  generateRecoverySalt,
} from '../../../src/identity/RecoveryPhrase.js';
import { computeCanonicalId, RECOVERY_TIMELOCK_MS, MAX_RECOVERY_ATTEMPTS } from '../../../src/identity/types.js';

describe('RevocationManager', () => {
  let tmpDir: string;
  let manager: RevocationManager;
  let primaryKeypair: { publicKey: Buffer; privateKey: Buffer };
  let recoveryPhrase: string;
  let recoverySalt: Buffer;
  let recoveryKeypair: { publicKey: Buffer; privateKey: Buffer };
  let commitment: string;
  let canonicalId: string;
  let newKeypair: { publicKey: Buffer; privateKey: Buffer };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revocation-test-'));
    manager = new RevocationManager(tmpDir);

    primaryKeypair = generateIdentityKeyPair();
    recoveryPhrase = generateRecoveryPhrase();
    recoverySalt = generateRecoverySalt();
    recoveryKeypair = deriveRecoveryKeypair(recoveryPhrase, recoverySalt);
    commitment = createRecoveryCommitment(recoveryKeypair.publicKey, primaryKeypair.privateKey);
    canonicalId = computeCanonicalId(primaryKeypair.publicKey);
    newKeypair = generateIdentityKeyPair();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('initiate', () => {
    it('creates a pending revocation with time-lock', () => {
      const req = manager.initiate(
        recoveryKeypair.privateKey, recoveryKeypair.publicKey,
        canonicalId, newKeypair.publicKey,
        primaryKeypair.publicKey, commitment,
      );

      expect(req.status).toBe('pending');
      expect(req.targetCanonicalId).toBe(canonicalId);
      expect(req.newPublicKey).toBe(newKeypair.publicKey.toString('base64'));
      expect(new Date(req.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('rejects with wrong recovery commitment', () => {
      const wrongKeypair = deriveRecoveryKeypair(generateRecoveryPhrase(), recoverySalt);
      expect(() => manager.initiate(
        wrongKeypair.privateKey, wrongKeypair.publicKey,
        canonicalId, newKeypair.publicKey,
        primaryKeypair.publicKey, commitment,
      )).toThrow('Recovery commitment verification failed');
    });

    it('enforces rate limiting after max attempts', () => {
      // Use up all attempts (some will fail with wrong commitment)
      const wrongKeypair = deriveRecoveryKeypair(generateRecoveryPhrase(), recoverySalt);
      for (let i = 0; i < MAX_RECOVERY_ATTEMPTS; i++) {
        try {
          manager.initiate(
            wrongKeypair.privateKey, wrongKeypair.publicKey,
            canonicalId, newKeypair.publicKey,
            primaryKeypair.publicKey, commitment,
          );
        } catch { /* expected */ }
      }

      // Next attempt should be rate-limited
      expect(() => manager.initiate(
        recoveryKeypair.privateKey, recoveryKeypair.publicKey,
        canonicalId, newKeypair.publicKey,
        primaryKeypair.publicKey, commitment,
      )).toThrow('Rate limited');
    });
  });

  describe('cancel', () => {
    it('cancels a pending revocation with primary key proof', () => {
      manager.initiate(
        recoveryKeypair.privateKey, recoveryKeypair.publicKey,
        canonicalId, newKeypair.publicKey,
        primaryKeypair.publicKey, commitment,
      );

      const cancelled = manager.cancel(primaryKeypair.privateKey, primaryKeypair.publicKey);
      expect(cancelled).toBe(true);
      expect(manager.getPending()).toBeNull();
    });

    it('returns false when nothing is pending', () => {
      expect(manager.cancel(primaryKeypair.privateKey, primaryKeypair.publicKey)).toBe(false);
    });
  });

  describe('checkAndActivate', () => {
    it('does not activate before time-lock expires', () => {
      manager.initiate(
        recoveryKeypair.privateKey, recoveryKeypair.publicKey,
        canonicalId, newKeypair.publicKey,
        primaryKeypair.publicKey, commitment,
      );

      const result = manager.checkAndActivate(new Date());
      expect(result).toBeNull();
    });

    it('activates after time-lock expires', () => {
      manager.initiate(
        recoveryKeypair.privateKey, recoveryKeypair.publicKey,
        canonicalId, newKeypair.publicKey,
        primaryKeypair.publicKey, commitment,
      );

      const future = new Date(Date.now() + RECOVERY_TIMELOCK_MS + 1000);
      const result = manager.checkAndActivate(future);
      expect(result).not.toBeNull();
      expect(result!.status).toBe('active');
    });
  });

  describe('audit log', () => {
    it('records all actions', () => {
      manager.initiate(
        recoveryKeypair.privateKey, recoveryKeypair.publicKey,
        canonicalId, newKeypair.publicKey,
        primaryKeypair.publicKey, commitment,
      );
      manager.cancel(primaryKeypair.privateKey, primaryKeypair.publicKey);

      const log = manager.getAuditLog();
      expect(log.length).toBeGreaterThanOrEqual(2);
      expect(log[0].action).toBe('initiate');
      expect(log[1].action).toBe('cancel');
    });
  });

  describe('persistence', () => {
    it('survives restart', () => {
      manager.initiate(
        recoveryKeypair.privateKey, recoveryKeypair.publicKey,
        canonicalId, newKeypair.publicKey,
        primaryKeypair.publicKey, commitment,
      );

      // Simulate restart
      const manager2 = new RevocationManager(tmpDir);
      expect(manager2.getPending()).not.toBeNull();
      expect(manager2.getPending()!.targetCanonicalId).toBe(canonicalId);
    });
  });

  describe('getRemainingAttempts', () => {
    it('starts at max', () => {
      expect(manager.getRemainingAttempts()).toBe(MAX_RECOVERY_ATTEMPTS);
    });

    it('decrements on each attempt', () => {
      manager.initiate(
        recoveryKeypair.privateKey, recoveryKeypair.publicKey,
        canonicalId, newKeypair.publicKey,
        primaryKeypair.publicKey, commitment,
      );
      expect(manager.getRemainingAttempts()).toBe(MAX_RECOVERY_ATTEMPTS - 1);
    });
  });
});
