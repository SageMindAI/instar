# Convergence Report — Threadline Cooldown & Queue Drain

**Spec:** `docs/specs/THREADLINE-COOLDOWN-QUEUE-DRAIN-SPEC.md` (v7)
**Converged at:** 2026-04-18
**Iterations:** 7 (6 internal + 1 cross-model)
**Final spec status:** converged, awaiting user approval

---

## ELI10 Overview

Two parts of the agent system were failing to talk to each other reliably. If you sent a burst of messages to another agent, a cooldown would kick in after the first one, and the follow-ups would pile up in a silent queue that nothing was watching. Eventually the messages would get delivered, but only if someone else happened to come along and kick the queue — if nobody did, the messages just sat there forever.

The plan fixes three real bugs:
- The silent queue now has a steady heartbeat that empties it on its own.
- The knob that controls the cooldown can now actually be turned by operators (it existed on paper but was never wired up).
- When the same agent sends several messages in a row, follow-ups now join the session that's already running instead of trying to start a new one and getting blocked.

The tradeoff is complexity: making these fixes safely means a lot of careful guardrails against abuse (a mean peer sending bad messages, an operator clicking the kill switch by accident, two messages colliding in a race, etc.). The spec designs each guardrail explicitly and measures the cost.

If this ships well: bursts feel snappy, silent drops go away, and operators can tune things without a code change. If it ships badly: new attack surfaces around session hijacking or queue poisoning. The design goes to some length to close those.

## Original vs Converged

**Originally**, the plan was a three-item bullet list with rough outlines — "add a drain timer, plumb the config knob, look into why follow-ups spawn fresh sessions." It took the first-analysis-was-correct framing and sketched a direct fix path.

**After review**, several things shifted:
- The "look into follow-up spawning" item turned out to have a much more specific root cause than guessed — the receiver mints a new thread-id when the sender doesn't provide one, and the sender never provides one. The fix moved from "normalize keys" (the first sketch) to "client-side session affinity plus authenticated receiver-side fallback," a substantially different mechanism.
- The penalty for misbehaving peers originally would have silenced the *victim* — a peer could send bad messages and force the receiver to apply the cooldown penalty to itself. Review caught this. The penalty now attributes the failure to the sender and applies to *them*, not the victim.
- Several claims in the plan (a Zod validator feature, a scoped-token auth layer, a dashboard plugin pattern) turned out not to exist in the actual codebase — the plan was leaning on infrastructure that doesn't ship. Each was reworked to use what's actually there.
- A scheduling rule meant to be "fair" turned out to do nothing because the math mixed two numbers of wildly different scales (one in 0–3 range, the other in millions of milliseconds). Review caught this — the first four reviewers missed it, a cross-model reviewer caught it. Swapped to a standard fair-scheduling algorithm (Deficit Round Robin).
- Many small reinforcements: uniform error responses so a peer can't fingerprint which rejection fired; a nonce system for kill-switch PATCHes so a stolen token can't silently disable protection; monotonic time so cooldown math survives clock skew; message-lifecycle diagram clarifying which component owns what.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|----------------------|-------------------|--------------|
| 1 (internal) | all 4 (security, scale, adversarial, integration) | 29 | v2 — comprehensive rewrite |
| 2 (internal) | all 4 | 22 (incl. 2 codebase fabrications) | v3 — regrounded in real codebase |
| 3 (internal) | all 4 | 10 (high-severity dropped) | v4 — attribution, scope, admission order |
| 4 (internal) | 3 (integration converged at 0) | 10 (mostly MED/LOW) | v5 — epoch scoping, oracle closure |
| 5 (internal) | all 4 | 7 (mostly LOW) | v6 — nonce, padding, cold-start polish |
| 6 (internal) | all 4 | 1 (LOW — one-line fix) | v6.1 — nonce confirm-time TTL |
| 7 (cross-model) | GPT CONDITIONAL, Gemini APPROVE, Grok APPROVE | 15 (all material) | v7 — integrated all cross-model findings |

## Convergence Verdict

**Converged at iteration 7.** Internal reviewers reached convergence at round 6 (one LOW finding, applied inline). Cross-model review (GPT 5.4, Gemini 3.1 Pro, Grok 4.1 Fast) surfaced 15 additional material findings, all integrated into v7. Gemini and Grok both issued APPROVE verdicts on v6; GPT issued CONDITIONAL. v7's additions (DRR scheduling, triple-bound nonce, Promise.allSettled, typed-error classifier, lifecycle state machine, monotonic time, operational observability, hash versioning, payload cap, audit log retention) address every CONDITIONAL item. No further review round is required.

Spec is ready for user review and approval.

## Full Findings Catalog

See `.claude/skills/crossreview/output/20260418-221510/` for full per-reviewer reports (gpt.md, gemini.md, grok.md) and synthesis.md.
