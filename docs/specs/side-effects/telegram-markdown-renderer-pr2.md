---
spec: telegram-markdown-renderer
pr: 2
status: shipped-disabled
default-behavior-change: none
rollback: config flip (`telegramFormatMode = 'legacy-passthrough'`)
---

# Side-effects review — Telegram markdown renderer (PR2: wire-up)

## Summary

PR2 wires the PR1 formatter into the two Bot API chokepoints
(`TelegramAdapter.apiCall`, `TelegramLifeline.apiCall`) behind a config
flag. The shipped default is `'legacy-passthrough'` — byte-for-byte identical
to pre-PR2 behavior. No agent sees a behavioral change from this merge.

## Changes enumerated

### Source changes

| File | Change | Blast radius | Rollback cost |
|------|--------|--------------|---------------|
| `src/core/types.ts` | Add `telegramFormatMode` + `telegramLintStrict` to `InstarConfig`. Optional; absence = legacy behavior. | None until set. | Zero — fields ignored when unset. |
| `src/messaging/TelegramAdapter.ts` | Add `getFormatMode` / `getLintStrict` accessors to `TelegramConfig`. Insert `applyTelegramFormatter()` call at top of `apiCall()`. Add 400 plain-retry path that suffixes idempotency key with `:fallback-plain`. Export `applyTelegramFormatter` for reuse by Lifeline + tests. | Every outbound Bot API call goes through the helper. In `legacy-passthrough` (default), the helper is a byte-for-byte pass-through — only the internal `_isPlainRetry` / `_idempotencyKey` keys are stripped before send, and neither was ever accepted by Bot API. | Config flip to `'legacy-passthrough'` (already default). |
| `src/lifeline/TelegramLifeline.ts` | Mirror the same `applyTelegramFormatter()` wire-up on the Lifeline's independent Bot API client. Reads `projectConfig.telegramFormatMode` on each call (hot-reloadable). | Independent Bot API client (lifeline pings, server-down notifications). Same default: passthrough. | Config flip. |
| `src/commands/server.ts` | Pass `getFormatMode` / `getLintStrict` closures into both `TelegramAdapter` constructor sites. Closures read live config on each call (hot-reloadable). | None behavioral — closures are only consulted inside the chokepoint we just added. | N/A. |
| `src/messaging/types.ts` | Add optional `alreadyFormatted?: boolean` to `TransportMetadata`. Observability-only; **receiver ignores it** (send-side authoritative). | None. Flag is unread by the sending path. | N/A. |
| `src/messaging/telegramFormatMetrics.ts` | New file. In-process counters (`format_applied_total`, `format_lint_issues_total`, `format_fallback_plain_retry_total`). No scrape endpoint yet — used for test assertions and future dashboard. | None. | Delete file. |
| `src/templates/scripts/telegram-reply.sh` | Add `--format <mode>` flag; forwards as `{"format": ...}` in POST body. No flag = server default. | Only affects newly scaffolded agents; existing agents keep their old script (server default handles missing field). | Revert template. |

### Docs / spec changes

| File | Change |
|------|--------|
| `docs/specs/TELEGRAM-MARKDOWN-RENDERER-SPEC.md` | Copied in from approved spec worktree. |
| `docs/specs/reports/telegram-markdown-renderer-convergence.md` | Copied in from convergence worktree. |
| `docs/specs/side-effects/telegram-markdown-renderer-pr2.md` | This file. |

### Test changes

| File | Change |
|------|--------|
| `tests/unit/telegram-format-wireup.test.ts` | New. Verifies: legacy-passthrough byte-for-byte; markdown mode converts + sets HTML parse_mode; editMessageText formats; plain/code modes; `_isPlainRetry` recursion guard; 400 plain-retry replays raw text with key suffix; hot-reload of mode. |

## Signal vs authority review

- `getFormatMode` is a **signal** reader — it reads what config says, nothing more.
- Actual authority (blocking / rejecting) lives in the existing 400-retry path
  on Bot API. If Telegram rejects the HTML, we fall back to raw text with the
  historical `parse_mode: undefined` behavior. No new blocking gate introduced.

## Level-of-abstraction fit

- Wire-up lives inside `apiCall()`, the lowest common chokepoint per the spec's
  "Pipeline ordering" section. This places formatting AFTER all rewrite gates
  (they run upstream in `send()`/`sendToTopic()`/dispatch paths that call
  `apiCall`) and BEFORE the Bot API HTTP call. Correct per spec.

## Interactions

- **Existing 400-retry in `send()`**: PR2 adds a second 400-retry layer inside
  `apiCall`. Order: apiCall-level plain-retry fires first (raw text, parse_mode
  stripped); if that also 400s, the `send()`-level retry path catches it. Tests
  confirm no infinite recursion via `_isPlainRetry` flag.
- **Rate-limit queue (429 handling)**: Unchanged. Formatting happens before
  fetch; 429 retries re-enter `apiCall` with the already-formatted params
  (via `_isPlainRetry` or the existing 429 recursion) and we set
  `_isPlainRetry = false` unchanged — correct, because a 429 is not a format
  error.
- **Idempotency keys**: PR2 introduces `_idempotencyKey` as an internal-only
  flag that the helper strips before the Bot API send. No existing callsite
  uses that name, verified by grep.

## Rollback cost

**O(1) config flip**: set `telegramFormatMode = 'legacy-passthrough'` in
`.instar/config.json` (or delete the field — same effect). Adapter/lifeline
read on every send, so the next outbound message uses the new mode without
restart.

If a deeper rollback is needed: revert this PR. No schema migration, no data
migration, no state cleanup.

## What is deliberately out of scope for PR2

- **Length-splitting module**: the spec's tag-aware splitter is a distinct
  component. The current codebase has no separate splitter; adding one is a
  PR3-scale change. PR2's 400 plain-retry covers the highest-value failure
  mode (entity parse errors) and mirrors the existing retry-without-parse_mode
  behavior the codebase already has.
- **`formatTemplate` helper + migrations**: spec's template-composition helper
  and the build-time lint that enforces it are deferred to PR3.
- **Audit-log caller enum**: we record metrics; structured audit events with
  the closed caller enum are PR3.
- **Prometheus scrape endpoint**: counters exist in-process; no HTTP endpoint
  wired yet. The existing metrics/dashboard work can pick these up with a
  one-line registration.
- **`/telegram/reply` body `format` field parsing**: the shell script sends it;
  the route does not consume it yet (deferred — shell-script is forward-
  compatible, no breaking change). This means `--format` from the CLI is a
  no-op against current main, but becomes live in PR3 without re-deploying the
  template.

## Canary plan

1. Merge PR2 with shipped default `'legacy-passthrough'`. No behavior change.
2. Post-merge, flip Echo's agent config: `telegramFormatMode: 'markdown'`.
3. Monitor Bot API 4xx rate + eyeball `scripts/verify-telegram-render.ts`
   fixtures at t=1h, t=6h, t=24h.
4. After 24h clean → expand to second agent.
5. After 72h clean across canary agents → flip shipped default.
