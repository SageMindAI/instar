#!/usr/bin/env node

/**
 * Listener Daemon — Standalone process maintaining a persistent WebSocket
 * connection to the Threadline relay, independent of the agent server lifecycle.
 *
 * Part of RFC: Persistent Listener Daemon Architecture (Phase 1).
 *
 * This process:
 * - Connects to the relay via WebSocket with Ed25519 authentication
 * - Decrypts incoming E2E-encrypted messages
 * - Writes HMAC-signed entries to the inbox JSONL file
 * - Signals the agent server via Unix domain socket for immediate pickup
 * - Writes periodic health snapshots
 * - Handles reconnection with exponential backoff
 * - Exits gracefully (code 0) on displacement to prevent respawn loops
 *
 * Usage:
 *   node listener-daemon.js --state-dir /path/to/.instar
 *
 * Environment:
 *   INSTAR_LISTENER_HMAC_KEY_FILE — Path to HMAC key file (0400 permissions)
 *     If not set, falls back to reading authToken from config.json and deriving key.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { RelayClient } from './client/RelayClient.js';
import { IdentityManager } from './client/IdentityManager.js';
import { MessageEncryptor } from './client/MessageEncryptor.js';
import type { RelayClientConfig, MessageEnvelope } from './relay/types.js';
import type { IdentityInfo } from './client/IdentityManager.js';
import type { InboxEntry } from './ListenerSessionManager.js';

// ── Types ─────────────────────────────────────────────────────────────

interface DaemonConfig {
  stateDir: string;
  relayUrl: string;
  agentName: string;
  healthIntervalMs: number;
  logPath: string;
  logMaxBytes: number;
  socketPath: string;
}

interface HealthSnapshot {
  pid: number;
  uptime: number;
  state: string;
  disconnects10m: number;
  msgsIn: number;
  msgsOut: number;
  reconnectDelay: number;
  lastMessage: string | null;
  snapshotAge: number;
}

// ── Logging ───────────────────────────────────────────────────────────

class DaemonLogger {
  private logPath: string;
  private maxBytes: number;

  constructor(logPath: string, maxBytes: number) {
    this.logPath = logPath;
    this.maxBytes = maxBytes;
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  private write(level: string, msg: string): void {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
    try {
      // Rotate if needed
      if (fs.existsSync(this.logPath)) {
        const stat = fs.statSync(this.logPath);
        if (stat.size > this.maxBytes) {
          const rotated = `${this.logPath}.1`;
          // safe-git-allow: incremental-migration
          if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
          fs.renameSync(this.logPath, rotated);
        }
      }
      fs.appendFileSync(this.logPath, line);
    } catch {
      // Logging failure is non-critical
    }
  }

  error(msg: string): void { this.write('ERROR', msg); }
  warn(msg: string): void { this.write('WARN', msg); }
  info(msg: string): void { this.write('INFO', msg); }
  debug(msg: string): void { this.write('DEBUG', msg); }
}

// ── Listener Daemon ───────────────────────────────────────────────────

export class ListenerDaemon extends EventEmitter {
  private config: DaemonConfig;
  private log: DaemonLogger;
  private identity: IdentityInfo;
  private encryptor: MessageEncryptor;
  private relay: RelayClient;
  private signingKey: Buffer;

  // Unix socket for wake signals
  private wakeSocket: net.Socket | null = null;
  private socketConnected = false;

  // Metrics
  private startTime = Date.now();
  private msgsIn = 0;
  private msgsOut = 0;
  private disconnects: number[] = []; // timestamps of disconnects in last 10 min
  private lastMessageAt: string | null = null;

  // Health timer
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  // PID file
  private pidPath: string;

  constructor(config: DaemonConfig) {
    super();
    this.config = config;
    this.pidPath = path.join(config.stateDir, 'listener-daemon.pid');
    this.log = new DaemonLogger(config.logPath, config.logMaxBytes);

    // Load identity
    const identityMgr = new IdentityManager(path.join(config.stateDir, 'threadline'));
    const identity = identityMgr.get();
    if (!identity) {
      // Try legacy path
      const legacyMgr = new IdentityManager(config.stateDir);
      const legacyIdentity = legacyMgr.get();
      if (!legacyIdentity) {
        this.log.error('No identity found. Server must generate identity first.');
        process.exit(1);
      }
      this.identity = legacyIdentity;
    } else {
      this.identity = identity;
    }

    // Create message encryptor for E2E decryption
    this.encryptor = new MessageEncryptor(
      this.identity.privateKey,
      this.identity.publicKey,
    );

    // Load HMAC signing key
    this.signingKey = this.loadSigningKey();

    // Create relay client
    const relayConfig: RelayClientConfig = {
      relayUrl: config.relayUrl,
      name: config.agentName,
      framework: 'instar-listener-daemon',
      capabilities: ['listener'],
      version: '1.0.0',
      visibility: 'unlisted',
      stateDir: config.stateDir,
    };
    this.relay = new RelayClient(relayConfig, this.identity);

    this.log.info(`Listener daemon initialized for agent ${this.identity.fingerprint.slice(0, 8)}...`);
  }

  /**
   * Load HMAC signing key from file or derive from authToken.
   */
  private loadSigningKey(): Buffer {
    // Try HMAC key file first (preferred — avoids env var exposure)
    const hmacKeyFile = process.env.INSTAR_LISTENER_HMAC_KEY_FILE
      || path.join(this.config.stateDir, 'threadline', 'inbox-hmac.key');

    if (fs.existsSync(hmacKeyFile)) {
      try {
        const keyHex = fs.readFileSync(hmacKeyFile, 'utf-8').trim();
        this.log.info('HMAC key loaded from file');
        return Buffer.from(keyHex, 'hex');
      } catch (err) {
        this.log.warn(`Failed to read HMAC key file: ${err}`);
      }
    }

    // Fallback: derive from authToken in config.json
    const configPath = path.join(this.config.stateDir, 'config.json');
    if (!fs.existsSync(configPath)) {
      this.log.error('No HMAC key file and no config.json found');
      process.exit(1);
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const authToken = config.authToken;
    if (!authToken) {
      this.log.error('No authToken in config.json and no HMAC key file');
      process.exit(1);
    }

    this.log.info('HMAC key derived from authToken (consider using key file instead)');
    return Buffer.from(crypto.hkdfSync(
      'sha256',
      Buffer.from(authToken, 'utf-8'),
      Buffer.alloc(32),
      Buffer.from('instar-inbox-signing', 'utf-8'),
      32,
    ));
  }

  /**
   * Start the daemon — connect to relay, begin processing.
   */
  async start(): Promise<void> {
    // Write PID file
    fs.writeFileSync(this.pidPath, String(process.pid));
    this.log.info(`Daemon started (pid: ${process.pid})`);

    // Wire relay events
    this.relay.on('connected', (sessionId: string) => {
      this.log.info(`Connected to relay (session: ${sessionId.slice(0, 8)}...)`);
      this.writeHealth();
      // Subscribe to presence changes for fast failover (Phase 3)
      try {
        this.relay.subscribe(); // Subscribe to all presence changes
        this.log.info('Subscribed to relay presence changes');
      } catch (err) {
        this.log.warn(`Failed to subscribe to presence: ${err}`);
      }
    });

    this.relay.on('disconnected', (reason: string) => {
      this.log.warn(`Disconnected from relay: ${reason}`);
      this.disconnects.push(Date.now());
      this.writeHealth();
    });

    this.relay.on('displaced', (reason: string) => {
      this.log.warn(`DISPLACED by another connection: ${reason}`);
      this.log.warn('Yielding gracefully — will NOT reconnect');
      this.writeHealth();
      // Write displacement alert file for server to pick up
      this.writeDisplacementAlert(reason);
      this.cleanup();
      // Exit code 0 — prevents launchd/systemd respawn loops
      process.exit(0);
    });

    this.relay.on('message', (envelope: MessageEnvelope) => {
      this.handleMessage(envelope);
    });

    // Phase 3: Subscribe to presence changes for fast failover
    this.relay.on('presence-change', (change: { agentId: string; status: string; name?: string }) => {
      this.log.info(`Presence change: ${change.agentId.slice(0, 8)}... → ${change.status}`);
      if (change.status === 'offline' || change.status === 'disconnected') {
        // Signal server with FAILOVER_TRIGGER (byte 0x02) so it can evaluate failover
        this.sendFailoverTrigger(change.agentId);
      }
    });

    this.relay.on('error', (error) => {
      this.log.error(`Relay error: ${JSON.stringify(error)}`);
    });

    // Connect to Unix socket for wake signals
    this.connectWakeSocket();

    // Start health reporting
    this.healthTimer = setInterval(() => this.writeHealth(), this.config.healthIntervalMs);

    // Connect to relay
    try {
      await this.relay.connect();
    } catch (err) {
      this.log.error(`Failed to connect to relay: ${err}`);
      // Relay client handles reconnection internally
    }

    // Handle process signals
    process.on('SIGTERM', () => {
      this.log.info('Received SIGTERM, shutting down');
      this.cleanup();
      process.exit(0);
    });

    process.on('SIGINT', () => {
      this.log.info('Received SIGINT, shutting down');
      this.cleanup();
      process.exit(0);
    });
  }

  /**
   * Handle incoming relay message — decrypt, write to inbox, signal server.
   */
  private handleMessage(envelope: MessageEnvelope): void {
    this.msgsIn++;
    this.lastMessageAt = new Date().toISOString();

    // Log metadata only (never log message content)
    this.log.info(`Message received from ${envelope.from.slice(0, 8)}... thread:${envelope.threadId?.slice(0, 8) || 'none'}`);

    let text: string;
    let senderName: string;

    try {
      // Try E2E decryption
      // Note: we need the sender's public keys for decryption.
      // For now, pass the envelope as-is and let the server handle full decryption.
      // The daemon writes the raw envelope to inbox for server-side processing.
      // This is the simpler approach — daemon doesn't need all known agent keys.
      text = JSON.stringify({
        type: 'encrypted-envelope',
        envelope,
      });
      senderName = envelope.from.slice(0, 8);
    } catch (err) {
      this.log.error(`Failed to process message: ${err}`);
      return;
    }

    // Write HMAC-signed entry to inbox
    const entry = this.writeInboxEntry({
      from: envelope.from,
      senderName,
      threadId: envelope.threadId || crypto.randomUUID(),
      text,
      messageId: envelope.messageId,
    });

    if (entry) {
      // Signal server via Unix socket
      this.sendWakeSignal();
      this.msgsOut++;
    }
  }

  /**
   * Write an HMAC-signed entry to the inbox JSONL file.
   */
  private writeInboxEntry(opts: {
    from: string;
    senderName: string;
    threadId: string;
    text: string;
    messageId: string;
  }): InboxEntry | null {
    const inboxPath = path.join(this.config.stateDir, 'threadline', 'inbox.jsonl.active');
    const inboxDir = path.dirname(inboxPath);
    if (!fs.existsSync(inboxDir)) {
      fs.mkdirSync(inboxDir, { recursive: true });
    }

    const entryData: Omit<InboxEntry, 'hmac'> = {
      id: opts.messageId || crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      from: opts.from,
      senderName: opts.senderName,
      trustLevel: 'unknown', // Server determines trust level
      threadId: opts.threadId,
      text: opts.text,
    };

    // Compute HMAC-SHA256
    const hmac = crypto.createHmac('sha256', this.signingKey);
    hmac.update(JSON.stringify(entryData));
    const entry: InboxEntry = { ...entryData, hmac: hmac.digest('hex') };

    try {
      // Append to active inbox file (atomic on local POSIX filesystems)
      fs.appendFileSync(inboxPath, JSON.stringify(entry) + '\n');
      this.log.debug(`Inbox entry written: ${entry.id.slice(0, 8)}...`);
      return entry;
    } catch (err) {
      this.log.error(`Failed to write inbox entry: ${err}`);

      // Retry up to 3 times
      for (let i = 0; i < 3; i++) {
        try {
          fs.appendFileSync(inboxPath, JSON.stringify(entry) + '\n');
          this.log.info(`Inbox entry written on retry ${i + 1}`);
          return entry;
        } catch {
          // Continue retrying
        }
      }

      this.log.error('Inbox write failed after 3 retries');
      return null;
    }
  }

  // ── Failover Trigger ──────────────────────────────────────────────

  /**
   * Send a FAILOVER_TRIGGER signal (byte 0x02) over the Unix socket
   * when a peer agent disconnects from the relay.
   * The server's MultiMachineCoordinator evaluates whether to promote.
   */
  private sendFailoverTrigger(disconnectedAgentId: string): void {
    // Write trigger info to a file the server can read
    try {
      const triggerPath = path.join(this.config.stateDir, 'failover-trigger.json');
      fs.writeFileSync(triggerPath, JSON.stringify({
        type: 'presence-change',
        agentId: disconnectedAgentId,
        timestamp: new Date().toISOString(),
        daemonPid: process.pid,
      }, null, 2), { mode: 0o600 });
    } catch (err) {
      this.log.error(`Failed to write failover trigger: ${err}`);
    }

    // Send byte 0x02 over Unix socket
    if (this.socketConnected && this.wakeSocket) {
      try {
        this.wakeSocket.write(Buffer.from([0x02]));
        this.log.info(`Failover trigger sent for ${disconnectedAgentId.slice(0, 8)}...`);
      } catch {
        this.log.warn('Failed to send failover trigger via socket');
      }
    }
  }

  // ── Unix Socket Wake Signal ───────────────────────────────────────

  /**
   * Connect to the server's Unix domain socket for wake signals.
   * Uses persistent connection (not per-message) to avoid TOCTOU attacks.
   */
  private connectWakeSocket(): void {
    const socketPath = this.config.socketPath;

    // Resolve symlinks before connecting (prevents symlink substitution attacks)
    let resolvedPath: string;
    try {
      resolvedPath = fs.realpathSync(socketPath);
    } catch {
      // Socket doesn't exist yet — server may not be running
      this.log.debug('Wake socket not available, will use sentinel file fallback');
      return;
    }

    try {
      this.wakeSocket = net.createConnection(resolvedPath);

      this.wakeSocket.on('connect', () => {
        this.socketConnected = true;
        this.log.info('Connected to wake socket');
      });

      this.wakeSocket.on('error', (err) => {
        this.socketConnected = false;
        this.log.debug(`Wake socket error: ${err.message}`);
      });

      this.wakeSocket.on('close', () => {
        this.socketConnected = false;
        this.log.debug('Wake socket closed, will retry on next message');
        this.wakeSocket = null;

        // Try to reconnect after a delay
        setTimeout(() => this.connectWakeSocket(), 5000);
      });
    } catch (err) {
      this.log.debug(`Failed to connect wake socket: ${err}`);
    }
  }

  /**
   * Send a 1-byte wake signal to the server.
   * Falls back to touching the sentinel file if socket is unavailable.
   */
  private sendWakeSignal(): void {
    if (this.socketConnected && this.wakeSocket) {
      try {
        this.wakeSocket.write(Buffer.from([0x01]));
        return;
      } catch {
        this.socketConnected = false;
      }
    }

    // Fallback: touch the wake sentinel file
    try {
      const sentinelPath = path.join(this.config.stateDir, 'state', 'listener-wake-sentinel');
      const dir = path.dirname(sentinelPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(sentinelPath, String(Date.now()));
    } catch (err) {
      this.log.error(`Failed to touch wake sentinel: ${err}`);
    }
  }

  // ── Health Reporting ──────────────────────────────────────────────

  /**
   * Write health snapshot to disk (0600 permissions).
   */
  private writeHealth(): void {
    const now = Date.now();

    // Prune disconnects older than 10 minutes
    const tenMinAgo = now - 10 * 60 * 1000;
    this.disconnects = this.disconnects.filter(t => t > tenMinAgo);

    const health: HealthSnapshot = {
      pid: process.pid,
      uptime: Math.floor((now - this.startTime) / 1000),
      state: this.relay.connectionState,
      disconnects10m: this.disconnects.length,
      msgsIn: this.msgsIn,
      msgsOut: this.msgsOut,
      reconnectDelay: 1000, // base reconnect delay
      lastMessage: this.lastMessageAt,
      snapshotAge: 0,
    };

    try {
      const healthPath = path.join(this.config.stateDir, 'listener-health.json');
      fs.writeFileSync(healthPath, JSON.stringify(health, null, 2), { mode: 0o600 });
    } catch {
      // Health write failure is non-critical
    }
  }

  /**
   * Write displacement alert for the server's Attention Queue.
   */
  private writeDisplacementAlert(reason: string): void {
    try {
      const alertPath = path.join(this.config.stateDir, 'listener-displaced-alert.json');
      fs.writeFileSync(alertPath, JSON.stringify({
        type: 'listener-displaced',
        timestamp: new Date().toISOString(),
        reason,
        pid: process.pid,
      }, null, 2), { mode: 0o600 });
    } catch {
      // Non-critical
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────

  private cleanup(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }

    if (this.wakeSocket) {
      this.wakeSocket.destroy();
      this.wakeSocket = null;
    }

    this.relay.disconnect();

    // Remove PID file
    try {
      if (fs.existsSync(this.pidPath)) {
        // safe-git-allow: incremental-migration
        fs.unlinkSync(this.pidPath);
      }
    } catch {
      // Non-critical
    }

    // Write final health with state 'stopped'
    try {
      const healthPath = path.join(this.config.stateDir, 'listener-health.json');
      fs.writeFileSync(healthPath, JSON.stringify({
        pid: process.pid,
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
        state: 'stopped',
        disconnects10m: 0,
        msgsIn: this.msgsIn,
        msgsOut: this.msgsOut,
        reconnectDelay: 0,
        lastMessage: this.lastMessageAt,
        snapshotAge: 0,
      }, null, 2), { mode: 0o600 });
    } catch {
      // Non-critical
    }
  }
}

// ── CLI Entry Point ──────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let stateDir = '.instar';
  let relayUrl = 'wss://threadline-relay.fly.dev/v1/connect';
  let agentName = 'unknown';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--state-dir' && args[i + 1]) {
      stateDir = args[++i];
    } else if (args[i] === '--relay-url' && args[i + 1]) {
      relayUrl = args[++i];
    } else if (args[i] === '--name' && args[i + 1]) {
      agentName = args[++i];
    }
  }

  // Load config for relay URL and agent name if not provided
  const configPath = path.join(stateDir, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (!relayUrl || relayUrl === 'wss://threadline-relay.fly.dev/v1/connect') {
        relayUrl = config?.threadline?.relayUrl || config?.relay?.url || relayUrl;
      }
      if (agentName === 'unknown') {
        agentName = config?.name || config?.agentName || 'unknown';
      }
    } catch {
      // Use defaults
    }
  }

  const daemon = new ListenerDaemon({
    stateDir,
    relayUrl,
    agentName,
    healthIntervalMs: 10 * 60 * 1000, // 10 minutes
    logPath: path.join(stateDir, 'logs', 'listener-daemon.log'),
    logMaxBytes: 10 * 1024 * 1024, // 10MB
    socketPath: path.join(stateDir, 'listener.sock'),
  });

  await daemon.start();
}

// Run if executed directly
const isDirectRun = process.argv[1]?.endsWith('listener-daemon.js')
  || process.argv[1]?.endsWith('listener-daemon.ts');
if (isDirectRun) {
  main().catch(err => {
    console.error('Listener daemon fatal error:', err);
    process.exit(1);
  });
}
