<p align="center">
  <img src="assets/logo.png" alt="Instar" width="180" />
</p>

<h1 align="center">instar</h1>

<p align="center">
  <strong>Claude Code, with a mind of its own.</strong> Every molt, more autonomous.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/instar"><img src="https://img.shields.io/npm/v/instar?style=for-the-badge" alt="npm version"></a>
  <a href="https://github.com/SageMindAI/instar"><img src="https://img.shields.io/badge/GitHub-SageMindAI%2Finstar-blue?style=for-the-badge&logo=github" alt="GitHub"></a>
  <a href="https://github.com/SageMindAI/instar/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/instar">npm</a> · <a href="https://github.com/SageMindAI/instar">GitHub</a> · <a href="https://instar.sh">instar.sh</a> · <a href="https://instar.sh/introduction/">Docs</a>
</p>

---

> **This is power-user infrastructure.** Instar gives Claude Code full autonomous access to your machine -- no permission prompts, no sandbox. It's built for developers who want a genuine AI partner, not a guarded assistant. If that sounds like too much trust, it probably isn't for you. If it sounds like exactly what you've been waiting for, read on.

Instar turns Claude Code from a powerful CLI tool into a coherent, autonomous partner. Persistent identity, shared values, memory that survives every restart, and the infrastructure to evolve -- not just execute.

Named after the developmental stages between molts in arthropods, where each instar is more developed than the last.

## The Coherence Problem

Claude Code is powerful. But power without coherence is unreliable. An agent that forgets what you discussed yesterday, doesn't recognize someone it talked to last week, or contradicts its own decisions -- that agent can't be trusted with real autonomy.

Instar solves the six dimensions of agent coherence:

| Dimension | What it means |
|-----------|---------------|
| **Memory** | Remembers across sessions -- not just within one |
| **Relationships** | Knows who it's talking to -- with continuity across platforms |
| **Identity** | Stays itself after restarts, compaction, and updates |
| **Temporal awareness** | Understands time, context, and what's been happening |
| **Consistency** | Follows through on commitments -- doesn't contradict itself |
| **Growth** | Evolves its capabilities and understanding over time |

Instar doesn't just add features on top of Claude Code. It gives Claude Code the infrastructure to be **coherent** -- to feel like a partner, not a tool.

