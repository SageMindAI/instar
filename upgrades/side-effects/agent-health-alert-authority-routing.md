# Side-Effects Review — agent health-alert authority routing

**Version / slug:** `agent-health-alert-authority-routing`
**Date:** `2026-04-28`
**Author:** `echo`
**Second-pass reviewer:** `subagent (post-artifact, see below)`

## Summary of the change

Routes `DegradationReporter` Telegram alerts through the existing `MessagingToneGate` (the established outbound-message authority) instead of calling `telegramSender` directly. Adds two new signals to `ToneReviewSignals`:

- `jargon` — produced by a new `JargonDetector` (token-list matcher), reports terms that an end user has no path to act on ("job", "logs", "load-bearing", "trigger", etc.).
- `selfHeal` — produced by `DegradationReporter` after invoking a registered self-healer for the affected feature; reports `{attempted, succeeded, attempts}`.

Adds a new `messageKind` field to `ToneReviewContext` (`'reply' | 'health-alert' | 'unknown'`, default `'reply'`) and three new health-alert-only rule IDs:

- `B12_HEALTH_ALERT_INTERNALS` — block when the candidate leaks jargon the user can't act on.
- `B13_HEALTH_ALERT_SUPPRESSED_BY_HEAL` — block when the producer has already self-healed.
- `B14_HEALTH_ALERT_NO_CTA` — block when a health-alert candidate doesn't end with a yes/no question.

When the tone gate blocks a health-alert candidate, `DegradationReporter` falls back to a safe-template message: `"Something on my end stopped working and I haven't been able to fix it on my own. Want me to dig in?"` (plain English, ends with a single yes/no the user answers in one word).

**Files touched:**
- `src/core/JargonDetector.ts` (new) — signal producer.
- `src/core/MessagingToneGate.ts` — signal extension, prompt extension, valid-rules update.
- `src/monitoring/DegradationReporter.ts` — self-heal-first orchestration, gate routing, healer registry.
- `src/commands/server.ts` — wire `messagingToneGate` into `connectDownstream`.
- `tests/unit/jargon-detector.test.ts` (new), `tests/unit/messaging-tone-gate-health-alerts.test.ts` (new), `tests/unit/degradation-reporter-self-heal.test.ts` (new).

## Decision-point inventory

