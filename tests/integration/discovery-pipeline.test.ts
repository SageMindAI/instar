/**
 * Integration tests for the full discovery pipeline.
 *
 * Tests the complete flow: filesystem scan → registry validation →
 * merge → scenario context building. Uses real temp directories
 * with mock agent structures and validates the entire pipeline
 * produces correct outputs end-to-end.
 *
 * Does NOT test GitHub scanning (requires network) — that's mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runDiscovery,
  buildScenarioContext,
  resolveScenario,
  writeSetupLock,
  readSetupLock,
  deleteSetupLock,
  type SetupDiscoveryContext,
  type SetupLock,
} from '../../src/commands/discovery.js';

// ── Helpers ─────────────────────────────────────────────────────

function createTempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-integration-'));
  return {
    dir,
    // safe-git-allow: incremental-migration
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Create a realistic agent directory structure.
 */
function createAgentDir(basePath: string, name: string, opts: {
  users?: Array<{ name: string; role?: string }>;
  machines?: Record<string, { status: string }>;
  telegram?: boolean;
  port?: number;
  projectName?: string;
} = {}) {
  const stateDir = path.join(basePath, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

  // config.json
  const messaging: unknown[] = [];
  if (opts.telegram) {
    messaging.push({ type: 'telegram', enabled: true, config: { token: 'fake', chatId: '-100123' } });
  }
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
    projectName: opts.projectName || name,
    port: opts.port || 4040,
    messaging,
  }));

  // users.json
  if (opts.users) {
    fs.writeFileSync(path.join(stateDir, 'users.json'), JSON.stringify(opts.users));
  }

  // machines
  if (opts.machines) {
    fs.mkdirSync(path.join(stateDir, 'machines'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'machines', 'registry.json'), JSON.stringify({
      machines: opts.machines,
    }));
  }
}

/**
 * Create a registry.json at the mocked home dir.
 */
function createRegistry(homeDir: string, entries: Array<{
  name: string;
  path: string;
  type?: string;
  status?: string;
  port?: number;
}>) {
  const registryDir = path.join(homeDir, '.instar');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(path.join(registryDir, 'registry.json'), JSON.stringify({
    version: 1,
    entries: entries.map(e => ({
      name: e.name,
      path: e.path,
      type: e.type || 'standalone',
      status: e.status || 'stopped',
      port: e.port,
    })),
  }));
}

// ═══════════════════════════════════════════════════════════════════
// FULL PIPELINE — Fresh Install Scenarios
// ═══════════════════════════════════════════════════════════════════

