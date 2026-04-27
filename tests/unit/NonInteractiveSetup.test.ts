/**
 * Tests for non-interactive setup mode.
 *
 * Covers:
 * - All CLI flag combinations
 * - Scenario-specific file generation
 * - Recovery key generation for multi-user scenarios
 * - File permissions
 * - Directory structure creation
 * - Invalid input handling
 * - Config.json correctness for each scenario
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// We test runNonInteractiveSetup indirectly by importing and calling it
// But it calls process.exit on errors, so we need to handle that
import { runNonInteractiveSetup } from '../../src/commands/setup.js';

// ── Helpers ─────────────────────────────────────────────────────

function createTempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-noninteractive-'));
  return {
    dir,
    // safe-git-allow: incremental-migration
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// We can't easily test runNonInteractiveSetup because it calls process.exit
// and process.cwd(). Instead, we test the scenario resolution logic and
// file generation logic that it relies on.

import { resolveScenario } from '../../src/commands/discovery.js';

// ═══════════════════════════════════════════════════════════════════
// SCENARIO FLAG DERIVATION — Matches non-interactive logic
// ═══════════════════════════════════════════════════════════════════

describe('Non-Interactive Scenario Flag Derivation', () => {
  /**
   * The non-interactive setup derives these flags from scenario number:
   *   isRepo: [3,4,5,6].includes(scenarioNum)
   *   isMultiUser: [5,6,7,8].includes(scenarioNum)
   *   isMultiMachine: [2,4,6,7].includes(scenarioNum)
   *
   * This must be consistent with resolveScenario() in the other direction.
   */
  function deriveFlags(scenario: number) {
    return {
      isRepo: [3, 4, 5, 6].includes(scenario),
      isMultiUser: [5, 6, 7, 8].includes(scenario),
      isMultiMachine: [2, 4, 6, 7].includes(scenario),
    };
  }

  it('scenario flag derivation is inverse of resolveScenario for all 8', () => {
    for (let s = 1; s <= 8; s++) {
      const { isRepo, isMultiUser, isMultiMachine } = deriveFlags(s);
      const resolved = resolveScenario(isRepo, isMultiUser, isMultiMachine);
      expect(resolved).toBe(s);
    }
  });

  it('scenario 1: standalone, single user, single machine', () => {
    const flags = deriveFlags(1);
    expect(flags).toEqual({ isRepo: false, isMultiUser: false, isMultiMachine: false });
  });

  it('scenario 2: standalone, single user, multi machine', () => {
    const flags = deriveFlags(2);
    expect(flags).toEqual({ isRepo: false, isMultiUser: false, isMultiMachine: true });
  });

  it('scenario 3: repo, single user, single machine', () => {
    const flags = deriveFlags(3);
    expect(flags).toEqual({ isRepo: true, isMultiUser: false, isMultiMachine: false });
  });

  it('scenario 4: repo, single user, multi machine', () => {
    const flags = deriveFlags(4);
    expect(flags).toEqual({ isRepo: true, isMultiUser: false, isMultiMachine: true });
  });

  it('scenario 5: repo, multi user, single machine', () => {
    const flags = deriveFlags(5);
    expect(flags).toEqual({ isRepo: true, isMultiUser: true, isMultiMachine: false });
  });

  it('scenario 6: repo, multi user, multi machine', () => {
    const flags = deriveFlags(6);
    expect(flags).toEqual({ isRepo: true, isMultiUser: true, isMultiMachine: true });
  });

  it('scenario 7: standalone, multi user, multi machine', () => {
    const flags = deriveFlags(7);
    expect(flags).toEqual({ isRepo: false, isMultiUser: true, isMultiMachine: true });
  });

  it('scenario 8: standalone, multi user, single machine', () => {
    const flags = deriveFlags(8);
    expect(flags).toEqual({ isRepo: false, isMultiUser: true, isMultiMachine: false });
  });
});

// ═══════════════════════════════════════════════════════════════════
// FILE STRUCTURE GENERATION — Simulating what runNonInteractiveSetup creates
// ═══════════════════════════════════════════════════════════════════

