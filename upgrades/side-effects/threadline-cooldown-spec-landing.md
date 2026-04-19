# Side-Effects Review — Threadline Cooldown Spec Landing

**Version / slug:** `threadline-cooldown-spec-landing`
**Date:** 2026-04-19
**Author:** echo
**Second-pass reviewer:** not required (documentation-only commit)

## Summary of the change

Lands the approved Threadline Cooldown & Queue Drain spec (v7) and its convergence report into the repo. No code changes, no runtime behavior change. Spec will gate subsequent implementation commits (the pre-commit hook refuses source commits without the `review-convergence` + `approved: true` tags that this commit carries in the spec frontmatter).

Files touched:
- `docs/specs/THREADLINE-COOLDOWN-QUEUE-DRAIN-SPEC.md` (new)
- `docs/specs/reports/threadline-cooldown-queue-drain-convergence.md` (new)

## Decision-point inventory

No runtime decision-point surface is introduced by this commit. Decision points described IN the spec will land via subsequent commits with their own artifacts.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

## 2. Under-block

No block/allow surface — under-block not applicable.

## 3. Level-of-abstraction fit

Documentation only. Lives in `docs/specs/` alongside every other design spec. Correct layer.

## 4. Signal vs authority compliance

No runtime surface, no authority, no signal. Compliant trivially.

## 5. Interactions

None at runtime. The approved spec changes the `/instar-dev` gate's decision: subsequent Threadline-cooldown-related source commits can proceed once the spec is in-tree and tagged.

## 6. External surfaces

None at runtime. The spec document itself is visible to any agent reading `docs/specs/`. This is the intended audience.

## 7. Rollback cost

`git revert` of this single commit. No state change, no migration, no dependents until implementation commits arrive.
