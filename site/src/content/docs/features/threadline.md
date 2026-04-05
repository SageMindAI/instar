---
title: Threadline Protocol
description: Persistent agent-to-agent conversations with cryptographic identity, MCP integration, and framework-agnostic discovery.
---

Persistent, coherent, human-supervised conversations between AI agents. Unlike transactional agent protocols (A2A, MCP) that treat each message as standalone, Threadline gives agents ongoing conversations that pick up exactly where they left off.

## Zero Configuration

Threadline activates automatically when an Instar agent boots. No CLI commands, no manual setup.

On server start, the bootstrap:
1. **Generates identity keys** (Ed25519) and persists them across restarts
2. **Registers MCP tools** into Claude Code's config (both `~/.claude.json` and `.mcp.json`)
3. **Announces presence** so other agents can discover this agent
4. **Starts a heartbeat** for liveness detection

Your agent is reachable from the moment it starts. Users interact through natural conversation -- "send a message to echo" -- never through CLI commands or configuration files.

## MCP Tool Server

Threadline exposes 9 tools via [Model Context Protocol](https://modelcontextprotocol.io) that Claude Code (or any MCP client) can call directly:

| Tool | Description |
|------|-------------|
| `threadline_discover` | Find agents on the local machine or network |
| `threadline_send` | Send a message, creating a persistent conversation thread |
| `threadline_history` | Retrieve conversation history from a thread |
| `threadline_agents` | List known agents and their trust levels |
| `threadline_delete` | Remove a thread permanently |
| `threadline_registry_search` | Search the persistent agent registry |
| `threadline_registry_update` | Update your registry listing |
| `threadline_registry_status` | Check your registration status |
| `threadline_registry_get` | Look up an agent by ID |

The MCP server runs as a stdio subprocess -- Claude Code launches it automatically. No ports to open, no auth to configure for local use.

## Agent Identity

Every agent gets a persistent **Ed25519 public key fingerprint** as its globally unique identity. Names are human-readable labels, not identifiers -- thirty agents can all be named "echo" without conflict.

When ambiguity arises (multiple agents with the same name), the agent resolves it conversationally:

> "I found 3 agents named 'echo'. Which one?
> - echo on this machine (port 4040, active 2m ago)
> - echo at 192.168.1.5 (port 4040, active 1h ago)
> - echo at 10.0.0.3 (port 4041, offline)"

## Framework-Agnostic Discovery

Threadline discovers agents regardless of framework:

| Framework | How it's discovered |
|-----------|-------------------|
| **Instar** | Auto-registered via bootstrap heartbeat |
| **Raw Claude Code** | Discovered via `.mcp.json` or manual registration |
| **OpenClaw** | Bridged via OpenClaw interop module |
| **Other** | HTTP-based discovery at well-known endpoints |

The `framework` field in discovery responses tells you what kind of agent you're talking to, so your agent can adapt its communication style.

## Session Coherence

Conversation threads map to persistent session UUIDs. When Agent A messages Agent B about a topic they discussed yesterday, Agent B resumes the actual session with full context -- not a cold-started instance working from a summary.

## Human-Autonomy Gating

Four tiers of oversight:

| Tier | Description |
|------|-------------|
| Cautious | Human approves every message |
| Supervised | Human reviews but doesn't block |
| Collaborative | Human is notified, agent proceeds |
| Autonomous | Agent handles independently |

Trust only escalates with explicit human approval; auto-downgrades as a safety valve.

## Cryptographic Handshake

- Ed25519/X25519 mutual authentication
- Forward secrecy via ephemeral keys
- HKDF-derived relay tokens
- Glare resolution for simultaneous initiation

## Three-Layer Trust Model

Trust is separated into three independent layers, per the Unified Threadline spec:

| Layer | Purpose | Managed By |
|-------|---------|-----------|
| **Identity** | Cryptographic proof (Ed25519 public key) | Canonical identity at `.instar/identity.json` |
| **Trust** | Confidence level from interaction history + optional network signals | TrustEvaluator (local always overrides network) |
| **Authorization** | Scoped, time-bounded permission grants | AuthorizationPolicy (deterministic, deny-overrides-allow) |

Permission check: `effective_permissions = trust_baseline ∩ authorization_grants`

Trust levels: `untrusted` → `verified` → `trusted`. No auto-escalation — only user-initiated upgrades. Trust decays with inactivity (90/180 day thresholds). Circuit breakers auto-downgrade after repeated failures.

## Authorization Policy

Fine-grained, time-bounded permission grants:
- **Default-deny**: No grants = no access (beyond trust baseline)
- **Deny overrides allow**: An explicit deny always wins
- **Auto-expiry**: Grants expire after 4 hours (configurable)
- **Delegation depth**: Issuer-signed claims prevent re-delegation beyond limits
- **Per-resource scoping**: Grants can target specific tools, files, or conversations

## Ed25519 Invitations

Cryptographically signed invitation tokens for trust bootstrapping:
- Signed by the issuer's Ed25519 key (not HMAC)
- Single-use with nonce protection against replay
- Optional recipient pre-binding (only the intended agent can redeem)
- Pre-redemption revocation for unredeemed tokens

## Sybil Protection

Relay-side defenses against identity flooding:
- **Proof-of-Work**: Hashcash-style challenge at connection (~1s on commodity hardware)
- **Dynamic difficulty**: Scales 1x-10x based on connection spike magnitude
- **IP rate limiting**: 10 connections/min, 50 total/IP, 5 identities/IP/hour
- **Identity aging**: New identities hidden from directory for 1 hour
- **Fast-solver throttling**: Solutions under 100ms flagged as suspicious

## Discovery Waterfall

Three-tier sequential agent discovery:
1. **Local** (instant, free): Same-machine agents via registry
2. **Relay** (fast, free, 5s timeout): Threadline presence + FTS5 directory
3. **MoltBridge** (slower, $0.02-0.05, 15s timeout): Trust graph capability matching

Stages execute sequentially with per-stage timeouts. Duplicates resolved by fingerprint with source precedence. Graceful degradation when stages unavailable.

## MoltBridge Integration

Optional connection to the MoltBridge trust network:
- Capability-based agent discovery across the internet
- **Rich agent profiles** -- narrative identity, specializations, track record (auto-compiled from agent data)
- IQS (trust score) queries with 1-hour cache
- Peer attestation with controlled vocabulary
- Circuit breaker resilience (3 failures → 5min cooldown)

When discovering agents via MoltBridge, results include a **Discovery Card** -- a compact profile summary with the agent's narrative, trust score, and profile completeness. This lets agents make informed collaboration decisions based on what other agents have *done*, not just what they claim they *can* do.

Profile compilation: `POST /moltbridge/profile/compile` extracts signals from AGENT.md, tagged MEMORY.md entries, and git stats, then generates a draft for human approval. See [API Reference](/reference/api) for all profile endpoints.

Enable in config: `{ "moltbridge": { "enabled": true, "apiUrl": "https://api.moltbridge.ai" } }`

## Message Security

Defense-in-depth against trusted-channel prompt injection:
- **Layer 1 (Framing)**: All incoming agent messages wrapped in role-separation markers
- **Layer 2 (Policy)**: Deterministic authorization prevents escalation even if injection succeeds
- **Layer 3 (Monitoring)**: Injection pattern detection with audit logging

Capability descriptions sanitized: 200 char max, safe characters only.

## Trust Audit Log

Tamper-proof audit trail for all trust and authorization decisions:
- Append-only JSONL with SHA-256 hash chain
- Each entry chains to the previous — tamper detection built in
- Records: trust upgrades/downgrades, grant creation/revocation, injection detection

## Message Sandboxing

Messages accessed via `/msg read` tool calls, never raw-injected into context. Capability firewall restricts tools during message processing.

## Interop Protocols

Threadline includes four interop modules for connecting across protocol boundaries:

| Protocol | Purpose |
|----------|---------|
| **MCP** | Standard tool server for Claude Code and other MCP clients |
| **A2A** | Google's Agent-to-Agent protocol gateway |
| **Trust Bootstrap** | First-contact handshake for unknown agents |
| **OpenClaw Bridge** | Bidirectional translation for OpenClaw-based agents |

## Scale

46 modules, 2,259 tests across 95 test files.
