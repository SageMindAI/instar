# Side-Effects Review — Token Ledger (Phase 1, read-only observability)

**Version / slug:** `token-ledger-phase1`
**Date:** 2026-04-29
**Author:** echo
**Second-pass reviewer:** not required (no decision points; see Q4)

## Summary of the change

Adds a read-only token-usage ledger as a core instar feature. Every agent now tails Claude Code's per-session JSONL files at `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`, parses each `assistant` line's `message.usage` block, and records token counts to a SQLite DB at `<stateDir>/server-data/token-ledger.db`. Four new GET endpoints (`/tokens/summary`, `/tokens/sessions`, `/tokens/by-project`, `/tokens/orphans`) expose rollups, and a new "Tokens" dashboard tab renders the data.

Files touched:
- `src/monitoring/TokenLedger.ts` (new) — SQLite schema + ingest + query methods
- `src/monitoring/TokenLedgerPoller.ts` (new) — 60s tick wrapping `scanAll()`
- `src/server/AgentServer.ts` — wires ledger into route context, starts/stops the poller
- `src/server/routes.ts` — adds the four GET endpoints under existing auth middleware
- `dashboard/index.html` — adds "Tokens" tab
- `tests/unit/token-ledger.test.ts` (new) — 12 unit tests

The change interacts with no decision points. The ledger does not gate, block, filter, or alter any agent behavior; it is pure observability.

## Decision-point inventory

The change has no decision-point surface. There is no block/allow logic, no message filtering, no session-lifecycle mutation, no dispatcher, sentinel, gate, or watchdog. The "orphans" endpoint returns a list of idle sessions as data — it does not act on them.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable.

---

## 3. Level-of-abstraction fit

This is observability infrastructure, not a decision point. It belongs at the same layer as other monitors in `src/monitoring/` (e.g. `QuotaTracker`, `TelemetryCollector`). It does not duplicate any existing primitive: there is no other instar feature reading Claude Code's per-call JSONL token data — `QuotaTracker` reads a separately-written quota state file, which is a different signal (account-level limit usage) at a different cadence.

The dashboard tab piggybacks on existing `TAB_REGISTRY` + `apiFetch` patterns rather than introducing a new framework. Storage uses the existing `<stateDir>/server-data/<name>.db` convention established by `StopGateDb`.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The ledger is pure read-side observability. Every output is data-for-the-user, never an automated decision. The "orphans" view is explicitly a *signal* (here are sessions idle > N minutes) with no authority to act on the signal. Any future kill-orphan automation, budget enforcement, or compaction trigger would be a separate change with its own review — and per the principle, the orphan list would feed an LLM-backed authority, not become its own brittle blocker.

---

## 5. Interactions

- **Shadowing:** None. The ledger reads files Claude Code writes; it does not stand in front of any existing read path. The new routes are under `/tokens/*` — a fresh prefix, no overlap with existing routes.
- **Double-fire:** None. The poller has a reentry guard (skips a tick if the previous one is still running). Multiple agents on one machine each maintain their own ledger DB under their own state dir, so they don't race on the SQLite file. They DO each scan the same `~/.claude/projects/` tree, but they only read it; the source files are never mutated.
- **Races:** The ledger writes only to its own DB. `INSERT OR IGNORE` on `request_id` makes ingest idempotent, so even if a file is partially read by one tick and re-read by the next (offset semantics), no double-counting can occur. File-rotation handling resets offset when inode changes.
- **Feedback loops:** None. The ledger is downstream of Claude Code's logging; it cannot influence what gets logged. It does not call any LLM, does not emit messages, does not write to any path Claude Code reads.

One subtle interaction worth naming: per-line ingest uses an explicit `BEGIN`/`COMMIT` per file. If the process is killed mid-file, the offset for that file is not advanced, so on next startup the file will be re-read from the prior offset — `INSERT OR IGNORE` makes that safe. Verified by the offset-resume test.

