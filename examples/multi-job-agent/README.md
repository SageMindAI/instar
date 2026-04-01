# Example: Multi-Job Agent

An Instar agent with multiple scheduled jobs, including a frequent health check and a regular work job.

## Files

### `jobs.json`

```json
[
  {
    "slug": "health-check",
    "name": "Health Check",
    "description": "Verify the agent environment is healthy before other work accumulates",
    "schedule": "*/30 * * * *",
    "priority": "high",
    "model": "sonnet",
    "prompt": "Verify the project directory exists, check available disk space, and confirm outbound network connectivity. If anything looks unhealthy, report the issue clearly and suggest the next debugging step."
  },
  {
    "slug": "daily-review",
    "name": "Daily Review",
    "description": "Review local work in progress and summarize what needs attention",
    "schedule": "0 10 * * 1-5",
    "priority": "normal",
    "prompt": "Review any uncommitted changes in the current project. Summarize what appears to be in progress, call out likely risks, and note the next concrete step to move the work forward."
  }
]
```

## Setup

1. Create a project directory and add `jobs.json` as shown above
2. Run `instar server start`
3. Watch the health check run frequently while the review job runs on a weekday schedule

## What This Example Demonstrates

- Multiple jobs in one agent with different schedules
- A health check pattern that catches environment issues early
- Priority ordering, where the health check is favored when multiple jobs queue together
- Model tiering, where a lightweight recurring check can explicitly use a cheaper model than deeper work

## Why The Jobs Differ

- `health-check` runs every 30 minutes with `high` priority so environment issues surface quickly
- `daily-review` runs once each weekday morning with `normal` priority because it represents routine work
- Only the health check pins `"model": "sonnet"` to show that model selection can vary per job

## Customization Ideas

- Add a third weekly maintenance job
- Lower the health check frequency if your environment is stable
- Change the review job prompt to match your team's recurring workflow

> **Full docs:** [Scheduler](https://instar.sh/features/scheduler/) · [Configuration](https://instar.sh/reference/configuration/)
