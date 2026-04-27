# Side-Effects Review — Wire WorkingMemoryAssembler into session context API

**Version / slug:** `assembler-context-endpoint`
**Date:** 2026-04-27
**Author:** gfrankgva (contributor)
**Second-pass reviewer:** Echo (EchoOfDawn), 3 review rounds

## Summary of the change

Two files touched:

1. `src/commands/server.ts` — WorkingMemoryAssembler construction is moved from line 3258 (before activitySentinel) to after activitySentinel initialization (~line 3475). This enables wiring `episodicMemory` via `activitySentinel.getEpisodicMemory()`, which was previously left as a TODO comment. The assembler now receives both `semanticMemory` and `episodicMemory`, making the 400-token episode budget functional in production.

2. `src/server/routes.ts` — The two assembled-context endpoints (`/topic/context/:topicId?assembled=true` and `/session/context/:topicId`) are refactored to call a shared `assembleAndRespond()` helper instead of duplicating the assembly + response logic. The helper takes the assembler instance, topicId, options, and the Express response object. Auth confirmation is added to the JSDoc for the session context route.

## Decision-point inventory

- `WorkingMemoryAssembler` construction order — **modify** (move later in init sequence for dependency availability).
- `episodicMemory` wiring — **add** (was commented out, now passed via `activitySentinel?.getEpisodicMemory()`).
- `assembleAndRespond()` helper — **add** (extracts duplicated assembly logic).
- Route handlers — **modify** (delegate to shared helper instead of inline assembly).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None. The assembler degrades gracefully when episodicMemory is undefined (sentinel requires sharedIntelligence / LLM key). The helper produces identical output to the previous inline logic. Backwards compatibility is preserved: `?assembled=true` is opt-in, and the raw topic context path is unchanged.

## 2. Under-block

**What failure modes does this still miss?**

If `activitySentinel.getEpisodicMemory()` returns an EpisodicMemory instance that later becomes invalid (e.g., sentinel is stopped mid-session), the assembler would hold a stale reference. However, EpisodicMemory is file-based (JSON under `state/episodes/`), so the instance remains usable even if the sentinel stops producing new digests — it just won't have fresh data.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The assembler is a dependency-injected component — it receives its memory sources at construction time. Moving its initialization to the correct point in the dependency graph (after sentinel) is the natural fix. The shared helper is a local function within the route setup closure, keeping the DRY refactor scoped to the routes file.

## 4. Blocking authority

- [x] No — these are read-only API endpoints. They do not gate any operation.

## 5. Interactions

- **Init ordering**: Assembler now depends on `activitySentinel` being initialized first. If sentinel init fails (sharedIntelligence unavailable), `activitySentinel` is undefined and `getEpisodicMemory()` is not called — assembler gets `episodicMemory: undefined` and degrades gracefully.
- **Route behavior**: Identical to prior implementation — the helper is a pure extraction refactor.

## 6. External surfaces

- **Agents**: Session-start hooks calling `/session/context/:topicId` now receive episode context (recent activity digests, themed episodes) in the assembled output. This is strictly additive — agents get richer context.
- **Persistent state**: No modifications. Both endpoints are read-only.

## 7. Rollback cost

Pure code change. Revert restores the previous inline handlers and removes episodic wiring. No migration or data repair needed.

---

## Evidence pointers

- Typecheck: `tsc --noEmit` — 0 errors.
- Existing tests (14 integration + 3 E2E) cover both endpoints' happy paths, fallback behavior, and budget surfacing. The shared helper produces identical output, so existing test assertions remain valid.
