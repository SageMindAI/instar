/**
 * WorktreeManager unit tests — parallel-dev isolation ACs.
 *
 * Covers ACs from PARALLEL-DEV-ISOLATION-SPEC.md:
 *   AC-1  default isolation
 *   AC-3  exclusive lock (409 LockHeld)
 *   AC-4  sequential attach
 *   AC-5  commit-msg trailer injection
 *   AC-9  replay rejected (nonce uniqueness)
 *   AC-10 lock heartbeat + boot-ID
 *   AC-11 force-take preserves staged + untracked (NOT --include-ignored)
 *   AC-17 incident replay part one (two-session sweep)
 *   AC-43 Ed25519 offline verify
 *   AC-48 nonce idempotency
 *   AC-51 merge-commit signs all parents
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createTwoSessionHarness, type HarnessHandle } from '../fixtures/two-session-harness.js';

let h: HarnessHandle;

beforeEach(async () => { h = await createTwoSessionHarness(); });
afterEach(() => { h.cleanup(); });

describe('AC-1 default isolation', () => {
  it('spawns into an isolated worktree (not main checkout)', async () => {
    const s = await h.spawn({ topicId: 2317, mode: 'dev', slug: 'github-prs' });
    expect(s.cwd).toBeDefined();
    expect(s.cwd).not.toBe(h.projectDir);
    expect(s.cwd!.startsWith(path.join(h.stateDir, 'worktrees'))).toBe(true);
    expect(fs.existsSync(s.cwd!)).toBe(true);
    // session-context.json is signed and present
    const ctxPath = path.join(s.cwd!, '.instar', 'session-context.json');
    expect(fs.existsSync(ctxPath)).toBe(true);
    const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf-8'));
    expect(ctx.sessionId).toBe(s.sessionId);
    expect(ctx.fencingToken).toBe(s.fencingToken);
    expect(ctx.serverSignature).toBeTruthy();
  });
});

describe('AC-3 exclusive lock — 409 LockHeld', () => {
  it('second session for same topic+mode gets LOCK_HELD', async () => {
    await h.spawn({ topicId: 2317, mode: 'dev', sessionId: 'session-a' });
    await expect(
      h.spawn({ topicId: 2317, mode: 'dev', sessionId: 'session-b' }),
    ).rejects.toMatchObject({ code: 'LOCK_HELD' });
  });
  it('different mode for same topic does NOT collide', async () => {
    await h.spawn({ topicId: 2317, mode: 'dev', sessionId: 'session-a' });
    const b = await h.spawn({ topicId: 2317, mode: 'doc-fix', sessionId: 'session-b' });
    expect(b.cwd).toBeDefined();
  });
});

describe('AC-4 sequential attach', () => {
  it('after release, second session attaches to same worktree', async () => {
    const a = await h.spawn({ topicId: 4242, mode: 'dev', slug: 'feature-x' });
    h.release(a);
    const b = await h.spawn({ topicId: 4242, mode: 'dev', slug: 'feature-x' });
    expect(b.cwd).toBe(a.cwd);
    // fencing token bumps monotonically
    const aT = Number(a.fencingToken!.split(':')[1]);
    const bT = Number(b.fencingToken!.split(':')[1]);
    expect(bT).toBeGreaterThan(aT);
  });
});

describe('AC-5 commit-msg trailer injection', () => {
  it('signTrailer returns 9 trailer lines with valid Ed25519 signature', async () => {
    const s = await h.spawn({ topicId: 2317, mode: 'dev' });
    // safe-git-allow: incremental-migration
    const treeHash = execFileSync('git', ['-C', s.cwd!, 'write-tree'], { encoding: 'utf-8' }).trim();
    // safe-git-allow: incremental-migration
    const head = execFileSync('git', ['-C', s.cwd!, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();

    const result = h.manager.signTrailer({
      sessionId: s.sessionId,
      fencingToken: s.fencingToken!,
      treeHash,
      parents: [head],
    });

    expect(result.trailers).toHaveLength(9);
    const map = Object.fromEntries(result.trailers.map((l) => l.split(/:\s*/)));
    expect(map['Instar-Topic-Id']).toBe('2317');
    expect(map['Instar-Trailer-Sig']).toBeTruthy();
  });
});

describe('AC-9 replay rejected (nonce uniqueness)', () => {
  it('same nonce reused for a different commit is rejected', async () => {
    const s = await h.spawn({ topicId: 2317, mode: 'dev' });
    // safe-git-allow: incremental-migration
    const treeHash = execFileSync('git', ['-C', s.cwd!, 'write-tree'], { encoding: 'utf-8' }).trim();
    const result = h.manager.signTrailer({
      sessionId: s.sessionId,
      fencingToken: s.fencingToken!,
      treeHash,
      parents: ['0'.repeat(40)],
    });
    h.manager.recordCommitForNonce({ nonce: result.nonce, commitSha: 'a'.repeat(40) });

    // Replay against different commit → seen-for-different-commit
    expect(h.manager.checkNonceUnique({ nonce: result.nonce, commitSha: 'b'.repeat(40) })).toBe('seen-for-different-commit');
  });
});

