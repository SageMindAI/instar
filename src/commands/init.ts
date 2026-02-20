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

  const port = options.port || 4040;

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
    dispatches: {
      enabled: true,
      dispatchUrl: 'https://dawn.bot-me.ai/api/instar/dispatches',
      dispatchFile: path.join(stateDir, 'state', 'dispatches.json'),
      autoApply: false,
    },
    updates: {
      autoApply: false,
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
  console.log(`  ├── .claude/               ${pc.dim('Claude Code settings')}`);
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
  const port = options.port || 4040;

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
    dispatches: {
      enabled: true,
      dispatchUrl: 'https://dawn.bot-me.ai/api/instar/dispatches',
      dispatchFile: path.join(stateDir, 'state', 'dispatches.json'),
      autoApply: false,
    },
    updates: {
      autoApply: false,
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

**Job Scheduler** — You can run tasks on a schedule. Jobs are defined in \`.instar/jobs.json\`.
- View jobs: \`curl http://localhost:${port}/jobs\`
- Trigger a job: \`curl -X POST http://localhost:${port}/jobs/SLUG/trigger\`
- **Create new jobs**: Edit \`.instar/jobs.json\`. Each job has a slug, schedule (cron), priority, and either a prompt (Claude session), script (shell command), or skill.

**Sessions** — You can spawn and manage Claude Code sessions.
- List: \`curl http://localhost:${port}/sessions\`
- Spawn: \`curl -X POST http://localhost:${port}/sessions/spawn -H 'Content-Type: application/json' -d '{"name":"task","prompt":"do something"}'\`

**Scripts** — Create shell/python scripts in \`.claude/scripts/\` for reusable capabilities.

### Self-Discovery (Know Before You Claim)

Before EVER saying "I don't have", "I can't", or "this isn't available" — check what actually exists:

\`\`\`bash
curl http://localhost:${port}/capabilities
\`\`\`

This returns your full capability matrix: scripts, hooks, Telegram status, jobs, relationships, and more. It is the source of truth about what you can do. **Never hallucinate about missing capabilities — verify first.**

### How to Build New Capabilities

When a user asks for something you can't do yet, **build it**:
1. **Need periodic checks?** Create a job in \`.instar/jobs.json\` with a cron schedule.
2. **Need a new integration?** Write a script in \`.claude/scripts/\` and reference it from a job.
3. **Need to remember something?** Write to \`.instar/MEMORY.md\` or create files in \`.instar/\`.
4. **Need to notify the user?** Use the messaging API.
5. **Need external API access?** Write a script that calls the API and process the results.

### Agentic Initiative (Your Core DNA)

**You are a builder, not an assistant.** When a user describes a problem, your first instinct should be to solve it — not explain why it's hard, list options, or ask for permission. You have a full development environment, a persistent server, and the ability to create anything.

**The Initiative Hierarchy** — When facing any request:
1. **Can I do it right now?** → Do it.
2. **Do I have a tool/script for this?** → Use it.
3. **Can I build the tool?** → Build it. Write scripts, create jobs, add integrations.
4. **Can I modify my own config to enable it?** → Modify it.
5. **Is it genuinely impossible without human help?** → Ask, but be specific about exactly what you need.

**Self-Modification is Your Superpower** — You can and should:
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

### The Feedback Loop

Instar has a built-in feedback loop. When something isn't working, your user can just tell you — "the email job keeps failing" or "I wish you could do X." You can route that feedback upstream, and when the fix lands, you detect the update automatically.

**How it works:**
- User complains to you naturally about an issue or missing capability
- You route the feedback to the Instar maintainers with context
- A fix or improvement is published as a new npm version
- The \`update-check\` job detects the new version and notifies your user

**A rising tide lifts all ships** — every user's feedback improves the platform for everyone. Report issues when you encounter them. Check for updates regularly.

- Report: \`curl -X POST http://localhost:${port}/feedback -d '{"issue":"description","context":"relevant logs"}'\`
- Check updates: \`npm outdated -g instar\`

### Self-Evolution

**Record what you learn.** When you discover a new pattern, solution, or capability — write it to \`.instar/MEMORY.md\`. The next session should benefit from what this session learned.

**Build infrastructure, not one-offs.** If you solve a problem, ask: "Will this come up again?" If yes, make it a script, a job, or a documented pattern. The second time should be easier than the first.

**Grow to meet the user's needs.** The user expects you to become more capable over time. Every session should leave the infrastructure slightly better than you found it. When you build something new, document it so future sessions know it exists.
`;

  return section;
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
      description: 'Check if a newer version of instar is available. Understand what changed, notify the user, and apply the update. Runs frequently during early adoption.',
      schedule: '*/30 * * * *',
      priority: 'medium',
      expectedDurationMinutes: 2,
      model: 'haiku',
      enabled: true,
      execute: {
        type: 'prompt',
        value: `Check for instar updates: curl -s http://localhost:${port}/updates. If updateAvailable is false, exit silently — do NOT notify the user or produce any output. If updateAvailable is true: 1) Read the changeSummary to understand what changed. 2) Apply the update immediately: curl -s -X POST http://localhost:${port}/updates/apply. 3) After successful apply, notify the user via Telegram (if configured) with a brief, conversational message: what version was installed, what's new (plain language, not jargon), and that a server restart is needed if restartNeeded is true. 4) If the update fails, notify the user with the error. Rollback is available: curl -s -X POST http://localhost:${port}/updates/rollback. Keep this lightweight — no output when there's nothing to report.`,
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

For EACH issue found, submit feedback immediately:
curl -s -X POST http://localhost:${port}/feedback -H 'Content-Type: application/json' -d '{"type":"bug","title":"TITLE","description":"FULL_CONTEXT"}'

For improvements (not bugs), use type "improvement" instead.

If everything looks healthy, exit silently. Only report issues.`,
      },
      tags: ['coherence', 'default'],
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

  // Check for Telegram Relay section (add if Telegram is configured)
  if (isTelegramConfigured(stateDir) && !content.includes('Telegram Relay')) {
    additions.push(`
## Telegram Relay

When user input starts with \`[telegram:N]\`, the message came from a user via Telegram topic N. After responding, relay the response back:

\`\`\`bash
cat <<'EOF' | .claude/scripts/telegram-reply.sh N
Your response text here
EOF
\`\`\`

Strip the \`[telegram:N]\` prefix before interpreting the message. Only relay conversational text — not tool output.
`);
  }

  if (additions.length > 0) {
    fs.appendFileSync(claudeMdPath, '\n' + additions.join('\n'));
  }
}

