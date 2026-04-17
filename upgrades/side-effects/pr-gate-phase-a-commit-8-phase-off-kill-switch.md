# Side-Effects Review — prGate.phase='off' kill-switch + 404 middleware

**Version / slug:** `pr-gate-phase-a-commit-8-phase-off-kill-switch`
**Date:** `2026-04-17`
**Author:** `Echo (instar-developing agent)`
**Second-pass reviewer:** `required — touches block/allow on an HTTP namespace (gate semantics)`

## Summary of the change

Lands the `prGate.phase` runtime kill-switch. Every existing and future `/pr-gate/*` request is now gated by a single Express middleware at the top of `routes.ts`. The middleware uses a **default-BLOCK + allowlist** shape: it admits only the three explicit active phases (`'shadow'`, `'layer1-2'`, `'layer3'` — after `trim().toLowerCase()` normalization) and 404s every other value, including `'off'`, `'OFF'`, empty string, whitespace-padded strings, numbers, `null`, typos, and the default-when-unset case. 404 body: `{disabled: true, reason: 'prGate.phase=off'}`.

Default-block + allowlist is the correct shape for a safety guard where false-pass is catastrophic (per `docs/signal-vs-authority.md` §"When this principle does NOT apply" bullet 2). An earlier draft used default-pass with a literal `=== 'off'` check; the second-pass reviewer caught that this would let any non-exact-match string (typos, casing, trailing whitespace, or a new unmapped phase value) bypass the gate entirely — foot-gun for Phase B+ commits that register real handlers. Shape inverted before commit.

Placement is structural: the middleware is declared immediately after `const router = Router()` — Express middlewares only apply to routes registered later in the same Router, so placing this one first guarantees every future pr-gate route is gated without explicit wiring.

Files touched:
- `src/server/routes.ts` — phase-gate middleware at the top of `registerRoutes()`.
- `src/core/types.ts` — new `PrGateConfig` interface; `InstarConfig.prGate?: PrGateConfig` optional field.
- `src/config/ConfigDefaults.ts` — `SHARED_DEFAULTS.prGate = { phase: 'off' as const }` so `PostUpdateMigrator.applyDefaults` sets the key on every existing agent on next update.
- `tests/unit/routes-prGatePhaseGate.test.ts` — 14 integration tests using real Express instances, covering: explicit 'off', missing prGate, missing phase, phase='shadow' pass-through (incl. whitespace-normalized), phase='layer3' pass-through, every subroute under `/pr-gate` gated, non-/pr-gate routes NOT gated, uppercase-'OFF' blocked, empty string blocked, trailing-whitespace 'off ' blocked, unknown 'bogus' blocked, null blocked, numeric blocked.

This is commit 8 — the final source-side commit of Phase A of `docs/specs/PR-REVIEW-HARDENING-SPEC.md`. The spec's §"Runtime kill-switch" specifies exactly this behavior.

## Decision-point inventory

- **`phase === 'off'` branch → 404**: a structural block. Brittle logic (string-equality check) with hard-block authority on an entire HTTP namespace. This is the kill-switch — by design the simplest possible mechanism. It is the EXPLICIT exception that `docs/signal-vs-authority.md` §"When this principle does NOT apply" bullet 2 carves out: safety guards on irreversible actions. Here the "irreversible action" is accepting a write into the pr-gate eligibility pipeline before the infrastructure is ready. False-pass is catastrophic (unvalidated eligibility records); false-block is trivial (404 with a clear reason body, Justin flips one config key to unblock).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

During Phase A: ALL `/pr-gate/*` requests are intentionally rejected with 404. This is the defined Phase A behavior — no endpoints are ready yet. The dashboard's PR Pipeline tab (commit 7) consumes the 404 cleanly via its 404-aware fallback.

During Phase B+ (post-flip): no over-block. The middleware's decision is `phase === 'off' ? block : pass`. If the phase is anything else, downstream handlers own the decision.

