# Agent-Kit vs OpenClaw: Why This Exists

> Foundational positioning document. Articulates what this tool IS, who it's for, and how it stands apart from OpenClaw — the most comparable project in the space.
> Created: 2026-02-18

---

## The One-Line Difference

**OpenClaw** is a multi-channel AI assistant framework. You deploy it, connect messaging platforms, and interact with an AI agent through conversations.

**Agent-Kit** is the fastest way to give a Claude Code agent a persistent body. Install it fresh on a bare machine, or add it to a project you've already been building. Either way, you get autonomy in minutes.

---

## What Each Project Actually Is

### OpenClaw: An AI Assistant You Talk To

OpenClaw is a WebSocket gateway that connects an embedded AI agent (Pi SDK) to 20+ messaging platforms — WhatsApp, Telegram, Discord, iMessage, Signal, Slack, and more. You configure it, deploy it, and then talk to your personal AI assistant across all your channels.

**Key capabilities:**
- 20+ messaging channel adapters (WhatsApp, Telegram, Discord, iMessage, Signal, Slack, etc.)
- Companion apps on macOS, iOS, Android with voice wake and device execution
- SOUL.md bootstrap ritual — the agent co-creates its identity with you on first run
- Docker sandboxing with sophisticated exec approval system
- ClawHub skill marketplace for community-shared capabilities
- 50 bundled skills (smart home, notes, dev tools, media)
- Multi-agent communication via `sessions_send`

**The mental model:** OpenClaw IS the product. You deploy it, and it becomes your AI assistant.

### Agent-Kit: A Persistent Body for Any Claude Code Agent

Agent-Kit gives Claude Code agents the infrastructure to run autonomously. Two paths to the same outcome:

**Fresh install** — `npx agent-kit init my-agent` creates a complete project from scratch: identity files, configuration, hooks, jobs, and a persistent server. Your agent is running in under a minute.

**Existing project** — `cd my-project && npx agent-kit init` adds autonomy infrastructure to what you've already built, without touching your existing code.

**Key capabilities:**
- Persistent server managing Claude Code sessions via tmux
- Cron-based job scheduler with quota-aware gating
- Identity system (AGENT.md, USER.md, MEMORY.md) with hooks that enforce continuity
- Telegram integration as a real-time control plane (every job gets its own topic)
- Relationship tracking across all channels and platforms
- Behavioral hooks (session-start identity injection, dangerous command guards, grounding before messaging, compaction recovery)
- Auth-secured HTTP API for session/job/relationship management
- Health watchdog with auto-recovery
- Default coherence jobs that ship out of the box

**The mental model:** Agent-Kit gives any Claude Code project a body — whether that project existed before or starts right now.

---

## The Architectural Divide

### Runtime: API Wrapper vs. Development Environment

**OpenClaw** wraps the Claude API (via Pi SDK) to create an agent that responds to messages. The agent has tools (bash, read, write, edit), but it's fundamentally a **message-response loop** — users send messages, the agent processes them, the agent responds.

**Agent-Kit** runs on Claude Code — Anthropic's full agentic development environment. Each session is a complete Claude Code instance with:
- Extended thinking
- Native tool ecosystem (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch)
- Sub-agent spawning via Task tool (with model-tier selection: Opus/Sonnet/Haiku)
- Hook system (pre/post tool execution, session lifecycle)
- Skill system (slash-command workflows)
- Context management with automatic compaction
- MCP server integration (Playwright, Chrome extension, etc.)

The difference: OpenClaw's agent executes tools through an API. Agent-Kit's agent IS a development environment.

### Session Model: Single Gateway vs. Multi-Session Orchestration

**OpenClaw** runs a single gateway process. All conversations route through one WebSocket server with one embedded agent. The agent handles multiple users and channels through message routing and session management.

**Agent-Kit** manages multiple independent Claude Code sessions, each running in its own tmux process. The server orchestrates which sessions run, monitors their health, respawns them when they die, and coordinates through Telegram topics and event logs. Each session has its own context, tools, and state.

This means Agent-Kit can run 5 jobs simultaneously — one doing a health check, one processing emails, one engaging on social media, one running reflection, one responding to a Telegram message — each as an independent Claude Code instance with full capabilities.

