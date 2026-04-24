# Convergence Report — Destructive Tool Target Guards

## ELI10 Overview

Yesterday an automated test made a horrible mistake: it thought it was poking around in a throwaway scratch folder, but because of a subtle wire-up error it was actually inside the real instar source code. It ran `git add -A && git commit`, which took a snapshot of the test's tiny made-up files and overwrote the main branch of the real repo with that snapshot — 1,893 files wiped out in a single "init" commit. We recovered by force-pushing a backup, but that's a scary near-miss, and we need a structural fix so the same class of mistake can't happen again.

This spec adds a small safety guard. Every piece of instar code that can do destructive git operations will, the very first thing it does when it starts up, check: "Am I about to do this work against the real instar source tree?" If yes, it refuses. If no, it proceeds normally. The check is deliberately narrow (it only protects one specific tree — the instar source) and deliberately "dumb" (it doesn't try to be clever about intent, it just matches against a list of fingerprints). That's correct for this kind of guard: the cost of a false refusal is "type a different path and try again," and the cost of a false allow is "lose 1,893 files again." We'll take the lopsided trade.

The guard has three independent ways of recognizing the instar tree: a marker file we'll commit to the repo root, the git remote URL, and a source-code signature. Any one of them being true triggers the block. The guard also handles the tricky cases — subdirectories, symlinks, git worktrees, directories that don't exist yet — because that's exactly where yesterday's mistake lived.

## Original vs Converged

The initial draft had the right idea but was dangerous in the details, and six rounds of cross-model review found every sharp edge.

**Subdirectory bypass.** The original guard checked "is THIS directory the instar root?" A misbehaving test could pass a deeper path like `.../instar/src/whatever`, and the guard would say "nope, not the root, proceed" — while git itself, being smarter, would walk up and commit against the real repo anyway. Fixed by making the guard walk up the same way git does.

**Uncreated directories.** The original version would error out on a directory that didn't exist yet, and the easiest way to handle that error was "return false, pass." That's a disaster: a caller that passes a not-yet-existing subpath inside instar would slip through, then `mkdir` it and wipe the repo. Fixed by walking up to the nearest existing ancestor and evaluating there.

**Worktrees.** Git has a feature called "worktrees" where a second working copy of the same repo lives in a different folder. The original guard didn't handle this — a worktree has a `.git` file (not a folder) pointing at the main repo, and the guard didn't know how to follow the pointer. Fixed by parsing the `.git` file the way git does, including the exact rules about how relative paths inside it resolve (which the first two attempts got wrong).

**Fail-closed semantics.** We originally said "any error anywhere = block." That sounds safe until you realize it also means "any random unreadable file near any caller = deny-all," which would turn the guard into a denial-of-service against normal test runs. The converged spec splits into two tiers: if the guard itself can't function at all (can't even look at the filesystem), block; if one of the three detection layers can't evaluate but the other two work fine, let the working layers decide. That keeps catastrophic-uncertainty safe without turning the guard into a nuisance.

**URL normalization.** The original said "exact-string-match on remote URL." In practice, git stores URLs with trailing slashes sometimes, with or without `.git`, with or without trailing whitespace. The final spec defines minimal canonicalization (strip whitespace, one trailing `/`, one trailing `.git`) before comparing, so legitimate variants of the same URL all match.

**Inventory vs structural defense.** The original guard was hard-wired to three specific constructor classes. What if someone adds a fourth destructive git call somewhere else? The spec now requires a pre-ship grep of the source tree, classifying every git-mutating call and either routing it through one of the guarded managers or adding it to the wire-in list. Plus a follow-up PR is committed to replacing the inventory defense with a single funneled `SafeGitExecutor` primitive.

