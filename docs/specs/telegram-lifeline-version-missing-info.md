---
slug: telegram-lifeline-version-missing-info
review-convergence: converged
approved: true
approved-by: dawn
iterations: 1
---

# TelegramLifeline.versionMissing — Stop Reporting As Critical Degradation

## Problem

Cluster `cmo7wswhj0000mgmdbw4j7dyd` (severity: critical) is "[DEGRADATION] TelegramLifeline.versionMissing: lifelineVersion field absent — backward-compat path".

This signal is emitted by `src/server/routes.ts` whenever the `/internal/telegram-forward` endpoint accepts a forward from a pre-Stage-B lifeline (one that was upgraded but not restarted, so its in-memory daemon predates the version handshake introduced in 0.28.67). The forward is *accepted* via the documented backward-compat path — the request succeeds. Per the original commit 495efa6, "Missing field accepted for backward compat."

Despite being explicitly informational, the signal is emitted as a `[DEGRADATION]` feedback event, which the cluster classifier in the Portal feedback intake labels critical. This produces:

- A persistently critical cluster for an *expected* observability signal.
- Noisy regressions whenever any agent on 0.28.67–0.28.74 forwards a Telegram message without restarting their lifeline.
- Distraction from genuinely critical degradations.

A behavioural dispatch (`dsp-moc6wunp-2dwj`, behavioral, minVersion 0.28.67) was already created on 2026-04-24 advising agents to restart their lifelines. The remaining work is to stop classifying the signal as a degradation in the first place.

## Root Cause

`src/server/routes.ts:6367-6377` (pre-fix) calls `DegradationReporter.getInstance().report({ feature: 'TelegramLifeline.versionMissing', … })` inside the backward-compat branch. The DegradationReporter formats every event it receives as a `[DEGRADATION] …` feedback submission with `type: 'bug'`. The Portal cluster classifier sees the `[DEGRADATION]` prefix and assigns critical severity. There is currently no severity discrimination between ERROR and COMPAT_SIGNAL events at the reporter layer; that is the broader systemic work tracked by PROP-543.

## Fix

Inside the backward-compat branch in `/internal/telegram-forward`:

1. Stop calling `DegradationReporter.getInstance().report(…)`.
2. Emit a one-shot `console.info` per server process so the signal is preserved in logs without spamming on every forwarded message and without entering the feedback pipeline.

Concretely, declare a module-scoped `let _versionMissingLogged = false;` near the existing version-cache constants, and gate the new `console.info` on it.

### Risk

LOW. Diagnostic / observability change only.

- Forward request handling is untouched — the backward-compat path still accepts the forward exactly as before.
- No public API or contract change. `src/messaging/` adapters are not touched (so prepublish `check:contract-evidence` is not triggered).
- No data-format change.
- No test references `TelegramLifeline.versionMissing` (verified: `grep -rn versionMissing src/ tests/ test/ __tests__/` returns only the call site itself).
- The dispatched advice ("Restart your instar lifeline after upgrading to 0.28.67+") remains the operator action that resolves the underlying state; this fix only stops mis-classifying the observed transition as a critical bug.

### Out of scope

- Adding a generic ERROR vs COMPAT_SIGNAL severity field to `DegradationReporter` / its `feedbackSubmitter` payload — tracked under PROP-543. This spec deliberately stays at the call site.
- Server-side cluster reclassification of historical reports.

## Approval

This is a LOW-risk diagnostic change authored by the autonomous `instar-bug-fix` job per its grounding contract: low-risk fixes (diagnostic strings, default config, null checks, observability classification) may carry retrospective single-iteration convergence with `approved-by: dawn`. The cluster's research notes already specify exactly this fix; the implementation follows the documented guidance directly.

Cluster reference: `cmo7wswhj0000mgmdbw4j7dyd`. Existing dispatch: `dsp-moc6wunp-2dwj`.
