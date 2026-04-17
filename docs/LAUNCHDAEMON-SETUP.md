# Running Instar as a LaunchDaemon (macOS)

By default, Instar installs as a **LaunchAgent** — it runs when you log in. That's fine for most setups, but has a limitation: **the agent only runs when you're logged in.** If the Mac reboots while you're away (OS update, power event, etc.) and your user doesn't auto-login, the agent stays offline until someone logs in.

**LaunchDaemon mode** fixes this: the agent starts at boot, before any user login, and keeps running across all user sessions. This is useful for a dedicated "always-on" Mac that you access remotely.

There are three gotchas when running as a daemon. This document covers all of them.

## 1. Authentication (Claude OAuth doesn't work in daemons)

Claude Code's interactive mode reads OAuth credentials from the macOS login keychain. LaunchDaemons run without a user session, so they cannot access the user's login keychain — meaning OAuth-based auth silently fails.

**Solution:** Use a long-lived OAuth token via `CLAUDE_CODE_OAUTH_TOKEN` instead of keychain-backed OAuth.

### Generate a long-lived token

Requires a Claude subscription (Pro or Max).

```bash
claude setup-token
```

This launches an interactive browser flow. When complete, it prints a token starting with `sk-ant-oat01-...` that's valid for one year.

**Alternative:** Use an API key from [console.anthropic.com](https://console.anthropic.com/). That's pay-per-use rather than subscription-billed, but works identically.

### Configure Instar

Add to `.instar/config.json`:

```json
{
  "sessions": {
    "anthropicApiKey": "sk-ant-oat01-..."
  }
}
```

Instar auto-detects the format:
- `sk-ant-oat01-*` → routed to `CLAUDE_CODE_OAUTH_TOKEN` (subscription-billed, works in interactive mode)
- `sk-ant-api03-*` → routed to `ANTHROPIC_API_KEY` (pay-per-use API billing)

## 2. iMessage database access

The `~/Library/Messages/` directory is protected by macOS TCC. Granting Full Disk Access to the node binary would work but is overly broad — node could then access anything, and FDA has to be re-granted if Homebrew changes the node path.

**Instar handles this automatically.** On startup, the iMessage adapter hardlinks `chat.db` (plus WAL and SHM files) from `~/Library/Messages/` to `<stateDir>/imessage/`. Hardlinks share the same inode, so the server reads the current data, but the link path itself isn't inside the TCC-protected directory — no FDA required on node.

### How it works

- **First startup:** the adapter needs FDA to create the hardlinks. Run `instar server start` once from a terminal that has FDA granted (System Settings → Privacy & Security → Full Disk Access → add Terminal.app or iTerm). The hardlinks are created in `.instar/imessage/`.
- **All subsequent startups:** the hardlinks already exist. The adapter reads through them without needing FDA on node. Works fine from a LaunchDaemon.
- **If Messages.app resets** (new install, major macOS upgrade), the inode may change. The adapter detects this on startup and recreates the hardlinks — which again requires FDA for that one startup.

### Overriding the default

If you want to point at a different database location (e.g., a shared volume), set `dbPath` explicitly:

```json
{
  "type": "imessage",
  "enabled": true,
  "config": {
    "dbPath": "/path/to/your/chat.db",
    "authorizedContacts": ["+14081234567"]
  }
}
```

When `dbPath` is set, the adapter uses it as-is and does not create hardlinks.

### Note on sending

`imsg send` uses ScriptingBridge to talk to Messages.app, which requires a running user session with Automation permission granted. A daemon can send iMessages *if* a user is logged in when the daemon spawns `imsg`. If you need sending to work even before any user logs in, you'll need a LaunchAgent (not Daemon) for the sending path.

In practice: most setups have someone log in eventually, and sending works thereafter.

## 3. Node binary path

Instar symlinks `.instar/bin/node` to a node binary. If multiple Homebrew prefixes exist (e.g., `/opt/homebrew` and `/Users/you/homebrew`), the symlink may point to the wrong one. This matters if you've granted FDA to a specific binary — FDA is per-path.

**Solution:** Point the symlink at the binary that has FDA (if any), using the resolved Cellar path (not the `bin/` symlink):

```bash
ln -sf /Users/YOU/homebrew/Cellar/node/XX.Y.Z/bin/node /Users/YOU/.instar/agents/AGENT/.instar/bin/node
```

With the hardlink approach for chat.db, FDA isn't needed at all — this step can be skipped.

## LaunchDaemon plist template

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.instar.AGENT</string>
    <key>UserName</key>
    <string>YOUR_USER</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOU/homebrew/Cellar/node/XX.Y.Z/bin/node</string>
        <string>/Users/YOU/.instar/agents/AGENT/.instar/instar-boot.js</string>
        <string>server</string>
        <string>start</string>
        <string>--foreground</string>
        <string>--dir</string>
        <string>/Users/YOU/.instar/agents/AGENT</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/YOU/.instar/agents/AGENT</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/YOU/.instar/agents/AGENT/.instar/logs/server-launchd.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOU/.instar/agents/AGENT/.instar/logs/server-launchd.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>/Users/YOU</string>
        <key>PATH</key>
        <string>/Users/YOU/homebrew/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
```

Install:

```bash
sudo cp my.plist /Library/LaunchDaemons/ai.instar.AGENT.plist
sudo chown root:wheel /Library/LaunchDaemons/ai.instar.AGENT.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/ai.instar.AGENT.plist
```

Reload after changes:

```bash
sudo launchctl bootout system /Library/LaunchDaemons/ai.instar.AGENT.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/ai.instar.AGENT.plist
```

## Verifying the setup

After the daemon starts:

```bash
curl -s http://localhost:4040/health
curl -s -H "Authorization: Bearer $(python3 -c "import json; print(json.load(open('/Users/YOU/.instar/agents/AGENT/.instar/config.json'))['authToken'])")" \
  http://localhost:4040/imessage/status
```

Both should return healthy responses. The iMessage status should show `"state":"connected"` without any `"reason":"unable to open database file"` in the degradations log.

Send a test iMessage to the agent's authorized number. You should see:
1. An ack message back within ~2 seconds (if `immediateAck` is configured)
2. A real reply from a Claude session within 30–90 seconds
