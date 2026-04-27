/**
 * Unit tests for TrustBootstrap — trust verification strategies for internet agent discovery.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TrustBootstrap } from '../../../src/threadline/TrustBootstrap.js';
import { InvitationManager } from '../../../src/threadline/InvitationManager.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import { DNSVerifier } from '../../../src/threadline/DNSVerifier.js';
import type { HttpFetcher } from '../../../src/threadline/AgentDiscovery.js';
import type { DNSResolverFn } from '../../../src/threadline/DNSVerifier.js';
import type { BootstrapEvidence } from '../../../src/threadline/TrustBootstrap.js';

// ── Helpers ──────────────────────────────────────────────────────────

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-bootstrap-test-'));
  tmpDirs.push(dir);
  return dir;
}

/** Create a mock HttpFetcher that returns a canned response */
function mockFetcher(response: { ok: boolean; status: number; body: unknown }): HttpFetcher {
  return async (_url, _options) => ({
    ok: response.ok,
    status: response.status,
    json: async () => response.body,
  });
}

/** Create a mock HttpFetcher that throws a network error */
function throwingFetcher(error: Error): HttpFetcher {
  return async () => {
    throw error;
  };
}

/** Create a mock DNS resolver */
function mockResolver(records: string[][]): DNSResolverFn {
  return async (_hostname: string) => records;
}

/** Create a mock DNS resolver that throws */
function throwingResolver(code: string): DNSResolverFn {
  return async () => {
    const err = new Error(`DNS error`) as NodeJS.ErrnoException;
    err.code = code;
    throw err;
  };
}

// ── Lifecycle ────────────────────────────────────────────────────────

