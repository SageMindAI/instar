/**
 * Tests for `instar ledger cleanup` command (Integrated-Being v1).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ledgerCleanup } from '../../src/commands/ledgerCleanup.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-cleanup-test-'));
}

describe('ledger cleanup', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = tempDir();
    fs.writeFileSync(path.join(stateDir, 'shared-state.jsonl'), '');
    fs.writeFileSync(path.join(stateDir, 'shared-state.jsonl.stats.json'), '{}');
    fs.writeFileSync(path.join(stateDir, 'shared-state.jsonl.1234567890'), '');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('refuses to delete when feature is enabled', async () => {
    const result = await ledgerCleanup({
      _configOverride: { stateDir, enabled: true },
      yes: true,
    });
    expect(result.deleted.length).toBe(0);
    expect(result.reason).toMatch(/still enabled/);
    // Files still exist
    expect(fs.existsSync(path.join(stateDir, 'shared-state.jsonl'))).toBe(true);
  });

  it('dry-runs when --yes is not passed', async () => {
    const result = await ledgerCleanup({
      _configOverride: { stateDir, enabled: false },
    });
    expect(result.deleted.length).toBe(0);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(stateDir, 'shared-state.jsonl'))).toBe(true);
  });

  it('deletes when feature disabled and --yes', async () => {
    const result = await ledgerCleanup({
      _configOverride: { stateDir, enabled: false },
      yes: true,
    });
    expect(result.deleted.length).toBe(3);
    expect(fs.existsSync(path.join(stateDir, 'shared-state.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'shared-state.jsonl.stats.json'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'shared-state.jsonl.1234567890'))).toBe(false);
  });

  it('--force allows deletion even when feature enabled', async () => {
    const result = await ledgerCleanup({
      _configOverride: { stateDir, enabled: true },
      yes: true,
      force: true,
    });
    expect(result.deleted.length).toBe(3);
  });

  it('returns gracefully when no files present', async () => {
    const fresh = tempDir();
    try {
      const result = await ledgerCleanup({
        _configOverride: { stateDir: fresh, enabled: false },
        yes: true,
      });
      expect(result.deleted.length).toBe(0);
    } finally {
      // safe-git-allow: incremental-migration
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});
