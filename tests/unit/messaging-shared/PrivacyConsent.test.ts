import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { PrivacyConsent } from '../../../src/messaging/shared/PrivacyConsent.js';

describe('PrivacyConsent', () => {
  let tmpDir: string;
  let consentPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-'));
    consentPath = path.join(tmpDir, 'consent.json');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createConsent(overrides: Partial<Parameters<typeof PrivacyConsent['prototype']['hasConsent']> extends never[] ? Record<string, unknown> : Record<string, unknown>> = {}): PrivacyConsent {
    return new PrivacyConsent({
      consentPath,
      ...overrides,
    });
  }

  // ── Basic consent flow ──────────────────────────────────

  describe('consent flow', () => {
    it('new user has no consent', () => {
      const consent = createConsent();
      expect(consent.hasConsent('+14155552671')).toBe(false);
    });

    it('grants consent', () => {
      const consent = createConsent();
      consent.grantConsent('+14155552671');
      expect(consent.hasConsent('+14155552671')).toBe(true);
    });

    it('revokes consent', () => {
      const consent = createConsent();
      consent.grantConsent('+14155552671');
      expect(consent.revokeConsent('+14155552671')).toBe(true);
      expect(consent.hasConsent('+14155552671')).toBe(false);
    });

    it('revoke returns false for non-existent user', () => {
      const consent = createConsent();
      expect(consent.revokeConsent('+19999999999')).toBe(false);
    });

    it('allows all when consent not required', () => {
      const consent = new PrivacyConsent({
        consentPath,
        requireConsent: false,
      });
      expect(consent.hasConsent('+14155552671')).toBe(true);
    });
  });

  // ── Pending consent ──────────────────────────────────

  describe('pending consent', () => {
    it('tracks pending consent state', () => {
      const consent = createConsent();
      expect(consent.isPendingConsent('+14155552671')).toBe(false);

      consent.markPendingConsent('+14155552671');
      expect(consent.isPendingConsent('+14155552671')).toBe(true);
    });

    it('clears pending on grant', () => {
      const consent = createConsent();
      consent.markPendingConsent('+14155552671');

      const result = consent.handleConsentResponse('+14155552671', 'yes');
      expect(result).toBe('granted');
      expect(consent.isPendingConsent('+14155552671')).toBe(false);
      expect(consent.hasConsent('+14155552671')).toBe(true);
    });

    it('clears pending on deny', () => {
      const consent = createConsent();
      consent.markPendingConsent('+14155552671');

      const result = consent.handleConsentResponse('+14155552671', 'no');
      expect(result).toBe('denied');
      expect(consent.isPendingConsent('+14155552671')).toBe(false);
      expect(consent.hasConsent('+14155552671')).toBe(false);
    });

    it('returns null for non-pending users', () => {
      const consent = createConsent();
      expect(consent.handleConsentResponse('+14155552671', 'yes')).toBeNull();
    });

    it('returns null for unrecognized responses', () => {
      const consent = createConsent();
      consent.markPendingConsent('+14155552671');

      expect(consent.handleConsentResponse('+14155552671', 'hello there')).toBeNull();
      expect(consent.isPendingConsent('+14155552671')).toBe(true);
    });
  });

  // ── Consent response parsing ──────────────────────────

  describe('consent response parsing', () => {
    const positiveResponses = ['I agree', 'yes', 'agree', 'ok', 'okay', 'sure', 'accept', 'y'];
    const negativeResponses = ['no', 'stop', 'deny', 'refuse', 'decline', 'n'];

    for (const response of positiveResponses) {
      it(`accepts "${response}" as positive consent`, () => {
        const consent = createConsent();
        consent.markPendingConsent('+14155552671');
        expect(consent.handleConsentResponse('+14155552671', response)).toBe('granted');
      });
    }

    for (const response of negativeResponses) {
      it(`accepts "${response}" as negative consent`, () => {
        const consent = createConsent();
        consent.markPendingConsent('+14155552671');
        expect(consent.handleConsentResponse('+14155552671', response)).toBe('denied');
      });
    }

    it('handles case-insensitive responses', () => {
      const consent = createConsent();
      consent.markPendingConsent('+14155552671');
      expect(consent.handleConsentResponse('+14155552671', 'YES')).toBe('granted');
    });

    it('handles whitespace-padded responses', () => {
      const consent = createConsent();
      consent.markPendingConsent('+14155552671');
      expect(consent.handleConsentResponse('+14155552671', '  yes  ')).toBe('granted');
    });
  });

  // ── Persistence ──────────────────────────────────

  describe('persistence', () => {
    it('persists consent records to disk', () => {
      const consent1 = createConsent();
      consent1.grantConsent('+14155552671');
      consent1.grantConsent('+447911123456');

      // Load fresh instance from same path
      const consent2 = createConsent();
      expect(consent2.hasConsent('+14155552671')).toBe(true);
      expect(consent2.hasConsent('+447911123456')).toBe(true);
    });

    it('persists revocation', () => {
      const consent1 = createConsent();
      consent1.grantConsent('+14155552671');
      consent1.revokeConsent('+14155552671');

      const consent2 = createConsent();
      expect(consent2.hasConsent('+14155552671')).toBe(false);
    });

    it('handles missing consent file gracefully', () => {
      const consent = new PrivacyConsent({
        consentPath: path.join(tmpDir, 'nonexistent', 'consent.json'),
      });
      expect(consent.hasConsent('+14155552671')).toBe(false);
    });

    it('handles corrupted consent file gracefully', () => {
      fs.writeFileSync(consentPath, 'not valid json{{{');
      const consent = createConsent();
      expect(consent.hasConsent('+14155552671')).toBe(false);
    });
  });

  // ── Consent versioning ──────────────────────────────

  describe('versioning', () => {
    it('requires re-consent for new version', () => {
      const consent1 = new PrivacyConsent({
        consentPath,
        currentVersion: 1,
      });
      consent1.grantConsent('+14155552671');
      expect(consent1.hasConsent('+14155552671')).toBe(true);

      // Bump version
      const consent2 = new PrivacyConsent({
        consentPath,
        currentVersion: 2,
      });
      expect(consent2.hasConsent('+14155552671')).toBe(false);
    });
  });

  // ── Records ──────────────────────────────────

  describe('records', () => {
    it('returns all consent records', () => {
      const consent = createConsent();
      consent.grantConsent('+14155552671');
      consent.grantConsent('+447911123456');

      const records = consent.getRecords();
      expect(records).toHaveLength(2);
      expect(records.map(r => r.userId).sort()).toEqual(['+14155552671', '+447911123456']);
    });

    it('records include timestamp', () => {
      const consent = createConsent();
      consent.grantConsent('+14155552671');

      const records = consent.getRecords();
      expect(records[0].consentedAt).toBeDefined();
      expect(new Date(records[0].consentedAt).getTime()).toBeGreaterThan(0);
    });

    it('tracks size', () => {
      const consent = createConsent();
      expect(consent.size).toBe(0);

      consent.grantConsent('+14155552671');
      expect(consent.size).toBe(1);

      consent.grantConsent('+447911123456');
      expect(consent.size).toBe(2);

      consent.revokeConsent('+14155552671');
      expect(consent.size).toBe(1);
    });
  });

  // ── Custom consent message ──────────────────────────

  describe('custom consent message', () => {
    it('uses default message when none provided', () => {
      const consent = createConsent();
      expect(consent.getConsentMessage()).toContain('Before we chat');
    });

    it('uses custom message when provided', () => {
      const consent = new PrivacyConsent({
        consentPath,
        consentMessage: 'Custom privacy notice. Reply yes to continue.',
      });
      expect(consent.getConsentMessage()).toBe('Custom privacy notice. Reply yes to continue.');
    });
  });
});
