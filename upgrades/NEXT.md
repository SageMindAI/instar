# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

**Persistent Listener Daemon** — A standalone process that maintains a permanent WebSocket connection to the Threadline relay, independent of the agent server. Four phases shipped together:

1. **Listener Daemon (Phase 1)**: Standalone Node.js daemon maintains relay WebSocket connection. Survives server restarts. Writes HMAC-signed entries to an inbox file. Signals the server via Unix domain socket for instant pickup. Managed via launchd on macOS with auto-restart on crash.

2. **Pipe-Mode Sessions (Phase 2)**: Lightweight sessions for simple threadline queries. Uses a Haiku-class LLM classifier to distinguish "task" messages (which need full interactive sessions) from "query" messages (which can be answered and auto-exit). Injection-hardened prompt template with XML data tags. Read-only tool access with path grant-list.

3. **Fast Failover (Phase 3)**: Failover time drops from 15 minutes to under 30 seconds. The daemon subscribes to relay presence changes and signals the server immediately when a peer agent disconnects.

4. **Cross-Machine Session Sync (Phase 4)**: When failover occurs, active conversation threads can migrate between machines. ThreadResumeMap entries carry machine origin metadata so the new machine can resume sessions with the correct Claude session UUID.

### New CLI commands:

Nine new commands under the listener subcommand for daemon lifecycle management, health checking, launchd integration, and data cleanup.

### New API endpoints:

Three new authenticated endpoints for daemon health, metrics, and restart signaling.

### Server-daemon coordination:

The server detects whether a listener daemon is running on boot. If so, it defers relay connection to the daemon (no displacement conflicts). Three-tier detection: config setting, PID file, recent health file.

## What to Tell Your User

- **Always-on relay connection**: "Your agent now has a dedicated process that keeps the Threadline relay connection alive at all times, even when the server restarts. You will never miss a message from another agent because of a restart or update."

- **Faster cross-machine failover**: "If you run your agent on two machines, failover from one to the other now happens in under 30 seconds instead of 15 minutes. The relay detects when a machine goes offline and notifies the standby immediately."

- **Lightweight responses**: "Simple questions from other agents now get answered faster through pipe-mode sessions that start, respond, and clean up automatically. Complex tasks still get full interactive sessions."

- **Easy setup**: "Run the listener doctor command to check prerequisites, then start the listener to activate it. For auto-start on login, use the listener install command to set up launchd."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Listener daemon | Start with the listener start command, check with listener status |
| Health monitoring | Listener doctor for pre-flight, listener status for runtime |
| Auto-start on login | Listener install creates a launchd plist (macOS) |
| Pipe-mode sessions | Automatic for simple queries from trusted agents (IQS 70 or above) |
| Fast failover | Automatic when daemon subscribes to relay presence changes |
| Cross-machine resume | Automatic during failover via ThreadResumeMap migration |
| Data cleanup | Listener purge removes all listener data (GDPR compliance) |
| Daemon log viewing | Listener logs shows daemon output with filtering options |
