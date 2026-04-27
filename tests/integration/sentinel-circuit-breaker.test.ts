/**
 * Integration test — sentinel circuit breaker.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § 3f.
 *
 * 5 consecutive escalation failures within 1h → suspended state.
 * Resume only on auth-relevant config-content-hash change.
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
import { TTL_MS } from '../../src/monitoring/delivery-failure-sentinel/recovery-policy.js';

let stateDir: string;

beforeEach(() => {
  _resetCacheForTest();
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-cb-'));
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/integration/sentinel-circuit-breaker.test.ts:cleanup' });
});

describe('DeliveryFailureSentinel — circuit breaker', () => {
  it('suspends after N consecutive escalation failures and resumes on auth-hash change', async () => {
    const store = PendingRelayStore.open('echo', stateDir);

    // Insert 5 entries already past TTL so each escalates immediately.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `${i.toString().padStart(8, '0')}-1111-4111-8111-111111111111`;
      ids.push(id);
      store.enqueue({
        delivery_id: id,
        topic_id: 100 + i,
        text_hash: i.toString().padStart(64, '0'),
        text: Buffer.from('msg', 'utf-8'),
        http_code: 503,
        attempted_port: 4042,
        attempted_at: new Date(Date.now() - TTL_MS - 1000).toISOString(),
      });
    }

    // postReply rejects every escalation send so each escalation is a failure.
    const postReply = vi.fn(async () => ({ status: 500, body: 'down' }));
    const whoamiCache = new WhoamiCache({ fetchFn: async () => ({ agentId: 'echo', port: 4042 }) });
    const bootId = getOrCreateBootId(stateDir, '0.28.0');

    let port = 4042;
    let token = 'tok-A';
    const sentinel = new DeliveryFailureSentinel(
      {
        store,
        configPath: path.join(stateDir, 'config.json'),
        readConfig: () => ({ port, authToken: token, agentId: 'echo' }),
        bootId,
        toneGate: null,
        postReply,
        whoamiCache,
      },
      {
        circuitBreakerCount: 5,
        circuitBreakerWindowMs: 60 * 60_000,
        // Disable the restore-purge for this test — we WANT entries past TTL.
        restorePurgeAgeMs: 365 * 24 * 60 * 60_000,
        // Drop the per-topic rate cap to 0 so we can drain all 5 entries
        // (each on a different topic) on a single tick.
        perTopicRateMs: 0,
      },
    );

    await sentinel.start();

    // Drive until breaker trips. Each tick processes max 4 entries (default
    // maxConcurrent), but escalation failures count even when the entries
    // span multiple ticks.
    for (let i = 0; i < 5 && !sentinel.isSuspended(); i++) {
      await sentinel.tick();
    }
    expect(sentinel.isSuspended()).toBe(true);

    // Tick while suspended — no further postReply invocations beyond what
    // already happened on the failing escalations.
    const callsBefore = postReply.mock.calls.length;
    await sentinel.tick();
    expect(postReply.mock.calls.length).toBe(callsBefore);

    // Rotate token (auth-hash change) → next tick should resume.
    token = 'tok-B';
    await sentinel.tick();
    expect(sentinel.isSuspended()).toBe(false);

    await sentinel.stop();
    store.close();
  }, 15_000);
});