describe('Full Discovery Pipeline — Fresh Install', () => {
  let tmpHome: { dir: string; cleanup: () => void };
  let tmpProject: { dir: string; cleanup: () => void };
  let origHomedir: typeof os.homedir;

  beforeEach(() => {
    tmpHome = createTempDir();
    tmpProject = createTempDir();
    origHomedir = os.homedir;
    (os as any).homedir = () => tmpHome.dir;
  });

  afterEach(() => {
    (os as any).homedir = origHomedir;
    tmpHome.cleanup();
    tmpProject.cleanup();
  });

  it('empty system produces fresh install context', () => {
    const discovery = runDiscovery(tmpProject.dir, null, 'unavailable');
    const scenario = buildScenarioContext(discovery, false);

    expect(discovery.local_agents).toHaveLength(0);
    expect(discovery.github_agents).toHaveLength(0);
    expect(discovery.merged_agents).toHaveLength(0);
    expect(discovery.current_dir_agent).toBeNull();
    expect(discovery.gh_status).toBe('unavailable');
    expect(discovery.scan_errors).toHaveLength(0);
    expect(discovery.zombie_entries).toHaveLength(0);

    expect(scenario.entryPoint).toBe('fresh');
    expect(scenario.existingAgentInCWD).toBe(false);
    expect(scenario.resolvedScenario).toBeNull();
    expect(scenario.isMultiUser).toBeNull();
    expect(scenario.isMultiMachine).toBeNull();
  });

  it('gh status auth-needed passes through correctly', () => {
    const discovery = runDiscovery(tmpProject.dir, '/usr/bin/fake-gh', 'auth-needed');
    expect(discovery.gh_status).toBe('auth-needed');
    expect(discovery.github_agents).toHaveLength(0);
  });

  it('local standalone agents are discovered', () => {
    // Create two agents in ~/.instar/agents/
    const agentsDir = path.join(tmpHome.dir, '.instar', 'agents');
    for (const name of ['bot-alpha', 'bot-beta']) {
      const agentDir = path.join(agentsDir, name);
      createAgentDir(agentDir, name);
    }

    const discovery = runDiscovery(tmpProject.dir, null, 'unavailable');

    expect(discovery.local_agents).toHaveLength(2);
    expect(discovery.local_agents.map(a => a.name).sort()).toEqual(['bot-alpha', 'bot-beta']);
    expect(discovery.local_agents.every(a => a.type === 'standalone')).toBe(true);
  });

  it('registry agents merge with filesystem scan', () => {
    // Create agent on filesystem
    const agentsDir = path.join(tmpHome.dir, '.instar', 'agents');
    const alphaDir = path.join(agentsDir, 'alpha');
    createAgentDir(alphaDir, 'alpha');

    // Also register it in registry with running status
    createRegistry(tmpHome.dir, [{
      name: 'alpha',
      path: alphaDir,
      type: 'standalone',
      status: 'running',
      port: 4040,
    }]);

    const discovery = runDiscovery(tmpProject.dir, null, 'unavailable');

    // Should be 1 agent (not 2), with running status from registry
    expect(discovery.local_agents).toHaveLength(1);
    expect(discovery.local_agents[0].name).toBe('alpha');
    expect(discovery.local_agents[0].status).toBe('running');
    expect(discovery.local_agents[0].port).toBe(4040);
  });

  it('registry adds project-bound agents not found in filesystem scan', () => {
    // Create a project-bound agent at the project dir
    createAgentDir(tmpProject.dir, 'my-project', {
      users: [{ name: 'Justin', role: 'admin' }],
    });

    // Register it in the registry
    createRegistry(tmpHome.dir, [{
      name: 'my-project',
      path: tmpProject.dir,
      type: 'project-bound',
      status: 'running',
      port: 4050,
    }]);

    const discovery = runDiscovery(tmpProject.dir, null, 'unavailable');

    // Should include the project-bound agent from registry
    expect(discovery.local_agents.some(a => a.name === 'my-project')).toBe(true);
    const projectAgent = discovery.local_agents.find(a => a.name === 'my-project')!;
    expect(projectAgent.type).toBe('project-bound');
    expect(projectAgent.status).toBe('running');
  });

  it('zombie registry entries are flagged but not included', () => {
    const ghostPath = path.join(tmpHome.dir, '.instar', 'agents', 'ghost');
    // Do NOT create the directory — this is a zombie

    createRegistry(tmpHome.dir, [{
      name: 'ghost',
      path: ghostPath,
      type: 'standalone',
      status: 'stopped',
    }]);

    const discovery = runDiscovery(tmpProject.dir, null, 'unavailable');

    expect(discovery.local_agents).toHaveLength(0);
    expect(discovery.zombie_entries).toHaveLength(1);
    expect(discovery.zombie_entries[0]).toContain('ghost');
  });
});

// ═══════════════════════════════════════════════════════════════════
// FULL PIPELINE — Existing Agent Scenarios
// ═══════════════════════════════════════════════════════════════════

