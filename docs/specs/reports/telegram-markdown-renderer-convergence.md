# Convergence Report — Telegram markdown renderer (server-side HTML formatter + lint + parse_mode migration)

**Spec**: `docs/specs/TELEGRAM-MARKDOWN-RENDERER-SPEC.md`
**Slug**: `telegram-markdown-renderer`
**Author**: echo
**Convergence timestamp**: 2026-04-24T19:28:38Z
**Iterations**: 6 (4 internal rounds + external cross-model + 2 integration rounds)

## ELI16 Overview

Justin and Dawn improved how Dawn sends messages to Telegram — before, Dawn's messages showed `**bold**` and `| tables |` as literal asterisks and pipes instead of rendering properly. Dawn's fix was a client-side script. This spec brings the same fix to instar, but **on the server** instead of the client so every send path benefits — whether a message comes from a job, a dispatch, an alert, a lifeline ping, or the shell script, it all goes through the same formatter and renders correctly in the Telegram chat.

The way it works: when instar is about to send a Telegram message, it runs the text through a small module that converts GitHub-style markdown (what Claude natively writes) into Telegram's HTML format. Bold becomes bold, tables become aligned monospace blocks, links become actual links, headings become bold text (Telegram doesn't support real headings), and bullets get a `•` character. The module is a pure string transformation — no AI calls, no network, a few milliseconds at most.

Important: we're also switching instar's Telegram parse mode from legacy `Markdown` to `HTML`. That's a bigger change than the formatter itself — it means every Telegram callsite starts sending HTML instead of old-style Markdown. To make rollback safe, the spec adds a `legacy-passthrough` mode that restores exact pre-change byte-for-byte behavior with a single config flip. The formatter ships disabled by default (pre-GA canary on Echo's own agent first), gets eyeballed at 1h/6h/24h, and only then flips as the default across all agents.

## Original vs Converged

**The original spec** (iteration 0) assumed instar sent all Telegram messages as `parse_mode: 'HTML'` and said "every send path goes through one `sendMessage` method, so we intercept there." Both of those premises were wrong. The real state is: instar sends mostly as `parse_mode: 'Markdown'` (legacy Markdown), ONE callsite already uses HTML, and send paths flow through two separate `apiCall()` methods (one in `TelegramAdapter`, one in `TelegramLifeline` — different class, different Bot API client, same token). That alone would have broken the feature on deployment.

**The converged spec** (iteration 6) gets the plumbing right. It identifies both `apiCall()` chokepoints and wires the formatter into both. It adds a `legacy-passthrough` mode that preserves each callsite's original parse_mode byte-for-byte, so rollback actually reverts to the pre-change state (not a worse-than-baseline state). It reorders the pipeline so formatting runs AFTER the LLM rewrite gates, not before — this prevents the gates from corrupting HTML with their own rewrites. It hardens link parsing against `javascript:` URLs, IDN homoglyphs, Wikipedia-style parens in URLs, and attribute-quote injection. It caps input at 32KB to prevent regex DoS. It defines nested-markdown grammar (bold-italic triple-asterisk, no nested links). It distinguishes `conversionSkipped` from `truncated` as separate flags. It adds a `formatTemplate` helper with a sentinel scheme that escapes variable content exactly once (not zero or two times). It adds Prometheus counters. And it specifies a 24-hour canary on Echo's agent with visual verification at t=1h, 6h, 24h (not just "no 400 errors" — which would miss silent render bugs).

The shape of change: the original was a terse 2-page port of Dawn's Python into TypeScript. The converged spec is a full 400-line design doc that survives the mixed-parse-mode reality, the dual send-path reality, the LLM-gate pipeline reality, and the multi-machine relay reality, with cutover and rollback procedures that actually work.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration | 20+ including 1 critical factual error (wrong parse_mode premise) | Major rewrite — correct premise, identify real chokepoints, reorder pipeline, add rollback mode |
| 2 | security, scalability, adversarial, integration | 14 including envelope trust, placeholder collision, gate HTML corruption, canary silent-failure, per-callsite rollback | Consolidated hardening section covering pipeline invariants, audit enum, fuzz rigor, drift ownership |
| 3 | GPT 5.4, Gemini 3.1 Pro, Grok 4.1 Fast (external cross-model) | 11 including paren-in-URL regex, plain-retry idempotency collision, editMessageText split policy, formatTemplate double-escape, override precedence | External hardening section: balanced-paren scanner, retry-key suffix, nested grammar, HTML allowlist appendix |
| 4 | Internal convergence synthesis | 5 spec-internal contradictions between iteration-3 additions and pre-existing text | In-place updates to length-guard flag, precedence list, formatTemplate description, rollback section |
| 5 | Internal convergence synthesis | 3 (step-number stale refs, NUL vs formatTemplate sentinel collision, frontmatter staleness) | Triple-asterisk as step 6, formatTemplate switched to PUA-B sentinels with substep-1 strip, step references updated |
| 6 | Internal convergence synthesis | CONVERGED — no material findings | None |

