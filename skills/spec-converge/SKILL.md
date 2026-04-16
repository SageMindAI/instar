---
name: spec-converge
description: Iteratively review an instar-development spec with multi-angle internal reviewers (security, scalability, adversarial, integration) and cross-model external reviewers (GPT, Gemini, Grok) until convergence, then produce a comprehensive ELI10 convergence report. Output is a spec tagged review-convergence — one of the two tags /instar-dev requires before it will touch instar source. NOT user-invocable; run by the instar-developing agent before any spec-driven /instar-dev work.
metadata:
  user_invocable: "false"
  audience: "instar-developing agent only — NOT end users"
---

# /spec-converge

**Audience:** the instar-developing agent. End users do not invoke this. Throughout this document, "the agent" refers to the instar-developing agent running the skill.

---

## What this skill does

Takes a spec file, runs multiple parallel reviewers against it, updates the spec to address their findings, runs another round, and repeats until convergence. Produces a final converged spec and a comprehensive human-readable report.

The purpose is to catch architectural, security, adversarial, scalability, and integration issues BEFORE code is written, not after. The single-reviewer pattern used by `/instar-dev`'s existing second-pass step has proven too narrow in practice — a four-reviewer parallel audit on the integrated-being ledger PR surfaced 14 serious issues that a single reviewer had missed. This skill bakes that multi-angle pattern in as the structural default for any substantive instar-dev work.

## When it runs

Before `/instar-dev` touches any instar source, the change's spec must pass through this skill. `/instar-dev`'s pre-commit hook refuses work unless:

1. The spec file has a `review-convergence: <timestamp>` entry in its frontmatter, written by this skill on successful convergence.
2. The spec file has an `approved: true` entry in its frontmatter, written by the user after reading the convergence report.

Both tags must be present. Without them, `/instar-dev` is blocked.

## Input

One argument: the path to the spec file, relative to the instar repo root.

The spec file is a markdown document with YAML frontmatter. Minimum required structure:

```markdown
---
title: "Short title"
slug: "url-friendly-slug"
author: "agent name"
---

# Title

## Problem statement
[what is being built and why]

## Proposed design
[how it works, at enough detail to review]

## Decision points touched
[any block/allow/route gates the design introduces, removes, or modifies]

## Open questions
[things that need human input]
```

The skill adds `review-convergence`, `review-iterations`, `review-completed-at`, and (if provided) `approved` fields to the frontmatter on successful convergence.

## Phases

### Phase 1 — Initial review round

The skill spawns reviewers in parallel:

**Internal reviewers (Claude subagents):**

- **Security.** Attack surfaces, leaks, privilege escalation, auth on endpoints, prompt injection vectors, rotation races.
- **Scalability/performance.** Hot-path cost, concurrent writes, memory churn, fail-open semantics, hook latency.
- **Adversarial.** Misbehaving-session scenarios — bad-entry poisoning, self-reinforcing loops, stale claims, authority ambiguity, kind gaming.
- **Integration/deployment.** Migration, backup/restore, multi-machine, config knobs, dashboard surface, rollback.

**External reviewers (cross-model, via the /crossreview pattern):**

- GPT-tier model — independent read on architecture and clarity.
- Gemini-tier model — independent read.
- Grok-tier model — independent read.

Each reviewer receives the spec, the architectural context docs referenced in the spec (`docs/signal-vs-authority.md`, `docs/integrated-being.md`, relevant subsystem docs), and a prompt specific to their perspective. Each produces a structured finding list.

All seven reviewers run in parallel. Their findings are collected.

### Phase 2 — Spec update

The skill reads all findings, groups duplicates, prioritizes by severity, and rewrites the spec to address each substantive finding. Trivial/cosmetic findings are noted but may be batched.

The spec update is ONE coherent edit of the spec document — not seven separate patches. The agent treats the findings as a single synthesis input.

Every update preserves the spec's structure. Changes are additive (new sections for new concerns) or rewrites of existing sections (when a finding reveals a design flaw).

### Phase 3 — Convergence check

After the spec is updated, the skill runs another full review round (all seven reviewers, in parallel, on the updated spec).

Convergence criterion: **the new round produces no material new issues.** "Material" means any finding that would require a spec change if unaddressed. Cosmetic findings, repeats of already-addressed concerns, and minor phrasing quibbles are non-material.

