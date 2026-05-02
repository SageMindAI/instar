/**
 * Update Checker — detects, understands, and applies updates intelligently.
 *
 * Part of the Dawn → Agents push layer: when Dawn publishes an update,
 * agents detect it, understand what changed, communicate with their user,
 * and optionally apply it automatically.
 *
 * Flow: detect → understand → communicate → execute → verify → report
 *
 * Uses `npm view instar version` to check the registry and
 * GitHub releases API for changelogs.
 */

import { execFile, execFileSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UpdateInfo, UpdateResult } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { PostUpdateMigrator } from './PostUpdateMigrator.js';
import type { MigratorConfig } from './PostUpdateMigrator.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/JKHeadley/instar/releases';

export interface RollbackResult {
  success: boolean;
  previousVersion: string;
  restoredVersion: string;
  message: string;
}

export interface UpdateCheckerConfig {
  stateDir: string;
  /** Required for post-update migrations */
  projectDir?: string;
  /** Server port for capability URLs in migrated files */
  port?: number;
  /** Whether Telegram is configured */
  hasTelegram?: boolean;
  /** Project name for migrated files */
  projectName?: string;
}

export class UpdateChecker {
  private stateDir: string;
  private stateFile: string;
  private rollbackFile: string;
  private migratorConfig: MigratorConfig | null;
  /** Cached version from first read — represents the RUNNING process version,
   *  not the potentially-updated-on-disk version. This is critical: after
   *  `npm install -g` replaces files in-place, reading package.json from disk
   *  returns the NEW version, but the running process still has OLD code in memory.
   *  Caching prevents false "already up to date" results. */
  private cachedInstalledVersion: string | null = null;

  constructor(config: string | UpdateCheckerConfig) {
    // Backwards-compatible: accept plain string (stateDir) or config object
    if (typeof config === 'string') {
      this.stateDir = config;
      this.migratorConfig = null;
    } else {
      this.stateDir = config.stateDir;
      this.migratorConfig = config.projectDir ? {
        projectDir: config.projectDir,
        stateDir: config.stateDir,
        port: config.port ?? 4040,
        hasTelegram: config.hasTelegram ?? false,
        projectName: config.projectName ?? 'agent',
      } : null;
    }
    this.stateFile = path.join(this.stateDir, 'state', 'update-check.json');
    this.rollbackFile = path.join(this.stateDir, 'state', 'update-rollback.json');
  }

  /**
   * Check npm for the latest version, fetch changelog, and compare to installed.
   */
  async check(): Promise<UpdateInfo> {
    const currentVersion = this.getInstalledVersion();
    let latestVersion: string;

    try {
      latestVersion = await this.execAsync('npm', ['view', 'instar', 'version'], 15000);
    } catch {
      // Offline or registry error — return last known state
      const lastState = this.getLastCheck();
      if (lastState) return lastState;

      return {
        currentVersion,
        latestVersion: currentVersion,
        updateAvailable: false,
        checkedAt: new Date().toISOString(),
      };
    }

    const updateAvailable = this.isNewer(latestVersion, currentVersion);

    const info: UpdateInfo = {
      currentVersion,
      latestVersion,
      updateAvailable,
      checkedAt: new Date().toISOString(),
      changelogUrl: `https://github.com/JKHeadley/instar/releases`,
    };

    // Fetch changelog if update is available
    if (updateAvailable) {
      try {
        info.changeSummary = await this.fetchChangelog(latestVersion);
      } catch {
        // @silent-fallback-ok — changelog fetch optional
      }
    }

    this.saveState(info);
    return info;
  }