## Full Findings Catalog

### Iteration 1

**Security (7 findings):**
- Critical: `href` attribute escaping "URL-escaped" too vague → added `escapeHtmlAttribute()` with explicit contract.
- High: scheme allowlist under-specified → WHATWG URL parse + lowercase+trim, http/https only, `tg:` explicit over-block.
- High: lint span-stripping parser-confusion bypass → clarified lint-only, converter has its own tokenizer.
- Medium: ReDoS on italic/bold with adversarial input → 32KB cap, bounded `{1,200}`, safe-regex2 CI, fuzz p99 < 5ms.
- Medium: `X-Telegram-Format` auth scope unstated → restricted to authed routes; html mode to trusted callers only.
- Medium: confused deputy via `</pre>` in table cells → invariant: pre contents always escapeHtmlText, never re-injection.
- Low: lint log leakage → canonical messages, never agent text.

**Scalability (8 findings):**
- High: no input length cap → 32KB hard cap.
- High: pipeline pass O(N·k) allocations → single tokenizer pass w/ placeholder tokens.
- High: length-splitter unbounded walk → single-pass O(N).
- Medium: unverified "<1ms" claim → replaced with measured threshold + bench.
- Medium: gate input distribution shift → mitigated by reordering (format runs AFTER gates).
- Medium: rate-limit interaction with split chunks → queue treats chunk-group as single FIFO.
- Low: config hot-reload unspecified → now accessor closure, per-send.
- Low: test migration cost → migration command specified.

**Adversarial (10 findings):**
- Critical C1: plain-retry double-escape → retries from ORIGINAL raw text.
- Critical C2: gate pipeline HTML corruption → format runs AFTER rewrite gates.
- High H1: ambiguous italic (`3*5`) → tightened regex with word-boundary context.
- High H2: `format:'html'` passthrough bypass → trusted-internal-callers only; shell/remote 422'd.
- High H3: template composition unsafety → `formatTemplate()` helper with per-variable escaping.
- Medium M1: semantic drift from Dawn → documented divergence; drift-detection test.
- Medium M2: idempotency + lint-strict race → key derived from raw text; deterministic formatter.
- Medium M3: operator debug leak → audit log; 24h self-monitor alert.
- Medium M4: 422 error body misrender → canonical prose only.
- Low L1-L3: various nits addressed.

**Integration (CRITICAL factual correction + 11 findings):**
- **CRITICAL**: parse_mode is actually `'Markdown'` in most places, not `'HTML'` → entire premise rewritten; spec now proposes Markdown→HTML migration alongside the formatter.
- High: single-funnel wrong → identified dual chokepoint `TelegramAdapter.apiCall()` + `TelegramLifeline.apiCall()`.
- High: class/file paths wrong → corrected to `src/messaging/TelegramAdapter.ts`, `tests/unit/`, Vitest.
- High: rollback worse than baseline → `legacy-passthrough` restores pre-cutover exactly.
- Medium: config plumbing details → Config → server.ts → accessor closure.
- Medium: multi-machine → envelope flag; formatting send-side only.
- Medium: shell script is templated → `src/templates/scripts/telegram-reply.sh`; server default handles old agents.
- Low: idempotency / 408 interaction → raw-text-keyed, deterministic formatter.
- Low: dashboard surface → store rawText + sentText + modeApplied.
- Low: docs surface → Self-Knowledge Tree, CLAUDE.md, scaffolding docs updated.

### Iteration 2

**Security (2 new):**
- Medium: `alreadyFormatted` envelope trust → sending machine always re-formats from raw, ignores flag.
- Low: audit log `caller` field enum → closed enum, topicId numeric-validated.

**Scalability (3 new):**
- S1: placeholder token collision → NUL-bracketed sentinels; step 0 strips NUL from input.
- S2: fuzz determinism → seeded RNG + 30s Vitest timeout cap.
- S3: envelope flag trust + formatter idempotency → idempotent on own output (test over 1000 fixtures).

