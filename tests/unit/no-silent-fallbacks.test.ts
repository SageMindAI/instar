/**
 * Infrastructure test — No Silent Fallbacks.
 *
 * Ensures that catch blocks with fallback behavior in server-side runtime code
 * report degradation via DegradationReporter. Prevents new silent fallbacks.
 *
 * Scope: Only scans server-side runtime code (server.ts, monitoring/*, messaging/*, memory/*).
 * CLI commands, init scripts, and one-shot utilities are excluded — they exit on error
 * rather than falling back silently.
 *
 * The test uses a ratchet pattern: it tracks a baseline count of known silent fallbacks.
 * New code must not add more. As existing ones get fixed, the baseline decreases.
 *
 * Born from the insight: "Fallbacks should only and always be associated
 * with a bug report back to Instar." — Justin, 2026-02-25
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC_DIR = path.resolve(__dirname, '../../src');

// Server-side runtime directories — code that runs continuously and needs degradation reporting.
// CLI commands (commands/init.ts, cli.ts) and setup scripts are excluded because they
// terminate on error (process.exit) rather than continuing with degraded behavior.
const RUNTIME_DIRS = [
  'server',
  'monitoring',
  'messaging',
  'memory',
  'scheduler',
  'core',
];

// Files to scan within commands/ — only the server entry point runs long-term
const RUNTIME_COMMAND_FILES = [
  'commands/server.ts',
];

/**
 * Get all TypeScript source files in runtime directories.
 */
function getRuntimeFiles(): string[] {
  const files: string[] = [];

  for (const dir of RUNTIME_DIRS) {
    const dirPath = path.join(SRC_DIR, dir);
    if (!fs.existsSync(dirPath)) continue;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.types.ts')) {
        files.push(path.join(dirPath, entry.name));
      }
    }
  }

  for (const relPath of RUNTIME_COMMAND_FILES) {
    const fullPath = path.join(SRC_DIR, relPath);
    if (fs.existsSync(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

interface CatchBlock {
  file: string;
  line: number;
  content: string;
}

/**
 * Extract catch blocks from a file.
 */
function extractCatchBlocks(filePath: string): CatchBlock[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const blocks: CatchBlock[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (/\}\s*catch\s*(\(|{)|\bcatch\s*(\(|{)/.test(lines[i])) {
      const blockLines = lines.slice(i, Math.min(i + 20, lines.length));
      blocks.push({
        file: path.relative(SRC_DIR, filePath),
        line: i + 1,
        content: blockLines.join('\n'),
      });
    }
  }

  return blocks;
}

/**
 * Determine if a catch block is a TRUE fallback that needs degradation reporting.
 *
 * A catch block is a fallback if it:
 * 1. Continues execution (no throw, no process.exit)
 * 2. Returns a default/empty value OR sets state to a degraded value
 * 3. Has a comment indicating fallback behavior
 * 4. Is NOT already reporting degradation
 * 5. Is NOT explicitly exempted
 */
function isTrueFallback(block: CatchBlock): boolean {
  const { content } = block;

  // Not a fallback: re-throws
  if (/\bthrow\b/.test(content)) return false;

  // Not a fallback: exits process (CLI behavior, not server runtime)
  if (/process\.exit/.test(content)) return false;

  // Not a fallback: explicitly exempted
  if (/@silent-fallback-ok/.test(content)) return false;

  // Not a fallback: already reports degradation
  if (/DegradationReporter/.test(content)) return false;

  // Identify fallback patterns:

  // Pattern 1: Returns empty/default value — the function continues with degraded data
  const hasFallbackReturn = /return\s+(null|undefined|\[\]|0|''|""|false|{})/.test(content);

  // Pattern 2: Explicit fallback comment — developer acknowledged it's a fallback
  const hasExplicitFallbackComment = /\b(fall\s?back|degrade|non[\s-]?critical)\b/i.test(content);

  // Pattern 3: Sets a variable to degraded state
  const hasStateReset = /\w+\s*=\s*(undefined|null)\s*;/.test(content);

  return hasFallbackReturn || hasExplicitFallbackComment || hasStateReset;
}

describe('No Silent Fallbacks', () => {
  const runtimeFiles = getRuntimeFiles();
  const allCatchBlocks = runtimeFiles.flatMap(extractCatchBlocks);

  it('found runtime files to analyze', () => {
    expect(runtimeFiles.length).toBeGreaterThan(10);
  });

  it('found catch blocks to analyze', () => {
    expect(allCatchBlocks.length).toBeGreaterThan(20);
  });

  it('no new silent fallbacks beyond tracked baseline', () => {
    const silentFallbacks = allCatchBlocks.filter(isTrueFallback);

    // ═══════════════════════════════════════════════════════════
    // RATCHET BASELINE — only decrease this number, never increase.
    // When you fix a silent fallback (add DegradationReporter.report()
    // or add @silent-fallback-ok exemption), lower this number.
    // ═══════════════════════════════════════════════════════════
    const BASELINE = 21; // 10 CapabilityMapper + 1 TelegramAdapter + 1 JobScheduler + 6 TopicResumeMap + 3 new subsystems

    if (silentFallbacks.length > 0) {
      const report = silentFallbacks.map(fb =>
        `  ${fb.file}:${fb.line}`
      ).join('\n');

      console.warn(
        `\n[SILENT FALLBACKS] ${silentFallbacks.length} catch blocks need DegradationReporter:\n${report}\n`
      );
    }

    // Hard enforcement: count must not exceed baseline
    expect(silentFallbacks.length).toBeLessThanOrEqual(BASELINE);
  });

  it('DegradationReporter is imported in files that use it', () => {
    const filesWithReport: string[] = [];

    for (const filePath of runtimeFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.includes('DegradationReporter.getInstance().report(')) {
        filesWithReport.push(filePath);
        expect(content).toMatch(
          /import.*DegradationReporter/,
          `${path.relative(SRC_DIR, filePath)} uses DegradationReporter but doesn't import it`
        );
      }
    }

    // We wired DegradationReporter into 15+ files during the full audit
    expect(filesWithReport.length).toBeGreaterThanOrEqual(12);
  });

  it('DegradationReporter.ts exports required interface', () => {
    const reporterPath = path.join(SRC_DIR, 'monitoring', 'DegradationReporter.ts');
    expect(fs.existsSync(reporterPath)).toBe(true);

    const content = fs.readFileSync(reporterPath, 'utf-8');
    // Must export: getInstance, report, configure, connectDownstream, getEvents, hasDegradations
    expect(content).toContain('static getInstance()');
    expect(content).toContain('report(');
    expect(content).toContain('configure(');
    expect(content).toContain('connectDownstream(');
    expect(content).toContain('getEvents()');
    expect(content).toContain('hasDegradations()');
  });
});
