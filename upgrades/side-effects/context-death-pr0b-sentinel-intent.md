# Side-Effects Review — Context-Death PR0b (Sentinel three-way intent)

**Version / slug:** `context-death-pr0b-sentinel-intent`
**Date:** `2026-04-17`
**Author:** `Echo (instar-developing agent)`
**Spec:** `docs/specs/context-death-pitfall-prevention.md` § P0.4
**Phase / PR sequence position:** PR0b of 8
**Second-pass reviewer:** `not-required` (no decision-point logic; pure side-channel signal added to existing classification result — see Phase 5 criteria below)

## Summary of the change

Adds a three-way intent classifier for "continue ping" user messages, attached as a side-channel field on every `MessageSentinel.classify()` result. No existing classification semantics change; no new blocking decisions; no new emergency paths. The only consumer of this signal is PR3's gate-quality telemetry, which lands later — until then the field is computed and discarded by current callers.

Files touched:

- **`src/core/MessageSentinel.ts`** (MOD) — adds:
  - New exported type `ContinuePingIntent = 'intent_a' | 'intent_b' | 'intent_c'`.
  - New optional field `continuePingIntent?: ContinuePingIntent | null` on `SentinelClassification`.
  - Pure-function classifier `classifyContinuePingIntent(message): ContinuePingIntent | null` (regex-only, <1ms).
  - Wiring inside `classify()` to populate the field on every return path (fast-path, LLM, default, and disabled cases).
- **`tests/unit/MessageSentinel-continue-ping-intent.test.ts`** (NEW) — 50 tests covering:
  - Non-continue-pings return null (8 cases).
  - 50-word ceiling override.
  - intent_a (pure resume) — 17 vocabularies including "continue", "yes", "yes please", "ok continue", "do it", "carry on", "yep", "yeah keep going", "yes proceed with the deployment".
  - intent_b (additive new requirement) — 7 phrasings: "and also", "additionally", "now also", "don't forget to", "while you're at it", "on top of that", "next do".
  - intent_c (verify/clarify) — 9 patterns: trailing "?", question-word starts ("why", "how", "did you", "can you explain"), explicit clarify words ("clarify", "verify", "double-check", "confirm").
  - Priority: intent_c wins over intent_b when both signals present (operator seeking info > operator adding scope).
  - Integration into `MessageSentinel.classify()` — field populated correctly on every `category` value, including emergency-stop and disabled-sentinel cases.

Existing `tests/unit/MessageSentinel.test.ts` (64 tests) continues to pass — backward-compatible additive change.

## Decision-point inventory

The classifier produces a signal, never an action. It does not gate inbound messages, does not change the outbound `SentinelAction`, and does not influence whether the existing categories (emergency-stop, pause, redirect, normal) fire. The only field touched on the result is the new `continuePingIntent` slot.

This is a textbook signal-vs-authority compliance: detector produces a label; downstream gate (PR3) decides what to do with it. Per the principle (`docs/signal-vs-authority.md`), the classifier carries no blocking authority.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Nothing is rejected. The change is purely additive — a new field on the classification result. Existing callers (TelegramAdapter routing decisions, etc.) are typed against the wider `SentinelClassification` interface and ignore unknown/unexpected fields.

The classifier itself can over-attribute intent (e.g., calling something intent_a that the operator meant as intent_c). This affects the *quality* of the gate-telemetry signal, not the *behavior* of any user-facing surface. Worst case under PR0b alone: the new field is wrong, no one notices because no one consumes it yet. Worst case after PR3 lands: the gate-quality SLO drifts mildly until the classifier is tuned.

## 2. Under-block

**What failure modes does this still miss?**

- **Multilingual continue-pings.** Patterns are English-only ("continue", "yes", "go ahead"). A Spanish "continuar por favor" returns null. Acceptable for v1 — Justin's environment is English.
- **Slang / paraphrase.** "Send it", "ship it", "lgtm" — none are in the resume-shape token set. Returns null. Acceptable: false negatives leak the gate-quality signal lower (fewer intent_a counts), not higher.
- **Sarcastic continue.** "Oh yeah, GREAT idea — go ahead 🙄" — classifier sees "go ahead" and the question-word "great" doesn't match → intent_a. Side-channel signal is wrong but no real-world harm.

