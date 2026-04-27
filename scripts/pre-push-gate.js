#!/usr/bin/env node
/**
 * Fast pre-push gate — runs BEFORE the test suite to catch common issues early.
 *
 * Checks:
 *   1. NEXT.md exists and has required sections (saves ~4min if missing)
 *   2. package.json version was incremented from the latest published guide
 *
 * This is intentionally lightweight — no imports from src/, no TypeScript,
 * no test framework. Just reads files and exits.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const upgradesDir = path.join(ROOT, 'upgrades');
const nextPath = path.join(ROOT, 'upgrades', 'NEXT.md');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const version = pkg.version;

const REQUIRED_SECTIONS = [
  '## What Changed',
  '## What to Tell Your User',
  '## Summary of New Capabilities',
];

const MIN_LENGTH = 200;

let errors = [];
let warnings = [];

// ── 1. NEXT.md validation ─────────────────────────────────────────────

const versionedGuidePath = path.join(upgradesDir, `${version}.md`);
const versionedGuideExists = fs.existsSync(versionedGuidePath);
const nextExists = fs.existsSync(nextPath);

if (versionedGuideExists) {
  // Already finalized — validate the versioned guide instead
  const content = fs.readFileSync(versionedGuidePath, 'utf-8');
  for (const section of REQUIRED_SECTIONS) {
    if (!content.includes(section)) {
      errors.push(`${version}.md missing "${section}" section`);
    }
  }
  if (content.length < MIN_LENGTH) {
    errors.push(`${version}.md is too short (${content.length} chars, need ${MIN_LENGTH}+)`);
  }
} else if (nextExists) {
  const content = fs.readFileSync(nextPath, 'utf-8');

  for (const section of REQUIRED_SECTIONS) {
    if (!content.includes(section)) {
      errors.push(`NEXT.md missing "${section}" section`);
    }
  }

  if (content.length < MIN_LENGTH) {
    errors.push(`NEXT.md is too short (${content.length} chars, need ${MIN_LENGTH}+)`);
  }

  // Check for unfilled template placeholders
  if (content.includes('<!-- Describe what changed')) {
    errors.push(`NEXT.md "What Changed" still has template placeholder`);
  }
  if (content.includes('[Feature name]') || content.includes('[Brief, friendly description')) {
    errors.push(`NEXT.md "What to Tell Your User" still has template placeholder`);
  }
  if (content.includes('[Capability]') && content.includes('[Endpoint, command')) {
    errors.push(`NEXT.md "Summary of New Capabilities" still has template placeholder`);
  }
} else {
  errors.push(
    `No upgrade guide found. Create upgrades/NEXT.md with sections: ${REQUIRED_SECTIONS.join(', ')}`
  );
}

// ── 2. Version increment check ────────────────────────────────────────

// Find the latest published version from existing upgrade guides
const publishedVersions = fs.existsSync(upgradesDir)
  ? fs.readdirSync(upgradesDir)
      .map(f => /^(\d+)\.(\d+)\.(\d+)\.md$/.exec(f))
      .filter(Boolean)
      .map(m => ({
        str: `${m[1]}.${m[2]}.${m[3]}`,
        parts: [+m[1], +m[2], +m[3]],
      }))
      .sort((a, b) => {
        for (let i = 0; i < 3; i++) {
          if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i];
        }
        return 0;
      })
  : [];

const latestPublished = publishedVersions.length > 0
  ? publishedVersions[publishedVersions.length - 1]
  : null;

if (latestPublished) {
  const [curMaj, curMin, curPatch] = version.split('.').map(Number);
  const [pubMaj, pubMin, pubPatch] = latestPublished.parts;

  if (curMaj === pubMaj && curMin === pubMin && curPatch === pubPatch) {
    warnings.push(
      `package.json version (${version}) matches the latest published guide (${latestPublished.str}). ` +
      `Did you forget to bump the version? Run: npm version patch|minor|major`
    );
  } else if (
    curMaj < pubMaj ||
    (curMaj === pubMaj && curMin < pubMin) ||
    (curMaj === pubMaj && curMin === pubMin && curPatch < pubPatch)
  ) {
    errors.push(
      `package.json version (${version}) is LOWER than the latest published guide (${latestPublished.str}). ` +
      `Version must be incremented, not decremented.`
    );
  }
}

// ── 3. Test file change check ─────────────────────────────────────────
// If source files changed, at least one test file should also change.
// This prevents shipping code changes without regression tests.

try {
  const { execSync } = await import('node:child_process');
  // Get files changed since the remote tracking branch
  const remoteBranch = execSync('git rev-parse --abbrev-ref @{u} 2>/dev/null || echo origin/main', { encoding: 'utf-8' }).trim();
  const changedFiles = execSync(`git diff --name-only ${remoteBranch}...HEAD 2>/dev/null || git diff --name-only HEAD~1 2>/dev/null`, { encoding: 'utf-8' })
    .trim()
    .split('\n')
    .filter(Boolean);

  const srcChanges = changedFiles.filter(f => f.startsWith('src/') && f.endsWith('.ts'));
  const testChanges = changedFiles.filter(f => f.includes('tests/') && f.endsWith('.test.ts'));

  if (srcChanges.length > 0 && testChanges.length === 0) {
    warnings.push(
      `${srcChanges.length} source file(s) changed but no test files were added or modified. ` +
      `Every code change should include regression tests. Files changed:\n` +
      srcChanges.slice(0, 5).map(f => `      • ${f}`).join('\n') +
      (srcChanges.length > 5 ? `\n      • ...and ${srcChanges.length - 5} more` : '')
    );
  }
  // ── 4. Adapter contract test gate ─────────────────────────────────────
  // If messaging adapter source files changed, require contract test evidence.
  // This prevents shipping integration code verified only by mocked unit tests.
  // The evidence file is created by `npm run test:contract` when tests pass.

  const ADAPTER_PATHS = [
    'src/messaging/slack/',
    'src/messaging/telegram/',
    'src/messaging/whatsapp/',
    'src/messaging/imessage/',
  ];

  const adapterChanges = srcChanges.filter(f =>
    ADAPTER_PATHS.some(prefix => f.startsWith(prefix))
  );

  if (adapterChanges.length > 0) {
    const evidencePath = path.join(ROOT, '.contract-test-evidence.json');
    let evidenceValid = false;

    if (fs.existsSync(evidencePath)) {
      try {
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf-8'));
        const ageMs = Date.now() - (evidence.timestamp || 0);
        const maxAgeMs = 4 * 60 * 60 * 1000; // 4 hours

        if (ageMs < maxAgeMs && evidence.passed === true) {
          evidenceValid = true;
          const ageMin = Math.round(ageMs / 60000);
          console.log(`  ✅ Contract tests passed ${ageMin}m ago (${evidence.suite})`);
        } else if (ageMs >= maxAgeMs) {
          console.log(`  ⏰ Contract test evidence is stale (${Math.round(ageMs / 3600000)}h old)`);
        } else if (!evidence.passed) {
          console.log(`  ❌ Contract test evidence shows FAILURE`);
        }
      } catch {
        // Corrupt evidence file
      }
    }

    if (!evidenceValid) {
      errors.push(
        `Adapter source files changed but no recent contract test evidence found.\n` +
        `      Adapter files modified:\n` +
        adapterChanges.slice(0, 5).map(f => `        • ${f}`).join('\n') +
        (adapterChanges.length > 5 ? `\n        • ...and ${adapterChanges.length - 5} more` : '') +
        `\n\n      Run contract tests against the REAL API before pushing:\n` +
        `        SLACK_CONTRACT_BOT_TOKEN=xoxb-... npm run test:contract\n\n` +
        `      This ensures your changes work against the actual API, not just mocked responses.\n` +
        `      Contract test evidence expires after 4 hours.`
      );
    }
  }
} catch {
  // Git commands may fail in CI or detached HEAD — skip gracefully
}

// ── 5. Side-effects review artifact ───────────────────────────────────
// If the upgrade notes claim a fix or feature (anything that would require
// an Evidence section), a matching side-effects review artifact must exist
// in upgrades/side-effects/. This enforces the /instar-dev process at push
// time — the pre-commit hook catches it earlier per-commit, this is the
// release-level re-check.
//
// Skipped in CI: contributor branches may be based on a commit predating the
// artifact being added to main. The enforcement point is the local pre-push
// hook; CI can't retroactively add artifacts.
if (!process.env.CI) {
  const FIX_PATTERNS = [
    /\bfix(es|ed|ing)?\b/i,
    /\bbug(fix)?\b/i,
    /\bregression\b/i,
    /\bresolves?\b/i,
    /\bresolved\b/i,
    /\bcrashes?\b/i,
    /\bcrashed\b/i,
    /\bcrashing\b/i,
    /\bbroken\b/i,
    /\bstall(s|ed|ing)?\b/i,
    /\bfeature\b/i,
    /\badd(s|ed|ing)?\b/i,
    /\bnew\b/i,
  ];

  const guidePath = versionedGuideExists ? versionedGuidePath : nextPath;
  if (fs.existsSync(guidePath)) {
    const guideContent = fs.readFileSync(guidePath, 'utf-8');
    // Extract "## What Changed" section
    const whatChangedMatch = guideContent.match(/## What Changed\s*([\s\S]*?)(?=\n##\s|$)/);
    const whatChanged = whatChangedMatch ? whatChangedMatch[1] : '';

    const qualifies = FIX_PATTERNS.some((p) => p.test(whatChanged));

    if (qualifies) {
      const sideEffectsDir = path.join(ROOT, 'upgrades', 'side-effects');
      const artifactName = versionedGuideExists ? `${version}.md` : null;
      let artifactFound = false;

      if (fs.existsSync(sideEffectsDir)) {
        const files = fs.readdirSync(sideEffectsDir).filter((f) => f.endsWith('.md'));
        if (artifactName) {
          artifactFound = files.includes(artifactName);
        } else {
          // For NEXT.md, any fresh artifact from the last 24h counts.
          // The expectation is that during release cut, NEXT.md -> <version>.md
          // rename will pair with the artifact rename as well.
          const recent = files.filter((f) => {
            const stat = fs.statSync(path.join(sideEffectsDir, f));
            return Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000;
          });
          artifactFound = recent.length > 0;
        }
      }

      if (!artifactFound) {
        errors.push(
          `Upgrade notes claim a fix/feature but no matching side-effects review artifact found in upgrades/side-effects/. ` +
          `Every change qualifying for review must ship with an artifact produced via the /instar-dev skill. ` +
          `See skills/instar-dev/SKILL.md and docs/signal-vs-authority.md.`
        );
      }
    }
  }
}

// ── Destructive-tool containment lint (full repo) ─────────────────────
//
// Runs the lint-no-direct-destructive AST scanner across the whole repo on
// every push. Pre-commit only runs it over staged files; pre-push catches
// commits that landed before the rule existed (or before the marker scheme
// expired). Fails the push on any violation.
//
// Wired here rather than in .husky/pre-push because the husky hook files
// are managed by a sandboxed flow that this gate can extend.

try {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts/lint-no-direct-destructive.js')],
    { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (result.status !== 0) {
    errors.push('lint-no-direct-destructive: violations detected (see output above)');
  }
} catch (err) {
  warnings.push(`lint-no-direct-destructive failed to run: ${err.message}`);
}

// ── Report ────────────────────────────────────────────────────────────

if (errors.length > 0 || warnings.length > 0) {
  console.log('\n  Pre-Push Gate');
  console.log(`  ${'─'.repeat(40)}`);
}

if (errors.length > 0) {
  console.log('');
  for (const e of errors) {
    console.log(`  ❌ ${e}`);
  }
  console.log('\n  Fix these before pushing. This saves ~4 minutes vs. discovering them in the test suite.\n');
  process.exit(1);
}

if (warnings.length > 0) {
  console.log('');
  for (const w of warnings) {
    console.log(`  ⚠️  ${w}`);
  }
  console.log('');
}

// If we get here, gate passed — print nothing (let the test suite output take over)
