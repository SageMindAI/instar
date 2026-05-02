---
title: Token Ledger — bounded first-boot scan
slug: token-ledger-bounded-scan
date: 2026-05-01
author: echo
second_pass_required: false
---

## Summary of the change

The token ledger (shipped in v0.28.77 as Phase 1 read-only observability) does
a synchronous walk of `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` on
every poll tick, and on first boot ingests every file it finds. On Echo's host
this turned out to mean **119,130 JSONL files / 12 GB of transcripts** — the
first scan blocked the Node event loop for minutes. The HTTP server accepted
TCP connections during the scan but never returned a response, including for
`/health`, which made the lifeline supervisor declare the agent dead and
restart it in a loop.

This change makes the scan bounded in three ways:

1. **Per-tick file cap (default 500)** with a persistent cursor across
   ticks, so the ledger backfills incrementally instead of in one pass.
2. **Async yielding (default every 25 files)** via `setImmediate`, so even
   within a tick the event loop gets to drain HTTP/health traffic.
3. **Optional max file age (default 30 days at the wiring layer)** so the
   ledger ignores transcripts older than the backfill window. The source
   JSONLs are unchanged and remain the ground truth — the operator can
   widen the window later by passing a larger `maxFileAgeMs`.

A new `scanAllAsync()` method wraps the existing scan loop and is the path
the poller now uses. The original `scanAll()` sync method is preserved for
callers and tests that don't need yielding (and now honors the per-tick
cap and age cutoff too).

Files touched:
- `src/monitoring/TokenLedger.ts` — added `maxFileAgeMs`, `maxFilesPerScan`,
  `yieldEveryNFiles` options; refactored `scanAll` into a shared
  `scanInternal` helper plus sync (`scanAll`) and async (`scanAllAsync`)
  entry points; added a persistent `scanCursor` for cross-tick resume.
- `src/monitoring/TokenLedgerPoller.ts` — switched `tick()` to await
  `scanAllAsync()` (still fire-and-forget; reentry guard unchanged).
- `src/server/AgentServer.ts` — wires the three caps with sensible defaults
  (30-day age window, 500 files/tick, yield every 25 files).
- `tests/unit/token-ledger.test.ts` — 3 new tests for cursor resume,
  age cutoff, and async yielding behavior.

The change has no decision-point surface. The ledger is still pure
observability: never gates, blocks, filters, or alters any agent behavior.
Adding caps does mean the data picture is incomplete during early backfill,
but only the *speed of completeness* changes — not whether the data ever
becomes complete.

## Decision-point inventory

The change has no block/allow/route surface. There is no dispatcher,
sentinel, gate, or watchdog being added or modified. The "orphans" view
remains a signal-only list (no kill authority), unchanged.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

The closest analogue would be "the dashboard hides data that does exist on
disk." That's a property of the new caps: a 90-day-old session won't appear
in `/tokens/summary` until the operator widens `maxFileAgeMs`. This is
visibility-shaping, not authority. No automation reads
`/tokens/summary` and acts on it.

---

## 2. Under-block

No block/allow surface — under-block not applicable.

---

## 3. Level-of-abstraction fit

The fix lives entirely inside the existing `src/monitoring/TokenLedger.ts`
file and its poller. It does not introduce a new framework, queue, or
abstraction. The caps are normal constructor options on the same class
that already exists. The cursor is a private instance field. The async
variant uses `setImmediate` — the standard Node primitive for yielding
to the event loop, which is what every other long-running scanner in this
codebase uses (see `OrphanProcessReaper`, `MemoryPressureMonitor`).

The wiring change in `AgentServer.ts` is co-located with the original
ledger initialization that landed in v0.28.77 — same try/catch,
same null-on-failure behavior.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The ledger remains pure read-side observability. The bounding logic does
not gain any authority — it only changes the cadence at which data
becomes visible. Future kill-orphan automation, budget enforcement, or
compaction triggers remain explicitly out of scope and would be separate
changes with their own review (per the principle, those would feed an
LLM-backed authority, not become their own brittle blockers).

---

## 5. Interactions

- **Shadowing:** None. No new route, no new file path, no new dispatcher.
  The ledger DB schema is unchanged (no migration needed).
- **Double-fire:** None. The poller's `running` reentry guard is unchanged
  and still skips a tick if the previous one is in flight. Cursor state
  is mutated only inside the (single-threaded) scan loop; no cross-tick
  race because reentry is blocked.
- **Races:** Cursor invalidation is handled — if `projectDirs` shrinks
  between ticks (a project directory was deleted), the cursor is reset to
  `{0, 0}` rather than indexing past the end. The `INSERT OR IGNORE` on
  `request_id` continues to make ingest idempotent regardless of cursor
  re-traversal.
