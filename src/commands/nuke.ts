/**
 * `instar nuke <name>` — Completely remove a standalone agent.
 *
 * Cleans up ALL artifacts:
 *   1. Stop the running server (tmux session)
 *   2. Remove auto-start (launchd/systemd)
 *   3. Push any uncommitted changes to git remote (if configured)
 *   4. Remove from agent registry
 *   5. Delete the agent directory
 *
 * Safety:
 *   - Requires explicit confirmation (unless --yes)
 *   - Pushes to git remote before deletion (preserves cloud backup)
 *   - Shows exactly what will be removed before proceeding
 *   - Only works on standalone agents (not project-bound)
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { standaloneAgentsDir } from '../core/Config.js';
import { unregisterAgent } from '../core/AgentRegistry.js';
import { uninstallAutoStart } from './setup.js';
import { SecretManager, SECRET_KEYS } from '../core/SecretManager.js';

interface NukeOptions {
  skipConfirm?: boolean;
}

export async function nukeAgent(name: string, options: NukeOptions = {}): Promise<void> {
  const agentDir = path.join(standaloneAgentsDir(), name);
  const stateDir = path.join(agentDir, '.instar');

  // Verify agent exists
  if (!fs.existsSync(path.join(stateDir, 'config.json'))) {
    console.log(pc.red(`  Agent "${name}" not found at ${agentDir}`));
    console.log(pc.dim(`  Standalone agents live at: ${standaloneAgentsDir()}/`));
    process.exit(1);
  }

  // Load config for project name
  let projectName = name;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
    projectName = config.projectName || name;
  } catch {
    // Use name as fallback
  }

  // Check what exists
  const hasGit = fs.existsSync(path.join(agentDir, '.git'));
  const hasRemote = hasGit && hasGitRemote(agentDir);
  const hasTmux = isTmuxSessionRunning(projectName);

  // Show what will be removed
  console.log();
  console.log(pc.bold(pc.red('  This will permanently remove:')));
  console.log();
  console.log(`  ${pc.red('x')} Agent directory: ${pc.dim(agentDir)}`);
  console.log(`  ${pc.red('x')} All agent data: memories, relationships, config, logs`);
  if (hasTmux) {
    console.log(`  ${pc.red('x')} Running server: ${pc.dim(`tmux session "${projectName}-server"`)}`);
  }
  console.log(`  ${pc.red('x')} Auto-start configuration (if any)`);
  console.log(`  ${pc.red('x')} Agent registry entry`);

  if (hasGit && hasRemote) {
    console.log();
    console.log(`  ${pc.green('~')} Git remote backup will be ${pc.bold('preserved')} (we'll push before deleting)`);
  } else if (hasGit && !hasRemote) {
    console.log();
    console.log(pc.yellow(`  ! Local git repo exists but has NO remote — data will be permanently lost`));
  }

  console.log();

  // Confirm
  if (!options.skipConfirm) {
    try {
      const { confirm } = await import('@inquirer/prompts');
      const confirmed = await confirm({
        message: `Remove agent "${name}" and all its data? This cannot be undone.`,
        default: false,
      });
      if (!confirmed) {
        console.log(pc.dim('  Cancelled.'));
        return;
      }
    } catch {
      console.log(pc.dim('  Cancelled.'));
      return;
    }
  }

  console.log();

  // Step 1: Stop server AND all spawned sessions
  if (hasTmux) {
    try {
      execFileSync('tmux', ['kill-session', '-t', `${projectName}-server`], { stdio: 'pipe' });
      console.log(`  ${pc.green('✓')} Stopped server`);
    } catch {
      console.log(pc.yellow('  Could not stop server (may already be stopped)'));
    }
  }

  // Kill ALL tmux sessions prefixed with the project name (spawned Claude sessions)
  try {
    const sessions = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split('\n').filter(Boolean);

    const projectSessions = sessions.filter(s => s.startsWith(`${projectName}-`) && s !== `${projectName}-server`);
    for (const session of projectSessions) {
      try {
        execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'pipe' });
      } catch { /* already dead */ }
    }
    if (projectSessions.length > 0) {
      console.log(`  ${pc.green('✓')} Killed ${projectSessions.length} spawned session(s)`);
    }
  } catch {
    // tmux not running or no sessions — fine
  }

  // Step 2: Remove auto-start
  try {
    const removed = uninstallAutoStart(projectName);
    if (removed) {
      console.log(`  ${pc.green('✓')} Removed auto-start`);
    }
  } catch {
    // Non-fatal
  }

  // Step 3: Push to git remote (preserve cloud backup)
  if (hasGit && hasRemote) {
    try {
      // Stage and commit any uncommitted changes
      // safe-git-allow: incremental-migration
      execFileSync('git', ['add', '-A'], { cwd: agentDir, stdio: 'pipe' });
      // safe-git-allow: incremental-migration
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: agentDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();

      if (status) {
        // safe-git-allow: incremental-migration
        execFileSync('git', ['commit', '-m', 'final backup before nuke'], {
          cwd: agentDir,
          stdio: 'pipe',
        });
      }

      // safe-git-allow: incremental-migration
      execFileSync('git', ['push'], { cwd: agentDir, stdio: 'pipe', timeout: 30_000 });
      console.log(`  ${pc.green('✓')} Pushed final backup to remote`);
    } catch {
      console.log(pc.yellow('  Could not push final backup (remote may be unavailable)'));
    }
  }

  // Step 4: Back up secrets before deletion
  try {
    const config = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
    const secretMgr = new SecretManager({ agentName: name });
    secretMgr.initialize();

    const telegramEntry = config.messaging?.find((m: { type: string }) => m.type === 'telegram');
    if (telegramEntry?.config) {
      secretMgr.backupFromConfig({
        telegramToken: telegramEntry.config.token,
        telegramChatId: telegramEntry.config.chatId,
        authToken: config.authToken,
        dashboardPin: config.dashboardPin,
        tunnelToken: config.tunnel?.token,
      });
      console.log(`  ${pc.green('✓')} Secrets backed up (will auto-restore on reinstall)`);
    }
  } catch {
    // Non-fatal — secrets may not exist or store may not be configured
  }

  // Step 5: Remove from agent registry
  try {
    unregisterAgent(agentDir);
    console.log(`  ${pc.green('✓')} Removed from agent registry`);
  } catch {
    // Non-fatal — may not be registered
  }

  // Step 6: Delete the agent directory
  try {
    // safe-git-allow: incremental-migration
    fs.rmSync(agentDir, { recursive: true, force: true });
    console.log(`  ${pc.green('✓')} Deleted ${agentDir}`);
  } catch (err) {
    console.log(pc.red(`  Could not delete directory: ${err instanceof Error ? err.message : err}`));
    console.log(pc.dim(`  Try manually: rm -rf ${agentDir}`));
  }

  console.log();
  console.log(pc.green(`  Agent "${name}" has been removed.`));
  if (hasGit && hasRemote) {
    console.log(pc.dim('  Your cloud backup is still available on GitHub.'));
    console.log(pc.dim(`  To restore: git clone <repo-url> ${agentDir} && instar server start ${name}`));
  }
  console.log();
}

function hasGitRemote(dir: string): boolean {
  try {
    // safe-git-allow: incremental-migration
    const remote = execFileSync('git', ['remote'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    return remote.length > 0;
  } catch {
    return false;
  }
}

function isTmuxSessionRunning(projectName: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', `${projectName}-server`], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
