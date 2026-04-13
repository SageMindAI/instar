# System Reviewer Spec (`instar review`)

> Instar has 70+ modules and growing. The existing monitoring tells us if the engine is running. `instar review` tells us if the car can drive.
>
> **Review Status**: Round 1 complete (2026-03-01). 8 reviewers, avg 6.9/10. P0 fixes applied below.

## The Problem

Instar's monitoring infrastructure is **operationally** comprehensive:
- `HealthChecker` aggregates component health (tmux, sessions, memory, disk)
- `CoherenceMonitor` checks config drift and state durability
- `DegradationReporter` makes fallback activations loud
- `CommitmentTracker` enforces behavioral promises
- `SessionWatchdog` auto-remediates stuck sessions
- `OrphanProcessReaper` cleans up zombie processes
- `QuotaTracker` monitors API usage

But none of these answer the question: **"Is this feature actually working end-to-end?"**

A system can be healthy (all processes alive, memory fine, no orphans) while being broken (semantic memory returning stale results, job scheduler silently skipping jobs, Telegram messages queuing but never delivering). The monitoring checks the plumbing. Nothing checks the water.

### Real Failure Modes This Would Catch

1. **Semantic memory silently degraded** — better-sqlite3 failed to load, fallback activated, but the degradation reporter itself had a bug and didn't fire. Agents ran for hours with no knowledge graph.

2. **Job scheduler running but ineffective** — Jobs were executing but the session they spawned was immediately hitting quota limits. The scheduler reported "job started" (healthy) but the job accomplished nothing.

3. **Telegram adapter receiving but not sending** — Long poll was active, messages were being received, but outgoing messages were queuing due to a rate limit change. The health check said "connected" because the connection was alive.

4. **Relationship enrichment silently stopped** — The enrichment pipeline depended on an intelligence provider that was null. No error, no degradation event — the code path was simply never reached because the conditional checked `if (this.intelligence)` and silently skipped.

5. **Commitment tracker not injecting into sessions** — The tracker was monitoring commitments, but the hook that injected them into session context had a path resolution bug. Commitments existed but were invisible to the agent.

## Design Principles

### 1. Probes, Not Tests

The System Reviewer runs **probes** — lightweight, non-destructive operations that verify a feature's end-to-end path works. This is distinct from:

- **Unit tests** — Verify component logic in isolation (build-time)
- **Integration tests** — Verify API routes and wiring (build-time)
- **Health checks** — Verify component liveness (runtime)
- **Probes** — Verify feature functionality end-to-end (runtime) ← THIS

A probe for semantic memory doesn't just check "is the database file present?" (health check) or "does the store method work with a mock?" (unit test). It writes a real entity, retrieves it, searches for it, and verifies the result. Then it cleans up after itself.

### 2. Rich Diagnostics, Not Pass/Fail

When a probe fails, the report must include enough context for an agent or human to act:

```typescript
interface ProbeResult {
  /** Probe identifier */
  probeId: string;
  /** Human-readable name */
  name: string;
  /** Which tier this probe belongs to */
  tier: 1 | 2 | 3 | 4 | 5;
  /** Pass or fail */
  passed: boolean;
  /** What was tested */
  description: string;
  /** How long the probe took (ms) */
  durationMs: number;
  /** On failure: what went wrong */
  error?: string;
  /** On failure: the full error stack */
  stack?: string;
  /** On failure: what was expected vs. what happened */
  expected?: string;
  actual?: string;
  /** On failure: suggested remediation */
  remediation?: string;
  /** Probe-specific diagnostic data */
  diagnostics?: Record<string, unknown>;
}
```

### 3. Self-Cleaning

Every probe that creates test data must clean up after itself. A probe that writes a test entity to semantic memory must delete it. A probe that creates a test file must remove it. The System Reviewer must never leave artifacts that pollute the agent's real state.

Pattern: wrap every probe in try/finally with cleanup in the finally block.

**Startup sweep**: Because `try/finally` does not survive SIGKILL or OOM-kill, the SystemReviewer runs a startup sweep on initialization that deletes ALL `__probe_*` artifacts from semantic memory, episodic memory, relationships, and any other state stores. This ensures orphaned probe data never accumulates across crashes.

**Probe metadata flag**: All probe-written entities carry a `probe: true` metadata field. The semantic search query layer actively filters entities with this flag, so even if cleanup fails, probe artifacts never appear in agent queries.

