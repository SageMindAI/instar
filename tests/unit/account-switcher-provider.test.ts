/**
 * Integration tests for AccountSwitcher + CredentialProvider.
 *
 * Tests the actual AccountSwitcher with a real ClaudeConfigCredentialProvider
 * (file-based) to verify the full switchAccount flow works through the
 * provider abstraction. Uses temp directories and real file operations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AccountSwitcher } from '../../src/monitoring/AccountSwitcher.js';
import { ClaudeConfigCredentialProvider } from '../../src/monitoring/CredentialProvider.js';
import type { CredentialProvider, ClaudeCredentials } from '../../src/monitoring/CredentialProvider.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Test Helpers ────────────────────────────────────────────────────

function createRegistry(accounts: Record<string, {
  name: string | null;
  token?: string;
  expiresAt?: number;
  percentUsed?: number;
}>, activeEmail: string | null = null): object {
  const entries: Record<string, unknown> = {};
  for (const [email, info] of Object.entries(accounts)) {
    entries[email] = {
      email,
      name: info.name,
      rateLimitTier: 'max_5x',
      cachedOAuth: info.token ? {
        accessToken: info.token,
        expiresAt: info.expiresAt ?? Date.now() + 3600000,
      } : null,
      tokenCachedAt: info.token ? new Date().toISOString() : null,
      staleSince: null,
      lastQuotaSnapshot: info.percentUsed !== undefined ? {
        collectedAt: new Date().toISOString(),
        weeklyUtilization: info.percentUsed,
        fiveHourUtilization: 30,
        weeklyResetsAt: null,
        fiveHourResetsAt: null,
        sonnetUtilization: info.percentUsed,
        percentUsed: info.percentUsed,
        canRunPriority: 'all',
      } : null,
    };
  }
  return {
    schemaVersion: 1,
    accounts: entries,
    activeAccountEmail: activeEmail,
    lastUpdated: new Date().toISOString(),
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('AccountSwitcher with CredentialProvider', () => {
  let tmpDir: string;
  let registryPath: string;
  let credDir: string;
  let provider: ClaudeConfigCredentialProvider;
  let switcher: AccountSwitcher;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-test-'));
    registryPath = path.join(tmpDir, 'account-registry.json');
    credDir = path.join(tmpDir, 'claude-config');
    fs.mkdirSync(credDir, { recursive: true });
    provider = new ClaudeConfigCredentialProvider(credDir);
    switcher = new AccountSwitcher({ registryPath, provider });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exposes the provider via getProvider()', () => {
    expect(switcher.getProvider()).toBe(provider);
    expect(switcher.getProvider().securityLevel).toBe('file-permission-only');
  });

  it('returns error when registry does not exist', async () => {
    const result = await switcher.switchAccount('anyone');
    expect(result.success).toBe(false);
    expect(result.message).toContain('Account registry not found');
  });

  it('switches account and writes credentials through provider', async () => {
    const registry = createRegistry({
      'dawn@sagemindai.io': { name: 'Dawn', token: 'dawn-token-123' },
      'justin@sagemindai.io': { name: 'Justin', token: 'justin-token-456' },
    }, 'dawn@sagemindai.io');
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    const result = await switcher.switchAccount('justin');
    expect(result.success).toBe(true);
    expect(result.previousAccount).toBe('dawn@sagemindai.io');
    expect(result.newAccount).toBe('justin@sagemindai.io');

    // Verify credentials were written through the provider
    const creds = await provider.readCredentials();
    expect(creds).not.toBeNull();
    expect(creds!.accessToken).toBe('justin-token-456');
    expect(creds!.email).toBe('justin@sagemindai.io');
  });

  it('updates registry with new active account', async () => {
    const registry = createRegistry({
      'dawn@sagemindai.io': { name: 'Dawn', token: 'dawn-token' },
      'justin@sagemindai.io': { name: 'Justin', token: 'justin-token' },
    }, 'dawn@sagemindai.io');
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    await switcher.switchAccount('justin');

    const updatedRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    expect(updatedRegistry.activeAccountEmail).toBe('justin@sagemindai.io');
  });

  it('supports fuzzy matching by name prefix', async () => {
    const registry = createRegistry({
      'dawn@sagemindai.io': { name: 'Dawn', token: 'dawn-token' },
      'justin@sagemindai.io': { name: 'Justin', token: 'justin-token' },
    });
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    const result = await switcher.switchAccount('dawn');
    expect(result.success).toBe(true);
    expect(result.newAccount).toBe('dawn@sagemindai.io');
  });

  it('supports fuzzy matching by display name', async () => {
    const registry = createRegistry({
      'user1@example.com': { name: 'Dawn Machine', token: 'token-1' },
    });
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    const result = await switcher.switchAccount('dawn');
    expect(result.success).toBe(true);
    expect(result.newAccount).toBe('user1@example.com');
  });

  it('rejects switch when target has no token', async () => {
    const registry = createRegistry({
      'dawn@sagemindai.io': { name: 'Dawn', token: 'dawn-token' },
      'empty@example.com': { name: 'NoToken' },
    }, 'dawn@sagemindai.io');
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    const result = await switcher.switchAccount('empty@example.com');
    expect(result.success).toBe(false);
    expect(result.message).toContain('No cached token');
  });

  it('rejects switch when target token is expired', async () => {
    const registry = createRegistry({
      'dawn@sagemindai.io': { name: 'Dawn', token: 'dawn-token' },
      'expired@example.com': { name: 'Expired', token: 'expired-token', expiresAt: Date.now() - 1000 },
    }, 'dawn@sagemindai.io');
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    const result = await switcher.switchAccount('expired@example.com');
    expect(result.success).toBe(false);
    expect(result.message).toContain('expired');
  });

  it('returns success when switching to already-active account', async () => {
    const registry = createRegistry({
      'dawn@sagemindai.io': { name: 'Dawn', token: 'dawn-token' },
    }, 'dawn@sagemindai.io');
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    const result = await switcher.switchAccount('dawn');
    expect(result.success).toBe(true);
    expect(result.message).toContain('already the active');
  });

  it('returns error for unknown account', async () => {
    const registry = createRegistry({
      'dawn@sagemindai.io': { name: 'Dawn', token: 'dawn-token' },
    });
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    const result = await switcher.switchAccount('nonexistent');
    expect(result.success).toBe(false);
    expect(result.message).toContain('Unknown account');
    expect(result.message).toContain('Dawn');
  });

  // ── getAccountCredentials (for session-scoped use) ─────────────

  it('gets credentials for an account without switching globally', async () => {
    const registry = createRegistry({
      'dawn@sagemindai.io': { name: 'Dawn', token: 'dawn-token-abc' },
      'justin@sagemindai.io': { name: 'Justin', token: 'justin-token-xyz' },
    }, 'dawn@sagemindai.io');
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    const creds = switcher.getAccountCredentials('justin');
    expect(creds).not.toBeNull();
    expect(creds!.email).toBe('justin@sagemindai.io');
    expect(creds!.accessToken).toBe('justin-token-xyz');

    // Global state should NOT have changed
    const updatedRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    expect(updatedRegistry.activeAccountEmail).toBe('dawn@sagemindai.io');
  });

  it('returns null for account with no token', () => {
    const registry = createRegistry({
      'notoken@example.com': { name: 'NoToken' },
    });
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    expect(switcher.getAccountCredentials('notoken')).toBeNull();
  });

  it('returns null for expired account token', () => {
    const registry = createRegistry({
      'expired@example.com': { name: 'Expired', token: 'old', expiresAt: Date.now() - 1000 },
    });
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    expect(switcher.getAccountCredentials('expired')).toBeNull();
  });

  // ── getAccountStatuses ────────────────────────────────────────

  it('returns statuses for all accounts', () => {
    const registry = createRegistry({
      'active@example.com': { name: 'Active', token: 'token-a', percentUsed: 45 },
      'stale@example.com': { name: 'Stale', token: 'token-b', percentUsed: 90 },
    }, 'active@example.com');
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    const statuses = switcher.getAccountStatuses();
    expect(statuses).toHaveLength(2);

    const active = statuses.find(s => s.email === 'active@example.com');
    expect(active!.isActive).toBe(true);
    expect(active!.hasToken).toBe(true);
    expect(active!.weeklyPercent).toBe(45);

    const other = statuses.find(s => s.email === 'stale@example.com');
    expect(other!.isActive).toBe(false);
  });

  it('returns empty array when no registry exists', () => {
    expect(switcher.getAccountStatuses()).toEqual([]);
  });

  // ── Provider error handling ───────────────────────────────────

  it('handles provider write failure gracefully', async () => {
    // Create a provider that always fails to write
    const failingProvider: CredentialProvider = {
      platform: 'test',
      securityLevel: 'file-permission-only',
      readCredentials: async () => null,
      writeCredentials: async () => { throw new Error('Write failed'); },
    };

    const failSwitcher = new AccountSwitcher({ registryPath, provider: failingProvider });
    const registry = createRegistry({
      'target@example.com': { name: 'Target', token: 'token-123' },
    });
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    const result = await failSwitcher.switchAccount('target');
    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to write credentials');
    expect(result.message).toContain('Write failed');
  });
});
