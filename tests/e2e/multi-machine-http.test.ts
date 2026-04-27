/**
 * E2E tests for multi-machine HTTP communication.
 *
 * Spins up two actual AgentServer instances and tests:
 * - Machine-to-machine authentication (Ed25519 signed requests)
 * - Heartbeat exchange between machines
 * - Full challenge-response handoff flow
 * - Pairing endpoint (unauthenticated)
 * - State sync endpoint
 *
 * These tests exercise the real HTTP stack, middleware, and crypto.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { AgentServer } from '../../src/server/AgentServer.js';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { MachineIdentityManager, generateMachineId, generateSigningKeyPair, generateEncryptionKeyPair, sign } from '../../src/core/MachineIdentity.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { signRequest } from '../../src/server/machineAuth.js';
import type { InstarConfig } from '../../src/core/types.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-http-e2e-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Create a fully initialized machine environment with identity, keys, and config.
 */
function createMachineEnv(name: string, port: number, role: 'awake' | 'standby' = 'awake') {
  const stateDir = createTempDir();
  const projectDir = stateDir; // For simplicity, state dir IS project dir

  const mgr = new MachineIdentityManager(stateDir);
  const machineId = generateMachineId();
  const signingKeys = generateSigningKeyPair();
  const encryptionKeys = generateEncryptionKeyPair();

  // Build identity — store full SPKI DER base64 (matches pemToBase64 behavior)
  const signingPubBase64 = signingKeys.publicKey
    .replace(/-----[A-Z ]+-----/g, '')
    .replace(/\s/g, '');
  const encryptionPubBase64 = encryptionKeys.publicKey
    .replace(/-----[A-Z ]+-----/g, '')
    .replace(/\s/g, '');

  const identity = {
    machineId,
    signingPublicKey: signingPubBase64,
    encryptionPublicKey: encryptionPubBase64,
    name,
    platform: `${os.platform()}-${os.arch()}`,
    createdAt: new Date().toISOString(),
    capabilities: ['sessions'] as string[],
  };

  // Write identity and keys to disk
  const machineDir = path.join(stateDir, 'machine');
  fs.mkdirSync(machineDir, { recursive: true });
  fs.writeFileSync(path.join(machineDir, 'identity.json'), JSON.stringify(identity, null, 2));
  fs.writeFileSync(path.join(machineDir, 'signing-private.pem'), signingKeys.privateKey, { mode: 0o600 });
  fs.writeFileSync(path.join(machineDir, 'encryption-private.pem'), encryptionKeys.privateKey, { mode: 0o600 });

  // Register self in registry
  mgr.registerMachine(identity as any, role);

  // Create minimal config
  const config: InstarConfig = {
    projectName: `test-${name}`,
    projectDir,
    stateDir,
    port,
    host: '127.0.0.1',
    authToken: `test-auth-${name}`,
    claudePath: 'claude',
    tmuxPath: 'tmux',
    scheduler: { enabled: false, timezone: 'UTC' },
    messaging: [],
    monitoring: {},
    requestTimeoutMs: 30000,
  } as InstarConfig;

  return {
    stateDir,
    projectDir,
    mgr,
    identity,
    machineId,
    signingKeys,
    encryptionKeys,
    config,
  };
}

/**
 * Cross-register two machines: each machine knows about the other.
 */
function crossRegister(
  envA: ReturnType<typeof createMachineEnv>,
  envB: ReturnType<typeof createMachineEnv>,
) {
  // A knows about B
  envA.mgr.registerMachine(envB.identity as any, 'standby');
  envA.mgr.storeRemoteIdentity(envB.identity as any);

  // B knows about A
  envB.mgr.registerMachine(envA.identity as any, 'awake');
  envB.mgr.storeRemoteIdentity(envA.identity as any);
}

