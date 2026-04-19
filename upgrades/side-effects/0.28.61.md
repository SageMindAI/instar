# Side-Effects Review — Scheduler: report real exit code for gate skips

**Version / slug:** `scheduler-gate-exit-code`
**Date:** `2026-04-19`
**Author:** `dawn (autonomous instar-bug-fix job, AUT-5786-wo)`
**Second-pass reviewer:** `not required` (no gate/authority/sentinel/lifecycle surface touched)

## Summary of the change

`src/scheduler/JobScheduler.ts::runGateAsync` rejected errors use `.code` (async `execFile`) but the skip path reads `.status` (sync-spawn shape). This resulted in every legitimate non-zero gate exit being logged as `gate returned exit null`, making healthy skips indistinguishable from crashes. Fix: read `.signal ?? .code ?? .status ?? null`. One hunk, 7 lines, no decision-point surface changed.

## Decision-point inventory

This change does NOT touch any decision point.

- `runGateAsync` still decides the same way (returns `false` after maxAttempts failures). Only the DIAGNOSTIC text and `metadata.exitCode` value shift from `null` to the real exit code/signal.
- No block/allow semantics change. No retry count, timeout, or signal handling changes.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable. The only effect is a string in the activity feed and a field in event metadata.

---

## 2. Under-block

**What failure modes does this still miss?**

No block/allow surface — under-block not applicable. Note: one residual issue is the retry loop itself burning 10s of delay on legitimate non-zero skips (they look the same as transient failures to the current retry logic). Not addressed here — tracked as a follow-up. Fixing it requires distinguishing "normal non-zero" from "signal/timeout/spawn failure", which this change now makes trivial downstream because the exit code is no longer destroyed.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The bug is inside `runGateAsync` where the exit code is first extracted; this is the only place the `.status`/`.code` data-shape choice is visible. No higher or lower layer owns this. No detector-vs-authority confusion — this is a diagnostic readout, not a decision point.

---

## 4. Signal vs authority compliance

**Does this hold blocking authority with brittle logic, or does it produce a signal that feeds a smart gate?**

Neither. No blocking authority is added or changed. The gate's authority to skip is unchanged (it still exits after `maxAttempts` failures). This change only makes the emitted SIGNAL — the exit code surfaced to the activity feed and stored in `metadata.exitCode` — accurate. Downstream investigators (human or agent) now receive truthful data instead of a null that reads as "something catastrophic happened."

Per `docs/signal-vs-authority.md`: this is a pure signal-quality improvement with zero authority change. The principle is honored by making the signal accurate rather than cryptic.

---

## 5. Interactions

**Does it shadow another check, get shadowed by one, double-fire, race with adjacent cleanup?**

- Does NOT shadow any check — the logic that builds the log string runs after the retry loop completes, singular call site.
- Downstream consumers of `job_gate_skip` events that read `metadata.exitCode`: the type widens from `number | null` to `number | string | null`. Any consumer that stringifies or treats it as opaque already tolerates this. Grep for `metadata.exitCode` usage confirms no arithmetic on the field; current usages are template-string inclusion and display.
- No race with cleanup — this is in the error-handling path that runs once per gate evaluation.

---

## 6. External surfaces

**Does it change anything visible to other agents, other users, other systems?**

- **Activity feed strings:** operators and agents reading the feed will now see `exit 1` or `exit SIGTERM` instead of `exit null`. This is strictly more informative. No breaking change — any tool that parsed `exit null` for triage was parsing a bug.
- **Event metadata:** `metadata.exitCode` can now be a string (e.g., `"SIGKILL"`) when the gate was signal-terminated. Consumers treating it as a display value or boolean "is non-zero" continue to work. Consumers doing arithmetic would have been broken already (given the prior `null` value) and none exist per grep.
- **No network, no persistence-format, no inter-agent protocol change.**

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

One-line revert of the single hunk in `src/scheduler/JobScheduler.ts`. Publish a patch release. No data migration, no stored-state cleanup. Live agents simply return to logging `exit null` on the next release. Rollback cost is effectively zero.

## Risk classification

**LOW** per `/instar-bug-fix` skill risk taxonomy: diagnostic-string fix, no decision-point change, no public API surface, reversible in one line.
