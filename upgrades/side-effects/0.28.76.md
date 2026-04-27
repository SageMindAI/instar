# Side-Effects Review — TelegramLifeline.versionMissing → info-only log

**Slug:** `telegram-lifeline-version-missing-info`
**Date:** `2026-04-27`
**Author:** Dawn (instar-bug-fix autonomous job)
**Cluster:** `cmo7wswhj0000mgmdbw4j7dyd` (severity: critical → resolved by reclassification)

## Summary of the change

In `src/server/routes.ts`, the backward-compat branch of the `POST /internal/telegram-forward` handler stops emitting `TelegramLifeline.versionMissing` as a `[DEGRADATION]` feedback event. The forward itself is still accepted via the documented backward-compat path; only the *classification* of the observed transition changes.

Concretely:

- The call to `DegradationReporter.getInstance().report({ feature: 'TelegramLifeline.versionMissing', … })` is removed from `routes.ts:6367-6376`.
- A one-shot `console.info` is emitted on first occurrence per process, gated by a new module-scoped `_versionMissingLogged` flag declared next to the existing `_serverVersionParsed` cache.
- No other lines of code change. No new files. No test files added or modified — the call site has no existing test coverage and the change is observability-only.

Files touched:
- `src/server/routes.ts` — two small edits described above.
- `docs/specs/telegram-lifeline-version-missing-info.md` — new spec (LOW-risk autonomous-approved).
- `upgrades/side-effects/telegram-lifeline-version-missing-info.md` — this file.
- `upgrades/NEXT.md` — release notes appended.

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None. The handler still accepts the forward; nothing is rejected. Pre-Stage-B lifelines continue to work exactly as they did, including the response body and logged inbound message. The only thing that changes is whether the acceptance is also reported as a `[DEGRADATION]` event into the feedback pipeline.

## 2. Under-block

**What failure modes does this still miss?**

A genuine class of "lifeline running with wrong assumptions about server" issues that *also* manifest as a missing version field would no longer raise a degradation event. In practice, `lifelineVersion === undefined` only happens in the pre-Stage-B compatibility scenario — newer lifelines always send the field. Any *new* incompatibility class would also need to hit a different branch of this handler to surface, which is the correct layer.

The console.info preserves the signal in server logs (the operator-side observability surface). What we lose is the per-incident feedback-pipeline submission — which was the entire point of this change, since those submissions were being mis-classified as critical.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The right long-term fix — adding a typed severity / category field to `DegradationReporter` so callers can distinguish ERROR from COMPAT_SIGNAL — is a broader API change tracked under PROP-543. This spec deliberately stays at the call site. The call site already has the contextual knowledge that *this particular* condition is observability-only (per the existing comment "emit informational signal once per cooldown" and the original commit's "Missing field accepted for backward compat."). Encoding "this is observability, not a degradation" at the call site is correct until the typed-severity refactor lands.

The chosen mechanism (module-scoped boolean + console.info) matches existing patterns in `routes.ts` (e.g. `console.log('[telegram-forward] …')` at lines 6452, 6515, 6604).

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

No. This change has no block/allow surface. It is purely a presentation/classification change about how an *already-accepted* request is reported back into the feedback pipeline. The handler still makes the same admission decision (accept the forward) it did before.

## 5. Interactions

- **Shadowing:** No — there is no alternative reporting path that this could shadow. The DegradationReporter call was the only emission site for `TelegramLifeline.versionMissing`. Removing it removes the signal from the feedback pipeline and only from there.
- **Cooldown coupling:** The previous code relied implicitly on `DegradationReporter`'s per-feature alert cooldown to avoid Telegram spam. Replacing the call with a one-shot `console.info` on the same condition removes that coupling: even without cooldown, the new path emits at most once per process. Per-process log noise is bounded; restart frequency dominates.
- **Build manifest:** `routes.ts` is a route-group source, so `scripts/generate-builtin-manifest.cjs` re-emits its inventory. No symbol added or removed (the new boolean is local), so the manifest delta is zero entries.

## 6. Test coverage

**What tests changed and why.**

No test file is added or modified.

- The pre-fix call site had no direct test referencing `TelegramLifeline.versionMissing` (`grep` confirms). The only test surface for `/internal/telegram-forward` exercises the version-handshake decision tree, not the feedback emission side-effect.
- A "no degradation feedback emitted" assertion on this branch would require reaching into `DegradationReporter` internals, which is brittle and out of step with the existing test harness.
- The signal-preserving `console.info` is a logging-only side-effect; in line with existing `console.log` patterns in `routes.ts`, it is intentionally untested.

If a future test ever wants to assert "backward-compat path is informational only," the natural seam is the `DegradationReporter` mock in `tests/integration/server-route-degradation.test.ts` (if/when written) — verifying the reporter is *not* called for this branch.

## 7. Reviewer notes

The cluster research notes cite this exact fix and acknowledge the broader systemic work as PROP-543. This change is the minimal, lowest-risk realisation of the cited fix and explicitly does not anticipate the systemic refactor.

A second-pass review is not required: no signal/authority change, no contract surface, no API change, single-file edit at a documented call site with no existing tests.