### 4. Non-Destructive

Probes must never:
- Delete real data
- Modify real configuration
- Send real messages to users
- Spawn real sessions (expensive, uses quota)
- Trigger real external operations

For features that inherently require these (e.g., "can we send a Telegram message?"), use **dry-run verification** — verify the message would be sent correctly without actually sending it, or send to a dedicated test topic.

### 5. Tiered Execution

Not all probes need to run at the same frequency. Critical probes run often; coordination probes only run when multi-machine is active.

## Architecture

### Module: `SystemReviewer`

```
src/monitoring/SystemReviewer.ts          — Orchestrator
src/monitoring/probes/                    — Probe implementations
  ├── SessionProbe.ts                     — Tier 1
  ├── SchedulerProbe.ts                   — Tier 1
  ├── MessagingProbe.ts                   — Tier 1
  ├── LifelineProbe.ts                    — Tier 1
  ├── SemanticMemoryProbe.ts              — Tier 2
  ├── EpisodicMemoryProbe.ts              — Tier 2
  ├── RelationshipProbe.ts                — Tier 2
  ├── KnowledgeProbe.ts                   — Tier 2
  ├── QuotaProbe.ts                       — Tier 3
  ├── CoherenceGateProbe.ts               — Tier 3
  ├── OrphanReaperProbe.ts                — Tier 3
  ├── SecretRedactionProbe.ts             — Tier 3
  ├── CommitmentProbe.ts                  — Tier 3
  ├── HeartbeatProbe.ts                   — Tier 4
  ├── GitSyncProbe.ts                     — Tier 4
  ├── WorkLedgerProbe.ts                  — Tier 4
  ├── NotificationProbe.ts                — Tier 5
  ├── UpdateCheckerProbe.ts               — Tier 5
  ├── FeedbackProbe.ts                    — Tier 5
  └── SessionSummaryProbe.ts              — Tier 5
```

### Probe Interface

```typescript
interface Probe {
  /** Unique probe identifier (namespaced, e.g., 'instar.session.list') */
  id: string;
  /** Human-readable name */
  name: string;
  /** Criticality tier (1 = most critical) */
  tier: 1 | 2 | 3 | 4 | 5;
  /** Which feature/module this probes */
  feature: string;
  /**
   * Serialization group. Probes in the same group run sequentially
   * (e.g., probes that write to SQLite share a group to avoid lock contention).
   * Probes in different groups (or with no group) run concurrently within a tier.
   */
  serialGroup?: string;
  /**
   * Per-probe timeout override (ms). Falls back to config.probeTimeoutMs.
   * Tier 1 probes should use shorter timeouts (5s) than Tier 3+ (30s).
   */
  timeoutMs?: number;
  /**
   * Whether this probe requires specific infrastructure to be active.
   * Probes with unmet prerequisites are skipped (not failed).
   */
  prerequisites: () => boolean;
  /** Run the probe. Must clean up after itself. */
  run: () => Promise<ProbeResult>;
}
```

### SystemReviewer Orchestrator

```typescript
class SystemReviewer {
  private probes: Probe[] = [];
  private history: ReviewReport[] = [];  // Loaded from JSONL on startup
  private historyFile: string;           // Persisted to .instar/state/review-history.jsonl
  private reviewMutex: boolean = false;  // Prevents concurrent review runs

  constructor(
    private ctx: ServerContext,  // Access to all server components
    private config: SystemReviewerConfig,
  ) {
    // 1. Load history from JSONL file (last N entries per historyLimit)
    // 2. Run startup sweep: delete all __probe_* artifacts from all state stores
    // 3. Register as HealthChecker component
  }

  /** Register a probe */
  register(probe: Probe): void;

  /** Run all probes for a given tier (or all tiers) */
  async review(options?: {
    tiers?: number[],
    probeIds?: string[],  // Run specific probes only
    dryRun?: boolean,     // Report what would run without running
  }): Promise<ReviewReport>;

  /** Get the last N review reports */
  getHistory(limit?: number): ReviewReport[];

  /** Get trend data: is the system getting healthier or degrading? */
  getTrend(): ReviewTrend;
}

interface ReviewReport {
  /** When the review ran */
  timestamp: string;
  /** Overall result */
  status: 'all-clear' | 'degraded' | 'critical';
  /** Probes that ran */
  results: ProbeResult[];
  /** Probes that were skipped (prerequisites not met) */
  skipped: Array<{ probeId: string; reason: string }>;
  /** Aggregate stats */
  stats: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    durationMs: number;
  };
  /** For failed probes: structured summary for feedback submission */
  failureSummary?: string;
}

interface ReviewTrend {
  /** Last N reviews */
  window: number;
  /** Is health score improving, stable, or declining? */
  direction: 'improving' | 'stable' | 'declining';
  /** Probes that are consistently failing (flaky vs. broken) */
  persistentFailures: string[];
  /** Probes that recently started failing */
  newFailures: string[];
  /** Probes that recently recovered */
  recovered: string[];
}
```