  /**
   * Apply the update: install to a local shadow directory, verify, and restart.
   *
   * IMPORTANT: Does NOT use `npm install -g`. Each agent manages its own version
   * via a local shadow install at `{stateDir}/shadow-install/`. This prevents
   * global install pollution, version drift across agents, and npx cache conflicts.
   *
   * Uses explicit version pinning (not @latest) to avoid npm CDN propagation
   * delays where @latest still resolves to the old version for several minutes
   * after a new version is published. Retries up to 3 times with backoff.
   */
  async applyUpdate(): Promise<UpdateResult> {
    const previousVersion = this.getInstalledVersion();

    // Check what the registry has. Note: even if getInstalledVersion() returns
    // the latest (e.g., after a previous install updated files in place),
    // we still need to install+restart since the running process has old code.
    // The caller (AutoUpdater) is responsible for loop prevention.
    const info = await this.check();
    if (!info.updateAvailable) {
      // Files on disk match the registry — but running code may be stale.
      // Return success with restartNeeded based on whether the process version
      // (captured at the start of this call) differs from what's on disk now.
      const needsRestart = previousVersion !== info.latestVersion;
      return {
        success: true,
        previousVersion,
        newVersion: info.latestVersion,
        message: needsRestart
          ? `Files already at v${info.latestVersion} (running v${previousVersion}). Restart needed.`
          : `Already up to date (v${previousVersion}).`,
        restartNeeded: needsRestart,
        healthCheck: 'skipped',
      };
    }

    // Use explicit version pin — `@latest` tag has CDN propagation delay
    // that can cause installs to silently resolve to the old version.
    const targetVersion = info.latestVersion;
    const MAX_RETRIES = 3;
    const RETRY_DELAYS = [0, 5000, 15000]; // immediate, 5s, 15s

    let lastError: string | null = null;
    let newVersion = 'unknown';

    // Install to local shadow directory — each agent owns its version
    const shadowDir = path.join(this.stateDir, 'shadow-install');
    fs.mkdirSync(shadowDir, { recursive: true });

    // Ensure shadow dir has a package.json (npm install requires it)
    const shadowPkgPath = path.join(shadowDir, 'package.json');
    if (!fs.existsSync(shadowPkgPath)) {
      fs.writeFileSync(shadowPkgPath, JSON.stringify({ name: 'instar-shadow', private: true }, null, 2));
    }

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        console.log(`[UpdateChecker] Retry ${attempt}/${MAX_RETRIES - 1} after ${RETRY_DELAYS[attempt]}ms...`);
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
      }

      try {
        // Install to local shadow directory instead of global.
        // --ignore-scripts prevents cloudflared's postinstall binary download from
        // failing with ENOENT in environments where the download path doesn't exist.
        // The cloudflared binary is installed lazily on-demand by TunnelManager when
        // the tunnel feature is first used (via install(bin) from the cloudflared package).
        await this.execAsync('npm', [
          'install', `instar@${targetVersion}`,
          '--ignore-scripts',
          '--prefix', shadowDir,
        ], 120000);

        // Rebuild native modules after --ignore-scripts installation.
        // --ignore-scripts skips better-sqlite3's build step, leaving no .node binaries.
        // Without this, TopicMemory and SemanticMemory fail silently on shadow installs.
        // better-sqlite3 uses node-gyp and can rebuild from source in ~30 seconds.
        try {
          await this.execAsync('npm', [
            'rebuild', 'better-sqlite3',
            '--prefix', shadowDir,
          ], 60000);
          console.log(`[UpdateChecker] Rebuilt better-sqlite3 native bindings in shadow install`);
        } catch (rebuildErr) {
          // Non-fatal: fallback SQLite behavior (legacy JSONL) handles the case
          console.warn(`[UpdateChecker] better-sqlite3 rebuild failed (legacy fallback active): ${rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr)}`);
        }

        // Strip extended attributes on macOS that may block launchd's restricted sandbox.
        // com.apple.quarantine can cause EPERM; com.apple.provenance is kernel-protected
        // on macOS 15+ (Sequoia) and can't actually be removed, but the attempt is harmless.
        if (os.platform() === 'darwin') {
          for (const attr of ['com.apple.quarantine', 'com.apple.provenance']) {
            try {
              execFileSync('xattr', ['-rd', attr, shadowDir], { stdio: 'ignore' });
            } catch {
              // Non-fatal: attribute may not exist or may be kernel-protected
            }
          }
          console.log(`[UpdateChecker] Attempted xattr cleanup on shadow install`);
        }

        // Pre-restart validation: verify node can actually load the new CLI.
        // If this fails, the update installed but the binary is inaccessible
        // (e.g., launchd sandbox restrictions). Better to detect now than crash-loop.
        const newCliPath = path.join(shadowDir, 'node_modules', 'instar', 'dist', 'cli.js');
        try {
          execFileSync(process.execPath, ['-e', `require("fs").readFileSync(${JSON.stringify(newCliPath)})`], {
            stdio: 'ignore',
            timeout: 10000,
          });
        } catch (accessErr) {
          console.error(`[UpdateChecker] WARNING: New CLI at ${newCliPath} is not accessible by node: ${accessErr instanceof Error ? accessErr.message : String(accessErr)}`);
          console.error(`[UpdateChecker] The update was installed but may fail on restart. Check file permissions and macOS security settings.`);
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        continue;
      }

      // Verify the update was applied by reading the local install
      try {
        const localPkgPath = path.join(shadowDir, 'node_modules', 'instar', 'package.json');
        if (fs.existsSync(localPkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(localPkgPath, 'utf-8'));
          newVersion = pkg.version || 'unknown';
        }
      } catch {
        newVersion = 'unknown';
      }

      if (newVersion === targetVersion) {
        break; // Success
      }

      lastError = `Installed version is ${newVersion}, expected ${targetVersion}`;
      console.log(`[UpdateChecker] Attempt ${attempt + 1}: ${lastError}`);
    }

