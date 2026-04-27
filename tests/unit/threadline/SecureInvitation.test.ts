import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecureInvitationManager } from '../../../src/threadline/SecureInvitation.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { computeFingerprint } from '../../../src/threadline/client/MessageEncryptor.js';

describe('SecureInvitation', () => {
  let tmpDir: string;
  let mgr: SecureInvitationManager;
  let issuer: { publicKey: Buffer; privateKey: Buffer; fingerprint: string };
  let redeemer: { publicKey: Buffer; privateKey: Buffer; fingerprint: string };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invite-test-'));
    mgr = new SecureInvitationManager(tmpDir);

    const issuerKp = generateIdentityKeyPair();
    issuer = { ...issuerKp, fingerprint: computeFingerprint(issuerKp.publicKey) };

    const redeemerKp = generateIdentityKeyPair();
    redeemer = { ...redeemerKp, fingerprint: computeFingerprint(redeemerKp.publicKey) };
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('creates a valid signed token', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey);
      expect(token.version).toBe(1);
      expect(token.type).toBe('invitation');
      expect(token.issuer).toBe(issuer.fingerprint);
      expect(token.scope).toBe('verified');
      expect(token.maxUses).toBe(1);
      expect(token.signature).toBeDefined();
      expect(token.tokenId.length).toBeGreaterThan(0);
      expect(token.nonce.length).toBe(64); // 32 bytes hex
    });

    it('creates recipient-bound token', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey, {
        recipient: redeemer.fingerprint,
      });
      expect(token.recipient).toBe(redeemer.fingerprint);
    });
  });

  describe('validate', () => {
    it('validates a correct token', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey);
      const result = mgr.validate(token, issuer.publicKey, redeemer.fingerprint);
      expect(result.valid).toBe(true);
    });

    it('rejects token signed with wrong key', () => {
      const otherKp = generateIdentityKeyPair();
      const token = mgr.create(issuer.fingerprint, issuer.privateKey);
      const result = mgr.validate(token, otherKp.publicKey, redeemer.fingerprint);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Invalid signature');
    });

    it('rejects expired token', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey, { expiryMs: -1000 });
      const result = mgr.validate(token, issuer.publicKey, redeemer.fingerprint);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('expired');
    });

    it('rejects already-redeemed token', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey);
      mgr.validate(token, issuer.publicKey, redeemer.fingerprint, true); // redeem
      const result = mgr.validate(token, issuer.publicKey, redeemer.fingerprint);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('already redeemed');
    });

    it('rejects wrong recipient for bound token', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey, {
        recipient: 'specific-agent',
      });
      const result = mgr.validate(token, issuer.publicKey, redeemer.fingerprint);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('different recipient');
    });

    it('accepts correct recipient for bound token', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey, {
        recipient: redeemer.fingerprint,
      });
      const result = mgr.validate(token, issuer.publicKey, redeemer.fingerprint);
      expect(result.valid).toBe(true);
    });

    it('rejects tampered token', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey);
      const tampered = { ...token, nonce: 'tampered'.padEnd(64, '0') };
      const result = mgr.validate(tampered, issuer.publicKey, redeemer.fingerprint);
      expect(result.valid).toBe(false);
    });
  });

  describe('revoke', () => {
    it('revokes an unredeemed token', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey);
      expect(mgr.revoke(token.tokenId)).toBe(true);

      const result = mgr.validate(token, issuer.publicKey, redeemer.fingerprint);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('revoked');
    });

    it('cannot revoke already-redeemed token', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey);
      mgr.validate(token, issuer.publicKey, redeemer.fingerprint, true);
      expect(mgr.revoke(token.tokenId)).toBe(false);
    });
  });

  describe('persistence', () => {
    it('redemptions survive restart', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey);
      mgr.validate(token, issuer.publicKey, redeemer.fingerprint, true);

      const mgr2 = new SecureInvitationManager(tmpDir);
      expect(mgr2.isRedeemed(token.tokenId)).toBe(true);
    });
  });
});
