---
title: "Scheduler: report real exit code for gate skips (not null)"
slug: "scheduler-gate-exit-code"
author: "dawn"
created: "2026-04-19"
review-iterations: 1
review-convergence: "converged"
convergence-date: "2026-04-19"
convergence-note: "Single-iteration convergence: one-line data-shape fix with no behavior change, no decision point, no interaction with gates/authorities. Rollback is a one-line revert. Risk surface is purely cosmetic (activity-feed string). See side-effects artifact for the signal-vs-authority question answered in the negative."
approved: true
approved-by: "dawn"
approved-date: "2026-04-19"
approval-context: "Autonomous instar-bug-fix job (AUT-5786-wo). Feedback cluster cluster-jobscheduler-reports-gate-exit-code-as-null-for-every-legiti identified the root cause conclusively: .status is the synchronous-spawn shape, .code is the promisified-execFile shape. The coalescing to null was making every legitimate skip look like a process crash and triggering false investigations. Fix is one line, no decision surface, no blocking authority changed. LOW risk per instar-bug-fix skill classification."
---

# Scheduler: report real exit code for gate skips

## Problem

`scheduler/JobScheduler.ts::runGateAsync` uses `util.promisify(child_process.execFile)` to run each job's gate asynchronously. When the gate exits non-zero (the normal "skip this run" signal), the promisified call rejects with a Node `ExecFileException` whose exit code lives on `.code`, not on `.status`. Our skip-recording path reads `.status`:

```ts
const exitCode = (lastErr as { status?: number })?.status ?? null;
```

`.status` is always `undefined` on these errors, so the coalescer always resolves to `null`. Every legitimate gate skip is then logged as `gate returned exit null after 3 attempts`, which is indistinguishable in the activity feed from a process crash or signal kill. This surfaced when `degradation-digest` appeared "permanently gated (62 skips, 0 runs)" while its gate was actually exiting 1 by design (no degradation events, so nothing to run on) — an agent user had to investigate before realizing the gate was healthy.

Root cause verified in cluster research with captured error shape:
```
err.code: 1
err.status: undefined
err.signal: null
err.killed: false
keys: [ 'code', 'killed', 'signal', 'cmd', 'stdout', 'stderr' ]
```

## Fix

Replace the single read with a signal-first / code-second / status-fallback cascade:

```ts
const errShape = lastErr as { code?: number; signal?: string | null; status?: number };
const exitCode = errShape?.signal ?? errShape?.code ?? errShape?.status ?? null;
```

`.signal` is preferred because a signal-terminated gate (e.g. SIGKILL from the 10s timeout) carries more diagnostic value than the synthetic exit code node attaches. `.code` handles the normal async case. `.status` is kept as a fallback purely in case a future refactor swaps back to a sync spawn shape.

No other behavior changes. The gate still retries up to `maxAttempts` times, still records to the skip ledger on final failure, and still emits a `job_gate_skip` event.

## Acceptance criteria

- Gate that exits 1 on first attempt (and all retries) logs `gate returned exit 1 after 3 attempts`, not `exit null`.
- Gate that is SIGKILL'd logs `gate returned exit SIGKILL`, not `exit null`.
- `JobScheduler` unit tests continue to pass (35/35 before and after).

## Rollback

Revert the one hunk. No data shape on disk changes; `metadata.exitCode` in `job_gate_skip` events shifts type from `null` to `number | string`, which any downstream consumer treating it as opaque already tolerates.

## Non-goals

- The secondary observation in the cluster report (the retry loop burning 10s on legitimate non-zero skips) is a separate optimization. Not addressed here; file a follow-up if it becomes load-bearing.
- No change to gate contract, retry policy, timeout, or event shape.
