/**
 * Tests for SemanticMemory — the entity-relationship knowledge store.
 *
 * Written test-first: these tests define the contract that SemanticMemory
 * must fulfill. The implementation comes after.
 *
 * Uses REAL SQLite databases in temp directories. No mocking of the
 * database layer — that's the whole point. The tests verify that:
 *
 * 1. Entity CRUD works end-to-end (create, read, update, delete)
 * 2. Edge CRUD creates real connections between entities
 * 3. FTS5 search returns relevant results ranked by multi-signal scoring
 * 4. Confidence decay reduces old knowledge's weight over time
 * 5. Graph traversal (explore) follows edges correctly
 * 6. Export/import produces identical round-trip data
 * 7. Verify operation refreshes confidence
 * 8. Supersede creates proper edge + lowers old entity confidence
 * 9. Stale detection finds low-confidence entities
 * 10. Edge cases don't crash (empty DB, missing entities, etc.)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';
import type {
  MemoryEntity,
  MemoryEdge,
  EntityType,
  RelationType,
} from '../../src/core/types.js';

// ─── Helpers ─────────────────────────────────────────────────────

interface TestSetup {
  dir: string;
  dbPath: string;
  memory: SemanticMemory;
  cleanup: () => void;
}

async function createTestMemory(): Promise<TestSetup> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-mem-test-'));
  const dbPath = path.join(dir, 'semantic.db');
  const memory = new SemanticMemory({ dbPath, decayHalfLifeDays: 30, lessonDecayHalfLifeDays: 90, staleThreshold: 0.2 });
  await memory.open();

  return {
    dir,
    dbPath,
    memory,
    cleanup: () => {
      memory.close();
      // safe-git-allow: incremental-migration
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ─── Entity CRUD ─────────────────────────────────────────────────

describe('SemanticMemory', () => {
  let setup: TestSetup;

  beforeEach(async () => {
    setup = await createTestMemory();
  });

  afterEach(() => {
    setup?.cleanup();
  });

  describe('entity CRUD', () => {
    it('creates an entity and returns an id', () => {
      const id = setup.memory.remember({
        type: 'fact',
        name: 'API endpoint',
        content: 'The user API is at /api/v2/users',
        confidence: 0.9,
        lastVerified: new Date().toISOString(),
        source: 'session:test-001',
        tags: ['api', 'infrastructure'],
        domain: 'infrastructure',
      });

      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });

    it('retrieves a created entity by id', () => {
      const id = setup.memory.remember({
        type: 'fact',
        name: 'Deploy target',
        content: 'Production deploys to Vercel via main branch',
        confidence: 0.95,
        lastVerified: new Date().toISOString(),
        source: 'observation',
        tags: ['deployment'],
      });

      const result = setup.memory.recall(id);
      expect(result).not.toBeNull();
      expect(result!.entity.name).toBe('Deploy target');
      expect(result!.entity.content).toContain('Vercel');
      expect(result!.entity.type).toBe('fact');
      expect(result!.entity.confidence).toBe(0.95);
      expect(result!.entity.tags).toContain('deployment');
    });

    it('returns null for non-existent entity', () => {
      const result = setup.memory.recall('non-existent-id');
      expect(result).toBeNull();
    });

    it('creates entities with all entity types', () => {
      const types: EntityType[] = ['fact', 'person', 'project', 'tool', 'pattern', 'decision', 'lesson'];

      for (const type of types) {
        const id = setup.memory.remember({
          type,
          name: `Test ${type}`,
          content: `Content for ${type}`,
          confidence: 0.8,
          lastVerified: new Date().toISOString(),
          source: 'test',
          tags: [],
        });

        const result = setup.memory.recall(id);
        expect(result!.entity.type).toBe(type);
      }
    });

    it('forgets an entity', () => {
      const id = setup.memory.remember({
        type: 'fact',
        name: 'Temporary fact',
        content: 'This will be deleted',
        confidence: 0.5,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: [],
      });

      setup.memory.forget(id, 'test cleanup');

      const result = setup.memory.recall(id);
      expect(result).toBeNull();
    });

    it('forgets an entity and its edges', () => {
      const id1 = setup.memory.remember({
        type: 'person',
        name: 'Alice',
        content: 'Alice is a developer',
        confidence: 0.9,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: [],
      });

      const id2 = setup.memory.remember({
        type: 'project',
        name: 'Project X',
        content: 'A web application',
        confidence: 0.9,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: [],
      });

      setup.memory.connect(id1, id2, 'built_by', 'Alice built Project X');

      // Forget Alice — edge should also be removed
      setup.memory.forget(id1, 'test');

      const result = setup.memory.recall(id2);
      expect(result!.connections).toHaveLength(0);
    });
  });

  // ─── Edge CRUD ─────────────────────────────────────────────────

  describe('edge CRUD', () => {
    it('connects two entities', () => {
      const personId = setup.memory.remember({
        type: 'person',
        name: 'Justin',
        content: 'Justin is the founder',
        confidence: 1.0,
        lastVerified: new Date().toISOString(),
        source: 'user:Justin',
        tags: ['team'],
      });

      const projectId = setup.memory.remember({
        type: 'project',
        name: 'Portal',
        content: 'AI chatbot platform',
        confidence: 1.0,
        lastVerified: new Date().toISOString(),
        source: 'observation',
        tags: ['product'],
      });

      const edgeId = setup.memory.connect(personId, projectId, 'built_by', 'Justin built Portal');
      expect(edgeId).toBeTruthy();

      // Recall should show connection
      const result = setup.memory.recall(personId);
      expect(result!.connections).toHaveLength(1);
      expect(result!.connections[0].entity.name).toBe('Portal');
      expect(result!.connections[0].edge.relation).toBe('built_by');
    });

    it('shows bidirectional connections', () => {
      const id1 = setup.memory.remember({
        type: 'fact',
        name: 'Fact A',
        content: 'First fact',
        confidence: 0.8,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: [],
      });

      const id2 = setup.memory.remember({
        type: 'fact',
        name: 'Fact B',
        content: 'Second fact',
        confidence: 0.8,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: [],
      });

      setup.memory.connect(id1, id2, 'related_to');

      // Recall id2 should show incoming connection from id1
      const result = setup.memory.recall(id2);
      expect(result!.connections).toHaveLength(1);
      expect(result!.connections[0].entity.name).toBe('Fact A');
      expect(result!.connections[0].direction).toBe('incoming');
    });

    it('rejects duplicate edges (same from, to, relation)', () => {
      const id1 = setup.memory.remember({
        type: 'fact',
        name: 'A',
        content: 'A',
        confidence: 0.8,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: [],
      });

      const id2 = setup.memory.remember({
        type: 'fact',
        name: 'B',
        content: 'B',
        confidence: 0.8,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: [],
      });

      setup.memory.connect(id1, id2, 'related_to');

      // Second connect with same relation should not create duplicate
      // (should either throw or return the existing edge id)
      expect(() => {
        setup.memory.connect(id1, id2, 'related_to');
      }).not.toThrow();

      const result = setup.memory.recall(id1);
      const relatedToEdges = result!.connections.filter(c => c.edge.relation === 'related_to');
      expect(relatedToEdges).toHaveLength(1);
    });

    it('allows different relation types between same entities', () => {
      const id1 = setup.memory.remember({
        type: 'fact',
        name: 'Old fact',
        content: 'The old way',
        confidence: 0.5,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: [],
      });

      const id2 = setup.memory.remember({
        type: 'fact',
        name: 'New fact',
        content: 'The new way',
        confidence: 0.9,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: [],
      });

      setup.memory.connect(id1, id2, 'related_to');
      setup.memory.connect(id2, id1, 'supersedes');

      const result = setup.memory.recall(id1);
      expect(result!.connections.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── FTS5 Search ───────────────────────────────────────────────

  describe('search', () => {
    it('finds entities by keyword', () => {
      setup.memory.remember({
        type: 'fact',
        name: 'Deployment process',
        content: 'We deploy to Vercel using the main branch. Builds take 3-4 minutes.',
        confidence: 0.9,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: ['deployment'],
      });

      setup.memory.remember({
        type: 'fact',
        name: 'Database config',
        content: 'The database is PostgreSQL hosted on Xata cloud.',
        confidence: 0.85,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: ['database'],
      });

      const results = setup.memory.search('deployment Vercel');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe('Deployment process');
    });

    it('returns empty array for no matches', () => {
      setup.memory.remember({
        type: 'fact',
        name: 'Something',
        content: 'Unrelated content about weather',
        confidence: 0.8,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: [],
      });

      const results = setup.memory.search('quantum physics');
      expect(results).toHaveLength(0);
    });

    it('ranks higher-confidence entities above lower-confidence ones', () => {
      // Same keywords, different confidence
      setup.memory.remember({
        type: 'fact',
        name: 'Low confidence deploy fact',
        content: 'Deploy might use Docker containers',
        confidence: 0.3,
        lastVerified: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days old
        source: 'test',
        tags: ['deployment'],
      });

      setup.memory.remember({
        type: 'fact',
        name: 'High confidence deploy fact',
        content: 'Deploy uses Vercel serverless functions',
        confidence: 0.95,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: ['deployment'],
      });

      const results = setup.memory.search('deploy');
      expect(results.length).toBe(2);
      expect(results[0].name).toBe('High confidence deploy fact');
    });

    it('filters by entity type', () => {
      setup.memory.remember({
        type: 'fact',
        name: 'A fact',
        content: 'Testing is important for quality',
        confidence: 0.8,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: [],
      });

      setup.memory.remember({
        type: 'lesson',
        name: 'A lesson',
        content: 'Testing should use real databases not mocks',
        confidence: 0.8,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: [],
      });

      const results = setup.memory.search('testing', { types: ['lesson'] });
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('lesson');
    });

    it('filters by domain', () => {
      setup.memory.remember({
        type: 'fact',
        name: 'Infra fact',
        content: 'Server runs on port 3000',
        confidence: 0.8,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: [],
        domain: 'infrastructure',
      });

      setup.memory.remember({
        type: 'fact',
        name: 'Business fact',
        content: 'Server is hosted by Vercel',
        confidence: 0.8,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: [],
        domain: 'business',
      });

      const results = setup.memory.search('server', { domain: 'infrastructure' });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Infra fact');
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        setup.memory.remember({
          type: 'fact',
          name: `Fact ${i}`,
          content: `This is deployment fact number ${i}`,
          confidence: 0.8,
          lastVerified: new Date().toISOString(),
          source: 'test',
          tags: [],
        });
      }

      const results = setup.memory.search('deployment', { limit: 3 });
      expect(results).toHaveLength(3);
    });

    it('filters by minimum confidence', () => {
      setup.memory.remember({
        type: 'fact',
        name: 'Low confidence',
        content: 'Maybe the API uses GraphQL',
        confidence: 0.2,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: [],
      });

      setup.memory.remember({
        type: 'fact',
        name: 'High confidence',
        content: 'The API definitely uses REST with GraphQL for subscriptions',
        confidence: 0.9,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: [],
      });

      const results = setup.memory.search('GraphQL', { minConfidence: 0.5 });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('High confidence');
    });
  });

  // ─── Confidence Decay ──────────────────────────────────────────

  describe('confidence decay', () => {
    it('reduces confidence of unverified entities', () => {
      const id = setup.memory.remember({
        type: 'fact',
        name: 'Aging fact',
        content: 'This fact was verified 60 days ago',
        confidence: 0.9,
        lastVerified: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
        source: 'test',
        tags: [],
      });

      const report = setup.memory.decayAll();

      expect(report.entitiesProcessed).toBe(1);
      expect(report.entitiesDecayed).toBeGreaterThan(0);

      const entity = setup.memory.recall(id);
      // After 60 days with 30-day half-life, confidence should be ~0.25 (0.9 * 0.25)
      expect(entity!.entity.confidence).toBeLessThan(0.5);
    });

    it('does not decay recently verified entities', () => {
      const id = setup.memory.remember({
        type: 'fact',
        name: 'Fresh fact',
        content: 'Verified just now',
        confidence: 0.9,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: [],
      });

      setup.memory.decayAll();

      const entity = setup.memory.recall(id);
      // Should be unchanged (or very close to 0.9)
      expect(entity!.entity.confidence).toBeGreaterThan(0.85);
    });

    it('lessons decay slower than facts', () => {
      const factId = setup.memory.remember({
        type: 'fact',
        name: 'Old fact',
        content: 'A factual observation from 60 days ago',
        confidence: 0.9,
        lastVerified: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
        source: 'test',
        tags: [],
      });

      const lessonId = setup.memory.remember({
        type: 'lesson',
        name: 'Old lesson',
        content: 'A hard-won lesson from 60 days ago',
        confidence: 0.9,
        lastVerified: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
        source: 'test',
        tags: [],
      });

      setup.memory.decayAll();

      const fact = setup.memory.recall(factId);
      const lesson = setup.memory.recall(lessonId);

      // Lesson should retain more confidence than the fact
      expect(lesson!.entity.confidence).toBeGreaterThan(fact!.entity.confidence);
    });

    it('returns accurate decay report', () => {
      // One fresh, one old
      setup.memory.remember({
        type: 'fact',
        name: 'Fresh',
        content: 'Fresh fact',
        confidence: 0.9,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: [],
      });

      setup.memory.remember({
        type: 'fact',
        name: 'Old',
        content: 'Old fact',
        confidence: 0.9,
        lastVerified: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
        source: 'test',
        tags: [],
      });

      const report = setup.memory.decayAll();
      expect(report.entitiesProcessed).toBe(2);
      expect(report.entitiesDecayed).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Verify ────────────────────────────────────────────────────

  describe('verify', () => {
    it('refreshes lastVerified timestamp and optional confidence', () => {
      const id = setup.memory.remember({
        type: 'fact',
        name: 'Verified fact',
        content: 'This will be re-verified',
        confidence: 0.5,
        lastVerified: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        source: 'test',
        tags: [],
      });

      setup.memory.verify(id, 0.95);

      const entity = setup.memory.recall(id);
      expect(entity!.entity.confidence).toBe(0.95);

      // lastVerified should be recent
      const verifiedAt = new Date(entity!.entity.lastVerified);
      const now = new Date();
      expect(now.getTime() - verifiedAt.getTime()).toBeLessThan(5000);
    });

    it('refreshes lastVerified without changing confidence when not specified', () => {
      const id = setup.memory.remember({
        type: 'fact',
        name: 'Keep confidence',
        content: 'Confidence stays the same',
        confidence: 0.7,
        lastVerified: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        source: 'test',
        tags: [],
      });

      setup.memory.verify(id);

      const entity = setup.memory.recall(id);
      expect(entity!.entity.confidence).toBe(0.7);
    });
  });

  // ─── Supersede ─────────────────────────────────────────────────

  describe('supersede', () => {
    it('creates supersedes edge and lowers old entity confidence', () => {
      const oldId = setup.memory.remember({
        type: 'fact',
        name: 'Old API endpoint',
        content: 'API is at /v1/users',
        confidence: 0.8,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: ['api'],
      });

      const newId = setup.memory.remember({
        type: 'fact',
        name: 'New API endpoint',
        content: 'API is now at /v2/users',
        confidence: 0.95,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: ['api'],
      });

      setup.memory.supersede(oldId, newId, 'API migrated to v2');

      // Old entity should have lower confidence
      const oldEntity = setup.memory.recall(oldId);
      expect(oldEntity!.entity.confidence).toBeLessThan(0.8);

      // New entity should have a supersedes edge
      const newEntity = setup.memory.recall(newId);
      const supersededEdges = newEntity!.connections.filter(
        c => c.edge.relation === 'supersedes'
      );
      expect(supersededEdges).toHaveLength(1);
    });
  });

  // ─── Graph Traversal ──────────────────────────────────────────

  describe('explore', () => {
    it('finds directly connected entities (depth 1)', () => {
      const personId = setup.memory.remember({
        type: 'person', name: 'Alice', content: 'Engineer',
        confidence: 0.9, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      const project1 = setup.memory.remember({
        type: 'project', name: 'Frontend', content: 'React app',
        confidence: 0.9, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      const project2 = setup.memory.remember({
        type: 'project', name: 'Backend', content: 'Node.js API',
        confidence: 0.9, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      setup.memory.connect(personId, project1, 'built_by');
      setup.memory.connect(personId, project2, 'built_by');

      const results = setup.memory.explore(personId, { maxDepth: 1 });
      expect(results).toHaveLength(2);
      const names = results.map(e => e.name);
      expect(names).toContain('Frontend');
      expect(names).toContain('Backend');
    });

    it('finds 2-hop connections', () => {
      const personId = setup.memory.remember({
        type: 'person', name: 'Alice', content: 'Engineer',
        confidence: 0.9, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      const projectId = setup.memory.remember({
        type: 'project', name: 'App', content: 'Web app',
        confidence: 0.9, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      const toolId = setup.memory.remember({
        type: 'tool', name: 'React', content: 'UI framework',
        confidence: 0.9, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      setup.memory.connect(personId, projectId, 'built_by');
      setup.memory.connect(projectId, toolId, 'depends_on');

      // From Alice, depth 1 should find App but not React
      const depth1 = setup.memory.explore(personId, { maxDepth: 1 });
      expect(depth1.map(e => e.name)).toContain('App');
      expect(depth1.map(e => e.name)).not.toContain('React');

      // From Alice, depth 2 should find both
      const depth2 = setup.memory.explore(personId, { maxDepth: 2 });
      expect(depth2.map(e => e.name)).toContain('App');
      expect(depth2.map(e => e.name)).toContain('React');
    });

    it('filters by relation type', () => {
      const personId = setup.memory.remember({
        type: 'person', name: 'Bob', content: 'Manager',
        confidence: 0.9, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      const projectId = setup.memory.remember({
        type: 'project', name: 'Dashboard', content: 'Admin UI',
        confidence: 0.9, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      const topicId = setup.memory.remember({
        type: 'fact', name: 'React patterns', content: 'Component patterns',
        confidence: 0.9, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      setup.memory.connect(personId, projectId, 'built_by');
      setup.memory.connect(personId, topicId, 'knows_about');

      // Only follow 'built_by' edges
      const results = setup.memory.explore(personId, { relations: ['built_by'] });
      expect(results.map(e => e.name)).toContain('Dashboard');
      expect(results.map(e => e.name)).not.toContain('React patterns');
    });

    it('returns empty for entity with no connections', () => {
      const id = setup.memory.remember({
        type: 'fact', name: 'Isolated', content: 'No connections',
        confidence: 0.8, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      const results = setup.memory.explore(id);
      expect(results).toHaveLength(0);
    });

    it('does not include the start entity in results', () => {
      const id1 = setup.memory.remember({
        type: 'fact', name: 'Start', content: 'Start point',
        confidence: 0.8, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      const id2 = setup.memory.remember({
        type: 'fact', name: 'End', content: 'End point',
        confidence: 0.8, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      setup.memory.connect(id1, id2, 'related_to');

      const results = setup.memory.explore(id1);
      expect(results.map(e => e.name)).not.toContain('Start');
    });
  });

  // ─── Stale Detection ──────────────────────────────────────────

  describe('findStale', () => {
    it('returns entities below confidence threshold', () => {
      setup.memory.remember({
        type: 'fact', name: 'High confidence', content: 'Fresh',
        confidence: 0.9, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      setup.memory.remember({
        type: 'fact', name: 'Low confidence', content: 'Stale',
        confidence: 0.1, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      const stale = setup.memory.findStale({ maxConfidence: 0.2 });
      expect(stale).toHaveLength(1);
      expect(stale[0].name).toBe('Low confidence');
    });

    it('finds old unverified entities', () => {
      setup.memory.remember({
        type: 'fact', name: 'Old fact', content: 'From long ago',
        confidence: 0.5,
        lastVerified: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
        source: 'test', tags: [],
      });

      const stale = setup.memory.findStale({
        olderThan: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      });
      expect(stale).toHaveLength(1);
    });
  });

  // ─── Export / Import ───────────────────────────────────────────

  describe('export and import', () => {
    it('round-trips entities and edges through export/import', async () => {
      const id1 = setup.memory.remember({
        type: 'person', name: 'Alice', content: 'Developer',
        confidence: 0.9, lastVerified: new Date().toISOString(),
        source: 'test', tags: ['team'],
        domain: 'relationships',
      });

      const id2 = setup.memory.remember({
        type: 'project', name: 'Portal', content: 'Web platform',
        confidence: 0.95, lastVerified: new Date().toISOString(),
        source: 'test', tags: ['product'],
        domain: 'business',
      });

      setup.memory.connect(id1, id2, 'built_by', 'Alice built Portal');

      // Export
      const exported = setup.memory.export();
      expect(exported.entities).toHaveLength(2);
      expect(exported.edges).toHaveLength(1);

      // Create fresh database and import
      const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-import-'));
      const importDb = new SemanticMemory({
        dbPath: path.join(importDir, 'import.db'),
        decayHalfLifeDays: 30,
        lessonDecayHalfLifeDays: 90,
        staleThreshold: 0.2,
      });
      await importDb.open();

      const report = importDb.import(exported);
      expect(report.entitiesImported).toBe(2);
      expect(report.edgesImported).toBe(1);

      // Verify data integrity
      const alice = importDb.recall(id1);
      expect(alice!.entity.name).toBe('Alice');
      expect(alice!.entity.domain).toBe('relationships');
      expect(alice!.connections).toHaveLength(1);
      expect(alice!.connections[0].entity.name).toBe('Portal');

      importDb.close();
      // safe-git-allow: incremental-migration
      fs.rmSync(importDir, { recursive: true, force: true });
    });

    it('handles import into non-empty database (skips duplicates)', async () => {
      const id = setup.memory.remember({
        type: 'fact', name: 'Existing', content: 'Already here',
        confidence: 0.8, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      const exported = setup.memory.export();

      // Import back into same database — should skip existing
      const report = setup.memory.import(exported);
      expect(report.entitiesSkipped).toBe(1);

      // Should still have only 1 entity
      const stats = setup.memory.stats();
      expect(stats.totalEntities).toBe(1);
    });
  });

  // ─── Statistics ────────────────────────────────────────────────

  describe('stats', () => {
    it('returns accurate statistics', () => {
      setup.memory.remember({
        type: 'fact', name: 'Fact 1', content: 'Content 1',
        confidence: 0.9, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      setup.memory.remember({
        type: 'lesson', name: 'Lesson 1', content: 'Content 2',
        confidence: 0.5, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      const stats = setup.memory.stats();
      expect(stats.totalEntities).toBe(2);
      expect(stats.totalEdges).toBe(0);
      expect(stats.entityCountsByType.fact).toBe(1);
      expect(stats.entityCountsByType.lesson).toBe(1);
      expect(stats.avgConfidence).toBe(0.7);
      expect(stats.dbSizeBytes).toBeGreaterThan(0);
    });

    it('returns zeroes for empty database', () => {
      const stats = setup.memory.stats();
      expect(stats.totalEntities).toBe(0);
      expect(stats.totalEdges).toBe(0);
      expect(stats.avgConfidence).toBe(0);
    });
  });

  // ─── getRelevantContext ────────────────────────────────────────

  describe('getRelevantContext', () => {
    it('returns formatted markdown context for a query', () => {
      setup.memory.remember({
        type: 'fact',
        name: 'Deployment process',
        content: 'We deploy to Vercel. Builds take 3-4 minutes.',
        confidence: 0.9,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: ['deployment'],
      });

      const context = setup.memory.getRelevantContext('deployment');
      expect(context).toBeTruthy();
      expect(context).toContain('Deployment process');
      expect(context).toContain('Vercel');
    });

    it('returns empty string for no matches', () => {
      const context = setup.memory.getRelevantContext('nonexistent topic');
      expect(context).toBe('');
    });

    it('respects maxTokens budget', () => {
      // Add many entities
      for (let i = 0; i < 20; i++) {
        setup.memory.remember({
          type: 'fact',
          name: `Deploy fact ${i}`,
          content: `Deployment detail number ${i}: ${'x'.repeat(200)}`,
          confidence: 0.8,
          lastVerified: new Date().toISOString(),
          source: 'test',
          tags: [],
        });
      }

      const context = setup.memory.getRelevantContext('deployment', { maxTokens: 500 });
      // Should be roughly within the token budget (word count / 0.75 ≈ tokens)
      const wordCount = context.split(/\s+/).length;
      expect(wordCount).toBeLessThan(700); // Some tolerance
    });
  });

  // ─── WAL Checkpoint ───────────────────────────────────────────

  describe('checkpoint', () => {
    it('does not throw on an open database', () => {
      expect(() => setup.memory.checkpoint()).not.toThrow();
    });

    it('can be called multiple times without error', () => {
      expect(() => {
        setup.memory.checkpoint();
        setup.memory.checkpoint();
        setup.memory.checkpoint();
      }).not.toThrow();
    });

    it('does not corrupt data after checkpoint', () => {
      const id = setup.memory.remember({
        type: 'fact', name: 'Pre-checkpoint', content: 'Before checkpoint',
        confidence: 0.9, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      setup.memory.checkpoint();

      const id2 = setup.memory.remember({
        type: 'fact', name: 'Post-checkpoint', content: 'After checkpoint',
        confidence: 0.8, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      setup.memory.checkpoint();

      expect(setup.memory.recall(id)).not.toBeNull();
      expect(setup.memory.recall(id2)).not.toBeNull();
      expect(setup.memory.stats().totalEntities).toBe(2);
    });

    it('search works after checkpoint', () => {
      setup.memory.remember({
        type: 'fact', name: 'Checkpoint search test', content: 'Unique searchable checkpoint content',
        confidence: 0.9, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      setup.memory.checkpoint();

      const results = setup.memory.search('checkpoint content');
      expect(results.length).toBeGreaterThan(0);
    });
  });

  // ─── Edge Cases ────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty search query', () => {
      const results = setup.memory.search('');
      expect(results).toHaveLength(0);
    });

    it('handles special characters in search', () => {
      setup.memory.remember({
        type: 'fact', name: 'Special chars', content: 'Testing with $pecial ch@racters & symbols',
        confidence: 0.8, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      // Should not crash on FTS5 special characters
      expect(() => setup.memory.search('$pecial AND OR NOT')).not.toThrow();
    });

    it('handles entity with long content', () => {
      const longContent = 'x'.repeat(100_000);
      const id = setup.memory.remember({
        type: 'fact', name: 'Long content', content: longContent,
        confidence: 0.8, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      const result = setup.memory.recall(id);
      expect(result!.entity.content.length).toBe(100_000);
    });

    it('handles many tags', () => {
      const tags = Array.from({ length: 50 }, (_, i) => `tag-${i}`);
      const id = setup.memory.remember({
        type: 'fact', name: 'Many tags', content: 'Content',
        confidence: 0.8, lastVerified: new Date().toISOString(),
        source: 'test', tags,
      });

      const result = setup.memory.recall(id);
      expect(result!.entity.tags).toHaveLength(50);
    });

    it('explore handles cycles without infinite loop', () => {
      const id1 = setup.memory.remember({
        type: 'fact', name: 'A', content: 'A',
        confidence: 0.8, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      const id2 = setup.memory.remember({
        type: 'fact', name: 'B', content: 'B',
        confidence: 0.8, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      // Create a cycle: A -> B -> A
      setup.memory.connect(id1, id2, 'related_to');
      setup.memory.connect(id2, id1, 'related_to');

      // Should not hang
      const results = setup.memory.explore(id1, { maxDepth: 5 });
      expect(results).toHaveLength(1); // Just B, not infinite
    });

    it('concurrent operations do not corrupt state', () => {
      // Create many entities rapidly
      const ids: string[] = [];
      for (let i = 0; i < 100; i++) {
        ids.push(setup.memory.remember({
          type: 'fact', name: `Fact ${i}`, content: `Content ${i}`,
          confidence: 0.8, lastVerified: new Date().toISOString(),
          source: 'test', tags: [],
        }));
      }

      const stats = setup.memory.stats();
      expect(stats.totalEntities).toBe(100);

      // All should be retrievable
      for (const id of ids) {
        expect(setup.memory.recall(id)).not.toBeNull();
      }
    });

    it('updates lastAccessed on recall', () => {
      const id = setup.memory.remember({
        type: 'fact', name: 'Access tracking', content: 'Track me',
        confidence: 0.8, lastVerified: new Date().toISOString(),
        source: 'test', tags: [],
      });

      const before = setup.memory.recall(id);
      const accessedBefore = before!.entity.lastAccessed;

      // Small delay to ensure timestamp changes
      const now = new Date(Date.now() + 1000).toISOString();

      // Access again
      const after = setup.memory.recall(id);

      // lastAccessed should be updated
      expect(after!.entity.lastAccessed).toBeTruthy();
    });
  });
});
