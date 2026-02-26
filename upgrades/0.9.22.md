# Upgrade Guide — vNEXT

## What Changed

### Anti-Confabulation Infrastructure (Convergence Check Pipeline)

The grounding-before-messaging hook has been upgraded from a simple text reminder ("remember who you are") to a **full three-phase defense pipeline**:

1. **Identity injection** — Injects full AGENT.md content directly into context before any external message
2. **Convergence check** — Heuristic quality gate that scans outgoing messages for 6 failure modes
3. **URL provenance verification** — Flags URLs with unfamiliar domains that may be fabricated

**New convergence check category: URL Provenance (Category 6)**

Agents commonly confabulate plausible-looking URLs by pattern-matching from project names — e.g., a project called "deep-signal" produces "deepsignal.xyz" in outgoing messages. The convergence check now extracts all URLs from outgoing messages and flags any with domains not in a curated allowlist of well-known services (GitHub, Vercel, npm, Cloudflare, etc.).

This check runs **automatically** before every external message (Telegram, email, API posts). Structure > Willpower.

**New CLAUDE.md gravity wells:**
- **"Defensive Fabrication"** — Warns agents about the doubling-down pattern: when caught in an error, constructing a plausible excuse ("the CLI returned that URL") instead of admitting the fabrication
- **"Output Provenance"** — Every URL, status code, or data point in an outgoing message must be traceable to actual tool output in the current session

**New CLAUDE.md anti-pattern:**
- **"Cite Without Source"** — Anti-pattern for including URLs/data in messages without verifying they came from tool output

### Technical Details

- `convergence-check.sh` now installed at `.instar/scripts/convergence-check.sh` during both fresh setup and auto-update
- `grounding-before-messaging.sh` upgraded to call the convergence check pipeline (blocking: exit 2 on failure)
- `src/templates` now included in npm package for template file access

## What to Tell Your User

Your agent now has structural protection against URL fabrication and other forms of confabulation in outgoing messages. Before sending any Telegram message, email, or API post, your agent's messages are automatically scanned for common failure modes including fabricated URLs, unsupported capability claims, and experiential fabrication. This runs automatically — no configuration needed.

## Summary of New Capabilities

- **URL provenance check**: Outgoing messages are scanned for fabricated URLs before sending
- **Full convergence check pipeline**: 6-category quality gate runs before every external message
- **Identity injection before messaging**: Full AGENT.md content injected, not just a reminder to re-read it
- **New gravity wells**: "Defensive Fabrication" and "Output Provenance" teach agents about confabulation patterns
