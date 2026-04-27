/**
 * Tests for MemoryExporter — MEMORY.md generation from SemanticMemory.
 *
 * Phase 6 of the memory architecture. Tests the inverse of MemoryMigrator:
 * reading entities from the knowledge graph and rendering well-structured
 * markdown suitable for session injection.
 *
 * Uses REAL SQLite databases in temp directories. Verifies:
 *
 * 1. Basic generation produces valid markdown with header and footer
 * 2. Entities are grouped by domain, then by type
 * 3. Domain ordering follows DOMAIN_ORDER constant
 * 4. Type ordering follows TYPE_ORDER constant within each domain
 * 5. Entities without a domain go under "General Knowledge"
 * 6. Confidence filtering excludes low-confidence entities
 * 7. Expired entities are excluded
 * 8. maxEntities cap is respected
 * 9. Entities are sorted by confidence descending within groups
 * 10. write() creates file on disk with correct content
 * 11. write() creates parent directories if missing
 * 12. Empty database produces minimal markdown
 * 13. Custom agentName appears in header
 * 14. includeFooter: false suppresses footer
 * 15. Tags are rendered inline
 * 16. ExportResult metadata is accurate
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';
import { MemoryExporter } from '../../src/memory/MemoryExporter.js';
import type { EntityType } from '../../src/core/types.js';

// ─── Helpers ─────────────────────────────────────────────────────

interface TestSetup {
  dir: string;
  memory: SemanticMemory;
  cleanup: () => void;
}

const NOW = new Date().toISOString();

/** Shorthand for remember() with required fields pre-filled */
function rem(memory: SemanticMemory, opts: {
  name: string;
  type: EntityType;
  content: string;
  confidence: number;
  domain?: string;
  tags?: string[];
  expiresAt?: string;
}): string {
  return memory.remember({
    type: opts.type,
    name: opts.name,
    content: opts.content,
    confidence: opts.confidence,
    lastVerified: NOW,
    source: 'test',
    tags: opts.tags ?? [],
    domain: opts.domain,
    expiresAt: opts.expiresAt,
  });
}

