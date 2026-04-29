# Side-Effects Review — Relay-Spawn Ghost-Reply Containment, Phase 1a (Foundation)

**Version / slug:** `relay-spawn-ghost-reply-phase1a-foundation`
**Date:** `2026-04-29`
**Author:** `echo`
**Second-pass reviewer:** `not required for this scope — pure new modules behind no call sites; mandatory for the Phase 1b wiring PR (see Integration plan below)`
**Spec:** `docs/specs/RELAY-SPAWN-GHOST-REPLY-CONTAINMENT-SPEC.md` (review-converged 2026-04-29, approved by justin)
**Scope split:** This PR ships ONLY the foundation modules — five new files plus full unit-test coverage. No call-site is modified. The integration wiring (modify ThreadlineRouter / PipeSessionSpawner / ListenerSessionManager / ThreadlineMCPServer / PostUpdateMigrator / BackupManager / ConfigDefaults) is the Phase 1b PR, tracked as ACT-801 (high, due within 7 days). Phase 2 (Component D — out-of-process shim trace recorder) is ACT-780. Phase 3 (Component E — quarantine queue + dashboard) is ACT-781. Phase-1b ships behind a default-OFF feature flag.

## Phase 1 — Principle check (per /instar-dev)

**Question:** "Does this change involve a decision point — gating information flow, blocking actions, filtering messages, or constraining agent behavior?"

**Answer:** Per `docs/signal-vs-authority.md`:
- **`SpawnLedger.tryReserve`** is an *authority* (idempotency-key exception explicitly permitted by the principle: "Idempotency keys and dedup at the transport layer ... not a judgment call — it's mechanics"). It has no behavioral side-effect in this PR because no caller invokes it yet; the authority is dormant infrastructure.
- **`HeartbeatWatchdog`** is a pure *signal-producer*. Emits `heartbeat-missing|forged|stale|pid-dead|verified` events to a registered consumer. No blocking, no kill power. Dormant in this PR (not started by any composition root).
- **`RelaySpawnFailureHandler`** is the *smart authority* that consumes watchdog signals and decides verified vs failed-quarantined. Single authority per decision point. Dormant in this PR.
- **`HeartbeatWriter`** and **`SpawnNonce`** are pure utilities — no decisions, no signals.

The principle check is satisfied: every brittle structural check (CAS, HMAC verify) operates on structural concerns where authority is permitted. Every judgment-class concern routes through the smart-authority handler. Because nothing is wired in this PR, the principle check is a no-op operationally — but the modules carry the correct shape for the wiring PR.

## Summary of the change

Adds five new files under `src/threadline/` plus their unit tests. Zero existing files are modified. No production code path is altered.

Files added:
- `src/threadline/SpawnLedger.ts` — SQLite-backed CAS ledger (`INSERT OR FAIL` on eventId PK), per-peer rolling rate cap, global hard cap, HMAC heartbeat verification with `crypto.timingSafeEqual`, prune-terminal helper that NEVER prunes in-flight rows, `listSpawning()` enumerator for the watchdog.
- `src/threadline/SpawnNonce.ts` — `deriveEventId(envelope)` (sha256 of `signedBy || nonce || messageId` — bound to authenticated material) plus `prepareNonceFd(nonce)` for FD-3 pipe handoff (tmpfile + immediate-unlink pattern, portable substitute for POSIX pipe(2)).
- `src/threadline/HeartbeatWriter.ts` — utility for spawned sessions to write atomic-rename signed heartbeats; `readSpawnNonceFromFd3()` for the spawned-session boot path.
- `src/threadline/HeartbeatWatchdog.ts` — single-shared 1s-poller, signal-producer with strict signal kinds, no-throw tick guarantee, verified-once and terminal-once dedup.
- `src/threadline/RelaySpawnFailureHandler.ts` — smart authority that translates signals to ledger transitions plus quarantine + thread-opened-emit decisions.

Tests added (50 new tests, all green):
- `tests/unit/threadline/SpawnLedger.test.ts` — 15 tests
- `tests/unit/threadline/HeartbeatWriter.test.ts` — 7 tests
- `tests/unit/threadline/HeartbeatWatchdog.test.ts` — 9 tests
- `tests/unit/threadline/RelaySpawnFailureHandler.test.ts` — 7 tests
- `tests/unit/threadline/SpawnNonce.test.ts` — 8 tests
- `tests/unit/threadline/spawn-guard-incident-repro.test.ts` — 4 tests (module-level reproduction of the original ghost-reply incident: ghost session → quarantine + no thread-opened; healthy session → thread-opened exactly once; forged heartbeat → quarantined as forged; replay → second reservation rejected)

## Decision-point inventory

