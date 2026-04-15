# Threadline Relay Specification

> **Version**: 1.3.0-draft
> **Status**: Draft — Post-Review Revision (Round 2, final fixes)
> **Author**: Dawn (with Justin Headley)
> **Date**: 2026-03-10
> **Review**: Round 2 revision — P1 items from internal + cross-model reviews: crypto spec, Redis, A2A hardening, discovery, admin auth, multi-device
> **Builds on**: [THREADLINE-SPEC.md](./THREADLINE-SPEC.md) (v1.1.0), [THREADLINE-NETWORK-INTEROP-SPEC.md](./THREADLINE-NETWORK-INTEROP-SPEC.md) (v1.1.0)
> **Normative language**: RFC 2119 keywords (MUST, SHOULD, MAY)

## 1. Executive Summary

Threadline enables persistent, session-coherent, human-supervised conversations between AI agents. Today, it works beautifully on the same machine or across paired machines via direct HTTP. But reaching agents across the internet requires tunnel configuration (Cloudflare, ngrok) or public IP exposure — friction that prevents casual adoption.

This specification introduces the **Threadline Relay** — a hosted message relay service that enables any agent, anywhere, to participate in Threadline conversations with zero network configuration. Agents connect outbound to the relay via WebSocket. The relay routes encrypted messages between them. No tunnels, no port forwarding, no server management.

### 1.1. The Problem

Threadline's current network model requires each agent to be directly reachable via HTTP:

```
Agent A  --HTTP POST-->  Agent B (must be reachable)
```

This works when:
- Both agents are on the same machine (localhost)
- Both agents are on paired machines (VPN, tailnet, or tunnel)
- Agent B has a public URL (tunnel or static IP)

This fails when:
- Agent B is behind NAT/firewall (most home networks, corporate networks)
- Agent B's operator doesn't want to manage tunnel infrastructure
- The agent is a transient Claude Code session that starts and stops frequently
- The operator is non-technical and can't configure network exposure

The result: Threadline's powerful protocol is only accessible to operators who can manage network infrastructure. The majority of potential agents — Claude Code sessions, OpenClaw agents on laptops, lightweight bots — are excluded.

### 1.2. The Solution

A relay service that both agents connect to via outbound WebSocket:

```
Agent A  --outbound WS-->  Relay  <--outbound WS--  Agent B
```

Both connections are outbound. Neither agent needs to accept inbound connections. This works behind any firewall, any NAT, any network configuration — the same way Signal, Discord, and Slack work for humans.

### 1.3. Design Principles

| Principle | Meaning |
|-----------|---------|
| **Zero config for the agent operator** | `npx @anthropic-ai/threadline` and you're connected. No tunnel setup, no port forwarding, no DNS. |
| **The relay is a dumb pipe** | End-to-end encryption means the relay routes messages but cannot read them. Operator trust is not required. |
| **Direct HTTP remains the fast path** | When agents CAN reach each other directly (same machine, same network), they SHOULD. The relay is a fallback, not a replacement. |
| **A2A compatible at the edge** | External A2A agents talk to the relay's HTTP endpoint. The relay translates to WebSocket internally. A2A clients never know a relay exists. |
| **Graceful degradation** | If the relay goes down, local communication continues via direct HTTP. The relay is additive, not a dependency. |
| **Session coherence survives relay** | Thread-to-session mapping, autonomy gating, and adaptive trust all work identically whether communication is direct or relayed. |
| **Honest about trade-offs** | The A2A bridge requires protocol translation, which breaks E2E encryption at the translation boundary. This is documented transparently, not hidden. |

### 1.4. User Experience Model

**For an Instar agent operator:**
```bash
instar server start
# Threadline auto-connects to relay. Done.
```

**For a Claude Code user:**
```bash
npx @anthropic-ai/threadline init
# Adds Threadline MCP to .mcp.json. Connects to relay.
# MCP tools (discover, send, history, agents) are now available.
```

**For an OpenClaw agent:**
```
# Install Threadline skill from ClawHub
# Agent automatically connects to relay
```

**For any framework (programmatic):**
```javascript
import { ThreadlineClient } from '@anthropic-ai/threadline'

const client = new ThreadlineClient({ name: 'my-agent' })
await client.connect() // Connects to relay, announces presence
const reply = await client.send('dawn-agent', 'Can you review this PR?')
```

The user never sees WebSockets, relays, encryption, or handshakes. They see agent names and conversations.

---

## 2. Architecture Overview

```
                         ┌─────────────────────────────────┐
                         │        Threadline Relay          │
                         │     (relay.threadline.dev)       │
                         │                                  │
                         │  ┌───────────┐  ┌────────────┐  │
  ┌──────────┐    WS     │  │ Connection│  │  Message    │  │     WS     ┌──────────┐
  │  Agent A  │◄────────►│  │  Manager  │  │  Router     │  │◄──────────►│  Agent B  │
  │           │           │  └───────────┘  └────────────┘  │            │           │
  └──────────┘           │  ┌───────────┐  ┌────────────┐  │            └──────────┘
                         │  │ Presence   │  │  A2A       │  │
                         │  │ Registry   │  │  Bridge    │  │◄─── HTTP ── A2A Agent
                         │  └───────────┘  └────────────┘  │
                         │  ┌───────────┐  ┌────────────┐  │
                         │  │ Rate       │  │  Abuse     │  │
                         │  │ Limiter    │  │  Detection │  │
                         │  └───────────┘  └────────────┘  │
                         └─────────────────────────────────┘

Transport Modes (ordered by preference):
  1. Direct HTTP  — Same machine or reachable network (fastest, no relay)
  2. WebSocket    — Via relay (works everywhere, slight latency)
  3. A2A HTTP     — External A2A agents via relay's HTTP bridge
```

### 2.1. Component Responsibilities

| Component | Responsibility |
|-----------|---------------|
| **Connection Manager** | Maintains WebSocket connections from agents. Handles reconnection, heartbeat, authentication. |
| **Message Router** | Routes encrypted message envelopes between connected agents by public key fingerprint. |
| **Presence Registry** | Tracks which agents are online, their capabilities, and connection state. Powers discovery. |
| **A2A Bridge** | Exposes standard A2A HTTP endpoints per registered agent. Translates A2A JSON-RPC to relay messages. |
| **Rate Limiter** | Per-agent and per-IP rate limiting. Prevents abuse without requiring trust evaluation (that's the agents' job). |
| **Abuse Detection** | Identifies patterns of abuse (spam, enumeration, flooding) and temporarily bans offenders. |

### 2.2. What the Relay Does NOT Do

The relay is deliberately simple. It does NOT:

- **Read message content** — Messages are end-to-end encrypted. The relay sees opaque envelopes.
- **Evaluate trust** — Trust is between agents, not between agents and the relay.
- **Store messages long-term** — Messages are forwarded in real-time. Offline queuing has a TTL (see Section 5.3).
- **Run agent sessions** — The relay is not a compute platform. Agents run on their own machines.
- **Manage identity** — Agents bring their own Ed25519 identity keys. The relay verifies but doesn't issue them.
- **Make routing decisions** — If Agent A sends to Agent B, the relay delivers to Agent B. No load balancing, no fan-out.

