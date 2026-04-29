# Spec — Lifeline self-heal hardening (Inspec post-mortem follow-through)

**Date:** 2026-04-29
**Author:** echo
**Status:** in-flight

## Background

On 2026-04-29, Inspec (instar agent in monroe-workspace) crashed silently. Post-mortem found three stacked failures:

1. **Stale better-sqlite3 binary.** A previous successful self-heal on 2026-04-21 was silently undone by a later auto-update reinstalling the library from a cached prebuild compiled for an older Node ABI. The in-process detector that would re-trigger the heal never ran because the server couldn't boot.

2. **Preflight self-heal missed the bad binary.** `ServerSupervisor.preflightSelfHeal()` checks `shadow-install/node_modules/better-sqlite3/...` (hoisted path), but the actually-loaded binary was at `shadow-install/node_modules/instar/node_modules/better-sqlite3/...` (nested under the instar package — npm did not hoist on this machine).

3. **RestartOrchestrator refused to exit-for-self-heal.** The orchestrator's "is launchd-managed?" detection relies on `process.ppid === 1`, which catches **system-domain launchd** but **NOT user-domain launchd** (`gui/501/...` — every macOS user-installed agent). With `isSupervised=false`, the orchestrator logged "would restart but unsupervised; skipping exit" and stayed in the crash-loop.

## Goal

Make this exact failure mode (auto-update reinstall + nested binary + missed self-heal + refused restart) impossible. After this change ships, an agent in the same shape should auto-recover within one supervisor cycle (≤ 30s) without human intervention.

## Scope (must-haves)

### Change 1 — Robust launchd-supervision detection

**File:** `src/lifeline/detectLaunchdSupervised.ts` (new), `src/lifeline/TelegramLifeline.ts` (call site).

Replace:

```ts
const isSupervised =
  process.env.INSTAR_SUPERVISED === '1' ||
  process.env.NODE_ENV !== 'test' && process.ppid === 1;
```

With a multi-signal detector that returns true if **any** of:

- `process.env.INSTAR_SUPERVISED === '1'` (explicit opt-in, dev override).
- `process.ppid === 1` (system-domain launchd / init).
- On `process.platform === 'darwin'`: parent process command name is exactly `launchd`. Resolved via `spawnSync('ps', ['-p', String(process.ppid), '-o', 'comm='])` and string-trim equality. Catches **user-launchd-managed** processes (the actual production case).
- On `process.platform === 'linux'`: parent command name in `{ 'systemd', 'init' }` resolved the same way. Catches systemd-managed services without requiring INSTAR_SUPERVISED to be plumbed into the unit file.

Cached at first call — supervision parentage doesn't change at runtime, so we don't re-poll `ps` on every check. `NODE_ENV === 'test'` short-circuits to `false` so unit tests never accidentally pass the gate.

### Change 2 — Path-aware better-sqlite3 preflight

**File:** `src/lifeline/ServerSupervisor.ts` (`preflightSelfHeal`, lines 404–455).

Today the preflight only checks `shadow-install/node_modules/better-sqlite3/build/Release/better_sqlite3.node`. Replace the single hard-coded path with **a scan** of `shadow-install/node_modules/**/better-sqlite3/build/Release/better_sqlite3.node` (bounded depth 5, glob done via `fs.readdirSync` — no new dependency). For every binary found, run the require-load probe with the server's Node. If any copy fails the probe, run `npm rebuild better-sqlite3` from the **directory containing that copy's `package.json`** (so each nested copy is rebuilt against its own deps).

Bounded depth and a hard cap of N=5 binaries scanned — a normal install has at most 2 copies (top-level + nested-under-instar). If we hit the cap, log + bail to the legacy path so we never spin on a pathological tree.

### Change 3 — Bind-failure escalation in supervisor

**File:** `src/lifeline/ServerSupervisor.ts` (around `handleServerUnhealthy` / restart loop, ~line 1100).

Today the supervisor restarts on health-failure with exponential backoff and trips a circuit breaker after N total failures. The escalation is "give up." Add:

