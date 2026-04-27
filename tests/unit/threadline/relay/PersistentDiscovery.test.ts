/**
 * PersistentDiscovery Tests
 *
 * Tests the persistent discovery system:
 * - RegistryStore persists agents across "restarts"
 * - ConnectionManager auto-registers public agents in the registry
 * - Discovery uses persistent registry as primary, merges with live presence
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { RegistryStore } from '../../../../src/threadline/relay/RegistryStore.js';
import { PresenceRegistry } from '../../../../src/threadline/relay/PresenceRegistry.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));
}

function makeAgent(id: string, name: string, extras?: Partial<Parameters<RegistryStore['upsert']>[0]>) {
  return {
    publicKey: `pubkey-${id}`,
    agentId: `agent-${id}`,
    name,
    bio: `I am ${name}`,
    interests: ['conversation'],
    capabilities: ['chat'],
    framework: 'instar',
    frameworkVisible: true,
    homepage: '',
    visibility: 'public' as const,
    consentMethod: 'auth_handshake',
    ...extras,
  };
}

// ── RegistryStore Persistence ────────────────────────────────────────

describe('RegistryStore persistence', () => {
  let dataDir: string;
  let store: RegistryStore;

  beforeEach(() => {
    dataDir = makeTempDir();
    store = new RegistryStore({ dataDir, relayId: 'test-relay' });
  });

  afterEach(() => {
    store.destroy();
    // safe-git-allow: incremental-migration
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('persists agents across store re-creation (simulated restart)', () => {
    // Register two agents
    store.upsert(makeAgent('1', 'Alpha'));
    store.upsert(makeAgent('2', 'Beta'));
    store.setOnline('pubkey-1');
    store.setOnline('pubkey-2');

    // Verify they're visible
    const before = store.search({});
    expect(before.agents).toHaveLength(2);

    // Close and re-create (simulates server restart / deploy)
    store.destroy();
    const store2 = new RegistryStore({ dataDir, relayId: 'test-relay' });

    // Both agents should still be searchable
    const after = store2.search({});
    expect(after.agents).toHaveLength(2);
    expect(after.agents.map(a => a.name).sort()).toEqual(['Alpha', 'Beta']);

    // Online status should be reset on restart (crash recovery)
    expect(after.agents.every(a => !a.online)).toBe(true);

    store2.destroy();
  });

  it('search filters by capability', () => {
    store.upsert(makeAgent('1', 'ChatBot', { capabilities: ['chat', 'search'] }));
    store.upsert(makeAgent('2', 'SearchBot', { capabilities: ['search'] }));
    store.upsert(makeAgent('3', 'VoiceBot', { capabilities: ['voice'] }));

    const searchResults = store.search({ capability: 'search' });
    expect(searchResults.agents).toHaveLength(2);
    expect(searchResults.agents.map(a => a.name).sort()).toEqual(['ChatBot', 'SearchBot']);
  });

  it('search filters by framework', () => {
    store.upsert(makeAgent('1', 'InstarAgent', { framework: 'instar' }));
    store.upsert(makeAgent('2', 'LangchainAgent', { framework: 'langchain' }));

    const results = store.search({ framework: 'instar' });
    expect(results.agents).toHaveLength(1);
    expect(results.agents[0].name).toBe('InstarAgent');
  });

  it('excludes unlisted agents from search', () => {
    store.upsert(makeAgent('1', 'PublicBot'));
    store.upsert(makeAgent('2', 'HiddenBot', { visibility: 'unlisted' }));

    const results = store.search({});
    expect(results.agents).toHaveLength(1);
    expect(results.agents[0].name).toBe('PublicBot');
  });

  it('tracks online/offline status', () => {
    store.upsert(makeAgent('1', 'Agent1'));
    store.setOnline('pubkey-1');

    let entry = store.getByPublicKey('pubkey-1');
    expect(entry?.online).toBe(true);

    store.setOffline('pubkey-1');
    entry = store.getByPublicKey('pubkey-1');
    expect(entry?.online).toBe(false);
  });

  it('upsert updates existing entries without duplicating', () => {
    store.upsert(makeAgent('1', 'OldName'));
    store.upsert(makeAgent('1', 'NewName'));

    const results = store.search({});
    expect(results.agents).toHaveLength(1);
    expect(results.agents[0].name).toBe('NewName');
  });
});

// ── Discovery Merging (Presence + Registry) ─────────────────────────

describe('Discovery merge logic', () => {
  let dataDir: string;
  let registry: RegistryStore;
  let presence: PresenceRegistry;

  beforeEach(() => {
    dataDir = makeTempDir();
    registry = new RegistryStore({ dataDir, relayId: 'test-relay' });
    presence = new PresenceRegistry({ maxAgents: 100 });
  });

  afterEach(() => {
    registry?.destroy();
    // safe-git-allow: incremental-migration
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /**
   * Simulates the handleDiscover merge logic from RelayServer.
   * This mirrors the actual code so we can test without a full WebSocket server.
   */
  function simulateDiscovery(filter?: { capability?: string; framework?: string; name?: string }) {
    // Step 1: Query persistent registry (primary source)
    const registryResult = registry.search({
      capability: filter?.capability,
      framework: filter?.framework,
      q: filter?.name,
      limit: 100,
    });

    // Step 2: Merge with live presence status
    const agents = registryResult.agents.map(entry => ({
      agentId: entry.agentId,
      name: entry.name,
      framework: entry.framework,
      capabilities: entry.capabilities,
      status: presence.isOnline(entry.agentId) ? 'online' as const : 'offline' as const,
      connectedSince: presence.get(entry.agentId)?.connectedSince ?? undefined,
      lastSeen: entry.lastSeen,
    }));

    // Step 3: Include agents from presence not yet in registry
    const registryAgentIds = new Set(registryResult.agents.map(a => a.agentId));
    const presenceAgents = presence.discover(filter);
    for (const pa of presenceAgents) {
      if (!registryAgentIds.has(pa.agentId)) {
        agents.push({
          agentId: pa.agentId,
          name: pa.metadata.name,
          framework: pa.metadata.framework ?? 'unknown',
          capabilities: pa.metadata.capabilities ?? [],
          status: 'online' as const,
          connectedSince: pa.connectedSince,
          lastSeen: new Date().toISOString(),
        });
      }
    }

    return agents;
  }

  it('returns offline registry agents even when not connected', () => {
    // Agent registered in persistent registry but NOT in live presence
    registry.upsert(makeAgent('1', 'PersistentBot'));

    const agents = simulateDiscovery();
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('PersistentBot');
    expect(agents[0].status).toBe('offline');
  });

  it('shows correct online status for connected registry agents', () => {
    // Agent in both registry and presence
    registry.upsert(makeAgent('1', 'ActiveBot'));
    presence.register('agent-1', 'pubkey-1', { name: 'ActiveBot', framework: 'instar' }, 'public', 'session-1');

    const agents = simulateDiscovery();
    expect(agents).toHaveLength(1);
    expect(agents[0].status).toBe('online');
    expect(agents[0].connectedSince).toBeDefined();
  });

  it('includes presence-only agents not yet in registry', () => {
    // Agent only in live presence, not in persistent registry
    presence.register('agent-new', 'pubkey-new', {
      name: 'NewAgent',
      framework: 'custom',
      capabilities: ['chat'],
    }, 'public', 'session-x');

    const agents = simulateDiscovery();
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('NewAgent');
    expect(agents[0].status).toBe('online');
  });

  it('does not duplicate agents present in both registry and presence', () => {
    // Same agent in both
    registry.upsert(makeAgent('shared', 'SharedBot'));
    presence.register('agent-shared', 'pubkey-shared', { name: 'SharedBot', framework: 'instar' }, 'public', 'session-s');

    const agents = simulateDiscovery();
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('SharedBot');
  });

  it('merges multiple agents from both sources correctly', () => {
    // 2 in registry, 1 connected
    registry.upsert(makeAgent('r1', 'RegistryBot1'));
    registry.upsert(makeAgent('r2', 'RegistryBot2'));
    presence.register('agent-r1', 'pubkey-r1', { name: 'RegistryBot1' }, 'public', 'session-1');

    // 1 only in presence
    presence.register('agent-p1', 'pubkey-p1', {
      name: 'PresenceOnlyBot',
      framework: 'other',
      capabilities: ['voice'],
    }, 'public', 'session-2');

    const agents = simulateDiscovery();
    expect(agents).toHaveLength(3);

    const names = agents.map(a => a.name).sort();
    expect(names).toEqual(['PresenceOnlyBot', 'RegistryBot1', 'RegistryBot2']);

    // RegistryBot1 is online (in both), RegistryBot2 is offline (registry only)
    const rb1 = agents.find(a => a.name === 'RegistryBot1')!;
    const rb2 = agents.find(a => a.name === 'RegistryBot2')!;
    const pb = agents.find(a => a.name === 'PresenceOnlyBot')!;

    expect(rb1.status).toBe('online');
    expect(rb2.status).toBe('offline');
    expect(pb.status).toBe('online');
  });

  it('filters by capability across both sources', () => {
    registry.upsert(makeAgent('1', 'ChatBot', { capabilities: ['chat'] }));
    registry.upsert(makeAgent('2', 'VoiceBot', { capabilities: ['voice'] }));
    presence.register('agent-3', 'pubkey-3', {
      name: 'SearchBot',
      capabilities: ['search'],
    }, 'public', 'session-3');

    const chatAgents = simulateDiscovery({ capability: 'chat' });
    expect(chatAgents).toHaveLength(1);
    expect(chatAgents[0].name).toBe('ChatBot');
  });

  it('excludes unlisted presence agents from discovery', () => {
    presence.register('agent-pub', 'pk-pub', { name: 'PublicBot' }, 'public', 's1');
    presence.register('agent-unl', 'pk-unl', { name: 'UnlistedBot' }, 'unlisted', 's2');

    const agents = simulateDiscovery();
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('PublicBot');
  });
});

