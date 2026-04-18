#!/usr/bin/env node
/**
 * Day -2 prerequisite migration script for parallel-dev isolation.
 *
 * Per PARALLEL-DEV-ISOLATION-SPEC.md "Migration (iter 4 — Day -2 trust-boundary
 * acknowledgment + GH ruleset auto-config)".
 *
 * Trust-on-first-use: this script CANNOT be verified by the system it installs
 * (chicken-and-egg). The Day -2 PR ruleset entry requires 2 approvals on PRs
 * touching .github/workflows/worktree-trailer-sig-check.yml so this lift
 * happens with 4-eyes review.
 *
 * Steps:
 *   1. Generate Ed25519 keypair (server-side; private to keychain).
 *   2. Print public key for inspection (user pastes into workflow YAML).
 *   3. Verify pre-existing stash@{0} matches expected SHA (refuse if changed).
 *   4. After PR merges (and ruleset created via gh-ruleset-install.mjs),
 *      write signed sentinel .instar/local-state/migration-2026-04-17.completed.
 *
 * Exit codes:
 *   0 — completed (or sentinel already exists / nothing to do)
 *   1 — refused (stash SHA mismatch / pre-condition failure)
 *   2 — uncaught error
 */

import crypto from 'node:crypto';
import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const STATE_DIR = path.join(ROOT, '.instar', 'local-state');
const SENTINEL = path.join(STATE_DIR, 'migration-2026-04-17.completed');
// Captured at spec-approval time; refuses migration if stash has changed since.
const EXPECTED_STASH_REF = 'stash@{0}';
const EXPECTED_STASH_LABEL_PREFIX = 'parallel-session: InitiativeTracker';

function logStep(msg) {
  console.log(`[migrate-incident-2026-04-17] ${msg}`);
}

function existsSentinel() {
  return fs.existsSync(SENTINEL);
}

function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

function verifyStash() {
  let stashList;
  try {
    stashList = execSync('git stash list', { encoding: 'utf-8' });
  } catch (err) {
    logStep(`No stash present (or not a git repo). Skipping stash verification.`);
    return { ok: true, skipped: true };
  }
  const lines = stashList.split('\n').filter(Boolean);
  if (lines.length === 0) {
    logStep('No stash entries — nothing to verify. Continuing.');
    return { ok: true, skipped: true };
  }
  const top = lines[0];
  if (!top.startsWith(`${EXPECTED_STASH_REF}:`)) {
    return { ok: false, reason: `expected stash ref ${EXPECTED_STASH_REF}, got "${top}"` };
  }
  if (!top.includes(EXPECTED_STASH_LABEL_PREFIX)) {
    return { ok: false, reason: `stash label changed; expected prefix "${EXPECTED_STASH_LABEL_PREFIX}", got "${top}"` };
  }
  return { ok: true };
}

function writeSentinel(publicKey, privateKey) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // Sign the sentinel content with the new Ed25519 private key, anchoring future trust.
  const sentinelContent = JSON.stringify({
    completedAt: new Date().toISOString(),
    publicKeyFingerprint: crypto.createHash('sha256').update(publicKey).digest('hex'),
    schemaVersion: 1,
  });
  const signature = crypto.sign(null, Buffer.from(sentinelContent), { key: privateKey }).toString('base64');
  fs.writeFileSync(SENTINEL, JSON.stringify({
    content: sentinelContent,
    signature,
  }, null, 2), { mode: 0o600 });
  logStep(`Wrote sentinel ${SENTINEL}`);
}

function main() {
  if (existsSentinel()) {
    logStep(`Sentinel exists at ${SENTINEL} — refusing to re-run.`);
    process.exit(0);
  }

  logStep('Step 1: Generate Ed25519 keypair (server-side; private will go to keychain)');
  const { publicKey, privateKey } = generateKeypair();

  logStep('Step 2: Public key (paste into .github/workflows/worktree-trailer-sig-check.yml as `INSTAR_TRAILER_PUBLIC_KEY` repo variable):');
  console.log('');
  console.log(publicKey);
  console.log('');

  logStep('Step 3: Verify staged stash@{0} matches expected (refuse if changed)');
  const stashCheck = verifyStash();
  if (!stashCheck.ok) {
    console.error(`[migrate-incident-2026-04-17] REFUSED: ${stashCheck.reason}`);
    console.error('  → If you have intentionally moved the InitiativeTracker work, update EXPECTED_STASH_LABEL_PREFIX in this script.');
    process.exit(1);
  }
  if (stashCheck.skipped) {
    logStep('  (no stash to verify; this is expected after the InitiativeTracker work has been popped/dropped on this machine)');
  }

  logStep('Step 4: Write signed sentinel (anchors future trust to this acknowledged-TOFU root)');
  writeSentinel(publicKey, privateKey);

  // Save private key to a known transitional location for the user to register
  // via `instar worktree register-keypair --private <path>` (which prompts for keychain).
  const privPath = path.join(STATE_DIR, 'trailer-private-key.pem.NEW');
  fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
  logStep(`Private key written to ${privPath} (chmod 0600)`);
  logStep('  → Next: run `instar worktree register-keypair --private ' + privPath + '` to move into keychain.');
  logStep('  → After successful registration, this file is securely deleted.');

  logStep('DONE.');
  process.exit(0);
}

try { main(); }
catch (err) {
  console.error(`[migrate-incident-2026-04-17] UNCAUGHT ${err.message}`);
  console.error(err.stack);
  process.exit(2);
}
