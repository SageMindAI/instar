# Side-Effects Review — Comprehensive Destructive-Tool Containment (PR 1/2 — Foundation)

**Version / slug:** `comprehensive-destructive-tool-containment-foundation`
**Date:** `2026-04-26`
**Author:** Echo
**Spec:** `docs/specs/COMPREHENSIVE-DESTRUCTIVE-TOOL-CONTAINMENT-SPEC.md`
**Convergence report:** `docs/specs/reports/comprehensive-destructive-tool-containment-convergence.md`
**Commitments:** `commitments/comprehensive-destructive-tool-containment.yaml`
**Approval:** `approved: true` by Justin via Telegram topic 8122 on 2026-04-26 after reading the bundled review doc.

## Summary of the change

This is the foundation half of the comprehensive containment work. It introduces two new destructive-operation funnels (`SafeGitExecutor`, `SafeFsExecutor`), a lint rule that refuses new direct destructive callsites, a CI step that catches accidental tree mutations, an audit log, and the three structural deferral-honesty layers that prevent recurrence of the "out-of-scope trap" pattern that allowed Incident B.

The migration of pre-existing direct callsites (1025 of them — 6× larger than the spec's initial estimate) is a separate PR scheduled for delivery within 7 days under principal-approved deferral with monitoring trigger (`commitment://incremental-migration`, due 2026-05-03). During the transitional period a `// safe-git-allow: incremental-migration` comment marker preserves bisectability — the lint rule blocks NEW direct callsites unconditionally; pre-existing callsites pass via marker.

## Decision-point inventory

Changes to decision points:

- **Added**: `src/core/SafeGitExecutor.ts` — single-funnel destructive git executor. Calls `assertNotInstarSourceTree` (from PR #96) against canonicalized cwd + `-C <dir>` + `--git-dir=` + `--work-tree=` targets. Strips git-redirection env vars from caller-supplied env. Injects `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_CONFIG_NOSYSTEM=1` to disable user-gitconfig alias bypasses.
- **Added**: `src/core/SafeFsExecutor.ts` — parallel funnel for in-process destructive `fs` calls (`rm`, `unlink`, `rmdir` and their sync variants). Same canonicalization + assertion pipeline.
- **Added**: `scripts/lint-no-direct-destructive.js` — AST rule blocking direct `execFileSync('git', …)`, `spawn('git', …)`, `simpleGit(…)`, `execSync('git …')` AND direct `fs.rm*`, `fs.unlink*`, `fs.rmdir*` outside the closed module allowlist. Catches namespace imports, aliased imports, dynamic require, namespace-imported forms.
- **Added**: `.github/workflows/ci.yml` working-tree integrity step at end of `unit`, `integration`, `e2e` jobs — fails build if `git status --porcelain` shows mutations.
- **Added**: `.instar/audit/destructive-ops.jsonl` audit log — every safe-executor call appends a structured JSON line (timestamp, executor, operation, verb, target, outcome, reason, caller). Fail-soft on log-write failure.
- **Added**: Layer A — `/instar-dev` skill deferral-honesty check. LLM classifier with regex fail-closed fallback. Refuses `recurrence-risking` items entirely unless `principal-deferral-approval` lists their commitment IDs. Refuses `tactical-deferral` items without paired tracked commitments. Time horizons: 36 hours / 6 days (10× tightened from initial 14d / 60d on principal directive).
- **Added**: Layer B — pre-commit hook deferral-section structural check (extends `scripts/instar-dev-precommit.js`). Refuses commits with "Out-of-scope follow-ups" section header but no paired commitments file.
- **Added**: Layer C — `/spec-converge` "recurrence-containment" reviewer angle. Two questions per deferred item: "if this never ships, does the original problem recur?" and "is there any way this could be done in current scope, even at the cost of a larger PR?"
- **Added**: 53 new unit tests covering SafeGitExecutor + SafeFsExecutor + lint-rule bypass closures, plus regression tests reproducing Incident A and Incident B at the new funnel level.
- **Modified**: 570 pre-existing destructive callsites carry the `// safe-git-allow: incremental-migration` marker as a transitional pass-through. Lint rule honors the marker until the migration commitment lands.
- **Allowlist (transitional)**: `src/messaging/imessage/IMessageAdapter.ts` and `src/messaging/imessage/NativeBackend.ts` are added to the lint ALLOWLIST as transitional entries (not per-line markers) so that the foundation PR does not modify adapter source files. This keeps the pre-push adapter contract test gate from triggering on what would otherwise be no-op marker comments. PR #2 (commitment://incremental-migration, due 2026-05-03) migrates these `fs.unlinkSync` calls through `SafeFsExecutor` and removes the entries.

## Roll-up verdict across the seven review dimensions

1. **Over-block**: minimal. The marker mechanism is intentionally transitional — pre-existing callsites pass via marker; new ones are refused unconditionally. False-block cost on a new caller is "use the safe executor"; the cost trade is correct.
2. **Under-block**: known transitional surface — pre-existing direct callsites can still hit the source tree if a fixture passes a misconfigured cwd. Compensating mechanisms during the transitional period: PR #96's three-class constructor guard catches manager-class instantiation; the new CI tree-mutation detector catches anything that mutated the working tree post-test; the migration commitment has a 7-day hard deadline with automatic Telegram notification on the due date.
3. **Level-of-abstraction fit**: appropriate. Funnels at the right layer (single chokepoint per domain). Lint at the right layer (compile-time AST rule). CI detector at the right layer (post-test integration). Layers A/B/C at the developer-process layer.
4. **Signal-vs-authority compliance**: compliant. `assertNotInstarSourceTree` is the authority (carve-out applies — irreversible action class). Lint rule is brittle pattern-matcher with refusal authority on a structural rule. Layer A LLM is smart authority; Layer B grep is brittle signal-producer; Layer C reviewer prompt is smart-LLM authority. All within carve-out.
5. **Interactions**: tested. 53 new tests pass. Three pre-existing test failures (`agent-registry.test.ts:271,287`, `ListenerSessionManager.test.ts:359`) verified to fail on baseline commit `1f06e99` before any changes — not introduced by this work. One flaky E2E (`tunnel-private-view.test.ts`) passes in isolation, fails in full-suite ordering — pre-existing flakiness. Other test suites unaffected.
6. **External surfaces**: lint rule extends pre-commit and pre-push gates (developer-process surface, not user-runtime). CI workflow gains a post-test step (CI surface, not user-runtime). No user-runtime API changes. Audit log is local, gitignored, and informational only.
7. **Rollback cost**: low. Per-commit revert restores prior state. No persistent state mutations beyond the new audit log file (which is informational and gitignored). The marker comments are pure no-ops — removing them is mechanical.

## Second-pass review

External cross-model review across GPT 5.4, Gemini 3.1 Pro, Grok 4.1 Fast. All three returned 8–9/10 CONDITIONAL. Eleven material findings between them, all addressed in spec before approval:

1. Env-var redirection bypass closure (GPT)
2. User-gitconfig alias bypass closure via `readSync` source-tree check + `GIT_CONFIG_GLOBAL=/dev/null` injection (Gemini)
3. Namespace-import lint coverage (Gemini)
4. `write-tree` reclassified read-only (GPT)
5. Path canonicalization on `cwd`/`-C`/`--git-dir`/`--work-tree` (GPT)
6. `format-patch` shape check (Grok)
7. LLM-unavailable fail-closed regex fallback (Grok)
8. Classifier hallucination override path (Gemini)
9. Audit logging (GPT, Grok)
10. Self-compliance contradiction → pulled `safe-fs` and `ci-mutation-detector` in-scope (Gemini)
11. Comprehensive-first stance + 10× time-horizon tightening (principal directive)

Synthesis at `~/.instar/agents/echo/.claude/skills/crossreview/output/20260426-131003/synthesis.md`. Convergence report Round 4 documents per-finding disposition.

## Evidence pointers

- 53 new unit tests in `tests/unit/SafeGitExecutor.test.ts`, `tests/unit/SafeFsExecutor.test.ts`, `tests/unit/lint-no-direct-destructive.test.ts`. All passing.
- Incident A regression test at `tests/integration/incident-a-fs-regression.test.ts` — verifies in-process `fs.rmSync(realInstarPath, …)` is blocked.
- Incident B regression test at `tests/integration/incident-b-regression.test.ts` — verifies test-fixture-shape `execFileSync('git', ['add', '-A'], { cwd: <instar source root> })` is blocked.
- Cross-review raw outputs at `~/.instar/agents/echo/.claude/skills/crossreview/output/20260426-131003/{gpt,gemini,grok,synthesis}.md`.
- Spec frontmatter records `approved: true`, `approved-by: justin`, `approved-at`, and `principal-deferral-approval` for `commitment://incremental-migration`.
- Commitments file lists three remaining deferrals (positive-authorization-redesign, kernel-container-guards, autostash-rebase-safety) plus the new incremental-migration with 7-day deadline. All non-`unscheduled` items have automatic Telegram-notification job triggers.

## Migration deferral — explicit principal-deferral-approval

Justin approved the incremental-migration deferral via Telegram topic 8122 on 2026-04-26 after acknowledging the scope-reality mismatch (spec estimated ~167 callsites; actual 1025). The deferral is recorded in the spec frontmatter under `principal-deferral-approval` with full rationale. The 7-day cap is a principal-approved override of the standard 36-hour `recurrence-risking` cap, justified by the engineering reality that 1025 mechanical migrations + their full-suite test verification cannot ship in a single PR without unacceptable risk of subtle test breakage and an extended no-progress window.

This is the first real exercise of the new commitment-tracker infrastructure. The migration PR (PR 2/2) follows this one in the same session.
