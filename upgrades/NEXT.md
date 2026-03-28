# Upgrade Guide — v0.24.16

## What Changed

### Presence Proxy (Standby)

New monitoring subsystem that provides intelligent status updates when an agent session is too busy to respond to Telegram messages.

**Three-tiered response system:**
- **Tier 1 (20s):** Haiku summarizes what the agent is currently doing based on terminal output
- **Tier 2 (2min):** Haiku compares progress since Tier 1, reports what changed
- **Tier 3 (5min):** Sonnet performs deep stall assessment — determines if the agent is genuinely stuck or running a legitimate long process. Offers user recovery options if stalled.

**Conversation mode:** When the proxy is active and the user sends follow-up messages, the proxy can answer questions about what the agent is doing based on terminal output.

**Security hardening:**
- Tmux output sanitized before LLM calls (ANSI codes, credentials, injection patterns stripped)
- LLM output guarded (URLs, commands, credential requests blocked)
- Telegram sender authentication for action commands (unstick/restart/quiet)
- Proxy messages don't reset StallDetector timers (isProxy flag)
- Race condition guard checks message log before each tier fires

**Integration:**
- Coordinates with StallTriageNurse via triage mutex (prevents double-intervention)
- State persists to disk for restart recovery
- LLM calls capped at 3 concurrent with queue, rate-limited per topic

**Configuration:** Activates automatically when `sharedIntelligence` and Telegram are available. Configurable under `monitoring.presenceProxy` in config.json.

### StallDetector Integration Fix

`POST /telegram/reply/:topicId` now accepts optional `metadata` field with `isProxy: true`. When set, the endpoint skips `clearInjectionTracker()` and `clearStallForTopic()` — ensuring proxy messages don't interfere with existing stall detection.

### TelegramAdapter

Added `skipStallClear` option to `sendToTopic()` to prevent proxy messages from resetting stall tracking timers.

## What to Tell Your User

Your agent now has a "standby assistant" that keeps you informed when the agent is busy working on something. If you send a message and don't get a response within 20 seconds, you'll see a 🔭 status update describing what the agent is doing. You can even ask follow-up questions and the standby will answer based on what it can see in the agent's terminal. At 5 minutes, it checks whether the agent is genuinely stuck and offers recovery options if needed.

## Summary of New Capabilities

- **Presence Proxy:** Tiered status updates (20s/2min/5min) when agent is busy
- **Conversation mode:** Proxy can answer user questions about agent activity
- **Stall assessment:** Intelligent stuck-vs-working detection at 5 minutes
- **User commands:** quiet, resume, unstick, restart — with authentication
- **42 e2e tests** covering all tiers, sanitization, conversation mode, and edge cases
