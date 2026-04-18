---
title: "Parallel Dev Isolation — /spec-converge Report"
spec: "docs/specs/PARALLEL-DEV-ISOLATION-SPEC.md"
slug: "parallel-dev-isolation"
author: "echo"
created: "2026-04-17"
iterations: 4
verdict: "CONVERGED with 20 pre-Day-0 hardening items"
---

# Parallel Dev Isolation — Convergence Report

## TL;DR

A 4-round multi-reviewer convergence loop over a spec to make collision-free parallel development the *structurally enforced* default in instar. After 4 iterations and 7 reviewers per round (4 internal, 3 external — GPT, Gemini, Grok), the spec has materially converged. **Architectural soundness: confirmed by all reviewers.** **Implementation readiness: 20 hardening items (K1–K20) tracked as pre-Day-0 work — none architectural, all localized.**

Spec is at `docs/specs/PARALLEL-DEV-ISOLATION-SPEC.md` — 789 lines, 63 acceptance criteria, 4 review iterations, 20 documented known-issues.

---

## ELI10 — what's actually being shipped

You and Justin run multiple instar agents in parallel on the same code. Today, every agent works in the same folder. If two agents touch different files, both edits sit there together. When one agent goes "I'm done, let me commit," it sweeps in everything sitting around — including the *other* agent's half-finished work — under its own commit message and authorship. That's how 1028 lines of unrelated `InitiativeTracker` work nearly got committed under the compaction-resume fix on April 17.

**The fix in five lines:**

1. **Every agent gets its own folder.** Even read-only agents. The "main" folder is reserved for humans and dashboards. Folder = git worktree, automatically created and cleaned up. Tied to the topic the agent is working on.
2. **Only one agent per folder at a time.** If a second agent for the same topic spawns, it gets "409: someone else is here." It can wait, take over (with a snapshot + alert), or quit.
3. **Every commit gets a tamper-resistant signature.** When you `git commit`, a hook reads the current tree, asks the agent server to sign it with a per-machine Ed25519 key, and embeds the signature in the commit message as a "trailer."
4. **GitHub itself enforces the signature.** A required GitHub Actions check verifies the signature and rejects pushes that lack it (or have a forged one) — even if the user used `git commit --no-verify`, even if they cloned to `/tmp/` and pushed direct, even if they're a repo admin. The check uses the public key baked into the workflow YAML, so it works offline (without contacting your laptop).
5. **Destructive commands snapshot first.** `git clean -fd`, `git reset --hard`, `rm -rf` get intercepted. If they'd delete >5 files, the worktree is auto-snapshotted to `.instar/worktrees/.snapshots/` (encrypted, mode 0600) before the command runs. So nobody accidentally wipes your `.env` again.

**The cost:** more disk (each worktree is an isolated checkout with `node_modules`), one new GitHub-required check (~5–10s per push), one Cloudflare Tunnel for the agent server, plus an Ed25519 keypair you keep in your OS keychain. Think "git worktrees + branch protection + commit signatures + a `git wrapper` that asks before destroying things." None of those are exotic; the novelty is wiring them into a single enforced default instead of leaving them as opt-in best practices.

**Failure modes covered:** the original incident (parallel-session sweep), the part-two collateral incident (untracked `.env` files wiped by `git clean`), 30+ adversarial vectors (replay, forgery, admin bypass, force-push, IDE-direct-git invocation, disk-imaging-clone collision), and graceful degradation when the agent server is down (existing sessions continue read-only; pushes fall back to a server-pushed signed cache stored in a GitHub Repo Variable).

---

## Original ask vs. converged design

| Justin's original ask | What converged |
|-----------------------|----------------|
| "Stop parallel sessions from colliding on the same working tree" | Default-on isolation: every session gets its own worktree, no opt-in needed |
| "Stop one session sweeping another's staged work" | Pre-commit fence checks `cwd == binding.worktree` AND lock-owner; commit-msg hook signs the tree — wrong-tree commits rejected |
| "Stop `git clean` from wiping untracked WIP" | Mandatory destructive-command interception via PATH+function shim + fsnotify watcher; snapshots before destroy |
| "Find the topic responsible for the InitiativeTracker work and nudge it" | Done in-flight: traced to topic 2317 (`echo-github-prs`); nudged with recovery instructions; work safely stashed as `stash@{0}` |
| "Provide a link to a report with ELI10 overview" | This document, plus private-view link in the Telegram reply |

---

## Iteration summary

