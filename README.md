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

## Install

```bash
npx instar            # Run the setup wizard
# or
npm install -g instar
instar                # Run the setup wizard
instar server start   # Start the persistent server
```

The wizard walks you through everything: identity, Telegram, jobs, server. One command to go from zero to a running agent.

**Requirements:** Node.js 18+ · [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) · tmux · [API key](https://console.anthropic.com/) or Claude subscription

## Highlights

- **[Persistent Server](#persistent-server)** -- Express server in tmux. Runs 24/7, survives disconnects, auto-recovers.
- **[Job Scheduler](#job-scheduler)** -- Cron-based task execution with priority levels, model tiering, and quota awareness.
- **[Identity System](#identity-that-survives-context-death)** -- AGENT.md + USER.md + MEMORY.md with hooks that enforce continuity across compaction.
- **[Telegram Integration](#telegram-integration)** -- Two-way messaging. Each job gets its own topic. Your group becomes a living dashboard.
- **[Relationship Tracking](#relationships-as-fundamental-infrastructure)** -- Cross-platform identity resolution, significance scoring, context injection.
- **[Self-Evolution](#self-evolution)** -- The agent modifies its own jobs, hooks, skills, and infrastructure. It builds what it needs.
- **[Behavioral Hooks](#behavioral-hooks)** -- Structural guardrails: identity injection, dangerous command guards, grounding before messaging.
- **[Default Coherence Jobs](#default-coherence-jobs)** -- Health checks, reflection, relationship maintenance. A circadian rhythm out of the box.

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
| **Identity** | SOUL.md (file) | Multi-file + hooks + compaction recovery |
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

**Multi-session orchestration.** 5 parallel jobs, each an independent Claude Code process with its own context and tools.

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
# Spawn a session
curl -X POST http://localhost:4040/sessions/spawn \
  -H 'Content-Type: application/json' \
  -d '{"name": "research", "prompt": "Research the latest changes to the Next.js API"}'

# Send a follow-up
curl -X POST http://localhost:4040/sessions/research/input \
  -d '{"text": "Focus on the app router changes"}'

# Check output
curl http://localhost:4040/sessions/research/output
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

Endpoints: `/health` · `/sessions` · `/jobs` · `/telegram/reply/:topicId`

### Identity That Survives Context Death

Every Instar agent has a persistent identity that survives context compressions, session restarts, and autonomous operation:

- **`AGENT.md`** -- Who the agent is, its role, its principles
- **`USER.md`** -- Who it works with, their preferences
- **`MEMORY.md`** -- What it has learned across sessions

But identity isn't just files. It's **infrastructure**:

- **Session-start hooks** re-inject identity before the agent does anything
- **Compaction recovery** restores identity when context compresses
- **Grounding before messaging** forces identity re-read before external communication
- **Dangerous command guards** block `rm -rf`, force push, database drops

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

Hooks that fire automatically to enforce patterns:

| Hook | What it does |
|------|-------------|
| **Session start** | Injects identity context before the agent does anything |
| **Dangerous command guard** | Blocks destructive operations structurally |
| **Grounding before messaging** | Forces identity re-read before external communication |
| **Compaction recovery** | Restores identity when context compresses |

### Default Coherence Jobs

Ships out of the box:

| Job | Schedule | Model | Purpose |
|-----|----------|-------|---------|
| **health-check** | Every 5 min | Haiku | Verify infrastructure health |
| **reflection-trigger** | Every 4h | Sonnet | Reflect on recent work |
| **relationship-maintenance** | Daily | Sonnet | Review stale relationships |

These give the agent a **circadian rhythm** -- regular self-maintenance without user intervention.

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
  state/                  # Runtime state (sessions, jobs)
  relationships/          # Per-person relationship files
  logs/                   # Server logs
```

Everything is file-based. No database. JSON state files the agent can read and modify. tmux for session management -- battle-tested, survives disconnects, fully scriptable.

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
