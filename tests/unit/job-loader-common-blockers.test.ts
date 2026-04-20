/**
 * Tests for commonBlockers validation in JobLoader (PROP-232 Autonomy Guard).
 *
 * Validates the validateCommonBlockers() function within validateJob().
 * Covers: valid structures, missing required fields, type mismatches,
 * max entry limits, optional field validation, status enum, edge cases.
 */

import { describe, it, expect } from 'vitest';
import { validateJob, validateCommonBlockers } from '../../src/scheduler/JobLoader.js';

// ---------------------------------------------------------------------------
// Base valid job (reused across all tests)
// ---------------------------------------------------------------------------

const validJob = {
  slug: 'test-job',
  name: 'Test Job',
  description: 'A test job',
  schedule: '0 */4 * * *',
  priority: 'medium',
  expectedDurationMinutes: 5,
  model: 'sonnet',
  enabled: true,
  execute: { type: 'skill', value: 'scan' },
};

const validBlocker = {
  description: 'npm login expired',
  resolution: 'Run npm login with stored credentials from SecretStore',
  toolsNeeded: ['bash', 'secret-store'],
  credentials: 'npm-token',
  addedFrom: 'agent',
  addedAt: '2026-03-01T00:00:00Z',
  successCount: 3,
  status: 'confirmed' as const,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JobLoader — commonBlockers validation', () => {
  // ── Accepts valid configurations ─────────────────────────────────────

  describe('valid configurations', () => {
    it('accepts job without commonBlockers (optional field)', () => {
      expect(() => validateJob(validJob)).not.toThrow();
    });

    it('accepts job with empty commonBlockers object', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {},
      })).not.toThrow();
    });

    it('accepts job with a fully-specified blocker', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: { 'npm-auth': validBlocker },
      })).not.toThrow();
    });

    it('accepts job with minimal blocker (description + resolution only)', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'basic-blocker': {
            description: 'Something broke',
            resolution: 'Fix it',
          },
        },
      })).not.toThrow();
    });

    it('accepts job with multiple blockers', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'npm-auth': validBlocker,
          'git-push': {
            description: 'Git push rejected',
            resolution: 'Pull and rebase first',
          },
          'api-rate-limit': {
            description: 'API rate limit hit',
            resolution: 'Wait 60 seconds and retry',
            toolsNeeded: ['bash'],
            successCount: 7,
            status: 'confirmed',
          },
        },
      })).not.toThrow();
    });

    it('accepts blocker with pending status', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'new-blocker': {
            description: 'Untested resolution',
            resolution: 'Try this approach',
            status: 'pending',
            successCount: 0,
          },
        },
      })).not.toThrow();
    });

    it('accepts blocker with expired status', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'old-blocker': {
            description: 'Old pattern',
            resolution: 'Was fixed',
            status: 'expired',
          },
        },
      })).not.toThrow();
    });

    it('accepts blocker with expiresAt and lastUsedAt', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'temp-blocker': {
            description: 'Temporary auth issue',
            resolution: 'Re-authenticate',
            expiresAt: '2026-12-31T23:59:59Z',
            lastUsedAt: '2026-03-01T12:00:00Z',
          },
        },
      })).not.toThrow();
    });

    it('accepts blocker with credentials as string', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'cred-test': {
            description: 'X',
            resolution: 'Y',
            credentials: 'npm-token',
          },
        },
      })).not.toThrow();
    });

    it('accepts blocker with credentials as array', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'cred-test': {
            description: 'X',
            resolution: 'Y',
            credentials: ['npm-token', 'bitwarden'],
          },
        },
      })).not.toThrow();
    });
  });

  // ── Rejects invalid top-level structure ──────────────────────────────

  describe('top-level structure validation', () => {
    it('rejects non-object commonBlockers (string)', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: 'not an object',
      })).toThrow('"commonBlockers" must be a plain object');
    });

    it('rejects non-object commonBlockers (array)', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: [validBlocker],
      })).toThrow('"commonBlockers" must be a plain object');
    });

    it('rejects non-object commonBlockers (number)', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: 42,
      })).toThrow('"commonBlockers" must be a plain object');
    });

    it('rejects null commonBlockers', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: null,
      })).toThrow('"commonBlockers" must be a plain object');
    });
  });

  // ── Max entries limit ────────────────────────────────────────────────

  describe('max entries limit', () => {
    it('accepts exactly 20 blockers', () => {
      const blockers: Record<string, typeof validBlocker> = {};
      for (let i = 0; i < 20; i++) {
        blockers[`blocker-${i}`] = { ...validBlocker, description: `Blocker ${i}` };
      }
      expect(() => validateJob({
        ...validJob,
        commonBlockers: blockers,
      })).not.toThrow();
    });

    it('rejects 21 blockers', () => {
      const blockers: Record<string, typeof validBlocker> = {};
      for (let i = 0; i < 21; i++) {
        blockers[`blocker-${i}`] = { ...validBlocker, description: `Blocker ${i}` };
      }
      expect(() => validateJob({
        ...validJob,
        commonBlockers: blockers,
      })).toThrow('has 21 entries, max is 20');
    });

    it('rejects 100 blockers', () => {
      const blockers: Record<string, typeof validBlocker> = {};
      for (let i = 0; i < 100; i++) {
        blockers[`b-${i}`] = { ...validBlocker, description: `Blocker ${i}` };
      }
      expect(() => validateJob({
        ...validJob,
        commonBlockers: blockers,
      })).toThrow('has 100 entries, max is 20');
    });
  });

  // ── Required fields (description, resolution) ───────────────────────

  describe('required fields', () => {
    it('rejects blocker without description', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'bad': { resolution: 'Fix it' },
        },
      })).toThrow('"description" is required');
    });

    it('rejects blocker with empty description', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'bad': { description: '', resolution: 'Fix it' },
        },
      })).toThrow('"description" is required');
    });

    it('rejects blocker with whitespace-only description', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'bad': { description: '   ', resolution: 'Fix it' },
        },
      })).toThrow('"description" is required');
    });

    it('rejects blocker with non-string description', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'bad': { description: 123, resolution: 'Fix it' },
        },
      })).toThrow('"description" is required');
    });

    it('rejects blocker without resolution', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'bad': { description: 'Something broke' },
        },
      })).toThrow('"resolution" is required');
    });

    it('rejects blocker with empty resolution', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'bad': { description: 'Something broke', resolution: '' },
        },
      })).toThrow('"resolution" is required');
    });

    it('rejects blocker with whitespace-only resolution', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'bad': { description: 'Something broke', resolution: '  \n  ' },
        },
      })).toThrow('"resolution" is required');
    });
  });

  // ── Entry-level type validation ──────────────────────────────────────

  describe('entry-level validation', () => {
    it('rejects non-object entry (string)', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: { 'bad': 'not an object' },
      })).toThrow('must be an object');
    });

    it('rejects non-object entry (null)', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: { 'bad': null },
      })).toThrow('must be an object');
    });

    it('rejects non-object entry (number)', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: { 'bad': 42 },
      })).toThrow('must be an object');
    });

    it('rejects array entry', () => {
      // Arrays are caught by the Array.isArray check
      expect(() => validateJob({
        ...validJob,
        commonBlockers: { 'bad': [1, 2, 3] },
      })).toThrow('must be an object');
    });
  });

  // ── toolsNeeded validation ───────────────────────────────────────────

  describe('toolsNeeded validation', () => {
    it('accepts valid toolsNeeded array', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'ok': { description: 'X', resolution: 'Y', toolsNeeded: ['bash', 'curl'] },
        },
      })).not.toThrow();
    });

    it('accepts empty toolsNeeded array', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'ok': { description: 'X', resolution: 'Y', toolsNeeded: [] },
        },
      })).not.toThrow();
    });

    it('rejects non-array toolsNeeded', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'bad': { description: 'X', resolution: 'Y', toolsNeeded: 'bash' },
        },
      })).toThrow('"toolsNeeded" must be an array');
    });

    it('rejects non-string entries in toolsNeeded', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'bad': { description: 'X', resolution: 'Y', toolsNeeded: [123] },
        },
      })).toThrow('"toolsNeeded" entries must be strings');
    });
  });

  // ── credentials validation ──────────────────────────────────────────

  describe('credentials validation', () => {
    it('accepts string credentials', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'ok': { description: 'X', resolution: 'Y', credentials: 'npm-token' },
        },
      })).not.toThrow();
    });

    it('accepts array credentials', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'ok': { description: 'X', resolution: 'Y', credentials: ['npm', 'bitwarden'] },
        },
      })).not.toThrow();
    });

    it('rejects non-string/non-array credentials', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'bad': { description: 'X', resolution: 'Y', credentials: 123 },
        },
      })).toThrow('"credentials" must be a string or array');
    });

    it('rejects non-string entries in credentials array', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'bad': { description: 'X', resolution: 'Y', credentials: [123] },
        },
      })).toThrow('"credentials" entries must be strings');
    });
  });

  // ── Optional string fields ──────────────────────────────────────────

  describe('optional string fields', () => {
    const stringFields = ['addedFrom', 'addedAt', 'confirmedAt', 'expiresAt', 'lastUsedAt'];

    for (const field of stringFields) {
      it(`accepts valid ${field} string`, () => {
        expect(() => validateJob({
          ...validJob,
          commonBlockers: {
            'ok': { description: 'X', resolution: 'Y', [field]: 'some-value' },
          },
        })).not.toThrow();
      });

      it(`rejects non-string ${field}`, () => {
        expect(() => validateJob({
          ...validJob,
          commonBlockers: {
            'bad': { description: 'X', resolution: 'Y', [field]: 123 },
          },
        })).toThrow(`"${field}" must be a string`);
      });
    }
  });

  // ── successCount validation ─────────────────────────────────────────

  describe('successCount validation', () => {
    it('accepts zero successCount', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'ok': { description: 'X', resolution: 'Y', successCount: 0 },
        },
      })).not.toThrow();
    });

    it('accepts positive successCount', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'ok': { description: 'X', resolution: 'Y', successCount: 42 },
        },
      })).not.toThrow();
    });

    it('rejects non-number successCount', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'bad': { description: 'X', resolution: 'Y', successCount: 'three' },
        },
      })).toThrow('"successCount" must be a number');
    });
  });

  // ── status enum validation ──────────────────────────────────────────

  describe('status validation', () => {
    it('accepts "confirmed" status', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'ok': { description: 'X', resolution: 'Y', status: 'confirmed' },
        },
      })).not.toThrow();
    });

    it('accepts "pending" status', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'ok': { description: 'X', resolution: 'Y', status: 'pending' },
        },
      })).not.toThrow();
    });

    it('accepts "expired" status', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'ok': { description: 'X', resolution: 'Y', status: 'expired' },
        },
      })).not.toThrow();
    });

    it('rejects invalid status string', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'bad': { description: 'X', resolution: 'Y', status: 'active' },
        },
      })).toThrow('"status" must be one of');
    });

    it('rejects non-string status', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'bad': { description: 'X', resolution: 'Y', status: true },
        },
      })).toThrow('"status" must be one of');
    });
  });

  // ── Error message quality ───────────────────────────────────────────

  describe('error message quality', () => {
    it('includes blocker key in error message', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'npm-login-expired': { description: 123, resolution: 'Fix' },
        },
      })).toThrow('commonBlockers["npm-login-expired"]');
    });

    it('includes job index in error message when provided', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: {
          'bad': { description: '', resolution: 'Fix' },
        },
      }, 5)).toThrow('Job[5]');
    });

    it('uses "Job" prefix without index', () => {
      expect(() => validateJob({
        ...validJob,
        commonBlockers: 'bad',
      })).toThrow('Job: "commonBlockers"');
    });
  });

  // ── Integration with loadJobs ───────────────────────────────────────

  describe('integration with loadJobs', () => {
    it('commonBlockers validation runs during loadJobs (entry skipped with logged error)', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const os = await import('node:os');
      const { vi } = await import('vitest');
      const { loadJobs } = await import('../../src/scheduler/JobLoader.js');

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-blocker-'));
      const filePath = path.join(tmpDir, 'jobs.json');
      fs.writeFileSync(filePath, JSON.stringify([{
        ...validJob,
        commonBlockers: { 'bad': { description: 123 } },
      }]));

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const jobs = loadJobs(filePath);
        expect(jobs).toHaveLength(0);
        expect(err).toHaveBeenCalledWith(expect.stringContaining('"description" is required'));
      } finally {
        warn.mockRestore();
        err.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ── validateCommonBlockers direct tests ─────────────────────────────

  describe('validateCommonBlockers (direct)', () => {
    it('is exported from JobLoader', () => {
      expect(typeof validateCommonBlockers).toBe('function');
    });

    it('validates as standalone function', () => {
      expect(() => validateCommonBlockers({ 'ok': { description: 'X', resolution: 'Y' } }, 'Test')).not.toThrow();
    });

    it('throws with prefix', () => {
      expect(() => validateCommonBlockers('bad', 'MyPrefix')).toThrow('MyPrefix: "commonBlockers"');
    });
  });
});