**Scope honesty.** Reviewers pushed back that this spec was being framed as THE fix, when it's really ONE layer of a deeper problem. The final spec is explicit: this is a tactical guardrail, not the ceiling. Four follow-up PRs are named (test harness hardening, CI mutation detector, Adriana's rebase fix, `SafeGitExecutor` centralization). Two longer-term items are tracked but not scheduled (positive-authorization redesign, kernel/container guards).

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | GPT (12), Gemini (4), Grok (7) | 13 unique material | Large rewrite: git-root walk, fail-closed semantics, multi-layer signature with `.git/config`, canonical-remote enumeration, "scope honesty" section, alternatives-considered, pre-ship enumeration, restructured ACs, testable wire-in criteria |
| 2 | GPT (worktree `.git`-file, fork-variant ambiguity), Gemini (ENOENT bypass on uncreated subdirs), Grok (converged) | 3 | Worktree `.git`-file parsing; nearest-existing-ancestor walk; closed canonical-remote list |
| 3 | GPT (relative-gitdir resolved against wrong base, ENOTDIR handling), Gemini (contradictory fork-list text), Grok (same 2) | 2 | Relative gitdir resolved against directory containing `.git` (not its parent); ENOTDIR treated same as ENOENT; removed contradictory "similar fork variants" text |
| 4 | GPT (common-git-dir derivation under-specified), Gemini (contradiction between "layer (b) fails closed = true" vs "other layers decide"), Grok (converged) | 2 | Exact common-git-dir rule (`if basename(dirname(gitdir)) === "worktrees" then ...`); explicit two-tier fail-closed model (detector-level vs layer-level) |
| 5 | GPT (under-block bullet stale, URL normalization missing), Gemini (converged), Grok (converged) | 2 | Under-block bullet rewritten to match two-tier semantics; URL canonicalization rules (strip whitespace / trailing `/` / trailing `.git`) with AC coverage |
| 6 | (none) | 0 | — |

**Verdict at iteration 6: CONVERGED.** All three external reviewers (GPT, Gemini, Grok) returned CONVERGED with no material findings. Total iteration count: 6.

## Full findings catalog

Every round's material findings with disposition:

### Round 1 — initial review
1. **[HIGH, GPT]** Guard is keyed to "instar source tree," not to "any protected working tree." — *Resolution:* added "Scope honesty" section stating this is a tactical fix, broader positive-authorization is scheduled follow-up.
2. **[HIGH, GPT]** Constructor-time guarding assumes three-class inventory is complete. — *Resolution:* added pre-ship enumeration requirement; `SafeGitExecutor` centralization as committed follow-up.
3. **[HIGH, Gemini]** Subdirectory bypass — guard misses when `projectDir` is inside the source tree. — *Resolution:* git-root walk added to detection logic.
4. **[HIGH, Gemini]** Unhandled sync fs exceptions (EACCES, malformed JSON) would crash constructors. — *Resolution:* fail-closed semantics added explicitly.
5. **[HIGH, Grok]** Single-file signature (`src/core/GitSync.ts` alone) is brittle. — *Resolution:* multi-file signature (two-of-N); plus `.git/config` remote URL layer.
6. **[MED, GPT]** Error message escape hatch leaked bypass instructions. — *Resolution:* error text no longer inlines bypass steps; moved to spec text.
7. **[MED, GPT]** Path normalization / symlink / canonicalization unspecified. — *Resolution:* `realpathSync` canonicalization; symlink AC added.
8. **[MED, GPT]** "First statement" AC not robustly testable. — *Resolution:* rewritten as "no collaborator side effect before throw," verified via spies.
9. **[MED, GPT]** Test-fixture sandbox hardening still deferred despite being the most direct fix. — *Resolution:* sandbox hardening PR explicitly committed to ship in the same milestone.
10. **[MED, Gemini]** `.git/config` remote URL check is more domain-appropriate than `package.json`. — *Resolution:* added as layer (b); renamed the original fallback as layer (c).
11. **[MED, Grok]** Industry alternatives (chmod -w, readonly bind mounts, seccomp) not acknowledged. — *Resolution:* "Alternatives considered" section added; kernel-layer guards tracked as orthogonal out-of-scope.
12. **[LOW→deferred, Grok]** Kernel-level defense in depth (seccomp/AppArmor). — *Resolution:* tracked, unscheduled.
13. **[LOW→addressed, multi]** Edge-case ACs missing (symlink, malformed package.json, nonexistent, worktree, submodule). — *Resolution:* expanded AC surface by category.

