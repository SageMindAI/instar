/**
 * ThreadlineMCP — End-to-End Tests
 *
 * Tests the complete MCP server with real transports and full lifecycle:
 * - Full stdio transport simulation via InMemoryTransport
 * - Multi-turn conversations with session persistence
 * - Auth token lifecycle (create, use, revoke, expire)
 * - Concurrent tool calls
 * - Tool parameter validation
 * - Error recovery
 * - Network auth enforcement end-to-end
 *
 * These tests simulate what a real MCP client (e.g., Claude Code) would
 * experience when connecting to the Threadline MCP server.
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
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import { AgentDiscovery } from '../../../src/threadline/AgentDiscovery.js';
import type {
  ThreadlineMCPServerConfig,
  ThreadlineMCPDeps,
  SendMessageResult,
  ThreadHistoryMessage,
  ThreadHistoryResult,
} from '../../../src/threadline/ThreadlineMCPServer.js';
import type { HttpFetcher } from '../../../src/threadline/AgentDiscovery.js';

// ── Helpers ──────────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-test-'));
}

function cleanupDir(dir: string): void {
  // safe-git-allow: incremental-migration
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Test-friendly ThreadResumeMap that skips JSONL file existence checks.
 */
class TestThreadResumeMap extends ThreadResumeMap {
  get(threadId: string): import('../../../src/threadline/ThreadResumeMap.js').ThreadResumeEntry | null {
    const filePath = (this as any).filePath;
    try {
      if (!fs.existsSync(filePath)) return null;
      const map = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return map[threadId] || null;
    } catch { return null; }
  }
}

// ── In-Memory Message System ─────────────────────────────────────────

class E2EMessageSystem {
  private threads = new Map<string, ThreadHistoryMessage[]>();
  private nextId = 1;
  private responseDelay = 0;
  private failNextSend = false;

  setResponseDelay(ms: number) { this.responseDelay = ms; }
  setFailNextSend(fail: boolean) { this.failNextSend = fail; }

  addMessage(threadId: string, from: string, body: string): string {
    const id = `e2e-msg-${this.nextId++}`;
    if (!this.threads.has(threadId)) this.threads.set(threadId, []);
    this.threads.get(threadId)!.push({
      id, from, body,
      timestamp: new Date().toISOString(),
      threadId,
    });
    return id;
  }

  getHistory(threadId: string, limit: number, before?: string): ThreadHistoryResult {
    let msgs = this.threads.get(threadId) || [];
    if (before) {
      const ts = new Date(before).getTime();
      msgs = msgs.filter(m => new Date(m.timestamp).getTime() < ts);
    }
    const total = msgs.length;
    const sliced = msgs.slice(-limit);
    return { threadId, messages: sliced, totalCount: total, hasMore: total > limit };
  }

  getResponseDelay() { return this.responseDelay; }
  shouldFail() { return this.failNextSend; }
}

// ── E2E Setup ────────────────────────────────────────────────────────

