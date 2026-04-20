---
title: Lifeline Self-Restart on Version Skew or Stuck Loop (Stage B)
slug: lifeline-self-restart-stage-b
stage: B
stage-a-predecessor: docs/specs/LIFELINE-MESSAGE-DROP-ROBUSTNESS-SPEC.md
date-drafted: 2026-04-20
author: echo
review-convergence: "2026-04-20T14:55:00Z"
review-iterations: 4
review-completed-at: "2026-04-20T14:55:00Z"
review-report: "docs/specs/reports/lifeline-self-restart-stage-b-convergence.md"
review-internal-lenses: [security, scalability, adversarial, integration]
review-external-models: [gpt-5.4, gemini-3.1-pro-preview, grok-4-1-fast]
approved: true
---

# Lifeline Self-Restart on Version Skew or Stuck Loop (Stage B)

## Problem

Two production incidents (Bob on 2026-04-19, Dawn on 2026-04-20) share a single pattern: the Telegram lifeline process ran for many days, drifted into a state where it could receive Telegram updates but could not forward them to the server, and was rescued only by a human operator restarting the process by hand. Stage A made this class of failure visible to the end user (the dropped-message notice and DegradationReporter alert); Stage B makes it *self-healing* so no human is required.

Two distinct root mechanisms were observed. Both produce the same end-state.

1. **Version skew** — the lifeline and the server ran different instar versions after a background `npm i` advanced the server. The lifeline's forward calls used a request shape the server no longer accepted. (Bob — `0.28.20` lifeline against `0.28.61` server.)

2. **Stuck message loop** — a long-running lifeline accumulated protocol state that kept it from recovering. Most commonly, a Telegram 409 conflict during server restart left the poll loop in a degraded backoff, and once the `forwardToServer` path started failing, it never recovered on its own. (Dawn — lifeline process age 7 days; forward success rate dropped to zero and stayed there for hours.)

Both patterns are silent in the absence of Stage A, and merely visible-but-still-broken in the presence of Stage A. Stage B closes the loop.

## Scope

Stage B adds two fixes.

### Fix 1 — Version handshake on forward-to-server

The lifeline includes its running version in every call to the server's `/internal/telegram-forward` endpoint as the JSON field `lifelineVersion`. The server validates the string structurally, compares against its own version, and responds according to the policy below. The lifeline's forward path uses a typed error so a 426 short-circuits Stage A's retry.

PATCH-only drift is accepted (patches must remain backward-compatible by project policy); a `versionSkewInfo` DegradationReporter signal fires as a pure observability signal if PATCH drift exceeds 10, with no blocking effect. This is an **informational signal, not an authority**.

### Fix 2 — Stuck-loop self-restart

The lifeline runs a lightweight health watchdog that tracks three signals with fixed thresholds, rate-limits restarts, and emits a DegradationReporter event naming the triggering cause before exit. Launchd respawns the process.

## Server-side policy (DP1 — structural API-boundary validator)

### Request-body schema change

`POST /internal/telegram-forward` accepts an OPTIONAL `lifelineVersion` field:

```
lifelineVersion?: string   // semver: /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[A-Za-z0-9.-]{1,32})?$/  max 64 chars
```

### Input validation

- If `lifelineVersion` is present but does not match the regex, or exceeds 64 chars: respond `400 Bad Request` with `{ ok: false, error: "invalid lifelineVersion" }`. No echo of the raw input.
- If `lifelineVersion` is absent: accept the forward (backward compatibility with pre-Stage-B lifelines). Emit a `TelegramLifeline.versionMissing` informational DegradationReporter signal (1 h cooldown) so operators can see un-migrated lifelines.

### Version resolution and boot window

- The server resolves `getInstarVersion()` once at boot into a cached `serverVersion` scalar.
- Until the cache is populated, `/internal/telegram-forward` responds `503 Service Unavailable` with `{ ok: false, reason: "server-boot-incomplete", retryAfterMs: 1000 }`. Never returns 426 during the boot window.
- The cache is never reloaded after boot — a fresh version requires a server restart, which is how deployments propagate.

### Version compare

