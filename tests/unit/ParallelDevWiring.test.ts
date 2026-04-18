/**
 * ParallelDevWiring composition-root tests.
 *
 * Covers the wiring helper that flips sessions onto worktree-per-topic
 * isolation (PARALLEL-DEV-ISOLATION-SPEC.md §"Composition root").
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wireParallelDev } from '../../src/core/ParallelDevWiring.js';
import { WorktreeManager } from '../../src/core/WorktreeManager.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-wiring-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('wireParallelDev', () => {
  it('returns null when phase="off" — sessions stay on legacy single-tree', async () => {
    const result = await wireParallelDev({
      config: { phase: 'off' },
      projectDir: tmp,
      stateDir: tmp,
    });
    expect(result).toBeNull();
  });

  it('returns a WorktreeManager + shimRoot when phase="shadow"', async () => {
    const result = await wireParallelDev({
      config: { phase: 'shadow', headlessAllowed: true },
      projectDir: tmp,
      stateDir: tmp,
      passphraseResolver: () => 'wiring-test-passphrase-xyz',
      repoOriginUrlResolver: () => 'https://github.com/test/instar.git',
      keyVaultBackend: 'flatfile',
    });
    expect(result).not.toBeNull();
    expect(result!.worktreeManager).toBeInstanceOf(WorktreeManager);
    expect(result!.shimRoot).toBe(path.join(tmp, 'session-shims'));
  });

  it('returns a WorktreeManager when phase="enforce"', async () => {
    const result = await wireParallelDev({
      config: { phase: 'enforce', headlessAllowed: true },
      projectDir: tmp,
      stateDir: tmp,
      passphraseResolver: () => 'wiring-test-passphrase-xyz',
      repoOriginUrlResolver: () => 'https://github.com/test/instar.git',
      keyVaultBackend: 'flatfile',
    });
    expect(result).not.toBeNull();
    expect(result!.worktreeManager).toBeInstanceOf(WorktreeManager);
  });

  it('initialize() is called — worktrees root and bindings dir exist on disk', async () => {
    await wireParallelDev({
      config: { phase: 'shadow', headlessAllowed: true },
      projectDir: tmp,
      stateDir: tmp,
      passphraseResolver: () => 'wiring-test-passphrase-xyz',
      repoOriginUrlResolver: () => '',
      keyVaultBackend: 'flatfile',
    });
    expect(fs.existsSync(path.join(tmp, 'worktrees'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'worktrees', '.snapshots'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'worktrees', '.quarantine'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'local-state'))).toBe(true);
  });

  it('K1: headless mode with missing passphrase fails loudly, not silently', async () => {
    await expect(
      wireParallelDev({
        config: { phase: 'shadow', headlessAllowed: true },
        projectDir: tmp,
        stateDir: tmp,
        passphraseResolver: () => '',
        repoOriginUrlResolver: () => '',
        keyVaultBackend: 'flatfile',
      }),
    ).rejects.toThrow(/passphrase/);
  });

  it('maxPushDelaySeconds propagates to the WorktreeManager', async () => {
    const result = await wireParallelDev({
      config: { phase: 'shadow', headlessAllowed: true, maxPushDelaySeconds: 1234 },
      projectDir: tmp,
      stateDir: tmp,
      passphraseResolver: () => 'wiring-test-passphrase-xyz',
      repoOriginUrlResolver: () => '',
      keyVaultBackend: 'flatfile',
    });
    expect((result!.worktreeManager as unknown as { opts: { maxPushDelaySeconds: number } }).opts.maxPushDelaySeconds).toBe(1234);
  });

  it('default repo-origin resolver does not throw when there is no origin remote', async () => {
    // No git init, no origin — the default resolver should swallow the error and pass ''.
    const result = await wireParallelDev({
      config: { phase: 'shadow', headlessAllowed: true },
      projectDir: tmp,
      stateDir: tmp,
      passphraseResolver: () => 'wiring-test-passphrase-xyz',
      keyVaultBackend: 'flatfile',
      // no repoOriginUrlResolver — use the default
    });
    expect(result).not.toBeNull();
  });
});
