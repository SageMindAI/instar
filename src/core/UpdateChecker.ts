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

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { UpdateInfo, UpdateResult } from './types.js';
import { PostUpdateMigrator } from './PostUpdateMigrator.js';
import type { MigratorConfig } from './PostUpdateMigrator.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/SageMindAI/instar/releases';

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
      changelogUrl: `https://github.com/SageMindAI/instar/releases`,
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
   * Apply the update: npm update, verify new version, check health.
   *
   * Uses explicit version pinning (not @latest) to avoid npm CDN propagation
   * delays where @latest still resolves to the old version for several minutes
   * after a new version is published. Retries up to 3 times with backoff.
   */
  async applyUpdate(): Promise<UpdateResult> {
    const previousVersion = this.getInstalledVersion();

    // Check if there's actually an update available
    const info = await this.check();
    if (!info.updateAvailable) {
      return {
        success: true,
        previousVersion,
        newVersion: previousVersion,
        message: `Already up to date (v${previousVersion}).`,
        restartNeeded: false,
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

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        console.log(`[UpdateChecker] Retry ${attempt}/${MAX_RETRIES - 1} after ${RETRY_DELAYS[attempt]}ms...`);
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
      }

      try {
        // --ignore-scripts prevents cloudflared's postinstall binary download from
        // failing with ENOENT in environments where the download path doesn't exist.
        // The cloudflared binary is installed lazily on-demand by TunnelManager when
        // the tunnel feature is first used (via install(bin) from the cloudflared package).
        await this.execAsync('npm', ['install', '-g', `instar@${targetVersion}`, '--ignore-scripts'], 120000);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        continue;
      }

      // Verify the update was applied
      try {
        const listOutput = await this.execAsync('npm', ['list', '-g', 'instar', '--depth=0', '--json'], 15000);
        const parsed = JSON.parse(listOutput);
        newVersion = parsed?.dependencies?.instar?.version || 'unknown';
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

    // Post-update migration: spawn the NEW binary to run migrations.
    // Critical: the old process has stale modules in memory — only the
    // new binary on disk has the latest PostUpdateMigrator entries.
    // This now also processes upgrade guides (Layer 2: intelligent knowledge).
    let migrationSummary = '';
    let upgradeGuideNote = '';
    if (success && this.migratorConfig) {
      try {
        // Prefer --dir to scope migration to this project's directory.
        // Fall back to no --dir if the binary doesn't support the flag
        // (can happen when PATH resolves to an older binary after auto-update).
        let output: string;
        try {
          const args = ['migrate'];
          if (this.migratorConfig.projectDir) args.push('--dir', this.migratorConfig.projectDir);
          output = await this.execAsync('instar', args, 30000);
        } catch (dirErr) {
          const dirErrMsg = dirErr instanceof Error ? dirErr.message : String(dirErr);
          const dirErrStderr = (dirErr as Error & { stderr?: string }).stderr || '';
          if (dirErrMsg.includes('unknown option') && dirErrMsg.includes('--dir')) {
            // Old binary in PATH — retry without --dir
            output = await this.execAsync('instar', ['migrate'], 30000);
          } else if (dirErrStderr.includes('unknown command')) {
            // Very old binary in PATH without migrate command — skip CLI migration gracefully.
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
        } catch {
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
        // or if it returned non-JSON output (old binary ran a different default command),
        // skip silently — the in-memory migrator on server startup handles it.
        const isNonJsonOutput = errMsg.includes('is not valid JSON') || errMsg.includes('JSON') || errMsg.includes('Unexpected token');
        const isMissingCommand = errStderr.includes('unknown command') || errMsg.includes('unknown command') || isNonJsonOutput;

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

        // Only fire degradation for unexpected failures — not for PATH conflicts with old binaries
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

    try {
      await this.execAsync('npm', ['install', '-g', `instar@${rollbackInfo.previousVersion}`, '--ignore-scripts'], 120000);
    } catch (err) {
      return {
        success: false,
        previousVersion: currentVersion,
        restoredVersion: currentVersion,
        message: `Rollback failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Verify the rollback
    let restoredVersion: string;
    try {
      const output = await this.execAsync('npm', ['list', '-g', 'instar', '--depth=0', '--json'], 15000);
      const parsed = JSON.parse(output);
      restoredVersion = parsed?.dependencies?.instar?.version || 'unknown';
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
        'https://api.github.com/repos/SageMindAI/instar/commits?per_page=5',
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
   */
  getInstalledVersion(): string {
    try {
      // Try to find instar's package.json relative to this module
      const pkgPath = path.resolve(
        new URL(import.meta.url).pathname,
        '..', '..', '..', 'package.json'
      );
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return pkg.version || '0.0.0';
      }
    } catch { /* @silent-fallback-ok — version read defaults to 0.0.0 */ }

    return '0.0.0';
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
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
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
      fs.unlinkSync(this.rollbackFile);
    }
  }
}
