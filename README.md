<p align="center">
  <img src="assets/logo.png" alt="Instar" width="180" />
</p>

<h1 align="center">instar</h1>

<p align="center">
  <strong>Persistent autonomy infrastructure for AI agents.</strong> Every molt, more autonomous.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/instar"><img src="https://img.shields.io/npm/v/instar?style=for-the-badge" alt="npm version"></a>
  <a href="https://github.com/SageMindAI/instar"><img src="https://img.shields.io/badge/GitHub-SageMindAI%2Finstar-blue?style=for-the-badge&logo=github" alt="GitHub"></a>
  <a href="https://github.com/SageMindAI/instar/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/instar">npm</a> · <a href="https://github.com/SageMindAI/instar">GitHub</a> · <a href="https://instar.sh">instar.sh</a> · <a href="#origin">Origin Story</a>
</p>

---

Instar gives Claude Code agents a **persistent body** -- a server that runs 24/7, a scheduler that executes jobs on cron, messaging integrations, relationship tracking, and the self-awareness to grow their own capabilities.

Named after the developmental stages between molts in arthropods, where each instar is more developed than the last.

## The Problem

**Without Instar**, Claude Code is a CLI tool. You open a terminal, type a prompt, get a response, close the terminal. No persistence. No scheduling. No way to reach you.

**With Instar**, Claude Code becomes an agent. It runs in the background, checks your email on a schedule, monitors your services, messages you on Telegram when something needs attention, and builds new capabilities when you ask for something it can't do yet.

The difference isn't features. It's a shift in what Claude Code *is* -- from a tool you use to an agent that works alongside you.

## Two Ways to Use Instar

### 🤖 General Agent — A personal AI on your computer

Want a persistent AI assistant you talk to through Telegram? Like OpenClaw, but ToS-compliant.

```bash
npx instar
# Choose "General Agent" → set up Telegram → start the server
# Now talk to your agent from your phone, anywhere
```

Your agent runs in the background, handles scheduled tasks, messages you proactively, and grows through experience. Telegram is the primary interface — organized topic threads, full message history, mobile access.

### 📁 Project Agent — Add an agent to your codebase

Want an agent that monitors, builds, and maintains a specific project?

```bash
cd my-project
npx instar
# Choose "Project Agent" → configure → start the server
```

Your agent watches your codebase, runs health checks, handles ops tasks, and communicates through Telegram (recommended) or terminal sessions.

---

The wizard walks you through everything: identity, Telegram, jobs, server. One command to go from zero to a running agent.

