import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SleepWakeDetector } from '../../src/core/SleepWakeDetector.js';

describe('SleepWakeDetector', () => {
  let detector: SleepWakeDetector;

  afterEach(() => {
    detector?.stop();
    vi.restoreAllMocks();
  });

  it('emits wake event when timer drift exceeds threshold', async () => {
    detector = new SleepWakeDetector({
      checkIntervalMs: 50,
      driftThresholdMs: 100,
    });

    const wakePromise = new Promise<any>((resolve) => {
      detector.on('wake', resolve);
    });

    // Fake a sleep by advancing time
    let realNow = Date.now();
    const origDateNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow);

    detector.start();

    // First tick — normal (no drift)
    realNow += 60;
    await new Promise(r => setTimeout(r, 60));

    // Second tick — simulate a wake (large time jump)
    realNow += 5000; // 5 second sleep

    const event = await Promise.race([
      wakePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 500)),
    ]);

    expect(event).toHaveProperty('sleepDurationSeconds');
    expect(event).toHaveProperty('timestamp');
    expect(event.sleepDurationSeconds).toBeGreaterThan(0);
  });

  it('does not emit wake on normal ticks', async () => {
    detector = new SleepWakeDetector({
      checkIntervalMs: 50,
      driftThresholdMs: 500,
    });

    const wakeSpy = vi.fn();
    detector.on('wake', wakeSpy);
    detector.start();

    // Wait for a few normal ticks
    await new Promise(r => setTimeout(r, 200));

    expect(wakeSpy).not.toHaveBeenCalled();
  });

  it('stop prevents further events', async () => {
    const wakeSpy = vi.fn();
    detector = new SleepWakeDetector({
      checkIntervalMs: 50,
      driftThresholdMs: 100,
    });
    detector.on('wake', wakeSpy);
    detector.start();
    detector.stop();
    await new Promise(r => setTimeout(r, 200));
    expect(wakeSpy).not.toHaveBeenCalled();
  });

  it('start is idempotent', () => {
    detector = new SleepWakeDetector();
    // Calling start() twice should not throw
    expect(() => {
      detector.start();
      detector.start();
    }).not.toThrow();
    detector.stop();
  });

  it('does not fire on normal OS scheduling jitter (< 15s)', async () => {
    // Regression: lowering threshold to 5s caused false wake detections
    // every 5 minutes from normal OS timer jitter (~9-10s drift).
    // The supervisor uses 15s threshold; verify jitter below that is ignored.
    detector = new SleepWakeDetector({
      checkIntervalMs: 50,
      driftThresholdMs: 15_000, // matches supervisor config
    });

    const wakeSpy = vi.fn();
    detector.on('wake', wakeSpy);

    let realNow = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => realNow);

    detector.start();

    // Simulate 10s of jitter (well under 15s threshold)
    realNow += 10_000;
    await new Promise(r => setTimeout(r, 100));

    expect(wakeSpy).not.toHaveBeenCalled();
  });
});