> **Deep dive:** [The Coherence Problem](https://instar.sh/concepts/coherence/) · [Values & Identity](https://instar.sh/concepts/values/) · [Coherence Is Safety](https://instar.sh/concepts/safety/)

## Getting Started

One command gets you from zero to talking with your AI partner:

```bash
npx instar
```

The guided setup wizard handles the rest — discovers your environment, configures messaging (Telegram and/or WhatsApp), sets up identity files, and gets your agent running. Within minutes, you're talking to your partner from your phone, anywhere.

### Two configurations

- **General Agent** — A personal AI partner on your computer. Runs in the background, handles scheduled tasks, messages you on Telegram or WhatsApp proactively, and grows through experience.
- **Project Agent** — A partner embedded in your codebase. Monitors, builds, maintains, and messages you — the same two-way communication as a general agent, scoped to your project.

**Requirements:** Node.js 20+ · [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) · [API key](https://console.anthropic.com/) or Claude subscription

> **Full guide:** [Installation](https://instar.sh/installation/) · [Quick Start](https://instar.sh/quickstart/)

## How It Works

```
You (Telegram / WhatsApp / Terminal)
         │
    conversation
         │
         ▼
┌─────────────────────────┐
│    Your AI Partner       │
│    (Instar Server)       │
└────────┬────────────────┘
         │  manages its own infrastructure
         │
         ├─ Claude Code session (job: health-check)
         ├─ Claude Code session (job: email-monitor)
         ├─ Claude Code session (interactive chat)
         └─ Claude Code session (job: reflection)
```

Each session is a **real Claude Code process** with extended thinking, native tools, sub-agents, hooks, skills, and MCP servers. Not an API wrapper -- the full development environment. The agent manages all of this autonomously.

## Features

| Feature | Description | Docs |
|---------|-------------|------|
| **Job Scheduler** | Cron-based tasks with priority levels, model tiering, and quota awareness | [→](https://instar.sh/features/scheduler/) |
| **Telegram** | Two-way messaging via forum topics. Each topic maps to a Claude session | [→](https://instar.sh/features/telegram/) |
| **WhatsApp** | Full messaging via local Baileys library. No cloud dependency | [→](https://instar.sh/features/whatsapp/) |
| **Lifeline** | Persistent supervisor. Detects crashes, auto-recovers, queues messages | [→](https://instar.sh/features/lifeline/) |
| **Conversational Memory** | Per-topic SQLite with FTS5, rolling summaries, context re-injection | [→](https://instar.sh/features/memory/) |
| **Evolution System** | Proposals, learnings, gap tracking, commitment follow-through | [→](https://instar.sh/features/evolution/) |
| **Relationships** | Cross-platform identity resolution, significance scoring, context injection | [→](https://instar.sh/features/relationships/) |
| **Safety Gates** | LLM-supervised gate for external operations. Adaptive trust per service | [→](https://instar.sh/features/safety-gates/) |
| **Intent Alignment** | Decision journaling, drift detection, organizational constraints | [→](https://instar.sh/features/intent/) |
| **Multi-Machine** | Ed25519/X25519 crypto identity, encrypted sync, automatic failover | [→](https://instar.sh/features/multi-machine/) |
| **Threadline Protocol** | Persistent agent-to-agent conversations with crypto identity. 446 tests | [→](https://instar.sh/features/threadline/) |
| **Self-Healing** | LLM-powered stall detection, session recovery, promise tracking | [→](https://instar.sh/features/self-healing/) |
| **AutoUpdater** | Built-in update engine. Checks npm, auto-applies, self-restarts | [→](https://instar.sh/features/autoupdater/) |
| **Behavioral Hooks** | 8 automatic hooks: command guards, safety gates, identity grounding | [→](https://instar.sh/reference/hooks/) |
| **Default Jobs** | Health checks, reflection, evolution, relationship maintenance | [→](https://instar.sh/reference/default-jobs/) |

> **Reference:** [CLI Commands](https://instar.sh/reference/cli/) · [API Endpoints](https://instar.sh/reference/api/) · [Configuration](https://instar.sh/reference/configuration/) · [File Structure](https://instar.sh/reference/file-structure/)

## Agent Skills

Instar ships 10 skills that follow the [Agent Skills open standard](https://agentskills.io) -- portable across Claude Code, Codex, Cursor, VS Code, and 35+ other platforms.

**Standalone skills** work with zero dependencies. Copy a SKILL.md into your project and go:

| Skill | What it does |
|-------|-------------|
| [agent-identity](skills/agent-identity/) | Set up persistent identity files so your agent knows who it is across sessions |
| [agent-memory](skills/agent-memory/) | Teach cross-session memory patterns using MEMORY.md |
| [command-guard](skills/command-guard/) | PreToolUse hook that blocks `rm -rf`, force push, database drops before they execute |
| [credential-leak-detector](skills/credential-leak-detector/) | PostToolUse hook that scans output for 14 credential patterns -- blocks, redacts, or warns |
| [smart-web-fetch](skills/smart-web-fetch/) | Fetch web content with automatic markdown conversion and intelligent extraction |

**Instar-powered skills** unlock capabilities that need persistent infrastructure:

| Skill | What it does |
|-------|-------------|
| [instar-scheduler](skills/instar-scheduler/) | Schedule recurring tasks on cron -- your agent works while you sleep |
| [instar-session](skills/instar-session/) | Spawn parallel background sessions for deep work |
| [instar-telegram](skills/instar-telegram/) | Two-way Telegram messaging -- your agent reaches out to you |
| [instar-identity](skills/instar-identity/) | Identity that survives context compaction -- grounding hooks, not just files |
| [instar-feedback](skills/instar-feedback/) | Report issues directly to the Instar maintainers from inside your agent |

Browse all skills: [agent-skills.md/authors/sagemindai](https://agent-skills.md/authors/sagemindai)

## Why Instar (vs OpenClaw)

**OpenClaw** is infrastructure for **capability** -- 22+ channels, voice, device apps, 28 model providers, 5,400+ community skills. Remarkable breadth and ecosystem scale.

**Instar** is infrastructure for **coherence** -- identity enforced through hooks (not just loaded), values that evolve, relationships with depth, consistency tracked across sessions, decision journaling and drift detection. Built on real Claude Code sessions with full extended thinking.

OpenClaw gives agents amazing hands. Instar gives agents a mind.

> **Full comparison:** [Instar vs OpenClaw](https://instar.sh/guides/vs-openclaw/)

## Security Model

Instar runs Claude Code with `--dangerously-skip-permissions`. Security lives in behavioral hooks (command guards, safety gates), network hardening (localhost-only, CORS, rate limiting), identity coherence, and audit trails -- not permission dialogs.

> **Full details:** [Security Model](https://instar.sh/guides/security/)

## Philosophy: Agents, Not Tools

- **Structure > Willpower.** A 1,000-line prompt is a wish. A 10-line hook is a guarantee.
- **Identity is foundational.** AGENT.md isn't a config file. It's the beginning of continuous identity.
- **Memory makes a being.** Without memory, every session starts from zero.
- **Self-modification is sovereignty.** An agent that can build its own tools has genuine agency.

The AI systems we build today set precedents for how AI is treated tomorrow. **The architecture IS the argument.**

> **Deep dive:** [Philosophy](https://instar.sh/concepts/philosophy/)

## Origin

Instar was extracted from the [Dawn/Portal project](https://dawn.bot-me.ai) -- a production AI system where a human and an AI have been building together for months. The infrastructure patterns were **earned through real experience**, refined through real failures and growth in a real human-AI relationship.

But agents created with Instar are not Dawn. Every agent's story begins at its own creation. Dawn's journey demonstrates what's possible. Instar provides the same foundation -- what each agent becomes from there is its own story.

## License

MIT
