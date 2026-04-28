#!/usr/bin/env tsx
// safe-git-allow: ci-lint-walks-instar-source-history-by-design
/**
 * lint-template-sha-history.ts — Layer 7 CI lint.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § 7.
 *
 * Asserts that every historical SHIPPED `src/templates/scripts/
 * telegram-reply.sh` content (across the last N commits on `main`) is
 * either:
 *   - the current bundled template SHA, OR
 *   - in `PostUpdateMigrator.TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS`.
 *
 * Why: the migrator's prior-shipped set is the *only* mechanism that
 * upgrades existing on-disk relay scripts to the latest version
 * cleanly. If we ship a new template version without adding the
 * just-superseded SHA to the prior-shipped set, every previously
 * shipped agent gets a `relay-script-modified-locally` degradation
 * event on its next `instar update` — the same orphan-TODO failure
 * mode the original incident's spec called out.
 *
 * Strategy:
 *   1. Walk `git log --first-parent main -- src/templates/scripts/
 *      telegram-reply.sh` for the last N commits (default 100, well
 *      above the realistic count of historical telegram-reply.sh
 *      changes).
 *   2. For each commit, hash the file content at that commit.
 *   3. Compare against
 *      `PostUpdateMigrator.TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS ∪ {currentSha}`.
 *   4. Print the first missing SHA (if any) and exit non-zero.
 *
 * Runs under tsx in CI (`pnpm test:push` or as part of the gate). Direct
 * `git` access is intentional — this is a dev-time lint, never invoked
 * by the runtime, so the SafeGitExecutor source-tree guard does not
 * apply (the guard exists to keep *runtime* code from mucking with the
 * source tree; lint scripts run *over* the source tree).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostUpdateMigrator } from '../src/core/PostUpdateMigrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_REL = 'src/templates/scripts/telegram-reply.sh';
const TEMPLATE_ABS = path.join(REPO_ROOT, TEMPLATE_REL);
const HISTORY_LIMIT = 100;

interface LintResult {
  ok: boolean;
  missing: Array<{ sha: string; commit: string; subject: string }>;
  scannedCommits: number;
  currentSha: string;
}

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitBuffer(args: string[]): Buffer {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function listHistoricalCommits(): Array<{ commit: string; subject: string }> {
  // --first-parent restricts to mainline merges, avoiding feature-branch
  // intermediate commits that may have shipped unfinished SHAs.
  let raw: string;
  try {
    raw = git([
      'log',
      `-n${HISTORY_LIMIT}`,
      '--first-parent',
      '--format=%H%x09%s',
      '--',
      TEMPLATE_REL,
    ]);
  } catch (err) {
    // No git history (e.g., tarball install) — skip the lint with a
    // visible note. CI environments always have git, so this only
    // matters for offline dev clones.
    process.stderr.write(
      `lint-template-sha-history: git log unavailable, skipping (${err instanceof Error ? err.message : String(err)})\n`,
    );
    return [];
  }
  const commits: Array<{ commit: string; subject: string }> = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [commit, ...subjectParts] = trimmed.split('\t');
    commits.push({ commit, subject: subjectParts.join('\t') });
  }
  return commits;
}

export function lintTemplateShaHistory(): LintResult {
  // Compute current bundled-template SHA.
  const currentBuf = fs.readFileSync(TEMPLATE_ABS);
  const currentSha = createHash('sha256').update(currentBuf).digest('hex');

  // Allowed = prior-shipped set ∪ {current}.
  const allowed = new Set<string>(PostUpdateMigrator.TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS);
  allowed.add(currentSha);

  const commits = listHistoricalCommits();
  const missing: Array<{ sha: string; commit: string; subject: string }> = [];
  const seenShas = new Set<string>();

  for (const { commit, subject } of commits) {
    let buf: Buffer;
    try {
      buf = gitBuffer(['show', `${commit}:${TEMPLATE_REL}`]);
    } catch {
      // File didn't exist at this commit — skip.
      continue;
    }
    const sha = createHash('sha256').update(buf).digest('hex');
    if (seenShas.has(sha)) continue;
    seenShas.add(sha);
    if (!allowed.has(sha)) {
      missing.push({ sha, commit, subject });
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    scannedCommits: commits.length,
    currentSha,
  };
}

async function main(): Promise<void> {
  const result = lintTemplateShaHistory();

  if (result.ok) {
    process.stdout.write(
      `lint-template-sha-history: OK (scanned ${result.scannedCommits} commits, ` +
        `current sha256:${result.currentSha.slice(0, 12)}…)\n`,
    );
    process.exit(0);
  }

  process.stderr.write(
    `lint-template-sha-history: FAIL — ${result.missing.length} historical ` +
      `telegram-reply.sh SHA(s) are not in PostUpdateMigrator` +
      `.TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS (and don't match the current bundled ` +
      `template).\n\n`,
  );
  for (const { sha, commit, subject } of result.missing) {
    process.stderr.write(`  - ${sha}  ${commit.slice(0, 12)}  ${subject}\n`);
  }
  process.stderr.write(
    `\nFix: add the missing SHA(s) to PostUpdateMigrator` +
      `.TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS so existing agents on those ` +
      `versions migrate cleanly to the current template.\n`,
  );
  process.exit(1);
}

// Run when invoked directly. Importing this file (e.g., from the unit
// test) does not trigger the CLI.
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('lint-template-sha-history.ts') === true;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`lint-template-sha-history crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
