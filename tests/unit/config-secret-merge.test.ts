/**
 * Unit tests for Config + SecretStore merge integration.
 *
 * Verifies that loadConfig() transparently merges encrypted secrets
 * into the config, replacing { "secret": true } placeholders.
 *
 * Tests:
 * - mergeConfigWithSecrets replaces placeholders in messaging array
 * - mergeConfigWithSecrets replaces top-level placeholders
 * - mergeConfigWithSecrets preserves non-secret values
 * - Missing SecretStore returns config unchanged
 * - Full migration + merge roundtrip
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mergeConfigWithSecrets, migrateSecrets } from '../../src/core/SecretMigrator.js';
import { SecretStore } from '../../src/core/SecretStore.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-config-merge-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('Config + SecretStore merge', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('full migration + merge roundtrip preserves all values', () => {
    const originalConfig = {
      projectName: 'test-agent',
      port: 4040,
      authToken: 'sk-my-secret-token',
      dashboardPin: '1234',
      messaging: [
        {
          type: 'telegram',
          enabled: true,
          config: {
            token: 'bot123:ABC-DEF',
            chatId: '-100123456',
            pollIntervalMs: 3000,
            authorizedUserIds: [123, 456],
          },
        },
      ],
      tunnel: {
        enabled: true,
        type: 'quick',
        token: 'eyJ-tunnel-token',
      },
    };

    // Write original config
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(originalConfig, null, 2));

    // Migrate secrets out
    const migration = migrateSecrets(configPath, tmpDir);
    expect(migration.extracted).toBe(5); // authToken, dashboardPin, telegram token, chatId, tunnel token

    // Read the migrated config (has placeholders)
    const migratedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(migratedConfig.authToken).toEqual({ secret: true });
    expect(migratedConfig.messaging[0].config.token).toEqual({ secret: true });

    // Merge should restore all original values
    const merged = mergeConfigWithSecrets(migratedConfig, tmpDir);
    expect(merged.authToken).toBe('sk-my-secret-token');
    expect(merged.dashboardPin).toBe('1234');
    expect((merged.messaging as any)[0].config.token).toBe('bot123:ABC-DEF');
    expect((merged.messaging as any)[0].config.chatId).toBe('-100123456');
    expect((merged.tunnel as any).token).toBe('eyJ-tunnel-token');

    // Non-secret values preserved
    expect(merged.projectName).toBe('test-agent');
    expect(merged.port).toBe(4040);
    expect((merged.messaging as any)[0].config.pollIntervalMs).toBe(3000);
    expect((merged.messaging as any)[0].config.authorizedUserIds).toEqual([123, 456]);
    expect((merged.tunnel as any).enabled).toBe(true);
  });

  it('merge is transparent when no SecretStore exists', () => {
    const config = {
      projectName: 'test',
      authToken: 'sk-plain-token',
      messaging: [{ type: 'telegram', config: { token: 'bot:token' } }],
    };

    const result = mergeConfigWithSecrets(config, tmpDir);
    expect(result).toEqual(config);
  });

  it('merge handles partial secret stores', () => {
    // Only some secrets migrated
    const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
    store.write({ authToken: 'sk-secret' });

    const config = {
      projectName: 'test',
      authToken: { secret: true },
      messaging: [{ type: 'telegram', config: { token: 'plain-token' } }],
    };

    const result = mergeConfigWithSecrets(config as any, tmpDir);
    expect(result.authToken).toBe('sk-secret');
    // Non-migrated fields stay as-is
    expect((result.messaging as any)[0].config.token).toBe('plain-token');
  });

  it('merge preserves config structure for nested arrays', () => {
    const store = new SecretStore({ stateDir: tmpDir, forceFileKey: true });
    store.write({
      messaging: [
        { config: { token: 'bot1:token', chatId: '-100' } },
        { config: { token: 'bot2:token', chatId: '-200' } },
      ],
    });

    const config = {
      messaging: [
        { type: 'telegram', enabled: true, config: { token: { secret: true }, chatId: { secret: true }, pollIntervalMs: 3000 } },
        { type: 'telegram', enabled: false, config: { token: { secret: true }, chatId: { secret: true } } },
      ],
    };

    const result = mergeConfigWithSecrets(config as any, tmpDir);
    expect((result.messaging as any)[0].config.token).toBe('bot1:token');
    expect((result.messaging as any)[0].config.chatId).toBe('-100');
    expect((result.messaging as any)[0].config.pollIntervalMs).toBe(3000);
    expect((result.messaging as any)[0].type).toBe('telegram');
    expect((result.messaging as any)[1].config.token).toBe('bot2:token');
    expect((result.messaging as any)[1].enabled).toBe(false);
  });
});
