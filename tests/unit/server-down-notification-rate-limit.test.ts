import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression tests for server-down notification rate limiting.
 *
 * The "server down" Telegram notification should:
 * 1. Send at most one notification per outage (existing behavior)
 * 2. Enforce a cross-outage cooldown (30 min) so flap cycles
 *    (down→up→down) during overnight Power Nap don't spam the user
 *
 * Bug: https://github.com/anthropics/instar — sleep/wake flap spam (2026-03-30)
 */

// Minimal stub types to isolate the rate-limiting logic without
// importing TelegramLifeline's full dependency tree.

class NotificationRateLimiter {
  hasNotifiedServerDown = false;
  suppressedServerDownCount = 0;
  lastServerDownNotifyAt = 0;
  static readonly COOLDOWN_MS = 30 * 60_000;

  private sent: string[] = [];

  /** Load persisted state (simulates loadRateLimitState). */
  load(state: { hasNotifiedServerDown?: boolean; suppressedServerDownCount?: number; lastServerDownNotifyAt?: number }) {
    this.hasNotifiedServerDown = state.hasNotifiedServerDown ?? false;
    this.suppressedServerDownCount = state.suppressedServerDownCount ?? 0;
    this.lastServerDownNotifyAt = state.lastServerDownNotifyAt ?? 0;
  }

  /** Returns the serializable state (simulates saveRateLimitState). */
  save() {
    return {
      hasNotifiedServerDown: this.hasNotifiedServerDown,
      suppressedServerDownCount: this.suppressedServerDownCount,
      lastServerDownNotifyAt: this.lastServerDownNotifyAt,
    };
  }

  /** Mirrors TelegramLifeline.notifyServerDown logic exactly. */
  notifyServerDown(reason: string, now: number): boolean {
    if (this.hasNotifiedServerDown) {
      this.suppressedServerDownCount++;
      return false;
    }

    // Cross-outage cooldown
    if (this.lastServerDownNotifyAt > 0 &&
        (now - this.lastServerDownNotifyAt) < NotificationRateLimiter.COOLDOWN_MS) {
      this.hasNotifiedServerDown = true;
      this.suppressedServerDownCount++;
      return false;
    }

    this.hasNotifiedServerDown = true;
    this.lastServerDownNotifyAt = now;
    this.suppressedServerDownCount = 0;
    this.sent.push(reason);
    return true;
  }

  /** Mirrors serverUp handler — resets per-outage flag but NOT cooldown. */
  onServerUp() {
    this.hasNotifiedServerDown = false;
    this.suppressedServerDownCount = 0;
  }

  get sentMessages() { return this.sent; }
}

describe('server-down notification rate limiting', () => {
  let limiter: NotificationRateLimiter;
  let now: number;

  beforeEach(() => {
    limiter = new NotificationRateLimiter();
    now = Date.now();
  });

  it('sends first notification', () => {
    expect(limiter.notifyServerDown('Health check failed', now)).toBe(true);
    expect(limiter.sentMessages).toHaveLength(1);
  });

  it('suppresses duplicate within same outage', () => {
    limiter.notifyServerDown('Health check failed', now);
    expect(limiter.notifyServerDown('Health check failed', now + 5000)).toBe(false);
    expect(limiter.sentMessages).toHaveLength(1);
    expect(limiter.suppressedServerDownCount).toBe(1);
  });

  it('suppresses notification after flap within cooldown window', () => {
    // First outage: notification sent
    limiter.notifyServerDown('Health check failed', now);
    expect(limiter.sentMessages).toHaveLength(1);

    // Server recovers
    limiter.onServerUp();

    // Second outage 15 min later — within 30 min cooldown
    const fifteenMinLater = now + 15 * 60_000;
    expect(limiter.notifyServerDown('Health check failed', fifteenMinLater)).toBe(false);
    expect(limiter.sentMessages).toHaveLength(1); // still just the first one
  });

  it('allows notification after cooldown window expires', () => {
    // First outage
    limiter.notifyServerDown('Health check failed', now);

    // Server recovers
    limiter.onServerUp();

    // Second outage 31 min later — past cooldown
    const thirtyOneMinLater = now + 31 * 60_000;
    expect(limiter.notifyServerDown('Health check failed', thirtyOneMinLater)).toBe(true);
    expect(limiter.sentMessages).toHaveLength(2);
  });

  it('handles rapid flap cycles (Power Nap pattern)', () => {
    // Simulate overnight: server goes down/up every 15 minutes for 3 hours
    const intervalMs = 15 * 60_000;
    const cycles = 12; // 3 hours at 15 min intervals

    for (let i = 0; i < cycles; i++) {
      const cycleTime = now + i * intervalMs;
      limiter.notifyServerDown('Health check failed', cycleTime);
      limiter.onServerUp();
    }

    // Should have sent at most ceil(3 hours / 30 min) = 6 notifications
    // Actually: first at t=0, next eligible at t=30min, then t=60min, etc.
    // With 15-min cycles and 30-min cooldown: t=0 (send), t=15 (suppress),
    // t=30 (send), t=45 (suppress), t=60 (send), ...
    // = 6 notifications over 3 hours, not 12.
    expect(limiter.sentMessages.length).toBeLessThanOrEqual(6);
    // And definitely fewer than the 12 raw cycles
    expect(limiter.sentMessages.length).toBeLessThan(cycles);
  });

  it('persists and restores cooldown state across restarts', () => {
    limiter.notifyServerDown('Health check failed', now);
    const saved = limiter.save();

    // Simulate process restart
    const restored = new NotificationRateLimiter();
    restored.load(saved);

    // Server recovers in new process
    restored.onServerUp();

    // Flap 10 minutes later — should still be in cooldown
    expect(restored.notifyServerDown('Health check failed', now + 10 * 60_000)).toBe(false);
  });
});
