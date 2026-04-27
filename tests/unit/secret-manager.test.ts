/**
 * Unit tests for SecretManager — unified secret management facade.
 *
 * Tests backend routing, CRUD, config backup/restore, preference persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SecretManager, SECRET_KEYS } from '../../src/core/SecretManager.js';
import { GlobalSecretStore } from '../../src/core/GlobalSecretStore.js';

describe('SecretManager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-sm-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Create a GlobalSecretStore that auto-inits with machine-derived password. */
  function initLocalStore() {
    const store = new GlobalSecretStore(tmpDir);
    store.autoInit(); // Uses machine-derived password since basePath disables keychain
    return store;
  }

  function createManager(agentName: string, backend?: string) {
    return new SecretManager({ agentName, backend: backend as any, basePath: tmpDir });
  }

  // ── Backend Selection ─────────────────────────────────────────

  describe('backend selection', () => {
    it('defaults to manual when no preference exists', () => {
      const mgr = createManager('test');
      expect(mgr.initialize()).toBe('manual');
    });

    it('uses explicit backend override', () => {
      initLocalStore();
      const mgr = createManager('test', 'local');
      expect(mgr.initialize()).toBe('local');
    });

    it('saves and loads backend preference', () => {
      const mgr1 = createManager('test');
      mgr1.configureBackend('local');

      const mgr2 = createManager('test');
      expect(mgr2.initialize()).toBe('local');
    });

    it('preference file stored at basePath/backend.json', () => {
      const mgr = createManager('test');
      mgr.configureBackend('local');

      const prefFile = path.join(tmpDir, 'backend.json');
      expect(fs.existsSync(prefFile)).toBe(true);
      const pref = JSON.parse(fs.readFileSync(prefFile, 'utf-8'));
      expect(pref.backend).toBe('local');
    });
  });

  // ── Local Backend Operations ──────────────────────────────────

  describe('local backend', () => {
    it('set and get a secret', () => {
      const mgr = createManager('my-agent', 'local');
      mgr.initialize();
      mgr.set('telegram-token', 'bot123:ABC');
      expect(mgr.get('telegram-token')).toBe('bot123:ABC');
    });

    it('has returns true for existing secrets', () => {
      const mgr = createManager('my-agent', 'local');
      mgr.initialize();
      mgr.set('token', 'value');
      expect(mgr.has('token')).toBe(true);
      expect(mgr.has('missing')).toBe(false);
    });

    it('delete removes a secret', () => {
      const mgr = createManager('my-agent', 'local');
      mgr.initialize();
      mgr.set('token', 'value');
      mgr.delete('token');
      expect(mgr.has('token')).toBe(false);
    });

    it('getAll returns all secrets', () => {
      const mgr = createManager('my-agent', 'local');
      mgr.initialize();
      mgr.set('key1', 'val1');
      mgr.set('key2', 'val2');
      expect(mgr.getAll()).toEqual({ 'key1': 'val1', 'key2': 'val2' });
    });

    it('secrets are isolated between agents', () => {
      const mgr1 = createManager('agent-a', 'local');
      mgr1.initialize();
      mgr1.set('token', 'token-a');

      const mgr2 = createManager('agent-b', 'local');
      mgr2.initialize();
      mgr2.set('token', 'token-b');

      expect(mgr1.get('token')).toBe('token-a');
      expect(mgr2.get('token')).toBe('token-b');
    });
  });

  // ── Manual Backend ────────────────────────────────────────────

  describe('manual backend', () => {
    it('still saves to local store as background backup', () => {
      const mgr = createManager('my-agent', 'manual');
      mgr.initialize();
      mgr.set('token', 'value');
      expect(mgr.get('token')).toBe('value');
    });

    it('isConfigured returns false for manual', () => {
      const mgr = createManager('my-agent', 'manual');
      mgr.initialize();
      expect(mgr.isConfigured()).toBe(false);
    });

    it('isConfigured returns true for local', () => {
      const mgr = createManager('my-agent', 'local');
      mgr.initialize();
      expect(mgr.isConfigured()).toBe(true);
    });
  });

  // ── Config Backup/Restore ─────────────────────────────────────

  describe('config backup/restore', () => {
    it('backupFromConfig saves all provided secrets', () => {
      const mgr = createManager('my-agent', 'local');
      mgr.initialize();

      mgr.backupFromConfig({
        telegramToken: 'bot123:ABC',
        telegramChatId: '-100123',
        authToken: 'sk-auth-token',
        dashboardPin: '1234',
        tunnelToken: 'tunnel-jwt',
      });

      expect(mgr.get(SECRET_KEYS.TELEGRAM_TOKEN)).toBe('bot123:ABC');
      expect(mgr.get(SECRET_KEYS.TELEGRAM_CHAT_ID)).toBe('-100123');
      expect(mgr.get(SECRET_KEYS.AUTH_TOKEN)).toBe('sk-auth-token');
      expect(mgr.get(SECRET_KEYS.DASHBOARD_PIN)).toBe('1234');
      expect(mgr.get(SECRET_KEYS.TUNNEL_TOKEN)).toBe('tunnel-jwt');
    });

    it('backupFromConfig skips undefined values', () => {
      const mgr = createManager('my-agent', 'local');
      mgr.initialize();
      mgr.backupFromConfig({ telegramToken: 'bot123:ABC', telegramChatId: '-100123' });

      expect(mgr.get(SECRET_KEYS.TELEGRAM_TOKEN)).toBe('bot123:ABC');
      expect(mgr.get(SECRET_KEYS.AUTH_TOKEN)).toBeNull();
    });

    it('restoreTelegramConfig returns token and chatId', () => {
      const mgr = createManager('my-agent', 'local');
      mgr.initialize();
      mgr.backupFromConfig({ telegramToken: 'bot123:ABC', telegramChatId: '-100123' });

      expect(mgr.restoreTelegramConfig()).toEqual({ token: 'bot123:ABC', chatId: '-100123' });
    });

    it('restoreTelegramConfig returns null when no secrets', () => {
      const mgr = createManager('my-agent', 'local');
      mgr.initialize();
      expect(mgr.restoreTelegramConfig()).toBeNull();
    });

    it('restoreTelegramConfig returns null when only partial data', () => {
      const mgr = createManager('my-agent', 'local');
      mgr.initialize();

      mgr.set(SECRET_KEYS.TELEGRAM_TOKEN, 'bot123:ABC');
      expect(mgr.restoreTelegramConfig()).toBeNull();
    });
  });

  // ── SECRET_KEYS Constants ─────────────────────────────────────

  describe('SECRET_KEYS', () => {
    it('exports all standard secret keys', () => {
      expect(SECRET_KEYS.TELEGRAM_TOKEN).toBe('telegram-token');
      expect(SECRET_KEYS.TELEGRAM_CHAT_ID).toBe('telegram-chat-id');
      expect(SECRET_KEYS.AUTH_TOKEN).toBe('auth-token');
      expect(SECRET_KEYS.DASHBOARD_PIN).toBe('dashboard-pin');
      expect(SECRET_KEYS.TUNNEL_TOKEN).toBe('tunnel-token');
    });
  });

  // ── Bitwarden Fallback ────────────────────────────────────────

  describe('bitwarden fallback', () => {
    it('falls back to local when bitwarden is not available', () => {
      const store = initLocalStore();
      store.setSecret('my-agent', 'telegram-token', 'local-token');

      const mgr = createManager('my-agent', 'bitwarden');
      mgr.initialize();

      expect(mgr.get('telegram-token')).toBe('local-token');
    });
  });
});
