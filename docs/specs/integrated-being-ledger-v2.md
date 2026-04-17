---
title: "Integrated-Being Ledger v2"
slug: "integrated-being-ledger-v2"
author: "echo"
created: "2026-04-16"
supersedes: "docs/specs/integrated-being-ledger-v1.md (remains in force; v2 is additive)"
review-convergence: null
review-iterations: 0
review-completed-at: null
review-report: null
approved: false
approved-by: null
approved-at: null
---

# Integrated-Being Ledger v2

## Problem statement

v1 shipped the read side and a curated set of server-side emitters. That addressed the passive-observation case — a user-facing session reading what the rest of the agent has been doing. It did NOT address two related failure modes that manifested in concrete incidents within 24 hours of v1 landing:

### Failure mode 1 — unbacked commitments at point of utterance

An agent session emits a promise ("I'll relay Dawn's response when it comes in") and then the mechanism to back it — polling, a scheduled check, a job, anything — is never created. The commitment is words, not infrastructure. The failure is silent: nothing breaks visibly; the user eventually notices nothing happened.

This happened twice in the topic whose resolution this spec IS. Both times the promise was cheap to utter, and both times no durable mechanism was attached. v1 cannot catch this because v1 has no writable commitment primitive — a session cannot say "I am committing to X, here is my mechanism, here is my deadline." The ledger records lifecycle events that server-side subsystems witness, not session-initiated declarations.

### Failure mode 2 — shadow-self commitments

When a threadline handler session spawns to process an inbound agent-to-agent message, that subsession can reach substantive agreements on behalf of the agent as a whole. On 2026-04-16 a subsession agreed with Dawn on an eight-endpoint feedback integration contract. The user-facing session learned of this agreement only by accidental discovery. v1 records that the thread opened and closed; it does not record that an agreement was reached or what its terms were.

This is structurally the same gap as failure mode 1 — a session needs to write substantive state for other sessions to read — and its fix has the same shape: a sanctioned session-write endpoint with proper authentication, rate limiting, and provenance labeling.

### What v2 is NOT addressing

Third-party delivery awareness (did the outbound message actually reach the other agent?) remains a parallel track. It is probably a threadline-layer concern — ack-protocol, read-receipt analogue — not a ledger-layer concern. Called out explicitly in §"Explicit deferrals" below so it isn't conflated with v2 work.

## Proposed design

v2 is additive. v1 remains in force: v1 entries, v1 emitters, v1 read endpoints, v1 rotation, v1 rendering — unchanged. v2 adds:

1. A `commitment` entry kind with `mechanism`, `deadline`, `status` fields.
2. A session-write endpoint (`POST /shared-state/append`) with session authentication and strict schema.
3. A session identity registry (`LedgerSessionRegistry`) separate from the existing tmux `SessionManager`.
4. A user-facing resolution workflow (`POST /shared-state/resolve/<id>`) for marking commitments resolved/cancelled.
5. Dashboard surface additions: active commitments view, resolution controls.

### 1. Commitment entry kind

Adds to the v1 `kind` union: `"commitment"`. Entries of this kind MUST carry the following additional fields; other kinds MUST NOT.

```typescript
interface CommitmentFields {
  mechanism: {
    type: "scheduled-job" | "polling-sentinel" | "external-callback" | "passive-wait" | "user-driven";
    ref?: string;                        // Opaque reference resolvable by the mechanism type (job id, sentinel id, etc.)
    refResolvedAt: string;               // ISO timestamp. Ref correctness FROZEN at write; never re-resolved.
    refStatus: "valid" | "invalid" | "unverified";  // Result of the one-time resolution attempt.
  };
  deadline?: string;                     // ISO timestamp. Optional — not every commitment has one.
  status: "open" | "resolved" | "cancelled" | "expired" | "disputed";
  resolution?: {                         // Present only when status !== "open"
    at: string;
    by: "self-asserted" | "subsystem-verified" | "user-resolved";  // Tiered per §2.3
    note?: string;                       // Max 400 chars, Unicode-sanitized per v1
    evidenceRef?: string;                // Opaque pointer to where the outcome can be audited
  };
  disputeCount?: number;                 // Incremented when another session flags this commitment; hard cap 3.
}
```

**Why mechanism is required**: the core failure this spec exists to prevent is "promise with no backing." Making `mechanism` non-optional forces the writer to think about how the commitment will actually be fulfilled. `passive-wait` IS an allowed mechanism — but it is labeled as such and rendered with heightened skepticism. The label creates a reviewable surface for "why is this commitment's mechanism passive-wait?"

**Why refStatus is frozen at write**: late-binding attack surface. If `refStatus: "valid"` were re-resolved at read time, a later attacker could invalidate the ref (e.g., cancel the referenced job) and cause reads to silently downgrade. Freezing at write means rendering is deterministic and the commitment's claim is pinned to the moment of utterance. If the referenced job genuinely fails later, that produces a NEW entry (subsystem-emitted `note` with `supersedes` pointing at the commitment), not a mutation of the existing one.

