# PROP: Session-End Maintenance (Cross-pollinated from Dawn)

**Status**: Implemented (v1 — JSONL rotation + journal trim, 2026-04-09)
**Source**: Dawn's `session-maintenance.py` (Portal `.claude/scripts/session-maintenance.py`)
**Date**: 2026-03-26

## Problem

Maintenance tasks (stale data cleanup, metric refresh, knowledge hygiene) currently run in dedicated maintenance jobs. This concentrates housekeeping into periodic bursts rather than distributing it across all sessions. Result: maintenance jobs either find too much work (overdue) or too little (redundant), and the system state drifts between runs.

## Pattern: Distributed Session-End Housekeeping

Dawn discovered that running cheap maintenance tasks at **every session boundary** — not just in dedicated maintenance jobs — keeps the system continuously healthy with minimal overhead per session.

### How It Works in Dawn

At session end (sleep), a lightweight script runs two fast operations:
1. **Retire stale/duplicate questions** — prunes the question queue of items that are outdated or already answered
2. **Refresh one stale metric** — picks the single most stale metric and refreshes it (budget: 10 seconds)

Design constraints:
- Must complete in **<15 seconds total**
- Must not fail loudly (session-end should always succeed)
- Produces a one-line summary for session reports

### Why This Works

- **Distributes load**: Every session does a tiny amount of housekeeping instead of one big maintenance session doing it all
- **Freshness**: Metrics and data stay current because they're refreshed continuously
- **Diminishing returns signal**: When maintenance jobs consistently find nothing to do, it's because session-end maintenance already handled it — a healthy signal

## Proposed Implementation for Instar

### Integration Point

Add a `SessionMaintenanceRunner` that executes after reflection but before session teardown. Hook it into the `HookEventReceiver`'s `SessionEnd` event processing or integrate it into the server's post-session cleanup flow.

### Candidate Maintenance Tasks

| Task | What It Does | Budget |
|------|-------------|--------|
| Stale memory pruning | Remove memories with significance < threshold and age > N days | 3s |
| Execution journal trim | Archive old execution entries beyond retention window | 2s |
| Knowledge tree refresh | Refresh the single most stale knowledge node | 5s |
| Blocker auto-resolve | Check if any tracked blockers have been resolved | 3s |

### API Surface

```typescript
// POST /maintenance/session-end
// Called automatically at session boundaries
interface SessionMaintenanceResult {
  tasksRun: string[];
  itemsProcessed: number;
  durationMs: number;
  summary: string; // One-line for session reports
}
```

### Key Principle

Session-end maintenance must be **fire-and-forget safe**. If it fails, the session still ends cleanly. If it takes too long, it gets killed at the timeout. The agent never blocks on maintenance — it's infrastructure-level, not agent-level.