- `MessagingToneGate.review()` — **modify** — add three new rule IDs and two new signal types to the existing single authority. No parallel gate added.
- `DegradationReporter.reportEvent()` — **modify** — wraps the existing direct `telegramSender` call in a self-heal-first + tone-gate path. The downstream call remains the same `telegramSender`.
- `JargonDetector.detectJargon()` — **add** — pure signal producer, no decision authority.
- `DegradationReporter.registerHealer()` — **add** — feature-keyed callback registry, no decision authority (just orchestration of producer-supplied logic).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The jargon detector flags neutral words ("job", "trigger", "module") that have legitimate non-internal meanings. A standard agent reply where the user asks "what triggered this?" would have the jargon detector fire — but `messageKind` defaults to `'reply'` for the standard outbound surface, and B12/B13/B14 only apply when `messageKind === 'health-alert'`. So jargon hits in normal replies still pass the gate (the LLM authority sees the signal but B12 doesn't apply). Verified by the test `defaults messageKind to "reply" when omitted`.

A degraded-but-acceptable health alert that uses a single jargon term ("My job queue is stuck — want me to dig in?") would be a borderline case; the LLM authority is what decides, and the prompt explicitly tells it to favor passing borderline cases. The fallback (safe template) is also a valid and reasonable user message, so over-block here is not catastrophic — the user always sees *something* actionable.

## 2. Under-block

**What failure modes does this still miss?**

1. Other paths can still send Telegram messages directly without going through `DegradationReporter` or `checkOutboundMessage`. Identified during the area mapping: `StallTriageNurse.sendToTopic` (session triage) and `SessionMonitor.sendToTopic` (session status). These are not internal-health alerts in the same sense — they're session-recovery actions and lifecycle status — but they do bypass the tone gate. Tracked as **commit-action CMT-344** (filed against echo's local instar server, blocked-by this PR merging).
2. An agent-authored Telegram message (an LLM in a session deciding on its own to alert the user about internals — the literal Scout-Agent-screenshot scenario) goes through `checkOutboundMessage` via `/telegram/reply`. That route does NOT currently set `messageKind: 'health-alert'`. So an agent-LLM freelancing a health alert would have `messageKind: 'reply'` and B12-B14 would not apply. The general tone rules (B1-B11) would still catch literal CLI commands or file paths in the message, but the "load-bearing infrastructure" / "reflection-trigger job" prose pattern would slip through. Mitigation: this PR ships the structural surface (signals, rules, kind-aware routing); follow-up adds heuristic `messageKind` detection at the outbound boundary. Tracked as **commit-action CMT-345** (filed against echo's local instar server, blocked-by this PR merging).
3. A producer that calls the healer, gets `succeeded: true`, but the heal didn't actually verify (because the healer lies). Mitigated by a `verifyHealStuck` discipline at the healer level, which is the healer author's responsibility — not enforced by this PR.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The change feeds the existing `MessagingToneGate` authority — the single outbound-message authority on this codebase — rather than running parallel to it. The earlier (rejected) sketch had a regex-based jargon-ban as a hard blocker; that was the brittle-blocker anti-pattern. The current design has detectors (`JargonDetector`, `selfHeal` orchestration in DegradationReporter) producing structured signals that an LLM authority combines with conversation context and `messageKind` to decide.

The `DegradationReporter`-side orchestration (self-heal-first → gate routing → safe-template fallback) is at the right layer because the producer is the only thing that knows (a) which feature is degraded, (b) which healer applies, and (c) whether the heal actually verified. Hoisting that orchestration into the gate would couple the gate to feature semantics it shouldn't know about.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change produces a signal consumed by an existing smart gate.

The `JargonDetector` is a pure token-list matcher with no decision power. It returns `{detected, terms[], score}` and is consumed by `MessagingToneGate.review()` as part of `signals.jargon`. The same is true of the `selfHeal` signal: `DegradationReporter` runs the healer and reports the result; the gate decides whether the result warrants suppressing the user message.

The new rule IDs (B12/B13/B14) live inside the existing LLM authority, which has the recent conversation history, the candidate text, all upstream signals, the configured target style, and now the `messageKind`. The authority's decision is logged in the existing structured form (`rule: string` + `issue: string` + `suggestion: string`) and is subject to the existing reasoning-discipline check (rule IDs not in `VALID_RULES` are treated as drift and fail-open).

This composes cleanly with the principle and reuses the existing structural enforcement.

## 5. Interactions

**Shadowing:** The new self-heal-first path runs before the cooldown check completes. If a healer succeeds but the heal-cooldown window is active, the alert is correctly suppressed. If a healer fails AND we're inside the cooldown window, the alert is suppressed by the existing cooldown — verified in `degradation-reporter-self-heal.test.ts` (cooldown is checked first, healer only invoked when we'd otherwise have alerted).

**Double-fire:** The healer is invoked once per `reportEvent` call. Multiple `report()` calls for the same feature produce multiple `reportEvent` calls, but the existing dedup (`lastAlertTime` per-feature 1-hour cooldown) limits the actual healer invocations. Acceptable — healers must be idempotent per the type contract.

**Races:** No new shared state. `lastAlertTime` continues to be the only mutable per-feature state, mutated only inside `reportEvent`. Healers run on the same async stack as the rest of `reportEvent`; if a healer is slow, alert delivery is delayed, but no race with cleanup.

**Feedback loops:** `DegradationReporter` does not itself report feedback about its own pipeline failures (`@silent-fallback-ok` annotation in existing code). A failure of the tone gate (LLM unavailable) is fail-open — the candidate is sent unchanged, no recursive degradation reported.

