# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The Token Ledger (shipped in v0.28.77 as Phase 1 read-only token-usage
observability) had an unbounded synchronous first scan. On agents with
deep Claude Code history this blocked the Node event loop for minutes —
one local agent had 119,130 JSONL transcripts totaling 12 GB, and on
boot the server stopped responding to its own `/health` endpoint, which
caused the lifeline supervisor to declare the agent dead and restart it
in a loop.

This release bounds the scan in three independent ways:

1. **Per-tick file cap** (default 500) with a persistent in-memory
   cursor across ticks. The first poll backfills 500 files; the next
   poll picks up where the previous one stopped; once the tree is fully
   walked the cursor wraps back to the start so newly-written sessions
   are still picked up.
2. **Intra-tick yielding** (default every 25 files) via `setImmediate`.
   Even within a single tick the event loop gets to drain HTTP and
   health-check traffic — the server stays responsive while the ledger
   is doing its work.
3. **Optional max file age** (default 30 days at the wiring layer). The
   ledger ignores transcripts whose mtime is older than the backfill
   window. Active sessions are never blackholed: appending a new turn
   updates the file's mtime, which brings it back into the window. The
   source JSONLs in `~/.claude/projects/` remain the ground truth, so an
   operator can widen the window later by passing a larger
   `maxFileAgeMs` and the ledger will pick up the older data on the
   next scan.

A new `scanAllAsync()` method is the path the poller now uses; the
original `scanAll()` sync entry point is preserved for tests and any
caller that doesn't need yielding (and now honors the per-tick cap and
age cutoff too).

No schema migration. No new routes. No new external surfaces. Pure
containment fix for the v0.28.77 regression.

## What to Tell Your User

- **Quieter, more reliable startup with the new Tokens tab**: I no
  longer get stuck staring at years of old session transcripts on boot.
  When I start up, I look at the most recent month of activity first,
  in small batches, and I keep answering you in between batches. The
  Tokens tab will fill in over the first few minutes instead of being
  empty until everything has been read at once.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Bounded first-boot scan of the token ledger | Automatic on upgrade |
| Configurable backfill window for the token ledger | Pass `maxFileAgeMs` to TokenLedger constructor (defaults to 30 days at the wiring layer) |
| Per-tick scan cap and event-loop yielding | Automatic on upgrade |

## Evidence

Reproduction (before fix):

1. Start v0.28.77 on a host with deep Claude Code history (the local
   reproduction host had 119,130 JSONL files / 12 GB under
   `~/.claude/projects/`).
2. `curl -m 5 http://localhost:4042/health` hangs — connection accepted
   but no response within timeout.
3. `sample <pid> 1` shows the main thread spending 100% of its time in
   `uv_fs_stat` callbacks under
   `Builtins_InterpreterEntryTrampoline` — a JS loop hammering the
   filesystem with no event-loop yields.
4. The lifeline supervisor's health probe times out, declares the
   server unhealthy, and restarts it. The next boot starts the same
   scan over again.

After fix:

1. Same host, same `~/.claude/projects/` tree. Server boots and
   `curl http://localhost:4042/health` returns a normal JSON response
   within a few hundred ms.
2. `curl http://localhost:4042/tokens/summary` returns valid JSON
   immediately (initially with a small subset of recent sessions).
   Subsequent ticks fill in the rest of the 30-day window.
3. The lifeline supervisor sees a healthy server and stops restarting.

Unit tests: `tests/unit/token-ledger.test.ts` — 15/15 passing locally
on the `fix/token-ledger-bounded-scan` branch. Three new tests cover
the cursor resume, age cutoff, and async yielding behavior. Typecheck
clean (`npx tsc --noEmit`).
