---
title: "Compaction-resume preamble prescribes calm acknowledgment + respond-to-last-message"
slug: "compaction-preamble-tone-and-intent"
author: "echo"
created: "2026-04-20"
supersedes: "none — follow-up to docs/specs/compaction-resume-payload.md"
review-convergence: "2026-04-20T19:50:00.000Z"
review-iterations: 1
review-completed-at: "2026-04-20T19:50:00.000Z"
approved: true
approved-by: "Justin"
approved-at: "2026-04-20T21:20:17.000Z"
approval-note: "Approved by Justin on Telegram topic 6795 after review of the private-view render of this spec."
---

# Compaction-Resume Preamble Tone + Intent Tightening

## Problem Statement

The prior fix (`compaction-resume-payload`, shipped as 0.28.52) closed the **information** failure of the compaction-recovery path: `COMPACTION_RESUME_PREAMBLE` now ships a rich context block (summary + recent messages + search hint) to the recovered agent. That fix shipped and recovered agents now have the context they need.

Two screenshots from topic 6795 on 2026-04-20 surfaced a **third** failure layer, one the prior fixes don't touch: the preamble text itself is too loose. The full preamble was:

> "Your session just went through context compaction — your working memory was reset. The context below is what you had before the reset. Briefly let the user know compaction occurred, then continue the conversation naturally."

Two observed failure modes, both on live 0.28.52 sessions:

1. **Tone failure (Mew / session-robustness topic, 12:12 PM)**. User asked a simple question about the /loop skill. Recovered agent opened with: "Quick heads-up: I lost track of what we were working on for a second, but I found my notes and caught back up." — then answered the question correctly. Agent HAD the context. Phrasing was the issue. "Let the user know" is open-ended, agents free-form narrate it with alarming language ("lost track", "got lost", "got confused").

2. **Intent failure (Bob / instar-agent-robustness topic, 12:04 PM)**. User's pre-compaction last message was "Your call." — a delegated decision. Recovered agent's response: a recap of the recent work + the same two choices offered before + "Your call." at the end. Infinite ping-pong. "Continue the conversation naturally" triggers a safe status-summary reflex instead of directing the agent to make the delegated decision.

## Root Cause

Open-ended instruction text in `COMPACTION_RESUME_PREAMBLE`. The rich context block from 0.28.52 gives the agent the raw material; the preamble tells the agent what to do with it. "Let the user know" and "continue naturally" are both too permissive — the agent has wide latitude, and under that latitude the default LLM behaviors are (a) hedge/apologize/narrate uncertainty and (b) reconstruct a plausible status summary with options.

## Proposed Fix

Rewrite `COMPACTION_RESUME_PREAMBLE` in `src/messaging/shared/compactionResumePayload.ts` with three explicit instructions, in order:

1. **First sentence must be a calm acknowledgment**: "your session paused for context compaction and has now resumed." Explicitly forbid "lost track", "got lost", "got confused", "lost your place".

2. **Then respond to the user's MOST RECENT message**. If a question, answer it. If a directive or delegated decision ("your call", "you decide", "proceed as you see fit"), make the decision and act — do NOT reconstruct a generic status summary, re-offer options already delegated, or hand the choice back.

3. **Assume full continuity**. Any work-in-progress, open commitments, or next steps recorded in the context are still the agent's to carry forward.

Mirror the same three-step instruction in `prepareInjectionText`'s over-threshold (file-reference) branch so long-context recoveries get identical guardrails to short ones.

## Non-Goals

- No change to `findLastRealMessage` or `isSystemOrProxyMessage` (0.28.51).
- No change to `topicMemory.formatContextForSession` (0.28.52).
- No outbound-message rewriting or tone-gate integration. Preamble is INPUT to the authority (recovered agent); the agent remains the sole authority on its response.
- No prompt-injection surface widening; the user's last message is already in the recovered agent's context via the 0.28.52 payload, and this spec does not change what context is provided — only how the agent is instructed to use it.

## Signal-vs-Authority

Not applicable. This change adds no decision point, no filter, no gate. It is instruction text fed to an existing LLM-backed authority (the recovered agent). Detectors remain detectors, authorities remain authorities.

## Acceptance Criteria

- `COMPACTION_RESUME_PREAMBLE` contains the prescribed acknowledgment phrasing ("paused for context compaction", "resumed") and explicit prohibitions ("do not say you 'lost track'/'got lost'/'got confused'").
- `COMPACTION_RESUME_PREAMBLE` explicitly directs the agent to respond to the user's most recent message, with special handling of delegated decisions.
- The calm acknowledgment appears BEFORE the respond-to-last-message instruction (order matters — first output must be the acknowledgment).
- `prepareInjectionText` over-threshold branch carries the same three instructions.
- Regression tests pin all invariants on both branches.

## Rollback

Pure text change in one file. Revert single commit, ship as next patch. No persistent state, no runtime flow change, zero agent-state repair.

## Evidence

- Topic 6795 screenshots 2026-04-20 (Mew 12:12 PM, Bob 12:04 PM).
- Thread context in `/tmp/instar-telegram/ctx-6795-1776712790539.txt`.
- Diagnosis confirmed by reading the shipped 0.28.52 preamble against both failure modes.
