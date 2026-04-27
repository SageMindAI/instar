import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { HandshakeManager } from '../../../src/threadline/HandshakeManager.js';
import { createThreadlineRoutes } from '../../../src/threadline/ThreadlineEndpoints.js';
import { sign } from '../../../src/threadline/ThreadlineCrypto.js';

describe('ThreadlineEndpoints', () => {
  let tmpDir: string;
  let stateDirA: string;
  let stateDirB: string;
  let appA: express.Express;
  let appB: express.Express;
  let managerA: HandshakeManager;
  let managerB: HandshakeManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-ep-test-'));
    stateDirA = path.join(tmpDir, 'agent-a');
    stateDirB = path.join(tmpDir, 'agent-b');

    managerA = new HandshakeManager(stateDirA, 'agent-a');
    managerB = new HandshakeManager(stateDirB, 'agent-b');

    appA = express();
    appA.use(express.json());
    appA.use(createThreadlineRoutes(managerA, null, {
      localAgent: 'agent-a',
      version: '1.0',
    }));

    appB = express();
    appB.use(express.json());
    appB.use(createThreadlineRoutes(managerB, null, {
      localAgent: 'agent-b',
      version: '1.0',
    }));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET /threadline/health', () => {
    it('returns health status', async () => {
      const res = await request(appA).get('/threadline/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.protocol).toBe('threadline');
      expect(res.body.version).toBe('1.0');
      expect(res.body.agent).toBe('agent-a');
      expect(res.body.identityPub).toBeDefined();
      expect(res.body.identityPub).toHaveLength(64); // 32 bytes hex
      expect(res.body.pairedAgents).toBe(0);
    });

    it('sets correct content type', async () => {
      const res = await request(appA).get('/threadline/health');
      expect(res.headers['content-type']).toContain('application/threadline+json');
    });
  });

  describe('POST /threadline/handshake/hello', () => {
    it('processes a hello and returns hello-response', async () => {
      // Agent A initiates locally, then sends hello to agent B's endpoint
      const initResult = managerA.initiateHandshake('agent-b');
      if (!('payload' in initResult)) throw new Error('unexpected');

      const res = await request(appB)
        .post('/threadline/handshake/hello')
        .send(initResult.payload);

      expect(res.status).toBe(200);
      expect(res.body.type).toBe('hello-response');
      expect(res.body.agent).toBe('agent-b');
      expect(res.body.identityPub).toHaveLength(64);
      expect(res.body.ephemeralPub).toHaveLength(64);
      expect(res.body.nonce).toBeDefined();
      expect(res.body.challengeResponse).toBeDefined();
    });

    it('rejects invalid payload — missing fields', async () => {
      const res = await request(appA)
        .post('/threadline/handshake/hello')
        .send({ agent: 'test' }); // missing identityPub, ephemeralPub, nonce

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TL_INVALID_PAYLOAD');
      expect(res.body.error.retryable).toBe(false);
    });

    it('rejects invalid hex encoding', async () => {
      const res = await request(appA)
        .post('/threadline/handshake/hello')
        .send({
          agent: 'test',
          identityPub: 'not-hex',
          ephemeralPub: 'also-not-hex',
          nonce: 'test-nonce',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TL_INVALID_PAYLOAD');
    });
  });

  describe('POST /threadline/handshake/confirm', () => {
    it('rejects confirm with no pending handshake', async () => {
      const res = await request(appA)
        .post('/threadline/handshake/confirm')
        .send({
          agent: 'unknown',
          challengeResponse: 'aa'.repeat(64),
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TL_HANDSHAKE_FAILED');
    });

    it('rejects confirm missing fields', async () => {
      const res = await request(appA)
        .post('/threadline/handshake/confirm')
        .send({ agent: 'test' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TL_INVALID_PAYLOAD');
    });
  });

  describe('Full handshake flow via HTTP', () => {
    it('completes handshake between two agents via endpoints', async () => {
      // Step 1: Agent A initiates locally
      const initResult = managerA.initiateHandshake('agent-b');
      if (!('payload' in initResult)) throw new Error('unexpected');

      // Step 2: Send hello to agent B's endpoint
      const helloRes = await request(appB)
        .post('/threadline/handshake/hello')
        .send(initResult.payload);

      expect(helloRes.status).toBe(200);
      expect(helloRes.body.type).toBe('hello-response');

      // Step 3: Agent A processes B's hello response
      const helloResponsePayload = {
        agent: helloRes.body.agent,
        identityPub: helloRes.body.identityPub,
        ephemeralPub: helloRes.body.ephemeralPub,
        nonce: helloRes.body.nonce,
        challengeResponse: helloRes.body.challengeResponse,
      };
      const confirmResult = managerA.handleHelloResponse(helloResponsePayload);
      if (!('confirmPayload' in confirmResult)) throw new Error('unexpected: ' + JSON.stringify(confirmResult));

      // Step 4: Send confirm to agent B's endpoint
      const confirmRes = await request(appB)
        .post('/threadline/handshake/confirm')
        .send(confirmResult.confirmPayload);

      expect(confirmRes.status).toBe(200);
      expect(confirmRes.body.status).toBe('paired');

      // Verify both have relay tokens
      expect(managerA.getRelayToken('agent-b')).toBeTruthy();
      expect(managerB.getRelayToken('agent-a')).toBeTruthy();
      expect(managerA.getRelayToken('agent-b')).toBe(managerB.getRelayToken('agent-a'));
    });
  });

  describe('Authenticated endpoints', () => {
    // Helper to complete handshake and get tokens
    async function completeHandshake() {
      const init = managerA.initiateHandshake('agent-b');
      if (!('payload' in init)) throw new Error('unexpected');

      const resp = managerB.handleHello(init.payload);
      if (!('payload' in resp)) throw new Error('unexpected');

      const confirm = managerA.handleHelloResponse(resp.payload);
      if (!('confirmPayload' in confirm)) throw new Error('unexpected');

      managerB.handleConfirm(confirm.confirmPayload);

      return managerA.getRelayToken('agent-b')!;
    }

    it('rejects requests without Authorization header', async () => {
      const res = await request(appA)
        .post('/threadline/messages/receive')
        .send({ message: {} });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TL_AUTH_MISSING');
    });

    it('rejects requests with wrong Authorization scheme', async () => {
      const res = await request(appA)
        .post('/threadline/messages/receive')
        .set('Authorization', 'Bearer some-token')
        .send({ message: {} });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TL_AUTH_MISSING');
    });

    it('rejects requests missing required threadline headers', async () => {
      await completeHandshake();

      const res = await request(appB)
        .post('/threadline/messages/receive')
        .set('Authorization', `Threadline-Relay ${managerA.getRelayToken('agent-b')}`)
        .send({ message: {} });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TL_AUTH_MISSING');
    });

    it('rejects requests with invalid relay token', async () => {
      await completeHandshake();

      const res = await request(appB)
        .post('/threadline/messages/receive')
        .set('Authorization', 'Threadline-Relay ' + 'deadbeef'.repeat(8))
        .set('X-Threadline-Agent', 'agent-a')
        .set('X-Threadline-Nonce', crypto.randomBytes(16).toString('hex'))
        .set('X-Threadline-Timestamp', new Date().toISOString())
        .set('X-Threadline-Signature', 'aa'.repeat(64))
        .send({ message: {} });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('TL_AUTH_FAILED');
    });

    it('rejects expired timestamps', async () => {
      await completeHandshake();
      const token = managerA.getRelayToken('agent-b')!;

      const oldTimestamp = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
      const nonce = crypto.randomBytes(16).toString('hex');

      const res = await request(appB)
        .post('/threadline/messages/receive')
        .set('Authorization', `Threadline-Relay ${token}`)
        .set('X-Threadline-Agent', 'agent-a')
        .set('X-Threadline-Nonce', nonce)
        .set('X-Threadline-Timestamp', oldTimestamp)
        .set('X-Threadline-Signature', 'aa'.repeat(64))
        .send({ message: {} });

      // Token is valid, but timestamp is outside the 30s window
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TL_TIMESTAMP_EXPIRED');
    });
  });

  describe('GET /threadline/messages/thread/:id', () => {
    it('requires authentication', async () => {
      const res = await request(appA).get('/threadline/messages/thread/test-thread');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TL_AUTH_MISSING');
    });
  });

  describe('GET /threadline/blobs/:id', () => {
    it('requires authentication', async () => {
      const res = await request(appA).get('/threadline/blobs/test-blob');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TL_AUTH_MISSING');
    });
  });

  describe('Error response format', () => {
    it('follows the TL_ error code format', async () => {
      const res = await request(appA)
        .post('/threadline/handshake/hello')
        .send({});

      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toHaveProperty('code');
      expect(res.body.error).toHaveProperty('message');
      expect(res.body.error).toHaveProperty('retryable');
      expect(res.body.error.code).toMatch(/^TL_/);
    });
  });
});
