# Upgrade Guide — v0.24.17

## What Changed

### PromptGate: LLM-Based Prompt Detection

PromptGate now uses Haiku for intelligent prompt detection alongside regex patterns. The brittle regex-based plan detection (which produced false positives on git commit messages and other multi-line output) has been replaced with an LLM classification path.

**How it works:**
- Simple structural prompts (y/n confirmations, file creation, Esc-to-cancel) still use fast regex matching
- Complex prompts (plans, ambiguous approval requests) are detected by Haiku after quiescence gating (3+ stable captures)
- LLM calls are deduplicated per session — only one pending detection per session at a time
- Falls back to regex-only if no intelligence provider is configured

**Configuration:** Pass an `intelligence` provider in `InputDetectorConfig` to enable LLM detection. Without it, behavior is unchanged from v0.24.16.

### PromptGate: Callback Query Forwarding

The Telegram lifeline now forwards callback queries (button presses from prompt-gate inline keyboards) to the Instar server for processing. Previously, button responses were handled entirely in the lifeline process.

### PromptGate: False Positive Reduction

- Claude Code status bar output (model info, token counts, cost displays) is now filtered before detection to prevent spurious prompt alerts
- Compact button format for Telegram inline keyboards
- Claude Code plan prompts correctly routed through LLM path instead of regex

### Dashboard: Systems Tab Redesign

The dashboard Systems tab has been redesigned for a user-friendly health view with improved layout and readability.

## What to Tell Your User

Prompt detection is now smarter. Previously, the system sometimes sent false alerts — especially when the agent was writing git commits or outputting plan-like text. Now, complex prompts are verified by an LLM before alerting you, which means fewer interruptions and more accurate notifications. Simple prompts (yes/no, file creation) are still instant. No configuration changes needed unless you want to opt into LLM detection — just provide an intelligence provider in your config.

## Summary of New Capabilities

- **LLM-based prompt detection:** Haiku classifies ambiguous prompts, eliminating regex false positives
- **Callback query forwarding:** Prompt button presses relay from lifeline to server
- **Status bar filtering:** Claude Code UI noise no longer triggers false prompt alerts
- **Dashboard redesign:** Systems tab with improved health visualization
