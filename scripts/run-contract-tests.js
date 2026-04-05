#!/usr/bin/env node
/**
 * Run contract tests and record evidence of the result.
 *
 * This wrapper runs `vitest run --config vitest.contract.config.ts` and,
 * if all tests pass, writes a timestamped evidence file that the pre-push
 * gate accepts as proof of real API verification.
 *
 * The evidence file expires after 4 hours — you can't run contract tests
 * on Monday and ship on Friday. Fresh changes require fresh verification.
 *
 * Usage:
 *   SLACK_CONTRACT_BOT_TOKEN=xoxb-... node scripts/run-contract-tests.js
 *   # or via npm:
 *   SLACK_CONTRACT_BOT_TOKEN=xoxb-... npm run test:contract
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EVIDENCE_PATH = path.join(ROOT, '.contract-test-evidence.json');

// Check if any contract test token is set
const hasSlackToken = !!process.env.SLACK_CONTRACT_BOT_TOKEN;

if (!hasSlackToken) {
  console.log('\n  ⚠️  No contract test tokens found.');
  console.log('  Set SLACK_CONTRACT_BOT_TOKEN to run Slack contract tests.\n');
  console.log('  Without tokens, contract tests are skipped — no evidence is recorded.\n');
  process.exit(1);
}

console.log('\n  🔬 Running contract tests against live APIs...\n');

try {
  execSync('npx vitest run --config vitest.contract.config.ts', {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env },
  });

  // Tests passed — write evidence
  const evidence = {
    passed: true,
    timestamp: Date.now(),
    date: new Date().toISOString(),
    suite: 'contract',
    tokens: {
      slack: hasSlackToken ? 'present' : 'absent',
    },
  };

  fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + '\n');
  console.log(`\n  ✅ Contract test evidence recorded: ${EVIDENCE_PATH}`);
  console.log(`  Valid for 4 hours (until ${new Date(Date.now() + 4 * 60 * 60 * 1000).toLocaleTimeString()})\n`);

} catch (err) {
  // Tests failed — write failure evidence (so we don't accidentally accept stale success)
  const evidence = {
    passed: false,
    timestamp: Date.now(),
    date: new Date().toISOString(),
    suite: 'contract',
    error: 'Contract tests failed — see output above',
  };

  fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + '\n');
  console.log(`\n  ❌ Contract tests FAILED. Evidence recorded as failure.`);
  console.log(`  Fix the issues above before pushing.\n`);
  process.exit(1);
}
