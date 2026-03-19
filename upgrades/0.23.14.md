# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- **Dashboard link auto-refresh**: New `POST /telegram/dashboard-refresh` endpoint triggers the existing dashboard URL edit-in-place logic. Paired with a new `dashboard-link-refresh` job that runs every 5 minutes (no LLM, just a curl). If the tunnel URL hasn't changed, Telegram silently skips the edit.
- **Lifeline 429 handling**: The `apiCall` helper in lifeline now recognizes HTTP 429 (rate limit) responses and backs off automatically instead of treating them as hard failures.
- **Telegraph confirmation gate**: Publishing to Telegraph now requires explicit confirmation, and each page gets its own access token for tracking.
- **CI pipeline reliability**: Publish workflow now derives the next version from npm (not package.json), eliminating version collision races. CI gate uses the stable test suite, matching the main CI workflow.

## What to Tell Your User

- **"Your dashboard link stays fresh now"**: The pinned dashboard message in Telegram auto-updates every 5 minutes. If the tunnel URL changes (like after a restart), the link fixes itself — no need to ask for a new one.
- **"Publishing is more reliable"**: Telegraph publishing now asks for confirmation before going live, and the deploy pipeline has been hardened against the version collision issues that were causing failed releases.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Dashboard link refresh | Automatic via job, or `POST /telegram/dashboard-refresh` |
| Telegraph confirmation gate | Automatic — prompts before publishing |
| Rate-limit backoff | Automatic in lifeline API calls |
