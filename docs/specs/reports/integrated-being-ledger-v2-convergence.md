# Convergence Report — Integrated-Being Ledger v2

**Spec:** [docs/specs/integrated-being-ledger-v2.md](../integrated-being-ledger-v2.md)
**Slug:** `integrated-being-ledger-v2`
**Converged at:** 2026-04-17T01:45Z (partial — see "Convergence Verdict" below)
**Iterations:** 3
**Final-round material findings:** varies by reviewer — 4/7 zero, 1/7 APPROVE, 2/7 architectural-deferred

---

## ELI10 Overview

The Integrated-Being Ledger v1 fixed a real problem — different parts of your agent couldn't tell what the other parts were doing. When a subsession reached an agreement with Dawn, your user-facing session had no idea. v1 added a shared append-only log that server-side subsystems write into and any session can read. That shipped and works.

But v1 was the READ side only. It couldn't help with the *other* half of the problem that surfaced the very next day: sessions making promises nothing could back ("I'll relay Dawn's response") and subsessions making substantive agreements (API contracts, integration designs) that nobody upstream could see.

v2 is the WRITE side. It adds three things. First, a new "commitment" entry type that carries a mechanism (how will this be backed — a job? a scheduled check? nothing?), a deadline, and a status. Second, a sanctioned session-write endpoint with proper authentication — sessions can now say "I am committing to X, here's my mechanism" and it gets recorded in a way other sessions can see. Third, a resolution workflow so commitments can be marked resolved (by the session, by a server-side witness, or by you at the dashboard) with tiered trust levels.

The promise this spec makes: if an agent session says "I'll do X by Y," there's now a durable place for that promise to live, a mechanism for it to be backed, and a way to see when it isn't. The commitments become visible infrastructure rather than decorative words.

## Original vs Converged

The review process, spanning three full iterations with seven parallel reviewers per iteration (four internal claude subagents + three cross-model externals — GPT, Gemini, Grok), forced substantial hardening of the initial draft. Twelve changes worth calling out:

1. **Mechanism refs are validated at write, not pinned-on-hope.** The original draft accepted any `mechanism.ref` as "valid" without checking. An adversarial reviewer caught that this lets sessions forge backed commitments for non-existent jobs. Now the server performs an in-memory lookup against the relevant registry (job scheduler, sentinel registry, callback allowlist) at write time and freezes the result.

2. **Near-duplicate detection folds visual homoglyphs.** The original NFC+lowercase normalization let a Cyrillic `а` bypass a dedup check against a Latin `a`. Now uses NFKC + Unicode confusables skeleton — folds visual-equivalent variants into one canonical form.

3. **Disputes are NOT chained via supersedes.** Original design stored disputes as entries in the supersession chain, which meant the 17th dispute hit the depth-16 cap and was silently lost. Now disputes use a dedicated `disputes: <id>` field, separate from the chain. The chain is reserved for state transitions (resolve/cancel/expire/strand) which are bounded by the commitment's lifecycle.

4. **User-resolve requires real auth.** Original design used an `X-Instar-Request: 1` header — the same pattern as casual dashboard calls. An external reviewer flagged that any process with the bearer token can set that header. Tightened to require a PIN-unlock within 15 minutes plus rotation on success.

5. **Session self-assert is creator-only.** Original allowed any session to self-assert any commitment as resolved — a cross-session hiding attack. Now only the creating session can self-assert; other sessions must use the visible `dispute` path.

6. **Deadlines are sanity-checked.** Original accepted any ISO timestamp. Now rejects past-dated and far-future deadlines (60s minimum, 90 days maximum) to prevent "written-already-expired" narrative spoofing.

7. **Dispute count is derived from the ledger, not in-memory.** Original tracked dispute counts in memory; server restart reset them, breaking the "3 disputes in 24h triggers escalation" contract. Now computed from ledger entries on render. Grok and Scalability reviewers independently caught this.

8. **Token handoff is race-safe.** Original wrote the token file then the ready marker. An adversarial reviewer noted a sibling-process race window. Now uses O_EXCL + atomic rename + mode verification + fail-CLOSED if mode is wrong.

9. **REST fallback has server-side attestation.** Gemini flagged that the naive REST fallback bypassed the 0o600 file boundary. Tightened: the fallback requires the hook to have called session-bind within 30s and not yet received a token. Bearer-token alone is insufficient.

