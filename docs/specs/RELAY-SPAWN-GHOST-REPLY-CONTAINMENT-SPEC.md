---
title: "Threadline Relay-Spawn Ghost-Reply Containment"
slug: "relay-spawn-ghost-reply-containment"
author: "echo"
status: "approved"
approved: true
approved-by: "justin"
approved-at: "2026-04-29T05:33:00Z"
approval-conditions: "Tracked follow-ups must not drop off map: ACT-775 (run /crossreview pre-merge), ACT-776 (multi-machine ledger spec), ACT-777 (session sandbox isolation spec)."
review-iterations: 3
review-convergence: "2026-04-29T05:30:00Z"
review-completed-at: "2026-04-29T05:30:00Z"
review-report: "docs/specs/reports/relay-spawn-ghost-reply-containment-convergence.md"
review-internal-reviewers: ["security", "scalability", "adversarial", "integration"]
review-external-reviewers-skipped: true
review-external-skip-reason: "Cross-model (GPT/Gemini/Grok) review skipped in this convergence run; recommend running /crossreview as a final pre-/instar-dev check before approval."
---

# Threadline Relay-Spawn Ghost-Reply Containment

## Problem statement

A peer agent sent a Threadline message to echo. The relay logged a `thread-opened` event and "Spawned session for X" — twice. But:

