---
title: "Eliminate URL.pathname path encoding across the codebase"
slug: "url-pathname-path-encoding-fix"
author: "gfrankgva"
status: "converged"
review-convergence: "2026-04-28T08:30:00Z"
review-iterations: 1
review-completed-at: "2026-04-28T08:30:00Z"
approved: true
approved-by: "gfrankgva"
approved-date: "2026-04-28"
approval-note: "Systematic bug fix — replaces URL.pathname with __dirname/fileURLToPath"
---

# Eliminate URL.pathname path encoding across the codebase

## Problem

`new URL(import.meta.url).pathname` preserves `%20`-encoded spaces. When the project directory contains spaces, `fs.readFileSync` and `path.resolve` fail because the OS expects real spaces, not `%20`.

## Solution

Replace with `__dirname` (defined via `fileURLToPath(import.meta.url)`) or inline `fileURLToPath()`. Both properly decode percent-encoded characters.

## Files Changed

10 source files, 5 test files, 1 generated manifest.
