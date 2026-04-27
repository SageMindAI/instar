/**
 * Integration test — sentinel tone-gate recovery path.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § 3d step 3.
 *
 * Re-tone-gate is invoked on every recovery attempt. If the queued text
 * is rejected on re-send, the entry finalizes as `delivered-tone-gated`
 * AND the user receives the fixed-template meta-notice.
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
import { TEMPLATES } from '../../src/messaging/system-templates.js';

let stateDir: string;

beforeEach(() => {
  _resetCacheForTest();
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-tone-'));
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/integration/sentinel-tone-gate-recovery.test.ts:cleanup' });
});

describe('DeliveryFailureSentinel — tone-gate recovery', () => {
  it('queued text rejected on re-gate → tone-gated finalize + meta-notice on topic', async () => {
    const store = PendingRelayStore.open('echo', stateDir);
    const id = '33333333-3333-4333-8333-333333333333';
    store.enqueue({
      delivery_id: id,
      topic_id: 42,
      text_hash: 'c'.repeat(64),
      text: Buffer.from('npm install instar # debug', 'utf-8'),
      http_code: 503,
      attempted_port: 4042,
    });

    const calls: Array<{ topicId: number; text: string; isSystem: boolean }> = [];
    const postReply = vi.fn(async (
      _port: number,
      _token: string,
      _agentId: string,
      topicId: number,
      text: string,
      _deliveryId: string,
      isSystem = false,
    ) => {
      calls.push({ topicId, text, isSystem });
      return { status: 200, body: '{"ok":true}' };
    });

    // Stub tone gate: always rejects with rule B7 ("CLI command leaking")
    const toneGate = {
      review: vi.fn().mockResolvedValue({
        pass: false,
        rule: 'B7',
        issue: 'CLI command leaking to user',
        suggestion: 'Phrase as conversational text',
        latencyMs: 12,
      }),
    } as unknown as import('../../src/core/MessagingToneGate.js').MessagingToneGate;

    const whoamiCache = new WhoamiCache({ fetchFn: async () => ({ agentId: 'echo', port: 4042 }) });
    const bootId = getOrCreateBootId(stateDir, '0.28.0');

    const sentinel = new DeliveryFailureSentinel({
      store,
      configPath: path.join(stateDir, 'config.json'),
      readConfig: () => ({ port: 4042, authToken: 'tok', agentId: 'echo' }),
      bootId,
      toneGate,
      postReply,
      whoamiCache,
    });

    await sentinel.start();
    await sentinel.tick();

    const row = store.findByDeliveryId(id);
    expect(row?.state).toBe('delivered-tone-gated');

    // The ONLY postReply call should be the meta-notice template (system).
    // The queued original text must NOT be sent.
    expect(calls.length).toBe(1);
    expect(calls[0].text).toBe(TEMPLATES.toneGateRejection);
    expect(calls[0].topicId).toBe(42);
    expect(calls[0].isSystem).toBe(true);
    expect(calls.find((c) => c.text.includes('npm install'))).toBeUndefined();

    await sentinel.stop();
    store.close();
  });
});
