# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

The `reflection-trigger` default job now actually reads recent activity and signals completion to ReflectionMetrics.

Previously the job was a one-line prompt ("review what happened in the last 4 hours; if any learnings, update MEMORY.md") that completed in ~40 seconds with zero output — no MEMORY.md update, no handoff note, and no notification to the ReflectionMetrics subsystem. ReflectionMetrics had no way to know a reflection had occurred, so its "time for reflection" check never reset and downstream systems kept firing the same nudge indefinitely.

The new prompt:
- Reads the most recent `.instar/logs/activity-*.jsonl` (last 500 lines, filtered to meaningful events, not job-start/job-queued noise)
- Presents the activity to the agent with a structured task (look for session patterns, completed commitments, gaps between intended and actual behavior, unexpected failure modes, capability gaps)
- Instructs the agent to append to `.instar/MEMORY.md` when a real learning exists
- Signals completion via `POST /reflection/record` so ReflectionMetrics sees the reflection and resets counters

This closes a 20-day instrumentation gap. Non-blocking change — fire-and-forget curl to the endpoint. If the signal fails, the reflection still happened; only the metrics are best-effort.

## What to Tell Your User

- **Your agent can now actually notice patterns over time.** Every few hours they'll quietly review recent activity and jot down anything worth remembering. If nothing significant happened, they stay silent.
- **The "time for another reflection" nudge will stop being wrong.** The system now knows when a reflection has actually occurred, so it won't keep asking forever.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Reflection-trigger reads recent activity logs and appends real learnings to MEMORY.md | Automatic (scheduled every 4h) |
| ReflectionMetrics notified when a reflection completes | Automatic (reflection-trigger job signals the endpoint) |

## Evidence

Feedback cluster: `cluster-reflection-trigger-job-running-but-not-persisting-knowledge`

Reproduction before fix:
- MEMORY.md unchanged since 2026-04-03 despite scheduled 4-hour reflections — 9+ days stale at time of report
- Representative job run `job-reflection-trigger-mnvnkvpi` (2026-04-12T11:01): status=success, duration=40s, no handoff note, no MEMORY.md delta
- ReflectionMetrics continued reporting "no reflection since startup" because nothing was ever signalling `/reflection/record`

Observed after fix (static verification on v0.28.47 source):
- `dist/commands/init.js` default job `reflection-trigger` now emits the activity-log tail + structured task prompt + `POST /reflection/record` curl
- `/reflection/record` endpoint exists at `src/server/routes.ts:773` and is wired to `ReflectionMetrics` at `routes.ts:188` — signal path is real
- `dist/commands/init.js:2532` contains the new curl call, matching source

Not runtime-exercisable in this fix: the job prompt change only takes effect on the next `init` (new agents) or after `post-update` refreshes the default jobs for existing agents. Full runtime evidence requires a scheduled 4h trigger on a live agent post-upgrade.

Side-effects review: `upgrades/side-effects/0.28.47-reflection-trigger-signal.md`
