import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthorizationPolicyManager } from '../../../src/threadline/AuthorizationPolicy.js';

describe('AuthorizationPolicy', () => {
  let tmpDir: string;
  let mgr: AuthorizationPolicyManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'authz-test-'));
    mgr = new AuthorizationPolicyManager(tmpDir);
  });

  afterEach(() => {
    mgr.flush();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('createGrant', () => {
    it('creates a grant with correct fields', () => {
      const grant = mgr.createGrant({
        subject: 'abc123',
        resource: 'tool',
        resourceId: 'web-search',
        action: 'execute',
        effect: 'allow',
        issuer: 'user-local',
      });

      expect(grant.id).toMatch(/^[0-9a-f]{32}$/);
      expect(grant.subject).toBe('abc123');
      expect(grant.resource).toBe('tool');
      expect(grant.resourceId).toBe('web-search');
      expect(grant.action).toBe('execute');
      expect(grant.effect).toBe('allow');
      expect(grant.delegationMode).toBe('approval-required');
      expect(grant.currentDepth).toBe(0);
      expect(new Date(grant.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('defaults resourceId to wildcard', () => {
      const grant = mgr.createGrant({
        subject: 'abc123', resource: 'message', action: 'message',
        effect: 'allow', issuer: 'user',
      });
      expect(grant.resourceId).toBe('*');
    });
  });

  describe('evaluate — default deny', () => {
    it('denies when no grants exist', () => {
      const result = mgr.evaluate('abc123', 'tool', 'search', 'execute');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('default-deny');
    });

    it('denies for wrong subject', () => {
      mgr.createGrant({
        subject: 'other-agent', resource: 'tool', action: 'execute',
        effect: 'allow', issuer: 'user',
      });
      const result = mgr.evaluate('abc123', 'tool', undefined, 'execute');
      expect(result.allowed).toBe(false);
    });
  });

  describe('evaluate — allow', () => {
    it('allows with matching grant', () => {
      mgr.createGrant({
        subject: 'abc123', resource: 'message', action: 'message',
        effect: 'allow', issuer: 'user',
      });
      const result = mgr.evaluate('abc123', 'message', undefined, 'message');
      expect(result.allowed).toBe(true);
    });

    it('wildcard resourceId matches any', () => {
      mgr.createGrant({
        subject: 'abc123', resource: 'tool', action: 'execute',
        effect: 'allow', issuer: 'user',
      });
      const result = mgr.evaluate('abc123', 'tool', 'any-tool', 'execute');
      expect(result.allowed).toBe(true);
    });

    it('specific resourceId takes precedence over wildcard', () => {
      mgr.createGrant({
        subject: 'abc123', resource: 'tool', resourceId: '*', action: 'execute',
        effect: 'allow', issuer: 'user',
      });
      mgr.createGrant({
        subject: 'abc123', resource: 'tool', resourceId: 'dangerous-tool', action: 'execute',
        effect: 'deny', issuer: 'user',
      });
      // Deny on specific tool should override wildcard allow
      const result = mgr.evaluate('abc123', 'tool', 'dangerous-tool', 'execute');
      expect(result.allowed).toBe(false);
    });
  });

  describe('evaluate — deny overrides allow', () => {
    it('deny wins over allow for same resource', () => {
      mgr.createGrant({
        subject: 'abc123', resource: 'file', action: 'read',
        effect: 'allow', issuer: 'user',
      });
      mgr.createGrant({
        subject: 'abc123', resource: 'file', action: 'read',
        effect: 'deny', issuer: 'user',
      });
      const result = mgr.evaluate('abc123', 'file', undefined, 'read');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('deny grant');
    });
  });

  describe('evaluate — TTL expiry', () => {
    it('expired grants are not matched', () => {
      const grant = mgr.createGrant({
        subject: 'abc123', resource: 'message', action: 'message',
        effect: 'allow', issuer: 'user', ttlMs: -1000, // already expired
      });

      const result = mgr.evaluate('abc123', 'message', undefined, 'message');
      expect(result.allowed).toBe(false);
    });
  });

  describe('delegation depth', () => {
    it('allows re-delegation within depth limit', () => {
      const grant = mgr.createGrant({
        subject: 'abc123', resource: 'tool', action: 'execute',
        effect: 'allow', issuer: 'user',
        constraints: { maxDelegationDepth: 2 },
      });
      expect(mgr.canRedelegate(grant.id)).toBe(true);
    });

    it('blocks re-delegation at max depth', () => {
      const grant = mgr.createGrant({
        subject: 'abc123', resource: 'tool', action: 'execute',
        effect: 'allow', issuer: 'user',
        constraints: { maxDelegationDepth: 1 },
      });
      // depth 0 < maxDepth 1 → allowed
      expect(mgr.canRedelegate(grant.id)).toBe(true);

      // Create a delegated grant at depth 1
      const delegated = mgr.createGrant({
        subject: 'downstream', resource: 'tool', action: 'execute',
        effect: 'allow', issuer: 'abc123',
        constraints: { maxDelegationDepth: 1 },
      });
      // Manually set depth to 1 (simulating delegation)
      delegated.currentDepth = 1;
      expect(mgr.canRedelegate(delegated.id)).toBe(false);
    });
  });

  describe('revokeGrant', () => {
    it('removes a grant', () => {
      const grant = mgr.createGrant({
        subject: 'abc123', resource: 'message', action: 'message',
        effect: 'allow', issuer: 'user',
      });
      expect(mgr.revokeGrant(grant.id)).toBe(true);
      const result = mgr.evaluate('abc123', 'message', undefined, 'message');
      expect(result.allowed).toBe(false);
    });

    it('returns false for nonexistent grant', () => {
      expect(mgr.revokeGrant('nonexistent')).toBe(false);
    });
  });

  describe('revokeAllForSubject', () => {
    it('removes all grants for a subject', () => {
      mgr.createGrant({ subject: 'abc', resource: 'message', action: 'message', effect: 'allow', issuer: 'u' });
      mgr.createGrant({ subject: 'abc', resource: 'tool', action: 'execute', effect: 'allow', issuer: 'u' });
      mgr.createGrant({ subject: 'other', resource: 'message', action: 'message', effect: 'allow', issuer: 'u' });

      expect(mgr.revokeAllForSubject('abc')).toBe(2);
      expect(mgr.size).toBe(1);
    });
  });

  describe('pruneExpired', () => {
    it('removes expired grants', () => {
      mgr.createGrant({ subject: 'a', resource: 'message', action: 'message', effect: 'allow', issuer: 'u', ttlMs: -1000 });
      mgr.createGrant({ subject: 'b', resource: 'message', action: 'message', effect: 'allow', issuer: 'u', ttlMs: 60000 });
      expect(mgr.pruneExpired()).toBe(1);
      expect(mgr.size).toBe(1);
    });
  });

  describe('persistence', () => {
    it('survives restart', () => {
      mgr.createGrant({
        subject: 'abc123', resource: 'tool', action: 'execute',
        effect: 'allow', issuer: 'user',
      });
      mgr.flush();

      const mgr2 = new AuthorizationPolicyManager(tmpDir);
      const result = mgr2.evaluate('abc123', 'tool', undefined, 'execute');
      expect(result.allowed).toBe(true);
    });
  });

  describe('getGrantsForSubject', () => {
    it('returns active grants only', () => {
      mgr.createGrant({ subject: 'abc', resource: 'message', action: 'message', effect: 'allow', issuer: 'u' });
      mgr.createGrant({ subject: 'abc', resource: 'tool', action: 'execute', effect: 'allow', issuer: 'u', ttlMs: -1 });
      const grants = mgr.getGrantsForSubject('abc');
      expect(grants).toHaveLength(1);
      expect(grants[0].resource).toBe('message');
    });
  });
});
