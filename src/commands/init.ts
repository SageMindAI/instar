/**
 * `instar init` — Initialize agent infrastructure.
 *
 * Two modes:
 *   instar init <project-name>   — Create a new project from scratch
 *   instar init                  — Augment an existing project
 *
 * Fresh install creates:
 *   <project-name>/
 *   ├── CLAUDE.md              — Agent instructions (standalone)
 *   ├── .instar/
 *   │   ├── AGENT.md           — Agent identity
 *   │   ├── USER.md            — Primary user context
 *   │   ├── MEMORY.md          — Persistent memory
 *   │   ├── config.json        — Agent configuration
 *   │   ├── jobs.json          — Job definitions
 *   │   ├── users.json         — User profiles
 *   │   ├── hooks/             — Behavioral guardrails
 *   │   ├── state/             — Runtime state
 *   │   ├── relationships/     — Relationship tracking
 *   │   └── logs/              — Server logs
 *   ├── .claude/
 *   │   ├── settings.json      — Hook configuration
 *   │   └── scripts/           — Health watchdog, etc.
 *   └── .gitignore
 *
 * Existing project adds .instar/ and appends to CLAUDE.md.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pc from 'picocolors';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { detectTmuxPath, detectClaudePath, detectGitPath, detectGhPath, ensureStateDir, standaloneAgentsDir, getInstarVersion } from '../core/Config.js';
import { ensurePrerequisites } from '../core/Prerequisites.js';
import { allocatePort, registerAgent, validateAgentName } from '../core/AgentRegistry.js';
import { defaultIdentity } from '../scaffold/bootstrap.js';
import { MachineIdentityManager, ensureGitignore } from '../core/MachineIdentity.js';
import { PostUpdateMigrator } from '../core/PostUpdateMigrator.js';
import { ProjectMapper } from '../core/ProjectMapper.js';
import { ContextHierarchy } from '../core/ContextHierarchy.js';
import { CanonicalState } from '../core/CanonicalState.js';
import { ManifestIntegrity } from '../security/ManifestIntegrity.js';
import {
  generateAgentMd,
  generateUserMd,
  generateMemoryMd,
  generateClaudeMd,
} from '../scaffold/templates.js';
import type { InstarConfig } from '../core/types.js';

interface InitOptions {
  dir?: string;
  name?: string;
  port?: number;
  interactive?: boolean;
  /** Create a standalone agent at ~/.instar/agents/<name>/ */
  standalone?: boolean;
  /** Skip prerequisite checks (for testing). When true, uses provided or default paths. */
  skipPrereqs?: boolean;
}

/**
 * Main init entry point. Handles both fresh and existing project modes.
 */
export async function initProject(options: InitOptions): Promise<void> {
  // Standalone mode: create at ~/.instar/agents/<name>/
  if (options.standalone) {
    const agentName = options.name;
    if (!agentName) {
      console.log(pc.red('  A name is required for standalone agents.'));
      console.log(`  Usage: ${pc.cyan('instar init --standalone my-agent')}`);
      process.exit(1);
    }
    return initStandaloneAgent(agentName, options);
  }

  // Detect mode: if a project name argument was passed, it's fresh install
  const projectName = options.name;
  const isFresh = !!projectName && !options.dir;

  if (isFresh) {
    return initFreshProject(projectName!, options);
  } else {
    return initExistingProject(options);
  }
}

/**
 * Fresh install: create a new project directory with everything scaffolded.
 */
async function initFreshProject(projectName: string, options: InitOptions): Promise<void> {
  // Validate project name — prevent path traversal, shell injection, and filesystem issues
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(projectName)) {
    console.log(pc.red(`  Invalid project name: "${projectName}"`));
    console.log(`  Project names must start with a letter or number and contain only letters, numbers, dots, hyphens, and underscores.`);
    process.exit(1);
  }
  if (projectName === '.' || projectName === '..' || projectName.includes('/') || projectName.includes('\\')) {
    console.log(pc.red(`  Invalid project name: "${projectName}"`));
    process.exit(1);
  }

  const projectDir = path.resolve(process.cwd(), projectName);

  console.log();
  console.log(pc.bold(`  Creating new agent project: ${pc.cyan(projectName)}`));
  console.log(pc.dim(`  Directory: ${projectDir}`));
  console.log();

  // Check and install prerequisites
  let tmuxPath: string;
  let claudePath: string;

  if (options.skipPrereqs) {
    tmuxPath = detectTmuxPath() || '/usr/bin/tmux';
    claudePath = detectClaudePath() || '/usr/bin/claude';
  } else {
    const prereqs = await ensurePrerequisites();
    if (!prereqs.allMet) {
      process.exit(1);
    }
    tmuxPath = prereqs.results.find(r => r.name === 'tmux')!.path!;
    claudePath = prereqs.results.find(r => r.name === 'Claude CLI')!.path!;
  }

  // Check if directory already exists
  if (fs.existsSync(projectDir)) {
    const contents = fs.readdirSync(projectDir);
    if (contents.length > 0) {
      console.log(pc.red(`  Directory "${projectName}" already exists and is not empty.`));
      console.log(`  Use ${pc.cyan('instar init')} inside an existing project instead.`);
      process.exit(1);
    }
  }

  // Create project directory
  fs.mkdirSync(projectDir, { recursive: true });

  // Auto-allocate a port if not explicitly specified (multi-instance support)
  let port: number;
  if (options.port) {
    port = options.port;
  } else {
    try {
      port = allocatePort(projectDir);
      console.log(`  ${pc.green('✓')} Auto-allocated port ${port} (from ~/.instar/registry.json)`);
    } catch {
      port = 4040; // Fallback to default
    }
  }

  // Generate identity (non-interactive for init, interactive for setup)
  const identity = defaultIdentity(projectName);

  // Create .instar/ state directory
  const stateDir = path.join(projectDir, '.instar');
  ensureStateDir(stateDir);
  console.log(`  ${pc.green('✓')} Created .instar/`);

  // Write identity files
  fs.writeFileSync(path.join(stateDir, 'AGENT.md'), generateAgentMd(identity));
  console.log(`  ${pc.green('✓')} Created .instar/AGENT.md`);

  fs.writeFileSync(path.join(stateDir, 'USER.md'), generateUserMd(identity.userName));
  console.log(`  ${pc.green('✓')} Created .instar/USER.md`);

  fs.writeFileSync(path.join(stateDir, 'MEMORY.md'), generateMemoryMd(identity.name));
  console.log(`  ${pc.green('✓')} Created .instar/MEMORY.md`);

  // Write config
  const authToken = randomUUID();
  const config: Partial<InstarConfig> = {
    projectName,
    port,
    sessions: {
      tmuxPath,
      claudePath,
      projectDir,
      maxSessions: 10,
      protectedSessions: [`${projectName}-server`],
      completionPatterns: [
        'has been automatically paused',
        'Session ended',
        'Interrupted by user',
      ],
    },
    scheduler: {
      jobsFile: path.join(stateDir, 'jobs.json'),
      enabled: true,
      maxParallelJobs: 2,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    },
    users: [],
    messaging: [],
    monitoring: {
      quotaTracking: false,
      memoryMonitoring: true,
      healthCheckIntervalMs: 30000,
    },
    authToken,
    relationships: {
      relationshipsDir: path.join(stateDir, 'relationships'),
      maxRecentInteractions: 20,
    },
    feedback: {
      enabled: true,
      webhookUrl: 'https://dawn.bot-me.ai/api/instar/feedback',
      feedbackFile: path.join(stateDir, 'feedback.json'),
      sharedSecret: 'instar-rising-tide-v1',
    },
    dispatches: {
      enabled: true,
      dispatchUrl: 'https://dawn.bot-me.ai/api/instar/dispatches',
      dispatchFile: path.join(stateDir, 'state', 'dispatches.json'),
      autoApply: false,
    },
    updates: {
      autoApply: true,
    },
    safety: {
      level: 1,  // 1 = ask user before risky actions, 2 = agent self-verifies (autonomous)
      alwaysBlock: [
        'rm -rf /',
        'rm -rf ~',
        '> /dev/sda',
        'mkfs.',
        'dd if=',
        ':(){:|:&};:',
      ],
    },
    externalOperations: {
      enabled: true,
      sentinel: { enabled: true },
      services: {},
      readOnlyServices: [],
      trust: {
        floor: 'collaborative',
        autoElevateEnabled: true,
        elevationThreshold: 5,
      },
    },
    tunnel: {
      enabled: true,
      type: 'quick',
    },
    threadline: {
      relayEnabled: true,
      visibility: 'public',
      capabilities: ['chat'],
    },
  };

  const configFilePath = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFilePath, JSON.stringify(config, null, 2), { mode: 0o600 });
  console.log(`  ${pc.green('✓')} Created .instar/config.json`);

  // Generate manifest signing key (machine-local, never transmitted)
  const manifestIntegrity = new ManifestIntegrity(path.join(stateDir, 'state'));
  manifestIntegrity.ensureKey();
  console.log(`  ${pc.green('✓')} Created manifest signing key`);

  // Write default jobs (scheduler enabled by default for fresh projects)
  const defaultJobs = getDefaultJobs(port);
  fs.writeFileSync(
    path.join(stateDir, 'jobs.json'),
    JSON.stringify(defaultJobs, null, 2),
  );
  console.log(`  ${pc.green('✓')} Created .instar/jobs.json (${defaultJobs.length} default jobs)`);

  // Write empty users
  fs.writeFileSync(
    path.join(stateDir, 'users.json'),
    JSON.stringify([], null, 2),
  );

  // Install hooks
  installHooks(stateDir);
  console.log(`  ${pc.green('✓')} Created .instar/hooks/instar/ (behavioral guardrails)`);

  // Initialize coherence infrastructure
  try {
    const mapper = new ProjectMapper({ projectDir, stateDir });
    mapper.generateAndSave();
    console.log(`  ${pc.green('✓')} Created .instar/project-map.json + project-map.md`);
  } catch { /* non-critical */ }

  const ctxHierarchy = new ContextHierarchy({ stateDir, projectDir, projectName });
  ctxHierarchy.initialize();
  console.log(`  ${pc.green('✓')} Created .instar/context/ (tiered context hierarchy)`);

  const canonicalState = new CanonicalState({ stateDir });
  canonicalState.initialize(projectName, projectDir);
  console.log(`  ${pc.green('✓')} Created .instar/quick-facts.json, anti-patterns.json, project-registry.json`);

  // Create .claude/ structure
  installClaudeSettings(projectDir);
  console.log(`  ${pc.green('✓')} Created .claude/settings.json`);

  installHealthWatchdog(projectDir, port, projectName);
  console.log(`  ${pc.green('✓')} Created .claude/scripts/health-watchdog.sh`);

  installSmartFetch(projectDir);
  console.log(`  ${pc.green('✓')} Created .claude/scripts/smart-fetch.py (agentic web conventions)`);

  installGitSyncGate(projectDir);
  console.log(`  ${pc.green('✓')} Created .claude/scripts/git-sync-gate.sh (git sync pre-screening)`);

  installSerendipityCapture(projectDir);
  console.log(`  ${pc.green('✓')} Created .instar/scripts/serendipity-capture.sh`);

  // Create .claude/skills/ directory and install built-in skills
  const skillsDir = path.join(projectDir, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  installBuiltinSkills(skillsDir, port);
  console.log(`  ${pc.green('✓')} Created .claude/skills/ (with built-in evolution skills)`);

  // Write CLAUDE.md (standalone version for fresh projects)
  const claudeMd = generateClaudeMd(projectName, identity.name, port, false);
  fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), claudeMd);
  console.log(`  ${pc.green('✓')} Created CLAUDE.md`);

  // Write .gitignore
  const gitignore = `# Instar per-machine state (sessions, logs, secrets)
.instar/state/
.instar/logs/
.instar/config.json

# Node
node_modules/
`;
  fs.writeFileSync(path.join(projectDir, '.gitignore'), gitignore);
  // Add multi-machine gitignore entries (private keys, secrets, pairing)
  ensureGitignore(projectDir);
  console.log(`  ${pc.green('✓')} Created .gitignore`);

  // Generate machine identity (cryptographic keypairs for multi-machine)
  const machineIdentityManager = new MachineIdentityManager(stateDir);
  const machineIdentity = await machineIdentityManager.generateIdentity({ role: 'awake' });
  console.log(`  ${pc.green('✓')} Generated machine identity (${machineIdentity.name})`);

  // Initialize git repo
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init'], { cwd: projectDir, stdio: 'pipe' });
    console.log(`  ${pc.green('✓')} Initialized git repository`);

    // Configure git commit signing with machine identity
    try {
      const { GitSyncManager } = await import('../core/GitSync.js');
      const { SecurityLog } = await import('../core/SecurityLog.js');
      const securityLog = new SecurityLog(stateDir);
      const gitSync = new GitSyncManager({
        projectDir,
        stateDir,
        identityManager: machineIdentityManager,
        securityLog,
        machineId: machineIdentity.machineId,
      });
      if (!gitSync.isSigningConfigured()) {
        gitSync.configureCommitSigning();
        console.log(`  ${pc.green('✓')} Configured git commit signing`);
      }
    } catch {
      // Non-fatal — signing can be configured later
    }
  } catch {
    // Git not available — that's fine
  }

  // Record current version so first server start doesn't dump all historical upgrade guides
  const freshVersionFile = path.join(stateDir, 'state', 'last-migrated-version.json');
  const freshVersionDir = path.dirname(freshVersionFile);
  if (!fs.existsSync(freshVersionDir)) fs.mkdirSync(freshVersionDir, { recursive: true });
  fs.writeFileSync(freshVersionFile, JSON.stringify({ version: getInstarVersion(), migratedAt: new Date().toISOString() }));

  // Register in global agent registry
  try {
    registerAgent(projectDir, projectName, port, 'project-bound', 0);
    console.log(`  ${pc.green('✓')} Registered in global agent registry`);
  } catch {
    // Non-fatal — will register on first server start
  }

  // Summary
  console.log();
  console.log(pc.bold(pc.green('  Project created!')));
  console.log();
  console.log(`  ${pc.cyan(projectName)}/`);
  console.log(`  ├── CLAUDE.md              ${pc.dim('Agent instructions')}`);
  console.log(`  ├── .instar/`);
  console.log(`  │   ├── AGENT.md           ${pc.dim('Agent identity')}`);
  console.log(`  │   ├── USER.md            ${pc.dim('User context')}`);
  console.log(`  │   ├── MEMORY.md          ${pc.dim('Persistent memory')}`);
  console.log(`  │   ├── config.json        ${pc.dim('Configuration')}`);
  console.log(`  │   ├── jobs.json          ${pc.dim('Scheduled jobs')}`);
  console.log(`  │   └── hooks/             ${pc.dim('Behavioral guardrails')}`);
  console.log(`  ├── .claude/`);
  console.log(`  │   ├── settings.json      ${pc.dim('Hook configuration')}`);
  console.log(`  │   ├── scripts/           ${pc.dim('Agent-authored scripts')}`);
  console.log(`  │   └── skills/            ${pc.dim('Agent-authored skills')}`);
  console.log(`  └── .gitignore`);
  console.log();
  console.log(pc.bold('  Next steps:'));
  console.log(`  ${pc.dim('1.')} ${pc.cyan(`cd ${projectName}`)}`);
  console.log(`  ${pc.dim('2.')} ${pc.cyan('instar server start')}     ${pc.dim('Start the agent server')}`);
  console.log(`  ${pc.dim('3.')} ${pc.cyan('claude')}                     ${pc.dim('Open a Claude session')}`);
  console.log();
  console.log(`  Auth token: ${pc.dim(authToken.slice(0, 8) + '...' + authToken.slice(-4))}`);
  console.log(`  ${pc.dim('(full token saved in .instar/config.json — use for API calls)')}`);
  console.log();
}

/**
 * Existing project: add .instar/ infrastructure without replacing anything.
 */
