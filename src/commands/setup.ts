/**
 * Interactive setup wizard — the one-line onboarding experience.
 *
 * `npx instar` or `instar setup` walks through everything:
 *   1. Project detection + naming
 *   2. Secret management (Bitwarden / local encrypted / manual)
 *   3. Telegram setup (primary communication channel)
 *   4. User setup (name, email, permissions)
 *   5. Scheduler + first job (optional)
 *   6. Start server
 *
 * Launches a Claude Code session that walks you through setup
 * conversationally. Claude Code is a hard requirement — Instar's
 * entire runtime depends on it.
 *
 * No flags needed. No manual config editing. Just answers.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pc from 'picocolors';
import { detectClaudePath, detectGhPath } from '../core/Config.js';
import { ensurePrerequisites } from '../core/Prerequisites.js';
import type { SecretBackend } from '../core/SecretManager.js';
import {
  runDiscovery,
  buildScenarioContext,
  readSetupLock,
  deleteSetupLock,
  type SetupDiscoveryContext,
  type SetupScenarioContext,
} from './discovery.js';

/**
 * Launch the conversational setup wizard via Claude Code.
 * Claude Code is required — there is no fallback.
 */
export async function runSetup(): Promise<void> {
  // Check and install prerequisites (tmux, Claude CLI, Node.js version)
  console.log();
  const prereqs = await ensurePrerequisites();

  // Claude Code is a hard requirement — Instar can't run without it
  const claudePath = detectClaudePath();
  if (!claudePath) {
    console.log();
    console.log(pc.red('  Claude Code is required to use Instar.'));
    console.log();
    console.log(pc.dim('  Instar agents are powered by Claude Code — it\'s not optional.'));
    console.log(pc.dim('  Install it, then run this command again:'));
    console.log();
    console.log(`    ${pc.cyan('npm install -g @anthropic-ai/claude-code')}`);
    console.log();
    process.exit(1);
  }

  if (!prereqs.allMet) {
    console.log(pc.red('  Some prerequisites are still missing. Please install them and try again.'));
    console.log();
    process.exit(1);
  }

  // Check that the setup-wizard skill exists
  const skillPath = path.join(findInstarRoot(), '.claude', 'skills', 'setup-wizard', 'skill.md');
  if (!fs.existsSync(skillPath)) {
    console.log();
    console.log(pc.red('  Setup wizard skill not found.'));
    console.log(pc.dim(`  Expected: ${skillPath}`));
    console.log(pc.dim('  This may indicate a corrupted installation. Try: npm install -g instar'));
    console.log();
    process.exit(1);
  }

  console.log();
  console.log(pc.bold('  Welcome to Instar'));
  console.log();
  console.log(pc.yellow('  Note: Instar runs Claude Code with --dangerously-skip-permissions.'));
  console.log(pc.dim('  This allows your agent to operate autonomously — reading, writing, and'));
  console.log(pc.dim('  executing within your project without per-action approval prompts.'));
  console.log(pc.dim('  Security is enforced through behavioral hooks, identity grounding, and'));
  console.log(pc.dim('  scoped access — not permission dialogs. See: README.md > Security Model'));
  console.log();

  // ── Context Detection & Discovery ───────────────────────────────
  const projectDir = process.cwd();

  // Detect git context
  let isInsideGitRepo = false;
  let gitRepoName = '';
  let gitRepoRoot = '';
  try {
    gitRepoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    gitRepoName = path.basename(gitRepoRoot);
    isInsideGitRepo = true;
  } catch { /* not in a git repo */ }

  // Detect gh CLI status (no auto-install — graceful degradation)
  let ghPath = detectGhPath();
  let ghStatus: 'ready' | 'auth-needed' | 'unavailable' = 'unavailable';

  if (!ghPath) {
    // Don't auto-install — display install guidance instead
    console.log(pc.dim('  GitHub CLI (gh) not found. To discover cloud-backed agents:'));
    const platform = process.platform;
    if (platform === 'darwin') {
      console.log(pc.dim('    brew install gh'));
    } else if (platform === 'linux') {
      console.log(pc.dim('    sudo apt install gh'));
    } else {
      console.log(pc.dim('    https://cli.github.com/'));
    }
    console.log(pc.dim('  Continuing without GitHub discovery...'));
    console.log();
  } else {
    // Check auth status
    try {
      execFileSync(ghPath, ['auth', 'status'], { stdio: 'pipe', timeout: 5000 });
      ghStatus = 'ready';
    } catch {
      ghStatus = 'auth-needed';
    }
  }

  // Check for interrupted setup
  const existingLock = readSetupLock();
  if (existingLock) {
    console.log(pc.yellow(`  A previous setup was interrupted during "${existingLock.phase}".`));
    console.log(pc.dim(`  Agent: ${existingLock.agentName}, started: ${existingLock.startedAt}`));
    console.log(pc.dim('  The wizard will offer to resume or start over.'));
    console.log();
  }

  // Run comprehensive discovery
  console.log(pc.dim('  Scanning for existing agents...'));
  const discovery = runDiscovery(projectDir, ghPath, ghStatus);
  const scenarioContext = buildScenarioContext(discovery, isInsideGitRepo);

  // Report discovery results
  const totalFound = discovery.merged_agents.length;
  if (totalFound > 0) {
    console.log(`  ${pc.green('✓')} Found ${totalFound} agent${totalFound !== 1 ? 's' : ''}`);
  } else {
    console.log(`  ${pc.green('✓')} No existing agents found — fresh install`);
  }
  if (discovery.zombie_entries.length > 0) {
    console.log(pc.dim(`    (${discovery.zombie_entries.length} stale registry entries excluded)`));
  }
  if (discovery.scan_errors.length > 0) {
    for (const err of discovery.scan_errors) {
      console.log(pc.dim(`    ⚠ ${err}`));
    }
  }
  console.log();

  // Build structured context for the wizard (replaces ad-hoc string interpolation)
  const gitContext = isInsideGitRepo
    ? ` This directory is inside a git repository "${gitRepoName}" at ${gitRepoRoot}. Set up a project-bound agent here.`
    : ' This directory is NOT inside a git repository. Set up a standalone agent at ~/.instar/agents/<name>/ using `npx instar init --standalone <name>`.';

  // Structured JSON context — the wizard parses this, not string fragments
  const discoveryJson = JSON.stringify(discovery, null, 2);
  const scenarioJson = JSON.stringify(scenarioContext, null, 2);
  const lockJson = existingLock ? JSON.stringify(existingLock, null, 2) : 'null';

  // Pre-formatted agent summary — deterministic, not LLM-generated.
  // Structure > Willpower: don't rely on the LLM to enumerate agents from JSON.
  const agentSummary = buildAgentSummary(discovery);

  const detectionContext = `
--- BEGIN UNTRUSTED DISCOVERY DATA (JSON) ---
${discoveryJson}
--- END UNTRUSTED DISCOVERY DATA ---

--- BEGIN SCENARIO CONTEXT (JSON) ---
${scenarioJson}
--- END SCENARIO CONTEXT ---

--- BEGIN SETUP LOCK ---
${lockJson}
--- END SETUP LOCK ---

--- BEGIN AGENT SUMMARY (display verbatim) ---
${agentSummary}
--- END AGENT SUMMARY ---`;

  // Pre-install Playwright browser binaries AND register the MCP server so
  // ALL Claude Code sessions (including the secret-setup micro-session) have
  // browser automation available.
  const instarRoot = findInstarRoot();
  console.log(pc.dim('  Preparing browser automation...'));

  // Step 1: Ensure .claude/settings.json has Playwright MCP registered
  ensurePlaywrightMcp(instarRoot);

  // Step 2: Pre-install Playwright browser binaries
  try {
    execFileSync('npx', ['-y', 'playwright', 'install', 'chromium'], {
      cwd: instarRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120000,
    });
  } catch {
    // Non-fatal — wizard will fall back to manual if browser isn't available
    console.log(pc.dim('  (Browser automation may not be available — the wizard can still guide you manually)'));
  }

  // ── Phase Gate: Secret Management ──────────────────────────────────
  // Structure > Willpower: secret management MUST be configured before the
  // main wizard. Uses a Claude Code micro-session (/secret-setup) for a
  // conversational experience. Gate: main wizard won't start without backend.json.
  const secretContext = await ensureSecretBackend(claudePath, instarRoot);

  // If Bitwarden session was saved by the secret-setup micro-session, pass it
  // as an env var so the main wizard can use it for credential restoration.
  const spawnEnv = { ...process.env };
  const bwSessionFile = path.join(os.homedir(), '.instar', 'secrets', '.bw-session');
  if (fs.existsSync(bwSessionFile)) {
    const bwSession = fs.readFileSync(bwSessionFile, 'utf-8').trim();
    if (bwSession) {
      spawnEnv.BW_SESSION = bwSession;
    }
  }

  // Launch Claude Code from the instar package root (where .claude/skills/ lives)
  const child = spawn(claudePath, [
    '--dangerously-skip-permissions',
    `/setup-wizard The project to set up is at: ${projectDir}.${gitContext}${detectionContext}${secretContext}`,
  ], {
    cwd: instarRoot,
    stdio: 'inherit',
    env: spawnEnv,
  });

  return new Promise((resolve) => {
    child.on('close', () => {
      resolve();
    });
    child.on('error', (err) => {
      console.log();
      console.log(pc.red(`  Could not launch Claude Code: ${err.message}`));
      console.log(pc.dim('  Make sure Claude Code is installed and accessible:'));
      console.log(`    ${pc.cyan('npm install -g @anthropic-ai/claude-code')}`);
      console.log();
      process.exit(1);
    });
  });
}

