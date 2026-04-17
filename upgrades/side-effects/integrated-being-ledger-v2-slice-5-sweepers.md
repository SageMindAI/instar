# Side-Effects Review — Integrated-Being Ledger v2, Slice 5 (Commitment sweepers)

**Version / slug:** `integrated-being-ledger-v2-slice-5-sweepers`
**Date:** `2026-04-17`
**Author:** Echo
**Second-pass reviewer:** not required — sweepers are pure signal emitters (no block/allow surface, no auth, no session lifecycle). Per `/instar-dev` Phase 5 high-risk list, none of the triggering categories apply.

## Summary

Slice 5 lands the two background sweepers the spec §4 mandates:

- **Expired sweep** (hourly): scans recent ledger entries for commitments with `status=open` and `deadline < now`, emits a `note` entry with `supersedes` pointing at the commitment and subject "expired: deadline passed without resolution". Bounded at 100 emissions per run. Uses the v1 dedup mechanism (dedupKey `integrated-being-v2:expired:<cid>`) to prevent duplicate emissions — rerunning the sweep is a no-op.

- **Stranded sweep** (daily): scans for open commitments whose creator session is no longer in the `LedgerSessionRegistry` and which were created more than 24h ago. Emits a `note` with subject "stranded: creating session no longer exists". Same supersedes-pointer + dedupKey mechanism.

Both sweepers are **signal-shaped**: they write observations; they do NOT mutate the original commitment entry. The commitment stays `kind=commitment` with stored status=open; the effective status (expired, stranded) is a render-time derivation from the supersession chain. This preserves the spec's "immutable commitment + observation chain" semantics and lets readers audit original utterance vs. subsystem observation independently.

Files touched:

- `src/core/CommitmentSweeper.ts` (new, ~230 LOC)
- `src/core/types.ts` (adds `'commitment-sweeper'` subsystem)
- `src/core/SharedStateLedger.ts` (adds `'commitment-sweeper'` to VALID_SUBSYSTEMS)
- `src/commands/server.ts` (boot-wires the sweeper when v2Enabled=true)
- `tests/unit/CommitmentSweeper.test.ts` (new, 9 tests)

## Decision-point inventory

| Decision point | Change | Description |
|---|---|---|
| sweepExpired skip-if-superseded | **add** | Idempotency check — "already has a supersession pointer" → skip. Structural. |
| sweepStranded active-session skip | **add** | Lookup against registry for current session ids. Boolean membership. |
| Batch-limit cap | **add** | Numeric counter. Transport mechanics. |

All structural. No judgment.

## 1. Over-block

None — sweepers don't block anything. They emit signal entries.

## 2. Under-block

- **Sweepers only scan `recent({limit: 200})`.** If an agent has more than 200 recent entries, older commitments don't get scanned. For normal agents this is generous (200 recent entries ≈ days of activity). For very-active agents, stale commitments past the 200 window become invisible to sweepers. Acceptable — the dashboard in slice 6 will provide the explicit audit path; sweepers are opportunistic cleanup.
- **Stranded sweep skips commitments <24h old.** A commitment whose creator session was purged at 23h-59min-59sec remains flagged `open` until the next stranded tick. The spec's stranding timeline (§4) is 7d registry retention + 24h sweep cadence, so this 24h threshold is part of that expected lag.
- **Sweep runs in-process on a setInterval.** If the process crashes between ticks, the missed tick is simply skipped — next start handles whatever accumulated. Acceptable.

## 3. Level-of-abstraction fit

Sweeper is a separate class at `src/core/` alongside the ledger and registry. Same layer as `registerLedgerEmitters` — it's a subsystem emitter. Could theoretically fold into `registerLedgerEmitters` but the sweeper has its own timers and bounded-work scanning that warrant isolation. Correct layer.

## 4. Signal vs authority compliance

- [x] **No — pure signal emitter.** Sweepers observe ledger state and emit subsystem-asserted notes. They do NOT modify commitment entries, do NOT block session writes, do NOT make judgment calls. This is exactly the signal-producer shape the architectural principle prescribes for "cheap, brittle-by-design observation" — except in this case the observation is mechanical (time comparison, session-id membership) rather than content-based, so there's no brittleness concern either.

The commitment's effective status (expired, stranded) is a render-time derivation from the supersession chain — rendering is still the authority for how status displays, not the sweeper. Slice 7 (dashboard) will render these properly.

## 5. Interactions

- **Shadowing:** sweeper emissions write through the v1 append path. They share the append lock with session writes and subsystem emitters — serialized. No shadow.
- **Double-fire:** the supersedes-pointer check prevents double-fire within a single sweep; the dedupKey `integrated-being-v2:expired:<cid>` prevents double-fire across sweeps. Tested explicitly (`is idempotent — a second run does not emit another expired note`).
- **Races:** sweeper runs in the Node event loop; each sweep tick is synchronous w.r.t. other JS code. Concurrent session writes between sweeper ticks are normal; the next sweep picks up the current state.
- **Feedback loops:** a sweeper emission (`note` with supersedes pointing at a commitment) means the commitment is no longer scanned next run (its `supersedes` set contains its own id). Closed loop.

## 6. External surfaces

- Dashboards / external readers: will see new `note` entries with subsystem=`commitment-sweeper` and subject `expired:` / `stranded:`. v1 renderers handle them as standard notes (subject/summary rendered; extra fields ignored).
- Other agents: unchanged.
- Persistent state: adds the new subsystem label to `VALID_SUBSYSTEMS`. Agents running v1 binary reading a v2-written ledger would throw on the unknown subsystem — BUT this is only relevant if v2Enabled is true, and the subsystem label is in the ledger only after a sweeper emission. In the observation window (v2Enabled=false default), no emissions occur. For agents that later upgrade and enable v2, the subsystem is valid at that point.
- Persistent writes: up to 100 entries per hour from the expired sweep, up to 100 entries per day from the stranded sweep. Negligible.

## 7. Rollback cost

- **Hot-fix revert:** pure code revert. Emissions already in the ledger remain (they're standard notes). Reverted code doesn't produce new ones.
- **Data migration:** none.
- **Agent state repair:** none. The sweeper's setInterval handles are `.unref()`-ed, so stopping the process stops the sweepers cleanly.

## Conclusion

Slice 5 is the simplest of the v2 slices so far: pure observation emitters, bounded work, idempotent. 137 tests across affected suites pass; typecheck clean. Second-pass not required — no gate, no auth, no session lifecycle.

Ready to commit.
