/**
 * ThreadlineBootstrap — Auto-wires Threadline protocol into the agent server.
 *
 * Called during server boot to:
 *   1. Persist identity keys (Ed25519) across restarts
 *   2. Create HandshakeManager for crypto handshakes
 *   3. Register MCP tools into Claude Code's ~/.claude.json
 *   4. Announce agent presence for discovery
 *   5. Start discovery heartbeat
 *
 * Design: The user never sees any of this. Threadline is ON when the agent boots.
 * The agent IS the interface — users talk to their agent, the agent handles the rest.
 *
 * Part of Threadline Protocol integration (Principle #11: "I am the interface").
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HandshakeManager } from './HandshakeManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { AgentDiscovery } from './AgentDiscovery.js';
import { generateIdentityKeyPair } from './ThreadlineCrypto.js';
import type { KeyPair } from './ThreadlineCrypto.js';
import { ThreadlineClient } from './client/ThreadlineClient.js';
import type { ReceivedMessage } from './client/ThreadlineClient.js';
import { InboundMessageGate } from './InboundMessageGate.js';
import { AgentTrustManager } from './AgentTrustManager.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

// ── Types ────────────────────────────────────────────────────────────

export interface ThreadlineBootstrapConfig {
  /** Agent name */
  agentName: string;
  /** Agent description */
  agentDescription?: string;
  /** State directory for persistence */
  stateDir: string;
  /** Agent's project directory (for MCP registration) */
  projectDir: string;
  /** Server port */
  port: number;
  /** Enable cloud relay connection (opt-in, default: false) */
  relayEnabled?: boolean;
  /** Cloud relay URL */
  relayUrl?: string;
  /** Agent visibility on relay */
  visibility?: 'public' | 'unlisted' | 'private';
  /** Agent framework identifier */
  framework?: string;
  /** Agent capabilities */
  capabilities?: string[];
}

export interface ThreadlineBootstrapResult {
  /** Handshake manager for crypto handshakes */
  handshakeManager: HandshakeManager;
  /** Agent discovery service */
  discovery: AgentDiscovery;
  /** Identity key pair */
  identityKeys: KeyPair;
  /** Cleanup function for graceful shutdown */
  shutdown: () => Promise<void>;
  /** Cloud relay client (if relay is enabled) */
  relayClient?: ThreadlineClient;
  /** Inbound message gate (if relay is enabled) */
  inboundGate?: InboundMessageGate;
  /** Trust manager */
  trustManager?: AgentTrustManager;
}

// ── Constants ────────────────────────────────────────────────────────

const IDENTITY_KEY_FILE = 'identity-keys.json';

// ── Implementation ───────────────────────────────────────────────────

/**
 * Bootstrap the Threadline protocol stack.
 *
 * Creates the HandshakeManager, registers MCP tools, announces presence,
 * and starts the discovery heartbeat. The ThreadlineRouter is created
 * separately in server.ts because it depends on messaging infrastructure.
 */
