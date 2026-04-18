/**
 * Worktree HTTP routes.
 *
 * Standard auth (bearer token) endpoints:
 *   POST /worktrees/resolve    — atomic create+bind+lock; spawned by SessionManager
 *   POST /worktrees/release    — release lock (sessionId+fencingToken)
 *   POST /worktrees/heartbeat  — server-stamped heartbeat
 *   POST /worktrees/force-take — forcible takeover (audit-logged)
 *   GET  /worktrees            — list bindings
 *   GET  /worktrees/reconcile  — state reconciliation matrix snapshot
 *
 * POST /commits/preflight  — pre-commit hook checks cwd vs binding, lock owner, foreign-WIP
 * POST /commits/sign-trailer — commit-msg hook gets the 9 trailer lines (server signs)
 *
 * OIDC-only endpoint (mounted before auth middleware):
 *   POST /gh-check/verify-nonce — called by GitHub Actions runner; OIDC-authenticated;
 *                                 rate-limited; oracle-protected (uniform error response).
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import type { WorktreeManager, WorktreeMode } from '../core/WorktreeManager.js';

// ── Validation schemas ───────────────────────────────────────────────

const ModeSchema = z.enum(['dev', 'read-only', 'doc-fix', 'platform']);

const TopicIdSchema = z.union([z.number().int().positive(), z.literal('platform')]);

const ResolveBody = z.object({
  topicId: TopicIdSchema,
  mode: ModeSchema,
  sessionId: z.string().min(1).max(128),
  pid: z.number().int().positive(),
  processStartTime: z.number().int().nonnegative().optional(),
  slug: z.string().max(80).optional(),
});

const ReleaseBody = z.object({
  sessionId: z.string().min(1).max(128),
  fencingToken: z.string().min(1).max(256),
});

const HeartbeatBody = ReleaseBody;

const ForceTakeBody = z.object({
  topicId: TopicIdSchema,
  mode: ModeSchema,
  bySessionId: z.string().min(1).max(128),
  pid: z.number().int().positive(),
  processStartTime: z.number().int().nonnegative().optional(),
  reason: z.string().max(500).optional(),
});

const PreflightBody = z.object({
  cwd: z.string().min(1).max(4096),
  fencingToken: z.string().min(1).max(256),
  stagedFiles: z.array(z.string().max(4096)).max(10_000).optional(),
});

const SignTrailerBody = z.object({
  sessionId: z.string().min(1).max(128),
  fencingToken: z.string().min(1).max(256),
  treeHash: z.string().regex(/^[0-9a-f]{40,64}$/),
  parents: z.array(z.string().regex(/^[0-9a-f]{40,64}$|^0{40}$/)).max(8),
});

const VerifyNonceBody = z.object({
  commitSha: z.string().regex(/^[0-9a-f]{40,64}$/),
  nonce: z.string().min(1).max(256),
  binding: z.object({
    topicId: TopicIdSchema,
    sessionId: z.string().min(1).max(128),
  }),
  treeHash: z.string().regex(/^[0-9a-f]{40,64}$/),
  parents: z.array(z.string().regex(/^[0-9a-f]{40,64}$|^0{40}$/)).max(8),
});

// ── Rate limiter for OIDC endpoint (60 req/min/repo) ─────────────────

interface RateLimitEntry { count: number; resetAt: number; }
function makeRateLimiter(maxPerMinute: number) {
  const buckets = new Map<string, RateLimitEntry>();
  return function check(key: string): boolean {
    const now = Date.now();
    let e = buckets.get(key);
    if (!e || e.resetAt < now) {
      e = { count: 0, resetAt: now + 60_000 };
      buckets.set(key, e);
    }
    e.count++;
    return e.count <= maxPerMinute;
  };
}

// ── Auth-required route factory ──────────────────────────────────────

export function createWorktreeRoutes(deps: {
  worktreeManager: WorktreeManager;
  projectDir: string;
}): Router {
  const router = Router();
  const { worktreeManager: wm } = deps;

  router.post('/worktrees/resolve', async (req: Request, res: Response) => {
    const parsed = ResolveBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid request', issues: parsed.error.issues });
    try {
      const result = await wm.resolve({
        topicId: parsed.data.topicId,
        mode: parsed.data.mode,
        sessionId: parsed.data.sessionId,
        pid: parsed.data.pid,
        processStartTime: parsed.data.processStartTime ?? Math.floor(Date.now() / 1000),
        slug: parsed.data.slug,
      });
      return res.json(result);
    } catch (err: any) {
      if (err.code === 'LOCK_HELD') {
        return res.status(409).json({ error: 'LockHeld', holder: err.holder });
      }
      return res.status(500).json({ error: err.message ?? 'unknown' });
    }
  });

  router.post('/worktrees/release', (req: Request, res: Response) => {
    const parsed = ReleaseBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid request' });
    const result = wm.release(parsed.data);
    return res.json(result);
  });

  router.post('/worktrees/heartbeat', (req: Request, res: Response) => {
    const parsed = HeartbeatBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid request' });
    const result = wm.heartbeat(parsed.data);
    return res.json(result);
  });

  router.post('/worktrees/force-take', async (req: Request, res: Response) => {
    const parsed = ForceTakeBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid request' });
    try {
      const result = await wm.forceTake({
        topicId: parsed.data.topicId,
        mode: parsed.data.mode,
        bySessionId: parsed.data.bySessionId,
        pid: parsed.data.pid,
        processStartTime: parsed.data.processStartTime ?? Math.floor(Date.now() / 1000),
      });
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ error: err.message ?? 'unknown' });
    }
  });

  router.get('/worktrees', (_req: Request, res: Response) => {
    res.json({ bindings: wm.listBindings() });
  });

  router.get('/worktrees/reconcile', (_req: Request, res: Response) => {
    try {
      const rows = wm.reconcile();
      res.json({ rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Pre-commit gate ──────────────────────────────────────────────

  router.post('/commits/preflight', (req: Request, res: Response) => {
    const parsed = PreflightBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid request' });

    // Find binding whose worktreePath is a prefix of cwd
    const bindings = wm.listBindings();
    const cwdReal = (() => {
      try { return fs.realpathSync(parsed.data.cwd); } catch { return parsed.data.cwd; }
    })();
    const binding = bindings.find(b => {
      try {
        const bReal = fs.realpathSync(b.worktreePath);
        return cwdReal === bReal || cwdReal.startsWith(bReal + path.sep);
      } catch { return false; }
    });
    if (!binding) {
      return res.json({ ok: false, code: 'cwd-not-in-binding', message: 'commit cwd is not a registered worktree' });
    }
    const lock = wm.getLock(binding.worktreePath);
    if (!lock) {
      return res.json({ ok: false, code: 'no-lock', message: 'no active lock on this worktree' });
    }
    if (lock.fencingToken !== parsed.data.fencingToken) {
      return res.json({ ok: false, code: 'fencing-token-mismatch', message: 'session fencing token superseded' });
    }
    if (binding.mode === 'read-only') {
      return res.json({ ok: false, code: 'read-only', message: 'read-only worktree; commits blocked' });
    }
    return res.json({ ok: true, binding });
  });

  // ── commit-msg trailer issuance ──────────────────────────────────

  router.post('/commits/sign-trailer', (req: Request, res: Response) => {
    const parsed = SignTrailerBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid request' });
    try {
      const result = wm.signTrailer(parsed.data);
      return res.json(result);
    } catch (err: any) {
      return res.status(403).json({ error: err.message });
    }
  });

  return router;
}

// ── OIDC-only routes (mounted BEFORE bearer-auth middleware) ─────────

export interface OidcVerifyOptions {
  /**
   * Allowed (owner, repo) tuples. e.g. {owner: 'instar', repo: 'instar'}.
   * Empty list means all callers rejected.
   */
  enrolledRepos: Array<{ owner: string; repo: string }>;
  /**
   * Verify a GitHub OIDC token and return claims, or throw.
   * Injected so we can unit-test without real OIDC traffic.
   */
  verifyOidcToken: (token: string) => Promise<{ repository: string; workflow_ref: string; ref: string }>;
}

