# Side-Effects Review — Guard against non-array feedback.json and widen route try/catch

**Version / slug:** `feedback-endpoint-500-fix`
**Date:** 2026-05-02
**Author:** gfrankgva (contributor)

## Summary of the change

Two-layer fix for POST /feedback returning 500 Internal Server Error when feedback.json contains valid but non-array JSON data (e.g. `{}`, `null`, `42`).

**Files changed (source):**
- `src/core/FeedbackManager.ts` (1 occurrence) — `loadFeedback()` now validates `JSON.parse` result with `Array.isArray()` before returning; returns `[]` for non-array data.
- `src/server/routes.ts` (1 occurrence) — POST `/feedback` route handler's `try/catch` now wraps the entire handler body (quality validation + anomaly detection + submit), not just the `submit()` call.

**Files changed (tests):**
- `tests/unit/feedback-loadFeedback-guard.test.ts` (new) — 8 unit tests covering non-array JSON, null, numbers, strings, valid arrays, missing files, invalid JSON, and quality validation with corrupted data.

## Decision-point inventory

- `loadFeedback()` return value when data is non-array — **return `[]`** (consistent with existing behavior for missing file and parse errors).
- Route handler try/catch scope — **widen to cover full handler body** (consistent with other route handlers like POST `/feedback/retry`).

---

## 1–7. Analysis

This is a pure bug fix with no behavioral, architectural, or security implications for valid data paths. The only change in behavior occurs when `feedback.json` contains non-array JSON — previously this caused a TypeError (`.slice()` on non-array), now it gracefully returns an empty array. The widened try/catch in routes.ts ensures any unexpected errors during quality validation or anomaly detection produce a proper 500 JSON response instead of crashing the request. Fully reversible by reverting the commit.
