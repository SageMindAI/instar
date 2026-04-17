# Convergence Report — Subscription-first InputGuard routing

## ELI10 Overview

The agent has an "Input Guard" — a safety check that reads every incoming message and watches for signs someone is trying to sneak an instruction into a conversation where it doesn't belong (for example, a message tagged as being about cooking arriving in a session that's talking about taxes). The guard has three layers: Layer 1 checks the message's "from" tag, Layer 1.5 scans for obvious manipulation patterns, and Layer 2 is the smart one — it sends the message to a language model and asks "does this fit the current conversation?"

Until this change, Layer 2 had a plumbing problem: it always called the paid Anthropic API directly, even on machines where the user only has a free Claude CLI subscription. So if you didn't happen to set an `ANTHROPIC_API_KEY` environment variable, Layer 2 quietly did nothing, and your agent was running with reduced defenses without you knowing. This change fixes that by routing Layer 2 through a shared "intelligence provider" that automatically prefers the free subscription and only uses the paid API when you've explicitly chosen to. The agent now also announces itself loudly if no intelligence is available at all, so a degraded state can never be silent.

The review rounds surfaced that doing the plumbing swap correctly required a few related improvements: making the timeout longer (because the CLI subprocess takes a beat longer to start than a raw HTTPS call), and hardening Layer 2's behavior when it gets a malformed response (by emitting a warning rather than silently passing), among others. The converged spec ships those together as one coherent change.

## Original vs Converged

The initial spec described a simple transport swap: add an `IntelligenceProvider` parameter to the Input Guard, keep the old `apiKey` parameter as a fallback, and wire startup so the provider is always available when the guard is built. Parallel review by four independent reviewers (security, scalability, adversarial, integration) surfaced that the "keep the old fallback" approach left several subtler bugs:

- A machine where the shared provider failed to initialize but had an API key in the environment would silently fall back to the paid API, quietly violating the subscription-first principle.
- The `apiKey` captured at guard construction introduced a credential-rotation race.
- More importantly, an attacker who could influence the language model's output (for instance, by including phrases in their message that nudge the model's response format) could reliably trigger the guard's existing "malformed JSON → pass silently" path. This was a deterministic Layer 2 bypass that had been present the whole time but would have remained hidden if the spec simply preserved legacy behavior.
- On the subscription path, the existing 3-second review timeout was likely to produce more timeouts than the direct HTTPS path had, because spawning a CLI subprocess is slower than opening an HTTPS connection.

The converged spec removes the old fallback entirely — the Input Guard no longer holds a direct transport at all, only a reference to the shared provider. It changes the "malformed JSON" path to surface a low-confidence "suspicious" warning rather than pass silently. It raises the effective review timeout to a floor of 8 seconds. It also tones down the external-channel impact string in the startup degradation event — so a compromised Telegram channel can't be used to read out "which defenses are currently down."

Several broader concerns surfaced by review are acknowledged and scoped into separate follow-up specs, rather than shoehorned into this one. Those include: a consecutive-failure escalation state machine so persistent transport failure flips the guard into a "suspicious-by-default" posture; a concurrency cap on the provider abstraction so bursts of messages can't spawn unbounded subprocesses; subprocess abort-signal plumbing so timeouts actually kill subprocesses instead of orphaning them; and verification that the CLI provider passes prompt content via stdin only, never argv or environment. These are real and important but are provider-layer concerns rather than guard-routing concerns. The spec names each one explicitly so it doesn't get lost.

## Iteration Summary

| Iteration | Reviewers who flagged material findings | Material findings | Spec changes |
|-----------|------------------------------------------|-------------------|--------------|
| 1         | security (4), scalability (3), adversarial (5), integration (0 material + 2 LOW notes) | 12 | Dropped the direct-API/apiKey fallback entirely. Added fail-closed-to-warn on malformed JSON. Raised effective timeout floor to 8s. Generic external impact string in DegradationReporter. Added explicit "Deferred follow-ups" section with rationale for each deferred item. |
| 2         | security (2 LOW), scalability (1 LOW), adversarial (2 LOW), integration (0 + 1 cosmetic) | 5 LOW (all addressed or acknowledged) | Clarified timeout semantics — `reviewTimeout` below 8000 is clamped up, not honored; added JSDoc on `InputGuardConfig.reviewTimeout` and a narrative paragraph in the spec. Cosmetic stale-copy in `trackErrors()` acknowledged as pre-existing, explicitly out of scope. |
| (converged) | — | 0 material | — |

## Full Findings Catalog

### Iteration 1

#### Security (4 material)

1. **[MEDIUM] CLI subprocess argv/env/stderr exposure vs HTTPS.** Prompt content flows through a subprocess transport rather than HTTPS. Could leak into `ps`, shell history, subprocess stderr.
   - *Resolution:* Partially addressed. The direct-API path is gone from InputGuard; all LLM traffic is provider-mediated. CLI-specific argv/stdin isolation is acknowledged but scoped to the provider layer as Deferred #4 — it is a provider-implementation concern that would reshape every consumer if fixed there.

