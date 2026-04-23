---
title: "Self-Healing Remediator — Turn the Smoke Alarm into a Sprinkler"
slug: "self-healing-remediator"
author: "echo"
status: "converged-pending-approval"
review-convergence: "2026-04-23T04:04:36Z"
review-iterations: 5
review-completed-at: "2026-04-23T04:04:36Z"
review-report: "docs/specs/reports/self-healing-remediator-convergence.md"
---

# Self-Healing Remediator

> Today, `DegradationReporter` detects when a subsystem falls back to a worse version of itself, spams the user's attention channel, and does nothing else. This spec adds a `Remediator` that matches known failure signatures against a runbook registry, executes recovery, verifies the subsystem returned to healthy, and only escalates to the user when remediation fails or the signature is unknown. Runbooks are added one-by-one as new signatures are hit. The system learns its own playbook rather than trying to be clever on day one.

## Problem statement

### The smoke-alarm gap

`DegradationReporter` is a good smoke alarm: when a feature degrades, it is LOUD about it. It logs, files a feedback bug, and sends a Telegram alert to the attention channel. What it doesn't do is *respond* to the fire. Every degradation requires a human (Justin) to notice the alert, diagnose the root cause, and run whatever repair is needed — even when the repair is mechanical and fully documented.

Today (2026-04-22), we hit this concretely. Echo's shadow node symlink was silently bumped from v22 to v25 by a Homebrew update. Four SQLite-backed subsystems — `TopicMemory`, `SemanticMemory`, `iMessage`, `FeatureRegistry` — fell back to degraded paths because `better-sqlite3` is ABI-pinned to v22. The user saw four degradation alerts every ~20 minutes in the Slack attention channel for hours before it came up in conversation. The repair ("repoint shadow node, rebuild native modules, restart") is 30 seconds of mechanical work.

A self-healing agent should have fixed it automatically. That is what Instar claims to be.

### What makes this hard

"Auto-repair" has well-known failure modes:

1. **Infinite-loop remediation** — the repair runs, fails, triggers a new degradation, triggers the repair again.
2. **Destructive remediation** — the repair makes things worse (e.g., a rebuild corrupts local state, a restart drops in-flight work).
3. **Symptom masking** — the repair silently fixes a symptom while the root cause continues to degrade other systems.
4. **Wrong-signature match** — a runbook matches a superficially similar error and runs a remedy that doesn't apply.
5. **Unbounded authority creep** — a system that can "repair itself" today becomes a system that can "rewrite itself" tomorrow unless the authority boundary is explicit.
6. **Injection via the detection channel** — the matcher reads strings that originated in untrusted sources (caught exception text, LLM tool output relayed into an error). A substring match on such a string is an attacker-controllable trigger for a privileged action.

This spec addresses each of these as a structural constraint, not an afterthought.

## Proposed design

### Trust model: signal vs. authority (per the project principle)