- Parse `serverVersion` and validated `lifelineVersion` into `{major, minor, patch}` triples.
- If `major !== serverVersion.major` OR `minor !== serverVersion.minor`: respond `426 Upgrade Required`:
  ```
  {
    ok: false,
    upgradeRequired: true,
    serverVersion: "${s.major}.${s.minor}.${s.patch}",  // reconstructed from parsed numbers, never raw echo
    action: "restart",
    reason: "major-minor-mismatch"
  }
  ```
- Else if `Math.abs(serverVersion.patch - lifelineVersion.patch) > 10`: emit a `TelegramLifeline.versionSkewInfo` DegradationReporter event (1 h cooldown, feature key is per-lifeline-instance not per-pair); accept the forward normally.
- Else: accept the forward normally.

### Never-426-when-auth-empty guarantee

The `/internal/*` middleware already requires either `127.0.0.1` binding or bearer-token auth. If the server starts with `authToken === ''` (dev-only mode), `/internal/telegram-forward` refuses to process version handshakes — returns 200 with forward semantics unchanged (no `serverVersion` leak). This prevents an unauthenticated localhost fingerprinting channel if bearer-auth ever regresses.

## Lifeline-side policy (DP2 — operational self-heal)

### Typed forward error

`forwardToServer` classifies HTTP responses:

- `2xx` → success. Reset consecutive-failure counter. Update `lastForwardSuccessAt`.
- `426` → throw `ForwardVersionSkewError { status: 426, serverVersion, body }`. The retry wrapper treats this class as TERMINAL — zero additional attempts consumed. The version-skew handler below is invoked.
- `503` with `retryAfterMs` → throw `ForwardServerBootError`; retry wrapper waits `retryAfterMs` and retries once. If still 503, treat as transient failure (queue for replay).
- `400` → if the request included `lifelineVersion` AND the response body indicates invalid version (or body is empty/unclear), perform ONE retry without `lifelineVersion` in the body. This is graceful degradation for a hypothetical pre-Stage-B server that strictly validates JSON schemas and rejects unknown fields. If the retry also 400s, throw `ForwardBadRequestError` and treat as terminal (record drop). If the retry succeeds, mark the target server as `legacyStrict` for this lifeline instance and subsequent forwards omit `lifelineVersion`.
- Any other → `ForwardTransientError`; retry wrapper uses Stage A's existing policy (3 attempts, 1s base backoff).

### Version-skew handler

On `ForwardVersionSkewError`:

1. Validate that `response.body.serverVersion` parses and is MAJOR/MINOR-different from the lifeline's `lifelineVersion`. If the body is malformed or `serverVersion === lifelineVersion`, treat as transient (loopback impostor / race) and retry normally.
2. If valid: emit `TelegramLifeline.selfRestart` DegradationReporter event with `reason: "version-skew"`, context includes parsed `serverVersion` and `lifelineVersion`.
3. Invoke the unified restart sequence (see §Restart sequence).
4. Version-skew restarts are counted in a distinct rate-limit bucket (see §Rate limit).

### Health watchdog

The watchdog is a single in-memory class with three scalar fields:

| Field | Type | Set when | Cleared when |
|---|---|---|---|
| `lastForwardSuccessAt` | number (ms) | any 2xx from forwardToServer | never cleared; always overwritten on success |
| `consecutiveForwardFailures` | number | incremented on any non-2xx (including 426/400 for this counter purpose) | reset to 0 on 2xx |
| `conflict409StartedAt` | number \| null | set at the 0→>0 edge of `consecutive409s` | cleared at the >0→0 edge (i.e., on first successful poll after conflict) |

No per-message or per-attempt history is retained. All three are O(1) memory.

### Tick cadence

