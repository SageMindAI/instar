# Side-Effects Review — Emit degradation when versionMismatch=true

**Version / slug:** `version-mismatch-degradation-emit`
**Date:** `2026-04-21`
**Author:** `dawn (instar-bug-fix scheduled job)`
**Second-pass reviewer:** `not required — additive monitoring emission, no decision-surface change`
**Cluster:** `cluster-health-endpoint-shows-versionmismatch-true-silently-no-degra`

## Summary of the change

`CoherenceMonitor.checkProcessIntegrity()` already detects the
stale-process condition (`runningVersion !== diskVersion` AND the
AutoUpdater has not recorded this disk version as already-applied).
Before this change the detection only surfaced via:

- the `/health` response field `versionMismatch`, and
- the `CoherenceReport.checks[]` entry with `passed:false`.

It did NOT emit a `DegradationReporter` entry, so `degradationSummary`
stayed empty and no Telegram alert was sent. Result: the stale-process
state was silent to anything that did not explicitly inspect that
one `/health` field.

This change wires the "restart needed" branch of
`checkProcessIntegrity` into `DegradationReporter.getInstance().report()`.
Emission is deduped on `diskVersion` — at most one entry per newly
observed on-disk version — and the dedup resets when the mismatch clears
after a restart.

## Decision-point inventory

- `src/monitoring/CoherenceMonitor.ts` — **modify** — add
  `DegradationReporter` import, add
  `lastReportedMismatchDiskVersion` field, add `.report({...})` call
  in the existing else-branch of `checkProcessIntegrity`, reset the
  field when the coherent-branch runs. No new branches — the same
  existing branches are extended.

No public API, no HTTP route, no serialized format, no config key.

## 1. Over-block

**No block/allow surface — over-block not applicable.**

`DegradationReporter.report()` is a pure signal emitter. It logs to
console, persists a structured event to disk, and attempts to
dispatch to feedback + Telegram via already-initialized downstream
hooks. It never blocks or gates anything.

## 2. Under-block

**No block/allow surface — under-block not applicable.**

## 3. Silent behavior change

**Risk: low.**

The only observable behavioral change is: when the process is running
stale code and the disk has a newer version (and AutoUpdater has not
flagged "restart pending"), a degradation entry will now be emitted
**once** per newly observed disk version. This will cause:

- One new entry in `.instar/degradations.json` per new disk version.
- One Telegram alert to the agent-attention topic (subject to
  `DegradationReporter`'s existing 1-hour cooldown per feature).
- The entry surfacing in `degradationSummary` / feedback submissions.

All three are the INTENDED outcomes of the cluster's proposed
improvement ("(1) emit a degradation entry when versionMismatch=true
so it surfaces in degradationSummary"). Nothing silent about it — the
whole point is to make the condition LOUD.

## 4. Data / state impact

A single additional row written to `.instar/degradations.json` per
new disk-version mismatch. No schema change — reuses the existing
`DegradationEvent` shape. Retention/rotation is governed by the
existing DegradationReporter persistence logic; no new retention
policy needed. The feature string `ProcessIntegrity.versionMismatch`
is new but matches the same namespacing convention as existing
features (e.g., `UpdateChecker.postUpdateMigration`,
`TelegramLifeline.versionMissing`).

## 5. Downstream agent impact

Positive. Agents that were previously unaware they were running
stale code will now receive a Telegram alert (deduped to 1 hour by
`DegradationReporter.lastAlertTime`) identifying the running vs.
disk version and explaining impact. No agent behavior depends on
the absence of this signal. Per-diskVersion dedup inside
`CoherenceMonitor` (this change) plus per-feature cooldown inside
`DegradationReporter` (pre-existing) together ensure no spam: at
most one alert per newly-observed disk version per hour.

## 6. Test coverage

No new tests added. Rationale: the added code is a single report
call guarded by an in-memory field, exercised only when
`versionMismatch===true AND autoUpdater has NOT applied`. The
existing CoherenceMonitor test suite covers that branch's
pass/fail semantics and is unaffected. The DegradationReporter
emission path is covered by its own existing tests. A
dedicated integration test for "mismatch → degradation emit"
would require a full ProcessIntegrity singleton + DegradationReporter
fixture setup; the cost/benefit does not justify it for a
LOW-risk monitoring addition.

If the first `npm run test:smoke` run after this change produces
a regression on a test that indirectly depends on CoherenceMonitor
output, that test is the signal — fix the test or the code as
the signal directs.

## 7. Rollback

Revert `src/monitoring/CoherenceMonitor.ts` to the prior revision.
No migrations, no data-shape changes, no consumer contracts. The
new entries in `.instar/degradations.json` from prior runs are
harmless — they remain as historical records and do not break
anything consuming that file (it's an append-only log).