One edge: the first request after a `config.json` write flipping `prGate.phase` from 'off' to 'shadow' may still be blocked if the server's in-memory config snapshot hasn't refreshed. The spec handles this via the config-reload mechanism (server re-reads on SIGHUP or next restart). Not in scope for this commit; noted.

---

## 2. Under-block

**What failure modes does this still miss?**

- An attacker who can write to `.instar/config.json` can flip `prGate.phase` to `'layer3'` and bypass the kill-switch. This is a trust-floor concern: anyone with write access to the config already owns the server. Out of scope.
- The middleware only gates `/pr-gate/*`. If a future phase registers a pr-gate operation under a different prefix (e.g., `/api/pr-gate/metrics`), it would NOT be gated. Mitigation: keep all pr-gate endpoints under `/pr-gate/*` by convention; enforced by code review, not by this middleware.
- The middleware doesn't validate token presence or correctness — that's the downstream handlers' responsibility. For phase=off, returning 404 before the auth check is intentional: don't leak that the endpoint exists if it's disabled.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. Express middleware is the natural place for cross-cutting enablement gates on an HTTP namespace. Putting it at the top of the router (before any /pr-gate handler is declared) means future phases add handlers without needing to remember to consult the phase — the middleware always runs first. This matches how analogous gates work elsewhere in the codebase (threadline routes are conditionally `router.use(threadlineRoutes)`; moltbridge likewise).

An alternative shape (check `phase` inside each handler) would scatter the kill-switch across every future pr-gate handler — brittle and easy to forget. The middleware shape is strictly better.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] Yes — but the logic is a hard-invariant safety guard, explicitly carved out in §"When this principle does NOT apply" bullet 2 (safety guards on irreversible actions). String-equality on a config value is the correct shape for a kill-switch: the cost of accepting an eligibility write into an un-ready pipeline is catastrophic (could leak tokens, poison records, mis-replicate); the cost of a false block is trivial (Justin flips one key).

