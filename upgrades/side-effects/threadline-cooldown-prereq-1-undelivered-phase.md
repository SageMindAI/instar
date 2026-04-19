# Side-Effects Review — Threadline Cooldown Prereq 1: 'undelivered' DeliveryPhase + markManyUndelivered

**Version / slug:** `threadline-cooldown-prereq-1-undelivered-phase`
**Date:** 2026-04-19
**Author:** echo
**Second-pass reviewer:** not required (no block/allow surface; pure data-model + additive API)

## Summary of the change

Sub-PR 1 of 3 prerequisites for the Threadline Cooldown & Queue Drain spec (v7, approved via Telegram topic 7344). Adds a new `'undelivered'` phase to `DeliveryPhase`, registers the valid transitions `queued|received → undelivered` and `undelivered → delivered|expired|queued|failed`, and introduces `IMessageStore.markManyUndelivered(ids[], chunkSize?)` for SpawnRequestManager's dispose handoff. Updates `DeliveryRetryManager.tick()` to treat `undelivered` messages identically to `queued` in Layer-2 retry.

Files touched:
- `src/messaging/types.ts` — DeliveryPhase union, VALID_TRANSITIONS, IMessageStore interface.
- `src/messaging/MessageStore.ts` — implements `markManyUndelivered`.
- `src/messaging/DeliveryRetryManager.ts` — widens Layer-2 retry branch to include `undelivered`.
- `tests/unit/message-store.test.ts` — 7 new tests for `markManyUndelivered`.
- `tests/unit/delivery-retry-manager.test.ts` — 1 new test for `undelivered` Layer-2 retry.

## Decision-point inventory

No gate-level decision points. Data-model addition + additive API.

- `DeliveryRetryManager.tick()` Layer-2 branch — **modify** — widened from `phase === 'queued'` to `phase === 'queued' || phase === 'undelivered'`. This is a phase-admission decision; it includes a previously-unrecognized phase into an existing behavior, not a new block/allow policy.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

`markManyUndelivered` skips messages that are:
- In a terminal phase (delivered, read, expired, dead-lettered, failed) — correct. These shouldn't regress.
- Already in `undelivered` — correct. Idempotent.
- Missing from disk — correct. Silent skip matches existing store patterns (`get` returns null for missing).
- Corrupt on disk (parse failure) — correct. Silent skip keeps dispose non-fatal.

No legitimate input is rejected. The transitions `queued → undelivered` and `received → undelivered` cover the only two phases an in-memory-queued envelope can be in when SpawnRequestManager disposes.

## 2. Under-block

**What failure modes does this still miss?**

- If the SpawnRequestManager has an envelope in `'sent'` or `'created'` phase (impossible by current design — these are pre-receive phases), `markManyUndelivered` silently skips. The caller would have handed over an envelope it never should have queued. Not a protection concern; caller bug would surface via silent no-op. Acceptable.
- Race: the messageStore could be updated by another path between the `fs.readFileSync` and the `fs.renameSync`. The existing atomic-write pattern (tmp + rename) is preserved; concurrent writes would last-write-win. This matches existing `updateDelivery` semantics; no regression.
- `markManyUndelivered` does not verify the envelope is owned by this agent's inbox. Per-agent isolation is a store-level concern already enforced upstream. Not introduced here.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The store owns phase transitions (see existing `updateDelivery`). Adding a batch-transition method at the store layer matches the existing abstraction. `DeliveryRetryManager` owns retry semantics; the one-line widening of its Layer-2 branch is at the right layer. The new `DeliveryPhase` enum member lives with the existing enum in `types.ts`. Nothing is smuggled into a higher or lower layer.

## 4. Signal vs authority compliance

Per `docs/signal-vs-authority.md`: this change neither adds nor modifies a decision point that blocks/allows behavior. `undelivered` is a state marker; `markManyUndelivered` is a state-transition API. `DeliveryRetryManager` was already the authority for Layer-2 retry; widening its admission criterion to include `undelivered` extends its authority over entries that already semantically belong to it (entries handed off by SpawnRequestManager are conceptually "awaiting delivery" — the same concept `queued` represents). Compliant.

## 5. Interactions

- **`DeliveryRetryManager.tick()`**: one widened branch; tests confirm `undelivered → delivered` transitions identically to `queued → delivered`, recording the actual from-phase (not hardcoded `'queued'`).
- **`MessageStore.cleanup()`**: inspects envelopes and dead-letters expired ones. `undelivered` is non-terminal, so it participates in TTL expiry exactly like `queued`. No change needed.
- **`MessageStore.getStats()`**: counts envelopes by phase; `undelivered` is a new phase value that may appear in stats. Downstream dashboards reading stats will see a new key. Not a breakage — additive.
- **Existing call sites reading `envelope.delivery.phase`**: any exhaustive switch statement would need an `undelivered` case. `tsc --noEmit` passes cleanly, so either the union is not exhaustively checked anywhere or all check sites already have `default` branches. Verified via full type-check in CI gate.
- **No interaction with SpawnRequestManager yet** — that's sub-PR 4+ of the spec. This prereq only wires the capability.

## 6. External surfaces

- **Wire format:** `DeliveryPhase` is serialized in envelope JSON files. Old instar versions reading a file with `phase: 'undelivered'` would see an unknown string. Since sub-PR 1 is shipped before any code writes `'undelivered'` (SpawnRequestManager integration lands in a later PR), no file on disk will carry the new value until a later version ships. Safe ordering.
- **Multi-machine:** no change. DeliveryRetryManager runs per-machine and only sweeps inbox messages belonging to the local agent.
- **MCP / external API:** no public-facing change.

## 7. Rollback cost

`git revert` of this single commit. Reversal is trivial and safe — no code anywhere else writes `'undelivered'` yet. DeliveryRetryManager reverts to its prior behavior (sweep only `queued`), and any `undelivered` entries (none in practice) would be ignored until the next forward release, NOT deleted. Zero data loss on rollback.
