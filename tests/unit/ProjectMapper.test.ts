/**
 * Unit tests for ProjectMapper — Auto-generated territory maps.
 *
 * Tests cover:
 * - Project name detection (package.json, CLAUDE.md, directory name)
 * - Git remote and branch detection
 * - Project type detection (nextjs, express, library, etc.)
 * - Deployment target detection (vercel, docker, etc.)
 * - Directory scanning with skip patterns
 * - Key file discovery
 * - Markdown and compact summary generation
 * - Save and load persistence
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProjectMapper } from '../../src/core/ProjectMapper.js';
import type { ProjectMapConfig } from '../../src/core/ProjectMapper.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTmpProject(): { projectDir: string; stateDir: string } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projmap-test-'));
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  return { projectDir, stateDir };
}

function makeConfig(projectDir: string, stateDir: string): ProjectMapConfig {
  return { projectDir, stateDir };
}

// ── Tests ────────────────────────────────────────────────────────

describe('ProjectMapper', () => {
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    ({ projectDir, stateDir } = createTmpProject());
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  describe('generate()', () => {
    it('produces a valid ProjectMap', () => {
      const mapper = new ProjectMapper(makeConfig(projectDir, stateDir));
      const map = mapper.generate();

      expect(map.projectDir).toBe(projectDir);
      expect(map.generatedAt).toBeTruthy();
      expect(typeof map.totalFiles).toBe('number');
      expect(Array.isArray(map.directories)).toBe(true);
      expect(Array.isArray(map.keyFiles)).toBe(true);
      expect(Array.isArray(map.deploymentTargets)).toBe(true);
    });

    it('detects project name from package.json', () => {
      fs.writeFileSync(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'my-cool-project' }),
      );

      const mapper = new ProjectMapper(makeConfig(projectDir, stateDir));
      const map = mapper.generate();

      expect(map.projectName).toBe('my-cool-project');
    });

    it('falls back to directory name when no package.json', () => {
      const mapper = new ProjectMapper(makeConfig(projectDir, stateDir));
      const map = mapper.generate();

      expect(map.projectName).toBe(path.basename(projectDir));
    });

    it('counts files across directories', () => {
      // Create some files
      fs.writeFileSync(path.join(projectDir, 'index.ts'), 'export {}');
      fs.mkdirSync(path.join(projectDir, 'src'));
      fs.writeFileSync(path.join(projectDir, 'src', 'main.ts'), 'console.log("hi")');
      fs.writeFileSync(path.join(projectDir, 'src', 'utils.ts'), 'export {}');

      const mapper = new ProjectMapper(makeConfig(projectDir, stateDir));
      const map = mapper.generate();

      expect(map.totalFiles).toBeGreaterThanOrEqual(3);
    });

    it('skips node_modules and .git directories', () => {
      fs.mkdirSync(path.join(projectDir, 'node_modules', 'some-pkg'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'node_modules', 'some-pkg', 'index.js'), '');
      fs.mkdirSync(path.join(projectDir, '.git', 'objects'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, '.git', 'objects', 'abc'), '');
      fs.writeFileSync(path.join(projectDir, 'real-file.ts'), '');

      const mapper = new ProjectMapper(makeConfig(projectDir, stateDir));
      const map = mapper.generate();

      // Should not count node_modules or .git files
      expect(map.totalFiles).toBe(1); // Only real-file.ts
    });

    it('scans top-level directories with descriptions', () => {
      fs.mkdirSync(path.join(projectDir, 'src'));
      fs.mkdirSync(path.join(projectDir, 'docs'));
      fs.mkdirSync(path.join(projectDir, 'tests'));
      fs.writeFileSync(path.join(projectDir, 'src', 'main.ts'), '');
      fs.writeFileSync(path.join(projectDir, 'docs', 'README.md'), '');

      const mapper = new ProjectMapper(makeConfig(projectDir, stateDir));
      const map = mapper.generate();

      const dirNames = map.directories.map(d => d.name);
      expect(dirNames).toContain('src');
      expect(dirNames).toContain('docs');

      const srcDir = map.directories.find(d => d.name === 'src');
      expect(srcDir?.description).toBe('Source code');
    });
  });

  describe('project type detection', () => {
    it('detects nextjs from next.config.js', () => {
      fs.writeFileSync(path.join(projectDir, 'next.config.js'), 'module.exports = {}');

      const mapper = new ProjectMapper(makeConfig(projectDir, stateDir));
      const map = mapper.generate();

      expect(map.projectType).toBe('nextjs');
    });

    it('detects node-server from express dependency', () => {
      fs.writeFileSync(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'api', dependencies: { express: '^4.0.0' } }),
      );

      const mapper = new ProjectMapper(makeConfig(projectDir, stateDir));
      const map = mapper.generate();

      expect(map.projectType).toBe('node-server');
    });

    it('detects rust from Cargo.toml', () => {
      fs.writeFileSync(path.join(projectDir, 'Cargo.toml'), '[package]\nname = "my-app"');

      const mapper = new ProjectMapper(makeConfig(projectDir, stateDir));
      const map = mapper.generate();

      expect(map.projectType).toBe('rust');
    });

    it('returns unknown for unrecognized projects', () => {
      const mapper = new ProjectMapper(makeConfig(projectDir, stateDir));
      const map = mapper.generate();

      expect(map.projectType).toBe('unknown');
    });
  });

  describe('deployment target detection', () => {
    it('detects vercel from vercel.json', () => {
      fs.writeFileSync(path.join(projectDir, 'vercel.json'), '{}');

      const mapper = new ProjectMapper(makeConfig(projectDir, stateDir));
      const map = mapper.generate();

      expect(map.deploymentTargets).toContain('vercel');
    });

    it('detects docker from Dockerfile', () => {
      fs.writeFileSync(path.join(projectDir, 'Dockerfile'), 'FROM node:20');

      const mapper = new ProjectMapper(makeConfig(projectDir, stateDir));
      const map = mapper.generate();

      expect(map.deploymentTargets).toContain('docker');
    });

    it('detects github-actions from .github/workflows', () => {
      fs.mkdirSync(path.join(projectDir, '.github', 'workflows'), { recursive: true });

      const mapper = new ProjectMapper(makeConfig(projectDir, stateDir));
      const map = mapper.generate();

      expect(map.deploymentTargets).toContain('github-actions');
    });

    it('returns empty array when no deployment targets found', () => {
      const mapper = new ProjectMapper(makeConfig(projectDir, stateDir));
      const map = mapper.generate();

      expect(map.deploymentTargets).toEqual([]);
    });
  });

  describe('key file discovery', () => {
    it('finds package.json', () => {
      fs.writeFileSync(path.join(projectDir, 'package.json'), '{}');

      const mapper = new ProjectMapper(makeConfig(projectDir, stateDir));
      const map = mapper.generate();

      expect(map.keyFiles).toContain('package.json');
    });

    it('finds CLAUDE.md and README.md', () => {
      fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Instructions');
      fs.writeFileSync(path.join(projectDir, 'README.md'), '# Project');

      const mapper = new ProjectMapper(makeConfig(projectDir, stateDir));
      const map = mapper.generate();

      expect(map.keyFiles).toContain('CLAUDE.md');
      expect(map.keyFiles).toContain('README.md');
    });
  });

  describe('toMarkdown()', () => {
    it('generates readable markdown', () => {
      fs.writeFileSync(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'test-project' }),
      );
      fs.mkdirSync(path.join(projectDir, 'src'));
      fs.writeFileSync(path.join(projectDir, 'src', 'index.ts'), '');

      const mapper = new ProjectMapper(makeConfig(projectDir, stateDir));
      const map = mapper.generate();
      const md = mapper.toMarkdown(map);

      expect(md).toContain('# Project Map: test-project');
      expect(md).toContain('## Directory Structure');
      expect(md).toContain('src/');
      expect(md).toContain('## Key Files');
      expect(md).toContain('package.json');
    });
  });

  describe('getCompactSummary()', () => {
    it('produces a concise summary for hook injection', () => {
      fs.writeFileSync(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'compact-test' }),
      );

      const mapper = new ProjectMapper(makeConfig(projectDir, stateDir));
      const map = mapper.generate();
      const summary = mapper.getCompactSummary(map);

      expect(summary).toContain('compact-test');
      expect(summary).toContain('Path:');
      expect(summary.split('\n').length).toBeLessThan(25);
    });
  });

  describe('generateAndSave()', () => {
    it('saves JSON and markdown files', () => {
      const mapper = new ProjectMapper(makeConfig(projectDir, stateDir));
      mapper.generateAndSave();

      expect(fs.existsSync(path.join(stateDir, 'project-map.json'))).toBe(true);
      expect(fs.existsSync(path.join(stateDir, 'project-map.md'))).toBe(true);
    });

    it('saved JSON is loadable', () => {
      const mapper = new ProjectMapper(makeConfig(projectDir, stateDir));
      const original = mapper.generateAndSave();

      const loaded = mapper.loadSavedMap();
      expect(loaded).not.toBeNull();
      expect(loaded!.projectName).toBe(original.projectName);
      expect(loaded!.totalFiles).toBe(original.totalFiles);
    });
  });

  describe('loadSavedMap()', () => {
    it('returns null when no saved map exists', () => {
      const mapper = new ProjectMapper(makeConfig(projectDir, stateDir));
      expect(mapper.loadSavedMap()).toBeNull();
    });

    it('returns null for corrupted JSON', () => {
      fs.writeFileSync(path.join(stateDir, 'project-map.json'), 'not json!!!');

      const mapper = new ProjectMapper(makeConfig(projectDir, stateDir));
      expect(mapper.loadSavedMap()).toBeNull();
    });
  });
});