export function createOidcWorktreeRoutes(deps: {
  worktreeManager: WorktreeManager;
  oidc: OidcVerifyOptions;
}): Router {
  const router = Router();
  const { worktreeManager: wm, oidc } = deps;
  const rateCheck = makeRateLimiter(60);

  router.post('/gh-check/verify-nonce', async (req: Request, res: Response) => {
    // Uniform response shape for oracle protection
    const denyUniform = (status = 200) => res.status(status).json({ verifier_says_no: true });

    const auth = req.header('authorization') ?? '';
    const m = auth.match(/^Bearer (.+)$/);
    if (!m) return denyUniform(401);
    const token = m[1];

    let claims: { repository: string; workflow_ref: string; ref: string };
    try {
      claims = await oidc.verifyOidcToken(token);
    } catch {
      return denyUniform(401);
    }

    const [owner, repo] = (claims.repository ?? '').split('/');
    if (!owner || !repo) return denyUniform(401);
    const allowed = oidc.enrolledRepos.some(r => r.owner === owner && r.repo === repo);
    if (!allowed) return denyUniform(403);

    if (!rateCheck(claims.repository)) {
      return res.status(429).json({ verifier_says_no: true, retry_after_seconds: 60 });
    }

    const parsed = VerifyNonceBody.safeParse(req.body);
    if (!parsed.success) return denyUniform();

    // Idempotent nonce check
    const status = wm.checkNonceUnique({ nonce: parsed.data.nonce, commitSha: parsed.data.commitSha });
    if (status === 'seen-for-different-commit') return denyUniform();

    if (status === 'unseen') {
      wm.recordCommitForNonce({ nonce: parsed.data.nonce, commitSha: parsed.data.commitSha });
    }
    return res.json({ verifier_says_yes: true });
  });

  return router;
}
