/**
 * MCPAuth — Unit Tests
 *
 * Comprehensive tests for MCP token authentication:
 * - Token creation, validation, expiry, revocation, deletion
 * - Scope checking (including admin implies all)
 * - Persistence (save/reload)
 * - Edge cases (empty scopes, duplicate names, malformed tokens)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MCPAuth } from '../../../src/threadline/MCPAuth.js';
import type { MCPTokenScope } from '../../../src/threadline/MCPAuth.js';

// ── Helpers ──────────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-test-'));
}

function cleanupDir(dir: string): void {
  try {
    // safe-git-allow: incremental-migration
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('MCPAuth', () => {
  let stateDir: string;
  let auth: MCPAuth;

  beforeEach(() => {
    stateDir = createTempDir();
    auth = new MCPAuth(stateDir);
  });

  afterEach(() => {
    cleanupDir(stateDir);
  });

  // ── Construction ─────────────────────────────────────────────────

  describe('constructor', () => {
    it('creates threadline directory if it does not exist', () => {
      const dir = createTempDir();
      const newDir = path.join(dir, 'nested', 'state');
      try {
        new MCPAuth(newDir);
        expect(fs.existsSync(path.join(newDir, 'threadline'))).toBe(true);
      } finally {
        cleanupDir(dir);
      }
    });

    it('starts with no tokens', () => {
      expect(auth.listTokens()).toHaveLength(0);
    });

    it('loads existing tokens from disk on construction', () => {
      const result = auth.createToken('test', ['threadline:send']);

      // Create a new instance pointing to the same dir
      const auth2 = new MCPAuth(stateDir);
      const tokens = auth2.listTokens();
      expect(tokens).toHaveLength(1);
      expect(tokens[0].id).toBe(result.id);
    });
  });

  // ── Token Creation ───────────────────────────────────────────────

  describe('createToken', () => {
    it('creates a token with the given name and scopes', () => {
      const result = auth.createToken('my-client', ['threadline:send', 'threadline:read']);

      expect(result.id).toMatch(/^mcp_[0-9a-f]{16}$/);
      expect(result.name).toBe('my-client');
      expect(result.scopes).toEqual(['threadline:send', 'threadline:read']);
      expect(result.rawToken).toMatch(/^[0-9a-f]{64}$/);
      expect(result.createdAt).toBeTruthy();
      expect(result.expiresAt).toBeNull();
    });

    it('creates unique IDs and tokens for each call', () => {
      const r1 = auth.createToken('a', ['threadline:send']);
      const r2 = auth.createToken('b', ['threadline:send']);

      expect(r1.id).not.toBe(r2.id);
      expect(r1.rawToken).not.toBe(r2.rawToken);
    });

    it('supports expiring tokens', () => {
      const result = auth.createToken('expiring', ['threadline:read'], 3600);

      expect(result.expiresAt).toBeTruthy();
      const expiresAt = new Date(result.expiresAt!).getTime();
      const createdAt = new Date(result.createdAt).getTime();
      // Should expire roughly 3600 seconds in the future
      expect(expiresAt - createdAt).toBeGreaterThanOrEqual(3599_000);
      expect(expiresAt - createdAt).toBeLessThanOrEqual(3601_000);
    });

    it('creates tokens with empty scopes array', () => {
      const result = auth.createToken('no-scopes', []);
      expect(result.scopes).toEqual([]);
    });

    it('creates tokens with all scopes', () => {
      const allScopes: MCPTokenScope[] = [
        'threadline:send',
        'threadline:read',
        'threadline:discover',
        'threadline:admin',
      ];
      const result = auth.createToken('admin', allScopes);
      expect(result.scopes).toEqual(allScopes);
    });

    it('allows duplicate token names', () => {
      const r1 = auth.createToken('same-name', ['threadline:send']);
      const r2 = auth.createToken('same-name', ['threadline:read']);

      expect(r1.id).not.toBe(r2.id);
      expect(auth.listTokens()).toHaveLength(2);
    });

    it('persists token to disk immediately', () => {
      auth.createToken('persisted', ['threadline:send']);

      const filePath = path.join(stateDir, 'threadline', 'mcp-tokens.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(data.tokens).toHaveLength(1);
      expect(data.tokens[0].name).toBe('persisted');
      // Verify raw token is NOT stored
      expect(data.tokens[0].rawToken).toBeUndefined();
      expect(data.tokens[0].hashedToken).toBeTruthy();
    });
  });

  // ── Token Validation ─────────────────────────────────────────────

  describe('validateToken', () => {
    it('validates a valid token', () => {
      const result = auth.createToken('valid', ['threadline:send']);
      const info = auth.validateToken(result.rawToken);

      expect(info).not.toBeNull();
      expect(info!.id).toBe(result.id);
      expect(info!.name).toBe('valid');
      expect(info!.scopes).toEqual(['threadline:send']);
    });

    it('returns null for unknown token', () => {
      expect(auth.validateToken('deadbeef'.repeat(8))).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(auth.validateToken('')).toBeNull();
    });

    it('returns null for revoked token', () => {
      const result = auth.createToken('revokable', ['threadline:send']);
      auth.revokeToken(result.id);

      expect(auth.validateToken(result.rawToken)).toBeNull();
    });

    it('returns null for expired token', () => {
      // Create token that expires in 1 second
      const result = auth.createToken('expiring', ['threadline:read'], 0);
      // Token with 0 TTL should be expired immediately (or within ms)
      // Give it a moment then check
      expect(auth.validateToken(result.rawToken)).toBeNull();
    });

    it('validates non-expired token', () => {
      const result = auth.createToken('long-lived', ['threadline:read'], 86400);
      const info = auth.validateToken(result.rawToken);
      expect(info).not.toBeNull();
      expect(info!.id).toBe(result.id);
    });

    it('validates after reload from disk', () => {
      const result = auth.createToken('persistent', ['threadline:send']);

      // New instance, same state dir
      const auth2 = new MCPAuth(stateDir);
      const info = auth2.validateToken(result.rawToken);
      expect(info).not.toBeNull();
      expect(info!.id).toBe(result.id);
    });
  });

  // ── Scope Checking ───────────────────────────────────────────────

  describe('hasScope', () => {
    it('returns true for direct scope match', () => {
      const result = auth.createToken('scoped', ['threadline:send']);
      const info = auth.validateToken(result.rawToken)!;

      expect(auth.hasScope(info, 'threadline:send')).toBe(true);
    });

    it('returns false for scope not in token', () => {
      const result = auth.createToken('limited', ['threadline:send']);
      const info = auth.validateToken(result.rawToken)!;

      expect(auth.hasScope(info, 'threadline:read')).toBe(false);
      expect(auth.hasScope(info, 'threadline:discover')).toBe(false);
      expect(auth.hasScope(info, 'threadline:admin')).toBe(false);
    });

    it('admin scope implies all other scopes', () => {
      const result = auth.createToken('admin', ['threadline:admin']);
      const info = auth.validateToken(result.rawToken)!;

      expect(auth.hasScope(info, 'threadline:admin')).toBe(true);
      expect(auth.hasScope(info, 'threadline:send')).toBe(true);
      expect(auth.hasScope(info, 'threadline:read')).toBe(true);
      expect(auth.hasScope(info, 'threadline:discover')).toBe(true);
    });

    it('non-admin scopes do not imply each other', () => {
      const result = auth.createToken('send-only', ['threadline:send']);
      const info = auth.validateToken(result.rawToken)!;

      expect(auth.hasScope(info, 'threadline:read')).toBe(false);
      expect(auth.hasScope(info, 'threadline:discover')).toBe(false);
    });

    it('multiple non-admin scopes work independently', () => {
      const result = auth.createToken('multi', ['threadline:send', 'threadline:read']);
      const info = auth.validateToken(result.rawToken)!;

      expect(auth.hasScope(info, 'threadline:send')).toBe(true);
      expect(auth.hasScope(info, 'threadline:read')).toBe(true);
      expect(auth.hasScope(info, 'threadline:discover')).toBe(false);
    });

    it('empty scopes grants nothing', () => {
      const result = auth.createToken('empty', []);
      const info = auth.validateToken(result.rawToken)!;

      expect(auth.hasScope(info, 'threadline:send')).toBe(false);
      expect(auth.hasScope(info, 'threadline:read')).toBe(false);
      expect(auth.hasScope(info, 'threadline:discover')).toBe(false);
      expect(auth.hasScope(info, 'threadline:admin')).toBe(false);
    });
  });

  // ── Token Revocation ─────────────────────────────────────────────

  describe('revokeToken', () => {
    it('revokes an existing token', () => {
      const result = auth.createToken('to-revoke', ['threadline:send']);
      const revoked = auth.revokeToken(result.id);

      expect(revoked).toBe(true);
      expect(auth.validateToken(result.rawToken)).toBeNull();
    });

    it('returns false for unknown token ID', () => {
      expect(auth.revokeToken('mcp_nonexistent')).toBe(false);
    });

    it('returns false for already-revoked token', () => {
      const result = auth.createToken('double-revoke', ['threadline:send']);
      auth.revokeToken(result.id);
      expect(auth.revokeToken(result.id)).toBe(false);
    });

    it('revoked token persists in list (for audit)', () => {
      const result = auth.createToken('auditable', ['threadline:send']);
      auth.revokeToken(result.id);

      const tokens = auth.listTokens();
      expect(tokens).toHaveLength(1);
      expect(tokens[0].revoked).toBe(true);
    });

    it('persists revocation to disk', () => {
      const result = auth.createToken('persist-revoke', ['threadline:send']);
      auth.revokeToken(result.id);

      const auth2 = new MCPAuth(stateDir);
      expect(auth2.validateToken(result.rawToken)).toBeNull();

      const tokens = auth2.listTokens();
      expect(tokens[0].revoked).toBe(true);
    });
  });

  // ── Token Listing ────────────────────────────────────────────────

  describe('listTokens', () => {
    it('returns empty array when no tokens', () => {
      expect(auth.listTokens()).toEqual([]);
    });

    it('returns all tokens including revoked', () => {
      const r1 = auth.createToken('active', ['threadline:send']);
      const r2 = auth.createToken('revoked', ['threadline:read']);
      auth.revokeToken(r2.id);

      const tokens = auth.listTokens();
      expect(tokens).toHaveLength(2);
      expect(tokens.find(t => t.id === r1.id)!.revoked).toBe(false);
      expect(tokens.find(t => t.id === r2.id)!.revoked).toBe(true);
    });

    it('returns copies (not mutable references)', () => {
      auth.createToken('original', ['threadline:send']);
      const tokens = auth.listTokens();

      tokens[0].name = 'mutated';
      tokens[0].scopes.push('threadline:admin');

      const fresh = auth.listTokens();
      expect(fresh[0].name).toBe('original');
      expect(fresh[0].scopes).toEqual(['threadline:send']);
    });
  });

  // ── Token Deletion ───────────────────────────────────────────────

  describe('deleteToken', () => {
    it('permanently removes a token', () => {
      const result = auth.createToken('delete-me', ['threadline:send']);
      const deleted = auth.deleteToken(result.id);

      expect(deleted).toBe(true);
      expect(auth.listTokens()).toHaveLength(0);
      expect(auth.validateToken(result.rawToken)).toBeNull();
    });

    it('returns false for unknown token ID', () => {
      expect(auth.deleteToken('mcp_nonexistent')).toBe(false);
    });

    it('can delete a revoked token', () => {
      const result = auth.createToken('revoke-then-delete', ['threadline:send']);
      auth.revokeToken(result.id);
      const deleted = auth.deleteToken(result.id);

      expect(deleted).toBe(true);
      expect(auth.listTokens()).toHaveLength(0);
    });

    it('persists deletion to disk', () => {
      const result = auth.createToken('persist-delete', ['threadline:send']);
      auth.deleteToken(result.id);

      const auth2 = new MCPAuth(stateDir);
      expect(auth2.listTokens()).toHaveLength(0);
    });
  });

  // ── Reload ───────────────────────────────────────────────────────

  describe('reload', () => {
    it('reloads tokens from disk', () => {
      auth.createToken('before-reload', ['threadline:send']);

      // Externally modify the file
      const filePath = path.join(stateDir, 'threadline', 'mcp-tokens.json');
      fs.writeFileSync(filePath, JSON.stringify({ tokens: [], updatedAt: new Date().toISOString() }));

      // Before reload, in-memory still has the token
      expect(auth.listTokens()).toHaveLength(1);

      auth.reload();
      expect(auth.listTokens()).toHaveLength(0);
    });
  });

  // ── Concurrency / Edge Cases ─────────────────────────────────────

  describe('edge cases', () => {
    it('handles corrupted tokens file gracefully', () => {
      const filePath = path.join(stateDir, 'threadline', 'mcp-tokens.json');
      fs.writeFileSync(filePath, 'not valid json');

      const auth2 = new MCPAuth(stateDir);
      expect(auth2.listTokens()).toEqual([]);
    });

    it('handles missing tokens file gracefully', () => {
      const emptyDir = createTempDir();
      try {
        const auth2 = new MCPAuth(emptyDir);
        expect(auth2.listTokens()).toEqual([]);
      } finally {
        cleanupDir(emptyDir);
      }
    });

    it('creates many tokens without issues', () => {
      for (let i = 0; i < 50; i++) {
        auth.createToken(`token-${i}`, ['threadline:send']);
      }
      expect(auth.listTokens()).toHaveLength(50);
    });

    it('validates correct token among many', () => {
      const tokens = [];
      for (let i = 0; i < 20; i++) {
        tokens.push(auth.createToken(`token-${i}`, ['threadline:send']));
      }

      // Validate a token in the middle
      const target = tokens[10];
      const info = auth.validateToken(target.rawToken);
      expect(info).not.toBeNull();
      expect(info!.id).toBe(target.id);
    });
  });
});
