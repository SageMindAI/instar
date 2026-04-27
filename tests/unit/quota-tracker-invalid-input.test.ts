/**
 * Tests for QuotaTracker invalid input handling.
 *
 * Covers: NaN/Infinity/negative/over-100 clamping in canRunJob,
 * updateState rejection of invalid data, and read cooldown behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { QuotaTracker } from '../../src/monitoring/QuotaTracker.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('QuotaTracker — invalid input handling', () => {
  let tmpDir: string;
  let quotaFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-invalid-'));
    quotaFile = path.join(tmpDir, 'quota-state.json');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeRawQuota(data: Record<string, unknown>) {
    fs.writeFileSync(quotaFile, JSON.stringify(data));
  }

  function createTracker() {
    return new QuotaTracker({
      quotaFile,
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    });
  }

  describe('canRunJob with non-numeric usagePercent', () => {
    it('fails open when usagePercent is NaN', () => {
      writeRawQuota({ usagePercent: NaN, lastUpdated: new Date().toISOString() });
      const tracker = createTracker();
      // NaN is not finite, so should fail open
      expect(tracker.canRunJob('low')).toBe(true);
      expect(tracker.canRunJob('critical')).toBe(true);
    });

    it('fails open when usagePercent is Infinity', () => {
      writeRawQuota({ usagePercent: Infinity, lastUpdated: new Date().toISOString() });
      const tracker = createTracker();
      expect(tracker.canRunJob('low')).toBe(true);
    });

    it('fails open when usagePercent is -Infinity', () => {
      writeRawQuota({ usagePercent: -Infinity, lastUpdated: new Date().toISOString() });
      const tracker = createTracker();
      expect(tracker.canRunJob('low')).toBe(true);
    });

    it('fails open when usagePercent is a string', () => {
      writeRawQuota({ usagePercent: '75', lastUpdated: new Date().toISOString() });
      const tracker = createTracker();
      // typeof '75' !== 'number', so fails open
      expect(tracker.canRunJob('low')).toBe(true);
    });

    it('fails open when usagePercent is null', () => {
      writeRawQuota({ usagePercent: null, lastUpdated: new Date().toISOString() });
      const tracker = createTracker();
      expect(tracker.canRunJob('low')).toBe(true);
    });
  });

  describe('canRunJob with out-of-range usagePercent (clamping)', () => {
    it('clamps negative values to 0 (everything runs)', () => {
      writeRawQuota({ usagePercent: -10, lastUpdated: new Date().toISOString() });
      const tracker = createTracker();
      // -10 clamped to 0, which is below all thresholds
      expect(tracker.canRunJob('low')).toBe(true);
      expect(tracker.canRunJob('critical')).toBe(true);
    });

    it('clamps values above 100 to 100 (nothing runs)', () => {
      writeRawQuota({ usagePercent: 150, lastUpdated: new Date().toISOString() });
      const tracker = createTracker();
      // 150 clamped to 100, which is above shutdown (95)
      expect(tracker.canRunJob('low')).toBe(false);
      expect(tracker.canRunJob('critical')).toBe(false);
    });
  });

  describe('updateState input validation', () => {
    it('rejects NaN usagePercent', () => {
      const tracker = createTracker();
      expect(() => tracker.updateState({
        usagePercent: NaN,
        lastUpdated: new Date().toISOString(),
      })).toThrow('Invalid usagePercent');
    });

    it('rejects Infinity usagePercent', () => {
      const tracker = createTracker();
      expect(() => tracker.updateState({
        usagePercent: Infinity,
        lastUpdated: new Date().toISOString(),
      })).toThrow('Invalid usagePercent');
    });

    it('rejects invalid lastUpdated date', () => {
      const tracker = createTracker();
      expect(() => tracker.updateState({
        usagePercent: 50,
        lastUpdated: 'not-a-date',
      })).toThrow('Invalid lastUpdated');
    });

    it('rejects empty lastUpdated', () => {
      const tracker = createTracker();
      expect(() => tracker.updateState({
        usagePercent: 50,
        lastUpdated: '',
      })).toThrow('Invalid lastUpdated');
    });

    it('accepts valid edge values', () => {
      const tracker = createTracker();
      // 0% is valid
      tracker.updateState({ usagePercent: 0, lastUpdated: new Date().toISOString() });
      expect(tracker.getState()?.usagePercent).toBe(0);
      // 100% is valid
      tracker.updateState({ usagePercent: 100, lastUpdated: new Date().toISOString() });
      expect(tracker.getState()?.usagePercent).toBe(100);
    });
  });

  describe('read cooldown', () => {
    it('uses cache within cooldown window', () => {
      writeRawQuota({ usagePercent: 42, lastUpdated: new Date().toISOString() });
      const tracker = createTracker();

      // First read hits disk
      const state1 = tracker.getState();
      expect(state1?.usagePercent).toBe(42);

      // Update file on disk
      writeRawQuota({ usagePercent: 99, lastUpdated: new Date().toISOString() });

      // Second read within 5s should return cached value (42, not 99)
      const state2 = tracker.getState();
      expect(state2?.usagePercent).toBe(42);
    });
  });
});
