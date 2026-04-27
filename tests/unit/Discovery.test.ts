/**
 * Exhaustive unit tests for the discovery module.
 *
 * Covers:
 * - Scenario resolution (all 8 scenarios, boundary conditions)
 * - Merge algorithm (collisions, mixed sources, dedup, empty, large sets)
 * - Registry validation (zombies, path traversal, malformed, edge cases)
 * - Local agent scanning (with temp directories)
 * - Scenario context building
 * - Setup lock file CRUD
 * - Name and URL validation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveScenario,
  mergeDiscoveryResults,
  validateRegistry,
  scanLocalAgents,
  buildScenarioContext,
  readSetupLock,
  writeSetupLock,
  deleteSetupLock,
  type LocalAgent,
  type DiscoveredGitHubAgent,
  type SetupDiscoveryContext,
  type SetupLock,
} from '../../src/commands/discovery.js';

// ── Test Helpers ───────────────────────────────────────────────────

function createTempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-discovery-test-'));
  return {
    dir,
    // safe-git-allow: incremental-migration
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function makeLocalAgent(overrides: Partial<LocalAgent> = {}): LocalAgent {
  return {
    name: 'test-agent',
    path: '/tmp/fake/.instar/agents/test-agent',
    type: 'standalone',
    status: 'stopped',
    port: undefined,
    userCount: 0,
    machineCount: 0,
    ...overrides,
  };
}

function makeGitHubAgent(overrides: Partial<DiscoveredGitHubAgent> = {}): DiscoveredGitHubAgent {
  return {
    name: 'test-agent',
    repo: 'testuser/instar-test-agent',
    owner: 'testuser',
    ownerType: 'user',
    cloneUrl: 'https://github.com/testuser/instar-test-agent.git',
    sshUrl: 'git@github.com:testuser/instar-test-agent.git',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════
// SCENARIO RESOLUTION — All 8 scenarios + edge cases
// ═══════════════════════════════════════════════════════════════════

describe('resolveScenario', () => {
  // ── Complete matrix ──────────────────────────────────────────────

  it('Scenario 1: standalone, single user, single machine', () => {
    expect(resolveScenario(false, false, false)).toBe(1);
  });

  it('Scenario 2: standalone, single user, multi-machine', () => {
    expect(resolveScenario(false, false, true)).toBe(2);
  });

  it('Scenario 3: repo, single user, single machine', () => {
    expect(resolveScenario(true, false, false)).toBe(3);
  });

  it('Scenario 4: repo, single user, multi-machine', () => {
    expect(resolveScenario(true, false, true)).toBe(4);
  });

  it('Scenario 5: repo, multi-user, single machine', () => {
    expect(resolveScenario(true, true, false)).toBe(5);
  });

  it('Scenario 6: repo, multi-user, multi-machine', () => {
    expect(resolveScenario(true, true, true)).toBe(6);
  });

  it('Scenario 7: standalone, multi-user, multi-machine', () => {
    expect(resolveScenario(false, true, true)).toBe(7);
  });

  it('Scenario 8: standalone, multi-user, single machine', () => {
    expect(resolveScenario(false, true, false)).toBe(8);
  });

  // ── Exhaustive: all 8 combinations produce unique scenarios ──────

  it('all 8 input combinations produce distinct scenarios', () => {
    const results = new Set<number>();
    for (const repo of [true, false]) {
      for (const multiUser of [true, false]) {
        for (const multiMachine of [true, false]) {
          results.add(resolveScenario(repo, multiUser, multiMachine));
        }
      }
    }
    expect(results.size).toBe(8);
    expect([...results].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  // ── Repo axis consistency ────────────────────────────────────────

  it('repo=true always yields scenarios 3-6', () => {
    for (const multiUser of [true, false]) {
      for (const multiMachine of [true, false]) {
        const s = resolveScenario(true, multiUser, multiMachine);
        expect(s).toBeGreaterThanOrEqual(3);
        expect(s).toBeLessThanOrEqual(6);
      }
    }
  });

  it('repo=false yields scenarios 1, 2, 7, or 8', () => {
    const standalone = new Set<number>();
    for (const multiUser of [true, false]) {
      for (const multiMachine of [true, false]) {
        standalone.add(resolveScenario(false, multiUser, multiMachine));
      }
    }
    expect(standalone).toEqual(new Set([1, 2, 7, 8]));
  });
});

// ═══════════════════════════════════════════════════════════════════
// MERGE ALGORITHM — Comprehensive coverage
// ═══════════════════════════════════════════════════════════════════

describe('mergeDiscoveryResults', () => {
  // ── Basic merging ────────────────────────────────────────────────

  it('merges local + GitHub same agent into source=both', () => {
    const local = [makeLocalAgent({ name: 'ai-guy' })];
    const github = [makeGitHubAgent({ name: 'ai-guy', repo: 'JKHeadley/instar-ai-guy', owner: 'SageMindAI' })];
    const result = mergeDiscoveryResults(local, github);

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('both');
    expect(result[0].name).toBe('ai-guy');
    expect(result[0].path).toBe(local[0].path);
    expect(result[0].repo).toBe('JKHeadley/instar-ai-guy');
  });

  it('keeps local-only agents as source=local', () => {
    const result = mergeDiscoveryResults([makeLocalAgent()], []);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('local');
  });

  it('keeps GitHub-only agents as source=github', () => {
    const result = mergeDiscoveryResults([], [makeGitHubAgent()]);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('github');
  });

  it('handles empty inputs', () => {
    expect(mergeDiscoveryResults([], [])).toHaveLength(0);
  });

  // ── Multi-source merging ─────────────────────────────────────────

  it('handles mixed sources correctly', () => {
    const local = [makeLocalAgent({ name: 'ai-guy' })];
    const github = [
      makeGitHubAgent({ name: 'ai-guy', repo: 'user/instar-ai-guy' }),
      makeGitHubAgent({ name: 'personal-bot', repo: 'user/instar-personal-bot' }),
    ];
    const result = mergeDiscoveryResults(local, github);

    expect(result).toHaveLength(2);
    expect(result.find(a => a.name === 'ai-guy')?.source).toBe('both');
    expect(result.find(a => a.name === 'personal-bot')?.source).toBe('github');
  });

  it('preserves local data in merged entries', () => {
    const local = [makeLocalAgent({
      name: 'ai-guy',
      status: 'running',
      port: 4040,
      userCount: 2,
      machineCount: 1,
    })];
    const github = [makeGitHubAgent({ name: 'ai-guy' })];
    const result = mergeDiscoveryResults(local, github);

    expect(result[0].status).toBe('running');
    expect(result[0].port).toBe(4040);
    expect(result[0].userCount).toBe(2);
    expect(result[0].machineCount).toBe(1);
  });

  // ── Name collision handling ──────────────────────────────────────

  it('same name across different orgs — both shown', () => {
    const orgA = makeGitHubAgent({ name: 'shared-bot', repo: 'OrgA/instar-shared-bot', owner: 'OrgA', ownerType: 'org' });
    const orgB = makeGitHubAgent({ name: 'shared-bot', repo: 'OrgB/instar-shared-bot', owner: 'OrgB', ownerType: 'org' });
    const result = mergeDiscoveryResults([], [orgA, orgB]);

    expect(result).toHaveLength(2);
    expect(result[0].repo).toBe('OrgA/instar-shared-bot');
    expect(result[1].repo).toBe('OrgB/instar-shared-bot');
  });

  it('local agent matches FIRST GitHub match only (no double-matching)', () => {
    const local = [makeLocalAgent({ name: 'bot' })];
    const github = [
      makeGitHubAgent({ name: 'bot', repo: 'user/instar-bot' }),
      makeGitHubAgent({ name: 'bot', repo: 'OrgX/instar-bot' }),
    ];
    const result = mergeDiscoveryResults(local, github);

    // Local matches first GitHub entry, second remains github-only
    expect(result).toHaveLength(2);
    const merged = result.find(a => a.source === 'both');
    const githubOnly = result.find(a => a.source === 'github');
    expect(merged?.repo).toBe('user/instar-bot');
    expect(githubOnly?.repo).toBe('OrgX/instar-bot');
  });

  // ── Large sets ───────────────────────────────────────────────────

  it('handles 50 local + 50 GitHub agents', () => {
    const local = Array.from({ length: 50 }, (_, i) =>
      makeLocalAgent({ name: `agent-${i}`, path: `/tmp/agents/agent-${i}` })
    );
    const github = Array.from({ length: 50 }, (_, i) =>
      makeGitHubAgent({ name: `remote-${i}`, repo: `user/instar-remote-${i}` })
    );
    const result = mergeDiscoveryResults(local, github);

    expect(result).toHaveLength(100);
    expect(result.filter(a => a.source === 'local')).toHaveLength(50);
    expect(result.filter(a => a.source === 'github')).toHaveLength(50);
  });

  it('handles 50 overlapping agents (all merge to both)', () => {
    const local = Array.from({ length: 50 }, (_, i) =>
      makeLocalAgent({ name: `agent-${i}`, path: `/tmp/agents/agent-${i}` })
    );
    const github = Array.from({ length: 50 }, (_, i) =>
      makeGitHubAgent({ name: `agent-${i}`, repo: `user/instar-agent-${i}` })
    );
    const result = mergeDiscoveryResults(local, github);

    expect(result).toHaveLength(50);
    expect(result.every(a => a.source === 'both')).toBe(true);
  });

  // ── Order stability ──────────────────────────────────────────────

  it('local agents appear before GitHub-only agents', () => {
    const local = [makeLocalAgent({ name: 'local-first' })];
    const github = [
      makeGitHubAgent({ name: 'local-first', repo: 'u/instar-local-first' }),
      makeGitHubAgent({ name: 'github-second', repo: 'u/instar-github-second' }),
    ];
    const result = mergeDiscoveryResults(local, github);

    expect(result[0].name).toBe('local-first');
    expect(result[0].source).toBe('both');
    expect(result[1].name).toBe('github-second');
    expect(result[1].source).toBe('github');
  });
});

// ═══════════════════════════════════════════════════════════════════
// REGISTRY VALIDATION — Zombies, path traversal, edge cases
// ═══════════════════════════════════════════════════════════════════

describe('validateRegistry', () => {
  let tmpHome: { dir: string; cleanup: () => void };
  let origHomedir: typeof os.homedir;

  beforeEach(() => {
    tmpHome = createTempDir();
    // Mock os.homedir to use temp directory
    origHomedir = os.homedir;
    (os as any).homedir = () => tmpHome.dir;
  });

  afterEach(() => {
    (os as any).homedir = origHomedir;
    tmpHome.cleanup();
  });

  it('returns empty for missing registry file', () => {
    const result = validateRegistry('/some/project');
    expect(result.validAgents).toHaveLength(0);
    expect(result.zombieEntries).toHaveLength(0);
  });

  it('returns empty for malformed registry JSON', () => {
    const registryDir = path.join(tmpHome.dir, '.instar');
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(registryDir, 'registry.json'), 'not valid json{{{');

    const result = validateRegistry('/some/project');
    expect(result.validAgents).toHaveLength(0);
    expect(result.zombieEntries).toHaveLength(0);
  });

  it('returns empty for registry with no entries array', () => {
    const registryDir = path.join(tmpHome.dir, '.instar');
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(registryDir, 'registry.json'), JSON.stringify({ version: 1 }));

    const result = validateRegistry('/some/project');
    expect(result.validAgents).toHaveLength(0);
  });

  it('detects zombie entry (path does not exist)', () => {
    const registryDir = path.join(tmpHome.dir, '.instar');
    fs.mkdirSync(registryDir, { recursive: true });

    const agentPath = path.join(tmpHome.dir, '.instar', 'agents', 'ghost');
    // Don't create the directory — it's a zombie

    fs.writeFileSync(path.join(registryDir, 'registry.json'), JSON.stringify({
      version: 1,
      entries: [{ name: 'ghost', path: agentPath, type: 'standalone', status: 'stopped' }],
    }));

    const result = validateRegistry('/some/project');
    expect(result.validAgents).toHaveLength(0);
    expect(result.zombieEntries).toHaveLength(1);
    expect(result.zombieEntries[0]).toContain('ghost');
    expect(result.zombieEntries[0]).toContain('directory missing');
  });

  it('detects zombie entry (path exists but no config.json)', () => {
    const registryDir = path.join(tmpHome.dir, '.instar');
    const agentPath = path.join(tmpHome.dir, '.instar', 'agents', 'nocfg');
    fs.mkdirSync(path.join(agentPath, '.instar'), { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    // No config.json written

    fs.writeFileSync(path.join(registryDir, 'registry.json'), JSON.stringify({
      version: 1,
      entries: [{ name: 'nocfg', path: agentPath, type: 'standalone', status: 'stopped' }],
    }));

    const result = validateRegistry('/some/project');
    expect(result.validAgents).toHaveLength(0);
    expect(result.zombieEntries).toHaveLength(1);
    expect(result.zombieEntries[0]).toContain('no config.json');
  });

  it('rejects path outside allowed directories (path traversal)', () => {
    const registryDir = path.join(tmpHome.dir, '.instar');
    fs.mkdirSync(registryDir, { recursive: true });

    // Try to register an agent at /etc (path traversal attempt)
    fs.writeFileSync(path.join(registryDir, 'registry.json'), JSON.stringify({
      version: 1,
      entries: [{ name: 'evil', path: '/etc', type: 'standalone', status: 'stopped' }],
    }));

    const result = validateRegistry('/some/project');
    expect(result.validAgents).toHaveLength(0);
    expect(result.zombieEntries).toHaveLength(1);
    expect(result.zombieEntries[0]).toContain('outside allowed directories');
  });

  it('accepts valid agent in allowed directory', () => {
    const registryDir = path.join(tmpHome.dir, '.instar');
    const agentPath = path.join(tmpHome.dir, '.instar', 'agents', 'good-agent');
    fs.mkdirSync(path.join(agentPath, '.instar'), { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(agentPath, '.instar', 'config.json'), JSON.stringify({ projectName: 'good-agent' }));

    fs.writeFileSync(path.join(registryDir, 'registry.json'), JSON.stringify({
      version: 1,
      entries: [{ name: 'good-agent', path: agentPath, type: 'standalone', status: 'running', port: 4040 }],
    }));

    const result = validateRegistry('/some/project');
    expect(result.validAgents).toHaveLength(1);
    expect(result.validAgents[0].name).toBe('good-agent');
    expect(result.validAgents[0].status).toBe('running');
    expect(result.validAgents[0].port).toBe(4040);
    expect(result.zombieEntries).toHaveLength(0);
  });

  it('reads user count from users.json', () => {
    const registryDir = path.join(tmpHome.dir, '.instar');
    const agentPath = path.join(tmpHome.dir, '.instar', 'agents', 'multi-user');
    fs.mkdirSync(path.join(agentPath, '.instar'), { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(agentPath, '.instar', 'config.json'), '{}');
    fs.writeFileSync(path.join(agentPath, '.instar', 'users.json'), JSON.stringify([
      { name: 'Alice' }, { name: 'Bob' }, { name: 'Charlie' },
    ]));

    fs.writeFileSync(path.join(registryDir, 'registry.json'), JSON.stringify({
      version: 1,
      entries: [{ name: 'multi-user', path: agentPath, type: 'standalone', status: 'stopped' }],
    }));

    const result = validateRegistry('/some/project');
    expect(result.validAgents[0].userCount).toBe(3);
  });

  it('reads machine count from machines/registry.json', () => {
    const registryDir = path.join(tmpHome.dir, '.instar');
    const agentPath = path.join(tmpHome.dir, '.instar', 'agents', 'multi-machine');
    fs.mkdirSync(path.join(agentPath, '.instar', 'machines'), { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(agentPath, '.instar', 'config.json'), '{}');
    fs.writeFileSync(path.join(agentPath, '.instar', 'machines', 'registry.json'), JSON.stringify({
      machines: {
        'mac-1': { status: 'active' },
        'mac-2': { status: 'active' },
        'mac-3': { status: 'inactive' },
      },
    }));

    fs.writeFileSync(path.join(registryDir, 'registry.json'), JSON.stringify({
      version: 1,
      entries: [{ name: 'multi-machine', path: agentPath, type: 'standalone', status: 'stopped' }],
    }));

    const result = validateRegistry('/some/project');
    expect(result.validAgents[0].machineCount).toBe(2); // Only active ones
  });

  it('handles mixed valid, zombie, and traversal entries', () => {
    const registryDir = path.join(tmpHome.dir, '.instar');
    const goodPath = path.join(tmpHome.dir, '.instar', 'agents', 'good');
    fs.mkdirSync(path.join(goodPath, '.instar'), { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(goodPath, '.instar', 'config.json'), '{}');

    const ghostPath = path.join(tmpHome.dir, '.instar', 'agents', 'ghost');
    // ghost doesn't exist

    fs.writeFileSync(path.join(registryDir, 'registry.json'), JSON.stringify({
      version: 1,
      entries: [
        { name: 'good', path: goodPath, type: 'standalone', status: 'running' },
        { name: 'ghost', path: ghostPath, type: 'standalone', status: 'stopped' },
        { name: 'evil', path: '/etc/passwd', type: 'standalone', status: 'stopped' },
      ],
    }));

    const result = validateRegistry('/some/project');
    expect(result.validAgents).toHaveLength(1);
    expect(result.validAgents[0].name).toBe('good');
    expect(result.zombieEntries).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// LOCAL AGENT SCANNING — Temp directory based
// ═══════════════════════════════════════════════════════════════════

describe('scanLocalAgents', () => {
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

  it('returns empty when agents directory does not exist', () => {
    const result = scanLocalAgents();
    expect(result).toHaveLength(0);
  });

  it('returns empty when agents directory is empty', () => {
    fs.mkdirSync(path.join(tmpHome.dir, '.instar', 'agents'), { recursive: true });
    const result = scanLocalAgents();
    expect(result).toHaveLength(0);
  });

  it('skips directories without config.json', () => {
    const agentsDir = path.join(tmpHome.dir, '.instar', 'agents');
    fs.mkdirSync(path.join(agentsDir, 'no-config', '.instar'), { recursive: true });
    // No config.json
    const result = scanLocalAgents();
    expect(result).toHaveLength(0);
  });

  it('finds agent with config.json', () => {
    const agentsDir = path.join(tmpHome.dir, '.instar', 'agents');
    const agentDir = path.join(agentsDir, 'my-agent');
    fs.mkdirSync(path.join(agentDir, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, '.instar', 'config.json'), '{}');

    const result = scanLocalAgents();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('my-agent');
    expect(result[0].type).toBe('standalone');
    expect(result[0].status).toBe('stopped');
  });

  it('finds multiple agents', () => {
    const agentsDir = path.join(tmpHome.dir, '.instar', 'agents');
    for (const name of ['alpha', 'beta', 'gamma']) {
      const agentDir = path.join(agentsDir, name);
      fs.mkdirSync(path.join(agentDir, '.instar'), { recursive: true });
      fs.writeFileSync(path.join(agentDir, '.instar', 'config.json'), '{}');
    }

    const result = scanLocalAgents();
    expect(result).toHaveLength(3);
    expect(result.map(a => a.name).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('reads user count from agents', () => {
    const agentDir = path.join(tmpHome.dir, '.instar', 'agents', 'team');
    fs.mkdirSync(path.join(agentDir, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, '.instar', 'config.json'), '{}');
    fs.writeFileSync(path.join(agentDir, '.instar', 'users.json'), JSON.stringify([
      { name: 'A' }, { name: 'B' },
    ]));

    const result = scanLocalAgents();
    expect(result[0].userCount).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// SCENARIO CONTEXT BUILDING
// ═══════════════════════════════════════════════════════════════════

describe('buildScenarioContext', () => {
  function makeDiscovery(overrides: Partial<SetupDiscoveryContext> = {}): SetupDiscoveryContext {
    return {
      local_agents: [],
      github_agents: [],
      merged_agents: [],
      current_dir_agent: null,
      gh_status: 'ready',
      scan_errors: [],
      zombie_entries: [],
      ...overrides,
    };
  }

  it('fresh install — no agents anywhere', () => {
    const ctx = buildScenarioContext(makeDiscovery(), false);
    expect(ctx.entryPoint).toBe('fresh');
    expect(ctx.existingAgentInCWD).toBe(false);
    expect(ctx.isMultiUser).toBeNull();
    expect(ctx.isMultiMachine).toBeNull();
    expect(ctx.resolvedScenario).toBeNull();
  });

  it('restore — GitHub agents found but no local', () => {
    const ctx = buildScenarioContext(makeDiscovery({
      github_agents: [makeGitHubAgent()],
    }), false);
    expect(ctx.entryPoint).toBe('restore');
    expect(ctx.githubBackupsFound).toBe(true);
  });

  it('existing — agent in CWD with users', () => {
    const ctx = buildScenarioContext(makeDiscovery({
      current_dir_agent: { exists: true, name: 'my-agent', users: ['Alice', 'Bob'], machines: 1 },
    }), true);
    expect(ctx.entryPoint).toBe('existing');
    expect(ctx.existingAgentInCWD).toBe(true);
    expect(ctx.existingUserCount).toBe(2);
    expect(ctx.isMultiUser).toBe(true);
    expect(ctx.isMultiMachine).toBe(false);
  });

  it('resolves scenario for existing multi-user multi-machine repo agent', () => {
    const ctx = buildScenarioContext(makeDiscovery({
      current_dir_agent: { exists: true, name: 'team-bot', users: ['A', 'B'], machines: 3 },
    }), true);
    expect(ctx.resolvedScenario).toBe(6); // repo + multi-user + multi-machine
  });

  it('resolves scenario for existing single-user standalone', () => {
    const ctx = buildScenarioContext(makeDiscovery({
      current_dir_agent: { exists: true, name: 'solo', users: ['Me'], machines: 1 },
    }), false);
    expect(ctx.resolvedScenario).toBe(1); // standalone + single + single
  });

  it('does NOT resolve scenario for fresh install (needs wizard questions)', () => {
    const ctx = buildScenarioContext(makeDiscovery(), true);
    expect(ctx.resolvedScenario).toBeNull();
  });

  it('detects local agents found', () => {
    const ctx = buildScenarioContext(makeDiscovery({
      local_agents: [makeLocalAgent()],
    }), false);
    expect(ctx.localAgentsFound).toBe(true);
  });

  it('passes through isInsideGitRepo flag', () => {
    expect(buildScenarioContext(makeDiscovery(), true).isInsideGitRepo).toBe(true);
    expect(buildScenarioContext(makeDiscovery(), false).isInsideGitRepo).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// SETUP LOCK FILE — CRUD operations
// ═══════════════════════════════════════════════════════════════════

describe('Setup Lock File', () => {
  let tmpHome: { dir: string; cleanup: () => void };
  let origHomedir: typeof os.homedir;

  beforeEach(() => {
    tmpHome = createTempDir();
    origHomedir = os.homedir;
    // Clean up any real setup lock that might interfere (LOCK_PATH is computed at module load)
    const realLockPath = path.join(origHomedir(), '.instar', 'setup-lock.json');
    // safe-git-allow: incremental-migration
    if (fs.existsSync(realLockPath)) fs.unlinkSync(realLockPath);
    (os as any).homedir = () => tmpHome.dir;
  });

  afterEach(() => {
    (os as any).homedir = origHomedir;
    tmpHome.cleanup();
  });

  it('readSetupLock returns null when no lock exists', () => {
    expect(readSetupLock()).toBeNull();
  });

  it('writeSetupLock creates lock file', () => {
    const lock: SetupLock = {
      startedAt: new Date().toISOString(),
      agentName: 'test-agent',
      scenario: 3,
      phase: 'telegram-setup',
      filesCreated: ['/tmp/test/config.json'],
      reposCreated: [],
    };
    writeSetupLock(lock);

    const read = readSetupLock();
    expect(read).not.toBeNull();
    expect(read!.agentName).toBe('test-agent');
    expect(read!.scenario).toBe(3);
    expect(read!.phase).toBe('telegram-setup');
    expect(read!.filesCreated).toEqual(['/tmp/test/config.json']);
  });

  it('deleteSetupLock removes lock file', () => {
    writeSetupLock({
      startedAt: new Date().toISOString(),
      agentName: 'temp',
      scenario: null,
      phase: 'init',
      filesCreated: [],
      reposCreated: [],
    });
    expect(readSetupLock()).not.toBeNull();

    deleteSetupLock();
    expect(readSetupLock()).toBeNull();
  });

  it('deleteSetupLock is safe when no lock exists', () => {
    expect(() => deleteSetupLock()).not.toThrow();
  });

  it('readSetupLock handles corrupted JSON', () => {
    const lockDir = path.join(tmpHome.dir, '.instar');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'setup-lock.json'), 'corrupted{{{');
    expect(readSetupLock()).toBeNull();
  });

  it('writeSetupLock creates parent directories', () => {
    // tmpHome.dir/.instar/ doesn't exist yet
    const lock: SetupLock = {
      startedAt: new Date().toISOString(),
      agentName: 'new',
      scenario: 1,
      phase: 'welcome',
      filesCreated: [],
      reposCreated: [],
    };
    expect(() => writeSetupLock(lock)).not.toThrow();
    expect(readSetupLock()).not.toBeNull();
  });
});