The choice to be conservative on what counts as a continue-ping (must match a token from the bounded set) means the false-positive rate is low and the false-negative rate is bounded by the vocabulary. PR3's gate-quality SLO will surface drift if the vocabulary needs expansion.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. Continue-ping intent is a property *of the inbound message text*, before any session context is involved. MessageSentinel is the universal classifier for inbound messages and already runs the equivalent regex-fast-path / LLM-fallback pattern. Co-locating the intent classifier here:

- Avoids re-tokenizing the message in PR3's gate.
- Reuses the existing test infrastructure pattern (`MessageSentinel.test.ts`).
- Keeps the two pure-text classifiers in one file (current category classifier + new intent classifier) for easy diff-comparison across reviews.

Could it live in PR3's gate module? Technically yes, but then PR3 would need to import MessageSentinel just to get the message text plus do its own classification, doubling the work. The chosen location is the lowest-effort coupling.

## 4. Signal vs authority compliance

`docs/signal-vs-authority.md`: detectors emit signals, only authorities can block. The intent classifier emits one of four labels (`intent_a` / `intent_b` / `intent_c` / `null`). Zero blocking. Zero side-effects. Zero coupling to anything that decides — PR0b is plumbing for a downstream consumer.

The principle compliance check fires fully here: the classifier is a *pure detector* with explicit downstream-consumer-only semantics. The PR3 review will check that the consumer (gate-quality telemetry) doesn't covertly elevate this signal into an authority.

## 5. Interactions

**Does this shadow another check, get shadowed by one, double-fire, race with adjacent cleanup?**

- **Existing `category` classification** — runs unchanged. Intent runs in *parallel* on the same input, then the result is stitched together. No race because both are pure functions of `message`.
- **Existing fast-path / LLM split** — both paths now populate `continuePingIntent` from the same source-of-truth pure function. No risk of fast-path / LLM divergence.
- **Sentinel stats** — `recordStats` not called for continue-ping intent (it's not a category dimension, it's a side-channel). `byCategory` and `byMethod` counters unchanged. No double-count.
- **Sentinel `enabled: false` short-circuit** — explicitly returns `continuePingIntent: null`. The disabled-Sentinel path doesn't run the classifier (defensive: a disabled Sentinel should produce no signals).
- **Future consumer (PR3 gate-quality)** — will read `continuePingIntent` off the `SentinelClassification` result. No interaction in this PR.

## 6. External surfaces

**Does this change anything visible to other agents, other users, other systems?**

- New exported type `ContinuePingIntent` and new exported function `classifyContinuePingIntent` on `MessageSentinel` module. Public API additions, backward-compatible.
- New optional field on `SentinelClassification` type. Existing TS callers will see the new field but type-checking continues to compile (optional field is a type-narrow, not a contract change).
- No changes to:
  - HTTP routes
  - Telegram message routing
  - Slack/iMessage/WhatsApp adapter behavior
  - Session lifecycle
  - Outbound dedup gate
  - Coherence checks
  - Trust state

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Trivial. Revert the commit:
- Removes the new exported type, function, and field.
- Removes wiring in `MessageSentinel.classify()`.
- Removes the test file.

No runtime state to repair. No external consumers to coordinate with (PR3's consumer doesn't ship in this PR). No downtime. Total rollback time: one `git revert` + one server restart (~30s).

If only the classifier behavior is bad (false-positive rate too high), the cheaper fix is to tighten the regex patterns in-place or set `continuePingIntent` to always-null while keeping the field for type stability. Both are local-edit-only changes.

---

## Tests

- `tests/unit/MessageSentinel-continue-ping-intent.test.ts` — 50 tests, all passing.
- `tests/unit/MessageSentinel.test.ts` — 64 existing tests, all passing (no regressions).
- `npm run lint` — clean.

## Phase 5 second-pass review criterion check

- Block/allow decisions on outbound messaging, inbound messaging, or dispatch — **no** (no decisions added).
- Session lifecycle: spawn, restart, kill, recovery — **no**.
- Context exhaustion, compaction, respawn — **adjacent, but not touched here** (this PR feeds PR3's gate-quality metric; the gate decision itself is PR3 and gets second-pass review there).
- Coherence gates, idempotency checks, trust levels — **no**.
- Anything with "sentinel," "guard," "gate," or "watchdog" — **the file is `MessageSentinel.ts`**. Phase 5's intent is to gate decision-point changes; this PR adds a non-decision label field. PR3 (the consumer) is the right gate point.

PR3 will require Phase 5 second-pass review.
