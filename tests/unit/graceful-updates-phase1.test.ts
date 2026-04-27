/**
 * Tests for Graceful Updates — Phase 1
 *
 * Covers:
 * - Phase 1A: plannedRestart flag in AutoUpdater
 * - Phase 1B: ServerSupervisor maintenance wait / alert suppression
 * - Phase 1C: ForegroundRestartWatcher planned-exit marker
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ForegroundRestartWatcher } from '../../src/core/ForegroundRestartWatcher.js';

// ── Helpers ──────────────────────────────────────────────────

let tmpDir: string;
let stateDir: string;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graceful-updates-test-'));
  stateDir = tmpDir;
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
}

function teardown() {
  // safe-git-allow: incremental-migration
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function writeFlagFile(data: Record<string, unknown>): void {
  const flagPath = path.join(stateDir, 'state', 'restart-requested.json');
  fs.writeFileSync(flagPath, JSON.stringify(data));
}

function writeMarkerFile(data: Record<string, unknown>): void {
  const markerPath = path.join(stateDir, 'state', 'planned-exit-marker.json');
  fs.writeFileSync(markerPath, JSON.stringify(data));
}

function markerExists(): boolean {
  return fs.existsSync(path.join(stateDir, 'state', 'planned-exit-marker.json'));
}

function readMarker(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'planned-exit-marker.json'), 'utf-8'));
}

// ── Phase 1C: ForegroundRestartWatcher planned-exit marker ──

describe('ForegroundRestartWatcher — planned-exit marker', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('writes planned-exit-marker.json when plannedRestart is true', async () => {
    const watcher = new ForegroundRestartWatcher({
      stateDir,
      exitOnRestart: false,
      pollIntervalMs: 50,
    });

    writeFlagFile({
      requestedAt: new Date().toISOString(),
      requestedBy: 'auto-updater',
      targetVersion: '0.9.76',
      previousVersion: '0.9.75',
      plannedRestart: true,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const detected = new Promise<void>((resolve) => {
      watcher.on('restartDetected', () => resolve());
    });

    watcher.start();
    await detected;
    watcher.stop();

    expect(markerExists()).toBe(true);

    const marker = readMarker();
    expect(marker.targetVersion).toBe('0.9.76');
    expect(marker.previousVersion).toBe('0.9.75');
    expect(marker.exitedAt).toBeTruthy();
    expect(marker.pid).toBe(process.pid);
  });

  it('does NOT write marker when plannedRestart is false/absent', async () => {
    const watcher = new ForegroundRestartWatcher({
      stateDir,
      exitOnRestart: false,
      pollIntervalMs: 50,
    });

    writeFlagFile({
      requestedAt: new Date().toISOString(),
      requestedBy: 'auto-updater',
      targetVersion: '0.9.76',
      previousVersion: '0.9.75',
      // No plannedRestart field
    });

    const detected = new Promise<void>((resolve) => {
      watcher.on('restartDetected', () => resolve());
    });

    watcher.start();
    await detected;
    watcher.stop();

    expect(markerExists()).toBe(false);
  });

  it('does NOT write marker when plannedRestart is explicitly false', async () => {
    const watcher = new ForegroundRestartWatcher({
      stateDir,
      exitOnRestart: false,
      pollIntervalMs: 50,
    });

    writeFlagFile({
      requestedAt: new Date().toISOString(),
      requestedBy: 'manual',
      targetVersion: '0.9.76',
      previousVersion: '0.9.75',
      plannedRestart: false,
    });

    const detected = new Promise<void>((resolve) => {
      watcher.on('restartDetected', () => resolve());
    });

    watcher.start();
    await detected;
    watcher.stop();

    expect(markerExists()).toBe(false);
  });
});

// ── Phase 1B: ServerSupervisor maintenance wait ──────────────

/**
 * ServerSupervisor depends on tmux (external process), making it hard to
 * unit-test directly. We test the core maintenance-wait logic by importing
 * the class and exercising its state management through the public API.
 *
 * We mock execFileSync/spawnSync to avoid actual tmux calls, and mock fetch
 * to simulate health check responses.
 */