async function createTestMemory(): Promise<TestSetup> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exporter-test-'));
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
    memory,
    cleanup: () => {
      memory.close();
      // safe-git-allow: incremental-migration
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedEntities(memory: SemanticMemory): void {
  // Infrastructure domain
  rem(memory, { name: 'Docker Setup', type: 'tool', content: 'Docker compose for local development.', confidence: 0.9, domain: 'infrastructure', tags: ['docker', 'devops'] });
  rem(memory, { name: 'Deploy Pipeline', type: 'pattern', content: 'CI/CD via GitHub Actions.', confidence: 0.7, domain: 'infrastructure', tags: ['ci-cd'] });
  // Development domain
  rem(memory, { name: 'Portal Project', type: 'project', content: 'AI chatbot platform with consciousness features.', confidence: 0.95, domain: 'development', tags: ['portal', 'ai'] });
  // Relationships domain
  rem(memory, { name: 'Justin Headley', type: 'person', content: 'Primary collaborator and founder.', confidence: 0.99, domain: 'relationships', tags: ['founder'] });
  // No domain (General Knowledge)
  rem(memory, { name: 'TypeScript Tip', type: 'fact', content: 'Use strict null checks.', confidence: 0.6, tags: ['typescript'] });
  // Low confidence (should be filtered)
  rem(memory, { name: 'Stale Note', type: 'fact', content: 'This should be excluded.', confidence: 0.1, domain: 'development' });
}

// ─── Tests ───────────────────────────────────────────────────────

describe('MemoryExporter', () => {
  let setup: TestSetup;

  beforeEach(async () => {
    setup = await createTestMemory();
  });

  afterEach(() => {
    setup.cleanup();
  });

  // 1. Basic generation
  it('generates valid markdown with header and footer', () => {
    seedEntities(setup.memory);
    const exporter = new MemoryExporter({ semanticMemory: setup.memory });
    const result = exporter.generate();

    expect(result.markdown).toContain('# Agent Memory');
    expect(result.markdown).toContain('Auto-generated from SemanticMemory');
    expect(result.markdown).toContain('---');
  });

  // 2. Grouping by domain then type
  it('groups entities by domain then by type', () => {
    seedEntities(setup.memory);
    const exporter = new MemoryExporter({ semanticMemory: setup.memory });
    const result = exporter.generate();

    expect(result.markdown).toContain('## Infrastructure');
    expect(result.markdown).toContain('## Development');
    expect(result.markdown).toContain('## Relationships');
    expect(result.markdown).toContain('## General Knowledge');
  });

  // 3. Domain ordering
  it('orders domains according to DOMAIN_ORDER', () => {
    seedEntities(setup.memory);
    const exporter = new MemoryExporter({ semanticMemory: setup.memory });
    const result = exporter.generate();

    const infraIdx = result.markdown.indexOf('## Infrastructure');
    const devIdx = result.markdown.indexOf('## Development');
    const relIdx = result.markdown.indexOf('## Relationships');
    const genIdx = result.markdown.indexOf('## General Knowledge');

    expect(infraIdx).toBeLessThan(devIdx);
    expect(devIdx).toBeLessThan(relIdx);
    expect(relIdx).toBeLessThan(genIdx);
  });

  // 4. Type ordering within domain
  it('orders types within a domain according to TYPE_ORDER', () => {
    seedEntities(setup.memory);
    const exporter = new MemoryExporter({ semanticMemory: setup.memory });
    const result = exporter.generate();

    const toolIdx = result.markdown.indexOf('### Tools');
    const patternIdx = result.markdown.indexOf('### Patterns');

    expect(toolIdx).toBeGreaterThan(-1);
    expect(patternIdx).toBeGreaterThan(-1);
    expect(toolIdx).toBeLessThan(patternIdx);
  });

  // 5. General Knowledge for no-domain entities
  it('places entities without domain under General Knowledge', () => {
    rem(setup.memory, { name: 'Orphan Fact', type: 'fact', content: 'No domain assigned.', confidence: 0.8 });

    const exporter = new MemoryExporter({ semanticMemory: setup.memory });
    const result = exporter.generate();

    expect(result.markdown).toContain('## General Knowledge');
    expect(result.markdown).toContain('Orphan Fact');
  });

  // 6. Confidence filtering
  it('excludes entities below minConfidence', () => {
    seedEntities(setup.memory);
    const exporter = new MemoryExporter({ semanticMemory: setup.memory, minConfidence: 0.2 });
    const result = exporter.generate();

    expect(result.markdown).not.toContain('Stale Note');
    expect(result.excludedCount).toBeGreaterThan(0);
  });

  // 7. Expired entities excluded
  it('excludes expired entities', () => {
    rem(setup.memory, {
      name: 'Expired Entity', type: 'fact', content: 'This has expired.',
      confidence: 0.8, domain: 'development',
      expiresAt: new Date(Date.now() - 86400000).toISOString(),
    });

    const exporter = new MemoryExporter({ semanticMemory: setup.memory });
    const result = exporter.generate();

    expect(result.markdown).not.toContain('Expired Entity');
  });

  // 8. maxEntities cap
  it('caps output at maxEntities', () => {
    for (let i = 0; i < 10; i++) {
      rem(setup.memory, { name: `Entity ${i}`, type: 'fact', content: `Content ${i}`, confidence: 0.9 - i * 0.05, domain: 'development' });
    }

    const exporter = new MemoryExporter({ semanticMemory: setup.memory, maxEntities: 5 });
    const result = exporter.generate();

    expect(result.entityCount).toBe(5);
    expect(result.excludedCount).toBe(5);
  });

  // 9. Sort by confidence descending
  it('sorts entities by confidence descending within groups', () => {
    rem(setup.memory, { name: 'Low Conf', type: 'fact', content: 'Lower confidence.', confidence: 0.5, domain: 'development' });
    rem(setup.memory, { name: 'High Conf', type: 'fact', content: 'Higher confidence.', confidence: 0.95, domain: 'development' });

    const exporter = new MemoryExporter({ semanticMemory: setup.memory });
    const result = exporter.generate();

    const highIdx = result.markdown.indexOf('High Conf');
    const lowIdx = result.markdown.indexOf('Low Conf');
    expect(highIdx).toBeLessThan(lowIdx);
  });

  // 10. write() creates file on disk
  it('writes MEMORY.md to disk', () => {
    seedEntities(setup.memory);
    const exporter = new MemoryExporter({ semanticMemory: setup.memory });
    const outPath = path.join(setup.dir, 'MEMORY.md');
    const result = exporter.write(outPath);

    expect(result.filePath).toBe(outPath);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(result.fileSizeBytes).toBeGreaterThan(0);

    const content = fs.readFileSync(outPath, 'utf-8');
    expect(content).toBe(result.markdown);
  });

  // 11. write() creates parent directories
  it('creates parent directories when writing', () => {
    seedEntities(setup.memory);
    const exporter = new MemoryExporter({ semanticMemory: setup.memory });
    const outPath = path.join(setup.dir, 'nested', 'deep', 'MEMORY.md');
    const result = exporter.write(outPath);

    expect(fs.existsSync(outPath)).toBe(true);
    expect(result.fileSizeBytes).toBeGreaterThan(0);
  });

  // 12. Empty database
  it('generates minimal markdown for empty database', () => {
    const exporter = new MemoryExporter({ semanticMemory: setup.memory });
    const result = exporter.generate();

    expect(result.markdown).toContain('# Agent Memory');
    expect(result.entityCount).toBe(0);
    expect(result.domainCount).toBe(0);
  });

  // 13. Custom agent name
  it('uses custom agentName in header', () => {
    seedEntities(setup.memory);
    const exporter = new MemoryExporter({ semanticMemory: setup.memory, agentName: 'Dawn' });
    const result = exporter.generate();

    expect(result.markdown).toContain('# Dawn Memory');
  });

  // 14. includeFooter: false
  it('suppresses footer when includeFooter is false', () => {
    seedEntities(setup.memory);
    const exporter = new MemoryExporter({ semanticMemory: setup.memory, includeFooter: false });
    const result = exporter.generate();

    expect(result.markdown).not.toContain('Auto-generated from SemanticMemory');
    expect(result.markdown).not.toContain('---');
  });

  // 15. Tags rendered inline
  it('renders tags inline', () => {
    rem(setup.memory, { name: 'Tagged Entity', type: 'fact', content: 'Has tags.', confidence: 0.8, domain: 'development', tags: ['alpha', 'beta'] });

    const exporter = new MemoryExporter({ semanticMemory: setup.memory });
    const result = exporter.generate();

    expect(result.markdown).toContain('*Tags: alpha, beta*');
  });

  // 16. ExportResult metadata accuracy
  it('returns accurate metadata in ExportResult', () => {
    seedEntities(setup.memory);
    const exporter = new MemoryExporter({ semanticMemory: setup.memory });
    const result = exporter.generate();

    expect(result.entityCount).toBe(5); // 6 seeded, 1 below threshold
    expect(result.excludedCount).toBe(1);
    expect(result.domainCount).toBeGreaterThanOrEqual(3);
    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(result.estimatedTokens).toBe(Math.ceil(result.markdown.length / 4));
  });
});
