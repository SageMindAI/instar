/**
 * Integration test — sentinel recovery happy path.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § 3d, § 3e.
 *
 * Drives the full DeliveryFailureSentinel state machine against a real
 * PendingRelayStore (SQLite on disk). The HTTP transport (postReply,
 * /whoami fetcher) is stubbed because spinning two real Telegram-
 * connected AgentServers in CI exceeds reasonable test runtime — the
 * stubs are intentionally narrow and capture the same wire shape the
 * real path would exercise.
 *
 * What this test verifies (the bug-fix evidence bar from spec §6):
 *   1. A 503 enqueue → /whoami → POST /telegram/reply with delivery-id → 200.
 *   2. Row finalizes as `delivered-recovered`.
 *   3. Recovered marker fires ~2s later as a follow-up.
 *   4. `X-Instar-DeliveryId` is propagated on the recovery POST.
 *   5. `X-Instar-System: true` is set on the recovered marker (system template).
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
let configPath: string;

beforeEach(() => {
  _resetCacheForTest();
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-recovery-'));
  configPath = path.join(stateDir, 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ port: 4042, projectName: 'echo' }));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/integration/sentinel-recovery.test.ts:cleanup' });
});

describe('DeliveryFailureSentinel — recovery happy path', () => {
  it('queued 503 → recovery → delivered-recovered + recovered marker follow-up', async () => {
    const store = PendingRelayStore.open('echo', stateDir);
    const id = '11111111-1111-4111-8111-111111111111';
    store.enqueue({
      delivery_id: id,
      topic_id: 7,
      text_hash: 'a'.repeat(64),
      text: Buffer.from('hello user', 'utf-8'),
      http_code: 503,
      attempted_port: 4042,
    });

    const calls: Array<{ topicId: number; deliveryId: string; isSystem: boolean; text: string }> = [];
    const postReply = vi.fn(async (
      _port: number,
      _token: string,
      _agentId: string,
      topicId: number,
      text: string,
      deliveryId: string,
      isSystem = false,
    ) => {
      calls.push({ topicId, deliveryId, isSystem, text });
      return { status: 200, body: '{"ok":true}' };
    });

    const whoamiCache = new WhoamiCache({
      fetchFn: async () => ({ agentId: 'echo', port: 4042 }),
    });

    const bootId = getOrCreateBootId(stateDir, '0.28.0');
    const sentinel = new DeliveryFailureSentinel({
      store,
      configPath,
      readConfig: () => ({ port: 4042, authToken: 'tok', agentId: 'echo' }),
      bootId,
      toneGate: null,
      postReply,
      whoamiCache,
    });

    await sentinel.start();
    const counters = await sentinel.tick();
    expect(counters.recovered).toBe(1);

    const row = store.findByDeliveryId(id);
    expect(row?.state).toBe('delivered-recovered');

    // First call is the recovery POST.
    const first = calls[0];
    expect(first.topicId).toBe(7);
    expect(first.deliveryId).toBe(id);
    expect(first.isSystem).toBe(false);
    expect(first.text).toBe('hello user');

    // The recovered-marker fires ~2s later. We don't want to wait that
    // long in a test, so we verify the call was scheduled by waiting
    // briefly past 2s.
    await new Promise((r) => setTimeout(r, 2200));
    const marker = calls.find((c) => c.isSystem);
    expect(marker).toBeDefined();
    expect(marker!.text).toContain(id.slice(0, 8));

    await sentinel.stop();
    store.close();
  }, 10_000);

  it('agent_id mismatch → retry, queued state preserved', async () => {
    const store = PendingRelayStore.open('echo', stateDir);
    const id = '22222222-2222-4222-8222-222222222222';
    store.enqueue({
      delivery_id: id,
      topic_id: 8,
      text_hash: 'b'.repeat(64),
      text: Buffer.from('hello again', 'utf-8'),
      http_code: 503,
      attempted_port: 4042,
    });

    // /whoami returns a different agentId than config.
    const whoamiCache = new WhoamiCache({
      fetchFn: async () => ({ agentId: 'wrong-agent', port: 4042 }),
    });
    const postReply = vi.fn();

    const bootId = getOrCreateBootId(stateDir, '0.28.0');
    const sentinel = new DeliveryFailureSentinel({
      store,
      configPath,
      readConfig: () => ({ port: 4042, authToken: 'tok', agentId: 'echo' }),
      bootId,
      toneGate: null,
      postReply,
      whoamiCache,
    });

    await sentinel.start();
    await sentinel.tick();
    expect(postReply).not.toHaveBeenCalled();
    const row = store.findByDeliveryId(id);
    expect(row?.state).toBe('queued');
    expect(row?.next_attempt_at).toBeTruthy();
    expect(row?.attempts).toBe(2); // attempts incremented on retry decision

    await sentinel.stop();
    store.close();
  });
});
