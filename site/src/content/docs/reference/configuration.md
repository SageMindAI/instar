---
title: Configuration
description: Configuration reference for Instar agents.
---

All configuration lives in `.instar/config.json`, created during setup and editable at any time. All keys are top-level (no nesting under section objects).

## Server

```json
{
  "port": 4040,
  "host": "127.0.0.1"
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `port` | 4040 | Server port |
| `host` | 127.0.0.1 | Bind address (localhost only by default) |
| `requestTimeoutMs` | 30000 | Request timeout in milliseconds |

## Messaging

Telegram, WhatsApp, and other adapters are configured via a `messaging` array:

```json
{
  "messaging": [
    {
      "type": "telegram",
      "botToken": "...",
      "chatId": -100...
    },
    {
      "type": "whatsapp"
    }
  ]
}
```

Each entry specifies an adapter `type` and its adapter-specific options. WhatsApp state is managed internally via the Baileys library.

## Scheduler

```json
{
  "scheduler": {
    "enabled": true,
    "maxConcurrentSessions": 3
  }
}
```

## Auth

```json
{
  "authToken": "..."
}
```

The auth token is a top-level key, generated during setup. Used for API authentication via `Bearer` header.

For dashboard web access, a simpler `dashboardPin` is also available:

```json
{
  "dashboardPin": "1234"
}
```

## Sessions

```json
{
  "sessions": {
    "maxConcurrent": 5,
    "timeoutMinutes": 120,
    "claudePath": "/path/to/claude",
    "tmuxPath": "/path/to/tmux"
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `maxConcurrent` | `5` | Maximum number of concurrent Claude Code sessions |
| `timeoutMinutes` | `120` | Session idle timeout in minutes |
| `claudePath` | auto-detected | Path to the `claude` CLI binary. Override if your Claude Code installation is in a non-standard location or if auto-detection fails. |
| `tmuxPath` | auto-detected | Path to the `tmux` binary. Override if tmux is installed in a non-standard location. |

## Safety & Autonomy

```json
{
  "safety": { ... },
  "agentAutonomy": { ... },
  "autonomyProfile": "supervised",
  "externalOperations": { ... }
}
```

| Field | Description |
|-------|-------------|
| `safety` | Safety configuration for autonomous operation |
| `agentAutonomy` | Agent autonomy configuration |
| `autonomyProfile` | Unified autonomy level: `cautious`, `supervised`, `collaborative`, `autonomous` |
| `externalOperations` | External operation safety -- gate, sentinel, trust |

## Response Review (Coherence Gate)

```json
{
  "responseReview": {
    "enabled": true,
    "mode": "observe"
  }
}
```

See [Coherence Gate](/features/coherence-gate/) for full configuration options.

## Threadline

```json
{
  "threadline": { ... }
}
```

Configures the Threadline relay for inter-agent communication. See [Threadline Protocol](/features/threadline/) for details.

## Additional Config Keys

| Key | Description |
|-----|-------------|
| `monitoring` | Health monitoring configuration |
| `relationships` | Relationship tracking config |
| `feedback` | Feedback loop config |
| `dispatches` | Dispatch (intelligence broadcast) config |
| `gitBackup` | Git backup config (opt-in for standalone agents) |
| `updates` | Update configuration (auto-updater behavior) |
| `publishing` | Publishing (Telegraph) config |
| `tunnel` | Cloudflare Tunnel config |
| `evolution` | Evolution system configuration |
| `multiMachine` | Multi-machine coordination config |
| `agentType` | `standalone` or `project-bound` |
| `userRegistrationPolicy` | User registration policy |
| `inputGuard` | Cross-topic injection defense |
| `notifications` | Notification preferences for autonomy events |
| `dashboard` | Dashboard configuration |
| `onboarding` | Controls what data is collected during user registration |
| `recoveryKey` | Recovery key for admin self-recovery |

## Identity Files

These aren't in config.json but are critical configuration:

| File | Purpose |
|------|---------|
| `.instar/AGENT.md` | Agent identity -- who it is, its principles |
| `.instar/USER.md` | User context -- who it works with, preferences |
| `.instar/MEMORY.md` | Persistent learnings across sessions |
| `.instar/ORG-INTENT.md` | Organizational constraints (optional) |

## Jobs

Jobs are defined in `.instar/jobs.json`. See [Job Scheduler](/features/scheduler/) for the format.

## Hooks

Behavioral hooks are installed in `.claude/settings.json` and scripts live in `.instar/hooks/` and `.claude/scripts/`. See [Hooks reference](/reference/hooks/) for details.
