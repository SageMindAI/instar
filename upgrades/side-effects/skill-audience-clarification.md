# Side-Effects Review — /instar-dev skill audience clarification

**Version / slug:** `skill-audience-clarification`
**Date:** `2026-04-15`
**Author:** Echo (autonomous followup)
**Second-pass reviewer:** not required (documentation-only change to skill prose; no runtime surface)

## Summary of the change

Updates `skills/instar-dev/SKILL.md` language so it unambiguously identifies its audience as "the instar-dev agent" (not "the user"). The skill is now explicitly labeled non-user-invocable in frontmatter, and the prose throughout uses third-person references to "the agent" where earlier drafts used second-person "you" in ways that could be read as addressing an end user.

The skill's behavior is unchanged. The enforcement hooks, artifact requirements, and phases are identical. Only the audience framing is clarified.

## Decision-point inventory

None. Pure documentation edit.

## 1. Over-block

No block/allow surface — over-block not applicable.

## 2. Under-block

No block/allow surface — under-block not applicable.

## 3. Level-of-abstraction fit

Documentation content lives alongside the skill that the documentation describes. No layering question.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

## 5. Interactions

The frontmatter change from `user_invocable: "true"` to `user_invocable: "false"` with a new `audience` field is consumed by Claude Code's skill registry and by instar's CapabilityMapper. `user_invocable: false` means Claude Code will not surface `/instar-dev` as a user-facing slash command. This matches intent: end users should never invoke this skill; the instar-dev agent will invoke it by reading `SKILL.md` directly from its filesystem (Claude Code agents with filesystem access discover skills regardless of the `user_invocable` flag — they read the `.claude/skills/` directory on session start).

## 6. External surfaces

End users who were somehow seeing `/instar-dev` in their slash-command menu (none expected, but possible if their agent was a custom variant of Echo with wider tooling) will stop seeing it. The intended users (instar-dev agents) retain full access to invoke it.

No impact on commits, artifacts, or enforcement hooks.

## 7. Rollback cost

Trivial. Revert the frontmatter `user_invocable` flag and the prose edits.

## Conclusion

Language-level clarification. Ships cleanly. Addresses a user-raised concern about ambiguity in who the skill's audience is.

## Evidence pointers

The change is pure prose + frontmatter. The test for "does it still work" is that the instar-dev agent (me, running this session) can still invoke the skill — which it can, having just used the skill to produce this very artifact.
