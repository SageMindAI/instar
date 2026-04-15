# Signal vs Authority — Architectural Principle

> This is a hard architectural constraint, not a suggestion. Any decision point in instar that gates information flow, blocks actions, filters messages, or constrains agent behavior must follow this pattern. The `/instar-dev` skill's side-effects review enforces it on every change.

## The principle

**Separate detection from authority.**

- **Detectors** are low-level, cheap, brittle-by-nature. They include regex matchers, literal token lookups, similarity thresholds, pattern counters, and the like. Their job is to *surface observations*: "this looks like a debug token," "this resembles a recent message at similarity 0.8," "this contains a literal path." Detectors **do not block**. They produce structured signals.

- **Authorities** are higher-level, intelligent, context-rich. An authority receives all relevant detector signals, plus the recent conversation, plus any structured context, and makes a single block/allow/warn decision with reasoning the user can inspect. An authority is typically LLM-backed, but could be a carefully-designed deterministic policy evaluator if the domain truly is that constrained.

Each decision point has exactly one authority. Multiple detectors can feed it. The authority is the only thing with blocking power.

## Why this is the rule

Low-context filters can't distinguish legitimate inputs from the specific failure mode they were built to catch. "Test" is a debug token *sometimes* and a legitimate word *most of the time*. A similarity score of 0.8 is a near-duplicate *when the respawned session re-generates the same answer* and a natural echo *when the user asked to hear the point again*. No brittle check can tell these cases apart. If we give brittle checks blocking authority anyway, we produce over-blocks, then fix them with more brittle checks, then over-block more, forever.

The Meta-problem — fixes with side effects that cause other problems that cause more fixes — is what happens when detectors hold authority. Fixing it requires that detectors never hold authority, by design, from the start.

## The pattern in practice

### Adding a new check — the right way

1. Identify the signal you want the system to see. "Is this message short and looks like a debug string?"
2. Implement it as a detector. Cheap function, no I/O, returns a structured signal: `{ junkScore: number, reason: string }`.
3. Feed the signal into the existing authority for that decision point. The authority receives the signal alongside other signals and the recent conversation, and decides.
4. If no authority exists for that decision point, step back: adding a new brittle blocker is not acceptable. Either design a proper authority first, or accept that this decision can't be made correctly with the information you have.

### Adding a new check — the wrong way

1. See a failure mode.
2. Write a filter that matches the specific failure.
3. Put the filter in front of the existing authority with its own block path.
4. Ship it.

The wrong way is how we got to four layers of brittle filters in front of the outbound gate on 2026-04-15. The skill's side-effects review catches this now.

## Detectors — what's allowed

- Regex / literal matchers
- Token lookups against a fixed list
- Similarity scores (Jaccard, Levenshtein, cosine over embeddings if cheap enough)
- Rate counters, frequency buckets
- Timestamp-window checks
- Structural validators (this field exists, this length is bounded, this type-checks)

These are fine and useful *when they produce signals*. They are not fine when they produce 422 block responses on their own.

## Authorities — what qualifies

- An LLM with the recent conversation and the detector signals as input, producing a structured decision with traceable reasoning.
- A deterministic policy evaluator for domains so constrained that all inputs can be enumerated (rare — most message-flow decisions are not like this).

An authority is not qualified if:

- Its "reasoning" is actually just one of its inputs winning by threshold.
- Its blocking decisions cite rules that are not in its actual prompt or policy. (This is the failure mode we observed with the tone gate on 2026-04-15 — the LLM invented rules not in its ruleset and blocked on them.)
- It doesn't have enough context to distinguish the legitimate and illegitimate cases the domain contains.

Authorities must log their decisions in a structured form: which signals they received, what the conversation context was, which rule they applied, and what the outcome was. This is how over-blocks and under-blocks become detectable instead of just frustrating.

## Violations found and resolved (2026-04-15)

These violations were identified in the initial audit and resolved together in `c204b68`:

- **`OutboundDedupGate`** *(resolved)* — was wired as a direct 422-block authority in `server/routes.ts`. Rework: it is now a pure signal (`signals.duplicate`) passed into `checkOutboundMessage()`. The tone gate decides based on the full picture.
- **`junk-payload` guard** *(resolved)* — was a literal-token matcher with direct 422-block authority on the same route. Rework: `isJunkPayload()` is now a pure signal (`signals.junk`) fed into the same authority.
- **`MessagingToneGate` reasoning drift** *(resolved)* — the gate was observed citing rules not in its own prompt. Rework: `ToneReviewResult.rule` is now constrained to enumerated IDs (B1..B9); any citation outside that set fails-open with `invalidRule: true` rather than silently blocking on an invented rule.

All three reworks shipped together in a single `/instar-dev` pass (side-effects artifact: `upgrades/side-effects/outbound-signal-authority-rework.md`).

## When this principle does NOT apply

- **Hard-invariant validation.** "This field must be a number." Typing and structural validators at the boundary of the system are not decision points in the sense this principle applies to — they don't evaluate messages, they reject malformed input. These belong at the API edge and are fine as brittle blockers.
- **Safety guards on irreversible actions.** `rm -rf /`, force-pushing to main, deleting the database — these can and should be hard-blocked by brittle pattern matchers, because the cost of a false pass is catastrophic and the cost of a false block is merely "try again with the right arguments."
- **Idempotency keys and dedup at the transport layer.** If a caller sends the same request twice with the same idempotency key, rejecting the second is not a judgment call — it's mechanics.

The principle applies to *judgment* decisions: blocking based on what a message *means* or what the agent's *intent* appears to be. Judgment requires context. Brittle checks cannot have context. Therefore brittle checks cannot make judgment calls.

## How the skill enforces this

The `/instar-dev` skill's side-effects review includes Question 4: "Signal vs authority compliance." Every change that touches a decision point must answer that question. If the answer is "yes, this adds brittle blocking authority," the skill requires the design to be reworked before the artifact can be completed.

For high-risk changes — anything touching outbound messaging, session lifecycle, dispatch, or information flow — a second-pass reviewer subagent independently audits the artifact for exactly this violation.

The pre-commit hook verifies the artifact exists. The pre-push gate re-verifies at release time. There is no path that ships a violation without all three of these catching it.