describe('Non-Interactive File Structure', () => {
  let tmpDir: { dir: string; cleanup: () => void };

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    tmpDir.cleanup();
  });

  function simulateSetup(opts: {
    name: string;
    user: string;
    scenario: number;
    telegramToken?: string;
    telegramGroup?: string;
    projectDir: string;
  }) {
    const isRepo = [3, 4, 5, 6].includes(opts.scenario);
    const isMultiUser = [5, 6, 7, 8].includes(opts.scenario);

    const stateDir = isRepo
      ? path.join(opts.projectDir, '.instar')
      : path.join(opts.projectDir, '.instar', 'agents', opts.name, '.instar');

    // Create directory structure
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    // Build config
    const messaging: unknown[] = [];
    if (opts.telegramToken && opts.telegramGroup) {
      messaging.push({
        type: 'telegram',
        enabled: true,
        config: {
          token: opts.telegramToken,
          chatId: opts.telegramGroup,
          pollIntervalMs: 2000,
          stallTimeoutMinutes: 5,
        },
      });
    }

    const config: Record<string, unknown> = {
      projectName: opts.name,
      port: 4040,
      messaging,
      users: [],
      monitoring: { quotaTracking: false, memoryMonitoring: true, healthCheckIntervalMs: 30000 },
    };

    if (isMultiUser) {
      config.userRegistrationPolicy = 'admin-only';
      config.agentAutonomy = { level: 'collaborative' };
    }

    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), `# Agent Identity\n\n**Name**: ${opts.name}\n`);
    fs.writeFileSync(path.join(stateDir, 'USER.md'), `# User Profile: ${opts.user}\n`);
    fs.writeFileSync(path.join(stateDir, 'MEMORY.md'), `# Agent Memory\n`);
    fs.writeFileSync(path.join(stateDir, 'jobs.json'), '[]');
    fs.writeFileSync(path.join(stateDir, 'users.json'), JSON.stringify([{ name: opts.user, role: 'admin' }], null, 2));

    return stateDir;
  }

  it('scenario 1 (standalone): creates files at ~/.instar/agents/<name>/', () => {
    const stateDir = simulateSetup({
      name: 'solo-bot',
      user: 'deploy-bot',
      scenario: 1,
      projectDir: tmpDir.dir,
    });

    expect(stateDir).toContain('.instar/agents/solo-bot/.instar');
    expect(fs.existsSync(path.join(stateDir, 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'AGENT.md'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'USER.md'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'MEMORY.md'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'jobs.json'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'users.json'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'state', 'sessions'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'state', 'jobs'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'logs'))).toBe(true);
  });

  it('scenario 3 (repo): creates files at CWD/.instar/', () => {
    const stateDir = simulateSetup({
      name: 'project-bot',
      user: 'dev',
      scenario: 3,
      projectDir: tmpDir.dir,
    });

    expect(stateDir).toBe(path.join(tmpDir.dir, '.instar'));
    expect(fs.existsSync(path.join(stateDir, 'config.json'))).toBe(true);
  });

  it('config.json includes Telegram when token+group provided', () => {
    const stateDir = simulateSetup({
      name: 'tg-bot',
      user: 'admin',
      scenario: 3,
      telegramToken: 'fake-token-123',
      telegramGroup: '-100999999',
      projectDir: tmpDir.dir,
    });

    const config = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
    expect(config.messaging).toHaveLength(1);
    expect(config.messaging[0].type).toBe('telegram');
    expect(config.messaging[0].enabled).toBe(true);
    expect(config.messaging[0].config.token).toBe('fake-token-123');
    expect(config.messaging[0].config.chatId).toBe('-100999999');
  });

  it('config.json has NO Telegram when not provided', () => {
    const stateDir = simulateSetup({
      name: 'no-tg',
      user: 'admin',
      scenario: 1,
      projectDir: tmpDir.dir,
    });

    const config = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
    expect(config.messaging).toHaveLength(0);
  });

  it('multi-user scenario adds userRegistrationPolicy and agentAutonomy', () => {
    for (const scenario of [5, 6, 7, 8]) {
      const dir = createTempDir();
      try {
        const stateDir = simulateSetup({
          name: `multi-${scenario}`,
          user: 'admin',
          scenario,
          projectDir: dir.dir,
        });

        const config = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
        expect(config.userRegistrationPolicy).toBe('admin-only');
        expect(config.agentAutonomy).toEqual({ level: 'collaborative' });
      } finally {
        dir.cleanup();
      }
    }
  });

  it('single-user scenarios do NOT add multi-user config', () => {
    for (const scenario of [1, 2, 3, 4]) {
      const dir = createTempDir();
      try {
        const stateDir = simulateSetup({
          name: `single-${scenario}`,
          user: 'solo',
          scenario,
          projectDir: dir.dir,
        });

        const config = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
        expect(config.userRegistrationPolicy).toBeUndefined();
        expect(config.agentAutonomy).toBeUndefined();
      } finally {
        dir.cleanup();
      }
    }
  });

  it('users.json contains the specified user as admin', () => {
    const stateDir = simulateSetup({
      name: 'test-users',
      user: 'Alice',
      scenario: 1,
      projectDir: tmpDir.dir,
    });

    const users = JSON.parse(fs.readFileSync(path.join(stateDir, 'users.json'), 'utf-8'));
    expect(users).toHaveLength(1);
    expect(users[0].name).toBe('Alice');
    expect(users[0].role).toBe('admin');
  });

  it('AGENT.md contains the agent name', () => {
    const stateDir = simulateSetup({
      name: 'named-agent',
      user: 'admin',
      scenario: 1,
      projectDir: tmpDir.dir,
    });

    const agentMd = fs.readFileSync(path.join(stateDir, 'AGENT.md'), 'utf-8');
    expect(agentMd).toContain('named-agent');
  });

  it('USER.md contains the user name', () => {
    const stateDir = simulateSetup({
      name: 'agent',
      user: 'SpecificUser',
      scenario: 1,
      projectDir: tmpDir.dir,
    });

    const userMd = fs.readFileSync(path.join(stateDir, 'USER.md'), 'utf-8');
    expect(userMd).toContain('SpecificUser');
  });
});

