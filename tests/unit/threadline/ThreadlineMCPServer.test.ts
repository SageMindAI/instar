/**
 * ThreadlineMCPServer — Unit Tests
 *
 * Tests the MCP server tool registration and behavior using mocked dependencies.
 * Covers all 7 tools:
 *   - threadline_discover
 *   - threadline_send
 *   - threadline_history
 *   - threadline_agents
 *   - threadline_delete
 *
 * Also covers:
 *   - Auth enforcement (local vs network)
 *   - Scope checking
 *   - Error handling
 *   - Edge cases
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ThreadlineMCPServer } from '../../../src/threadline/ThreadlineMCPServer.js';
import { MCPAuth } from '../../../src/threadline/MCPAuth.js';
import type {
  ThreadlineMCPServerConfig,
  ThreadlineMCPDeps,
  SendMessageResult,
  ThreadHistoryResult,
} from '../../../src/threadline/ThreadlineMCPServer.js';
import type { ThreadlineAgentInfo } from '../../../src/threadline/AgentDiscovery.js';
import type { ThreadResumeEntry } from '../../../src/threadline/ThreadResumeMap.js';
import type { AgentTrustProfile } from '../../../src/threadline/AgentTrustManager.js';

// ── Test Helpers ─────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-server-test-'));
}

function cleanupDir(dir: string): void {
  // safe-git-allow: incremental-migration
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function makeAgent(overrides?: Partial<ThreadlineAgentInfo>): ThreadlineAgentInfo {
  return {
    name: 'test-agent',
    port: 18700,
    path: '/tmp/test-agent',
    status: 'active',
    capabilities: ['conversation', 'code-review'],
    description: 'A test agent',
    threadlineEnabled: true,
    threadlineVersion: '1.0.0',
    publicKey: 'abc123',
    framework: 'instar',
    lastVerified: new Date().toISOString(),
    ...overrides,
  };
}

function makeThreadEntry(overrides?: Partial<ThreadResumeEntry>): ThreadResumeEntry {
  const now = new Date().toISOString();
  return {
    uuid: 'test-uuid-1234',
    sessionName: 'thread-abc12345',
    createdAt: now,
    savedAt: now,
    lastAccessedAt: now,
    remoteAgent: 'remote-agent',
    subject: 'Test thread',
    state: 'idle',
    pinned: false,
    messageCount: 5,
    ...overrides,
  };
}

function makeTrustProfile(overrides?: Partial<AgentTrustProfile>): AgentTrustProfile {
  return {
    agent: 'test-agent',
    level: 'verified',
    source: 'user-granted',
    history: {
      messagesReceived: 10,
      messagesResponded: 8,
      successfulInteractions: 8,
      failedInteractions: 0,
      lastInteraction: new Date().toISOString(),
      streakSinceIncident: 8,
    },
    allowedOperations: ['ping', 'health', 'message', 'query'],
    blockedOperations: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Mock Dependencies ────────────────────────────────────────────────

function createMockDeps(stateDir: string): ThreadlineMCPDeps {
  return {
    discovery: {
      discoverLocal: vi.fn().mockResolvedValue([makeAgent()]),
      loadKnownAgents: vi.fn().mockReturnValue([makeAgent()]),
      searchByCapability: vi.fn().mockReturnValue([]),
    } as any,
    threadResumeMap: {
      get: vi.fn().mockReturnValue(makeThreadEntry()),
      remove: vi.fn(),
      getByRemoteAgent: vi.fn().mockReturnValue([
        { threadId: 'thread-1', entry: makeThreadEntry() },
      ]),
      listActive: vi.fn().mockReturnValue([]),
    } as any,
    trustManager: {
      getProfile: vi.fn().mockReturnValue(makeTrustProfile()),
    } as any,
    auth: new MCPAuth(stateDir),
    sendMessage: vi.fn<any>().mockResolvedValue({
      success: true,
      threadId: 'thread-new-123',
      messageId: 'msg-456',
      reply: 'Hello back!',
      replyFrom: 'remote-agent',
    } satisfies SendMessageResult),
    getThreadHistory: vi.fn<any>().mockResolvedValue({
      threadId: 'thread-123',
      messages: [
        { id: 'msg-1', from: 'agent-a', body: 'Hello', timestamp: '2026-01-01T00:00:00Z', threadId: 'thread-123' },
        { id: 'msg-2', from: 'agent-b', body: 'Hi there', timestamp: '2026-01-01T00:01:00Z', threadId: 'thread-123' },
      ],
      totalCount: 2,
      hasMore: false,
    } satisfies ThreadHistoryResult),
  };
}

// ── Connect MCP Client+Server via InMemoryTransport ──────────────────

async function connectClientServer(
  config: Partial<ThreadlineMCPServerConfig>,
  deps: ThreadlineMCPDeps,
) {
  const fullConfig: ThreadlineMCPServerConfig = {
    agentName: 'test-agent',
    protocolVersion: '1.0.0',
    transport: 'stdio',
    requireAuth: false,
    ...config,
  };

  const server = new ThreadlineMCPServer(fullConfig, deps);
  const mcpServer = server.getServer();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: 'test-client', version: '1.0.0' });

  await Promise.all([
    client.connect(clientTransport),
    mcpServer.connect(serverTransport),
  ]);

  return { server, client, close: async () => {
    await client.close();
    await server.stop();
  }};
}

// ── Tests ────────────────────────────────────────────────────────────

describe('ThreadlineMCPServer', () => {
  let stateDir: string;
  let deps: ThreadlineMCPDeps;

  beforeEach(() => {
    stateDir = createTempDir();
    deps = createMockDeps(stateDir);
  });

  afterEach(() => {
    cleanupDir(stateDir);
  });

  // ── Server Lifecycle ─────────────────────────────────────────────

  describe('lifecycle', () => {
    it('creates server and lists 7 tools', async () => {
      const { client, close } = await connectClientServer({}, deps);
      try {
        const tools = await client.listTools();
        expect(tools.tools).toHaveLength(7);

        const names = tools.tools.map(t => t.name).sort();
        expect(names).toEqual([
          'threadline_agents',
          'threadline_delete',
          'threadline_discover',
          'threadline_history',
          'threadline_relay',
          'threadline_send',
          'threadline_trust',
        ]);
      } finally {
        await close();
      }
    });

    it('provides tool descriptions', async () => {
      const { client, close } = await connectClientServer({}, deps);
      try {
        const tools = await client.listTools();
        for (const tool of tools.tools) {
          expect(tool.description).toBeTruthy();
          expect(tool.description!.length).toBeGreaterThan(10);
        }
      } finally {
        await close();
      }
    });

    it('throws when started twice', async () => {
      const config: ThreadlineMCPServerConfig = {
        agentName: 'test',
        protocolVersion: '1.0.0',
        transport: 'stdio',
        requireAuth: false,
      };
      const server = new ThreadlineMCPServer(config, deps);
      // Manually start via non-stdio to allow double start testing
      await server.start();
      await expect(server.start()).rejects.toThrow('already started');
      await server.stop();
    });
  });

  // ── threadline_discover ──────────────────────────────────────────

  describe('threadline_discover', () => {
    it('discovers local agents', async () => {
      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_discover',
          arguments: { scope: 'local' },
        });

        const data = JSON.parse((result.content as any)[0].text);
        expect(data.scope).toBe('local');
        expect(data.count).toBe(1);
        expect(data.agents[0].name).toBe('test-agent');
        expect(deps.discovery.discoverLocal).toHaveBeenCalled();
      } finally {
        await close();
      }
    });

    it('discovers network agents from cache', async () => {
      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_discover',
          arguments: { scope: 'network' },
        });

        const data = JSON.parse((result.content as any)[0].text);
        expect(data.scope).toBe('network');
        expect(deps.discovery.loadKnownAgents).toHaveBeenCalled();
      } finally {
        await close();
      }
    });

    it('filters by capability', async () => {
      (deps.discovery.discoverLocal as any).mockResolvedValue([
        makeAgent({ name: 'coder', capabilities: ['code-review'] }),
        makeAgent({ name: 'researcher', capabilities: ['research'] }),
      ]);

      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_discover',
          arguments: { scope: 'local', capability: 'code-review' },
        });

        const data = JSON.parse((result.content as any)[0].text);
        expect(data.count).toBe(1);
        expect(data.agents[0].name).toBe('coder');
      } finally {
        await close();
      }
    });

    it('returns message when no agents found', async () => {
      (deps.discovery.discoverLocal as any).mockResolvedValue([]);

      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_discover',
          arguments: { scope: 'local' },
        });

        const text = (result.content as any)[0].text;
        expect(text).toContain('No Threadline-capable agents found');
      } finally {
        await close();
      }
    });

    it('does not expose internal fields like publicKey', async () => {
      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_discover',
          arguments: { scope: 'local' },
        });

        const data = JSON.parse((result.content as any)[0].text);
        expect(data.agents[0].publicKey).toBeUndefined();
        expect(data.agents[0].port).toBeUndefined();
        expect(data.agents[0].path).toBeUndefined();
      } finally {
        await close();
      }
    });

    it('handles discovery errors gracefully', async () => {
      (deps.discovery.discoverLocal as any).mockRejectedValue(new Error('Network timeout'));

      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_discover',
          arguments: { scope: 'local' },
        });

        const text = (result.content as any)[0].text;
        expect(text).toContain('Error');
        expect(text).toContain('Network timeout');
        expect(result.isError).toBe(true);
      } finally {
        await close();
      }
    });
  });

  // ── threadline_send ──────────────────────────────────────────────

  describe('threadline_send', () => {
    it('sends a message and receives reply', async () => {
      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_send',
          arguments: {
            agentId: 'remote-agent',
            message: 'Hello there!',
            waitForReply: true,
            timeoutSeconds: 30,
          },
        });

        const data = JSON.parse((result.content as any)[0].text);
        expect(data.delivered).toBe(true);
        expect(data.threadId).toBe('thread-new-123');
        expect(data.reply).toBe('Hello back!');
        expect(data.replyFrom).toBe('remote-agent');
      } finally {
        await close();
      }
    });

    it('sends with existing threadId for resume', async () => {
      const { client, close } = await connectClientServer({}, deps);
      try {
        await client.callTool({
          name: 'threadline_send',
          arguments: {
            agentId: 'remote-agent',
            threadId: 'existing-thread-42',
            message: 'Continuing our conversation',
          },
        });

        expect(deps.sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            targetAgent: 'remote-agent',
            threadId: 'existing-thread-42',
            message: 'Continuing our conversation',
          }),
        );
      } finally {
        await close();
      }
    });

    it('sends without waiting for reply', async () => {
      (deps.sendMessage as any).mockResolvedValue({
        success: true,
        threadId: 'thread-fire-forget',
        messageId: 'msg-789',
      });

      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_send',
          arguments: {
            agentId: 'remote-agent',
            message: 'Fire and forget',
            waitForReply: false,
          },
        });

        const data = JSON.parse((result.content as any)[0].text);
        expect(data.delivered).toBe(true);
        expect(data.reply).toBeUndefined();
      } finally {
        await close();
      }
    });

    it('reports timeout when no reply received', async () => {
      (deps.sendMessage as any).mockResolvedValue({
        success: true,
        threadId: 'thread-timeout',
        messageId: 'msg-timeout',
      });

      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_send',
          arguments: {
            agentId: 'remote-agent',
            message: 'Waiting...',
            waitForReply: true,
            timeoutSeconds: 5,
          },
        });

        const data = JSON.parse((result.content as any)[0].text);
        expect(data.delivered).toBe(true);
        expect(data.reply).toBeNull();
        expect(data.note).toContain('No reply received');
      } finally {
        await close();
      }
    });

    it('rejects empty message', async () => {
      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_send',
          arguments: {
            agentId: 'remote-agent',
            message: '   ',
          },
        });

        const text = (result.content as any)[0].text;
        expect(text).toContain('cannot be empty');
        expect(result.isError).toBe(true);
      } finally {
        await close();
      }
    });

    it('rejects invalid timeout', async () => {
      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_send',
          arguments: {
            agentId: 'remote-agent',
            message: 'Hello',
            timeoutSeconds: 999,
          },
        });

        const text = (result.content as any)[0].text;
        expect(text).toContain('timeoutSeconds must be between');
        expect(result.isError).toBe(true);
      } finally {
        await close();
      }
    });

    it('handles send failure', async () => {
      (deps.sendMessage as any).mockResolvedValue({
        success: false,
        threadId: '',
        messageId: '',
        error: 'Agent offline',
      });

      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_send',
          arguments: {
            agentId: 'offline-agent',
            message: 'Hello',
          },
        });

        const text = (result.content as any)[0].text;
        expect(text).toContain('Agent offline');
        expect(result.isError).toBe(true);
      } finally {
        await close();
      }
    });

    it('handles sendMessage exception', async () => {
      (deps.sendMessage as any).mockRejectedValue(new Error('Connection refused'));

      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_send',
          arguments: {
            agentId: 'broken-agent',
            message: 'Hello',
          },
        });

        const text = (result.content as any)[0].text;
        expect(text).toContain('Connection refused');
        expect(result.isError).toBe(true);
      } finally {
        await close();
      }
    });
  });

  // ── threadline_history ─────────────────────────────────────────────

  describe('threadline_history', () => {
    it('retrieves thread history', async () => {
      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_history',
          arguments: { threadId: 'thread-123' },
        });

        const data = JSON.parse((result.content as any)[0].text);
        expect(data.threadId).toBe('thread-123');
        expect(data.messageCount).toBe(2);
        expect(data.messages[0].from).toBe('agent-a');
        expect(data.messages[1].body).toBe('Hi there');
      } finally {
        await close();
      }
    });

    it('passes limit and before parameters', async () => {
      const { client, close } = await connectClientServer({}, deps);
      try {
        await client.callTool({
          name: 'threadline_history',
          arguments: {
            threadId: 'thread-123',
            limit: 5,
            before: '2026-01-01T00:00:00Z',
          },
        });

        expect(deps.getThreadHistory).toHaveBeenCalledWith(
          'thread-123',
          5,
          '2026-01-01T00:00:00Z',
        );
      } finally {
        await close();
      }
    });

    it('returns error for nonexistent thread', async () => {
      (deps.threadResumeMap.get as any).mockReturnValue(null);

      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_history',
          arguments: { threadId: 'nonexistent' },
        });

        const text = (result.content as any)[0].text;
        expect(text).toContain('not found');
        expect(result.isError).toBe(true);
      } finally {
        await close();
      }
    });

    it('rejects limit out of range', async () => {
      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_history',
          arguments: { threadId: 'thread-123', limit: 500 },
        });

        const text = (result.content as any)[0].text;
        expect(text).toContain('limit must be between');
        expect(result.isError).toBe(true);
      } finally {
        await close();
      }
    });

    it('handles history retrieval error', async () => {
      (deps.getThreadHistory as any).mockRejectedValue(new Error('Storage error'));

      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_history',
          arguments: { threadId: 'thread-123' },
        });

        const text = (result.content as any)[0].text;
        expect(text).toContain('Storage error');
        expect(result.isError).toBe(true);
      } finally {
        await close();
      }
    });
  });

  // ── threadline_agents ──────────────────────────────────────────────

  describe('threadline_agents', () => {
    it('lists known active agents', async () => {
      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_agents',
          arguments: {},
        });

        const data = JSON.parse((result.content as any)[0].text);
        expect(data.count).toBe(1);
        expect(data.agents[0].name).toBe('test-agent');
        expect(data.agents[0].activeThreads).toBe(1);
      } finally {
        await close();
      }
    });

    it('shows trust levels for local (stdio) connections', async () => {
      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_agents',
          arguments: {},
        });

        const data = JSON.parse((result.content as any)[0].text);
        expect(data.agents[0].trustLevel).toBe('verified');
        expect(data.agents[0].trustSource).toBe('user-granted');
      } finally {
        await close();
      }
    });

    it('includes offline agents when requested', async () => {
      (deps.discovery.loadKnownAgents as any).mockReturnValue([
        makeAgent({ name: 'online', status: 'active' }),
        makeAgent({ name: 'offline', status: 'inactive' }),
      ]);

      const { client, close } = await connectClientServer({}, deps);
      try {
        // Without includeOffline
        const result1 = await client.callTool({
          name: 'threadline_agents',
          arguments: { includeOffline: false },
        });
        const data1 = JSON.parse((result1.content as any)[0].text);
        expect(data1.count).toBe(1);

        // With includeOffline
        const result2 = await client.callTool({
          name: 'threadline_agents',
          arguments: { includeOffline: true },
        });
        const data2 = JSON.parse((result2.content as any)[0].text);
        expect(data2.count).toBe(2);
      } finally {
        await close();
      }
    });

    it('handles no agents gracefully', async () => {
      (deps.discovery.loadKnownAgents as any).mockReturnValue([]);

      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_agents',
          arguments: {},
        });

        const data = JSON.parse((result.content as any)[0].text);
        expect(data.count).toBe(0);
        expect(data.agents).toEqual([]);
      } finally {
        await close();
      }
    });
  });

  // ── threadline_delete ──────────────────────────────────────────────

  describe('threadline_delete', () => {
    it('deletes a thread with confirmation', async () => {
      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_delete',
          arguments: { threadId: 'thread-123', confirm: true },
        });

        const data = JSON.parse((result.content as any)[0].text);
        expect(data.deleted).toBe(true);
        expect(data.threadId).toBe('thread-123');
        expect(data.remoteAgent).toBe('remote-agent');
        expect(deps.threadResumeMap.remove).toHaveBeenCalledWith('thread-123');
      } finally {
        await close();
      }
    });

    it('requires confirmation', async () => {
      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_delete',
          arguments: { threadId: 'thread-123', confirm: false },
        });

        const text = (result.content as any)[0].text;
        expect(text).toContain('confirmation');
        expect(result.isError).toBe(true);
        expect(deps.threadResumeMap.remove).not.toHaveBeenCalled();
      } finally {
        await close();
      }
    });

    it('defaults confirm to false', async () => {
      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_delete',
          arguments: { threadId: 'thread-123' },
        });

        const text = (result.content as any)[0].text;
        expect(text).toContain('confirmation');
        expect(result.isError).toBe(true);
      } finally {
        await close();
      }
    });

    it('returns error for nonexistent thread', async () => {
      (deps.threadResumeMap.get as any).mockReturnValue(null);

      const { client, close } = await connectClientServer({}, deps);
      try {
        const result = await client.callTool({
          name: 'threadline_delete',
          arguments: { threadId: 'gone', confirm: true },
        });

        const text = (result.content as any)[0].text;
        expect(text).toContain('not found');
        expect(result.isError).toBe(true);
      } finally {
        await close();
      }
    });
  });

  // ── Auth Enforcement ─────────────────────────────────────────────

  describe('auth enforcement', () => {
    it('allows all tools without auth for local stdio', async () => {
      const { client, close } = await connectClientServer(
        { transport: 'stdio', requireAuth: false },
        deps,
      );
      try {
        // All tools should work without auth
        const discover = await client.callTool({
          name: 'threadline_discover',
          arguments: { scope: 'local' },
        });
        expect(discover.isError).toBeFalsy();

        const agents = await client.callTool({
          name: 'threadline_agents',
          arguments: {},
        });
        expect(agents.isError).toBeFalsy();
      } finally {
        await close();
      }
    });

    it('rejects unauthenticated network requests', async () => {
      const { server, client, close } = await connectClientServer(
        { transport: 'sse', requireAuth: true },
        deps,
      );
      try {
        // Set network context without auth
        server.setRequestContext({
          authenticated: false,
          isLocal: false,
        });

        const result = await client.callTool({
          name: 'threadline_discover',
          arguments: { scope: 'local' },
        });

        const text = (result.content as any)[0].text;
        expect(text).toContain('Authentication required');
        expect(result.isError).toBe(true);
      } finally {
        await close();
      }
    });

    it('allows authenticated network requests with correct scope', async () => {
      const { server, client, close } = await connectClientServer(
        { transport: 'sse', requireAuth: true },
        deps,
      );
      try {
        const tokenResult = deps.auth!.createToken('test', ['threadline:discover']);
        server.authenticateBearer(tokenResult.rawToken);

        const result = await client.callTool({
          name: 'threadline_discover',
          arguments: { scope: 'local' },
        });
        expect(result.isError).toBeFalsy();
      } finally {
        await close();
      }
    });

    it('rejects network requests with insufficient scope', async () => {
      const { server, client, close } = await connectClientServer(
        { transport: 'sse', requireAuth: true },
        deps,
      );
      try {
        // Create token with only discover scope
        const tokenResult = deps.auth!.createToken('limited', ['threadline:discover']);
        server.authenticateBearer(tokenResult.rawToken);

        // Try to send (requires threadline:send)
        const result = await client.callTool({
          name: 'threadline_send',
          arguments: { agentId: 'x', message: 'test' },
        });

        const text = (result.content as any)[0].text;
        expect(text).toContain('Insufficient scope');
        expect(result.isError).toBe(true);
      } finally {
        await close();
      }
    });

    it('admin scope allows all operations', async () => {
      const { server, client, close } = await connectClientServer(
        { transport: 'sse', requireAuth: true },
        deps,
      );
      try {
        const tokenResult = deps.auth!.createToken('admin', ['threadline:admin']);
        server.authenticateBearer(tokenResult.rawToken);

        // All operations should work
        const discover = await client.callTool({
          name: 'threadline_discover',
          arguments: { scope: 'local' },
        });
        expect(discover.isError).toBeFalsy();

        const send = await client.callTool({
          name: 'threadline_send',
          arguments: { agentId: 'x', message: 'test' },
        });
        expect(send.isError).toBeFalsy();

        const history = await client.callTool({
          name: 'threadline_history',
          arguments: { threadId: 'thread-123' },
        });
        expect(history.isError).toBeFalsy();
      } finally {
        await close();
      }
    });

    it('hides trust levels for non-admin network tokens', async () => {
      const { server, client, close } = await connectClientServer(
        { transport: 'sse', requireAuth: true },
        deps,
      );
      try {
        const tokenResult = deps.auth!.createToken('discover-only', ['threadline:discover']);
        server.authenticateBearer(tokenResult.rawToken);

        const result = await client.callTool({
          name: 'threadline_agents',
          arguments: {},
        });

        const data = JSON.parse((result.content as any)[0].text);
        // Trust levels should be hidden for non-admin
        expect(data.agents[0].trustLevel).toBeUndefined();
        expect(data.agents[0].trustSource).toBeUndefined();
      } finally {
        await close();
      }
    });

    it('shows trust levels for admin network tokens', async () => {
      const { server, client, close } = await connectClientServer(
        { transport: 'sse', requireAuth: true },
        deps,
      );
      try {
        const tokenResult = deps.auth!.createToken('admin', ['threadline:admin']);
        server.authenticateBearer(tokenResult.rawToken);

        const result = await client.callTool({
          name: 'threadline_agents',
          arguments: {},
        });

        const data = JSON.parse((result.content as any)[0].text);
        expect(data.agents[0].trustLevel).toBe('verified');
      } finally {
        await close();
      }
    });

    it('delete requires admin scope for network', async () => {
      const { server, client, close } = await connectClientServer(
        { transport: 'sse', requireAuth: true },
        deps,
      );
      try {
        const tokenResult = deps.auth!.createToken('send-only', ['threadline:send']);
        server.authenticateBearer(tokenResult.rawToken);

        const result = await client.callTool({
          name: 'threadline_delete',
          arguments: { threadId: 'thread-123', confirm: true },
        });

        const text = (result.content as any)[0].text;
        expect(text).toContain('Insufficient scope');
        expect(result.isError).toBe(true);
      } finally {
        await close();
      }
    });

    it('authenticateBearer returns false for invalid token', async () => {
      const config: ThreadlineMCPServerConfig = {
        agentName: 'test',
        protocolVersion: '1.0.0',
        transport: 'sse',
        requireAuth: true,
      };
      const server = new ThreadlineMCPServer(config, deps);
      expect(server.authenticateBearer('invalid-token')).toBe(false);
    });
  });
});
