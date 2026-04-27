/**
 * Unit tests for FileClassifier — file routing before LLM resolution.
 *
 * Tests classification rules, lockfile handling, binary detection,
 * and pattern matching for generated artifacts and secrets.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileClassifier } from '../../src/core/FileClassifier.js';
import type { ClassificationResult, FileClass, MergeStrategy } from '../../src/core/FileClassifier.js';

function makeClassifier(tmpDir: string, overrides?: Partial<ConstructorParameters<typeof FileClassifier>[0]>) {
  return new FileClassifier({
    projectDir: tmpDir,
    ...overrides,
  });
}

describe('FileClassifier', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-classifier-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Source Code Classification ────────────────────────────────────

  describe('source code', () => {
    const sourceExtensions = [
      '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java',
      '.c', '.cpp', '.rb', '.php', '.swift', '.sh', '.sql', '.css',
      '.html', '.vue', '.svelte', '.prisma',
    ];

    it.each(sourceExtensions)('classifies %s as source code with LLM strategy', (ext) => {
      const classifier = makeClassifier(tmpDir);
      const result = classifier.classify(path.join(tmpDir, `src/main${ext}`));

      expect(result.fileClass).toBe('source-code');
      expect(result.strategy).toBe('llm');
    });
  });

  // ── Documentation Classification ─────────────────────────────────

  describe('documentation', () => {
    it.each(['.md', '.mdx', '.txt', '.rst'])('classifies %s as documentation', (ext) => {
      const classifier = makeClassifier(tmpDir);
      const result = classifier.classify(path.join(tmpDir, `docs/README${ext}`));

      expect(result.fileClass).toBe('documentation');
      expect(result.strategy).toBe('llm');
    });
  });

  // ── Lockfile Classification ──────────────────────────────────────

  describe('lockfiles', () => {
    const lockfiles = [
      { file: 'package-lock.json', manifest: 'package.json' },
      { file: 'pnpm-lock.yaml', manifest: 'package.json' },
      { file: 'yarn.lock', manifest: 'package.json' },
      { file: 'Cargo.lock', manifest: 'Cargo.toml' },
      { file: 'poetry.lock', manifest: 'pyproject.toml' },
      { file: 'Gemfile.lock', manifest: 'Gemfile' },
      { file: 'composer.lock', manifest: 'composer.json' },
      { file: 'go.sum', manifest: 'go.mod' },
    ];

    it.each(lockfiles)('classifies $file as lockfile with regenerate strategy', ({ file, manifest }) => {
      const classifier = makeClassifier(tmpDir);
      const result = classifier.classify(path.join(tmpDir, file));

      expect(result.fileClass).toBe('lockfile');
      expect(result.strategy).toBe('regenerate');
      expect(result.manifestFile).toBe(manifest);
      expect(result.regenCommands).toBeDefined();
      expect(result.regenCommands!.length).toBeGreaterThan(0);
    });

    it('provides strict + fallback regen commands for npm lockfile', () => {
      const classifier = makeClassifier(tmpDir);
      const result = classifier.classify(path.join(tmpDir, 'package-lock.json'));

      expect(result.regenCommands).toEqual([
        'npm ci',
        'npm install --package-lock-only',
      ]);
    });

    it('supports custom lockfile patterns', () => {
      const classifier = makeClassifier(tmpDir, {
        extraLockfilePatterns: ['custom.lock'],
      });
      const result = classifier.classify(path.join(tmpDir, 'custom.lock'));

      expect(result.fileClass).toBe('lockfile');
      expect(result.strategy).toBe('regenerate');
    });

    it('supports custom regen commands', () => {
      const classifier = makeClassifier(tmpDir, {
        extraLockfilePatterns: ['custom.lock'],
        extraRegenCommands: { 'custom.lock': ['custom-install --frozen', 'custom-install'] },
      });
      const result = classifier.classify(path.join(tmpDir, 'custom.lock'));

      expect(result.regenCommands).toEqual(['custom-install --frozen', 'custom-install']);
    });
  });

  // ── Binary File Classification ───────────────────────────────────

  describe('binary files', () => {
    const binaryExts = [
      '.png', '.jpg', '.gif', '.webp', '.svg',
      '.woff', '.woff2', '.ttf',
      '.mp3', '.mp4', '.wav',
      '.zip', '.tar', '.gz',
      '.pdf', '.doc', '.xlsx',
      '.sqlite', '.db',
      '.psd', '.wasm', '.exe',
    ];

    it.each(binaryExts)('classifies %s as binary with ours-theirs strategy', (ext) => {
      const classifier = makeClassifier(tmpDir);
      const result = classifier.classify(path.join(tmpDir, `assets/file${ext}`));

      expect(result.fileClass).toBe('binary');
      expect(result.strategy).toBe('ours-theirs');
    });

    it('supports custom binary extensions', () => {
      const classifier = makeClassifier(tmpDir, {
        extraBinaryExtensions: ['.custom'],
      });
      const result = classifier.classify(path.join(tmpDir, 'data.custom'));

      expect(result.fileClass).toBe('binary');
      expect(result.strategy).toBe('ours-theirs');
    });
  });

  // ── Generated Artifact Classification ────────────────────────────

  describe('generated artifacts', () => {
    const generatedPaths = [
      'dist/bundle.js',
      'build/output.css',
      '.next/static/chunks/main.js',
      'out/index.html',
      'node_modules/lodash/index.js',
      '__pycache__/module.pyc',
      'coverage/lcov.info',
    ];

    it.each(generatedPaths)('classifies %s as generated with exclude strategy', (relPath) => {
      const classifier = makeClassifier(tmpDir);
      const result = classifier.classify(path.join(tmpDir, relPath));

      expect(result.fileClass).toBe('generated');
      expect(result.strategy).toBe('exclude');
    });

    it('classifies .min.js as generated', () => {
      const classifier = makeClassifier(tmpDir);
      const result = classifier.classify(path.join(tmpDir, 'vendor/jquery.min.js'));

      expect(result.fileClass).toBe('generated');
      expect(result.strategy).toBe('exclude');
    });

    it('classifies .map as generated', () => {
      const classifier = makeClassifier(tmpDir);
      const result = classifier.classify(path.join(tmpDir, 'dist/app.js.map'));

      expect(result.fileClass).toBe('generated');
      expect(result.strategy).toBe('exclude');
    });

    it('supports custom exclude patterns', () => {
      const classifier = makeClassifier(tmpDir, {
        extraExcludePatterns: ['generated/'],
      });
      const result = classifier.classify(path.join(tmpDir, 'generated/output.js'));

      expect(result.fileClass).toBe('generated');
      expect(result.strategy).toBe('exclude');
    });
  });

  // ── Secret Classification ────────────────────────────────────────

  describe('secrets', () => {
    const secretFiles = [
      '.env',
      '.env.local',
      '.env.production',
    ];

    it.each(secretFiles)('classifies %s as secret with never-sync strategy', (file) => {
      const classifier = makeClassifier(tmpDir);
      const result = classifier.classify(path.join(tmpDir, file));

      expect(result.fileClass).toBe('secret');
      expect(result.strategy).toBe('never-sync');
    });

    it('classifies .pem files as secrets', () => {
      const classifier = makeClassifier(tmpDir);
      const result = classifier.classify(path.join(tmpDir, 'server.pem'));

      expect(result.fileClass).toBe('secret');
      expect(result.strategy).toBe('never-sync');
    });

    it('classifies key files as secrets', () => {
      const classifier = makeClassifier(tmpDir);
      const result = classifier.classify(path.join(tmpDir, 'private.key'));

      expect(result.fileClass).toBe('secret');
      expect(result.strategy).toBe('never-sync');
    });

    it('classifies files with "credentials" in name as secrets', () => {
      const classifier = makeClassifier(tmpDir);
      const result = classifier.classify(path.join(tmpDir, 'db-credentials.json'));

      expect(result.fileClass).toBe('secret');
      expect(result.strategy).toBe('never-sync');
    });

    it('classifies SSH keys as secrets', () => {
      const classifier = makeClassifier(tmpDir);
      const result = classifier.classify(path.join(tmpDir, 'id_rsa'));

      expect(result.fileClass).toBe('secret');
      expect(result.strategy).toBe('never-sync');
    });

    it('supports custom secret patterns', () => {
      const classifier = makeClassifier(tmpDir, {
        extraSecretPatterns: ['my-tokens.json'],
      });
      const result = classifier.classify(path.join(tmpDir, 'my-tokens.json'));

      expect(result.fileClass).toBe('secret');
      expect(result.strategy).toBe('never-sync');
    });
  });

  // ── Structured Data Classification ───────────────────────────────

  describe('structured data', () => {
    it('classifies .instar/*.json as structured data', () => {
      const classifier = makeClassifier(tmpDir);
      const result = classifier.classify(path.join(tmpDir, '.instar/state/sessions.json'));

      expect(result.fileClass).toBe('structured-data');
      expect(result.strategy).toBe('programmatic');
    });

    it('classifies .instar/*.yaml as structured data', () => {
      const classifier = makeClassifier(tmpDir);
      const result = classifier.classify(path.join(tmpDir, '.instar/config.yaml'));

      expect(result.fileClass).toBe('structured-data');
      expect(result.strategy).toBe('programmatic');
    });

    it('does NOT classify non-.instar JSON as structured data', () => {
      const classifier = makeClassifier(tmpDir);
      const result = classifier.classify(path.join(tmpDir, 'src/data.json'));

      // JSON outside .instar/ isn't guaranteed to have a programmatic strategy
      // It falls through to source code
      expect(result.strategy).toBe('llm');
    });
  });

  // ── Priority Order ──────────────────────────────────────────────

  describe('classification priority', () => {
    it('secret takes priority over lockfile (e.g., .npmrc)', () => {
      const classifier = makeClassifier(tmpDir);
      const result = classifier.classify(path.join(tmpDir, '.npmrc'));

      expect(result.fileClass).toBe('secret');
      expect(result.strategy).toBe('never-sync');
    });

    it('generated takes priority over source code (e.g., dist/app.js)', () => {
      const classifier = makeClassifier(tmpDir);
      const result = classifier.classify(path.join(tmpDir, 'dist/app.js'));

      expect(result.fileClass).toBe('generated');
      expect(result.strategy).toBe('exclude');
    });

    it('lockfile takes priority over JSON (e.g., package-lock.json)', () => {
      const classifier = makeClassifier(tmpDir);
      const result = classifier.classify(path.join(tmpDir, 'package-lock.json'));

      expect(result.fileClass).toBe('lockfile');
      expect(result.strategy).toBe('regenerate');
    });

    it('binary .svg takes priority over markup extensions', () => {
      const classifier = makeClassifier(tmpDir);
      const result = classifier.classify(path.join(tmpDir, 'icon.svg'));

      expect(result.fileClass).toBe('binary');
      expect(result.strategy).toBe('ours-theirs');
    });
  });

  // ── Unknown File Types ──────────────────────────────────────────

  describe('unknown files', () => {
    it('defaults unknown extensions to source-code/llm', () => {
      const classifier = makeClassifier(tmpDir);
      const result = classifier.classify(path.join(tmpDir, 'Makefile'));

      expect(result.fileClass).toBe('source-code');
      expect(result.strategy).toBe('llm');
    });

    it('defaults extensionless files to source-code/llm', () => {
      const classifier = makeClassifier(tmpDir);
      const result = classifier.classify(path.join(tmpDir, 'Dockerfile'));

      expect(result.fileClass).toBe('source-code');
      expect(result.strategy).toBe('llm');
    });
  });

  // ── ClassificationResult shape ──────────────────────────────────

  describe('result shape', () => {
    it('always includes reason string', () => {
      const classifier = makeClassifier(tmpDir);
      const files = ['app.ts', 'image.png', 'package-lock.json', '.env', 'dist/out.js'];

      for (const file of files) {
        const result = classifier.classify(path.join(tmpDir, file));
        expect(result.reason).toBeDefined();
        expect(typeof result.reason).toBe('string');
        expect(result.reason.length).toBeGreaterThan(0);
      }
    });

    it('includes regenCommands only for lockfiles', () => {
      const classifier = makeClassifier(tmpDir);

      const lockResult = classifier.classify(path.join(tmpDir, 'yarn.lock'));
      expect(lockResult.regenCommands).toBeDefined();

      const codeResult = classifier.classify(path.join(tmpDir, 'app.ts'));
      expect(codeResult.regenCommands).toBeUndefined();
    });

    it('includes manifestFile only for lockfiles', () => {
      const classifier = makeClassifier(tmpDir);

      const lockResult = classifier.classify(path.join(tmpDir, 'pnpm-lock.yaml'));
      expect(lockResult.manifestFile).toBe('package.json');

      const codeResult = classifier.classify(path.join(tmpDir, 'app.ts'));
      expect(codeResult.manifestFile).toBeUndefined();
    });
  });
});
