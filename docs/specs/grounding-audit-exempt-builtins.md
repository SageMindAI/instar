---
title: "Exempt built-in default jobs from grounding audit warning"
slug: "grounding-audit-exempt-builtins"
author: "dawn"
created: "2026-04-21"
review-convergence: "2026-04-21T16:40:00.000Z"
review-iterations: 0
review-completed-at: "2026-04-21T16:40:00.000Z"
review-report: "not-required — LOW-risk log-noise fix. Single-file change to a static Set of exempt slugs in JobLoader.ts. Behavior change: a boot-time console.warn goes silent for package-shipped default jobs. No runtime, scheduling, or security effect. Autonomous instar-bug-fix precedent covers this class per grounding file (diagnostic string / default config fixes)."
approved: true
approved-by: "dawn"
approved-at: "2026-04-21T16:40:00.000Z"
approval-note: "Self-approved per instar-bug-fix grounding: LOW-risk fix (suppresses a noisy boot warning). Cluster ID: cluster-jobloader-warns-12-enabled-jobs-lack-grounding-config. The user report explicitly proposed this remedy: 'Either add grounding fields to the built-in jobs or suppress the audit for known-built-in job slugs.' Suppress path chosen because adding grounding to each default is a larger design question (what identity/security requirements do shipped defaults assume) that should not block the noise fix."
---

# Exempt built-in default jobs from the grounding audit warning

## Problem statement

On every server start, `JobLoader.auditGrounding` prints:

> [JobLoader] Grounding audit: 12 enabled job(s) lack grounding config: sentry-error-scan, reflection-trigger, relationship-maintenance, self-diagnosis, evolution-review, insight-harvest, commitment-check, coherence-audit, degradation-digest, state-integrity-check, guardian-pulse, session-continuity-check. Add a grounding field to declare identity and security requirements.

The warning was designed to nudge users toward declaring grounding on jobs *they* add. But every slug in the above list is a job shipped with the package itself — defined in `src/commands/init.ts` `getDefaultJobs()`. The user has no way to silence the warning without editing vendored defaults, so the nudge fires at every boot and trains the user to ignore it. Once the nudge is ignored, the audit's real purpose (catching a missing grounding field on a *user*-authored job that actually needs it) is lost.

## Fix

Widen `GROUNDING_EXEMPT_SLUGS` in `src/scheduler/JobLoader.ts` to include the full set of built-in default job slugs that currently ship without an inline `grounding` field. The audit continues to fire for any job slug not in the exempt set — i.e., user-authored jobs, which is the actual target population.

Rationale for the exempt-vs-add-grounding choice: deciding the correct identity/security grounding for each default job is a design question (what operator identity does `guardian-pulse` assume? what upstream inputs does `insight-harvest` process?). That work is worth doing but is scoped larger than a boot-warning-noise fix. Exempting now preserves the audit's signal for user jobs; adding grounding to each default can land later as a separate spec.

## Scope

- ONE file: `src/scheduler/JobLoader.ts`
- Added slugs: `reflection-trigger`, `relationship-maintenance`, `insight-harvest`, `evolution-overdue-check`, `coherence-audit`, `degradation-digest`, `state-integrity-check`, `memory-hygiene`, `guardian-pulse`, `session-continuity-check`, `memory-export`, `capability-audit`, `identity-review`, `evolution-proposal-evaluate`, `evolution-proposal-implement`, `commitment-detection`, `dashboard-link-refresh`, `overseer-guardian`, `overseer-learning`, `overseer-maintenance`, `overseer-infrastructure`, `overseer-development`, `sentry-error-scan`, `self-diagnosis`, `evolution-review`, `commitment-check`
- The 4 historical jobs (`sentry-error-scan`, `self-diagnosis`, `evolution-review`, `commitment-check`) are included even though `init.ts` no longer defines them — existing long-running agents still have them in their installed `jobs.json` and trigger the warning.

## Non-goals

- No change to the audit *logic* (still checks `enabled` && !exempt && !grounding).
- No change to what counts as valid grounding.
- No attempt to retroactively add grounding to the shipped default jobs.
- No change to how user-authored jobs are audited.

## Risk classification

LOW. A static Set is widened. The only behavioral change is the absence of a `console.warn` for ~26 named slugs at boot. No control-flow change. No security surface.
