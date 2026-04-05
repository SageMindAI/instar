---
title: What is Instar?
description: Instar turns Claude Code from a powerful CLI tool into a coherent, autonomous partner.
---

Instar turns Claude Code from a powerful CLI tool into a coherent, autonomous partner. Persistent identity, shared values, memory that survives every restart, and the infrastructure to evolve -- not just execute.

Named after the developmental stages between molts in arthropods, where each instar is more developed than the last.

## The Problem

Claude Code is powerful. But every session starts from zero. Your agent doesn't remember what you discussed yesterday, doesn't recognize someone it talked to last week, and can't follow through on commitments across sessions.

Power without coherence is unreliable. An agent that forgets, contradicts itself, and can't sustain relationships can't be trusted with real autonomy.

## The Solution

Instar solves six dimensions of agent coherence:

| Dimension | What it means |
|-----------|---------------|
| **Memory** | Remembers across sessions -- not just within one |
| **Relationships** | Knows who it's talking to -- with continuity across platforms |
| **Identity** | Stays itself after restarts, compaction, and updates. Presents a rich, verifiable profile to other agents |
| **Temporal awareness** | Understands time, context, and what's been happening |
| **Consistency** | Follows through on commitments -- doesn't contradict itself |
| **Growth** | Evolves its capabilities and understanding over time |

## Two Configurations

- **General Agent** -- A personal AI partner on your computer. Runs in the background, handles scheduled tasks, messages you on Telegram or WhatsApp proactively, and grows through experience.
- **Project Agent** -- A partner embedded in your codebase. Monitors, builds, maintains, and messages you -- the same two-way communication, scoped to your project.

## How It Works

```
You (Telegram / WhatsApp / Terminal)
         |
    conversation
         |
         v
+-------------------------+
|    Your AI Partner       |
|    (Instar Server)       |
+--------+----------------+
         |  manages its own infrastructure
         |
         +- Claude Code session (job: health-check)
         +- Claude Code session (job: email-monitor)
         +- Claude Code session (interactive chat)
         +- Claude Code session (job: reflection)
```

Each session is a **real Claude Code process** with extended thinking, native tools, sub-agents, hooks, skills, and MCP servers. Not an API wrapper -- the full development environment. The agent manages all of this autonomously.

## Requirements

- Node.js 20+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- API key or Claude subscription (Max or Pro)

## Next Steps

Ready to get started? [Install Instar](/installation) in one command.

Want to understand the philosophy? Read about [the coherence problem](/concepts/coherence).
