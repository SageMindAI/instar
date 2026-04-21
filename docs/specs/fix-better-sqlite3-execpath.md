---
title: "fix-better-sqlite3.cjs: use process.execPath, not PATH's node"
slug: "fix-better-sqlite3-execpath"
author: "echo"
status: "converged"
review-convergence: "2026-04-21T21:30:00Z"
review-iterations: 2
review-completed-at: "2026-04-21T21:30:00Z"
review-report: "docs/specs/reports/fix-better-sqlite3-execpath-convergence.md"
approved: true
approved-by: "justin"
approved-date: "2026-04-21"
approval-note: "User approved via Telegram topic 5447 after operational fix on Inspec confirmed symptom: 'It's working the test message went through. Please proceed with the fixes.' Scope: the two robustness fixes identified during Inspec outage investigation (this PR addresses issue 1 — PR #89 source-build fallback broken on mixed-Node machines; issue 2 lifeline state-dir drift is a separate follow-up PR). Full-scope approval per 'No PR fragmentation across one approval' discipline: spec passed 2 internal convergence rounds (all 4 reviewers concurred) + cross-model round (Gemini APPROVE 9/10, Grok APPROVE 9/10, GPT CONDITIONAL 8/10 with 0 correctness bugs — all critical items were doc-clarity, resolved in final spec revision). LOW-RISK: recovery helper, no decision-point surface, no external-surface change, idempotent rollback. Field-validated: running the patched script on Inspec with process.execPath = Node 25 produced 'Prebuild installed and verified' in one step; require('better-sqlite3') under Node 25 returned OK ABI 141."
---

# fix-better-sqlite3.cjs — use `process.execPath`, not PATH's `node`

## Problem statement

`scripts/fix-better-sqlite3.cjs` is the self-heal script that `ensureSqliteBindings()` in `src/commands/server.ts` invokes when the server detects at startup that it cannot load better-sqlite3's native binding. The script downloads the correct prebuild from GitHub based on `process.versions.modules` (the ABI of the Node actually running the script), and falls back to a `npm rebuild --build-from-source` if the prebuild fails to verify.

The script has two spawn sites that incorrectly resolve `node` via `PATH` instead of via `process.execPath`:

1. `testBinary(pkgDir)` spawns `execSync("node -e ...")` — a shelled command where `node` resolves against the script's inherited `PATH`.
2. `trySourceBuild(pkgDir)` spawns `execSync("\"${process.execPath}\" \"${npmCli}\" rebuild ...")` with the parent Node set correctly, but the child's `PATH` is inherited unchanged, so any internal shell-out to bare `node` (node-gyp tool invocations, npm lifecycle scripts) resolves to the same PATH-first Node.

On mixed-Node machines this produces a **silent ABI mismatch**. Concrete repro from Inspec 2026-04-21:

- Server runs Node 25.6.1 (ABI 141), bundled in instar's shadow install.
- User's PATH has asdf Node 22 first (`~/.asdf/installs/nodejs/22.18.0/bin/node`, ABI 127).
- Script downloads the correct `node-v141-darwin-arm64` prebuild.
- `testBinary` spawns `node -e` → resolves to asdf Node 22 → ABI-141 binary fails to load under Node 22 → testBinary returns false.
- Script falls through to source-build. `npm rebuild` resolves child node-gyp through PATH → Node 22 → compiles an ABI-127 binary.
- `testBinary` (still Node 22) loads the ABI-127 binary successfully → returns true.
- Script records `source-ok`, exits 0, server restarts.
- Server (Node 25) loads better-sqlite3, gets `NODE_MODULE_VERSION 127 ≠ 141`, degrades TopicMemory, SemanticMemory, and FeatureRegistry.

No alarm surfaces because the self-heal reports success and the degradations are intentional fallback behavior. The only user-visible symptom is progressively worse agent capability (no conversation summaries, no semantic search, no persistent feature registry) until a human notices.

Inspec ran in this state for ~7 days across 3 supervisor restart cycles before a user reported "Telegram unresponsive," which traced to the lifeline failing to forward messages into a server whose message-ingest path depends on the degraded TopicMemory layer.

## Proposed design

