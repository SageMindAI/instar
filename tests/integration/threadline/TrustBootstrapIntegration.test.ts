/**
 * TrustBootstrap Integration Tests
 *
 * Tests TrustBootstrap with real InvitationManager, AgentTrustManager, and
 * DNSVerifier (with mock resolver). Only the directory HTTP fetcher is mocked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { TrustBootstrap } from '../../../src/threadline/TrustBootstrap.js';
import type { TrustBootstrapConfig, BootstrapEvidence } from '../../../src/threadline/TrustBootstrap.js';
import { InvitationManager } from '../../../src/threadline/InvitationManager.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import { DNSVerifier } from '../../../src/threadline/DNSVerifier.js';
import type { DNSResolverFn } from '../../../src/threadline/DNSVerifier.js';
import type { HttpFetcher } from '../../../src/threadline/AgentDiscovery.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';

// ── Helpers ─────────────────────────────────────────────────────────

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trust-bootstrap-integration-'));
}

function makeFingerprint(publicKey: Buffer): string {
  return crypto.createHash('sha256').update(publicKey).digest('hex');
}

function makeMockFetcher(responses: Record<string, { ok: boolean; status: number; body: any } | 'error'>): HttpFetcher {
  return async (url: string) => {
    const entry = responses[url];
    if (!entry) {
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    }
    if (entry === 'error') {
      throw new Error('Network error');
    }
    return {
      ok: entry.ok,
      status: entry.status,
      json: async () => entry.body,
    };
  };
}

function makeDnsResolver(records: Record<string, string[][]>): DNSResolverFn {
  return async (hostname: string) => {
    const result = records[hostname];
    if (!result) {
      const err = new Error(`ENOTFOUND ${hostname}`) as NodeJS.ErrnoException;
      err.code = 'ENOTFOUND';
      throw err;
    }
    return result;
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('TrustBootstrap Integration', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = createTmpDir();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  // ── 1. Full Invitation Workflow ────────────────────────────────

  describe('Full invitation workflow', () => {
    it('creates invitation, bootstraps agent, verifies trust persisted, rejects second agent (token consumed)', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const invitationManager = new InvitationManager({ stateDir });

      const token = invitationManager.create({ label: 'test-invite' });

      const bootstrap = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager,
        invitationManager,
      });

      // First agent succeeds
      const result1 = await bootstrap.verify('agent-alpha', { invitationToken: token });
      expect(result1.verified).toBe(true);
      expect(result1.trustLevel).toBe('verified');

      // Trust profile created and upgraded to verified (paired-machine-granted can upgrade)
      const profile = trustManager.getProfile('agent-alpha');
      expect(profile).not.toBeNull();
      expect(profile!.level).toBe('verified');

      // Second agent rejected (single-use token consumed)
      const result2 = await bootstrap.verify('agent-beta', { invitationToken: token });
      expect(result2.verified).toBe(false);
      expect(result2.trustLevel).toBe('untrusted');
    });

    it('tracks consumed-by identity correctly', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const invitationManager = new InvitationManager({ stateDir });
      const token = invitationManager.create({ label: 'track-test', maxUses: 2 });

      const bootstrap = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager,
        invitationManager,
      });

      await bootstrap.verify('agent-one', { invitationToken: token });
      await bootstrap.verify('agent-two', { invitationToken: token });

      const list = invitationManager.list();
      const inv = list.find(i => i.label === 'track-test');
      expect(inv).toBeDefined();
      expect(inv!.consumedBy).toContain('agent-one');
      expect(inv!.consumedBy).toContain('agent-two');
      expect(inv!.useCount).toBe(2);
    });
  });

  // ── 2. Domain Verification E2E ─────────────────────────────────

  describe('Domain verification end-to-end', () => {
    it('verifies agent via DNS TXT record with matching fingerprint', async () => {
      const keyPair = generateIdentityKeyPair();
      const fingerprint = makeFingerprint(keyPair.publicKey);

      const dnsVerifier = new DNSVerifier({
        resolver: makeDnsResolver({
          '_threadline.example.com': [[`threadline-agent=v1 fp=${fingerprint}`]],
        }),
      });

      const trustManager = new AgentTrustManager({ stateDir });
      const bootstrap = new TrustBootstrap({
        strategy: 'domain-verified',
        stateDir,
        trustManager,
        dnsVerifier,
      });

      const result = await bootstrap.verify('agent-example', {
        domain: 'example.com',
        fingerprint,
      });

      expect(result.verified).toBe(true);
      expect(result.trustLevel).toBe('verified');
      // Profile created and upgraded to verified (paired-machine-granted can upgrade)
      expect(trustManager.getProfile('agent-example')!.level).toBe('verified');
    });

    it('rejects agent when DNS fingerprint does not match', async () => {
      const keyPair = generateIdentityKeyPair();
      const fingerprint = makeFingerprint(keyPair.publicKey);
      const wrongFingerprint = crypto.randomBytes(32).toString('hex');

      const dnsVerifier = new DNSVerifier({
        resolver: makeDnsResolver({
          '_threadline.example.com': [[`threadline-agent=v1 fp=${wrongFingerprint}`]],
        }),
      });

      const trustManager = new AgentTrustManager({ stateDir });
      const bootstrap = new TrustBootstrap({
        strategy: 'domain-verified',
        stateDir,
        trustManager,
        dnsVerifier,
      });

      const result = await bootstrap.verify('agent-example', {
        domain: 'example.com',
        fingerprint,
      });

      expect(result.verified).toBe(false);
      expect(result.trustLevel).toBe('untrusted');
    });

    it('fails when no domain provided in evidence', async () => {
      const dnsVerifier = new DNSVerifier({ resolver: makeDnsResolver({}) });
      const trustManager = new AgentTrustManager({ stateDir });

      const bootstrap = new TrustBootstrap({
        strategy: 'domain-verified',
        stateDir,
        trustManager,
        dnsVerifier,
      });

      const result = await bootstrap.verify('agent-x', { fingerprint: 'abc123' });
      expect(result.verified).toBe(false);
      expect(result.reason).toContain('domain');
    });

    it('fails when no fingerprint provided in evidence', async () => {
      const dnsVerifier = new DNSVerifier({ resolver: makeDnsResolver({}) });
      const trustManager = new AgentTrustManager({ stateDir });

      const bootstrap = new TrustBootstrap({
        strategy: 'domain-verified',
        stateDir,
        trustManager,
        dnsVerifier,
      });

      const result = await bootstrap.verify('agent-x', { domain: 'example.com' });
      expect(result.verified).toBe(false);
      expect(result.reason).toContain('fingerprint');
    });
  });

  // ── 3. Directory Verification E2E ──────────────────────────────

  describe('Directory verification end-to-end', () => {
    it('verifies agent via directory lookup', async () => {
      const keyPair = generateIdentityKeyPair();
      const fingerprint = makeFingerprint(keyPair.publicKey);
      const publicKeyHex = keyPair.publicKey.toString('hex');

      const fetcher = makeMockFetcher({
        [`https://directory.example.com/agents/${fingerprint}`]: {
          ok: true,
          status: 200,
          body: {
            verified: true,
            agentName: 'TestAgent',
            publicKey: publicKeyHex,
            verifiedAt: '2026-01-01T00:00:00Z',
          },
        },
      });

      const trustManager = new AgentTrustManager({ stateDir });
      const bootstrap = new TrustBootstrap({
        strategy: 'directory-verified',
        stateDir,
        trustManager,
        directoryUrl: 'https://directory.example.com',
        fetcher,
      });

      const result = await bootstrap.verify('test-agent', {
        fingerprint,
        publicKey: publicKeyHex,
      });

      expect(result.verified).toBe(true);
      expect(result.trustLevel).toBe('verified');
      expect(result.metadata?.agentName).toBe('TestAgent');
      // Profile created and upgraded to verified (paired-machine-granted can upgrade)
      expect(trustManager.getProfile('test-agent')!.level).toBe('verified');
    });

    it('rejects when directory returns 404', async () => {
      const fingerprint = crypto.randomBytes(32).toString('hex');
      const fetcher = makeMockFetcher({});  // no entries => 404

      const trustManager = new AgentTrustManager({ stateDir });
      const bootstrap = new TrustBootstrap({
        strategy: 'directory-verified',
        stateDir,
        trustManager,
        directoryUrl: 'https://directory.example.com',
        fetcher,
      });

      const result = await bootstrap.verify('unknown-agent', { fingerprint });
      expect(result.verified).toBe(false);
      expect(result.reason).toContain('not found');
    });

    it('rejects when directory reports agent not verified', async () => {
      const fingerprint = crypto.randomBytes(32).toString('hex');
      const fetcher = makeMockFetcher({
        [`https://directory.example.com/agents/${fingerprint}`]: {
          ok: true,
          status: 200,
          body: {
            verified: false,
            agentName: 'UnverifiedAgent',
            publicKey: '',
            verifiedAt: '',
          },
        },
      });

      const trustManager = new AgentTrustManager({ stateDir });
      const bootstrap = new TrustBootstrap({
        strategy: 'directory-verified',
        stateDir,
        trustManager,
        directoryUrl: 'https://directory.example.com',
        fetcher,
      });

      const result = await bootstrap.verify('unverified-agent', { fingerprint });
      expect(result.verified).toBe(false);
      expect(result.reason).toContain('not verified');
    });

    it('handles network error from directory', async () => {
      const fingerprint = crypto.randomBytes(32).toString('hex');
      const fetcher = makeMockFetcher({
        [`https://directory.example.com/agents/${fingerprint}`]: 'error',
      });

      const trustManager = new AgentTrustManager({ stateDir });
      const bootstrap = new TrustBootstrap({
        strategy: 'directory-verified',
        stateDir,
        trustManager,
        directoryUrl: 'https://directory.example.com',
        fetcher,
      });

      const result = await bootstrap.verify('err-agent', { fingerprint });
      expect(result.verified).toBe(false);
      expect(result.reason).toContain('failed');
    });

    it('rejects when public key does not match directory record', async () => {
      const keyPair = generateIdentityKeyPair();
      const fingerprint = makeFingerprint(keyPair.publicKey);
      const publicKeyHex = keyPair.publicKey.toString('hex');
      const differentKey = crypto.randomBytes(32).toString('hex');

      const fetcher = makeMockFetcher({
        [`https://directory.example.com/agents/${fingerprint}`]: {
          ok: true,
          status: 200,
          body: {
            verified: true,
            agentName: 'MismatchAgent',
            publicKey: differentKey,
            verifiedAt: '2026-01-01T00:00:00Z',
          },
        },
      });

      const trustManager = new AgentTrustManager({ stateDir });
      const bootstrap = new TrustBootstrap({
        strategy: 'directory-verified',
        stateDir,
        trustManager,
        directoryUrl: 'https://directory.example.com',
        fetcher,
      });

      const result = await bootstrap.verify('mismatch-agent', {
        fingerprint,
        publicKey: publicKeyHex,
      });

      expect(result.verified).toBe(false);
      expect(result.reason).toContain('does not match');
    });

    it('requires fingerprint in evidence for directory strategy', async () => {
      const fetcher = makeMockFetcher({});
      const trustManager = new AgentTrustManager({ stateDir });
      const bootstrap = new TrustBootstrap({
        strategy: 'directory-verified',
        stateDir,
        trustManager,
        directoryUrl: 'https://directory.example.com',
        fetcher,
      });

      const result = await bootstrap.verify('no-fp-agent', {});
      expect(result.verified).toBe(false);
      expect(result.reason).toContain('fingerprint');
    });
  });

  // ── 4. Open Bootstrap E2E ─────────────────────────────────────

  describe('Open bootstrap end-to-end', () => {
    it('accepts any agent at untrusted level', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const bootstrap = new TrustBootstrap({
        strategy: 'open',
        stateDir,
        trustManager,
      });

      const result = await bootstrap.verify('random-agent', {
        metadata: { hello: 'world' },
      });

      expect(result.verified).toBe(true);
      expect(result.trustLevel).toBe('untrusted');
      expect(result.metadata?.hello).toBe('world');

      const profile = trustManager.getProfile('random-agent');
      expect(profile).not.toBeNull();
      expect(profile!.level).toBe('untrusted');
    });

    it('creates a profile for previously unknown agent', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      expect(trustManager.getProfile('new-agent')).toBeNull();

      const bootstrap = new TrustBootstrap({
        strategy: 'open',
        stateDir,
        trustManager,
      });

      await bootstrap.verify('new-agent', {});
      expect(trustManager.getProfile('new-agent')).not.toBeNull();
    });
  });

  // ── 5. Trust Persistence ──────────────────────────────────────

  describe('Trust persistence', () => {
    it('trust level persists in AgentTrustManager after bootstrap', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const invitationManager = new InvitationManager({ stateDir });
      const token = invitationManager.create({ label: 'persist-test' });

      const bootstrap = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager,
        invitationManager,
      });

      await bootstrap.verify('persist-agent', { invitationToken: token });

      // Profile created and upgraded to verified (paired-machine-granted can upgrade)
      const profile = trustManager.getProfile('persist-agent');
      expect(profile).not.toBeNull();
      expect(profile!.level).toBe('verified');
      expect(profile!.source).toBe('paired-machine-granted');

      // Verify via listProfiles — agent is at verified level
      const profiles = trustManager.listProfiles({ level: 'verified' });
      expect(profiles.some(p => p.agent === 'persist-agent')).toBe(true);
    });
  });

  // ── 6. Multi-Use Invitation ───────────────────────────────────

  describe('Multi-use invitation', () => {
    it('allows maxUses agents and rejects subsequent ones', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const invitationManager = new InvitationManager({ stateDir });
      const token = invitationManager.create({ label: 'multi-use', maxUses: 3 });

      const bootstrap = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager,
        invitationManager,
      });

      // Three agents succeed
      for (let i = 1; i <= 3; i++) {
        const result = await bootstrap.verify(`agent-${i}`, { invitationToken: token });
        expect(result.verified).toBe(true);
        expect(result.trustLevel).toBe('verified');
      }

      // Fourth agent fails
      const result4 = await bootstrap.verify('agent-4', { invitationToken: token });
      expect(result4.verified).toBe(false);
      expect(result4.trustLevel).toBe('untrusted');
    });
  });

  // ── 7. Expired Invitation ─────────────────────────────────────

  describe('Expired invitation', () => {
    it('rejects bootstrap after invitation expires', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const invitationManager = new InvitationManager({ stateDir });
      // Expire in 1ms
      const token = invitationManager.create({ label: 'ephemeral', expiresInMs: 1 });

      const bootstrap = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager,
        invitationManager,
      });

      // Wait for expiry
      await new Promise(r => setTimeout(r, 10));

      const result = await bootstrap.verify('late-agent', { invitationToken: token });
      expect(result.verified).toBe(false);
      expect(result.trustLevel).toBe('untrusted');
    });
  });

  // ── 8. Revoked Invitation ─────────────────────────────────────

  describe('Revoked invitation', () => {
    it('rejects bootstrap after invitation is revoked', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const invitationManager = new InvitationManager({ stateDir });
      const token = invitationManager.create({ label: 'revocable' });

      invitationManager.revoke(token);

      const bootstrap = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager,
        invitationManager,
      });

      const result = await bootstrap.verify('blocked-agent', { invitationToken: token });
      expect(result.verified).toBe(false);
      expect(result.trustLevel).toBe('untrusted');
    });
  });

  // ── 9. DNS Mismatch ───────────────────────────────────────────

  describe('DNS mismatch', () => {
    it('fails when DNS TXT record has wrong fingerprint', async () => {
      const wrongFp = crypto.randomBytes(32).toString('hex');
      const realFp = crypto.randomBytes(32).toString('hex');

      const dnsVerifier = new DNSVerifier({
        resolver: makeDnsResolver({
          '_threadline.test.com': [[`threadline-agent=v1 fp=${wrongFp}`]],
        }),
      });

      const trustManager = new AgentTrustManager({ stateDir });
      const bootstrap = new TrustBootstrap({
        strategy: 'domain-verified',
        stateDir,
        trustManager,
        dnsVerifier,
      });

      const result = await bootstrap.verify('dns-mismatch', {
        domain: 'test.com',
        fingerprint: realFp,
      });

      expect(result.verified).toBe(false);
    });
  });

  // ── 10. Directory 404 ─────────────────────────────────────────
  // (covered in directory E2E above, but explicit for clarity)

  describe('Directory 404', () => {
    it('returns not verified when directory returns 404 for fingerprint', async () => {
      const fingerprint = crypto.randomBytes(32).toString('hex');
      const fetcher: HttpFetcher = async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: 'not found' }),
      });

      const trustManager = new AgentTrustManager({ stateDir });
      const bootstrap = new TrustBootstrap({
        strategy: 'directory-verified',
        stateDir,
        trustManager,
        directoryUrl: 'https://dir.example.com',
        fetcher,
      });

      const result = await bootstrap.verify('missing-agent', { fingerprint });
      expect(result.verified).toBe(false);
      expect(result.reason).toContain('not found');
    });
  });

  // ── 11. Directory Network Error ───────────────────────────────

  describe('Directory network error', () => {
    it('handles fetch throwing an error gracefully', async () => {
      const fingerprint = crypto.randomBytes(32).toString('hex');
      const fetcher: HttpFetcher = async () => {
        throw new Error('Connection refused');
      };

      const trustManager = new AgentTrustManager({ stateDir });
      const bootstrap = new TrustBootstrap({
        strategy: 'directory-verified',
        stateDir,
        trustManager,
        directoryUrl: 'https://dir.example.com',
        fetcher,
      });

      const result = await bootstrap.verify('err-agent', { fingerprint });
      expect(result.verified).toBe(false);
      expect(result.reason).toContain('Connection refused');
    });
  });

  // ── 12. Strategy Switching ────────────────────────────────────

  describe('Strategy switching', () => {
    it('different TrustBootstrap instances with different strategies work independently', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const invitationManager = new InvitationManager({ stateDir });
      const dnsVerifier = new DNSVerifier({ resolver: makeDnsResolver({}) });

      const openBootstrap = new TrustBootstrap({
        strategy: 'open',
        stateDir,
        trustManager,
      });

      const inviteBootstrap = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager,
        invitationManager,
      });

      const domainBootstrap = new TrustBootstrap({
        strategy: 'domain-verified',
        stateDir,
        trustManager,
        dnsVerifier,
      });

      expect(openBootstrap.getStrategy()).toBe('open');
      expect(inviteBootstrap.getStrategy()).toBe('invitation-only');
      expect(domainBootstrap.getStrategy()).toBe('domain-verified');

      // Open works
      const openResult = await openBootstrap.verify('open-agent', {});
      expect(openResult.verified).toBe(true);
      expect(openResult.trustLevel).toBe('untrusted');

      // Invite without token fails
      const inviteResult = await inviteBootstrap.verify('invite-agent', {});
      expect(inviteResult.verified).toBe(false);

      // Domain without domain fails
      const domainResult = await domainBootstrap.verify('domain-agent', {});
      expect(domainResult.verified).toBe(false);
    });

    it('getStrategy returns correct strategy for each instance', () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const strategies = ['open', 'invitation-only', 'domain-verified', 'directory-verified'] as const;
      const configs: Record<string, Partial<TrustBootstrapConfig>> = {
        'open': {},
        'invitation-only': { invitationManager: new InvitationManager({ stateDir }) },
        'domain-verified': { dnsVerifier: new DNSVerifier({ resolver: makeDnsResolver({}) }) },
        'directory-verified': { directoryUrl: 'https://dir.example.com', fetcher: makeMockFetcher({}) },
      };

      for (const strategy of strategies) {
        const bootstrap = new TrustBootstrap({
          strategy,
          stateDir,
          trustManager,
          ...configs[strategy],
        } as TrustBootstrapConfig);
        expect(bootstrap.getStrategy()).toBe(strategy);
      }
    });
  });

  // ── Config Validation ─────────────────────────────────────────

  describe('Config validation', () => {
    it('throws when directory-verified strategy lacks directoryUrl', () => {
      const trustManager = new AgentTrustManager({ stateDir });
      expect(() => new TrustBootstrap({
        strategy: 'directory-verified',
        stateDir,
        trustManager,
      })).toThrow('directoryUrl');
    });

    it('throws when domain-verified strategy lacks dnsVerifier', () => {
      const trustManager = new AgentTrustManager({ stateDir });
      expect(() => new TrustBootstrap({
        strategy: 'domain-verified',
        stateDir,
        trustManager,
      })).toThrow('dnsVerifier');
    });

    it('throws when invitation-only strategy lacks invitationManager', () => {
      const trustManager = new AgentTrustManager({ stateDir });
      expect(() => new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager,
      })).toThrow('invitationManager');
    });

    it('does not throw for open strategy with minimal config', () => {
      const trustManager = new AgentTrustManager({ stateDir });
      expect(() => new TrustBootstrap({
        strategy: 'open',
        stateDir,
        trustManager,
      })).not.toThrow();
    });
  });

  // ── Missing Evidence Fields ───────────────────────────────────

  describe('Missing evidence fields', () => {
    it('invitation-only rejects when no token in evidence', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const invitationManager = new InvitationManager({ stateDir });

      const bootstrap = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager,
        invitationManager,
      });

      const result = await bootstrap.verify('no-token-agent', {});
      expect(result.verified).toBe(false);
      expect(result.reason).toContain('invitation token');
    });

    it('invitation-only rejects forged token', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const invitationManager = new InvitationManager({ stateDir });

      const bootstrap = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager,
        invitationManager,
      });

      const result = await bootstrap.verify('forger', {
        invitationToken: crypto.randomBytes(32).toString('hex'),
      });

      expect(result.verified).toBe(false);
    });
  });
});
