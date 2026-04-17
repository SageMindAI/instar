---
title: "Subscription-first InputGuard routing"
slug: "subscription-first-input-guard"
author: "echo"
created: "2026-04-17"
cluster: "subscription-first-intelligence"
review-convergence: "2026-04-17T16:40:00.000Z"
review-iterations: 2
review-completed-at: "2026-04-17T16:40:00.000Z"
review-report: "docs/specs/reports/subscription-first-input-guard-convergence.md"
approved: true
approved-by: "echo (delegated authority from Justin via Telegram topic 6655: 'you have my authority to follow through')"
approved-at: "2026-04-17T16:40:00.000Z"
---

# Subscription-first InputGuard routing

## Problem statement

The principle the team has adopted: every LLM-powered decision in instar defaults to the Claude CLI subscription, and the Anthropic API is opt-in only. This is enforced through the `IntelligenceProvider` abstraction — callers ask the provider to `evaluate()`, and the provider transparently chooses the CLI (subscription, zero-cost) or the Anthropic API (explicit opt-in) based on configuration.

An audit of runtime `ANTHROPIC_API_KEY` reads across `src/` surfaced one violation: `InputGuard` was constructed with a raw `apiKey` and called `fetch('https://api.anthropic.com/v1/messages', …)` directly for its Layer 2 topic-coherence review. On machines running only the Claude CLI subscription (no API key), Layer 2 silently no-opped — returning `verdict: 'coherent'` with no LLM evaluation at all. This left agents with unsupervised cross-topic injection risk without any signal that the supervisor had stopped running.

Three other runtime reads were already OK (`CoherenceGate`, `StallTriageNurse`, and the `AnthropicIntelligenceProvider` itself, which is the legitimate carrier). The rest of the grep hits were doc strings, CLI help text, Docker env clearing, and redaction regex.

A second gap: when neither the Claude CLI nor an API key is available at server startup, the code logged a yellow `console.log` line and moved on. There was no structured degradation event — nothing that routes to disk, Telegram alerts, or the feedback system. This is the exact "silent fallback" pattern the `DegradationReporter` exists to prevent.

## Goals

1. Route `InputGuard`'s Layer 2 topic-coherence review through the shared `IntelligenceProvider`, matching the pattern established by `CoherenceReviewer` (`3d4240a`) and `StallTriageNurse`.
2. Remove the direct-API fetch path from InputGuard entirely. Any Anthropic-API usage must flow through the shared provider abstraction (subscription-first, API opt-in at the *provider selection* layer, not at the guard layer).
3. Make startup degradation loud: when no `IntelligenceProvider` is available, emit a structured `DegradationReporter.report(...)` event so the condition is visible (console + disk + Telegram + feedback), not just a yellow log line. External-channel emission uses a generic impact string; the detailed capability-down list remains in local disk logs only.
4. Harden Layer 2's fail-mode so authority absence is treated as a warnable anomaly (not a silent pass) while preserving the existing `action: 'warn'` default — i.e., fail-closed-to-warn, never fail-closed-to-block.
5. Tune the review timeout when the provider is a CLI subprocess (which has higher cold-start p99 than the direct-HTTPS path had), so the ship doesn't regress from "LLM review ran" to "LLM review timed out".

## Non-goals

- Changing the Layer 2 LLM prompt or verdict semantics.
- Adding new input-guard layers or new brittle detectors.
- Consecutive-failure escalation state machine (moving Layer 2 into a sticky "suspicious-by-default" mode after N transport failures). Worthwhile follow-up but a separate design decision with its own risk of over-block.
- IntelligenceProvider-level concurrency caps, subprocess abort plumbing, or argv/env/stdin isolation. These are real concerns surfaced in review but are provider-implementation problems, not guard-routing problems. See "Deferred follow-ups" below.
- Dashboard or `instar doctor` integration for backend visibility. Pre-existing gap; inherited but not expanded by this change.

## Design

### InputGuard constructor

The constructor accepts the shared provider. The legacy `apiKey` parameter is removed in this change:

```ts
constructor(options: {
  config: InputGuardConfig;
  stateDir: string;
  /**
   * Shared IntelligenceProvider (Claude CLI subscription by default, Anthropic API
   * via explicit opt-in in the provider-selection layer). Optional — when absent,
   * Layer 2 fails closed-to-warn rather than calling a transport directly.
   */
  intelligence?: IntelligenceProvider;
})
```

No direct `fetch('https://api.anthropic.com/…')` call exists in InputGuard anymore.

**Back-compat note:** the only production caller is `startServer()`. Tests that use `topicCoherenceReview: false` are unaffected (the transport is never reached). The single existing test that exercised the apiKey-only fetch path is rewritten to provide an `IntelligenceProvider` instead.

### reviewTopicCoherence() routing