Three surgical changes in `scripts/fix-better-sqlite3.cjs`, plus one new safety net. All changes run only when a binding mismatch has already been detected — zero steady-state startup cost when the binary is healthy.

### 1. `testBinary` uses `process.execPath`

Replace:

```js
execSync(
  `node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.pragma('journal_mode = WAL'); db.close();"`,
  { stdio: 'pipe', timeout: 10000, cwd: pkgDir }
);
```

With `execFileSync(process.execPath, ['-e', '<script>'], ...)` — no shell, no PATH resolution, guaranteed to test the binary against the Node that actually invoked the recovery helper.

### 2. `trySourceBuild` prepends `execDir` to child `PATH`

Compute `const execDir = path.dirname(process.execPath);` and set the child env's PATH to `${execDir}${path.delimiter}${process.env.PATH || ''}`. Also switch from shelled `execSync` to `execFileSync(process.execPath, [npmCli, 'rebuild', ...], ...)` for the same reason — argv-as-array avoids shell quoting surprises and makes the spawn shape unambiguous.

**`npmCli` resolution (already correct; documenting for clarity):** `findNpmCli()` tries `path.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')` FIRST, where `nodeDir = path.dirname(process.execPath)`. This anchors npm to the server's Node installation by default, then falls back to Homebrew/system paths. Combined with `execFileSync(process.execPath, [npmCli, ...])`, the parent Node is authoritative — whatever `findNpmCli` returns, node-gyp inherits `process.execPath` as its header target.

**Trust assumption (explicit):** `dirname(process.execPath)` must be writable only by the same principal as the server itself. Prepending to PATH means any executable in that directory can shadow system tools (`python3`, `make`, `cc`, `env`, …) during the node-gyp build. For instar's standard shadow-install layout (`.instar/shadow-install/node_modules/.../bin/node`), this is the same trust envelope the server already runs under — no new surface. This assumption fails ONLY if the shadow-install directory has been tampered with by a non-server principal, at which point the server was already compromised.

### 3. `verifyChildAbiMatches` — defence-in-depth ABI probe

Before entering the recovery flow, spawn `process.execPath -e "process.stdout.write(process.versions.modules)"` and confirm the child's reported ABI matches the in-process `process.versions.modules`. Divergence means the Node binary behind `process.execPath` was replaced mid-session (rare on macOS where Homebrew's Cellar paths are versioned and stable; plausible on Linux `/usr/bin/node` with an in-place package upgrade). When this happens we cannot safely build — the target is ambiguous — so we bail with a clear operator message rather than produce another silently-wrong binary.

Performance: one ~20ms Node spawn per recovery invocation. Zero cost on the hot path (binary already good → testBinary passes → early return).

### 4. Structural + behavioural regression tests

Add six tests to `tests/unit/fix-better-sqlite3-state.test.ts`:

- `testBinary`'s body contains `process.execPath` and does NOT contain a `node -e` shell invocation.
- `trySourceBuild`'s body contains `path.dirname(process.execPath)` AND a `PATH:` env entry.
- `trySourceBuild` uses `execFileSync(process.execPath, ...)` and does NOT call `execSync`.
- **Positive export canary:** `typeof fixModule.testBinary === 'function'`. Without this, a future refactor that renames `testBinary` silently passes the source-regex tests against an empty body.
- **Behavioural:** `verifyChildAbiMatches()` returns `true` when invoked under a process whose `process.execPath` IS the current Node (the expected case). Exercises the real spawn path.
- **Injection guard:** `testBinary`'s `-e` payload is a string literal (no template backticks, no string concatenation). A future refactor that interpolated user-controlled data into the payload would turn this spawn into arbitrary-code execution inside the server's Node; this test prevents that class of regression structurally.

These mix source inspection (catches code-shape drift) with behavioural exercise (catches "code was deleted" drift). The actual multi-Node end-to-end (ABI-127 prebuild under Node 25) cannot be reproduced in single-Node CI; the combination above is the best practical guard.

## Decision points touched

None. `fix-better-sqlite3.cjs` is a low-level install/recovery helper, not a decision point. It detects a hard-invariant condition (does the native binding load?) and attempts a fix; success/failure is structural, not judgmental. The loop-breaker logic (tuple-keyed `source-failed` state) is a safety guard on an irreversible action (re-downloading the same broken tarball forever), explicitly allowed under `docs/signal-vs-authority.md` § "Safety guards on irreversible actions."

