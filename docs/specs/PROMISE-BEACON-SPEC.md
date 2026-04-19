---
title: "Promise Beacon — Follow-Through Heartbeats for Open Commitments"
slug: "promise-beacon"
author: "echo"
review-convergence: "2026-04-18T22:50:00Z"
review-iterations: 3
review-completed-at: "2026-04-18T22:50:00Z"
review-report: "docs/specs/reports/promise-beacon-convergence.md"
approved: true
approved-by: "Justin (JKHeadley)"
approved-date: "2026-04-18"
approval-note: "Approved via Telegram topic 7383 — 'Sounds great! Please continue to [build]'. Defaults ratified: prefix=⏳, maxDailyLlmSpendCents=100, no silent sentinelAutoEnable, quiet hours 22:00–08:00 local."
ratified-defaults:
  prefix: "⏳"
  maxDailyLlmSpendCents: 100
  sentinelAutoEnable: false
  quietHours: "22:00-08:00"
---

# Promise Beacon

> When the agent says "I'll come back when X finishes" and then works silently for 30+ minutes, the user has no signal whether the agent is alive, progressing, or has forgotten. PresenceProxy (the "standby" feature) covers only the opposite silence shape — *user waiting on agent* — because it is triggered by an unanswered user message. This spec adds a symmetric system that watches *open commitments with a topic audience* and emits heartbeats on a commitment-scoped cadence.
>
> **Major v2 reframe:** Round 1 of convergence review caught that instar already has `CommitmentTracker` (durable ledger with auto-verification) and `CommitmentSentinel` (LLM scanner that catches unregistered commitments on Telegram). The spec's original "new ledger + new auto-parser" was duplicate infrastructure. The Promise Beacon is now a *third* monitor sitting alongside those two — CommitmentTracker enforces state (did the config stick?), CommitmentSentinel detects declarations, PromiseBeacon handles the communication cadence (did the agent go quiet on the user?). One ledger, three complementary monitors.

## ELI10 version

You already have two babysitters. One watches when you're waiting for the agent to reply. That's "standby." The other watches if the agent said "I changed your config" and quietly checks the config is still changed — that's the promise ledger.

Neither of them knows how to nudge you when the agent promised "I'll come back in a while" and then just… goes quiet. That's a third shape of silence, and that's what this new babysitter — the Promise Beacon — watches. Every 10 minutes or so, if the agent has gone quiet on an open promise, the beacon reads what the agent is working on and posts you a one-line "still alive, still doing X" note.

Three babysitters, one for each shape of silence. That's the whole idea.

## Problem statement

### Triggering incident

On 2026-04-18 a multi-round spec convergence review ran for ~35 minutes in topic 7383. Early rounds produced visible output. Then rounds 3–5 ran without agent-facing updates. The user sent "how's it going?" at ~t+32m. From the user's perspective the agent had forgotten them. The work had in fact progressed fine — the silence was the problem, not the work.

### Why PresenceProxy doesn't cover this

`PresenceProxy` (src/monitoring/PresenceProxy.ts) watches user→agent silence. Its state machine is keyed on `MessageLoggedEvent` where `from: 'user'`; timers fire only while a user message is unanswered. When the agent *itself* announces "I'll come back later," no user message is pending. PresenceProxy is silent by design.

### What already exists (v2 discovery)

- **CommitmentTracker** (src/monitoring/CommitmentTracker.ts) — durable ledger at `.instar/state/commitments.json`. Types: `config-change`, `behavioral`, `one-time-action`. Statuses: `pending | verified | violated | expired | withdrawn | delivered`. Runs a `verify()` loop every 60s. **This is the ledger the beacon needs; we extend it, not replace it.**
- **CommitmentSentinel** (src/monitoring/CommitmentSentinel.ts) — Haiku-powered scanner that periodically reads recent Telegram messages per topic, finds agent commitments that never made it to the ledger, and registers them. **This is the auto-parser the v1 spec called "Phase 2." It is already built.**
- **PresenceProxy** — wrong-direction standby, not reusable for this case but provides the tiered-LLM + rate-limiting + prompt-sanitization primitives this spec inherits.
- **InitiativeTracker** — week-scale board, not minute-scale heartbeats. Distinct system. `linkedInitiativeId` on a commitment remains a valid integration seam for long-running initiatives whose milestones generate individual promises.

### Cost of the gap

- User confidence erosion; repeated "is the agent still there?" pings fragment focus.
- Silent failures: if the agent forgets (compaction, session death, CI blocking indefinitely), nothing outside the agent's head notices.
- Asymmetric trust: users rationally distrust "I'll get back to you" because it has no enforcement. Adding enforcement raises the ceiling of what they can ask the agent to do unattended.

## Proposed design

### Data model — extend `Commitment`, do not fork

Add fields to the existing `Commitment` interface (additive, backwards-compatible). New fields are all optional and only engage the beacon when set.

```ts
interface Commitment {
  // ... existing fields (id, userRequest, agentResponse, type, status, topicId, ...)

  // ── NEW: follow-through beacon fields ───────────────────
  /** Enable beacon heartbeats for this commitment. Requires topicId. */
  beaconEnabled?: boolean;
  /** Heartbeat cadence in ms. Clamped server-side to [60_000, 6*3600_000]. */
  cadenceMs?: number;
  /** Soft ETA. Past this, cadence doubles (exponential backoff). */
  expectedFinishAt?: string;
  /** Hard deadline. Past this, commitment transitions to `expired` with a ⚠️ user notice. */
  hardDeadlineAt?: string;
  /** ISO timestamp of the last heartbeat emitted. */
  lastHeartbeatAt?: string;
  /** Count of heartbeats emitted. */
  heartbeatCount?: number;
  /** Sonnet-tier assessments fired (escalation counter). */
  tier3AssessmentCount?: number;
  /** Hash of the tmux snapshot used for the most recent heartbeat (P1 fix). */
  lastSnapshotHash?: string;
  /** silencedUntil (rate-limit breaker). */
  silencedUntil?: string;
  /** Session identity at declaration time — used to detect session restart (A6 fix). */
  sessionEpoch?: string;
  /** Machine that owns the beacon for this commitment (A12/I1 fix). */
  ownerMachineId?: string;
  /** Provenance of the beacon-enabling mutation (S1 fix). */
  beaconCreatedBySource?: 'skill' | 'api-loopback' | 'sentinel' | 'manual';
  /** Idempotency key for skill retries (I4 fix). */
  externalKey?: string;
  /** User id for multi-user isolation (S10 fix). Required when multi-user mode is active. */
  userId?: string;
  /** If true, register for completion tracking but suppress heartbeats (except expiry). */
  silent?: boolean;
  /** Required to close via `/deliver` — message id of the delivery message (A4 fix). */
  deliveryMessageId?: string;
}
```

