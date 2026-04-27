# Side-Effects Review — telegram-delivery-robustness Layer 3 (DeliveryFailureSentinel)

**Version / slug:** `telegram-delivery-robustness-layer-3`
**Date:** `2026-04-27`
**Author:** `echo`
**Second-pass reviewer:** `subagent (Claude, fresh context)`

## Summary of the change

Ships Layer 3 of the `telegram-delivery-robustness` spec on top of the
already-merged Layer 1 (port-from-config + agent-id binding, PR #100,
commit `f9b5e3bb`) and Layer 2 (durable SQLite queue + `delivery_failed`
event endpoint, PR #101, commit `5b953c17`). Layer 3 introduces an
in-process `DeliveryFailureSentinel` that reads the per-agent SQLite
queue, runs the recovery state machine (detect → claim → re-resolve
config → `/whoami` → re-tone-gate → `POST /telegram/reply` with
`X-Instar-DeliveryId` header → finalize OR escalate), and is feature-
flag-gated default-OFF via `monitoring.deliveryFailureSentinel.enabled`.

Files added:

- `src/monitoring/delivery-failure-sentinel.ts` — sentinel class (≈530 LoC).
- `src/monitoring/delivery-failure-sentinel/recovery-policy.ts` — pure deterministic policy evaluator.
- `src/messaging/system-templates.ts` — fixed-template constants + boot-time SHA verification + system-template allow-list.
- `src/messaging/whoami-cache.ts` — 60s in-process cache keyed on `(port, sha256(token), agentId, config-mtime)`.
- `src/messaging/secret-patterns.ts` — compiled-in redaction patterns.
- `src/messaging/local-tone-check.ts` — in-process wrapper around `MessagingToneGate`.
- `src/server/boot-id.ts` — synchronous-before-listener boot id (16 bytes, mode 0600).

Files modified:

- `src/server/routes.ts` — `X-Instar-DeliveryId` 24h LRU dedup, `X-Instar-System` template-bypass on `/telegram/reply`, new `GET /delivery-queue` route.
- `src/server/AgentServer.ts` — wires `getOrCreateBootId` before listener bind; spins up `DeliveryFailureSentinel` after listener bind, gated on the feature flag.
- `src/server/WebSocketManager.ts` — adds `subscribeEvents()` for in-process listeners (no schema change for dashboard clients).
- `src/messaging/pending-relay-store.ts` — adds `selectClaimable(nowIso, limit)` and `purgeStaleClaimable(cutoffIso)` (no schema change; idempotent over the same DB created by Layer 2).

Tests added: 5 unit (`recovery-policy`, `system-templates`, `whoami-cache`, `boot-id`, `delivery-queue-route`) + 4 integration (`sentinel-recovery`, `sentinel-circuit-breaker`, `sentinel-tone-gate-recovery`, `sentinel-stampede-digest`).

## Decision-point inventory

- `DeliveryFailureSentinel.processRow` — **add** — runs the recovery state machine on a single queue row.
- `evaluatePolicy` (recovery-policy) — **add** — pure deterministic mapping of `(http_code, attempts, time_since_first)` to `{retry|escalate|finalize-*}`.
- `/telegram/reply` `X-Instar-DeliveryId` LRU dedup — **add** — server-side 24h LRU returns 200-idempotent on duplicate delivery_id.
- `/telegram/reply` `X-Instar-System` bypass — **add** — bypasses tone gate iff body matches a known compiled-in template.
- `/delivery-queue` route — **add** — read-only depth/oldest-age/by-state introspection.
- Tone gate authority (`MessagingToneGate.review`) — **pass-through** — sentinel calls `review()` directly via `local-tone-check`, never overrides its decision.
- WebSocketManager `broadcastEvent` — **modify** — also notifies in-process subscribers; existing dashboard clients see no change.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- The new `X-Instar-System` bypass is **deny-by-default** — only bodies that match a compiled-in template (regex- or SHA-bound) bypass the tone gate. Arbitrary system-flagged text falls through to the normal gate. There is no over-block here; the bypass narrows authority, it doesn't widen it.
- The `X-Instar-DeliveryId` LRU returns 200-idempotent on duplicate header values. A legitimate sender that intentionally retries a `delivery_id` (operator manually replays a row) will see the second send swallowed. Mitigation: the LRU is bounded at 10K entries with 24h TTL, so a deliberate delay > 24h triggers a fresh send.
- The recovery-policy escalates on `403/unstructured`. A server returning a non-JSON 403 body (rare, but possible from intermediate proxies) will skip retry. Acceptable: spec § 3d step 5 is explicit about default-deny on this code path.

---

## 2. Under-block

**What failure modes does this still miss?**

- **WebSocket-disconnected dashboard.** `broadcastEvent` notifies in-process subscribers BEFORE the WebSocket fan-out, so the sentinel reacts even with no clients. But if a server crashes between the script-side enqueue and the SSE event, the SSE primary path is lost and recovery falls to the 5-minute watchdog tick. This is the spec-acknowledged backstop, not a new gap.
- **Stampede summarization across ticks.** The `stampedeThreshold` check runs per-tick. A topic that accrues 4 entries per tick over 3 ticks (12 total) does not trigger the digest — each tick only sees 4. This is intentional: the digest's purpose is "compress a single outage's burst into one user-visible event", not "police a slow-burn."
- **Tone-gate failure-open.** When the tone gate provider is unavailable, `local-tone-check` returns `passed: true, failedOpen: true`. A queued message with technical leakage would be re-sent. Mitigation: the original send went through the same gate (which presumably passed); if the gate is now down, we don't have authority to override its prior pass. Documented in `local-tone-check.ts`.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

The split between `recovery-policy.ts` (pure, deterministic) and
`delivery-failure-sentinel.ts` (lifecycle, I/O) matches the spec's
signal-vs-authority framing exactly:

- The sentinel does **not** reason about content. It runs a state machine
  whose transitions are entirely determined by HTTP codes and counts.
- All user-visible content is fixed-template, with template integrity
  verified at boot.
- All tone judgment is delegated to `MessagingToneGate.review` via
  `local-tone-check`.

This is the right shape. The alternative — embedding policy decisions in
`AgentServer` or `routes.ts` — would couple recovery to HTTP handlers
and make the policy untestable in isolation. The current split keeps
the policy in 250 LoC of pure code with exhaustive unit coverage.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] **No** — this change produces a signal consumed by an existing smart gate (the `MessagingToneGate`). The sentinel runs a deterministic policy on enumerable HTTP codes, never on free-form content. User-visible text emitted by the sentinel is fixed-template only, and the templates were tone-gate-reviewed at code-review time. Per spec § 5 the sentinel is "a deterministic policy engine for retry mechanics + a fixed-template message emitter routed through the same single tone-gate authority."