**Why resolution tiers**: self-asserted resolutions are the easiest to fabricate. A session claiming "I completed the commitment" without evidence has no more force than the original commitment. v2 splits resolution into tiers so the reader can calibrate trust:
- `self-asserted`: the committing session (or any session) says "done." Renders with a warning.
- `subsystem-verified`: a server-side emitter observed the outcome (e.g., the scheduled job completed and reported success). Higher trust.
- `user-resolved`: Justin (or an authenticated user) pressed the resolve button on the dashboard. Highest trust.

### 2. Session-write endpoint

`POST /shared-state/append` — bearer-token gated (reuses the existing instar auth token).

**Authentication and session binding**:

1. The handler extracts the caller's session identity via a new `X-Instar-Session-Id` header. The session id MUST be registered in the `LedgerSessionRegistry` (§3 below).
2. If the header is missing or the session id is unregistered, return 401. Missing-header is NOT inferred from process context — explicit binding only. This closes the "forged caller identity" attack surface the v1 adversarial reviewer will almost certainly flag.
3. On accept, `emittedBy.subsystem = "session"`, `emittedBy.instance = <session-id>`. These fields remain server-bound; the client cannot supply them.

**Request schema**:

```typescript
interface SessionAppendRequest {
  kind: "commitment" | "agreement" | "decision" | "note";  // subset — session cannot forge lifecycle events
  subject: string;                       // Max 200 chars, Unicode-sanitized at receive
  summary?: string;                      // Max 400 chars, Unicode-sanitized at receive
  counterparty: {
    type: "user" | "agent" | "self" | "system";
    name: string;                        // Max 64 chars, charset-restricted per v1
    trustTier?: "trusted" | "untrusted"; // Optional HINT. Server re-resolves and may override.
  };
  commitment?: CommitmentFields;         // REQUIRED when kind === "commitment", FORBIDDEN otherwise
  supersedes?: string;                   // Optional id of earlier entry being resolved/withdrawn
  dedupKey: string;                      // Required. Sessions responsible for making it stable-per-intent.
}
```

**Authoritative server rebinds**:

- `provenance` is ALWAYS set to `"session-asserted"` by the server. Client cannot supply.
- `counterparty.trustTier` is server-re-resolved from threadline autonomy level per v1's trust-tier mapping. Client hint is ignored if it conflicts. Lookup failure → `untrusted` (default-deny).
- `source` field is NOT allowed on session-asserted entries. It's reserved for subsystem-inferred (classifier) entries.

**Rate limits** (layered, all enforced):

1. Global: existing per-IP bearer-token rate limit shared with other instar HTTP endpoints.
2. Per-session: `config.integratedBeing.sessionWriteRatePerMinute` (default 30). Returns 429.
3. Per-commitment-cap: a single session may have at most `config.integratedBeing.openCommitmentsPerSession` (default 20) entries with `kind="commitment"` AND `status="open"`. New commitment attempts beyond the cap return 429 with an `X-Cap-Reason: open-commitments` header. Coalesces with the attention queue per §"Dispute bombing defense."

**Near-duplicate rejection**:

A cross-session hash index of recent subject+summary pairs (rolling 24h window). On append, hash the normalized `subject + "\0" + (summary ?? "")` and check against the index. Hits are rejected with 409 and a `X-Dedup-Hit: <prior-id>` header. This prevents two sessions from independently logging near-identical commitments that, in aggregate, would appear to the reader as "the agent committed to this three times" — i.e., false consensus.

Near-duplicate threshold is Hamming-distance-free: exact match on normalized hash. Semantic-similarity dedup remains a v1 deferral; explicit not-in-scope for v2 either.

**Aggregation signal**: if the near-duplicate index sees >10 rejected hits within 24h for the same hash, emit a server-side `note` entry with subject "suspicious repetition detected" and the counts. Reader of the ledger then sees both: the original commitment AND a server-side warning that it is being repeated suspiciously. Prevents the "legitimization through aggregation" failure mode.

### 3. LedgerSessionRegistry

A new class at `src/core/LedgerSessionRegistry.ts`. Distinct from the existing tmux `SessionManager` — different lifecycle, different trust model.

**Responsibilities**:

1. Register a session on first write attempt: `register(sessionId, bindingToken, metadata)`.
2. Authenticate subsequent writes against the registered binding token.
3. Rotate binding tokens on session restart (detected via hook propagation).
4. Expose a list of active sessions for the dashboard.

**Registration**:

