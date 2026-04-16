# Convergence Report — {{SPEC_TITLE}}

**Spec:** [{{SPEC_PATH}}]({{SPEC_PATH}})
**Slug:** `{{SPEC_SLUG}}`
**Converged at:** {{CONVERGED_AT}}
**Iterations:** {{ITERATION_COUNT}}
**Final-round material findings:** 0

---

## ELI10 Overview

<!--
Two or three paragraphs in plain English. No jargon. Tell the user:
1. What this spec is (the problem it solves, the design it proposes)
2. Why it matters — what changes for users if it ships
3. The main tradeoffs — what this design does well and what it deliberately doesn't do

Tone: "We're adding a way for different parts of the agent to know what each
other is doing, because right now the user-facing session and the session
handling agent-to-agent messages are blind to each other..."

Assume the reader is smart but not a systems engineer. The user should be able
to read this section alone and decide whether to approve.
-->

## Original vs Converged

<!--
A dedicated section describing what the review process changed, also in
ELI10 terms. This is the most important section for the user to read.

Structure as: "Originally the spec said X. After review, it now says Y,
because [plain-English reason]."

Cover the 3-6 most significant changes. Skip cosmetic/minor ones. If a
major redesign happened, put that first.

Example:
  - Originally: any session could write anything to the ledger.
    After review: writes are restricted to a curated set of server-side
    sources. Why: untrusted writes made adversarial scenarios (session
    writing false commitments, poisoning context) too hard to defend
    against — the safer default is "read-only to sessions, writes only
    from infrastructure the user controls."

The user reads this section to understand what convergence changed.
-->

## Iteration Summary

| Iteration | Reviewers who flagged material issues | Material findings | Spec sections changed |
|-----------|---------------------------------------|-------------------|-----------------------|
{{ITERATION_TABLE}}

## Full Findings Catalog

<!--
Structured dump for detail-oriented readers. Organize by iteration,
then by reviewer perspective. For each finding: severity, reviewer,
original finding text, resolution taken.
-->

{{FINDINGS_CATALOG}}

## Convergence Verdict

{{CONVERGENCE_VERDICT}}

<!--
Plain statement: "Converged at iteration N. The final review round
produced zero material findings. Spec is ready for user review and
approval. To approve: edit the spec's frontmatter to set approved: true
(or run `instar spec approve {{SPEC_SLUG}}`), then /instar-dev can
proceed with implementation."
-->
