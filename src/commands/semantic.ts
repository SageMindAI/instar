/**
 * `instar semantic` — Manage the semantic memory knowledge graph.
 *
 * Commands:
 *   instar semantic search "query"   Search the knowledge graph
 *   instar semantic remember         Add a knowledge entity
 *   instar semantic forget <id>      Remove an entity
 *   instar semantic stats            Show graph statistics
 *   instar semantic export           Export all entities and edges
 *   instar semantic decay            Run confidence decay
 */

import pc from 'picocolors';
import { loadConfig, getSemanticMemoryConfig } from '../core/Config.js';
import { SemanticMemory } from '../memory/SemanticMemory.js';
import type { EntityType } from '../core/types.js';

interface SemanticOptions {
  dir?: string;
  limit?: number;
}

async function getSemanticMemory(dir?: string): Promise<{ memory: SemanticMemory; cleanup: () => void }> {
  const config = loadConfig(dir);
  const memory = new SemanticMemory(getSemanticMemoryConfig(config));
  await memory.open();
  return { memory, cleanup: () => memory.close() };
}

export async function semanticSearch(query: string, opts: SemanticOptions & {
  type?: string;
  domain?: string;
  minConfidence?: string;
}): Promise<void> {
  let cleanup: () => void = () => {};

  try {
    const { memory, cleanup: c } = await getSemanticMemory(opts.dir);
    cleanup = c;

    const limit = opts.limit || 10;
    const types = opts.type ? [opts.type as EntityType] : undefined;
    const domain = opts.domain;
    const minConfidence = opts.minConfidence ? parseFloat(opts.minConfidence) : undefined;

    const results = memory.search(query, { types, domain, minConfidence, limit });

    if (results.length === 0) {
      console.log(pc.dim(`No results for "${query}".`));
      return;
    }

    console.log(pc.bold(`\n  Results for "${query}" (${results.length})\n`));

    for (const entity of results) {
      const score = entity.score.toFixed(3);
      const conf = (entity.confidence * 100).toFixed(0);
      console.log(`  ${pc.cyan(entity.name)}  ${pc.dim(`[${entity.type}]`)}  ${pc.dim(`score: ${score}`)}  ${pc.dim(`conf: ${conf}%`)}`);

      const snippet = entity.content.slice(0, 200).replace(/\n/g, ' ');
      console.log(`  ${pc.dim(snippet)}${entity.content.length > 200 ? '...' : ''}`);
      if (entity.domain) console.log(`  ${pc.dim(`domain: ${entity.domain}`)}`);
      console.log();
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('better-sqlite3')) {
      console.log(pc.yellow('Semantic memory requires better-sqlite3.'));
      console.log(pc.dim('Install it with: npm install better-sqlite3'));
    } else {
      console.log(pc.red(`Search failed: ${err instanceof Error ? err.message : err}`));
    }
    process.exit(1);
  } finally {
    cleanup();
  }
}

export async function semanticRemember(opts: SemanticOptions & {
  type: string;
  name: string;
  content: string;
  confidence?: string;
  source?: string;
  tags?: string;
  domain?: string;
}): Promise<void> {
  let cleanup: () => void = () => {};

  try {
    const { memory, cleanup: c } = await getSemanticMemory(opts.dir);
    cleanup = c;

    const id = memory.remember({
      type: opts.type as EntityType,
      name: opts.name,
      content: opts.content,
      confidence: opts.confidence ? parseFloat(opts.confidence) : 0.8,
      lastVerified: new Date().toISOString(),
      source: opts.source || 'cli',
      tags: opts.tags ? opts.tags.split(',').map(t => t.trim()) : [],
      domain: opts.domain,
    });

    console.log(pc.green(`Remembered: ${pc.bold(opts.name)}`));
    console.log(pc.dim(`  ID: ${id}`));
  } catch (err) {
    console.log(pc.red(`Remember failed: ${err instanceof Error ? err.message : err}`));
    process.exit(1);
  } finally {
    cleanup();
  }
}

