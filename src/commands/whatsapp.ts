/**
 * WhatsApp CLI commands — add, login, doctor, status.
 */

import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { loadConfig } from '../core/Config.js';
import { isEncryptedFile } from '../messaging/shared/EncryptedAuthStore.js';

/**
 * Check if Baileys is importable. Uses dynamic import() instead of require.resolve()
 * because require.resolve() fails in npx context — it resolves relative to the
 * npx cache directory, not the user's project. Dynamic import() correctly searches
 * the full module resolution chain including the user's node_modules.
 *
 * Prefers v7 (baileys) over deprecated v6 (@whiskeysockets/baileys).
 */
async function isBaileysInstalled(): Promise<{ installed: boolean; packageName: string | null }> {
  // Try v7 first (preferred — v6 is deprecated and has protocol issues)
  try {
    await import('baileys');
    return { installed: true, packageName: 'baileys' };
  } catch {
    // Fall back to deprecated v6 package name
    try {
      // @ts-expect-error — Baileys v6 uses different package name
      await import('@whiskeysockets/baileys');
      return { installed: true, packageName: '@whiskeysockets/baileys' };
    } catch {
      return { installed: false, packageName: null };
    }
  }
}

// ── instar add whatsapp ──────────────────────────────────────

interface AddWhatsAppOptions {
  backend?: string;
  authMethod?: string;
  phone?: string;
  authorized?: string;
  encrypt?: boolean;
  // Business API options
  phoneNumberId?: string;
  accessToken?: string;
  webhookVerifyToken?: string;
  webhookPort?: number;
}

export async function addWhatsApp(opts: AddWhatsAppOptions): Promise<void> {
  const configPath = path.join(process.cwd(), '.instar', 'config.json');
  if (!fs.existsSync(configPath)) {
    console.log(pc.red('No .instar/config.json found. Run `instar init` first.'));
    process.exit(1);
  }

  const backend = opts.backend ?? 'baileys';
  if (backend !== 'baileys' && backend !== 'business-api') {
    console.log(pc.red(`Unknown backend: "${backend}". Use "baileys" or "business-api".`));
    process.exit(1);
  }

  if (backend === 'business-api' && (!opts.phoneNumberId || !opts.accessToken || !opts.webhookVerifyToken)) {
    console.log(pc.red('Business API requires --phone-number-id, --access-token, and --webhook-verify-token.'));
    console.log('Example: instar add whatsapp --backend business-api \\');
    console.log('  --phone-number-id 123456789 \\');
    console.log('  --access-token EAAx... \\');
    console.log('  --webhook-verify-token my-secret');
    process.exit(1);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    console.log(pc.red('Failed to parse .instar/config.json.'));
    process.exit(1);
  }

  if (!config.messaging) config.messaging = [];

  // Remove existing WhatsApp config if any
  config.messaging = config.messaging.filter((m: { type: string }) => m.type !== 'whatsapp');

  const authMethod = opts.authMethod ?? 'qr';
  if (authMethod !== 'qr' && authMethod !== 'pairing-code') {
    console.log(pc.red(`Unknown auth method: "${authMethod}". Use "qr" or "pairing-code".`));
    process.exit(1);
  }

  if (authMethod === 'pairing-code' && !opts.phone) {
    console.log(pc.red('--phone is required for pairing-code auth method.'));
    console.log('Example: instar add whatsapp --auth-method pairing-code --phone +14155552671');
    process.exit(1);
  }

  const authorizedNumbers = opts.authorized
    ? opts.authorized.split(',').map(n => n.trim()).filter(Boolean)
    : [];

  const waConfig: Record<string, unknown> = {
    backend,
    authorizedNumbers,
  };

  if (backend === 'baileys') {
    waConfig.baileys = {
      authMethod,
      ...(opts.phone && { pairingPhoneNumber: opts.phone }),
      ...(opts.encrypt && { encryptAuth: true }),
    };
  } else if (backend === 'business-api') {
    waConfig.businessApi = {
      phoneNumberId: opts.phoneNumberId,
      accessToken: opts.accessToken,
      webhookVerifyToken: opts.webhookVerifyToken,
      ...(opts.webhookPort && { webhookPort: opts.webhookPort }),
    };
  }

  config.messaging.push({
    type: 'whatsapp',
    enabled: true,
    config: waConfig,
  });

  const tmpPath = configPath + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    // safe-git-allow: incremental-migration
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  console.log(pc.green('WhatsApp adapter configured successfully!'));
  console.log(`  Backend: ${backend}`);
  if (authorizedNumbers.length > 0) {
    console.log(`  Authorized: ${authorizedNumbers.join(', ')}`);
  } else {
    console.log(`  Authorized: all users (no restrictions)`);
  }

  if (backend === 'baileys') {
    console.log(`  Auth method: ${authMethod}`);
    if (opts.encrypt) {
      console.log(`  Auth encryption: ${pc.green('enabled')}`);
    }
    console.log();

    // Check if Baileys is installed
    const baileysCheck = await isBaileysInstalled();
    if (!baileysCheck.installed) {
      console.log(pc.yellow('Baileys is not installed. Install it:'));
      console.log(`  npm install @whiskeysockets/baileys`);
      console.log();
    }

    console.log('Next steps:');
    console.log(`  1. ${pc.cyan('instar channels login whatsapp')} — Authenticate with WhatsApp`);
    console.log(`  2. Restart the server: ${pc.cyan('instar server stop && instar server start')}`);
  } else {
    console.log(`  Phone Number ID: ${opts.phoneNumberId}`);
    console.log(`  Webhook verify token: ${opts.webhookVerifyToken}`);
    console.log();

    console.log('Next steps:');
    console.log(`  1. Configure your Meta webhook URL to point to your server's ${pc.cyan('/webhooks/whatsapp')} endpoint`);
    console.log(`  2. Restart the server: ${pc.cyan('instar server stop && instar server start')}`);
    console.log();
    console.log(pc.yellow('Note: Business API requires a publicly accessible HTTPS endpoint.'));
    console.log('If running locally, use Cloudflare Tunnel or ngrok to expose the webhook URL.');
  }
}

