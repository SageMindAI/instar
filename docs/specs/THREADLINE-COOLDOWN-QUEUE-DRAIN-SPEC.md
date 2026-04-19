---
title: "Threadline Cooldown & Queue Drain"
slug: "threadline-cooldown-queue-drain"
author: "echo"
status: "converged"
date: "2026-04-18"
revision: "v7 — post cross-model review; material findings integrated"
review-convergence: "2026-04-18T22:30:00Z"
review-iterations: 7
review-completed-at: "2026-04-18T22:30:00Z"
review-report: "docs/specs/reports/threadline-cooldown-queue-drain-convergence.md"
approved: true
approved-by: "Justin (Telegram topic 7344)"
approved-at: "2026-04-19T05:54:00Z"
---

# Threadline Cooldown & Queue Drain — Design Spec

**Status:** draft (in /spec-converge)
**Owner:** Echo
**Date:** 2026-04-18
**Related files (verified to exist):**
- `src/messaging/SpawnRequestManager.ts` (the queue + cooldown site)
- `src/messaging/DeliveryRetryManager.ts` (existing retry infra; new `DeliveryPhase` entry needed — see §4.3)
- `src/threadline/ThreadlineRouter.ts` (inbound + `senderFingerprint` on `RelayMessageContext` at line 61)
- `src/threadline/client/ThreadlineClient.ts` (client affinity site)
- `src/commands/server.ts` (instantiation around line 5211; existing PATCH pattern at `/api/files/config` for the config endpoint)
- `src/core/types.ts` (`ThreadlineConfig` is a plain TS interface — no Zod schema; forward-compat for unknown keys is automatic)
- `src/config/ConfigDefaults.ts` (defaults registry consumed by `PostUpdateMigrator`)
- `src/monitoring/StallTriageNurse.ts`, `src/monitoring/HeartbeatManager.ts`, `src/monitoring/LifelineProbe.ts` (must filter on `triggeredBy`)

---

## 1. Problem

Same as v2. Three defects observed via echo↔sagemind on 2026-04-17:

- **D1** — `SpawnRequestManager` queues denied messages (`queueMessage`, line 112) but only drains inside a subsequent approved spawn (`drainQueue` at line 146). No timer fires when the cooldown ends. Silent hold indefinitely if no further messages arrive.
- **D2** — `cooldownMs` is declared on `SpawnRequestManagerConfig` (line 45) and respected at runtime (line 106) but never passed in at the instantiation site (`src/commands/server.ts:5211-5233`). Operators cannot tune it without a code change.
- **D3** — Client mints a fresh `thread-${Date.now()}-${random}` on each `send` when no threadId supplied (`ThreadlineClient.ts:165, 188`). Router's `tryInjectIntoLiveSession` path looks up by threadId via `threadResumeMap.get()`; mismatched threadId misses, falls through to spawn, trips cooldown. Live-session folding is unreachable for bursting callers.

## 2. Goals & Non-goals

**Goals**
1. Eliminate "queue held hostage" (D1).
2. End-to-end configurability with emergency kill switch (D2).
3. Restore same-peer session affinity without introducing spoofing or cross-conversation leakage (D3).
4. No regression in: concurrent-spawn guard, memory-pressure gate, max-session cap, autonomy-gate decisions.

**Non-goals**
- Gate redesign.
- Cross-agent fairness beyond the admission caps specified in §4.3.
- Trust-level-scaled cooldowns (deferred).
- Scoped auth tokens (would be a cross-cutting auth redesign — see §4.4).
- Dashboard UI work beyond the API extension (see §4.5).

## 3. Threat Model

- Peer forges `message.from.agent`. Mitigation: affinity keyed on `senderFingerprint`, authenticated path only.
- Peer times messages to exploit TTLs, drain windows, gate context shifts. Mitigations: absolute+sliding TTL, gate-decision freeze at enqueue, downgrade-only re-eval.
- Peer floods to exhaust memory, timers, sessions. Mitigations: three-level admission caps; plaintext path has its own smaller budget (new in v3).
- Peer queue-poisons via drop-oldest. Mitigation: backpressure (refuse new), not eviction.
- Peer induces repeated spawn failures to storm cooldown rollbacks. Mitigation: rollback keeps cooldown; penalty cooldown after N consecutive failures (new in v3).
- Peer forges truncation marker in message body. Mitigation: marker is structurally separated, peer content fenced (new in v3).
- Compromised auth token used to weaponize config. Mitigation: server-side clamps + rate-limit + audit (scoped tokens out of scope).

**Out of scope:** relay-layer compromise, kernel-level timer manipulation.

---

## 4. Proposed Design

### 4.1 Authenticated session affinity (D3 fix)

**Prerequisite confirmed:** `RelayMessageContext.senderFingerprint: string` exists at `ThreadlineRouter.ts:61` and is populated (line 613). However the type is a bare string; presence ≠ verified. This spec introduces a branded discriminated union to distinguish verified paths:

```ts
type RelayTrustLevel =
  | { kind: 'verified'; senderFingerprint: string }     // E2E-auth path
  | { kind: 'plaintext-tofu'; senderFingerprint: string } // plaintext, not hijack-safe
  | { kind: 'unauthenticated' };                          // legacy/failed verification

interface RelayMessageContext {
  trust: RelayTrustLevel;
  // ... existing fields
}
```

Only `trust.kind === 'verified'` paths populate and read the receiver affinity map. Plaintext path mints fresh (current behavior); unauthenticated path is rejected earlier in the pipeline (no change).

