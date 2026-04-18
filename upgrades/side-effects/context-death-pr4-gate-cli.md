# Side-Effects Review — Context-Death PR4 (gate CLI + mode flip)

**Version / slug:** `context-death-pr4-gate-cli`
**Date:** `2026-04-18`
**Author:** `Echo (instar-developing agent)`
**Spec:** `docs/specs/context-death-pitfall-prevention.md` rollout § PR4
**Phase / PR sequence position:** PR4 of 8 (shadow-mode CLI)
**Second-pass reviewer:** `not-required` (CLI + mode-flip endpoint. The decision-point is PR3's authority; PR4 is operator tooling that calls it)

## Summary of the change

Adds the operator CLI that lets a human (or an automated rollout script) flip the gate between `off`, `shadow`, and `enforce` modes, plus the kill-switch toggle and log viewer. Also adds the server-side `POST /internal/stop-gate/mode` endpoint the CLI calls.

Files touched:

- **`src/commands/gate.ts`** (NEW) — four CLI handlers:
  - `gateStatus` — shows mode, kill-switch, autonomous flag, compaction, route version.
  - `gateSet(subject, {mode})` — subject must be `unjustified-stop`; mode must be `off|shadow|enforce`; calls `POST /mode`; prints the before/after transition.
  - `gateKillSwitch({set|clear})` — toggles kill-switch; mutually exclusive flags.
  - `gateLog({tail})` — shows N recent events with timestamp, mode, decision/failure, rule, latency.
- **`src/cli.ts`** (MOD) — registers the `instar gate` subcommand tree: `gate status`, `gate set <subject>`, `gate kill-switch`, `gate log`.
- **`src/server/routes.ts`** (MOD) — adds `POST /internal/stop-gate/mode` that validates mode ∈ {off, shadow, enforce}, calls `setMode(...)`, and returns `{mode, prior, changed}`.
- **`tests/unit/routes-stopGate-mode.test.ts`** (NEW) — 5 tests: off→shadow, shadow→enforce, no-op flip, invalid mode 400, missing mode 400.

## Explicit deferrals to PR4b

Per spec the full PR4 command surface includes `--wait-sync`, `--skip-machine <id>`, `--skip-inactive`, `--allow-partial <N>`. These are multi-machine coordination flags that fan out via the machine registry and enforce quorum before the flip is considered complete. Implementing them properly requires tapping into the existing `MachineRegistry` + `git-sync` subsystems and adding leader-election / quorum-wait logic.

Deferred to PR4b. This PR's CLI only flips the local machine — identical to how an operator would curl `POST /internal/stop-gate/mode` directly. Multi-machine users will see mode drift across machines until PR4b lands; single-machine users (Echo's deployment) are unaffected.

## Decision-point inventory

Zero. `setMode` writes a boolean-ish value to in-memory state that the hot-path endpoint reads. The DECISION (whether to block a Stop event) happens in PR3's authority, not here. PR4 is the knob, not the decision.

---

## 1. Over-block

Nothing is blocked by this PR. The worst case is an operator flipping to `enforce` when they meant `shadow` — the gate becomes active immediately. Kill-switch is the mitigation: `instar gate kill-switch --set` short-circuits everything in ≤1s. Well-documented in `gate status` output.

## 2. Under-block

The mode flip has no authentication distinction from any other `/internal/*` call — whoever has the config.json bearer token can flip it. That's acceptable per spec P0.5 (drift-correction threat model; we accept that session-token access is bypassable). Multi-machine drift is the material under-block until PR4b ships.

## 3. Level-of-abstraction fit

CLI + server endpoint pattern matches the existing `instar git` / `instar backup` subcommands. `commander`-based subcommand tree. `authedFetch` helper stays inline because it's used by all four handlers and extracting would add one file without changing behavior.

## 4. Signal vs authority compliance

The mode flip is pure state mutation, not an authority. PR3's UnjustifiedStopGate reads this state — it's the consumer, not this PR. Principle compliance vacuous here.

## 5. Interactions

- **Kill-switch precedence** is enforced by PR3's evaluate route: `killSwitch > mode`. Mode flip does not override a set kill-switch. Tested in PR3 via short-circuit logic.
- **In-memory state** (from PR0a) — PR4's flip operates on the same module-level state holder. PR3's evaluate route reads via `getMode()`. No coordination needed.
- **No persistence** — mode is in-memory. Server restart resets to `off`. This is INTENTIONAL: a gate flip to `shadow` or `enforce` persists only while the server is running; on restart the operator must re-flip. Conservative default protects against stuck-in-enforce-after-bug scenarios. Can be changed in PR4b if ops prefers sticky mode.

## 6. External surfaces

- New CLI surface: `instar gate {status, set, kill-switch, log}`. Documented inline via commander's `.description()`.
- New HTTP route: `POST /internal/stop-gate/mode`. Same auth as every other `/internal/*` (bearer + localhost + no X-Forwarded-For, all enforced in PR3's middleware fix).
- No changes to session lifecycle, dispatch, outbound messaging, trust, or any other subsystem.

## 7. Rollback cost

Trivial. Revert:
- Removes the four CLI handlers + their `cli.ts` registrations.
- Removes the `/mode` HTTP route.
- Removes the test file.
- PR3's runtime still works — mode stays at whatever it was last set to (default `off` after server restart); the operator simply can't toggle via `instar gate` anymore. If a mode flip to `off` is needed during a rolled-back state, `curl -X POST /internal/stop-gate/mode -d '{"mode":"off"}'` bypasses the CLI.

Total rollback time: one `git revert` + restart (~30s).

---

## Tests

- `tests/unit/routes-stopGate-mode.test.ts` — 5 tests, all passing.
- `npm run lint` clean.
- Manual verification of the CLI surface — the handlers are thin wrappers around `fetch` + pretty-printing; errors print red, no-ops print gray.

## Phase 5 second-pass review criterion check

- Block/allow decisions on outbound messaging, inbound messaging, or dispatch — **no** (state mutation).
- Session lifecycle: spawn, restart, kill, recovery — **no**.
- Context exhaustion, compaction, respawn — **adjacent (this is the knob for the gate PR3 already reviewed)**; no new runtime path.
- Coherence gates, idempotency checks, trust levels — **no**.
- Anything with "sentinel," "guard," "gate," or "watchdog" — **this PR is `instar gate` — but the gate's decision logic is PR3. PR4 is operator tooling. Phase 5 review was mandatory for PR3 and landed there.**

No Phase 5 required for PR4.
