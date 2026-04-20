# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

Stage B of the lifeline robustness work. Two new self-healing mechanisms, both addressing the same pattern observed in the Bob (2026-04-19) and Dawn (2026-04-20) incidents: a long-running lifeline drifting into a state where it receives Telegram updates but cannot forward them, rescued only by a human operator.

**1. Version handshake.** The Telegram lifeline includes its semver in every `/internal/telegram-forward` request as the JSON field `lifelineVersion`. The server validates structurally (regex + 64-char cap) and compares MAJOR/MINOR with its own cached version. On mismatch, server returns 426 Upgrade Required with a reconstructed canonical `serverVersion`. The lifeline's forward path uses typed errors (`ForwardVersionSkewError`, `ForwardBadRequestError`, `ForwardServerBootError`, `ForwardTransientError`) so 426 short-circuits Stage A's retry (`isTerminal` predicate) and triggers a restart request through the new `RestartOrchestrator`. PATCH drift > 10 emits a pure-observability `TelegramLifeline.versionSkewInfo` signal with no blocking effect. Missing `lifelineVersion` is accepted (backward compat with pre-Stage-B lifelines) and emits a `TelegramLifeline.versionMissing` observability signal. Dev mode (empty authToken) skips the handshake to avoid an unauth'd fingerprinting channel.

**2. Stuck-loop watchdog + RestartOrchestrator.** New `LifelineHealthWatchdog` runs every 30 s and tracks three deterministic signals:
- `noForwardStuck` — oldest queued message older than 10 min (anchored on `QueuedMessage.timestamp`, NOT "time since last success" — the latter would crash-loop low-traffic agents)
- `consecutiveFailures` — >20 consecutive non-2xx responses from `forwardToServer`
- `conflict409Stuck` — consecutive409s pinned >5 min (0→>0 edge timestamp in `TelegramLifeline.poll`)

Signals fire in fixed priority (`conflict409Stuck > noForwardStuck > consecutiveFailures`) producing exactly one DegradationReporter event per restart. Latched signals re-evaluate at rate-limit window expiry. The `noForwardStuck` signal is suppressed when `supervisor.getStatus().healthy === false` to avoid double-firing with existing server-down recovery.

The new `RestartOrchestrator` is a single-owner state machine (`idle → quiescing → persisting → exiting`) that serializes all restart initiators (watchdog tick, 426 handler, external SIGTERM). Step 1 quiesces Telegram polling, replay, and watchdog timers BEFORE persist so the queue snapshot is causally consistent. Step 2 emits the signal. Step 3 persists all state files in parallel (2 s budget). Hard-kill `setTimeout(5000)` guard fires `process.exit(1)` if persist hangs. Rate limit: one restart per 10 min per bucket, with versionSkew additionally capped at 3 per 24 h. `state/last-self-restart-at.json` holds a 50-entry history ring buffer with 0600 mode and atomic tmp+rename writes; fail-closed on corruption, allow-and-overwrite on future timestamps (breaks a deadlock). Storm escalation: 6 restarts within 1 h fires a distinct `TelegramLifeline.restartStorm` signal outside normal per-feature cooldown.

**3. Supporting infrastructure.** New `state/lifeline-started-at.json` pid-bearing marker written on every startup (cold boot, self-restart, external kickstart — all paths). The new `instar lifeline restart` CLI polls this marker (pid delta) rather than `last-self-restart-at.json` because `launchctl kickstart` is an external restart that doesn't invoke the self-restart code path. CLI also checks `.instar/shadow-install/.updating` lockfile (waits up to 60 s) to avoid respawning against a half-written install. Unsupervised mode (not under launchd, no `INSTAR_SUPERVISED=1`) emits signals and logs but skips `process.exit` to keep local testing sane. Thresholds configurable under `lifeline.watchdog.*` in project config; invalid values fall back to defaults + emit `TelegramLifeline.configInvalid` signal. `state/last-self-restart-at.json` is excluded from backup snapshots (machine-local operational state).

