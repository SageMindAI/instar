/**
 * DecisionJournal — Records intent-relevant decisions for alignment analysis.
 *
 * The measurement foundation for intent engineering. Agents log decisions
 * when they face significant tradeoffs, and the journal enables reflection
 * on whether those decisions aligned with stated intent.
 *
 * Storage: JSONL file at {stateDir}/decision-journal.jsonl
 * Format: One JSON object per line, newest entries appended at the end.
 * Creation: Lazy — file is only created when the first entry is logged.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DecisionJournalEntry } from './types.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';

export interface DecisionJournalStats {
  /** Total number of entries */
  count: number;
  /** ISO timestamp of earliest entry */
  earliest: string | null;
  /** ISO timestamp of latest entry */
  latest: string | null;
  /** Top principles referenced, sorted by frequency */
  topPrinciples: Array<{ principle: string; count: number }>;
  /** Number of entries flagged as conflicting */
  conflictCount: number;
}

export class DecisionJournal {
  private journalFile: string;

  constructor(stateDir: string) {
    this.journalFile = path.join(stateDir, 'decision-journal.jsonl');
  }

  /**
   * Log a decision to the journal.
   * Appends a JSONL line with an auto-generated timestamp.
   */
  log(entry: Omit<DecisionJournalEntry, 'timestamp'>): DecisionJournalEntry {
    const full: DecisionJournalEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };

    // Ensure parent directory exists (lazy creation)
    const dir = path.dirname(this.journalFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    maybeRotateJsonl(this.journalFile);
    fs.appendFileSync(this.journalFile, JSON.stringify(full) + '\n');
    return full;
  }

  /**
   * Read journal entries with optional filtering.
   */
  read(options?: {
    /** Only entries from the last N days */
    days?: number;
    /** Only entries from this job */
    jobSlug?: string;
    /** Maximum entries to return (most recent first) */
    limit?: number;
  }): DecisionJournalEntry[] {
    const entries = this.readLines();

    const cutoff = options?.days
      ? new Date(Date.now() - options.days * 24 * 60 * 60 * 1000).toISOString()
      : undefined;

    let filtered = entries.filter(e => {
      if (cutoff && e.timestamp < cutoff) return false;
      if (options?.jobSlug && e.jobSlug !== options.jobSlug) return false;
      return true;
    });

    // Most recent first
    filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    if (options?.limit) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
  }

  /**
   * Return aggregate statistics about the journal.
   */
  stats(): DecisionJournalStats {
    const entries = this.readLines();

    if (entries.length === 0) {
      return {
        count: 0,
        earliest: null,
        latest: null,
        topPrinciples: [],
        conflictCount: 0,
      };
    }

    // Sort chronologically for earliest/latest
    entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Count principles
    const principleCounts: Record<string, number> = {};
    let conflictCount = 0;

    for (const entry of entries) {
      if (entry.principle) {
        principleCounts[entry.principle] = (principleCounts[entry.principle] || 0) + 1;
      }
      if (entry.conflict) {
        conflictCount++;
      }
    }

    const topPrinciples = Object.entries(principleCounts)
      .map(([principle, count]) => ({ principle, count }))
      .sort((a, b) => b.count - a.count);

    return {
      count: entries.length,
      earliest: entries[0].timestamp,
      latest: entries[entries.length - 1].timestamp,
      topPrinciples,
      conflictCount,
    };
  }

  /**
   * Read all lines from the JSONL file.
   */
  private readLines(): DecisionJournalEntry[] {
    if (!fs.existsSync(this.journalFile)) return [];

    try {
      const content = fs.readFileSync(this.journalFile, 'utf-8').trim();
      if (!content) return [];

      return content.split('\n').map(line => {
        try {
          return JSON.parse(line) as DecisionJournalEntry;
        } catch {
          // @silent-fallback-ok — JSONL line parse, skip corrupted
          return null;
        }
      }).filter(Boolean) as DecisionJournalEntry[];
    } catch (error) {
      console.error(`[DecisionJournal] Failed to read ${this.journalFile}:`, error);
      DegradationReporter.getInstance().report({
        feature: 'DecisionJournal.readLines',
        primary: 'Read decision journal from JSONL',
        fallback: 'Return empty array — no history',
        reason: `Failed to read journal: ${error instanceof Error ? error.message : String(error)}`,
        impact: 'Alignment analysis lacks decision data',
      });
      return [];
    }
  }
}
