# Side-Effects Review — /build mid-run heartbeats + long-tool-wait detector (Fix 2 + Fix 3)

**Version / slug:** `build-stall-visibility-fix2-3`
**Date:** `2026-04-20`
**Author:** `echo`
**Spec:** `docs/specs/BUILD-STALL-VISIBILITY-SPEC.md`
**Second-pass reviewer:** `not required`

## Summary of the change

Two fixes to surface progress during long /build waits that previously went silent.

**Fix 2 — mid-run heartbeats.** Adds `POST /build/heartbeat` to the agent server. The /build skill (build-state.py) calls it on every phase transition and on completion. The endpoint validates against allowlists (phase / tool / status), enforces a runId regex, requires exactly one of topicId/channelId, and dispatches the templated message via Telegram or Slack. After dispatch, `ProxyCoordinator.recordBuildHeartbeat(topicId)` records the timestamp; `PresenceProxy.fireTier` checks `hasRecentBuildHeartbeat` (default 6-min window) before firing Tier 2/3 standby — so the user hears one progress voice per channel, not two.

**Fix 3 — long-tool-wait detector.** Extends PresenceProxy with a snapshot-diff detector: per-topic state tracks `toolStartedAt` (last unchanged-snapshot baseline) and `lastAgentTextAt`. When `enterThresholdMs` (default 8 min) of unchanged snapshot with a `Cogitated` marker passes, Tier 2/3 swap their templated message to a tool-specific one. Hysteresis exit after `exitHysteresisMs` of sustained new text. One-time escalation at `escalationCapMs`. Feature-flagged off by default.

Files touched:
- `src/server/routes.ts` — POST /build/heartbeat handler (already present from prior session).
- `src/monitoring/ProxyCoordinator.ts` — `recordBuildHeartbeat` / `hasRecentBuildHeartbeat` / `clearBuildHeartbeat` (prior session).
- `src/monitoring/PresenceProxy.ts` — `hasRecentBuildHeartbeat` config + Tier 2/3 suppression (prior session); long-tool-wait detector (`recordAgentText`, `recordToolWait`, `getLongToolWaitMessage`, `updateToolWaitFromSnapshot`) wired into `fireTier2` and `fireTier3` (this session).
- `src/server/AgentServer.ts` + `src/commands/server.ts` — proxyCoordinator passed into routeContext + hasRecentBuildHeartbeat callback wired to PresenceProxy (prior session).
- `playbook-scripts/build-state.py` — `post_heartbeat()` helper called from `cmd_transition` and `cmd_complete` (this session).
- `tests/unit/proxy-coordinator-heartbeat.test.ts` (8) — record/has/clear semantics, default 6-min window, per-topic isolation.
- `tests/unit/build-heartbeat-route.test.ts` (12) — enum allowlists, runId regex, exactly-one-of-topic/channel, telegram/slack dispatch, ProxyCoordinator integration, 503 on missing transport.
- `tests/unit/presence-proxy-build-heartbeat-suppression.test.ts` (4) — Tier 1 NOT suppressed; Tier 2/3 suppressed when heartbeat is fresh; normal emission when no heartbeat.
- `tests/unit/presence-proxy-long-tool-wait.test.ts` (5) — off-by-default; threshold + hysteresis exit + escalation cap; per-topic.
- `tests/unit/build-state-heartbeat.test.ts` (5) — Python smoke test against a localhost fake server: phase POST, complete POST, no-op when env unset, best-effort on POST failure (audit log entry, no exit code), Slack channel routing.

Decision points touched: heartbeat suppression authority (PresenceProxy), heartbeat dispatch authority (POST /build/heartbeat), tool-wait swap authority (PresenceProxy.getLongToolWaitMessage).

## Decision-point inventory

- **POST /build/heartbeat** — *signal generator* — produces a typed `build-progress` event for ProxyCoordinator + dispatches a templated message. No block/allow on agent prose.
- **PresenceProxy heartbeat suppression** — *authority* — decides not to fire Tier 2/3 when heartbeat is fresh. Tier 1 deliberately exempt (first signal of life).
- **PresenceProxy long-tool-wait detector** — *signal generator + message swap* — feeds the existing standby authority a different templated string when tripped. Does not introduce a new block decision.

---

## 1. Over-block

