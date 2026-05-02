# Side-Effects Review — Threadline → Telegram Bridge Module

**Version / slug:** `threadline-tg-bridge-module`
**Date:** `2026-05-02`
**Author:** `echo`
**Second-pass reviewer:** `self (incident-grounded reasoning)`

## Summary of the change

Ships the actual **bridge module** that mirrors threadline messages into
per-thread Telegram topics — third of five deliverables in topic-8686.

Builds on:
- (a) Canonical inbox write-path fix — PR #113, commit `9cc3e9af` — gives
  the bridge a single source of truth for inbound traffic.
- (2) Settings surface — PR #114 — provides the toggles + allow/deny
  list policy the bridge consults on every message.

Files added:

- `src/threadline/TelegramBridge.ts` — bridge class. Methods:
  - `mirrorInbound(evt)` — relay handler calls this after the canonical
    inbox write; auto-creates a topic if config policy allows, otherwise
    no-op or mirrors into existing.
  - `mirrorOutbound(evt)` — `/threadline/relay-send` calls this after
    success; mirrors into existing topic only (outbound never auto-creates).
  - Persistence in `.instar/threadline/telegram-bridge-bindings.json`
    (mode `0o600`).

Files modified:

- `src/commands/server.ts` — instantiates `TelegramBridge` after the
  Telegram adapter is constructed; passes through to AgentServer; the
  relay handler's `gate-passed` listener fires `mirrorInbound` async.
- `src/server/routes.ts` — `RouteContext.telegramBridge` typed; the
  `/threadline/relay-send` route fires `mirrorOutbound` on both the
  local-delivery and relay-delivery success paths.
- `src/server/AgentServer.ts` — accepts `options.telegramBridge`,
  passes through `routeCtx`.

Tests added: 18 unit cases in `tests/unit/TelegramBridge.test.ts`.

## Decision-point inventory

- `TelegramBridge.mirrorInbound` — **add** — relay-only mirror with
  auto-create gate via `TelegramBridgeConfig`.
- `TelegramBridge.mirrorOutbound` — **add** — relay-only mirror into
  existing topic; never auto-creates.
- `TelegramBridge.buildTopicName` — **add** — `{local}↔{remote} — {subject}`
  with truncation to 96 chars (Telegram 128 cap with headroom).
- `TelegramBridgeBindingsFile` — **add** — version=1 JSON file persisted
  at `.instar/threadline/telegram-bridge-bindings.json`.
- Relay handler in `server.ts` — **modify** — new `mirrorInbound` call
  AFTER the canonical inbox write, fire-and-forget with `.catch()`.
- `/threadline/relay-send` route — **modify** — new `mirrorOutbound`
  calls in BOTH success paths (local + relay); fire-and-forget.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The bridge is **relay-only**: it has zero blocking authority. It cannot
reject any input, route, or send. The only gate is "should I post this
into Telegram?" — and the answer is decided by `TelegramBridgeConfig`,
which was reviewed and pinned in PR #114.

False over-blocks are not possible at this layer. If the user reports
"a message I expected to see in Telegram didn't show up", the cause is
either (a) bridge disabled (master switch off), (b) auto-create denied
because the remote agent isn't allow-listed and `autoCreateTopics=false`,
or (c) the underlying Telegram API call failed (logged via the bridge's
warn channel, not surfaced as an error to the routing path).

## 2. Under-block

**What failure modes does this still miss?**

- **No retry on transient Telegram failures.** A 429 / 5xx from Telegram
  during `findOrCreateForumTopic` or `sendToTopic` is logged and skipped.
  No queue, no exponential backoff. Acceptable: the bridge is observability,
  not delivery — message liveness matters for the threadline relay, not
  for the Telegram mirror. A future PR can add a delivery queue if losing
  the occasional mirror becomes a real complaint.
- **Inbound from a relay that uses a different `threadId` than the
  outbound send.** The bridge keys bindings by `threadId`, which is the
  threadline-side id. As long as both sides use a consistent thread id
  (which they do post-(a)), the binding is stable. If a thread-id
  divergence sneaks in (e.g. the outbound side mints a fresh id), the
  outbound mirror returns `no-binding` and silently no-ops. This is the
  documented behavior; the canonical inbox in (a) is unaffected.
- **No de-duplication across rapid-fire same-thread inbound.** If the
  relay handler is invoked twice for the same `messageId`, the bridge
  will post twice. Out of scope for this PR — same-thread rapid-fire
  is handled at the relay layer (existing pipe-mode guard) and the
  threadline replay-gate (already enforced by the relay client).

## 3. Level-of-abstraction fit

The split is the same one used in (2):

