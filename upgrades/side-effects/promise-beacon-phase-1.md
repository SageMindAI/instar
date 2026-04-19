# Side-Effects Review — Promise Beacon Phase 1 (core monitor + shared queue + delivery endpoint)

**Version / slug:** `promise-beacon-phase-1`
**Date:** `2026-04-19`
**Author:** `echo`
**Second-pass reviewer:** `not required` (prereq PR #71 landed first; this lands the core behind the same review-convergence tag)

## Summary of the change

Lands the Phase 1 scope of `docs/specs/PROMISE-BEACON-SPEC.md`: a third monitor that sits alongside `PresenceProxy` and `CommitmentTracker` and emits `⏳` heartbeats on commitments where the agent has gone quiet on an open promise. Changes are additive and scoped — the beacon only engages for commitments that explicitly opt in via `beaconEnabled: true`.

Files touched:
- `src/monitoring/LlmQueue.ts` — NEW. Shared, priority-laned LLM queue with interactive-lane reserve and AbortController preemption of background calls. Extracted as its own module so `PresenceProxy` can adopt it incrementally without a disruptive refactor.
- `src/monitoring/ProxyCoordinator.ts` — NEW. Per-topic mutex so `PresenceProxy` (🔭) and `PromiseBeacon` (⏳) cannot double-post to the same topic in the same second.
- `src/monitoring/PromiseBeacon.ts` — NEW. The monitor itself: `setTimeout`-based scheduling, snapshot-hash gate (templated line when the tmux output is unchanged), session-epoch violation path, quiet-hours and daily-spend-cap suppression, hot state at `.instar/state/promise-beacon/<id>.json` (gitignored under the existing `.instar/state/` entry).
- `src/monitoring/CommitmentTracker.ts` — schema additions (optional beacon fields on `Commitment`), new terminal status `delivered`, `deliver(id, deliveryMessageId)` method emitting a `delivered` event.
- `src/monitoring/PresenceProxy.ts` — acquires the shared `ProxyCoordinator` mutex in `sendProxyMessage` when the coordinator is wired, so a simultaneous beacon fire doesn't double-post.
- `src/server/routes.ts` — `POST /commitments/:id/deliver` endpoint + beacon fields accepted on `POST /commitments` (with validation: `beaconEnabled` requires `topicId` and at least one of `nextUpdateDueAt` / `softDeadlineAt` / `hardDeadlineAt`).
- `src/commands/server.ts` — wires the `ProxyCoordinator` and a shared `LlmQueue` instance, passes the coordinator to `PresenceProxy`, instantiates `PromiseBeacon` after `PresenceProxy.start()` guarded by the same intelligence/telegram gates.
- `src/commands/init.ts` — commit-action skill template extended with a Promise Beacon block documenting how to opt in via `POST /commitments`.
- `tests/unit/LlmQueue.test.ts` — NEW (5 tests): concurrency, interactive preemption via AbortController, interactive reserve enforcement, daily cap, priority ordering.
- `tests/unit/ProxyCoordinator.test.ts` — NEW (5 tests): mutual exclusion, reentrancy, release semantics, topic isolation.
- `tests/unit/PromiseBeacon.test.ts` — NEW (4 tests): snapshot-hash gate skips the LLM, session-epoch mismatch transitions to `violated`, quiet hours suppress (not violate), daily spend cap suppresses (not violates).
- `tests/integration/PromiseBeacon-lifecycle.test.ts` — NEW (2 tests): end-to-end record → heartbeat → deliver → stop; terminal status rejects re-delivery.

Decision-point surfaces touched:
- `POST /commitments` (validation only — no change in who can create a commitment; beacon opt-in requires the same authenticated caller as an ordinary record).
- `POST /commitments/:id/deliver` (new — transitions an already-existing commitment from `pending` to `delivered`; terminal-status guard prevents re-delivery).
- `PromiseBeacon.fire()` internal transitions (`pending → violated` on session-epoch mismatch; `pending` + `beaconSuppressed: true` on quiet-hours / daily-cap).

## Decision-point inventory

- **`beaconEnabled` validation**: a new 400 on `POST /commitments` when `beaconEnabled: true` but `topicId` or all three deadline markers are missing. Surface rejection only — never blocks an agent from making the underlying commitment, it rejects the *beacon activation* for malformed input. Agent can still record the commitment without `beaconEnabled`.
- **`quiet-hours` suppression**: non-terminal. Status stays `pending`. Flag `beaconSuppressed: true` + reason documented in the record; the scheduler re-arms the timer so the beacon resumes after the window.
- **`daily-spend-cap` suppression**: same shape as quiet-hours — non-terminal, re-armed hourly.
- **`session-lost` transition**: `pending → violated`. This is the only place the beacon terminally mutates a commitment. Triggered only by explicit session-UUID mismatch supplied by the wiring; there is no heuristic path to `violated`.

All block/authority decisions land on the same authenticated caller as the existing `CommitmentTracker` write paths. The beacon itself never blocks or mutates agent output, only produces its own proxy-tagged emissions.

---

## 1. Over-block

- **`POST /commitments` beacon validation**: can it block a legitimate beacon opt-in? Only if the caller forgot `topicId` or all three deadline fields. Both are required by spec (§"No default hardDeadlineAt" and §A10). The rejection carries a precise error message identifying the missing field, so retry is trivial.
- **`session-lost` auto-violation**: could a transient session-UUID hiccup (e.g., a brief tmux restart) fire a false violation? The wiring uses the Claude Code session UUID read from the session metadata file — it does not mutate during normal operation. `getSessionEpoch` is called only at beacon-fire time (not continuously), and the Round 3 #3 spec clarification deliberately removed `serverBootId` from the epoch precisely so server restarts don't auto-violate. The remaining false-positive surface is bounded to cases where the session is genuinely restarted.

Over-block risk: low. Both paths carry clear errors and are bounded.

---

## 2. Under-block

- **`beaconEnabled` on an existing pending commitment**: the current validation only fires on `POST /commitments`. An agent could record a commitment without `beaconEnabled` and later mutate it to `beaconEnabled: true` via `PATCH` if such a route exists. Mitigation: no PATCH route on `/commitments` adds beacon fields in this PR; the only post-creation state change is `deliver` / `withdraw`. Phase 2 may add a `PATCH` — when it does, the same validation must be applied there.
- **Missing sessionEpoch**: if `sessionEpoch` is unset on a beacon commitment, the violation path is inert. This is intentional — the Round 3 #3 clarification makes the session-epoch check conditional on both the stored and live epoch being present. When the wiring does not provide `getSessionEpoch`, the check is skipped entirely. No hidden auto-violation.
- **`proxyCoordinator` absent**: a third party wiring the beacon without a coordinator (e.g., a future embedding) would lose the double-post guard. The class constructor requires a coordinator — you cannot instantiate without it. TypeScript enforces this.

Under-block risk: low, with one named follow-up (`PATCH`).

---

## 3. Level-of-abstraction fit

- `LlmQueue` belongs as a standalone module — both `PresenceProxy` and `PromiseBeacon` consume it, and the daily spend cap is a cross-cutting concern not owned by either monitor.
- `ProxyCoordinator` belongs at the monitoring-layer level for the same reason. In-memory, per-process, no persistence, no distributed lock — matches spec §P16.
- `PromiseBeacon` owns its own scheduling and hot-state file I/O; cold writes go through `CommitmentTracker.mutate()` so the beacon never bypasses the single-writer surface the PR #71 prereq established.
- `deliver()` belongs on `CommitmentTracker` (not on `PromiseBeacon`) because the status transition is a property of the commitment record, not of the beacon. The beacon subscribes to the tracker's `delivered` event to stop its timer — decoupled side-effect, not a call chain.

Level-of-abstraction fit: right layers. No violations of the signal-vs-authority rule: the beacon emits `⏳` status lines (signal) but the only authority it exercises is over the fields it owns (`heartbeatCount`, `lastSnapshotHash`, etc. via `mutate`).

---

## 4. Signal vs authority compliance

- **Signal**: the beacon emits `⏳` heartbeats (informational, user-facing) and fires internal EventEmitter events (`heartbeat.fired`, `heartbeat.skipped`, `promise.violated`) for downstream observers.
- **Authority**: the only record mutation the beacon exercises under normal operation is hot-field updates via `mutate()` (`lastHeartbeatAt`, `heartbeatCount`, `lastSnapshotHash`) and `beaconSuppressed` flag writes during quiet-hours / cap. These are non-terminal, per-record, and visible.
- **Terminal authority** is exercised exactly once: `session-lost` transitions `pending → violated`. This is gated on an explicit UUID mismatch (not a heuristic), emits a user-visible `⚠️` notice, and is irreversible only in the sense that *the commitment* is terminal — the user can always record a fresh replacement commitment.
- No route in this PR allows an agent to self-grant beacon opt-in on someone else's commitment. The `record()` API is the same one the `commit-action` skill already uses.

Compliance: clean.

---

## 5. Interactions

- **PresenceProxy coexistence**: shared `ProxyCoordinator` ensures only one of 🔭/⏳ emits per topic per moment. The mutex is reentrant by holder; release is a no-op from the non-holder. Covered by `ProxyCoordinator.test.ts`.
- **CommitmentTracker verify-loop**: the verify loop runs on `one-time-action` and `config-change` types and does not look at beacon fields. A `delivered` commitment is no longer active (filtered out by `getActive()`). No interaction.
- **CommitmentSentinel (Phase 2)**: not wired in this PR. The sentinel's default `sentinelAutoEnable` is `false`, the spec's shadow-mode requirement is preserved for Phase 2.
- **InitiativeTracker**: distinct week-scale board; no interaction. The beacon is minute-scale.
- **Backup/restore**: hot state files under `.instar/state/promise-beacon/` are gitignored (under the existing `.instar/state/` entry). Spec §"Backup/restore notice symmetry" (A27) is not implemented in this PR — the stale-threshold auto-transition is Phase 1 follow-up. Documented in PR body.

---

## 6. Rollback cost

- **Runtime disable**: `config.json → promiseBeacon.enabled = false` is not yet a read flag in Phase 1 — the monitor wires unconditionally inside the existing `sharedIntelligence && telegram` guard. To disable at runtime, comment out the `PromiseBeacon` block in `src/commands/server.ts` and restart. Documented as a known gap for Phase 2.
- **Full revert**: revert the PR. `Commitment` schema additions are all optional — existing code ignores them. Hot state files under `.instar/state/promise-beacon/` become orphaned but harmless (the state dir is gitignored and disposable). The new `delivered` status value is referenced only by the new `deliver()` method and the new endpoint — reverting the endpoint + method removes all producers.
- **Partial revert**: reverting only `PromiseBeacon.ts` + `ProxyCoordinator.ts` + the wiring block leaves `LlmQueue.ts` as an unused utility. Harmless.

Rollback cost: low. No data migrations, no irreversible state changes.

---

## Known limitations / scoped-out pieces

Called out in the PR body so they land as explicit follow-ups:

- `atRisk` corroboration path (spec Round 3 #1) — the beacon lands with hard-signal-only violation. Soft-signal `atRisk` doubling-cadence is a small follow-up.
- `beaconSuppressed` boot-cap enforcement (spec Round 3 #2) — not needed at Phase 1's single-digit commitment counts; landed as a follow-up.
- `PATCH /commitments/:id` beacon-field mutation — not in this PR; apply the same validation when added.
- Dashboard Commitments-tab "Open promises" section — stubbed out for the next PR; the `GET /commitments` endpoint already exposes the fields the tab needs.
- `<active_commitments>` compaction-recovery injection — spec Round 3 #7; follow-up.
- `PresenceProxy` migration to the shared `LlmQueue` — the queue is extracted and wired into the beacon; `PresenceProxy` still uses its own local queue. Follow-up PR will migrate it so the daily-spend-cap is shared end-to-end.

---

## Evidence the change works

- `npx tsc --noEmit` clean.
- `npx vitest run tests/unit/LlmQueue.test.ts tests/unit/ProxyCoordinator.test.ts tests/unit/PromiseBeacon.test.ts tests/integration/PromiseBeacon-lifecycle.test.ts` — 16/16 pass.
- `npx vitest run tests/unit/CommitmentTracker.test.ts tests/unit/CommitmentTracker-mutate.test.ts` — prior suite unaffected (47/47 pass).
- `npx vitest run tests/unit/presence-proxy-*.test.ts` — 39/39 regression pass, confirming the `ProxyCoordinator` wiring is backwards-compatible (the config property is optional).