- **Feedback loops:** None. The caps don't create any new path back into
  Claude Code or the agent's behavior. The ledger continues to be
  downstream of Claude Code's logging.
- **Cross-restart:** The cursor resets on process restart (it's an
  instance field, not persisted). This is correct: after a restart, the
  ledger DB itself records which files have been read up to which offset
  (`file_offsets` table), so re-scanning previously-ingested files is
  cheap (the offset check fires before any line parsing). The cursor
  exists only to bound *intra-process* work; per-file resume is already
  handled by the durable offset table from v0.28.77.

One subtle interaction worth naming: the `maxFileAgeMs` filter uses
`fs.statSync(fp).mtimeMs`. If a JSONL is *appended to* (Claude Code adds
a turn to an existing session), the mtime updates and the file becomes
in-window again — so active sessions never get blackholed by the age cap.
Only sessions that are truly dormant past the cap drop out of the rotation.
Verified by test: the `respects maxFileAgeMs` test backdates a file with
`fs.utimesSync` to confirm the filter triggers on stale mtime.

---

## 6. External surfaces

- **Other agents on the same machine:** No effect on their behavior. They
  each gain the bounded-scan defaults when they upgrade.
- **Other users of the install base:** Pure additive option surface. Old
  callers passing only `dbPath` and `claudeProjectsDir` get the new
  defaults automatically. No existing API contract changed.
- **External systems:** None. No new outbound calls.
- **Persistent state:** No schema migration. The existing `file_offsets`
  table continues to drive per-file resume. The new cursor is in-memory
  only.
- **Timing/runtime:** First-boot scan now spans many ticks instead of
  blocking the event loop. On Echo's box (119k files, mostly stale): with
  defaults, the first useful tick reads ~500 files within a 30-day window,
  yielding every 25 files; subsequent ticks pick up the cursor. Steady
  state once backfill is done is identical to v0.28.77 (same offset-check
  no-op for already-ingested files).

The reader remains **strictly read-only against `~/.claude/projects/`**.
No write fds are ever opened.

---

## 7. Rollback cost

Pure additive change. Rollback steps:

1. Revert the commit. Ship as next patch release.
2. The ledger DB at `<stateDir>/server-data/token-ledger.db` is unchanged
   on disk (no schema migration). Reverting goes back to unbounded scan
   behavior — which is broken on agents with deep history, so we'd want
   to either (a) deploy a different fix, or (b) ship a config option that
   defaults the agent to NOT initialize the ledger at all on the affected
   hosts. But the DB itself is fine.
3. No agent state repair needed.

Estimated rollback time: minutes. Pure code revert.

If the bounded defaults turn out to be wrong (too aggressive), the operator
can override per-agent via the AgentServer construction call (or, if a
config knob is added later, via `.instar/config.json`). No re-deploy needed
to widen the window — the data is still in `~/.claude/projects/`.

---

## Conclusion

This change is a containment fix for a v0.28.77 regression: the ledger
shipped without considering agents that have years of accumulated Claude
Code history, and the unbounded synchronous first scan blocked the
server's event loop. The fix bounds work via three independent
mechanisms (per-tick file cap, intra-tick yielding, age cutoff) so that
no plausible JSONL tree can stall the agent. None of these mechanisms
introduce decision-point surface or change the ledger's read-only,
observability-only character.

The change is clear to ship.

---

## Second-pass review (if required)

Not required. The change does not touch any of the trigger criteria from
the side-effects-review skill (block/allow on messaging or dispatch,
session lifecycle, context exhaustion/compaction, coherence/idempotency/
trust, sentinel/guard/gate/watchdog).

---

## Evidence pointers

- Reproduction (before fix): start v0.28.77 server on a host with deep
  Claude Code history. `curl http://localhost:4042/health` hangs;
  `sample <pid> 1` shows the main thread spending 100% of its time in
  `uv_fs_stat` callbacks under `Builtins_InterpreterEntryTrampoline`
  (i.e., a JS loop hammering the filesystem). The lifeline supervisor
  declares the server unhealthy and restarts it in a loop.
- Reproduction (after fix): same host, same `~/.claude/projects/` tree.
  `curl http://localhost:4042/health` returns within a few hundred ms
  immediately on boot. `curl /tokens/summary` returns valid JSON
  (initially with a small subset of recent sessions; backfill fills in
  across subsequent ticks).
- Unit tests: `tests/unit/token-ledger.test.ts` — 15/15 passing locally
  on `fix/token-ledger-bounded-scan` branch. New tests cover the three
  bounding mechanisms (cursor resume, age cutoff, async yielding).
- Typecheck: `npx tsc --noEmit` clean.
