/**
 * Tests for CredentialProvider — cross-platform credential abstraction.
 *
 * Tests the actual ClaudeConfigCredentialProvider (file-based) with real
 * file system operations in temp directories. KeychainCredentialProvider
 * is tested structurally (constructor, platform, securityLevel) since
 * the macOS `security` CLI is not available in CI.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ClaudeConfigCredentialProvider,
  KeychainCredentialProvider,
  createDefaultProvider,
  redactToken,
  redactEmail,
} from '../../src/monitoring/CredentialProvider.js';
import type { ClaudeCredentials, CredentialProvider } from '../../src/monitoring/CredentialProvider.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Token Redaction ─────────────────────────────────────────────────

describe('redactToken', () => {
  it('redacts a normal token showing first 4 chars', () => {
    expect(redactToken('sk-ant-api03-abc123def456')).toBe('[TOKEN:sk-a****]');
  });

  it('handles short tokens', () => {
    expect(redactToken('abc')).toBe('[TOKEN:****]');
  });

  it('handles empty string', () => {
    expect(redactToken('')).toBe('[TOKEN:****]');
  });

  it('handles exactly 4-char token', () => {
    expect(redactToken('abcd')).toBe('[TOKEN:abcd****]');
  });
});

describe('redactEmail', () => {
  it('redacts a normal email', () => {
    expect(redactEmail('justin@sagemindai.io')).toBe('[EMAIL:j***@***.io]');
  });

  it('handles empty string', () => {
    expect(redactEmail('')).toBe('[EMAIL:****]');
  });

  it('handles string without @', () => {
    expect(redactEmail('notanemail')).toBe('[EMAIL:****]');
  });

  it('handles email with subdomain', () => {
    const result = redactEmail('user@mail.example.com');
    expect(result).toBe('[EMAIL:u***@***.com]');
  });
});

// ── ClaudeConfigCredentialProvider ───────────────────────────────────

describe('ClaudeConfigCredentialProvider', () => {
  let tmpDir: string;
  let provider: ClaudeConfigCredentialProvider;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-test-'));
    provider = new ClaudeConfigCredentialProvider(tmpDir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('has correct platform and security level', () => {
    expect(provider.platform).toBe(process.platform);
    expect(provider.securityLevel).toBe('file-permission-only');
  });

  it('returns null when no credential file exists', async () => {
    const creds = await provider.readCredentials();
    expect(creds).toBeNull();
  });

  it('writes and reads credentials', async () => {
    const creds: ClaudeCredentials = {
      accessToken: 'test-token-abc123',
      expiresAt: Date.now() + 3600000,
      email: 'test@example.com',
    };

    await provider.writeCredentials(creds);
    const read = await provider.readCredentials();

    expect(read).not.toBeNull();
    expect(read!.accessToken).toBe('test-token-abc123');
    expect(read!.expiresAt).toBe(creds.expiresAt);
    expect(read!.email).toBe('test@example.com');
  });

  it('writes credentials with 0600 file permissions', async () => {
    const creds: ClaudeCredentials = {
      accessToken: 'test-token',
      expiresAt: Date.now() + 3600000,
    };

    await provider.writeCredentials(creds);

    const credPath = path.join(tmpDir, 'credentials.json');
    const stats = fs.statSync(credPath);
    // 0600 in octal = 384 in decimal, but stat mode includes file type bits
    // So we mask with 0o777 to get just permission bits
    const perms = stats.mode & 0o777;
    expect(perms).toBe(0o600);
  });

  it('creates config directory with 0700 permissions if missing', async () => {
    const nestedDir = path.join(tmpDir, 'nested', 'dir');
    const nestedProvider = new ClaudeConfigCredentialProvider(nestedDir);

    await nestedProvider.writeCredentials({
      accessToken: 'test',
      expiresAt: Date.now() + 3600000,
    });

    const stats = fs.statSync(nestedDir);
    const perms = stats.mode & 0o777;
    expect(perms).toBe(0o700);
  });

  it('overwrites existing credentials', async () => {
    await provider.writeCredentials({
      accessToken: 'old-token',
      expiresAt: Date.now() + 3600000,
      email: 'old@example.com',
    });

    await provider.writeCredentials({
      accessToken: 'new-token',
      expiresAt: Date.now() + 7200000,
      email: 'new@example.com',
    });

    const read = await provider.readCredentials();
    expect(read!.accessToken).toBe('new-token');
    expect(read!.email).toBe('new@example.com');
  });

  it('deletes credentials', async () => {
    await provider.writeCredentials({
      accessToken: 'doomed-token',
      expiresAt: Date.now() + 3600000,
    });

    expect(await provider.readCredentials()).not.toBeNull();

    await provider.deleteCredentials!('any@email.com');

    expect(await provider.readCredentials()).toBeNull();
  });

  it('deleteCredentials is safe when no file exists', async () => {
    // Should not throw
    await provider.deleteCredentials!('nonexistent@email.com');
  });

  it('reads credentials with claudeAiOauth nested format', async () => {
    const credPath = path.join(tmpDir, 'credentials.json');
    const nestedFormat = {
      claudeAiOauth: {
        accessToken: 'nested-token',
        expiresAt: 1234567890,
        email: 'nested@example.com',
      }
    };
    fs.writeFileSync(credPath, JSON.stringify(nestedFormat), { mode: 0o600 });

    const read = await provider.readCredentials();
    expect(read).not.toBeNull();
    expect(read!.accessToken).toBe('nested-token');
    expect(read!.expiresAt).toBe(1234567890);
    expect(read!.email).toBe('nested@example.com');
  });

  it('returns null when credential file has no token', async () => {
    const credPath = path.join(tmpDir, 'credentials.json');
    fs.writeFileSync(credPath, JSON.stringify({ foo: 'bar' }), { mode: 0o600 });

    const read = await provider.readCredentials();
    expect(read).toBeNull();
  });

  it('returns null when credential file is malformed JSON', async () => {
    const credPath = path.join(tmpDir, 'credentials.json');
    fs.writeFileSync(credPath, 'not-json', { mode: 0o600 });

    const read = await provider.readCredentials();
    expect(read).toBeNull();
  });

  it('includes refreshToken when provided', async () => {
    await provider.writeCredentials({
      accessToken: 'token',
      expiresAt: Date.now() + 3600000,
      refreshToken: 'refresh-abc',
    });

    const read = await provider.readCredentials();
    expect(read!.refreshToken).toBe('refresh-abc');
  });

  it('omits refreshToken when not provided', async () => {
    await provider.writeCredentials({
      accessToken: 'token',
      expiresAt: Date.now() + 3600000,
    });

    const credPath = path.join(tmpDir, 'credentials.json');
    const raw = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    expect(raw.refreshToken).toBeUndefined();
  });
});

// ── KeychainCredentialProvider (structural tests) ───────────────────

describe('KeychainCredentialProvider', () => {
  it('has correct platform and security level', () => {
    const provider = new KeychainCredentialProvider();
    expect(provider.platform).toBe('darwin');
    expect(provider.securityLevel).toBe('os-encrypted');
  });

  // Note: readCredentials/writeCredentials require macOS Keychain
  // and are tested via integration tests only (gated by CI_HAS_KEYCHAIN env)
});

// ── createDefaultProvider ───────────────────────────────────────────

describe('createDefaultProvider', () => {
  it('returns a provider with valid interface', () => {
    const provider = createDefaultProvider();
    expect(provider).toBeDefined();
    expect(typeof provider.readCredentials).toBe('function');
    expect(typeof provider.writeCredentials).toBe('function');
    expect(typeof provider.platform).toBe('string');
    expect(['os-encrypted', 'file-permission-only']).toContain(provider.securityLevel);
  });

  it('returns KeychainCredentialProvider on macOS', () => {
    if (process.platform === 'darwin') {
      const provider = createDefaultProvider();
      expect(provider).toBeInstanceOf(KeychainCredentialProvider);
      expect(provider.securityLevel).toBe('os-encrypted');
    }
  });

  it('returns ClaudeConfigCredentialProvider on non-macOS', () => {
    if (process.platform !== 'darwin') {
      const provider = createDefaultProvider();
      expect(provider).toBeInstanceOf(ClaudeConfigCredentialProvider);
      expect(provider.securityLevel).toBe('file-permission-only');
    }
  });
});