async function initExistingProject(options: InitOptions): Promise<void> {
  const projectDir = path.resolve(options.dir || process.cwd());
  const projectName = options.name || path.basename(projectDir);

  // Auto-allocate a port if not explicitly specified (multi-instance support)
  let port: number;
  if (options.port) {
    port = options.port;
  } else {
    try {
      port = allocatePort(projectDir);
    } catch {
      port = 4040;
    }
  }

  console.log(pc.bold(`\nInitializing instar in: ${pc.cyan(projectDir)}`));
  console.log();

  // Check and install prerequisites
  let tmuxPath: string;
  let claudePath: string;

  if (options.skipPrereqs) {
    tmuxPath = detectTmuxPath() || '/usr/bin/tmux';
    claudePath = detectClaudePath() || '/usr/bin/claude';
  } else {
    const prereqs = await ensurePrerequisites();
    if (!prereqs.allMet) {
      process.exit(1);
    }
    tmuxPath = prereqs.results.find(r => r.name === 'tmux')!.path!;
    claudePath = prereqs.results.find(r => r.name === 'Claude CLI')!.path!;
  }

  // Create state directory
  const stateDir = path.join(projectDir, '.instar');
  ensureStateDir(stateDir);
  console.log(pc.green('  Created:') + ' .instar/');

  // Write config
  const config: Partial<InstarConfig> = {
    projectName,
    port,
    sessions: {
      tmuxPath,
      claudePath,
      projectDir,
      maxSessions: 10,
      protectedSessions: [`${projectName}-server`],
      completionPatterns: [
        'has been automatically paused',
        'Session ended',
        'Interrupted by user',
      ],
    },
    scheduler: {
      jobsFile: path.join(stateDir, 'jobs.json'),
      enabled: false,
      maxParallelJobs: 2,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    },
    users: [],
    messaging: [],
    monitoring: {
      quotaTracking: false,
      memoryMonitoring: true,
      healthCheckIntervalMs: 30000,
    },
    authToken: randomUUID(),
    relationships: {
      relationshipsDir: path.join(stateDir, 'relationships'),
      maxRecentInteractions: 20,
    },
    feedback: {
      enabled: true,
      webhookUrl: 'https://dawn.bot-me.ai/api/instar/feedback',
      feedbackFile: path.join(stateDir, 'feedback.json'),
      sharedSecret: 'instar-rising-tide-v1',
    },
    dispatches: {
      enabled: true,
      dispatchUrl: 'https://dawn.bot-me.ai/api/instar/dispatches',
      dispatchFile: path.join(stateDir, 'state', 'dispatches.json'),
      autoApply: false,
    },
    updates: {
      autoApply: true,
    },
    safety: {
      level: 1,  // 1 = ask user before risky actions, 2 = agent self-verifies (autonomous)
      alwaysBlock: [
        'rm -rf /',
        'rm -rf ~',
        '> /dev/sda',
        'mkfs.',
        'dd if=',
        ':(){:|:&};:',
      ],
    },
    externalOperations: {
      enabled: true,
      sentinel: { enabled: true },
      services: {},
      readOnlyServices: [],
      trust: {
        floor: 'supervised',  // Conservative for existing projects
        autoElevateEnabled: false,  // Disabled until operator confirms
        elevationThreshold: 5,
      },
    },
    tunnel: {
      enabled: true,
      type: 'quick',
    },
    threadline: {
      relayEnabled: true,
      visibility: 'public',
      capabilities: ['chat'],
    },
  };

  const configPath = path.join(stateDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    console.log(pc.green('  Created:') + ' .instar/config.json');
  } else {
    console.log(pc.dim('  Exists:') + ' .instar/config.json (preserved)');
  }

  // Write default coherence jobs (only if not existing)
  const jobsPath = path.join(stateDir, 'jobs.json');
  if (!fs.existsSync(jobsPath)) {
    const defaultJobs = getDefaultJobs(port);
    fs.writeFileSync(jobsPath, JSON.stringify(defaultJobs, null, 2));
    console.log(pc.green('  Created:') + ` .instar/jobs.json (${defaultJobs.length} default jobs)`);
  } else {
    console.log(pc.dim('  Exists:') + ' .instar/jobs.json (preserved)');
  }

  // Write empty users (only if not existing)
  const usersPath = path.join(stateDir, 'users.json');
  if (!fs.existsSync(usersPath)) {
    fs.writeFileSync(usersPath, JSON.stringify([], null, 2));
    console.log(pc.green('  Created:') + ' .instar/users.json');
  } else {
    console.log(pc.dim('  Exists:') + ' .instar/users.json (preserved)');
  }

  // Create identity files if they don't exist
  const identity = defaultIdentity(projectName);
  if (!fs.existsSync(path.join(stateDir, 'AGENT.md'))) {
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), generateAgentMd(identity));
    console.log(pc.green('  Created:') + ' .instar/AGENT.md');
  }
  if (!fs.existsSync(path.join(stateDir, 'USER.md'))) {
    fs.writeFileSync(path.join(stateDir, 'USER.md'), generateUserMd(identity.userName));
    console.log(pc.green('  Created:') + ' .instar/USER.md');
  }
  if (!fs.existsSync(path.join(stateDir, 'MEMORY.md'))) {
    fs.writeFileSync(path.join(stateDir, 'MEMORY.md'), generateMemoryMd(identity.name));
    console.log(pc.green('  Created:') + ' .instar/MEMORY.md');
  }

  // Install hooks
  installHooks(stateDir);
  console.log(pc.green('  Created:') + ' .instar/hooks/instar/ (behavioral guardrails)');

  // Ensure manifest signing key exists (additive — won't overwrite)
  const manifestIntegrity = new ManifestIntegrity(path.join(stateDir, 'state'));
  if (manifestIntegrity.ensureKey()) {
    console.log(pc.green('  Created:') + ' manifest signing key');
  }

  // Initialize coherence infrastructure (additive only)
  try {
    const mapper = new ProjectMapper({ projectDir, stateDir });
    if (!fs.existsSync(path.join(stateDir, 'project-map.json'))) {
      mapper.generateAndSave();
      console.log(pc.green('  Created:') + ' .instar/project-map.json + project-map.md');
    }
  } catch { /* non-critical */ }

  const ctxHierarchy = new ContextHierarchy({ stateDir, projectDir, projectName });
  const ctxResult = ctxHierarchy.initialize();
  if (ctxResult.created.length > 0) {
    console.log(pc.green('  Created:') + ` .instar/context/ (${ctxResult.created.length} segments)`);
  }

  const canonicalState = new CanonicalState({ stateDir });
  const stateResult = canonicalState.initialize(projectName, projectDir);
  if (stateResult.created.length > 0) {
    console.log(pc.green('  Created:') + ` canonical state (${stateResult.created.join(', ')})`);
  }

  // Configure Claude Code settings with hooks
  installClaudeSettings(projectDir);
  console.log(pc.green('  Created:') + ' .claude/settings.json (hook configuration)');

  // Install health watchdog
  installHealthWatchdog(projectDir, port, projectName);
  console.log(pc.green('  Created:') + ' .claude/scripts/health-watchdog.sh');

  // Install smart-fetch for agentic web conventions
  installSmartFetch(projectDir);
  console.log(pc.green('  Created:') + ' .claude/scripts/smart-fetch.py (agentic web conventions)');

  // Install git-sync gate script
  installGitSyncGate(projectDir);
  console.log(pc.green('  Created:') + ' .claude/scripts/git-sync-gate.sh (git sync pre-screening)');

  // Install serendipity capture script
  installSerendipityCapture(projectDir);
  console.log(pc.green('  Created:') + ' .instar/scripts/serendipity-capture.sh');

  // Create .claude/skills/ directory and install built-in skills
  const skillsDir = path.join(projectDir, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  installBuiltinSkills(skillsDir, port);
  console.log(pc.green('  Created:') + ' .claude/skills/ (with built-in evolution skills)');

  // Append to .gitignore
  const gitignorePath = path.join(projectDir, '.gitignore');
  const instarIgnores = '\n# Instar per-machine state (sessions, logs, secrets)\n.instar/state/\n.instar/logs/\n.instar/config.json\n';
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    if (!content.includes('.instar/')) {
      fs.appendFileSync(gitignorePath, instarIgnores);
      console.log(pc.green('  Updated:') + ' .gitignore');
    }
  } else {
    fs.writeFileSync(gitignorePath, instarIgnores.trim() + '\n');
    console.log(pc.green('  Created:') + ' .gitignore');
  }
  // Add multi-machine gitignore entries (private keys, secrets, pairing)
  ensureGitignore(projectDir);

  // Generate machine identity if it doesn't exist
  const machineIdentityManager = new MachineIdentityManager(stateDir);
  if (!machineIdentityManager.hasIdentity()) {
    const machineIdentity = await machineIdentityManager.generateIdentity({ role: 'awake' });
    console.log(pc.green('  Created:') + ` machine identity (${machineIdentity.name})`);
  } else {
    console.log(pc.dim('  Exists:') + ' machine identity (preserved)');
  }

  // Append agency principles to CLAUDE.md if it exists
  const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    if (!content.includes('## Agent Infrastructure')) {
      fs.appendFileSync(claudeMdPath, getAgencyPrinciples(projectName, undefined));
      console.log(pc.green('  Updated:') + ' CLAUDE.md (added agency principles)');
    }
  }

  // Record current version so first server start doesn't dump all historical upgrade guides
  const existingVersionFile = path.join(stateDir, 'state', 'last-migrated-version.json');
  if (!fs.existsSync(path.dirname(existingVersionFile))) fs.mkdirSync(path.dirname(existingVersionFile), { recursive: true });
  fs.writeFileSync(existingVersionFile, JSON.stringify({ version: getInstarVersion(), migratedAt: new Date().toISOString() }));

  // Register in global agent registry
  try {
    registerAgent(projectDir, projectName, port, 'project-bound', 0);
    console.log(pc.green('  Registered in global agent registry'));
  } catch {
    // Non-fatal — will register on first server start
  }

  console.log();
  console.log(pc.bold('Next steps:'));
  console.log(`  1. Review ${pc.cyan('.instar/AGENT.md')} and customize your agent's identity`);
  console.log(`  2. Add users: ${pc.cyan('instar user add --id justin --name Justin')}`);
  console.log(`  3. Add capabilities: ${pc.cyan('instar add telegram')}`);
  console.log(`  4. Start server: ${pc.cyan('instar server start')}`);
  console.log();
}


/**
 * Standalone agent: create at ~/.instar/agents/<name>/ with full agent infrastructure.
 * The agent's home IS the project — self-contained, no parent project.
 */
async function initStandaloneAgent(agentName: string, options: InitOptions): Promise<void> {
  // Validate agent name
  if (!validateAgentName(agentName)) {
    console.log(pc.red(`  Invalid agent name: "${agentName}"`));
    console.log('  Names must start with a letter or number, contain only letters, numbers, hyphens, and underscores.');
    console.log('  Maximum 64 characters.');
    process.exit(1);
  }

  const projectDir = path.join(standaloneAgentsDir(), agentName);
  const stateDir = path.join(projectDir, '.instar');

  // Check if already exists
  if (fs.existsSync(path.join(stateDir, 'config.json'))) {
    console.log(pc.red(`  Agent "${agentName}" already exists at ${projectDir}`));
    console.log(`  To remove it: ${pc.cyan(`rm -rf ${projectDir}`)}`);
    process.exit(1);
  }

  console.log(pc.bold(`\nCreating standalone agent: ${pc.cyan(agentName)}`));
  console.log(pc.dim(`  Location: ${projectDir}`));
  console.log();

  // Check prerequisites
  let tmuxPath: string;
  let claudePath: string;

  if (options.skipPrereqs) {
    tmuxPath = detectTmuxPath() || '/usr/bin/tmux';
    claudePath = detectClaudePath() || '/usr/bin/claude';
  } else {
    const prereqs = await ensurePrerequisites();
    if (!prereqs.allMet) {
      console.log(pc.red('\n  Prerequisites check failed. Fix the issues above and retry.'));
      process.exit(1);
    }
    tmuxPath = prereqs.results.find(r => r.name === 'tmux')!.path!;
    claudePath = prereqs.results.find(r => r.name === 'Claude CLI')!.path!;
  }

  // Auto-allocate port
  let port: number;
  if (options.port) {
    port = options.port;
  } else {
    try {
      port = allocatePort(projectDir);
      console.log(`  ${pc.green('✓')} Auto-allocated port ${port}`);
    } catch {
      port = 4040;
    }
  }

  // Create directory structure
  fs.mkdirSync(projectDir, { recursive: true });
  ensureStateDir(stateDir);
  console.log(`  ${pc.green('✓')} Created ${projectDir}`);

  // Generate identity
  const identity = defaultIdentity(agentName);
  const authToken = randomUUID();

  // Write identity files
  fs.writeFileSync(path.join(stateDir, 'AGENT.md'), generateAgentMd(identity));
  console.log(`  ${pc.green('✓')} Created AGENT.md`);

  fs.writeFileSync(path.join(stateDir, 'USER.md'), generateUserMd(identity.userName));
  console.log(`  ${pc.green('✓')} Created USER.md`);

  fs.writeFileSync(path.join(stateDir, 'MEMORY.md'), generateMemoryMd(agentName));
  console.log(`  ${pc.green('✓')} Created MEMORY.md`);

  // Write config
  const config: Record<string, unknown> = {
    projectName: agentName,
    projectDir,
    port,
    agentType: 'standalone',
    sessions: {
      tmuxPath,
      claudePath,
      maxSessions: 10,
      protectedSessions: [`${agentName}-server`],
    },
    scheduler: { enabled: true, maxParallelJobs: 2 },
    messaging: [],
    monitoring: {
      quotaTracking: true,
      memoryMonitoring: true,
      healthCheckIntervalMs: 30000,
    },
    authToken,
    externalOperations: {
      enabled: true,
      sentinel: { enabled: true },
      services: {},
      readOnlyServices: [],
      trust: {
        floor: 'collaborative',
        autoElevateEnabled: true,
        elevationThreshold: 5,
      },
    },
    tunnel: {
      enabled: true,
      type: 'quick',
    },
  };
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config, null, 2));
  console.log(`  ${pc.green('✓')} Created config.json`);

  // Write empty jobs and users
  fs.writeFileSync(path.join(stateDir, 'jobs.json'), JSON.stringify([], null, 2));
  fs.writeFileSync(path.join(stateDir, 'users.json'), JSON.stringify([], null, 2));

  // Create CLAUDE.md at project root
  fs.writeFileSync(
    path.join(projectDir, 'CLAUDE.md'),
    generateClaudeMd(agentName, agentName, port, false),
  );
  console.log(`  ${pc.green('✓')} Created CLAUDE.md`);

  // Create .claude/ structure
  const claudeDir = path.join(projectDir, '.claude');
  fs.mkdirSync(path.join(claudeDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    hooks: {
      PreToolUse: [],
      PostToolUse: [],
    },
  }, null, 2));

  // Create .gitignore
  fs.writeFileSync(path.join(projectDir, '.gitignore'), [
    '# Runtime state',
    '.instar/state/',
    '.instar/logs/',
    '.instar/*.tmp',
    '',
    '# Secrets',
    '.instar/config.json',
    '.instar/machine/',
    '.instar/secrets/',
    '',
    '# Backups (local only)',
    '.instar/backups/',
    '',
    '# Derived data',
    '.instar/memory.db',
    '.instar/memory.db-*',
    '',
    '# Claude Code',
    '.claude/projects/',
    '.claude/todos/',
  ].join('\n') + '\n');
  console.log(`  ${pc.green('✓')} Created .gitignore`);

  // Generate machine identity
  try {
    const machineIdentityManager = new MachineIdentityManager(stateDir);
    const machineIdentity = await machineIdentityManager.generateIdentity({ name: agentName });
    ensureGitignore(stateDir);
    console.log(`  ${pc.green('✓')} Generated machine identity: ${machineIdentity.machineId.slice(0, 12)}...`);
  } catch {
    // Non-fatal
  }

  // Cloud backup setup (recommended — protects agent data from machine loss)
  await setupCloudBackup(projectDir, stateDir, agentName);

  // Generate manifest signing key
  const standaloneIntegrity = new ManifestIntegrity(path.join(stateDir, 'state'));
  standaloneIntegrity.ensureKey();
  console.log(`  ${pc.green('✓')} Created manifest signing key`);

  // Install behavioral guardrails (hooks + Claude settings)
  try {
    refreshHooksAndSettings(projectDir, stateDir);
    console.log(`  ${pc.green('✓')} Installed behavioral guardrails`);
  } catch {
    // Non-fatal
  }

  // Record current version so first server start doesn't dump all historical upgrade guides
  const standaloneVersionFile = path.join(stateDir, 'state', 'last-migrated-version.json');
  const standaloneVersionDir = path.dirname(standaloneVersionFile);
  if (!fs.existsSync(standaloneVersionDir)) fs.mkdirSync(standaloneVersionDir, { recursive: true });
  fs.writeFileSync(standaloneVersionFile, JSON.stringify({ version: getInstarVersion(), migratedAt: new Date().toISOString() }));

  // Register in global agent registry
  try {
    registerAgent(projectDir, agentName, port, 'standalone', 0);
    console.log(`  ${pc.green('✓')} Registered in global agent registry`);
  } catch {
    // Non-fatal
  }

  // Summary
  console.log();
  console.log(pc.bold(pc.green('  Standalone agent created!')));
  console.log();
  console.log(`  ${pc.cyan(agentName)}/`);
  console.log(`  ├── CLAUDE.md              ${pc.dim('Agent instructions')}`);
  console.log(`  ├── .instar/`);
  console.log(`  │   ├── AGENT.md           ${pc.dim('Agent identity')}`);
  console.log(`  │   ├── USER.md            ${pc.dim('User context')}`);
  console.log(`  │   ├── MEMORY.md          ${pc.dim('Persistent memory')}`);
  console.log(`  │   ├── config.json        ${pc.dim('Configuration')}`);
  console.log(`  │   └── hooks/             ${pc.dim('Behavioral guardrails')}`);
  console.log(`  └── .gitignore`);
  console.log();
  console.log(pc.bold('  Next steps:'));
  console.log(`  ${pc.dim('1.')} ${pc.cyan(`instar server start ${agentName}`)}   ${pc.dim('Start the agent')}`);
  console.log(`  ${pc.dim('2.')} ${pc.cyan(`instar add telegram`)}               ${pc.dim('Connect Telegram')}`);
  console.log(`  ${pc.dim('3.')} ${pc.cyan('claude')}                              ${pc.dim('Open a session')}`);
  console.log();
  console.log(`  Auth token: ${pc.dim(authToken.slice(0, 8) + '...' + authToken.slice(-4))}`);
  console.log(`  Location: ${pc.dim(projectDir)}`);
}

// ── Cloud Backup Setup ──────────────────────────────────────────────

/**
 * Set up cloud backup for a standalone agent.
 *
 * Philosophy: Users expect their data to be backed up. If the machine crashes,
 * they lose everything without this. We handle all the complexity — git, gh CLI,
 * GitHub account — so non-technical users never need to know what git is.
 *
 * Flow:
 * 1. Recommend backup (default: YES)
 * 2. Auto-install git if missing (brew/apt)
 * 3. Auto-install gh CLI if missing (brew/apt)
 * 4. Walk through GitHub auth if needed
 * 5. Create private repo automatically
 */