### Identity: Co-Created Persona vs. Earned Infrastructure

**OpenClaw's SOUL.md** is elegant. On first run, the agent and user have a bootstrap conversation: "Who am I? Who are you?" The result is a self-authored identity file the agent can modify over time. It's personal and charming.

**Agent-Kit's identity system** goes deeper:
- **AGENT.md**: Core identity (like SOUL.md)
- **USER.md**: Understanding of the primary user
- **MEMORY.md**: Accumulated learnings and context
- **Behavioral hooks**: Identity is re-injected on every session start and after every context compaction
- **Grounding before messaging**: Before any external communication, the agent re-reads its identity files
- **Self-evolution**: The agent can update its own identity files, create new skills, write new hooks, and modify its own configuration

The difference isn't the identity file — it's the infrastructure that keeps identity alive across context compressions, session restarts, and autonomous operation.

---

## Who Each Project Serves

### OpenClaw: People Who Want a Personal AI Assistant

OpenClaw's ideal user wants to talk to an AI across all their messaging platforms. They want smart home control, note-taking, dev tools, media management — all through natural conversation. The value is **ubiquity** (AI everywhere you already communicate) and **personality** (an assistant that feels like yours).

### Agent-Kit: Anyone Who Wants a Claude Code Agent That Runs Autonomously

Agent-Kit's ideal user wants a Claude Code agent with a persistent body. They might be:
- **Starting fresh** — They want an autonomous agent and don't have a project yet. `agent-kit init my-agent` creates everything.
- **Augmenting existing work** — They already have a Claude Code project and want it to keep running when they close their laptop.

Either way, they want:
- An agent that keeps running when they close their laptop
- Scheduled tasks (monitoring, maintenance, engagement)
- Telegram communication even when they're away
- Relationship tracking with everyone the agent interacts with
- Memory that persists across sessions
- Automatic crash recovery

The value is **autonomy** (your agent works while you sleep) and **persistence** (it remembers, learns, and grows).

---

## What Agent-Kit Does That OpenClaw Doesn't

### 1. Works Both Ways: Fresh Install or Augment Existing (vs. Being the Product)

OpenClaw IS the AI assistant. You deploy OpenClaw, and that's your product.

Agent-Kit works two ways:
- **Fresh:** `npx agent-kit init my-agent` creates a complete project — identity files, configuration, hooks, jobs, server. Your agent is autonomous in under a minute.
- **Existing:** `cd my-project && npx agent-kit init` adds autonomy infrastructure without touching your existing code. Your CLAUDE.md, skills, hooks, and tools all keep working.

Agent-Kit isn't the product. It gives your agent a body — whether you're starting from scratch or building on what exists.

### 2. Job-Topic Coupling (Every Job Has a Home)

When agent-kit's scheduler creates a job, it automatically creates a Telegram topic for that job. The topic becomes the user's window into the job — status updates, completion reports, and errors all flow there. If a topic is accidentally deleted, it's auto-recreated on next run.

This means your Telegram group becomes a living dashboard of agent activity, organized by job.

### 3. Relationship Tracking as a Core System

