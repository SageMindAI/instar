# Side-Effects Review — default skills: dynamic localhost port

**Version / slug:** `skill-port-dynamic-resolution`
**Date:** `2026-04-17`
**Author:** `dawn`
**Second-pass reviewer:** `not required`

## Summary of the change

Two source changes. In `src/commands/init.ts`, every `http://localhost:${port}/...` URL inside `installBuiltinSkills` (and adjacent helpers that share the same file) is rewritten to emit `http://localhost:\${INSTAR_PORT:-${port}}/...`, so the generated `.claude/skills/*/SKILL.md` files contain a shell-expandable port reference instead of a number baked in at install time. In `src/core/PostUpdateMigrator.ts`, a new `migrateSkillPortHardcoding()` scans existing default-skill files for bare `http://localhost:NNNN/` URLs and rewrites them to `http://localhost:${INSTAR_PORT:-NNNN}/`, preserving the original port as the fallback default. The migration is scoped to the 14 known-default skill names and is idempotent. Test coverage: `tests/unit/PostUpdateMigrator-skillPortHardcoding.test.ts` — 6 cases.

## Decision-point inventory

- `src/commands/init.ts` `installBuiltinSkills` — **modify** — replaces hardcoded port templating with runtime-expandable pattern. 93 occurrences, mechanical find/replace, all inside backtick template strings for shell-executed content.
- `src/core/PostUpdateMigrator.ts` `migrateSkillPortHardcoding` — **add** — new migration method. Called from `migrate()` between `migrateBuiltinSkills` and `migrateSelfKnowledgeTree`. Scoped to a fixed allowlist of 14 default skill names.
- `tests/unit/PostUpdateMigrator-skillPortHardcoding.test.ts` — **add** — regression coverage for the migration.

---

## 1. Over-block

No block/allow surface. The change is runtime port resolution in user-project skill files. No message content or agent action is gated.

Within the migration's own domain: the scan matches `/http:\/\/localhost:(\d+)\//g` in the default-skill set. This pattern is narrow enough that it will not false-positive on natural-language references ("localhost:4040" mentioned in prose without the URL form is untouched). Files outside the 14-name allowlist are never read, so custom skills are never modified — a principle the test suite asserts explicitly.

---

## 2. Under-block

No block surface existed before this change. The migration adds no new enforcement — it is a one-way content rewrite. There is nothing to under-block.

Edge case: if a user had a default-skill file with a mix of the new dynamic pattern and stray hardcoded ports (e.g., partial manual edits), the idempotency guard (`includes('${INSTAR_PORT:-')`) will cause the migration to skip the file entirely rather than finish the rewrite. That is the safe direction — migrating a partially-edited file risks corrupting the user's edits. Users in that state can manually finish the rewrite or delete the file and let `installBuiltinSkills` regenerate it.

---

## 3. Level-of-abstraction fit

The change is at the correct layer. The root cause was install-time templating of a value that should have been runtime-resolved. Fixing the template is the direct fix; fixing existing user files via migration is the correct catch-up mechanism. Neither change rearchitects the skill system — skills remain static markdown files, the only change is that a value inside them resolves later.

The dynamic pattern `${INSTAR_PORT:-PORT}` uses POSIX shell parameter expansion, the same primitive the rest of the Instar shell surface depends on. It is a recognized idiom inside curl-heavy bash content, not a novel construct the user has to learn.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface.

The change is a content rewrite inside skill files. It does not evaluate messages, gate agent actions, or constrain information flow. Signal-vs-authority applies to decision points that judge messages or block work. A port-expansion template does neither.

---

## 5. Interactions

**Shadowing:** `installBuiltinSkills` and `migrateSkillPortHardcoding` target overlapping surface. Order matters: `migrateBuiltinSkills` runs first (non-destructive, writes only missing files), then `migrateSkillPortHardcoding` runs (rewrites existing files). A skill newly written by `installBuiltinSkills` in the same migration pass already uses the dynamic pattern, so `migrateSkillPortHardcoding` will see the `${INSTAR_PORT:-` marker and no-op. No double-processing.

**Double-fire:** `migrateSkillPortHardcoding` is idempotent — once a file contains the dynamic marker, it is skipped. Test case `is idempotent on a second run after migration` covers this explicitly.

**Races:** `PostUpdateMigrator.migrate()` is sequential and runs once per `instar` update. No concurrent access to the same skill file is expected. If two updaters ran simultaneously, they would both read the hardcoded content, both rewrite it, and the second write would overwrite the first with identical content — no corruption.

**Feedback loops:** None. The migration is a one-shot rewrite; the rewritten content does not feed back into any system.

---

## 6. External surfaces

- **Other agents:** Each agent running instar will get the migration on next `instar` upgrade. Agents on non-default ports gain working skills; agents on port 4040 see no behavioral change (the fallback matches their previous hardcoded value).
- **Install base users:** Users with customized skill files (renamed default skills, heavily edited content) are protected by the allowlist and the dynamic-marker idempotency check. The migration touches only the 14 canonical default-skill files, and only if they still contain the bare-port pattern.
- **External systems:** None. The URL targets are all `localhost` — no external traffic shape changes.
- **Persistent state:** Skill files on disk are rewritten in place. No database, no config, no registry is touched. Rollback = `git checkout` of the skill file or `rm` and re-run `installBuiltinSkills`.
- **Timing/runtime:** The `${INSTAR_PORT:-NNNN}` expansion runs at shell invocation time. An agent with `INSTAR_PORT` unset gets the fallback; with it set, gets the override. Zero-cost at skill-read time; one environment variable lookup per curl.

---

## 7. Rollback cost

Low. Revert: `git revert` the two source commits; the emitted skills would return to hardcoded ports, matching pre-fix behavior. Users who already ran the migration would keep their dynamic-pattern skills, which continue to work (the fallback equals the previous hardcoded value). No persistent state to undo, no agent state to repair, no user communication required.

Narrow risk: if a user's `INSTAR_PORT` env var is set to an invalid value (e.g., a port the server isn't listening on), curls will fail after this change where they would have succeeded before on the hardcoded default. Mitigation: the variable is only consulted if the user explicitly exported it. The intersection of "exported `INSTAR_PORT`" and "set it wrong" is small and self-inflicted; the fix for that case is `unset INSTAR_PORT` or set it correctly.

---

## Conclusion

The change is narrow, well-scoped, and covered by regression tests. The template fix is mechanical and safe. The migration is scoped to a known allowlist, idempotent, and respects user customizations. The under-block surface is zero; the over-block surface is zero. The worst case in rollback is a return to the original bug, which affected only users on non-default ports and is already worked around today by hand-sed. Ship.

No design changes were made as a result of the review.

---

## Evidence pointers

- `tests/unit/PostUpdateMigrator-skillPortHardcoding.test.ts` — 6 tests pass:
  - rewrites hardcoded ports in a default skill
  - leaves already-dynamic skills untouched (idempotent)
  - does not touch custom (non-default) skills
  - is idempotent on a second run after migration
  - skips when the skill file does not exist
  - preserves the original port number in the fallback
- Live template verification: `node -e "const {installBuiltinSkills}=require('./dist/commands/init.js'); ..."` against a temp dir shows 13 of 14 default skills emit `localhost:${INSTAR_PORT:-4040}` and zero emit bare `localhost:4040` (the 14th skill, `autonomous`, is a stub that deploys separately and has no localhost URLs).
- Source-side verification: `grep -c 'localhost:${port}' src/commands/init.ts` = 0 after the rewrite (was 93).
