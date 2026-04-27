#!/usr/bin/env node
/**
 * Pre-publish contract evidence check.
 *
 * If any messaging adapter source files have been modified since the last
 * published version, this script requires fresh contract test evidence.
 *
 * This is the FINAL gate before `npm publish`. It catches the exact scenario
 * that burned us: shipping integration code verified only by mocked unit tests.
 *
 * Bypass (emergency only): SKIP_CONTRACT_CHECK=1 npm publish
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

if (process.env.SKIP_CONTRACT_CHECK === '1') {
  console.log('  ⚠️  SKIP_CONTRACT_CHECK=1 — bypassing contract evidence check');
  console.log('  You are publishing adapter changes WITHOUT verified API testing.\n');
  process.exit(0);
}

const ADAPTER_PATHS = [
  'src/messaging/slack/',
  'src/messaging/telegram/',
  'src/messaging/whatsapp/',
  'src/messaging/imessage/',
];

// Check if adapter files changed since last tag
let adapterChanges = [];
try {
  // Find files changed since the last npm version tag
  // safe-git-allow: incremental-migration
  const lastTag = execSync('git describe --tags --abbrev=0 2>/dev/null || echo ""', {
    encoding: 'utf-8',
    cwd: ROOT,
  }).trim();

  const diffBase = lastTag || 'HEAD~10';
  // safe-git-allow: incremental-migration
  const changedFiles = execSync(`git diff --name-only ${diffBase}...HEAD 2>/dev/null || echo ""`, {
    encoding: 'utf-8',
    cwd: ROOT,
  }).trim().split('\n').filter(Boolean);

  adapterChanges = changedFiles.filter(f =>
    ADAPTER_PATHS.some(prefix => f.startsWith(prefix))
  );
} catch {
  // If git fails, be conservative — check for evidence anyway
  adapterChanges = ['(unable to determine — checking evidence anyway)'];
}

if (adapterChanges.length === 0) {
  // No adapter changes — no contract evidence required
  process.exit(0);
}

console.log(`\n  📋 Adapter files modified (${adapterChanges.length}):`);
adapterChanges.slice(0, 5).forEach(f => console.log(`     • ${f}`));
if (adapterChanges.length > 5) console.log(`     • ...and ${adapterChanges.length - 5} more`);

// Check evidence file
const evidencePath = path.join(ROOT, '.contract-test-evidence.json');

if (!fs.existsSync(evidencePath)) {
  console.log('\n  ❌ No contract test evidence found.');
  console.log('  You MUST run contract tests before publishing adapter changes:\n');
  console.log('    SLACK_CONTRACT_BOT_TOKEN=xoxb-... npm run test:contract\n');
  console.log('  This verifies your changes work against the REAL API.');
  console.log('  Emergency bypass: SKIP_CONTRACT_CHECK=1 npm publish\n');
  process.exit(1);
}

try {
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf-8'));
  const ageMs = Date.now() - (evidence.timestamp || 0);
  const maxAgeMs = 4 * 60 * 60 * 1000; // 4 hours

  if (!evidence.passed) {
    console.log('\n  ❌ Contract tests FAILED on their last run.');
    console.log('  Fix the failures and re-run: npm run test:contract\n');
    process.exit(1);
  }

  if (ageMs > maxAgeMs) {
    const hoursAgo = Math.round(ageMs / 3600000);
    console.log(`\n  ❌ Contract test evidence is stale (${hoursAgo}h old, max 4h).`);
    console.log('  Re-run: SLACK_CONTRACT_BOT_TOKEN=xoxb-... npm run test:contract\n');
    process.exit(1);
  }

  const minutesAgo = Math.round(ageMs / 60000);
  console.log(`\n  ✅ Contract tests passed ${minutesAgo}m ago — evidence valid\n`);

} catch (err) {
  console.log('\n  ❌ Contract evidence file is corrupt. Re-run: npm run test:contract\n');
  process.exit(1);
}