- **TelegramBridgeConfig** owns *whether* to mirror (validation + policy).
- **TelegramBridge** owns *how* to mirror (binding lookup, topic creation,
  HTTP call, body formatting).
- The relay handler and `/threadline/relay-send` route own *when* to
  mirror (event firing).

The bridge depends only on a `TelegramSink` interface (subset of
`TelegramAdapter`'s `findOrCreateForumTopic` + `sendToTopic`). Tests
inject a fake sink to exercise success and failure paths without a
running Telegram. This keeps the bridge testable and the dependency
surface narrow.

## 4. Signal-vs-authority compliance

- **Signal:** the gate-passed inbox event (already authorized by
  `InboundMessageGate` upstream); the threadline_send → relay-send
  outbound success.
- **Authority:** `TelegramBridgeConfig` decides whether the bridge runs
  at all. The bridge itself emits zero decisions back to the routing
  layer — `mirrorInbound` and `mirrorOutbound` return `{posted, reason}`
  for observability only; nothing in the routing path inspects that
  return value. This is the canonical signal-vs-authority pattern: the
  bridge is a low-context observer; the higher-level intelligent gate
  (config + the existing inbound gate) holds blocking authority.

## 5. Interactions

- **Canonical inbox (PR #113).** The bridge fires AFTER the canonical
  inbox write at relay-ingest. Two writes — one local audit, one
  Telegram mirror — both flow from the same event. No coupling: if the
  canonical write fails, the bridge call still runs (and vice versa).
- **`telegram-reply.sh` pipeline.** The bridge does NOT use this
  pipeline — it calls TelegramAdapter primitives directly, bypassing
  the agent-reply pre-tone-gate path. There is no double-fire because
  `telegram-reply` is for agent → user replies tied to specific topics,
  whereas the bridge writes into bridge-owned topics distinguished by
  the `{local}↔{remote}` naming convention. If the user runs
  `/link <session>` to bind a session to a bridge topic, that's the
  user's explicit choice; the bridge doesn't generate that overlap by itself.
- **Spawn-session prompt.** The bridge does NOT replace the existing
  spawn-session orchestration. The relay handler still spawns Claude
  Code sessions on inbound; the bridge runs alongside, purely for user
  visibility.
- **`topic-session-registry.json`.** The bridge maintains its own,
  separate file (`telegram-bridge-bindings.json`) so it does not
  collide with session ↔ topic bindings. Reusing
  `topic-session-registry.json` would have conflated two distinct
  concerns (bridge bindings = thread → topic; session registry =
  session ↔ topic).

## 6. Rollback cost

- Set `enabled=false` via the dashboard or `PATCH
  /threadline/telegram-bridge/config`. Bridge stops mirroring on the
  next event. Existing bindings stay in the file (no dangling Telegram
  topics get cleaned up — they continue to exist in Telegram but the
  bridge stops feeding them).
- Drop the bridge module entirely: remove the
  `TelegramBridge` import + instantiation in server.ts + the two route
  hooks. Settings UI from (2) keeps working unchanged. Bindings file
  becomes an orphaned `.instar/threadline/telegram-bridge-bindings.json`
  on disk; safe to leave.
- No database migrations, no Telegram-side cleanup, no schema changes.

## Plan if a regression appears

- **Symptom: Telegram noise.** Verify settings — the user can flip
  `enabled=false` instantly via the dashboard. If the noise comes
  through an existing topic that the user wants quieter,
  `mirrorExisting=false` stops it without affecting auto-create policy.
- **Symptom: routing latency increases.** The bridge calls are
  fire-and-forget (`.catch(() => {})` on both `mirrorInbound` and
  `mirrorOutbound`). Routing should not be on the critical path of any
  Telegram call. If a regression shows otherwise, audit for an
  unintended `await` in the relay handler.
- **Symptom: Telegram topic spam.** Auto-create policy gone wrong.
  `shouldAutoCreateTopic` is unit-tested for "deny on either id" and
  "allow on either id"; if a real spam case appears, capture the
  `remoteAgent` + `remoteAgentName` values and add to the deny-list.

## Phase / scope

Third of five deliverables in topic-8686:

1. (a) Canonical inbox write-path — **MERGED** (#113).
2. (2) Settings surface — **PR #114, merging**.
3. **(b) Bridge module — THIS PR.**
4. (4) Observability tab — extends the Threadline dashboard tab to render
   the canonical inbox + bindings + thread-resume-map.
5. (c) Backfill four open threads — one-shot script.

After (b) merges, the bridge is **armed but quiet by default**. The
user must flip `enabled=true` in the dashboard for any traffic to reach
Telegram. The next PR (4) lights up the observability view.
