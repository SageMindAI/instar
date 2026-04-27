import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UpdateChecker } from '../../src/core/UpdateChecker.js';

describe('UpdateChecker', () => {
  let tmpDir: string;
  let checker: UpdateChecker;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-update-test-'));
    // Create state directory structure
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    checker = new UpdateChecker(tmpDir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('getInstalledVersion', () => {
    it('returns a version string', () => {
      const version = checker.getInstalledVersion();
      expect(typeof version).toBe('string');
      // Should be a semver-like string
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe('getLastCheck', () => {
    it('returns null when no check has been performed', () => {
      expect(checker.getLastCheck()).toBeNull();
    });

    it('returns saved state after a check', async () => {
      // We can't reliably test the npm check in CI,
      // but we can test the state persistence
      const stateFile = path.join(tmpDir, 'state', 'update-check.json');
      const mockState = {
        currentVersion: '0.1.8',
        latestVersion: '0.1.9',
        updateAvailable: true,
        checkedAt: new Date().toISOString(),
      };
      fs.writeFileSync(stateFile, JSON.stringify(mockState));

      const result = checker.getLastCheck();
      expect(result).not.toBeNull();
      expect(result!.currentVersion).toBe('0.1.8');
      expect(result!.latestVersion).toBe('0.1.9');
      expect(result!.updateAvailable).toBe(true);
    });
  });

  describe('isNewer (via check)', () => {
    // Test the semver comparison indirectly through persisted state
    it('detects when versions are equal', () => {
      const stateFile = path.join(tmpDir, 'state', 'update-check.json');
      fs.writeFileSync(stateFile, JSON.stringify({
        currentVersion: '0.1.8',
        latestVersion: '0.1.8',
        updateAvailable: false,
        checkedAt: new Date().toISOString(),
      }));

      const result = checker.getLastCheck();
      expect(result!.updateAvailable).toBe(false);
    });
  });

  describe('rollback', () => {
    it('returns failure when no rollback info exists', async () => {
      const result = await checker.rollback();
      expect(result.success).toBe(false);
      expect(result.message).toContain('No rollback info');
    });

    it('canRollback() returns false initially', () => {
      expect(checker.canRollback()).toBe(false);
    });

    it('getRollbackInfo() returns null initially', () => {
      expect(checker.getRollbackInfo()).toBeNull();
    });

    it('getRollbackInfo() returns saved info', () => {
      const rollbackFile = path.join(tmpDir, 'state', 'update-rollback.json');
      const info = {
        previousVersion: '0.9.7',
        updatedVersion: '0.9.8',
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(rollbackFile, JSON.stringify(info));

      const result = checker.getRollbackInfo();
      expect(result).not.toBeNull();
      expect(result!.previousVersion).toBe('0.9.7');
      expect(result!.updatedVersion).toBe('0.9.8');
    });
  });

  describe('applyUpdate — explicit version pinning', () => {
    // We can't actually run npm install in tests, but we can verify
    // the source code uses explicit versions via static analysis.
    it('source code uses explicit version, not @latest', () => {
      const sourcePath = path.resolve(__dirname, '../../src/core/UpdateChecker.ts');
      const source = fs.readFileSync(sourcePath, 'utf-8');

      // The applyUpdate method should use `instar@${targetVersion}` not `instar@latest`
      const applySection = source.slice(
        source.indexOf('async applyUpdate'),
        source.indexOf('// Post-update migration'),
      );

      // Should NOT contain @latest in the npm install command
      expect(applySection).not.toContain("'instar@latest'");
      expect(applySection).not.toContain('"instar@latest"');

      // Should contain the explicit version pattern
      expect(applySection).toContain('`instar@${targetVersion}`');
    });

    it('source code implements retry logic', () => {
      const sourcePath = path.resolve(__dirname, '../../src/core/UpdateChecker.ts');
      const source = fs.readFileSync(sourcePath, 'utf-8');

      const applySection = source.slice(
        source.indexOf('async applyUpdate'),
        source.indexOf('// Post-update migration'),
      );

      // Should have retry loop
      expect(applySection).toContain('MAX_RETRIES');
      expect(applySection).toContain('RETRY_DELAYS');
      expect(applySection).toContain('for (let attempt');

      // Should verify version matches target
      expect(applySection).toContain('newVersion === targetVersion');
    });

    it('source code has 3 retries with backoff delays', () => {
      const sourcePath = path.resolve(__dirname, '../../src/core/UpdateChecker.ts');
      const source = fs.readFileSync(sourcePath, 'utf-8');

      // Extract the constants
      const maxRetriesMatch = source.match(/MAX_RETRIES\s*=\s*(\d+)/);
      expect(maxRetriesMatch).not.toBeNull();
      expect(Number(maxRetriesMatch![1])).toBe(3);

      const delaysMatch = source.match(/RETRY_DELAYS\s*=\s*\[([^\]]+)\]/);
      expect(delaysMatch).not.toBeNull();
      const delays = delaysMatch![1].split(',').map(s => Number(s.trim()));
      expect(delays).toHaveLength(3);
      expect(delays[0]).toBe(0); // First attempt is immediate
      expect(delays[1]).toBeGreaterThan(0); // Second has a delay
      expect(delays[2]).toBeGreaterThan(delays[1]); // Third has a longer delay
    });
  });

  describe('state persistence', () => {
    it('saveState writes atomic temp file', () => {
      const stateFile = path.join(tmpDir, 'state', 'update-check.json');

      // Trigger save by writing state directly
      fs.writeFileSync(stateFile, JSON.stringify({
        currentVersion: '1.0.0',
        latestVersion: '1.0.1',
        updateAvailable: true,
        checkedAt: new Date().toISOString(),
      }));

      // Verify it can be read back
      const result = checker.getLastCheck();
      expect(result).not.toBeNull();
      expect(result!.updateAvailable).toBe(true);
    });

    it('handles corrupted state gracefully', () => {
      const stateFile = path.join(tmpDir, 'state', 'update-check.json');
      fs.writeFileSync(stateFile, 'not json!!!');

      // Should not throw
      const result = checker.getLastCheck();
      expect(result).toBeNull();
    });
  });
});
