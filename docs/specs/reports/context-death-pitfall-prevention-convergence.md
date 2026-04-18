---
title: "Context-death pitfall prevention — Convergence Report"
spec: docs/specs/context-death-pitfall-prevention.md
converged-at: "2026-04-17"
iterations: 4
verified-iterations: 5
author: Echo
---

# Convergence Report — Context-Death Pitfall Prevention

## ELI10 Overview

Sometimes Claude agents that are supposed to be working autonomously just… stop in the middle of a job. They tell you they're "being careful not to run out of memory" and ask you to type "continue" to keep going. This is annoying, and it's also wrong — our system is already set up to keep agents working through those memory-pressure moments. They just panic unnecessarily.

This spec is a fix for that panic. When an agent is about to stop for "memory" reasons AND there's clear evidence on disk that the work is mid-flight (a plan file, a recent commit), a small specialist (an LLM called the "authority") looks at the situation and, if the evidence clearly shows "you're fine, keep going," it tells the agent to keep going and gives it a short reminder of what to do next. Casual chatting sessions are untouched.

Crucially, this is **not a security system**. If an agent actively wanted to defeat the gate, it could — it has full access to its own settings files. We're not trying to stop a malicious agent; we're trying to nudge a well-intentioned confused one. That scoping, clarified in iteration 4, was the single biggest clarity win in this whole review process.

## Original vs Converged

**Original (iteration 1):** A three-part design — identity text saying "don't stop for context reasons," a new LLM gate at the Stop event, and an end-to-end test. Simple, but under-specified about *how* the gate authority avoided being another brittle blocker, and under-specified about how the gate protected itself from the very agent it was judging.

**Converged (iteration 4):** Same three parts, significantly hardened and honestly scoped:

- The gate authority decides, but it can only cite rules from an enumerated list and must point at evidence from a pre-enumerated set — it can't invent plan filenames or cite rules that don't exist.
- Reminder text is server-assembled from templates; the authority can't smuggle free text into the agent's context.
- The gate's own state (mode, continue-counter, kill-switch) lives in the server's SQLite DB, NOT in the project tree where the session could edit it. This is enough for drift correction, even though not bulletproof against a truly adversarial session.
- The rollout is gated on real measured evidence: ≥20 human-reviewed correctness annotations from ≥2 operators, ≥14 days shadow, cold-start latency separately tracked, and a kill-switch that works via both a fast local path and a git-sync fanout.
- Cross-platform bugs (`stat -f` BSD-only; client timeout cutting server budget short) were caught and fixed.

The biggest *conceptual* change between iteration 2 and iteration 4: iteration 2 tried to defend against an adversarial agent that edits its own config to bypass the gate. Iteration 3's review surfaced that many of those defenses (elaborate reflog checks, ephemeral tokens, cross-machine signed broadcasts) were spoofable anyway and adding complexity without actually helping. Iteration 4 explicitly reframed the threat model as **drift-correction** — the common failure mode — and dropped the elaborate adversarial-scope defenses. The spec got smaller, simpler, and more honest in iteration 4. That was the key unlock for convergence.

## Iteration Summary

| Iter | Reviewers who flagged | Material findings | Spec changes |
|------|----------------------|-------------------|--------------|
| 1 | initial draft (security/scalability/adversarial/integration baked in) | ~30 (S1-S5, SC1-SC7, A1-A8, I1-I13) | Initial spec with prior-round findings embedded |
| 2 | security, scalability, adversarial, integration, GPT, Gemini(partial), Grok | 50+ across 14 clusters | Major rewrite: server-owned state, SQLite counter, AF_INET loopback listener, ephemeral token, structural evidence verifier, server-table reminder tracking, stratified flip criteria, multi-machine kill-switch |
| 3 | security, scalability, adversarial, integration, GPT, Gemini, Grok | ~30 — most driven by adversarial-threat-model framing that was itself the problem. Real new bugs: F1 (routing error), F2 (`--since` excludes unmodified pre-session files), F3 (compaction-defer causes context_length_exceeded) | Reframed threat model to drift-correction; fixed F1/F2/F3; dropped elaborate adversarial defenses; pinned all open questions |
| 4 | consolidated internal + GPT + Gemini + Grok | 8 surgical (timeout off-by-one, Linux btime portability, session-start fallback direction, self-reference over-exempt, annotation threshold low, observability metric split, pseudocode clarity, compaction-allow ceiling) | 8 targeted edits in-place |
| 5 (verification) | GPT focused verification | **0 material new** | — |