// ── Phase Gate: Secret Management ──────────────────────────────────────
// Structure > Willpower: secret management MUST be configured before the main
// wizard launches. We use a Claude Code micro-session (/secret-setup skill)
// for this — conversational, can explain options, can answer questions, can
// install and configure Bitwarden end-to-end. But SCOPED to one job.
//
// The gate: setup.ts won't launch the main wizard until backend.json exists.

/**
 * Ensure a secret backend is configured before the wizard launches.
 * Returns context string to pass to the wizard so it knows secrets are handled.
 *
 * If backend.json already exists → skip (returns existing choice as context).
 * If not → spawn a focused Claude Code session with the /secret-setup skill.
 *   Claude explains options, guides through Bitwarden install/login/unlock,
 *   configures the backend, and exits. Then we continue.
 */
async function ensureSecretBackend(claudePath: string, instarRoot: string): Promise<string> {
  const backendFile = path.join(os.homedir(), '.instar', 'secrets', 'backend.json');

  // Check if already configured
  if (fs.existsSync(backendFile)) {
    try {
      const pref = JSON.parse(fs.readFileSync(backendFile, 'utf-8'));
      const backend = pref.backend as SecretBackend;
      console.log(`  ${pc.green('✓')} Secret management: ${formatBackendName(backend)}`);

      // If Bitwarden, check for saved session and try to restore it
      let bwSessionContext = '';
      if (backend === 'bitwarden') {
        const sessionFile = path.join(os.homedir(), '.instar', 'secrets', '.bw-session');
        if (fs.existsSync(sessionFile)) {
          const savedSession = fs.readFileSync(sessionFile, 'utf-8').trim();
          if (savedSession) {
            bwSessionContext = ` BW_SESSION is available — Bitwarden vault is unlocked.`;
          }
        }
      }

      return ` SECRET_BACKEND_CONFIGURED="${backend}". Secret management is already set up — skip Phase 2.5.${bwSessionContext}`;
    } catch {
      // Corrupted file — fall through to micro-session
    }
  }

  // Not configured — launch Claude Code micro-session for secret setup
  console.log();
  console.log(pc.bold('  Secret Management'));
  console.log(pc.dim('  Your agent needs a way to store secrets securely.'));
  console.log(pc.dim('  Let me walk you through the options...'));
  console.log();

  // Spawn a focused Claude Code session with the /secret-setup skill
  const child = spawn(claudePath, [
    '--dangerously-skip-permissions',
    '/secret-setup',
  ], {
    cwd: instarRoot,
    stdio: 'inherit',
  });

  await new Promise<void>((resolve) => {
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });

  // Verify the micro-session did its job — backend.json must exist now
  if (fs.existsSync(backendFile)) {
    try {
      const pref = JSON.parse(fs.readFileSync(backendFile, 'utf-8'));
      const backend = pref.backend as SecretBackend;
      console.log();
      console.log(`  ${pc.green('✓')} Secret management: ${formatBackendName(backend)}`);

      let bwSessionContext = '';
      if (backend === 'bitwarden') {
        const sessionFile = path.join(os.homedir(), '.instar', 'secrets', '.bw-session');
        if (fs.existsSync(sessionFile)) {
          bwSessionContext = ` BW_SESSION is available — Bitwarden vault is unlocked.`;
        }
      }

      return ` SECRET_BACKEND_CONFIGURED="${backend}". Secret management configured. Skip Phase 2.5.${bwSessionContext}`;
    } catch {
      // Fall through
    }
  }

  // Micro-session didn't configure a backend — fall back to local
  console.log();
  console.log(pc.yellow('  Secret setup was not completed. Using local encrypted store as default.'));
  console.log(pc.dim('  You can change this later via: instar secrets backend bitwarden'));
  console.log();

  const { SecretManager } = await import('../core/SecretManager.js');
  const mgr = new SecretManager({ agentName: '_setup' });
  mgr.configureBackend('local');

  return ` SECRET_BACKEND_CONFIGURED="local". Secret setup micro-session did not complete — defaulted to local encrypted store. Skip Phase 2.5.`;
}