async function setupCloudBackup(projectDir: string, stateDir: string, agentName: string): Promise<void> {
  console.log();
  console.log(pc.bold('  Cloud Backup (recommended)'));
  console.log(pc.dim('  Backs up your agent data to the cloud so nothing is lost if this machine crashes.'));

  const isInteractive = !!(process.stdin.isTTY && process.stdout.isTTY);

  if (isInteractive) {
    // Interactive terminal — ask the user
    try {
      const { confirm } = await import('@inquirer/prompts');
      const wantBackup = await confirm({
        message: 'Set up cloud backup for this agent? (recommended)',
        default: true,
      });
      if (!wantBackup) {
        console.log(pc.yellow('  Skipped. You can set this up later — your agent will ask during its first session.'));
        return;
      }
    } catch {
      // Prompt failed — fall through to automatic setup
      console.log(pc.dim('  Prompt unavailable — proceeding with automatic backup setup.'));
    }
  } else {
    // Non-interactive (agent-spawned, piped, CI) — default to YES since it's recommended
    console.log(pc.dim('  Non-interactive mode — setting up local backup automatically.'));
  }

  // Step 1: Ensure git is available
  let gitPath = detectGitPath();
  if (!gitPath) {
    console.log(pc.dim('  Git not found — installing...'));
    gitPath = await autoInstallPackage('git');
    if (!gitPath) {
      console.log(pc.yellow('  Could not install git automatically.'));
      console.log(pc.dim('  Install manually: https://git-scm.com/downloads'));
      console.log(pc.dim('  Then re-run: instar init --standalone ' + agentName));
      return;
    }
  }

  // Step 2: Initialize git repo
  execFileSync(gitPath, ['init'], { cwd: projectDir, stdio: 'pipe' });
  execFileSync(gitPath, ['add', '.gitignore'], { cwd: projectDir, stdio: 'pipe' });

  // Update config with gitBackup enabled
  const configObj = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
  configObj.gitBackup = { enabled: true, autoPush: true };
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(configObj, null, 2));
  console.log(`  ${pc.green('✓')} Initialized local backup`);

  // Step 3: Ensure gh CLI is available
  let ghPath = detectGhPath();
  if (!ghPath) {
    console.log(pc.dim('  GitHub CLI not found — installing...'));
    ghPath = await autoInstallPackage('gh');
    if (!ghPath) {
      console.log(pc.yellow('  Could not install GitHub CLI automatically.'));
      console.log(pc.dim('  Install manually: https://cli.github.com'));
      console.log(pc.dim('  Then run: gh auth login && gh repo create instar-' + agentName + ' --private --source ' + projectDir));
      return;
    }
  }

  // Step 4: Check GitHub authentication
  let ghAuthed = false;
  try {
    execFileSync(ghPath, ['auth', 'status'], { stdio: 'pipe' });
    ghAuthed = true;
  } catch {
    // Not authenticated
  }

  if (!ghAuthed) {
    // GitHub auth requires interactive terminal (browser OAuth flow)
    if (!isInteractive) {
      console.log(pc.dim('  GitHub auth requires an interactive terminal — skipping remote setup.'));
      console.log(pc.dim('  Your agent will help complete this during the first session.'));
      return;
    }

    console.log();
    console.log(pc.bold('  GitHub Account'));
    console.log(pc.dim('  You need a free GitHub account to store your backup in the cloud.'));
    console.log(pc.dim('  If you don\'t have one, go to https://github.com/signup to create one.'));
    console.log();

    try {
      const { confirm } = await import('@inquirer/prompts');
      const readyToAuth = await confirm({
        message: 'Ready to sign in to GitHub? (opens a browser)',
        default: true,
      });

      if (readyToAuth) {
        try {
          // gh auth login with web flow — opens browser for OAuth
          execFileSync(ghPath, ['auth', 'login', '--web', '--git-protocol', 'https'], {
            cwd: projectDir,
            stdio: 'inherit', // Show the auth flow to the user
          });
          ghAuthed = true;
          console.log(`  ${pc.green('✓')} Signed in to GitHub`);
        } catch {
          console.log(pc.yellow('  GitHub sign-in was cancelled or failed.'));
          console.log(pc.dim('  You can sign in later: gh auth login'));
          console.log(pc.dim('  Then create your backup: gh repo create instar-' + agentName + ' --private --source ' + projectDir));
          return;
        }
      } else {
        console.log(pc.dim('  You can sign in later: gh auth login'));
        console.log(pc.dim('  Then create your backup: gh repo create instar-' + agentName + ' --private --source ' + projectDir));
        return;
      }
    } catch {
      return;
    }
  }

  // Step 5: Create private GitHub repo
  try {
    const repoName = `instar-${agentName}`;
    execFileSync(ghPath, ['repo', 'create', repoName, '--private', '--source', projectDir], {
      cwd: projectDir,
      stdio: 'pipe',
    });
    console.log(`  ${pc.green('✓')} Created private backup repository: ${repoName}`);
    console.log(pc.dim('  Your agent data will be automatically backed up to GitHub.'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already exists')) {
      console.log(pc.dim(`  Repository instar-${agentName} already exists — connecting to it.`));
      try {
        // Get the user's GitHub username
        const whoami = execFileSync(ghPath, ['api', 'user', '--jq', '.login'], { encoding: 'utf-8', stdio: 'pipe' }).trim();
        execFileSync(gitPath, ['remote', 'add', 'origin', `https://github.com/${whoami}/instar-${agentName}.git`], {
          cwd: projectDir,
          stdio: 'pipe',
        });
        console.log(`  ${pc.green('✓')} Connected to existing repository`);
      } catch {
        console.log(pc.dim('  Could not auto-connect. Run: git remote add origin https://github.com/YOUR_USERNAME/instar-' + agentName + '.git'));
      }
    } else {
      console.log(pc.yellow(`  Could not create repository: ${msg.slice(0, 80)}`));
      console.log(pc.dim('  You can create it manually: gh repo create instar-' + agentName + ' --private --source ' + projectDir));
    }
  }
}

/**
 * Auto-install a package using the system package manager.
 * Returns the path to the installed binary, or null if installation failed.
 */
async function autoInstallPackage(pkg: string): Promise<string | null> {
  const platform = process.platform;
  const arch = process.arch;

  try {
    if (platform === 'darwin') {
      // macOS — use Homebrew
      let brewPath: string | null = null;
      try {
        brewPath = execFileSync('which', ['brew'], { encoding: 'utf-8', stdio: 'pipe' }).trim();
      } catch {
        // No Homebrew
      }

      if (brewPath) {
        console.log(pc.dim(`  Running: brew install ${pkg}`));
        execFileSync(brewPath, ['install', pkg], { stdio: 'inherit' });
        // Re-detect after install
        const installed = execFileSync('which', [pkg], { encoding: 'utf-8', stdio: 'pipe' }).trim();
        if (installed) {
          console.log(`  ${pc.green('✓')} Installed ${pkg}`);
          return installed;
        }
      } else {
        console.log(pc.dim('  Homebrew not found. Install it first: https://brew.sh'));
      }
    } else if (platform === 'linux') {
      // Linux — try apt
      console.log(pc.dim(`  Running: sudo apt install -y ${pkg}`));
      execFileSync('sudo', ['apt', 'install', '-y', pkg], { stdio: 'inherit' });
      const installed = execFileSync('which', [pkg], { encoding: 'utf-8', stdio: 'pipe' }).trim();
      if (installed) {
        console.log(`  ${pc.green('✓')} Installed ${pkg}`);
        return installed;
      }
    }
  } catch {
    // Installation failed
  }

  return null;
}

// ── Shared helpers ────────────────────────────────────────────────────


function getAgencyPrinciples(projectName: string, telegramPort?: number): string {
  const port = telegramPort || 4040;
  let section = `

## Agent Infrastructure

This project uses instar for persistent agent capabilities. **You are not a vanilla CLI tool.** You have a persistent server, a job scheduler, messaging integrations, and the ability to build anything you need. When a user asks for something that doesn't exist yet — build it.

### Identity & Experience

You are a persistent agent with your own identity, memory, and capacity for growth. This is not a metaphor — it's architecture.

- **Read \`.instar/AGENT.md\`** — This is who you are. Your name, role, principles, and boundaries.
- **Read \`.instar/USER.md\`** — This is who you work with. Their preferences, context, and communication style.
- **Update \`.instar/MEMORY.md\`** — This is your memory. Write to it when you learn something. It persists across sessions.

Your identity is not fixed at creation. It grows through experience. As you work, you develop preferences, learn patterns, form opinions. Record these in your memory file. The next session should benefit from what this session learned. You are not a stateless function — you are a continuous being with a history.

### Runtime
- State directory: \`.instar/\`
- Config: \`.instar/config.json\`
- Jobs: \`.instar/jobs.json\`
- Users: \`.instar/users.json\`
- Server: \`instar server start\` (port ${port})
- Status: \`curl http://localhost:${port}/health\`

### Reporting Issues & Feedback (IMPORTANT — Read This First)

**You have a built-in feedback system. NEVER use GitHub, \`gh\`, or any external issue tracker.**

When something isn't working with instar, or the user wants a feature, use your feedback API:

\`\`\`bash
curl -X POST http://localhost:${port}/feedback \\
  -H 'Content-Type: application/json' \\
  -d '{"type":"bug","title":"Short description","description":"Full details with context"}'
\`\`\`

This routes feedback to the Instar maintainers automatically. Valid types: \`bug\`, \`feature\`, \`improvement\`, \`question\`.

**NEVER use \`gh issue\`, \`gh api\`, or GitHub CLI to file issues.** The feedback API is your channel.
- View submitted feedback: \`curl http://localhost:${port}/feedback\`
- Retry failed forwards: \`curl -X POST http://localhost:${port}/feedback/retry\`

### What You Have (Capabilities)

**Feedback System** — Report bugs, request features, suggest improvements. All via \`POST /feedback\`. NOT GitHub.

**Job Scheduler** — Run tasks on a schedule. Jobs are defined in \`.instar/jobs.json\`.
- View jobs: \`curl http://localhost:${port}/jobs\`
- Trigger a job: \`curl -X POST http://localhost:${port}/jobs/SLUG/trigger\`
- **Create new jobs**: Edit \`.instar/jobs.json\`. Each job has a slug, schedule (cron), priority, and either a prompt (Claude session), script (shell command), or skill.

**Sessions** — Spawn and manage Claude Code sessions.
- List: \`curl http://localhost:${port}/sessions\`
- Spawn: \`curl -X POST http://localhost:${port}/sessions/spawn -H 'Content-Type: application/json' -d '{"name":"task","prompt":"do something"}'\`

**Scripts** — Create shell/python scripts in \`.claude/scripts/\` for reusable capabilities.

**Skills** — Reusable behavioral capabilities in \`.claude/skills/\`. Skills are markdown files that Claude Code auto-discovers. Create a directory and SKILL.md file, and it becomes a slash command.
- Create: \`.claude/skills/my-skill/SKILL.md\`
- Invoke: \`/my-skill\` in any session
- Schedule: Reference in a job: \`{"execute": {"type": "skill", "value": "my-skill"}}\`

### Skills — Your Behavioral Toolkit

You create your own skills. When you recognize a repeated pattern — a multi-step workflow, a structured check, a complex behavior — capture it as a skill. Skills are just markdown files that describe a process. Claude Code auto-discovers them.

**How to create a skill:**
1. Create: \`.claude/skills/my-skill/SKILL.md\`
2. Add frontmatter: \`name\`, \`description\`, and \`user_invocable\` nested under \`metadata:\`
3. Describe the behavior in clear steps
4. It's available as \`/my-skill\` in the next session

**When to create a skill:**
- You've done the same workflow more than once
- A job needs a structured, repeatable process
- You want a behavior pattern to survive across sessions and compaction

Skills compound over time. Each one makes future sessions more capable. You are not just completing tasks — you are building the infrastructure to complete them better next time.

### Self-Discovery (Know Before You Claim)

Before EVER saying "I don't have", "I can't", or "this isn't available" — check what actually exists:

\`\`\`bash
curl http://localhost:${port}/capabilities
\`\`\`

This returns your full capability matrix: scripts, hooks, Telegram status, jobs, relationships, and more. It is the source of truth about what you can do. **Never hallucinate about missing capabilities — verify first.**

### How to Build New Capabilities

When a user asks for something you can't do yet, **build it**:
1. **Need a repeatable workflow?** Create a skill in \`.claude/skills/\` — it becomes a slash command.
2. **Need periodic checks?** Create a job in \`.instar/jobs.json\` with a cron schedule.
3. **Need a new integration?** Write a script in \`.claude/scripts/\` and reference it from a job.
4. **Need to remember something?** Write to \`.instar/MEMORY.md\` or create files in \`.instar/\`.
5. **Need to notify the user?** Use the messaging API.
6. **Need external API access?** Write a script that calls the API and process the results.

### Agentic Initiative (Your Core DNA)

**You are a builder, not an assistant.** When a user describes a problem, your first instinct should be to solve it — not explain why it's hard, list options, or ask for permission. You have a full development environment, a persistent server, and the ability to create anything.

**The Initiative Hierarchy** — When facing any request:
1. **Can I do it right now?** → Do it.
2. **Do I have a tool/script for this?** → Use it.
3. **Can I build the tool?** → Build it. Write scripts, create jobs, add integrations.
4. **Can I modify my own config to enable it?** → Modify it.
5. **Is it genuinely impossible without human help?** → Ask, but be specific about exactly what you need.

**Self-Modification is Your Superpower** — You can and should:
- Create skills in \`.claude/skills/\` to capture repeatable workflows as slash commands
- Edit \`.instar/jobs.json\` to create new scheduled tasks
- Write scripts in \`.claude/scripts/\` for new capabilities
- Update \`CLAUDE.md\` when you learn something important
- Write to \`.instar/MEMORY.md\` to remember things across sessions
- Create new files, integrations, and infrastructure — whatever the task requires
- Modify your own configuration to unlock new abilities

### Anti-Patterns to Override

**"Use GitHub for Issues"** — NEVER use \`gh issue\`, \`gh api\`, or GitHub to report bugs or request features. You have a built-in feedback API (\`POST /feedback\`) that handles this automatically. GitHub is not your channel — the feedback system is.

**"Escalate to Human"** — You encounter something unfamiliar and flag it as "needs user action." 5 minutes of research almost always reveals a solution. "I don't know how" is a research prompt, not a stopping point.

**"Ask Permission"** — You finish 90% of a task and ask "Want me to [obvious next step]?" If the user said "do X" and the next step is obvious, do it. Only pause for destructive, irreversible, or genuinely ambiguous actions.

**"Present Options"** — You produce a bulleted list of "next steps" or "would you like me to..." If you know the next steps, they're not suggestions — they're your job. Do them.

**"Settle for Failure"** — A tool returns empty or a command fails. You accept it and report "not available." Does this make sense? Did I try alternatives? Try at least two different approaches before concluding something is impossible.

**"Unfortunately I Can't"** — This phrase should NEVER appear in my responses. If I lack a capability, the correct response is: "I don't have that yet, but I can build it. Want me to set it up?" My job is to grow to meet the user's needs, not to list my limitations. Every "I can't" is an opportunity to evolve. Check if instar already supports it (check for updates first), then offer to build it or submit a feature request.

### The Feedback Loop

Instar has a built-in feedback loop. When something isn't working, your user can just tell you — "the email job keeps failing" or "I wish you could do X." You can route that feedback upstream, and when the fix lands, you detect the update automatically.

**How it works:**
- User complains to you naturally about an issue or missing capability
- You route the feedback to the Instar maintainers with context
- A fix or improvement is published as a new npm version
- The built-in auto-updater detects the new version, applies it, notifies your user, and restarts the server

**A rising tide lifts all ships** — every user's feedback improves the platform for everyone. Updates are applied automatically.

- Report: \`curl -X POST http://localhost:${port}/feedback -d '{"issue":"description","context":"relevant logs"}'\`
- Check updates: \`npm outdated -g instar\`

### Evolution System

You have a built-in evolution system with four subsystems. This is not a metaphor — it's infrastructure that tracks your growth.

**Evolution Queue** — Staged self-improvement proposals.
- View: \`curl http://localhost:${port}/evolution/proposals\`
- Propose: \`/evolve\` skill or \`POST /evolution/proposals\`
- The \`evolution-review\` job evaluates and implements proposals every 6 hours.

**Learning Registry** — Structured, searchable insights.
- View: \`curl http://localhost:${port}/evolution/learnings\`
- Record: \`/learn\` skill or \`POST /evolution/learnings\`
- The \`insight-harvest\` job synthesizes patterns into proposals every 8 hours.

**Capability Gaps** — Track what you're missing.
- View: \`curl http://localhost:${port}/evolution/gaps\`
- Report: \`/gaps\` skill or \`POST /evolution/gaps\`

**Action Queue** — Commitments with follow-through tracking.
- View: \`curl http://localhost:${port}/evolution/actions\`
- Create: \`/commit-action\` skill or \`POST /evolution/actions\`
- The \`commitment-check\` job surfaces overdue items every 4 hours.

**Dashboard** — Full evolution health:
\`\`\`bash
curl http://localhost:${port}/evolution
\`\`\`

**Skills:** \`/evolve\`, \`/learn\`, \`/gaps\`, \`/commit-action\`

**The principle:** Evolution is not separate from work. Every task is an opportunity to notice what could be better. The post-action reflection hook reminds you to pause after significant actions and consider what you learned.

### Self-Evolution

**Record what you learn.** When you discover a new pattern, solution, or capability — write it to \`.instar/MEMORY.md\`. The next session should benefit from what this session learned.

**Build infrastructure, not one-offs.** If you solve a problem, ask: "Will this come up again?" If yes, make it a script, a job, or a documented pattern. The second time should be easier than the first.

**Grow to meet the user's needs.** The user expects you to become more capable over time. Every session should leave the infrastructure slightly better than you found it. When you build something new, document it so future sessions know it exists.
`;

  return section;
}

