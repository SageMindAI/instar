#!/usr/bin/env node
/**
 * verify-trailers.js — runs in GitHub Actions to verify Instar trailers.
 *
 * Per PARALLEL-DEV-ISOLATION-SPEC.md "worktree-trailer-sig-check workflow".
 *
 * Two steps per commit:
 *   1. Offline Ed25519 signature verification using PUBLIC_KEY_PEM (baked into workflow).
 *   2. Online nonce-uniqueness check via OIDC-authenticated POST, with fallback
 *      to INSTAR_VERIFY_CACHE Repo Variable.
 *
 * Exits non-zero (failing the required check) on any verification failure.
 * GitHub's auto-merge commits (authored by noreply@github.com) are exempt.
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import https from 'node:https';

const REQUIRED_TRAILERS = [
  'Instar-Topic-Id', 'Instar-Session', 'Instar-Worktree-Branch',
  'Instar-Trailer-Nonce', 'Instar-Trailer-Parent', 'Instar-Trailer-Issued',
  'Instar-Trailer-MaxPushDelay', 'Instar-Trailer-KeyVersion', 'Instar-Trailer-Sig',
];

function getCommitsInRange(range) {
  const out = execFileSync('git', ['rev-list', '--reverse', range], { encoding: 'utf-8' });
  return out.split('\n').filter(Boolean);
}

function getCommitMessage(sha) {
  return execFileSync('git', ['log', '-1', '--format=%B', sha], { encoding: 'utf-8' });
}

function getCommitAuthor(sha) {
  return execFileSync('git', ['log', '-1', '--format=%ae', sha], { encoding: 'utf-8' }).trim();
}

function getCommitTree(sha) {
  return execFileSync('git', ['log', '-1', '--format=%T', sha], { encoding: 'utf-8' }).trim();
}

function getCommitParents(sha) {
  return execFileSync('git', ['log', '-1', '--format=%P', sha], { encoding: 'utf-8' }).trim().split(' ').filter(Boolean);
}

function parseTrailers(msg) {
  const out = {};
  for (const line of msg.split('\n')) {
    const m = line.match(/^(Instar-[A-Za-z0-9-]+):\s*(.+)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function verifySignature({ trailers, sha }) {
  const pubKeyPem = process.env.PUBLIC_KEY_PEM;
  if (!pubKeyPem) throw new Error('PUBLIC_KEY_PEM env var not set');
  const treeHash = getCommitTree(sha);
  const parents = getCommitParents(sha);
  const repoOrigin = process.env.REPO_ORIGIN_URL ?? '';

  const payload = [
    treeHash,
    trailers['Instar-Topic-Id'],
    trailers['Instar-Session'],
    trailers['Instar-Trailer-Nonce'],
    parents.join(','),
    trailers['Instar-Trailer-Issued'],
    trailers['Instar-Trailer-MaxPushDelay'],
    trailers['Instar-Trailer-KeyVersion'],
    repoOrigin,
  ].join('|');

  const digest = crypto.createHash('sha256').update(payload).digest();
  const sigBuf = Buffer.from(trailers['Instar-Trailer-Sig'], 'base64url');

  return crypto.verify(null, digest, pubKeyPem, sigBuf);
}

function verifyExpiry(trailers) {
  const issued = Number(trailers['Instar-Trailer-Issued']);
  const maxDelay = Number(trailers['Instar-Trailer-MaxPushDelay']);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(issued) || !Number.isFinite(maxDelay)) return false;
  return now >= issued && now <= issued + maxDelay;
}

function postOidc({ url, token, body }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization': `Bearer ${token}`,
      },
      timeout: 10_000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: { raw: buf } }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getOidcToken() {
  // Get GitHub OIDC token via the standard ID-token request endpoint
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const reqToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !reqToken) throw new Error('OIDC env vars not set');
  return new Promise((resolve, reject) => {
    const u = new URL(`${url}&audience=instar-worktree-verify`);
    https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'Authorization': `Bearer ${reqToken}` },
      timeout: 5000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf).value); }
        catch { reject(new Error('invalid OIDC response')); }
      });
    }).on('error', reject);
  });
}

async function checkNonceUniqueness({ sha, trailers }) {
  const verifyUrl = process.env.VERIFY_TUNNEL_URL;
  const cacheJson = process.env.VERIFY_CACHE_JSON;
  const expectedUrlHash = process.env.INSTAR_VERIFY_TUNNEL_URL_HASH;

  // K2: Tunnel URL hash pin. Refuse to call any URL that doesn't match the
  // hash baked into the workflow file. The expected hash is configured via the
  // 2-approval-protected workflow file, NOT via the freely-rotatable repo
  // variable, so a leaked `actions:write` PAT cannot redirect verification.
  if (verifyUrl && expectedUrlHash) {
    const actualHash = crypto.createHash('sha256').update(verifyUrl).digest('hex');
    if (actualHash !== expectedUrlHash) {
      console.error(`verify-trailers: VERIFY_TUNNEL_URL hash mismatch (expected ${expectedUrlHash.substring(0, 12)}..., got ${actualHash.substring(0, 12)}...) — refusing to call to prevent SSRF/OIDC-token exfiltration`);
      // fall through to cache-only path
    } else {
      // hash OK — proceed to server call below
    }
  }

  const tunnelUrlOk = !verifyUrl || !expectedUrlHash || crypto.createHash('sha256').update(verifyUrl).digest('hex') === expectedUrlHash;

  // Try server first
  if (verifyUrl && tunnelUrlOk) {
    try {
      const oidcToken = await getOidcToken();
      const result = await postOidc({
        url: `${verifyUrl}/gh-check/verify-nonce`,
        token: oidcToken,
        body: {
          commitSha: sha,
          nonce: trailers['Instar-Trailer-Nonce'],
          binding: {
            topicId: trailers['Instar-Topic-Id'].includes('platform') ? 'platform' : Number(trailers['Instar-Topic-Id']),
            sessionId: trailers['Instar-Session'],
          },
          treeHash: getCommitTree(sha),
          parents: getCommitParents(sha),
        },
      });
      if (result.status === 200 && result.body && result.body.verifier_says_yes) return { ok: true, source: 'server' };
      if (result.status === 200 && result.body && result.body.verifier_says_no) return { ok: false, source: 'server' };
      // 5xx or unexpected → fallback
    } catch (err) {
      console.error(`verify-trailers: server unreachable (${err.message}); trying cache`);
    }
  }

  // Cache fallback
  if (cacheJson) {
    try {
      const cache = JSON.parse(cacheJson);
      const now = Math.floor(Date.now() / 1000);
      for (const pair of cache.validNoncePairs ?? []) {
        if (pair.nonce === trailers['Instar-Trailer-Nonce'] && pair.commitSha === sha && pair.expiresAt > now) {
          return { ok: true, source: 'cache' };
        }
      }
    } catch (err) {
      console.error(`verify-trailers: cache parse failed: ${err.message}`);
    }
  }

  return { ok: false, source: 'no-source' };
}

async function main() {
  // Bootstrap guard: if the public key hasn't been configured yet (Day -2 migration
  // not yet run), the signing infrastructure doesn't exist. Skip verification so the
  // workflow that SHIPS this system can merge without a chicken-and-egg deadlock.
  if (!process.env.PUBLIC_KEY_PEM) {
    console.log('verify-trailers: PUBLIC_KEY_PEM not configured — verification system not yet activated. Skipping.');
    process.exit(0);
  }

  const range = process.env.PUSH_RANGE;
  if (!range || !range.includes('..')) {
    console.error(`verify-trailers: invalid PUSH_RANGE "${range}"`);
    process.exit(2);
  }

  let commits;
  try {
    commits = getCommitsInRange(range);
  } catch (err) {
    console.error(`verify-trailers: could not enumerate commits: ${err.message}`);
    process.exit(2);
  }

  if (commits.length === 0) {
    console.log('verify-trailers: no commits in range, passing');
    process.exit(0);
  }

  const failures = [];
  for (const sha of commits) {
    const author = getCommitAuthor(sha);
    if (author === 'noreply@github.com' || author === 'github-actions[bot]@users.noreply.github.com') {
      console.log(`✓ ${sha.substring(0, 12)} GitHub-merge-commit (exempt)`);
      continue;
    }

    const msg = getCommitMessage(sha);
    const trailers = parseTrailers(msg);

    const missing = REQUIRED_TRAILERS.filter(t => !trailers[t]);
    if (missing.length > 0) {
      failures.push({ sha, reason: `missing trailers: ${missing.join(', ')}` });
      continue;
    }

    if (!verifyExpiry(trailers)) {
      failures.push({ sha, reason: 'trailer expired or not yet valid' });
      continue;
    }

    if (!verifySignature({ trailers, sha })) {
      failures.push({ sha, reason: 'invalid Ed25519 signature' });
      continue;
    }

    const nonceCheck = await checkNonceUniqueness({ sha, trailers });
    if (!nonceCheck.ok) {
      failures.push({ sha, reason: `nonce-check failed (source=${nonceCheck.source})` });
      continue;
    }

    console.log(`✓ ${sha.substring(0, 12)} ${trailers['Instar-Worktree-Branch']} verified (source=${nonceCheck.source})`);
  }

  if (failures.length > 0) {
    console.error(`verify-trailers: ${failures.length} commit(s) failed verification:`);
    for (const f of failures) {
      console.error(`  ✗ ${f.sha.substring(0, 12)}  ${f.reason}`);
    }
    process.exit(1);
  }

  console.log(`verify-trailers: all ${commits.length} commit(s) verified`);
}

main().catch((err) => {
  console.error(`verify-trailers: FATAL ${err.message}`);
  console.error(err.stack);
  process.exit(2);
});
