/**
 * Unit tests for ScopeCoherenceTracker — Implementation depth tracking.
 *
 * Tests cover:
 * - Recording implementation actions (Edit, Write, Bash)
 * - Scope document detection and depth reduction
 * - Grounding skill reset
 * - Checkpoint trigger logic (threshold, cooldown, session age)
 * - Checkpoint dismissal tracking and escalation
 * - State persistence across instances
 * - Query command filtering
 * - Edge cases (empty state, corrupted state, boundary values)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ScopeCoherenceTracker } from '../../src/core/ScopeCoherenceTracker.js';
import type { ScopeCoherenceConfig } from '../../src/core/ScopeCoherenceTracker.js';
import { StateManager } from '../../src/core/StateManager.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTmpState(): { stateDir: string; state: StateManager } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-test-'));
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  const state = new StateManager(stateDir);
  return { stateDir, state };
}

function recordNEdits(tracker: ScopeCoherenceTracker, n: number): void {
  for (let i = 0; i < n; i++) {
    tracker.recordAction('Edit', { file_path: `src/file${i}.ts` });
  }
}

// ── Tests ────────────────────────────────────────────────────────

describe('ScopeCoherenceTracker', () => {
  let stateDir: string;
  let state: StateManager;

  beforeEach(() => {
    ({ stateDir, state } = createTmpState());
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  describe('recordAction() — implementation depth', () => {
    it('increments depth for Edit actions', () => {
      const tracker = new ScopeCoherenceTracker(state);
      tracker.recordAction('Edit', { file_path: 'src/app.ts' });
      expect(tracker.getState().implementationDepth).toBe(1);
    });

    it('increments depth for Write actions', () => {
      const tracker = new ScopeCoherenceTracker(state);
      tracker.recordAction('Write', { file_path: 'src/new-file.ts' });
      expect(tracker.getState().implementationDepth).toBe(1);
    });

    it('increments depth for substantive Bash commands', () => {
      const tracker = new ScopeCoherenceTracker(state);
      tracker.recordAction('Bash', { command: 'pnpm build && pnpm test' });
      expect(tracker.getState().implementationDepth).toBe(1);
    });

    it('does NOT increment for query Bash commands', () => {
      const tracker = new ScopeCoherenceTracker(state);
      tracker.recordAction('Bash', { command: 'git status' });
      tracker.recordAction('Bash', { command: 'git log --oneline -5' });
      tracker.recordAction('Bash', { command: 'ls src/' });
      tracker.recordAction('Bash', { command: 'grep something file.ts' });
      expect(tracker.getState().implementationDepth).toBe(0);
    });

    it('does NOT increment for very short Bash commands', () => {
      const tracker = new ScopeCoherenceTracker(state);
      tracker.recordAction('Bash', { command: 'pwd' });
      expect(tracker.getState().implementationDepth).toBe(0);
    });

    it('accumulates depth across multiple actions', () => {
      const tracker = new ScopeCoherenceTracker(state);
      recordNEdits(tracker, 5);
      tracker.recordAction('Write', { file_path: 'src/new.ts' });
      tracker.recordAction('Bash', { command: 'npx tsc --noEmit' });
      expect(tracker.getState().implementationDepth).toBe(7);
    });

    it('sets session start on first action', () => {
      const tracker = new ScopeCoherenceTracker(state);
      expect(tracker.getState().sessionStart).toBeNull();
      tracker.recordAction('Edit', { file_path: 'src/app.ts' });
      expect(tracker.getState().sessionStart).not.toBeNull();
    });

    it('tracks last implementation tool', () => {
      const tracker = new ScopeCoherenceTracker(state);
      tracker.recordAction('Edit', { file_path: 'src/app.ts' });
      const lastTool = tracker.getState().lastImplementationTool;
      expect(lastTool).not.toBeNull();
      expect(lastTool!.startsWith('Edit:')).toBe(true);
    });
  });

  describe('recordAction() — scope document detection', () => {
    it('reduces depth when reading a spec file', () => {
      const tracker = new ScopeCoherenceTracker(state);
      recordNEdits(tracker, 15);
      tracker.recordAction('Read', { file_path: 'docs/specs/MY_SPEC.md' });
      expect(tracker.getState().implementationDepth).toBe(5); // 15 - 10
    });

    it('reduces depth when reading AGENT.md', () => {
      const tracker = new ScopeCoherenceTracker(state);
      recordNEdits(tracker, 12);
      tracker.recordAction('Read', { file_path: '.instar/AGENT.md' });
      expect(tracker.getState().implementationDepth).toBe(2);
    });

    it('reduces depth when reading README', () => {
      const tracker = new ScopeCoherenceTracker(state);
      recordNEdits(tracker, 8);
      tracker.recordAction('Read', { file_path: 'README.md' });
      expect(tracker.getState().implementationDepth).toBe(0); // max(0, 8-10)
    });

    it('tracks docs read in session', () => {
      const tracker = new ScopeCoherenceTracker(state);
      tracker.recordAction('Read', { file_path: 'docs/ARCHITECTURE.md' });
      tracker.recordAction('Read', { file_path: 'docs/specs/API_SPEC.md' });
      expect(tracker.getState().sessionDocsRead).toEqual([
        'docs/ARCHITECTURE.md',
        'docs/specs/API_SPEC.md',
      ]);
    });

    it('does not duplicate doc entries', () => {
      const tracker = new ScopeCoherenceTracker(state);
      tracker.recordAction('Read', { file_path: 'docs/ARCHITECTURE.md' });
      tracker.recordAction('Read', { file_path: 'docs/ARCHITECTURE.md' });
      expect(tracker.getState().sessionDocsRead).toHaveLength(1);
    });

    it('does NOT reduce depth for non-scope reads', () => {
      const tracker = new ScopeCoherenceTracker(state);
      recordNEdits(tracker, 5);
      tracker.recordAction('Read', { file_path: 'src/utils/helper.ts' });
      expect(tracker.getState().implementationDepth).toBe(5);
    });

    it('sets lastScopeCheck timestamp on scope read', () => {
      const tracker = new ScopeCoherenceTracker(state);
      tracker.recordAction('Read', { file_path: 'docs/DESIGN.md' });
      expect(tracker.getState().lastScopeCheck).not.toBeNull();
    });

    it('caps sessionDocsRead at 20 entries', () => {
      const tracker = new ScopeCoherenceTracker(state);
      for (let i = 0; i < 25; i++) {
        tracker.recordAction('Read', { file_path: `docs/spec-${i}.md` });
      }
      expect(tracker.getState().sessionDocsRead).toHaveLength(20);
    });
  });

  describe('recordAction() — grounding skills', () => {
    it('resets depth when grounding skill is invoked', () => {
      const tracker = new ScopeCoherenceTracker(state);
      recordNEdits(tracker, 15);
      tracker.recordAction('Skill', { skill: 'grounding' });
      expect(tracker.getState().implementationDepth).toBe(0);
    });

    it('resets depth for reflect skill', () => {
      const tracker = new ScopeCoherenceTracker(state);
      recordNEdits(tracker, 10);
      tracker.recordAction('Skill', { skill: 'reflect' });
      expect(tracker.getState().implementationDepth).toBe(0);
    });

    it('does NOT reset depth for non-grounding skills', () => {
      const tracker = new ScopeCoherenceTracker(state);
      recordNEdits(tracker, 10);
      tracker.recordAction('Skill', { skill: 'commit' });
      expect(tracker.getState().implementationDepth).toBe(10);
    });
  });

  describe('isScopeDocument()', () => {
    it('detects docs/ paths', () => {
      const tracker = new ScopeCoherenceTracker(state);
      expect(tracker.isScopeDocument('docs/guide.md')).toBe(true);
    });

    it('detects specs/ paths', () => {
      const tracker = new ScopeCoherenceTracker(state);
      expect(tracker.isScopeDocument('specs/API_SPEC.md')).toBe(true);
    });

    it('detects ALL_CAPS filenames with .md extension', () => {
      const tracker = new ScopeCoherenceTracker(state);
      expect(tracker.isScopeDocument('MIGRATION_GUIDE.md')).toBe(true);
    });

    it('rejects source code files', () => {
      const tracker = new ScopeCoherenceTracker(state);
      expect(tracker.isScopeDocument('src/utils/helper.ts')).toBe(false);
    });

    it('rejects short ALL_CAPS names', () => {
      const tracker = new ScopeCoherenceTracker(state);
      expect(tracker.isScopeDocument('FAQ.md')).toBe(false); // stem.length <= 3
    });

    it('detects CLAUDE.md', () => {
      const tracker = new ScopeCoherenceTracker(state);
      expect(tracker.isScopeDocument('CLAUDE.md')).toBe(true);
    });

    it('detects .instar/AGENT.md', () => {
      const tracker = new ScopeCoherenceTracker(state);
      expect(tracker.isScopeDocument('.instar/AGENT.md')).toBe(true);
    });

    it('handles empty string', () => {
      const tracker = new ScopeCoherenceTracker(state);
      expect(tracker.isScopeDocument('')).toBe(false);
    });
  });

  describe('shouldTriggerCheckpoint()', () => {
    it('does not trigger when depth is below threshold', () => {
      const tracker = new ScopeCoherenceTracker(state, { depthThreshold: 20 });
      recordNEdits(tracker, 10);
      const result = tracker.shouldTriggerCheckpoint();
      expect(result.trigger).toBe(false);
      expect(result.skipReason).toBe('below_threshold');
    });

    it('triggers when depth exceeds threshold and session is old enough', () => {
      const tracker = new ScopeCoherenceTracker(state, {
        depthThreshold: 5,
        minSessionAgeMinutes: 0, // disable age check for test
      });
      recordNEdits(tracker, 6);
      const result = tracker.shouldTriggerCheckpoint();
      expect(result.trigger).toBe(true);
      expect(result.depth).toBe(6);
    });

    it('respects cooldown period', () => {
      const tracker = new ScopeCoherenceTracker(state, {
        depthThreshold: 5,
        minSessionAgeMinutes: 0,
        cooldownMinutes: 30,
      });
      recordNEdits(tracker, 6);

      // First trigger should work
      const first = tracker.shouldTriggerCheckpoint();
      expect(first.trigger).toBe(true);

      // Record that it was shown
      tracker.recordCheckpointShown();

      // Second trigger should be blocked by cooldown
      const second = tracker.shouldTriggerCheckpoint();
      expect(second.trigger).toBe(false);
      expect(second.skipReason).toBe('cooldown');
    });

    it('respects minimum session age', () => {
      const tracker = new ScopeCoherenceTracker(state, {
        depthThreshold: 5,
        minSessionAgeMinutes: 60, // very long — will always block
      });
      recordNEdits(tracker, 10);
      const result = tracker.shouldTriggerCheckpoint();
      expect(result.trigger).toBe(false);
      expect(result.skipReason).toBe('session_too_young');
    });

    it('triggers at exact threshold boundary', () => {
      const tracker = new ScopeCoherenceTracker(state, {
        depthThreshold: 5,
        minSessionAgeMinutes: 0,
      });
      recordNEdits(tracker, 5);
      const result = tracker.shouldTriggerCheckpoint();
      expect(result.trigger).toBe(true);
    });

    it('does not trigger below exact boundary', () => {
      const tracker = new ScopeCoherenceTracker(state, {
        depthThreshold: 5,
        minSessionAgeMinutes: 0,
      });
      recordNEdits(tracker, 4);
      const result = tracker.shouldTriggerCheckpoint();
      expect(result.trigger).toBe(false);
    });
  });

  describe('recordCheckpointShown()', () => {
    it('increments dismissal counter', () => {
      const tracker = new ScopeCoherenceTracker(state);
      tracker.recordCheckpointShown();
      expect(tracker.getState().checkpointsDismissed).toBe(1);
      tracker.recordCheckpointShown();
      expect(tracker.getState().checkpointsDismissed).toBe(2);
    });

    it('records checkpoint timestamp', () => {
      const tracker = new ScopeCoherenceTracker(state);
      tracker.recordCheckpointShown();
      expect(tracker.getState().lastCheckpointPrompt).not.toBeNull();
    });
  });

  describe('reset()', () => {
    it('resets all state to defaults', () => {
      const tracker = new ScopeCoherenceTracker(state);
      recordNEdits(tracker, 15);
      tracker.recordCheckpointShown();
      tracker.recordAction('Read', { file_path: 'docs/SPEC.md' });

      tracker.reset();
      const s = tracker.getState();
      expect(s.implementationDepth).toBe(0);
      expect(s.checkpointsDismissed).toBe(0);
      expect(s.sessionDocsRead).toEqual([]);
      expect(s.lastCheckpointPrompt).toBeNull();
      expect(s.lastScopeCheck).toBeNull();
      expect(s.sessionStart).toBeNull();
    });
  });

  describe('state persistence', () => {
    it('persists state across tracker instances', () => {
      const tracker1 = new ScopeCoherenceTracker(state);
      recordNEdits(tracker1, 8);

      // Create new tracker with same StateManager
      const tracker2 = new ScopeCoherenceTracker(state);
      expect(tracker2.getState().implementationDepth).toBe(8);
    });

    it('handles missing state file gracefully', () => {
      const tracker = new ScopeCoherenceTracker(state);
      const s = tracker.getState();
      expect(s.implementationDepth).toBe(0);
      expect(s.sessionDocsRead).toEqual([]);
    });
  });

  describe('custom configuration', () => {
    it('respects custom depth threshold', () => {
      const tracker = new ScopeCoherenceTracker(state, {
        depthThreshold: 3,
        minSessionAgeMinutes: 0,
      });
      recordNEdits(tracker, 3);
      expect(tracker.shouldTriggerCheckpoint().trigger).toBe(true);
    });

    it('respects custom scope check reduction', () => {
      const tracker = new ScopeCoherenceTracker(state, { scopeCheckReduction: 5 });
      recordNEdits(tracker, 8);
      tracker.recordAction('Read', { file_path: 'docs/SPEC.md' });
      expect(tracker.getState().implementationDepth).toBe(3); // 8 - 5
    });
  });
});
