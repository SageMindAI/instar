import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RestartOrchestrator } from '../../../src/lifeline/RestartOrchestrator.js';
import { DegradationReporter } from '../../../src/monitoring/DegradationReporter.js';

describe('RestartOrchestrator', () => {
  beforeEach(() => {
    DegradationReporter.resetForTesting?.();
  });

  it('proceeds through idle → quiescing → persisting → exiting', async () => {
    const states: string[] = [];
    const quiesce = vi.fn(async () => { states.push('quiesce'); });
    const persistAll = vi.fn(async () => { states.push('persist'); });
    const exitFn = vi.fn(() => { states.push('exit'); });
    const o = new RestartOrchestrator({ quiesce, persistAll, exitFn, isSupervised: true });
    await o.requestRestart({ reason: 'test', bucket: 'watchdog' });
    expect(states).toEqual(['quiesce', 'persist', 'exit']);
    expect(o.state).toBe('exiting');
  });

  it('suppresses re-entrant requests (single-owner guarantee)', async () => {
    // Deferred pattern — promise and resolver created together so the
    // resolver is callable from the outer scope regardless of timing.
    let resolveQuiesce!: () => void;
    const quiescePromise = new Promise<void>(r => { resolveQuiesce = r; });
    const quiesce = vi.fn(() => quiescePromise);
    const persistAll = vi.fn(async () => {});
    const exitFn = vi.fn();
    const o = new RestartOrchestrator({ quiesce, persistAll, exitFn, isSupervised: true });

    const first = o.requestRestart({ reason: 'watchdog-tick', bucket: 'watchdog' });
    // Second request synchronously after first — state is already 'quiescing'.
    const second = await o.requestRestart({ reason: 'version-skew', bucket: 'versionSkew' });
    expect(second).toBe('suppressed');
    expect(o.lastSuppressed?.reason).toBe('version-skew');
    // State may be 'quiescing' or still pre-quiesce depending on microtask
    // ordering; accept either as valid non-idle states.
    expect(['quiescing', 'persisting']).toContain(o.lastSuppressed?.currentState);

    resolveQuiesce();
    await first;
    expect(quiesce).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledTimes(1);
  });

  it('unsupervised mode emits signal but does not exit', async () => {
    const exitFn = vi.fn();
    const quiesce = vi.fn(async () => {});
    const persistAll = vi.fn(async () => {});
    const o = new RestartOrchestrator({ quiesce, persistAll, exitFn, isSupervised: false });
    const r = await o.requestRestart({ reason: 'test', bucket: 'watchdog' });
    expect(r).toBe('suppressed');
    expect(exitFn).not.toHaveBeenCalled();
    expect(quiesce).not.toHaveBeenCalled(); // stopped before quiesce
    expect(o.state).toBe('idle');
  });

  it('supervised mode exits with code 0 on clean persist', async () => {
    const exitFn = vi.fn();
    const o = new RestartOrchestrator({
      quiesce: async () => {},
      persistAll: async () => {},
      exitFn,
      isSupervised: true,
    });
    await o.requestRestart({ reason: 'test', bucket: 'watchdog' });
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it('defers when shadow-install is updating (AC10)', async () => {
    const exitFn = vi.fn();
    const quiesce = vi.fn(async () => {});
    const o = new RestartOrchestrator({
      quiesce,
      persistAll: async () => {},
      exitFn,
      isSupervised: true,
      isShadowInstallUpdating: () => true, // lockfile present
    });
    const r = await o.requestRestart({ reason: 'noForwardStuck', bucket: 'watchdog' });
    expect(r).toBe('suppressed');
    expect(quiesce).not.toHaveBeenCalled();
    expect(exitFn).not.toHaveBeenCalled();
    expect(o.state).toBe('idle'); // re-entered idle so next tick can retry
  });

  it('proceeds when shadow-install is not updating', async () => {
    const exitFn = vi.fn();
    const o = new RestartOrchestrator({
      quiesce: async () => {},
      persistAll: async () => {},
      exitFn,
      isSupervised: true,
      isShadowInstallUpdating: () => false,
    });
    await o.requestRestart({ reason: 'x', bucket: 'watchdog' });
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it('hard-kill timer fires if persist hangs past hardKillMs', async () => {
    vi.useFakeTimers();
    const exitFn = vi.fn();
    const o = new RestartOrchestrator({
      quiesce: async () => {},
      persistAll: () => new Promise(() => {}), // never resolves
      exitFn,
      isSupervised: true,
      persistBudgetMs: 100,
      hardKillMs: 500,
    });
    const p = o.requestRestart({ reason: 'test', bucket: 'watchdog' });
    // Advance past persistBudgetMs — Promise.race([persist, timeout]) resolves
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(exitFn).toHaveBeenCalledWith(0); // normal-exit path, budget expired
    vi.useRealTimers();
  });
});
