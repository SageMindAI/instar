/**
 * Unit tests for SecretMigrator — config.json secret extraction.
 *
 * Tests:
 * - Extracts known secret fields from config
 * - Replaces extracted fields with { "secret": true }
 * - Idempotent (re-running doesn't double-extract)
 * - Skips null/undefined/empty fields
 * - Handles array wildcards (messaging.*.config.token)
 * - mergeConfigWithSecrets reconstructs full config
 * - Missing secret store returns config unchanged
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { migrateSecrets, mergeConfigWithSecrets } from '../../src/core/SecretMigrator.js';
import { SecretStore } from '../../src/core/SecretStore.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-migrator-test-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeConfig(dir: string, config: Record<string, unknown>): string {
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

describe('SecretMigrator', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── migrateSecrets ──────────────────────────────────────────────

  describe('migrateSecrets', () => {
    it('extracts authToken from config', () => {
      const configPath = writeConfig(tmpDir, {
        projectName: 'test',
        authToken: 'sk-my-secret-token',
      });

      const result = migrateSecrets(configPath, tmpDir);

      expect(result.extracted).toBe(1);
      expect(result.fields).toContain('authToken');
      expect(result.configModified).toBe(true);

      // Config should have placeholder
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(config.authToken).toEqual({ secret: true });

      // Secret should be in store
      const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
      expect(store.get('authToken')).toBe('sk-my-secret-token');
    });

    it('extracts Telegram token and chatId', () => {
      const configPath = writeConfig(tmpDir, {
        messaging: [
          {
            type: 'telegram',
            enabled: true,
            config: {
              token: 'bot123:ABC-DEF',
              chatId: '-100123456',
              pollIntervalMs: 3000,
            },
          },
        ],
      });

      const result = migrateSecrets(configPath, tmpDir);

      expect(result.extracted).toBe(2);
      expect(result.fields).toContain('messaging.0.config.token');
      expect(result.fields).toContain('messaging.0.config.chatId');

      // Config should have placeholders
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(config.messaging[0].config.token).toEqual({ secret: true });
      expect(config.messaging[0].config.chatId).toEqual({ secret: true });
      // Non-secret fields preserved
      expect(config.messaging[0].config.pollIntervalMs).toBe(3000);

      // Secrets in store
      const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
      expect(store.get('messaging.0.config.token')).toBe('bot123:ABC-DEF');
      expect(store.get('messaging.0.config.chatId')).toBe('-100123456');
    });

    it('extracts tunnel token', () => {
      const configPath = writeConfig(tmpDir, {
        tunnel: { enabled: true, token: 'eyJ-tunnel-token' },
      });

      const result = migrateSecrets(configPath, tmpDir);

      expect(result.extracted).toBe(1);
      expect(result.fields).toContain('tunnel.token');

      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(config.tunnel.token).toEqual({ secret: true });
      expect(config.tunnel.enabled).toBe(true);
    });

    it('extracts dashboardPin', () => {
      const configPath = writeConfig(tmpDir, {
        dashboardPin: '1234',
      });

      const result = migrateSecrets(configPath, tmpDir);

      expect(result.extracted).toBe(1);
      expect(result.fields).toContain('dashboardPin');
    });

    it('is idempotent — re-running skips already-migrated fields', () => {
      const configPath = writeConfig(tmpDir, {
        authToken: 'sk-secret',
      });

      const result1 = migrateSecrets(configPath, tmpDir);
      expect(result1.extracted).toBe(1);

      const result2 = migrateSecrets(configPath, tmpDir);
      expect(result2.extracted).toBe(0);
      expect(result2.configModified).toBe(false);

      // Store still has the value
      const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
      expect(store.get('authToken')).toBe('sk-secret');
    });

    it('skips null/undefined fields', () => {
      const configPath = writeConfig(tmpDir, {
        authToken: null,
      });

      const result = migrateSecrets(configPath, tmpDir);
      expect(result.extracted).toBe(0);
    });

    it('skips empty string fields', () => {
      const configPath = writeConfig(tmpDir, {
        authToken: '',
      });

      const result = migrateSecrets(configPath, tmpDir);
      expect(result.extracted).toBe(0);
    });

    it('handles missing config file', () => {
      const result = migrateSecrets(path.join(tmpDir, 'nonexistent.json'), tmpDir);
      expect(result.extracted).toBe(0);
    });

    it('handles config with no secret fields', () => {
      const configPath = writeConfig(tmpDir, {
        projectName: 'test',
        port: 4040,
        sessions: { maxSessions: 3 },
      });

      const result = migrateSecrets(configPath, tmpDir);
      expect(result.extracted).toBe(0);
      expect(result.configModified).toBe(false);
    });

    it('handles multiple messaging adapters', () => {
      const configPath = writeConfig(tmpDir, {
        messaging: [
          { type: 'telegram', config: { token: 'bot1-token', chatId: '-100' } },
          { type: 'telegram', config: { token: 'bot2-token', chatId: '-200' } },
        ],
      });

      const result = migrateSecrets(configPath, tmpDir);
      expect(result.extracted).toBe(4); // 2 tokens + 2 chatIds

      const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
      expect(store.get('messaging.0.config.token')).toBe('bot1-token');
      expect(store.get('messaging.1.config.token')).toBe('bot2-token');
    });

    it('extracts multiple field types in one pass', () => {
      const configPath = writeConfig(tmpDir, {
        authToken: 'sk-secret',
        dashboardPin: '5678',
        messaging: [{ type: 'telegram', config: { token: 'bot:token' } }],
        tunnel: { token: 'tunnel-token' },
      });

      const result = migrateSecrets(configPath, tmpDir);
      expect(result.extracted).toBe(4);
    });
  });

  // ── mergeConfigWithSecrets ──────────────────────────────────────

  describe('mergeConfigWithSecrets', () => {
    it('replaces placeholders with secret values', () => {
      // Set up migrated state
      const configPath = writeConfig(tmpDir, {
        authToken: 'sk-secret',
        messaging: [{ type: 'telegram', config: { token: 'bot:token', pollIntervalMs: 3000 } }],
      });
      migrateSecrets(configPath, tmpDir);

      // Read the migrated config (has placeholders)
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(config.authToken).toEqual({ secret: true });

      // Merge should restore secret values
      const merged = mergeConfigWithSecrets(config, tmpDir);
      expect(merged.authToken).toBe('sk-secret');
      expect((merged.messaging as any)[0].config.token).toBe('bot:token');
      // Non-secret preserved
      expect((merged.messaging as any)[0].config.pollIntervalMs).toBe(3000);
    });

    it('returns config unchanged when no secret store exists', () => {
      const config = { projectName: 'test', authToken: 'sk-token' };
      const result = mergeConfigWithSecrets(config, tmpDir);
      expect(result).toEqual(config);
    });

    it('handles config with no placeholders (pre-migration)', () => {
      // Write some secrets manually
      const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
      store.write({ extraKey: 'extra-value' });

      const config = { projectName: 'test', port: 4040 };
      const result = mergeConfigWithSecrets(config, tmpDir);
      // Config unchanged since no placeholders match
      expect(result.projectName).toBe('test');
      expect(result.port).toBe(4040);
    });
  });
});
