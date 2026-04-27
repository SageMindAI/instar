import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { InvitationManager } from '../../../src/threadline/InvitationManager.js';
import type { InvitationStatus } from '../../../src/threadline/InvitationManager.js';

describe('InvitationManager', () => {
  let tmpDir: string;
  let manager: InvitationManager;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `instar-invitation-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    manager = new InvitationManager({ stateDir: tmpDir });
  });

  afterEach(() => {
    vi.useRealTimers();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. Constructor ──────────────────────────────────────────────

  describe('constructor', () => {
    it('creates the threadline directory', () => {
      const threadlineDir = path.join(tmpDir, 'threadline');
      expect(fs.existsSync(threadlineDir)).toBe(true);
    });

    it('creates the secret key file', () => {
      const secretPath = path.join(tmpDir, 'threadline', 'invitation-secret.key');
      expect(fs.existsSync(secretPath)).toBe(true);
    });

    it('sets 0o600 permissions on the secret key file', () => {
      const secretPath = path.join(tmpDir, 'threadline', 'invitation-secret.key');
      const stat = fs.statSync(secretPath);
      // Mask to just owner/group/other permissions
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('generates a 32-byte secret', () => {
      const secretPath = path.join(tmpDir, 'threadline', 'invitation-secret.key');
      const secret = fs.readFileSync(secretPath);
      expect(secret.length).toBe(32);
    });

    it('reuses existing secret on subsequent instantiation', () => {
      const secretPath = path.join(tmpDir, 'threadline', 'invitation-secret.key');
      const secret1 = fs.readFileSync(secretPath);
      const manager2 = new InvitationManager({ stateDir: tmpDir });
      const secret2 = fs.readFileSync(secretPath);
      expect(Buffer.compare(secret1, secret2)).toBe(0);
      // Tokens created by both should be interchangeable
      const token = manager.create();
      expect(manager2.validate(token).status).toBe('not-found');
      // But after reload:
      manager2.reload();
      expect(manager2.validate(token).status).toBe('valid');
    });

    it('creates threadline dir recursively even if stateDir does not exist', () => {
      const deepDir = path.join(tmpDir, 'a', 'b', 'c');
      const mgr = new InvitationManager({ stateDir: deepDir });
      expect(fs.existsSync(path.join(deepDir, 'threadline'))).toBe(true);
      // Create a token to prove it works
      const token = mgr.create();
      expect(token).toBeTruthy();
    });
  });

  // ── 2. Token Creation ──────────────────────────────────────────

  describe('token creation', () => {
    it('returns a hex string token', () => {
      const token = manager.create();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns unique tokens on each call', () => {
      const tokens = new Set(Array.from({ length: 10 }, () => manager.create()));
      expect(tokens.size).toBe(10);
    });

    it('stores the invitation internally', () => {
      const token = manager.create();
      const result = manager.validate(token);
      expect(result.status).toBe('valid');
      expect(result.invitation).toBeDefined();
    });

    it('defaults maxUses to 1', () => {
      const token = manager.create();
      const result = manager.validate(token);
      expect(result.invitation!.maxUses).toBe(1);
    });

    it('sets custom maxUses', () => {
      const token = manager.create({ maxUses: 5 });
      const result = manager.validate(token);
      expect(result.invitation!.maxUses).toBe(5);
    });

    it('sets maxUses to 0 for unlimited', () => {
      const token = manager.create({ maxUses: 0 });
      const result = manager.validate(token);
      expect(result.invitation!.maxUses).toBe(0);
    });

    it('stores label when provided', () => {
      const token = manager.create({ label: 'Test Invite' });
      const result = manager.validate(token);
      expect(result.invitation!.label).toBe('Test Invite');
    });

    it('sets label to undefined when not provided', () => {
      const token = manager.create();
      const result = manager.validate(token);
      expect(result.invitation!.label).toBeUndefined();
    });

    it('sets createdAt to an ISO timestamp', () => {
      const before = new Date().toISOString();
      const token = manager.create();
      const after = new Date().toISOString();
      const result = manager.validate(token);
      expect(result.invitation!.createdAt >= before).toBe(true);
      expect(result.invitation!.createdAt <= after).toBe(true);
    });

    it('sets expiresAt when expiresInMs is provided', () => {
      const token = manager.create({ expiresInMs: 60000 });
      const result = manager.validate(token);
      expect(result.invitation!.expiresAt).not.toBeNull();
      const expiresAt = new Date(result.invitation!.expiresAt!).getTime();
      const createdAt = new Date(result.invitation!.createdAt).getTime();
      expect(expiresAt - createdAt).toBeCloseTo(60000, -2);
    });

    it('sets expiresAt to null when expiresInMs is not provided', () => {
      const token = manager.create();
      const result = manager.validate(token);
      expect(result.invitation!.expiresAt).toBeNull();
    });

    it('initializes useCount to 0', () => {
      const token = manager.create();
      const result = manager.validate(token);
      expect(result.invitation!.useCount).toBe(0);
    });

    it('initializes consumedBy to empty array', () => {
      const token = manager.create();
      const result = manager.validate(token);
      expect(result.invitation!.consumedBy).toEqual([]);
    });

    it('initializes revoked to false', () => {
      const token = manager.create();
      const result = manager.validate(token);
      expect(result.invitation!.revoked).toBe(false);
    });

    it('persists invitation to disk on create', () => {
      const token = manager.create();
      const filePath = path.join(tmpDir, 'threadline', 'invitations.json');
      expect(fs.existsSync(filePath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(data.invitations[token]).toBeDefined();
    });
  });

  // ── 3. Token Validation ────────────────────────────────────────

  describe('token validation', () => {
    it('returns valid for a fresh token', () => {
      const token = manager.create();
      const result = manager.validate(token);
      expect(result.status).toBe('valid');
      expect(result.reason).toContain('valid');
    });

    it('returns not-found for an unknown token', () => {
      const result = manager.validate('deadbeef'.repeat(8));
      expect(result.status).toBe('not-found');
      expect(result.invitation).toBeUndefined();
    });

    it('returns not-found for an empty string', () => {
      const result = manager.validate('');
      expect(result.status).toBe('not-found');
    });

    it('returns expired for an expired token', () => {
      vi.useFakeTimers();
      const token = manager.create({ expiresInMs: 1000 });
      vi.advanceTimersByTime(1001);
      const result = manager.validate(token);
      expect(result.status).toBe('expired');
      expect(result.invitation).toBeDefined();
    });

    it('returns valid for a token that has not yet expired', () => {
      vi.useFakeTimers();
      const token = manager.create({ expiresInMs: 5000 });
      vi.advanceTimersByTime(4999);
      const result = manager.validate(token);
      expect(result.status).toBe('valid');
    });

    it('returns exhausted for a fully consumed single-use token', () => {
      const token = manager.create();
      manager.consume(token, 'agent-1');
      const result = manager.validate(token);
      expect(result.status).toBe('exhausted');
    });

    it('returns revoked for a revoked token', () => {
      const token = manager.create();
      manager.revoke(token);
      const result = manager.validate(token);
      expect(result.status).toBe('revoked');
      expect(result.invitation).toBeDefined();
    });

    it('includes the invitation in the result for known tokens', () => {
      const token = manager.create({ label: 'check' });
      const result = manager.validate(token);
      expect(result.invitation!.token).toBe(token);
      expect(result.invitation!.label).toBe('check');
    });
  });

  // ── 4. HMAC Integrity ─────────────────────────────────────────

  describe('HMAC integrity', () => {
    it('valid token passes HMAC check', () => {
      const token = manager.create();
      const result = manager.validate(token);
      expect(result.status).toBe('valid');
    });

    it('detects tampered HMAC in stored invitation', () => {
      const token = manager.create();
      // Tamper with the stored HMAC directly on disk
      const filePath = path.join(tmpDir, 'threadline', 'invitations.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      // Flip some bytes in the HMAC
      const originalHmac = data.invitations[token].hmac;
      data.invitations[token].hmac = 'a'.repeat(originalHmac.length);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

      // Reload and validate
      manager.reload();
      const result = manager.validate(token);
      expect(result.status).toBe('invalid-hmac');
      expect(result.reason).toContain('tamper');
    });

    it('tampered HMAC includes invitation in result', () => {
      const token = manager.create();
      const filePath = path.join(tmpDir, 'threadline', 'invitations.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      data.invitations[token].hmac = 'b'.repeat(data.invitations[token].hmac.length);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      manager.reload();
      const result = manager.validate(token);
      expect(result.invitation).toBeDefined();
      expect(result.invitation!.token).toBe(token);
    });

    it('different secrets produce different HMACs (cross-manager check)', () => {
      const token = manager.create();

      // Create a second manager with a different stateDir (different secret)
      const tmpDir2 = path.join(os.tmpdir(), `instar-invitation-test2-${crypto.randomUUID()}`);
      fs.mkdirSync(tmpDir2, { recursive: true });
      try {
        const manager2 = new InvitationManager({ stateDir: tmpDir2 });
        // Manually copy the invitation but it should fail HMAC due to different secret
        const filePath1 = path.join(tmpDir, 'threadline', 'invitations.json');
        const filePath2 = path.join(tmpDir2, 'threadline', 'invitations.json');
        fs.copyFileSync(filePath1, filePath2);
        manager2.reload();
        const result = manager2.validate(token);
        expect(result.status).toBe('invalid-hmac');
      } finally {
        // safe-git-allow: incremental-migration
        fs.rmSync(tmpDir2, { recursive: true, force: true });
      }
    });
  });

  // ── 5. Token Consumption ───────────────────────────────────────

  describe('token consumption', () => {
    it('consumes a single-use token successfully', () => {
      const token = manager.create();
      const result = manager.consume(token, 'agent-1');
      expect(result.status).toBe('valid');
      expect(result.invitation!.useCount).toBe(1);
    });

    it('single-use token is exhausted after one consume', () => {
      const token = manager.create();
      manager.consume(token, 'agent-1');
      const result = manager.consume(token, 'agent-2');
      expect(result.status).toBe('exhausted');
    });

    it('multi-use token can be consumed multiple times', () => {
      const token = manager.create({ maxUses: 3 });
      expect(manager.consume(token, 'a1').status).toBe('valid');
      expect(manager.consume(token, 'a2').status).toBe('valid');
      expect(manager.consume(token, 'a3').status).toBe('valid');
      expect(manager.consume(token, 'a4').status).toBe('exhausted');
    });

    it('unlimited token (maxUses=0) never exhausts', () => {
      const token = manager.create({ maxUses: 0 });
      for (let i = 0; i < 20; i++) {
        const result = manager.consume(token, `agent-${i}`);
        expect(result.status).toBe('valid');
      }
      expect(manager.validate(token).invitation!.useCount).toBe(20);
    });

    it('tracks consumedBy identities', () => {
      const token = manager.create({ maxUses: 3 });
      manager.consume(token, 'agent-alpha');
      manager.consume(token, 'agent-beta');
      const result = manager.validate(token);
      expect(result.invitation!.consumedBy).toEqual(['agent-alpha', 'agent-beta']);
    });

    it('does not duplicate consumedBy for same agent', () => {
      const token = manager.create({ maxUses: 5 });
      manager.consume(token, 'agent-alpha');
      manager.consume(token, 'agent-alpha');
      const result = manager.validate(token);
      expect(result.invitation!.consumedBy).toEqual(['agent-alpha']);
      expect(result.invitation!.useCount).toBe(2);
    });

    it('returns not-found when consuming unknown token', () => {
      const result = manager.consume('nonexistent', 'agent-1');
      expect(result.status).toBe('not-found');
    });

    it('returns expired when consuming expired token', () => {
      vi.useFakeTimers();
      const token = manager.create({ expiresInMs: 500 });
      vi.advanceTimersByTime(501);
      const result = manager.consume(token, 'agent-1');
      expect(result.status).toBe('expired');
    });

    it('returns revoked when consuming revoked token', () => {
      const token = manager.create();
      manager.revoke(token);
      const result = manager.consume(token, 'agent-1');
      expect(result.status).toBe('revoked');
    });

    it('consume persists state to disk', () => {
      const token = manager.create();
      manager.consume(token, 'agent-1');

      const manager2 = new InvitationManager({ stateDir: tmpDir });
      const result = manager2.validate(token);
      expect(result.invitation!.useCount).toBe(1);
      expect(result.invitation!.consumedBy).toEqual(['agent-1']);
    });

    it('consume reason message includes agent identity', () => {
      const token = manager.create();
      const result = manager.consume(token, 'my-agent');
      expect(result.reason).toContain('my-agent');
    });
  });

  // ── 6. Token Revocation ────────────────────────────────────────

  describe('token revocation', () => {
    it('revokes a valid token', () => {
      const token = manager.create();
      expect(manager.revoke(token)).toBe(true);
    });

    it('returns false for unknown token', () => {
      expect(manager.revoke('nonexistent')).toBe(false);
    });

    it('revoked token validates as revoked', () => {
      const token = manager.create();
      manager.revoke(token);
      expect(manager.validate(token).status).toBe('revoked');
    });

    it('revoked token cannot be consumed', () => {
      const token = manager.create({ maxUses: 5 });
      manager.consume(token, 'agent-1');
      manager.revoke(token);
      const result = manager.consume(token, 'agent-2');
      expect(result.status).toBe('revoked');
    });

    it('revocation persists to disk', () => {
      const token = manager.create();
      manager.revoke(token);

      const manager2 = new InvitationManager({ stateDir: tmpDir });
      expect(manager2.validate(token).status).toBe('revoked');
    });

    it('can revoke an already-revoked token (idempotent)', () => {
      const token = manager.create();
      expect(manager.revoke(token)).toBe(true);
      expect(manager.revoke(token)).toBe(true);
      expect(manager.validate(token).status).toBe('revoked');
    });
  });

  // ── 7. Token Listing ──────────────────────────────────────────

  describe('token listing', () => {
    it('returns empty array when no tokens exist', () => {
      expect(manager.list()).toEqual([]);
    });

    it('lists all created tokens', () => {
      manager.create({ label: 'A' });
      manager.create({ label: 'B' });
      manager.create({ label: 'C' });
      const listed = manager.list();
      expect(listed).toHaveLength(3);
      expect(listed.map(i => i.label).sort()).toEqual(['A', 'B', 'C']);
    });

    it('includes status for each token', () => {
      const t1 = manager.create({ label: 'valid-one' });
      const t2 = manager.create({ label: 'exhausted-one' });
      const t3 = manager.create({ label: 'revoked-one' });
      manager.consume(t2, 'agent');
      manager.revoke(t3);

      const listed = manager.list();
      const statusMap = Object.fromEntries(listed.map(i => [i.label, i.status]));
      expect(statusMap['valid-one']).toBe('valid');
      expect(statusMap['exhausted-one']).toBe('exhausted');
      expect(statusMap['revoked-one']).toBe('revoked');
    });

    it('reflects expired status in listing', () => {
      vi.useFakeTimers();
      manager.create({ label: 'will-expire', expiresInMs: 1000 });
      manager.create({ label: 'stays-valid', expiresInMs: 10000 });
      vi.advanceTimersByTime(2000);

      const listed = manager.list();
      const statusMap = Object.fromEntries(listed.map(i => [i.label, i.status]));
      expect(statusMap['will-expire']).toBe('expired');
      expect(statusMap['stays-valid']).toBe('valid');
    });

    it('listed items contain full invitation fields', () => {
      const token = manager.create({ label: 'full-check', maxUses: 3 });
      const listed = manager.list();
      expect(listed).toHaveLength(1);
      const item = listed[0];
      expect(item.token).toBe(token);
      expect(item.hmac).toBeTruthy();
      expect(item.label).toBe('full-check');
      expect(item.maxUses).toBe(3);
      expect(item.useCount).toBe(0);
      expect(item.consumedBy).toEqual([]);
      expect(item.revoked).toBe(false);
      expect(item.createdAt).toBeTruthy();
      expect(item.status).toBe('valid');
    });
  });

  // ── 8. Persistence ────────────────────────────────────────────

  describe('persistence', () => {
    it('tokens survive reload()', () => {
      const token = manager.create({ label: 'persist-test' });
      manager.reload();
      const result = manager.validate(token);
      expect(result.status).toBe('valid');
      expect(result.invitation!.label).toBe('persist-test');
    });

    it('new InvitationManager on same stateDir sees existing tokens', () => {
      const token = manager.create({ label: 'cross-instance' });
      const manager2 = new InvitationManager({ stateDir: tmpDir });
      const result = manager2.validate(token);
      expect(result.status).toBe('valid');
      expect(result.invitation!.label).toBe('cross-instance');
    });

    it('consumption state persists across reload', () => {
      const token = manager.create({ maxUses: 3 });
      manager.consume(token, 'agent-a');
      manager.reload();
      const result = manager.validate(token);
      expect(result.invitation!.useCount).toBe(1);
      expect(result.invitation!.consumedBy).toEqual(['agent-a']);
    });

    it('revocation state persists across reload', () => {
      const token = manager.create();
      manager.revoke(token);
      manager.reload();
      expect(manager.validate(token).status).toBe('revoked');
    });

    it('multiple tokens all persist', () => {
      const tokens = Array.from({ length: 5 }, (_, i) => manager.create({ label: `token-${i}` }));
      const manager2 = new InvitationManager({ stateDir: tmpDir });
      for (const token of tokens) {
        expect(manager2.validate(token).status).toBe('valid');
      }
      expect(manager2.list()).toHaveLength(5);
    });

    it('invitations.json is valid JSON', () => {
      manager.create();
      const filePath = path.join(tmpDir, 'threadline', 'invitations.json');
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(() => JSON.parse(content)).not.toThrow();
      const data = JSON.parse(content);
      expect(data.invitations).toBeDefined();
      expect(data.updatedAt).toBeTruthy();
    });

    it('handles missing invitations.json gracefully (empty state)', () => {
      manager.create();
      const filePath = path.join(tmpDir, 'threadline', 'invitations.json');
      // safe-git-allow: incremental-migration
      fs.unlinkSync(filePath);
      manager.reload();
      expect(manager.list()).toEqual([]);
    });

    it('handles corrupted invitations.json gracefully', () => {
      manager.create();
      const filePath = path.join(tmpDir, 'threadline', 'invitations.json');
      fs.writeFileSync(filePath, '{not valid json!!!');
      manager.reload();
      expect(manager.list()).toEqual([]);
    });
  });

  // ── 9. Expiry ─────────────────────────────────────────────────

  describe('expiry', () => {
    it('token is valid before expiry', () => {
      vi.useFakeTimers();
      const token = manager.create({ expiresInMs: 10000 });
      vi.advanceTimersByTime(9999);
      expect(manager.validate(token).status).toBe('valid');
    });

    it('token expires exactly at expiry boundary', () => {
      vi.useFakeTimers();
      const token = manager.create({ expiresInMs: 5000 });
      vi.advanceTimersByTime(5001);
      expect(manager.validate(token).status).toBe('expired');
    });

    it('expired reason includes expiry timestamp', () => {
      vi.useFakeTimers();
      const token = manager.create({ expiresInMs: 100 });
      vi.advanceTimersByTime(200);
      const result = manager.validate(token);
      expect(result.reason).toContain('expired');
    });

    it('token without expiry never expires', () => {
      vi.useFakeTimers();
      const token = manager.create();
      vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000); // 1 year
      expect(manager.validate(token).status).toBe('valid');
    });

    it('expired token cannot be consumed', () => {
      vi.useFakeTimers();
      const token = manager.create({ expiresInMs: 100 });
      vi.advanceTimersByTime(200);
      const result = manager.consume(token, 'agent-1');
      expect(result.status).toBe('expired');
    });

    it('expiry is checked before use count', () => {
      vi.useFakeTimers();
      // Create with maxUses=1, consume it, then let it expire
      const token = manager.create({ maxUses: 2, expiresInMs: 1000 });
      manager.consume(token, 'agent-1');
      vi.advanceTimersByTime(2000);
      // Both expired and would-be-valid for use, but expired takes priority
      const result = manager.validate(token);
      expect(result.status).toBe('expired');
    });
  });

  // ── 10. Edge Cases ────────────────────────────────────────────

  describe('edge cases', () => {
    it('validates empty string token as not-found', () => {
      expect(manager.validate('').status).toBe('not-found');
    });

    it('consumes empty string token as not-found', () => {
      expect(manager.consume('', 'agent').status).toBe('not-found');
    });

    it('revoke returns false for empty string', () => {
      expect(manager.revoke('')).toBe(false);
    });

    it('handles many tokens without issues', () => {
      const tokens: string[] = [];
      for (let i = 0; i < 100; i++) {
        tokens.push(manager.create({ label: `bulk-${i}` }));
      }
      expect(manager.list()).toHaveLength(100);
      for (const token of tokens) {
        expect(manager.validate(token).status).toBe('valid');
      }
    });

    it('create with no options at all works', () => {
      const token = manager.create();
      expect(token).toBeTruthy();
      expect(manager.validate(token).status).toBe('valid');
    });

    it('create with empty options object works', () => {
      const token = manager.create({});
      expect(token).toBeTruthy();
      const inv = manager.validate(token).invitation!;
      expect(inv.maxUses).toBe(1);
      expect(inv.label).toBeUndefined();
      expect(inv.expiresAt).toBeNull();
    });

    it('validation priority: HMAC checked before revocation', () => {
      const token = manager.create();
      manager.revoke(token);
      // Tamper with HMAC
      const filePath = path.join(tmpDir, 'threadline', 'invitations.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      data.invitations[token].hmac = 'f'.repeat(data.invitations[token].hmac.length);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      manager.reload();
      // HMAC should be checked first
      expect(manager.validate(token).status).toBe('invalid-hmac');
    });

    it('validation priority: revocation checked before expiry', () => {
      vi.useFakeTimers();
      const token = manager.create({ expiresInMs: 1000 });
      manager.revoke(token);
      vi.advanceTimersByTime(2000);
      // Revoked check comes before expiry
      expect(manager.validate(token).status).toBe('revoked');
    });

    it('concurrent creates do not overwrite each other', () => {
      const t1 = manager.create({ label: 'first' });
      const t2 = manager.create({ label: 'second' });
      const t3 = manager.create({ label: 'third' });
      expect(manager.validate(t1).status).toBe('valid');
      expect(manager.validate(t2).status).toBe('valid');
      expect(manager.validate(t3).status).toBe('valid');
      expect(manager.list()).toHaveLength(3);
    });

    it('consuming a multi-use token returns updated use count in reason', () => {
      const token = manager.create({ maxUses: 3 });
      const r1 = manager.consume(token, 'a');
      expect(r1.reason).toContain('1/3');
      const r2 = manager.consume(token, 'b');
      expect(r2.reason).toContain('2/3');
    });

    it('consuming unlimited token shows unlimited in reason', () => {
      const token = manager.create({ maxUses: 0 });
      const result = manager.consume(token, 'agent');
      expect(result.reason).toContain('unlimited');
    });
  });
});
