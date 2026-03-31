#!/usr/bin/env node
/**
 * instar CLI — Persistent autonomy infrastructure for AI agents.
 *
 * Usage:
 *   instar init my-project         # Create a new agent project from scratch
 *   instar init                    # Add agent infrastructure to existing project
 *   instar setup                   # Interactive setup wizard
 *   instar server start            # Start the persistent agent server
 *   instar server stop             # Stop the server
 *   instar status                  # Show agent infrastructure status
 *   instar user add                # Add a user profile
 *   instar job add                 # Add a job definition
 *   instar job list                # List all jobs
 *   instar relationship list       # List tracked relationships
 *   instar relationship import     # Import from Portal people-registry
 *   instar relationship export     # Export for Portal import
 *   instar add telegram            # Add Telegram messaging adapter
 */
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { initProject } from './commands/init.js';
// setup.ts is imported dynamically — it depends on @inquirer/prompts which requires Node 20.12+
import { startServer, stopServer, restartServer } from './commands/server.js';
import { showStatus } from './commands/status.js';
import { addUser, listUsers } from './commands/user.js';
import { addJob, listJobs } from './commands/job.js';
import { listRelationships, importRelationships, exportRelationships } from './commands/relationship.js';
import { listMachines, removeMachine, whoami, startPairing, joinMesh, leaveMesh, wakeup, doctor } from './commands/machine.js';
import pc from 'picocolors';
import { getInstarVersion } from './core/Config.js';
import { listAgents } from './core/AgentRegistry.js';
/**
 * Add or update Telegram configuration in the project config.
 */
async function addTelegram(opts) {
    const configPath = path.join(process.cwd(), '.instar', 'config.json');
    if (!fs.existsSync(configPath)) {
        console.log(pc.red('No .instar/config.json found. Run `instar init` first.'));
        process.exit(1);
    }
    let token = opts.token;
    let chatId = opts.chatId;
    // If not provided via flags, show usage
    if (!token || !chatId) {
        console.log(pc.yellow('Both --token and --chat-id are required.'));
        console.log();
        console.log('Usage:');
        console.log(`  instar add telegram --token YOUR_BOT_TOKEN --chat-id -100YOUR_GROUP_ID`);
        console.log();
        console.log('Get a bot token from @BotFather on Telegram.');
        console.log('Get the chat ID by adding @RawDataBot to your forum group.');
        process.exit(1);
    }
    // Read, update, write config
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let config;
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
    catch {
        console.log(pc.red('Failed to parse .instar/config.json. Check that it contains valid JSON.'));
        process.exit(1);
    }
    if (!config.messaging)
        config.messaging = [];
    // Remove existing Telegram config if any
    config.messaging = config.messaging.filter((m) => m.type !== 'telegram');
    config.messaging.push({
        type: 'telegram',
        enabled: true,
        config: {
            token,
            chatId,
            pollIntervalMs: 2000,
        },
    });
    const tmpPath = configPath + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
        fs.renameSync(tmpPath, configPath);
    }
    catch (err) {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch { /* ignore */ }
        throw err;
    }
    console.log(pc.green('Telegram adapter configured successfully!'));
    console.log(`  Bot token: ${token.slice(0, 8)}...`);
    console.log(`  Chat ID: ${chatId}`);
    console.log();
    console.log(`Restart the server to apply: ${pc.cyan('instar server stop && instar server start')}`);
}
/**
 * Add Sentry error monitoring configuration.
 */
async function addSentry(opts) {
    const configPath = path.join(process.cwd(), '.instar', 'config.json');
    if (!fs.existsSync(configPath)) {
        console.log(pc.red('No .instar/config.json found. Run `instar init` first.'));
        process.exit(1);
    }
    if (!opts.dsn) {
        console.log(pc.yellow('The --dsn option is required.'));
        console.log();
        console.log('Usage:');
        console.log(`  instar add sentry --dsn https://examplePublicKey@o0.ingest.sentry.io/0`);
        console.log();
        console.log('Get your DSN from https://sentry.io → Project Settings → Client Keys (DSN)');
        process.exit(1);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let config;
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
    catch {
        console.log(pc.red('Failed to parse .instar/config.json. Check that it contains valid JSON.'));
        process.exit(1);
    }
    if (!config.monitoring) {
        config.monitoring = {};
    }
    config.monitoring.sentry = {
        enabled: true,
        dsn: opts.dsn,
    };
    const tmpPath = configPath + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
        fs.renameSync(tmpPath, configPath);
    }
    catch (err) {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch { /* ignore */ }
        throw err;
    }
    console.log(pc.green('Sentry error monitoring configured!'));
    console.log(`  DSN: ${opts.dsn.slice(0, 30)}...`);
    console.log();
    console.log(`Restart the server to apply: ${pc.cyan('instar server stop && instar server start')}`);
}
/**
 * Add email (Gmail) integration configuration.
 */
async function addEmail(opts) {
    const configPath = path.join(process.cwd(), '.instar', 'config.json');
    if (!fs.existsSync(configPath)) {
        console.log(pc.red('No .instar/config.json found. Run `instar init` first.'));
        process.exit(1);
    }
    if (!opts.credentialsFile) {
        console.log(pc.yellow('The --credentials-file option is required.'));
        console.log();
        console.log('Usage:');
        console.log(`  instar add email --credentials-file ./credentials.json`);
        console.log();
        console.log('To get credentials:');
        console.log('  1. Go to https://console.cloud.google.com → APIs & Services → Credentials');
        console.log('  2. Create OAuth 2.0 Client ID (Desktop app)');
        console.log('  3. Download the credentials JSON file');
        process.exit(1);
    }
    // Read, update, write config
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let config;
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
    catch {
        console.log(pc.red('Failed to parse .instar/config.json. Check that it contains valid JSON.'));
        process.exit(1);
    }
    if (!config.messaging)
        config.messaging = [];
    // Remove existing email config if any
    config.messaging = config.messaging.filter((m) => m.type !== 'email');
    config.messaging.push({
        type: 'email',
        enabled: true,
        config: {
            credentialsFile: opts.credentialsFile,
            tokenFile: opts.tokenFile || path.join(process.cwd(), '.instar', 'gmail-token.json'),
        },
    });
    const tmpPath = configPath + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
        fs.renameSync(tmpPath, configPath);
    }
    catch (err) {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch { /* ignore */ }
        throw err;
    }
    console.log(pc.green('Email (Gmail) integration configured!'));
    console.log(`  Credentials: ${opts.credentialsFile}`);
    console.log(`  Token file: ${opts.tokenFile || '.instar/gmail-token.json'}`);
    console.log();
    console.log(`Restart the server to apply: ${pc.cyan('instar server stop && instar server start')}`);
}
/**
 * Enable quota tracking in the project config.
 */
