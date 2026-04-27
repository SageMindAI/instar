/**
 * Global Install Cleanup
 *
 * Detects and removes global `instar` installations that can cause version
 * confusion. Each agent manages its own version via shadow installs — global
 * binaries are vestigial and actively harmful (agents report stale versions).
 *
 * Runs at server startup and after successful auto-updates.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CleanupResult {
  found: string[];
  removed: string[];
  failed: Array<{ path: string; error: string }>;
}

/**
 * Find all global instar installations across common Node.js version managers
 * and system-wide install locations.
 */
function findGlobalInstalls(): string[] {
  const found: string[] = [];
  const home = os.homedir();

  // ── asdf: ~/.asdf/installs/nodejs/*/lib/node_modules/instar/
  const asdfNodeDir = path.join(home, '.asdf', 'installs', 'nodejs');
  if (fs.existsSync(asdfNodeDir)) {
    try {
      for (const version of fs.readdirSync(asdfNodeDir)) {
        const instarPkg = path.join(asdfNodeDir, version, 'lib', 'node_modules', 'instar', 'package.json');
        if (fs.existsSync(instarPkg)) {
          found.push(path.join(asdfNodeDir, version, 'lib', 'node_modules', 'instar'));
        }
      }
    } catch { /* permission errors, etc. */ }
  }

  // ── nvm: ~/.nvm/versions/node/*/lib/node_modules/instar/
  const nvmNodeDir = path.join(home, '.nvm', 'versions', 'node');
  if (fs.existsSync(nvmNodeDir)) {
    try {
      for (const version of fs.readdirSync(nvmNodeDir)) {
        const instarPkg = path.join(nvmNodeDir, version, 'lib', 'node_modules', 'instar', 'package.json');
        if (fs.existsSync(instarPkg)) {
          found.push(path.join(nvmNodeDir, version, 'lib', 'node_modules', 'instar'));
        }
      }
    } catch { /* permission errors, etc. */ }
  }

  // ── Homebrew (macOS): /opt/homebrew/lib/node_modules/instar/
  const brewPath = '/opt/homebrew/lib/node_modules/instar';
  if (fs.existsSync(path.join(brewPath, 'package.json'))) {
    found.push(brewPath);
  }

  // ── System-wide: /usr/local/lib/node_modules/instar/
  const systemPath = '/usr/local/lib/node_modules/instar';
  if (fs.existsSync(path.join(systemPath, 'package.json'))) {
    found.push(systemPath);
  }

  // ── volta: ~/.volta/tools/image/packages/instar/
  const voltaPath = path.join(home, '.volta', 'tools', 'image', 'packages', 'instar');
  if (fs.existsSync(voltaPath)) {
    found.push(voltaPath);
  }

  return found;
}

/**
 * Remove a global instar installation directory and its bin symlink.
 */
function removeGlobalInstall(installPath: string): void {
  // Remove the package directory
  // safe-git-allow: incremental-migration
  fs.rmSync(installPath, { recursive: true, force: true });

  // Find and remove the corresponding bin symlink.
  // For asdf/nvm: ../../bin/instar relative to lib/node_modules/instar/
  // For system/brew: the bin is at the same prefix level
  const possibleBinPaths = [
    // asdf/nvm layout: lib/node_modules/instar → ../../bin/instar
    path.resolve(installPath, '..', '..', '..', 'bin', 'instar'),
    // homebrew/system layout: lib/node_modules/instar → ../../bin/instar
    path.resolve(installPath, '..', '..', 'bin', 'instar'),
  ];

  for (const binPath of possibleBinPaths) {
    try {
      if (fs.existsSync(binPath)) {
        const stat = fs.lstatSync(binPath);
        if (stat.isSymbolicLink()) {
          // safe-git-allow: incremental-migration
          fs.unlinkSync(binPath);
        }
      }
    } catch { /* best-effort bin cleanup */ }
  }
}

/**
 * Clean up all global instar installations.
 * Safe to run multiple times — idempotent.
 */
export function cleanupGlobalInstalls(): CleanupResult {
  const found = findGlobalInstalls();
  const removed: string[] = [];
  const failed: CleanupResult['failed'] = [];

  for (const installPath of found) {
    try {
      // Read version before removing for logging
      let version = 'unknown';
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(installPath, 'package.json'), 'utf-8'));
        version = pkg.version || 'unknown';
      } catch { /* ok */ }

      removeGlobalInstall(installPath);
      removed.push(`${installPath} (v${version})`);
    } catch (err) {
      failed.push({
        path: installPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Reshim asdf if we removed anything from asdf directories
  if (removed.some(r => r.includes('.asdf'))) {
    try {
      execFileSync('asdf', ['reshim', 'nodejs'], {
        stdio: 'pipe',
        timeout: 10000,
      });
    } catch { /* asdf may not be installed or reshim may fail — non-fatal */ }
  }

  return { found, removed, failed };
}