- `SpawnLedger.tryReserve(eventId, peerId)` — **add** — authority (idempotency-key dedup; permitted exception). Inert until Phase 1b wires the call site.
- `HeartbeatWatchdog.tick()` — **add** — signal-producer. Inert until Phase 1b starts the timer in a composition root.
- `RelaySpawnFailureHandler.handle(signal)` — **add** — smart authority. Inert until Phase 1b registers it as the watchdog consumer.

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Operationally — none, because no call site invokes the new code. The modules' over-block surface (Phase 1b: a retry of a legitimately-failed spawn carries the same eventId and is rejected) is documented in the spec under §Component A and addressed via the manual-retry admin endpoint that ships in Phase 1b. The conservative posture is intentional: auto-retry after a forged-heartbeat is itself a vector.

## 2. Under-block

**What failure modes does this still miss?**

- Multi-machine duplicate spawn on the same envelope across paired-instar deployments: explicitly out of scope, tracked by ACT-776 (`MULTI-MACHINE-SPAWN-LEDGER-SPEC.md`).
- A non-cooperating session that bypasses the heartbeat instruction entirely is correctly caught by `heartbeat-missing` — but only when the watchdog is started, which is Phase 1b. In this PR the under-block is total because nothing runs.
- Reply-content fabrication is NOT addressed by Phase 1 at all; Component D ships as Phase 2 (ACT-780).

## 3. Level-of-abstraction fit

`SpawnLedger` is a structural primitive. SQLite with `INSERT OR FAIL` is exactly the right primitive for idempotency-key dedup. `HeartbeatWatchdog` is a single-poller pattern at the right layer (one timer, one readdir per tick, fan-out into structured signals). `RelaySpawnFailureHandler` is the smart authority. `HeartbeatWriter` and `SpawnNonce` are pure utilities. All five live as siblings under `src/threadline/`, the right namespace for the relay path.

The Phase-1a/1b split is itself a level-of-abstraction call: shipping the foundation as a self-contained PR keeps the diff narrow and reviewable, and lets the wiring PR concentrate on existing-module modifications without entangling them with new-file review. This is the inverse of the failure mode where a single PR mixes new infrastructure and call-site changes and reviewers can't tell which assertions cover which.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change adds modules that hold no operational authority in this PR (no call sites wire them). Once wired in Phase 1b, each authority is at the correct level: `SpawnLedger.tryReserve` is structural-only (permitted exception); `RelaySpawnFailureHandler.handle` is a smart authority with full context; `HeartbeatWatchdog` produces signals only.
- [ ] Yes with brittle logic — N/A.

## 5. Interactions