async function addQuota(opts) {
    const configPath = path.join(process.cwd(), '.instar', 'config.json');
    if (!fs.existsSync(configPath)) {
        console.log(pc.red('No .instar/config.json found. Run `instar init` first.'));
        process.exit(1);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let config;
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
    catch {
        console.log(pc.red('Failed to parse .instar/config.json. Check that it contains valid JSON.'));
        process.exit(1);
    }
    if (!config.monitoring) {
        config.monitoring = {};
    }
    config.monitoring.quotaTracking = true;
    if (opts.stateFile) {
        config.monitoring.quotaStateFile = opts.stateFile;
    }
    const tmpPath = configPath + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
        fs.renameSync(tmpPath, configPath);
    }
    catch (err) {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch { /* ignore */ }
        throw err;
    }
    console.log(pc.green('Quota tracking enabled!'));
    console.log();
    if (opts.stateFile) {
        console.log(`  State file: ${opts.stateFile}`);
    }
    console.log('The agent will now track Claude API usage and throttle jobs when usage is high.');
    console.log();
    console.log(`Restart the server to apply: ${pc.cyan('instar server stop && instar server start')}`);
}
const program = new Command();
program
    .name('instar')
    .description('Persistent autonomy infrastructure for AI agents')
    .version(getInstarVersion())
    .action(async () => {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 20 || (major === 20 && minor < 12)) {
        console.error(`\n  Instar setup requires Node.js 20.12 or later.`);
        console.error(`  You're running Node.js ${process.versions.node}.`);
        console.error(`\n  Upgrade: https://nodejs.org/en/download\n`);
        process.exit(1);
    }
    const { runSetup } = await import('./commands/setup.js');
    return runSetup();
}); // Default: run interactive setup when no subcommand given
// ── Setup (explicit alias) ────────────────────────────────────────
program
    .command('setup')
    .description('Interactive setup wizard (same as running `instar` with no args)')
    .option('--non-interactive', 'Run setup without LLM wizard (requires all flags)')
    .option('--name <name>', 'Agent name (non-interactive)')
    .option('--user <user>', 'User name (non-interactive)')
    .option('--telegram-token <token>', 'Telegram bot token (non-interactive)')
    .option('--telegram-group <group>', 'Telegram group/chat ID (non-interactive)')
    .option('--whatsapp-backend <backend>', 'WhatsApp backend: baileys or business-api (non-interactive)')
    .option('--whatsapp-phone <phone>', 'WhatsApp authorized phone number (non-interactive)')
    .option('--whatsapp-phone-number-id <id>', 'Business API phone number ID (non-interactive)')
    .option('--whatsapp-access-token <token>', 'Business API access token (non-interactive)')
    .option('--whatsapp-verify-token <token>', 'Business API webhook verify token (non-interactive)')
    .option('--scenario <number>', 'Scenario number 1-8 (non-interactive)')
    .action(async (opts) => {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 20 || (major === 20 && minor < 12)) {
        console.error(`\n  Instar setup requires Node.js 20.12 or later.`);
        console.error(`  You're running Node.js ${process.versions.node}.`);
        console.error(`\n  Upgrade: https://nodejs.org/en/download\n`);
        process.exit(1);
    }
    const { runSetup, runNonInteractiveSetup } = await import('./commands/setup.js');
    if (opts.nonInteractive) {
        return runNonInteractiveSetup(opts);
    }
    return runSetup();
});
// ── Init ─────────────────────────────────────────────────────────
program
    .command('init [project-name]')
    .description('Initialize agent infrastructure (fresh project, existing, or standalone)')
    .option('-d, --dir <path>', 'Project directory (default: current directory)')
    .option('--port <port>', 'Server port (default: 4040)', (v) => parseInt(v, 10))
    .option('--standalone', 'Create a standalone agent at ~/.instar/agents/<name>/')
    .action((projectName, opts) => {
    return initProject({ ...opts, name: projectName });
});
// ── Add ───────────────────────────────────────────────────────────
const addCmd = program
    .command('add')
    .description('Add capabilities to the agent');
addCmd
    .command('telegram')
    .description('Add Telegram messaging adapter')
    .option('--token <token>', 'Telegram bot token (from @BotFather)')
    .option('--chat-id <id>', 'Telegram forum supergroup chat ID')
    .action((opts) => addTelegram(opts));
addCmd
    .command('email')
    .description('Add email integration (Gmail)')
    .option('--credentials-file <path>', 'Path to Google OAuth credentials JSON file')
    .option('--token-file <path>', 'Path to store Gmail auth token')
    .action((opts) => addEmail(opts));
addCmd
    .command('whatsapp')
    .description('Add WhatsApp messaging adapter')
    .option('--backend <backend>', 'Backend: baileys (free, QR auth) or business-api (paid, Meta API)', 'baileys')
    .option('--auth-method <method>', 'Auth method: qr (scan code) or pairing-code (8-digit code)', 'qr')
    .option('--phone <number>', 'Phone number for pairing code auth (E.164 format: +1234567890)')
    .option('--authorized <numbers>', 'Comma-separated authorized phone numbers (E.164). Empty = allow all.')
    .option('--encrypt', 'Encrypt auth credentials at rest (recommended)')
    .option('--phone-number-id <id>', 'Meta Phone Number ID (Business API)')
    .option('--access-token <token>', 'Meta access token (Business API)')
    .option('--webhook-verify-token <token>', 'Webhook verification token (Business API)')
    .option('--webhook-port <port>', 'Webhook port if different from server port (Business API)', parseInt)
    .action(async (opts) => {
    const { addWhatsApp } = await import('./commands/whatsapp.js');
    return addWhatsApp(opts);
});
addCmd
    .command('slack')
    .description('Add Slack messaging adapter (tokens entered interactively)')
    .action(async () => {
    const { addSlack } = await import('./commands/slack-cli.js');
    return addSlack();
});
addCmd
    .command('sentry')
    .description('Add Sentry error monitoring')
    .option('--dsn <dsn>', 'Sentry DSN')
    .action((opts) => addSentry(opts));
addCmd
    .command('quota')
    .description('Add Claude API quota tracking')
    .option('--state-file <path>', 'Path to quota state file (default: .instar/state/quota.json)')
    .action((opts) => addQuota(opts));
// ── Remove ──────────────────────────────────────────────────────
const removeAdapterCmd = program
    .command('remove')
    .description('Remove capabilities from the agent');
removeAdapterCmd
    .command('slack')
    .description('Remove Slack messaging adapter and purge associated data')
    .action(async () => {
    const { removeSlack } = await import('./commands/slack-cli.js');
    return removeSlack();
});
// ── Backup ───────────────────────────────────────────────────────
const backupCmd = program
    .command('backup')
    .description('Manage agent state backups');
backupCmd
    .command('create')
    .description('Create a manual backup')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    const { createBackup } = await import('./commands/backup.js');
    return createBackup(opts);
});
backupCmd
    .command('list')
    .description('List available backup snapshots')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    const { listBackups } = await import('./commands/backup.js');
    return listBackups(opts);
});
backupCmd
    .command('restore [id]')
    .description('Restore from a backup snapshot (latest if no ID)')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (id, opts) => {
    const { restoreBackup } = await import('./commands/backup.js');
    return restoreBackup(id, opts);
});
// ── Git State ────────────────────────────────────────────────────
const gitCmd = program
    .command('git')
    .description('Git-backed state tracking (standalone agents only)');
gitCmd
    .command('init')
    .description('Initialize git tracking in the agent state directory')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    const { gitInit } = await import('./commands/git.js');
    return gitInit(opts);
});
gitCmd
    .command('status')
    .description('Show git tracking status')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    const { gitStatus } = await import('./commands/git.js');
    return gitStatus(opts);
});
gitCmd
    .command('push')
    .description('Push state to remote')
    .option('-d, --dir <path>', 'Project directory')
    .option('--confirm', 'Confirm first push to remote')
    .action(async (opts) => {
    const { gitPush } = await import('./commands/git.js');
    return gitPush(opts);
});
gitCmd
    .command('pull')
    .description('Pull state from remote')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    const { gitPull } = await import('./commands/git.js');
    return gitPull(opts);
});
gitCmd
    .command('log')
    .description('Show recent commit history')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    const { gitLog } = await import('./commands/git.js');
    return gitLog(opts);
});
gitCmd
    .command('remote <url>')
    .description('Set remote URL for push/pull')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (url, opts) => {
    const { gitRemote } = await import('./commands/git.js');
    return gitRemote(url, opts);
});
gitCmd
    .command('commit [message]')
    .description('Manual commit of state changes')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (message, opts) => {
    const { gitCommit } = await import('./commands/git.js');
    return gitCommit(message, opts);
});
// ── Memory Search ────────────────────────────────────────────────
const memoryCmd = program
    .command('memory')
    .description('Search and manage agent memory index (FTS5)');
