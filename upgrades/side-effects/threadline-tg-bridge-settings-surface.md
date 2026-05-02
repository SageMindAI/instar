# Side-Effects Review — Threadline → Telegram Bridge: Settings Surface

**Version / slug:** `threadline-tg-bridge-settings-surface`
**Date:** `2026-05-02`
**Author:** `echo`
**Second-pass reviewer:** `self (incident-grounded reasoning)`

## Summary of the change

Ships the **settings surface** for the Threadline → Telegram bridge BEFORE
the bridge module itself (deliverable b) goes live. This is the second of
five deliverables in the topic-8686 build; it ensures default-OFF
auto-create is structurally enforced from day one, so when (b) lights up
the bridge, the user's noise budget is already wired and respected.

The settings surface is three layers:

1. **`TelegramBridgeConfig` class** — a thin, validated read/write API over
   `LiveConfig` keys under `threadline.telegramBridge.*`. Owns the policy
   functions `shouldAutoCreateTopic(remoteAgent)` and
   `shouldMirrorIntoExistingTopic()` that the bridge module will call on
   every inbound/outbound message.
2. **HTTP endpoints** — `GET /threadline/telegram-bridge/config` and
   `PATCH /threadline/telegram-bridge/config`, mounted in the main route
   set (bearer-auth enforced globally). Validation lives in the config
   class; the route handler is a 14-line wrapper.
3. **Dashboard tab** — a new "Threadline" tab with a Bridge Settings card:
   master switch, two policy toggles, and dual allow/deny-list management.
   The same tab is the natural home for deliverable (4)'s observability
   view; this PR ships a placeholder noting that.

Files added:

- `src/threadline/TelegramBridgeConfig.ts` — config class + `shouldAutoCreateTopic`, `shouldMirrorIntoExistingTopic` policies.
- `tests/unit/TelegramBridgeConfig.test.ts` — 22 unit cases.
- `tests/integration/telegram-bridge-config-routes.test.ts` — 8 supertest cases.

Files modified:

- `src/server/routes.ts` — `RouteContext.telegramBridgeConfig: TelegramBridgeConfig | null` + two routes.
- `src/server/AgentServer.ts` — accepts `options.telegramBridgeConfig`, passes through `routeCtx`.
- `src/commands/server.ts` — instantiates `new TelegramBridgeConfig(liveConfig)` once at boot, hands it to `AgentServer`.
- `dashboard/index.html` — new Threadline tab (button + panel + load/patch/render JS + tab-registry entry).

## Decision-point inventory

- `TelegramBridgeConfig.update(patch)` — **add** — partial-patch
  application with type validation; emits `change` events per field.
- `TelegramBridgeConfig.shouldAutoCreateTopic(remoteAgent)` — **add** —
  policy: `enabled && (allowList match → true; denyList match → false; else autoCreateTopics)`.
- `TelegramBridgeConfig.shouldMirrorIntoExistingTopic()` — **add** —
  policy: `enabled && mirrorExisting`.
- `GET /threadline/telegram-bridge/config` — **add** — read endpoint
  (bearer-auth via global `authMiddleware`).
- `PATCH /threadline/telegram-bridge/config` — **add** — partial-patch
  endpoint with 400 on validation error and 503 when config not initialized.
- Dashboard `loadThreadlineBridgeConfig` / `tlBridgePatchConfig` — **add** —
  load + optimistic write; rolls back via re-load on 4xx.
- Toggle change-handlers — **add** — bound once on `DOMContentLoaded` with
  a `tlBridgeWiring` reentrancy guard (avoids feeding back the
  programmatic `checked = ...` set into the change event).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The settings class deliberately rejects non-boolean toggles and non-string
list entries with a 400. The error messages name the offending field
("enabled must be boolean", "allowList must be string[]"). False positives
are not possible at the type level: a JSON `true`/`false` is unambiguous,
and a JSON array of strings is unambiguous. The dashboard cannot send
malformed input — `<input type="checkbox">.checked` is always a boolean
and the list-management code stringifies entries.

The PATCH endpoint **ignores unknown fields silently** (the route filters
the body to known fields before forwarding to `update`). This is
intentional: future toggles can be deployed server-side without breaking
older dashboards that don't know about them. There is a unit test for
this exact behaviour.

## 2. Under-block

**What failure modes does this still miss?**

- **No rate-limit on PATCH.** A pathological dashboard could thrash
  toggles. The cost is bounded — each PATCH writes config.json
  atomically; throughput is disk-bound, not unbounded. Acceptable for a
  bearer-auth-gated endpoint with one user.
- **No audit log on config changes.** A future PR could forward the
  `change` events from `TelegramBridgeConfig` into the existing event
  stream, but it's out of scope for this deliverable. Today, config
  changes show up in `config.json` git history (or backup snapshots).
