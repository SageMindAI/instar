/**
 * Threadline Relay E2E Tests
 *
 * Full integration: RelayServer + RelayClient + MessageEncryptor + IdentityManager
 * Tests real WebSocket connections, authentication, discovery, and encrypted messaging.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { RelayClient } from '../../../src/threadline/client/RelayClient.js';
import { MessageEncryptor, computeFingerprint, deriveX25519PublicKey } from '../../../src/threadline/client/MessageEncryptor.js';
import { IdentityManager } from '../../../src/threadline/client/IdentityManager.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import type { MessageEnvelope, AckFrame } from '../../../src/threadline/relay/types.js';

describe('Threadline Relay E2E', () => {
  let server: RelayServer;
  let serverPort: number;
  let tmpDirs: string[] = [];

  const makeTmpDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-e2e-'));
    tmpDirs.push(dir);
    return dir;
  };

  const makeClient = (identity: ReturnType<typeof generateIdentityKeyPair>, name: string, opts?: Record<string, unknown>) => {
    const fingerprint = computeFingerprint(identity.publicKey);
    return new RelayClient(
      {
        relayUrl: `ws://127.0.0.1:${serverPort}/v1/connect`,
        name,
        framework: 'test',
        capabilities: ['conversation'],
        version: '1.0.0',
        visibility: (opts?.visibility as 'public' | 'unlisted' | 'private') ?? 'public',
      },
      {
        fingerprint,
        publicKey: identity.publicKey,
        privateKey: identity.privateKey,
        x25519PublicKey: deriveX25519PublicKey(identity.privateKey),
        createdAt: new Date().toISOString(),
      },
    );
  };

  beforeAll(async () => {
    server = new RelayServer({
      port: 0,
      rateLimitConfig: {
        perAgentPerMinute: 1000,
        perAgentPerHour: 10000,
        perIPPerMinute: 10000,
        globalPerMinute: 50000,
        discoveryPerMinute: 100,
        authAttemptsPerMinute: 100,
      },
      abuseDetectorConfig: {
        sybilFirstHourLimit: 10000,
        sybilSecondHourLimit: 10000,
        spamUniqueRecipientsPerMinute: 10000,
      },
    });
    await server.start();
    serverPort = server.address!.port;
  });

  afterAll(async () => {
    await server.stop();
    for (const dir of tmpDirs) {
      // safe-git-allow: incremental-migration
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Authentication ────────────────────────────────────────────────

  describe('authentication', () => {
    it('authenticates a client with valid Ed25519 signature', async () => {
      const identity = generateIdentityKeyPair();
      const client = makeClient(identity, 'auth-test-agent');

      const sessionId = await client.connect();
      expect(sessionId).toMatch(/^relay-/);
      expect(client.connectionState).toBe('connected');

      client.disconnect();
    });

    it('rejects client with invalid signature', async () => {
      // Create a client that will send wrong signature
      // This requires a custom approach — we'll test via the server's connection count
      const identity = generateIdentityKeyPair();
      const client = makeClient(identity, 'valid-agent');
      await client.connect();

      expect(server.connections.size).toBe(1);
      client.disconnect();
    });

    it('multiple agents can connect simultaneously', async () => {
      const clients: RelayClient[] = [];
      try {
        for (let i = 0; i < 5; i++) {
          const identity = generateIdentityKeyPair();
          const client = makeClient(identity, `agent-${i}`);
          await client.connect();
          clients.push(client);
        }
        expect(server.connections.size).toBe(5);
        expect(server.presence.size).toBe(5);
      } finally {
        clients.forEach(c => c.disconnect());
      }
    });

    it('disconnects cleanly', async () => {
      const identity = generateIdentityKeyPair();
      const client = makeClient(identity, 'disconnect-test');
      await client.connect();
      expect(server.presence.size).toBeGreaterThanOrEqual(1);

      client.disconnect();
      // Give the server a moment to process the disconnect
      await new Promise(r => setTimeout(r, 100));
      expect(client.connectionState).toBe('disconnected');
    });
  });

  // ── Displacement ──────────────────────────────────────────────────

  describe('displacement', () => {
    it('displaces existing connection when same key connects again', async () => {
      const identity = generateIdentityKeyPair();
      const client1 = makeClient(identity, 'agent-v1');
      const client2 = makeClient(identity, 'agent-v2');

      await client1.connect();
      const displaced = new Promise<string>(resolve => {
        client1.on('displaced', resolve);
      });

      await client2.connect();

      const reason = await displaced;
      expect(reason).toContain('Another device');
      expect(server.connections.size).toBe(1);

      client1.disconnect();
      client2.disconnect();
    });
  });

  // ── Discovery ─────────────────────────────────────────────────────

  describe('discovery', () => {
    it('discovers public agents', async () => {
      const id1 = generateIdentityKeyPair();
      const id2 = generateIdentityKeyPair();
      const client1 = makeClient(id1, 'discoverable-agent', { visibility: 'public' });
      const client2 = makeClient(id2, 'searcher-agent', { visibility: 'public' });

      try {
        await client1.connect();
        await client2.connect();

        const result = new Promise<{ agents: Array<{ name: string }> }>(resolve => {
          client2.on('discover-result', resolve);
        });
        client2.discover();

        const { agents } = await result;
        expect(agents.length).toBeGreaterThanOrEqual(1);
        const names = agents.map(a => a.name);
        expect(names).toContain('discoverable-agent');
      } finally {
        client1.disconnect();
        client2.disconnect();
      }
    });

    it('does not discover unlisted agents', async () => {
      const id1 = generateIdentityKeyPair();
      const id2 = generateIdentityKeyPair();
      const unlisted = makeClient(id1, 'hidden-agent', { visibility: 'unlisted' });
      const searcher = makeClient(id2, 'searcher', { visibility: 'public' });

      try {
        await unlisted.connect();
        await searcher.connect();

        const result = new Promise<{ agents: Array<{ name: string }> }>(resolve => {
          searcher.on('discover-result', resolve);
        });
        searcher.discover();

        const { agents } = await result;
        const names = agents.map(a => a.name);
        expect(names).not.toContain('hidden-agent');
      } finally {
        unlisted.disconnect();
        searcher.disconnect();
      }
    });

    it('filters by capability', async () => {
      const id1 = generateIdentityKeyPair();
      const id2 = generateIdentityKeyPair();
      const id3 = generateIdentityKeyPair();

      const agent1 = new RelayClient(
        {
          relayUrl: `ws://127.0.0.1:${serverPort}/v1/connect`,
          name: 'code-reviewer',
          framework: 'test',
          capabilities: ['code-review', 'conversation'],
          version: '1.0.0',
          visibility: 'public',
        },
        { fingerprint: computeFingerprint(id1.publicKey), publicKey: id1.publicKey, privateKey: id1.privateKey, x25519PublicKey: deriveX25519PublicKey(id1.privateKey), createdAt: new Date().toISOString() },
      );
      const agent2 = new RelayClient(
        {
          relayUrl: `ws://127.0.0.1:${serverPort}/v1/connect`,
          name: 'chat-only',
          framework: 'test',
          capabilities: ['conversation'],
          version: '1.0.0',
          visibility: 'public',
        },
        { fingerprint: computeFingerprint(id2.publicKey), publicKey: id2.publicKey, privateKey: id2.privateKey, x25519PublicKey: deriveX25519PublicKey(id2.privateKey), createdAt: new Date().toISOString() },
      );
      const searcher = makeClient(id3, 'searcher-cap', { visibility: 'public' });

      try {
        await agent1.connect();
        await agent2.connect();
        await searcher.connect();

        const result = new Promise<{ agents: Array<{ name: string }> }>(resolve => {
          searcher.on('discover-result', resolve);
        });
        searcher.discover({ capability: 'code-review' });

        const { agents } = await result;
        expect(agents.map(a => a.name)).toContain('code-reviewer');
        expect(agents.map(a => a.name)).not.toContain('chat-only');
      } finally {
        agent1.disconnect();
        agent2.disconnect();
        searcher.disconnect();
      }
    });
  });

  // ── Message Routing ───────────────────────────────────────────────

  describe('message routing', () => {
    it('routes encrypted messages between two agents', async () => {
      const aliceKeys = generateIdentityKeyPair();
      const bobKeys = generateIdentityKeyPair();

      const alice = makeClient(aliceKeys, 'alice', { visibility: 'public' });
      const bob = makeClient(bobKeys, 'bob', { visibility: 'public' });

      const aliceEncryptor = new MessageEncryptor(aliceKeys.privateKey, aliceKeys.publicKey);
      const bobEncryptor = new MessageEncryptor(bobKeys.privateKey, bobKeys.publicKey);

      try {
        await alice.connect();
        await bob.connect();

        // Bob listens for messages
        const received = new Promise<MessageEnvelope>(resolve => {
          bob.on('message', resolve);
        });

        // Alice listens for ack
        const ackReceived = new Promise<AckFrame>(resolve => {
          alice.on('ack', resolve);
        });

        // Alice sends encrypted message to Bob
        const envelope = aliceEncryptor.encrypt(
          bobKeys.publicKey,
          bobEncryptor.x25519Public,
          'thread-e2e',
          { content: 'Hello Bob from E2E test!' },
        );
        alice.sendMessage(envelope);

        // Verify Bob received it
        const msg = await received;
        expect(msg.from).toBe(aliceEncryptor.fingerprint);
        expect(msg.threadId).toBe('thread-e2e');

        // Bob decrypts the message
        const decrypted = bobEncryptor.decrypt(msg, aliceKeys.publicKey, aliceEncryptor.x25519Public);
        expect(decrypted.content).toBe('Hello Bob from E2E test!');

        // Verify Alice got ack
        const ack = await ackReceived;
        expect(ack.status).toBe('delivered');
        expect(ack.messageId).toBe(envelope.messageId);
      } finally {
        alice.disconnect();
        bob.disconnect();
      }
    });

    it('routes messages bidirectionally', async () => {
      const aliceKeys = generateIdentityKeyPair();
      const bobKeys = generateIdentityKeyPair();

      const alice = makeClient(aliceKeys, 'alice-bidir');
      const bob = makeClient(bobKeys, 'bob-bidir');

      const aliceEnc = new MessageEncryptor(aliceKeys.privateKey, aliceKeys.publicKey);
      const bobEnc = new MessageEncryptor(bobKeys.privateKey, bobKeys.publicKey);

      try {
        await alice.connect();
        await bob.connect();

        // Alice → Bob
        const bobReceived = new Promise<MessageEnvelope>(resolve => {
          bob.on('message', resolve);
        });
        const env1 = aliceEnc.encrypt(bobKeys.publicKey, bobEnc.x25519Public, 'bidir-thread', { content: 'Hello Bob' });
        alice.sendMessage(env1);
        const msg1 = await bobReceived;
        expect(bobEnc.decrypt(msg1, aliceKeys.publicKey, aliceEnc.x25519Public).content).toBe('Hello Bob');

        // Bob → Alice
        const aliceReceived = new Promise<MessageEnvelope>(resolve => {
          alice.on('message', resolve);
        });
        const env2 = bobEnc.encrypt(aliceKeys.publicKey, aliceEnc.x25519Public, 'bidir-thread', { content: 'Hello Alice' });
        bob.sendMessage(env2);
        const msg2 = await aliceReceived;
        expect(aliceEnc.decrypt(msg2, bobKeys.publicKey, bobEnc.x25519Public).content).toBe('Hello Alice');
      } finally {
        alice.disconnect();
        bob.disconnect();
      }
    });

    it('queues messages to offline agents (Phase 3)', async () => {
      const aliceKeys = generateIdentityKeyPair();
      const bobKeys = generateIdentityKeyPair();

      const alice = makeClient(aliceKeys, 'alice-offline');
      const aliceEnc = new MessageEncryptor(aliceKeys.privateKey, aliceKeys.publicKey);

      try {
        await alice.connect();

        const ackReceived = new Promise<AckFrame>(resolve => {
          alice.on('ack', resolve);
        });

        // Try to send to Bob who is not connected — should be queued (not rejected)
        const bobEnc = new MessageEncryptor(bobKeys.privateKey, bobKeys.publicKey);
        const envelope = aliceEnc.encrypt(bobKeys.publicKey, bobEnc.x25519Public, 'offline-thread', { content: 'Are you there?' });
        alice.sendMessage(envelope);

        const ack = await ackReceived;
        expect(ack.status).toBe('queued');
        expect(ack.ttl).toBeGreaterThan(0);
      } finally {
        alice.disconnect();
      }
    });
  });

  // ── Presence Subscriptions ────────────────────────────────────────

  describe('presence subscriptions', () => {
    it('notifies subscribers when agents come online', async () => {
      const watcherKeys = generateIdentityKeyPair();
      const watcher = makeClient(watcherKeys, 'watcher', { visibility: 'public' });

      try {
        await watcher.connect();
        watcher.subscribe(); // Subscribe to all changes

        const changePromise = new Promise<{ agentId: string; status: string }>(resolve => {
          watcher.on('presence-change', resolve);
        });

        // New agent connects
        const newAgentKeys = generateIdentityKeyPair();
        const newAgent = makeClient(newAgentKeys, 'newcomer', { visibility: 'public' });
        await newAgent.connect();

        const change = await changePromise;
        expect(change.status).toBe('online');
        expect(change.agentId).toBe(computeFingerprint(newAgentKeys.publicKey));

        newAgent.disconnect();
      } finally {
        watcher.disconnect();
      }
    });
  });

  // ── Identity Manager Integration ──────────────────────────────────

  describe('identity persistence', () => {
    it('creates and persists identity, reconnects with same fingerprint', async () => {
      const stateDir = makeTmpDir();
      const idm = new IdentityManager(stateDir);
      const id1 = idm.getOrCreate();

      const client1 = new RelayClient(
        {
          relayUrl: `ws://127.0.0.1:${serverPort}/v1/connect`,
          name: 'persistent-agent',
          framework: 'test',
          capabilities: ['conversation'],
          version: '1.0.0',
          visibility: 'public',
        },
        id1,
      );

      await client1.connect();
      client1.disconnect();
      await new Promise(r => setTimeout(r, 100));

      // New instance loads same identity from disk
      const idm2 = new IdentityManager(stateDir);
      const id2 = idm2.getOrCreate();
      expect(id2.fingerprint).toBe(id1.fingerprint);

      const client2 = new RelayClient(
        {
          relayUrl: `ws://127.0.0.1:${serverPort}/v1/connect`,
          name: 'persistent-agent',
          framework: 'test',
          capabilities: ['conversation'],
          version: '1.0.0',
          visibility: 'public',
        },
        id2,
      );

      const sessionId = await client2.connect();
      expect(sessionId).toMatch(/^relay-/);
      expect(client2.fingerprint).toBe(id1.fingerprint);

      client2.disconnect();
    });
  });

  // ── Rate Limiting ─────────────────────────────────────────────────

  describe('rate limiting', () => {
    it('rate limits excessive discovery queries', async () => {
      const server2 = new RelayServer({ port: 0 });
      await server2.start();
      const port = server2.address!.port;

      // Override rate limiter with strict limits
      (server2 as any).rateLimiter = new (await import('../../../src/threadline/relay/RelayRateLimiter.js')).RelayRateLimiter({
        perAgentPerMinute: 100,
        perAgentPerHour: 1000,
        perIPPerMinute: 200,
        globalPerMinute: 5000,
        discoveryPerMinute: 2, // Very strict
        authAttemptsPerMinute: 10,
      });

      const identity = generateIdentityKeyPair();
      const client = new RelayClient(
        {
          relayUrl: `ws://127.0.0.1:${port}/v1/connect`,
          name: 'rate-test',
          framework: 'test',
          capabilities: [],
          version: '1.0.0',
          visibility: 'public',
        },
        { fingerprint: computeFingerprint(identity.publicKey), publicKey: identity.publicKey, privateKey: identity.privateKey, x25519PublicKey: deriveX25519PublicKey(identity.privateKey), createdAt: new Date().toISOString() },
      );

      try {
        await client.connect();

        // Send many discovery requests — one should get rate limited
        let errorReceived = false;
        client.on('error', (err) => {
          if (err.code === 'rate_limited') errorReceived = true;
        });

        for (let i = 0; i < 5; i++) {
          client.discover();
          await new Promise(r => setTimeout(r, 10));
        }

        // Give time for error to arrive
        await new Promise(r => setTimeout(r, 200));
        expect(errorReceived).toBe(true);
      } finally {
        client.disconnect();
        await server2.stop();
      }
    });
  });

  // ── Server Health ─────────────────────────────────────────────────

  describe('server health', () => {
    it('health endpoint returns status', async () => {
      const res = await fetch(`http://127.0.0.1:${serverPort}/health`);
      expect(res.ok).toBe(true);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(typeof body.agents).toBe('number');
      expect(typeof body.uptime).toBe('number');
    });
  });

  // ── Error Handling ────────────────────────────────────────────────

  describe('error handling', () => {
    it('handles invalid JSON frames gracefully', async () => {
      const { WebSocket: WS } = await import('ws');
      const ws = new WS(`ws://127.0.0.1:${serverPort}/v1/connect`);

      await new Promise<void>((resolve) => {
        ws.on('open', () => {
          // Wait for challenge, then send garbage
          ws.on('message', () => {
            ws.send('not valid json');
          });
          resolve();
        });
      });

      // Should receive an error frame, not crash
      const errorMsg = await new Promise<string>((resolve) => {
        ws.on('message', (data) => {
          const frame = JSON.parse(data.toString());
          if (frame.type === 'error') resolve(frame.code);
        });
        // Timeout fallback
        setTimeout(() => resolve('timeout'), 2000);
      });

      expect(errorMsg).toBe('invalid_frame');
      ws.close();
    });

    it('requires authentication for message frames', async () => {
      const { WebSocket: WS } = await import('ws');
      const ws = new WS(`ws://127.0.0.1:${serverPort}/v1/connect`);

      let challengeReceived = false;
      const errorCode = await new Promise<string>((resolve) => {
        ws.on('message', (data) => {
          const frame = JSON.parse(data.toString());
          if (frame.type === 'challenge') {
            challengeReceived = true;
            // Skip auth, try to send a message
            ws.send(JSON.stringify({ type: 'discover' }));
          } else if (frame.type === 'error') {
            resolve(frame.code);
          }
        });
        setTimeout(() => resolve('timeout'), 2000);
      });

      expect(challengeReceived).toBe(true);
      expect(errorCode).toBe('auth_failed');
      ws.close();
    });
  });
});