memoryCmd
    .command('search <query>')
    .description('Full-text search over agent memory files')
    .option('-d, --dir <path>', 'Project directory')
    .option('-l, --limit <count>', 'Max results (default: 10)', (v) => parseInt(v, 10))
    .action(async (query, opts) => {
    const { memorySearch } = await import('./commands/memory.js');
    return memorySearch(query, opts);
});
memoryCmd
    .command('reindex')
    .description('Full rebuild of the SQLite memory index')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    const { memoryReindex } = await import('./commands/memory.js');
    return memoryReindex(opts);
});
memoryCmd
    .command('status')
    .description('Show memory index statistics')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    const { memoryStatus } = await import('./commands/memory.js');
    return memoryStatus(opts);
});
memoryCmd
    .command('export')
    .description('Generate MEMORY.md from SemanticMemory knowledge graph')
    .option('-d, --dir <path>', 'Project directory')
    .option('-o, --output <path>', 'Output file path (prints to stdout if omitted)')
    .option('-a, --agent <name>', 'Agent name for the header (default: Agent)')
    .option('--min-confidence <value>', 'Minimum confidence threshold (default: 0.2)', (v) => parseFloat(v))
    .option('--max-entities <count>', 'Maximum entities to include (default: 200)', (v) => parseInt(v, 10))
    .action(async (opts) => {
    const { memoryExport } = await import('./commands/memory.js');
    return memoryExport(opts);
});
// ── Knowledge Base ────────────────────────────────────────────────
const knowledgeCmd = program
    .command('knowledge')
    .description('Ingest URLs, documents, and transcripts into a searchable knowledge base');
knowledgeCmd
    .command('ingest <content>')
    .description('Ingest content into the knowledge base')
    .requiredOption('-t, --title <title>', 'Title for the content')
    .option('-u, --url <url>', 'Source URL')
    .option('--type <type>', 'Content type: article, transcript, doc (default: article)')
    .option('--tags <tags>', 'Comma-separated tags')
    .option('-s, --summary <summary>', 'Brief summary')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (content, opts) => {
    const { knowledgeIngest } = await import('./commands/knowledge.js');
    return knowledgeIngest(content, opts);
});
knowledgeCmd
    .command('list')
    .description('List all ingested knowledge sources')
    .option('--tag <tag>', 'Filter by tag')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    const { knowledgeList } = await import('./commands/knowledge.js');
    return knowledgeList(opts);
});
knowledgeCmd
    .command('search <query>')
    .description('Search knowledge base (scoped to knowledge/ sources)')
    .option('-l, --limit <count>', 'Max results (default: 10)', (v) => parseInt(v, 10))
    .option('-d, --dir <path>', 'Project directory')
    .action(async (query, opts) => {
    const { knowledgeSearch } = await import('./commands/knowledge.js');
    return knowledgeSearch(query, opts);
});
knowledgeCmd
    .command('remove <sourceId>')
    .description('Remove a source from the knowledge base')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (sourceId, opts) => {
    const { knowledgeRemove } = await import('./commands/knowledge.js');
    return knowledgeRemove(sourceId, opts);
});
// ── Semantic Memory ──────────────────────────────────────────────
const semanticCmd = program
    .command('semantic')
    .description('Manage the semantic memory knowledge graph');
semanticCmd
    .command('search <query>')
    .description('Search the knowledge graph')
    .option('-d, --dir <path>', 'Project directory')
    .option('-l, --limit <count>', 'Max results (default: 10)', (v) => parseInt(v, 10))
    .option('-t, --type <type>', 'Filter by entity type (fact, person, project, tool, pattern, decision, lesson)')
    .option('--domain <domain>', 'Filter by domain')
    .option('--min-confidence <value>', 'Minimum confidence (0.0-1.0)')
    .action(async (query, opts) => {
    const { semanticSearch } = await import('./commands/semantic.js');
    return semanticSearch(query, opts);
});
semanticCmd
    .command('remember')
    .description('Add a knowledge entity to the graph')
    .requiredOption('-t, --type <type>', 'Entity type (fact, person, project, tool, pattern, decision, lesson)')
    .requiredOption('-n, --name <name>', 'Entity name')
    .requiredOption('-c, --content <content>', 'Entity content')
    .option('--confidence <value>', 'Confidence (0.0-1.0, default: 0.8)')
    .option('--source <source>', 'Source (default: cli)')
    .option('--tags <tags>', 'Comma-separated tags')
    .option('--domain <domain>', 'Domain grouping')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    const { semanticRemember } = await import('./commands/semantic.js');
    return semanticRemember(opts);
});
semanticCmd
    .command('forget <id>')
    .description('Remove an entity and its edges')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (id, opts) => {
    const { semanticForget } = await import('./commands/semantic.js');
    return semanticForget(id, opts);
});
semanticCmd
    .command('stats')
    .description('Show knowledge graph statistics')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    const { semanticStats } = await import('./commands/semantic.js');
    return semanticStats(opts);
});
semanticCmd
    .command('export')
    .description('Export all entities and edges as JSON')
    .option('-o, --output <path>', 'Output file (defaults to stdout)')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    const { semanticExport } = await import('./commands/semantic.js');
    return semanticExport(opts);
});
semanticCmd
    .command('decay')
    .description('Run confidence decay on all entities')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    const { semanticDecay } = await import('./commands/semantic.js');
    return semanticDecay(opts);
});
// ── Intent ────────────────────────────────────────────────────────
const intentCmd = program
    .command('intent')
    .description('Intent engineering — review decisions against stated intent');
intentCmd
    .command('reflect')
    .description('Review recent decisions against stated intent from AGENT.md')
    .option('-d, --dir <path>', 'Project directory')
    .option('--days <days>', 'Number of days to review (default: 7)', (v) => parseInt(v, 10))
    .option('--limit <count>', 'Max entries to show (default: 100)', (v) => parseInt(v, 10))
    .action(async (opts) => {
    const { intentReflect } = await import('./commands/intent.js');
    return intentReflect(opts);
});
intentCmd
    .command('org-init [name]')
    .description('Create ORG-INTENT.md for organizational intent')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (name, opts) => {
    const { orgInit } = await import('./commands/org.js');
    return orgInit({ ...opts, name });
});
intentCmd
    .command('validate')
    .description('Validate agent intent against org constraints')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    const { intentValidate } = await import('./commands/intent.js');
    return intentValidate(opts);
});
intentCmd
    .command('drift')
    .description('Detect intent drift from decision journal trends')
    .option('-d, --dir <path>', 'Project directory')
    .option('--window <days>', 'Window size in days (default: 14)', (v) => parseInt(v, 10))
    .action(async (opts) => {
    const { intentDrift } = await import('./commands/intent.js');
    return intentDrift(opts);
});
// ── Reflect (Living Skills) ──────────────────────────────────────
const reflectCmd = program
    .command('reflect')
    .description('Living Skills — view execution journal and patterns for jobs');
