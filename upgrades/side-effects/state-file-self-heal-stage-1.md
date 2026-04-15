# Side-Effects Review — State-File Self-Heal (Stage 1 of 3)

**Version / slug:** `state-file-self-heal-stage-1`
**Date:** `2026-04-15`
**Author:** `echo`
**Second-pass reviewer:** `required — touches boot sequence and session lifecycle`

## Summary of the change

Closes the three highest-frequency "missing state file bricks the agent" failure modes directly observed in production outages over the past week (luna 2026-04-08, inspec 2026-04-09, ai-guy 2026-04-09, inspec 2026-04-15). Each of the three sites that actually caused an outage is converted to self-heal instead of throwing:

1. **`src/scheduler/JobLoader.ts`** — missing `.instar/jobs.json` now logs a warning and returns `[]` instead of throwing `Jobs file not found`. Scheduler already handles an empty list, so fresh-install and partial-state agents boot normally.
2. **`src/core/MachineIdentity.ts`** + **`src/core/MultiMachineCoordinator.ts`** — new `ensureSelfRegistered()` method self-registers the current machine if it's missing from `.instar/machines/registry.json` at coordinator init. Closes the registry-wiped-by-sync case where `updateRole` hard-throws on unknown machineIds.
3. **`src/commands/setup.ts`** + **`src/lifeline/TelegramLifeline.ts`** — extracted `ensureBootWrapper()` that regenerates the missing `instar-boot.{js,cjs}` + `instar-boot.sh` entry points while a live process still exists to do so. Called from the Lifeline's existing self-heal path alongside the node-symlink self-heal. Prevents "launchd can't relaunch us after we die" dead-ends.

Tests: 3 new tests on `ensureSelfRegistered` (missing-entry, idempotent, post-registration updateRole works); 1 existing JobLoader test rewritten from "throws for missing file" to "returns empty list for missing file"; all 104 tests across the two touched files pass.

**Scope is deliberately narrow.** This is Stage 1 of a 3-stage plan. Stage 2 will introduce a shared `StateFileRecovery` helper (read-with-backup-on-corrupt, defaults fallback, DegradationReporter integration) and convert `.instar/config.json` malformed-JSON handling as the first consumer. Stage 3 will add `StartupPreflight` (validates the remaining critical files — identity + signing/encryption keys — at boot with actionable exit) and an `instar doctor` command. The decision to ship this as three stages instead of one mega-PR follows the cross-model review guidance from 2026-04-09 (staged canary deployment to avoid one-bug-breaks-all-agents).

## Decision-point inventory

- `MultiMachineCoordinator.start()` (src/core/MultiMachineCoordinator.ts:114) — **modify** — new call to `ensureSelfRegistered` at line 130, runs after `this._identity = loadIdentity()` and before `securityLog.initialize()` / heartbeat init / any role-update path.
- `TelegramLifeline` periodic self-heal hot-path (src/lifeline/TelegramLifeline.ts:~1648) — **modify** — adds `ensureBootWrapper()` call alongside the existing node-symlink self-heal.
- `JobLoader.loadJobs()` (src/scheduler/JobLoader.ts:34-44) — **modify** — removes a fatal throw on missing file; warns and returns `[]`.

No new gates, no new filters, no new authorities. These are structural invariants at the boot/restart boundary — the kind of hard validators the signal-vs-authority doc explicitly permits.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — this change removes blocks, it doesn't add any.

The inverse risk exists: could it *accept* something illegitimate that the old throw would have rejected?

- **JobLoader** — if a user intentionally deletes `.instar/jobs.json` they now get a boot with no jobs instead of a loud failure. This matches the existing "no jobs configured" state for a fresh install, and the scheduler already handles an empty list. The warning still surfaces "create the file to configure recurring jobs" so the silence isn't invisible. Acceptable.
- **ensureSelfRegistered** — self-registers with role `standby` if the machine is missing. A malicious actor who wipes the registry *cannot* escalate themselves to `awake` via this path — `standby` is the most conservative role and any leadership transfer goes through the existing election mechanism which requires valid signatures from other machines. Verified in `MultiMachineCoordinator` election code path.
- **ensureBootWrapper** — only writes files the installer already writes during `instar init`. No new files, no new shell content. The regenerated wrapper is byte-identical to the one the installer creates.

---

## 2. Under-block

**What failure modes does this still miss?**

This Stage 1 patch closes 3 of the 6 fatal paths identified in the audit. Still missing (explicitly deferred to Stage 2/3):