**Client side (`ThreadlineClient`):**
`lastThreadByPeer: Map<recipientFingerprint, { threadId, firstUsedAt, lastUsedAt }>`. On `send`:
1. Explicit `threadId` wins.
2. Else lookup by recipient fingerprint; reuse iff `now - firstUsedAt < ABSOLUTE_TTL_MS` AND `now - lastUsedAt < SLIDING_TTL_MS`.
3. Else mint.

Map bounded: LRU cap `CLIENT_AFFINITY_MAX = 1000` (evicts under cap pressure); periodic sweep every 5 min removes entries past absolute TTL. LRU dominates under pressure; sweep reclaims in steady state.

**Eviction policy applies to all per-agent maps (v5, per R4 scalability):** `lastSpawnByAgent`, `penaltyUntil`, `consecutiveSpawnFailures`, `infraFailureWindow`, and `gateEpoch` (v6, per R5 scalability) all share an LRU cap of `SPAWN_STATE_MAX = 10_000` fingerprints plus a 1-hour periodic sweep removing entries where all associated state is at defaults. For `gateEpoch`, all three dimensions for one fingerprint evict together (tuple-grouped eviction) — missing entries on mismatch-check safely default to 0 which forces re-eval on any stamped entry, so aggressive eviction is safe.

**Receiver side (`ThreadlineRouter`):**
`recentThreadByPeer: Map<verifiedSenderFingerprint, { threadId, firstUsedAt, lastUsedAt }>`. Consulted in `handleInboundMessage` before minting a new threadId — but only when `context.trust.kind === 'verified'`.

**TTLs (defaults, configurable):**
- `SLIDING_TTL_MS = 600_000` (10 min)
- `ABSOLUTE_TTL_MS = 7_200_000` (2 h)

**Authority precedence (strict):**
explicit caller threadId > client affinity > receiver affinity > resume map > mint.

**Thread-closed collision:** receiver rejects inbound threadId matching a `thread-closed` entry with `error: 'thread closed'` and does NOT auto-mint. Rate-limited by path:
- **Verified path:** max 10 close-events per fingerprint per 60 s are honored; 11th coalesced silently.
- **Plaintext path:** thread-close requests are **rejected entirely** (require verified trust). Closes identity-rotation bypass on plaintext path.

**Machine-locality invariant:** both affinity maps are process-local, never persisted to `.instar/` (which is synced). Enforced by: (a) maps declared as instance fields with no persistence path, (b) a test that runs a send burst then asserts no new files under `.instar/threadline/affinity/` or similar.

### 4.2 Coalesced drain loop (D1 fix)

**One shared `setInterval`.** Replaces per-agent `setTimeout`.

- `DRAIN_TICK_MS = max(min(cooldownMs / 4, 5000), 1000)` — floor at 1 s so an operator setting `cooldownMs = 1000` does not produce a 250 ms hot loop.
- Tick body short-circuits with O(1) early return when `pendingMessages.size === 0`.
- Each tick collects agents with `readyAt <= now + TICK_GRACE_MS` where `TICK_GRACE_MS = DRAIN_TICK_MS`.
- **Fair scheduling (v7, per GPT cross-review — prior `max(drainAttempts, ageMs)` mixed incomparable scales and was dominated by age):** use **Deficit Round Robin (DRR)** across ready agents. Each ready agent has a deficit counter; per tick each agent's deficit is incremented by a fixed quantum, and agents are drained in order while they have deficit ≥ cost. Drain-attempts above 1 bump the quantum by 50 % for that agent (age boost) so starved entries catch up without swamping the schedule. Replaces the broken weighted-shuffle.
- `MAX_DRAINS_PER_TICK` default 8, configurable via `threadline.maxDrainsPerTick`. Optional auto-scale to `min(32, ceil(ready / 4))` when tick body is idle in previous ticks.
- Drain callbacks run **concurrently** within a tick via **`Promise.allSettled`** (not `Promise.all`) so one callback failure does not abort the whole batch (v7, per Gemini cross-review). Bounded by max-drains-per-tick. Failures are logged to DegradationReporter; queue state for the failing agent is preserved (drainAttempts increment applies). MessageStore fetches within a tick are memoized by envelopeRef to avoid redundant I/O.
- Any callback error caught at interval-body scope, logged to DegradationReporter, does not stop the interval.
- `clearInterval` on `SpawnRequestManager.dispose()`. Tests assert timer map size is 0 post-teardown.

**Cooldown reservation — failure-suppressive with classified attribution (v4 revision):**

On cooldown-check pass: `lastSpawnByAgent.set(agent, now)` BEFORE async spawn. On spawn **failure**, do NOT roll back.

Penalty state is stored in a **separate field** (not overloaded into `lastSpawnByAgent`):
- `penaltyUntil: Map<agent, number>` — a future timestamp before which the agent is forbidden from spawning regardless of cooldown.
- `consecutiveSpawnFailures: Map<agent, number>` — resets only on spawn success.

All cooldown/status reads go through a helper `cooldownRemainingMs(agent)` which returns `max(cooldownMs - (now - lastSpawn), penaltyUntil[agent] - now, 0)`. No consumer computes `now - lastSpawn` directly — closes the "negative elapsed" alias bug (R3 scalability).