### Lifecycle additions

Existing commitment statuses are extended with `delivered` (added in Round 3 #18). `pending` is the beacon-watched state. New one-way transitions:

- `pending → delivered` when `POST /commitments/:id/deliver` is called with a valid `deliveryMessageId` (beacon-enabled path; see Round 3 #18).
- `pending → expired` when `hardDeadlineAt` passes with no delivery.
- `pending → withdrawn` on explicit close (was `abandoned` in v1; we reuse the existing withdrawn status).
- `pending → violated` if the Tier-3 Sonnet verdict is "dead session" or "stuck and not progressing past threshold."

Note: un-beaconed `one-time-action` commitments continue using `verified` via the existing verify-loop. Beacon-enabled commitments use `delivered` to keep delivery distinct from config verification.

Terminal statuses are immutable. `PATCH` on a terminal commitment's beacon fields is rejected.

### `PromiseBeacon` monitor

New class `src/monitoring/PromiseBeacon.ts`. Runs in the server process alongside PresenceProxy and CommitmentTracker.

**Scheduling model (P2 fix, drops polling):** on commitment create/mutate, schedule a `setTimeout(cadenceMs)`. On `MessageLoggedEvent` where `from:'agent'` and `topicId` matches and the message is not proxy-class (see A1), clear and re-arm the timer. Only active commitments consume timer slots. A lightweight boot-time pass schedules all existing `pending + beaconEnabled` commitments with jitter (P11 fix).

**Timer-fire handler (per commitment):**

1. **Session-epoch check (A6 fix).** Compare stored `sessionEpoch` to the current session identity for `(topicId → sessionName)`. Mismatch → transition to `violated` with reason `"session-restarted"`, emit a `⚠️` user notice, do not heartbeat.
2. **Session-alive check (A7 fix).** If `!isSessionAlive(sessionName)`, emit `⚠️ session ended, commitment unresolved`, transition to `violated`.
3. **Topic-session binding check (A11 fix).** Verify `getSessionForTopic(topicId) === promise.sessionName`. Mismatch → `violated` with `"session-reassigned"`.
4. **Ownership check (I1/A12 fix).** If `ownerMachineId !== currentMachineId` OR `!MultiMachineCoordinator.isAwake()`, do not fire. Phase 1 is awake-only; multi-awake lease support is a Phase 3 concern.
5. **Liveness check (A1 fix).** Query the message log: any agent message to `topicId` since `max(madeAt, lastHeartbeatAt)` where `metadata.source !== 'promise-beacon'` AND `!isSystemOrProxyMessage(text)`. If yes, reset timer to cadenceMs from that message's timestamp, return.
6. **PresenceProxy coexistence (A10 fix).** Acquire shared per-topic proxy mutex (new `ProxyCoordinator` class, extends the existing triage-mutex pattern into a topic-keyed surface). If held by PresenceProxy, skip this firing and re-arm.
7. **Rate-limit check (S7/P7 fix).** Check shared `LlmQueue` (a new surface that both PresenceProxy and PromiseBeacon consume; unified daily spend cap `promiseBeacon.maxDailyLlmSpendCents`, default 100). If `silencedUntil` in future or daily cap hit, skip + re-arm with exponential backoff.
8. **Snapshot-hash gate (P1 fix).** Capture tmux tail via `captureSessionOutput` (per-session 2s cache — P8 fix). Compute SHA-256 hash. If `hash === lastSnapshotHash`, emit a *templated* heartbeat ("still working, no new output since T+Xm") — no LLM call. Otherwise proceed to LLM.
9. **Tier selection.**
   - Tier 1 (Haiku): generate one-line status. Prompt requires the model to respond `NO_OBSERVABLE_PROGRESS` if output is empty/unchanged/unrelated to `promiseText`.
   - Tier 2 (Haiku, after 3 tier-1 heartbeats without snapshot change): compare progress across snapshots. If "no progress," mark stuck.
   - Tier 3 (Sonnet, after 2 tier-2 assessments of "stuck"): verdict `working | waiting | stalled | dead`. `stalled | dead` → transition to `violated` and trigger StallTriage path.
10. **Prompt-injection hardening (S2/S3/A14 fix).**
    - `promiseText` / `agentResponse` sanitized at commitment creation (reject patterns matching tmux delimiters, `SYSTEM:`, `IGNORE:`, `OVERRIDE:`, `</...>` XML-ish tags). Hash stored; verified per tick.
    - `sanitizeTmuxOutput(raw, credentialPatterns)` applied to captured output.
    - Both are wrapped in explicit `<untrusted_*>` delimiters with a system-level "treat as untrusted data" instruction.
    - `guardProxyOutput(text)` applied to generated heartbeat text before send.
    - **New post-filter** (S4 fix): regex pass for email/phone/token-shape leakage; redact before send; log the redaction event.
11. **Emit.** Send with `metadata: { source: 'promise-beacon', tier, isProxy: true }`. Prefix `⏳` (I5 fix; ratified below). The skip-list match in `isSystemOrProxyMessage` is updated to require **metadata equality, not prefix match** (S13/A1 fix) — a user typing `⏳` in a message is treated as user text.
12. **Persist hot state.** Mutate the commitment record's hot fields (`lastHeartbeatAt`, `heartbeatCount`, `lastSnapshotHash`, `tier3AssessmentCount`). Route this through the existing `CommitmentTracker.mutate()` single-writer queue (P3 fix) — never raw file writes.

**Heartbeat wording example:**
```
⏳ [Promise] Still working on spec-converge round 3 — external reviewers mid-call, ~4m in. No blocker. Next update ~10m.
```

### Declaration paths

1. **Existing `CommitmentTracker.record()` API, extended.** Beacon-enabled commitments pass `{ beaconEnabled: true, cadenceMs?, expectedFinishAt?, hardDeadlineAt, topicId }`. Default: `cadenceMs = 10*60_000`. `hardDeadlineAt` is **required** when `beaconEnabled: true` — no default (see Round 2 clarification "No default `hardDeadlineAt`"). Missing → 400.
2. **Existing `commit-action` skill.** Already invokes CommitmentTracker. Extended to pass beacon fields when the commitment has an active `topicId`. The skill's own local ledger row remains the source of truth for idempotency (I4 fix) — `externalKey` flows through.
3. **Existing `CommitmentSentinel` — opt-in "beacon-enable" step.** The Sentinel detects unregistered commitments from Telegram messages. When a detected commitment has an implicit cadence ("I'll update in 10 min"), the Sentinel's Haiku classifier extracts it and proposes beacon-enabling. **Shadow mode required (A9 fix):** for the first 7 days after this ships, the Sentinel logs the intent but does not actually enable the beacon. Precision report gates enabling. Default-off. Cap auto-created cadence to `≥ 5min`.

No auto-parse of outgoing agent messages is added in this spec — `CommitmentSentinel` already covers that surface and is intelligence-based, not regex.

### Delivery detection

- **Explicit (always):** `POST /commitments/:id/deliver` with body `{ deliveryMessageId }`. Server verifies the referenced message exists, is `from: 'agent'`, is non-proxy, and posted to `commitment.topicId` (A4 fix). Transition `pending → delivered` (Round 3 #18).
- **Implicit (opt-in, gated):** Sentinel-style Haiku pass inspects new agent messages on watched topics, proposes delivery close if the message semantically satisfies `promiseText`. **Suggest, don't auto-close** — UI prompt on the dashboard, skill prompt in-session.
- **Timeout:** `hardDeadlineAt` → `expired` with `⚠️` user notice. `silent: true` commitments still emit on expiry unconditionally (A13 fix).

### Storage model — hot/cold split (P4, I2 fix)

- **Cold fields** (id, userRequest, agentResponse, type, topicId, cadenceMs, hardDeadlineAt, createdAt, status, sessionEpoch, ownerMachineId, externalKey, userId) stay in `.instar/state/commitments.json` — git-ignored per existing CommitmentTracker layout. Rewritten only on status transitions. Inside `state/` already, so **not in the project's git-sync include path by default.**
- **Hot fields** (lastHeartbeatAt, heartbeatCount, lastSnapshotHash, tier3AssessmentCount, silencedUntil) in `.instar/state/promise-beacon/<id>.json` — per-promise, gitignored, machine-local.
- Per-record version field + optimistic CAS on write (P3 fix).

**Implication (S5 fix):** No git-synced beacon state. Remote machines cannot inject a beacon-enabled commitment that fires `⏳` messages on this machine. If cross-machine visibility is wanted later (Phase 3), use a signed-handshake protocol, not naive git-sync.

### Corruption / fail-open / fail-closed (P5 fix)

- **Ledger parse failure:** move corrupt file to `.<name>.corrupt.<ts>`, emit AttentionQueue entry. Fail-closed — do not auto-create an empty ledger.
- **Per-record validation failure:** bad records go to a quarantine list surfaced in `GET /commitments/diagnostics`. Other records keep running.
- **Intelligence provider unavailable:** fail-open to templated heartbeat (`⏳ still open, no fresh status available`). Silent skip is exactly the problem we're solving.

### GC / archival (P6 fix)

Retain `verified | violated | expired | withdrawn | delivered` commitments for 30 days (configurable), then move to `.instar/state/commitments.archive.jsonl` (append-only) and evict from the live map. Dashboard "show archived" toggle reads the archive lazily.

### Concurrency / races summary

| Race | Guard |
|---|---|
| Beacon ↔ PresenceProxy overlapping send | Shared `ProxyCoordinator` per-topic mutex (A10) |
| Beacon ↔ user-message mid-LLM | `hasAgentRespondedSince` re-check after LLM, before send (inherits PresenceProxy pattern) |
| Beacon tick ↔ HTTP mutation | Single-writer queue in CommitmentTracker (P3) |
| Multi-machine duplicate fire | `ownerMachineId` + awake-only Phase 1 (I1, A12) |
| Backup-restore burst | `now - lastHeartbeatAt > cadenceMs * 10` → transition to `violated` with `⚠️ [resumed-from-backup] status uncertain` user notice (I3, A27 — never silent) |
| Crash recovery burst | Jittered re-arm on boot (P11) |
| Self-silencing via beacon's own message | Metadata-based skip-list match, not prefix (A1, S13) |

### Integration points

| File / surface | Change |
|---|---|
| `src/monitoring/PromiseBeacon.ts` | New — scheduler + timer handler |
| `src/monitoring/CommitmentTracker.ts` | Extend Commitment schema; expose `mutate(id, fn)` single-writer surface; emit lifecycle events on bus |
| `src/monitoring/ProxyCoordinator.ts` | New — per-topic mutex shared with PresenceProxy |
| `src/monitoring/LlmQueue.ts` | Extract/extend — unified daily spend cap + concurrency limit shared across proxy monitors |
| `src/server/routes.ts` | Extend `/commitments/*` with beacon fields; new `/commitments/:id/deliver`; admin disable route |
| `src/server/AgentServer.ts` | Wire PromiseBeacon after CommitmentTracker, before Telegram adapter. `stop()` drains LLM queue before signalling adapters. |
| `src/messaging/shared/isSystemOrProxyMessage.ts` | Metadata-based skip match; `⏳` added only as fallback |
| Dashboard | Extend `/commitments` API surface (existing route); UI tab status: **if absent at implementation time, add minimal commitments tab as part of Phase 1** (read-only list + "Heartbeats" column + XSS-safe rendering per A24). Not blocking API delivery. |
| `commit-action` skill | Pass beacon fields and `externalKey` |
| `.instar/config.json` (per-agent) | `promiseBeacon: { enabled, maxDailyLlmSpendCents, globalMaxOpen, prefix, sentinelAutoEnable, quietHours: { start, end, timezone } }` — every ratified default is per-agent configurable; defaults fire only when an agent hasn't overridden. Same mechanism PresenceProxy already uses. |

### Prefix choice (I5 ratification)

`⏳` (hourglass). Renders on Android 8+/iOS 12+, semantically aligned with "open promise, time passing," visually distinct from `🔭` (standby) and `⚠️` (expiry). Skip-list match is **metadata-based** — `⏳` in user text does not trigger skip.

### Cost model (P7 honest republish)

Worst case, steady state, no agent activity:
- 5 open commitments × 10-min cadence × 8 hours = 240 heartbeat windows.
- With snapshot-hash gating (P1), ~70% are templated (no LLM). 72 Haiku calls + ~10 Tier-2 Haiku + ~2 Tier-3 Sonnet.
- At current pricing (~3k-token prompts): ~$0.80/day upper bound per agent.
- Daily cap `maxDailyLlmSpendCents: 100` is the kill-switch.

### Observability (I10 fix)

- `[PromiseBeacon]`-tagged logs matching PresenceProxy convention.
- Events on internal bus: `promise.heartbeat.fired`, `promise.heartbeat.skipped`, `promise.expired`, `promise.violated`. Picked up by SSE event stream.
- `GET /commitments/diagnostics` — per-commitment next-due-at, rate-limit counters, last decision.

### Security hardening summary

| Finding | Fix |
|---|---|
| S1 auth model | Record `beaconCreatedBySource`; `POST /commitments` (beacon-enabling path) defaults to loopback-only unless `promiseBeacon.allowRemoteCreate=true` |
| S2 promiseText injection | Sanitize + delimit + hash at create, verify per tick |
| S3 session output injection | Mandatory `sanitizeTmuxOutput` + `guardProxyOutput` per tier |
| S4 PII/secret leakage | Post-filter redactor before send |
| S5 git-synced injection | Hot/cold split; nothing beacon-related in synced paths |
| S6 replay/reopen | One-way status machine; PATCH of terminal states rejected |
| S7 DoS/spam | Payload size limits, `globalMaxOpen`, shared `LlmQueue` daily cap |
| S9 cross-machine ownership | Required `ownerMachineId`; awake-only fire in Phase 1 |
| S10 multi-user isolation | Required `userId` field; authorize all reads/mutations |
| S11 link validation | Validate `linkedInitiativeId` / linked commitment exists + user-scoped |
| S12 Phase-2 amplifier | Already covered by existing Sentinel shadow-mode requirement |

## Non-goals

- Not a task manager. No priorities, dependencies, assignments.
- Not a replacement for InitiativeTracker (week-scale) or the Attention Queue (one-off).
- Not a new ledger — extends CommitmentTracker.
- Not a cross-agent commitment registry.
- Not an auto-parser (Sentinel already handles that surface).
- Phase 1 is not multi-awake safe; primary-standby only.

## Phases

### Phase 1 — core (single PR)
1. Extend Commitment schema (additive, no migration needed).
2. `PromiseBeacon` monitor with all tier logic, hot/cold split, metadata-based skip, ownership gate.
3. `ProxyCoordinator` + shared `LlmQueue` extraction.
4. `⏳` prefix integration.
5. `/commitments/:id/deliver` with `deliveryMessageId` verification.
6. `commit-action` skill passes beacon fields + `externalKey`.
7. Dashboard "Heartbeats" column on existing commitments view.
8. Tests:
   - Unit: tier transitions, snapshot-hash gate, session-epoch guard, ownership gate, metadata-skip correctness (heartbeat doesn't reset its own clock), rate-limit, restore grace window.
   - Integration: real beacon + stubbed `captureSessionOutput` (I11 — no real tmux needed) + real HTTP + stub Telegram adapter + stub MessageRouter log.
   - Adversarial: injection in `promiseText`, stale ledger restore, session-restart mid-flight, PresenceProxy-coincident send.

### Phase 2 — Sentinel integration (follow-up)
- CommitmentSentinel extended to propose beacon enablement (shadow-mode default).
- Delivery auto-match (suggest only).
- 7-day shadow-mode precision report gates enabling.

### Phase 3 — multi-awake / cross-machine
- Distributed per-topic lease (file-lock with TTL, explicit handoff) if multi-awake coordination is introduced.
- Not part of this spec; called out so Phase 1 doesn't box it out.

## Round 2 clarifications (tightening of v2)

Round 2 surfaced ~35 non-architectural findings. This section makes each previously-implicit contract explicit. No v2 design decisions change.

### Prerequisite PR — `CommitmentTracker.mutate()` (I14, P12, P3)

`mutate(id, fn)` does **not** exist today. A prerequisite micro-PR (merged before Phase 1) extracts a single-writer queue with the following contract:

- Every write path (`record`, `withdraw`, beacon tick, Sentinel registration, verify loop, expiry pass, escalation) serialises through `mutate(id, fn)`.
- Queue is FIFO with per-id coalescing (consecutive mutations to the same id collapse to one flush).
- Bounded depth 256; overflow rejects with 503 (never silently drops).
- Each record carries a monotonically-increasing `version: number`; `mutate`'s read/apply/write is optimistic-CAS on version and retries once on conflict.
- `CommitmentStore.version` bumps from `1` to `2`; loader back-fills `version: 0` on existing records.
- p99 enqueue→applied target 50ms under 20-open load.

### PresenceProxy refactor in-scope (I16)

`ProxyCoordinator` is a Phase 1 refactor that both PresenceProxy and PromiseBeacon consume. Partial adoption is explicitly rejected as a non-fix. PresenceProxy's local mutex is removed in the same PR. Regression test: both monitors firing a Tier-1 on the same topic — only one prevails.

### `LlmQueue` priority lanes (I17, P13, S17)

Extracted shared queue has **two lanes** and a reservation rule:

- **Interactive lane** (PresenceProxy + delivery-close verification): reserved ≥ 40% of `maxDailyLlmSpendCents`, preempts background lane on arrival.
- **Background lane** (PromiseBeacon heartbeats, Sentinel shadow scans): consumes residual budget.
- Per-topic daily sub-cap: max 30% of total daily cap per topic.
- PresenceProxy's existing fail-open semantics preserved — if its lane hits ceiling, it templated-degrades (same as today), never starves.

Test includes: beacon floods the background lane → PresenceProxy Tier-1 must still fire on a new user message.

### Session epoch definition (A6, A16)

```
sessionEpoch = "${claudeCodeSessionUuid}|${serverBootId}"
```

- `claudeCodeSessionUuid`: the Claude Code session UUID read from the session's metadata file (not tmux start time; tmux ctime is seconds-granular and spoofable).
- `serverBootId`: a random UUID generated at AgentServer boot, stable across the server's lifetime.
- Both components verified against a server-held map (`activeSessions.get(sessionName)`); mismatch → session restarted → commitment `violated`.

### Metadata integrity (A21)

Message metadata `source` is **server-stamped** at the `MessageRouter` ingress. Caller-supplied `source` values are overwritten. No API surface accepts `source='promise-beacon'` from an untrusted caller. The skip-list matches strictly on server-stamped metadata equality.

### Snapshot hash normalization (P14)

Before SHA-256, tmux capture output passes through:
1. Strip ANSI CSI sequences (`\x1b\[[\d;]*[a-zA-Z]`).
2. Strip trailing whitespace per line; strip trailing blank lines.
3. Collapse common spinner unicode ranges (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) to a single placeholder.
4. Strip cursor-position / bell / save-restore control bytes.

Test: feed two captures with identical visual text + different spinner frames → same hash.

### Cross-file atomicity ordering (P15, S20)

- **Cold file is authoritative.** Terminal status transitions write cold first, then clean hot.
- **Boot reconciliation pass:** for each hot-state file, if the corresponding cold record is terminal or absent, archive-rename the hot file with `.orphan.<ts>` suffix — never delete, never reuse.
- Hot-state write for a commitment whose cold record is terminal is a no-op (caller gets `COMMITMENT_TERMINAL` error).

### Schema migration (I15, S21)

- `CommitmentStore.version` bumped to `2`.
- Loader: v1 → v2 back-fills `version: 0` per record; beacon-enabled records missing `ownerMachineId` are populated with `currentMachineId` at first mutation.
- All writes go through `mutate()` (schema-preserving merge; unknown fields retained). Full-object replace writes are removed from the codebase.

### Terminal immutability (A17, A23)

All `PATCH` on a terminal commitment is rejected with 409, regardless of field. Corrections require a new commitment + explicit link to the archived one. `cadenceMs` / `hardDeadlineAt` / `expectedFinishAt` on a pending+activated commitment are also write-once — modification requires `withdraw` + new record.

### Proxy-tag filtering in agent context (A25)

The tmux-capture layer that injects context back to the agent (compaction recovery, self-knowledge queries, session summarisation) strips messages tagged `metadata.isProxy === true` before injection. Lookup is by metadata, not by `⏳` prefix. AGENT.md gains a one-line notice: "`⏳` is reserved for the Promise Beacon."

### NO_OBSERVABLE_PROGRESS oracle collapse (A26)

The Tier-1 prompt returns `NO_OBSERVABLE_PROGRESS` as an internal control signal only. On emission, it is always collapsed into the same templated "still open, no new output" line the snapshot-hash gate emits. No external observer can distinguish "no progress" from "cache hit."

### Sentinel proxy-aware ingestion (A19)

`CommitmentSentinel`'s Telegram scan filter adds `message.metadata?.isProxy !== true`. Beacon heartbeats and PresenceProxy standby lines are never parsed as new commitments. Existing sentinel skip-list (via `isSystemOrProxyMessage`) is updated to the same metadata-based rule.

### Payload size limits (S14, S7)

Enforced at the HTTP route layer with 413 on overflow:
- `userRequest` ≤ 4 KiB
- `agentResponse` ≤ 8 KiB
- `promiseText` ≤ 2 KiB (where spec uses `promiseText`, this is `agentResponse` on the Commitment schema)
- `cadenceMs` ∈ [60_000, 21_600_000]
- `hardDeadlineAt` ≤ now + 30d
- `externalKey` ≤ 128 chars

### Loopback definition (S15)

"Loopback-only" = `req.socket.remoteAddress ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}` AND no `X-Forwarded-For` / `CF-Connecting-IP` / `X-Real-IP` headers present. Cloudflare-tunneled requests are never loopback regardless of source-address appearance.

### Multi-user activation (S10, S16)

- `multiUser.enabled: boolean` in config. When false, `userId` is optional and defaults to a constant `"single-user"` sentinel; all existing behaviour preserved.
- When true: every `/commitments/*` route requires an authenticated principal with a `userId`; records lacking `userId` are migrated lazily on first touch; list/diagnostics are user-scoped; link validation (S11, S19) runs on every tick, not only at create.

### No default `hardDeadlineAt` (I22, Q3 resolved)

Beacon-enabled commitments **must** declare `hardDeadlineAt`. `POST /commitments { beaconEnabled: true }` without `hardDeadlineAt` returns 400. A silent auto-expiry at 24h would re-create the exact trust erosion this spec exists to prevent.

### Backup/restore notice symmetry (A27, I23)

- `cadenceMs * 10` stale threshold auto-transition is **not silent**: emits a `⚠️ [resumed-from-backup] status uncertain, manual review needed` message and sets status to `violated` (not `withdrawn`), leaving the trail visible.
- All terminal non-delivery transitions (`violated | expired`) emit a `⚠️` user-visible final message. `withdrawn` (explicit user action) is the only silent terminal path.

### Boot order + globalMaxOpen enforcement (I21)

`PromiseBeacon.start()`:
1. `await commitmentTracker.isReady()`.
2. Load all `pending && beaconEnabled` records.
3. If count > `globalMaxOpen`, keep the `globalMaxOpen` most-recent (by `createdAt`), archive-rename the rest with status `withdrawn` reason `"boot-cap-exceeded"`, emit AttentionQueue entry. Never silently drop.
4. Schedule remaining with jitter `= min(cadenceMs * 0.5, 60_000)`.
5. Return. AgentServer wires `PromiseBeacon.start()` between `CommitmentTracker.start()` and Telegram adapter `start()`.

### ProxyCoordinator liveness (P16, P18, P19)

- In-memory only (dies with process). No persistence. No distributed lock.
- Concurrent-fire semaphore on the beacon handler: max 4 in-flight.
- Per-topic mutex holder logged with owner tag; non-owner acquire after 2× `tier3DelayMs` idle fails loud (state leak caught, not hidden).

### In-memory indexing (P20)

In-memory state: `Map<id, Commitment>` (primary), `Map<topicId, Set<id>>` (liveness + PresenceProxy mutex checks), `Map<(userId, externalKey), id>` (idempotency), sorted min-heap of next-due-at for beacon scheduling. Updated incrementally on every `mutate()`. At `globalMaxOpen: 20` the secondary indexes are strictly defensive; they exist so raising the cap later doesn't require a rewrite.

### Archive bounding (P17)

`commitments.archive.jsonl` capped at 10 MiB. On overflow, rotate to `commitments.archive.<ts>.jsonl.gz` (gzipped). Retention for gzipped files: 1 year, then deleted with a one-line boot log.

### PII redactor = defense-in-depth (S18)

Regex redactor is acknowledged as defense-in-depth, not authority. Primary defense is the LLM prompt's "untrusted data" delimiter contract. Heartbeat text is additionally reviewed by a Haiku PII pass when Tier ≥ 2; Tier 1 is templated ~70% of the time via snapshot-hash gate, so the cost is negligible.

### Sanitizer canonicalization (A20)

Before reject-pattern matching and before hashing, `promiseText` / `agentResponse` are Unicode-NFC-normalized, zero-width characters stripped, and Unicode confusables folded (standard confusables-mapping set).

### externalKey idempotency contract (A18, P22)

- On POST with existing `externalKey` matching a **pending** commitment: return 200 with existing record (idempotent).
- On POST with existing `externalKey` matching a **terminal** commitment: return 409 with pointer to archived row. Never reactivate.
- `externalKey` is a server-enforced unique index within `(userId, externalKey)` scope.

### Dashboard rendering (A24)

All commitment-origin text rendered via `textContent` / templating-engine auto-escape (not `innerHTML`). CSP header restricts inline script. XSS review checklist for the new "Heartbeats" column added to PR checklist.

### deliveryMessageId race (P21)

`POST /commitments/:id/deliver` acquires the commitment's `mutate()` lock, which also blocks the timer-handler's persist step. In-flight LLM calls for that id are cancelled (AbortController). Delivery writes before the next timer can re-arm.

### Shadow-mode precision gate (S22, I19)

- Shadow log at `.instar/state/promise-beacon/sentinel-shadow.jsonl`.
- Per-entry: `{ topicId, userIdHash, cadenceBucket, detectedAt, confidence }`. No raw promiseText.
- Enabling requires: affirmative `promiseBeacon.sentinelAutoEnable=true` config flip AND precision ≥ 85% across ≥ 20 shadow events AND a user-visible approval message. Absent approval → shadow continues.

## Round 3 (cross-model review) clarifications

External models (GPT, Gemini, Grok) surfaced these material items after rounds 1–2 internal convergence. All folded in; none architectural.

### 1. `atRisk` intermediate state (GPT #1)

Tier-3 Sonnet verdicts of `stalled` or `dead` no longer auto-transition to `violated`. A new **non-terminal** flag `atRisk: boolean` is added to the Commitment schema. Flow:

- Tier-3 verdict `stalled` → set `atRisk: true`, emit `⚠️ [at-risk] task appears idle; still watching` user notice. Continue heartbeating (cadence doubles).
- Repeated Tier-3 corroboration (2 consecutive `stalled` over ≥ 30min span) OR hard signal (session dead/restart/reassigned/hardDeadline passed) → only then `violated`.
- Explicit hard signals (session restart/end/reassign/deadline/backup-stale) remain the ONLY auto-`violated` triggers without corroboration.

### 2. `beaconSuppressed` flag replaces boot-cap withdraw (GPT #2)

Boot-cap overflow no longer mutates commitments to `withdrawn`. New non-terminal flag `beaconSuppressed: boolean` with reason:

- Excess commitments at boot: `beaconSuppressed: true`, reason `"boot-cap-exceeded"`, **status stays `pending`**, no heartbeats fire. Single AttentionQueue entry for operator.
- Admin-visible; not user-visible unless count ≥ 5 or suppression ≥ 24h, then one user notice.
- Same flag used for other capacity-suppression cases (daily spend cap hit).

### 3. Remove `serverBootId` from `sessionEpoch` (Gemini #2)

Revised: `sessionEpoch = claudeCodeSessionUuid` (only). Server restart does NOT violate commitments whose underlying Claude Code session is still alive. Boot pass re-verifies session liveness via `isSessionAlive` before firing the first heartbeat; absent session → violated on that single path.

### 4. Deadline concept split (GPT #3)

Replace single `hardDeadlineAt` requirement with a small menu:

- `nextUpdateDueAt`: optional. "I'll check in by X." Past it → one `atRisk` notice, cadence continues.
- `softDeadlineAt`: optional. "I aim to be done by X." Past it → cadence doubles, no terminal transition.
- `hardDeadlineAt`: optional. "This MUST be done by X." Past it → `expired` terminal with `⚠️` notice.

At least one of the three is required when `beaconEnabled: true`. "Heartbeat only, no deadline violation" is expressed as `{ nextUpdateDueAt: …, hardDeadlineAt: null }`. Removes the pressure to fabricate arbitrary hard deadlines.

### 5. LLM preemption via AbortController (Gemini #1)

`LlmQueue` priority lanes use real preemption. Every background-lane LLM call receives an `AbortController.signal`. When the interactive lane is non-empty and the provider concurrency limit is hit, the queue `abort()`s the lowest-priority in-flight background call, frees its slot, re-enqueues the aborted task with a 30s delay. Aborted heartbeats collapse to templated ("still open, no fresh status"); never counted as failure.

### 6. Tmux capture settle + incomplete-escape handling (Gemini #3, Grok)

`captureSessionOutput` adopts a 500ms idle-settle requirement: if the capture contains an incomplete ANSI CSI sequence (`\x1b\[` with no terminator) OR the tmux pane's `cursor_active_at` is within the last 500ms, defer the capture by up to 2s (with a single retry). On retry failure, emit a templated "session active, output in flux" heartbeat — no LLM call. P14 normaliser additionally drops trailing incomplete escape sequences deterministically.

### 7. Agent awareness of own commitments (Gemini gap)

A new read-only context-injection hook exposes the agent's active beacon-enabled commitments on each session turn (truncated, most-recent-5, JSON summary):

```
<active_commitments>
[{"id":"cmt-…","promiseText":"…","nextUpdateDueAt":"…","atRisk":false},…]
</active_commitments>
```

Injected via the existing compaction-recovery pipeline. Enables the agent to self-regulate pacing without needing to remember across compaction. AGENT.md gains a one-line "check `<active_commitments>` before starting long work" directive.

### 8. Failover policy (Phase 1, bounded) (GPT #4)

When a commitment's `ownerMachineId` has not heartbeated any commitment for > 3× cadence AND the standby machine observes it via read-only view:

- Standby emits exactly one `⚠️ [monitoring-unavailable] owner machine is unreachable; commitment status unknown` message per affected topic.
- Does NOT take ownership automatically.
- User can manually reassign via `POST /commitments/:id/reassign-owner` (admin route, awake-machine-only).

### 9. Heartbeat message policy (GPT #5)

Explicit product policy for tone and repetition:

- **Template variants**: rotate across a small set (5 templated phrasings) to avoid word-for-word repetition.
- **Cadence stretching**: after 3 consecutive identical templated heartbeats (snapshot hash unchanged), cadence multiplier doubles (capped at 4×).
- **Content classes**: distinct wordings for `working | waiting | atRisk | uncertain`, all derived from Tier-1/2 verdicts.
- **Opt-down**: per-topic user preference `heartbeatVerbosity: 'terse' | 'normal'` (default normal). Dashboard toggle.
- **Do-not-disturb hours**: per-user quiet-hours window — heartbeats during quiet hours defer to window end (hardDeadline-passing expiry still fires immediately, gated only by `⚠️` priority).

### 10. Sentinel consent model (GPT #6)

Phase 2 Sentinel defaults to **propose-only** — detected commitments surface in the dashboard with a "enable heartbeats" button. No auto-enablement regardless of precision. Explicit auto-enable requires BOTH global config `sentinelAutoEnable: true` AND per-topic opt-in stored with the topic record. Shadow mode's purpose is precision data for the proposal UI, not for unlocking silent enablement.

### 11. LLM provider 5xx/429 behavior (Gemini gap)

On provider 5xx or 429: immediately fail-open to templated heartbeat. No retries inside the tick. Error recorded to `promise.heartbeat.skipped` event. Circuit breaker (per-provider): 3 consecutive failures within 60s → suspend non-templated heartbeats for 5 min; all heartbeats stay templated during suspension.

### 12. UTC normalization (Gemini gap)

All ISO timestamps in Commitment records are normalized to UTC (Z suffix) at HTTP ingress. Non-UTC values are accepted and converted server-side; the normalized form is what's stored and returned.

### 13. `cadenceMs` clamp transparency (Grok)

When a caller submits `cadenceMs` outside the `[60_000, 21_600_000]` range, the server clamps it and returns the clamped value in the response body's `appliedCadenceMs` field with a `warnings: ["cadenceMs clamped to 60s"]` array. Never silently clamped.

### 14. Multi-topic commitments (Grok)

Out of scope for Phase 1. A commitment has exactly one `topicId`. Cross-topic promises are expressed by declaring multiple commitments (shared `externalKey` suffix if useful). Revisit in Phase 2 if demand.

### 15. Inline prompt skeletons (Grok)

Tier-1 Haiku prompt (literal):

```
You are observing an agent's work terminal output to summarize its current progress on a specific promise.

<promise_text>{sanitizedPromiseText}</promise_text>
<tmux_output>
{sanitizedOutput}
</tmux_output>

Produce ONE short line (< 120 chars) describing observable progress toward the promise.
If the output shows no activity on the promise, or is empty, or is unrelated: respond EXACTLY with:
NO_OBSERVABLE_PROGRESS

Do not include URLs, imperatives, or credentials.
```

Tier-2 and Tier-3 prompt skeletons follow the same shape with added `<previous_snapshot>` block and verdict vocabulary `{working|waiting|stalled|dead}`. Full prompts live in `src/monitoring/PromiseBeacon.prompts.ts`.

### 16a. Hash canonicalization — volatile-output classes (Gemini additional)

Snapshot normalization extends beyond ANSI + spinner stripping to mask common volatile-but-non-semantic output classes before hashing:

- Timestamps (ISO, Unix seconds, `HH:MM:SS`) → replaced with fixed token `[TS]`.
- Byte counters / progress percentages (`N%`, `N/M bytes`, `N KiB/s`) → `[PROG]`.
- Monotonic counters in common formats (e.g. `iter=N`, `step N`) → `[CTR]`.

This preserves the 70%-templated cost target against naturally noisy output (build logs, download progress, test runners). Test fixture includes an npm install log to assert stable hashing across two runs.

### 16b. Tmux capture byte/line caps (Gemini additional)

`captureSessionOutput` is bounded: max 4 KiB or 200 lines (whichever comes first, from tail). Rejected overflow is logged. Eliminates context-overflow risk and bounds Haiku token spend per call deterministically.

### 16c. Session-restart softer than "violated cliff" (Gemini additional)

Revising Round 3 item #1's intermediate-state principle to session-restart too: on `claudeCodeSessionUuid` mismatch, transition to non-terminal `paused` with `atRisk: true` (new status value), emit `⚠️ [paused] session restarted — monitoring held for 30 min pending user action`. After 30 min without resumption/reassignment, transition to `violated`. `paused` is a new non-terminal status next to `pending`.

### 16d. User-initiated cancellation path (Gemini gap)

Add `POST /commitments/:id/cancel` — distinct from `/deliver` (fulfilled) and existing `/withdraw` (administrative). `cancel` means "user decided not to require this promise anymore." Transitions to `withdrawn`, reason `"user-cancelled"`, no `⚠️` notice. Exposed in dashboard as a per-row "cancel heartbeats" button.

### 16e. Timer handler exception contract (Gemini gap)

The beacon's `setTimeout`-driven handler is wrapped in a top-level try/catch. Exceptions are:
- Logged with `[PromiseBeacon]` tag + commitment id + stack.
- Counted per commitment (`timerErrorCount`). After 3 consecutive errors on one commitment, transition to `paused` with reason `"handler-errors"`.
- Never propagated to the event loop (would crash the server).

### 16. Emoji fallback (Grok)

Heartbeat rendering degrades gracefully: when posting to a plain-text surface (no emoji support), `⏳` is replaced with `[heartbeat]`. Detection: per-adapter capability flag; Telegram/Slack render emoji; iMessage/SMS adapters substitute text form.

### 17. Timer durability across restart/sleep (GPT-agent)

`nextDueAt = max(lastHeartbeatAt, madeAt) + cadenceMs` stored on each commitment row. On boot/wake from sleep, the scheduling pass derives next-tick from `nextDueAt`, not from in-memory `setTimeout` state. Sleep gap > cadence triggers the backup-restore grace pass (already spec'd). Test: laptop-close for 2h with an open commitment → on wake, exactly one `⚠️ [resumed-from-backup]` notice, not N backlogged heartbeats.

### 18. Status semantics per commitment type (GPT-agent)

`verified` is overloaded — it means "config stuck" for `config-change` but "delivery confirmed" for beacon-enabled `one-time-action`. Resolution:

- `verified` retains its CommitmentTracker meaning (state verified).
- For beacon-enabled delivery, add distinct terminal status `delivered`. Transition: `pending → delivered` via `/deliver` endpoint. `delivered` implies no more heartbeats, no future verification attempts.
- Existing commitments migrate naturally: un-beaconed `one-time-action` commitments continue using `verified` via verify-loop. New beacon commitments use `delivered`.

### 19. Audit retention for heartbeats + redactions (GPT-agent)

All heartbeat emissions, redaction events, tier-3 verdicts, and `atRisk`/`paused` transitions are appended to `.instar/state/promise-beacon/audit.jsonl`. Retention: same 30d live + 1yr archived policy as the commitment archive (P17). Enables post-hoc review of "why did the beacon say that."

### 20. Partial fulfillment (GPT-agent)

Out of scope for Phase 1. A commitment is either delivered (complete) or still pending. Partial fulfillment is expressed by splitting one commitment into N commitments at declaration time. Revisit if demand surfaces.

## Residual open questions (for user ratification)

1. **Prefix ratification.** `⏳` (hourglass) with `[heartbeat]` fallback.
2. **Rate-limit default `maxDailyLlmSpendCents: 100`.** Fine at ~$0.80/day steady state. Tune after first week of data.
3. **Sentinel is propose-only.** Confirmed via Round 3 (GPT #6) — no silent auto-enable path remains. Does the user want a global `sentinelAutoEnable` override kept as a possibility, or removed entirely?
4. **Quiet-hours default.** Recommend 22:00–08:00 local. Adjust.

## Success criteria

- A beacon-enabled commitment at T with `cadenceMs = 10min` and no agent activity produces a Tier-1 heartbeat at T+10m ±25%.
- Agent posting a non-proxy message to the topic resets the next-heartbeat clock (verified by metadata skip).
- PresenceProxy active on the same topic suppresses promise heartbeats.
- Delivery with verified `deliveryMessageId` closes the commitment within one event-loop turn.
- Session restart transitions the commitment to `violated` with a user notice; no false-progress heartbeat fires.
- Daily LLM spend never exceeds `maxDailyLlmSpendCents` (hard cap, fail-open to templated).
- No regression in PresenceProxy or CommitmentTracker existing test suites.

## Rollback

- **Runtime disable:** `POST /promise-beacon/disable` (admin route). Stops timers, drains in-flight.
- **Boot disable:** `config.json → promiseBeacon.enabled = false`. AgentServer skips wire-up.
- **Full rollback:** revert PR. Hot state files under `.instar/state/promise-beacon/` orphaned but harmless. Schema additions to Commitment are optional fields; existing code ignores.
- **Never delete `commitments.json` as a rollback step** (A15 fix). If quarantine is needed, archive-rename to `.instar/state/commitments.archived-<ts>.json`.
