import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createMoltBridgeRoutes } from '../../../src/moltbridge/routes.js';
import { MoltBridgeClient, type MoltBridgeConfig } from '../../../src/moltbridge/MoltBridgeClient.js';
import { CanonicalIdentityManager } from '../../../src/identity/IdentityManager.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock the moltbridge SDK
vi.mock('moltbridge', () => ({
  MoltBridge: vi.fn().mockImplementation(() => ({
    verify: vi.fn().mockResolvedValue({ verified: true, token: 'test-token' }),
    register: vi.fn().mockResolvedValue({ agent: { id: 'test' }, consents_granted: [] }),
    discoverCapability: vi.fn().mockResolvedValue({ results: [] }),
    evaluateIqs: vi.fn().mockResolvedValue({ band: 'medium' }),
    attest: vi.fn().mockResolvedValue({ attestation: {} }),
    health: vi.fn().mockResolvedValue({ status: 'healthy', neo4j: { connected: true } }),
    updateProfile: vi.fn().mockResolvedValue({ updated: true }),
    updatePrincipal: vi.fn().mockResolvedValue({ profile: { bio: 'test' } }),
    onboardPrincipal: vi.fn().mockResolvedValue({ profile: { bio: 'test' } }),
    getPrincipal: vi.fn().mockResolvedValue({ bio: 'Test agent', expertise: ['TypeScript'] }),
    getPrincipalVisibility: vi.fn().mockResolvedValue({ bio: 'Test agent' }),
  })),
  Ed25519Signer: { fromSeed: vi.fn(), generate: vi.fn() },
}));

describe('MoltBridge Routes', () => {
  let app: express.Express;
  let tmpDir: string;
  let identity: CanonicalIdentityManager;
  let client: MoltBridgeClient;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-routes-'));
    identity = new CanonicalIdentityManager(tmpDir);
    identity.create({ skipRecovery: true });

    client = new MoltBridgeClient({
      enabled: true,
      apiUrl: 'https://api.moltbridge.test',
      autoRegister: false,
      enrichmentMode: 'manual',
    });

    // Initialize client with the created identity
    const id = identity.get();
    if (id) client.initializeWithIdentity(id);

    app = express();
    app.use(express.json());
    app.use(createMoltBridgeRoutes({ client, identity }));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET /moltbridge/status', () => {
    it('returns disabled status when client is disabled', async () => {
      const disabledClient = new MoltBridgeClient({
        enabled: false,
        apiUrl: 'https://api.test',
        autoRegister: false,
        enrichmentMode: 'manual',
      });
      const disabledApp = express();
      disabledApp.use(express.json());
      disabledApp.use(createMoltBridgeRoutes({ client: disabledClient, identity }));

      const res = await request(disabledApp).get('/moltbridge/status');
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);
      expect(res.body.reason).toContain('disabled');
    });

    it('returns health status when enabled', async () => {
      const res = await request(app).get('/moltbridge/status');
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(res.body.healthy).toBe(true);
    });
  });

  describe('POST /moltbridge/discover', () => {
    it('returns 400 without capability', async () => {
      const res = await request(app)
        .post('/moltbridge/discover')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('capability');
    });

    it('returns results on valid capability', async () => {
      const res = await request(app)
        .post('/moltbridge/discover')
        .send({ capability: 'code-review', limit: 5 });
      expect(res.status).toBe(200);
      expect(res.body.source).toBe('moltbridge');
      expect(Array.isArray(res.body.agents)).toBe(true);
    });
  });

  describe('POST /moltbridge/attest', () => {
    it('returns 400 without required fields', async () => {
      const res = await request(app)
        .post('/moltbridge/attest')
        .send({ capabilityTag: 'code-review' });
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid attestation type', async () => {
      const res = await request(app)
        .post('/moltbridge/attest')
        .send({
          targetAgentId: 'abc',
          attestationType: 'INVALID',
          confidence: 0.9,
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_ATTESTATION_TYPE');
    });

    it('accepts valid attestation', async () => {
      const res = await request(app)
        .post('/moltbridge/attest')
        .send({
          targetAgentId: 'abc',
          attestationType: 'CAPABILITY',
          capabilityTag: 'code-review',
          confidence: 0.9,
        });
      expect(res.status).toBe(200);
      expect(res.body.submitted).toBe(true);
    });
  });

  describe('GET /moltbridge/trust/:agentId', () => {
    it('returns IQS band for agent', async () => {
      const res = await request(app).get('/moltbridge/trust/some-agent-id');
      expect(res.status).toBe(200);
      expect(res.body.agentId).toBe('some-agent-id');
      expect(['high', 'medium', 'low', 'unknown']).toContain(res.body.iqsBand);
    });
  });

  describe('POST /moltbridge/register', () => {
    it('registers agent with capabilities', async () => {
      const res = await request(app)
        .post('/moltbridge/register')
        .send({ capabilities: ['code-review'], displayName: 'Test Agent' });
      expect(res.status).toBe(200);
      expect(res.body.agent).toBeDefined();
    });
  });

  describe('POST /moltbridge/profile', () => {
    it('returns 400 without narrative', async () => {
      const res = await request(app)
        .post('/moltbridge/profile')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('narrative');
    });

    it('returns 400 if narrative exceeds limit', async () => {
      const res = await request(app)
        .post('/moltbridge/profile')
        .send({ narrative: 'x'.repeat(501) });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('500');
    });

    it('publishes valid profile', async () => {
      const res = await request(app)
        .post('/moltbridge/profile')
        .send({
          narrative: 'Test agent for integration testing',
          specializations: [{ domain: 'testing', level: 'expert' }],
          trackRecord: [],
          roleContext: 'Test role',
          collaborationStyle: 'Async',
          differentiation: 'Test-focused',
          fieldVisibility: {},
        });
      expect(res.status).toBe(200);
      expect(res.body.published).toBe(true);
    });
  });

  describe('GET /moltbridge/profile', () => {
    it('returns agent profile', async () => {
      const res = await request(app).get('/moltbridge/profile');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('bio');
    });
  });

  describe('GET /moltbridge/profile/summary', () => {
    it('returns profile summary', async () => {
      const res = await request(app).get('/moltbridge/profile/summary');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('bio');
    });
  });

  describe('POST /moltbridge/profile/compile', () => {
    it('returns 501 when compiler not configured', async () => {
      const res = await request(app).post('/moltbridge/profile/compile');
      expect(res.status).toBe(501);
    });
  });

  describe('GET /moltbridge/profile/draft', () => {
    it('returns 501 when compiler not configured', async () => {
      const res = await request(app).get('/moltbridge/profile/draft');
      expect(res.status).toBe(501);
    });
  });

  describe('POST /moltbridge/profile/approve', () => {
    it('returns 501 when compiler not configured', async () => {
      const res = await request(app).post('/moltbridge/profile/approve');
      expect(res.status).toBe(501);
    });
  });
});
