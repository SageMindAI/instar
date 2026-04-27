import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';

describe('ProcessIntegrity', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'process-integrity-test-'));
    ProcessIntegrity.reset();
  });

  afterEach(() => {
    ProcessIntegrity.reset();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Core: Version Freezing ──────────────────────────────────────

  describe('version freezing', () => {
    it('runningVersion is frozen at construction time', () => {
      const pi = new ProcessIntegrity('0.9.70');
      expect(pi.runningVersion).toBe('0.9.70');
    });

    it('runningVersion NEVER changes even if disk version changes', () => {
      const pkgPath = path.join(tmpDir, 'package.json');
      fs.writeFileSync(pkgPath, JSON.stringify({ name: 'instar', version: '0.9.70' }));

      const pi = new ProcessIntegrity('0.9.70', pkgPath);
      expect(pi.runningVersion).toBe('0.9.70');

      // Simulate npm install -g updating the package on disk
      fs.writeFileSync(pkgPath, JSON.stringify({ name: 'instar', version: '0.9.71' }));

      // runningVersion must still be 0.9.70 — the code in memory hasn't changed
      expect(pi.runningVersion).toBe('0.9.70');
    });

    it('diskVersion reads live from disk', () => {
      const pkgPath = path.join(tmpDir, 'package.json');
      fs.writeFileSync(pkgPath, JSON.stringify({ name: 'instar', version: '0.9.70' }));

      const pi = new ProcessIntegrity('0.9.70', pkgPath);
      expect(pi.diskVersion).toBe('0.9.70');

      // Update disk
      fs.writeFileSync(pkgPath, JSON.stringify({ name: 'instar', version: '0.9.71' }));
      expect(pi.diskVersion).toBe('0.9.71');
    });

    it('diskVersion falls back to frozen version when no package path', () => {
      const pi = new ProcessIntegrity('0.9.70', null);
      expect(pi.diskVersion).toBe('0.9.70');
    });

    it('diskVersion falls back to frozen version when file is missing', () => {
      const pi = new ProcessIntegrity('0.9.70', '/nonexistent/package.json');
      expect(pi.diskVersion).toBe('0.9.70');
    });

    it('diskVersion falls back to frozen version when file is corrupt', () => {
      const pkgPath = path.join(tmpDir, 'package.json');
      fs.writeFileSync(pkgPath, 'not json!!!');

      const pi = new ProcessIntegrity('0.9.70', pkgPath);
      expect(pi.diskVersion).toBe('0.9.70');
    });

    it('diskVersion falls back when package.json has wrong name', () => {
      const pkgPath = path.join(tmpDir, 'package.json');
      fs.writeFileSync(pkgPath, JSON.stringify({ name: 'something-else', version: '1.0.0' }));

      const pi = new ProcessIntegrity('0.9.70', pkgPath);
      expect(pi.diskVersion).toBe('0.9.70');
    });
  });

  // ── Mismatch Detection ────────────────────────────────────────

  describe('version mismatch detection', () => {
    it('no mismatch when versions are equal', () => {
      const pkgPath = path.join(tmpDir, 'package.json');
      fs.writeFileSync(pkgPath, JSON.stringify({ name: 'instar', version: '0.9.70' }));

      const pi = new ProcessIntegrity('0.9.70', pkgPath);
      expect(pi.versionMismatch).toBe(false);
    });

    it('detects mismatch when disk is ahead', () => {
      const pkgPath = path.join(tmpDir, 'package.json');
      fs.writeFileSync(pkgPath, JSON.stringify({ name: 'instar', version: '0.9.70' }));

      const pi = new ProcessIntegrity('0.9.70', pkgPath);
      expect(pi.versionMismatch).toBe(false);

      // npm install -g updates disk
      fs.writeFileSync(pkgPath, JSON.stringify({ name: 'instar', version: '0.9.71' }));
      expect(pi.versionMismatch).toBe(true);
    });

    it('detects mismatch when disk is behind (rollback)', () => {
      const pkgPath = path.join(tmpDir, 'package.json');
      fs.writeFileSync(pkgPath, JSON.stringify({ name: 'instar', version: '0.9.71' }));

      const pi = new ProcessIntegrity('0.9.71', pkgPath);

      // Rollback on disk
      fs.writeFileSync(pkgPath, JSON.stringify({ name: 'instar', version: '0.9.70' }));
      expect(pi.versionMismatch).toBe(true);
    });

    it('no mismatch when no packageJsonPath provided', () => {
      const pi = new ProcessIntegrity('0.9.70');
      expect(pi.versionMismatch).toBe(false);
    });
  });

  // ── State Reporting ───────────────────────────────────────────

  describe('getState()', () => {
    it('returns complete state object', () => {
      const pi = new ProcessIntegrity('0.9.70');
      const state = pi.getState();

      expect(state.runningVersion).toBe('0.9.70');
      expect(state.diskVersion).toBe('0.9.70');
      expect(state.versionMismatch).toBe(false);
      expect(state.bootedAt).toBeTruthy();
      expect(state.pid).toBe(process.pid);
      expect(state.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });

    it('includes mismatch info when versions differ', () => {
      const pkgPath = path.join(tmpDir, 'package.json');
      fs.writeFileSync(pkgPath, JSON.stringify({ name: 'instar', version: '0.9.71' }));

      const pi = new ProcessIntegrity('0.9.70', pkgPath);
      const state = pi.getState();

      expect(state.runningVersion).toBe('0.9.70');
      expect(state.diskVersion).toBe('0.9.71');
      expect(state.versionMismatch).toBe(true);
    });
  });

  // ── Singleton ─────────────────────────────────────────────────

  describe('singleton', () => {
    it('returns null before initialization', () => {
      expect(ProcessIntegrity.getInstance()).toBeNull();
    });

    it('initialize creates and returns instance', () => {
      const pi = ProcessIntegrity.initialize('0.9.70');
      expect(pi).toBeInstanceOf(ProcessIntegrity);
      expect(pi.runningVersion).toBe('0.9.70');
    });

    it('getInstance returns the initialized instance', () => {
      ProcessIntegrity.initialize('0.9.70');
      const pi = ProcessIntegrity.getInstance();
      expect(pi).not.toBeNull();
      expect(pi!.runningVersion).toBe('0.9.70');
    });

    it('reset clears the singleton', () => {
      ProcessIntegrity.initialize('0.9.70');
      expect(ProcessIntegrity.getInstance()).not.toBeNull();

      ProcessIntegrity.reset();
      expect(ProcessIntegrity.getInstance()).toBeNull();
    });

    it('initialize replaces existing instance', () => {
      ProcessIntegrity.initialize('0.9.70');
      ProcessIntegrity.initialize('0.9.71');
      expect(ProcessIntegrity.getInstance()!.runningVersion).toBe('0.9.71');
    });
  });

  // ── Boot Time ─────────────────────────────────────────────────

  describe('boot time', () => {
    it('captures boot timestamp at construction', () => {
      const before = new Date().toISOString();
      const pi = new ProcessIntegrity('0.9.70');
      const after = new Date().toISOString();

      expect(pi.bootedAt >= before).toBe(true);
      expect(pi.bootedAt <= after).toBe(true);
    });

    it('bootedAt never changes', () => {
      const pi = new ProcessIntegrity('0.9.70');
      const firstRead = pi.bootedAt;

      // Wait a tick
      const secondRead = pi.bootedAt;
      expect(secondRead).toBe(firstRead);
    });
  });
});
