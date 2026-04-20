import { describe, it, expect } from 'vitest';
import {
  evaluate,
  LifelineHealthWatchdog,
  DEFAULT_WATCHDOG_THRESHOLDS,
  SIGNAL_PRIORITY,
  type WatchdogInputs,
} from '../../../src/lifeline/LifelineHealthWatchdog.js';

const baseInputs = (over: Partial<WatchdogInputs> = {}): WatchdogInputs => ({
  now: 1_000_000,
  oldestQueueItemEnqueuedAt: undefined,
  consecutiveForwardFailures: 0,
  conflict409StartedAt: null,
  serverHealthy: true,
  ...over,
});

describe('evaluate (signal logic)', () => {
  it('empty queue does NOT trip noForwardStuck — idle-agent safety', () => {
    // This is the crucial crash-loop prevention: a low-traffic agent
    // with no recent message must not trip when a message arrives.
    const r = evaluate(
      baseInputs({ oldestQueueItemEnqueuedAt: undefined }),
      DEFAULT_WATCHDOG_THRESHOLDS,
    );
    expect(r.tripped).not.toContain('noForwardStuck');
  });

  it('queue non-empty but oldest item young does NOT trip', () => {
    const r = evaluate(
      baseInputs({
        now: 1_000_000,
        oldestQueueItemEnqueuedAt: 1_000_000 - 60_000, // 60s ago
      }),
      DEFAULT_WATCHDOG_THRESHOLDS,
    );
    expect(r.tripped).not.toContain('noForwardStuck');
  });

  it('queue non-empty and oldest item >10min trips noForwardStuck', () => {
    const r = evaluate(
      baseInputs({
        now: 1_000_000,
        oldestQueueItemEnqueuedAt: 1_000_000 - 11 * 60_000,
      }),
      DEFAULT_WATCHDOG_THRESHOLDS,
    );
    expect(r.tripped).toContain('noForwardStuck');
  });

  it('noForwardStuck suppressed when supervisor unhealthy', () => {
    const r = evaluate(
      baseInputs({
        now: 1_000_000,
        oldestQueueItemEnqueuedAt: 1_000_000 - 11 * 60_000,
        serverHealthy: false,
      }),
      DEFAULT_WATCHDOG_THRESHOLDS,
    );
    expect(r.tripped).not.toContain('noForwardStuck');
  });

  it('consecutiveForwardFailures > 20 trips', () => {
    const r = evaluate(
      baseInputs({ consecutiveForwardFailures: 21 }),
      DEFAULT_WATCHDOG_THRESHOLDS,
    );
    expect(r.tripped).toContain('consecutiveFailures');
  });

  it('conflict409 older than 5min trips', () => {
    const r = evaluate(
      baseInputs({ now: 1_000_000, conflict409StartedAt: 1_000_000 - 6 * 60_000 }),
      DEFAULT_WATCHDOG_THRESHOLDS,
    );
    expect(r.tripped).toContain('conflict409Stuck');
  });

  it('all three trip in one tick fires ONE event with priority', () => {
    const r = evaluate(
      baseInputs({
        now: 1_000_000,
        oldestQueueItemEnqueuedAt: 1_000_000 - 11 * 60_000,
        consecutiveForwardFailures: 25,
        conflict409StartedAt: 1_000_000 - 6 * 60_000,
      }),
      DEFAULT_WATCHDOG_THRESHOLDS,
    );
    expect(r.tripped).toHaveLength(3);
    expect(r.primary).toBe(SIGNAL_PRIORITY[0]); // conflict409Stuck
    expect(r.snapshot.consecutiveForwardFailures).toBe(25);
  });
});

describe('LifelineHealthWatchdog.tick', () => {
  it('calls onTrip with highest-priority signal', () => {
    let tripCount = 0;
    let lastPrimary: string | null = null;
    const wd = new LifelineHealthWatchdog({
      getInputs: () => baseInputs({
        now: Date.now(),
        consecutiveForwardFailures: 21,
      }),
      onTrip: (r) => {
        tripCount++;
        lastPrimary = r.primary;
      },
      autoStart: false,
    });
    wd.tick();
    expect(tripCount).toBe(1);
    expect(lastPrimary).toBe('consecutiveFailures');
  });

  it('does not call onTrip when nothing tripped', () => {
    let tripCount = 0;
    const wd = new LifelineHealthWatchdog({
      getInputs: () => baseInputs(),
      onTrip: () => { tripCount++; },
      autoStart: false,
    });
    wd.tick();
    expect(tripCount).toBe(0);
  });

  it('latches signals that cross threshold; drops latches when de-crossed', () => {
    let counter = 25;
    const wd = new LifelineHealthWatchdog({
      getInputs: () => baseInputs({ consecutiveForwardFailures: counter }),
      onTrip: () => { /* no-op */ },
      autoStart: false,
    });
    wd.tick();
    expect(wd._latchedForTesting().has('consecutiveFailures')).toBe(true);
    // De-cross (e.g., a successful forward resets the counter):
    counter = 0;
    wd.tick();
    expect(wd._latchedForTesting().has('consecutiveFailures')).toBe(false);
  });

  it('emits onStarved when tick gap exceeds starvationMultiplier × tickInterval', () => {
    let now = 1_000_000;
    let starvedGap: number | null = null;
    const wd = new LifelineHealthWatchdog({
      thresholds: { tickIntervalMs: 30_000, starvationMultiplier: 3 },
      getInputs: () => baseInputs({ now }),
      onTrip: () => { /* no-op */ },
      onStarved: (gap) => { starvedGap = gap; },
      autoStart: false,
    });
    wd.tick();                 // lastTickAt = 1_000_000
    now = 1_000_000 + 120_000; // +120s = 4× tickInterval
    wd.tick();
    expect(starvedGap).toBeGreaterThan(90_000);
  });
});
