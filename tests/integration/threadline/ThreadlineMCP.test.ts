/**
 * ThreadlineMCP — Integration Tests
 *
 * Tests the MCP server with REAL Threadline components wired together:
 * - Real MCPAuth (token persistence to disk)
 * - Real ThreadResumeMap (file-based thread state)
 * - Real AgentDiscovery (but with mocked HTTP fetcher)
 * - Real AgentTrustManager (file-based trust profiles)
 * - Simulated message sending and history retrieval
 *
 * Uses InMemoryTransport to connect MCP client ↔ server without stdio.
 *
 * Covers:
 * - Multi-turn conversations via threadline_send
 * - Thread lifecycle (create → send → history → delete)
 * - Auth token flow (create → authenticate → use tools)
 * - Discovery with real AgentDiscovery
 * - Trust level visibility with real trust profiles
 * - Error handling with real component failures
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ThreadlineMCPServer } from '../../../src/threadline/ThreadlineMCPServer.js';
import { MCPAuth } from '../../../src/threadline/MCPAuth.js';
import { ThreadResumeMap } from '../../../src/threadline/ThreadResumeMap.js';

/**
 * Test-friendly ThreadResumeMap that skips JSONL file existence checks.
 * In production, ThreadResumeMap.get() verifies the Claude JSONL file exists.
 * In tests, those files don't exist, so we override to skip that check.
 */
class TestThreadResumeMap extends ThreadResumeMap {
  /**
   * Override get() to use the raw data without JSONL verification.
   * We access the internal load() and isExpired() by reading the file directly.
   */
  get(threadId: string): import('../../../src/threadline/ThreadResumeMap.js').ThreadResumeEntry | null {
    // Read the file directly to bypass JSONL check
    const filePath = (this as any).filePath;
    try {
      if (!fs.existsSync(filePath)) return null;
      const map = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const entry = map[threadId];
      if (!entry) return null;
      return entry;
    } catch {
      return null;
    }
  }
}
import { AgentDiscovery } from '../../../src/threadline/AgentDiscovery.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import type {
  ThreadlineMCPServerConfig,
  ThreadlineMCPDeps,
  SendMessageResult,
  ThreadHistoryMessage,
  ThreadHistoryResult,
} from '../../../src/threadline/ThreadlineMCPServer.js';
import type { HttpFetcher } from '../../../src/threadline/AgentDiscovery.js';

// ── Test Helpers ─────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-integ-test-'));
}

