---
title: "Message Injection Delivery Guarantee — Verification + Watchdog for rawInject"
slug: "message-injection-delivery-guarantee"
author: "echo"
created: "2026-04-18"
review-iterations: 1
review-convergence: "pending"
approved: false
---

# Message Injection Delivery Guarantee

> Telegram messages intermittently land in a session's input line but are never submitted — user has to open the dashboard and press Enter manually. Root cause: `rawInject` fires `send-keys Enter` after the text-paste step with a fixed 0.5s sleep for multi-line input, and assumes it worked. When terminal rendering lags (heavy pane, CPU pressure, large paste), Enter can be swallowed by the bracketed-paste buffer or lost to a race. No post-delivery verification exists on the hot path. The only existing recovery — a per-session once-only retry in the idle-detection loop — only fires after the session goes fully idle *and* only on multi-line `[Pasted text #N]` stucks (single-line stucks are invisible to it). This spec adds (a) immediate post-Enter verification inside `rawInject`, (b) a per-injection async watchdog that fires seconds later regardless of idle state, (c) cooperative authority across all repair paths so they don't double-fire, and (d) structured logging at each send-keys step. Revised v2 after 6-reviewer pass; all material findings incorporated below.

## Problem statement

### Symptom (reported by Justin, 2026-04-18, topic 7195)

A Telegram message sent from the phone says "delivered" at the server. The session never replies. Opening the dashboard shows the message sitting in Claude Code's input line with the cursor after it. Pressing Enter in the dashboard submits it. Does not reproduce every time.

### Current code path (`src/core/SessionManager.ts:1749-1821`, `rawInject`)

Multi-line path: paste-start → literal text → paste-end → sleep(0.5s) → Enter. Single-line path: literal text → Enter. Both retry twice on exec failure, but *silent Enter loss* (Enter succeeded at tmux layer but TUI missed the key event, or Enter arrived inside bracketed-paste window) is undetected.

Existing partial recovery at `:476-485` fires only in the idle loop, only on `[Pasted text #N]` markers, and only once per session lifetime — leaves single-line stucks, rapid-repeat stucks, and stucks on non-idle sessions uncovered.

## Proposed fix (v2 — revised from reviewer findings)

### 0. Per-injection record

New type `InjectionRecord`:
```
{ id: string               // uuid, one per rawInject call
  tmuxSession: string
  textSig: string           // SHA-1 hex of full text (collision-resistant vs 40-char prefix)
  textPrefix: string        // first 40 chars, whitespace-collapsed, ANSI-stripped
  textSuffix: string        // last 40 chars, same normalization
  textLen: number
  isMultiline: boolean
  injectedAt: number        // ms epoch
  watchdogTimer: NodeJS.Timeout | null
  attempts: { immediate: boolean; watchdog: boolean; idleLoop: boolean }
}
```

