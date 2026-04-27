/**
 * TrustBootstrap E2E Tests
 *
 * Full-stack E2E tests simulating real-world trust bootstrap scenarios.
 * Uses real file persistence (temp dirs), real crypto for fingerprints.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { TrustBootstrap } from '../../../src/threadline/TrustBootstrap.js';
import type { BootstrapEvidence } from '../../../src/threadline/TrustBootstrap.js';
import { InvitationManager } from '../../../src/threadline/InvitationManager.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import type { TrustChangeNotification } from '../../../src/threadline/AgentTrustManager.js';
import { DNSVerifier } from '../../../src/threadline/DNSVerifier.js';
import type { DNSResolverFn } from '../../../src/threadline/DNSVerifier.js';
import type { HttpFetcher } from '../../../src/threadline/AgentDiscovery.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';

// ── Helpers ─────────────────────────────────────────────────────────

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trust-bootstrap-e2e-'));
}

function makeFingerprint(publicKey: Buffer): string {
  return crypto.createHash('sha256').update(publicKey).digest('hex');
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

function makeDirectoryFetcher(agents: Record<string, {
  verified: boolean;
  agentName: string;
  publicKey: string;
  verifiedAt: string;
}>): HttpFetcher {
  return async (url: string) => {
    // Parse fingerprint from URL: .../agents/{fingerprint}
    const parts = url.split('/');
    const fp = parts[parts.length - 1];
    const agent = agents[fp];
    if (!agent) {
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    }
    return { ok: true, status: 200, json: async () => agent };
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('TrustBootstrap E2E', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = createTmpDir();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  // ── 1. New Agent Joining via Invitation ────────────────────────

  describe('New agent joining via invitation', () => {
    it('full lifecycle from invitation creation through trust verification', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const invitationManager = new InvitationManager({ stateDir });
      const keyPair = generateIdentityKeyPair();
      const fingerprint = makeFingerprint(keyPair.publicKey);

      // Create invitation
      const token = invitationManager.create({ label: 'welcome-agent' });

      // Bootstrap
      const bootstrap = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager,
        invitationManager,
      });

      const result = await bootstrap.verify(`agent-${fingerprint.slice(0, 8)}`, {
        invitationToken: token,
        fingerprint,
        publicKey: keyPair.publicKey.toString('hex'),
      });

      expect(result.verified).toBe(true);
      expect(result.trustLevel).toBe('verified');

      // Profile created and upgraded to verified (paired-machine-granted can upgrade)
      const agentId = `agent-${fingerprint.slice(0, 8)}`;
      expect(trustManager.getProfile(agentId)!.level).toBe('verified');
      expect(trustManager.checkPermission(agentId, 'ping')).toBe(true);
      expect(trustManager.checkPermission(agentId, 'health')).toBe(true);
      expect(trustManager.checkPermission(agentId, 'message')).toBe(true);
      expect(trustManager.checkPermission(agentId, 'task-request')).toBe(false);
    });
  });

  // ── 2. Domain-Verified Agent Discovery ─────────────────────────

  describe('Domain-verified agent discovery', () => {
    it('DNS TXT record leads to trust bootstrap and communication capability', async () => {
      const keyPair = generateIdentityKeyPair();
      const fingerprint = makeFingerprint(keyPair.publicKey);

      const dnsVerifier = new DNSVerifier({
        resolver: makeDnsResolver({
          '_threadline.agent.example.org': [[`threadline-agent=v1 fp=${fingerprint}`]],
        }),
        cacheTtlMs: 60_000,
      });

      const trustManager = new AgentTrustManager({ stateDir });
      const bootstrap = new TrustBootstrap({
        strategy: 'domain-verified',
        stateDir,
        trustManager,
        dnsVerifier,
      });

      const result = await bootstrap.verify('domain-agent', {
        domain: 'agent.example.org',
        fingerprint,
      });

      expect(result.verified).toBe(true);
      expect(result.trustLevel).toBe('verified');
      expect(result.metadata?.domain).toBe('agent.example.org');

      // Profile created and upgraded to verified (paired-machine-granted can upgrade)
      expect(trustManager.getProfile('domain-agent')!.level).toBe('verified');
      expect(trustManager.checkPermission('domain-agent', 'ping')).toBe(true);
      expect(trustManager.checkPermission('domain-agent', 'message')).toBe(true);
    });
  });

  // ── 3. Open Network Agent ─────────────────────────────────────

  describe('Open network agent', () => {
    it('unknown agent connects at untrusted level with limited capabilities', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const bootstrap = new TrustBootstrap({
        strategy: 'open',
        stateDir,
        trustManager,
      });

      const result = await bootstrap.verify('stranger', {
        metadata: { reason: 'just exploring' },
      });

      expect(result.verified).toBe(true);
      expect(result.trustLevel).toBe('untrusted');

      // Only basic operations allowed
      expect(trustManager.checkPermission('stranger', 'ping')).toBe(true);
      expect(trustManager.checkPermission('stranger', 'health')).toBe(true);
      expect(trustManager.checkPermission('stranger', 'message')).toBe(false);
      expect(trustManager.checkPermission('stranger', 'task-request')).toBe(false);
    });
  });

  // ── 4. Invitation Token Security ──────────────────────────────

  describe('Invitation token security', () => {
    it('rejects reuse of single-use token', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const invitationManager = new InvitationManager({ stateDir });
      const token = invitationManager.create({ maxUses: 1 });

      const bootstrap = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager,
        invitationManager,
      });

      const first = await bootstrap.verify('agent-1', { invitationToken: token });
      expect(first.verified).toBe(true);

      const second = await bootstrap.verify('agent-2', { invitationToken: token });
      expect(second.verified).toBe(false);
    });

    it('rejects forged token', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const invitationManager = new InvitationManager({ stateDir });

      const bootstrap = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager,
        invitationManager,
      });

      const forgedToken = crypto.randomBytes(32).toString('hex');
      const result = await bootstrap.verify('forger', { invitationToken: forgedToken });
      expect(result.verified).toBe(false);
    });

    it('rejects expired token', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const invitationManager = new InvitationManager({ stateDir });
      const token = invitationManager.create({ expiresInMs: 1 });

      await new Promise(r => setTimeout(r, 10));

      const bootstrap = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager,
        invitationManager,
      });

      const result = await bootstrap.verify('late-agent', { invitationToken: token });
      expect(result.verified).toBe(false);
    });

    it('rejects revoked token', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const invitationManager = new InvitationManager({ stateDir });
      const token = invitationManager.create();
      invitationManager.revoke(token);

      const bootstrap = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager,
        invitationManager,
      });

      const result = await bootstrap.verify('revoked-agent', { invitationToken: token });
      expect(result.verified).toBe(false);
    });
  });

  // ── 5. Trust Escalation Path ──────────────────────────────────

  describe('Trust escalation path', () => {
    it('agent starts verified via invitation then user manually upgrades to trusted', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const invitationManager = new InvitationManager({ stateDir });
      const token = invitationManager.create();

      const bootstrap = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager,
        invitationManager,
      });

      await bootstrap.verify('escalate-agent', { invitationToken: token });
      // Profile upgraded to verified (paired-machine-granted can upgrade)
      expect(trustManager.getProfile('escalate-agent')!.level).toBe('verified');

      // user-granted CAN upgrade to trusted
      const userUpgrade = trustManager.setTrustLevel('escalate-agent', 'trusted', 'user-granted', 'Manual trust upgrade');
      expect(userUpgrade).toBe(true);
      expect(trustManager.getProfile('escalate-agent')!.level).toBe('trusted');

      // Now has trusted-level operations
      expect(trustManager.checkPermission('escalate-agent', 'task-request')).toBe(true);
      expect(trustManager.checkPermission('escalate-agent', 'data-share')).toBe(true);
    });

    it('user can upgrade to autonomous level', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const invitationManager = new InvitationManager({ stateDir });
      const token = invitationManager.create();

      const bootstrap = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager,
        invitationManager,
      });

      await bootstrap.verify('autonomous-candidate', { invitationToken: token });
      // Bootstrap upgrades agent to verified, user grants further upgrades
      trustManager.setTrustLevel('autonomous-candidate', 'trusted', 'user-granted');
      trustManager.setTrustLevel('autonomous-candidate', 'autonomous', 'user-granted', 'Full autonomy granted');

      expect(trustManager.getProfile('autonomous-candidate')!.level).toBe('autonomous');
      expect(trustManager.checkPermission('autonomous-candidate', 'spawn')).toBe(true);
      expect(trustManager.checkPermission('autonomous-candidate', 'delegate')).toBe(true);
    });
  });

  // ── 6. Multi-Agent Invitation Sharing ─────────────────────────

  describe('Multi-agent invitation sharing', () => {
    it('one invitation bootstraps multiple agents up to maxUses', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const invitationManager = new InvitationManager({ stateDir });
      const token = invitationManager.create({ label: 'team-invite', maxUses: 5 });

      const bootstrap = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager,
        invitationManager,
      });

      const results = [];
      for (let i = 0; i < 5; i++) {
        results.push(await bootstrap.verify(`team-member-${i}`, { invitationToken: token }));
      }

      expect(results.every(r => r.verified)).toBe(true);
      expect(results.every(r => r.trustLevel === 'verified')).toBe(true);

      // 6th fails
      const sixth = await bootstrap.verify('team-member-5', { invitationToken: token });
      expect(sixth.verified).toBe(false);

      // All 5 have profiles at verified level
      for (let i = 0; i < 5; i++) {
        expect(trustManager.getProfile(`team-member-${i}`)!.level).toBe('verified');
      }
    });
  });

  // ── 7. File Persistence ───────────────────────────────────────

  describe('File persistence', () => {
    it('bootstrap state survives InvitationManager and AgentTrustManager recreation', async () => {
      // Phase 1: Bootstrap an agent
      const trustManager1 = new AgentTrustManager({ stateDir });
      const invitationManager1 = new InvitationManager({ stateDir });
      const token = invitationManager1.create({ label: 'persist-test', maxUses: 2 });

      const bootstrap1 = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager: trustManager1,
        invitationManager: invitationManager1,
      });

      await bootstrap1.verify('persistent-agent', { invitationToken: token });

      // Phase 2: Recreate all managers from the same stateDir
      const trustManager2 = new AgentTrustManager({ stateDir });
      const invitationManager2 = new InvitationManager({ stateDir });

      // Trust profile persisted
      const profile = trustManager2.getProfile('persistent-agent');
      expect(profile).not.toBeNull();
      // Profile upgraded to verified (paired-machine-granted can upgrade)
      expect(profile!.level).toBe('verified');

      // Invitation state persisted (1 use consumed, 1 remaining)
      const bootstrap2 = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager: trustManager2,
        invitationManager: invitationManager2,
      });

      const result = await bootstrap2.verify('second-agent', { invitationToken: token });
      expect(result.verified).toBe(true);

      // Third use fails (maxUses=2)
      const result3 = await bootstrap2.verify('third-agent', { invitationToken: token });
      expect(result3.verified).toBe(false);
    });

    it('audit trail persists across AgentTrustManager recreations', async () => {
      const trustManager1 = new AgentTrustManager({ stateDir });
      const invitationManager = new InvitationManager({ stateDir });
      const token = invitationManager.create();

      const bootstrap = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager: trustManager1,
        invitationManager,
      });

      await bootstrap.verify('audit-agent', { invitationToken: token });

      // Bootstrap's setTrustLevel with paired-machine-granted successfully upgrades,
      // which writes to the audit trail.

      // Recreate trust manager
      const trustManager2 = new AgentTrustManager({ stateDir });
      const auditTrail = trustManager2.readAuditTrail();
      expect(auditTrail.length).toBeGreaterThan(0);
      expect(auditTrail.some(e => e.agent === 'audit-agent')).toBe(true);
    });
  });

  // ── 8. DNS Cache Behavior ─────────────────────────────────────

  describe('DNS cache behavior', () => {
    it('caches DNS result and serves from cache on second lookup', async () => {
      let queryCount = 0;
      const keyPair = generateIdentityKeyPair();
      const fingerprint = makeFingerprint(keyPair.publicKey);

      const countingResolver: DNSResolverFn = async (hostname: string) => {
        queryCount++;
        return [[`threadline-agent=v1 fp=${fingerprint}`]];
      };

      const dnsVerifier = new DNSVerifier({
        resolver: countingResolver,
        cacheTtlMs: 60_000,
      });

      const trustManager = new AgentTrustManager({ stateDir });

      // First lookup
      const bootstrap = new TrustBootstrap({
        strategy: 'domain-verified',
        stateDir,
        trustManager,
        dnsVerifier,
      });

      await bootstrap.verify('cached-agent-1', {
        domain: 'cache-test.com',
        fingerprint,
      });

      expect(queryCount).toBe(1);

      // Second lookup (should be cached)
      await bootstrap.verify('cached-agent-2', {
        domain: 'cache-test.com',
        fingerprint,
      });

      expect(queryCount).toBe(1); // Still 1 — served from cache
      expect(dnsVerifier.getCacheSize()).toBe(1);
    });
  });

  // ── 9. Directory-Verified with Key Mismatch ───────────────────

  describe('Directory-verified with key mismatch', () => {
    it('rejects when public key in evidence differs from directory record', async () => {
      const keyPair = generateIdentityKeyPair();
      const fingerprint = makeFingerprint(keyPair.publicKey);
      const differentKeyPair = generateIdentityKeyPair();

      const fetcher = makeDirectoryFetcher({
        [fingerprint]: {
          verified: true,
          agentName: 'DirectoryAgent',
          publicKey: differentKeyPair.publicKey.toString('hex'),
          verifiedAt: '2026-01-01T00:00:00Z',
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

      const result = await bootstrap.verify('key-mismatch-agent', {
        fingerprint,
        publicKey: keyPair.publicKey.toString('hex'),
      });

      expect(result.verified).toBe(false);
      expect(result.reason).toContain('does not match');
    });
  });

  // ── 10. Concurrent Bootstraps ─────────────────────────────────

  describe('Concurrent bootstraps', () => {
    it('multiple agents bootstrapping simultaneously all succeed', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const invitationManager = new InvitationManager({ stateDir });

      // Create separate single-use tokens for each agent
      const tokens = Array.from({ length: 5 }, (_, i) =>
        invitationManager.create({ label: `concurrent-${i}` })
      );

      const bootstrap = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager,
        invitationManager,
      });

      // Bootstrap all concurrently
      const results = await Promise.all(
        tokens.map((token, i) =>
          bootstrap.verify(`concurrent-agent-${i}`, { invitationToken: token })
        )
      );

      expect(results.every(r => r.verified)).toBe(true);
      expect(results.every(r => r.trustLevel === 'verified')).toBe(true);

      // All profiles created
      for (let i = 0; i < 5; i++) {
        expect(trustManager.getProfile(`concurrent-agent-${i}`)).not.toBeNull();
      }
    });

    it('concurrent DNS bootstraps all succeed', async () => {
      const keyPairs = Array.from({ length: 3 }, () => generateIdentityKeyPair());
      const fingerprints = keyPairs.map(kp => makeFingerprint(kp.publicKey));

      const dnsRecords: Record<string, string[][]> = {};
      fingerprints.forEach((fp, i) => {
        dnsRecords[`_threadline.agent${i}.example.com`] = [[`threadline-agent=v1 fp=${fp}`]];
      });

      const dnsVerifier = new DNSVerifier({
        resolver: makeDnsResolver(dnsRecords),
      });

      const trustManager = new AgentTrustManager({ stateDir });
      const bootstrap = new TrustBootstrap({
        strategy: 'domain-verified',
        stateDir,
        trustManager,
        dnsVerifier,
      });

      const results = await Promise.all(
        fingerprints.map((fp, i) =>
          bootstrap.verify(`dns-agent-${i}`, {
            domain: `agent${i}.example.com`,
            fingerprint: fp,
          })
        )
      );

      expect(results.every(r => r.verified)).toBe(true);
    });
  });

  // ── 11. Agent Identity Binding ────────────────────────────────

  describe('Agent identity binding', () => {
    it('same invitation consumed by different identities tracks them separately', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const invitationManager = new InvitationManager({ stateDir });
      const token = invitationManager.create({ label: 'binding-test', maxUses: 3 });

      const bootstrap = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager,
        invitationManager,
      });

      await bootstrap.verify('identity-A', { invitationToken: token });
      await bootstrap.verify('identity-B', { invitationToken: token });
      await bootstrap.verify('identity-C', { invitationToken: token });

      // Each identity has its own profile
      expect(trustManager.getProfile('identity-A')!.agent).toBe('identity-A');
      expect(trustManager.getProfile('identity-B')!.agent).toBe('identity-B');
      expect(trustManager.getProfile('identity-C')!.agent).toBe('identity-C');

      // Invitation tracks all consumers
      const list = invitationManager.list();
      const inv = list.find(i => i.label === 'binding-test');
      expect(inv!.consumedBy).toHaveLength(3);
      expect(inv!.consumedBy).toContain('identity-A');
      expect(inv!.consumedBy).toContain('identity-B');
      expect(inv!.consumedBy).toContain('identity-C');
    });
  });

  // ── 12. Security: Spoofing Prevention ─────────────────────────

  describe('Security: spoofing prevention', () => {
    it('agent claiming to be verified but with wrong key is rejected by directory', async () => {
      const realKeyPair = generateIdentityKeyPair();
      const realFingerprint = makeFingerprint(realKeyPair.publicKey);

      const spoofKeyPair = generateIdentityKeyPair();

      const fetcher = makeDirectoryFetcher({
        [realFingerprint]: {
          verified: true,
          agentName: 'RealAgent',
          publicKey: realKeyPair.publicKey.toString('hex'),
          verifiedAt: '2026-01-01T00:00:00Z',
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

      // Spoofer uses real fingerprint but different key
      const result = await bootstrap.verify('spoofer', {
        fingerprint: realFingerprint,
        publicKey: spoofKeyPair.publicKey.toString('hex'),
      });

      expect(result.verified).toBe(false);
      expect(result.reason).toContain('does not match');
    });

    it('agent with no fingerprint cannot pass directory verification', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const fetcher = makeDirectoryFetcher({});

      const bootstrap = new TrustBootstrap({
        strategy: 'directory-verified',
        stateDir,
        trustManager,
        directoryUrl: 'https://directory.example.com',
        fetcher,
      });

      const result = await bootstrap.verify('no-fp-spoofer', {
        publicKey: crypto.randomBytes(32).toString('hex'),
      });

      expect(result.verified).toBe(false);
      expect(result.reason).toContain('fingerprint');
    });
  });

  // ── 13. Token Cleanup ─────────────────────────────────────────

  describe('Token cleanup', () => {
    it('list() returns all tokens with correct status', async () => {
      const invitationManager = new InvitationManager({ stateDir });

      // Create various tokens
      const validToken = invitationManager.create({ label: 'valid' });
      const expiredToken = invitationManager.create({ label: 'expired', expiresInMs: 1 });
      const revokedToken = invitationManager.create({ label: 'revoked' });
      const usedToken = invitationManager.create({ label: 'used', maxUses: 1 });
      const multiToken = invitationManager.create({ label: 'multi', maxUses: 3 });

      // Revoke one
      invitationManager.revoke(revokedToken);

      // Consume one
      invitationManager.consume(usedToken, 'consumer-agent');

      // Wait for expiry
      await new Promise(r => setTimeout(r, 10));

      const list = invitationManager.list();
      expect(list.length).toBe(5);

      const statuses = Object.fromEntries(list.map(i => [i.label, i.status]));
      expect(statuses['valid']).toBe('valid');
      expect(statuses['expired']).toBe('expired');
      expect(statuses['revoked']).toBe('revoked');
      expect(statuses['used']).toBe('exhausted');
      expect(statuses['multi']).toBe('valid');
    });
  });

  // ── 14. Invitation Manager Secret Persistence ─────────────────

  describe('Invitation manager secret persistence', () => {
    it('tokens survive InvitationManager recreation on same stateDir', async () => {
      // Phase 1: Create a token with first manager
      const invMgr1 = new InvitationManager({ stateDir });
      const token = invMgr1.create({ label: 'survive-restart', maxUses: 2 });

      // Consume once
      const consumeResult1 = invMgr1.consume(token, 'agent-before-restart');
      expect(consumeResult1.status).toBe('valid');

      // Phase 2: Recreate manager on same dir
      const invMgr2 = new InvitationManager({ stateDir });
      const trustManager = new AgentTrustManager({ stateDir });

      const bootstrap = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager,
        invitationManager: invMgr2,
      });

      // Token still works (1 use remaining)
      const result = await bootstrap.verify('agent-after-restart', { invitationToken: token });
      expect(result.verified).toBe(true);

      // Third use fails
      const result3 = await bootstrap.verify('agent-too-late', { invitationToken: token });
      expect(result3.verified).toBe(false);
    });

    it('HMAC secret persists so old tokens remain valid', () => {
      const invMgr1 = new InvitationManager({ stateDir });
      const token = invMgr1.create({ label: 'hmac-persist' });

      // Validate with first manager
      const v1 = invMgr1.validate(token);
      expect(v1.status).toBe('valid');

      // Validate with second manager (same stateDir, reloads same secret)
      const invMgr2 = new InvitationManager({ stateDir });
      const v2 = invMgr2.validate(token);
      expect(v2.status).toBe('valid');
    });
  });

  // ── Trust Change Notifications ────────────────────────────────

  describe('Trust change notifications', () => {
    it('onTrustChange callback fires during bootstrap', async () => {
      const notifications: TrustChangeNotification[] = [];
      const trustManager = new AgentTrustManager({
        stateDir,
        onTrustChange: (n) => notifications.push(n),
      });
      const invitationManager = new InvitationManager({ stateDir });
      const token = invitationManager.create();

      const bootstrap = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager,
        invitationManager,
      });

      await bootstrap.verify('notified-agent', { invitationToken: token });

      // setTrustLevel with 'paired-machine-granted' successfully upgrades to verified,
      // so trust change notification fires during bootstrap.
      expect(notifications.length).toBeGreaterThan(0);
      const relevant = notifications.find(n => n.agent === 'notified-agent');
      expect(relevant).toBeDefined();
      expect(relevant!.newLevel).toBe('verified');
    });
  });

  // ── Mixed Strategy Scenarios ──────────────────────────────────

  describe('Mixed strategy scenarios', () => {
    it('same trust manager used across different bootstrap strategies', async () => {
      const trustManager = new AgentTrustManager({ stateDir });
      const invitationManager = new InvitationManager({ stateDir });
      const keyPair = generateIdentityKeyPair();
      const fingerprint = makeFingerprint(keyPair.publicKey);

      const dnsVerifier = new DNSVerifier({
        resolver: makeDnsResolver({
          '_threadline.mixed.com': [[`threadline-agent=v1 fp=${fingerprint}`]],
        }),
      });

      // Open bootstrap
      const openBS = new TrustBootstrap({ strategy: 'open', stateDir, trustManager });
      await openBS.verify('open-peer', {});

      // Invitation bootstrap
      const token = invitationManager.create();
      const invBS = new TrustBootstrap({
        strategy: 'invitation-only',
        stateDir,
        trustManager,
        invitationManager,
      });
      await invBS.verify('invited-peer', { invitationToken: token });

      // DNS bootstrap
      const dnsBS = new TrustBootstrap({
        strategy: 'domain-verified',
        stateDir,
        trustManager,
        dnsVerifier,
      });
      await dnsBS.verify('dns-peer', { domain: 'mixed.com', fingerprint });

      // All three agents exist with correct levels
      expect(trustManager.getProfile('open-peer')!.level).toBe('untrusted');
      // Invitation and DNS bootstrap upgrade to verified (paired-machine-granted can upgrade)
      expect(trustManager.getProfile('invited-peer')!.level).toBe('verified');
      expect(trustManager.getProfile('dns-peer')!.level).toBe('verified');

      // Trust manager lists all
      const allProfiles = trustManager.listProfiles();
      expect(allProfiles.length).toBe(3);
    });
  });

  // ── Directory Non-200 Status ──────────────────────────────────

  describe('Directory non-200 status codes', () => {
    it('handles 500 error from directory gracefully', async () => {
      const fingerprint = crypto.randomBytes(32).toString('hex');
      const fetcher: HttpFetcher = async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: 'internal server error' }),
      });

      const trustManager = new AgentTrustManager({ stateDir });
      const bootstrap = new TrustBootstrap({
        strategy: 'directory-verified',
        stateDir,
        trustManager,
        directoryUrl: 'https://directory.example.com',
        fetcher,
      });

      const result = await bootstrap.verify('server-error-agent', { fingerprint });
      expect(result.verified).toBe(false);
      expect(result.reason).toContain('500');
    });
  });

  // ── DNS Error Codes ───────────────────────────────────────────

  describe('DNS error codes', () => {
    it('handles ENOTFOUND gracefully', async () => {
      const dnsVerifier = new DNSVerifier({
        resolver: makeDnsResolver({}),  // empty => ENOTFOUND
      });

      const trustManager = new AgentTrustManager({ stateDir });
      const bootstrap = new TrustBootstrap({
        strategy: 'domain-verified',
        stateDir,
        trustManager,
        dnsVerifier,
      });

      const result = await bootstrap.verify('no-dns-agent', {
        domain: 'nonexistent.example.com',
        fingerprint: crypto.randomBytes(32).toString('hex'),
      });

      expect(result.verified).toBe(false);
      expect(result.reason).toContain('ENOTFOUND');
    });

    it('handles ETIMEOUT gracefully', async () => {
      const dnsVerifier = new DNSVerifier({
        resolver: async () => {
          const err = new Error('DNS timeout') as NodeJS.ErrnoException;
          err.code = 'ETIMEOUT';
          throw err;
        },
      });

      const trustManager = new AgentTrustManager({ stateDir });
      const bootstrap = new TrustBootstrap({
        strategy: 'domain-verified',
        stateDir,
        trustManager,
        dnsVerifier,
      });

      const result = await bootstrap.verify('timeout-agent', {
        domain: 'slow.example.com',
        fingerprint: crypto.randomBytes(32).toString('hex'),
      });

      expect(result.verified).toBe(false);
      expect(result.reason).toContain('timed out');
    });
  });
});
