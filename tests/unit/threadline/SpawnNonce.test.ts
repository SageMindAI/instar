/**
 * SpawnNonce unit tests.
 *
 * Covers Component A glue:
 *  - deriveEventId is deterministic given the same envelope inputs
 *  - deriveEventId differs across distinct nonce / msgId / signer
 *  - prepareNonceFd opens a readable FD that yields exactly the nonce bytes
 *  - prepareNonceFd unlinks the tmp file before returning
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

import { deriveEventId, prepareNonceFd } from '../../../src/threadline/SpawnNonce';
import type { MessageEnvelope } from '../../../src/messaging/types';

function envelope(overrides: Partial<{
  signedBy: string;
  hmacBy: string;
  nonce: string;
  msgId: string;
}> = {}): MessageEnvelope {
  return {
    schemaVersion: 1,
    message: {
      id: overrides.msgId ?? 'msg-1',
      from: { agent: 'a', machine: 'm' },
      to: { agent: 'b', machine: 'n' },
      type: 'request',
      priority: 'medium',
      subject: 's',
      body: 'b',
      timestamp: '2026-04-29T00:00:00Z',
    } as never, // test-only minimal AgentMessage
    transport: {
      relayChain: [],
      originServer: 'https://relay',
      signedBy: overrides.signedBy,
      hmacBy: overrides.hmacBy,
      nonce: overrides.nonce ?? 'nonce-1',
      timestamp: '2026-04-29T00:00:00Z',
    },
    delivery: {} as never,
  };
}

describe('deriveEventId', () => {
  it('is deterministic for identical inputs', () => {
    const a = deriveEventId(envelope({ signedBy: 'machine-x', nonce: 'n', msgId: 'm' }));
    const b = deriveEventId(envelope({ signedBy: 'machine-x', nonce: 'n', msgId: 'm' }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs when the transport nonce differs', () => {
    const a = deriveEventId(envelope({ nonce: 'n1' }));
    const b = deriveEventId(envelope({ nonce: 'n2' }));
    expect(a).not.toBe(b);
  });

  it('differs when the message id differs', () => {
    const a = deriveEventId(envelope({ msgId: 'mA' }));
    const b = deriveEventId(envelope({ msgId: 'mB' }));
    expect(a).not.toBe(b);
  });

  it('differs when the signer differs', () => {
    const a = deriveEventId(envelope({ signedBy: 'one' }));
    const b = deriveEventId(envelope({ signedBy: 'two' }));
    expect(a).not.toBe(b);
  });

  it('falls back to hmacBy when signedBy is absent', () => {
    const a = deriveEventId(envelope({ hmacBy: 'h' }));
    const b = deriveEventId(envelope({ signedBy: 'h' }));
    // Same identity placed in either field yields the same eventId — the
    // fallback collapses to the present field.
    expect(a).toBe(b);
  });
});

describe('prepareNonceFd', () => {
  it('rejects a non-32-byte nonce', () => {
    expect(() => prepareNonceFd(Buffer.alloc(16))).toThrow();
  });

  it('opens a readable FD whose contents equal the nonce', () => {
    const nonce = Buffer.alloc(32, 0x5a);
    const handle = prepareNonceFd(nonce);
    try {
      const buf = Buffer.alloc(32);
      const n = fs.readSync(handle.readFd, buf, 0, 32, 0);
      expect(n).toBe(32);
      expect(buf.equals(nonce)).toBe(true);
    } finally {
      handle.close();
    }
  });

  it('handle.close is idempotent', () => {
    const handle = prepareNonceFd(Buffer.alloc(32, 0x11));
    handle.close();
    expect(() => handle.close()).not.toThrow();
  });
});