A lightweight LLM (Haiku-class) compares the new round's findings to the prior round's findings and emits a boolean `converged: true|false` with reasoning. Human-readable comparison log is retained.

**Not converged** → back to Phase 2.
**Converged** → Phase 4.

Hard cap: 10 iterations. If the skill hits 10 iterations without convergence, it exits with a `convergence-failed` status and a report explaining why. Human input is required before retry.

### Phase 4 — Convergence report

Produce a final report at `docs/specs/reports/<slug>-convergence.md` with the following structure:

```markdown
# Convergence Report — <spec title>

## ELI10 Overview

[2-3 paragraph plain-English summary of what the spec is, why it matters, what changes for users if it ships, and what the main tradeoffs are. No jargon. Assume the reader is smart but not a systems engineer. "We're adding a way for different parts of the agent to know what each other is doing..." tone.]

## Original vs Converged

[A dedicated section describing the major differences between the initial spec and the converged version, also in ELI10 terms. "Originally, any session could write anything to the ledger. After review, we restricted writes to a curated set of server-side sources because an untrusted write surface made too many attacks too easy." This section is what the user reads to understand what the review process actually changed.]

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1         | security, adversarial | 14                | ... |
| 2         | scalability           | 3                 | ... |
| 3         | (converged)           | 0                 | none |

## Full Findings Catalog

[Every iteration, every reviewer, every finding with: severity, reviewer perspective, original text, resolution taken. Structured for detail-oriented readers.]

## Convergence verdict

[Plain statement: "Converged at iteration N. No material findings in the final round. Spec is ready for user review and approval."]
```

### Phase 5 — Frontmatter tag

On successful convergence, the skill writes to the spec's frontmatter:

```yaml
review-convergence: "<ISO timestamp>"
review-iterations: <N>
review-completed-at: "<ISO timestamp>"
review-report: "docs/specs/reports/<slug>-convergence.md"
```

The `approved: true` tag is NOT written by this skill. That's the user's step.

### Phase 6 — User handoff

The skill emits the link to the convergence report via the messaging layer (Telegram or equivalent) so the user can read the ELI10 report and decide.

The skill does NOT auto-apply `approved: true`. That requires explicit human action — editing the frontmatter or running `instar spec approve <path>` (follow-on CLI command).

## What this skill does NOT do

- It does not build code. That's `/instar-dev`'s job, after both tags are present.
- It does not relax convergence criteria to avoid iteration. 10-iteration cap exists to surface "this design is too confused to review" rather than to force false convergence.
- It does not skip reviewer perspectives. All seven run on every round.
- It does not auto-approve on behalf of the user. Approval is the user's structural contribution to the process.

## Bootstrap exception

This skill itself is an instar-source change. The strict reading of the new rule would require IT to have a spec that passed through itself before it could ship. That's a chicken-and-egg loop the skill itself has to break.

Documented bootstrap exception: the first commit introducing `/spec-converge` is allowed to pass `/instar-dev`'s pre-commit gate without the spec tags, ONLY because the skill that installs the tag mechanism cannot be gated by itself. This is a one-time exception, visible in the commit history, and will not recur — every subsequent change to this skill or to anything else in instar source will require the full spec-convergence-approval chain.

## Anti-patterns the enforcement will catch

### "Just one more iteration"
The convergence check is structural. If the LLM comparator finds new material issues, iteration is required. The agent does not get to overrule this.

### "Convergence" with shrinking findings but not zero
A smaller finding count is NOT convergence. Convergence is zero material findings in a new round.

### Skipping a reviewer perspective to ship faster
All four internal reviewers AND all three external reviewers run on every round. Skipping is visible in the iteration log and fails the report validation.

### Rewriting the spec between iterations to hide findings
Spec edits must address findings, not evade them. The iteration log records both the finding and the resolution. An edit that changes the spec to make the finding "not applicable" without actually solving the concern is caught at the next review round.

### Forging the review-convergence tag
The tag is written only by this skill's Phase 5. Manual writes of the tag without going through the skill will fail `/instar-dev`'s deeper check (the report file at `docs/specs/reports/<slug>-convergence.md` must exist and match).
