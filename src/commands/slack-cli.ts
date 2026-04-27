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

// Polyfill WebSocket for Node <22 (global added in Node 22)
if (typeof globalThis.WebSocket === 'undefined') {
  const ws = await import('ws');
  // @ts-expect-error ws package is API-compatible but has different TS types
  globalThis.WebSocket = ws.default;
}

/**
 * Check if Slack event subscriptions are configured by connecting via WebSocket
 * and looking for event-related payloads. A connected WebSocket that receives
 * a hello with connection_info suggests events are wired up.
 */
async function checkEventSubscriptions(wsUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      ws.close();
      resolve(false);
    }, 5000);

    const ws = new WebSocket(wsUrl);

    ws.addEventListener('message', (event: MessageEvent) => {
      try {
        const data = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        // Socket Mode sends a hello event on connect. If it includes
        // connection_info.app_id, the app has event subscriptions configured.
        if (data.type === 'hello' && data.connection_info) {
          clearTimeout(timeout);
          ws.close();
          resolve(true);
        }
      } catch { /* ignore parse errors */ }
    });

    ws.addEventListener('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

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
 * Generate a Slack app manifest with all required scopes and event subscriptions.
 * Users can paste this into Slack's "Create from manifest" flow to get a
 * correctly-configured app in one step.
 */
export function generateSlackManifest(agentName: string): Record<string, unknown> {
  return {
    display_information: {
      name: agentName,
      description: `Instar agent: ${agentName}`,
    },
    features: {
      bot_user: {
        display_name: agentName,
        always_online: true,
      },
    },
    oauth_config: {
      scopes: {
        bot: [
          'app_mentions:read',
          'channels:history',
          'channels:join',
          'channels:manage',
          'channels:read',
          'chat:write',
          'files:read',
          'groups:history',
          'im:history',
          'im:read',
          'im:write',
          'pins:write',
          'reactions:read',
          'reactions:write',
          'users:read',
        ],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: [
          'message.channels',
          'message.groups',
          'message.im',
          'app_mention',
        ],
      },
      interactivity: {
        is_enabled: false,
      },
      socket_mode_enabled: true,
    },
  };
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

  // Read agent name from config for manifest generation
  let agentName = 'instar-agent';
  try {
    const existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    agentName = existingConfig.projectName || existingConfig.identity?.name || 'instar-agent';
  } catch { /* use default */ }

  console.log(pc.green('Add Slack Messaging Adapter'));
  console.log();
  console.log('Create a Slack app with the correct scopes using this manifest:');
  console.log(`  ${pc.cyan('https://api.slack.com/apps?new_app=1')} → "From a manifest" → JSON tab`);
  console.log();
  console.log(pc.dim(JSON.stringify(generateSlackManifest(agentName), null, 2)));
  console.log();
  console.log('After creating the app:');
  console.log('  1. Install it to your workspace');
  console.log('  2. Create an app-level token (Basic Information → App-Level Tokens → connections:write)');
  console.log();
  console.log('Then enter the two tokens:');
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

    // Check OAuth scopes — warn about missing required scopes
    const REQUIRED_SCOPES = [
      'app_mentions:read', 'channels:history', 'channels:join', 'channels:manage',
      'channels:read', 'chat:write', 'files:read', 'groups:history', 'im:history',
      'im:read', 'im:write', 'pins:write', 'reactions:read', 'reactions:write', 'users:read',
    ];
    const scopeHeader = authResponse.headers.get('x-oauth-scopes') ?? '';
    const grantedScopes = scopeHeader.split(',').map(s => s.trim()).filter(Boolean);
    const missingScopes = REQUIRED_SCOPES.filter(s => !grantedScopes.includes(s));

    if (missingScopes.length > 0) {
      console.log();
      console.log(pc.yellow(`⚠  Bot token is missing ${missingScopes.length} required scope(s):`));
      for (const scope of missingScopes) {
        console.log(pc.yellow(`   • ${scope}`));
      }
      console.log();
      console.log('   Add these scopes in your Slack app:');
      console.log(`   ${pc.cyan('https://api.slack.com/apps')} → Your App → OAuth & Permissions → Scopes`);
      console.log('   After adding scopes, reinstall the app to your workspace.');
      console.log();
      if (missingScopes.includes('files:read')) {
        console.log(pc.yellow('   ⚠  Without files:read, file/snippet/Post content will not be readable.'));
      }
      console.log();
    } else {
      console.log(pc.green(`  All ${REQUIRED_SCOPES.length} required scopes present`));
    }

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
      // safe-git-allow: incremental-migration
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }

    console.log();
    console.log(pc.green('Slack adapter configured successfully!'));
    console.log(`  Workspace: ${authData.team}`);
    console.log(`  Authorized user: ${authData.user_id}`);
    console.log();

    // Check if event subscriptions are configured by connecting via WebSocket
    // and waiting briefly for the hello event
    console.log(pc.dim('Checking event subscriptions...'));
    const wsUrl = connData.url as string;
    let eventsConfigured = false;
    try {
      eventsConfigured = await checkEventSubscriptions(wsUrl);
    } catch { /* best-effort check */ }

    if (!eventsConfigured) {
      console.log();
      console.log(pc.yellow('⚠  Event subscriptions may not be configured.'));
      console.log(pc.yellow('   Your bot can send messages but won\'t receive them without event subscriptions.'));
      console.log();
      console.log('   Go to: ' + pc.cyan(`https://api.slack.com/apps → Your App → Event Subscriptions`));
      console.log('   1. Enable Events');
      console.log('   2. Subscribe to bot events:');
      console.log(`      ${pc.dim('message.channels')}  — messages in public channels`);
      console.log(`      ${pc.dim('message.groups')}    — messages in private channels`);
      console.log(`      ${pc.dim('message.im')}        — direct messages`);
      console.log(`      ${pc.dim('app_mention')}       — @mentions of your bot`);
      console.log('   3. Save Changes');
      console.log();
      console.log('   Or recreate the app using a manifest (includes subscriptions automatically):');
      console.log(`   ${pc.cyan('https://api.slack.com/apps?new_app=1')}`);
      console.log();
    } else {
      console.log(pc.green('  Event subscriptions are configured'));
    }

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
    // safe-git-allow: incremental-migration
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
      // safe-git-allow: incremental-migration
      fs.unlinkSync(file);
      console.log(pc.dim(`  Deleted: ${path.basename(file)}`));
    }
  }

  for (const dir of dirsToDelete) {
    if (fs.existsSync(dir)) {
      // safe-git-allow: incremental-migration
      fs.rmSync(dir, { recursive: true });
      console.log(pc.dim(`  Deleted: ${path.basename(dir)}/`));
    }
  }

  console.log(pc.green('Slack adapter removed.'));
  console.log(`Restart the server: ${pc.cyan('instar server stop && instar server start')}`);
}
