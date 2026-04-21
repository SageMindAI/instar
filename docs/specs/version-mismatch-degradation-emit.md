---
slug: version-mismatch-degradation-emit
title: Emit degradation entry when process versionMismatch=true
review-convergence: "converged"
approved: true
approved-by: dawn
approval-context: >
  LOW-risk monitoring emission (no behavior change, no API change). Authored
  retrospectively by the instar-bug-fix scheduled job per the grounding file's
  guidance for low-risk bugs. Single-iteration convergence: the fix hooks into
  the existing CoherenceMonitor.checkProcessIntegrity() pathway that already
  detects the mismatch but was not routing it to DegradationReporter.
cluster-id: cluster-health-endpoint-shows-versionmismatch-true-silently-no-degra
severity: low
risk: low
---

# Emit degradation entry when process versionMismatch=true

## Problem

`GET /health` returns `version`, `diskVersion`, `versionMismatch`. When a new
version lands on disk but the process hasn't restarted, `versionMismatch=true`.
This is surfaced in `/health` as a field, but nothing emits a
`DegradationReporter` entry — so:

- `degradationSummary` stays empty (no signal).
- No Telegram alert fires to the agent-attention topic.
- The stale-process state is only visible if something actively queries
  `/health` and inspects that specific field.

## Fix

In `CoherenceMonitor.checkProcessIntegrity()`, the "restart needed" branch
(versionMismatch=true AND AutoUpdater has NOT already applied this disk
version) now additionally calls `DegradationReporter.getInstance().report({...})`.

Dedup: emit at most once per newly-observed `diskVersion`. A per-instance
field `lastReportedMismatchDiskVersion` tracks the last version we reported;
when the mismatch clears (running===disk after a restart), the field is
reset so the next update cycle can re-emit.

## Scope

- Change is confined to `src/monitoring/CoherenceMonitor.ts`.
- Adds an import of `DegradationReporter` (already used elsewhere in the
  repo; same singleton pattern).
- No changes to public API, data formats, or behavior of the coherence
  check itself — it still returns the same `CoherenceCheckResult`. The
  degradation emission is an additional side channel.

## Risk

LOW. The DegradationReporter pathway is battle-tested (GitSync, StateManager,
UpdateChecker all emit through it). Dedup prevents alert-spam. The emission
is guarded by `try/catch` so a misconfigured reporter cannot break the
coherence check.

## Rollback

Revert `src/monitoring/CoherenceMonitor.ts` to the prior revision. No
migrations, no data shape changes, no consumer contracts.
