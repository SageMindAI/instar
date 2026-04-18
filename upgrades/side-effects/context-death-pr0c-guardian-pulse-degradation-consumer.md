# Side-Effects Review — Context-Death PR0c (guardian-pulse degradation consumer)

**Version / slug:** `context-death-pr0c-guardian-pulse-degradation-consumer`
**Date:** `2026-04-18`
**Author:** `Echo (instar-developing agent)`
**Spec:** `docs/specs/context-death-pitfall-prevention.md` § (d), DegradationReport consumer
**Phase / PR sequence position:** PR0c of 8
**Second-pass reviewer:** `not-required` (no decision-point logic; the new endpoint flips a boolean by exact-match or regex; the skill template is a documentation update — see Phase 5 criteria below)

## Summary of the change

Closes the loop for DegradationReports that aren't auto-routed by the FeedbackManager / Telegram alerter. Spec § (d) calls this out as a PR0 precondition: the future stop-gate emits DegradationReports for timeout/malformed/etc. failures, and unless guardian-pulse actively surfaces and acknowledges them, they pile up silently in `degradation-events.json`. PR0c adds the missing consumer surface.

Files touched:

- **`src/monitoring/DegradationReporter.ts`** (MOD) — adds `markReported(featurePattern: string | RegExp): number`. Returns count actually flipped. Idempotent (already-reported events are not double-counted). Pattern can be exact-string or regex for prefix/suffix matching.
- **`src/server/routes.ts`** (MOD) — adds `POST /health/degradations/mark-reported` route. Body: either `{feature: string}` (exact match) OR `{featurePattern: string}` (regex source). Returns `{flipped: number}`. 400 on missing body, invalid regex.
- **`src/commands/init.ts`** (MOD) — extends the embedded guardian-pulse skill template § "4. Degradation Reporter Health" with the active-consumption procedure. Instructions now: read `/health/degradations`, surface each unreported event to `/attention` with stable id `degradation:{feature}:{timestamp}` (idempotent re-runs), then `POST /health/degradations/mark-reported` to close the loop. Explicit fail-safe: if `/attention` POST fails, do NOT call mark-reported — leave the event for the next pulse.
- **`tests/unit/degradation-reporter-mark-reported.test.ts`** (NEW) — 6 unit tests: exact-match flip, no-match returns 0, idempotency, regex multi-match, no-match regex returns 0, doesn't double-flip auto-pipeline-reported events.
- **`tests/unit/routes-degradations-mark-reported.test.ts`** (NEW) — 5 route tests: exact match, regex multi-match, missing body 400, invalid regex 400, idempotent re-flip.

Existing `tests/unit/degradation-reporter.test.ts` (8 tests) continues to pass.

## Decision-point inventory

The new endpoint flips a boolean. It does not gate any agent behavior, does not block any session, does not control any outbound message. The guardian-pulse skill update is a procedure-extension document — it tells operators (or autonomous agents running the skill) what *to do*, not what *to allow*.

There are zero decision-points introduced. The principle compliance gate is vacuous here.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The endpoint's two 400 responses:
- Missing both `feature` and `featurePattern` — correct rejection of malformed input.
- Invalid `featurePattern` regex — correct rejection (would otherwise crash the server with an unhandled `SyntaxError`).

Both are tested. Neither over-blocks any legitimate caller.

The `markReported` method itself accepts any string pattern, so an over-broad pattern (`/.+/`) would flip every unreported event. That's the operator's call — over-broad input is an operator decision, not the function being wrong. Documentation in the guardian-pulse skill template steers callers to specific feature names.

## 2. Under-block

**What failure modes does this still miss?**

- **Race between attention POST and mark-reported.** If the attention POST succeeds but the mark-reported POST fails (network drop), the event is in attention queue but still listed as unreported — next pulse will re-surface it as a duplicate attention item. The skill template uses a stable id (`degradation:{feature}:{timestamp}`) for idempotency, so the duplicate POST hits the existing attention item by id. Acceptable: dedup is end-to-end via id reuse, not transactional.
- **Multiple events for the same feature.** `markReported('feature')` flips ALL unreported events for that feature in one shot. If only some have been surfaced and others are pending, this is wrong. Mitigation: the spec's degradation-events typically use distinct feature names per failure-mode (`unjustifiedStopGate.timeout` vs `unjustifiedStopGate.malformed` etc.), so the per-event distinction is preserved.

Neither of these is a context-death-specific concern; both apply to any caller using mark-reported.

## 3. Level-of-abstraction fit

**Is this at the right layer? Should a higher or lower layer own it?**

DegradationReporter is the right home for `markReported` — it owns the event lifecycle, has the existing reported flag, and other consumers (built-in feedback / Telegram alerter) already mutate the same flag. Co-locating the manual-mark path keeps mutation invariants in one place.

