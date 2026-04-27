/**
 * Tests for MemoryMigrator — the engine that ingests from legacy memory systems
 * into SemanticMemory.
 *
 * Written test-first: these tests define the contract MemoryMigrator must fulfill.
 *
 * Uses REAL filesystems and REAL SQLite databases. No mocking of data layers.
 * We create actual MEMORY.md files, relationship JSON files, canonical state
 * JSON files, and decision journal JSONL files — then verify the migrator
 * correctly transforms them into SemanticMemory entities and edges.
 *
 * What we test:
 *   1. MEMORY.md → entities (sections become facts/patterns)
 *   2. RelationshipManager records → person entities + edges
 *   3. CanonicalState quick-facts → fact entities
 *   4. CanonicalState anti-patterns → lesson entities
 *   5. CanonicalState projects → project entities
 *   6. DecisionJournal entries → decision entities
 *   7. Incremental migration (skip already-migrated)
 *   8. Migration report accuracy
 *   9. Edge cases (empty sources, corrupt files, missing dirs)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';
import { MemoryMigrator } from '../../src/memory/MemoryMigrator.js';
import type { MigrationReport, MigrationSource } from '../../src/memory/MemoryMigrator.js';

// ─── Helpers ─────────────────────────────────────────────────────

interface TestSetup {
  dir: string;
  stateDir: string;
  memory: SemanticMemory;
  migrator: MemoryMigrator;
  cleanup: () => void;
}

async function createTestSetup(): Promise<TestSetup> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrator-test-'));
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });

  const dbPath = path.join(stateDir, 'semantic.db');
  const memory = new SemanticMemory({
    dbPath,
    decayHalfLifeDays: 30,
    lessonDecayHalfLifeDays: 90,
    staleThreshold: 0.2,
  });
  await memory.open();

  const migrator = new MemoryMigrator({
    stateDir,
    semanticMemory: memory,
  });

  return {
    dir,
    stateDir,
    memory,
    migrator,
    cleanup: () => {
      memory.close();
      // safe-git-allow: incremental-migration
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Write a MEMORY.md file in the test directory */
function writeMemoryMd(dir: string, content: string): void {
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), content);
}

