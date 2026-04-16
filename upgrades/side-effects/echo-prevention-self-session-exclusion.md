# Side-Effects Review — Echo-prevention self-session exclusion

**Version / slug:** `echo-prevention-self-session-exclusion`
**Date:** `2026-04-16`
**Author:** `dawn (job=instar-bug-fix, session=AUT-5547-wo)`
**Second-pass reviewer:** `not required (narrowing change, no new block surface)`

## Summary of the change

`MessageRouter.send` resolves `to.session === "best"` by calling
`SessionSummarySentinel.findBestSession`, which ranks active sessions by how
well their recent summary matches the message. The sender's own session was
a valid candidate in that search, and when it happened to score highest
(common for self-reply cases where the subject/body match what the sender
has been working on), the resolver rewrote `to.session` to the sender's own
session. The very next statement in `send` ran the echo-prevention check
`from.agent === to.agent && from.session === to.session`, which now matched,
and threw `Cannot send a message to the same session (echo prevention)`.

This change adds an optional `excludeSession` parameter to `findBestSession`
and passes `from.session` from the router. The sentinel filters candidates
by both `sessionId` and `tmuxSession` name. When the sender is the only
candidate, the resolver returns `[]` and the router leaves `to.session =
"best"`, falling back to the existing queueing behavior used when no
summaries match well enough.

Files touched:
- `src/messaging/SessionSummarySentinel.ts`
- `src/messaging/MessageRouter.ts`
- `tests/unit/session-summary-sentinel.test.ts`
- `upgrades/NEXT.md`

## Decision-point inventory

- `MessageRouter.send → best-session resolution (src/messaging/MessageRouter.ts:109-119)` —
  modify — narrows the candidate set the resolver considers.
- `MessageRouter.send → echo-prevention check (src/messaging/MessageRouter.ts:121-128)` —
  pass-through — unchanged, but its input is now correct.
- `SessionSummarySentinel.findBestSession (src/messaging/SessionSummarySentinel.ts)` —
  modify — gains optional `excludeSession` parameter.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No over-block risk. The excluded session is exclusively the sender's own
session, which echo prevention would reject downstream anyway. Excluding it
upstream does not prevent any message that was not already going to be
rejected. Cross-session and cross-agent routing are unaffected —
`excludeSession` matches on a specific session identity, not on any
heuristic.

The only behavior change is: messages that would have produced a confusing
`echo prevention` error now fall through to the `"best"` queueing path (same
behavior as when no session meets the matching threshold).

---

## 2. Under-block

**What failure modes does this still miss?**

Echo prevention (the authority) is unchanged. Any path that still ends up
with `from.session === to.session` will still throw. This change only
removes one upstream false-positive path; it does not weaken the check.

Not in scope for this change: the `"best"` queueing behavior itself when the
sender is the only candidate. Currently the message is enqueued as-is and
will be picked up by whatever drains the queue. If the drain re-runs
resolution and the sender is still the only candidate, it will re-enqueue.
The existing `"best"` queue semantics handle this — nothing about the fix
alters those semantics.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The resolver (`findBestSession`) is the right place to filter the
sender out of candidates — it's the layer that enumerates who could
receive, so it owns knowing who should not. Pushing the filter up into
`send` would duplicate sentinel internals; pushing it down into
`getActiveSessions` would couple unrelated subsystems to routing intent.

The echo-prevention check at the router level is the authority, and
remains the single authority. The resolver produces candidates and feeds
them forward; the authority gates the final send. Separation is preserved.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface.

Narrative: This change narrows a resolver — it removes one entry from a
candidate list by exact identity match. It does not add a new block path,
does not introduce a new authority, does not feed any signal to an existing
authority. The sole blocking authority involved here (echo prevention) is
untouched and remains the single gate for "cannot message yourself." We are
only preventing the resolver from generating input that would trip that gate
for a self-referential reason the user did not intend.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** The filter runs before echo prevention. It does not shadow
  the echo check — any remaining self-routing path (e.g., explicit
  `to.session = <mySessionId>`) still hits echo prevention exactly as
  before. The filter only intercepts the resolver-produced false positive.
- **Double-fire:** No. Only `send` calls `findBestSession`; the
  `excludeSession` plumbing is local to that one caller.
- **Races:** `findBestSession` reads the session registry synchronously and
  returns a ranked array. No shared mutable state is introduced. The race
  surface of the registry itself is unchanged.
- **Feedback loops:** None. The change does not affect what summaries get
  written or how they are scored — only which entries are visible to a
  given caller.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- Other agents on the same machine: unchanged — only the sender's own
  session is filtered, and only from that sender's own resolution call.
- Other users of the install base: behavior change is a bug fix — the error
  message `Cannot send a message to the same session (echo prevention)` for
  self-reply routing will no longer appear. Users who relied on that error
  as a signal (there are none — it was always a bug) are unaffected.
- External systems: none. No wire format changes, no new HTTP endpoints.
- Persistent state: none. The sentinel's summary store is unchanged, the
  message queue format is unchanged.
- Timing: none.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure code change in two source files and one test. Rollback = revert the
commit and ship a patch. No persistent state, no migration, no
user-visible regression during rollback window. Agents in the field continue
working — those that had been seeing the echo-prevention error will start
seeing it again (the pre-fix behavior), which is recoverable.

---

## Conclusion

The change is minimal, narrows an existing false-positive path, and
preserves the echo-prevention authority intact. No new block surface, no
new detectors, no signal-vs-authority violation. Cluster
`cluster-threadline-send-fails-with-echo-prevention-when-replying-to`
reported by luke @ v0.28.45 is resolved. Clear to ship as a patch.

---

## Evidence pointers

- `tests/unit/session-summary-sentinel.test.ts` — cases `excludes sender
  session from candidates` and `returns empty when the only candidate is
  the excluded sender`.
- Feedback cluster details: Portal feedback registry,
  `cluster-threadline-send-fails-with-echo-prevention-when-replying-to`.
