# Side-Effects Review — CommitmentTracker.mutate() single-writer surface

**Version / slug:** `commitment-tracker-mutate`
**Date:** `2026-04-19`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Adds a single-writer `mutate(id, fn)` API to `CommitmentTracker` as the prerequisite micro-PR called out in `docs/specs/PROMISE-BEACON-SPEC.md §"Prerequisite PR"`. Every in-tree write path (`record` initialization, `withdraw`, `verifyOne`, `expireCommitments`, `attemptAutoCorrection`, `checkForEscalation`) now serialises through this surface so the forthcoming Promise Beacon, PresenceProxy, and CommitmentSentinel can't clobber each other's writes. The `Commitment` record gains a monotonic `version: number` field; `CommitmentStore.version` bumps from 1 to 2; loader back-fills `version: 0` on every legacy record.

Files touched:
- `src/monitoring/CommitmentTracker.ts` — new async `mutate`, internal `mutateSync`, CAS retry, FIFO queue (depth 256), schema bump, v1→v2 migration, all existing write paths routed through the single-writer surface.
- `tests/unit/CommitmentTracker-mutate.test.ts` — new (9 tests).
- `tests/unit/CommitmentTracker.test.ts` — existing test updated for store version 2.

Decision-point surfaces touched: none. This change is a concurrency-control primitive, not a block/allow surface.

## Decision-point inventory

- No decision points added, modified, or removed. This PR is a data-model + concurrency-control refactor. `mutate()` does not filter, gate, or reject any agent input — it only serialises writes to a record that already existed.
- `queue-full` rejection at depth 256 is backpressure, not authority over agent behavior: it rejects *its own caller's write attempt* to protect memory, it does not decide what agents are allowed to say or do.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

The only rejection path is `queue-full` at depth 256 of in-flight writes for the same commitment id. Reaching that depth requires 256 pending writes on a single commitment — under the spec's `globalMaxOpen: 20` and normal timer cadence this is structurally unreachable outside of a test harness. If it ever fires in practice, the caller sees a clear error (not a silent drop) and can retry or surface the failure.

---

## 2. Under-block

No block/allow surface — under-block not applicable.

The CAS retry budget is 5. If five consecutive writers drift a record's version between one caller's read and write, that caller's mutation is dropped with a clear error. Under `globalMaxOpen: 20` with per-id queues that serialise synchronously, this is unreachable in practice — but if it ever is, the error is explicit, not silent, and the caller can surface it.

---

## 3. Level-of-abstraction fit

Right layer. `CommitmentTracker` owns the commitment record's lifecycle; the single-writer queue belongs inside the class that owns the data. Putting it higher (e.g., a route-level lock) would force every caller to know about the invariant; putting it lower (e.g., a filesystem lock) would miss in-memory writes. The `mutate(id, fn)` shape matches the spec's prereq contract and is the same surface PromiseBeacon will consume without any additional adapter.

A sync fast-path (`mutateSync`) is preserved for the existing synchronous write paths because JS is single-threaded — synchronous fn bodies cannot race each other — so forcing the existing callers through an async queue would add gratuitous microtask latency to every write without any concurrency benefit. Async `mutate()` is the surface that matters when fn bodies await (e.g., beacon timer handlers calling the LLM).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.
- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] Yes, with brittle logic — STOP.

`mutate()` is a concurrency primitive. It does not decide what agents are allowed to do. The only error responses (`queue full`, `unknown id`, `CAS retry exhausted`) are structural backpressure, not agent-behavior authority. Signal-vs-authority is not applicable to this surface.

---

## 5. Interactions

