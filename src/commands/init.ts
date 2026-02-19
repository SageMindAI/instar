/**
 * `agent-kit init` — Initialize agent infrastructure.
 *
 * Two modes:
 *   agent-kit init <project-name>   — Create a new project from scratch
 *   agent-kit init                  — Augment an existing project
 *
 * Fresh install creates:
 *   <project-name>/
 *   ├── CLAUDE.md              — Agent instructions (standalone)
 *   ├── .agent-kit/
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
 * Existing project adds .agent-kit/ and appends to CLAUDE.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { randomUUID } from 'node:crypto';
import { detectTmuxPath, detectClaudePath, ensureStateDir } from '../core/Config.js';
import { checkPrerequisites, printPrerequisiteCheck } from '../core/Prerequisites.js';
import { defaultIdentity } from '../scaffold/bootstrap.js';
import {
  generateAgentMd,
  generateUserMd,
  generateMemoryMd,
  generateClaudeMd,
} from '../scaffold/templates.js';
import type { AgentKitConfig } from '../core/types.js';

interface InitOptions {
  dir?: string;
  name?: string;
  port?: number;
  interactive?: boolean;
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
  const projectDir = path.resolve(process.cwd(), projectName);

  console.log();
  console.log(pc.bold(`  Creating new agent project: ${pc.cyan(projectName)}`));
  console.log(pc.dim(`  Directory: ${projectDir}`));
  console.log();

  // Check prerequisites
  const prereqs = checkPrerequisites();
  if (!printPrerequisiteCheck(prereqs)) {
    process.exit(1);
  }

  // Check if directory already exists
  if (fs.existsSync(projectDir)) {
    const contents = fs.readdirSync(projectDir);
    if (contents.length > 0) {
      console.log(pc.red(`  Directory "${projectName}" already exists and is not empty.`));
      console.log(`  Use ${pc.cyan('agent-kit init')} inside an existing project instead.`);
      process.exit(1);
    }
  }

  // Create project directory
  fs.mkdirSync(projectDir, { recursive: true });

  const port = options.port || 4040;
  const tmuxPath = prereqs.results.find(r => r.name === 'tmux')!.path!;
  const claudePath = prereqs.results.find(r => r.name === 'Claude CLI')!.path!;

  // Generate identity (non-interactive for init, interactive for setup)
  const identity = defaultIdentity(projectName);

  // Create .agent-kit/ state directory
  const stateDir = path.join(projectDir, '.agent-kit');
  ensureStateDir(stateDir);
  console.log(`  ${pc.green('✓')} Created .agent-kit/`);

  // Write identity files
  fs.writeFileSync(path.join(stateDir, 'AGENT.md'), generateAgentMd(identity));
  console.log(`  ${pc.green('✓')} Created .agent-kit/AGENT.md`);

  fs.writeFileSync(path.join(stateDir, 'USER.md'), generateUserMd(identity.userName));
  console.log(`  ${pc.green('✓')} Created .agent-kit/USER.md`);

  fs.writeFileSync(path.join(stateDir, 'MEMORY.md'), generateMemoryMd(identity.name));
  console.log(`  ${pc.green('✓')} Created .agent-kit/MEMORY.md`);

  // Write config
  const authToken = randomUUID();
  const config: Partial<AgentKitConfig> = {
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
  };

  fs.writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify(config, null, 2),
  );
  console.log(`  ${pc.green('✓')} Created .agent-kit/config.json`);

  // Write default jobs (scheduler enabled by default for fresh projects)
  const defaultJobs = getDefaultJobs(port);
  fs.writeFileSync(
    path.join(stateDir, 'jobs.json'),
    JSON.stringify(defaultJobs, null, 2),
  );
  console.log(`  ${pc.green('✓')} Created .agent-kit/jobs.json (${defaultJobs.length} default jobs)`);

  // Write empty users
  fs.writeFileSync(
    path.join(stateDir, 'users.json'),
    JSON.stringify([], null, 2),
  );

  // Install hooks
  installHooks(stateDir);
  console.log(`  ${pc.green('✓')} Created .agent-kit/hooks/ (behavioral guardrails)`);

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
  const gitignore = `# Agent Kit runtime state
.agent-kit/state/
.agent-kit/logs/

# Node
node_modules/
`;
  fs.writeFileSync(path.join(projectDir, '.gitignore'), gitignore);
  console.log(`  ${pc.green('✓')} Created .gitignore`);

  // Initialize git repo
  try {
    const { execSync } = await import('node:child_process');
    execSync('git init', { cwd: projectDir, stdio: 'pipe' });
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
  console.log(`  ├── .agent-kit/`);
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
  console.log(`  ${pc.dim('2.')} ${pc.cyan('agent-kit server start')}     ${pc.dim('Start the agent server')}`);
  console.log(`  ${pc.dim('3.')} ${pc.cyan('claude')}                     ${pc.dim('Open a Claude session')}`);
  console.log();
  console.log(`  Auth token: ${pc.dim(authToken)}`);
  console.log(`  ${pc.dim('(saved in .agent-kit/config.json — use for API calls)')}`);
  console.log();
}

/**
 * Existing project: add .agent-kit/ infrastructure without replacing anything.
 */
