# Upgrade Guide: Instar (latest)

## What Changed

### Stall Triage Nurse — Full Recovery Pipeline

The Stall Triage Nurse has been upgraded from a basic nudge-and-hope system to a comprehensive recovery pipeline that keeps the user informed at every step.

#### Intelligence Provider Wiring (Fixed)

Previously, the nurse was constructed without an intelligence provider, causing LLM diagnosis to always fail and fall back to a generic nudge. Now it properly receives an Anthropic API provider (preferred) or Claude CLI provider (fallback), enabling real LLM-powered diagnosis of stuck sessions.

#### Smarter Heuristic Fallback

When LLM diagnosis is unavailable, instead of always defaulting to nudge (the weakest action), the nurse now uses heuristics:
- Dead/missing session → immediate restart
- Error indicators in terminal output → restart
- 5+ minutes unresponsive → interrupt (skips nudge)
- Otherwise → nudge

#### Stricter Verification

Previously, any tmux output change after an action was treated as "recovered" — even just echoing a newline. Now the nurse checks for actual work indicators (tool calls, telegram-reply, significant output growth). A session that echoes a prompt line after a nudge but doesn't process the message is correctly identified as still stuck.

#### Force-Restart as Last Resort

After exhausting all escalation attempts, if `restart` wasn't already tried, the nurse now automatically restarts the session. Previously it would give up and the user would have to manually intervene.

#### User-Facing Status Messages Throughout

Every escalation step now sends a status message to the user:
- "That didn't work. Escalating — sending interrupt signal..."
- "That didn't work. Escalating — killing stuck process..."
- "Recovery attempts exhausted. Restarting session with full conversation context..."
- If all else fails: "I wasn't able to recover automatically. You can send a new message or use /restart."

#### Stall Tracking Cleanup (Fixed)

The `clearStallForTopic` dependency was a no-op — an empty function with a comment saying "will clear naturally." Now it properly calls `TelegramAdapter.clearStallTracking()`, ensuring stall tracking is cleaned up after recovery.

## What to Tell Your User

- **Automatic recovery with updates**: "When my session gets stuck, I'll now automatically try progressively stronger recovery actions — from nudging to interrupting to restarting. You'll see status messages explaining what's happening at each step. In most cases, you won't need to do anything."
- **Smarter diagnosis**: "I can now diagnose why a session is stuck and choose the right recovery action, instead of just trying a nudge and hoping for the best."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| LLM-powered diagnosis | Automatic — nurse now has access to intelligence provider |
| Heuristic fallback | Automatic — when LLM unavailable, uses terminal output analysis |
| Escalation status messages | Automatic — user sees each recovery step in Telegram |
| Force-restart safety net | Automatic — restarts session if all else fails |
| Stricter verification | Automatic — checks for real work activity, not just any output change |
| Stall tracking cleanup | Automatic — properly clears pending message tracking after recovery |