### Configuration

```typescript
interface SystemReviewerConfig {
  /** Whether the system reviewer is enabled */
  enabled: boolean;
  /** How often to run a full review (cron expression) */
  schedule: string;  // Default: '0 */6 * * *' (every 6 hours)
  /** Which tiers to include in scheduled runs */
  scheduledTiers: number[];  // Default: [1, 2, 3]
  /** Maximum time for a single probe before it's considered hung (ms) */
  probeTimeoutMs: number;  // Default: 30000 (30 seconds)
  /** Maximum time for a full review run (ms) */
  reviewTimeoutMs: number;  // Default: 300000 (5 minutes)
  /** How many past reports to keep */
  historyLimit: number;  // Default: 50
  /** Whether to auto-submit failures as feedback (requires feedbackConsentGiven) */
  autoSubmitFeedback: boolean;  // Default: false (opt-in, not opt-out)
  /** Whether the operator has explicitly consented to feedback submission */
  feedbackConsentGiven: boolean;  // Default: false — must be set explicitly
  /** Whether to send Telegram alerts for critical failures */
  alertOnCritical: boolean;  // Default: true
  /** Cooldown between repeated alerts for the same probe (ms) */
  alertCooldownMs: number;  // Default: 3600000 (1 hour)
  /** Telegram topic for review alerts (uses agent-attention if not set) */
  alertTopicId?: number;
  /** Probes to skip (by probe ID) */
  disabledProbes: string[];  // Default: []
}
```

## Probe Specifications

### Tier 1 — Core Survival

#### 1.1 SessionProbe

**What it tests**: Can the session management system track, query, and report on sessions?

**Probes**:
- `session-list`: Call `sessionManager.listSessions()` — verify it returns without error and the result is a valid array
- `session-diagnostics`: Call `sessionManager.getDiagnostics()` — verify diagnostics contain expected fields (memory, age, status)
- `session-limits`: Verify `maxSessions` config matches actual enforcement — `sessionManager.canSpawn()` returns consistent result relative to active count
- `session-tmux-alive`: For each active session, verify the tmux session exists via `tmux has-session -t <name>`

**Does NOT**: Spawn a new session (expensive, uses quota). Verifies the management layer, not the spawning capability.

**Prerequisites**: tmux available

**Remediation guidance**:
- `session-list` fails → StateManager may have corrupt sessions.json
- `session-diagnostics` fails → tmux may have crashed, sessions exist in state but not in tmux
- `session-limits` inconsistent → Config may have been hot-reloaded incorrectly
- `session-tmux-alive` fails → Orphan in state file, needs cleanup

#### 1.2 SchedulerProbe

**What it tests**: Is the job scheduler correctly loading, scheduling, and tracking jobs?

**Probes**:
- `scheduler-loaded`: Verify `scheduler.getJobs()` returns the expected job list (matches jobs.json)
- `scheduler-running`: Verify the scheduler's internal cron is active (not paused/stopped)
- `scheduler-history`: Verify job execution history is being recorded — at least one entry in the last 24h (if jobs are defined)
- `scheduler-queue`: Verify the priority queue is functional — `scheduler.getQueueStatus()` returns valid state
- `scheduler-skip-ledger`: Verify skip reasons are being recorded when jobs are skipped

**Does NOT**: Execute a job.

**Prerequisites**: Scheduler is enabled (some setups run without it)

**Remediation guidance**:
- `scheduler-loaded` mismatch → jobs.json may have been edited while scheduler was running; restart needed
- `scheduler-running` stopped → Scheduler may have hit an unhandled exception; check logs
- `scheduler-history` empty → Jobs may all be gated behind prerequisites that are never met
- `scheduler-queue` invalid → Internal state corruption; scheduler restart needed

