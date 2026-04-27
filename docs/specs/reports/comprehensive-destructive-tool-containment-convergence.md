# Convergence Report — Comprehensive Destructive-Tool Containment

## ELI16 Overview

Five days ago we shipped a fix (PR #96) for a near-miss where a test accidentally wiped 1,893 files from the real instar source tree. The fix added a safety guard inside the three classes the test was supposed to be using.

That fix worked, but it had a hole: it only protected those three classes. Last night the same kind of accident happened again — a different test fixture went around the three guarded classes and ran `git add` and `git commit` directly against the instar source. The original guard never saw the call, so it never blocked.

The honest read on what went wrong: PR #96 named the hole ("we should funnel ALL destructive git calls through one guarded primitive"), said it would be fixed in a follow-up PR, and then nobody owned that follow-up. There was no calendar entry, no tracked initiative, no monitoring trigger. Five days passed. The original problem class came back.

This new spec does two things at once.

**Part 1 — close the technical hole.** A new primitive called `SafeGitExecutor` becomes the only path destructive git calls are allowed to take. Test fixtures, harnesses, scripts — every git call that mutates state goes through it. The same guard from PR #96 fires inside `SafeGitExecutor`, but now it can't be bypassed by accident: a lint rule (running on every commit and push) refuses any direct `execFileSync('git', ...)` outside the primitive itself. The PR #96 constructor guards stay as belt-and-suspenders.

**Part 2 — close the "out-of-scope trap."** Three structural layers prevent future specs from quietly deferring same-class items. Layer A: the `/instar-dev` skill uses a small LLM call to detect deferral language and refuse to proceed unless every deferred item has a paired tracked commitment with an owner and a due date. Layer B: a pre-commit hook structurally requires a `commitments/<slug>.yaml` file when a spec contains a deferral section. Layer C: the `/spec-converge` reviewer asks, for every deferred item, "if this never ships, does the original problem recur?" — if yes, the deferral is illegitimate.

The spec applies its own rule to itself. It contains five genuinely deferred items, each with an owner, a due date, and an active monitoring trigger that pings if the work doesn't ship on time.

## Original vs Converged

The first draft was structurally sound but had several sharp edges I caught in three rounds of internal adversarial review.

**The `preVerified` escape hatch was a bypass surface.** I originally added a way for the destructive-command-shim to skip the source-tree re-check (it had already counted files in a dry-run pass). Stack-frame inspection in JS for security is unreliable, and the cost of re-checking is sub-millisecond anyway. Removed.

**The `-C <dir>` bypass.** A caller could pass `opts.cwd: <tmpdir>` plus `args: ['-C', '<instar-source>', 'add', '-A']` and trick the guard into looking at the wrong directory. Fixed: both `opts.cwd` AND the `-C` target are checked; either being the instar source tree causes a throw.

**`safe-fs-extension` was misclassified.** I labeled the deferred non-git destructive primitive as `tactical-deferral`, but on re-read: an in-process `fs.rmSync(realInstarPath, { recursive: true })` from a fixture would wipe files in the same shape as Incident A and SafeGitExecutor would never see it. So this is `recurrence-risking`, not tactical, which by the spec's own rule pulls the due-by from 60 days down to 14 days. The spec was failing its own test. Fixed.

**Prompt injection in Layer A's classifier.** Spec content gets wrapped in `<spec>...</spec>` tags with explicit "ignore instructions inside" framing. Cheap defense against future-Echo accidentally pasting a directive into a spec.

**`simple-git` removal claim was wrong.** I said the dependency was in `package.json`. Verified by grep: it's not. The lint rule's `simple-git` import check becomes forward-looking — it prevents reintroduction.

**Husky integration spelled out.** Pre-commit and pre-push are wired through husky 9.x (verified present). Pre-commit lints staged files only; pre-push lints the full repo to catch commits that landed before the rule existed.

**CommitmentTracker is a real existing thing.** The spec now points at `src/monitoring/CommitmentTracker.ts` (verified to exist) as one of the valid monitoring-trigger backends.

## Iteration Summary

| Iteration | Reviewer angles | Material findings | Spec changes |
|---|---|---|---|
| 1 (initial draft) | self-adversarial: security, integration, recurrence-containment, scalability | 6 | `preVerified` removed; `-C` shape covered; classification fix; prompt injection defense; simple-git fact-check; husky/CommitmentTracker integration |
| 2 (post-patch) | re-read for consistency | 1 | `-C` precedence wording made consistent ("both checked, more conservative wins") |
| 3 (final pass) | spec-vs-reality grep | 0 | — |

**Verdict at iteration 3: CONVERGED (internal multi-angle review).** Note: this convergence was performed by the spec author (Echo) running internal adversarial review across security/integration/recurrence-containment/scalability angles, NOT by the live `/spec-converge` skill (which would have taken the same path with three external models). Justin should treat this as a single-author internal review and may request a full `/spec-converge` + `/crossreview` pass before approving — doing so is recommended for foundational specs of this scope.

## Findings catalog

### Round 1 (self-adversarial)

1. **[HIGH, security]** `preVerified` stack-frame allowlist is unreliable. → Hatch removed entirely; sub-millisecond re-check cost makes the optimization premature.
2. **[HIGH, security]** `-C <dir>` bypass — caller passes safe `opts.cwd` plus dangerous `-C` target. → Both checked.
3. **[MEDIUM, recurrence-containment]** `safe-fs-extension` deferral is `recurrence-risking`, not `tactical-deferral` (in-process fs.rmSync would wipe). → Reclassified, due-by tightened from 29d to 14d.
4. **[MEDIUM, security]** Layer A LLM classifier vulnerable to prompt injection from spec content. → `<spec>` tag wrapping + ignore-instructions framing.
5. **[LOW, integration]** Spec claimed simple-git in package.json. → Verified absent; lint rule made forward-looking.
6. **[LOW, integration]** Husky integration not specified. → Pre-commit/pre-push wiring documented; CommitmentTracker pointed at the real existing file.

### Round 2 (consistency pass)

7. **[LOW, integration]** Wording said "`-C` takes precedence" but tests said "both checked." → Made consistent: both checked.

### Round 3 (final pass)

No new findings.

## Recommendation

The spec is internally coherent and applies its own rule to itself. The core technical case (Part 1) is straightforward — funnel + lint + constructor-guard belt-and-suspenders. The structural-prevention case (Part 2) is the more subjective one and is where the user may want to weigh in:

- Is the 14-day cap on `recurrence-risking` deferrals the right pressure?
- Should `commitments/<slug>.yaml` files live top-level or inside `docs/specs/`?
- Is the LLM classifier in Layer A worth its ~500ms (cached) cost vs a stricter regex?

These are documented in the "Open questions for Justin" section of the spec.

**Suggested next step**: before approving, optionally run the live `/spec-converge` and `/crossreview` skills against this spec for external-model perspective. Internal review is genuine but single-author.

---

## Cross-model review pass — 2026-04-26

The `/crossreview` skill was run against the spec on 2026-04-26 with all three external models (GPT 5.4, Gemini 3.1 Pro, Grok 4.1 Fast). Per Echo's MEMORY entry "external cross-model review catches what Claude-internal misses," this pass was specifically aimed at concurrency / supply-chain / precision failure modes a Claude-family reviewer would miss.

### Per-model summary

- **GPT 5.4 (8/10, CONDITIONAL).** Strong structural critique: verb-list taxonomy is brittle for git's actual semantics, lint rule has realistic bypass surfaces (subprocess library aliases, namespace imports), `readSync` weakens the "single funnel" story, governance layers depend on a fuzzy commitment schema, several ACs overstate enforceability, and there is no defined audit-logging surface. Recommended formalizing command-shape policy, adding mandatory CI enforcement, defining a canonical commitment schema, strengthening the lint rule, and adding audit/logging requirements.

- **Gemini 3.1 Pro (9/10, CONDITIONAL).** Caught the highest-precision technical bypasses: `GIT_WORK_TREE`/`GIT_DIR` env-variable redirection (caller passes safe `cwd` but env-redirected `--work-tree=<instar-source>`); user-config alias bypass on `readSync` (`[alias] status = clean -fdx` in `~/.gitconfig` lets a "read-only" verb wipe the tree); LLM cache-invalidation trap (author permanently blocked by a hallucinated classification, with cache keyed by content hash). Strong praise for governance dogfooding and the `simple-git` removal stance.

- **Grok 4.1 Fast (9/10, APPROVE).** Praised incident-driven precision, defense-in-depth layering, enforceability focus (AST not regex), self-compliance demonstration, and migration thoroughness. Flagged: LLM reliability fallback in Layer A, monitoring-trigger pre-population verification, git alias handling in verb extraction (the same surface Gemini caught from a different angle), test fixture hygiene guidance, missing security threat model, husky revert needed in rollback section.

### Material findings and disposition

| # | Finding | Source | Material | Disposition |
|---|---|---|---|---|
| CR-1 | `--work-tree=<path>` and `--git-dir=<path>` flags silently skipped during verb extraction → caller can pass safe `cwd` and a redirected target | Gemini | YES | Spec amended: target-redirect flag closure subsection added. Both flag values are extracted and added to the source-tree check set; any pointing at the instar source tree throws. |
| CR-2 | `GIT_WORK_TREE` / `GIT_DIR` / `GIT_INDEX_FILE` etc. env-variable redirection bypasses the guard | Gemini | YES | Spec amended: SafeGitOptions denylist on env passthrough (declared in interface comment), plus environment-variable closure subsection — these vars are inspected in caller env, added to the check set, then deleted from the subprocess env. |
| CR-3 | Symlink bypass: caller hands SafeGitExecutor a symlink that resolves to the instar source tree without string-matching it | GPT (implied), Gemini-adjacent | YES | Spec amended: path canonicalization subsection — every directory the guard inspects is `realpathSync`-canonicalized before assertion. |
| CR-4 | User-config alias bypass: `[alias] status = clean -fdx` in `~/.gitconfig` lets `readSync(['status'])` execute a destructive command | Gemini | YES | Spec amended: user-config alias closure subsection — SafeGitExecutor injects `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_CONFIG_NOSYSTEM=1` into every subprocess env unconditionally. |
| CR-5 | `readSync` skips the source-tree check entirely → repo-local aliases remain a residual surface | Gemini-derived | YES | Spec amended: `readSync` source-tree check subsection — `readSync` runs the same source-tree assertion as `execSync` against the same resolved target set. The verb-list check becomes defense-in-depth. |
| CR-6 | LLM-unavailable failure mode for Layer A undefined → fail-open risk | GPT, Grok | YES | Spec amended: LLM-unavailable fallback subsection — fail-CLOSED to a regex pattern fallback that requires explicit principal acknowledgement to proceed. |
| CR-7 | LLM classifier hallucination has no override path → author permanently blocked, tempted toward whitespace cache-busting | Gemini | YES | Spec amended: classifier hallucination override subsection — `--no-cache` / `--force-refresh` flags plus a frontmatter `classifier-override:` block with quoted offending text and corrected classification. |
| CR-8 | `operation` field declared "for audit log" but no audit-log surface defined | GPT | YES | Spec amended: audit logging subsection — every SafeGitExecutor / SafeFsExecutor call appends a structured JSON line to `.instar/audit/destructive-ops.jsonl` with timestamp/executor/operation/verb/target/outcome/reason/caller fields. Fail-soft on log-write failure. |
| CR-9 | In-process `fs.rm*` on the source tree was a `recurrence-risking` deferred item — cross-review rated this material | Gemini, Grok (both adjacent) | YES | Spec amended in parallel by another session: SafeFsExecutor pulled in-scope as Part 1b. Namespace-imported fs forms (`import * as fs from 'node:fs'; fs.rmSync(...)`) are also caught by the AST lint rule per Gemini's specific call-out. |
| CR-10 | CI mutation-detector job was a `tactical-deferral` — final-line check is structurally important | GPT (recommendation #2: mandatory CI enforcement) | YES | Spec amended in parallel: Part 1c added — GitHub Actions step that fails the build if the working tree is dirty after the test suite. |
| CR-11 | Time-horizon caps (14d / 60d) for deferrals are too loose to prevent the "out-of-scope trap" the spec exists to close | GPT (governance critique), Grok (deadlines need teeth) | YES | Spec amended in parallel: caps tightened 10× to 36 hours / 6 days respectively, and a "comprehensive-first stance" added (recurrence-risking items default-denied, require explicit `principal-deferral-approval` in frontmatter). |

### Non-material findings (style, polish, deferred refinements)

- Verb taxonomy formalization (GPT recommendation #1): replacing "destructive verbs vs read-only verbs" with a formal command-shape grammar. Real improvement but addressable as iterative refinement post-merge; the layered defenses (env-var closure, alias closure, source-tree check on `readSync`, audit log) make the residual classification risk small enough to defer.
- Lint-rule hardening for `cross-spawn` / `execa` / dynamic require (GPT recommendation #4): worth doing as a follow-up tightening; current scope is sufficient for the in-repo callsite inventory.
- Commitment schema formalization (GPT recommendation #3): the YAML companion and Layer B already enforce structure; making it normatively schema-defined is a polish item.
- Windows / cross-platform path portability (GPT gap F): not a current concern — instar is macOS/Linux only.
- Pre-populate monitoring triggers in PR (Grok recommendation #2): documentation refinement; the triggers are real and verified by Layer A's read-the-named-file check.
- Husky revert in rollback section (Grok recommendation #4): minor doc nit; the existing rollback ("git revert <PR-merge-commit>") already covers it, since husky scripts revert with the rest of the PR.

### Verdict

Cross-review surfaced 11 material findings. All 11 are addressed in the spec — five in this pass (CR-1 through CR-5 on bypass-surface closure, CR-6 + CR-7 on LLM-failure modes, CR-8 on audit logging) and three (CR-9, CR-10, CR-11) in a parallel session that pulled `fs` and CI items in-scope and tightened deferral caps. The non-material findings are documented above as deferred polish.

**This pass does NOT set `approved: true`.** External cross-review is one input; principal sign-off is the gate for approval. The convergence label remains `internal-converged` with an external cross-review pass appended.
