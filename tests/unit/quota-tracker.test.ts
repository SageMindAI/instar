/**
 * Tests for QuotaTracker — load-shedding decisions based on quota state.
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

describe('QuotaTracker', () => {
  let tmpDir: string;
  let quotaFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-test-'));
    quotaFile = path.join(tmpDir, 'quota-state.json');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeQuota(usagePercent: number): void {
    const state: QuotaState = {
      usagePercent,
      lastUpdated: new Date().toISOString(),
    };
    fs.writeFileSync(quotaFile, JSON.stringify(state));
  }

  it('allows all jobs when usage is below normal threshold', () => {
    writeQuota(30);
    const tracker = new QuotaTracker({ quotaFile, thresholds });

    expect(tracker.canRunJob('low')).toBe(true);
    expect(tracker.canRunJob('medium')).toBe(true);
    expect(tracker.canRunJob('high')).toBe(true);
    expect(tracker.canRunJob('critical')).toBe(true);
  });

  it('blocks low-priority jobs above normal threshold', () => {
    writeQuota(55);
    const tracker = new QuotaTracker({ quotaFile, thresholds });

    expect(tracker.canRunJob('low')).toBe(false);
    expect(tracker.canRunJob('medium')).toBe(true);
    expect(tracker.canRunJob('high')).toBe(true);
    expect(tracker.canRunJob('critical')).toBe(true);
  });

  it('allows only high+ above elevated threshold', () => {
    writeQuota(75);
    const tracker = new QuotaTracker({ quotaFile, thresholds });

    expect(tracker.canRunJob('low')).toBe(false);
    expect(tracker.canRunJob('medium')).toBe(false);
    expect(tracker.canRunJob('high')).toBe(true);
    expect(tracker.canRunJob('critical')).toBe(true);
  });

  it('allows only critical above critical threshold', () => {
    writeQuota(90);
    const tracker = new QuotaTracker({ quotaFile, thresholds });

    expect(tracker.canRunJob('low')).toBe(false);
    expect(tracker.canRunJob('medium')).toBe(false);
    expect(tracker.canRunJob('high')).toBe(false);
    expect(tracker.canRunJob('critical')).toBe(true);
  });

  it('blocks all jobs above shutdown threshold', () => {
    writeQuota(96);
    const tracker = new QuotaTracker({ quotaFile, thresholds });

    expect(tracker.canRunJob('low')).toBe(false);
    expect(tracker.canRunJob('medium')).toBe(false);
    expect(tracker.canRunJob('high')).toBe(false);
    expect(tracker.canRunJob('critical')).toBe(false);
  });

  it('fails open when no quota file exists', () => {
    const tracker = new QuotaTracker({ quotaFile: '/nonexistent/quota.json', thresholds });

    expect(tracker.canRunJob('low')).toBe(true);
    expect(tracker.canRunJob('critical')).toBe(true);
  });

  it('fails open when quota file is corrupted', () => {
    fs.writeFileSync(quotaFile, 'not-json');
    const tracker = new QuotaTracker({ quotaFile, thresholds });

    expect(tracker.canRunJob('low')).toBe(true);
  });

  it('getState returns parsed quota data', () => {
    writeQuota(42);
    const tracker = new QuotaTracker({ quotaFile, thresholds });

    const state = tracker.getState();
    expect(state).not.toBeNull();
    expect(state!.usagePercent).toBe(42);
  });

  it('updateState writes and caches state', () => {
    const tracker = new QuotaTracker({ quotaFile, thresholds });

    const state: QuotaState = {
      usagePercent: 65,
      lastUpdated: new Date().toISOString(),
    };
    tracker.updateState(state);

    // Verify written
    const read = JSON.parse(fs.readFileSync(quotaFile, 'utf-8'));
    expect(read.usagePercent).toBe(65);

    // Verify cached
    expect(tracker.getState()?.usagePercent).toBe(65);
  });

  it('getRecommendation returns appropriate labels', () => {
    const tracker = new QuotaTracker({ quotaFile, thresholds });

    writeQuota(30);
    expect(tracker.getRecommendation()).toBe('normal');

    // Force cache refresh by creating a new tracker
    writeQuota(55);
    const t2 = new QuotaTracker({ quotaFile, thresholds });
    expect(t2.getRecommendation()).toBe('reduce');

    writeQuota(90);
    const t3 = new QuotaTracker({ quotaFile, thresholds });
    expect(t3.getRecommendation()).toBe('critical');

    writeQuota(96);
    const t4 = new QuotaTracker({ quotaFile, thresholds });
    expect(t4.getRecommendation()).toBe('stop');
  });

  it('treats stale data as unknown (no recommendation)', () => {
    const staleState: QuotaState = {
      usagePercent: 90,
      lastUpdated: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour ago
    };
    fs.writeFileSync(quotaFile, JSON.stringify(staleState));

    const tracker = new QuotaTracker({
      quotaFile,
      thresholds,
      maxStalenessMs: 30 * 60 * 1000, // 30 min
    });

    const state = tracker.getState();
    // Stale data now returns null (fail-open behavior)
    expect(state).toBeNull();
  });
});
