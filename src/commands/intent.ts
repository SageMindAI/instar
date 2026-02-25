/**
 * `instar intent reflect` — Review recent decisions against stated intent.
 *
 * Reads the decision journal and AGENT.md Intent section, then outputs
 * a human-readable summary. This is a local command — no Claude session needed.
 */

import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { loadConfig } from '../core/Config.js';
import { DecisionJournal } from '../core/DecisionJournal.js';

interface IntentReflectOptions {
  dir?: string;
  days?: number;
  limit?: number;
}

/**
 * Extract the ## Intent section from AGENT.md content.
 * Returns the section text, or null if not found.
 */
function extractIntentSection(agentMdContent: string): string | null {
  const lines = agentMdContent.split('\n');
  let inIntent = false;
  let intentLines: string[] = [];

  for (const line of lines) {
    // Start of Intent section
    if (/^##\s+Intent\b/.test(line)) {
      inIntent = true;
      intentLines.push(line);
      continue;
    }
    // Another ## section starts — stop capturing
    if (inIntent && /^##\s+/.test(line) && !/^###/.test(line)) {
      break;
    }
    if (inIntent) {
      intentLines.push(line);
    }
  }

  if (intentLines.length === 0) return null;

  const text = intentLines.join('\n').trim();
  // Check if it's just the template with only HTML comments (no actual content)
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '').replace(/^##.*$/gm, '').replace(/^###.*$/gm, '').trim();
  if (!withoutComments) return null;

  return text;
}

export async function intentReflect(options: IntentReflectOptions): Promise<void> {
  let config;
  try {
    config = loadConfig(options.dir);
  } catch (err) {
    console.log(pc.red(`Not initialized: ${err instanceof Error ? err.message : String(err)}`));
    console.log(`Run ${pc.cyan('instar init')} first.`);
    process.exit(1);
    return; // Safety: process.exit may not actually exit in test environments
  }

  const days = options.days ?? 7;
  const limit = options.limit ?? 100;

  console.log(pc.bold(`\n  Intent Reflection: ${pc.cyan(config.projectName)}\n`));

  // Read AGENT.md
  const agentMdPath = path.join(config.stateDir, 'AGENT.md');
  let intentSection: string | null = null;

  if (fs.existsSync(agentMdPath)) {
    const content = fs.readFileSync(agentMdPath, 'utf-8');
    intentSection = extractIntentSection(content);
  }

  if (!intentSection) {
    console.log(pc.yellow('  No Intent section found in AGENT.md.'));
    console.log();
    console.log(pc.dim('  Add an ## Intent section to .instar/AGENT.md to define your agent\'s'));
    console.log(pc.dim('  mission, tradeoffs, and boundaries. The decision journal will then'));
    console.log(pc.dim('  track how decisions align with stated intent.'));
    console.log();
    console.log(pc.dim('  Example:'));
    console.log(pc.dim('    ## Intent'));
    console.log(pc.dim('    ### Mission'));
    console.log(pc.dim('    Build lasting customer relationships.'));
    console.log(pc.dim('    ### Tradeoffs'));
    console.log(pc.dim('    - When speed conflicts with thoroughness: prefer thoroughness.'));
    console.log(pc.dim('    ### Boundaries'));
    console.log(pc.dim('    - Never share internal data with external parties.'));
    console.log();
  } else {
    console.log(pc.bold('  Stated Intent:'));
    // Indent each line of the intent section
    for (const line of intentSection.split('\n')) {
      console.log(`    ${pc.dim(line)}`);
    }
    console.log();
  }

  // Read decision journal
  const journal = new DecisionJournal(config.stateDir);
  const entries = journal.read({ days, limit });
  const stats = journal.stats();

  if (entries.length === 0) {
    console.log(pc.yellow('  No decision journal entries found.'));
    console.log();
    console.log(pc.dim('  Decisions are logged via POST /intent/journal when the agent'));
    console.log(pc.dim('  faces significant tradeoffs. Entries appear here automatically'));
    console.log(pc.dim('  as the agent operates.'));
    console.log();
    return;
  }

  // Summary stats
  console.log(pc.bold('  Journal Summary:'));
  console.log(`    Total entries:     ${pc.cyan(String(stats.count))}`);
  if (stats.earliest && stats.latest) {
    console.log(`    Date range:        ${pc.dim(stats.earliest.slice(0, 10))} to ${pc.dim(stats.latest.slice(0, 10))}`);
  }
  console.log(`    Conflicts flagged: ${stats.conflictCount > 0 ? pc.red(String(stats.conflictCount)) : pc.green('0')}`);
  console.log(`    Showing:           ${pc.dim(`last ${days} days, up to ${limit} entries`)}`);
  console.log();

  // Principle distribution
  if (stats.topPrinciples.length > 0) {
    console.log(pc.bold('  Principle Distribution:'));
    for (const { principle, count } of stats.topPrinciples.slice(0, 10)) {
      const bar = '█'.repeat(Math.min(count, 30));
      console.log(`    ${pc.dim(bar)} ${count}x ${principle}`);
    }
    console.log();
  }

  // Recent entries
  console.log(pc.bold(`  Recent Decisions (${entries.length}):\n`));
  for (const entry of entries.slice(0, 20)) {
    const ts = entry.timestamp.slice(0, 16).replace('T', ' ');
    const conflict = entry.conflict ? pc.red(' [CONFLICT]') : '';
    const confidence = entry.confidence !== undefined ? pc.dim(` (${Math.round(entry.confidence * 100)}% confident)`) : '';
    const principle = entry.principle ? pc.cyan(` [${entry.principle}]`) : '';
    const job = entry.jobSlug ? pc.magenta(` job:${entry.jobSlug}`) : '';

    console.log(`    ${pc.dim(ts)}${job}${conflict}`);
    console.log(`      ${entry.decision}${principle}${confidence}`);
    if (entry.alternatives && entry.alternatives.length > 0) {
      console.log(`      ${pc.dim('Alternatives: ' + entry.alternatives.join(', '))}`);
    }
    console.log();
  }

  if (entries.length > 20) {
    console.log(pc.dim(`    ... and ${entries.length - 20} more entries (use --limit to see more)`));
    console.log();
  }
}