- **Shadowing:** None. `mutate()` is a new internal surface; all existing write paths funnel *through* it rather than running in parallel. No existing check is shadowed by or shadows the new code.
- **Double-fire:** None. The FIFO-per-id discipline means two write attempts on the same commitment serialise; they cannot both win. The existing `emit('recorded' | 'withdrawn' | 'corrected' | 'escalation' | 'verification')` events fire exactly where they did before — the refactor preserves emission sites.
- **Races:** The one place to watch is `expireCommitments` iterating the store while `mutateSync` replaces records in-place. The code snapshot-collects target ids *before* iterating so we don't iterate a live array under index-preserving writes. `verifyOne` uses the latest snapshot from the store after mutation to pass to callbacks. The sync helper preserves array index (`store.commitments[idx] = committed`), so stable id-based lookup is intact.
- **Feedback loops:** `attemptAutoCorrection` still calls `checkForEscalation(updated)` which can itself mutate — this was the prior behavior, now both routed through `mutateSync`. No new feedback loop introduced.

---

## 6. External surfaces

- **Other agents on the same machine:** None. `CommitmentTracker` is in-process server state.
- **Other users of the install base:** Agents upgrading from a v1 commitments store transparently get a v2 on-disk format after the first write post-upgrade. Pre-upgrade records are auto-migrated on load (`version: 0` back-filled). No user action needed.
- **External systems:** None.
- **Persistent state:** `state/commitments.json` bumps from `"version": 1` to `"version": 2` and gains a `version: N` field per commitment. Forward-compatible in the sense that v2 is a strict superset of v1 by field set; backward-compatible on load because the loader still accepts `version: 1` and migrates. A v1-only reader would see the new top-level version and the new per-record field; the only in-tree v1 reader is the loader itself, which is already v2-aware.
- **Timing:** `mutate()` adds one FS `writeFile`-then-`rename` per successful apply (same pattern the file already used). No new timing dependency.

---

## 7. Rollback cost

- **Hot-fix release:** Revert the commit. No code downstream depends on `mutate()` yet — PromiseBeacon and PresenceProxy adoption is explicitly deferred to follow-up PRs. A straight revert is clean.
- **Data migration:** Rolling back *with* existing agents on v2 stores on disk is slightly awkward — the old loader only accepts `version: 1`. The loader's pre-rollback behavior was to discard unknown versions and start fresh, which would wipe live commitments. **Mitigation if rollback becomes necessary:** include a one-shot rewrite step in the rollback patch that copies the old loader's v1 acceptance back in, or ship a migration script that rewrites v2 stores down to v1 (drop `version` field, set top-level to 1). Estimated effort: 15 minutes of code + a release.
- **Agent state repair:** None beyond the note above. No events, no external deps, no cached derived state.
- **User visibility:** None during rollout. If rollback happens without the loader-compat patch, affected agents would lose their commitments list (reset to empty) — a rare but non-trivial user-visible regression. The low-friction fix is "don't roll back blindly — include the loader-compat step".

## Conclusion

This is an internal refactor + new API surface. No decision-point surface is touched, no block/allow authority is added, and signal-vs-authority does not apply. The main rollback caveat is the v1→v2 store-version bump: a blind revert would leave agents unable to read their own commitments. A rollback, if ever needed, needs to include a 15-minute compat patch. All 122 commitment-related tests pass (9 new in `CommitmentTracker-mutate.test.ts`, 113 pre-existing across `CommitmentTracker`, `CommitmentSentinel`, `CommitmentSweeper`, `commitment-routes`). Clear to ship as the Promise Beacon prerequisite PR.

---

## Evidence pointers

- Tests: `tests/unit/CommitmentTracker-mutate.test.ts` (9 tests covering concurrency serialisation, FIFO across awaits, queue-full rejection, CAS retry under drift, v1→v2 migration, round-trip version preservation).
- Spec: `docs/specs/PROMISE-BEACON-SPEC.md §"Prerequisite PR — CommitmentTracker.mutate()"`.
- Verification: `npx vitest run tests/unit/CommitmentTracker*.test.ts tests/unit/CommitmentSentinel.test.ts tests/unit/CommitmentSweeper.test.ts tests/unit/commitment-routes.test.ts` — 122 passed, 0 failed.
