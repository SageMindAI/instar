/**
 * Integration tests for SemanticMemory Privacy Scoping (Phase 2C).
 *
 * Tests the full pipeline: remember → search → context assembly with privacy filtering.
 * Verifies cross-module integration between SemanticMemory and privacy utilities.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';
import {
  isVisibleToUser,
  privateScope,
  sharedProjectScope,
  defaultScope,
  buildPrivacySqlFilter,
} from '../../src/utils/privacy.js';

// ── Fixtures ─────────────────────────────────────────────────────

let testDir: string;
let memory: SemanticMemory;

const ALICE = { id: 'alice', name: 'Alice' };
const BOB = { id: 'bob', name: 'Bob' };
const CHARLIE = { id: 'charlie', name: 'Charlie' };

beforeEach(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-privacy-integ-'));
  memory = new SemanticMemory({
    dbPath: path.join(testDir, 'semantic.db'),
    decayHalfLifeDays: 30,
    lessonDecayHalfLifeDays: 90,
    staleThreshold: 0.2,
  });
  await memory.open();
});

afterEach(() => {
  memory.close();
  // safe-git-allow: incremental-migration
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ── Full Pipeline: Remember → Privacy Filter → Context ──────────

describe('full pipeline: remember → privacy filter → context', () => {
  it('privacy utilities and SemanticMemory produce consistent results', () => {
    // Use privacy utilities to determine scope
    const aliceScope = privateScope(ALICE.id);
    const sharedScope = sharedProjectScope();
    const userDefault = defaultScope(`user:${ALICE.id}`);
    const agentDefault = defaultScope('agent:discovery');

    expect(userDefault).toBe('private');
    expect(agentDefault).toBe('shared-project');

    // Store with determined scopes
    memory.remember({
      type: 'fact',
      name: 'Alice Personal Note',
      content: 'Alice personal note about the project',
      confidence: 0.9,
      lastVerified: new Date().toISOString(),
      source: `user:${ALICE.id}`,
      tags: ['personal'],
      ownerId: aliceScope.ownerId,
      privacyScope: aliceScope.type,
    });

    memory.remember({
      type: 'fact',
      name: 'Project Architecture',
      content: 'The project uses microservices architecture',
      confidence: 0.95,
      lastVerified: new Date().toISOString(),
      source: 'agent:discovery',
      tags: ['architecture'],
      privacyScope: sharedScope.type,
    });

    // Verify isVisibleToUser agrees with SemanticMemory filtering
    expect(isVisibleToUser('private', ALICE.id, ALICE.id)).toBe(true);
    expect(isVisibleToUser('private', ALICE.id, BOB.id)).toBe(false);
    expect(isVisibleToUser('shared-project', null, BOB.id)).toBe(true);

    // SemanticMemory search should agree with visibility check
    const aliceResults = memory.search('project', { userId: ALICE.id });
    expect(aliceResults.length).toBe(2); // personal note + architecture

    const bobResults = memory.search('project', { userId: BOB.id });
    expect(bobResults.length).toBe(1); // only architecture
    expect(bobResults[0].name).toBe('Project Architecture');
  });

  it('context assembly respects privacy end-to-end', () => {
    // Simulate a real agent conversation with multiple users
    const users = [ALICE, BOB, CHARLIE];

    for (const user of users) {
      // Each user creates private knowledge
      memory.remember({
        type: 'fact',
        name: `${user.name} Config`,
        content: `${user.name} database configuration uses port 5432`,
        confidence: 0.9,
        lastVerified: new Date().toISOString(),
        source: `user:${user.id}`,
        tags: ['config'],
        ownerId: user.id,
        privacyScope: 'private',
      });
    }

    // Agent creates shared knowledge
    memory.remember({
      type: 'fact',
      name: 'Database Protocol',
      content: 'The database uses PostgreSQL with SSL configuration',
      confidence: 0.95,
      lastVerified: new Date().toISOString(),
      source: 'agent:discovery',
      tags: ['config'],
      privacyScope: 'shared-project',
    });

    // Each user's context should include ONLY their config + shared
    for (const user of users) {
      const context = memory.getRelevantContext('database configuration', { userId: user.id });

      // Should contain their own config
      expect(context).toContain(`${user.name} database configuration`);
      // Should contain shared knowledge
      expect(context).toContain('PostgreSQL with SSL');

      // Should NOT contain other users' configs
      for (const otherUser of users) {
        if (otherUser.id !== user.id) {
          expect(context).not.toContain(`${otherUser.name} database configuration`);
        }
      }
    }
  });
});

// ── GDPR Operations Integration ──────────────────────────────────

describe('GDPR operations integration', () => {
  beforeEach(() => {
    // Build a realistic knowledge graph
    const aliceId1 = memory.remember({
      type: 'fact',
      name: 'Alice API Key',
      content: 'Alice API key for production',
      confidence: 0.9,
      lastVerified: new Date().toISOString(),
      source: `user:${ALICE.id}`,
      tags: ['credentials'],
      ownerId: ALICE.id,
      privacyScope: 'private',
    });

    const aliceId2 = memory.remember({
      type: 'lesson',
      name: 'Alice Lesson',
      content: 'Alice learned about caching strategies',
      confidence: 0.85,
      lastVerified: new Date().toISOString(),
      source: `session:abc`,
      tags: ['caching'],
      ownerId: ALICE.id,
      privacyScope: 'private',
    });

    const sharedId = memory.remember({
      type: 'fact',
      name: 'Shared Infrastructure',
      content: 'Infrastructure uses Kubernetes',
      confidence: 0.95,
      lastVerified: new Date().toISOString(),
      source: 'agent:discovery',
      tags: ['infra'],
      privacyScope: 'shared-project',
    });

    // Create relationships
    memory.connect(aliceId1, sharedId, 'related-to', 'API key used for infra');
    memory.connect(aliceId2, sharedId, 'derives-from', 'Lesson from infra work');
  });

  it('/mydata export captures all user-owned entities with relationships', () => {
    const aliceEntities = memory.getEntitiesByUser(ALICE.id);
    expect(aliceEntities).toHaveLength(2);

    // Verify entity details preserved
    const apiKey = aliceEntities.find(e => e.name === 'Alice API Key');
    expect(apiKey).toBeDefined();
    expect(apiKey!.type).toBe('fact');
    expect(apiKey!.tags).toContain('credentials');
  });

  it('/forget erasure removes user data but preserves shared knowledge', () => {
    // Before
    const beforeStats = memory.stats();
    expect(beforeStats.totalEntities).toBe(3);
    expect(beforeStats.totalEdges).toBe(2);

    // Erase Alice's data
    const deleted = memory.deleteEntitiesByUser(ALICE.id);
    expect(deleted).toBe(2);

    // After
    const afterStats = memory.stats();
    expect(afterStats.totalEntities).toBe(1); // Only shared remains
    expect(afterStats.totalEdges).toBe(0); // All edges involving Alice removed

    // Shared knowledge persists
    const results = memory.search('Kubernetes');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Shared Infrastructure');
  });
});

// ── Privacy + Graph Traversal ────────────────────────────────────

describe('privacy with graph traversal', () => {
  it('explore() returns connected entities regardless of privacy scope', () => {
    // explore() is a graph operation, not a search — it should return all connected nodes
    // Privacy filtering happens at the search/context level
    const privateId = memory.remember({
      type: 'fact',
      name: 'Private Start',
      content: 'Starting point',
      confidence: 0.9,
      lastVerified: new Date().toISOString(),
      source: `user:${ALICE.id}`,
      tags: [],
      ownerId: ALICE.id,
      privacyScope: 'private',
    });

    const sharedId = memory.remember({
      type: 'fact',
      name: 'Shared Connected',
      content: 'Connected via edge',
      confidence: 0.9,
      lastVerified: new Date().toISOString(),
      source: 'agent:discovery',
      tags: [],
      privacyScope: 'shared-project',
    });

    memory.connect(privateId, sharedId, 'related-to');

    const explored = memory.explore(privateId);
    expect(explored).toHaveLength(1);
    expect(explored[0].name).toBe('Shared Connected');
    expect(explored[0].privacyScope).toBe('shared-project');
  });
});

// ── buildPrivacySqlFilter integration ────────────────────────────

describe('buildPrivacySqlFilter integration with SemanticMemory columns', () => {
  it('filter clause uses correct column names for entities table', () => {
    const filter = buildPrivacySqlFilter(ALICE.id, {
      ownerColumn: 'e.owner_id',
      scopeColumn: 'e.privacy_scope',
    });

    // Should reference the right columns
    expect(filter.clause).toContain('e.privacy_scope');
    expect(filter.clause).toContain('e.owner_id');
    expect(filter.params).toContain(ALICE.id);
  });
});

// ── Confidence Decay with Privacy ────────────────────────────────

describe('confidence decay respects privacy metadata', () => {
  it('decayAll() processes entities with privacy fields without error', () => {
    memory.remember({
      type: 'fact',
      name: 'Old Private',
      content: 'Old private data',
      confidence: 0.9,
      lastVerified: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(), // 60 days old
      source: `user:${ALICE.id}`,
      tags: [],
      ownerId: ALICE.id,
      privacyScope: 'private',
    });

    memory.remember({
      type: 'fact',
      name: 'Old Shared',
      content: 'Old shared data',
      confidence: 0.9,
      lastVerified: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      source: 'agent:discovery',
      tags: [],
      privacyScope: 'shared-project',
    });

    const report = memory.decayAll();
    expect(report.entitiesProcessed).toBe(2);
    expect(report.entitiesDecayed).toBe(2); // Both should have decayed

    // Privacy fields preserved after decay
    const results = memory.getEntitiesByUser(ALICE.id);
    expect(results).toHaveLength(1);
    expect(results[0].ownerId).toBe(ALICE.id);
    expect(results[0].privacyScope).toBe('private');
    expect(results[0].confidence).toBeLessThan(0.9); // Decayed
  });
});