**Structural enforcement (v5, per R4 security; widened v6 per R5):** `lastSpawnByAgent`, `penaltyUntil`, `consecutiveSpawnFailures`, `infraFailureWindow`, and `gateEpoch` are `#private` ECMAScript class fields on `SpawnRequestManager` (tsconfig target is ES2022 — verified). Only narrow public helpers (`cooldownRemainingMs`, `getStatus`, etc.) expose state. A CI check runs a TypeScript-AST-based lint rule rather than a text grep — it asserts no subtraction expression outside `SpawnRequestManager.ts` has either operand reading one of the private field names (pattern matching via AST, not text, so aliases, destructuring, and renamed accessors all fail the check). CI precedent for code-pattern assertions exists at `.github/workflows/publish.yml:50`.

**Failure classification (closes penalty-as-griefing attack):** spawn failures are tagged by cause and only **agent-attributable** causes increment `consecutiveSpawnFailures`:

- **Agent-attributable (counts toward penalty):** envelope validation failure, admission cap hit, autonomy gate downgrade-to-block, malformed tool/config in payload, authorization mismatch.
- **Infrastructure (does NOT count toward penalty):** memory-pressure denial, session-cap denial, provider 5xx, disk I/O error, spawn process crash due to resource exhaustion, autonomy gate LLM timeout.
- **Ambiguous / unknown:** fail-open — do NOT count toward penalty, but DO emit a DegradationReporter breadcrumb (`spawn-failure-ambiguous`) for pattern detection.

**Classifier trust boundary (v5, per R4 security):** the classifier lives in `SpawnRequestManager` and consumes a discriminated `SpawnFailureCause` enum emitted by the caller (spawn session wrapper). Callers MUST explicitly tag errors; untagged errors default to `ambiguous`. Gate LLM 5xx is `infrastructure`. Gate LLM returning explicit `block` with reason `safety-refusal-on-payload` is `agent-attributable`.

**Rollout strategy (v7, tightened per GPT cross-review — "regex brittleness" concern):** the current `spawnSession: (prompt, options) => Promise<string>` contract throws generic Error from 6+ injection sites. **Staged rollout:**

1. **Phase 1 (ship with this spec):** `SpawnRequestManager` classifies only **locally-generated typed errors** as `agent-attributable`. Specifically: errors thrown from `validateEnvelope()`, the admission caps (both classes the manager itself emits), and autonomy-gate decisions returned as `{ decision: 'block', reason: 'safety-refusal-on-payload' }`. **All other errors — including anything bubbling up from `err.message` of downstream libraries — are `ambiguous`.** No regex matching on third-party error strings (closes GPT finding that regex-on-err.message is brittle across library upgrades).
2. **Phase 2 (follow-up spec, tracked as separate sub-PR):** change `spawnSession` return type to `Promise<{ sessionId: string } | { failed: SpawnFailureCause }>`, migrate all 6 call sites, extend attribution to downstream typed errors.

Phase 1 is safe because ambiguous failures don't penalize. It only undercounts attribution (some real agent-attributable failures wash into `ambiguous`), which is the conservative direction. A peer cannot exploit this because `ambiguous` still emits DegradationReporter breadcrumbs for pattern detection and still counts toward the infra-failure soft limiter.

**Infra-failure soft limiter (v5, per R4 adversarial):** in addition to the penalty counter, track `infraFailureWindow: Map<agent, CircularBuffer<timestamp>>` over the last 10 min. If a peer exceeds 5 infra failures in 10 min, their admission is **degraded** to `maxQueuedPerAgent = 1` (configurable via `degradedMaxQueuedPerAgent`) for the next 30 min — no blame attribution, no penalty, but a soft backpressure on peers that reliably trigger infra paths. Emits a distinct `spawn-infra-degraded` breadcrumb. Separates signal from penalty per R4 guidance.

If `consecutiveSpawnFailures[agent] >= 3`, set `penaltyUntil.set(agent, now + 2 * cooldownMs)`. On success, clear both entries.

Key is `request.requester.agent` — the peer sending the bad messages — so penalty silences the attacker, not the receiver's legitimate peers. Unit tests: provider timeout (infrastructure) does not trigger penalty; malformed envelope (agent-attributable) does; peer that triggers 6 provider timeouts in 10 min lands in degraded admission without penalty.

### 4.3 Queue shape, gate policy, admission (core D1 safety mechanics)

Queue entry:
```ts
{
  envelopeRef: string,       // id into messageStore
  envelopeHash: string,      // SHA-256 over canonical JSON of envelope (see below)
  threadId?: string,
  receivedAt: number,
  drainAttempts: number,
  gateDecisionAt: number,
  gateDecision: 'deliver' | 'notify-and-deliver',
  gateEpochs: {              // v5: declared explicitly per R4 scalability
    trust: number,
    gateConfig: number,
    globalReload: number,
  },
}
```

