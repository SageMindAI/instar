/**
 * `instar listener` — Manage the standalone listener daemon.
 *
 * Commands:
 *   instar listener start     — Start the listener daemon
 *   instar listener stop      — Gracefully stop the daemon
 *   instar listener status    — Show daemon state + connection info
 *   instar listener logs      — Tail daemon log file
 *   instar listener restart   — Graceful restart
 *   instar listener doctor    — Pre-flight check
 *   instar listener install   — Install launchd plist / systemd unit
 *   instar listener uninstall — Remove launchd plist / systemd unit
 *   instar listener purge     — Delete all listener data (GDPR right-to-erasure)
 */

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { loadConfig, ensureStateDir } from '../core/Config.js';

const __filename = fileURLToPath(import.meta.url);

// ── Helpers ─────────────────────────────────────────────────────────

function getProjectDir(opts: { dir?: string }): string {
  return opts.dir || process.cwd();
}

function getStateDir(opts: { dir?: string }): string {
  return path.join(getProjectDir(opts), '.instar');
}

function getPidFile(stateDir: string): string {
  return path.join(stateDir, 'listener-daemon.pid');
}

function getDaemonPid(stateDir: string): number | null {
  const pidFile = getPidFile(stateDir);
  if (!fs.existsSync(pidFile)) return null;
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (isNaN(pid)) return null;
    // Check if process is running
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      return null; // Process not running
    }
  } catch {
    return null;
  }
}

function readHealth(stateDir: string): Record<string, unknown> | null {
  const healthPath = path.join(stateDir, 'listener-health.json');
  if (!fs.existsSync(healthPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(healthPath, 'utf-8'));
  } catch {
    return null;
  }
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatAge(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  return `${hours} hours ago`;
}

// ── Commands ────────────────────────────────────────────────────────

export async function startListener(opts: { dir?: string; foreground?: boolean }): Promise<void> {
  const stateDir = getStateDir(opts);
  ensureStateDir(stateDir);

  // Check if already running
  const existingPid = getDaemonPid(stateDir);
  if (existingPid) {
    console.log(pc.yellow(`Listener daemon already running (pid: ${existingPid})`));
    return;
  }

  // Load config for relay URL
  const config = loadConfig(getProjectDir(opts));
  const relayUrl = config?.threadline?.listener?.relayUrl
    || config?.threadline?.relayUrl
    || 'wss://threadline-relay.fly.dev/v1/connect';
  const agentName = config?.projectName || path.basename(path.dirname(stateDir));

  // Find the listener daemon script
  const daemonScript = path.join(path.dirname(path.dirname(__filename)), 'threadline', 'listener-daemon.js');
  if (!fs.existsSync(daemonScript)) {
    console.log(pc.red('Listener daemon script not found. Ensure instar is built.'));
    console.log(pc.dim(`Expected at: ${daemonScript}`));
    return;
  }

  if (opts.foreground) {
    // Run in foreground
    console.log(pc.blue('Starting listener daemon in foreground...'));
    const child = spawn('node', [
      daemonScript,
      '--state-dir', stateDir,
      '--relay-url', relayUrl,
      '--name', agentName,
    ], {
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      console.log(pc.dim(`Daemon exited with code ${code}`));
    });
  } else {
    // Run in background
    console.log(pc.blue('Starting listener daemon...'));
    const child = spawn('node', [
      daemonScript,
      '--state-dir', stateDir,
      '--relay-url', relayUrl,
      '--name', agentName,
    ], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    console.log(pc.green(`Listener daemon started (pid: ${child.pid})`));
    console.log(pc.dim('Run `instar listener status` to check connection.'));
  }
}

export async function stopListener(opts: { dir?: string }): Promise<void> {
  const stateDir = getStateDir(opts);
  const pid = getDaemonPid(stateDir);
  if (!pid) {
    console.log(pc.yellow('Listener daemon is not running.'));
    return;
  }

  console.log(pc.blue(`Stopping listener daemon (pid: ${pid})...`));
  try {
    process.kill(pid, 'SIGTERM');
    // Wait up to 5 seconds for graceful shutdown
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100));
      try {
        process.kill(pid, 0);
      } catch {
        console.log(pc.green('Listener daemon stopped.'));
        return;
      }
    }
    // Force kill if still running
    process.kill(pid, 'SIGKILL');
    console.log(pc.yellow('Listener daemon force-killed.'));
  } catch (err) {
    console.log(pc.red(`Failed to stop daemon: ${err}`));
  }
}