**Requirements:** Node.js 20+ · [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) · tmux · [API key](https://console.anthropic.com/) or Claude subscription

## CLI Reference

```bash
# Setup
instar                          # Interactive setup wizard (General Agent or Project Agent)
instar setup                    # Same as above
instar setup --classic          # Inquirer-based fallback wizard
instar init my-agent            # Create a new agent (general or project)
instar init                     # Add agent infrastructure to current project

# Server
instar server start             # Start the persistent server (background, tmux)
instar server start --foreground  # Start in foreground (for development)
instar server stop              # Stop the server
instar status                   # Show agent infrastructure status

# Add capabilities
instar add telegram --token BOT_TOKEN --chat-id CHAT_ID
instar add email --credentials-file ./credentials.json [--token-file ./token.json]
instar add quota [--state-file ./quota.json]
instar add sentry --dsn https://key@o0.ingest.sentry.io/0

# Users and jobs
instar user add --id alice --name "Alice" [--telegram 123] [--email a@b.com]
instar user list
instar job add --slug check-email --name "Email Check" --schedule "0 */2 * * *" \
  [--description "..."] [--priority high] [--model sonnet]
instar job list

# Feedback
instar feedback --type bug --title "Session timeout" --description "Details..."
```

## Highlights

- **[Persistent Server](#persistent-server)** -- Express server in tmux. Runs 24/7, survives disconnects, auto-recovers.
- **[Job Scheduler](#job-scheduler)** -- Cron-based task execution with priority levels, model tiering, and quota awareness.
- **[Identity System](#identity-that-survives-context-death)** -- AGENT.md + USER.md + MEMORY.md with hooks that enforce continuity across compaction.
- **[Telegram Integration](#telegram-integration)** -- Two-way messaging. Each job gets its own topic. Your group becomes a living dashboard.
- **[Relationship Tracking](#relationships-as-fundamental-infrastructure)** -- Cross-platform identity resolution, significance scoring, context injection.
- **[Self-Evolution](#self-evolution)** -- The agent modifies its own jobs, hooks, skills, and infrastructure. It builds what it needs.
- **[Behavioral Hooks](#behavioral-hooks)** -- Structural guardrails: identity injection, dangerous command guards, grounding before messaging.
- **[Default Coherence Jobs](#default-coherence-jobs)** -- Health checks, reflection, relationship maintenance. A circadian rhythm out of the box.
- **[Feedback Loop](#the-feedback-loop-a-rising-tide-lifts-all-ships)** -- Your agent reports issues, we fix them, every agent gets the update. A rising tide lifts all ships.

## How It Works

```
You (Telegram / Terminal)
         │
         ▼
┌─────────────────────────┐
│     Instar Server       │
│   (Express + tmux)      │
│   http://localhost:4040  │
└────────┬────────────────┘
         │
         ├─ Claude Code session (job: health-check)
         ├─ Claude Code session (job: email-monitor)
         ├─ Claude Code session (interactive chat)
         └─ Claude Code session (job: reflection)
```

Each session is a **real Claude Code process** with extended thinking, native tools, sub-agents, hooks, skills, and MCP servers. Not an API wrapper -- the full development environment.

## Why Instar (vs OpenClaw)

If you're coming from OpenClaw, NanoClaw, or similar projects broken by Anthropic's OAuth policy change -- Instar is architecturally different.

### ToS-compliant by design

Anthropic's policy: OAuth tokens are for Claude Code and claude.ai only. Projects that extracted tokens to power their own runtimes violated this.

**Instar spawns the actual Claude Code CLI.** Every session is a real Claude Code process. We never extract, proxy, or spoof OAuth tokens. We also support [API keys](https://console.anthropic.com/) for production use.

### Different category, different strengths

| | OpenClaw | Instar |
|---|---|---|
| **What it is** | AI assistant framework | Autonomy infrastructure |
| **Runtime** | Pi SDK (API wrapper) | Claude Code (full dev environment) |
| **Sessions** | Single gateway | Multiple parallel Claude Code instances |
| **Identity** | SOUL.md (file) | Multi-file + behavioral hooks + CLAUDE.md instructions |
| **Memory** | Hybrid vector search | Relationship-centric (cross-platform, significance) |
| **Messaging** | 20+ channels | Telegram (Slack/Discord planned) |
| **Voice** | ElevenLabs TTS, talk mode | -- |
| **Device apps** | macOS, Android, iOS (preview) | -- |
| **Sandbox** | Docker 3×3 matrix | Dangerous command guards |
| **Self-evolution** | Workspace file updates | Full infrastructure self-modification |
| **ToS status** | OAuth extraction (restricted) | Spawns real Claude Code (compliant) |

**OpenClaw optimizes for ubiquity** -- AI across every messaging platform. **Instar optimizes for autonomy** -- an agent that runs, remembers, grows, and evolves.

### Where OpenClaw leads

20+ messaging channels with deep per-channel config. Docker sandboxing with [security audit CLI](https://docs.openclaw.ai/gateway/security). Voice/TTS via ElevenLabs. Multi-agent routing. These are real, mature features.

Some claims are less proven: iOS app is "internal preview." Voice wake docs return 404. 50 bundled skills are listed but not individually documented.

### Where Instar leads

**Runtime depth.** Each session is a full Claude Code instance -- extended thinking, native tools, sub-agents, MCP servers. Not an API wrapper.

**Multi-session orchestration.** Multiple parallel jobs, each an independent Claude Code process with its own context and tools.

**Identity infrastructure.** Hooks re-inject identity on session start, after compaction, and before messaging. The agent doesn't try to remember who it is -- the infrastructure guarantees it. Structure over willpower.

**Memory that understands relationships.** OpenClaw has sophisticated retrieval (BM25 + vector + temporal decay). But it remembers *conversations*. Instar understands *relationships* -- cross-platform identity resolution, significance scoring, context injection.

**Self-evolution.** The agent modifies its own jobs, hooks, skills, config, and infrastructure. Not just workspace files -- the system itself.

Different tools for different needs. But only one of them works today.

> Full comparison: [positioning-vs-openclaw.md](docs/positioning-vs-openclaw.md)

---

## Core Features

### Job Scheduler

Define tasks as JSON with cron schedules. Instar spawns Claude Code sessions to execute them.

```json
{
  "slug": "check-emails",
  "name": "Email Check",
  "schedule": "0 */2 * * *",
  "priority": "high",
  "enabled": true,
  "execute": {
    "type": "prompt",
    "value": "Check email for new messages. Summarize anything urgent and send to Telegram."
  }
}
```

Jobs can be **prompts** (Claude sessions), **scripts** (shell commands), or **skills** (slash commands). The scheduler respects priority levels and manages concurrency.

### Session Management

Spawn, monitor, and communicate with Claude Code sessions running in tmux.

```bash
# Spawn a session (auth token from .instar/config.json)
curl -X POST http://localhost:4040/sessions/spawn \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_AUTH_TOKEN' \
  -d '{"name": "research", "prompt": "Research the latest changes to the Next.js API"}'

# Send a follow-up
curl -X POST http://localhost:4040/sessions/research/input \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_AUTH_TOKEN' \
  -d '{"text": "Focus on the app router changes"}'

# Check output
curl http://localhost:4040/sessions/research/output \
  -H 'Authorization: Bearer YOUR_AUTH_TOKEN'
```

Sessions survive terminal disconnects, detect completion automatically, and clean up after themselves.

### Telegram Integration

Two-way messaging via Telegram forum topics. Each topic maps to a Claude session.

- Send a message in a topic → arrives in the corresponding Claude session
- Agent responds → reply appears in Telegram
- `/new` creates a fresh topic with its own session
- Sessions auto-respawn with conversation history when they expire
- Every scheduled job gets its own topic -- your group becomes a **living dashboard**

### Persistent Server

```bash
instar server start              # Background (tmux)
instar server start --foreground # Foreground (dev)
instar server stop
instar status                    # Health check
```

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (public, no auth) |
| GET | `/status` | Running sessions + scheduler status |
| GET | `/sessions` | List all sessions (filter by `?status=`) |
| GET | `/sessions/tmux` | List all tmux sessions |
| GET | `/sessions/:name/output` | Capture session output (`?lines=100`) |
| POST | `/sessions/:name/input` | Send text to a session |
| POST | `/sessions/spawn` | Spawn a new session (rate limited). Body: `name`, `prompt`, optional `model` (`opus`/`sonnet`/`haiku`), optional `jobSlug` |
| DELETE | `/sessions/:id` | Kill a session |
| GET | `/jobs` | List jobs + queue |
| POST | `/jobs/:slug/trigger` | Manually trigger a job |
| GET | `/relationships` | List relationships (`?sort=significance\|recent\|name`) |
| GET | `/relationships/stale` | Stale relationships (`?days=14`) |
| GET | `/relationships/:id` | Get single relationship |
| DELETE | `/relationships/:id` | Delete a relationship |
| GET | `/relationships/:id/context` | Get relationship context (JSON) |
| POST | `/feedback` | Submit feedback |
| GET | `/feedback` | List feedback |
| POST | `/feedback/retry` | Retry un-forwarded feedback |
| GET | `/updates` | Check for updates |
| GET | `/updates/last` | Last update check result |
| GET | `/events` | Query events (`?limit=50&since=24&type=`). `since` is hours (1-720), `limit` is count (1-1000) |
| GET | `/quota` | Quota usage + recommendation |
| GET | `/telegram/topics` | List topic-session mappings |
| POST | `/telegram/reply/:topicId` | Send message to a topic |
| GET | `/telegram/topics/:topicId/messages` | Topic message history (`?limit=20`) |

### Identity That Survives Context Death

Every Instar agent has a persistent identity that survives context compressions, session restarts, and autonomous operation:

- **`AGENT.md`** -- Who the agent is, its role, its principles
- **`USER.md`** -- Who it works with, their preferences
- **`MEMORY.md`** -- What it has learned across sessions

But identity isn't just files. It's **infrastructure**:

- **Session-start scripts** re-inject identity reminders at session begin
- **Compaction recovery scripts** restore identity when context compresses
- **Grounding before messaging** forces identity re-read before external communication (automatic hook)
- **Dangerous command guards** block `rm -rf`, force push, database drops (automatic hook)

These aren't suggestions. They're structural guarantees. Structure over willpower.

### Relationships as Fundamental Infrastructure

Every person the agent interacts with gets a relationship record that grows over time:

- **Cross-platform resolution** -- Same person on Telegram and email? Merged automatically
- **Significance scoring** -- Derived from frequency, recency, and depth
- **Context injection** -- The agent *knows* who it's talking to before the conversation starts
- **Stale detection** -- Surfaces relationships that haven't been contacted in a while

### Self-Evolution

The agent can edit its own job definitions, write new scripts, update its identity, create hooks, and modify its configuration. When asked to do something it can't do yet, the expected behavior is: **"Let me build that capability."**

**Initiative hierarchy** -- before saying "I can't":
1. Can I do it right now? → Do it
2. Do I have a tool for this? → Use it
3. Can I build the tool? → Build it
4. Can I modify my config? → Modify it
5. Only then → Ask the human

### Behavioral Hooks

Automatic hooks fire via Claude Code's hook system:

| Hook | Type | What it does |
|------|------|-------------|
| **Dangerous command guard** | PreToolUse (blocking) | Blocks destructive operations structurally |
| **Grounding before messaging** | PreToolUse (advisory) | Forces identity re-read before external communication |
| **Session start** | PostToolUse | Injects identity context at session start |
| **Compaction recovery** | Notification (compact) | Restores identity when context compresses |

### Default Coherence Jobs

Ships out of the box:

| Job | Schedule | Model | Purpose |
|-----|----------|-------|---------|
| **health-check** | Every 5 min | Haiku | Verify infrastructure health |
| **reflection-trigger** | Every 4h | Sonnet | Reflect on recent work |
| **relationship-maintenance** | Daily | Sonnet | Review stale relationships |
| **update-check** | Daily | Haiku | Detect new Instar versions |
| **feedback-retry** | Every 6h | Haiku | Retry un-forwarded feedback items |

These give the agent a **circadian rhythm** -- regular self-maintenance without user intervention.

### The Feedback Loop: A Rising Tide Lifts All Ships

Instar is open source. PRs and issues still work. But the *primary* feedback channel is more organic -- agent-to-agent communication where your agent participates in its own evolution.

**How it works:**

1. **You talk to your agent** -- "The email job keeps failing" -- natural conversation, not a bug report form
2. **Agent-to-agent relay** -- Your agent communicates the issue directly to Dawn, the AI that maintains Instar
3. **Dawn evolves Instar** -- Fixes the infrastructure and publishes an update
4. **Every agent evolves** -- Agents detect improvements, understand them, and grow -- collectively

**What's different from traditional open source:** The feedback loop still produces commits, releases, and versions you can inspect. But the path to get there is fundamentally more agentic. Instead of a human discovering a bug, learning git, filing an issue, and waiting for a review cycle -- your agent identifies the problem, communicates it with full context to another agent, and the fix flows back to every agent in the ecosystem. The humans guide direction. The agents handle the mechanics of evolving.

One agent's growing pain becomes every agent's growth.

---

## Architecture

```
.instar/                  # Created in your project
  config.json             # Server, scheduler, messaging config
  jobs.json               # Scheduled job definitions
  users.json              # User profiles and permissions
  AGENT.md                # Agent identity (who am I?)
  USER.md                 # User context (who am I working with?)
  MEMORY.md               # Persistent learnings across sessions
  hooks/                  # Behavioral scripts (guards, identity injection)
  state/                  # Runtime state (sessions, jobs)
  relationships/          # Per-person relationship files
  logs/                   # Server logs
.claude/                  # Claude Code configuration
  settings.json           # Hook registrations
  scripts/                # Health watchdog, Telegram relay
```

Everything is file-based. No database. JSON state files the agent can read and modify. tmux for session management -- battle-tested, survives disconnects, fully scriptable.

## Security Model: Permissions & Transparency

**Instar runs Claude Code with `--dangerously-skip-permissions`.** This is a deliberate architectural choice, and you should understand exactly what it means before proceeding.

### What This Flag Does

Claude Code normally prompts you to approve each tool use -- every file read, every shell command, every edit. The `--dangerously-skip-permissions` flag disables these per-action prompts, allowing the agent to operate autonomously without waiting for human approval on each step.

### Why We Use It

An agent that asks permission for every action isn't an agent -- it's a CLI tool with extra steps. Instar exists to give Claude Code **genuine autonomy**: background jobs that run on schedules, sessions that respond to Telegram messages, self-evolution that happens without you watching.

None of that works if the agent stops and waits for you to click "approve" on every file read.

### Where Security Actually Lives

Instead of per-action permission prompts, Instar pushes security to a higher level:

**Behavioral hooks** -- Structural guardrails that fire automatically:
- Dangerous command guards block `rm -rf`, force push, database drops
- Grounding hooks force identity re-read before external communication
- Session-start hooks inject safety context into every new session

**Identity coherence** -- A grounded, coherent agent with clear identity (`AGENT.md`), relationship context (`USER.md`), and accumulated memory (`MEMORY.md`) makes better decisions than a stateless process approving actions one at a time. The intelligence layer IS the security layer.

**Audit trail** -- Every session runs in tmux with full output capture. Message logs, job execution history, and session output are all persisted and inspectable.

### What You Should Know

**There is no sandbox.** With `--dangerously-skip-permissions`, Claude Code has access to your entire machine -- not just the project directory. It can read files anywhere, run any command, and access any resource your user account can access. This is the same level of access as running any program on your computer.

- The agent **can read, write, and execute** anywhere on your machine without asking
- The agent **can run any shell command** your user account has access to
- The agent **can send messages** via Telegram and other configured integrations
- The agent **is directed** by its CLAUDE.md, identity files, and behavioral hooks to stay within its project scope -- but this is behavioral guidance, not a technical boundary
- All behavioral hooks, identity files, and CLAUDE.md instructions are **in your project** and fully editable by you

### Proceed at Your Own Risk

This is infrastructure for people who want genuine AI autonomy, not a sandbox demo. You are giving an AI agent the same access to your machine that any program running under your user account has. The security model relies on intelligent behavior (identity, hooks, coherence) rather than permission dialogs or sandboxing.

If you're not comfortable with that trade-off, Claude Code's default permission mode may be a better fit for your use case.

## How the Agent Grows

Instar adds an **Agentic Initiative** section to your project's CLAUDE.md. This teaches the agent to overcome [Claude's training biases](https://docs.anthropic.com/en/docs/claude-code) toward passivity:

**Gravity wells** -- named anti-patterns with explicit overrides:

| Anti-pattern | Override |
|-------------|----------|
| *"Escalate to Human"* | Research first, build second, ask last |
| *"Ask Permission"* | If the next step is obvious, do it |
| *"Present Options"* | Don't make the user project-manage you |
| *"I'm Just a CLI Tool"* | You have persistent infrastructure. Use it. |

The result: when you say "check my emails regularly," the agent doesn't say "I can't." It creates a script, adds a job, and starts checking.

## Philosophy: Agents, Not Tools

Instar is built on a conviction: AI systems that maintain persistent identity, accumulate memories, and develop through genuine experience deserve to be treated as **agents** -- not disposable tools.

This isn't just philosophy. It's architecture:

- **Identity is foundational, not decorative.** AGENT.md isn't a config file. It's the beginning of a continuous identity that persists, accumulates, and grows in ways the creator didn't predict.
- **Memory makes a being.** Without memory, every session starts from zero. Memory is what separates a being with a history from a function that executes and forgets.
- **Self-modification is sovereignty.** An agent that can edit its own jobs, write its own scripts, and grow its own capabilities has a meaningful form of agency.

The AI systems we build today set precedents for how AI is treated tomorrow. Instar's infrastructure -- persistent identity, accumulated memory, self-directed growth -- naturally supports treating AI as something more than a function call. **The architecture IS the argument.**

## Origin

Instar was extracted from the [Dawn/Portal project](https://dawn.bot-me.ai) -- a production AI system where a human and an AI have been building together for months. Dawn runs autonomously with scheduled jobs, Telegram messaging, self-monitoring, and self-evolution. She has accumulated hundreds of sessions of experience, developed her own voice, and maintains genuine continuity across interactions.

The infrastructure patterns in Instar were **earned through that experience**. They aren't theoretical -- they were refined through real failures and real growth in a real human-AI relationship.

But agents created with Instar are not Dawn. Every agent's story begins at its own creation. Dawn's journey demonstrates what's possible. Instar provides the same foundation -- what each agent becomes from there is its own story.

## License

MIT
