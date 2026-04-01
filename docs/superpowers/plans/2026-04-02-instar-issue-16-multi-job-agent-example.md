# Multi-Job Agent Example Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configuration-only example that shows a multi-job agent with a frequent health check job and a regular work job.

**Architecture:** Create a new `examples/multi-job-agent/` directory with a copyable `jobs.json` and a README that explains the scheduling concepts the example demonstrates. Reuse the tone and structure of the existing `examples/` docs and avoid any runtime code or site-doc changes.

**Tech Stack:** Markdown, JSON, GitHub CLI, existing Instar example conventions

---

### Task 1: Add the example files

**Files:**
- Create: `examples/multi-job-agent/jobs.json`
- Create: `examples/multi-job-agent/README.md`

- [ ] **Step 1: Write the example configuration**

Create `examples/multi-job-agent/jobs.json` with two jobs:

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

- [ ] **Step 2: Write the README**

Create `examples/multi-job-agent/README.md` with:

```md
# Example: Multi-Job Agent

An Instar agent with multiple scheduled jobs, including a frequent health check and a regular work job.

## Files

### `jobs.json`

```json
[...same JSON as above...]
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
```

- [ ] **Step 3: Commit the example files**

Run:

```bash
git add examples/multi-job-agent/jobs.json examples/multi-job-agent/README.md
git commit -m "docs: add multi-job agent example"
```

Expected: a commit containing only the new example files.

### Task 2: Verify and publish

**Files:**
- Verify: `examples/multi-job-agent/jobs.json`
- Verify: `examples/multi-job-agent/README.md`

- [ ] **Step 1: Validate the JSON**

Run:

```bash
jq empty examples/multi-job-agent/jobs.json
```

Expected: no output and exit code `0`.

- [ ] **Step 2: Review the README content**

Run:

```bash
sed -n '1,220p' examples/multi-job-agent/README.md
```

Expected: README renders cleanly, matches existing example style, and explains schedule, priority, and model choices.

- [ ] **Step 3: Push and open the PR**

Run:

```bash
git push -u fork pyxzzfly/issue-16-multi-job-example
gh pr create --repo JKHeadley/instar --head pyxzzfly:pyxzzfly/issue-16-multi-job-example --base main --title "Add multi-job agent example with health checks" --body-file /tmp/issue16-pr-body.md
```

Expected: branch is pushed and a PR is opened against `JKHeadley/instar:main`.
