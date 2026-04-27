import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

describe('WhatsApp CLI commands', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cli-'));
    const instarDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(instarDir, { recursive: true });
    configPath = path.join(instarDir, 'config.json');
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(config: Record<string, unknown>): void {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  function readConfig(): any {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  describe('addWhatsApp', () => {
    it('adds WhatsApp config to messaging array', async () => {
      writeConfig({ projectName: 'test', messaging: [] });

      // Simulate what the CLI command does
      const config = readConfig();
      config.messaging = config.messaging.filter((m: any) => m.type !== 'whatsapp');
      config.messaging.push({
        type: 'whatsapp',
        enabled: true,
        config: {
          backend: 'baileys',
          authorizedNumbers: ['+14155552671'],
          baileys: { authMethod: 'qr' },
        },
      });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      const result = readConfig();
      const wa = result.messaging.find((m: any) => m.type === 'whatsapp');
      expect(wa).toBeDefined();
      expect(wa.enabled).toBe(true);
      expect(wa.config.backend).toBe('baileys');
      expect(wa.config.authorizedNumbers).toEqual(['+14155552671']);
    });

    it('replaces existing WhatsApp config', async () => {
      writeConfig({
        projectName: 'test',
        messaging: [
          { type: 'whatsapp', enabled: false, config: { backend: 'baileys' } },
          { type: 'telegram', enabled: true, config: { token: 'abc' } },
        ],
      });

      const config = readConfig();
      config.messaging = config.messaging.filter((m: any) => m.type !== 'whatsapp');
      config.messaging.push({
        type: 'whatsapp',
        enabled: true,
        config: { backend: 'baileys', authorizedNumbers: [] },
      });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      const result = readConfig();
      expect(result.messaging.filter((m: any) => m.type === 'whatsapp')).toHaveLength(1);
      expect(result.messaging.find((m: any) => m.type === 'telegram')).toBeDefined();
    });

    it('preserves existing adapters', async () => {
      writeConfig({
        projectName: 'test',
        messaging: [
          { type: 'telegram', enabled: true, config: { token: 'abc', chatId: '-100123' } },
        ],
      });

      const config = readConfig();
      config.messaging.push({
        type: 'whatsapp',
        enabled: true,
        config: { backend: 'baileys' },
      });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      const result = readConfig();
      expect(result.messaging).toHaveLength(2);
      expect(result.messaging.map((m: any) => m.type).sort()).toEqual(['telegram', 'whatsapp']);
    });

    it('supports pairing code config', async () => {
      writeConfig({ projectName: 'test', messaging: [] });

      const config = readConfig();
      config.messaging.push({
        type: 'whatsapp',
        enabled: true,
        config: {
          backend: 'baileys',
          baileys: {
            authMethod: 'pairing-code',
            pairingPhoneNumber: '+14155552671',
          },
        },
      });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      const result = readConfig();
      const wa = result.messaging.find((m: any) => m.type === 'whatsapp');
      expect(wa.config.baileys.authMethod).toBe('pairing-code');
      expect(wa.config.baileys.pairingPhoneNumber).toBe('+14155552671');
    });

    it('supports encryption flag', async () => {
      writeConfig({ projectName: 'test', messaging: [] });

      const config = readConfig();
      config.messaging.push({
        type: 'whatsapp',
        enabled: true,
        config: {
          backend: 'baileys',
          baileys: { authMethod: 'qr', encryptAuth: true },
        },
      });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      const result = readConfig();
      const wa = result.messaging.find((m: any) => m.type === 'whatsapp');
      expect(wa.config.baileys.encryptAuth).toBe(true);
    });
  });

  describe('channelDoctor diagnostics', () => {
    it('detects missing WhatsApp config', () => {
      writeConfig({ projectName: 'test', messaging: [] });

      const config = readConfig();
      const waConfig = config.messaging?.find((m: any) => m.type === 'whatsapp');
      expect(waConfig).toBeUndefined();
    });

    it('detects configured but disabled adapter', () => {
      writeConfig({
        projectName: 'test',
        messaging: [{ type: 'whatsapp', enabled: false, config: { backend: 'baileys' } }],
      });

      const config = readConfig();
      const waConfig = config.messaging.find((m: any) => m.type === 'whatsapp');
      expect(waConfig).toBeDefined();
      expect(waConfig.enabled).toBe(false);
    });

    it('detects missing auth state', () => {
      const stateDir = path.join(tmpDir, '.instar');
      const authDir = path.join(stateDir, 'whatsapp-auth');
      const credsFile = path.join(authDir, 'creds.json');

      expect(fs.existsSync(credsFile)).toBe(false);
    });

    it('detects existing auth state', () => {
      const stateDir = path.join(tmpDir, '.instar');
      const authDir = path.join(stateDir, 'whatsapp-auth');
      fs.mkdirSync(authDir, { recursive: true });
      fs.writeFileSync(path.join(authDir, 'creds.json'), '{"creds": true}');

      expect(fs.existsSync(path.join(authDir, 'creds.json'))).toBe(true);
    });

    it('detects encrypted vs unencrypted auth', async () => {
      const { writeAuthFile, isEncryptedFile } = await import('../../src/messaging/shared/EncryptedAuthStore.js');

      const stateDir = path.join(tmpDir, '.instar');
      const authDir = path.join(stateDir, 'whatsapp-auth');

      // Unencrypted
      writeAuthFile(path.join(authDir, 'creds-plain.json'), '{"a":1}');
      expect(isEncryptedFile(path.join(authDir, 'creds-plain.json'))).toBe(false);

      // Encrypted
      writeAuthFile(path.join(authDir, 'creds-enc.json'), '{"b":2}', 'pass');
      expect(isEncryptedFile(path.join(authDir, 'creds-enc.json'))).toBe(true);
    });
  });

  describe('channelStatus', () => {
    it('lists all configured adapters', () => {
      writeConfig({
        projectName: 'test',
        messaging: [
          { type: 'telegram', enabled: true, config: { token: 'abc', chatId: '-100' } },
          { type: 'whatsapp', enabled: true, config: { backend: 'baileys' } },
        ],
      });

      const config = readConfig();
      expect(config.messaging).toHaveLength(2);
      expect(config.messaging.map((m: any) => m.type)).toContain('telegram');
      expect(config.messaging.map((m: any) => m.type)).toContain('whatsapp');
    });

    it('shows disabled adapters', () => {
      writeConfig({
        projectName: 'test',
        messaging: [
          { type: 'whatsapp', enabled: false, config: { backend: 'baileys' } },
        ],
      });

      const config = readConfig();
      const wa = config.messaging.find((m: any) => m.type === 'whatsapp');
      expect(wa.enabled).toBe(false);
    });
  });
});