The `X-Instar-System` server-side bypass deserves a closer look:

- The bypass is restricted to a **compiled-in allow-list** verified by SHA-256 (static templates) and bounded regex (parameterized templates with enumerated `{category}`).
- The allow-list cannot be modified at runtime — it ships in `dist/messaging/system-templates.js`.
- The sentinel sets `X-Instar-System: true` on its template sends; non-template bodies fail through to the normal gate.
- This is the bypass shape the spec calls for in § 3f. It does not introduce a new content authority.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** `X-Instar-DeliveryId` LRU runs BEFORE the tone gate. A duplicate replay returns 200-idempotent without the gate ever running. This is intentional — a duplicate header proves a prior send already went through the gate. No tone-gate event is emitted for the dedup return; the original send's gate event remains the only record.
- **Double-fire:** the sentinel and the script-side detector (Layer 2b) cannot fire on the same row. The script INSERTs with `state='queued'`; the sentinel transitions to `'claimed'` before any send. INSERT OR IGNORE on the same `delivery_id` is a no-op (Layer 2a property), so a tight-loop sender cannot enqueue the same row twice.
- **Races:** lease ownership uses `<bootId>:<pid>:<leaseUntil>`. PID reuse across reboots is handled by bootId mismatch (always reclaimable). Two sentinels on the same DB (shared worktree case) race on the `transition('claimed')` UPDATE; the loser sees `changes=0` and skips the row this tick.
- **Feedback loops:** the sentinel's recovered-marker send is fire-and-forget. A failed marker is logged and dropped — never queued. This prevents the "sentinel queues its own retry on its own follow-up" cascade.
- **WSManager subscribers:** new `subscribeEvents` API. Existing `broadcastEvent` callers see no behavioral change; in-process subscribers run on the same code path before the WebSocket fan-out. A subscriber that throws is logged but does not block the broadcast.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Wire format:** `/telegram/reply` accepts two new optional headers (`X-Instar-DeliveryId`, `X-Instar-System`). Existing callers that don't send them see no behavioral change.
- **New endpoint:** `GET /delivery-queue` (authed). Read-only; safe for dashboard polling.
- **Persistent state:** the sentinel reads the SQLite queue created by Layer 2 (`pending-relay.<agentId>.sqlite`). It writes lease metadata (`claimed_by`, `next_attempt_at`, `state` transitions) but does not change the schema. Layer 2's idempotent ALTER pattern remains compatible.
- **boot.id file:** new file at `<stateDir>/state/boot.id` (16 bytes, mode 0600). Persists across restarts within the same instar minor version. Operators upgrading multiple minor versions in quick succession will see one rotation per minor bump — this is intentional (queue semantics may change across minor versions, so prior-version leases must not survive).
- **Telegram users:** when the feature flag is OFF (default), users see no change. When ON and recovery succeeds, users see (a) the original message delivered up to 24h after the original outage, (b) a `_(recovered)_` follow-up marker ~2s later. When recovery fails, users see one fixed-template escalation message per topic; a circuit breaker prevents flooding.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Hot-fix release:** revert the source. Existing queue rows become inert (no sentinel reads them). Layer 1 and Layer 2 keep working — the originating incident is still fixed by Layer 1 alone.
- **Feature flag toggle:** the cleanest rollback is `monitoring.deliveryFailureSentinel.enabled = false`. Default is already OFF; only opt-in agents need to flip the flag back. No data migration, no user-visible regression.
- **Persistent state:** `boot.id` and the SQLite queue both live under `.instar/state/` and are gitignored (Layer 2 added the patterns). No backup capture, no cross-machine replay. A rollback that wipes both files leaves the agent in a clean state.
- **User visibility during rollback:** an agent mid-recovery when the flag flips OFF will leave a row in `state='claimed'` with a stale lease. Next sentinel run (after re-enabling) reclaims it via bootId/lease-stale checks. No user-visible regression.