- **Signal producer** — `DegradationReporter` continues to be the *detector*. It reports what failed and why. It has no authority to act, and is responsible for **redacting and normalizing** reason strings before they are observed by any other module.
- **Authority** — `Remediator` is the only module that decides whether and how to act on a degradation. It consumes structured, normalized events from `DegradationReporter`, matches them against the runbook registry, and is the sole executor of remedies.
- **Alert policy (authoritative — supersedes wording elsewhere).** The existing `DegradationReporter` attention-channel path is **gated by the remediator's decision envelope**, not preserved unconditionally. The full matrix:

  | Remediator outcome | Attention-channel alert? | Audit log entry? |
  | --- | --- | --- |
  | `no-matching-runbook` (remediator doesn't know this signature) | YES | YES |
  | `precondition-failed`, `execution-failed`, `execution-failed-partial`, `verification-failed`, `window-cap-exceeded`, `churn-detected`, `coalesce-suspect` | YES (with attempt summary) | YES |
  | `dry-run` (matched, would-execute, not executed) | YES (unchanged from pre-remediator behavior — user must see the raw degradation until the runbook is trusted enough to go live) | YES |
  | `success` (matched, executed, verified) | NO (silent) | YES |
  | `covered-by-attempt` (identical-tuple storm coalesce) | NO (silent) | YES |

  Phase-1 (dry-run default) always shows the user the alert: dry-run matches DO NOT suppress the existing alert path. Phase-2 flips dry-run default to false for `local-process` / `shadow-install` / `machine` runbooks, at which point `success` goes silent. The Upgrade invariants are amended accordingly: the zero-user-visible-change promise is specifically about Phase 1.

### Attempt state machine (explicit)

Every remediation attempt walks this state machine. Transitions are recorded to the audit log at each boundary with the same `attemptId`:

```
matched
  ↓
preconditions-ok ── preconditions-failed → [terminal: escalate]
  ↓
lock-acquired ── lock-contested → [terminal: escalate or coalesce]
  ↓
dry-run-logged → [terminal: silent if Phase ≥ 2, alert if Phase 1]
  OR
executing  ── execute-failed-pre-mutation → (retry-once branch)
  ↓                      └── execute-failed-pre-mutation-2 → [terminal: freeze, escalate]
  ↓          └── execute-failed-partial → [terminal: dead-letter, freeze, escalate]
  ↓          └── execute-failed (post-mutation, non-partial) → [terminal: escalate]
awaiting-restart → restart-timed-out → [terminal: verification-failed, escalate]
  ↓
verifying ── verify-failed → [terminal: escalate]
  ↓
succeeded → [terminal: silent, resolve feedback bug]
```

Each non-terminal state has a hard wall-clock cap beyond which the attempt is force-transitioned to the nearest failure terminal. State-machine transitions are the only authoritative attempt outcome — audit entries, feedback-manager updates, and attention-channel gating all consult the state, not free-form prose.

### Time source (monotonic where it matters)

**Wall-clock (`Date.now()`)** is used ONLY for long-horizon comparisons that must survive process restart and are user-inspectable: `windowMs` (24h), audit-log retention (90d), dry-run promotion trace age (≤ 48h), phase-transition announcement keys. These are resilient to modest laptop sleep-wake drift — a 2-hour sleep during a 24h window is not a failure mode.

**Monotonic time (`performance.now()`, `process.hrtime.bigint()`)** is used for ALL short-duration timers within a single process lifetime: heartbeat cadence, verify-poll interval + backoff, execute-step timeouts, lock `expectedRuntimeMs` budget, storm-coalesce recency window, matcher 5ms budget, end-to-end `report()` budget. This closes the crossreview finding (Gemini + GPT) that `heartbeatAt` and similar short TTLs measured via wall clock would prematurely expire after a MacBook sleep-wake cycle, triggering spurious lock reclaim or timeout. Monotonic time is paused-during-sleep on macOS/Linux, which matches the "how much work did the holder actually do" semantics we want.

When a state survives a process restart (e.g., heartbeat record on disk), the on-disk record carries BOTH a wall-clock timestamp (for cross-process comparison) AND a monotonic delta from the record's own wall-clock anchor (useless across processes; used only within the writing process). The post-restart consumer uses wall-clock only and accepts that a long sleep-wake window across process boundaries will look like staleness.

### Structured, normalized event contract

`DegradationReporter` owns the redaction and normalization boundary. Before any downstream observer (including the remediator) sees an event, the reporter produces a **NormalizedDegradationEvent** with these fields:

```ts
interface NormalizedDegradationEvent extends DegradationEvent {
  subsystem: string;                 // e.g. "TopicMemory" — stable enum
  errorCode: string | null;          // whitelisted enum extracted from the original error
                                     // (e.g. "NATIVE_MODULE_ABI_MISMATCH", "SPAWN_ENOENT", "DB_OPEN_FAIL")
  nativeError?: {                    // structured shape for ABI-class failures
    moduleName: string;              // e.g. "better-sqlite3"
    observedAbi: number | null;      // e.g. 127
    requiredAbi: number | null;      // e.g. 141
  };
  reason: {
    firstLine: string;               // single line, ANSI/control stripped, length-capped at 512 chars
    full: string;                    // redacted, capped at 8KB, ANSI-stripped, newlines preserved
  };
  redactions: string[];              // list of redaction tokens applied (for observability, no secrets)
  observedAt: string;                // ISO timestamp
}
```

Redaction (owned by the reporter) replaces: bearer tokens, values of env vars known to be secrets, absolute home paths (→ `~`), user project paths (→ `<project>`), IP addresses, email addresses, API key prefixes. The redaction table is defined in `src/monitoring/Redactor.ts` with unit tests per pattern.

**Matchers MUST match on `subsystem`, `errorCode`, and `nativeError` structured fields. Using `reason.full` or `reason.firstLine` as a matcher primary key is forbidden by a registry-load-time lint.** Matchers may consult those strings only to *refine* a match already made on structured fields (defense-in-depth), never to originate one.

### Runbook registry

A runbook is a small, declarative object:

```ts
interface Runbook {
  id: string;                                // stable identifier, e.g. "node-abi-mismatch"
  description: string;                       // one-line human summary
  priority: number;                          // unique per registry load; higher runs first
  eventPrefilter: {                          // registry uses this for O(k) dispatch, not O(n)
    subsystem?: string | string[];
    errorCode: string | string[];            // required
  };
  match(event: NormalizedDegradationEvent): boolean;  // deterministic, side-effect-free, <5ms
  preconditions(ctx: RemediationContext): Promise<PreconditionResult>;
  execute(ctx: RemediationContext): Promise<ExecutionResult>;
  verify(ctx: RemediationContext): Promise<VerificationResult>;
  blastRadius: "local-process" | "shadow-install" | "state-directory" | "machine";
  // NOTE: "external" blast-radius is intentionally NOT in this union on day one.
  // The non-goals list forbids outbound network in execute(); an "external" runbook
  // would contradict that non-goal. A future spec-convergence round may introduce
  // an "external" radius WITH an explicit relaxation of the outbound-network non-goal
  // and its own authority-boundary guardrails.
  reversibility: "reversible" | "partial" | "irreversible";
  platforms: ("darwin" | "linux" | "win32")[];
  maxAttemptsPerWindow: number;              // default 1; counts FAILED attempts, success resets
  windowMs: number;                          // default 24h
  expectedRuntimeMs: number;                 // used for lock-staleness bound
  requiresRestart: boolean;
  requiresMachineLock?: string;              // resource id when blastRadius === "machine"
}
```

Registry-load-time validation (refuses to boot if violated):
- Every runbook lives under `src/remediation/runbooks/` (enforced by build step).
- `priority` values are unique across the loaded set.
- `eventPrefilter.errorCode` is non-empty.
- `match`, `preconditions`, `execute`, `verify` are all functions; `verify` is not a no-op stub.
- Each runbook module imports no I/O (fs/net) at module top-level; platform-specific imports are dynamic and gated by `process.platform`.
- A static-analysis pass (lint rule) forbids `match()` from calling anything outside a pure-function allowlist (no `fs.*`, `require`, `process.env`, network).
- Runbook `platforms` includes the running `process.platform`; otherwise the runbook is skipped at load with an observability event, not an error.

**Matchers are pure functions** over the normalized event. No LLM in the match path. LLMs may be used to *author* new runbooks offline, but once registered, a runbook is code.

Runtime behavior:
- Matcher execution is wrapped: exceptions are caught per-runbook, logged as `runbook.match.error`, and count toward a per-runbook circuit breaker. After 3 consecutive match-path throws, the runbook is disabled until the next server start and surfaced in `/remediation/status`. One bad runbook cannot disable the rest of remediation.
- Matcher timing is asserted in tests (<5ms) and wrapped at runtime with a soft warning if it exceeds 5ms.
- Match dispatch uses the prefilter index: events route only to runbooks whose prefilter matches `(subsystem, errorCode)`. O(k) where k is candidates for this feature, not O(n) across the registry. Perf budget: <2ms per event for the dispatch step.

### First runbook: Node ABI mismatch

Ships with the remediator:

- **id**: `node-abi-mismatch`
- **priority**: 100
- **eventPrefilter**: `{ errorCode: ["NATIVE_MODULE_ABI_MISMATCH", "SPAWN_ENOENT"] }`
- **match**: `event.errorCode === "NATIVE_MODULE_ABI_MISMATCH" && event.nativeError?.moduleName === "better-sqlite3"` OR `event.errorCode === "SPAWN_ENOENT"` AND the spawned path resolves to the shadow node symlink. The corroborating system check `process.versions.modules !== expectedAbi` runs inside `match()` as a final gate; without this live observation, the match is false regardless of the event string.
- **preconditions**:
  - the asdf-pinned node version exists at the expected path (stat check),
  - the shadow install directory is inside the agent's state dir and writable,
  - **native build toolchain is available** — `which make`, `which python3`, and at least one of `which gcc` / `which clang` on the current platform. If the toolchain is absent, the runbook returns `precondition-failed: build-toolchain-missing` and escalates with a plain-English instruction (e.g., macOS: "install Xcode command-line tools via `xcode-select --install`"). Closes the crossreview finding (Gemini): the same Homebrew update that shifted node might have also affected the toolchain, so `npm rebuild` could fail silently without this check,
  - no other remediation is currently running (lock check),
  - the machine-level ABI-rebuild lock is acquirable (see §Multi-agent coordination),
  - `better-sqlite3/package.json` checksum matches the pinned manifest shipped with instar (integrity pin),
  - cumulative ABI-mismatch events in the last 10 minutes ≥ 2 (avoids acting on a single transient error).
- **execute**:
  1. Write `intent.json` with `{ runbookId, attemptId, step: "snapshot", startedAt }`. All subsequent steps update `intent.json.step` atomically.
  2. Snapshot: copy the current shadow node symlink target to `rollback/<attemptId>/symlink-target.txt`, and write `node_modules-manifest.json` (name + integrity hashes of top-level deps). Retain 24h.
  3. Repoint shadow node binary to the pinned version.
  4. Rebuild only the known-affected module: `npm rebuild better-sqlite3 --ignore-scripts` (scripts already executed during the original install; a rebuild does not require re-running `preinstall`/`postinstall`). If `--ignore-scripts` breaks the native rebuild on some platform, fall back to running the specific `gyp` command directly rather than generic `npm rebuild`. The rebuild is spawned with an explicit **execution sandbox**: `cwd = <shadow-install-root>`, `env = { PATH: <narrow-path-allowlist>, HOME, USER }` (no arbitrary env inheritance), `stdio: ['ignore', 'pipe', 'pipe']` captured for audit, hard timeout = `expectedRuntimeMs`, kill signal SIGTERM → SIGKILL escalation at `1.5 × expectedRuntimeMs`. Stdout/stderr are truncated to 8KB before audit-log append and pass through the Redactor.
  5. Write `pending-verify.jsonl` record: `{ attemptId, runbookId, event, deadline, expectedHealth, hmac }` where `hmac` is computed over the record using a per-agent key derived from `.instar/agent.state` (never persisted alongside the file).
  6. Signal the server supervisor to restart via `restart-intent.json` (see §Supervisor coordination).
  7. On successful verify post-restart: delete `intent.json`.
- **verify**: post-restart, poll `/health?fast=1` with 2s interval backing off to 10s, max 30 calls (≈4 min). Success = `degradations` array contains none of the affected subsystems.
- **blastRadius**: `machine` (shared shadow node / brew install affects all agents on this host).
- **requiresMachineLock**: `node-abi-rebuild` (coordinates with other agents on the same machine).
- **reversibility**: `reversible` — rollback artifacts under `rollback/<attemptId>/` for 24h; explicit rollback tool swaps the symlink back and rebuilds against the previous target.
- **platforms**: `["darwin", "linux"]`
- **maxAttemptsPerWindow**: 1 FAILED attempt per 24h. A successful attempt resets the counter.
- **windowMs**: 24h
- **expectedRuntimeMs**: 180_000 (3 min; covers slow CI).
- **requiresRestart**: true

### HMAC key lifecycle (threat model, machine-scoped)

**Threat model (explicit).** The HMAC on `pending-verify.jsonl` entries defends against an adversary (or buggy component) with write access to `.instar/remediation/` but NOT to `~/.instar/agent.key`. It is a containment boundary, not an unbreakable seal. On a single-user machine where any code running as the agent user can read both, this is a weakening attacker-forcing-work measure, not a capability guarantee. Documented here so nobody over-trusts it.

**Key storage.** The HMAC key lives at `~/.instar/agent.key` — **machine-scoped, 0600, NOT git-synced, NOT included in `.instar/` state**. The agent's synced `agent.state` does NOT carry the HMAC seed. `MachineLock.ts` owns creation of `~/.instar/machine-locks/` and `~/.instar/agent.key` with `mkdir(..., {recursive: true, mode: 0o700})` on first use, tolerant of EEXIST. Key derivation: `hmacKey = HKDF(readFileSync(~/.instar/agent.key), "remediation-pending-verify-v1", machineId)`. Each record stores `{ keyEpoch, hmac }`.

**Rotation.** The agent.key is generated once per machine (256-bit random). Explicit user rotation (`instar remediation rotate-key`) increments `keyEpoch` and invalidates older pending records. On state-dir restore where `~/.instar/agent.key` is absent or mismatched (expected — it's per-machine), pending-verify records whose `keyEpoch` doesn't match are treated as **`pending-verify.stale`** (observability-only, not escalated as "tampered"). Records whose HMAC fails on a matching epoch ARE treated as `pending-verify.tampered` and escalated.

### Multi-agent coordination (machine-level locks)

Runbooks with `blastRadius: "machine"` require a machine-level lock in addition to the agent-level lock. Machine locks live at `~/.instar/machine-locks/<resource>.lock` with `{ agentId, pid, bootId, startedAt, expectedRuntimeMs, heartbeatAt }`. Acquisition is `flock`-based (POSIX) or `O_EXCL` + fsync fallback.

**Heartbeat-based reclaim (not boot-gated).** The holder updates `heartbeatAt` every `max(expectedRuntimeMs / 3, 10s)` on a timer. A lock is reclaimable — at ANY time, not only at server boot — when:
- `heartbeatAt` is older than `3 × expectedRuntimeMs` (primary signal — proves the holder stopped doing work), AND
- EITHER `pid` is not running (`kill(pid, 0)` returns ESRCH) OR `bootId` doesn't match the current boot.

The `pid`-OR-`bootId` disjunction closes the iter-crossreview finding (GPT) that the original AND-of-three predicate meant a same-boot dead process never reclaimed — `kill(pid, 0)` is the authoritative liveness check within a boot; `bootId` mismatch covers PID-reuse across reboots.

Reclaim is logged as `machine-lock.reclaimed` with the stale record for forensic review. Zombie-holder case (process alive but stuck) is covered by the heartbeat expiry.

If a machine lock is held by another live agent, the current agent's runbook returns `precondition-failed: machine-lock-held-by-<agentId>`, logs the conflict, and does NOT escalate — the other agent is expected to fix the shared resource. A subsequent degradation event after the other agent finishes re-runs the match.

### Supervisor coordination (extend existing mechanism; new code acknowledged)

Instar's server supervisor (`src/lifeline/ServerSupervisor.ts`) already implements planned-restart via `.instar/state/restart-requested.json` and `.instar/state/planned-exit-marker.json` with `{ plannedRestart: true, expiresAt, ... }`. This spec extends that mechanism with forgery resistance and a version handshake. Both are explicitly new code introduced by this spec, not reuse:

**New primitive: supervisor handshake file.** The supervisor writes `.instar/state/supervisor-handshake.json` with `{ version: <instar-package-version>, supervisorBuildId, writtenAt }` on every supervisor start, atomically via write-rename. The remediator reads this file once at init and on every restart attempt. If the file is missing (old supervisor still running during partial upgrade) OR `version` is below `MIN_SUPERVISOR_VERSION` (constant in `src/remediation/Remediator.ts`), the remediator refuses to issue a planned-restart, marks the attempt `precondition-failed: supervisor-version-too-old-or-absent`, and escalates. Test matrix: old-supervisor-writes-nothing ⇒ remediator conservatively skips (contract test).

**Extended `restart-requested.json` schema.** Remediator writes `{ plannedRestart: true, source: "remediator", runbookId, attemptId, bootId, expiresAt, hmac }`. Existing supervisor consumers that don't know about `source`/`hmac` honor the flag by existing semantics. The NEW supervisor (version ≥ `MIN_SUPERVISOR_VERSION`) implements these behaviors:

- **HMAC required on every planned restart, not only `source: "remediator"`.** This closes the iter-3 bypass where an attacker writes `{plannedRestart:true}` without `source` to evade HMAC. The new supervisor rejects any `plannedRestart:true` without a valid HMAC, regardless of `source`. Legacy writers (AutoUpdater, ForegroundRestartWatcher) are updated in the same phase to include HMACs. During partial upgrade (new remediator against old supervisor), the spec accepts that unsigned-flag writes may still be honored by the old supervisor — this is a known-limited window that closes when both are upgraded.
- **Atomic read-verify-act.** The supervisor reads `restart-requested.json` ONCE into a buffer, verifies HMAC on that buffer, parses and acts on that same buffer. The path is not re-consulted between verify and act. File-descriptor open + read + close is a single syscall sequence; the buffer is the single source of truth for the decision. Closes the iter-3 TOCTOU finding.
- **Forged records logged and ignored.** Invalid or missing HMAC on a `plannedRestart:true` (new-supervisor mode) ⇒ `restart-intent.forged` audit entry, flag ignored, file left in place for the next honest writer to overwrite.
- **Planned-restart zero-backoff path** for validated `source: "remediator"` records: `CrashLoopPauser` is not engaged and the backoff counter is neither incremented nor consulted.

After a clean post-restart boot, the supervisor clears the flag via existing code (`unlinkSync`). The remediator keys post-restart verify on `pending-verify.jsonl`, not on flag residue — a contract test asserts remediator's verify loop works correctly after flag cleared.

**keyEpoch rotation is gated.** `instar remediation rotate-key` (and any programmatic rotation) requires bearer auth + `X-Instar-Request: 1` + `collaborative` trust level, and is rate-limited to 1 rotation per hour server-side. Rotation writes a `key-rotated` audit entry. Prevents rotation-DoS against in-flight pending-verify records.

### Restart handling — durable event capture

1. `DegradationReporter` persists normalized events synchronously to `.instar/degradations-queue.jsonl` when a restart is pending (`RestartPending` flag set by Remediator before step 6). Append is fsync'd.
2. **Queue-file caps.** `.instar/degradations-queue.jsonl` is capped at 1000 entries OR 5MB, whichever first. Further appends are dropped and counted in a `degradations.queue.dropped` telemetry counter. On boot, if the file exceeds cap, replay is skipped entirely and a single aggregate escalation is issued (`queue-overflow: N events dropped, please investigate`).
3. On server start, remediator:
   - Scans `intent.json`. If present and no matching `pending-verify.jsonl` record: the previous process crashed mid-execute. Handling depends on the `step` field the execute() method wrote into `intent.json` before each mutation:
     - `step === "snapshot"` (no mutations yet) ⇒ safe to retry once. Attempt marked `execution-failed-pre-mutation`, intent cleared, runbook remains eligible. If the retry also fails at snapshot step, treat as mid-mutation and freeze (below).
     - Any later step (`repoint-symlink`, `rebuild-module`, `signal-restart`) ⇒ state may be half-repaired, mid-mutation: attempt marked `execution-failed-partial`, intent moved to `dead-letter/<attemptId>.json`, user escalated with the artifact path, **per-runbook freeze** engages.
   - Per-runbook freeze auto-clears after EITHER (a) 3 successful unrelated runbook attempts in the same agent OR (b) 24 hours elapsed, whichever comes first, with an audit entry `dead-letter.auto-cleared`. This bounds the DoS window — an attacker who repeatedly crashes a runbook mid-mutation cannot permanently disable it without permanently denying the remaining remediation surface too. Manual clear via `instar remediation clear-deadletter` remains available.
   - Scans `pending-verify.jsonl` for entries whose HMAC validates against the current agent key:
     - `keyEpoch` mismatch → `pending-verify.stale` (observability only, not escalated).
     - HMAC fails on matching epoch → `pending-verify.tampered` (escalated).
     - Valid entries drive verify polling (§verify).
   - **Compacts `pending-verify.jsonl`** to entries whose `deadline` is in the future and unverified. Bounded by concurrency-of-one, so realistically ≤ 1 open entry. Compaction is atomic write-rename.
   - Replays `degradations-queue.jsonl` through the remediator. Entries older than their configured TTL (default 5 min) are dropped with an observability event, not re-processed. After replay, the queue is truncated.
4. Deadline expiry without verify success ⇒ attempt marked `verification-failed`, escalated, pending record cleared.

### Audit log storage & rotation

- Path: `.instar/remediation/attempts-<machineId>.jsonl`. Per-machine suffix avoids git-sync merge conflicts and follows the existing `shared-state.jsonl*` pattern.
- Format: one JSON object per line, `JSON.stringify` with no pretty-printing. Each record ≤ 8KB; oversize fields truncated with a `[truncated]` marker. Newlines and ANSI in any string field are stripped before write.
- Rotation: at 10MB or 10,000 lines, rotate to `attempts-<machineId>.jsonl.<epoch>`. Retain 4 generations and 90 days, whichever is shorter.
- Retention sweep runs once per day at remediator init plus a scheduled job entry.
- Git sync: all `attempts-*.jsonl*` files sync as read-only history; the dashboard unions them.
- Backup set: `attempts-*.jsonl*` are INCLUDED in `BackupManager.DEFAULT_CONFIG.includeFiles`. `remediation.lock`, `~/.instar/machine-locks/*.lock`, `intent.json`, `pending-verify.jsonl`, `.instar/state/restart-requested.json` (already excluded), `degradations-queue.jsonl`, and `~/.instar/agent.key` are EXPLICITLY EXCLUDED (ephemeral, deadline-bearing, machine-local, or security-sensitive).
- Dashboard reads the last 50 records **preferentially from** the per-machine sidecar `attempts-recent-<machineId>.json` (a 50-entry circular buffer). Full-file tail read is only used when the sidecar is missing or stale.
- **Sidecar consistency.** Audit writes sequence: (1) append fsync'd to main `attempts-<machineId>.jsonl`; (2) rewrite sidecar via atomic write-rename. On boot, the sidecar is rebuilt from the tail of the main file — it is a cache, never source of truth.
- **Dashboard union bound.** Dashboard union-read is capped at the 5 most-recently-modified `attempts-*.jsonl*` files. Older machine histories are surfaced as "historical machines: K" with an explicit "load older" action; the default view never holds more than 5 file handles.
- The `.instar/remediation/` directory is explicitly NOT watched by `DegradationReporter`, filesystem notifiers, or any other signal source (asserted by a contract test). Audit writes cannot trigger new degradation events.

### Window-cap accounting

- `maxAttemptsPerWindow` counts **failed** attempts (`execution-failed`, `execution-failed-partial`, `verification-failed`) within `windowMs`.
- A successful attempt for a runbook clears the failure counter for that runbook.
- **Churn detector (rolling-count, not fixed-pattern).** A runbook that accumulates ≥ 3 outcome-flip transitions (any success↔failure boundary) within any rolling 24-hour window triggers an escalation `churn-detected: underlying-system-flapping`, disables the runbook for 24h, and files a feedback bug. Rolling-count closes the fixed-pattern gaming vector flagged in iter 2.
- Window state is reconstructed at remediator init by scanning the trailing N entries of the audit log (bounded: max 1000 entries or 30 days, whichever is smaller).

### Guardrails (consolidated)

1. **Per-runbook failure cap** (above): default 1 failure per 24h; success resets; churn detector guards flap.
2. **Global concurrency of one** at the agent level: serialized via `.instar/remediation/remediation.lock` using `flock` or `O_EXCL`, with `{pid, bootId, attemptId, startedAt, expectedRuntimeMs}`. Stale reclaim only at server boot, gated on both `pid`-not-running AND `bootId`-mismatch to resist PID reuse.
3. **Machine-level locks** for `blastRadius: "machine"` runbooks (above).
4. **Dry-run mode.** `remediator.dryRun: true` (default on first release) matches and logs the plan; `execute()` is not called. A later release flips the default after ≥ 1 week of real-world dry-run traces.
5. **Explicit opt-in per blast-radius.** `remediator.allow.stateDirectory: false` default. `local-process`, `shadow-install`, `machine` radii are allowed by default when `dryRun: false`. (`external` is removed from day-one scope — see Runbook type note.) Any change to these flags is logged to the audit file as a separate `config-flip` event.
6. **Storm coalescing.** Coalesce key is the tuple `(runbookId, subsystem, errorCode, nativeError.moduleName)`, not just `runbookId`. If an attempt is in-flight or recently succeeded for the same tuple, matching events are recorded as `covered-by-attempt:<attemptId>` and do NOT escalate. Events whose tuple differs but still match the same runbook (errorCode collision) are logged as `coalesce-suspect` and DO escalate via the existing alert path — this closes the iter-2 finding that different root causes could be silently absorbed. Ten simultaneous identical-tuple ABI-mismatch events produce one remediation and one audit entry per event, not ten alerts.
7. **Kill switch.** `remediator.enabled: false` stops *new* attempts; in-flight attempts run to completion (including `verify`). Aborting mid-rebuild is more dangerous than completing; documented in `/capabilities`. A separate `remediator.panicStop: true` flag is documented as potentially-state-corrupting and aborts `execute()` at the next await point.
8. **Per-runbook disable.** `remediator.disabledRunbooks: ["runbook-id"]` surgically disables one runbook without flipping the whole system.
9. **Config integrity.**
   - Config is loaded once at boot and on explicit `fs.watch` events with mtime-debouncing (200ms). No syscall on the hot path.
   - **`config-flip` whitelist.** Only flips whose path is on a whitelist — `remediator.enabled`, `remediator.dryRun`, `remediator.allow.stateDirectory`, `remediator.allow.external`, `remediator.disabledRunbooks[*]`, `remediator.panicStop` — are serialized with before/after values. Flips outside this whitelist are logged as `config-flip.path-rejected` with the path only, not the value (prevents accidental secret serialization when a neighboring config field changes). Even whitelisted before/after values pass through the Redactor as defense-in-depth.
   - In-flight attempts observe the config snapshot they started with; flips take effect for the next attempt.
   - Dashboard toggle for these fields requires bearer auth + `X-Instar-Request: 1`. Trust levels use the `AutonomyProfileLevel` taxonomy from `src/core/types.ts` (`cautious | supervised | collaborative | autonomous`). Defaults: `supervised` can toggle `dryRun` and `disabledRunbooks`; flipping `enabled: false` is always allowed (kill switch); flipping `enabled: true` or expanding `allow` requires `collaborative` trust.
   - **Self-trust exclusion (allowlist, not deny-list).** The trust-elevation signal path used by the remediator's config-toggle gate is NOT `AutonomyGate` (which operates on inter-agent `MessageEnvelope`s and is not subscribed to internal events). This spec introduces a thin new module `src/remediation/TrustElevationSource.ts` that the toggle handler consults to decide if the caller meets the required trust floor. The module admits **only** events explicitly tagged `origin: "user"` or `origin: "dashboard"` (with a verified bearer-session reference). Untagged events, `origin: "self"` events, and events tagged anything else are excluded. Allowlist semantics — absence of tag is NOT trusted. A lint rule (`scripts/validate-telemetry-origin.ts`, run on prebuild) asserts every remediator-emitted telemetry event carries an `origin` field; untagged events fail CI. Contract test: a crafted event without origin does not elevate trust.
10. **Rate-limited runbook authoring.** Runbooks are code, reviewed via the normal `/instar-dev` path. No dynamic runbook loading from runtime sources. Registry-load-time validation (above) catches smuggled dynamism.
11. **Feedback-manager interaction (new APIs introduced by this spec).** `FeedbackManager` today has no degradation-awareness; this spec introduces two idempotent methods:

    ```ts
    FeedbackManager.resolveDegradation(lookupKey: { subsystem: string; errorCode: string }, resolution: { outcome: "remediated"; attemptId: string; auditRef: string; resolvedAt: string }): Promise<void>
    FeedbackManager.updateDegradation(lookupKey: { subsystem: string; errorCode: string }, update: { attemptId: string; outcome: "verification-failed" | "execution-failed" | "execution-failed-partial"; auditRef: string; attempts: number }): Promise<void>
    ```

    The `lookupKey` is `{subsystem, errorCode}` (not a freshly-minted bugId) so calls are naturally idempotent across duplicate events. An internal 10-minute de-dup window suppresses repeat `updateDegradation` calls for the same key+outcome. If the originally-filed bug has already been closed manually, `resolveDegradation` is a no-op; both methods fail closed (silent pass) if the feedback webhook is unconfigured.

    - On remediation `success`: `resolveDegradation` with a link to the audit entry.
    - On `verification-failed` or `execution-failed`: `updateDegradation` with the attempt summary.
    - On `no-matching-runbook`, `churn-detected`, or coalesced events: no feedback interaction (reporter's original bug stands).

    Test-strategy bullet added for both methods.

### Lifecycle

```
DegradationReporter.report(rawEvent)
  ├→ normalize (redact, extract errorCode/nativeError)
  ├→ persist to .instar/degradations-queue.jsonl if RestartPending
  ├→ existing alert path (preserved; dryRun does NOT suppress it)
  └→ Remediator.onDegradation(normalizedEvent)
       ├→ enabled? → no → noop (existing alert path handles it)
       ├→ prefilter dispatch → candidate runbooks
       ├→ match (with per-runbook error isolation) → pick highest-priority match
       │    ├→ none → escalate (existing alert path)
       │    └→ match → continue
       ├→ in disabledRunbooks? → yes → escalate
       ├→ storm-coalesce: R currently running or recent-success? → yes → log "covered-by" and return
       ├→ failure-cap: failed attempts in windowMs ≥ maxAttemptsPerWindow? → yes → escalate
       ├→ platform supported? → no → escalate as "runbook-platform-mismatch"
       ├→ acquire agent lock → fail → queue (one retry in 30s with jitter) → escalate
       ├→ acquire machine lock if required → fail → log "machine-lock-held" → NO escalation
       ├→ preconditions → fail → release locks, escalate with reason
       ├→ dryRun? → yes → log plan, release locks, noop
       ├→ execute (with intent.json markers) → fail → release locks, escalate, move intent to dead-letter
       ├→ verify (possibly post-restart) → fail → escalate
       └→ success → audit log, close feedback bug, release locks, silent
```

### Rollback artifact integrity

`rollback/<attemptId>/` contains `symlink-target.txt` and `node_modules-manifest.json` (24h TTL). To prevent an attacker-redirected rollback:

- `symlink-target.txt` carries BOTH the path AND a SHA-256 of the target binary at snapshot time.
- The explicit rollback tool (`instar remediation rollback <attemptId>`) re-hashes the target path and refuses to swap if the hash doesn't match OR if the target isn't on the shipped "known-good node versions" allowlist.
- The allowlist ships as `src/data/known-node-targets.json` (under `src/data/`, already in the npm `files` array — verified by a `post-build-smoke.ts` assertion that the file is present in the published tarball). Day-one integrity control: a constant `KNOWN_TARGETS_DIGEST` in `src/remediation/Remediator.ts` holds the SHA-256 of the committed allowlist. On load, the runtime re-hashes the loaded file and refuses to proceed if the digest doesn't match. A supply-chain or local write to the allowlist ALONE does not subvert rollback; an attacker would have to compromise both the data file and the source constant (separate review paths under `/instar-dev`). Signed release artifacts are a future phase; the digest pin is the day-one compensating control.
- The manifest file is newline/ANSI/length-sanitized at write time, identical to audit records.
- Rollback tool logs its decision to the audit log as `rollback.invoked`, regardless of outcome.

### errorCode extraction — ownership & governance

The structured-match safety story depends entirely on `errorCode` being correctly extracted from raw errors. This is a single point of failure if undocumented.

- **Owner**: `src/monitoring/ErrorCodeExtractor.ts` (new module), owned by the same team that owns `DegradationReporter`. The reporter calls the extractor before producing a `NormalizedDegradationEvent`.
- **Enum**: `ErrorCode` is an exported TypeScript union in `src/monitoring/types.ts`. Adding a new value is a `/instar-dev` commit; removing or renaming a value is a BREAKING change gated by the normal spec-convergence path.
- **Extraction rules**: each enum value has a corresponding rule function in the extractor (regex + structural checks against the original error shape). Rules are pure functions; rule ordering is deterministic and documented.
- **Version stamp**: every `NormalizedDegradationEvent` carries `extractorVersion: number` (starts at 1, bumped on every extractor rule change). Runbooks may declare `minExtractorVersion`; registry load refuses to load a runbook whose `minExtractorVersion` exceeds the running extractor.
- **Drift test**: a contract-test corpus (`tests/corpus/errorcode-extraction/`) holds real captured errors from prior incidents with expected `errorCode` outputs. Every extractor change runs the corpus and refuses to ship if expected outputs drift.
- **Unknown errors**: when the extractor cannot classify a reason to any enum value, it returns `errorCode: null` and the normalized event has `unclassified: true`. Matchers in the prefilter index are never invoked for unclassified events — remediation is impossible without a signature, and the existing alert path handles the escalation.

### Runbook lifecycle & deprecation

Runbooks are code, but they're also runtime authority. A runbook that worked in 2026 may be subtly wrong in 2027 (environment drift, tool changes, upstream fixes). Lifecycle policy:

1. **Active**: default state. Loaded, matched, executed.
2. **Quarantined**: auto-transitioned after `churn-detected` or `verification-failed` ≥ 2× in a rolling 7 days. Quarantined runbooks remain loaded and matchable but always run in dry-run regardless of config, and all matches escalate. Clears after 30 days of no events OR manual clearance via `instar remediation unquarantine <runbookId>`.
3. **Deprecated**: explicit in the runbook source (`deprecated: { since: "YYYY-MM-DD", reason: string, removeAfter: "YYYY-MM-DD" }`). Deprecated runbooks warn on load, still execute if not past `removeAfter`, are skipped with an escalation after `removeAfter`.
4. **Removed**: runbook file deleted in a `/instar-dev` commit. The removal must carry a migration note if any agents could be mid-pending-verify for that runbook — pending-verify records pointing to a removed runbook are marked `pending-verify.orphaned`, escalated, and cleared on next boot.

Quarantine and deprecation states survive restarts via `.instar/remediation/runbook-state.json` (per-agent; not git-synced).

### Registry-validation failure mode (graceful)

Registry-load-time validation errors — I/O at import, missing `verify`, I/O in `match()`, prefilter shape violations, etc. — do NOT hard-fail boot. The offending runbook is **disabled-by-validation**, logged to `registry.validation-failed` with the file path and reason, excluded from the loaded set, and surfaced in `/remediation/status`. Boot continues with the remaining valid runbooks. This prevents a field-installation with a version-skewed runbook from killing the agent.

**Duplicate `priority` disables BOTH.** On priority collision, BOTH runbooks are disabled-by-validation and a `registry.priority-collision` audit + escalation is emitted, naming both file paths and priorities. Loading either could be exploited by an attacker who backdates a malicious runbook (via `utimes`) to force the legitimate runbook to be disabled as "newer." Disabling both is the only outcome that cannot be manipulated by mtime. A human resolves the collision by picking which to keep; the other is removed or repriorited in a subsequent `/instar-dev` commit.

### What the remediator will NOT do (explicit non-goals)

- Write to user project files outside `.instar/`.
- Modify git state of any repository.
- Call external APIs or send outbound network requests during `execute()` (a test-harness interceptor asserts no outbound `fetch`/`undici`/`http(s)` calls during `execute()`). `verify()` may call the local `/health` endpoint.
- Install or upgrade packages from the internet. `npm rebuild` is local-only; `npm install` is out of scope for any day-one runbook.
- Author its own runbooks at runtime from LLM output. Every runbook ships as code through `/instar-dev`.
- Modify `.instar/config.json`, `.instar/jobs.json`, or any other state file a human edits.
- Persist or transmit any data from `reason.full` or `reason.firstLine` without the upstream redactor having run.

## Observability

- `GET /remediation/status` (bearer-auth required) → `{ enabled, dryRun, allow, activeAttempts, disabledRunbooks, disabledByCircuitBreaker, lastAttempt, windowCapsByRunbook }`.
- `GET /remediation/attempts?limit=50` (bearer-auth required) → recent audit records, with `event.reason.full` replaced by `[redacted: N chars]` for the tunnel-exposed variant unless caller has `collaborative` trust.
- `POST /remediation/toggle` (bearer-auth + `X-Instar-Request: 1`, trust-gated per §Guardrail 9) — dashboard-backed control surface.
- Dashboard tab **Remediation**: live status, recent attempts, per-runbook window state, controls matching the toggle endpoint. Renders `reason.full` as plain text (never HTML/markdown).
- `/capabilities` exposes:
  ```
  { name: "remediator",
    enabled, dryRun, allow,
    runbooks: [{ id, description, priority, blastRadius, reversibility, platforms, dryRun, disabled, circuitBroken }],
    windowState: { [runbookId]: { failuresInWindow, lastAttemptAt, lastOutcome } },
    lastAttempt }
  ```
- Telemetry events (redacted, structured): `remediation.attempt.started`, `remediation.attempt.succeeded`, `remediation.attempt.failed`, `remediation.storm.coalesced`, `remediation.runbook.match-error`, `remediation.runbook.circuit-breaker-tripped`, `remediation.config-flip`.

## Upgrade invariants

The N → N+1 upgrade that introduces the remediator MUST NOT change any user-visible behavior:

1. **First-boot default (not migration-dependent).** The remediator treats ANY missing `remediator.*` config as `{ enabled: true, dryRun: true, allow: { stateDirectory: false, external: false }, disabledRunbooks: [], panicStop: false }`. This same defaulting runs on every init, not just first boot — so a half-run `PostUpdateMigrator` that crashed before seeding config leaves the system in the intended-safe default rather than an undefined state.
2. In dry-run, the existing `DegradationReporter` alert path is NOT suppressed. Telegram/Slack alerts continue exactly as before.
3. `PostUpdateMigrator` step `remediator-init` uses a new primitive introduced by this spec, `runAtomicStep(name, steps[], cleanup[])`, added to `src/core/PostUpdateMigrator.ts`. The primitive executes `steps` in order; on any throw it invokes matching `cleanup` entries in reverse order and leaves the migration unrecorded. The `remediator-init` step calls `runAtomicStep`:
   - step: create `.instar/remediation/` recursively / cleanup: `rm -rf` if this step created it.
   - step: ensure `~/.instar/machine-locks/` + `~/.instar/agent.key` (0600, generated per-machine if missing) / cleanup: remove agent.key only if we created it (never touch pre-existing).
   - step: acquire config-write lock, merge `remediator` section into config, release lock / cleanup: restore prior config snapshot.
   - step: record migration as applied.

   If any step throws, the remaining steps don't run, cleanups for completed steps fire, and the migration is NOT recorded so the next boot retries. The remediator's own init is also idempotent w.r.t. directory/key creation (safe against a migrator that never runs — e.g., corrupted migrations registry). A contract test asserts a mid-step throw leaves no partial config/dir/key state and the migration is retried on next boot.
4. **Partial-upgrade handling.** A partially-upgraded agent whose lifeline is still on the prior build and whose server is on the new build must not deadlock. The remediator checks the supervisor's handshake version on first-restart-request; if the supervisor is too old, the remediator marks the attempt `precondition-failed: supervisor-version-too-old` and escalates. No new protocol assumed-to-exist is required from the old supervisor.
5. Upgrade-listener phase-transition note: this spec introduces a new helper `PostUpdateMigrator.announceOnce(key, text)` that posts a one-line message through the existing attention-channel sender (the same channel `DegradationReporter` uses for alerts) and records the `key` in migrations state so the announcement fires once per key across reboots. The phase-transition note uses keys `remediator.phase-1`, `remediator.phase-2`, `remediator.phase-3`. If the attention-channel path is unavailable at announcement time, the text is appended to `attempts-<machineId>.jsonl` as `phase-transition.announced-failed`, the key is marked pending-retry (next init re-attempts), and the message surfaces as a persistent dashboard banner until delivered. `announceOnce` is explicitly new code owned by this spec, not an assumed-to-exist primitive; its signature, caller, and contract test are listed in §Decision surface.

## Rollout plan

1. **Phase 1 — scaffold + dry-run only.** Remediator wired into `DegradationReporter`, `node-abi-mismatch` runbook registered, `dryRun: true` default. Every current degradation causes a dry-run log entry only. Collect ≥ 1 week of traces.
2. **Phase 2 — enable for `local-process`, `shadow-install`, `machine` blast radii.** Dry-run default flipped to false for these three. ABI-mismatch runbook goes live. Promotion requires a FRESH dry-run trace within 48 hours of the flip, not aggregate historical traces.
3. **Phase 3 — add runbooks one-by-one.** Each new runbook requires a `/instar-dev` build, a side-effects review artifact, and ≥ 1 week of dry-run traces before going live. `state-directory` and `external` blast radii require a separate spec-convergence round because the authority boundary is meaningfully different.

Phase transitions are explicit version bumps.

## Rollback ladder

1. **First line** — kill switch: `remediator.enabled: false` via dashboard toggle (instant, in-flight attempts complete).
2. **Second line** — per-runbook disable: `remediator.disabledRunbooks: [...]` (instant, other runbooks continue).
3. **Third line** — panic stop: `remediator.panicStop: true` (aborts in-flight at next await; documented as potentially state-corrupting).
4. **Fourth line** — instar downgrade via `npx instar@<prev>`. The audit log schema is append-only JSONL and survives downgrades.
5. **Fifth line (nuclear)** — full uninstall: drop `src/remediation/`, remove the subscription hook from `DegradationReporter`, delete the dashboard tab. Audit files remain for forensic review.

## Test strategy

- **Unit tests per runbook**: 100% branch coverage. Match function (including structured-field requirement and live-observation gate), precondition logic (each failure mode), execute mocked, verify mocked.
- **Matcher-purity tests**: each runbook's `match()` is invoked with a stubbed event under a test harness that asserts no `fs`, no `net`, no `require` calls, and < 5ms timing.
- **Integration test (ABI-mismatch)**: in a tmp agent state dir (with `TMPDIR` and `HOME` overridden so `~/.instar/machine-locks/` and `~/.instar/agent.key` are also tmp-scoped), spin up a shadow install with a deliberately mis-pinned node symlink; assert detect → execute → verify → audit flow. Matrix `node-version: [20.x, 22.x, 24.x]` on GHA Linux (matches current `package.json` engines and existing CI matrix), extending the unit-test matrix by one LTS. The remediation integration test is a separate job, not a shard. The test explicitly verifies that no symlink outside its tmpdir was mutated by a post-test assertion (prevents CI-runner leak). On platforms where the native-module prebuild hides the ABI symptom (Linux glibc + prebuilt `better-sqlite3`), the test records a `skipped-reason: prebuild-hides-abi` artifact rather than silently passing. Odd-major node (e.g. 25.x) is NOT in the matrix — adding it requires updating `engines.node` and verifying `better-sqlite3` prebuild availability, both out of scope for this spec.
- **Contract tests**:
  - `DegradationReporter` → `Remediator` wiring: single-consumer async callback (`reporter.setRemediator(r)`), exactly one call per event, no `EventEmitter.on` allowed (lint rule + test).
  - Redaction: every field of every `NormalizedDegradationEvent` passes through the redactor; no bearer-token/absolute-path/email/IP-address pattern survives.
  - Backup inclusion/exclusion: integration test asserts `attempts-*.jsonl*` backed up, `lock`/`intent.json`/`pending-verify.jsonl`/`restart-intent.json` excluded.
  - Audit log is not watched: a filesystem-notifier test asserts writes to `.instar/remediation/` do not produce new degradation events.
- **Chaos tests**:
  - Execute() crashes the process ⇒ next boot marks attempt `execution-failed-partial`, escalates, moves intent to dead-letter, does not retry.
  - Pending-verify with tampered HMAC ⇒ rejected, escalated, never runs verify.
  - Pending-verify with mismatched `keyEpoch` (simulated restore scenario) ⇒ `pending-verify.stale`, NOT escalated.
  - Forged `restart-requested.json` with `source: "remediator"` but invalid HMAC ⇒ logged as `restart-intent.forged`, supervisor does NOT honor as planned.
  - Ten same-tuple degradations fired concurrently ⇒ exactly one execute, others coalesced.
  - Ten different-subsystem degradations routing to the same runbook via errorCode collision ⇒ each escalates `coalesce-suspect`, only first-tuple executes.
  - Config flip `enabled: false` during execute ⇒ attempt completes, next attempt suppressed.
  - Config flip `dryRun: true` during execute ⇒ attempt completes with execute-mode, next attempt dry-runs.
  - Machine lock held by another live agent ⇒ local runbook returns `precondition-failed: machine-lock-held`, no escalation.
  - Machine lock held by stale record (pid-dead, bootId-mismatch, heartbeat > 3× expectedRuntimeMs) ⇒ reclaimed with audit log, remediation proceeds.
  - PostUpdateMigrator sub-step throws mid-init ⇒ no partial config seed persists, migration unrecorded, next boot retries cleanly.
  - Remediator successes do NOT cause trust-elevation (contract test asserts `origin: "self"` events filtered by `AutonomyGate`).
  - Redactor idempotency + adversarial-string fuzz: corpus of nested tokens, pattern-marker mimics, and overlapping patterns — every output satisfies `redact(redact(x)) === redact(x)` and contains no secret-shaped substring.
  - Rollback tool refuses to swap a symlink target whose SHA-256 mismatches the manifest or isn't in `data/known-node-targets.json`.
  - Duplicate-priority runbook at registry load ⇒ BOTH runbooks disabled-by-validation, collision escalated, boot continues with remaining valid runbooks.
  - Forged `restart-requested.json` WITHOUT `source: "remediator"` but with `plannedRestart: true` and no HMAC ⇒ NEW supervisor rejects as `restart-intent.forged`; OLD supervisor (partial-upgrade window) honors by existing semantics (documented limitation).
  - `supervisor-handshake.json` absent or version below `MIN_SUPERVISOR_VERSION` ⇒ remediator refuses planned-restart, attempt marked `precondition-failed: supervisor-version-too-old-or-absent`, escalated.
  - TrustElevationSource admits only `origin: "user"` / `origin: "dashboard"`; untagged or `origin: "self"` events ⇒ no elevation (contract test).
  - `KNOWN_TARGETS_DIGEST` mismatch on load ⇒ rollback tool refuses.
  - Execute() crash at `step: "snapshot"` (pre-mutation) ⇒ attempt marked `execution-failed-pre-mutation`, one retry allowed; second same-step crash ⇒ freeze.
  - Per-runbook freeze auto-clears after 3 successful unrelated attempts OR 24h elapsed.
  - keyEpoch rotation requires bearer + X-Instar-Request + collaborative trust + 1-per-hour rate limit (contract test).
  - Redactor applies defense-in-depth to whitelisted `config-flip` before/after values (contract test).
  - Queue overflow: 1001st event during RestartPending ⇒ dropped, counter increments, on boot single aggregate escalation issued.
- **Registry-validation tests**: runbook with I/O at import crashes the registry; runbook with duplicate priority crashes; runbook with `verify` as a no-op stub crashes.

## Open questions for review

None blocking. Previous open questions resolved in the spec body:

- Pending-verify in multi-agent / multi-machine context → per-agent state dir + HMAC + per-machine audit file.
- Supervisor restart-policy interaction → `restart-intent.json` planned-restart marker.
- Dry-run trace auto-promotion → explicitly no (promotion is a code/config change, with a fresh-trace requirement).
- `reason` field as prompt-injection surface → structured matcher contract + live-observation gate + redactor boundary.
- Rollback artifact format → `.instar/remediation/rollback/<attemptId>/{symlink-target.txt,node_modules-manifest.json}` with 24h TTL.

## End-to-end latency budget for `DegradationReporter.report()`

- Non-RestartPending path: ≤ 25ms p99 (normalize + redact + dispatch + coalesce-check + fire-and-forget enqueue to Remediator).
- RestartPending path: ≤ 75ms p99 (adds one fsync'd append to `degradations-queue.jsonl`).
- `Remediator.onDegradation` is invoked via microtask (`queueMicrotask`), never synchronously from `report()`. Match/precondition/execute cost is fully off the reporter's caller path.
- Redactor operates on capped strings (≤ 8KB full, ≤ 512 firstLine). Redactor patterns have unit-tested ReDoS resistance (linear-time regex constructs only — no nested quantifiers).
- Contract test asserts the p99 budget with a synthetic workload.

## Verify budget coordination with supervisor backoff

If the supervisor is in `CrashLoopPauser` backoff (e.g., 30–60s), `/health?fast=1` polling during backoff burns budget waiting on a dead port. Two-part fix:

1. **Planned-restart bypasses backoff.** The supervisor treats a `source: "remediator"` + valid-HMAC planned restart as zero-backoff (backoff counter not incremented AND not consulted). This is an additive behavior on the existing `restart-requested.json` path.
2. **Remediator verify sequencing.** Poll starts with a 10s initial delay when the restart was remediator-triggered, then 2s→10s backoff, for up to 36 polls (≈ 6 minutes wall-clock). Budget covers crash-loop worst-case even if (1) fails to ship or is disabled by a future config.

## Decision surface touched

- `src/monitoring/DegradationReporter.ts` — add `setRemediator()` single-consumer async callback, event normalization, redactor integration, `RestartPending` flag and queue persistence.
- `src/monitoring/Redactor.ts` (new) — pattern-based redaction of reason strings, with ReDoS-resistant patterns and idempotency/fuzz tests.
- `src/monitoring/ErrorCodeExtractor.ts` (new) — rule-based extraction of `errorCode` enum values from raw errors, with version stamp, drift tests, and a captured-error corpus at `tests/corpus/errorcode-extraction/`.
- `src/remediation/` (new) — `Remediator.ts`, `RunbookRegistry.ts`, `MachineLock.ts`, `IntentJournal.ts`, runbook implementations under `src/remediation/runbooks/`. `MachineLock.ts` owns creation of `~/.instar/machine-locks/` and `~/.instar/agent.key` (0700/0600).
- `src/server.ts` — wiring; intent/pending-verify/queue replay on boot.
- `src/core/FeedbackManager.ts` — NEW: introduce `resolveDegradation` / `updateDegradation` idempotent entry points keyed on `{subsystem, errorCode}`, with 10-min de-dup window and fail-closed-silent when webhook unconfigured. Signatures + tests listed in Guardrails §11.
- `src/core/PostUpdateMigrator.ts` — NEW: introduce `runAtomicStep(name, steps[], cleanup[])` primitive; NEW: introduce `announceOnce(key, text)` helper. Add `remediator-init` migration step using `runAtomicStep`. Both primitives are consumed by this spec's migrator step AND available for future migrations.
- `src/lifeline/ServerSupervisor.ts` — NEW: write `.instar/state/supervisor-handshake.json` on supervisor start. Extend `restart-requested.json` consumer to verify HMAC on any `plannedRestart: true` record (new-supervisor path); update AutoUpdater / ForegroundRestartWatcher in the same phase to include HMACs for legacy planned restarts. Add zero-backoff path for validated `source: "remediator"` records.
- `src/remediation/TrustElevationSource.ts` (new) — thin allowlist admitting only `origin: "user"` or `origin: "dashboard"` events with verified bearer-session binding. Consumed by the toggle-handler gate. Supersedes the iter-2 assumption that `AutonomyGate` would do this (`AutonomyGate` operates on inter-agent MessageEnvelopes and has no internal-event surface).
- Capabilities exposure (per `/capabilities` handler) — add `remediator` entry as specified.
- Dashboard — new `Remediation` tab + toggle endpoint behind bearer auth.
- `.instar/config.json` — nested `remediator` section, seeded by `PostUpdateMigrator` and defaulted at init.
- `.instar/remediation/` (new state dir) — `attempts-<machineId>.jsonl`, `attempts-recent-<machineId>.json`, `remediation.lock`, `intent.json`, `pending-verify.jsonl`, `degradations-queue.jsonl`, `rollback/<attemptId>/`, `dead-letter/<attemptId>.json`.
- `.instar/state/restart-requested.json` — extended schema; owned by existing supervisor code, co-written by remediator.
- `~/.instar/machine-locks/` (new) — cross-agent coordination.
- `~/.instar/agent.key` (new) — per-machine HMAC seed, 0600, not synced.
- `.gitignore` — qualified paths: `.instar/remediation/remediation.lock`, `.instar/remediation/intent.json`, `.instar/remediation/pending-verify.jsonl`, `.instar/remediation/degradations-queue.jsonl`, `.instar/remediation/rollback/`, `.instar/remediation/dead-letter/`. NO unqualified basenames (which could accidentally match user-project files).
- `scripts/validate-runbooks.ts` (new) — build-time lint for runbook purity + placement. Wired as `prebuild` script in `package.json`.
- `scripts/validate-telemetry-origin.ts` (new) — build-time lint asserting every remediator-emitted telemetry call carries an `origin` field. Wired into `prebuild`.
- `scripts/post-build-smoke.ts` (new) — asserts `dist/remediation/runbooks/*.js` matches the source runbook set AND `dist/data/known-node-targets.json` is present.
- `src/data/known-node-targets.json` (new, under existing `src/data/` npm-published path) — allowlist of node binary SHA-256 targets for rollback integrity check. Corresponding `KNOWN_TARGETS_DIGEST` constant in `src/remediation/Remediator.ts` pins the allowlist SHA-256; load-time mismatch refuses rollback. `post-build-smoke.ts` asserts the file is present in the published tarball.
- CI: extend unit-test matrix to `[20, 22, 24]` AND add a separate integration-test job running the ABI-mismatch flow with appropriate skip-reason handling.
