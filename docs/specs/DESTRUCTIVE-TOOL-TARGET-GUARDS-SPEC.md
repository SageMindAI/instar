---
slug: destructive-tool-target-guards
review-convergence: converged
review-iterations: 6
review-completed-at: "2026-04-23T20:45:00Z"
review-report: "docs/specs/reports/destructive-tool-target-guards-convergence.md"
approved: true
---

# Destructive Tool Target Guards

## Problem

On 2026-04-22, a run of `tests/e2e/branch-lifecycle.test.ts` executed its `git add` / `git commit` sequence against the real instar source tree at `/Users/justin/Documents/Projects/instar/` instead of the `mkdtemp`-allocated sandbox it was supposed to be operating inside. The fixture wiped 1,893 files from `main` as a single commit titled "init", authored `Test <test@test.com>`.

Forensic fingerprint is unambiguous — the fixture's own code matches the damage byte-for-byte:

- The committed `README.md` was `# Test\n` — the exact string the fixture writes.
- The branch name left behind on the working copy was `task/test-machine/add-auth` — the fixture's hard-coded branch name.
- `src/auth.ts` and `src/middleware.ts` in the bad commit match the fixture's inlined source verbatim.

Recovery required a force-push from the fork remote to restore history.

Root-cause narrative: the test constructed a `GitSyncManager` (and helpers) pointed at a directory it believed was the `mkdtemp` sandbox, but due to a cwd/env mistake the `projectDir` it passed through was the real instar repo. The destructive components trusted the incoming path and ran `git add -A` / `git commit` / branch mutation directly against it. No component along that path asked "is this actually the intended target?" before mutating.