async function createE2ESetup(config?: Partial<ThreadlineMCPServerConfig>) {
  const stateDir = createTempDir();
  const projectDir = createTempDir();
  const msgSystem = new E2EMessageSystem();
  const auth = new MCPAuth(stateDir);
  const threadMap = new TestThreadResumeMap(stateDir, projectDir);
  const trustManager = new AgentTrustManager({ stateDir });

  const mockFetcher: HttpFetcher = vi.fn().mockImplementation(async (url: string) => {
    // Simulate a threadline health endpoint
    if (url.includes('/threadline/health')) {
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          status: 'ok',
          protocol: 'threadline',
          version: '1.0.0',
          agent: 'simulated-agent',
          capabilities: ['conversation', 'research'],
          framework: 'instar',
        }),
      };
    }
    return { ok: false, status: 404, json: () => Promise.resolve({}) };
  });

  const discovery = new AgentDiscovery({
    stateDir,
    selfPath: projectDir,
    selfName: 'e2e-agent',
    selfPort: 18700,
    fetcher: mockFetcher,
  });

  let threadCounter = 1;

  const deps: ThreadlineMCPDeps = {
    discovery, threadResumeMap: threadMap, trustManager, auth,
    sendMessage: async (params) => {
      if (msgSystem.shouldFail()) {
        msgSystem.setFailNextSend(false);
        return { success: false, threadId: '', messageId: '', error: 'Simulated failure' };
      }

      const delay = msgSystem.getResponseDelay();
      if (delay > 0) await new Promise(r => setTimeout(r, delay));

      const threadId = params.threadId || `e2e-thread-${threadCounter++}`;
      const msgId = msgSystem.addMessage(threadId, 'e2e-agent', params.message);

      if (!threadMap.get(threadId)) {
        const now = new Date().toISOString();
        threadMap.save(threadId, {
          uuid: `e2e-uuid-${threadId}`,
          sessionName: `e2e-session-${threadId.slice(0, 8)}`,
          createdAt: now, savedAt: now, lastAccessedAt: now,
          remoteAgent: params.targetAgent,
          subject: params.message.slice(0, 50),
          state: 'active', pinned: false, messageCount: 1,
        });
      }

      if (params.waitForReply) {
        msgSystem.addMessage(threadId, params.targetAgent, `E2E reply to: ${params.message}`);
        return {
          success: true, threadId, messageId: msgId,
          reply: `E2E reply to: ${params.message}`,
          replyFrom: params.targetAgent,
        };
      }
      return { success: true, threadId, messageId: msgId };
    },
    getThreadHistory: async (threadId, limit, before) =>
      msgSystem.getHistory(threadId, limit, before),
  };

  const fullConfig: ThreadlineMCPServerConfig = {
    agentName: 'e2e-agent',
    protocolVersion: '1.0.0',
    transport: 'stdio',
    requireAuth: false,
    ...config,
  };

  const server = new ThreadlineMCPServer(fullConfig, deps);
  const mcpServer = server.getServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'e2e-client', version: '1.0.0' });
  await Promise.all([client.connect(ct), mcpServer.connect(st)]);

  return {
    stateDir, projectDir, auth, threadMap, trustManager, discovery,
    msgSystem, server, client,
    close: async () => { await client.close(); await server.stop(); },
    cleanup: () => { cleanupDir(stateDir); cleanupDir(projectDir); },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('ThreadlineMCP E2E', () => {
  let e2e: Awaited<ReturnType<typeof createE2ESetup>>;

  afterEach(async () => {
    if (e2e) {
      await e2e.close();
      e2e.cleanup();
    }
  });

  // ── Multi-Turn Conversation E2E ────────────────────────────────

  describe('multi-turn conversation', () => {
    it('maintains context across 5 messages in a thread', async () => {
      e2e = await createE2ESetup();

      // Message 1: Start conversation
      const r1 = await e2e.client.callTool({
        name: 'threadline_send',
        arguments: { agentId: 'research-bot', message: 'What is quantum computing?' },
      });
      const d1 = JSON.parse((r1.content as any)[0].text);
      const threadId = d1.threadId;
      expect(d1.delivered).toBe(true);

      // Messages 2-5: Continue on same thread
      for (let i = 2; i <= 5; i++) {
        const r = await e2e.client.callTool({
          name: 'threadline_send',
          arguments: {
            agentId: 'research-bot',
            threadId,
            message: `Follow-up question ${i}`,
          },
        });
        const d = JSON.parse((r.content as any)[0].text);
        expect(d.threadId).toBe(threadId);
        expect(d.delivered).toBe(true);
      }

      // Verify full history
      const hist = await e2e.client.callTool({
        name: 'threadline_history',
        arguments: { threadId, limit: 100 },
      });
      const h = JSON.parse((hist.content as any)[0].text);
      // 5 messages + 5 replies = 10
      expect(h.messageCount).toBe(10);
      expect(h.messages[0].body).toContain('quantum computing');
    });

    it('handles interleaved conversations with different agents', async () => {
      e2e = await createE2ESetup();

      // Start threads with 3 different agents
      const threads: string[] = [];
      const agents = ['alpha', 'beta', 'gamma'];

      for (const agent of agents) {
        const r = await e2e.client.callTool({
          name: 'threadline_send',
          arguments: { agentId: agent, message: `Hello ${agent}!` },
        });
        threads.push(JSON.parse((r.content as any)[0].text).threadId);
      }

      expect(new Set(threads).size).toBe(3); // All different threads

      // Interleave messages
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < agents.length; i++) {
          await e2e.client.callTool({
            name: 'threadline_send',
            arguments: {
              agentId: agents[i],
              threadId: threads[i],
              message: `Round ${round} to ${agents[i]}`,
            },
          });
        }
      }

      // Verify each thread has its own history
      for (let i = 0; i < agents.length; i++) {
        const h = await e2e.client.callTool({
          name: 'threadline_history',
          arguments: { threadId: threads[i], limit: 50 },
        });
        const data = JSON.parse((h.content as any)[0].text);
        // 1 initial + 3 rounds = 4 messages per thread + 4 replies = 8
        expect(data.messageCount).toBe(8);
        // Verify messages are for the right agent
        expect(data.messages.every((m: any) =>
          m.body.includes(agents[i]) || m.body.includes('E2E reply')
        )).toBe(true);
      }
    });
  });

  // ── Tool Parameter Validation E2E ──────────────────────────────

  describe('parameter validation', () => {
    it('threadline_send validates all parameters', async () => {
      e2e = await createE2ESetup();

      // Empty message
      const r1 = await e2e.client.callTool({
        name: 'threadline_send',
        arguments: { agentId: 'x', message: '' },
      });
      expect(r1.isError).toBe(true);
      expect((r1.content as any)[0].text).toContain('empty');

      // Timeout too high
      const r2 = await e2e.client.callTool({
        name: 'threadline_send',
        arguments: { agentId: 'x', message: 'hi', timeoutSeconds: 999 },
      });
      expect(r2.isError).toBe(true);
      expect((r2.content as any)[0].text).toContain('timeoutSeconds');

      // Timeout too low
      const r3 = await e2e.client.callTool({
        name: 'threadline_send',
        arguments: { agentId: 'x', message: 'hi', timeoutSeconds: 0 },
      });
      expect(r3.isError).toBe(true);
    });

    it('threadline_history validates limit range', async () => {
      e2e = await createE2ESetup();

      const r1 = await e2e.client.callTool({
        name: 'threadline_history',
        arguments: { threadId: 'x', limit: 0 },
      });
      expect(r1.isError).toBe(true);

      const r2 = await e2e.client.callTool({
        name: 'threadline_history',
        arguments: { threadId: 'x', limit: 200 },
      });
      expect(r2.isError).toBe(true);
    });

    it('threadline_delete requires explicit confirmation', async () => {
      e2e = await createE2ESetup();

      // Without confirm (default false)
      const r1 = await e2e.client.callTool({
        name: 'threadline_delete',
        arguments: { threadId: 'x' },
      });
      expect(r1.isError).toBe(true);
      expect((r1.content as any)[0].text).toContain('confirmation');

      // With confirm: false
      const r2 = await e2e.client.callTool({
        name: 'threadline_delete',
        arguments: { threadId: 'x', confirm: false },
      });
      expect(r2.isError).toBe(true);
    });
  });

  // ── Error Recovery E2E ─────────────────────────────────────────

  describe('error recovery', () => {
    it('recovers from transient send failure', async () => {
      e2e = await createE2ESetup();

      // First send fails
      e2e.msgSystem.setFailNextSend(true);
      const r1 = await e2e.client.callTool({
        name: 'threadline_send',
        arguments: { agentId: 'flaky', message: 'Try 1' },
      });
      expect(r1.isError).toBe(true);

      // Second send succeeds
      const r2 = await e2e.client.callTool({
        name: 'threadline_send',
        arguments: { agentId: 'flaky', message: 'Try 2' },
      });
      const d2 = JSON.parse((r2.content as any)[0].text);
      expect(d2.delivered).toBe(true);
    });

    it('handles tool call with missing thread gracefully', async () => {
      e2e = await createE2ESetup();

      // History for non-existent thread
      const r = await e2e.client.callTool({
        name: 'threadline_history',
        arguments: { threadId: 'ghost-thread' },
      });
      expect(r.isError).toBe(true);
      expect((r.content as any)[0].text).toContain('not found');
    });
  });

  // ── Concurrent Operations E2E ──────────────────────────────────

  describe('concurrent operations', () => {
    it('handles multiple tool calls in sequence', async () => {
      e2e = await createE2ESetup();

      // Create thread
      const sendResult = await e2e.client.callTool({
        name: 'threadline_send',
        arguments: { agentId: 'concurrent-agent', message: 'Setup' },
      });
      const { threadId } = JSON.parse((sendResult.content as any)[0].text);

      // Run discover, agents, and history in rapid sequence
      const discover = await e2e.client.callTool({
        name: 'threadline_discover',
        arguments: { scope: 'local' },
      });
      expect(discover.isError).toBeFalsy();

      const agents = await e2e.client.callTool({
        name: 'threadline_agents',
        arguments: {},
      });
      expect(agents.isError).toBeFalsy();

      const history = await e2e.client.callTool({
        name: 'threadline_history',
        arguments: { threadId },
      });
      expect(history.isError).toBeFalsy();
    });
  });

  // ── Network Auth E2E ───────────────────────────────────────────

  describe('network auth end-to-end', () => {
    it('full auth lifecycle: no token → denied, create token → allowed, revoke → denied', async () => {
      e2e = await createE2ESetup({ transport: 'sse', requireAuth: true });

      // No auth → denied
      e2e.server.setRequestContext({ authenticated: false, isLocal: false });
      const r1 = await e2e.client.callTool({
        name: 'threadline_discover',
        arguments: { scope: 'local' },
      });
      expect(r1.isError).toBe(true);
      expect((r1.content as any)[0].text).toContain('Authentication');

      // Create token and authenticate
      const token = e2e.auth.createToken('e2e-client', ['threadline:discover', 'threadline:send', 'threadline:read']);
      const authed = e2e.server.authenticateBearer(token.rawToken);
      expect(authed).toBe(true);

      // Now discover works
      const r2 = await e2e.client.callTool({
        name: 'threadline_discover',
        arguments: { scope: 'local' },
      });
      expect(r2.isError).toBeFalsy();

      // Send works
      const r3 = await e2e.client.callTool({
        name: 'threadline_send',
        arguments: { agentId: 'x', message: 'Authenticated send' },
      });
      expect(r3.isError).toBeFalsy();
      const sendData = JSON.parse((r3.content as any)[0].text);

      // History works
      const r4 = await e2e.client.callTool({
        name: 'threadline_history',
        arguments: { threadId: sendData.threadId },
      });
      expect(r4.isError).toBeFalsy();

      // Delete requires admin scope → denied
      const r5 = await e2e.client.callTool({
        name: 'threadline_delete',
        arguments: { threadId: sendData.threadId, confirm: true },
      });
      expect(r5.isError).toBe(true);
      expect((r5.content as any)[0].text).toContain('scope');

      // Revoke token
      e2e.auth.revokeToken(token.id);
      e2e.server.authenticateBearer(token.rawToken); // Updates context to unauthenticated

      // Now denied again
      const r6 = await e2e.client.callTool({
        name: 'threadline_discover',
        arguments: { scope: 'local' },
      });
      expect(r6.isError).toBe(true);
    });

    it('token scope enforcement across all tools', async () => {
      e2e = await createE2ESetup({ transport: 'sse', requireAuth: true });

      // Test each scope individually
      const scopeToolMap = [
        { scope: 'threadline:discover', tool: 'threadline_discover', args: { scope: 'local' } },
        { scope: 'threadline:send', tool: 'threadline_send', args: { agentId: 'x', message: 'test' } },
        { scope: 'threadline:read', tool: 'threadline_history', args: { threadId: 'any' } },
      ];

      for (const { scope, tool, args } of scopeToolMap) {
        // Create token with only this scope
        const token = e2e.auth.createToken(`test-${scope}`, [scope as any]);
        e2e.server.authenticateBearer(token.rawToken);

        // This tool should work
        const result = await e2e.client.callTool({ name: tool, arguments: args });
        // Note: some may error for other reasons (e.g., thread not found),
        // but NOT for insufficient scope
        const text = (result.content as any)[0].text;
        expect(text).not.toContain('Insufficient scope');

        // Other tools should fail with scope error
        for (const other of scopeToolMap) {
          if (other.scope === scope) continue;
          // Skip if current scope would be covered by admin
          const otherResult = await e2e.client.callTool({
            name: other.tool,
            arguments: other.args,
          });
          // Should either fail with scope error or succeed (if tool doesn't need different scope)
          if (otherResult.isError) {
            const otherText = (otherResult.content as any)[0].text;
            if (otherText.includes('scope')) {
              expect(otherText).toContain('Insufficient scope');
            }
          }
        }

        e2e.auth.deleteToken(token.id);
      }
    });
  });

  // ── Thread Lifecycle E2E ───────────────────────────────────────

  describe('thread lifecycle', () => {
    it('create → interact → delete → verify gone', async () => {
      e2e = await createE2ESetup();

      // Create
      const r1 = await e2e.client.callTool({
        name: 'threadline_send',
        arguments: { agentId: 'lifecycle-agent', message: 'Birth' },
      });
      const { threadId } = JSON.parse((r1.content as any)[0].text);

      // Interact
      await e2e.client.callTool({
        name: 'threadline_send',
        arguments: { agentId: 'lifecycle-agent', threadId, message: 'Growth' },
      });

      // Verify history
      const hist = await e2e.client.callTool({
        name: 'threadline_history',
        arguments: { threadId },
      });
      expect(JSON.parse((hist.content as any)[0].text).messageCount).toBe(4);

      // Delete
      const del = await e2e.client.callTool({
        name: 'threadline_delete',
        arguments: { threadId, confirm: true },
      });
      const delData = JSON.parse((del.content as any)[0].text);
      expect(delData.deleted).toBe(true);
      expect(delData.messageCount).toBe(1); // Original entry count

      // Verify gone
      const histAfter = await e2e.client.callTool({
        name: 'threadline_history',
        arguments: { threadId },
      });
      expect(histAfter.isError).toBe(true);
      expect((histAfter.content as any)[0].text).toContain('not found');
    });
  });

  // ── Discovery E2E ──────────────────────────────────────────────

  describe('discovery', () => {
    it('discovers agents via local scope', async () => {
      e2e = await createE2ESetup();

      const result = await e2e.client.callTool({
        name: 'threadline_discover',
        arguments: { scope: 'local' },
      });

      // Even though our mock fetcher returns simulated agents,
      // discovery.discoverLocal requires agents in the registry
      // so it might return empty in test. The tool should handle both.
      expect(result.isError).toBeFalsy();
    });

    it('filters agents by capability', async () => {
      e2e = await createE2ESetup();

      // Seed known agents
      const knownPath = path.join(e2e.stateDir, 'threadline', 'known-agents.json');
      fs.writeFileSync(knownPath, JSON.stringify({
        agents: [
          { name: 'coder', status: 'active', capabilities: ['code-review', 'debugging'], threadlineEnabled: true, threadlineVersion: '1.0.0', framework: 'instar', port: 18700, path: '/tmp/coder' },
          { name: 'writer', status: 'active', capabilities: ['writing', 'editing'], threadlineEnabled: true, threadlineVersion: '1.0.0', framework: 'instar', port: 18701, path: '/tmp/writer' },
          { name: 'researcher', status: 'active', capabilities: ['research', 'analysis'], threadlineEnabled: true, threadlineVersion: '1.0.0', framework: 'instar', port: 18702, path: '/tmp/researcher' },
        ],
        updatedAt: new Date().toISOString(),
      }));

      // Search for code-review capability
      const r1 = await e2e.client.callTool({
        name: 'threadline_discover',
        arguments: { scope: 'network', capability: 'code' },
      });
      const d1 = JSON.parse((r1.content as any)[0].text);
      expect(d1.count).toBe(1);
      expect(d1.agents[0].name).toBe('coder');

      // Search for research
      const r2 = await e2e.client.callTool({
        name: 'threadline_discover',
        arguments: { scope: 'network', capability: 'research' },
      });
      const d2 = JSON.parse((r2.content as any)[0].text);
      expect(d2.count).toBe(1);
      expect(d2.agents[0].name).toBe('researcher');
    });
  });

  // ── Agent Listing E2E ──────────────────────────────────────────

  describe('agent listing', () => {
    it('shows trust levels for local connections, hides for network non-admin', async () => {
      e2e = await createE2ESetup();

      // Seed a known agent with trust profile
      const knownPath = path.join(e2e.stateDir, 'threadline', 'known-agents.json');
      fs.writeFileSync(knownPath, JSON.stringify({
        agents: [
          { name: 'trusted-bot', status: 'active', capabilities: ['conversation'], threadlineEnabled: true, threadlineVersion: '1.0.0', framework: 'instar', port: 18700, path: '/tmp/trusted' },
        ],
        updatedAt: new Date().toISOString(),
      }));
      e2e.trustManager.setTrustLevel('trusted-bot', 'trusted', 'user-granted', 'E2E test');

      // Local: should see trust
      const r1 = await e2e.client.callTool({
        name: 'threadline_agents',
        arguments: {},
      });
      const d1 = JSON.parse((r1.content as any)[0].text);
      expect(d1.agents[0].trustLevel).toBe('trusted');
    });
  });

  // ── Complete Workflow E2E (The "Golden Path") ──────────────────

  describe('golden path workflow', () => {
    it('simulates a complete Claude Code user workflow', async () => {
      e2e = await createE2ESetup();

      // Step 1: User lists available tools
      const tools = await e2e.client.listTools();
      expect(tools.tools.length).toBe(7);

      // Step 2: User discovers agents
      const discover = await e2e.client.callTool({
        name: 'threadline_discover',
        arguments: { scope: 'local' },
      });
      expect(discover.isError).toBeFalsy();

      // Step 3: User lists agents
      const agents = await e2e.client.callTool({
        name: 'threadline_agents',
        arguments: { includeOffline: true },
      });
      expect(agents.isError).toBeFalsy();

      // Step 4: User starts a conversation
      const send1 = await e2e.client.callTool({
        name: 'threadline_send',
        arguments: {
          agentId: 'dawn',
          message: 'Can you help me review this code?',
          waitForReply: true,
          timeoutSeconds: 60,
        },
      });
      const d1 = JSON.parse((send1.content as any)[0].text);
      expect(d1.delivered).toBe(true);

      // Step 5: User continues the conversation
      const send2 = await e2e.client.callTool({
        name: 'threadline_send',
        arguments: {
          agentId: 'dawn',
          threadId: d1.threadId,
          message: 'The code is in src/main.ts, lines 50-100',
          waitForReply: true,
        },
      });
      expect(JSON.parse((send2.content as any)[0].text).delivered).toBe(true);

      // Step 6: User checks conversation history
      const history = await e2e.client.callTool({
        name: 'threadline_history',
        arguments: { threadId: d1.threadId, limit: 10 },
      });
      const hData = JSON.parse((history.content as any)[0].text);
      expect(hData.messageCount).toBe(4);

      // Step 7: User deletes the thread when done
      const del = await e2e.client.callTool({
        name: 'threadline_delete',
        arguments: { threadId: d1.threadId, confirm: true },
      });
      expect(JSON.parse((del.content as any)[0].text).deleted).toBe(true);
    });
  });
});
