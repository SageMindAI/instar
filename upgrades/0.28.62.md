# Upgrade Guide — Scheduler reports real exit code for gate skips

## What Changed

`JobScheduler.runGateAsync` previously surfaced `exit null` for every
legitimate non-zero gate skip, because it was reading `.status` (the
synchronous `spawnSync` shape) off an error from the asynchronous
`util.promisify(child_process.execFile)` call, which exposes exit codes
on `.code` instead. Every gate-skip event and activity-feed line ended
up coalesced to `null`, indistinguishable from a process crash or
signal kill.

### Before

```
Job "degradation-digest" skipped — gate returned exit null after 3 attempts
```

Agents and operators reading this saw a null exit and assumed the gate
process had crashed or been killed. This triggered unnecessary
investigations — most recently, `degradation-digest` looking
"permanently gated (62 skips, 0 runs)" when the gate was in fact
exiting 1 by design (no degradation events to digest, nothing to run).

### After

The skip path now reads `.signal ?? .code ?? .status ?? null`, so:

```
Job "degradation-digest" skipped — gate returned exit 1 after 3 attempts
Job "other-job"         skipped — gate returned exit SIGKILL after 3 attempts
```

Legitimate non-zero skips report their real exit code. Signal-terminated
gates surface their signal. `metadata.exitCode` on the `job_gate_skip`
event is now a `number | string | null` (was `number | null`); consumers
doing display or non-arithmetic comparisons continue to work unchanged.

No decision-point change. The gate still retries up to `gateRetries`
times, still records to the skip ledger, still emits the same event
shape. Only the exit-code field is now truthful.

## What to Tell Your User

Your activity feed will stop saying "gate returned exit null" for
healthy skips — it will show the real exit code instead, so a legitimate
skip stops looking like a crash. Nothing changes about when jobs run or
skip; we just stopped hiding why.

## Summary of New Capabilities

| Capability | How it shows up |
|-----------|-----------------|
| Truthful gate exit codes | Activity feed and `job_gate_skip` events show the real exit code (e.g. `exit 1`) or signal (e.g. `exit SIGKILL`), never `exit null` for non-zero gates |
| Easier triage of stuck jobs | A job that "keeps skipping" now shows WHY (exit 1 = intentional skip; exit SIGKILL = runtime kill), so operators know whether to investigate |

## Evidence

- `JobScheduler` unit tests: 35/35 passing before and after the change.
- Error shape captured in the feedback cluster
  (`cluster-jobscheduler-reports-gate-exit-code-as-null-for-every-legiti`):
  `err.code: 1`, `err.status: undefined` — confirming the root cause.
- Side-effects review:
  `upgrades/side-effects/scheduler-gate-exit-code.md` covers
  over/under-block (n/a — no block surface), level-of-abstraction fit
  (right layer, pure diagnostic signal), signal-vs-authority compliance
  (pure signal quality, no authority change), interactions,
  external surfaces (activity-feed strings + `metadata.exitCode` type
  widening), and rollback cost (one-line revert).

## Deployment Notes

No operator action required. Agents pick this up automatically on the
next AutoUpdater cycle.

## Rollback

Revert the single commit. `metadata.exitCode` returns to being a
`number | null`, activity feed returns to showing `exit null` for
legitimate non-zero skips. No schema or state-file changes.