// ── instar channels login <adapter> ──────────────────────────

interface ChannelLoginOptions {
  dir?: string;
  method?: string;
  phone?: string;
}

export async function channelLogin(adapter: string, opts: ChannelLoginOptions): Promise<void> {
  if (adapter !== 'whatsapp') {
    console.log(pc.red(`Unknown adapter: "${adapter}". Currently supported: whatsapp`));
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig(opts.dir);
  } catch {
    console.log(pc.red('Not initialized. Run `instar init` first.'));
    process.exit(1);
  }

  const waConfig = config.messaging?.find(m => m.type === 'whatsapp');
  if (!waConfig) {
    console.log(pc.red('WhatsApp is not configured. Run `instar add whatsapp` first.'));
    process.exit(1);
  }

  // Check if Baileys is installed
  const baileysCheck = await isBaileysInstalled();
  if (!baileysCheck.installed) {
    console.log(pc.red('Baileys is not installed.'));
    console.log(`Run: ${pc.cyan('npm install @whiskeysockets/baileys')}`);
    process.exit(1);
  }

  const authMethod = opts.method ?? (waConfig.config as any).baileys?.authMethod ?? 'qr';
  const authDir = path.join(config.stateDir, 'whatsapp-auth');

  console.log(pc.bold('\n  WhatsApp Login\n'));

  if (authMethod === 'qr') {
    console.log('A QR code will appear in the terminal.');
    console.log('Open WhatsApp on your phone > Settings > Linked Devices > Link a Device');
    console.log('Scan the QR code to authenticate.\n');
  } else {
    console.log('An 8-digit pairing code will be displayed.');
    console.log('Open WhatsApp on your phone > Settings > Linked Devices > Link a Device');
    console.log('Choose "Link with phone number instead" and enter the code.\n');
  }

  // Dynamic import of BaileysBackend
  const { BaileysBackend } = await import('../messaging/backends/BaileysBackend.js');
  const { WhatsAppAdapter } = await import('../messaging/WhatsAppAdapter.js');

  const adapter_ = new WhatsAppAdapter(waConfig.config, config.stateDir);

  const backend = new BaileysBackend(adapter_, adapter_.getBaileysConfig(), {
    onQrCode: (qr) => {
      console.log(pc.cyan('QR Code received — scan it with your phone:'));
      // The Baileys printQRInTerminal option will print to terminal directly
      console.log(`(QR data: ${qr.substring(0, 20)}...)\n`);
    },
    onPairingCode: (code) => {
      console.log(pc.green(`Pairing code: ${pc.bold(code)}`));
      console.log('Enter this code in WhatsApp on your phone.\n');
    },
    onConnected: (phoneNumber) => {
      console.log(pc.green(`\nConnected as ${phoneNumber}!`));
      console.log(`Auth state saved to: ${authDir}`);
      console.log(`\nRestart the server to begin: ${pc.cyan('instar server stop && instar server start')}`);
      process.exit(0);
    },
    onDisconnected: (reason, shouldReconnect) => {
      if (!shouldReconnect) {
        console.log(pc.red(`\nDisconnected: ${reason}`));
        process.exit(1);
      }
      console.log(pc.yellow(`Disconnected: ${reason}. Reconnecting...`));
    },
    onMessage: () => {}, // Ignore messages during login
    onError: (error) => {
      console.log(pc.red(`\nError: ${error.message}`));
      process.exit(1);
    },
  });

  console.log('Connecting...\n');
  await backend.connect();

  // Keep the process alive for QR scanning
  await new Promise(() => {}); // Block forever — process.exit() in onConnected/onError
}