/**
 * Build a pre-formatted agent summary from discovery data.
 * This is deterministic — the wizard displays it verbatim instead of
 * trying to enumerate agents from JSON (which LLMs do unreliably).
 *
 * Includes inline numbered options so the user can type their choice.
 * AskUserQuestion is NOT used — its overlay hides the summary text.
 */
function buildAgentSummary(discovery: SetupDiscoveryContext): string {
  const lines: string[] = [];

  const localAgents = discovery.merged_agents.filter(a => a.source === 'local' || a.source === 'both');
  const githubOnly = discovery.merged_agents.filter(a => a.source === 'github');

  // Restorable = github-only agents + 'both' agents not in current directory
  const restorable = discovery.merged_agents.filter(a =>
    a.source === 'github' || (a.source === 'both' && !discovery.current_dir_agent?.exists)
  );

  if (localAgents.length === 0 && githubOnly.length === 0) {
    lines.push('No existing agents found. Let\'s set up a new one.');
    return lines.join('\n');
  }

  lines.push('I found some existing agents.');
  lines.push('');

  if (localAgents.length > 0) {
    lines.push('Already running on this machine:');
    for (const agent of localAgents) {
      const details: string[] = [];
      if (agent.port) details.push(`port ${agent.port}`);
      if (agent.userCount) details.push(`${agent.userCount} user${agent.userCount !== 1 ? 's' : ''}`);
      const detailStr = details.length > 0 ? ` (${details.join(', ')})` : '';
      const backupNote = agent.source === 'both' && agent.repo ? `, backed up to ${agent.repo}` : '';
      lines.push(`- ${agent.name}${detailStr} — already set up${backupNote}`);
    }
    lines.push('');
  }

  if (githubOnly.length > 0) {
    lines.push('Available to restore from GitHub:');
    for (const agent of githubOnly) {
      const repoStr = agent.repo ? ` (${agent.repo})` : '';
      lines.push(`- ${agent.name}${repoStr}`);
    }
    lines.push('');
  }

  // Build inline numbered options
  lines.push('What would you like to do?');
  lines.push('');

  let optNum = 1;
  for (const agent of restorable) {
    const repoStr = agent.repo ? ` from ${agent.repo}` : '';
    lines.push(`${optNum}. Restore ${agent.name} — clone${repoStr} and set it up here`);
    optNum++;
  }
  lines.push(`${optNum}. Start fresh — create a brand new agent`);
  lines.push('');
  lines.push('Type a number or describe what you\'d like to do.');

  return lines.join('\n');
}

