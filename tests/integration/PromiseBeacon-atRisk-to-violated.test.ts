/**
 * Integration: commit-action → beacon → summarizer signals concern → atRisk
 * (non-terminal) → simulated session death → violated (terminal).
 *
 * Exercises the signal-vs-authority split: the `classifyProgress` summarizer
 * can only set the non-terminal `atRisk` flag; promotion to terminal
 * `violated` requires a hard corroborating signal (session-epoch mismatch).
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

describe('PromiseBeacon — atRisk signal → violated authority', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-ar-v-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  });
  // safe-git-allow: incremental-migration
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('classifier=stalled sets atRisk (non-terminal); session-epoch mismatch then promotes to violated', async () => {
    const tracker = new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir) });
    const sent: string[] = [];
    let liveEpoch = 'EPOCH-A';
    let snapshotNum = 0;

    const beacon = new PromiseBeacon({
      stateDir: dir,
      commitmentTracker: tracker,
      llmQueue: new LlmQueue({ maxDailyCents: 100 }),
      proxyCoordinator: new ProxyCoordinator(),
      captureSessionOutput: () => `diff output ${++snapshotNum}`,
      getSessionForTopic: () => 'sess-1',
      isSessionAlive: () => true,
      getSessionEpoch: () => liveEpoch,
      sendMessage: async (_t, text) => { sent.push(text); },
      generateStatusLine: async () => 'progressing',
      classifyProgress: async () => 'stalled',
    });
    beacon.start();

    const c = tracker.record({
      type: 'one-time-action',
      userRequest: 'ship feature X',
      agentResponse: 'I will ship X and come back when it is live',
      topicId: 42,
      beaconEnabled: true,
      cadenceMs: 60_000,
      nextUpdateDueAt: '2099-01-01T00:00:00Z',
      sessionEpoch: liveEpoch,
    });

    // Phase 1 — beacon fires, classifier says stalled → atRisk.
    await beacon.fire(c.id);
    const afterSignal = tracker.getAll().find(x => x.id === c.id)!;
    expect(afterSignal.atRisk).toBe(true);
    expect(afterSignal.status).toBe('pending'); // Non-terminal — signal only.
    const atRiskHeartbeat = sent[sent.length - 1];
    expect(atRiskHeartbeat).toMatch(/idle|at-risk|no observable progress|no recent output/i);

    // Phase 2 — hard signal: session is reassigned (epoch changes). This is
    // the ONLY auto-transition to `violated` and is gated by authoritative
    // UUID mismatch, not by the signal.
    liveEpoch = 'EPOCH-B';
    await beacon.fire(c.id);
    const afterHardSignal = tracker.getAll().find(x => x.id === c.id)!;
    expect(afterHardSignal.status).toBe('violated');
    expect(afterHardSignal.resolution).toBe('session-lost');
    // User-visible terminal notice emitted.
    const lastMsg = sent[sent.length - 1];
    expect(lastMsg).toMatch(/violated|session-lost/);

    beacon.stop();
  });
});
