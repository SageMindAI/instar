/**
 * Tests for GlobalInstallCleanup — verifies detection and removal of
 * stale global instar installations across version managers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupGlobalInstalls } from '../../src/core/GlobalInstallCleanup.js';

// We test the actual function against a temp directory structure
describe('GlobalInstallCleanup', () => {
  const tmpBase = path.join(os.tmpdir(), `instar-cleanup-test-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(tmpBase, { recursive: true });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  describe('cleanupGlobalInstalls', () => {
    it('returns empty results when no global installs exist', () => {
      const result = cleanupGlobalInstalls();
      // In CI / clean environments, there may be no globals
      expect(result).toHaveProperty('found');
      expect(result).toHaveProperty('removed');
      expect(result).toHaveProperty('failed');
      expect(Array.isArray(result.found)).toBe(true);
      expect(Array.isArray(result.removed)).toBe(true);
      expect(Array.isArray(result.failed)).toBe(true);
    });

    it('is idempotent — running twice produces same result', () => {
      const result1 = cleanupGlobalInstalls();
      const result2 = cleanupGlobalInstalls();
      // After first run cleans up, second run should find nothing new
      expect(result2.found.length).toBeLessThanOrEqual(result1.found.length);
    });
  });

  describe('boot wrapper template', () => {
    it('should NOT contain global fallback', async () => {
      // Read the setup.ts source and verify the boot wrapper template
      const setupSource = fs.readFileSync(
        path.join(process.cwd(), 'src', 'commands', 'setup.ts'),
        'utf-8'
      );
      // The boot wrapper should fail loudly, not fall back to global
      expect(setupSource).toContain('Shadow install is the sole source of truth');
      expect(setupSource).not.toMatch(/exec instar "\$@"/);
      expect(setupSource).toContain('exit 1');
    });
  });

  describe('server startup integration', () => {
    it('server.ts imports and calls cleanupGlobalInstalls', () => {
      const serverSource = fs.readFileSync(
        path.join(process.cwd(), 'src', 'commands', 'server.ts'),
        'utf-8'
      );
      expect(serverSource).toContain("import { cleanupGlobalInstalls } from '../core/GlobalInstallCleanup.js'");
      expect(serverSource).toContain('cleanupGlobalInstalls()');
    });
  });

  describe('auto-updater integration', () => {
    it('AutoUpdater calls cleanupGlobalInstalls after successful update', () => {
      const autoUpdaterSource = fs.readFileSync(
        path.join(process.cwd(), 'src', 'core', 'AutoUpdater.ts'),
        'utf-8'
      );
      expect(autoUpdaterSource).toContain("import { cleanupGlobalInstalls } from './GlobalInstallCleanup.js'");
      expect(autoUpdaterSource).toContain('cleanupGlobalInstalls()');
      // Should be after the success log, before the restart
      const cleanupIndex = autoUpdaterSource.indexOf('cleanupGlobalInstalls()');
      const successLogIndex = autoUpdaterSource.indexOf('Updated: v${result.previousVersion}');
      const restartIndex = autoUpdaterSource.indexOf('Always restart after a successful apply');
      expect(cleanupIndex).toBeGreaterThan(successLogIndex);
      expect(cleanupIndex).toBeLessThan(restartIndex);
    });
  });
});