---

## 6. External surfaces

- **Other agents on the same machine:** No effect on their behavior. They each gain the same ledger feature when they upgrade. Each agent's DB lives under its own `<stateDir>/server-data/`, so no cross-agent file contention.
- **Other users of the install base:** Pure additive feature. No existing API contracts changed. Dashboard gains a new tab; existing tabs unchanged.
- **External systems:** None. No outbound network calls. No Telegram, Slack, GitHub, or Cloudflare interaction.
- **Persistent state:** New SQLite DB at `<stateDir>/server-data/token-ledger.db`. Auto-created on first boot. No migration needed for existing installs (the DB simply doesn't exist yet and is created on upgrade). The file can be deleted at any time without affecting agent operation — it will be rebuilt by next scan from the source JSONLs (which are themselves the ground truth).
- **Timing/runtime:** The poller runs every 60s. Each tick performs file I/O proportional to JSONL bytes written since last tick (typically tens of KB/min on a busy agent). SQLite operations are local and bounded. No LLM calls in the hot path. Verified to be cheap by manual sizing — a busy session writes ~1 line per turn, and parsing+inserting one line is microseconds.

The reader is **strictly read-only against `~/.claude/projects/`**. It never opens those files for write. Confirmed by code review of `ingestFile()` — only `fs.openSync(path, 'r')` and `fs.readSync` are used.

---

## 7. Rollback cost

Pure additive code change. Rollback steps:

1. Revert the commit. Ship as next patch release.
2. The token-ledger DB file at `<stateDir>/server-data/token-ledger.db` becomes orphaned. Safe to ignore — it doesn't affect agent operation. Cleanup is optional (`rm` the file).
3. No agent state repair needed. No user-visible regression — the dashboard tab disappears, the four endpoints 404. No other behavior changes.
4. No data migration. No persistent format outside the isolated DB.

Estimated rollback time: minutes. Pure code revert.

---

## Conclusion

This change is read-only observability with no decision-point surface, no external network calls, and no interaction with existing message-flow gates. It follows the established `src/monitoring/` pattern for collectors and the `<stateDir>/server-data/` convention for SQLite storage. The signal-vs-authority principle is preserved by design: the ledger never holds blocking authority, and the "orphans" view is explicitly a signal that any future kill-orphan automation would feed into a smart gate rather than acting on directly.

The change is clear to ship.

---

## Second-pass review (if required)

Not required. This change does not touch any of the trigger criteria from the skill (block/allow on messaging or dispatch, session lifecycle, context exhaustion/compaction, coherence/idempotency/trust, sentinel/guard/gate/watchdog).

---

## Follow-up fix (2026-04-29, post-CI)

CI surfaced a Linux-specific failure in the inode-rotation test: Linux can reuse the same inode number when a file is unlinked and immediately recreated (tmpfs/ext4 behavior). On macOS (where the implementation was first tested) the inode always differs, so the issue was invisible locally.

**Fix:** added a 256-byte content fingerprint (`head_hash` column) to `file_offsets`. Rotation is now detected by `(inode change) OR (head_hash change)`, which is robust across both filesystems. Schema migration is idempotent (`ALTER TABLE … ADD COLUMN` is wrapped in a "duplicate column" swallow).

This change is internal to the ledger and does not affect any of the seven side-effects review answers above. Specifically:
- No new decision-point surface (still pure observability).
- No new external surfaces.
- Rollback cost unchanged — pure code revert; the extra column is harmless if left in place.

## Evidence pointers

- Unit tests: `tests/unit/token-ledger.test.ts` — 12/12 passing locally on `token-ledger-phase1` branch.
- Typecheck: `npm run lint` clean (tsc --noEmit + lint-no-direct-destructive both pass).
- JSONL shape verified against real samples in `~/.claude/projects/-Users-justin-Documents-Projects-ai-guy/` before implementation.
