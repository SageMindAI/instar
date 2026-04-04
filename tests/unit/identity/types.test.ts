import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  computeCanonicalId,
  computeDisplayFingerprint,
  CANONICAL_ID_DOMAIN,
  IDENTITY_SCHEMA_VERSION,
  DISPLAY_FINGERPRINT_BYTES,
} from '../../../src/identity/types.js';

describe('Identity Types', () => {
  describe('computeCanonicalId', () => {
    it('produces a 64-char hex string', () => {
      const pubKey = crypto.randomBytes(32);
      const id = computeCanonicalId(pubKey);
      expect(id).toHaveLength(64);
      expect(id).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic for the same key', () => {
      const pubKey = crypto.randomBytes(32);
      expect(computeCanonicalId(pubKey)).toBe(computeCanonicalId(pubKey));
    });

    it('produces different IDs for different keys', () => {
      const keyA = crypto.randomBytes(32);
      const keyB = crypto.randomBytes(32);
      expect(computeCanonicalId(keyA)).not.toBe(computeCanonicalId(keyB));
    });

    it('uses domain separation (not raw SHA-256 of key)', () => {
      const pubKey = crypto.randomBytes(32);
      const rawHash = crypto.createHash('sha256').update(pubKey).digest('hex');
      const canonicalId = computeCanonicalId(pubKey);
      expect(canonicalId).not.toBe(rawHash);
    });

    it('matches manual computation with domain prefix', () => {
      const pubKey = Buffer.alloc(32, 0xab);
      const expected = crypto.createHash('sha256')
        .update(Buffer.from(CANONICAL_ID_DOMAIN, 'utf-8'))
        .update(pubKey)
        .digest('hex');
      expect(computeCanonicalId(pubKey)).toBe(expected);
    });
  });

  describe('computeDisplayFingerprint', () => {
    it('returns first 16 hex chars of canonical ID', () => {
      const canonicalId = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
      expect(computeDisplayFingerprint(canonicalId)).toBe('abcdef0123456789');
    });

    it('has the correct byte length', () => {
      const pubKey = crypto.randomBytes(32);
      const canonicalId = computeCanonicalId(pubKey);
      const fp = computeDisplayFingerprint(canonicalId);
      expect(fp).toHaveLength(DISPLAY_FINGERPRINT_BYTES * 2);
    });
  });

  describe('constants', () => {
    it('schema version is 1', () => {
      expect(IDENTITY_SCHEMA_VERSION).toBe(1);
    });

    it('display fingerprint is 8 bytes', () => {
      expect(DISPLAY_FINGERPRINT_BYTES).toBe(8);
    });
  });
});
