/**
 * `instar memory` — Search and manage agent memory index.
 *
 * Commands:
 *   instar memory search "query"   Search memory from CLI
 *   instar memory reindex          Full rebuild of SQLite index
 *   instar memory status           Show index statistics
 */

import pc from 'picocolors';
import { loadConfig, getSemanticMemoryConfig } from '../core/Config.js';
import { SemanticMemory } from '../memory/SemanticMemory.js';

interface MemoryOptions {
  dir?: string;
  limit?: number;
}

async function getSemanticMemory(dir?: string): Promise<{ memory: SemanticMemory; cleanup: () => void }> {
  const config = loadConfig(dir);
  const memory = new SemanticMemory(getSemanticMemoryConfig(config));
  await memory.open();
  return { memory, cleanup: () => memory.close() };
}

export async function memorySearch(query: string, opts: MemoryOptions): Promise<void> {
  let cleanup: () => void = () => {};

  try {
    const { memory, cleanup: c } = await getSemanticMemory(opts.dir);
    cleanup = c;

    const limit = opts.limit || 10;
    const results = memory.search(query, { limit });

    if (results.length === 0) {
      console.log(pc.dim(`No results for "${query}".`));
      console.log(pc.dim('Try a different query or run `instar memory reindex` to rebuild the index.'));
      return;
    }

    console.log(pc.bold(`\n  Results for "${query}" (${results.length})\n`));

    for (const result of results) {
      const score = result.score.toFixed(3);
      const confidence = Math.round(result.confidence * 100);
      console.log(`  ${pc.cyan(result.name)} ${pc.dim(`(${result.type})`)}  ${pc.dim(`score: ${score}  confidence: ${confidence}%`)}`);

      // Show a snippet (first 200 chars)
      const snippet = result.content.slice(0, 200).replace(/\n/g, ' ');
      console.log(`  ${pc.dim(snippet)}${result.content.length > 200 ? '...' : ''}`);
      console.log();
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('better-sqlite3')) {
      console.log(pc.yellow('Memory search requires better-sqlite3.'));
      console.log(pc.dim('Install it with: npm install better-sqlite3'));
    } else {
      console.log(pc.red(`Search failed: ${err instanceof Error ? err.message : err}`));
    }
    process.exit(1);
  } finally {
    cleanup();
  }
}

export async function memoryReindex(opts: MemoryOptions): Promise<void> {
  let cleanup: () => void = () => {};

  try {
    const { memory, cleanup: c } = await getSemanticMemory(opts.dir);
    cleanup = c;

    console.log(pc.dim('Rebuilding semantic memory from JSONL...'));
    const result = memory.rebuild();
    console.log(pc.green(`Rebuilt: ${result.entities} entities, ${result.edges} edges.`));

    const stats = memory.stats();
    console.log(`  DB size: ${formatBytes(stats.dbSizeBytes)}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('better-sqlite3')) {
      console.log(pc.yellow('Memory search requires better-sqlite3.'));
      console.log(pc.dim('Install it with: npm install better-sqlite3'));
    } else {
      console.log(pc.red(`Reindex failed: ${err instanceof Error ? err.message : err}`));
    }
    process.exit(1);
  } finally {
    cleanup();
  }
}

export async function memoryStatus(opts: MemoryOptions): Promise<void> {
  let cleanup: () => void = () => {};

  try {
    const { memory, cleanup: c } = await getSemanticMemory(opts.dir);
    cleanup = c;

    const stats = memory.stats();

    console.log(pc.bold('\n  Semantic Memory\n'));
    console.log(`  Status:     ${pc.green('enabled')}`);
    console.log(`  Entities:   ${stats.totalEntities}`);
    console.log(`  Edges:      ${stats.totalEdges}`);
    console.log(`  Avg conf:   ${stats.avgConfidence}`);
    console.log(`  Stale:      ${stats.staleCount > 0 ? pc.yellow(String(stats.staleCount)) : pc.dim('0')}`);
    console.log(`  DB size:    ${formatBytes(stats.dbSizeBytes)}`);
    console.log(`  Vector:     ${stats.vectorSearchAvailable ? pc.green(`available (${stats.embeddingCount} embeddings)`) : pc.dim('not available')}`);

    // Show type breakdown
    const types = Object.entries(stats.entityCountsByType).sort((a, b) => b[1] - a[1]);
    if (types.length > 0) {
      console.log(`  Types:      ${types.map(([t, c]) => `${t}: ${c}`).join(', ')}`);
    }

    console.log();
  } catch (err) {
    if (err instanceof Error && err.message.includes('better-sqlite3')) {
      console.log(pc.yellow('Memory search requires better-sqlite3.'));
      console.log(pc.dim('Install it with: npm install better-sqlite3'));
    } else {
      console.log(pc.red(`Status failed: ${err instanceof Error ? err.message : err}`));
    }
    process.exit(1);
  } finally {
    cleanup();
  }
}

interface ExportOptions extends MemoryOptions {
  output?: string;
  agent?: string;
  minConfidence?: number;
  maxEntities?: number;
}

export async function memoryExport(opts: ExportOptions): Promise<void> {
  try {
    const config = loadConfig(opts.dir);
    const { SemanticMemory } = await import('../memory/SemanticMemory.js');
    const { MemoryExporter } = await import('../memory/MemoryExporter.js');

    const semanticMemory = new SemanticMemory(getSemanticMemoryConfig(config));
    await semanticMemory.open();

    try {
      const exporter = new MemoryExporter({
        semanticMemory,
        agentName: opts.agent,
        minConfidence: opts.minConfidence,
        maxEntities: opts.maxEntities,
      });

      if (opts.output) {
        const result = exporter.write(opts.output);
        console.log(pc.green(`Exported ${result.entityCount} entities to ${result.filePath}`));
        console.log(`  Domains:  ${result.domainCount}`);
        console.log(`  Excluded: ${result.excludedCount} (below confidence threshold)`);
        console.log(`  Tokens:   ~${result.estimatedTokens}`);
        console.log(`  Size:     ${formatBytes(result.fileSizeBytes)}`);
      } else {
        const result = exporter.generate();
        // Print markdown to stdout for piping
        process.stdout.write(result.markdown);
      }
    } finally {
      semanticMemory.close();
    }
  } catch (err) {
    console.log(pc.red(`Export failed: ${err instanceof Error ? err.message : err}`));
    process.exit(1);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
