/**
 * Unit tests for HomeostasisMonitor
 *
 * Tests the work-velocity awareness system:
 * commit tracking, time-based triggers, pause recording,
 * session reset, and self-tuning thresholds.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HomeostasisMonitor } from '../../src/monitoring/HomeostasisMonitor.js';

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'homeostasis-test-'));
}

describe('HomeostasisMonitor', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = createTempStateDir();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  describe('initialization', () => {
    it('starts with zero counters', () => {
      const monitor = new HomeostasisMonitor(stateDir);
      const check = monitor.check();
      expect(check.metrics.commitsSincePause).toBe(0);
      expect(check.metrics.totalCommits).toBe(0);
      expect(check.metrics.totalPauses).toBe(0);
      expect(check.pauseSuggested).toBe(false);
    });

    it('has default thresholds', () => {
      const monitor = new HomeostasisMonitor(stateDir);
      const check = monitor.check();
      expect(check.thresholds.commits).toBe(3);
      expect(check.thresholds.minutes).toBe(20);
    });
  });

  describe('commit tracking', () => {
    it('increments commit counter', () => {
      const monitor = new HomeostasisMonitor(stateDir);
      monitor.recordCommit();
      monitor.recordCommit();
      expect(monitor.check().metrics.commitsSincePause).toBe(2);
      expect(monitor.check().metrics.totalCommits).toBe(2);
    });

    it('suggests pause when commit threshold crossed', () => {
      const monitor = new HomeostasisMonitor(stateDir);
      monitor.recordCommit();
      monitor.recordCommit();
      expect(monitor.check().pauseSuggested).toBe(false);
      monitor.recordCommit();
      const check = monitor.check();
      expect(check.pauseSuggested).toBe(true);
      expect(check.exceededThresholds).toContain('commits');
      expect(check.suggestion).toContain('3 commits');
    });
  });

  describe('pause recording', () => {
    it('resets commit counter on pause', () => {
      const monitor = new HomeostasisMonitor(stateDir);
      monitor.recordCommit();
      monitor.recordCommit();
      monitor.recordCommit();
      expect(monitor.check().pauseSuggested).toBe(true);

      monitor.recordPause('reviewed scope');
      const check = monitor.check();
      expect(check.metrics.commitsSincePause).toBe(0);
      expect(check.pauseSuggested).toBe(false);
      expect(check.metrics.totalPauses).toBe(1);
      // Total commits should still be tracked
      expect(check.metrics.totalCommits).toBe(3);
    });

    it('records context in pause history', () => {
      const monitor = new HomeostasisMonitor(stateDir);
      monitor.recordCommit();
      monitor.recordPause('checked alignment with goals');

      const data = monitor.getData();
      expect(data.history).toHaveLength(1);
      expect(data.history[0].context).toBe('checked alignment with goals');
      expect(data.history[0].commitsSincePrevious).toBe(1);
    });
  });

  describe('session reset', () => {
    it('resets all session counters', () => {
      const monitor = new HomeostasisMonitor(stateDir);
      monitor.recordCommit();
      monitor.recordCommit();
      monitor.recordPause();

      monitor.resetSession();
      const check = monitor.check();
      expect(check.metrics.commitsSincePause).toBe(0);
      expect(check.metrics.totalCommits).toBe(0);
      expect(check.metrics.totalPauses).toBe(0);
    });

    it('preserves thresholds and history across reset', () => {
      const monitor = new HomeostasisMonitor(stateDir);
      monitor.updateThresholds({ commits: 5 });
      monitor.recordCommit();
      monitor.recordPause('test');

      monitor.resetSession();
      const data = monitor.getData();
      expect(data.thresholds.commits).toBe(5);
      expect(data.history).toHaveLength(1); // History preserved
    });
  });

  describe('threshold tuning', () => {
    it('allows updating commit threshold', () => {
      const monitor = new HomeostasisMonitor(stateDir);
      monitor.updateThresholds({ commits: 5 });
      expect(monitor.check().thresholds.commits).toBe(5);
    });

    it('allows updating minutes threshold', () => {
      const monitor = new HomeostasisMonitor(stateDir);
      monitor.updateThresholds({ minutes: 30 });
      expect(monitor.check().thresholds.minutes).toBe(30);
    });

    it('respects updated thresholds', () => {
      const monitor = new HomeostasisMonitor(stateDir);
      monitor.updateThresholds({ commits: 5 });
      monitor.recordCommit();
      monitor.recordCommit();
      monitor.recordCommit();
      // Would trigger at default (3) but not at 5
      expect(monitor.check().pauseSuggested).toBe(false);
    });
  });

  describe('persistence', () => {
    it('persists state across instances', () => {
      const monitor1 = new HomeostasisMonitor(stateDir);
      monitor1.recordCommit();
      monitor1.recordCommit();

      // New instance reads from disk
      const monitor2 = new HomeostasisMonitor(stateDir);
      expect(monitor2.check().metrics.commitsSincePause).toBe(2);
    });

    it('handles corrupted state file gracefully', () => {
      const stateSubDir = path.join(stateDir, 'state');
      fs.mkdirSync(stateSubDir, { recursive: true });
      fs.writeFileSync(path.join(stateSubDir, 'homeostasis.json'), 'not json');

      const monitor = new HomeostasisMonitor(stateDir);
      expect(monitor.check().metrics.commitsSincePause).toBe(0);
    });
  });

  describe('suggestion message', () => {
    it('includes meaningful guidance when pause suggested', () => {
      const monitor = new HomeostasisMonitor(stateDir);
      monitor.recordCommit();
      monitor.recordCommit();
      monitor.recordCommit();

      const check = monitor.check();
      expect(check.suggestion).toContain('What is this session teaching me?');
      expect(check.suggestion).toContain('scope alignment');
    });

    it('returns empty suggestion when no pause needed', () => {
      const monitor = new HomeostasisMonitor(stateDir);
      expect(monitor.check().suggestion).toBe('');
    });
  });
});
