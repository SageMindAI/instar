/**
 * Tests for QuotaTracker boundary values.
 *
 * Verifies exact threshold behavior — usage at boundary values
 * should be handled correctly by >= comparisons.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { QuotaTracker } from '../../src/monitoring/QuotaTracker.js';
import type { QuotaState, JobSchedulerConfig } from '../../src/core/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const thresholds: JobSchedulerConfig['quotaThresholds'] = {
  normal: 50,
  elevated: 70,
  critical: 85,
  shutdown: 95,
};

describe('QuotaTracker — boundary values', () => {
  let tmpDir: string;
  let quotaFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-boundary-'));
    quotaFile = path.join(tmpDir, 'quota-state.json');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTracker(usagePercent: number): QuotaTracker {
    const state: QuotaState = {
      usagePercent,
      lastUpdated: new Date().toISOString(),
    };
    fs.writeFileSync(quotaFile, JSON.stringify(state));
    return new QuotaTracker({ quotaFile, thresholds });
  }

  it('at exactly normal threshold (50%), blocks low jobs', () => {
    const tracker = createTracker(50);

    expect(tracker.canRunJob('low')).toBe(false);
    expect(tracker.canRunJob('medium')).toBe(true);
    expect(tracker.canRunJob('high')).toBe(true);
    expect(tracker.canRunJob('critical')).toBe(true);
  });

  it('at 1 below normal (49%), allows all jobs', () => {
    const tracker = createTracker(49);

    expect(tracker.canRunJob('low')).toBe(true);
    expect(tracker.canRunJob('medium')).toBe(true);
    expect(tracker.canRunJob('high')).toBe(true);
    expect(tracker.canRunJob('critical')).toBe(true);
  });

  it('at exactly elevated threshold (70%), blocks low+medium jobs', () => {
    const tracker = createTracker(70);

    expect(tracker.canRunJob('low')).toBe(false);
    expect(tracker.canRunJob('medium')).toBe(false);
    expect(tracker.canRunJob('high')).toBe(true);
    expect(tracker.canRunJob('critical')).toBe(true);
  });

  it('at exactly critical threshold (85%), allows only critical', () => {
    const tracker = createTracker(85);

    expect(tracker.canRunJob('low')).toBe(false);
    expect(tracker.canRunJob('medium')).toBe(false);
    expect(tracker.canRunJob('high')).toBe(false);
    expect(tracker.canRunJob('critical')).toBe(true);
  });

  it('at exactly shutdown threshold (95%), blocks everything', () => {
    const tracker = createTracker(95);

    expect(tracker.canRunJob('low')).toBe(false);
    expect(tracker.canRunJob('medium')).toBe(false);
    expect(tracker.canRunJob('high')).toBe(false);
    expect(tracker.canRunJob('critical')).toBe(false);
  });

  it('at 0% usage, allows everything', () => {
    const tracker = createTracker(0);

    expect(tracker.canRunJob('low')).toBe(true);
    expect(tracker.canRunJob('critical')).toBe(true);
  });

  it('at 100% usage, blocks everything', () => {
    const tracker = createTracker(100);

    expect(tracker.canRunJob('low')).toBe(false);
    expect(tracker.canRunJob('critical')).toBe(false);
  });

  it('getRecommendation at boundaries', () => {
    expect(createTracker(0).getRecommendation()).toBe('normal');
    expect(createTracker(49).getRecommendation()).toBe('normal');
    expect(createTracker(50).getRecommendation()).toBe('reduce');
    expect(createTracker(70).getRecommendation()).toBe('reduce');
    expect(createTracker(85).getRecommendation()).toBe('critical');
    expect(createTracker(95).getRecommendation()).toBe('stop');
    expect(createTracker(100).getRecommendation()).toBe('stop');
  });
});