The watchdog evaluates once every 30 seconds via a single `setInterval` (unref'd in dev mode). The tick is in-memory only; the rate-limit file is read only when a signal has already tripped threshold.

**Tick drift check.** The watchdog records `lastTickAt` on each evaluation. If the gap between the current tick and `lastTickAt` exceeds `3 × tickInterval` (i.e., the event loop was blocked for >90 s), emit a `TelegramLifeline.watchdogStarved` informational signal. Starvation does not itself trigger restart — it is observability only.

### Signals and thresholds

| Signal | Computation | Threshold | Config override |
|---|---|---|---|
| `noForwardStuck` | `oldestQueueItemAge > 10min` — computed as `now - queue[0].enqueuedAt` when queue is non-empty. Signal is off when queue is empty. | 10 min | `lifeline.watchdog.noForwardStuckMs` (default 600_000) |
| `consecutiveFailures` | `consecutiveForwardFailures > 20` | 20 | `lifeline.watchdog.consecutiveFailureMax` (default 20) |
| `conflict409Stuck` | `conflict409StartedAt !== null && now - conflict409StartedAt > 5min` | 5 min | `lifeline.watchdog.conflict409StuckMs` (default 300_000) |

**Why `oldestQueueItemAge` and not `lastForwardSuccessAt`.** A low-traffic agent that receives no messages for 10+ minutes would have a stale `lastForwardSuccessAt`; when a message finally arrives, the watchdog's very next tick would see "queue non-empty + lastForwardSuccessAt >10 min ago" and trip the restart. That would crash-loop any infrequent-traffic agent — the most common deployment profile. Anchoring on the age of the oldest in-queue item, not the age of the last success, correctly captures "messages are accumulating and not draining" while excluding "messages haven't arrived in a while." The existing `QueuedMessage.timestamp: string` (ISO, already set at enqueue time) is the anchor — no new field required. Watchdog computes `oldestQueueItemAge = Date.now() - Date.parse(queue[0].timestamp)` when queue is non-empty.

The `noForwardStuck` signal is **suppressed** when `supervisor.getStatus().healthy === false` (the existing `ServerSupervisor` API on `TelegramLifeline.ts`) — no point restarting the lifeline for a stuck forward when the server is already known-down and a separate recovery path is active.

### Signal latching

When a signal crosses threshold during an active rate-limit window, it is *latched* on the watchdog instance. At the next tick after the rate-limit window expires:

- If any latched signal is STILL above threshold, fire restart.
- If all latched signals have de-crossed, drop the latches and resume normal evaluation.

This prevents the "signal crossed once and recovered, so we never restarted despite pathological behavior" failure. It also prevents a signal that latched during a restart storm from masking true recovery.

### Signal priority and single-event guarantee

If multiple signals trip in the same tick, evaluation proceeds in fixed priority: `conflict409Stuck` → `noForwardStuck` → `consecutiveFailures`. Exactly ONE DegradationReporter event fires per restart, with:

- `reason`: the highest-priority tripped signal's name
- `context.tripped`: array of all tripped signal names
- `context.values`: snapshot of all three signals

## Restart sequence

### Supervision detection

On startup, the watchdog classifies the run:

- **Supervised**: `process.env.INSTAR_SUPERVISED === '1'` (set by the boot wrapper / launchd agent) OR `process.ppid === 1` (adopted by launchd).
- **Unsupervised**: neither. Dev/interactive/test.

In unsupervised mode, the watchdog STILL evaluates signals and STILL emits DegradationReporter events. It does NOT call `process.exit(0)` — it logs a loud warning `[watchdog] would restart (trigger=X) but unsupervised; skipping exit` and continues. This keeps local testing from becoming "lifeline vanished."

### Shadow-install coordination

If `.instar/shadow-install/.updating` exists (lockfile published by the updater around `npm i`), the restart sequence defers by one tick (30 s) and emits a `restart-deferred-shadow-updating` log line. Prevents respawning against a half-written tree.

**Per-agent lockfile scope.** The lockfile lives under the agent's own `.instar/` — it is NOT machine-global. Multiple agents on the same machine running concurrent `npm i` do not interfere because each has its own state dir. If a future machine-global updater is added, it must use a distinct machine-global path (e.g., `~/.instar/shared/.updating`) and the watchdog must check both; that is out of scope for Stage B.

### Rate limit

Persisted state at `state/last-self-restart-at.json`:

```
{
  "lastRestartAt": "<ISO timestamp>",
  "lastReason": "<reason string>",
  "history": [{ "at": "<ISO>", "reason": "<string>" }, ...]  // ring buffer, last 50
}
```

- File mode: `0600`.
- Writes are atomic: write temp + `fsync` + `rename`.
- Two logical buckets sharing this file:
  - `watchdog`: rate-limited to one restart per 10 minutes. Tracks `noForwardStuck` / `consecutiveFailures` / `conflict409Stuck`.
  - `versionSkew`: rate-limited to one restart per 10 minutes *and* at most 3 restarts per rolling 24 hours (tighter ceiling; a misbehaving 426 source must not drive 144 restarts/day).

Read-side behavior, fail-closed on error:

- Missing file → treat as "clear to restart."
- Malformed JSON, permission error, unknown schema → treat as "just restarted NOW"; block restart and fire `TelegramLifeline.rateLimitFileCorrupt` signal.
- Future timestamp (`lastRestartAt > now`) → **allow the current restart to proceed** (bypass rate limit this cycle), fire `TelegramLifeline.rateLimitFileSkew` signal, and let the restart sequence overwrite the file with the correct `now`. Blocking here would be a permanent deadlock: a blocked restart never invokes the exit sequence, the exit sequence is the only writer, and the future timestamp persists forever.
- Elapsed time is clamped: `elapsed = Math.max(0, now - lastRestartAt)`.

Restart-storm escalation: after 6 restarts within 1 rolling hour (counted from `history`), emit a distinct `TelegramLifeline.restartStorm` DegradationReporter event OUTSIDE the per-feature 1 h cooldown (using a dedicated feature key and manual rate-limit reset) AND push an attention-queue item. Stops silent after-cooldown degradation.

### Exit sequence

The restart sequence is owned by a single orchestrator object, `RestartOrchestrator`, that serializes all restart initiators (watchdog signals, 426 handler, any future triggers). Only the orchestrator calls `process.exit`. All callers invoke `orchestrator.requestRestart(reason)` and await the returned promise (which resolves only if the request was suppressed; otherwise the process exits before the promise resolves).

Ordered steps:

0. **Single-owner guard.** The orchestrator exposes `state: 'idle' | 'quiescing' | 'persisting' | 'exiting'`. `requestRestart(reason)` is a no-op if `state !== 'idle'`; it logs `restart-request-suppressed reason=<new> currentState=<state>`. Transition `idle → quiescing` is synchronous and atomic before any `await`.

1. **Quiesce / drain barrier.** Before any persist, the orchestrator halts in-flight mutation sources in this order:
   - Clear the Telegram long-poll timer and abort the in-flight `getUpdates` fetch (AbortController).
   - Clear the replay interval that walks the dropped-messages queue.
   - Clear the watchdog tick interval.
   - Set `isPaused = true` on the forward path; any forward in flight is allowed to settle (≤500 ms await) but no new forwards start.
   - After 500 ms of quiesce grace, any still-in-flight forward is abandoned (response is ignored even if it arrives).

   This produces a causally-consistent snapshot: the queue observed by the persist step is the queue at the moment mutations stopped, not a moving target.

2. **Emit DegradationReporter event** (best-effort, max 500 ms await).

3. **Persist state** (three atomic writes, all in parallel via `Promise.all`):
   - `state/last-self-restart-at.json` — updated lastRestartAt, new history entry.
   - `state/dropped-messages.json` — already atomically persisted by Stage A; re-flushed to capture any final updates from step 1.
   - `state/lifeline-queue.json` — in-memory queue if present. If queue is empty, this file is still written (empty array) to make snapshot state unambiguous.

4. **Await persists** with a total 2000 ms budget.

5. **Hard-kill guard.** `setTimeout(() => process.exit(1), 5000).unref()`. If persist hangs, the process dies with exit code 1 and launchd respawns.

6. **Clean exit.** `process.exit(0)`.

The orchestrator's `state` is in-memory only — it does NOT survive restart (the new process starts with `state = 'idle'`, which is correct).

### External-restart path (via `instar lifeline restart`)

The CLI invokes `launchctl kickstart -k gui/$UID/${label}` which sends `SIGTERM` to the lifeline process. The existing `SIGTERM` handler (already in `TelegramLifeline.ts:397`) invokes `shutdown()`. Stage B modifies `shutdown()` to delegate to the orchestrator with `reason: 'external-signal'`. This gives external restarts the same quiesce/persist guarantees as internal ones.

### Startup liveness marker (for CLI success detection)

On startup, the lifeline writes `state/lifeline-started-at.json`:

```
{ "startedAt": "<ISO>", "pid": <number>, "version": "<semver>" }
```

This file is written unconditionally on every startup, even ones not triggered by the restart orchestrator (e.g., a cold boot after a crash). `instar lifeline restart` uses THIS file, not `last-self-restart-at.json`, for liveness polling: the CLI captures the pre-kickstart `pid` (or null if absent), calls `launchctl kickstart`, then polls `lifeline-started-at.json` until the observed `pid` differs from baseline, up to 30 s.

This fixes a previous-draft bug where `launchctl kickstart` (an external restart) would not touch `last-self-restart-at.json` and the CLI would always time out.

### Updater-path shadow-install coordination

The updater's invocation path is:

1. `.instar/shadow-install/.updating` lockfile is created by the updater BEFORE `npm i`.
2. `npm i` runs.
3. Lockfile is removed AFTER `npm i` completes successfully (or on error).
4. THEN `instar lifeline restart` is invoked.

The CLI `instar lifeline restart` verifies the lockfile is ABSENT before calling `launchctl kickstart`. If the lockfile is present, the CLI waits up to 60 s for it to clear; if still present after 60 s, returns a timeout error without restarting (safer to leave the old lifeline running on a coherent install than to respawn against a half-written one).

The startup path ALSO verifies coherence: on launch the lifeline attempts to `require('./package.json')` and checks the version against the spawning plist's expected version (if available). On mismatch or require-failure, the lifeline exits with code 2 (launchd will throttle-respawn; an operator needs to fix the install).

### Queue preservation

Dropped-messages ring buffer (500 cap) is untouched by the restart sequence — the existing Stage A persist path is already atomic. On next startup, `readDroppedMessages()` + existing replay path rehydrates. Replay failures are bounded by `MAX_REPLAY_FAILURES=3` — items that fail 3 restart cycles route through `notifyMessageDropped` and are removed from the queue, so replay set does not grow across restarts.

### In-flight Telegram updates

Telegram long-poll is a resumable GET with a persisted `offset`. The open connection dies on process exit; Telegram's server buffers and re-delivers on next `getUpdates` with the same offset. No data loss. This is a property of Telegram's API, not something Stage B needs to implement.

## Migration path

### One-time manual kick

Until the currently-running lifeline picks up the new code, it can't honor a 426 or trip the watchdog. Advancing the shadow install via `npm i` does not restart the running lifeline. The first Stage B migration therefore requires a one-time restart of each lifeline.

### New CLI: `instar lifeline restart`

A new CLI subcommand is added. Behavior:

1. Read `state/lifeline-started-at.json` to capture the current `pid` as baseline (or null if file absent).
2. Resolve the launchd label from config (`${agentName}.lifeline`).
3. Verify `.instar/shadow-install/.updating` is absent. If present, wait up to 60 s for it to clear; if still present, abort with `shadow-install-updating` error.
4. `launchctl kickstart -k gui/$UID/${label}` — launchd sends SIGTERM; existing handler invokes the restart orchestrator; launchd respawns.
5. Poll `state/lifeline-started-at.json` for up to 30 seconds; success iff observed `pid` differs from baseline. Otherwise report "timeout."

The upgrade pipeline (`POST /updates/apply`) invokes `instar lifeline restart` automatically after successful `npm i`. Operators can also invoke it directly.

### Dashboard surface

A new tile on the main dashboard card: "Lifeline Restarts (24 h): N — last reason: X." Reads from the `history` array. Operators can see restart storms without scrolling the event log.

## Config knobs

All five thresholds are overridable in `.instar/config.json` under `lifeline.watchdog.*` (see per-signal table above). Defaults match the spec values. Unknown keys are ignored (forward compat). Invalid values (non-finite, negative, zero) fall back to default and emit `TelegramLifeline.configInvalid` once at startup.

PATCH-drift boundary is strict: `Math.abs(s.patch - l.patch) > 10` fires `versionSkewInfo`; a drift of exactly 10 stays silent.

## Test-mode safety

- Watchdog constructor accepts `enableSelfRestart: boolean`, default true.
- `TelegramLifeline` constructor sets `enableSelfRestart = (process.env.NODE_ENV !== 'test')` unless overridden.
- Unit tests that construct the watchdog directly to verify signal logic use `enableSelfRestart: false` and assert on the "would-restart" log/signal rather than on `process.exit`.

## Backup/restore

`state/last-self-restart-at.json` is **excluded** from backup snapshots. It is machine-local operational state, not agent state. Restoration onto a different machine starts the rate-limit fresh. The existing backup manifest gets one entry added to its exclude list.

## Acceptance criteria

1. `forwardToServer` request body includes `lifelineVersion` as a semver string from `getInstarVersion()`. Unit test verifies.
2. Server `/internal/telegram-forward` returns 426 with the documented body on MAJOR/MINOR mismatch; 400 on malformed string; 503 during boot window; 200 on absent `lifelineVersion`. Unit tests verify each.
3. On 426 with a valid mismatch `serverVersion`, the lifeline emits `TelegramLifeline.selfRestart` with `reason: "version-skew"` and triggers restart sequence. 426 with matching or malformed `serverVersion` is treated as transient. 426 does NOT consume retry attempts. Unit tests verify.
4. Watchdog triggers restart within one 30s tick of any signal threshold crossing. Unit tests with fake timers verify each signal independently.
5. Rate limit enforced across process restarts. File tampering, corruption, and future timestamps all fail-closed. Unit test asserts each branch.
6. Queue + dropped-messages are on disk at `process.exit(0)` time. Persist budget ≤ 2 s; hard-kill after 5 s. Test asserts persist-before-exit ordering.
7. Watchdog does not fire `noForwardStuck` when supervisor reports unhealthy. Test asserts.
8. PATCH-drift `versionSkewInfo` fires at most once per hour per lifeline instance (per-feature cooldown). Test asserts single feature key across multiple PATCH-drift observations.
9. Unsupervised mode skips `process.exit(0)` and logs loud warning. Test asserts.
10. Shadow-install lockfile defers restart by one tick. Test asserts.
11. Restart-storm escalation fires `TelegramLifeline.restartStorm` after 6 restarts in 1 h. Test asserts.
12. Latched signals fire at window expiry if still above threshold. Test asserts.
13. All three signals crossing in one tick fire exactly one DegradationReporter event with priority `conflict409Stuck > noForwardStuck > consecutiveFailures`. Test asserts.
14. `instar lifeline restart` CLI ends with a new entry in `last-self-restart-at.json` or reports timeout. Test asserts.
15. `state/last-self-restart-at.json` is present in backup-exclude list. Test asserts.
16. Typecheck clean, full test suite green, pre-commit gate clean.
17. Ships through `/instar-dev`: side-effects artifact at `upgrades/side-effects/lifeline-self-restart-stage-b.md` covering Q1–Q7 including signal-vs-authority on DP1 (exempted under API-boundary structural validator) and DP2 (operational self-heal with deterministic thresholds + rate-limit).
18. Single-owner orchestrator: two concurrent restart requests (watchdog tick + 426 handler + external SIGTERM, all within 500 ms) produce exactly one quiesce+persist+exit sequence. Test asserts state transitions and suppression logging.
19. Quiesce barrier: during the exit sequence, the Telegram poll timer, replay interval, and watchdog interval are all cleared BEFORE persist begins. In-flight forwards are drained within 500 ms or abandoned. Test asserts by injecting a slow forward mid-restart and verifying the persisted queue snapshot is causally consistent.
20. External restart via SIGTERM: sending SIGTERM goes through the orchestrator with `reason: 'external-signal'` and produces the same quiesce+persist+exit semantics. Test asserts.
21. Startup liveness marker: every lifeline startup writes `state/lifeline-started-at.json` with pid/version/timestamp. Test asserts both on cold boot and post-restart.
22. CLI liveness detection: `instar lifeline restart` polls `lifeline-started-at.json` for `pid` delta (not `last-self-restart-at.json`), and returns success only on observed pid change within 30 s. Test asserts.
23. Updater shadow-install coordination: CLI refuses to kickstart while `.updating` lockfile is present, waiting up to 60 s. Test asserts.
24. Startup coherence verification: on launch the lifeline checks `require('./package.json').version` against the spawning plist's expected version; on mismatch exits with code 2. Test asserts.
25. Old-server tolerance: pre-Stage-B server (mock that ignores lifelineVersion field) accepts the forward cleanly. Test asserts. A 426 body lacking `upgradeRequired: true` does NOT trigger restart. Test asserts.
26. Watchdog starvation: a deliberately-blocked event loop for >90 s results in a `TelegramLifeline.watchdogStarved` signal but no restart. Test asserts (via `vi.useFakeTimers` + advancing beyond 3× tick interval).
27. Idle-traffic correctness: an agent with empty queue and `oldestQueueItemAge` undefined does NOT trip `noForwardStuck` regardless of how long since last forward. Test asserts: receive no messages for 20 simulated minutes, then deliver one — no restart fires.
28. Future-timestamp deadlock fix: with `lastRestartAt` set to `now + 1h`, the next restart trigger proceeds (does NOT block), and the file is overwritten with the correct current time. Test asserts.
29. 400 graceful degradation: if server returns 400 on a request carrying `lifelineVersion`, the lifeline retries once without the field; if that succeeds, subsequent forwards omit the field. Test asserts.

## Failure modes intentionally left unfixed

- **Restart storms from a persistent server bug.** Rate limit caps restarts at 1 per 10 min (watchdog bucket) or 3 per 24 h (version-skew bucket). Restart-storm signal escalates after 6 per hour. True human fix required to resolve underlying server bug.

- **Intra-window message loss.** Within a 10-min rate-limit window, the 500-entry ring buffer may rotate; messages older than the newest 500 are overwritten. Accepted — Stage A's visible drop notice still fires per loss.

- **Wallclock jumps.** Backward jumps are handled by `Math.max(0, elapsed)` clamping and the future-timestamp fail-closed path. Forward jumps extend the rate-limit window silently; worst case the next restart is delayed a few hours, still vastly better than never.

- **Simultaneously-restarting fleet.** If all agents on a machine trip at once on a shared-cause outage (network partition, Telegram down), they all restart simultaneously. No coordinated backoff. Accepted — launchd's ThrottleInterval (default 10s) provides the minimum per-process gap, and the operator will see a wave of signals that aggregates cleanly.

## Relationship to Stage A

Stage A's retry layer is additive to Stage B's watchdog:

- Stage A retries on transient errors (3 attempts, 1s base backoff).
- Stage B typed errors short-circuit retry for version-skew (426) and malformed-request (400).
- Stage B's watchdog operates at a higher abstraction layer: per-process health, not per-message health. It watches what Stage A's counters report.

The PATCH-drift observation (`versionSkewInfo`) is a Stage B addition; Stage A does not touch it.

## Rollout ordering

1. Stage B ships in release `0.28.66` (or next).
2. Servers on `0.28.66` begin accepting `lifelineVersion` and enforcing policy. Old lifelines continue to send no version and are accepted (versionMissing signal fires).
3. `instar update apply` pulls the new shadow install and calls `instar lifeline restart` as its last step. Lifelines pick up new code.
4. Post-migration, old lifelines still running will either self-restart via watchdog (if stuck) or be forcibly restarted by the updater; either way, within a day or two the entire fleet runs Stage B.

### Heterogeneous-direction tolerance (new lifeline → old server)

A new Stage-B lifeline may run against a server that has not yet been upgraded to Stage B (e.g., the lifeline upgraded first because its `npm i` finished first, or the server was manually pinned to an older version). In this case:

- The server's `/internal/telegram-forward` handler simply ignores the unknown `lifelineVersion` field — Express/Koa-style JSON handlers pass extra fields through silently. The forward proceeds as it always did.
- If the OLD server returns a transient 5xx that LOOKS like a version-rejection (it isn't, but the lifeline can't distinguish on status alone), the lifeline treats it as `ForwardTransientError` and retries normally. The watchdog's `noForwardStuck` signal will eventually catch a sustained-5xx scenario.
- The lifeline does NOT interpret a missing `serverVersion` in a 426 response body as "restart." This was already required for the loopback-impostor guard; the same rule covers the old-server-wrongly-returning-426 case.

**Acceptance criterion addition:** an explicit test verifies a pre-Stage-B server (modeled by a route that simply ignores the field) accepts the forward without error, and that a 426 from an unrelated source (no `upgradeRequired: true` in body) does NOT trigger restart.

## Rollback cost

Pure code change, no persistent state migration.

- Rollback = revert the code change and ship as next patch.
- `state/last-self-restart-at.json` is harmless if left in place after rollback (simply unread). Not in backup snapshots.
- No agent state repair required — old lifelines fall back to Stage A behavior.
- No user-visible regression during rollback window — self-restart is operator-visible (DegradationReporter events), not user-visible.

## Convergence-round-3 changes (2026-04-20, external crossreview)

Material findings from Gemini 3.1 Pro external review (all HIGH, would have caused production incidents):

- **Idle-traffic crash loop.** `noForwardStuck` anchored on `lastForwardSuccessAt` would crash-loop any low-traffic agent the moment a message arrived after 10+ minutes of quiet. Fixed by re-anchoring on `oldestQueueItemAge` — "messages accumulating and not draining," not "no recent success."
- **Future-timestamp deadlock.** Previous "block + wait for next successful write" was a permanent self-disable (no write ever happens while blocked). Changed to allow-and-overwrite with a skew signal.
- **400 graceful degradation.** Previous draft treated all 400s as terminal; a pre-Stage-B server with strict JSON validation could reject `lifelineVersion` and cause total message loss. Now a one-shot retry without the field, with a `legacyStrict` flag pinned for the session.
- **Exit-sequence re-entrancy & ingress-during-flush.** Gemini corroborated GPT's findings; orchestrator + quiesce barrier already address.
- **Typo fix.** "Three in parallel" now actually lists three targets.

Material findings from GPT 5.4 external review (all HIGH):

- **Single-owner orchestrator.** Previous draft used a bare `isRestarting` bool; strengthened to a named state machine (`idle → quiescing → persisting → exiting`) owned by `RestartOrchestrator`. All initiators route through it. Fixes cross-source races that the intra-tick priority ordering could not.
- **Quiesce/drain barrier.** Added explicit step 1: halt poll, replay, and watchdog timers BEFORE persist so the queue snapshot is causally consistent. Previous draft persisted in parallel without stopping mutation sources first.
- **CLI liveness via `lifeline-started-at.json`.** Previous draft used `lastRestartAt` delta, which is untouched by `launchctl kickstart` (SIGTERM path). CLI now polls a separate pid-bearing marker that every startup writes.
- **Updater shadow-install coordination through the CLI path.** Previous draft only checked the lockfile in the self-restart path. CLI now also refuses to kickstart while lockfile is present (60 s wait). Startup additionally verifies `require('./package.json').version` coherence.

Material findings from Grok 4.1 Fast external review:

- **Re-entrance race (HIGH).** Concurrent watchdog tick + `ForwardVersionSkewError` could double-enter the exit sequence and torn-write `last-self-restart-at.json`. Fixed by in-memory `isRestarting` guard as step 0.
- **Heterogeneous deployment ordering (HIGH).** New lifeline against old server was implicit; now explicit tolerance criterion plus test.
- **setInterval drift under blocked event loop (MED).** Now emits `TelegramLifeline.watchdogStarved` informational signal on >3× tick-interval gap.
- **Supervisor health API (MED).** Named explicitly: `supervisor.getStatus().healthy`.
- **`.updating` lockfile scope (MED).** Clarified as per-agent, with a note on future machine-global extension.

## Convergence-round-1 changes (2026-04-20)

Material findings addressed from 4 internal reviewer lenses:

- **Security**: version-string input validation (regex + 64-char cap + 400 on malformed), 426-body reconstruction from parsed triples (never raw echo), serverVersion withheld when authToken empty, rate-limit file 0600 mode + atomic write + fail-closed on all error modes.
- **Scalability**: tick cadence pinned at 30 s, three-scalar state discipline, persist budget 2 s with parallel flush + hard-kill guard, PATCH-skew feature key pinned per-lifeline-instance, no-I/O-on-hot-path rule.
- **Adversarial**: typed `ForwardVersionSkewError` short-circuits retry, server boot window returns 503 not 426, forced-exit setTimeout guard, dev-mode detection, signal latching across rate-limit window, restart-storm escalation at 6/hour, clock-skew clamping, single-event-per-restart with priority ordering, version-skew impostor guard (require serverVersion !== lifelineVersion in body).
- **Integration**: missing-version acceptance (backward compat), 503 during boot cache population, new `instar lifeline restart` CLI, shadow-install `.updating` lockfile coordination, backup-exclude for rate-limit file, `enableSelfRestart` option + NODE_ENV=test default, config.json threshold overrides, dashboard restart-history tile, artifact declaration.

Deferred to follow-up fixes (explicitly out of scope for Stage B):

- **Chaos tests** — Stage C.
- **Native-module self-heal** — separate fix queued after Stage B.
- **Server-side self-restart** — separate design.
