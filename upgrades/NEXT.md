# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Tightens the instruction prompt injected into a session after context compaction. Two empirical failure modes on active sessions (topic 6795, 2026-04-20) drove this change:

1. **Tone failure**: recovered agents self-narrated compaction as "I lost track of what we were working on" / "I got lost for a second" — alarming phrasing for what was a routine pause-and-resume. The agent had full context; the phrasing was the issue.
2. **Intent failure**: when the user's last message was a delegated decision ("Your call"), recovered agents regenerated a status summary and re-offered the same options — handing "Your call" back to the user for an infinite ping-pong.

Both traced to a single loose line in `COMPACTION_RESUME_PREAMBLE`: "Briefly let the user know compaction occurred, then continue the conversation naturally." Open-ended "let the user know" produced free-form alarming narration; "continue naturally" triggered the status-summary reflex.

Fix: `COMPACTION_RESUME_PREAMBLE` in `src/messaging/shared/compactionResumePayload.ts` now:

- Prescribes the acknowledgment phrasing: "your session paused for context compaction and has now resumed." Explicitly forbids "lost track," "got lost," "got confused," "lost your place."
- Directs the agent to respond to the user's **most recent message** — answer questions, make delegated decisions, do NOT reconstruct a generic status summary or re-offer options already delegated back.
- Instructs the agent to assume continuity with any in-progress work in the context block.

The over-threshold (file-reference) branch in `prepareInjectionText` carries the same guardrails, so long-context recoveries get the same instruction as short ones.

No change to `findLastRealMessage` (0.28.51), `isSystemOrProxyMessage` (0.28.51), `formatContextForSession` (0.28.52), or any other compaction-recovery plumbing. Pure preamble text change + 7 new regression tests (18 total on the file).

## What to Tell Your User

- **Calmer compaction recoveries**: "When I pause to compress older parts of our conversation and come back, I won't say alarming things like 'I lost track' or 'I got confused' — because I didn't. It's a routine pause, and I'll just tell you that."
- **No more ping-pong on delegated decisions**: "If you hand a decision back to me and I happen to pause for compaction right after, when I come back I'll actually make the call instead of re-offering you the same choices."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Tighter compaction-recovery tone | Automatic — applies to every session recovery on 0.28.66+ |

## Evidence

Reproduction: topic 6795 on 2026-04-20, two screenshots at ~12:04 PM and ~12:12 PM showing both failure modes on active sessions running 0.28.52.

- Mew topic (session-robustness): recovered agent opened with "Quick heads-up: I lost track of what we were working on for a second, but I found my notes and caught back up" — user flagged as alarming.
- Bob topic (instar-agent-robustness): user had said "Your call." Recovered agent's response ended with "Your call." on the same two options — infinite delegation ping-pong.

Root cause traced to the open-ended phrasing of `COMPACTION_RESUME_PREAMBLE` in 0.28.52. After the fix in 0.28.66, the preamble explicitly prohibits the alarming self-narration phrases and explicitly requires responding to the user's most recent message (including making delegated decisions). 18 unit tests pin the invariants (presence, order, prohibition language, file-reference branch parity).

Cannot reproduce the end-to-end tone failure in an automated dev test without spinning up a real compaction event, which requires a long-running session — the unit tests are the strongest evidence achievable without waiting for a natural compaction in an active session. Live verification will come from the next compaction on the affected topics once the hot-patch lands.
