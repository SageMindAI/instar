# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

This release completes Promise Beacon Phase 1. Six follow-on capabilities land together, building on PR #72 (beacon core) and PR #71 (CommitmentTracker single-writer `mutate()` + CAS):

- **`atRisk` non-terminal state** — `PromiseBeacon` accepts a `classifyProgress` signal. A "looks-concerning" verdict moves the commitment into `atRisk`, emits a softer heartbeat, and doubles cadence. Signal-only — terminal `violated` still requires session-epoch mismatch or hard-deadline lapse. Signal-vs-authority is preserved: the classifier is a signal, higher-level gates hold authority.
- **Boot-cap enforcement** — on startup, if the active-beacon count exceeds the configured cap, overflow beacons are marked `beaconSuppressed: "boot-cap-exceeded"` while `status` stays `pending`. Never silently withdrawn. Configurable per-agent via `promiseBeacon.maxActiveBeacons` (default 20).
- **`PATCH /commitments/:id`** — update `nextUpdateDueAt`, `softDeadlineAt`, `hardDeadlineAt`, `cadenceMs`, `beaconEnabled` on an existing commitment. Routes through `CommitmentTracker.mutate()`. Returns 400 on unknown field, 409 when the commitment is already in a terminal status.
- **Dashboard Commitments tab extension** — "Open Promises" list with cadence, last-heartbeat, state badge, and a Mark-delivered action wired to `POST /commitments/:id/deliver`. XSS-safe.
- **`<active_commitments>` session-start injection** — new `GET /commitments/active-context` endpoint (≤20 most recent pending/atRisk plus "+N more"). Wired into `session-start.sh` so agents see their own open promises across compaction.
- **PresenceProxy → shared `LlmQueue`** — optional `sharedLlmQueue` config on PresenceProxy. When passed, both monitors share the daily spend cap and honour cross-monitor interactive-lane preemption via `AbortController`. Backwards-compatible: absent config preserves existing behaviour.

Together with PR #71 and PR #72, the follow-through heartbeat infrastructure is feature-complete for Phase 1.

## What to Tell Your User

- "I can now watch my own promises. When I say 'back in an hour,' I can actually mark it as a promise — the system watches the clock, and if I go quiet past the check-in time, it sends you a short 'still alive, still working' note on its own."
- "If my progress looks concerning, the promise goes into a middle state and you get a softer heads-up — not a full 'it died,' just a check-in."
- "You can change a promise's timing. If I said 'back in ten minutes' but it's going to take twenty, you can ask me to stretch the clock."
- "There's a board you can check. The dashboard now has an Open Promises section. You can see every promise I'm currently on the clock for, when the next beat is due, and mark one as done."
- "I remember my promises across memory resets. When my memory gets packed down, I now reload a short list of what I'm still on the clock for, so I don't forget."

## Summary of New Capabilities

- Promise Beacon `atRisk` non-terminal state (signal-only; terminal `violated` still gated by session-epoch mismatch or hard-deadline lapse)
- Boot-cap enforcement via `promiseBeacon.maxActiveBeacons` (default 20); overflow marked `beaconSuppressed: "boot-cap-exceeded"`
- `PATCH /commitments/:id` for cadence/deadline updates through `CommitmentTracker.mutate()`
- Dashboard "Open Promises" list with Mark-delivered action wired to `POST /commitments/:id/deliver`
- `GET /commitments/active-context` + `<active_commitments>` session-start injection (≤20 entries)
- PresenceProxy shares `LlmQueue` with PromiseBeacon when `sharedLlmQueue` is provided

## Explicitly Still Deferred

- Audit log (`.instar/state/promise-beacon/audit.jsonl`)
- `paused` status (30-minute non-terminal hold on session-UUID mismatch)
- Explicit `atRisk`-clear endpoint
- CommitmentSentinel shadow mode (Phase 2)
- Live dashboard push updates (polling today, matches Initiatives tab)

None of these block the feature from working.
