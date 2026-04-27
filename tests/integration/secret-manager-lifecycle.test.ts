/**
 * Integration tests for secret management lifecycle.
 *
 * Tests the full nuke → reinstall cycle, cross-agent isolation,
 * backend preference persistence, and config round-trips.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SecretManager, SECRET_KEYS } from '../../src/core/SecretManager.js';
import { GlobalSecretStore } from '../../src/core/GlobalSecretStore.js';

describe('Secret Manager Lifecycle', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-lifecycle-'));
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createMgr(agentName: string) {
    const mgr = new SecretManager({ agentName, backend: 'local', basePath: tmpDir });
    mgr.initialize();
    return mgr;
  }

  // ── Setup → Nuke → Reinstall ──────────────────────────────────

  describe('setup → nuke → reinstall cycle', () => {
    it('secrets survive agent deletion via local store backup', () => {
      // PHASE 1: Initial setup
      const mgr1 = createMgr('dude');
      mgr1.backupFromConfig({
        telegramToken: 'bot777:SECRETABC',
        telegramChatId: '-100999888',
        authToken: 'uuid-auth-token',
      });

      expect(mgr1.get(SECRET_KEYS.TELEGRAM_TOKEN)).toBe('bot777:SECRETABC');
      expect(mgr1.get(SECRET_KEYS.TELEGRAM_CHAT_ID)).toBe('-100999888');
      expect(mgr1.get(SECRET_KEYS.AUTH_TOKEN)).toBe('uuid-auth-token');

      // PHASE 2: Simulate nuke (global store at ~/.instar/secrets/ survives)

      // PHASE 3: Reinstall
      const mgr2 = createMgr('dude');
      const restored = mgr2.restoreTelegramConfig();
      expect(restored).toEqual({ token: 'bot777:SECRETABC', chatId: '-100999888' });
      expect(mgr2.get(SECRET_KEYS.AUTH_TOKEN)).toBe('uuid-auth-token');
    });
  });

  // ── Cross-Agent Isolation ─────────────────────────────────────

  describe('cross-agent isolation', () => {
    it('different agents have separate secret namespaces', () => {
      const mgrA = createMgr('agent-alpha');
      mgrA.set(SECRET_KEYS.TELEGRAM_TOKEN, 'alpha-token');

      const mgrB = createMgr('agent-beta');
      mgrB.set(SECRET_KEYS.TELEGRAM_TOKEN, 'beta-token');

      expect(mgrA.get(SECRET_KEYS.TELEGRAM_TOKEN)).toBe('alpha-token');
      expect(mgrB.get(SECRET_KEYS.TELEGRAM_TOKEN)).toBe('beta-token');

      mgrA.delete(SECRET_KEYS.TELEGRAM_TOKEN);
      expect(mgrA.get(SECRET_KEYS.TELEGRAM_TOKEN)).toBeNull();
      expect(mgrB.get(SECRET_KEYS.TELEGRAM_TOKEN)).toBe('beta-token');
    });
  });

  // ── Backend Preference Persistence ────────────────────────────

  describe('backend preference persistence', () => {
    it('preference survives across instances', () => {
      const mgr1 = new SecretManager({ agentName: 'test', basePath: tmpDir });
      mgr1.configureBackend('local');

      const mgr2 = new SecretManager({ agentName: 'test', basePath: tmpDir });
      mgr2.initialize();
      expect(mgr2.getBackend()).toBe('local');
    });

    it('preference includes metadata', () => {
      const mgr = new SecretManager({ agentName: 'test', basePath: tmpDir });
      mgr.configureBackend('bitwarden', { bitwardenEmail: 'test@example.com' });

      const pref = mgr.getPreference();
      expect(pref!.backend).toBe('bitwarden');
      expect(pref!.bitwardenEmail).toBe('test@example.com');
      expect(pref!.configuredAt).toBeDefined();
    });
  });

  // ── Full Config Round-Trip ────────────────────────────────────

  describe('full config round-trip', () => {
    it('all standard secret keys round-trip correctly', () => {
      const mgr = createMgr('full-test');
      mgr.backupFromConfig({
        telegramToken: 'bot111:XYZ',
        telegramChatId: '-100555',
        authToken: 'auth-uuid-123',
        dashboardPin: '9999',
        tunnelToken: 'eyJhbGci.tunnel',
      });

      // Simulate reinstall
      const mgr2 = createMgr('full-test');
      expect(mgr2.get(SECRET_KEYS.TELEGRAM_TOKEN)).toBe('bot111:XYZ');
      expect(mgr2.get(SECRET_KEYS.TELEGRAM_CHAT_ID)).toBe('-100555');
      expect(mgr2.get(SECRET_KEYS.AUTH_TOKEN)).toBe('auth-uuid-123');
      expect(mgr2.get(SECRET_KEYS.DASHBOARD_PIN)).toBe('9999');
      expect(mgr2.get(SECRET_KEYS.TUNNEL_TOKEN)).toBe('eyJhbGci.tunnel');

      const telegram = mgr2.restoreTelegramConfig();
      expect(telegram).toEqual({ token: 'bot111:XYZ', chatId: '-100555' });
    });
  });
});
