/**
 * ProxyCoordinator — /build heartbeat tracking (BUILD-STALL-VISIBILITY-SPEC Fix 2).
 *
 * Validates record/has/clear semantics and the default 6-min suppression window.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProxyCoordinator } from '../../src/monitoring/ProxyCoordinator.js';

describe('ProxyCoordinator — /build heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-19T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hasRecentBuildHeartbeat returns false when no heartbeat recorded', () => {
    const c = new ProxyCoordinator();
    expect(c.hasRecentBuildHeartbeat(123)).toBe(false);
  });

  it('records and detects a fresh heartbeat within the default 6-min window', () => {
    const c = new ProxyCoordinator();
    c.recordBuildHeartbeat(42);
    expect(c.hasRecentBuildHeartbeat(42)).toBe(true);

    // Advance 5 min — still inside default 6-min window
    vi.advanceTimersByTime(5 * 60_000);
    expect(c.hasRecentBuildHeartbeat(42)).toBe(true);
  });

  it('default window is 6 minutes (5:59 inside, 6:01 outside)', () => {
    const c = new ProxyCoordinator();
    c.recordBuildHeartbeat(42);
    vi.advanceTimersByTime(5 * 60_000 + 59_000);
    expect(c.hasRecentBuildHeartbeat(42)).toBe(true);
    vi.advanceTimersByTime(2_000); // now 6:01
    expect(c.hasRecentBuildHeartbeat(42)).toBe(false);
  });

  it('honors a caller-supplied window override', () => {
    const c = new ProxyCoordinator();
    c.recordBuildHeartbeat(7);
    vi.advanceTimersByTime(60_000);
    expect(c.hasRecentBuildHeartbeat(7, 30_000)).toBe(false);
    expect(c.hasRecentBuildHeartbeat(7, 120_000)).toBe(true);
  });

  it('keys per topic — heartbeat for one topic does not satisfy another', () => {
    const c = new ProxyCoordinator();
    c.recordBuildHeartbeat(100);
    expect(c.hasRecentBuildHeartbeat(100)).toBe(true);
    expect(c.hasRecentBuildHeartbeat(200)).toBe(false);
  });

  it('clearBuildHeartbeat wipes the timestamp', () => {
    const c = new ProxyCoordinator();
    c.recordBuildHeartbeat(55);
    expect(c.hasRecentBuildHeartbeat(55)).toBe(true);
    c.clearBuildHeartbeat(55);
    expect(c.hasRecentBuildHeartbeat(55)).toBe(false);
  });

  it('does not interfere with the proxy mutex tracking', () => {
    const c = new ProxyCoordinator();
    c.recordBuildHeartbeat(1);
    expect(c.tryAcquire(1, 'presence-proxy')).toBe(true);
    expect(c.currentHolder(1)).toBe('presence-proxy');
    // Heartbeat still considered fresh after a mutex acquire
    expect(c.hasRecentBuildHeartbeat(1)).toBe(true);
  });

  it('accepts an explicit atMs override (for tests / replay)', () => {
    const c = new ProxyCoordinator();
    const past = Date.now() - 10 * 60_000; // 10 min ago
    c.recordBuildHeartbeat(9, past);
    expect(c.hasRecentBuildHeartbeat(9)).toBe(false);
  });
});
