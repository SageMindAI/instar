/**
 * Unit tests for GlobalSecretStore — encrypted secret store at ~/.instar/secrets/.
 *
 * Tests:
 * - Password-based init, unlock, wrong password
 * - CRUD: get/set/delete secrets per agent
 * - Agent queries: list, has, delete
 * - Encryption verification: not readable, restrictive permissions
 * - Persistence across instances
 * - Destroy cleanup
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GlobalSecretStore } from '../../src/core/GlobalSecretStore.js';

describe('GlobalSecretStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-gss-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createStore() {
    return new GlobalSecretStore(tmpDir);
  }

  // ── Password-Based Initialization ─────────────────────────────

  describe('password-based initialization', () => {
    it('creates a new store with password', () => {
      const store = createStore();
      const isNew = store.initWithPassword('test-password-123');
      expect(isNew).toBe(true);
      expect(store.exists).toBe(true);
    });

    it('unlocks existing store with correct password', () => {
      const store1 = createStore();
      store1.initWithPassword('my-secret-password');
      store1.setSecret('agent1', 'token', 'abc123');

      const store2 = createStore();
      const isNew = store2.initWithPassword('my-secret-password');
      expect(isNew).toBe(false);
      expect(store2.getSecret('agent1', 'token')).toBe('abc123');
    });

    it('fails with wrong password', () => {
      const store1 = createStore();
      store1.initWithPassword('correct-password');
      store1.setSecret('agent1', 'key', 'value');

      const store2 = createStore();
      expect(() => store2.initWithPassword('wrong-password')).toThrow();
    });

    it('stores key metadata with PBKDF2 params', () => {
      const store = createStore();
      store.initWithPassword('test-password');

      const keyFile = path.join(tmpDir, 'global.key');
      expect(fs.existsSync(keyFile)).toBe(true);

      const keyData = JSON.parse(fs.readFileSync(keyFile, 'utf-8'));
      expect(keyData.type).toBe('pbkdf2');
      expect(keyData.salt).toBeDefined();
      expect(keyData.iterations).toBeGreaterThanOrEqual(100000);
    });

    it('reports requiresPassword correctly', () => {
      const store = createStore();
      expect(store.requiresPassword()).toBe(false);

      store.initWithPassword('test-password');
      const store2 = createStore();
      expect(store2.requiresPassword()).toBe(true);
    });
  });

  // ── Agent-Scoped CRUD ─────────────────────────────────────────

  describe('agent-scoped CRUD', () => {
    it('set and get a secret', () => {
      const store = createStore();
      store.initWithPassword('test-pass');
      store.setSecret('my-agent', 'telegram-token', 'bot123:ABC');
      expect(store.getSecret('my-agent', 'telegram-token')).toBe('bot123:ABC');
    });

    it('secrets are isolated between agents', () => {
      const store = createStore();
      store.initWithPassword('test-pass');
      store.setSecret('agent-a', 'token', 'token-a');
      store.setSecret('agent-b', 'token', 'token-b');
      expect(store.getSecret('agent-a', 'token')).toBe('token-a');
      expect(store.getSecret('agent-b', 'token')).toBe('token-b');
    });

    it('returns null for non-existent secret', () => {
      const store = createStore();
      store.initWithPassword('test-pass');
      expect(store.getSecret('no-agent', 'no-key')).toBeNull();
    });

    it('overwrites existing secret', () => {
      const store = createStore();
      store.initWithPassword('test-pass');
      store.setSecret('agent', 'key', 'old-value');
      store.setSecret('agent', 'key', 'new-value');
      expect(store.getSecret('agent', 'key')).toBe('new-value');
    });

    it('setAgentSecrets sets multiple at once', () => {
      const store = createStore();
      store.initWithPassword('test-pass');
      store.setAgentSecrets('agent1', {
        'telegram-token': 'bot123:ABC',
        'telegram-chat-id': '-100123',
        'auth-token': 'sk-secret',
      });
      expect(store.getSecret('agent1', 'telegram-token')).toBe('bot123:ABC');
      expect(store.getSecret('agent1', 'telegram-chat-id')).toBe('-100123');
      expect(store.getSecret('agent1', 'auth-token')).toBe('sk-secret');
    });

    it('getAgentSecrets returns all secrets for an agent', () => {
      const store = createStore();
      store.initWithPassword('test-pass');
      store.setAgentSecrets('agent1', { 'key1': 'val1', 'key2': 'val2' });
      expect(store.getAgentSecrets('agent1')).toEqual({ 'key1': 'val1', 'key2': 'val2' });
    });

    it('getAgentSecrets returns empty for unknown agent', () => {
      const store = createStore();
      store.initWithPassword('test-pass');
      expect(store.getAgentSecrets('unknown')).toEqual({});
    });

    it('deleteSecret removes a single secret', () => {
      const store = createStore();
      store.initWithPassword('test-pass');
      store.setAgentSecrets('agent1', { 'key1': 'val1', 'key2': 'val2' });
      store.deleteSecret('agent1', 'key1');
      expect(store.getSecret('agent1', 'key1')).toBeNull();
      expect(store.getSecret('agent1', 'key2')).toBe('val2');
    });

    it('deleteSecret cleans up empty agent entries', () => {
      const store = createStore();
      store.initWithPassword('test-pass');
      store.setSecret('agent1', 'only-key', 'value');
      store.deleteSecret('agent1', 'only-key');
      expect(store.hasAgent('agent1')).toBe(false);
    });

    it('deleteAgent removes all secrets for an agent', () => {
      const store = createStore();
      store.initWithPassword('test-pass');
      store.setAgentSecrets('agent1', { 'k1': 'v1', 'k2': 'v2' });
      store.deleteAgent('agent1');
      expect(store.hasAgent('agent1')).toBe(false);
      expect(store.getAgentSecrets('agent1')).toEqual({});
    });
  });

  // ── Agent Queries ─────────────────────────────────────────────

  describe('agent queries', () => {
    it('hasAgent returns true for agents with secrets', () => {
      const store = createStore();
      store.initWithPassword('test-pass');
      store.setSecret('agent1', 'key', 'value');
      expect(store.hasAgent('agent1')).toBe(true);
      expect(store.hasAgent('agent2')).toBe(false);
    });

    it('hasSecret checks specific keys', () => {
      const store = createStore();
      store.initWithPassword('test-pass');
      store.setSecret('agent1', 'exists', 'value');
      expect(store.hasSecret('agent1', 'exists')).toBe(true);
      expect(store.hasSecret('agent1', 'missing')).toBe(false);
    });

    it('listAgents returns all agent names', () => {
      const store = createStore();
      store.initWithPassword('test-pass');
      store.setSecret('alpha', 'k', 'v');
      store.setSecret('beta', 'k', 'v');
      store.setSecret('gamma', 'k', 'v');
      expect(store.listAgents().sort()).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('listAgents returns empty for fresh store', () => {
      const store = createStore();
      store.initWithPassword('test-pass');
      expect(store.listAgents()).toEqual([]);
    });
  });

  // ── Encryption Verification ───────────────────────────────────

  describe('encryption', () => {
    it('encrypted file is not readable as JSON', () => {
      const store = createStore();
      store.initWithPassword('test-pass');
      store.setSecret('agent', 'token', 'super-secret');

      const encFile = path.join(tmpDir, 'global.secrets.enc');
      const raw = fs.readFileSync(encFile);
      expect(() => JSON.parse(raw.toString())).toThrow();
    });

    it('secret value is not present in raw file bytes', () => {
      const store = createStore();
      store.initWithPassword('test-pass');
      store.setSecret('agent', 'token', 'MYSECRETTOKEN12345');

      const encFile = path.join(tmpDir, 'global.secrets.enc');
      const raw = fs.readFileSync(encFile).toString();
      expect(raw).not.toContain('MYSECRETTOKEN12345');
    });

    it('corrupted file throws on read', () => {
      const store = createStore();
      store.initWithPassword('test-pass');
      store.setSecret('agent', 'key', 'value');

      const encFile = path.join(tmpDir, 'global.secrets.enc');
      const raw = fs.readFileSync(encFile);
      raw[raw.length - 1] ^= 0xff;
      fs.writeFileSync(encFile, raw);

      const store2 = createStore();
      expect(() => store2.initWithPassword('test-pass')).toThrow();
    });

    it('key file has restrictive permissions', () => {
      const store = createStore();
      store.initWithPassword('test-pass');

      const keyFile = path.join(tmpDir, 'global.key');
      const stats = fs.statSync(keyFile);
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it('encrypted file has restrictive permissions', () => {
      const store = createStore();
      store.initWithPassword('test-pass');
      store.setSecret('agent', 'key', 'value');

      const encFile = path.join(tmpDir, 'global.secrets.enc');
      const stats = fs.statSync(encFile);
      expect(stats.mode & 0o777).toBe(0o600);
    });
  });

  // ── Persistence ───────────────────────────────────────────────

  describe('persistence', () => {
    it('data survives across instances', () => {
      const store1 = createStore();
      store1.initWithPassword('persistent-pass');
      store1.setSecret('agent', 'token', 'persisted-value');

      const store2 = createStore();
      store2.initWithPassword('persistent-pass');
      expect(store2.getSecret('agent', 'token')).toBe('persisted-value');
    });

    it('multiple agents persist independently', () => {
      const store = createStore();
      store.initWithPassword('test-pass');
      store.setSecret('agent-a', 'key', 'value-a');
      store.setSecret('agent-b', 'key', 'value-b');
      store.setSecret('agent-c', 'key', 'value-c');

      const store2 = createStore();
      store2.initWithPassword('test-pass');
      expect(store2.getSecret('agent-a', 'key')).toBe('value-a');
      expect(store2.getSecret('agent-b', 'key')).toBe('value-b');
      expect(store2.getSecret('agent-c', 'key')).toBe('value-c');
    });
  });

  // ── Destroy ───────────────────────────────────────────────────

  describe('destroy', () => {
    it('removes encrypted file and key', () => {
      const store = createStore();
      store.initWithPassword('test-pass');
      store.setSecret('agent', 'key', 'value');

      store.destroy();

      const encFile = path.join(tmpDir, 'global.secrets.enc');
      const keyFile = path.join(tmpDir, 'global.key');
      expect(fs.existsSync(encFile)).toBe(false);
      expect(fs.existsSync(keyFile)).toBe(false);
    });
  });
});
