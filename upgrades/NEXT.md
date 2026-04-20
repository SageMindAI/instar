# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**JobLoader per-entry resilience.** `JobLoader.loadJobs` now logs and
skips invalid job entries instead of throwing on the first one. One
malformed job (e.g. missing `name`/`priority` or an invalid
`execute.type`) previously took down the whole scheduler — propagating
through `JobScheduler.start` and killing the HTTP server before port
bind, which cascaded to the dashboard, feedback pipeline, attention
queue, and Telegram poller. Now each bad entry is logged (to
`console.error` with index + slug + validation error) and skipped;
valid sibling entries load normally. Structural errors (missing file,
unparseable JSON, non-array root) still throw — those indicate nothing
can be loaded at all. `validateJob` is unchanged and still throws on a
single bad entry, so CLI validators and tests keep their strict
single-entry semantics.

Fixes `cluster-jobloader-crashes-entire-server-on-one-bad-job-supervisor-ci`.
See `docs/specs/jobloader-per-entry-resilience.md` and
`upgrades/side-effects/jobloader-per-entry-resilience.md`.

## What to Tell Your User

- "If one job in my jobs file is broken, the others still run. The broken one gets logged and skipped instead of taking down everything."

## Summary of New Capabilities

- `JobLoader.loadJobs` skips invalid entries with `console.error` + summary `console.warn` instead of throwing.