#### 1.3 MessagingProbe

**What it tests**: Is the Telegram adapter connected and capable of message flow?

**Probes**:
- `telegram-connected`: Verify the adapter reports connected status
- `telegram-polling`: Verify long-poll is active (last poll timestamp within expected window)
- `telegram-send-dry`: Construct a message but verify the send path is wired — check that `sendMessage` method exists and the bot token resolves
- `telegram-message-log`: Verify the JSONL message log is being written — last entry within reasonable window
- `telegram-topic-mapping`: Verify at least one user has a topic assignment

**Does NOT**: Send a real message (unless a dedicated test topic is configured).

**Prerequisites**: Telegram adapter is configured

**Remediation guidance**:
- `telegram-connected` fails → Bot token may be invalid or Telegram API may be down
- `telegram-polling` stale → Long poll may be hung; adapter restart needed
- `telegram-send-dry` fails → Adapter wiring issue; check server construction
- `telegram-message-log` stale → Message logging may be broken; check file permissions
- `telegram-topic-mapping` empty → No users have been onboarded

#### 1.4 LifelineProbe

**What it tests**: Is the lifeline process (crash recovery) alive and functional?

**Probes**:
- `lifeline-process`: Verify the lifeline process is running (check PID file or process list)
- `lifeline-supervisor`: Verify the ServerSupervisor is tracking the main server process
- `lifeline-queue`: Verify the message queue is functional (can enqueue/dequeue a test message, then clean up)

**Prerequisites**: Lifeline is enabled

**Does NOT**: Crash the server to test recovery.

**Remediation guidance**:
- `lifeline-process` missing → Lifeline may not have been started; check launch config
- `lifeline-supervisor` not tracking → PID mismatch; lifeline may be watching wrong process
- `lifeline-queue` broken → Queue file may be corrupted; check file integrity

### Tier 2 — Intelligence

#### 2.1 SemanticMemoryProbe

**What it tests**: Can the knowledge graph store, retrieve, and search entities?

**Serial group**: `sqlite`

**Probes**:
- `semantic-store`: Write a test entity (`__probe_test_entity`) with `probe: true` metadata, verify it returns an ID
- `semantic-retrieve`: Retrieve the test entity by ID, verify content matches
- `semantic-search-fts`: Run `PRAGMA wal_checkpoint(FULL)` first (ensures FTS5 index is synced in WAL mode), then search for the test entity via FTS5, verify it appears in results
- `semantic-search-vector`: If vector search is enabled, search via embedding similarity
- `semantic-cleanup`: Delete the test entity, verify it's gone

**All operations use a `__probe_` prefix** and carry `probe: true` metadata so they're clearly distinguishable from real data and filtered from agent queries.

**FTS5 race condition mitigation**: In SQLite WAL mode, a write committed on one connection may not be visible to FTS5 search until the WAL is checkpointed. All SemanticMemoryProbe operations MUST use a single database connection and call `PRAGMA wal_checkpoint(FULL)` between store and FTS5 search to prevent false failures on healthy systems.

**Prerequisites**: SemanticMemory is initialized

**Remediation guidance**:
- `semantic-store` fails → SQLite database may be locked or corrupted
- `semantic-retrieve` fails → Store succeeded but retrieval broken — index issue
- `semantic-search-fts` fails → FTS5 index may need rebuilding
- `semantic-search-vector` fails → Embedding provider may be unavailable (HuggingFace model loading)
- `semantic-cleanup` fails → Delete operation broken — potential data leak from probes

#### 2.2 EpisodicMemoryProbe

**What it tests**: Is event recording working?

**Probes**:
- `episodic-record`: Record a test event, verify it's written to the JSONL file
- `episodic-query`: Query recent events, verify the test event appears
- `episodic-cleanup`: Remove the test event entry

**Prerequisites**: EpisodicMemory is initialized

#### 2.3 RelationshipProbe

**What it tests**: Is the relationship system storing and resolving identities?

**Probes**:
- `relationship-list`: Verify `relationshipManager.list()` returns without error
- `relationship-store`: Create a test relationship (`__probe_test_person`), verify it persists
- `relationship-resolve`: Test channel-based identity resolution (given a platform + handle, does it find the right person?)
- `relationship-cleanup`: Delete the test relationship

