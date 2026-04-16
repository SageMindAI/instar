/**
 * `instar ledger cleanup` — deletes orphaned Integrated-Being ledger files
 * when the feature is disabled. Safe to run when enabled — it refuses to
 * delete active ledger data unless --force is passed.
 *
 * Spec: docs/specs/integrated-being-ledger-v1.md §"Rollback plan".
 */

import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { loadConfig } from '../core/Config.js';

export interface LedgerCleanupOptions {
  dir?: string;
  /** Skip confirmation prompt. */
  yes?: boolean;
  /** Delete even when the feature is still enabled (dangerous). */
  force?: boolean;
  /** Test-only override. */
  _configOverride?: { stateDir: string; enabled: boolean };
}

export async function ledgerCleanup(
  opts: LedgerCleanupOptions = {},
): Promise<{ deleted: string[]; skipped: string[]; reason?: string }> {
  const cfg = opts._configOverride ?? (() => {
    const c = loadConfig(opts.dir);
    const enabled = c.integratedBeing?.enabled;
    return {
      stateDir: c.stateDir,
      // Default: enabled when undefined
      enabled: enabled === undefined ? true : enabled !== false,
    };
  })();

  // Refuse to run when feature is enabled unless --force
  if (cfg.enabled && !opts.force) {
    console.log(pc.yellow(
      'Integrated-Being ledger is ENABLED. Refusing to delete active ledger data.',
    ));
    console.log(pc.yellow(
      'Either disable it in config (integratedBeing.enabled=false) and re-run, or pass --force.',
    ));
    return { deleted: [], skipped: [], reason: 'feature still enabled' };
  }

  const patterns = [
    'shared-state.jsonl',
    'shared-state.jsonl.stats.json',
    'shared-state.jsonl.prune-lastrun',
  ];
  const stateDir = cfg.stateDir;

  const toDelete: string[] = [];
  try {
    const entries = fs.readdirSync(stateDir);
    for (const name of entries) {
      if (patterns.includes(name) || /^shared-state\.jsonl\.\d+$/.test(name)) {
        toDelete.push(name);
      }
    }
  } catch {
    return { deleted: [], skipped: [], reason: 'stateDir unreadable' };
  }

  if (toDelete.length === 0) {
    console.log(pc.green('No Integrated-Being ledger files to clean up.'));
    return { deleted: [], skipped: [] };
  }

  if (!opts.yes) {
    console.log(pc.yellow(`Would delete ${toDelete.length} file(s):`));
    for (const f of toDelete) console.log(`  ${f}`);
    console.log(pc.yellow('Re-run with --yes to actually delete.'));
    return { deleted: [], skipped: toDelete, reason: 'dry-run — use --yes' };
  }

  const deleted: string[] = [];
  const skipped: string[] = [];
  for (const name of toDelete) {
    try {
      fs.unlinkSync(path.join(stateDir, name));
      deleted.push(name);
    } catch {
      skipped.push(name);
    }
  }
  console.log(pc.green(`Deleted ${deleted.length} ledger file(s).`));
  return { deleted, skipped };
}
