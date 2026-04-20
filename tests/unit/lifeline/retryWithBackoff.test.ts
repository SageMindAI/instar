import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retryWithBackoff } from '../../../src/lifeline/retryWithBackoff.js';

describe('retryWithBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('succeeds on the 1st attempt with no delay', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const p = retryWithBackoff(fn, { attempts: 3, baseMs: 1000 });
    await expect(p).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure with exponential backoff and succeeds on the 3rd attempt', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce('ok');

    const p = retryWithBackoff(fn, { attempts: 3, baseMs: 1000 });

    // First attempt fires immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    // After 1s delay, second attempt fires
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);

    // After 2s more delay, third attempt fires
    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).toHaveBeenCalledTimes(3);

    await expect(p).resolves.toBe('ok');
  });

  it('gives up after all attempts exhausted and re-throws the last error', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockRejectedValueOnce(new Error('fail 3'));

    // Attach a no-op handler synchronously so the eventual rejection is not unhandled
    // while we advance fake timers.
    const p = retryWithBackoff(fn, { attempts: 3, baseMs: 1000 });
    const caught = p.catch((e: Error) => e);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('fail 3');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('invokes the onAttempt callback for each attempt', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('ok');
    const onAttempt = vi.fn();

    const p = retryWithBackoff(fn, { attempts: 3, baseMs: 100, onAttempt });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);

    await expect(p).resolves.toBe('ok');
    expect(onAttempt).toHaveBeenCalledWith(1, undefined);
    expect(onAttempt).toHaveBeenCalledWith(2, expect.any(Error));
  });

  it('short-circuits on isTerminal — zero additional attempts', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('version-skew-ish'));
    const isTerminal = (err: Error) => err.message === 'version-skew-ish';
    const p = retryWithBackoff(fn, { attempts: 3, baseMs: 1000, isTerminal });
    const caught = p.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(0);
    const err = await caught;
    expect((err as Error).message).toBe('version-skew-ish');
    // Critical: called exactly ONCE, not 3 times.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses doubling backoff (baseMs, baseMs*2, baseMs*4)', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('b'))
      .mockResolvedValueOnce('ok');

    const p = retryWithBackoff(fn, { attempts: 3, baseMs: 500 });

    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    // After 500ms: second attempt
    await vi.advanceTimersByTimeAsync(499);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    // After 1000ms more (baseMs * 2): third attempt
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(3);

    await expect(p).resolves.toBe('ok');
  });
});
