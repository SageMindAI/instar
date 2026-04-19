# Side-Effects Review — Threadline §4.3 commit 2: envelope hash + extended queue entry shape

**Version / slug:** `threadline-cooldown-sec4.3-envelope-hash`
**Date:** 2026-04-19
**Author:** echo
**Second-pass reviewer:** not required (additive fields on internal queue type; hash is pure computation)

## Summary of the change

Second commit of §4.3. Extends the per-agent queue entry shape with two new fields and ships the canonical-JSON-based envelope hash function:

- `envelopeHash: string` — SHA-256 of canonical JSON of `{ context, threadId }`, prefixed `sha256-v1:`. Computed at enqueue. Lets future drain-loop code verify integrity (in case the queue gets serialized + reloaded) and supports algorithm upgrades via the version prefix.
- `drainAttempts: number` — count of times the drain loop has attempted this entry. Bumped before drain; reset on success. Already used by DRR's age-boost in §4.2 commit 2 (which read attempts from a separate `#drainAttempts: Map<agent, number>`); this commit prepares the per-entry counter that future commits will tie back into the DRR scheduler at message granularity.

Public surface adds: `computeEnvelopeHash({ context?, threadId? }): string` exported from the module so consumers (e.g., upcoming gate-freeze code in §4.3 commit 3) can compute matching hashes.

The hash is canonical — key permutation in input yields the same output — so two requests with logically-identical payloads always hash to the same value.

Files touched:
- `src/messaging/SpawnRequestManager.ts` — `node:crypto` import, `ENVELOPE_HASH_PREFIX` constant, `canonicalJson` + `computeEnvelopeHash` helpers (exported); extended queue entry type; hash + `drainAttempts: 0` set at enqueue.
- `tests/unit/spawn-request-manager.test.ts` — 4 new tests: prefix + determinism + length, canonical key permutation invariance, content sensitivity, indirect verification that queued entries acquire the hash via enqueue path.

## Decision-point inventory

1. **Versioned prefix `sha256-v1:`.** Subresource-integrity-style. Lets a future spec roll out a new hash algorithm (sha3, blake3) without invalidating queued entries — the verifier can dispatch on prefix.
2. **Canonical JSON via custom serializer, not `JSON.stringify` with `Object.keys().sort()`.** Recursive sort handles nested objects. The full implementation is ~10 lines; pulling in a library would be over-kill for a hot-path computation that runs once per enqueue.
3. **Hash includes `context` AND `threadId`.** Per spec: hash spans the payload identity. Two messages on different threads should hash differently even if content is identical.
4. **`drainAttempts` field on each entry, not just on the manager-level map.** §4.2's `#drainAttempts` map keyed by agent gave a per-agent attempt count — which conflated "tried once for the whole queue" with "tried once for THIS specific message". Per-entry counter is more precise. The agent-level map can be retired in a follow-up commit when the drain loop reads from per-entry counters; both exist for now to avoid a behavior shift mid-feature.
5. **Hash exported, not just internal.** The gate-freeze logic in §4.3 commit 3 will need to compute hashes externally (when comparing a new spawn request to a queued entry's recorded hash). Exporting the helper keeps both call sites consistent.

## Blast radius

- **Queue write path:** every enqueue now computes one SHA-256 + canonical-JSON serialization. SHA-256 in Node is hardware-accelerated; cost is microseconds for typical payload sizes (<256 KiB). Negligible.
- **Queue read path:** unchanged. Drain loop still reads `context` / `threadId` from queue entries; new fields are present but not yet consumed.
- **Existing tests:** all 54 pass unmodified. The queue entry shape change is purely additive on read sites (the `#buildSpawnPrompt` and `#drainQueue` methods only destructure `context` and `threadId`).

## Over-block risk

None. Hash is a label, not a gate. The cap from commit 1 already gates oversized envelopes BEFORE the hash is computed.

## Under-block risk

None at this layer. The hash exists for tamper detection in future commits; this commit only stamps the field.

## Level-of-abstraction fit

Hash function lives next to its consumer (the queue) in `SpawnRequestManager`. Exported because §4.3 commit 3 needs it externally. Could be moved to a shared utility module if other parts of the codebase need canonical-JSON hashing — leave for now until a second consumer materializes.

## Signal-vs-authority compliance

Hash is data, not a decision. No authority surface introduced in this commit.

## Interactions

- **§4.2 drain loop:** the loop's `#drainAttempts: Map<agent, number>` now has a parallel per-entry counter. Both are populated; the loop still reads from the map. §4.3 commit 3 (or later) will switch the loop to read per-entry counters and the map can be retired.
- **§4.3 commit 1 (byte-cap):** runs first; hash is only computed for envelopes that pass the cap.
- **§4.3 future commits:** gate freeze needs envelopeHash for re-eval comparison; truncation-marker logic will set a sentinel hash for synthetic truncation entries.

## Rollback cost

Revert. New fields disappear from queue entries; `computeEnvelopeHash` export disappears. No persisted state.

## Tests

- 4 new tests under `describe('§4.2 drain loop', ...)`: prefix + determinism + length, canonical key-permutation invariance, content sensitivity, indirect enqueue verification.
- All 54 prior tests pass unmodified.
- `npx tsc --noEmit`: clean.

## Rollout

Ships on `feat/threadline-cooldown-queue-drain`. Next §4.3 commits: gate freeze/downgrade policy with epoch invalidation, three-tier admission caps, truncation marker.