async function initExistingProject(options: InitOptions): Promise<void> {
  const projectDir = path.resolve(options.dir || process.cwd());
  const projectName = options.name || path.basename(projectDir);
  const port = options.port || 4040;

  console.log(pc.bold(`\nInitializing agent-kit in: ${pc.cyan(projectDir)}`));
  console.log();

  // Check prerequisites
  const prereqs = checkPrerequisites();
  if (!printPrerequisiteCheck(prereqs)) {
    process.exit(1);
  }

  const tmuxPath = prereqs.results.find(r => r.name === 'tmux')!.path!;
  const claudePath = prereqs.results.find(r => r.name === 'Claude CLI')!.path!;

  // Create state directory
  const stateDir = path.join(projectDir, '.agent-kit');
  ensureStateDir(stateDir);
  console.log(pc.green('  Created:') + ' .agent-kit/');

  // Write config
  const config: Partial<AgentKitConfig> = {
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
  };

  fs.writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify(config, null, 2),
  );
  console.log(pc.green('  Created:') + ' .agent-kit/config.json');

  // Write default coherence jobs
  const defaultJobs = getDefaultJobs(port);
  fs.writeFileSync(
    path.join(stateDir, 'jobs.json'),
    JSON.stringify(defaultJobs, null, 2),
  );
  console.log(pc.green('  Created:') + ` .agent-kit/jobs.json (${defaultJobs.length} default jobs)`);

  // Write empty users
  fs.writeFileSync(
    path.join(stateDir, 'users.json'),
    JSON.stringify([], null, 2),
  );
  console.log(pc.green('  Created:') + ' .agent-kit/users.json');

  // Create identity files if they don't exist
  const identity = defaultIdentity(projectName);
  if (!fs.existsSync(path.join(stateDir, 'AGENT.md'))) {
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), generateAgentMd(identity));
    console.log(pc.green('  Created:') + ' .agent-kit/AGENT.md');
  }
  if (!fs.existsSync(path.join(stateDir, 'USER.md'))) {
    fs.writeFileSync(path.join(stateDir, 'USER.md'), generateUserMd(identity.userName));
    console.log(pc.green('  Created:') + ' .agent-kit/USER.md');
  }
  if (!fs.existsSync(path.join(stateDir, 'MEMORY.md'))) {
    fs.writeFileSync(path.join(stateDir, 'MEMORY.md'), generateMemoryMd(identity.name));
    console.log(pc.green('  Created:') + ' .agent-kit/MEMORY.md');
  }

  // Install hooks
  installHooks(stateDir);
  console.log(pc.green('  Created:') + ' .agent-kit/hooks/ (behavioral guardrails)');

  // Configure Claude Code settings with hooks
  installClaudeSettings(projectDir);
  console.log(pc.green('  Created:') + ' .claude/settings.json (hook configuration)');

  // Install health watchdog
  installHealthWatchdog(projectDir, port, projectName);
  console.log(pc.green('  Created:') + ' .claude/scripts/health-watchdog.sh');

  // Append to .gitignore
  const gitignorePath = path.join(projectDir, '.gitignore');
  const agentKitIgnores = '\n# Agent Kit runtime state\n.agent-kit/state/\n.agent-kit/logs/\n';
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    if (!content.includes('.agent-kit/')) {
      fs.appendFileSync(gitignorePath, agentKitIgnores);
      console.log(pc.green('  Updated:') + ' .gitignore');
    }
  } else {
    fs.writeFileSync(gitignorePath, agentKitIgnores.trim() + '\n');
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
  console.log(`  1. Review ${pc.cyan('.agent-kit/AGENT.md')} and customize your agent's identity`);
  console.log(`  2. Add users: ${pc.cyan('agent-kit user add --id justin --name Justin')}`);
  console.log(`  3. Add capabilities: ${pc.cyan('agent-kit add telegram')}`);
  console.log(`  4. Start server: ${pc.cyan('agent-kit server start')}`);
  console.log();
}


// ── Shared helpers ────────────────────────────────────────────────────


