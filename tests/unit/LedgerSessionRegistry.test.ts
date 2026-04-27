/**
 * Unit tests for LedgerSessionRegistry (Integrated-Being v2 slice 1).
 *
 * Covers register (issue/idempotent), verify (all failure reasons),
 * touchActivity, revoke, purgeExpired, listSessions, and persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { LedgerSessionRegistry } from '../../src/core/LedgerSessionRegistry.js';
import type { IntegratedBeingConfig } from '../../src/core/types.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-session-registry-test-'));
}

function uuid(): string {
  return crypto.randomUUID();
}

function makeConfig(over: Partial<IntegratedBeingConfig> = {}): IntegratedBeingConfig {
  return {
    enabled: true,
    v2Enabled: true,
    tokenAbsoluteTtlHours: 72,
    tokenIdleTtlHours: 24,
    sessionBindingRetentionDays: 7,
    ...over,
  };
}

describe('LedgerSessionRegistry', () => {
  let dir: string;
  let registry: LedgerSessionRegistry;

  beforeEach(() => {
    dir = tempDir();
    registry = new LedgerSessionRegistry({ stateDir: dir, config: makeConfig() });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('register', () => {
    it('issues a 32-byte hex token on first register', () => {
      const r = registry.register(uuid());
      expect(r.token).toMatch(/^[0-9a-f]{64}$/);
      expect(r.idempotentReplay).toBe(false);
    });

    it('returns same token on duplicate register within TTL (idempotent replay)', () => {
      const id = uuid();
      const first = registry.register(id);
      const second = registry.register(id);
      expect(second.token).toBe(first.token);
      expect(second.idempotentReplay).toBe(true);
    });

    it('rejects malformed sessionId', () => {
      expect(() => registry.register('not-a-uuid')).toThrow(/UUIDv4/);
      expect(() => registry.register('')).toThrow(/UUIDv4/);
    });

    it('absolute TTL is ANCHORED to registeredAt, not refresh-revived across restart', () => {
      // Simulated flow: register at t=0 with 2h absolute TTL, persist,
      // instantiate a new registry (simulating server restart — plaintext
      // token cache is lost), then re-register at t=90min with the same
      // sessionId. The new absoluteExpiresAt must equal original registeredAt
      // + 2h, NOT now + 2h. Closes the second-pass reviewer's concern.
      let now = 1_000_000_000;
      const cfg = makeConfig({ tokenAbsoluteTtlHours: 2, tokenIdleTtlHours: 1 });
      const reg1 = new LedgerSessionRegistry({
        stateDir: dir,
        config: cfg,
        now: () => now,
      });
      const sid = uuid();
      const first = reg1.register(sid);
      const firstAbs = new Date(first.absoluteExpiresAt).getTime();
      expect(firstAbs - now).toBe(2 * 60 * 60 * 1000);

      // Server "restart" — new registry instance, plaintext cache empty.
      now += 90 * 60 * 1000; // +90 min
      const reg2 = new LedgerSessionRegistry({
        stateDir: dir,
        config: cfg,
        now: () => now,
      });
      const second = reg2.register(sid);
      // New token (plaintext cache is empty post-restart), but anchored absolute
      // expiry is unchanged — the rebind did NOT extend the TTL window.
      expect(second.token).not.toBe(first.token);
      expect(new Date(second.absoluteExpiresAt).getTime()).toBe(firstAbs);
      expect(second.idempotentReplay).toBe(false);
    });

    it('throws when absolute TTL has fully elapsed (refuses same-sessionId rebind)', () => {
      let now = 1_000_000_000;
      const cfg = makeConfig({ tokenAbsoluteTtlHours: 1 });
      const reg1 = new LedgerSessionRegistry({
        stateDir: dir,
        config: cfg,
        now: () => now,
      });
      const sid = uuid();
      reg1.register(sid);
      now += 2 * 60 * 60 * 1000; // +2h, past absolute TTL

      const reg2 = new LedgerSessionRegistry({
        stateDir: dir,
        config: cfg,
        now: () => now,
      });
      expect(() => reg2.register(sid)).toThrow(/absolute TTL exhausted/);
    });

    it('computes absolute and idle expirations from config', () => {
      const cfg = makeConfig({ tokenAbsoluteTtlHours: 1, tokenIdleTtlHours: 1 });
      const reg = new LedgerSessionRegistry({ stateDir: dir, config: cfg });
      const before = Date.now();
      const r = reg.register(uuid());
      const abs = new Date(r.absoluteExpiresAt).getTime();
      const idle = new Date(r.idleExpiresAt).getTime();
      expect(abs - before).toBeGreaterThanOrEqual(60 * 60 * 1000 - 100);
      expect(abs - before).toBeLessThanOrEqual(60 * 60 * 1000 + 100);
      expect(idle - before).toBeGreaterThanOrEqual(60 * 60 * 1000 - 100);
    });
  });

  describe('verify', () => {
    it('accepts valid (sessionId, token)', () => {
      const id = uuid();
      const r = registry.register(id);
      const v = registry.verify(id, r.token);
      expect(v.ok).toBe(true);
    });

    it('rejects unknown session', () => {
      const v = registry.verify(uuid(), 'a'.repeat(64));
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toBe('unknown-session');
    });

    it('rejects token mismatch', () => {
      const id = uuid();
      registry.register(id);
      const v = registry.verify(id, 'b'.repeat(64));
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toBe('token-mismatch');
    });

    it('rejects revoked session', () => {
      const id = uuid();
      const r = registry.register(id);
      registry.revoke(id);
      const v = registry.verify(id, r.token);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toBe('revoked');
    });

    it('rejects when idle TTL has passed', () => {
      let now = 1_000_000;
      const cfg = makeConfig({ tokenIdleTtlHours: 1, tokenAbsoluteTtlHours: 24 });
      const reg = new LedgerSessionRegistry({
        stateDir: dir,
        config: cfg,
        now: () => now,
      });
      const id = uuid();
      const r = reg.register(id);
      now += 2 * 60 * 60 * 1000; // +2h, past idle
      const v = reg.verify(id, r.token);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toBe('idle-expired');
    });

    it('rejects when absolute TTL has passed', () => {
      let now = 1_000_000;
      const cfg = makeConfig({ tokenIdleTtlHours: 1, tokenAbsoluteTtlHours: 2 });
      const reg = new LedgerSessionRegistry({
        stateDir: dir,
        config: cfg,
        now: () => now,
      });
      const id = uuid();
      const r = reg.register(id);
      // Bump time past absolute TTL; note: idle also elapses, and the check
      // order is absolute-first, so reason is 'absolute-expired'.
      now += 3 * 60 * 60 * 1000;
      const v = reg.verify(id, r.token);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toBe('absolute-expired');
    });

    it('rejects malformed sessionId or token as malformed (not unknown-session)', () => {
      const v1 = registry.verify('not-a-uuid', 'x'.repeat(64));
      expect(v1.ok).toBe(false);
      if (!v1.ok) expect(v1.reason).toBe('malformed');

      const v2 = registry.verify(uuid(), 'short');
      expect(v2.ok).toBe(false);
      if (!v2.ok) expect(v2.reason).toBe('malformed');
    });
  });

  describe('touchActivity', () => {
    it('extends idleExpiresAt and flips hasWritten', () => {
      let now = 1_000_000;
      const cfg = makeConfig({ tokenIdleTtlHours: 2 });
      const reg = new LedgerSessionRegistry({
        stateDir: dir,
        config: cfg,
        now: () => now,
      });
      const id = uuid();
      reg.register(id);
      const r0 = reg._getRegistrationForTest(id)!;
      const idle0 = new Date(r0.idleExpiresAt).getTime();
      expect(r0.hasWritten).toBe(false);

      now += 60 * 60 * 1000; // +1h
      reg.touchActivity(id);
      const r1 = reg._getRegistrationForTest(id)!;
      expect(r1.hasWritten).toBe(true);
      expect(new Date(r1.idleExpiresAt).getTime()).toBeGreaterThan(idle0);
    });

    it('does not extend absolute TTL', () => {
      let now = 1_000_000;
      const cfg = makeConfig({ tokenIdleTtlHours: 1, tokenAbsoluteTtlHours: 2 });
      const reg = new LedgerSessionRegistry({
        stateDir: dir,
        config: cfg,
        now: () => now,
      });
      const id = uuid();
      reg.register(id);
      const abs0 = new Date(
        reg._getRegistrationForTest(id)!.absoluteExpiresAt
      ).getTime();

      now += 30 * 60 * 1000;
      reg.touchActivity(id);
      const abs1 = new Date(
        reg._getRegistrationForTest(id)!.absoluteExpiresAt
      ).getTime();
      expect(abs1).toBe(abs0);
    });
  });

  describe('revoke', () => {
    it('marks a session revoked', () => {
      const id = uuid();
      registry.register(id);
      expect(registry.revoke(id)).toBe(true);
      expect(registry._getRegistrationForTest(id)!.revoked).toBe(true);
    });

    it('returns false for unknown session', () => {
      expect(registry.revoke(uuid())).toBe(false);
    });

    it('is idempotent on double revoke', () => {
      const id = uuid();
      registry.register(id);
      expect(registry.revoke(id)).toBe(true);
      expect(registry.revoke(id)).toBe(true);
    });
  });

  describe('purgeExpired', () => {
    it('removes revoked sessions immediately', () => {
      const id = uuid();
      registry.register(id);
      registry.revoke(id);
      const purged = registry.purgeExpired();
      expect(purged).toBeGreaterThanOrEqual(1);
      expect(registry._getRegistrationForTest(id)).toBeUndefined();
    });

    it('removes never-written sessions past 1 day', () => {
      let now = 1_000_000;
      const reg = new LedgerSessionRegistry({
        stateDir: dir,
        config: makeConfig(),
        now: () => now,
      });
      const id = uuid();
      reg.register(id);
      now += 2 * 24 * 60 * 60 * 1000; // +2 days
      const purged = reg.purgeExpired();
      expect(purged).toBeGreaterThanOrEqual(1);
      expect(reg._getRegistrationForTest(id)).toBeUndefined();
    });

    it('keeps active sessions that have written', () => {
      let now = 1_000_000;
      const reg = new LedgerSessionRegistry({
        stateDir: dir,
        config: makeConfig(),
        now: () => now,
      });
      const id = uuid();
      reg.register(id);
      reg.touchActivity(id);
      now += 2 * 24 * 60 * 60 * 1000; // +2 days; still within retention + TTL
      const purged = reg.purgeExpired();
      expect(purged).toBe(0);
      expect(reg._getRegistrationForTest(id)).toBeDefined();
    });

    it('removes past-absolute-TTL sessions that are outside retention', () => {
      let now = 1_000_000;
      const cfg = makeConfig({
        tokenAbsoluteTtlHours: 1,
        sessionBindingRetentionDays: 1,
      });
      const reg = new LedgerSessionRegistry({
        stateDir: dir,
        config: cfg,
        now: () => now,
      });
      const id = uuid();
      reg.register(id);
      reg.touchActivity(id);
      // Past absolute TTL AND past 1 day retention.
      now += 3 * 24 * 60 * 60 * 1000;
      const purged = reg.purgeExpired();
      expect(purged).toBeGreaterThanOrEqual(1);
    });
  });

  describe('listSessions', () => {
    it('returns summaries without tokenHash', () => {
      const id = uuid();
      registry.register(id);
      const [s] = registry.listSessions();
      expect(s.sessionId).toBe(id);
      // Explicit: the summary shape does not carry tokenHash.
      expect(Object.prototype.hasOwnProperty.call(s, 'tokenHash')).toBe(false);
    });

    it('activeCount reflects non-revoked, non-expired sessions', () => {
      let now = 1_000_000;
      const reg = new LedgerSessionRegistry({
        stateDir: dir,
        config: makeConfig({ tokenAbsoluteTtlHours: 1 }),
        now: () => now,
      });
      const a = uuid();
      const b = uuid();
      reg.register(a);
      reg.register(b);
      expect(reg.activeCount()).toBe(2);
      reg.revoke(a);
      expect(reg.activeCount()).toBe(1);
      now += 2 * 60 * 60 * 1000; // +2h, past absolute TTL for b
      expect(reg.activeCount()).toBe(0);
    });
  });

  describe('rotate (slice 2)', () => {
    it('issues a new token and invalidates the old one', () => {
      const id = uuid();
      const first = registry.register(id);
      const rot = registry.rotate(id, first.token);
      expect(rot.ok).toBe(true);
      if (rot.ok) {
        expect(rot.result.token).not.toBe(first.token);
        // Old token no longer verifies.
        const v = registry.verify(id, first.token);
        expect(v.ok).toBe(false);
        if (!v.ok) expect(v.reason).toBe('token-mismatch');
        // New token does verify.
        const v2 = registry.verify(id, rot.result.token);
        expect(v2.ok).toBe(true);
      }
    });

    it('refuses rotation with wrong current token', () => {
      const id = uuid();
      registry.register(id);
      const rot = registry.rotate(id, 'a'.repeat(64));
      expect(rot.ok).toBe(false);
      if (!rot.ok) expect(rot.reason).toBe('token-mismatch');
    });

    it('preserves absolute expiry on rotation (does not extend)', () => {
      let now = 1_000_000_000;
      const cfg = makeConfig({ tokenAbsoluteTtlHours: 2, tokenIdleTtlHours: 1 });
      const reg = new LedgerSessionRegistry({
        stateDir: dir,
        config: cfg,
        now: () => now,
      });
      const id = uuid();
      const first = reg.register(id);
      const origAbs = new Date(first.absoluteExpiresAt).getTime();
      now += 30 * 60 * 1000; // +30min
      const rot = reg.rotate(id, first.token);
      expect(rot.ok).toBe(true);
      if (rot.ok) {
        expect(new Date(rot.result.absoluteExpiresAt).getTime()).toBe(origAbs);
      }
    });

    it('refuses rotation when absolute TTL has passed', () => {
      let now = 1_000_000_000;
      const cfg = makeConfig({ tokenAbsoluteTtlHours: 1, tokenIdleTtlHours: 2 });
      const reg = new LedgerSessionRegistry({
        stateDir: dir,
        config: cfg,
        now: () => now,
      });
      const id = uuid();
      const first = reg.register(id);
      now += 2 * 60 * 60 * 1000; // +2h, past absolute TTL
      const rot = reg.rotate(id, first.token);
      expect(rot.ok).toBe(false);
      if (!rot.ok) expect(rot.reason).toBe('absolute-expired');
    });
  });

  describe('hook-in-progress tracking (slice 2)', () => {
    it('markHookInProgress + isHookInProgress roundtrip', () => {
      const id = uuid();
      expect(registry.isHookInProgress(id)).toBe(false);
      registry.markHookInProgress(id);
      expect(registry.isHookInProgress(id)).toBe(true);
    });

    it('flag expires after 30 seconds', () => {
      let now = 1_000_000;
      const reg = new LedgerSessionRegistry({
        stateDir: dir,
        config: makeConfig(),
        now: () => now,
      });
      const id = uuid();
      reg.markHookInProgress(id);
      now += 31 * 1000;
      expect(reg.isHookInProgress(id)).toBe(false);
    });

    it('confirmHookDone clears the flag', () => {
      const id = uuid();
      registry.markHookInProgress(id);
      expect(registry.isHookInProgress(id)).toBe(true);
      registry.confirmHookDone(id);
      expect(registry.isHookInProgress(id)).toBe(false);
    });

    it('hasConfirmedHandoff reflects flag state', () => {
      const id = uuid();
      expect(registry.hasConfirmedHandoff(id)).toBe(false); // unregistered
      registry.register(id); // register() also marks hook-in-progress via the route; registry.register alone doesn't.
      expect(registry.hasConfirmedHandoff(id)).toBe(true); // registered, no pending flag
      registry.markHookInProgress(id);
      expect(registry.hasConfirmedHandoff(id)).toBe(false); // pending flag set
      registry.confirmHookDone(id);
      expect(registry.hasConfirmedHandoff(id)).toBe(true); // flag cleared
    });
  });

  describe('reissueForInteractive (slice 2 — fallback path)', () => {
    it('issues a new token against an existing registration', () => {
      const id = uuid();
      const first = registry.register(id);
      const reissue = registry.reissueForInteractive(id);
      expect(reissue.ok).toBe(true);
      if (reissue.ok) {
        expect(reissue.result.token).not.toBe(first.token);
        // Old token no longer verifies; new one does.
        expect(registry.verify(id, first.token).ok).toBe(false);
        expect(registry.verify(id, reissue.result.token).ok).toBe(true);
      }
    });

    it('preserves anchored absolute expiry', () => {
      let now = 1_000_000_000;
      const cfg = makeConfig({ tokenAbsoluteTtlHours: 2 });
      const reg = new LedgerSessionRegistry({
        stateDir: dir,
        config: cfg,
        now: () => now,
      });
      const id = uuid();
      const first = reg.register(id);
      const origAbs = new Date(first.absoluteExpiresAt).getTime();
      now += 30 * 60 * 1000;
      const reissue = reg.reissueForInteractive(id);
      expect(reissue.ok).toBe(true);
      if (reissue.ok) {
        expect(new Date(reissue.result.absoluteExpiresAt).getTime()).toBe(origAbs);
      }
    });

    it('refuses when session is unknown', () => {
      const reissue = registry.reissueForInteractive(uuid());
      expect(reissue.ok).toBe(false);
      if (!reissue.ok) expect(reissue.reason).toBe('unknown-session');
    });

    it('refuses when session is revoked', () => {
      const id = uuid();
      registry.register(id);
      registry.revoke(id);
      const reissue = registry.reissueForInteractive(id);
      expect(reissue.ok).toBe(false);
      if (!reissue.ok) expect(reissue.reason).toBe('revoked');
    });
  });

  describe('corrupt-hydrate degradation (slice 2 carry-forward)', () => {
    it('reports a degradation event on malformed registry file', () => {
      // Write garbage to the registry file path.
      const filePath = path.join(dir, 'ledger-sessions.json');
      fs.writeFileSync(filePath, '{not valid json', { mode: 0o600 });

      const reports: Array<{ feature?: string }> = [];
      const reporter = {
        report: (r: { feature?: string }) => { reports.push(r); },
      };

      // Instantiate — should report + start empty.
      const reg = new LedgerSessionRegistry({
        stateDir: dir,
        config: makeConfig(),
        degradationReporter: reporter as unknown as import('../../src/monitoring/DegradationReporter.js').DegradationReporter,
      });
      expect(reg.listSessions().length).toBe(0);
      expect(reports.length).toBe(1);
      expect(reports[0].feature).toBe('LedgerSessionRegistry');
    });
  });

  describe('persistence', () => {
    it('hydrates registrations across instances', () => {
      const id = uuid();
      const r = registry.register(id);

      const registry2 = new LedgerSessionRegistry({
        stateDir: dir,
        config: makeConfig(),
      });
      // Verify should still pass with the previously-issued token.
      const v = registry2.verify(id, r.token);
      expect(v.ok).toBe(true);
    });

    it('registry file is 0o600', () => {
      registry.register(uuid());
      const filePath = path.join(dir, 'ledger-sessions.json');
      const mode = fs.statSync(filePath).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('never persists plaintext token to disk', () => {
      const r = registry.register(uuid());
      const filePath = path.join(dir, 'ledger-sessions.json');
      const raw = fs.readFileSync(filePath, 'utf8');
      expect(raw).not.toContain(r.token);
      // And the hash IS in the file.
      const hash = crypto.createHash('sha256').update(r.token).digest('hex');
      expect(raw).toContain(hash);
    });
  });
});