export async function semanticForget(id: string, opts: SemanticOptions): Promise<void> {
  let cleanup: () => void = () => {};

  try {
    const { memory, cleanup: c } = await getSemanticMemory(opts.dir);
    cleanup = c;

    // Verify entity exists before forgetting
    const entity = memory.recall(id);
    if (!entity) {
      console.log(pc.yellow(`Entity not found: ${id}`));
      process.exit(1);
    }

    memory.forget(id, 'cli');
    console.log(pc.green(`Forgot: ${pc.bold(entity.entity.name)} (${id})`));
  } catch (err) {
    console.log(pc.red(`Forget failed: ${err instanceof Error ? err.message : err}`));
    process.exit(1);
  } finally {
    cleanup();
  }
}

export async function semanticStats(opts: SemanticOptions): Promise<void> {
  let cleanup: () => void = () => {};

  try {
    const { memory, cleanup: c } = await getSemanticMemory(opts.dir);
    cleanup = c;

    const stats = memory.stats();

    console.log(pc.bold('\n  Semantic Memory\n'));
    console.log(`  Entities:     ${stats.totalEntities}`);
    console.log(`  Edges:        ${stats.totalEdges}`);
    console.log(`  Avg conf:     ${(stats.avgConfidence * 100).toFixed(1)}%`);
    console.log(`  Stale:        ${stats.staleCount > 0 ? pc.yellow(String(stats.staleCount)) : pc.dim('0')}`);
    console.log(`  DB size:      ${formatBytes(stats.dbSizeBytes)}`);

    if (Object.keys(stats.entityCountsByType).length > 0) {
      console.log(`\n  ${pc.dim('By type:')}`);
      for (const [type, count] of Object.entries(stats.entityCountsByType)) {
        console.log(`    ${type}: ${count}`);
      }
    }
    console.log();
  } catch (err) {
    console.log(pc.red(`Stats failed: ${err instanceof Error ? err.message : err}`));
    process.exit(1);
  } finally {
    cleanup();
  }
}

export async function semanticExport(opts: SemanticOptions & { output?: string }): Promise<void> {
  let cleanup: () => void = () => {};

  try {
    const { memory, cleanup: c } = await getSemanticMemory(opts.dir);
    cleanup = c;

    const data = memory.export();

    if (opts.output) {
      const fs = await import('node:fs');
      fs.writeFileSync(opts.output, JSON.stringify(data, null, 2));
      console.log(pc.green(`Exported ${data.entities.length} entities, ${data.edges.length} edges to ${opts.output}`));
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
  } catch (err) {
    console.log(pc.red(`Export failed: ${err instanceof Error ? err.message : err}`));
    process.exit(1);
  } finally {
    cleanup();
  }
}

export async function semanticDecay(opts: SemanticOptions): Promise<void> {
  let cleanup: () => void = () => {};

  try {
    const { memory, cleanup: c } = await getSemanticMemory(opts.dir);
    cleanup = c;

    const report = memory.decayAll();

    console.log(pc.bold('\n  Decay Report\n'));
    console.log(`  Processed:  ${report.entitiesProcessed}`);
    console.log(`  Decayed:    ${report.entitiesDecayed}`);
    console.log(`  Expired:    ${report.entitiesExpired}`);
    if (report.entitiesProcessed > 0) {
      console.log(`  Confidence: ${(report.minConfidence * 100).toFixed(1)}% - ${(report.maxConfidence * 100).toFixed(1)}%`);
      console.log(`  Average:    ${(report.avgConfidence * 100).toFixed(1)}%`);
    }
    console.log();
  } catch (err) {
    console.log(pc.red(`Decay failed: ${err instanceof Error ? err.message : err}`));
    process.exit(1);
  } finally {
    cleanup();
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