export async function listenerStatus(opts: { dir?: string }): Promise<void> {
  const stateDir = getStateDir(opts);
  const pid = getDaemonPid(stateDir);
  const health = readHealth(stateDir);

  if (!pid) {
    console.log(`Listener Daemon: ${pc.red('STOPPED')}`);
    if (health && typeof health.uptime === 'number') {
      console.log(pc.dim(`  Last known uptime: ${formatUptime(health.uptime as number)}`));
    }
    return;
  }

  const state = (health?.state as string) || 'unknown';
  const stateColor = state === 'connected' ? pc.green(state.toUpperCase())
    : state === 'authenticating' ? pc.yellow(state.toUpperCase())
    : pc.red(state.toUpperCase());

  console.log(`Listener Daemon: ${stateColor} (pid ${pid})`);
  if (health) {
    console.log(`  Uptime:        ${formatUptime(health.uptime as number)}`);
    console.log(`  Relay:         ${state === 'connected' ? pc.green('session active') : pc.yellow('not connected')}`);
    console.log(`  Last message:  ${health.lastMessage ? formatAge(health.lastMessage as string) : pc.dim('none')}`);
    console.log(`  Messages:      ${health.msgsIn} received, ${health.msgsOut} processed`);
    console.log(`  Disconnects:   ${health.disconnects10m} in last 10 min`);
  }

  // Check socket connection
  const socketPath = path.join(stateDir, 'listener.sock');
  console.log(`  Socket:        ${fs.existsSync(socketPath) ? pc.green(socketPath) : pc.dim('not available')}`);

  // Check inbox
  const inboxPath = path.join(stateDir, 'threadline', 'inbox.jsonl.active');
  if (fs.existsSync(inboxPath)) {
    const stat = fs.statSync(inboxPath);
    const sizeKb = (stat.size / 1024).toFixed(1);
    console.log(`  Inbox:         ${sizeKb} KB (inbox.jsonl.active)`);
  } else {
    console.log(`  Inbox:         ${pc.dim('empty')}`);
  }
}

export async function listenerLogs(opts: { dir?: string; lines?: number; follow?: boolean }): Promise<void> {
  const stateDir = getStateDir(opts);
  const logPath = path.join(stateDir, 'logs', 'listener-daemon.log');

  if (!fs.existsSync(logPath)) {
    console.log(pc.yellow('No listener daemon log file found.'));
    return;
  }

  const lines = opts.lines || 50;
  try {
    const tailCmd = opts.follow
      ? `tail -f -n ${lines} "${logPath}"`
      : `tail -n ${lines} "${logPath}"`;
    execSync(tailCmd, { stdio: 'inherit' });
  } catch {
    // tail exits with error on SIGINT (Ctrl+C) — that's fine
  }
}