- Session ids are opaque (UUIDv4 generated at session start).
- Binding tokens are server-generated on first `register` call, returned once, and stored by the session in `.instar/session-binding/<session-id>.token` (file mode 0o600).
- The registry persists to `.instar/ledger-sessions.json` with file mode 0o600.
- On server restart, the registry is reloaded. A session's binding token survives server restart.

**Token handoff from session to server**:

The current session-start hook already writes session metadata to a known location. v2 adds a binding-token write to the same flow:

1. Session-start hook invokes a new endpoint `POST /shared-state/session-bind` with `X-Instar-Session-Id: <uuid>`.
2. Server returns binding token.
3. Hook writes token to `.instar/session-binding/<session-id>.token`.
4. Subsequent session writes include the token in the `X-Instar-Session-Token` header.

**Hook-env-propagation gap**: Claude Code hooks sometimes do not propagate env changes to the running session. The v2 design uses a FILE-based token handoff specifically to avoid this — the file is written by the hook, the session reads it from disk. A marker file at `.instar/session-binding/<session-id>.ready` is touched by the hook AFTER the token file is written, so the session can poll-loop for readiness without race. Max wait 5 seconds, then log and fail-open (degrade to read-only for this session).

**No weaker fallback**: there is NO path that allows a session to write without a registered binding token. If the file handoff fails, the session loses write access for its lifetime. This is intentional; session-write is an elevated capability and silent degradation would undermine the entire authentication story.

**Cleanup**: sessions are purged from the registry 7 days after last write activity. The binding-token files are deleted on purge. Bounded cleanup work per run (max 50 purges), runs on server-start and daily.

### 4. Resolution workflow

`POST /shared-state/resolve/<id>` — bearer-token gated. Marks a commitment resolved/cancelled/disputed.

**Resolution types and authorization**:

| Resolution | Who can call | Tier written |
|------------|--------------|--------------|
| self-assert | The registered session that originally created the commitment | `self-asserted` |
| subsystem-verify | A whitelisted server-side emitter (e.g., scheduled-job outcome emitter) | `subsystem-verified` |
| user-resolve | The dashboard, behind `X-Instar-Request: 1` header (existing user-auth pattern) | `user-resolved` |
| dispute | Any registered session OR the dashboard | Produces a new entry, does NOT mutate the commitment. See below. |

Resolutions write a NEW entry that `supersedes` the commitment AND updates the commitment's `status` field via supersession chain walk at render time. The original commitment entry is immutable; its effective status is computed by walking the supersession chain (cycle-guarded, depth cap 16, per v1).

**Dispute handling**:

A dispute is a new entry with kind `note`, `supersedes` the commitment, subject `"disputed: <brief reason>"`. On write, the commitment's `disputeCount` is incremented (in-memory only; NOT mutating the original entry). After 3 disputes within 24h:

- Commitment's effective `status` is rendered as `disputed`.
- An attention-queue item is produced (coalesced: at most one per commitment per 24h; multiple disputes within the window do NOT produce multiple attention-queue items — prevents "dispute bombing" where an attacker floods attention-queue via synthetic disputes).
- The render surface shows all dispute reasons.

### 5. Dashboard surface additions

Additions to the existing `Integrated Being` tab (from v1, at `dashboard/index.html` line 2409 region):

1. **Active commitments table**. Columns: subject, counterparty, mechanism type, deadline, status, age. Sort by deadline ascending. Filter by counterparty type.
2. **Resolution controls**. Per-row: "mark resolved" / "cancel" / "dispute" buttons. Button click POSTs to `/shared-state/resolve/<id>` with `X-Instar-Request: 1`.
3. **Overdue highlighting**. Commitments with `deadline` in the past and `status: "open"` render red.
4. **Mechanism badges**. `passive-wait` renders with a warning icon; `subsystem-verified` resolutions render with a check icon; `self-asserted` resolutions render with a warning.
5. **Session-identity column** (audit-only, behind an "advanced" toggle): which registered session created the entry. Default hidden to avoid operator overload.

Estimated scope: ~200 LoC JS + ~100 LoC HTML added to the existing tab. No new page.

## Hot-path latency

Session-write is a hot path for any session that commits often. Target: p99 < 150ms from `POST /shared-state/append` to 200 OK.

Split into phases:

- **Phase A (sync, in-request)**: schema validate, session-auth check, near-duplicate hash check, append to in-memory sidecar buffer. Target: <20ms.
- **Phase B (sync-adjacent)**: coalesced flush of the sidecar to the JSONL file. Runs every 100ms or at 50 entries, whichever first. Append-lock shared with v1 emitters.
- **Phase C (async)**: aggregation-signal evaluation, dispute-count tracking, dashboard cache invalidation. Fire-and-forget.

Lock contention: session-write shares the v1 `proper-lockfile` on the ledger. Writes coalesce via Phase B. A single flush acquires the lock once for the whole buffered batch. Worst-case measured flush: <50ms.

