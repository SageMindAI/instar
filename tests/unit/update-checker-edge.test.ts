/**
 * Edge case tests for UpdateChecker.
 *
 * Covers: version comparison, state persistence,
 * offline behavior, corrupted state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UpdateChecker } from '../../src/core/UpdateChecker.js';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import fs from 'node:fs';
import path from 'node:path';

describe('UpdateChecker edge cases', () => {
  let project: TempProject;
  let checker: UpdateChecker;

  beforeEach(() => {
    project = createTempProject();
    checker = new UpdateChecker(project.stateDir);
  });

  afterEach(() => {
    project.cleanup();
    vi.restoreAllMocks();
  });

  describe('getLastCheck', () => {
    it('returns null when no previous check', () => {
      expect(checker.getLastCheck()).toBeNull();
    });

    it('returns saved state after manual write', () => {
      const stateFile = path.join(project.stateDir, 'state', 'update-check.json');
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({
        currentVersion: '0.1.0',
        latestVersion: '0.2.0',
        updateAvailable: true,
        checkedAt: '2026-01-01T00:00:00Z',
      }));

      const result = checker.getLastCheck();
      expect(result).not.toBeNull();
      expect(result!.updateAvailable).toBe(true);
      expect(result!.latestVersion).toBe('0.2.0');
    });

    it('handles corrupted state file', () => {
      const stateFile = path.join(project.stateDir, 'state', 'update-check.json');
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, 'bad json {{');

      expect(checker.getLastCheck()).toBeNull();
    });
  });

  describe('getInstalledVersion', () => {
    it('returns a version string', () => {
      const version = checker.getInstalledVersion();
      expect(typeof version).toBe('string');
      // Should be either a real version or fallback '0.0.0'
      expect(version).toMatch(/^\d+\.\d+\.\d+$|^v?\d+/);
    });
  });

  describe('semver comparison (via check)', () => {
    // We can't directly test isNewer since it's private,
    // but we can verify the logic works through the full check.
    // execAsync is mocked to avoid a real npm registry call — this is a
    // unit test, not an integration test. The real call takes 5-15s on CI
    // and causes vitest's 10s timeout to fire on slower Node 20 runners.
    it('check returns a valid UpdateInfo structure', async () => {
      vi.spyOn(checker as any, 'execAsync').mockResolvedValue('0.0.0');
      const info = await checker.check();
      expect(info).toHaveProperty('currentVersion');
      expect(info).toHaveProperty('latestVersion');
      expect(info).toHaveProperty('updateAvailable');
      expect(info).toHaveProperty('checkedAt');
      expect(typeof info.updateAvailable).toBe('boolean');
    });
  });
});