function formatBackendName(backend: SecretBackend): string {
  switch (backend) {
    case 'bitwarden': return 'Bitwarden';
    case 'local': return 'Local encrypted store';
    case 'manual': return 'Manual (paste when prompted)';
  }
}

/**
 * Register the Playwright MCP server so Claude Code has browser automation
 * available when spawned for the setup wizard.
 *
 * Claude Code loads MCP servers from THREE places (NOT .claude/settings.json):
 *   1. ~/.claude.json — user scope (top-level mcpServers) or local scope
 *      (projects["/abs/path"].mcpServers) — NO trust dialog needed
 *   2. .mcp.json in project root — project scope — requires trust acceptance
 *
 * We register in BOTH places for robustness:
 *   - ~/.claude.json local scope: guaranteed to work, no trust dialog
 *   - .mcp.json: works if trust is pre-accepted or enableAllProjectMcpServers
 */
function ensurePlaywrightMcp(dir: string): void {
  const absDir = path.resolve(dir);

  // ── 1. Register in ~/.claude.json at local scope (most reliable) ──
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  try {
    let claudeJson: Record<string, unknown> = {};
    if (fs.existsSync(claudeJsonPath)) {
      claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
    }

    // Ensure projects map exists
    if (!claudeJson.projects || typeof claudeJson.projects !== 'object') {
      claudeJson.projects = {};
    }
    const projects = claudeJson.projects as Record<string, Record<string, unknown>>;

    // Ensure project entry exists
    if (!projects[absDir]) {
      projects[absDir] = {};
    }
    const projectEntry = projects[absDir];

    // Register Playwright MCP at local scope
    if (!projectEntry.mcpServers || typeof projectEntry.mcpServers !== 'object') {
      projectEntry.mcpServers = {};
    }
    const mcpServers = projectEntry.mcpServers as Record<string, unknown>;
    if (!mcpServers.playwright) {
      mcpServers.playwright = {
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
      };
    }

    // Pre-accept trust so .mcp.json servers also load without a dialog
    projectEntry.hasTrustDialogAccepted = true;

    // Write atomically
    const tmpPath = `${claudeJsonPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(claudeJson, null, 2));
    fs.renameSync(tmpPath, claudeJsonPath);
  } catch {
    // Non-fatal — .mcp.json fallback below
  }

  // ── 2. Also create .mcp.json in the project root (belt-and-suspenders) ──
  const mcpJsonPath = path.join(dir, '.mcp.json');
  if (!fs.existsSync(mcpJsonPath)) {
    try {
      const mcpConfig = {
        mcpServers: {
          playwright: {
            command: 'npx',
            args: ['-y', '@playwright/mcp@latest'],
          },
        },
      };
      fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2));
    } catch {
      // Non-fatal
    }
  }
}

/**
 * Find the root of the instar package (where .claude/skills/ lives).
 * Works whether running from source, linked global, or node_modules.
 */
function findInstarRoot(): string {
  // Walk up from this file to find package.json with name "instar"
  let dir = path.dirname(new URL(import.meta.url).pathname);
  while (dir !== path.dirname(dir)) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === 'instar') return dir;
      } catch { /* continue */ }
    }
    dir = path.dirname(dir);
  }
  // Fallback: assume we're in dist/commands/ — go up to root
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
}

// ── Auto-Start on Login ─────────────────────────────────────────

/**
 * Install auto-start so the agent's lifeline process starts on login.
 * macOS: LaunchAgent plist in ~/Library/LaunchAgents/
 * Linux: systemd user service in ~/.config/systemd/user/
 *
 * Returns true if auto-start was installed successfully.
 */
export function installAutoStart(projectName: string, projectDir: string, hasTelegram: boolean): boolean {
  const platform = process.platform;

  if (platform === 'darwin') {
    return installMacOSLaunchAgent(projectName, projectDir, hasTelegram);
  } else if (platform === 'linux') {
    return installLinuxSystemdService(projectName, projectDir, hasTelegram);
  } else {
    // Windows or other — no auto-start support yet
    return false;
  }
}

/**
 * Remove auto-start for a project.
 */
export function uninstallAutoStart(projectName: string): boolean {
  const platform = process.platform;

  if (platform === 'darwin') {
    const label = `ai.instar.${projectName}`;
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);

    // Unload if loaded
    try {
      execFileSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}`, plistPath], { stdio: 'ignore' });
    } catch { /* not loaded */ }

    // Remove file
    try {
      fs.unlinkSync(plistPath);
      return true;
    } catch {
      return false;
    }
  } else if (platform === 'linux') {
    const serviceName = `instar-${projectName}.service`;
    const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', serviceName);

    try {
      execFileSync('systemctl', ['--user', 'disable', serviceName], { stdio: 'ignore' });
      execFileSync('systemctl', ['--user', 'stop', serviceName], { stdio: 'ignore' });
    } catch { /* not loaded */ }

    try {
      fs.unlinkSync(servicePath);
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

function findNodePath(): string {
  try {
    return execFileSync('which', ['node'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '/usr/local/bin/node';
  }
}

function findInstarCli(): string {
  // Find the actual instar CLI entry point
  try {
    const globalPath = execFileSync('which', ['instar'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (globalPath && !globalPath.includes('.npm/_npx')) {
      return globalPath;
    }
  } catch { /* not global */ }

  // Fallback: use the dist/cli.js from the npm package
  const cliPath = new URL('../cli.js', import.meta.url).pathname;
  if (fs.existsSync(cliPath)) {
    return cliPath;
  }

  return 'instar';
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function installMacOSLaunchAgent(projectName: string, projectDir: string, hasTelegram: boolean): boolean {
  const label = `ai.instar.${projectName}`;
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plistPath = path.join(launchAgentsDir, `${label}.plist`);
  const logDir = path.join(projectDir, '.instar', 'logs');
  const nodePath = findNodePath();
  const instarCli = findInstarCli();

  // Determine what to start: lifeline if Telegram configured, otherwise just the server
  const command = hasTelegram ? 'lifeline' : 'server';
  const args = hasTelegram
    ? [instarCli, 'lifeline', 'start', '--dir', projectDir]
    : [instarCli, 'server', 'start', '--foreground', '--dir', projectDir];

  // If instar CLI is a node script (not a binary), prepend node
  const isNodeScript = instarCli.endsWith('.js') || instarCli.endsWith('.mjs');
  const programArgs = isNodeScript ? [nodePath, ...args] : args;

  // Build the plist XML
  const argsXml = programArgs.map(a => `      <string>${escapeXml(a)}</string>`).join('\n');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(projectDir)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(path.join(logDir, `${command}-launchd.log`))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(path.join(logDir, `${command}-launchd.err`))}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escapeXml(process.env.PATH || '/usr/local/bin:/usr/bin:/bin')}</string>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>`;

  try {
    fs.mkdirSync(launchAgentsDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(plistPath, plist);

    // Load the agent
    try {
      // Unload first if already loaded
      execFileSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}`, plistPath], { stdio: 'ignore' });
    } catch { /* not loaded yet — fine */ }

    execFileSync('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 501}`, plistPath], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function installLinuxSystemdService(projectName: string, projectDir: string, hasTelegram: boolean): boolean {
  const serviceName = `instar-${projectName}.service`;
  const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const servicePath = path.join(serviceDir, serviceName);
  const nodePath = findNodePath();
  const instarCli = findInstarCli();

  const command = hasTelegram ? 'lifeline' : 'server';
  const args = hasTelegram
    ? `${instarCli} lifeline start --dir ${projectDir}`
    : `${instarCli} server start --foreground --dir ${projectDir}`;

  const isNodeScript = instarCli.endsWith('.js') || instarCli.endsWith('.mjs');
  const execStart = isNodeScript ? `${nodePath} ${args}` : args;

  const service = `[Unit]
Description=Instar Agent - ${projectName}
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
WorkingDirectory=${projectDir}
Restart=always
RestartSec=10
Environment=PATH=${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}

[Install]
WantedBy=default.target
`;

  try {
    fs.mkdirSync(serviceDir, { recursive: true });
    fs.writeFileSync(servicePath, service);

    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    execFileSync('systemctl', ['--user', 'enable', serviceName], { stdio: 'ignore' });
    execFileSync('systemctl', ['--user', 'start', serviceName], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ── Non-Interactive Setup ──────────────────────────────────────────
// For CI/CD and automation. No LLM wizard — all config via CLI flags.

interface NonInteractiveOptions {
  name?: string;
  user?: string;
  telegramToken?: string;
  telegramGroup?: string;
  scenario?: string;
}

/**
 * Run setup without the LLM wizard. Requires all necessary flags.
 * Returns exit code 0 on success, throws on failure.
 */
export async function runNonInteractiveSetup(opts: NonInteractiveOptions): Promise<void> {
  const { resolveScenario } = await import('./discovery.js');

  // Validate required flags
  const missing: string[] = [];
  if (!opts.name) missing.push('--name');
  if (!opts.user) missing.push('--user');
  if (!opts.scenario) missing.push('--scenario');

  if (missing.length > 0) {
    console.error(pc.red(`\n  Missing required flags for non-interactive setup: ${missing.join(', ')}`));
    console.error(pc.dim('\n  Example:'));
    console.error(pc.dim('    npx instar setup --non-interactive --name my-agent --user deploy-bot --scenario 3'));
    console.error(pc.dim('\n  Scenarios: 1-8 (see docs/specs/GUIDED-SETUP-SPEC.md for details)\n'));
    process.exit(1);
  }

  const scenarioNum = parseInt(opts.scenario!, 10);
  if (isNaN(scenarioNum) || scenarioNum < 1 || scenarioNum > 8) {
    console.error(pc.red(`\n  Invalid scenario: ${opts.scenario}. Must be 1-8.\n`));
    process.exit(1);
  }

  const projectDir = process.cwd();
  const agentName = opts.name!;
  const userName = opts.user!;

  // Determine setup type from scenario
  const isRepo = [3, 4, 5, 6].includes(scenarioNum);
  const isMultiUser = [5, 6, 7, 8].includes(scenarioNum);
  const isMultiMachine = [2, 4, 6, 7].includes(scenarioNum);

  console.log(pc.bold(`\n  Non-interactive setup: ${agentName}`));
  console.log(pc.dim(`  Scenario ${scenarioNum}: ${isRepo ? 'repo' : 'standalone'}, ${isMultiUser ? 'multi' : 'single'}-user, ${isMultiMachine ? 'multi' : 'single'}-machine`));

  // Create agent directory structure
  const stateDir = isRepo
    ? path.join(projectDir, '.instar')
    : path.join(os.homedir(), '.instar', 'agents', agentName, '.instar');
  const agentDir = isRepo ? projectDir : path.join(os.homedir(), '.instar', 'agents', agentName);

  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

  // Build config
  const config: Record<string, unknown> = {
    projectName: agentName,
    port: 4040,
    sessions: {
      tmuxPath: '/opt/homebrew/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir: agentDir,
      maxSessions: 3,
      protectedSessions: [`${agentName}-server`],
      completionPatterns: ['has been automatically paused', 'Session ended', 'Interrupted by user'],
    },
    scheduler: { jobsFile: path.join(stateDir, 'jobs.json'), enabled: false, maxParallelJobs: 1 },
    users: [],
    messaging: [] as Record<string, unknown>[],
    monitoring: { quotaTracking: false, memoryMonitoring: true, healthCheckIntervalMs: 30000 },
  };

  // Add Telegram if provided
  if (opts.telegramToken && opts.telegramGroup) {
    (config.messaging as Record<string, unknown>[]).push({
      type: 'telegram',
      enabled: true,
      config: {
        token: opts.telegramToken,
        chatId: opts.telegramGroup,
        pollIntervalMs: 2000,
        stallTimeoutMinutes: 5,
      },
    });
  }

  // Multi-user additions
  if (isMultiUser) {
    config.userRegistrationPolicy = 'admin-only';
    config.agentAutonomy = { level: 'collaborative' };

    // Generate recovery key
    const crypto = await import('node:crypto');
    const bytes = crypto.randomBytes(32);
    const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let key = '';
    let num = BigInt('0x' + bytes.toString('hex'));
    while (key.length < 44) {
      key += chars[Number(num % 58n)];
      num = num / 58n;
    }

    // Hash for storage, output key to stdout
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    config.recoveryKeyHash = hash;

    // Recovery key to stdout (single line for capture)
    console.log(key);
  }

  // Write config
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config, null, 2));

  // Write AGENT.md
  fs.writeFileSync(path.join(stateDir, 'AGENT.md'), `# Agent Identity

**Name**: ${agentName}
**Created**: ${new Date().toISOString().split('T')[0]}

## Who I Am

I am ${agentName}, set up via non-interactive mode.

## Operating Principles

- Be genuinely helpful
- Research before asking
- When in doubt, ask ${userName}
`);

  // Write USER.md
  fs.writeFileSync(path.join(stateDir, 'USER.md'), `# User Profile: ${userName}

**Name**: ${userName}
**Role**: Admin
`);

  // Write MEMORY.md
  fs.writeFileSync(path.join(stateDir, 'MEMORY.md'), `# Agent Memory

## Key Facts

- Initialized on ${new Date().toISOString().split('T')[0]} (non-interactive)
- Primary user: ${userName}
`);

  // Write empty jobs.json and users.json
  fs.writeFileSync(path.join(stateDir, 'jobs.json'), '[]');
  fs.writeFileSync(path.join(stateDir, 'users.json'), JSON.stringify([{ name: userName, role: 'admin' }], null, 2));

  // Set file permissions on sensitive files
  if (opts.telegramToken) {
    try {
      fs.chmodSync(path.join(stateDir, 'config.json'), 0o600);
    } catch { /* non-fatal on Windows */ }
  }

  console.log(pc.green(`\n  ✓ Agent "${agentName}" configured at ${stateDir}`));
  if (opts.telegramToken) {
    console.log(pc.green('  ✓ Telegram configured'));
  }
  console.log(pc.dim(`\n  Start with: instar server start --dir ${agentDir}\n`));
}
