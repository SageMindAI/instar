/**
 * ParallelDevWiring — composition helper for turning a ParallelDevConfig into
 * a running WorktreeManager (PARALLEL-DEV-ISOLATION-SPEC.md).
 *
 * Kept tiny on purpose so the composition root in `commands/server.ts` stays
 * a one-line call and the wiring logic is unit-testable on its own.
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { ParallelDevConfig } from './types.js';
import { WorktreeKeyVault } from './WorktreeKeyVault.js';
import { WorktreeManager } from './WorktreeManager.js';

export interface ParallelDevWiringOptions {
  config: ParallelDevConfig;
  projectDir: string;
  stateDir: string;
  /** Overridable for tests (defaults to reading `git remote get-url origin`). */
  repoOriginUrlResolver?: (projectDir: string) => string;
  /** Overridable for tests (defaults to `process.env.INSTAR_WORKTREE_PASSPHRASE`). */
  passphraseResolver?: () => Promise<string> | string;
  /** Force keyvault backend (tests only). */
  keyVaultBackend?: 'keychain' | 'flatfile';
}

export interface ParallelDevWiringResult {
  worktreeManager: WorktreeManager;
  shimRoot: string;
}

function defaultRepoOriginUrl(projectDir: string): string {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Builds + initializes a WorktreeManager per the supplied ParallelDevConfig.
 *
 * Returns `null` when `config.phase === 'off'` (caller should skip wiring).
 * Throws when headless-fallback is chosen but no passphrase is reachable
 * (K1 mitigation — no silent weak-key material).
 */
export async function wireParallelDev(
  opts: ParallelDevWiringOptions,
): Promise<ParallelDevWiringResult | null> {
  if (opts.config.phase === 'off') return null;

  const vault = new WorktreeKeyVault({
    stateDir: opts.stateDir,
    headlessAllowed: opts.config.headlessAllowed ?? false,
    passphraseResolver: opts.config.headlessAllowed
      ? (opts.passphraseResolver ?? (() => process.env.INSTAR_WORKTREE_PASSPHRASE ?? ''))
      : undefined,
    forceBackend: opts.keyVaultBackend,
  });
  const keys = await vault.loadOrInit();

  const repoOriginUrl = (opts.repoOriginUrlResolver ?? defaultRepoOriginUrl)(opts.projectDir);

  const worktreeManager = new WorktreeManager({
    projectDir: opts.projectDir,
    stateDir: opts.stateDir,
    signingKey: keys.signing,
    hmacKey: keys.hmacKey,
    machineId: keys.machineId,
    bootId: crypto.randomUUID(),
    repoOriginUrl,
    maxPushDelaySeconds: opts.config.maxPushDelaySeconds,
  });
  worktreeManager.initialize();

  return {
    worktreeManager,
    shimRoot: path.join(opts.stateDir, 'session-shims'),
  };
}
