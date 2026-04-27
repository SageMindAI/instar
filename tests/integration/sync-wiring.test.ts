/**
 * Wiring Integrity Tests for Sync Pipeline
 *
 * Per TESTING-INTEGRITY-SPEC: "For every dependency-injected function, test that:
 *   1. It is not null/undefined when the feature is enabled
 *   2. It is not a no-op (calling it produces observable side effects)
 *   3. It delegates to the real implementation (not a stub)"
 *
 * These tests verify the assembly layer — GitSync receives a real FileClassifier
 * and LLMConflictResolver with correct deps, and the wiring in server.ts
 * connects them properly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GitSyncManager } from '../../src/core/GitSync.js';
import { FileClassifier } from '../../src/core/FileClassifier.js';
import { LLMConflictResolver } from '../../src/core/LLMConflictResolver.js';
import type { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import type { SecurityLog } from '../../src/core/SecurityLog.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

// ── Mocks ────────────────────────────────────────────────────────────

function makeMockIdentityManager(): MachineIdentityManager {
  return {
    loadRegistry: () => ({ machines: {} }),
    loadRemoteIdentity: () => null,
  } as unknown as MachineIdentityManager;
}

function makeMockSecurityLog(): SecurityLog {
  return {
    append: () => {},
  } as unknown as SecurityLog;
}

function makeMockIntelligence(): IntelligenceProvider & { calls: Array<{ prompt: string; options?: IntelligenceOptions }> } {
  const calls: Array<{ prompt: string; options?: IntelligenceOptions }> = [];
  return {
    calls,
    evaluate: async (prompt: string, options?: IntelligenceOptions) => {
      calls.push({ prompt, options });
      return `=== RESOLVED: test.ts ===\nresolved content\n=== END ===`;
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Sync pipeline wiring integrity', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-wiring-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Category 1: FileClassifier is wired into GitSync ─────────────

  describe('FileClassifier wiring', () => {
    it('GitSyncManager always has a FileClassifier (not optional)', () => {
      const gitSync = new GitSyncManager({
        projectDir: tmpDir,
        stateDir,
        identityManager: makeMockIdentityManager(),
        securityLog: makeMockSecurityLog(),
        machineId: 'test-machine-001',
      });

      // Access the private field — this is a wiring test, not a unit test
      const classifier = (gitSync as any).fileClassifier;
      expect(classifier).toBeDefined();
      expect(classifier).toBeInstanceOf(FileClassifier);
    });

    it('FileClassifier uses the correct projectDir from GitSync config', () => {
      const gitSync = new GitSyncManager({
        projectDir: tmpDir,
        stateDir,
        identityManager: makeMockIdentityManager(),
        securityLog: makeMockSecurityLog(),
        machineId: 'test-machine-001',
      });

      const classifier = (gitSync as any).fileClassifier as FileClassifier;
      // Classify a file relative to the project — should produce a relative path in reason
      const result = classifier.classify(path.join(tmpDir, 'src/app.ts'));
      expect(result.reason).toContain('app.ts');
      expect(result.fileClass).toBe('source-code');
    });

    it('FileClassifier classify() is functional (not a stub)', () => {
      const classifier = new FileClassifier({ projectDir: tmpDir });

      // Test that calling it produces distinct results for different file types
      const tsResult = classifier.classify(path.join(tmpDir, 'app.ts'));
      const lockResult = classifier.classify(path.join(tmpDir, 'package-lock.json'));
      const pngResult = classifier.classify(path.join(tmpDir, 'image.png'));

      expect(tsResult.strategy).toBe('llm');
      expect(lockResult.strategy).toBe('regenerate');
      expect(pngResult.strategy).toBe('ours-theirs');

      // All three should be different — not a no-op returning the same thing
      expect(tsResult.strategy).not.toBe(lockResult.strategy);
      expect(lockResult.strategy).not.toBe(pngResult.strategy);
    });
  });

  // ── Category 1: LLMConflictResolver wiring ───────────────────────

  describe('LLMConflictResolver wiring', () => {
    it('is null when no intelligence provider is given', () => {
      const gitSync = new GitSyncManager({
        projectDir: tmpDir,
        stateDir,
        identityManager: makeMockIdentityManager(),
        securityLog: makeMockSecurityLog(),
        machineId: 'test-machine-001',
        // No intelligence: property
      });

      const resolver = (gitSync as any).llmResolver;
      expect(resolver).toBeNull();
    });

    it('is initialized when intelligence provider is given at construction', () => {
      const intelligence = makeMockIntelligence();
      const gitSync = new GitSyncManager({
        projectDir: tmpDir,
        stateDir,
        identityManager: makeMockIdentityManager(),
        securityLog: makeMockSecurityLog(),
        machineId: 'test-machine-001',
        intelligence,
      });

      const resolver = (gitSync as any).llmResolver;
      expect(resolver).toBeDefined();
      expect(resolver).toBeInstanceOf(LLMConflictResolver);
    });

    it('setIntelligence() creates resolver when called after construction', () => {
      const gitSync = new GitSyncManager({
        projectDir: tmpDir,
        stateDir,
        identityManager: makeMockIdentityManager(),
        securityLog: makeMockSecurityLog(),
        machineId: 'test-machine-001',
      });

      // Initially null
      expect((gitSync as any).llmResolver).toBeNull();

      // Wire intelligence late (mirrors server.ts pattern)
      const intelligence = makeMockIntelligence();
      gitSync.setIntelligence(intelligence);

      // Now it should be initialized
      const resolver = (gitSync as any).llmResolver;
      expect(resolver).toBeDefined();
      expect(resolver).toBeInstanceOf(LLMConflictResolver);
    });

    it('LLMConflictResolver creates escalation log directory', () => {
      const intelligence = makeMockIntelligence();
      new LLMConflictResolver({
        intelligence,
        projectDir: tmpDir,
        stateDir,
      });

      // The constructor should create the log directory
      const logDir = path.join(stateDir, 'sync');
      expect(fs.existsSync(logDir)).toBe(true);
    });

    it('LLMConflictResolver.resolve() actually calls intelligence.evaluate()', async () => {
      const intelligence = makeMockIntelligence();
      const resolver = new LLMConflictResolver({
        intelligence,
        projectDir: tmpDir,
        stateDir,
      });

      await resolver.resolve({
        filePath: path.join(tmpDir, 'test.ts'),
        relativePath: 'test.ts',
        oursContent: 'const a = 1;',
        theirsContent: 'const a = 2;',
        conflictedContent: '<<<< ours\nconst a = 1;\n====\nconst a = 2;\n>>>> theirs',
      });

      // Verify intelligence was actually called (not a no-op)
      expect(intelligence.calls.length).toBeGreaterThan(0);
      expect(intelligence.calls[0].prompt).toContain('test.ts');
    });
  });

  // ── Category 1: Server.ts wiring pattern ─────────────────────────

  describe('server.ts wiring pattern', () => {
    it('mirrors the late-binding pattern from server.ts', () => {
      // This test reconstructs the exact wiring pattern from server.ts:
      // 1. GitSync is created without intelligence
      // 2. Intelligence provider is created later
      // 3. setIntelligence() is called to wire them together

      // Step 1: Create GitSync (as server.ts does)
      const gitSync = new GitSyncManager({
        projectDir: tmpDir,
        stateDir,
        identityManager: makeMockIdentityManager(),
        securityLog: makeMockSecurityLog(),
        machineId: 'test-machine-001',
      });

      // At this point, no LLM resolver
      expect((gitSync as any).llmResolver).toBeNull();
      // But FileClassifier is always present
      expect((gitSync as any).fileClassifier).toBeInstanceOf(FileClassifier);

      // Step 2: Create intelligence provider (as server.ts does)
      const intelligence = makeMockIntelligence();

      // Step 3: Wire it in (as server.ts does: if (gitSync && sharedIntelligence))
      if (gitSync && intelligence) {
        gitSync.setIntelligence(intelligence);
      }

      // Now both FileClassifier and LLMResolver are available
      expect((gitSync as any).fileClassifier).toBeInstanceOf(FileClassifier);
      expect((gitSync as any).llmResolver).toBeInstanceOf(LLMConflictResolver);
    });
  });
});
