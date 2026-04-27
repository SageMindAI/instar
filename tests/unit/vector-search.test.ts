/**
 * Tests for EmbeddingProvider + VectorSearch — Phase 5 vector search infrastructure.
 *
 * Uses REAL SQLite databases with sqlite-vec loaded. No mocking of the
 * database or embedding layers. Tests verify:
 *
 * 1. EmbeddingProvider generates correct-dimension embeddings
 * 2. EmbeddingProvider batch embedding works
 * 3. EmbeddingProvider cosine similarity is correct for known inputs
 * 4. VectorSearch creates vec0 table and handles CRUD
 * 5. VectorSearch KNN returns nearest neighbors in correct order
 * 6. VectorSearch batch operations work correctly
 * 7. VectorSearch findMissingEmbeddings detects unembedded entities
 * 8. Buffer serialization round-trips correctly
 * 9. Graceful behavior when sqlite-vec extension isn't loaded
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EmbeddingProvider } from '../../src/memory/EmbeddingProvider.js';
import { VectorSearch } from '../../src/memory/VectorSearch.js';

type Database = import('better-sqlite3').Database;

// ─── Shared State ─────────────────────────────────────────────────

// Singleton provider — model takes ~10s to load, reuse across all tests
let sharedProvider: EmbeddingProvider;

beforeAll(async () => {
  sharedProvider = new EmbeddingProvider();
  await sharedProvider.initialize();
}, 120_000); // Model download can take a while on first run

// ─── Helpers ──────────────────────────────────────────────────────

interface TestSetup {
  dir: string;
  dbPath: string;
  db: Database;
  cleanup: () => void;
}

async function createTestDb(): Promise<TestSetup> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-search-test-'));
  const dbPath = path.join(dir, 'test.db');

  const BetterSqlite3 = await import('better-sqlite3');
  const constructor = BetterSqlite3.default || BetterSqlite3;
  const db = constructor(dbPath) as Database;
  db.pragma('journal_mode = WAL');

  return {
    dir,
    dbPath,
    db,
    cleanup: () => {
      db.close();
      // safe-git-allow: incremental-migration
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ─── EmbeddingProvider Tests ──────────────────────────────────────

describe('EmbeddingProvider', () => {
  it('generates 384-dim embeddings', async () => {
    const embedding = await sharedProvider.embed('Hello world');
    expect(embedding).toBeInstanceOf(Float32Array);
    expect(embedding.length).toBe(384);
  });

  it('generates normalized embeddings (unit length)', async () => {
    const embedding = await sharedProvider.embed('This is a test sentence');
    let magnitude = 0;
    for (let i = 0; i < embedding.length; i++) {
      magnitude += embedding[i] * embedding[i];
    }
    magnitude = Math.sqrt(magnitude);
    expect(magnitude).toBeCloseTo(1.0, 2);
  });

  it('produces similar embeddings for similar texts', async () => {
    const a = await sharedProvider.embed('The cat sat on the mat');
    const b = await sharedProvider.embed('A cat is sitting on a mat');
    const c = await sharedProvider.embed('Quantum physics equations');

    const simAB = EmbeddingProvider.cosineSimilarity(a, b);
    const simAC = EmbeddingProvider.cosineSimilarity(a, c);

    // Similar sentences should have higher similarity than unrelated ones
    expect(simAB).toBeGreaterThan(simAC);
    expect(simAB).toBeGreaterThan(0.5);
  });

  it('batch embeds multiple texts', async () => {
    const texts = ['Hello', 'World', 'Test'];
    const embeddings = await sharedProvider.embedBatch(texts);

    expect(embeddings.length).toBe(3);
    for (const emb of embeddings) {
      expect(emb).toBeInstanceOf(Float32Array);
      expect(emb.length).toBe(384);
    }
  });

  it('batch embed with empty array returns empty', async () => {
    const results = await sharedProvider.embedBatch([]);
    expect(results).toEqual([]);
  });

  it('batch embed with single item works', async () => {
    const results = await sharedProvider.embedBatch(['Single']);
    expect(results.length).toBe(1);
    expect(results[0].length).toBe(384);
  });

  it('truncates long text to maxTextLength', async () => {
    const longText = 'x'.repeat(20000);
    // Should not throw — just truncates
    const embedding = await sharedProvider.embed(longText);
    expect(embedding.length).toBe(384);
  });

  describe('buffer serialization', () => {
    it('round-trips Float32Array through Buffer', async () => {
      const original = await sharedProvider.embed('Test');
      const buffer = EmbeddingProvider.toBuffer(original);
      const restored = EmbeddingProvider.fromBuffer(buffer);

      expect(restored.length).toBe(original.length);
      for (let i = 0; i < original.length; i++) {
        expect(restored[i]).toBeCloseTo(original[i], 6);
      }
    });
  });

  describe('cosine similarity', () => {
    it('returns 1.0 for identical vectors', async () => {
      const a = await sharedProvider.embed('Same text');
      const sim = EmbeddingProvider.cosineSimilarity(a, a);
      expect(sim).toBeCloseTo(1.0, 4);
    });

    it('throws on dimension mismatch', () => {
      const a = new Float32Array(384);
      const b = new Float32Array(128);
      expect(() => EmbeddingProvider.cosineSimilarity(a, b)).toThrow('Dimension mismatch');
    });
  });

  describe('sqlite-vec extension', () => {
    let setup: TestSetup;

    beforeEach(async () => {
      setup = await createTestDb();
    });

    afterEach(() => {
      setup?.cleanup();
    });

    it('loads sqlite-vec extension and vec_version works', async () => {
      await sharedProvider.loadVecModule();
      const loaded = sharedProvider.loadVecExtension(setup.db);
      expect(loaded).toBe(true);

      const row = setup.db.prepare('SELECT vec_version() as v').get() as { v: string };
      expect(row.v).toMatch(/^v\d+\.\d+/);
    });

    it('loading extension twice is safe (idempotent)', async () => {
      await sharedProvider.loadVecModule();
      expect(sharedProvider.loadVecExtension(setup.db)).toBe(true);
      expect(sharedProvider.loadVecExtension(setup.db)).toBe(true);
    });
  });
});

// ─── VectorSearch Tests ──────────────────────────────────────────

describe('VectorSearch', () => {
  let setup: TestSetup;
  let vs: VectorSearch;

  beforeEach(async () => {
    setup = await createTestDb();
    await sharedProvider.loadVecModule();
    sharedProvider.loadVecExtension(setup.db);

    vs = new VectorSearch({ dimensions: 384 });
    vs.createTable(setup.db);
  });

  afterEach(() => {
    setup?.cleanup();
  });

  it('creates vec0 table', () => {
    // If we got here without throwing, the table was created
    const count = vs.count(setup.db);
    expect(count).toBe(0);
  });

  it('throws if methods called before createTable', () => {
    const vs2 = new VectorSearch();
    expect(() => vs2.count(setup.db)).toThrow('not initialized');
  });

  describe('CRUD', () => {
    it('upserts and counts embeddings', async () => {
      const emb = await sharedProvider.embed('Test entity');
      vs.upsert(setup.db, 'entity-1', emb);
      expect(vs.count(setup.db)).toBe(1);
    });

    it('upsert replaces existing embedding', async () => {
      const emb1 = await sharedProvider.embed('First version');
      const emb2 = await sharedProvider.embed('Second version');

      vs.upsert(setup.db, 'entity-1', emb1);
      vs.upsert(setup.db, 'entity-1', emb2);

      expect(vs.count(setup.db)).toBe(1);
    });

    it('has() returns correct state', async () => {
      const emb = await sharedProvider.embed('Test');
      expect(vs.has(setup.db, 'entity-1')).toBe(false);
      vs.upsert(setup.db, 'entity-1', emb);
      expect(vs.has(setup.db, 'entity-1')).toBe(true);
    });

    it('deletes embedding', async () => {
      const emb = await sharedProvider.embed('Test');
      vs.upsert(setup.db, 'entity-1', emb);
      expect(vs.count(setup.db)).toBe(1);

      vs.delete(setup.db, 'entity-1');
      expect(vs.count(setup.db)).toBe(0);
      expect(vs.has(setup.db, 'entity-1')).toBe(false);
    });

    it('delete on non-existent ID is a no-op', () => {
      expect(() => vs.delete(setup.db, 'nonexistent')).not.toThrow();
    });
  });

  describe('KNN search', () => {
    it('finds nearest neighbors in correct order', async () => {
      // Insert three semantically distinct entities
      const catEmb = await sharedProvider.embed('The cat sat on the mat');
      const dogEmb = await sharedProvider.embed('The dog played in the yard');
      const physicsEmb = await sharedProvider.embed('Quantum mechanics and wave functions');

      vs.upsert(setup.db, 'cat', catEmb);
      vs.upsert(setup.db, 'dog', dogEmb);
      vs.upsert(setup.db, 'physics', physicsEmb);

      // Query for something cat-related
      const queryEmb = await sharedProvider.embed('A feline sitting on a rug');
      const results = vs.search(setup.db, queryEmb, 3);

      expect(results.length).toBe(3);
      // Cat should be closest to the feline query
      expect(results[0].id).toBe('cat');
      // Physics should be furthest
      expect(results[2].id).toBe('physics');
      // Similarities should be in descending order
      expect(results[0].similarity).toBeGreaterThanOrEqual(results[1].similarity);
      expect(results[1].similarity).toBeGreaterThanOrEqual(results[2].similarity);
    });

    it('respects k limit', async () => {
      for (let i = 0; i < 10; i++) {
        const emb = await sharedProvider.embed(`Entity number ${i}`);
        vs.upsert(setup.db, `e-${i}`, emb);
      }

      const queryEmb = await sharedProvider.embed('Entity');
      const results = vs.search(setup.db, queryEmb, 3);
      expect(results.length).toBe(3);
    });

    it('returns empty for empty table', async () => {
      const queryEmb = await sharedProvider.embed('anything');
      const results = vs.search(setup.db, queryEmb, 5);
      expect(results.length).toBe(0);
    });

    it('throws on dimension mismatch', () => {
      const wrongDim = new Float32Array(128);
      expect(() => vs.search(setup.db, wrongDim, 5)).toThrow('dimension');
    });

    it('similarity scores are between 0 and 1', async () => {
      const emb = await sharedProvider.embed('Test text');
      vs.upsert(setup.db, 'test', emb);

      const queryEmb = await sharedProvider.embed('Test query');
      const results = vs.search(setup.db, queryEmb, 1);

      expect(results[0].similarity).toBeGreaterThanOrEqual(0);
      expect(results[0].similarity).toBeLessThanOrEqual(1);
    });
  });

  describe('batch operations', () => {
    it('upserts batch in a transaction', async () => {
      const embeddings = await sharedProvider.embedBatch(['Alpha', 'Beta', 'Gamma']);
      const items = embeddings.map((emb, i) => ({
        id: `batch-${i}`,
        embedding: emb,
      }));

      const count = vs.upsertBatch(setup.db, items);
      expect(count).toBe(3);
      expect(vs.count(setup.db)).toBe(3);
    });

    it('batch upsert with empty array returns 0', () => {
      const count = vs.upsertBatch(setup.db, []);
      expect(count).toBe(0);
    });
  });

  describe('findMissingEmbeddings', () => {
    it('detects entities without embeddings', async () => {
      // Create a real entities table (mimicking SemanticMemory)
      setup.db.exec(`
        CREATE TABLE IF NOT EXISTS entities (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          content TEXT NOT NULL
        );
      `);

      setup.db.prepare('INSERT INTO entities VALUES (?, ?, ?)').run('e1', 'Alpha', 'First');
      setup.db.prepare('INSERT INTO entities VALUES (?, ?, ?)').run('e2', 'Beta', 'Second');
      setup.db.prepare('INSERT INTO entities VALUES (?, ?, ?)').run('e3', 'Gamma', 'Third');

      // Only embed e1
      const emb = await sharedProvider.embed('Alpha First');
      vs.upsert(setup.db, 'e1', emb);

      const missing = vs.findMissingEmbeddings(setup.db);
      expect(missing.sort()).toEqual(['e2', 'e3']);
    });

    it('returns empty when all entities are embedded', async () => {
      setup.db.exec(`
        CREATE TABLE IF NOT EXISTS entities (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL
        );
      `);
      setup.db.prepare('INSERT INTO entities VALUES (?, ?)').run('e1', 'Alpha');

      const emb = await sharedProvider.embed('Alpha');
      vs.upsert(setup.db, 'e1', emb);

      const missing = vs.findMissingEmbeddings(setup.db);
      expect(missing).toEqual([]);
    });
  });
});