// ── instar channels doctor [adapter] ─────────────────────────

interface ChannelDoctorOptions {
  dir?: string;
}

export async function channelDoctor(adapter: string | undefined, opts: ChannelDoctorOptions): Promise<void> {
  let config;
  try {
    config = loadConfig(opts.dir);
  } catch {
    console.log(pc.red('Not initialized. Run `instar init` first.'));
    process.exit(1);
  }

  const checks: Array<{ name: string; status: 'ok' | 'warn' | 'fail'; detail: string }> = [];

  console.log(pc.bold('\n  Channel Diagnostics\n'));

  const adapters = adapter ? [adapter] : ['telegram', 'whatsapp'];

  for (const adapterType of adapters) {
    const adapterConfig = config.messaging?.find(m => m.type === adapterType);

    if (!adapterConfig) {
      if (adapter) {
        checks.push({ name: `${adapterType} config`, status: 'fail', detail: `Not configured. Run \`instar add ${adapterType}\`` });
      }
      continue;
    }

    checks.push({ name: `${adapterType} config`, status: adapterConfig.enabled ? 'ok' : 'warn', detail: adapterConfig.enabled ? 'Configured and enabled' : 'Configured but disabled' });

    if (adapterType === 'whatsapp') {
      const waConf = adapterConfig.config as any;

      // Check backend
      checks.push({ name: 'WhatsApp backend', status: 'ok', detail: waConf.backend ?? 'baileys' });

      const currentBackend = waConf.backend ?? 'baileys';

      // Backend-specific checks
      if (currentBackend === 'baileys') {
        const doctorBaileysCheck = await isBaileysInstalled();
        if (doctorBaileysCheck.installed) {
          checks.push({ name: 'Baileys installed', status: 'ok', detail: `Found (${doctorBaileysCheck.packageName})` });
        } else {
          checks.push({ name: 'Baileys installed', status: 'fail', detail: 'Not installed. Run: npm install @whiskeysockets/baileys' });
        }

        // Check auth state
        const authDir = waConf.baileys?.authDir ?? path.join(config.stateDir, 'whatsapp-auth');
        const credsFile = path.join(authDir, 'creds.json');
        if (fs.existsSync(credsFile)) {
          const encrypted = isEncryptedFile(credsFile);
          checks.push({
            name: 'Auth state',
            status: 'ok',
            detail: `Credentials found${encrypted ? ' (encrypted)' : ' (unencrypted)'}`,
          });

          if (!encrypted && waConf.baileys?.encryptAuth) {
            checks.push({ name: 'Auth encryption', status: 'warn', detail: 'Encryption enabled in config but credentials are not encrypted. Re-authenticate to encrypt.' });
          }
        } else {
          checks.push({ name: 'Auth state', status: 'warn', detail: `No credentials. Run \`instar channels login whatsapp\`` });
        }

        // Check auth method
        const method = waConf.baileys?.authMethod ?? 'qr';
        checks.push({ name: 'Auth method', status: 'ok', detail: method });

        if (method === 'pairing-code' && !waConf.baileys?.pairingPhoneNumber) {
          checks.push({ name: 'Pairing phone', status: 'fail', detail: 'pairing-code auth requires pairingPhoneNumber in config' });
        }
      } else if (currentBackend === 'business-api') {
        const apiConf = waConf.businessApi;

        // Check required Business API fields
        checks.push({
          name: 'Phone Number ID',
          status: apiConf?.phoneNumberId ? 'ok' : 'fail',
          detail: apiConf?.phoneNumberId ? `${String(apiConf.phoneNumberId).slice(0, 8)}...` : 'Missing — required for Business API',
        });

        checks.push({
          name: 'Access token',
          status: apiConf?.accessToken ? 'ok' : 'fail',
          detail: apiConf?.accessToken ? `${String(apiConf.accessToken).slice(0, 8)}...` : 'Missing — required for Business API',
        });

        checks.push({
          name: 'Webhook verify token',
          status: apiConf?.webhookVerifyToken ? 'ok' : 'fail',
          detail: apiConf?.webhookVerifyToken ? 'Configured' : 'Missing — required for webhook verification',
        });

        // Webhook port
        if (apiConf?.webhookPort) {
          checks.push({ name: 'Webhook port', status: 'ok', detail: `Port ${apiConf.webhookPort}` });
        } else {
          checks.push({ name: 'Webhook port', status: 'ok', detail: 'Using Instar server port (default)' });
        }
      }

      // Check authorized numbers
      const authNumbers = waConf.authorizedNumbers ?? [];
      if (authNumbers.length > 0) {
        checks.push({ name: 'Authorized users', status: 'ok', detail: `${authNumbers.length} number(s) configured` });
      } else {
        checks.push({ name: 'Authorized users', status: 'warn', detail: 'No restrictions — all users can message. Set authorizedNumbers to restrict.' });
      }

      // Check consent records
      const consentPath = path.join(config.stateDir, 'whatsapp', 'consent.json');
      if (fs.existsSync(consentPath)) {
        try {
          const records = JSON.parse(fs.readFileSync(consentPath, 'utf-8'));
          checks.push({ name: 'Privacy consent', status: 'ok', detail: `${records.length} consent record(s)` });
        } catch {
          checks.push({ name: 'Privacy consent', status: 'warn', detail: 'Consent file exists but is unreadable' });
        }
      } else {
        checks.push({ name: 'Privacy consent', status: 'ok', detail: 'No records yet (first-contact prompt will trigger)' });
      }
    }

    if (adapterType === 'telegram') {
      const tgConf = adapterConfig.config as any;
      checks.push({ name: 'Telegram token', status: tgConf.token ? 'ok' : 'fail', detail: tgConf.token ? `${String(tgConf.token).slice(0, 8)}...` : 'Missing' });
      checks.push({ name: 'Telegram chat ID', status: tgConf.chatId ? 'ok' : 'fail', detail: tgConf.chatId ? String(tgConf.chatId) : 'Missing' });
    }
  }

  // Display results
  for (const check of checks) {
    const icon = check.status === 'ok' ? pc.green('OK') : check.status === 'warn' ? pc.yellow('WARN') : pc.red('FAIL');
    console.log(`  [${icon}] ${check.name}: ${check.detail}`);
  }

  const fails = checks.filter(c => c.status === 'fail');
  const warns = checks.filter(c => c.status === 'warn');
  console.log();
  if (fails.length > 0) {
    console.log(pc.red(`  ${fails.length} issue(s) need attention.`));
  } else if (warns.length > 0) {
    console.log(pc.yellow(`  ${warns.length} warning(s). Everything functional.`));
  } else if (checks.length > 0) {
    console.log(pc.green('  All checks passed.'));
  } else {
    console.log('  No messaging adapters configured.');
  }
}