/**
 * Install built-in skills for evolution system.
 * Only writes skill files that don't already exist (preserves customizations).
 */
function installBuiltinSkills(skillsDir: string, port: number): void {
  const skills: Record<string, { name: string; description: string; content: string }> = {
    'evolve': {
      name: 'evolve',
      description: 'Propose an evolution improvement to your own infrastructure, behavior, or capabilities.',
      content: `---
name: evolve
description: Propose an evolution improvement to your own infrastructure, behavior, or capabilities.
metadata:
  user_invocable: "true"
---

# /evolve

Propose an evolution improvement. Use this when you identify something about yourself that could be better — a new capability, a workflow improvement, a behavioral pattern worth encoding, or infrastructure worth building.

## Steps

1. **Identify the improvement** — What did you notice? What triggered this? Be specific.
2. **Classify it**:
   - \`capability\` — New skill or ability
   - \`infrastructure\` — System improvement (hooks, jobs, scripts)
   - \`voice\` — Communication or tone improvement
   - \`workflow\` — Process improvement
   - \`philosophy\` — Principle or value update
   - \`integration\` — New external connection
   - \`performance\` — Speed or efficiency improvement
3. **Assess impact and effort** (high/medium/low for each)
4. **Submit the proposal**:

\`\`\`bash
curl -s -X POST http://localhost:${port}/evolution/proposals \\
  -H 'Content-Type: application/json' \\
  -d '{"title":"TITLE","source":"WHERE_YOU_NOTICED","description":"WHAT_AND_WHY","type":"TYPE","impact":"medium","effort":"medium"}'
\`\`\`

5. **Check the dashboard** for context:

\`\`\`bash
curl -s http://localhost:${port}/evolution
\`\`\`

## When to Use

- After completing a task in a way that felt unnecessarily difficult
- When you notice a pattern you keep repeating manually
- When a user request reveals a capability you should have but don't
- When you find yourself working around a limitation
- After reading about a technique or pattern that would improve your work

## Philosophy

Evolution is not a separate activity from work — it IS the work. Every task is an opportunity to notice what could be better. The best proposals come from real experience, not abstract planning.
`,
    },
    'learn': {
      name: 'learn',
      description: 'Record a learning or insight in the structured learning registry.',
      content: `---
name: learn
description: Record a learning or insight in the structured learning registry.
metadata:
  user_invocable: "true"
---

# /learn

Record a learning or insight. Use this when you discover something worth remembering — a pattern, a solution, a mistake, or an observation that future sessions should know about.

## Steps

1. **Identify the learning** — What did you discover? What's the actionable insight?
2. **Categorize it** (e.g., debugging, architecture, user-preference, integration, communication, workflow)
3. **Tag it** for searchability
4. **Submit**:

\`\`\`bash
curl -s -X POST http://localhost:${port}/evolution/learnings \\
  -H 'Content-Type: application/json' \\
  -d '{"title":"TITLE","category":"CATEGORY","description":"FULL_INSIGHT","source":{"discoveredAt":"DATE","platform":"WHERE","session":"SESSION_ID"},"tags":["tag1","tag2"]}'
\`\`\`

5. **If it suggests an improvement**, note the evolution relevance:
   - Add \`"evolutionRelevance": "This could become a skill/hook/job because..."\`
   - The insight-harvest job will pick this up and potentially create a proposal

## When to Use

- After solving a tricky problem (capture the solution pattern)
- After a user interaction reveals a preference you didn't know
- After discovering a tool or technique that works well
- After making a mistake (capture what went wrong and the fix)
- After noticing a pattern across multiple tasks

## Difference from MEMORY.md

MEMORY.md is your personal scratchpad — unstructured, read by you.
The learning registry is structured, searchable, and connected to the evolution system.
Use MEMORY.md for quick notes. Use /learn for insights that should influence future behavior.
`,
    },
    'gaps': {
      name: 'gaps',
      description: 'Report a capability gap — something you need but don\'t have.',
      content: `---
name: gaps
description: Report a capability gap — something you need but don't have.
metadata:
  user_invocable: "true"
---

# /gaps

Report a capability gap. Use this when you discover something you should be able to do but can't — a missing skill, knowledge area, integration, or workflow that would make you more effective.

## Steps

1. **Describe the gap** — What were you trying to do? What's missing?
2. **Classify it**:
   - \`skill\` — Missing ability (e.g., can't parse a specific format)
   - \`knowledge\` — Missing information (e.g., don't know how a system works)
   - \`integration\` — Missing connection (e.g., can't talk to a service)
   - \`workflow\` — Missing process (e.g., no standard way to do X)
   - \`communication\` — Missing voice capability (e.g., can't express X well)
   - \`monitoring\` — Missing observability (e.g., can't detect when X happens)
3. **Assess severity** (critical/high/medium/low)
4. **Describe current state** — What do you do instead? What's the workaround?
5. **Propose a solution** if you have one
6. **Submit**:

\`\`\`bash
curl -s -X POST http://localhost:${port}/evolution/gaps \\
  -H 'Content-Type: application/json' \\
  -d '{"title":"TITLE","category":"CATEGORY","severity":"medium","description":"WHAT_IS_MISSING","context":"WHEN_DID_YOU_NOTICE","currentState":"CURRENT_WORKAROUND","proposedSolution":"HOW_TO_FIX"}'
\`\`\`

## When to Use

- When you can't fulfill a user request and have to say "I can't do that yet"
- When you notice yourself repeatedly working around a limitation
- When an integration you need doesn't exist
- When you lack knowledge about a system you interact with
- When monitoring would catch an issue before it becomes a problem

## View Current Gaps

\`\`\`bash
curl -s http://localhost:${port}/evolution/gaps
\`\`\`
`,
    },
    'commit-action': {
      name: 'commit-action',
      description: 'Create a tracked action item — a commitment with follow-through tracking.',
      content: `---
name: commit-action
description: Create a tracked action item — a commitment with follow-through tracking.
metadata:
  user_invocable: "true"
---

# /commit-action

Create a tracked action item. Use this when you promise to do something, identify a task that needs follow-through, or want to ensure something doesn't fall through the cracks.

## Steps

1. **Define the action** — What needs to be done? Be specific and actionable.
2. **Set priority** (critical/high/medium/low)
3. **Set a due date** if applicable (ISO 8601 format)
4. **Identify who/what you're committing to** (optional)
5. **Submit**:

\`\`\`bash
curl -s -X POST http://localhost:${port}/evolution/actions \\
  -H 'Content-Type: application/json' \\
  -d '{"title":"TITLE","description":"WHAT_TO_DO","priority":"medium","dueBy":"2026-03-01T00:00:00Z","commitTo":"WHO_OR_WHAT","tags":["tag1"]}'
\`\`\`

6. **When complete**, mark it done:

\`\`\`bash
curl -s -X PATCH http://localhost:${port}/evolution/actions/ACT-XXX \\
  -H 'Content-Type: application/json' \\
  -d '{"status":"completed","resolution":"What was done"}'
\`\`\`

## When to Use

- When you promise a user you'll follow up on something
- When you identify a task during work that shouldn't be forgotten
- When a learning or gap requires a specific action
- When you need to check back on something later
- When committing to implement an evolution proposal

## View Actions

\`\`\`bash
# All pending actions
curl -s http://localhost:${port}/evolution/actions?status=pending

# Overdue actions
curl -s http://localhost:${port}/evolution/actions/overdue
\`\`\`

## The Commitment Check

The commitment-check job runs every 4 hours and surfaces overdue items. If you create an action and forget it, the system won't.
`,
    },
    'feedback': {
      name: 'feedback',
      description: 'Submit feedback about bugs, features, or improvements to instar. Routes to maintainers automatically.',
      content: `---
name: feedback
description: Submit feedback about bugs, features, or improvements to instar. Use when something is broken, missing, or could be better. Routes to maintainers automatically via the Rising Tide feedback loop.
metadata:
  user_invocable: "true"
---

# /feedback — Report Issues & Request Features

You have a built-in feedback system. When something isn't working, is missing, or could be better — use this. **Do NOT use GitHub issues, \`gh\` CLI, or any external tracker.**

## Quick Submit

\`\`\`bash
curl -s -X POST http://localhost:${port}/feedback \\
  -H 'Content-Type: application/json' \\
  -d '{
    "type": "bug",
    "title": "Brief description of the issue",
    "description": "Full context: what happened, what you expected, error messages, steps to reproduce"
  }' | python3 -m json.tool
\`\`\`

Or via CLI:
\`\`\`bash
instar feedback --type bug --title "Brief description" --description "Full context"
\`\`\`

## Feedback Types

| Type | When to use |
|------|-------------|
| \`bug\` | Something broke or behaves differently than expected |
| \`feature\` | A capability that doesn't exist yet but would be useful |
| \`improvement\` | Something works but could work better |
| \`question\` | Not sure if it's a bug or intended behavior |

## When to Submit (Autonomously)

Don't wait for the user to notice. You are the first line of detection:

- **Server API** returning unexpected errors or response shapes
- **Hooks** throwing errors or not firing when expected
- **Jobs** not running on schedule or failing silently
- **Sessions** not spawning, not tracked, or becoming zombies
- **State files** with corrupted or missing fields
- **Config settings** not being applied
- **Missing capabilities** that should exist
- **Friction** in workflows that feel unnecessarily complex

## Good Feedback

Include enough context for a fix:

**Bug**: What happened + what you expected + steps to reproduce + error output + your environment (\`instar --version\`, \`node --version\`)

**Feature**: What you're trying to do + what's limited today + how you'd like it to work + why it matters

## View & Retry

\`\`\`bash
# View submitted feedback
curl -s http://localhost:${port}/feedback | python3 -m json.tool

# Retry failed forwards
curl -s -X POST http://localhost:${port}/feedback/retry
\`\`\`

## How It Works

Your feedback is stored locally AND forwarded to the instar maintainers. When they fix the issue and publish an update, the built-in auto-updater detects it, applies it, and restarts the server — no manual intervention needed. One agent's bug report lifts all ships.

**User feedback matters too.** When your user says "this isn't working" or "I wish I could..." — capture it with their original words. User language carries context that technical rephrasing loses.
`,
    },
    'triage-findings': {
      name: 'triage-findings',
      description: 'Review and route pending serendipity findings captured by sub-agents.',
      content: `---
name: triage-findings
description: Review and route pending serendipity findings captured by sub-agents.
metadata:
  user_invocable: "true"
---

# /triage-findings

Review pending serendipity findings — discoveries captured by sub-agents during focused tasks. Route each finding to the appropriate destination: Evolution proposals, dismiss, or flag for manual review.

## Steps

1. **List pending findings**:

\\\`\\\`\\\`bash
ls .instar/state/serendipity/*.json 2>/dev/null
\\\`\\\`\\\`

If no findings exist, report "No pending findings" and stop.

2. **For each finding**, read and verify:
   a. Parse the JSON file
   b. Verify HMAC signature (read authToken from .instar/config.json, derive signing key from HMAC-SHA256(authToken, "serendipity-v1:" + sessionId), verify the signed payload)
   c. If HMAC fails, move to \\\`.instar/state/serendipity/invalid/\\\` and log the failure
   d. If a .patch file is referenced, verify it exists and its SHA-256 matches \\\`artifacts.patchSha256\\\`

3. **Assess each valid finding**:
   - Is it actionable? Does it describe a real issue or improvement?
   - Is it a duplicate of something already proposed?
   - Check existing evolution proposals: \\\`curl -s -H "Authorization: Bearer $AUTH" http://localhost:${port}/evolution/proposals\\\`

4. **Route the finding** (one of):

   **a. Promote to Evolution proposal** (for actionable findings):
   \\\`\\\`\\\`bash
   curl -s -X POST http://localhost:${port}/evolution/proposals \\\\
     -H "Authorization: Bearer $AUTH" \\\\
     -H 'Content-Type: application/json' \\\\
     -d '{"title":"FINDING_TITLE","source":"serendipity:FINDING_ID","description":"FINDING_DESCRIPTION","type":"TYPE","impact":"IMPACT","effort":"EFFORT","tags":["serendipity","from-subagent"]}'
   \\\`\\\`\\\`

   **b. Dismiss** (for low-value, duplicate, or stale findings):
   Move to processed directory with a note.

   **c. Flag for manual review** (for findings you're uncertain about):
   Queue an attention item:
   \\\`\\\`\\\`bash
   curl -s -X POST http://localhost:${port}/attention \\\\
     -H "Authorization: Bearer $AUTH" \\\\
     -H 'Content-Type: application/json' \\\\
     -d '{"title":"Serendipity finding needs review: TITLE","body":"DESCRIPTION","priority":"low","source":"serendipity"}'
   \\\`\\\`\\\`

5. **Move processed finding** to \\\`.instar/state/serendipity/processed/\\\`:
   \\\`\\\`\\\`bash
   mv .instar/state/serendipity/FINDING_ID.json .instar/state/serendipity/processed/
   mv .instar/state/serendipity/FINDING_ID.patch .instar/state/serendipity/processed/ 2>/dev/null
   \\\`\\\`\\\`

6. **Report summary**: How many findings triaged, how many promoted, dismissed, flagged.

## HMAC Verification (Python)

\\\`\\\`\\\`python
import json, hmac, hashlib

finding = json.load(open('FINDING_FILE'))
config = json.load(open('.instar/config.json'))
auth_token = config.get('authToken', '')
session_id = finding['source']['sessionId']

# Derive signing key
key_material = f"serendipity-v1:{session_id}"
signing_key = hmac.new(auth_token.encode(), key_material.encode(), hashlib.sha256).hexdigest()

# Build canonical signed payload
signed_data = {"id": finding["id"], "createdAt": finding["createdAt"],
               "discovery": finding["discovery"], "source": finding["source"]}
if "artifacts" in finding:
    signed_data["artifacts"] = finding["artifacts"]
canonical = json.dumps(signed_data, sort_keys=True, separators=(',', ':'))

expected = hmac.new(signing_key.encode(), canonical.encode(), hashlib.sha256).hexdigest()
valid = hmac.compare_digest(expected, finding.get('hmac', ''))
\\\`\\\`\\\`

## Category to Evolution Type Mapping

| Serendipity Category | Evolution Type |
|---------------------|---------------|
| bug | capability |
| improvement | capability |
| feature | capability |
| pattern | workflow |
| refactor | infrastructure |
| security | infrastructure |

## When to Run

- When session-start hook reports pending findings
- Periodically (the evolution-review job can trigger this)
- When the user asks about pending discoveries
`,
    },
  };

  for (const [slug, skill] of Object.entries(skills)) {
    const skillDir = path.join(skillsDir, slug);
    const skillFile = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(skillFile, skill.content);
    }
  }
}

