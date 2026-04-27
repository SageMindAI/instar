/**
 * Integration test — stampede digest.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § 3c.
 *
 * When > 5 entries are recoverable on the same topic on the same tick,
 * the sentinel sends ONE digest message and drops the rest with
 * `delivered-ambiguous` state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import os from 'node:os';
import path from 'node:path';
import { PendingRelayStore } from '../../src/messaging/pending-relay-store.js';
import { DeliveryFailureSentinel } from '../../src/monitoring/delivery-failure-sentinel.js';
import { WhoamiCache } from '../../src/messaging/whoami-cache.js';
import { getOrCreateBootId, _resetCacheForTest } from '../../src/server/boot-id.js';

let stateDir: string;

beforeEach(() => {
  _resetCacheForTest();
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-stampede-'));
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/integration/sentinel-stampede-digest.test.ts:cleanup' });
});

describe('DeliveryFailureSentinel — stampede digest', () => {
  it('6 entries on same topic → 1 digest, others dropped as delivered-ambiguous', async () => {
    const store = PendingRelayStore.open('echo', stateDir);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = `${i.toString().padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
      ids.push(id);
      store.enqueue({
        delivery_id: id,
        topic_id: 99,
        text_hash: i.toString().padStart(64, '0'),
        text: Buffer.from(`message ${i}`, 'utf-8'),
        http_code: 503,
        attempted_port: 4042,
        // Stagger attempted_at so [last] is most-recent.
        attempted_at: new Date(Date.now() - (6 - i) * 1000).toISOString(),
      });
    }

    const calls: Array<{ text: string; isSystem: boolean }> = [];
    const postReply = vi.fn(async (
      _port: number,
      _token: string,
      _agentId: string,
      _topicId: number,
      text: string,
      _deliveryId: string,
      isSystem = false,
    ) => {
      calls.push({ text, isSystem });
      return { status: 200, body: '{"ok":true}' };
    });
    const whoamiCache = new WhoamiCache({ fetchFn: async () => ({ agentId: 'echo', port: 4042 }) });
    const bootId = getOrCreateBootId(stateDir, '0.28.0');

    const sentinel = new DeliveryFailureSentinel(
      {
        store,
        configPath: path.join(stateDir, 'config.json'),
        readConfig: () => ({ port: 4042, authToken: 'tok', agentId: 'echo' }),
        bootId,
        toneGate: null,
        postReply,
        whoamiCache,
      },
      { stampedeThreshold: 5 },
    );

    await sentinel.start();
    await sentinel.tick();

    // The digest is one of the calls (system template, "6 replies queued").
    const digest = calls.find((c) => c.isSystem && /6 replies queued/.test(c.text));
    expect(digest).toBeDefined();

    // Of the 6 entries: 5 dropped to `delivered-ambiguous`, the last (most
    // recent) actually delivered.
    const states = ids.map((id) => store.findByDeliveryId(id)?.state);
    const recoveredCount = states.filter((s) => s === 'delivered-recovered').length;
    const droppedCount = states.filter((s) => s === 'delivered-ambiguous').length;
    expect(recoveredCount).toBe(1);
    expect(droppedCount).toBe(5);

    await sentinel.stop();
    store.close();
  }, 10_000);
});
