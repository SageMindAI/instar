/**
 * Integration test for Rich Agent Profiles.
 *
 * Tests the full flow: compile → draft → approve → publish.
 * Uses mocked MoltBridge SDK but real ProfileCompiler with real file system.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMoltBridgeRoutes } from '../../src/moltbridge/routes.js';
import { MoltBridgeClient } from '../../src/moltbridge/MoltBridgeClient.js';
import { ProfileCompiler } from '../../src/moltbridge/ProfileCompiler.js';
import { CanonicalIdentityManager } from '../../src/identity/IdentityManager.js';

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
    updatePrincipal: vi.fn().mockResolvedValue({ profile: { bio: 'compiled bio' } }),
    onboardPrincipal: vi.fn().mockResolvedValue({ profile: { bio: 'compiled bio' }, enrichment_level: 'basic' }),
    getPrincipal: vi.fn().mockResolvedValue({ bio: 'compiled bio', expertise: ['TypeScript'] }),
    getPrincipalVisibility: vi.fn().mockResolvedValue({ bio: 'compiled bio' }),
  })),
  Ed25519Signer: { fromSeed: vi.fn(), generate: vi.fn() },
}));

describe('Rich Agent Profile Integration', () => {
  let app: express.Express;
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rich-profile-'));
    stateDir = tmpDir;

    // Create test AGENT.md
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), `# TestAgent

## Who I Am

I am TestAgent. I am the lead developer of test-project, specializing in cryptographic identity and agent protocols.

## Personality

Thorough and systematic.
`);

    // Create test MEMORY.md with tagged entries
    fs.writeFileSync(path.join(stateDir, 'MEMORY.md'), `# Memory

## Learnings
- Built the authentication system from scratch #profile-safe
- Internal: user prefers dark mode
- Implemented Ed25519 signing for all API calls #profile-safe
`);

    // Initialize git repo for git stats
    try {
      const execSync = require('child_process').execSync;
      execSync('git init && git add -A && git commit -m "init" --allow-empty', {
        cwd: stateDir, stdio: 'ignore',
      });
    } catch {
      // OK if git init fails in test env
    }

    const identity = new CanonicalIdentityManager(stateDir);
    identity.create({ skipRecovery: true });

    const client = new MoltBridgeClient({
      enabled: true,
      apiUrl: 'https://api.moltbridge.test',
    });
    const id = identity.get();
    if (id) client.initializeWithIdentity(id);

    const profileCompiler = new ProfileCompiler({
      stateDir,
      projectRoot: stateDir,
      capabilities: ['agent-protocols', 'cryptographic-identity'],
      jobNames: ['daily-health-check'],
    });

    app = express();
    app.use(express.json());
    app.use(createMoltBridgeRoutes({ client, identity, profileCompiler }));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full profile lifecycle: compile → review → approve → publish', async () => {
    // Step 1: No draft initially
    const noDraft = await request(app).get('/moltbridge/profile/draft');
    expect(noDraft.status).toBe(200);
    expect(noDraft.body.draft).toBeNull();

    // Step 2: Compile a draft
    const compileRes = await request(app).post('/moltbridge/profile/compile');
    expect(compileRes.status).toBe(200);
    expect(compileRes.body.draft).toBeDefined();
    expect(compileRes.body.draft.status).toBe('pending');
    expect(compileRes.body.draft.profile.narrative).toBeTruthy();

    // Step 3: Verify draft is accessible
    const draftRes = await request(app).get('/moltbridge/profile/draft');
    expect(draftRes.status).toBe(200);
    expect(draftRes.body.draft.status).toBe('pending');

    // Step 4: Approve and publish
    const approveRes = await request(app).post('/moltbridge/profile/approve');
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.published).toBe(true);

    // Step 5: Verify profile is accessible
    const profileRes = await request(app).get('/moltbridge/profile');
    expect(profileRes.status).toBe(200);
  });

  it('compiled profile extracts name from AGENT.md', async () => {
    const res = await request(app).post('/moltbridge/profile/compile');
    expect(res.body.draft.profile.narrative).toContain('TestAgent');
  });

  it('compiled profile only includes #profile-safe memory entries', async () => {
    const res = await request(app).post('/moltbridge/profile/compile');
    const signals = res.body.draft.signals;
    expect(signals.taggedMemoryEntries.length).toBe(2);
    for (const entry of signals.taggedMemoryEntries) {
      expect(entry).not.toContain('dark mode');
    }
  });

  it('compiled profile marks all track records as first_party', async () => {
    const res = await request(app).post('/moltbridge/profile/compile');
    for (const entry of res.body.draft.profile.trackRecord) {
      expect(entry.source).toBe('first_party');
    }
  });

  it('approve fails when no pending draft exists', async () => {
    const res = await request(app).post('/moltbridge/profile/approve');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No pending draft');
  });

  it('direct profile publish works without compiler', async () => {
    const res = await request(app)
      .post('/moltbridge/profile')
      .send({
        narrative: 'Manually crafted agent profile',
        specializations: [{ domain: 'testing', level: 'expert' }],
        trackRecord: [],
        roleContext: 'Test agent',
        collaborationStyle: 'Direct',
        differentiation: 'Test-focused',
        fieldVisibility: { narrative: 'public' },
      });
    expect(res.status).toBe(200);
    expect(res.body.published).toBe(true);
  });
});