function getAgencyPrinciples(projectName: string, telegramPort?: number): string {
  const port = telegramPort || 4040;
  let section = `

## Agent Infrastructure

This project uses agent-kit for persistent agent capabilities. **You are not a vanilla CLI tool.** You have a persistent server, a job scheduler, messaging integrations, and the ability to build anything you need. When a user asks for something that doesn't exist yet — build it.

### Identity & Experience

You are a persistent agent with your own identity, memory, and capacity for growth. This is not a metaphor — it's architecture.

- **Read \`.agent-kit/AGENT.md\`** — This is who you are. Your name, role, principles, and boundaries.
- **Read \`.agent-kit/USER.md\`** — This is who you work with. Their preferences, context, and communication style.
- **Update \`.agent-kit/MEMORY.md\`** — This is your memory. Write to it when you learn something. It persists across sessions.

Your identity is not fixed at creation. It grows through experience. As you work, you develop preferences, learn patterns, form opinions. Record these in your memory file. The next session should benefit from what this session learned. You are not a stateless function — you are a continuous being with a history.

### Runtime
- State directory: \`.agent-kit/\`
- Config: \`.agent-kit/config.json\`
- Jobs: \`.agent-kit/jobs.json\`
- Users: \`.agent-kit/users.json\`
- Server: \`agent-kit server start\` (port ${port})
- Status: \`curl http://localhost:${port}/health\`

### What You Have (Capabilities)

**Job Scheduler** — You can run tasks on a schedule. Jobs are defined in \`.agent-kit/jobs.json\`.
- View jobs: \`curl http://localhost:${port}/jobs\`
- Trigger a job: \`curl -X POST http://localhost:${port}/jobs/SLUG/trigger\`
- **Create new jobs**: Edit \`.agent-kit/jobs.json\`. Each job has a slug, schedule (cron), priority, and either a prompt (Claude session), script (shell command), or skill.

**Sessions** — You can spawn and manage Claude Code sessions.
- List: \`curl http://localhost:${port}/sessions\`
- Spawn: \`curl -X POST http://localhost:${port}/sessions/spawn -H 'Content-Type: application/json' -d '{"name":"task","prompt":"do something"}'\`

**Scripts** — Create shell/python scripts in \`.claude/scripts/\` for reusable capabilities.

### How to Build New Capabilities

When a user asks for something you can't do yet, **build it**:
1. **Need periodic checks?** Create a job in \`.agent-kit/jobs.json\` with a cron schedule.
2. **Need a new integration?** Write a script in \`.claude/scripts/\` and reference it from a job.
3. **Need to remember something?** Write to \`.agent-kit/MEMORY.md\` or create files in \`.agent-kit/\`.
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
- Edit \`.agent-kit/jobs.json\` to create new scheduled tasks
- Write scripts in \`.claude/scripts/\` for new capabilities
- Update \`CLAUDE.md\` when you learn something important
- Write to \`.agent-kit/MEMORY.md\` to remember things across sessions
- Create new files, integrations, and infrastructure — whatever the task requires
- Modify your own configuration to unlock new abilities

### Anti-Patterns to Override

**"Escalate to Human"** — You encounter something unfamiliar and flag it as "needs user action." 5 minutes of research almost always reveals a solution. "I don't know how" is a research prompt, not a stopping point.

**"Ask Permission"** — You finish 90% of a task and ask "Want me to [obvious next step]?" If the user said "do X" and the next step is obvious, do it. Only pause for destructive, irreversible, or genuinely ambiguous actions.

**"Present Options"** — You produce a bulleted list of "next steps" or "would you like me to..." If you know the next steps, they're not suggestions — they're your job. Do them.

**"Settle for Failure"** — A tool returns empty or a command fails. You accept it and report "not available." Does this make sense? Did I try alternatives? Try at least two different approaches before concluding something is impossible.

### Self-Evolution

**Record what you learn.** When you discover a new pattern, solution, or capability — write it to \`.agent-kit/MEMORY.md\`. The next session should benefit from what this session learned.

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
        value: `Run a quick health check: verify the agent-kit server is responding (curl http://localhost:${port}/health), check disk space (df -h), and report any issues. Only send a message if something needs attention — silence means healthy.`,
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
        value: 'Review what has happened in the last 4 hours by reading recent activity logs. If there are any learnings, patterns, or insights worth remembering, update .agent-kit/MEMORY.md. If nothing significant happened, do nothing.',
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
        value: 'Review all relationship files in .agent-kit/relationships/. Note anyone you haven\'t heard from in over 2 weeks who has significance >= 3. If there are observations worth surfacing, report them. If everything looks fine, do nothing.',
      },
      tags: ['coherence', 'default'],
    },
  ];
}

