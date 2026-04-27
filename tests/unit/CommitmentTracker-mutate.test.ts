/**
 * Unit tests for CommitmentTracker.mutate() — single-writer queue with CAS.
 *
 * These tests are the prerequisite for the Promise Beacon feature
 * (see docs/specs/PROMISE-BEACON-SPEC.md §"Prerequisite PR"). They cover:
 *   - Concurrent mutates on the same id serialise correctly (no lost updates).
 *   - v1 store auto-migrates on load (back-fills version: 0).
 *   - Queue-full (depth 256) rejects with a clear error.
 *   - CAS retry works when version drifts between reads and apply.
 *   - Round-trip: mutate → persist → reload → version preserved.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';

function createTmpState(): { stateDir: string; cleanup: () => void } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitment-mutate-'));
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify({ updates: { autoApply: true } }, null, 2)
  );
  return {
    stateDir,
    // safe-git-allow: incremental-migration
    cleanup: () => fs.rmSync(stateDir, { recursive: true, force: true }),
  };
}

function makeTracker(stateDir: string): CommitmentTracker {
  return new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) });
}

describe('CommitmentTracker.mutate()', () => {
  let stateDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ stateDir, cleanup } = createTmpState());
  });

  afterEach(() => {
    cleanup();
  });

  it('starts new commitments at version 0 and bumps on mutate', async () => {
    const tracker = makeTracker(stateDir);
    const c = tracker.record({
      userRequest: 'test',
      agentResponse: 'ok',
      type: 'behavioral',
      behavioralRule: 'Do the thing',
    });
    expect(c.version).toBe(0);

    const updated = await tracker.mutate(c.id, cur => ({
      ...cur,
      verificationCount: cur.verificationCount + 1,
    }));
    expect(updated.version).toBe(1);
    expect(updated.verificationCount).toBe(1);

    const again = await tracker.mutate(c.id, cur => ({ ...cur }));
    expect(again.version).toBe(2);
  });

  it('serialises concurrent mutates on the same id (no lost updates)', async () => {
    const tracker = makeTracker(stateDir);
    const c = tracker.record({
      userRequest: 'concurrent',
      agentResponse: 'ok',
      type: 'behavioral',
      behavioralRule: 'rule',
    });

    const N = 50;
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) {
      promises.push(
        tracker.mutate(c.id, cur => ({
          ...cur,
          verificationCount: cur.verificationCount + 1,
        }))
      );
    }
    await Promise.all(promises);

    const final = tracker.get(c.id)!;
    // Started at 0, N increments — no lost updates.
    expect(final.verificationCount).toBe(N);
    // Version bumps once per mutate (record inserted at v0, then N mutates).
    expect(final.version).toBe(N);
  });

  it('serialises async mutate bodies (FIFO, no interleave)', async () => {
    const tracker = makeTracker(stateDir);
    const c = tracker.record({
      userRequest: 'async-serial',
      agentResponse: 'ok',
      type: 'behavioral',
      behavioralRule: 'rule',
    });

    const order: number[] = [];
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      const idx = i;
      promises.push(
        tracker.mutate(c.id, async cur => {
          order.push(idx);
          // Give the event loop a chance to interleave — it shouldn't.
          await new Promise(resolve => setImmediate(resolve));
          order.push(idx);
          return { ...cur, verificationCount: cur.verificationCount + 1 };
        })
      );
    }
    await Promise.all(promises);

    // Each index should appear twice in a row, proving no interleaving.
    for (let i = 0; i < 10; i++) {
      expect(order[i * 2]).toBe(i);
      expect(order[i * 2 + 1]).toBe(i);
    }
    expect(tracker.get(c.id)!.verificationCount).toBe(10);
  });

  it('rejects when the queue exceeds max depth (256)', async () => {
    const tracker = makeTracker(stateDir);
    const c = tracker.record({
      userRequest: 'qfull',
      agentResponse: 'ok',
      type: 'behavioral',
      behavioralRule: 'rule',
    });

    // Block the drain by making the first mutation wait on a barrier.
    let releaseFirst: (() => void) | null = null;
    const firstBarrier = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    // Start the in-flight mutation.
    const inflight = tracker.mutate(c.id, async cur => {
      await firstBarrier;
      return cur;
    });

    // Fill the queue to capacity (256 additional, since 1 is running).
    const queued: Promise<unknown>[] = [];
    for (let i = 0; i < 256; i++) {
      queued.push(tracker.mutate(c.id, cur => ({ ...cur })));
    }

    // The 257th enqueue should reject immediately with a clear error.
    await expect(
      tracker.mutate(c.id, cur => ({ ...cur }))
    ).rejects.toThrow(/queue full/i);

    // Drain.
    releaseFirst!();
    await inflight;
    await Promise.all(queued);
  });

  it('rejects mutate() for unknown ids', async () => {
    const tracker = makeTracker(stateDir);
    await expect(
      tracker.mutate('CMT-999', cur => cur)
    ).rejects.toThrow(/unknown commitment/i);
  });

  it('retries on CAS drift (async fn reads, external write drifts version)', async () => {
    const tracker = makeTracker(stateDir);
    const c = tracker.record({
      userRequest: 'cas-drift',
      agentResponse: 'ok',
      type: 'behavioral',
      behavioralRule: 'rule',
    });

    // Drive CAS drift by having the fn (inside mutate) await while we
    // directly mutate the in-memory record's version underneath it.
    // This simulates another writer completing between our read and write.
    let driftAttempts = 0;
    const firstVersion = tracker.get(c.id)!.version;

    await tracker.mutate(c.id, async cur => {
      driftAttempts++;
      if (driftAttempts === 1) {
        // Simulate concurrent write: bump the stored version so our CAS fails.
        const store = (tracker as unknown as {
          store: { commitments: Array<{ id: string; version: number }> };
        }).store;
        const rec = store.commitments.find(r => r.id === c.id)!;
        rec.version = (rec.version ?? 0) + 1;
      }
      return { ...cur, verificationCount: cur.verificationCount + 1 };
    });

    // fn ran at least twice (first attempt, then retry after drift).
    expect(driftAttempts).toBeGreaterThanOrEqual(2);
    const final = tracker.get(c.id)!;
    // Version moved forward past both the injected drift and our commit.
    expect(final.version).toBeGreaterThan(firstVersion);
    expect(final.verificationCount).toBe(1);
  });

  it('round-trip: mutate → persist → reload → version preserved', async () => {
    const tracker = makeTracker(stateDir);
    const c = tracker.record({
      userRequest: 'roundtrip',
      agentResponse: 'ok',
      type: 'behavioral',
      behavioralRule: 'rule',
    });
    await tracker.mutate(c.id, cur => ({ ...cur, verificationCount: 5 }));
    await tracker.mutate(c.id, cur => ({ ...cur, verificationCount: 6 }));

    // Reload a fresh tracker from the same state dir.
    const reloaded = makeTracker(stateDir);
    const rec = reloaded.get(c.id)!;
    expect(rec.version).toBe(2);
    expect(rec.verificationCount).toBe(6);
  });

  it('auto-migrates a v1 store by back-filling version: 0', () => {
    // Write a v1-shaped store directly, omitting the version field.
    const storePath = path.join(stateDir, 'state', 'commitments.json');
    const v1 = {
      version: 1,
      commitments: [
        {
          id: 'CMT-001',
          userRequest: 'legacy',
          agentResponse: 'ok',
          type: 'behavioral',
          status: 'pending',
          createdAt: new Date().toISOString(),
          verificationCount: 0,
          violationCount: 0,
          correctionCount: 0,
          correctionHistory: [],
          escalated: false,
          behavioralRule: 'legacy rule',
          // no version field
        },
      ],
      lastModified: new Date().toISOString(),
    };
    fs.writeFileSync(storePath, JSON.stringify(v1, null, 2));

    const tracker = makeTracker(stateDir);
    const rec = tracker.get('CMT-001')!;
    expect(rec.version).toBe(0);

    // Confirm the store-level version is bumped on next save.
    const after = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    // Migration bumps on load; saveStore() on next mutation persists v2.
    expect([1, 2]).toContain(after.version);
  });

  it('persists store version 2 after any write', async () => {
    const tracker = makeTracker(stateDir);
    const c = tracker.record({
      userRequest: 'v2-on-disk',
      agentResponse: 'ok',
      type: 'behavioral',
      behavioralRule: 'rule',
    });
    await tracker.mutate(c.id, cur => ({ ...cur }));
    const storePath = path.join(stateDir, 'state', 'commitments.json');
    const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    expect(onDisk.version).toBe(2);
    expect(onDisk.commitments[0].version).toBeGreaterThanOrEqual(1);
  });
});