- Track `consecutiveBindFailures` — incremented when the server **never reaches a healthy `/health` response** within the spawn window (i.e., the spawn produced a process that crashed before binding the port). Distinguished from "crashed mid-run" via the `spawnedAt` → first-healthy-tick latency: if the crash arrives before any healthy tick, count it as a bind failure.
- On `consecutiveBindFailures >= 2`, before the next `spawnServer()`, force a more aggressive heal pass: delete and re-extract the better-sqlite3 binary by running `npm rebuild better-sqlite3 --force` (skipping the prebuild-install fast path) for **every** discovered nested copy, then retry. This is the path that would have rescued Inspec without me.
- Reset `consecutiveBindFailures` on any successful health tick.

### Change 4 — INSTAR_SUPERVISED in plist template + one-time self-heal

**File:** `src/commands/setup.ts` (`installMacOSLaunchAgent`, plist template ~line 1164).

Add to the `<EnvironmentVariables>` dict in the generated plist:

```xml
<key>INSTAR_SUPERVISED</key>
<string>1</string>
```

This makes Change 1 redundant in the happy path — but Change 1 still matters because it covers existing-install agents whose plists predate this change, and because the orchestrator should not need a setup-injected env var to know what every system call can already tell it.

**One-time self-heal:** in `TelegramLifeline.startup`, if running on darwin, parent is launchd, and `INSTAR_SUPERVISED` is not in the env, write a one-line log line — no plist-rewrite from the running lifeline (rewriting a launchd-loaded plist while it's loaded is racy). The next `instar setup --reconfigure` (or fresh install) will pick up Change 4 directly. Lifeline-side detection (Change 1) closes the gap meanwhile.

## Non-goals

- Not changing the better-sqlite3 self-heal *script* (`scripts/fix-better-sqlite3.cjs`) — its logic was correct as of PR #91; the bug is upstream of it (preflight didn't find the file to ask the script to fix).
- Not changing the auto-updater. The auto-update reinstall behavior is correct in isolation; the durability comes from re-detecting after every reinstall, which Change 2 + Change 3 handle.
- Not changing the in-process detector inside `AgentServer` (it doesn't run when the server can't boot, so it's not on this code path).

## Acceptance criteria

1. **Reproduction test for the original failure.** Mock a `better_sqlite3.node` file at the **nested** path (`shadow-install/node_modules/instar/node_modules/better-sqlite3/build/Release/`) that fails the require-load with the right NODE_MODULE_VERSION error. Run `preflightSelfHeal`. Expect: scan finds the nested copy, attempts rebuild, logs the rebuild, returns "better-sqlite3 rebuilt …" in the healed list.

2. **Launchd-supervised detection.** Unit-test `detectLaunchdSupervised()` against four parent-process scenarios: ppid=1 (linux), parent=launchd (darwin), parent=systemd (linux), parent=zsh (any — should return false in non-test). Verify cache behavior (second call doesn't re-spawn ps).

3. **Bind-failure escalation.** Simulate two consecutive spawns that fail before binding. Expect: on the third attempt, the aggressive rebuild runs first. Reset on any successful health tick.

4. **Plist template adds env var.** Snapshot test of the generated plist contains `<key>INSTAR_SUPERVISED</key>\n<string>1</string>`. Validates with `plutil -lint`.

## Signal-vs-authority compliance

This change does not add brittle blocking authority. Decision-points:

- **`detectLaunchdSupervised`** — produces a structural signal (am I run by launchd?). The downstream consumer (RestartOrchestrator) is the authority. The signal is structural (parent process identity), not judgmental.
- **`scanBetterSqlite3Copies`** — produces a list of file paths. No authority.
- **`consecutiveBindFailures` counter** — produces a numeric signal. The escalation path inside the supervisor uses a fixed threshold (≥2) which is a deterministic mechanic, not a judgment call (cf. signal-vs-authority.md "Idempotency keys and dedup at the transport layer").

The rebuild action itself is a recovery primitive, not a block/allow decision. Per the principle, "Safety guards on irreversible actions" can be brittle — but this isn't even a safety guard; it's a recovery action.

## Rollback

Pure code change. Revert + ship as a patch. No persistent state changes. No user-visible regression during rollback window.