reflectCmd
    .command('job <slug>')
    .description('Show execution journal for a specific job')
    .option('-d, --dir <path>', 'Project directory')
    .option('--days <days>', 'Number of days to show (default: 30)', (v) => parseInt(v, 10))
    .option('--limit <count>', 'Max records to show (default: 10)', (v) => parseInt(v, 10))
    .option('--agent <id>', 'Agent ID (default: "default")')
    .action(async (slug, opts) => {
    const { reflectJob } = await import('./commands/reflect.js');
    return reflectJob(slug, opts);
});
reflectCmd
    .command('all')
    .description('Show execution journal summary for all jobs')
    .option('-d, --dir <path>', 'Project directory')
    .option('--days <days>', 'Number of days to show (default: 30)', (v) => parseInt(v, 10))
    .option('--agent <id>', 'Agent ID (default: "default")')
    .action(async (opts) => {
    const { reflectAll } = await import('./commands/reflect.js');
    return reflectAll(opts);
});
reflectCmd
    .command('analyze [slug]')
    .description('Detect patterns across execution history')
    .option('-d, --dir <path>', 'Project directory')
    .option('--days <days>', 'Number of days to analyze (default: 30)', (v) => parseInt(v, 10))
    .option('--agent <id>', 'Agent ID (default: "default")')
    .option('--all', 'Analyze all jobs')
    .option('--proposals', 'Show evolution proposals for detected patterns')
    .option('--min-runs <count>', 'Minimum runs for pattern detection (default: 3)', (v) => parseInt(v, 10))
    .action(async (slug, opts) => {
    const { analyzePatterns } = await import('./commands/reflect.js');
    return analyzePatterns(slug, opts);
});
reflectCmd
    .command('consolidate')
    .description('Run full reflection cycle — analyze patterns, create proposals, record learnings')
    .option('-d, --dir <path>', 'Project directory')
    .option('--days <days>', 'Number of days to analyze (default: 7)', (v) => parseInt(v, 10))
    .option('--agent <id>', 'Agent ID (default: "default")')
    .option('--min-runs <count>', 'Minimum runs for pattern detection (default: 3)', (v) => parseInt(v, 10))
    .option('--dry-run', 'Show what would be proposed without writing to EvolutionManager')
    .action(async (opts) => {
    const { consolidateReflection } = await import('./commands/reflect.js');
    return consolidateReflection(opts);
});
reflectCmd
    .command('run [slug]')
    .description('Run LLM-powered per-job reflection (requires Claude CLI or ANTHROPIC_API_KEY)')
    .option('-d, --dir <path>', 'Project directory')
    .option('--days <days>', 'Number of days of history to include (default: 30)', (v) => parseInt(v, 10))
    .option('--agent <id>', 'Agent ID (default: "default")')
    .option('--session <id>', 'Specific session ID to reflect on')
    .option('--model <tier>', 'Model tier: fast, balanced, capable (default: capable)')
    .option('--all', 'Reflect on all jobs')
    .action(async (slug, opts) => {
    const { runReflection } = await import('./commands/reflect.js');
    return runReflection(slug, opts);
});
// ── Feedback ─────────────────────────────────────────────────────
program
    .command('feedback')
    .description('Submit feedback about Instar (bugs, features, improvements)')
    .option('--type <type>', 'Feedback type (bug|feature|improvement|question)', 'other')
    .option('--title <title>', 'Short title')
    .option('--description <desc>', 'Detailed description')
    .option('-d, --dir <path>', 'Project directory')
    .option('--port <port>', 'Server port (default: 4040)', (v) => parseInt(v, 10))
    .action(async (opts) => {
    const port = opts.port || 4040;
    const title = opts.title || 'CLI feedback submission';
    const description = opts.description || opts.title || 'No description provided';
    // Load config to get auth token if available
    let authToken;
    try {
        const { loadConfig } = await import('./core/Config.js');
        const config = loadConfig(opts.dir);
        authToken = config.authToken;
    }
    catch { /* project may not be initialized yet */ }
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (authToken)
            headers['Authorization'] = `Bearer ${authToken}`;
        const response = await fetch(`http://localhost:${port}/feedback`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ type: opts.type, title, description }),
            signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) {
            const result = await response.json();
            console.log(`Feedback submitted: ${result.id}`);
            console.log(`Forwarded upstream: ${result.forwarded ? 'yes' : 'no (will retry later)'}`);
        }
        else {
            console.error(`Failed to submit feedback: ${response.statusText}`);
            console.error('Is the instar server running? Try: instar server start');
            process.exit(1);
        }
    }
    catch {
        console.error('Could not connect to instar server. Is it running?');
        console.error('Start it with: instar server start');
        process.exit(1);
    }
});
// ── Telemetry (Baseline) ──────────────────────────────────────────
const telemetryCmd = program
    .command('telemetry')
    .description('Manage Baseline telemetry — anonymous cross-agent metrics');
