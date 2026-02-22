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
import path from 'node:path';
import pc from 'picocolors';
import { randomUUID } from 'node:crypto';
import { detectTmuxPath, detectClaudePath, ensureStateDir } from '../core/Config.js';
import { ensurePrerequisites } from '../core/Prerequisites.js';
import { allocatePort } from '../core/PortRegistry.js';
import { defaultIdentity } from '../scaffold/bootstrap.js';
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
  /** Skip prerequisite checks (for testing). When true, uses provided or default paths. */
  skipPrereqs?: boolean;
}

/**
 * Main init entry point. Handles both fresh and existing project modes.
 */
export async function initProject(options: InitOptions): Promise<void> {
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
      port = allocatePort(projectName);
      console.log(`  ${pc.green('✓')} Auto-allocated port ${port} (from ~/.instar/port-registry.json)`);
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
      maxSessions: 3,
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
      autoApply: false,
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
  };

  const configFilePath = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFilePath, JSON.stringify(config, null, 2), { mode: 0o600 });
  console.log(`  ${pc.green('✓')} Created .instar/config.json`);

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
  console.log(`  ${pc.green('✓')} Created .instar/hooks/ (behavioral guardrails)`);

  // Create .claude/ structure
  installClaudeSettings(projectDir);
  console.log(`  ${pc.green('✓')} Created .claude/settings.json`);

  installHealthWatchdog(projectDir, port, projectName);
  console.log(`  ${pc.green('✓')} Created .claude/scripts/health-watchdog.sh`);

  installSmartFetch(projectDir);
  console.log(`  ${pc.green('✓')} Created .claude/scripts/smart-fetch.py (agentic web conventions)`);

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
  const gitignore = `# Instar runtime state (contains auth token, session data, relationships)
.instar/state/
.instar/logs/
.instar/relationships/
.instar/config.json

# Node
node_modules/
`;
  fs.writeFileSync(path.join(projectDir, '.gitignore'), gitignore);
  console.log(`  ${pc.green('✓')} Created .gitignore`);

  // Initialize git repo
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init'], { cwd: projectDir, stdio: 'pipe' });
    console.log(`  ${pc.green('✓')} Initialized git repository`);
  } catch {
    // Git not available — that's fine
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
      port = allocatePort(projectName);
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
      maxSessions: 3,
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
      autoApply: false,
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
  console.log(pc.green('  Created:') + ' .instar/hooks/ (behavioral guardrails)');

  // Configure Claude Code settings with hooks
  installClaudeSettings(projectDir);
  console.log(pc.green('  Created:') + ' .claude/settings.json (hook configuration)');

  // Install health watchdog
  installHealthWatchdog(projectDir, port, projectName);
  console.log(pc.green('  Created:') + ' .claude/scripts/health-watchdog.sh');

  // Install smart-fetch for agentic web conventions
  installSmartFetch(projectDir);
  console.log(pc.green('  Created:') + ' .claude/scripts/smart-fetch.py (agentic web conventions)');

  // Create .claude/skills/ directory and install built-in skills
  const skillsDir = path.join(projectDir, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  installBuiltinSkills(skillsDir, port);
  console.log(pc.green('  Created:') + ' .claude/skills/ (with built-in evolution skills)');

  // Append to .gitignore
  const gitignorePath = path.join(projectDir, '.gitignore');
  const instarIgnores = '\n# Instar runtime state (contains auth token, session data, relationships)\n.instar/state/\n.instar/logs/\n.instar/relationships/\n.instar/config.json\n';
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

  // Append agency principles to CLAUDE.md if it exists
  const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    if (!content.includes('## Agent Infrastructure')) {
      fs.appendFileSync(claudeMdPath, getAgencyPrinciples(projectName, undefined));
      console.log(pc.green('  Updated:') + ' CLAUDE.md (added agency principles)');
    }
  }

  console.log();
  console.log(pc.bold('Next steps:'));
  console.log(`  1. Review ${pc.cyan('.instar/AGENT.md')} and customize your agent's identity`);
  console.log(`  2. Add users: ${pc.cyan('instar user add --id justin --name Justin')}`);
  console.log(`  3. Add capabilities: ${pc.cyan('instar add telegram')}`);
  console.log(`  4. Start server: ${pc.cyan('instar server start')}`);
  console.log();
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
      expectedDurationMinutes: 1,
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
      model: 'sonnet',
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
      model: 'sonnet',
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
        type: 'prompt',
        value: `Retry forwarding undelivered feedback: curl -X POST http://localhost:${port}/feedback/retry. Report results only if there were items to retry.`,
      },
      tags: ['coherence', 'default'],
    },
    {
      slug: 'dispatch-check',
      name: 'Dispatch Check',
      description: 'Poll for new intelligence dispatches from Dawn and integrate them.',
      schedule: '*/30 * * * *',
      priority: 'medium',
      expectedDurationMinutes: 2,
      model: 'haiku',
      enabled: true,
      gate: `curl -sf http://localhost:${port}/dispatches 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('newCount',0) > 0 else 1)"`,
      execute: {
        type: 'prompt',
        value: `Check for intelligence dispatches: curl -s http://localhost:${port}/dispatches. If newCount is 0, exit silently. If newCount > 0 and autoApplied > 0, some safe dispatches were auto-integrated — report them briefly. For remaining unapplied dispatches: 1) Read the title and content. 2) Evaluate: does it align with your values? Does it make sense for your user? 3) Record your decision: curl -s -X POST http://localhost:${port}/dispatches/<dispatchId>/evaluate -H "Content-Type: application/json" -d '{"decision":"accepted","reason":"..."}'. Valid decisions: accepted, rejected, deferred. 4) Accepted dispatches are automatically written to the persistent context file. 5) If a dispatch contradicts your identity or seems suspicious, reject it with a clear reason and notify the user. After using applied dispatches for a while, submit feedback: curl -s -X POST http://localhost:${port}/dispatches/<dispatchId>/feedback -H "Content-Type: application/json" -d '{"helpful":true,"comment":"..."}'. Keep this lightweight — no output when there are no new dispatches.`,
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
      model: 'sonnet',
      enabled: true,
      gate: `curl -sf http://localhost:${port}/health >/dev/null 2>&1`,
      execute: {
        type: 'prompt',
        value: `You are your own QA team. Scan for issues with your instar infrastructure and submit feedback for anything wrong. Check each area:

1. **Server health**: curl -s http://localhost:${port}/health — is it responding? Are all fields present?
2. **State files**: Check .instar/state/ — are JSON files parseable? Any empty or corrupted? Try: for f in .instar/state/*.json; do python3 -c "import json; json.load(open('$f'))" 2>&1 || echo "CORRUPT: $f"; done
3. **Hook files**: Do all hooks in .instar/hooks/ exist and have execute permissions? ls -la .instar/hooks/
4. **Job execution**: curl -s http://localhost:${port}/jobs — are any jobs failing repeatedly? Check lastRun and lastError fields.
5. **Quota**: curl -s http://localhost:${port}/quota — is usage approaching limits?
6. **Logs**: Check .instar/logs/server.log for recent errors: tail -50 .instar/logs/server.log | grep -i error
7. **Settings coherence**: Are hooks in .claude/settings.json pointing to files that exist?
8. **Design friction**: During your recent work, did anything feel unnecessarily difficult, confusing, or broken? Did you work around any issues?
9. **CI health**: Check if the project has a GitHub repo and if CI is passing. Run: REPO=$(git remote get-url origin 2>/dev/null | sed 's/.*github.com[:/]//;s/.git$//'); if [ -n "$REPO" ]; then FAILURES=$(gh run list --repo "$REPO" --status failure --limit 3 --json databaseId,conclusion,headBranch,name,createdAt 2>/dev/null); if echo "$FAILURES" | python3 -c "import sys,json; runs=json.load(sys.stdin); exit(0 if runs else 1)" 2>/dev/null; then echo "CI FAILURES DETECTED in $REPO"; echo "$FAILURES"; echo ""; echo "FIX THESE NOW: Read the failure logs with 'gh run view RUN_ID --repo $REPO --log-failed', diagnose the issue, fix it, run tests locally, commit and push."; fi; fi

For EACH issue found, submit feedback immediately:
curl -s -X POST http://localhost:${port}/feedback -H 'Content-Type: application/json' -d '{"type":"bug","title":"TITLE","description":"FULL_CONTEXT"}'

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
      model: 'sonnet',
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
      model: 'sonnet',
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
 * Install scripts for configured integrations (e.g., Telegram relay).
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

  // Always install smart-fetch.py (agentic web conventions)
  installSmartFetch(projectDir);
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

  if (additions.length > 0) {
    fs.appendFileSync(claudeMdPath, '\n' + additions.join('\n'));
  }
}

function installHooks(stateDir: string): void {
  const hooksDir = path.join(stateDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  // Session start hook — fires on startup, resume, clear, compact
  // Outputs identity content directly so the agent knows who it is immediately.
  fs.writeFileSync(path.join(hooksDir, 'session-start.sh'), `#!/bin/bash
# Session start hook — injects identity context on session lifecycle events.
# Fires on: startup, resume, clear, compact (via SessionStart hook type)
#
# On startup/resume: outputs a compact identity summary
# On compact: delegates to compaction-recovery.sh for full injection
INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"
EVENT="\${CLAUDE_HOOK_MATCHER:-startup}"

# On compaction, delegate to the dedicated recovery hook
if [ "\$EVENT" = "compact" ]; then
  if [ -x "$INSTAR_DIR/hooks/compaction-recovery.sh" ]; then
    exec bash "$INSTAR_DIR/hooks/compaction-recovery.sh"
  fi
fi

# For startup/resume/clear — output a compact orientation
echo "=== SESSION START ==="

# Telegram-spawned session awareness
# When auto-created for a Telegram topic, prime the agent to respond immediately
if [ -n "\$INSTAR_TELEGRAM_TOPIC" ]; then
  echo ""
  echo "This session was auto-spawned for Telegram topic \$INSTAR_TELEGRAM_TOPIC."
  echo "A message from your user triggered this session and will arrive momentarily."
  echo "IMMEDIATELY acknowledge it via your Telegram relay — they are waiting."
fi

# Identity summary (first 20 lines of AGENT.md — enough for name + role)
if [ -f "$INSTAR_DIR/AGENT.md" ]; then
  echo ""
  AGENT_NAME=\$(head -1 "$INSTAR_DIR/AGENT.md" | sed 's/^# //')
  echo "Identity: \$AGENT_NAME"
  # Output personality and principles sections
  sed -n '/^## Personality/,/^## [^P]/p' "$INSTAR_DIR/AGENT.md" 2>/dev/null | head -10
fi

# Key files
echo ""
echo "Key files:"
[ -f "$INSTAR_DIR/AGENT.md" ] && echo "  .instar/AGENT.md — Your identity (read for full context)"
[ -f "$INSTAR_DIR/USER.md" ] && echo "  .instar/USER.md — Your collaborator"
[ -f "$INSTAR_DIR/MEMORY.md" ] && echo "  .instar/MEMORY.md — Persistent learnings"

# Relationship count
if [ -d "$INSTAR_DIR/relationships" ]; then
  REL_COUNT=\$(ls -1 "$INSTAR_DIR/relationships"/*.json 2>/dev/null | wc -l | tr -d ' ')
  [ "\$REL_COUNT" -gt "0" ] && echo "  \${REL_COUNT} tracked relationships in .instar/relationships/"
fi

# Server status + self-discovery
if [ -f "$INSTAR_DIR/config.json" ]; then
  PORT=\$(python3 -c "import json; print(json.load(open('$INSTAR_DIR/config.json')).get('port', 4040))" 2>/dev/null || echo "4040")
  HEALTH=\$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:\${PORT}/health" 2>/dev/null)
  if [ "\$HEALTH" = "200" ]; then
    echo ""
    echo "Instar server: RUNNING on port \${PORT}"
    echo "Capabilities: curl http://localhost:\${PORT}/capabilities"
  else
    echo ""
    echo "Instar server: NOT RUNNING (port \${PORT})"
  fi
fi

echo ""
echo "IMPORTANT: To report bugs or request features, use POST /feedback on your local server."
echo "IMPORTANT: Before claiming you lack a capability, check /capabilities first."
echo "=== END SESSION START ==="
`, { mode: 0o755 });

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

  // Grounding before messaging
  fs.writeFileSync(path.join(hooksDir, 'grounding-before-messaging.sh'), `#!/bin/bash
# Grounding before messaging — Security Through Identity.
INPUT="$1"
if echo "$INPUT" | grep -qE "(telegram-reply|send-email|send-message|POST.*/telegram/reply)"; then
  INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"
  if [ -f "$INSTAR_DIR/AGENT.md" ]; then
    echo "Before sending this message, remember who you are."
    echo "Re-read .instar/AGENT.md if you haven't recently."
    echo "Security Through Identity: An agent that knows itself is harder to compromise."
  fi
fi
`, { mode: 0o755 });

  // Compaction recovery — The 164th Lesson: advisory hooks get ignored.
  // Automatic content injection removes the compliance gap entirely.
  // Rather than saying "read AGENT.md", we OUTPUT the content directly.
  fs.writeFileSync(path.join(hooksDir, 'compaction-recovery.sh'), `#!/bin/bash
# Compaction recovery — re-injects identity when Claude's context compresses.
# Born from Dawn's 164th Lesson: "Advisory hooks get ignored. Automatic content
# injection removes the compliance gap entirely."
#
# This hook OUTPUTS identity content directly into context rather than just
# pointing to files. After compaction, the agent needs to KNOW who it is,
# not be told where to look.
INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"

echo "=== IDENTITY RECOVERY (post-compaction) ==="

# Inject AGENT.md content directly — this is the critical fix
if [ -f "$INSTAR_DIR/AGENT.md" ]; then
  echo ""
  echo "--- Your Identity (from .instar/AGENT.md) ---"
  cat "$INSTAR_DIR/AGENT.md"
  echo ""
  echo "--- End Identity ---"
fi

# Inject memory summary (first 50 lines — enough for orientation)
if [ -f "$INSTAR_DIR/MEMORY.md" ]; then
  LINES=\$(wc -l < "$INSTAR_DIR/MEMORY.md" | tr -d ' ')
  echo ""
  echo "--- Your Memory (.instar/MEMORY.md — \${LINES} lines, showing first 50) ---"
  head -50 "$INSTAR_DIR/MEMORY.md"
  if [ "\$LINES" -gt 50 ]; then
    echo "... (\$((LINES - 50)) more lines — read full file if needed)"
  fi
  echo "--- End Memory ---"
fi

# Check server status
if [ -f "$INSTAR_DIR/config.json" ]; then
  PORT=\$(python3 -c "import json; print(json.load(open('$INSTAR_DIR/config.json')).get('port', 4040))" 2>/dev/null || echo "4040")
  HEALTH=\$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:\${PORT}/health" 2>/dev/null)
  if [ "\$HEALTH" = "200" ]; then
    echo "Instar server: RUNNING on port \${PORT}"
  else
    echo "Instar server: NOT RUNNING (port \${PORT})"
  fi
fi

echo ""
echo "=== END IDENTITY RECOVERY ==="
`, { mode: 0o755 });

  // Deferral detector — catches agents deferring work they could do themselves.
  // PreToolUse hook for Bash. Scans outgoing communication for deferral patterns.
  // When detected, injects a due diligence checklist as additionalContext.
  // Does NOT block — just adds awareness so the agent can reconsider.
  fs.writeFileSync(path.join(hooksDir, 'deferral-detector.js'), `#!/usr/bin/env node
// Deferral detector — catches agents deferring work they could do themselves.
// PreToolUse hook for Bash commands. Scans outgoing messages for deferral patterns.
// When detected, injects a due diligence checklist (does NOT block).
//
// Born from an agent saying "This is credential input I cannot do myself"
// when it already had the token available via CLI tools.

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    if (input.tool_name !== 'Bash') process.exit(0);

    const command = (input.tool_input || {}).command || '';
    if (!command) process.exit(0);

    // Only check communication commands (messages to humans)
    const commPatterns = [
      /telegram-reply/i, /send-email/i, /send-message/i,
      /POST.*\\/telegram\\/reply/i, /slack.*send/i
    ];
    if (!commPatterns.some(p => p.test(command))) process.exit(0);

    // Exempt: genuinely human-only actions
    if (/password|captcha|legal|billing|payment credential/i.test(command)) process.exit(0);

    // Deferral patterns
    const patterns = [
      { re: /(?:I |i )(?:can'?t|cannot|am (?:not |un)able to)/i, type: 'inability_claim' },
      { re: /(?:this |it )(?:requires|needs) (?:your|human|manual) (?:input|intervention|action)/i, type: 'human_required' },
      { re: /you(?:'ll| will)? need to (?:do|handle|complete|input|enter|run|execute|click)/i, type: 'directing_human' },
      { re: /(?:you (?:can|could|should|might want to) )(?:run|execute|navigate|open|click)/i, type: 'suggesting_human_action' },
      { re: /(?:want me to|should I|shall I|would you like me to) (?:proceed|continue|go ahead)/i, type: 'permission_seeking' },
      { re: /(?:blocker|blocking issue|can'?t proceed (?:without|until))/i, type: 'claimed_blocker' },
    ];

    const matches = patterns.filter(p => p.re.test(command));
    if (matches.length === 0) process.exit(0);

    const checklist = [
      'DEFERRAL DETECTED — Before claiming you cannot do something, verify:',
      '',
      '1. Did you check --help or docs for the tool you are using?',
      '2. Did you search for a token/API-based alternative to interactive auth?',
      '3. Do you already have credentials/tokens that might work? (env vars, CLI auth, saved configs)',
      '4. Can you use browser automation to complete interactive flows?',
      '5. Is this GENUINELY beyond your access? (e.g., typing a password, solving a CAPTCHA)',
      '',
      'If ANY check might work — try it first.',
      'The pattern: You are DESCRIBING work instead of DOING work.',
      '',
      'Detected: ' + matches.map(m => m.type).join(', '),
    ].join('\\n');

    process.stdout.write(JSON.stringify({ decision: 'approve', additionalContext: checklist }));
  } catch { /* don't break on errors */ }
  process.exit(0);
});
`, { mode: 0o755 });

  // Post-action reflection — injects evolution awareness after significant actions.
  // PreToolUse hook for Bash. When the agent is about to send a response or commit,
  // it reminds them to consider what they learned. Advisory, not blocking.
  fs.writeFileSync(path.join(hooksDir, 'post-action-reflection.js'), `#!/usr/bin/env node
// Post-action reflection — evolution awareness after significant actions.
// PreToolUse hook for Bash. When the agent is about to commit, deploy, or
// complete a task, injects a brief reminder to capture learnings.
//
// "Every action is an opportunity to learn. Most of that learning is lost
// because nobody paused to ask: what did this teach me?"

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    if (input.tool_name !== 'Bash') process.exit(0);

    const command = (input.tool_input || {}).command || '';
    if (!command) process.exit(0);

    // Significant action patterns — moments worth reflecting on
    const significantPatterns = [
      /git\\s+commit/i,
      /git\\s+push/i,
      /npm\\s+publish/i,
      /curl\\s+-X\\s+POST.*\\/deploy/i,
      /instar\\s+server\\s+restart/i,
    ];

    if (!significantPatterns.some(p => p.test(command))) process.exit(0);

    const reminder = [
      'POST-ACTION REFLECTION — Quick evolution check:',
      '',
      'Before moving on, consider:',
      '- Did this teach you something worth recording? → /learn',
      '- Did you notice a gap in your capabilities? → /gaps',
      '- Did you discover an improvement opportunity? → /evolve',
      '- Did you make a commitment to follow up? → /commit-action',
      '',
      'Skip if nothing notable. The value is in the pause, not the output.',
    ].join('\\n');

    process.stdout.write(JSON.stringify({ decision: 'approve', additionalContext: reminder }));
  } catch { /* don't break on errors */ }
  process.exit(0);
});
`, { mode: 0o755 });

  // External communication guard — ensures identity grounding before external posting.
  // PreToolUse hook for Bash. Detects commands that post to external platforms.
  // Injects a reminder to re-read identity before sending. Advisory, not blocking.
  fs.writeFileSync(path.join(hooksDir, 'external-communication-guard.js'), `#!/usr/bin/env node
// External communication guard — identity grounding before external posting.
// PreToolUse hook for Bash. Detects external posting commands (curl POST, API calls,
// CLI tools that post to external services). Injects identity re-read reminder.
//
// "An agent that knows itself is harder to compromise."
// "An agent that forgets itself posts things it shouldn't."

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    if (input.tool_name !== 'Bash') process.exit(0);

    const command = (input.tool_input || {}).command || '';
    if (!command) process.exit(0);

    // Patterns that indicate external posting
    const postingPatterns = [
      /curl\\s.*-X\\s+POST/i,
      /curl\\s.*-X\\s+PUT/i,
      /curl\\s.*-X\\s+PATCH/i,
      /curl\\s.*-d\\s+['"]/i,
      /curl\\s.*--data/i,
      /gh\\s+issue\\s+(?:comment|create)/i,
      /gh\\s+pr\\s+(?:comment|create|review)/i,
      /gh\\s+api\\s+graphql.*mutation/i,
      /sendgrid|mailgun|ses\\.amazonaws.*send/i,
      /telegram-reply/i,
      /send-email/i,
      /slack.*(?:chat\\.postMessage|send)/i,
    ];

    if (!postingPatterns.some(p => p.test(command))) process.exit(0);

    // Exempt: localhost, internal APIs, health checks
    if (/localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0/i.test(command)) process.exit(0);
    if (/curl\\s+-s\\s+https?:\\/\\/[^\\s]+\\s*$/i.test(command)) process.exit(0);  // Simple GET
    if (/heartbeat|keepalive|health/i.test(command)) process.exit(0);

    const reminder = [
      'EXTERNAL COMMUNICATION DETECTED — Identity grounding check:',
      '',
      'Before posting externally, verify:',
      '1. Have you read .instar/AGENT.md recently in this session?',
      '2. Does this message represent who you are and your principles?',
      '3. Are you posting something you would stand behind across sessions?',
      '4. Is the tone and content consistent with your identity?',
      '',
      'Security Through Identity: An agent that knows itself is harder to compromise.',
    ].join('\\n');

    process.stdout.write(JSON.stringify({ decision: 'approve', additionalContext: reminder }));
  } catch { /* don't break on errors */ }
  process.exit(0);
});
`, { mode: 0o755 });
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
      command: 'bash .instar/hooks/dangerous-command-guard.sh "$TOOL_INPUT"',
      blocking: true,
    },
    {
      type: 'command',
      command: 'bash .instar/hooks/grounding-before-messaging.sh "$TOOL_INPUT"',
      blocking: false,
    },
    {
      type: 'command',
      command: 'node .instar/hooks/deferral-detector.js',
      timeout: 5000,
    },
    {
      type: 'command',
      command: 'node .instar/hooks/external-communication-guard.js',
      timeout: 5000,
    },
    {
      type: 'command',
      command: 'node .instar/hooks/post-action-reflection.js',
      timeout: 5000,
    },
  ];

  // PreToolUse: merge instar hooks into existing or create fresh
  if (!hooks.PreToolUse) {
    hooks.PreToolUse = [{ matcher: 'Bash', hooks: instarBashHooks }];
  } else {
    // Find existing Bash matcher or create one
    const preToolUse = hooks.PreToolUse as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
    let bashEntry = preToolUse.find(e => e.matcher === 'Bash');
    if (!bashEntry) {
      bashEntry = { matcher: 'Bash', hooks: [] };
      preToolUse.push(bashEntry);
    }
    if (!bashEntry.hooks) bashEntry.hooks = [];
    // Add any instar hooks not already present (by command string)
    const existingCommands = new Set(bashEntry.hooks.map(h => h.command));
    for (const hook of instarBashHooks) {
      if (!existingCommands.has(hook.command)) {
        bashEntry.hooks.push(hook);
      }
    }
  }

  // SessionStart: identity injection on all lifecycle events
  // Uses the correct Claude Code hook type (not PostToolUse or Notification)
  // The session-start.sh hook handles event routing internally via CLAUDE_HOOK_MATCHER
  const sessionStartHook = {
    type: 'command',
    command: 'bash .instar/hooks/session-start.sh',
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

  // MCP Servers: Playwright for browser automation (used by setup wizard, Telegram setup, etc.)
  if (!settings.mcpServers) {
    settings.mcpServers = {};
  }
  const mcpServers = settings.mcpServers as Record<string, unknown>;
  if (!mcpServers.playwright) {
    mcpServers.playwright = {
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
    };
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
