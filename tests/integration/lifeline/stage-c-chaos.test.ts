/**
 * Stage C — chaos / stress integration tests for the Stage B self-restart
 * substrate. See docs/specs/LIFELINE-STAGE-C-CHAOS-TESTS-SPEC.md.
 *
 * These tests compose the REAL Stage-B modules (MessageQueue on disk,
 * rate-limit state on disk, LifelineHealthWatchdog with real evaluate(),
 * RestartOrchestrator state machine, DegradationReporter singleton) and
 * drive each failure mode through the full trip → suppress-or-write-and-exit
 * chain. A tiny `initiateRestart` helper mirrors TelegramLifeline's wire-up
 * so the composition can be exercised without loading the full config/
 * tmux/supervisor stack.
 *
 * Exit is captured via an injected exitFn on the orchestrator; nothing
 * here touches process.exit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MessageQueue, type QueuedMessage } from '../../../src/lifeline/MessageQueue.js';
import {
  LifelineHealthWatchdog,
  type TripResult,
  type WatchdogInputs,
} from '../../../src/lifeline/LifelineHealthWatchdog.js';
import { RestartOrchestrator } from '../../../src/lifeline/RestartOrchestrator.js';
import {
  decide,
  isRestartStorm,
  readRateLimitState,
  statePath,
  writeRateLimitState,
  type RestartBucket,
  type RestartHistoryEntry,
} from '../../../src/lifeline/rateLimitState.js';
import { DegradationReporter } from '../../../src/monitoring/DegradationReporter.js';

type RestartOutcome = 'exited' | 'suppressed';

interface Harness {
  stateDir: string;
  queue: MessageQueue;
  orchestrator: RestartOrchestrator;
  watchdog: LifelineHealthWatchdog;
  exitCalls: number[];
  tripResults: TripResult[];
  /** Mutable inputs read by the watchdog on each tick. */
  inputs: WatchdogInputs;
  /** Simulate TelegramLifeline.initiateRestart: rate-limit check, storm signal, history write, orchestrator. */
  initiateRestart: (bucket: RestartBucket, reason: string) => Promise<RestartOutcome>;
}

function mkHarness(overrides?: {
  thresholds?: Partial<ConstructorParameters<typeof LifelineHealthWatchdog>[0]['thresholds']>;
  isShadowInstallUpdating?: () => boolean;
}): Harness {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-c-'));
  const queue = new MessageQueue(stateDir);

  const exitCalls: number[] = [];
  const orchestrator = new RestartOrchestrator({
    quiesce: async () => {
      // In production, this stops polling/replay/watchdog. Harness stops the watchdog
      // so it can't re-trip mid-persist.
      watchdog.stop();
    },
    persistAll: async () => {
      // MessageQueue writes atomically on enqueue; nothing else to flush here.
    },
    exitFn: (code) => {
      exitCalls.push(code);
    },
    isSupervised: true,
    isShadowInstallUpdating: overrides?.isShadowInstallUpdating,
    persistBudgetMs: 100,
    hardKillMs: 500,
  });

  const tripResults: TripResult[] = [];
  const inputs: WatchdogInputs = {
    now: Date.now(),
    oldestQueueItemEnqueuedAt: undefined,
    consecutiveForwardFailures: 0,
    conflict409StartedAt: null,
    serverHealthy: true,
  };

  const watchdog = new LifelineHealthWatchdog({
    thresholds: overrides?.thresholds,
    getInputs: () => ({ ...inputs, now: Date.now() }),
    onTrip: (r) => {
      tripResults.push(r);
      // Real wire-up calls initiateRestart with bucket='watchdog'.
      void harness.initiateRestart('watchdog', r.primary ?? 'unknown');
    },
    autoStart: false,
  });

  const initiateRestart = async (bucket: RestartBucket, reason: string): Promise<RestartOutcome> => {
    const outcome = readRateLimitState(stateDir);
    const dec = decide(outcome, bucket);
    if (!dec.allowed) return 'suppressed';
    if (dec.stormActive || isRestartStorm(outcome.kind === 'ok' ? outcome.state : null)) {
      DegradationReporter.getInstance().report({
        feature: 'TelegramLifeline.restartStorm',
        primary: 'Rate-limited self-restarts within ceiling',
        fallback: 'Continuing to restart — underlying cause unresolved',
        reason: `>= 6 restarts within the last hour; latest bucket=${bucket} reason=${reason}`,
        impact: 'Operator should investigate; self-heal is not converging.',
      });
    }
    const prior = outcome.kind === 'ok' ? outcome.state : null;
    writeRateLimitState(stateDir, reason, bucket, prior);
    const result = await orchestrator.requestRestart({ reason, bucket });
    return result === 'proceeded' ? 'exited' : 'suppressed';
  };

  const harness: Harness = {
    stateDir,
    queue,
    orchestrator,
    watchdog,
    exitCalls,
    tripResults,
    inputs,
    initiateRestart,
  };
  return harness;
}

