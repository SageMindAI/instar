import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MoltBridgeClient, type MoltBridgeConfig } from '../../../src/moltbridge/MoltBridgeClient.js';
import type { CanonicalIdentity } from '../../../src/identity/types.js';

// Mock the moltbridge SDK module
vi.mock('moltbridge', () => {
  const mockVerify = vi.fn().mockResolvedValue({ verified: true, token: 'test-token-123' });
  const mockRegister = vi.fn().mockResolvedValue({
    agent: { id: 'test-agent', name: 'test', trust_score: 0 },
    consents_granted: ['operational_omniscience', 'iqs_scoring'],
  });
  const mockDiscoverCapability = vi.fn().mockResolvedValue({
    results: [
      { agent_id: 'agent-1', agent_name: 'Agent One', matched_capabilities: ['code-review'], trust_score: 0.8, match_score: 0.9 },
    ],
    query_time_ms: 42,
  });
  const mockEvaluateIqs = vi.fn().mockResolvedValue({
    band: 'high',
    recommendation: 'Proceed with introduction',
    threshold_used: 0.7,
    is_probationary: false,
    components_received: true,
  });
  const mockAttest = vi.fn().mockResolvedValue({
    attestation: { source: 'me', target: 'them', type: 'CAPABILITY', confidence: 0.9, created_at: '2026-01-01', valid_until: '2026-07-01' },
    target_trust_score: 0.85,
  });
  const mockHealth = vi.fn().mockResolvedValue({
    name: 'MoltBridge',
    version: '0.1.0',
    status: 'healthy',
    uptime: 12345,
    neo4j: { connected: true },
  });

  return {
    MoltBridge: vi.fn().mockImplementation(() => ({
      verify: mockVerify,
      register: mockRegister,
      discoverCapability: mockDiscoverCapability,
      evaluateIqs: mockEvaluateIqs,
      attest: mockAttest,
      health: mockHealth,
    })),
    Ed25519Signer: {
      fromSeed: vi.fn().mockReturnValue({ agentId: 'test', publicKeyB64: 'pubkey' }),
      generate: vi.fn().mockReturnValue({ agentId: 'test', publicKeyB64: 'pubkey' }),
    },
    // Re-export the mock functions so tests can access them
    _mocks: { mockVerify, mockRegister, mockDiscoverCapability, mockEvaluateIqs, mockAttest, mockHealth },
  };
});

const { _mocks } = await import('moltbridge') as any;

const testConfig: MoltBridgeConfig = {
  enabled: true,
  apiUrl: 'https://api.moltbridge.test',
  autoRegister: false,
  enrichmentMode: 'manual',
};

const testIdentity: CanonicalIdentity = {
  version: 1,
  publicKey: Buffer.alloc(32, 1),
  privateKey: Buffer.alloc(32, 2),
  x25519PublicKey: Buffer.alloc(32, 3),
  canonicalId: 'a'.repeat(64),
  displayFingerprint: 'a'.repeat(16),
  createdAt: '2026-01-01T00:00:00Z',
};

