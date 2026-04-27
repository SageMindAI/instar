#!/usr/bin/env node
/**
 * worktree-precommit-gate.js — pre-commit gate for parallel-dev isolation.
 *
 * Ensures the cwd of this commit matches the worktree the active session was
 * granted, and that the session's fencing token is still current. Calls the
 * agent server's POST /commits/preflight; fail-open-to-warn on timeout.
 *
 * Exit codes:
 *   0 — pass (binding+lock OK, or warn on timeout)
 *   1 — block (cwd-not-in-binding, fencing-token-mismatch, read-only mode, etc.)
 *
 * Reads INSTAR_SERVER_URL + INSTAR_AUTH_TOKEN from env (set by SessionManager).
 * Reads .instar/session-context.json for sessionId + fencingToken.
 *
 * Per spec section: "Pre-commit fence (advisory layer, iter 3)".
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execSync } from 'node:child_process';

const PREFLIGHT_TIMEOUT_MS = 500;

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

function readContext(ctxPath) {
  try { return JSON.parse(fs.readFileSync(ctxPath, 'utf-8')); }
  catch { return null; }
}

function postPreflight({ serverUrl, authToken, cwd, fencingToken, stagedFiles }) {
  return new Promise((resolve) => {
    const url = new URL(serverUrl);
    const body = JSON.stringify({ cwd, fencingToken, stagedFiles });
    const req = http.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: '/commits/preflight',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${authToken}`,
      },
      timeout: PREFLIGHT_TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve({ ok: true, status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ ok: false, reason: 'invalid-json' }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
    req.on('error', (err) => resolve({ ok: false, reason: err.code || err.message }));
    req.write(body);
    req.end();
  });
}

async function main() {
  const cwd = process.cwd();
  const ctxPath = findSessionContext(cwd);
  if (!ctxPath) {
    // No session context — likely a manual commit by the user, not an agent. Pass.
    process.exit(0);
  }
  const ctx = readContext(ctxPath);
  if (!ctx || !ctx.sessionId || !ctx.fencingToken) {
    console.error('worktree-precommit: malformed session-context.json — skipping gate');
    process.exit(0);
  }

  if (ctx.mode === 'read-only') {
    console.error('worktree-precommit: BLOCK — this is a read-only worktree. Use /promote-to-dev to convert, or /quick-doc-fix.');
    process.exit(1);
  }

  // Check fail-open env (only honored for warn mode)
  const isolationMode = process.env.INSTAR_PARALLEL_ISOLATION ?? 'block';

  // Collect staged files (from `git diff --cached --name-only`)
  let stagedFiles = [];
  try {
    // safe-git-allow: incremental-migration
    stagedFiles = execSync('git diff --cached --name-only -z', { encoding: 'utf-8', cwd })
      .split('\0').filter(Boolean);
  } catch { /* @silent-fallback-ok */ }

  const serverUrl = process.env.INSTAR_SERVER_URL;
  const authToken = process.env.INSTAR_AUTH_TOKEN;
  if (!serverUrl || !authToken) {
    console.error('worktree-precommit: WARN — missing INSTAR_SERVER_URL/INSTAR_AUTH_TOKEN; cannot enforce. Continuing.');
    process.exit(0);
  }

  const result = await postPreflight({
    serverUrl,
    authToken,
    cwd,
    fencingToken: ctx.fencingToken,
    stagedFiles,
  });

  if (!result.ok || result.reason === 'timeout') {
    console.error(`worktree-precommit: WARN — preflight ${result.reason ?? 'failed'}; failing open (warn mode).`);
    process.exit(0);
  }

  if (result.body && result.body.ok === true) {
    process.exit(0);
  }

  const code = result.body?.code ?? 'unknown';
  const message = result.body?.message ?? 'preflight rejected';

  if (isolationMode === 'warn') {
    console.error(`worktree-precommit: WARN [${code}] ${message} (would BLOCK in enforcing mode)`);
    process.exit(0);
  }

  console.error(`worktree-precommit: BLOCK [${code}] ${message}`);
  console.error(`  → cwd: ${cwd}`);
  console.error(`  → session-context: ${ctxPath}`);
  console.error('  → If this is wrong, run: instar worktree status');
  process.exit(1);
}

main().catch((err) => {
  console.error(`worktree-precommit: ERROR ${err.message}`);
  // Fail-open on uncaught errors (matches timeout behavior)
  process.exit(0);
});
