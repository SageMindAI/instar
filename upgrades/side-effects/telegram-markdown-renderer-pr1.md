# Side-Effects Review — Telegram markdown renderer (PR1: formatter module, disabled)

**Version / slug:** `telegram-markdown-renderer-pr1`
**Date:** `2026-04-24`
**Author:** `echo`
**Second-pass reviewer:** `not required (no block/allow surface, no wiring into send paths, shipped disabled)`

## Summary of the change

PR1 of the two-PR plan in `docs/specs/TELEGRAM-MARKDOWN-RENDERER-SPEC.md` (approved 2026-04-24 by Justin via Telegram topic 8183). Adds a new pure-function module `src/messaging/TelegramMarkdownFormatter.ts` that ports Dawn's `telegram_format.py` (the-portal) to TypeScript, plus a Vitest test suite `tests/unit/telegram-markdown-formatter.test.ts` with 105 passing tests.

The module exports `formatForTelegram(text, mode)`, `format(text, mode)`, `lintTelegramMarkdown(text)`, and primitives (`escapeHtmlText`, `escapeHtmlAttribute`, `isSafeUrl`). It implements the spec's full 12-step markdown→Telegram-HTML pipeline, a balanced-paren URL scanner (Wikipedia-style parens), WHATWG URL scheme allowlist, distinct HTML-text vs HTML-attribute escapers, NUL + Supplementary-PUA-B stripping for sentinel-collision safety, a 32KB input guard that falls back to plain mode without byte loss (`conversionSkipped: true`), and a `legacy-passthrough` mode that returns input byte-for-byte unchanged with `parseMode: undefined` so callers retain their historical `parse_mode`.

**Critically, no send path is wired to this module.** `TelegramAdapter.ts` and `TelegramLifeline.ts` are untouched. The module is dead code at runtime until PR2 wires `apiCall()` behind the `telegramFormatMode` config accessor. PR2 ships with `legacy-passthrough` as the default, so PR1 has zero behavioral effect on any agent even after PR2 merges.

## Decision-point inventory

This PR contains no runtime decision points — the module is not called by anything. The future decision points it enables (documented here for completeness; all are PR2 scope):

- `TelegramAdapter.apiCall` — formatter invocation conditional on `method === 'sendMessage' || method === 'editMessageText'`. **Not in this PR.**
- `TelegramLifeline.apiCall` — same. **Not in this PR.**
- Trusted-internal-caller allowlist for `html` mode. **Not in this PR.**

Decision points inside the module itself (pure functions, no runtime authority):

- `isSafeUrl(raw)` — scheme allowlist (http/https/tg/mailto). Pure function; refuses unsafe schemes by returning `null`. Caller decides what to do with the rejection (emit literal text).
- `lintTelegramMarkdown(text)` — pure detector returning string array. Advisory-only; no blocking authority in this PR.
- 32KB length guard in `formatForTelegram` — falls back to plain mode on oversized input. Pure transformation; no network/storage side effect.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface in PR1 — module is not wired. Future-facing concerns the module itself introduces:

