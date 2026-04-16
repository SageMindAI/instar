# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Fixed echo-prevention false positive in `MessageRouter` when resolving `to.session === "best"` for self-directed routing. The best-session resolver could pick the sender's own session as the top candidate, which then immediately tripped the echo-prevention guard and threw `Cannot send a message to the same session (echo prevention)`.

`MessageRouter.send` now passes `from.session` to `SessionSummarySentinel.findBestSession` as an exclusion, so the sender's own session can never be selected as the routing target. When the sender is the only active candidate, the resolver returns no matches and the router leaves `to.session = "best"` for queueing — the same behavior used when no summaries match well enough.

## What to Tell Your User

- **Smarter message routing**: "If you've ever seen an agent throw an 'echo prevention' error when it tried to message itself or hand off to a related session, that's fixed. I won't accidentally route a message back to my own live session anymore."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Self-session exclusion in best-session routing | Automatic — no configuration needed |

## Evidence

Reproducible via the new `session-summary-sentinel.test.ts` cases:
- `excludes sender session from candidates` — confirms the sender's own session is dropped from results when `excludeSession` is passed, even though its score would otherwise qualify.
- `returns empty when the only candidate is the excluded sender` — confirms the router falls back to queueing as `best` instead of triggering echo prevention.

Feedback cluster: `cluster-threadline-send-fails-with-echo-prevention-when-replying-to` (reported by luke @ v0.28.45).
