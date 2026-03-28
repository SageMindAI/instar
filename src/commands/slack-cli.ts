/**
 * CLI commands for Slack adapter management.
 *
 * `instar add slack` — Interactive token input (stdin-only for security).
 * `instar remove slack` — Remove config and purge associated data.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import pc from 'picocolors';

function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Add Slack adapter interactively.
 * Tokens are collected via stdin (never as CLI arguments for security).
 */
export async function addSlack(): Promise<void> {
  const configPath = path.join(process.cwd(), '.instar', 'config.json');
  if (!fs.existsSync(configPath)) {
    console.log(pc.red('No .instar/config.json found. Run `instar init` first.'));
    process.exit(1);
  }

  console.log(pc.green('Add Slack Messaging Adapter'));
  console.log();
  console.log('You need two tokens from your Slack app:');
  console.log(`  1. ${pc.cyan('Bot token')} (xoxb-...) — from OAuth & Permissions page`);
  console.log(`  2. ${pc.cyan('App-level token')} (xapp-...) — from Basic Information > App-Level Tokens`);
  console.log();

  const botToken = await readLine('Bot token (xoxb-...): ');
  if (!botToken.startsWith('xoxb-')) {
    console.log(pc.red('Bot token must start with "xoxb-"'));
    process.exit(1);
  }

  const appToken = await readLine('App-level token (xapp-...): ');
  if (!appToken.startsWith('xapp-')) {
    console.log(pc.red('App-level token must start with "xapp-"'));
    process.exit(1);
  }

  // Validate bot token
  console.log(pc.dim('Validating bot token...'));
  try {
    const authResponse = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
    });
    const authData = (await authResponse.json()) as Record<string, unknown>;
    if (!authData.ok) {
      console.log(pc.red(`Bot token validation failed: ${authData.error}`));
      process.exit(1);
    }
    console.log(pc.green(`  Workspace: ${authData.team} (${authData.team_id})`));

    // Validate app token
    console.log(pc.dim('Validating app-level token...'));
    const connResponse = await fetch('https://slack.com/api/apps.connections.open', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${appToken}`,
        'Content-Type': 'application/json',
      },
    });
    const connData = (await connResponse.json()) as Record<string, unknown>;
    if (!connData.ok) {
      console.log(pc.red(`App token validation failed: ${connData.error}`));
      process.exit(1);
    }
    console.log(pc.green('  Socket Mode connection verified'));

    // Read and update config
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let config: any;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      console.log(pc.red('Failed to parse .instar/config.json'));
      process.exit(1);
    }

    if (!config.messaging) config.messaging = [];
    config.messaging = config.messaging.filter((m: { type: string }) => m.type !== 'slack');

    config.messaging.push({
      type: 'slack',
      enabled: true,
      config: {
        botToken,
        appToken,
        workspaceId: authData.team_id,
        workspaceName: authData.team,
        authorizedUserIds: [authData.user_id],
        stallTimeoutMinutes: 5,
        logRetentionDays: 90,
      },
    });

    // Atomic write with restricted permissions
    const tmpPath = configPath + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
      fs.chmodSync(tmpPath, 0o600);
      fs.renameSync(tmpPath, configPath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }

    console.log();
    console.log(pc.green('Slack adapter configured successfully!'));
    console.log(`  Workspace: ${authData.team}`);
    console.log(`  Authorized user: ${authData.user_id}`);
    console.log();
    console.log(`Restart the server to apply: ${pc.cyan('instar server stop && instar server start')}`);

  } catch (err) {
    console.log(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

/**
 * Remove Slack adapter and purge associated data.
 */
export async function removeSlack(): Promise<void> {
  const configPath = path.join(process.cwd(), '.instar', 'config.json');
  if (!fs.existsSync(configPath)) {
    console.log(pc.red('No .instar/config.json found.'));
    process.exit(1);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    console.log(pc.red('Failed to parse .instar/config.json'));
    process.exit(1);
  }

  const hasSlack = config.messaging?.some((m: { type: string }) => m.type === 'slack');
  if (!hasSlack) {
    console.log(pc.yellow('No Slack adapter configured.'));
    return;
  }

  const answer = await readLine(
    pc.yellow('This will remove all Slack config and message history. Continue? (y/N) '),
  );
  if (answer.toLowerCase() !== 'y') {
    console.log('Cancelled.');
    return;
  }

  // Remove from config
  config.messaging = config.messaging.filter((m: { type: string }) => m.type !== 'slack');
  const tmpPath = configPath + `.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  // Purge data files
  const stateDir = path.join(process.cwd(), '.instar');
  const filesToDelete = [
    path.join(stateDir, 'slack-messages.jsonl'),
    path.join(stateDir, 'slack-channels.json'),
  ];
  const dirsToDelete = [
    path.join(stateDir, 'slack-files'),
  ];

  for (const file of filesToDelete) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      console.log(pc.dim(`  Deleted: ${path.basename(file)}`));
    }
  }

  for (const dir of dirsToDelete) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true });
      console.log(pc.dim(`  Deleted: ${path.basename(dir)}/`));
    }
  }

  console.log(pc.green('Slack adapter removed.'));
  console.log(`Restart the server: ${pc.cyan('instar server stop && instar server start')}`);
}
