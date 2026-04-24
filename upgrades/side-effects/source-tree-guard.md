# Side-Effects Review — Destructive tool target guard

**Version / slug:** `source-tree-guard`
**Date:** `2026-04-24`
**Author:** `echo`
**Second-pass reviewer:** `not required (brittle safety-guard carve-out; see §4)`

## Summary of the change

Adds a new primitive `src/core/SourceTreeGuard.ts` that refuses to let
destructive managers (`GitSyncManager`, `BranchManager`,
`HandoffManager`) be constructed against the instar source tree. The
guard is wired as the first statement of each manager's constructor and
throws `SourceTreeGuardError` (code `INSTAR_SOURCE_TREE_GUARD`) before
any collaborator touches anything. Detection is the OR of three layers
(marker file `.instar-source-tree`, canonical `origin` URL in the
resolved common git dir's config, or `package.json name === "instar"`
plus two-of-N signature files). Path resolution closes the
uncreated-subdirectory bypass via a nearest-existing-ancestor walk, and
handles worktrees via `.git`-file parsing with
`basename(dirname(gitdir)) === "worktrees"` common-git-dir resolution.
Fail-closed is two-tier: detector-level inability to canonicalize/ascend
returns TRUE; layer-level inability to evaluate returns FALSE for that
sub-check and the OR across layers decides.

Files touched:

- `src/core/SourceTreeGuard.ts` (new)
- `src/core/GitSync.ts` (+1 import, +1 assert at constructor top)
- `src/core/BranchManager.ts` (+1 import, +1 assert at constructor top)
- `src/core/HandoffManager.ts` (+1 import, +1 assert at constructor top)
- `.instar-source-tree` (new — marker file at repo root)
- `tests/unit/SourceTreeGuard.test.ts` (new — 34 tests)
- `tests/integration/source-tree-guard-wiring.test.ts` (new — 10 tests)
- `docs/specs/DESTRUCTIVE-TOOL-TARGET-GUARDS-SPEC.md` (spec, pre-existing)
- `docs/specs/reports/destructive-tool-target-guards-convergence.md` (report, pre-existing)

Incident context: the 2026-04-22 branch-lifecycle e2e fixture wiped 1,893
files from the real instar checkout because destructive components
trusted an incoming `projectDir` without verification. This PR delivers
the tactical guardrail described in the spec. E2E sandbox hardening,
Adriana's autostash fix, the CI mutation detector, and the
SafeGitExecutor centralization are explicitly deferred to separate PRs.

## Decision-point inventory

- `src/core/SourceTreeGuard.ts :: isInstarSourceTree` — **add** — new
  detector returning boolean based on the 3-layer OR.
- `src/core/SourceTreeGuard.ts :: assertNotInstarSourceTree` — **add** —
  new assertion wrapper that throws `SourceTreeGuardError`.
- `GitSyncManager` constructor — **modify** — first statement now calls
  the assertion; no other behavior change.
- `BranchManager` constructor — **modify** — same.
- `HandoffManager` constructor — **modify** — same.

No existing decision points are removed or repurposed.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Concrete over-block scenarios considered:

- A parallel-dev worktree *of the instar source* used as a destructive
  target. Blocked today. This is intended — the worktree's common git
  dir is the real repo, so `git add -A` from the worktree mutates the
  real repo. If someone legitimately needs this, the fix is to loosen
  the guard deliberately, not to silently permit it.
