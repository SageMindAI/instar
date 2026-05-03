---
title: "Guard against non-array feedback.json and widen route try/catch"
slug: "feedback-endpoint-500-fix"
author: "gfrankgva"
status: "converged"
review-convergence: "2026-05-02T12:30:00Z"
review-iterations: 1
review-completed-at: "2026-05-02T12:30:00Z"
approved: false
---

# Guard against non-array feedback.json and widen route try/catch

## Problem

POST /feedback returns 500 Internal Server Error when `feedback.json` contains valid but non-array JSON (`{}`, `null`, `42`). Two root causes:

1. `FeedbackManager.loadFeedback()` calls `JSON.parse()` and returns the result without validating it is an array. Subsequent calls to `.slice()`, `.some()`, `.filter()` on non-array data throw `TypeError`.

2. The POST `/feedback` route handler's `try/catch` only wraps the `submit()` call, not the quality validation that runs earlier. The `TypeError` from `loadFeedback()` (called via `validateFeedbackQuality()`) escapes the `try/catch`.

## Solution

1. Add `Array.isArray()` guard in `loadFeedback()` — return `[]` when parsed data is not an array.
2. Widen `try/catch` in POST `/feedback` to wrap the entire handler body (quality validation + anomaly detection + submit).

## Files Changed

2 source files, 1 new test file (8 tests).
