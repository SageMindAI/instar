# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Setup wizard Entry Point B no longer uses `AskUserQuestion` for the agent selection step. The multichoice overlay in Claude Code's terminal was hiding the agent summary text above it, causing users to miss agents that were listed but visually truncated.

The fix:
- `buildAgentSummary()` now generates inline numbered options (e.g., "1. Restore bob", "2. Restore dude", "3. Start fresh") as part of the deterministic summary text.
- The skill instructions now say "DO NOT use AskUserQuestion here" and instead tell the wizard to display the summary verbatim and wait for the user to type their choice.
- This eliminates the overlay-hiding-context problem entirely.

## What to Tell Your User

- **Setup wizard improvement**: "The agent discovery screen now shows all your options inline instead of in a popup menu. Everything is visible at once — no more hidden agents."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Inline agent selection | Automatic — just run `npx instar` |
