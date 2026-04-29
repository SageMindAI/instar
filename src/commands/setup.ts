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

import { execFileSync, execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pc from 'picocolors';
import { detectClaudePath, detectGhPath } from '../core/Config.js';
import { ensurePrerequisites } from '../core/Prerequisites.js';
import { allocatePort } from '../core/AgentRegistry.js';
import type { SecretBackend } from '../core/SecretManager.js';
import {
  runDiscovery,
  buildScenarioContext,
  readSetupLock,
  deleteSetupLock,
  type SetupDiscoveryContext,
  type SetupScenarioContext,
} from './discovery.js';
import { SafeGitExecutor } from '../core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

/**
 * Try allocatePort from the registry, fall back to scanning for a free port.
 */
function allocatePortSafe(agentDir: string): number {
  try {
    return allocatePort(agentDir);
  } catch {
    // Registry unavailable — scan for a free port directly
    for (let port = 4040; port <= 4099; port++) {
      try {
        execSync(`lsof -iTCP:${port} -sTCP:LISTEN -P -n`, { stdio: 'ignore' });
      } catch {
        return port; // lsof found nothing — port is free
      }
    }
    return 4040;
  }
}

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
  const skillPath = path.join(findInstarRoot(), '.claude', 'skills', 'setup-wizard', 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    console.log();
    console.log(pc.red('  Setup wizard skill not found.'));
    console.log(pc.dim(`  Expected: ${skillPath}`));
    console.log(pc.dim('  This may indicate a corrupted installation. Try: npx instar'));
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
    gitRepoRoot = SafeGitExecutor.readSync(['rev-parse', '--show-toplevel'], { cwd: projectDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'], operation: 'src/commands/setup.ts:115' }).trim();
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
      SafeFsExecutor.safeUnlinkSync(plistPath, { operation: 'src/commands/setup.ts:590' });
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
      SafeFsExecutor.safeUnlinkSync(servicePath, { operation: 'src/commands/setup.ts:606' });
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

/**
 * Resolve multiple candidate node paths for robustness.
 * Returns all valid node binary paths found on this system, ordered by preference.
 * Used to create fallback-aware boot wrappers that survive NVM/asdf version switches.
 */
function resolveNodeCandidates(): string[] {
  const candidates = new Set<string>();

  // 1. Current session's node (most likely correct)
  try {
    const current = execFileSync('which', ['node'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (current && fs.existsSync(current)) candidates.add(current);
  } catch { /* not found */ }

  // 2. process.execPath — the node that's running THIS process right now
  if (fs.existsSync(process.execPath)) candidates.add(process.execPath);

  // 3. Well-known stable paths (survive NVM/asdf switches)
  const wellKnown = [
    '/opt/homebrew/bin/node',        // Apple Silicon homebrew
    '/usr/local/bin/node',           // Intel homebrew / manual install
    '/usr/bin/node',                 // System node (rare on macOS)
  ];
  for (const p of wellKnown) {
    if (fs.existsSync(p)) candidates.add(p);
  }

  // 4. Homebrew cellar (follows any installed version)
  try {
    const brewPrefix = execFileSync('brew', ['--prefix', 'node'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
    const brewNode = path.join(brewPrefix, 'bin', 'node');
    if (fs.existsSync(brewNode)) candidates.add(brewNode);
  } catch { /* brew not installed or node not installed via brew */ }

  return [...candidates];
}

/**
 * Pick the most durable node path from candidates.
 *
 * Prefers stable, non-versioned paths (e.g. /opt/homebrew/bin/node) over
 * version-specific paths (e.g. /opt/homebrew/opt/node@20/bin/node) because
 * version-specific paths disappear when that version is uninstalled — causing
 * the symlink to break and the agent to become unrecoverable.
 */
function pickDurableNodePath(candidates: string[]): string | undefined {
  // Stable paths that survive version switches (ordered by preference)
  const stablePrefixes = [
    '/opt/homebrew/bin/',        // Apple Silicon homebrew — updated by `brew upgrade`
    '/usr/local/bin/',           // Intel homebrew / manual installs
  ];

  // Version-specific patterns that should be avoided
  const versionSpecificPattern = /node@\d|\/Cellar\/node\/|\/\.asdf\/installs\/|\/\.nvm\/versions\//;

  // First pass: find a stable, non-versioned path
  for (const prefix of stablePrefixes) {
    const match = candidates.find(c => c.startsWith(prefix) && !versionSpecificPattern.test(c));
    if (match && fs.existsSync(match)) return match;
  }

  // Second pass: any candidate that isn't version-specific
  const nonVersioned = candidates.find(c => !versionSpecificPattern.test(c) && fs.existsSync(c));
  if (nonVersioned) return nonVersioned;

  // Last resort: any valid candidate
  return candidates.find(c => fs.existsSync(c));
}

/**
 * Create or update a stable node symlink at .instar/bin/node.
 *
 * The plist references this symlink instead of a hardcoded node path.
 * This way, when node moves (NVM switch, homebrew upgrade), we only
 * need to update the symlink — not regenerate the entire plist.
 *
 * Returns the symlink path.
 */
export function ensureStableNodeSymlink(projectDir: string): string {
  const binDir = path.join(projectDir, '.instar', 'bin');
  const symlinkPath = path.join(binDir, 'node');

  fs.mkdirSync(binDir, { recursive: true });

  // Resolve all available node paths and pick the most durable one
  const candidates = resolveNodeCandidates();
  const durablePath = pickDurableNodePath(candidates) ?? findNodePath();

  // Check if symlink exists and already points to a valid, durable target
  try {
    const target = fs.readlinkSync(symlinkPath);
    if (fs.existsSync(target)) {
      // Symlink works — only update if we found a more durable path
      if (target === durablePath) return symlinkPath;
    }
  } catch { /* symlink doesn't exist or is broken */ }

  // Create/update the symlink
  try {
    SafeFsExecutor.safeUnlinkSync(symlinkPath, { operation: 'src/commands/setup.ts:735' });
  } catch { /* didn't exist */ }
  fs.symlinkSync(durablePath, symlinkPath);

  // Also write the candidate list for the JS boot wrapper's fallback logic
  fs.writeFileSync(
    path.join(binDir, 'node-candidates.json'),
    JSON.stringify({ primary: durablePath, candidates, updatedAt: new Date().toISOString() }, null, 2),
  );

  return symlinkPath;
}

function findInstarCli(): string {
  // Find the actual instar CLI entry point
  // CRITICAL: Never resolve to an npx cache path. When users run `npx instar setup`,
  // import.meta.url points to the npx cache. If we bake that path into the launchd
  // plist, `npm install -g` updates won't reach the running binary (the npx cache
  // is a separate copy). This caused an infinite update→notify→restart loop (v0.12.12).
  try {
    const globalPath = execFileSync('which', ['instar'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (globalPath && !globalPath.includes('.npm/_npx')) {
      return globalPath;
    }
  } catch { /* not global */ }

  // Try resolving from npm's global prefix (works even when `which` fails)
  try {
    const prefix = execFileSync('npm', ['prefix', '-g'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const globalCli = path.join(prefix, 'lib', 'node_modules', 'instar', 'dist', 'cli.js');
    if (fs.existsSync(globalCli)) {
      return globalCli;
    }
  } catch { /* npm prefix failed */ }

  // Fallback: use the dist/cli.js from the npm package — but ONLY if not in npx cache
  const cliPath = new URL('../cli.js', import.meta.url).pathname;
  if (fs.existsSync(cliPath) && !cliPath.includes('.npm/_npx')) {
    return cliPath;
  }

  // Last resort: if everything points to npx cache, warn and use bare command name.
  // The plist will need PATH to resolve it, but at least it won't be pinned to a stale cache.
  if (cliPath.includes('.npm/_npx')) {
    console.warn(
      '[setup] WARNING: Running from npx cache. The launchd plist will use bare "instar" command.\n' +
      '  Auto-updates are handled via shadow installs — no global install needed.'
    );
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

/**
 * Generate and install boot wrapper scripts that resolve the shadow install
 * binary at runtime. This ensures machine reboots pick up the auto-updated
 * version instead of the version that was global at setup time.
 *
 * The shadow install is the sole source of truth — no fallback to global.
 * If the shadow install is missing, the wrapper fails loudly instead of
 * silently running a stale global binary (which causes version confusion).
 *
 * Two wrappers are generated:
 *   - instar-boot.sh  — bash wrapper for manual use / Linux systemd
 *   - instar-boot.js  — Node.js wrapper for macOS launchd (avoids /bin/bash TCC)
 *
 * On macOS, launchd spawns /bin/bash without Full Disk Access permissions,
 * causing "Operation not permitted" when accessing project directories.
 * Using node directly as the plist entry point bypasses this because
 * user-installed binaries (homebrew, nvm) are not subject to TCC restrictions.
 */
export function installBootWrapper(projectDir: string): { sh: string; js: string } {
  const stateDir = path.join(projectDir, '.instar');
  const shPath = path.join(stateDir, 'instar-boot.sh');

  // Use .cjs extension if the project has "type": "module" in package.json.
  // Without this, Node treats the boot wrapper as ESM and `require()` fails.
  let usesCjs = false;
  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
    usesCjs = pkgJson.type === 'module';
  } catch { /* no package.json or parse error — use .js */ }
  const jsExt = usesCjs ? '.cjs' : '.js';
  const jsPath = path.join(stateDir, `instar-boot${jsExt}`);
  // Clean up the other extension if it exists (prevents stale wrapper confusion)
  const altPath = path.join(stateDir, `instar-boot${usesCjs ? '.js' : '.cjs'}`);
  try { SafeFsExecutor.safeUnlinkSync(altPath, { operation: 'src/commands/setup.ts:837' }); } catch { /* didn't exist */ }

  const shadowCli = path.join(stateDir, 'shadow-install', 'node_modules', 'instar', 'dist', 'cli.js');

  const shadowDir = path.join(stateDir, 'shadow-install');

  const crashFile = path.join(stateDir, 'state', 'boot-crashes.txt');

  // ── Bash wrapper (for manual use, Linux systemd, backward compat) ──
  const bashWrapper = `#!/bin/bash
# Instar boot wrapper — generated by 'instar setup'
# Shadow install is the sole source of truth. No global fallback.
SHADOW="${shadowCli}"
SHADOW_DIR="${shadowDir}"
CRASH_FILE="${crashFile}"

if [ ! -f "$SHADOW" ]; then
  echo "ERROR: Shadow install not found at $SHADOW" >&2
  echo "Run: npm install instar --prefix ${stateDir}/shadow-install" >&2
  exit 1
fi

# Strip extended attributes that may block launchd's restricted sandbox.
# com.apple.quarantine is removable; com.apple.provenance silently fails on macOS 15+.
if command -v xattr >/dev/null 2>&1; then
  xattr -rd com.apple.quarantine "$SHADOW_DIR" 2>/dev/null || true
  xattr -rd com.apple.provenance "$SHADOW_DIR" 2>/dev/null || true
fi

# Crash loop protection: if node fails rapidly, back off before exiting.
# Prevents launchd KeepAlive from spinning at max speed on persistent errors.
mkdir -p "$(dirname "$CRASH_FILE")" 2>/dev/null
node "$SHADOW" "$@"
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "$(date -u +%s)" >> "$CRASH_FILE"
  # Count crashes in the last 120 seconds
  NOW=$(date -u +%s)
  RECENT=$(awk -v now="$NOW" '$1 > now - 120' "$CRASH_FILE" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$RECENT" -ge 3 ]; then
    BACKOFF=$((RECENT * 10))
    [ "$BACKOFF" -gt 120 ] && BACKOFF=120
    echo "[instar-boot] Crash loop detected ($RECENT crashes in 120s). Backing off \${BACKOFF}s..." >&2
    sleep $BACKOFF
  fi
  # Trim crash file to last 20 entries
  tail -20 "$CRASH_FILE" > "$CRASH_FILE.tmp" 2>/dev/null && mv "$CRASH_FILE.tmp" "$CRASH_FILE" 2>/dev/null
  exit $EXIT_CODE
fi

# Clean exit — clear crash history
rm -f "$CRASH_FILE" 2>/dev/null
`;

  // ── Node.js wrapper (for macOS launchd — bypasses /bin/bash TCC) ──
  //
  // The plist references .instar/bin/node (a stable symlink) to execute this wrapper.
  // If the symlink breaks (NVM switch, homebrew upgrade), launchd can't even start
  // this script — that's the chicken-and-egg problem.
  //
  // To mitigate: this wrapper self-heals the node symlink on every successful boot,
  // ensuring the NEXT restart will work even if node moved between boots.
  // For the initial bootstrap gap, the plist includes the full PATH env var so
  // launchd can resolve commands, and we use well-known fallback paths.
  const nodeSymlinkDir = path.join(stateDir, 'bin');
  const nodeCandidatesFile = path.join(nodeSymlinkDir, 'node-candidates.json');

  const jsWrapper = `#!/usr/bin/env node
/**
 * Instar boot wrapper (Node.js) — generated by 'instar setup'
 *
 * This replaces /bin/bash as the launchd entry point on macOS.
 * On macOS Sequoia+, launchd-spawned /bin/bash lacks Full Disk Access,
 * causing "Operation not permitted" when accessing project files.
 * User-installed node (homebrew, nvm) is not subject to TCC restrictions.
 *
 * Shadow install is the sole source of truth. No global fallback.
 */
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SHADOW = ${JSON.stringify(shadowCli)};
const SHADOW_DIR = ${JSON.stringify(shadowDir)};
const CRASH_FILE = ${JSON.stringify(crashFile)};
const NODE_SYMLINK = ${JSON.stringify(path.join(nodeSymlinkDir, 'node'))};
const NODE_CANDIDATES_FILE = ${JSON.stringify(nodeCandidatesFile)};

// ── Self-heal node symlink ──
// Update the stable node symlink to point at a working node binary.
// CRITICAL: Only change the symlink if it's broken (missing or won't run).
// "More durable" path selection must NOT cross major versions because the
// shadow-install's native modules (better-sqlite3) are compiled for a specific
// NODE_MODULE_VERSION. Switching from v22 -> v25 (or any major bump) breaks
// native modules and causes server crash-loops / event loop deadlocks.
function selfHealNodeSymlink() {
  try {
    const currentNode = process.execPath;
    const symlinkDir = path.dirname(NODE_SYMLINK);
    fs.mkdirSync(symlinkDir, { recursive: true });

    // If symlink exists and works, don't touch it — changing node major version
    // breaks native modules compiled for the previous version.
    try {
      const target = fs.readlinkSync(NODE_SYMLINK);
      if (fs.existsSync(target)) {
        const { execFileSync } = require('child_process');
        const result = execFileSync(target, ['--version'], { encoding: 'utf-8', timeout: 5000 });
        if (result.trim()) return; // symlink works, leave it alone
      }
    } catch { /* broken — proceed to fix */ }

    process.stderr.write('[instar-boot] Node symlink broken — attempting repair\\n');

    // Build candidate list
    const candidates = [currentNode];
    const wellKnown = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
    for (const p of wellKnown) {
      if (p !== currentNode && fs.existsSync(p)) candidates.push(p);
    }

    // Check if native modules exist — if so, prefer a node with the same major version
    const sqliteNode = path.join(${JSON.stringify(stateDir)}, 'shadow-install', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    let best = currentNode;

    if (fs.existsSync(sqliteNode)) {
      // Try to find which candidate can actually load the native module
      const { execFileSync } = require('child_process');
      for (const candidate of candidates) {
        try {
          execFileSync(candidate, ['-e', "require('" + sqliteNode.replace(/'/g, "\\\\'") + "')"], {
            encoding: 'utf-8', timeout: 10000
          });
          best = candidate;
          process.stderr.write('[instar-boot] Found compatible node for native modules: ' + candidate + '\\n');
          break;
        } catch { /* this candidate can't load native modules */ }
      }
    } else {
      // No native modules to worry about — pick most durable path
      const versionPattern = /node@\\d|\\/Cellar\\/node\\/|\\.asdf\\/installs\\/|\\.nvm\\/versions\\//;
      const stablePrefixes = ['/opt/homebrew/bin/', '/usr/local/bin/'];
      for (const prefix of stablePrefixes) {
        const match = candidates.find(c => c.startsWith(prefix) && !versionPattern.test(c) && fs.existsSync(c));
        if (match) { best = match; break; }
      }
      if (versionPattern.test(best)) {
        const nonVersioned = candidates.find(c => !versionPattern.test(c) && fs.existsSync(c));
        if (nonVersioned) best = nonVersioned;
      }
    }

    // Update symlink
    try { fs.unlinkSync(NODE_SYMLINK); } catch { /* didn't exist */ }
    fs.symlinkSync(best, NODE_SYMLINK);

    // Update candidates file for diagnostics
    fs.writeFileSync(NODE_CANDIDATES_FILE, JSON.stringify({
      primary: best,
      candidates: candidates,
      updatedAt: new Date().toISOString(),
      updatedBy: 'instar-boot.js',
    }, null, 2));

    process.stderr.write('[instar-boot] Node symlink self-healed: ' + NODE_SYMLINK + ' -> ' + best + '\\n');
  } catch (err) {
    // Non-fatal — symlink update is best-effort
    process.stderr.write('[instar-boot] Node symlink self-heal failed (non-critical): ' + err.message + '\\n');
  }
}

selfHealNodeSymlink();

// Verify shadow install exists
if (!fs.existsSync(SHADOW)) {
  process.stderr.write('ERROR: Shadow install not found at ' + SHADOW + '\\n');
  process.stderr.write('Run: npm install instar --prefix ' + ${JSON.stringify(stateDir + '/shadow-install')} + '\\n');
  process.exit(1);
}

// Strip macOS extended attributes that may block launchd's restricted sandbox
if (os.platform() === 'darwin') {
  try {
    execFileSync('xattr', ['-rd', 'com.apple.quarantine', SHADOW_DIR], { stdio: 'ignore' });
  } catch { /* no quarantine to remove — fine */ }
  try {
    execFileSync('xattr', ['-rd', 'com.apple.provenance', SHADOW_DIR], { stdio: 'ignore' });
  } catch { /* provenance is kernel-protected on macOS 15+ — fine */ }
}

// Ensure crash file directory exists
const crashDir = path.dirname(CRASH_FILE);
fs.mkdirSync(crashDir, { recursive: true });

// Spawn the CLI as a child process and wait for exit
const args = process.argv.slice(2);
const child = spawn(process.execPath, [SHADOW, ...args], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  const exitCode = code ?? (signal ? 1 : 0);

  if (exitCode !== 0) {
    // Record crash timestamp
    const now = Math.floor(Date.now() / 1000);
    fs.appendFileSync(CRASH_FILE, now + '\\n');

    // Count crashes in the last 120 seconds
    try {
      const lines = fs.readFileSync(CRASH_FILE, 'utf-8').trim().split('\\n');
      const cutoff = now - 120;
      const recent = lines.filter(l => parseInt(l, 10) > cutoff).length;

      if (recent >= 3) {
        const backoff = Math.min(recent * 10, 120);
        process.stderr.write('[instar-boot] Crash loop detected (' + recent + ' crashes in 120s). Backing off ' + backoff + 's...\\n');
        // Block before exiting so launchd KeepAlive doesn't spin
        execFileSync('sleep', [String(backoff)], { stdio: 'ignore' });
      }

      // Trim crash file to last 20 entries
      if (lines.length > 20) {
        fs.writeFileSync(CRASH_FILE, lines.slice(-20).join('\\n') + '\\n');
      }
    } catch { /* crash file read failed — not critical */ }

    process.exit(exitCode);
  }

  // Clean exit — clear crash history
  try { fs.unlinkSync(CRASH_FILE); } catch { /* ok */ }
  process.exit(0);
});

child.on('error', (err) => {
  process.stderr.write('[instar-boot] Failed to spawn CLI: ' + err.message + '\\n');
  process.exit(1);
});
`;

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(shPath, bashWrapper, { mode: 0o755 });
  fs.writeFileSync(jsPath, jsWrapper, { mode: 0o755 });
  return { sh: shPath, js: jsPath };
}

/**
 * Ensure the boot wrapper exists on disk, regenerating it if missing.
 *
 * The boot wrapper is what launchd exec's — if it's gone, launchd can't
 * bring the agent back after any restart. The wrapper itself can't
 * regenerate itself (chicken-and-egg), but any running process that
 * descends from it can, which closes the loop for future restarts.
 *
 * Returns `true` if a wrapper was written (was missing), `false` if
 * it was already present and nothing was done.
 */
export function ensureBootWrapper(projectDir: string): boolean {
  const stateDir = path.join(projectDir, '.instar');
  let usesCjs = false;
  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
    usesCjs = pkgJson.type === 'module';
  } catch { /* no package.json — use .js */ }
  const jsExt = usesCjs ? '.cjs' : '.js';
  const jsPath = path.join(stateDir, `instar-boot${jsExt}`);
  const shPath = path.join(stateDir, 'instar-boot.sh');

  if (fs.existsSync(jsPath) && fs.existsSync(shPath)) return false;

  console.warn(
    `[setup] Boot wrapper(s) missing under ${stateDir} — regenerating. ` +
    `If the agent had been restarted by launchd in this state, it would have been permanently dead.`
  );
  installBootWrapper(projectDir);
  return true;
}

function installMacOSLaunchAgent(projectName: string, projectDir: string, hasTelegram: boolean): boolean {
  const label = `ai.instar.${projectName}`;
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plistPath = path.join(launchAgentsDir, `${label}.plist`);
  const logDir = path.join(projectDir, '.instar', 'logs');

  // Install boot wrappers that resolve shadow install at startup time.
  // This ensures machine reboots use the auto-updated version, not the version
  // that was global when setup ran. See: github issue / cluster-shadow-install-*
  const wrappers = installBootWrapper(projectDir);

  // Determine what to start: lifeline if Telegram configured, otherwise just the server
  const command = hasTelegram ? 'lifeline' : 'server';
  const args = hasTelegram
    ? ['lifeline', 'start', '--dir', projectDir]
    : ['server', 'start', '--foreground', '--dir', projectDir];

  // Use node + JS wrapper instead of /bin/bash + shell wrapper.
  // On macOS Sequoia+, launchd-spawned /bin/bash lacks Full Disk Access (TCC),
  // causing "Operation not permitted" on project files. User-installed node
  // (homebrew, nvm) is not subject to TCC restrictions.
  //
  // We use a stable symlink (.instar/bin/node) so NVM/asdf version switches
  // don't break the plist. The symlink is updated by self-healing on every startup.
  const nodeSymlink = ensureStableNodeSymlink(projectDir);
  const programArgs = [nodeSymlink, wrappers.js, ...args];

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
        <key>INSTAR_SUPERVISED</key>
        <string>1</string>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>`;

  try {
    fs.mkdirSync(launchAgentsDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(plistPath, plist);

    // Validate the plist is well-formed XML before loading.
    // A corrupted plist means launchd can't restart the agent after crashes,
    // which turns transient failures into permanently dead agents.
    try {
      execFileSync('plutil', ['-lint', plistPath], { stdio: 'pipe' });
    } catch (err) {
      const stderr = err instanceof Error && 'stderr' in err ? String((err as any).stderr) : '';
      console.error(`[setup] CRITICAL: Generated plist failed validation: ${stderr}`);
      console.error(`[setup] Plist path: ${plistPath}`);
      // Remove the invalid plist so we don't leave a landmine
      try { SafeFsExecutor.safeUnlinkSync(plistPath, { operation: 'src/commands/setup.ts:1195' }); } catch { /* best effort */ }
      return false;
    }

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
  whatsappBackend?: string;
  whatsappPhone?: string;
  whatsappPhoneNumberId?: string;
  whatsappAccessToken?: string;
  whatsappVerifyToken?: string;
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
    port: allocatePortSafe(agentDir),
    sessions: {
      tmuxPath: '/opt/homebrew/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir: agentDir,
      maxSessions: 10,
      protectedSessions: [`${agentName}-server`],
      completionPatterns: ['has been automatically paused', 'Session ended', 'Interrupted by user'],
    },
    scheduler: { jobsFile: path.join(stateDir, 'jobs.json'), enabled: true, maxParallelJobs: 1 },
    users: [],
    messaging: [] as Record<string, unknown>[],
    monitoring: { quotaTracking: false, memoryMonitoring: true, healthCheckIntervalMs: 30000 },
  };

  // Add Telegram if provided
  if (opts.telegramToken && opts.telegramGroup) {
    // Validate chatId is numeric (Telegram chat IDs are integers, typically negative for groups)
    // Users sometimes paste invite links (t.me/+ABC123) or link hashes instead of the numeric ID
    let chatId = opts.telegramGroup.trim();
    let chatIdValid = /^-?\d+$/.test(chatId);
    if (!chatIdValid) {
      console.warn(`[setup] ⚠️ Telegram chatId "${chatId}" does not look like a numeric chat ID.`);
      console.warn('[setup] Telegram chat IDs are integers (e.g., -1001234567890 for supergroups).');
      console.warn('[setup] Attempting to resolve via Telegram API...');
      try {
        const res = await fetch(`https://api.telegram.org/bot${opts.telegramToken}/getChat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId }),
        });
        const data = await res.json() as { ok: boolean; result?: { id: number }; description?: string };
        if (data.ok && data.result?.id) {
          chatId = String(data.result.id);
          chatIdValid = true;
          console.log(`[setup] ✓ Resolved to numeric chat ID: ${chatId}`);
        } else {
          console.error(`[setup] ✗ Could not resolve "${opts.telegramGroup}" to a chat ID: ${data.description ?? 'unknown error'}`);
          console.error('[setup] Skipping Telegram setup. Run setup again with a valid numeric chat ID.');
        }
      } catch (err) {
        console.error(`[setup] ✗ Failed to validate chat ID: ${err}`);
        console.error('[setup] Skipping Telegram setup. Run setup again with a valid numeric chat ID.');
      }
    }
    if (chatIdValid) {
      (config.messaging as Record<string, unknown>[]).push({
        type: 'telegram',
        enabled: true,
        config: {
          token: opts.telegramToken,
          chatId,
          pollIntervalMs: 2000,
          stallTimeoutMinutes: 5,
        },
      });
    }
  }

  // Add WhatsApp if provided
  if (opts.whatsappBackend && opts.whatsappPhone) {
    const waConfig: Record<string, unknown> = {
      backend: opts.whatsappBackend,
      authorizedNumbers: [opts.whatsappPhone],
      requireConsent: false,
    };

    if (opts.whatsappBackend === 'business-api' && opts.whatsappPhoneNumberId && opts.whatsappAccessToken) {
      waConfig.businessApi = {
        phoneNumberId: opts.whatsappPhoneNumberId,
        accessToken: opts.whatsappAccessToken,
        webhookVerifyToken: opts.whatsappVerifyToken ?? '',
      };
    }

    (config.messaging as Record<string, unknown>[]).push({
      type: 'whatsapp',
      enabled: true,
      config: waConfig,
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
