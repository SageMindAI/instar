/**
 * Update Checker — detects when a newer version of Instar is available.
 *
 * Part of the Dawn → Agents push layer: when Dawn publishes an update,
 * agents detect it and notify their users with context about what changed.
 *
 * Uses `npm view instar version` to check the registry.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { UpdateInfo } from './types.js';

export class UpdateChecker {
  private stateDir: string;
  private stateFile: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.stateFile = path.join(stateDir, 'state', 'update-check.json');
  }

  /**
   * Check npm for the latest version and compare to installed.
   */
  async check(): Promise<UpdateInfo> {
    const currentVersion = this.getInstalledVersion();
    let latestVersion: string;

    try {
      latestVersion = execFileSync('npm', ['view', 'instar', 'version'], {
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
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

    const info: UpdateInfo = {
      currentVersion,
      latestVersion,
      updateAvailable: this.isNewer(latestVersion, currentVersion),
      checkedAt: new Date().toISOString(),
      changelogUrl: `https://github.com/SageMindAI/instar/releases`,
    };

    // Persist last check
    this.saveState(info);

    return info;
  }

  /**
   * Get the last check result without hitting npm.
   */
  getLastCheck(): UpdateInfo | null {
    if (!fs.existsSync(this.stateFile)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
    } catch {
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
    } catch { /* fallback below */ }

    // Fallback: try npm list
    try {
      const output = execFileSync('npm', ['list', '-g', 'instar', '--json'], {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const data = JSON.parse(output);
      return data.dependencies?.instar?.version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  /**
   * Simple semver comparison — is `a` newer than `b`?
   */
  private isNewer(a: string, b: string): boolean {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);

    for (let i = 0; i < 3; i++) {
      const va = partsA[i] || 0;
      const vb = partsB[i] || 0;
      if (va > vb) return true;
      if (va < vb) return false;
    }
    return false;
  }

  private saveState(info: UpdateInfo): void {
    const dir = path.dirname(this.stateFile);
    fs.mkdirSync(dir, { recursive: true });
    // Atomic write: write to .tmp then rename
    const tmpPath = this.stateFile + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(info, null, 2));
    fs.renameSync(tmpPath, this.stateFile);
  }
}