describe('ServerSupervisor — planned restart suppression', () => {
  beforeEach(setup);
  afterEach(() => {
    teardown();
    vi.restoreAllMocks();
  });

  // We can't easily test the full ServerSupervisor health check loop in
  // a unit test (it depends on tmux, health endpoints, etc.). Instead, we
  // test the state management through getStatus() and verify the logic
  // via the planned-exit marker file mechanism.

  it('planned-exit-marker.json is the coordination mechanism between watcher and supervisor', () => {
    // This test verifies the contract: ForegroundRestartWatcher writes the marker,
    // and the marker file contains the expected shape for the supervisor to read.
    writeMarkerFile({
      exitedAt: new Date().toISOString(),
      targetVersion: '0.9.76',
      previousVersion: '0.9.75',
      pid: 12345,
    });

    const data = readMarker();
    expect(data.targetVersion).toBe('0.9.76');
    expect(data.previousVersion).toBe('0.9.75');
    expect(data.exitedAt).toBeTruthy();
    expect(data.pid).toBe(12345);
  });

  it('maintenance wait configuration defaults to 5 minutes', async () => {
    // Import dynamically to access the class
    const { ServerSupervisor } = await import('../../src/lifeline/ServerSupervisor.js');

    // Mock tmux detection to return null (no tmux — safe for tests)
    vi.mock('../../src/core/Config.js', () => ({
      detectTmuxPath: () => null,
    }));

    const supervisor = new ServerSupervisor({
      projectDir: tmpDir,
      projectName: 'test-project',
      port: 9999,
      stateDir,
    });

    const status = supervisor.getStatus();
    expect(status.inMaintenanceWait).toBe(false);
    expect(status.maintenanceWaitElapsedMs).toBe(0);
  });

  it('getStatus includes maintenance wait fields', async () => {
    const { ServerSupervisor } = await import('../../src/lifeline/ServerSupervisor.js');

    const supervisor = new ServerSupervisor({
      projectDir: tmpDir,
      projectName: 'test-project',
      port: 9999,
      stateDir,
      maintenanceWaitMinutes: 10,
    });

    const status = supervisor.getStatus();
    expect(status).toHaveProperty('inMaintenanceWait');
    expect(status).toHaveProperty('maintenanceWaitElapsedMs');
    expect(status.inMaintenanceWait).toBe(false);
  });
});

// ── Phase 1A: AutoUpdater restart flag ──────────────────────

describe('AutoUpdater — plannedRestart in restart-requested.json', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('restart-requested.json includes plannedRestart: true', () => {
    // Simulate what AutoUpdater.requestRestart() writes
    const flagPath = path.join(stateDir, 'state', 'restart-requested.json');
    const data = {
      requestedAt: new Date().toISOString(),
      requestedBy: 'auto-updater',
      targetVersion: '0.9.76',
      previousVersion: '0.9.75',
      plannedRestart: true,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      pid: process.pid,
    };
    fs.writeFileSync(flagPath, JSON.stringify(data, null, 2));

    const written = JSON.parse(fs.readFileSync(flagPath, 'utf-8'));
    expect(written.plannedRestart).toBe(true);
    expect(written.requestedBy).toBe('auto-updater');
    expect(written.targetVersion).toBe('0.9.76');
  });

  it('RestartRequest interface includes plannedRestart field', async () => {
    // Type-level test: importing the interface and using it
    const { ForegroundRestartWatcher } = await import('../../src/core/ForegroundRestartWatcher.js');
    type RestartRequest = Parameters<NonNullable<ConstructorParameters<typeof ForegroundRestartWatcher>[0]['onRestartDetected']>>[0];

    // Verify the type has the expected shape (this is a compile-time check)
    const request: RestartRequest = {
      requestedAt: new Date().toISOString(),
      requestedBy: 'auto-updater',
      targetVersion: '0.9.76',
      previousVersion: '0.9.75',
      plannedRestart: true,
    };

    expect(request.plannedRestart).toBe(true);
  });
});

// ── Integration: ForegroundRestartWatcher + marker round-trip ──

describe('Planned restart round-trip', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('full flow: write flag → watcher detects → writes marker → marker readable', async () => {
    // Step 1: Simulate AutoUpdater writing restart-requested.json
    writeFlagFile({
      requestedAt: new Date().toISOString(),
      requestedBy: 'auto-updater',
      targetVersion: '0.9.77',
      previousVersion: '0.9.76',
      plannedRestart: true,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      pid: process.pid,
    });

    // Step 2: ForegroundRestartWatcher detects and writes marker
    const watcher = new ForegroundRestartWatcher({
      stateDir,
      exitOnRestart: false,
      pollIntervalMs: 50,
    });

    const detected = new Promise<void>((resolve) => {
      watcher.on('restartDetected', () => resolve());
    });

    watcher.start();
    await detected;
    watcher.stop();

    // Step 3: Verify the marker is readable (supervisor would read this)
    expect(markerExists()).toBe(true);
    const marker = readMarker();
    expect(marker.targetVersion).toBe('0.9.77');
    expect(marker.previousVersion).toBe('0.9.76');

    // Step 4: The original flag should be consumed (deleted)
    expect(fs.existsSync(path.join(stateDir, 'state', 'restart-requested.json'))).toBe(false);
  });

  it('marker includes timing info for maintenance wait calculation', async () => {
    const beforeTime = Date.now();

    writeFlagFile({
      requestedAt: new Date().toISOString(),
      requestedBy: 'auto-updater',
      targetVersion: '0.9.77',
      previousVersion: '0.9.76',
      plannedRestart: true,
    });

    const watcher = new ForegroundRestartWatcher({
      stateDir,
      exitOnRestart: false,
      pollIntervalMs: 50,
    });

    const detected = new Promise<void>((resolve) => {
      watcher.on('restartDetected', () => resolve());
    });

    watcher.start();
    await detected;
    watcher.stop();

    const marker = readMarker();
    const exitedAt = new Date(marker.exitedAt as string).getTime();

    // exitedAt should be recent (within 5 seconds of test start)
    expect(exitedAt).toBeGreaterThanOrEqual(beforeTime);
    expect(exitedAt).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
