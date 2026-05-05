---
title: PresenceProxy — brief-ack tolerance + post-message baseline
slug: presence-proxy-ack-and-baseline
date: 2026-05-04
author: echo
second_pass_required: false
---

## Summary of the change

PresenceProxy emits tiered standby updates (20s / 2m / 5m) when an agent
hasn't replied to a user message yet. Two regressions had silently
broken the user-facing behavior:

1. **Brief acks were cancelling all tier timers.** Telegram-bridged agents
   are now instructed to send an immediate ack ("Got it, looking into
   this", "On it") on every inbound message. The proxy interpreted that
   ack as the agent's response and cancelled every pending tier check.
   Result: the user never saw a 20s/2m/5m progressive update again — the
   feature looked broken even though the timer machinery was intact.

2. **Tier-summary prompts described pre-message work.** The prompts
   read whatever was visible in the agent's tmux pane right now, which
   is the rolling window — so older work from BEFORE the user's latest
   message often dominated the snapshot. The user got summaries of work
   the agent was already doing, not work the agent was doing in response
   to their message.

This change adds two things:

- `isBriefAck(text)` — a length-bounded, opener-only pattern matcher that
  classifies short forward-looking acks ("On it", "Got it, looking into
  this") as non-cancelling. `onMessageLogged` now skips the cancellation
  branch for brief acks (still records them on conversation history so
  subsequent prompts know an ack went out).
- `userMessageBaselineSnapshot` on `PresenceState`, captured in
  `handleUserMessage` at the moment the user message arrives. Plus an
  `extractDeltaSinceBaseline()` helper and a `buildScopedSnapshotBlock()`
  method that the four tier-prompt builders now use to feed the LLM only
  the post-baseline delta.

Files touched:
- `src/monitoring/PresenceProxy.ts` — new helpers, baseline capture,
  ack-aware message handling, scoped prompt blocks.
- `tests/unit/presence-proxy-ack-and-baseline.test.ts` — 15 new tests
  across `isBriefAck`, `extractDeltaSinceBaseline`, brief-ack handling,
  and baseline capture.

## Decision-point inventory

The change touches one decision point: PresenceProxy's
"is this agent message a real response?" predicate, which gates timer
cancellation. `isSystemOrProxyMessage` was already shared with several
other subsystems (compaction recovery, stall triage, log scans); we
intentionally did NOT modify that helper. Brief acks ARE real agent
messages — they just shouldn't end the standby cycle. So the new check
lives inside PresenceProxy's `onMessageLogged` branch only and does not
leak into other subsystems' definition of "real reply."

---

## 1. Over-block

The brief-ack filter is the only thing that could over-block. The
"block" here is "block cancellation" — i.e., a real substantive reply
gets misclassified as an ack and tier timers keep running. The user
sees one extra standby message after the agent has already answered.

Mitigations:

- **Length cap of 200 chars.** Substantive replies tend to be longer.
  200 is generous enough to cover compound acks ("Got it — looking into
  both: foo and bar. On it.") but tight enough to exclude short
  substantive answers in practice.
- **Opening-only match (first 60 chars).** Patterns like `\bi['']?ll\s+(?:dig|look|...)` only fire when the message STARTS with that
  phrase — a 200-char substantive reply that mentions "I'll get to that
  next" deep in the body won't match.
- **Conservative pattern list.** Generic "I will" / "let me" alone is
  not enough — must be followed by an action verb (`dig`, `look`,
  `check`, etc.). This was tightened in response to a failing test that
  caught an over-match on a 267-char substantive plan.

Worst case: tier 1 fires after a real reply, the user sees one
"🔭 the-agent is currently …" message immediately after the substantive
answer. No data loss, no repeated tier 2/3 because tier 1 reads the
post-message terminal pane (which now contains the substantive reply)
and produces a brief, accurate snapshot summary. Then the timers re-arm
on the next user message.

---

## 2. Under-block

Under-blocking the cancellation = a real substantive reply incorrectly
classified as ack → timers fire when they shouldn't. Covered above.

The other direction is "ack misclassified as substantive" → timers
cancel as before, user sees no progressive updates. This is the bug we
were already living with; our change can't make it worse than the
status quo.

---

## 3. Level-of-abstraction fit

Both new helpers are pure, exported, and live next to the other
detectors (`detectQuotaExhaustion`, `detectSessionIdle`,
`isLongRunningProcess`) in PresenceProxy.ts — same level of abstraction
the file already operates at. No new modules, no new framework, no new
queue. The state field (`userMessageBaselineSnapshot`) is a sibling of
existing snapshot fields. The prompt-scoping helper
(`buildScopedSnapshotBlock`) is a private method on the proxy class,
co-located with the four prompt builders that consume it.

The baseline snapshot is intentionally NOT persisted to disk
(consistent with the existing policy for `tier1Snapshot` /
`tier2Snapshot`) — too large, contains potentially sensitive content,
and a session restart loses the original user-message moment anyway.
After restart, `recoverFromRestart` sets the baseline to null and
prompts fall back to the legacy "full pane" path with a `[scope: full
pane — baseline anchor scrolled off]` label.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **`isBriefAck` is a brittle pattern-matching filter — a SIGNAL,
      not an authority.** It does not block cancellation outright; it
      simply withholds the cancellation that the proxy was about to
      perform. The "authority" in this flow remains the natural one:
      either a substantive reply lands and cancels timers, or the
      agent's tier message comes from the LLM-backed prompt builder
      (which has full context of conversation history). No brittle
      filter is making a final decision on user experience.
- [x] **Baseline scoping is also a signal-shaping change**, not an
      authority change. The LLM still decides what to say in the tier
      message; we just narrow the input so the decision happens on the
      right context. If the baseline anchor can't be located, we
      conservatively widen back to the full pane and label the prompt
      so the LLM knows scope is best-effort.

The dangerous failure mode in this kind of work is "brittle filter
silently determines the user-facing outcome." Both fixes are
specifically scoped to AVOID that: false positives on `isBriefAck`
produce a slightly redundant user message (recoverable in the next
message); false positives on the baseline anchor produce slightly less
focused tier summaries (no worse than the pre-change behavior).

---

## 5. Interactions with adjacent subsystems

- **CompactionSentinel.recoverFn** uses `findLastRealMessage` /
  `isSystemOrProxyMessage` to decide whether to re-inject after
  compaction. We did NOT modify those helpers — brief acks are still
  considered "real" by that subsystem (which is correct: an ack IS a
  real outbound message that the user saw). Only PresenceProxy's
  cancellation logic treats brief acks specially.
- **PromiseBeacon / shared LLM queue** — unchanged. Tier messages still
  go through the same `interactive` lane and respect the daily spend
  cap.
- **ProxyCoordinator mutex** — unchanged. The mutex acquisition order
  in `sendProxyMessage` is the same; we only changed prompt content
  and added a new pre-cancel branch.
- **Persisted state files** — schema unchanged; the new
  `userMessageBaselineSnapshot` is an in-memory-only field. Existing
  state files still load correctly (the spread in `recoverFromRestart`
  picks up undefined for the new field, then we explicitly set it to
  null).
- **Tier 1 fallback (no LLM, intelligence: null)** — unchanged. Falls
  back to the same templated message; the new snapshot scoping only
  affects the LLM prompt, never the fallback path.

---

## 6. Rollback cost

Single-file revert + test deletion. No schema changes, no on-disk
artifacts, no API contract changes. If the brief-ack filter
misbehaves in production we can:

1. Empty the `BRIEF_ACK_PATTERNS` array — every agent message is
   substantive again, behavior matches v0.28.79.
2. Or revert the entire commit — same outcome, plus the prompts go
   back to full-pane scope.

Both rollbacks are atomic and require no migration.

---

## 7. Test coverage

New tests in `tests/unit/presence-proxy-ack-and-baseline.test.ts`:

- `isBriefAck` (5 tests):
  - very short messages always ack
  - forward-looking phrases under 200 chars are acks
  - substantive multi-sentence replies (267 chars) are NOT acks
  - empty/null/whitespace not classified as ack
  - 280-char substantive cap (boundary)

- `extractDeltaSinceBaseline` (5 tests):
  - null/empty baseline → full current
  - null current → empty
  - anchor found → returns post-anchor content, anchored=true
  - identical baseline+current → hasNewActivity=false
  - anchor missing (terminal scrolled) → falls back to full current,
    anchored=false

- `PresenceProxy brief-ack handling` (3 tests):
  - tier 1 + tier 2 both fire after brief ack
  - substantive reply DOES cancel tiers
  - multiple acks in sequence don't cancel; substantive reply finally does

- `PresenceProxy baseline capture` (2 tests):
  - baseline captured at user-message arrival
  - capture failure doesn't crash, baseline stays null

All 64 pre-existing PresenceProxy tests still pass — no regression in
cancel-race, build-heartbeat suppression, idle detection,
context-exhaustion, quota detection, or long-tool-wait paths.

---

## 8. Evidence

- Repro source: Justin's message in topic 8882 (2026-05-04, 03:52
  UTC) reporting "this feature no longer seems to give progressive
  updates" and "messages from standby mode often seem to be
  summarizing what the agent was working on BEFORE the user's last
  message."
- Root cause for #1: `handleAgentMessage` is called from
  `onMessageLogged` for any non-system, non-proxy outbound message.
  Telegram bridge instructions added an "On it" ack as the first
  outbound message on every inbound user message → cancellation
  fires before tier 1 can run.
- Root cause for #2: tier prompts at lines 1192/1211/1244/1271
  passed `snapshot.slice(0, 3000)` directly. The snapshot is the
  full visible pane, with no boundary marker for "what was here
  when the user's message arrived."

---

## 9. What this does NOT change

- Tier 1 / 2 / 3 timing (still 20s / 2m / 5m by default).
- LLM cost or model selection.
- Persistence schema or on-disk state files.
- `isSystemOrProxyMessage` / `findLastRealMessage` (shared with
  compaction + stall triage).
- Conversation-history capping.
- Proxy mutex acquisition / release semantics.
- `triggerManualTriage`, unstick, restart, quiet, resume command flows.

The change is intentionally surgical: two well-defined behaviors
(timer cancellation predicate + prompt input scoping) modified in
their natural locations, with new pure helpers exposed for direct
testing.
