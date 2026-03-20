/**
 * JSONL Truncator — Programmatic Conversation Rewind
 *
 * Claude Code has no programmatic rewind API. But the JSONL file IS the
 * conversation state. Truncating it is equivalent to rewinding.
 *
 * Always creates a backup before truncating. If resume after truncation fails,
 * the backup can be restored.
 *
 * Uses tail-scan to avoid reading entire multi-MB files into memory.
 * Only the tail is parsed to find the truncation point; the file is then
 * truncated at the byte offset without buffering the full content.
 *
 * Part of PROP-session-stall-recovery Phase B
 */

import * as fs from 'node:fs';

// ============================================================================
// Types
// ============================================================================

export type TruncationStrategy = 'last_exchange' | 'last_successful_tool' | 'n_exchanges_back';

export interface TruncationResult {
  originalLines: number;
  truncatedLines: number;
  removedLines: number;
  backupPath: string;
  strategy: TruncationStrategy;
}

interface TailEntry {
  parsed: any;
  /** Byte offset where this line starts in the file */
  byteOffset: number;
  /** Byte length of this line (including newline) */
  byteLength: number;
}

// ============================================================================
// Main Truncation Function
// ============================================================================

/**
 * Truncate a JSONL file to a safe point for resume.
 *
 * Uses tail-scan: reads the last ~256KB of the file to find the truncation
 * point, then truncates at the byte offset. Avoids loading the entire file.
 *
 * @param jsonlPath - Path to the JSONL conversation file
 * @param strategy - How far back to truncate
 * @param nExchanges - Number of exchanges to remove (only for 'n_exchanges_back')
 * @returns TruncationResult with details of what was done
 */
export function truncateJsonlToSafePoint(
  jsonlPath: string,
  strategy: TruncationStrategy = 'last_exchange',
  nExchanges: number = 1,
): TruncationResult {
  const stat = fs.statSync(jsonlPath);
  if (stat.size === 0) {
    throw new Error('JSONL file is empty — nothing to truncate');
  }

  // Read tail of file — 256KB is enough for ~50+ JSONL entries
  const TAIL_BYTES = 256 * 1024;
  const readStart = Math.max(0, stat.size - TAIL_BYTES);
  const readSize = Math.min(TAIL_BYTES, stat.size);

  const fd = fs.openSync(jsonlPath, 'r');
  let tailContent: string;
  try {
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, readStart);
    tailContent = buffer.toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }

  // Parse lines from tail with byte offsets
  const rawLines = tailContent.split('\n');
  const entries: TailEntry[] = [];

  // Track byte position within the tail
  let bytePos = readStart;
  // If we started mid-file, skip the first (potentially partial) line
  const startIdx = readStart > 0 ? 1 : 0;
  if (readStart > 0) {
    bytePos += Buffer.byteLength(rawLines[0] + '\n', 'utf-8');
  }

  // Count total lines (approximate — we know exact count in the tail)
  let totalLinesInTail = 0;

  for (let i = startIdx; i < rawLines.length; i++) {
    const line = rawLines[i];
    const lineBytes = Buffer.byteLength(line, 'utf-8');

    if (line.trim().length > 0) {
      totalLinesInTail++;
      try {
        entries.push({
          parsed: JSON.parse(line),
          byteOffset: bytePos,
          byteLength: lineBytes + 1, // +1 for newline
        });
      } catch { // @silent-fallback-ok — skipping corrupt JSONL lines during tail-scan is expected
        entries.push({
          parsed: null,
          byteOffset: bytePos,
          byteLength: lineBytes + 1,
        });
      }
    }
    bytePos += lineBytes + 1; // +1 for newline separator
  }

  if (entries.length === 0) {
    throw new Error('JSONL file has no parseable entries in tail');
  }

  // Find truncation point (index in entries array)
  let keepUpTo: number;

  switch (strategy) {
    case 'last_exchange':
      keepUpTo = findLastExchangeStart(entries);
      break;
    case 'last_successful_tool':
      keepUpTo = findLastSuccessfulToolEnd(entries);
      break;
    case 'n_exchanges_back':
      keepUpTo = findNExchangesBack(entries, nExchanges);
      break;
    default:
      throw new Error(`Unknown truncation strategy: ${strategy}`);
  }

  // Safety: never truncate to nothing
  if (keepUpTo <= 0) keepUpTo = 1;

  // If we're keeping everything in the tail, nothing to truncate
  if (keepUpTo >= entries.length) {
    // Create backup anyway for consistency, but don't truncate
    const backupPath = `${jsonlPath}.bak.${Date.now()}`;
    fs.copyFileSync(jsonlPath, backupPath);
    return {
      originalLines: totalLinesInTail,
      truncatedLines: totalLinesInTail,
      removedLines: 0,
      backupPath,
      strategy,
    };
  }

  // Calculate the byte offset to truncate at
  const truncateAtByte = entries[keepUpTo].byteOffset;

  // Create backup before truncating
  const backupPath = `${jsonlPath}.bak.${Date.now()}`;
  fs.copyFileSync(jsonlPath, backupPath);

  // Truncate the file at the byte offset
  fs.truncateSync(jsonlPath, truncateAtByte);

  const removedLines = entries.length - keepUpTo;

  return {
    originalLines: totalLinesInTail + (readStart > 0 ? -1 : 0), // approximate if tail-only
    truncatedLines: keepUpTo,
    removedLines,
    backupPath,
    strategy,
  };
}

