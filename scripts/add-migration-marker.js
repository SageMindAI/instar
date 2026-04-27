#!/usr/bin/env node
/**
 * add-migration-marker.js — stamp every pre-existing direct destructive
 * git/fs callsite with `// safe-git-allow: incremental-migration` so the
 * lint rule (`scripts/lint-no-direct-destructive.js`) accepts the existing
 * codebase during the transitional period.
 *
 * Idempotent. Running it multiple times is safe — already-marked callsites
 * are skipped. After PR #2 migrates every callsite through SafeGitExecutor /
 * SafeFsExecutor, this script can be deleted along with the marker support
 * in the lint rule.
 *
 * Mechanism:
 *   1. Run the lint rule with markers temporarily disabled to collect every
 *      pre-existing violation as (file, line) pairs.
 *   2. For each unique line in each file, prepend a `// safe-git-allow:
 *      incremental-migration` comment matching the indentation of the
 *      flagged line. Skip if the marker already exists immediately above
 *      or on the same line.
 *   3. Write the file back.
 *
 * Usage:
 *   node scripts/add-migration-marker.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const MARKER = '// safe-git-allow: incremental-migration';
const MARKER_RE = /\/\/\s*safe-git-allow:\s*incremental-migration\b/;

function collectViolations() {
  // Run lint with the marker disabled by setting an env override the lint
  // rule respects. Easier: pass --no-marker-suppression. The lint rule
  // doesn't support that flag, so instead we set INSTAR_DISABLE_MIGRATION_MARKER=1
  // and have the lint rule honor it.
  const env = { ...process.env, INSTAR_DISABLE_MIGRATION_MARKER: '1' };
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/lint-no-direct-destructive.js')], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
  // Lint exits 1 on violations. We parse stderr regardless.
  const stderr = result.stderr || '';

  // Output format from lint:
  //   <relpath>:<line>:<col>
  //     <message>
  const violations = [];
  const lines = stderr.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s+([^:\s][^:]*):(\d+):(\d+)\s*$/);
    if (m) {
      violations.push({ file: m[1], line: parseInt(m[2], 10) });
    }
  }
  return violations;
}

function applyMarkers(violations) {
  // Group by file.
  const byFile = new Map();
  for (const v of violations) {
    if (!byFile.has(v.file)) byFile.set(v.file, new Set());
    byFile.get(v.file).add(v.line);
  }

  let marked = 0;
  let skipped = 0;
  for (const [relFile, lineSet] of byFile) {
    const full = path.resolve(ROOT, relFile);
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const orig = text.split('\n');

    // Sort target lines DESCENDING so insertions don't shift later targets.
    const targets = Array.from(lineSet).sort((a, b) => b - a);
    const out = orig.slice();

    for (const lineNum of targets) {
      const idx = lineNum - 1; // 0-based
      if (idx < 0 || idx >= out.length) continue;
      const targetLine = out[idx];
      // Skip if marker already on the target line or on the line above.
      if (MARKER_RE.test(targetLine)) { skipped++; continue; }
      if (idx - 1 >= 0 && MARKER_RE.test(out[idx - 1])) { skipped++; continue; }

      // Match the indentation of the target line.
      const indentMatch = targetLine.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1] : '';
      out.splice(idx, 0, `${indent}${MARKER}`);
      marked++;
    }
    fs.writeFileSync(full, out.join('\n'));
  }
  return { marked, skipped };
}

function main() {
  const violations = collectViolations();
  if (violations.length === 0) {
    console.log('No violations detected — nothing to mark.');
    return 0;
  }
  console.log(`Found ${violations.length} flagged callsites.`);
  const { marked, skipped } = applyMarkers(violations);
  console.log(`Stamped ${marked} new marker(s); ${skipped} already had a marker.`);
  return 0;
}

process.exit(main());
