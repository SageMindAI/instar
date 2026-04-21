# Side-Effects Review — better-sqlite3 self-heal uses `process.execPath` instead of `node` from PATH

**Version / slug:** `fix-better-sqlite3-execpath`
**Date:** `2026-04-21`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

`scripts/fix-better-sqlite3.cjs` is the self-heal script the server invokes from `ensureSqliteBindings()` when it detects a native-binding mismatch at startup. The existing implementation spawned verification (`testBinary`) and rebuild (`trySourceBuild`) using a bare `node` lookup from `PATH`. On machines where `PATH`'s `node` differs from the Node running the script (the common case for instar agents on asdf-managed systems: asdf Node 22 first on `PATH`, server's bundled Node 25 as `process.execPath`), this produced a silent ABI mismatch:

1. The prebuild URL is constructed from `process.versions.modules` (ABI 141 on Node 25) — correct.
2. The extracted binary is verified by spawning `node -e ...` against `PATH`'s Node (ABI 127 on Node 22) — wrong.
3. The ABI-141 binary fails to load under Node 22, so `testBinary` returns false and the script falls through to source-build.
4. Source-build runs `npm rebuild better-sqlite3 --build-from-source` via `execSync` with a shelled command that inherits `PATH`. npm lifecycle scripts that shell out to `node` pick up Node 22; node-gyp compiles against Node 22 headers; the output is an ABI-127 binary.
5. `testBinary` (still Node 22) successfully loads the ABI-127 binary → returns true. Script records `source-ok` and exits 0.
6. Server restarts, loads better-sqlite3 under its actual Node 25 → gets `NODE_MODULE_VERSION 127 ≠ 141` → degrades TopicMemory, SemanticMemory, and FeatureRegistry to fallback mode.

This is the exact silent-degradation condition found on the Inspec agent on 2026-04-21: three degradations, healthy-looking self-heal logs, and an ABI-mismatched binary on disk after multiple supervisor restart cycles. Messages arrived at the lifeline but couldn't be forwarded; the user saw unresponsive Telegram with no alarm.

**Change:** `testBinary` now spawns `process.execPath` via `execFileSync` with argv array (no shell). `trySourceBuild` also spawns `process.execPath` via `execFileSync` and prepends `path.dirname(process.execPath)` to `PATH` in the child's environment so any internal shell-outs to bare `node` (node-gyp internals, npm lifecycle scripts) resolve to the correct Node.

**Files touched:**
- `scripts/fix-better-sqlite3.cjs` (behavior + shelling hygiene)
- `tests/unit/fix-better-sqlite3-state.test.ts` (+3 structural regression tests)

## Decision-point inventory

This change touches no decision points. The script is a build/install recovery helper; it does not gate information flow, block actions, or filter messages. It detects binding mismatches and attempts to fix them, with a loop-breaker for exhausted tuples (which *is* a brittle blocker but is covered under "safety guards on irreversible actions" in `docs/signal-vs-authority.md` — re-downloading the same broken tarball on every launchd respawn is the irreversible damage being guarded against, and the loop-breaker has no ambiguity: tuple matched = skip).

- `fix-better-sqlite3.cjs testBinary Node resolution` — modify — now uses `process.execPath` rather than PATH's `node`; closes a false-positive path where an ABI-wrong binary appears to verify successfully.
- `fix-better-sqlite3.cjs trySourceBuild Node resolution` — modify — same reasoning, applied to the source-build spawn path.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable. The script is a recovery helper; its outputs are "fixed," "can't fix," or "already fine." None of those gate any user-visible flow.

---

## 2. Under-block

**What failure modes does this still miss?**

No block/allow surface — under-block not applicable in the decision-gate sense. But in the "failure modes the script still can't recover from" sense, worth naming:

