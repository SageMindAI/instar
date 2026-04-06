#!/usr/bin/env node
/**
 * mcp-stdio-entry — Standalone entry point for the Threadline MCP server.
 *
 * Claude Code launches this as a child process (stdio transport).
 * It reads agent state from disk and exposes up to 9 Threadline tools
 * (5 core + 4 registry tools if relay is configured).
 *
 * Usage (by Claude Code, not humans):
 *   node dist/threadline/mcp-stdio-entry.js --state-dir /path/.instar --agent-name my-agent
 *
 * Environment:
 *   THREADLINE_RELAY     — Relay WebSocket URL (default: wss://relay.threadline.dev/v1/connect)
 *   THREADLINE_REGISTRY  — Enable registry tools (default: true if relay configured)
 *
 * This script:
 *   1. Reads agent config and Threadline state from disk
 *   2. Creates a ThreadlineMCPServer with stdio transport
 *   3. Optionally authenticates with relay for registry access
 *   4. Connects to Claude Code via stdin/stdout
 *   5. Handles tool calls until Claude Code disconnects
 */

import path from 'node:path';
import fs from 'node:fs';
import { ThreadlineMCPServer } from './ThreadlineMCPServer.js';
import { AgentDiscovery } from './AgentDiscovery.js';
import { ThreadResumeMap } from './ThreadResumeMap.js';
import { AgentTrustManager } from './AgentTrustManager.js';
import { IdentityManager } from './client/IdentityManager.js';
import { RegistryRestClient } from './client/RegistryRestClient.js';
import type { SendMessageParams, SendMessageResult, ThreadHistoryResult, RegistryClient } from './ThreadlineMCPServer.js';

const DEFAULT_RELAY_URL = 'wss://relay.threadline.dev/v1/connect';

// ── Parse CLI args ───────────────────────────────────────────────────

function parseArgs(): { stateDir: string; agentName: string } {
  const args = process.argv.slice(2);
  let stateDir = '';
  let agentName = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--state-dir' && args[i + 1]) {
      stateDir = args[++i];
    } else if (args[i] === '--agent-name' && args[i + 1]) {
      agentName = args[++i];
    }
  }

  if (!stateDir || !agentName) {
    process.stderr.write('Usage: mcp-stdio-entry --state-dir DIR --agent-name NAME\n');
    process.exit(1);
  }

  return { stateDir, agentName };
}

// ── Message sending via HTTP (talks to the running agent server) ─────

/**
 * Send a message via the agent server's relay endpoint.
 * Routes through the Threadline relay WebSocket for cloud delivery.
 * Falls back to the local messaging system if relay isn't available.
 */
