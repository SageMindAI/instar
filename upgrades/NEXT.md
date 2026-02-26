# Upgrade Guide — vNEXT

## What Changed

### Auto-Detect Existing Agents on New Machine Setup

When running `npx instar` on a new machine, the setup wizard now proactively scans for existing agents before offering to create a new one:

1. **Local scan**: Checks `~/.instar/agents/` for standalone agents already on this machine
2. **GitHub scan**: Runs `gh repo list` to find `instar-*` backup repositories on the user's GitHub

If existing agents are found, the wizard presents them as restore options:

> I found existing agents on your GitHub: my-agent, work-bot.
> Want to restore one of these?

**Restore Flow**: Clone from GitHub, update machine-specific config (paths, ports), register in local agent registry, install auto-start, start server. The agent arrives on the new machine with all memories and identity intact.

### Setup Launcher Detection Improvements

The `setup.ts` launcher now passes richer detection context to the wizard:
- Existing standalone agents on this machine (names and paths)
- GitHub backup repos found via `gh` CLI
- This information is passed in the Claude session prompt so the wizard can act on it immediately

Previously, the launcher only checked the current working directory for `.instar/config.json`, which missed all standalone agents.

## What to Tell Your User

If you've set up cloud backup, your agent now travels with you. Run `npx instar` on any new machine and the wizard will find your agent's backup on GitHub and offer to restore it. All memories, identity, and configuration come with it — only machine-specific paths get updated.

## Summary of New Capabilities

- **GitHub agent scanning**: Setup wizard auto-discovers `instar-*` repos on user's GitHub
- **Local agent scanning**: Detects existing standalone agents at `~/.instar/agents/`
- **Restore Flow**: Full automated restore from GitHub backup to local agent
- **Richer detection context**: Setup launcher passes standalone and GitHub data to wizard
