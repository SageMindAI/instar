/**
 * Integration tests for multi-machine API routes.
 *
 * Tests the full stack: HTTP request → machineAuth → route handler → response.
 * Simulates two machines communicating via their API endpoints.
 *
 * Tests:
 * - Heartbeat exchange between machines
 * - Heartbeat split-brain detection
 * - Handoff challenge-response flow
 * - Unauthenticated requests rejected
 * - State sync acknowledgment
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import request from 'supertest';
import { MachineIdentityManager, generateSigningKeyPair, generateMachineId, pemToBase64, sign } from '../../src/core/MachineIdentity.js';
import { HeartbeatManager } from '../../src/core/HeartbeatManager.js';
import { NonceStore } from '../../src/core/NonceStore.js';
import { SecurityLog } from '../../src/core/SecurityLog.js';
import { signRequest } from '../../src/server/machineAuth.js';
import { createMachineRoutes } from '../../src/server/machineRoutes.js';
import type { MachineAuthDeps } from '../../src/server/machineAuth.js';
import type { MachineIdentity } from '../../src/core/types.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-routes-test-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Create a full test environment simulating Machine A (the server) receiving
 * requests from Machine B (the client).
 */
function createTestEnv(tmpDir: string) {
  const identityManager = new MachineIdentityManager(tmpDir);

  // Machine A (local — the server)
  const aSigning = generateSigningKeyPair();
  const aId = generateMachineId();
  const aIdentity: MachineIdentity = {
    machineId: aId,
    signingPublicKey: pemToBase64(aSigning.publicKey),
    encryptionPublicKey: 'unused',
    name: 'machine-a',
    platform: 'test',
    createdAt: new Date().toISOString(),
    capabilities: ['sessions'],
  };

  // Machine B (remote — the client)
  const bSigning = generateSigningKeyPair();
  const bId = generateMachineId();
  const bIdentity: MachineIdentity = {
    machineId: bId,
    signingPublicKey: pemToBase64(bSigning.publicKey),
    encryptionPublicKey: 'unused',
    name: 'machine-b',
    platform: 'test',
    createdAt: new Date().toISOString(),
    capabilities: ['sessions'],
  };

  // Set up local identity
  fs.mkdirSync(path.join(tmpDir, 'machine'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'machine', 'identity.json'), JSON.stringify(aIdentity));

  // Register both machines
  identityManager.registerMachine(aIdentity, 'awake');
  identityManager.registerMachine(bIdentity, 'standby');
  identityManager.storeRemoteIdentity(bIdentity);

  const nonceStore = new NonceStore(path.join(tmpDir, 'nonces'));
  const securityLog = new SecurityLog(tmpDir);
  securityLog.initialize();

  const heartbeatManager = new HeartbeatManager(tmpDir, aId);

  const authDeps: MachineAuthDeps = {
    identityManager,
    nonceStore,
    securityLog,
    localMachineId: aId,
  };

  let demoteCalled = false;
  let promoteCalled = false;

  const routes = createMachineRoutes({
    identityManager,
    heartbeatManager,
    securityLog,
    authDeps,
    localMachineId: aId,
    localSigningKeyPem: aSigning.privateKey,
    onDemote: () => { demoteCalled = true; },
    onPromote: () => { promoteCalled = true; },
    onHandoffRequest: async () => ({ ready: true, state: { jobs: [], sessions: [] } }),
  });

  const app = express();
  app.use(express.json());
  app.use(routes);

  return {
    app,
    aId, aSigning, aIdentity,
    bId, bSigning, bIdentity,
    identityManager,
    heartbeatManager,
    nonceStore,
    securityLog,
    getDemoteCalled: () => demoteCalled,
    getPromoteCalled: () => promoteCalled,
  };
}

