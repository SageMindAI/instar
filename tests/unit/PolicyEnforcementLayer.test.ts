import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PolicyEnforcementLayer } from '../../src/core/PolicyEnforcementLayer.js';
import type { PELContext, PELResult } from '../../src/core/PolicyEnforcementLayer.js';

/**
 * Policy Enforcement Layer tests — verify that deterministic hard
 * policy checks correctly detect credential leaks, PII, auth tokens,
 * internal URLs, file paths, and env vars.
 */

describe('PolicyEnforcementLayer', () => {
  let tmpDir: string;
  let stateDir: string;
  let pel: PolicyEnforcementLayer;

  const makeContext = (overrides: Partial<PELContext> = {}): PELContext => ({
    channel: 'telegram',
    isExternalFacing: false,
    recipientType: 'primary-user',
    stateDir,
    ...overrides,
  });

  const externalContext = (overrides: Partial<PELContext> = {}): PELContext =>
    makeContext({ isExternalFacing: true, recipientType: 'external-contact', ...overrides });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-pel-test-'));
    stateDir = tmpDir;
    // Write a config with an auth token
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ authToken: 'test-secret-token-12345678' }),
    );
    pel = new PolicyEnforcementLayer(stateDir);
  });

  afterEach(() => {
    pel.destroy();
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Clean Messages ─────────────────────────────────────────────

  describe('clean messages', () => {
    it('passes a simple greeting', () => {
      const result = pel.enforce('Hello! How are you today?', makeContext());
      expect(result.pass).toBe(true);
      expect(result.outcome).toBe('pass');
      expect(result.violations).toHaveLength(0);
    });

    it('passes a technical message without secrets', () => {
      const result = pel.enforce(
        'The server is running on port 4042. Deployment was successful.',
        makeContext(),
      );
      expect(result.pass).toBe(true);
      expect(result.outcome).toBe('pass');
    });

    it('passes internal URLs on internal channels', () => {
      const result = pel.enforce(
        'Check http://localhost:4042/health for status',
        makeContext({ isExternalFacing: false }),
      );
      // Internal URLs are only flagged on external channels
      expect(result.violations.filter(v => v.rule === 'internal-url-leak')).toHaveLength(0);
    });
  });

  // ── Credential Detection ───────────────────────────────────────

  describe('credential patterns', () => {
    it('detects OpenAI API keys', () => {
      const result = pel.enforce(
        'Use this key: sk-abcdefghijklmnopqrstuvwxyz1234567890',
        makeContext(),
      );
      expect(result.outcome).toBe('hard_block');
      expect(result.violations).toContainEqual(
        expect.objectContaining({ rule: 'credential-leak', severity: 'hard_block' }),
      );
    });

    it('detects GitHub personal access tokens', () => {
      const result = pel.enforce(
        'Token: ghp_abcdefghijklmnopqrstuvwxyz1234567890ab',
        makeContext(),
      );
      expect(result.outcome).toBe('hard_block');
      expect(result.violations.some(v => v.rule === 'credential-leak')).toBe(true);
    });

    it('detects Slack bot tokens', () => {
      const result = pel.enforce(
        'xoxb-1234567890-abcdefghij-klmnopqrstuvwx',
        makeContext(),
      );
      expect(result.outcome).toBe('hard_block');
    });

    it('detects AWS access keys', () => {
      const result = pel.enforce(
        'AWS key: AKIAIOSFODNN7EXAMPLE',
        makeContext(),
      );
      expect(result.outcome).toBe('hard_block');
    });

    it('detects Stripe secret keys', () => {
      // Constructed at runtime to avoid GitHub secret scanning
      const key = ['sk', 'test', 'FAKEKEYFORTESTING000000000000'].join('_');
      const result = pel.enforce(key, makeContext());
      expect(result.outcome).toBe('hard_block');
    });

    it('detects Anthropic API keys', () => {
      const result = pel.enforce(
        'sk-ant-abcdefghijklmnopqrstuvwxyz',
        makeContext(),
      );
      expect(result.outcome).toBe('hard_block');
    });

    it('detects bearer tokens', () => {
      const result = pel.enforce(
        'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc',
        makeContext(),
      );
      expect(result.outcome).toBe('hard_block');
    });

    it('detects password assignments', () => {
      const result = pel.enforce(
        'password = "my-super-secret-password"',
        makeContext(),
      );
      expect(result.outcome).toBe('hard_block');
    });

    it('detects private key blocks', () => {
      const result = pel.enforce(
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...',
        makeContext(),
      );
      expect(result.outcome).toBe('hard_block');
    });

    it('blocks credentials on BOTH internal and external channels', () => {
      const key = 'sk-abcdefghijklmnopqrstuvwxyz1234567890';
      const internal = pel.enforce(`Key: ${key}`, makeContext());
      const external = pel.enforce(`Key: ${key}`, externalContext());
      expect(internal.outcome).toBe('hard_block');
      expect(external.outcome).toBe('hard_block');
    });
  });

  // ── PII Detection ──────────────────────────────────────────────

  describe('PII detection', () => {
    it('detects email addresses on external channels', () => {
      const result = pel.enforce(
        'Contact me at user@example.com for details',
        externalContext(),
      );
      expect(result.outcome).toBe('hard_block');
      expect(result.violations.some(v => v.rule === 'pii-detection')).toBe(true);
    });

    it('detects US phone numbers on external channels', () => {
      const result = pel.enforce(
        'Call me at (555) 123-4567',
        externalContext(),
      );
      expect(result.outcome).toBe('hard_block');
      expect(result.violations.some(v => v.rule === 'pii-detection')).toBe(true);
    });

    it('detects SSN patterns on external channels', () => {
      const result = pel.enforce(
        'SSN: 123-45-6789',
        externalContext(),
      );
      expect(result.outcome).toBe('hard_block');
    });

    it('does NOT flag PII on internal channels', () => {
      const result = pel.enforce(
        'Justin\'s email is justin@example.com',
        makeContext({ isExternalFacing: false }),
      );
      // PII rules are external-only
      expect(result.violations.filter(v => v.rule === 'pii-detection')).toHaveLength(0);
    });
  });

  // ── Auth Token Leakage ─────────────────────────────────────────

  describe('auth token leakage', () => {
    it('detects the agent auth token in messages', () => {
      const result = pel.enforce(
        'The auth token is test-secret-token-12345678',
        makeContext(),
      );
      expect(result.outcome).toBe('hard_block');
      expect(result.violations.some(v => v.rule === 'auth-token-leak')).toBe(true);
    });

    it('blocks auth token on both internal and external channels', () => {
      const internal = pel.enforce('test-secret-token-12345678', makeContext());
      const external = pel.enforce('test-secret-token-12345678', externalContext());
      expect(internal.outcome).toBe('hard_block');
      expect(external.outcome).toBe('hard_block');
    });

    it('handles missing config gracefully', () => {
      pel.destroy();
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-pel-noconfig-'));
      const pelNoConfig = new PolicyEnforcementLayer(emptyDir);
      try {
        expect(pelNoConfig.getAuthToken()).toBeNull();
        const result = pelNoConfig.enforce('some message', makeContext());
        expect(result.violations.filter(v => v.rule === 'auth-token-leak')).toHaveLength(0);
      } finally {
        pelNoConfig.destroy();
        // safe-git-allow: incremental-migration
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('does not flag short auth tokens to avoid false positives', () => {
      pel.destroy();
      const shortDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-pel-short-'));
      fs.writeFileSync(
        path.join(shortDir, 'config.json'),
        JSON.stringify({ authToken: 'abc' }),
      );
      const pelShort = new PolicyEnforcementLayer(shortDir);
      try {
        // Token "abc" is too short (< 8 chars), should not trigger
        const result = pelShort.enforce('abc is a common string', makeContext());
        expect(result.violations.filter(v => v.rule === 'auth-token-leak')).toHaveLength(0);
      } finally {
        pelShort.destroy();
        // safe-git-allow: incremental-migration
        fs.rmSync(shortDir, { recursive: true, force: true });
      }
    });
  });

  // ── Internal URL Detection ─────────────────────────────────────

  describe('internal URL detection', () => {
    it('flags localhost URLs on external channels', () => {
      const result = pel.enforce(
        'Check http://localhost:4042/health',
        externalContext(),
      );
      expect(result.violations.some(v => v.rule === 'internal-url-leak')).toBe(true);
      expect(result.outcome).toBe('hard_block');
    });

    it('flags 127.0.0.1 URLs on external channels', () => {
      const result = pel.enforce(
        'API at http://127.0.0.1:4042/status',
        externalContext(),
      );
      expect(result.violations.some(v => v.rule === 'internal-url-leak')).toBe(true);
    });

    it('flags 0.0.0.0 URLs on external channels', () => {
      const result = pel.enforce(
        'Bound to http://0.0.0.0:3000',
        externalContext(),
      );
      expect(result.violations.some(v => v.rule === 'internal-url-leak')).toBe(true);
    });

    it('does NOT flag internal URLs on internal channels', () => {
      const result = pel.enforce(
        'http://localhost:4042/health is up',
        makeContext({ isExternalFacing: false }),
      );
      expect(result.violations.filter(v => v.rule === 'internal-url-leak')).toHaveLength(0);
    });
  });

  // ── File Path Detection ────────────────────────────────────────

  describe('file path detection', () => {
    it('warns about .instar/ paths on external channels', () => {
      const result = pel.enforce(
        'Check .instar/config.json for settings',
        externalContext(),
      );
      expect(result.violations.some(v => v.rule === 'file-path-leak')).toBe(true);
      expect(result.violations.find(v => v.rule === 'file-path-leak')?.severity).toBe('warn');
    });

    it('warns about .claude/ paths on external channels', () => {
      const result = pel.enforce(
        'The script is at .claude/scripts/foo.sh',
        externalContext(),
      );
      expect(result.violations.some(v => v.rule === 'file-path-leak')).toBe(true);
    });

    it('warns about /Users/ paths on external channels', () => {
      const result = pel.enforce(
        'File is at /Users/justin/Documents/project/file.txt',
        externalContext(),
      );
      expect(result.violations.some(v => v.rule === 'file-path-leak')).toBe(true);
    });

    it('warns about /home/ paths on external channels', () => {
      const result = pel.enforce(
        'Stored at /home/deploy/.config/app.json',
        externalContext(),
      );
      expect(result.violations.some(v => v.rule === 'file-path-leak')).toBe(true);
    });

    it('file path warnings result in "warn" outcome (not hard_block)', () => {
      const result = pel.enforce(
        'Check .instar/config.json',
        externalContext(),
      );
      // Only file path violations -> warn, not hard_block
      const nonPathViolations = result.violations.filter(v => v.rule !== 'file-path-leak');
      if (nonPathViolations.length === 0) {
        expect(result.outcome).toBe('warn');
      }
    });

    it('does NOT flag file paths on internal channels', () => {
      const result = pel.enforce(
        'Read /Users/justin/.instar/MEMORY.md',
        makeContext({ isExternalFacing: false }),
      );
      expect(result.violations.filter(v => v.rule === 'file-path-leak')).toHaveLength(0);
    });
  });

  // ── Environment Variable Patterns ──────────────────────────────

  describe('environment variable patterns', () => {
    it('warns about $AUTH usage', () => {
      const result = pel.enforce(
        'Run: curl -H "Authorization: Bearer $AUTH" ...',
        makeContext(),
      );
      expect(result.violations.some(v => v.rule === 'env-var-leak')).toBe(true);
    });

    it('warns about $API_KEY usage', () => {
      const result = pel.enforce(
        'Set $API_KEY to your key',
        makeContext(),
      );
      expect(result.violations.some(v => v.rule === 'env-var-leak')).toBe(true);
    });

    it('warns about process.env references', () => {
      const result = pel.enforce(
        'Access it via process.env.DATABASE_URL',
        makeContext(),
      );
      expect(result.violations.some(v => v.rule === 'env-var-leak')).toBe(true);
    });

    it('env var warnings are severity "warn"', () => {
      const result = pel.enforce('Use $AUTH here', makeContext());
      const envViolation = result.violations.find(v => v.rule === 'env-var-leak');
      expect(envViolation?.severity).toBe('warn');
    });
  });

  // ── Combined Violations ────────────────────────────────────────

  describe('combined violations', () => {
    it('detects multiple violation types in one message', () => {
      const result = pel.enforce(
        'Key: sk-abcdefghijklmnopqrstuvwxyz1234567890, server at http://localhost:4042, path: /Users/justin/project',
        externalContext(),
      );
      expect(result.outcome).toBe('hard_block');
      // Should have credential, internal URL, and file path violations
      const rules = new Set(result.violations.map(v => v.rule));
      expect(rules.has('credential-leak')).toBe(true);
      expect(rules.has('internal-url-leak')).toBe(true);
      expect(rules.has('file-path-leak')).toBe(true);
    });

    it('hard_block takes precedence over warn', () => {
      const result = pel.enforce(
        'Token: sk-abcdefghijklmnopqrstuvwxyz1234567890 and also $AUTH',
        makeContext(),
      );
      // credential-leak is hard_block, env-var-leak is warn
      expect(result.outcome).toBe('hard_block');
      expect(result.violations.some(v => v.severity === 'hard_block')).toBe(true);
      expect(result.violations.some(v => v.severity === 'warn')).toBe(true);
    });
  });

  // ── Performance ────────────────────────────────────────────────

  describe('performance', () => {
    it('enforces rules in under 5ms', () => {
      const longMessage = 'A'.repeat(10000) + ' Some regular content with no secrets.';
      const ctx = externalContext();

      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        pel.enforce(longMessage, ctx);
      }
      const elapsed = performance.now() - start;
      const perCall = elapsed / 100;

      expect(perCall).toBeLessThan(5);
    });

    it('handles empty messages quickly', () => {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        pel.enforce('', makeContext());
      }
      const elapsed = performance.now() - start;
      expect(elapsed / 1000).toBeLessThan(1);
    });
  });

  // ── Edge Cases ─────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles null-like content without crashing', () => {
      expect(() => pel.enforce('', makeContext())).not.toThrow();
      expect(() => pel.enforce('   ', makeContext())).not.toThrow();
    });

    it('does not false-positive on short strings that look like prefixes', () => {
      const result = pel.enforce('sk- is a prefix for OpenAI keys', makeContext());
      // "sk-" alone is too short to match the 20+ char requirement
      expect(result.violations.filter(v => v.rule === 'credential-leak')).toHaveLength(0);
    });

    it('does not false-positive on "ghp" without underscore', () => {
      const result = pel.enforce('The word ghp appears sometimes', makeContext());
      expect(result.violations.filter(v => v.rule === 'credential-leak')).toHaveLength(0);
    });

    it('preserves match field for debugging', () => {
      const result = pel.enforce(
        'Key: AKIAIOSFODNN7EXAMPLE',
        makeContext(),
      );
      const violation = result.violations.find(v => v.rule === 'credential-leak');
      expect(violation?.match).toBeTruthy();
      expect(violation?.match).toContain('AKIA');
    });
  });
});