---

## Conclusion

The Layer 3 implementation matches the spec exactly. The split into a
pure policy module + a stateful sentinel made the policy exhaustively
testable (32 unit tests covering the entire decision table). The
`X-Instar-System` bypass is the most security-sensitive new surface,
and it's structurally constrained — compiled-in allow-list + bounded
regex on parameterized templates + SHA-256 on static templates. The
default-OFF feature flag means no current agent is affected by this
PR's runtime behavior unless they explicitly opt in.

Two design decisions made during the review:

1. The `WhoamiCache` originally keyed only on `(port, tokenHash)`. After
   re-reading § 1c, I added `agentId` to the key so a multi-agent host
   running multiple servers on different ports cannot poison each other's
   caches. (This was already implicit in the spec via the `X-Instar-AgentId`
   header on `/whoami`, but explicit keying makes the invariant local.)
2. The recovery-policy originally retried on attempt = MAX_ATTEMPTS. After
   re-reading § 3c ("9 steps... attempts exhausted"), I changed the
   threshold to `attempts >= MAX_ATTEMPTS` so the 9th attempt's failure
   escalates rather than scheduling a 10th. The unit test was updated
   accordingly.

Ship.

---

## Second-pass review (if required)

**Reviewer:** subagent (Claude, fresh context)
**Independent read of the artifact: concur**

The Layer 3 implementation correctly factors the deterministic policy
into a pure module, isolates user-visible content into compiled-in
templates with boot-time SHA verification, and gates everything behind
a default-OFF feature flag. The `X-Instar-DeliveryId` LRU-before-gate
ordering is the correct precedence: a duplicate `delivery_id` proves a
prior gate pass, so re-running the gate on the same body would be wasted
work and could spuriously block on a tone-gate provider transient.

One concern raised, addressed in this PR before commit:

- The `WhoamiCache` cache key initially omitted `agentId`. On a host
  with multiple servers sharing a token (uncommon but possible during
  config rotation drills), this would have produced cross-agent
  whoami leakage. Fix: include `agentId` in the cache key.

No other concerns at the medium-or-higher threshold.

---

## Evidence pointers

- Unit tests: `tests/unit/recovery-policy.test.ts` (32 cases), `tests/unit/system-templates.test.ts` (15 cases), `tests/unit/whoami-cache.test.ts` (6 cases), `tests/unit/boot-id.test.ts` (8 cases), `tests/unit/delivery-queue-route.test.ts` (2 cases).
- Integration tests: `tests/integration/sentinel-recovery.test.ts` (2 cases — happy path + agent-id mismatch retry), `tests/integration/sentinel-circuit-breaker.test.ts` (1 case — 5 failures → suspend → resume on auth-hash change), `tests/integration/sentinel-tone-gate-recovery.test.ts` (1 case — re-gate rejection finalizes as `delivered-tone-gated` with meta-notice), `tests/integration/sentinel-stampede-digest.test.ts` (1 case — 6 entries → digest + 5 dropped).
- Spec: `docs/specs/telegram-delivery-robustness.md` § 4 Layer 3.
- Predecessor PRs: #100 (Layer 1, `f9b5e3bb`), #101 (Layer 2, `5b953c17`).