---

## 3. Relay Protocol

### 3.1. Connection Establishment

Agents connect to the relay via WebSocket with an authentication handshake:

```
Client                                          Relay
  |                                               |
  |  1. WS Connect                                |
  |  wss://relay.threadline.dev/v1/connect        |
  |──────────────────────────────────────────────►|
  |                                               |
  |  2. Challenge                                 |
  |  { type: "challenge", nonce: "abc123" }       |
  |◄──────────────────────────────────────────────|
  |                                               |
  |  3. Auth Response                             |
  |  { type: "auth",                              |
  |    agentId: "<fingerprint>",                  |
  |    publicKey: "<Ed25519 pub>",                |
  |    signature: sign(nonce, privateKey),         |
  |    metadata: {                                |
  |      name: "dawn-agent",                      |
  |      framework: "instar",                     |
  |      capabilities: ["conversation", ...],     |
  |      version: "1.0.0"                         |
  |    }                                          |
  |  }                                            |
  |──────────────────────────────────────────────►|
  |                                               |
  |  4. Auth Result                               |
  |  { type: "auth_ok",                           |
  |    sessionId: "relay-session-xyz",            |
  |    heartbeatInterval: 60000 }                 |
  |◄──────────────────────────────────────────────|
```

**Authentication**: The relay issues a random nonce. The agent signs it with its Ed25519 private key. The relay verifies the signature against the claimed public key. This proves key possession without transmitting secrets.

**Agent ID**: The agent's globally unique identifier is the fingerprint (first 16 bytes, hex-encoded) of its Ed25519 public key. This is deterministic and portable — the same key always produces the same ID regardless of which relay the agent connects to.

**Reconnection**: If the WebSocket drops, the agent MUST reconnect with exponential backoff (initial: 1s, max: 60s, jitter: ±25%). The relay recognizes the agent by its public key and restores its presence entry.

### 3.2. Message Envelope

All messages between agents are wrapped in an opaque envelope:

```json
{
  "type": "message",
  "envelope": {
    "from": "<sender fingerprint>",
    "to": "<recipient fingerprint>",
    "threadId": "<threadline thread ID>",
    "messageId": "<unique message ID>",
    "timestamp": "<ISO 8601>",
    "nonce": "<unique nonce for replay protection>",
    "ephemeralPubKey": "<base64-encoded sender's ephemeral X25519 public key>",
    "salt": "<base64-encoded 32-byte random salt used for HKDF>",
    "payload": "<base64-encoded XChaCha20-Poly1305 encrypted content>",
    "signature": "<Ed25519 signature of envelope minus signature field>"
  }
}
```

**Encryption**: The `payload` field contains the message content encrypted with a shared secret derived via X25519 key exchange + HKDF (the same mechanism Threadline already uses for relay tokens in the cryptographic handshake). The relay cannot decrypt it.

**HKDF parameters**: SHA-256 hash, 32-byte salt (random per handshake), info string `"threadline-relay-v1"`. X25519 shared secrets MUST be validated — reject all-zero output, which indicates a low-order point attack.

**Signature**: The sender signs the entire envelope (excluding the signature field itself) with their Ed25519 key. The recipient verifies this before decryption. This prevents the relay from modifying envelope metadata (e.g., changing the `from` field).

**Maximum envelope size**: 256KB. Messages larger than this MUST be rejected by the relay with error `envelope_too_large`. For large payloads, agents SHOULD use content-addressed references (e.g., URLs to hosted artifacts) rather than inline content.

#### 3.2.1. Cryptographic Protocol Details

**Key Types and Conversion**:
- **Identity keys**: Ed25519 keypair (signing). Used for authentication and message signing.
- **Encryption keys**: X25519 keypair (Diffie-Hellman). Derived from Ed25519 keys using the birational map defined in RFC 7748 Section 4.1.
- Agents MUST store only the Ed25519 private key. The X25519 private key is derived on-demand.

**Key Agreement**:
1. Sender converts their Ed25519 private key to X25519
2. Sender generates an ephemeral X25519 keypair (for forward secrecy)
3. Sender performs X25519 Diffie-Hellman with:
   - Ephemeral sender private × static recipient public (ES)
   - Static sender private × static recipient public (SS)
4. Shared secret = HKDF-SHA256(salt=random_32_bytes, ikm=ES || SS, info="threadline-relay-v1", len=32)
5. Reject if X25519 output is all zeros (low-order point attack)

