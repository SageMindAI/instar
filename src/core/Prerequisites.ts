/**
 * Prerequisite detection and auto-installation.
 *
 * Checks for required software (tmux, Claude CLI, Node.js)
 * and offers to install missing dependencies automatically.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import pc from 'picocolors';
import { confirm } from '@inquirer/prompts';
import { detectTmuxPath, detectClaudePath } from './Config.js';

export interface PrerequisiteResult {
  name: string;
  found: boolean;
  path?: string;
  version?: string;
  installHint: string;
  /** Whether this prerequisite can be auto-installed. */
  canAutoInstall: boolean;
  /** The command to run to auto-install this prerequisite. */
  installCommand?: string;
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
    execFileSync('which', ['brew'], { encoding: 'utf-8', stdio: 'pipe' });
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
    const output = execFileSync(tmuxPath, ['-V'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
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
    const output = execFileSync(claudePath, ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
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
 * Build install hint and command for tmux based on platform.
 */
function tmuxInstallInfo(): { hint: string; canAutoInstall: boolean; command?: string } {
  const platform = detectPlatform();
  switch (platform) {
    case 'macos-arm':
    case 'macos-intel':
      if (hasHomebrew()) {
        return {
          hint: 'Install with: brew install tmux',
          canAutoInstall: true,
          command: 'brew install tmux',
        };
      }
      return {
        hint: 'Install Homebrew first (https://brew.sh), then: brew install tmux',
        canAutoInstall: false,
      };
    case 'linux':
      return {
        hint: 'Install with: sudo apt install tmux (Debian/Ubuntu) or sudo yum install tmux (RHEL/CentOS)',
        canAutoInstall: true,
        command: 'sudo apt install -y tmux',
      };
    default:
      return {
        hint: 'Install tmux: https://github.com/tmux/tmux/wiki/Installing',
        canAutoInstall: false,
      };
  }
}

/**
 * Build install hint and command for Claude CLI.
 */
function claudeInstallInfo(): { hint: string; canAutoInstall: boolean; command: string } {
  return {
    hint: 'Install Claude Code: npm install -g @anthropic-ai/claude-code',
    canAutoInstall: true,
    command: 'npm install -g @anthropic-ai/claude-code',
  };
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
    canAutoInstall: false,
  });

  // 2. tmux
  const tmuxPath = detectTmuxPath();
  const tmuxInfo = tmuxInstallInfo();
  results.push({
    name: 'tmux',
    found: !!tmuxPath,
    path: tmuxPath || undefined,
    version: tmuxPath ? getTmuxVersion(tmuxPath) : undefined,
    installHint: tmuxInfo.hint,
    canAutoInstall: tmuxInfo.canAutoInstall,
    installCommand: tmuxInfo.command,
  });

  // 3. Claude CLI
  const claudePath = detectClaudePath();
  const claudeInfo = claudeInstallInfo();
  results.push({
    name: 'Claude CLI',
    found: !!claudePath,
    path: claudePath || undefined,
    version: claudePath ? getClaudeVersion(claudePath) : undefined,
    installHint: claudeInfo.hint,
    canAutoInstall: claudeInfo.canAutoInstall,
    installCommand: claudeInfo.command,
  });

  const missing = results.filter(r => !r.found);

  return {
    allMet: missing.length === 0,
    results,
    missing,
  };
}

/**
 * Attempt to install a missing prerequisite.
 * Returns true if installation succeeded.
 */
function installPrerequisite(result: PrerequisiteResult): boolean {
  if (!result.installCommand) return false;

  try {
    console.log(pc.dim(`  Running: ${result.installCommand}`));
    // Split command string into executable + args for execFileSync (no shell)
    const parts = result.installCommand.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);
    execFileSync(cmd, args, {
      encoding: 'utf-8',
      stdio: 'inherit',
      timeout: 120000, // 2 min timeout
    });
    return true;
  } catch {
    return false;
  }
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

/**
 * Interactive prerequisite check that offers to install missing dependencies.
 * Returns a fresh PrerequisiteCheck after any installations.
 */
export async function ensurePrerequisites(): Promise<PrerequisiteCheck> {
  let check = checkPrerequisites();

  console.log(pc.bold('  Checking prerequisites...'));
  console.log();

  for (const result of check.results) {
    if (result.found) {
      const versionStr = result.version ? ` (${result.version})` : '';
      const pathStr = result.path ? pc.dim(` ${result.path}`) : '';
      console.log(`  ${pc.green('✓')} ${result.name}${versionStr}${pathStr}`);
    }
  }

  if (check.allMet) {
    console.log();
    return check;
  }

  // Handle missing prerequisites
  for (const missing of check.missing) {
    console.log();
    console.log(`  ${pc.red('✗')} ${missing.name} — not found`);

    if (missing.canAutoInstall && missing.installCommand) {
      const install = await confirm({
        message: `Install ${missing.name}? (${pc.dim(missing.installCommand)})`,
        default: true,
      });

      if (install) {
        const success = installPrerequisite(missing);
        if (success) {
          console.log(`  ${pc.green('✓')} ${missing.name} installed successfully`);
        } else {
          console.log(`  ${pc.red('✗')} Failed to install ${missing.name}`);
          console.log(`    Try manually: ${missing.installHint}`);
        }
      } else {
        console.log(`    ${missing.installHint}`);
      }
    } else {
      console.log(`    ${missing.installHint}`);
    }
  }

  // Re-check after installations
  check = checkPrerequisites();
  console.log();

  if (!check.allMet) {
    const stillMissing = check.missing.map(r => r.name).join(', ');
    console.log(pc.red(`  Still missing: ${stillMissing}`));
    console.log(pc.dim('  Install the missing prerequisites and run instar again.'));
    console.log();
  }

  return check;
}