describe('Machine Routes Integration', () => {
  let tmpDir: string;
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    tmpDir = createTempDir();
    env = createTestEnv(tmpDir);
  });

  afterEach(() => {
    env.nonceStore.destroy();
    cleanup(tmpDir);
  });

  // ── Heartbeat ──────────────────────────────────────────────────

  describe('POST /api/heartbeat', () => {
    it('accepts valid heartbeat from standby machine', async () => {
      const heartbeat = {
        holder: env.bId,
        role: 'awake',
        timestamp: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      };
      const headers = signRequest(env.bId, env.bSigning.privateKey, heartbeat, 0);

      const res = await request(env.app)
        .post('/api/heartbeat')
        .set(headers)
        .set('Connection', 'close')
        .send(heartbeat);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('acknowledged');
    });

    it('triggers demote when incoming heartbeat is newer', async () => {
      // Machine A writes its own heartbeat first
      env.heartbeatManager.writeHeartbeat();

      // Machine B sends a newer heartbeat
      const heartbeat = {
        holder: env.bId,
        role: 'awake',
        timestamp: new Date(Date.now() + 5000).toISOString(),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      };
      const headers = signRequest(env.bId, env.bSigning.privateKey, heartbeat, 0);

      const res = await request(env.app)
        .post('/api/heartbeat')
        .set(headers)
        .set('Connection', 'close')
        .send(heartbeat);

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('we-demoted');
      expect(env.getDemoteCalled()).toBe(true);
    });

    it('tells sender to demote when our heartbeat is newer', async () => {
      // Machine A has a fresh heartbeat
      env.heartbeatManager.writeHeartbeat();

      // Machine B sends an older heartbeat
      const heartbeat = {
        holder: env.bId,
        role: 'awake',
        timestamp: new Date(Date.now() - 10_000).toISOString(),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      };
      const headers = signRequest(env.bId, env.bSigning.privateKey, heartbeat, 0);

      const res = await request(env.app)
        .post('/api/heartbeat')
        .set(headers)
        .set('Connection', 'close')
        .send(heartbeat);

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('you-should-demote');
    });

    it('rejects heartbeat with mismatched holder', async () => {
      const heartbeat = {
        holder: 'm_some_other_machine',
        role: 'awake',
        timestamp: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      };
      const headers = signRequest(env.bId, env.bSigning.privateKey, heartbeat, 0);

      const res = await request(env.app)
        .post('/api/heartbeat')
        .set(headers)
        .set('Connection', 'close')
        .send(heartbeat);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('does not match');
    });

    it('rejects unauthenticated heartbeat', async () => {
      const res = await request(env.app)
        .post('/api/heartbeat')
        .set('Connection', 'close')
        .send({ holder: env.bId, role: 'awake', timestamp: new Date().toISOString(), expiresAt: new Date(Date.now() + 900_000).toISOString() });

      expect(res.status).toBe(401);
    });
  });

  // ── Pairing ────────────────────────────────────────────────────

  describe('POST /api/pair', () => {
    it('accepts pairing request (no auth required)', async () => {
      const res = await request(env.app)
        .post('/api/pair')
        .set('Connection', 'close')
        .send({
          pairingCode: 'test-code',
          machineIdentity: { machineId: 'm_new', name: 'new-machine' },
          ephemeralPublicKey: 'base64-key-data',
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
      expect(res.body.machineIdentity).toBeTruthy();
    });

    it('rejects incomplete pairing request', async () => {
      const res = await request(env.app)
        .post('/api/pair')
        .set('Connection', 'close')
        .send({ pairingCode: 'test' });

      expect(res.status).toBe(400);
    });
  });

  // ── Handoff Challenge ──────────────────────────────────────────

  describe('POST /api/handoff/challenge + /api/handoff/request', () => {
    it('generates a challenge', async () => {
      const body = {};
      const headers = signRequest(env.bId, env.bSigning.privateKey, body, 0);

      const res = await request(env.app)
        .post('/api/handoff/challenge')
        .set(headers)
        .set('Connection', 'close')
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.challenge).toBeTruthy();
      expect(res.body.challenge).toHaveLength(64); // 32 bytes hex
      expect(res.body.expiresAt).toBeGreaterThan(Date.now());
    });

    it('completes full handoff with challenge-response', async () => {
      // Step 1: Get a challenge
      const challengeBody = {};
      const challengeHeaders = signRequest(env.bId, env.bSigning.privateKey, challengeBody, 0);

      const challengeRes = await request(env.app)
        .post('/api/handoff/challenge')
        .set(challengeHeaders)
        .set('Connection', 'close')
        .send(challengeBody);

      expect(challengeRes.status).toBe(200);
      const challenge = challengeRes.body.challenge;

      // Step 2: Sign the challenge and make handoff request
      const requestBody: Record<string, unknown> = { reason: 'wakeup' };
      const bodyHash = require('crypto').createHash('sha256')
        .update(JSON.stringify(requestBody))
        .digest('hex');
      const challengeMessage = `${challenge}|${env.bId}|${env.aId}|${bodyHash}`;
      const challengeSignature = sign(challengeMessage, env.bSigning.privateKey);

      const handoffBody = {
        ...requestBody,
        challenge,
        challengeSignature,
      };
      const handoffHeaders = signRequest(env.bId, env.bSigning.privateKey, handoffBody, 1);

      const handoffRes = await request(env.app)
        .post('/api/handoff/request')
        .set(handoffHeaders)
        .set('Connection', 'close')
        .send(handoffBody);

      expect(handoffRes.status).toBe(200);
      expect(handoffRes.body.status).toBe('handed-off');
      expect(handoffRes.body.state).toBeTruthy();

      // Verify Machine A demoted itself
      expect(env.getDemoteCalled()).toBe(true);

      // Verify registry updated
      const registry = env.identityManager.loadRegistry();
      expect(registry.machines[env.aId].role).toBe('standby');
      expect(registry.machines[env.bId].role).toBe('awake');
    });

    it('rejects handoff with wrong challenge signature', async () => {
      // Get a challenge
      const challengeBody = {};
      const challengeHeaders = signRequest(env.bId, env.bSigning.privateKey, challengeBody, 0);
      const challengeRes = await request(env.app)
        .post('/api/handoff/challenge')
        .set(challengeHeaders)
        .set('Connection', 'close')
        .send(challengeBody);

      const challenge = challengeRes.body.challenge;

      // Sign with wrong key
      const wrongKey = generateSigningKeyPair();
      const challengeMessage = `${challenge}|${env.bId}|${env.aId}|hash`;
      const badSignature = sign(challengeMessage, wrongKey.privateKey);

      const handoffBody = {
        reason: 'wakeup',
        challenge,
        challengeSignature: badSignature,
      };
      const handoffHeaders = signRequest(env.bId, env.bSigning.privateKey, handoffBody, 1);

      const res = await request(env.app)
        .post('/api/handoff/request')
        .set(handoffHeaders)
        .set('Connection', 'close')
        .send(handoffBody);

      expect(res.status).toBe(403);
    });

    it('rejects handoff with already-consumed challenge', async () => {
      // Get a challenge
      const challengeBody = {};
      const challengeHeaders = signRequest(env.bId, env.bSigning.privateKey, challengeBody, 0);
      const challengeRes = await request(env.app)
        .post('/api/handoff/challenge')
        .set(challengeHeaders)
        .set('Connection', 'close')
        .send(challengeBody);

      const challenge = challengeRes.body.challenge;
      const requestBody: Record<string, unknown> = { reason: 'wakeup' };
      const bodyHash = require('crypto').createHash('sha256')
        .update(JSON.stringify(requestBody))
        .digest('hex');
      const challengeMessage = `${challenge}|${env.bId}|${env.aId}|${bodyHash}`;
      const challengeSignature = sign(challengeMessage, env.bSigning.privateKey);

      // First request with this challenge succeeds
      const handoffBody1 = { ...requestBody, challenge, challengeSignature };
      const headers1 = signRequest(env.bId, env.bSigning.privateKey, handoffBody1, 1);
      await request(env.app).post('/api/handoff/request').set(headers1).set('Connection', 'close').send(handoffBody1).expect(200);

      // Second request with same challenge fails
      const handoffBody2 = { ...requestBody, challenge, challengeSignature };
      const headers2 = signRequest(env.bId, env.bSigning.privateKey, handoffBody2, 2);
      const res = await request(env.app)
        .post('/api/handoff/request')
        .set(headers2)
        .set('Connection', 'close')
        .send(handoffBody2);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('already-used');
    });
  });

  // ── State Sync ─────────────────────────────────────────────────

  describe('POST /api/sync/state', () => {
    it('accepts valid state sync', async () => {
      const body = {
        type: 'jobs',
        data: [{ slug: 'test-job', lastRun: new Date().toISOString() }],
        timestamp: new Date().toISOString(),
      };
      const headers = signRequest(env.bId, env.bSigning.privateKey, body, 0);

      const res = await request(env.app)
        .post('/api/sync/state')
        .set(headers)
        .set('Connection', 'close')
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('received');
      expect(res.body.type).toBe('jobs');
    });

    it('rejects invalid sync type', async () => {
      const body = { type: 'invalid', data: {} };
      const headers = signRequest(env.bId, env.bSigning.privateKey, body, 0);

      const res = await request(env.app)
        .post('/api/sync/state')
        .set(headers)
        .set('Connection', 'close')
        .send(body);

      expect(res.status).toBe(400);
    });
  });

  // ── Security Log ───────────────────────────────────────────────

  describe('security logging', () => {
    it('logs heartbeat events', async () => {
      const heartbeat = {
        holder: env.bId,
        role: 'awake',
        timestamp: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      };
      const headers = signRequest(env.bId, env.bSigning.privateKey, heartbeat, 0);

      await request(env.app)
        .post('/api/heartbeat')
        .set(headers)
        .set('Connection', 'close')
        .send(heartbeat);

      const events = env.securityLog.readAll();
      const heartbeatEvents = events.filter(e => e.event === 'heartbeat_received');
      expect(heartbeatEvents.length).toBeGreaterThanOrEqual(1);
    });
  });
});
