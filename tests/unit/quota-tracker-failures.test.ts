/**
 * Failure-path tests for QuotaTracker.
 *
 * Focuses on scenarios that existing test suites do NOT cover:
 * - updateState file write failures (permission denied, temp cleanup)
 * - fetchRemoteQuota failure modes (timeout, non-200, invalid JSON)
 * - fiveHourPercent rate-limit boundary values (79, 80, 94, 95, 100)
 * - Concurrent getState calls using cache instead of hammering disk
 * - Corrupted file returning last-known-good cached state
 * - usagePercent as undefined specifically
 *
 * See also: quota-tracker.test.ts, quota-tracker-edge.test.ts,
 * quota-tracker-invalid-input.test.ts, quota-tracker-warnings.test.ts,
 * quota-boundary.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QuotaTracker } from '../../src/monitoring/QuotaTracker.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import type { QuotaState, JobSchedulerConfig } from '../../src/core/types.js';

const thresholds: JobSchedulerConfig['quotaThresholds'] = {
  normal: 50,
  elevated: 70,
  critical: 85,
  shutdown: 95,
};

describe('QuotaTracker — failure paths', () => {
  let tmpDir: string;
  let quotaFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-fail-'));
    quotaFile = path.join(tmpDir, 'quota-state.json');
    DegradationReporter.resetForTesting();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createTracker(opts?: Partial<{ maxStalenessMs: number }>) {
    return new QuotaTracker({
      quotaFile,
      thresholds,
      ...opts,
    });
  }

  function writeRawQuota(data: Record<string, unknown>) {
    fs.writeFileSync(quotaFile, JSON.stringify(data));
  }

  function writeValidQuota(usagePercent: number, extra?: Record<string, unknown>) {
    fs.writeFileSync(quotaFile, JSON.stringify({
      usagePercent,
      lastUpdated: new Date().toISOString(),
      ...extra,
    }));
  }

  // ── 1. Corrupted file returns last-known-good cached state ──────────

  describe('corrupted file with prior cache', () => {
    it('returns cached state when file becomes corrupted after a good read', () => {
      // First: write valid data and read it to populate cache
      writeValidQuota(42);
      const tracker = createTracker();
      const good = tracker.getState();
      expect(good?.usagePercent).toBe(42);

      // Corrupt the file
      fs.writeFileSync(quotaFile, '<<<not json>>>');

      // Force cache expiry by reaching into private state
      // The readCooldownMs is 5000, so we manipulate lastRead
      (tracker as any).lastRead = 0;

      // Should return the cached state (42), not null
      const state = tracker.getState();
      expect(state).not.toBeNull();
      expect(state!.usagePercent).toBe(42);
    });

    it('returns null when file is corrupted and no prior cache exists', () => {
      // Write corrupt data with no prior good read
      fs.writeFileSync(quotaFile, '{{{broken');
      const tracker = createTracker();
      const state = tracker.getState();
      // cachedState is null, so catch block returns null
      expect(state).toBeNull();
    });
  });

  // ── 2. usagePercent as undefined specifically ───────────────────────

  describe('usagePercent is undefined', () => {
    it('fails open when usagePercent is undefined in file', () => {
      writeRawQuota({ lastUpdated: new Date().toISOString() }); // no usagePercent key
      const tracker = createTracker();
      // typeof undefined !== 'number', so shouldSpawnSession returns fail-open
      expect(tracker.canRunJob('low')).toBe(true);
      expect(tracker.canRunJob('critical')).toBe(true);
    });

    it('shouldSpawnSession explains the fail-open reason for undefined usage', () => {
      writeRawQuota({ lastUpdated: new Date().toISOString() });
      const tracker = createTracker();
      const result = tracker.shouldSpawnSession('low');
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain('Invalid');
    });
  });

  // ── 3. updateState with invalid data throws, does not write ─────────

  describe('updateState rejects invalid data without writing', () => {
    it('throws on undefined usagePercent and does not create file', () => {
      const tracker = createTracker();
      expect(() => tracker.updateState({
        usagePercent: undefined as any,
        lastUpdated: new Date().toISOString(),
      })).toThrow('Invalid usagePercent');
      expect(fs.existsSync(quotaFile)).toBe(false);
    });

    it('throws on string usagePercent', () => {
      const tracker = createTracker();
      expect(() => tracker.updateState({
        usagePercent: '50' as any,
        lastUpdated: new Date().toISOString(),
      })).toThrow('Invalid usagePercent');
    });

    it('throws on null lastUpdated', () => {
      const tracker = createTracker();
      expect(() => tracker.updateState({
        usagePercent: 50,
        lastUpdated: null as any,
      })).toThrow('Invalid lastUpdated');
    });

    it('does not corrupt existing file when validation fails', () => {
      const tracker = createTracker();
      // Write valid state first
      tracker.updateState({
        usagePercent: 30,
        lastUpdated: new Date().toISOString(),
      });
      const before = fs.readFileSync(quotaFile, 'utf-8');

      // Attempt invalid update
      expect(() => tracker.updateState({
        usagePercent: NaN,
        lastUpdated: new Date().toISOString(),
      })).toThrow();

      // File should be unchanged
      const after = fs.readFileSync(quotaFile, 'utf-8');
      expect(after).toBe(before);
    });
  });

  // ── 4. updateState file write failure cleans up temp file ───────────

  describe('updateState file write failure', () => {
    it('cleans up temp file when writeFileSync fails', () => {
      const tracker = createTracker();

      // Mock writeFileSync to fail (simulating permission denied)
      const originalWriteFileSync = fs.writeFileSync;
      let tmpFilePath: string | null = null;
      vi.spyOn(fs, 'writeFileSync').mockImplementation((filePath: any, ...args: any[]) => {
        // Let mkdirSync work, but fail on .tmp file writes
        if (typeof filePath === 'string' && filePath.endsWith('.tmp')) {
          tmpFilePath = filePath;
          throw new Error('EACCES: permission denied');
        }
        return originalWriteFileSync(filePath, ...args);
      });

      expect(() => tracker.updateState({
        usagePercent: 50,
        lastUpdated: new Date().toISOString(),
      })).toThrow('EACCES');

      // The temp file should not remain on disk
      if (tmpFilePath) {
        expect(fs.existsSync(tmpFilePath)).toBe(false);
      }
    });

    it('cleans up temp file when renameSync fails', () => {
      const tracker = createTracker();

      const originalWriteFileSync = fs.writeFileSync;
      const originalRenameSync = fs.renameSync;
      let tmpFilePath: string | null = null;

      vi.spyOn(fs, 'writeFileSync').mockImplementation((filePath: any, ...args: any[]) => {
        if (typeof filePath === 'string' && filePath.endsWith('.tmp')) {
          tmpFilePath = filePath;
        }
        return originalWriteFileSync(filePath, ...args);
      });

      vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw new Error('EXDEV: cross-device link not permitted');
      });

      expect(() => tracker.updateState({
        usagePercent: 50,
        lastUpdated: new Date().toISOString(),
      })).toThrow('EXDEV');

      // Temp file should be cleaned up
      if (tmpFilePath) {
        expect(fs.existsSync(tmpFilePath)).toBe(false);
      }
    });
  });

  // ── 5. Stale data clears recommendation (with custom maxStalenessMs) ─

  describe('stale data with custom staleness window', () => {
    it('clears recommendation when data exceeds custom maxStalenessMs', () => {
      // Write data 10 minutes old with a 5-minute staleness window
      const state = {
        usagePercent: 80,
        lastUpdated: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        recommendation: 'critical' as const,
      };
      fs.writeFileSync(quotaFile, JSON.stringify(state));

      const tracker = createTracker({ maxStalenessMs: 5 * 60 * 1000 });
      const result = tracker.getState();
      // Stale data now returns null (fail-open behavior)
      expect(result).toBeNull();
    });

    it('preserves recommendation within custom staleness window', () => {
      const state = {
        usagePercent: 80,
        lastUpdated: new Date(Date.now() - 2 * 60 * 1000).toISOString(), // 2 min old
        recommendation: 'critical' as const,
      };
      fs.writeFileSync(quotaFile, JSON.stringify(state));

      const tracker = createTracker({ maxStalenessMs: 5 * 60 * 1000 });
      const result = tracker.getState();
      expect(result!.recommendation).toBe('critical');
    });
  });

  // ── 6. fetchRemoteQuota — network timeout ───────────────────────────

  describe('fetchRemoteQuota network timeout', () => {
    it('returns null on timeout (fail-open)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tracker = createTracker();

      // Mock fetch to simulate a timeout via AbortError
      const mockFetch = vi.fn().mockImplementation(() => {
        return new Promise((_resolve, reject) => {
          setTimeout(() => {
            const err = new DOMException('The operation was aborted', 'AbortError');
            reject(err);
          }, 10);
        });
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await tracker.fetchRemoteQuota(
        'https://example.com/api/quota',
        'test-key',
        50, // very short timeout
      );
      expect(result).toBeNull();

      vi.unstubAllGlobals();
    });

    it('reports degradation on timeout', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tracker = createTracker();
      const reporter = DegradationReporter.getInstance();
      const reportSpy = vi.spyOn(reporter, 'report');

      const mockFetch = vi.fn().mockRejectedValue(
        new DOMException('The operation was aborted', 'AbortError')
      );
      vi.stubGlobal('fetch', mockFetch);

      await tracker.fetchRemoteQuota('https://example.com/api/quota', 'test-key', 50);

      expect(reportSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          feature: 'QuotaTracker.remoteCheck',
        })
      );

      vi.unstubAllGlobals();
    });
  });

  // ── 7. fetchRemoteQuota — non-200 response ─────────────────────────

  describe('fetchRemoteQuota non-200 response', () => {
    it('returns null on 500 error', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tracker = createTracker();

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await tracker.fetchRemoteQuota(
        'https://example.com/api/quota',
        'test-key',
      );
      expect(result).toBeNull();

      vi.unstubAllGlobals();
    });

    it('returns null on 401 unauthorized', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tracker = createTracker();

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await tracker.fetchRemoteQuota(
        'https://example.com/api/quota',
        'bad-key',
      );
      expect(result).toBeNull();

      vi.unstubAllGlobals();
    });

    it('returns null on 404 not found', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tracker = createTracker();

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await tracker.fetchRemoteQuota(
        'https://example.com/api/quota',
        'test-key',
      );
      expect(result).toBeNull();

      vi.unstubAllGlobals();
    });
  });

  // ── 8. fetchRemoteQuota — invalid JSON response ─────────────────────

  describe('fetchRemoteQuota invalid JSON response', () => {
    it('returns null when response body is not valid JSON', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tracker = createTracker();

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await tracker.fetchRemoteQuota(
        'https://example.com/api/quota',
        'test-key',
      );
      expect(result).toBeNull();

      vi.unstubAllGlobals();
    });

    it('reports degradation on invalid JSON', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tracker = createTracker();
      const reporter = DegradationReporter.getInstance();
      const reportSpy = vi.spyOn(reporter, 'report');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token')),
      });
      vi.stubGlobal('fetch', mockFetch);

      await tracker.fetchRemoteQuota('https://example.com/api/quota', 'test-key');

      expect(reportSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          feature: 'QuotaTracker.remoteCheck',
          reason: expect.stringContaining('Unexpected token'),
        })
      );

      vi.unstubAllGlobals();
    });
  });

  // ── 9. fetchRemoteQuota — successful response updates local state ───

  describe('fetchRemoteQuota updates local state on blocked response', () => {
    it('updates cachedState when remote says canProceed=false', async () => {
      // Write initial valid quota so getState() has a file to read
      writeValidQuota(30);
      const tracker = createTracker();
      // Prime the cache with a disk read
      tracker.getState();

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          canProceed: false,
          weeklyPercent: 92,
          fiveHourPercent: 88,
          blockReason: 'Rate limited',
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await tracker.fetchRemoteQuota(
        'https://example.com/api/quota',
        'test-key',
      );
      expect(result).not.toBeNull();
      expect(result!.canProceed).toBe(false);

      // fetchRemoteQuota sets cachedState directly.
      // getState() will return the cache because we're within cooldown (5s).
      const state = tracker.getState();
      expect(state).not.toBeNull();
      expect(state!.usagePercent).toBe(92);
      expect(state!.fiveHourPercent).toBe(88);

      vi.unstubAllGlobals();
    });

    it('sets cachedState but getState fails-open when no file exists and cooldown expired', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      // No file on disk, no prior reads
      const tracker = createTracker();

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          canProceed: false,
          weeklyPercent: 92,
          blockReason: 'Blocked',
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await tracker.fetchRemoteQuota('https://example.com/api/quota', 'test-key');

      // fetchRemoteQuota sets cachedState, but does NOT set lastRead.
      // getState() checks cooldown first: cachedState exists but lastRead=0,
      // so (now - 0) > 5000 => misses cache => falls to disk read => no file => returns null.
      // This is a known gap: fetchRemoteQuota's cache update is only visible
      // if there's already been a disk read within cooldown.
      const state = tracker.getState();
      expect(state).toBeNull();
      // But the tracker still allows jobs (fail-open)
      expect(tracker.canRunJob('critical')).toBe(true);

      vi.unstubAllGlobals();
    });

    it('does not update local state when remote says canProceed=true', async () => {
      const tracker = createTracker();

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          canProceed: true,
          weeklyPercent: 30,
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await tracker.fetchRemoteQuota('https://example.com/api/quota', 'test-key');

      // Local cache should NOT be updated (canProceed is true)
      const state = tracker.getState();
      expect(state).toBeNull(); // No file exists, no cache set

      vi.unstubAllGlobals();
    });
  });

  // ── 10. Concurrent getState calls use cache ─────────────────────────

  describe('concurrent getState calls use cache', () => {
    it('does not re-read file within cooldown window', () => {
      writeValidQuota(55);
      const tracker = createTracker();

      const readSpy = vi.spyOn(fs, 'readFileSync');

      // First call reads from disk
      tracker.getState();
      const readCount1 = readSpy.mock.calls.length;
      expect(readCount1).toBeGreaterThan(0);

      // Rapid subsequent calls should NOT hit disk again
      tracker.getState();
      tracker.getState();
      tracker.getState();
      tracker.getState();

      // readFileSync call count should not increase (cache serves all)
      expect(readSpy.mock.calls.length).toBe(readCount1);
    });

    it('re-reads from disk after cooldown expires', () => {
      writeValidQuota(55);
      const tracker = createTracker();

      const readSpy = vi.spyOn(fs, 'readFileSync');

      // First read
      tracker.getState();
      const readCount1 = readSpy.mock.calls.length;

      // Expire the cooldown by manipulating lastRead
      (tracker as any).lastRead = Date.now() - 10000; // 10s ago, past 5s cooldown

      // This should hit disk again
      tracker.getState();
      expect(readSpy.mock.calls.length).toBeGreaterThan(readCount1);
    });
  });

  // ── 11. fiveHourPercent rate-limit boundary values ──────────────────

  describe('fiveHourPercent rate-limit boundaries', () => {
    function writeQuotaWithFiveHour(weekly: number, fiveHour: number) {
      fs.writeFileSync(quotaFile, JSON.stringify({
        usagePercent: weekly,
        fiveHourPercent: fiveHour,
        lastUpdated: new Date().toISOString(),
      }));
    }

    it('at fiveHourPercent=79, does not impose 5-hour rate limit', () => {
      writeQuotaWithFiveHour(30, 79); // weekly is low, 5hr just under 80
      const tracker = createTracker();
      // 5-hour at 79 is below 80 threshold, weekly at 30 is below all thresholds
      expect(tracker.canRunJob('low')).toBe(true);
      expect(tracker.canRunJob('medium')).toBe(true);
      expect(tracker.canRunJob('high')).toBe(true);
      expect(tracker.canRunJob('critical')).toBe(true);
    });

    it('at fiveHourPercent=80, blocks non-critical jobs', () => {
      writeQuotaWithFiveHour(30, 80); // weekly low, 5hr at 80
      const tracker = createTracker();
      expect(tracker.canRunJob('low')).toBe(false);
      expect(tracker.canRunJob('medium')).toBe(false);
      expect(tracker.canRunJob('high')).toBe(false);
      expect(tracker.canRunJob('critical')).toBe(true);
    });

    it('at fiveHourPercent=94, still allows critical jobs', () => {
      writeQuotaWithFiveHour(30, 94); // weekly low, 5hr just under 95
      const tracker = createTracker();
      expect(tracker.canRunJob('low')).toBe(false);
      expect(tracker.canRunJob('medium')).toBe(false);
      expect(tracker.canRunJob('high')).toBe(false);
      expect(tracker.canRunJob('critical')).toBe(true);
    });

    it('at fiveHourPercent=95, blocks ALL jobs including critical', () => {
      writeQuotaWithFiveHour(30, 95); // weekly low, 5hr at hard limit
      const tracker = createTracker();
      expect(tracker.canRunJob('low')).toBe(false);
      expect(tracker.canRunJob('medium')).toBe(false);
      expect(tracker.canRunJob('high')).toBe(false);
      expect(tracker.canRunJob('critical')).toBe(false);
    });

    it('at fiveHourPercent=100, blocks ALL jobs', () => {
      writeQuotaWithFiveHour(30, 100);
      const tracker = createTracker();
      expect(tracker.canRunJob('low')).toBe(false);
      expect(tracker.canRunJob('critical')).toBe(false);
    });

    it('fiveHourPercent overrides permissive weekly — 5hr=95 blocks even at weekly=10', () => {
      writeQuotaWithFiveHour(10, 95);
      const tracker = createTracker();
      expect(tracker.canRunJob('critical')).toBe(false);
    });

    it('shouldSpawnSession explains 5-hour rate limit reason', () => {
      writeQuotaWithFiveHour(30, 95);
      const tracker = createTracker();
      const result = tracker.shouldSpawnSession('high');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('5-hour rate limit');
      expect(result.reason).toContain('95%');
    });

    it('shouldSpawnSession without priority at fiveHour=80 allows (no priority to check)', () => {
      writeQuotaWithFiveHour(30, 80);
      const tracker = createTracker();
      // When priority is undefined: the 80% check requires priority && priority !== 'critical'
      // undefined is falsy, so the 80% gate does NOT block
      const result = tracker.shouldSpawnSession();
      expect(result.allowed).toBe(true);
    });

    it('getRecommendation returns stop at fiveHour=95', () => {
      writeQuotaWithFiveHour(30, 95);
      const tracker = createTracker();
      expect(tracker.getRecommendation()).toBe('stop');
    });

    it('getRecommendation returns critical at fiveHour=80', () => {
      writeQuotaWithFiveHour(30, 80);
      const tracker = createTracker();
      expect(tracker.getRecommendation()).toBe('critical');
    });

    it('non-finite fiveHourPercent is ignored (falls through to weekly check)', () => {
      writeRawQuota({
        usagePercent: 30,
        fiveHourPercent: NaN,
        lastUpdated: new Date().toISOString(),
      });
      const tracker = createTracker();
      // NaN is not finite, so 5-hour check is skipped. Weekly at 30 allows all.
      expect(tracker.canRunJob('low')).toBe(true);
    });

    it('string fiveHourPercent is ignored (typeof check)', () => {
      writeRawQuota({
        usagePercent: 30,
        fiveHourPercent: '95',
        lastUpdated: new Date().toISOString(),
      });
      const tracker = createTracker();
      // typeof '95' is 'string', not 'number', so 5-hour check is skipped
      expect(tracker.canRunJob('low')).toBe(true);
    });
  });

  // ── 12. fetchRemoteQuota sends correct request ──────────────────────

  describe('fetchRemoteQuota request format', () => {
    it('sends Bearer auth header and Accept: application/json', async () => {
      const tracker = createTracker();

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ canProceed: true, weeklyPercent: 20 }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await tracker.fetchRemoteQuota('https://example.com/api/quota', 'my-secret-key');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/api/quota',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer my-secret-key',
            'Accept': 'application/json',
          }),
        })
      );

      vi.unstubAllGlobals();
    });
  });

  // ── 13. fetchRemoteQuota generic network error ──────────────────────

  describe('fetchRemoteQuota generic network error', () => {
    it('returns null on ECONNREFUSED', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tracker = createTracker();

      const mockFetch = vi.fn().mockRejectedValue(
        new Error('connect ECONNREFUSED 127.0.0.1:443')
      );
      vi.stubGlobal('fetch', mockFetch);

      const result = await tracker.fetchRemoteQuota(
        'https://example.com/api/quota',
        'test-key',
      );
      expect(result).toBeNull();

      vi.unstubAllGlobals();
    });

    it('reports degradation with error message on network failure', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tracker = createTracker();
      const reporter = DegradationReporter.getInstance();
      const reportSpy = vi.spyOn(reporter, 'report');

      const mockFetch = vi.fn().mockRejectedValue(
        new Error('getaddrinfo ENOTFOUND example.com')
      );
      vi.stubGlobal('fetch', mockFetch);

      await tracker.fetchRemoteQuota('https://example.com/api/quota', 'test-key');

      expect(reportSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          feature: 'QuotaTracker.remoteCheck',
          reason: expect.stringContaining('ENOTFOUND'),
        })
      );

      vi.unstubAllGlobals();
    });
  });
});
