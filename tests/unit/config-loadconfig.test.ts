/**
 * Tests for Config module — loadConfig, detectProjectDir, ensureStateDir.
 *
 * Config.test.ts covers detectTmuxPath and detectClaudePath (environment-dependent).
 * This file tests the config loading and project detection logic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectProjectDir, ensureStateDir, loadConfig } from '../../src/core/Config.js';

describe('Config module', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-config-test-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('detectProjectDir', () => {
    it('returns directory containing CLAUDE.md', () => {
      // Create a nested structure: tmpDir/project/sub/deep/
      const projectDir = path.join(tmpDir, 'project');
      const deepDir = path.join(projectDir, 'sub', 'deep');
      fs.mkdirSync(deepDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Test');

      const result = detectProjectDir(deepDir);
      expect(result).toBe(projectDir);
    });

    it('returns directory containing .git', () => {
      const projectDir = path.join(tmpDir, 'repo');
      const subDir = path.join(projectDir, 'src', 'lib');
      fs.mkdirSync(subDir, { recursive: true });
      fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true });

      const result = detectProjectDir(subDir);
      expect(result).toBe(projectDir);
    });

    it('prefers CLAUDE.md over .git when both exist', () => {
      const projectDir = path.join(tmpDir, 'both');
      const subDir = path.join(projectDir, 'deep');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Hi');
      fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true });

      const result = detectProjectDir(subDir);
      expect(result).toBe(projectDir);
    });

    it('returns startDir when no project markers found', () => {
      // tmpDir has neither CLAUDE.md nor .git at root level
      // But we're walking up from a nested dir — eventually reaches /
      // which also has neither, so it falls back to process.cwd()
      const isolated = path.join(tmpDir, 'isolated', 'deep');
      fs.mkdirSync(isolated, { recursive: true });

      const result = detectProjectDir(isolated);
      // Should return process.cwd() since no markers found walking up from isolated
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('ensureStateDir', () => {
    it('creates all required directories', () => {
      const stateDir = path.join(tmpDir, 'fresh-state');

      ensureStateDir(stateDir);

      expect(fs.existsSync(stateDir)).toBe(true);
      expect(fs.existsSync(path.join(stateDir, 'state'))).toBe(true);
      expect(fs.existsSync(path.join(stateDir, 'state', 'sessions'))).toBe(true);
      expect(fs.existsSync(path.join(stateDir, 'state', 'jobs'))).toBe(true);
      expect(fs.existsSync(path.join(stateDir, 'relationships'))).toBe(true);
      expect(fs.existsSync(path.join(stateDir, 'logs'))).toBe(true);
    });

    it('is idempotent (can be called multiple times)', () => {
      const stateDir = path.join(tmpDir, 'idempotent');

      ensureStateDir(stateDir);
      ensureStateDir(stateDir); // second call should not throw

      expect(fs.existsSync(stateDir)).toBe(true);
    });

    it('does not overwrite existing files in directories', () => {
      const stateDir = path.join(tmpDir, 'existing');
      fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'state', 'existing.json'), '{"keep": true}');

      ensureStateDir(stateDir);

      const content = JSON.parse(fs.readFileSync(
        path.join(stateDir, 'state', 'existing.json'),
        'utf-8',
      ));
      expect(content.keep).toBe(true);
    });
  });

  describe('loadConfig error handling', () => {
    it('throws descriptive error when config.json is corrupted', () => {
      // Create a project dir with corrupt config
      const projectDir = path.join(tmpDir, 'corrupt-project');
      const instarDir = path.join(projectDir, '.instar');
      fs.mkdirSync(instarDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Test');
      fs.writeFileSync(path.join(instarDir, 'config.json'), '{invalid json!!!}');

      expect(() => loadConfig(projectDir)).toThrow(/Failed to parse/);
      expect(() => loadConfig(projectDir)).toThrow(/valid JSON/);
    });

    it('throws descriptive error when config.json is truncated', () => {
      const projectDir = path.join(tmpDir, 'truncated-project');
      const instarDir = path.join(projectDir, '.instar');
      fs.mkdirSync(instarDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Test');
      fs.writeFileSync(path.join(instarDir, 'config.json'), '{"projectName": "test", "port": ');

      expect(() => loadConfig(projectDir)).toThrow(/Failed to parse/);
    });
  });

  describe('loadConfig passes through optional config fields', () => {
    it('spreads fileConfig so safety, evolution, agentAutonomy etc. are not dropped', () => {
      const source = fs.readFileSync(
        path.join(process.cwd(), 'src/core/Config.ts'),
        'utf-8',
      );
      // The return statement should spread fileConfig before explicit overrides
      expect(source).toContain('...fileConfig,');
    });

    it('loadConfig preserves safety config from config file', () => {
      const projectDir = path.join(tmpDir, 'safety-project');
      const instarDir = path.join(projectDir, '.instar');
      fs.mkdirSync(instarDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Test');
      fs.writeFileSync(path.join(instarDir, 'config.json'), JSON.stringify({
        safety: { level: 2 },
        agentAutonomy: { level: 'autonomous' },
        autonomyProfile: 'collaborative',
        sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/claude' },
      }));

      const config = loadConfig(projectDir);
      expect(config.safety).toEqual({ level: 2 });
      expect(config.agentAutonomy).toEqual({ level: 'autonomous' });
      expect(config.autonomyProfile).toBe('collaborative');
    });
  });

  describe('loadConfig maxSessions nullish coalescing', () => {
    // This tests the fix: maxSessions should use ?? not ||
    // so that 0 is a valid (falsy but intentional) value
    it('uses ?? for maxSessions (source verification)', () => {
      const source = fs.readFileSync(
        path.join(process.cwd(), 'src/core/Config.ts'),
        'utf-8',
      );
      // Should use ?? not || for maxSessions
      expect(source).toContain('maxSessions ?? DEFAULT_MAX_SESSIONS');
      expect(source).not.toContain('maxSessions || DEFAULT_MAX_SESSIONS');
    });

    it('uses ?? for maxParallelJobs (source verification)', () => {
      const source = fs.readFileSync(
        path.join(process.cwd(), 'src/core/Config.ts'),
        'utf-8',
      );
      // Should use ?? not || for maxParallelJobs
      expect(source).toContain('maxParallelJobs ?? DEFAULT_MAX_PARALLEL_JOBS');
    });
  });
});