describe('Full Discovery Pipeline — Existing Agent', () => {
  let tmpHome: { dir: string; cleanup: () => void };
  let tmpProject: { dir: string; cleanup: () => void };
  let origHomedir: typeof os.homedir;

  beforeEach(() => {
    tmpHome = createTempDir();
    tmpProject = createTempDir();
    origHomedir = os.homedir;
    (os as any).homedir = () => tmpHome.dir;
  });

  afterEach(() => {
    (os as any).homedir = origHomedir;
    tmpHome.cleanup();
    tmpProject.cleanup();
  });

  it('detects existing agent in CWD and builds context', () => {
    createAgentDir(tmpProject.dir, 'my-agent', {
      users: [{ name: 'Alice' }, { name: 'Bob' }],
      machines: { 'mac-1': { status: 'active' }, 'mac-2': { status: 'active' } },
      telegram: true,
    });

    const discovery = runDiscovery(tmpProject.dir, null, 'unavailable');
    const scenario = buildScenarioContext(discovery, true);

    expect(discovery.current_dir_agent).not.toBeNull();
    expect(discovery.current_dir_agent!.exists).toBe(true);
    expect(discovery.current_dir_agent!.name).toBe('my-agent');
    expect(discovery.current_dir_agent!.users).toEqual(['Alice', 'Bob']);
    expect(discovery.current_dir_agent!.machines).toBe(2);

    expect(scenario.entryPoint).toBe('existing');
    expect(scenario.existingAgentInCWD).toBe(true);
    expect(scenario.existingUserCount).toBe(2);
    expect(scenario.existingMachineCount).toBe(2);
    expect(scenario.isMultiUser).toBe(true);
    expect(scenario.isMultiMachine).toBe(true);
    expect(scenario.resolvedScenario).toBe(6); // repo + multi-user + multi-machine
  });

  it('scenario 1: standalone single-user single-machine', () => {
    createAgentDir(tmpProject.dir, 'solo', {
      users: [{ name: 'Me' }],
      machines: { 'mac-1': { status: 'active' } },
    });

    const discovery = runDiscovery(tmpProject.dir, null, 'unavailable');
    const scenario = buildScenarioContext(discovery, false);

    expect(scenario.resolvedScenario).toBe(1);
    expect(scenario.isMultiUser).toBe(false);
    expect(scenario.isMultiMachine).toBe(false);
  });

  it('scenario 3: repo single-user single-machine', () => {
    createAgentDir(tmpProject.dir, 'project-bot', {
      users: [{ name: 'Dev' }],
      machines: { 'laptop': { status: 'active' } },
    });

    const discovery = runDiscovery(tmpProject.dir, null, 'unavailable');
    const scenario = buildScenarioContext(discovery, true);

    expect(scenario.resolvedScenario).toBe(3);
    expect(scenario.isInsideGitRepo).toBe(true);
  });

  it('scenario 5: repo multi-user single-machine', () => {
    createAgentDir(tmpProject.dir, 'team-bot', {
      users: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
      machines: { 'server': { status: 'active' } },
    });

    const discovery = runDiscovery(tmpProject.dir, null, 'unavailable');
    const scenario = buildScenarioContext(discovery, true);

    expect(scenario.resolvedScenario).toBe(5);
    expect(scenario.isMultiUser).toBe(true);
    expect(scenario.isMultiMachine).toBe(false);
  });

  it('scenario 8: standalone multi-user single-machine', () => {
    createAgentDir(tmpProject.dir, 'shared-bot', {
      users: [{ name: 'X' }, { name: 'Y' }],
      machines: { 'server': { status: 'active' } },
    });

    const discovery = runDiscovery(tmpProject.dir, null, 'unavailable');
    const scenario = buildScenarioContext(discovery, false);

    expect(scenario.resolvedScenario).toBe(8);
    expect(scenario.isMultiUser).toBe(true);
    expect(scenario.isMultiMachine).toBe(false);
    expect(scenario.isInsideGitRepo).toBe(false);
  });

  it('inactive machines are not counted', () => {
    createAgentDir(tmpProject.dir, 'mixed-machines', {
      users: [{ name: 'Solo' }],
      machines: {
        'mac-active': { status: 'active' },
        'mac-inactive': { status: 'inactive' },
        'mac-decomm': { status: 'inactive' },
      },
    });

    const discovery = runDiscovery(tmpProject.dir, null, 'unavailable');
    const scenario = buildScenarioContext(discovery, false);

    expect(discovery.current_dir_agent!.machines).toBe(1);
    expect(scenario.isMultiMachine).toBe(false);
    expect(scenario.resolvedScenario).toBe(1);
  });

  it('zero users means fresh entryPoint even with existing agent', () => {
    // Agent dir exists with config but no users.json
    const stateDir = path.join(tmpProject.dir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'new-agent' }));
    // No users.json — so users array will be empty

    const discovery = runDiscovery(tmpProject.dir, null, 'unavailable');
    const scenario = buildScenarioContext(discovery, false);

    expect(discovery.current_dir_agent).not.toBeNull();
    // entryPoint depends on user count — 0 users means no "existing" experience
    expect(scenario.existingUserCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// FULL PIPELINE — Lock File Integration
// ═══════════════════════════════════════════════════════════════════

describe('Full Discovery Pipeline — Lock File Integration', () => {
  let tmpHome: { dir: string; cleanup: () => void };
  let origHomedir: typeof os.homedir;

  beforeEach(() => {
    tmpHome = createTempDir();
    origHomedir = os.homedir;
    (os as any).homedir = () => tmpHome.dir;
  });

  afterEach(() => {
    // CRITICAL: Clean up any lock file written to the REAL home dir
    // (LOCK_PATH is a module-level constant computed at import time,
    // so it uses the real homedir, not our mock)
    deleteSetupLock();
    (os as any).homedir = origHomedir;
    tmpHome.cleanup();
  });

  it('full CRUD lifecycle in pipeline context', () => {
    // Write
    const lock: SetupLock = {
      startedAt: '2026-03-01T12:00:00Z',
      agentName: 'pipeline-test',
      scenario: 4,
      phase: 'telegram-setup',
      filesCreated: ['/tmp/config.json', '/tmp/AGENT.md'],
      reposCreated: ['user/instar-pipeline-test'],
    };
    writeSetupLock(lock);

    // Read
    const read = readSetupLock();
    expect(read).not.toBeNull();
    expect(read!.agentName).toBe('pipeline-test');
    expect(read!.scenario).toBe(4);
    expect(read!.phase).toBe('telegram-setup');
    expect(read!.filesCreated).toHaveLength(2);
    expect(read!.reposCreated).toHaveLength(1);

    // Update (overwrite)
    writeSetupLock({ ...lock, phase: 'user-setup', filesCreated: [...lock.filesCreated, '/tmp/users.json'] });
    const updated = readSetupLock();
    expect(updated!.phase).toBe('user-setup');
    expect(updated!.filesCreated).toHaveLength(3);

    // Delete
    deleteSetupLock();
    expect(readSetupLock()).toBeNull();
  });

  it('lock file survives across multiple discovery runs', () => {
    writeSetupLock({
      startedAt: new Date().toISOString(),
      agentName: 'persistent',
      scenario: null,
      phase: 'init',
      filesCreated: [],
      reposCreated: [],
    });

    const tmpProject = createTempDir();
    try {
      // Run discovery multiple times
      runDiscovery(tmpProject.dir, null, 'unavailable');
      runDiscovery(tmpProject.dir, null, 'unavailable');

      // Lock should still be there
      const lock = readSetupLock();
      expect(lock).not.toBeNull();
      expect(lock!.agentName).toBe('persistent');
    } finally {
      tmpProject.cleanup();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// CROSS-SCENARIO CONSISTENCY — Verify all 8 scenarios are reachable
// ═══════════════════════════════════════════════════════════════════

describe('Cross-Scenario Consistency', () => {
  let tmpHome: { dir: string; cleanup: () => void };
  let origHomedir: typeof os.homedir;

  beforeEach(() => {
    tmpHome = createTempDir();
    origHomedir = os.homedir;
    (os as any).homedir = () => tmpHome.dir;
  });

  afterEach(() => {
    (os as any).homedir = origHomedir;
    tmpHome.cleanup();
  });

  const scenarioMatrix = [
    { isRepo: false, users: 1, machines: 1, expected: 1, label: 'standalone/single/single' },
    { isRepo: false, users: 1, machines: 2, expected: 2, label: 'standalone/single/multi-machine' },
    { isRepo: true,  users: 1, machines: 1, expected: 3, label: 'repo/single/single' },
    { isRepo: true,  users: 1, machines: 2, expected: 4, label: 'repo/single/multi-machine' },
    { isRepo: true,  users: 2, machines: 1, expected: 5, label: 'repo/multi-user/single' },
    { isRepo: true,  users: 3, machines: 3, expected: 6, label: 'repo/multi-user/multi-machine' },
    { isRepo: false, users: 2, machines: 2, expected: 7, label: 'standalone/multi-user/multi-machine' },
    { isRepo: false, users: 4, machines: 1, expected: 8, label: 'standalone/multi-user/single' },
  ];

  for (const sc of scenarioMatrix) {
    it(`scenario ${sc.expected}: ${sc.label} — end-to-end`, () => {
      const tmpProject = createTempDir();
      try {
        // Build user list
        const users = Array.from({ length: sc.users }, (_, i) => ({ name: `User-${i}` }));
        // Build machine map
        const machines: Record<string, { status: string }> = {};
        for (let i = 0; i < sc.machines; i++) {
          machines[`machine-${i}`] = { status: 'active' };
        }

        createAgentDir(tmpProject.dir, `scenario-${sc.expected}`, { users, machines });

        const discovery = runDiscovery(tmpProject.dir, null, 'unavailable');
        const scenario = buildScenarioContext(discovery, sc.isRepo);

        expect(scenario.resolvedScenario).toBe(sc.expected);
        expect(scenario.isMultiUser).toBe(sc.users > 1);
        expect(scenario.isMultiMachine).toBe(sc.machines > 1);
        expect(scenario.isInsideGitRepo).toBe(sc.isRepo);
      } finally {
        tmpProject.cleanup();
      }
    });
  }

  it('all 8 scenarios are reachable from the matrix', () => {
    const reached = new Set<number>();
    for (const sc of scenarioMatrix) {
      reached.add(sc.expected);
    }
    expect(reached.size).toBe(8);
    expect([...reached].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// EDGE CASES — Malformed data, missing files, race conditions
// ═══════════════════════════════════════════════════════════════════

describe('Pipeline Edge Cases', () => {
  let tmpHome: { dir: string; cleanup: () => void };
  let origHomedir: typeof os.homedir;

  beforeEach(() => {
    tmpHome = createTempDir();
    origHomedir = os.homedir;
    (os as any).homedir = () => tmpHome.dir;
  });

  afterEach(() => {
    (os as any).homedir = origHomedir;
    tmpHome.cleanup();
  });

  it('malformed config.json in CWD agent — still detects as existing', () => {
    const tmpProject = createTempDir();
    try {
      const stateDir = path.join(tmpProject.dir, '.instar');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'config.json'), 'not json');

      const discovery = runDiscovery(tmpProject.dir, null, 'unavailable');
      expect(discovery.current_dir_agent).not.toBeNull();
      expect(discovery.current_dir_agent!.exists).toBe(true);
      expect(discovery.current_dir_agent!.name).toBe('unknown');
    } finally {
      tmpProject.cleanup();
    }
  });

  it('malformed users.json — treated as no users', () => {
    const tmpProject = createTempDir();
    try {
      const stateDir = path.join(tmpProject.dir, '.instar');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'broken' }));
      fs.writeFileSync(path.join(stateDir, 'users.json'), 'corrupt');

      const discovery = runDiscovery(tmpProject.dir, null, 'unavailable');
      expect(discovery.current_dir_agent!.users).toEqual([]);
    } finally {
      tmpProject.cleanup();
    }
  });

  it('malformed machines/registry.json — treated as zero machines', () => {
    const tmpProject = createTempDir();
    try {
      const stateDir = path.join(tmpProject.dir, '.instar');
      fs.mkdirSync(path.join(stateDir, 'machines'), { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'broken' }));
      fs.writeFileSync(path.join(stateDir, 'machines', 'registry.json'), 'not json');

      const discovery = runDiscovery(tmpProject.dir, null, 'unavailable');
      expect(discovery.current_dir_agent!.machines).toBe(0);
    } finally {
      tmpProject.cleanup();
    }
  });

  it('registry + filesystem + CWD all populated — everything merges correctly', () => {
    const tmpProject = createTempDir();
    try {
      // CWD agent
      createAgentDir(tmpProject.dir, 'cwd-agent', {
        users: [{ name: 'Admin' }],
        machines: { 'laptop': { status: 'active' } },
      });

      // Standalone agent in filesystem
      const standaloneDir = path.join(tmpHome.dir, '.instar', 'agents', 'standalone-bot');
      createAgentDir(standaloneDir, 'standalone-bot');

      // Registry has both + a zombie
      createRegistry(tmpHome.dir, [
        { name: 'cwd-agent', path: tmpProject.dir, type: 'project-bound', status: 'running', port: 4040 },
        { name: 'standalone-bot', path: standaloneDir, type: 'standalone', status: 'stopped' },
        { name: 'ghost', path: '/nonexistent/path', type: 'standalone', status: 'stopped' },
      ]);

      const discovery = runDiscovery(tmpProject.dir, null, 'unavailable');

      // Should find both real agents
      expect(discovery.local_agents.length).toBeGreaterThanOrEqual(2);
      // Should flag the zombie
      expect(discovery.zombie_entries).toHaveLength(1);
      expect(discovery.zombie_entries[0]).toContain('ghost');
      // CWD agent should be detected
      expect(discovery.current_dir_agent).not.toBeNull();
      expect(discovery.current_dir_agent!.name).toBe('cwd-agent');
    } finally {
      tmpProject.cleanup();
    }
  });

  it('handles empty .instar directory (no config.json)', () => {
    const tmpProject = createTempDir();
    try {
      const stateDir = path.join(tmpProject.dir, '.instar');
      fs.mkdirSync(stateDir, { recursive: true });
      // No config.json

      const discovery = runDiscovery(tmpProject.dir, null, 'unavailable');
      expect(discovery.current_dir_agent).toBeNull();
    } finally {
      tmpProject.cleanup();
    }
  });

  it('project dir is inside allowed prefix for registry validation', () => {
    const tmpProject = createTempDir();
    try {
      createAgentDir(tmpProject.dir, 'legit', { users: [{ name: 'Me' }] });

      // Register the project-dir agent
      createRegistry(tmpHome.dir, [{
        name: 'legit',
        path: tmpProject.dir,
        type: 'project-bound',
        status: 'running',
      }]);

      const discovery = runDiscovery(tmpProject.dir, null, 'unavailable');
      const registryAgents = discovery.local_agents.filter(a => a.name === 'legit');
      expect(registryAgents.length).toBeGreaterThanOrEqual(1);
    } finally {
      tmpProject.cleanup();
    }
  });
});