The signal-vs-authority principle does not apply to this change. No block/allow surface is added, modified, or removed.

## Open questions — known gaps explicitly acknowledged

The following are known limitations NOT addressed by this PR. Each is named here so they aren't silently forgotten.

### Deferred: same PATH-inheritance bug in `UpdateChecker.ts:202`

`UpdateChecker` runs `npm rebuild better-sqlite3` after each update via a shelled command that inherits PATH. This PR does not fix that path. Justification: the primary self-heal trigger — the one that fires when the binding actually can't load — is `ensureSqliteBindings()` → this script. The UpdateChecker path is a prophylactic rebuild during fresh installs, typically running before the bad-prebuild scenario applies. Its result is non-authoritative: even if UpdateChecker produces a bad binary, this script (with the present fix) re-runs at next server start under the correct Node and heals. Ordering-hazard note: after this PR ships, `testBinary` will correctly detect UpdateChecker-produced bad binaries; this is an improvement, but could drive self-heal cycles if UpdateChecker keeps reproducing bad binaries. Follow-up PR should apply the same `execFileSync(process.execPath, [npmCli, ...])` shape to `UpdateChecker.ts`.

### Deferred: postinstall may leave wrong-ABI binaries

`package.json`'s `"postinstall": "node scripts/fix-better-sqlite3.cjs"` runs under whatever `node` npm was invoked with at install time, which may differ from the Node the server will run under. This PR's fix does NOT change postinstall behavior directly, but it makes the runtime recovery at `ensureSqliteBindings()` authoritative: whatever postinstall produces, the server-startup detector re-runs this script under server's `process.execPath` and corrects the binary. Documented behavior is "runtime recovery is authoritative; postinstall is best-effort."

### Deferred: source-failed lockout has no TTL

The loop-breaker permanently disables recovery for a given tuple once `source-failed` is recorded. Transient compiler-state failures (Xcode updating, EULA not yet accepted, `make` temporarily missing) are lumped together with deterministic failures (incompatible Node headers). Operator workaround is to delete `.instar-fix-state.json`. A TTL-based retry (e.g., 24h) would be safer but re-introduces some risk of the "launchd-respawn redownload loop" that the loop-breaker was built to prevent. Acknowledged limitation; not addressed here.

### Deferred: concurrent recovery race

If two instar processes share a single `better-sqlite3` package directory (uncommon but possible in a hoisted-monorepo layout), they can race on the tmpfile download, the build directory extract, and the state file write. The "per-package state" phrasing in earlier revisions overstated safety — per-package is not per-process. This PR does not change race behavior. A proper fix uses a file-lock on pkgDir (e.g., `proper-lockfile`); deferred to a follow-up.

### Deferred: prebuild signature/checksum verification

`tryPrebuild` downloads with `curl -L -f` and no signature check. Pre-existing. Compromise of the GitHub release asset yields native-code execution in the server's Node. Out of scope here; worth a separate PR.

### Deferred: predictable `tmpFile` path under `os.tmpdir()`

On multi-user machines, a local attacker can pre-create a symlink at the predictable tmpFile path, causing `tar xzf` to extract outside `pkgDir`. Pre-existing. Out of scope.

### Deferred: no end-to-end CI exercise of `fix-better-sqlite3.cjs`

Structural + behavioural tests here protect the spawn shape and a probe function. They do NOT protect against npm CLI resolution changes, curl availability regressions, or the tarball URL format shifting upstream. A runtime smoke test that exercises `tryPrebuild` + `testBinary` against the current CI Node would close this gap; deferred to a follow-up since this PR's structural tests catch the specific regression it introduces.

### Deferred: structured observability / self-heal telemetry

The bug was dangerous precisely because recovery silently reported success. This PR narrows the window (ABI alignment probe, correct spawn target, injection-guard tests) but does NOT add structured logging of parent/child execPath, version, ABI, recovery-path-taken, and final outcome. A future PR should add a single structured log line per recovery attempt so fleet-wide observability can detect regressions. Acknowledged gap; out of scope here because it requires a logging-subsystem decision (console vs ledger vs tunneled metrics) that's bigger than this bugfix.

