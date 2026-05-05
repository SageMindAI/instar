---
spec: telegram-markdown-renderer
pr: 3
status: default-flip
default-behavior-change: yes — outbound Telegram sends now route GFM markdown → HTML by default
rollback: config flip (`telegramFormatMode = 'legacy-passthrough'` in `.instar/config.json`)
---

# Side-effects review — Telegram markdown renderer (PR3: default flip + per-call override)

## Summary

PR3 finishes the cutover the spec called for. Two coupled changes:

1. Flip the shipped default in `applyTelegramFormatter` from `'legacy-passthrough'` to `'markdown'`. Agents that have not set `telegramFormatMode` in `.instar/config.json` (today: all of them) now route every outbound `sendMessage` / `editMessageText` through the formatter — markdown source → Telegram HTML, with `parse_mode='HTML'` on the wire. The headline effect: snake_case identifiers (`GITHUB_TOKEN`, `auto_triage_runs`) stop rendering as italics on Telegram.

2. Add a per-call mode override (`_formatMode` field on the `apiCall` params) and migrate the two server-internal callsites that produce literal Telegram HTML (`relayPrompt` and the attention-item creator) onto it. The override is the spec's "trusted internal callers list" mechanism — apiCall is private to the adapter, so only server-internal code can set the field. HTTP routes (`/telegram/reply/:topic`, etc.) cannot reach `_formatMode`; their text continues to flow through the configured mode.

Pre-existing legacy `*X*` (single-asterisk-bold) and `_X_` (underscore-italic) literals in dashboard message body and the mute-tip stay verbatim. They render slightly differently after the flip (italic / literal underscores) — accepted minor regression in exchange for byte-for-byte rollback under `'legacy-passthrough'`.

## Changes enumerated

### Source changes

| File | Change | Blast radius | Rollback cost |
|------|--------|--------------|---------------|
| `src/messaging/TelegramAdapter.ts` (`applyTelegramFormatter`) | Read optional `_formatMode` from params (per-call override). Strip before send. Default fallback: `callerMode ?? configMode ?? 'markdown'` (was `'legacy-passthrough'`). | All outbound `sendMessage` / `editMessageText` now run the markdown converter unless the agent has explicitly set `telegramFormatMode='legacy-passthrough'`. | Per-agent: set `telegramFormatMode='legacy-passthrough'` in `.instar/config.json` (hot accessor — picks up on next send). Source: revert this PR. |
| `src/messaging/TelegramAdapter.ts` (attention-item creator, ~line 2902) | Add `_formatMode: 'html'` to the `sendMessage` params alongside the existing `parse_mode: 'HTML'`. The text is already escaped Telegram HTML (built with `this.escapeHtml(...)` and literal `<b>`/`<i>` tags), so the formatter must passthrough. | Without this, the markdown converter would re-escape the `<b>` tags and they'd render as literal text. | Revert — but rollback path also restores legacy behavior (`legacy-passthrough` short-circuits before the formatter regardless). |
| `src/messaging/TelegramAdapter.ts` (`formatPromptMessage` + `relayPrompt`) | Switch prompt-gate output from legacy-Markdown source (`*X*`, `escapeMarkdown`) to HTML source (`<b>X</b>`, `escapeHtml`). Caller (`relayPrompt`) sets `parse_mode: 'HTML'` and `_formatMode: 'html'` on both branches (with-options and text-reply). Option labels HTML-escaped. Removed unused `escapeMarkdown` private method. | Prompt-gate messages now ship as HTML. Under markdown mode (new default): renders bold via `<b>`. Under legacy-passthrough rollback: still renders bold because Telegram honors caller's `parse_mode='HTML'`. | Revert. |
| `CLAUDE.md` | Updated module sketch to note new default (`'markdown'`) and the `_formatMode: 'html'` opt-out. | None functional. | N/A. |

### Test changes