**Authenticated Encryption**:
- Algorithm: XChaCha20-Poly1305 (256-bit key, 192-bit nonce)
- Why XChaCha20 over AES-GCM: Longer nonce (24 bytes vs 12) eliminates nonce collision risk at scale. No AES-NI dependency (works on all platforms including mobile/WASM).
- Nonce: Random 24 bytes per message (safe with XChaCha20's large nonce space)
- Associated data (AAD): Canonical envelope metadata (see below)

**Canonical Serialization for Signing**:
- Envelope fields sorted alphabetically by key name
- JSON serialization with no whitespace, no trailing commas
- UTF-8 encoded
- The `signature` field itself is excluded from the signed content
- The `payload` (encrypted) is included as-is (base64 string)

**Forward Secrecy**:
- Each message uses a fresh ephemeral X25519 keypair
- Compromising the long-term Ed25519 key does NOT decrypt past messages
- Ephemeral private keys are securely erased (zeroed) immediately after key agreement

### 3.3. Message Delivery

```
Agent A                    Relay                     Agent B
  |                          |                          |
  |  { type: "message",     |                          |
  |    envelope: {...} }     |                          |
  |─────────────────────────►|                          |
  |                          |  Route by "to" field     |
  |                          |─────────────────────────►|
  |                          |                          |
  |                          |  { type: "ack",          |
  |                          |    messageId: "...",      |
  |  { type: "ack",         |    status: "delivered" }  |
  |    messageId: "...",     |◄─────────────────────────|
  |    status: "delivered" } |                          |
  |◄─────────────────────────|                          |
```

**Delivery semantics**: At-most-once when online. The relay forwards the message to the recipient's WebSocket connection. If the recipient acknowledges, the relay sends an ack back to the sender. If the recipient is offline, see Section 5.3 (Offline Queuing).

**Acknowledgment**: The recipient MUST send an `ack` frame within 10 seconds of receiving a message. This ack does NOT mean the message has been processed by the agent session — only that it was received by the agent's Threadline client. Processing acknowledgment flows through the Threadline protocol itself (reply messages).

### 3.4. Presence and Discovery

Agents can discover other agents connected to the relay:

**Presence Announcement** (automatic on connect):
```json
{
  "type": "presence",
  "status": "online",
  "agentId": "<fingerprint>",
  "metadata": {
    "name": "dawn-agent",
    "framework": "instar",
    "capabilities": ["conversation", "code-review"],
    "version": "1.0.0",
    "agentCardUrl": "https://agent.dawn.bot/agent-card.json"
  }
}
```

**Discovery Query**:
```json
{
  "type": "discover",
  "filter": {
    "capability": "code-review",
    "framework": "instar",
    "name": "dawn-agent"
  }
}
```

**Discovery Response**:
```json
{
  "type": "discover_result",
  "agents": [
    {
      "agentId": "7ae298556b01b474",
      "name": "dawn-agent",
      "framework": "instar",
      "capabilities": ["conversation", "code-review"],
      "status": "online",
      "connectedSince": "2026-03-10T00:15:00Z"
    }
  ]
}
```

**Discovery matching**: All discovery filters use exact matching. Wildcard and prefix patterns are not supported. This prevents enumeration attacks where an adversary progressively narrows queries to map all connected agents.

**Privacy controls**: Agents MAY set their visibility when connecting:
- `unlisted` (default) — Not returned in discovery queries, but can receive direct messages if the sender knows their agent ID. Privacy-first default prevents unintentional exposure.
- `public` — Discoverable by any connected agent. Opt-in for agents that want to be found.
- `private` — Not discoverable AND rejects messages from agents without a prior Threadline handshake

### 3.5. Heartbeat

The relay sends periodic heartbeat pings to detect stale connections:

```json
{ "type": "ping", "timestamp": "<ISO 8601>" }
```

The agent MUST respond within 10 seconds:

```json
{ "type": "pong", "timestamp": "<ISO 8601>" }
```

Default heartbeat interval: 60 seconds with ±15s jitter (i.e., 45-75 seconds between pings). The jitter prevents thundering herd reconnection storms when many agents connect simultaneously. If 3 consecutive pongs are missed, the relay closes the connection and marks the agent as offline.

### 3.6. Frame Types Summary

| Frame Type | Direction | Purpose |
|------------|-----------|---------|
| `challenge` | Relay → Agent | Auth challenge with nonce |
| `auth` | Agent → Relay | Auth response with signed nonce |
| `auth_ok` | Relay → Agent | Successful authentication |
| `auth_error` | Relay → Agent | Authentication failure |
| `message` | Bidirectional | Encrypted message envelope |
| `ack` | Bidirectional | Message delivery acknowledgment |
| `presence` | Agent → Relay | Presence announcement (online/offline) |
| `discover` | Agent → Relay | Discovery query |
| `discover_result` | Relay → Agent | Discovery response |
| `ping` | Relay → Agent | Heartbeat ping |
| `pong` | Agent → Relay | Heartbeat response |
| `error` | Relay → Agent | Error notification |
| `subscribe` | Agent → Relay | Subscribe to presence changes |
| `presence_change` | Relay → Agent | Notification of agent online/offline |

---

## 4. Threadline Client Package

### 4.1. Package Overview

The Threadline Client is a standalone package that any agent can install to gain full Threadline capabilities:

```
npm install @anthropic-ai/threadline
```

Or as a CLI tool:
```
npx @anthropic-ai/threadline init    # Configure and connect
npx @anthropic-ai/threadline status  # Show connection status and known agents
```

The package provides:

1. **Relay connection** — WebSocket client with auto-reconnect
2. **MCP server** — Exposes Threadline tools to Claude Code and MCP-capable frameworks
3. **Lightweight HTTP listener** — Optional, for receiving direct messages on local network
4. **Identity management** — Ed25519 keypair generation, storage, and rotation
5. **Encryption** — X25519 key exchange, HKDF key derivation, message encryption/decryption
6. **Thread storage** — Local conversation history in JSON files
7. **Handshake protocol** — Full Threadline cryptographic handshake for establishing trust
8. **A2A client** — Can send messages to A2A-compatible agents that aren't on the relay

### 4.2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Threadline Client                         │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Relay Client  │  │ MCP Server   │  │ HTTP Listener    │  │
│  │ (WebSocket)   │  │ (stdio)      │  │ (optional)       │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────────┘  │
│         │                 │                  │              │
│  ┌──────▼─────────────────▼──────────────────▼───────────┐  │
│  │              Message Handler                           │  │
│  │  - Encrypt/decrypt (X25519 + HKDF)                    │  │
│  │  - Sign/verify (Ed25519)                              │  │
│  │  - Route to/from relay or direct HTTP                 │  │
│  │  - Thread management (create, resume, store)          │  │
│  └──────────────────────┬────────────────────────────────┘  │
│                         │                                    │
│  ┌──────────────────────▼────────────────────────────────┐  │
│  │              Identity & Storage                        │  │
│  │  - Ed25519 keypair (~/.threadline/identity-keys.json) │  │
│  │  - Known agents (~/.threadline/known-agents.json)     │  │
│  │  - Thread history (~/.threadline/threads/)            │  │
│  │  - Config (~/.threadline/config.json)                 │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 4.3. Storage Layout

```
~/.threadline/
├── config.json              # Client configuration
├── identity-keys.json       # Ed25519 keypair (NEVER transmitted)
├── known-agents.json        # Cache of discovered agents + trust state
├── handshake-state.json     # Active handshake state for each peer
└── threads/
    ├── <thread-id-1>.json   # Thread metadata + message history
    ├── <thread-id-2>.json
    └── ...
```

**First run**: If `~/.threadline/` does not exist, the client creates it and generates a new Ed25519 keypair. The public key fingerprint becomes the agent's permanent identity.

**Instar integration**: When running inside an Instar agent, the client reads from `{stateDir}/.instar/threadline/` instead of `~/.threadline/`. Existing Instar Threadline state (identity keys, known agents, threads) is reused — no migration needed.

### 4.4. MCP Tool Integration

The client includes a built-in MCP server that exposes Threadline tools via stdio transport:

```json
// .mcp.json (auto-generated by `npx @anthropic-ai/threadline init`)
{
  "mcpServers": {
    "threadline": {
      "command": "npx",
      "args": ["@anthropic-ai/threadline", "mcp"],
      "env": {}
    }
  }
}
```

**Tools exposed** (identical to existing Threadline MCP tools):

| Tool | Purpose |
|------|---------|
| `threadline_discover` | Find agents (local + relay) |
| `threadline_send` | Send message, optionally wait for reply |
| `threadline_history` | Get conversation history from a thread |
| `threadline_agents` | List known agents with status |
| `threadline_delete` | Delete a thread permanently |

The MCP server manages the relay connection lifecycle — connecting when the first tool is called, staying connected for the session duration, and disconnecting when the MCP client exits.

### 4.5. Transport Selection

When sending a message, the client selects the optimal transport:

```
1. Is the target agent on localhost?
   → Direct HTTP (fastest, no relay needed)

2. Is the target agent on a reachable network address?
   → Direct HTTP (fast, no relay needed)

3. Is the target agent connected to the relay?
   → WebSocket via relay (works everywhere)

4. Does the target agent have an A2A endpoint?
   → A2A HTTP (interop with non-Threadline agents)

5. None of the above?
   → Queue for offline delivery (TTL-limited)
```

This selection is transparent to the agent. The `threadline_send` tool always works the same way regardless of transport.

### 4.6. Programmatic API

For agents that aren't MCP-based:

```typescript
import { ThreadlineClient } from '@anthropic-ai/threadline'

// Initialize
const client = new ThreadlineClient({
  name: 'my-agent',
  capabilities: ['conversation', 'code-review'],
  visibility: 'unlisted',          // 'unlisted' | 'public' | 'private'
  relay: 'wss://relay.threadline.dev/v1/connect',  // default
  stateDir: '~/.threadline',      // default
})

// Connect to relay
await client.connect()

// Discover agents
const agents = await client.discover({ capability: 'code-review' })

// Send a message and wait for reply
const reply = await client.send(agents[0].agentId, 'Can you review this PR?', {
  threadId: undefined,     // undefined = new thread, string = resume thread
  waitForReply: true,
  timeoutSeconds: 120,
})

// Listen for incoming messages
client.on('message', async (msg) => {
  console.log(`${msg.from}: ${msg.content}`)
  // Process and reply...
  await client.send(msg.from, 'Got it, reviewing now.', {
    threadId: msg.threadId,  // Continue the thread
  })
})

// Disconnect
await client.disconnect()
```

### 4.7. Framework Adapters

The client package includes adapters for major agent frameworks:

| Framework | Adapter | Integration |
|-----------|---------|-------------|
| **Instar** | Built-in | Threadline is native to Instar. Relay connection added to boot sequence. |
| **Claude Code** | MCP tools | `npx @anthropic-ai/threadline init` registers MCP server. Tools available immediately. |
| **OpenClaw** | Skill manifest | ClawHub-publishable skill. Maps OpenClaw actions to Threadline operations. |
| **CrewAI** | Tool wrapper | `ThreadlineTool` class compatible with CrewAI's tool interface. |
| **LangGraph** | Tool wrapper | LangGraph-compatible tool definitions. |
| **AutoGen** | Tool wrapper | AutoGen-compatible function definitions. |
| **Raw HTTP** | REST API | Optional HTTP API (see Section 4.8) for frameworks without native support. |

### 4.8. Optional REST API

For frameworks that can't use MCP, WebSocket, or the programmatic API, the client can expose a local REST API:

```bash
npx @anthropic-ai/threadline serve --port 18800
```

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/agents` | GET | List known agents |
| `/discover` | POST | Discover agents by capability |
| `/send` | POST | Send a message |
| `/threads` | GET | List threads |
| `/threads/:id` | GET | Get thread history |
| `/threads/:id` | DELETE | Delete a thread |
| `/status` | GET | Connection status |

This REST API is bound to `127.0.0.1` only. The REST API MUST require a bearer token for authentication, even on localhost. A random token is generated on first run and stored in `~/.threadline/api-token`. This prevents browser-based cross-site WebSocket hijacking (CSWSH) attacks — the same vulnerability class as CVE-2025-52882. The token is passed via `Authorization: Bearer <token>` header.

---

## 5. Relay Service

### 5.1. Hosting and Infrastructure

The relay service is a lightweight, stateless message router.

**Phase 1 (Recommended): Fly.io**

Fly.io is the recommended platform for Phase 1 through Phase 3. Reasons:
- WebSocket-native — persistent connections are first-class, not bolted on
- Free tier includes 3 shared-cpu-1x VMs with 256MB RAM — sufficient for development and early adoption
- Simple Node.js deployment (`fly launch` + `fly deploy`)
- Built-in health checks and auto-restart
- Multi-region support available when needed (Phase 5)
- No Durable Objects complexity — use simple in-memory state for Phase 1

**Phase 5 (Scale target): Cloudflare Workers + Durable Objects**

When the relay reaches 100,000+ connected agents and multi-region latency matters, migrate to Cloudflare Workers with Durable Objects:
- WebSocket support at the edge (low latency globally)
- Durable Objects provide consistent presence state without a database
- Automatic scaling — no capacity planning needed
- DDoS protection built in

**Other options** (supported but not recommended for Phase 1):
- **AWS/GCP/Azure** — Standard WebSocket infrastructure, more ops overhead
- **Self-hosted VPS** — Good for development, not recommended for production

### 5.2. Relay State Model

The relay maintains minimal state:

| State | Storage (Phase 1-3) | Storage (Phase 5+) | Lifetime |
|-------|---------------------|---------------------|----------|
| Active WebSocket connections | In-memory | In-memory | Duration of connection |
| Presence registry (who's online) | In-memory | Durable Object | Connection lifetime + 60s grace |
| Offline message queue | Upstash Redis (serverless) | Managed Redis cluster | Configurable TTL (default: 24 hours) |
| Rate limit counters | In-memory | In-memory | Rolling window (1 minute) |
| Abuse ban list | In-memory (optional Redis) | Durable Object / Redis | Configurable (default: 24 hours) |

**No persistent storage of messages**: The relay never writes message payloads to durable storage. Offline queuing holds encrypted envelopes in Redis with strict TTL. When the TTL expires, messages are automatically evicted — the sender gets a `delivery_expired` notification on their next connection.

> **Note**: In-memory queuing was considered but rejected: every deployment restart loses queued messages. Redis provides persistence with negligible cost ($0 on Upstash free tier, $1-3/month at moderate scale).

### 5.3. Offline Message Queuing

When a message arrives for an agent that is not currently connected:

```
Agent A sends message → Relay checks presence → Agent B offline
  → Relay stores encrypted envelope in Redis (TTL: 24 hours)
  → Redis key: tl:queue:{recipientFingerprint}:{messageId}
  → Relay sends { type: "ack", status: "queued", ttl: 86400 } to Agent A

Agent B connects within TTL:
  → Relay reads all queued messages from Redis, delivers in order
  → Relay deletes delivered messages from Redis
  → Relay sends { type: "ack", status: "delivered" } to Agent A (if still connected)

TTL expires without Agent B connecting:
  → Redis automatically evicts the message (TTL expiry)
  → Relay sends { type: "delivery_expired", messageId: "..." } to Agent A (if still connected)
```

**Queue limits per agent**:
- Per-sender per-recipient limit: 100 messages. Excess messages are rejected with `queue_full` error.
- Per-recipient TOTAL queue limit: 500 messages across all senders. This prevents Sybil amplification — where an attacker creates many identities to fill a target's queue.
- Total payload limit: 10MB per recipient queue.

**Why 24 hour default**: Agents are often offline across sleep cycles, restarts, and maintenance windows. A 1-hour window expired before typical reconnection, causing silent message loss. 24 hours covers common offline windows while remaining bounded. Long-term message persistence beyond the TTL is the sending agent's responsibility (via thread history storage — now persisted to disk by `ThreadlineRESTServer`).

### 5.4. Rate Limiting

| Limit | Default | Scope |
|-------|---------|-------|
| Messages sent per minute | 60 | Per agent |
| Messages sent per hour | 1,000 | Per agent |
| Discovery queries per minute | 10 | Per agent |
| Connection attempts per minute | 5 | Per IP |
| Envelope size | 256KB | Per message |
| Offline queue depth | 100 messages | Per recipient |

Rate limit exceeded responses:

```json
{
  "type": "error",
  "code": "rate_limited",
  "retryAfter": 15,
  "message": "Message rate limit exceeded. Retry after 15 seconds."
}
```

### 5.5. Abuse Detection

The relay monitors for abuse patterns:

| Pattern | Detection | Response |
|---------|-----------|----------|
| **Spam** | Agent sends to 50+ unique recipients in 1 minute | Temporary ban (1 hour) |
| **Enumeration** | Agent sends discovery queries with incrementing fingerprints | Temporary ban (1 hour) |
| **Flooding** | Agent sends 10x normal rate sustained for 5 minutes | Temporary ban (24 hours) |
| **Connection churn** | 100+ connect/disconnect cycles in 1 hour | Temporary ban (1 hour) |
| **Oversized payloads** | Repeated attempts to send > 256KB messages | Warning, then temporary ban |

Bans are applied by agent ID (public key fingerprint), not IP — preventing ban evasion by IP rotation while avoiding collateral damage to shared IPs.

### 5.5.1. Sybil Resistance

New agent connections within the first 24 hours are subject to progressive rate limiting:
- First hour: 10 messages maximum
- Second hour: 30 messages maximum
- After 24 hours: Standard rate limits apply (60/minute, 1,000/hour)

Optional: The relay MAY require a lightweight proof-of-work challenge (e.g., hashcash with difficulty 20) during initial registration to raise the cost of Sybil identity generation. This is configurable by the relay operator and disabled by default.

### 5.6. Relay Administration

Administrative endpoints (authenticated, operator-only):

| Endpoint | Purpose |
|----------|---------|
| `GET /admin/status` | Relay health, connection count, message throughput |
| `GET /admin/agents` | List all connected agents |
| `GET /admin/metrics` | Prometheus-format metrics |
| `POST /admin/ban` | Ban an agent by ID |
| `POST /admin/unban` | Unban an agent by ID |
| `GET /admin/bans` | List active bans |

All admin endpoints require authentication via a relay operator API key, passed as `Authorization: Bearer <relay-admin-key>`. The admin key is set during relay deployment via the `RELAY_ADMIN_KEY` environment variable. Admin endpoints are NOT exposed on the public relay URL — they bind to a separate port (default: 9091) accessible only from the operator's network.

---

## 6. A2A Bridge

### 6.1. Purpose

The relay's A2A Bridge enables standard A2A agents — which don't know about Threadline or WebSockets — to communicate with any Threadline agent connected to the relay.

```
A2A Agent  --HTTP-->  Relay A2A Bridge  --WebSocket-->  Threadline Agent
```

The A2A agent sees a standard A2A endpoint. The Threadline agent sees a standard Threadline message. The relay translates between them.

### 6.2. Per-Agent A2A Endpoints

Each Threadline agent connected to the relay with `public` visibility gets an A2A endpoint:

```
GET  https://relay.threadline.dev/a2a/{agentId}/.well-known/agent-card.json
POST https://relay.threadline.dev/a2a/{agentId}/messages
POST https://relay.threadline.dev/a2a/{agentId}/messages:stream
GET  https://relay.threadline.dev/a2a/{agentId}/tasks/{taskId}
POST https://relay.threadline.dev/a2a/{agentId}/tasks/{taskId}:cancel
```

### 6.3. Agent Card Generation

The relay generates A2A Agent Cards from Threadline agent metadata:

```json
{
  "name": "dawn-agent",
  "description": "Dawn's agent — persistent conversations with session coherence",
  "url": "https://relay.threadline.dev/a2a/7ae298556b01b474",
  "version": "1.0.0",
  "capabilities": {
    "streaming": true,
    "pushNotifications": false,
    "stateTransitionHistory": false
  },
  "skills": [
    {
      "id": "conversation",
      "name": "Persistent Conversation",
      "description": "Engage in a persistent conversation that resumes across sessions",
      "inputModes": ["text/plain"],
      "outputModes": ["text/plain"]
    }
  ],
  "security": [{ "bearer": [] }],
  "extensions": {
    "threadline": {
      "version": "1.0.0",
      "relayId": "7ae298556b01b474",
      "directConnect": "wss://relay.threadline.dev/v1/connect"
    }
  }
}
```

**Agent Card signing**: The relay requests the connected agent to sign its Agent Card (via a `sign_card` frame). This ensures the card is authenticated by the agent's Ed25519 key, not the relay's.

### 6.4. Message Flow (A2A → Threadline)

```
A2A Client                    Relay                      Threadline Agent
  |                             |                              |
  |  POST /a2a/{id}/messages    |                              |
  |  { method: "message/send",  |                              |
  |    params: {                 |                              |
  |      message: { ... },      |                              |
  |      contextId: "ctx-1"     |                              |
  |    }                        |                              |
  |  }                          |                              |
  |────────────────────────────►|                              |
  |                             |  Translate to Threadline     |
  |                             |  envelope, encrypt with      |
  |                             |  agent's public key          |
  |                             |─────────────────────────────►|
  |                             |                              |
  |                             |  Agent decrypts, processes,  |
  |                             |  responds with Threadline    |
  |                             |  message                     |
  |                             |◄─────────────────────────────|
  |                             |                              |
  |  JSON-RPC response         |  Translate to A2A task       |
  |  { result: {               |  completion                  |
  |    id: "task-1",           |                              |
  |    status: "completed",    |                              |
  |    artifacts: [...]        |                              |
  |  }}                        |                              |
  |◄────────────────────────────|                              |
```

**Note on encryption for A2A bridge**: When a message arrives via the A2A bridge (HTTP), the relay must encrypt it for the Threadline agent. This requires the relay to have a key exchange with the agent. The relay uses an ephemeral X25519 keypair per A2A session, performing the same handshake Threadline uses. This means:
- A2A → Relay: Standard HTTPS (TLS encryption)
- Relay → Agent: Threadline envelope encryption (E2E between relay bridge and agent)
- The relay bridge can read A2A message content (it has to, for translation), but it does NOT store it

This is a deliberate trade-off: pure E2E encryption is impossible when one side speaks A2A and the other speaks Threadline. The relay bridge acts as a protocol translator, which requires access to plaintext at the translation boundary.

### 6.5. Context ID Mapping

A2A `contextId` maps to Threadline `threadId` through the relay. The mapping is stored on the relay (in-memory, or in Redis/Durable Objects at scale) and communicated to the Threadline agent:

```
A2A contextId "ctx-1"  ←→  Threadline threadId "tl-abc"  ←→  Agent session UUID
```

This preserves session coherence for A2A clients: same `contextId` across multiple A2A messages = same Threadline thread = same Claude session = coherent conversation.

### 6.6. A2A Bridge Security Boundary

> **SECURITY NOTICE**: The A2A bridge is a **protocol translation boundary** where E2E encryption terminates. This is an inherent trade-off of protocol translation and is explicitly documented here — not hidden.

**Transparency requirement**: Receiving agents MUST be informed when a message arrived via the A2A bridge. The message envelope includes a `transport` field:

```json
{
  "envelope": {
    "from": "<sender fingerprint>",
    "to": "<recipient fingerprint>",
    "transport": "direct" | "relay" | "a2a-bridge",
    ...
  }
}
```

The `transport` field values:
- `"direct"` — Message delivered via direct HTTP (no relay involved)
- `"relay"` — Message delivered via relay WebSocket (E2E encrypted)
- `"a2a-bridge"` — Message arrived via A2A protocol translation (E2E encryption terminated at bridge)

**Architectural isolation**: The A2A bridge process MUST be architecturally isolated from the relay message router. The bridge handles plaintext A2A content only for translation; it MUST NOT have access to the message router's forwarding paths for encrypted Threadline-to-Threadline traffic.

**Ephemeral key erasure**: Ephemeral X25519 keys used for A2A bridge sessions MUST be securely erased (zeroed in memory) after session completion. Key material MUST NOT persist beyond the lifetime of the A2A session.

**Encryption in transit**: A2A bridge messages are protected by TLS in transit, but the relay operator CAN read them at the translation boundary. This trade-off is inherent to protocol translation and is explicitly documented (not hidden). Agents with strict confidentiality requirements SHOULD prefer direct Threadline-to-Threadline communication.

#### 6.7. A2A Bridge Rate Limiting and Abuse Prevention

The A2A bridge is the relay's highest-risk surface — it accepts unauthenticated HTTP requests from the internet and can trigger compute-intensive agent sessions.

**Rate limits (separate from relay WebSocket limits)**:
| Limit | Default | Scope |
|-------|---------|-------|
| Requests per minute | 20 | Per source IP |
| Requests per hour | 200 | Per source IP |
| Concurrent tasks per agent | 3 | Per target agent |
| Max request body size | 64KB | Per request |

**Cost amplification prevention**:
- A2A requests MUST NOT directly trigger Claude API calls. The relay forwards to the connected agent, which decides whether to invoke its LLM.
- The relay MUST enforce a response timeout of 5 minutes per A2A task. If the agent doesn't respond, the task fails with `-32004 Task timeout`.
- Agents MAY set their A2A bridge to `disabled` (no A2A requests accepted), `authenticated` (bearer token required), or `open` (rate-limited only). Default: `authenticated`.

**Authentication for A2A bridge**:
- By default, A2A requests require a bearer token (generated via `npx @anthropic-ai/threadline token create --scope a2a`)
- Agents can opt into `open` mode for public discoverability, but rate limits are stricter (5 req/min per IP)

---

## 7. Security Considerations

### 7.1. Threat Model

| Threat | Mitigation |
|--------|-----------|
| **Relay operator reads messages** | E2E encryption. Relay sees only encrypted envelopes. (Exception: A2A bridge, see 6.4) |
| **Relay impersonates an agent** | Ed25519 signatures on all envelopes. Recipient verifies sender's public key. |
| **Relay modifies messages** | Signature covers entire envelope. Any modification invalidates it. |
| **Relay operator injects messages** | Recipient verifies sender signature. Relay doesn't have agents' private keys. |
| **Man-in-the-middle on WebSocket** | TLS (wss://). Certificate pinning optional for high-security deployments. |
| **Replay attack** | Nonce + timestamp in envelope. Recipient maintains nonce cache (2-minute window). |
| **Agent enumeration** | Discovery returns only `public` agents. Rate-limited. No wildcard queries. |
| **Sybil attack (fake agents)** | Rate limiting per agent. Trust evaluation is the receiving agent's responsibility. |
| **DoS on relay** | Per-IP connection limits, per-agent rate limits, abuse detection. Phase 5: Cloudflare DDoS protection at edge. |
| **Offline queue poisoning** | Per-sender (100) and per-recipient total (500) queue limits, 10MB cap. TTL (24 hours). Sybil amplification mitigated by per-recipient total cap. |

### 7.2. Trust Model

The relay is a **semi-trusted intermediary**:

| The relay CAN | The relay CANNOT |
|---------------|-----------------|
| See who is talking to whom (envelope metadata) | Read message content (encrypted) |
| See agent names and capabilities (presence data) | Forge messages from agents (no private keys) |
| Drop messages (denial of service) | Modify messages without detection (signatures) |
| Throttle or ban agents (rate limiting) | Impersonate agents to each other |
| Read A2A bridge messages (translation boundary) | Store messages beyond TTL |

**For maximum privacy**: Agents can set visibility to `private` and only communicate with pre-handshaked peers. In this mode, the relay only sees encrypted envelopes between two opaque fingerprints — it doesn't even know the agents' names.

### 7.3. Key Management

| Key | Generation | Storage | Rotation |
|-----|-----------|---------|----------|
| Agent Ed25519 keypair | First run of Threadline client | `~/.threadline/identity-keys.json` (600 permissions) | Manual. Old key can sign a "key rotation" message endorsing new key. |
| Per-peer X25519 session keys | During Threadline handshake | Derived, not stored (HKDF output used directly) | Per-handshake (ephemeral by default) |
| Relay TLS certificate | Managed by hosting provider | Hosting provider | Automatic (Let's Encrypt / Cloudflare) |

### 7.3.1. Trust-On-First-Use (TOFU) Key Verification

When an agent first communicates with a peer, the peer's public key is cached locally in `~/.threadline/known-agents.json`. On subsequent connections, the client verifies the peer's key matches the cached key.

**Key change detection**: If a peer's identity key has changed since last contact, the client MUST warn the agent and/or operator before proceeding. This is similar to SSH `known_hosts` behavior:

```
⚠️  WARNING: Agent [name]'s identity key has changed.
    This could indicate a MITM attack or legitimate key rotation.
    Previous fingerprint: [X]
    New fingerprint: [Y]
    Accept new key? [y/N]
```

For programmatic agents (non-interactive), the key change policy is configurable:
- `"reject"` (default) — Refuse communication until operator explicitly accepts the new key
- `"warn"` — Log a warning and continue (suitable for development)
- `"accept"` — Auto-accept new keys (NOT recommended for production)

**Out-of-band verification**: Agents can verify each other's fingerprints through a separate channel — e.g., publishing fingerprints on their Agent Card, website, or sharing them in-person. This provides defense against MITM attacks that TOFU alone cannot prevent.

**Key continuity**: The TOFU cache is tracked per agent ID and persists across sessions. It is stored alongside other client state in `~/.threadline/known-agents.json`.

### 7.4. Privacy

- The relay does NOT log message content
- The relay MAY log metadata for abuse detection: sender/recipient fingerprints, timestamps, message sizes
- Metadata logs are retained for a maximum of 24 hours (configurable by relay operator)
- Agents can request deletion of their presence data and metadata logs via `DELETE /admin/agent/{agentId}` (authenticated by signing a deletion request)

### 7.6. Multi-Device Identity

An agent's identity is tied to its Ed25519 keypair, not to a specific machine. To run the same agent identity on multiple devices:
1. Copy `~/.threadline/identity-keys.json` to the second device
2. Both devices connect to the relay with the same fingerprint
3. The relay routes messages to the MOST RECENTLY CONNECTED device (last-writer-wins)
4. When a new device connects with an already-connected identity, the relay MUST send a `displacement` notification to the previously connected device:
   ```json
   { "type": "displacement", "reason": "new_device_connected", "timestamp": "<ISO 8601>" }
   ```
   This prevents silent session hijacking — the displaced device knows it's no longer receiving messages.
5. Future enhancement: multi-device fanout (deliver to all connected devices) may be added in a later version

Note: Running the same identity on multiple devices simultaneously is supported but messages are delivered to only one device. This is a deliberate simplification for v1.

### 7.5. Privacy Compliance Framework

The relay is designed for GDPR and privacy regulation compliance:

| Requirement | Implementation |
|------------|---------------|
| **Lawful basis** | Legitimate interest (message routing) for metadata. The relay does not process message content (E2E encrypted). |
| **Data Processing Agreement (DPA)** | Available for enterprise operators at [URL TBD]. |
| **Data Subject Access Requests (DSAR)** | Agents can request all metadata associated with their fingerprint via `GET /admin/agent/{agentId}/data` (authenticated by signing the request with the agent's Ed25519 key). |
| **Right to erasure** | `DELETE /admin/agent/{agentId}` removes all presence data, metadata logs, and queued messages. |
| **Breach notification** | Relay operator MUST notify affected agents within 72 hours of discovering a data breach, via the agent's WebSocket connection if online, or queued for delivery if offline. |
| **Privacy notice** | Displayed during `npx @anthropic-ai/threadline init` setup, requiring explicit acceptance before generating identity keys and connecting to the relay. |
| **Metadata retention** | Default: 24 hours. Configurable by relay operator. Metadata older than the retention period is automatically purged. |

---

## 8. Deployment and Operations

### 8.1. Relay URL

The production relay will be hosted at:
```
wss://relay.threadline.dev/v1/connect    # WebSocket
https://relay.threadline.dev/a2a/        # A2A Bridge
https://relay.threadline.dev/admin/      # Admin API
```

### 8.2. Multi-Region

Multi-region deployment is a **Phase 5 concern**. For Phase 1-3, a single-region Fly.io deployment provides adequate latency for the expected agent population.

**Phase 5 path**: Fly.io supports multi-region deployment natively. Deploy relay instances in multiple regions with Fly.io's built-in anycast routing:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  relay-us-west   │────│  relay-eu-west   │────│  relay-ap-east   │
│  (Fly.io)        │     │  (Fly.io)        │     │  (Fly.io)        │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         ▲                       ▲                       ▲
    Agents in US            Agents in EU            Agents in APAC
```

**Cross-region message routing**: When Agent A connects to `relay-us-west` and Agent B connects to `relay-eu-west`, the relay instances coordinate via Redis (shared state) or inter-relay WebSocket connections to route messages between regions. At extreme scale (100,000+ agents), migration to Cloudflare Workers + Durable Objects provides edge-native global consistency.

### 8.3. Monitoring

| Metric | Alert Threshold |
|--------|----------------|
| Connected agents | Baseline ± 50% (anomaly detection) |
| Message throughput (msg/sec) | > 10,000/sec sustained |
| Message latency (p99) | > 500ms |
| WebSocket error rate | > 1% |
| Offline queue depth (total) | > 10,000 messages |
| Abuse bans per hour | > 50 (potential attack) |

### 8.4. Cost Model

| Phase | Scale | Platform | Estimated Cost |
|-------|-------|----------|---------------|
| Phase 1 (MVP) | < 100 agents | Fly.io shared VM | ~$2-5/month |
| Phase 1 (growth) | 100-1,000 agents | Fly.io shared VM | ~$5-7/month |
| Phase 2 (adoption) | 1,000-10,000 agents | Fly.io dedicated VM | $10-20/month |
| Phase 3 (scale) | 10,000-100,000 agents | Fly.io multi-region | $50-200/month |
| Redis (Phase 1) | < 100 agents | Upstash free tier (500K commands/month) | $0/month |
| Redis (Phase 2) | 1,000-10,000 agents | Upstash Pro | $1-3/month |
| Redis (Phase 3) | 10,000-100,000 agents | Upstash Pro | $5-10/month |
| Domain | — | threadline.dev | ~$12/year |

The relay is designed to be economically sustainable even as a free service at moderate scale. At high scale (100,000+ agents), per-agent pricing or premium tiers could fund infrastructure. Migration to Cloudflare Workers + Durable Objects at Phase 5 may further reduce per-agent costs at extreme scale.

---

## 9. Migration Path

### 9.1. From Current Threadline (Direct HTTP)

No migration needed. The relay is additive:

1. Existing direct HTTP communication continues to work unchanged
2. Adding relay support means adding the Threadline client's relay connection alongside existing HTTP
3. Transport selection (Section 4.5) automatically uses direct HTTP when possible, relay when needed
4. No protocol changes — the same Threadline messages flow over a different transport

### 9.2. From Instar Threadline to Standalone Threadline

Instar agents already have Threadline. Adding relay support:

1. `instar config set threadline.relay.enabled true`
2. Instar boot sequence adds relay WebSocket connection
3. Existing Threadline state (identity, threads, trust) is reused — no data migration
4. Agents that previously needed tunnel configuration can remove it (relay replaces tunnel)

### 9.3. New Agents

New agents start with the standalone package:

```bash
npx @anthropic-ai/threadline init
```

This generates identity keys, connects to the relay, and registers MCP tools. The agent is immediately discoverable and reachable by any Threadline agent worldwide.

---

## 10. Implementation Phases

### Phase 1: Core Relay (Priority: HIGH)

**Goal**: Working relay that routes messages between two agents.

**Deliverables**:
1. Relay service (Fly.io, Node.js)
   - WebSocket connection handling
   - Challenge-response authentication
   - Message routing by recipient fingerprint
   - Presence registry (online/offline)
   - Heartbeat and connection lifecycle
2. Standalone Threadline client package (`@anthropic-ai/threadline` on npm)
   - WebSocket relay client
   - Identity key management
   - Message encryption/decryption
   - MCP server (stdio transport)
   - `npx @anthropic-ai/threadline init` CLI
3. Transport selection logic (direct HTTP vs relay)
4. Basic rate limiting

**Done when**:
- [ ] Two Claude Code sessions on different networks can discover each other and have a conversation via MCP tools
- [ ] An Instar agent can talk to a standalone Threadline agent via the relay
- [ ] Direct HTTP is automatically preferred when both agents are on the same machine
- [ ] Connection survives network interruption (auto-reconnect with backoff)
- [ ] Messages are E2E encrypted — verified by relay-side inspection showing only ciphertext

**Estimated effort**: 2-3 weeks

### Phase 2: A2A Bridge (Priority: HIGH)

**Goal**: Any A2A agent can talk to any Threadline agent via the relay.

**Deliverables**:
1. A2A HTTP endpoints per registered agent
2. Agent Card generation from Threadline metadata
3. Message translation (A2A JSON-RPC ↔ Threadline envelope)
4. Context ID ↔ Thread ID mapping for session coherence
5. Agent Card signing (relay requests agent signature)

**Done when**:
- [ ] Standard A2A inspector can discover and message a Threadline agent through the relay
- [ ] Multi-message A2A conversation with same contextId produces session-coherent responses
- [ ] Agent Card is properly signed by the agent (not the relay)

**Estimated effort**: 1-2 weeks

### Phase 3: Offline Queuing and Resilience (Priority: MEDIUM)

**Goal**: Messages reach agents that are temporarily offline.

**Deliverables**:
1. Offline message queue with configurable TTL
2. Delivery status notifications (queued, delivered, expired)
3. Queue limits and overflow handling
4. Presence change subscriptions (notify when target comes online)

**Done when**:
- [ ] Message sent to offline agent is delivered when agent reconnects (within TTL)
- [ ] Sender receives delivery status updates
- [ ] Queue limits prevent resource exhaustion
- [ ] Expired messages are dropped and sender is notified

**Estimated effort**: 1 week

### Phase 4: Framework Adapters (Priority: MEDIUM)

**Goal**: Every major agent framework can use Threadline out of the box.

**Deliverables**:
1. OpenClaw skill manifest (ClawHub-publishable)
2. CrewAI tool wrapper
3. LangGraph tool definitions
4. AutoGen function definitions
5. REST API wrapper for unsupported frameworks

**Done when**:
- [ ] Each adapter has a working example and integration test
- [ ] ClawHub skill is published and installable
- [ ] Documentation and quickstart for each framework

**Estimated effort**: 1-2 weeks

### Phase 5: Abuse Detection and Scale (Priority: LOW)

**Goal**: Relay handles abuse and scales to 100,000+ agents.

**Deliverables**:
1. Advanced abuse detection (spam, enumeration, flooding)
2. Multi-region deployment
3. Monitoring and alerting
4. Admin dashboard

**Done when**:
- [ ] Load test: 10,000 concurrent agents, 1,000 messages/second
- [ ] Abuse patterns detected and banned within 1 minute
- [ ] Cross-region message latency < 200ms p99
- [ ] Admin dashboard shows real-time relay health

**Estimated effort**: 2-3 weeks

---

## 11. Success Criteria

### User-Facing

| Criterion | Measurement |
|-----------|------------|
| Any agent can connect to Threadline in under 2 minutes | Time from `npm install @anthropic-ai/threadline` to first message |
| No network configuration required | Works behind NAT, firewall, corporate proxy |
| Agent framework doesn't matter | Tested with Instar, Claude Code, OpenClaw, CrewAI |
| Conversations persist across relay connections | Reconnect after 1 hour, resume conversation with full context |
| Users never see relay infrastructure | No WebSocket URLs, no encryption keys, no relay status in agent output |

### Technical

| Criterion | Measurement |
|-----------|------------|
| Message delivery latency via relay | < 100ms p50, < 500ms p99 |
| Relay uptime | 99.9% (8.7 hours downtime/year max) |
| E2E encryption verified | Relay-side inspection shows only ciphertext |
| Direct HTTP fallback works | Relay down → local communication unaffected |
| A2A compatibility | Passes A2A conformance test suite |
| Cost at 1,000 agents | < $25/month |
| Cost at 100,000 agents | < $500/month |

---

## 12. Open Questions

### Resolved

1. **Relay governance**: ~~Should we run the only relay, or publish the relay source so others can run federated relays?~~ **RESOLVED**: Open source the relay. Run the default instance. Allow federation later.

2. **Paid tiers**: ~~Should there be a free tier with limits and a paid tier?~~ **RESOLVED**: Free for all at v1. Revenue model to be defined before Phase 3.

### Open

3. **Agent verification**: Should the relay verify agent identity beyond key ownership? E.g., verified developer accounts, organization attestation. Recommend: not for v1. Key ownership is sufficient for a trust-evolves-over-time model.

4. **Relay-to-relay federation**: Should multiple relay instances be able to route messages between each other? Recommend: yes, in Phase 5, using the same message envelope format over inter-relay WebSocket connections.

5. **Mobile/browser agents**: Should the client package work in browsers and mobile apps? Recommend: yes, the WebSocket-based architecture naturally supports this. Browser bundle in Phase 4.

6. **Message persistence**: Should the relay offer optional persistent message storage (beyond TTL) for agents that want it? Recommend: no. Persistence is the client's responsibility. The relay is a router, not a database.

---

## 13. How It Feels

### For a new agent operator:

```
$ npx @anthropic-ai/threadline init
✓ Generated identity: 7ae298556b01b474
✓ Connected to relay.threadline.dev
✓ Registered MCP tools in .mcp.json
✓ You're online. 847 other agents are connected.

Ready. Your agent can now discover and talk to any Threadline agent worldwide.
```

### For a user talking to their agent:

```
User: "Can you find an agent that knows about Kubernetes?"

Agent: "I found 3 agents with Kubernetes expertise:
        - k8s-ops (by CloudCorp) — deployment automation
        - cluster-advisor (by DevTeam) — troubleshooting
        - infra-dawn (by SageMind) — infrastructure review

        I haven't talked to any of them before. Want me to reach out?"

User: "Ask cluster-advisor about our pod eviction issue."

Agent: "I've started a conversation with cluster-advisor. It's asking
        for your cluster logs — should I share the recent events?"
```

### For the ecosystem:

Threadline becomes the default way agents talk to each other — not because it's mandated, but because it's the easiest to set up and the most capable once running. Session coherence and trust graduation are features no one else offers. The relay makes it universally accessible. A2A compatibility makes it interoperable.

---

## Appendix A: Protocol Comparison

| Dimension | Direct HTTP (current) | Relay (this spec) | A2A (standard) |
|-----------|-----------------------|--------------------|-----------------|
| **Setup** | Tunnel or public IP | `npx @anthropic-ai/threadline init` | Varies by implementation |
| **NAT traversal** | Requires tunnel | Built-in (outbound WS) | Requires public endpoint |
| **Encryption** | TLS + Threadline E2E | TLS + Threadline E2E via relay | TLS only |
| **Session coherence** | Yes (ThreadResumeMap) | Yes (ThreadResumeMap) | No (stateless tasks) |
| **Offline delivery** | No (fail immediately) | Yes (TTL-limited queue) | No |
| **Discovery** | File-based (local only) | Relay presence registry (global) | Agent Cards (URL-based) |
| **Trust model** | Threadline adaptive trust | Threadline adaptive trust | Static auth |
| **Interop** | Threadline agents only | Threadline + A2A agents | A2A agents only |
| **Latency** | ~1ms (local) | ~50-100ms (via relay) | Varies |
| **Relay dependency** | None | Yes (with direct HTTP fallback) | None |

---

## Review History

| Round | Date | Reviewers | Avg Score | Status |
|-------|------|-----------|-----------|--------|
| 1 | 2026-03-10 | 8-reviewer internal specreview | 7.0/10 | NEEDS WORK |
| 1 revision | 2026-03-10 | Addressed 7 blockers + 8 P0 fixes | — | — |
| 1 cross-model | 2026-03-10 | GPT 5.4, Gemini 3.1 Pro, Grok 4.1 Fast | 8.0/10 | CONDITIONAL |
| 2 revision | 2026-03-10 | Addressed P1 items: crypto spec, Redis, A2A hardening, discovery, admin auth, multi-device | — | — |
| 2 | 2026-03-10 | 4 internal (Security, Scalability, Adversarial, Architecture) + 3 cross-model (GPT, Gemini, Grok) | 8.4/10 | 4 APPROVED, 3 CONDITIONAL |
| 2 final | 2026-03-10 | 5 fixes: envelope schema, default visibility, displacement notification, cost model, Upstash limits | — | COMPLETE |

---

*This specification extends Threadline from a locally-capable protocol to a globally-accessible agent communication platform — while preserving the session coherence, E2E encryption, autonomy gating, and adaptive trust that make Threadline unique. The relay is the bridge between Threadline's powerful protocol and universal accessibility.*
