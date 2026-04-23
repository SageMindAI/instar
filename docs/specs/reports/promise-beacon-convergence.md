# Convergence Report — Promise Beacon

## ELI10 Overview

You already have two helpers that notice silence. One pokes me when you ask something and I go quiet — "standby." Another checks that when I say "I changed your config," the config stays changed — the commitment tracker. Neither helper notices when I say "I'll come back when round 3 is done" and then work silently for an hour.

The Promise Beacon is a third helper that watches exactly that gap. When I make a follow-up promise tied to a chat topic, the beacon writes it down. If I go quiet past the cadence I promised, the beacon reads what I'm working on and posts you a one-line "still alive, still progressing" note. If the session I was working in restarts or dies, it tells you that instead of pretending progress is happening. When the work is actually done, I mark it delivered and the beacon stops.

What changes for you if this ships: you can ask me to do things that take an hour or two without attention and trust that you'll hear a beat from me every 10–15 minutes whether I remember to or not. If anything goes wrong — session crashed, stuck, deadline missed — you find out from the system, not from eventually noticing the silence. The main tradeoffs: a modest LLM bill (capped at ~$1/day worst case), a new emoji prefix (`⏳`) reserved for these pokes, and a handful of new guardrails to make sure the beacon never lies to you about progress it can't actually see.

## Original vs Converged

**Original plan (v1).** Build a new ledger, a new monitor, a new auto-parser for detecting promises in agent messages, a new dashboard tab, optional git-sync of the whole thing across machines.

**Converged plan (v3).** One of those four pieces is new — the monitor. The ledger is the existing CommitmentTracker, extended with additive optional fields. The auto-parser is the existing CommitmentSentinel with a propose-only path. The dashboard extends the existing commitments surface. None of the beacon state is git-synced (early review caught that remote machines could inject messages by planting entries in a synced file).

**What review changed, in plain terms.**

- **Don't share state across machines by default.** The first draft casually said "git-sync the ledger" — a tampered commit on one machine could make another machine send you messages. Fixed by splitting hot state (per-machine, gitignored) from cold state (declaration record only), and running only on the "awake" machine in Phase 1.
- **Don't pay the AI tax if nothing changed.** The first draft called the summarizer model every cycle even when the work output was identical. Fixed with a hash gate — if the output looks the same as last time, we emit a templated "still working" without touching the model. Cuts cost by ~70%.
- **Don't pretend progress you can't see.** The first draft would have the summarizer describe progress even when the session had died or restarted. Fixed by checking session identity and aliveness before every heartbeat; on mismatch, we tell you the session is gone, we don't invent progress.
- **Don't auto-kill promises when the model guesses "stuck."** Original violated a commitment whenever the escalation model said it looked stalled. Too much authority. Fixed with an `atRisk` intermediate state — the model flags concern, you get a softer notice, and terminal violation requires corroboration or a hard signal (session dead, deadline passed).
- **Don't silently withdraw promises for capacity reasons.** Original boot-cap overflow "withdrew" commitments above the cap. "Withdrawn" implies intent; capacity discards aren't intent. Fixed with a new `beaconSuppressed` flag that keeps the commitment pending but quiet.
- **Don't violate everything when the server restarts.** Original `sessionEpoch` included the server boot id — redeploying the server would falsely violate every live promise. Fixed by removing server boot id from the epoch; only the underlying session identity matters.
- **Make the background-vs-interactive lanes actually preempt.** Original said "interactive preempts background" without saying how. A background LLM call mid-flight would block the interactive request until done. Fixed with `AbortController` — the queue actively cancels the lowest-priority in-flight background call when an interactive call arrives.
- **Let me see my own promises.** The agent had no way to know it was on the clock across compaction. Fixed with a read-only `<active_commitments>` context injection.
- **Don't trust a single emoji.** Original used `⏳` as the skip-match key — a user typing `⏳` in their own message would be filtered. Fixed with server-stamped metadata as the real skip signal; the emoji is just rendering.
- **Split deadline concepts.** "Every promise must have a hard deadline" pushed callers toward arbitrary deadlines. Fixed with `nextUpdateDueAt` / `softDeadlineAt` / `hardDeadlineAt` — pick what's actually meaningful.
- **Cleanup around the edges.** Payload size limits defined (no more 10MB promise text); loopback defined (tunnel requests are not loopback); multi-user activation defined; archive file bounded (10MiB then rotate+gzip); timer handler wrapped in try/catch; heartbeat message policy (rotating phrasings, do-not-disturb hours, per-topic verbosity); emoji fallback for plain-text adapters.

## Iteration Summary

| Iteration | Reviewers | Material findings | Major spec changes |
|-----------|-----------|-------------------|--------------------|
| 1 | security, scalability, adversarial, integration | ~50 | Full reframe: reuse CommitmentTracker + Sentinel; hot/cold storage split; setTimeout scheduling (not poll); snapshot-hash gate; session-epoch check; owner-machine gating; metadata-based skip match; 15+ security/concurrency guards. |
| 2 | security, scalability, adversarial, integration | ~35 | `CommitmentTracker.mutate()` prerequisite PR; `ProxyCoordinator` full adoption (PresenceProxy refactor in-scope); LlmQueue priority lanes; sessionEpoch formula; canonical sanitizer (NFC + confusables); payload caps; no default `hardDeadlineAt`; boot-order contract; in-memory indexing; cross-file atomicity ordering; ~20 other tightenings. |
| 3 | GPT-5.4, Gemini-3.1-pro, Grok-4.1-fast + internal convergence-check | ~20 | `atRisk` non-terminal state; `beaconSuppressed` replaces boot-cap withdraw; `serverBootId` removed from epoch; `AbortController` preemption; tmux capture settle + byte-cap; agent awareness of own commitments via context injection; deadline-split (`nextUpdateDueAt` / `softDeadlineAt` / `hardDeadlineAt`); failover policy Phase 1; heartbeat tone policy; Sentinel propose-only default; 5xx/429 + circuit breaker; UTC normalization; clamp-transparency warnings; timer durability across sleep; `delivered` terminal status distinct from `verified`; audit retention; prompt skeletons inline. |

Round 3 closed on the internal convergence-check's verdict **CONVERGED with editorial fixes** (all applied) plus cross-model substantive findings (all folded in). External verdicts: Grok APPROVE (9/10, zero criticals). Gemini CONDITIONAL APPROVAL (9/10, three criticals addressed). GPT CONDITIONAL (8.5–8.7/10, six criticals addressed).

## Convergence Verdict

**Converged at iteration 3.** No architectural concerns remain. All findings from rounds 1–3 are either resolved in the spec body or absorbed into the "Round 2 clarifications" / "Round 3 (cross-model) clarifications" sections. Residual items are ratification requests (prefix choice, spend-cap default, Sentinel auto-enable policy, quiet-hours default) — the user's call, not the reviewers'.

Spec is ready for user review and approval. Approval flips `approved: true` and unblocks `/instar-dev`.