## Full Findings Catalog

### Iteration 2 — Major clusters addressed

**Cluster 1 — Gate state in session write-reach** (S105, S106, S114, A100)
- Resolution: mode/counter/stuck-state moved to server SQLite; `INSTAR_STOPGATE_MODE` env override removed.

**Cluster 2 — Auth + loopback** (S100, S101, A115)
- Resolution iter-2: separate internal listener + ephemeral token.
- Revised iter-4: simple auth (existing authToken) on localhost endpoints; threat-model-scoped.

**Cluster 3 — Prompt injection** (S102, S108, S109, S110, A103, I115, R11-gpt)
- Resolution: structured JSON `untrusted_content` field; secret-redaction helper; server-assembled reminder templates (no free text from authority).

**Cluster 4 — Evidence-cite TOCTOU + spoofing** (S103, S104, S115, A104, R3-gpt, R2-grok, Gemini-R1)
- Resolution: authority selects from hook-enumerated artifact set (can't hallucinate paths); server post-verifier checks git object exists, file ctime unchanged, descendant relationship, at least one non-session-created artifact.
- Revised iter-4: reflog-based pre-session checks dropped as spoofable; primary pre-session signal is `introducingCommit` timestamp vs `sessionStartTs`.

**Cluster 5 — Compaction fail-open bypass** (S113, A113, R7-gpt, R5-grok)
- Resolution: compaction window bounded 60s; stale-compaction is logged.
- Iter-3/4: `compaction-defer` emitting block-with-reminder was itself a bug (F3) — forces context_length_exceeded. Fixed: compaction always routes to exit 0 with telemetry + per-session allow-ceiling N=3.

**Cluster 6 — Sidecar races + idempotency** (A109, A116, R6-gpt, R3-grok)
- Resolution: idempotency key = sha256(session_id + stop_reason + signals + minute); server caches 5 min; all counters in SQLite transactions.

**Cluster 7 — Rename + settings.json atomicity** (I100, I101, I112)
- Resolution: filename `autonomous-stop-hook.sh` preserved; router extends existing file; no rename operation.

**Cluster 8 — Flip-gate weakness** (A108, A110, R4-gpt, R10-gpt, R4-grok, R8-grok)
- Resolution: stratified ≥3 agents × ≥3 signals × ≥14 days × ≥50 evals × ≥20 human-reviewed annotations from ≥2 operators; CLI refuses flip below thresholds.

**Cluster 9 — Detector sandbagging + self-reference** (A101, A102, R4-gpt)
- Resolution: `suspiciouslyQuiet` signal; self-reference exemption with canonical-path anchoring and majority-canonical scoping.

**Cluster 10 — Identity-text over-reliance** (A106, R5-gpt)
- Resolution: explicitly reframed as weak prior, not defense layer; not counted in defense-depth.

**Cluster 11 — Continue-ping confound** (A105)
- Resolution: three-way intent classification (intent_a/b/c); only intent_a counts against gate quality.

**Cluster 12 — Multi-machine rollout** (A107, I103, I106, SC107, R8-gpt)
- Resolution: kill-switch with fast-path local + git-sync fanout; `--wait-sync` with timeout + `--skip-machine`; machine-registry leader election for aggregation.

**Cluster 13 — Scalability** (SC100-111)
- Resolution: SQLite-backed counters + log (no PIPE_BUF); admission-control 503 on queue-shed; batched hot-path endpoint (single RTT for 5 state fields); file-TTL cache for 60s; bounded ledger tail-reads; cold-start warmup.

**Cluster 14 — Rollout machinery** (I102, I104, I107, I108, I109-I113)
- Resolution: marker-block pinning via sidecar file; `HOOK_LIB_VERSION=1` contract; startup staleness attention-queue; `/health` version + minimum; per-PR compaction test; branch-protection PR deps; `guardian-pulse` consumer in PR0c; backup/restore doc.

### Iteration 3 — Critical structural bugs (introduced by iter-2)

**F1 — Router excluded autonomous from gate** (Gemini)
- Issue: iter-2's router placed `unjustified-stop-check` in the `else` branch, meaning autonomous sessions (the exact case we target) never went through it.
- Fix iter-4: autonomous and non-autonomous both go through the check; the check's outcome is authoritative for the Stop event.

**F2 — `--since=<sessionStartTs>` excluded unmodified pre-session plan files** (Gemini, Grok)
- Issue: `git log --since=<sessionStartTs>` only returned files modified during the session; unmodified plan files (the common case) were invisible → fast-path exit-0 → complete bypass.
- Fix iter-4: `git ls-files` enumerates all tracked plans; per-file classification via `introducingCommit` timestamp.

**F3 — `compaction-defer` forces context_length_exceeded** (Gemini)
- Issue: iter-2 emitted `decision: block` during compaction, which forces Claude to try another turn; that turn hits context_length_exceeded because compaction runs because the window is full.
- Fix iter-4: compaction always exits 0 with telemetry; N=3 allow-ceiling per session prevents compaction-loop.

### Iteration 3 — Adversarial-model findings (out of scope after threat-model reframing)

The following are real in an adversarial threat model but explicitly out of scope per iteration-4's drift-correction declaration:

- A200 (self-reference glob gameable)
- A201 (kill-switch session-writable via registry)
- A202 (reflog GIT_COMMITTER_DATE spoofable)
- A203 (compaction-defer reminder tagging) — also moot after F3 fix
- S201/S202 (reflog + plan-commit semantic linkage)
- S203 (conversation-window unimplementable as security boundary)
- I204 (internal token in env readable by session)
- I208 (SessionStart-down attack) — partially addressed via degraded-mode allow + DegradationReport

### Iteration 4 — 8 surgical findings

| ID | Severity | Finding | Fix |
|----|----------|---------|-----|
| Grok R4.1 | critical→clarity | Router pseudocode ambiguous about autonomous post-check behavior | Pseudocode explicitly states check outcome is authoritative |
| Gemini R1 | major | Client AbortController 1500ms < server budget 1800ms → spurious timeout | Client timeout raised to 2000ms |
| Internal R2 / Gemini R2 | major | `stat -f` BSD-only; breaks on Linux | `introducingCommit` git timestamp is primary; stat is advisory |
| Internal R1 | major | Compaction-allow no per-session ceiling | N=3 ceiling added |
| Internal R3 | major | Annotation threshold too low; single-reviewer closed loop | ≥20 / 5 of each / ≥2 operators |
| Internal R4 | major | Self-reference exemption over-triggered on incidental touches | Requires majority-canonical session work |
| Internal R5 | major-borderline | Session-start fallback biased late → over-continue | Unconditional allow + DegradationReport on server-down |
| Internal R6 | major | `invalidEvidence_on_continue_attempt` buried in aggregate SLO | Split as own SLO; <1% target, >2% alert |

### Iteration 5 (verification pass) — zero material findings

GPT confirmed all 8 iter-4 edits landed correctly; no new material issues surfaced under the declared drift-correction threat model.

## Convergence Verdict

**Converged at iteration 4.** Iteration 5 was a focused verification pass that confirmed all 8 surgical edits landed cleanly and introduced no new material issues.

The spec is approved by Justin (2026-04-17 06:24:43 EDT) and ready for implementation via the eight-PR sequence (PR0a, PR0b, PR0c, PR0d, PR1, PR2, PR3, PR4-shadow). PR5 (flip to enforce) is hard-gated on ≥14 days of shadow telemetry + ≥20 operator annotations from ≥2 distinct operators, and will be a manual operator decision after data accumulates.