```
if (!config.topicCoherenceReview) return coherent  // review disabled
if (!intelligence)                {                 // no transport available
  logDegradation("topic coherence review skipped: no IntelligenceProvider")
  return { verdict: 'coherent', reason: 'no LLM available — review skipped',
           confidence: 0, layer: 'topic-coherence' }
}

// IntelligenceProvider is the only path
raw = await Promise.race([
  intelligence.evaluate(prompt, { model: 'fast', maxTokens: 150, temperature: 0 }),
  timeout(effectiveTimeout)
])
return parseReviewResponse(raw)
```

The effective timeout is a **floor**: `max(config.reviewTimeout ?? 0, 8000ms)`. Rationale: CLI subprocess cold-start p99 can exceed 3000ms; honoring a below-floor user config would silently regress Layer 2 from "review ran" to "review timed out" on the subscription path. A config value below 8s is clamped up; a config value above 8s takes effect. This is **not** overridable downward — by design. Warn-only action (the default) means a longer review budget is benign: no user-visible latency impact. The floor is documented in the `reviewTimeout` field's JSDoc (added in this change) so operators don't get surprised.

### parseReviewResponse()

```
if (empty)   → coherent (confidence 0, reason "Empty response")
if (valid JSON with suspicious verdict) → suspicious (parsed confidence)
if (valid JSON with coherent verdict)   → coherent (parsed confidence)
if (malformed JSON)                     → suspicious (confidence 0.3,
                                                     reason "Parse error — fail-closed-to-warn")
                                          AND logDegradation()
```

Rationale for the malformed-JSON change: the previous behavior ("Parse error — fail open") is a silent bypass. An attacker who can influence the LLM's output (prompt injection *within the reviewed message itself*) gets a deterministic bypass by forcing malformed output. Under `action: 'warn'` (the default), emitting a low-confidence `suspicious` verdict surfaces a warning to the session model — a non-blocking system-reminder — rather than passing silently. Under `action: 'block'` (non-default), block behavior is unchanged for truly suspicious verdicts, but the low-confidence parse-error verdict should remain warn-only regardless of action, to avoid false blocks on transient transport flakes. That nuance is handled in the SessionManager's verdict consumption layer, not here.

Empty responses are kept as `coherent` because "the provider returned nothing" is indistinguishable from "the provider isn't available," and the transport-missing path already surfaces a degradation log.

### parseReviewResponse — markdown fences

Handles ` ```json ... ``` ` and ` ``` ... ``` ` wrappers (the Claude CLI sometimes adds them, the direct Anthropic API does not). Tolerates leading/trailing whitespace and one fence pair. No CRLF-specific logic beyond what `String.trim()` handles; if a future provider pretty-prints with CRLF, a targeted fix lands then.

### startServer() ordering

Currently `InputGuard` is constructed around line 1988, before `sharedIntelligence` is initialized (around line 2045). Move the construction to after `sharedIntelligence` is initialized. The intervening ~80 lines (TopicResumeMap setup, sharedIntelligence init, git-sync wiring) do not consume the input guard. Verified by reading the code: `sessionManager.setInputGuard()` is the only consumer, and SessionManager guards every guard access with `if (this.inputGuard)`, so even if a message somehow arrived pre-wiring, it would pass through (prior behavior) rather than crash.

Pass `intelligence: sharedIntelligence` to the guard constructor. If `sharedIntelligence` is null, pass `intelligence: undefined` — the guard degrades loudly.

### startServer() backend logging

Replace the flat `Input Guard: enabled (action: warn)` line with one that reports the chosen backend:

- `Input Guard: enabled (action: warn, via shared IntelligenceProvider)` — provider available
- `Input Guard: enabled (action: warn, provenance + patterns only (no LLM review))` — no provider

There is no third line for "via Anthropic API (direct)" because the direct-API path is gone.

### startServer() no-intelligence branch

When `sharedIntelligence` is null at startup, preserve the existing yellow `console.log` and additionally emit a structured `DegradationReporter.report(...)` event. The external-channel emission uses a deliberately generic impact string; the detailed capability list is retained in the structured event's `impact` field but the `DegradationReporter`'s Telegram/feedback renderer is responsible for summarizing it to something like "LLM-gated features degraded — see local logs" for external surfaces. If that renderer does not already do summarization (worth verifying at review), this spec's in-scope change is to pass a short impact string and keep the detail in a separate disk-only `context` field.

(Implementation note: the current `DegradationReporter.report(...)` API takes a single `impact` string. This spec reduces that string to a short summary — "LLM-gated features degraded; defense-in-depth reduced" — rather than enumerating every capability. Enumeration goes to the `degradations.json` append log via existing disk write path, which is not externally visible.)

## Signal-vs-authority compliance

InputGuard Layer 2 is an authority in the signal-vs-authority sense: it is the LLM-backed gate with full conversational context that evaluates topic coherence. That authority is unchanged by this design — same prompt, same verdict mapping, same confidence semantics. Only the transport (how the authority is reached) is being routed through the shared abstraction.

