---
title: "Integrated-Being Ledger v2"
slug: "integrated-being-ledger-v2"
author: "echo"
created: "2026-04-16"
supersedes: "docs/specs/integrated-being-ledger-v1.md (remains in force; v2 is additive)"
review-convergence: null
review-iterations: 1
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
    refResolvedAt: string;               // ISO 8601 timestamp, server-set. Ref correctness FROZEN at write; never re-resolved.
    refStatus: "valid" | "invalid" | "unverified";  // Result of the one-time resolution attempt at write, set by server — never accepted from client.
  };
  deadline?: string;                     // ISO 8601 timestamp. Optional — not every commitment has one. Strict server validation per §"Deadline validation" below.
  status: "open" | "resolved" | "cancelled" | "expired" | "disputed";
  resolution?: {                         // Present only when status !== "open"
    at: string;
    by: "self-asserted" | "subsystem-verified" | "user-resolved";  // Tiered per §4
    note?: string;                       // Max 400 chars, Unicode-sanitized per v1
    evidenceRef?: string;                // Opaque pointer to where the outcome can be audited
  };
}
```

**Dispute count is NOT stored on the commitment entry.** Earlier drafts kept an in-memory `disputeCount` field; Grok and Scalability reviewers independently flagged that this resets on server restart, breaking the "3 disputes in 24h triggers escalation" contract. Dispute count is now derived at render time by walking the supersession chain and counting entries of kind `note` whose subject begins with `disputed:`. Source of truth is the ledger itself. Cost: bounded by chain-depth cap (16) and the v1 chain cache.

**Why mechanism is required**: the core failure this spec exists to prevent is "promise with no backing." Making `mechanism` non-optional forces the writer to think about how the commitment will actually be fulfilled. `passive-wait` IS an allowed mechanism — but it is labeled as such and rendered with heightened skepticism. Additionally, `passive-wait` commitments are capped separately (see §"Rate limits" below) to prevent the mechanism from becoming a path-of-least-resistance loophole (flagged by Gemini as a loophole; counter-measure: stricter cap).

**Mechanism ref validation (adversarial A1 resolution)**: on append, if `mechanism.ref` is present, the server MUST attempt to resolve it against the corresponding mechanism-type registry:
- `scheduled-job`: lookup in the job scheduler — must be a valid, non-expired, non-cancelled job.
- `polling-sentinel`: lookup in the sentinel registry.
- `external-callback`: verify the callback URL/handle is in the per-agent allowlist.
- `passive-wait`, `user-driven`: `ref` is ignored/optional.

Resolution timeout is 200ms. On success, `refStatus: "valid"`. On explicit failure, `refStatus: "invalid"` AND the commitment is still accepted but written with `status: "disputed"` immediately (so the falsified-backing claim is visible). On timeout or inability to verify, `refStatus: "unverified"` and the commitment renders with a warning icon. `refStatus` is ALWAYS server-bound — never accepted from the client.

**Why refStatus is frozen at write**: late-binding attack surface. If `refStatus: "valid"` were re-resolved at read time, a later attacker could invalidate the ref (e.g., cancel the referenced job) and cause reads to silently downgrade. Freezing at write means rendering is deterministic and the commitment's claim is pinned to the moment of utterance. If the referenced job genuinely fails later, that produces a NEW entry (subsystem-emitted `note` with `supersedes` pointing at the commitment), not a mutation of the existing one.

**Why resolution tiers**: self-asserted resolutions are the easiest to fabricate. A session claiming "I completed the commitment" without evidence has no more force than the original commitment. v2 splits resolution into tiers so the reader can calibrate trust:
- `self-asserted`: ONLY the registered session that originally created the commitment may self-assert resolution (tightened from an earlier draft; see §4 authorization matrix). Renders with a warning.
- `subsystem-verified`: a server-side emitter observed the outcome (e.g., the scheduled job completed and reported success). Higher trust.
- `user-resolved`: Justin (or an authenticated user) pressed the resolve button on the dashboard. Highest trust.

**Expired-status emitter (Grok resolution)**: a server-side daily sweep scans commitments with `status: "open"` and `deadline < now`. For each, it emits a `note` entry with `supersedes` pointing at the commitment and subject `expired: deadline passed without resolution`. This is `subsystem-asserted` provenance — the status transition to `expired` is a fact the server witnessed, not a session claim. Sweep runs hourly, bounded work (max 100 expirations per run), coalesced with the v1 rotation cron.

### 2. Session-write endpoint

`POST /shared-state/append` — bearer-token gated (reuses the existing instar auth token).

**Authentication and session binding**:

1. The handler extracts the caller's session identity via an `X-Instar-Session-Id` header AND session-write binding token via `X-Instar-Session-Token` header.
2. The session id MUST be registered in the `LedgerSessionRegistry` (§3 below) with a matching binding token.
3. If either header is missing, or the session id is unregistered, or the token does not match, return 401. Missing-header is NOT inferred from process context — explicit binding only.
4. On accept, `emittedBy.subsystem = "session"`, `emittedBy.instance = <session-id>`. These fields remain server-bound; the client cannot supply them.

**Token/session-id log masking (Security S1 resolution)**: Binding tokens and session ids MUST NOT appear in logs, debug output, error traces, or support-bundle dumps. Server-side request/response logging MUST mask `X-Instar-Session-Token` and `X-Instar-Session-Id` header values with `***REDACTED***` at the log formatter level (not at the call site — a structural redactor that cannot be bypassed by forgotten redaction calls). A unit test asserts that a synthetic token value does not appear in any log output across the full request cycle.

**Request schema**:

```typescript
interface SessionAppendRequest {
  kind: "commitment" | "agreement" | "decision" | "note";  // subset — session cannot forge lifecycle events
  subject: string;                       // Max 200 chars, Unicode-sanitized at receive per v1 rules (NFC + strip \p{C}\p{Cf})
  summary?: string;                      // Max 400 chars, Unicode-sanitized at receive
  counterparty: {
    type: "user" | "agent" | "self" | "system";
    name: string;                        // Max 64 chars, charset [a-zA-Z0-9-_.:] — v1 rules
    trustTier?: "trusted" | "untrusted"; // Optional HINT. Server re-resolves per v1 trust-tier mapping and OVERRIDES hint. Hint is purely informational.
  };
  commitment?: CommitmentFields;         // REQUIRED when kind === "commitment", FORBIDDEN otherwise
  supersedes?: string;                   // Optional id of earlier entry being resolved/withdrawn
  dedupKey: string;                      // REQUIRED. Max 200 chars. Charset [a-zA-Z0-9-_.:]. Server rejects 400 on invalid format.
}
```

**Field validation (Security S2/S3 resolution)**:
- `dedupKey`: max 200 chars, charset `[a-zA-Z0-9-_.:]`. Server rejects with 400 and `X-Invalid-Field: dedupKey` on violation.
- `deadline`: strict ISO 8601 parse. Rejection with 400 and `X-Invalid-Field: deadline` on invalid format. Additionally, deadline MUST be between `now + 60 seconds` and `now + 90 days` (sanity range). Adversarial A5: prevents "past-deadline narrative spoofing" where a commitment is written already-expired to appear as a failure.
- All Unicode-bearing fields normalized to NFC and sanitized (strip `\p{C}\p{Cf}`) per v1 rules before length check.

**Authoritative server rebinds (and trust-tier override visibility)**:

- `provenance` is ALWAYS set to `"session-asserted"` by the server. Client cannot supply.
- `counterparty.trustTier` is server-re-resolved from threadline autonomy level per v1's trust-tier mapping. If the client hint differs from the server's resolution, the server emits a `note` entry (subsystem-asserted, dedup'd at per-session-per-counterparty-per-24h) recording the discrepancy. This resolves Grok's "silent trust-tier override" finding — overrides are now visible in the ledger, not silent.
- Trust-tier resolution timeout is 500ms. On timeout, resolved as `untrusted` (default-deny) AND a degradation event `trust-tier-lookup-timeout` is emitted at WARN level (Security M3 resolution).
- `source` field is NOT allowed on session-asserted entries. It's reserved for subsystem-inferred (classifier) entries.

**Rate limits (layered, all enforced)**:

1. **Global bearer-token per-IP rate limit**: existing instar limit, shared with other endpoints. First line of defense against unauthenticated flood.
2. **Per-session**: `config.integratedBeing.sessionWriteRatePerMinute` (default 30). Returns 429.
3. **Per-agent global ledger-write ceiling** (Adversarial A7 resolution): `config.integratedBeing.maxWritesPerMinuteGlobal` (default 100). Summed across all registered sessions of this agent. On exceeding, 429 with `X-Cap-Reason: agent-global`. Closes the multi-session-flood loophole that per-session alone didn't cover.
4. **Per-session open-commitments cap**: `config.integratedBeing.openCommitmentsPerSession` (default 20). Attempts beyond cap return 429 with `X-Cap-Reason: open-commitments`.
5. **Per-session passive-wait cap** (Gemini loophole resolution): `config.integratedBeing.passiveWaitCommitmentsPerSession` (default 3). `passive-wait` mechanism is the weakest form of backing; capping it lower than general commitments prevents it from becoming the dumping ground for unbacked promises.

**Near-duplicate rejection with explicit normalization**:

A cross-session hash index of recent subject+summary pairs. **Normalization (Adversarial A2 resolution)** is explicit:
1. Unicode NFC-normalize `subject` and `summary`.
2. Lowercase.
3. Strip `\p{C}` (control chars) and `\p{Cf}` (format chars per v1 Unicode rules).
4. Concatenate `normalized-subject + "\0" + (normalized-summary ?? "")`.
5. SHA-256 hash, first 16 hex chars.

**Index eviction (Scalability Sc1 resolution)**: the index is a time-bucketed ring buffer. Hourly buckets; oldest bucket evicted on rotation to cap memory. Total index capped at 24 hours × (maxWritesPerMinuteGlobal × 60) = ~144K entries worst case at default config. Each entry is ~40 bytes (hash + timestamp + byte-count), max ~6MB — acceptable. At lower sustained rates, index is much smaller.

On append, hash per the above, check against the index. Hits are rejected with 409 and `X-Dedup-Hit: <prior-id>`.

**Aggregation signal (Adversarial A6 resolution)**: lowered threshold AND real-time emission for repeated same-session hits:
- >5 rejected hits in 24h for the same hash → emit a server-side `note` with subject "suspicious repetition detected" and counts. Coalesce to at most one such `note` per hash per 24h (Security M4 resolution — the signal itself cannot be used as an attention-queue flood vector).
- >2 rejected hits in one session on the same hash → emit `note` IMMEDIATELY (real-time, not aggregated). Same coalescing rule.

### 3. LedgerSessionRegistry

A new class at `src/core/LedgerSessionRegistry.ts`. Distinct from the existing tmux `SessionManager`. Registration is EAGER via the session-start hook (GPT caught the earlier lazy-vs-eager contradiction — resolved below by requiring eager registration).

**Responsibilities**:

1. Eagerly register a session on session-start via the hook (see "Token handoff" below).
2. Authenticate subsequent writes against the registered binding token.
3. Rotate binding tokens on session restart (detected via hook re-run on a new session id).
4. Enforce absolute TTL on tokens (Gemini resolution — no infinite refresh).
5. Expose a list of active sessions for the dashboard.

**Registration**:

- Session ids are opaque (UUIDv4 generated at session start).
- Binding tokens are server-generated on first `register` call, cryptographically random 32-byte hex, returned once, and stored by the session at `.instar/session-binding/<session-id>.token` (file mode 0o600).
- Registration is idempotent: if the same session id calls `register` twice (e.g., hook re-runs within a single session lifecycle), the server returns the SAME token. Metadata is NOT updated on duplicate registration. Security M1 resolution.
- The registry persists to `.instar/ledger-sessions.json` with file mode 0o600.
- On server restart, the registry is reloaded; binding tokens survive server restart.

**Token absolute TTL and rotation (Gemini + Grok resolution)**:
- Absolute TTL: `config.integratedBeing.tokenAbsoluteTtlHours` (default 72). A token is invalid past this age regardless of session activity. Prevents a leaked token from being refresh-revived indefinitely.
- Rolling TTL (activity refresh): `config.integratedBeing.tokenIdleTtlHours` (default 24). A session that hasn't written in 24h must re-register to get a new token. Absolute TTL still caps the total lifetime.
- Rotation: sessions MAY proactively re-register at any time; old token is invalidated on new token issue. The session-start hook re-runs on session restart, producing a new binding.
- Revocation: the dashboard exposes a "revoke binding" button per session; revocation immediately invalidates the token and writes a `note` entry (subsystem-asserted) recording the revocation.

**Token handoff from session to server (race-safe — Adversarial A3 + Gemini resolution)**:

The session-start hook writes the token with atomic rename and explicit mode verification:

1. Hook invokes `POST /shared-state/session-bind` with `X-Instar-Session-Id: <uuid>`.
2. Server returns binding token.
3. Hook writes the token to a temp file `<token-path>.tmp.<pid>` with `O_CREAT | O_WRONLY | O_EXCL` flags and mode 0o600 explicitly (not umask-dependent).
4. Hook fsyncs the temp file.
5. Hook atomically renames the temp file to the final path. The final file has mode 0o600 from step 3 — no world-readable window.
6. Hook writes a marker file `.instar/session-binding/<session-id>.ready` (also 0o600) AFTER the token file is in place.
7. Session polls for `.ready`; max wait 5s.
8. On read, the session verifies file mode is exactly 0o600. If not, fail-CLOSED (log CRITICAL, deny write capability for this session's lifetime). This tightens the earlier "fail-open" which was the wrong default (GPT flagged the wording; this is a security boundary).

**REST fallback for hook propagation failure (Gemini resolution)**: if the hook-propagation path fails (marker never appears, or token file has wrong mode), the session can fall back to an interactive re-bind path: `POST /shared-state/session-bind-interactive` which returns the token directly in the response body over the authenticated HTTP channel (bearer-token gated). This path is ONLY usable when the file-based path fails, gated by a runtime detection that the file-based handoff did not succeed. Prevents the "permanent read-only degradation" failure mode where a single failed handoff silently disables a session's write capability for its lifetime.

**No weaker fallback for auth itself**: there is NO path that allows a session to write without a registered, valid, non-expired binding token. The REST fallback still produces a token through the authenticated server channel — the fallback is only about HOW the token is delivered, not about WHETHER authentication happens.

**Cleanup (Scalability Sc4 resolution — two-tier retention)**:
- Active sessions (wrote within last 7 days): retained 7 days after last write.
- One-shot sessions (registered but never wrote): purged after 1 day.
- Binding-token files deleted on purge.
- Cleanup runs async in background, bounded 50 purges per run, hourly cadence.

### 4. Resolution workflow

`POST /shared-state/resolve/<id>` — bearer-token gated.

**Resolution types and authorization (Adversarial A4 resolution — self-assert restricted)**:

| Resolution | Who can call | Tier written |
|------------|--------------|--------------|
| self-assert | ONLY the registered session that originally created the commitment (session id matches `emittedBy.instance`) | `self-asserted` |
| subsystem-verify | A whitelisted server-side emitter (e.g., scheduled-job outcome emitter) | `subsystem-verified` |
| user-resolve | The dashboard, behind `X-Instar-Request: 1` header | `user-resolved` |
| dispute | Any registered session OR the dashboard | New `note` entry, does NOT mutate |

Sessions other than the creator may NOT self-assert resolution (Adversarial A4: closes "any session can hide any commitment via self-assert"). To contest a commitment written by another session, use `dispute` — which produces a visible note.

**Stranded commitments (GPT follow-up)**: if the creating session is expired/purged before self-asserting, the commitment remains `open` forever. To handle this: the daily expired-status sweep (§1) also targets commitments whose creating session has been purged for 7+ days — those get a `note` with subject `stranded: creating session no longer exists` and effective status rendered as `stranded` (new derived state, not in the enum — computed at render time only).

Resolutions write a NEW entry that `supersedes` the commitment AND updates the commitment's effective status via supersession chain walk at render time. The original commitment entry is immutable.

**Supersession chain caching (Scalability Sc3 resolution)**: chain walks are cached per-entry with TTL 60s and bust-on-write (new entry supersedes an entry → invalidate cache for that entry's chain). Bounded by v1's depth cap 16.

**Dispute handling**:

A dispute is a new entry with kind `note`, `supersedes` the commitment, subject `"disputed: <brief reason>"`. Render-time aggregation counts disputes (derived from ledger, not in-memory — Grok/Scalability Sc5 resolution). After ≥3 disputes within 24h (window measured at render time over the supersession chain):
- Commitment's effective `status` renders as `disputed`.
- Attention-queue item produced (coalesced per Security M4 — at most one per commitment per 24h).
- Render surface shows all dispute reasons.

### 5. Dashboard surface additions

Additions to the existing `Integrated Being` tab (from v1, at `dashboard/index.html` around the tab-bar region):

1. **Active commitments table**. Columns: subject, counterparty, mechanism type, deadline, status, age. Sort by deadline ascending. Filter by counterparty type.
2. **Resolution controls**. Per-row: "mark resolved" / "cancel" / "dispute" buttons. Button click POSTs to `/shared-state/resolve/<id>` with `X-Instar-Request: 1`.
3. **Overdue highlighting**. Commitments with `deadline` in the past and `status: "open"` render red.
4. **Mechanism badges**. `passive-wait` renders with a warning icon; `subsystem-verified` resolutions render with a check icon; `self-asserted` resolutions render with a warning icon; `invalid` refStatus renders with a critical-error icon.
5. **Session revocation controls**. Per-session row in a "Bindings" subtab: "revoke token" button.
6. **Session-identity column** (audit-only, behind an "advanced" toggle): which registered session created the entry.

Estimated scope: ~250 LoC JS + ~120 LoC HTML added to the existing tab. No new page.

## Hot-path latency

Session-write is a hot path. Target: p99 < 150ms from `POST /shared-state/append` to 200 OK.

Split into phases:

- **Phase A (sync, in-request)**: schema validate, session-auth check, near-duplicate hash check, mechanism-ref validation (≤200ms timeout built into the 150ms target — note below), append to in-memory sidecar buffer. Target: <80ms.
- **Phase B (sync-adjacent)**: coalesced flush of the sidecar to the JSONL file. Runs every 100ms or at 50 entries, whichever first. Append-lock shared with v1 emitters.
- **Phase C (async)**: aggregation-signal evaluation, dashboard cache invalidation. Fire-and-forget.

**Mechanism-ref validation timeout**: the 200ms timeout is NOT additive to the 150ms p99 — refs that are cheap to resolve (local scheduler/sentinel lookup) complete in <5ms. Only slow external-callback lookups approach the timeout, and those hit `refStatus: "unverified"` rather than blocking the write.

**Phase A backpressure (Gemini OOM resolution)**: in-memory sidecar buffer is hard-capped at `config.integratedBeing.sidecarBufferMax` (default 500 entries). On overflow, writes receive 429 with `X-Cap-Reason: sidecar-full` and retry-after hint. Prevents OOM under sustained write load exceeding flush rate.

**Durability note (GPT ack-before-durable-flush resolution)**: the 200 OK from `POST /shared-state/append` is returned after Phase A buffer-append, not after Phase B JSONL flush. The client sees ack before durable-write. For commitments specifically, this is an acceptable trade: the in-memory buffer survives anything short of a crash in the 100ms flush window. For crash-safety of commitments, the response includes `X-Durable-At-Or-Before: <ISO timestamp>` set to `now + flush-interval`, so callers know the window. A `?sync=1` query parameter forces Phase B flush before response for callers that need durable-before-ack; costs p99 up to ~200ms.

Lock contention: session-write shares the v1 `proper-lockfile` on the ledger. Writes coalesce via Phase B. A single flush acquires the lock once for the whole buffered batch. A load-test success criterion verifies p99 <150ms at sustained 100 writes/minute with 4 concurrent sessions (see §"Success criteria").

## Cross-machine scope

Each machine has its own ledger AND its own session registry. Commitments written on machine A cannot be resolved on machine B via the ledger — this is explicit v2 scope (Scalability Sc6 resolution). To prevent confusion:
1. Startup warning on paired agents (extension of v1's warning): `[integrated-being-v2] This agent runs on N machines. Session registries and commitments are per-machine. Cross-machine commitment coordination is not yet implemented.`
2. Dashboard header shows "commitments on this machine only" when paired.
3. Session registry and binding tokens excluded from git-sync via existing per-agent exclude-list (same mechanism as v1 shared-state.jsonl).

Cross-machine commitment visibility remains a v3 deferral.

## Interactions with existing subsystems

- **SharedStateLedger.ts (v1)**: v2 extends the entry type union; v1 entries remain valid. `renderForInjection()` updated to handle `commitment` kind with mechanism/status/resolution rendering. Existing v1 kinds render unchanged.
- **BackupManager**: `.instar/ledger-sessions.json` and `.instar/session-binding/*.token` added to default backup manifest (gated by `config.integratedBeing.enabled`). Glob inclusion per v1's pattern.
- **Dashboard**: additions to existing tab (not a new tab). Bindings subtab is the only structural addition.
- **Session-start hook**: one new server call (`POST /shared-state/session-bind`) with token-file atomic write. Authoritative inline template at `PostUpdateMigrator.getSessionStartHook()` updated. `instar migrate sync-session-hook` (from v1) extended with v2 migration steps. Divergent local hooks (e.g., Echo's) require explicit re-run of this CLI.
- **Job scheduler**: new `onComplete` callback hook. On job completion, if the job was referenced by an open commitment (`mechanism.ref` matches job id), emit a `subsystem-verified` resolution entry. If the spec's target scheduler doesn't yet have an `onComplete` extension point, that becomes a prerequisite implementation step — called out in §"Implementation prerequisites" below.
- **Attention queue**: new item kind `"commitment-dispute"` AND `"suspicious-repetition"` (from aggregation signal). Coalesced per §4 and §2 respectively.
- **Threadline**: no changes. Third-party delivery awareness remains a separate track.
- **MessageSentinel paraphrase cross-check (v1)**: extended to scan `subject` on `commitment` entries with exclusion rules matching v1 (different counterparty only, skip inferred-provenance). Fires as a signal only. No spec change to v1; this is an implementation-time addition to v1's existing corpus.

All interactions are additive. v1 behavior is unchanged.

## Implementation prerequisites (Integration I3/I10 resolution)

These exist as implementation tasks (not spec gaps — the spec assumes they'll be built as part of v2):

1. `LedgerSessionRegistry` class — new file at `src/core/LedgerSessionRegistry.ts`.
2. `/shared-state/session-bind` and `/shared-state/session-bind-interactive` endpoints — additions to the shared-state router.
3. `/shared-state/append` and `/shared-state/resolve/<id>` endpoints.
4. Job scheduler `onComplete` extension point — if not present, add it as a minimal hook that subscribers can register against. Scoped as "minimal addition"; if the existing scheduler doesn't expose completion events, a polling fallback on job status is acceptable (less ideal, noted as tech debt in v3).
5. `PostUpdateMigrator.getSessionStartHook()` template update to include the v2 session-bind call.
6. `instar migrate sync-session-hook` extension for v2 steps.
7. Atomic token-file write helper (reusable utility, not ledger-specific).
8. Supersession-chain cache module (reusable; used by v1 render path too).

## v1 backward compatibility (Integration I12 resolution)

v1 entries remain renderable. A v1 reader encountering a v2 commitment entry sees an entry with extra unknown fields. v1's render path has an explicit "unknown kind → show subject/summary with kind name as a label" fallback (already present). The extra fields (mechanism, deadline, etc.) are ignored by v1 rendering. This means: a v1-installed agent reading a v2-written ledger after a mixed upgrade gets degraded-but-safe rendering. Tested explicitly via the success criteria.

## Rollback plan

v2 write surface is gated by independent switches, any of which disables it cleanly:

1. `config.integratedBeing.v2Enabled` (default **false** initially, flipped to true after observation period) — gates the `/shared-state/append`, `/shared-state/resolve`, `/shared-state/session-bind`, and `/shared-state/session-bind-interactive` endpoints. When false, endpoints return 503 with `X-Disabled: v2`.
2. `config.integratedBeing.resolutionEnabled` — gates the resolution workflow independently.
3. Revert commit: single-commit revert removes the endpoints, the LedgerSessionRegistry class, and the dashboard additions. v1 emitters and read path are untouched.

**Cleanup on rollback**: `.instar/ledger-sessions.json`, `.instar/session-binding/*.token`, and `.instar/session-binding/*.ready` files remain on disk after revert. `instar ledger cleanup` (from v1 scope) is extended to clean these; users running the cleanup command after rollback recover the disk space. Sensitive token content is cleared on purge.

## Config knobs (additions to v1)

```
integratedBeing.v2Enabled                          (default false — observation period first)
integratedBeing.resolutionEnabled                  (default false until v2Enabled, then true)
integratedBeing.sessionWriteRatePerMinute          (default 30)
integratedBeing.maxWritesPerMinuteGlobal           (default 100)    # agent-global ceiling
integratedBeing.openCommitmentsPerSession          (default 20)
integratedBeing.passiveWaitCommitmentsPerSession   (default 3)
integratedBeing.sidecarBufferMax                   (default 500)
integratedBeing.disputeCountThreshold              (default 3)
integratedBeing.disputeWindowHours                 (default 24)
integratedBeing.sessionBindingRetentionDays        (default 7)
integratedBeing.tokenAbsoluteTtlHours              (default 72)
integratedBeing.tokenIdleTtlHours                  (default 24)
integratedBeing.mechanismRefValidateTimeoutMs      (default 200)
integratedBeing.trustTierLookupTimeoutMs           (default 500)
integratedBeing.aggregationSignalThreshold         (default 5)
integratedBeing.aggregationSignalImmediateThreshold (default 2)     # same-session immediate emit
```

## Explicit deferrals (to v3 or later)

1. **Third-party delivery awareness** — threadline-layer concern, separate spec.
2. **Cross-machine coherence** — unchanged from v1's deferral; v2 adds explicit per-machine startup warning and dashboard scope label.
3. **Session-scoped reads** — unchanged from v1's deferral.
4. **Semantic-similarity dedup** — exact-normalized-hash only in v2.
5. **Cross-agent visibility** — unchanged from v1's deferral.
6. **Automated mechanism synthesis** — v2 requires the writer to declare a mechanism; it does NOT synthesize one automatically from commitment text.
7. **Commitment detection at utterance** — adjacent to v2 but lives in the tone-gate, not the ledger. Tracked separately.
8. **Storage backend migration** (Gemini framing) — v2 stays on JSONL + proper-lockfile. Migration to SQLite-WAL or equivalent is v3 work if scale demands it.
9. **PII/GDPR-grade redaction** (Gemini framing) — v2 relies on Unicode sanitization and length caps. A dedicated PII-scrubbing layer for commitment text is v3.

## Success criteria

- v2 ships behind `v2Enabled=false` default. After a 7-day observation period with no anomalies on internal testing, default flips to true in a minor release.
- Existing v1 tests pass unchanged.
- New tests for v2:
  - Session-auth rejection paths (missing headers, invalid token, expired token, absolute-TTL-exceeded).
  - Near-duplicate normalization: Unicode NFC equivalent strings hash to same key; case-only variations hash to same key; zero-width character injection hashes to same key.
  - Rate limits: per-session, per-agent-global, per-session passive-wait.
  - Resolution tiers: self-asserted restricted to creator session; cross-session self-assert attempt returns 403.
  - Mechanism-ref validation: valid job ref → refStatus valid; bogus ref → refStatus invalid + status disputed immediately; timeout → refStatus unverified.
  - Dispute coalescing derived from ledger (no in-memory state).
  - Supersession-chain cycle detection (cycle produces structured error, not hang).
  - Hook-env-propagation fallback: marker file missing → interactive REST fallback path succeeds.
  - Atomic token-file write: temp-and-rename leaves no world-readable window (strace or equivalent test).
  - File-mode verification: token file with mode 0o640 → session fails CLOSED, no writes permitted.
  - Log masking: synthetic token value does not appear in any log output.
  - Expired-status sweep: commitments past deadline get `expired` note entries.
  - Stranded-commitment sweep: commitments whose creating session is purged get `stranded` note entries.
- A shadow-self end-to-end test: subsession registers, writes a `commitment` with `mechanism.type="scheduled-job"`, the job later completes and emits a `subsystem-verified` resolution, user-facing session reads the ledger and sees both the original commitment and its verified resolution.
- Hot-path load test: p99 < 150ms at 100 writes/minute sustained, 4 concurrent sessions.
- v1-reader compatibility: a v1 render path encountering a v2 commitment entry renders safely with degraded fields, no crash.
- Dashboard displays active commitments with correct overdue highlighting, mechanism badges, refStatus badges, revocation controls.
- User-resolve path works end-to-end from the dashboard.
- `instar migrate sync-session-hook` correctly migrates divergent session-start hooks to include the v2 session-bind call.
- Rollback path verified: disable `v2Enabled`, confirm v1 behavior intact; revert commit, confirm v1 behavior intact; `instar ledger cleanup` removes v2 artifacts.
- Cross-model review (GPT/Gemini/Grok) runs as part of convergence, not as an explicit deferral. Inclusion of cross-model is tracked in the spec's convergence report.
