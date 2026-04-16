---
title: Outbound-route extended timeout + HTTP 408 ambiguous-outcome client handling
status: implementing
date: 2026-04-16
review-convergence: 2026-04-16T18:45:00Z
approved: true
approved-by: justin (telegram=6644, direct approval)
cluster: cluster-duplicate-outbound-messages-408-timeout-race
---

# Outbound-route extended timeout + HTTP 408 ambiguous-outcome client handling

## Problem

Agents ship duplicate replies to Telegram topics. The two replies are not
byte-identical — they are the same semantic answer, freshly regenerated with
different wording. Live-reproduced on Echo (topic 6655, msgs 6669 + 6670, 69s
apart) and Inspec (topic 72, msgs 1280 + 1281, 32s apart). 3-gram Jaccard
similarity between the duplicates is 0.398 — far below `OutboundDedupGate`'s
0.7 threshold and the `B9_RESPAWN_RACE_DUPLICATE` rule's 0.9 authority
threshold — so the existing respawn-race safety net has no shot at catching
this class.

## Root cause

The mechanism, traced through the Claude session JSONL for Echo's topic 6655:

1. Agent calls `.claude/scripts/telegram-reply.sh` with the full reply text.
2. The `/telegram/reply/:topicId` handler runs the single-authority outbound
   gate: `MessagingToneGate.review()` (Haiku-class LLM call, ~500ms–several
   seconds) plus signal collection (`isJunkPayload`, `OutboundDedupGate`),
   then `ctx.telegram.sendToTopic()` (Telegram Bot API roundtrip).
3. The global `requestTimeout` middleware fires at 30s. In at least the 0.398-
   similarity case, the handler's async work crosses that threshold — tone gate
   took ~5s and the Telegram API posted a 2kB-ish reply over a sluggish link.
4. Middleware sends `res.status(408).json({error: "Request timeout", ...})`.
5. The handler's `sendToTopic` continues to completion — message lands in
   Telegram. The handler then tries `res.json({ok: true})` and Express raises
   "Cannot set headers after they are sent to the client" (observed in
   monroe-workspace `logs/server.log:2225`).
6. The client script sees HTTP 408 from `curl -w "%{http_code}"` and emits
   `Failed (HTTP 408): {...}` on stderr with exit 1. The agent's tool-use path
   reads this as a send failure.
7. The agent regenerates the reply (paraphrased) and retries. Second send
   succeeds. Duplicate ships.

The 30s budget is the wrong shape for a route whose design includes an LLM
call and a third-party API roundtrip. The client's interpretation of 408 as
hard failure is the wrong shape for a response code that semantically means
"we don't know whether it completed."

## Design

Two coordinated changes, each at its natural layer.

### (a) Per-route request-timeout override

`requestTimeout(defaultMs, perPathOverrides?)` in `src/server/middleware.ts`
gains an optional path-prefix override map. Match is by exact prefix or
prefix-followed-by-`/`, so `/telegram/reply` matches `/telegram/reply/6655`
but never `/telegram/reply-other`. Overrides are sorted longest-first so a
more specific prefix wins over a shorter parent if both are registered.
`req.path` in Express never contains the query string, so no `?`-clause is
needed.

`AgentServer.ts` registers 120s overrides for every outbound messaging route:
`/telegram/reply`, `/telegram/post-update`, `/slack/reply`, `/whatsapp/send`,
`/imessage/reply`, `/imessage/validate-send`. Every other route keeps the
30s default.

### (b) HTTP 408 → ambiguous-outcome at the transport client

The three reply scripts (`telegram-reply.sh`, `slack-reply.sh`,
`whatsapp-reply.sh`) grow an explicit 408 branch that:

- Exits 0 (not 1) — the outcome is unknown, not failed; a hard-failure signal
  would drive the agent to retry, which duplicate-sends because the first
  attempt probably succeeded.
- Prints a loud stderr warning instructing the agent to verify delivery in
  the conversation before retrying.
- Prints a distinct stdout marker ("AMBIGUOUS (HTTP 408): outcome unknown —
  verify in conversation before retrying") that does NOT match the success
  pattern ("Sent N chars …"), so no pipeline grep misclassifies.

### (c) Migration + scaffold parity

Existing agents get the new script via `PostUpdateMigrator.migrateScripts`,
gated by a shipped-header marker: if the on-disk copy includes the canonical
shebang comment AND lacks an `HTTP_CODE" = "408"` branch, it's overwritten.
Custom scripts are preserved. `PostUpdateMigrator.getTelegramReplyScript` is
refactored to read from `src/templates/scripts/telegram-reply.sh` (same
pattern as `getConvergenceCheck`). `src/commands/init.ts` gains a
`loadRelayTemplate(filename, port)` helper and both `installTelegramRelay` /
`installWhatsAppRelay` now delegate to it. One canonical template per script,
no inlined drift.

Slack and WhatsApp migrations are file-presence-gated (no `hasSlack` /
`hasWhatsApp` config signal yet, and init.ts doesn't install slack-reply):
migrate only if the file is already present and matches the shipped header.

## Decision-point impact

No new detectors, no new authorities. `MessagingToneGate` remains the single
outbound block/allow authority; `OutboundDedupGate`, `isJunkPayload`, and the
paraphrase cross-check remain pure signals. The change is a capacity knob
(timeout budget) plus a transport-layer idempotency concern (how the client
interprets an ambiguous response code) — both explicitly outside the
signal-vs-authority principle's scope per `docs/signal-vs-authority.md`:

> Idempotency keys and dedup at the transport layer. If a caller sends the
> same request twice with the same idempotency key, rejecting the second is
> not a judgment call — it's mechanics.

## Gaps not addressed here

- Duplicate generation from other causes (TriageOrchestrator reinject false
  positives, context-exhaustion respawn, paraphrase-level semantic dupes that
  aren't 408-triggered) remains possible. Those are separate classes; this
  spec scopes to the 408-driven cascade reproduced today.
- p99 latency above 120s still hits 408. The client now handles 408 correctly
  (verify before retry), so even the tail case doesn't duplicate-send.
- No `hasSlack` / `hasWhatsApp` config signal added. Current scope preserved —
  migrator only upgrades existing-on-disk copies.

## Evidence

- `/Users/justin/Documents/Projects/monroe-workspace/logs/server.log:2225` —
  "Cannot set headers after they are sent to the client" at 16:55:42.807
  coincident with successful Telegram delivery of Inspec's first reply.
- `/Users/justin/.claude/projects/-Users-justin--instar-agents-echo/42479d7f-a0ad-4b45-bb33-3d18fa981a8b.jsonl`
  lines 267–277 — Echo's session JSONL showing the retry-and-paraphrase cycle
  on topic 6655: first attempt at 17:19:14 → HTTP 408 → regenerate → tone-gate
  block → regenerate again → success at 17:20:55.