// ── instar channels status ───────────────────────────────────

interface ChannelStatusOptions {
  dir?: string;
}

export async function channelStatus(opts: ChannelStatusOptions): Promise<void> {
  let config;
  try {
    config = loadConfig(opts.dir);
  } catch {
    console.log(pc.red('Not initialized. Run `instar init` first.'));
    process.exit(1);
  }

  console.log(pc.bold('\n  Messaging Channels\n'));

  const adapters = config.messaging ?? [];
  if (adapters.length === 0) {
    console.log('  No messaging adapters configured.');
    console.log(`  Add one: ${pc.cyan('instar add telegram')} or ${pc.cyan('instar add whatsapp')}`);
    return;
  }

  for (const adapter of adapters) {
    const status = adapter.enabled ? pc.green('enabled') : pc.red('disabled');
    console.log(`  ${pc.bold(adapter.type)} [${status}]`);

    if (adapter.type === 'whatsapp') {
      const conf = adapter.config as any;
      const whatsappBackend = conf.backend ?? 'baileys';
      console.log(`    Backend: ${whatsappBackend}`);

      if (whatsappBackend === 'baileys') {
        console.log(`    Auth: ${conf.baileys?.authMethod ?? 'qr'}`);
        const authDir = conf.baileys?.authDir ?? path.join(config.stateDir, 'whatsapp-auth');
        const hasCreds = fs.existsSync(path.join(authDir, 'creds.json'));
        console.log(`    Authenticated: ${hasCreds ? pc.green('yes') : pc.yellow('no')}`);
      } else if (whatsappBackend === 'business-api') {
        const apiConf = conf.businessApi;
        console.log(`    Phone Number ID: ${apiConf?.phoneNumberId ? `${String(apiConf.phoneNumberId).slice(0, 8)}...` : pc.red('missing')}`);
        console.log(`    Access token: ${apiConf?.accessToken ? pc.green('configured') : pc.red('missing')}`);
        console.log(`    Webhook: ${apiConf?.webhookVerifyToken ? pc.green('configured') : pc.red('missing')}`);
      }
    }

    if (adapter.type === 'telegram') {
      const conf = adapter.config as any;
      console.log(`    Token: ${conf.token ? `${String(conf.token).slice(0, 8)}...` : pc.red('missing')}`);
      console.log(`    Chat ID: ${conf.chatId ?? pc.red('missing')}`);
    }

    console.log();
  }
}