    const success = newVersion === targetVersion;

    // Save rollback info on successful update
    if (success) {
      this.saveRollbackInfo(previousVersion, newVersion);
    }

    // Post-update migration: run migrations using the NEW binary.
    // Critical: the old process has stale modules in memory — only the
    // new binary on disk has the latest PostUpdateMigrator entries.
    // This now also processes upgrade guides (Layer 2: intelligent knowledge).
    //
    // Resolution: use the shadow install's cli.js directly — no global prefix needed.
    let migrationSummary = '';
    let upgradeGuideNote = '';
    if (success && this.migratorConfig) {
      try {
        // Resolve the newly installed cli.js from the shadow install
        let cmd = 'instar';
        let baseArgs: string[] = [];
        const shadowCliJs = path.join(shadowDir, 'node_modules', 'instar', 'dist', 'cli.js');
        if (fs.existsSync(shadowCliJs)) {
          // Run the exact installed cli.js with the current Node.js runtime.
          // Guard: process.execPath can point at a deleted binary when Node was
          // upgraded while this process was still running (common on Homebrew —
          // Cellar/node@22/22.22.2/bin/node vanishes after `brew upgrade node`).
          // Fall back to 'node' on PATH when the resolved execPath is gone.
          cmd = fs.existsSync(process.execPath) ? process.execPath : 'node';
          baseArgs = [shadowCliJs];
        }

        let output: string;
        try {
          const args = [...baseArgs, 'migrate'];
          if (this.migratorConfig.projectDir) args.push('--dir', this.migratorConfig.projectDir);
          output = await this.execAsync(cmd, args, 30000);
        } catch (dirErr) {
          const dirErrMsg = dirErr instanceof Error ? dirErr.message : String(dirErr);
          const dirErrStderr = (dirErr as Error & { stderr?: string }).stderr || '';
          if (dirErrMsg.includes('unknown option') && dirErrMsg.includes('--dir')) {
            // Old binary — retry without --dir
            output = await this.execAsync(cmd, [...baseArgs, 'migrate'], 30000);
          } else if (dirErrStderr.includes('unknown command')) {
            // Very old binary without migrate command — skip CLI migration gracefully.
            // The in-memory migrator still runs as a safety net on server startup.
            output = JSON.stringify({ upgraded: [], errors: [] });
          } else {
            throw dirErr;
          }
        }
        // Guard: old binaries may run a default command (e.g., setup wizard) instead of
        // recognizing 'migrate', exiting 0 but returning non-JSON text. Treat parse
        // failures the same as "unknown command" — use the in-memory fallback quietly.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let migration: any;
        try {
          migration = JSON.parse(output);
        } catch { // @silent-fallback-ok — old binary returned non-JSON; graceful skip, no degradation
          migration = { upgraded: [], errors: [] };
        }
        if (migration.upgraded && migration.upgraded.length > 0) {
          migrationSummary = ` Intelligence download: ${migration.upgraded.length} files upgraded (${migration.upgraded.join(', ')}).`;
        }
        if (migration.errors && migration.errors.length > 0) {
          migrationSummary += ` Migration warnings: ${migration.errors.join('; ')}.`;
        }
        // Upgrade guide delivery
        if (migration.upgradeGuide) {
          const versions = migration.upgradeGuide.versions as string[];
          upgradeGuideNote = `\n\nUpgrade guide available for: ${versions.join(', ')}. ` +
            `Read and process the guide at your next session start, or read .instar/state/pending-upgrade-guide.md now.`;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errStderr = (err as Error & { stderr?: string }).stderr || '';
        // If the binary doesn't support the migrate command at all (very old version),
        // or returned non-JSON output (old binary ran a different default command),
        // skip silently — the in-memory migrator on server startup handles it.
        const isNonJsonOutput = errMsg.includes('is not valid JSON') || errMsg.includes('JSON') || errMsg.includes('Unexpected token');
        const isMissingCommand = errStderr.includes('unknown command') || errMsg.includes('unknown command') || isNonJsonOutput;
        // Report degradation early (before fallback) for unexpected failures only
        if (!isMissingCommand) {
          const detail = errStderr ? ` (stderr: ${errStderr.slice(0, 200)})` : '';
          DegradationReporter.getInstance().report({
            feature: 'UpdateChecker.postUpdateMigration',
            primary: 'Run post-update migrations',
            fallback: 'Migration skipped — data may not be upgraded',
            reason: `Why: ${errMsg}${detail}`,
            impact: 'Agent configuration may be stale after update',
          });
        }
        // Fallback: run in-memory migrator (better than nothing)
        try {
          const migrator = new PostUpdateMigrator(this.migratorConfig);
          const migration = migrator.migrate();
          if (migration.upgraded.length > 0) {
            migrationSummary = ` Intelligence download (fallback): ${migration.upgraded.length} files upgraded (${migration.upgraded.join(', ')}).`;
          }
        } catch (fallbackErr) {
          migrationSummary = ` Post-update migration failed: ${errMsg}.`;
        }
      }
    }

    return {
      success,
      previousVersion,
      newVersion,
      message: success
        ? `Updated from v${previousVersion} to v${newVersion}.${migrationSummary}${upgradeGuideNote} ${info.changeSummary || 'Restart to use the new version.'}`
        : `Update command ran but version didn't change (still v${previousVersion}). May need manual intervention.`,
      restartNeeded: success,
      healthCheck: 'skipped', // Can't check health until after restart
    };
  }