The fail-closed-to-warn change on parse errors is an authority-behavior change at the *edge case* level: when the authority's *output* is malformed, we treat that as weak "suspicious" evidence rather than "allow." The authority is still the decision-maker; we are defining what a parse-failed response means. This is compatible with the principle — a brittle parser is not acquiring blocking authority; it is mapping authority-absence to the safer of the two warn-only outcomes.

Layers 1 (provenance tag matching) and 1.5 (injection-pattern regex) are detectors operating in warn-only mode. They are untouched.

The new `DegradationReporter.report()` call is a pure observability signal — no control-flow authority. It cannot block; it can only inform.

No brittle check acquires blocking authority. No existing authority is being replaced with a brittle check. The principle holds.

## Deferred follow-ups (explicitly out of scope)

These findings from the initial review round are real and worth addressing, but are decoupled from the transport-routing change and are tracked separately:

1. **Consecutive-failure escalation to sticky suspicious state** (Adversarial #2). When N Layer-2 transport failures occur in window W, future untagged messages default to `verdict: suspicious` (low confidence) until a successful review clears the state. Requires careful tuning to avoid warn-spam on transient flakes. Separate spec.
2. **IntelligenceProvider-level concurrency cap** (Scalability #2). A semaphore bounding concurrent `evaluate()` calls so bursts cannot OOM. Provider-level, not guard-level. Separate spec.
3. **IntelligenceProvider subprocess abort plumbing** (Scalability #3). An `AbortSignal` parameter so callers' timeouts actually kill the subprocess instead of orphaning it to 30s. Provider-level. Separate spec.
4. **CLI subprocess input isolation** (Security #1). Prompt content must be passed via stdin only, never argv or env, and never with `shell: true`. Depends on `ClaudeCliIntelligenceProvider`'s internals. Verify current behavior; file follow-up if non-compliant.
5. **Dashboard "Guard backend" visibility and `instar doctor` InputGuard check** (Integration LOW). Pre-existing observability gaps. Separate follow-up.
6. **apiKey rotation awareness** (Security #4). Now less applicable since InputGuard no longer captures apiKey — but the underlying AnthropicIntelligenceProvider still captures it at construction. Provider-level, separate.
7. **Provider lifetime** (Adversarial #4). This spec captures `intelligence` at construction; if a future hot-swap mechanism exists, a mutator or getter would be needed. No hot-swap exists today. Separate spec if/when it becomes real.

Each of these is logged in the convergence report as a deferred finding with severity and rationale. Shipping this spec does not make them less real or less urgent.

## Rollback

Pure code change. Revert the commit, ship as a patch. No persistent state migration. No agent state repair. Machines currently using the subscription path would silently return to the pre-release no-op — no user-visible regression, just reduced defense depth that matches the prior state.

## Acceptance criteria

- [ ] `InputGuard` constructor accepts only `intelligence?: IntelligenceProvider` (no `apiKey` parameter).
- [ ] `InputGuard.reviewTopicCoherence()` has no direct `fetch` call. All LLM interaction flows through `this.intelligence.evaluate(...)`.
- [ ] Effective review timeout is `max(config.reviewTimeout ?? 0, 8000ms)` when a provider is present.
- [ ] On malformed JSON response from the provider, the verdict is `suspicious` with `confidence: 0.3`, a `logDegradation()` line is emitted, and the reason string is "Parse error — fail-closed-to-warn".
- [ ] On empty response, the verdict is `coherent` (authority declined to decide; degradation is logged at the transport layer).
- [ ] On transport timeout or `evaluate()` error, the verdict is `coherent` and `logDegradation()` fires. (Transport flake ≠ authority dissent; keep fail-open at the transport boundary to avoid warn-spam.)
- [ ] When `intelligence` is absent, `reviewTopicCoherence()` returns `coherent` with a distinct reason, and `logDegradation()` fires once per call.
- [ ] `startServer()` constructs `InputGuard` after `sharedIntelligence` is initialized and passes the provider.
- [ ] Startup log reports the chosen backend (two possible lines; "direct Anthropic API" is gone).
- [ ] When no LLM transport is available, startup emits a `DegradationReporter.report(...)` event. The event's externally-rendered message is a short generic summary; the detailed capability list stays in disk logs / the structured event's fields.
- [ ] Regression tests cover: (a) provider-supplied happy path, (b) suspicious verdict pass-through, (c) markdown-fenced responses parse, (d) malformed JSON → suspicious-with-low-confidence-and-degradation-log, (e) empty response → coherent, (f) no-provider → coherent + degradation-log, (g) timeout → coherent + degradation-log.
- [ ] All existing InputGuard tests (unit + e2e) remain green.
- [ ] TypeScript clean.