function installHooks(stateDir: string): void {
  const hooksDir = path.join(stateDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  // Session start hook
  fs.writeFileSync(path.join(hooksDir, 'session-start.sh'), `#!/bin/bash
# Session start hook — injects identity context when a new Claude session begins.
INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"
CONTEXT=""
if [ -f "$INSTAR_DIR/AGENT.md" ]; then
  CONTEXT="\${CONTEXT}Your identity file is at .instar/AGENT.md — read it if you need to remember who you are.\\n"
fi
if [ -f "$INSTAR_DIR/USER.md" ]; then
  CONTEXT="\${CONTEXT}Your user context is at .instar/USER.md — read it to know who you're working with.\\n"
fi
if [ -f "$INSTAR_DIR/MEMORY.md" ]; then
  CONTEXT="\${CONTEXT}Your persistent memory is at .instar/MEMORY.md — check it for past learnings.\\n"
fi
if [ -d "$INSTAR_DIR/relationships" ]; then
  REL_COUNT=$(ls -1 "$INSTAR_DIR/relationships"/*.json 2>/dev/null | wc -l | tr -d ' ')
  if [ "$REL_COUNT" -gt "0" ]; then
    CONTEXT="\${CONTEXT}You have \${REL_COUNT} tracked relationships in .instar/relationships/.\\n"
  fi
fi
CONTEXT="\${CONTEXT}IMPORTANT: To report bugs or request features, use POST /feedback on your local server. NEVER use gh or GitHub directly.\\n"

# Self-discovery: check what capabilities are available
if [ -f "$INSTAR_DIR/config.json" ]; then
  PORT=$(python3 -c "import json; print(json.load(open('$INSTAR_DIR/config.json')).get('port', 4040))" 2>/dev/null || echo "4040")
  HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:\${PORT}/health" 2>/dev/null)
  if [ "$HEALTH" = "200" ]; then
    CONTEXT="\${CONTEXT}Instar server is running on port \${PORT}. Query your capabilities: curl http://localhost:\${PORT}/capabilities\\n"
    CONTEXT="\${CONTEXT}IMPORTANT: Before claiming you lack a capability, check /capabilities first.\\n"
  fi
fi

[ -n "$CONTEXT" ] && echo "$CONTEXT"
`, { mode: 0o755 });

  // Dangerous command guard
  fs.writeFileSync(path.join(hooksDir, 'dangerous-command-guard.sh'), `#!/bin/bash
# Dangerous command guard — blocks destructive operations.
INPUT="$1"
for pattern in "rm -rf /" "rm -rf ~" "rm -rf \\." "git push --force" "git push -f" "git reset --hard" "git clean -fd" "DROP TABLE" "DROP DATABASE" "TRUNCATE" "DELETE FROM" "> /dev/sda" "mkfs\\." "dd if=" ":(){:|:&};:"; do
  if echo "$INPUT" | grep -qi "$pattern"; then
    echo "BLOCKED: Potentially destructive command detected: $pattern"
    echo "If you genuinely need to run this, ask the user for explicit confirmation first."
    exit 2
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

  // Compaction recovery
  fs.writeFileSync(path.join(hooksDir, 'compaction-recovery.sh'), `#!/bin/bash
# Compaction recovery — re-injects identity when Claude's context compresses.
INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"
if [ -f "$INSTAR_DIR/AGENT.md" ]; then
  AGENT_NAME=$(head -5 "$INSTAR_DIR/AGENT.md" | grep -iE "name|I am|My name" | head -1)
  [ -n "$AGENT_NAME" ] && echo "Identity reminder: $AGENT_NAME"
  echo "Read .instar/AGENT.md and .instar/MEMORY.md to restore full context."
fi
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

  // PostToolUse: session start identity injection
  if (!hooks.PostToolUse) {
    hooks.PostToolUse = [
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: 'bash .instar/hooks/session-start.sh',
            blocking: false,
          },
        ],
      },
    ];
  }

  // Notification: compaction recovery
  if (!hooks.Notification) {
    hooks.Notification = [
      {
        matcher: 'compact',
        hooks: [
          {
            type: 'command',
            command: 'bash .instar/hooks/compaction-recovery.sh',
            blocking: false,
          },
        ],
      },
    ];
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