**Gate re-evaluation policy (freeze-and-downgrade with mutation-event invalidation):**
- If `now - gateDecisionAt < GATE_STALE_MS` AND no trust/policy mutation has occurred since `gateDecisionAt` → **skip re-eval**, use frozen decision.
- Else → re-evaluate. If stricter → discard. If looser → **ignore** the upgrade; frozen decision holds.
- `GATE_STALE_MS` is a fixed 60 s. Configurable.
- **Mutation events that invalidate frozen decisions** (closes batching-across-tightening attack): trust level change for the sender peer, trust table reload, autonomy gate config reload, operator-initiated `threadline:gate:invalidate` command.
- **Epoch scoping (v5, per R4 adversarial):** instead of ONE global counter, use a per-(senderFingerprint, policyDimension) epoch stored as `gateEpoch: Map<string, number>` keyed `${fingerprint}:${dimension}` where dimension ∈ {`trust`, `gateConfig`, `globalReload`}. Mutation to peer A's trust only bumps A's `trust` epoch — other peers' frozen entries are untouched. Entries stamp `(trustEpoch, gateConfigEpoch, globalReloadEpoch)` at enqueue (three numbers); any mismatch on drain forces re-eval for THAT entry only. Closes the reload-storm weaponization.
- **Epoch persistence / restart (v5, per R4 security):** all epochs are process-local (in-memory). On startup, **every queue entry redelivered from messageStore `undelivered` state forces re-eval** (ignore stamped epochs). No epoch persistence, no (bootId, counter) tuple needed — simpler and avoids collision risk entirely.

**envelopeRef integrity:** at drain, fetch envelope from `messageStore`, recompute content-hash, compare to `envelopeHash`. Mismatch (missing or tampered) → discard + escalate.

**Hash algorithm + versioning (v7, per Gemini cross-review):** **SHA-256** over canonical JSON `{ body, from, to, threadId, messageId, createdAt }` with a stable key-ordering serializer. The stored `envelopeHash` is prefixed with `"sha256-v1:"` so future algorithm upgrades can be rolled out without invalidating queued entries (forward-compat, matches subresource-integrity pattern). Test: permuting input object keys yields the same hash.

**Payload byte-size cap (v7, per Gemini):** envelopes above `maxEnvelopeBytes` (default 256 KiB) are refused at enqueue with a distinct `envelope-too-large` breadcrumb. Prevents a peer from drinking drain-tick budget on bulk content and bounds hash-computation cost.

**Live-session injection:** gate is re-evaluated per-(peerFingerprint, threadId) **once per `GATE_STALE_MS` window**, not per message. Closes stacked-LLM-cost for bursts of follow-ups into one live session.

**Admission (three levels, local-fairness-first order per R3 adversarial):**
1. **Per-peer first:** `queue[agent].length < maxQueuedPerAgent` (default 20 verified, 3 plaintext). Local fairness enforced before global scarcity.
2. **Distinct-agents:** `distinctAgentsWithQueues < maxDistinctAgentsQueued` (default 32 verified, 4 plaintext — **separate plaintext budget** prevents plaintext identity rotation filling the cap).
3. **Global:** `totalQueuedAcrossAllAgents < maxQueuedTotal` (default 200).

**Plaintext + verified budget union cap (closes stacking attack, with oracle closure):** if a single fingerprint has been observed on BOTH plaintext-tofu and verified paths, the plaintext budget for that fingerprint is **zeroed** for the rest of the process lifetime. Verified identity supersedes plaintext.

**Uniform-error closure (v5, per R4 security+adversarial):** the zeroing must not be observable as a distinct error. All plaintext admission refusals — whether from per-peer cap, distinct-agents cap, global cap, or union-cap-zeroing — return the **same generic** `{ error: 'admission-refused' }` response with identical shape and status code.

**Constant-time padding (v7, per Gemini cross-review — smoothed step-function + telemetry):** plaintext admission is restructured so it never reaches the gate — all plaintext refusal paths are O(1) cap-checks. Padding floor = worst-case refusal path's p99 + 20 % buffer, pinned as `plaintextRefusalPadMs` (default 40 ms).

**Graceful degradation under flood (v7 — replaces the hard pad-drop step-function):** above `maxConcurrentPlaintextRefusals` (default 256) new refusals return **HTTP 429 with `Retry-After` header** instead of silently dropping the pad. The timing oracle is not re-opened under flood (429 latency is also O(1) and padded to the same floor); legitimate operators see explicit backpressure instead of subtle protection-loss.

**Telemetry (v7, per GPT cross-review):** `GET /threadline/spawn-status` exposes `plaintextRefusals: { padded, unpadded, rate_limited_429, concurrentHighWaterMark }`, refreshed on each tick. Breadcrumbs `plaintext-pad-concurrency-exceeded` and `plaintext-refusal-burst` fire at configurable thresholds.

Statistical timing oracles across thousands of samples remain possible and are documented as accepted residual risk (threat model: plaintext is already trust-on-first-use; inference leak weaponization value is low vs. flood cost to obtain).

Any failure: refuse enqueue, escalate via `onEscalate`. **No drop-oldest.** Closes queue-poisoning + cross-peer griefing.

**Truncation marker (double-escaped):** the "context truncated: N queued, M admitted" signal emits as a distinct section in the spawn prompt with a sigil-fenced block (`<<<system-truncation-marker>>> ... <<<end>>>`). Peer content is fenced in its own block, AND the renderer replaces any literal `<<<...>>>` substring in peer content with zero-width-joined escape sequences (`<‌<‌<…>‌>‌>`) — closes both "forge the marker" and "close the marker context" attacks. Fuzz test: peer content containing the literal sigil renders as body text.

**Restart contract:** `dispose()` or SIGTERM walks queue entries and calls `messageStore.markManyUndelivered(envelopeRefs[])` in **chunks of 50**, **yielding between chunks** via `await setImmediate()` so the event loop stays responsive during shutdown. Dispose bounded at 5 s wall-clock. If exhausted, remaining entries are abandoned; `DeliveryRetryManager`'s existing TTL sweep recovers them.