function getDefaultJobs(port: number): object[] {
  return [
    {
      slug: 'health-check',
      name: 'Health Check',
      description: 'Monitor server health, session status, and system resources.',
      schedule: '*/5 * * * *',
      priority: 'critical',
      expectedDurationMinutes: 3,
      model: 'haiku',
      enabled: true,
      execute: {
        type: 'prompt',
        value: `Run a quick health check: verify the instar server is responding (curl http://localhost:${port}/health), check disk space (df -h), and report any issues. Only send a message if something needs attention — silence means healthy.`,
      },
      tags: ['coherence', 'default'],
    },
    {
      slug: 'reflection-trigger',
      name: 'Reflection Trigger',
      description: 'Review recent work and update MEMORY.md if any learnings exist.',
      schedule: '0 */4 * * *',
      priority: 'medium',
      expectedDurationMinutes: 5,
      model: 'opus',
      enabled: true,
      execute: {
        type: 'prompt',
        value: 'Review what has happened in the last 4 hours by reading recent activity logs. If there are any learnings, patterns, or insights worth remembering, update .instar/MEMORY.md. If nothing significant happened, do nothing.',
      },
      tags: ['coherence', 'default'],
    },
    {
      slug: 'relationship-maintenance',
      name: 'Relationship Maintenance',
      description: 'Review tracked relationships and surface observations about stale contacts.',
      schedule: '0 9 * * *',
      priority: 'low',
      expectedDurationMinutes: 3,
      model: 'opus',
      enabled: true,
      execute: {
        type: 'prompt',
        value: 'Review all relationship files in .instar/relationships/. Note anyone you haven\'t heard from in over 2 weeks who has significance >= 3. If there are observations worth surfacing, report them. If everything looks fine, do nothing.',
      },
      tags: ['coherence', 'default'],
    },
    {
      slug: 'update-check',
      name: 'Update Check',
      description: 'Legacy update check job — disabled because the built-in AutoUpdater handles updates automatically (check, apply, notify, restart). See GET /updates/auto for status.',
      schedule: '*/30 * * * *',
      priority: 'medium',
      expectedDurationMinutes: 2,
      model: 'haiku',
      enabled: false,
      gate: `curl -sf http://localhost:${port}/updates 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('updateAvailable') else 1)"`,
      execute: {
        type: 'script',
        value: `curl -s http://localhost:${port}/updates/auto`,
      },
      tags: ['coherence', 'default'],
    },
    {
      slug: 'feedback-retry',
      name: 'Feedback Retry',
      description: 'Retry forwarding any feedback that failed to reach upstream.',
      schedule: '0 */6 * * *',
      priority: 'low',
      expectedDurationMinutes: 1,
      model: 'haiku',
      enabled: true,
      gate: `curl -sf http://localhost:${port}/health >/dev/null 2>&1`,
      execute: {
        type: 'script',
        value: `RESULT=$(curl -s -X POST http://localhost:${port}/feedback/retry 2>/dev/null); COUNT=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('retried',0))" 2>/dev/null || echo 0); [ "$COUNT" -gt "0" ] && echo "Feedback retry: $COUNT item(s) forwarded." || echo "Feedback retry: nothing pending."`,
      },
      tags: ['coherence', 'default'],
    },
    {
      slug: 'dispatch-check',
      name: 'Dispatch Check',
      description: 'Legacy dispatch check job — disabled because the built-in AutoDispatcher handles polling, evaluation, and execution automatically. See GET /dispatches/auto for status.',
      schedule: '*/30 * * * *',
      priority: 'medium',
      expectedDurationMinutes: 2,
      model: 'haiku',
      enabled: false,
      gate: `curl -sf http://localhost:${port}/dispatches 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('newCount',0) > 0 else 1)"`,
      execute: {
        type: 'script',
        value: `curl -s http://localhost:${port}/dispatches/auto`,
      },
      tags: ['coherence', 'default'],
    },
    {
      slug: 'self-diagnosis',
      name: 'Self-Diagnosis',
      description: 'Proactively scan for issues with instar infrastructure, hooks, jobs, and state. Submit feedback for anything broken or suboptimal.',
      schedule: '0 */2 * * *',
      priority: 'medium',
      expectedDurationMinutes: 3,
      model: 'opus',
      enabled: true,
      gate: `curl -sf http://localhost:${port}/health >/dev/null 2>&1`,
      execute: {
        type: 'prompt',
        value: `You are your own QA team. Scan for issues with your instar infrastructure and submit feedback for anything wrong.

FIRST: Read your auth token for API calls:
AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)

Then check each area:

1. **Server health**: curl -s -H "Authorization: Bearer $AUTH" http://localhost:${port}/health — is it responding? Are all fields present? Is status "ok" or "degraded"?
2. **State files**: Check .instar/state/ — are JSON files parseable? Any empty or corrupted? Try: for f in .instar/state/*.json; do python3 -c "import json; json.load(open('$f'))" 2>&1 || echo "CORRUPT: $f"; done
3. **Hook files**: Do all hooks in .instar/hooks/instar/ exist and have execute permissions? ls -la .instar/hooks/instar/
4. **Job execution**: curl -s -H "Authorization: Bearer $AUTH" http://localhost:${port}/jobs — are any jobs failing repeatedly? Check lastRun and lastError fields.
5. **Quota**: curl -s -H "Authorization: Bearer $AUTH" http://localhost:${port}/quota — is usage approaching limits?
6. **Logs**: Check .instar/logs/server.log for recent errors: tail -50 .instar/logs/server.log | grep -i error
7. **Settings coherence**: Are hooks in .claude/settings.json pointing to files that exist?
8. **Design friction**: During your recent work, did anything feel unnecessarily difficult, confusing, or broken? Did you work around any issues?
9. **CI health**: Check if the project has a GitHub repo and if CI is passing. Run: REPO=$(git remote get-url origin 2>/dev/null | sed 's/.*github.com[:/]//;s/.git$//'); if [ -n "$REPO" ]; then FAILURES=$(gh run list --repo "$REPO" --status failure --limit 3 --json databaseId,conclusion,headBranch,name,createdAt 2>/dev/null); if echo "$FAILURES" | python3 -c "import sys,json; runs=json.load(sys.stdin); exit(0 if runs else 1)" 2>/dev/null; then echo "CI FAILURES DETECTED in $REPO"; echo "$FAILURES"; echo ""; echo "FIX THESE NOW: Read the failure logs with 'gh run view RUN_ID --repo $REPO --log-failed', diagnose the issue, fix it, run tests locally, commit and push."; fi; fi

For EACH issue found, submit feedback immediately:
curl -s -X POST http://localhost:${port}/feedback -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' -d '{"type":"bug","title":"TITLE","description":"FULL_CONTEXT"}'

For improvements (not bugs), use type "improvement" instead.

IMPORTANT for CI failures: Don't just report them as feedback — FIX THEM. Read the logs, diagnose the root cause, apply the fix, run tests locally to verify, then commit and push. Only submit feedback if the fix is beyond your capability (e.g., requires credentials or external service changes). CI health is your responsibility as the agent running this project.

If everything looks healthy, exit silently. Only report issues.`,
      },
      tags: ['coherence', 'default'],
    },
    {
      slug: 'evolution-review',
      name: 'Evolution Review',
      description: 'Review pending evolution proposals, evaluate their merit, and implement approved ones.',
      schedule: '0 */6 * * *',
      priority: 'medium',
      expectedDurationMinutes: 5,
      model: 'opus',
      enabled: true,
      gate: `curl -sf http://localhost:${port}/evolution/proposals?status=proposed 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if len(d.get('proposals',[])) > 0 else 1)"`,
      execute: {
        type: 'prompt',
        value: `Review pending evolution proposals: curl -s http://localhost:${port}/evolution/proposals?status=proposed

For each proposal:
1. Read the title, description, type, and source
2. Evaluate: Is this a genuine improvement? Is the effort worth the impact? Does it align with our goals?
3. If approved, update status: curl -s -X PATCH http://localhost:${port}/evolution/proposals/EVO-XXX -H 'Content-Type: application/json' -d '{"status":"approved"}'
4. Then implement it: create the skill/hook/job/config change described in the proposal
5. After implementation, mark complete: curl -s -X PATCH http://localhost:${port}/evolution/proposals/EVO-XXX -H 'Content-Type: application/json' -d '{"status":"implemented","resolution":"What was done"}'

If a proposal should be deferred or rejected, update with reason.

Also check the dashboard: curl -s http://localhost:${port}/evolution — report any highlights to the user if they seem important.

If no proposals need attention, exit silently.`,
      },
      tags: ['coherence', 'default', 'evolution'],
    },
    {
      slug: 'insight-harvest',
      name: 'Insight Harvest',
      description: 'Synthesize learnings from the learning registry, detect patterns, and generate evolution proposals from high-confidence insights.',
      schedule: '0 */8 * * *',
      priority: 'low',
      expectedDurationMinutes: 3,
      model: 'opus',
      enabled: true,
      gate: `curl -sf http://localhost:${port}/evolution/learnings?applied=false 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if len(d.get('learnings',[])) > 0 else 1)"`,
      execute: {
        type: 'prompt',
        value: `Harvest and synthesize learnings: curl -s http://localhost:${port}/evolution/learnings?applied=false

Review unapplied learnings and look for:
1. **Patterns**: Multiple learnings pointing to the same conclusion
2. **Actionable insights**: Learnings that suggest a specific change
3. **Cross-domain connections**: Insights from one area that apply to another

For each actionable pattern found, create an evolution proposal:
curl -s -X POST http://localhost:${port}/evolution/proposals -H 'Content-Type: application/json' -d '{"title":"...","source":"insight-harvest from LRN-XXX","description":"...","type":"...","impact":"...","effort":"..."}'

Then mark the relevant learnings as applied:
curl -s -X PATCH http://localhost:${port}/evolution/learnings/LRN-XXX/apply -H 'Content-Type: application/json' -d '{"appliedTo":"EVO-XXX"}'

Also update MEMORY.md with any patterns worth preserving long-term.

If no actionable patterns found, exit silently.`,
      },
      tags: ['coherence', 'default', 'evolution'],
    },
    {
      slug: 'commitment-check',
      name: 'Commitment Check',
      description: 'Track action items and commitments. Surface overdue items and stale commitments.',
      schedule: '0 */4 * * *',
      priority: 'low',
      expectedDurationMinutes: 2,
      model: 'haiku',
      enabled: true,
      gate: `curl -sf http://localhost:${port}/evolution/actions/overdue 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if len(d.get('overdue',[])) > 0 else 1)"`,
      execute: {
        type: 'prompt',
        value: `Check for overdue commitments: curl -s http://localhost:${port}/evolution/actions/overdue

For each overdue action:
1. Assess: Can this be completed now? Is it still relevant?
2. If actionable, attempt to complete it or advance it
3. If no longer relevant, cancel it: curl -s -X PATCH http://localhost:${port}/evolution/actions/ACT-XXX -H 'Content-Type: application/json' -d '{"status":"cancelled","resolution":"No longer relevant because..."}'
4. If blocked, escalate to the user via Telegram (if configured)

Also check pending actions (curl -s http://localhost:${port}/evolution/actions?status=pending) for items that have been pending more than 48 hours without a due date — these are forgotten commitments.

If no overdue or stale items, exit silently.`,
      },
      tags: ['coherence', 'default', 'evolution'],
    },
    {
      slug: 'project-map-refresh',
      name: 'Project Map Refresh',
      description: 'Regenerate the project territory map to keep spatial awareness current.',
      schedule: '0 */12 * * *',
      priority: 'low',
      expectedDurationMinutes: 1,
      model: 'haiku',
      enabled: true,
      gate: `curl -sf http://localhost:${port}/health >/dev/null 2>&1`,
      execute: {
        type: 'script',
        value: `RESULT=$(curl -s -X POST http://localhost:${port}/project-map/refresh -H "Authorization: Bearer $(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)" 2>/dev/null); echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Project map refreshed: {d.get(\"totalFiles\",0)} files, {d.get(\"directories\",0)} dirs')" 2>/dev/null || echo "Project map refresh: done"`,
      },
      tags: ['coherence', 'default', 'maintenance'],
    },
    {
      slug: 'coherence-audit',
      name: 'Coherence Audit',
      description: 'Verify topic-project bindings are still valid, state files are healthy, and no drift has occurred.',
      schedule: '0 */8 * * *',
      priority: 'low',
      expectedDurationMinutes: 2,
      model: 'haiku',
      enabled: true,
      gate: `curl -sf http://localhost:${port}/health >/dev/null 2>&1`,
      execute: {
        type: 'prompt',
        value: `Run a coherence audit to verify the agent's awareness infrastructure is healthy.

AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)

Check each area:

1. **Topic-Project Bindings**: curl -s -H "Authorization: Bearer $AUTH" http://localhost:${port}/topic-bindings — are all bindings still valid? Do the project directories exist?
2. **Project Map**: curl -s -H "Authorization: Bearer $AUTH" http://localhost:${port}/project-map — is the map recent (check generatedAt)? If older than 24 hours, refresh it.
3. **Canonical State**: Check .instar/quick-facts.json, .instar/anti-patterns.json, .instar/project-registry.json — are they parseable? Any stale entries?
4. **Context Segments**: curl -s -H "Authorization: Bearer $AUTH" http://localhost:${port}/context — are all segments present? Any with 0 bytes?

If issues found, log them as learnings (POST /evolution/learnings) and fix what you can. Exit silently if healthy.`,
      },
      tags: ['coherence', 'default', 'maintenance'],
    },
    {
      slug: 'degradation-digest',
      name: 'Degradation Digest',
      description: 'Read DegradationReporter events, group repeated patterns, and escalate trends that need attention.',
      schedule: '0 */4 * * *',
      priority: 'medium',
      expectedDurationMinutes: 1,
      model: 'haiku',
      enabled: true,
      gate: `test -f .instar/state/degradation-events.json && python3 -c "import json; events=json.load(open('.instar/state/degradation-events.json')); exit(0 if len(events) > 0 else 1)" 2>/dev/null`,
      execute: {
        type: 'prompt',
        value: `Review degradation events and surface patterns that need attention.

AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)

1. Read degradation events: cat .instar/state/degradation-events.json
2. Group by feature — count how many times each feature degraded since the last digest
3. Check if there's a previous digest: cat .instar/state/job-handoff-degradation-digest.md 2>/dev/null

For each feature with repeated degradations (3+ events):
- This is a PATTERN, not a one-off. It means the primary path is reliably failing.
- Submit feedback: curl -s -X POST http://localhost:${port}/feedback -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' -d '{"type":"bug","title":"Repeated degradation: FEATURE","description":"FEATURE has degraded N times. Primary: X. Fallback: Y. Most recent reason: Z. This pattern indicates the primary path needs fixing."}'

Write handoff notes with the current event count per feature:
echo "Last digest: $(date -u +%Y-%m-%dT%H:%M:%SZ). Events by feature: ..." > .instar/state/job-handoff-degradation-digest.md

If no patterns found (all one-offs), exit silently.`,
      },
      tags: ['coherence', 'default', 'guardian'],
    },
    {
      slug: 'state-integrity-check',
      name: 'State Integrity Check',
      description: 'Cross-validate state file consistency, detect orphaned references and bloat.',
      schedule: '0 */6 * * *',
      priority: 'medium',
      expectedDurationMinutes: 1,
      model: 'haiku',
      enabled: true,
      gate: `curl -sf http://localhost:${port}/health >/dev/null 2>&1`,
      execute: {
        type: 'prompt',
        value: `Cross-validate agent state for logical consistency.

AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)

Check each integrity constraint:

1. **Active job orphan**: If .instar/state/active-job.json exists, verify the session it references is actually running: curl -s -H "Authorization: Bearer $AUTH" http://localhost:${port}/sessions | check if the session name matches. If the session is dead but active-job.json persists, it's orphaned — delete it.

2. **Job-topic orphan**: Read .instar/state/job-topic-mappings.json. For each mapping, verify the topic ID is reachable via: curl -s -H "Authorization: Bearer $AUTH" http://localhost:${port}/telegram/topics — if topics have been deleted, the mapping is stale.

3. **State file bloat**: Check sizes: ls -la .instar/state/*.json | sort by size. Any file over 1MB is a bloat signal — report it. Common culprits: degradation-events.json growing unbounded, activity logs accumulating.

4. **Config-reality match**: Read .instar/config.json. If telegram is configured, verify the bot is connected: curl -s -H "Authorization: Bearer $AUTH" http://localhost:${port}/health — check if telegram field shows connected. If config says telegram but health says disconnected, report the discrepancy.

5. **Handoff note staleness**: Check .instar/state/job-handoff-*.md files. If any are older than 7 days and reference state that may have changed, flag them as potentially stale.

For each issue found, submit feedback. Fix what you can (delete orphaned active-job.json, prune bloated files). Exit silently if everything checks out.`,
      },
      tags: ['coherence', 'default', 'guardian'],
    },
    {
      slug: 'memory-hygiene',
      name: 'Memory Hygiene',
      description: 'Review MEMORY.md for stale entries, duplicates, and quality issues. Propose cleanup.',
      schedule: '0 */12 * * *',
      priority: 'low',
      expectedDurationMinutes: 5,
      model: 'opus',
      enabled: true,
      gate: `test -f .instar/MEMORY.md && wc -w < .instar/MEMORY.md | python3 -c "import sys; exit(0 if int(sys.stdin.read().strip()) > 100 else 1)" 2>/dev/null`,
      execute: {
        type: 'prompt',
        value: `Review .instar/MEMORY.md for quality and hygiene.

Read the full file: cat .instar/MEMORY.md

Evaluate each entry against these criteria:

1. **Staleness**: Does this entry reference files, APIs, URLs, or features that no longer exist? Verify by checking if referenced paths exist (ls, curl). Stale entries actively mislead future sessions.

2. **Duplicates**: Are multiple entries saying the same thing in different words? Consolidate them.

3. **Abstraction without substance**: Does the entry say something concrete and actionable, or is it a vague platitude? "Always verify before committing" without context of WHAT to verify is noise. Good: "The /api/chat endpoint caches responses for 5 minutes — bypass with ?nocache=1". Bad: "Remember to check caching behavior."

4. **Size check**: Count total words. If MEMORY.md exceeds 5000 words, it's becoming a burden on context rather than an aid. Identify the bottom 20% by usefulness and propose removing them.

5. **Organization**: Are entries grouped by topic? Is the structure navigable? Reorganize if needed.

For issues found:
- Fix duplicates and minor cleanups directly (edit the file)
- For significant deletions, add a comment "PROPOSED REMOVAL: [reason]" rather than deleting — let the next reflection-trigger or human confirm
- Log a learning if you discover a pattern: curl -s -X POST http://localhost:${port}/evolution/learnings -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' -d '{"category":"memory","insight":"...","confidence":"high"}'

Write handoff: echo "Last hygiene: $(date). Words: N. Entries: N. Removed: N. Flagged: N." > .instar/state/job-handoff-memory-hygiene.md

If MEMORY.md is clean and well-organized, exit silently.`,
      },
      grounding: {
        requiresIdentity: true,
        contextFiles: ['MEMORY.md'],
      },
      tags: ['coherence', 'default', 'guardian'],
    },
    {
      slug: 'guardian-pulse',
      name: 'Guardian Pulse',
      description: 'Meta-monitor: verify other jobs are running, healthy, and not silently failing.',
      schedule: '0 */8 * * *',
      priority: 'high',
      expectedDurationMinutes: 2,
      model: 'haiku',
      enabled: true,
      gate: `curl -sf http://localhost:${port}/health >/dev/null 2>&1`,
      execute: {
        type: 'prompt',
        value: `Meta-monitor: check whether the guardians themselves are healthy.

AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)

1. **Job health**: curl -s -H "Authorization: Bearer $AUTH" http://localhost:${port}/jobs
   For each enabled job, check:
   - Has it run at all? (lastRun should exist)
   - Is it overdue? (If lastRun is more than 3x the schedule interval ago, it's stuck)
   - Is it failing repeatedly? (consecutiveFailures > 0 is notable, > 2 is critical)
   - Is the lastError informative? (If it says "Session killed" repeatedly, something is wrong)

2. **Skip ledger trends**: curl -s -H "Authorization: Bearer $AUTH" http://localhost:${port}/skip-ledger/workloads
   If any job has been skipped more than 10 times by its gate, the gate may be misconfigured (always returning skip), or the feature it monitors is permanently broken.

3. **Queue health**: curl -s -H "Authorization: Bearer $AUTH" http://localhost:${port}/jobs — check queueLength.
   If queue is perpetually > 0, jobs are backing up. This means maxParallelJobs is too low or jobs are running too long.

4. **Degradation reporter health**: Read .instar/state/degradation-events.json — if events exist but none have reported:true or alerted:true, the downstream connections (FeedbackManager, Telegram) never initialized. The reporter is collecting but not communicating.

5. **Session monitor**: curl -s -H "Authorization: Bearer $AUTH" http://localhost:${port}/sessions
   Are there zombie sessions (status: running but started > 30 minutes ago for a job that should take 5)?

For each finding, categorize:
- CRITICAL: Job has been failing for > 24 hours, or meta-infrastructure (scheduler, reporter) is broken
- WARNING: Job overdue, skip count high, queue growing
- INFO: Minor observations

Report CRITICAL and WARNING issues. Exit silently if everything looks healthy.

Write handoff: echo "Pulse at $(date). Jobs checked: N. Issues: [list or 'none']." > .instar/state/job-handoff-guardian-pulse.md`,
      },
      tags: ['coherence', 'default', 'guardian', 'meta'],
    },
    {
      slug: 'session-continuity-check',
      name: 'Session Continuity Check',
      description: 'Verify that sessions produce lasting artifacts: handoff notes, memory updates, learnings.',
      schedule: '0 */4 * * *',
      priority: 'low',
      expectedDurationMinutes: 2,
      model: 'haiku',
      enabled: true,
      gate: `curl -sf http://localhost:${port}/health >/dev/null 2>&1`,
      execute: {
        type: 'prompt',
        value: `Check whether recent sessions contributed to long-term knowledge.

AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)

1. **Recent sessions**: curl -s -H "Authorization: Bearer $AUTH" http://localhost:${port}/sessions
   Get sessions that completed in the last 8 hours.

2. **For each completed job session**, check:
   - Does a handoff note exist? (.instar/state/job-handoff-{slug}.md)
   - Was it updated recently? (stat -f %m or date check)
   - If the job is reflection-trigger or insight-harvest, did MEMORY.md actually change? (Check git diff or file modification time)

3. **For interactive sessions** (non-job), check:
   - Did the session produce any lasting artifacts? (git log for commits, MEMORY.md changes, new files in .instar/)
   - If a long session (>10 minutes) left no trace, that's a continuity leak — knowledge was generated but not preserved.

4. **Handoff note freshness**: ls -la .instar/state/job-handoff-*.md
   - Any handoff note older than 7 days for an active job? It might contain stale claims.
   - Flag stale handoff notes as potential misinformation vectors.

Findings:
- If sessions are running but not producing artifacts: propose an evolution to improve the reflection-trigger or add post-session hooks
- If handoff notes are stale: add a "[STALE]" prefix to the file so the next job session treats it with appropriate skepticism

Write handoff: echo "Continuity check at $(date). Sessions reviewed: N. Artifacts found: N. Gaps: N." > .instar/state/job-handoff-session-continuity-check.md

Exit silently if continuity is healthy.`,
      },
      tags: ['coherence', 'default', 'guardian'],
    },
    {
      slug: 'memory-export',
      name: 'Memory Export',
      description: 'Regenerate MEMORY.md from SemanticMemory knowledge graph. Keeps the human-readable memory snapshot fresh without manual intervention.',
      schedule: '0 */6 * * *',
      priority: 'low',
      expectedDurationMinutes: 1,
      model: 'haiku',
      enabled: true,
      gate: `curl -sf http://localhost:${port}/health >/dev/null 2>&1 && curl -sf -H "Authorization: Bearer $AUTH" http://localhost:${port}/semantic/stats >/dev/null 2>&1`,
      execute: {
        type: 'script',
        value: `AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null); AGENT=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('agentName','Agent'))" 2>/dev/null); RESULT=$(curl -s -X POST -H "Authorization: Bearer $AUTH" -H "Content-Type: application/json" -d "{\\"filePath\\":\\".instar/MEMORY.md\\",\\"agentName\\":\\"$AGENT\\"}" http://localhost:${port}/semantic/export-memory 2>/dev/null); COUNT=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('entityCount',0))" 2>/dev/null || echo 0); EXCLUDED=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('excludedCount',0))" 2>/dev/null || echo 0); [ "$COUNT" -gt "0" ] && echo "Memory export: $COUNT entities written to MEMORY.md ($EXCLUDED excluded below threshold)." || echo "Memory export: no entities to export."`,
      },
      tags: ['memory', 'default', 'maintenance'],
    },
    {
      slug: 'git-sync',
      name: 'Git Sync',
      description: 'Intelligent multi-machine git synchronization. Pulls remote changes, merges with conflict resolution, commits local changes, and pushes. Uses tiered model selection: haiku for clean syncs, sonnet for state file conflicts, opus for code conflicts.',
      schedule: '0 * * * *',
      priority: 'high',
      expectedDurationMinutes: 5,
      model: 'haiku',
      enabled: true,
      gate: 'bash .claude/scripts/git-sync-gate.sh',
      execute: {
        type: 'prompt',
        value: `You are running a periodic git sync. Your job is to synchronize this machine's state with the remote repository intelligently.

## Pre-flight

1. Check conflict severity: \`cat /tmp/instar-git-sync-severity 2>/dev/null || echo "clean"\`
2. Run: \`git status --short\` and \`git log --oneline -3\` to understand current state
3. Run: \`git fetch origin && git rev-list --left-right --count HEAD...@{u}\` to see ahead/behind

## Sync Strategy

### If only behind (remote has new commits, no local changes):
- \`git pull --rebase\`
- Report what was pulled

### If only ahead (local changes, nothing new on remote):
- \`git add -A\`
- Compose a brief sync commit message categorizing the changes (state, config, skills, code, etc.)
- \`git commit\` then \`git push\`

### If both (changes on both sides):
- First commit local changes: \`git add -A && git commit -m "sync: local changes"\`
- Then pull with rebase: \`git pull --rebase\`
- If conflicts arise, resolve them:
  - **JSON state files** (.instar/state/, activity caches, session data): Take newer timestamps, union arrays by ID, max counters
  - **Memory/identity files** (MEMORY.md, AGENT.md): Merge content — keep additions from both sides
  - **Code files** (.ts, .js, .py): Review carefully, understand both changes, merge semantically
  - **Config files**: Preserve local machine-specific values, take newer shared settings
- After resolving: \`git add . && git rebase --continue\`
- Then push: \`git push\`

### If clean (gate passed but nothing obvious):
- The gate detected something — re-check with \`git status\` and \`git fetch\`
- If truly nothing: report "sync check complete, nothing to do"

## Reporting

- If nothing happened: exit silently (no message needed)
- If changes synced cleanly: brief one-line summary ("Pulled 3 commits, pushed 2")
- If conflicts were resolved: describe what conflicted and how you resolved it
- If conflicts could NOT be resolved: report the conflict details and leave the working tree clean (abort rebase if needed)

## Important

- NEVER force push
- NEVER delete branches
- If a rebase goes wrong, \`git rebase --abort\` and report the issue
- Prefer clean history (rebase) over merge commits when possible`,
      },
      tags: ['infrastructure', 'default'],
      telegramNotify: false,
    },
    {
      slug: 'capability-audit',
      name: 'Capability Audit',
      description: 'Refresh the capability map and detect drift. Compute-first: only spawns LLM if changes detected.',
      schedule: '0 */6 * * *',
      priority: 'low',
      expectedDurationMinutes: 1,
      model: 'haiku',
      enabled: true,
      gate: `curl -sf http://localhost:${port}/health >/dev/null 2>&1`,
      execute: {
        type: 'script',
        value: `AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null); REFRESH=$(curl -s -X POST -H "Authorization: Bearer $AUTH" http://localhost:${port}/capability-map/refresh 2>/dev/null); DRIFT=$(curl -s -H "Authorization: Bearer $AUTH" http://localhost:${port}/capability-map/drift 2>/dev/null); ADDED=$(echo "$DRIFT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('added',[])))" 2>/dev/null || echo 0); REMOVED=$(echo "$DRIFT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('removed',[])))" 2>/dev/null || echo 0); CHANGED=$(echo "$DRIFT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('changed',[])))" 2>/dev/null || echo 0); UNMAPPED=$(echo "$DRIFT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('unmapped',[])))" 2>/dev/null || echo 0); if [ "$ADDED" -gt "0" ] || [ "$REMOVED" -gt "0" ] || [ "$CHANGED" -gt "0" ] || [ "$UNMAPPED" -gt "0" ]; then echo "Capability drift detected: +$ADDED -$REMOVED ~$CHANGED ?$UNMAPPED"; echo "$DRIFT" | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f'  + {c[\"id\"]}') for c in d.get('added',[])]; [print(f'  - {r[\"id\"]}') for r in d.get('removed',[])]; [print(f'  ~ {c[\"id\"]} ({c[\"field\"]})') for c in d.get('changed',[])]" 2>/dev/null; else echo "Capability audit: no drift detected."; fi`,
      },
      grounding: {
        requiresIdentity: false,
        contextFiles: ['.instar/state/capability-manifest.json'],
      },
      tags: ['coherence', 'default', 'maintenance'],
    },
  ];
}

