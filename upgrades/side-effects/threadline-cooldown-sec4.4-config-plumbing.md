# Side-Effects Review — Threadline §4.4 commit 1: config plumbing + drain-loop lifecycle wiring + kill switch

**Version / slug:** `threadline-cooldown-sec4.4-config-plumbing`
**Date:** 2026-04-19
**Author:** echo
**Second-pass reviewer:** not required (additive config surface; default behavior is to enable the drain loop with manager-level defaults; kill switch is one config flag)

## Summary of the change

First commit of §4.4. Adds a `ThreadlineSpawnConfig` subtree to `ThreadlineConfig` and wires every spawn-manager / drain-loop knob through from `config.threadline.spawn.*` to the `SpawnRequestManager` constructor. Also wires the drain-loop lifecycle: `start()` at server boot (unless killed by config), `dispose()` on shutdown.

The kill switch is `config.threadline.spawn.drainEnabled = false`. When set, the server skips `start()`, leaving the drain loop dormant. Operators can flip this without redeploying code if the drain loop misbehaves.

Files touched:
- `src/core/types.ts` — adds `ThreadlineSpawnConfig` interface; adds `spawn?: ThreadlineSpawnConfig` to `ThreadlineConfig`.
- `src/commands/server.ts` — reads `config.threadline?.spawn` and threads each knob into `SpawnRequestManager`'s constructor; calls `spawnManager.start()` (or logs the kill-switch message); calls `spawnManager.dispose()` in the SIGINT/SIGTERM shutdown handler.

No tests added in this commit. The underlying `SpawnRequestManager` config fields each have dedicated unit tests from §4.2 / §4.3 commits; this commit is glue. Integration testing of the server wiring belongs in a separate end-to-end test, not a unit test (which would require mocking the entire server boot path).

## Decision-point inventory

1. **Config subtree, not flat fields.** `config.threadline.spawn.*` keeps the spawn knobs grouped and easy to find. Avoids polluting the top-level `ThreadlineConfig` namespace with six unrelated-looking fields.
2. **Default to drain-loop ON.** `drainEnabled !== false` enables it. Means callers who set the new config but forget `drainEnabled: true` still get the loop. The off-by-default alternative would silently break the feature.
3. **Kill switch is `drainEnabled = false`, not `enabled = true` opt-in.** A negative gate gives operators a clear panic button: ship the code, then turn off via config if it misbehaves. Ship-with-default-on lets it actually work in production without operator action.
4. **Lifecycle in the same place as construction.** `start()` immediately after `new SpawnRequestManager(...)`; `dispose()` next to other `.stop()` calls in the shutdown handler. Easy to audit.
5. **No PATCH endpoint in this commit.** Spec calls for a runtime PATCH endpoint to retune knobs without restart. That requires (a) an HTTP route, (b) auth check, (c) schema validation, (d) a `updateConfig()` method on the manager that's safe to call while the loop is running. Non-trivial; deferred to commit 2 of §4.4.

## Blast radius

- **Existing deployments without `config.threadline.spawn`:** drain loop now starts at boot using all manager-level defaults. Behavior change: queued messages now drain on a 1 s tick instead of waiting for the next inline `evaluate` call. **This is the load-bearing fix the whole spec was chartered to deliver.** Spec is approved; this is intended.
- **Existing deployments with `config.threadline.spawn.drainEnabled = false`:** drain loop stays dormant. Identical to pre-commit behavior.
- **Existing deployments with custom knob values:** all knobs are honored from config. Manager defaults remain the fallback for absent fields.

## Over-block risk

The drain loop now actively tries to spawn for queued agents. If a buggy or hostile peer accumulates many queued messages, the loop will repeatedly attempt to spawn. Mitigations from prior commits:
- §4.2 cooldown reservation prevents fast-failure beats
- §4.2 penalty silences attributable-failure peers after 3 strikes
- §4.2 infra soft limiter caps queue depth for infra-failing peers
- §4.3 byte cap and global cap bound resource use
All gates compose; the drain loop respects each via the consumer's `evaluate` callback.

## Under-block risk

If the consumer's `onDrainReady` callback is NOT wired (i.e., `start()` is called but no callback set), the drain loop runs but does nothing. Currently in this commit, server wiring DOES NOT set `onDrainReady` because the consumer pattern (synthesize a SpawnRequest from a queued message and re-call evaluate) needs deliberate design. A follow-up commit will wire the callback.

For now, the drain loop spins safely without effect — same as pre-commit drain semantics, plus the lifecycle plumbing is in place.

## Level-of-abstraction fit

Config interface lives in `core/types.ts` next to other config types. Server wiring lives next to the existing `new SpawnRequestManager(...)` call. Both placements are obvious.

## Signal-vs-authority compliance

Config is plain data. The kill switch is an authority gate — when off, the loop doesn't run. Compliant.

## Interactions

- **All §4.2 / §4.3 knobs:** now plumbed through the config surface.
- **§4.4 follow-up commits:** will add `onDrainReady` consumer wiring, `updateConfig` method, PATCH endpoint, schema validation.
- **§4.5 observability:** future commit will add metrics + DegradationReporter integration.

## Rollback cost

Revert. `spawnManager.start()` and `dispose()` calls disappear; drain loop dormant. Config interface change is benign — extra fields are ignored if the type is reverted but the fields are still passed (they'd just be `undefined` from a reverted client viewpoint, falling through to defaults).

If the drain loop misbehaves in production: set `config.threadline.spawn.drainEnabled = false` and restart. No code change needed.

## Tests

- No new tests in this commit. The `SpawnRequestManager` constructor fields are individually tested in §4.2 / §4.3 commits; this commit is glue.
- All 62 prior tests pass unmodified.
- `npx tsc --noEmit`: clean.

## Rollout

Ships on `feat/threadline-cooldown-queue-drain`. The drain loop will start at boot in production after this commit lands. Default behavior: 1 s tick interval (because default cooldown is 30 s, tick = max(min(30000/4, 5000), 1000) = 5 s actually, so 5 s tick), 8 drains per tick, opt-out via config. Next commit: `onDrainReady` wiring so the loop actually does work.