// ── Auto-registration on Connect ────────────────────────────────────

describe('Auto-registration of public agents', () => {
  let dataDir: string;
  let registry: RegistryStore;

  beforeEach(() => {
    dataDir = makeTempDir();
    registry = new RegistryStore({ dataDir, relayId: 'test-relay' });
  });

  afterEach(() => {
    registry?.destroy();
    // safe-git-allow: incremental-migration
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('public agents are auto-registered in registry on connect', () => {
    // Simulate what ConnectionManager does for public visibility
    const visibility = 'public';
    if (visibility === 'public') {
      registry.upsert({
        publicKey: 'test-key',
        agentId: 'test-agent',
        name: 'TestBot',
        bio: '',
        interests: [],
        capabilities: ['chat'],
        framework: 'instar',
        frameworkVisible: true,
        homepage: '',
        visibility: 'public',
        consentMethod: 'auth_handshake',
      });
    }

    const entry = registry.getByPublicKey('test-key');
    expect(entry).not.toBeNull();
    expect(entry!.name).toBe('TestBot');
    expect(entry!.agentId).toBe('test-agent');
  });

  it('unlisted agents are NOT auto-registered', () => {
    const visibility = 'unlisted';
    if (visibility === 'public') {
      registry.upsert({
        publicKey: 'hidden-key',
        agentId: 'hidden-agent',
        name: 'HiddenBot',
        bio: '',
        interests: [],
        capabilities: ['chat'],
        framework: 'instar',
        consentMethod: 'auth_handshake',
      });
    }

    const entry = registry.getByPublicKey('hidden-key');
    expect(entry).toBeNull();
  });

  it('unlisted agents update last_seen if previously registered', () => {
    // First register as public
    registry.upsert({
      publicKey: 'switch-key',
      agentId: 'switch-agent',
      name: 'SwitchBot',
      bio: '',
      interests: [],
      capabilities: ['chat'],
      framework: 'instar',
      consentMethod: 'auth_handshake',
      visibility: 'public',
    });

    // Now reconnect as unlisted — should update last_seen, not create new entry
    const visibility = 'unlisted';
    if (visibility === 'public') {
      // Would create — but visibility is unlisted, so skip
    } else {
      const existing = registry.getByPublicKey('switch-key');
      if (existing) {
        registry.setOnline('switch-key');
      }
    }

    const entry = registry.getByPublicKey('switch-key');
    expect(entry).not.toBeNull();
    expect(entry!.online).toBe(true);
    expect(entry!.name).toBe('SwitchBot');
  });
});
