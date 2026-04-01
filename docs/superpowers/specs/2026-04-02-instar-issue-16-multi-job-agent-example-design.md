# Instar Issue #16 Design

## Summary

Add a new example under `examples/multi-job-agent/` that demonstrates an agent running multiple scheduled jobs with different priorities and model tiers, including a high-priority health check job. The example remains configuration-only and does not change any runtime behavior.

## Goals

- Provide a copyable `jobs.json` that shows multiple scheduled jobs in one agent.
- Demonstrate a health check pattern that validates the local environment before other work accumulates.
- Show how priority and optional model selection can differ across jobs.
- Match the style and scope of the existing examples in `examples/`.

## Non-Goals

- No changes to scheduler, job loading, or any `src/` runtime code.
- No new validation or test harness for examples.
- No site docs or broader documentation changes outside the new example directory.

## User-Facing Design

### Directory

Add a new directory:

- `examples/multi-job-agent/README.md`
- `examples/multi-job-agent/jobs.json`

### `jobs.json`

The example will contain at least two jobs:

1. `health-check`
   Shows a frequent, high-priority environment verification task. It will check basic prerequisites such as the project directory existing, available disk space, and network connectivity.

2. `daily-review`
   Shows a normal-priority content or review task that represents regular work. It will summarize local uncommitted work or recent project state.

The file will also demonstrate:

- different cron schedules
- different priorities
- optional `model` selection on at least one job
- concise `description` fields so the example is self-explanatory when viewed without the README

### `README.md`

The README will follow the pattern of the existing example READMEs:

- short summary of what the example demonstrates
- embedded `jobs.json` example
- setup steps describing how to copy the file into a project
- brief explanation of:
  - why the health check job runs more frequently
  - how priority affects queue ordering
  - how model tiering can be used to keep lightweight checks cheaper than deeper review jobs

## Content Decisions

- Keep the example intentionally minimal: no `AGENT.md` is required because issue #16 is specifically about multi-job scheduling configuration.
- Use realistic but generic prompts so the example is broadly reusable.
- Prefer one lightweight health-oriented job and one substantive work-oriented job rather than adding many jobs, to keep the example easy to understand.

## Testing

This change is documentation/example-only. Verification is limited to:

- confirm the new files render/read cleanly
- confirm the JSON is valid
- confirm the example follows the formatting conventions already used in `examples/`

## Risks

- Over-designing the example would make it harder to copy into a real project.
- Adding too much explanation in the README would drift beyond the issue's requested scope.

## Recommended Implementation

Implement only the new example directory with one README and one `jobs.json`, then validate the JSON locally. No runtime or documentation system changes should be included in the same branch.