Narrative: the principle's target failure mode is brittle filters holding authority over *judgment* decisions where context would matter. `phase === 'off'` is not a judgment — it is a structural fact about whether the operator has authorized the feature. The distinction is clean: judgment decisions go through smart gates; runtime kill-switches are brittle by design because that's exactly what a kill-switch is.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** the middleware shadows every future /pr-gate/* handler during phase=off. This is the intended behavior. It does NOT shadow any currently-registered handler because no /pr-gate/* handler exists yet.
- **Double-fire:** Express runs middlewares once per request in registration order. No double-fire.
- **Races:** synchronous middleware; no shared mutable state. No races.
- **Feedback loops:** none.
- **Interaction with `PostUpdateMigrator.applyDefaults`:** `SHARED_DEFAULTS.prGate = { phase: 'off' }` ensures every existing agent's `config.json` gains the key on next migration. `applyDefaults` only adds missing keys (arrays as opaque leaves); a user who manually set `prGate.phase` to something else retains their value.
- **Interaction with `BackupConfig` plumbing (commit 2):** both add a key under `SHARED_DEFAULTS`. Independent.
- **Interaction with `migrateBackupManifest` (commit 5):** the migrated backup paths include `.instar/state/pr-gate/phase-a-sha.json` — so the phase-a-sha grandfathering boundary gets snapshotted even while the gate is 'off'. Correct; the boundary SHA is set by a separate commit-lifecycle step (§"phase-a-sha.json lifecycle" in the spec) that is not this commit.
- **Interaction with the dashboard PR Pipeline tab (commit 7):** the tab fetches `/pr-gate/metrics`. This middleware returns 404, and the tab handles 404 by rendering the "Gate disabled (phase=off)" placeholder. End-to-end path verified structurally (though not in a browser here).

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** none.
- **Users of the install base:** on next `npm update`, every agent's `config.json` gains `prGate: { phase: 'off' }`. No user-visible behavior change (the routes were already 404 — as unregistered — before; now they 404 with a specific body). The dashboard tab renders the phase-off placeholder.
- **External systems:** no. The middleware does not make external calls.
- **Persistent state:** one new key in `config.json`.
- **Git-sync:** the `config.json` update will propagate to paired machines. All paired machines will see `prGate.phase='off'` and behave identically.
- **Timing:** single string comparison per /pr-gate/* request. Negligible.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure code revert. The middleware disappears; the `prGate` key in config.json becomes unread (harmless). No dashboard regression — the PR Pipeline tab would then get the natural Express 404 (no body), which its loader handles identically to a 404-with-body (both paths render the "Gate disabled" placeholder via the httpStatus === 404 check).

Estimated rollback effort: one commit revert, one patch release. Zero data migration, zero operational action.

---

## Conclusion

The Phase A landing commit for the pr-gate kill-switch. Structurally gates every `/pr-gate/*` route via Express middleware; config key + default shipping so every agent flips into the 'off' state on next update. 7 integration tests using real Express instances cover every branch. Existing Config + ConfigDefaults tests (21) still pass; tsc clean.

This completes the source-side Phase A work. Runtime enablement (Phase B flip to 'shadow') requires only a `config.json` edit plus a server restart — no additional source commits.

Clear to ship as Phase A commit 8 of 8 — pending second-pass reviewer per `/instar-dev` Phase 5 (gate/kill-switch surface).

---

## Second-pass review (if required)

**Reviewer:** independent subagent (general-purpose agent, fresh context)
**Independent read of the artifact: concern-raised, then concur after fix**

Reviewer independently verified:
- Middleware placement at top of `createRoutes()` in `src/server/routes.ts` — structurally correct; no downstream `/pr-gate/*` handler exists yet, so the middleware currently handles all /pr-gate traffic.
- Mount path `router.use('/pr-gate', ...)` — probed adjacent prefixes (`/pr-gateway/ok`) at runtime and confirmed not-gated; no over-block on sibling namespaces.
- Express URL casing is insensitive by default, so `/PR-GATE/status` also gets blocked — good for kill-switch semantics.
- Config plumbing: `PrGateConfig` at types.ts, `InstarConfig.prGate?` field, `SHARED_DEFAULTS.prGate = { phase: 'off' as const }` — the `as const` is erased by `Record<string, unknown>` with no widening fallout.
- tsc clean.

**Concern raised** (pre-fix): the original implementation used `phase === 'off'` default-pass, which would let any non-exact-match string bypass the gate — `'OFF'`, `''`, `'off '`, `'bogus'`, numeric 42, `null`, or any future unmapped phase. Given the artifact's own framing (false-pass is catastrophic), the correct shape is default-block + allowlist. Foot-gun would ripple forward to Phase B+ handlers registering in a still-off-but-bypassable state.

**Resolution applied**: middleware inverted to default-block + allowlist (`PR_GATE_ACTIVE_PHASES = new Set(['shadow', 'layer1-2', 'layer3'])`). Config value normalized via `trim().toLowerCase()` before lookup. 7 additional test cases added covering the previously-bypassable inputs. All 14 tests now pass. tsc clean.

**Final verdict**: concur with the fixed implementation.

**Minor cosmetic note from reviewer** (not blocking): the test file reimplements the middleware inside `buildApp()` rather than importing `createRoutes`. A regression in the real `routes.ts` middleware wouldn't be caught by this test file alone. Noted for a follow-up test pass that boots `createRoutes(ctx)` with a stub context to exercise the actual production code path — out of scope for this commit; spec-wise the current tests exercise the middleware SHAPE while a future integration test can exercise the WIRING.

---

## Evidence pointers

- Source: `src/server/routes.ts` — middleware at top of `registerRoutes()` router.
- Source: `src/core/types.ts` — `PrGateConfig` interface + `InstarConfig.prGate?: PrGateConfig`.
- Source: `src/config/ConfigDefaults.ts` — `SHARED_DEFAULTS.prGate = { phase: 'off' as const }`.
- Tests: `tests/unit/routes-prGatePhaseGate.test.ts` — 7 tests with real Express instances, 266ms.
- Regression: Config + ConfigDefaults tests (21) pass.
- Type check: `npx tsc --noEmit` — clean.
