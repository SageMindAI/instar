# Convergence Report — fix-better-sqlite3.cjs: use process.execPath, not PATH's node

## ELI10 Overview

Instar agents ship with a little self-heal script. When the agent starts up and finds its database library is broken (the wrong version for the Node it's running), the script downloads the right one, tests it, and if that fails, tries to compile it from scratch.

The script had a subtle bug: it was asking "which Node am I running?" the wrong way. It was saying "whatever `node` means on this computer right now" instead of "the Node that's literally running me right now." On most computers those are the same thing. On any computer that has multiple Node versions installed — which is basically every developer's laptop and a decent chunk of production servers — they can be different. When they're different, the script would download the right database library, test it against the *wrong* Node (which failed), give up, compile a *wrong* version from scratch, test it against the same wrong Node (which passed), and declare victory. Then the actual agent would try to load it and crash silently, dropping into a crippled mode where it couldn't remember conversations or search its own memory.

The fix: ask the question correctly. Use the exact Node binary that's running the script (`process.execPath`), not whatever's first on the system's PATH. The fix is about 50 lines of code change, 6 new tests, and a lot of documentation about edge cases and things we're explicitly NOT fixing in this PR.

## Original vs Converged

The original spec was already a concrete, well-scoped fix. Review surfaced three changes worth calling out in plain English:

**Added a self-check.** After the round-1 "stale execPath" finding, we added a 20ms sanity probe: spawn a child process using `process.execPath`, ask *it* what Node ABI it reports, and confirm it matches the parent. If a Node binary somewhere got replaced while the server was running (rare but possible), this catches it and bails loudly instead of producing another silently-wrong binary. This closed a ~1% edge case.

**Made "who's broken" vs "who self-heals" explicit.** Original remediation said "agents self-heal automatically, no operator action needed." A reviewer pointed out this contradicts the loop-breaker (once a tuple hits `source-failed`, the script refuses to retry until the operator deletes a state file). Resolution: the contradiction isn't real for *this* bug's victims. This bug produced `source-ok` false positives, not `source-failed`. Agents hit by this bug DO self-heal on the patched release. Agents in `source-failed` were already in the manual-fix path before this PR. We spelled this out so it can't be misread as a blanket "everything auto-heals" claim.

**Enumerated deferred items.** Review surfaced seven adjacent concerns — UpdateChecker has the same bug shape, there's no signature verification on prebuild downloads, the tmpfile path is predictable, no file-lock for concurrent recovery, no structured telemetry, no end-to-end CI, no air-gapped-environment doc. None are blockers for this fix. All are now named explicitly with justification so they aren't silently forgotten.

No design flaws were found that required reworking the approach. All seven reviewers (4 internal perspectives + 3 external models) converged on "the fix is correct; clarify the docs and add one small defensive check."

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1         | security, scalability, adversarial, integration, GPT, Gemini, Grok | 9 material (1 HIGH, 5 MEDIUM, 3 LOW) | Added `verifyChildAbiMatches` probe; strengthened tests from 3 to 6; enumerated 7 deferred items; added Platform Scope; added Remediation-for-affected-agents; added Caller Invariants; added trust-assumption paragraph on PATH prepend |
| 2         | security, scalability, adversarial, integration | 0 material — all four concurred convergence | (none) |
| Cross-model  | GPT (8/10 CONDITIONAL), Gemini (9/10 APPROVE), Grok (9/10 APPROVE) | 3 spec-clarity items, 0 correctness bugs | Fixed test-count inconsistency (11→14); added npmCli-resolution clarity paragraph; added Remediation "distinction matters" clarification; added two new deferred items (observability, network assumptions) |
| Final     | (converged) | 0 | none |

## Full Findings Catalog

### Round 1 — Internal

**Security (none critical; 4 low):**
- Net improvement from eliminating PATH-hijack on `testBinary` — addressed by construction.
- Future-risk of `-e` payload interpolation — addressed via structural injection-guard test.
- PATH-prepend trust assumption — addressed via explicit trust-assumption paragraph.
- Pre-existing: prebuild signature verification, tmpfile predictability — both deferred with named scope.

**Scalability (1 medium, 2 low):**
- Concurrent recovery race unaddressed, "per-package" overstated — deferred with named scope.
- Hot-path positioning — addressed with "zero steady-state cost" note.
- Fail-closed on bad execPath — addressed by `verifyChildAbiMatches` bailing with operator message.

**Adversarial (1 HIGH, 3 medium, 2 low):**
- HIGH: stale `process.execPath` via symlink upgrade mid-session — addressed by `verifyChildAbiMatches` probe.
- MEDIUM: `source-failed` permanent lockout on transient compiler state — deferred with operator workaround documented.
- MEDIUM: CLI-spawned script can poison shadow-install binary — addressed by caller-invariants section (grep-verified: only postinstall + ensureSqliteBindings invoke this script).
- MEDIUM: structural regression tests regex-gameable — addressed by adding positive export canary and behavioural test.
- LOW: NODE_OPTIONS env inheritance — noted as "game-over if parent compromised."
- LOW: UpdateChecker ordering hazard — addressed with explicit ordering-hazard paragraph in deferred section.

**Integration (2 medium, 5 low):**
- MEDIUM: fleet remediation clarity — addressed with Remediation-for-affected-agents section.
- MEDIUM: no end-to-end CI — deferred with named scope.
- LOW: Windows scope — addressed with Platform Scope section.
- LOW: NEXT.md entry — tracked; non-blocking; will add in ship commit.
- LOW: findNpmCli shadow-install verification — addressed with npmCli-resolution clarity paragraph.
- LOW: Node version matrix — covered under Platform Scope.
- LOW: launchd chain confirmation — confirmed safe via spec prose.

### Round 2 — Internal

All four internal reviewers returned "No new material findings — concur with convergence" on the updated spec. One non-material observation from an adversarial reviewer (5s child-probe timeout might be short on loaded machines; a 15s bump or single retry would cover it) — tracked for a trailing polish PR, not blocking.

### Cross-model — External

- **GPT 5.4 (8/10 CONDITIONAL):** 5 critical issues. Material subset: test-count inconsistency (fixed), verifyChildAbiMatches value narrowing (spec already uses "defence in depth" / "sanity check" language; re-verified adequate), PATH-prepend blast radius (trust-assumption section already present; ownership-check hardening noted as potential follow-up). Non-material: observability gap (added to deferred), UpdateChecker churn (already in deferred).
- **Gemini 3.1 Pro (9/10 APPROVE):** 2 critical issues. Material subset: remediation vs loop-breaker "contradiction" (resolved via Distinction-Matters clarification — the two populations are disjoint), npmCli resolution ambiguity (addressed with explicit npmCli-resolution paragraph; the code was already correct, just undocumented).
- **Grok 4.1 Fast (9/10 APPROVE):** No critical issues. Recommendations are post-merge enhancements (telemetry, timelines for deferred items, Docker CI).

## Convergence verdict

**Converged after 2 internal iterations + 1 cross-model round.** No material findings in the final internal round. External models unanimously found no correctness issues; all critical items from the external round were documentation clarifications now applied. Spec is ready for user review and approval.

The change is LOW-RISK per the spec's own classification (recovery helper, no decision-point surface, no external-surface change, pure code + structural tests, idempotent rollback). Convergence achieves a precisely-scoped fix with 7 explicitly-named deferred items that prevent scope creep without losing visibility.
