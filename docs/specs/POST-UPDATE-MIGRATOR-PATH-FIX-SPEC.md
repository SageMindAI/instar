---
title: "Fix PostUpdateMigrator path decoding for directories with spaces"
slug: "post-update-migrator-path-fix"
author: "gfrankgva"
status: "converged"
review-convergence: "2026-04-28T08:00:00Z"
review-iterations: 1
review-completed-at: "2026-04-28T08:00:00Z"
approved: true
approved-by: "gfrankgva"
approved-date: "2026-04-28"
approval-note: "Trivial one-line bug fix — uses existing __dirname instead of broken URL.pathname"
---

# Fix PostUpdateMigrator path decoding for directories with spaces

## Problem

`getFreeTextGuardHook()` constructs a path using `new URL(import.meta.url).pathname`, which preserves `%20`-encoded spaces. When the project directory contains spaces, `fs.readFileSync` fails because the OS path has literal `%20` instead of spaces.

## Solution

Replace with `__dirname`, which is already defined at module scope via `fileURLToPath(import.meta.url)` and handles percent-decoding correctly.

## Files Changed

- `src/core/PostUpdateMigrator.ts` — One line in `getFreeTextGuardHook()`
