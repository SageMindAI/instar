// Unit tests for CompactionSentinel — verifies the full detect/inject/verify/
// retry lifecycle, dedupe behavior, and isRecoveryActive predicate used by the
// zombie-killer veto.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompactionSentinel } from '../../src/monitoring/CompactionSentinel.js';

function makeTempJsonlRoot(): { root: string; write: (name: string, bytes: number) => void; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-test-'));
  return {
    root,
    write: (name, bytes) => {
      fs.writeFileSync(path.join(root, name), 'x'.repeat(bytes));
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

describe('CompactionSentinel', () => {
  let jsonl: ReturnType<typeof makeTempJsonlRoot>;
  let recoverFn: ReturnType<typeof vi.fn>;
  let sentinel: CompactionSentinel;
  let events: Array<{ type: string; payload: any }>;

  beforeEach(() => {
    vi.useFakeTimers();
    jsonl = makeTempJsonlRoot();
    recoverFn = vi.fn().mockResolvedValue(true);
    sentinel = new CompactionSentinel(
      {
        recoverFn: recoverFn as any,
        projectDir: '/fake/project',
        jsonlRoot: jsonl.root,
      },
      {
        dedupeWindowMs: 60_000,
        verifyWindowMs: 25_000,
        maxInjectAttempts: 3,
        recoveryGuardMs: 10 * 60_000,
      },
    );
    events = [];
    for (const e of ['compaction:detected', 'compaction:inject-attempted', 'compaction:recovered', 'compaction:failed']) {
      sentinel.on(e as any, (p: any) => events.push({ type: e, payload: p }));
    }
  });

  afterEach(() => {
    sentinel.stop();
    jsonl.cleanup();
    vi.useRealTimers();
  });

  // ─── Detection / dedupe ───

  it('emits compaction:detected on first report and calls recoverFn', async () => {
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'watchdog-poll');
    // Allow the async recoverFn to resolve.
    await vi.advanceTimersByTimeAsync(0);
    expect(events.some(e => e.type === 'compaction:detected')).toBe(true);
    expect(recoverFn).toHaveBeenCalledTimes(1);
    expect(recoverFn).toHaveBeenCalledWith('s1', 'watchdog-poll');
  });

  it('dedupes reports within the dedupe window', async () => {
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'PreCompact');
    await vi.advanceTimersByTimeAsync(0);
    sentinel.report('s1', 'watchdog-poll'); // should be no-op — already active
    sentinel.report('s1', 'recovery-hook'); // also no-op
    await vi.advanceTimersByTimeAsync(0);
    expect(recoverFn).toHaveBeenCalledTimes(1);
  });

  it('separate sessions recover independently', async () => {
    jsonl.write('a.jsonl', 100);
    sentinel.report('session-a', 'watchdog-poll');
    sentinel.report('session-b', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    expect(recoverFn).toHaveBeenCalledWith('session-a', 'watchdog-poll');
    expect(recoverFn).toHaveBeenCalledWith('session-b', 'watchdog-poll');
  });

  // ─── Verification success path ───

  it('emits compaction:recovered when jsonl grows within the verify window', async () => {
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'watchdog-poll');
    // Let recoverFn resolve
    await vi.advanceTimersByTimeAsync(0);
    // Simulate claude writing to jsonl
    jsonl.write('foo.jsonl', 500);
    // Advance past verify window
    await vi.advanceTimersByTimeAsync(25_500);
    const recovered = events.find(e => e.type === 'compaction:recovered');
    expect(recovered).toBeDefined();
    expect(recovered!.payload.jsonlDelta).toBeGreaterThan(0);
    expect(recovered!.payload.attempts).toBe(1);
  });

  // ─── Retry path ───

  it('retries when jsonl does not grow, up to maxInjectAttempts', async () => {
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);

    // First verify window passes with no growth → retry
    await vi.advanceTimersByTimeAsync(25_500);
    expect(recoverFn).toHaveBeenCalledTimes(2);
    // Second verify window → retry again
    await vi.advanceTimersByTimeAsync(25_500);
    expect(recoverFn).toHaveBeenCalledTimes(3);
    // Third → exhausted → failed
    await vi.advanceTimersByTimeAsync(25_500);
    const failed = events.find(e => e.type === 'compaction:failed');
    expect(failed).toBeDefined();
    expect(failed!.payload.attempts).toBe(3);
  });

  it('stops retrying as soon as jsonl grows (recovers on attempt 2)', async () => {
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(25_500); // first verify fails → retry
    expect(recoverFn).toHaveBeenCalledTimes(2);

    jsonl.write('foo.jsonl', 400);
    await vi.advanceTimersByTimeAsync(25_500); // second verify succeeds
    const recovered = events.find(e => e.type === 'compaction:recovered');
    expect(recovered).toBeDefined();
    expect(recovered!.payload.attempts).toBe(2);
    expect(recoverFn).toHaveBeenCalledTimes(2);
  });

  // ─── Zombie veto ───

  it('isRecoveryActive returns true during recovery and false after success', async () => {
    jsonl.write('foo.jsonl', 100);
    expect(sentinel.isRecoveryActive('s1')).toBe(false);
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    expect(sentinel.isRecoveryActive('s1')).toBe(true); // verifying

    jsonl.write('foo.jsonl', 500);
    await vi.advanceTimersByTimeAsync(25_500);
    // Recovered — but we still veto briefly before cleanup. Check both paths:
    // during the 5s post-recovery keep-window, state.status = 'recovered'
    // → isRecoveryActive should be FALSE (don't claim active in terminal state).
    expect(sentinel.isRecoveryActive('s1')).toBe(false);

    // After the keep-window, state is gone.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(sentinel.isRecoveryActive('s1')).toBe(false);
    expect(sentinel.getState('s1')).toBeUndefined();
  });

  it('isRecoveryActive returns false for never-seen sessions', () => {
    expect(sentinel.isRecoveryActive('never-reported')).toBe(false);
  });

  // ─── recoverFn failure ───

  it('finalizes as failed when recoverFn returns false', async () => {
    recoverFn.mockResolvedValue(false);
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    const failed = events.find(e => e.type === 'compaction:failed');
    expect(failed).toBeDefined();
    expect(failed!.payload.reason).toMatch(/declined/);
    // Should NOT retry when recoverFn declines — different from verify failure
    expect(recoverFn).toHaveBeenCalledTimes(1);
  });

  it('treats recoverFn throwing as acceptance=false and finalizes', async () => {
    recoverFn.mockRejectedValue(new Error('kaboom'));
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    const failed = events.find(e => e.type === 'compaction:failed');
    expect(failed).toBeDefined();
    expect(recoverFn).toHaveBeenCalledTimes(1);
  });

  // ─── Jsonl baseline edge cases ───

  it('handles the no-jsonl case without crashing', async () => {
    // No jsonl file written at all
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    // Should still dispatch inject
    expect(recoverFn).toHaveBeenCalledTimes(1);
    // verify window: no baseline means grew=false → retry
    await vi.advanceTimersByTimeAsync(25_500);
    expect(recoverFn).toHaveBeenCalledTimes(2);
  });

  it('detects growth via mtime change on a fixed-size jsonl', async () => {
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    // Simulate mtime change without size change (rare, but possible)
    const p = path.join(jsonl.root, 'foo.jsonl');
    const newTime = new Date(Date.now() + 5000);
    fs.utimesSync(p, newTime, newTime);
    await vi.advanceTimersByTimeAsync(25_500);
    const recovered = events.find(e => e.type === 'compaction:recovered');
    expect(recovered).toBeDefined();
  });

  // ─── clear / stop ───

  it('clear() removes active state', async () => {
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    expect(sentinel.getState('s1')).toBeDefined();
    sentinel.clear('s1');
    expect(sentinel.getState('s1')).toBeUndefined();
  });

  it('stop() cleans up all state and timers', async () => {
    jsonl.write('a.jsonl', 100);
    sentinel.report('a', 'watchdog-poll');
    sentinel.report('b', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    sentinel.stop();
    expect(sentinel.getState('a')).toBeUndefined();
    expect(sentinel.getState('b')).toBeUndefined();
  });
});
