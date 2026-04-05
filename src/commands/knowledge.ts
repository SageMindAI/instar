/**
 * `instar knowledge` — Ingest, list, search, and remove knowledge base entries.
 *
 * Commands:
 *   instar knowledge ingest "content" --title "Title"   Ingest content
 *   instar knowledge list [--tag TAG]                   List catalog
 *   instar knowledge search "query"                     Search knowledge
 *   instar knowledge remove SOURCE_ID                   Remove a source
 */

import pc from 'picocolors';
import { loadConfig, getSemanticMemoryConfig } from '../core/Config.js';
import { KnowledgeManager } from '../knowledge/KnowledgeManager.js';

interface KnowledgeOptions {
  dir?: string;
  title?: string;
  url?: string;
  type?: string;
  tags?: string;
  summary?: string;
  tag?: string;
  limit?: number;
}

function getManager(dir?: string): KnowledgeManager {
  const config = loadConfig(dir);
  return new KnowledgeManager(config.stateDir);
}

export async function knowledgeIngest(content: string, opts: KnowledgeOptions): Promise<void> {
  try {
    const km = getManager(opts.dir);
    const tags = opts.tags ? opts.tags.split(',').map(t => t.trim()) : [];
    const type = (opts.type as 'article' | 'transcript' | 'doc') ?? 'article';

    const result = km.ingest(content, {
      title: opts.title!,
      url: opts.url,
      type,
      tags,
      summary: opts.summary,
    });

    console.log(pc.green(`\n  Ingested: ${opts.title}`));
    console.log(pc.dim(`  ID: ${result.sourceId}`));
    console.log(pc.dim(`  File: ${result.filePath}`));
    console.log(pc.dim(`  Words: ${result.wordCount}`));
    console.log();
    console.log(pc.dim('  Run `instar memory sync` to update the search index.'));
  } catch (err) {
    console.error(pc.red(`Failed to ingest: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

export async function knowledgeList(opts: KnowledgeOptions): Promise<void> {
  try {
    const km = getManager(opts.dir);
    const sources = km.getCatalog(opts.tag);

    if (sources.length === 0) {
      console.log(pc.dim('\n  No knowledge sources found.'));
      if (opts.tag) console.log(pc.dim(`  (filtered by tag: ${opts.tag})`));
      console.log();
      return;
    }

    console.log(pc.bold(`\n  Knowledge Base (${sources.length} source${sources.length === 1 ? '' : 's'})\n`));

    for (const source of sources) {
      const date = source.ingestedAt.split('T')[0];
      const tagStr = source.tags.length > 0 ? ` [${source.tags.join(', ')}]` : '';
      console.log(`  ${pc.cyan(source.id)} ${source.title}${pc.dim(tagStr)}`);
      console.log(`    ${pc.dim(`${source.type} | ${date} | ${source.wordCount} words`)}`);
      if (source.url) console.log(`    ${pc.dim(source.url)}`);
      console.log();
    }
  } catch (err) {
    console.error(pc.red(`Failed to list: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

export async function knowledgeSearch(query: string, opts: KnowledgeOptions): Promise<void> {
  try {
    const config = loadConfig(opts.dir);
    const { SemanticMemory } = await import('../memory/SemanticMemory.js');
    const memory = new SemanticMemory(getSemanticMemoryConfig(config));
    await memory.open();

    try {
      const limit = opts.limit || 10;
      const results = memory.search(query, { limit });

      if (results.length === 0) {
        console.log(pc.dim(`\n  No knowledge results for "${query}".`));
        console.log(pc.dim('  Try `instar memory search` for a broader search.\n'));
        return;
      }

      console.log(pc.bold(`\n  Knowledge search: "${query}" (${results.length} results)\n`));

      for (const result of results) {
        const score = result.score.toFixed(3);
        const confidence = Math.round(result.confidence * 100);
        console.log(`  ${pc.cyan(result.name)} ${pc.dim(`(${result.type})`)}  ${pc.dim(`score: ${score}  confidence: ${confidence}%`)}`);
        const snippet = result.content.slice(0, 200).replace(/\n/g, ' ');
        console.log(`  ${pc.dim(snippet)}${result.content.length > 200 ? '...' : ''}`);
        console.log();
      }
    } finally {
      memory.close();
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('better-sqlite3')) {
      console.log(pc.yellow('Knowledge search requires better-sqlite3.'));
      console.log(pc.dim('Run: npm install better-sqlite3'));
    } else {
      console.error(pc.red(`Search failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    process.exit(1);
  }
}

export async function knowledgeRemove(sourceId: string, opts: KnowledgeOptions): Promise<void> {
  try {
    const km = getManager(opts.dir);
    const source = km.getSource(sourceId);

    if (!source) {
      console.log(pc.red(`\n  Source not found: ${sourceId}\n`));
      process.exit(1);
    }

    const removed = km.remove(sourceId);
    if (removed) {
      console.log(pc.green(`\n  Removed: ${source.title} (${sourceId})`));
      console.log(pc.dim('  Run `instar memory sync` to update the search index.\n'));
    }
  } catch (err) {
    console.error(pc.red(`Failed to remove: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}
