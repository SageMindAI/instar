/**
 * Integration test — CredentialProvider + AccountSwitcher + SessionCredentialManager
 * wired together with real file operations.
 *
 * Tests that the three Phase 1 components work together correctly:
 * - CredentialProvider reads/writes real credentials to disk
 * - AccountSwitcher delegates to the provider instead of Keychain
 * - SessionCredentialManager produces correct env isolation
 *
 * Uses real file system, real registry, real provider — no mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AccountSwitcher } from '../../src/monitoring/AccountSwitcher.js';
import { ClaudeConfigCredentialProvider } from '../../src/monitoring/CredentialProvider.js';
import { SessionCredentialManager } from '../../src/monitoring/SessionCredentialManager.js';
import type { ClaudeCredentials } from '../../src/monitoring/CredentialProvider.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Test Helpers ────────────────────────────────────────────────────

function writeRegistry(registryPath: string, accounts: Record<string, {
  name: string;
  token: string;
  expiresAt?: number;
  percentUsed?: number;
  fiveHourUtilization?: number;
}>, activeEmail: string | null = null): void {
  const entries: Record<string, unknown> = {};
  for (const [email, info] of Object.entries(accounts)) {
    entries[email] = {
      email,
      name: info.name,
      rateLimitTier: 'max_5x',
      cachedOAuth: {
        accessToken: info.token,
        expiresAt: info.expiresAt ?? Date.now() + 3600000,
      },
      tokenCachedAt: new Date().toISOString(),
      staleSince: null,
      lastQuotaSnapshot: {
        collectedAt: new Date().toISOString(),
        weeklyUtilization: info.percentUsed ?? 50,
        fiveHourUtilization: info.fiveHourUtilization ?? 30,
        weeklyResetsAt: new Date(Date.now() + 86400000).toISOString(),
        fiveHourResetsAt: new Date(Date.now() + 18000000).toISOString(),
        sonnetUtilization: info.percentUsed ?? 50,
        percentUsed: info.percentUsed ?? 50,
        canRunPriority: 'all',
      },
    };
  }
  fs.writeFileSync(registryPath, JSON.stringify({
    schemaVersion: 1,
    accounts: entries,
    activeAccountEmail: activeEmail,
    lastUpdated: new Date().toISOString(),
  }, null, 2), { mode: 0o600 });
}

// ── Tests ───────────────────────────────────────────────────────────

describe('Credential Switching (integration)', () => {
  let tmpDir: string;
  let registryPath: string;
  let credDir: string;
  let provider: ClaudeConfigCredentialProvider;
  let switcher: AccountSwitcher;
  let credManager: SessionCredentialManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-integ-'));
    registryPath = path.join(tmpDir, 'account-registry.json');
    credDir = path.join(tmpDir, 'claude-config');
    fs.mkdirSync(credDir, { recursive: true });

    provider = new ClaudeConfigCredentialProvider(credDir);
    switcher = new AccountSwitcher({ registryPath, provider });
    credManager = new SessionCredentialManager();
  });

  afterEach(() => {
    credManager.clear();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full flow: switch account via provider and verify file was written', async () => {
    writeRegistry(registryPath, {
      'dawn@sagemindai.io': { name: 'Dawn', token: 'dawn-token-abc' },
      'justin@sagemindai.io': { name: 'Justin', token: 'justin-token-xyz' },
    }, 'dawn@sagemindai.io');

    // Switch through the actual AccountSwitcher → CredentialProvider pipeline
    const result = await switcher.switchAccount('justin');
    expect(result.success).toBe(true);
    expect(result.newAccount).toBe('justin@sagemindai.io');

    // Verify the provider can now read back the credentials it wrote
    const creds = await provider.readCredentials();
    expect(creds).not.toBeNull();
    expect(creds!.accessToken).toBe('justin-token-xyz');
    expect(creds!.email).toBe('justin@sagemindai.io');

    // Verify the file was actually written to disk with correct permissions
    const credFile = path.join(credDir, 'credentials.json');
    expect(fs.existsSync(credFile)).toBe(true);
    const stats = fs.statSync(credFile);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('session-scoped credential isolation: two sessions, two accounts', async () => {
    writeRegistry(registryPath, {
      'dawn@sagemindai.io': { name: 'Dawn', token: 'dawn-token-aaa', percentUsed: 92 },
      'justin@sagemindai.io': { name: 'Justin', token: 'justin-token-bbb', percentUsed: 30 },
    }, 'dawn@sagemindai.io');

    // Get credentials for each account WITHOUT switching globally
    const dawnCreds = switcher.getAccountCredentials('dawn');
    const justinCreds = switcher.getAccountCredentials('justin');
    expect(dawnCreds).not.toBeNull();
    expect(justinCreds).not.toBeNull();

    // Assign different accounts to different sessions
    credManager.assignAccount('session-1', dawnCreds!.email, {
      accessToken: dawnCreds!.accessToken,
      expiresAt: dawnCreds!.expiresAt,
      email: dawnCreds!.email,
    });
    credManager.assignAccount('session-2', justinCreds!.email, {
      accessToken: justinCreds!.accessToken,
      expiresAt: justinCreds!.expiresAt,
      email: justinCreds!.email,
    });

    // Each session gets its own env
    const env1 = credManager.getSessionEnv('session-1');
    const env2 = credManager.getSessionEnv('session-2');
    expect(env1.ANTHROPIC_AUTH_TOKEN).toBe('dawn-token-aaa');
    expect(env2.ANTHROPIC_AUTH_TOKEN).toBe('justin-token-bbb');
    expect(env1.CLAUDE_ACCOUNT_EMAIL).toBe('dawn@sagemindai.io');
    expect(env2.CLAUDE_ACCOUNT_EMAIL).toBe('justin@sagemindai.io');

    // Verify the global registry was NOT modified
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    expect(registry.activeAccountEmail).toBe('dawn@sagemindai.io');
  });

  it('migration simulation: halt session-1, reassign to new account', async () => {
    writeRegistry(registryPath, {
      'dawn@sagemindai.io': { name: 'Dawn', token: 'dawn-token', percentUsed: 93 },
      'justin@sagemindai.io': { name: 'Justin', token: 'justin-token', percentUsed: 25 },
    }, 'dawn@sagemindai.io');

    // Step 1: Session is running on Dawn's account
    const dawnCreds = switcher.getAccountCredentials('dawn');
    credManager.assignAccount('session-1', dawnCreds!.email, {
      accessToken: dawnCreds!.accessToken,
      expiresAt: dawnCreds!.expiresAt,
      email: dawnCreds!.email,
    });

    expect(credManager.getSessionEnv('session-1').ANTHROPIC_AUTH_TOKEN).toBe('dawn-token');

    // Step 2: Migration triggered — Dawn at 93%, Justin at 25%
    // "Halt" the session (release credentials)
    credManager.releaseSession('session-1');
    expect(credManager.activeCount).toBe(0);

    // Step 3: Get Justin's credentials and reassign the session
    const justinCreds = switcher.getAccountCredentials('justin');
    credManager.assignAccount('session-1', justinCreds!.email, {
      accessToken: justinCreds!.accessToken,
      expiresAt: justinCreds!.expiresAt,
      email: justinCreds!.email,
    });

    // Step 4: Verify session is now on Justin's account
    expect(credManager.getSessionEnv('session-1').ANTHROPIC_AUTH_TOKEN).toBe('justin-token');
    expect(credManager.getSessionEnv('session-1').CLAUDE_ACCOUNT_EMAIL).toBe('justin@sagemindai.io');

    // Step 5: Global state untouched — Dawn is still the "active" account in registry
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    expect(registry.activeAccountEmail).toBe('dawn@sagemindai.io');
  });

  it('provider persistence: credentials survive AccountSwitcher restart', async () => {
    writeRegistry(registryPath, {
      'dawn@sagemindai.io': { name: 'Dawn', token: 'dawn-persistent-token' },
    }, null);

    // Switch account (writes to disk through provider)
    await switcher.switchAccount('dawn');

    // Create a NEW provider instance pointing to the same directory
    const provider2 = new ClaudeConfigCredentialProvider(credDir);
    const creds = await provider2.readCredentials();
    expect(creds).not.toBeNull();
    expect(creds!.accessToken).toBe('dawn-persistent-token');

    // Create a NEW AccountSwitcher — should work with persisted state
    const switcher2 = new AccountSwitcher({ registryPath, provider: provider2 });
    const statuses = switcher2.getAccountStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0].email).toBe('dawn@sagemindai.io');
    expect(statuses[0].isActive).toBe(true);
  });

  it('multi-session account tracking: tracks which sessions use each account', async () => {
    writeRegistry(registryPath, {
      'a@example.com': { name: 'Account A', token: 'token-a', percentUsed: 80 },
      'b@example.com': { name: 'Account B', token: 'token-b', percentUsed: 20 },
    }, 'a@example.com');

    const credsA = switcher.getAccountCredentials('a@example.com');
    const credsB = switcher.getAccountCredentials('b@example.com');

    // 3 sessions on account A, 1 on account B
    credManager.assignAccount('s1', credsA!.email, { accessToken: credsA!.accessToken, expiresAt: credsA!.expiresAt });
    credManager.assignAccount('s2', credsA!.email, { accessToken: credsA!.accessToken, expiresAt: credsA!.expiresAt });
    credManager.assignAccount('s3', credsA!.email, { accessToken: credsA!.accessToken, expiresAt: credsA!.expiresAt });
    credManager.assignAccount('s4', credsB!.email, { accessToken: credsB!.accessToken, expiresAt: credsB!.expiresAt });

    // Verify account distribution
    expect(credManager.getSessionsForAccount('a@example.com')).toHaveLength(3);
    expect(credManager.getSessionsForAccount('b@example.com')).toHaveLength(1);

    // Migrate s1 and s2 from A to B
    credManager.releaseSession('s1');
    credManager.releaseSession('s2');
    credManager.assignAccount('s1', credsB!.email, { accessToken: credsB!.accessToken, expiresAt: credsB!.expiresAt });
    credManager.assignAccount('s2', credsB!.email, { accessToken: credsB!.accessToken, expiresAt: credsB!.expiresAt });

    // Now 1 on A, 3 on B
    expect(credManager.getSessionsForAccount('a@example.com')).toHaveLength(1);
    expect(credManager.getSessionsForAccount('b@example.com')).toHaveLength(3);

    // All 4 sessions still have valid, isolated env
    expect(credManager.getSessionEnv('s1').ANTHROPIC_AUTH_TOKEN).toBe('token-b');
    expect(credManager.getSessionEnv('s2').ANTHROPIC_AUTH_TOKEN).toBe('token-b');
    expect(credManager.getSessionEnv('s3').ANTHROPIC_AUTH_TOKEN).toBe('token-a');
    expect(credManager.getSessionEnv('s4').ANTHROPIC_AUTH_TOKEN).toBe('token-b');
  });

  it('handles expired token during getAccountCredentials', async () => {
    writeRegistry(registryPath, {
      'valid@example.com': { name: 'Valid', token: 'valid-token', percentUsed: 30 },
      'expired@example.com': { name: 'Expired', token: 'old-token', expiresAt: Date.now() - 1000, percentUsed: 10 },
    }, 'valid@example.com');

    // Valid account works
    expect(switcher.getAccountCredentials('valid')).not.toBeNull();

    // Expired account returns null — cannot be used for session injection
    expect(switcher.getAccountCredentials('expired')).toBeNull();
  });

  it('credential file permissions are enforced throughout lifecycle', async () => {
    writeRegistry(registryPath, {
      'a@example.com': { name: 'A', token: 'token-a' },
      'b@example.com': { name: 'B', token: 'token-b' },
    }, null); // No active account — so first switch actually writes credentials

    // Switch to A — writes credentials
    await switcher.switchAccount('a');
    const credFile = path.join(credDir, 'credentials.json');
    expect(fs.statSync(credFile).mode & 0o777).toBe(0o600);

    // Switch to B — overwrites credentials
    await switcher.switchAccount('b');
    expect(fs.statSync(credFile).mode & 0o777).toBe(0o600);

    // Delete and recreate — still enforced
    await provider.deleteCredentials!('b@example.com');
    expect(fs.existsSync(credFile)).toBe(false);

    await provider.writeCredentials({ accessToken: 'new', expiresAt: Date.now() + 3600000 });
    expect(fs.statSync(credFile).mode & 0o777).toBe(0o600);
  });
});
