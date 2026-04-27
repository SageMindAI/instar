/**
 * Wiring Integrity Tests for OverlapGuard
 *
 * Per TESTING-INTEGRITY-SPEC Category 1: "For every dependency-injected function, test that:
 *   1. It is not null/undefined when the feature is enabled
 *   2. It is not a no-op (calling it produces observable side effects)
 *   3. It delegates to the real implementation (not a stub)"
 *
 * These tests verify the OverlapGuard module uses real WorkLedger instances
 * backed by temp directories on disk. No mocking. Every assertion proves
 * that the wiring between OverlapGuard and WorkLedger is live — not stubbed,
 * not no-op'd, and not null.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkLedger } from '../../src/core/WorkLedger.js';
import {
  OverlapGuard,
  type OverlapGuardConfig,
  type OverlapCheckResult,
  type OverlapNotificationConfig,
} from '../../src/core/OverlapGuard.js';

// ── Helpers ─────────────────────────────────────────────────────────

function makeLedger(stateDir: string, machineId: string, userId?: string): WorkLedger {
  return new WorkLedger({ stateDir, machineId, userId });
}

function makeGuard(
  workLedger: WorkLedger,
  machineId: string,
  overrides?: Partial<Omit<OverlapGuardConfig, 'workLedger' | 'machineId'>>,
): OverlapGuard {
  return new OverlapGuard({
    workLedger,
    machineId,
    ...overrides,
  });
}

// ── Tests ───────────────────────────────────────────────────────────

describe('OverlapGuard wiring integrity', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlap-wiring-'));
    stateDir = path.join(tmpDir, '.instar');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. Construction — not null/undefined ────────────────────────────

  describe('construction — not null/undefined', () => {
    it('OverlapGuard is defined when constructed with valid config', () => {
      const ledger = makeLedger(stateDir, 'guard-machine');
      const guard = makeGuard(ledger, 'guard-machine');

      expect(guard).toBeDefined();
      expect(guard).not.toBeNull();
      expect(guard).toBeInstanceOf(OverlapGuard);
    });

    it('uses a real WorkLedger (not null) — ledger dir exists on disk', () => {
      const ledger = makeLedger(stateDir, 'guard-machine');
      makeGuard(ledger, 'guard-machine');

      // The WorkLedger constructor creates the ledger directory.
      // If the guard accepted a null ledger, this wouldn't exist.
      const ledgerDir = path.join(stateDir, 'state', 'ledger');
      expect(fs.existsSync(ledgerDir)).toBe(true);
      expect(fs.statSync(ledgerDir).isDirectory()).toBe(true);
    });
  });

  // ── 2. check() is functional (not a no-op) ─────────────────────────

  describe('check() is functional (not a no-op)', () => {
    it('returns action=log and canProceed=true when there is no overlap', () => {
      const ledger = makeLedger(stateDir, 'my-machine');
      const guard = makeGuard(ledger, 'my-machine');

      const result = guard.check({
        plannedFiles: ['src/foo.ts'],
        task: 'refactor foo',
      });

      expect(result.action).toBe('log');
      expect(result.canProceed).toBe(true);
      expect(result.maxTier).toBe(0);
      expect(result.warnings).toHaveLength(0);
      expect(result.architecturalConflicts).toHaveLength(0);
    });

    it('returns a different (higher-severity) result when overlap exists', () => {
      // Machine A writes an active entry to disk via its own WorkLedger
      const ledgerA = makeLedger(stateDir, 'machine-A', 'user-A');
      ledgerA.startWork({
        sessionId: 'AUT-500',
        task: 'modify shared file',
        filesPlanned: ['src/shared.ts'],
      });

      // Machine B's OverlapGuard checks against the same shared ledger dir
      // Use different userId so differentUsers action (default 'alert') applies
      const ledgerB = makeLedger(stateDir, 'machine-B', 'user-B');
      const guard = makeGuard(ledgerB, 'machine-B', { userId: 'user-B' });

      const result = guard.check({
        plannedFiles: ['src/shared.ts'],
        task: 'also modify shared file',
      });

      // Must be different from the no-overlap case — differentUsers defaults to 'alert'
      expect(result.action).toBe('alert');
      expect(result.maxTier).toBeGreaterThan(0);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('check() returns all required fields in OverlapCheckResult', () => {
      const ledger = makeLedger(stateDir, 'my-machine');
      const guard = makeGuard(ledger, 'my-machine');

      const result = guard.check({
        plannedFiles: ['src/any.ts'],
        task: 'any task',
      });

      expect(result).toHaveProperty('action');
      expect(result).toHaveProperty('maxTier');
      expect(result).toHaveProperty('warnings');
      expect(result).toHaveProperty('architecturalConflicts');
      expect(result).toHaveProperty('canProceed');
      expect(result).toHaveProperty('suggestion');
      expect(typeof result.action).toBe('string');
      expect(typeof result.maxTier).toBe('number');
      expect(Array.isArray(result.warnings)).toBe(true);
      expect(Array.isArray(result.architecturalConflicts)).toBe(true);
      expect(typeof result.canProceed).toBe('boolean');
      expect(typeof result.suggestion).toBe('string');
    });
  });

  // ── 3. Delegates to real WorkLedger ─────────────────────────────────

  describe('delegates to real WorkLedger on disk', () => {
    it('check() reads entries written by a second WorkLedger instance', () => {
      // Instance 1: write an active entry to disk
      const writerLedger = makeLedger(stateDir, 'writer-machine');
      writerLedger.startWork({
        sessionId: 'AUT-510',
        task: 'writing to disk',
        filesPlanned: ['lib/core.ts', 'lib/utils.ts'],
      });

      // Instance 2: completely separate WorkLedger feeding into OverlapGuard
      const readerLedger = makeLedger(stateDir, 'reader-machine');
      const guard = makeGuard(readerLedger, 'reader-machine');

      const result = guard.check({
        plannedFiles: ['lib/core.ts'],
        task: 'reading from disk',
      });

      // The guard must have found the writer's entry via the shared ledger dir
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].entry.machineId).toBe('writer-machine');
      expect(result.warnings[0].entry.sessionId).toBe('AUT-510');
      expect(result.warnings[0].overlappingFiles).toContain('lib/core.ts');
    });

    it('check() reflects updates made after initial write (not cached)', () => {
      const writerLedger = makeLedger(stateDir, 'writer-machine');
      const readerLedger = makeLedger(stateDir, 'reader-machine');
      const guard = makeGuard(readerLedger, 'reader-machine');

      // First: no overlap
      const entry = writerLedger.startWork({
        sessionId: 'AUT-511',
        task: 'initial task',
        filesPlanned: ['src/unrelated.ts'],
      });

      const before = guard.check({
        plannedFiles: ['src/target.ts'],
        task: 'my task',
      });
      expect(before.warnings).toHaveLength(0);

      // Now the writer updates to include the target file
      writerLedger.updateWork(entry.id, {
        filesPlanned: ['src/unrelated.ts', 'src/target.ts'],
      });

      const after = guard.check({
        plannedFiles: ['src/target.ts'],
        task: 'my task',
      });
      expect(after.warnings).toHaveLength(1);
      expect(after.warnings[0].overlappingFiles).toContain('src/target.ts');
    });

    it('check() stops detecting overlap after writer completes work', () => {
      const writerLedger = makeLedger(stateDir, 'writer-machine');
      const readerLedger = makeLedger(stateDir, 'reader-machine');
      const guard = makeGuard(readerLedger, 'reader-machine');

      const entry = writerLedger.startWork({
        sessionId: 'AUT-512',
        task: 'temporary work',
        filesPlanned: ['src/file.ts'],
      });

      // Overlap exists while active
      const during = guard.check({ plannedFiles: ['src/file.ts'], task: 'check' });
      expect(during.warnings).toHaveLength(1);

      // Writer completes — no longer active
      writerLedger.endWork(entry.id, 'completed');

      const after = guard.check({ plannedFiles: ['src/file.ts'], task: 'check' });
      expect(after.warnings).toHaveLength(0);
    });

    it('distinguishes tier 1 (planned) from tier 2 (actively modified) via real ledger', () => {
      const writerLedger = makeLedger(stateDir, 'writer-machine');
      const readerLedger = makeLedger(stateDir, 'reader-machine');
      const guard = makeGuard(readerLedger, 'reader-machine');

      const entry = writerLedger.startWork({
        sessionId: 'AUT-513',
        task: 'tier check',
        filesPlanned: ['src/tier.ts'],
      });

      // Tier 1: only planned, not yet modified
      const tier1 = guard.check({ plannedFiles: ['src/tier.ts'], task: 'tier check' });
      expect(tier1.maxTier).toBe(1);

      // Writer modifies the file
      writerLedger.updateWork(entry.id, { filesModified: ['src/tier.ts'] });

      // Tier 2: actively modified
      const tier2 = guard.check({ plannedFiles: ['src/tier.ts'], task: 'tier check' });
      expect(tier2.maxTier).toBe(2);
    });
  });

  // ── 4. detectArchitecturalConflicts is functional ───────────────────

  describe('detectArchitecturalConflicts is functional', () => {
    it('detects no conflict when tasks have opposing terms but no file overlap', () => {
      const writerLedger = makeLedger(stateDir, 'writer-machine');
      writerLedger.startWork({
        sessionId: 'AUT-520',
        task: 'add authentication',
        filesPlanned: ['src/auth/login.ts'],
      });

      const readerLedger = makeLedger(stateDir, 'reader-machine');
      const guard = makeGuard(readerLedger, 'reader-machine');

      // Opposing term ("remove" vs "add") but completely different directory trees
      // (findFileOverlap checks directory proximity, so different parent dirs needed)
      const conflicts = guard.detectArchitecturalConflicts(
        'remove authentication',
        ['lib/unrelated/widget.ts'],
      );

      expect(conflicts).toHaveLength(0);
    });

    it('detects no conflict when tasks have file overlap but no opposing terms', () => {
      const writerLedger = makeLedger(stateDir, 'writer-machine');
      writerLedger.startWork({
        sessionId: 'AUT-521',
        task: 'update the login page',
        filesPlanned: ['src/login.ts'],
      });

      const readerLedger = makeLedger(stateDir, 'reader-machine');
      const guard = makeGuard(readerLedger, 'reader-machine');

      // Same file, but tasks don't oppose each other
      const conflicts = guard.detectArchitecturalConflicts(
        'improve the login page',
        ['src/login.ts'],
      );

      expect(conflicts).toHaveLength(0);
    });

    it('detects conflict when tasks have BOTH file overlap AND opposing terms', () => {
      const writerLedger = makeLedger(stateDir, 'writer-machine');
      writerLedger.startWork({
        sessionId: 'AUT-522',
        task: 'add caching layer',
        filesPlanned: ['src/data-layer.ts'],
      });

      const readerLedger = makeLedger(stateDir, 'reader-machine');
      const guard = makeGuard(readerLedger, 'reader-machine');

      // Same file AND opposing terms (add vs remove)
      const conflicts = guard.detectArchitecturalConflicts(
        'remove caching layer',
        ['src/data-layer.ts'],
      );

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].opposingSignals).toContain('add↔remove');
      expect(conflicts[0].overlappingFiles).toContain('src/data-layer.ts');
      expect(conflicts[0].entryB.machineId).toBe('writer-machine');
      expect(conflicts[0].message).toBeTruthy();
    });

    it('detects conflict with directory-level proximity (same parent dir)', () => {
      const writerLedger = makeLedger(stateDir, 'writer-machine');
      writerLedger.startWork({
        sessionId: 'AUT-523',
        task: 'enable session-based auth',
        filesPlanned: ['src/auth/session.ts'],
      });

      const readerLedger = makeLedger(stateDir, 'reader-machine');
      const guard = makeGuard(readerLedger, 'reader-machine');

      // Different files but same directory, with opposing terms (session vs jwt)
      const conflicts = guard.detectArchitecturalConflicts(
        'switch to jwt tokens',
        ['src/auth/tokens.ts'],
      );

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].opposingSignals.length).toBeGreaterThan(0);
      // Directory-level overlap shows as "dir/*"
      expect(conflicts[0].overlappingFiles.some(f => f.includes('src/auth'))).toBe(true);
    });

    it('uses multiple opposition pattern pairs (not just add/remove)', () => {
      const writerLedger = makeLedger(stateDir, 'writer-machine');
      writerLedger.startWork({
        sessionId: 'AUT-524',
        task: 'migrate to graphql endpoint',
        filesPlanned: ['src/api/handler.ts'],
      });

      const readerLedger = makeLedger(stateDir, 'reader-machine');
      const guard = makeGuard(readerLedger, 'reader-machine');

      const conflicts = guard.detectArchitecturalConflicts(
        'standardize rest endpoint',
        ['src/api/handler.ts'],
      );

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].opposingSignals).toContain('rest↔graphql');
    });

    it('architectural conflict elevates check() to tier 3', () => {
      const writerLedger = makeLedger(stateDir, 'writer-machine');
      writerLedger.startWork({
        sessionId: 'AUT-525',
        task: 'add caching to data layer',
        filesPlanned: ['src/data.ts'],
      });

      const readerLedger = makeLedger(stateDir, 'reader-machine');
      const guard = makeGuard(readerLedger, 'reader-machine');

      const result = guard.check({
        plannedFiles: ['src/data.ts'],
        task: 'remove caching from data layer',
      });

      expect(result.maxTier).toBe(3);
      expect(result.architecturalConflicts.length).toBeGreaterThan(0);
    });

    it('excludes own machine entries from architectural conflict detection', () => {
      const myMachine = 'same-machine';
      const ledger = makeLedger(stateDir, myMachine);
      ledger.startWork({
        sessionId: 'AUT-526',
        task: 'add feature X',
        filesPlanned: ['src/feature.ts'],
      });

      const guard = makeGuard(ledger, myMachine);

      // Own machine's entry should be excluded even with opposing terms
      const conflicts = guard.detectArchitecturalConflicts(
        'remove feature X',
        ['src/feature.ts'],
      );

      expect(conflicts).toHaveLength(0);
    });
  });

  // ── 5. Notification config propagation ──────────────────────────────

  describe('notification config propagation', () => {
    it('default config: sameUser=log, differentUsers=alert, architecturalConflict=block', () => {
      const writerLedger = makeLedger(stateDir, 'writer-machine');
      writerLedger.startWork({
        sessionId: 'AUT-530',
        task: 'add caching',
        filesPlanned: ['src/cache.ts'],
      });

      // Same user, different machine — defaults apply
      const readerLedger = makeLedger(stateDir, 'reader-machine');
      const guard = makeGuard(readerLedger, 'reader-machine');

      // Tier 1/2 with no userId configured defaults to sameUser = 'log'
      const tierResult = guard.check({
        plannedFiles: ['src/cache.ts'],
        task: 'also touch cache',
      });
      // No userId set → isSameUserOverlap returns true → sameUser action → 'log'
      expect(tierResult.action).toBe('log');

      // Architectural conflict defaults to 'block'
      const archResult = guard.check({
        plannedFiles: ['src/cache.ts'],
        task: 'remove caching',
      });
      expect(archResult.action).toBe('block');
      expect(archResult.canProceed).toBe(false);
    });

    it('custom config overrides: sameUser=alert changes tier 1/2 action for same user', () => {
      const writerLedger = makeLedger(stateDir, 'writer-machine', 'user-A');
      writerLedger.startWork({
        sessionId: 'AUT-531',
        task: 'work on shared',
        filesPlanned: ['src/shared.ts'],
      });

      const readerLedger = makeLedger(stateDir, 'reader-machine', 'user-A');
      const guard = makeGuard(readerLedger, 'reader-machine', {
        userId: 'user-A',
        notification: { sameUser: 'alert' },
      });

      const result = guard.check({
        plannedFiles: ['src/shared.ts'],
        task: 'also work on shared',
      });

      // Same user (both user-A) with sameUser overridden to 'alert'
      expect(result.action).toBe('alert');
    });

    it('custom config overrides: differentUsers=block changes tier 1/2 action for different users', () => {
      const writerLedger = makeLedger(stateDir, 'writer-machine', 'user-A');
      writerLedger.startWork({
        sessionId: 'AUT-532',
        task: 'work on shared',
        filesPlanned: ['src/shared.ts'],
      });

      const readerLedger = makeLedger(stateDir, 'reader-machine', 'user-B');
      const guard = makeGuard(readerLedger, 'reader-machine', {
        userId: 'user-B',
        notification: { differentUsers: 'block' },
      });

      const result = guard.check({
        plannedFiles: ['src/shared.ts'],
        task: 'also work on shared',
      });

      // Different users with differentUsers overridden to 'block'
      expect(result.action).toBe('block');
      expect(result.canProceed).toBe(false);
    });

    it('custom config overrides: architecturalConflict=log downgrades tier 3', () => {
      const writerLedger = makeLedger(stateDir, 'writer-machine');
      writerLedger.startWork({
        sessionId: 'AUT-533',
        task: 'add websocket support',
        filesPlanned: ['src/transport.ts'],
      });

      const readerLedger = makeLedger(stateDir, 'reader-machine');
      const guard = makeGuard(readerLedger, 'reader-machine', {
        notification: { architecturalConflict: 'log' },
      });

      const result = guard.check({
        plannedFiles: ['src/transport.ts'],
        task: 'implement polling transport',
      });

      // Architectural conflict with architecturalConflict overridden to 'log'
      expect(result.maxTier).toBe(3);
      expect(result.action).toBe('log');
      expect(result.canProceed).toBe(true);
    });

    it('all three tiers have independently configurable actions', () => {
      const writerLedger = makeLedger(stateDir, 'writer-machine', 'user-X');
      writerLedger.startWork({
        sessionId: 'AUT-534',
        task: 'create endpoints',
        filesPlanned: ['src/api.ts'],
      });

      const readerLedger = makeLedger(stateDir, 'reader-machine', 'user-Y');

      // Configure all three tiers to non-default values
      const guard = makeGuard(readerLedger, 'reader-machine', {
        userId: 'user-Y',
        notification: {
          sameUser: 'block',
          differentUsers: 'log',
          architecturalConflict: 'alert',
        },
      });

      // Different user overlap — should use differentUsers='log'
      const overlapResult = guard.check({
        plannedFiles: ['src/api.ts'],
        task: 'update endpoints',
      });
      expect(overlapResult.action).toBe('log');

      // Architectural conflict — should use architecturalConflict='alert'
      const archResult = guard.check({
        plannedFiles: ['src/api.ts'],
        task: 'delete endpoints',
      });
      expect(archResult.action).toBe('alert');
    });
  });

  // ── 6. Callback wiring ──────────────────────────────────────────────

  describe('callback wiring', () => {
    it('onAlert receives a real OverlapCheckResult when action is alert', () => {
      const writerLedger = makeLedger(stateDir, 'writer-machine');
      writerLedger.startWork({
        sessionId: 'AUT-540',
        task: 'work on feature',
        filesPlanned: ['src/feature.ts'],
      });

      const readerLedger = makeLedger(stateDir, 'reader-machine');
      let capturedResult: OverlapCheckResult | null = null;

      const guard = makeGuard(readerLedger, 'reader-machine', {
        // Default differentUsers='alert' but no userId → sameUser='log'
        // So we need differentUsers scenario: use userIds
        userId: 'user-B',
        notification: { differentUsers: 'alert' },
        onAlert: (result) => {
          capturedResult = result;
        },
      });

      // The writer entry has no userId, so guard treats it as different user
      // Actually, WorkLedger entry userId comes from the WorkLedger config
      // Writer has no userId configured, reader has userId='user-B'
      // isSameUserOverlap checks: entry.userId is undefined → returns true (assumes same user)
      // So we need the writer to have a different userId
      // Let's reconfigure with explicit userId on writer

      // Reset
      // safe-git-allow: incremental-migration
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.mkdirSync(tmpDir, { recursive: true });

      const writerLedger2 = makeLedger(stateDir, 'writer-machine', 'user-A');
      writerLedger2.startWork({
        sessionId: 'AUT-540b',
        task: 'work on feature',
        filesPlanned: ['src/feature.ts'],
      });

      const readerLedger2 = makeLedger(stateDir, 'reader-machine', 'user-B');
      capturedResult = null;

      const guard2 = makeGuard(readerLedger2, 'reader-machine', {
        userId: 'user-B',
        notification: { differentUsers: 'alert' },
        onAlert: (result) => {
          capturedResult = result;
        },
      });

      const result = guard2.check({
        plannedFiles: ['src/feature.ts'],
        task: 'also work on feature',
      });

      expect(result.action).toBe('alert');
      expect(capturedResult).not.toBeNull();
      expect(capturedResult!.action).toBe('alert');
      expect(capturedResult!.warnings.length).toBeGreaterThan(0);
      expect(capturedResult!.maxTier).toBeGreaterThan(0);
      // The callback received the same object as the return value
      expect(capturedResult).toBe(result);
    });

    it('onBlock receives a real OverlapCheckResult when action is block', () => {
      const writerLedger = makeLedger(stateDir, 'writer-machine');
      writerLedger.startWork({
        sessionId: 'AUT-541',
        task: 'add caching',
        filesPlanned: ['src/cache.ts'],
      });

      const readerLedger = makeLedger(stateDir, 'reader-machine');
      let capturedResult: OverlapCheckResult | null = null;

      const guard = makeGuard(readerLedger, 'reader-machine', {
        // Default architecturalConflict='block'
        onBlock: (result) => {
          capturedResult = result;
        },
      });

      const result = guard.check({
        plannedFiles: ['src/cache.ts'],
        task: 'remove caching',
      });

      expect(result.action).toBe('block');
      expect(result.canProceed).toBe(false);
      expect(capturedResult).not.toBeNull();
      expect(capturedResult!.action).toBe('block');
      expect(capturedResult!.architecturalConflicts.length).toBeGreaterThan(0);
      expect(capturedResult!.maxTier).toBe(3);
      // Same reference
      expect(capturedResult).toBe(result);
    });

    it('onAlert does NOT fire for log-level results', () => {
      const ledger = makeLedger(stateDir, 'my-machine');
      let alertFired = false;

      const guard = makeGuard(ledger, 'my-machine', {
        onAlert: () => {
          alertFired = true;
        },
      });

      // No overlap → action=log
      const result = guard.check({
        plannedFiles: ['src/isolated.ts'],
        task: 'safe task',
      });

      expect(result.action).toBe('log');
      expect(alertFired).toBe(false);
    });

    it('onBlock does NOT fire for log-level results', () => {
      const ledger = makeLedger(stateDir, 'my-machine');
      let blockFired = false;

      const guard = makeGuard(ledger, 'my-machine', {
        onBlock: () => {
          blockFired = true;
        },
      });

      // No overlap → action=log
      const result = guard.check({
        plannedFiles: ['src/isolated.ts'],
        task: 'safe task',
      });

      expect(result.action).toBe('log');
      expect(blockFired).toBe(false);
    });

    it('onBlock does NOT fire for alert-level results', () => {
      const writerLedger = makeLedger(stateDir, 'writer-machine', 'user-A');
      writerLedger.startWork({
        sessionId: 'AUT-542',
        task: 'work on shared',
        filesPlanned: ['src/shared.ts'],
      });

      const readerLedger = makeLedger(stateDir, 'reader-machine', 'user-B');
      let blockFired = false;
      let alertFired = false;

      const guard = makeGuard(readerLedger, 'reader-machine', {
        userId: 'user-B',
        notification: { differentUsers: 'alert' },
        onAlert: () => {
          alertFired = true;
        },
        onBlock: () => {
          blockFired = true;
        },
      });

      const result = guard.check({
        plannedFiles: ['src/shared.ts'],
        task: 'also work on shared',
      });

      expect(result.action).toBe('alert');
      expect(alertFired).toBe(true);
      expect(blockFired).toBe(false);
    });

    it('onAlert does NOT fire for block-level results', () => {
      const writerLedger = makeLedger(stateDir, 'writer-machine');
      writerLedger.startWork({
        sessionId: 'AUT-543',
        task: 'enable polling',
        filesPlanned: ['src/transport.ts'],
      });

      const readerLedger = makeLedger(stateDir, 'reader-machine');
      let alertFired = false;
      let blockFired = false;

      const guard = makeGuard(readerLedger, 'reader-machine', {
        onAlert: () => {
          alertFired = true;
        },
        onBlock: () => {
          blockFired = true;
        },
      });

      const result = guard.check({
        plannedFiles: ['src/transport.ts'],
        task: 'switch to websocket',
      });

      expect(result.action).toBe('block');
      expect(blockFired).toBe(true);
      expect(alertFired).toBe(false);
    });
  });
});
