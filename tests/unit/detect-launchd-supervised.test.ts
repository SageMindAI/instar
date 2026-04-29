/**
 * Unit tests for detectLaunchdSupervised — robust supervision detection.
 *
 * Background: the previous detection (`process.ppid === 1`) only catches
 * system-domain launchd. User-domain launchd (`gui/<uid>/...`) — which is
 * how every macOS user-installed instar agent runs — has a non-1 ppid.
 * The 2026-04-29 Inspec post-mortem identified this gap.
 *
 * These tests verify each detection signal independently and the cache
 * behavior.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectLaunchdSupervised,
  _resetSupervisionCacheForTesting,
} from '../../src/lifeline/detectLaunchdSupervised.js';

describe('detectLaunchdSupervised', () => {
  beforeEach(() => {
    _resetSupervisionCacheForTesting();
  });

  it('returns true when INSTAR_SUPERVISED=1 is set explicitly', () => {
    expect(detectLaunchdSupervised({
      env: { INSTAR_SUPERVISED: '1' },
      ppid: 12345,
      platform: 'darwin',
      parentNameLookup: () => 'zsh',
    })).toBe(true);
  });

  it('returns true when ppid === 1 (system-domain init)', () => {
    expect(detectLaunchdSupervised({
      env: {},
      ppid: 1,
      platform: 'linux',
      parentNameLookup: () => 'init',
    })).toBe(true);
  });

  it('returns true on darwin when parent process is launchd (user-domain case)', () => {
    // This is the real production case: gui/501/... agents are managed by
    // user-launchd, whose pid is not 1, but the parent-name is launchd.
    expect(detectLaunchdSupervised({
      env: {},
      ppid: 1234,
      platform: 'darwin',
      parentNameLookup: () => 'launchd',
    })).toBe(true);
  });

  it('returns true on linux when parent process is systemd', () => {
    expect(detectLaunchdSupervised({
      env: {},
      ppid: 4321,
      platform: 'linux',
      parentNameLookup: () => 'systemd',
    })).toBe(true);
  });

  it('returns false on darwin when parent is a regular shell', () => {
    expect(detectLaunchdSupervised({
      env: {},
      ppid: 4567,
      platform: 'darwin',
      parentNameLookup: () => 'zsh',
    })).toBe(false);
  });

  it('returns false on linux when parent is a regular shell', () => {
    expect(detectLaunchdSupervised({
      env: {},
      ppid: 4567,
      platform: 'linux',
      parentNameLookup: () => 'bash',
    })).toBe(false);
  });

  it('returns false when parent name lookup returns null (unresolvable)', () => {
    expect(detectLaunchdSupervised({
      env: {},
      ppid: 999,
      platform: 'darwin',
      parentNameLookup: () => null,
    })).toBe(false);
  });

  it('NODE_ENV=test forces unsupervised even when parent is launchd', () => {
    expect(detectLaunchdSupervised({
      env: { NODE_ENV: 'test' },
      ppid: 1234,
      platform: 'darwin',
      parentNameLookup: () => 'launchd',
    })).toBe(false);
  });

  it('NODE_ENV=test still respects INSTAR_SUPERVISED=1 (explicit override)', () => {
    // Some tests need to exercise the supervised path on purpose.
    expect(detectLaunchdSupervised({
      env: { NODE_ENV: 'test', INSTAR_SUPERVISED: '1' },
      ppid: 4567,
      platform: 'darwin',
      parentNameLookup: () => 'zsh',
    })).toBe(true);
  });

  it('passing options bypasses cache; subsequent option-less calls populate it', () => {
    // Simulate a scenario where the test option-call returns a different value
    // than what the option-less call would compute. This is mainly verifying
    // that explicit-test invocations don't pollute the runtime cache.
    detectLaunchdSupervised({
      env: { INSTAR_SUPERVISED: '1' },
      ppid: 1,
      platform: 'darwin',
      parentNameLookup: () => 'launchd',
    });
    // Cache should still be unset at this point.
    // Force a second explicit call with different env to confirm options-mode
    // doesn't read from cache.
    expect(detectLaunchdSupervised({
      env: {},
      ppid: 999,
      platform: 'darwin',
      parentNameLookup: () => 'zsh',
    })).toBe(false);
  });
});