- **The `enabled` master switch is still load-bearing for the bridge
  module that doesn't exist yet.** This PR does NOT enforce default-OFF
  in any code path that mirrors messages — it only persists the toggles.
  Enforcement happens in deliverable (b), where the bridge module calls
  `shouldAutoCreateTopic` and `shouldMirrorIntoExistingTopic` at every
  routing decision. The unit tests for those two functions in this PR
  pin the policy contract so (b) cannot drift.
- **Validation does not deduplicate trailing-whitespace in arbitrary
  Unicode whitespace.** `dedupeAndTrim` uses `.trim()` (ASCII whitespace
  + Unicode whitespace per ECMAScript). Acceptable.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The split between class (validation + policy), routes (thin HTTP
shim), and dashboard (presentation only) is the standard
"signal-vs-authority" shape: brittle low-context surfaces (the dashboard
checkboxes) emit signals; the higher-level intelligent gate
(`TelegramBridgeConfig.update` + the policy functions) holds the
blocking authority.

The settings class lives under `src/threadline/` because it's a
threadline-specific feature; placing it in `src/config/` would conflate
it with the generic `LiveConfig`. The bridge module in deliverable (b)
will instantiate this class — it does NOT instantiate `LiveConfig`
directly, which keeps key naming centralized.

## 4. Signal-vs-authority compliance

- **Signal:** dashboard checkbox toggles, dashboard list inputs, REST
  PATCH bodies. Each is a low-context request that "wants" something to
  change.
- **Authority:** `TelegramBridgeConfig.update` is the single chokepoint
  that validates types, dedupes lists, and writes to config.json. The
  bridge module (b) will read its decisions through `shouldAutoCreateTopic`
  and `shouldMirrorIntoExistingTopic` — both pure functions of the
  current settings.

The bridge module itself, when it ships, will be **relay-only** (no
block/allow surface). The blocking authority for noise control lives
exactly here, in the config policy. This separation is the
signal-vs-authority memory pattern applied correctly: the bridge
forwards messages it sees; the config class decides what gets seen.

## 5. Interactions

- **`LiveConfig`.** All reads and writes go through the existing
  `LiveConfig.get` / `.set` API. No new file format, no new mtime
  watcher, no new poll. Atomic write semantics are inherited.
- **`config.json` schema.** The new keys `threadline.telegramBridge.*`
  are namespaced under the existing `threadline` block. Older agents
  without these keys read the documented defaults (defined in
  `DEFAULT_TELEGRAM_BRIDGE_SETTINGS`). No migration needed.
- **Bridge module (deliverable b, future PR).** Will instantiate
  `TelegramBridgeConfig` from `liveConfig` and call the policy functions.
  This PR pins the contract via unit tests so (b) cannot accidentally
  deliver while `enabled=false` or while a remote agent is in the deny
  list.
- **Observability tab (deliverable 4, future PR).** Will share the same
  Threadline dashboard tab and extend the panel HTML; the bridge
  settings card stays put.
- **Bearer-auth via `authMiddleware`.** Both routes are
  globally-authenticated. No change to auth wiring.

## 6. Rollback cost

**How easy is it to undo this if it breaks something in production?**

Trivially. The change is purely additive:

- Drop the new `TelegramBridgeConfig` class file → no callers in
  production code (only the new server.ts instantiation + the new
  routes use it).
- Drop the two routes → unauthenticated GET still 503's elsewhere; the
  dashboard tab silently fails on `loadThreadlineBridgeConfig`.
- Drop the dashboard tab + JS → no regression elsewhere; other tabs
  unaffected.
- The new `config.json` keys are silently ignored by older agents — no
  schema migration to unwind.

No file format changes, no shared-state changes, no new processes, no
new sockets. The PR is a pure "API + UI for not-yet-shipped feature"
shape — the safest possible kind of change.

## Plan if a regression appears

- **Symptom: dashboard tab errors.** Check `apiFetch` logs in the browser
  console; verify the bridge config endpoints return 200 from the agent
  server; verify auth token is correct.
- **Symptom: toggle change feeds back into a loop.** The
  `tlBridgeWiring` reentrancy guard skips the change handler while
  `renderThreadlineBridgeConfig` is programmatically setting `.checked`.
  If a regression escapes the guard, log the toggle source — DOM
  `change` events are synchronous, so the guard works as long as the
  programmatic set is followed by `tlBridgeWiring = false` in a
  `try/finally`.
- **Symptom: config.json gets a stray key.** The `update` method only
  writes the five known keys; no caller has a path to write something
  else. If junk appears, suspect manual editing.

## Phase / scope

Second of five deliverables in topic-8686. Order:

1. (a) Canonical inbox write-path fix — **MERGED** as PR #113 (commit `9cc3e9af`).
2. **(2) Settings surface — THIS PR.** Default-OFF auto-create, allow/deny list, dashboard tab.
3. (b) Bridge module — reads this config, mirrors threadline messages.
4. (4) Observability tab — extends the Threadline dashboard tab.
5. (c) Backfill four open threads — one-shot script.

Subsequent deliverables (b, 4, c) all depend on this settings contract.
The 22 unit tests + 8 integration tests pin the contract so they cannot
drift as the bridge module is built.