telemetryCmd
    .command('status')
    .description('Show current Baseline telemetry status')
    .option('-d, --dir <path>', 'Project directory')
    .option('--port <port>', 'Server port (default: 4040)', (v) => parseInt(v, 10))
    .action(async (opts) => {
    const port = opts.port || 4040;
    let authToken;
    try {
        const { loadConfig } = await import('./core/Config.js');
        const config = loadConfig(opts.dir);
        authToken = config.authToken;
    }
    catch { /* project may not be initialized */ }
    try {
        const headers = {};
        if (authToken)
            headers['Authorization'] = `Bearer ${authToken}`;
        const response = await fetch(`http://localhost:${port}/telemetry/status`, {
            headers,
            signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
            const status = await response.json();
            const baseline = status.baseline;
            const pc = (await import('picocolors')).default;
            console.log(pc.bold('Baseline Telemetry'));
            console.log(`  Enabled:       ${status.enabled ? pc.green('yes') : pc.dim('no')}`);
            console.log(`  Provisioned:   ${baseline?.provisioned ? pc.green('yes') : pc.dim('no')}`);
            if (baseline?.installationIdPrefix) {
                console.log(`  Installation:  ${baseline.installationIdPrefix}...`);
            }
            if (baseline?.lastSubmission) {
                console.log(`  Last sent:     ${baseline.lastSubmission}`);
            }
            if (baseline?.nextWindow) {
                console.log(`  Next window:   ${baseline.nextWindow}`);
            }
            if (baseline?.lastErrorCode) {
                console.log(`  Last error:    ${pc.red(String(baseline.lastErrorCode))}`);
            }
        }
        else {
            console.error(`Failed to get status: ${response.statusText}`);
            process.exit(1);
        }
    }
    catch {
        console.error('Could not connect to instar server. Is it running?');
        process.exit(1);
    }
});
telemetryCmd
    .command('enable')
    .description('Enable Baseline — see how your agent compares to the population')
    .option('-d, --dir <path>', 'Project directory')
    .option('--port <port>', 'Server port (default: 4040)', (v) => parseInt(v, 10))
    .action(async (opts) => {
    const port = opts.port || 4040;
    const pc = (await import('picocolors')).default;
    const readline = await import('node:readline');
    // Show consent disclosure
    console.log(pc.bold('\n┌─ Enable Baseline ─────────────────────────────────────────┐'));
    console.log('│                                                            │');
    console.log('│  Baseline helps your agent know if it\'s healthy by         │');
    console.log('│  comparing its behavior to the population — anonymously.   │');
    console.log('│                                                            │');
    console.log(pc.bold('│  What\'s collected:'));
    console.log('│  • Job skip rates (with reasons), durations, results       │');
    console.log('│  • Model usage per job, schedule adherence                 │');
    console.log('│  • Version, uptime, feature flags (curated list only)      │');
    console.log('│  • Session activity (coarse bucket, not exact count)       │');
    console.log('│                                                            │');
    console.log(pc.bold('│  What\'s NEVER collected:'));
    console.log('│  • Names, prompts, memory, conversations, file paths       │');
    console.log('│  • Error messages, IP addresses, Telegram data             │');
    console.log('│  • Security configuration flags                            │');
    console.log('│                                                            │');
    console.log(pc.bold('│  How it works:'));
    console.log('│  • Anonymous ID: random UUID (not derived from your machine)│');
    console.log('│  • Submitted to: instar-telemetry.sagemind-ai.workers.dev  │');
    console.log('│  • Frequency: every 6 hours                                │');
    console.log('│  • Retention: 30 days (local and remote)                   │');
    console.log('│  • Every submission is logged locally for your review:      │');
    console.log('│    run `instar telemetry submissions` to inspect            │');
    console.log('│                                                            │');
    console.log('│  You can disable at any time with `instar telemetry disable`│');
    console.log('│  which deletes your local ID and requests remote deletion. │');
    console.log(pc.bold('└──────────────────────────────────────────────────────────┘\n'));
    // Ask for confirmation
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => {
        rl.question('  Enable Baseline? [y/N] ', resolve);
    });
    rl.close();
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.log(pc.dim('  Declined. No data will be sent.'));
        return;
    }
    let authToken;
    try {
        const { loadConfig } = await import('./core/Config.js');
        const config = loadConfig(opts.dir);
        authToken = config.authToken;
    }
    catch { /* project may not be initialized */ }
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (authToken)
            headers['Authorization'] = `Bearer ${authToken}`;
        const response = await fetch(`http://localhost:${port}/telemetry/enable`, {
            method: 'POST',
            headers,
            signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
            const result = await response.json();
            console.log(pc.green(`\n  ✓ ${result.message}`));
            console.log(pc.dim(`    Installation ID: ${result.installationId}`));
            console.log(pc.dim('    Restart the server for submissions to begin.'));
        }
        else {
            const err = await response.json();
            console.error(pc.red(`  Failed: ${err.error}`));
            process.exit(1);
        }
    }
    catch {
        console.error('Could not connect to instar server. Is it running?');
        process.exit(1);
    }
});
telemetryCmd
    .command('disable')
    .description('Disable Baseline telemetry and delete local identity')
    .option('-d, --dir <path>', 'Project directory')
    .option('--port <port>', 'Server port (default: 4040)', (v) => parseInt(v, 10))
    .action(async (opts) => {
    const port = opts.port || 4040;
    const pc = (await import('picocolors')).default;
    console.log(pc.yellow('\n  Warning: Re-enabling telemetry will create a new identity.'));
    console.log(pc.yellow('  Prior submission history is not recoverable.\n'));
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => {
        rl.question('  Disable Baseline and delete identity? [y/N] ', resolve);
    });
    rl.close();
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.log(pc.dim('  Cancelled.'));
        return;
    }
    let authToken;
    try {
        const { loadConfig } = await import('./core/Config.js');
        const config = loadConfig(opts.dir);
        authToken = config.authToken;
    }
    catch { /* project may not be initialized */ }
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (authToken)
            headers['Authorization'] = `Bearer ${authToken}`;
        const response = await fetch(`http://localhost:${port}/telemetry/disable`, {
            method: 'POST',
            headers,
            signal: AbortSignal.timeout(10000),
        });
        if (response.ok) {
            const result = await response.json();
            console.log(pc.green(`  ✓ ${result.message}`));
            if (result.remoteDeletion !== 'success') {
                console.log(pc.dim(`    Remote deletion: ${result.remoteDeletion}`));
            }
        }
        else {
            const err = await response.json();
            console.error(pc.red(`  Failed: ${err.error}`));
            process.exit(1);
        }
    }
    catch {
        console.error('Could not connect to instar server. Is it running?');
        process.exit(1);
    }
});
telemetryCmd
    .command('submissions')
    .description('View the local transparency log of Baseline submissions')
    .option('-n, --limit <limit>', 'Number of entries to show', (v) => parseInt(v, 10), 10)
    .option('-d, --dir <path>', 'Project directory')
    .option('--port <port>', 'Server port (default: 4040)', (v) => parseInt(v, 10))
    .action(async (opts) => {
    const port = opts.port || 4040;
    let authToken;
    try {
        const { loadConfig } = await import('./core/Config.js');
        const config = loadConfig(opts.dir);
        authToken = config.authToken;
    }
    catch { /* project may not be initialized */ }
    try {
        const headers = {};
        if (authToken)
            headers['Authorization'] = `Bearer ${authToken}`;
        const response = await fetch(`http://localhost:${port}/telemetry/submissions?limit=${opts.limit}`, {
            headers,
            signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
            const { submissions } = await response.json();
            const pc = (await import('picocolors')).default;
            if (submissions.length === 0) {
                console.log(pc.dim('No Baseline submissions yet.'));
                return;
            }
            for (const sub of submissions) {
                const status = sub.responseStatus === 200 ? pc.green('✓') : pc.red(`✗ ${sub.responseStatus}`);
                const jobCount = sub.payload?.jobs?.skips?.length ?? 0;
                console.log(`${status} ${sub.timestamp}  (${jobCount} skip metrics)`);
            }
            console.log(pc.dim(`\nShowing ${submissions.length} most recent. Use --limit for more.`));
        }
        else {
            console.error(`Failed: ${response.statusText}`);
            process.exit(1);
        }
    }
    catch {
        console.error('Could not connect to instar server. Is it running?');
        process.exit(1);
    }
});
telemetryCmd
    .command('purge')
    .description('Request remote data deletion (secret-loss fallback)')
    .option('--force', 'Use unsigned deletion with 72h grace period')
    .option('-d, --dir <path>', 'Project directory')
    .option('--port <port>', 'Server port (default: 4040)', (v) => parseInt(v, 10))
    .action(async (opts) => {
    if (!opts.force) {
        console.error('This command requires --force. It sends an unsigned DELETE with a 72-hour grace period.');
        console.error('Use `instar telemetry disable` for normal deactivation.');
        process.exit(1);
    }
    const pc = (await import('picocolors')).default;
    console.log(pc.yellow('\n  This sends an unsigned DELETE request with a 72-hour grace period.'));
    console.log(pc.yellow('  During those 72 hours, anyone with the original secret can cancel it.\n'));
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => {
        rl.question('  Proceed with unsigned purge? [y/N] ', resolve);
    });
    rl.close();
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.log(pc.dim('  Cancelled.'));
        return;
    }
    // Read install-id from state dir (even if secret is lost)
    let installationId;
    try {
        const { loadConfig } = await import('./core/Config.js');
        const config = loadConfig(opts.dir);
        const { TelemetryAuth } = await import('./monitoring/TelemetryAuth.js');
        const auth = new TelemetryAuth(config.stateDir);
        installationId = auth.getInstallationId() ?? undefined;
    }
    catch { /* best-effort */ }
    if (!installationId) {
        console.error(pc.red('  Cannot find installation ID. No telemetry identity to purge.'));
        process.exit(1);
    }
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(`https://instar-telemetry.sagemind-ai.workers.dev/v1/telemetry/${installationId}`, {
            method: 'DELETE',
            headers: { 'X-Instar-Purge-Reason': 'secret-lost' },
            signal: controller.signal,
        });
        clearTimeout(timeout);
        if (resp.ok) {
            console.log(pc.green('  ✓ Unsigned purge request accepted. Data will be deleted in 72 hours.'));
            console.log(pc.dim('    The original secret holder can cancel this within that window.'));
        }
        else {
            console.error(pc.red(`  Purge request failed: ${resp.status} ${resp.statusText}`));
            process.exit(1);
        }
    }
    catch {
        console.error(pc.red('  Network error — could not reach telemetry endpoint.'));
        process.exit(1);
    }
});
// ── Server ────────────────────────────────────────────────────────
/** Guard: prevent sessions from inadvertently starting/stopping/restarting the server. */
function rejectIfInsideSession(action) {
    if (process.env.INSTAR_SESSION_ID) {
        console.error(pc.red(`Cannot '${action}' from inside a session (session ${process.env.INSTAR_SESSION_ID}).`));
        console.error(pc.dim('The server is managed by the supervisor. Sessions should not start, stop, or restart it.'));
        return true;
    }
    return false;
}
const serverCmd = program
    .command('server')
    .description('Manage the persistent agent server');