async function sendMessageViaHttp(
  params: SendMessageParams,
  serverPort: number,
  agentToken: string,
): Promise<SendMessageResult> {
  // Try relay-send first (for remote agents on the Threadline network)
  try {
    const relayResponse = await fetch(`http://localhost:${serverPort}/threadline/relay-send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${agentToken}`,
      },
      body: JSON.stringify({
        targetAgent: params.targetAgent,
        threadId: params.threadId,
        message: params.message,
        waitForReply: params.waitForReply,
        timeoutSeconds: params.timeoutSeconds,
      }),
    });

    if (relayResponse.ok) {
      const result = await relayResponse.json() as { success: boolean; messageId: string; threadId: string; reply?: string; error?: string };
      if (result.success) {
        return {
          success: true,
          threadId: result.threadId,
          messageId: result.messageId,
          reply: result.reply ?? undefined,
        };
      }
    }

    // If relay returned 503 (not connected), fall through to local messaging
    if (relayResponse.status !== 503) {
      const errText = await relayResponse.text();
      return {
        success: false,
        threadId: params.threadId ?? '',
        messageId: '',
        error: `Relay send failed (${relayResponse.status}): ${errText}`,
      };
    }
  } catch {
    // Relay endpoint not available — fall through to local
  }

  // Fallback: local messaging system (for agents on the same machine)
  try {
    const response = await fetch(`http://localhost:${serverPort}/messages/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${agentToken}`,
      },
      body: JSON.stringify({
        targetAgent: params.targetAgent,
        threadId: params.threadId,
        message: params.message,
        waitForReply: params.waitForReply,
        timeoutSeconds: params.timeoutSeconds,
      }),
    });

    if (!response.ok) {
      return {
        success: false,
        threadId: params.threadId ?? '',
        messageId: '',
        error: `Server returned ${response.status}: ${await response.text()}`,
      };
    }

    return await response.json() as SendMessageResult;
  } catch (err) {
    return {
      success: false,
      threadId: params.threadId ?? '',
      messageId: '',
      error: `Failed to reach agent server: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Registry Client Setup ────────────────────────────────────────────

async function setupRegistryClient(
  stateDir: string,
  agentName: string,
): Promise<RegistryClient | null> {
  const relayUrl = process.env.THREADLINE_RELAY || DEFAULT_RELAY_URL;
  const registryDisabled = process.env.THREADLINE_REGISTRY === 'false';

  if (registryDisabled) {
    return null;
  }

  try {
    // Load or create agent identity
    const identityManager = new IdentityManager(stateDir);
    const identity = identityManager.getOrCreate();

    const client = new RegistryRestClient({
      relayUrl,
      identity,
      agentName,
      framework: 'instar',
      listed: process.env.THREADLINE_REGISTRY === 'true',
    });

    // Authenticate with relay to get registry token
    await client.authenticate();

    if (client.hasToken()) {
      process.stderr.write(`[threadline-mcp] Registry client authenticated\n`);
      return client;
    } else {
      process.stderr.write(`[threadline-mcp] Registry auth succeeded but no token received\n`);
      return client; // Still usable for unauthenticated searches
    }
  } catch (err) {
    process.stderr.write(
      `[threadline-mcp] Registry client setup failed (tools will be unavailable): ${err instanceof Error ? err.message : err}\n`
    );
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { stateDir, agentName } = parseArgs();

  const threadlineDir = path.join(stateDir, 'threadline');
  if (!fs.existsSync(threadlineDir)) {
    fs.mkdirSync(threadlineDir, { recursive: true });
  }

  // Read server port and auth token from config
  const configPath = path.join(stateDir, 'config.json');
  let serverPort = 4040;
  let agentToken = '';
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      serverPort = config.port ?? 4040;
      agentToken = config.authToken ?? '';
    } catch {
      // Use defaults
    }
  }

  // Instantiate dependencies from disk state
  const threadResumeMap = new ThreadResumeMap(stateDir, stateDir);
  const trustManager = new AgentTrustManager({ stateDir });
  const discovery = new AgentDiscovery({
    stateDir,
    selfPath: stateDir,
    selfName: agentName,
    selfPort: serverPort,
  });

  // Set up registry client (non-blocking — MCP server starts even if registry fails)
  const registryClient = await setupRegistryClient(stateDir, agentName);

  // Create MCP server with stdio transport
  const mcpServer = new ThreadlineMCPServer(
    {
      agentName,
      protocolVersion: '1.0',
      transport: 'stdio',
      requireAuth: false, // stdio = local, no auth needed
    },
    {
      discovery,
      threadResumeMap,
      trustManager,
      auth: null, // No auth for stdio
      sendMessage: (params) => sendMessageViaHttp(params, serverPort, agentToken),
      getThreadHistory: (threadId, _limit) =>
        Promise.resolve({ threadId, messages: [], totalCount: 0, hasMore: false } as ThreadHistoryResult),
      registry: registryClient,
    },
  );

  // Start — connects to stdin/stdout
  await mcpServer.start();

  // Keep process alive until Claude Code disconnects
  process.on('SIGINT', async () => {
    await mcpServer.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await mcpServer.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`MCP entry point failed: ${err}\n`);
  process.exit(1);
});