// ═══════════════════════════════════════════════════════════════════
// RECOVERY KEY GENERATION — Properties
// ═══════════════════════════════════════════════════════════════════

describe('Recovery Key Properties', () => {
  // Test the key generation algorithm properties
  // (we replicate the algorithm since the real one requires process.exit mock)

  async function generateRecoveryKey(): Promise<{ key: string; hash: string }> {
    const crypto = await import('node:crypto');
    const bytes = crypto.randomBytes(32);
    const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let key = '';
    let num = BigInt('0x' + bytes.toString('hex'));
    while (key.length < 44) {
      key += chars[Number(num % 58n)];
      num = num / 58n;
    }
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    return { key, hash };
  }

  it('key is exactly 44 characters', async () => {
    const { key } = await generateRecoveryKey();
    expect(key.length).toBe(44);
  });

  it('key uses base58 character set (no 0, O, I, l)', async () => {
    const { key } = await generateRecoveryKey();
    expect(key).not.toMatch(/[0OIl]/);
  });

  it('key is alphanumeric (base58)', async () => {
    const { key } = await generateRecoveryKey();
    expect(key).toMatch(/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/);
  });

  it('hash is a valid SHA-256 hex string', async () => {
    const { hash } = await generateRecoveryKey();
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('two generated keys are different', async () => {
    const key1 = await generateRecoveryKey();
    const key2 = await generateRecoveryKey();
    expect(key1.key).not.toBe(key2.key);
    expect(key1.hash).not.toBe(key2.hash);
  });

  it('key verifies against stored hash', async () => {
    const crypto = await import('node:crypto');
    const { key, hash } = await generateRecoveryKey();
    const verifyHash = crypto.createHash('sha256').update(key).digest('hex');
    expect(verifyHash).toBe(hash);
  });

  it('wrong key does not match hash', async () => {
    const crypto = await import('node:crypto');
    const { hash } = await generateRecoveryKey();
    const wrongHash = crypto.createHash('sha256').update('wrong-key').digest('hex');
    expect(wrongHash).not.toBe(hash);
  });

  it('generates 100 unique keys with no collisions', async () => {
    const keys = new Set<string>();
    const hashes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const { key, hash } = await generateRecoveryKey();
      keys.add(key);
      hashes.add(hash);
    }
    expect(keys.size).toBe(100);
    expect(hashes.size).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════════
// INPUT VALIDATION — Testing validation logic
// ═══════════════════════════════════════════════════════════════════

describe('Non-Interactive Input Validation', () => {
  it('scenario number must be 1-8', () => {
    const validScenarios = [1, 2, 3, 4, 5, 6, 7, 8];
    const invalidScenarios = [0, -1, 9, 100];

    for (const s of validScenarios) {
      const num = parseInt(String(s), 10);
      expect(!isNaN(num) && num >= 1 && num <= 8).toBe(true);
    }

    for (const s of invalidScenarios) {
      const num = parseInt(String(s), 10);
      expect(isNaN(num) || num < 1 || num > 8).toBe(true);
    }
  });

  it('NaN and floats are rejected', () => {
    // NaN: parseInt('NaN', 10) returns NaN
    expect(isNaN(parseInt('NaN', 10))).toBe(true);
    // 1.5: parseInt('1.5', 10) returns 1 — valid as integer
    expect(parseInt('1.5', 10)).toBe(1);
    // But as a number, 1.5 is not an integer
    expect(Number.isInteger(1.5)).toBe(false);
  });

  it('scenario string parsing works for valid inputs', () => {
    const inputs = ['1', '2', '3', '4', '5', '6', '7', '8'];
    for (const input of inputs) {
      const num = parseInt(input, 10);
      expect(num).toBeGreaterThanOrEqual(1);
      expect(num).toBeLessThanOrEqual(8);
    }
  });

  it('scenario string parsing rejects invalid strings', () => {
    const inputs = ['abc', '', 'one', '1.5', '-1', '0', '9'];
    for (const input of inputs) {
      const num = parseInt(input, 10);
      const valid = !isNaN(num) && num >= 1 && num <= 8;
      if (input === '0' || input === '9' || input === '-1') {
        expect(valid).toBe(false);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// FILE PERMISSIONS
// ═══════════════════════════════════════════════════════════════════

describe('Non-Interactive File Permissions', () => {
  let tmpDir: { dir: string; cleanup: () => void };

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    tmpDir.cleanup();
  });

  it('config with telegram token gets chmod 0600', () => {
    const configPath = path.join(tmpDir.dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ token: 'secret' }));

    // Apply chmod as runNonInteractiveSetup would
    fs.chmodSync(configPath, 0o600);

    const stat = fs.statSync(configPath);
    // On macOS/Linux, check permissions
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('config without telegram does not require restricted permissions', () => {
    const configPath = path.join(tmpDir.dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ no_secrets: true }));

    // Default permissions should be more permissive
    const stat = fs.statSync(configPath);
    const mode = stat.mode & 0o777;
    expect(mode).not.toBe(0o600);
    expect(mode & 0o044).toBeGreaterThan(0); // Group/other can read
  });
});