| File | Change |
|------|--------|
| `tests/unit/telegram-format-wireup.test.ts` | Updated "bypasses formatter when mode is undefined" → now asserts the post-cutover default formats with markdown. Added three new tests: `_formatMode` override beats configMode (html-passthrough); `_formatMode` applies even when configMode is undefined; `_formatMode` flag stripped before send (legacy-passthrough opt-out via per-call). |

## Signal vs authority review

- `_formatMode` is a **per-call signal** from a server-internal caller saying "I already produced HTML, don't re-process me." The formatter remains the **authority** on outbound rendering — passthrough modes (`html`, `legacy-passthrough`) still flow through the helper and have their parse_mode decisions made there.
- HTTP-route callers cannot set `_formatMode` (the route handler does not plumb it from the JSON body to apiCall). Authority stays server-side. Spec's trusted-internal-callers list is enforced by the call graph, not a runtime allowlist — the simplest viable shape.

## Level-of-abstraction fit

- The override lives on `apiCall` params alongside the existing internal flags `_isPlainRetry` and `_idempotencyKey`. Same shape, same strip-before-send pattern. Right level.
- Default flip is a single `??` chain change. Right level.
- Prompt-gate migration moves emphasis markup from agent-Markdown source to HTML source so the same render works under both `markdown` (formatter passthrough) and `legacy-passthrough` (Telegram honors `parse_mode='HTML'`). One-shot, mechanical.

## Interactions

- **400-retry path**: unchanged. `_isPlainRetry` short-circuits the formatter the same as before. Verified by existing test.
- **Idempotency**: `_idempotencyKey` still stripped. Verified by existing test.
- **Tone gate / outbound gate**: runs at the `/telegram/reply` route layer, well upstream of `apiCall`. Not affected.
- **Lifeline**: also calls `applyTelegramFormatter` via its `currentFormatMode()` accessor. Same default flip applies — lifeline pings, attention queue notifications, and dashboard broadcasts all route through the formatter under the new default.
- **MessageStore**: stores rawText and sentText separately (PR1/PR2 envelope additions). Unchanged.
- **Existing agents on legacy-passthrough**: anyone who has explicitly set `telegramFormatMode: 'legacy-passthrough'` keeps that — `configMode` beats the new default fallback. Today no agent has set it explicitly, but the rollback path remains a single config flip.

## Accepted regressions

These three are accepted because each has a clean rollback path (set `telegramFormatMode='legacy-passthrough'`) and the alternative (changing the literal source) breaks the spec's byte-for-byte rollback contract:

| Literal | Pre-flip render (legacy `parse_mode='Markdown'`) | Post-flip render (`markdown` mode formatter) |
|---------|-----------------------------------------------|------------------------------------------|
| `*Tip*` (mute-topic suggestion) | bold | italic |
| `*Dashboard*` (broadcast heading) | bold | italic |
| `_This link is permanent…_` etc. (3 sub-text lines) | italic | literal underscores |

The first two are one-word emphasis on rare paths (one-shot per topic, one-shot per restart). The third is sub-text on the dashboard broadcast — readable without italic. None of these are core conversational rendering.

## Rollback

- **Per agent**: Edit `.instar/config.json`, add `"telegramFormatMode": "legacy-passthrough"`, restart server (config is read at startup; `getFormatMode` accessor returns the value live but the in-memory `config` object is set once). Pre-cutover behavior fully restored — the formatter short-circuits and `parse_mode` flows through from the callsite.
- **Source-level**: revert this commit. Auto-update propagates. No data migration, no schema change.

## Verification

- All 122 telegram-related unit tests pass locally (`telegram-markdown-formatter.test.ts` + `telegram-format-wireup.test.ts`).
- Type check (`tsc --noEmit`) passes.
- Direct Bot API canary: sent a markdown-mode formatter output (snake_case + bold + code + URL) into topic 8183 with `parse_mode='HTML'` — Telegram accepted (msg id 8903), no parse error. Visual confirmation pending from operator.
- Fleet flip: confirmed via auto-update on at least one second agent post-release. (To be reported in the release artifact.)
