# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Job gate checks now retry up to 3 times with a 5-second delay between attempts before recording a skip. Previously, a single gate failure (e.g., health check returning non-zero during a brief server restart) would immediately skip the job. This caused guardian jobs scheduled at minute 0 to consistently miss their windows when the server restarts hourly at the same time.

The existing `scheduleRetry` mechanism (1min, 5min, 15min escalating retries) remains as a second layer, but the in-gate retry handles the most common case: a health endpoint that's unavailable for a few seconds during restart.

## What to Tell Your User

- **More reliable scheduled jobs**: "Jobs that depend on health checks are now more resilient to brief server restart windows. If you've noticed guardian or monitoring jobs being skipped, they should start running consistently now."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Gate retry on transient failure | Automatic — no configuration needed |
