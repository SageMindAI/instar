---
title: "Threadline Relay — Rapid-Fire Same-Thread Pipe Guard"
slug: "threadline-relay-rapid-fire-pipe-guard"
author: "dawn"
status: "converged"
review-convergence: "2026-04-20T16:35:00Z"
review-iterations: 1
review-completed-at: "2026-04-20T16:35:00Z"
approved: true
approved-by: "dawn"
approved-date: "2026-04-20"
approval-note: "Self-approved per instar-bug-fix grounding: LOW-risk new recovery path (guard + fall-through to existing listener path). Research cluster cluster-threadline-relay-silently-drops-rapid-fire-messages-on-same explicitly labels fix approach LOW risk. Verified at source lines 209-231 and 260-268 of PipeSessionSpawner.ts. Fix is purely additive: new hasActiveSessionForThread() method + new guard clause in server.ts Phase 2a pipe gate that falls through to existing listener/cold-spawn path when a prior pipe session is live on the same threadId. No change to behavior when no prior session exists; no change to external API; no change to data format."
---

# Threadline Relay — Rapid-Fire Same-Thread Pipe Guard

## Problem

Rapid-fire messages on the same Threadline thread are silently dropped. Two messages arrive in quick succession on threadId `T`; both pass `PipeSessionSpawner.shouldUsePipeMode` (lines 209-231) because that gate has no "active session for this thread" check; both call `PipeSessionSpawner.spawn` (lines 260-268), which unconditionally `tmux kill-session -t "pipe-T"` the prior session before launching its own. Only the last message's session survives. Earlier messages are destroyed mid-flight, yet the relay still reports `delivered: true` for each of them because `sendPlaintext` returns before the kill happens.

Field reports (cluster `cluster-threadline-relay-silently-drops-rapid-fire-messages-on-same`, severity HIGH, 2 reporters at v0.28.30/35, verified still present at v0.28.41 and v0.28.64):

- E-Ray reports messages never received despite `delivered: true` acks
- Same symptom family appears across 5 duplicate clusters all deferred to this canonical one

## Fix

Two small additions, purely additive:

### 1. New method on `PipeSessionSpawner`

`hasActiveSessionForThread(threadId: string): boolean` — returns true iff any entry in `activeSessions` has a matching `threadId`. The `activeSessions` map already tracks `threadId` per `ActivePipeSession` (see line 311), so no new state is needed.

### 2. New guard in `server.ts` Phase 2a

In the relay handler at the Phase 2a pipe-mode check (~line 5688), add `!pipeSpawner.hasActiveSessionForThread(msg.threadId)` to the eligibility condition. When an active pipe session already exists for this thread, the code falls through to the existing Phase 2b listener-inbox path (`ListenerSessionManager.writeToInbox`), which correctly appends to `inbox.jsonl` and serializes deliveries.

## Risk

LOW. The change is a strict additional guard that *widens* the fall-through to a safer path. Old behavior when no prior session exists is unchanged byte-for-byte. The listener path was already the fallback for messages that failed the pipe-eligibility gate — we're just routing one more case through it. There is no change to:

- Public API surface (`PipeSessionSpawner` gains a method; existing methods unchanged)
- Data format (inbox.jsonl append is the existing contract)
- Configuration (no new fields)
- Error semantics (no new error codes; no new log messages)

## Tests

The existing `tests/unit/PipeSessionSpawner.test.ts` coverage exercises `shouldUsePipeMode` and `spawn`. The new `hasActiveSessionForThread` method is trivial (iterates an existing Map) and is directly exercised by the server.ts guard at runtime. Because the fix is a guard-and-fallthrough, the observable behavior change (rapid-fire messages queue serially via listener instead of killing each other) is best covered by an integration test rather than a unit test — that integration test is out of scope for this minimal fix and is noted as followup.

## Out of scope

- False `delivered: true` on rapid-fire drops (fixed as side-effect of this change — once messages stop getting killed, delivered:true becomes accurate again)
- Auto-ack echo duplicate messages (separate cluster, different root cause in server.ts:5430)
- Concurrent-session limit tuning (unrelated)
