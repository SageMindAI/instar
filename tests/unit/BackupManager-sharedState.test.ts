/**
 * Tests the Integrated-Being v1 additions to BackupManager:
 *  - `shared-state.jsonl*` glob is expanded at snapshot time
 *  - The pattern is gated by config.integratedBeing.enabled
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BackupManager } from '../../src/core/BackupManager.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'backup-sharedstate-test-'));
}

describe('BackupManager — shared-state.jsonl* glob', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = tempDir();
    // Write the core state files the default config includes
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Agent');
    fs.writeFileSync(path.join(stateDir, 'MEMORY.md'), '# Mem');
    fs.writeFileSync(path.join(stateDir, 'jobs.json'), '{}');
    fs.writeFileSync(path.join(stateDir, 'users.json'), '[]');
    // Shared-state ledger + two rotated archives
    fs.writeFileSync(path.join(stateDir, 'shared-state.jsonl'), 'line1\n');
    fs.writeFileSync(path.join(stateDir, 'shared-state.jsonl.1000'), 'old\n');
    fs.writeFileSync(path.join(stateDir, 'shared-state.jsonl.2000'), 'older\n');
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('includes all shared-state files when integrated-being enabled', () => {
    const mgr = new BackupManager(stateDir, undefined, undefined, () => true);
    const snap = mgr.createSnapshot('manual');
    expect(snap.files).toContain('shared-state.jsonl');
    expect(snap.files).toContain('shared-state.jsonl.1000');
    expect(snap.files).toContain('shared-state.jsonl.2000');
  });

  it('excludes shared-state files when integrated-being disabled', () => {
    const mgr = new BackupManager(stateDir, undefined, undefined, () => false);
    const snap = mgr.createSnapshot('manual');
    expect(snap.files.some((f) => f.startsWith('shared-state.jsonl'))).toBe(false);
    // Non-ledger files still backed up
    expect(snap.files).toContain('AGENT.md');
  });

  it('defaults to including when gate callback is omitted (backwards-compat)', () => {
    const mgr = new BackupManager(stateDir);
    const snap = mgr.createSnapshot('manual');
    expect(snap.files).toContain('shared-state.jsonl');
  });
});
