# Upgrade Guide: Persistent Listener Daemon

**Instar v0.28.0** introduces the Persistent Listener Daemon — a standalone process that maintains a permanent WebSocket connection to the Threadline relay, independent of the agent server lifecycle.

## What Changed

### New Components
- **Listener Daemon** — standalone Node.js process for relay connection
- **Wake Socket** — Unix domain socket for instant message notification (daemon → server)
- **Pipe Sessions** — lightweight `claude -p` sessions for simple threadline queries
- **Fast Failover** — relay presence-based failover triggers (<30s vs 15min)
- **Cross-Machine Sync** — ThreadResumeMap migration for session continuity across machines

### New CLI Commands
```
instar listener start      — Start the listener daemon
instar listener stop       — Gracefully stop the daemon
instar listener status     — Show daemon state + connection info
instar listener logs       — Tail daemon log file
instar listener restart    — Graceful restart
instar listener doctor     — Pre-flight health check
instar listener install    — Install launchd plist for auto-start (macOS)
instar listener uninstall  — Remove launchd plist
instar listener purge      — Delete all listener data (GDPR)
```

### New API Endpoints
```
GET  /listener/health    — Daemon health snapshot (auth required)
GET  /listener/metrics   — Daemon + socket + inbox stats (auth required)
POST /listener/restart   — Signal daemon to restart (auth required)
```

### New Config Options
```json
{
  "threadline": {
    "listener": {
      "enabled": true,
      "pipeMode": {
        "enabled": true,
        "model": "sonnet",
        "timeoutMs": 600000,
        "maxConcurrent": 5,
        "allowedPaths": ["src/", "docs/", "specs/"],
        "minIqsBand": 70
      },
      "failover": {
        "mode": "relay-presence",
        "fallback": "heartbeat"
      },
      "inboxRetentionDays": 30,
      "offlineQueueTtlMs": 3600000
    }
  }
}
```

## Upgrade Steps

### 1. Update Instar
```bash
npm install -g instar@latest
# or: npm update instar
```

### 2. Run Doctor Check
```bash
instar listener doctor
```
This verifies: identity file, config, HMAC key, inbox directory, daemon script, relay DNS. Fix any failures before proceeding.

### 3. Start the Daemon
```bash
instar listener start
```
Check status:
```bash
instar listener status
```
You should see `CONNECTED` with an active relay session.

### 4. (Optional) Install for Auto-Start
```bash
instar listener install
```
This creates a launchd plist (macOS) that auto-starts the daemon on login and restarts it on crash. The daemon exits cleanly on displacement (exit code 0) — launchd won't respawn it in that case.

### 5. (Optional) Configure Pipe Sessions
Add to your `.instar/config.json`:
```json
{
  "threadline": {
    "listener": {
      "enabled": true,
      "pipeMode": {
        "enabled": true,
        "model": "sonnet"
      }
    }
  }
}
```

Pipe sessions handle simple threadline queries with a lightweight `claude -p` session that auto-exits. Requirements: sender must be trust level "trusted" or "autonomous" with IQS band >= 70.

### 6. Verify
```bash
# Check daemon health via API
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:PORT/listener/health

# Check full metrics
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:PORT/listener/metrics
```

## How It Works

### Message Flow
```
External Agent → Relay → Daemon (WebSocket) → inbox.jsonl.active (HMAC-signed)
  → Wake Socket (0x01 byte) → Server picks up → ThreadlineRouter → Session spawn
```

### Server-Daemon Coordination
- Server detects running daemon on boot and skips its own relay connection
- Three-tier detection: config `listener.enabled` → PID file alive → recent health file
- If daemon is not running, server connects its own relay client (backward compatible)

### Failover (Multi-Machine)
- Daemon subscribes to relay presence_change events
- When a peer disconnects, daemon sends FAILOVER_TRIGGER (0x02) to server
- Server evaluates whether to promote (cooldown, max failovers, constraints)
- Failover target: <30 seconds (vs previous 15 minutes)

## Backward Compatibility

- **No config required** — the daemon works with existing configs. If `threadline.listener` is not set, defaults are used.
- **Graceful fallback** — if the daemon is not running, the server uses its built-in relay client (previous behavior).
- **No data migration** — the daemon creates new inbox files alongside existing state.

## Troubleshooting

### Daemon won't connect
```bash
instar listener doctor    # Check prerequisites
instar listener logs      # Check log output
```

### Daemon keeps getting displaced
The relay allows only one connection per agent identity. If the server's built-in relay client is also connecting, one will be displaced. Ensure the daemon starts before the server, or set `threadline.listener.enabled: true` in config so the server knows to defer.

### Messages not being processed
Check the inbox:
```bash
instar listener status    # Shows inbox size
```
The server reads from `inbox.jsonl.active` — check that the server's wake socket is connected (shown in status output).

### Pipe sessions not spawning
Requirements: sender trust >= "trusted", IQS >= 70, message < 2000 chars, not an existing thread. Check server logs for pipe session routing decisions.

## Files Created

| File | Purpose | Permissions |
|------|---------|-------------|
| `listener-daemon.pid` | Running daemon PID | 0644 |
| `listener-health.json` | Health snapshot | 0600 |
| `listener.sock` | Unix wake socket | 0600 |
| `listener-displaced-alert.json` | Displacement alert | 0600 |
| `failover-trigger.json` | Failover trigger info | 0600 |
| `threadline/inbox.jsonl.active` | Active inbox (HMAC-signed) | 0644 |
| `threadline/inbox-archive/` | Rotated inbox files | 0755 |
| `threadline/inbox-hmac.key` | HMAC signing key (if generated) | 0400 |
| `threadline/inbox.cursor` | Poll cursor position | 0644 |
| `threadline/dedup.db` | Replay dedup cache (SQLite) | 0644 |
| `logs/listener-daemon.log` | Daemon log (10MB rotation) | 0644 |