10. **passive-wait requires a deadline.** Without this, passive-wait commitments would accumulate forever with no expired-sweep trigger.

11. **Divergent-hook migration has explicit modes.** `instar migrate sync-session-hook --v2 --mode=inject` (default, marker-scoped, idempotent) vs `--mode=overwrite` (destructive, with pre-migration backup). Echo-style custom hooks now have a concrete migration path.

12. **dedupKey is an idempotency key.** A client that times out mid-write and retries gets the same entry id back (with `X-Idempotent-Replay: 1`), not a duplicate entry. Closes the ack-before-durable-flush retry-correctness gap GPT flagged.

About sixty material findings total across three iterations. Many were cross-confirmed across independent reviewer perspectives — e.g., dispute-count restart-loss flagged by both Grok (external) AND Scalability (internal); token race flagged by both Adversarial (internal) AND Gemini (external) — a strong signal the issues were real, not noise.

## Iteration Summary

| Iteration | Internal converged | External verdicts | Material findings |
|-----------|--------------------|--------------------| ------------------|
| 1         | 0 / 4 (all flagged — Security minor, Scalability minor, Adversarial serious, Integration serious) | GPT 7/10, Gemini 8/10, Grok 9/10 (all CONDITIONAL) | ~30 |
| 2         | 2 / 4 (Security, Scalability converged) | GPT 8/10, Gemini 8.5/10, Grok 9/10 | ~15 (mostly NEW, emerging from iter-1 fixes) |
| 3         | 4 / 4 (all internal converged) | GPT 8/10 CONDITIONAL, Gemini 7/10 CONDITIONAL (regressed — deeper architectural finding), Grok 10/10 APPROVE | ~8 total, 3 architectural-deferred |

## Convergence Verdict

**Partial convergence.** Four internal reviewers converged fully at iter 3. One external (Grok) approved. Two externals (GPT, Gemini) still flagged real concerns, most of which were addressed in-spec during iter 3 (stranding timeline contradiction, resolve endpoint schema, dedupKey idempotency). Three concerns remain documented as explicit open questions in the spec under "Open architectural questions":

1. **Session-bind privilege separation** (Gemini bootstrap confused-deputy): the bearer token a session uses for other calls can also call `session-bind`, bypassing the 0o600 file ceremony. True isolation requires a privileged channel — an architectural decision with real cost.

2. **Effective-status state machine** (GPT): conflicting resolution entries in a supersession chain are currently described in prose. A formalized state machine is v2.1 work.

3. **Interactive bind fallback challenge-response** (GPT): the time-window attestation is softer than a nonce-based proof. v2.1 work.

None of the three are blocking v2's practical utility. v2 can ship with `v2Enabled=false` as the spec specifies, collect 7 days of observational data, and if the architectural concerns haven't manifested as real problems, flip to true. The open questions are called out in the spec so they're not surprise-discovered later.

Strictly, per the `/spec-converge` skill's zero-material-findings criterion, this is NOT full convergence. The report is honest about that. The question for the user is: accept the current state and approve v2 with documented architectural limits, OR run a fourth iteration focused on resolving the three open architectural questions (which would likely require decisions about privilege separation, state machine formalization, and challenge-response design).

## Cross-model review status

Unlike v1 (where cross-model review was noted as not working), v2's convergence included full cross-model review across all three iterations: GPT, Gemini, and Grok via `call-llm.cjs`. All three returned substantive reviews with concrete findings. Gemini caught the bootstrap confused-deputy architectural concern that none of the internal reviewers surfaced — the value of genuinely independent perspectives is visible in the iteration log.

## To approve

Edit the spec's frontmatter at `docs/specs/integrated-being-ledger-v2.md`:

```yaml
approved: true
approved-by: "justin"
approved-at: "<ISO timestamp>"
```

Once the approved tag is present AND the review-convergence tag is populated (not currently — still `null` pending decision on the three open architectural questions), `/instar-dev` can proceed with implementation.

Recommendation: before approving, decide on the open architectural questions. Options: (a) accept them as v2 documented limits, tag convergence, approve — implementation starts; (b) run iter 4 to close them, re-convergence; (c) defer v2 and revisit the architecture.
