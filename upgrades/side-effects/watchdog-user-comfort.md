# Side-Effects Review — Watchdog user-comfort (MCP exclusion + notification silencing)

**Version / slug:** `watchdog-user-comfort`
**Date:** `2026-04-19`
**Author:** Echo
**Second-pass reviewer:** required (touches "watchdog" / session lifecycle)

## Summary of the change

Two related fixes to `SessionWatchdog` and its server wiring.

1. **Broaden MCP exclusion** (`src/monitoring/SessionWatchdog.ts`). The `EXCLUDED_PATTERNS` array shifts from string-only substring matching to mixed string + regex. A generic `-mcp` / `-mcp-server` token regex is added so any future MCP stdio server (workspace-mcp, foo-mcp, @scope/bar-mcp, etc.) is auto-excluded without code changes. This closes the workspace-mcp regression where Luna (SageMind) had her Google Workspace MCP server killed because the exclusion list caught MCP servers by literal name.
2. **Silence routine watchdog notifications** (`src/commands/server.ts` + new `src/monitoring/watchdog-notifications.ts`). Ctrl+C and SIGTERM interventions stop being relayed to Telegram/Slack. Only SIGKILL and KillSession — the "gentle recovery failed" levels — produce user-visible messages, in plain English with no raw commands, no "SIGKILL/SIGTERM/watchdog/escalation" jargon. The separate `recovery` event is no longer relayed to user channels at all, because announcing recovery of a problem we never announced is noise.

Files touched:
- `src/monitoring/SessionWatchdog.ts` — `EXCLUDED_PATTERNS` type widened to `Array<string | RegExp>`, `-mcp` regex added, `isExcluded()` extended to handle both kinds.
- `src/monitoring/watchdog-notifications.ts` — new, one exported function `formatWatchdogUserMessage(event) → string | null`.
- `src/commands/server.ts` — intervention handler routes through `formatWatchdogUserMessage`; recovery handler removed from user channels.
- `tests/unit/SessionWatchdog-mcp-exclusion.test.ts` — new, 14 cases covering workspace-mcp, generic shapes, pre-existing exclusions, and over-match negatives.
- `tests/unit/watchdog-notifications.test.ts` — new, 7 cases covering null-returning levels and jargon-free wording for kill levels.

## Decision-point inventory

- `SessionWatchdog.isExcluded(command)` — **modify** — broadens the set of processes that short-circuit the entire stuck-check path (never escalates).
- `watchdog.on('intervention')` message-emit in server.ts — **modify** — now only emits for SIGKILL/KillSession, with plain-English text.
- `watchdog.on('recovery')` message-emit in server.ts — **remove** — handler deleted from user-facing channels.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The MCP exclusion regex matches any token ending in `-mcp` or `-mcp-server`. Realistic over-matches:

- A one-off script literally named `my-mcp` (not an MCP server) would be excluded from watchdog kill. Impact: low. If someone's ad-hoc script hangs, they'd manually kill it; this is the same fallback the watchdog already relies on for every other excluded pattern.
- An argument like `--config=foo-mcp` to an unrelated tool: the regex requires `(?=$|[\s/])` after, so `--config=foo-mcp` matches (followed by end-of-string) and excludes. Consequence: that process would not be killed as stuck. This is the same safety bias as the existing `/mcp/` literal match in the prior code.

For the notification silencer: no over-block surface. SIGKILL/KillSession events still fire; only the user-facing Telegram/Slack relay changes. Console logs and `watchdog-interventions.jsonl` are untouched.

---

## 2. Under-block

**What failure modes does this still miss?**