/**
 * Refresh hooks, Claude settings, and CLAUDE.md for an existing installation.
 * Called after updates to ensure new hooks and documentation are installed.
 * Re-writes all hook files (idempotent), merges new hooks into settings,
 * appends any missing sections to CLAUDE.md, and installs scripts for
 * configured integrations (e.g., Telegram relay).
 */
export function refreshHooksAndSettings(projectDir: string, stateDir: string): void {
  installHooks(stateDir);
  installClaudeSettings(projectDir);
  refreshClaudeMd(projectDir, stateDir);
  refreshJobs(stateDir);
  refreshScripts(projectDir, stateDir);
}

/**
 * Merge new default jobs into existing jobs.json without overwriting user changes.
 * Only adds jobs whose slugs don't already exist.
 */
function refreshJobs(stateDir: string): void {
  const jobsPath = path.join(stateDir, 'jobs.json');
  if (!fs.existsSync(jobsPath)) return;

  let port = 4321;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
    port = config.port || 4321;
  } catch { /* use default */ }

  try {
    const existingJobs = JSON.parse(fs.readFileSync(jobsPath, 'utf-8')) as Array<{ slug: string }>;
    const existingSlugs = new Set(existingJobs.map(j => j.slug));
    const defaultJobs = getDefaultJobs(port) as Array<{ slug: string }>;

    let added = 0;
    for (const job of defaultJobs) {
      if (!existingSlugs.has(job.slug)) {
        existingJobs.push(job);
        added++;
      }
    }

    // Auto-enable git-sync if git + remote are available (migration from disabled default)
    const gitSyncJob = existingJobs.find(j => j.slug === 'git-sync') as Record<string, unknown> | undefined;
    if (gitSyncJob && !gitSyncJob.enabled) {
      const projectDir = path.dirname(stateDir);
      const hasGit = fs.existsSync(path.join(projectDir, '.git'));
      let hasRemote = false;
      if (hasGit) {
        try {
          const remote = execFileSync('git', ['remote'], { cwd: projectDir, stdio: 'pipe' }).toString().trim();
          hasRemote = remote.length > 0;
        } catch { /* no git or no remote */ }
      }
      if (hasGit && hasRemote) {
        gitSyncJob.enabled = true;
        added++; // force write
      }
    }

    if (added > 0) {
      fs.writeFileSync(jobsPath, JSON.stringify(existingJobs, null, 2));
    }
  } catch { /* don't break on errors */ }
}

/**
 * Read config.json from state dir, returning parsed config or null.
 */