  /**
   * Roll back to the previous version.
   * Only available after a successful update has saved rollback info.
   */
  async rollback(): Promise<RollbackResult> {
    const rollbackInfo = this.getRollbackInfo();
    if (!rollbackInfo) {
      return {
        success: false,
        previousVersion: this.getInstalledVersion(),
        restoredVersion: this.getInstalledVersion(),
        message: 'No rollback info available. A successful update must have occurred first.',
      };
    }

    const currentVersion = this.getInstalledVersion();

    // Install rollback version to shadow directory
    const shadowDir = path.join(this.stateDir, 'shadow-install');
    fs.mkdirSync(shadowDir, { recursive: true });

    const shadowPkgPath = path.join(shadowDir, 'package.json');
    if (!fs.existsSync(shadowPkgPath)) {
      fs.writeFileSync(shadowPkgPath, JSON.stringify({ name: 'instar-shadow', private: true }, null, 2));
    }

    try {
      await this.execAsync('npm', [
        'install', `instar@${rollbackInfo.previousVersion}`,
        '--ignore-scripts',
        '--prefix', shadowDir,
      ], 120000);
    } catch (err) {
      return {
        success: false,
        previousVersion: currentVersion,
        restoredVersion: currentVersion,
        message: `Rollback failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Verify the rollback from shadow install
    let restoredVersion: string;
    try {
      const localPkgPath = path.join(shadowDir, 'node_modules', 'instar', 'package.json');
      if (fs.existsSync(localPkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(localPkgPath, 'utf-8'));
        restoredVersion = pkg.version || 'unknown';
      } else {
        restoredVersion = 'unknown';
      }
    } catch {
      restoredVersion = 'unknown';
    }

    const success = restoredVersion === rollbackInfo.previousVersion;

    if (success) {
      // Clear rollback info after successful rollback
      this.clearRollbackInfo();
    }

    return {
      success,
      previousVersion: currentVersion,
      restoredVersion,
      message: success
        ? `Rolled back from v${currentVersion} to v${restoredVersion}.`
        : `Rollback command ran but version is ${restoredVersion} (expected ${rollbackInfo.previousVersion}).`,
    };
  }

  /**
   * Check if rollback is available.
   */
  canRollback(): boolean {
    return this.getRollbackInfo() !== null;
  }

  /**
   * Get rollback info (previous version, current version, when the update happened).
   */
  getRollbackInfo(): { previousVersion: string; updatedVersion: string; updatedAt: string } | null {
    if (!fs.existsSync(this.rollbackFile)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.rollbackFile, 'utf-8'));
    } catch {
      // @silent-fallback-ok — rollback info optional
      return null;
    }
  }

  /**
   * Fetch human-readable changelog from GitHub releases, falling back to
   * recent commit messages if no release exists for this version.
   */
  async fetchChangelog(version: string): Promise<string | undefined> {
    // Try GitHub release first
    try {
      const tag = version.startsWith('v') ? version : `v${version}`;
      const response = await fetch(`${GITHUB_RELEASES_URL}/tags/${tag}`, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'instar-update-checker',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        const release = await response.json() as { body?: string; name?: string };
        if (release.body) {
          const summary = release.body.slice(0, 500);
          return summary.length < release.body.length ? summary + '...' : summary;
        }
        if (release.name) return release.name;
      }
    } catch {
      // @silent-fallback-ok — changelog fetch optional
    }

    // Fallback: fetch recent commits from GitHub
    try {
      const response = await fetch(
        'https://api.github.com/repos/JKHeadley/instar/commits?per_page=5',
        {
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'instar-update-checker',
          },
          signal: AbortSignal.timeout(10000),
        }
      );

      if (response.ok) {
        const commits = await response.json() as Array<{ commit: { message: string } }>;
        if (commits.length > 0) {
          const lines = commits
            .map(c => {
              // Take first line of commit message only
              const firstLine = c.commit.message.split('\n')[0];
              return `• ${firstLine}`;
            })
            .join('\n');
          return `Recent changes:\n${lines}`;
        }
      }
    } catch {
      // @silent-fallback-ok — GitHub commits API optional
    }

    return undefined;
  }

  /**
   * Get the last check result without hitting npm.
   */
  getLastCheck(): UpdateInfo | null {
    if (!fs.existsSync(this.stateFile)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
    } catch {
      // @silent-fallback-ok — last check state, will re-check
      return null;
    }
  }

  /**
   * Get the currently installed version from package.json.
   *
   * IMPORTANT: Returns the version that was on disk when first called (cached).
   * This represents the RUNNING process version. After `npm install -g` updates
   * files in-place, the disk version changes but the running code doesn't.
   * Without caching, check() would see "no update available" after an install,
   * causing applyUpdate() to return restartNeeded:false even though the running
   * process needs a restart.
   */
  getInstalledVersion(): string {
    if (this.cachedInstalledVersion !== null) {
      return this.cachedInstalledVersion;
    }

    try {
      // Try to find instar's package.json relative to this module
      const pkgPath = path.resolve(
        __dirname,
        '..', '..', 'package.json'
      );
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const version = pkg.version || '0.0.0';
        this.cachedInstalledVersion = version;
        return version;
      }
    } catch { /* @silent-fallback-ok — version read defaults to 0.0.0 */ }

    this.cachedInstalledVersion = '0.0.0';
    return this.cachedInstalledVersion;
  }

  /**
   * Run a command asynchronously, returning trimmed stdout.
   */
  private execAsync(cmd: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(cmd, args, {
        encoding: 'utf-8',
        timeout: timeoutMs,
      }, (err, stdout, stderr) => {
        if (err) {
          // Attach stderr for richer diagnostics in error handlers
          (err as Error & { stderr?: string }).stderr = stderr || '';
          reject(err);
        } else {
          resolve((stdout || '').trim());
        }
      });
      // Safety: ensure child doesn't leak if parent is GC'd
      child.unref?.();
    });
  }

  /**
   * Simple semver comparison — is `a` newer than `b`?
   */
  private isNewer(a: string, b: string): boolean {
    // Extract major.minor.patch, ignoring pre-release suffixes
    const semverRe = /^(\d+)\.(\d+)\.(\d+)/;
    const matchA = semverRe.exec(a);
    const matchB = semverRe.exec(b);
    if (!matchA || !matchB) return false;

    for (let i = 1; i <= 3; i++) {
      const va = Number(matchA[i]);
      const vb = Number(matchB[i]);
      if (va > vb) return true;
      if (va < vb) return false;
    }
    return false;
  }

  private saveState(info: UpdateInfo): void {
    const dir = path.dirname(this.stateFile);
    fs.mkdirSync(dir, { recursive: true });
    // Atomic write: unique temp filename to prevent concurrent corruption
    const tmpPath = this.stateFile + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(info, null, 2));
      fs.renameSync(tmpPath, this.stateFile);
    } catch (err) {
      try { SafeFsExecutor.safeUnlinkSync(tmpPath, { operation: 'src/core/UpdateChecker.ts:625' }); } catch { /* ignore */ }
      throw err;
    }
  }

  private saveRollbackInfo(previousVersion: string, updatedVersion: string): void {
    const dir = path.dirname(this.rollbackFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.rollbackFile, JSON.stringify({
      previousVersion,
      updatedVersion,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  }

  private clearRollbackInfo(): void {
    if (fs.existsSync(this.rollbackFile)) {
      SafeFsExecutor.safeUnlinkSync(this.rollbackFile, { operation: 'src/core/UpdateChecker.ts:643' });
    }
  }
}