- The MCP pattern is string-based and can be tricked by a legitimately-stuck process named `foo-mcp` that is *not* an MCP server. Trade-off accepted: false-negative cost (user's ad-hoc mis-named script isn't auto-killed) is much lower than false-positive cost (killing a real MCP server, which is what just happened to Luna's workspace-mcp).
- For the notification silencer: a SIGTERM-level intervention that the user *would* have wanted to know about (e.g. repeated firing on the same session) is now silent. Partial mitigation: the intervention log still records everything. Future work could add a "repeated-intervention digest" that surfaces patterns at a higher level — that's a new signal feeding the attention queue, not in scope here.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

- `isExcluded` is a **detector** / short-circuit that runs *before* the LLM gate. Broadening it means fewer LLM-gated paths for MCP servers. That's the right layer — LLM gate is backup; the exclusion list is the "obviously safe" fast path, and MCP stdio servers are in the same category as caffeinate and playwright-persistent (by design long-lived).
- `formatWatchdogUserMessage` is a **presentation-layer** function. No decision authority over whether to kill — just over whether and how to surface. Correct layer: the watchdog itself still owns the recovery logic; this function owns user communication.

A smarter gate does not already exist for "should we tell the user about this intervention." The alternative (feed interventions into the tone gate / attention queue / stall nurse) would be over-engineering for a decision this simple: level >= SIGKILL is the threshold.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no new block/allow surface in the "judgment" sense.

The MCP exclusion is a fast-path short-circuit on a destructive action (process kill). Per the doc's "safety guards on irreversible actions" carve-out: brittle matchers that fail *open* (skip the kill, let the process keep running) on a destructive path are the correct pattern. The LLM gate downstream still runs for everything not in the exclusion list.

The notification silencer is pure presentation — it decides *what to say*, not *whether to permit an action*. No judgment authority involved.

---

## 5. Interactions

- **Shadowing:** The MCP regex adds to `EXCLUDED_PATTERNS`, which runs before the LLM gate in `checkSession`. It shadows the LLM gate only for the expanded set (MCP servers) — which is desired. Literal patterns like `playwright-persistent`, `mcp-stdio-entry`, `caffeinate`, `.claude/shell-snapshots` remain and still match the same commands they did before (confirmed by the "pre-existing MCP exclusions still work" test block).
- **Double-fire:** The intervention emit now returns early for Ctrl+C/SIGTERM instead of sending a message. No double-send risk.
- **Races:** No shared state added. `formatWatchdogUserMessage` is pure.
- **Feedback loops:** Telegram messages previously sent by the watchdog could arrive in the tmux session's topic and be seen by the session itself. Silencing Ctrl+C/SIGTERM notifications removes a minor self-feedback path (agents observing their own watchdog noise) — marginally positive.
- The `pre-existing-exclusions-still-work` test covers `playwright-persistent`, `mcp-stdio-entry`, `exa-mcp-server`, `caffeinate`. No removals.

One subtle point: I did remove the specific strings `playwright-mcp`, `@playwright/mcp`, `claude-in-chrome-mcp`, `payments-mcp`, `exa-mcp-server` from EXCLUDED_PATTERNS because the new `-mcp` regex subsumes them. The regression test explicitly verifies exa-mcp-server still matches via the regex. `playwright-persistent` kept as-is (it doesn't end in `-mcp`).

---

## 6. External surfaces

- **Other agents on the same machine:** Every instar agent inherits this watchdog behavior. After deploy, all agents stop sending Ctrl+C/SIGTERM/"recovered" wrench-emoji messages on their Telegram topics and Slack channels. Users of the install base will see less noise. No breaking change to API contracts.
- **Other users of the install base:** This is a reduction in volume of messages only; no action required on their part.
- **External systems:** No change to Telegram/Slack API usage beyond "fewer messages sent."
- **Persistent state:** `watchdog-interventions.jsonl` continues to record all interventions unchanged.
- **Timing/runtime:** No new timing dependencies. The `formatWatchdogUserMessage` call is synchronous.

---

## 7. Rollback cost

**Pure code change — revert and ship a patch.** No persistent state modified. No migration. If a user starts complaining "I want the Ctrl+C notifications back," ship a small config knob; existing intervention logs provide retroactive visibility. Estimated rollback: one revert commit + server restart on affected installs. No data repair.

If the `-mcp` regex causes a real stuck-mcp-like process to go un-killed, a user can still manually intervene and we can tighten the regex in a patch. Intervention log will record any non-actions.

---

## Conclusion

Both fixes ship together because they address the same user-facing incident: Luna's workspace-mcp got killed AND the user saw three jargon-filled messages about it. Fixing only one leaves either the silent kill or the loud noise. Tests cover both the regression (workspace-mcp now excluded) and the principle (no jargon in user messages). 37 existing watchdog tests still pass. No signal-vs-authority violation. Cleared to ship pending second-pass concurrence.

---

## Second-pass review (if required)

**Reviewer:** general-purpose subagent (independent)
**Independent read of the artifact: concern → resolved → concur**

First-pass concern raised: the original `-mcp` regex used `[\w.@]+` which excludes hyphens, so multi-hyphen names like `claude-in-chrome-mcp` silently failed to match. Additionally `@playwright/mcp` (bare `mcp` after `/`) and `bar-mcp-server.js` (file-extension suffix) were not covered. Because the artifact removed those literals from EXCLUDED_PATTERNS on the false assumption the regex subsumed them, this was a real exclusion regression.

Resolution:
1. Character class widened to `[\w.@-]+` so multi-hyphen names are consumed whole.
2. Trailing lookahead relaxed to `(?=$|[\s/.])` so `-mcp-server.js` and similar entry files match.
3. Added a second regex for package-style `@scope/mcp` where the last token is bare `mcp`.
4. Added explicit regression tests for `claude-in-chrome-mcp`, `@playwright/mcp` (npx and path forms), `bar-mcp-server.js`, `payments-mcp`, and `exa-mcp-server` in npx-style invocation. All pass.

Updated test suite: 63/63 pass (19 new MCP exclusion cases + 7 notification cases + 37 pre-existing watchdog tests).

Concur with the revised review.

---

## Evidence pointers

- Test run: `vitest run tests/unit/SessionWatchdog-mcp-exclusion.test.ts tests/unit/watchdog-notifications.test.ts` → 21/21 pass.
- Regression baseline: `vitest run tests/unit/SessionWatchdog-pipeline.test.ts tests/unit/SessionWatchdog-compaction.test.ts` → 37/37 pass.
- Typecheck: `npx tsc --noEmit` → 0 errors.