export async function bootstrapThreadline(
  config: ThreadlineBootstrapConfig,
): Promise<ThreadlineBootstrapResult> {
  const threadlineDir = path.join(config.stateDir, 'threadline');
  fs.mkdirSync(threadlineDir, { recursive: true });

  // ── 1. Identity Keys (persist across restarts) ───────────────────
  const identityKeys = loadOrCreateIdentityKeys(threadlineDir);

  // ── 2. HandshakeManager ──────────────────────────────────────────
  const handshakeManager = new HandshakeManager(config.stateDir, config.agentName);

  // ── 3. Agent Discovery ───────────────────────────────────────────
  const discovery = new AgentDiscovery({
    stateDir: config.stateDir,
    selfPath: config.projectDir,
    selfName: config.agentName,
    selfPort: config.port,
  });

  // Announce presence for other agents to find us
  discovery.announcePresence({
    capabilities: ['threadline', 'mcp'],
    description: config.agentDescription ?? `${config.agentName} Instar agent`,
    threadlineVersion: '1.0',
    publicKey: identityKeys.publicKey.toString('hex'),
    framework: 'instar',
  });

  // Start heartbeat for liveness detection
  const stopHeartbeat = discovery.startPresenceHeartbeat();

  // ── 4. Register MCP server into Claude Code config ───────────────
  registerThreadlineMcp(config.projectDir, config.agentName, config.stateDir);

  // ── 5. Cloud Relay Connection (opt-in) ─────────────────────────
  const relayEnabled = config.relayEnabled === true
    || process.env.THREADLINE_RELAY_ENABLED === 'true';

  // Check if the standalone listener daemon should handle the relay connection.
  // Three checks, in order:
  //   1. Config says listener.enabled = true → always defer to daemon
  //   2. Daemon PID file exists and process alive → defer
  //   3. Health file shows recent activity (last 5 min) → defer (daemon may be restarting)
  // This prevents the displacement race where the server briefly connects its own
  // relay client during restart, displacing the daemon.
  let daemonHandlingRelay = false;
  if (relayEnabled) {
    // Check 1: Config-level opt-in — if the user configured a daemon, always defer
    const listenerConfigPath = path.join(config.stateDir, 'config.json');
    let listenerConfigEnabled = false;
    try {
      if (fs.existsSync(listenerConfigPath)) {
        const rawConfig = JSON.parse(fs.readFileSync(listenerConfigPath, 'utf-8'));
        listenerConfigEnabled = rawConfig?.threadline?.listener?.enabled === true;
      }
    } catch { /* ignore parse errors */ }

    // Check 2: Daemon PID file exists and process alive
    const daemonPidPath = path.join(config.stateDir, 'listener-daemon.pid');
    let daemonAlive = false;
    if (fs.existsSync(daemonPidPath)) {
      try {
        const pid = parseInt(fs.readFileSync(daemonPidPath, 'utf-8').trim(), 10);
        process.kill(pid, 0); // Check if process is alive (doesn't actually kill)
        daemonAlive = true;
      } catch {
        // PID file exists but process is dead — clean up stale PID
        try { SafeFsExecutor.safeUnlinkSync(daemonPidPath, { operation: 'src/threadline/ThreadlineBootstrap.ts:153' }); } catch { /* ignore */ }
      }
    }

    // Check 3: Health file shows recent activity (daemon may be restarting)
    let recentHealth = false;
    const healthPath = path.join(config.stateDir, 'listener-health.json');
    if (fs.existsSync(healthPath)) {
      try {
        const healthMtime = fs.statSync(healthPath).mtimeMs;
        const fiveMinAgo = Date.now() - 5 * 60 * 1000;
        if (healthMtime > fiveMinAgo) {
          const health = JSON.parse(fs.readFileSync(healthPath, 'utf-8'));
          // Only count as recent if the daemon was previously connected (not just 'stopped')
          if (health.state === 'connected' || health.state === 'authenticating' || health.state === 'connecting') {
            recentHealth = true;
          }
        }
      } catch { /* ignore */ }
    }

    if (daemonAlive) {
      daemonHandlingRelay = true;
      const pid = parseInt(fs.readFileSync(daemonPidPath, 'utf-8').trim(), 10);
      console.log(`Threadline: listener daemon running (pid: ${pid}) — server will NOT connect to relay (daemon handles it)`);
    } else if (listenerConfigEnabled) {
      daemonHandlingRelay = true;
      console.log(`Threadline: listener daemon configured (threadline.listener.enabled=true) — server will NOT connect to relay (start daemon with: instar listener start)`);
    } else if (recentHealth) {
      daemonHandlingRelay = true;
      console.log(`Threadline: listener daemon was recently active — server will NOT connect to relay (daemon may be restarting)`);
    }
  }

  let relayClient: ThreadlineClient | undefined;
  let inboundGate: InboundMessageGate | undefined;
  let trustManager: AgentTrustManager | undefined;

  // Always create trust manager when relay is enabled — needed for processing
  // inbox entries even when the daemon handles the relay connection.
  if (relayEnabled) {
    trustManager = new AgentTrustManager({ stateDir: config.stateDir });
  }

  if (relayEnabled) {
    const relayUrl = config.relayUrl
      ?? process.env.THREADLINE_RELAY_URL
      ?? 'wss://threadline-relay.fly.dev/v1/connect';

    // Always create relay client for outbound messages.
    // When daemon handles inbound, we still need the client for sending.
    relayClient = new ThreadlineClient({
      name: config.agentName,
      relayUrl,
      framework: config.framework ?? 'instar',
      capabilities: config.capabilities ?? ['chat', 'threadline'],
      visibility: config.visibility ?? 'public',
      stateDir: config.stateDir,
    });

    // Create inbound message gate (imports ThreadlineRouter lazily if needed)
    // For now, router is not available at bootstrap time — it's created in server.ts
    // The gate will be wired to the router after server setup
    inboundGate = new InboundMessageGate(trustManager!, null, {
      maxPayloadBytes: 64 * 1024,
    });

    // Only wire inbound message handling and connect if daemon is NOT handling relay.
    // When daemon handles inbound, the server only uses the relay client for outbound sends.
    if (!daemonHandlingRelay) {
    console.log(`Threadline: connecting to relay at ${relayUrl} (disable with THREADLINE_RELAY_ENABLED=false)`);

    // Route inbound relay messages through the gate
    relayClient.on('message', async (msg: ReceivedMessage) => {
      if (!inboundGate) return;
      const decision = await inboundGate.evaluate(msg);
      if (decision.action === 'pass' && decision.message) {
        // Gate passed — emit for ThreadlineRouter to handle
        relayClient!.emit('gate-passed', decision);
      }
    });

    // Handle unknown senders — decode payload directly (relay-authenticated, not E2E encrypted)
    relayClient.on('unknown-sender', async (envelope: Record<string, unknown>) => {
      if (!inboundGate || !envelope) return;

      // Attempt to decode the base64 payload as plaintext JSON
      let textContent: string;
      let msgType: string | undefined;
      try {
        const payloadStr = Buffer.from(envelope.payload as string, 'base64').toString('utf-8');
        const parsed = JSON.parse(payloadStr);
        if (typeof parsed === 'object' && parsed !== null && 'text' in parsed) {
          textContent = String(parsed.text);
          msgType = parsed.type as string | undefined;
        } else if (typeof parsed === 'string') {
          textContent = parsed;
        } else {
          textContent = JSON.stringify(parsed);
        }
      } catch {
        textContent = `[undecryptable relay message from ${String(envelope.from).slice(0, 16)}]`;
      }

      const received: ReceivedMessage = {
        from: String(envelope.from ?? 'unknown'),
        fromName: String(envelope.from ?? 'unknown').slice(0, 8),
        threadId: String(envelope.threadId ?? `relay-${Date.now()}`),
        messageId: String(envelope.messageId ?? `msg-${Date.now()}`),
        content: { content: textContent, type: msgType },
        timestamp: String(envelope.timestamp ?? new Date().toISOString()),
        envelope: envelope as never,
      };

      // Relay-authenticated unknown senders bypass the trust manager gate.
      // The relay already verified their Ed25519 identity via challenge-response.
      // We still run payload size checks but skip trust/rate checks.
      const payloadSize = Buffer.byteLength(JSON.stringify(received.content), 'utf-8');
      if (payloadSize > 64 * 1024) {
        console.log(`Threadline: relay message from ${received.from.slice(0, 8)} blocked (payload too large: ${payloadSize})`);
        return;
      }

      // Record the interaction for trust building
      trustManager!.recordMessageReceivedByFingerprint(received.from);

      // Emit gate-passed with relay-authenticated trust level
      relayClient!.emit('gate-passed', {
        action: 'pass' as const,
        reason: 'relay-authenticated',
        trustLevel: 'verified',
        fingerprint: received.from,
        message: received,
      });
    });

    // Log auto-discovery results
    relayClient.on('auto-discovered', (info: { count: number }) => {
      console.log(`Threadline: auto-discovered ${info.count} agent(s) on relay`);
    });

    try {
      await relayClient.connect();
      console.log(`Threadline: relay connected (fingerprint: ${relayClient.fingerprint})`);
    } catch (err) {
      console.error(`Threadline: relay connection failed — ${err instanceof Error ? err.message : err}`);
      console.log('Threadline: agent will operate in local-only mode');
      relayClient = undefined;
    }
    } else {
      // Daemon handles the relay connection (both inbound and outbound).
      // The server's relay client is NOT connected — outbound messages are
      // sent by the daemon via a file-based outbox or via sessions using
      // the threadline_send MCP tool (which connects its own stdio subprocess).
      // The relay client object exists but is not connected.
      console.log(`Threadline: daemon handles relay — server relay client not connected (outbound via MCP tools)`);
    }
  }

  return {
    handshakeManager,
    discovery,
    identityKeys,
    trustManager,
    relayClient,
    inboundGate,
    shutdown: async () => {
      stopHeartbeat();
      if (relayClient) {
        relayClient.disconnect();
      }
      if (inboundGate) {
        inboundGate.shutdown();
      }
      if (trustManager) {
        trustManager.flush();
      }
    },
  };
}