serverCmd
    .command('start [name]')
    .description('Start the agent server (optional: standalone agent name)')
    .option('--foreground', 'Run in foreground (default: background via tmux)')
    .option('--no-telegram', 'Skip Telegram polling (use when lifeline manages Telegram)')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (name, opts) => {
    if (rejectIfInsideSession('server start'))
        return;
    if (name && !opts.dir) {
        // Resolve standalone agent name to directory
        const { resolveAgentDir } = await import('./core/Config.js');
        try {
            opts.dir = resolveAgentDir(name);
        }
        catch (err) {
            console.log(pc.red(`Agent "${name}" not found: ${err instanceof Error ? err.message : err}`));
            process.exit(1);
        }
    }
    return startServer(opts);
});
serverCmd
    .command('stop [name]')
    .description('Stop the agent server (optional: standalone agent name)')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (name, opts) => {
    if (rejectIfInsideSession('server stop'))
        return;
    if (name && !opts.dir) {
        const { resolveAgentDir } = await import('./core/Config.js');
        try {
            opts.dir = resolveAgentDir(name);
        }
        catch (err) {
            console.log(pc.red(`Agent "${name}" not found: ${err instanceof Error ? err.message : err}`));
            process.exit(1);
        }
    }
    return stopServer(opts);
});
serverCmd
    .command('restart [name]')
    .description('Restart the agent server (handles launchd/systemd lifecycle)')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (name, opts) => {
    if (rejectIfInsideSession('server restart'))
        return;
    if (name && !opts.dir) {
        const { resolveAgentDir } = await import('./core/Config.js');
        try {
            opts.dir = resolveAgentDir(name);
        }
        catch (err) {
            console.log(pc.red(`Agent "${name}" not found: ${err instanceof Error ? err.message : err}`));
            process.exit(1);
        }
    }
    return restartServer(opts);
});
// ── Status ────────────────────────────────────────────────────────
program
    .command('status [name]')
    .description('Show agent infrastructure status (optional: standalone agent name)')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (name, opts) => {
    if (name && !opts.dir) {
        const { resolveAgentDir } = await import('./core/Config.js');
        try {
            opts.dir = resolveAgentDir(name);
        }
        catch (err) {
            console.log(pc.red(`Agent "${name}" not found: ${err instanceof Error ? err.message : err}`));
            process.exit(1);
        }
    }
    return showStatus(opts);
});
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
    .option('--permissions <perms>', 'Comma-separated permissions', (v) => v.split(','))
    .action(addUser);
userCmd
    .command('list')
    .description('List all users')
    .option('-d, --dir <path>', 'Project directory')
    .action(listUsers);
// ── Relationship ─────────────────────────────────────────────────
const relCmd = program
    .command('relationship')
    .description('Manage relationship records (PROP-166)');
relCmd
    .command('list')
    .description('List all tracked relationships')
    .option('--sort <by>', 'Sort by: significance, recent, name', 'significance')
    .action(listRelationships);
relCmd
    .command('import')
    .description('Import relationships from Portal people-registry export')
    .requiredOption('--file <path>', 'Path to Portal export JSON file')
    .option('--dry-run', 'Preview what would be imported without making changes')
    .action(importRelationships);
relCmd
    .command('export')
    .description('Export relationships for Portal import')
    .option('--file <path>', 'Output file path (stdout if omitted)')
    .option('--min-significance <n>', 'Minimum significance (1-10) to include', '0')
    .action(exportRelationships);
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
    .option('--model <model>', 'Model tier (opus|sonnet|haiku)', 'opus')
    .option('--type <type>', 'Execution type (skill|prompt|script)', 'prompt')
    .option('--execute <value>', 'Execution value (skill name, prompt text, or script path)')
    .action(addJob);
jobCmd
    .command('list')
    .description('List all jobs')
    .option('-d, --dir <path>', 'Project directory')
    .action(listJobs);
jobCmd
    .command('handoff <slug>')
    .description('Write handoff notes for the next execution of a job')
    .requiredOption('--notes <notes>', 'Handoff notes (human-readable context for next execution)')
    .option('--state <json>', 'JSON state snapshot to pass to next execution')
    .option('--run-id <runId>', 'Specific run ID (defaults to most recent pending/active run)')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (slug, opts) => {
    const { jobHandoff } = await import('./commands/job.js');
    await jobHandoff(slug, opts);
});
jobCmd
    .command('history [slug]')
    .description('Show job run history with handoff notes')
    .option('-n, --limit <n>', 'Number of runs to show (default: 10)', (v) => parseInt(v, 10))
    .option('--handoff-only', 'Only show runs with handoff notes')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (slug, opts) => {
    const { jobHistory } = await import('./commands/job.js');
    await jobHistory(slug, opts);
});
jobCmd
    .command('continuity <slug>')
    .description('Show what the next execution of a job will inherit (handoff notes, state)')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (slug, _opts) => {
    const { jobContinuity } = await import('./commands/job.js');
    await jobContinuity(slug);
});
// ── Lifeline ──────────────────────────────────────────────────────
const lifelineCmd = program
    .command('lifeline')
    .description('Manage the Telegram lifeline (persistent Telegram connection)');
