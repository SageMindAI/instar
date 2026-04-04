---
title: API Endpoints
description: Complete REST API reference for the Instar server.
---

The Instar server exposes a REST API on `localhost:4040` (configurable). All endpoints except `/health` require authentication via `Authorization: Bearer TOKEN` header.

## Health & Status

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (public, no auth). Returns version, session count, scheduler status, memory usage |
| GET | `/status` | Running sessions + scheduler status |

## Sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sessions` | List all sessions (filter by `?status=`) |
| GET | `/sessions/tmux` | List all tmux sessions |
| GET | `/sessions/:name/output` | Capture session output (`?lines=100`) |
| POST | `/sessions/:name/input` | Send text to a session |
| POST | `/sessions/spawn` | Spawn a new session (rate limited). Body: `name`, `prompt`, `model?`, `jobSlug?` |
| DELETE | `/sessions/:id` | Kill a session |

## Jobs

| Method | Path | Description |
|--------|------|-------------|
| GET | `/jobs` | List jobs + queue |
| POST | `/jobs/:slug/trigger` | Manually trigger a job |

## Relationships

| Method | Path | Description |
|--------|------|-------------|
| GET | `/relationships` | List relationships (`?sort=significance\|recent\|name`) |
| GET | `/relationships/stale` | Stale relationships (`?days=14`) |
| GET | `/relationships/:id` | Get single relationship |
| DELETE | `/relationships/:id` | Delete a relationship |
| GET | `/relationships/:id/context` | Get relationship context (JSON) |

## Telegram

| Method | Path | Description |
|--------|------|-------------|
| GET | `/telegram/topics` | List topic-session mappings |
| POST | `/telegram/topics` | Programmatic topic creation |
| POST | `/telegram/reply/:topicId` | Send message to a topic |
| GET | `/telegram/topics/:topicId/messages` | Topic message history (`?limit=20`) |

## Evolution

| Method | Path | Description |
|--------|------|-------------|
| GET | `/evolution` | Full evolution dashboard |
| GET | `/evolution/proposals` | List proposals (`?status=`, `?type=`) |
| POST | `/evolution/proposals` | Create a proposal |
| PATCH | `/evolution/proposals/:id` | Update proposal status |
| GET | `/evolution/learnings` | List learnings (`?applied=`, `?category=`) |
| POST | `/evolution/learnings` | Record a learning |
| PATCH | `/evolution/learnings/:id/apply` | Mark learning applied |
| GET | `/evolution/gaps` | List capability gaps |
| POST | `/evolution/gaps` | Report a gap |
| PATCH | `/evolution/gaps/:id/address` | Mark gap addressed |
| GET | `/evolution/actions` | List action items |
| POST | `/evolution/actions` | Create an action item |
| GET | `/evolution/actions/overdue` | List overdue actions |
| PATCH | `/evolution/actions/:id` | Update action status |

## Memory & Search

| Method | Path | Description |
|--------|------|-------------|
| GET | `/memory/search?q=` | Full-text search across agent knowledge |
| POST | `/memory/reindex` | Rebuild the search index |
| GET | `/memory/status` | Index stats |
| GET | `/topic/search?q=` | Search across topic conversations |
| GET | `/topic/context/:topicId` | Topic context (summary + recent messages) |
| GET | `/topic/summary` | List all topic summaries |
| POST | `/topic/summarize` | Trigger summary regeneration |

## Intent & Coherence

| Method | Path | Description |
|--------|------|-------------|
| GET | `/intent/journal` | Query the decision journal |
| POST | `/intent/journal` | Record a decision |
| GET | `/intent/drift` | Detect behavioral drift |
| GET | `/intent/alignment` | Alignment score |
| GET | `/project-map` | Auto-generated project territory map |
| POST | `/coherence/check` | Pre-action coherence verification |

## Updates & Dispatches

| Method | Path | Description |
|--------|------|-------------|
| GET | `/updates` | Check for updates |
| GET | `/updates/last` | Last update check result |
| GET | `/updates/auto` | AutoUpdater status |
| GET | `/dispatches/auto` | AutoDispatcher status |

## Self-Healing

| Method | Path | Description |
|--------|------|-------------|
| GET | `/triage/status` | Stall triage nurse status |
| GET | `/triage/history` | Recovery attempt history |
| POST | `/triage/trigger` | Manually trigger triage |

## Infrastructure

| Method | Path | Description |
|--------|------|-------------|
| GET | `/capabilities` | Feature guide and metadata |
| GET | `/events` | Query events (`?limit=50&since=24&type=`) |
| GET | `/quota` | Quota usage + recommendation |
| GET | `/agents` | List all agents on this machine |
| GET | `/tunnel/status` | Cloudflare tunnel status |
| POST | `/tunnel/start` | Start a tunnel |
| POST | `/tunnel/stop` | Stop the tunnel |
| GET | `/messages/inbox` | Inter-agent inbox |
| GET | `/messages/outbox` | Inter-agent outbox |
| GET | `/messages/dead-letter` | Dead letter queue |

## Threadline (MCP Tools)

These tools are registered as an MCP server and called by Claude Code (or any MCP client) via stdio transport. They are registered automatically on server boot.

| Tool | Description |
|------|-------------|
| `threadline_discover` | Find Threadline-capable agents. Scope: `local` (same machine) or `network` (known remotes). Optional capability filter |
| `threadline_send` | Send a message to an agent. Creates or resumes a persistent thread. Optional `waitForReply` (default true, 120s timeout) |
| `threadline_history` | Retrieve conversation history from a thread. Supports pagination via `limit` and `before` timestamp |
| `threadline_agents` | List known agents with status, capabilities, framework, trust level, and active thread count |
| `threadline_delete` | Delete a thread permanently. Requires `confirm: true` |

### Threadline REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/messages/inbox` | Inter-agent inbox |
| GET | `/messages/outbox` | Inter-agent outbox |
| GET | `/messages/dead-letter` | Dead letter queue |
| POST | `/messages/send` | Send a message (used internally by MCP tools) |

## Serendipity Protocol

| Method | Path | Description |
|--------|------|-------------|
| GET | `/serendipity/stats` | Pending, processed, and invalid finding counts with details |
| GET | `/serendipity/findings` | List all pending findings (full JSON) |

## Backup

| Method | Path | Description |
|--------|------|-------------|
| POST | `/backup` | Create a backup snapshot |
| GET | `/backup` | List available backups |
| POST | `/backup/restore` | Restore from a snapshot |

## MoltBridge (Trust Network)

Requires MoltBridge to be enabled in config: `{ "moltbridge": { "enabled": true, "apiUrl": "..." } }`

| Method | Path | Description |
|--------|------|-------------|
| POST | `/moltbridge/register` | Register agent with MoltBridge network. Body: `capabilities[]`, `displayName?` |
| POST | `/moltbridge/discover` | Capability-based agent discovery. Body: `capability` (required), `limit?` |
| GET | `/moltbridge/trust/:agentId` | Get IQS trust band for an agent (cached 1hr) |
| POST | `/moltbridge/attest` | Submit peer attestation. Body: `subject`, `capability`, `outcome`, `confidence?`, `context?` |
| GET | `/moltbridge/status` | Registration status and wallet balance |

## Feedback

| Method | Path | Description |
|--------|------|-------------|
| POST | `/feedback` | Submit feedback |
| GET | `/feedback` | List feedback |
| POST | `/feedback/retry` | Retry un-forwarded feedback |
