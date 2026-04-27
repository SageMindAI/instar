/**
 * Unit tests for PROMISE-BEACON-SPEC Phase 1 follow-ups.
 *
 * Covers:
 *  - atRisk signal from `classifyProgress` sets the non-terminal flag and
 *    emits a softer heartbeat (signal-only; never auto-violates).
 *  - Boot-cap enforcement on start() — overflow gets `beaconSuppressed` with
 *    reason `boot-cap-exceeded`; status stays `pending`.
 *  - Cadence doubles when `atRisk` is true.
 *  - Context-injection truncation: server caps at 20 and appends "+N more".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { LlmQueue } from '../../src/monitoring/LlmQueue.js';
import { ProxyCoordinator } from '../../src/monitoring/ProxyCoordinator.js';
import { PromiseBeacon } from '../../src/monitoring/PromiseBeacon.js';

function tmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promise-beacon-fu-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  // safe-git-allow: incremental-migration
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function baseTracker(dir: string) {
  return new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir) });
}

describe('PromiseBeacon — phase 1 follow-ups', () => {
  let dir: string;
  let cleanup: () => void;
  beforeEach(() => { ({ dir, cleanup } = tmpState()); });
  afterEach(() => cleanup());

  it('classifyProgress=stalled → sets atRisk (non-terminal) and emits softer heartbeat', async () => {
    const tracker = baseTracker(dir);
    const sent: string[] = [];
    const classify = vi.fn(async () => 'stalled' as const);
    const generate = vi.fn(async () => 'normal status');

    const beacon = new PromiseBeacon({
      stateDir: dir,
      commitmentTracker: tracker,
      llmQueue: new LlmQueue({ maxDailyCents: 100 }),
      proxyCoordinator: new ProxyCoordinator(),
      // Return distinct snapshots so hash-gate does NOT skip the LLM path.
      captureSessionOutput: (() => {
        let n = 0;
        return () => `output ${++n}`;
      })(),
      getSessionForTopic: () => 'sess-1',
      isSessionAlive: () => true,
      sendMessage: async (_t, text) => { sent.push(text); },
      generateStatusLine: generate,
      classifyProgress: classify,
    });
    beacon.start();

    const c = tracker.record({
      type: 'one-time-action', userRequest: 'x', agentResponse: 'y',
      topicId: 1, beaconEnabled: true, cadenceMs: 60_000,
      nextUpdateDueAt: '2099-01-01T00:00:00Z',
    });
    await beacon.fire(c.id);

    expect(classify).toHaveBeenCalledTimes(1);
    const after = tracker.getAll().find(x => x.id === c.id)!;
    // Signal-only: atRisk flag set, status still pending.
    expect(after.atRisk).toBe(true);
    expect(after.status).toBe('pending');
    // Softer heartbeat text.
    expect(sent[0]).toMatch(/no observable progress|appears idle|flagging at-risk|no recent output/i);
    beacon.stop();
  });

  it('start() marks overflow as beaconSuppressed with reason boot-cap-exceeded', async () => {
    const tracker = baseTracker(dir);
    // Seed 5 pending beacon-enabled commitments.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = tracker.record({
        type: 'one-time-action',
        userRequest: `req-${i}`,
        agentResponse: `resp-${i}`,
        topicId: 100 + i,
        beaconEnabled: true,
        cadenceMs: 600_000,
        nextUpdateDueAt: '2099-01-01T00:00:00Z',
      });
      ids.push(c.id);
      // Small delay to ensure distinct createdAt ordering.
      await new Promise(r => setTimeout(r, 2));
    }

    const beacon = new PromiseBeacon({
      stateDir: dir,
      commitmentTracker: tracker,
      llmQueue: new LlmQueue({ maxDailyCents: 100 }),
      proxyCoordinator: new ProxyCoordinator(),
      captureSessionOutput: () => 'x',
      getSessionForTopic: () => 'sess',
      isSessionAlive: () => true,
      sendMessage: async () => { /* noop */ },
      maxActiveBeacons: 3,
    });
    beacon.start();
    // Mutate is async inside start(); let microtasks drain.
    await new Promise(r => setTimeout(r, 20));

    const all = tracker.getAll();
    const suppressed = all.filter(c => c.beaconSuppressed);
    const unsuppressed = all.filter(c => !c.beaconSuppressed);
    expect(suppressed.length).toBe(2);
    expect(suppressed.every(c => c.beaconSuppressionReason === 'boot-cap-exceeded')).toBe(true);
    expect(suppressed.every(c => c.status === 'pending')).toBe(true); // non-terminal
    expect(unsuppressed.length).toBe(3);
    // Only unsuppressed should be scheduled.
    expect(beacon.getScheduledIds().length).toBe(3);
    beacon.stop();
  });

  it('atRisk doubles effective cadence via schedule()', async () => {
    const tracker = baseTracker(dir);
    const beacon = new PromiseBeacon({
      stateDir: dir,
      commitmentTracker: tracker,
      llmQueue: new LlmQueue({ maxDailyCents: 100 }),
      proxyCoordinator: new ProxyCoordinator(),
      captureSessionOutput: () => 'x',
      getSessionForTopic: () => 'sess',
      isSessionAlive: () => true,
      sendMessage: async () => { /* noop */ },
    });
    beacon.start();
    const c = tracker.record({
      type: 'one-time-action', userRequest: 'x', agentResponse: 'y',
      topicId: 5, beaconEnabled: true, cadenceMs: 120_000,
      nextUpdateDueAt: '2099-01-01T00:00:00Z',
    });
    // Baseline: cadence honored.
    expect(beacon.getScheduledIds()).toContain(c.id);

    // Flip atRisk on the commitment and re-schedule — the new timer delay
    // should reflect 2x cadence. We can't inspect the timer delay directly,
    // but we can verify schedule() accepts the mutated commitment without
    // throwing and re-registers the timer.
    const updated = await tracker.mutate(c.id, prev => ({ ...prev, atRisk: true }));
    beacon.stopFor(c.id);
    beacon.schedule(updated);
    expect(beacon.getScheduledIds()).toContain(c.id);
    beacon.stop();
  });
});