- `legacy-passthrough` mode emits no lint issues (by design — it's the rollback target and must be behaviorally identical to pre-cutover). A future operator might want lint-as-observation in passthrough mode; noted as open question for PR2.
- `isSafeUrl` rejects `javascript:`, `data:`, `file:`, `vbscript:`, and any non-allowlisted scheme. Rejected links become literal text (`[click](javascript:...)` rendered verbatim) — a legitimate agent-authored `tg://resolve?domain=foo` link is permitted (mode allowed). Wikipedia-style `https://...wiki/X_(y)` URLs parse correctly via the balanced-paren scanner (covered by fixture test).

---

## 2. Under-block

**What failure modes does this still miss?**

No block/allow surface in PR1. Module-internal known gaps (documented in spec, accepted as v1):

- Italic between emoji (`🎉*bold*🎉`) renders literal asterisks because the punctuation-class lookaround doesn't include emoji — accepted v1 per spec iteration-2 L4.
- `tg://` deep links are permitted (spec allowlists them); future spec may tighten.
- PUA-B range is stripped from input before sentinels are inserted — this means a user message legitimately containing PUA-B codepoints will lose those bytes. Near-zero real-world usage; accepted trade-off per spec. Not flagged as `truncated` because "byte loss" in the spec is reserved for the oversized-`<pre>` fallback.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The module is a pure string-transform library at the same layer as `MessageFormatter.ts`. It owns no I/O, no config reading, no network, no logging. It does not hold blocking authority. The decision "should this send happen at all?" stays with the adapter/lifeline chokepoints; the formatter only answers "given this text and mode, what bytes go on the wire?"

This is consistent with the spec's architectural intent: the formatter is a detector+transformer producing `{ text, parseMode, lintIssues }`, consumed downstream by the adapter which holds the authoritative send/no-send decision.

---

## 4. Signal vs authority compliance

Per `docs/signal-vs-authority.md`:

- **Lint is a signal, not an authority.** `lintTelegramMarkdown` returns canonical prose-string issues. It does not reject a send. The spec specifies lint-strict mode (which a downstream authority can consume to return 422) as PR2 scope; PR1's lint is purely observational.
- **Scheme allowlist is a deterministic transform, not a policy decision.** `isSafeUrl` is brittle-by-design (WHATWG URL + scheme set). It does not block a send — it causes a link to render as literal text. The outbound send still happens. This satisfies the "brittle logic must not hold blocking authority" rule: brittle logic (regex/parse) produces a transformation, not a decision to refuse a user action.
- **No sentinel, gate, watchdog, or sentinel-class name is introduced by this PR.**

Compliance: PASS.

---

## 5. Interactions

- No shadow/shadowed interactions in PR1 — module is not called by anything. Search confirms no existing import site.
- Module name collision check: `src/messaging/` contains `MessageFormatter.ts` (different purpose: envelope formatting) and no `TelegramMarkdownFormatter.ts` prior to this PR. No collision.
- Test file name: `tests/unit/telegram-markdown-formatter.test.ts`. No existing test file of that name.
- PR2 will introduce interactions with `TelegramAdapter.apiCall`, `TelegramLifeline.apiCall`, `MessageStore` (raw/sent fields), and `GitSyncTransport` (envelope flag). Those interactions get their own artifact at PR2 time.

---

## 6. External surfaces

**Does it change anything visible to other agents, other users, other systems?**

No. PR1 ships dead code. No route changes, no message format changes on the wire, no config schema changes applied (config fields `telegramFormatMode` / `telegramLintStrict` are spec'd but deliberately not added in PR1 — they land in PR2 alongside the wiring), no database changes, no envelope changes.

- Bot API: untouched — adapter still sends exactly the bytes it sends today with exactly the `parse_mode` it uses today.
- MessageStore: untouched.
- GitSyncTransport: untouched.
- Shell-script `.claude/scripts/telegram-reply.sh`: untouched.
- Agent dashboards / self-knowledge: untouched.

No timing dependencies, no conversation state dependencies.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Trivial. PR1 is a code-only addition with no runtime invocation. Rollback options in order of cost:

1. **Do nothing.** The module is not on any call path; a latent bug is invisible until PR2.
2. **Revert the merge commit.** Standard `git revert` — affects only two new files. No data migration, no agent state repair, no config flip.
3. **Fix forward.** The module is pure functions with 105 unit tests; most fixes ship as deltas.

PR2 itself is governed by the spec's staged-rollout (ships with `legacy-passthrough` default; canary via config flip). That's PR2's rollback story — out of scope for this artifact.

---

## Second-pass review

Not required. PR1 has no block/allow surface, no session-lifecycle surface, no sentinel/gate/watchdog, no coherence/idempotency/trust change, and is shipped disabled. High-risk criteria from Phase 5 are not met.

## Spec linkage

- Approved spec: `docs/specs/TELEGRAM-MARKDOWN-RENDERER-SPEC.md` (approved 2026-04-24T20:53:47Z by Justin via Telegram topic 8183).
- Convergence report: `docs/specs/reports/telegram-markdown-renderer-convergence.md`.
- Dawn reference impl: `the-portal/.claude/scripts/telegram_format.py` (merged 2026-04-24T17:57Z).
