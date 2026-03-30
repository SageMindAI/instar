# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Standby mode now detects and reports quota exhaustion.** When a session hits Claude's API usage limit ("You've hit your limit - resets 7pm"), the PresenceProxy now detects the quota message in the terminal output and reports it clearly to the user instead of giving generic "agent is still working" status updates.

Previously, when quota was hit, the standby system would send misleading LLM-generated updates like "echo is actively working" when in reality the session was frozen waiting for quota to reset. This wasted the user's time and eroded trust in the standby system.

The fix adds a pre-LLM check in all three standby tiers. When quota exhaustion patterns are detected in the terminal output:
- The LLM call is skipped entirely (saves tokens when quota is the issue)
- A clear message is sent: "The agent has hit its Claude API usage limit. Quota resets 7pm (America/Los_Angeles). The session is paused until then — no work is being done."
- Further tier escalation is cancelled (nothing more to assess)

## What to Tell Your User

- **Quota detection in standby**: "When your agent hits the Claude API limit mid-work, the standby system will now tell you clearly instead of pretending the agent is still working. You'll see the exact reset time so you know when work will resume."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Quota exhaustion detection in standby | Automatic — detects quota limit in terminal output across all standby tiers |
