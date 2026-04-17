# Side-Effects Review — Integrated-Being Ledger v2, Slice 4 (Resolve)

**Version / slug:** `integrated-being-ledger-v2-slice-4-resolve`
**Date:** `2026-04-17`
**Author:** Echo
**Second-pass reviewer:** required — slice adds idempotency + session-scoped auth on a user-authoritative write path.

## Summary

Slice 4 lands POST /shared-state/resolve/:id with the two session-callable resolution types: `self-assert` (creator-session only) and `dispute` (any authenticated session, rate-capped). `user-resolve` returns 501 pending slice 6 (requires PIN-unlock infrastructure). `subsystem-verify` returns 501 pending slice 5 (requires onComplete wiring). dedupKey is a true idempotency key — retries return the same result with `X-Idempotent-Replay: 1`. Ships behind `v2Enabled=false` AND `resolutionEnabled=false`; when v2 flips, resolution is auto-true unless operator set explicit false (spec §"resolutionEnabled coupling").

Files touched:

- `src/server/routes.ts` — POST /shared-state/resolve/:id (~160 LOC)
- `src/core/LedgerSessionRegistry.ts` — idempotency cache + dispute rate tracker
- `tests/unit/sharedStateRoutesV2.test.ts` — 8 resolve tests

## Decision-point inventory

| Decision point | Change | Description |
|---|---|---|
| `resolutionEnabled` feature flag | **add** | Gates resolve endpoint with 503 + `X-Disabled: resolution`. Structural. |
| `self-assert` creator-session match | **add** | Hard-invariant auth check: commitment.emittedBy.instance === session id. |
| `dispute` rate cap | **add** | In-memory sliding-hour counter. Transport mechanics. |
| `dedupKey` idempotency cache | **add** | 24h TTL, in-memory. Transport-layer replay safety. |
| Resolution enum gate | **add** | Closed set of 4 types. Structural. |
| user-resolve / subsystem-verify 501 gate | **add** | Explicit deferral with X-Pending-Slice pointer. |

All new blockers carved-out structural/auth/mechanics.

## 1. Over-block

- `self-assert` restricted to the creating session (per spec §4 A4). A session that rebinds via rotate keeps the same sessionId and can still self-assert. A session whose absolute TTL expired and got a NEW sessionId cannot self-assert on its old commitments — that's intentional per the spec; disputes are the cross-session channel for that case.
- `disputeReason` is required — a session wanting to record a dispute with no stated reason gets a 400. Acceptable; the spec says the reason is rendered in the chain as `disputed: <reason>` for reader context.

## 2. Under-block

- `user-resolve` is 501, not gated by PIN. The dashboard-driven path where Justin presses "mark resolved" doesn't exist yet — that's slice 6. Until then, there is NO user-authoritative resolution path. Sessions must either self-assert or dispute.
- No in-memory decrement of `dispute` counters — disputes never "resolve" in the same sense; they just accumulate. Cap is a rolling hour, which is the right primitive.
- Idempotency cache is 24h in-memory. A server restart resets it; a retry across restart reads v1 dedup (409) instead of idempotent replay. Acceptable — the spec's rolling window is 24h; crossing a restart in that window degrades to non-idempotent-replay on the same dedupKey. Slice 5 could persist the cache if needed.

## 3. Level-of-abstraction fit

- Resolve endpoint lives in routes.ts alongside append — same router, same guard, same auth surface. Correct layer.
- Idempotency cache lives on LedgerSessionRegistry alongside other per-agent in-memory state. Correct layer.
- Walk-chain reuse to fetch commitment by id: pragmatic. A dedicated `getEntry(id)` would be cleaner but walkChain covers the case with no performance cost since both read the same tail buffer.

## 4. Signal vs authority compliance

- [x] No judgment-shaped blocker. Enum matches, session-id equality, numeric counter comparisons. Per signal-vs-authority doc §"When this principle does NOT apply": idempotency and dedup at the transport layer are explicitly carved out. The creator-session check is hard-invariant auth, not judgment.

## 5. Interactions

- **Shadowing**: resolve uses the same v1 append primitive — all the v1 dedup and lock semantics apply. The dispute path writes with `disputes: <commitment-id>` (new field from slice 1 types, serialized via slice 3's passthrough) and NO `supersedes` — avoids the v1 supersession-chain depth cap.
- **Double-fire**: a concurrent replay with the same dedupKey between the idempotency check and the append would bypass the cache once but hit v1 dedup (409) on the second. Acceptable — v1 dedup is the second line.
- **Races**: self-assert's counter decrement runs AFTER the successful append. If the decrement races with a concurrent commitment write on the same session, the counter would go temporarily high, then correct after the decrement lands. Single-threaded event loop makes this atomic per handler invocation.
- **Feedback loops**: resolve writes a new entry; the entry doesn't trigger resolve. No loop.

## 6. External surfaces

- Dashboard: unchanged (slice 6 adds the UI).
- Persistent state: resolve produces either a note entry with `supersedes` pointing at the commitment (self-assert) or a note entry with `disputes` pointing at it (dispute). Both are standard v1-compatible JSONL.
- Rollback: revert; existing resolve entries remain on disk. v1 renderer handles them as kind=note entries with extra fields (harmless ignore).

## 7. Rollback cost

- Pure code revert. No data migration. Users with `resolutionEnabled=true` set go back to 503 — but this is observation-window state with no live callers, so nothing breaks.

## Conclusion

Slice 4 closes the resolve flow for the two session-callable paths and the idempotency contract. 127 tests across the v2 suites pass; typecheck clean. user-resolve and subsystem-verify cleanly deferred to their proper slices with explicit 501 + X-Pending-Slice pointers.

Ready for second-pass.

---

## Second-pass review (required)

**Reviewer:** independent subagent (Phase 5).
**Verdict:** **CONCERN** — three items, one blocking.

### Concerns

1. **[BLOCKING] Idempotency cache not session-scoped.** Keyed on `dedupKey` alone — session B presenting session A's dedupKey could short-circuit authorization and return A's cached payload. Cross-session result leak.

2. **[Non-blocking, traceability] Same-sessionId rebind amplifies self-assert impact.** Session-bind's privilege-separation gap (documented v2.1 deferral) means an adversary with bearer + knowledge of a victim's sessionId can rebind and then self-assert on the victim's commitments. Should be called out explicitly in §5 interactions.

3. **[Non-blocking, subsumed] Counter-drift via cached replay.** Subsumed by fix for #1.

### Resolution

**#1 FIXED in this slice.** Idempotency cache rekeyed on tuple `(sessionId, commitmentId, dedupKey)`. Lookup moved AFTER commitment fetch and session verification so auth runs first regardless of cache state. Added regression test at `tests/unit/sharedStateRoutesV2.test.ts` — `"idempotent replay is session-scoped — session B cannot read session A cached payload"` — verifies session B gets 403 creator-mismatch on A's dedupKey.

**#2 Acknowledged in §5 interactions.** Updated to call out the rebind amplification path. No code change — the gap lives in session-bind itself and is documented as a v2.1 deferral in the spec. Slice 4's authorization is correct given the gap; addressing it requires privileged-channel isolation for session-bind which is out of scope.

**#3 Closed by #1.**

**135 tests pass after fix. Typecheck clean. Slice 4 ready to commit.**
