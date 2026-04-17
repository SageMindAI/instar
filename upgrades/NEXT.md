# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Default skills now use a runtime-expandable `${INSTAR_PORT:-NNNN}` pattern in
their `http://localhost:PORT/...` URLs instead of a port hardcoded at install
time. This unblocks agents whose server runs on a non-default port.

**Background**: `installBuiltinSkills` templated the server port into each
generated `.claude/skills/*/SKILL.md` at install time. If the user later
changed `.instar/config.json#port`, every curl call in every default skill
continued pointing at the stale port, silently failing with `ECONNREFUSED`.
One agent running on port 4041 had 25 hardcoded `localhost:4040` references
across 11 skills, turning short reflection/health-check runs into 75-second
timeouts.

**The fix is twofold**:
1. `installBuiltinSkills` in `src/commands/init.ts` now emits URLs as
   `http://localhost:${INSTAR_PORT:-4040}/...` so the shell expands the port
   at skill-execute time — respecting `INSTAR_PORT` if set, otherwise
   falling back to the port configured at install.
2. A new `PostUpdateMigrator.migrateSkillPortHardcoding()` scans existing
   default-skill files for hardcoded `localhost:NNNN` URLs and rewrites
   them to the dynamic pattern. It is idempotent, scoped to the known
   default-skill set (so custom skills are never touched), and preserves
   the original port as the fallback default.

## What to Tell Your User

- **Skills survive a port change**: "When you change your Instar server port, your default skills keep working. Before, every curl call in every default skill silently failed with a connection-refused error until you hand-edited each file. Now the port is resolved at the moment the skill runs."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Runtime port resolution in default skills | automatic — new installs emit the dynamic pattern |
| Auto-migration of existing skills | automatic — runs on next post-update migration |
| `INSTAR_PORT` override | `export INSTAR_PORT=4041` before running skill commands |

## Evidence

Reproduction: install instar with server port 4040, then change
`.instar/config.json#port` to 4041. Before fix: `.claude/skills/reflect/SKILL.md`
still calls `http://localhost:4040/reflection/record` — every curl returns
`ECONNREFUSED`, and skills that poll `/sessions`, `/relationships`, or
`/capabilities` return empty. After fix: the same URL reads
`http://localhost:${INSTAR_PORT:-4040}/reflection/record`, and shell
expansion hits the configured port whenever `INSTAR_PORT` is exported.

Verified in unit tests:
`tests/unit/PostUpdateMigrator-skillPortHardcoding.test.ts` — 6 tests
covering the migration happy path, idempotency, custom-skill preservation,
fallback port preservation, and the missing-file branch. All pass.

Template-side verified by invoking `installBuiltinSkills` directly and
grepping the emitted content: 13 of 14 default skills now contain
`localhost:${INSTAR_PORT:-4040}` and zero contain bare `localhost:4040`.