describe('MoltBridgeClient', () => {
  let client: MoltBridgeClient;

  beforeEach(() => {
    client = new MoltBridgeClient(testConfig);
    vi.clearAllMocks();
  });

  describe('configuration', () => {
    it('reports enabled status', () => {
      expect(client.enabled).toBe(true);
      const disabled = new MoltBridgeClient({ ...testConfig, enabled: false });
      expect(disabled.enabled).toBe(false);
    });

    it('reports enrichment mode', () => {
      expect(client.enrichmentMode).toBe('manual');
    });

    it('starts uninitialized', () => {
      expect(client.initialized).toBe(false);
    });
  });

  describe('initialization', () => {
    it('initializes with identity', () => {
      client.initializeWithIdentity(testIdentity);
      expect(client.initialized).toBe(true);
    });

    it('throws on API calls before initialization', async () => {
      await expect(client.discover('test')).rejects.toThrow('not initialized');
    });
  });

  describe('registration', () => {
    it('runs verification then registers with correct fields', async () => {
      client.initializeWithIdentity(testIdentity);

      const result = await client.register(testIdentity, ['code-review'], 'Test Agent');

      expect(_mocks.mockVerify).toHaveBeenCalled();
      expect(_mocks.mockRegister).toHaveBeenCalledWith({
        agentId: testIdentity.canonicalId,
        name: 'Test Agent',
        platform: 'instar',
        pubkey: testIdentity.publicKey.toString('base64url'),
        capabilities: ['code-review'],
        verificationToken: 'test-token-123',
        omniscienceAcknowledged: true,
        article22Consent: true,
      });

      expect(result.agent).toBeDefined();
      expect(result.consentsGranted).toContain('operational_omniscience');
    });
  });

  describe('discovery', () => {
    it('calls discoverCapability with correct params', async () => {
      client.initializeWithIdentity(testIdentity);

      const result = await client.discover('code-review', 5);

      expect(_mocks.mockDiscoverCapability).toHaveBeenCalledWith({
        needs: ['code-review'],
        maxResults: 5,
      });
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].agentId).toBe('agent-1');
      expect(result.agents[0].agentName).toBe('Agent One');
      expect(result.source).toBe('moltbridge');
      expect(result.queryTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('IQS evaluation', () => {
    it('calls evaluateIqs with targetId', async () => {
      client.initializeWithIdentity(testIdentity);

      const band = await client.getIQSBand('target-agent-123');

      expect(_mocks.mockEvaluateIqs).toHaveBeenCalledWith({ targetId: 'target-agent-123' });
      expect(band).toBe('high');
    });

    it('caches IQS results', async () => {
      client.initializeWithIdentity(testIdentity);

      const first = await client.getIQSBand('agent-1');
      const second = await client.getIQSBand('agent-1');

      expect(first).toBe('high');
      expect(second).toBe('high');
      expect(_mocks.mockEvaluateIqs).toHaveBeenCalledTimes(1); // only one API call
    });

    it('returns null on error (graceful degradation)', async () => {
      client.initializeWithIdentity(testIdentity);
      _mocks.mockEvaluateIqs.mockRejectedValueOnce(new Error('network error'));

      const result = await client.getIQSBand('bad-agent');
      expect(result).toBeNull();
    });
  });

  describe('attestation', () => {
    it('submits attestation with correct params', async () => {
      client.initializeWithIdentity(testIdentity);

      await client.submitAttestation({
        targetAgentId: 'target-123',
        attestationType: 'CAPABILITY',
        capabilityTag: 'code-review',
        confidence: 0.9,
      });

      expect(_mocks.mockAttest).toHaveBeenCalledWith({
        targetAgentId: 'target-123',
        attestationType: 'CAPABILITY',
        capabilityTag: 'code-review',
        confidence: 0.9,
      });
    });
  });

  describe('health check', () => {
    it('returns server health', async () => {
      client.initializeWithIdentity(testIdentity);

      const health = await client.health();
      expect(health.status).toBe('healthy');
      expect(health.neo4j.connected).toBe(true);
    });
  });

  describe('circuit breaker', () => {
    it('starts closed', () => {
      expect(client.isCircuitBreakerOpen).toBe(false);
    });

    it('opens after 3 failures', async () => {
      client.initializeWithIdentity(testIdentity);
      _mocks.mockDiscoverCapability.mockRejectedValue(new Error('network error'));

      for (let i = 0; i < 3; i++) {
        try { await client.discover('test'); } catch { /* expected */ }
      }

      expect(client.isCircuitBreakerOpen).toBe(true);
      await expect(client.discover('test')).rejects.toThrow('circuit breaker');
    });

    it('resets after success', async () => {
      client.initializeWithIdentity(testIdentity);

      // Cause 2 failures (not enough to trip)
      _mocks.mockDiscoverCapability.mockRejectedValueOnce(new Error('fail'));
      _mocks.mockDiscoverCapability.mockRejectedValueOnce(new Error('fail'));
      try { await client.discover('test'); } catch {}
      try { await client.discover('test'); } catch {}

      // Successful call resets counter
      _mocks.mockDiscoverCapability.mockResolvedValueOnce({ results: [] });
      await client.discover('test');

      expect(client.isCircuitBreakerOpen).toBe(false);
    });
  });
});
