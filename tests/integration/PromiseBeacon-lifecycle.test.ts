/**
 * Integration test: end-to-end PromiseBeacon lifecycle.
 *
 * Scenario:
 *   1. A beacon-enabled commitment is recorded.
 *   2. The beacon fires at least one heartbeat on the bound topic.
 *   3. `POST /commitments/:id/deliver` (simulated via tracker.deliver())
 *      transitions the commitment to `delivered` and stops the beacon.
 *   4. Subsequent fires for that commitment are no-ops.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { LlmQueue } from '../../src/monitoring/LlmQueue.js';
import { ProxyCoordinator } from '../../src/monitoring/ProxyCoordinator.js';
import { PromiseBeacon } from '../../src/monitoring/PromiseBeacon.js';

describe('PromiseBeacon lifecycle', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promise-beacon-int-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  });
  // safe-git-allow: incremental-migration
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('records → heartbeats → delivered → stops', async () => {
    const tracker = new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir) });
    const sent: string[] = [];
    const beacon = new PromiseBeacon({
      stateDir: dir,
      commitmentTracker: tracker,
      llmQueue: new LlmQueue({ maxDailyCents: 100 }),
      proxyCoordinator: new ProxyCoordinator(),
      captureSessionOutput: () => 'tmux output\nrunning',
      getSessionForTopic: () => 'sess-1',
      isSessionAlive: () => true,
      sendMessage: async (_t, text) => { sent.push(text); },
    });
    beacon.start();

    const c = tracker.record({
      type: 'one-time-action',
      userRequest: 'run the thing',
      agentResponse: 'will ship in ~10min',
      topicId: 77,
      beaconEnabled: true,
      cadenceMs: 60_000,
      nextUpdateDueAt: '2099-01-01T00:00:00Z',
      beaconCreatedBySource: 'skill',
    });

    // Fire one heartbeat.
    await beacon.fire(c.id);
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatch(/^⏳/);

    // Deliver — simulates POST /commitments/:id/deliver.
    const delivered = tracker.deliver(c.id, 'msg-abc');
    expect(delivered?.status).toBe('delivered');
    expect(delivered?.deliveryMessageId).toBe('msg-abc');

    // Fire after delivery — should NOT emit anything.
    await beacon.fire(c.id);
    expect(sent.length).toBe(1);

    // No further scheduled timer for that id.
    expect(beacon.getScheduledIds()).not.toContain(c.id);

    beacon.stop();
  });

  it('rejects deliver on terminal status', async () => {
    const tracker = new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir) });
    const c = tracker.record({
      type: 'one-time-action', userRequest: 'x', agentResponse: 'y',
      topicId: 1, beaconEnabled: true, cadenceMs: 60_000,
      nextUpdateDueAt: '2099-01-01T00:00:00Z',
    });
    expect(tracker.deliver(c.id)?.status).toBe('delivered');
    expect(tracker.deliver(c.id)).toBeNull(); // already delivered
  });
});
