#!/usr/bin/env node

/**
 * agent-kit CLI — Give any Claude Code project a persistent body.
 *
 * Usage:
 *   agent-kit init my-project         # Create a new agent project from scratch
 *   agent-kit init                    # Add agent infrastructure to existing project
 *   agent-kit setup                   # Interactive setup wizard
 *   agent-kit server start            # Start the persistent agent server
 *   agent-kit server stop             # Stop the server
 *   agent-kit status                  # Show agent infrastructure status
 *   agent-kit user add                # Add a user profile
 *   agent-kit job add                 # Add a job definition
 *   agent-kit job list                # List all jobs
 *   agent-kit add telegram            # Add Telegram messaging adapter
 */

import { Command } from 'commander';
import { initProject } from './commands/init.js';
import { runSetup } from './commands/setup.js';
import { startServer, stopServer } from './commands/server.js';
import { showStatus } from './commands/status.js';
import { addUser, listUsers } from './commands/user.js';
import { addJob, listJobs } from './commands/job.js';

const program = new Command();

program
  .name('agent-kit')
  .description('Give any Claude Code project a persistent body')
  .version('0.1.0')
  .option('--classic', 'Use the classic inquirer-based setup wizard instead of Claude')
  .action((opts) => runSetup(opts)); // Default: run interactive setup when no subcommand given

// ── Setup (explicit alias) ────────────────────────────────────────

program
  .command('setup')
  .description('Interactive setup wizard (same as running `agent-kit` with no args)')
  .option('--classic', 'Use the classic inquirer-based setup wizard instead of Claude')
  .action((opts) => runSetup(opts));

// ── Init ─────────────────────────────────────────────────────────

program
  .command('init [project-name]')
  .description('Initialize agent infrastructure (fresh project or existing)')
  .option('-d, --dir <path>', 'Project directory (default: current directory)')
  .option('--port <port>', 'Server port (default: 4040)', parseInt)
  .action((projectName, opts) => {
    // If a project name is given, it's a fresh install
    // Otherwise, augment the current directory
    initProject({ ...opts, name: projectName });
  });

// ── Add ───────────────────────────────────────────────────────────

const addCmd = program
  .command('add')
  .description('Add capabilities to the agent');

addCmd
  .command('telegram')
  .description('Add Telegram messaging adapter')
  .option('--token <token>', 'Telegram bot token')
  .option('--chat-id <id>', 'Telegram forum chat ID')
  .action((_opts) => {
    console.log('TODO: Add Telegram adapter (scaffolding only — use programmatic API for now)');
  });

addCmd
  .command('email')
  .description('Add email integration (Gmail)')
  .action((_opts) => {
    console.log('TODO: Add email integration');
  });

addCmd
  .command('sentry')
  .description('Add Sentry error monitoring')
  .option('--dsn <dsn>', 'Sentry DSN')
  .action((_opts) => {
    console.log('TODO: Add Sentry integration');
  });

addCmd
  .command('quota')
  .description('Add Claude API quota tracking')
  .action((_opts) => {
    console.log('TODO: Add quota tracking');
  });

// ── Server ────────────────────────────────────────────────────────

const serverCmd = program
  .command('server')
  .description('Manage the persistent agent server');

serverCmd
  .command('start')
  .description('Start the agent server')
  .option('--foreground', 'Run in foreground (default: background via tmux)')
  .option('-d, --dir <path>', 'Project directory')
  .action(startServer);

serverCmd
  .command('stop')
  .description('Stop the agent server')
  .option('-d, --dir <path>', 'Project directory')
  .action(stopServer);

// ── Status ────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show agent infrastructure status')
  .option('-d, --dir <path>', 'Project directory')
  .action(showStatus);

// ── User ──────────────────────────────────────────────────────────

const userCmd = program
  .command('user')
  .description('Manage users');

userCmd
  .command('add')
  .description('Add a user profile')
  .requiredOption('--id <id>', 'User ID')
  .requiredOption('--name <name>', 'User display name')
  .option('--telegram <topicId>', 'Telegram topic ID')
  .option('--email <email>', 'Email address')
  .option('--slack <userId>', 'Slack user ID')
  .option('--permissions <perms>', 'Comma-separated permissions', (v: string) => v.split(','))
  .action(addUser);

userCmd
  .command('list')
  .description('List all users')
  .option('-d, --dir <path>', 'Project directory')
  .action(listUsers);

// ── Job ───────────────────────────────────────────────────────────

const jobCmd = program
  .command('job')
  .description('Manage scheduled jobs');

jobCmd
  .command('add')
  .description('Add a job definition')
  .requiredOption('--slug <slug>', 'Job identifier')
  .requiredOption('--name <name>', 'Job display name')
  .requiredOption('--schedule <cron>', 'Cron expression')
  .option('--description <desc>', 'Job description')
  .option('--priority <priority>', 'Priority (critical|high|medium|low)', 'medium')
  .option('--model <model>', 'Model tier (opus|sonnet|haiku)', 'sonnet')
  .option('--type <type>', 'Execution type (skill|prompt|script)', 'prompt')
  .option('--execute <value>', 'Execution value (skill name, prompt text, or script path)')
  .action(addJob);

jobCmd
  .command('list')
  .description('List all jobs')
  .option('-d, --dir <path>', 'Project directory')
  .action(listJobs);

program.parse();