- **Malformed `config.json`** — still throws. A corrupt config (merge conflict, bad JSON from manual edit) will still crash startup before any of the Stage 1 self-heal fires. Covered in Stage 2 by `StateFileRecovery.readWithBackup()`.
- **Missing `.instar/machine/identity.json`** — `MultiMachineCoordinator.initialize()` loads identity *before* `ensureSelfRegistered`, so if identity itself is gone the load throws first and the self-heal never runs. Covered in Stage 3 by `StartupPreflight`.
- **Missing signing/encryption key PEMs** — raw ENOENT on first use. Covered in Stage 3.
- **`jobs.json` exists but is malformed** — still throws at `JSON.parse`. Only missing file is handled; malformed JSON drops into the existing error path. This is a deliberate scope-narrow: malformed handling needs the shared backup-and-default helper (Stage 2) to avoid silent data loss.

All of these failure modes are tracked in the task list. None are newly introduced by this change; they are pre-existing and explicitly out of scope for Stage 1.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Mostly yes, with one noted asymmetry:

- `JobLoader.loadJobs` handling missing-file inline is the right layer — the loader owns the semantics of "what does no jobs file mean" and "empty list" is the correct semantic.
- `ensureSelfRegistered` on `MachineIdentityManager` is the right layer — the registry invariant is "machines that exist should be in the registry" and the identity manager owns the registry.
- `ensureBootWrapper` on `setup.ts` is the right *module* (the installer module owns wrapper content) but being called from the Lifeline's self-heal hot-path feels one layer off. A cleaner future shape is a dedicated `BootInfrastructureMonitor` or consolidated `SelfHealOrchestrator` that owns detect → attempt → verify → retry for all of these (matches the [own-the-lifecycle pattern](.instar/memory/feedback_own_the_lifecycle_pattern.md) we've adopted for session watchdog). Stage 2/3 will extract this — explicitly flagged here so we don't forget.

No existing higher-level gate is being shadowed or duplicated. `DegradationReporter` is the relevant existing signal consumer; Stage 1 uses `console.warn` + `console.log` for self-heal events and Stage 2 will migrate these to `DegradationReporter.report()` once the shared helper exists. This is a known follow-up.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] **No — this change has no block/allow surface.** The three sites *remove* fatal throws or *add* self-registration/self-heal. None of them evaluate agent-generated messages, filter outbound content, gate dispatch, or make a judgment call about what a message "means."
- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The only "decision" logic present is deterministic state-mechanics: `if file missing → create it with defaults`, `if registry entry missing → register with most-conservative role`. These are hard-invariant validators at the boot boundary, which the principle doc explicitly allows as exceptions: "Typing and structural validators at the boundary of the system are not decision points... these belong at the API edge and are fine as brittle blockers." Boot-time state mechanics are the structural equivalent.

No LLM context, no message content, no conversational state is consulted. Correct by design — there is no judgment surface.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** `ensureSelfRegistered` runs before the existing `heartbeatManager` init in `MultiMachineCoordinator.initialize()`. Heartbeat depends on a populated registry — this is the intended ordering. Previously, a wiped registry crashed at the first `updateRole` call which was after heartbeat init; that crash path is now closed. No shadowing of a check that needs to fire — the old path was pure crash.
- **Double-fire:** `ensureBootWrapper` is idempotent — `if (fs.existsSync(jsPath) && fs.existsSync(shPath)) return false`. The Lifeline self-heal hot-path runs periodically; it will no-op on every call after the first successful regeneration. No write amplification.
- **Races:** the Lifeline self-heal runs on a single timer, not concurrent with itself. `ensureBootWrapper` uses `fs.writeFileSync` which is atomic-enough for this case (single writer, no concurrent read-modify-write). `ensureSelfRegistered` calls `loadRegistry` → conditional `registerMachine` → `atomicWrite`; the existing `atomicWrite` uses a `.tmp` + rename pattern which is safe against partial writes. `start()` has no explicit lock, so two concurrent calls *could* both observe an empty registry and both call `registerMachine`; in that race the second re-registers with identical content via `atomicWrite`, which tolerates the overlap (same machineId, same role, same content). Outcome is benign. The idempotency test (`"is a no-op when machine already registered"`) covers the serialized case, not the concurrent case — concurrent correctness relies on `atomicWrite` + identical-content-on-rewrite.
- **Feedback loops:** none. Self-heal events produce log output and a boolean return; they do not re-trigger downstream paths that could call back into the self-heal.
- **Lifeline loop amplification:** specifically checked — the new `ensureBootWrapper` call is inside the existing node-symlink self-heal try/catch block, which is gated by the same `shouldSelfHeal` condition. No new timer, no new polling path.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** no. Every self-heal operates on the agent's own `.instar/` directory. No cross-agent state is written.
- **Other users of the install base:** yes — this is shipping as a published instar version, so every agent on auto-update will inherit the changes at next update cycle. Behavior change is *strictly additive* (previously-fatal errors now recover), so existing working agents see no difference. Existing broken agents (e.g., inspec-equivalent state) will recover on next boot.
- **External systems:** no. No network calls, no API shape changes, no file-format migrations.
- **Persistent state:** `ensureSelfRegistered` will add a registry row on agents that previously lost theirs. Content is identical to what `instar init`/`instar pair` would write. `ensureBootWrapper` will regenerate boot wrapper files; content is identical to what `instar init` writes. No schema changes, no data migrations needed.
- **Timing:** the Lifeline self-heal hot-path runs on an existing timer we control. No new timers, no dependency on external runtime conditions.
- **Log surface:** three new `console.warn`/`console.log` lines. Warning text clearly attributes self-heal to its source (`[MachineIdentity]`, `[setup]`, `[JobLoader]`). Monitoring tools that alert on warn/log counts may see a one-time uptick on affected agents at boot; this is desired visibility.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure code change with no schema migration, no persistent-state format changes, and no user-visible protocol changes. Rollback path:

- **Hot-fix release:** revert the five touched files (or the commit) and ship as next patch. Agents will receive the revert on next auto-update.
- **Data migration:** none needed. Self-registered machines stay in the registry post-revert — that's the correct state; the post-revert code just won't regenerate them if wiped again. Regenerated boot wrappers stay on disk — identical content to what the old installer would have written, so no issue.
- **Agent state repair:** none needed. No agent will be in a state that is incompatible with the reverted code.
- **User visibility during rollback:** none. Self-heal is silent from the user's perspective unless they are looking at agent logs.

Estimated rollback time: one patch release. No downtime, no orchestration. This is about as cheap a rollback as changes to instar get.

---

## Conclusion

Stage 1 is a narrowly-scoped, deliberately-additive change that closes the three fatal paths responsible for all four observed outages in the past week. It is structurally compliant with signal-vs-authority (no judgment surface), has clear rollback cost (one patch revert), and defers the remaining three fatal paths + shared recovery helper + preflight to Stages 2 and 3 — which is the correct staging per the cross-model review's guidance on canary rollouts.

Clear to ship after second-pass review concurs.

---

## Second-pass review (if required)

**Reviewer:** `general-purpose subagent (independent read, 2026-04-15)`
**Independent read of the artifact: concur — ship Stage 1.**

Signal-vs-authority compliance, under-block honesty, rollback-cost claim, and Stage 1/2/3 split all hold up against the code. Four follow-up observations raised, none blocking:

1. **Artifact method name** — original draft said `MultiMachineCoordinator.initialize()`; actual method is `start()` at line 114. **Fixed in this artifact** (decision-point inventory now references `start()` at 114, ensureSelfRegistered call at line 130).
2. **Concurrency claim was too strong** — original draft asserted "second will no-op." Actual: `start()` has no lock, so two concurrent callers could both pass the existence check and both re-register; outcome is still benign (identical-content atomicWrite), but the claim is softer than originally written. **Fixed in Section 5 Races** with the correct weaker claim.
3. **Extension-selection logic duplicated** — `ensureBootWrapper`'s `usesCjs` detection is a second copy of the rule inside `installBootWrapper`. Drift risk if the installer's rule changes. **Follow-up**, tracked for Stage 2/3 extraction into a shared `resolveBootWrapperPaths()` helper.
4. **`start()` not idempotent at top level** — pre-existing, not introduced by this change; repeated `start()` calls create new HeartbeatManagers. **Flagged for Stage 3 `StartupPreflight`** which will own boot-path idempotency.

Ship Stage 1 as-is with the artifact corrections now applied. Observations 3 and 4 roll forward as explicit task items.

---

## Evidence pointers

- Test output: `tests/unit/JobLoader.test.ts` (40 tests pass), `tests/unit/machine-identity.test.ts` (64 tests pass including 3 new `ensureSelfRegistered` cases).
- Typecheck: `npx tsc --noEmit` exits clean.
- Outage reproduction evidence:
  - inspec 2026-04-15: missing boot wrapper reproduced and recovered via manual `installBootWrapper()` call; new `ensureBootWrapper()` does the same work automatically.
  - inspec 2026-04-09: wiped registry → `updateRole` throws; reproduced in a test fixture and shown green with `ensureSelfRegistered`.
  - luna (jobs file corruption class): `loadJobs('/nonexistent/jobs.json')` previously threw, now returns `[]` — `JobLoader.test.ts` verifies.
- Task tracking: Stage 2 (config.json + StateFileRecovery helper) and Stage 3 (identity/keys + StartupPreflight + doctor) are explicitly tracked in the session TaskList and will ship as separate instar-dev passes.
