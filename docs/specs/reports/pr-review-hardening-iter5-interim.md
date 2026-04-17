# PR Review Hardening — iteration 5 interim status

**Date**: 2026-04-16
**Status**: IN-PROGRESS — awaiting decision on iter6 vs stop
**Convergence trajectory**: strong

## Reviewer tally — iter5

| Reviewer | Verdict | Material new findings |
|---|---|---|
| Security (internal) | MINOR | 3 (1 high: secret-sync/replicate auth unspecified) |
| Scalability (internal) | MINOR / borderline | 7 (1 high: sync replication no timeout, rest localized) |
| Adversarial (internal) | **CONVERGED** | 0 |
| Integration (internal) | MINOR | 9 (1 critical: dashboard monolith mismatch; 2 high: BackupConfig plumbing gaps, amendment-vs-follow-up commit) |
| GPT (external) | MINOR 9/10 | **0** |
| Gemini (external) | NOT CONVERGED 9/10 | 1 high: HMAC responseSignature key mismatch (crypto error I introduced in iter5) |
| Grok (external) | NOT CONVERGED 8/10 | 1 high: server needs independent GitHub API verification of (pr, sha) |

## Material findings remaining (would be iter6 work)

1. **Gemini high** — HMAC key mismatch: iter5's challenge-response uses `server_secret` as HMAC key, but the Action only has `PR_GATE_READ_TOKEN`. Symmetric HMAC requires shared key. Fix: HMAC key = read token.
2. **Grok high** — Server accepts Action-declared (pr, sha) without independently verifying via GitHub API. Fix: server queries `GET /repos/{owner}/pulls/{pr}` to confirm PR exists and head.sha matches.
3. **Security high** — `/pr-gate/secret-sync` and `/pr-gate/replicate` endpoints reference "authenticated" without specifying mechanism. Fix: pre-shared per-pair HMAC key in `.instar/secrets/pr-gate/peer-keys.json`, HMAC-signed requests with timestamp replay window, peer-id allowlist.
4. **Scalability high** — Synchronous replication on eligibility write path has no timeout, no quorum, no async backfill. One slow paired machine blocks all merges. Fix: per-peer 5s timeout, quorum semantics, async backfill for slow peers with AQ escalation.
5. **Integration critical** — Spec says dashboard tab ships as "server-bundled React route" but actual dashboard is a 5986-line monolithic HTML file. Fix: spec must say Phase-A commit edits `dashboard/index.html` directly OR defer tab to Phase D behind feature flag.
6. **Integration high** — `BackupConfig.includeFiles` override path has no end-to-end plumbing: ConfigDefaults has no `backup` key, call sites don't read `ctx.config.backup`. Fix: spec must enumerate ConfigDefaults addition + call-site changes in routes.ts and backup.ts.
7. **Integration high** — "post-merge amendment commit" implies force-push to main (banned). Fix: rename to "follow-up commit."

## Non-blocking clarifications (batch at end of iter6 if done)

- Challenge DoS mitigation (per-token rate limit + per-(pr,sha) dedup)
- Claim-grounder hardening explicit reassertion
- Claim-grounder quote length cap (500 chars)
- Claim-grounder cost entries in ledger
- Deferred-queue jittered re-entry at UTC midnight
- Cost ledger rotation/retention
- Rollup rebuild: clean orphan .tmp + tolerate torn trailing JSONL line
- SSE dashboard max subscribers + coalesce
- Remove actions/checkout (Grok medium)
- phase-a-sha.json 24h window before flip-to-closed (Security low)
- Schema version check for SQLite eligibility DB
- lstat on backup traversal (symlink escape)
- Fork push permissions fallback (Gemini non-blocking)
- Sockpuppet threshold via deterministic GitHub API query
- Dashboard CSP specifics
- migratePrPipelineArtifacts inline vs manifest (Integration recommends inline)
- addGitignoreEntry idempotency line-match vs substring-match
- BLOCKED_PATH_PREFIXES edge cases (absolute paths, leading-slash)

## Trajectory

- iter1 → iter2: 14+ critical findings across 7 reviewers
- iter2 → iter3: cross-cutting architectural issues surfaced (prompt injection, signal-vs-authority, server auth)
- iter3 → iter4: 4 critical → 0; 17 high → 7; iter4 adds implementation-grounded findings from real source reads
- iter4 → iter5: BackupManager-literal-Set critical resolved; Adversarial → CONVERGED; GPT → zero material
- iter5 → iter6: 7 legitimate material fixes, all localized/crypto/clarifying, no architectural changes

## Decision pending

Path A — iter6 fixes + final convergence check (~15 min + API cost).
Path B — land iter5 as-is, hand spec to Justin for human judgment, move on to other work.