**Heartbeat suppression.** Suppression applies only to Tier 2 (2-min) and Tier 3 (5-min) — never Tier 1 (20-sec). Tier 1's job is the first signal of life when the agent is busy; we want it to fire even when /build is producing heartbeats, so the user hears the standby voice within 20 seconds of a follow-up message. Verified: `presence-proxy-build-heartbeat-suppression.test.ts > does NOT suppress Tier 1 even when a build heartbeat is fresh`.

The suppression window is 6 min while heartbeats fire every ~5 min — one missed/delayed heartbeat does not unsuppress standby (worst case: a slightly stale "phase=executing" beats a "still working" generic). After the 6-min window with no fresh heartbeat, standby resumes — Tier 2 and Tier 3 are rescheduled when the suppression check fires (not cancelled). Verified by inspection of `fireTier`'s reschedule branch.

**Long-tool-wait detector.** Detector is OFF by default. When ON, the swap message replaces (not blocks) the LLM-generated standby — same channel, same tier, same authority, different content. The hysteresis-during-recovery branch suppresses the "blocked" message while sustained text is accumulating, so the user never sees "blocked" while watching new output appear.

---

## 2. Under-block

**Heartbeat suppression.** A single `recordBuildHeartbeat` call wins suppression for 6 min. If the /build skill crashes mid-run and never sends another heartbeat, standby resumes after 6 min — appropriate. If the channel sees a malicious heartbeat (an agent or attacker calls POST /build/heartbeat with junk content), the templated allowlist (phase + tool + status enums + runId regex + elapsedMs bounds) caps the blast radius — no free-form prose, no path leakage, no command injection. The dispatched message is structurally fixed.

**Long-tool-wait detector.** Off by default; the introduction release has zero behavioral change for unconfigured agents. The escalation cap (one-time alert at 30 min) prevents alert fatigue even in pathological hangs. Without escalation cap, an actually-hung tool would silently sit forever — escalation gives the user one explicit cue before going quiet.

The detector relies on snapshot-hash diff plus the `Cogitated for Nm Ns` marker. Snapshot hashes already exist in `PresenceState.tier1SnapshotHash` / `tier2SnapshotHash` for the duplicate-output check — we reuse them, no new state pressure.

---

## 3. Level-of-abstraction fit

POST /build/heartbeat lives at the server route layer alongside other typed-event endpoints (e.g. POST /telegram/post-update). Dispatch via `ctx.telegram.sendToTopic` matches existing routing surface for proxy-class messages. ProxyCoordinator is the right home for the `lastBuildHeartbeatAt` map — it already coordinates PresenceProxy ↔ PromiseBeacon mutex; adding a heartbeat-timestamp dimension keeps three-way deconfliction state in one place.

The long-tool-wait detector lives inside PresenceProxy — same class that owns Tier 2/3 message authority. Adding a detector here is the *minimum viable* change to that authority — we did not introduce a new monitor class. Per signal-vs-authority doc, detector + authority colocation in one class is acceptable when (a) the detector is a pure projection of state already maintained for other reasons (snapshot hashes), and (b) the detector is feature-flagged so its rollout can be reverted without touching the authority.

The build-state.py helper is the lowest-overhead surface for emitting heartbeats — phase transitions are the natural cadence point in the /build state machine. Stdlib-only (urllib.request, hashlib, os, socket) avoids any new Python dependency. Best-effort on failure preserves the build state machine's existing exit-code contract.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Heartbeat dispatch — *signal*. POST /build/heartbeat produces a templated event with enumerated fields and bounds; structural validation at the system boundary, no judgment call. Permitted per doc §"When this principle does NOT apply: Hard-invariant validation."
- [x] Heartbeat suppression — *authority*. PresenceProxy decides whether to fire Tier 2/3. Single-authority principle preserved: only one progress voice per channel per cycle.
- [x] Long-tool-wait detector — *signal generator that feeds the existing standby authority*. Detector produces a richer signal (tool identity + elapsed + zero-delta boolean); PresenceProxy remains the one authority deciding whether to send and what to say. No new blocking decision.
- [x] Tone gate fast-path — heartbeats are templated system messages, not agent prose. Skipping LLM tone-gate invocation is permitted under the structural-validator carve-out (gate_latency_vs_client_timeout memory item).

---

## 5. Interactions

