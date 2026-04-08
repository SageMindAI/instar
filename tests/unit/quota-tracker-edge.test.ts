/**
 * Edge case tests for QuotaTracker.
 *
 * Covers: staleness detection, threshold boundaries,
 * cache cooldown, file corruption, missing file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { QuotaTracker } from '../../src/monitoring/QuotaTracker.js';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import fs from 'node:fs';
import path from 'node:path';

describe('QuotaTracker edge cases', () => {
  let project: TempProject;
  let quotaFile: string;

  beforeEach(() => {
    project = createTempProject();
    quotaFile = path.join(project.stateDir, 'quota-state.json');
  });

  afterEach(() => {
    project.cleanup();
  });

  function createTracker(overrides?: Partial<Parameters<typeof QuotaTracker['prototype']['canRunJob']>>) {
    return new QuotaTracker({
      quotaFile,
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      maxStalenessMs: 30 * 60 * 1000,
    });
  }

  function writeQuotaState(usagePercent: number, minutesAgo: number = 0) {
    const lastUpdated = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
    fs.writeFileSync(quotaFile, JSON.stringify({
      usagePercent,
      lastUpdated,
      recommendation: usagePercent >= 95 ? 'stop' : usagePercent >= 85 ? 'critical' : usagePercent >= 70 ? 'reduce' : 'normal',
    }));
  }

  describe('missing file', () => {
    it('returns null when file does not exist', () => {
      const tracker = createTracker();
      expect(tracker.getState()).toBeNull();
    });

    it('allows all jobs when file does not exist (fail-open)', () => {
      const tracker = createTracker();
      expect(tracker.canRunJob('low')).toBe(true);
      expect(tracker.canRunJob('critical')).toBe(true);
    });
  });

  describe('corrupted file', () => {
    it('returns null for corrupted JSON', () => {
      fs.writeFileSync(quotaFile, 'not valid json {{{');
      const tracker = createTracker();
      expect(tracker.getState()).toBeNull();
    });

    it('allows all jobs for corrupted file (fail-open)', () => {
      fs.writeFileSync(quotaFile, '');
      const tracker = createTracker();
      expect(tracker.canRunJob('low')).toBe(true);
    });
  });

  describe('staleness detection', () => {
    it('clears recommendation for stale data', () => {
      // Write data that's 60 minutes old (stale beyond 30min threshold)
      writeQuotaState(60, 60);
      const tracker = createTracker();
      const state = tracker.getState();
      // Stale data now returns null (fail-open behavior)
      expect(state).toBeNull();
    });

    it('preserves recommendation for fresh data', () => {
      writeQuotaState(60, 1); // 1 minute ago
      const tracker = createTracker();
      const state = tracker.getState();
      expect(state).not.toBeNull();
      expect(state!.recommendation).toBe('normal');
    });
  });

  describe('threshold boundaries', () => {
    it('allows all at 49%', () => {
      writeQuotaState(49);
      const tracker = createTracker();
      expect(tracker.canRunJob('low')).toBe(true);
      expect(tracker.canRunJob('medium')).toBe(true);
      expect(tracker.canRunJob('high')).toBe(true);
      expect(tracker.canRunJob('critical')).toBe(true);
    });

    it('blocks low at exactly 50% (normal threshold)', () => {
      writeQuotaState(50);
      const tracker = createTracker();
      expect(tracker.canRunJob('low')).toBe(false);
      expect(tracker.canRunJob('medium')).toBe(true);
      expect(tracker.canRunJob('high')).toBe(true);
      expect(tracker.canRunJob('critical')).toBe(true);
    });

    it('blocks low+medium at 70% (elevated threshold)', () => {
      writeQuotaState(70);
      const tracker = createTracker();
      expect(tracker.canRunJob('low')).toBe(false);
      expect(tracker.canRunJob('medium')).toBe(false);
      expect(tracker.canRunJob('high')).toBe(true);
      expect(tracker.canRunJob('critical')).toBe(true);
    });

    it('only critical at 85%', () => {
      writeQuotaState(85);
      const tracker = createTracker();
      expect(tracker.canRunJob('low')).toBe(false);
      expect(tracker.canRunJob('medium')).toBe(false);
      expect(tracker.canRunJob('high')).toBe(false);
      expect(tracker.canRunJob('critical')).toBe(true);
    });

    it('nothing at 95% (shutdown)', () => {
      writeQuotaState(95);
      const tracker = createTracker();
      expect(tracker.canRunJob('low')).toBe(false);
      expect(tracker.canRunJob('medium')).toBe(false);
      expect(tracker.canRunJob('high')).toBe(false);
      expect(tracker.canRunJob('critical')).toBe(false);
    });

    it('nothing at 100%', () => {
      writeQuotaState(100);
      const tracker = createTracker();
      expect(tracker.canRunJob('critical')).toBe(false);
    });
  });

  describe('recommendations', () => {
    it('returns normal below threshold', () => {
      writeQuotaState(30);
      const tracker = createTracker();
      expect(tracker.getRecommendation()).toBe('normal');
    });

    it('returns reduce at elevated', () => {
      writeQuotaState(75);
      const tracker = createTracker();
      expect(tracker.getRecommendation()).toBe('reduce');
    });

    it('returns critical at critical threshold', () => {
      writeQuotaState(90);
      const tracker = createTracker();
      expect(tracker.getRecommendation()).toBe('critical');
    });

    it('returns stop at shutdown', () => {
      writeQuotaState(96);
      const tracker = createTracker();
      expect(tracker.getRecommendation()).toBe('stop');
    });

    it('returns normal when no data', () => {
      const tracker = createTracker();
      expect(tracker.getRecommendation()).toBe('normal');
    });
  });

  describe('updateState', () => {
    it('writes and immediately reads state', () => {
      const tracker = createTracker();
      tracker.updateState({
        usagePercent: 42,
        lastUpdated: new Date().toISOString(),
      });

      const state = tracker.getState();
      expect(state).not.toBeNull();
      expect(state!.usagePercent).toBe(42);
    });

    it('creates parent directories', () => {
      const deepPath = path.join(project.stateDir, 'deep', 'nested', 'quota.json');
      const tracker = new QuotaTracker({
        quotaFile: deepPath,
        thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      });
      tracker.updateState({
        usagePercent: 10,
        lastUpdated: new Date().toISOString(),
      });
      expect(fs.existsSync(deepPath)).toBe(true);
    });
  });
});