**Prerequisites**: RelationshipManager is initialized

#### 2.4 KnowledgeProbe

**What it tests**: Is the knowledge base accessible and functional?

**Probes**:
- `knowledge-list`: Verify knowledge bases can be listed
- `knowledge-query`: If any knowledge bases exist, verify a query returns results

**Prerequisites**: KnowledgeManager is initialized

### Tier 3 — Safety & Quality

#### 3.1 QuotaProbe

**What it tests**: Is quota tracking accurate and responsive?

**Probes**:
- `quota-state`: Verify `quotaTracker.getState()` returns valid state with recent timestamp
- `quota-threshold`: Verify threshold calculations are producing reasonable values (not NaN, not negative)
- `quota-freshness`: Verify quota data was updated within the expected polling interval

**Prerequisites**: QuotaManager is enabled

#### 3.2 CoherenceGateProbe

**What it tests**: Are high-risk actions being properly gated?

**Probes**:
- `gate-configured`: Verify the coherence gate has its action definitions loaded
- `gate-blocks`: Submit a simulated high-risk action and verify it's blocked (not actually executed)
- `gate-audit`: Verify the audit trail is being written

**Prerequisites**: CoherenceGate is initialized

#### 3.3 OrphanReaperProbe

**What it tests**: Is the orphan process reaper detecting and classifying processes?

**Probes**:
- `reaper-scan`: Trigger a process scan, verify it returns classified results
- `reaper-classification`: Verify processes are being classified into tracked/orphan/external categories
- `reaper-schedule`: Verify the reaper's cleanup interval is active

**Prerequisites**: OrphanProcessReaper is initialized

#### 3.4 SecretRedactionProbe

**What it tests**: Are secrets being properly stripped from outputs?

**Probes**:
- `redaction-basic`: Pass a string containing a known test secret pattern through the redactor, verify it's stripped
- `redaction-patterns`: Test multiple secret patterns (API keys, tokens, passwords) are all caught
- `redaction-passthrough`: Verify non-secret strings pass through unchanged

**Prerequisites**: SecretRedactor is available

#### 3.5 CommitmentProbe

**What it tests**: Is the commitment tracker recording and verifying promises?

**Probes**:
- `commitment-list`: Verify `commitmentTracker.list()` returns without error
- `commitment-store`: Record a test commitment, verify it persists
- `commitment-verify`: Trigger verification on the test commitment
- `commitment-cleanup`: Withdraw the test commitment

**Prerequisites**: CommitmentTracker is initialized

### Tier 4 — Coordination

#### 4.1 HeartbeatProbe

**What it tests**: Is the multi-machine heartbeat system operational?

**Probes**:
- `heartbeat-sending`: Verify this machine is emitting heartbeats
- `heartbeat-freshness`: Verify the last heartbeat was within the expected interval
- `heartbeat-peers`: If peers are configured, verify their heartbeat status

**Prerequisites**: Multi-machine is enabled and configured

#### 4.2 GitSyncProbe

**What it tests**: Is Git-based state sync functional?

**Probes**:
- `gitsync-repo`: Verify the sync repo exists and is accessible
- `gitsync-push`: Verify the last push was within expected window (or no pending changes)
- `gitsync-pull`: Verify pulls are succeeding (no persistent merge conflicts)

**Prerequisites**: GitSync is enabled

#### 4.3 WorkLedgerProbe

**What it tests**: Is the work ledger tracking and preventing overlaps?

**Probes**:
- `ledger-state`: Verify the work ledger file is accessible and valid JSON
- `ledger-record`: Record a test entry, verify it persists, clean up

**Prerequisites**: Multi-machine is enabled

### Tier 5 — Communication Quality

#### 5.1 NotificationProbe

**What it tests**: Is the notification batcher correctly routing and deduplicating?

**Probes**:
- `notification-batch`: Submit a test notification, verify it's queued in the correct tier
- `notification-dedup`: Submit a duplicate, verify it's suppressed
- `notification-cleanup`: Clear test notifications

**Prerequisites**: NotificationBatcher is initialized

#### 5.2 UpdateCheckerProbe

**What it tests**: Is the update detection system functional?

