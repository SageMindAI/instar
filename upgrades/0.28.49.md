# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The job scheduler now injects `$INSTAR_AUTH_TOKEN` into the environment of any
gate shell it runs when `scheduler.authToken` is configured. Four built-in
gate scripts (evolution-proposal-evaluate, evolution-proposal-implement,
evolution-overdue-check, insight-harvest) have been updated to send
`Authorization: Bearer $INSTAR_AUTH_TOKEN` with their curl calls to the local
Instar HTTP API.

Previously these gates curled `http://127.0.0.1:4041/evolution/...` without
authentication. `authMiddleware` returned 401, the downstream
`python3 -c 'json.load(stdin)'` crashed on invalid JSON, and the job was
skipped every cycle with no error surface. The fix is additive: when
`authToken` is unset the env var is absent and gates remain identical to
their prior behavior; when it IS set (the default post-`instar init` state)
the four affected gates begin succeeding immediately on next scheduler tick.

A new optional field `authToken?: string` was added to `JobSchedulerConfig`,
wired through from `instar.json` via `Config.ts`. No migration required.

## What to Tell Your User

- **Evolution pipeline unblocked**: "Your evolution jobs start firing real work again — proposal evaluation, proposal implementation, overdue-check, and insight harvesting have all been silently skipping every cycle, and this release fixes that."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Authenticated gate calls | automatic — gates inherit auth token from scheduler config |
| Evolution proposal evaluation | automatic — fires on scheduler tick when proposals queued |
| Evolution proposal implementation | automatic — fires on scheduler tick when proposals approved |
| Overdue action check | automatic — fires on scheduler tick when actions overdue |
| Insight harvest | automatic — fires on scheduler tick when learnings accumulated |

## Evidence

Reproduction: on any instance with `authToken` configured (default post-
`instar init`), tail `logs/job-scheduler.log` for an evolution job's next
scheduled tick. Before fix: gate execution stderr contains
`json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)`
or a silent 10s timeout, and the job is skipped with no command execution.
After fix: gate logs show `HTTP/1.1 200 OK` from the authenticated
localhost call, gate returns 0, command proceeds.

Verified in unit tests: `tests/unit/JobScheduler.test.ts` — 2 new tests
assert the env var is present when authToken configured (`token=<value>`)
and absent when unset (`token=`), exercising both branches. All 47 tests
in the scheduler suite pass.