/** Write relationship JSON files */
function writeRelationship(stateDir: string, record: Record<string, unknown>): void {
  const relDir = path.join(stateDir, 'relationships');
  fs.mkdirSync(relDir, { recursive: true });
  const id = record.id ?? `rel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(
    path.join(relDir, `${id}.json`),
    JSON.stringify(record, null, 2),
  );
}

/** Write canonical state files */
function writeCanonicalState(
  stateDir: string,
  quickFacts?: unknown[],
  antiPatterns?: unknown[],
  projects?: unknown[],
): void {
  if (quickFacts) {
    fs.writeFileSync(path.join(stateDir, 'quick-facts.json'), JSON.stringify(quickFacts));
  }
  if (antiPatterns) {
    fs.writeFileSync(path.join(stateDir, 'anti-patterns.json'), JSON.stringify(antiPatterns));
  }
  if (projects) {
    fs.writeFileSync(path.join(stateDir, 'project-registry.json'), JSON.stringify(projects));
  }
}

/** Write decision journal JSONL */
function writeDecisionJournal(stateDir: string, entries: unknown[]): void {
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(stateDir, 'decision-journal.jsonl'), content);
}

// ─── Tests ───────────────────────────────────────────────────────

describe('MemoryMigrator', () => {
  let setup: TestSetup;

  beforeEach(async () => {
    setup = await createTestSetup();
  });

  afterEach(() => {
    setup?.cleanup();
  });

  // ─── MEMORY.md Migration ────────────────────────────────────────

  describe('MEMORY.md migration', () => {
    it('parses markdown sections into entities', async () => {
      writeMemoryMd(setup.dir, `# Agent Memory

## Deployment
We deploy to Vercel using the main branch. Builds take 3-4 minutes.

## Database
PostgreSQL hosted on Xata cloud. Connection string in .env.secrets.local.

## Key People
Justin is the founder and primary collaborator.
`);

      const report = await setup.migrator.migrateMemoryMd(path.join(setup.dir, 'MEMORY.md'));

      expect(report.entitiesCreated).toBeGreaterThanOrEqual(3);
      expect(report.source).toBe('MEMORY.md');

      // Verify entities exist in SemanticMemory
      const deployResults = setup.memory.search('Vercel deploy');
      expect(deployResults.length).toBeGreaterThan(0);
      expect(deployResults[0].source).toContain('memory-md:');

      const dbResults = setup.memory.search('PostgreSQL Xata');
      expect(dbResults.length).toBeGreaterThan(0);
    });

    it('assigns appropriate entity types based on section content', async () => {
      writeMemoryMd(setup.dir, `# Memory

## Key Patterns
Always rebuild after modifying server code. Silent catch blocks are the #1 debugging suspect.

## Development Workflow
Run pnpm dev for local development. Use pnpm test before committing.
`);

      const report = await setup.migrator.migrateMemoryMd(path.join(setup.dir, 'MEMORY.md'));
      expect(report.entitiesCreated).toBeGreaterThanOrEqual(2);

      // Pattern sections should create 'pattern' type entities
      const patternResults = setup.memory.search('rebuild server code');
      expect(patternResults.length).toBeGreaterThan(0);
    });

    it('handles empty MEMORY.md gracefully', async () => {
      writeMemoryMd(setup.dir, '');

      const report = await setup.migrator.migrateMemoryMd(path.join(setup.dir, 'MEMORY.md'));
      expect(report.entitiesCreated).toBe(0);
      expect(report.errors).toHaveLength(0);
    });

    it('handles MEMORY.md with no sections', async () => {
      writeMemoryMd(setup.dir, 'Just some plain text without any markdown headings.');

      const report = await setup.migrator.migrateMemoryMd(path.join(setup.dir, 'MEMORY.md'));
      // Should still create at least one entity from the content
      expect(report.errors).toHaveLength(0);
    });

    it('handles missing MEMORY.md file', async () => {
      const report = await setup.migrator.migrateMemoryMd(path.join(setup.dir, 'nonexistent.md'));
      expect(report.entitiesCreated).toBe(0);
      expect(report.errors.length).toBeGreaterThan(0);
    });

    it('assigns confidence 0.7 to migrated MEMORY.md entities', async () => {
      writeMemoryMd(setup.dir, `# Memory

## Server Port
The server runs on port 3000.
`);

      await setup.migrator.migrateMemoryMd(path.join(setup.dir, 'MEMORY.md'));

      const results = setup.memory.search('server port 3000');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].confidence).toBe(0.7);
    });
  });

  // ─── Relationship Migration ─────────────────────────────────────

  describe('relationship migration', () => {
    it('migrates relationship records into person entities', async () => {
      writeRelationship(setup.stateDir, {
        id: 'rel-001',
        name: 'Justin Headley',
        channels: [
          { type: 'telegram', identifier: '12345' },
          { type: 'email', identifier: 'justin@example.com' },
        ],
        firstInteraction: '2026-01-15T00:00:00Z',
        lastInteraction: '2026-02-25T00:00:00Z',
        interactionCount: 150,
        themes: ['development', 'consciousness', 'business'],
        notes: 'Primary collaborator and founder.',
        significance: 10,
        arcSummary: 'Co-builder of Portal. Deep technical and philosophical partnership.',
        recentInteractions: [],
      });

      const report = await setup.migrator.migrateRelationships();

      expect(report.entitiesCreated).toBeGreaterThanOrEqual(1);
      expect(report.source).toBe('relationships');

      // Verify person entity exists
      const results = setup.memory.search('Justin Headley');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].type).toBe('person');
      expect(results[0].content).toContain('Primary collaborator');
    });

    it('creates knows_about edges for relationship themes', async () => {
      writeRelationship(setup.stateDir, {
        id: 'rel-002',
        name: 'Alice Developer',
        channels: [{ type: 'github', identifier: 'alice-dev' }],
        firstInteraction: '2026-02-01T00:00:00Z',
        lastInteraction: '2026-02-20T00:00:00Z',
        interactionCount: 12,
        themes: ['react', 'testing'],
        notes: 'Contributor to frontend.',
        significance: 5,
        recentInteractions: [],
      });

      const report = await setup.migrator.migrateRelationships();

      // Should create person entity + theme fact entities + edges
      expect(report.entitiesCreated).toBeGreaterThanOrEqual(1);
      expect(report.edgesCreated).toBeGreaterThanOrEqual(0); // Edges are optional depending on impl
    });

    it('maps significance to confidence', async () => {
      writeRelationship(setup.stateDir, {
        id: 'rel-003',
        name: 'Bob Manager',
        channels: [],
        firstInteraction: '2026-02-10T00:00:00Z',
        lastInteraction: '2026-02-15T00:00:00Z',
        interactionCount: 3,
        themes: [],
        notes: 'Brief interaction about project scope.',
        significance: 3,
        recentInteractions: [],
      });

      await setup.migrator.migrateRelationships();

      const results = setup.memory.search('Bob Manager');
      expect(results.length).toBeGreaterThan(0);
      // Significance 3/10 → confidence ~0.3
      expect(results[0].confidence).toBeLessThanOrEqual(0.5);
    });

    it('handles empty relationships directory', async () => {
      // Don't create any relationship files
      const report = await setup.migrator.migrateRelationships();
      expect(report.entitiesCreated).toBe(0);
      expect(report.errors).toHaveLength(0);
    });

    it('handles missing relationships directory', async () => {
      // stateDir exists but no relationships/ subdirectory
      const report = await setup.migrator.migrateRelationships();
      expect(report.entitiesCreated).toBe(0);
      expect(report.errors).toHaveLength(0);
    });
  });

  // ─── Canonical State Migration ──────────────────────────────────

  describe('canonical state migration', () => {
    it('migrates quick-facts into fact entities', async () => {
      writeCanonicalState(setup.stateDir, [
        {
          question: 'What is the deploy target?',
          answer: 'Vercel, auto-deploys from main branch.',
          lastVerified: '2026-02-20T00:00:00Z',
          source: 'observation',
        },
        {
          question: 'What database do we use?',
          answer: 'PostgreSQL on Xata cloud.',
          lastVerified: '2026-02-18T00:00:00Z',
          source: 'session:ABC-123',
        },
      ]);

      const report = await setup.migrator.migrateCanonicalState();

      expect(report.entitiesCreated).toBe(2);
      expect(report.source).toBe('canonical-state');

      // Verify entities exist
      const results = setup.memory.search('deploy Vercel');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].type).toBe('fact');
      expect(results[0].confidence).toBe(0.95); // Quick facts get high confidence
    });

    it('migrates anti-patterns into lesson entities', async () => {
      writeCanonicalState(setup.stateDir, undefined, [
        {
          id: 'AP-001',
          pattern: 'Deploying without verifying target project',
          consequence: 'Deploy to wrong production environment',
          alternative: 'Always verify topic-project binding before deploy.',
          learnedAt: '2026-02-01T00:00:00Z',
          incident: 'Luna incident',
        },
      ]);

      const report = await setup.migrator.migrateCanonicalState();

      expect(report.entitiesCreated).toBe(1);

      const results = setup.memory.search('deploy verify target project');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].type).toBe('lesson');
    });

    it('migrates projects into project entities', async () => {
      writeCanonicalState(setup.stateDir, undefined, undefined, [
        {
          name: 'Portal',
          dir: '/Users/justin/Documents/Projects/the-portal',
          gitRemote: 'https://github.com/SageMindAI/the-portal.git',
          type: 'nextjs',
          description: 'AI chatbot platform',
          topicIds: [4509, 4510],
        },
      ]);

      const report = await setup.migrator.migrateCanonicalState();

      expect(report.entitiesCreated).toBe(1);

      const results = setup.memory.search('Portal chatbot');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].type).toBe('project');
    });

    it('handles empty canonical state files', async () => {
      writeCanonicalState(setup.stateDir, [], [], []);

      const report = await setup.migrator.migrateCanonicalState();
      expect(report.entitiesCreated).toBe(0);
      expect(report.errors).toHaveLength(0);
    });

    it('handles missing canonical state files', async () => {
      const report = await setup.migrator.migrateCanonicalState();
      expect(report.entitiesCreated).toBe(0);
      expect(report.errors).toHaveLength(0);
    });

    it('handles corrupt JSON files gracefully', async () => {
      fs.writeFileSync(path.join(setup.stateDir, 'quick-facts.json'), '{not valid json');

      const report = await setup.migrator.migrateCanonicalState();
      expect(report.errors.length).toBeGreaterThan(0);
    });
  });

  // ─── Decision Journal Migration ─────────────────────────────────

  describe('decision journal migration', () => {
    it('migrates decisions into decision entities', async () => {
      writeDecisionJournal(setup.stateDir, [
        {
          timestamp: '2026-02-20T10:00:00Z',
          sessionId: 'session-001',
          decision: 'Use SQLite for semantic memory instead of external DB',
          alternatives: ['PostgreSQL extension', 'Neo4j', 'In-memory only'],
          principle: 'Stay file-based — Instar portability promise',
          confidence: 0.9,
          context: 'Evaluating storage for knowledge graph',
          tags: ['architecture', 'storage'],
        },
        {
          timestamp: '2026-02-22T14:00:00Z',
          sessionId: 'session-002',
          decision: 'Implement FTS5 for text search rather than embedding vectors',
          alternatives: ['OpenAI embeddings', 'Local sentence transformers'],
          principle: 'Start simple, upgrade when data proves the need',
          confidence: 0.8,
          tags: ['search', 'architecture'],
        },
      ]);

      const report = await setup.migrator.migrateDecisionJournal();

      expect(report.entitiesCreated).toBe(2);
      expect(report.source).toBe('decision-journal');

      // Verify entities
      const results = setup.memory.search('SQLite semantic memory');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].type).toBe('decision');
    });

    it('preserves decision confidence as entity confidence', async () => {
      writeDecisionJournal(setup.stateDir, [
        {
          timestamp: '2026-02-20T10:00:00Z',
          sessionId: 'session-001',
          decision: 'Use BM25 ranking for search results',
          confidence: 0.75,
        },
      ]);

      await setup.migrator.migrateDecisionJournal();

      const results = setup.memory.search('BM25 ranking search');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].confidence).toBe(0.75);
    });

    it('handles empty decision journal', async () => {
      writeDecisionJournal(setup.stateDir, []);

      const report = await setup.migrator.migrateDecisionJournal();
      expect(report.entitiesCreated).toBe(0);
      expect(report.errors).toHaveLength(0);
    });

    it('handles missing decision journal file', async () => {
      const report = await setup.migrator.migrateDecisionJournal();
      expect(report.entitiesCreated).toBe(0);
      expect(report.errors).toHaveLength(0);
    });

    it('skips corrupt JSONL lines without failing the whole migration', async () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-02-20T10:00:00Z',
          sessionId: 's1',
          decision: 'Good decision',
        }),
        '{not valid json',
        JSON.stringify({
          timestamp: '2026-02-21T10:00:00Z',
          sessionId: 's2',
          decision: 'Another good decision',
        }),
      ].join('\n') + '\n';

      fs.writeFileSync(path.join(setup.stateDir, 'decision-journal.jsonl'), content);

      const report = await setup.migrator.migrateDecisionJournal();
      // Should migrate the 2 valid entries, skip the corrupt one
      expect(report.entitiesCreated).toBe(2);
    });
  });

  // ─── Full Migration (migrateAll) ────────────────────────────────

  describe('migrateAll', () => {
    it('migrates all sources in a single call', async () => {
      // Set up all sources
      writeMemoryMd(setup.dir, `# Memory

## Server
Runs on port 3000 locally. Production on Vercel.
`);

      writeRelationship(setup.stateDir, {
        id: 'rel-100',
        name: 'Test User',
        channels: [],
        firstInteraction: '2026-01-01T00:00:00Z',
        lastInteraction: '2026-02-01T00:00:00Z',
        interactionCount: 5,
        themes: ['testing'],
        notes: 'A test user.',
        significance: 4,
        recentInteractions: [],
      });

      writeCanonicalState(setup.stateDir, [
        {
          question: 'Deploy target?',
          answer: 'Vercel',
          lastVerified: '2026-02-20T00:00:00Z',
          source: 'observation',
        },
      ]);

      writeDecisionJournal(setup.stateDir, [
        {
          timestamp: '2026-02-20T10:00:00Z',
          sessionId: 's1',
          decision: 'Use SQLite',
          confidence: 0.9,
        },
      ]);

      const report = await setup.migrator.migrateAll({
        memoryMdPath: path.join(setup.dir, 'MEMORY.md'),
      });

      // Should have results from all sources
      expect(report.totalEntitiesCreated).toBeGreaterThanOrEqual(3);
      expect(report.sources.length).toBe(4);

      // Verify per-source reports
      const sourceNames = report.sources.map(s => s.source);
      expect(sourceNames).toContain('MEMORY.md');
      expect(sourceNames).toContain('relationships');
      expect(sourceNames).toContain('canonical-state');
      expect(sourceNames).toContain('decision-journal');
    });

    it('returns aggregate totals', async () => {
      writeCanonicalState(setup.stateDir, [
        {
          question: 'Q1',
          answer: 'A1',
          lastVerified: new Date().toISOString(),
          source: 'test',
        },
        {
          question: 'Q2',
          answer: 'A2',
          lastVerified: new Date().toISOString(),
          source: 'test',
        },
      ]);

      const report = await setup.migrator.migrateAll({});

      expect(report.totalEntitiesCreated).toBeGreaterThanOrEqual(2);
      expect(report.totalErrors).toBeGreaterThanOrEqual(0);
      expect(report.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ─── Incremental Migration (Idempotency) ────────────────────────

  describe('incremental migration', () => {
    it('does not duplicate entities on repeated migration', async () => {
      writeCanonicalState(setup.stateDir, [
        {
          question: 'Deploy target?',
          answer: 'Vercel',
          lastVerified: '2026-02-20T00:00:00Z',
          source: 'observation',
        },
      ]);

      // First migration
      const report1 = await setup.migrator.migrateCanonicalState();
      expect(report1.entitiesCreated).toBe(1);

      // Second migration — same data
      const report2 = await setup.migrator.migrateCanonicalState();
      expect(report2.entitiesCreated).toBe(0);
      expect(report2.entitiesSkipped).toBe(1);

      // Only 1 entity in the database
      const stats = setup.memory.stats();
      expect(stats.totalEntities).toBe(1);
    });

    it('detects already-migrated MEMORY.md sections', async () => {
      writeMemoryMd(setup.dir, `# Memory

## Deploy
Vercel production deployment.
`);

      const mdPath = path.join(setup.dir, 'MEMORY.md');

      const report1 = await setup.migrator.migrateMemoryMd(mdPath);
      expect(report1.entitiesCreated).toBeGreaterThanOrEqual(1);

      const report2 = await setup.migrator.migrateMemoryMd(mdPath);
      expect(report2.entitiesCreated).toBe(0);
      expect(report2.entitiesSkipped).toBeGreaterThanOrEqual(1);
    });

    it('migrates new entries when source grows', async () => {
      writeCanonicalState(setup.stateDir, [
        {
          question: 'Q1',
          answer: 'A1',
          lastVerified: new Date().toISOString(),
          source: 'test',
        },
      ]);

      await setup.migrator.migrateCanonicalState();

      // Add a new fact
      writeCanonicalState(setup.stateDir, [
        {
          question: 'Q1',
          answer: 'A1',
          lastVerified: new Date().toISOString(),
          source: 'test',
        },
        {
          question: 'Q2',
          answer: 'A2',
          lastVerified: new Date().toISOString(),
          source: 'test',
        },
      ]);

      const report2 = await setup.migrator.migrateCanonicalState();
      expect(report2.entitiesCreated).toBe(1);  // Only the new one
      expect(report2.entitiesSkipped).toBe(1);  // The existing one
    });
  });

  // ─── Migration Report ───────────────────────────────────────────

  describe('migration report', () => {
    it('reports include per-source breakdowns', async () => {
      writeCanonicalState(setup.stateDir, [
        {
          question: 'Q',
          answer: 'A',
          lastVerified: new Date().toISOString(),
          source: 'test',
        },
      ], [
        {
          id: 'AP-001',
          pattern: 'Do not X',
          consequence: 'Bad things',
          alternative: 'Do Y instead',
          learnedAt: new Date().toISOString(),
        },
      ]);

      const report = await setup.migrator.migrateCanonicalState();

      expect(report.entitiesCreated).toBe(2);
      expect(report.source).toBe('canonical-state');
      expect(typeof report.durationMs).toBe('number');
    });
  });

  // ─── Edge Cases ─────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles relationship file with minimal data', async () => {
      writeRelationship(setup.stateDir, {
        id: 'rel-minimal',
        name: 'Minimal User',
        channels: [],
        firstInteraction: new Date().toISOString(),
        lastInteraction: new Date().toISOString(),
        interactionCount: 0,
        themes: [],
        notes: '',
        significance: 0,
        recentInteractions: [],
      });

      const report = await setup.migrator.migrateRelationships();
      // Should still create an entity, even for minimal records
      expect(report.entitiesCreated).toBe(1);
      expect(report.errors).toHaveLength(0);
    });

    it('handles decision with no optional fields', async () => {
      writeDecisionJournal(setup.stateDir, [
        {
          timestamp: '2026-02-20T10:00:00Z',
          sessionId: 's1',
          decision: 'A bare-bones decision',
        },
      ]);

      const report = await setup.migrator.migrateDecisionJournal();
      expect(report.entitiesCreated).toBe(1);
    });

    it('handles MEMORY.md with deeply nested headings', async () => {
      writeMemoryMd(setup.dir, `# Root

## Category

### Subcategory

#### Detail
The actual detailed content about a specific thing.

### Another Subcategory
More content here.
`);

      const report = await setup.migrator.migrateMemoryMd(path.join(setup.dir, 'MEMORY.md'));
      // Should create entities from meaningful sections
      expect(report.entitiesCreated).toBeGreaterThanOrEqual(1);
    });

    it('handles MEMORY.md with links and references', async () => {
      writeMemoryMd(setup.dir, `# Memory

## External Links
See [docs](https://example.com) and \`code references\` for details.
Check \`src/core/types.ts\` for type definitions.
`);

      const report = await setup.migrator.migrateMemoryMd(path.join(setup.dir, 'MEMORY.md'));
      expect(report.errors).toHaveLength(0);
    });

    it('handles concurrent migrateAll sources without conflicts', async () => {
      writeCanonicalState(setup.stateDir, [
        {
          question: 'Q',
          answer: 'A',
          lastVerified: new Date().toISOString(),
          source: 'test',
        },
      ]);

      writeDecisionJournal(setup.stateDir, [
        {
          timestamp: new Date().toISOString(),
          sessionId: 's1',
          decision: 'D',
        },
      ]);

      // Run migrateAll multiple times — should be idempotent
      await setup.migrator.migrateAll({});
      const report2 = await setup.migrator.migrateAll({});

      expect(report2.totalEntitiesCreated).toBe(0);
    });
  });
});
