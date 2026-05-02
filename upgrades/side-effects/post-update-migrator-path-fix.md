# Side-Effects Review — PostUpdateMigrator path decoding fix

**Version / slug:** `post-update-migrator-path-fix`
**Date:** 2026-04-28
**Author:** gfrankgva (contributor)

## Summary of the change

One file, one line:

`src/core/PostUpdateMigrator.ts` — `getFreeTextGuardHook()` replaced `path.dirname(new URL(import.meta.url).pathname)` with `__dirname`. The former preserves `%20`-encoded spaces in the filesystem path, causing `fs.readFileSync` to fail when the project directory contains spaces. `__dirname` is already defined at module scope via `fileURLToPath(import.meta.url)`, which properly decodes percent-encoded characters.

## Decision-point inventory

- `getFreeTextGuardHook()` path construction — **fix** (replace URL.pathname with __dirname).

---

## 1. Over-block

None. Pure bug fix — strictly widens the set of environments where the function works.

## 2. Under-block

None. `__dirname` handles all valid filesystem paths.

## 3. Level-of-abstraction fit

Correct. Uses the same `__dirname` already defined at module scope by the file itself.

## 4. Blocking authority

- [x] No — this is a path construction fix, not a gate.

## 5. Interactions

None. The function is called during hook installation — no racing, no shadowing.

## 6. External surfaces

The function returns the content of `free-text-guard.sh`, which is written to `.claude/hooks/`. No behavioral change to the hook content itself.

## 7. Rollback cost

Revert restores the bug — `readFileSync` would again fail on paths with spaces.

---

## Evidence pointers

- Typecheck: `tsc --noEmit` — 0 errors.
- Tests: All 7 `PostUpdateMigrator-buildStopHook` tests pass (were 2/7 failing before this fix).
