# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

PresenceProxy — the standby system that emits 20s / 2m / 5m progressive
status updates while an agent is busy — had two regressions that made
the feature look broken even though the timer machinery was still in
place.

**Layer A — Brief acks no longer cancel tier timers.** Recent guidance
told every Telegram/Slack/iMessage agent to send an immediate
acknowledgement ("Got it, looking into this") on every inbound user
message. The proxy treated that ack as the agent's response and
silently cancelled every pending tier check. Result: progressive
20s/2m/5m updates stopped firing entirely — the user got an immediate
"On it" and then radio silence until the real reply arrived.

PresenceProxy now classifies short, forward-looking acks ("On it",
"Got it, looking into this", "I'll dig into that") as non-cancelling.
The classifier is length-bounded (≤ 200 chars) and opener-only (the
ack phrase has to appear in the first 60 chars), so a substantive
multi-sentence reply that happens to mention "I will…" deep in the
body is NOT misclassified.

**Layer B — Tier prompts now scope to post-message activity.** The
prompts that built the tier-1/2/3 status messages read whatever was
visible in the agent's tmux pane right then, which is the rolling
window — so older work from BEFORE the user's latest message often
dominated the snapshot. The user got summaries describing pre-message
work instead of "what the agent is doing in response to my message."

PresenceProxy now captures a baseline tmux snapshot at the instant
the user message arrives (`userMessageBaselineSnapshot`). The four
prompt builders (Tier 1, conversation, Tier 2, Tier 3) anchor on the
baseline and feed only the post-baseline delta to the LLM, with an
explicit "[scope: only output that appeared AFTER the user's message
arrived]" header. If the baseline anchor scrolled off the visible
pane (very busy build), we fall back to the full pane with a
labelled scope tag.

## What to Tell Your User

- **The 20-second / 2-minute / 5-minute progressive standby updates
  are working again**: When your agent is busy and you message it,
  you'll once more get a status update at the 20-second mark, then
  another at 2 minutes, then a stall assessment at 5 minutes. The
  agent's brief ack right after your message no longer turns those
  off.
- **Standby summaries finally describe what the agent is doing in
  response to your latest message**: Before, the standby update
  could summarize work the agent was already doing before your
  question arrived. Now the proxy anchors on the moment your
  message hit and only describes activity since.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Brief-ack tolerance — tier timers survive "On it" / "Got it" replies | Automatic. Substantive replies still cancel timers as before; only short forward-looking acks are now treated as non-cancelling. |
| Post-message scope — standby summaries describe only activity AFTER your latest message | Automatic. Captured at the moment your message arrives; baseline is in-memory only and survives a session restart by falling back to the legacy full-pane scope. |

## Evidence

- Repro source: user report on topic 8882 (2026-05-04T03:52Z) —
  "this feature no longer seems to give progressive updates such as
  the 5, 10, 15 min mark like it used to" + "the messages from
  standby mode often seem to be summarizing what the agent was
  working on BEFORE the user's last message."
- Root cause for #1: `handleAgentMessage` was called from
  `onMessageLogged` for every non-system, non-proxy outbound
  message. The Telegram-bridge instruction to ack immediately on
  inbound meant every user message produced an immediate
  cancellation before tier 1 had a chance to fire.
- Root cause for #2: tier prompts at lines 1192/1211/1244/1271 in
  `src/monitoring/PresenceProxy.ts` passed the raw rolling tmux
  pane to the LLM with no boundary marker for "what was visible at
  user-message arrival."
- Side-effects review at
  `upgrades/side-effects/presence-proxy-ack-and-baseline.md`
  covers over/under-block for the brief-ack filter,
  level-of-abstraction fit, signal-vs-authority compliance,
  interactions with CompactionSentinel / PromiseBeacon /
  ProxyCoordinator, and rollback cost.
- 15 new unit tests in
  `tests/unit/presence-proxy-ack-and-baseline.test.ts` covering
  `isBriefAck` (5), `extractDeltaSinceBaseline` (5), brief-ack
  handling end-to-end (3), baseline capture (2). All 64 prior
  PresenceProxy unit tests + 64 e2e tests still pass after
  updating two e2e tests to use clearly-substantive agent replies
  (the prior fixtures were short messages now correctly classified
  as acks).
