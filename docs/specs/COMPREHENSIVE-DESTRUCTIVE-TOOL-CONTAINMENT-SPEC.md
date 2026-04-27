---
slug: comprehensive-destructive-tool-containment
title: "Comprehensive Destructive-Tool Containment (SafeGitExecutor + Deferral-Honesty Layers)"
author: "echo"
review-convergence: internal-converged
review-iterations: 3
review-completed-at: "2026-04-26T00:00:00Z"
review-report: "docs/specs/reports/comprehensive-destructive-tool-containment-convergence.md"
review-notes: "Single-author internal multi-angle review (security, integration, recurrence-containment, scalability). Live /spec-converge + /crossreview recommended before approval for additional external-model perspective on a foundational spec of this scope."
approved: true
approved-by: justin
approved-at: "2026-04-26T20:35:00Z"
approval-notes: "Approved via Telegram topic 8122 after reading the bundled review doc (link 2783c601-...). Comprehensive-first directive applied to the spec itself; zero recurrence-risking deferrals remain at approval time."
principal-deferral-approval:
  - id: commitment://incremental-migration
    approved-at: "2026-04-26T20:50:00Z"
    rationale: "Spec inventory undercounted destructive callsites by ~6× (estimated ~167, actual 1025). Migrating all 1025 in a single PR is a 15-25h mechanical job with high risk of subtle test breakage and a long no-progress window. The foundation (funnels + lint rule + CI mutation detector + governance layers) prevents the original wipe class on its own — the migration is closing the bypass surface for callers that already exist. Deferred for incremental delivery via a same-week follow-up PR with hard 7-day deadline. This is the first real test of the new commitment-tracker infrastructure."
supersedes-deferrals-from:
  - docs/specs/DESTRUCTIVE-TOOL-TARGET-GUARDS-SPEC.md
related:
  - docs/specs/DESTRUCTIVE-TOOL-TARGET-GUARDS-SPEC.md
  - docs/signal-vs-authority.md
---

# Comprehensive Destructive-Tool Containment

## Problem

### Incident A — 2026-04-22 (the one PR #96 was meant to prevent)

A run of `tests/e2e/branch-lifecycle.test.ts` constructed a `GitSyncManager` (and helpers) pointed at `/Users/justin/Documents/Projects/instar/` instead of an `mkdtemp` sandbox. The fixture's `git add -A && git commit` ran against the real source tree, replacing `main` with a 1,893-file deletion commit titled "init", authored `Test <test@test.com>`. Recovery required a force-push of a backup. Documented and partially fixed in PR #96 (`docs/specs/DESTRUCTIVE-TOOL-TARGET-GUARDS-SPEC.md`).

PR #96 added `assertNotInstarSourceTree` and wired it into the constructors of `GitSyncManager`, `BranchManager`, and `HandoffManager`. Three independent detection layers (marker file, canonical remote URL, source signature) plus a git-root walk plus worktree handling plus two-tier fail-closed semantics. That guard works as designed.

### Incident B — 2026-04-25 02:17 (the recurrence)

Five days after PR #96 shipped, the same class of bug recurred in a different surface: e2e test fixtures (`tests/e2e/branch-lifecycle.test.ts` setup, `tests/e2e/compaction-harness.ts`, `tests/fixtures/two-session-harness.ts`, GitSync init paths) ran `execFileSync('git', [...])` directly against the real source tree, **bypassing the manager constructors entirely**. The PR #96 guard never fired because the destructive call never went through a guarded manager — the test fixture invoked git itself.

This is exactly the under-block PR #96 named in its own "What this explicitly does NOT cover" section (line 243: "SafeGitExecutor centralization — single-funnel refactor of all destructive git calls. Follow-up PR.") and named again in "Out-of-scope follow-ups" (line 366). The deferral was identified, written down, and then **never scheduled with a tracked commitment**. Five days passed. The original problem class recurred.

### The meta-pattern (the deeper failure mode)

PR #96's containment was technically correct for the surface it covered, and structurally insufficient because it relied on caller discipline ("destructive components funnel through these three classes"). That is a load-bearing assumption in a codebase where 90+ direct git callsites exist. The spec named the gap, deferred it, and the deferral became a silent commitment that no infrastructure was watching.

This is the **out-of-scope trap**: a tactical fix ships with a non-trivial residual risk, the residual risk is honestly named, and then the act of naming it substitutes for actually scheduling the follow-up. The original problem recurs in the residual surface within the lifetime of a normal sprint, and the agent that wrote the spec has no record of having promised to ship the follow-up — because the spec itself was the only artifact, and specs aren't tracked work items.

This spec must close BOTH the technical gap (Part 1: funnel-and-enforce all destructive git calls) AND the meta-pattern (Part 2: structural prevention of "out-of-scope follow-ups without owned commitments" recurring on future specs).

## Goals

1. **Eliminate Incident B's class — for git AND for filesystem destructive ops.** Every destructive git invocation in the instar repo — manager constructors, test fixtures, integration harnesses, npm scripts, shell scripts, skill scripts — funnels through a single `SafeGitExecutor` primitive that calls `assertNotInstarSourceTree`. **Equally, every in-process destructive filesystem call (`fs.rm`, `fs.rmSync`, `fs.unlink`, `fs.unlinkSync`, `fs.rmdir`, `fs.rmdirSync`) funnels through a parallel `SafeFsExecutor` primitive that calls the same source-tree assertion before touching disk.** Both are added in this spec — the fs guard was originally deferred but pulled in-scope on 2026-04-26 under the comprehensive-first directive, since an in-process `fs.rmSync(realInstarPath, { recursive: true })` from a misconfigured fixture would wipe the same source tree as Incident A through a code path SafeGitExecutor never sees. The PR #96 constructor guard remains as belt-and-suspenders and second-tier defense.

2. **Make bypass structurally hard.** A lint rule (compile-time / pre-commit) refuses any new direct `execFileSync('git', ...)` / `spawn('git', ...)` / `simpleGit(...)` / `execSync('git ...')` callsite outside the SafeGitExecutor module, AND any direct `fs.rm*` / `fs.unlink*` / `fs.rmdir*` callsite outside the SafeFsExecutor module — including namespace-imported forms (`import * as fs from 'node:fs'; fs.rmSync(...)`). The lint allowlist is closed and small.

3. **Catch accidental tree mutations in CI.** A continuous-integration step fails the build if the working tree is dirty after the test suite runs. This is the final-line "did anything mutate the source tree we didn't expect?" check. **Originally deferred but pulled in-scope on 2026-04-26 under the comprehensive-first directive** — it's a small CI add and same-class as the funnels (both are about catching destructive surface that escapes the funnel).

4. **Close the out-of-scope trap.** Three structural layers prevent the meta-pattern recurrence:
   - **Layer A** — `/instar-dev`'s spec gate: refuses to proceed past Phase 0 if the spec contains `recurrence-risking` deferral language at all (default-deny, not default-allow), and refuses `tactical-deferral` items without paired commitment-tracker entries. Time-horizon caps tightened to 36 hours / 6 days respectively (10× tighter than the initial draft) on principal directive.
   - **Layer B** — pre-commit hook: refuses commits where staged spec content has an "out-of-scope follow-ups" section without commitment-tracker entries staged in the same commit.
   - **Layer C** — `/spec-converge` adds a "recurrence containment" reviewer angle: for each deferred item, asks "if this never ships, does the original problem recur?" AND a stricter sibling "is there any way this could be done in current scope, even at the cost of a larger PR?" If either answer points toward in-scope, the deferral is illegitimate.

5. **Comply with the new rule in this very spec.** After the comprehensive-first pass on 2026-04-26, the only deferred items remaining are: (i) the positive-authorization redesign (large refactor, classified `tactical-deferral`, paired commitment with 6-day cap), (ii) kernel/container guards (`genuinely-out-of-scope`, paired commitment unscheduled), and (iii) Adriana's autostash/rebase failure mode (`genuinely-out-of-scope` from this spec — different class — paired commitment for a separate spec to be drafted within 2 days). No `recurrence-risking` deferrals remain.