- `process.execPath` points to a deleted/broken binary. If the parent that spawned the script has an `execPath` pointing to a now-deleted Node install (hypothetical: user removed the Homebrew Cellar version the server was launched against), `testBinary` will `ENOENT` and return false; the script will fall through to source-build which will fail the same way; the loop-breaker will kick in and degrade gracefully. Not a regression.
- `process.execPath` points to a Node with no npm bundled. The `findNpmCli()` candidate list has fallbacks (homebrew, /usr/local, /usr); if none match, source-build returns false, loop-breaker engages, degraded mode. Not a regression.
- The Node running the script is somehow different from the Node that will *consume* the library later. Example: script invoked manually by a user under an unusual shell. The script now builds for the Node running it, which is the documented contract; the pre-change contract was "whatever Node is first on PATH" which was wrong by design.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The script is a low-level recovery helper invoked by `ensureSqliteBindings()` (a higher-level policy in `src/commands/server.ts`). The policy says "make the native binding work for this process"; the helper implements "fix it or tell me you can't." Using `process.execPath` rather than PATH is the correct shape for a helper — it matches the contract the caller relies on (the caller invoked it *with this specific Node*; that's the Node the binding must work for).

No higher-level gate should own this. No lower-level primitive is being reimplemented.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface.

The script is not a decision point under the principle. It detects a mismatch and attempts a fix; success/failure is a hard-invariant check (the binary either loads under the correct Node or it doesn't). Per `docs/signal-vs-authority.md` § "When this principle does NOT apply," structural validators at system boundaries are not judgment decisions and are allowed to be brittle.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** No. `ensureSqliteBindings()` is the sole upstream caller. The script runs synchronously; its result determines whether the server restarts to clear the ESM module cache.
- **Double-fire:** No. `ensureSqliteBindings()` is called once during server startup, guarded by `fs.existsSync(fixScript)`.
- **Races:** None with other instar processes. The script holds no locks; its state file (`.instar-fix-state.json`) is written under the package directory, which is process-private. If two different instar agents share a single node_modules (uncommon; shadow-install isolation exists precisely to avoid this), the existing tuple-keyed state design already handles that — each tuple includes `platform` and `arch`, so no collision possible on shared hardware.
- **Feedback loops:** None. The loop-breaker prevents the prior-observed "launchd respawn → broken prebuild redownload" pattern; that remains intact.

One interaction worth naming: the `UpdateChecker.ts` path that also claims to "rebuild better-sqlite3 native bindings in shadow install" after each update (src/core/UpdateChecker.ts:202). That path uses `npm rebuild better-sqlite3` (not this script) and has the same PATH-inheritance vulnerability. It is out of scope for this PR because the primary self-heal path — the one triggered when the server actually can't load the binding — is what this fix addresses. The UpdateChecker path is a prophylactic rebuild that typically succeeds (it runs during a fresh install, often before the bad-prebuild scenario applies) and a fix to it belongs in a separate PR with its own review.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- Other agents on the same machine: no (script is per-package-dir).
- Other users of the install base: yes, positively — after this ships, the Inspec-style silent-degradation pattern can no longer silently pass. Other agents running on asdf / NVM / mixed-Node environments were vulnerable to the same bug; this closes it.
- External systems: no change. Same prebuild URL format, same `npm rebuild` invocation from the same cwd.
- Persistent state: no new state, no schema change. `.instar-fix-state.json` format unchanged.
- Timing: end-to-end timing unchanged. `execFileSync` vs `execSync` is the same mechanism at the syscall level; argv-as-array avoids a shell fork but on the critical path this is microseconds.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure code change in a recovery helper. Rollback is `git revert` + patch release. No persistent state needs cleanup. No user-visible regression during rollback: agents that run the reverted version get back to the pre-fix behavior (which was the status quo for weeks; merely imperfect, not broken). Agents that already ran the fixed script and have a correctly-compiled binary keep working regardless of which version of the script ships next.

Estimated rollback: 5 minutes to revert + re-release, no migration, no operator action needed on any agent.

---

## Conclusion

Single-file behavior fix with structural regression tests. Root cause was a shell-spawn shape (`node -e` relying on PATH) that silently produced wrong-ABI binaries on mixed-Node machines. New behavior invokes `process.execPath` explicitly, matching the caller's contract. No decision-point surface, no interaction concerns, straightforward rollback. Clear to ship.

---

## Revisions from spec-converge round 1

In response to four parallel internal reviewers (security, scalability, adversarial, integration):

- **Added `verifyChildAbiMatches()` defence-in-depth probe** (adversarial-HIGH): before attempting recovery, confirm the Node behind `process.execPath` reports the same MODULE_VERSION as the in-process Node. Catches the narrow case where a symlink-behind-execPath was replaced mid-session.
- **Added explicit trust assumption** on `dirname(process.execPath)` for the PATH prepend (security-low).
- **Strengthened tests** from 3 structural to 6 (structural + behavioural): positive export canary for `testBinary`, behavioural exercise of `verifyChildAbiMatches`, injection guard asserting the `-e` payload is a string literal (security-low).
- **Expanded Open Questions** to explicitly name six deferred items with justification: UpdateChecker path has same bug (follow-up), postinstall authority (runtime is authoritative), source-failed TTL (acknowledged tradeoff), concurrent-recovery race (pre-existing, out of scope), prebuild signature verification (pre-existing), tmpfile path predictability (pre-existing), no end-to-end CI (acknowledged).
- **Added Platform scope** (darwin + linux) and **Caller invariants** (verified: only postinstall + ensureSqliteBindings invoke this script).
- **Added "Remediation for already-affected agents"** to Rollback: patched release heals on next startup via the in-process detector; no one-shot operator action needed.

## Evidence pointers

- Reproduction: on Inspec (2026-04-21), server ran Node 25 (ABI 141), PATH's `node` was asdf Node 22 (ABI 127). Degradations showed NODE_MODULE_VERSION 127 mismatch. After the fix: running the updated script with `process.execPath = Node 25` produced `Prebuild installed and verified.` in one step, and `require('better-sqlite3')` under Node 25 returned `OK ABI 141`.
- Unit tests: `tests/unit/fix-better-sqlite3-state.test.ts` — 14 passed (8 existing + 6 new regression).
- Type check: `tsc --noEmit` clean.
- Caller audit: `grep -rn fix-better-sqlite3 src/ scripts/ package.json` confirms only two call sites (postinstall, ensureSqliteBindings) — no CLI or dashboard path.