// ============================================================================
// Truncation Point Finders
// ============================================================================

/**
 * Find the start of the last exchange (assistant message that may have tool_use).
 * Removes the last assistant message and any following entries.
 */
function findLastExchangeStart(entries: TailEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i].parsed;
    if (entry && entry.type === 'assistant') {
      return i;
    }
  }
  return entries.length;
}

/**
 * Find the end of the last complete tool exchange (tool_use followed by tool_result).
 * Keeps up to and including the last successful tool_result.
 */
function findLastSuccessfulToolEnd(entries: TailEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i].parsed;
    if (!entry) continue;

    if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
      const hasSuccessfulResult = entry.message.content.some(
        (b: any) => b.type === 'tool_result' && !b.is_error
      );
      if (hasSuccessfulResult) {
        return i + 1;
      }
    }
  }
  return 1;
}

/**
 * Remove the last N complete exchanges (assistant + tool_result pairs).
 */
function findNExchangesBack(entries: TailEntry[], n: number): number {
  let exchangesFound = 0;
  let cutPoint = entries.length;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i].parsed;
    if (!entry) continue;

    if (entry.type === 'assistant') {
      exchangesFound++;
      if (exchangesFound >= n) {
        cutPoint = i;
        break;
      }
    }
  }

  return cutPoint;
}

/**
 * Validate that a JSONL file contains valid entries.
 * Uses tail-scan — reads last 256KB rather than the full file.
 */
export function validateJsonl(jsonlPath: string): { valid: number; invalid: number } {
  const stat = fs.statSync(jsonlPath);
  if (stat.size === 0) return { valid: 0, invalid: 0 };

  const TAIL_BYTES = 256 * 1024;
  const readStart = Math.max(0, stat.size - TAIL_BYTES);

  const fd = fs.openSync(jsonlPath, 'r');
  let tailContent: string;
  try {
    const buffer = Buffer.alloc(Math.min(TAIL_BYTES, stat.size));
    fs.readSync(fd, buffer, 0, buffer.length, readStart);
    tailContent = buffer.toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }

  const lines = tailContent.split('\n').filter(line => line.trim().length > 0);
  // Skip first line if we started mid-file
  const startIdx = readStart > 0 ? 1 : 0;

  let valid = 0;
  let invalid = 0;

  for (let i = startIdx; i < lines.length; i++) {
    try {
      JSON.parse(lines[i]);
      valid++;
    } catch { // @silent-fallback-ok — counting invalid lines is the purpose of this function
      invalid++;
    }
  }

  return { valid, invalid };
}