function cleanupDir(dir: string): void {
  // safe-git-allow: incremental-migration
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── Simulated Message Store ──────────────────────────────────────────

class SimulatedMessageStore {
  private threads: Map<string, ThreadHistoryMessage[]> = new Map();
  private nextMsgId = 1;

  addMessage(threadId: string, from: string, body: string): string {
    const id = `msg-${this.nextMsgId++}`;
    if (!this.threads.has(threadId)) {
      this.threads.set(threadId, []);
    }
    this.threads.get(threadId)!.push({
      id,
      from,
      body,
      timestamp: new Date().toISOString(),
      threadId,
    });
    return id;
  }

  getHistory(threadId: string, limit: number, before?: string): ThreadHistoryResult {
    let messages = this.threads.get(threadId) || [];

    if (before) {
      const beforeTime = new Date(before).getTime();
      messages = messages.filter(m => new Date(m.timestamp).getTime() < beforeTime);
    }

    const totalCount = messages.length;
    const sliced = messages.slice(-limit);

    return {
      threadId,
      messages: sliced,
      totalCount,
      hasMore: totalCount > limit,
    };
  }
}

// ── Integration Setup ────────────────────────────────────────────────

interface IntegrationContext {
  stateDir: string;
  projectDir: string;
  auth: MCPAuth;
  threadMap: ThreadResumeMap;
  discovery: AgentDiscovery;
  trustManager: AgentTrustManager;
  messageStore: SimulatedMessageStore;
  server: ThreadlineMCPServer;
  client: Client;
  close: () => Promise<void>;
}

async function createIntegrationContext(
  configOverrides?: Partial<ThreadlineMCPServerConfig>,
): Promise<IntegrationContext> {
  const stateDir = createTempDir();
  const projectDir = createTempDir();

  const auth = new MCPAuth(stateDir);
  const threadMap = new TestThreadResumeMap(stateDir, projectDir);
  const messageStore = new SimulatedMessageStore();

  // Create mock HTTP fetcher for discovery (no real HTTP calls)
  const mockFetcher: HttpFetcher = vi.fn().mockResolvedValue({
    ok: false,
    status: 404,
    json: () => Promise.resolve({}),
  });

  const discovery = new AgentDiscovery({
    stateDir,
    selfPath: projectDir,
    selfName: 'integration-test-agent',
    selfPort: 18700,
    fetcher: mockFetcher,
  });

  const trustManager = new AgentTrustManager({ stateDir });

  let threadCounter = 1;

  const deps: ThreadlineMCPDeps = {
    discovery,
    threadResumeMap: threadMap,
    trustManager,
    auth,
    sendMessage: async (params) => {
      const threadId = params.threadId || `thread-${threadCounter++}`;
      const msgId = messageStore.addMessage(threadId, 'local-agent', params.message);

      // Simulate creating thread entry if new
      if (!threadMap.get(threadId)) {
        const now = new Date().toISOString();
        threadMap.save(threadId, {
          uuid: `uuid-${threadId}`,
          sessionName: `session-${threadId.slice(0, 8)}`,
          createdAt: now,
          savedAt: now,
          lastAccessedAt: now,
          remoteAgent: params.targetAgent,
          subject: params.message.slice(0, 50),
          state: 'active',
          pinned: false,
          messageCount: 1,
        });
      }

      if (params.waitForReply) {
        // Simulate a reply
        const replyId = messageStore.addMessage(threadId, params.targetAgent, `Reply to: ${params.message}`);
        return {
          success: true,
          threadId,
          messageId: msgId,
          reply: `Reply to: ${params.message}`,
          replyFrom: params.targetAgent,
        };
      }

      return {
        success: true,
        threadId,
        messageId: msgId,
      };
    },
    getThreadHistory: async (threadId, limit, before) => {
      return messageStore.getHistory(threadId, limit, before);
    },
  };

  const config: ThreadlineMCPServerConfig = {
    agentName: 'integration-test-agent',
    protocolVersion: '1.0.0',
    transport: 'stdio',
    requireAuth: false,
    ...configOverrides,
  };

  const server = new ThreadlineMCPServer(config, deps);
  const mcpServer = server.getServer();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'integration-test-client', version: '1.0.0' });

  await Promise.all([
    client.connect(clientTransport),
    mcpServer.connect(serverTransport),
  ]);

  return {
    stateDir,
    projectDir,
    auth,
    threadMap,
    discovery,
    trustManager,
    messageStore,
    server,
    client,
    close: async () => {
      await client.close();
      await server.stop();
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('ThreadlineMCP Integration', () => {
  let ctx: IntegrationContext;

  afterEach(async () => {
    if (ctx) {
      await ctx.close();
      cleanupDir(ctx.stateDir);
      cleanupDir(ctx.projectDir);
    }
  });

  // ── Full Conversation Flow ─────────────────────────────────────

  describe('full conversation flow', () => {
    it('creates a new thread, sends messages, checks history, deletes thread', async () => {
      ctx = await createIntegrationContext();

      // Step 1: Send first message (creates a new thread)
      const sendResult1 = await ctx.client.callTool({
        name: 'threadline_send',
        arguments: {
          agentId: 'partner-agent',
          message: 'Hello, this is the first message!',
          waitForReply: true,
        },
      });
      const send1 = JSON.parse((sendResult1.content as any)[0].text);
      expect(send1.delivered).toBe(true);
      expect(send1.threadId).toBeTruthy();
      expect(send1.reply).toContain('Reply to:');

      const threadId = send1.threadId;

      // Step 2: Send follow-up on same thread
      const sendResult2 = await ctx.client.callTool({
        name: 'threadline_send',
        arguments: {
          agentId: 'partner-agent',
          threadId,
          message: 'This is the second message!',
          waitForReply: true,
        },
      });
      const send2 = JSON.parse((sendResult2.content as any)[0].text);
      expect(send2.delivered).toBe(true);
      expect(send2.threadId).toBe(threadId);

      // Step 3: Retrieve history
      const historyResult = await ctx.client.callTool({
        name: 'threadline_history',
        arguments: { threadId, limit: 20 },
      });
      expect(historyResult.isError).toBeFalsy();
      const history = JSON.parse((historyResult.content as any)[0].text);
      expect(history.threadId).toBe(threadId);
      // 2 messages sent + 2 replies = 4
      expect(history.messageCount).toBe(4);

      // Step 4: Delete the thread
      const deleteResult = await ctx.client.callTool({
        name: 'threadline_delete',
        arguments: { threadId, confirm: true },
      });
      const deleted = JSON.parse((deleteResult.content as any)[0].text);
      expect(deleted.deleted).toBe(true);
      expect(deleted.threadId).toBe(threadId);
      expect(deleted.remoteAgent).toBe('partner-agent');

      // Step 5: Verify thread is gone
      const historyResult2 = await ctx.client.callTool({
        name: 'threadline_history',
        arguments: { threadId },
      });
      const text = (historyResult2.content as any)[0].text;
      expect(text).toContain('not found');
    });

    it('supports multiple concurrent threads with different agents', async () => {
      ctx = await createIntegrationContext();

      // Thread 1 with agent-alpha
      const r1 = await ctx.client.callTool({
        name: 'threadline_send',
        arguments: { agentId: 'agent-alpha', message: 'Hi Alpha!' },
      });
      const t1 = JSON.parse((r1.content as any)[0].text);

      // Thread 2 with agent-beta
      const r2 = await ctx.client.callTool({
        name: 'threadline_send',
        arguments: { agentId: 'agent-beta', message: 'Hi Beta!' },
      });
      const t2 = JSON.parse((r2.content as any)[0].text);

      expect(t1.threadId).not.toBe(t2.threadId);

      // Both threads should have history
      const h1 = await ctx.client.callTool({
        name: 'threadline_history',
        arguments: { threadId: t1.threadId },
      });
      const h2 = await ctx.client.callTool({
        name: 'threadline_history',
        arguments: { threadId: t2.threadId },
      });

      const hist1 = JSON.parse((h1.content as any)[0].text);
      const hist2 = JSON.parse((h2.content as any)[0].text);

      expect(hist1.messages.some((m: any) => m.body.includes('Alpha'))).toBe(true);
      expect(hist2.messages.some((m: any) => m.body.includes('Beta'))).toBe(true);
    });
  });

  // ── Token-Based Auth Flow ──────────────────────────────────────

  describe('token-based auth flow', () => {
    it('full token lifecycle: create → auth → use → revoke → fail', async () => {
      ctx = await createIntegrationContext({
        transport: 'sse',
        requireAuth: true,
      });

      // Create token with send + discover scopes
      const tokenResult = ctx.auth.createToken('test-client', [
        'threadline:send',
        'threadline:discover',
      ]);

      // Authenticate with the token
      const authed = ctx.server.authenticateBearer(tokenResult.rawToken);
      expect(authed).toBe(true);

      // Use discover tool (should work)
      const discoverResult = await ctx.client.callTool({
        name: 'threadline_discover',
        arguments: { scope: 'local' },
      });
      expect(discoverResult.isError).toBeFalsy();

      // Use send tool (should work)
      const sendResult = await ctx.client.callTool({
        name: 'threadline_send',
        arguments: { agentId: 'x', message: 'test' },
      });
      expect(sendResult.isError).toBeFalsy();

      // Try read (should fail — no read scope)
      const historyResult = await ctx.client.callTool({
        name: 'threadline_history',
        arguments: { threadId: 'thread-1' },
      });
      expect(historyResult.isError).toBe(true);

      // Revoke the token
      ctx.auth.revokeToken(tokenResult.id);

      // Re-authenticate should fail
      const reAuthed = ctx.server.authenticateBearer(tokenResult.rawToken);
      expect(reAuthed).toBe(false);

      // Tool calls should now fail
      const failResult = await ctx.client.callTool({
        name: 'threadline_discover',
        arguments: { scope: 'local' },
      });
      expect(failResult.isError).toBe(true);
    });

    it('admin token grants full access', async () => {
      ctx = await createIntegrationContext({
        transport: 'sse',
        requireAuth: true,
      });

      const tokenResult = ctx.auth.createToken('admin', ['threadline:admin']);
      ctx.server.authenticateBearer(tokenResult.rawToken);

      // All tools should work
      const tools = ['threadline_discover', 'threadline_agents'];
      for (const tool of tools) {
        const result = await ctx.client.callTool({
          name: tool,
          arguments: tool === 'threadline_discover' ? { scope: 'local' } : {},
        });
        expect(result.isError).toBeFalsy();
      }
    });
  });

  // ── Real ThreadResumeMap Integration ───────────────────────────

  describe('ThreadResumeMap integration', () => {
    it('thread state persists across server restarts', async () => {
      ctx = await createIntegrationContext();

      // Create a thread
      const sendResult = await ctx.client.callTool({
        name: 'threadline_send',
        arguments: { agentId: 'persistent-agent', message: 'Hello!' },
      });
      const { threadId } = JSON.parse((sendResult.content as any)[0].text);

      // Verify thread exists in the real ThreadResumeMap
      const entry = ctx.threadMap.get(threadId);
      expect(entry).not.toBeNull();
      expect(entry!.remoteAgent).toBe('persistent-agent');
      expect(entry!.state).toBe('active');

      // The thread data is persisted to disk — a new TestThreadResumeMap
      // instance reading the same stateDir would see it
      const threadMap2 = new TestThreadResumeMap(ctx.stateDir, ctx.projectDir);
      const entry2 = threadMap2.get(threadId);
      expect(entry2).not.toBeNull();
      expect(entry2!.remoteAgent).toBe('persistent-agent');
    });
  });

  // ── Real AgentTrustManager Integration ─────────────────────────

  describe('AgentTrustManager integration', () => {
    it('shows real trust profiles in agent listing', async () => {
      ctx = await createIntegrationContext();

      // Set up a real trust profile
      ctx.trustManager.setTrustLevel('known-agent', 'trusted', 'user-granted', 'Manually trusted');

      // Seed a known agent
      ctx.discovery.announcePresence({
        capabilities: ['conversation'],
        threadlineVersion: '1.0.0',
        framework: 'instar',
      });

      // The known-agents list needs to include this agent for the test
      // Since our discovery mock doesn't return any agents from HTTP,
      // we need to pre-populate
      const knownAgentsPath = path.join(ctx.stateDir, 'threadline', 'known-agents.json');
      fs.writeFileSync(knownAgentsPath, JSON.stringify({
        agents: [{
          name: 'known-agent',
          port: 18701,
          path: '/tmp/known',
          status: 'active',
          capabilities: ['conversation'],
          threadlineEnabled: true,
          threadlineVersion: '1.0.0',
          framework: 'instar',
        }],
        updatedAt: new Date().toISOString(),
      }));

      const result = await ctx.client.callTool({
        name: 'threadline_agents',
        arguments: {},
      });

      const data = JSON.parse((result.content as any)[0].text);
      const agent = data.agents.find((a: any) => a.name === 'known-agent');
      expect(agent).toBeTruthy();
      expect(agent.trustLevel).toBe('trusted');
      expect(agent.trustSource).toBe('user-granted');
    });
  });

  // ── History Pagination ─────────────────────────────────────────

  describe('history pagination', () => {
    it('limits returned messages', async () => {
      ctx = await createIntegrationContext();

      // Create a thread with many messages
      const sendResult = await ctx.client.callTool({
        name: 'threadline_send',
        arguments: { agentId: 'chatty', message: 'msg-1' },
      });
      const { threadId } = JSON.parse((sendResult.content as any)[0].text);

      // Add more messages directly
      for (let i = 2; i <= 10; i++) {
        ctx.messageStore.addMessage(threadId, 'local', `msg-${i}`);
        ctx.messageStore.addMessage(threadId, 'chatty', `reply-${i}`);
      }

      // Get only 5 messages
      const result = await ctx.client.callTool({
        name: 'threadline_history',
        arguments: { threadId, limit: 5 },
      });

      const data = JSON.parse((result.content as any)[0].text);
      expect(data.messageCount).toBe(5);
      expect(data.hasMore).toBe(true);
      expect(data.totalCount).toBeGreaterThan(5);
    });
  });

  // ── Error Scenarios ────────────────────────────────────────────

  describe('error scenarios', () => {
    it('handles fire-and-forget message (no waitForReply)', async () => {
      ctx = await createIntegrationContext();

      const result = await ctx.client.callTool({
        name: 'threadline_send',
        arguments: {
          agentId: 'background-agent',
          message: 'Process this asynchronously',
          waitForReply: false,
        },
      });

      const data = JSON.parse((result.content as any)[0].text);
      expect(data.delivered).toBe(true);
      expect(data.reply).toBeUndefined();
    });

    it('cannot delete non-existent thread', async () => {
      ctx = await createIntegrationContext();

      const result = await ctx.client.callTool({
        name: 'threadline_delete',
        arguments: { threadId: 'does-not-exist', confirm: true },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as any)[0].text;
      expect(text).toContain('not found');
    });

    it('thread delete is permanent', async () => {
      ctx = await createIntegrationContext();

      // Create a thread
      const sendResult = await ctx.client.callTool({
        name: 'threadline_send',
        arguments: { agentId: 'doomed', message: 'This will be deleted' },
      });
      const { threadId } = JSON.parse((sendResult.content as any)[0].text);

      // Delete it
      await ctx.client.callTool({
        name: 'threadline_delete',
        arguments: { threadId, confirm: true },
      });

      // Verify removal from ThreadResumeMap
      expect(ctx.threadMap.get(threadId)).toBeNull();

      // Try to send on the deleted thread (should create a new one)
      const sendResult2 = await ctx.client.callTool({
        name: 'threadline_send',
        arguments: { agentId: 'doomed', threadId, message: 'After deletion' },
      });
      const data2 = JSON.parse((sendResult2.content as any)[0].text);
      expect(data2.delivered).toBe(true);
    });
  });

  // ── Tool Discovery ─────────────────────────────────────────────

  describe('tool discovery', () => {
    it('client can list all tools and their schemas', async () => {
      ctx = await createIntegrationContext();

      const tools = await ctx.client.listTools();
      expect(tools.tools).toHaveLength(7);

      // Verify each tool has input schema
      for (const tool of tools.tools) {
        expect(tool.inputSchema).toBeTruthy();
        expect(tool.inputSchema.type).toBe('object');
      }

      // Verify specific schemas
      const sendTool = tools.tools.find(t => t.name === 'threadline_send');
      expect(sendTool!.inputSchema.required).toContain('agentId');
      expect(sendTool!.inputSchema.required).toContain('message');

      const historyTool = tools.tools.find(t => t.name === 'threadline_history');
      expect(historyTool!.inputSchema.required).toContain('threadId');
    });
  });
});
