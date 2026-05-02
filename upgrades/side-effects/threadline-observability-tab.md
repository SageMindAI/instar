# Side-Effects Review — Threadline Observability Tab

**Version / slug:** `threadline-observability-tab`
**Date:** `2026-05-02`
**Author:** `echo`
**Second-pass reviewer:** `self (incident-grounded reasoning)`

## Summary of the change

Fourth of five deliverables in topic-8686. Lights up the dashboard
"Threadline" tab (added in PR #114) with a real conversation-observability
view: thread list, color-coded message stream, per-thread metrics,
filters, and search across all threadline message bodies.

Reads three already-existing sources of truth:

- `.instar/threadline/inbox.jsonl.active` — every inbound threadline
  message (single source post-PR #113).
- `.instar/threadline/telegram-bridge-bindings.json` — thread → Telegram
  topic links (single source post-PR #117).
- `.instar/threadline/thread-resume-map.json` — spawn-session
  bookkeeping (existing).

Adds one new source of truth:

- `.instar/threadline/outbox.jsonl.active` — every outbound threadline
  message sent via `/threadline/relay-send`. Mirror of the inbox-write
  pattern from PR #113. Gives the conversation view BOTH sides of an
  agent-to-agent thread.

Files added:

- `src/threadline/ThreadlineObservability.ts` — read-only view layer
  with `listThreads(filters)`, `getThread(threadId)`, `searchMessages(q, limit)`.
- `tests/unit/ThreadlineObservability.test.ts` — 15 unit cases.

Files modified:

- `src/threadline/ListenerSessionManager.ts` — adds
  `canonicalOutboxPath` getter and `appendCanonicalOutboxEntry(opts)`
  helper.
- `src/server/routes.ts`:
  - `RouteContext.threadlineObservability: ThreadlineObservability | null`.
  - Three new endpoints: `GET /threadline/observability/threads`,
    `GET /threadline/observability/threads/:threadId`,
    `GET /threadline/observability/search`.
  - `/threadline/relay-send`: appends a canonical-outbox entry on BOTH
    success paths (local-delivery + relay-delivery) before returning.
- `src/server/AgentServer.ts` / `src/commands/server.ts` — instantiate
  and pass through `threadlineObservability`.
- `dashboard/index.html` — replaces the placeholder card on the
  Threadline tab with the conversation view: 280px threads list,
  conversation pane with header metrics + per-message bubbles,
  toolbar with filters + debounced search.

## Decision-point inventory

- `appendCanonicalOutboxEntry` — **add** — mirror of the inbound
  helper from PR #113. HMAC-signed, JSONL-append, 0o600 perms,
  failure-open.
- `ThreadlineObservability.listThreads(filters)` — **add** — combines
  inbox + outbox + bindings + thread-resume-map into per-thread
  summaries; sorts most-recent first; supports remoteAgent / since /
  until / hasTopic filters.
- `ThreadlineObservability.getThread(threadId)` — **add** — returns
  summary + chronological message stream.
- `ThreadlineObservability.searchMessages(q, limit)` — **add** —
  case-insensitive substring search over inbox+outbox bodies; returns
  hits with snippets bracketed by «...».
- Three GET endpoints (bearer-auth via global authMiddleware) — **add**.
- `/threadline/relay-send` outbox writes — **modify** — add one
  helper call on each of two success branches; failure-open.
- Dashboard JS handlers (`tlObsLoadThreads`, `tlObsLoadThread`,
  `tlObsRunSearch`) — **add**.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The observability layer is read-only and never blocks. The new outbox
write is failure-open and never throws back to `/threadline/relay-send`
(the route returns its existing success response either way). No
over-blocks possible.

The endpoints validate query string fields (`hasTopic` only accepts
`yes` / `no`; everything else is treated as "no filter"). A typo in
the dashboard's filter UI returns the unfiltered list — which is the
desirable behavior; the dashboard's controls produce only the valid
values, and a curl-from-the-CLI user gets an unambiguous result rather
than a 400.

## 2. Under-block

**What failure modes does this still miss?**

- **No persistence boundary on outbox.** `outbox.jsonl.active` grows
  forever. At the current ~10K msgs/agent envelope this isn't a
  problem, but a future PR should add rotation parallel to the
  warm-listener queue's rotation. Out of scope here.
- **No streaming SSE for the conversation view.** Threads list and
  conversation are pull-on-activate + manual refresh; new messages
  don't appear without a refresh. Acceptable for v1; a follow-up can
  add the existing `/events` SSE channel for live updates.
- **No FTS5 index.** `searchMessages` does a full-file scan.
  Sub-100ms at the current envelope; rebuild as FTS5 if it ever
  becomes a complaint. Documented in the class header.
- **HMAC verification is NOT performed during read.** The
  observability layer reads JSONL lines and parses them as data; it
  doesn't call `verifyEntry` on each row. This is intentional: the
  inbox write uses HMAC for tamper-evidence at write time; reading
  for display doesn't need to re-verify. If an attacker tampers with
  the file at rest, the dashboard would render corrupted bodies, but
  no decision is made on that data — there's no authority surface
  here to subvert.

## 3. Level-of-abstraction fit

The class is intentionally thin: it composes the existing files into
view models. Three sources of truth (inbox, outbox, bindings) compose
into one summary; the `ListenerSessionManager` already owns the writers.
This matches the pattern set in PR #113 and #117: each class owns a
single concern, the observability layer is just a join.

The dashboard handlers debounce input and bind to existing endpoints
through the existing `apiFetch` helper. No new client-side state
machine, no caching beyond what the browser does naturally.

## 4. Signal-vs-authority compliance

- **Signal:** dashboard query string parameters; text typed into the
  search box.
- **Authority:** none — this layer makes no decisions, gates nothing,
  blocks nothing. Read-only.

The new outbox write follows the same signal-vs-authority shape as
the inbound write from PR #113: relay-only, failure-open, no decision
surface. The route's authority (whether to deliver) was already taken
upstream.

## 5. Interactions

- **PR #113 (canonical inbox).** Reads the inbox file written by that
  PR. No coupling beyond file format (well-documented JSONL with
  `id, timestamp, from, senderName, trustLevel, threadId, text, hmac`).
- **PR #114 (settings).** Shares the Threadline dashboard tab — the
  bridge settings card stays at the top, the conversation view sits
  below.
- **PR #117 (bridge module).** Reads
  `telegram-bridge-bindings.json` to populate the per-thread bridge
  link. The bridge is unaware of the observability layer; the
  observability layer is unaware of the bridge's runtime — they
  communicate exclusively through the on-disk file.
- **`thread-resume-map.json`.** The class accepts both the legacy
  flat shape (`{threadId: ...}`) and the newer `{threads: {...}}`
  shape, so it works against either.
- **`/threadline/relay-send`.** Two new helper calls on the success
  paths. Same failure-open pattern as PR #113's inbox hoist.

## 6. Rollback cost

- Drop the three observability endpoints + the dashboard handlers →
  the Threadline tab loses the conversation view but the bridge
  settings card from PR #114 keeps working.
- Drop the outbox helper + the two route hooks → outbound messages
  no longer accrue in `outbox.jsonl.active`, but the relay-send
  route still functions. The conversation view degrades to inbound-only.
- The on-disk `outbox.jsonl.active` file is JSONL-append-only with no
  cross-references; it can be `rm`'d safely if rolled back.

No schema migrations, no shared-state changes, no new processes.

## Plan if a regression appears

- **Symptom: dashboard tab errors loading threads.** Check
  `apiFetch('/threadline/observability/threads')` — 503 means
  `threadlineObservability` is null in the route context (server-side
  bootstrap regression). 200 with empty threads is the correct
  response for a fresh agent.
- **Symptom: search slow.** The full-file scan is bounded by
  `inbox.jsonl.active` + `outbox.jsonl.active` line counts. Profile;
  if pathological, add an FTS5 index keyed on `(threadId, timestamp)`.
- **Symptom: outbound messages missing from conversation view.**
  Either (a) the relay-send route's outbox-append helper threw and
  was caught, or (b) the threadline message went out via a different
  path (e.g. legacy direct relay client). Check the warn lines in
  the agent log. Worst case: roll back the outbox helper additions
  and rely on the bridge bindings file alone (which still gives
  thread-level visibility).

## Phase / scope

Fourth of five deliverables in topic-8686:

1. (a) Canonical inbox write-path — **MERGED** (#113).
2. (2) Settings surface — **MERGED** (#114).
3. (b) Bridge module — **MERGED** (#117).
4. **(4) Observability tab — THIS PR.**
5. (c) Backfill four open threads — final, one-shot script.

After (4) merges, the Threadline tab is the user's single pane of
glass for agent-to-agent traffic: every thread, every message,
filters by remote agent / date / has-topic, search, and a clear
visual signal of which threads have a Telegram topic and which have
been spawned into a Claude Code session.