**Probes**:
- `update-check`: Verify `updateChecker.check()` returns without error (doesn't need to find an update)
- `update-version-parse`: Verify the current version is correctly parsed and comparable

**Prerequisites**: UpdateChecker is initialized

#### 5.3 FeedbackProbe

**What it tests**: Can the feedback pipeline store and forward items?

**Probes**:
- `feedback-store`: Submit a test feedback item, verify it's stored locally
- `feedback-quality`: Verify the quality check accepts well-formed items and rejects malformed ones
- `feedback-cleanup`: Remove the test feedback item

**Does NOT**: Forward to the webhook (that's a real external operation).

**Prerequisites**: FeedbackManager is initialized

#### 5.4 SessionSummaryProbe

**What it tests**: Is session summary generation working?

**Probes**:
- `summary-generation`: Verify the summary sentinel can process session data (doesn't require active sessions)
- `summary-delivery`: Verify the delivery path is wired (Telegram adapter available)

**Prerequisites**: SessionSummarySentinel is initialized

## Execution Model

### Scheduled Execution

The SystemReviewer registers itself as a job in the scheduler:

```json
{
  "id": "system-review",
  "name": "System Review",
  "schedule": "0 */6 * * *",
  "priority": "low",
  "type": "internal",
  "description": "Run system probes to verify feature health",
  "sessionless": true
}
```

**Sessionless execution**: Unlike most jobs, the system review does NOT spawn a Claude session. It runs directly in the server process. This is critical — the review should work even when sessions can't be spawned (quota exhaustion, session limits).

### Probe Execution Model

**Within a tier**: Probes run concurrently via `Promise.allSettled`, EXCEPT probes that share a `serialGroup` — those run sequentially within their group. This prevents SQLite lock contention between write-heavy probes while keeping total execution time within the review timeout.

**Across tiers**: Tiers run sequentially (Tier 1 first, then Tier 2, etc.). If a tier exceeds its time budget, remaining probes in that tier are marked as timed-out and the next tier proceeds.

**Serial groups**: Probes that write to shared state declare a `serialGroup`:
- `'sqlite'` — SemanticMemoryProbe, EpisodicMemoryProbe (share SQLite)
- `'relationships'` — RelationshipProbe (writes to relationship JSON files)
- `'state'` — CommitmentProbe, WorkLedgerProbe (write to state files)

**Concurrency guard**: A mutex prevents overlapping review runs. If a manual trigger arrives during a scheduled run, it queues and runs after the current review completes (or returns the in-progress review if `dryRun: true`).

### Dead-Letter Fallback

The SystemReviewer's own error reporting MUST be independent of all monitored infrastructure. When the reviewer itself encounters errors (probe orchestration failure, history persistence failure, etc.), it writes to a dead-letter file:

```
.instar/state/doctor-dead-letter.jsonl
```

This file-append path uses only `fs.appendFileSync` — no Telegram, no feedback pipeline, no SQLite. It is the one error path that cannot fail unless the filesystem is gone.

### Scheduler Bootstrap

The SystemReviewer does NOT depend on the scheduler for its first run. On server startup, after the startup sweep, the SystemReviewer starts its own `setInterval` timer (independent of the job scheduler). This ensures the doctor runs even if the scheduler is broken — which is exactly one of the things it tests.

The scheduler job registration is optional and additive — it allows the scheduler dashboard to show when the next review is due, but the timer is the source of truth for execution.

### On-Demand Execution

Available via API (all routes require `Authorization: Bearer $INTERNAL_API_KEY`):

```
POST /system-reviews
  Body: { tiers?: number[], probeIds?: string[], dryRun?: boolean }
  Response: ReviewReport

GET /system-reviews/history
  Query: ?limit=10
  Response: ReviewReport[]

GET /system-reviews/trend
  Response: ReviewTrend

GET /system-reviews/probes
  Response: Array<{ id, name, tier, feature, prerequisites_met }>

GET /system-reviews/latest
  Response: ReviewReport | null
```

**Discoverability aliases** (no auth required — these mirror the auth-gated endpoints for agents that probe common URL shapes):

```
GET /health/probes
  Response: { timestamp, status, stats, probes: ProbeResult[], skipped }
  Note: Returns all probe results (pass and fail). Alias for agents that naturally try /health/* paths.

GET /system-review
  Response: ReviewReport | null
  Note: Singular alias for /system-reviews/latest. Matches the URL shape agents commonly try first.
```

And via CLI:

```bash
instar review                    # Run full review
instar review --tier 1           # Run tier 1 only
instar review --probe semantic-store  # Run specific probe
instar review --dry-run          # Show what would run
instar review --history          # Show past results
instar review --trend            # Show trend analysis
instar review --json             # Machine-readable JSON output
```

**Exit codes**:
- `0` — All probes passed
- `1` — One or more probes failed
- `2` — Review-level error (orchestrator failure, timeout)

### Failure Response

When probes fail, the SystemReviewer takes graduated action:

1. **Any failure**: Record in review history (JSONL), include in trend analysis
2. **Tier 1 failure**: Telegram alert to agent-attention topic (respects `alertCooldownMs`) + submit feedback if `feedbackConsentGiven && autoSubmitFeedback`
3. **Tier 2 failure**: Telegram notification (non-silent) + submit feedback if consented
4. **Tier 3-5 failure**: Include in next dashboard update + submit feedback if consented
5. **Persistent failure** (fails 3+ consecutive reviews without a single pass): Escalate severity by one level and add `[PERSISTENT]` tag. Counter resets to 0 on any pass.

**Feedback gating**: Feedback auto-submission requires BOTH `autoSubmitFeedback: true` AND `feedbackConsentGiven: true`. When submitting, all `actual`, `error`, `stack`, and `diagnostics` fields are sanitized through the SecretRedactor before transmission. If SecretRedactor is unavailable (not yet initialized), feedback submission is silently skipped.

**Feedback dedup**: Only one feedback item per probeId per 24-hour window. Prevents alert storms from persistently broken probes (which would otherwise generate 4 feedback items/day at the default 6-hour schedule).

**Telegram alerts**: Alerts embed a summary line with probe name, tier, and status — NOT full diagnostic data. Full details are available via `instar review --history` or the API. This prevents attacker-influenced diagnostic data from being sent to Telegram.

### Feedback Format

Failed probes submit structured feedback:

```
Title: [SYSTEM-REVIEW] SemanticMemoryProbe: semantic-search-fts FAILED
Type: bug
Description:
  Probe: semantic-search-fts (Tier 2 — Intelligence)
  Feature: Semantic Memory

  What was tested:
    Full-text search via FTS5 — stored a test entity "__probe_test_1709312400",
    then searched for it by content.

  Expected: Test entity appears in FTS5 search results
  Actual: Search returned 0 results despite entity being stored successfully

  Duration: 450ms
  Error: None thrown — search completed but returned empty array

  Diagnostics:
    - Entity stored at ID: 47
    - Entity content: "System reviewer probe test entity 1709312400"
    - Search query: "probe test entity"
    - Search results: []
    - FTS5 table exists: true
    - FTS5 row count: 342

  Suggested remediation:
    FTS5 index may be out of sync with main table. Try:
    1. Check if INSERT trigger on entities table is firing for FTS5 sync
    2. Run: DELETE FROM entities_fts; INSERT INTO entities_fts(entities_fts) VALUES('rebuild');
    3. If persists, check SQLite WAL mode — FTS5 can lag behind in WAL

  Review run: 2026-03-01T12:00:00Z (run 47 of system-review job)
  Consecutive failures: 1
  Previous status: passed (2026-03-01T06:00:00Z)
```

## Integration Points

### With HealthChecker

The SystemReviewer registers as a component in the existing HealthChecker:

```typescript
components.systemReview = {
  status: lastReview.status === 'all-clear' ? 'healthy'
    : lastReview.status === 'degraded' ? 'degraded'
    : 'unhealthy',
  message: `${lastReview.stats.passed}/${lastReview.stats.total} probes passed`,
  lastCheck: lastReview.timestamp,
};
```

The `/health` endpoint's `systemReview` section also includes enriched failure data so agents can drill into problems without a second API call:

```json
"systemReview": {
  "status": "degraded",
  "lastReview": { "passed": 13, "failed": 3, "skipped": 0 },
  "probesRegistered": 16,
  "failedProbes": [
    {
      "probeId": "scheduler-heartbeat",
      "name": "Scheduler Heartbeat",
      "tier": 1,
      "error": "Last tick was 14 minutes ago (threshold: 5 min)",
      "remediation": "Check .instar/jobs.json and restart the server"
    }
  ],
  "detailsUrl": "/system-reviews/latest"
}
```

`failedProbes` is an empty array when all probes pass. `detailsUrl` always points to the full review report.

### With CoherenceMonitor

The CoherenceMonitor can use SystemReviewer results as an additional coherence signal — if probes are failing but HealthChecker says healthy, that's an incoherence worth reporting.

### With DegradationReporter

When a probe detects a degradation that the DegradationReporter missed (silent fallback), the probe should also file a DegradationEvent. This creates a safety net for the safety net.

### With Dashboard

The dashboard includes a "System Review" section:
- Last review timestamp and overall status
- Pass/fail counts with tier breakdown
- Trend indicator (improving/stable/declining)
- Link to detailed results

### With Telegram Notifications

Review results follow the existing notification patterns:
- Critical failures: immediate alert (respects cross-batch suppression)
- Degraded results: batched with other notifications
- All-clear: silent (no notification — avoids the "everything is fine" spam Justin flagged)

## Testing Strategy

### Unit Tests
- Each probe has unit tests that verify it produces correct ProbeResults for success and failure scenarios
- Mock the underlying services (SessionManager, SemanticMemory, etc.)
- Test cleanup behavior (probe artifacts are removed even on failure)

### Integration Tests (Wiring Integrity)
- Verify SystemReviewer correctly receives server context with all services
- Verify probes can access the real instances they need
- Verify feedback submission path is wired

### E2E Tests
- Run a full review on a test server instance
- Verify the review report is correctly structured
- Verify feedback items are created for failures
- Verify cleanup: no test artifacts remain in state after review

## Rollout Plan

### Phase 1: Foundation (This PR)
- `SystemReviewer` orchestrator with config, scheduling, history, trend
- Probe interface and registration
- API routes and CLI commands
- Tier 1 probes (Session, Scheduler, Messaging, Lifeline)
- Feedback integration for failures
- Unit + integration tests

### Phase 2: Intelligence Probes
- Tier 2 probes (Semantic Memory, Episodic Memory, Relationships, Knowledge)
- Self-cleaning test entity management
- Enhanced diagnostics for memory subsystem

### Phase 3: Safety & Quality Probes
- Tier 3 probes (Quota, Coherence Gate, Orphan Reaper, Secret Redaction, Commitments)
- Gate testing without triggering real gates

### Phase 4: Coordination & Communication Probes
- Tier 4 probes (Heartbeat, Git Sync, Work Ledger) — only active on multi-machine setups
- Tier 5 probes (Notifications, Updates, Feedback, Session Summaries)

### Phase 5: Intelligence Layer
- Trend analysis: automatically detect patterns in probe failures
- Correlation: "whenever probe X fails, probe Y also fails within 2 hours"
- Predictive: if a probe's response time is trending upward, warn before it fails
- Auto-remediation: for known failure patterns, attempt automated fixes before reporting

## Configuration Defaults

```json
{
  "systemReviewer": {
    "enabled": true,
    "schedule": "0 */6 * * *",
    "scheduledTiers": [1, 2, 3],
    "probeTimeoutMs": 30000,
    "reviewTimeoutMs": 300000,
    "historyLimit": 50,
    "autoSubmitFeedback": false,
    "feedbackConsentGiven": false,
    "alertOnCritical": true,
    "alertCooldownMs": 3600000,
    "disabledProbes": []
  }
}
```

## Resolved Questions (from Review Round 1)

1. **Probe test topic**: RESOLVED — Dry-run verification is sufficient for Phase 1. MessagingProbe verifies the adapter is connected and the send path is wired without actually sending. A dedicated test topic can be added in Phase 2 if dry-run proves insufficient.

2. **Session spawn probe**: RESOLVED — Implement in Phase 2. A daily minimal session spawn probe costs ~$0.001 and catches the primary failure mode the system was built to detect (sessions spawning but accomplishing nothing). Configurable schedule, disabled by default on quota-limited setups.

3. **Cross-machine probe coordination**: RESOLVED — Each machine runs its own review independently. Results include `machineId` for feedback deduplication. Probes can declare `scope: 'machine-local'` (default) vs `scope: 'cluster'` for Phase 4 coordination probes.

4. **Probe versioning**: DEFERRED — Probes should degrade gracefully for now. Add `minVersion?: string` to Probe interface in Phase 3 if version drift becomes a real problem.

5. **User-defined probes**: RESOLVED — The `SystemReviewer.register()` API supports custom probes. Document extensibility path in Phase 2. Auto-load from a `customProbes` directory if present.