## Non-Goals

- Replacing PR #96. The constructor guard stays. SafeGitExecutor delegates to the same `assertNotInstarSourceTree` primitive — there is no second guard implementation, just additional callers of the same one.
- Positive-authorization redesign (mutable-workspace capability tokens). Larger architectural change. Tracked, scheduled with a commitment, but explicitly not delivered here. The funnel + lint defense is sufficient to close Incident B's class without requiring the redesign.
- Container/kernel-level guards (seccomp-bpf, AppArmor, readonly bind mounts). Orthogonal defense-in-depth. Tracked, not scheduled.
- Adriana's autostash/rebase wipe (different failure mode — rebase-during-autostash on a legitimate target). Tracked as its own spec with a 2-day deadline to publish a draft.
- Refactoring read-only git callsites (`git rev-parse`, `git remote get-url`, `git status --porcelain`, etc.). They do not mutate; SafeGitExecutor's funnel is for destructive operations only. Read-only callsites are catalogued in the inventory (Migration plan) and explicitly exempted from the lint rule via a closed list of safe verbs.

## Design

### Part 1 — SafeGitExecutor

#### Surface

New file: `src/core/SafeGitExecutor.ts`. Exports:

```ts
/**
 * Verbs treated as destructive. The funnel rule is: any verb in this set,
 * called via any path (execFileSync, spawn, simple-git, exec, shell), MUST
 * go through SafeGitExecutor.
 *
 * Closed enumeration. Adding a verb requires a spec change.
 */
export const DESTRUCTIVE_GIT_VERBS: ReadonlySet<string>;

/**
 * Read-only verbs explicitly safe to call directly. Closed enumeration.
 * The lint rule allows direct `execFileSync('git', ['<verb>', ...])` only
 * if the first arg after 'git' is in this list (or in the `-C <dir> <verb>`
 * shape, the verb following -C <dir>).
 */
export const READONLY_GIT_VERBS: ReadonlySet<string>;

export interface SafeGitOptions {
  /** Required. The directory the git command will mutate.
   *  Passed straight through to assertNotInstarSourceTree. */
  cwd: string;

  /** Caller label for error messages and audit log. */
  operation: string;

  /** stdio passthrough, default 'pipe'. */
  stdio?: 'pipe' | 'inherit' | 'ignore';

  /** Encoding for return value, default 'utf-8'. */
  encoding?: BufferEncoding;

  /** Timeout in ms, default 30000. */
  timeout?: number;

  /** Env passthrough — DENYLISTED for git-redirection variables.
   *  SafeGitExecutor strips the following from the merged env before invocation,
   *  even if the caller supplies them:
   *    GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY,
   *    GIT_COMMON_DIR, GIT_NAMESPACE, GIT_CONFIG, GIT_CONFIG_GLOBAL,
   *    GIT_CONFIG_SYSTEM, GIT_CONFIG_NOSYSTEM, GIT_CONFIG_PARAMETERS,
   *    GIT_CONFIG_COUNT, GIT_CONFIG_KEY_*, GIT_CONFIG_VALUE_*,
   *    GIT_CEILING_DIRECTORIES, GIT_DISCOVERY_ACROSS_FILESYSTEM
   *  Reason: these env vars redirect git's effective working tree / git-dir,
   *  which would let a caller in a benign cwd still mutate the instar source
   *  via env-redirected commands (cross-review finding, GPT 5.4, 2026-04-26).
   *  The denylist is enforced inside SafeGitExecutor; callers cannot opt out. */
  env?: NodeJS.ProcessEnv;

  // (No preVerified field. The guard runs unconditionally on every call.
  // See "Escape hatch" section below for why this was rejected during
  // internal review.)
}

export class SafeGitExecutor {
  /** Synchronous destructive git execution.
   *  Calls assertNotInstarSourceTree(opts.cwd, opts.operation) FIRST.
   *  If the cwd is the instar source tree, throws SourceTreeGuardError.
   *  If the verb is not in DESTRUCTIVE_GIT_VERBS, throws (callers should
   *  use the read-only path instead — fail loud rather than silently
   *  letting a typo pass through).
   *  Otherwise, runs `git <args>` in opts.cwd via execFileSync. */
  static execSync(args: readonly string[], opts: SafeGitOptions): string;

  /** Async/streaming variant for long-running ops. Same guard semantics. */
  static spawn(args: readonly string[], opts: SafeGitOptions): ChildProcess;

  /** Read-only escape valve: runs `git <args>` in opts.cwd WITHOUT the
   *  source-tree guard. The verb (args[0], or args[1] if args[0] === '-C')
   *  MUST be in READONLY_GIT_VERBS or the call throws.
   *  This is the supported way to do `git rev-parse` etc. without
   *  triggering the guard or the lint rule. */
  static readSync(args: readonly string[], opts: Omit<SafeGitOptions, 'operation'> & { operation: string }): string;
}
```

`DESTRUCTIVE_GIT_VERBS` initial contents (closed set; additions are spec changes):

```
add, am, apply, branch, checkout, cherry-pick, clean, clone, commit,
fetch, gc, init, merge, mv, pull, push, rebase, reset, restore, revert,
rm, stash, submodule, switch, tag, update-ref, worktree, prune,
notes, replace, filter-branch
```

`READONLY_GIT_VERBS`:

```
status, log, diff, show, rev-parse, rev-list, ls-files, ls-tree, ls-remote,
config (get only — see note), describe, name-rev, blame, cat-file, grep,
shortlog, count-objects, fsck, var, version, --version, help, write-tree
(adds objects only — does NOT mutate working tree or refs), remote
(only the `remote` and `remote get-url` forms; `remote add/remove/set-url`
are destructive), branch (only with --list / -l / --show-current; bare
`branch <name>` is destructive), worktree (only `worktree list`)
```

Verbs with mode-dependent destructiveness (`config`, `branch`, `remote`, `worktree`, `format-patch`) are validated by an additional argument-shape check inside `readSync`: if the args do not match a known read-only sub-shape, the call throws and the caller must use `execSync` with a destructive `operation` label instead. Specifically: `format-patch` is read-only by default (it writes patch files to a directory the caller specifies); it becomes destructive when invoked with `--inline` (which rewrites in-tree files) — the shape check catches `--inline` and routes to `execSync`. (Cross-review finding, Grok 4.1 Fast, 2026-04-26 — initial draft listed `format-patch (when used with --inline)` in DESTRUCTIVE_GIT_VERBS, which would have over-blocked the common read-only use.)

