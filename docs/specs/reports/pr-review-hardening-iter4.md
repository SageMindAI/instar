# PR Review Hardening — iteration 4 review synthesis

**Date**: 2026-04-16
**Verdict**: NOT CONVERGED (borderline — one critical source-code constraint + ~20 spec-clarification findings)
**Reviewer tally**: 4 MINOR (security, scalability, adversarial, GPT) · 2 NOT CONVERGED (integration, Gemini-unavailable) · 1 CONVERGED (Grok)

## Headline: iter3 → iter4 transition dropped all 4 criticals and 10+ highs

iter4 addressed:
- LLM-verifying-Justin-identity → server-side structural check (verified resolved)
- Sampling PRNG + grandfathering chain → HMAC per-PR + last-push-SHA (verified)
- Token-vs-git-sync contradiction → secrets path + gitignore + BLOCKED_FILES (intent resolved, implementation gap found — see F1 below)
- Migration absent → PostUpdateMigrator steps enumerated (intent resolved, specifics found — see Integration)
- Fork-and-fix rebase TOCTOU → explicit rebase flow (verified)
- Multi-machine → primary declared + 409 NOT_PRIMARY (verified, but seed/ledger bootstrap gap — see Adversarial #4 + Integration F8)
- Proof-bundle concurrence circularity → hash-bound + window-bound (verified)

## Critical iter4 finding (convergence blocker)

### Integration F1+F6+F10: BackupManager.BLOCKED_FILES is a literal Set<string>, not a glob matcher
Current source at `BackupManager.ts:20,170` is `Set(['config.json','secrets','machine'])` checked via `.has(baseName) || .has(entry)`. My spec's migration plan adds `.instar/secrets/pr-gate/**` to that Set — no-op under current semantics. If iter4 shipped, the secrets directory would be silently backed up, leaking tokens into git-synced snapshots — the exact attack vector the spec defends against.

**Fix for iter5**: Two-pronged:
1. Spec must require a source change: switch `BLOCKED_FILES` to a matcher (regex or micromatch), OR extend `.has(baseName)` check to also reject any entry whose resolved path starts with a registered secrets prefix.
2. Spec must explicitly enforce `includeFiles` never contains any entry under `.instar/secrets/**` (defense in depth).

## High-severity iter4 findings

**Security:**
- Replay nonce direction backwards — action-chosen nonce allows same-tuple response replay by attacker with read-token + MITM. Fix: server issues short-lived challenge (`GET /pr-gate/status/challenge`), action answers.
- Per-contributor $5 sub-ceiling bypassable by multi-account (sockpuppets). Fix: new-contributor pooled sub-ceiling + fork-network clustering.
- Multi-machine primary failover has no replication path for eligibility DB. Fix: streaming replication OR explicit "failover forces full re-review" semantics.
- PostUpdateMigrator now high-value attack target; no content-hash verification on shipped files. Fix: build-time manifest, verify-before-write.

**Scalability:**
- Rollup JSON atomicity unspecified — crash mid-write breaks `/pr-gate/metrics` until hand-repair. Fix: atomic temp-rename, fsync, rebuild-on-startup from JSONL + checkpoint.
- SQLite WAL/busy_timeout/vacuum unspecified — `VACUUM` at 10k rows locks DB → Action times out → merge spuriously blocked. Fix: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, incremental auto-vacuum.
- PR-wave FIFO has no depth cap — unbounded memory on spike. Fix: `prWaveMaxQueueDepth: 50`, reserve 1 slot for deterministic-override high-risk PRs.

**Adversarial:**
- repo-state-evidence can cite PR-added files (semantic laundering). Fix: define as "exists at merge-base, unmodified in diff" + deterministic server check.
- **claim-source is self-declared by the same LLM being defended against (sharpest).** Sycophancy/injection can launder contributor framing as diff-evidence. Fix: separate description-blind grounding verifier that rates `does-evidence-support-claim`.
- Seed rotation "unlogged" contradicts primary failover (secondary can't recover seed). Fix: server-to-server sync endpoint on rotation; event logged to security.jsonl (event only, not value).

**Integration:**
- migrateBackupManifest needs to write config.json override, not mutate shipped constant. Must ALSO ship source-level DEFAULT_CONFIG update in same release.
- installBuiltinSkills pattern: spec must say "add entry to the skills record in init.ts:1444".
- phase-a-sha.json writer unspecified (commit-time static file vs server-boot cache).
- migrateGitignore is REMOVE-only today; `addGitignoreEntry` is a new helper.
- `git remote get-url` detection is fork-fragile (SSH vs HTTPS, forks, Echo's own agent dir). Fix: URL normalization + `package.json.name === "instar"` second signal.
- Migrator step insertion points in `migrate()` must be explicit.
- tokens.json write atomicity (temp-rename + fsync).
- `docs/pr-gate-setup.md` is referenced but not authored — Phase D blocker.

**Adversarial medium/low:**
- Material-concern AQ override should escalate to blocking after N hours if not cleared.
- Fork-and-fix rebase: no `rerere`, no `-X theirs/ours` — any conflict aborts.
- Dashboard XSS — HTML escape + safe-mode markdown + CSP.
- HMAC head-sha grinding — add `(pr-number, head-sha, push-iteration-counter)` so re-pushes don't re-roll dice.

**GPT:**
- Stale record refresh path at 24h TTL + unchanged SHA (explicit behavior on merge attempt).
- Deferred-queue semantics (deferred vs removed from active FIFO).

**Grok:**
- Extracted spec end-to-end mechanics (implicit spec → repo-resident file → Justin approval) — currently gap between extraction and repo landing.
- server_secret rotation parity with token rotation (revoke endpoint, security.jsonl event).

## Iteration verdict

NOT CONVERGED due to Integration F1 (critical, source-level constraint). ~25 spec-clarification findings also need addressing. Proceeding to iter5 with targeted edits.
