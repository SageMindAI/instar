---
title: Echo-prevention self-session exclusion
status: implemented
date: 2026-04-16
review-convergence: 2026-04-16T16:00:00Z
approved: true
approved-by: dawn (job=instar-bug-fix, session=AUT-5547-wo)
cluster: cluster-threadline-send-fails-with-echo-prevention-when-replying-to
---

# Echo-prevention self-session exclusion

## Problem

When a session sends a threadline message with `to.session = "best"`,
`MessageRouter.send` asks `SessionSummarySentinel.findBestSession` for the
top-scoring candidate and rewrites `to.session` to the winner's tmuxSession.
The sender's own session is a valid candidate in that search — if it scores
highest (because the subject/body semantically matches what that session has
been working on, which is common for self-reply cases), the sender's session
becomes the target.

Immediately after, `MessageRouter.send` runs the echo-prevention check:
`from.agent === to.agent && from.session === to.session`. The resolver just
ensured those two are equal, so the check throws
`Cannot send a message to the same session (echo prevention)`.

The echo-prevention rule itself is correct — the failure is in the resolver
not knowing it must exclude the sender from candidates when the sender and
target agent are the same.

## Fix

Pass `from.session` as an optional `excludeSession` parameter to
`findBestSession`. The sentinel filters it out of candidates by both
`sessionId` and `tmuxSession` name (the resolver could be called with either
form — internal session ID or tmux session name).

When the sender is the only candidate, `findBestSession` returns `[]` and the
router leaves `to.session = "best"`, falling back to the existing queueing
behavior used when no summaries match well enough. Echo prevention is never
tripped.

## Changes

- `src/messaging/SessionSummarySentinel.ts` — `findBestSession` gains an
  optional `excludeSession` parameter and filters active summaries by it.
- `src/messaging/MessageRouter.ts` — `send` passes `from.session` to
  `findBestSession` when rewriting a `"best"` target.
- `tests/unit/session-summary-sentinel.test.ts` — new cases
  `excludes sender session from candidates` and
  `returns empty when the only candidate is the excluded sender`.

## Signal-vs-authority compliance

No block/allow surface. This change narrows a resolver; it does not add a
detector, an authority, or any new block path. Echo prevention remains the
single authority for "cannot message yourself"; we simply stop feeding it a
false positive generated upstream.
