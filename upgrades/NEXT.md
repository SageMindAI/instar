# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- **Startup grace period for gate evaluation**: Job gates (health checks, quota checks) that require HTTP endpoints are now evaluated after a configurable grace period (default 5 seconds) at startup, rather than immediately. This fixes a race condition where health-gated jobs would permanently fail because the HTTP server wasn't ready yet during the initial missed-job catch-up evaluation. Configurable via startupGraceMs in JobScheduler config. Set to 0 to disable.

- **QuotaTracker stale data handling**: When quota data is older than the staleness threshold (default 30 minutes), the tracker now returns null instead of the stale values. This triggers the existing fail-open path, allowing jobs to run when quota data is unavailable rather than blocking them with outdated percentages.

## What to Tell Your User

- **"Scheduled jobs should start running more reliably"**: If your user noticed that certain scheduled jobs never seemed to execute despite being enabled and due, that should be resolved now. The system was accidentally blocking them during startup.

- **"The system handles missing data more gracefully"**: When usage tracking data gets stale, the system now allows work to continue rather than blocking it based on outdated information.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Startup grace period | Automatic — 5s default delay before first gate evaluation |
| Stale quota fail-open | Automatic — stale data allows all jobs to proceed |