lifelineCmd
    .command('start')
    .description('Start the Telegram lifeline (owns Telegram polling, supervises server)')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    const { TelegramLifeline } = await import('./lifeline/TelegramLifeline.js');
    try {
        const lifeline = new TelegramLifeline(opts.dir);
        await lifeline.start();
    }
    catch (err) {
        console.error(pc.red(`Failed to start lifeline: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
    }
});
lifelineCmd
    .command('stop')
    .description('Stop the Telegram lifeline')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    // The lifeline runs in a tmux session — kill it
    const { loadConfig, detectTmuxPath } = await import('./core/Config.js');
    const config = loadConfig(opts.dir);
    const tmuxPath = detectTmuxPath();
    const sessionName = `${config.projectName}-lifeline`;
    if (!tmuxPath) {
        console.log(pc.red('tmux not found'));
        process.exit(1);
    }
    try {
        const { execFileSync } = await import('node:child_process');
        execFileSync(tmuxPath, ['has-session', '-t', `=${sessionName}`], { stdio: 'ignore' });
        execFileSync(tmuxPath, ['send-keys', '-t', `=${sessionName}:`, 'C-c'], { stdio: 'ignore' });
        // Wait briefly for graceful shutdown
        await new Promise(r => setTimeout(r, 3000));
        try {
            execFileSync(tmuxPath, ['kill-session', '-t', `=${sessionName}`], { stdio: 'ignore' });
        }
        catch { /* already dead */ }
        console.log(pc.green(`Lifeline stopped (session: ${sessionName})`));
    }
    catch {
        console.log(pc.yellow(`No lifeline running (no tmux session: ${sessionName})`));
    }
});
lifelineCmd
    .command('status')
    .description('Check lifeline status')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    const { loadConfig, detectTmuxPath } = await import('./core/Config.js');
    const config = loadConfig(opts.dir);
    const tmuxPath = detectTmuxPath();
    const sessionName = `${config.projectName}-lifeline`;
    if (!tmuxPath) {
        console.log(pc.red('tmux not found'));
        process.exit(1);
    }
    try {
        const { execFileSync } = await import('node:child_process');
        execFileSync(tmuxPath, ['has-session', '-t', `=${sessionName}`], { stdio: 'ignore' });
        console.log(pc.green(`Lifeline is running (tmux session: ${sessionName})`));
        console.log(`  Attach: tmux attach -t '=${sessionName}'`);
    }
    catch {
        console.log(pc.yellow('Lifeline is not running'));
        console.log(`  Start: instar lifeline start`);
    }
});
// ── List (replaces Instances) ─────────────────────────────────────
function showAgentList() {
    const agents = listAgents();
    if (agents.length === 0) {
        console.log(pc.dim('No Instar agents registered.'));
        console.log(pc.dim('Start a server with: instar server start'));
        return;
    }
    console.log(pc.bold(`\n  Instar Agents (${agents.length})\n`));
    for (const entry of agents) {
        const age = Math.round((Date.now() - new Date(entry.createdAt).getTime()) / 60000);
        const heartbeatAge = Math.round((Date.now() - new Date(entry.lastHeartbeat).getTime()) / 60000);
        const statusIcon = entry.status === 'running' && heartbeatAge < 3
            ? pc.green('●')
            : entry.status === 'running'
                ? pc.yellow('●')
                : pc.dim('○');
        const typeLabel = entry.type === 'standalone' ? pc.magenta(' [standalone]') : '';
        console.log(`  ${statusIcon} ${pc.bold(entry.name)}${typeLabel}`);
        console.log(`    Port: ${pc.cyan(String(entry.port))}  PID: ${entry.pid}  Status: ${entry.status}  Heartbeat: ${heartbeatAge}m ago`);
        console.log(`    Dir:  ${pc.dim(entry.path)}`);
        console.log();
    }
}
program
    .command('list')
    .description('List all registered agents on this machine')
    .action(showAgentList);
// Hidden alias for backward compatibility
program
    .command('instances', { hidden: true })
    .action(() => {
    console.warn(pc.yellow('⚠ "instar instances" is deprecated. Use "instar list" instead.'));
    showAgentList();
});
// ── Auto-Start ───────────────────────────────────────────────────
const autostartCmd = program
    .command('autostart')
    .description('Manage auto-start on login (agent starts when you log into your computer)');
autostartCmd
    .command('install')
    .description('Install auto-start so your agent starts on login')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    const { loadConfig } = await import('./core/Config.js');
    const { installAutoStart } = await import('./commands/setup.js');
    const config = loadConfig(opts.dir);
    const hasTelegram = config.messaging?.some((m) => m.type === 'telegram') ?? false;
    const installed = installAutoStart(config.projectName, config.projectDir, hasTelegram);
    if (installed) {
        console.log(pc.green(`Auto-start installed for "${config.projectName}".`));
        console.log(pc.dim('Your agent will start automatically when you log in.'));
    }
    else {
        console.log(pc.red('Failed to install auto-start.'));
        console.log(pc.dim(`Platform: ${process.platform} — auto-start supports macOS and Linux.`));
    }
});
autostartCmd
    .command('uninstall')
    .description('Remove auto-start')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    const { loadConfig } = await import('./core/Config.js');
    const { uninstallAutoStart } = await import('./commands/setup.js');
    const config = loadConfig(opts.dir);
    const removed = uninstallAutoStart(config.projectName);
    if (removed) {
        console.log(pc.green(`Auto-start removed for "${config.projectName}".`));
    }
    else {
        console.log(pc.yellow('No auto-start found to remove.'));
    }
});
autostartCmd
    .command('status')
    .description('Check if auto-start is installed')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    const { loadConfig } = await import('./core/Config.js');
    const config = loadConfig(opts.dir);
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    if (process.platform === 'darwin') {
        const label = `ai.instar.${config.projectName}`;
        const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
        if (fs.existsSync(plistPath)) {
            console.log(pc.green(`Auto-start is installed (macOS LaunchAgent: ${label})`));
            console.log(pc.dim(`  Plist: ${plistPath}`));
        }
        else {
            console.log(pc.yellow('Auto-start is not installed.'));
            console.log(pc.dim('  Install with: instar autostart install'));
        }
    }
    else if (process.platform === 'linux') {
        const serviceName = `instar-${config.projectName}.service`;
        const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', serviceName);
        if (fs.existsSync(servicePath)) {
            console.log(pc.green(`Auto-start is installed (systemd user service: ${serviceName})`));
            console.log(pc.dim(`  Service: ${servicePath}`));
        }
        else {
            console.log(pc.yellow('Auto-start is not installed.'));
            console.log(pc.dim('  Install with: instar autostart install'));
        }
    }
    else {
        console.log(pc.yellow(`Auto-start is not supported on ${process.platform}.`));
    }
});
// Hidden command: run post-update migration from the NEW binary
// Called by the auto-updater after `npm install -g` to ensure
// migrations use the latest code, not the old in-memory modules.
program
    .command('migrate')
    .description('Run post-update knowledge migration')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    try {
        const { loadConfig } = await import('./core/Config.js');
        const { PostUpdateMigrator } = await import('./core/PostUpdateMigrator.js');
        const { UpgradeGuideProcessor } = await import('./core/UpgradeGuideProcessor.js');
        const { getInstarVersion } = await import('./core/Config.js');
        const config = loadConfig(opts.dir);
        const hasTelegram = config.messaging?.some((m) => m.type === 'telegram') ?? false;
        // Layer 1: Mechanical migrations (hooks, scripts, CLAUDE.md patches)
        const migrator = new PostUpdateMigrator({
            projectDir: config.projectDir,
            stateDir: config.stateDir,
            port: config.port,
            hasTelegram,
            projectName: config.projectName,
        });
        const result = migrator.migrate();
        // Read previously-migrated version so we only deliver guides for NEW versions
        let previousVersion;
        try {
            const versionFile = path.join(config.stateDir, 'state', 'last-migrated-version.json');
            previousVersion = JSON.parse(fs.readFileSync(versionFile, 'utf-8')).version || undefined;
        }
        catch { /* first run — no previous version */ }
        // Layer 2: Upgrade guide delivery (intelligent knowledge upgrades)
        const guideProcessor = new UpgradeGuideProcessor({
            stateDir: config.stateDir,
            currentVersion: getInstarVersion(),
            previousVersion,
        });
        const guideResult = guideProcessor.process();
        // Combined output for the calling process
        console.log(JSON.stringify({
            ...result,
            upgradeGuide: guideResult.pendingGuides.length > 0 ? {
                versions: guideResult.pendingGuides,
                content: guideResult.guideContent,
                pendingGuidePath: guideResult.pendingGuidePath,
            } : null,
        }));
    }
    catch (err) {
        console.error(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        process.exit(1);
    }
});
// Mark pending upgrade guide as processed (called by agent after reading)
program
    .command('upgrade-ack')
    .description('Acknowledge that upgrade guides have been processed')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    try {
        const { loadConfig } = await import('./core/Config.js');
        const { UpgradeGuideProcessor } = await import('./core/UpgradeGuideProcessor.js');
        const { getInstarVersion } = await import('./core/Config.js');
        const config = loadConfig(opts.dir);
        const processor = new UpgradeGuideProcessor({
            stateDir: config.stateDir,
            currentVersion: getInstarVersion(),
        });
        processor.clearPendingGuide();
        console.log('Upgrade guide acknowledged and cleared.');
    }
    catch (err) {
        console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
});
// ── Multi-Machine ─────────────────────────────────────────────────
const machineCmd = program
    .command('machines')
    .description('List all paired machines and their roles')
    .option('-d, --dir <path>', 'Project directory')
    .action(listMachines);
machineCmd
    .command('remove <name-or-id>')
    .description('Revoke a machine from the mesh')
    .option('-d, --dir <path>', 'Project directory')
    .action(removeMachine);
program
    .command('whoami')
    .description("Show this machine's identity and role")
    .option('-d, --dir <path>', 'Project directory')
    .action(whoami);
program
    .command('pair')
    .description('Generate a pairing code for a new machine')
    .option('-d, --dir <path>', 'Project directory')
    .option('--qr', 'Display pairing info as QR code')
    .action(startPairing);
program
    .command('join <url>')
    .description('Join an existing agent mesh (run on the new machine)')
    .option('--code <code>', 'Pairing code from `instar pair`')
    .option('--name <name>', 'Display name for this machine')
    .action(joinMesh);
program
    .command('wakeup')
    .description('Move the agent to this machine (transfer awake role)')
    .option('-d, --dir <path>', 'Project directory')
    .option('--force', 'Force wakeup without contacting the current awake machine')
    .action(wakeup);
program
    .command('leave')
    .description('Remove this machine from the mesh')
    .option('-d, --dir <path>', 'Project directory')
    .action(leaveMesh);
program
    .command('doctor')
    .description('Diagnose multi-machine health and connectivity')
    .option('-d, --dir <path>', 'Project directory')
    .action(doctor);
// ── Channels ─────────────────────────────────────────────────────
const channelsCmd = program
    .command('channels')
    .description('Manage messaging channel adapters');
channelsCmd
    .command('login <adapter>')
    .description('Authenticate a messaging adapter (e.g., whatsapp)')
    .option('-d, --dir <path>', 'Project directory')
    .option('--method <method>', 'Auth method: qr or pairing-code', 'qr')
    .option('--phone <number>', 'Phone number for pairing code auth')
    .action(async (adapter, opts) => {
    const { channelLogin } = await import('./commands/whatsapp.js');
    return channelLogin(adapter, opts);
});
channelsCmd
    .command('doctor [adapter]')
    .description('Diagnose messaging adapter health')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (adapter, opts) => {
    const { channelDoctor } = await import('./commands/whatsapp.js');
    return channelDoctor(adapter, opts);
});
channelsCmd
    .command('status')
    .description('Show status of all configured messaging adapters')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    const { channelStatus } = await import('./commands/whatsapp.js');
    return channelStatus(opts);
});
// ── System Review ────────────────────────────────────────────────
program
    .command('review')
    .description('Run system review — verify features work end-to-end')
    .option('-d, --dir <path>', 'Project directory')
    .option('-t, --tier <n>', 'Run only probes in this tier (1-5)')
    .option('-p, --probe <id>', 'Run a specific probe by ID')
    .option('--dry-run', 'Show what would run without executing')
    .option('--history', 'Show past review results')
    .option('--trend', 'Show trend analysis across recent reviews')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
    const { review } = await import('./commands/review.js');
    await review(opts);
});
program
    .command('nuke <name>')
    .description('Completely remove a standalone agent and all its data')
    .option('--yes', 'Skip confirmation prompts')
    .action(async (name, opts) => {
    const { nukeAgent } = await import('./commands/nuke.js');
    await nukeAgent(name, { skipConfirm: opts.yes });
});
// ── Playbook (Context Engineering) ───────────────────────────────
const playbookCmd = program
    .command('playbook')
    .description('Context engineering for autonomous AI agents');
playbookCmd
    .command('init')
    .description('Initialize playbook for this project (detect Python, create venv, config)')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    const { playbookInit } = await import('./commands/playbook.js');
    return playbookInit(opts);
});
playbookCmd
    .command('doctor')
    .description('Validate Python, venv, config, manifest, and script accessibility')
    .option('-d, --dir <path>', 'Project directory')
    .option('-v, --verbose', 'Show detailed paths')
    .action(async (opts) => {
    const { playbookDoctor } = await import('./commands/playbook.js');
    return playbookDoctor(opts);
});
playbookCmd
    .command('status')
    .description('Show manifest health, item counts, and chain integrity')
    .option('-d, --dir <path>', 'Project directory')
    .option('--json', 'Machine-readable JSON output')
    .action(async (opts) => {
    const { playbookStatus } = await import('./commands/playbook.js');
    return playbookStatus(opts);
});
playbookCmd
    .command('list')
    .description('List manifest items with filtering')
    .option('--tag <tag>', 'Filter by tag')
    .option('--type <type>', 'Filter by type')
    .option('-d, --dir <path>', 'Project directory')
    .option('--json', 'Machine-readable JSON output')
    .action(async (opts) => {
    const { playbookList } = await import('./commands/playbook.js');
    return playbookList(opts);
});
playbookCmd
    .command('read <itemId>')
    .description('Display a single manifest item')
    .option('-d, --dir <path>', 'Project directory')
    .option('--json', 'Machine-readable JSON output')
    .action(async (itemId, opts) => {
    const { playbookRead } = await import('./commands/playbook.js');
    return playbookRead(itemId, opts);
});
playbookCmd
    .command('add')
    .description('Add a new context item (routed through delta validator)')
    .option('-c, --content <content>', 'Item content')
    .option('-f, --content-file <path>', 'Read content from file')
    .option('--tags <tags>', 'Comma-separated tags')
    .option('--type <type>', 'Item type (strategy, lesson, practice, pattern, ...)')
    .option('--category <category>', 'Item category')
    .option('-d, --dir <path>', 'Project directory')
    .option('--json', 'Machine-readable JSON output')
    .action(async (opts) => {
    const { playbookAdd } = await import('./commands/playbook.js');
    return playbookAdd(opts);
});
playbookCmd
    .command('search <query>')
    .description('Search items by content, tags, or ID')
    .option('-l, --limit <count>', 'Max results', (v) => parseInt(v, 10))
    .option('-d, --dir <path>', 'Project directory')
    .option('--json', 'Machine-readable JSON output')
    .action(async (query, opts) => {
    const { playbookSearch } = await import('./commands/playbook.js');
    return playbookSearch(query, opts);
});
playbookCmd
    .command('assemble')
    .description('Assemble context for a session (the integration point)')
    .option('--tags <tags>', 'Comma-separated tags to match')
    .option('--budget <tokens>', 'Token budget', (v) => parseInt(v, 10))
    .option('--triggers <triggers>', 'Comma-separated trigger types')
    .option('-d, --dir <path>', 'Project directory')
    .option('--json', 'Machine-readable JSON output (includes assembled_text)')
    .action(async (opts) => {
    const { playbookAssemble } = await import('./commands/playbook.js');
    return playbookAssemble(opts);
});
playbookCmd
    .command('evaluate [sessionLog]')
    .description('Evaluate session context usage from a log file')
    .option('--demo', 'Use built-in demo fixture')
    .option('-d, --dir <path>', 'Project directory')
    .option('--json', 'Machine-readable JSON output')
    .action(async (sessionLog, opts) => {
    const { playbookEvaluate } = await import('./commands/playbook.js');
    return playbookEvaluate(sessionLog, opts);
});
playbookCmd
    .command('lifecycle')
    .description('Run full lifecycle pass (decay, dedup, retirement)')
    .option('--dry-run', 'Show what would change without modifying')
    .option('-d, --dir <path>', 'Project directory')
    .option('--json', 'Machine-readable JSON output')
    .action(async (opts) => {
    const { playbookLifecycle } = await import('./commands/playbook.js');
    return playbookLifecycle(opts);
});
playbookCmd
    .command('validate')
    .description('Validate manifest schema + chain integrity')
    .option('-d, --dir <path>', 'Project directory')
    .option('--debug', 'Show full error details')
    .action(async (opts) => {
    const { playbookValidate } = await import('./commands/playbook.js');
    return playbookValidate(opts);
});
playbookCmd
    .command('mount <path>')
    .description('Mount external manifest as read-only overlay')
    .requiredOption('-n, --name <name>', 'Mount name')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (mountPath, opts) => {
    const { playbookMount } = await import('./commands/playbook.js');
    return playbookMount(mountPath, opts);
});
playbookCmd
    .command('unmount <name>')
    .description('Remove a mounted manifest')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (name, opts) => {
    const { playbookUnmount } = await import('./commands/playbook.js');
    return playbookUnmount(name, opts);
});
playbookCmd
    .command('export')
    .description('Export manifest for sharing or backup')
    .option('--format <format>', 'Output format: json or md (default: json)')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (opts) => {
    const { playbookExport } = await import('./commands/playbook.js');
    return playbookExport(opts);
});
playbookCmd
    .command('import <file>')
    .description('Import items (routed through delta validator)')
    .option('-d, --dir <path>', 'Project directory')
    .option('--json', 'Machine-readable JSON output')
    .action(async (filePath, opts) => {
    const { playbookImport } = await import('./commands/playbook.js');
    return playbookImport(filePath, opts);
});
playbookCmd
    .command('eject [scriptName]')
    .description('Copy bundled scripts to local for customization')
    .option('-a, --all', 'Eject all scripts')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (scriptName, opts) => {
    const { playbookEject } = await import('./commands/playbook.js');
    return playbookEject(scriptName, opts);
});
playbookCmd
    .command('user-export <userId>')
    .description('Export all data for a user (DSAR compliance)')
    .option('-d, --dir <path>', 'Project directory')
    .option('--json', 'Machine-readable JSON output')
    .action(async (userId, opts) => {
    const { playbookUserExport } = await import('./commands/playbook.js');
    return playbookUserExport(userId, opts);
});
playbookCmd
    .command('user-delete <userId>')
    .description('Delete all user data (DSAR compliance)')
    .option('--confirm', 'Confirm permanent deletion')
    .option('-d, --dir <path>', 'Project directory')
    .action(async (userId, opts) => {
    const { playbookUserDelete } = await import('./commands/playbook.js');
    return playbookUserDelete(userId, opts);
});
playbookCmd
    .command('user-audit <userId>')
    .description('Audit trail of all operations on user data')
    .option('-d, --dir <path>', 'Project directory')
    .option('--json', 'Machine-readable JSON output')
    .action(async (userId, opts) => {
    const { playbookUserAudit } = await import('./commands/playbook.js');
    return playbookUserAudit(userId, opts);
});
program.parse();
//# sourceMappingURL=cli.js.map