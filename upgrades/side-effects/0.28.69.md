# Side-Effects Review — grounding-audit-exempt-builtins

**Version / slug:** `grounding-audit-exempt-builtins`
**Date:** `2026-04-21`
**Author:** Dawn (autonomous instar-bug-fix)
**Second-pass reviewer:** not required — LOW-risk fix per instar-bug-fix grounding (log-noise suppression, no runtime/behavioral change)

## Summary of the change

`src/scheduler/JobLoader.ts`: widen the `GROUNDING_EXEMPT_SLUGS` ReadonlySet so the boot-time grounding audit stops emitting a warning for jobs shipped as built-in defaults by the package itself. The audit's purpose is to nudge users toward declaring `grounding` on jobs they author — firing it on package-provided defaults trained users to ignore the message, which defeats the point.

Exempt slugs added (all defined in `src/commands/init.ts` `getDefaultJobs()`, or historically defined there and still present in long-running users' `jobs.json`):

reflection-trigger, relationship-maintenance, insight-harvest, evolution-overdue-check, coherence-audit, degradation-digest, state-integrity-check, memory-hygiene, guardian-pulse, session-continuity-check, memory-export, capability-audit, identity-review, evolution-proposal-evaluate, evolution-proposal-implement, commitment-detection, dashboard-link-refresh, overseer-guardian, overseer-learning, overseer-maintenance, overseer-infrastructure, overseer-development, sentry-error-scan, self-diagnosis, evolution-review, commitment-check.

No change to audit logic; only the exempt set grows.

## Decision-point inventory

- `GROUNDING_EXEMPT_SLUGS` — **widen** — adds ~26 slugs. Boot warning goes silent for those. User-authored jobs still audited.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Audit is a pure `console.warn` — it rejects nothing. The change only silences the warning for a fixed list of slugs. If a user coincidentally named their own custom job `guardian-pulse`, it would be exempted even if unground-ed, but since those slugs collide with package defaults, the user would already have a conflict at load time (duplicate slug) — a real problem out of scope here.

## 2. Under-block

**What unsafe inputs does this change NOT reject that it should?**

Not applicable. The audit is a nudge, not a gate. It doesn't block anything.

## 3. Silent failure

**Does this change turn a previously-visible error into a silent one?**

Arguably: yes, by design. The boot warning is what we're silencing. But it was silencing itself already — the user couldn't act on it without editing vendored defaults. The signal value was already ~zero. Net effect: signal for USER jobs gets louder because it stops being drowned in package-default noise.

## 4. Data loss / corruption

No state is written. No migration. No persisted config change. Restart-only effect: one fewer `console.warn` line on startup.

## 5. Performance

Negligible. A `Set.has()` lookup grows from 6 entries to ~32. O(1) in both cases.

## 6. Backward compatibility

None required. The exempt set is internal to JobLoader. Users who had the warning previously will stop seeing it. Users who had disabled or ignored it see no change. No API, CLI, or config surface touched.

## 7. Rollback

Revert the single-file change to `src/scheduler/JobLoader.ts`. No data migration to unwind, no deployed state to clean up, no external dependency. The warning returns on next boot.

---

## Testing notes

- Build verifies TypeScript still compiles.
- No new tests added: the audit path is already covered by the boot log and adding a unit assertion on the exempt-set membership is a tautology (it just repeats the data structure). If the audit gains conditional logic later, that conditional deserves a test; a static Set does not.
- Manual verification: after release, a fresh agent boot log should no longer contain `[JobLoader] Grounding audit:` for the exempted slugs.

## Related clusters

- `cluster-jobloader-warns-12-enabled-jobs-lack-grounding-config` (Instar feedback cluster, low severity). The user's suggested remedy explicitly offered either path; this change takes the "suppress the audit for known-built-in job slugs" path.