2. **[MEDIUM] Exploitable fail-open on quota exhaustion / transport failure.** An attacker could flood the guard with untagged messages, blow the subscription quota, and every subsequent message would fail-open silently.
   - *Resolution:* Partially addressed. The malformed-JSON variant — the deterministic attacker-controlled bypass — is closed (see Adversarial #1). The quota-exhaustion / transport-flake fail-open remains at the transport boundary (fail-open on transport error is the intended behavior to avoid warn-spam). Consecutive-failure escalation to sticky-suspicious state is Deferred #1 with documented rationale (needs its own design to balance safety and warn-spam).

3. **[LOW→MEDIUM] DegradationReporter impact string enumerates capability-down map on external channels.** The startup degradation event listed every LLM-gated defense that was down and broadcast it through Telegram/feedback, handing an adversary a ready-made "which guards to bypass" checklist.
   - *Resolution:* Addressed. Spec and code now use a short generic external impact string; the detailed enumeration stays in the local console log and in `degradations.json`.

4. **[LOW] apiKey captured at construction; rotation race.** Constructor-captured apiKey is stale if env changes.
   - *Resolution:* Addressed. The `apiKey` parameter is removed from InputGuard's constructor entirely. The underlying provider-level race is acknowledged as Deferred #6.

#### Scalability (3 material)

1. **[HIGH] CLI subprocess p99 likely exceeds 3000ms reviewTimeout → more fail-opens.**
   - *Resolution:* Addressed. Effective timeout is now `max(config.reviewTimeout ?? 0, 8000ms)` — 8s floor. Iteration 2 surfaced that the FLOOR semantics were initially undocumented ("explicit config overrides") when the code actually clamps below-floor values up; spec and JSDoc now agree.

2. **[MEDIUM] Thundering herd — unbounded subprocess-per-message.**
   - *Resolution:* Deferred (acknowledged) #2. Provider-layer concurrency cap requires its own design. Input-volume ceiling on the subscription path is bounded by Telegram message rate; fail-open-at-transport-boundary means OOM pressure would surface as review timeouts rather than crashes.

3. **[MEDIUM] Timeout orphans subprocess — no AbortSignal plumbing.**
   - *Resolution:* Deferred (acknowledged) #3. Provider-layer concern. The new 8s floor slightly worsens per-event orphan duration but drops the orphan rate overall. Flagged in the deferred spec as a reason to prioritize it.

#### Adversarial (5 material)

1. **[HIGH] Prompt-injection → malformed JSON → fail-open bypass.** Attacker crafts message content that pushes the LLM toward malformed output; parse fails; old code silently returned `coherent`.
   - *Resolution:* Addressed. `parseReviewResponse` on malformed JSON now returns `verdict: 'suspicious'` with `confidence: 0.3` and a degradation log — fail-closed-to-warn. Under the default `action: 'warn'`, this surfaces a non-blocking system-reminder rather than silently passing.

2. **[HIGH] Transport-degradation bypass via induced CLI failure.**
   - *Resolution:* Partially addressed. The immediate bypass (malformed JSON) is closed. Consecutive-failure escalation is Deferred #1 with documented rationale. Existing `trackErrors()` counter surfaces 3-failures-in-10-min via attention queue as an observability floor, so persistent CLI disruption is no longer silent. Accepted as ship-blocking threshold not reached.

3. **[MEDIUM] Silent subscription→billed-API downgrade via init race.**
   - *Resolution:* Addressed. The apiKey fallback is gone. No route exists from InputGuard back to `api.anthropic.com` except through the explicitly-selected shared provider.

4. **[MEDIUM] Stale-provider reference after swap.**
   - *Resolution:* Deferred (acknowledged) #7. No hot-swap mechanism exists today; a mutator can land when it does.

5. **[MEDIUM] Agent-in-the-middle via CLI.** A local attacker replacing the CLI binary controls every verdict.
   - *Resolution:* Deferred (acknowledged) #4/#5. Provider-level trust issue. Appropriate layer for the fix.

#### Integration (0 material)

- LOW: Dashboard "Guard backend" visibility is a pre-existing observability gap.
- LOW: `instar doctor` / `status` has no InputGuard check.
- *Resolution:* Both acknowledged as pre-existing gaps. Not expanded by this change. Followup items.

### Iteration 2

1. **[LOW] Timeout-config semantics silently coerce user intent.** Raised by security + adversarial reviewers. Documentation said "explicit config overrides" but code clamps values below 8000 up to the floor.
   - *Resolution:* Addressed. Spec wording changed to "floor, not default." JSDoc added to `InputGuardConfig.reviewTimeout`. Code comment explains the rationale inline.

2. **[LOW] 8s floor × orphaned subprocess = slightly worse tail memory.** Raised by scalability.
   - *Resolution:* Acknowledged. Flagged as a reason to prioritize Deferred #3 (subprocess abort plumbing). No code change needed here; the tradeoff (lower timeout rate at the cost of slightly longer per-orphan wall-time) is net positive.

3. **[LOW] `parseReviewResponse` greedy-brace regex.** Benign — worst case triggers the new fail-closed-to-warn path, which is by design.
   - *Resolution:* Acknowledged. Monitoring the degradation-log volume will surface if a provider legitimately pretty-prints and triggers repeated warn events.

4. **[LOW / cosmetic] `trackErrors()` attention-queue body still references "Anthropic API status."** Stale copy now that the transport is provider-mediated.
   - *Resolution:* Explicitly out of scope for this spec (it's a pre-existing string, unchanged by this work). Noted as a cleanup item in the follow-up backlog.

## Convergence verdict

**Converged at iteration 2.** No blocking material findings remain. All iteration-2 findings are LOW severity; the actionable ones (timeout semantics, spec/code wording alignment) have been addressed in a single additional code + spec edit. Remaining items are either explicitly deferred to named follow-up specs (with rationale for the deferral) or pre-existing cosmetic cleanups outside this spec's scope.

The converged spec is significantly more honest than the initial version: the initial spec described a simple transport swap, but the review surfaced that doing the swap *without* dropping the old fallback, tightening the malformed-JSON path, and raising the timeout floor would have shipped several latent bugs. The converged version ships one coherent change that closes all of those at once, while scoping the broader provider-layer hardening to named follow-ups.

Ready for user review and approval.