**Signal-vs-authority compliance.** DP1 (server-side policy) is an API-boundary structural validator under the hard-invariant exemption. DP2 (lifeline-side restart policy) is operational self-heal on the lifeline's own process — it constrains no other agent's behavior, filters no message flow, and blocks no user action. The sole output is "I, the lifeline, restart myself." Restart is fully reversible via launchd respawn.

## What to Tell Your User

- **Self-healing for stuck helpers**: "I can now notice if my Telegram helper gets stuck in a weird state and restart myself, instead of going silent."
- **Version coordination**: "If my main program and my helper end up on different versions, they now work it out automatically — my helper restarts to pick up the right code."
- **Safer shutdown**: "When I restart myself, I now pause everything first so no messages get lost in the middle of saving."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Version handshake on forward-to-server | Automatic — included in every `/internal/telegram-forward` request |
| Stuck-loop self-restart | Automatic — every 30 s watchdog tick |
| `instar lifeline restart` | CLI command — triggers `launchctl kickstart`, polls pid-marker |
| Storm-escalation alert | Automatic — fires after 6 restarts in 1 h |
| Configurable watchdog thresholds | `.instar/config.json` → `lifeline.watchdog.*` |

## Evidence

This change includes two categories of coverage:

**Unit tests (84 new tests across 7 files, all passing):**
- `tests/unit/lifeline/versionHandshake.test.ts` — 15 tests covering parseVersion semantics (regex, length cap, malformed rejection) and compareVersions semantics (match, patch-info boundary at exactly 10, MAJOR/MINOR rejection, canonical serverVersion reconstruction).
- `tests/unit/lifeline/rateLimitState.test.ts` — 17 tests covering read outcomes (missing / corrupt / future / ok), decide semantics (cooldown, version-skew-daily-cap, storm detection), atomic write with 0600 mode, history ring-buffer cap.
- `tests/unit/lifeline/forwardErrors.test.ts` — 4 tests covering isTerminal classification.
- `tests/unit/lifeline/startupMarker.test.ts` — 5 tests covering write/read round-trip and fail-safe reads.
- `tests/unit/lifeline/LifelineHealthWatchdog.test.ts` — 9 tests covering idle-agent safety (empty queue never trips), `noForwardStuck` only fires with non-empty queue AND old oldest-item AND healthy server, consecutiveFailures threshold, conflict409Stuck threshold, priority ordering when multiple signals trip, signal latching + de-cross, starvation signal.
- `tests/unit/lifeline/RestartOrchestrator.test.ts` — 5 tests covering state progression (idle→quiescing→persisting→exiting), re-entrance suppression, unsupervised-mode skip-exit, supervised-mode exit code 0, hard-kill timer fires on hung persist.
- `tests/unit/lifeline/retryWithBackoff.test.ts` — 1 new test: isTerminal short-circuit consumes zero additional attempts.
- `tests/unit/server/telegramForwardHandshake.test.ts` — 8 tests covering accept-on-match, 426 on MAJOR/MINOR mismatch with reconstructed serverVersion, 400 on malformed/over-long input (no echo), accept on absent lifelineVersion (backward compat), dev-mode empty-authToken path, 503 on unparseable serverVersion.

**Live verification — not reproducible in dev**: The original Bob/Dawn failure modes (7-day lifeline accumulating protocol state, version skew post-`npm i`) require wall-clock durations and deployment races that cannot be induced locally. Stage C (chaos tests) is queued as the follow-up fix that will exercise these paths under simulated failure. Stage B's correctness is gated on the 84 unit tests above plus the 4-round convergent review (4 internal lenses + GPT-5.4 + Gemini-3.1-Pro + Grok-4.1-Fast) that surfaced and closed 28 material findings before implementation began.

Side-effects artifact: `upgrades/side-effects/lifeline-self-restart-stage-b.md`
Spec: `docs/specs/LIFELINE-SELF-RESTART-STAGE-B-SPEC.md`
Convergence report: `docs/specs/reports/lifeline-self-restart-stage-b-convergence.md`
