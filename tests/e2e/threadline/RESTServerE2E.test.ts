/**
 * REST Server E2E Tests
 *
 * Full integration: ThreadlineRESTServer with real HTTP requests.
 * Tests auth, status, agents, discover, send, thread history, and error handling.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { ThreadlineRESTServer } from '../../../src/threadline/adapters/RESTServer.js';
import type { ThreadlineClient, KnownAgent, ReceivedMessage } from '../../../src/threadline/client/ThreadlineClient.js';
import { EventEmitter } from 'node:events';

// ── Mock ThreadlineClient ──────────────────────────────────────────

function createMockClient(): ThreadlineClient & EventEmitter {
  const emitter = new EventEmitter();

  const knownAgents: KnownAgent[] = [
    {
      agentId: 'a1b2c3d4e5f60000a1b2c3d4e5f60000',
      name: 'test-agent-alpha',
      publicKey: Buffer.from('pubkey-alpha'),
      x25519PublicKey: Buffer.from('x25519-alpha'),
      framework: 'instar',
      capabilities: ['conversation', 'code-review'],
    },
    {
      agentId: 'b2c3d4e5f6000000b2c3d4e5f6000000',
      name: 'test-agent-beta',
      publicKey: Buffer.from('pubkey-beta'),
      x25519PublicKey: Buffer.from('x25519-beta'),
      framework: 'crewai',
      capabilities: ['conversation'],
    },
  ];

  const client = Object.assign(emitter, {
    discover: async (filter?: { capability?: string; framework?: string; name?: string }) => {
      if (!filter) return knownAgents;
      return knownAgents.filter(a => {
        if (filter.capability && !a.capabilities?.includes(filter.capability)) return false;
        if (filter.framework && a.framework !== filter.framework) return false;
        if (filter.name && !a.name?.includes(filter.name)) return false;
        return true;
      });
    },
    send: (recipientId: string, message: string, threadId?: string) => {
      if (recipientId === 'unknown') throw new Error('Unknown agent: unknown');
      return `msg-${Date.now()}`;
    },
    getKnownAgents: () => knownAgents,
    connectionState: 'connected' as string,
    fingerprint: 'abcdef0123456789abcdef0123456789' as string | null,
    connect: async () => 'session-1',
    disconnect: () => {},
    registerAgent: () => {},
    publicKey: null as Buffer | null,
  }) as unknown as ThreadlineClient & EventEmitter;

  return client;
}

// ── HTTP helper ────────────────────────────────────────────────────

function request(
  port: number,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(bodyStr ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: { raw: text } as Record<string, unknown> });
          }
        });
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Tests ──────────────────────────────────────────────────────────

describe('REST Server E2E', () => {
  let client: ThreadlineClient & EventEmitter;
  let server: ThreadlineRESTServer;
  let port: number;
  let token: string;
  let tokenPath: string;

  beforeAll(async () => {
    // Use a unique temp dir for each test run to avoid token conflicts
    const tmpDir = path.join(os.tmpdir(), `threadline-rest-test-${crypto.randomBytes(4).toString('hex')}`);
    tokenPath = path.join(tmpDir, 'api-token');

    client = createMockClient();
    server = new ThreadlineRESTServer(client as unknown as ThreadlineClient, {
      port: 0, // Let OS pick a free port
      tokenPath,
    });

    const result = await server.start();
    port = server.address!.port;
    token = result.token;
  });

  afterAll(async () => {
    await server.stop();
    // Cleanup token file
    try {
      // safe-git-allow: incremental-migration
      fs.unlinkSync(tokenPath);
      // safe-git-allow: incremental-migration
      fs.rmdirSync(path.dirname(tokenPath));
    } catch { /* ignore */ }
  });

  // ── Auth ─────────────────────────────────────────────────────────

  it('rejects requests without auth token', async () => {
    const res = await request(port, 'GET', '/status', 'wrong-token');
    expect(res.status).toBe(401);
    expect(res.data.error).toContain('Unauthorized');
  });

  it('rejects requests with empty auth header', async () => {
    const res = await request(port, 'GET', '/status', '');
    expect(res.status).toBe(401);
  });

  // ── GET /status ──────────────────────────────────────────────────

  it('returns status with connection info', async () => {
    const res = await request(port, 'GET', '/status', token);
    expect(res.status).toBe(200);
    expect(res.data.connectionState).toBe('connected');
    expect(res.data.fingerprint).toBe('abcdef0123456789abcdef0123456789');
    expect(res.data.knownAgents).toBe(2);
    expect(res.data.threads).toBe(0);
  });

  // ── GET /agents ──────────────────────────────────────────────────

  it('lists known agents', async () => {
    const res = await request(port, 'GET', '/agents', token);
    expect(res.status).toBe(200);
    expect(res.data.count).toBe(2);
    const agents = res.data.agents as Array<Record<string, unknown>>;
    expect(agents[0].name).toBe('test-agent-alpha');
    expect(agents[1].name).toBe('test-agent-beta');
    // Should not expose raw public keys
    expect(agents[0].publicKey).toBeUndefined();
    expect(agents[0].x25519PublicKey).toBeUndefined();
  });

  // ── POST /discover ──────────────────────────────────────────────

  it('discovers agents with filter', async () => {
    const res = await request(port, 'POST', '/discover', token, { framework: 'instar' });
    expect(res.status).toBe(200);
    expect(res.data.count).toBe(1);
    const agents = res.data.agents as Array<Record<string, unknown>>;
    expect(agents[0].name).toBe('test-agent-alpha');
  });

  it('discovers all agents without filter', async () => {
    const res = await request(port, 'POST', '/discover', token);
    expect(res.status).toBe(200);
    expect(res.data.count).toBe(2);
  });

  it('returns 400 for invalid JSON in discover', async () => {
    // Send raw invalid JSON
    const res = await new Promise<{ status: number; data: Record<string, unknown> }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/discover',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        },
        (httpRes) => {
          const chunks: Buffer[] = [];
          httpRes.on('data', (c: Buffer) => chunks.push(c));
          httpRes.on('end', () => {
            resolve({
              status: httpRes.statusCode ?? 0,
              data: JSON.parse(Buffer.concat(chunks).toString()),
            });
          });
        },
      );
      req.on('error', reject);
      req.write('not valid json');
      req.end();
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('Invalid JSON');
  });

  // ── POST /send ──────────────────────────────────────────────────

  it('sends a message', async () => {
    const res = await request(port, 'POST', '/send', token, {
      recipientId: 'a1b2c3d4e5f60000a1b2c3d4e5f60000',
      message: 'hello from REST',
    });
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('sent');
    expect(res.data.messageId).toBeDefined();
  });

  it('sends with threadId', async () => {
    const res = await request(port, 'POST', '/send', token, {
      recipientId: 'a1b2c3d4e5f60000a1b2c3d4e5f60000',
      message: 'continuing thread',
      threadId: 'thread-42',
    });
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('sent');
  });

  it('rejects send without recipientId', async () => {
    const res = await request(port, 'POST', '/send', token, {
      message: 'hello',
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('recipientId');
  });

  it('rejects send without message', async () => {
    const res = await request(port, 'POST', '/send', token, {
      recipientId: 'abc123',
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('message');
  });

  it('rejects send without body', async () => {
    const res = await request(port, 'POST', '/send', token);
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('body required');
  });

  it('returns error when send throws', async () => {
    const res = await request(port, 'POST', '/send', token, {
      recipientId: 'unknown',
      message: 'hello',
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('Unknown agent');
  });

  // ── Threads ─────────────────────────────────────────────────────

  it('lists threads (initially empty)', async () => {
    const res = await request(port, 'GET', '/threads', token);
    expect(res.status).toBe(200);
    expect(res.data.count).toBe(0);
    expect(res.data.threads).toEqual([]);
  });

  it('tracks thread history from incoming messages', async () => {
    // Simulate incoming messages via the client's 'message' event
    const msg1: ReceivedMessage = {
      from: 'a1b2c3d4e5f60000a1b2c3d4e5f60000',
      fromName: 'test-agent-alpha',
      threadId: 'thread-100',
      messageId: 'msg-001',
      content: { content: 'first message' },
      timestamp: new Date().toISOString(),
      envelope: {} as any,
    };
    const msg2: ReceivedMessage = {
      from: 'a1b2c3d4e5f60000a1b2c3d4e5f60000',
      fromName: 'test-agent-alpha',
      threadId: 'thread-100',
      messageId: 'msg-002',
      content: { content: 'second message' },
      timestamp: new Date().toISOString(),
      envelope: {} as any,
    };

    client.emit('message', msg1);
    client.emit('message', msg2);

    // List threads
    const listRes = await request(port, 'GET', '/threads', token);
    expect(listRes.status).toBe(200);
    expect(listRes.data.count).toBe(1);
    const threads = listRes.data.threads as Array<Record<string, unknown>>;
    expect(threads[0].threadId).toBe('thread-100');
    expect(threads[0].messageCount).toBe(2);

    // Get thread detail
    const threadRes = await request(port, 'GET', '/threads/thread-100', token);
    expect(threadRes.status).toBe(200);
    expect(threadRes.data.threadId).toBe('thread-100');
    expect(threadRes.data.count).toBe(2);
    const messages = threadRes.data.messages as Array<Record<string, unknown>>;
    expect(messages[0].messageId).toBe('msg-001');
    expect(messages[1].messageId).toBe('msg-002');
  });

  it('returns 404 for unknown thread', async () => {
    const res = await request(port, 'GET', '/threads/nonexistent', token);
    expect(res.status).toBe(404);
    expect(res.data.error).toContain('not found');
  });

  it('deletes a thread', async () => {
    // Ensure thread-100 exists from previous test
    const delRes = await request(port, 'DELETE', '/threads/thread-100', token);
    expect(delRes.status).toBe(200);
    expect(delRes.data.deleted).toBe(true);
    expect(delRes.data.threadId).toBe('thread-100');

    // Verify it's gone
    const getRes = await request(port, 'GET', '/threads/thread-100', token);
    expect(getRes.status).toBe(404);
  });

  it('handles delete of non-existent thread gracefully', async () => {
    const res = await request(port, 'DELETE', '/threads/nonexistent', token);
    expect(res.status).toBe(200);
    expect(res.data.deleted).toBe(false);
  });

  // ── CORS & Routing ──────────────────────────────────────────────

  it('responds to OPTIONS with 204', async () => {
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/status',
          method: 'OPTIONS',
        },
        (httpRes) => {
          httpRes.resume();
          httpRes.on('end', () => resolve({ status: httpRes.statusCode ?? 0 }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(204);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await request(port, 'GET', '/nonexistent', token);
    expect(res.status).toBe(404);
    expect(res.data.error).toBe('Not found');
  });

  // ── Server lifecycle ────────────────────────────────────────────

  it('reports isRunning correctly', () => {
    expect(server.isRunning).toBe(true);
  });

  it('persists token to file', () => {
    const saved = fs.readFileSync(tokenPath, 'utf-8').trim();
    expect(saved).toBe(token);
    expect(token.length).toBeGreaterThanOrEqual(32);
  });

  it('reuses existing token on restart', async () => {
    await server.stop();
    expect(server.isRunning).toBe(false);

    // Restart with same config
    const client2 = createMockClient();
    const server2 = new ThreadlineRESTServer(client2 as unknown as ThreadlineClient, {
      port: 0,
      tokenPath,
    });
    const result = await server2.start();

    // Should reuse the same token from file
    expect(result.token).toBe(token);

    await server2.stop();

    // Restart original server for remaining tests
    // (We can't, it was stopped — but this is the last test)
  });

  it('prevents double start', async () => {
    const client3 = createMockClient();
    const server3 = new ThreadlineRESTServer(client3 as unknown as ThreadlineClient, {
      port: 0,
      tokenPath: path.join(os.tmpdir(), `threadline-rest-test-dbl-${crypto.randomBytes(4).toString('hex')}`, 'token'),
    });
    await server3.start();
    await expect(server3.start()).rejects.toThrow('already running');
    await server3.stop();
  });
});
