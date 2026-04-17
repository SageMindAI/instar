---
title: Reflection-trigger signal to ReflectionMetrics
status: implemented
date: 2026-04-17
review-convergence: 2026-04-17T02:00:00Z
approved: true
approved-by: dawn (job=instar-bug-fix, session=AUT-5587-wo)
cluster: cluster-reflection-trigger-job-running-but-not-persisting-knowledge
---

# Reflection-trigger signal to ReflectionMetrics

## Problem

The `reflection-trigger` default job was a one-line prompt:

> "Review what has happened in the last 4 hours by reading recent activity logs. If there are any learnings, patterns, or insights worth remembering, update .instar/MEMORY.md. If nothing significant happened, do nothing."

On reporting agents the job completed in ~40 seconds with `status: success`, but produced zero output:

- No handoff note written (`.instar/state/job-handoff-reflection-trigger.md` absent)
- Project `MEMORY.md` unchanged for 9+ days despite scheduled 4-hour reflections
- The server-side `ReflectionMetrics` subsystem was never notified that a reflection occurred

Because `ReflectionMetrics` was never signalled, its internal `lastReflectionTimestamp` never updated, and downstream "time for reflection?" prompts kept firing indefinitely. A 20-day instrumentation gap accumulated: the metrics system had no idea whether reflections were happening at all.

Root cause (two parts):

1. **Prompt lacks context.** Telling an agent to "review recent activity" without actually surfacing any activity means the agent has nothing concrete to analyze. Fluent completion of that prompt is "nothing significant happened" — whether or not that's true.
2. **No completion signal.** Even when a reflection does produce a MEMORY.md update, there was no mechanism to notify `ReflectionMetrics`. The metrics subsystem was architecturally decoupled from the jobs that were supposed to feed it.

## Proposed fix

Replace the one-line prompt with a shell-based prompt that:

1. Locates the most recent `.instar/logs/activity-*.jsonl`
2. Tails the last 500 lines, filtering out low-value events (`job-start`, `job-queued`)
3. Emits the filtered activity as visible context under an "=== RECENT ACTIVITY ===" header
4. Presents a structured task: session patterns, completed commitments, intended vs actual behavior gaps, unexpected failure modes, process improvements, capability gaps
5. Instructs the agent to append genuine learnings to `.instar/MEMORY.md`
6. Signals completion via `POST http://localhost:${port}/reflection/record` with `{"type":"quick"}` so `ReflectionMetrics` resets counters

The `POST /reflection/record` endpoint already exists (`src/server/routes.ts:773`), wired to the `ReflectionMetrics` instance constructed at `routes.ts:188`. No server changes required — only the job prompt.

## Signal vs authority compliance

- **Signal producer**: `reflection-trigger` job emits a signal when a reflection has occurred.
- **Signal consumer**: `ReflectionMetrics` passively consumes the signal to update `lastReflectionTimestamp` and reset deep-reflection counters.
- **Non-blocking**: The curl call is fire-and-forget at the end of the prompt. If the POST fails (server down, network error), the reflection still happened — `MEMORY.md` was updated — and only the metrics are stale. Nothing downstream blocks on the signal.
- **No brittle authority**: The agent's decision to update `MEMORY.md` is independent of signal delivery. No authority is held in a way that breaks when the signal is absent.

Full side-effects review: `upgrades/side-effects/0.28.47-reflection-trigger-signal.md`.

## Scope

In scope:

- `src/commands/init.ts` — replace the `reflection-trigger` default job's `execute.value` with the new shell prompt
- `src/data/builtin-manifest.json` — regenerate (downstream of any change that touches `src/core/PostUpdateMigrator.ts` hook content; regeneration is part of `npm run build`)
- `upgrades/NEXT.md` — upgrade guide for v0.28.47
- `upgrades/side-effects/0.28.47-reflection-trigger-signal.md` — side-effects review

Not in scope (explicitly excluded — separate WIP stashed during this ship):

- `src/core/InputGuard.ts` + `src/commands/server.ts` + `tests/unit/InputGuard.test.ts` — IntelligenceProvider wiring for Input Guard (separate feature, belongs to a different spec)

## Verification

Static verification on v0.28.47 source:

- `dist/commands/init.js:2532` contains the new `curl ... /reflection/record` line
- `src/server/routes.ts:773` confirms `POST /reflection/record` is routed to `ReflectionMetrics`
- `src/monitoring/ReflectionMetrics.ts:86` confirms `ReflectionMetrics.getInstance().report(...)` pattern
- Build (`npm run build`) passes; type-check (`tsc --noEmit`) passes

Not runtime-exercisable in this spec: the job prompt change takes effect only at next `init` (new agents) or after `post-update` migration (existing agents). Full runtime evidence requires a 4h scheduled trigger on a live agent post-upgrade.
