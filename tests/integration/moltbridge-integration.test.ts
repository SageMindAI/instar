/**
 * MoltBridge Integration Test — Real API calls against running server.
 *
 * REQUIRES: MoltBridge server running at localhost:3040
 * Skip if server is unavailable (test is conditional).
 *
 * Tests the full flow: health → verify → register → discover → attest → IQS
 * using the real MoltBridge SDK (no mocks).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { MoltBridgeClient, type MoltBridgeConfig } from '../../src/moltbridge/MoltBridgeClient.js';
import type { CanonicalIdentity } from '../../src/identity/types.js';
import crypto from 'node:crypto';

const MOLTBRIDGE_URL = 'http://localhost:3040';

// Generate a test identity
function createTestIdentity(): CanonicalIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const canonicalId = crypto.createHash('sha256')
    .update(Buffer.from('instar-agent-id-v1', 'utf-8'))
    .update(pub)
    .digest('hex');

  return {
    version: 1,
    publicKey: Buffer.from(pub),
    privateKey: Buffer.from(priv),
    x25519PublicKey: Buffer.alloc(32), // not needed for MoltBridge
    canonicalId,
    displayFingerprint: canonicalId.slice(0, 16),
    createdAt: new Date().toISOString(),
  };
}

// Check if MoltBridge server is reachable
async function isServerAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${MOLTBRIDGE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json() as any;
    return data.status === 'healthy';
  } catch {
    return false;
  }
}

describe('MoltBridge Integration (real server)', () => {
  let serverAvailable = false;
  let client: MoltBridgeClient;
  let identity: CanonicalIdentity;

  const config: MoltBridgeConfig = {
    enabled: true,
    apiUrl: MOLTBRIDGE_URL,
    autoRegister: false,
    enrichmentMode: 'manual',
    agentName: 'instar-integration-test',
    platform: 'instar-test',
  };

  beforeAll(async () => {
    serverAvailable = await isServerAvailable();
    if (!serverAvailable) {
      console.log('  ⏭ MoltBridge server not available at localhost:3040 — skipping integration tests');
      return;
    }

    identity = createTestIdentity();
    client = new MoltBridgeClient(config);
    client.initializeWithIdentity(identity);
  });

  it('server is healthy', async () => {
    if (!serverAvailable) return;

    const health = await client.health();
    expect(health.status).toBe('healthy');
    expect(health.neo4j.connected).toBe(true);
  });

  it('full flow: verify → register → discover → attest', async () => {
    if (!serverAvailable) return;

    // Step 1: Verify (proof-of-work + cognitive challenge)
    const verification = await client.verify();
    expect(verification.verified).toBe(true);
    expect(verification.token).toBeTruthy();

    // Step 2: Register
    const registration = await client.register(
      identity,
      ['code-review', 'testing', 'debugging'],
      'Echo Integration Test',
    );
    expect(registration.agent).toBeDefined();
    expect(registration.consentsGranted).toEqual(
      expect.arrayContaining(['operational_omniscience', 'iqs_scoring']),
    );

    // Step 3: Discover (may find our agent or others)
    const discovery = await client.discover('code-review', 5);
    expect(discovery.source).toBe('moltbridge');
    expect(discovery.queryTimeMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(discovery.agents)).toBe(true);

    // Step 4: Register a second agent to attest about
    const identity2 = createTestIdentity();
    const client2 = new MoltBridgeClient(config);
    client2.initializeWithIdentity(identity2);
    const v2 = await client2.verify();
    expect(v2.verified).toBe(true);
    await client2.register(identity2, ['debugging'], 'Target Agent');

    // Step 5: Attest about the second agent
    const attested = await client.submitAttestation({
      targetAgentId: identity2.canonicalId,
      attestationType: 'CAPABILITY',
      capabilityTag: 'debugging',
      confidence: 0.85,
    });
    expect(attested).toBe(true);

    // Step 6: IQS evaluation
    const band = await client.getIQSBand(identity2.canonicalId);
    if (band !== null) {
      expect(['high', 'medium', 'low', 'unknown']).toContain(band);
    }
  });

  it('circuit breaker handles failures gracefully', async () => {
    // Create a client pointed at a non-existent server
    const badClient = new MoltBridgeClient({
      ...config,
      apiUrl: 'http://localhost:19999', // nothing here
    });
    const badIdentity = createTestIdentity();
    badClient.initializeWithIdentity(badIdentity);

    // Should fail but not crash
    try {
      await badClient.discover('test');
    } catch (err) {
      expect(err).toBeDefined();
    }

    // After 3 failures, circuit breaker should open
    try { await badClient.discover('test'); } catch {}
    try { await badClient.discover('test'); } catch {}

    expect(badClient.isCircuitBreakerOpen).toBe(true);
  });
});