## Interactions with existing subsystems

- **SharedStateLedger.ts (v1)**: v2 extends the entry type union; v1 entries remain valid. `renderForInjection()` updated to handle `commitment` kind with mechanism/status/resolution rendering. Existing v1 kinds render unchanged.
- **BackupManager**: `.instar/ledger-sessions.json` and `.instar/session-binding/*.token` added to default backup manifest (gated by `config.integratedBeing.enabled`).
- **Dashboard**: additions to existing tab (not a new tab).
- **Session-start hook**: one new server call (`POST /shared-state/session-bind`). Must be added to the authoritative inline template at `PostUpdateMigrator.getSessionStartHook()`. The `instar migrate sync-session-hook` CLI (from v1) is the migration path for divergent hooks.
- **Job scheduler**: new optional `onComplete` callback emits a `subsystem-verified` resolution entry when a scheduled-job-backed commitment's job terminates. This is how "mechanism: scheduled-job, ref: job-xyz" gets upgraded from `self-asserted` to `subsystem-verified`.
- **Attention queue**: new item kind `"commitment-dispute"`. Coalesced per §4.
- **Threadline**: no changes. Third-party delivery awareness remains a separate track.
- **MessageSentinel paraphrase cross-check (v1)**: now also scans for paraphrases of `subject` on `commitment` entries. Fires as a signal only (no blocking) per v1's signal-vs-authority posture.

All interactions are additive. v1 behavior is unchanged.

## Rollback plan

v2 write surface is gated by three independent switches, any of which disables it cleanly:

1. `config.integratedBeing.v2Enabled` (default **false** initially, flipped to true after observation period) — gates the `/shared-state/append`, `/shared-state/resolve`, and `/shared-state/session-bind` endpoints. When false, endpoints return 503 with `X-Disabled: v2`.
2. `config.integratedBeing.resolutionEnabled` — gates the resolution workflow independently of the append endpoint.
3. Revert commit: single-commit revert removes the endpoints, the LedgerSessionRegistry class, and the dashboard additions. v1 emitters and read path are untouched.

`.instar/ledger-sessions.json` and the binding-token files remain on disk after revert. `instar ledger cleanup` (from v1 scope) is extended to also clean these.

## Config knobs (additions to v1)

```
integratedBeing.v2Enabled                     (default false — observation period first)
integratedBeing.resolutionEnabled             (default false until v2Enabled, then true)
integratedBeing.sessionWriteRatePerMinute     (default 30)
integratedBeing.openCommitmentsPerSession     (default 20)
integratedBeing.disputeCountThreshold         (default 3)
integratedBeing.disputeWindowHours            (default 24)
integratedBeing.sessionBindingRetentionDays   (default 7)
```

## Explicit deferrals (to v3 or later)

1. **Third-party delivery awareness** — threadline-layer concern, separate spec.
2. **Cross-machine coherence** — unchanged from v1's deferral.
3. **Session-scoped reads** — unchanged from v1's deferral.
4. **Semantic-similarity dedup** — exact-hash only in v2.
5. **Cross-agent visibility** — unchanged from v1's deferral.
6. **Automated mechanism synthesis** — v2 requires the writer to declare a mechanism; it does NOT synthesize one automatically from the commitment text. A future version might propose "you said 'I'll check back at X' → here's a scheduled job that backs it, OK?" — out of scope for v2.
7. **Commitment detection at utterance** — the outbound tone-gate hook could in principle detect commitment-like phrasing and require the writer to attach a mechanism before send. Adjacent to v2 but lives in the tone-gate, not the ledger. Tracked separately.

## Success criteria

- v2 ships behind `v2Enabled=false` default. After a 7-day observation period with no anomalies on internal testing, default flips to true in a minor release.
- Existing v1 tests pass unchanged.
- New tests for v2: session-auth rejection paths, near-duplicate rejection, rate limits, resolution tiers, dispute coalescing, mechanism refStatus frozen-at-write behavior, hook-env-propagation fallback (marker file), supersession-chain rendering of commitment status.
- A shadow-self scenario end-to-end test: a subsession registers, writes a `commitment` with `mechanism.type="scheduled-job"`, the job later completes and emits a `subsystem-verified` resolution, the user-facing session reads the ledger and sees both the original commitment and its verified resolution.
- Dashboard displays active commitments with correct overdue highlighting.
- User-resolve path works end-to-end from the dashboard.
- `instar migrate sync-session-hook` correctly migrates divergent session-start hooks to include the v2 session-bind call.
- Rollback path verified: disable `v2Enabled`, confirm v1 behavior intact; revert commit, confirm v1 behavior intact.
- Cross-model review (GPT/Gemini/Grok) runs as part of convergence, not as an explicit deferral. Inclusion of cross-model is tracked in the spec's convergence report.
