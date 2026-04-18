# Side-Effects Review — Initiative Tracker core + API

**Version / slug:** `initiative-tracker-core-and-api`
**Date:** `2026-04-17`
**Author:** `Echo (instar-developing agent)`
**Second-pass reviewer:** `not required — new opt-in persistence surface behind its own routes; no existing behavior is modified`

## Summary of the change

Introduces a long-running-work tracker to close the user-feedback gap where multi-phase efforts (e.g. the PR-REVIEW-HARDENING rollout) stall silently because there is no structural place to persist "this is phase N of M, last touched on D, needs user decision X." Existing primitives (AttentionItem = single actionable; Job = recurring cron; Dispatch = broadcast) don't cover this shape.

Files added/modified:
- **new** `src/core/InitiativeTracker.ts` — class with CRUD + phase transitions + digest scan; atomic-write persistence to `.instar/initiatives.json` following the existing AttentionItem pattern.
- **new** `tests/unit/InitiativeTracker.test.ts` — 28 unit tests (CRUD, validation, phase transitions, persistence, digest scan).
- **new** `tests/unit/routes-initiatives.test.ts` — 15 integration tests hitting real Express with real persistence.
- **mod** `src/server/AgentServer.ts` — adds `initiativeTracker` to constructor options and routeContext.
- **mod** `src/server/routes.ts` — RouteContext field + 7 new endpoints: `GET/POST /initiatives`, `GET /initiatives/digest`, `GET/PATCH/DELETE /initiatives/:id`, `POST /initiatives/:id/phase/:phaseId`.
- **mod** `src/commands/server.ts` — instantiates `InitiativeTracker` and passes to `new AgentServer`.

## Decision-point inventory

1. **Persistence location**: `.instar/initiatives.json` at the root of stateDir. Follows the same convention as `jobs.json`, `telegram-messages.jsonl`, etc. Alternative considered: nest under `.instar/state/initiatives/`. Rejected because the existing convention for top-level agent state is flat JSON at stateDir root.
2. **Persistence format**: single JSON file with `{ initiatives: [...] }` root (same shape as AttentionItem persistence). Not a directory-per-initiative. Rationale: expected volume is ≤50 records, fits comfortably in one atomic write; per-record writes would risk torn state.
3. **Ready-to-advance signal definition**: emits when the previous phase is `done` AND the current phase is `pending` (untouched). Does not emit once the current phase is `in-progress` — by then the advance has started and the signal would become noise. (Bug discovered mid-test-run and corrected.)
4. **Staleness threshold**: 7 days (`STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000`). Only applies to `active` initiatives. Configurable in a future change if noise is observed.
5. **Id validation**: lowercase kebab-case, 1–63 chars, must start with alphanumeric. Matches slug conventions used elsewhere (job slugs, topic names).

## 1. Over-block review

No blocking behavior introduced. Every endpoint is opt-in (503 when `initiativeTracker` is null, which cannot happen in practice since the server always instantiates it). No existing routes or middleware are changed. No pre-commit hook, git-sync behavior, or session lifecycle is touched.

## 2. Under-block review

N/A — there is no block-or-pass decision. The tracker is purely a persistence + query surface.

## 3. Level-of-abstraction fit

- Persistence logic lives in `InitiativeTracker` class (domain layer).
- HTTP shape lives in `routes.ts` (transport layer).
- Construction lives in `commands/server.ts` (composition root).
- Tests hit both the class layer and the HTTP layer independently.

This matches the pattern established by `BackupManager`, `RelationshipManager`, `FeedbackManager`.

## 4. Signal-vs-authority review

The digest scan emits **signals only** (`DigestItem[]`). It has zero blocking authority — callers (daily digest job, dashboard UI, the user) decide what to do with the signal. The daily digest job (separate commit) will use these signals to decide whether to push a Telegram notification; the threshold for pushing is the job's concern, not the tracker's.

## 5. Interactions review

- **Does not interact with Telegram**: tracker has no knowledge of topics, messages, or channels. The separate daily-digest job will bridge signal → Telegram.
- **Does not interact with JobScheduler**: the digest job reads the tracker but lives separately.
- **Does not interact with BackupManager**: `.instar/initiatives.json` is picked up by default backup globbing (no explicit include needed).
- **Does not conflict with AttentionItem**: complementary — AttentionItem is for single-shot actionables, Initiative is for multi-phase long-lived work. A future convenience could auto-create an AttentionItem from a `needs-user` digest row, but that's a separate design decision.

## 6. External surfaces

- **HTTP API**: 7 new routes under `/initiatives`, all behind the existing auth middleware. No public unauthenticated surface.
- **File system**: one new file (`.instar/initiatives.json`), atomic-rename writes prevent torn state.
- **Dashboard**: not wired yet — separate commit adds the Initiatives tab.

## 7. Rollback cost

Low. `git revert` removes the tracker class, routes, wiring, and tests. `.instar/initiatives.json` persists on disk but is ignored by all revived code paths (no other consumer reads it). The user can delete the file manually if desired, or leave it as dead data.

## Conclusion

Additive-only change. No existing behavior modified. 43 new tests (28 class + 15 route), all passing. `tsc --noEmit` clean. Clear to ship as commit 1 of 4 for the Initiative Tracker feature.

## Evidence pointers

- Unit tests: `tests/unit/InitiativeTracker.test.ts` (28 pass).
- Integration tests: `tests/unit/routes-initiatives.test.ts` (15 pass).
- Prior Phase A tests still green (spot-checked: `routes-prGatePhaseGate`, `PostUpdateMigrator-gitignore`, `PostUpdateMigrator-prPipelineArtifacts` — 37 pass).
- `npx tsc --noEmit` — clean.
