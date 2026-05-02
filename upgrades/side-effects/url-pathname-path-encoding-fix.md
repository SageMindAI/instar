# Side-Effects Review — Eliminate URL.pathname path encoding across the codebase

**Version / slug:** `url-pathname-path-encoding-fix`
**Date:** 2026-04-28
**Author:** gfrankgva (contributor)

## Summary of the change

Systematic replacement of `new URL(import.meta.url).pathname` with `__dirname` (or `fileURLToPath()`) across 13 source files. The former preserves `%20`-encoded spaces in filesystem paths, causing `fs.readFileSync`, `path.resolve`, and similar operations to fail when the project directory contains spaces.

**Files changed (source):**
- `src/commands/init.ts` (4 occurrences)
- `src/commands/playbook.ts` (1)
- `src/commands/server.ts` (4)
- `src/commands/setup.ts` (3)
- `src/core/Config.ts` (1)
- `src/core/PostUpdateMigrator.ts` (2)
- `src/core/SessionManager.ts` (1)
- `src/core/UpdateChecker.ts` (1)
- `src/core/UpgradeGuideProcessor.ts` (1)
- `src/threadline/ThreadlineBootstrap.ts` (1)
- `src/lifeline/ServerSupervisor.ts` (1)

**Files changed (tests):** 5 test files with unquoted `execSync` paths or test expectation updates.

**Files changed (generated):** `src/data/builtin-manifest.json` — content hashes updated to reflect changed source files.

**Files changed (infrastructure):** `scripts/pre-push-gate.js` — added regression guard (check 5) that prevents re-introduction of the `URL.pathname` antipattern.

## Decision-point inventory

- All `new URL(import.meta.url).pathname` usages — **fix** (replace with `__dirname` or `fileURLToPath`).
- No behavioral changes — every replacement produces the same decoded path, just without the `%20` encoding bug.

---

## 1–7. Analysis

This is a pure bug fix with no behavioral, architectural, or security implications. Every replacement produces the identical filesystem path on systems without spaces, and the correct path on systems with spaces. No new code paths, no new dependencies, no new failure modes. Fully reversible by reverting the commit.

## Evidence pointers

- Typecheck: `tsc --noEmit` — 0 errors.
- Full test suite: 740 files passed, 0 failed, 17171 individual tests passed.
- Zero instances of `new URL(import.meta.url).pathname` remain in `src/`.
