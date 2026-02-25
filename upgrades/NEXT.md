# Lifeline Alert Suppression During Updates

## What Changed

Previously, every time an agent auto-updated, the lifeline's health check would detect the brief server restart as a failure and fire a "Server went down" alert to the Lifeline topic. This was a false alarm — the server was intentionally restarting for the update.

Now the AutoUpdater writes a coordination flag file (`state/update-restart.json`) with a 3-minute TTL before restarting. The ServerSupervisor checks this flag before emitting "server down" events:

- If the flag is present and not expired: suppresses the alert, skips auto-restart (the replacement process handles recovery), and extends the startup grace period
- If the flag is expired or absent: normal behavior (alerts fire, auto-restart kicks in)
- When the server comes back healthy: flag is automatically cleaned up

This is a purely internal infrastructure change — no new commands, no config changes, no behavior differences from the user's perspective.

## What to Tell Your User

Nothing — this is an invisible quality-of-life improvement. Your user will simply stop seeing false "Server went down" alerts in the Lifeline topic during updates. Everything else works exactly the same.

## Summary of New Capabilities

- **Silent update restarts**: Health check alerts are suppressed during planned auto-update restarts
- **Flag-based coordination**: AutoUpdater signals the lifeline supervisor via a TTL-bounded flag file before restarting
- **Self-healing TTL**: If the replacement server fails to start within 3 minutes, the flag expires and real alerts fire as normal
