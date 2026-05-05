# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The underscore-as-italic bug on outbound Telegram messages is fixed. Snake_case identifiers like `GITHUB_TOKEN`, `auto_triage_runs`, and any other word with an underscore inside it stop rendering as italics on Telegram. This was happening because instar was sending messages with `parse_mode: 'Markdown'`, and Telegram's legacy Markdown treats `_word_` as italic.

The fix flips the formatter default — the GFM-to-HTML formatter that PR1 + PR2 wired in (shipped disabled in v0.28.76) is now the shipped default. Outbound `sendMessage` and `editMessageText` now route GitHub-flavored markdown → Telegram HTML. Underscores stay literal because HTML doesn't treat them as anything special.

Two server-internal callsites (the attention-queue creator and the prompt-gate relay) already produced Telegram HTML directly. They migrate to a per-call `_formatMode: 'html'` opt-out so the markdown converter doesn't re-process their `<b>` tags. The override is reachable only from inside the adapter — HTTP routes cannot set it from the JSON body — which is the spec's "trusted internal callers list" enforced by the call graph rather than a runtime allowlist.

## What to Tell Your User

**Telegram messages from your agent now render correctly.** Things like `GITHUB_TOKEN`, `auto_triage_runs`, and `snake_case_function` will appear exactly as written instead of rendering with random italic styling. Bold text (`**important**`) and code blocks (`` `func()` ``) work as expected. No action needed on your side — the fix lands automatically when your agent auto-updates.

If the rendering ever looks worse than before for some reason, the rollback is one line in `.instar/config.json`: `"telegramFormatMode": "legacy-passthrough"`. Tell your agent and it will set this for you.

## Summary of New Capabilities

- **Markdown → HTML formatter (now default)** — GitHub-flavored markdown (`**bold**`, `` `code` ``, `# headings`, `- bullets`, `[text](url)`) is converted to Telegram HTML automatically on every outbound send. Underscores in identifiers stay literal.
- **Per-call HTML opt-out (`_formatMode: 'html'`)** — server-internal apiCall callers that already produce Telegram HTML can tag their send to bypass the markdown converter. Used by the attention-queue creator and the prompt-gate relay.
- **Rollback knob (`telegramFormatMode` in `.instar/config.json`)** — `'legacy-passthrough'` restores byte-for-byte pre-cutover behavior. Hot-reloadable accessor — picks up on next send after the config is saved.

## Evidence

- Side-effects review: `docs/specs/side-effects/telegram-markdown-renderer-pr3.md`.
- Spec: `docs/specs/TELEGRAM-MARKDOWN-RENDERER-SPEC.md` — converged 2026-04-24, approved by Justin same day.
- Direct Bot API canary (snake_case + bold + code + URL) accepted by Telegram with `parse_mode='HTML'`, no parse error.
- Tests: 122 telegram formatter unit tests pass; 373 push-tier tests pass; type check clean.