## 6. External surfaces

- **Telegram (other users' machines):** the user-visible message format changes for degradation alerts. Before: `narrativeFor(event)` text directly. After: either `narrativeFor(event)` (if gate passes), or the safe-template "Something on my end stopped working… Want me to dig in?" (if gate blocks). Strictly an improvement for the screenshot-class user-experience bug.
- **Other agents on the same machine:** no surface change. The new `registerHealer` API is opt-in; existing producers that don't register a healer get the previous behavior plus tone-gate gating.
- **Persistent state:** no schema changes to `degradations.json`. The `DegradationEvent` shape is unchanged. New fields (`alerted: true` after suppression) follow the existing semantics.
- **Timing:** healers may add up to (healer's runtime) latency to alert delivery. For a fast healer (no-op stub returning `false`), this is negligible; for a real healer (e.g., re-running a job), this can add seconds. Acceptable — the alert was about to fire to the user anyway, and this is the entire point of "self-heal-first."
- **Backwards compat:** `connectDownstream`'s `toneGate` parameter is optional; existing callers (none beyond `server.ts`, but theoretically downstream tools/tests) continue to work without it.

## 7. Rollback cost

**Pure code change.** Revert + ship as a patch. No persistent-state changes. No user-visible regression during the rollback window — agents that picked up the change would simply revert to the previous behavior (direct `telegramSender` calls without gate routing).

The new files (`JargonDetector.ts`, three test files, the artifact) are additive and can be deleted on revert without breaking the build (no imports outside the new code use them).

## Conclusion

The review caught and prevented a brittle-blocker anti-pattern in the original design (jargon-ban as hard regex blocker). The reshaped design feeds detectors as signals into the existing `MessagingToneGate` authority, in line with `docs/signal-vs-authority.md`. Two scope items deferred to same-PR follow-up: (1) routing `StallTriageNurse` / `SessionMonitor` direct sends through the gate; (2) heuristic `messageKind` detection so agent-authored health alerts also benefit. Both are tracked in the under-block section above and warrant a follow-up PR — not orphaned notes.

The change is clear to ship.

## Second-pass review

**Reviewer:** independent-subagent
**Independent read of the artifact: concur (after raised concerns resolved)**

- **Verified clean:** `JargonDetector` is signal-only (returns `{detected, terms, score}`, never decides); the self-heal suppression branch correctly uses strict `healResult.succeeded === true`, so `attempted: true && succeeded: false` falls through to the gate as intended; B12/B13/B14 are all present in `VALID_RULES` and will not be drift-failed-open; `messageKind` defaults to `'reply'` so health-alert rules don't leak into the standard reply path.
- **Concern raised (now resolved):** under-block items 1 and 2 lacked concrete tracking handles. **Resolution applied:** filed as commit-actions **CMT-344** (StallTriageNurse + SessionMonitor routing) and **CMT-345** (heuristic `messageKind` detection at `/telegram/reply`) against echo's local instar server, both `type: one-time-action` and blocked-by this PR merging. References added inline in the under-block section.
- **Minor (now resolved):** `ToneReviewResult.rule` JSDoc updated from "B1..B9" to "B1..B14" in `src/core/MessagingToneGate.ts`.

## Evidence pointers

- Test output: 25/25 new tests pass (`tests/unit/jargon-detector.test.ts`, `tests/unit/messaging-tone-gate-health-alerts.test.ts`, `tests/unit/degradation-reporter-self-heal.test.ts`).
- Adjacent regression: 41/41 existing tests in `MessagingToneGate.test.ts` + `degradation-reporter*.test.ts` still pass.
- TypeScript: `tsc --noEmit -p tsconfig.json` — clean.
- The literal Scout-Agent-screenshot text is asserted to trigger `detected: true` with ≥5 jargon hits in `jargon-detector.test.ts`.