**Verb extraction from args.** Both `execSync` and `readSync` extract the verb defensively to handle the common `git -C <dir> <verb> ...` shape. The extraction rule: walk the args array skipping any leading `-C <dir>`, `--git-dir=<path>`, `--work-tree=<path>`, `-c <key=value>` pairs, and `--namespace=<n>` flags (a closed list of git's pre-verb global options). The first non-flag, non-`-C`-pair token is the verb. Unrecognized leading flags cause the call to throw — git itself is conservative about pre-verb flags, and so is this primitive. **Notably**: when `-C <dir>` is present, the source-tree check runs against BOTH `opts.cwd` AND the `-C` target. Either being the instar source tree causes the call to throw. This closes the bypass where a caller passes `opts.cwd: <tmpdir>` plus `args: ['-C', '<instar-source>', 'add', '-A']` (or vice versa). Belt-and-suspenders: cheap (two sub-ms calls), and avoids the subtle precedence question entirely.

**Path canonicalization (cross-review finding, GPT 5.4, 2026-04-26).** Every directory the guard inspects — `opts.cwd`, the `-C <dir>` target, and the path values in `--git-dir=<path>`, `--work-tree=<path>` — is passed through `realpathSync` before the source-tree assertion fires. This closes the symlink bypass where a caller hands SafeGitExecutor a symlink that resolves to the instar source tree but doesn't string-match it. The same canonicalization is applied inside `assertNotInstarSourceTree` itself (PR #96), so this is belt-and-suspenders at the SafeGitExecutor boundary plus the existing assertion-internal canonicalization.

**User-config alias closure (cross-review finding, Gemini 3.1 Pro, 2026-04-26).** Git supports user-configured aliases that can rebind any verb — including verbs in `READONLY_GIT_VERBS` — to an arbitrary command. A `~/.gitconfig` containing `[alias] status = clean -fdx` would let a `readSync(['status'], ...)` call execute a destructive wipe: the verb-list check passes because `status` is in `READONLY_GIT_VERBS`, but the actual command git runs is `clean -fdx`. The denylist on `SafeGitOptions.env` strips `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` from caller input but does not by itself disable the user's actual `~/.gitconfig`. SafeGitExecutor therefore ALSO INJECTS `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null` (and `GIT_CONFIG_NOSYSTEM=1` belt-and-suspenders) into every subprocess env unconditionally. This disables both global and system-level git config — including aliases, hooks-config, and core.\* overrides — for every git invocation through the funnel. Repository-local config (`.git/config`) is still read; that is a property of the repo under operation, not of the user's environment, and disabling it would break legitimate workflows. The residual surface (a target repo's local `.git/config` aliasing a read-only verb to a destructive one) is closed by the next subsection.

**`readSync` source-tree check (cross-review finding, Gemini 3.1 Pro, 2026-04-26).** The earlier draft allowed `readSync` to skip `assertNotInstarSourceTree` entirely, on the theory that read-only verbs cannot mutate. With repository-local aliases as a residual surface, that theory has a hole. `readSync` is therefore amended to ALSO run `assertNotInstarSourceTree` against the resolved targets (`opts.cwd` + `-C` target + flag targets + env-var targets) before subprocess spawn — exactly the same set of paths `execSync` checks, computed by the same canonicalization pipeline. Sub-millisecond cost; eliminates the residual surface. **Net behavior across the funnel: every git subprocess spawned through SafeGitExecutor, regardless of verb classification path or read/write mode, is preceded by an instar-source-tree check on every directory it could mutate.** The verb-list check on `readSync` becomes a defense-in-depth refinement (it still throws on a clearly-destructive verb in the read path), not the sole barrier.

#### Why a primitive, not a wrapper

`SafeGitExecutor` is the only place `execFileSync('git', ...)` and `spawn('git', ...)` may live (excluding the shim and the read path inside `readSync`). It does NOT wrap `simple-git` — instead the codebase deletes its few `simple-git` callsites in favor of SafeGitExecutor, and the `simple-git` dependency is removed from `package.json`. Rationale: leaving `simple-git` available creates a parallel destructive surface that requires its own funnel, doubling the attack surface for no benefit.

#### Interaction with existing PR #96 guard

`SafeGitExecutor.execSync` calls `assertNotInstarSourceTree` directly. The constructor wire-ins from PR #96 stay in place — they catch the case where a manager is constructed with a bad `projectDir` even before any git call is attempted. Net effect: two independent guards on the same `assertNotInstarSourceTree` primitive. A bypass of one is caught by the other.

There is no behavior change for callers who already routed through the three managers — the manager constructors still throw at construction time, exactly as before. The new behavior is only visible to callers who used `execFileSync('git', ...)` directly.

#### Escape hatch (`preVerified`)

One caller legitimately needs to bypass the guard re-check: the `destructive-command-shim` (`scripts/destructive-command-shim.js`). The shim runs `git <args> --dry-run` first to count affected files, then re-invokes for real. Both invocations target the same path; the second one re-running the source-tree check is wasted work but not wrong.

On reflection during internal review: the `preVerified` escape hatch is removed from this spec. The runtime cost of re-running `assertNotInstarSourceTree` is sub-millisecond (cached fs walk, no I/O after first call); skipping it is a premature optimization that opens a documented bypass surface. The shim simply calls `SafeGitExecutor.execSync` for its real-invocation step like every other caller, and the guard runs twice (once for the dry-run, once for the real run). The lint rule therefore has no `preVerified` exception to police, simplifying both surfaces.

The `SafeGitOptions.preVerified` field is removed from the public interface. If a future caller proves it needs a bypass, that's a spec change; today, no caller needs one.

#### Lint enforcement

New file: `scripts/lint-no-direct-git.js`. Wired into the existing husky setup (`.husky/pre-commit` and `.husky/pre-push`, both verified present at commit `1f06e99`). Pre-commit runs the lint over staged files only (cheap); pre-push runs it over the full repo (slower but catches commits that landed before the rule existed). Uses `@typescript-eslint/parser` to AST-parse `.ts`/`.js`/`.mjs`/`.cjs` files and flag:

1. Any `CallExpression` whose callee is `execFileSync` or `execSync` or `spawn` or `spawnSync` or `exec`, where the first string-literal argument is `'git'` or starts with `'git '` (or where args[0] === literal `'git'`).
2. Any `import` of `simple-git` outside `src/core/SafeGitExecutor.ts` (none should remain after migration).
3. Any direct call to `SafeGitExecutor.execSync` with `preVerified` set, outside the literal file `scripts/destructive-command-shim.js`.

Allowlist (file-level escape, requires comment justification on the file's first line `// safe-git-allow: <reason>`): `src/core/SafeGitExecutor.ts` itself, `tests/unit/SafeGitExecutor.test.ts`, `scripts/destructive-command-shim.js`. Any other allowlist entry requires a spec change.

For shell-script callers (the few `.sh` files that invoke git), a complementary grep-based check runs in pre-commit: a regex `\bgit\s+(add|commit|push|reset|rebase|...)\b` over staged `.sh` files. Hits cause a refusal unless the file is on a closed allowlist (`scripts/setup-imessage-hardlink.sh` is the current full list — none of its git uses are destructive; if it grows a destructive use, it gets ported to a Node script that uses SafeGitExecutor).

For npm scripts (`package.json`'s `scripts` section), the same regex runs over the JSON values. There are currently zero destructive-git npm scripts; the rule prevents new ones from sneaking in.

### Part 1b — SafeFsExecutor (pulled in-scope on 2026-04-26)

Parallel structure to SafeGitExecutor but for in-process filesystem destructive calls. Originally deferred as `recurrence-risking`; pulled in-scope under principal directive because an in-process `fs.rmSync(realInstarPath, { recursive: true })` from a misconfigured fixture wipes the same source tree as Incident A through a code path SafeGitExecutor never sees.

#### Surface

New file: `src/core/SafeFsExecutor.ts`. Exports:

- `safeRm(target: string, options?: fs.RmOptions): Promise<void>` — wraps `fs.promises.rm`.
- `safeRmSync(target: string, options?: fs.RmOptions): void` — wraps `fs.rmSync`.
- `safeUnlink(target: string): Promise<void>` / `safeUnlinkSync(target: string): void` — wraps `fs.unlink` / `fs.unlinkSync`.
- `safeRmdir(target: string, options?: fs.RmDirOptions): Promise<void>` / `safeRmdirSync` — wraps `fs.rmdir` / `fs.rmdirSync`.

Each function canonicalizes `target` via `realpathSync` (with the same uncreated-subdirectory bypass closure as PR #96's detector) and calls `assertNotInstarSourceTree(target)` before touching disk. On assertion failure, the function throws with the same diagnostic shape SafeGitExecutor uses; no filesystem call is made.

#### Why a parallel module instead of one combined "SafeDestructiveExecutor"

The two domains have different verbs, options shapes, and error paths. A combined module would either be ergonomically awkward (callers passing a "kind: 'git' | 'fs'" tag) or over-abstracted. Parallel modules with a shared `assertNotInstarSourceTree` primitive is the clean factoring; the assertion is the only shared concept.

#### Lint coverage for fs

The same AST lint rule (`scripts/lint-no-direct-destructive.js`, generalized from `lint-no-direct-git.js` — single name covers both surfaces) catches:

- Direct calls to `fs.rm*`, `fs.unlink*`, `fs.rmdir*` (named imports: `import { rm } from 'node:fs/promises'`).
- **Namespace-imported forms** (per Gemini cross-review finding): `import * as fs from 'node:fs'; fs.rmSync(...)` — the AST rule resolves the namespace identifier and flags member-access calls. This closes a real bypass vector that the initial draft missed.
- Aliased imports (`import { rmSync as nuke } from 'node:fs'`).
- `require('fs').rmSync(...)` and `require('node:fs/promises').rm(...)`.

The closed allowlist of files allowed to call `fs.rm*` directly: `src/core/SafeFsExecutor.ts` and the two test files that test it. Every other caller migrates.

#### Inventory

Direct destructive `fs` callsites in the repo on commit `1f06e99` (derived from grep + AST scan):

- `src/core/GitSync.ts`: `fs.rmSync(stashDir, { recursive: true })` — inside the snapshot-cleanup path. Migrate.
- `src/commands/nuke.ts`: `fs.rmSync(agentDir, { recursive: true, force: true })` — agent-directory deletion. The agent dir is not the instar source; SafeFsExecutor will pass it through. Migrate.
- `src/commands/setup.ts`: `fs.unlinkSync(legacyConfigPath)` — Migrate.
- `src/jobs/JobRunner.ts`: `fs.rmSync(tempJobDir, ...)` — Migrate.
- `src/lifeline/LifelineSnapshot.ts`: `fs.rmSync(stagingDir, ...)` — Migrate.
- `tests/**` — ~40 callsites, all in test fixtures targeting `mkdtemp` paths. Migrate in bulk; the assertion will pass for any path that isn't the instar source.
- `scripts/**` — 2 callsites in build scripts. Migrate.

Total: 47 callsites. Mechanical migration; the lint rule prevents reintroduction.

### Part 1c — CI tree-mutation detector (pulled in-scope on 2026-04-26)

Originally a separate deferred item; pulled in-scope as the third leg of "comprehensive containment of accidental source-tree mutation."

A new GitHub Actions step at the end of every test workflow:

```yaml
- name: Working-tree integrity check
  run: |
    if [ -n "$(git status --porcelain)" ]; then
      echo "::error::Test suite mutated the working tree. SafeGitExecutor / SafeFsExecutor likely bypassed."
      git status --porcelain
      git diff
      exit 1
    fi
```

Runs after `npm test`. If any tracked file changed or any untracked file appeared, the build fails. This is the final-line defense that catches anything the funnel + lint rule somehow missed (e.g. a new test fixture that AST-rule-evades by computing the function name dynamically — `fs['rm' + 'Sync']`).

This is a brittle signal-producer with build-fail authority on a structural rule (post-test working tree must be clean). Compliant with signal-vs-authority — the false-block cost is "find what mutated it"; the false-pass cost is silent bypass.

### Part 2 — Three layers preventing "out-of-scope trap" recurrence

#### Layer A — `/instar-dev` skill: deferral-honesty check

Add a new pre-Phase-1 check inside `skills/instar-dev/SKILL.md` and its enforcement script (`scripts/instar-dev-precommit.js`).

**Detection.** When `/instar-dev` is invoked with `--spec <path>`, the skill loads the spec markdown and runs an LLM-classifier pass (cheap model, Haiku-class — per the Memory entry "Intelligence Over String Matching") that asks: "Does this spec contain any deferral language? Quote each instance and label it `genuinely-out-of-scope`, `tactical-deferral`, or `recurrence-risking`." The classifier output is cached in `.instar/instar-dev-traces/spec-classifier-<sha>.json` keyed by the SHA-256 of the spec content; repeated invocations of `/instar-dev` against an unchanged spec reuse the cached classification at zero LLM cost.

The classifier prompt is deliberately constructed to resist prompt-injection from spec content: spec content is wrapped in `<spec>...</spec>` tags and the prompt explicitly instructs the model to ignore any instructions inside the tagged content. Spec authors are Echo (a trusted insider), not adversaries — but defending against accidental "ignore previous instructions" patterns in spec text is cheap and prevents future-Echo from accidentally blinding the gate by pasting a directive into a spec.

The classifier is given the rubric:

- `genuinely-out-of-scope`: the deferred item is a different problem class entirely (e.g. "kernel-level guards" in a userspace spec).
- `tactical-deferral`: the deferred item is in the same problem class but a strictly larger, more invasive implementation. The current spec's solution is sufficient on its own to prevent the named incidents.
- `recurrence-risking`: the deferred item is in the same problem class AND the current spec's solution leaves a residual surface where the original incident class can recur. **This is what PR #96's "SafeGitExecutor centralization" deferral was, in retrospect.**

**Enforcement.** For every classified item, the skill checks whether the spec contains a paired commitment-tracker entry — a structured frontmatter or in-document block that names:

- `id` (stable string, `commitment://...`)
- `owner` (an agent or human handle)
- `due-by` (ISO timestamp; for `recurrence-risking`, max **36 hours** from spec approval; for `tactical-deferral`, max **6 days**; for `genuinely-out-of-scope`, may be `unscheduled`). These caps were tightened by an order of magnitude on 2026-04-26 (down from 14 days / 60 days) on principal directive: "deadlines must have real teeth — same-class deferrals are an exception, not a routine."
- `monitoring-trigger` (an active mechanism — a job entry in `.instar/jobs.json`, an `InitiativeTracker` initiative + phase, a `CommitmentTracker` registration via `src/monitoring/CommitmentTracker.ts` (which already exists and tracks Commitments with status `pending` / `verified` / `violated` / `expired`), or a calendar-style schedule entry — that fires on `due-by` if the work hasn't shipped). The skill verifies the trigger is real by reading the named state file/registry; a string like "I'll remember" is rejected.

**Comprehensive-first stance (added 2026-04-26 on principal directive).** A `recurrence-risking` item is *not allowed by default*, even with a paired commitment. The skill refuses to proceed past Phase 0 if the spec contains any `recurrence-risking` deferral unless the spec frontmatter contains `principal-deferral-approval: [<id>, ...]` listing the exact commitment IDs the principal (Justin) has personally signed off on. Each approval requires a `rationale` block in the spec naming the engineering reason the item cannot be pulled into current scope; reasons that reduce to "this would make the PR larger" are explicitly insufficient and the skill rejects them by classifier. The default action when the skill sees a `recurrence-risking` item without principal approval is: print the item, print the rubric, surface the question "Can this be pulled in-scope?" to the agent, and abort. `tactical-deferral` items still require a paired commitment and an engineering reason but do not require per-item principal approval. `genuinely-out-of-scope` items must have an entry but may carry `unscheduled` due-by — so that "we know we deferred this" is an audit record, not an oral tradition.

The rationale: PR #96's failure mode wasn't "we forgot to track the deferral" — it was "we deferred at all, when the deferred piece left the original problem class half-open." The structural answer is to refuse the deferral category that has that property.

**Why LLM and not regex.** Per the Memory entry, regex would silently miss synonyms (e.g. "shipped in a follow-up release" reads identical to "PR2" semantically but no shared substring). The classifier is cheap, fast, and reads intent. The regex grep that exists in Layer B is the brittle signal-producer; Layer A's LLM is the smart authority. (Signal vs authority compliance: see Phase 4 of `/instar-dev`.)

**LLM-unavailable fallback (cross-review finding, Grok 4.1 Fast, 2026-04-26).** When the LLM is unreachable (rate limit, outage, missing API key, sandbox without network), Layer A degrades to a fail-CLOSED regex fallback rather than a fail-open pass-through. The fallback scans the spec for any of: `\bdefer\b`, `\bfollow[- ]?up\b`, `\bout[- ]?of[- ]?scope\b`, `\bPR\s*\d+\b`, `\bfuture\s+work\b`, `\blater\b\s+(?:PR|spec|change|work)`, `\bnext\s+(?:PR|spec|sprint)\b`. Any hit pauses the workflow with an explicit message: "LLM classifier unavailable; fallback regex matched deferral pattern '<pattern>' on line <N>. Resolve the LLM connectivity OR confirm by adding `principal-deferral-approval-fallback: <commitment-id>` to the spec frontmatter so the agent can proceed knowing the principal has reviewed the deferral manually." This makes the LLM a primary authority but not a single point of failure. The fallback's false-positive rate is high (it will flag "let's defer this discussion to a later PR" in casual prose), and that's the correct trade — false-positives cost a manual confirmation; false-negatives cost an Incident-B-class recurrence.

**Classifier hallucination override (cross-review finding, Gemini 3.1 Pro, 2026-04-26).** A separate failure mode from the unreachable-LLM case: the classifier returns a structured response that is wrong (flags a benign sentence as `recurrence-risking`). Caching by SHA-256 of spec content means trivial-edit-the-spec-to-bust-the-cache is poor UX and tempts authors toward whitespace games. The skill therefore exposes `--no-cache` / `--force-refresh` flags that re-call the LLM (still cheap — Haiku-class, ~500ms, no caching credit). If a re-run produces the same misclassification the author judges incorrect, they may add a `classifier-override:` block to the spec frontmatter naming the offending quote and the corrected classification with a one-line rationale. The override is itself an audit record visible to reviewers; abuse is detectable. This pattern (LLM authority, narrow auditable human override) follows the standard signal-vs-authority shape — narrower than "let the author dismiss the classifier whenever convenient."

**Audit logging for SafeGitExecutor / SafeFsExecutor (cross-review finding, GPT 5.4, 2026-04-26).** The `operation` label on `SafeGitOptions` was previously declared "for error messages and audit log" without specifying the audit-log surface. Concretely:

- Every call to `SafeGitExecutor.execSync`, `SafeGitExecutor.spawn`, `SafeGitExecutor.readSync`, `SafeFsExecutor.safeRm*`, `SafeFsExecutor.safeUnlink*`, and `SafeFsExecutor.safeRmdir*` appends a single JSON line to `.instar/audit/destructive-ops.jsonl` with fields: `timestamp` (ISO 8601), `executor` (`"git"` | `"fs"`), `operation` (the caller-supplied label), `verb` (for git, the resolved verb; for fs, the function name), `target` (the canonicalized path that was checked), `outcome` (`"allowed"` | `"denied"`), `reason` (on denial, the assertion failure message; on success, omitted), and `caller` (best-effort, from `Error.captureStackTrace` walking up two frames — informational, never a security boundary).
- The log file is rotated at 10 MB by the agent's existing log-rotation job; older shards live alongside the active file as `destructive-ops-<ISO-date>.jsonl`.
- Logging is fail-soft: if writing the audit line throws (full disk, ENOSPC), the destructive operation still proceeds (denial would be the wrong fail-mode for a logging failure); the failure is logged to stderr and to the agent's general error stream so it remains visible.
- The audit log is not a security control — the funnel is. The audit log is for post-incident reconstruction: when something goes wrong, "what mutations were attempted in the last hour" is the first question, and this answers it.

#### Layer B — pre-commit hook: deferral-section structural check

Add to `scripts/instar-dev-precommit.js`. Runs on staged spec files (`docs/specs/*.md`):

For each staged spec file, check whether the file contains an "Out-of-scope" / "Out-of-scope follow-ups" / "Future work" / "Deferred" / "Follow-up PR" section header (regex over markdown headings only, not body text — body mentions are Layer A's job).

If yes, the hook checks that:

1. The same commit stages a corresponding commitments file (`commitments/<spec-slug>.yaml`) OR the spec itself contains an inline `commitments:` frontmatter list.
2. Every deferred bullet under the section header has a matching commitment by `id`.

The pre-commit refuses if either check fails. Error message names the offending bullet(s).

This is a brittle signal-producer in the signal-vs-authority sense: it catches the obvious shape ("there's a heading and no commitments") and refuses commits that fail the obvious shape. It does NOT try to judge whether the deferred items are recurrence-risking — that's Layer A's job. Layer B's job is to make it impossible to commit a spec with a deferral section and no paired tracking, regardless of intent. This is correct: the cost of a false-block ("you have to add a commitment entry, even for a doc-only deferral") is small; the cost of a false-pass is another Incident B.

#### Layer C — `/spec-converge` adds "recurrence containment" reviewer angle

Add to `skills/spec-converge/SKILL.md` and its reviewer prompts:

A new reviewer perspective named `recurrence-containment`. Runs in every iteration alongside the existing security/scalability/adversarial/integration reviewers. Its mandate, in its prompt:

> For each deferred item, follow-up PR, "tracked but not scheduled" item, or scope-out clause in this spec, answer:
>
> 1. If this deferred item never ships, does the original problem class this spec addresses still recur?
> 2. If yes, is the deferral defensible by some other compensating mechanism in the current spec? (E.g. "the lint rule blocks new instances" is compensating; "we trust callers to be careful" is not.)
> 3. Is there a tracked commitment with owner + due-by in the spec for this item?
>
> Flag every item where (1) is yes and (2)+(3) are not both yes. These are illegitimate deferrals that must be either pulled in-scope or attached to a hard commitment.

The reviewer's findings flow through `/spec-converge`'s normal iteration loop. A spec cannot reach `review-convergence: converged` while any `recurrence-containment` finding is unaddressed.

The cross-model `/crossreview` reviewers (GPT, Gemini, Grok) inherit the same prompt — every external reviewer is asked the same recurrence-containment question, so the failure mode is caught even if the internal reviewer has a blind spot.

### Interactions with existing PR #96 guard (summary)

| Defense layer | What it catches | After this spec |
|---|---|---|
| Constructor wire-ins (PR #96) | Bad `projectDir` passed into `GitSyncManager` / `BranchManager` / `HandoffManager` | Unchanged — still active. Belt-and-suspenders. |
| `assertNotInstarSourceTree` primitive (PR #96) | Direct calls with the instar source tree as target | Unchanged. SafeGitExecutor calls the same primitive. |
| `SafeGitExecutor` funnel (this spec) | `execFileSync('git', ...)` and friends from anywhere — fixtures, harnesses, scripts, future code | New. |
| `lint-no-direct-git` (this spec) | Future code that bypasses the funnel | New. |
| Shell/npm grep (this spec) | Future shell scripts and npm scripts with destructive git | New. |
| Layer A (this spec) | New specs that defer same-class items without a tracked commitment | New. |
| Layer B (this spec) | Commits that contain a deferral section without paired tracking | New. |
| Layer C (this spec) | Convergence cannot complete with illegitimate deferrals | New. |

## Migration plan

### Inventory (current callsites — derived from grep on commit `1f06e99`)

The full inventory was generated by:

```
grep -rEn "execFileSync\(['\"]git['\"]|execSync\([^)]*git |spawn\(['\"]git['\"]|simpleGit\(" src/ tests/ scripts/
```

**Destructive callsites that MUST migrate to SafeGitExecutor:**

Source (`src/`):
- `src/core/GitSync.ts:1008` — already inside a guarded manager; migrate the inner `execFileSync` to `SafeGitExecutor.execSync` (passes through the same constructor guard, plus the funnel guard).
- `src/core/BranchManager.ts:535` — same disposition.
- `src/core/HandoffManager.ts:498` — same.
- `src/core/SyncOrchestrator.ts:1163` — destructive (caller-determined args); migrate.
- `src/core/WorktreeManager.ts:765` (`git -C ... branch <name>`), `:767` (`git worktree add`), `:879` (`worktree list` is read-only — `readSync`).
- `src/core/FileClassifier.ts:298` (`checkout --ours`), `:302` (`add`), `:324` (`add`) — destructive; migrate.
- `src/core/ParallelDevWiring.ts:35` (`remote get-url` — read-only — `readSync`).
- `src/core/ScopeVerifier.ts:449` (`remote get-url` — read-only).
- `src/core/ProjectMapper.ts:261, :275` (read-only).
- `src/core/AgentConnector.ts:141` (`git --version` — read-only).
- `src/server/routes.ts:2285, :3035` — both `remote get-url` style (read-only); migrate to `SafeGitExecutor.readSync` for consistency.
- `src/commands/machine.ts:285` (`git clone`) — destructive but target is always a fresh path; still must funnel.
- `src/commands/init.ts:386` (`git init`) — destructive; the shape is "create a new repo at projectDir." `assertNotInstarSourceTree` will block if projectDir IS the instar source — correct. Migrate.
- `src/commands/init.ts:3329` (`remote` listing — read-only).
- `src/commands/nuke.ts:142, :143, :150, :156, :212` — `git add -A`, `commit`, `push`, `remote`. The `nuke` flow operates on the **agent state directory**, not the instar source. SafeGitExecutor will pass these through (agent state dir is not the instar source tree). Migrate.
- `src/commands/setup.ts:114` (`rev-parse --show-toplevel` — read-only).
- `src/monitoring/WorktreeReaper.ts:208` (`worktree add`) — destructive; migrate.

Tests (`tests/`) — every fixture and harness must migrate, because Incident B was a test fixture:
- `tests/unit/branch-manager.test.ts:19,61–66`, `tests/unit/handoff-manager.test.ts:22,106–111` — fixture init/commit. Migrate.
- `tests/integration/handoff-wiring.test.ts:35`, `tests/integration/branch-wiring.test.ts:52,80–85`, `tests/integration/source-tree-guard-wiring.test.ts:144–146`, `tests/integration/rich-profile-integration.test.ts:70` — migrate.
- `tests/unit/git-sync-guard.test.ts:71`, `tests/unit/git-state-manager.test.ts:52,53,313`, `tests/unit/PostUpdateMigrator-prPipelineArtifacts.test.ts:47,202` — migrate.
- `tests/unit/WorktreeManager.test.ts:77,78,97,142,143,178,179,194`, `tests/unit/WorktreeManager-merkle.test.ts:18,27,45` — `write-tree` is read-only → `readSync`.
- `tests/e2e/branch-lifecycle.test.ts:25,234,240,324,345,359,456,570` — **the Incident-B file**. Migrate.
- `tests/e2e/compaction-harness.ts:110–112,168,176,177,188` — the Incident-B harness. Migrate.
- `tests/fixtures/two-session-harness.ts:43–48` — Incident-B fixture. Migrate.
- `tests/e2e/sync-edge-cases.test.ts:39–44`, `tests/e2e/handoff-lifecycle.test.ts:27`, `tests/e2e/sync-lifecycle.test.ts:25` — migrate.

Scripts (`scripts/`):
- `scripts/destructive-command-shim.js:105` — destructive (real invocation); migrate to `SafeGitExecutor.execSync` like every other caller. The guard re-runs (sub-ms cost) on top of the shim's own dry-run accounting; this is intentional defense-in-depth and was preferred over a `preVerified` bypass during internal review.
- `scripts/worktree-commit-msg-hook.js:41,46,61,154` — read-only (`rev-parse`, `write-tree`, `interpret-trailers`); `interpret-trailers --in-place` is destructive on a single file. The trailer hook operates on a commit-message file in `.git/COMMIT_EDITMSG` of a worktree; not on the instar source tree per se. Still migrate to `execSync` with appropriate operation label.
- `scripts/pre-push-gate.js:132`, `scripts/instar-dev-precommit.js:50,96`, `scripts/worktree-precommit-gate.js:97`, `scripts/analyze-release.js:47,50`, `scripts/check-contract-evidence.js:39`, `scripts/generate-builtin-manifest.cjs:21` — all read-only (`rev-parse`, `diff --cached`, `describe`, `status --porcelain`, `rev-list`). Migrate to `readSync`.
- `scripts/migrate-incident-2026-04-17.mjs:57` — read-only (`stash list`).

Shell scripts (`*.sh`):
- `scripts/setup-imessage-hardlink.sh` — no destructive git verbs. Stays. Lint allowlist entry.

`simple-git` imports: zero in current source after grep, and `simple-git` is NOT present as a direct dependency in `package.json` (verified on commit `1f06e99`). No removal step needed; the lint rule's `simple-git` import check is forward-looking — it prevents reintroduction.

Total destructive callsites to migrate: **~45 call lines across ~20 files**. Total read-only callsites moving to `readSync` (for consistency and future-proofing): **~30 call lines**.

### Migration order

1. Land `SafeGitExecutor.ts` + tests (independently committable; no callers yet).
2. Migrate the three managers (`GitSync.ts`, `BranchManager.ts`, `HandoffManager.ts`) — these are already constructor-guarded; the change is internal to one file each.
3. Migrate the test fixtures and harnesses (the Incident-B surface) — second commit, atomic.
4. Migrate the remaining `src/` callsites (`SyncOrchestrator`, `WorktreeManager`, `FileClassifier`, etc.).
5. Migrate the scripts.
6. Land the lint rule (`lint-no-direct-git.js`) and wire it into pre-commit + pre-push.
7. Remove `simple-git` from `package.json` (verifies all callsites migrated).
8. Land Layer A, B, C changes (instar-dev skill, pre-commit hook, spec-converge reviewer).

Each step is a separate commit, all in a single PR. Bisectability is preserved: at no intermediate commit does the lint rule reject a callsite that hasn't been migrated yet, because the lint rule is the LAST migration commit.

### Rollback

Per-commit revert. The lint rule landing last means rolling back the whole PR is `git revert <PR-merge-commit>` and shipping. SafeGitExecutor.ts becomes orphaned but inert (no callers after the revert). The PR #96 constructor guards continue functioning unchanged.

## Test plan

### SafeGitExecutor (`tests/unit/SafeGitExecutor.test.ts`)

- `execSync` against the instar source tree throws `SourceTreeGuardError` (forwarded from `assertNotInstarSourceTree`).
- `execSync` against a tmpdir succeeds and returns stdout.
- `execSync` with a non-destructive verb in args[0] throws (typo / wrong-method protection).
- `readSync` against the instar source tree succeeds (read-only is allowed everywhere).
- `readSync` with a destructive verb in args[0] throws.
- `readSync` with an ambiguous verb (`branch`) and bare `<name>` arg throws (caller must use `execSync`).
- `readSync` with `branch --list` succeeds.
- `readSync` with `-C <dir>` prefix correctly extracts the verb from args[1].
- `execSync` with `opts.cwd: <tmpdir>` AND `args: ['-C', '<instar-source>', 'add', '-A']` throws `SourceTreeGuardError` — the `-C` target is the effective working directory and is what gets guarded. (This is the explicit bypass-closure test for the args[0]==='-C' case.)
- `execSync` with `opts.cwd: <instar-source>` AND `args: ['-C', '<tmpdir>', 'add', '-A']` ALSO throws — both directories are checked; the more conservative outcome wins. (Belt-and-suspenders.)
- `spawn` returns a `ChildProcess`; guard fires before spawn.
- The `DESTRUCTIVE_GIT_VERBS` and `READONLY_GIT_VERBS` sets are disjoint.
- The shim's real-invocation path calls `SafeGitExecutor.execSync` like every other caller; the guard fires; against a tmpdir target the call succeeds.

### Lint rule (`tests/unit/lint-no-direct-git.test.ts`)

- AST: `execFileSync('git', ...)` flagged.
- AST: `execSync('git --version')` flagged.
- AST: `execSync('git status', ...)` flagged (read-only, but the lint rule still funnels — easy escape: callers use `SafeGitExecutor.readSync`).
- AST: `spawn('git', ...)` flagged.
- AST: `import { simpleGit } from 'simple-git'` flagged.
- AST: a file with `// safe-git-allow: <reason>` on line 1 is exempt.
- Shell grep: `git add -A` in a `.sh` file flagged.
- npm grep: a destructive verb in `package.json` `scripts` flagged.

### Migration (covered by existing test suites)

Every migrated file's existing tests must continue to pass unchanged. New regression test: a fixture targeting the Incident-B surface — construct a fixture with `cwd` accidentally pointing at a tmpdir-shaped-like-instar (with marker file) and verify `SafeGitExecutor.execSync` blocks. Mirror PR #96's wire-in tests but at the SafeGitExecutor layer.

### Layer A — `/instar-dev` deferral honesty

- Test fixture spec with no deferral section: skill proceeds.
- Test fixture spec with "Out-of-scope follow-ups" header containing one `recurrence-risking` item without commitment: skill blocks; error names the item.
- Test fixture spec with the same header but commitment present: skill proceeds.
- Test fixture spec with `genuinely-out-of-scope` items, `unscheduled` commitments: skill proceeds.
- Test fixture spec with a `recurrence-risking` item where the commitment's `due-by` is more than **36 hours** out: skill blocks.
- Test fixture spec with a `recurrence-risking` item present at all (regardless of commitment): skill blocks unless the spec frontmatter contains `principal-deferral-approval` for that exact `id`. Comprehensive-first stance — same-class deferrals are not allowed by default.
- Classifier robustness: synonyms ("future PR", "shipped later", "follow-up release") all detected.

### Layer B — pre-commit deferral-section check

- Spec staged with no deferral header: hook accepts.
- Spec staged with deferral header and no commitments file: hook rejects.
- Spec staged with deferral header and matching commitments file in same commit: hook accepts.
- Spec staged with deferral header and commitments file with mismatched IDs: hook rejects.

### Layer C — `/spec-converge` recurrence-containment reviewer

- Reviewer prompt invoked with a spec containing illegitimate deferral: returns finding flagged.
- Reviewer invoked with a spec where deferred item has compensating mechanism in current spec: returns CONVERGED for that item.
- Cross-model integration: same finding produced by GPT, Gemini, Grok independently on a known-bad fixture.

## Acceptance criteria

(Each is a passing unit, integration, or system test before this spec's PR ships.)

### SafeGitExecutor surface
- AC-1: All test cases under "SafeGitExecutor" above pass.
- AC-2: `simple-git` remains absent from `package.json` (verified at commit time and by the lint rule going forward).
- AC-3: `grep -rEn "execFileSync\(['\"]git['\"]|execSync\([^)]*git |spawn\(['\"]git['\"]" src/ tests/ scripts/` returns ONLY:
  - `src/core/SafeGitExecutor.ts`
  - `tests/unit/SafeGitExecutor.test.ts`
  - `scripts/destructive-command-shim.js`

  **Transitional period (until `commitment://incremental-migration` lands).** The actual destructive-callsite inventory at spec-approval time is 1025 (vs the ~167 the spec body estimated — a ~6× undercount, see `principal-deferral-approval` in the frontmatter). Migrating all 1025 callsites in the same PR as the foundation is deferred to PR #2 under principal-approved deferral with a hard 7-day deadline (`commitment://incremental-migration`, due 2026-05-03). During the transitional period the AC-3 closed-allowlist requirement is **relaxed** to a comment-marker scheme:

  - The lint rule (`scripts/lint-no-direct-destructive.js`) honors a `// safe-git-allow: incremental-migration` comment placed on the line immediately above any pre-existing direct callsite. Pre-existing callsites with this marker pass the lint rule.
  - **NEW** direct callsites without the marker are rejected — the lint rule is fully active for new code starting on PR #1's merge commit. The marker exists only to permit a finite, enumerated set of pre-existing callsites to remain in place while PR #2 migrates them.
  - The marker has an expiry: on the `due-by` date of `commitment://incremental-migration` (2026-05-03), the lint rule reverts to the strict closed-allowlist mode and any remaining markers cause violations. PR #2 removes every marker as the corresponding callsite migrates.
  - At the end of PR #2, zero markers remain and AC-3's closed-allowlist requirement is met as originally written.
- AC-4: All existing tests pass after migration with no behavior change visible to callers.

### Lint rule
- AC-5: Every test under "Lint rule" above passes.
- AC-6: The lint rule runs in `.husky/pre-commit` and `.husky/pre-push`.
- AC-7: A deliberately-introduced direct `execFileSync('git', ...)` in a feature branch is caught by the lint rule before commit.

### Layers A, B, C
- AC-8: All test cases under "Layer A/B/C" above pass.
- AC-9: A fixture spec mimicking PR #96's "Out-of-scope follow-ups" section with `SafeGitExecutor centralization` listed and no commitment: blocked by Layer A AND Layer B AND Layer C (independently verifiable).
- AC-10: This very spec (the one you are reading) passes Layers A/B/C — every deferred item below has a paired commitment.

### Recurrence regression
- AC-11: A reproduction of Incident B (a test fixture invoking `execFileSync('git', ['add', '-A'], { cwd: <instar source root> })`) — already prevented by the migration making it a `SafeGitExecutor.execSync` call which calls `assertNotInstarSourceTree` and throws. The reproduction is a regression test that lives at `tests/integration/incident-b-regression.test.ts`.
- AC-12: A reproduction of Incident A (constructing a `GitSyncManager` against the instar source) — still blocked by PR #96's constructor guard. Test inherited from PR #96's suite, must continue to pass.

## Genuine deferrals (with paired commitments — meta-section)

After the comprehensive-first pass on 2026-04-26, this spec carries only the deferrals that genuinely cannot ship in the same PR. The previously-deferred `safe-fs-extension` and `ci-mutation-detector` items have been **pulled in-scope** under principal directive — see Goals 1 and 3, and the "SafeFsExecutor" and "CI tree-mutation detector" subsections under Design. No `recurrence-risking` deferrals remain.

The commitments file lives at `commitments/comprehensive-destructive-tool-containment.yaml` and is staged in the same PR as this spec.

### Items

1. **Positive-authorization redesign (mutable-workspace capability tokens).**
   - Classification: `tactical-deferral`. The funnel + lint defense closes Incident A and B's class. The redesign would replace deny-list with allow-list, a strictly stronger model. It is a multi-week refactor that touches every component currently using `assertNotInstarSourceTree` and would dwarf this spec's PR; that's the engineering reason it cannot be pulled in-scope here.
   - Compensating mechanism: SafeGitExecutor + SafeFsExecutor + lint rule cover the surface that capability tokens would protect, modulo "callers can still pass any cwd they want." The deny-list in `assertNotInstarSourceTree` is the residual brittleness.
   - Commitment: `commitment://positive-authorization-redesign`, owner `echo`, due-by **2026-05-02** (6 days — the cap for `tactical-deferral` after the 10× tightening), monitoring trigger: an `InitiativeTracker` initiative with phases.

2. **Kernel/container guards (seccomp-bpf, AppArmor, readonly bind mounts).**
   - Classification: `genuinely-out-of-scope`. Different problem class — defense in depth at the syscall layer, orthogonal to the userspace funnel.
   - Compensating mechanism: not required. Userspace funnel + constructor guard + lint rule are independently sufficient for Incidents A and B's classes.
   - Commitment: `commitment://kernel-container-guards`, owner `unassigned`, due-by `unscheduled`, monitoring trigger: a memory entry in MEMORY.md so future-Echo sees it on session start; if a similar incident recurs that this layer would have prevented, the commitment escalates to scheduled.

3. **Adriana's autostash/rebase wipe (separate failure mode, separate spec).**
   - Classification: `genuinely-out-of-scope` for THIS spec — different failure mode (rebase eating uncommitted work on a legitimate target). PR #96 deferred it; this spec carries the deferral forward but tightens the deadline to draft a dedicated spec.
   - Compensating mechanism: tracked as its own spec, with a 2-day deadline to publish a draft (down from 19 days under the 10× tightening).
   - Commitment: `commitment://autostash-rebase-safety`, owner `echo`, due-by **2026-04-28**, monitoring trigger: a job entry.

### Self-compliance check (this spec applied to itself)

Per the new rule, this spec must demonstrate compliance with Layers A/B/C on its own deferrals. The check after the 2026-04-26 comprehensive-first pass:

- **Layer A:** zero `recurrence-risking` deferrals (down from one in the initial draft). All remaining deferrals are `tactical-deferral` or `genuinely-out-of-scope`, each with paired commitment, owner, due-by within the new tightened caps (6 days for tactical, unscheduled-with-MEMORY.md-trigger for genuinely-out-of-scope), and monitoring-trigger.
- **Layer B:** the section header "Genuine deferrals" plus the commitments file `commitments/comprehensive-destructive-tool-containment.yaml` ship in the same commit.
- **Layer C:** for each remaining deferral, "if this never ships, does Incident A or B's class recur?" Answer: **no**, for all three remaining items. The two items that previously answered "yes" (`safe-fs-extension`, indirectly through fs path; and `ci-mutation-detector`, weakly) have been pulled in-scope and are no longer deferred.

This spec is the first artifact validated by its own rule, and after the 2026-04-26 revision it passes that validation cleanly with no `recurrence-risking` deferrals carried.

## Signal vs authority compliance

Per `docs/signal-vs-authority.md`:

- **`assertNotInstarSourceTree`** (PR #96, called by SafeGitExecutor here): brittle blocker on irreversible action. Carve-out applies. Compliant.
- **Lint rule (`lint-no-direct-git`)**: brittle pattern-matcher on a structural rule (no direct git callsites). Pre-commit/pre-push refusal. Compliant — false-block cost is "use SafeGitExecutor instead," false-pass cost is Incident-B class recurrence.
- **Layer A LLM classifier**: smart authority over a brittle signal (the deferral-language detection). Compliant — this is the canonical signal-vs-authority pattern.
- **Layer B grep on heading**: brittle signal-producer with refusal authority on a structural shape (heading-without-paired-commitments). False-block cost is "add a commitment entry," false-pass cost is silent deferral. Compliant per the carve-out (irreversible-action class — silent deferrals were the input to Incident B).
- **Layer C reviewer prompt**: smart-LLM evaluation. Compliant.

## Over-block / under-block analysis

**Over-block risks:**

1. *Legitimate test fixture that happens to create a marker file in a tmpdir.* The marker file is `.instar-source-tree`; a stray creation in a tmpdir would trigger the guard. Mitigation: marker is empty, file name is specific, accidental collision is implausible. Tests can assert tmpdir absence of the marker.
2. *Read-only call accidentally classified as destructive.* The closed enumeration of `READONLY_GIT_VERBS` plus the additional shape check inside `readSync` for ambiguous verbs (`branch --list` vs `branch <name>`) handles this. False-block cost is small (use `execSync` with the right operation label).
3. *Lint rule false-positive on a string `'git'` that is not the binary.* AST inspection requires `'git'` to be the FIRST argument to a child-process function. A string `'git'` elsewhere (e.g. a comment, a config value) is not flagged.

**Under-block risks:**

1. *A caller that uses `Bash` tool from inside Claude Code to run `git ...` directly.* Not covered by this spec — the lint rule operates on staged source, not on Claude's tool calls. Compensated by `command-guard` skill (already exists, blocks high-risk shell git invocations) and by the destructive-command-shim. **NOT named as a deferral because the existing skill already covers it; this spec does not introduce the gap.**
2. *A caller that re-implements `execFileSync` via `require('child_process').execFileSync` with an alias name.* AST analysis catches the call signature (`execFileSync(...)`); aliasing breaks the analysis only if the caller also imports under a non-standard name. Mitigation: lint rule flags any direct `child_process` import outside SafeGitExecutor.ts.
3. *A WASM/native module that shells out to git.* No such module exists in the codebase today; if one is added, it is a spec change to extend coverage.
4. *A `npx`/`pnpm`/`yarn` invocation that runs a binary that runs git.* Out of scope; the funnel is for in-codebase callers.

**Abstraction fit.** SafeGitExecutor is at the call boundary — where args become a real subprocess. PR #96's constructor guard is at the manager boundary. Lint rule is at compile-time. Layers A/B/C are at the spec/governance boundary. Each layer is at a different boundary, by design — defense in depth.

**Interactions.** SafeGitExecutor is sub-millisecond on the source-tree check (cached fs walk, no network, no LLM). Layer A's LLM classifier adds a one-shot ~500ms call per spec at `/instar-dev` invocation time — not on a hot path. Layer B's grep is sub-10ms on staged file content. Layer C's reviewer adds a normal /spec-converge reviewer-round cost (already paid by every spec).

No latency-vs-client-timeout exposure (this is build-time and tooling-time machinery, not runtime user-facing).

## Rollback

- Code revert: `git revert <PR-merge-commit>`. SafeGitExecutor.ts and lint rule become orphaned/inert.
- Migration revert: every callsite that was migrated to `SafeGitExecutor.execSync` reverts to `execFileSync('git', ...)`. PR #96 constructor guards continue to fire.
- Layer A/B/C reverts: skill files and pre-commit hook entries removed. No persistent state.

A rollback ships as a hotfix within one release cycle.

## Open questions for Justin

1. **Time horizons on commitments.** The 14-day cap for `recurrence-risking` and 60-day cap for `tactical-deferral` are first-pass defaults. Reasonable, but the user may want to set the cap per commitment based on how exposed the residual surface is.
2. **`simple-git` removal.** No callsites in current grep, but `package.json` may carry it transitively. If removal causes a downstream issue, fallback is to leave the dep installed and rely on the lint rule to refuse new imports.
3. **`/instar-dev` Layer A's LLM cost.** ~500ms + a Haiku-class API call per spec gate run. Acceptable in normal usage; if `/instar-dev` is invoked many times per session this adds up. Alternative: cache the classifier output in `.instar/instar-dev-traces/` keyed by spec content hash, so repeated invocations of the same unchanged spec are free.
4. **Should the `commitments/<slug>.yaml` files live inside `docs/specs/` or at a top-level `commitments/` directory?** Current draft says top-level. If specs are the canonical home, all commitments could live as inline frontmatter. Trade-off is grep-discoverability vs co-location.

## Meta — how this spec complies with the rule it introduces

This spec contains a "Genuine deferrals" section. The rule says: every deferral must have an `id`, `owner`, `due-by`, and `monitoring-trigger`. The five deferrals above each have all four fields. The commitments file is in this PR.

The rule says: `recurrence-risking` deferrals require a max-14-day commitment. None of the deferrals above are `recurrence-risking` — each is either `tactical-deferral` (with compensating mechanism in this spec) or `genuinely-out-of-scope` (different problem class). The compensating-mechanism column is filled in for every `tactical-deferral`.

The rule says: Layer C's reviewer asks "if this never ships, does the original problem recur?" — the answer for each deferral is documented in "Genuine deferrals" above.

The rule says: Layer B's pre-commit refuses commits with deferral sections and no paired commitments file. The commitments file ships in the same commit as this spec.

This spec is the first artifact that validates its own rule.