**Adversarial (9 new):**
- C3: gate-output HTML-like tokens → gates declare raw-markdown contract; fixture test.
- C4: 422 lint-strict leakage → canonical messages + (line, col); no excerpts.
- H4: `legacy-markdown` imprecise rollback → renamed `legacy-passthrough`, preserves per-callsite parse_mode.
- H5: canary silent failure → 24h canary requires both API-error-flat AND eyeball-pass at 1h/6h/24h.
- M5: envelope version gate → reserved field; future flip requires min-version + separate spec.
- M6: chunk-retry semantics → paraphrase = fresh send; chunk-retry only for byte-equal raw.
- M7: drift-detection owner → Echo triages; escalate to Justin if behavioral.
- L4: italic between emoji → documented accepted trade-off.
- L5: formatTemplate + `<` round-trip → fixture pinned.

**Integration (6 new):**
- INT-1: MessageStore is JSON → no schema migration, additive fields.
- INT-2: non-uniform parse_mode today → `legacy-passthrough` preserves per-callsite.
- INT-3: two server.ts instantiation sites → both wire identical accessor.
- INT-5: closure needs mutable holder → `getFormatMode: () => FormatMode` pattern.
- INT-6: pre-push full suite → `INSTAR_PRE_PUSH_FULL=1`.
- PR scope revision: ~12 / ~14-16 files.

### Iteration 3 (external cross-model)

**Gemini 3.1 Pro (3 critical):**
- Paren-in-URL regex fails on Wikipedia-style URLs → balanced-paren scanner with 2048-char cap and literal fallback.
- Plain-retry idempotency collision → `${key}:fallback-plain` suffix.
- Plain-retry length-splitter re-entry → raw text re-enters splitter; chunks get `:fallback-plain:part:N/total`.

**GPT 5.4 (7 findings):**
- Rollback inconsistency (`parse_mode: 'Markdown'` global vs per-callsite) → canonical statement added.
- Nested markdown grammar undefined → explicit grammar; code highest priority; triple-asterisk = bold-italic before bold before italic.
- `editMessageText` split policy → cannot chunk edits; `TELEGRAM_EDIT_TOO_LONG` error.
- 32KB guard vs 4096 flag ambiguity → two distinct flags (`conversionSkipped` vs `truncated`).
- `formatTemplate` double-escape risk → sentinel-based single-escape.
- Telegram HTML allowlist appendix → full allowlist with Bot API citation.
- Override precedence → explicit arg > body field > header > config > default.

**Grok 4.1 Fast (approve; 5 gaps):**
- Lint runtime semantics → informational by default; strict returns 422.
- Edge cases (zero-length, emoji URLs, retry-cache eviction) → each specified.
- Prometheus counters → three added (duration, lint_issues, fallback).
- Scalability trigger → p99 > 10% at canary+2w opens formatter-to-service spec.
- MessageStore bloat → out-of-scope follow-up at 10K/day sustained.

### Iterations 4, 5, 6 (internal consistency)

**Iteration 4 (5 findings):**
- Line 89 `truncated` stale → `conversionSkipped`.
- Line 209 precedence order stale → updated.
- Line 230 formatTemplate pre-escape stale → sentinel approach.
- Line 251 rollback `parse_mode: 'Markdown'` stale → per-callsite.
- Step 10 link regex → balanced-paren scanner numbered.

**Iteration 5 (3 findings):**
- Step 7/8 reference staleness after triple-asterisk insertion → updated.
- NUL-sentinel collision with formatTemplate → switched to Supplementary-PUA-B sentinels with substep-1 scrub.
- Frontmatter `review-iterations` stale → 5 then 6.

**Iteration 6 (convergence):**
- No material findings. Spec is internally consistent and addresses every prior round.

## Convergence Verdict

**Converged at iteration 6.** Four internal review rounds and one external cross-model round produced findings; each was addressed without introducing new material issues at the next round. The iteration-6 verification round returned zero material findings. Spec is ready for user review and approval.

The `approved: true` frontmatter tag is NOT set by this skill. Justin must read this report and either set the tag himself or ask Echo to set it after he confirms — the approval is the structural human contribution to the process.

Once `approved: true` is set, `/instar-dev` is unblocked on this spec and implementation can proceed per the two-PR plan (formatter module + tests + legacy-passthrough first; adapter + lifeline + shell template + canary flip second).
