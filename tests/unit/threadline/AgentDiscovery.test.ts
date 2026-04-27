import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentDiscovery, type ThreadlineAgentInfo, type HttpFetcher } from '../../../src/threadline/AgentDiscovery.js';

// Mock the AgentRegistry module
vi.mock('../../../src/core/AgentRegistry.js', () => ({
  loadRegistry: vi.fn(() => ({ version: 1, entries: [] })),
}));

import { loadRegistry } from '../../../src/core/AgentRegistry.js';
const mockLoadRegistry = vi.mocked(loadRegistry);

describe('AgentDiscovery', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-test-'));
    stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
    mockLoadRegistry.mockReturnValue({ version: 1, entries: [] });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createDiscovery(opts?: {
    fetcher?: HttpFetcher;
    selfName?: string;
    selfPort?: number;
    selfPath?: string;
  }): AgentDiscovery {
    return new AgentDiscovery({
      stateDir,
      selfPath: opts?.selfPath ?? '/projects/self',
      selfName: opts?.selfName ?? 'self-agent',
      selfPort: opts?.selfPort ?? 4040,
      fetcher: opts?.fetcher,
    });
  }

  function mockFetcher(responses: Map<string, { ok: boolean; status: number; body: any }>): HttpFetcher {
    return async (url: string) => {
      const resp = responses.get(url);
      if (!resp) {
        throw new Error(`Connection refused: ${url}`);
      }
      return {
        ok: resp.ok,
        status: resp.status,
        json: async () => resp.body,
      };
    };
  }

  // ── Discovery Tests ────────────────────────────────────────────

  describe('discoverLocal()', () => {
    it('discovers Threadline-capable agents from registry', async () => {
      mockLoadRegistry.mockReturnValue({
        version: 1,
        entries: [
          {
            name: 'agent-a',
            type: 'project-bound',
            path: '/projects/agent-a',
            port: 4041,
            pid: 1234,
            status: 'running',
            createdAt: '2026-01-01T00:00:00Z',
            lastHeartbeat: '2026-01-01T00:00:00Z',
          },
        ],
      });

      const responses = new Map([
        ['http://localhost:4041/threadline/health', {
          ok: true,
          status: 200,
          body: {
            status: 'ok',
            protocol: 'threadline',
            version: '1.0',
            agent: 'agent-a',
            identityPub: 'a'.repeat(64),
            capabilities: ['chat', 'research'],
            description: 'Test agent A',
            framework: 'instar',
          },
        }],
      ]);

      const discovery = createDiscovery({ fetcher: mockFetcher(responses) });
      const agents = await discovery.discoverLocal();

      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe('agent-a');
      expect(agents[0].threadlineEnabled).toBe(true);
      expect(agents[0].capabilities).toEqual(['chat', 'research']);
      expect(agents[0].publicKey).toBe('a'.repeat(64));
      expect(agents[0].threadlineVersion).toBe('1.0');
      expect(agents[0].status).toBe('unverified');
    });

    it('skips self in discovery', async () => {
      mockLoadRegistry.mockReturnValue({
        version: 1,
        entries: [
          {
            name: 'self-agent',
            type: 'project-bound',
            path: '/projects/self',
            port: 4040,
            pid: 1000,
            status: 'running',
            createdAt: '2026-01-01T00:00:00Z',
            lastHeartbeat: '2026-01-01T00:00:00Z',
          },
          {
            name: 'other-agent',
            type: 'project-bound',
            path: '/projects/other',
            port: 4041,
            pid: 1001,
            status: 'running',
            createdAt: '2026-01-01T00:00:00Z',
            lastHeartbeat: '2026-01-01T00:00:00Z',
          },
        ],
      });

      const responses = new Map([
        ['http://localhost:4041/threadline/health', {
          ok: true,
          status: 200,
          body: { status: 'ok', protocol: 'threadline', version: '1.0', agent: 'other-agent' },
        }],
      ]);

      const discovery = createDiscovery({ fetcher: mockFetcher(responses) });
      const agents = await discovery.discoverLocal();

      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe('other-agent');
    });

    it('skips non-running agents', async () => {
      mockLoadRegistry.mockReturnValue({
        version: 1,
        entries: [
          {
            name: 'stopped-agent',
            type: 'project-bound',
            path: '/projects/stopped',
            port: 4041,
            pid: 0,
            status: 'stopped',
            createdAt: '2026-01-01T00:00:00Z',
            lastHeartbeat: '2026-01-01T00:00:00Z',
          },
        ],
      });

      const discovery = createDiscovery({ fetcher: mockFetcher(new Map()) });
      const agents = await discovery.discoverLocal();

      expect(agents).toHaveLength(0);
    });

    it('skips agents without Threadline protocol', async () => {
      mockLoadRegistry.mockReturnValue({
        version: 1,
        entries: [
          {
            name: 'plain-agent',
            type: 'project-bound',
            path: '/projects/plain',
            port: 4041,
            pid: 1001,
            status: 'running',
            createdAt: '2026-01-01T00:00:00Z',
            lastHeartbeat: '2026-01-01T00:00:00Z',
          },
        ],
      });

      const responses = new Map([
        ['http://localhost:4041/threadline/health', {
          ok: true,
          status: 200,
          body: { status: 'ok' }, // No protocol field
        }],
      ]);

      const discovery = createDiscovery({ fetcher: mockFetcher(responses) });
      const agents = await discovery.discoverLocal();

      expect(agents).toHaveLength(0);
    });

    it('handles unreachable agents gracefully', async () => {
      mockLoadRegistry.mockReturnValue({
        version: 1,
        entries: [
          {
            name: 'dead-agent',
            type: 'project-bound',
            path: '/projects/dead',
            port: 4099,
            pid: 9999,
            status: 'running',
            createdAt: '2026-01-01T00:00:00Z',
            lastHeartbeat: '2026-01-01T00:00:00Z',
          },
        ],
      });

      // No responses — fetcher will throw
      const discovery = createDiscovery({ fetcher: mockFetcher(new Map()) });
      const agents = await discovery.discoverLocal();

      expect(agents).toHaveLength(0);
    });

    it('returns empty list when registry is empty', async () => {
      mockLoadRegistry.mockReturnValue({ version: 1, entries: [] });

      const discovery = createDiscovery({ fetcher: mockFetcher(new Map()) });
      const agents = await discovery.discoverLocal();

      expect(agents).toHaveLength(0);
    });

    it('handles agents returning non-200 status', async () => {
      mockLoadRegistry.mockReturnValue({
        version: 1,
        entries: [
          {
            name: 'error-agent',
            type: 'project-bound',
            path: '/projects/error',
            port: 4041,
            pid: 1001,
            status: 'running',
            createdAt: '2026-01-01T00:00:00Z',
            lastHeartbeat: '2026-01-01T00:00:00Z',
          },
        ],
      });

      const responses = new Map([
        ['http://localhost:4041/threadline/health', {
          ok: false,
          status: 500,
          body: { error: 'internal error' },
        }],
      ]);

      const discovery = createDiscovery({ fetcher: mockFetcher(responses) });
      const agents = await discovery.discoverLocal();

      expect(agents).toHaveLength(0);
    });

    it('discovers multiple agents concurrently', async () => {
      mockLoadRegistry.mockReturnValue({
        version: 1,
        entries: [
          {
            name: 'agent-a', type: 'project-bound', path: '/projects/a',
            port: 4041, pid: 1001, status: 'running',
            createdAt: '2026-01-01T00:00:00Z', lastHeartbeat: '2026-01-01T00:00:00Z',
          },
          {
            name: 'agent-b', type: 'project-bound', path: '/projects/b',
            port: 4042, pid: 1002, status: 'running',
            createdAt: '2026-01-01T00:00:00Z', lastHeartbeat: '2026-01-01T00:00:00Z',
          },
          {
            name: 'agent-c', type: 'project-bound', path: '/projects/c',
            port: 4043, pid: 1003, status: 'running',
            createdAt: '2026-01-01T00:00:00Z', lastHeartbeat: '2026-01-01T00:00:00Z',
          },
        ],
      });

      const responses = new Map([
        ['http://localhost:4041/threadline/health', {
          ok: true, status: 200,
          body: { status: 'ok', protocol: 'threadline', version: '1.0', agent: 'agent-a' },
        }],
        ['http://localhost:4042/threadline/health', {
          ok: true, status: 200,
          body: { status: 'ok', protocol: 'threadline', version: '1.0', agent: 'agent-b', capabilities: ['code'] },
        }],
        // agent-c is unreachable
      ]);

      const discovery = createDiscovery({ fetcher: mockFetcher(responses) });
      const agents = await discovery.discoverLocal();

      expect(agents).toHaveLength(2);
      const names = agents.map(a => a.name).sort();
      expect(names).toEqual(['agent-a', 'agent-b']);
    });

    it('saves discovered agents to known-agents cache', async () => {
      mockLoadRegistry.mockReturnValue({
        version: 1,
        entries: [
          {
            name: 'agent-a', type: 'project-bound', path: '/projects/a',
            port: 4041, pid: 1001, status: 'running',
            createdAt: '2026-01-01T00:00:00Z', lastHeartbeat: '2026-01-01T00:00:00Z',
          },
        ],
      });

      const responses = new Map([
        ['http://localhost:4041/threadline/health', {
          ok: true, status: 200,
          body: { status: 'ok', protocol: 'threadline', version: '1.0', agent: 'agent-a' },
        }],
      ]);

      const discovery = createDiscovery({ fetcher: mockFetcher(responses) });
      await discovery.discoverLocal();

      const knownPath = path.join(stateDir, 'threadline', 'known-agents.json');
      expect(fs.existsSync(knownPath)).toBe(true);

      const data = JSON.parse(fs.readFileSync(knownPath, 'utf-8'));
      expect(data.agents).toHaveLength(1);
      expect(data.agents[0].name).toBe('agent-a');
    });
  });

  // ── Announce Tests ─────────────────────────────────────────────

  describe('announcePresence()', () => {
    it('writes agent-info.json with correct data', () => {
      const discovery = createDiscovery();

      discovery.announcePresence({
        capabilities: ['chat', 'research'],
        description: 'Test agent',
        threadlineVersion: '1.0',
        publicKey: 'abc123',
        framework: 'instar',
        machine: 'workstation',
      });

      const infoPath = path.join(stateDir, 'threadline', 'agent-info.json');
      expect(fs.existsSync(infoPath)).toBe(true);

      const info = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
      expect(info.name).toBe('self-agent');
      expect(info.port).toBe(4040);
      expect(info.capabilities).toEqual(['chat', 'research']);
      expect(info.description).toBe('Test agent');
      expect(info.threadlineVersion).toBe('1.0');
      expect(info.publicKey).toBe('abc123');
      expect(info.framework).toBe('instar');
      expect(info.machine).toBe('workstation');
      expect(info.updatedAt).toBeDefined();
    });

    it('updates existing agent-info.json', () => {
      const discovery = createDiscovery();

      discovery.announcePresence({
        capabilities: ['chat'],
        threadlineVersion: '1.0',
      });

      discovery.announcePresence({
        capabilities: ['chat', 'code'],
        threadlineVersion: '1.1',
        description: 'Updated',
      });

      const info = JSON.parse(
        fs.readFileSync(path.join(stateDir, 'threadline', 'agent-info.json'), 'utf-8')
      );
      expect(info.capabilities).toEqual(['chat', 'code']);
      expect(info.threadlineVersion).toBe('1.1');
      expect(info.description).toBe('Updated');
    });

    it('defaults framework to instar when not specified', () => {
      const discovery = createDiscovery();

      discovery.announcePresence({
        capabilities: [],
        threadlineVersion: '1.0',
      });

      const info = JSON.parse(
        fs.readFileSync(path.join(stateDir, 'threadline', 'agent-info.json'), 'utf-8')
      );
      expect(info.framework).toBe('instar');
    });

    it('getSelfInfo returns the announced info', () => {
      const discovery = createDiscovery();

      expect(discovery.getSelfInfo()).toBeNull();

      discovery.announcePresence({
        capabilities: ['chat'],
        threadlineVersion: '1.0',
        publicKey: 'key123',
      });

      const info = discovery.getSelfInfo();
      expect(info).not.toBeNull();
      expect(info!.name).toBe('self-agent');
      expect(info!.publicKey).toBe('key123');
    });
  });

  // ── Verification Tests ─────────────────────────────────────────

  describe('verifyAgent()', () => {
    it('returns verified agent info on successful health check', async () => {
      mockLoadRegistry.mockReturnValue({
        version: 1,
        entries: [
          {
            name: 'target', type: 'project-bound', path: '/projects/target',
            port: 4041, pid: 1001, status: 'running',
            createdAt: '2026-01-01T00:00:00Z', lastHeartbeat: '2026-01-01T00:00:00Z',
          },
        ],
      });

      const validPubKey = 'ab'.repeat(32); // 64 hex chars = 32 bytes
      const responses = new Map([
        ['http://localhost:4041/threadline/health', {
          ok: true, status: 200,
          body: {
            status: 'ok',
            protocol: 'threadline',
            version: '1.0',
            agent: 'target',
            identityPub: validPubKey,
            capabilities: ['chat'],
          },
        }],
      ]);

      const discovery = createDiscovery({ fetcher: mockFetcher(responses) });
      const result = await discovery.verifyAgent('target', 4041);

      expect(result).not.toBeNull();
      expect(result!.name).toBe('target');
      expect(result!.status).toBe('active');
      expect(result!.lastVerified).toBeDefined();
      expect(result!.publicKey).toBe(validPubKey);
      expect(result!.path).toBe('/projects/target');
    });

    it('returns null for agents without identityPub', async () => {
      const responses = new Map([
        ['http://localhost:4041/threadline/health', {
          ok: true, status: 200,
          body: { status: 'ok', protocol: 'threadline', version: '1.0' },
        }],
      ]);

      const discovery = createDiscovery({ fetcher: mockFetcher(responses) });
      const result = await discovery.verifyAgent('target', 4041);

      expect(result).toBeNull();
    });

    it('returns null for unreachable agents', async () => {
      const discovery = createDiscovery({ fetcher: mockFetcher(new Map()) });
      const result = await discovery.verifyAgent('ghost', 9999);

      expect(result).toBeNull();
    });

    it('returns null for non-threadline agents', async () => {
      const responses = new Map([
        ['http://localhost:4041/threadline/health', {
          ok: true, status: 200,
          body: { status: 'ok' }, // No protocol field
        }],
      ]);

      const discovery = createDiscovery({ fetcher: mockFetcher(responses) });
      const result = await discovery.verifyAgent('plain', 4041);

      expect(result).toBeNull();
    });

    it('returns null for invalid public key length', async () => {
      const responses = new Map([
        ['http://localhost:4041/threadline/health', {
          ok: true, status: 200,
          body: {
            status: 'ok',
            protocol: 'threadline',
            identityPub: 'tooshort',
          },
        }],
      ]);

      const discovery = createDiscovery({ fetcher: mockFetcher(responses) });
      const result = await discovery.verifyAgent('bad-key', 4041);

      expect(result).toBeNull();
    });

    it('updates known-agents cache after verification', async () => {
      const validPubKey = 'ab'.repeat(32);
      const responses = new Map([
        ['http://localhost:4041/threadline/health', {
          ok: true, status: 200,
          body: {
            status: 'ok',
            protocol: 'threadline',
            version: '1.0',
            agent: 'target',
            identityPub: validPubKey,
          },
        }],
      ]);

      mockLoadRegistry.mockReturnValue({ version: 1, entries: [] });

      const discovery = createDiscovery({ fetcher: mockFetcher(responses) });
      await discovery.verifyAgent('target', 4041);

      const known = discovery.loadKnownAgents();
      expect(known).toHaveLength(1);
      expect(known[0].name).toBe('target');
      expect(known[0].status).toBe('active');
    });
  });

  // ── Heartbeat Tests ────────────────────────────────────────────

  describe('startPresenceHeartbeat()', () => {
    it('returns a cleanup function that stops the heartbeat', () => {
      const discovery = createDiscovery({ fetcher: mockFetcher(new Map()) });
      const cleanup = discovery.startPresenceHeartbeat(60_000);

      expect(typeof cleanup).toBe('function');
      cleanup(); // Should not throw
    });

    it('marks agents inactive after missed heartbeats', async () => {
      // Seed known agents
      const knownPath = path.join(stateDir, 'threadline', 'known-agents.json');
      const knownData = {
        agents: [{
          name: 'flaky-agent',
          port: 4041,
          path: '/projects/flaky',
          status: 'active',
          capabilities: [],
          threadlineEnabled: true,
          framework: 'instar',
          lastVerified: '2026-01-01T00:00:00Z',
        }],
        updatedAt: '2026-01-01T00:00:00Z',
      };
      fs.writeFileSync(knownPath, JSON.stringify(knownData));

      // Fetcher always fails
      const discovery = createDiscovery({ fetcher: mockFetcher(new Map()) });

      // Simulate 3 missed heartbeat ticks
      for (let i = 0; i < 3; i++) {
        await (discovery as any).heartbeatTick();
      }

      const agents = discovery.loadKnownAgents();
      expect(agents[0].status).toBe('inactive');
    });

    it('resets missed beats when agent responds', async () => {
      const knownPath = path.join(stateDir, 'threadline', 'known-agents.json');
      const knownData = {
        agents: [{
          name: 'recovering-agent',
          port: 4041,
          path: '/projects/recovering',
          status: 'active',
          capabilities: [],
          threadlineEnabled: true,
          framework: 'instar',
        }],
        updatedAt: '2026-01-01T00:00:00Z',
      };
      fs.writeFileSync(knownPath, JSON.stringify(knownData));

      let shouldRespond = false;
      const fetcher: HttpFetcher = async (url) => {
        if (shouldRespond) {
          return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
        }
        throw new Error('Connection refused');
      };

      const discovery = createDiscovery({ fetcher });

      // Miss 2 beats
      await (discovery as any).heartbeatTick();
      await (discovery as any).heartbeatTick();

      const trackers = discovery.getHeartbeatTrackers();
      expect(trackers.get('recovering-agent')?.missedBeats).toBe(2);

      // Agent comes back
      shouldRespond = true;
      await (discovery as any).heartbeatTick();

      expect(trackers.get('recovering-agent')?.missedBeats).toBe(0);
    });

    it('skips self during heartbeat tick', async () => {
      const knownPath = path.join(stateDir, 'threadline', 'known-agents.json');
      const knownData = {
        agents: [{
          name: 'self-agent', // Same as self
          port: 4040,
          path: '/projects/self',
          status: 'active',
          capabilities: [],
          threadlineEnabled: true,
          framework: 'instar',
        }],
        updatedAt: '2026-01-01T00:00:00Z',
      };
      fs.writeFileSync(knownPath, JSON.stringify(knownData));

      let fetchCalled = false;
      const fetcher: HttpFetcher = async () => {
        fetchCalled = true;
        return { ok: true, status: 200, json: async () => ({}) };
      };

      const discovery = createDiscovery({ fetcher });
      await (discovery as any).heartbeatTick();

      expect(fetchCalled).toBe(false);
    });

    it('does not mark agent inactive before threshold', async () => {
      const knownPath = path.join(stateDir, 'threadline', 'known-agents.json');
      const knownData = {
        agents: [{
          name: 'flaky-agent',
          port: 4041,
          path: '/projects/flaky',
          status: 'active',
          capabilities: [],
          threadlineEnabled: true,
          framework: 'instar',
        }],
        updatedAt: '2026-01-01T00:00:00Z',
      };
      fs.writeFileSync(knownPath, JSON.stringify(knownData));

      const discovery = createDiscovery({ fetcher: mockFetcher(new Map()) });

      // Only 2 missed beats (threshold is 3)
      await (discovery as any).heartbeatTick();
      await (discovery as any).heartbeatTick();

      const agents = discovery.loadKnownAgents();
      // Status should still not be 'inactive' since we haven't hit 3
      expect(agents[0].status).not.toBe('inactive');
    });
  });

  // ── Capability Search Tests ────────────────────────────────────

  describe('searchByCapability()', () => {
    it('finds agents with matching capability', () => {
      const knownPath = path.join(stateDir, 'threadline', 'known-agents.json');
      const knownData = {
        agents: [
          { name: 'coder', port: 4041, path: '/a', status: 'active', capabilities: ['code', 'review'], threadlineEnabled: true, framework: 'instar' },
          { name: 'chatter', port: 4042, path: '/b', status: 'active', capabilities: ['chat'], threadlineEnabled: true, framework: 'instar' },
          { name: 'hybrid', port: 4043, path: '/c', status: 'active', capabilities: ['code', 'chat'], threadlineEnabled: true, framework: 'instar' },
        ],
        updatedAt: '2026-01-01T00:00:00Z',
      };
      fs.writeFileSync(knownPath, JSON.stringify(knownData));

      const discovery = createDiscovery();
      const results = discovery.searchByCapability('code');

      expect(results).toHaveLength(2);
      const names = results.map(a => a.name).sort();
      expect(names).toEqual(['coder', 'hybrid']);
    });

    it('returns empty array when no agents match', () => {
      const knownPath = path.join(stateDir, 'threadline', 'known-agents.json');
      const knownData = {
        agents: [
          { name: 'chatter', port: 4042, path: '/b', status: 'active', capabilities: ['chat'], threadlineEnabled: true, framework: 'instar' },
        ],
        updatedAt: '2026-01-01T00:00:00Z',
      };
      fs.writeFileSync(knownPath, JSON.stringify(knownData));

      const discovery = createDiscovery();
      const results = discovery.searchByCapability('deploy');

      expect(results).toHaveLength(0);
    });

    it('performs case-insensitive matching', () => {
      const knownPath = path.join(stateDir, 'threadline', 'known-agents.json');
      const knownData = {
        agents: [
          { name: 'coder', port: 4041, path: '/a', status: 'active', capabilities: ['Code'], threadlineEnabled: true, framework: 'instar' },
        ],
        updatedAt: '2026-01-01T00:00:00Z',
      };
      fs.writeFileSync(knownPath, JSON.stringify(knownData));

      const discovery = createDiscovery();
      expect(discovery.searchByCapability('code')).toHaveLength(1);
      expect(discovery.searchByCapability('CODE')).toHaveLength(1);
    });

    it('returns empty when no known agents exist', () => {
      const discovery = createDiscovery();
      const results = discovery.searchByCapability('anything');
      expect(results).toHaveLength(0);
    });
  });

  // ── Verified Agents Tests ──────────────────────────────────────

  describe('getVerifiedAgents()', () => {
    it('returns only verified active agents', () => {
      const knownPath = path.join(stateDir, 'threadline', 'known-agents.json');
      const knownData = {
        agents: [
          { name: 'verified', port: 4041, path: '/a', status: 'active', capabilities: [], threadlineEnabled: true, framework: 'instar', lastVerified: '2026-01-01T00:00:00Z' },
          { name: 'unverified', port: 4042, path: '/b', status: 'unverified', capabilities: [], threadlineEnabled: true, framework: 'instar' },
          { name: 'inactive-verified', port: 4043, path: '/c', status: 'inactive', capabilities: [], threadlineEnabled: true, framework: 'instar', lastVerified: '2026-01-01T00:00:00Z' },
        ],
        updatedAt: '2026-01-01T00:00:00Z',
      };
      fs.writeFileSync(knownPath, JSON.stringify(knownData));

      const discovery = createDiscovery();
      const verified = discovery.getVerifiedAgents();

      expect(verified).toHaveLength(1);
      expect(verified[0].name).toBe('verified');
    });

    it('returns empty when no agents are verified', () => {
      const knownPath = path.join(stateDir, 'threadline', 'known-agents.json');
      const knownData = {
        agents: [
          { name: 'unverified', port: 4042, path: '/b', status: 'unverified', capabilities: [], threadlineEnabled: true, framework: 'instar' },
        ],
        updatedAt: '2026-01-01T00:00:00Z',
      };
      fs.writeFileSync(knownPath, JSON.stringify(knownData));

      const discovery = createDiscovery();
      expect(discovery.getVerifiedAgents()).toHaveLength(0);
    });
  });

  // ── File Operation Tests ───────────────────────────────────────

  describe('File operations', () => {
    it('uses atomic writes for known-agents.json', async () => {
      mockLoadRegistry.mockReturnValue({
        version: 1,
        entries: [
          {
            name: 'agent-a', type: 'project-bound', path: '/projects/a',
            port: 4041, pid: 1001, status: 'running',
            createdAt: '2026-01-01T00:00:00Z', lastHeartbeat: '2026-01-01T00:00:00Z',
          },
        ],
      });

      const responses = new Map([
        ['http://localhost:4041/threadline/health', {
          ok: true, status: 200,
          body: { status: 'ok', protocol: 'threadline', version: '1.0', agent: 'agent-a' },
        }],
      ]);

      const discovery = createDiscovery({ fetcher: mockFetcher(responses) });
      await discovery.discoverLocal();

      // Verify file is valid JSON (atomic write ensures no partial writes)
      const knownPath = path.join(stateDir, 'threadline', 'known-agents.json');
      const data = JSON.parse(fs.readFileSync(knownPath, 'utf-8'));
      expect(data.agents).toBeDefined();
      expect(data.updatedAt).toBeDefined();
    });

    it('uses atomic writes for agent-info.json', () => {
      const discovery = createDiscovery();
      discovery.announcePresence({ capabilities: ['test'], threadlineVersion: '1.0' });

      const infoPath = path.join(stateDir, 'threadline', 'agent-info.json');
      const data = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
      expect(data.name).toBe('self-agent');
    });

    it('recovers from corrupted known-agents.json', () => {
      const knownPath = path.join(stateDir, 'threadline', 'known-agents.json');
      fs.writeFileSync(knownPath, '{invalid json!!!');

      const discovery = createDiscovery();
      const agents = discovery.loadKnownAgents();

      expect(agents).toEqual([]);
    });

    it('recovers from corrupted agent-info.json', () => {
      const infoPath = path.join(stateDir, 'threadline', 'agent-info.json');
      fs.mkdirSync(path.dirname(infoPath), { recursive: true });
      fs.writeFileSync(infoPath, 'not json');

      const discovery = createDiscovery();
      const info = discovery.getSelfInfo();

      expect(info).toBeNull();
    });

    it('creates threadline directory if it does not exist', () => {
      const freshDir = path.join(tmpDir, 'fresh-state');
      const discovery = new AgentDiscovery({
        stateDir: freshDir,
        selfPath: '/projects/self',
        selfName: 'self-agent',
        selfPort: 4040,
      });

      expect(fs.existsSync(path.join(freshDir, 'threadline'))).toBe(true);
    });

    it('handles missing known-agents.json gracefully', () => {
      const discovery = createDiscovery();
      const agents = discovery.loadKnownAgents();
      expect(agents).toEqual([]);
    });
  });

  // ── Edge Case Tests ────────────────────────────────────────────

  describe('Edge cases', () => {
    it('handles duplicate agents in known-agents (upsert by name)', async () => {
      const validPubKey = 'ab'.repeat(32);
      const responses = new Map([
        ['http://localhost:4041/threadline/health', {
          ok: true, status: 200,
          body: {
            status: 'ok', protocol: 'threadline', version: '1.0',
            agent: 'target', identityPub: validPubKey,
          },
        }],
      ]);

      mockLoadRegistry.mockReturnValue({ version: 1, entries: [] });
      const discovery = createDiscovery({ fetcher: mockFetcher(responses) });

      // Verify twice — should upsert, not duplicate
      await discovery.verifyAgent('target', 4041);
      await discovery.verifyAgent('target', 4041);

      const known = discovery.loadKnownAgents();
      expect(known).toHaveLength(1);
    });

    it('handles all agents being down during discovery', async () => {
      mockLoadRegistry.mockReturnValue({
        version: 1,
        entries: [
          { name: 'a', type: 'project-bound', path: '/a', port: 4041, pid: 1, status: 'running', createdAt: '', lastHeartbeat: '' },
          { name: 'b', type: 'project-bound', path: '/b', port: 4042, pid: 2, status: 'running', createdAt: '', lastHeartbeat: '' },
          { name: 'c', type: 'project-bound', path: '/c', port: 4043, pid: 3, status: 'running', createdAt: '', lastHeartbeat: '' },
        ],
      });

      const discovery = createDiscovery({ fetcher: mockFetcher(new Map()) });
      const agents = await discovery.discoverLocal();

      expect(agents).toHaveLength(0);
    });

    it('uses framework from health response when available', async () => {
      mockLoadRegistry.mockReturnValue({
        version: 1,
        entries: [
          {
            name: 'cc-agent', type: 'project-bound', path: '/projects/cc',
            port: 4041, pid: 1001, status: 'running',
            createdAt: '2026-01-01T00:00:00Z', lastHeartbeat: '2026-01-01T00:00:00Z',
          },
        ],
      });

      const responses = new Map([
        ['http://localhost:4041/threadline/health', {
          ok: true, status: 200,
          body: {
            status: 'ok', protocol: 'threadline', version: '1.0',
            agent: 'cc-agent', framework: 'claude-code',
          },
        }],
      ]);

      const discovery = createDiscovery({ fetcher: mockFetcher(responses) });
      const agents = await discovery.discoverLocal();

      expect(agents[0].framework).toBe('claude-code');
    });

    it('defaults framework to instar when not in health response', async () => {
      mockLoadRegistry.mockReturnValue({
        version: 1,
        entries: [
          {
            name: 'basic', type: 'project-bound', path: '/projects/basic',
            port: 4041, pid: 1001, status: 'running',
            createdAt: '2026-01-01T00:00:00Z', lastHeartbeat: '2026-01-01T00:00:00Z',
          },
        ],
      });

      const responses = new Map([
        ['http://localhost:4041/threadline/health', {
          ok: true, status: 200,
          body: { status: 'ok', protocol: 'threadline', version: '1.0', agent: 'basic' },
        }],
      ]);

      const discovery = createDiscovery({ fetcher: mockFetcher(responses) });
      const agents = await discovery.discoverLocal();

      expect(agents[0].framework).toBe('instar');
    });
  });
});