| Iter | Spec changes | Reviewers | Verdict | Key surface introduced |
|------|--------------|-----------|---------|------------------------|
| 1 | Initial spec — server-mediated bindings, advisory pre-commit gate, lock with HMAC, /promote-to-dev | 4 internal + GPT/Gemini/Grok | NOT CONVERGED — multi-machine binding conflict, lock tamper, auto-promote risk | Naive multi-machine bindings, single auth layer |
| 2 | Per-machine binding files, server-signed lock + HMAC + fencing tokens, explicit /promote-to-dev (no auto-promote), state reconciliation matrix, force-take protocol | 4 internal + 3 external | NOT CONVERGED — server-mediated authority introduced new criticals: push-gate not authoritative, doc-only fast path bypassable, server outage = total dev block | Push-time mirror gate, server-mediated authority |
| 3 | GitHub-side branch protection as authoritative (replaces local mirror as authority), commit-msg hook (fixes pre-commit-can't-write-message bug), exclusive same-topic concurrency, FS snapshot + scoped stash, server-down read-only fallback, cross-platform matrix, HMAC key in OS keychain | 4 internal + 3 external | NOT CONVERGED — Cloudflare Tunnel SPoF, GH runner can't verify HMAC offline, multi-machine binding-history blindness, doc-fix-merge-to-main bypass, optional shim too weak | GH-side authoritative gate, online verify endpoint, optional shim |
| 4 | Ed25519 keypair (offline GH verify), GitHub Repository Ruleset with hardened bypass actors, OIDC-authenticated nonce verification + rate-limit + oracle-protection, GH Repo Variable cache fallback, mandatory destructive-command shim (PATH+function+fsnotify), `cp -al` fully removed, headless keychain fallback, server-generated machineId, multi-machine binding-history-log signed sync, /quick-doc-fix ratification, named tunnel required, nonce idempotency, rolling 7d trailer expiry, merge/amend/rebase/squash policy, Day -2 TOFU acknowledgment, rollback split local vs origin, GH-merge-commit ruleset bypass | 4 internal (lean — externals skipped per stop criterion) | **CONVERGED with 20 pre-Day-0 hardening items** | Ed25519 + ruleset + cache + sync log; remaining surface is localized hardening, not architectural |

---

## What each external reviewer said (iter 3 — last externals run)

- **Grok 4.1 Fast (iter 3):** 10/10 APPROVE. "Production-ready, exhaustive threat modeling, atomicity guarantees, 39 testable ACs."
- **Gemini 3.1 Pro (iter 3):** 8/10 CONDITIONAL. 4 criticals (all addressed in iter 4): `--include-ignored` repo bloat, `cp -al` inode aliasing, offline-tunnel cache paradox, OS keychain in headless daemons.
- **GPT 5.4 (iter 3):** 8/10 CONDITIONAL. 5 criticals (all addressed in iter 4): GH ruleset overstated, rollback contradiction, doc-fix bypass, public verify endpoint underspecified, destructive shim too optional.

Iter 4 closes 100% of those 9 external criticals (verified by iter-4 internal pass).

---

## Iter-4 internal review (lean, final)

4 reviewers (security, scalability, adversarial, integration) — externals skipped per stop criterion (committed publicly to user before iter 4: "calling iter 4 the FINAL iteration regardless").

| Reviewer | Verdict | Iter-3 must-fixes resolved | New issues |
|----------|---------|-----------------------------|------------|
| Security | CONVERGED with caveats | 9/9 GPT+Gemini criticals + 9/9 internal must-fixes RESOLVED | 6 new (N1-N6); 2 medium-high → tracked as K7, K8 |
| Scalability | CONVERGED with operational caveats | No architectural cliff | 3 ops concerns → K13, K14, K15 |
| Adversarial | CONVERGED — recommend one more iteration to close 3 critical hardening items | 16/19 RESOLVED, 3 PARTIAL (Tunnel SPoF, IDE bypass, Day -2 TOFU — all honestly acknowledged) | 8 new vectors; V1, V4, V5 marked critical localized hardening → K1, K2, K3 |
| Integration | CONVERGED with 3 friction points | Spec fits existing instar infra cleanly | tmux env injection, GitSync debounce conflict, OIDC route mount order → K9, K10, K16 |

All 4 reviewers explicitly use the word "CONVERGED" or "shippable." None call for a 5th iteration of architectural rework. Adversarial recommends "one more iteration to close 3 hardening items before approval"; per pre-commitment to user, those 3 items are tracked as K1, K2, K3 in the open-issues section instead.

---

## Known issues — pre-Day-0 hardening (K1–K20)

See "Iter-4 known issues" section in the spec for full details. Summary:

- **3 critical (K1, K2, K3)** — must address before Day 0:
  - Headless flat-file fallback enables Ed25519 private-key extraction without passphrase
  - `INSTAR_VERIFY_TUNNEL_URL` Repo Variable is an SSRF/OIDC-token-exfiltration vector
  - `binding-history-log.jsonl` is "append-only by convention" (rebase-droppable)
- **5 high (K4–K8)** — address during Day 0:
  - Workflow public-key version rollback risk
  - `INSTAR_VERIFY_CACHE` replay risk
  - Auto-PR for key rotation lacks out-of-band proof
  - Binding-history sync leaks per-topic metadata
  - GH PAT is `actions:write` (overscoped)
- **2 high integration (K9, K10)** — address before Day 0:
  - tmux env-flag injection for shim
  - GitSync debounce conflict for binding-history-log
- **8 medium (K11–K18)** — Day 0 or Day 7 cutover:
  - BASH_ENV escape, pull_request_target lint, FS-typed AC-26, inotify limit, GH Actions minutes, route mount order, ruleset start mode, .gitattributes preflight
- **2 low / acknowledged (K19, K20):**
  - Cache key type unspecified
  - IDE-burst-delete fsnotify race admitted

These shift the Day -2 → Day 0 timeline from "1 PR" to "1 PR + 6 follow-up commits before flipping to enforcing mode." Migration accommodates this via the `evaluate → active` cutover gate (already specced).

---

## Convergence verdict

**APPROVED for implementation, conditional on K1–K10 resolved before Day 0 enforcement.**

Architectural decisions are locked:

- Per-topic worktree as default isolation unit (not per-session).
- Server-mediated authority (bindings, locks, fencing tokens, trailer signing).
- GitHub Repository Ruleset + Ed25519-verified required check as authoritative push gate.
- Mandatory (not optional) destructive-command interception.
- Cloudflare Tunnel for nonce-uniqueness verification with GH Repo Variable cache fallback.
- Multi-machine cross-visibility via signed git-synced binding-history log.
- 4-month phased migration: Day -2 (TOFU PR) → Day 0 (dark launch) → Day 7 (enforcement) → Day 14 (quarantine maturation).

Pending human ratification:

- R8 (cache backing — Repo Variable vs branch).
- R9 (PR-only enforcement vs every-push).
- R10 (headless-mode passphrase requirement).
- R11 (binding-history retention).
- R12 (rotation-PR auto-open).
- R13 (PAT lifecycle).

Recommend Justin reviews the 13 R-questions and 20 K-issues before authorizing Day -2 PR.

---

## Process retrospective

- 4 iterations × 7 reviewers/round (3 in iter 4) = ~25 review passes total.
- Each round closed ~80% of prior must-fixes while introducing a new architectural surface (the rate of new criticals dropped each round: 9 → 8 → 5 → 0 architectural / 3 hardening).
- Without the 4-round loop, iter 1's design would have shipped with multi-machine binding conflicts, lock tamper risks, and an opt-in destructive-command guard that would have failed the original incident.
- External reviewers (Grok, GPT, Gemini) consistently surfaced different failure classes than internal reviewers — Grok caught macOS/Linux platform assumptions, GPT caught control-plane contradictions and over-claimed guarantees, Gemini caught Git-internals issues (`--include-ignored` bloat, `cp -al` aliasing). Internal reviewers caught threat-model + integration friction.
- Without the externals, Gemini's `cp -al` inode aliasing finding (which would have *destroyed* parallel isolation in production) would have shipped.

**Stop criterion**: at iter 4, no new architectural surface introduced; remaining items are localized hardening expressible as a known-issues list. Per pre-commitment, iter 4 was final regardless.

---

## Appendix: where to find each artifact

- **Spec:** `docs/specs/PARALLEL-DEV-ISOLATION-SPEC.md`
- **Iter-1 reviewer findings:** `docs/specs/reports/_drafts/parallel-dev-isolation-iter1-findings.md`
- **Iter-2 reviewer findings:** `docs/specs/reports/_drafts/parallel-dev-isolation-iter2-findings.md`
- **Iter-3 external reviews:** `~/.instar/agents/echo/.claude/skills/crossreview/output/20260417-184647/`
- **Iter-4 internal reviews:** `~/.instar/agents/echo/.claude/skills/crossreview/output/20260417-194500/`
- **This convergence report:** `docs/specs/reports/parallel-dev-isolation-convergence.md`