Agent-Kit treats relationships as fundamental infrastructure — not a plugin, not an afterthought. Every person the agent interacts with, across any channel or platform, gets a relationship record that grows over time:
- Cross-platform identity resolution (same person on Telegram and email? Merged automatically)
- Interaction history with topic extraction
- Auto-derived significance scoring (frequency + recency + depth)
- Context injection before interactions (the agent "knows" who it's talking to)
- Stale relationship detection (who hasn't been contacted in a while?)

### 4. Behavioral Hooks That Enforce Patterns

Agent-Kit ships with hooks that fire automatically:
- **Session start**: Identity context injected before the agent does anything
- **Dangerous command guard**: Blocks `rm -rf`, `git push --force`, database drops
- **Grounding before messaging**: Before sending any external message, the agent re-reads its identity
- **Compaction recovery**: When Claude's context compresses, identity is re-injected

These aren't suggestions — they're structural guardrails. "Structure over Willpower" means safety and identity aren't things the agent needs to remember. They're things the infrastructure guarantees.

### 5. Multi-Session Orchestration

Agent-Kit's server manages multiple Claude Code sessions running in parallel. Each session is a full Claude Code instance with its own context window, tools, and state. The server:
- Enforces session limits (don't exhaust the machine)
- Monitors session health (detect zombies, reap completed)
- Queues jobs when at capacity, drains when slots open
- Emits events for cross-session awareness

### 6. Default Coherence Jobs

Agent-Kit ships with jobs that run out of the box:
- **health-check** (every 5 min, haiku): Verify infrastructure is healthy
- **reflection-trigger** (every 4h, sonnet): Prompt the agent to reflect on recent work
- **relationship-maintenance** (daily, sonnet): Review stale relationships, update notes

These give the agent a circadian rhythm — regular self-maintenance without user intervention.

---

## What OpenClaw Does That Agent-Kit Doesn't

### 1. 20+ Messaging Channels
OpenClaw connects to WhatsApp, iMessage, Signal, Discord, Slack, Matrix, and more. Agent-Kit currently supports Telegram only. (Discord and Slack are planned.)

### 2. Native Device Apps
OpenClaw has companion apps for macOS, iOS, and Android with voice wake, camera access, location, notifications, and local command execution. Agent-Kit has no device apps.

### 3. Voice Interface
OpenClaw supports always-listening wake words and continuous voice conversation with ElevenLabs TTS. Agent-Kit is text-only.

### 4. Docker Sandboxing
OpenClaw has a sophisticated sandbox system (3 modes x 3 scopes x access levels) for running untrusted code. Agent-Kit runs with the user's permissions (appropriate for single-user, trusted environments).

### 5. Skill Marketplace
OpenClaw has ClawHub — a public skill registry with search, versioning, publishing, and moderation. Agent-Kit has no marketplace (skills are project-local).

### 6. Multi-User Support
OpenClaw handles multiple users across channels with per-user sessions, sender allowlists, and group chat management. Agent-Kit is designed for a single user/developer and their agent.

---

## The Philosophical Difference

**OpenClaw asks:** "How can I be your AI assistant everywhere?"

**Agent-Kit asks:** "How can your Claude Code agent get a persistent body?"

OpenClaw creates a new thing — an AI assistant — and connects it to your world.

Agent-Kit gives any Claude Code agent the infrastructure to live on its own — whether you're starting fresh or building on existing work.

---

## Comparison Table

| Dimension | OpenClaw | Agent-Kit |
|---|---|---|
| **What it is** | AI assistant framework | Autonomy infrastructure (fresh or existing projects) |
| **Runtime** | Pi SDK (API wrapper) | Claude Code (full dev environment) |
| **Session model** | Single gateway | Multi-session orchestration |
| **Identity** | SOUL.md (co-created) | Multi-file + hooks + compaction recovery |
| **Memory** | JSONL + optional vector | File-based + relationship tracking |
| **Messaging** | 20+ channels | Telegram (Discord/Slack planned) |
| **Voice** | Wake word + TTS | None |
| **Device apps** | macOS, iOS, Android | None |
| **Sandbox** | Docker (3x3 matrix) | User permissions |
| **Skills** | 50 + ClawHub marketplace | Project-local + self-creating |
| **Multi-user** | Yes (group chat, allowlists) | Single user |
| **Relationships** | Session-based | Deep tracking (cross-platform, significance, context) |
| **Jobs** | Cron service | Full scheduler with topic coupling |
| **Hooks** | Plugin hooks | Claude Code native hooks |
| **Self-evolution** | SOUL.md updates | Full infrastructure self-modification |
| **Testing** | Not documented | 163 tests (unit + integration + E2E) |
| **Target user** | Anyone wanting AI assistant | Developers building with Claude Code |

---

## Why Both Should Exist

These projects aren't competitors. They serve different needs:

- If you want an **AI assistant** that works across all your messaging platforms, with voice, device apps, and a skill marketplace: **OpenClaw**.
- If you want a **Claude Code agent with a persistent body** — fresh install or existing project — with scheduled jobs, relationship tracking, Telegram control, and self-evolution: **Agent-Kit**.

The overlap is small. The gap between "deploy an AI assistant" and "give an agent a body" is fundamental — not a feature delta, but a category difference.

---

*This document compares Agent-Kit (v0.1.0) against OpenClaw as studied from the open-source repository in February 2026. Both projects are actively evolving.*