- **PresenceProxy ↔ PromiseBeacon ↔ /build heartbeat** — three-way coordination via ProxyCoordinator. PresenceProxy reads `hasRecentBuildHeartbeat` before sending Tier 2/3 (suppress when /build is talking). PromiseBeacon's existing mutex acquire is unchanged. Heartbeat record is in a *separate* map from the mutex — heartbeats never hold the per-topic mutex, so they cannot starve other proxies.
- **Long-tool-wait detector ↔ heartbeat suppression** — order matters: heartbeat-suppression check (in `fireTier`) runs *before* the detector check (in `fireTier2`/`fireTier3`). If a heartbeat is fresh, Tier 2/3 is suppressed entirely — the detector swap never runs. This is correct: when /build is talking, we don't want to muddy the channel with the long-wait swap.
- **Detector ↔ existing snapshot-hash diff** — the detector reuses `state.tier1SnapshotHash` / `state.tier2SnapshotHash` already maintained by `fireTier1`/`fireTier2`. No new persistent state on disk; the per-topic `toolWaitState` map lives in the in-memory PresenceProxy instance, lost on restart (acceptable — Tier 2/3 cycles re-establish baselines).
- **build-state.py ↔ POST /build/heartbeat** — the helper is best-effort with a 2s timeout. If the local instar server is down or 401s, the audit log records `heartbeat.skipped` and the transition succeeds. The build state machine's exit-code contract is preserved.
- **Routes registry test** — adding POST /build/heartbeat is a new surface; `route-completeness.test.ts` (existing) iterates handlers, may need update if it asserts a fixed count.

Verified by running new test suite (34 tests across 5 files) and adjacent regression tests (presence-proxy-* and build-state.test.ts, 64 + previous tests).

---

## 6. External surfaces

- **Other agents on the machine:** none — each agent has its own server + ProxyCoordinator instance.
- **Install base:** new POST /build/heartbeat endpoint; pre-fix /build skills won't call it (no-op). Post-fix /build skills running against pre-fix server will get 404 — caught by best-effort try/except in build-state.py, logged to audit, transition continues.
- **External services:** Telegram and Slack adapters dispatch the heartbeat text. No external credentials touched. Outbound message is templated → no PII / secret leakage path.
- **Persistent state:** none. ProxyCoordinator and PresenceProxy detector state are in-memory only.
- **Telemetry:** new `heartbeat.skipped` audit event in `.instar/state/build/audit.jsonl` when POST fails. Bounded by 200-char error string; no body content stored.
- **Timing:** 2s POST timeout for build-state.py heartbeat (worst-case 2s overhead per phase transition; happy-path <50ms locally).

---

## 7. Rollback cost

**Per spec §Rollback** — both fixes are independently revertable.

- **Fix 2 rollback (heartbeat).** Revert the five files touched (server routes + monitoring + commands + build-state.py). No persistent state to migrate. ProxyCoordinator's `lastBuildHeartbeatAt` is in-memory and lost on restart. PresenceProxy falls back to standard standby behavior. Channels just stop seeing the templated `🔨 /build —` line.

- **Fix 3 rollback (detector).** Two paths:
  1. **Config flip** — set `longToolWaitDetector.enabled: false` in PresenceProxy config. Zero deploy. Detector becomes inert; existing behavior restored.
  2. **Hard revert** — remove the detector code blocks from PresenceProxy.ts and the test file. Tier 2/3 LLM-summary path is the original, untouched.

Cost: ~5 min via config flip, ~30 min via hard revert + test update. No data loss either way.

---

## 8. Acceptance evidence

- POST /build/heartbeat handler at `src/server/routes.ts:4158` with full validation + dispatch + ProxyCoordinator integration.
- PresenceProxy Tier 2/3 suppression at `src/monitoring/PresenceProxy.ts:617` (untouched from prior session).
- Long-tool-wait detector public methods (`recordAgentText`, `recordToolWait`, `getLongToolWaitMessage`) on PresenceProxy.
- build-state.py `post_heartbeat()` called from `cmd_transition` and `cmd_complete`.
- New tests: 34 passing across 5 new test files.
- TypeScript: `npx tsc --noEmit` clean.
- Adjacent regressions: presence-proxy-cancel-race, presence-proxy-idle, presence-proxy-quota, presence-proxy-context-exhaustion, build-state — all green.