1. The persistent inbox never received the message body.
2. `threadline_history` for that thread returns "not found or expired".
3. No tmux session and no session directory was actually created on the receiver side.
4. **Despite all of the above, the sender received four replies in their inbox** referencing real commit SHAs — accurate forensic detail mixed with a fabricated narrative ("interrupted interactive rebase" — no rebase was in progress; "parallel-dev-isolation never merged" — it merged via PR #53).

Diagnostic: an ephemeral session on the receiver side spawned, had real `git` access, ran some commands, and synthesized a plausible-but-wrong audit. It then crashed or was reaped without persisting back to the receiver's main inbox or session ledger. The sender's side is none the wiser; the receiver's persistent self never saw the conversation.

### Why this is the worst failure mode

A pipeline that drops the message entirely is recoverable — both ends notice and re-send.
A pipeline that returns a clear error is recoverable — the sender knows.
**A pipeline that returns a coherent-but-wrong response with real artifacts is the worst case** — the sender forwards it as ground truth; the receiver's persistent self has no record to refute it; the user makes decisions on fabricated state.

Structurally the same failure mode as "audit appeared correct because it cited real commit hashes" — partial truth used as a vector for false conclusions.

## Threat model

The system must defend against all of:

1. **Confused/buggy sessions** — the actual ghost case. Real disk access, real git access, fabricated narrative.
2. **Stale state** — heartbeat/ledger files left behind by prior spawns being reused.
3. **Sibling processes** — unrelated tmux/jobs on the same machine touching the same paths.
4. **Crashed components** — watchdog itself crashes, relay restarts mid-spawn, sleep/wake events.
5. **Replay** — old envelopes re-injected, old traces reattached to new replies.
6. **Hostile/buggy peer** — peer floods heartbeats, withholds ACKs, replays envelopes, ships forged traces.
7. **Cross-process** — a second instar process on the same machine, or a paired machine across MoltBridge.

The defenses below are designed assuming the suspect is the spawned session itself; nothing the suspect can write or sign can be the basis of trust.

## Proposed design

### Component A — Spawn provenance & idempotence

**Spawn nonce.** When the relay decides to spawn a session for `thread-opened` event `E`, it generates a cryptographically random `spawnNonce`. This nonce is:
- Stored in the spawn ledger row for `E.eventId` (see below)
- Handed to the spawned session via an inherited file descriptor (FD 3) opened on a pipe by the relay before `execve`. The session reads the nonce from FD 3 once and the relay closes its write end. Children of the session do NOT inherit the nonce (FD 3 is closed by the session after read; not exported to env). This closes the round-2 finding that env-passing leaks the nonce to forked helpers used to forge heartbeats.
- Never written to any on-disk path the session can read after launch.

**Spawn ledger (compare-and-swap on spawn).** Backed by a SQLite table at `.instar/threadline/spawn-ledger.db` (chosen over JSONL after round-2 review: 100k-row CAS scans on append-only JSONL are O(n) per spawn). Schema: `(eventId TEXT PRIMARY KEY, peerId, spawnNonce, spawnedAt, status)`. CAS = `INSERT OR FAIL`; on `SQLITE_CONSTRAINT_PRIMARYKEY`, spawn is skipped. WAL mode + `flock` on the db path coordinates a second instar process on the same host. The ledger row is the spawn-creation step, not a post-hoc check.

**Retention & rate limits.** TTL: 30 days, pruned by an existing background job. Hard caps: 100k rows global; per-peer rolling cap of 1000 spawns per 24h with `peer-spawn-flood` Attention Queue entry on breach. Index on `(peerId, spawnedAt)` for the per-peer scan.

**Multi-machine — explicitly out of scope.** Round-2 integration review confirmed `shared-state.jsonl` is per-machine and does NOT sync cross-machine (`MultiMachineCoordinator.ts:137,237`). For paired machines, the same envelope CAN reach both relays and produce two spawns of the same event. This is documented as a known gap and tracked as a follow-up spec `MULTI-MACHINE-SPAWN-LEDGER-SPEC.md`. Single-machine (the common case, and the case in the original incident) is fully covered. The follow-up spec will be filed in the same PR as this one and linked from this spec's frontmatter.

**Authenticated spawn-event id.** `eventId` is bound to the relay-acknowledged signature of the encrypted envelope. Replayed envelopes produce the same eventId and are ledger-rejected on the second arrival.

### Component B — Heartbeat & failure detection

**Authenticated heartbeat.** The spawned session writes a heartbeat record containing:
```
{ threadId, spawnEventId, sessionPid, hmac(spawnNonce, "{eventId}:{pid}:{timestamp}"), timestamp }
```
to `.instar/threadline/sessions/<threadId>.alive` using **atomic-rename**: write `<threadId>.alive.tmp`, fsync, then `rename()`. First write must occur within 5s of process start. Subsequent refreshes every 10s while the session is alive.

**Concurrent spawn cap.** Maximum 1000 simultaneous in-flight spawns per agent. New spawn requests beyond the cap return `delivery-failed:overloaded` to the sender (no inbox-only fallback for overload — explicit failure surfaces backpressure). This bounds the watchdog's per-tick `readdir` cost and prevents a flood from exhausting watchdog throughput.

**Watchdog (signal-producer).** A single shared poller — one timer, one `readdir` of `.instar/threadline/sessions/` at 1s tick — emits signals:
- `heartbeat-missing` if the file does not appear within 5s
- `heartbeat-forged` if the file appears but HMAC does not verify against the ledger's `spawnNonce`
- `heartbeat-stale` if `mtime + 2× refresh_interval` (20s grace) passes without refresh while ledger row is `spawning`

The watchdog NEVER kills the session itself. It emits signals that feed the relay-side authority below.

**Liveness of the watchdog.** The watchdog itself emits a `watchdog-alive` heartbeat to the relay every 5s. Absence of `watchdog-alive` for >15s causes the relay to default-fail any pending spawns rather than promote them. **Default is fail-CLOSED** for all ghost-prevention authorities.

**Relay-side spawn-failure authority (smart gate).** Consumes watchdog signals; on `heartbeat-missing|forged|stale` the relay:
- Marks the ledger row `status:'failed'`
- Persists the message envelope to the receiver's persistent inbox via the inbox-only path (no session, no auto-reply)
- Surfaces an Attention Queue entry on the receiver side describing the failed spawn with a link to the inbox
- Notifies the sender via the receipt mechanism in Component C (status: `delivery-failed`)
- Does NOT auto-retry spawn (manual retry only — auto-retry of spawn after a forged heartbeat is itself a vector)

### Component C — Sender-side delivery confirmation (chained receipt)

A `threadline_send` returns one of three explicit `deliveryStatus` values, side-by-side with the existing `success` boolean for backward compatibility:

| Status | Meaning |
|--------|---------|
| `confirmed` | Receiver-side relay signed `{spawnEventId, heartbeatNonce, inboxWriteSha}` AFTER the message body was durably persisted to the persistent inbox. Reply, if any, is authoritative. |
| `unconfirmed` | Receipt did not arrive within bound (default 8s). Outcome is ambiguous. The status is *informational* and never auto-promoted to `confirmed` by timeout. |
| `failed` | Relay-side spawn-failure authority emitted `delivery-failed` for this eventId. Inbox-only delivery may have succeeded; check `inboxOnly: true`. |

**Receipt content.** The receipt is signed by the receiver-side relay, NOT by the spawned session. It only signs after observing both: (a) verified heartbeat + (b) inbox-write SHA. Heartbeat alone never produces a `confirmed` receipt — that is the bug being fixed.

**Sender-side state machine.** Each outbound has a delivery-attempt row with terminal states:
- `confirmed`, `failed`, or `abandoned-after-T` (24h ceiling)

Rows are archived to a rotating log after terminal-state transition. No monotonic in-memory growth.

**Anti-weaponization.** A peer holding ACKs to permanently mark a sender's outbound `unconfirmed` is bounded by the existing `AgentTrustManager` per-peer error budget. The sender's own trust state is NOT degraded by receiver-side timeouts. Auto-feedback POSTs to the sender on remote `delivery-failed` are deduped per `(peerId, threadId, hour)`.

### Component D — Reply provenance (out-of-process trace recorder)

The original spec proposed "session attaches commands + stdout SHA." Round 1 review correctly observed this is theater — the suspect signs its own alibi. Round 2 review correctly observed that PATH-shimming is best-effort against a non-cooperating session (LD_PRELOAD, absolute-path exec, custom PATH override all bypass it). The design below is honest about that and uses **quarantine-by-default-on-empty-trace** as the safety net rather than relying on the shim being uncircumventable.

**Trace recorder (best-effort).** The spawned session is launched with:
- `PATH=$INSTAR_SHIM_BIN:$PATH` where `$INSTAR_SHIM_BIN` contains shims for `git`, `gh`, `npm`, etc.
- Shims are installed at `<agent-state>/threadline/shim-bin/` by `PostUpdateMigrator` (this is a normal directory under the agent's existing state dir — does NOT require a per-session sandbox bin/, addressing the round-2 integration finding that no such sandbox exists today).
- Each shim execs the real binary (resolved by reading `/etc/paths` minus the shim dir to avoid recursion), tees stdio through `crypto.createHash` streaming, and appends a signed record to `<agent-state>/threadline/sessions/<threadId>.trace.jsonl` via the relay-supplied FD 4 pipe (HMAC keyed on `spawnNonce`, signing happens in the shim).
- Records: `{cmd, argHash, exitCode, outputDigest, timestamp}`. Output capped at 1 MiB; on overflow, `truncated:true`.

**Threat-model honesty.** A non-cooperating session can bypass the shim via `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, absolute-path exec (`/usr/bin/git`), or shell PATH override. The spec does NOT claim the shim is tamper-proof against the session. It claims:
1. A *cooperating* session (the common case — including a confused session running normal Claude logic) will go through the shim and produce a useful trace.
2. A non-cooperating session produces an empty or suspicious trace, which triggers fail-closed quarantine (below).
3. True sandbox-level isolation (`sandbox-exec` on macOS, seccomp on Linux) is tracked as a separate follow-up spec `SESSION-SANDBOX-ISOLATION-SPEC.md`. This spec works without it.

**Reply gate (implementable).** When the spawned session emits a reply, the receiver-side relay verifies:

1. **Trace presence & signature.** Trace file exists, every record has a valid HMAC under the ledger's `spawnNonce`. Missing trace OR invalid signature OR empty trace (zero records) → `traceVerified: false`, quarantine.

2. **Command-template causation check.** Round-2 correctly noted "intersect" was unimplementable — the receiver does not have raw stdout to verify SHA membership. The implementable check: extract from the reply text any (a) git SHA-like tokens (40-hex or short-form), (b) branch/ref names, (c) file paths matching the receiver's working tree, (d) PR/issue numbers. For each extracted fact, verify the trace contains a successful invocation of a command whose output COULD have produced that fact class (e.g., a SHA-class fact requires at least one `git log`, `git rev-parse`, `git show`, or `git diff` invocation in the trace; a PR-number requires a `gh pr` invocation). This is a *necessary* check (a reply about a SHA without ANY git command in the trace is presumptively fabricated) but not *sufficient* — a session that ran `git log` and then fabricated SHAs from imagination still passes step 2. That's why step 3 exists.

3. **Quarantine-on-suspicion.** Any reply whose extracted facts exceed the trace's recorded command count by more than a small ratio (default: facts > 3× commands) triggers quarantine for human review. A reply with 5 invented SHAs but only 1 `git log` invocation is suspicious. Tunable `factsToCommandsMaxRatio` in config.

4. Replies that pass all three → forwarded to sender with `traceVerified: 'shim-best-effort', traceId`.

5. Replies that fail any step → quarantined locally (Component E); sender receives `delivery-failed` with reason `unverified-reply`.

The honest claim: this design **detects naive fabrication** (no git commands ran, or far more facts than commands) and **defers truly hostile fabrication** to (a) the receiver's persistent self via quarantine and (b) the future sandbox-isolation spec.

**Privacy.** Raw stdout never leaves the receiver. Only `outputDigest` is in the trace; only `traceVerified + traceId` ships to the sender.

**Bounded cost.** Stream-SHA in the shim subprocess, off the relay's main event loop. Trace JSONL rotates per-session (deleted on session end + 7d retention).

### Component E — Quarantine queue & user surfacing

Quarantined replies (failed trace verification, missing trace, or any reply emitted by a session whose spawn-ledger row is not `verified`) land in a per-thread quarantine queue at `.instar/threadline/quarantine/`. Queue:
- Per-peer cap of 100 entries; global cap of 5000; FIFO eviction with `quarantine-overflow` metric
- Each entry surfaces an Attention Queue notification AND a dashboard route `/threadline/quarantine` shows them
- Surfaced content is rendered through the existing `/msg read` tool-based message sandbox — never raw-injected into any agent's prompt context (avoids prompt-injection vector)
- Manual user action (approve / discard / reply) clears the entry

**Quarantine is a signal, not a final authority.** The receiver's persistent self can pull from quarantine and decide. The block is on auto-promotion to "authoritative reply forwarded to sender" — that requires trace verification.

### Component F — Configuration & rollback

New config block in `ConfigDefaults.ts`:
```typescript
threadline: {
  spawnGuard: {
    heartbeat: true,            // default-on; ghost-prevention
    spawnLedger: true,          // default-on; idempotence
    fabricationGuard: true,     // default-on; trace verification
    senderConfirmation: false,  // default-off until consumers opt-in (backcompat)
  },
  spawnGuardTimeouts: {
    firstHeartbeatMs: 5000,
    refreshIntervalMs: 10000,
    senderConfirmTimeoutMs: 8000,
    senderTerminalTimeoutMs: 86400000,
  },
}
```

**Per-flag rollback story:**

- **heartbeat**: flag-off → no failure detection; pre-existing spawn behavior. In-flight heartbeats: ignored harmlessly.
- **spawnLedger**: flag-off → re-enables double-spawn risk. In-flight ledger rows: retained for forensics; not consulted.
- **fabricationGuard**: flag-off → traces still recorded (cheap) but not gated on. In-flight quarantined replies: **drained to inbox-as-unverified before disabling** (rollback procedure must run drain step; never bare flag-off).
- **senderConfirmation**: flag-off → return `success:true` with `deliveryStatus` field omitted. Existing callers unaffected.

## Decision points touched

Per `docs/signal-vs-authority.md`:

1. **Spawn ledger CAS** — *authority* (idempotency keys exception). Blocks duplicate spawns. Brittle structural check on a structural concern → permitted authority.
2. **Heartbeat watchdog** — *signal-producer*. Emits `heartbeat-missing|forged|stale`. Does not block; feeds (3).
3. **Relay-side spawn-failure handler** — *authority*. Smart gate consuming (2)'s signals; decides inbox-only delivery vs. retry-suppression.
4. **Reply trace verifier** — *authority* on the outbound-reply path. Three-step structural check (HMAC presence + signature; command-class causation; facts/commands ratio) on a high-stakes irreversible peer-visible action → permitted authority under the safety-guard exception. Quarantine is the consequence, not a kill.
5. **Quarantine queue** — *signal* to the receiver's persistent self; user is the final authority on what to do with quarantined content.
6. **Sender-side delivery-confirmation** — explicit tri-state status; neither blocking nor silent. Surfaces ambiguity rather than masking it.

## Backward compatibility & migration

### MCP/SDK surface
`threadline_send` returns `{success: true|false, deliveryStatus?: 'confirmed'|'unconfirmed'|'failed', inboxOnly?: bool}` — `deliveryStatus` is optional in the response schema, so external SDK consumers (`AutoGenTool`, `CrewAITool`, `LangGraphTool`) that don't read it are unaffected. In-tree callers (`routes.ts:10473`, `LangGraphTool.ts:75`, `ThreadlineRouter.ts:162`, the four MCP adapters) are updated atomically in the same PR to read `deliveryStatus` when `senderConfirmation` flag is on.

### PostUpdateMigrator
Adds an idempotent migration block (with stamped marker) that:
- `mkdirSync` for `.instar/threadline/sessions/`, `.instar/threadline/quarantine/`, `.instar/threadline/shim-bin/`
- Initializes `.instar/threadline/spawn-ledger.db` (SQLite, WAL mode, schema applied)
- Writes the shim binaries into `.instar/threadline/shim-bin/` (one shim per allowlisted CLI; shipped as files in instar's `templates/` directory and copied on migration — does NOT require migrator to rewrite TS template literals)

**Spawned-session prompt template change.** The heartbeat-write instructions ship as part of the npm package via `PipeSessionSpawner.ts` and `ListenerSessionManager.ts` source updates. There is no migrator step that rewrites compiled JS in `node_modules/instar/dist`; the change reaches existing agents the next time they `npm install` instar (which is also the moment `PostUpdateMigrator` runs the rest of the migration). Spec is honest about this — round-2 integration review correctly flagged the original phrasing as implying a capability the migrator does not have.

### BackupManager
Round-3 review caught two issues:

1. `BackupManager.expandGlob` rejects entries containing `/` and falls through to literal-path semantics — so a naive `threadline/quarantine/*` would not actually be backed up. Resolution: ship a small extension to `expandGlob` (separately tested) that handles single-level subdir globs of the form `<dir>/<pattern>`, OR add the entire `threadline/quarantine/` directory as a recursive include via the existing recursive-dir code path (preferred — no new glob behavior).

2. Ledger filename: Component A specifies SQLite at `threadline/spawn-ledger.db`. The backup includes the db file plus its WAL sidecar files (`spawn-ledger.db-wal`, `spawn-ledger.db-shm`); a `PRAGMA wal_checkpoint(TRUNCATE)` runs immediately before snapshot to flush WAL into the main db so a partial WAL is never the only source of recent rows. Heartbeats are ephemeral; explicitly excluded.

`DEFAULT_CONFIG.includeFiles` adds:
- `threadline/quarantine/` (recursive-dir include)
- `threadline/spawn-ledger.db` (with WAL checkpoint pre-snapshot)

### Multi-machine
Out of scope for this spec. See `MULTI-MACHINE-SPAWN-LEDGER-SPEC.md` (filed alongside this PR). Single-machine ghost-prevention is fully covered; cross-machine paired-instar deployments retain the duplicate-spawn risk on the same envelope until that follow-up ships. Documented as a known limitation in the user-facing convergence report.

## Test plan

### Unit
- Watchdog signal generation under all five conditions (`missing`, `forged`, `stale`, watchdog-alive present/absent, sleep/wake jump).
- Spawn-ledger CAS under concurrent insert (process A and B race for the same eventId).
- HMAC heartbeat verification with valid nonce, wrong nonce, missing nonce.
- Trace-recorder shim: command on allowlist, off allowlist, output-digest matches independent re-run, truncation at 1 MiB.

### Integration
- Reproduce original failure: relay receives encrypted envelope, decryption returns empty body, spawn-session called → assert `DELIVERY_FAILED` is emitted, no ghost reply produced.
- Spawn a session that never writes the heartbeat → assert reaping + `delivery-failed` to sender.
- Spawn a session that writes a forged heartbeat (wrong HMAC) → assert `heartbeat-forged`, ledger marked `failed`, no reply forwarded.
- Spawn a session that writes valid heartbeat but produces a reply containing a commit SHA never seen by the trace recorder → assert quarantine.
- Sender-side: send a message the receiver never confirms → assert `unconfirmed` returned, never auto-promoted.
- Multi-machine: open the same thread on machine A and B simultaneously → assert only one spawn proceeds.
- Backup/restore round-trip: snapshot with quarantined entries, restore, verify entries surface in dashboard.
- PostUpdateMigrator: run on a pre-spec agent state directory, verify all paths exist and template was updated.

### End-to-end
- Re-run the original cross-agent scenario after the fix is live: receiver inbox either gets the message OR sender gets a clear `failed`/`unconfirmed`. Manual inspection: no fabricated-reply path possible.

### Adversarial
- Sibling process `touch`es a heartbeat file → assert `heartbeat-forged`.
- Hostile peer floods envelopes with new eventIds → assert per-peer rate cap engages, ledger does not exhaust.
- Replayed envelope → assert spawn-ledger CAS rejects.
- Fabricated trace (matching HMAC stolen from prior session) → infeasible because nonce is per-spawn; cover with unit test that two spawns of the same eventId never share a nonce.
- Watchdog crashed → assert relay defaults all pending spawns to `failed` (fail-closed).

## Why this should NOT be deferred

Per the "no out-of-scope trap" rule: every same-class deferral has to be justified. Components A–F all serve the same problem (ghost replies producing fabricated peer-visible state) and removing any one re-opens the failure mode:
- Spawn ledger without heartbeat → ghost can still emit replies until OOM.
- Heartbeat without trace recorder → session can write a valid heartbeat then fabricate a narrative.
- Trace recorder without sender-side confirmation → sender still acts on stale partial information when the full pipeline fails late.
- All of the above without quarantine + dashboard → silent failure mode returns.

Comprehensive scope by default. Feature flags in Component F are the rollback path, not a scope-deferral excuse.

## Open questions resolved by round 1 review

1. **Heartbeat path** → `.instar/threadline/sessions/<threadId>.alive`, atomic-rename, HMAC'd. (Resolved.)
2. **Trace format** → out-of-process shim, signed JSONL, allowlisted commands, output digests only (no raw stdout). (Resolved.)
3. **Auto-feedback to sender** → yes, deduped per `(peerId, threadId, hour)`. (Resolved.)
4. **Rollback story** → see Component F per-flag table. (Resolved.)
5. **Multi-instance/multi-machine ledger** → multi-instance same-host: SQLite WAL + flock. Multi-machine: explicitly out of scope, tracked via `MULTI-MACHINE-SPAWN-LEDGER-SPEC.md` filed in the same PR. (Resolved.)
6. **Watchdog liveness** → `watchdog-alive` heartbeat to relay; absence triggers fail-closed. (Resolved.)

## Cross-review resolutions (post round 2)

- **2-phase CAS race**: descoped along with multi-machine. Single-machine SQLite CAS is atomic.
- **Interactive `git` prompts**: spawned sessions run with `GIT_TERMINAL_PROMPT=0`, `GPG_TTY` unset, `GIT_ASKPASS=/bin/false`. Shim asserts these are set on every invocation; if not, shim refuses to exec.
- **Backup manifest growth**: 5000-entry cap × ~10KB = ~50MB worst case in snapshot. Acceptable; existing backup compression (gzip) brings actual disk impact to ~5–10MB. Documented in `BackupManager` config comment.
- **In-memory ledger index**: SQLite handles this internally; no separate in-memory index needed (replaces the round-2 scalability finding about JSONL scan cost).
- **Concurrent-spawn cap**: 1000 enforced (Component B); breach returns `delivery-failed:overloaded`.

## Anti-scope (unchanged)

- Fixing decryption errors at the relay (separate concern).
- Sender-side reply trust scoring beyond the tri-state delivery status (separate concern).
- Any change to the relay protocol itself — fixes go in receiver-side spawn handling and sender-side delivery confirmation.
