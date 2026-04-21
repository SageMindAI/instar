# Upgrade Guide — vNEXT

<!-- bump: patch -->

## Summary of New Capabilities

The better-sqlite3 native-bindings self-heal gains a source-build fallback and a loop-breaker. You'll notice the difference if an install on a fresh Node major version (where no prebuild exists yet) or a machine with a corrupted prebuild now recovers automatically instead of crash-looping. There's no new agent-facing surface — this is all under-the-hood install-time machinery.

## What to Tell Your User

Nothing unless they ask. If they've seen their agent crash-loop on startup with `better-sqlite3` errors in the logs, tell them:

> I patched the startup self-heal. If the native binding is missing or broken, I'll now rebuild it from source instead of redownloading the same broken prebuild over and over. And if both paths fail, I'll stop retrying and degrade to a slower backing store so your agent stays up — you'll see a log line, not a crash loop. You can clear the attempt state and force another try by deleting `<instar-install>/node_modules/better-sqlite3/.instar-fix-state.json`.

## What Changed

`scripts/fix-better-sqlite3.cjs` — the startup self-heal for better-sqlite3 native bindings — now has a source-build fallback and a loop-breaker, closing the "keep redownloading the same broken prebuild forever" failure mode observed on Dawn's machine on 2026-04-20.

**Previously**, the fix script had exactly one strategy: download the matching prebuild from the WiseLibs/better-sqlite3 GitHub release. If the prebuild didn't exist for the current `(better-sqlite3 version, Node MODULE_VERSION, platform, arch)` tuple, or if the downloaded tarball's binary still failed to load, the script exited 1. Under launchd KeepAlive, a crashing server would respawn, re-enter the fix script, redownload the same broken tarball, and fail again — wasting bandwidth and hiding the real problem.

**Now:**

1. **Prebuild attempt** (unchanged) — curl the prebuild, extract, test.
2. **Source-build fallback** — if the prebuild is missing OR fails to load after install, run `npm rebuild better-sqlite3 --build-from-source`. node-gyp compiles against the local Node's headers and works for any Node version that has headers + a toolchain on PATH.
3. **Attempt-state tracking** — each fix attempt writes to `<better-sqlite3>/.instar-fix-state.json`, keyed by the `(version, MODULE_VERSION, platform, arch)` tuple. A Node upgrade naturally invalidates stale state.
4. **Loop-breaker** — if state shows the current tuple has already exhausted both prebuild AND source-build, the script exits 1 immediately without any further network or build activity. Caller (`ensureSqliteBindings` in `src/commands/server.ts`) then degrades to JSONL-only mode instead of crash-looping.

The prebuild path is still attempted first (faster than a source build when it works). Source build is the safety net, not the default.

## Why This Matters

Native-module self-heal is the second self-healing system we're hardening this sprint (the first was Stage B lifeline self-restart). Same pattern: an automated recovery path needs both a primary attempt AND a deterministic terminal condition. Without the loop-breaker, launchd respawn cycles can drown the machine in repeated downloads of a binary we already know is broken. Without the source-build fallback, any Node version without a published prebuild (e.g., fresh major releases) is unrecoverable without manual intervention.

## Test Plan

- [x] `tests/unit/fix-better-sqlite3-state.test.ts` — 8 scenarios covering tuple-key derivation, state read/write roundtrip, attempt append, tuple-change state reset, best-effort write-failure tolerance.
- [x] CLI smoke-test: `node scripts/fix-better-sqlite3.cjs` on a machine with a valid binary reports "Native binary is working correctly" and exits 0.
- [ ] Manual verification on a machine with a deliberately-broken prebuild would exercise the full fallback chain (not scripted — requires toolchain).

## Side Effects

See `upgrades/side-effects/native-module-source-build-fallback.md`.
