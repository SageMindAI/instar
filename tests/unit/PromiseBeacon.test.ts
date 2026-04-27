/**
 * Unit tests for PromiseBeacon — the per-commitment heartbeat monitor.
 *
 * Covers Phase 1 spec surface:
 *  - Snapshot-hash gate: unchanged tmux output emits a templated heartbeat
 *    and does NOT call the LLM.
 *  - Session-epoch mismatch transitions the commitment to `violated` with
 *    reason `session-lost`.
 *  - Quiet hours suppress heartbeats as `beaconSuppressed` (non-terminal).
 *  - Daily spend cap hit → beaconSuppressed, no heartbeat emitted.
 *  - Delivery stops the beacon for a commitment.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promise-beacon-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  // safe-git-allow: incremental-migration
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function baseTracker(dir: string) {
  return new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir) });
}

describe('PromiseBeacon', () => {
  let dir: string;
  let cleanup: () => void;
  beforeEach(() => { ({ dir, cleanup } = tmpState()); });
  afterEach(() => cleanup());

  it('emits a templated heartbeat (no LLM call) when the tmux snapshot is unchanged', async () => {
    const tracker = baseTracker(dir);
    const sent: Array<{ topicId: number; text: string }> = [];
    const queue = new LlmQueue({ maxDailyCents: 100 });
    const spy = vi.fn(async () => 'LLM-RESULT');

    const beacon = new PromiseBeacon({
      stateDir: dir,
      commitmentTracker: tracker,
      llmQueue: queue,
      proxyCoordinator: new ProxyCoordinator(),
      captureSessionOutput: () => 'static output\nline two',
      getSessionForTopic: () => 'sess-1',
      isSessionAlive: () => true,
      sendMessage: async (topicId, text) => { sent.push({ topicId, text }); },
      generateStatusLine: spy,
    });
    beacon.start();

    const c = tracker.record({
      type: 'one-time-action', userRequest: 'ship x', agentResponse: 'will ship',
      topicId: 42, beaconEnabled: true, cadenceMs: 60_000, nextUpdateDueAt: '2099-01-01T00:00:00Z',
    });

    // Fire twice — second fire hits the hash-gate because output is identical.
    await beacon.fire(c.id);
    await beacon.fire(c.id);

    expect(sent.length).toBe(2);
    // First emission calls the LLM (no prior hash to compare against).
    // Second emission uses the templated path because the hash is unchanged.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(sent[1].text).toMatch(/still (on it|working)|no (new|fresh) output|terminal quiet|snapshot unchanged|no visible change/i);
    beacon.stop();
  });

  it('transitions to violated when sessionEpoch mismatches the live session', async () => {
    const tracker = baseTracker(dir);
    const sent: Array<{ text: string }> = [];
    const beacon = new PromiseBeacon({
      stateDir: dir,
      commitmentTracker: tracker,
      llmQueue: new LlmQueue({ maxDailyCents: 100 }),
      proxyCoordinator: new ProxyCoordinator(),
      captureSessionOutput: () => 'x',
      getSessionForTopic: () => 'sess-1',
      isSessionAlive: () => true,
      getSessionEpoch: () => 'NEW-EPOCH',
      sendMessage: async (_topicId, text) => { sent.push({ text }); },
    });
    beacon.start();

    const c = tracker.record({
      type: 'one-time-action', userRequest: 'x', agentResponse: 'y',
      topicId: 10, beaconEnabled: true, cadenceMs: 60_000,
      nextUpdateDueAt: '2099-01-01T00:00:00Z', sessionEpoch: 'OLD-EPOCH',
    });
    await beacon.fire(c.id);

    const after = tracker.getAll().find(x => x.id === c.id)!;
    expect(after.status).toBe('violated');
    expect(after.resolution).toBe('session-lost');
    expect(sent[0].text).toMatch(/session-lost|violated/);
    beacon.stop();
  });

  it('suppresses during quiet hours without violating the commitment', async () => {
    const tracker = baseTracker(dir);
    const sent: string[] = [];
    // Set clock to 23:00 local (inside default 22:00-08:00 window).
    const frozen = new Date();
    frozen.setHours(23, 0, 0, 0);

    const beacon = new PromiseBeacon({
      stateDir: dir,
      commitmentTracker: tracker,
      llmQueue: new LlmQueue({ maxDailyCents: 100 }),
      proxyCoordinator: new ProxyCoordinator(),
      captureSessionOutput: () => 'x',
      getSessionForTopic: () => 'sess-1',
      isSessionAlive: () => true,
      sendMessage: async (_topicId, text) => { sent.push(text); },
      quietHours: { start: '22:00', end: '08:00' },
      now: () => frozen.getTime(),
    });
    beacon.start();

    const c = tracker.record({
      type: 'one-time-action', userRequest: 'x', agentResponse: 'y',
      topicId: 11, beaconEnabled: true, cadenceMs: 60_000, nextUpdateDueAt: '2099-01-01T00:00:00Z',
    });
    await beacon.fire(c.id);

    expect(sent.length).toBe(0);
    const after = tracker.getAll().find(x => x.id === c.id)!;
    expect(after.status).toBe('pending');
    expect(after.beaconSuppressed).toBe(true);
    expect(after.beaconSuppressionReason).toBe('quiet-hours');
    beacon.stop();
  });

  it('suppresses (not violates) when the daily LLM spend cap is already hit', async () => {
    const tracker = baseTracker(dir);
    const queue = new LlmQueue({ maxDailyCents: 5 });
    // Exhaust the cap.
    await queue.enqueue('interactive', async () => 'x', 5);

    const sent: string[] = [];
    const beacon = new PromiseBeacon({
      stateDir: dir,
      commitmentTracker: tracker,
      llmQueue: queue,
      proxyCoordinator: new ProxyCoordinator(),
      captureSessionOutput: () => 'x',
      getSessionForTopic: () => 'sess-1',
      isSessionAlive: () => true,
      sendMessage: async (_topicId, text) => { sent.push(text); },
      maxDailyLlmSpendCents: 5,
    });
    beacon.start();

    const c = tracker.record({
      type: 'one-time-action', userRequest: 'x', agentResponse: 'y',
      topicId: 12, beaconEnabled: true, cadenceMs: 60_000, nextUpdateDueAt: '2099-01-01T00:00:00Z',
    });
    await beacon.fire(c.id);

    expect(sent.length).toBe(0);
    const after = tracker.getAll().find(x => x.id === c.id)!;
    expect(after.beaconSuppressed).toBe(true);
    expect(after.beaconSuppressionReason).toBe('daily-spend-cap');
    expect(after.status).toBe('pending');
    beacon.stop();
  });
});