### Round 2 — first convergence round
14. **[HIGH, Gemini, NEW]** ENOENT bypass on uncreated subdirectories. — *Resolution:* nearest-existing-ancestor walk.
15. **[HIGH, GPT, PRIOR]** Worktree `.git`-file handling missing from v2. — *Resolution:* explicit worktree-handling subsection added.
16. **[MED, GPT, NEW]** "similar fork variants" ambiguous. — *Resolution:* closed enumeration of exactly three canonical URLs.

### Round 3 — second convergence round
17. **[HIGH, GPT/Gemini/Grok, MIXED]** Relative `gitdir:` resolved against worktree root's parent (wrong); should resolve against directory containing `.git` file. — *Resolution:* explicit rule correction with `git-worktree(1)` citation.
18. **[MED, Gemini/Grok, PRIOR]** Detection-logic prose still said "instar-fork.git (and similar fork variants)" contradicting the closed enumeration. — *Resolution:* prose rewritten to refer to the closed list.
19. **[MED, GPT, NEW]** ENOTDIR during ancestor walk not handled. — *Resolution:* ENOTDIR treated identically to ENOENT during ancestor discovery.

### Round 4 — third convergence round
20. **[MED, GPT, PRIOR]** Common-git-dir derivation ambiguous ("walk until it looks like a real .git"). — *Resolution:* exact rule: `if basename(dirname(gitdir)) === "worktrees" then commonGitDir = dirname(dirname(gitdir)); else layer (b) fails layer-inconclusive`.
21. **[MED, Gemini, NEW]** Contradiction: "layer (b) fails closed = true" vs AC saying "layers (a)/(c) still decide" — an OR with a TRUE in it is TRUE unconditionally, but ACs implied otherwise. — *Resolution:* explicit two-tier fail-closed model (detector-level vs layer-level). ACs rewritten.

### Round 5 — fourth convergence round
22. **[MED, GPT, PRIOR]** Under-block bullet still said "unreadable package.json is addressed by fail-closed semantics" — inconsistent with v5's layer-level inconclusive model. — *Resolution:* bullet rewritten to match two-tier semantics.
23. **[MED, GPT, NEW]** URL canonicalization missing for trailing slash / trailing `.git` / whitespace. — *Resolution:* minimal canonicalization rules added (strip whitespace, one trailing `/`, one trailing `.git`); AC coverage added.

### Round 6 — fifth convergence round
**No material findings.** GPT, Gemini, and Grok all returned CONVERGED.

## Convergence verdict

**Converged at iteration 6.** No material findings in the final round from any of the three external reviewers. Spec is ready for user review and approval.

Caveats for the approver:

- The spec is a **tactical** guardrail, not the full answer. Four follow-up PRs are committed to ship in the same milestone (test-harness sandbox hardening, CI mutation detector, Adriana's rebase/autostash fix, `SafeGitExecutor` centralization). If any of those four slip, the spec's own scope-honesty framing weakens.
- The pre-ship enumeration requirement (`grep -rn "simpleGit\|spawn.*['\"]git['\"]" src/`) is load-bearing for this iteration. The implementing agent must include the grep output in the PR and classify every hit. Without that, "three managers is enough" is unverified.
- The two-tier fail-closed model is subtle. Reviewer Gemini specifically flagged the "single stray unreadable file causes deny-all" anti-pattern, and the model avoids it — but implementation must carefully preserve the distinction. A test that conflates "EACCES anywhere = returns true" would enshrine exactly the over-block pathology this design rejects.
- The spec does NOT handle destructive git work launched by child processes (shell scripts, npm scripts). That surface is explicitly called out as uncovered, with a `safe-git` wrapper as a non-blocking follow-up. If the threat model includes that path, this spec alone is insufficient.
- The `ssh://git@github.com/dawn/instar.git` canonical remote URL is a conservative addition — worth verifying against `git remote -v` output on actual instar checkouts before shipping. If that form never appears in practice, it's harmless; if it does, keep it.
