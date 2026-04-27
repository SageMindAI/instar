/**
 * Tests for CommitmentSweeper (Integrated-Being v2 slice 5).
 *
 * Covers expired-sweep and stranded-sweep, emission cadence,
 * idempotent re-runs (no duplicate note entries), and the batch limit.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { SharedStateLedger } from '../../src/core/SharedStateLedger.js';
import { LedgerSessionRegistry } from '../../src/core/LedgerSessionRegistry.js';
import { CommitmentSweeper } from '../../src/core/CommitmentSweeper.js';
import type { LedgerAppendPayload } from '../../src/core/SharedStateLedger.js';
import type { IntegratedBeingConfig } from '../../src/core/types.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'commitment-sweeper-test-'));
}
function uuid(): string {
  return crypto.randomUUID();
}
function makeConfig(over: Partial<IntegratedBeingConfig> = {}): IntegratedBeingConfig {
  return { enabled: true, v2Enabled: true, ...over };
}

async function seedCommitment(
  ledger: SharedStateLedger,
  over: Partial<LedgerAppendPayload> = {},
  commitmentOver: Partial<NonNullable<LedgerAppendPayload['commitment']>> = {},
): Promise<string | null> {
  const base: LedgerAppendPayload = {
    emittedBy: { subsystem: 'session', instance: uuid() },
    kind: 'commitment',
    subject: 'test commitment',
    counterparty: { type: 'self', name: 'self', trustTier: 'untrusted' },
    provenance: 'session-asserted',
    dedupKey: `commit-${Math.random().toString(36).slice(2, 10)}`,
    commitment: {
      mechanism: {
        type: 'scheduled-job',
        ref: 'job-1',
        refResolvedAt: new Date().toISOString(),
        refStatus: 'unverified',
      },
      status: 'open',
      ...commitmentOver,
    },
  };
  const merged = { ...base, ...over, commitment: { ...base.commitment!, ...commitmentOver } };
  const entry = await ledger.append(merged);
  return entry?.id ?? null;
}

describe('CommitmentSweeper', () => {
  let dir: string;
  let ledger: SharedStateLedger;
  let registry: LedgerSessionRegistry;

  beforeEach(() => {
    dir = tempDir();
    const cfg = makeConfig();
    ledger = new SharedStateLedger({ stateDir: dir, config: cfg, salt: 's' });
    registry = new LedgerSessionRegistry({ stateDir: dir, config: cfg });
  });

  afterEach(() => {
    ledger.shutdown();
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('sweepExpired', () => {
    it('emits a note for a commitment whose deadline has passed', async () => {
      // Past deadline — append bypasses route validation by calling ledger direct.
      const pastDeadline = new Date(Date.now() - 60_000).toISOString();
      const cid = await seedCommitment(ledger, {}, { deadline: pastDeadline });
      expect(cid).toBeTruthy();
      const sweeper = new CommitmentSweeper({
        ledger,
        registry,
        instance: 'test',
      });
      const result = await sweeper.sweepExpired();
      expect(result.emitted).toBe(1);
      const entries = await ledger.recent({ limit: 50 });
      const expiredNote = entries.find(
        (e) =>
          e.kind === 'note' &&
          e.supersedes === cid &&
          e.subject.startsWith('expired:'),
      );
      expect(expiredNote).toBeDefined();
      expect(expiredNote?.provenance).toBe('subsystem-asserted');
      expect(expiredNote?.emittedBy.subsystem).toBe('commitment-sweeper');
    });

    it('does not emit for commitments whose deadline has NOT passed', async () => {
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await seedCommitment(ledger, {}, { deadline: future });
      const sweeper = new CommitmentSweeper({
        ledger,
        registry,
        instance: 'test',
      });
      const result = await sweeper.sweepExpired();
      expect(result.emitted).toBe(0);
    });

    it('is idempotent — a second run does not emit another expired note', async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      const cid = await seedCommitment(ledger, {}, { deadline: past });
      const sweeper = new CommitmentSweeper({
        ledger,
        registry,
        instance: 'test',
      });
      const r1 = await sweeper.sweepExpired();
      expect(r1.emitted).toBe(1);
      const r2 = await sweeper.sweepExpired();
      // Second run finds the existing expired-note's supersedes pointer at cid
      // and skips. The dedupKey ALSO collides with the prior note's key, so
      // v1 dedup would block anyway — we assert the observed behavior.
      expect(r2.emitted).toBe(0);
      // And there is still exactly one expired note.
      const entries = await ledger.recent({ limit: 50 });
      const expired = entries.filter(
        (e) =>
          e.kind === 'note' &&
          e.supersedes === cid &&
          e.subject.startsWith('expired:'),
      );
      expect(expired.length).toBe(1);
    });

    it('respects batchLimit', async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      for (let i = 0; i < 5; i++) {
        await seedCommitment(
          ledger,
          { dedupKey: `bulk-${i}`, subject: `c${i}` },
          { deadline: past },
        );
      }
      const sweeper = new CommitmentSweeper({
        ledger,
        registry,
        instance: 'test',
        batchLimit: 2,
      });
      const r = await sweeper.sweepExpired();
      expect(r.emitted).toBe(2);
      expect(r.truncated).toBe(true);
    });

    it('skips commitments with no deadline (no expiry possible)', async () => {
      await seedCommitment(ledger);
      const sweeper = new CommitmentSweeper({ ledger, registry, instance: 'test' });
      const r = await sweeper.sweepExpired();
      expect(r.emitted).toBe(0);
    });
  });

  describe('sweepStranded', () => {
    it('emits a note for an open commitment whose creator session is purged', async () => {
      // Deadline far in the future so expired-sweep won't fire.
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const orphanSid = uuid();
      const cid = await seedCommitment(
        ledger,
        { emittedBy: { subsystem: 'session', instance: orphanSid } },
        { deadline: future },
      );
      // Creator session NOT in registry (we never registered orphanSid).

      // Use a clock override to simulate the commitment being > 24h old.
      let now = Date.now();
      // Advance now by 25h after seeding so the commitment is "stranded".
      now = now + 25 * 60 * 60 * 1000;
      const sweeper = new CommitmentSweeper({
        ledger,
        registry,
        instance: 'test',
        now: () => now,
      });
      const r = await sweeper.sweepStranded();
      expect(r.emitted).toBe(1);
      const entries = await ledger.recent({ limit: 50 });
      const stranded = entries.find(
        (e) =>
          e.kind === 'note' &&
          e.supersedes === cid &&
          e.subject.startsWith('stranded:'),
      );
      expect(stranded).toBeDefined();
      expect(stranded?.emittedBy.subsystem).toBe('commitment-sweeper');
    });

    it('skips commitments whose creator session is still active in the registry', async () => {
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const sid = uuid();
      registry.register(sid);
      const cid = await seedCommitment(
        ledger,
        { emittedBy: { subsystem: 'session', instance: sid } },
        { deadline: future },
      );
      expect(cid).toBeTruthy();
      let now = Date.now() + 48 * 60 * 60 * 1000;
      const sweeper = new CommitmentSweeper({
        ledger,
        registry,
        instance: 'test',
        now: () => now,
      });
      const r = await sweeper.sweepStranded();
      expect(r.emitted).toBe(0);
    });

    it('does not emit stranded-note for a commitment less than 24h old', async () => {
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const orphanSid = uuid();
      await seedCommitment(
        ledger,
        { emittedBy: { subsystem: 'session', instance: orphanSid } },
        { deadline: future },
      );
      const sweeper = new CommitmentSweeper({
        ledger,
        registry,
        instance: 'test',
      });
      const r = await sweeper.sweepStranded();
      expect(r.emitted).toBe(0);
    });
  });

  describe('start/stop', () => {
    it('stop() is safe when start() was never called', () => {
      const sweeper = new CommitmentSweeper({ ledger, registry, instance: 'test' });
      expect(() => sweeper.stop()).not.toThrow();
    });
  });
});
