/**
 * Tests for SemanticMemory Privacy Scoping (Phase 2C).
 *
 * Verifies the critical invariant:
 *   "User B cannot retrieve knowledge entities owned by User A with scope 'private'."
 *
 * Covers:
 *   1. remember() stores ownerId and privacyScope
 *   2. search() filters results by userId + privacy scope
 *   3. getRelevantContext() respects privacy boundaries
 *   4. getEntitiesByUser() returns only that user's entities (GDPR /mydata)
 *   5. deleteEntitiesByUser() removes only that user's entities (GDPR /forget)
 *   6. Migration from legacy schema adds new columns
 *   7. Legacy entities (no owner) are visible to all users
 *   8. Cross-user isolation with multiple users and mixed scopes
 *   9. recall() returns ownerId/privacyScope on entities
 *  10. import/export preserves privacy fields
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';
import type { MemoryEntity } from '../../src/core/types.js';

// ── Helpers ─────────────────────────────────────────────────────

interface TestSetup {
  dir: string;
  dbPath: string;
  memory: SemanticMemory;
  cleanup: () => void;
}

async function createTestMemory(): Promise<TestSetup> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-privacy-test-'));
  const dbPath = path.join(dir, 'semantic.db');
  const memory = new SemanticMemory({
    dbPath,
    decayHalfLifeDays: 30,
    lessonDecayHalfLifeDays: 90,
    staleThreshold: 0.2,
  });
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

const ALICE = { id: 'alice', name: 'Alice' };
const BOB = { id: 'bob', name: 'Bob' };
const CHARLIE = { id: 'charlie', name: 'Charlie' };

function rememberPrivate(memory: SemanticMemory, userId: string, name: string, content: string): string {
  return memory.remember({
    type: 'fact',
    name,
    content,
    confidence: 0.9,
    lastVerified: new Date().toISOString(),
    source: `user:${userId}`,
    tags: ['test'],
    ownerId: userId,
    privacyScope: 'private',
  });
}

function rememberShared(memory: SemanticMemory, name: string, content: string, ownerId?: string): string {
  return memory.remember({
    type: 'fact',
    name,
    content,
    confidence: 0.9,
    lastVerified: new Date().toISOString(),
    source: 'agent:discovery',
    tags: ['test'],
    ownerId,
    privacyScope: 'shared-project',
  });
}

// ── Tests ────────────────────────────────────────────────────────

describe('SemanticMemory Privacy Scoping', () => {
  let setup: TestSetup;

  beforeEach(async () => {
    setup = await createTestMemory();
  });

  afterEach(() => {
    setup?.cleanup();
  });

  // ── remember() stores privacy fields ──────────────────────────

  describe('remember() privacy fields', () => {
    it('stores ownerId and privacyScope on entities', () => {
      const id = rememberPrivate(setup.memory, ALICE.id, 'Secret', 'Alice secret info');
      const result = setup.memory.recall(id);

      expect(result).not.toBeNull();
      expect(result!.entity.ownerId).toBe(ALICE.id);
      expect(result!.entity.privacyScope).toBe('private');
    });

    it('defaults privacyScope to shared-project when not specified', () => {
      const id = setup.memory.remember({
        type: 'fact',
        name: 'Shared Knowledge',
        content: 'Everyone can see this',
        confidence: 0.9,
        lastVerified: new Date().toISOString(),
        source: 'agent:discovery',
        tags: ['test'],
      });
      const result = setup.memory.recall(id);

      expect(result).not.toBeNull();
      expect(result!.entity.privacyScope).toBe('shared-project');
      expect(result!.entity.ownerId).toBeUndefined();
    });

    it('stores shared-project scope with explicit ownerId', () => {
      const id = rememberShared(setup.memory, 'Shared Fact', 'Visible to everyone', ALICE.id);
      const result = setup.memory.recall(id);

      expect(result!.entity.ownerId).toBe(ALICE.id);
      expect(result!.entity.privacyScope).toBe('shared-project');
    });
  });

  // ── search() privacy filtering ─────────────────────────────────

  describe('search() privacy filtering', () => {
    beforeEach(() => {
      // Alice's private knowledge
      rememberPrivate(setup.memory, ALICE.id, 'Alice Password', 'Alice password is hunter2');
      // Bob's private knowledge
      rememberPrivate(setup.memory, BOB.id, 'Bob Password', 'Bob password is correct horse');
      // Shared knowledge
      rememberShared(setup.memory, 'API Endpoint', 'The API endpoint is /api/v2');
    });

    it('CRITICAL: Alice cannot see Bob\'s private entities via search', () => {
      const results = setup.memory.search('password', { userId: ALICE.id });
      const names = results.map(r => r.name);

      expect(names).toContain('Alice Password');
      expect(names).not.toContain('Bob Password');
    });

    it('CRITICAL: Bob cannot see Alice\'s private entities via search', () => {
      const results = setup.memory.search('password', { userId: BOB.id });
      const names = results.map(r => r.name);

      expect(names).toContain('Bob Password');
      expect(names).not.toContain('Alice Password');
    });

    it('both users can see shared-project entities', () => {
      const aliceResults = setup.memory.search('API endpoint', { userId: ALICE.id });
      const bobResults = setup.memory.search('API endpoint', { userId: BOB.id });

      expect(aliceResults.some(r => r.name === 'API Endpoint')).toBe(true);
      expect(bobResults.some(r => r.name === 'API Endpoint')).toBe(true);
    });

    it('search without userId returns ALL entities (no privacy filter)', () => {
      const results = setup.memory.search('password');
      const names = results.map(r => r.name);

      expect(names).toContain('Alice Password');
      expect(names).toContain('Bob Password');
    });

    it('CRITICAL: third user sees only shared entities, not any private ones', () => {
      const results = setup.memory.search('password', { userId: CHARLIE.id });

      // Charlie has no private entities, so should see 0 password results
      expect(results.length).toBe(0);
    });

    it('privacy filter works with other search filters', () => {
      // Add a domain-tagged private entity
      setup.memory.remember({
        type: 'lesson',
        name: 'Alice Lesson',
        content: 'Alice learned something about passwords',
        confidence: 0.9,
        lastVerified: new Date().toISOString(),
        source: `user:${ALICE.id}`,
        tags: ['security'],
        domain: 'security',
        ownerId: ALICE.id,
        privacyScope: 'private',
      });

      const results = setup.memory.search('password', {
        userId: ALICE.id,
        types: ['lesson'],
        domain: 'security',
      });

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Alice Lesson');
    });
  });

  // ── getRelevantContext() privacy filtering ──────────────────────

  describe('getRelevantContext() privacy filtering', () => {
    beforeEach(() => {
      rememberPrivate(setup.memory, ALICE.id, 'Alice Secret', 'Alice sensitive data about deployment');
      rememberPrivate(setup.memory, BOB.id, 'Bob Secret', 'Bob sensitive data about deployment');
      rememberShared(setup.memory, 'Deployment Info', 'Deployment scheduled for 3pm');
    });

    it('Alice\'s context includes her private data + shared data', () => {
      const context = setup.memory.getRelevantContext('deployment', { userId: ALICE.id });

      expect(context).toContain('Alice sensitive data');
      expect(context).toContain('Deployment scheduled');
      expect(context).not.toContain('Bob sensitive data');
    });

    it('Bob\'s context includes his private data + shared data', () => {
      const context = setup.memory.getRelevantContext('deployment', { userId: BOB.id });

      expect(context).toContain('Bob sensitive data');
      expect(context).toContain('Deployment scheduled');
      expect(context).not.toContain('Alice sensitive data');
    });

    it('context without userId includes everything', () => {
      const context = setup.memory.getRelevantContext('deployment');

      expect(context).toContain('Alice sensitive data');
      expect(context).toContain('Bob sensitive data');
      expect(context).toContain('Deployment scheduled');
    });
  });

  // ── GDPR: getEntitiesByUser() ──────────────────────────────────

  describe('getEntitiesByUser() (GDPR /mydata)', () => {
    beforeEach(() => {
      // Alice: 2 private + 1 shared
      rememberPrivate(setup.memory, ALICE.id, 'Alice Fact 1', 'Alice private fact');
      rememberPrivate(setup.memory, ALICE.id, 'Alice Fact 2', 'Alice other private fact');
      rememberShared(setup.memory, 'Alice Shared', 'Alice shared fact', ALICE.id);

      // Bob: 1 private
      rememberPrivate(setup.memory, BOB.id, 'Bob Fact', 'Bob private fact');

      // Agent-owned (no owner)
      rememberShared(setup.memory, 'Agent Fact', 'Agent knowledge');
    });

    it('returns all entities owned by a specific user', () => {
      const aliceEntities = setup.memory.getEntitiesByUser(ALICE.id);
      expect(aliceEntities).toHaveLength(3); // 2 private + 1 shared
      expect(aliceEntities.every(e => e.ownerId === ALICE.id)).toBe(true);
    });

    it('does not include entities owned by other users', () => {
      const aliceEntities = setup.memory.getEntitiesByUser(ALICE.id);
      expect(aliceEntities.some(e => e.content.includes('Bob'))).toBe(false);
    });

    it('does not include agent-owned entities', () => {
      const aliceEntities = setup.memory.getEntitiesByUser(ALICE.id);
      expect(aliceEntities.some(e => e.name === 'Agent Fact')).toBe(false);
    });

    it('returns empty for non-existent user', () => {
      expect(setup.memory.getEntitiesByUser('nonexistent')).toHaveLength(0);
    });
  });

  // ── GDPR: deleteEntitiesByUser() ───────────────────────────────

  describe('deleteEntitiesByUser() (GDPR /forget)', () => {
    let aliceId1: string;
    let aliceId2: string;
    let bobId: string;

    beforeEach(() => {
      aliceId1 = rememberPrivate(setup.memory, ALICE.id, 'Alice Fact 1', 'Alice data');
      aliceId2 = rememberShared(setup.memory, 'Alice Shared', 'Alice shared', ALICE.id);
      bobId = rememberPrivate(setup.memory, BOB.id, 'Bob Fact', 'Bob data');

      // Create edges between entities
      setup.memory.connect(aliceId1, aliceId2, 'related-to', 'Alice internal edge');
      setup.memory.connect(aliceId1, bobId, 'related-to', 'Cross-user edge');
    });

    it('deletes all entities owned by a user', () => {
      const deleted = setup.memory.deleteEntitiesByUser(ALICE.id);
      expect(deleted).toBe(2);

      // Alice's entities are gone
      expect(setup.memory.getEntitiesByUser(ALICE.id)).toHaveLength(0);
      expect(setup.memory.recall(aliceId1)).toBeNull();
      expect(setup.memory.recall(aliceId2)).toBeNull();
    });

    it('does not affect other users\' entities', () => {
      setup.memory.deleteEntitiesByUser(ALICE.id);

      // Bob's entity is untouched
      const bobResult = setup.memory.recall(bobId);
      expect(bobResult).not.toBeNull();
      expect(bobResult!.entity.content).toBe('Bob data');
    });

    it('cleans up edges connected to deleted entities', () => {
      setup.memory.deleteEntitiesByUser(ALICE.id);

      // Bob's entity should no longer have the edge to Alice
      const bobResult = setup.memory.recall(bobId);
      expect(bobResult!.connections).toHaveLength(0);
    });

    it('returns 0 for non-existent user', () => {
      expect(setup.memory.deleteEntitiesByUser('nonexistent')).toBe(0);
    });
  });

  // ── Legacy backward compatibility ──────────────────────────────

  describe('backward compatibility', () => {
    it('entities without ownerId are visible to all users in search', () => {
      // Legacy entity — no ownerId, default privacy_scope
      setup.memory.remember({
        type: 'fact',
        name: 'Legacy Knowledge',
        content: 'Old data from before privacy scoping',
        confidence: 0.9,
        lastVerified: new Date().toISOString(),
        source: 'migration',
        tags: ['legacy'],
      });

      // Both users can see it
      const aliceResults = setup.memory.search('Legacy Knowledge', { userId: ALICE.id });
      const bobResults = setup.memory.search('Legacy Knowledge', { userId: BOB.id });

      expect(aliceResults.length).toBeGreaterThan(0);
      expect(bobResults.length).toBeGreaterThan(0);
    });

    it('mixed legacy + privacy-scoped search works correctly', () => {
      // Legacy entity
      setup.memory.remember({
        type: 'fact',
        name: 'Public API Docs',
        content: 'API documentation for version 1',
        confidence: 0.9,
        lastVerified: new Date().toISOString(),
        source: 'migration',
        tags: ['api'],
      });

      // Private entity
      rememberPrivate(setup.memory, ALICE.id, 'Alice API Key', 'Alice API key is sk-abc123');

      const aliceResults = setup.memory.search('API', { userId: ALICE.id });
      expect(aliceResults.map(r => r.name)).toContain('Public API Docs');
      expect(aliceResults.map(r => r.name)).toContain('Alice API Key');

      const bobResults = setup.memory.search('API', { userId: BOB.id });
      expect(bobResults.map(r => r.name)).toContain('Public API Docs');
      expect(bobResults.map(r => r.name)).not.toContain('Alice API Key');
    });
  });

  // ── Migration ──────────────────────────────────────────────────

  describe('migration from legacy schema', () => {
    it('adds owner_id and privacy_scope columns to existing databases', async () => {
      // Create a DB without the new columns (simulate pre-Phase 2C schema)
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-migration-test-'));
      const dbPath = path.join(dir, 'semantic.db');

      // Build a raw DB without the new columns
      const BetterSqlite3 = await import('better-sqlite3');
      const constructor = BetterSqlite3.default || BetterSqlite3;
      const rawDb = constructor(dbPath) as any;
      rawDb.pragma('journal_mode = WAL');
      rawDb.exec(`
        CREATE TABLE IF NOT EXISTS entities (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          name TEXT NOT NULL,
          content TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 1.0,
          created_at TEXT NOT NULL,
          last_verified TEXT NOT NULL,
          last_accessed TEXT NOT NULL,
          expires_at TEXT,
          source TEXT NOT NULL,
          source_session TEXT,
          tags TEXT NOT NULL DEFAULT '[]',
          domain TEXT
        );
        CREATE TABLE IF NOT EXISTS edges (
          id TEXT PRIMARY KEY,
          from_id TEXT NOT NULL,
          to_id TEXT NOT NULL,
          relation TEXT NOT NULL,
          weight REAL NOT NULL DEFAULT 1.0,
          context TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(from_id, to_id, relation)
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
          name, content, tags,
          content='entities', content_rowid='rowid',
          tokenize='porter unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS entities_fts_ai AFTER INSERT ON entities BEGIN
          INSERT INTO entities_fts(rowid, name, content, tags) VALUES (new.rowid, new.name, new.content, new.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS entities_fts_ad AFTER DELETE ON entities BEGIN
          INSERT INTO entities_fts(entities_fts, rowid, name, content, tags) VALUES ('delete', old.rowid, old.name, old.content, old.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS entities_fts_au AFTER UPDATE ON entities BEGIN
          INSERT INTO entities_fts(entities_fts, rowid, name, content, tags) VALUES ('delete', old.rowid, old.name, old.content, old.tags);
          INSERT INTO entities_fts(rowid, name, content, tags) VALUES (new.rowid, new.name, new.content, new.tags);
        END;
      `);

      // Insert a legacy entity
      const now = new Date().toISOString();
      rawDb.prepare(`
        INSERT INTO entities (id, type, name, content, confidence, created_at, last_verified, last_accessed, source, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('legacy-1', 'fact', 'Legacy Fact', 'Old knowledge', 0.8, now, now, now, 'migration', '["legacy"]');
      rawDb.close();

      // Open with SemanticMemory — should migrate
      const memory = new SemanticMemory({
        dbPath,
        decayHalfLifeDays: 30,
        lessonDecayHalfLifeDays: 90,
        staleThreshold: 0.2,
      });
      await memory.open();

      // Legacy entity should have default privacy_scope
      const legacy = memory.recall('legacy-1');
      expect(legacy).not.toBeNull();
      expect(legacy!.entity.privacyScope).toBe('shared-project');
      expect(legacy!.entity.ownerId).toBeUndefined();

      // New entity with privacy works
      const newId = rememberPrivate(memory, ALICE.id, 'Alice Secret', 'Post-migration private data');
      const newEntity = memory.recall(newId);
      expect(newEntity!.entity.ownerId).toBe(ALICE.id);
      expect(newEntity!.entity.privacyScope).toBe('private');

      memory.close();
      // safe-git-allow: incremental-migration
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  // ── Import/Export preserves privacy fields ─────────────────────

  describe('import/export preserves privacy fields', () => {
    it('export includes ownerId and privacyScope', () => {
      rememberPrivate(setup.memory, ALICE.id, 'Alice Fact', 'Alice data');
      rememberShared(setup.memory, 'Shared Fact', 'Shared data');

      const exported = setup.memory.export();

      const aliceEntity = exported.entities.find(e => e.name === 'Alice Fact');
      expect(aliceEntity?.ownerId).toBe(ALICE.id);
      expect(aliceEntity?.privacyScope).toBe('private');

      const sharedEntity = exported.entities.find(e => e.name === 'Shared Fact');
      expect(sharedEntity?.privacyScope).toBe('shared-project');
    });

    it('import preserves privacy fields', async () => {
      rememberPrivate(setup.memory, ALICE.id, 'Alice Original', 'Alice data');

      const exported = setup.memory.export();

      // Import into a fresh database
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-import-test-'));
      const dbPath2 = path.join(dir2, 'semantic.db');
      const memory2 = new SemanticMemory({
        dbPath: dbPath2,
        decayHalfLifeDays: 30,
        lessonDecayHalfLifeDays: 90,
        staleThreshold: 0.2,
      });
      await memory2.open();

      const report = memory2.import(exported);
      expect(report.entitiesImported).toBe(1);

      const entities = memory2.getEntitiesByUser(ALICE.id);
      expect(entities).toHaveLength(1);
      expect(entities[0].name).toBe('Alice Original');
      expect(entities[0].privacyScope).toBe('private');

      memory2.close();
      // safe-git-allow: incremental-migration
      fs.rmSync(dir2, { recursive: true, force: true });
    });
  });

  // ── Multi-user isolation stress test ───────────────────────────

  describe('multi-user isolation', () => {
    it('CRITICAL: 5 users with mixed scopes — each sees only their private + all shared', () => {
      const users = ['alice', 'bob', 'charlie', 'dave', 'eve'];

      for (const user of users) {
        // Each user: 2 private + 1 shared
        rememberPrivate(setup.memory, user, `${user} Private 1`, `${user} private knowledge one`);
        rememberPrivate(setup.memory, user, `${user} Private 2`, `${user} private knowledge two`);
        rememberShared(setup.memory, `${user} Shared`, `${user} shared knowledge`, user);
      }

      // Total: 15 entities
      const allStats = setup.memory.stats();
      expect(allStats.totalEntities).toBe(15);

      for (const user of users) {
        // User's entities (for GDPR)
        const userEntities = setup.memory.getEntitiesByUser(user);
        expect(userEntities).toHaveLength(3); // 2 private + 1 shared (all owned by user)

        // Search for "knowledge" — should see: 2 own private + 5 shared
        const results = setup.memory.search('knowledge', { userId: user });
        expect(results).toHaveLength(7);

        // Verify private results are only the user's own
        const privateResults = results.filter(r => r.privacyScope === 'private');
        expect(privateResults).toHaveLength(2);
        expect(privateResults.every(r => r.ownerId === user)).toBe(true);

        // Verify shared results include all 5 shared
        const sharedResults = results.filter(r => r.privacyScope === 'shared-project');
        expect(sharedResults).toHaveLength(5);
      }
    });

    it('CRITICAL: deleting one user does not affect others\' search results', () => {
      rememberPrivate(setup.memory, ALICE.id, 'Alice Data', 'Alice secret knowledge');
      rememberPrivate(setup.memory, BOB.id, 'Bob Data', 'Bob secret knowledge');
      rememberShared(setup.memory, 'Shared Data', 'Shared knowledge');

      // Delete Alice
      const deleted = setup.memory.deleteEntitiesByUser(ALICE.id);
      expect(deleted).toBe(1);

      // Bob can still find his own data
      const bobResults = setup.memory.search('knowledge', { userId: BOB.id });
      expect(bobResults.map(r => r.name)).toContain('Bob Data');
      expect(bobResults.map(r => r.name)).toContain('Shared Data');

      // Alice's data is completely gone
      expect(setup.memory.search('Alice', { userId: ALICE.id })).toHaveLength(0);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────

  describe('edge cases', () => {
    it('empty string userId is treated as a valid userId', () => {
      const id = setup.memory.remember({
        type: 'fact',
        name: 'Empty Owner',
        content: 'Owned by empty string user',
        confidence: 0.9,
        lastVerified: new Date().toISOString(),
        source: 'test',
        tags: [],
        ownerId: '',
        privacyScope: 'private',
      });

      const result = setup.memory.recall(id);
      expect(result!.entity.ownerId).toBe('');

      // Only visible to the empty-string user
      const results = setup.memory.search('Empty Owner', { userId: '' });
      expect(results).toHaveLength(1);

      const otherResults = setup.memory.search('Empty Owner', { userId: ALICE.id });
      expect(otherResults).toHaveLength(0);
    });

    it('userId with special characters works', () => {
      const specialUserId = 'user-with-dashes_and.dots@example.com';
      rememberPrivate(setup.memory, specialUserId, 'Special User Data', 'Special chars data');

      const entities = setup.memory.getEntitiesByUser(specialUserId);
      expect(entities).toHaveLength(1);

      const results = setup.memory.search('Special', { userId: specialUserId });
      expect(results).toHaveLength(1);
    });

    it('recall() on private entity always returns it regardless of caller', () => {
      // recall() is an admin/system operation — it returns the entity by ID
      // Privacy filtering happens at search/context level, not recall
      const id = rememberPrivate(setup.memory, ALICE.id, 'Secret', 'Very secret');
      const result = setup.memory.recall(id);
      expect(result).not.toBeNull();
      expect(result!.entity.ownerId).toBe(ALICE.id);
    });

    it('findBySource returns entity with privacy fields', () => {
      setup.memory.remember({
        type: 'fact',
        name: 'Sourced Entity',
        content: 'Has a source key',
        confidence: 0.9,
        lastVerified: new Date().toISOString(),
        source: 'unique:source:key',
        tags: [],
        ownerId: ALICE.id,
        privacyScope: 'private',
      });

      const found = setup.memory.findBySource('unique:source:key');
      expect(found).not.toBeNull();
      expect(found!.ownerId).toBe(ALICE.id);
      expect(found!.privacyScope).toBe('private');
    });

    it('explore() returns entities with privacy fields', () => {
      const id1 = rememberPrivate(setup.memory, ALICE.id, 'Start Entity', 'Starting point');
      const id2 = rememberShared(setup.memory, 'Connected Entity', 'Reachable via edge');
      setup.memory.connect(id1, id2, 'related-to');

      const explored = setup.memory.explore(id1);
      expect(explored).toHaveLength(1);
      expect(explored[0].name).toBe('Connected Entity');
      expect(explored[0].privacyScope).toBe('shared-project');
    });
  });
});