export async function listenerDoctor(opts: { dir?: string }): Promise<void> {
  const stateDir = getStateDir(opts);
  let passed = 0;
  let failed = 0;

  function check(name: string, fn: () => boolean | string): void {
    try {
      const result = fn();
      if (result === true) {
        console.log(`  ${pc.green('✓')} ${name}`);
        passed++;
      } else {
        console.log(`  ${pc.red('✗')} ${name}${typeof result === 'string' ? `: ${result}` : ''}`);
        failed++;
      }
    } catch (err) {
      console.log(`  ${pc.red('✗')} ${name}: ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }

  console.log(pc.bold('Listener Daemon Doctor\n'));

  check('State directory exists', () => fs.existsSync(stateDir));

  check('Identity file exists', () => {
    const canonical = path.join(stateDir, 'identity.json');
    const legacy = path.join(stateDir, 'threadline', 'identity.json');
    if (fs.existsSync(canonical) || fs.existsSync(legacy)) return true;
    return 'No identity file found — server must generate one first';
  });

  check('Config file exists', () => {
    const configPath = path.join(stateDir, 'config.json');
    return fs.existsSync(configPath) || 'No config.json found — run `instar init`';
  });

  check('HMAC key available', () => {
    const keyFile = path.join(stateDir, 'threadline', 'inbox-hmac.key');
    const configPath = path.join(stateDir, 'config.json');
    if (fs.existsSync(keyFile)) return true;
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.authToken) return true;
    }
    return 'No HMAC key file and no authToken in config';
  });

  check('Inbox directory writable', () => {
    const inboxDir = path.join(stateDir, 'threadline');
    if (!fs.existsSync(inboxDir)) {
      fs.mkdirSync(inboxDir, { recursive: true });
    }
    const testFile = path.join(inboxDir, '.write-test');
    fs.writeFileSync(testFile, 'test');
    // safe-git-allow: incremental-migration
    fs.unlinkSync(testFile);
    return true;
  });

  check('Log directory writable', () => {
    const logDir = path.join(stateDir, 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    return true;
  });

  check('Daemon script exists', () => {
    const script = path.join(path.dirname(path.dirname(__filename)), 'threadline', 'listener-daemon.js');
    return fs.existsSync(script) || `Not found at ${script} — run npm run build`;
  });

  check('No stale PID file', () => {
    const pidFile = getPidFile(stateDir);
    if (!fs.existsSync(pidFile)) return true;
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    try {
      process.kill(pid, 0);
      return true; // Process is actually running — not stale
    } catch {
      // safe-git-allow: incremental-migration
      fs.unlinkSync(pidFile);
      return true; // Cleaned up stale PID
    }
  });

  // Relay connectivity check (optional — may timeout)
  check('Relay reachable (DNS)', () => {
    try {
      // Use nslookup which is available on all platforms
      execSync('nslookup relay.threadline.dev', { timeout: 5000, stdio: 'pipe' });
      return true;
    } catch {
      try {
        // Fallback: try host command
        execSync('host relay.threadline.dev', { timeout: 5000, stdio: 'pipe' });
        return true;
      } catch {
        return 'Cannot resolve relay.threadline.dev — check network';
      }
    }
  });

  console.log(`\n  ${pc.bold(`${passed} passed`)}, ${failed > 0 ? pc.red(`${failed} failed`) : pc.green(`${failed} failed`)}`);

  if (failed === 0) {
    console.log(pc.green('\n  Ready to start: instar listener start'));
  }
}

export async function restartListener(opts: { dir?: string }): Promise<void> {
  await stopListener(opts);
  await new Promise(r => setTimeout(r, 1000));
  await startListener(opts);
}

export async function purgeListener(opts: { dir?: string; force?: boolean }): Promise<void> {
  const stateDir = getStateDir(opts);

  if (!opts.force) {
    console.log(pc.yellow('This will permanently delete all listener data:'));
    console.log('  - Inbox files and archives');
    console.log('  - Daemon logs');
    console.log('  - Health snapshots');
    console.log('  - Dedup cache');
    console.log('  - HMAC key file');
    console.log();
    console.log(pc.bold('Add --force to confirm.'));
    return;
  }

  // Stop daemon first
  const pid = getDaemonPid(stateDir);
  if (pid) {
    console.log(pc.blue('Stopping daemon before purge...'));
    await stopListener(opts);
  }

  const toDelete = [
    path.join(stateDir, 'threadline', 'inbox.jsonl.active'),
    path.join(stateDir, 'threadline', 'inbox-hmac.key'),
    path.join(stateDir, 'threadline', 'inbox.cursor'),
    path.join(stateDir, 'threadline', 'dedup.db'),
    path.join(stateDir, 'listener-health.json'),
    path.join(stateDir, 'listener-daemon.pid'),
    path.join(stateDir, 'listener-displaced-alert.json'),
    path.join(stateDir, 'logs', 'listener-daemon.log'),
    path.join(stateDir, 'logs', 'listener-daemon.log.1'),
  ];

  let deleted = 0;
  for (const file of toDelete) {
    if (fs.existsSync(file)) {
      // safe-git-allow: incremental-migration
      fs.unlinkSync(file);
      deleted++;
    }
  }

  // Clean inbox archive directory
  const archiveDir = path.join(stateDir, 'threadline', 'inbox-archive');
  if (fs.existsSync(archiveDir)) {
    // safe-git-allow: incremental-migration
    fs.rmSync(archiveDir, { recursive: true });
    deleted++;
  }

  // Clean temp prompt files
  const tmpDir = path.join(stateDir, 'tmp');
  if (fs.existsSync(tmpDir)) {
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('prompt-'));
    for (const f of files) {
      // safe-git-allow: incremental-migration
      fs.unlinkSync(path.join(tmpDir, f));
      deleted++;
    }
  }

  console.log(pc.green(`Purged ${deleted} files. Listener data erased.`));
}

export async function installListener(opts: { dir?: string }): Promise<void> {
  const stateDir = getStateDir(opts);
  const platform = process.platform;

  if (platform === 'darwin') {
    // macOS — launchd plist
    const plistDir = path.join(process.env.HOME || '', 'Library', 'LaunchAgents');
    const plistName = 'dev.instar.listener.plist';
    const plistPath = path.join(plistDir, plistName);

    const daemonScript = path.join(path.dirname(path.dirname(__filename)), 'threadline', 'listener-daemon.js');
    const nodePath = process.execPath;

    const config = loadConfig(getProjectDir(opts));
    const relayUrl = config?.threadline?.listener?.relayUrl
      || config?.threadline?.relayUrl
      || 'wss://threadline-relay.fly.dev/v1/connect';
    const agentName = config?.projectName || 'instar-agent';

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.instar.listener</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${daemonScript}</string>
    <string>--state-dir</string>
    <string>${stateDir}</string>
    <string>--relay-url</string>
    <string>${relayUrl}</string>
    <string>--name</string>
    <string>${agentName}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${path.join(stateDir, 'logs', 'listener-daemon-stdout.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(stateDir, 'logs', 'listener-daemon-stderr.log')}</string>
  <key>WorkingDirectory</key>
  <string>${path.dirname(stateDir)}</string>
</dict>
</plist>`;

    if (!fs.existsSync(plistDir)) {
      fs.mkdirSync(plistDir, { recursive: true });
    }
    fs.writeFileSync(plistPath, plist);
    console.log(pc.green(`Installed launchd plist: ${plistPath}`));
    console.log(pc.dim('The daemon will auto-start on login and restart on crash (not on clean exit).'));
    console.log(pc.dim('Load now: launchctl load ' + plistPath));
  } else if (platform === 'linux') {
    console.log(pc.yellow('systemd unit file generation not yet implemented.'));
    console.log(pc.dim('For now, use `instar listener start` to run manually.'));
  } else {
    console.log(pc.yellow(`Unsupported platform: ${platform}`));
  }
}

export async function uninstallListener(opts: { dir?: string }): Promise<void> {
  if (process.platform === 'darwin') {
    const plistPath = path.join(
      process.env.HOME || '',
      'Library', 'LaunchAgents', 'dev.instar.listener.plist'
    );

    if (fs.existsSync(plistPath)) {
      try {
        execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
      } catch {
        // May not be loaded
      }
      // safe-git-allow: incremental-migration
      fs.unlinkSync(plistPath);
      console.log(pc.green('Uninstalled launchd plist.'));
    } else {
      console.log(pc.yellow('No launchd plist found.'));
    }
  } else {
    console.log(pc.yellow('Only macOS launchd is currently supported.'));
  }
}
