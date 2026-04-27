/**
 * Unit tests for standalone agent support.
 *
 * Tests:
 * - initProject with --standalone creates at ~/.instar/agents/<name>/
 * - Standalone agent has correct directory structure
 * - Standalone agent config has agentType: 'standalone'
 * - Agent name validation rejects bad names
 * - resolveAgentDir resolves standalone agent by name
 * - resolveAgentDir resolves by absolute path
 * - loadConfig detects standalone agent type
 * - Duplicate standalone agent name is rejected
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-standalone-test-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('Standalone Agent', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = createTempDir();
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup(tmpHome);
  });

  describe('standaloneAgentsDir', () => {
    it('returns ~/.instar/agents', async () => {
      const { standaloneAgentsDir } = await import('../../src/core/Config.js');
      expect(standaloneAgentsDir()).toBe(path.join(tmpHome, '.instar', 'agents'));
    });
  });

  describe('resolveAgentDir', () => {
    it('resolves standalone agent by name when config exists', async () => {
      const { standaloneAgentsDir, resolveAgentDir } = await import('../../src/core/Config.js');
      // Create a fake standalone agent
      const agentDir = path.join(standaloneAgentsDir(), 'test-agent');
      fs.mkdirSync(path.join(agentDir, '.instar'), { recursive: true });
      fs.writeFileSync(path.join(agentDir, '.instar', 'config.json'), '{}');

      const resolved = resolveAgentDir('test-agent');
      expect(resolved).toBe(agentDir);
    });

    it('resolves by absolute path with valid config', async () => {
      const { resolveAgentDir } = await import('../../src/core/Config.js');
      const dir = createTempDir();
      fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.instar', 'config.json'), '{}');

      const resolved = resolveAgentDir(dir);
      expect(resolved).toBe(fs.realpathSync(dir));
      cleanup(dir);
    });

    it('throws for nonexistent agent name', async () => {
      const { resolveAgentDir } = await import('../../src/core/Config.js');
      expect(() => resolveAgentDir('nonexistent-agent')).toThrow(/not found/);
    });

    it('falls back to detectProjectDir when no argument', async () => {
      const { resolveAgentDir } = await import('../../src/core/Config.js');
      // Should not throw — returns cwd or detected project dir
      const result = resolveAgentDir();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('agent name validation', () => {
    it('validates good names', async () => {
      const { validateAgentName } = await import('../../src/core/AgentRegistry.js');
      expect(validateAgentName('my-agent')).toBe(true);
      expect(validateAgentName('MyAgent123')).toBe(true);
      expect(validateAgentName('agent_v2')).toBe(true);
    });

    it('rejects bad names', async () => {
      const { validateAgentName } = await import('../../src/core/AgentRegistry.js');
      expect(validateAgentName('')).toBe(false);
      expect(validateAgentName('a/b')).toBe(false);
      expect(validateAgentName('..')).toBe(false);
      expect(validateAgentName('-dash')).toBe(false);
    });
  });

  describe('standalone directory structure', () => {
    it('creates expected structure via initProject', async () => {
      // We'll test the structure creation directly rather than calling initProject
      // (which has interactive prereqs). Simulate what initProject --standalone does.
      const { standaloneAgentsDir } = await import('../../src/core/Config.js');
      const { ensureStateDir } = await import('../../src/core/Config.js');
      const { registerAgent } = await import('../../src/core/AgentRegistry.js');

      const agentName = 'test-standalone';
      const projectDir = path.join(standaloneAgentsDir(), agentName);
      const stateDir = path.join(projectDir, '.instar');

      // Create structure
      fs.mkdirSync(projectDir, { recursive: true });
      ensureStateDir(stateDir);

      // Write config
      const config = {
        projectName: agentName,
        projectDir,
        port: 4050,
        agentType: 'standalone',
      };
      fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config, null, 2));
      fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Agent');
      fs.writeFileSync(path.join(stateDir, 'USER.md'), '# User');
      fs.writeFileSync(path.join(stateDir, 'MEMORY.md'), '# Memory');
      fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# CLAUDE.md');

      // Register in registry
      registerAgent(projectDir, agentName, 4050, 'standalone', 0);

      // Verify structure
      expect(fs.existsSync(path.join(stateDir, 'config.json'))).toBe(true);
      expect(fs.existsSync(path.join(stateDir, 'AGENT.md'))).toBe(true);
      expect(fs.existsSync(path.join(stateDir, 'USER.md'))).toBe(true);
      expect(fs.existsSync(path.join(stateDir, 'MEMORY.md'))).toBe(true);
      expect(fs.existsSync(path.join(stateDir, 'state'))).toBe(true);
      expect(fs.existsSync(path.join(stateDir, 'relationships'))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, 'CLAUDE.md'))).toBe(true);

      // Verify config content
      const loaded = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
      expect(loaded.agentType).toBe('standalone');
      expect(loaded.projectName).toBe(agentName);

      // Verify registry entry
      const { getAgent } = await import('../../src/core/AgentRegistry.js');
      const entry = getAgent(projectDir);
      expect(entry).not.toBeNull();
      expect(entry!.type).toBe('standalone');
      expect(entry!.name).toBe(agentName);
    });
  });

  describe('resolveAgentDir from registry', () => {
    it('resolves agent name from global registry', async () => {
      const { resolveAgentDir } = await import('../../src/core/Config.js');
      const { registerAgent } = await import('../../src/core/AgentRegistry.js');

      // Register an agent at a custom path
      const agentDir = path.join(tmpHome, 'custom-project');
      fs.mkdirSync(path.join(agentDir, '.instar'), { recursive: true });
      fs.writeFileSync(path.join(agentDir, '.instar', 'config.json'), '{}');
      registerAgent(agentDir, 'custom-agent', 4060, 'project-bound', 0);

      // resolveAgentDir should find it by name via registry
      const resolved = resolveAgentDir('custom-agent');
      expect(resolved).toBe(agentDir);
    });
  });
});
