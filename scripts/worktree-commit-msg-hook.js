#!/usr/bin/env node
/**
 * worktree-commit-msg-hook.js — commit-msg hook for trailer signing.
 *
 * Invoked by git as: `worktree-commit-msg-hook.js <commit-msg-file>`.
 *
 * 1. Reads .instar/session-context.json (locates by walking up from cwd).
 * 2. Computes treeHash via `git write-tree` (HONORS $GIT_INDEX_FILE per K-fix).
 * 3. Reads parent SHA(s) via `git rev-parse HEAD` + merge-mode parents.
 * 4. POSTs to instar server `/commits/sign-trailer`.
 * 5. Appends 9 trailer lines via `git interpret-trailers --in-place`.
 *
 * Per spec section: "Commit trailer (iter 4 — Ed25519 + offline-friendly expiry + index-aware)".
 *
 * Exit codes:
 *   0 — trailer injected (commit proceeds)
 *   1 — failed; commit aborted with retry message
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';

const SIGN_TIMEOUT_MS = 5000;

function findSessionContext(startCwd) {
  let cwd = startCwd;
  for (let i = 0; i < 10; i++) {
    const ctx = path.join(cwd, '.instar', 'session-context.json');
    if (fs.existsSync(ctx)) return ctx;
    const parent = path.dirname(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }
  return null;
}

function gitParents(cwd) {
  // Determine if this is a merge: presence of $GIT_REFLOG_ACTION=merge OR MERGE_HEAD file
  // safe-git-allow: incremental-migration
  const gitDir = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-dir'], { encoding: 'utf-8' }).trim();
  const mergeHeadPath = path.join(cwd, gitDir, 'MERGE_HEAD');
  let parents = [];
  // Primary parent = current HEAD (or 0...0 for initial commit)
  try {
    // safe-git-allow: incremental-migration
    const head = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    parents.push(head);
  } catch {
    parents.push('0'.repeat(40));
  }
  if (fs.existsSync(mergeHeadPath)) {
    const extra = fs.readFileSync(mergeHeadPath, 'utf-8').trim().split('\n').filter(Boolean);
    parents.push(...extra);
  }
  return parents;
}

function gitWriteTree(cwd) {
  // K-fix: honor $GIT_INDEX_FILE (set by `git commit -a` and `git commit <file>`)
  const env = { ...process.env };
  // safe-git-allow: incremental-migration
  return execFileSync('git', ['-C', cwd, 'write-tree', '--missing-ok'], {
    encoding: 'utf-8', env,
  }).trim();
}

function postSign({ serverUrl, authToken, sessionId, fencingToken, treeHash, parents }) {
  return new Promise((resolve, reject) => {
    const url = new URL(serverUrl);
    const body = JSON.stringify({ sessionId, fencingToken, treeHash, parents });
    const req = http.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: '/commits/sign-trailer',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${authToken}`,
      },
      timeout: SIGN_TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`sign-trailer ${res.statusCode}: ${data}`));
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('sign-trailer timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const commitMsgFile = process.argv[2];
  if (!commitMsgFile) {
    console.error('worktree-commit-msg-hook: usage: <commit-msg-file>');
    process.exit(1);
  }

  // Skip merge commits authored by GitHub (they're verified at PR-merge time per spec)
  // and skip rebase/cherry-pick (commit-msg re-fires per spec — handled the same way)
  const cwd = process.cwd();
  const ctxPath = findSessionContext(cwd);
  if (!ctxPath) process.exit(0); // human commit, no session context

  const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf-8'));
  if (!ctx.sessionId || !ctx.fencingToken) process.exit(0);
  if (ctx.mode === 'read-only') {
    console.error('worktree-commit-msg-hook: BLOCK — read-only mode');
    process.exit(1);
  }

  const serverUrl = process.env.INSTAR_SERVER_URL;
  const authToken = process.env.INSTAR_AUTH_TOKEN;
  if (!serverUrl || !authToken) {
    console.error('worktree-commit-msg-hook: WARN — missing INSTAR_SERVER_URL; cannot sign trailer');
    process.exit(0);
  }

  let treeHash;
  try { treeHash = gitWriteTree(cwd); }
  catch (err) {
    console.error(`worktree-commit-msg-hook: BLOCK — write-tree failed: ${err.message}`);
    process.exit(1);
  }

  const parents = gitParents(cwd);

  let signed;
  try {
    signed = await postSign({
      serverUrl, authToken,
      sessionId: ctx.sessionId,
      fencingToken: ctx.fencingToken,
      treeHash,
      parents,
    });
  } catch (err) {
    console.error(`worktree-commit-msg-hook: BLOCK — sign-trailer failed: ${err.message}`);
    console.error('  Retry the commit; or run `instar worktree status` to diagnose.');
    process.exit(1);
  }

  // Append trailers via git interpret-trailers --in-place
  const trailerArgs = [];
  for (const t of signed.trailers) {
    trailerArgs.push('--trailer', t);
  }
  try {
    // safe-git-allow: incremental-migration
    execFileSync('git', ['interpret-trailers', '--in-place', ...trailerArgs, commitMsgFile], {
      stdio: 'inherit',
    });
  } catch (err) {
    console.error(`worktree-commit-msg-hook: BLOCK — interpret-trailers failed: ${err.message}`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(`worktree-commit-msg-hook: BLOCK — ${err.message}`);
  process.exit(1);
});
