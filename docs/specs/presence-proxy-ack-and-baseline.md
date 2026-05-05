---
title: "PresenceProxy — brief-ack tolerance + post-message baseline"
slug: "presence-proxy-ack-and-baseline"
author: "echo"
review-iterations: 1
review-convergence: "2026-05-05T04:30:00Z"
review-completed-at: "2026-05-05T04:30:00Z"
approved: true
approved-by: "justin"
approved-at: "2026-05-05T03:52:00Z"
incident-origin: "topic 8882 (justin), 2026-05-05 03:52 UTC"
---

# PresenceProxy — brief-ack tolerance + post-message baseline

**Status:** spec — bug fix driven by direct user report
**Owner:** Echo
**Date:** 2026-05-05
**Incident origin:** Justin's report on topic 8882 (2026-05-05T03:52Z)

## Problem

Justin reported two regressions in the standby (PresenceProxy) feature:

1. **No more progressive 5/10/15 min updates.** The 20-second / 2-minute /
   5-minute progressive standby updates that fire while the agent is busy
   stopped firing for Telegram-bridged agents.
2. **Standby summaries describe pre-message work.** The standby messages
   often summarize what the agent was working on BEFORE the user's latest
   message, instead of what the agent is doing IN RESPONSE to the message.

## Root cause analysis

### #1 — Brief acks were cancelling tier timers

Recent guidance instructed every Telegram/Slack/iMessage agent to send an
immediate acknowledgement ("Got it, looking into this") on every inbound
user message. PresenceProxy.onMessageLogged treats every non-system,
non-proxy outbound message as the agent's response and calls
handleAgentMessage, which sets state.cancelled = true and clears all tier
timers. So the first ack the agent sent silently killed all 3 pending
tier checks.

### #2 — No boundary marker for post-message scope

The four tier prompt builders (Tier 1 status, conversation, Tier 2 progress,
Tier 3 stall assessment) at lines 1192/1211/1244/1271 of PresenceProxy.ts
fed the rolling tmux pane directly to the LLM with no anchor for "what was
visible at user-message arrival." The pane contains pre-message work in
its top portion and post-message work at the bottom; the LLM
naturally summarized whichever was more visually dominant.

## Fix

### Layer A — `isBriefAck()` filter

Add `isBriefAck(text)` — a pure exported function that classifies short
forward-looking acks as non-cancelling. PresenceProxy.onMessageLogged
records the ack on conversation history but skips handleAgentMessage when
the message looks like an ack.

Heuristic (intentionally conservative on length, opener-only on phrasing,
because false positives produce one extra standby message — cheap — and
false negatives are exactly the bug we're fixing):

- Empty / whitespace → not ack
- Length ≤ 12 → ack regardless
- Length > 200 → never ack (substantive replies tend to be longer)
- Otherwise: pattern must match within the FIRST 60 characters
  (so a 200-char substantive reply that mentions "I will…" deep in the
  body is correctly classified as substantive)

Pattern list emphasizes openers: "On it", "Got it", "I'll dig/look/check",
"Looking into", "Digging in", "Investigating", "Let me check/look/see",
"Working on it/this/that", "More coming/soon", "Sharing the diagnosis".

### Layer B — `userMessageBaselineSnapshot` + delta scoping

Add `userMessageBaselineSnapshot: string | null` to PresenceState.
PresenceProxy.handleUserMessage captures a sanitized tmux snapshot at the
moment the user message arrives and stores it on state.

Add `extractDeltaSinceBaseline(current, baseline)` — pure exported
function that anchors on the last 8 non-empty lines of the baseline and
returns everything in `current` after the anchor. Falls back to the full
current snapshot (with anchored=false) when the anchor scrolls off the
visible pane.

Add private method `buildScopedSnapshotBlock(state, current, maxChars)`
that the four tier prompt builders use in place of `snapshot.slice(0, N)`.
The block is labelled `[scope: only output that appeared AFTER the
user's message arrived]` when anchored, or `[scope: full pane — baseline
anchor scrolled off]` on fallback. The prompts now instruct the LLM to
"base your summary ONLY on activity after the user's message; ignore any
work the agent was doing before."

Baseline is intentionally NOT persisted to disk (consistent with the
existing tier1Snapshot / tier2Snapshot policy — too large, potentially
sensitive). After a session restart, recoverFromRestart sets baseline to
null and prompts use the full-pane fallback path.

## Decision-point inventory

The change touches one decision point: PresenceProxy's "is this agent
message a real response?" predicate, which gates timer cancellation.
isSystemOrProxyMessage is already shared with several other subsystems
(compaction recovery, stall triage, log scans); we do NOT modify that
helper. Brief acks ARE real agent messages — they just shouldn't end the
standby cycle. So the new check lives inside PresenceProxy's
onMessageLogged branch only.

## Signal vs authority

`isBriefAck` is a brittle pattern-matching filter — a SIGNAL, not an
authority. It does not block cancellation outright; it withholds the
cancellation that the proxy was about to perform. The "authority" in the
flow remains the natural one: either a substantive reply lands and
cancels timers, or the LLM-backed prompt builder produces a tier message
with full conversation-history context. No brittle filter makes a final
decision on user experience.

Baseline scoping is also a signal-shaping change, not an authority change.
The LLM still decides what to say in the tier message; we just narrow
the input so the decision happens on the right context.

## Test coverage

15 new unit tests in tests/unit/presence-proxy-ack-and-baseline.test.ts:

- `isBriefAck` (5): very short, opener acks, substantive reply, empty,
  length cap.
- `extractDeltaSinceBaseline` (5): empty baseline, null current, anchor
  found, no new activity, anchor missing.
- `PresenceProxy brief-ack handling` (3): ack keeps timers running,
  substantive reply cancels, multiple acks then substantive.
- `PresenceProxy baseline capture` (2): baseline captured at arrival,
  capture failure does not crash.

All 64 prior PresenceProxy unit tests + 64 e2e tests still pass after
updating two e2e tests that used short messages now correctly classified
as acks.

## Rollback cost

Single-file revert + test deletion. No schema changes, no on-disk
artifacts, no API contract changes. Empty BRIEF_ACK_PATTERNS to match
v0.28.79 behavior, or revert the entire commit.

## Convergence note

Bug fix with direct user repro and a clear two-layer root cause. No
multi-angle review iteration needed beyond the single-pass side-effects
review at upgrades/side-effects/presence-proxy-ack-and-baseline.md
(over/under-block, level of abstraction, signal-vs-authority,
interactions with adjacent subsystems, rollback cost). Approved by
Justin via topic 8882 message describing the desired behavior in detail.
