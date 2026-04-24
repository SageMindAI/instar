---
title: Telegram markdown renderer (server-side HTML formatter + lint + parse_mode migration)
slug: telegram-markdown-renderer
author: echo
review-iterations: 6
review-convergence: "2026-04-24T19:28:38Z"
review-completed-at: "2026-04-24T19:28:38Z"
review-report: "docs/specs/reports/telegram-markdown-renderer-convergence.md"
approved: true
approved-by: Justin
approved-at: "2026-04-24T20:53:47Z"
approved-via: "Telegram topic 8183"
approval-context: "Telegram topic 8183 'telegram markdown' 2026-04-24 — Justin asked Echo to port Dawn's formatter into instar. Dawn's impl lives in the-portal/.claude/scripts/telegram_format.py + telegram-reply.py (merged 2026-04-24T17:57Z). Spec must pass convergent review (internal + crossreview) before /instar-dev touches code. Iteration 1 corrected a factual error in the premise (instar uses parse_mode='Markdown', not 'HTML') and addressed 20+ findings."
---

# Telegram markdown renderer (server-side HTML formatter + lint + parse_mode migration)

## Problem

**Corrected premise** (iteration-1 finding from integration reviewer, refined in iteration-2): instar's outbound Telegram path is NOT uniform. The majority of send sites use `parse_mode: 'Markdown'` (`TelegramAdapter.ts` lines 722, 790, 1212, 3646, 3654; `TelegramLifeline.ts:1816`), but at least ONE callsite already uses `'HTML'` (`TelegramAdapter.ts:2889`, the onboarding/welcome path). The codebase mixes modes by callsite. Any spec that treats "current baseline = Markdown everywhere" is wrong; rollback must preserve per-callsite historical mode, not force Markdown on every send.

That matters because agent output is Claude-native GitHub-flavored markdown (`**bold**`, `` `code` ``, `# headings`, `| tables |`, `[text](url)`). Legacy Telegram Markdown uses `*bold*` (single asterisk) and has no syntax for headings or tables. The mismatch produces:

