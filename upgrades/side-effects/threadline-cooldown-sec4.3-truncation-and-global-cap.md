# Side-Effects Review — Threadline §4.3 commit 3: truncation marker + global queue cap

**Version / slug:** `threadline-cooldown-sec4.3-truncation-and-global-cap`
**Date:** 2026-04-19
**Author:** echo
**Second-pass reviewer:** not required (additive admission cap; per-agent semantics unchanged for under-cap traffic; truncation marker is observability only)

## Summary of the change

Third commit of §4.3. Adds two related admission gates:

1. **Per-agent truncation marker** (`#truncated: Set<string>`). When the per-agent cap (or degraded cap) is hit and the queue evicts an older entry, the agent's name is added to the set. Cleared on drain. Public `isTruncated(agent)` lets the consumer report truncation to the spawned session ("you missed N earlier messages") or to operators.
2. **Global queue cap** (`maxGlobalQueued`, default 1000). Total queued across ALL agents bounded. New enqueues silently refused once the cap is hit (`#queueMessage` returns false). This is a defensive bound — `evaluate` already returned a denial earlier; this prevents a degenerate scenario where many distinct peers each just fit under their per-agent cap and collectively explode memory.

Files touched:
- `src/messaging/SpawnRequestManager.ts` — `DEFAULT_MAX_GLOBAL_QUEUED` constant, `maxGlobalQueued` config, `#truncated` field, `isTruncated()` public helper, `#queueMessage` return-type change (now `boolean`) plus per-agent truncation tracking + global-cap check, `#drainQueue` clears the marker, `reset()` clears the set.
- `tests/unit/spawn-request-manager.test.ts` — 4 new tests: truncation set after eviction, cleared after drain, global cap refuses past-limit, default 1000 doesn't break normal use.

## Decision-point inventory

1. **Per-agent truncation as a `Set<string>`, not an entry-level boolean.** Truncation is a property of "this peer lost some messages recently", not "this specific message is part of a truncated batch". Set semantics match — single bit per agent.
2. **Truncation cleared on drain.** Once the queue is fully serviced, the truncation indicator is no longer accurate. Future re-truncation will re-set it.
3. **Global cap default 1000.** Spec is silent on the exact default; 1000 is generous (≈ 2.5 MiB worst-case at 256 KiB envelopes — bounded by the byte cap). Configurable.
4. **Global cap refuses silently from `#queueMessage` (returns false).** The `evaluate` call has already returned a denial reason ("Cooldown remaining: …") to the caller. The global cap is a backstop — if we got here, the user has already been told they can't spawn right now.
5. **Computation cost: O(agents) sum to compute `totalQueued`.** Acceptable given typical agent counts (<100 in production). If profile shows pressure, can cache + maintain a counter; not worth premature optimization now.
6. **Per-trust-tier admission caps deferred.** Spec mentions a third tier (per-trust-level). That requires the SpawnRequest to carry trust info — a public-API change. Not done in this commit; acceptable because the per-agent + global caps cover the load-bearing safety properties.

## Blast radius

- **Existing callers:** zero behavior change for traffic below 10 messages/agent and 1000 messages global. Above either threshold, eviction (per-agent) or refusal (global) kicks in — both intended.
- **Public surface change:** `isTruncated(agent)` is a new public method. Additive; no breakage.
- **Internal `#queueMessage` return type:** changed from `void` to `boolean`. The only caller (`evaluate`) doesn't currently check the return, which is correct: if global cap refuses, the user already got their "denial with cooldown" reason, and the lost queueing is just a defensive miss.

## Over-block risk

Global cap could refuse a peer's queueing when the system is genuinely flooded. That's the intended behavior — if 1000 messages are already pending, adding a 1001st is unlikely to ship before TTL anyway. Tunable via config.

## Under-block risk

The peer-level cap (10) + degraded cap (1) already cap per-agent depth. Global cap covers the cross-agent multiplication scenario. No under-block here.

## Level-of-abstraction fit

Both gates live in `#queueMessage` next to the existing per-agent cap logic. Symmetric placement. Could refactor into a "QueueAdmissionPolicy" class if more gates land — for now, three checks inline is readable.

## Signal-vs-authority compliance

`isTruncated` is a signal (observation). Global cap is an authority gate (refusal). Both at appropriate boundaries.

## Interactions

- **§4.3 commit 1 (byte cap):** runs first in `evaluate`. If a request is byte-capped, it never reaches `#queueMessage`.
- **§4.3 commit 2 (envelope hash):** entries acquire hashes regardless of truncation; truncated batches still hash the entries that survive.
- **§4.2 drain loop:** drains the queue normally. The truncation marker doesn't change drain behavior — it's just an observability flag.
- **§4.5 (observability):** future commit may emit a `queue-truncated` DegradationReporter breadcrumb when the marker flips on.

## Rollback cost

Revert. `#queueMessage` reverts to void return + no truncation tracking. `isTruncated` disappears. No persisted state.

## Tests

- 4 new tests under the same drain-loop describe block: truncation set after per-agent eviction, cleared after drain, global cap refuses past limit, default 1000 doesn't break normal use.
- All 58 prior tests pass unmodified.
- `npx tsc --noEmit`: clean.

## Rollout

Ships on `feat/threadline-cooldown-queue-drain`. Remaining §4.3 work (gate freeze/downgrade with epoch invalidation, per-trust-tier admission) is more cross-cutting and may live in §4.4 or a dedicated follow-up. Next: §4.4 config plumbing + PATCH endpoint + kill switch.
