/**
 * Migration CLI commands for Integrated-Being v1.
 *
 * `instar migrate sync-session-hook` — overwrites .claude/hooks/instar/session-start.sh
 * with the latest `PostUpdateMigrator.getSessionStartHook()` output. Used by
 * divergent-local-hook agents (e.g., Echo) to pick up the new /shared-state/render
 * injection after an update.
 *
 * Spec: docs/specs/integrated-being-ledger-v1.md §"Session-start injection".
 */

import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { loadConfig } from '../core/Config.js';
import { PostUpdateMigrator } from '../core/PostUpdateMigrator.js';

export interface SyncSessionHookOptions {
  dir?: string;
  /** Overwrite without prompting. */
  force?: boolean;
  /** Test-only override — supplies config instead of reading from disk. */
  _configOverride?: { projectDir: string; stateDir: string; port: number; projectName: string; hasTelegram?: boolean };
}

/**
 * Entry point for `instar migrate sync-session-hook`.
 * Returns { changed, path, reason } for tests / scripting.
 */
export async function syncSessionHook(
  opts: SyncSessionHookOptions = {},
): Promise<{ changed: boolean; path: string; reason?: string }> {
  const cfg = opts._configOverride ?? (() => {
    const c = loadConfig(opts.dir);
    return {
      projectDir: c.projectDir,
      stateDir: c.stateDir,
      port: c.port,
      projectName: c.projectName,
      hasTelegram: c.messaging?.some((m: { type: string }) => m.type === 'telegram') ?? false,
    };
  })();

  const migrator = new PostUpdateMigrator({
    projectDir: cfg.projectDir,
    stateDir: cfg.stateDir,
    port: cfg.port,
    hasTelegram: cfg.hasTelegram ?? false,
    projectName: cfg.projectName,
  });
  const hookContent = (migrator as unknown as { getSessionStartHook(): string }).getSessionStartHook();

  const hookDir = path.join(cfg.projectDir, '.claude', 'hooks', 'instar');
  const hookPath = path.join(hookDir, 'session-start.sh');

  fs.mkdirSync(hookDir, { recursive: true });

  let existing: string | null = null;
  try { existing = fs.readFileSync(hookPath, 'utf-8'); } catch { /* first install */ }

  if (existing === hookContent) {
    return { changed: false, path: hookPath, reason: 'already up to date' };
  }

  if (existing !== null && !opts.force) {
    // Divergent hook detected — require --force to overwrite
    const divergent = existing.length > 0;
    if (divergent) {
      console.log(pc.yellow(
        `Existing hook at ${hookPath} differs from the default template.`,
      ));
      console.log(pc.yellow(
        `Re-run with --force to overwrite (your custom changes will be replaced).`,
      ));
      return { changed: false, path: hookPath, reason: 'divergent — use --force' };
    }
  }

  fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
  console.log(pc.green(`Wrote ${hookPath}`));
  return { changed: true, path: hookPath };
}