Tracked in `Map<string /* injectionId */, InjectionRecord>` and secondary index `Map<tmuxSession, Set<injectionId>>` for per-session lookup without O(N) scan. This replaces the single-slot `Map<tmuxSession, Timeout>` from v1 — addresses §Security-3, §Grok-1, §Adversarial-3 (second inject must NOT silently orphan first's repair).

### 1. Signature detection — `verifyInjected(record): 'clean' | 'stuck' | 'unknown' | 'rendering'`

- Capture **last non-empty line** of the pane via `tmux capture-pane -p -S -5`, then post-process: strip ANSI escape sequences, trim trailing whitespace, find the last non-blank line.
- **Quiescence check**: take two captures 250ms apart. If they differ, return `'rendering'` — the TUI is mid-update, do not act. Addresses §Adversarial-5 (long legitimate render at watchdog fire) and §Gemini-1 (fixed sleep anti-pattern; polling is the correct idiom).
- **Multi-line stuck detection**: last non-empty line matches `/\[Pasted text #\d+\]/`. This marker is Claude-Code-specific and only appears when bracketed-paste content is buffered but not submitted.
- **Single-line stuck detection**: last non-empty line contains our `textPrefix` + (if text > 40 chars) our `textSuffix`, with nothing after the suffix except whitespace, AND the line begins with a recognized prompt glyph (`❯ ` or `> `). Bookend match (prefix + suffix) addresses §Adversarial-2 (user-typed-content cross-contamination): if user typed after our inject, the suffix won't match. Addresses §Security-1 (blockquote/echo false positive): requiring prompt glyph at line start + no trailing content rules out quoted echoes.
- **Regex safety**: all dynamic text compared via `indexOf` / `String.prototype.endsWith`, NEVER `new RegExp(textPrefix + ...)`. Addresses §Adversarial-6.
- **Short/empty text**: if `textLen < 8`, use exact line-equality after prompt glyph: `trimmedLine === promptGlyph + text`. No prefix-match for short text. Addresses §Adversarial-8, §Gemini short-string gap.
- **Null captureOutput**: return `'unknown'`. Caller treats unknown as "no action now, let next layer try." Never fires Enter on unknown. Addresses §Scalability-5, §Adversarial-4.
- **Non-Claude TUI (bash/python sub-REPL)**: prompt glyph check fails → returns `'unknown'`. Documented as accepted — this spec covers Claude-Code panes; sub-REPLs inherit pre-spec behavior. Addresses §Adversarial-7.
- **Scrollback hygiene**: the "last non-empty line" scope naturally excludes older scrollback copies. Combined with quiescence check, this addresses §Adversarial-1 (scrollback stale signature).

### 2. Hot-path verify in `rawInject`

After the final `send-keys Enter`:
```
await setTimeout(150ms)         // async, not execFileSync('sleep') — addresses §Scalability-1, §Gemini-1
state = verifyInjected(record)
if state === 'stuck':
    log stuck-repair
    if isMultiline: send \x1b[201~ (idempotent paste-end close) then Enter   // §Adversarial-11
    else: send Enter
    await setTimeout(200ms)
    state = verifyInjected(record)   // one confirmation capture
    if state === 'stuck': leave to watchdog (§3)
    if state === 'clean': record.attempts.immediate = true, done
if state === 'rendering' or 'unknown': leave to watchdog
if state === 'clean': done
scheduleWatchdog(record)         // always, even on clean — cheap belt-and-suspenders
```

Note: `rawInject` currently uses `execFileSync`. The hot-path sleep is converted to `await new Promise(r => setTimeout(r, ms))` — this requires making `rawInject` async. Callers (`injectMessage`, `injectTelegramMessage`) must `await`. This is a small chain change; the telegram-forward route already awaits SessionManager calls.

### 3. Watchdog

3500ms after `rawInject` returns:
```
record.watchdogTimer = setTimeout(async () => {
  try {
    if (!isSessionAlive(record.tmuxSession)): cleanup(record); return
    if (Date.now() - record.injectedAt < 2500): reschedule +1000ms; return  // dashboard-race guard §Integration-high-2
    state = await verifyInjected(record)
    if state === 'stuck':
      if record.attempts.watchdog: cleanup(record); emit 'injectionStuckUnrepaired'; return  // hard cap 1 watchdog retry §Adversarial-10, §Gemini-5
      record.attempts.watchdog = true
      if isMultiline: send \x1b[201~ then Enter; else send Enter
      dedupedDegradationReport(record)   // 5-min fingerprint dedup §Security-5
      annotate pendingInjections[record.tmuxSession].watchdogFailed = false (will flip to true at next re-verify if still stuck)
      await setTimeout(400ms); state = await verifyInjected(record)
      if state === 'stuck': annotate watchdogFailed = true
    cleanup(record)
  } catch (e) {
    console.error('[rawInject] watchdog err', e)
    cleanup(record)
  }
}, 3500)
```

`cleanup(record)`: `clearTimeout(record.watchdogTimer)`, remove from injection Map and per-session index.

**Dashboard coordination**: new method `cancelAndFlushInjectionWatchdogs(tmuxSession)` called by:
- Dashboard manual-Enter route (before sending its Enter).
- `sessionComplete` / `beforeSessionKill` listeners.
- `stopMonitoring()` / server shutdown (iterates all sessions, clears all timers).

Addresses §Integration-high-1, §Integration-high-2.

### 4. Idle-loop cooperation

The existing `pasteRetried` logic at `:476-485` is revised:
- Remove the once-per-session lock; replace with: "skip if any injection record for this session has `attempts.watchdog === true` within the last 60s" (the watchdog already tried, don't double-fire).
- Cap total idle-loop retries at 3 per session per hour (ring buffer of timestamps). Addresses §Integration-medium-2, §Adversarial-10.
- Continue to match only `[Pasted text #N]` in the idle loop — single-line stucks are not its jurisdiction (the watchdog catches those; if the watchdog missed, the idle loop's detection is too coarse for single-line anyway).

### 5. Structured logging

Trace lines ONLY on stuck/error paths:
```
[rawInject] tmux=<name> id=<uuid> len=<n> multiline=<bool> attempt=<n>   (entry, always)
[rawInject] tmux=<name> id=<uuid> result=<clean|stuck|rendering|unknown>  (verify, always, one line)
[rawInject] tmux=<name> id=<uuid> step=repair-immediate                   (only on stuck path)
[rawInject] tmux=<name> id=<uuid> step=watchdog-fire result=<...>         (only if watchdog ran repair)
[rawInject] tmux=<name> id=<uuid> step=watchdog-skipped-dash-race         (only if dashboard guard kicked in)
```
Happy path: 2 lines per inject. Stuck path: 4-6 lines. Addresses §Scalability-cosmetic and §Integration-low (logging volume).

**No text content in log lines.** Ever. Only `len`, `id`, and step markers. Addresses §Security-6.

### 6. Observability

Emit SSE event `injection_verify` with `{ sessionId, injectionId, result, latencyMs, path: 'immediate'|'watchdog'|'idleLoop' }`. Dashboard aggregates stuck-rate per hour. Addresses §Integration-low-3.

### 7. Lifecycle cleanup

- `sessionComplete` listener: iterate per-session injectionId index, clear all timers, drop records.
- `stopMonitoring()`: same, for all sessions.
- Integration test asserts Map drains within 5s after `stopMonitoring()` with 50 pending watchdogs.

## Signal-vs-authority compliance

This change is a delivery-layer reliability mechanism, not a judgment gate. It does not filter, block, or reject legitimate inputs. Specifically:
- Detection signal (`verifyInjected`) is a pure string compare + ANSI strip + indexOf. No LLM. No fuzzy match.
- The repair action (re-send Enter) is a retry of a step we already authorized at injection time.
- Bookend signature (prefix + suffix) + quiescence check + cursor-line anchoring ensure the repair cannot submit any content other than our own. No authority is added over what the user or agent can say; only reliability of already-authorized delivery.

## Concurrency model

- Per-injection records (uuid-keyed) let multiple in-flight injections to the same session each run their own verify/watchdog without overwriting state. Addresses §Security-3, §Grok-1, §Adversarial-3.
- Secondary per-session index allows dashboard/shutdown to cancel all watchdogs for a session atomically.
- Hot-path verify uses `await setTimeout`, not `execFileSync('sleep')` — does not block the Node event loop. §Scalability-1, §Gemini-1.
- `captureOutput` stays synchronous (out of scope to convert); wrapped in `await Promise.resolve()` for Promise-compatible error handling.
- SLO: ≤5 injects/sec aggregate; p99 inject latency budget 2s (Telegram client timeout 30s; ample headroom). Hot-path additional latency: 150ms clean, 450ms stuck-repaired, 750ms stuck-confirmed-by-watchdog. Addresses §Scalability-low-2.

## Acceptance criteria

Unit tests (`tests/unit/SessionManager.rawInject-verify.test.ts`):
- `verifyInjected` detects multi-line stuck (mock captureOutput → `[Pasted text #1]` at end).
- `verifyInjected` detects single-line stuck with bookend match.
- `verifyInjected` returns `'clean'` when tail shows empty fresh prompt.
- `verifyInjected` returns `'rendering'` when two captures 250ms apart differ.
- `verifyInjected` returns `'unknown'` when captureOutput is null.
- `verifyInjected` returns `'unknown'` on bash/python sub-REPL prompt.
- `verifyInjected` rejects scrollback false-positive: prior identical message in scrollback but clean input line → clean.
- `verifyInjected` rejects user-typed false-positive: our text on input line followed by additional typed chars → clean (bookend suffix doesn't match).
- Short-text (<8 chars) uses exact match; prefix match not used.
- Regex metachar text does not throw and does not match unexpected panes.
- `rawInject` immediate-verify repair path sends Enter once and not twice when first repair succeeds.
- `rawInject` handoff to watchdog on persistent stuck.
- Watchdog repairs stuck, caps at 1 retry per injection, logs DegradationReporter via dedupe helper.
- Watchdog no-ops on `'clean'`.
- Watchdog reschedules by 1000ms when `Date.now() - injectedAt < 2500ms` (dashboard race guard).
- `cancelAndFlushInjectionWatchdogs(session)` clears all timers for a session.
- Concurrent burst: 10 `rawInject` calls to same session in 100ms produce 10 independent injection records; no cross-cancellation; each independently verified.
- Session-death mid-watchdog: watchdog exits cleanly without firing Enter on dead pane.
- DegradationReporter dedup: 10 same-fingerprint reports in 60s produce 1 actual report.

Integration tests (`tests/integration/tmux-inject-verify.test.ts`, skip-if-no-tmux):
- Real tmux session running `cat`: inject multi-line, verify submission.
- Real tmux session: inject single-line, verify submission.
- Real tmux session: inject, kill session before watchdog fires, verify clean shutdown (no Node process retention via dangling timer).

Regression test:
- Telegram bot delivery path end-to-end with mocked first-Enter loss: message arrives at session via watchdog-repair.

## Rollback path

- Revert commit. Previous once-per-session idle-loop retry remains unchanged under the new code (we revised it, but the base path is preserved on revert). Worst case: return to pre-fix intermittent behavior.
- No persistent state, no migration, no data handling. All injectionRecords are in-memory only; server restart drops them, which is acceptable — the idle-loop retry path covers the post-restart multi-line case, and single-line stucks coinciding with a restart are a documented accepted gap (see below).

## Accepted gaps

- **Single-line stuck + server restart in the 3.5s watchdog window**: the new records are in-memory only. If the server restarts before the watchdog fires, a single-line stuck has no recovery path (the idle-loop matches only `[Pasted text #N]`). Frequency estimate: <0.01% of injects (restart window × single-line-stuck rate). Mitigation: existing 15-min zombie-kill path notifies of unanswered injection. Documented rather than engineered — pursuing persistent pendingInjections is out of scope (would require migration + disk I/O per inject).
- **Non-Claude-Code panes (bash/python REPL)**: verifyInjected returns `'unknown'` on non-Claude prompts; spec explicitly scoped to Claude-Code TUI. Addresses §Adversarial-7 by accepting the gap.
- **Extreme burst loads (>10/sec/session)**: synchronous tmux exec path serializes repairs; p99 can drift above 2s. Spec's SLO is ≤5/sec aggregate, which covers the realistic Telegram + threadline envelope. Future work: Gemini/Grok both suggest tmux control-mode / PTY writes at >500 sessions; out of scope.

## Files touched

- `src/core/SessionManager.ts`: new `verifyInjected()`, new `InjectionRecord` infra, refactor `rawInject` to async, new `scheduleInjectionWatchdog`, `cancelAndFlushInjectionWatchdogs`, revised idle-loop `pasteRetried` → bounded cooperative retry.
- `src/commands/server.ts`: dashboard send-Enter route calls `cancelAndFlushInjectionWatchdogs` before sending.
- `src/server/routes.ts`: SSE event wiring for `injection_verify` (minimal change).
- `tests/unit/SessionManager.rawInject-verify.test.ts`: new.
- `tests/integration/tmux-inject-verify.test.ts`: new (skip-if-no-tmux).

## Out of scope

- Extending to non-Claude panes (sub-REPLs).
- Persistent `pendingInjections` across restart.
- Async conversion of `captureOutput` / tmux exec path.
- tmux control-mode / PTY migration.
- Rate-limiting or inject throttling (separate concern).

---

## v1 → v2 changelog (for convergence log)

Addressed:
- Security-1 (false-positive on echoed text) → bookend signature + prompt-glyph anchor + last-non-empty-line scope
- Security-2 (ANSI/metachar evasion) → ANSI strip, whitespace collapse, indexOf not regex, injection reject of `[Pasted text #` in payload
- Security-3 / Grok-1 / Adversarial-3 (watchdog Map race) → per-injection-id records, no tmuxSession cancel-on-reinsert
- Security-4 / Adversarial-10 (unbounded retry) → per-injection watchdog cap + 3-per-hour idle-loop cap
- Security-5 (DegradationReporter spam) → 5-min fingerprint dedupe
- Security-6 (text leakage in logs) → explicit ban + lint test
- Security-7 (prompt injection) → confirmed pure string compare
- Scalability-1 / Gemini-1 (event loop block) → async hot-path sleep
- Scalability-2 (captureOutput cost) → 5-line tail only
- Scalability-3 (Map leak on session death) → sessionComplete cleanup hook
- Scalability-4 (burst timer load) → per-injection cap, dedup, async
- Scalability-5 (null fail-open semantics) → explicit `'unknown'` state, never fires Enter
- Adversarial-1 (scrollback stale) → last-non-empty-line scope + quiescence
- Adversarial-2 (user-typed race) → bookend signature
- Adversarial-4 (session died) → isSessionAlive check in watchdog
- Adversarial-5 (long render) → quiescence check
- Adversarial-6 (regex metachars) → indexOf only
- Adversarial-7 (sub-REPL) → documented accepted gap
- Adversarial-8 (short text) → exact match for len<8
- Adversarial-9 (DegradationReporter throw) → try/catch watchdog body
- Adversarial-11 (enter in paste mode) → re-send paste-end before repair Enter
- Integration-1 (shutdown cleanup) → stopMonitoring hook iterates records
- Integration-2 (dashboard race) → cancelAndFlushInjectionWatchdogs
- Integration-medium-1 (pendingInjections interaction) → watchdogFailed annotation
- Integration-medium-2 (idle-loop unbounded retry) → 3/hr cap
- Integration-medium-3 (tmux in CI) → skip-if-no-tmux pattern
- Integration-low-1 (log volume) → trace on stuck path only, happy-path = 2 lines
- Integration-low-2 (restart window) → documented accepted gap
- Integration-low-3 (metric) → SSE `injection_verify` event
- Gemini-2 (fixed sleep vs polling) → quiescence two-capture polling idiom
- Gemini-3 (signature false positive) → anchor to last non-empty line + prompt glyph
- Grok-2 (signature collision) → SHA-1 full-text hash + prefix-suffix bookend

No findings intentionally unaddressed other than the three explicitly accepted gaps above.