- A fork that keeps `package.json.name === "instar"`, ships two of the
  signature files (likely — they're core infra), and carries the
  `.instar-source-tree` marker (only if the forker copied it; it's in
  the upstream repo but not automatically propagated by `git clone`).
  Fork remotes are NOT on the canonical list, so layer (b) does not
  match. If a fork has the marker and keeps the name+signature, it
  blocks — the fork author can delete the marker in their repo.
- A developer who manually sets their working dir to the instar source
  to run a one-off script. Blocked only for destructive-manager
  construction — read-only tools are untouched. This is the entire
  purpose of the guard.
- Tests that deliberately construct a manager pointed at the instar
  source to exercise error paths. Use a `mkdtemp` sandbox instead (the
  integration tests in this PR follow that convention).

No legitimate input is rejected that shouldn't be. The one "blocked by
design" case (worktrees of the source) matches the incident shape and
is a deliberate guard.

---

## 2. Under-block

**What failure modes does this still miss?**

- Destructive components not on the three-manager list. Addressed by
  the pre-ship enumeration below: every direct git invocation under
  `src/` was inventoried. See §"Pre-ship grep enumeration evidence."
- Destructive work launched via child processes or shell scripts
  (e.g. `nuke.ts`, `init.ts`) that bypass the manager layer. These are
  either operator-initiated (`nuke`) or target a fresh dir (`init`),
  not the incident shape. The SafeGitExecutor follow-up PR centralizes
  these.
- Fork of instar that renames `package.json`, changes canonical remote,
  and drops the marker. By design — if all three layers disagree this
  is not the instar source tree, guard passes.
- A manager constructed against a fresh clone that doesn't have the
  marker yet AND has a non-canonical remote (e.g. contributor fork)
  AND has been renamed. Same as above — by design not caught.

Under-block is scoped to "things out of this PR's lane" and enumerated
in the spec's Out-of-Scope Follow-Ups. Nothing silently degrades.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Constructor-time on the three destructive managers is the correct
layer for this PR. It is the point at which `projectDir` first becomes
trusted state — below this (inside `execFileSync('git', ...)`) is too
late (damage already in flight); above this (scattered across callers)
is the layer the incident proved unreliable.

A lower-level primitive (`SafeGitExecutor`) will additionally funnel at
the `execFileSync` boundary in a follow-up PR. The constructor wire-in
remains as belt-and-suspenders even after that refactor.

A higher-level gate does NOT already exist for this — the incident is
specifically the absence of such a gate. This change creates it.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [x] ✅ Yes, with brittle logic — **and that is correct** under the
  carve-out in `docs/signal-vs-authority.md` lines 74–77:

  > **Safety guards on irreversible actions.** `rm -rf /`,
  > force-pushing to main, deleting the database — these can and
  > should be hard-blocked by brittle pattern matchers, because the
  > cost of a false pass is catastrophic and the cost of a false
  > block is merely "try again with the right arguments."

This guard is exactly that category. False-pass cost: 1,893-file wipe +
force-push recovery (established empirically on 2026-04-22). False-block
cost: developer edits a path or touches a marker file once. The
asymmetry is overwhelming and the principle explicitly excludes this
class of check from the "brittle = signal only" rule.

No judgment gate is being added. No LLM-backed contextual check is
being bypassed. The check does not reason about message content, agent
intent, or conversational state — it asks "is this path the source
tree?" and acts on the yes/no. Fully compliant with the
signal-vs-authority separation.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** The guard runs as the FIRST statement of each
  constructor, before any other validation. It cannot shadow existing
  checks — it precedes them. If the guard throws, later validation does
  not run, which is correct (the path is untrusted; any later check
  against it is moot).
- **Double-fire:** No other component performs an equivalent check
  today (grep confirms). Once `SafeGitExecutor` lands, both will fire;
  that's intentional redundancy, not a bug.
- **Races:** Pure synchronous fs reads. No shared state. No
  concurrency hazard. The detector is idempotent and side-effect-free.
- **Feedback loops:** None. The guard does not feed any downstream
  decision system.
- **Test harness interaction:** All existing `mkdtemp`-based tests
  still pass. The smoke tier (2037 tests) passes locally post-wiring.
  Integration test confirms that a sandbox subdirectory still
  constructs successfully.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** none. Per-process guard only.
- **Other users of the install base:** behaviour changes only for
  callers constructing the three managers against the instar source
  itself — which no legitimate user does (it would mutate the instar
  source). Forks are intentionally not caught by layer (b); layer (c)
  catches unrenamed forks, which is arguably a feature (forkers who
  kept the instar name probably also don't want their own repo wiped).
- **External systems:** no network, no LLM, no IPC. Sub-millisecond
  synchronous fs check.
- **Persistent state:** the `.instar-source-tree` marker file at repo
  root is new persistent state. It's a one-line inert sentinel; its
  only consumer is this guard. Safe to leave in place on rollback.
- **Timing / runtime conditions:** the guard runs at constructor time,
  before any async work. Worst case ~5ms cold (three fs reads); warm
  cache sub-millisecond. Cannot cause gate-vs-client-timeout issues.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Hot-fix release:** revert the commit — delete
  `src/core/SourceTreeGuard.ts`, remove the three one-line wire-ins,
  ship as next patch. No code outside this module depends on the new
  symbols. The `.instar-source-tree` marker can be left in place (inert
  without the guard reading it) — avoids a second commit.
- **Data migration:** none. No persistent state introduced beyond the
  inert marker file.
- **Agent state repair:** none. Per-process guard, no shared state.
- **User visibility:** none — rollback restores prior behaviour
  instantly on restart. A legitimate caller that was ever blocked by
  this guard was almost certainly pointed at the wrong tree anyway; the
  rollback window does not expose users to regression.

Estimated hot-fix time: minutes.

---

## Conclusion

This review produced the following design decisions locked into the
final code:

- Two-tier fail-closed (detector-level = TRUE; layer-level = FALSE for
  that sub-check) to avoid the over-block pathology flagged in the
  convergence review.
- Worktree common-git-dir resolution via the
  `basename(dirname(gitdir)) === "worktrees"` rule, falling through to
  layer (b) inconclusive on non-standard layouts rather than guessing.
- Canonical-remote list kept intentionally narrow (three exact URLs
  with three narrow normalization rules: strip whitespace, strip
  trailing slash, strip trailing `.git`). No substring or regex
  matching.
- Error message deliberately does NOT inline bypass instructions (a
  tutorial-in-the-error-message is a convenient "how to defeat the
  guard" crib sheet that outlives the reason it exists).
- Pre-ship enumeration converts the three-manager defense from "hope
  we found them all" to "documented inventory at ship time." Findings
  below.

The change is clear to ship. It is a necessary-but-not-sufficient step
toward the SafeGitExecutor centralization, which is scheduled as a
follow-up PR.

---

## Pre-ship grep enumeration evidence

```
$ grep -rnE "execFileSync\('git'|execSync\('git |spawn\(?'git'|spawnSync\('git'" src/
src/core/SyncOrchestrator.ts:1163    return execFileSync('git', args, {                             non-destructive (delegates to GitSync / BranchManager / HandoffManager which are now guarded)
src/core/ProjectMapper.ts:261        execFileSync('git', ['remote', 'get-url', 'origin'], …)       non-destructive (read-only)
src/core/ProjectMapper.ts:275        execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], …) non-destructive (read-only)
src/core/ScopeVerifier.ts:449        execFileSync('git', ['remote', 'get-url', 'origin'], …)       non-destructive (read-only)
src/core/BranchManager.ts:533        execFileSync('git', args, {                                    destructive — wrapped by the guarded BranchManager constructor
src/core/AgentConnector.ts:141       execSync('git --version', …)                                   non-destructive (version query)
src/core/ParallelDevWiring.ts:35     execFileSync('git', ['remote', 'get-url', 'origin'], …)       non-destructive (read-only)
src/core/GitSync.ts:1006             execFileSync('git', args, {                                    destructive — wrapped by the guarded GitSyncManager constructor
src/core/WorktreeManager.ts:756      execFileSync('git', […'rev-parse', 'HEAD'], …)                 non-destructive (read-only)
src/core/WorktreeManager.ts:763      execFileSync('git', […'rev-parse', '--verify', branch], …)    non-destructive (read-only)
src/core/WorktreeManager.ts:765      execFileSync('git', […'branch', branch], …)                    branch-create only; targets a worktree path, not the source tree — deferred to SafeGitExecutor PR
src/core/WorktreeManager.ts:767      execFileSync('git', […'worktree', 'add', …], …)                creates a new worktree, does not mutate source — out of scope
src/core/WorktreeManager.ts:879      execFileSync('git', […'worktree', 'list', …], …)              non-destructive (read-only)
src/core/FileClassifier.ts:298       execFileSync('git', ['checkout', '--ours', …], …)             destructive — invoked only during sync under GitSyncManager's control; guard fires at manager construction upstream
src/core/FileClassifier.ts:302       execFileSync('git', ['add', …], …)                             destructive — same as above; upstream-guarded
src/core/FileClassifier.ts:324       execFileSync('git', ['add', relPath], …)                       destructive — same; upstream-guarded
src/core/HandoffManager.ts:496       execFileSync('git', args, …)                                  destructive — wrapped by the guarded HandoffManager constructor
src/server/routes.ts:2285            execFileSync('git', ['remote'], …)                             non-destructive (read-only)
src/server/routes.ts:3035            execFileSync('git', ['remote', 'get-url', 'origin'], …)       non-destructive (read-only)
src/lifeline/ServerSupervisor.ts:376 spawnSync('git', ['status'], …)                                non-destructive (read-only)
src/lifeline/ServerSupervisor.ts:384 spawnSync('git', ['rebase', '--abort'], …)                     recovery-only, operates on the agent's OWN repo (not the source tree); orthogonal to this guard
src/commands/init.ts:386             execFileSync('git', ['init'], …)                              destructive on target dir — target is a fresh user project, not the source tree; out of scope
src/commands/init.ts:3329            execFileSync('git', ['remote'], …)                             non-destructive (read-only)
src/commands/nuke.ts:142             execFileSync('git', ['add', '-A'], …)                          destructive — operator-initiated on the agent's own directory; documented and out of scope
src/commands/nuke.ts:143             execFileSync('git', ['status', '--porcelain'], …)             non-destructive (read-only)
src/commands/nuke.ts:150             execFileSync('git', ['commit', …], …)                          destructive — same as above
src/commands/nuke.ts:156             execFileSync('git', ['push'], …)                              destructive — same
src/commands/nuke.ts:212             execFileSync('git', ['remote'], …)                            non-destructive (read-only)
src/commands/machine.ts:285          execFileSync('git', ['clone', …], …)                          destructive on a fresh target, not the source tree
src/commands/setup.ts:114            execFileSync('git', ['rev-parse', '--show-toplevel'], …)      non-destructive (read-only)
src/monitoring/WorktreeReaper.ts:208 execFileSync('git', […'worktree', 'add', …], …)               creates a new worktree, does not mutate source
```

Summary:
- 31 direct git invocations under `src/`.
- Destructive call sites routed through the three guarded managers:
  `GitSync.ts:1006`, `BranchManager.ts:533`, `HandoffManager.ts:496`,
  plus three `FileClassifier` helpers invoked only under
  `GitSyncManager`'s control.
- Destructive sites NOT routed through the three managers and flagged
  for PR 2 (SafeGitExecutor centralization): `WorktreeManager.ts`
  branch/worktree creation, `commands/init.ts`, `commands/nuke.ts`,
  `commands/machine.ts clone`, `ServerSupervisor.ts rebase --abort`.
  None of these target the instar source tree in their documented call
  patterns — they either operate on fresh targets (`init`, `clone`,
  `worktree add`) or on the agent's own dir (`nuke`, `rebase --abort`).
- No unguarded manager-layer destructive paths found.

This inventory is the "documented enumeration at ship time" the spec's
pre-ship acceptance criterion requires.

---

## Evidence pointers

- Spec: `docs/specs/DESTRUCTIVE-TOOL-TARGET-GUARDS-SPEC.md` (approved,
  converged).
- Convergence report:
  `docs/specs/reports/destructive-tool-target-guards-convergence.md`.
- Unit tests: `tests/unit/SourceTreeGuard.test.ts` — 34 tests, all
  green locally. Covers detector layers individually, normalization
  rules, worktree handling (standard + non-standard + malformed +
  relative pointer), subdirectory bypass, uncreated-subdirectory
  bypass, symlink canonicalization, two-tier fail-closed, error
  shape.
- Integration tests:
  `tests/integration/source-tree-guard-wiring.test.ts` — 10 tests, all
  green. Covers: constructor throws for each of the three managers
  pointed at the real instar source; uncreated-subdirectory-of-instar
  still throws; mkdtemp sandbox construction succeeds for all three;
  subdirectory-of-sandbox also succeeds (no over-block on legitimate
  nested paths); side-effect isolation (state dir NOT created when
  guard fires).
- Smoke tier pass: `npm run test:smoke` — 2037 tests passed locally
  post-wiring (the push-hook's gate).
- Full-suite sample: `tsc --noEmit` clean; no new warnings.