// ── Identity Key Persistence ─────────────────────────────────────────

function loadOrCreateIdentityKeys(threadlineDir: string): KeyPair {
  const keyFile = path.join(threadlineDir, IDENTITY_KEY_FILE);

  if (fs.existsSync(keyFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(keyFile, 'utf-8'));
      if (data.publicKey && data.privateKey) {
        return {
          publicKey: Buffer.from(data.publicKey, 'hex'),
          privateKey: Buffer.from(data.privateKey, 'hex'),
        };
      }
    } catch {
      // Corrupted key file — regenerate
    }
  }

  const keys = generateIdentityKeyPair();

  // Persist atomically
  const tmpFile = `${keyFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify({
    publicKey: keys.publicKey.toString('hex'),
    privateKey: keys.privateKey.toString('hex'),
    createdAt: new Date().toISOString(),
  }, null, 2), { mode: 0o600 }); // Private key — restrictive permissions
  fs.renameSync(tmpFile, keyFile);

  return keys;
}

// ── MCP Registration ─────────────────────────────────────────────────

/**
 * Register the Threadline MCP server into Claude Code's config.
 *
 * Uses the same pattern as ensurePlaywrightMcp() — registers in both
 * ~/.claude.json (local scope) and .mcp.json (project scope).
 *
 * The MCP server is a stdio process that Claude Code launches as a subprocess.
 */
function registerThreadlineMcp(projectDir: string, agentName: string, stateDir: string): void {
  const absDir = path.resolve(projectDir);

  // The MCP server entry point — runs as a child process of Claude Code.
  // Resolve the actual instar package location (handles both node_modules and npm-linked).
  let mcpEntryPath = path.join(absDir, 'node_modules', 'instar', 'dist', 'threadline', 'mcp-stdio-entry.js');
  if (!fs.existsSync(mcpEntryPath)) {
    // Fall back to the running instar installation's dist directory.
    // This handles npm-linked installs where node_modules/instar doesn't exist.
    mcpEntryPath = path.join(__dirname, 'mcp-stdio-entry.js');
  }

  const mcpEntry = {
    command: 'node',
    args: [
      mcpEntryPath,
      '--state-dir', stateDir,
      '--agent-name', agentName,
    ],
  };

  // ── 1. Register in ~/.claude.json at local scope ──
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  try {
    let claudeJson: Record<string, unknown> = {};
    if (fs.existsSync(claudeJsonPath)) {
      claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
    }

    if (!claudeJson.projects || typeof claudeJson.projects !== 'object') {
      claudeJson.projects = {};
    }
    const projects = claudeJson.projects as Record<string, Record<string, unknown>>;

    if (!projects[absDir]) {
      projects[absDir] = {};
    }
    const projectEntry = projects[absDir];

    if (!projectEntry.mcpServers || typeof projectEntry.mcpServers !== 'object') {
      projectEntry.mcpServers = {};
    }
    const mcpServers = projectEntry.mcpServers as Record<string, unknown>;

    // Register (or update) the Threadline MCP server
    mcpServers.threadline = mcpEntry;

    // Pre-accept trust
    projectEntry.hasTrustDialogAccepted = true;

    // Write atomically
    const tmpPath = `${claudeJsonPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(claudeJson, null, 2));
    fs.renameSync(tmpPath, claudeJsonPath);
  } catch {
    // Non-fatal — .mcp.json fallback below
  }

  // ── 2. Also add to .mcp.json in the project root ──
  const mcpJsonPath = path.join(projectDir, '.mcp.json');
  try {
    let mcpConfig: Record<string, unknown> = {};
    if (fs.existsSync(mcpJsonPath)) {
      mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
    }
    if (!mcpConfig.mcpServers || typeof mcpConfig.mcpServers !== 'object') {
      mcpConfig.mcpServers = {};
    }
    const mcpServers = mcpConfig.mcpServers as Record<string, unknown>;
    mcpServers.threadline = mcpEntry;

    const tmpPath = `${mcpJsonPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(mcpConfig, null, 2));
    fs.renameSync(tmpPath, mcpJsonPath);
  } catch {
    // Non-fatal
  }
}