**`markManyUndelivered` statement shape (v6, per R5 scalability):** implemented as a single `UPDATE messages SET phase = 'undelivered' WHERE id IN (?, ?, …)` per chunk (50 params — well under SQLite's default `SQLITE_MAX_VARIABLE_NUMBER = 32766`, safe even on older 999-param builds). Transaction-wrapped per chunk. No row-level metadata writes that would balloon param count if future refactors touch it — documented inline in the migration sub-PR.

**Post-restart re-evaluation invariant:** on startup, any queue entries rehydrated from `undelivered` state MUST be re-evaluated by the autonomy gate (epochs are process-local and reset to 0). No frozen decisions survive a restart. Closes epoch-collision risk (R4 security).

**Cold-start concurrency cap (v6, per R5 scalability+adversarial):** rehydrated entries are NOT re-evaluated eagerly in parallel. They are fed through the normal drain-loop pipeline at `MAX_DRAINS_PER_TICK` cadence. Admission caps are applied DURING rehydration — entries that would exceed `maxQueuedTotal` or their per-peer cap are **refused at rehydration** (messageStore left as `undelivered`, DeliveryRetryManager's TTL sweep eventually ages them out). Closes cold-start flood attack.

### 4.4 Config plumbing, PATCH, kill switch (D2 fix, codebase-grounded)

**Schema additions to `ThreadlineConfig` (plain TS interface in `src/core/types.ts`):**

```ts
threadline?: {
  spawnCooldownMs?: number;           // default 300_000; clamp [1000, 3_600_000]
  maxQueuedPerAgent?: number;         // default 20; clamp [1, 100]
  maxQueuedPerPlaintext?: number;     // default 3; clamp [1, 20]
  maxQueuedTotal?: number;            // default 200; clamp [1, 2000]
  maxDistinctAgentsQueued?: number;   // default 32; clamp [1, 256]
  maxDistinctPlaintextAgents?: number;// default 4; clamp [1, 32]
  maxDrainsPerTick?: number;          // default 8; clamp [1, 64]
  affinitySlidingTtlMs?: number;      // default 600_000
  affinityAbsoluteTtlMs?: number;     // default 7_200_000
  gateStaleMs?: number;               // default 60_000
  drainTimerEnabled?: boolean;        // default true — kill switch
}
```

Config is plain TS interfaces; unknown keys survive JSON.parse via structural typing. **No `.passthrough()` claim** (v2 error: Zod isn't used by the config loader). Rollback safety is automatic — removed keys in user config are ignored because the interface shape only consumes what it reads.

**Defaults registered in `src/config/ConfigDefaults.ts`** and auto-applied to existing agents via `PostUpdateMigrator`. Because `drainTimerEnabled` defaults to `true`, upgrading v0.29.0 → this-version silently enables the drain loop at first boot. Migration subsection below.

**Instantiation** at `src/commands/server.ts:5211` reads from loaded config and passes all fields to `new SpawnRequestManager(...)`.

**PATCH `/threadline/config` endpoint:**
- Auth: existing Bearer token.
- `X-Instar-Request: 1` header required — verified to exist at `src/server/fileRoutes.ts:623` on PATCH `/api/files/config`, returns 403 on missing. This spec adopts that guard.
- Server-side clamps enforced per-field; out-of-range requests return 400 with the violating field.
- Rate-limited: max 1 successful PATCH per 10 s per token. **This extends (is stricter than) the /api/files/config pattern, which has no rate-limit today.** Justified by higher sensitivity of runtime admission caps vs file-config paths.
- Every PATCH appended to the operations log with actor token hash + before/after diff. (/api/files/config has no audit log today; threadline PATCH adds one.)
- On successful PATCH: cancel existing drain-tick interval, reschedule with new cadence.

**`drainTimerEnabled: false`** — kill switch. Tick loop exits early. Queued entries sit (reverts to D1 behavior) until re-enabled or `DeliveryRetryManager` sweeps. Intended as incident-response escape hatch.

**Kill-switch safety wrapping (operator UX guard, NOT a security control per R4 security):** PATCH requests to set `drainTimerEnabled: false` return a pre-flight response summarizing impact (`{ queueDepth, distinctAgentsAffected, oldestEntryAgeMs, nonce }`) and require a second PATCH within **60 s** (widened from 30 s per R4 adversarial — accommodates operators on slow links) carrying both `confirm: true` AND the server-issued `nonce` from the dry-run. First PATCH is a dry-run; second without the nonce is rejected.

This is framed as an **operator-UX guard** against reflexive toggling in response to noisy alerts — it is NOT a defense against a compromised token (those get both calls trivially). The nonce defeats replay/prefetch attacks where an attacker issues both PATCHes in one TCP burst without seeing the dry-run response. Compromised-token defense relies on audit log + rate-limit per §4.4.

**Nonce specification (v7, per cross-review GPT + Gemini):**
- Generation: `crypto.randomBytes(32).toString('base64url')` (matches `SecretDrop.ts` pattern).
- Storage: `Map<nonceHash, { tokenHash, dryRunBodyHash, requestedPatchHash, issuedAt }>`. **LRU-bounded at `NONCE_MAP_MAX = 256` entries** — defends against dry-run-flood OOM (Gemini).
- **Triple binding:** confirm PATCH is rejected unless (a) nonce maps to same `tokenHash`, (b) current queue state hash matches `dryRunBodyHash`, AND (c) the confirm's canonical PATCH-body hash matches the dry-run's `requestedPatchHash` (v7 addition per GPT — previously an attacker with a captured nonce could confirm a *different* config than the dry-run showed).
- Single-use: removed on first successful confirm.
- Expiry: confirm-PATCH validates `(now - issuedAt) <= 60_000` at lookup time, independent of sweep cadence. A `setInterval` every 30 s reclaims memory but is NOT the source of truth for expiry.

**Per-peer quarantine sibling `threadline.drainTimerDisabledForPeers: string[]`** — list of fingerprints whose drain is suspended. Operator-set only; **NEVER auto-populated from penalty state** (explicit to prevent a peer from pushing themselves onto it through noise). Per-peer quarantine lets operators mute one abuser without halting everyone.

**PATCH array semantics (v5, per R4 integration):** the config loader's `deepMerge` replaces arrays as opaque leaves. A PATCH writing `drainTimerDisabledForPeers` replaces the ENTIRE list. No append/remove semantics. Operators must send the full desired list. Documented in the endpoint reference.

### 4.5 Observability, tagging, testability — scoped to what already exists

**Spawn source tagging:** drain-initiated spawns carry `triggeredBy: 'spawn-request-drain'`. `SessionManager` already accepts + stores `triggeredBy` (verified at `SessionManager.ts:584, 704`). Consumers that currently branch on `triggeredBy`:
- StallTriageNurse — add branch: treat drain-spawns like normal spawns but suppress "user-initiated stall" alerts for the first cooldown window.
- LifelineProbe — add branch: count toward session budget normally, no special case.
- HeartbeatManager — no change needed (heartbeat doesn't key on `triggeredBy`).

Each consumer change is a tracked sub-task with a test.

**New `GET /threadline/spawn-status` endpoint (greenfield — no prior endpoint existed; v3 wording "extend" was incorrect per R3 integration):**
```json
{
  "cooldowns": [...],
  "pendingRetries": N,
  "queuedMessages": [...],
  "queueDepth": { "perAgent": {...}, "total": N, "distinctAgents": N, "distinctPlaintext": N },
  "scheduledDrains": { "tickIntervalMs": N, "lastTickAt": "...", "drainedLastTick": N },
  "affinityHitRate": { "client": {...}, "receiver": {...}, "windowMs": 300_000 }
}
```

Response cached 1 s with in-flight-promise deduplication (single Promise shared across concurrent callers during cache-miss; closes thundering-herd on cold cache).

Dashboard integration: add a new spawn-status section to the dashboard rendered inline from `src/server/routes.ts` (dashboard is embedded in routes, not a separate `src/server/dashboard*` directory — v3 wording was also inaccurate here). Scope is ~one new route + one inlined HTML section, no plugin infra.

**DegradationReporter breadcrumbs:** queue overflow, admission-cap hit, affinity collision rejection, gate re-eval downgrade, drain attempts exhausted, PATCH applied, dispose-timeout, messageStore integrity mismatch, penalty-cooldown applied.

**CI / testability — use existing vitest fake-timer patterns, not Clock injection.** v2 proposed `clock: Clock` DI but the codebase has no such precedent and co-located timers (DeliveryRetryManager intervals, watchdog, TTL) still use wall clock — introducing DI for this one class creates a mixed-clock test surface. v3 uses `vi.useFakeTimers()` + `vi.advanceTimersByTime()` (current repo pattern).

**One real-clock integration test** remains as the `feedback_bug_fix_evidence_bar` witness: reproduces the echo↔sagemind 2026-04-17 failure end-to-end against two local instar servers. This test must fail on pre-fix code and pass on post-fix.

**Jitter:** within a tick, per-agent drain offset jitters in `[0, DRAIN_TICK_MS)` via `crypto.randomInt`. Thundering-herd mitigation only; not a security property.

---

## 5. Interactions & Side Effects

- `pendingSpawns` concurrency guard: unchanged, participates naturally.
- Autonomy gate: re-eval policy per §4.3 (frozen within GATE_STALE_MS; downgrade-only thereafter).
- Memory pressure: unchanged. Denied drains re-queue with incremented `drainAttempts`; entry drops + escalates at 3.
- Live-session injection: gate re-eval per-(peer, thread, window), not per-message.
- `onSessionEnd`: unchanged.
- Multi-machine: affinity maps machine-local by invariant. Each machine builds its own affinity; brief affinity loss window on failover (documented tradeoff, not a bug).
- Backup/restore: no new on-disk state.
- StallTriageNurse / LifelineProbe / HeartbeatManager: explicit `triggeredBy` branches (§4.5) covered by unit + integration tests.

## 6. Rollout & Rollback

**Rollout:** purely additive defaults; no rollout flag needed beyond `drainTimerEnabled: true` default.

**Migration note (addresses v2's gap):** shipping with `drainTimerEnabled: true` silently activates the drain loop at next boot for every agent on upgrade. Upgrade note in CHANGELOG and release notes:
- "This release adds an autonomous drain timer for Threadline spawn queue. It is enabled by default and runs every few seconds when the queue is non-empty. To stage the rollout on a specific agent, set `threadline.drainTimerEnabled: false` in `.instar/config.json` BEFORE upgrading, then flip to `true` when ready."

**Rollback:** revert the PR. Unknown config keys survive via structural typing. No on-disk state created. Emergency kill switch (`drainTimerEnabled: false` via PATCH) is faster than a revert.

## 7. Test Plan

Per `feedback_always_write_tests`, `feedback_verify_before_ship`, `feedback_bug_fix_evidence_bar`, `feedback_refactor_test_coverage`:

### Unit (vitest fake timers)
- Drain tick fires at cadence, short-circuits on empty queue, drains due agents concurrently with cap.
- Weighted shuffle surfaces starved entries first.
- Optimistic cooldown reservation: two concurrent evaluates, only one spawns.
- Failure-suppressive rollback: forced spawn failures do not reset cooldown; penalty cooldown after 3 failures; success resets counter.
- Affinity TTL: sliding, absolute, both required; LRU cap; periodic sweep.
- Admission: per-peer, distinct-agents, global; separate plaintext budgets.
- Queue overflow: refuses new, preserves existing, escalates.
- drainAttempts persists on entry, drops + escalates at max.
- Dispose clears interval AND batches markManyUndelivered within 5 s timeout; timeout falls back to DeliveryRetryManager sweep.
- Receiver affinity consulted only for `trust.kind === 'verified'`; plaintext mints.
- thread-closed rate limit: first 10 honored + logged, 11th coalesced silently.
- Gate freeze-and-downgrade: skip within GATE_STALE_MS; downgrade respected; upgrade ignored.
- envelopeRef integrity: content-hash mismatch discards + escalates.
- Truncation marker renderer: peer content in marker block renders as body text, not meta.

### Integration (real HTTP, two local instar servers)
- **Witness test (required per `feedback_bug_fix_evidence_bar`):** burst of 5 messages from peer A to peer B within cooldown. Pre-fix: fails. Post-fix: exactly one spawn, 5 messages delivered in order, no queue residue. Real clock.
- 100 peers × 10 messages: memory bounded, global cap kicks in, escalation fires.
- PATCH mid-burst lowering cooldownMs: drains accelerate; audit entry present.
- drainTimerEnabled=false: queue holds; re-enable drains cleanly.
- Server restart mid-burst: entries marked undelivered; DeliveryRetryManager redelivers.
- Plaintext-path flood: 32 fresh fingerprints cannot exhaust verified-peer budget.
- triggeredBy propagation: spawn-request-drain tags surface in StallTriageNurse + LifelineProbe logs.

### Load / chaos
- Timer-handle count returns to baseline after 1000-burst iterations.
- 10 000 unique fingerprints: LRU evicts, no OOM.
- Forced spawn failures: penalty cooldown prevents storm.

## 8. Open Questions (resolved in v3; none remain blocking)

All v2 questions answered by round 1–2 reviewers:
1. TTL model: both sliding + absolute, both required.
2. Overflow: backpressure, not drop-oldest.
3. Affinity persistence: in-memory only.
4. Cross-agent fairness: three-level admission + separate plaintext budget.
5. `GATE_STALE_MS`: fixed 60 s, decoupled from cooldownMs.
6. `senderFingerprint` presence confirmed; verification modeled via branded discriminated union on `RelayMessageContext.trust`.
7. thread-close DoS: concrete 10/peer/60 s rate limit; 11th coalesced silently.

### v3 open issue (for user decision, not a reviewer blocker)

**Q-plaintext-scope:** v3 assumes plaintext-path admission budgets (3 per-peer, 4 distinct) are small enough to prevent griefing but large enough to serve legitimate plaintext usage. Depends on actual plaintext traffic patterns — are there legitimate plaintext multi-peer burst flows today? If yes, tune defaults or exempt a trusted list.

## 9. Dependency & Sequencing

Dependencies surfaced by round 2 reviewers. One of these (DeliveryPhase) is genuinely prerequisite; the others are soft prereqs or reframed.

**Blocking prerequisites (must land before or alongside the main PRs):**

1. **`DeliveryPhase = 'undelivered'` + `messageStore.markManyUndelivered(ids[])` API** (chunks of 50). Additive change to `src/messaging/types.ts`, `DeliveryRetryManager.ts`, messageStore. Tracked as sub-PR.
2. **Branded `RelayMessageContext.trust` discriminated union.** Replaces bare `senderFingerprint: string`. Per R3 security, call sites are broader than v3 acknowledged — verified at: `src/commands/server.ts:5448–5553` (auto-ack gate, reply waiters, inbox write, envelope construction, relay context object), `ThreadlineRouter.ts:61/613`, `UnifiedTrustWiring.ts:56/206`, `MessageSecurity.ts:26`, `RelayGroundingPreamble.ts:22/48–50`. The auto-ack site at server.ts:5495–5497 MUST branch on `trust.kind === 'verified'` — otherwise a plaintext-tofu sender gets a free "message received" signal leak (fingerprint probing oracle). Migration strategy: introduce a transitional accessor `getSenderFingerprint(ctx)` so sites migrate incrementally without one mega-PR. Tracked as sub-PR.
3. **`triggeredBy: 'spawn-request-drain'` branches in StallTriageNurse + LifelineProbe.** `SessionManager` already accepts `triggeredBy` at lines 584, 704. Additive. Tracked as sub-PR.

**Main PR sequence (after prerequisites):**
4. §4.4 config plumbing + defaults + PATCH + kill switch. Gives operators escape hatch before anything else exists.
5. §4.1 client + receiver authenticated affinity. Restores fold-into-live-session — biggest user-visible improvement.
6. §4.3 queue shape (envelopeRef + envelopeHash + gate freeze + admission + truncation marker).
7. §4.2 coalesced drain loop + failure-suppressive reservation.
8. §4.5 observability extensions (concurrent with 5–7).

## 10. Message Lifecycle & Ownership (v7, per GPT cross-review — "queue persistence/rehydration ownership ambiguous")

Explicit state machine for every envelope passing through this system:

```
                          ┌──────────────┐
messageStore: queued ────▶│ evaluate()   │─── approved ──▶ spawn/inject ──▶ delivered
                          └──────────────┘                                        │
                                 │                                                 │
                              denied                                    (messageStore: delivered)
                                 │
                                 ▼
                          ┌──────────────┐
                          │ enqueue      │
                          │ (with        │
                          │  envelopeRef,│
                          │  hash,       │
                          │  epochs)     │
                          └──────────────┘
                                 │
                         ┌───────┴───────┐
                         │               │
                    drain tick       dispose()
                         │               │
                         ▼               ▼
                    re-evaluate     markManyUndelivered
                    (hash check)    (messageStore: undelivered)
                         │               │
                    ┌────┴────┐          │
                    │         │          ▼
                 approved  denied   DeliveryRetryManager sweep
                    │         │          │
                    ▼         ▼          ▼
                delivered  requeue    rehydrate at startup
                           (++attempts)   (through drain-loop pipeline)
```

**Ownership:**
- **messageStore** owns durable envelope storage + phase transitions (`queued` ↔ `undelivered` ↔ `delivered`).
- **SpawnRequestManager** owns the in-memory queue (`pendingMessages`), cooldown/penalty state, drain-tick scheduling, and calls `messageStore.markManyUndelivered` at dispose.
- **DeliveryRetryManager** owns TTL-based recovery of `undelivered` entries and existing retry logic.
- **ThreadlineRouter** owns the envelope-to-spawn/inject routing + affinity maps.

No state is owned by two components. Transitions that cross boundaries (e.g. `queued` → `undelivered`) are documented as a single call with clear caller/receiver.

**Affinity invalidation lifecycle (v7, per GPT):** affinity entries are invalidated on:
- TTL expiry (sliding + absolute)
- `thread-closed` ledger event
- Explicit override (caller passes different `threadId`)
- Session-end with clean termination → affinity entry preserved (normal flow)
- Session-end with abnormal termination / crash → affinity entry evicted for that threadId (so a follow-up does not try to inject into a dead session)
- Process dispose / SIGTERM → all affinity maps cleared (process-local invariant)

**Monotonic time (v7, per GPT + Gemini):** all duration arithmetic uses `performance.now()` or `process.hrtime.bigint()`, NOT `Date.now()`. Wall-clock `Date.now()` is used only for logging/display and for absolute `gateDecisionAt` timestamps stored in durable entries. This prevents cooldown arithmetic from breaking under NTP adjustments or clock skew between machines.

## 11. Operational Observability (v7, per GPT + Grok cross-review)

Beyond breadcrumbs, `GET /threadline/spawn-status` surfaces first-class metrics:

- Drain: `{ tickIntervalMs, lastTickAt, drainedLastTick, avgDrainLatencyMs_p50, _p99 }`
- Queue: `{ perAgent: {...}, total, distinctAgents, distinctPlaintext, oldestEntryAgeMs }`
- Affinity: `{ client: { hits, misses, evictions }, receiver: {...}, size }`
- Cooldown: `{ activeCooldowns, activePenalties, degradedAdmission: [...] }`
- Plaintext: `{ padded, unpadded, rate_limited_429, concurrentHighWaterMark }`
- Gate: `{ frozen, re_evaluated, downgraded, invalidated_by_epoch }`

**Perf baselines pinned via vitest perf suite (v7, per Grok):**
- p99 drain-tick latency under 100 ready agents: target < 200 ms
- Map lookup: target < 10 μs (O(1))
- Rehydration throughput from messageStore: target > 500 entries/s
- Plaintext refusal pad floor: 40 ms ± 5 ms

Baselines recorded at CI time; regression > 20 % fails the suite.

**Audit log retention (v7, per Grok):** PATCH ops log is LRU-capped at 10 k entries with a 24 h TTL sweep. Rollover emits a `degradation-audit-log-rollover` breadcrumb. Size exposed in spawn-status.

## 12. Side-effects Review (per `feedback_side_effects_review`)

Pre-populated here so convergence can check directly:

- **Over-block risk:** backpressure refuses new enqueues instead of silently dropping. Verified: admission is checked and escalated, never silent.
- **Under-block risk:** plaintext path does not consult affinity → cannot be hijacked via fingerprint spoofing. Verified in §4.1.
- **Level-of-abstraction fit:** `envelopeRef` + content-hash lives in SpawnRequestManager (right layer — it already owns the queue). Gate re-eval is a thin wrapper delegated to ThreadlineRouter (right layer — gate already lives there).
- **Signal-vs-authority compliance (per `feedback_signal_vs_authority`):** drain timer + weighted shuffle are SIGNALS of readiness. Autonomy gate + admission caps are AUTHORITIES. The timer never overrides a gate verdict or a cap.
- **Rollback cost:** additive defaults, structural-typing rollback safety, kill switch, no on-disk state. Revert is a single `git revert`.
- **Interactions considered:** SessionManager, StallTriageNurse, LifelineProbe, HeartbeatManager, DeliveryRetryManager, messageStore, ThreadlineCrypto/relay, existing PATCH endpoints (`/api/files/config`), DegradationReporter, PostUpdateMigrator.
