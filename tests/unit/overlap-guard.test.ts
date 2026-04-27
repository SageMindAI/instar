/**
 * Unit + Semantic Correctness tests for OverlapGuard.
 *
 * Tests the tiered overlap detection, architectural conflict heuristics,
 * multi-user notification routing, callbacks, and custom configuration.
 *
 * Uses REAL WorkLedger instances (not mocks) to ensure wiring integrity.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkLedger } from '../../src/core/WorkLedger.js';
import { OverlapGuard } from '../../src/core/OverlapGuard.js';
import type { OverlapCheckResult, OverlapAction } from '../../src/core/OverlapGuard.js';

// ── Test Helpers ──────────────────────────────────────────────────────

let tmpDir: string;
let stateDir: string;
let myLedger: WorkLedger;
let otherLedger: WorkLedger;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlap-guard-'));
  stateDir = path.join(tmpDir, '.instar');
  myLedger = new WorkLedger({ stateDir, machineId: 'machine-a' });
  otherLedger = new WorkLedger({ stateDir, machineId: 'machine-b' });
});

afterEach(() => {
  // safe-git-allow: incremental-migration
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeGuard(overrides: Partial<Parameters<typeof OverlapGuard.prototype.check>[0]> & {
  userId?: string;
  notification?: Partial<import('../../src/core/OverlapGuard.js').OverlapNotificationConfig>;
  oppositionPatterns?: Array<[string, string]>;
  onAlert?: (result: OverlapCheckResult) => void;
  onBlock?: (result: OverlapCheckResult) => void;
} = {}) {
  return new OverlapGuard({
    workLedger: myLedger,
    machineId: 'machine-a',
    userId: overrides.userId,
    notification: overrides.notification,
    oppositionPatterns: overrides.oppositionPatterns,
    onAlert: overrides.onAlert,
    onBlock: overrides.onBlock,
  });
}

// ── Tier 0: No Overlap ───────────────────────────────────────────────

describe('OverlapGuard', () => {
  describe('Tier 0 — No overlap', () => {
    it('returns action log, maxTier 0, canProceed true when no other machines working', () => {
      const guard = makeGuard();

      const result = guard.check({
        plannedFiles: ['src/auth.ts', 'src/config.ts'],
        task: 'Implementing OAuth2',
      });

      expect(result.action).toBe('log');
      expect(result.maxTier).toBe(0);
      expect(result.canProceed).toBe(true);
      expect(result.warnings).toHaveLength(0);
      expect(result.architecturalConflicts).toHaveLength(0);
    });

    it('returns Tier 0 when other machine works on different files', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Working on database',
        filesPlanned: ['src/db.ts', 'src/models.ts'],
      });

      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: ['src/auth.ts', 'src/config.ts'],
        task: 'Implementing OAuth2',
      });

      expect(result.maxTier).toBe(0);
      expect(result.action).toBe('log');
      expect(result.canProceed).toBe(true);
    });

    it('suggestion says "Safe to proceed"', () => {
      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Some task',
      });

      expect(result.suggestion).toContain('Safe to proceed');
    });
  });

  // ── Tier 1: Planned Overlap ──────────────────────────────────────

  describe('Tier 1 — Planned overlap', () => {
    it('detects planned file overlap with other machine', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Planning auth refactor',
        filesPlanned: ['src/auth.ts', 'src/routes.ts'],
      });

      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Adding login feature',
      });

      expect(result.maxTier).toBe(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].tier).toBe(1);
      expect(result.warnings[0].overlappingFiles).toContain('src/auth.ts');
    });

    it('default same-user action is log', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Planning auth refactor',
        filesPlanned: ['src/auth.ts'],
      });

      // No userId set on either side -> assumes same user -> 'log'
      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Adding login feature',
      });

      expect(result.action).toBe('log');
      expect(result.canProceed).toBe(true);
    });

    it('suggestion mentions task branch', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Planning auth refactor',
        filesPlanned: ['src/auth.ts'],
      });

      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Adding login feature',
      });

      expect(result.suggestion).toContain('task branch');
    });
  });

  // ── Tier 2: Active Overlap ──────────────────────────────────────

  describe('Tier 2 — Active overlap', () => {
    it('detects modified file overlap', () => {
      const entry = otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Modifying auth',
        filesPlanned: ['src/auth.ts'],
      });
      otherLedger.updateWork(entry.id, { filesModified: ['src/auth.ts'] });

      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Also touching auth',
      });

      expect(result.maxTier).toBe(2);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].tier).toBe(2);
    });

    it('default different-user action is alert', () => {
      // Set userId on the other ledger's entry
      const otherWithUser = new WorkLedger({
        stateDir,
        machineId: 'machine-b',
        userId: 'bob',
      });
      const entry = otherWithUser.startWork({
        sessionId: 'AUT-200',
        task: 'Modifying auth',
        filesPlanned: ['src/auth.ts'],
      });
      otherWithUser.updateWork(entry.id, { filesModified: ['src/auth.ts'] });

      // Guard with different userId
      const guard = new OverlapGuard({
        workLedger: myLedger,
        machineId: 'machine-a',
        userId: 'alice',
      });

      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Also touching auth',
      });

      expect(result.action).toBe('alert');
      expect(result.canProceed).toBe(true); // alert still allows proceeding
    });

    it('same-user action is log for matching userIds', () => {
      const otherWithUser = new WorkLedger({
        stateDir,
        machineId: 'machine-b',
        userId: 'alice',
      });
      const entry = otherWithUser.startWork({
        sessionId: 'AUT-200',
        task: 'Modifying auth',
        filesPlanned: ['src/auth.ts'],
      });
      otherWithUser.updateWork(entry.id, { filesModified: ['src/auth.ts'] });

      // Guard with same userId
      const guard = new OverlapGuard({
        workLedger: myLedger,
        machineId: 'machine-a',
        userId: 'alice',
      });

      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Also touching auth',
      });

      expect(result.action).toBe('log');
    });

    it('onAlert callback fires', () => {
      const otherWithUser = new WorkLedger({
        stateDir,
        machineId: 'machine-b',
        userId: 'bob',
      });
      const entry = otherWithUser.startWork({
        sessionId: 'AUT-200',
        task: 'Modifying auth',
        filesPlanned: ['src/auth.ts'],
      });
      otherWithUser.updateWork(entry.id, { filesModified: ['src/auth.ts'] });

      const alertSpy = vi.fn();
      const guard = new OverlapGuard({
        workLedger: myLedger,
        machineId: 'machine-a',
        userId: 'alice',
        onAlert: alertSpy,
      });

      guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Also touching auth',
      });

      expect(alertSpy).toHaveBeenCalledOnce();
      expect(alertSpy.mock.calls[0][0].action).toBe('alert');
    });
  });

  // ── Tier 3: Architectural Conflict ──────────────────────────────

  describe('Tier 3 — Architectural conflict', () => {
    it('detects opposing tasks on overlapping files', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Adding session tracking to auth module',
        filesPlanned: ['src/auth.ts'],
      });

      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Switching to JWT authentication',
      });

      expect(result.maxTier).toBe(3);
      expect(result.architecturalConflicts).toHaveLength(1);
      expect(result.architecturalConflicts[0].opposingSignals).toContain('session\u2194jwt');
    });

    it('default action is block', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Adding session tracking',
        filesPlanned: ['src/auth.ts'],
      });

      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Switching to JWT tokens',
      });

      expect(result.action).toBe('block');
    });

    it('canProceed is false', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Adding session management',
        filesPlanned: ['src/auth.ts'],
      });

      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Implementing JWT flow',
      });

      expect(result.canProceed).toBe(false);
    });

    it('onBlock callback fires', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Adding session support',
        filesPlanned: ['src/auth.ts'],
      });

      const blockSpy = vi.fn();
      const guard = new OverlapGuard({
        workLedger: myLedger,
        machineId: 'machine-a',
        onBlock: blockSpy,
      });

      guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Switching to JWT',
      });

      expect(blockSpy).toHaveBeenCalledOnce();
      expect(blockSpy.mock.calls[0][0].action).toBe('block');
      expect(blockSpy.mock.calls[0][0].canProceed).toBe(false);
    });

    it('message includes both task descriptions', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Adding session-based auth',
        filesPlanned: ['src/auth.ts'],
      });

      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Migrating to JWT tokens',
      });

      const conflict = result.architecturalConflicts[0];
      expect(conflict.message).toContain('Migrating to JWT tokens');
      expect(conflict.message).toContain('Adding session-based auth');
    });
  });

  // ── Architectural Heuristics ─────────────────────────────────────

  describe('Architectural heuristics', () => {
    it('detects "add" vs "remove" patterns', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Remove legacy validation',
        filesPlanned: ['src/validation.ts'],
      });

      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: ['src/validation.ts'],
        task: 'Add new validation rules',
      });

      expect(result.maxTier).toBe(3);
      expect(result.architecturalConflicts[0].opposingSignals).toContain('add\u2194remove');
    });

    it('detects "session" vs "jwt" patterns', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Improve session handling',
        filesPlanned: ['src/auth.ts'],
      });

      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Replace with jwt tokens',
      });

      expect(result.maxTier).toBe(3);
      expect(result.architecturalConflicts[0].opposingSignals).toContain('session\u2194jwt');
    });

    it('does NOT trigger when tasks do not have opposing terms', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Refactor auth module for clarity',
        filesPlanned: ['src/auth.ts'],
      });

      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Update auth module tests',
      });

      // Should be Tier 1 or 2 (file overlap) but NOT Tier 3
      expect(result.architecturalConflicts).toHaveLength(0);
      expect(result.maxTier).toBeLessThan(3);
    });

    it('does NOT trigger when there is no file overlap even with opposing terms', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Adding session management',
        filesPlanned: ['src/session-store.ts'],
      });

      const guard = makeGuard();
      const result = guard.check({
        // Completely different files, different directories
        plannedFiles: ['lib/jwt-handler.ts'],
        task: 'Implementing JWT verification',
      });

      // Opposing terms exist (session vs jwt) but no file/directory overlap
      expect(result.architecturalConflicts).toHaveLength(0);
    });

    it('directory-level proximity counts for architectural detection', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Adding session tracking',
        filesPlanned: ['src/auth/session-store.ts'],
      });

      const guard = makeGuard();
      const result = guard.check({
        // Different file but same parent directory
        plannedFiles: ['src/auth/jwt-handler.ts'],
        task: 'Implementing JWT verification',
      });

      // Directory-level proximity should trigger architectural detection
      expect(result.architecturalConflicts).toHaveLength(1);
      expect(result.architecturalConflicts[0].overlappingFiles[0]).toContain('src/auth');
    });

    it('detects opposing terms in either direction (A->B or B->A)', () => {
      // Term B in other's task, term A in our task
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Implement jwt authentication',
        filesPlanned: ['src/auth.ts'],
      });

      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Add session management',
      });

      expect(result.maxTier).toBe(3);
      expect(result.architecturalConflicts[0].opposingSignals).toContain('session\u2194jwt');
    });
  });

  // ── Multi-User Notification Routing ──────────────────────────────

  describe('Multi-user notification routing', () => {
    it('same userId uses sameUser config (default: log)', () => {
      const otherWithUser = new WorkLedger({
        stateDir,
        machineId: 'machine-b',
        userId: 'shared-user',
      });
      const entry = otherWithUser.startWork({
        sessionId: 'AUT-200',
        task: 'Modifying shared file',
        filesPlanned: ['src/shared.ts'],
      });
      otherWithUser.updateWork(entry.id, { filesModified: ['src/shared.ts'] });

      const guard = new OverlapGuard({
        workLedger: myLedger,
        machineId: 'machine-a',
        userId: 'shared-user',
      });

      const result = guard.check({
        plannedFiles: ['src/shared.ts'],
        task: 'Also modifying shared file',
      });

      expect(result.action).toBe('log');
    });

    it('different userId uses differentUsers config (default: alert)', () => {
      const otherWithUser = new WorkLedger({
        stateDir,
        machineId: 'machine-b',
        userId: 'user-bob',
      });
      const entry = otherWithUser.startWork({
        sessionId: 'AUT-200',
        task: 'Modifying shared file',
        filesPlanned: ['src/shared.ts'],
      });
      otherWithUser.updateWork(entry.id, { filesModified: ['src/shared.ts'] });

      const guard = new OverlapGuard({
        workLedger: myLedger,
        machineId: 'machine-a',
        userId: 'user-alice',
      });

      const result = guard.check({
        plannedFiles: ['src/shared.ts'],
        task: 'Also modifying shared file',
      });

      expect(result.action).toBe('alert');
    });

    it('no userId set assumes same user', () => {
      const entry = otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Working on file',
        filesPlanned: ['src/shared.ts'],
      });
      otherLedger.updateWork(entry.id, { filesModified: ['src/shared.ts'] });

      // Guard with no userId
      const guard = new OverlapGuard({
        workLedger: myLedger,
        machineId: 'machine-a',
        // no userId
      });

      const result = guard.check({
        plannedFiles: ['src/shared.ts'],
        task: 'Also working on file',
      });

      // No userId -> isSameUserOverlap returns true -> sameUser action ('log')
      expect(result.action).toBe('log');
    });

    it('custom notification config overrides defaults', () => {
      const entry = otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Working on file',
        filesPlanned: ['src/shared.ts'],
      });
      otherLedger.updateWork(entry.id, { filesModified: ['src/shared.ts'] });

      // Override sameUser to 'alert' instead of default 'log'
      const guard = new OverlapGuard({
        workLedger: myLedger,
        machineId: 'machine-a',
        notification: {
          sameUser: 'alert',
        },
      });

      const result = guard.check({
        plannedFiles: ['src/shared.ts'],
        task: 'Also working on file',
      });

      // No userId -> same user -> but sameUser config is now 'alert'
      expect(result.action).toBe('alert');
    });

    it('other entry has no userId but guard has userId — treats as same user', () => {
      // Other ledger created without userId
      const entry = otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Working on file',
        filesPlanned: ['src/shared.ts'],
      });
      otherLedger.updateWork(entry.id, { filesModified: ['src/shared.ts'] });

      // Guard WITH userId
      const guard = new OverlapGuard({
        workLedger: myLedger,
        machineId: 'machine-a',
        userId: 'alice',
      });

      const result = guard.check({
        plannedFiles: ['src/shared.ts'],
        task: 'Also working on file',
      });

      // Entry has no userId -> isSameUserOverlap treats as same user
      expect(result.action).toBe('log');
    });
  });

  // ── Callbacks ────────────────────────────────────────────────────

  describe('Callbacks', () => {
    it('onAlert fires for alert-level results', () => {
      const otherWithUser = new WorkLedger({
        stateDir,
        machineId: 'machine-b',
        userId: 'bob',
      });
      otherWithUser.startWork({
        sessionId: 'AUT-200',
        task: 'Working on shared file',
        filesPlanned: ['src/shared.ts'],
      });

      const alertSpy = vi.fn();
      const blockSpy = vi.fn();
      const guard = new OverlapGuard({
        workLedger: myLedger,
        machineId: 'machine-a',
        userId: 'alice',
        onAlert: alertSpy,
        onBlock: blockSpy,
      });

      guard.check({
        plannedFiles: ['src/shared.ts'],
        task: 'Also working on shared file',
      });

      expect(alertSpy).toHaveBeenCalledOnce();
      expect(blockSpy).not.toHaveBeenCalled();
    });

    it('onBlock fires for block-level results', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Adding session management',
        filesPlanned: ['src/auth.ts'],
      });

      const alertSpy = vi.fn();
      const blockSpy = vi.fn();
      const guard = new OverlapGuard({
        workLedger: myLedger,
        machineId: 'machine-a',
        onAlert: alertSpy,
        onBlock: blockSpy,
      });

      guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Switching to JWT',
      });

      expect(blockSpy).toHaveBeenCalledOnce();
      expect(alertSpy).not.toHaveBeenCalled();
    });

    it('neither fires for log-level results', () => {
      const alertSpy = vi.fn();
      const blockSpy = vi.fn();
      const guard = new OverlapGuard({
        workLedger: myLedger,
        machineId: 'machine-a',
        onAlert: alertSpy,
        onBlock: blockSpy,
      });

      guard.check({
        plannedFiles: ['src/unique-file.ts'],
        task: 'No overlap at all',
      });

      expect(alertSpy).not.toHaveBeenCalled();
      expect(blockSpy).not.toHaveBeenCalled();
    });

    it('callback receives correct OverlapCheckResult', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Adding session management',
        filesPlanned: ['src/auth.ts'],
      });

      const blockSpy = vi.fn();
      const guard = new OverlapGuard({
        workLedger: myLedger,
        machineId: 'machine-a',
        onBlock: blockSpy,
      });

      guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Switching to JWT',
      });

      const received: OverlapCheckResult = blockSpy.mock.calls[0][0];
      expect(received.action).toBe('block');
      expect(received.maxTier).toBe(3);
      expect(received.canProceed).toBe(false);
      expect(received.architecturalConflicts.length).toBeGreaterThan(0);
      expect(received.suggestion).toBeDefined();
    });

    it('log-level overlap with callbacks set does not fire them', () => {
      // Planned overlap, same user (no userId) -> log
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Planning changes',
        filesPlanned: ['src/shared.ts'],
      });

      const alertSpy = vi.fn();
      const blockSpy = vi.fn();
      const guard = new OverlapGuard({
        workLedger: myLedger,
        machineId: 'machine-a',
        onAlert: alertSpy,
        onBlock: blockSpy,
      });

      const result = guard.check({
        plannedFiles: ['src/shared.ts'],
        task: 'Also planning changes',
      });

      // Tier 1, same user -> log
      expect(result.action).toBe('log');
      expect(alertSpy).not.toHaveBeenCalled();
      expect(blockSpy).not.toHaveBeenCalled();
    });
  });

  // ── Custom Config ────────────────────────────────────────────────

  describe('Custom config', () => {
    it('custom oppositionPatterns work', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Implementing redis caching',
        filesPlanned: ['src/cache.ts'],
      });

      const guard = new OverlapGuard({
        workLedger: myLedger,
        machineId: 'machine-a',
        oppositionPatterns: [['redis', 'memcached']],
      });

      const result = guard.check({
        plannedFiles: ['src/cache.ts'],
        task: 'Switching to memcached',
      });

      expect(result.maxTier).toBe(3);
      expect(result.architecturalConflicts[0].opposingSignals).toContain('redis\u2194memcached');
    });

    it('custom oppositionPatterns replace defaults, not extend them', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Adding session tracking',
        filesPlanned: ['src/auth.ts'],
      });

      // Custom patterns that do NOT include session/jwt
      const guard = new OverlapGuard({
        workLedger: myLedger,
        machineId: 'machine-a',
        oppositionPatterns: [['redis', 'memcached']],
      });

      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Switching to JWT',
      });

      // session/jwt is a default pattern, but custom replaces defaults
      expect(result.architecturalConflicts).toHaveLength(0);
      expect(result.maxTier).toBeLessThan(3);
    });

    it('custom notification overrides per-tier behavior', () => {
      // Create a Tier 1 overlap scenario
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Planning file changes',
        filesPlanned: ['src/shared.ts'],
      });

      // Override sameUser to 'block' instead of default 'log'
      const guard = new OverlapGuard({
        workLedger: myLedger,
        machineId: 'machine-a',
        notification: {
          sameUser: 'block',
        },
      });

      const result = guard.check({
        plannedFiles: ['src/shared.ts'],
        task: 'Also planning file changes',
      });

      expect(result.action).toBe('block');
      expect(result.canProceed).toBe(false);
    });

    it('all-block config blocks everything', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Working on a file',
        filesPlanned: ['src/shared.ts'],
      });

      const guard = new OverlapGuard({
        workLedger: myLedger,
        machineId: 'machine-a',
        notification: {
          sameUser: 'block',
          differentUsers: 'block',
          architecturalConflict: 'block',
        },
      });

      const result = guard.check({
        plannedFiles: ['src/shared.ts'],
        task: 'Also working on a file',
      });

      expect(result.action).toBe('block');
      expect(result.canProceed).toBe(false);
    });

    it('architecturalConflict notification can be downgraded to log', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Adding session management',
        filesPlanned: ['src/auth.ts'],
      });

      const guard = new OverlapGuard({
        workLedger: myLedger,
        machineId: 'machine-a',
        notification: {
          architecturalConflict: 'log',
        },
      });

      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Switching to JWT',
      });

      expect(result.maxTier).toBe(3);
      expect(result.action).toBe('log');
      expect(result.canProceed).toBe(true);
    });
  });

  // ── Edge Cases & Semantic Correctness ─────────────────────────────

  describe('Edge cases', () => {
    it('Tier 3 takes precedence when both Tier 2 and Tier 3 exist', () => {
      // Other machine has modified files AND opposing task
      const entry = otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Adding session management',
        filesPlanned: ['src/auth.ts'],
      });
      otherLedger.updateWork(entry.id, { filesModified: ['src/auth.ts'] });

      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Switching to JWT',
      });

      expect(result.maxTier).toBe(3);
      expect(result.action).toBe('block');
    });

    it('multiple conflicting entries accumulate architectural conflicts', () => {
      // Machine B: session work
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Adding session tracking',
        filesPlanned: ['src/auth.ts'],
      });

      // Machine C: also opposing work
      const machineC = new WorkLedger({ stateDir, machineId: 'machine-c' });
      machineC.startWork({
        sessionId: 'AUT-300',
        task: 'Enable session persistence',
        filesPlanned: ['src/auth.ts'],
      });

      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Switching to JWT',
      });

      expect(result.architecturalConflicts).toHaveLength(2);
    });

    it('completed entries on other machine do not trigger overlap', () => {
      const entry = otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Adding session management',
        filesPlanned: ['src/auth.ts'],
      });
      otherLedger.endWork(entry.id, 'completed');

      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Switching to JWT',
      });

      // Completed entries are excluded from getActiveEntries
      expect(result.maxTier).toBe(0);
      expect(result.architecturalConflicts).toHaveLength(0);
    });

    it('own machine entries do not trigger architectural conflicts', () => {
      // Only entries from machine-a (our own machine)
      myLedger.startWork({
        sessionId: 'AUT-100',
        task: 'Adding session management',
        filesPlanned: ['src/auth.ts'],
      });

      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Switching to JWT',
      });

      // Own machine entries are filtered out in detectArchitecturalConflicts
      expect(result.architecturalConflicts).toHaveLength(0);
    });

    it('empty plannedFiles returns Tier 0 with no warnings', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Working on everything',
        filesPlanned: ['src/auth.ts', 'src/db.ts'],
      });

      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: [],
        task: 'Some task with no files',
      });

      expect(result.maxTier).toBe(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('architectural conflict entryA has self as machine', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Adding session management',
        filesPlanned: ['src/auth.ts'],
      });

      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Switching to JWT',
      });

      const conflict = result.architecturalConflicts[0];
      expect(conflict.entryA.id).toBe('self');
      expect(conflict.entryA.machineId).toBe('machine-a');
      expect(conflict.entryB.machineId).toBe('machine-b');
    });

    it('suggestion for Tier 2 includes machine name', () => {
      const entry = otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Modifying file',
        filesPlanned: ['src/shared.ts'],
      });
      otherLedger.updateWork(entry.id, { filesModified: ['src/shared.ts'] });

      // Use different userId to get alert action (confirms Tier 2 path)
      const otherWithUser = new WorkLedger({
        stateDir,
        machineId: 'machine-b',
        userId: 'bob',
      });

      const guard = new OverlapGuard({
        workLedger: myLedger,
        machineId: 'machine-a',
      });

      const result = guard.check({
        plannedFiles: ['src/shared.ts'],
        task: 'Also modifying file',
      });

      expect(result.suggestion).toContain('machine-b');
    });

    it('suggestion for Tier 3 includes the other task description', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Implementing session cookies',
        filesPlanned: ['src/auth.ts'],
      });

      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Migrating to JWT',
      });

      expect(result.suggestion).toContain('session cookies');
      expect(result.suggestion).toContain('machine-b');
    });

    it('long task descriptions are truncated in conflict message', () => {
      const longTask = 'A'.repeat(100);
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: `Adding session ${longTask}`,
        filesPlanned: ['src/auth.ts'],
      });

      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: `Switching to jwt ${longTask}`,
      });

      const conflict = result.architecturalConflicts[0];
      // The truncate function caps at 60 chars in the message
      expect(conflict.message).toContain('...');
    });

    it('case-insensitive opposition detection', () => {
      otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'ADD new SESSION tracking',
        filesPlanned: ['src/auth.ts'],
      });

      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'REMOVE old JWT code',
      });

      // Opposition detection lowercases both tasks
      expect(result.maxTier).toBe(3);
      expect(result.architecturalConflicts.length).toBeGreaterThan(0);
    });

    it('paused entries from other machine still trigger overlap and architectural conflicts', () => {
      const entry = otherLedger.startWork({
        sessionId: 'AUT-200',
        task: 'Adding session management',
        filesPlanned: ['src/auth.ts'],
      });
      otherLedger.endWork(entry.id, 'paused');

      const guard = makeGuard();
      const result = guard.check({
        plannedFiles: ['src/auth.ts'],
        task: 'Switching to JWT',
      });

      // Paused entries are included in getActiveEntries
      expect(result.maxTier).toBe(3);
    });
  });
});