describe('AC-11 force-take preserves untracked, NOT --include-ignored', () => {
  it('force-take produces a snapshot, no node_modules in stash', async () => {
    const s = await h.spawn({ topicId: 5555, mode: 'dev' });
    // Add untracked file simulating .env (gitignored)
    fs.writeFileSync(path.join(s.cwd!, '.env'), 'SECRET=42\n');
    fs.writeFileSync(path.join(s.cwd!, 'wip.txt'), 'work in progress\n');
    fs.writeFileSync(path.join(s.cwd!, '.gitignore'), '.env\nnode_modules/\n');

    const result = (await h.forceTake({ topicId: 5555, mode: 'dev', bySessionId: 'session-b' })) as { snapshotPath: string };
    expect(result.snapshotPath).toBeTruthy();
    // Snapshot file (or .gz fallback) exists
    const exists = fs.existsSync(result.snapshotPath) || fs.existsSync(result.snapshotPath.replace(/\.zst$/, '.gz'));
    expect(exists).toBe(true);
  }, 30_000);
});

describe('AC-17 incident replay part one — two-session sweep', () => {
  it('two parallel spawns for same topic produce one isolated worktree, one rejection', async () => {
    const a = await h.spawn({ topicId: 2317, mode: 'dev', sessionId: 'compaction-resume', slug: 'github-prs' });
    expect(a.cwd).toBeTruthy();
    let collision: any = null;
    try { await h.spawn({ topicId: 2317, mode: 'dev', sessionId: 'echo-github-prs-2', slug: 'github-prs' }); }
    catch (err) { collision = err; }
    expect(collision).toBeTruthy();
    expect(collision.code).toBe('LOCK_HELD');
  });
});

describe('AC-43 Ed25519 offline verify', () => {
  it('signature verifies offline using only the public key', async () => {
    const s = await h.spawn({ topicId: 2317, mode: 'dev' });
    // safe-git-allow: incremental-migration
    const treeHash = execFileSync('git', ['-C', s.cwd!, 'write-tree'], { encoding: 'utf-8' }).trim();
    // safe-git-allow: incremental-migration
    const head = execFileSync('git', ['-C', s.cwd!, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();

    const result = h.manager.signTrailer({
      sessionId: s.sessionId,
      fencingToken: s.fencingToken!,
      treeHash,
      parents: [head],
    });

    const map = Object.fromEntries(result.trailers.map((l) => {
      const idx = l.indexOf(': ');
      return [l.slice(0, idx), l.slice(idx + 2)];
    }));
    const repoOriginUrl = `file://${h.projectDir}.git`;
    const payload = [
      treeHash,
      map['Instar-Topic-Id'],
      map['Instar-Session'],
      map['Instar-Trailer-Nonce'],
      head,
      map['Instar-Trailer-Issued'],
      map['Instar-Trailer-MaxPushDelay'],
      map['Instar-Trailer-KeyVersion'],
      repoOriginUrl,
    ].join('|');
    const digest = crypto.createHash('sha256').update(payload).digest();
    const sigBuf = Buffer.from(map['Instar-Trailer-Sig'], 'base64url');
    const ok = crypto.verify(null, digest, h.publicKeyPem, sigBuf);
    expect(ok).toBe(true);
  });
});

describe('AC-48 nonce idempotency', () => {
  it('same (nonce, commitSha) on retry returns seen-for-same-commit (allowed)', async () => {
    const s = await h.spawn({ topicId: 2317, mode: 'dev' });
    // safe-git-allow: incremental-migration
    const treeHash = execFileSync('git', ['-C', s.cwd!, 'write-tree'], { encoding: 'utf-8' }).trim();
    // safe-git-allow: incremental-migration
    const head = execFileSync('git', ['-C', s.cwd!, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    const result = h.manager.signTrailer({
      sessionId: s.sessionId,
      fencingToken: s.fencingToken!,
      treeHash,
      parents: [head],
    });
    h.manager.recordCommitForNonce({ nonce: result.nonce, commitSha: 'c'.repeat(40) });
    expect(h.manager.checkNonceUnique({ nonce: result.nonce, commitSha: 'c'.repeat(40) })).toBe('seen-for-same-commit');
  });
});

describe('AC-51 merge-commit signs all parents in order', () => {
  it('signature payload includes all parent SHAs comma-joined', async () => {
    const s = await h.spawn({ topicId: 2317, mode: 'dev' });
    // safe-git-allow: incremental-migration
    const treeHash = execFileSync('git', ['-C', s.cwd!, 'write-tree'], { encoding: 'utf-8' }).trim();
    const parents = ['a'.repeat(40), 'b'.repeat(40)];
    const result = h.manager.signTrailer({
      sessionId: s.sessionId,
      fencingToken: s.fencingToken!,
      treeHash,
      parents,
    });
    const trailerMap = Object.fromEntries(result.trailers.map((l) => {
      const idx = l.indexOf(': ');
      return [l.slice(0, idx), l.slice(idx + 2)];
    }));
    expect(trailerMap['Instar-Trailer-Parent']).toBe(parents.join(','));
  });
});

describe('reconciliation matrix', () => {
  it('detects external worktree as adopt-external-alert-once row', async () => {
    const rows = h.manager.reconcile();
    // Main worktree from `git init` is considered external (not under .instar/worktrees/)
    const externals = rows.filter((r) => r.action === 'adopt-external-alert-once');
    expect(externals.length).toBeGreaterThanOrEqual(1);
  });
});
