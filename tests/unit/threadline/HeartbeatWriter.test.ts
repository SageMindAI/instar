/**
 * HeartbeatWriter unit tests.
 *
 * Covers Component B writer-side invariants:
 *  - 32-byte nonce required
 *  - Atomic-rename leaves a complete file (no half-writes visible)
 *  - Canonical payload string is stable across calls
 *  - HMAC envelope round-trips through the watchdog's expected shape
 *  - readSpawnNonceFromFd3 returns null when FD 3 is absent or wrong length
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  HeartbeatWriter,
  canonicalHeartbeatPayload,
  readSpawnNonceFromFd3,
  defaultSessionsDir,
} from '../../../src/threadline/HeartbeatWriter';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-writer-test-'));
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/threadline/HeartbeatWriter.test.ts' });
});

describe('canonicalHeartbeatPayload', () => {
  it('returns a stable string with locked field order', () => {
    const s = canonicalHeartbeatPayload({
      eventId: 'e',
      sessionPid: 42,
      threadId: 't',
      ts: 1000,
    });
    expect(s).toBe('evt:e:pid:42:tid:t:ts:1000');
  });
});

describe('HeartbeatWriter', () => {
  const nonce = Buffer.alloc(32, 0xaa);

  it('rejects construction without a 32-byte nonce', () => {
    expect(
      () =>
        new HeartbeatWriter({
          sessionsDir: tmpDir,
          spawnNonce: Buffer.alloc(31),
          eventId: 'e',
          threadId: 't',
        }),
    ).toThrow();
  });

  it('writes a complete envelope at the expected path', () => {
    const w = new HeartbeatWriter({
      sessionsDir: tmpDir,
      spawnNonce: nonce,
      eventId: 'e1',
      threadId: 'thr1',
    });
    const env = w.write(12345);
    const onDisk = JSON.parse(fs.readFileSync(w.path, 'utf8'));
    expect(onDisk.eventId).toBe('e1');
    expect(onDisk.threadId).toBe('thr1');
    expect(onDisk.ts).toBe(12345);
    expect(onDisk.hmac).toBe(env.hmac);
  });

  it('hmac matches the canonical payload signed with the nonce', () => {
    const w = new HeartbeatWriter({
      sessionsDir: tmpDir,
      spawnNonce: nonce,
      eventId: 'e2',
      threadId: 'thr2',
      sessionPid: 99,
    });
    const env = w.write(5000);
    const expected = crypto
      .createHmac('sha256', nonce)
      .update('evt:e2:pid:99:tid:thr2:ts:5000')
      .digest('hex');
    expect(env.hmac).toBe(expected);
  });

  it('atomic-rename: no .tmp files visible after write', () => {
    const w = new HeartbeatWriter({
      sessionsDir: tmpDir,
      spawnNonce: nonce,
      eventId: 'e',
      threadId: 't',
    });
    w.write();
    const tmps = fs.readdirSync(tmpDir).filter((n) => n.endsWith('.tmp'));
    expect(tmps).toEqual([]);
  });
});

describe('readSpawnNonceFromFd3', () => {
  it('returns null when FD 3 is not open (test runner has no FD 3)', () => {
    // Vitest does not bind FD 3 to a 32-byte pipe by default.
    expect(readSpawnNonceFromFd3()).toBeNull();
  });
});

describe('defaultSessionsDir', () => {
  it('returns the spec-mandated path', () => {
    expect(defaultSessionsDir('/x')).toBe('/x/threadline/sessions');
  });
});
