/**
 * Prerequisite detection and installation guidance.
 *
 * Checks for required software (tmux, Claude CLI, Node.js)
 * and provides clear installation instructions when something is missing.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import pc from 'picocolors';
import { detectTmuxPath, detectClaudePath } from './Config.js';

export interface PrerequisiteResult {
  name: string;
  found: boolean;
  path?: string;
  version?: string;
  installHint: string;
}

export interface PrerequisiteCheck {
  allMet: boolean;
  results: PrerequisiteResult[];
  missing: PrerequisiteResult[];
}

/**
 * Detect the current platform for install guidance.
 */
function detectPlatform(): 'macos-arm' | 'macos-intel' | 'linux' | 'unknown' {
  const platform = process.platform;
  if (platform === 'darwin') {
    const arch = process.arch;
    return arch === 'arm64' ? 'macos-arm' : 'macos-intel';
  }
  if (platform === 'linux') return 'linux';
  return 'unknown';
}

/**
 * Check if Homebrew is available (macOS).
 */
function hasHomebrew(): boolean {
  try {
    execSync('which brew', { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get tmux version if installed.
 */
function getTmuxVersion(tmuxPath: string): string | undefined {
  try {
    const output = execSync(`${tmuxPath} -V`, { encoding: 'utf-8', stdio: 'pipe' }).trim();
    return output.replace('tmux ', '');
  } catch {
    return undefined;
  }
}

/**
 * Get Claude CLI version if installed.
 */
function getClaudeVersion(claudePath: string): string | undefined {
  try {
    const output = execSync(`${claudePath} --version 2>/dev/null || echo unknown`, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Get Node.js version.
 */
function getNodeVersion(): { version: string; major: number } {
  const version = process.version; // e.g., "v20.11.0"
  const major = parseInt(version.slice(1).split('.')[0], 10);
  return { version, major };
}

/**
 * Build install hint for tmux based on platform.
 */
function tmuxInstallHint(): string {
  const platform = detectPlatform();
  switch (platform) {
    case 'macos-arm':
    case 'macos-intel':
      return hasHomebrew()
        ? 'Install with: brew install tmux'
        : 'Install Homebrew first (https://brew.sh), then: brew install tmux';
    case 'linux':
      return 'Install with: sudo apt install tmux (Debian/Ubuntu) or sudo yum install tmux (RHEL/CentOS)';
    default:
      return 'Install tmux: https://github.com/tmux/tmux/wiki/Installing';
  }
}

/**
 * Build install hint for Claude CLI based on platform.
 */
function claudeInstallHint(): string {
  return 'Install Claude Code: npm install -g @anthropic-ai/claude-code\n  Docs: https://docs.anthropic.com/en/docs/claude-code';
}

/**
 * Check all prerequisites and return a structured result.
 */
export function checkPrerequisites(): PrerequisiteCheck {
  const results: PrerequisiteResult[] = [];

  // 1. Node.js >= 18
  const node = getNodeVersion();
  results.push({
    name: 'Node.js',
    found: node.major >= 18,
    version: node.version,
    installHint: node.major < 18
      ? `Node.js 18+ required (found ${node.version}). Update: https://nodejs.org`
      : '',
  });

  // 2. tmux
  const tmuxPath = detectTmuxPath();
  results.push({
    name: 'tmux',
    found: !!tmuxPath,
    path: tmuxPath || undefined,
    version: tmuxPath ? getTmuxVersion(tmuxPath) : undefined,
    installHint: tmuxInstallHint(),
  });

  // 3. Claude CLI
  const claudePath = detectClaudePath();
  results.push({
    name: 'Claude CLI',
    found: !!claudePath,
    path: claudePath || undefined,
    version: claudePath ? getClaudeVersion(claudePath) : undefined,
    installHint: claudeInstallHint(),
  });

  const missing = results.filter(r => !r.found);

  return {
    allMet: missing.length === 0,
    results,
    missing,
  };
}

/**
 * Print prerequisite check results to console.
 * Returns true if all prerequisites are met.
 */
export function printPrerequisiteCheck(check: PrerequisiteCheck): boolean {
  console.log(pc.bold('  Checking prerequisites...'));
  console.log();

  for (const result of check.results) {
    if (result.found) {
      const versionStr = result.version ? ` (${result.version})` : '';
      const pathStr = result.path ? pc.dim(` ${result.path}`) : '';
      console.log(`  ${pc.green('✓')} ${result.name}${versionStr}${pathStr}`);
    } else {
      console.log(`  ${pc.red('✗')} ${result.name} — not found`);
      console.log(`    ${result.installHint}`);
    }
  }

  console.log();

  if (!check.allMet) {
    console.log(pc.red(`  ${check.missing.length} prerequisite(s) missing. Install them and try again.`));
    console.log();
  }

  return check.allMet;
}