The HTTP route belongs alongside `/health/degradations` (next to it in the route file) — same namespace, same auth, same logical surface.

The skill template extension lives in `src/commands/init.ts` because that's where the templates are defined. Could it move to a separate `templates/skills/` directory? Yes — but that's a broader refactor (every skill template lives there), not a context-death PR0c concern. Keeping the extension in-place avoids scope creep.

## 4. Signal vs authority compliance

`docs/signal-vs-authority.md`: detectors emit signals; only authorities can block.

`markReported` is a state-mutator on a *signal store*. It does not block anything. It does not decide anything. It is a passive close-the-loop helper for downstream consumers.

The guardian-pulse skill itself is a *consumer* of signals (degradations) that surfaces them to operators via attention queue. Surfacing is also not a block — operators decide what to do with attention items.

Compliance is satisfied vacuously: no authority introduced, only mutation primitives for an existing signal queue.

## 5. Interactions

**Does this shadow another check, get shadowed by one, double-fire, race with adjacent cleanup?**

- **Auto-pipeline (FeedbackManager / Telegram alerter)** — both paths flip `event.reported` to `true` via direct field mutation in `reportEvent()`. `markReported` checks `!event.reported` before flipping, so an auto-flipped event won't be double-counted. Tested explicitly.
- **`/health/degradations` GET** — read-only; no race with the mark-reported POST. Successive reads after a flip will show fewer unreported events. Expected behavior.
- **`degradation-events.json` persistence** — `markReported` updates the in-memory event objects but does NOT call `persistToDisk()`. **That's a known limitation worth flagging:** if the server restarts after a mark-reported POST but before any persistence, the flip is lost. Acceptable because: (a) the event will simply re-surface next pulse, (b) the attention item is already created with a stable id so it dedups, (c) avoiding additional disk writes preserves the existing atomic-write invariants in the file. If this becomes annoying in production, a follow-up can add explicit persistence — but it's not blocking PR0c shipping.
- **Attention queue dedup** — POST /attention creates an item with the caller-supplied `id`. The skill template uses `degradation:{feature}:{timestamp}` so re-runs idempotently produce the same id — no spam.
- **Skill template** — guardian-pulse runs every 8 hours by default (per `slug: 'guardian-pulse'` schedule `'0 */8 * * *'`). Higher frequency would re-surface stale degradations more often; lower frequency means slower discovery of new degradations. Current cadence is unchanged.

## 6. External surfaces

- New HTTP route under existing `/health/*` namespace. Auth-middleware applies (existing pattern). Tunnel-reachable like all health routes.
- New exported method on DegradationReporter — backward-compatible additive change; no existing callers affected.
- Skill template changes will propagate to **new agent installations** via `instar init` and to **existing agents** via `instar upgrade --skills` (existing migration path). The change is additive (extends section 4), not destructive — operators who have customized their guardian-pulse skill will see a clean diff and can merge or skip.
- No changes to: outbound messaging, dispatch, session lifecycle, coherence, trust, or any feature outside the DegradationReporter / guardian-pulse loop.

## 7. Rollback cost

Trivial. Three commits to revert (or one if all changes ship together):
- DegradationReporter method removal (~25 lines)
- Route removal (~30 lines)
- Skill template diff (~30 lines)

No data migration. No agent-state repair. Existing `degradation-events.json` files stay valid. Total rollback time: one `git revert` + one server restart (~30s).

If only the skill template is wrong, the cheapest fix is an in-place edit (no revert) — operators get the corrected version on next `instar upgrade --skills`.

---

## Tests

- `tests/unit/degradation-reporter-mark-reported.test.ts` — 6 tests, all passing.
- `tests/unit/routes-degradations-mark-reported.test.ts` — 5 tests, all passing.
- `tests/unit/degradation-reporter.test.ts` — 8 existing tests, all passing.
- `npm run lint` — clean.

## Phase 5 second-pass review criterion check

- Block/allow decisions on outbound messaging, inbound messaging, or dispatch — **no** (no decisions added).
- Session lifecycle: spawn, restart, kill, recovery — **no**.
- Context exhaustion, compaction, respawn — **no** (this PR closes the *consumer* loop for any DegradationReport; the spec's gate is the *producer*, lands in PR3).
- Coherence gates, idempotency checks, trust levels — **no**.
- Anything with "sentinel," "guard," "gate," or "watchdog" — **the file is `DegradationReporter.ts`** (no decision logic) and the route is `/health/degradations/mark-reported` (state mutator). Phase 5's intent is to gate decision-point changes; PR0c adds none.

PR3 will require Phase 5 second-pass review.