describe('Multi-Machine HTTP E2E', () => {
  // Use ports in high range to avoid conflicts
  const PORT_A = 19100 + Math.floor(Math.random() * 100);
  const PORT_B = PORT_A + 1;

  let envA: ReturnType<typeof createMachineEnv>;
  let envB: ReturnType<typeof createMachineEnv>;
  let serverA: AgentServer;
  let serverB: AgentServer;
  let coordA: MultiMachineCoordinator;
  let coordB: MultiMachineCoordinator;

  beforeAll(async () => {
    // Create machine environments
    envA = createMachineEnv('machine-a', PORT_A, 'awake');
    envB = createMachineEnv('machine-b', PORT_B, 'standby');
    crossRegister(envA, envB);

    // Create coordinators — A must start first and write heartbeat before B starts
    const stateA = new StateManager(envA.stateDir);
    coordA = new MultiMachineCoordinator(stateA, { stateDir: envA.stateDir });
    coordA.start(); // This writes a heartbeat as the awake machine

    // Copy A's heartbeat to B's state dir so B sees A is alive
    const heartbeatSrc = path.join(envA.stateDir, 'state', 'heartbeat.json');
    const heartbeatDst = path.join(envB.stateDir, 'state', 'heartbeat.json');
    fs.mkdirSync(path.dirname(heartbeatDst), { recursive: true });
    if (fs.existsSync(heartbeatSrc)) {
      fs.copyFileSync(heartbeatSrc, heartbeatDst);
    }

    const stateB = new StateManager(envB.stateDir);
    coordB = new MultiMachineCoordinator(stateB, { stateDir: envB.stateDir });
    coordB.start(); // Should stay standby because A's heartbeat is fresh

    // Create session managers (minimal — just need them for AgentServer constructor)
    const sessA = new SessionManager({
      stateDir: envA.stateDir,
      claudePath: 'claude',
      tmuxPath: 'tmux',
      projectDir: envA.projectDir,
      port: PORT_A,
    });
    const sessB = new SessionManager({
      stateDir: envB.stateDir,
      claudePath: 'claude',
      tmuxPath: 'tmux',
      projectDir: envB.projectDir,
      port: PORT_B,
    });

    // Create and start servers
    serverA = new AgentServer({
      config: envA.config,
      sessionManager: sessA,
      state: stateA,
      coordinator: coordA,
      localSigningKeyPem: envA.signingKeys.privateKey,
    });

    serverB = new AgentServer({
      config: envB.config,
      sessionManager: sessB,
      state: stateB,
      coordinator: coordB,
      localSigningKeyPem: envB.signingKeys.privateKey,
    });

    await serverA.start();
    await serverB.start();
  }, 15000);

  afterAll(async () => {
    await serverA?.stop();
    await serverB?.stop();
    coordA?.stop();
    coordB?.stop();
    cleanup(envA.stateDir);
    cleanup(envB.stateDir);
  }, 10000);

  // ── Health Check ────────────────────────────────────────────────

  it('both servers are listening and respond', async () => {
    // Health endpoint may error due to tmux not being available in test env,
    // but the server itself should be responding (not connection refused)
    const respA = await fetch(`http://127.0.0.1:${PORT_A}/health`);
    // Any HTTP response means the server is up — status may be 500 if tmux is unavailable
    expect(respA.status).toBeGreaterThan(0);

    const respB = await fetch(`http://127.0.0.1:${PORT_B}/health`);
    expect(respB.status).toBeGreaterThan(0);
  });

  // ── Machine Auth ────────────────────────────────────────────────

  it('rejects unsigned requests to machine endpoints', async () => {
    const resp = await fetch(`http://127.0.0.1:${PORT_A}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ holder: 'fake', timestamp: new Date().toISOString(), expiresAt: new Date().toISOString() }),
    });
    // Should be 401 or 403 (no auth headers)
    expect(resp.ok).toBe(false);
    expect(resp.status).toBeGreaterThanOrEqual(400);
  });

  it('accepts properly signed requests', async () => {
    const heartbeat = {
      holder: envB.machineId,
      role: 'standby',
      timestamp: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };

    const headers = signRequest(envB.machineId, envB.signingKeys.privateKey, heartbeat, 1);

    const resp = await fetch(`http://127.0.0.1:${PORT_A}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(heartbeat),
    });

    expect(resp.ok).toBe(true);
    const body = await resp.json() as { status: string };
    expect(body.status).toBe('acknowledged');
  });

  // ── Pairing ─────────────────────────────────────────────────────

  it('pairing endpoint works without machine auth', async () => {
    const resp = await fetch(`http://127.0.0.1:${PORT_A}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairingCode: 'TEST-CODE-1234',
        machineIdentity: envB.identity,
        ephemeralPublicKey: 'test-ephemeral-key',
      }),
    });

    expect(resp.ok).toBe(true);
    const body = await resp.json() as { status: string; machineIdentity: any };
    expect(body.status).toBe('pending');
    expect(body.machineIdentity.machineId).toBe(envA.machineId);
  });

  // ── Full Handoff Flow ──────────────────────────────────────────

  it('full challenge-response handoff: B takes over from A', async () => {
    const baseUrl = `http://127.0.0.1:${PORT_A}`;

    // Step 1: B requests a challenge from A
    const challengeHeaders = signRequest(envB.machineId, envB.signingKeys.privateKey, {}, 10);
    const challengeResp = await fetch(`${baseUrl}/api/handoff/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...challengeHeaders },
      body: JSON.stringify({}),
    });

    expect(challengeResp.ok).toBe(true);
    const { challenge, expiresAt } = await challengeResp.json() as { challenge: string; expiresAt: string };
    expect(challenge).toBeTruthy();
    expect(expiresAt).toBeTruthy();

    // Step 2: B signs the challenge
    // The server expects: challenge|sender_machine_id|receiver_machine_id|bodyHash
    const bodyForHash = {}; // empty because we only send challenge + signature
    const bodyHash = crypto.createHash('sha256')
      .update(JSON.stringify(bodyForHash))
      .digest('hex');
    const challengeMessage = `${challenge}|${envB.machineId}|${envA.machineId}|${bodyHash}`;
    const challengeSignature = sign(challengeMessage, envB.signingKeys.privateKey);

    // Step 3: B sends the handoff request with signed challenge
    const handoffBody = { challenge, challengeSignature };
    const handoffHeaders = signRequest(envB.machineId, envB.signingKeys.privateKey, handoffBody, 11);

    const handoffResp = await fetch(`${baseUrl}/api/handoff/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...handoffHeaders },
      body: JSON.stringify(handoffBody),
    });

    expect(handoffResp.ok).toBe(true);
    const result = await handoffResp.json() as { status: string; message?: string; state?: unknown };
    expect(result.status).toBe('handed-off');
    expect(result.message).toContain('Handoff complete');

    // Step 4: Verify role changes in A's registry
    const registryA = envA.mgr.loadRegistry();
    expect(registryA.machines[envA.machineId].role).toBe('standby');
    expect(registryA.machines[envB.machineId].role).toBe('awake');

    // Step 5: Verify coordinator state on A
    expect(coordA.isAwake).toBe(false);
  });

  it('rejects handoff with wrong challenge signature', async () => {
    // Re-register A as awake for this test (it was demoted in the previous test)
    envA.mgr.updateRole(envA.machineId, 'awake');
    envA.mgr.updateRole(envB.machineId, 'standby');
    coordA.promoteToAwake('test re-promotion');

    const baseUrl = `http://127.0.0.1:${PORT_A}`;

    // Get a challenge
    const challengeHeaders = signRequest(envB.machineId, envB.signingKeys.privateKey, {}, 20);
    const challengeResp = await fetch(`${baseUrl}/api/handoff/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...challengeHeaders },
      body: JSON.stringify({}),
    });
    const { challenge } = await challengeResp.json() as { challenge: string };

    // Sign with wrong message (tamper with the challenge)
    const wrongSignature = sign('wrong-data', envB.signingKeys.privateKey);

    const handoffBody = { challenge, challengeSignature: wrongSignature };
    const handoffHeaders = signRequest(envB.machineId, envB.signingKeys.privateKey, handoffBody, 21);

    const handoffResp = await fetch(`${baseUrl}/api/handoff/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...handoffHeaders },
      body: JSON.stringify(handoffBody),
    });

    expect(handoffResp.ok).toBe(false);
    expect(handoffResp.status).toBe(403);
    const body = await handoffResp.json() as { error: string };
    expect(body.error.toLowerCase()).toContain('signature');
  });

  it('rejects replayed challenge', async () => {
    const baseUrl = `http://127.0.0.1:${PORT_A}`;

    // Get a challenge
    const challengeHeaders = signRequest(envB.machineId, envB.signingKeys.privateKey, {}, 30);
    const challengeResp = await fetch(`${baseUrl}/api/handoff/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...challengeHeaders },
      body: JSON.stringify({}),
    });
    const { challenge } = await challengeResp.json() as { challenge: string };

    // Build a valid signature
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify({})).digest('hex');
    const challengeMessage = `${challenge}|${envB.machineId}|${envA.machineId}|${bodyHash}`;
    const challengeSignature = sign(challengeMessage, envB.signingKeys.privateKey);

    // First use: valid
    const handoffBody = { challenge, challengeSignature };
    const headers1 = signRequest(envB.machineId, envB.signingKeys.privateKey, handoffBody, 31);
    const resp1 = await fetch(`${baseUrl}/api/handoff/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers1 },
      body: JSON.stringify(handoffBody),
    });
    expect(resp1.ok).toBe(true);

    // Second use: rejected (challenge consumed)
    const headers2 = signRequest(envB.machineId, envB.signingKeys.privateKey, handoffBody, 32);
    const resp2 = await fetch(`${baseUrl}/api/handoff/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers2 },
      body: JSON.stringify(handoffBody),
    });
    expect(resp2.ok).toBe(false);
    expect(resp2.status).toBe(403);
  });

  // ── State Sync ─────────────────────────────────────────────────

  it('accepts authenticated state sync', async () => {
    // Re-promote A for this test
    envA.mgr.updateRole(envA.machineId, 'awake');
    coordA.promoteToAwake('test re-promotion for sync');

    const syncBody = {
      type: 'jobs',
      data: { jobs: [{ slug: 'health-check', lastRun: new Date().toISOString() }] },
      timestamp: new Date().toISOString(),
    };

    const headers = signRequest(envB.machineId, envB.signingKeys.privateKey, syncBody, 40);
    const resp = await fetch(`http://127.0.0.1:${PORT_A}/api/sync/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(syncBody),
    });

    expect(resp.ok).toBe(true);
    const body = await resp.json() as { status: string; type: string };
    expect(body.status).toBe('received');
    expect(body.type).toBe('jobs');
  });

  it('rejects invalid sync type', async () => {
    const syncBody = {
      type: 'invalid',
      data: {},
      timestamp: new Date().toISOString(),
    };

    const headers = signRequest(envB.machineId, envB.signingKeys.privateKey, syncBody, 41);
    const resp = await fetch(`http://127.0.0.1:${PORT_A}/api/sync/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(syncBody),
    });

    expect(resp.ok).toBe(false);
    expect(resp.status).toBe(400);
  });
});
