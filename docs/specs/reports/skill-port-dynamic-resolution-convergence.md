# Convergence Report — Default skills use runtime-expandable localhost port

## ELI10 Overview

When an agent installs instar, the installer writes a bunch of "skill" files into the agent's project — short instruction files that include `curl http://localhost:4040/...` commands. The installer pastes the server's port number into those files at install time. This works fine until the agent later changes their server's port. From then on, every skill is pointing at the old port, every curl silently fails, and the agent wastes time reasoning around empty replies.

This fix changes the installer to write a shell-expandable port reference instead — `localhost:${INSTAR_PORT:-4040}` — so the port is resolved when the command actually runs, not when the file is written. It also adds a one-time migration that rewrites the old hardcoded URLs in existing installs, but only inside the 14 default skills we know we own. Anything the user wrote themselves is left alone.

Tradeoffs: a user who explicitly exports `INSTAR_PORT` to a wrong value will break things in a way the old hardcoded default would have prevented. This is a self-inflicted case we accept, since the old behavior was worse for everyone who changed their port in any way.

## Original vs. Converged

The original spec described the two source changes and the allowlist migration, but was silent on three concerns a careful reviewer would raise:

1. **Static-URL tooling compatibility.** What happens if a future tool parses skill bodies and tries to extract URLs without shell expansion? Converged spec acknowledges this is a hypothetical future concern, notes no such tooling exists today, and documents the expected accommodation if someone adds one.

2. **Wrong `INSTAR_PORT` env var.** A user who exports `INSTAR_PORT=bogus` will now hit `ECONNREFUSED` on every skill, where the old hardcoded default would have saved them from their own mistake. Converged spec names this explicitly and accepts it — the trigger requires a deliberate export, the blast radius is the user's own agent, and the fix is trivial.

3. **Allowlist maintenance debt.** The allowlist of 14 default-skill names must be kept in sync with `installBuiltinSkills`. If a future skill is added to the installer but not the allowlist, existing users with the new skill hardcoded won't auto-migrate. Converged spec notes this as deliberate — the allowlist is the very safety mechanism that keeps the migration from touching user-authored skills.

## Iteration Summary

| Iteration | Reviewers | Material findings | Spec changes |
|-----------|-----------|-------------------|--------------|
| 1 | Security, Operational, Adversarial, Maintenance | 3 material | Added "Known limitations" section covering static-URL tooling, bogus `INSTAR_PORT`, and allowlist-drift concerns |
| 2 | Convergence check (all perspectives) | 0 material | None — converged |

## Full Findings Catalog

### Security (round 1)

- **No new blocking surface.** Confirmed — the change has no block/allow semantics. Runtime port resolution is a content rewrite, not an enforcement point.
- **Shell injection.** The `${INSTAR_PORT:-NNNN}` form uses a numeric fallback, and `INSTAR_PORT` is consumed only by shell expansion inside curl commands the agent already runs. No command substitution, no eval, no interpolation of untrusted content.

### Operational (round 1)

- **Migration idempotency.** Verified by test — the `${INSTAR_PORT:-` marker check prevents re-rewrite. Second run is a no-op.
- **Custom-skill preservation.** Verified by test — the migration's allowlist of default-skill names means anything the user authored is not inspected at all.
- **Partial-edit hazard.** If a user partially edited a default skill (mixing the dynamic pattern with a stray hardcoded port), the `${INSTAR_PORT:-` marker check makes the migration skip the file entirely. This is the safe direction — migrating a partially-edited file risks corrupting the user's edits. Noted as an acceptable outcome; user can finish the rewrite manually or delete the file and let `installBuiltinSkills` regenerate it.

### Adversarial (round 1)

- **Intentional wrong `INSTAR_PORT`.** Setting `INSTAR_PORT` to an invalid value breaks the user's own skills. Not a meaningful adversarial surface (user breaks themselves) but worth documenting. Added to spec.
- **Environment leakage.** A parent process that exports `INSTAR_PORT` for a different reason could unexpectedly route skill curls through the wrong port. Very narrow — the var name is instar-specific and collision risk is low. Accepted.

### Maintenance (round 1)

- **Allowlist drift.** If a new default skill is added to `installBuiltinSkills` without being added to `migrateSkillPortHardcoding`'s allowlist, existing users won't auto-migrate the new skill. Added to known limitations. Pairing the two lists in code (single source of truth) was considered but rejected as scope creep for this patch — the 14 names are stable and the risk is low.

### Convergence (round 2)

All perspectives concurred. No material changes requested. Spec is ready to ship.

## Decision

Proceed. The change is narrow, covered by regression tests, and has no blocking authority. The known limitations are documented and accepted.
