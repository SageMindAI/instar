/**
 * Unit tests for AgentRegistry — unified agent tracking and port allocation.
 *
 * Tests:
 * - Load/save roundtrip
 * - Empty registry on fresh start
 * - Register and retrieve agent
 * - Register updates existing agent by path
 * - Port conflict detection
 * - Unregister agent by path
 * - Stale entry detection (dead PID)
 * - Port allocation from range
 * - Port allocation reuses existing
 * - Port allocation exhaustion
 * - Agent name validation
 * - Heartbeat updates timestamp
 * - List agents with type filter
 * - List agents with status filter
 * - Migration from port-registry.json
 * - Backward compat: registerPort/unregisterPort
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// We need to mock the home directory to isolate tests
const ORIG_HOMEDIR = os.homedir;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-registry-test-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('AgentRegistry', () => {
  let tmpHome: string;
  let registryPath: string;

  beforeEach(() => {
    tmpHome = createTempDir();
    registryPath = path.join(tmpHome, '.instar', 'registry.json');

    // Mock os.homedir to point to our temp dir
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup(tmpHome);
  });

  // Dynamic import to pick up the mocked homedir
  async function getRegistry() {
    // Clear module cache to pick up new homedir
    const mod = await import('../../src/core/AgentRegistry.js');
    return mod;
  }

  describe('load and save', () => {
    it('returns empty registry on fresh start', async () => {
      const { loadRegistry } = await getRegistry();
      const reg = loadRegistry();
      expect(reg.version).toBe(1);
      expect(reg.entries).toEqual([]);
    });

    it('save and load roundtrip', async () => {
      const { loadRegistry, saveRegistry } = await getRegistry();
      const reg = {
        version: 1 as const,
        entries: [{
          name: 'test-agent',
          type: 'project-bound' as const,
          path: '/tmp/test-project',
          port: 4040,
          pid: 12345,
          status: 'running' as const,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastHeartbeat: '2026-01-01T00:00:00.000Z',
        }],
      };
      saveRegistry(reg);
      const loaded = loadRegistry();
      expect(loaded).toEqual(reg);
    });
  });

  describe('agent registration', () => {
    it('registers a new agent', async () => {
      const { registerAgent, getAgent } = await getRegistry();
      registerAgent('/tmp/my-project', 'my-project', 4040);
      const agent = getAgent('/tmp/my-project');
      expect(agent).not.toBeNull();
      expect(agent!.name).toBe('my-project');
      expect(agent!.port).toBe(4040);
      expect(agent!.status).toBe('running');
      expect(agent!.type).toBe('project-bound');
    });

    it('updates existing agent by path', async () => {
      const { registerAgent, getAgent } = await getRegistry();
      registerAgent('/tmp/my-project', 'my-project', 4040, 'project-bound', 100);
      registerAgent('/tmp/my-project', 'renamed-project', 4041, 'project-bound', 200);
      const agent = getAgent('/tmp/my-project');
      expect(agent!.name).toBe('renamed-project');
      expect(agent!.port).toBe(4041);
      expect(agent!.pid).toBe(200);
    });

    it('registers standalone agent', async () => {
      const { registerAgent, getAgent } = await getRegistry();
      registerAgent('/home/.instar/agents/my-agent', 'my-agent', 4045, 'standalone');
      const agent = getAgent('/home/.instar/agents/my-agent');
      expect(agent!.type).toBe('standalone');
    });

    it('detects port conflicts with running agents', async () => {
      const { registerAgent } = await getRegistry();
      // Use process.pid (alive) so entry stays 'running' through cleanStaleEntries
      registerAgent('/tmp/project-a', 'project-a', 4040, 'project-bound', process.pid);
      expect(() => {
        registerAgent('/tmp/project-b', 'project-b', 4040);
      }).toThrow(/Port 4040 is already in use/);
    });

    it('stale entries do not block port reuse', async () => {
      const { registerAgent, getAgent } = await getRegistry();
      // Register with a dead PID — will be marked stale on next registerAgent call
      registerAgent('/tmp/project-a', 'project-a', 4040, 'project-bound', 999999);
      // Another agent on the same port should succeed because project-a is stale
      registerAgent('/tmp/project-b', 'project-b', 4040);
      const agent = getAgent('/tmp/project-b');
      expect(agent).not.toBeNull();
      expect(agent!.port).toBe(4040);
      expect(agent!.status).toBe('running');
    });

    it('same path can reuse same port', async () => {
      const { registerAgent, getAgent } = await getRegistry();
      registerAgent('/tmp/my-project', 'my-project', 4040, 'project-bound', 100);
      registerAgent('/tmp/my-project', 'my-project', 4040, 'project-bound', 200);
      const agent = getAgent('/tmp/my-project');
      expect(agent!.pid).toBe(200);
    });
  });

  describe('unregister', () => {
    it('removes agent by path', async () => {
      const { registerAgent, unregisterAgent, getAgent } = await getRegistry();
      registerAgent('/tmp/my-project', 'my-project', 4040, 'project-bound', process.pid);
      unregisterAgent('/tmp/my-project');
      const agent = getAgent('/tmp/my-project');
      expect(agent).toBeNull();
    });

    it('unregister non-existent path is a no-op', async () => {
      const { unregisterAgent, loadRegistry } = await getRegistry();
      unregisterAgent('/tmp/nonexistent');
      const reg = loadRegistry();
      expect(reg.entries).toHaveLength(0);
    });
  });

  describe('stale entry detection and pruning', () => {
    it('marks dead PID entries as stale', async () => {
      const { loadRegistry, saveRegistry, cleanStaleEntries } = await getRegistry();
      const reg = {
        version: 1 as const,
        entries: [{
          name: 'dead-agent',
          type: 'project-bound' as const,
          path: '/home/user/real-project', // Non-ephemeral path
          port: 4040,
          pid: 999999,
          status: 'running' as const,
          createdAt: new Date().toISOString(),
          lastHeartbeat: new Date().toISOString(), // Recent — won't be expired
        }],
      };
      saveRegistry(reg);
      const cleaned = cleanStaleEntries(loadRegistry());
      // Entry marked stale but kept (recent heartbeat, non-ephemeral path)
      expect(cleaned.entries).toHaveLength(1);
      expect(cleaned.entries[0].status).toBe('stale');
    });

    it('prunes stale entries from ephemeral paths', async () => {
      const { loadRegistry, saveRegistry, cleanStaleEntries } = await getRegistry();
      const reg = {
        version: 1 as const,
        entries: [{
          name: 'test-agent',
          type: 'project-bound' as const,
          path: '/tmp/instar-test-abc123',
          port: 4040,
          pid: 999999,
          status: 'running' as const,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastHeartbeat: new Date().toISOString(),
        }, {
          name: 'var-folders-agent',
          type: 'project-bound' as const,
          path: '/var/folders/xx/yyyy/T/instar-test',
          port: 4041,
          pid: 999998,
          status: 'running' as const,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastHeartbeat: new Date().toISOString(),
        }],
      };
      saveRegistry(reg);
      const cleaned = cleanStaleEntries(loadRegistry());
      // Both ephemeral entries should be removed entirely
      expect(cleaned.entries).toHaveLength(0);
    });

    it('prunes stale entries older than 1 hour', async () => {
      const { loadRegistry, saveRegistry, cleanStaleEntries } = await getRegistry();
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const reg = {
        version: 1 as const,
        entries: [{
          name: 'expired-agent',
          type: 'project-bound' as const,
          path: '/home/user/old-project', // Non-ephemeral
          port: 4040,
          pid: 999999,
          status: 'running' as const,
          createdAt: twoHoursAgo,
          lastHeartbeat: twoHoursAgo, // 2 hours stale
        }],
      };
      saveRegistry(reg);
      const cleaned = cleanStaleEntries(loadRegistry());
      // Dead PID + stale for >1 hour = removed
      expect(cleaned.entries).toHaveLength(0);
    });

    it('keeps recently-stale entries from non-ephemeral paths', async () => {
      const { loadRegistry, saveRegistry, cleanStaleEntries } = await getRegistry();
      const reg = {
        version: 1 as const,
        entries: [{
          name: 'recently-dead',
          type: 'project-bound' as const,
          path: '/home/user/my-project', // Non-ephemeral
          port: 4040,
          pid: 999999,
          status: 'running' as const,
          createdAt: new Date().toISOString(),
          lastHeartbeat: new Date().toISOString(), // Just now
        }],
      };
      saveRegistry(reg);
      const cleaned = cleanStaleEntries(loadRegistry());
      // Kept — stale but recent heartbeat, non-ephemeral path
      expect(cleaned.entries).toHaveLength(1);
      expect(cleaned.entries[0].status).toBe('stale');
    });
  });

  describe('port allocation', () => {
    it('allocates from range', async () => {
      const { allocatePort } = await getRegistry();
      const port = allocatePort('/tmp/new-project', 5000, 5010);
      expect(port).toBe(5000);
    });

    it('skips ports used by running agents', async () => {
      const { registerAgent, allocatePort } = await getRegistry();
      registerAgent('/tmp/project-a', 'a', 5000, 'project-bound', process.pid);
      registerAgent('/tmp/project-b', 'b', 5001, 'project-bound', process.pid);
      const port = allocatePort('/tmp/project-c', 5000, 5010);
      expect(port).toBe(5002);
    });

    it('reclaims ports from stale agents', async () => {
      const { registerAgent, allocatePort } = await getRegistry();
      // Dead PID — will be marked stale, port should be reclaimable
      registerAgent('/tmp/project-a', 'a', 5000, 'project-bound', 999999);
      const port = allocatePort('/tmp/project-c', 5000, 5010);
      expect(port).toBe(5000); // Reclaimed from stale entry
    });

    it('returns existing port for same agent', async () => {
      const { registerAgent, allocatePort } = await getRegistry();
      registerAgent('/tmp/my-project', 'my-project', 5005, 'project-bound', process.pid);
      const port = allocatePort('/tmp/my-project', 5000, 5010);
      expect(port).toBe(5005);
    });

    it('throws when range exhausted by running agents', async () => {
      const { registerAgent, allocatePort } = await getRegistry();
      registerAgent('/tmp/p0', 'p0', 5000, 'project-bound', process.pid);
      registerAgent('/tmp/p1', 'p1', 5001, 'project-bound', process.pid);
      registerAgent('/tmp/p2', 'p2', 5002, 'project-bound', process.pid);
      expect(() => allocatePort('/tmp/new', 5000, 5002)).toThrow(/No free ports available/);
    });
  });

  describe('agent name validation', () => {
    it('accepts valid names', async () => {
      const { validateAgentName } = await getRegistry();
      expect(validateAgentName('my-agent')).toBe(true);
      expect(validateAgentName('agent_123')).toBe(true);
      expect(validateAgentName('A')).toBe(true);
      expect(validateAgentName('x'.repeat(64))).toBe(true);
    });

    it('rejects invalid names', async () => {
      const { validateAgentName } = await getRegistry();
      expect(validateAgentName('')).toBe(false);
      expect(validateAgentName('has/slash')).toBe(false);
      expect(validateAgentName('has\\backslash')).toBe(false);
      expect(validateAgentName('../traversal')).toBe(false);
      expect(validateAgentName('has\0null')).toBe(false);
      expect(validateAgentName('-starts-with-dash')).toBe(false);
      expect(validateAgentName('x'.repeat(65))).toBe(false);
    });
  });

  describe('heartbeat', () => {
    it('updates timestamp', async () => {
      const { registerAgent, heartbeat, getAgent } = await getRegistry();
      registerAgent('/tmp/my-project', 'my-project', 4040, 'project-bound', process.pid);
      const before = getAgent('/tmp/my-project')!.lastHeartbeat;

      // Small delay to ensure timestamp differs
      await new Promise(r => setTimeout(r, 10));
      heartbeat('/tmp/my-project');

      const after = getAgent('/tmp/my-project')!.lastHeartbeat;
      expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
    });
  });

  describe('listing with filters', () => {
    it('lists all agents', async () => {
      const { registerAgent, listAgents } = await getRegistry();
      registerAgent('/tmp/p1', 'agent-1', 4040, 'project-bound', process.pid);
      registerAgent('/tmp/p2', 'agent-2', 4041, 'standalone', process.pid);
      const all = listAgents();
      expect(all).toHaveLength(2);
    });

    it('filters by type', async () => {
      const { registerAgent, listAgents } = await getRegistry();
      registerAgent('/tmp/p1', 'agent-1', 4040, 'project-bound', process.pid);
      registerAgent('/tmp/p2', 'agent-2', 4041, 'standalone', process.pid);
      const standalone = listAgents({ type: 'standalone' });
      expect(standalone).toHaveLength(1);
      expect(standalone[0].name).toBe('agent-2');
    });

    it('filters by status', async () => {
      const { registerAgent, updateStatus, listAgents } = await getRegistry();
      registerAgent('/tmp/p1', 'agent-1', 4040, 'project-bound', process.pid);
      registerAgent('/tmp/p2', 'agent-2', 4041, 'project-bound', process.pid);
      updateStatus('/tmp/p2', 'stopped');
      const stopped = listAgents({ status: 'stopped' });
      expect(stopped).toHaveLength(1);
      expect(stopped[0].name).toBe('agent-2');
    });
  });

  describe('migration from port-registry.json', () => {
    it('migrates legacy entries', async () => {
      const legacyDir = path.join(tmpHome, '.instar');
      fs.mkdirSync(legacyDir, { recursive: true });
      const legacyPath = path.join(legacyDir, 'port-registry.json');
      fs.writeFileSync(legacyPath, JSON.stringify({
        entries: [{
          projectName: 'old-project',
          port: 4042,
          pid: 12345,
          projectDir: '/tmp/old-project',
          registeredAt: '2026-01-01T00:00:00.000Z',
          lastHeartbeat: '2026-01-01T00:00:00.000Z',
        }],
      }));

      const { loadRegistry } = await getRegistry();
      const reg = loadRegistry();
      expect(reg.entries).toHaveLength(1);
      expect(reg.entries[0].name).toBe('old-project');
      expect(reg.entries[0].type).toBe('project-bound');
      expect(reg.entries[0].path).toBe('/tmp/old-project');

      // Legacy file should be renamed
      expect(fs.existsSync(legacyPath + '.migrated')).toBe(true);
      expect(fs.existsSync(legacyPath)).toBe(false);

      // New registry should exist
      expect(fs.existsSync(path.join(legacyDir, 'registry.json'))).toBe(true);
    });
  });

  describe('backward compatibility wrappers', () => {
    it('registerPort works via registerAgent', async () => {
      const { registerPort, getAgent } = await getRegistry();
      registerPort('my-project', 4040, '/tmp/my-project');
      const agent = getAgent('/tmp/my-project');
      expect(agent).not.toBeNull();
      expect(agent!.name).toBe('my-project');
      expect(agent!.port).toBe(4040);
    });

    it('unregisterPort works by name', async () => {
      const { registerPort, unregisterPort, listAgents } = await getRegistry();
      registerPort('my-project', 4040, '/tmp/my-project');
      unregisterPort('my-project');
      const agents = listAgents();
      expect(agents).toHaveLength(0);
    });

    it('listInstances returns all agents', async () => {
      const { registerAgent, listInstances } = await getRegistry();
      registerAgent('/tmp/p1', 'a1', 4040, 'project-bound', process.pid);
      registerAgent('/tmp/p2', 'a2', 4041, 'standalone', process.pid);
      const instances = listInstances();
      expect(instances).toHaveLength(2);
    });
  });

  // ── Sync lock retry resilience ───────────────────────────────────

  describe('sync lock retry resilience', () => {
    it('registerAgent succeeds despite transient lock contention', async () => {
      const { registerAgent, listAgents } = await getRegistry();

      // Register two agents concurrently (sync calls) — both should succeed
      // even though they're contending for the same lock file
      registerAgent('/tmp/project-a', 'agent-a', 4050, 'project-bound', process.pid);
      registerAgent('/tmp/project-b', 'agent-b', 4051, 'project-bound', process.pid);

      const agents = listAgents();
      expect(agents.length).toBe(2);
      expect(agents.map(a => a.name).sort()).toEqual(['agent-a', 'agent-b']);
    });

    it('heartbeat recovers after stale lock is force-removed', async () => {
      const lockfileMod = await import('proper-lockfile');
      const { registerAgent, heartbeat, forceRemoveRegistryLock } = await getRegistry();

      registerAgent('/tmp/project-c', 'agent-c', 4052, 'project-bound', process.pid);

      // Force-remove any existing lock (simulating stale lock recovery)
      forceRemoveRegistryLock();

      // Heartbeat should succeed after lock removal
      heartbeat('/tmp/project-c');

      const { listAgents } = await getRegistry();
      const agents = listAgents();
      const agentC = agents.find(a => a.name === 'agent-c');
      expect(agentC).toBeDefined();
    });
  });
});