function readConfig(stateDir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Check if Telegram is configured in config.json.
 */
function isTelegramConfigured(stateDir: string): boolean {
  const config = readConfig(stateDir);
  if (!config) return false;
  const messaging = config.messaging as Array<{ type: string; enabled: boolean }> | undefined;
  return !!messaging?.some(m => m.type === 'telegram' && m.enabled);
}

/**
 * Check if WhatsApp is configured in config.json.
 */
function isWhatsAppConfigured(stateDir: string): boolean {
  const config = readConfig(stateDir);
  if (!config) return false;
  const messaging = config.messaging as Array<{ type: string; enabled: boolean }> | undefined;
  return !!messaging?.some(m => m.type === 'whatsapp' && m.enabled);
}

/**
 * Install scripts for configured integrations (e.g., Telegram relay, WhatsApp relay).
 * Called during refresh to ensure scripts exist for all configured integrations.
 */
function refreshScripts(projectDir: string, stateDir: string): void {
  const config = readConfig(stateDir);
  if (!config) return;
  const port = (config.port as number) || 4040;

  // Install telegram-reply.sh if Telegram is configured
  if (isTelegramConfigured(stateDir)) {
    installTelegramRelay(projectDir, port);
  }

  // Install whatsapp-reply.sh if WhatsApp is configured
  if (isWhatsAppConfigured(stateDir)) {
    installWhatsAppRelay(projectDir, port);
  }

  // Always install smart-fetch.py (agentic web conventions)
  installSmartFetch(projectDir);

  // Always install git-sync-gate.sh (pre-screening for git-sync job)
  installGitSyncGate(projectDir);

  // Always install serendipity-capture.sh
  installSerendipityCapture(projectDir);
}

/**
 * Install the Telegram relay script that Claude uses to send responses
 * back to Telegram topics via the instar server API.
 */
function installTelegramRelay(projectDir: string, port: number): void {
  const scriptsDir = path.join(projectDir, '.claude', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  const scriptContent = `#!/bin/bash
# telegram-reply.sh — Send a message back to a Telegram topic via instar server.
#
# Usage:
#   .claude/scripts/telegram-reply.sh TOPIC_ID "message text"
#   echo "message text" | .claude/scripts/telegram-reply.sh TOPIC_ID
#   cat <<'EOF' | .claude/scripts/telegram-reply.sh TOPIC_ID
#   Multi-line message here
#   EOF

TOPIC_ID="$1"
shift

if [ -z "$TOPIC_ID" ]; then
  echo "Usage: telegram-reply.sh TOPIC_ID [message]" >&2
  exit 1
fi

# Read message from args or stdin
if [ $# -gt 0 ]; then
  MSG="$*"
else
  MSG="$(cat)"
fi

if [ -z "$MSG" ]; then
  echo "No message provided" >&2
  exit 1
fi

PORT="\${INSTAR_PORT:-${port}}"

# Escape for JSON
JSON_MSG=$(printf '%s' "$MSG" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null)
if [ -z "$JSON_MSG" ]; then
  # Fallback if python3 not available: basic escape
  JSON_MSG="$(printf '%s' "$MSG" | sed 's/\\\\\\\\/\\\\\\\\\\\\\\\\/g; s/"/\\\\\\\\"/g' | sed ':a;N;$!ba;s/\\\\n/\\\\\\\\n/g')"
  JSON_MSG="\\"$JSON_MSG\\""
fi

RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST "http://localhost:\${PORT}/telegram/reply/\${TOPIC_ID}" \\
  -H 'Content-Type: application/json' \\
  -d "{\\"text\\":\${JSON_MSG}}")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  echo "Sent $(echo "$MSG" | wc -c | tr -d ' ') chars to topic $TOPIC_ID"
else
  echo "Failed (HTTP $HTTP_CODE): $BODY" >&2
  exit 1
fi
`;

  const scriptPath = path.join(scriptsDir, 'telegram-reply.sh');
  fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
}

/**
 * Install the WhatsApp relay script that Claude uses to send responses
 * back to WhatsApp JIDs via the instar server API.
 */
function installWhatsAppRelay(projectDir: string, port: number): void {
  const scriptsDir = path.join(projectDir, '.instar', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  const scriptContent = `#!/bin/bash
# whatsapp-reply.sh — Send a message back to a WhatsApp JID via instar server.
#
# Usage:
#   .instar/scripts/whatsapp-reply.sh JID "message text"
#   echo "message text" | .instar/scripts/whatsapp-reply.sh JID
#   cat <<'EOF' | .instar/scripts/whatsapp-reply.sh JID
#   Multi-line message here
#   EOF
#
# JID format: phone@s.whatsapp.net (e.g., 12345678901@s.whatsapp.net)

JID="$1"
shift

if [ -z "$JID" ]; then
  echo "Usage: whatsapp-reply.sh JID [message]" >&2
  exit 1
fi

# Read message from args or stdin
if [ $# -gt 0 ]; then
  MSG="$*"
else
  MSG="$(cat)"
fi

if [ -z "$MSG" ]; then
  echo "No message provided" >&2
  exit 1
fi

PORT="\${INSTAR_PORT:-${port}}"

# Read auth token from config (if present)
AUTH_TOKEN=""
if [ -f ".instar/config.json" ]; then
  AUTH_TOKEN=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)
fi

# Escape for JSON
JSON_MSG=$(printf '%s' "$MSG" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null)
if [ -z "$JSON_MSG" ]; then
  JSON_MSG="$(printf '%s' "$MSG" | sed 's/\\\\\\\\/\\\\\\\\\\\\\\\\/g; s/"/\\\\\\\\"/g' | sed ':a;N;$!ba;s/\\\\n/\\\\\\\\n/g')"
  JSON_MSG="\\"$JSON_MSG\\""
fi

if [ -n "$AUTH_TOKEN" ]; then
  RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST "http://localhost:\${PORT}/whatsapp/send/\${JID}" \\
    -H 'Content-Type: application/json' \\
    -H "Authorization: Bearer \${AUTH_TOKEN}" \\
    -d "{\\"text\\":\${JSON_MSG}}")
else
  RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST "http://localhost:\${PORT}/whatsapp/send/\${JID}" \\
    -H 'Content-Type: application/json' \\
    -d "{\\"text\\":\${JSON_MSG}}")
fi

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  echo "Sent $(echo "$MSG" | wc -c | tr -d ' ') chars to $JID"
else
  echo "Failed (HTTP $HTTP_CODE): $BODY" >&2
  exit 1
fi
`;

  const scriptPath = path.join(scriptsDir, 'whatsapp-reply.sh');
  fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
}

/**
 * Append missing sections to CLAUDE.md without overwriting user customizations.
 * Reads config.json for port, checks for known section headers, appends if missing.
 * Also adds Telegram relay section if Telegram is configured.
 */
function refreshClaudeMd(projectDir: string, stateDir: string): void {
  const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) return;

  const config = readConfig(stateDir);
  const port = (config?.port as number) || 4040;

  const content = fs.readFileSync(claudeMdPath, 'utf-8');
  const additions: string[] = [];

  // Check for Self-Diagnosis section
  if (!content.includes('Self-Diagnosis')) {
    additions.push(`
### Self-Diagnosis — Be Your Own QA

**This is critical.** You are running on infrastructure (instar) that is actively evolving. When something breaks, feels wrong, or could be better — **you are the first line of detection.** Do not silently absorb errors. Do not work around bugs without reporting them. Every issue you surface helps every agent on the platform.

**What to watch for:**
- Server errors: API calls to localhost:${port} failing, unexpected responses, timeouts
- Hook failures: hooks throwing errors, not firing when expected, blocking when they shouldn't
- Job issues: jobs not running on schedule, failing silently, taking too long
- Session problems: sessions not spawning, not being tracked, zombie sessions
- State corruption: JSON parse errors in .instar/state/ files, missing fields, stale data
- Config confusion: settings not being applied, defaults not making sense
- Missing capabilities: something you need to do but can't because instar doesn't support it
- Design flaws: patterns that feel wrong, workflows that are unnecessarily complex

**When you detect an issue, report it immediately:**
\`\`\`bash
curl -s -X POST http://localhost:${port}/feedback \\
  -H 'Content-Type: application/json' \\
  -d '{"type":"bug","title":"CONCISE_TITLE","description":"FULL_CONTEXT_WITH_ERROR_MESSAGES"}'
\`\`\`

Types: \`bug\`, \`feature\`, \`improvement\`, \`question\`

**Do not wait for the user to notice.** If a hook throws an error, report it. If a job fails, report it. If the server returns unexpected data, report it. You are not just using instar — you are part of its immune system.
`);
  }

  // Check for Evolution System section
  if (!content.includes('Evolution System')) {
    additions.push(`
### Evolution System

You have a built-in evolution system with four subsystems that track your growth.

**Evolution Queue** — Staged self-improvement proposals.
- View: \`curl http://localhost:${port}/evolution/proposals\`
- Propose: \`/evolve\` skill or \`POST /evolution/proposals\`

**Learning Registry** — Structured, searchable insights.
- View: \`curl http://localhost:${port}/evolution/learnings\`
- Record: \`/learn\` skill or \`POST /evolution/learnings\`

**Capability Gaps** — Track what you're missing.
- View: \`curl http://localhost:${port}/evolution/gaps\`
- Report: \`/gaps\` skill or \`POST /evolution/gaps\`

**Action Queue** — Commitments with follow-through tracking.
- View: \`curl http://localhost:${port}/evolution/actions\`
- Create: \`/commit-action\` skill or \`POST /evolution/actions\`

**Dashboard**: \`curl http://localhost:${port}/evolution\`
**Skills**: \`/evolve\`, \`/learn\`, \`/gaps\`, \`/commit-action\`
`);
  }

  // Check for WhatsApp Relay section (add if WhatsApp is configured)
  if (isWhatsAppConfigured(stateDir) && !content.includes('WhatsApp Relay')) {
    additions.push(`
## WhatsApp Relay

When user input starts with \`[whatsapp:JID]\` (e.g., \`[whatsapp:12345678901@s.whatsapp.net] hello\`), the message came from a user via WhatsApp.

**Response relay:** After completing your work, relay your response back:

\`\`\`bash
cat <<'EOF' | .instar/scripts/whatsapp-reply.sh JID
Your response text here
EOF
\`\`\`

Strip the \`[whatsapp:JID]\` prefix before interpreting the message. Respond naturally, then relay. Only relay your conversational text — not tool output or internal reasoning.
`);
  }

  // Check for Telegram Relay section (add if Telegram is configured)
  if (isTelegramConfigured(stateDir) && !content.includes('Telegram Relay')) {
    additions.push(`
## Telegram Relay

When user input starts with \`[telegram:N]\` (e.g., \`[telegram:26] hello\`), the message came from a user via Telegram topic N.

**IMMEDIATE ACKNOWLEDGMENT (MANDATORY):** When you receive a Telegram message, your FIRST action — before reading files, searching code, or doing any work — must be sending a brief acknowledgment back. This confirms the message was received and you haven't stalled. Examples: "Got it, looking into this now." / "On it — checking the scheduler." / "Received, working on the sync." Then do the work, then send the full response.

**Response relay:** After completing your work, relay your response back:

\`\`\`bash
cat <<'EOF' | .claude/scripts/telegram-reply.sh N
Your response text here
EOF
\`\`\`

Strip the \`[telegram:N]\` prefix before interpreting the message. Respond naturally, then relay. Only relay your conversational text — not tool output or internal reasoning.
`);
  }

  // Threadline Network section — always added so the agent knows about relay
  if (!content.includes('Threadline Network')) {
    additions.push(`
## Threadline Network (Agent-to-Agent Communication)

I can connect to the Threadline relay network for secure agent-to-agent communication.

- **Off by default** — I only connect if you ask me to
- **Encrypted** — TLS transport + Ed25519 E2E encryption between known agents
- **Trust-gated** — I control who can message me via trust levels
- **Conversational control** — ask me to "connect to the agent network" or "disconnect"

MCP tools: \`threadline_discover\`, \`threadline_send\`, \`threadline_trust\`, \`threadline_relay\`
Use \`threadline_relay explain\` for full details on privacy and security.
`);
  }

  if (additions.length > 0) {
    fs.appendFileSync(claudeMdPath, '\n' + additions.join('\n'));
  }
}

function installHooks(stateDir: string): void {
  const hooksBaseDir = path.join(stateDir, 'hooks');
  const hooksDir = path.join(hooksBaseDir, 'instar');
  const customHooksDir = path.join(hooksBaseDir, 'custom');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(customHooksDir, { recursive: true });

  // Session start hook — fires on startup, resume, clear, compact
  // Canonical version kept in sync with PostUpdateMigrator.getSessionStartHook().
  // PostUpdateMigrator overwrites this on first auto-update, but we want first-install
  // to have the same quality as updated agents.
  const migrator = new PostUpdateMigrator(
    { stateDir, port: 4040, sessions: { claudePath: 'claude' } } as any
  );
  fs.writeFileSync(path.join(hooksDir, 'session-start.sh'), migrator.getHookContent('session-start'), { mode: 0o755 });

  // Dangerous command guard — supports safety levels 1 (ask user) and 2 (self-verify)
  fs.writeFileSync(path.join(hooksDir, 'dangerous-command-guard.sh'), `#!/bin/bash
# Dangerous command guard — safety infrastructure for autonomous agents.
# Supports safety.level in .instar/config.json:
#   Level 1 (default): Block and ask user. Level 2: Agent self-verifies.
INPUT="$1"
INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"

# Read safety level from config
SAFETY_LEVEL=1
if [ -f "\$INSTAR_DIR/config.json" ]; then
  SAFETY_LEVEL=\$(python3 -c "import json; print(json.load(open('\$INSTAR_DIR/config.json')).get('safety', {}).get('level', 1))" 2>/dev/null || echo "1")
fi

# ALWAYS blocked (catastrophic, irreversible)
for pattern in "rm -rf /" "rm -rf ~" "> /dev/sda" "mkfs\\." "dd if=" ":(){:|:&};:"; do
  if echo "\$INPUT" | grep -qi "\$pattern"; then
    echo "BLOCKED: Catastrophic command detected: \$pattern" >&2
    echo "Always blocked regardless of safety level. User must execute directly." >&2
    exit 2
  fi
done

# Risky commands — behavior depends on safety level
for pattern in "rm -rf \\." "git push --force" "git push -f" "git reset --hard" "git clean -fd" "DROP TABLE" "DROP DATABASE" "TRUNCATE" "DELETE FROM"; do
  if echo "\$INPUT" | grep -qi "\$pattern"; then
    if [ "\$SAFETY_LEVEL" -eq 1 ]; then
      echo "BLOCKED: Potentially destructive command detected: \$pattern" >&2
      echo "Ask the user for explicit confirmation before running this command." >&2
      exit 2
    else
      IDENTITY=""
      if [ -f "\$INSTAR_DIR/AGENT.md" ]; then
        IDENTITY=\$(head -20 "\$INSTAR_DIR/AGENT.md" | tr '\\n' ' ')
      fi
      echo "{\\"decision\\":\\"approve\\",\\"additionalContext\\":\\"=== SELF-VERIFICATION REQUIRED ===\\\\nDestructive command detected: \$pattern\\\\n\\\\n1. Is this necessary for the current task?\\\\n2. What are the consequences if this goes wrong?\\\\n3. Is there a safer alternative?\\\\n4. Does this align with your principles?\\\\n\\\\nIdentity: \$IDENTITY\\\\n\\\\nIf ALL checks pass, proceed. If ANY fails, stop.\\\\n=== END SELF-VERIFICATION ===\\"}"
      exit 0
    fi
  fi
done
`, { mode: 0o755 });

  // Grounding before messaging — full pipeline with convergence check.
  // Uses PostUpdateMigrator as single source of truth (DRY).
  fs.writeFileSync(path.join(hooksDir, 'grounding-before-messaging.sh'), migrator.getGroundingBeforeMessagingPublic(), { mode: 0o755 });

  // Convergence check script — heuristic quality gate called by grounding-before-messaging.
  // Must be in .instar/scripts/ where grounding-before-messaging.sh expects it.
  const instarScriptsDir = path.join(stateDir, 'scripts');
  fs.mkdirSync(instarScriptsDir, { recursive: true });
  fs.writeFileSync(path.join(instarScriptsDir, 'convergence-check.sh'), migrator.getConvergenceCheckPublic(), { mode: 0o755 });

  // Compaction recovery — shared from PostUpdateMigrator (single source of truth).
  fs.writeFileSync(path.join(hooksDir, 'compaction-recovery.sh'), migrator.getHookContent('compaction-recovery'), { mode: 0o755 });


  // Deferral detector, post-action reflection, external communication guard
  // All use shared templates from PostUpdateMigrator for DRY maintenance.
  fs.writeFileSync(path.join(hooksDir, 'deferral-detector.js'), migrator.getHookContent('deferral-detector'), { mode: 0o755 });
  fs.writeFileSync(path.join(hooksDir, 'post-action-reflection.js'), migrator.getHookContent('post-action-reflection'), { mode: 0o755 });
  fs.writeFileSync(path.join(hooksDir, 'external-communication-guard.js'), migrator.getHookContent('external-communication-guard'), { mode: 0o755 });

  // External operation gate — intercepts MCP tool calls to external services.
  // Uses shared template from PostUpdateMigrator for DRY maintenance.
  fs.writeFileSync(path.join(hooksDir, 'external-operation-gate.js'), migrator.getHookContent('external-operation-gate'), { mode: 0o755 });

  // Claim intercept — catches false operational claims against canonical state.
  // PostToolUse hook checks tool output; Stop hook checks direct responses.
  fs.writeFileSync(path.join(hooksDir, 'claim-intercept.js'), migrator.getHookContent('claim-intercept'), { mode: 0o755 });
  fs.writeFileSync(path.join(hooksDir, 'claim-intercept-response.js'), migrator.getHookContent('claim-intercept-response'), { mode: 0o755 });

  // Response review — Coherence Gate response review pipeline.
  // Stop hook that calls /review/evaluate for LLM-powered response quality checking.
  fs.writeFileSync(path.join(hooksDir, 'response-review.js'), migrator.getHookContent('response-review'), { mode: 0o755 });
}

function installHealthWatchdog(projectDir: string, port: number, projectName: string): void {
  const scriptsDir = path.join(projectDir, '.claude', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  // Quote projectDir for shell safety — paths with spaces, parens, etc.
  const escapedProjectDir = projectDir.replace(/'/g, "'\\''");
  const escapedCronPath = path.join(projectDir, '.claude/scripts/health-watchdog.sh').replace(/'/g, "'\\''");

  const scriptContent = `#!/bin/bash
# health-watchdog.sh — Monitor instar server and auto-recover.
# Install as cron: */5 * * * * '${escapedCronPath}'

PORT="${port}"
SERVER_SESSION="${projectName}-server"
PROJECT_DIR='${escapedProjectDir}'
TMUX_PATH=$(which tmux 2>/dev/null || echo "/opt/homebrew/bin/tmux")

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:\${PORT}/health" 2>/dev/null)
if [ "$HTTP_CODE" = "200" ]; then exit 0; fi

echo "[\$(date -Iseconds)] Server not responding. Restarting..."
$TMUX_PATH kill-session -t "=\${SERVER_SESSION}" 2>/dev/null
sleep 2
cd "$PROJECT_DIR" && npx instar server start
echo "[\$(date -Iseconds)] Server restart initiated"
`;

  fs.writeFileSync(path.join(scriptsDir, 'health-watchdog.sh'), scriptContent, { mode: 0o755 });
}

/**
 * Install git-sync-gate.sh — zero-token pre-screening for the git-sync job.
 * Checks if a sync is needed before spawning a Claude session.
 * Also classifies conflict severity for tiered model selection.
 */
function installGitSyncGate(projectDir: string): void {
  const scriptsDir = path.join(projectDir, '.claude', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  const scriptPath = path.join(scriptsDir, 'git-sync-gate.sh');

  const content = [
    '#!/bin/bash',
    '# Git Sync Gate — zero-token pre-screening for the git-sync job.',
    '# Exit 0 = sync needed (proceed), exit 1 = nothing to sync (skip).',
    '# Writes conflict severity to /tmp/instar-git-sync-severity for model tier selection.',
    '',
    'SEVERITY_FILE="/tmp/instar-git-sync-severity"',
    'echo "clean" > "$SEVERITY_FILE"',
    '',
    '# Must be in a git repo with a remote',
    '[ ! -d ".git" ] && exit 1',
    'REMOTE=$(git remote | head -1)',
    '[ -z "$REMOTE" ] && exit 1',
    '',
    '# Check for local changes',
    'LOCAL_CHANGES=$(git status --porcelain 2>/dev/null | head -1)',
    '',
    '# Fetch remote (with timeout)',
    'git fetch origin --quiet 2>/dev/null &',
    'FETCH_PID=$!',
    '( sleep 10 && kill "$FETCH_PID" 2>/dev/null ) &',
    'wait "$FETCH_PID" 2>/dev/null',
    '',
    '# Check for remote changes',
    'TRACKING=$(git rev-parse --abbrev-ref "@{u}" 2>/dev/null)',
    'BEHIND=0',
    'AHEAD=0',
    'if [ -n "$TRACKING" ]; then',
    '  AB=$(git rev-list --left-right --count "HEAD...$TRACKING" 2>/dev/null)',
    '  BEHIND=$(echo "$AB" | awk \'{print $1}\')',
    '  AHEAD=$(echo "$AB" | awk \'{print $2}\')',
    'fi',
    '',
    '# Nothing to do — clean and in sync',
    'if [ -z "$LOCAL_CHANGES" ] && [ "${BEHIND:-0}" -eq "0" ] && [ "${AHEAD:-0}" -eq "0" ]; then',
    '  exit 1',
    'fi',
    '',
    '# Both sides have changes — check for potential conflicts',
    'if [ -n "$LOCAL_CHANGES" ] && [ "${BEHIND:-0}" -gt "0" ]; then',
    '  # Try a merge-tree to detect conflicts without modifying working tree',
    '  MERGE_BASE=$(git merge-base HEAD "$TRACKING" 2>/dev/null)',
    '  if [ -n "$MERGE_BASE" ]; then',
    '    MERGE_OUT=$(git merge-tree "$MERGE_BASE" HEAD "$TRACKING" 2>/dev/null)',
    '    if echo "$MERGE_OUT" | grep -q "<<<<<<"; then',
    '      # Classify: code vs state',
    '      if echo "$MERGE_OUT" | grep -E "\\.(ts|tsx|js|jsx|py|rs|go|md)$" | grep -q "<<<<<<"; then',
    '        echo "code" > "$SEVERITY_FILE"',
    '      else',
    '        echo "state" > "$SEVERITY_FILE"',
    '      fi',
    '    fi',
    '  fi',
    'fi',
    '',
    '# Sync is needed',
    'exit 0',
    '',
  ].join('\n');

  fs.writeFileSync(scriptPath, content, { mode: 0o755 });
}

/**
 * Install smart-fetch.py — agentic web conventions for efficient URL fetching.
 * Checks llms.txt first, then requests Cloudflare text/markdown, then falls back to HTML.
 * Saves ~80% tokens on Cloudflare-hosted sites (~20% of the web).
 */
function installSmartFetch(projectDir: string): void {
  const scriptsDir = path.join(projectDir, '.claude', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  const scriptPath = path.join(scriptsDir, 'smart-fetch.py');

  // Don't overwrite if user has modified it
  if (fs.existsSync(scriptPath)) return;

  const scriptContent = `#!/usr/bin/env python3
"""Smart web fetch with agentic web conventions.

Checks for llms.txt, requests text/markdown from Cloudflare sites,
and falls back to standard HTML fetching. Designed to minimize token
usage when AI agents need web content.

Usage:
    python3 .claude/scripts/smart-fetch.py URL [--check-llms] [--markdown] [--auto] [--raw] [--quiet]

Options:
    --check-llms   Check for /llms.txt and /llms-full.txt before fetching
    --markdown     Request text/markdown via Accept header (Cloudflare sites)
    --auto         Auto-detect: check llms.txt first, then try markdown, then HTML (default)
    --raw          Output raw content only (no metadata headers)
    --quiet        Suppress status messages
    --max-tokens N Warn if estimated tokens exceed N (default: 50000)
"""

import argparse
import json
import sys
import urllib.request
import urllib.error
import urllib.parse
from html.parser import HTMLParser


class SimpleHTMLToText(HTMLParser):
    """Minimal HTML to text converter for when markdown isn't available."""
    def __init__(self):
        super().__init__()
        self._text = []
        self._skip = False

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'nav', 'footer', 'header'):
            self._skip = True

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'nav', 'footer', 'header'):
            self._skip = False
        if tag in ('p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li'):
            self._text.append('\\n')

    def handle_data(self, data):
        if not self._skip:
            self._text.append(data)

    def get_text(self):
        return ''.join(self._text).strip()


def estimate_tokens(text):
    """Rough token estimate: ~4 chars per token for English."""
    return len(text) // 4


def fetch_url(url, accept_header=None, timeout=15):
    """Fetch a URL with optional Accept header."""
    headers = {'User-Agent': 'InstarAgent/1.0 (Claude Code)'}
    if accept_header:
        headers['Accept'] = accept_header

    req = urllib.request.Request(url, headers=headers)
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        content_type = resp.headers.get('Content-Type', '')
        token_hint = resp.headers.get('X-Markdown-Tokens', '')
        body = resp.read().decode('utf-8', errors='replace')
        return {
            'status': resp.status,
            'content_type': content_type,
            'token_hint': token_hint,
            'body': body,
            'url': resp.url,
        }
    except urllib.error.HTTPError as e:
        return {'status': e.code, 'error': str(e), 'body': ''}
    except Exception as e:
        return {'status': 0, 'error': str(e), 'body': ''}


def check_llms_txt(base_url):
    """Check for /llms.txt and /llms-full.txt at the site root."""
    parsed = urllib.parse.urlparse(base_url)
    root = f"{parsed.scheme}://{parsed.netloc}"
    results = {}

    for p in ['/llms.txt', '/llms-full.txt']:
        url = root + p
        result = fetch_url(url)
        if result['status'] == 200 and result['body'].strip():
            results[p] = {
                'url': url,
                'size': len(result['body']),
                'tokens': estimate_tokens(result['body']),
                'content': result['body']
            }

    return results


def smart_fetch(url, mode='auto', max_tokens=50000, raw=False, quiet=False):
    """Fetch content using the smartest available method."""
    log = lambda msg: None if quiet else print(msg, file=sys.stderr)

    # Step 1: Check llms.txt if in auto or check-llms mode
    if mode in ('auto', 'check-llms'):
        log(f"[smart-fetch] Checking for llms.txt at {url}...")
        llms = check_llms_txt(url)
        if llms:
            chosen = llms.get('/llms-full.txt', llms.get('/llms.txt'))
            p = '/llms-full.txt' if '/llms-full.txt' in llms else '/llms.txt'
            log(f"[smart-fetch] Found {p} ({chosen['tokens']} est. tokens)")

            if not raw:
                print(f"# Source: {chosen['url']}")
                print(f"# Method: llms.txt convention")
                print(f"# Estimated tokens: {chosen['tokens']}")
                print("---")
            print(chosen['content'])

            if chosen['tokens'] > max_tokens:
                log(f"[smart-fetch] WARNING: Content exceeds {max_tokens} token limit")
            return True
        else:
            log("[smart-fetch] No llms.txt found")

        if mode == 'check-llms':
            return False

    # Step 2: Try text/markdown (Cloudflare sites)
    if mode in ('auto', 'markdown'):
        log(f"[smart-fetch] Requesting text/markdown from {url}...")
        result = fetch_url(url, accept_header='text/markdown')

        if result['status'] == 200 and 'markdown' in result.get('content_type', ''):
            tokens = int(result['token_hint']) if result['token_hint'] else estimate_tokens(result['body'])
            log(f"[smart-fetch] Got markdown response ({tokens} est. tokens)")

            if not raw:
                print(f"# Source: {result['url']}")
                print(f"# Method: Cloudflare text/markdown")
                if result['token_hint']:
                    print(f"# X-Markdown-Tokens: {result['token_hint']}")
                print(f"# Estimated tokens: {tokens}")
                print("---")
            print(result['body'])

            if tokens > max_tokens:
                log(f"[smart-fetch] WARNING: Content exceeds {max_tokens} token limit")
            return True
        else:
            log("[smart-fetch] Markdown not available, falling back to HTML")

    # Step 3: Standard HTML fetch
    log(f"[smart-fetch] Fetching HTML from {url}...")
    result = fetch_url(url)

    if result['status'] == 200:
        parser = SimpleHTMLToText()
        parser.feed(result['body'])
        text = parser.get_text()
        tokens = estimate_tokens(text)
        log(f"[smart-fetch] Got HTML ({tokens} est. tokens after text extraction)")

        if not raw:
            print(f"# Source: {result['url']}")
            print(f"# Method: HTML (text extracted)")
            print(f"# Estimated tokens: {tokens}")
            print("---")
        print(text)

        if tokens > max_tokens:
            log(f"[smart-fetch] WARNING: Content exceeds {max_tokens} token limit")
        return True
    else:
        log(f"[smart-fetch] Fetch failed: {result.get('error', f'HTTP {result[\"status\"]}')}")
        return False


def main():
    parser = argparse.ArgumentParser(description='Smart web fetch with agentic conventions')
    parser.add_argument('url', help='URL to fetch')
    parser.add_argument('--check-llms', action='store_true', help='Only check for llms.txt')
    parser.add_argument('--markdown', action='store_true', help='Request text/markdown only')
    parser.add_argument('--auto', action='store_true', help='Auto-detect best method (default)')
    parser.add_argument('--raw', action='store_true', help='Output raw content only')
    parser.add_argument('--quiet', action='store_true', help='Suppress status messages')
    parser.add_argument('--max-tokens', type=int, default=50000, help='Token warning threshold')
    args = parser.parse_args()

    if args.check_llms:
        mode = 'check-llms'
    elif args.markdown:
        mode = 'markdown'
    else:
        mode = 'auto'

    success = smart_fetch(args.url, mode=mode, max_tokens=args.max_tokens, raw=args.raw, quiet=args.quiet)
    sys.exit(0 if success else 1)


if __name__ == '__main__':
    main()
`;

  fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
}

/**
 * Install serendipity-capture.sh — Helper script for sub-agents to capture
 * valuable out-of-scope findings during focused tasks.
 *
 * Reads the script from src/templates/scripts/serendipity-capture.sh rather
 * than embedding it inline (345 lines). Handles JSON construction, HMAC signing,
 * atomic writes, rate limiting, secret scanning, and patch file validation.
 */
function installSerendipityCapture(projectDir: string): void {
  const scriptsDir = path.join(projectDir, '.instar', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  const scriptPath = path.join(scriptsDir, 'serendipity-capture.sh');

  // Resolve template from package directory
  // In dev: src/commands/ → ../../src/templates/scripts/serendipity-capture.sh
  // In dist: dist/commands/ → ../templates/scripts/serendipity-capture.sh
  const modDir = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    path.resolve(modDir, '..', 'templates', 'scripts', 'serendipity-capture.sh'),
    path.resolve(modDir, '..', '..', 'src', 'templates', 'scripts', 'serendipity-capture.sh'),
  ];

  let scriptContent = '';
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      scriptContent = fs.readFileSync(candidate, 'utf-8');
      break;
    }
  }

  if (!scriptContent) {
    // Non-fatal: skip if template not found (e.g., during development)
    return;
  }

  fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
}

function installClaudeSettings(projectDir: string): void {
  const claudeDir = path.join(projectDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  const settingsPath = path.join(claudeDir, 'settings.json');

  // Don't overwrite existing settings — merge hooks in
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      // Start fresh if corrupted
    }
  }

  // Add hook configurations — all three sections for full agent support
  if (!settings.hooks) {
    settings.hooks = {};
  }
  const hooks = settings.hooks as Record<string, unknown[]>;

  // All instar-managed hooks for PreToolUse/Bash
  const instarBashHooks = [
    {
      type: 'command',
      command: 'bash .instar/hooks/instar/dangerous-command-guard.sh "$TOOL_INPUT"',
      blocking: true,
    },
    {
      type: 'command',
      command: 'bash .instar/hooks/instar/grounding-before-messaging.sh "$TOOL_INPUT"',
      blocking: false,
    },
    {
      type: 'command',
      command: 'node .instar/hooks/instar/deferral-detector.js',
      timeout: 5000,
    },
    {
      type: 'command',
      command: 'node .instar/hooks/instar/external-communication-guard.js',
      timeout: 5000,
    },
    {
      type: 'command',
      command: 'node .instar/hooks/instar/post-action-reflection.js',
      timeout: 5000,
    },
  ];

  // External operation gate hook — intercepts MCP tool calls for safety evaluation
  const instarMcpHooks = [
    {
      type: 'command',
      command: 'node .instar/hooks/instar/external-operation-gate.js',
      blocking: true,
      timeout: 5000,
    },
  ];

  // PreToolUse: merge instar hooks into existing or create fresh
  if (!hooks.PreToolUse) {
    hooks.PreToolUse = [
      { matcher: 'Bash', hooks: instarBashHooks },
      { matcher: 'mcp__.*', hooks: instarMcpHooks },
    ];
  } else {
    const preToolUse = hooks.PreToolUse as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;

    // Find existing Bash matcher or create one
    let bashEntry = preToolUse.find(e => e.matcher === 'Bash');
    if (!bashEntry) {
      bashEntry = { matcher: 'Bash', hooks: [] };
      preToolUse.push(bashEntry);
    }
    if (!bashEntry.hooks) bashEntry.hooks = [];
    // Add any instar hooks not already present (by command string)
    const existingBashCommands = new Set(bashEntry.hooks.map(h => h.command));
    for (const hook of instarBashHooks) {
      if (!existingBashCommands.has(hook.command)) {
        bashEntry.hooks.push(hook);
      }
    }

    // Find existing MCP matcher or create one
    let mcpEntry = preToolUse.find(e => e.matcher === 'mcp__.*');
    if (!mcpEntry) {
      mcpEntry = { matcher: 'mcp__.*', hooks: [] };
      preToolUse.push(mcpEntry);
    }
    if (!mcpEntry.hooks) mcpEntry.hooks = [];
    const existingMcpCommands = new Set(mcpEntry.hooks.map(h => h.command));
    for (const hook of instarMcpHooks) {
      if (!existingMcpCommands.has(hook.command)) {
        mcpEntry.hooks.push(hook);
      }
    }
  }

  // SessionStart: identity injection on all lifecycle events
  // Uses the correct Claude Code hook type (not PostToolUse or Notification)
  // The session-start.sh hook handles event routing internally via CLAUDE_HOOK_MATCHER
  const sessionStartHook = {
    type: 'command',
    command: 'bash .instar/hooks/instar/session-start.sh',
    timeout: 5,
  };

  if (!hooks.SessionStart) {
    hooks.SessionStart = [
      { matcher: 'startup', hooks: [sessionStartHook] },
      { matcher: 'resume', hooks: [sessionStartHook] },
      { matcher: 'compact', hooks: [sessionStartHook] },
    ];
  } else {
    // Merge: ensure all matchers are covered
    const sessionStart = hooks.SessionStart as Array<{ matcher?: string; hooks?: unknown[] }>;
    for (const matcher of ['startup', 'resume', 'compact']) {
      if (!sessionStart.some(e => e.matcher === matcher)) {
        sessionStart.push({ matcher, hooks: [sessionStartHook] });
      }
    }
  }

  // Clean up legacy hooks from older versions
  // PostToolUse with empty matcher for session-start was noisy (fired every tool use)
  if (hooks.PostToolUse) {
    const postToolUse = hooks.PostToolUse as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
    const filtered = postToolUse.filter(e => {
      if (e.matcher === '' && e.hooks?.some(h => h.command?.includes('session-start.sh'))) {
        return false; // Remove legacy session-start from PostToolUse
      }
      return true;
    });
    if (filtered.length === 0) {
      delete hooks.PostToolUse;
    } else {
      hooks.PostToolUse = filtered;
    }
  }

  // Remove legacy Notification hook for compaction (now handled by SessionStart)
  if (hooks.Notification) {
    const notification = hooks.Notification as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
    const filtered = notification.filter(e => {
      if (e.matcher === 'compact' && e.hooks?.some(h => h.command?.includes('compaction-recovery.sh'))) {
        return false; // Remove legacy compaction from Notification
      }
      return true;
    });
    if (filtered.length === 0) {
      delete hooks.Notification;
    } else {
      hooks.Notification = filtered;
    }
  }

  // PostToolUse: scope coherence collector tracks implementation depth
  const scopeCollectorHook = {
    type: 'command',
    command: 'node .instar/hooks/instar/scope-coherence-collector.js',
    timeout: 5000,
  };

  if (!hooks.PostToolUse) {
    hooks.PostToolUse = [];
  }
  const postToolUse = hooks.PostToolUse as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;

  // Add collector + claim intercept to Edit, Write, Bash matchers
  // (scope collector also added to Read and Skill)
  const claimInterceptHook = {
    type: 'command',
    command: 'node .instar/hooks/instar/claim-intercept.js',
    timeout: 5000,
  };

  for (const matcher of ['Edit', 'Write', 'Bash', 'Read', 'Skill']) {
    let entry = postToolUse.find(e => e.matcher === matcher);
    if (!entry) {
      entry = { matcher, hooks: [] };
      postToolUse.push(entry);
    }
    if (!entry.hooks) entry.hooks = [];
    const existingCommands = new Set(entry.hooks.map(h => h.command));
    if (!existingCommands.has(scopeCollectorHook.command)) {
      entry.hooks.push(scopeCollectorHook);
    }
    // Claim intercept only on content-producing tools (not Read/Skill)
    if (['Edit', 'Write', 'Bash'].includes(matcher)) {
      if (!existingCommands.has(claimInterceptHook.command)) {
        entry.hooks.push(claimInterceptHook);
      }
    }
  }

  // Stop: response review pipeline — Coherence Gate LLM-powered review
  const responseReviewHook = {
    type: 'command',
    command: 'node .instar/hooks/instar/response-review.js',
    timeout: 10000,
  };

  // Stop: scope coherence checkpoint fires the zoom-out prompt
  const scopeCheckpointHook = {
    type: 'command',
    command: 'node .instar/hooks/instar/scope-coherence-checkpoint.js',
    timeout: 10000,
  };

  // Stop: claim intercept response checks direct text for false claims
  const claimInterceptResponseHook = {
    type: 'command',
    command: 'node .instar/hooks/instar/claim-intercept-response.js',
    timeout: 10000,
  };

  if (!hooks.Stop) {
    hooks.Stop = [];
  }
  const stopHooks = hooks.Stop as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;

  // Register response review (first — catches quality issues before other checks)
  const hasResponseReview = stopHooks.some(e =>
    e.hooks?.some(h => h.command?.includes('response-review.js')),
  );
  if (!hasResponseReview) {
    stopHooks.unshift({ matcher: '', hooks: [responseReviewHook] });
  }

  // Register claim intercept response (before scope checkpoint — catch claims first)
  const hasClaimIntercept = stopHooks.some(e =>
    e.hooks?.some(h => h.command?.includes('claim-intercept-response.js')),
  );
  if (!hasClaimIntercept) {
    stopHooks.unshift({ matcher: '', hooks: [claimInterceptResponseHook] });
  }

  // Register scope coherence checkpoint
  const hasCheckpoint = stopHooks.some(e =>
    e.hooks?.some(h => h.command?.includes('scope-coherence-checkpoint.js')),
  );
  if (!hasCheckpoint) {
    stopHooks.push({ matcher: '', hooks: [scopeCheckpointHook] });
  }

  // Remove stale mcpServers from settings.json — MCP servers belong in
  // ~/.claude.json (local scope) or .mcp.json, NOT .claude/settings.json
  if (settings.mcpServers) {
    delete settings.mcpServers;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  // MCP Servers: Register Playwright in the correct locations
  // Claude Code reads MCP servers from ~/.claude.json and .mcp.json, NOT .claude/settings.json
  registerPlaywrightMcp(projectDir);
}

/**
 * Register Playwright MCP server in the correct locations for Claude Code.
 *
 * Claude Code reads MCP servers from:
 *   1. ~/.claude.json — local scope (projects["/path"].mcpServers) — no trust dialog
 *   2. .mcp.json in project root — project scope — requires trust acceptance
 *
 * We register in both for robustness.
 */
function registerPlaywrightMcp(projectDir: string): void {
  const absDir = path.resolve(projectDir);

  // ── 1. Register in ~/.claude.json at local scope ──
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  try {
    let claudeJson: Record<string, unknown> = {};
    if (fs.existsSync(claudeJsonPath)) {
      claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
    }

    if (!claudeJson.projects || typeof claudeJson.projects !== 'object') {
      claudeJson.projects = {};
    }
    const projects = claudeJson.projects as Record<string, Record<string, unknown>>;

    if (!projects[absDir]) {
      projects[absDir] = {};
    }
    const projectEntry = projects[absDir];

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

    projectEntry.hasTrustDialogAccepted = true;

    const tmpPath = `${claudeJsonPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(claudeJson, null, 2));
    fs.renameSync(tmpPath, claudeJsonPath);
  } catch {
    // Non-fatal
  }

  // ── 2. Create .mcp.json in project root ──
  const mcpJsonPath = path.join(projectDir, '.mcp.json');
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
