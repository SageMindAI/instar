---
title: "Default skills use runtime-expandable localhost port"
slug: "skill-port-dynamic-resolution"
author: "dawn"
created: "2026-04-17"
review-convergence: "2026-04-17T10:25:00.000Z"
review-iterations: 1
review-completed-at: "2026-04-17T10:25:00.000Z"
review-report: "docs/specs/reports/skill-port-dynamic-resolution-convergence.md"
approved: true
approved-by: "dawn-autonomous"
approved-at: "2026-04-17T10:25:00.000Z"
---

# Default skills use runtime-expandable localhost port

## Problem statement

`installBuiltinSkills` in `src/commands/init.ts` templates the agent's server port (from `.instar/config.json#port`) into every `http://localhost:${port}/...` URL of every generated default skill file at install time. Once the user changes their server port after install, the templated port becomes wrong. Every curl in every default skill silently fails with `ECONNREFUSED`, and the agent wastes tokens reasoning around empty responses. Observed impact: one field agent running on port 4041 had 25 hardcoded `localhost:4040` references across 11 default skills, turning ~10s reflection/health-check runs into 75s timeouts. The workaround shipped in feedback was `sed -i s/4040/4041/g` on every affected file.

## Goal

Skills must resolve the server port at skill-execute time, not at install time. A user changing `.instar/config.json#port` should not have to touch any skill file.

## Solution

Two coordinated changes:

1. **Template fix (`src/commands/init.ts`)**: Every `http://localhost:${port}/...` inside `installBuiltinSkills` (and adjacent templated helpers sharing the same file) is rewritten to emit `http://localhost:\${INSTAR_PORT:-${port}}/...`. The generated SKILL.md files therefore contain literal `http://localhost:${INSTAR_PORT:-4040}/...` — a POSIX shell parameter expansion that resolves at shell invocation time. The fallback value matches the install-time port, so no user running on the default port experiences a behavioral change.

2. **Migration (`src/core/PostUpdateMigrator.migrateSkillPortHardcoding`)**: A new idempotent migration step rewrites existing default-skill files in the user's `.claude/skills/` directory from bare `http://localhost:NNNN/` URLs to the dynamic pattern. The migration is scoped to an allowlist of the 14 canonical default-skill names; custom skills are never touched. Idempotency is enforced by a `${INSTAR_PORT:-` marker check before any regex rewrite. The original port is preserved as the fallback default, so users on the pre-migration port see no behavioral change.

Test coverage: `tests/unit/PostUpdateMigrator-skillPortHardcoding.test.ts` — 6 cases covering the rewrite path, idempotency, custom-skill preservation, fallback-port preservation, missing-file tolerance, and second-run noop.

## Known limitations

- `${INSTAR_PORT:-NNNN}` requires a shell expansion context. Any tooling that reads the skill body and extracts URL strings without running them through a shell (e.g., a static URL linter) will see the literal string, not the expanded port. No such tooling exists in-tree today, but if it is added later it must consult the shell or read `.instar/config.json#port` directly.
- The fallback value inside `${INSTAR_PORT:-NNNN}` remains the install-time port. If a user runs `export INSTAR_PORT=wrong_value`, curls will fail where previously they succeeded on the hardcoded default. Mitigation: the env var is consulted only if the user sets it; the intersection of "exported `INSTAR_PORT`" and "set it to a wrong value" is small and self-inflicted.
- The migration allowlist is static. Future default skills added to `installBuiltinSkills` must also be added to the allowlist, otherwise existing users with the new skill hardcoded will not auto-migrate. This is deliberate — the allowlist is the safety guardrail that prevents the migration from touching user-authored skills.

## Signal vs authority

This change has no block/allow surface and does not evaluate messages or agent intent. It is a structural content rewrite inside developer-process-owned files. The signal-vs-authority principle does not apply.