1. `**bold**` renders as literal `**bold**` (legacy Markdown doesn't understand double-asterisk).
2. `| table |` rows render as literal pipes; alignment is lost.
3. `# Heading` renders as literal `# Heading`.
4. Bracket-link `[text](url)` *does* work in legacy Markdown but breaks when the URL or text contains reserved chars because legacy Markdown has no standardized escape.
5. Any literal `_`, `*`, `` ` ``, `[` inside prose can silently open an unterminated entity, which makes the send fail or the rest of the message render incorrectly.

Dawn hit the same problem and landed a client-side fix at 2026-04-24T17:57Z (`the-portal/.claude/scripts/telegram_format.py` + `telegram-reply.py`). Her fix lives in the CLI client; any send path that bypasses that script bypasses the fix. Instar has multiple bypass paths (jobs, dispatch, attention-queue, lifeline pings, MCP-triggered sends, direct route POSTs) so a client-side fix is structurally insufficient here.

This spec proposes: (a) migrate the outbound parse_mode from `Markdown` → `HTML`, and (b) add a server-side formatter that converts agent-authored GitHub markdown → Telegram HTML on every outbound path. Both together, because the HTML migration without the formatter is net-worse (current legacy Markdown handles `*italic*` and `[text](url)` reasonably; HTML mode without a formatter renders those literally too).

## Non-goals

- Not switching to `MarkdownV2`. MarkdownV2 requires escaping every reserved char in every non-formatting position — strictly worse operationally than HTML.
- Not rewriting message *content* (that's the tone / style / plain-language gates).
- Not supporting every GitHub markdown feature — only bold, italic, code, pre, headings, bullets, tables, links. (Reference-style links, footnotes, images, definition lists, strikethrough-via-tilde are out of scope.)
- Not adding any LLM call to the formatter. Pure deterministic string transformation.
- Not changing the `onboarding/welcome` path that already uses `parse_mode: 'HTML'` (it becomes a consumer of the new formatter like everything else).

## Solution

### Architecture: server is authoritative, shell script is a thin flag

**Layer 1 — server-side formatter (authoritative).** New module at `src/messaging/TelegramMarkdownFormatter.ts`:

```ts
export type FormatMode =
  | 'plain'            // HTML-escape; strip markdown to unicode (•, '')
  | 'html'             // passthrough for internal callers emitting Telegram HTML
  | 'code'             // wrap whole message in <pre>
  | 'markdown'         // convert GH markdown -> Telegram HTML (default)
  | 'legacy-passthrough'; // passthrough using parse_mode:'Markdown' (rollback)

export interface FormatResult {
  text: string;
  parseMode: 'HTML' | 'Markdown' | undefined;
  lintIssues: string[];
  modeApplied: FormatMode;
  truncated: boolean;
}

export function formatForTelegram(text: string, mode?: FormatMode): FormatResult;
export function lintTelegramMarkdown(text: string): string[];
```

The formatter returns BOTH the rendered text AND the `parse_mode` the caller should set. Previously the adapter hard-coded `'Markdown'`; after this change the adapter reads `parse_mode` from the formatter result, so a single config flip can select `markdown` (→ HTML) or `legacy-passthrough` (→ Markdown, passthrough) without another code change.

**Wiring point — corrected** (iteration-1 integration finding): the spec originally claimed a single `sendMessage` funnel. That's wrong. The real chokepoints are the private `apiCall()` methods:

- `TelegramAdapter.apiCall()` (`src/messaging/TelegramAdapter.ts:3996`) — used by `send()`, `sendToTopic()`, edit paths, attention queue, welcomes.
- `TelegramLifeline.apiCall()` (`src/lifeline/TelegramLifeline.ts:1837`) — duplicate Bot API client with its own token, bypasses the adapter entirely.

The formatter runs inside both `apiCall()` methods, conditional on `method === 'sendMessage' || method === 'editMessageText'`. This catches every send path, including the 6+ direct `apiCall('sendMessage', ...)` sites and the Lifeline's independent client.

**Layer 2 — shell-script convenience (thin).** `.claude/scripts/telegram-reply.sh` gains `--format <mode>` and `--lint-strict` flags. The flag is forwarded via `X-Telegram-Format` header (auth-gated — see Security) and a `format` field in the POST body. If absent, the server uses its configured default. The shell script does NOT re-implement formatting.

The shell script lives in `src/templates/scripts/telegram-reply.sh` (instar template distributed to every scaffolded agent). Existing agents keep their old script until they re-scaffold; the server default handles the missing-header case correctly, so older scripts continue to work.

### Modes — exact contract

- **`plain`** — HTML-escape `<`, `>`, `&`, `"`, `'`. Strip markdown down to unicode: `**bold**` → `bold`; `` `code` `` → `'code'`; `- bullet`/`* bullet`/`+ bullet` → `• bullet`; `# Heading` → `HEADING` (uppercased for emphasis). Lint rejects markdown tables. `parseMode: 'HTML'`.
- **`html`** — Passthrough. Reserved for internal callers already producing Telegram HTML (e.g. the onboarding welcome path). Runs ONLY when the caller identity is on the trusted-internal-callers list (see Security). `parseMode: 'HTML'`.
- **`code`** — Wrap message in `<pre>...</pre>`; inner content HTML-escaped. For tables and aligned monospace output. `parseMode: 'HTML'`.
- **`markdown`** (DEFAULT after cutover) — Convert GH markdown → Telegram HTML. Details below. `parseMode: 'HTML'`.
- **`legacy-passthrough`** (renamed from `legacy-passthrough` — iteration-2 INT-2): Passthrough, no conversion, `parseMode` is **whatever the callsite originally passed** (preserved via per-call override rather than global setting). Restores exact pre-cutover byte-for-byte behavior even for callsites that already use HTML (e.g. `TelegramAdapter.ts:2889` onboarding path). Implementation: when `legacy-passthrough` is the configured default, `apiCall()` passes `parse_mode` through from the caller's explicit argument unchanged, bypassing the formatter entirely. This is the true rollback target.

### Markdown conversion rules

Processing order matters for correctness. Exact sequence:

0. **Strip NUL bytes** (iteration-2 scalability finding S1): remove all `\x00` from input before any further processing. Placeholder sentinels use NUL-bracketed tokens (`\x00INSTAR_TOK_<n>\x00`); stripping up front eliminates collision risk. NUL is not legal in Telegram HTML anyway.
1. **Length guard**: if `text.length > 32768`, skip conversion and return `plain` mode output with a `conversionSkipped: true` flag (ReDoS defense — iteration-1 scalability finding). The distinct `truncated: true` flag is reserved for bytes-dropped cases (see Iteration-3 hardening).
2. **Extract fenced code blocks** (``` ``` fences ```) — replace with placeholder tokens. Inner content HTML-escaped, wrapped in `<pre>`.
3. **Extract table blocks** — contiguous lines matching `^\s*\|.+\|\s*$` with an alignment row (`^\s*\|[\s\-:|]+\|\s*$`). Escape inner text, wrap entire block in `<pre>`. Replace with placeholder tokens.
4. **Extract inline code spans** (`` `x` ``) — placeholder tokens; inner escaped, wrapped in `<code>`.
5. **HTML-escape remaining prose** (`<`, `>`, `&`, `"`, `'`).
6. **Bold-italic** (triple-asterisk, must run BEFORE steps 7-8 — iteration-3 GPT finding): `\*\*\*([^*\n]+?)\*\*\*` → `<b><i>$1</i></b>`.
7. **Bold**: `\*\*([^*\n]+?)\*\*` → `<b>$1</b>`. Not greedy, bounded by newline.
8. **Italic** (tightened — iteration-1 adversarial finding H1): `(?<=^|[\s(,.;:!?])\*(?!\s)([^*\n]{1,200}?)(?<!\s)\*(?=$|[\s),.;:!?])` → `<i>$1</i>`. Requires word-boundary-ish context on both sides; does NOT match `3*5`, `f(x) = x * y`, `a*b*c`.
9. **Headings**: `^(#{1,6})\s+(.+?)\s*#*\s*$` → `<b>$2</b>` (Telegram supports only bold, not h1-h6).
10. **Bullets**: `^(\s*)[-*+]\s+` → `$1• `.
11. **Links** (balanced-paren scanner — iteration-3 Gemini finding): NOT a regex. Find every `[` / `](` sequence. For each:
    - Capture visible text (already HTML-escaped from step 5) until matching `]`.
    - After `](`, walk forward counting `(` and `)` until balanced (first `(` opens count 1; matching `)` closes it; nested parens increment and decrement; `\(` and `\)` are treated as LITERAL parens, not escape sequences — markdown has no defined paren-escape, so the scanner treats a preceding backslash as already-escaped text and still counts the paren). If balance not reached within 2048 chars of URL content, emit literal `[text](url-so-far` as fallback.
    - On balance, extract URL text.
    - Parse URL with WHATWG URL. If parse fails, emit literal text `[text](url)` (already escaped).
    - Reject scheme unless ∈ `{http, https}` (lowercased after trimming leading whitespace/control chars). `tg:`, `javascript:`, `data:`, `file:`, etc. become literal text. (Explicit over-block of `tg:` noted; a future spec may allow it.)
    - URL goes through `escapeHtmlAttribute()` (distinct from `escapeHtmlText`): escapes `"`, `'`, `<`, `>`, `&`, and strips `\x00-\x1f`, `\x7f`, CR, LF.
    - Emit `<a href="escaped-url">escaped-text</a>`.
12. **Splice placeholder tokens back in** (pre blocks, table blocks, code spans).

The italic regex (step 8) is the only subtle one; the rest are bounded by `\n` or `\|`-anchored to avoid backtracking. A fuzz test (see Tests) covers adversarial inputs.

### Security hardening

#### URL attribute escaping

`escapeHtmlAttribute(url)` is a DISTINCT function from `escapeHtmlText`. Contract:

```
escapeHtmlAttribute(s):
  1. strip chars in \x00-\x1f\x7f
  2. replace CR and LF with nothing
  3. replace & with &amp;
  4. replace " with &quot;
  5. replace ' with &#39;
  6. replace < with &lt;
  7. replace > with &gt;
```

Tests: URLs containing `"`, `'`, `\n`, `\r`, NUL, `<`, `>`, `&`, mixed.

#### Scheme allowlist

```
isSafeUrl(raw):
  trimmed = raw.replace(/^[\s\x00-\x1f]+/, '')
  parsed = try new URL(trimmed); catch { return false }
  scheme = parsed.protocol.toLowerCase().replace(':','')
  return scheme === 'http' || scheme === 'https'
```

IDN homoglyph attacks: WHATWG URL normalizes via Punycode, so `һttps://evil` (Cyrillic `һ`) either parses to punycode (detectable — not `https`) or fails parse.

#### Auth scope for `X-Telegram-Format` and `format` body field

- All Telegram send routes (`/telegram/reply/:topic`, `/telegram/topic/:topic/send`, any future route) already require the server auth token (per existing instar auth policy). Format inputs are honored ONLY on authed requests; unauthenticated POST with format=html is rejected at auth layer BEFORE reaching the formatter.
- `format: 'html'` is further restricted: server maintains an allowlist of trusted internal caller identities (request originates from server-internal code, e.g. the onboarding path, the attention-queue renderer). Shell script and remote HTTP callers are REFUSED `html` mode — they get a 422 with message "html mode is reserved for trusted internal callers; use markdown, plain, code, or legacy-passthrough". (Iteration-1 adversarial finding H2.)
- Identity check uses the existing `requestOrigin` metadata the server attaches to authed calls; no new auth mechanism.

#### ReDoS bound

- 32KB hard cap (step 1 above).
- Italic regex body bounded by `{1,200}` (step 8).
- Safe-regex CI lint (safe-regex2) runs on every commit; any new pattern must pass.
- Fuzz test: 10K random strings with pathological patterns (nested `*`, repeated `|`, long runs of `` ` ``). p99 must be < 5ms.

#### Lint self-safety

Lint issue strings MUST NOT contain markdown tokens or excerpts from input. Canonical messages use plain prose:
- `"markdown bold syntax detected (double-asterisk)"` — NOT `"**bold** detected"`.
- `"markdown heading syntax detected (leading hash)"`.
- `"markdown table syntax detected (pipe rows with alignment separator)"`.
- Lint strings NEVER include user/agent text.

#### Lint span-stripping is advisory-only

`<code>` / `<pre>` stripping runs in `lintTelegramMarkdown()` only, to avoid flagging literal examples. That function does NOT feed into the converter. The converter path (markdown mode) extracts code/pre blocks with its own tokenizer (step 2-4), not via the advisory strip. Invariant stated in comments + asserted in tests.

### Pipeline ordering — corrected (iteration-1 adversarial findings C1, C2)

The original spec placed the formatter BEFORE the rewrite gates (plain-language, closure-reflex), which would have corrupted HTML when the LLM-based rewriters re-wrote the bytes. Corrected order:

```
raw_text
  ↓
plain-language gate (may rewrite)
  ↓
closure-reflex gate (may rewrite; dryrun by default)
  ↓
messaging tone / style gate (may reject or rewrite)
  ↓
FORMAT  ← here
  ↓
length-split (tag-aware, entity-aware)
  ↓
Bot API sendMessage with computed parse_mode and stable idempotency key
```

Formatting runs AFTER all rewrites. Gates see/produce agent-native markdown (their native input distribution); no gate is required to preserve HTML bytes; no double-escape on retry.

#### Plain-retry fallback — corrected

When Bot API returns `400 Bad Request: can't parse entities`, the adapter retries WITHOUT re-entering the formatter. It retries the Bot API call with `parse_mode: undefined` and the ORIGINAL pre-format text. The adapter caches `(rawText, formattedText)` tuple per request so retry has access to raw. This avoids C1 double-escape.

### Length splitting

- Implemented as a single-pass O(N) walk. Upper-bound: one pass to find the chunk boundary, one pass to copy. No retry loops.
- Safe boundary search walks backward from the 4096-char cap to find the nearest preceding `\n\n` (paragraph), `\n` (line), space (word), OR safe inter-tag position.
- MUST NOT split inside `<a>...</a>`, `<b>...</b>`, `<i>...</i>`, `<code>...</code>`, `<pre>...</pre>`, or an HTML entity (`&...;`).
- Edge case: a single `<pre>` larger than 4096 chars → the splitter surfaces this via `FormatResult.truncated = true` and the adapter falls back to `plain` mode on the RAW text (not re-formatted output), then splits that.
- Split chunks share the original idempotency namespace: each chunk gets `${originalIdempotencyKey}:part:${N}/${total}` so retries of a partial send don't double-post.
- Rate-limit: split chunks enter the existing per-chat rate-limit queue; spec requires extending the queue to treat a group of chunks as a single FIFO admission (no interleaving with unrelated messages).

### Config — corrected plumbing

Additions to `InstarConfig` (`src/core/types.ts`):
- `telegramFormatMode?: FormatMode` — default `'markdown'` after cutover; `'legacy-passthrough'` during canary.
- `telegramLintStrict?: boolean` — default `false`.

Propagation:
- `Config.ts` loads these into the top-level config object.
- `server.ts` (`src/commands/server.ts` ~:4628, :4760) passes an accessor closure `() => config.telegramFormatMode` into the `TelegramAdapter` constructor's `TelegramConfig`.
- `TelegramAdapter.apiCall()` reads the accessor on each send (live reflection, no restart needed). Same for `TelegramLifeline.apiCall()`.
- Config hot-reload works because the accessor reads the current config object on each invocation.
- Override precedence (per send) — updated in Iteration-3: explicit arg (trusted-by-construction, internal callers only) → body field (authed request) → request header → config accessor → hard default `'markdown'`. The `html` mode gate applies to sources 2 and 3 identically; explicit-arg callers are implicitly trusted by virtue of being internal server code, bound by the trusted-internal-callers list in Security.

### Multi-machine

- Formatting is SEND-side only. The machine holding the Telegram token formats; other machines never touch Telegram directly.
- GitSyncTransport (`src/messaging/GitSyncTransport.ts`) forwards messages across machines with envelope metadata. Add envelope flag `alreadyFormatted: false` (default). When a machine relays a message to the sending machine, the relay carries the RAW text (not HTML); the sending machine formats at send time. This avoids per-machine config divergence producing double-formatting.
- Migration path: existing GitSync envelopes without the flag are treated as raw (default).

### Template composition safety

New helper `formatTemplate(template, vars, mode)`:

```ts
export function formatTemplate(
  template: string,
  vars: Record<string, string>,
  mode: FormatMode = 'markdown'
): FormatResult;
```

The helper:
1. Strips BOTH NUL bytes AND the Supplementary-PUA-B range (`U+100000..U+10FFFD`) from template body and every variable value. Sentinel codepoints are drawn from this PUA-B range, so scrubbing user content up front prevents collision. This range has near-zero real-world usage and is not valid Telegram HTML text.
2. Splices each `${var}` value into the template as a TEXT-NODE SENTINEL drawn from Supplementary-PUA-B (`U+100000..U+10FFFD`) — e.g. `U+100000 + n` bracketed by `U+10FFFD`. Sentinels cannot collide with user content because substep 1 already stripped that range. Variable content is NOT pre-escaped; the sentinel ensures step 5 HTML-escapes the variable as plain text exactly once. The inner formatter treats these sentinels the same way it treats NUL-bracketed placeholders.
3. Runs the spliced template through `formatForTelegram(mode)` with `skipNulStrip: true` (step 0 already ran at substep 1).
Callers that currently build message bodies via string concatenation (attention-queue alerts, job status pings, etc.) migrate to `formatTemplate`.

Lint rule (build-time): any `.ts` file matching `templates/messages/` or `attention-queue/` that contains `${` inside a template literal passed to `sendMessage` without going through `formatTemplate` fails CI.

### Idempotency

- Current idempotency key includes request payload hash. After formatting moves server-side, the key is computed from RAW text (pre-format) so `format(x) === format(x)` determinism plus raw-keying guarantees retries (including the 400 plain-retry path) land in the same dedup window.
- Formatter is deterministic → identical inputs produce identical outputs (byte-for-byte). Test asserts `format(x).text === format(x).text` across 1000 fixtures.
- Lint-strict rejection: no idempotency key is written (send never attempted). Agent retry with fixed text gets a new key. Lint-strict toggles are logged as auditable events with timestamp + operator identity.

### Audit trail on non-default mode

- Every send where the applied mode differs from the configured default emits a structured log record `{ timestamp, mode, configuredDefault, caller, topicId }`.
- A self-monitor job (runs hourly) checks: "has `telegramFormatMode` been set to a non-`markdown` value for >24h?" — surfaces to attention queue if true. Prevents operator-debug-left-on scenarios.

### Rollback

True rollback target: set `telegramFormatMode = 'legacy-passthrough'`. This:
- Skips all conversion (passthrough).
- Preserves each callsite's ORIGINAL `parse_mode` byte-for-byte — `Markdown` for the Markdown sites (`TelegramAdapter.ts:722, 790, 1212, 3646, 3654`, `TelegramLifeline.ts:1816`), `HTML` for the onboarding site (`TelegramAdapter.ts:2889`). No global `parse_mode` forcing. (Iteration-3 GPT finding.)
- Restores exact pre-cutover behavior including `*italic*`/`[text](url)` working as they do today.

Not a code revert — a config flip. Rollback is O(1) operational cost.

### Staged rollout

1. **Pre-GA canary**: merge with `telegramFormatMode = 'legacy-passthrough'` as the shipped default. Formatter code is present but not applied. Canary flip on Echo's own agent: set `legacy-passthrough` → `markdown`, monitor for 24h.
2. **Expand canary**: after 24h clean, flip `markdown` on a second agent.
3. **Flip shipped default** to `markdown` after 72h clean across canary agents.
4. **Monitor post-GA**: alert on any increase in Bot API 400 errors. Instantly revertable by config flip.

## Tests

New test files (framework: **Vitest**, matching instar's actual setup):

- `tests/unit/telegram-markdown-formatter.test.ts`:
  - Mode contracts (each of 5 modes × fixture set of 15 messages).
  - HTML escape correctness across all positions incl. attribute context.
  - Attribute-escape specific tests: URLs with `"`, `'`, `\n`, `\r`, NUL, `<`, `>`, `&`.
  - Scheme allowlist: http, https allow; javascript, data, tg, file, mailto, and IDN homoglyph reject.
  - Table extraction: with/without alignment row; adjacent tables; table at message end; table containing `</pre>` in a cell.
  - Link safety: bad schemes become literal text; malformed URLs become literal text.
  - Italic edge cases: `3*5`, `f(x) = x * y`, `a*b*c`, `*valid italic*`, `*unterminated`, `***triple***` (bold+italic).
  - Bold edge cases: `**valid**`, `**nested `` `code` `` **`, `**unterminated`, `*****` quintuple.
  - Lint: each rule positive + negative; literal-example carve-out.
  - Lint-self-safety: lint messages never contain `**` or `#` tokens.
  - Lint-strict: route returns 422 with issue list.
  - Length splitting: paragraph, line, space boundaries; tag boundaries; entity boundaries; oversized single `<pre>` fallback.
  - Determinism: `format(x).text === format(x).text` over 1000 fixtures.
  - Idempotency of already-formatted input (envelope flag case).
  - ReDoS fuzz: 10K random pathological strings; p99 < 5ms.
  - Length guard: 33KB input returns `plain` mode with `truncated: true`.

- `tests/integration/telegram-adapter-format.test.ts`:
  - `**bold**` at route send → Bot API body contains `<b>bold</b>` + `parse_mode: 'HTML'`.
  - Markdown table at route send → Bot API body contains `<pre>` with preserved alignment.
  - Malformed HTML path → plain-retry fires with ORIGINAL raw text, not re-formatted output.
  - `format: 'html'` from unauthenticated caller → 401.
  - `format: 'html'` from authenticated but non-trusted caller → 422.
  - `format: 'html'` from trusted internal caller (onboarding path) → passthrough.
  - `legacy-passthrough` mode → Bot API body is raw text + `parse_mode: 'Markdown'`.
  - Idempotency key derived from raw text → retry after formatter change produces same key.
  - `TelegramLifeline.apiCall` formats with same pipeline as `TelegramAdapter.apiCall` (separate test — Lifeline has its own class).

- `tests/integration/telegram-template-composition.test.ts`:
  - `formatTemplate('Alert: ${title} is down', {title: 'User **pwned** us'}, 'markdown')` → asterisks in value are HTML-escaped, not interpreted.
  - Build-time lint catches `${` in message templates not routed through `formatTemplate`.

- `scripts/verify-telegram-render.ts` (dev-only, not CI): sends each fixture to a verification topic; prints Bot API message IDs for eyeball check. Runs on request.

## Migration

- **Behavioral change**: messages currently rendered as literal `**bold**` start rendering bold. Messages currently using legacy-Markdown-compatible `*italic*` render bold-italic or italic depending on context (tightened italic regex mostly preserves intent; edge-case fixtures enumerate). Operators should expect visible-but-desirable changes in the week after flip.
- **Existing tests**: any integration test asserting exact Bot API body content (`expect(body).toContain('**bold**')`) breaks. Migration command: `grep -rn "parse_mode.*Markdown" tests/` and `grep -rn "\\*\\*.*\\*\\*" tests/fixtures/` to enumerate. Updated in the wiring PR.
- **Message store**: `src/messaging/MessageStore.ts` currently stores `text` (ambiguously pre-or-post-format). Adjust to store `rawText` + `sentText` + `modeApplied`; dashboard displays `rawText` with a "rendered preview" toggle that shows the formatter's output.
- **Agent scripts**: `src/templates/scripts/telegram-reply.sh` is updated to understand `--format`/`--lint-strict`. Existing scaffolded agent copies keep their old script; server default handles missing header. `CLAUDE.md` scaffold text is updated so new agents learn the flag exists.
- **Docs**: update Self-Knowledge Tree telegram entry, instar `CLAUDE.md` Telegram Relay section, agent scaffold template docs, `docs/specs/` index.

## Iteration-2 hardening (consolidated)

The following refinements address iteration-2 reviewer findings and are stated here for convergence review:

**Pipeline invariants (adversarial C3, C4):**
- Rewrite gates (plain-language, closure-reflex, tone) declare a RAW-MARKDOWN output contract. Gate output is treated as raw markdown and fed to the formatter. If a gate's LLM incidentally produces literal `<b>` or `<i>`, step 5's HTML-escape converts them to `&lt;b&gt;` — safety-preserving; the agent's unintended HTML is not rendered. A fixture test covers "gate rewrites `**bold**` → `*strong*`" to document the bold→italic drift and confirm it doesn't regress past an accepted fixture set.
- 422 lint-strict responses contain ONLY canonical lint messages + optional (line, col) coordinates. Never an excerpt of the submitted text. Response body shape: `{ issues: [{ code: 'MD_BOLD', message: 'markdown bold syntax detected (double-asterisk)', line: 3, col: 12 }] }`.

**GitSync envelope trust (security + scalability S3 + adversarial M5):**
- The `alreadyFormatted` field exists on the envelope for observability/future use but is **ignored by the receiving (sending-to-Telegram) machine**. The sending machine ALWAYS re-formats from raw. This makes formatting strictly send-side authoritative and prevents a non-sending machine from injecting pre-built HTML.
- Formatter MUST be idempotent on its own output: `format(format(x).text).text === format(x).text` for any `x`. Enforced by test over 1000 fixtures. Idempotency matters because some future optimization may opportunistically skip re-formatting; the correctness-preserving version of that optimization depends on idempotency.
- Any future change that would make the sending machine trust `alreadyFormatted: true` requires a minimum-version gate across the fleet and a separate spec.

**Audit log shape (security):**
- `caller` field is a closed enum: `route-reply | route-send | attention-queue | onboarding | lifeline | dispatch | mcp | job-template | other`. Never free-form. Prevents log-forging via header injection.
- `topicId` is numeric-validated before logging.

**Fuzz test rigor (scalability S2):**
- Seeded RNG (seed committed in the test file) for deterministic, reproducible runs.
- Vitest per-test `timeout: 30_000`; test suite fails if fuzz total wall-clock exceeds the cap.

**Canary observability (adversarial H5):**
- 24h canary on Echo's agent requires BOTH (a) zero increase in Bot API 4xx/5xx rate AND (b) eyeball-pass of `scripts/verify-telegram-render.ts` output at t=1h, t=6h, t=24h marks. Passing only (a) is not sufficient — rendering bugs most often produce 200 OK with visibly wrong output.
- Verification fixture set has 30 entries covering all mode × feature combinations.

**Chunk-retry semantics (adversarial M6):**
- Chunked idempotency keys (`${key}:part:N/total`) apply ONLY when retrying the byte-identical raw text. If the agent paraphrases between attempts, the retry is treated as a fresh send (new top-level key, new chunking).

**Drift-detection ownership (adversarial M7):**
- Weekly Dawn-vs-instar formatter drift test is owned by Echo. Echo triages drift items; escalates to Justin only if the drift is behavioral (different rendered output for the same input), not cosmetic (different internal comments / test fixture shape).

**Documented accepted trade-offs (adversarial L4):**
- Italic between emoji (`🎉*bold*🎉`) renders with literal asterisks because the punctuation-class lookaround doesn't include emoji. Accepted v1; follow-up spec may extend the class.

**Template-composition edge case (adversarial L5):**
- Test fixture: `formatTemplate('${x}', {x: '<b>pwned</b>'}, 'markdown')` — output is the escaped literal `&lt;b&gt;pwned&lt;/b&gt;`, which Telegram renders as the literal string `<b>pwned</b>`. Not bold, not re-escaped further. One fixture pins this.

**Config hot-mutable accessor (integration INT-5):**
- `TelegramConfig` carries `getFormatMode: () => FormatMode` (closure over a mutable reference, not a captured value). Config mutations update the reference; subsequent sends read the new value without restart. Both `TelegramAdapter` and `TelegramLifeline` receive the same accessor.
- Both server.ts instantiation sites (`:2375`, `:2430` per iteration-2 INT-3) wire the accessor identically.

**MessageStore migration (integration INT-1):**
- `MessageStore` is JSON-file-backed (`src/messaging/MessageStore.ts`), not SQLite/FTS. Adding `rawText` / `sentText` / `modeApplied` is a purely additive change on `AgentMessage` / the envelope. Older records missing the fields are tolerated by readers (`undefined` check). No backfill job, no schema migration, no FTS reindex.

**Pre-push guidance (integration INT-6):**
- Cutover PR sets `INSTAR_PRE_PUSH_FULL=1` so the full sharded suite runs locally before the push, not just the smoke tier.

**PR scope revision (integration):**
- Revised estimate: ~12 files in PR1 (formatter + types + tests + envelope field + MessageStore field additions + template helper) and ~14-16 files in PR2 (adapter wire + lifeline wire + server.ts × 2 + shell template + migrations of existing message builders to `formatTemplate` + docs + canary flip + integration tests).

## Iteration-3 hardening (external cross-model review)

GPT 5.4, Gemini 3.1 Pro, and Grok 4.1 Fast reviewed the iteration-2 spec. External consensus: conditionally approved with a set of tactical fixes below. Addressed:

**Link regex — paren-balanced URLs (Gemini critical):**
- Step 10's pattern `\[([^\]\n]+)\]\(([^)\n]+)\)` fails on Wikipedia-style `https://en.wikipedia.org/wiki/Foo_(bar)`. Replacement: use a balanced-paren scanner, not a regex. Algorithm: after finding `](`, walk forward counting `(` / `)` (ignoring escaped parens), terminating on the balancing close-paren. If no balance within 2048 chars of URL scan → fall back to literal `[text](url)` output. Test fixtures: Wikipedia URLs, URL with trailing `)`, unbalanced URL (literal fallback).

**Plain-retry key + length-splitter re-entry (Gemini critical):**
- On Bot API `400 can't parse entities`, the adapter retries with the ORIGINAL raw text. Iteration-3 corrections:
  - Idempotency key for the retry is `${originalIdempotencyKey}:fallback-plain`. Distinct from the original key so downstream dedup treats it as a fresh send, not a cached 400.
  - The raw text re-enters the length-splitter (which may produce different chunk boundaries than the HTML-formatted text did). If the resulting chunk count differs from the original, each chunk uses `${originalIdempotencyKey}:fallback-plain:part:N/total`.
  - Plain-retry consumes a fresh per-chat rate-limit token (not the original one, which already fired on the failed HTML send). Retry ordering is NOT guaranteed under rate-limit pressure: if other messages are queued between the failed HTML send and the plain-retry, the retry may arrive after them. Callers that require strict ordering (rare) must serialize through the existing per-chat queue with explicit ordering constraints — out-of-scope for this spec.

**Rollback inconsistency (GPT critical):**
- The earlier "set `parse_mode: 'Markdown'`" language was contradicted by `legacy-passthrough`'s per-callsite preservation. Canonical statement: `legacy-passthrough` does not force any global `parse_mode`. It passes through whatever the callsite originally specified, byte-for-byte — Markdown for the Markdown sites, HTML for the HTML onboarding site. Rollback = flip config to `legacy-passthrough`; per-callsite modes resume exactly as before the cutover. The Rollback section's prior language is superseded by this statement.

**Nested markdown grammar (GPT):**
- Explicit grammar for nesting at conversion step 2-11:
  - Fenced code and inline code have HIGHEST priority (no markdown interpreted inside).
  - Inside a link's visible text (`[text]`): bold and italic are permitted; code spans are permitted; links are NOT nested.
  - Inside bold: italic is permitted (`**bold *italic***` → `<b>bold <i>italic</i></b>`). Code spans are permitted. Links are NOT nested inside bold.
  - Triple asterisk (`***x***`) parses as bold-italic (`<b><i>x</i></b>`) — requires explicit rule ordering: match triple BEFORE double BEFORE single. Test fixtures pin this.
  - `***` at the start of a line without closing triple → literal asterisks (bullet-like? no — only `-/*/+ SPACE` is bullet; unterminated emphasis becomes literal).

**editMessageText split policy (GPT critical):**
- Telegram's `editMessageText` cannot be split — a single edit must map to a single message. Spec correction: if a formatted edit text exceeds 4096 chars post-format, the adapter returns an error to the caller (`TELEGRAM_EDIT_TOO_LONG`). It does NOT split the edit into multiple messages. The caller is responsible for content brevity on edits. Integration test covers this path.

**32KB guard vs 4096 limit flag ambiguity (GPT):**
- Replace single `truncated: true` with two distinct flags:
  - `conversionSkipped: true` — formatter bypassed markdown conversion because input > 32KB; applied `plain` mode instead. No bytes dropped.
  - `truncated: true` — output was byte-truncated to fit within Bot API single-message cap. Can only occur alongside the single-`<pre>` oversized-block fallback path.

**formatTemplate double-escape (GPT critical):**
- Canonical pipeline clarified: `formatTemplate(template, vars, mode)` does NOT HTML-escape variables in advance. Instead, it splices the raw variable values into the template as TEXT NODES with a sentinel boundary (NUL-bracketed like other placeholders), such that step 5's HTML-escape sees them as plain text and escapes them exactly once. The template's own markdown (`**`, `` ` ``) is interpreted normally; variable content is not. This produces the iteration-2 fixture L5 result (`{x: '<b>pwned</b>'}` → rendered literal `<b>pwned</b>`) with exactly one round of escaping, not two. Implementation test: `formatTemplate('hi ${x}', {x: 'a & b'}) → 'hi a &amp; b'` (single-escape).

**Telegram HTML allowlist appendix (GPT):**
- Add an appendix to the spec listing the exact set of Telegram-valid HTML tags the formatter is permitted to emit, cited to the Bot API docs (https://core.telegram.org/bots/api#html-style): `<b>`, `<strong>`, `<i>`, `<em>`, `<u>`, `<ins>`, `<s>`, `<strike>`, `<del>`, `<span class="tg-spoiler">`, `<tg-spoiler>`, `<a href="...">`, `<tg-emoji emoji-id="...">`, `<code>`, `<pre>`, `<pre><code class="language-...">`, `<blockquote>`, `<blockquote expandable>`. Formatter emits a strict subset: `<b>`, `<i>`, `<code>`, `<pre>`, `<a href>`. `html`-mode (trusted-caller) passthrough permits the full allowlist.

**Override precedence unambiguous (GPT):**
- Corrected precedence (highest wins):
  1. Explicit `mode` argument to `formatForTelegram()` call — used by internal server code.
  2. `format` body field on authed HTTP POST — used by `.claude/scripts/telegram-reply.sh`.
  3. `X-Telegram-Format` header on authed HTTP POST — used for sidecar tooling.
  4. `InstarConfig.telegramFormatMode` accessor.
  5. Hard default: `markdown`.
- The original list had header above body; flipped so the body field (explicitly chosen by the request author) wins over a header (often auto-populated by a proxy or template). Security gate on `html` mode applies to sources 2 and 3 identically — only authenticated requests from identity-whitelisted callers may select `html`.

**Lint runtime behavior (Grok):**
- When lint runs: every invocation of `formatForTelegram()` runs `lintTelegramMarkdown()` on the input text and populates `FormatResult.lintIssues`. Issues are informational by default.
- Non-strict (default): issues are logged at INFO level, included in the `FormatResult`, and optionally surfaced via audit log. Send proceeds.
- Strict (`telegramLintStrict: true` OR request `lint-strict` flag): any issue returns 422 to HTTP callers or throws `TelegramLintError` to internal callers. Send does not proceed.

**Edge cases (Grok):**
- Zero-length / whitespace-only input: formatter returns empty string, no-op, no send attempted (adapter returns early before Bot API call).
- Emoji in URL query params: WHATWG URL parse accepts percent-encoded or IDN-form. Native emoji survives parse. Covered by fixture test.
- `(raw, formatted)` retry-cache eviction: cache is scoped to a single `apiCall()` invocation; on function return the cache is released. No cross-invocation cache, no concurrency issue.

**MessageStore bloat (Gemini):**
- Storing `rawText + sentText + modeApplied` on every outbound message approximately doubles MessageStore disk usage. Phase 1 (current scale ~100s/day per agent) is fine. At phase 3 (>5000/day) the JSON file approach starts straining. Out-of-scope for this spec; flagged as a known follow-up: migrate MessageStore to SQLite when message volume exceeds 10K/day sustained. Track under a separate issue.

**Cost / monitoring (Grok, Gemini):**
- Add Prometheus-style counters on the outbound path:
  - `telegram_format_duration_ms` histogram per `modeApplied`.
  - `telegram_format_lint_issues_total` counter by `code` (MD_BOLD, MD_HEADING, MD_TABLE, etc.).
  - `telegram_format_fallback_total` counter for plain-retry invocations.
- These feed the existing dashboard; no new monitoring stack required.

**Scalability trigger (Grok):**
- If `telegram_format_duration_ms.p99` exceeds 10% of total send-path duration at canary flip + 2 weeks, open a follow-up spec for extracting the formatter to a dedicated service. Until then, in-process is correct.

## Semantic alignment with Dawn

- Dawn's default mode is `plain`. Instar's default after this spec is `markdown`. **Intentional divergence** — Dawn's repo uses markdown heavily enough that `plain` is safer; instar agents are more formatting-aware and benefit from default conversion. Divergence is documented here and tracked by a drift-detection test that pins a 50-fixture suite against Dawn's `telegram_format.py` output. Test runs weekly; failure opens an attention-queue item for review.
- Modes themselves (names, semantics for shared modes) match Dawn exactly for copy-paste safety.
- `legacy-passthrough` is instar-specific (Dawn was never on legacy Markdown).

## Rollback cost

Low. Config flip `telegramFormatMode = 'legacy-passthrough'` restores exact pre-cutover behavior. No schema migration, no data migration, no code revert. Rollback can be performed in seconds during an incident without restart (config hot-reload).

## PR plan

Two PRs:

1. **PR1: formatter module + tests + legacy-mode passthrough.** Adds `TelegramMarkdownFormatter.ts`, full test suite, `formatTemplate` helper, envelope flag in `GitSyncTransport`, new config fields. No adapter wiring. Default stays `legacy-passthrough`. CI green, no behavior change.

2. **PR2: wire adapter + lifeline + shell script + templates + docs + canary flip.** Wires `apiCall` paths in both `TelegramAdapter` and `TelegramLifeline`. Updates `telegram-reply.sh` template. Migrates existing message builders to `formatTemplate`. Updates docs. Ships with `legacy-passthrough` still the shipped default; flip to `markdown` on Echo's agent as canary.

Estimated scope: ~8 files in PR1, ~10-12 files in PR2.

## Open questions

- `tg://` deep links over-blocked. Acceptable v1; follow-up spec can add them back with a safe-URL check.
- Should `formatTemplate` produce split chunks atomically (no interleaving), or is that a separate spec? (Recommendation: this spec; the length-splitter change already covers it.)

## Success criteria

1. Agent-authored `**bold**` renders bold; `` `code` `` renders code; `# Heading` renders bold; markdown tables render with alignment preserved via `<pre>`.
2. Every server send path (route, job, dispatch, attention, lifeline, MCP, edit) gets the same formatting — verified by integration tests against both `TelegramAdapter.apiCall` and `TelegramLifeline.apiCall`.
3. Rollback to pre-cutover behavior requires one config flip, no code change.
4. No regression in existing gates, idempotency, or 408-ambiguous handling.
5. No increase in Bot API 400 errors post-cutover (≤ pre-cutover baseline).
6. Shell-script `.claude/scripts/telegram-reply.sh --format code "..."` works for operational monospace output on new agents; old agents continue to work unchanged (server default).
7. `html` mode is refused for untrusted callers (unit + integration test proof).
8. ReDoS fuzz test p99 < 5ms for 4KB pathological input.
