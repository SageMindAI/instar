# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

The better-sqlite3 self-heal script (`scripts/fix-better-sqlite3.cjs`, invoked by `ensureSqliteBindings()` at server startup when a native-binding mismatch is detected) now anchors its Node resolution to `process.execPath` instead of `node` from `$PATH`. Prior behavior: on machines with a mixed Node environment — asdf / NVM / Homebrew / system-node combinations where `$PATH`'s first `node` differs from the one running the instar server — the script could silently produce and "verify" a binary compiled for the wrong ABI, reporting success while the server's next load fails with NODE_MODULE_VERSION mismatch. This produced three cascading SQLite-subsystem degradations (TopicMemory, SemanticMemory, FeatureRegistry) with no loud-signal alarm — the exact failure mode observed on the Inspec agent on 2026-04-21.

Three changes in `scripts/fix-better-sqlite3.cjs`:

1. `testBinary` now uses `execFileSync(process.execPath, ['-e', ...])` instead of a shelled `execSync("node -e ...")` — guarantees the test runs under the same Node that will load the binary.
2. `trySourceBuild` prepends `path.dirname(process.execPath)` to the child's PATH and invokes npm via `execFileSync(process.execPath, [npmCli, ...])` — ensures node-gyp compiles against the right Node's headers even when PATH is non-standard.
3. New `verifyChildAbiMatches()` defence-in-depth probe — before recovery, confirms the Node behind `process.execPath` reports the same MODULE_VERSION as the in-process one. Catches the narrow case of a symlink-behind-execPath being replaced mid-session.

Six new regression tests in `tests/unit/fix-better-sqlite3-state.test.ts` combine source inspection (protect the spawn shape), behavioural exercise (exercise verifyChildAbiMatches), and injection-guard (prevent future interpolation into `-e` payloads).

Already-affected agents self-heal on the next server restart after this patch lands — no operator action needed. The in-process detector re-fires on every startup, and the patched script now correctly targets the server's Node. Full technical detail in `docs/specs/fix-better-sqlite3-execpath.md` and side-effects artifact `upgrades/side-effects/fix-better-sqlite3-execpath.md`.

## What to Tell Your User

- **Silent SQLite degradation on mixed-Node machines, fixed**: "If you've ever noticed I couldn't remember conversations or search my own memory properly, that was likely this bug. It should heal itself automatically on my next restart."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Correct native-binding self-heal on mixed-Node machines | automatic (at server startup) |

## Evidence

Reproduction on Inspec 2026-04-21:
- Server: Node 25.6.1 (ABI 141), bundled in `.instar/shadow-install/.../bin/node`.
- `$PATH` first `node`: asdf Node 22.18.0 (ABI 127).
- Observed: three degradations (TopicMemory, SemanticMemory, FeatureRegistry) all citing `NODE_MODULE_VERSION 127 ≠ 141`. better-sqlite3 binary on disk was ABI 127.
- Root cause: earlier self-heal attempt(s) under the buggy script produced ABI-127 binaries while testing them with asdf Node 22 (false positive → `source-ok` state recorded).

Post-fix verification:
- Running the updated script with `process.execPath = /Users/justin/Documents/Projects/monroe-workspace/.instar/bin/node` (Node 25): output `[fix-better-sqlite3] Prebuild installed and verified.` in one step.
- `require('better-sqlite3')` under Node 25 returned successfully: `OK ABI 141`.
- Tests: 14/14 passing in `tests/unit/fix-better-sqlite3-state.test.ts` (8 existing + 6 new).
- Type check: `tsc --noEmit` clean.
