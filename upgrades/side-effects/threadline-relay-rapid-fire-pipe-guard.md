# Side-effects review — threadline relay rapid-fire same-thread pipe guard

**Scope**: Close high-severity data-loss bug where rapid-fire messages on the same Threadline thread silently drop because `PipeSessionSpawner.spawn` unconditionally kills the prior `tmux` session, and the pipe eligibility gate never checks whether a prior pipe session is already live on that thread.

**Files touched**:
- `src/threadline/PipeSessionSpawner.ts` — add `hasActiveSessionForThread(threadId: string): boolean` method that iterates the existing `activeSessions` Map and returns true iff any session's `threadId` matches. No new state, no new configuration.
- `src/commands/server.ts` — extend the Phase 2a pipe-mode eligibility condition at ~line 5688 to also require `!pipeSpawner.hasActiveSessionForThread(msg.threadId)`. When the guard fires, control falls through to the existing Phase 2b listener-inbox path, which serializes deliveries via `ListenerSessionManager.writeToInbox` → inbox.jsonl append.

**Under-block**: None for the target bug. The guard covers every rapid-fire same-thread case at the exact chokepoint (relay handler, pre-pipe-spawn). There is no remaining code path where two same-thread messages could reach `spawn()` concurrently with pipe-mode enabled.

**Over-block**: Minimal. If a prior pipe session is "stuck" (tmux alive but claude process hung), subsequent messages for that thread now go through the listener rather than killing the stuck session. This is actually desirable — killing a stuck pipe session was previously how operators unblocked threads, but that kill was a side-effect of a concurrency bug, not a designed recovery path. The proper recovery (listener accumulates the messages; stuck pipe session eventually times out via existing `maxRuntimeMs`; next request after timeout enters pipe mode cleanly) is already the intended behavior.

**Level-of-abstraction fit**: `PipeSessionSpawner` already owns the `activeSessions` Map and the `threadId` field on each session. Adding a lookup method at this abstraction is the correct home — the server.ts caller asks a question of the spawner rather than reaching into its internal Map. The guard in server.ts stays at the relay-routing level where Phase 2a/2b selection already lives.

**Signal vs authority**: No authority change. `PipeSessionSpawner` remains the single authority over pipe-mode sessions; the new method is a read-only query. The server.ts caller gains one new piece of information but no new authority.

**Interactions**:
- `ListenerSessionManager.writeToInbox` is exercised more often now (every rapid-fire same-thread overflow). Its contract (append to inbox.jsonl, serialized by file lock) is already designed for this and is the safer path per cluster research.
- `activeSessions.delete(sessionName)` on session exit (existing line ~390) means the guard correctly opens again when a session completes — no permanent lockout.
- Auto-ack behavior (line 5681-5684) is unchanged; acks still fire immediately before the routing decision.
- `threadResumeMap` check remains in front of the guard, preserving thread-resume semantics untouched.

**External surfaces**:
- New public method: `PipeSessionSpawner.hasActiveSessionForThread(threadId: string): boolean`.
- No new CLI flag, no new config field, no new API endpoint, no new log format, no new metric.

**Rollback cost**: Trivial. Revert two files. No migration. No data format change. Existing `inbox.jsonl` files remain valid under both old and new code paths.

**Tests**:
- The change is verified to compile cleanly (`npm run build` passes with the change; PipeSessionSpawner.ts and server.ts emit valid JS into `dist/`).
- `npm test` vitest run executed (see trace).
- The new method is trivial (single Map iteration); its correctness is directly observable in the server.ts guard at runtime.
- An integration test that demonstrates rapid-fire messages queue serially through the listener inbox instead of killing each other is the natural next coverage, but is out of scope for this minimal fix. The existing unit suite for `PipeSessionSpawner` remains green.

**Decision-point inventory**:
1. **Method name**: `hasActiveSessionForThread` (vs. `isThreadActive`, `threadHasSession`) — chosen to mirror the existing `activeSessions` field name so readers find the answer by following the noun. The method is a direct question about the collection it owns.
2. **Guard placement**: Inline in the Phase 2a `if` condition (vs. inside `shouldUsePipeMode`) — kept in server.ts because the fall-through target (Phase 2b listener path) is a server.ts concept. Putting the check inside `shouldUsePipeMode` would return `{eligible: false}` but couldn't express "eligible for listener, not pipe", which is the actual semantics we want. The eligibility gate in the spawner remains a pure property of the spawner's capacity/trust/iqs/length gates.
3. **Fallthrough target**: Phase 2b listener inbox (vs. Phase 2c cold-spawn) — per research, the listener inbox already serializes rapid-fire via a file append + lock, which is the correct model for same-thread queuing. Cold-spawn would also work but creates a new session per message, defeating the listener's reuse.
4. **No cache TTL**: `activeSessions` entries are already removed on session exit (`activeSessions.delete(sessionName)` in existing cleanup path). No stale-entry risk; no TTL needed.

**Why LOW risk**:
- Purely additive: new method + new boolean term in an existing `if`.
- Fall-through target is already the documented safer path for ineligible-for-pipe messages.
- No change to behavior when the guard does not fire (i.e., the common single-message-per-thread case).
- No data-format change; no persistent state added.
- Reversible with a two-line revert.