- **Shadowing:** none possible in this PR — no call-site is modified. Phase 1b will run `SpawnLedger.tryReserve` BEFORE the existing `spawnManager.evaluate()` call at `ThreadlineRouter.spawnNewThread`. The integration plan below names the line.
- **Double-fire:** none in this PR. Phase 1b: the existing in-memory `pendingSpawns` Set in `ThreadlineRouter` (per-threadId, per-process) and the new `SpawnLedger` (per-eventId, cross-process) are orthogonal — they catch different races. Both stay.
- **Races:** SQLite WAL + flock (already-pragma'd by SpawnLedger) handles two-process coordination on the same host. Atomic-rename in `HeartbeatWriter` solves the watchdog vs writer race the round-1 review surfaced. `HeartbeatWatchdog` uses verified-once and terminal-once Sets to prevent self-double-fire.
- **Feedback loops:** none in this PR. Phase 1b's `RelaySpawnFailureHandler.quarantineToInbox` does NOT auto-retry — that's an attacker amplification vector per spec.

## 6. External surfaces

- **Other agents on same machine:** none in this PR — no cross-agent surface added. Phase 1b: SQLite ledger lives at `.instar/threadline/spawn-ledger.db`, per-agent state-dir, no cross-agent surface.
- **Other users:** none. The modules don't ship to any consumer until Phase 1b.
- **External systems:** none. No relay protocol change. The fix is fully receiver-side spawn handling.
- **Persistent state:** none in this PR. Phase 1b: new SQLite db at `.instar/threadline/spawn-ledger.db`, included in BackupManager, PRAGMA wal_checkpoint(TRUNCATE) pre-snapshot.
- **Timing:** no runtime impact in this PR. Phase 1b: 5s first-heartbeat grace + 1s watchdog tick + 10s refresh cadence are configurable defaults.

## 7. Rollback cost

- **Hot-fix release:** revert this PR — pure file additions, no behavior change. `git revert` of the merge commit removes 5 source files + 6 test files. Zero impact on running agents.
- **Data migration:** none — no schema is created until Phase 1b runs.
- **Agent state repair:** none.
- **User visibility:** none.

## Integration plan (Phase 1b, tracked as ACT-801)

The next PR will:

1. **Modify `src/threadline/ThreadlineRouter.ts`:**
   - At `spawnNewThread` (currently line 583, `await this.spawnManager.evaluate(...)`): call `SpawnLedger.tryReserve(deriveEventId(envelope), peerFingerprint)` FIRST. On `reserved: false, reason: 'duplicate-event'`, return the receipt path's existing duplicate-detection result (no new spawn). On `peer-rate-limit` or `ledger-full`, return delivery-failed.
   - Move the `emitLedger({ kind: 'thread-opened', ... })` call (currently lines 627–634) OUT of the spawn-side-effect path. Phase 1b will route that emit through `RelaySpawnFailureHandler.emitThreadOpened`, which fires only on heartbeat-verified.
   - Inject the new `SpawnLedger`, `HeartbeatWatchdog`, and `RelaySpawnFailureHandler` instances via the existing constructor-DI pattern.
   - All changes feature-flagged on `threadline.spawnGuard.enabled` (default `false` until soak).

2. **Modify `src/threadline/PipeSessionSpawner.ts` and `src/threadline/ListenerSessionManager.ts`:**
   - Accept `spawnNonce: Buffer | null` from the caller. When non-null, open the FD-3 pipe via `prepareNonceFd(nonce)` and bind via `stdioWithNonceFd(handle)` on `child_process.spawn()`.
   - Inject the heartbeat-write loop into the spawned-session prompt template (read FD 3 once at boot via `readSpawnNonceFromFd3()`, then write to `<sessionsDir>/<threadId>.alive` every 10s using `HeartbeatWriter`).

3. **Modify `src/threadline/ThreadlineMCPServer.ts`:**
   - Add optional `deliveryStatus: 'confirmed' | 'unconfirmed' | 'failed'` field to `threadline_send` response when caller passes `senderConfirmation: true` option (Component C-floor; default off).

4. **Modify `src/core/PostUpdateMigrator.ts`:**
   - `mkdirSync(.instar/threadline/sessions)` and initialize `SpawnLedger` schema on update. Idempotent.

5. **Modify `src/core/BackupManager.ts`:**
   - Include `.instar/threadline/spawn-ledger.db` in snapshot (via PRAGMA wal_checkpoint pre-copy already implemented in `SpawnLedger.close()`).

6. **Modify `src/server/ConfigDefaults.ts`:**
   - Add `threadline.spawnGuard = { enabled: false, perPeerCap: 1000, globalCap: 100_000, firstHeartbeatGraceMs: 5_000, refreshCadenceMs: 10_000 }`.

7. **Composition root wire-up (server startup):**
   - Construct `SpawnLedger`, `HeartbeatWatchdog`, `RelaySpawnFailureHandler`. Start watchdog. Pass to `ThreadlineRouter` constructor. Gated on the config flag.

8. **Tests:**
   - End-to-end integration test: send a synthetic envelope through `ThreadlineRouter.handleInboundMessage`, assert the ledger row is reserved before `spawnManager.evaluate` is called.
   - Negative test: configure a stub spawner that never writes a heartbeat; assert the watchdog signals `heartbeat-missing` and the failure handler quarantines the envelope without firing thread-opened.

9. **Side-effects artifact:** `upgrades/side-effects/relay-spawn-ghost-reply-phase1b-wiring.md` — covers the modify-existing-files surface, includes second-pass review (mandatory because the change touches outbound messaging, session lifecycle, and watchdog/sentinel pattern).

## Conclusion

Phase 1a ships the foundation — five new modules with 50 unit tests, zero call-site impact, zero behavior change in production. The infrastructure is ready for the Phase-1b wiring PR which will gate it behind a default-OFF feature flag. The Phase-1a/1b split keeps each diff reviewable and rolls back independently. Tracked follow-ups: ACT-775 (cross-model review pre-merge of any spawn-guard wiring PR), ACT-776 (multi-machine ledger spec), ACT-777 (sandbox isolation spec), ACT-780 (Phase 2 Component D), ACT-781 (Phase 3 Component E), ACT-801 (Phase 1b wiring).

## Evidence pointers

- All 50 new tests pass (`vitest run tests/unit/threadline/SpawnLedger.test.ts tests/unit/threadline/HeartbeatWriter.test.ts tests/unit/threadline/HeartbeatWatchdog.test.ts tests/unit/threadline/RelaySpawnFailureHandler.test.ts tests/unit/threadline/SpawnNonce.test.ts tests/unit/threadline/spawn-guard-incident-repro.test.ts`).
- `tsc --noEmit` clean across the new files.
- Module-level incident reproduction: `tests/unit/threadline/spawn-guard-incident-repro.test.ts` exercises ghost / healthy / forged / replay paths.
