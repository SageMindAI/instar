# Side-Effects Review — Threadline §4.4 commit 2: drain-loop consumer wiring (load-bearing)

**Version / slug:** `threadline-cooldown-sec4.4-drain-consumer-wiring`
**Date:** 2026-04-19
**Author:** echo
**Second-pass reviewer:** not required (single re-entrant callback that delegates to existing evaluate(); covered by end-to-end unit test)

## Summary of the change

Second commit of §4.4. Wires the `onDrainReady` callback so the drain loop actually delivers queued messages — turning the previously-dormant tick into the load-bearing fix the spec was chartered to deliver.

When the drain loop finds an agent ready (cooldown cleared + queued messages present), the callback synthesizes a `SpawnRequest` with `triggeredBy: 'spawn-request-drain'` and re-invokes `spawnManager.evaluate(...)`. Inside `evaluate`, the queued message context is reattached via `#drainQueue` and a real session spawn fires.

The wiring uses a `let` forward-declaration so the callback can reference `spawnManager` itself for re-entrant evaluation. JS closures capture by reference, so by the time the callback fires (asynchronously, after construction completes), `spawnManager` is bound.

Files touched:
- `src/commands/server.ts` — forward-declares `let spawnManager`, registers `onDrainReady` callback in the constructor config that calls `spawnManager.evaluate(...)` with stub session/machine values + `triggeredBy: 'spawn-request-drain'`.
- `tests/unit/spawn-request-manager.test.ts` — 1 new end-to-end test asserting the queue → tick → onDrainReady → evaluate → spawn pipeline ships a queued message and tags the spawned session with `spawn-request-drain`.

## Decision-point inventory

1. **Forward-declared `let` for self-reference.** Cleaner than a `setOnDrainReady` setter on the manager; avoids exposing additional public surface. JS-idiomatic — closures over `let` bindings are well-understood. TypeScript is satisfied because the callback is never invoked synchronously during construction.
2. **Stub `requester.session: 'drain'`, `machine: 'drain'`.** The original requester's session/machine isn't preserved per-message in the queue (only `agent` is the key). These fields are only used for prompt-template display in the spawn callback; they don't affect any decision logic. Stub values are honest about provenance.
3. **Single drain re-attempt per tick per agent.** The drain loop's DRR scheduler already enforces at-most-one drain per agent per tick. No additional guard needed.
4. **Re-entrancy: drain → evaluate → drainQueue → spawnSession.** All synchronous-await chain inside evaluate. The drain loop's `#tickInflight` guard prevents overlapping ticks; within a single tick, evaluate's stamp-before-spawn semantics + drainQueue's "delete-then-process" pattern prevent double-drain.
5. **Failure handling: log and let drain loop retry on next tick.** If `evaluate` returns `approved: false` (e.g., session limit hit), the agent's queue still has the message; the next tick will retry. If `evaluate` throws, the drain loop's existing `Promise.allSettled` + warn-log keeps the batch going.
6. **No new public manager API.** All the necessary surface (`evaluate`, `runTick`, `start`, `dispose`) was added in earlier commits.

## Blast radius

- **Existing inline-spawn flows:** zero behavior change. They still call `evaluate` directly with their own SpawnRequests (no `triggeredBy` set, defaulting to `'spawn-request'`).
- **Queued messages that previously sat indefinitely:** now get drained on the next tick after cooldown clears, instead of waiting for a NEW inbound message. **This is the load-bearing fix the whole spec was chartered to deliver.**
- **Session log filtering:** drain-spawned sessions now carry `triggeredBy: 'spawn-request-drain'` (vs `'spawn-request'` for inline). Operators can filter by tag.
- **Session count:** if many agents had queued messages stuck pre-commit, they'll now drain — potentially producing a burst of new sessions at the first tick after deployment. The session-cap and DRR `maxDrainsPerTick` (default 8) bound the burst.

## Over-block risk

The drain re-attempt may be denied if cooldown hasn't fully cleared at the moment of evaluation (the drain loop's `tickGraceMs` admits agents whose cooldown expires within the next tick — but the actual evaluate may still see remaining cooldown if the tick fires slightly early). Such denials are logged and re-tried on the next tick. No over-block.

## Under-block risk

If the consumer's `onDrainReady` callback is never invoked (e.g., `start()` not called, or kill switch on), queued messages still sit until the next inline `evaluate`. That's the pre-§4.2 behavior, which is the documented kill-switch fallback.

## Level-of-abstraction fit

Wiring lives in `server.ts` next to manager construction — same place all the other server-side wiring is. Could be extracted to a helper if more drain consumers materialize, but one consumer needs no abstraction.

## Signal-vs-authority compliance

The drain loop generates a signal ("agent ready"). The consumer callback exercises the authority surface (`evaluate`) which already enforces cooldown / penalty / soft-limiter / byte-cap / global-cap gates. The drain doesn't bypass any policy.

## Interactions

- **§4.2 drain loop:** finally has a real callback to fire. Tick → onDrainReady → evaluate cycle is the load-bearing fix.
- **§4.2 cooldown reservation:** `evaluate` stamps cooldown before spawn — drain re-attempts respect it.
- **§4.2 penalty / infra soft limiter:** drain re-attempts pass through `cooldownRemainingMs` and the queue cap, so penalized peers stay silenced and degraded peers stay at depth-1 even on drain re-attempts.
- **§4.3 byte cap, hash, global cap, truncation:** all gates apply to drain re-attempts because they pass through `evaluate` → `#queueMessage` paths. (Drain re-attempts that hit cooldown will queue themselves, but the queued context already came in from the original message — no double-queue.)
- **§4.5 triggeredBy plumbing:** drain re-attempts are tagged `'spawn-request-drain'` and the tag flows through to the spawned session.

## Rollback cost

Revert. `onDrainReady` callback disappears; drain loop ticks become no-ops (same as §4.2 commit 2 baseline). Queued messages return to the "wait for next inline evaluate" pattern.

## Tests

- 1 new end-to-end test asserting: queue → tick → onDrainReady → evaluate → spawn pipeline drains a queued message AND the spawned session is tagged with `triggeredBy: 'spawn-request-drain'`.
- All 64 prior tests pass unmodified.
- `npx tsc --noEmit`: clean.

## Rollout

Ships on `feat/threadline-cooldown-queue-drain`. After this commit lands, the spec's central guarantee (queued messages drain proactively on a fair schedule) is operational in production. The remaining follow-up (§4.4 commit 3: PATCH endpoint for runtime tuning) is a nice-to-have; the kill switch from commit 1 already covers emergency rollback.
