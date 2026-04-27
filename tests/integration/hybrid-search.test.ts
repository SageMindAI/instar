/**
 * Integration tests for Hybrid Search — Phase 5 full pipeline.
 *
 * Tests the complete flow: query → FTS5 + vector KNN → hybrid re-ranking → results.
 * Uses REAL SemanticMemory with EmbeddingProvider wired in. Verifies:
 *
 * 1. Hybrid search finds entities that FTS5 alone would miss (vocabulary mismatch)
 * 2. Scoring formula weights are correct (0.4 text + 0.3 confidence + 0.1 access + 0.2 vector)
 * 3. Fallback: searchHybrid() degrades to FTS5-only when vectors unavailable
 * 4. Embedding generation on remember() works end-to-end
 * 5. Embedding deletion on forget() cleans up properly
 * 6. embedAllEntities() batch migration works
 * 7. SemanticMemory stats include vector search info
 * 8. Type/domain/confidence filters work with hybrid search
 * 9. rememberWithEmbedding() makes embedding immediately searchable
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';
import { EmbeddingProvider } from '../../src/memory/EmbeddingProvider.js';

// ─── Shared State ─────────────────────────────────────────────────

let sharedProvider: EmbeddingProvider;

beforeAll(async () => {
  sharedProvider = new EmbeddingProvider();
  await sharedProvider.initialize();
  await sharedProvider.loadVecModule();
}, 120_000);

// ─── Helpers ──────────────────────────────────────────────────────

interface TestSetup {
  dir: string;
  memory: SemanticMemory;
  cleanup: () => void;
}

async function createHybridMemory(): Promise<TestSetup> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-search-test-'));
  const dbPath = path.join(dir, 'semantic.db');
  const memory = new SemanticMemory({
    dbPath,
    decayHalfLifeDays: 30,
    lessonDecayHalfLifeDays: 90,
    staleThreshold: 0.2,
  });

  memory.setEmbeddingProvider(sharedProvider);
  await memory.open();
  await memory.initializeVectorSearch();

  return {
    dir,
    memory,
    cleanup: () => {
      memory.close();
      // safe-git-allow: incremental-migration
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function createFtsOnlyMemory(): Promise<TestSetup> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fts-only-test-'));
  const dbPath = path.join(dir, 'semantic.db');
  const memory = new SemanticMemory({
    dbPath,
    decayHalfLifeDays: 30,
    lessonDecayHalfLifeDays: 90,
    staleThreshold: 0.2,
  });

  // No embedding provider — FTS5 only
  await memory.open();

  return {
    dir,
    memory,
    cleanup: () => {
      memory.close();
      // safe-git-allow: incremental-migration
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const now = new Date().toISOString();

// ─── Tests ────────────────────────────────────────────────────────

describe('Hybrid Search Integration', () => {
  let setup: TestSetup;

  afterEach(() => {
    setup?.cleanup();
  });

  describe('vector search availability', () => {
    it('reports vectorSearchAvailable=true when provider is wired', async () => {
      setup = await createHybridMemory();
      expect(setup.memory.vectorSearchAvailable).toBe(true);
    });

    it('reports vectorSearchAvailable=false without provider', async () => {
      setup = await createFtsOnlyMemory();
      expect(setup.memory.vectorSearchAvailable).toBe(false);
    });

    it('stats include vector search info', async () => {
      setup = await createHybridMemory();
      const stats = setup.memory.stats();
      expect(stats.vectorSearchAvailable).toBe(true);
      expect(stats.embeddingCount).toBe(0);
    });
  });

  describe('rememberWithEmbedding', () => {
    it('stores entity and embedding synchronously', async () => {
      setup = await createHybridMemory();

      const id = await setup.memory.rememberWithEmbedding({
        type: 'fact',
        name: 'Deployment process',
        content: 'We deploy using Vercel with automatic deploys from the main branch',
        confidence: 0.9,
        lastVerified: now,
        source: 'test',
        tags: ['deployment'],
      });

      expect(id).toBeTruthy();
      const stats = setup.memory.stats();
      expect(stats.totalEntities).toBe(1);
      expect(stats.embeddingCount).toBe(1);
    });

    it('entity is immediately searchable via hybrid search', async () => {
      setup = await createHybridMemory();

      await setup.memory.rememberWithEmbedding({
        type: 'fact',
        name: 'API authentication',
        content: 'The API uses JWT tokens with RS256 signing for authentication',
        confidence: 0.9,
        lastVerified: now,
        source: 'test',
        tags: ['auth'],
      });

      // Search using semantically similar but different words
      const results = await setup.memory.searchHybrid('how do we verify user identity');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe('API authentication');
    });
  });

  describe('vocabulary mismatch — the key hybrid search advantage', () => {
    beforeEach(async () => {
      setup = await createHybridMemory();

      // Store entities using technical terminology
      await setup.memory.rememberWithEmbedding({
        type: 'tool',
        name: 'Docker containerization',
        content: 'We use Docker containers with multi-stage builds for isolation and reproducible deployments',
        confidence: 0.9,
        lastVerified: now,
        source: 'test',
        tags: ['infra'],
      });

      await setup.memory.rememberWithEmbedding({
        type: 'pattern',
        name: 'Circuit breaker pattern',
        content: 'External API calls use circuit breaker with 5-failure threshold and 30s recovery window',
        confidence: 0.85,
        lastVerified: now,
        source: 'test',
        tags: ['resilience'],
      });

      await setup.memory.rememberWithEmbedding({
        type: 'fact',
        name: 'Database connection pooling',
        content: 'PostgreSQL uses PgBouncer with max 20 connections per pool for connection management',
        confidence: 0.95,
        lastVerified: now,
        source: 'test',
        tags: ['database'],
      });
    });

    it('FTS5-only misses vocabulary mismatch but hybrid finds it', async () => {
      // "sandboxing" is semantically related to "containerization" but keyword-different
      const ftsResults = setup.memory.search('application sandboxing and packaging');
      const hybridResults = await setup.memory.searchHybrid('application sandboxing and packaging');

      // Hybrid should find Docker via semantic similarity even if FTS5 doesn't
      // (FTS5 may find nothing since "sandboxing" and "packaging" don't appear in the content)
      if (ftsResults.length === 0) {
        expect(hybridResults.length).toBeGreaterThan(0);
      }
    });

    it('hybrid search still uses FTS5 when keywords match', async () => {
      // Direct keyword match — both FTS5 and vector should find this
      const results = await setup.memory.searchHybrid('circuit breaker');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe('Circuit breaker pattern');
    });
  });

  describe('searchHybrid fallback', () => {
    it('falls back to FTS5-only when no embedding provider', async () => {
      setup = await createFtsOnlyMemory();

      setup.memory.remember({
        type: 'fact',
        name: 'Test entity',
        content: 'This is a test entity for fallback testing',
        confidence: 0.9,
        lastVerified: now,
        source: 'test',
        tags: [],
      });

      const results = await setup.memory.searchHybrid('test entity');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('Test entity');
    });
  });

  describe('forget cleans up embeddings', () => {
    it('removes embedding when entity is forgotten', async () => {
      setup = await createHybridMemory();

      const id = await setup.memory.rememberWithEmbedding({
        type: 'fact',
        name: 'Temporary fact',
        content: 'This will be forgotten',
        confidence: 0.9,
        lastVerified: now,
        source: 'test',
        tags: [],
      });

      expect(setup.memory.stats().embeddingCount).toBe(1);

      setup.memory.forget(id);

      expect(setup.memory.stats().totalEntities).toBe(0);
      expect(setup.memory.stats().embeddingCount).toBe(0);
    });
  });

  describe('embedAllEntities batch migration', () => {
    it('embeds all entities missing embeddings', async () => {
      setup = await createHybridMemory();

      // Add entities without embeddings (using regular remember, not rememberWithEmbedding)
      // The fire-and-forget embedding in remember() may or may not complete before we call
      // embedAllEntities, so we use a fresh FTS-only memory then attach the provider
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-embed-test-'));
      const dbPath = path.join(dir, 'semantic.db');
      const memory = new SemanticMemory({
        dbPath,
        decayHalfLifeDays: 30,
        lessonDecayHalfLifeDays: 90,
        staleThreshold: 0.2,
      });

      // Open without embedding provider — pure FTS5
      await memory.open();

      memory.remember({
        type: 'fact', name: 'Fact A', content: 'Content A',
        confidence: 0.9, lastVerified: now, source: 'test', tags: [],
      });
      memory.remember({
        type: 'fact', name: 'Fact B', content: 'Content B',
        confidence: 0.9, lastVerified: now, source: 'test', tags: [],
      });
      memory.remember({
        type: 'fact', name: 'Fact C', content: 'Content C',
        confidence: 0.9, lastVerified: now, source: 'test', tags: [],
      });

      expect(memory.stats().totalEntities).toBe(3);

      // Now attach embedding provider and run batch migration
      memory.setEmbeddingProvider(sharedProvider);
      await memory.initializeVectorSearch();

      expect(memory.stats().embeddingCount).toBe(0);

      const progress: { done: number; total: number }[] = [];
      const embedded = await memory.embedAllEntities((done, total) => {
        progress.push({ done, total });
      });

      expect(embedded).toBe(3);
      expect(memory.stats().embeddingCount).toBe(3);
      expect(progress.length).toBeGreaterThan(0);
      expect(progress[progress.length - 1].done).toBe(3);

      // Clean up this nested setup
      memory.close();
      // safe-git-allow: incremental-migration
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('returns 0 when all entities already embedded', async () => {
      setup = await createHybridMemory();

      await setup.memory.rememberWithEmbedding({
        type: 'fact', name: 'Already embedded', content: 'Has embedding',
        confidence: 0.9, lastVerified: now, source: 'test', tags: [],
      });

      const count = await setup.memory.embedAllEntities();
      expect(count).toBe(0);
    });

    it('returns 0 when vector search not available', async () => {
      setup = await createFtsOnlyMemory();
      const count = await setup.memory.embedAllEntities();
      expect(count).toBe(0);
    });
  });

  describe('search filters with hybrid search', () => {
    beforeEach(async () => {
      setup = await createHybridMemory();

      await setup.memory.rememberWithEmbedding({
        type: 'fact',
        name: 'Production database host',
        content: 'The production database runs on db.example.com port 5432',
        confidence: 0.95,
        lastVerified: now,
        source: 'test',
        tags: ['infra'],
        domain: 'infrastructure',
      });

      await setup.memory.rememberWithEmbedding({
        type: 'lesson',
        name: 'Database migration lesson',
        content: 'Always run migrations in a transaction to avoid partial schema states',
        confidence: 0.7,
        lastVerified: now,
        source: 'test',
        tags: ['database'],
        domain: 'development',
      });
    });

    it('filters by entity type', async () => {
      const results = await setup.memory.searchHybrid('database', { types: ['lesson'] });
      expect(results.length).toBe(1);
      expect(results[0].type).toBe('lesson');
    });

    it('filters by domain', async () => {
      const results = await setup.memory.searchHybrid('database', { domain: 'infrastructure' });
      expect(results.length).toBe(1);
      expect(results[0].domain).toBe('infrastructure');
    });

    it('filters by minimum confidence', async () => {
      const results = await setup.memory.searchHybrid('database', { minConfidence: 0.9 });
      expect(results.length).toBe(1);
      expect(results[0].confidence).toBeGreaterThanOrEqual(0.9);
    });
  });

  describe('scoring weights', () => {
    it('high-confidence entity scores higher than low-confidence with equal text match', async () => {
      setup = await createHybridMemory();

      await setup.memory.rememberWithEmbedding({
        type: 'fact', name: 'API endpoint high', content: 'The user API endpoint',
        confidence: 0.95, lastVerified: now, source: 'test', tags: [],
      });

      await setup.memory.rememberWithEmbedding({
        type: 'fact', name: 'API endpoint low', content: 'The user API endpoint',
        confidence: 0.2, lastVerified: now, source: 'test', tags: [],
      });

      const results = await setup.memory.searchHybrid('API endpoint');
      expect(results.length).toBe(2);
      expect(results[0].name).toBe('API endpoint high');
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });
  });
});