A related but distinct incident (Adriana's git-sync autostash/rebase wipe) has a different failure shape — rebase-during-autostash losing uncommitted work on a legitimate target directory. **That case is out of scope for this spec.** It is covered by a separate PR and must not be conflated here.

## Root cause

Destructive components assume their `projectDir` is safe to mutate with no verification that it actually is the right target. The fixture/cwd layer is one source of mistakes; hostile or buggy callers are another; future refactors that rewire how `projectDir` is resolved are a third. None of these are covered by structural checks today — the verification surface is wherever the caller happens to remember to put it, which in practice means nowhere.

The fix is to move the check from "every caller, hopefully" to "the destructive component itself, unconditionally, at construction time."

### Scope honesty

This spec delivers a **tactical guardrail**, not the primary containment boundary. The durable answer to "destructive components trust arbitrary path strings" is positive authorization: require an unforgeable "mutable workspace" capability produced only by sandbox/worktree creation code. That redesign is deliberately out of scope here — see "Out-of-scope follow-ups." What ships under THIS spec is a specific deny-list of one known-dangerous target (the instar source tree) at the component boundary. The assumption is that the cost-benefit of this narrower guard is dominated by "it would have prevented yesterday's incident," and the broader redesign is a larger effort that should not block the tactical fix.

## Design principle

This guard is deliberately a brittle blocker. That is correct, not incorrect, per `docs/signal-vs-authority.md` § "When this principle does NOT apply":

> **Safety guards on irreversible actions.** `rm -rf /`, force-pushing to main, deleting the database — these can and should be hard-blocked by brittle pattern matchers, because the cost of a false pass is catastrophic and the cost of a false block is merely "try again with the right arguments."

An unintended `git add -A && git commit` against the instar source is exactly this category: false-pass cost = 1,893-file wipe + force-push recovery; false-block cost = developer edits a path or touches a marker file once. The asymmetry is overwhelming. Signal-vs-authority does not apply to this class of check.

## The guard primitive

New file: `src/core/SourceTreeGuard.ts`. Two exports.

```ts
/**
 * Returns true if `dir` — OR any of its git-root ancestors — is the instar source tree.
 * Canonicalizes the input path first.
 *
 * Detection is the OR of:
 *   (a) marker file present: <resolvedRoot>/.instar-source-tree exists.
 *   (b) git remote identity: the resolved common git dir (see "worktree
 *       handling" below) has a `config` file whose `origin` remote URL
 *       exactly matches one of the canonical instar remotes
 *       (closed enumeration below).
 *   (c) source identity signature fallback: <resolvedRoot>/package.json has
 *       `name === "instar"` AND at least TWO of the following files exist:
 *       `src/core/GitSync.ts`, `src/core/BranchManager.ts`,
 *       `src/core/HandoffManager.ts`, `tsconfig.json`, `skills/spec-converge/SKILL.md`.
 *
 * "resolvedRoot" is computed as follows:
 *   1. If `dir` exists, start from `realpathSync(dir)`. If `dir` does NOT
 *      exist, walk upward via `path.dirname` until an existing ancestor is
 *      found, then `realpathSync` THAT ancestor. This closes the
 *      "uncreated subdirectory" bypass — a caller passing
 *      `/Users/.../instar/src/new_feature` (not yet on disk) gets resolved
 *      to its nearest existing ancestor, which is still inside the instar
 *      source tree.
 *   2. From the canonicalized start, walk upward (up to 40 levels) looking
 *      for a directory containing `.git` (file or dir). The first hit is
 *      the worktree root; continue to "worktree handling" for common-git-dir
 *      resolution. If no `.git` is found, resolvedRoot is the canonicalized
 *      start.
 *
 * Two tiers of fail-closed (intentional — see "Fail-closed semantics"
 * below for the reasoning):
 *   - Detector-level errors (cannot canonicalize path at all, cannot
 *     ascend to any existing ancestor, or cannot stat any ancestor due
 *     to permissions): the function returns TRUE. We cannot decide,
 *     so we block.
 *   - Layer-level errors (e.g. layer (b)'s .git/config is unreadable,
 *     malformed, or .git is a file with a broken pointer; layer (c)'s
 *     package.json is unreadable or malformed): that specific layer
 *     returns FALSE for its sub-check, and the OR across the three
 *     layers decides. A layer that cannot evaluate does NOT unilaterally
 *     force overall TRUE — otherwise a random corrupted file
 *     anywhere near the path would deny-all, which is an over-block
 *     the spec rejects.
 *
 * ENOENT and ENOTDIR during the nearest-existing-ancestor walk are
 * normal walk conditions, not failures — keep ascending. Layer (b) and
 * (c) seeing ENOENT on config/package.json is "layer doesn't match" =
 * layer returns FALSE for its sub-check; other layers still evaluate.
 */
export function isInstarSourceTree(dir: string): boolean;

/**
 * Throws `SourceTreeGuardError` if `dir` is the instar source tree.
 * `operation` is a short human label used in the thrown message,
 * e.g. "GitSyncManager", "BranchManager", "HandoffManager".
 *
 * IMPORTANT: callers MUST pass the raw `projectDir` from the original
 * caller — NOT a post-sanitization/post-normalization value. The guard's
 * job is to catch caller mistakes; sanitization that runs first would
 * hide exactly the class of bug this guard exists to catch.
 */
export function assertNotInstarSourceTree(dir: string, operation: string): void;
```

### Detection logic

Detection is intentionally multi-layered:

1. **Marker file (`.instar-source-tree`)** — an empty sentinel file committed to the root of the instar repo. Fast, explicit, zero-ambiguity. Git-tracked so it propagates with the repo.

2. **Git remote identity** — read `.git/config` (or the common git dir's `config` for a worktree — see "Worktree handling" below), find the `origin` remote URL, exact-match against the closed canonical-remote list enumerated in "Canonical instar remotes" below. No substring matching, no fork variants. This check is domain-appropriate for git-managing components and survives package renames. Forks are explicitly NOT caught by this layer — they rely on the marker or the signature fallback (or are out of scope, for serious forks that rename the project).

3. **Source identity signature fallback** — for cases where the marker has been deleted and `.git/config` is missing/unreadable (e.g. shallow copy, export tarball): `package.json.name === "instar"` AND at least TWO of a list of instar-specific files exist. Multi-file signature survives any single rename or deletion — only a coordinated rename of two-plus files AND the package name defeats it, at which point this is no longer the instar source tree.

### Git-root walk (critical — not a nice-to-have)

The resolved root is computed by canonicalizing `dir` (or its nearest existing ancestor if `dir` does not yet exist — see "uncreated subdirectory bypass" below) and walking upward to find `.git`. This closes the **subdirectory-bypass** hole: if a caller passes `/Users/.../instar/src/tests`, the raw path does not look like a repo root, but the walk finds `/Users/.../instar/.git` and evaluates the three checks there. Without this walk, `git add -A` from inside the subdirectory would still mutate the real repo while the guard said "fine, not the source tree." The walk is what makes the guard match how git itself resolves the target.

Walk cap: 40 directory levels, to prevent pathological loops on broken filesystems. If the walk hits filesystem root without finding `.git`, the resolved root is the canonicalized start.

### Uncreated-subdirectory bypass (must be closed)

A naive implementation would `realpathSync(dir)`, catch ENOENT, and return false. That re-opens the bypass: a caller passes `/Users/.../instar/src/new_feature` (which doesn't exist yet), the detector returns false, the component then `mkdir`s the directory and runs `git add -A`, which traverses up to the real `.git` and wipes the repo. The round-2 reviewer (Gemini) flagged this path explicitly.

Closure: when `dir` does not exist, walk upward via `path.dirname` until an existing ancestor is found, canonicalize THAT, and continue the git-root walk from there. The nonexistent-path AC is therefore: "returns false ONLY when the nearest existing ancestor is outside the instar source tree; returns true when the nearest existing ancestor resolves to an instar git root."

### Worktree handling (`.git` as file, not dir)

A git worktree has a `.git` **file** (not a directory) at the worktree root, containing a line like `gitdir: /path/to/main/repo/.git/worktrees/<name>`. The walk finds this file; the detector must then:

1. Read the `.git` file.
2. Parse the `gitdir:` line. Resolve the target path. If relative, resolve it against the directory containing the `.git` file (the worktree root itself), per `git-worktree(1)` — NOT against the worktree root's parent.
3. Derive the common git dir from the resolved `gitdir:` target by this exact rule:
   - If `basename(dirname(gitdir))` equals `worktrees` (the standard layout — `<common-git-dir>/worktrees/<name>`), then the common git dir is `dirname(dirname(gitdir))`.
   - Otherwise (non-standard layout — e.g. submodule worktree, custom `core.worktreesDir`, or implementation-defined layouts we don't recognize), layer (b) fails closed for this sub-check. Layers (a) and (c) still evaluate at the worktree root. This matches the overall fail-closed philosophy: when we can't definitively identify which ancestor holds `config`, we don't guess — we rely on the other two layers.
   Read `config` from the derived common git dir for the remote-URL check. Do NOT read `config` from the per-worktree admin dir (which also contains its own `HEAD` and similar, and is why "contains HEAD/config heuristic" is unreliable and rejected).
4. The worktree root ITSELF still carries the marker file (git-tracked, checked out into worktrees) and the signature files (also checked out), so those two layers work at the worktree root unchanged.

Outcome: a worktree of the instar source is detected by (a) marker OR (c) signature (both present in the worktree checkout) AND by (b) remote URL check via the resolved common git dir. Three independent layers still protect worktrees — no degradation.

If `.git` is a file but the `gitdir:` line is malformed, the pointed-at directory is unreadable, or the layout isn't the standard `<common>/worktrees/<name>`, layer (b) returns FALSE for its sub-check (layer-level inconclusive) and layers (a) and (c) still decide. This is the layer-level tier of fail-closed described in "Fail-closed semantics" — a single layer being unable to evaluate does not force the whole detector to block; only a detector-level inability to canonicalize or ascend does.

### Canonical instar remotes (closed enumeration)

The list is:

- `git@github.com:dawn/instar.git`
- `https://github.com/dawn/instar.git`
- `ssh://git@github.com/dawn/instar.git`

**Minimal canonicalization before comparison** (to avoid false negatives on textually-different-but-semantically-identical URLs that git itself accepts):

1. Strip leading/trailing whitespace, including a trailing newline (git config values sometimes carry one).
2. Strip a single trailing `/` if present.
3. Strip a single trailing `.git` if present (so `https://github.com/dawn/instar` and `https://github.com/dawn/instar.git` both compare equal to the canonical form after normalization).

After normalization, the comparison is exact-match against the list above (also normalized the same way). No substring matching on `instar`. No regex matching. No wildcarding of owner or repo name. The three enumerated URLs are the only ones that match, modulo the three normalization rules.

Rationale: git itself treats `https://github.com/dawn/instar.git` and `https://github.com/dawn/instar.git/` as the same remote; the guard should too, or it weakens layer (b) on legitimate checkouts. The normalization rules are intentionally narrow — no scheme rewriting, no host normalization, no credential stripping — to keep the surface small and predictable.

The enumeration lives as a constant in `SourceTreeGuard.ts`, with a code comment explaining that forks running on their own `package.json.name` and without the marker file will legitimately NOT be caught by layer (b) — that is intentional. Layer (c) still catches unrenamed forks; the marker catches any fork that deliberately opts in.

If instar ever moves org/repo name, this list gets an entry ADDED, never substituted (old URL stays to catch legacy checkouts). Change-management: any PR modifying this list goes through `/spec-converge` the same as any other source change.

### Error shape

```ts
export class SourceTreeGuardError extends Error {
  readonly code = "INSTAR_SOURCE_TREE_GUARD";
  readonly operation: string;
  readonly dir: string;
  readonly resolvedRoot: string;
  constructor(dir: string, resolvedRoot: string, operation: string) {
    super(
      `Refusing to run ${operation} against the instar source tree ` +
      `(requested dir: ${dir}, resolved git root: ${resolvedRoot}). ` +
      `This is a safety guard against the 2026-04-22 class of incident. ` +
      `See docs/specs/DESTRUCTIVE-TOOL-TARGET-GUARDS-SPEC.md for the documented ` +
      `escape hatch if this block is a genuine false-positive.`
    );
    this.operation = operation;
    this.dir = dir;
    this.resolvedRoot = resolvedRoot;
  }
}
```

The error message intentionally does NOT inline bypass instructions. Reviewers flagged that a tutorial-in-the-error-message creates a convenient "how to defeat the guard" crib sheet that outlives the reason the guard exists. Bypass procedure lives in the spec, not in the exception text.

### Fail-closed semantics (two tiers)

**Detector-level fail-closed.** If the detector cannot complete its own top-level contract — cannot canonicalize the path, cannot find any existing ancestor (all the way to filesystem root), or EACCES on every attempt to stat the candidate ancestors — it returns TRUE. In this state we literally cannot decide whether the path is the instar tree, and the safety asymmetry says block.

**Layer-level fail-inconclusive.** Within the three-layer OR, a layer whose required inputs are missing or unreadable returns FALSE for its own sub-check, and the OR across layers decides. For example: layer (b) encounters EACCES on `.git/config`, or the `.git` pointer is malformed — layer (b) returns false; layers (a) and (c) evaluate normally; if either of those is true, the detector returns true; if neither is true, the detector returns false. This avoids the over-block pathology where a single corrupted or inaccessible file adjacent to a caller's legitimate tmpdir would unilaterally deny every destructive operation.

Rationale for the two-tier split: if we collapse the two tiers ("any layer error = detector returns true"), a single stray unreadable file near ANY caller's `projectDir` triggers the guard, turning the safety mechanism into a denial-of-service vector against routine test runs. If we collapse them the other way ("all errors are layer-local, detector never fails closed"), a caller whose path can't be canonicalized at all silently passes. The two-tier rule preserves both: catastrophic errors at the detector level block; localized errors at a layer level let the other layers speak.

ENOENT and ENOTDIR during the nearest-existing-ancestor walk (step 1 of resolvedRoot) are explicitly normal — they mean "keep ascending." ENOENT on a layer's required file (e.g. no `.git/config` at all) means "this layer doesn't apply," which is FALSE for the sub-check, NOT fail-closed.

## Wire-ins

In each of the following constructors, the **first statement** (before any `this.x = y` assignment, before any collaborator construction, before any other validation) is:

```ts
assertNotInstarSourceTree(config.projectDir, "<ComponentName>");
```

Targets (today's destructive components):

- `src/core/GitSyncManager.ts` constructor — label `"GitSyncManager"`.
- `src/core/BranchManager.ts` constructor — label `"BranchManager"`.
- `src/core/HandoffManager.ts` constructor — label `"HandoffManager"`.

### Pre-ship enumeration requirement

The three-constructor list is valid today but is an inventory-based defense. Before this PR ships, the implementing agent MUST:

1. Run `grep -rn "simpleGit\|spawn.*['\"]git['\"]" src/` from the instar repo root.
2. For every hit, classify: is this a destructive call (mutates the working tree or branch state)? If yes, does it go through one of the three listed managers?
3. Any destructive call site that does NOT go through the three managers is added to the wire-in list in this spec BEFORE the PR lands. The grep output is included in the PR description as evidence.

This converts the inventory defense from "hope we found them all" to "documented enumeration at ship time."

### Future-proofing (non-blocking)

A follow-up PR (see out-of-scope) will centralize destructive git execution behind a single `SafeGitExecutor` primitive that internally calls `assertNotInstarSourceTree`. At that point the three constructor wire-ins remain as belt-and-suspenders but the inventory defense is replaced by structural funnel. This PR is necessary-but-not-sufficient toward that end state.

## What this explicitly does NOT cover

- **Adriana's autostash/rebase wipe** — separate failure mode (rebase eats uncommitted work on a legitimate target), fixed in a separate PR.
- **E2E test sandbox hardening** — making the test harness refuse to run when cwd/projectDir is outside `mkdtemp`, asserting env isolation. Follow-up PR. The spec author notes this is the **most-direct** prevention of yesterday's specific incident; it is deferred only because this guardrail is narrower, more portable, and deployable faster. The sandbox hardening PR is committed to ship in the same milestone.
- **CI read-only job** — CI step that fails the build if the repo working tree is dirty after the test run. Follow-up PR.
- **SafeGitExecutor centralization** — single-funnel refactor of all destructive git calls. Follow-up PR.
- **Positive-authorization redesign** — replacing deny-list with mutable-workspace capability tokens. Larger architectural change; tracked but not scheduled.
- **Kernel/container guards** — seccomp-bpf, AppArmor profiles, readonly bind mounts, chroot. Orthogonal defense-in-depth layer. Not blocked, not scheduled here.

## Alternatives considered (and rejected for this PR)

- **Filesystem `chmod -w` on the instar repo root during tests.** Cheap but doesn't survive `git reset`, requires per-developer setup, no-op on CI without equivalent config. Good complementary measure, not a replacement.
- **Readonly bind mount / Docker volume for the source checkout.** Effective but raises the bar for casual development and doesn't help in-process mistakes made by the agent itself.
- **Git hook (`pre-commit`) on the instar repo that refuses commits authored `Test <test@test.com>`.** Narrow — only catches this exact fixture signature, trivially bypassed.
- **Require an explicit "mutable-workspace token" threaded through destructive components.** The right long-term answer, explicitly scheduled as a follow-up. Larger refactor than this incident justifies as a blocking change.
- **Pure inventory grep + lint rule forbidding `simpleGit` outside approved files.** Good companion but doesn't catch the case where an approved file gets the wrong `projectDir`.

## Over-block / Under-block analysis

**Over-block risk** — legitimate cases where the guard blocks work that should proceed:

- Self-hosting an instar fork with `package.json.name` unchanged and canonical remotes. Mitigation: fork remotes are NOT on the enumerated canonical-remote list; forks survive remote identity check. Marker file is only in the upstream repo unless the forker copied it. Signature fallback is defeated by renaming two of the signature files OR the package — realistic for a serious fork.
- Test that deliberately wants to construct a manager against the instar source (e.g. the guard's own test). Mitigation: such tests use a tmpdir that fails all three checks; guard's own tests construct and tear down each signature variant per case.
- Git worktree of instar used intentionally as a target (e.g. parallel-dev harness). This WOULD block today. The fix is to declare worktrees of the instar source as also-protected, not to weaken the guard — the worktree's `.git` pointer resolves to the same repo, so autostash/rebase there is equally catastrophic.

**Under-block risk** — destructive paths the guard does not cover:

- Destructive components not on the three-manager list. Addressed by pre-ship enumeration requirement above.
- Destructive work launched via child processes that bypass the manager layer entirely (shell scripts, `npm` scripts calling git). Not covered. Companion `safe-git` wrapper is a follow-up.
- Mutation via a manager constructed before the guard landed, held across an in-process upgrade. Not realistic — managers are per-process, upgrade ⇒ restart.
- Subdirectory-passed `projectDir`: **addressed** by the git-root walk.
- Symlinked `projectDir`: **addressed** by `realpathSync` canonicalization.
- Unreadable `package.json`: **addressed** as layer-level inconclusive — layer (c) returns false, layers (a)/(b) still decide. If neither matches, detector returns false. (See "Fail-closed semantics (two tiers)" — this is NOT detector-level fail-closed, and is intentionally not.)
- Renamed `src/core/GitSync.ts`: **addressed** by multi-file signature (two-of-N) and by `.git/config` remote-URL check.
- Uncreated-subdirectory bypass: **addressed** by nearest-existing-ancestor walk.
- Git worktree: **addressed** by `.git`-file parsing for the remote-URL layer and by marker/signature layers working unchanged at the worktree root.

**Abstraction fit.** The guard is at the component boundary — where `projectDir` first becomes trusted state. Below that boundary (inside `simpleGit`/`spawn` calls) is too late; above (in callers) is too scattered. Constructor-time is the right layer for today's code; the `SafeGitExecutor` follow-up will additionally funnel at the call boundary.

**Interactions.** No interaction with auth, dispatch, tone, or session systems. The guard is a local synchronous fs check with no network, no LLM, no async. Cannot introduce latency-gate-vs-client-timeout issues (it is sub-millisecond on warm fs cache, <5ms cold).

**Signal-vs-authority compliance.** Re-checked: this is a brittle blocker on an irreversible action, which is the explicit carve-out in `docs/signal-vs-authority.md`. No judgment-call gate is being added. Compliant.

## Rollback

Pure code revert: delete `src/core/SourceTreeGuard.ts`, remove the three one-line wire-ins. No persistent state in any agent's `.instar/` dir is touched. No migration, no data format change. Any running process is unaffected until next restart.

The `.instar-source-tree` marker file in the instar repo root can be left in place on rollback — it's inert without the guard code reading it. Leaving it avoids a second commit on rollback.

A rollback ships as a hotfix within minutes.

## Acceptance criteria

Each of these must be a passing unit or integration test before the feature ships. Organized by surface.

### Detector — positive cases (guard engages)

- `isInstarSourceTree(dir)` returns true when `<dir>/.instar-source-tree` exists.
- `isInstarSourceTree(dir)` returns true when `<dir>/.git/config` has `origin` pointing at EACH of the three canonical instar remotes (one test per enumerated URL — `git@github.com:dawn/instar.git`, `https://github.com/dawn/instar.git`, `ssh://git@github.com/dawn/instar.git`).
- `isInstarSourceTree(dir)` returns true for URL variants that normalize to a canonical remote: trailing slash (`https://github.com/dawn/instar.git/`), missing `.git` suffix (`https://github.com/dawn/instar`), trailing whitespace / trailing newline in the config value. One test per normalization rule.
- `isInstarSourceTree(worktreeRoot)` returns true for a git worktree of the instar source — verifies the `.git`-file parsing path and that layers (a)/(c) still engage at the worktree root.
- `isInstarSourceTree(worktreeRoot_with_relative_gitdir_pointer)` — fixture's `.git` contains `gitdir: ../main/.git/worktrees/foo`; detector resolves relative to the worktree root (directory containing the `.git` file), NOT the worktree root's parent. Test fails if implementation resolves to the wrong base.
- `isInstarSourceTree(worktreeRoot_standard_layout)` — fixture has `gitdir:` pointing at `<commonGitDir>/worktrees/<name>`; detector reads `config` from `<commonGitDir>` (verified via spy that `readFileSync` was called on `<commonGitDir>/config`, NOT on `<commonGitDir>/worktrees/<name>/config`).
- `isInstarSourceTree(worktreeRoot_nonstandard_layout)` — fixture has `gitdir:` pointing at a path where `basename(dirname(gitdir))` is not `worktrees` (e.g. submodule or custom layout); layer (b) fails closed; layers (a)/(c) still determine the verdict; detector behavior is fully defined, not implementation-dependent.
- `isInstarSourceTree(path_where_intermediate_segment_is_a_file_ENOTDIR)` — the nearest-existing-ancestor walk continues past ENOTDIR the same as ENOENT.
- `isInstarSourceTree(dir_inside_instar_that_does_not_yet_exist)` returns true — verifies uncreated-subdirectory closure via nearest-existing-ancestor walk.
- `isInstarSourceTree(dir)` returns true when `<dir>/package.json` has `name === "instar"` AND two-plus signature files exist, and marker + .git/config absent.
- `isInstarSourceTree(subdir_of_instar_source)` returns true — verifies the git-root walk closes the subdirectory-bypass hole.
- `isInstarSourceTree(symlinkToInstarSource)` returns true — verifies `realpathSync` canonicalization.

### Detector — negative cases (guard passes)

- `isInstarSourceTree(emptyTmpDir)` returns false.
- `isInstarSourceTree(tmpDirWithInstarPackageJsonButNoSignatureFiles)` returns false.
- `isInstarSourceTree(tmpDirWithOneSignatureFileButNoPackageJsonMatch)` returns false.
- `isInstarSourceTree(legitimateForkWithNonCanonicalRemote)` returns false — fork remote is not on the canonical list.
- `isInstarSourceTree(dirWithGitButUnrelatedRemote)` returns false.
- `isInstarSourceTree(nonexistentPath_with_nearest_existing_ancestor_outside_instar)` returns false — ENOENT itself does not fail-closed, but the nearest-existing-ancestor walk does not find instar markers.
- `isInstarSourceTree(legitimateForkWithForkRemoteURL_not_on_canonical_list)` returns false — fork remotes (e.g. `git@github.com:someuser/instar-fork.git`) are explicitly NOT caught by layer (b). Forks that also rename `package.json.name` and drop the marker survive by design.

### Detector — fail-inconclusive cases (layer-level vs detector-level)

Layer-level inconclusive (one layer can't evaluate; other layers decide):

- `isInstarSourceTree(dirWithUnreadablePackageJson_EACCES_but_marker_present)` returns true (layer (a) matches; layer (c) inconclusive).
- `isInstarSourceTree(dirWithUnreadablePackageJson_EACCES_no_marker_no_gitconfig)` returns false (no layer matches; detector itself CAN complete — the ancestor is accessible, just this one file isn't readable).
- `isInstarSourceTree(dirWithMalformedPackageJson_no_marker_no_gitconfig)` returns false (layer (c) inconclusive; layers (a)/(b) don't match; detector completes).
- `isInstarSourceTree(dirWhereGitConfigIsDirectoryNotFile_no_marker_no_signature)` returns false (layer (b) inconclusive; (a)/(c) don't match; detector completes).
- `isInstarSourceTree(worktreeWithMalformedGitFilePointer)` returns true if the worktree root has marker OR signature; false otherwise. Layer (b) inconclusive; layers (a)/(c) evaluate at the worktree root and decide.

Detector-level fail-closed (detector itself can't decide; guard engages):

- `isInstarSourceTree(dir_where_all_ancestors_return_EACCES_on_stat)` returns true (detector can't ascend).
- `isInstarSourceTree(dir_with_realpath_throwing_ELOOP)` returns true (detector can't canonicalize).

Test coverage must distinguish these two tiers — a test that conflates them (e.g. checks "EACCES anywhere returns true") enshrines the over-block pathology this design rejects.

### Assertion wrapper

- `assertNotInstarSourceTree(dir, op)` throws `SourceTreeGuardError` with `code === "INSTAR_SOURCE_TREE_GUARD"`, `operation === op`, when `isInstarSourceTree(dir)` is true.
- `assertNotInstarSourceTree(dir, op)` is a no-op when `isInstarSourceTree(dir)` is false.
- Thrown error's `resolvedRoot` field matches the git-root-walked path.

### Wire-ins — side-effect isolation

- `new GitSyncManager({ projectDir: <instar-source-root>, ... })` throws `SourceTreeGuardError` with `operation === "GitSyncManager"`.
- Same for `BranchManager`, `HandoffManager`.
- `new GitSyncManager(...)` against the instar source throws with NO observable side effect on injected spy collaborators (no `git()` call, no fs write, no assignment that the spy can witness). Equivalent tests for the other two managers. This replaces the less-testable "first statement" acceptance criterion — what matters is "throws before any collaborator touches anything," which IS directly testable via spies.
- Legitimate `mkdtemp` sandbox construction succeeds for all three managers.
- Subdirectory-of-sandbox construction succeeds (to confirm the git-root walk does not over-block when the git root is a sandbox, not the instar source).

### Repo-level

- `.instar-source-tree` marker file exists at the instar repo root and is tracked in git.
- A self-test runs in CI that constructs `isInstarSourceTree(process.cwd())` during the instar test suite and asserts it returns true — this catches any future refactor that silently invalidates all three detection layers at once.
- All existing e2e / integration tests that use `mkdtemp` sandboxes still pass unchanged — the guard does not fire on legitimate sandboxes.

### Pre-ship enumeration

- PR description contains the output of `grep -rn "simpleGit\|spawn.*['\"]git['\"]" src/` with each hit classified destructive/non-destructive and, if destructive, which of the three managers handles it (or a wire-in added for new cases).

## Out-of-scope follow-ups

Explicitly deferred, committed to ship as separate PRs:

- **PR: e2e sandbox cwd isolation** — test harness refuses to run when cwd/projectDir is not under `mkdtemp` or an approved temp root; env vars scrubbed. This is the most direct prevention of yesterday's specific incident and ships in the same milestone as this spec.
- **PR: git-sync autostash/rebase safety** — Adriana's separate case; rebase-during-autostash wiping uncommitted work on a legitimate target.
- **PR: CI mutation-detector job** — CI step that fails the build if the repo working tree is dirty after the test run.
- **PR: SafeGitExecutor centralization** — single-funnel refactor of all destructive git calls to eliminate the inventory defense.
- **Tracked, unscheduled: positive-authorization redesign** — mutable-workspace capability tokens replacing deny-list. Larger architectural change.
- **Tracked, unscheduled: kernel/container guards** — seccomp-bpf, AppArmor, readonly bind mounts. Orthogonal defense-in-depth.
