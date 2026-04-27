/**
 * Comprehensive tests for BlockerLearningLoop (PROP-232 Phase 3).
 *
 * Tests cover:
 * - Eager capture of blocker resolutions
 * - N-confirmation promotion (human=0, research-agent=2, agent=3)
 * - Reuse tracking and success counting
 * - Pruning: expiration, pending staleness, max entry limit
 * - Edge cases: missing jobs, duplicate capture, confirmed→pending protection
 * - Job file persistence
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BlockerLearningLoop, type BlockerResolution } from '../../src/core/BlockerLearningLoop.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let stateDir: string;
let jobsFile: string;

const baseJob = {
  slug: 'test-job',
  name: 'Test Job',
  description: 'A test job',
  schedule: '0 */4 * * *',
  priority: 'medium',
  model: 'sonnet',
  enabled: true,
  execute: { type: 'skill', value: 'scan' },
};

function setup(jobs: unknown[] = [baseJob]) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-learning-'));
  stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  jobsFile = path.join(tmpDir, 'jobs.json');
  fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));
}

function teardown() {
  // safe-git-allow: incremental-migration
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function makeResolution(overrides?: Partial<BlockerResolution>): BlockerResolution {
  return {
    jobSlug: 'test-job',
    blockerKey: 'npm-login',
    description: 'npm login token expired',
    resolution: 'Run npm login with SecretStore credentials',
    toolsUsed: ['bash', 'secret-store'],
    resolvedBy: 'agent',
    resolvedInSession: 'session-001',
    resolvedAt: new Date().toISOString(),
    ...overrides,
  };
}

function readJobs(): any[] {
  return JSON.parse(fs.readFileSync(jobsFile, 'utf-8'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BlockerLearningLoop', () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  // ── Capture ──────────────────────────────────────────────────────────

  describe('capture', () => {
    it('captures a resolution to the pending queue', () => {
      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      const key = loop.capture(makeResolution());

      expect(key).toBe('npm-login');

      const jobs = readJobs();
      const blocker = jobs[0].commonBlockers?.['npm-login'];
      expect(blocker).toBeDefined();
      expect(blocker.status).toBe('pending');
      expect(blocker.description).toBe('npm login token expired');
      expect(blocker.resolution).toContain('SecretStore');
      expect(blocker.toolsNeeded).toEqual(['bash', 'secret-store']);
      expect(blocker.successCount).toBe(0);
    });

    it('promotes immediately for human-resolved blockers', () => {
      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      loop.capture(makeResolution({ resolvedBy: 'human' }));

      const jobs = readJobs();
      const blocker = jobs[0].commonBlockers?.['npm-login'];
      expect(blocker.status).toBe('confirmed');
      expect(blocker.confirmedAt).toBeDefined();
      expect(blocker.successCount).toBe(1);
    });

    it('stores as pending for agent-resolved blockers', () => {
      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      loop.capture(makeResolution({ resolvedBy: 'agent' }));

      const jobs = readJobs();
      expect(jobs[0].commonBlockers?.['npm-login'].status).toBe('pending');
    });

    it('stores as pending for research-agent-resolved blockers', () => {
      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      loop.capture(makeResolution({ resolvedBy: 'research-agent' }));

      const jobs = readJobs();
      expect(jobs[0].commonBlockers?.['npm-login'].status).toBe('pending');
    });

    it('does not overwrite confirmed with pending on re-capture', () => {
      // First: human-confirmed
      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      loop.capture(makeResolution({ resolvedBy: 'human' }));

      // Second: agent re-discovers same blocker
      loop.capture(makeResolution({ resolvedBy: 'agent' }));

      const jobs = readJobs();
      const blocker = jobs[0].commonBlockers?.['npm-login'];
      expect(blocker.status).toBe('confirmed'); // Still confirmed
      expect(blocker.successCount).toBe(2); // Incremented
    });

    it('initializes commonBlockers if not present', () => {
      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      loop.capture(makeResolution());

      const jobs = readJobs();
      expect(jobs[0].commonBlockers).toBeDefined();
      expect(typeof jobs[0].commonBlockers).toBe('object');
    });

    it('throws for non-existent job', () => {
      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      expect(() => loop.capture(makeResolution({ jobSlug: 'nonexistent' }))).toThrow('not found');
    });

    it('stores credentials when provided', () => {
      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      loop.capture(makeResolution({ credentials: ['bitwarden', 'env-file'] }));

      const jobs = readJobs();
      expect(jobs[0].commonBlockers?.['npm-login'].credentials).toEqual(['bitwarden', 'env-file']);
    });

    it('stores addedFrom and addedAt', () => {
      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      const now = new Date().toISOString();
      loop.capture(makeResolution({ resolvedInSession: 'sess-xyz', resolvedAt: now }));

      const jobs = readJobs();
      const blocker = jobs[0].commonBlockers?.['npm-login'];
      expect(blocker.addedFrom).toBe('sess-xyz');
      expect(blocker.addedAt).toBe(now);
    });

    it('handles multiple different blockers for same job', () => {
      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      loop.capture(makeResolution({ blockerKey: 'npm-login' }));
      loop.capture(makeResolution({ blockerKey: 'git-push', description: 'Git push rejected' }));

      const jobs = readJobs();
      expect(Object.keys(jobs[0].commonBlockers)).toHaveLength(2);
      expect(jobs[0].commonBlockers?.['npm-login']).toBeDefined();
      expect(jobs[0].commonBlockers?.['git-push']).toBeDefined();
    });
  });

  // ── Reuse tracking ──────────────────────────────────────────────────

  describe('recordReuse', () => {
    it('increments successCount on reuse', () => {
      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      loop.capture(makeResolution());

      const result = loop.recordReuse('test-job', 'npm-login');
      expect(result).not.toBeNull();
      expect(result!.successCount).toBe(1);
      expect(result!.promoted).toBe(false);
    });

    it('promotes agent-resolved after 3 reuses', () => {
      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      loop.capture(makeResolution({ resolvedBy: 'agent' }));

      loop.recordReuse('test-job', 'npm-login');
      loop.recordReuse('test-job', 'npm-login');
      const result = loop.recordReuse('test-job', 'npm-login');

      expect(result!.promoted).toBe(true);
      expect(result!.successCount).toBe(3);

      const jobs = readJobs();
      expect(jobs[0].commonBlockers?.['npm-login'].status).toBe('confirmed');
      expect(jobs[0].commonBlockers?.['npm-login'].confirmedAt).toBeDefined();
    });

    it('promotes research-agent-resolved after 2 reuses', () => {
      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      loop.capture(makeResolution({ resolvedBy: 'research-agent' }));

      loop.recordReuse('test-job', 'npm-login');
      const result = loop.recordReuse('test-job', 'npm-login');

      expect(result!.promoted).toBe(true);
      expect(result!.successCount).toBe(2);
    });

    it('does not re-promote already confirmed blocker', () => {
      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      loop.capture(makeResolution({ resolvedBy: 'human' })); // Immediate confirm

      const result = loop.recordReuse('test-job', 'npm-login');
      expect(result!.promoted).toBe(false); // Already confirmed
      expect(result!.successCount).toBe(2); // Still tracks usage
    });

    it('returns null for non-existent blocker', () => {
      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      const result = loop.recordReuse('test-job', 'nonexistent');
      expect(result).toBeNull();
    });

    it('returns null for non-existent job', () => {
      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      const result = loop.recordReuse('nonexistent', 'npm-login');
      expect(result).toBeNull();
    });

    it('sets lastUsedAt on reuse', () => {
      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      loop.capture(makeResolution());
      loop.recordReuse('test-job', 'npm-login');

      const jobs = readJobs();
      expect(jobs[0].commonBlockers?.['npm-login'].lastUsedAt).toBeDefined();
    });
  });

  // ── Custom thresholds ──────────────────────────────────────────────

  describe('custom promotion thresholds', () => {
    it('uses custom threshold for agent', () => {
      const loop = new BlockerLearningLoop({
        stateDir,
        jobsFile,
        promotionThresholds: { agent: 5, 'research-agent': 3, human: 0 },
      });
      loop.capture(makeResolution({ resolvedBy: 'agent' }));

      // Need 5 reuses
      for (let i = 0; i < 4; i++) {
        const r = loop.recordReuse('test-job', 'npm-login');
        expect(r!.promoted).toBe(false);
      }
      const result = loop.recordReuse('test-job', 'npm-login');
      expect(result!.promoted).toBe(true);
    });
  });

  // ── Pruning ─────────────────────────────────────────────────────────

  describe('prune', () => {
    it('prunes entries with expired expiresAt', () => {
      setup([{
        ...baseJob,
        commonBlockers: {
          'expired-one': {
            description: 'Old blocker',
            resolution: 'Old fix',
            status: 'confirmed',
            expiresAt: new Date(Date.now() - 1000).toISOString(),
          },
        },
      }]);

      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      const pruned = loop.prune('test-job');

      expect(pruned).toBe(1);
      const jobs = readJobs();
      expect(jobs[0].commonBlockers?.['expired-one']).toBeUndefined();
    });

    it('marks stale confirmed entries as expired', () => {
      const staleDate = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
      setup([{
        ...baseJob,
        commonBlockers: {
          'stale-one': {
            description: 'Stale blocker',
            resolution: 'Stale fix',
            status: 'confirmed',
            lastUsedAt: staleDate,
          },
        },
      }]);

      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      const pruned = loop.prune('test-job');

      expect(pruned).toBe(1);
      const jobs = readJobs();
      expect(jobs[0].commonBlockers?.['stale-one'].status).toBe('expired');
    });

    it('deletes stale pending entries', () => {
      const staleDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      setup([{
        ...baseJob,
        commonBlockers: {
          'stale-pending': {
            description: 'Stale pending',
            resolution: 'Untested',
            status: 'pending',
            addedAt: staleDate,
          },
        },
      }]);

      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      const pruned = loop.prune('test-job');

      expect(pruned).toBe(1);
      const jobs = readJobs();
      expect(jobs[0].commonBlockers?.['stale-pending']).toBeUndefined();
    });

    it('enforces max entries by removing lowest-success', () => {
      const blockers: Record<string, unknown> = {};
      for (let i = 0; i < 22; i++) {
        blockers[`blocker-${i}`] = {
          description: `Blocker ${i}`,
          resolution: `Fix ${i}`,
          status: 'confirmed',
          successCount: i, // successCount matches index
          lastUsedAt: new Date().toISOString(),
        };
      }

      setup([{ ...baseJob, commonBlockers: blockers }]);
      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      const pruned = loop.prune('test-job');

      expect(pruned).toBe(2); // 22 - 20 = 2 removed
      const jobs = readJobs();
      const remaining = Object.keys(jobs[0].commonBlockers);
      expect(remaining).toHaveLength(20);

      // The lowest-success ones (0, 1) should be removed
      expect(jobs[0].commonBlockers?.['blocker-0']).toBeUndefined();
      expect(jobs[0].commonBlockers?.['blocker-1']).toBeUndefined();
      expect(jobs[0].commonBlockers?.['blocker-2']).toBeDefined();
    });

    it('returns 0 when nothing to prune', () => {
      setup([{
        ...baseJob,
        commonBlockers: {
          'fresh': {
            description: 'Fresh blocker',
            resolution: 'Fix',
            status: 'confirmed',
            lastUsedAt: new Date().toISOString(),
            successCount: 5,
          },
        },
      }]);

      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      expect(loop.prune('test-job')).toBe(0);
    });

    it('returns 0 for job with no commonBlockers', () => {
      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      expect(loop.prune('test-job')).toBe(0);
    });
  });

  // ── getBlockers ─────────────────────────────────────────────────────

  describe('getBlockers', () => {
    it('returns blockers for a job', () => {
      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      loop.capture(makeResolution());

      const blockers = loop.getBlockers('test-job');
      expect(blockers).not.toBeNull();
      expect(blockers?.['npm-login']).toBeDefined();
    });

    it('returns null for non-existent job', () => {
      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      expect(loop.getBlockers('nonexistent')).toBeNull();
    });

    it('returns null for job without blockers', () => {
      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      expect(loop.getBlockers('test-job')).toBeNull();
    });
  });

  // ── Multi-job isolation ───────────────────────────────────────────────

  describe('multi-job isolation', () => {
    it('captures to the correct job', () => {
      setup([
        { ...baseJob, slug: 'job-a' },
        { ...baseJob, slug: 'job-b' },
      ]);

      const loop = new BlockerLearningLoop({ stateDir, jobsFile });
      loop.capture(makeResolution({ jobSlug: 'job-a', blockerKey: 'blocker-a' }));
      loop.capture(makeResolution({ jobSlug: 'job-b', blockerKey: 'blocker-b' }));

      const a = loop.getBlockers('job-a');
      const b = loop.getBlockers('job-b');

      expect(a?.['blocker-a']).toBeDefined();
      expect(a?.['blocker-b']).toBeUndefined();
      expect(b?.['blocker-b']).toBeDefined();
      expect(b?.['blocker-a']).toBeUndefined();
    });
  });
});
