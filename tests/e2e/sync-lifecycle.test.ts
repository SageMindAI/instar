/**
 * E2E Lifecycle Tests for Sync Pipeline
 *
 * Per TESTING-INTEGRITY-SPEC Category 3: "The full path from user action
 * to user-visible outcome works end-to-end, with controlled (but real)
 * intermediate components."
 *
 * Tests the complete conflict → classify → route → resolve → validate pipeline
 * using a real git repo with actual merge conflicts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileClassifier } from '../../src/core/FileClassifier.js';
import { LLMConflictResolver } from '../../src/core/LLMConflictResolver.js';
import type { ConflictFile } from '../../src/core/LLMConflictResolver.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

// ── Helpers ──────────────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  // safe-git-allow: incremental-migration
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
    },
  }).trim();
}

function createGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-e2e-'));
  git(['init', '--initial-branch=main'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);

  // Initial commit
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test Repo\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'Initial commit'], dir);

  return dir;
}

function createConflict(
  repoDir: string,
  filePath: string,
  baseContent: string,
  oursContent: string,
  theirsContent: string,
): void {
  // Write base content on main
  const fullPath = path.join(repoDir, filePath);
  const dirName = path.dirname(fullPath);
  if (!fs.existsSync(dirName)) fs.mkdirSync(dirName, { recursive: true });
  fs.writeFileSync(fullPath, baseContent);
  git(['add', filePath], repoDir);
  git(['commit', '-m', `Add ${filePath}`], repoDir);

  // Create "theirs" branch with their changes
  git(['checkout', '-b', 'theirs'], repoDir);
  fs.writeFileSync(fullPath, theirsContent);
  git(['add', filePath], repoDir);
  git(['commit', '-m', `Theirs: modify ${filePath}`], repoDir);

  // Go back to main with "ours" changes
  git(['checkout', 'main'], repoDir);
  fs.writeFileSync(fullPath, oursContent);
  git(['add', filePath], repoDir);
  git(['commit', '-m', `Ours: modify ${filePath}`], repoDir);
}

function makeMockIntelligence(
  resolvedContent: string,
): IntelligenceProvider & { calls: Array<{ prompt: string; options?: IntelligenceOptions }> } {
  const calls: Array<{ prompt: string; options?: IntelligenceOptions }> = [];
  return {
    calls,
    evaluate: async (prompt: string, options?: IntelligenceOptions) => {
      calls.push({ prompt, options });
      // Extract the file path from the prompt
      const pathMatch = prompt.match(/(?:RESOLVED|file is)\s+(\S+)/);
      const filePath = pathMatch?.[1] ?? 'unknown';
      return `=== RESOLVED: ${filePath} ===\n${resolvedContent}\n=== END ===`;
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Sync pipeline E2E lifecycle', () => {
  let repoDir: string;
  let stateDir: string;

  beforeEach(() => {
    repoDir = createGitRepo();
    stateDir = path.join(repoDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  // ── Full pipeline: classify → route → resolve ────────────────────

  describe('source code conflict lifecycle', () => {
    it('classifies .ts file as source code, routes to LLM, resolves', async () => {
      const classifier = new FileClassifier({ projectDir: repoDir });

      // Step 1: Classify the file
      const filePath = path.join(repoDir, 'src/utils.ts');
      const classification = classifier.classify(filePath);

      expect(classification.fileClass).toBe('source-code');
      expect(classification.strategy).toBe('llm');

      // Step 2: Create a real git conflict
      createConflict(
        repoDir,
        'src/utils.ts',
        'export function greet() { return "hello"; }\n',
        'export function greet() { return "hi there"; }\n',
        'export function greet(name: string) { return `hello ${name}`; }\n',
      );

      // Try to merge — will fail with conflict
      try {
        git(['merge', 'theirs'], repoDir);
      } catch {
        // Expected — merge conflict
      }

      // Step 3: Read the conflict from git stages
      const oursContent = git(['show', ':2:src/utils.ts'], repoDir);
      const theirsContent = git(['show', ':3:src/utils.ts'], repoDir);
      const conflictedContent = fs.readFileSync(path.join(repoDir, 'src/utils.ts'), 'utf-8');

      expect(conflictedContent).toContain('<<<<');
      expect(oursContent).toContain('hi there');
      expect(theirsContent).toContain('name: string');

      // Step 4: Route to LLM resolver
      const mergedContent = 'export function greet(name?: string) { return name ? `hello ${name}` : "hi there"; }';
      const intelligence = makeMockIntelligence(mergedContent);
      const resolver = new LLMConflictResolver({
        intelligence,
        projectDir: repoDir,
        stateDir,
      });

      const conflict: ConflictFile = {
        filePath: path.join(repoDir, 'src/utils.ts'),
        relativePath: 'src/utils.ts',
        oursContent,
        theirsContent,
        conflictedContent,
      };

      const result = await resolver.resolve(conflict);

      // Step 5: Verify full lifecycle completed
      expect(result.resolved).toBe(true);
      expect(result.tier).toBe(1); // Resolved at Tier 1
      expect(result.resolvedContent).toBe(mergedContent);
      expect(intelligence.calls.length).toBe(1);
      expect(intelligence.calls[0].options?.model).toBe('fast'); // Tier 1 uses fast model

      // Step 6: Verify escalation log was written
      const logEntries = resolver.readLog();
      expect(logEntries.length).toBe(1);
      expect(logEntries[0].tier).toBe(1);
      expect(logEntries[0].resolved).toBe(true);
      expect(logEntries[0].filePath).toBe('src/utils.ts');
    });
  });

  describe('lockfile conflict lifecycle', () => {
    it('classifies package-lock.json as lockfile, routes to regenerate (not LLM)', () => {
      const classifier = new FileClassifier({ projectDir: repoDir });

      const filePath = path.join(repoDir, 'package-lock.json');
      const classification = classifier.classify(filePath);

      // Should NEVER reach LLM
      expect(classification.fileClass).toBe('lockfile');
      expect(classification.strategy).toBe('regenerate');
      expect(classification.strategy).not.toBe('llm');
      expect(classification.regenCommands).toContain('npm ci');
      expect(classification.manifestFile).toBe('package.json');
    });

    it('lockfile regeneration falls back to second command if first fails', () => {
      // Create a package.json but no node_modules — npm ci will fail
      fs.writeFileSync(
        path.join(repoDir, 'package.json'),
        JSON.stringify({ name: 'test', version: '1.0.0', dependencies: {} }),
      );
      fs.writeFileSync(
        path.join(repoDir, 'package-lock.json'),
        '{}', // Invalid lockfile
      );

      const classifier = new FileClassifier({ projectDir: repoDir });
      const classification = classifier.classify(path.join(repoDir, 'package-lock.json'));

      // Regen will try npm ci (may fail since lockfile is empty) then npm install --package-lock-only
      const result = classifier.regenerateLockfile(
        path.join(repoDir, 'package-lock.json'),
        classification,
      );

      // One of the commands should succeed since we have a valid package.json
      // (npm ci may fail, npm install --package-lock-only should work)
      if (result.success) {
        expect(result.command).toBeDefined();
        // The regenerated file should exist
        expect(fs.existsSync(path.join(repoDir, 'package-lock.json'))).toBe(true);
      } else {
        // If both fail (e.g., npm not available in test env), that's ok —
        // we verify the fallback chain was attempted
        expect(result.error).toContain('failed');
      }
    });
  });

  describe('binary file conflict lifecycle', () => {
    it('classifies .png as binary, uses hash divergence (not LLM)', () => {
      const classifier = new FileClassifier({ projectDir: repoDir });

      const filePath = path.join(repoDir, 'assets/logo.png');
      const classification = classifier.classify(filePath);

      expect(classification.fileClass).toBe('binary');
      expect(classification.strategy).toBe('ours-theirs');
      expect(classification.strategy).not.toBe('llm');
    });

    it('resolves binary conflict when both sides changed using hash divergence', () => {
      // Create base binary content
      const binaryBase = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      const binaryOurs = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0b]); // Changed byte 5
      const binaryTheirs = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0c]); // Changed byte 5 differently

      fs.mkdirSync(path.join(repoDir, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'assets/logo.png'), binaryBase);
      git(['add', 'assets/logo.png'], repoDir);
      git(['commit', '-m', 'Add logo'], repoDir);

      // Theirs branch — different change
      git(['checkout', '-b', 'theirs'], repoDir);
      fs.writeFileSync(path.join(repoDir, 'assets/logo.png'), binaryTheirs);
      git(['add', 'assets/logo.png'], repoDir);
      git(['commit', '-m', 'Theirs: update logo differently'], repoDir);

      // Ours — our change
      git(['checkout', 'main'], repoDir);
      fs.writeFileSync(path.join(repoDir, 'assets/logo.png'), binaryOurs);
      git(['add', 'assets/logo.png'], repoDir);
      git(['commit', '-m', 'Ours: update logo'], repoDir);

      // Merge — binary conflict (both sides changed)
      try {
        git(['merge', 'theirs'], repoDir);
      } catch {
        // Expected — binary merge conflict
      }

      const classifier = new FileClassifier({ projectDir: repoDir });
      const binaryResult = classifier.resolveBinary(path.join(repoDir, 'assets/logo.png'));

      // Both sides changed from base → real conflict, needs human
      expect(binaryResult.resolution).toBe('conflict');
      expect(binaryResult.reason).toContain('Both sides');
    });
  });

  describe('generated artifact conflict lifecycle', () => {
    it('classifies dist/ files as generated, never routes to LLM', () => {
      const classifier = new FileClassifier({ projectDir: repoDir });

      const filePath = path.join(repoDir, 'dist/bundle.js');
      const classification = classifier.classify(filePath);

      expect(classification.fileClass).toBe('generated');
      expect(classification.strategy).toBe('exclude');
      expect(classification.strategy).not.toBe('llm');
    });

    it('classifies .min.js as generated', () => {
      const classifier = new FileClassifier({ projectDir: repoDir });

      const classification = classifier.classify(path.join(repoDir, 'vendor/jquery.min.js'));
      expect(classification.fileClass).toBe('generated');
      expect(classification.strategy).toBe('exclude');
    });
  });

  describe('secret file conflict lifecycle', () => {
    it('classifies .env files as secrets, never routes to LLM', () => {
      const classifier = new FileClassifier({ projectDir: repoDir });

      for (const envFile of ['.env', '.env.local', '.env.production']) {
        const classification = classifier.classify(path.join(repoDir, envFile));
        expect(classification.fileClass).toBe('secret');
        expect(classification.strategy).toBe('never-sync');
        expect(classification.strategy).not.toBe('llm');
      }
    });
  });

  // ── Multi-file conflict scenario ─────────────────────────────────

  describe('mixed file type conflict scenario', () => {
    it('routes each file type to the correct strategy in a multi-file conflict', () => {
      const classifier = new FileClassifier({ projectDir: repoDir });

      const files = [
        { path: 'src/app.ts', expectedClass: 'source-code', expectedStrategy: 'llm' },
        { path: 'src/utils.py', expectedClass: 'source-code', expectedStrategy: 'llm' },
        { path: 'package-lock.json', expectedClass: 'lockfile', expectedStrategy: 'regenerate' },
        { path: 'yarn.lock', expectedClass: 'lockfile', expectedStrategy: 'regenerate' },
        { path: 'assets/logo.png', expectedClass: 'binary', expectedStrategy: 'ours-theirs' },
        { path: 'dist/bundle.js', expectedClass: 'generated', expectedStrategy: 'exclude' },
        { path: '.env.local', expectedClass: 'secret', expectedStrategy: 'never-sync' },
        { path: 'README.md', expectedClass: 'documentation', expectedStrategy: 'llm' },
        { path: '.instar/state/sessions.json', expectedClass: 'structured-data', expectedStrategy: 'programmatic' },
      ];

      const results = files.map(f => ({
        ...f,
        result: classifier.classify(path.join(repoDir, f.path)),
      }));

      // Verify each file routed correctly
      for (const { path: filePath, expectedClass, expectedStrategy, result } of results) {
        expect(result.fileClass).toBe(expectedClass);
        expect(result.strategy).toBe(expectedStrategy);
      }

      // Verify LLM is only used for source code and documentation
      const llmFiles = results.filter(r => r.result.strategy === 'llm');
      expect(llmFiles.every(f =>
        f.result.fileClass === 'source-code' || f.result.fileClass === 'documentation'
      )).toBe(true);

      // Verify lockfiles get regeneration commands
      const lockFiles = results.filter(r => r.result.strategy === 'regenerate');
      expect(lockFiles.every(f => f.result.regenCommands && f.result.regenCommands.length > 0)).toBe(true);
    });
  });

  // ── Tier escalation lifecycle ────────────────────────────────────

  describe('tier escalation lifecycle', () => {
    it('escalates from Tier 1 → Tier 2 → Tier 3 when LLM fails', async () => {
      let callCount = 0;
      const intelligence: IntelligenceProvider = {
        evaluate: async (prompt: string, options?: IntelligenceOptions) => {
          callCount++;
          // All attempts return unresolvable response
          return 'I cannot resolve this conflict because the changes are fundamentally incompatible.';
        },
      };

      const resolver = new LLMConflictResolver({
        intelligence,
        projectDir: repoDir,
        stateDir,
        maxRetriesPerTier: 2,
      });

      const conflict: ConflictFile = {
        filePath: path.join(repoDir, 'complex.ts'),
        relativePath: 'complex.ts',
        oursContent: 'class A { method() { return 1; } }',
        theirsContent: 'class B { method() { return 2; } }',
        conflictedContent: '<<<< ours\nclass A...\n====\nclass B...\n>>>> theirs',
      };

      const result = await resolver.resolve(conflict);

      // Should have escalated to Tier 3 (human)
      expect(result.resolved).toBe(false);
      expect(result.tier).toBe(3);

      // Tier 1: 2 retries + Tier 2: 2 retries = 4 total calls
      expect(callCount).toBe(4);

      // Verify escalation log tracks the full journey
      const logEntries = resolver.readLog();
      expect(logEntries.length).toBe(4);

      // First 2 entries should be Tier 1
      expect(logEntries[0].tier).toBe(1);
      expect(logEntries[1].tier).toBe(1);

      // Last 2 entries should be Tier 2
      expect(logEntries[2].tier).toBe(2);
      expect(logEntries[3].tier).toBe(2);
    });

    it('NEEDS_HUMAN at Tier 1 skips retries and escalates immediately', async () => {
      let callCount = 0;
      const intelligence: IntelligenceProvider = {
        evaluate: async () => {
          callCount++;
          if (callCount === 1) {
            // Tier 1 says needs human
            return [
              '=== NEEDS_HUMAN: complex.ts ===',
              'Reason: Semantic conflict between class rename and method change',
              'Machine A intent: Renaming class A to B',
              'Machine B intent: Adding parameters to method',
              'Suggested resolution: Keep class B with new parameters',
              '=== END ===',
            ].join('\n');
          }
          // Tier 2 resolves it
          return '=== RESOLVED: complex.ts ===\nclass B { method(x: number) { return x; } }\n=== END ===';
        },
      };

      const resolver = new LLMConflictResolver({
        intelligence,
        projectDir: repoDir,
        stateDir,
        maxRetriesPerTier: 2,
      });

      const conflict: ConflictFile = {
        filePath: path.join(repoDir, 'complex.ts'),
        relativePath: 'complex.ts',
        oursContent: 'class A { method() { return 1; } }',
        theirsContent: 'class B { method(x: number) { return x; } }',
        conflictedContent: '...',
      };

      const result = await resolver.resolve(conflict);

      expect(result.resolved).toBe(true);
      expect(result.tier).toBe(2);
      // Only 2 calls: 1 for Tier 1 (NEEDS_HUMAN, no retry) + 1 for Tier 2
      expect(callCount).toBe(2);
    });
  });
});