function enqueue(
  queue: MessageQueue,
  overrides: Partial<QueuedMessage> = {},
): QueuedMessage {
  const msg: QueuedMessage = {
    id: overrides.id ?? `m-${Math.random().toString(36).slice(2, 10)}`,
    topicId: 1,
    text: 'hello',
    fromUserId: 1,
    fromFirstName: 'test',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
  queue.enqueue(msg);
  return msg;
}

function seedHistory(stateDir: string, entries: RestartHistoryEntry[]): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const newest = entries[entries.length - 1];
  const state = {
    lastRestartAt: newest.at,
    lastReason: newest.reason,
    history: entries,
  };
  fs.writeFileSync(statePath(stateDir), JSON.stringify(state, null, 2));
}

let harness: Harness;

beforeEach(() => {
  DegradationReporter.resetForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    if (harness?.stateDir && fs.existsSync(harness.stateDir)) {
      // safe-git-allow: incremental-migration
      fs.rmSync(harness.stateDir, { recursive: true, force: true });
    }
  } catch {
    /* best effort */
  }
});

describe('Stage C — chaos / stress integration', () => {
  it('S1: version-skew path writes versionSkew history and exits', async () => {
    harness = mkHarness();
    const outcome = await harness.initiateRestart('versionSkew', 'version-skew');

    expect(outcome).toBe('exited');
    expect(harness.exitCalls).toEqual([0]);

    const state = readRateLimitState(harness.stateDir);
    expect(state.kind).toBe('ok');
    if (state.kind === 'ok') {
      expect(state.state.history).toHaveLength(1);
      expect(state.state.history[0].bucket).toBe('versionSkew');
      expect(state.state.history[0].reason).toBe('version-skew');
    }
  });

  it('S2: noForwardStuck trips when oldest queued item age exceeds threshold', async () => {
    harness = mkHarness({ thresholds: { tickIntervalMs: 10, noForwardStuckMs: 100 } });

    // Stale queued message — older than threshold.
    const staleTs = Date.now() - 200;
    enqueue(harness.queue, { timestamp: new Date(staleTs).toISOString() });
    harness.inputs.oldestQueueItemEnqueuedAt = staleTs;

    harness.watchdog.tick();
    // Orchestrator.requestRestart is async; wait a microtask.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(harness.tripResults.length).toBeGreaterThanOrEqual(1);
    expect(harness.tripResults[0].tripped).toContain('noForwardStuck');
    expect(harness.exitCalls).toEqual([0]);
  });

  it('S3: conflict409Stuck has higher priority than simultaneous consecutiveFailures', async () => {
    harness = mkHarness({
      thresholds: {
        tickIntervalMs: 10,
        conflict409StuckMs: 100,
        consecutiveFailureMax: 5,
      },
    });

    const now = Date.now();
    harness.inputs.conflict409StartedAt = now - 200;
    harness.inputs.consecutiveForwardFailures = 50;

    harness.watchdog.tick();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const trip = harness.tripResults[0];
    expect(trip).toBeDefined();
    expect(trip.tripped).toContain('conflict409Stuck');
    expect(trip.tripped).toContain('consecutiveFailures');
    expect(trip.primary).toBe('conflict409Stuck');
    expect(harness.exitCalls).toEqual([0]);
  });

  it('S4: watchdog rate-limit brake suppresses a second trip within the cooldown', async () => {
    harness = mkHarness({ thresholds: { tickIntervalMs: 10, noForwardStuckMs: 50 } });

    // First trip — write history now.
    const first = await harness.initiateRestart('watchdog', 'noForwardStuck');
    expect(first).toBe('exited');

    // Reset orchestrator so a second attempt isn't blocked by its own state.
    harness.orchestrator._resetForTesting();

    // Second attempt within cooldown — rate-limit decision blocks.
    const second = await harness.initiateRestart('watchdog', 'noForwardStuck');
    expect(second).toBe('suppressed');
    expect(harness.exitCalls).toEqual([0]); // only the first

    const state = readRateLimitState(harness.stateDir);
    expect(state.kind).toBe('ok');
    if (state.kind === 'ok') {
      expect(state.state.history).toHaveLength(1);
    }
  });

  it('S5: storm escalation fires when 6th restart arrives within the hour', async () => {
    harness = mkHarness();
    const reporterSpy = vi.spyOn(DegradationReporter.getInstance(), 'report');

    // Seed 6 prior restart entries within the last hour (>= storm threshold).
    // Newest is 11 min ago so cooldown has passed and the 7th restart is allowed;
    // decide() returns stormActive=true, and the storm signal must fire.
    const now = Date.now();
    const seeded: RestartHistoryEntry[] = [
      { at: new Date(now - 55 * 60_000).toISOString(), reason: 'a', bucket: 'watchdog' },
      { at: new Date(now - 45 * 60_000).toISOString(), reason: 'b', bucket: 'watchdog' },
      { at: new Date(now - 35 * 60_000).toISOString(), reason: 'c', bucket: 'watchdog' },
      { at: new Date(now - 25 * 60_000).toISOString(), reason: 'd', bucket: 'watchdog' },
      { at: new Date(now - 20 * 60_000).toISOString(), reason: 'e', bucket: 'watchdog' },
      { at: new Date(now - 11 * 60_000).toISOString(), reason: 'f', bucket: 'watchdog' },
    ];
    seedHistory(harness.stateDir, seeded);

    const outcome = await harness.initiateRestart('watchdog', 'noForwardStuck');
    expect(outcome).toBe('exited');

    const stormCalls = reporterSpy.mock.calls.filter(
      (c) => (c[0] as { feature?: string }).feature === 'TelegramLifeline.restartStorm',
    );
    expect(stormCalls.length).toBeGreaterThanOrEqual(1);

    // History now has 7 entries (6 seeded + 1 new).
    const state = readRateLimitState(harness.stateDir);
    expect(state.kind).toBe('ok');
    if (state.kind === 'ok') {
      expect(state.state.history).toHaveLength(7);
    }
  });

  it('S6: queued messages survive the full restart sequence (MessageQueue reloads from disk)', async () => {
    harness = mkHarness();

    const a = enqueue(harness.queue, { id: 'A', text: 'alpha' });
    const b = enqueue(harness.queue, { id: 'B', text: 'beta' });
    const c = enqueue(harness.queue, { id: 'C', text: 'gamma' });

    const outcome = await harness.initiateRestart('watchdog', 'noForwardStuck');
    expect(outcome).toBe('exited');

    // Fresh MessageQueue simulates the post-restart process loading from disk.
    const respawned = new MessageQueue(harness.stateDir);
    const peeked = respawned.peek();
    expect(peeked).toHaveLength(3);
    expect(peeked.map((m) => m.id)).toEqual([a.id, b.id, c.id]);
    expect(peeked.map((m) => m.text)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('S7 (regression): empty queue never trips noForwardStuck — idle-agent safety', () => {
    harness = mkHarness({ thresholds: { tickIntervalMs: 10, noForwardStuckMs: 10 } });

    // Queue empty. Advance "now" so any elapsed time would exceed threshold.
    harness.inputs.oldestQueueItemEnqueuedAt = undefined;

    harness.watchdog.tick();
    harness.watchdog.tick();

    expect(harness.tripResults).toHaveLength(0);
    expect(harness.exitCalls).toHaveLength(0);
  });

  it('S8 (regression): shadow-install updating defers restart (no exit this cycle)', async () => {
    let updating = true;
    harness = mkHarness({ isShadowInstallUpdating: () => updating });

    const outcome = await harness.orchestrator.requestRestart({
      reason: 'noForwardStuck',
      bucket: 'watchdog',
    });

    expect(outcome).toBe('suppressed');
    expect(harness.exitCalls).toHaveLength(0);
    expect(harness.orchestrator.state).toBe('idle');

    // Updater finishes; next attempt proceeds.
    updating = false;
    const retry = await harness.orchestrator.requestRestart({
      reason: 'noForwardStuck',
      bucket: 'watchdog',
    });
    expect(retry).toBe('proceeded');
    expect(harness.exitCalls).toEqual([0]);
  });
});
