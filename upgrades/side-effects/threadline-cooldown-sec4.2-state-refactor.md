# Side-Effects Review — Threadline §4.2 commit 1: state refactor + failure-suppressive reservation

**Version / slug:** `threadline-cooldown-sec4.2-state-refactor`
**Date:** 2026-04-19
**Author:** echo
**Second-pass reviewer:** not required (internal refactor + attribution; public API unchanged; all 26 prior tests pass unmodified)

## Summary of the change

First of several commits implementing spec §4.2. This commit lands the state-machine and attribution scaffolding for the drain loop that follows. Key changes:

1. **Failure-suppressive cooldown reservation.** `lastSpawnByAgent.set(agent, now)` now happens BEFORE the async `spawnSession(...)` call (was AFTER in the prior code). Failure no longer rolls it back. Closes a hole where a peer triggering fast-failing spawns could beat the cooldown.
2. **Classified failure attribution.** New `SpawnFailureCause` discriminated enum and `SpawnFailureError` thrown class. Phase 1 classifier (per spec, to close GPT cross-review "regex brittleness" finding) treats ONLY locally-typed `SpawnFailureError` with an attributable cause as agent-attributable. Everything else — including all third-party library errors — classifies as `ambiguous` and does NOT bump penalty.
3. **Penalty state in dedicated fields.** `#penaltyUntil: Map<agent, number>` and `#consecutiveSpawnFailures: Map<agent, number>`. Penalty trips after 3 consecutive agent-attributable failures; duration is 2 × configured `cooldownMs`. Cleared on successful spawn.
4. **Single cooldown-remaining read path.** New public `cooldownRemainingMs(agent)` helper returns `max(cooldownRem, penaltyRem, 0)`. `evaluate()` uses this. No code in or out of the class subtracts timestamps directly — closes the alias bug (R3 scalability from spec).
5. **`#private` ECMAScript fields.** All mutable state maps are now true ECMAScript private (tsconfig target is ES2022). External consumers can't reach them; helpers are the only exposed surface. `MAX_QUEUED_PER_AGENT` and `QUEUE_MAX_AGE_MS` kept as `static readonly` for backwards-compat with the existing test that reads them.
6. **Injectable clock.** Optional `nowFn?: () => number` added to `SpawnRequestManagerConfig`. Default is `Date.now()`; tests use a mutable `fakeNow` closure for deterministic penalty/TTL tests.

Public API: unchanged (`evaluate`, `handleDenial`, `getStatus`, `getQueuedCount`, `reset`). `getStatus()` now also exposes a `penalties` array.

Files touched:
- `src/messaging/SpawnRequestManager.ts` — full refactor to private fields; new helpers; new enum/error; behavior changes (reservation timing, attribution).
- `tests/unit/spawn-request-manager.test.ts` — 7 new tests under `§4.2 failure-suppressive reservation`. All 26 prior tests unmodified and still pass.

## Decision-point inventory

1. **Phase 1 classifier only.** Spec is explicit — ship with local-typed-error-only classification. No regex on third-party error strings. Phase 2 (typed return signature on `spawnSession`) is a separate future spec. This commit is conservatively safe: it only undercounts attribution. A peer cannot exploit undercount because ambiguous failures still emit failure logs and cooldown reservation still fires.
2. **Keep `SpawnFailureError` as instanceof-based.** Simpler than a type guard. Tests import the class across the module boundary and vitest handles it cleanly. Alternative (nominal tag field) adds indirection with no safety benefit.
3. **Penalty duration = 2 × cooldownMs.** Matches spec literal. Configurable indirectly via `cooldownMs`. No separate `penaltyDurationMs` knob in this commit — can add later if product needs it.
4. **Penalty threshold = 3 consecutive failures.** Spec literal.
5. **`#private` fields vs `private` TypeScript modifier.** Spec §4.2 R4 security requires *runtime* privacy, not just compile-time. ES2022 native `#private` provides this. Current tsconfig targets ES2022 — verified by existing Router code using optional chaining + modern syntax without polyfills.
6. **Clock injection at constructor, not per-call.** Matches `ThreadlineRouter.nowFn` pattern added in §4.1 commit 2. Symmetric.
7. **`getStatus()` adds `penalties` field.** Opt-in extension, not a breaking change. Existing callers who destructure by key are unaffected.

## Blast radius

- **Existing callers of `evaluate()`:** behavior identical on success path (previously stamped cooldown on success → now stamped before spawn, cleared on success = net same observable state). Behavior differs on FAILURE path: previous code didn't stamp → caller could retry immediately. New code stamps before spawn → caller pays cooldown. This is the intended fix.
- **Existing callers of `handleDenial()`:** unchanged.
- **Existing callers of `getStatus()`:** unchanged keys; new `penalties` key is additive.
- **Existing callers of `getQueuedCount()`, `reset()`:** unchanged.
- **No external reads of private fields in the codebase** — verified by `grep -R "lastSpawnByAgent\|penaltyUntil\|consecutiveSpawnFailures\|pendingMessages\|pendingRetries" src/` returning only the file itself.

## Over-block risk

**Medium, but bounded.** A buggy caller that wraps `spawnSession` AND throws a raw `Error` (not `SpawnFailureError`) where they used to throw successfully is now under `ambiguous` classification, which does NOT penalize — so no over-block. The only over-block path would be a caller that deliberately throws `SpawnFailureError` with `envelope-validation` for a case that isn't actually the agent's fault. Mitigation: `SpawnFailureError` is new; no existing caller uses it; adoption is opt-in.

## Under-block risk

**Low.** The reservation-before-spawn closes the fast-failure beat. The penalty only kicks in for CONFIRMED agent-attributable failures, so a peer sending legitimate messages that happen to trigger infra flakes never gets penalized. The infra-failure soft limiter (separate commit) adds the additional signal for peers that reliably trigger infra paths.

## Level-of-abstraction fit

State + classifier live inside `SpawnRequestManager` where the cooldown decision is made. Alternative (separate `SpawnPolicy` class) adds indirection with no safety benefit; we'd end up passing state refs around. Current shape keeps the blast radius contained.

## Signal-vs-authority compliance

`SpawnFailureError`'s `cause` is a **caller-asserted signal**. The manager (authority) still owns the decision to penalize or not. If a caller lies about cause, the worst they can do is penalize themselves (since the caller IS the agent path emitting the cause tag). Compliant.

## Interactions

- **§4.1 (receiver/client affinity):** no interaction. Different code path.
- **Drain loop (§4.2 next commit):** the drain loop will read `cooldownRemainingMs` as its scheduling gate. This commit publishes the helper.
- **Infra soft limiter (§4.2 later commit):** will read `consecutiveSpawnFailures` (via a new helper or direct `#private` access inside this same class) to feed the `infraFailureWindow` → degraded-admission logic.
- **`handleDenial`:** unchanged; the retry tracker path still works for the legacy flow. May be retired later when the drain loop fully owns retry.

## Rollback cost

Revert the commit. Public API is unchanged so no external breakage. State resets to the old shape. Reservation behavior reverts to pre-commit (stamp on success only).

## Tests

- 7 new tests in `describe('§4.2 failure-suppressive reservation', ...)`: reservation stamps on failure, ambiguous failures don't penalize, attributable failures accumulate to penalty, infrastructure failures don't penalize, success clears counter, `cooldownRemainingMs` returns max of cooldown + penalty, penalty blocks past cooldown.
- All 26 prior tests unchanged and pass.
- `npx tsc --noEmit`: clean.

## Rollout

Ships on `feat/threadline-cooldown-queue-drain`. Next commits: DRR drain loop, infra soft limiter, observability tagging.