afterEach(() => {
  for (const dir of tmpDirs) {
    // safe-git-allow: incremental-migration
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

// ══════════════════════════════════════════════════════════════════════
// 1. Constructor Validation
// ══════════════════════════════════════════════════════════════════════

describe('TrustBootstrap — constructor validation', () => {
  it('throws when directory-verified has no directoryUrl', () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    expect(() => new TrustBootstrap({
      strategy: 'directory-verified',
      stateDir,
      trustManager,
    })).toThrow('directoryUrl');
  });

  it('throws when domain-verified has no dnsVerifier', () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    expect(() => new TrustBootstrap({
      strategy: 'domain-verified',
      stateDir,
      trustManager,
    })).toThrow('dnsVerifier');
  });

  it('throws when invitation-only has no invitationManager', () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    expect(() => new TrustBootstrap({
      strategy: 'invitation-only',
      stateDir,
      trustManager,
    })).toThrow('invitationManager');
  });

  it('open strategy works with no extras', () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const bootstrap = new TrustBootstrap({
      strategy: 'open',
      stateDir,
      trustManager,
    });
    expect(bootstrap.getStrategy()).toBe('open');
  });

  it('directory-verified accepts valid config', () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const bootstrap = new TrustBootstrap({
      strategy: 'directory-verified',
      stateDir,
      trustManager,
      directoryUrl: 'https://directory.example.com',
      fetcher: mockFetcher({ ok: true, status: 200, body: {} }),
    });
    expect(bootstrap.getStrategy()).toBe('directory-verified');
  });

  it('domain-verified accepts valid config', () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const dnsVerifier = new DNSVerifier({ resolver: mockResolver([]) });
    const bootstrap = new TrustBootstrap({
      strategy: 'domain-verified',
      stateDir,
      trustManager,
      dnsVerifier,
    });
    expect(bootstrap.getStrategy()).toBe('domain-verified');
  });

  it('invitation-only accepts valid config', () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const invitationManager = new InvitationManager({ stateDir });
    const bootstrap = new TrustBootstrap({
      strategy: 'invitation-only',
      stateDir,
      trustManager,
      invitationManager,
    });
    expect(bootstrap.getStrategy()).toBe('invitation-only');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. getStrategy
// ══════════════════════════════════════════════════════════════════════

describe('TrustBootstrap — getStrategy', () => {
  it('returns directory-verified', () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const bootstrap = new TrustBootstrap({
      strategy: 'directory-verified',
      stateDir,
      trustManager,
      directoryUrl: 'https://dir.example.com',
      fetcher: mockFetcher({ ok: true, status: 200, body: {} }),
    });
    expect(bootstrap.getStrategy()).toBe('directory-verified');
  });

  it('returns domain-verified', () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const bootstrap = new TrustBootstrap({
      strategy: 'domain-verified',
      stateDir,
      trustManager,
      dnsVerifier: new DNSVerifier({ resolver: mockResolver([]) }),
    });
    expect(bootstrap.getStrategy()).toBe('domain-verified');
  });

  it('returns invitation-only', () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const bootstrap = new TrustBootstrap({
      strategy: 'invitation-only',
      stateDir,
      trustManager,
      invitationManager: new InvitationManager({ stateDir }),
    });
    expect(bootstrap.getStrategy()).toBe('invitation-only');
  });

  it('returns open', () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const bootstrap = new TrustBootstrap({
      strategy: 'open',
      stateDir,
      trustManager,
    });
    expect(bootstrap.getStrategy()).toBe('open');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3. Directory-verified Strategy
// ══════════════════════════════════════════════════════════════════════

describe('TrustBootstrap — directory-verified', () => {
  const fingerprint = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
  const publicKey = 'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344';

  function makeDirectoryBootstrap(fetcher: HttpFetcher): TrustBootstrap {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    return new TrustBootstrap({
      strategy: 'directory-verified',
      stateDir,
      trustManager,
      directoryUrl: 'https://directory.example.com',
      fetcher,
    });
  }

  it('succeeds when directory returns verified agent', async () => {
    const bootstrap = makeDirectoryBootstrap(mockFetcher({
      ok: true,
      status: 200,
      body: {
        verified: true,
        agentName: 'TestAgent',
        publicKey,
        verifiedAt: '2026-01-01T00:00:00Z',
      },
    }));

    const result = await bootstrap.verify('test-agent', { fingerprint, publicKey });
    expect(result.verified).toBe(true);
    expect(result.trustLevel).toBe('verified');
    expect(result.reason).toContain('TestAgent');
    expect(result.metadata?.agentName).toBe('TestAgent');
    expect(result.metadata?.verifiedAt).toBe('2026-01-01T00:00:00Z');
    expect(result.metadata?.directoryUrl).toBe('https://directory.example.com');
  });

  it('succeeds without public key in evidence (fingerprint only)', async () => {
    const bootstrap = makeDirectoryBootstrap(mockFetcher({
      ok: true,
      status: 200,
      body: {
        verified: true,
        agentName: 'FingerprintOnly',
        publicKey,
        verifiedAt: '2026-02-01T00:00:00Z',
      },
    }));

    const result = await bootstrap.verify('test-agent', { fingerprint });
    expect(result.verified).toBe(true);
    expect(result.trustLevel).toBe('verified');
  });

  it('fails when fingerprint is missing in evidence', async () => {
    const bootstrap = makeDirectoryBootstrap(mockFetcher({
      ok: true,
      status: 200,
      body: {},
    }));

    const result = await bootstrap.verify('test-agent', {});
    expect(result.verified).toBe(false);
    expect(result.trustLevel).toBe('untrusted');
    expect(result.reason).toContain('fingerprint');
  });

  it('fails when directory returns 404', async () => {
    const bootstrap = makeDirectoryBootstrap(mockFetcher({
      ok: false,
      status: 404,
      body: {},
    }));

    const result = await bootstrap.verify('test-agent', { fingerprint });
    expect(result.verified).toBe(false);
    expect(result.trustLevel).toBe('untrusted');
    expect(result.reason).toContain('not found');
    expect(result.reason).toContain(fingerprint);
  });

  it('fails when directory returns non-200 status (500)', async () => {
    const bootstrap = makeDirectoryBootstrap(mockFetcher({
      ok: false,
      status: 500,
      body: {},
    }));

    const result = await bootstrap.verify('test-agent', { fingerprint });
    expect(result.verified).toBe(false);
    expect(result.trustLevel).toBe('untrusted');
    expect(result.reason).toContain('500');
  });

  it('fails when directory returns non-200 status (403)', async () => {
    const bootstrap = makeDirectoryBootstrap(mockFetcher({
      ok: false,
      status: 403,
      body: {},
    }));

    const result = await bootstrap.verify('test-agent', { fingerprint });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('403');
  });

  it('fails when directory says agent is not verified', async () => {
    const bootstrap = makeDirectoryBootstrap(mockFetcher({
      ok: true,
      status: 200,
      body: {
        verified: false,
        agentName: 'BadAgent',
        publicKey,
        verifiedAt: null,
      },
    }));

    const result = await bootstrap.verify('test-agent', { fingerprint });
    expect(result.verified).toBe(false);
    expect(result.trustLevel).toBe('untrusted');
    expect(result.reason).toContain('not verified');
  });

  it('fails when public key in evidence mismatches directory record', async () => {
    const differentKey = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    const bootstrap = makeDirectoryBootstrap(mockFetcher({
      ok: true,
      status: 200,
      body: {
        verified: true,
        agentName: 'TestAgent',
        publicKey,
        verifiedAt: '2026-01-01T00:00:00Z',
      },
    }));

    const result = await bootstrap.verify('test-agent', {
      fingerprint,
      publicKey: differentKey,
    });
    expect(result.verified).toBe(false);
    expect(result.trustLevel).toBe('untrusted');
    expect(result.reason).toContain('does not match');
  });

  it('succeeds when public keys match case-insensitively', async () => {
    const bootstrap = makeDirectoryBootstrap(mockFetcher({
      ok: true,
      status: 200,
      body: {
        verified: true,
        agentName: 'TestAgent',
        publicKey: publicKey.toUpperCase(),
        verifiedAt: '2026-01-01T00:00:00Z',
      },
    }));

    const result = await bootstrap.verify('test-agent', {
      fingerprint,
      publicKey: publicKey.toLowerCase(),
    });
    expect(result.verified).toBe(true);
  });

  it('fails on network error (fetcher throws)', async () => {
    const bootstrap = makeDirectoryBootstrap(
      throwingFetcher(new Error('ECONNREFUSED'))
    );

    const result = await bootstrap.verify('test-agent', { fingerprint });
    expect(result.verified).toBe(false);
    expect(result.trustLevel).toBe('untrusted');
    expect(result.reason).toContain('ECONNREFUSED');
  });

  it('fails on timeout error', async () => {
    const bootstrap = makeDirectoryBootstrap(
      throwingFetcher(new Error('The operation was aborted'))
    );

    const result = await bootstrap.verify('test-agent', { fingerprint });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('aborted');
  });

  it('calls setTrustLevel on success', async () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const bootstrap = new TrustBootstrap({
      strategy: 'directory-verified',
      stateDir,
      trustManager,
      directoryUrl: 'https://directory.example.com',
      fetcher: mockFetcher({
        ok: true,
        status: 200,
        body: {
          verified: true,
          agentName: 'TestAgent',
          publicKey,
          verifiedAt: '2026-01-01T00:00:00Z',
        },
      }),
    });

    const result = await bootstrap.verify('dir-agent', { fingerprint, publicKey });
    expect(result.verified).toBe(true);
    expect(result.trustLevel).toBe('verified');
    // Profile should exist (created by getOrCreateProfile inside setTrustLevel)
    const profile = trustManager.getProfile('dir-agent');
    expect(profile).not.toBeNull();
  });

  it('constructs the correct lookup URL from directoryUrl', async () => {
    let calledUrl = '';
    const capturingFetcher: HttpFetcher = async (url) => {
      calledUrl = url;
      return { ok: true, status: 200, json: async () => ({
        verified: true, agentName: 'A', publicKey: 'aa', verifiedAt: 'now',
      }) };
    };

    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const bootstrap = new TrustBootstrap({
      strategy: 'directory-verified',
      stateDir,
      trustManager,
      directoryUrl: 'https://directory.example.com/',
      fetcher: capturingFetcher,
    });

    await bootstrap.verify('agent', { fingerprint: 'abc123' });
    expect(calledUrl).toBe('https://directory.example.com/agents/abc123');
  });

  it('strips trailing slashes from directoryUrl', async () => {
    let calledUrl = '';
    const capturingFetcher: HttpFetcher = async (url) => {
      calledUrl = url;
      return { ok: true, status: 200, json: async () => ({
        verified: true, agentName: 'A', publicKey: 'aa', verifiedAt: 'now',
      }) };
    };

    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const bootstrap = new TrustBootstrap({
      strategy: 'directory-verified',
      stateDir,
      trustManager,
      directoryUrl: 'https://directory.example.com///',
      fetcher: capturingFetcher,
    });

    await bootstrap.verify('agent', { fingerprint: 'xyz789' });
    expect(calledUrl).toBe('https://directory.example.com/agents/xyz789');
  });

  it('handles non-Error thrown from fetcher', async () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const bootstrap = new TrustBootstrap({
      strategy: 'directory-verified',
      stateDir,
      trustManager,
      directoryUrl: 'https://directory.example.com',
      fetcher: async () => { throw 'string-error'; },
    });

    const result = await bootstrap.verify('agent', { fingerprint });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('string-error');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 4. Domain-verified Strategy
// ══════════════════════════════════════════════════════════════════════

describe('TrustBootstrap — domain-verified', () => {
  const fingerprint = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
  const domain = 'example.com';

  function makeDNSBootstrap(resolver: DNSResolverFn): { bootstrap: TrustBootstrap; trustManager: AgentTrustManager } {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const dnsVerifier = new DNSVerifier({ resolver, cacheTtlMs: 0 });
    const bootstrap = new TrustBootstrap({
      strategy: 'domain-verified',
      stateDir,
      trustManager,
      dnsVerifier,
    });
    return { bootstrap, trustManager };
  }

  it('succeeds when DNS TXT record matches fingerprint', async () => {
    const { bootstrap } = makeDNSBootstrap(
      mockResolver([[`threadline-agent=v1 fp=${fingerprint}`]])
    );

    const result = await bootstrap.verify('dns-agent', { domain, fingerprint });
    expect(result.verified).toBe(true);
    expect(result.trustLevel).toBe('verified');
    expect(result.metadata?.domain).toBe(domain);
  });

  it('returns record in metadata on success', async () => {
    const record = `threadline-agent=v1 fp=${fingerprint}`;
    const { bootstrap } = makeDNSBootstrap(mockResolver([[record]]));

    const result = await bootstrap.verify('dns-agent', { domain, fingerprint });
    expect(result.verified).toBe(true);
    expect(result.metadata?.record).toBe(record);
  });

  it('fails when domain is missing in evidence', async () => {
    const { bootstrap } = makeDNSBootstrap(mockResolver([]));

    const result = await bootstrap.verify('dns-agent', { fingerprint });
    expect(result.verified).toBe(false);
    expect(result.trustLevel).toBe('untrusted');
    expect(result.reason).toContain('domain');
  });

  it('fails when fingerprint is missing in evidence', async () => {
    const { bootstrap } = makeDNSBootstrap(mockResolver([]));

    const result = await bootstrap.verify('dns-agent', { domain });
    expect(result.verified).toBe(false);
    expect(result.trustLevel).toBe('untrusted');
    expect(result.reason).toContain('fingerprint');
  });

  it('fails when DNS record does not match fingerprint', async () => {
    const differentFp = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    const { bootstrap } = makeDNSBootstrap(
      mockResolver([[`threadline-agent=v1 fp=${differentFp}`]])
    );

    const result = await bootstrap.verify('dns-agent', { domain, fingerprint });
    expect(result.verified).toBe(false);
    expect(result.trustLevel).toBe('untrusted');
    expect(result.reason).toContain('does not match');
  });

  it('fails when no threadline TXT record exists', async () => {
    const { bootstrap } = makeDNSBootstrap(
      mockResolver([['v=spf1 include:_spf.google.com ~all']])
    );

    const result = await bootstrap.verify('dns-agent', { domain, fingerprint });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('No Threadline TXT record');
  });

  it('fails when DNS lookup throws ENOTFOUND', async () => {
    const { bootstrap } = makeDNSBootstrap(throwingResolver('ENOTFOUND'));

    const result = await bootstrap.verify('dns-agent', { domain, fingerprint });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('ENOTFOUND');
  });

  it('fails when DNS lookup times out', async () => {
    const { bootstrap } = makeDNSBootstrap(throwingResolver('ETIMEOUT'));

    const result = await bootstrap.verify('dns-agent', { domain, fingerprint });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('ETIMEOUT');
  });

  it('calls setTrustLevel on success', async () => {
    const { bootstrap, trustManager } = makeDNSBootstrap(
      mockResolver([[`threadline-agent=v1 fp=${fingerprint}`]])
    );

    const result = await bootstrap.verify('dns-verified-agent', { domain, fingerprint });
    expect(result.verified).toBe(true);
    const profile = trustManager.getProfile('dns-verified-agent');
    expect(profile).not.toBeNull();
  });

  it('handles case-insensitive fingerprint matching', async () => {
    const upperFp = fingerprint.toUpperCase();
    const { bootstrap } = makeDNSBootstrap(
      mockResolver([[`threadline-agent=v1 fp=${fingerprint}`]])
    );

    const result = await bootstrap.verify('dns-agent', { domain, fingerprint: upperFp });
    expect(result.verified).toBe(true);
  });

  it('handles multiple TXT records with only one matching', async () => {
    const { bootstrap } = makeDNSBootstrap(
      mockResolver([
        ['v=spf1 include:_spf.google.com ~all'],
        [`threadline-agent=v1 fp=0000000000000000000000000000000000000000000000000000000000000000`],
        [`threadline-agent=v1 fp=${fingerprint}`],
      ])
    );

    const result = await bootstrap.verify('dns-agent', { domain, fingerprint });
    expect(result.verified).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 5. Invitation-only Strategy
// ══════════════════════════════════════════════════════════════════════

describe('TrustBootstrap — invitation-only', () => {
  function makeInvitationBootstrap(): {
    bootstrap: TrustBootstrap;
    invitationManager: InvitationManager;
    trustManager: AgentTrustManager;
  } {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const invitationManager = new InvitationManager({ stateDir });
    const bootstrap = new TrustBootstrap({
      strategy: 'invitation-only',
      stateDir,
      trustManager,
      invitationManager,
    });
    return { bootstrap, invitationManager, trustManager };
  }

  it('succeeds with valid invitation token', async () => {
    const { bootstrap, invitationManager } = makeInvitationBootstrap();
    const token = invitationManager.create({ label: 'test-invite' });

    const result = await bootstrap.verify('invited-agent', { invitationToken: token });
    expect(result.verified).toBe(true);
    expect(result.trustLevel).toBe('verified');
    expect(result.reason).toContain('invited-agent');
    expect(result.metadata?.invitationLabel).toBe('test-invite');
  });

  it('returns use count in metadata', async () => {
    const { bootstrap, invitationManager } = makeInvitationBootstrap();
    const token = invitationManager.create({ maxUses: 3 });

    const result = await bootstrap.verify('agent-1', { invitationToken: token });
    expect(result.verified).toBe(true);
    expect(result.metadata?.invitationUseCount).toBe(1);
    expect(result.metadata?.invitationMaxUses).toBe(3);
  });

  it('fails when invitation token is missing in evidence', async () => {
    const { bootstrap } = makeInvitationBootstrap();

    const result = await bootstrap.verify('agent', {});
    expect(result.verified).toBe(false);
    expect(result.trustLevel).toBe('untrusted');
    expect(result.reason).toContain('invitation token');
  });

  it('fails with invalid (nonexistent) token', async () => {
    const { bootstrap } = makeInvitationBootstrap();

    const result = await bootstrap.verify('agent', { invitationToken: 'bogus-token-1234' });
    expect(result.verified).toBe(false);
    expect(result.trustLevel).toBe('untrusted');
    expect(result.reason).toContain('invalid');
  });

  it('fails with expired token', async () => {
    const { bootstrap, invitationManager } = makeInvitationBootstrap();
    // Create with 1ms expiry — will be expired by the time verify runs
    const token = invitationManager.create({ expiresInMs: 1 });

    // Small delay to ensure expiry
    await new Promise(r => setTimeout(r, 10));

    const result = await bootstrap.verify('agent', { invitationToken: token });
    expect(result.verified).toBe(false);
    expect(result.trustLevel).toBe('untrusted');
    expect(result.reason).toContain('invalid');
  });

  it('fails with revoked token', async () => {
    const { bootstrap, invitationManager } = makeInvitationBootstrap();
    const token = invitationManager.create();
    invitationManager.revoke(token);

    const result = await bootstrap.verify('agent', { invitationToken: token });
    expect(result.verified).toBe(false);
    expect(result.trustLevel).toBe('untrusted');
    expect(result.reason).toContain('invalid');
  });

  it('single-use token: first agent succeeds', async () => {
    const { bootstrap, invitationManager } = makeInvitationBootstrap();
    const token = invitationManager.create({ maxUses: 1 });

    const result = await bootstrap.verify('first-agent', { invitationToken: token });
    expect(result.verified).toBe(true);
  });

  it('single-use token: second agent fails', async () => {
    const { bootstrap, invitationManager } = makeInvitationBootstrap();
    const token = invitationManager.create({ maxUses: 1 });

    await bootstrap.verify('first-agent', { invitationToken: token });
    const result = await bootstrap.verify('second-agent', { invitationToken: token });
    expect(result.verified).toBe(false);
    expect(result.trustLevel).toBe('untrusted');
  });

  it('multi-use token: multiple agents succeed within limit', async () => {
    const { bootstrap, invitationManager } = makeInvitationBootstrap();
    const token = invitationManager.create({ maxUses: 3 });

    const r1 = await bootstrap.verify('agent-1', { invitationToken: token });
    const r2 = await bootstrap.verify('agent-2', { invitationToken: token });
    const r3 = await bootstrap.verify('agent-3', { invitationToken: token });

    expect(r1.verified).toBe(true);
    expect(r2.verified).toBe(true);
    expect(r3.verified).toBe(true);
  });

  it('multi-use token: fails when limit exceeded', async () => {
    const { bootstrap, invitationManager } = makeInvitationBootstrap();
    const token = invitationManager.create({ maxUses: 2 });

    await bootstrap.verify('agent-1', { invitationToken: token });
    await bootstrap.verify('agent-2', { invitationToken: token });
    const r3 = await bootstrap.verify('agent-3', { invitationToken: token });

    expect(r3.verified).toBe(false);
  });

  it('unlimited token (maxUses: 0) allows many uses', async () => {
    const { bootstrap, invitationManager } = makeInvitationBootstrap();
    const token = invitationManager.create({ maxUses: 0 });

    for (let i = 0; i < 10; i++) {
      const result = await bootstrap.verify(`agent-${i}`, { invitationToken: token });
      expect(result.verified).toBe(true);
    }
  });

  it('calls setTrustLevel on success', async () => {
    const { bootstrap, invitationManager, trustManager } = makeInvitationBootstrap();
    const token = invitationManager.create();

    await bootstrap.verify('inv-agent', { invitationToken: token });
    const profile = trustManager.getProfile('inv-agent');
    expect(profile).not.toBeNull();
  });

  it('includes label in reason metadata', async () => {
    const { bootstrap, invitationManager } = makeInvitationBootstrap();
    const token = invitationManager.create({ label: 'beta-access' });

    const result = await bootstrap.verify('agent', { invitationToken: token });
    expect(result.metadata?.invitationLabel).toBe('beta-access');
  });

  it('handles token without label gracefully', async () => {
    const { bootstrap, invitationManager } = makeInvitationBootstrap();
    const token = invitationManager.create();

    const result = await bootstrap.verify('agent', { invitationToken: token });
    expect(result.verified).toBe(true);
    // label should be undefined, not throw
    expect(result.metadata?.invitationLabel).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════
// 6. Open Strategy
// ══════════════════════════════════════════════════════════════════════

describe('TrustBootstrap — open', () => {
  function makeOpenBootstrap(): { bootstrap: TrustBootstrap; trustManager: AgentTrustManager } {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const bootstrap = new TrustBootstrap({
      strategy: 'open',
      stateDir,
      trustManager,
    });
    return { bootstrap, trustManager };
  }

  it('always succeeds', async () => {
    const { bootstrap } = makeOpenBootstrap();
    const result = await bootstrap.verify('any-agent', {});
    expect(result.verified).toBe(true);
  });

  it('returns untrusted trust level', async () => {
    const { bootstrap } = makeOpenBootstrap();
    const result = await bootstrap.verify('any-agent', {});
    expect(result.trustLevel).toBe('untrusted');
  });

  it('creates trust profile via getOrCreateProfile', async () => {
    const { bootstrap, trustManager } = makeOpenBootstrap();

    expect(trustManager.getProfile('new-agent')).toBeNull();
    await bootstrap.verify('new-agent', {});
    const profile = trustManager.getProfile('new-agent');
    expect(profile).not.toBeNull();
    expect(profile!.level).toBe('untrusted');
  });

  it('passes through evidence metadata', async () => {
    const { bootstrap } = makeOpenBootstrap();
    const metadata = { purpose: 'testing', version: '1.0' };
    const result = await bootstrap.verify('agent', { metadata });
    expect(result.metadata).toEqual(metadata);
  });

  it('handles empty evidence', async () => {
    const { bootstrap } = makeOpenBootstrap();
    const result = await bootstrap.verify('agent', {});
    expect(result.verified).toBe(true);
    expect(result.metadata).toBeUndefined();
  });

  it('handles evidence with fingerprint (ignored in open)', async () => {
    const { bootstrap } = makeOpenBootstrap();
    const result = await bootstrap.verify('agent', {
      fingerprint: 'abc123',
      publicKey: 'def456',
    });
    expect(result.verified).toBe(true);
    expect(result.trustLevel).toBe('untrusted');
  });

  it('includes descriptive reason', async () => {
    const { bootstrap } = makeOpenBootstrap();
    const result = await bootstrap.verify('agent', {});
    expect(result.reason).toContain('Open bootstrap');
    expect(result.reason).toContain('untrusted');
  });

  it('idempotent — verifying same agent twice works', async () => {
    const { bootstrap, trustManager } = makeOpenBootstrap();

    await bootstrap.verify('agent', {});
    await bootstrap.verify('agent', {});

    const profile = trustManager.getProfile('agent');
    expect(profile).not.toBeNull();
    expect(profile!.level).toBe('untrusted');
  });

  it('different agents get separate profiles', async () => {
    const { bootstrap, trustManager } = makeOpenBootstrap();

    await bootstrap.verify('agent-a', { metadata: { id: 'a' } });
    await bootstrap.verify('agent-b', { metadata: { id: 'b' } });

    const profileA = trustManager.getProfile('agent-a');
    const profileB = trustManager.getProfile('agent-b');
    expect(profileA).not.toBeNull();
    expect(profileB).not.toBeNull();
    expect(profileA!.agent).toBe('agent-a');
    expect(profileB!.agent).toBe('agent-b');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 7. Integration Scenarios
// ══════════════════════════════════════════════════════════════════════

describe('TrustBootstrap — integration scenarios', () => {
  it('full invitation workflow: create → verify → consumed → second attempt fails', async () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const invitationManager = new InvitationManager({ stateDir });
    const bootstrap = new TrustBootstrap({
      strategy: 'invitation-only',
      stateDir,
      trustManager,
      invitationManager,
    });

    // Create invitation
    const token = invitationManager.create({ label: 'onboarding', maxUses: 1 });

    // Verify invitation is listed
    const listed = invitationManager.list();
    expect(listed.length).toBe(1);
    expect(listed[0].status).toBe('valid');

    // First agent verifies successfully
    const r1 = await bootstrap.verify('agent-alpha', { invitationToken: token });
    expect(r1.verified).toBe(true);
    expect(r1.trustLevel).toBe('verified');

    // Invitation is now exhausted
    const listedAfter = invitationManager.list();
    expect(listedAfter[0].status).toBe('exhausted');

    // Second agent fails
    const r2 = await bootstrap.verify('agent-beta', { invitationToken: token });
    expect(r2.verified).toBe(false);
  });

  it('trust profile persists after directory bootstrap', async () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const fingerprint = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222';
    const bootstrap = new TrustBootstrap({
      strategy: 'directory-verified',
      stateDir,
      trustManager,
      directoryUrl: 'https://dir.example.com',
      fetcher: mockFetcher({
        ok: true,
        status: 200,
        body: {
          verified: true,
          agentName: 'PersistAgent',
          publicKey: 'cafebabe',
          verifiedAt: '2026-03-01T00:00:00Z',
        },
      }),
    });

    await bootstrap.verify('persist-agent', { fingerprint });

    // Profile exists in trust manager
    const profile = trustManager.getProfile('persist-agent');
    expect(profile).not.toBeNull();
    expect(profile!.agent).toBe('persist-agent');
  });

  it('trust profile persists after DNS bootstrap', async () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const fingerprint = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222';
    const dnsVerifier = new DNSVerifier({
      resolver: mockResolver([[`threadline-agent=v1 fp=${fingerprint}`]]),
      cacheTtlMs: 0,
    });
    const bootstrap = new TrustBootstrap({
      strategy: 'domain-verified',
      stateDir,
      trustManager,
      dnsVerifier,
    });

    await bootstrap.verify('dns-persist', { domain: 'example.com', fingerprint });

    const profile = trustManager.getProfile('dns-persist');
    expect(profile).not.toBeNull();
  });

  it('trust profile persists after open bootstrap', async () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const bootstrap = new TrustBootstrap({
      strategy: 'open',
      stateDir,
      trustManager,
    });

    await bootstrap.verify('open-persist', {});

    const profile = trustManager.getProfile('open-persist');
    expect(profile).not.toBeNull();
    expect(profile!.level).toBe('untrusted');
  });

  it('invitation bootstrap profile survives trust manager reload', async () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const invitationManager = new InvitationManager({ stateDir });
    const bootstrap = new TrustBootstrap({
      strategy: 'invitation-only',
      stateDir,
      trustManager,
      invitationManager,
    });

    const token = invitationManager.create();
    await bootstrap.verify('reload-agent', { invitationToken: token });

    // Reload trust manager from disk
    trustManager.reload();
    const profile = trustManager.getProfile('reload-agent');
    expect(profile).not.toBeNull();
  });

  it('open bootstrap profile survives trust manager reload', async () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const bootstrap = new TrustBootstrap({
      strategy: 'open',
      stateDir,
      trustManager,
    });

    await bootstrap.verify('reload-open', { metadata: { key: 'value' } });

    trustManager.reload();
    const profile = trustManager.getProfile('reload-open');
    expect(profile).not.toBeNull();
    expect(profile!.level).toBe('untrusted');
  });

  it('multiple bootstrap instances share same stateDir', async () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const invitationManager = new InvitationManager({ stateDir });

    const openBootstrap = new TrustBootstrap({
      strategy: 'open',
      stateDir,
      trustManager,
    });

    const invBootstrap = new TrustBootstrap({
      strategy: 'invitation-only',
      stateDir,
      trustManager,
      invitationManager,
    });

    await openBootstrap.verify('open-agent', {});
    const token = invitationManager.create();
    await invBootstrap.verify('inv-agent', { invitationToken: token });

    expect(trustManager.getProfile('open-agent')).not.toBeNull();
    expect(trustManager.getProfile('inv-agent')).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════
// 8. Edge Cases
// ══════════════════════════════════════════════════════════════════════

describe('TrustBootstrap — edge cases', () => {
  it('unknown strategy returns error result', async () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    // Force an unknown strategy by casting
    const bootstrap = new TrustBootstrap({
      strategy: 'open',
      stateDir,
      trustManager,
    });
    // Mutate the private config to inject unknown strategy
    (bootstrap as any).config.strategy = 'unknown-strategy';

    const result = await bootstrap.verify('agent', {});
    expect(result.verified).toBe(false);
    expect(result.trustLevel).toBe('untrusted');
    expect(result.reason).toContain('Unknown bootstrap strategy');
    expect(result.reason).toContain('unknown-strategy');
  });

  it('empty evidence object handled by each strategy', async () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });

    // directory-verified with empty evidence
    const dirBootstrap = new TrustBootstrap({
      strategy: 'directory-verified',
      stateDir,
      trustManager,
      directoryUrl: 'https://dir.example.com',
      fetcher: mockFetcher({ ok: true, status: 200, body: {} }),
    });
    const dirResult = await dirBootstrap.verify('agent', {});
    expect(dirResult.verified).toBe(false);

    // domain-verified with empty evidence
    const dnsBootstrap = new TrustBootstrap({
      strategy: 'domain-verified',
      stateDir,
      trustManager,
      dnsVerifier: new DNSVerifier({ resolver: mockResolver([]) }),
    });
    const dnsResult = await dnsBootstrap.verify('agent', {});
    expect(dnsResult.verified).toBe(false);

    // invitation-only with empty evidence
    const invBootstrap = new TrustBootstrap({
      strategy: 'invitation-only',
      stateDir,
      trustManager,
      invitationManager: new InvitationManager({ stateDir }),
    });
    const invResult = await invBootstrap.verify('agent', {});
    expect(invResult.verified).toBe(false);

    // open with empty evidence
    const openBootstrap = new TrustBootstrap({
      strategy: 'open',
      stateDir,
      trustManager,
    });
    const openResult = await openBootstrap.verify('agent', {});
    expect(openResult.verified).toBe(true);
  });

  it('verify is async — returns a promise', () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const bootstrap = new TrustBootstrap({
      strategy: 'open',
      stateDir,
      trustManager,
    });

    const result = bootstrap.verify('agent', {});
    expect(result).toBeInstanceOf(Promise);
  });

  it('agent identity with special characters works', async () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const bootstrap = new TrustBootstrap({
      strategy: 'open',
      stateDir,
      trustManager,
    });

    const result = await bootstrap.verify('agent with spaces & symbols!@#', {});
    expect(result.verified).toBe(true);
    const profile = trustManager.getProfile('agent with spaces & symbols!@#');
    expect(profile).not.toBeNull();
  });

  it('empty agent identity string works', async () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const bootstrap = new TrustBootstrap({
      strategy: 'open',
      stateDir,
      trustManager,
    });

    const result = await bootstrap.verify('', {});
    expect(result.verified).toBe(true);
  });

  it('directory-verified with empty fingerprint string fails gracefully', async () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const bootstrap = new TrustBootstrap({
      strategy: 'directory-verified',
      stateDir,
      trustManager,
      directoryUrl: 'https://dir.example.com',
      fetcher: mockFetcher({ ok: true, status: 200, body: {} }),
    });

    // Empty string is falsy, so it should hit the "missing fingerprint" check
    const result = await bootstrap.verify('agent', { fingerprint: '' });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('fingerprint');
  });

  it('domain-verified with empty domain string fails gracefully', async () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const bootstrap = new TrustBootstrap({
      strategy: 'domain-verified',
      stateDir,
      trustManager,
      dnsVerifier: new DNSVerifier({ resolver: mockResolver([]) }),
    });

    const result = await bootstrap.verify('agent', { domain: '', fingerprint: 'abc' });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('domain');
  });

  it('invitation-only with empty token string fails gracefully', async () => {
    const stateDir = makeTmpDir();
    const trustManager = new AgentTrustManager({ stateDir });
    const bootstrap = new TrustBootstrap({
      strategy: 'invitation-only',
      stateDir,
      trustManager,
      invitationManager: new InvitationManager({ stateDir }),
    });

    const result = await bootstrap.verify('agent', { invitationToken: '' });
    expect(result.verified).toBe(false);
  });
});