### Deferred: network-assumption documentation

`tryPrebuild` assumes outbound HTTPS to `github.com` (release assets, redirected to blob storage). Air-gapped or proxied environments will fail the prebuild path and fall through to source-build, which assumes a working toolchain. Both assumptions were already present pre-PR. An explicit "requires outbound network OR a complete local toolchain" statement in user-facing docs would help operators diagnose; out of scope for this code PR.

## Platform scope

darwin (arm64, x64) and linux (x64, arm64). Windows is not supported by instar. The `curl` and `tar` invocations in `tryPrebuild` (pre-existing, not introduced here) assume POSIX toolchain. `path.delimiter` and `path.dirname(process.execPath)` are cross-platform. `execFileSync` is cross-platform.

## Rollback

Pure code change in a recovery helper. Rollback is `git revert` + patch release. No persistent state needs cleanup. Agents that ran the fixed script and have a correctly-compiled binary keep working regardless of which version ships next.

### Remediation for already-affected agents

**Agents affected by the specific bug this PR fixes** — wrong-ABI binary on disk, state file either missing or `lastResult: source-ok` (the false-positive the bug produces) — self-heal automatically with no operator action:

1. The patched instar version ships.
2. The agent's auto-updater applies the patch and restarts the server.
3. On the next startup, `ensureSqliteBindings()` detects the existing ABI mismatch (unchanged — it was already wrong).
4. The in-process detector invokes the patched `fix-better-sqlite3.cjs` via `execFileSync(process.execPath, [fixScript])`.
5. The patched script now correctly targets `process.execPath`, verifies child ABI alignment, downloads the correct prebuild, and verifies it under the same Node.
6. On next server restart, better-sqlite3 loads cleanly; degradations clear.

The recovery is idempotent: running the patched script on an already-healthy agent returns early after `testBinary` passes. A `lastResult: source-ok` state from the bug is not a lockout — the startup path checks `testBinary` FIRST and only consults state when testBinary fails, at which point the state gets updated with fresh attempt results anyway.

**Agents in `lastResult: source-failed` state** — loop-breaker engaged due to actual toolchain failure (Xcode not installed, EULA unaccepted, `make` missing) — remain in the documented escape-hatch path: operator deletes `.instar-fix-state.json` after fixing the underlying toolchain. This is NOT a regression from this PR; it's the pre-existing behavior and the documented contract. A TTL-based auto-retry is named as deferred above.

**Distinction matters:** the bug this PR fixes produced `source-ok` (false positive), not `source-failed`. Agents affected by THIS bug self-heal on patched-release. Agents hitting `source-failed` were already in the manual-fix path pre-PR.

### Caller invariants

Verified via grep of the instar source tree: `fix-better-sqlite3.cjs` has exactly two invocation paths: (a) `package.json` postinstall hook at install time, (b) `src/commands/server.ts:1503` via `ensureSqliteBindings()` at server startup. No CLI command, dashboard route, or job invokes the script directly. The (b) path is authoritative; this PR makes (a) best-effort (unchanged behavior from pre-PR, but now explicitly non-blocking).

## Evidence

- Field repro: Inspec at `/Users/justin/Documents/Projects/monroe-workspace/.instar/shadow-install/node_modules/instar/node_modules/better-sqlite3`, 3 degradations with `NODE_MODULE_VERSION 127` mismatch error, 2026-04-21.
- Hypothesis confirmation: running the pre-change script with server's Node 25 first on PATH produced "Prebuild installed and verified" in one step; running with asdf Node 22 first on PATH produced the false-positive "source build succeeded" outcome observed in the field.
- Post-change verification: running the updated script with `process.execPath = /Users/justin/Documents/Projects/monroe-workspace/.instar/bin/node` (Node 25) reliably produces `Prebuild installed and verified` regardless of what's first on PATH; binary loads under Node 25 with `OK ABI 141`.
- Tests: 14/14 passing (8 existing + 6 new: 3 structural regression, 2 behavioural + positive export canary, 1 injection guard).
- Type check: clean.
