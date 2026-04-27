/**
 * JSONL Size-Based Rotation — prevents unbounded JSONL file growth.
 *
 * Born from a 64GB doctor-dead-letter.jsonl incident: append-only JSONL files
 * with no size limit will eventually fill the disk under sustained failure loops.
 *
 * Design:
 *   - Size check via fs.statSync() — O(1), no file read needed
 *   - When over limit: read lines, keep last N%, atomic write (tmp + rename)
 *   - Never throws — rotation failure is non-fatal (the append that triggered
 *     it will still succeed; we just couldn't trim the file this time)
 *   - Lazy rotation — called before/after append, no background timers
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Types ────────────────────────────────────────────────────────────

export interface RotationOptions {
  /** Maximum file size in bytes before rotation triggers. Default: 10MB */
  maxBytes?: number;
  /** Fraction of lines to keep after rotation (0.0–1.0). Default: 0.75 */
  keepRatio?: number;
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_KEEP_RATIO = 0.75;

// ── Public API ───────────────────────────────────────────────────────

/**
 * Check if a JSONL file exceeds its size limit, and if so, rotate it
 * by keeping only the most recent lines.
 *
 * @returns true if rotation occurred, false otherwise
 */
export function maybeRotateJsonl(filePath: string, options?: RotationOptions): boolean {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const keepRatio = Math.max(0, Math.min(1, options?.keepRatio ?? DEFAULT_KEEP_RATIO));

  try {
    // O(1) size check — no file read
    const stat = fs.statSync(filePath);
    if (stat.size <= maxBytes) {
      return false;
    }

    // File is over the limit — read, truncate, write atomically
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    if (lines.length === 0) {
      return false;
    }

    const keepCount = Math.max(1, Math.ceil(lines.length * keepRatio));
    const keptLines = lines.slice(-keepCount);

    // Atomic write: tmp file + rename
    const tmpPath = filePath + '.rotation-tmp';
    fs.writeFileSync(tmpPath, keptLines.join('\n') + '\n');
    fs.renameSync(tmpPath, filePath);

    return true;
  } catch {
    // Rotation failure is non-fatal — the file continues to grow until
    // the next successful rotation attempt. Clean up tmp if it exists.
    try {
      const tmpPath = filePath + '.rotation-tmp';
      if (fs.existsSync(tmpPath)) {
        // safe-git-allow: incremental-migration
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Best effort cleanup
    }
    return false;
  }
}