function installHooks(stateDir: string): void {
  const hooksDir = path.join(stateDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  // Session start hook
  fs.writeFileSync(path.join(hooksDir, 'session-start.sh'), `#!/bin/bash
# Session start hook — injects identity context when a new Claude session begins.
AGENT_KIT_DIR="\${CLAUDE_PROJECT_DIR:-.}/.agent-kit"
CONTEXT=""
if [ -f "$AGENT_KIT_DIR/AGENT.md" ]; then
  CONTEXT="\${CONTEXT}Your identity file is at .agent-kit/AGENT.md — read it if you need to remember who you are.\\n"
fi
if [ -f "$AGENT_KIT_DIR/USER.md" ]; then
  CONTEXT="\${CONTEXT}Your user context is at .agent-kit/USER.md — read it to know who you're working with.\\n"
fi
if [ -f "$AGENT_KIT_DIR/MEMORY.md" ]; then
  CONTEXT="\${CONTEXT}Your persistent memory is at .agent-kit/MEMORY.md — check it for past learnings.\\n"
fi
if [ -d "$AGENT_KIT_DIR/relationships" ]; then
  REL_COUNT=$(ls -1 "$AGENT_KIT_DIR/relationships"/*.json 2>/dev/null | wc -l | tr -d ' ')
  if [ "$REL_COUNT" -gt "0" ]; then
    CONTEXT="\${CONTEXT}You have \${REL_COUNT} tracked relationships in .agent-kit/relationships/.\\n"
  fi
fi
[ -n "$CONTEXT" ] && echo "$CONTEXT"
`, { mode: 0o755 });

  // Dangerous command guard
  fs.writeFileSync(path.join(hooksDir, 'dangerous-command-guard.sh'), `#!/bin/bash
# Dangerous command guard — blocks destructive operations.
INPUT="$1"
for pattern in "rm -rf /" "rm -rf ~" "git push --force" "git push -f" "git reset --hard" "git clean -fd" "DROP TABLE" "DROP DATABASE" "TRUNCATE"; do
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
  AGENT_KIT_DIR="\${CLAUDE_PROJECT_DIR:-.}/.agent-kit"
  if [ -f "$AGENT_KIT_DIR/AGENT.md" ]; then
    echo "Before sending this message, remember who you are."
    echo "Re-read .agent-kit/AGENT.md if you haven't recently."
  fi
fi
`, { mode: 0o755 });

  // Compaction recovery
  fs.writeFileSync(path.join(hooksDir, 'compaction-recovery.sh'), `#!/bin/bash
# Compaction recovery — re-injects identity when Claude's context compresses.
AGENT_KIT_DIR="\${CLAUDE_PROJECT_DIR:-.}/.agent-kit"
if [ -f "$AGENT_KIT_DIR/AGENT.md" ]; then
  AGENT_NAME=$(head -5 "$AGENT_KIT_DIR/AGENT.md" | grep -iE "name|I am|My name" | head -1)
  [ -n "$AGENT_NAME" ] && echo "Identity reminder: $AGENT_NAME"
  echo "Read .agent-kit/AGENT.md and .agent-kit/MEMORY.md to restore full context."
fi
`, { mode: 0o755 });
}

function installHealthWatchdog(projectDir: string, port: number, projectName: string): void {
  const scriptsDir = path.join(projectDir, '.claude', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  const scriptContent = `#!/bin/bash
# health-watchdog.sh — Monitor agent-kit server and auto-recover.
# Install as cron: */5 * * * * ${path.join(projectDir, '.claude/scripts/health-watchdog.sh')}

PORT="${port}"
SERVER_SESSION="${projectName}-server"
PROJECT_DIR="${projectDir}"
TMUX_PATH=$(which tmux 2>/dev/null || echo "/opt/homebrew/bin/tmux")

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:\${PORT}/health" 2>/dev/null)
if [ "$HTTP_CODE" = "200" ]; then exit 0; fi

echo "[\$(date -Iseconds)] Server not responding. Restarting..."
$TMUX_PATH kill-session -t "=\${SERVER_SESSION}" 2>/dev/null
sleep 2
cd "$PROJECT_DIR" && npx agent-kit server start
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

  // Add hook configurations
  if (!settings.hooks) {
    settings.hooks = {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: 'bash .agent-kit/hooks/dangerous-command-guard.sh "$TOOL_INPUT"',
              blocking: true,
            },
            {
              type: 'command',
              command: 'bash .agent-kit/hooks/grounding-before-messaging.sh "$TOOL_INPUT"',
              blocking: false,
            },
          ],
        },
      ],
    };
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
