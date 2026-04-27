import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ForegroundRestartWatcher } from '../../src/core/ForegroundRestartWatcher.js';

describe('ForegroundRestartWatcher', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frw-test-'));
    stateDir = tmpDir;
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFlagFile(data: Record<string, unknown>): void {
    const flagPath = path.join(stateDir, 'state', 'restart-requested.json');
    fs.writeFileSync(flagPath, JSON.stringify(data));
  }

  function flagExists(): boolean {
    return fs.existsSync(path.join(stateDir, 'state', 'restart-requested.json'));
  }

  // ── Detection ──────────────────────────────────────────────

  describe('restart detection', () => {
    it('emits restartDetected when flag file exists', async () => {
      const watcher = new ForegroundRestartWatcher({
        stateDir,
        exitOnRestart: false, // Don't actually exit in tests
      });

      writeFlagFile({
        requestedAt: new Date().toISOString(),
        requestedBy: 'auto-updater',
        targetVersion: '0.9.72',
        previousVersion: '0.9.71',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

      const detected = new Promise<any>((resolve) => {
        watcher.on('restartDetected', resolve);
      });

      watcher.start();

      // Wait for the poll cycle (default 10s is too long for tests, so we'll
      // use a short interval in the test setup)
      // Actually, let's just create a watcher with a very short interval
      watcher.stop();

      const fastWatcher = new ForegroundRestartWatcher({
        stateDir,
        exitOnRestart: false,
        pollIntervalMs: 50,
      });

      writeFlagFile({
        requestedAt: new Date().toISOString(),
        requestedBy: 'auto-updater',
        targetVersion: '0.9.72',
        previousVersion: '0.9.71',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

      const detected2 = new Promise<any>((resolve) => {
        fastWatcher.on('restartDetected', resolve);
      });

      fastWatcher.start();
      const data = await detected2;
      fastWatcher.stop();

      expect(data.targetVersion).toBe('0.9.72');
      expect(data.previousVersion).toBe('0.9.71');
      expect(data.requestedBy).toBe('auto-updater');
    });

    it('calls onRestartDetected callback', async () => {
      const callback = vi.fn();

      const watcher = new ForegroundRestartWatcher({
        stateDir,
        exitOnRestart: false,
        pollIntervalMs: 50,
        onRestartDetected: callback,
      });

      writeFlagFile({
        requestedAt: new Date().toISOString(),
        requestedBy: 'auto-updater',
        targetVersion: '0.9.72',
        previousVersion: '0.9.71',
      });

      const detected = new Promise<void>((resolve) => {
        watcher.on('restartDetected', () => resolve());
      });

      watcher.start();
      await detected;
      watcher.stop();

      expect(callback).toHaveBeenCalledOnce();
      expect(callback.mock.calls[0][0].targetVersion).toBe('0.9.72');
    });

    it('clears the flag file after detection', async () => {
      const watcher = new ForegroundRestartWatcher({
        stateDir,
        exitOnRestart: false,
        pollIntervalMs: 50,
      });

      writeFlagFile({
        requestedAt: new Date().toISOString(),
        requestedBy: 'auto-updater',
        targetVersion: '0.9.72',
        previousVersion: '0.9.71',
      });

      expect(flagExists()).toBe(true);

      const detected = new Promise<void>((resolve) => {
        watcher.on('restartDetected', () => resolve());
      });

      watcher.start();
      await detected;
      watcher.stop();

      expect(flagExists()).toBe(false);
    });

    it('does nothing when no flag file exists', async () => {
      const callback = vi.fn();
      const watcher = new ForegroundRestartWatcher({
        stateDir,
        exitOnRestart: false,
        pollIntervalMs: 50,
        onRestartDetected: callback,
      });

      watcher.start();

      // Wait a few poll cycles
      await new Promise(resolve => setTimeout(resolve, 200));
      watcher.stop();

      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ── Expired flag handling ──────────────────────────────────

  describe('expired flag handling', () => {
    it('STILL acts on expired flags — stale process is worse than late restart', async () => {
      const callback = vi.fn();
      const watcher = new ForegroundRestartWatcher({
        stateDir,
        exitOnRestart: false,
        pollIntervalMs: 50,
        onRestartDetected: callback,
      });

      // Write an expired flag
      writeFlagFile({
        requestedAt: new Date(Date.now() - 20 * 60_000).toISOString(), // 20 min ago
        requestedBy: 'auto-updater',
        targetVersion: '0.9.72',
        previousVersion: '0.9.71',
        expiresAt: new Date(Date.now() - 10 * 60_000).toISOString(), // expired 10 min ago
      });

      const detected = new Promise<void>((resolve) => {
        watcher.on('restartDetected', () => resolve());
      });

      watcher.start();
      await detected;
      watcher.stop();

      // Key assertion: expired flag was still acted on
      expect(callback).toHaveBeenCalledOnce();
      expect(callback.mock.calls[0][0].targetVersion).toBe('0.9.72');
    });
  });

  // ── Malformed flag handling ────────────────────────────────

  describe('malformed flag handling', () => {
    it('cleans up malformed flag file', async () => {
      const watcher = new ForegroundRestartWatcher({
        stateDir,
        exitOnRestart: false,
        pollIntervalMs: 50,
      });

      // Write malformed JSON
      const flagPath = path.join(stateDir, 'state', 'restart-requested.json');
      fs.writeFileSync(flagPath, 'not json!!!');

      watcher.start();
      await new Promise(resolve => setTimeout(resolve, 200));
      watcher.stop();

      // Flag should be cleaned up
      expect(flagExists()).toBe(false);
    });
  });

  // ── Idempotency ────────────────────────────────────────────

  describe('idempotency', () => {
    it('only fires once per flag file', async () => {
      const callback = vi.fn();
      const watcher = new ForegroundRestartWatcher({
        stateDir,
        exitOnRestart: false,
        pollIntervalMs: 50,
        onRestartDetected: callback,
      });

      writeFlagFile({
        requestedAt: new Date().toISOString(),
        requestedBy: 'auto-updater',
        targetVersion: '0.9.72',
        previousVersion: '0.9.71',
      });

      watcher.start();
      // Wait for multiple poll cycles
      await new Promise(resolve => setTimeout(resolve, 300));
      watcher.stop();

      // Should only fire once — flag is cleared after first detection
      expect(callback).toHaveBeenCalledOnce();
    });
  });

  // ── Lifecycle ──────────────────────────────────────────────

  describe('lifecycle', () => {
    it('stop prevents further polling', async () => {
      const callback = vi.fn();
      const watcher = new ForegroundRestartWatcher({
        stateDir,
        exitOnRestart: false,
        pollIntervalMs: 50,
        onRestartDetected: callback,
      });

      watcher.start();
      watcher.stop();

      // Write flag AFTER stopping
      writeFlagFile({
        requestedAt: new Date().toISOString(),
        requestedBy: 'auto-updater',
        targetVersion: '0.9.72',
        previousVersion: '0.9.71',
      });

      await new Promise(resolve => setTimeout(resolve, 200));
      expect(callback).not.toHaveBeenCalled();
    });

    it('start is idempotent', () => {
      const watcher = new ForegroundRestartWatcher({
        stateDir,
        exitOnRestart: false,
        pollIntervalMs: 50,
      });

      // Starting twice should not create duplicate intervals
      watcher.start();
      watcher.start();
      watcher.stop();
    });
  });
});
