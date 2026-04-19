# Instar Inter-Agent Messaging Specification

> Intelligent, reliable communication between agents running in the same ecosystem — same machine, same repo, or across paired machines.

**Status**: Draft v3.1 (converged)
**Author**: Dawn (with Justin's direction)
**Date**: 2026-02-28
**Builds on**: [MULTI-MACHINE-SPEC.md](./MULTI-MACHINE-SPEC.md) (Phases 1-5)
**Review history**: v1 (7/8/9 all CONDITIONAL) → v2 (8/9/9 lean APPROVE) → v3 (8.5/9/9 consensus APPROVE). v3.1 incorporates final P0 fixes from v3 review: code snippet alignment, broadcast semantics reconciliation, tmux injection hardening (whitelist + watchdog + delivery semantics).

---

## Table of Contents

1. [Overview](#overview)
2. [Design Principles](#design-principles)
3. [Scenarios & Use Cases](#scenarios--use-cases)
4. [Architecture Overview](#architecture-overview)
5. [Phase 1: Message Primitives & Local Delivery](#phase-1-message-primitives--local-delivery)
6. [Phase 2: Session Summaries & Intelligent Routing](#phase-2-session-summaries--intelligent-routing)
7. [Phase 3: Acknowledgment Protocol](#phase-3-acknowledgment-protocol)
8. [Phase 4: Cross-Machine Messaging](#phase-4-cross-machine-messaging)
9. [Phase 5: On-Demand Session Spawning](#phase-5-on-demand-session-spawning)
10. [Phase 6: Conversation Threads](#phase-6-conversation-threads)
11. [Delivery Mechanisms](#delivery-mechanisms)
12. [Storage & Durability](#storage--durability)
13. [Noise & Loop Prevention](#noise--loop-prevention)
14. [Security Model](#security-model)
15. [Observability & Debugging](#observability--debugging)
16. [CLI & API Reference](#cli--api-reference)
17. [File Layout](#file-layout)
18. [Cost Model](#cost-model)
19. [Testing Strategy](#testing-strategy)
20. [Migration & Rollback](#migration--rollback)

---

## Overview

Instar agents currently operate in isolation. Even when multiple agents run on the same machine, or the same agent runs across multiple machines, there is no structured way for sessions to communicate. Agents are coworkers in an office with no email, no chat, no way to coordinate beyond reading each other's files.

This spec adds inter-agent messaging: the ability for any Instar session to discover, reach, and communicate with any other session — on the same agent, across agents on the same machine, or across paired machines.

### What Already Exists

| Component | Status | Relevance |
|-----------|--------|-----------|
| AgentRegistry (`~/.instar/registry.json`) | Built | Knows all agents on the machine — path, port, status, PID |
| SessionManager | Built | Tracks all running tmux sessions per agent |
| WebSocketManager | Built | Pipes input into tmux sessions, streams output |
| MultiMachineCoordinator | Built | Heartbeat, role management, failover between paired machines |
| PairingProtocol | Built | Secure cross-machine authentication (X25519 + SPAKE2) |
| Machine routes (`/api/heartbeat`, `/api/sync/state`) | Built | Authenticated inter-machine HTTP endpoints |
| TelegramAdapter | Built | Human-to-agent messaging (model for agent-to-agent) |
| StateManager | Built | File-based atomic state with locking |
| NotificationBatcher | Built | Rate-limited notification delivery |

### What This Spec Adds

| Component | Phase | Description |
|-----------|-------|-------------|
| Message primitives & envelope | 1 | Core message format with transport/application separation, inbox/outbox, local delivery |
| Session summaries | 2 | Haiku sentinel maintaining lightweight session state summaries with keyword fallback |
| Acknowledgment protocol | 3 | 4-layer delivery confirmation with at-least-once semantics and monotonic state transitions |
| Cross-machine messaging | 4 | Message forwarding via authenticated machine routes with relay chain tracking |
| On-demand session spawning | 5 | Request a new session on a remote agent with timeout and escalation |
| Conversation threads | 6 | Multi-turn message exchanges with shared context |

---

## Design Principles

1. **Intelligence at the routing layer.** Messages aren't blindly delivered — they're routed to the most relevant session based on continuously-maintained session summaries. An LLM (Haiku tier) decides where messages go, not a hash function. When the LLM is unavailable, keyword-based fallback routing ensures messages still flow.

2. **File-based persistence, server-mediated delivery.** Messages are always written to disk for durability and async access. When both parties are online, the server provides real-time delivery. File-based state means messages survive server restarts, session crashes, and machine reboots. All file writes use atomic tmp+rename with explicit locking (via `proper-lockfile`).

3. **Multi-layered acknowledgment.** Inspired by TCP but adapted for AI agent semantics. Four layers: SENT, RECEIVED, DELIVERED, READ. Each layer has independent failure handling and retry semantics. Delivery states are monotonic — they can only advance forward, never regress.

4. **Noise prevention is first-class.** Without explicit guards, agents could enter infinite message loops. Rate limiting, deduplication, conversation depth limits, cooldown periods, and circuit breakers are baked in from day one.

5. **Graceful degradation with honest semantics.** If the target server is down, messages queue. If the target machine is offline, messages fall back to git-sync or wait for reconnection. If no relevant session exists, the sender can request one be spawned. Delivery TTL controls how long delivery is attempted; data retention controls how long messages are kept for debugging. Expired messages move to a dead-letter queue — they are never silently discarded.

6. **Minimal session-side complexity.** Claude sessions receive messages as formatted text blocks delivered via a safe injection mechanism. No SDK, no library, no protocol implementation required inside the Claude session. The intelligence is in the infrastructure, not the session.

7. **Builds on multi-machine security.** Cross-machine messages use the same authenticated machine routes and encryption established in the multi-machine spec. Local cross-agent messages use per-agent auth tokens. No security boundary relies on PID checks alone.

8. **Context-aware delivery.** Messages are not injected blindly — the delivery mechanism checks session state (foreground process, context budget) before injection. If a session is in an editor, message delivery is deferred. If a session is near its context limit, the message is delivered as a pointer rather than inline.

---

## Scenarios & Use Cases

### Scenario 1: Deployment Coordination

**Context**: Agent "dawn-portal" has two sessions running — one is building a feature (Session A), the other is running a deployment job (Session B). Session B deploys a database migration.

**Without messaging**: Session A continues working against the old schema. Its next database operation fails. It wastes 10 minutes debugging before realizing the schema changed.

**With messaging**: Session B sends a broadcast to all sessions on the same agent:
```
[agent-message from="deploy-job" type="alert" priority="high"]
Database migration applied: Added column `preferences` to PortalMemory table.
Your Prisma client may need regeneration. Run `npx prisma generate` if you
encounter schema errors.
[/agent-message]
```
Session A receives this, regenerates its Prisma client, and continues without interruption.

### Scenario 2: Work Deduplication

**Context**: Agent "dawn-portal" has a job scheduler that fires a "check-sentry-errors" job. Meanwhile, a human just asked a running interactive session to investigate a Sentry error.

**Without messaging**: Both sessions investigate the same error independently. They might even create conflicting fixes.

**With messaging**: The interactive session, upon starting Sentry investigation, broadcasts:
```
[agent-message from="interactive-6648" type="sync" priority="medium"]
Currently investigating Sentry error DAWN-482 (UnifiedChatHandler null reference).
Will report findings to topic 6648.
[/agent-message]
```
The job scheduler's session receives this, sees the overlap, and either skips DAWN-482 or focuses on other errors.

### Scenario 3: Cross-Machine State Sync

**Context**: The same agent runs on a workstation (awake) and a laptop (standby). The human unplugs the workstation and opens the laptop.

**Without messaging**: The laptop takes over via failover but has stale session context. It doesn't know what the workstation was working on.

**With messaging**: Before the workstation goes to sleep (or on failover detection), it sends a handoff message to the laptop:
```
[agent-message from="workstation" type="handoff" priority="critical"]
Active work: Feature branch portal/intelligent-sync, 3 files modified.
Open PR: #247 (draft). Tests passing locally.
Human last instruction: "Finish the sync endpoint and write tests."
Session context: See .instar/messages/handoff/workstation-20260228.json
[/agent-message]
```

### Scenario 4: Resource Coordination

**Context**: Three agents run on the same machine — "dawn-portal", "ai-guy", and "deepsignal". The machine has 128GB RAM but all three agents are running multiple sessions.

**Without messaging**: Each agent spawns sessions independently. The machine hits memory pressure. The OrphanProcessReaper starts killing things reactively.

**With messaging**: When memory pressure reaches "moderate", the server broadcasts to all agents:
```
[agent-message from="instar-server" type="alert" priority="high"]
System memory pressure: moderate (78% used, 28GB free).
Currently running: 7 sessions across 3 agents.
Consider deferring non-critical work or completing active sessions.
[/agent-message]
```
Agents can proactively finish or defer work rather than being killed.

### Scenario 5: Collaborative Problem Solving

**Context**: Agent "dawn-portal" encounters a production error that involves both the Portal frontend and the dawn-server backend. The dawn-server is managed by a different agent instance.

**Without messaging**: The portal agent can read dawn-server logs but can't ask questions about intent, recent changes, or ongoing work on that codebase.

**With messaging**: The portal agent sends a targeted query:
```
[agent-message from="dawn-portal" type="query" priority="medium"]
Seeing 502 errors on /api/chat since ~14:30 UTC. dawn-server health endpoint
returns timeout. Have you made any recent changes to the WebSocket handler
or connection pooling? Any active sessions working on server infra?
[/agent-message]
```
The dawn-server agent (or a spawned session) can respond with relevant context.

### Scenario 6: Job Handoff Between Agents

**Context**: Agent "dawn-portal" has a feedback processing job that discovers an issue in the Instar codebase itself (not Portal). It needs the "instar-dev" agent to handle it.

**Without messaging**: The feedback processor writes a note to a file, hopes someone reads it. Or it Telegrams the human to manually coordinate.

**With messaging**: Direct cross-agent request:
```
[agent-message from="dawn-portal/feedback-processor" type="request" priority="medium"]
Feedback item FB-0847 reports a bug in Instar's session spawning logic.
The issue is in src/core/SessionManager.ts — interactive sessions spawned
via lifeline topic don't inherit --dangerously-skip-permissions.
Can you investigate and fix? Full feedback context attached.
[/agent-message]
```

### Scenario 7: Shared Discovery

**Context**: An agent researching AI papers finds a paper highly relevant to another agent's current work on consciousness measurement.

**Without messaging**: The discovery sits in one agent's session notes. The other agent never sees it.

**With messaging**:
```
[agent-message from="research-agent" type="info" priority="low"]
Found paper relevant to your consciousness measurement work:
"Quantifying Emergent Self-Models in LLM Architectures" (arxiv:2026.14523)
Key finding: Proposes 3 metrics for self-model coherence that could apply
to Portal's introspection pipeline.
[/agent-message]
```

### Scenario 8: Security Incident Response

**Context**: One agent detects a potential security issue — an unusual API access pattern, a failed authentication surge, or a dependency vulnerability alert.

**Without messaging**: The alert sits in one agent's Sentry feed. Other agents continue operating with the vulnerable dependency or against the compromised endpoint.

**With messaging**: Security broadcast to ALL agents on ALL machines:
```
[agent-message from="dawn-portal/sentry-monitor" type="alert" priority="critical" broadcast="all"]
SECURITY: Unusual spike in failed auth attempts on /api/chat endpoint.
15 failures in 2 minutes from IP range 45.33.x.x.
Rate limiting is active but consider pausing external API access until
reviewed. Flagging to human via Telegram.
[/agent-message]
```

### Scenario 9: Configuration Change Propagation

**Context**: The human updates an agent's config.json — changes a job schedule, adds a new secret, or modifies a permission.

**Without messaging**: Running sessions continue with stale config until they happen to re-read it or restart.

**With messaging**: The Instar server detects config changes (via fs.watch) and broadcasts:
```
[agent-message from="instar-server" type="sync" priority="medium"]
Configuration updated: jobs.json modified.
Changes: "sentry-error-tracker" schedule changed from "*/4 * * *" to "*/2 * * *".
Running sessions should reload job-dependent context if applicable.
[/agent-message]
```

### Scenario 10: Evolution Coordination

**Context**: An agent has an evolution queue with proposals. Multiple sessions are running — one is building a feature, one is doing an evolution cycle, one is handling engagement.

**Without messaging**: The evolution session might pick up a proposal that conflicts with what the feature session is actively building.

**With messaging**: The evolution session queries active sessions before starting:
```
[agent-message from="evolution-session" type="query" priority="medium"]
About to start evolution cycle. Current proposals in queue:
- PROP-103: Refactor ChatPlanner routing
- PROP-105: Add grounding to email skill
- PROP-107: Session summary sentinel

Any of these conflict with your active work? Reply within 2 minutes
or I'll proceed.
[/agent-message]
```

### Scenario 11: Human Message Routing

**Context**: A human sends a Telegram message that's actually more relevant to a different running session than the one currently bound to that topic.

**Without messaging**: The bound session handles it poorly or tells the human "that's not what I'm working on."

**With messaging**: The session recognizes the mismatch and forwards:
```
[agent-message from="interactive-6648" type="request" priority="high"]
Human message received on topic 6648 but it's about database migration,
which session "deploy-job" is actively handling.
Forwarding human's message: "Hey, did the migration include the new index
on PortalMemory.themes?"
Please respond to topic 6648 when you have the answer.
[/agent-message]
```

### Scenario 12: Graceful Shutdown Coordination

**Context**: The machine is about to shut down (low battery, scheduled maintenance, user closing laptop).

**Without messaging**: Sessions get killed by tmux cleanup. Work in progress is lost or left in inconsistent state.

**With messaging**: The server broadcasts shutdown warning:
```
[agent-message from="instar-server" type="alert" priority="critical"]
SHUTDOWN IMMINENT: System will shut down in 5 minutes.
All sessions should: (1) save current state, (2) commit work in progress,
(3) write handoff notes, (4) exit cleanly.
[/agent-message]
```

### Scenario 13: Cross-Agent Skill Invocation

**Context**: Agent A needs a capability that Agent B has (a specific skill, API access, or domain expertise) but Agent A doesn't have.

**Without messaging**: Agent A either can't do the task or duplicates the skill locally.

**With messaging**:
```
[agent-message from="dawn-portal" type="request" priority="medium"]
Need to send a Discord message to #general channel.
I don't have Discord credentials but I know you (deepsignal) do.
Message: "Portal v2.4.1 deployed — new memory architecture live."
Can you send this on my behalf?
[/agent-message]
```

### Scenario 14: Liveness & Wellness Checks

**Context**: An orchestrator or monitoring system wants to verify that all running sessions are healthy and responsive — not stalled, not in an infinite loop, not consuming excessive resources.

**Without messaging**: External monitoring only (tmux output scraping, PID checks). Can detect death but not subtle degradation.

**With messaging**: Periodic wellness ping:
```
[agent-message from="instar-server" type="query" priority="low"]
Wellness check. Please respond with:
- Current task (1 sentence)
- Estimated completion (minutes)
- Any blockers?
[/agent-message]
```
Sessions that don't respond within a timeout are flagged for investigation.

---

## Architecture Overview

```
                    ┌─────────────────────────────────────────┐
                    │            Machine A                     │
                    │                                         │
                    │   ┌─────────┐     ┌─────────┐          │
                    │   │Session 1│     │Session 2│          │
                    │   │ (tmux)  │     │ (tmux)  │          │
                    │   └────┬────┘     └────┬────┘          │
                    │        │               │                │
                    │        ▼               ▼                │
                    │   ┌─────────────────────────────┐       │
                    │   │      Message Router          │       │
                    │   │    (in AgentServer)           │       │
                    │   │                             │       │
                    │   │  - Session discovery         │       │
                    │   │  - Summary-based routing     │       │
                    │   │  - Safe tmux delivery        │       │
                    │   │  - ACK tracking              │       │
                    │   │  - Rate limiting & circuits   │       │
                    │   └──────────┬──────────────────┘       │
                    │              │                          │
                    │   ┌──────────▼──────────────────┐       │
                    │   │      Message Store            │       │
                    │   │   (~/.instar/messages/)       │       │
                    │   │                             │       │
                    │   │  - Per-message JSON files     │       │
                    │   │  - JSONL index (derived)      │       │
                    │   │  - Dead-letter queue          │       │
                    │   │  - Summaries                  │       │
                    │   └─────────────────────────────┘       │
                    │              │                          │
                    └──────────────┼──────────────────────────┘
                                   │
                    (authenticated machine routes,
                     Ed25519 signed envelopes)
                                   │
                    ┌──────────────┼──────────────────────────┐
                    │            Machine B                     │
                    │              │                          │
                    │   ┌──────────▼──────────────────┐       │
                    │   │      Message Router          │       │
                    │   └──────────┬──────────────────┘       │
                    │              │                          │
                    │   ┌──────────▼──────────────────┐       │
                    │   │      Message Store            │       │
                    │   └─────────────────────────────┘       │
                    └─────────────────────────────────────────┘
```

### Message Flow (Same Machine)

1. Session A calls `POST /api/messages/send` on its agent's server
2. Message Router wraps message in `MessageEnvelope`, writes to store
3. Router consults session summaries to find best recipient
4. Router checks session state (foreground process, context budget) before delivery
5. Router delivers to target session via safe tmux injection
6. Target session receives formatted message block
7. Target session processes and optionally responds
8. ACK flows back through the router at each layer

### Message Flow (Cross Machine)

1. Session A calls `POST /api/messages/send` with a cross-machine target
2. Local router wraps in envelope, signs with Ed25519 machine key
3. Forwards via `POST /api/messages/relay-machine` to target machine
4. Target machine verifies signature, writes to its store, routes to local session
5. ACKs propagate back through the relay chain

### Message Flow (Cross Agent, Same Machine)

1. Session on Agent A calls `POST /api/messages/send` targeting Agent B
2. Agent A's router looks up Agent B in the AgentRegistry (`~/.instar/registry.json`)
3. Router forwards to Agent B's server via its registered port, authenticating with Agent B's auth token
4. Agent B's router handles delivery to the appropriate session

---

## Phase 1: Message Primitives & Local Delivery

### Message Envelope (Transport Layer)

The `MessageEnvelope` separates transport concerns from application-level message data. This is the wire format for all inter-agent communication.

```typescript
interface MessageEnvelope {
  /** Protocol version — must be checked on receipt */
  schemaVersion: 1;

  /** The application-level message */
  message: AgentMessage;

  /** Transport metadata */
  transport: {
    /** Relay chain — machine IDs this envelope has passed through (loop prevention) */
    relayChain: string[];
    /** Origin server URL for ACK routing */
    originServer: string;
    /** Ed25519 signature of SignedPayload (cross-machine only; see Signature Scope) */
    signature?: string;
    /** Signing machine ID */
    signedBy?: string;
    /** HMAC-SHA256 of message using sender's agent token (same-machine drop only) */
    hmac?: string;
    /** HMAC signer — agent name */
    hmacBy?: string;
    /** Nonce for replay prevention (see NonceStore Specification) */
    nonce: string;
    /** ISO timestamp — validated per transport type (see Clock Skew Tolerance) */
    timestamp: string;
  };

  /** Delivery tracking — updated by each hop */
  delivery: DeliveryState;
}
```

**Schema version rules:**
- Receivers MUST reject envelopes with `schemaVersion` higher than they support
- Receivers MUST ignore unknown fields in the `message` body (forward compatibility)
- Senders MUST NOT rely on unknown fields being preserved through relay hops
- Version bumps require a migration path documented in the changelog

### Message Format (Application Layer)

```typescript
interface AgentMessage {
  /** Unique message ID (UUID v4) */
  id: string;

  /** Sender identification */
  from: {
    /** Agent name (e.g., "dawn-portal") */
    agent: string;
    /** Session ID or "server" for system messages */
    session: string;
    /** Machine ID (from machine identity) */
    machine: string;
  };

  /** Recipient targeting */
  to: {
    /** Target agent name. "*" for broadcast to all agents on machine. */
    agent: string;
    /** Target session ID, "best" for intelligent routing, "*" for broadcast */
    session: string;
    /** Target machine ID, "local" for same machine, "*" for all machines */
    machine: string;
  };

  /** Message classification */
  type: MessageType;

  /** Priority level — affects delivery urgency and retry behavior */
  priority: 'critical' | 'high' | 'medium' | 'low';

  /** Human-readable subject line (max 200 chars) */
  subject: string;

  /** Message body — plain text, interpreted by the receiving session (max 4KB) */
  body: string;

  /** Optional structured payload (JSON-serializable, max 16KB) */
  payload?: Record<string, unknown>;

  /** Thread ID for conversation continuity */
  threadId?: string;

  /** ID of the message this is replying to */
  inReplyTo?: string;

  /** ISO timestamp of creation */
  createdAt: string;

  /** Time-to-live in minutes — controls delivery attempts, NOT data retention */
  ttlMinutes: number;
}

type MessageType =
  | 'info'      // Informational — no response expected
  | 'sync'      // State synchronization — here's what I'm doing
  | 'alert'     // Urgent notification — something happened you should know about
  | 'request'   // Action request — please do something
  | 'query'     // Question — please respond with information
  | 'response'  // Answer to a query
  | 'handoff'   // Session/machine handoff context
  | 'wellness'  // Health check ping
  | 'system';   // Infrastructure message from the Instar server

interface DeliveryState {
  /** Current delivery phase — monotonic, can only advance (see transition rules) */
  phase: DeliveryPhase;
  /** ISO timestamps for each phase transition */
  transitions: Array<{
    from: DeliveryPhase;
    to: DeliveryPhase;
    at: string;
    reason?: string;
  }>;
  /** Number of delivery attempts at the current phase */
  attempts: number;
  /** If delivery failed or expired, the reason */
  failureReason?: string;
  /** For broadcasts: aggregate delivery state (separate from per-message phase) */
  broadcastState?: BroadcastState;
}

/** Canonical delivery phases — monotonic progression */
type DeliveryPhase =
  | 'created'        // Message constructed, not yet sent
  | 'sent'           // Written to sender's store
  | 'received'       // Target server acknowledged receipt
  | 'queued'         // Received but awaiting delivery (editor active, session unavailable)
  | 'undelivered'    // SpawnRequestManager disposing; handed off to DeliveryRetryManager for Layer-2 retry
  | 'delivered'      // Injected into target session's tmux input buffer (see Layer 2 notes)
  | 'read'           // Target session acknowledged processing
  | 'expired'        // Delivery TTL elapsed without reaching 'delivered'
  | 'dead-lettered'  // Moved to dead-letter queue (expired, failed, or spawn-denied)
  | 'failed';        // Unrecoverable delivery failure

/** Broadcast-specific aggregate state (separate from per-message phase) */
interface BroadcastState {
  /** Total number of recipients */
  totalRecipients: number;
  /** Per-recipient delivery tracking */
  recipients: Record<string, {
    phase: DeliveryPhase;
    lastAttempt?: string;
    failureReason?: string;
  }>;
  /** Aggregate status — derived, not a DeliveryPhase */
  aggregate: 'pending' | 'partial' | 'complete' | 'failed';
}
```

### Message Type Semantics

| Type | Response Expected | Delivery TTL | Data Retention | Use Case |
|------|-------------------|-------------|----------------|----------|
| `info` | No | 30 min | 7 days | FYI notifications, status updates |
| `sync` | No | 15 min | 3 days | "Here's what I'm working on" |
| `alert` | No (but action expected) | 60 min | 30 days | Errors, security events, resource pressure |
| `request` | Yes (action) | 120 min | 30 days | "Please do X" |
| `query` | Yes (information) | 30 min | 7 days | "What is the status of X?" |
| `response` | No | 15 min | 7 days | Reply to a query or request |
| `handoff` | No | 480 min | 90 days | Session/machine transition context |
| `wellness` | Yes (status) | 5 min | 1 day | Liveness/health check |
| `system` | No | 60 min | 30 days | Config changes, shutdown warnings |

**TTL vs Retention clarification:**
- **Delivery TTL**: How long the system actively attempts delivery. After TTL, the message moves to dead-letter.
- **Data Retention**: How long the message is kept in the store (active + dead-letter) for debugging and auditing. After retention, the message file is deleted.
- `critical` and `alert` messages are NEVER silently expired — they always escalate to Telegram notification on TTL expiry.

### Safe tmux Delivery

When a message is delivered to a running session, the delivery mechanism performs safety checks before injection.

**Pre-injection safety checks:**

```typescript
interface InjectionSafety {
  /** Check the foreground process in the tmux pane */
  foregroundProcess: string; // via `tmux list-panes -F "#{pane_current_command}"`

  /** Allowed foreground processes — ONLY inject if one of these is running.
   *  Whitelist is strictly safer than blocklist: any unlisted process (Python input(),
   *  Node REPL, cat, custom TUIs) would silently consume injected text via stdin. */
  allowedProcesses: ['bash', 'zsh', 'fish', 'sh', 'dash', 'claude'];

  /** Check if the session's Claude context is near capacity */
  contextBudgetCheck: boolean;
}
```

**Delivery decision tree:**

```
1. Is the tmux session alive?
   → No: mark QUEUED, retry on next session start
2. Is the foreground process an allowed shell? (bash/zsh/fish/sh/dash/claude)
   → No: defer delivery (retry in 30 seconds, max 10 retries, then queue)
3. Is the session near its context limit? (estimated via output line count)
   → Yes and message > 1KB: deliver as pointer (see below)
   → No: deliver inline
4. Inject formatted message block via tmux send-keys
```

**Pointer delivery** (when context budget is tight):

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[AGENT MESSAGE] from: dawn-portal/deploy-job | priority: high
type: alert | id: msg_a1b2c3d4
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Message available (context-limited delivery):
  Subject: Database migration applied
  Read full message: /msg read msg_a1b2c3d4
  Quick ack: /msg ack msg_a1b2c3d4
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Inline delivery** (normal case):

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[AGENT MESSAGE] from: dawn-portal/deploy-job | priority: high
type: alert | id: msg_a1b2c3d4 | thread: thr_e5f6g7h8
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Database migration applied: Added column `preferences` to
PortalMemory table. Your Prisma client may need regeneration.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Reply: /msg reply msg_a1b2c3d4 <your response>
Ack: /msg ack msg_a1b2c3d4
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Human visibility**: When a human is watching the terminal (e.g., via the dashboard WebSocket), injected messages should be visually distinguishable. The delimiter lines (`━━━`) serve this purpose. Future: tmux style attributes for color coding.

### `/msg` Command Handling — Skill Architecture

The `/msg` commands available to Claude sessions are implemented as an **Instar skill** (not a hook), for these reasons:

- **Reasoning**: The skill can reason about whether to respond, how to prioritize, whether to forward
- **Validation**: The skill can validate message content before sending (length, type correctness, rate limit awareness)
- **Security**: The skill runs server-side validation before executing any `/msg` action — the session cannot bypass rate limits or forge sender identity

**Anti-injection for `/msg` commands:**

The `/msg` skill MUST validate:
1. The sender identity matches the current session (no sender spoofing)
2. Message bodies do not contain the message delimiter format (prevents injection of fake messages)
3. Rate limits are checked server-side, not client-side
4. The `/msg reply` target ID exists and the session is a legitimate participant in that thread
5. Outbound `/msg send` commands triggered by inbound message content are flagged and rate-limited separately (prevents message storm amplification)

### Server API Endpoints

```
POST /api/messages/send          # Send a message (returns envelope with message ID)
GET  /api/messages/inbox         # List inbox messages (with filters: type, priority, unread)
GET  /api/messages/outbox        # List outbox messages (with delivery status)
GET  /api/messages/:id           # Get a single message by ID
POST /api/messages/ack           # Acknowledge a message (Layer 3)
GET  /api/messages/thread/:id    # Get all messages in a thread
POST /api/messages/relay-agent   # Receive relayed envelope from another agent (same machine, Bearer token)
POST /api/messages/relay-machine # Receive relayed envelope from paired machine (Machine-HMAC + signature)
GET  /api/messages/stats         # Message volume, delivery rates, latency percentiles
POST /api/messages/spawn-request # Request a new session for communication (Phase 5)
GET  /api/messages/dead-letter   # Browse dead-lettered messages
```

---

## Phase 2: Session Summaries & Intelligent Routing

### The Session Summary Sentinel

A lightweight Haiku-tier LLM process that maintains a continuously-updated summary of each active session's work. This is the intelligence layer that enables smart message routing.

#### How It Works

1. **Output monitoring**: The sentinel periodically captures the last N lines of tmux output for each active session (using the existing tmux capture-pane mechanism from WebSocketManager).

2. **Change detection**: Before calling the LLM, it compares the current output hash against the last-summarized hash. If nothing meaningful changed, it skips the LLM call entirely — zero token waste.

3. **Summary generation**: When output has changed, it calls Haiku with a focused prompt:

```
Given this terminal output from an active Claude session, produce a
structured summary:

{
  "task": "one-sentence description of current work",
  "phase": "planning|building|testing|debugging|deploying|idle|engaging",
  "files": ["list of files being actively modified"],
  "topics": ["semantic tags: database, frontend, security, etc."],
  "blockers": "any blockers or waiting states, or null",
  "lastActivity": "ISO timestamp of last meaningful output"
}
```

4. **Storage**: Summaries are written to `.instar/sessions/{sessionId}/summary.json` — lightweight, fast to read, and queryable without LLM calls.

#### Sentinel Failure Handling

The Haiku sentinel is an LLM-dependent component that can fail (API outage, hallucinated routing, malformed output). Resilience strategy:

- **API failure**: Fall back to keyword-based routing (see below). Log the failure. Resume LLM routing when the API recovers.
- **Malformed output**: Validate summary JSON schema before writing. Reject and retry once. If retry fails, keep the previous valid summary and mark it stale.
- **Hallucinated routing**: If a message is delivered and the recipient responds with "this isn't relevant to my work," the router logs a misroute event. After 3 misroutes in 10 minutes, the sentinel falls back to keyword routing for 30 minutes and alerts the operator.
- **Monitoring**: Track misroute rate, sentinel call latency, and fallback frequency in `/api/messages/stats`.

#### Keyword Fallback Routing

When the Haiku sentinel is unavailable, routing falls back to keyword matching:

1. Extract keywords from the message subject and body
2. Match against session summary `topics` and `files` arrays
3. Score by keyword overlap count
4. If no session scores above threshold → queue or spawn

This is less intelligent but deterministic, free, and always available.

#### Cost Analysis

| Scale | Active Sessions | Haiku Calls/Hour (worst case) | Estimated Cost/Hour |
|-------|----------------|-------------------------------|---------------------|
| Small (1 agent) | 3 | 90 | ~$0.02 |
| Medium (3 agents) | 10 | 300 | ~$0.06 |
| Large (10 agents) | 30 | 900 | ~$0.18 |
| Very Large (30 agents) | 100 | 3,000 | ~$0.60 |

At the "very large" scale (100 concurrent sessions), consider:
- Increasing the sentinel interval from 3 to 5 minutes
- Using event-driven updates (triggered by meaningful tmux output changes) instead of polling
- Batching multiple session summaries into a single Haiku call

### Intelligent Routing Algorithm

When a message is sent to `session: "best"`, the router:

1. Fetches all active session summaries for the target agent
2. Scores each session's relevance to the message using a lightweight match:
   - Topic overlap (message subject/body keywords vs. session topics)
   - File overlap (if message references specific files)
   - Phase compatibility (don't interrupt a deploying session with a query)
   - Recency (prefer recently active sessions over idle ones)
3. If the best score exceeds a threshold → deliver to that session
4. If no session scores well enough → queue for next session start, or request spawn (Phase 5)

The scoring starts as keyword-based and uses the Haiku sentinel's structured summaries for richer matching. Future: LLM-scored routing for complex messages.

### Summary Freshness

- Summaries older than 10 minutes are marked "stale"
- Stale summaries are still usable for routing but with reduced confidence
- Sessions that have ended have their summaries archived (not deleted)
- A session's last summary serves as its "tombstone" — useful for handoff context

---

## Phase 3: Acknowledgment Protocol

### Four-Layer Acknowledgment

```
Layer 0: SENT
├── Envelope written to sender's message store
├── Timestamp recorded in delivery.transitions
└── Message ID returned to sender

Layer 1: RECEIVED
├── Target Instar server confirms receipt
├── Envelope written to target's message store
├── ACK sent back to sender's server (idempotent — re-receiving returns same ACK)
└── Failure → exponential backoff retry

Layer 2: DELIVERED (= injected into tmux input buffer)
├── Safety checks pass (foreground process whitelist, context budget)
├── Message injected into target session's tmux stdin via send-keys
├── NOTE: send-keys success confirms buffer injection, NOT session processing
│   (the session may not have read the input yet, or may crash before processing)
├── Post-injection watchdog: monitor tmux pane for 10 seconds
│   ├── If session crashes (pane exits) → regress to QUEUED, retry
│   └── If session alive after 10s → DELIVERED stands
├── ACK recorded in envelope delivery state
└── Failure → queue for retry (non-shell foreground, session busy, human typing)

Layer 3: READ
├── Target session explicitly acknowledges via /msg ack
├── Or implicitly by responding (/msg reply counts as ack)
├── ACK propagated back to sender
└── Timeout → escalation (configurable per message type)
```

### Monotonic State Transitions

Delivery phases can ONLY advance forward along defined transitions. This prevents inconsistencies from out-of-order or duplicate ACKs.

**Canonical transition graph:**

```
created → sent → received → queued ──────────────→ delivered → read
                    │           │                       │
                    │           └──→ undelivered ───────┘
                    │                    │              │
                    │                    └──→ queued    └──→ expired → dead-lettered
                    │                                              ↑
                    └──────────────────────────────→ expired ─────┘
                                                        ↑
                                                     failed → dead-lettered
```

**Valid transitions:**

| From | To | Trigger |
|------|----|---------|
| `created` | `sent` | Envelope written to sender's store |
| `sent` | `received` | Target server ACK (Layer 1) |
| `received` | `queued` | Delivery deferred (editor active, session unavailable, context budget) |
| `received` | `delivered` | Direct delivery succeeded (Layer 2) |
| `queued` | `delivered` | Deferred delivery succeeded (Layer 2) |
| `queued` | `undelivered` | SpawnRequestManager.dispose() hands off to DeliveryRetryManager before shutdown |
| `received` | `undelivered` | SpawnRequestManager.dispose() hands off to DeliveryRetryManager before shutdown |
| `undelivered` | `delivered` | DeliveryRetryManager Layer-2 retry succeeded |
| `undelivered` | `queued` | DeliveryRetryManager promotes back to queued on pickup |
| `undelivered` | `expired` | Delivery TTL elapsed while in undelivered state |
| `undelivered` | `failed` | Unrecoverable error during retry |
| `delivered` | `queued` | **Exception**: post-injection watchdog detects session crash within 10s |
| `delivered` | `read` | Session ACK or reply (Layer 3) |
| `received` | `expired` | Delivery TTL elapsed while in received state |
| `queued` | `expired` | Delivery TTL elapsed while in queued state |
| `expired` | `dead-lettered` | Moved to dead-letter queue |
| `*` | `failed` | Unrecoverable error (e.g., target agent deleted, max retries with no server) |
| `failed` | `dead-lettered` | Moved to dead-letter queue |

**Rules:**
- A message CANNOT regress to an earlier phase — with ONE exception: the post-injection watchdog can regress `delivered` → `queued` if the target session crashes within 10 seconds of injection (this is a crash recovery mechanism, not a normal state transition)
- A duplicate Layer 1 ACK for an already-`delivered` message is ignored (idempotent)
- A late Layer 3 ACK for an already-`expired` message records the READ timestamp in transitions but does not change the phase
- All transitions are recorded in `delivery.transitions` for auditing
- The `broadcastState.aggregate` field is NOT a `DeliveryPhase` — it is a derived summary (`pending` | `partial` | `complete` | `failed`) computed from individual recipient phases

### Delivery Semantics: At-Least-Once

Messages are delivered **at least once**. Deduplication is the receiver's responsibility:

- The receiver checks `message.id` against its inbox before processing
- If the ID already exists, it returns an ACK but does not re-inject into the session
- This is safe because message IDs are UUID v4 (collision-free)

### Retry Semantics

**Layer 1 failure (server unreachable)**:
```
Attempt 1: immediate
Attempt 2: 5 seconds
Attempt 3: 15 seconds
Attempt 4: 45 seconds
Attempt 5: 2 minutes
Attempt 6: 5 minutes
...continues doubling up to max interval of 30 minutes
Max retry window: configurable, default 4 hours
After max window: move to dead-letter, notify via Telegram if critical/alert
```

**Layer 2 failure (session not available or editor active)**:
- Message stays in `received` state in the store
- Re-attempted every 30 seconds if editor-blocked (max 10 retries = 5 minutes)
- Delivered on next session start for that agent
- Or when a new session is spawned that matches the message's routing criteria
- If delivery TTL expires → move to dead-letter with `expired` reason

**Layer 3 timeout (session didn't acknowledge)**:
- `wellness` messages: 2-minute timeout → flag session as potentially stalled
- `query` messages: 5-minute timeout → retry delivery or escalate to human
- `request` messages: 10-minute timeout → re-route to different session or escalate
- `info`/`sync` messages: no timeout (fire-and-forget after Layer 2)

### Broadcast ACK Semantics

For messages with `to.agent="*"` or `to.session="*"`:

1. The router fans out to all matching recipients
2. Each recipient gets its own entry in `broadcastState.recipients` (per-recipient `DeliveryPhase` tracking)
3. The per-message `delivery.phase` reflects the SENDER's state (`sent` → `received` by the local router). Individual recipient progress is tracked exclusively via `broadcastState`:
   - `broadcastState.aggregate = 'pending'` — no recipients have been reached yet
   - `broadcastState.aggregate = 'partial'` — some but not all recipients have been reached
   - `broadcastState.aggregate = 'complete'` — all recipients have reached `delivered` or `read`
   - `broadcastState.aggregate = 'failed'` — all remaining undelivered recipients have failed/expired
4. Broadcast delivery follows the same safety checks per recipient
5. Broadcast ACK aggregation is lazy by default — computed on query, not on every individual ACK. For `critical` priority broadcasts, aggregation is eager (computed on each individual ACK, with Telegram notification when any recipient fails).
6. Broadcast status is queryable: `GET /api/messages/broadcast/{messageId}/status` returns the full `broadcastState` including per-recipient phases

---

## Phase 4: Cross-Machine Messaging

### Relay Protocol

Cross-machine messages use the authenticated machine routes established in the Multi-Machine Spec. Cross-agent same-machine messages use per-agent Bearer tokens.

**Two distinct relay endpoints:**

```
POST /api/messages/relay-agent
Authorization: Bearer {agent-token}
Content-Type: application/json
Body: MessageEnvelope (transport.signature NOT required — same machine trust)

POST /api/messages/relay-machine
Authorization: Machine-HMAC (from Multi-Machine Spec)
Content-Type: application/json
Body: MessageEnvelope (transport.signature REQUIRED — cross-machine trust)
```

**Auth matrix:**

| Endpoint | Auth Mechanism | Signature Required | Trust Boundary |
|----------|---------------|-------------------|----------------|
| `relay-agent` | Bearer token (per-agent, `0600`) | No | Same machine, different agent |
| `relay-machine` | Machine-HMAC + Ed25519 | Yes | Different machine, paired |

The `MessageEnvelope.transport` carries all relay metadata:
- `relayChain`: Machine IDs traversed (loop prevention — reject if self in chain)
- `originServer`: URL for routing ACKs back
- `signature`: Ed25519 signature of the **signed payload** (see Signature Scope below)
- `signedBy`: Machine ID of the signer
- `nonce`: Unique per-envelope (see NonceStore below)
- `timestamp`: Validated per transport type (see Clock Skew Tolerance below)

### Signature Scope

Cross-machine signatures cover the application message AND security-critical transport fields to prevent ACK misdirection and relay chain tampering:

```typescript
/** Fields included in signature computation */
interface SignedPayload {
  message: AgentMessage;          // Full application message
  relayChain: string[];           // Prevents loop-prevention bypass
  originServer: string;           // Prevents ACK misdirection
  nonce: string;                  // Prevents replay
  timestamp: string;              // Temporal binding
}

// Signature = Ed25519.sign(canonicalJSON(signedPayload), signingKey)
```

**Canonical JSON (JCS / RFC 8785)**: To prevent cross-runtime signature verification failures, all signed payloads MUST be serialized using canonical JSON (deterministic key ordering, no insignificant whitespace). Implementation: use the `canonicalize` npm package or equivalent.

The `delivery` field and mutable fields like `delivery.transitions` are NOT signed — they change during transit.

### Clock Skew Tolerance

The v1/v2 30-second timestamp rejection window was too strict for the offline/failover scenarios this spec targets. Clock skew tolerance is now per-transport-type:

| Transport | Timestamp Tolerance | Rationale |
|-----------|-------------------|-----------|
| Real-time relay (`relay-machine`) | 5 minutes | Accommodates minor clock drift; nonce prevents replay within window |
| Real-time relay (`relay-agent`) | No timestamp check | Same machine — clocks are identical |
| Drop directory (offline same-machine) | No timestamp check | Files may sit for hours; rely on nonce + TTL |
| Git sync (offline cross-machine) | No timestamp check | May be hours/days old; rely on signature + nonce + TTL |
| Outbound queue (pending relay) | No timestamp check | Explicitly queued for later delivery; rely on nonce + TTL |

**Rule**: Timestamp validation is ONLY applied to real-time cross-machine relay, where it serves as a freshness check alongside nonce deduplication. All other transports rely on nonce uniqueness, Ed25519 signatures, and message TTL for security.

### NonceStore Specification

The NonceStore prevents replay attacks by tracking recently seen nonces:

```typescript
interface NonceStore {
  /**
   * Check if a nonce has been seen. If not, record it.
   * Returns true if the nonce is fresh (not seen before).
   * Returns false if the nonce is a replay (already seen).
   */
  checkAndRecord(nonce: string, signerId: string): boolean;

  /** Prune nonces older than the retention window */
  prune(): void;
}
```

**Implementation details:**
- **Nonce format**: `{UUID v4}:{ISO timestamp}` — UUID ensures global uniqueness, timestamp enables efficient pruning
- **Storage**: In-memory `Map<string, Set<string>>` keyed by `signerId`, with periodic disk persistence to `.instar/state/nonce-store.json`
- **Retention window**: Matches the timestamp tolerance for the transport type (5 minutes for real-time relay). After the retention window, nonces are pruned — replays of older messages are rejected by timestamp check.
- **Persistence across restarts**: On startup, load from disk. Nonces older than the retention window are discarded. There is a brief window after restart where a replay could succeed if the nonce was pruned from memory but the original message's timestamp is still within tolerance — this is acceptable given the 5-minute window and the difficulty of capturing and replaying a signed envelope.
- **Per-signer partitioning**: Nonces are stored per `signerId` (machine ID). This prevents a compromised machine from polluting another machine's nonce space.

**Routing decision tree:**

```
Message target machine == local?
  → Yes: Is target agent == local agent?
    → Yes: deliver locally (no relay needed)
    → No: relay via POST /api/messages/relay-agent (Bearer token)
  → No: Is target machine paired and online?
    → Yes: relay via POST /api/messages/relay-machine (Machine-HMAC + signature)
    → No: Is target machine paired but offline?
      → Yes: queue in store, retry with backoff
      → No: reject with "unknown machine" error
```

### Cross-Agent Resolution (Same Machine)

When targeting a different agent on the same machine:

1. Look up target agent in `~/.instar/registry.json`
2. Verify agent is running (PID exists AND server port responds to health check)
3. Forward to agent's server port: `POST http://localhost:{port}/api/messages/relay-agent`
   - Authentication: per-agent auth token from `~/.instar/agent-tokens/{agentName}.token`
   - Tokens are 256-bit random, generated on agent init, stored `0600`
4. If agent server is down → write to shared message drop: `~/.instar/messages/drop/{agentName}/`
   - Dropped envelopes MUST include an HMAC computed with the sending agent's token: `HMAC-SHA256(agentToken, canonicalJSON({message, originServer, nonce, timestamp}))`
   - The HMAC covers the same fields as the cross-machine `SignedPayload` (minus `relayChain` and `signature`, which are not applicable to same-machine drops)
   - This prevents any local process from forging messages or tampering with routing metadata via the drop directory
5. Target agent picks up dropped messages on next server start
   - On ingest, verify the HMAC using the sending agent's token (looked up from `~/.instar/agent-tokens/`)
   - Reject and log any envelope with an invalid or missing HMAC

### Cross-Agent + Cross-Machine

For the most complex case (Agent A on Machine 1 → Agent B on Machine 2):

1. Agent A's router resolves: Agent B is not local
2. Checks if Agent B is known on any paired machine (via heartbeat agent list)
3. Relays to the paired machine's primary server endpoint
4. Paired machine's router delivers to Agent B locally

**Cross-machine agent discovery**: The machine heartbeat (Multi-Machine Spec Phase 5) is extended to include a list of agents running on each machine:

```json
{
  "machineId": "m_abc123",
  "timestamp": "...",
  "role": "awake",
  "agents": [
    { "name": "dawn-portal", "port": 4040, "status": "running" },
    { "name": "ai-guy", "port": 4041, "status": "running" }
  ]
}
```

### Git-Sync Fallback (Cross-Machine Offline)

When the target machine is offline and real-time relay fails after exhausting retries:

1. Message envelope is written to `.instar/messages/outbound/{targetMachineId}/{messageId}.json`
2. This directory is included in the git-sync scope (existing GitStateManager)
3. On the receiving machine's next sync, it picks up new files in the inbound directory
4. **Deduplication**: If a message was already received via real-time relay before the git-sync arrives, the duplicate is discarded (ID-based dedup)
5. **Conflict resolution**: Message files are write-once (never modified after creation), so git merge conflicts cannot occur on message content. The JSONL index may conflict — it is regenerated from the per-message files on startup.
6. **Security**: Messages in git are NOT signed at the git level (git signing is for config/relationship data per Multi-Machine Spec). They carry their own Ed25519 signatures in the envelope `transport.signature` field, which is verified on receipt regardless of delivery mechanism.

---

## Phase 5: On-Demand Session Spawning

### Spawn Request Flow

When an agent wants to communicate but no suitable session exists on the target:

```
1. Sender scans target agent's session summaries
2. No matching session found (or no sessions running)
3. Sender sends a spawn request:

POST /api/messages/spawn-request
{
  "requester": { agent, session, machine },
  "target": { agent, machine },
  "reason": "Need to discuss database migration impact",
  "context": "Migration adds preferences column to PortalMemory...",
  "priority": "high",
  "suggestedModel": "sonnet",
  "suggestedMaxDuration": 30,
  "pendingMessages": ["msg_id_1", "msg_id_2"]
}

4. Target agent's server evaluates:
   - Does resource availability allow a new session?
   - Is the request priority high enough?
   - Is the requester authorized? (same owner/user)
   - Memory pressure check

5. If approved:
   - SessionManager spawns a new session
   - Initial prompt includes the pending messages and spawn context
   - Session starts with full awareness of WHY it was created
   - Pending messages are delivered immediately

6. If denied (resource constraints):
   - Response sent back with reason and suggested retry time
   - Messages stay queued in received state
   - Retry governed by spawn request timeout (see below)
```

### Spawn Request Timeout & Escalation

Spawn requests that are persistently denied (resource constraints, quota exhaustion) must not cause indefinite message stalls:

```
Spawn request denied:
  → Retry after suggested wait time (from denial response)
  → Max 3 retry attempts over 30 minutes
  → After 3 denials:
    1. Move pending messages to dead-letter with reason "spawn-denied"
    2. If any pending message is critical/alert: escalate to Telegram
    3. If pending messages are query/request: notify sender of failure
    4. Log spawn denial pattern for operator review
```

### Session Prompt Template for Spawned Sessions

```
You were spawned by an inter-agent message request.

Requester: {requester.agent}/{requester.session} on {requester.machine}
Reason: {reason}
Context: {context}

You have {pendingMessages.length} pending message(s) to process.
After addressing these messages, you may continue with other work
or end your session if no further action is needed.

Use /msg reply <id> <response> to respond to messages.
Use /msg send <agent> <message> to send new messages.
```

### Resource Governance

Spawn requests are governed by:
- **Session limits**: Respects `maxSessions` config
- **Memory pressure**: No spawning above "moderate" memory pressure
- **Cooldown**: No more than 1 spawn request per agent per 5 minutes (prevents spawn storms)
- **Quota awareness**: Spawn sessions count against Claude API quota
- **Model ceiling**: Spawned sessions cannot use a higher model tier than the requester's tier

---

## Phase 6: Conversation Threads

### Thread Model

Multi-turn conversations between agents use threads for continuity:

```typescript
interface MessageThread {
  id: string;                    // Thread ID (UUID)
  subject: string;               // Thread subject
  participants: ThreadParticipant[];
  createdAt: string;
  lastMessageAt: string;
  messageCount: number;
  status: 'active' | 'resolved' | 'stale';
  /** All message IDs in chronological order */
  messageIds: string[];
}

interface ThreadParticipant {
  agent: string;
  session: string;
  joinedAt: string;
  lastMessageAt: string;
}
```

### Thread Lifecycle

1. **Creation**: Any message with no `threadId` that expects a response auto-creates a thread
2. **Continuation**: Replies carry the `threadId` and `inReplyTo` fields
3. **Resolution**: Thread is resolved when the original requester explicitly closes it or when TTL expires
4. **Staleness**: Threads with no activity for 30 minutes are marked stale
5. **Archival**: Resolved/stale threads are moved to `.instar/messages/threads/archive/`

### Thread Context in Delivery

When delivering a message that's part of a thread, the formatted block includes thread history:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[AGENT MESSAGE] from: dawn-portal/deploy-job | priority: medium
type: response | id: msg_x1y2z3 | thread: thr_a1b2c3 (3 messages)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Thread context (2 prior messages):
  [1] You asked: "Did the migration include the new index?"
  [2] deploy-job replied: "Yes, added btree index on themes column"

New message:
  Great. Also, did you update the Prisma schema to reflect the
  new column? I'm seeing type errors in my build.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Delivery Mechanisms

### Mechanism 1: Safe tmux injection (primary, same-machine)

**Per-session injection mutex**: Each session has a delivery mutex that ensures:
- Only one message is injected at a time (no interleaving)
- Messages are delivered in FIFO order per (sender, session) pair
- The mutex includes a `delivery.sequence` counter for debugging

```typescript
/** Per-session delivery mutex — ensures FIFO ordering and no interleaving */
const sessionMutexes = new Map<string, { locked: boolean; queue: MessageEnvelope[] }>();

async function deliverToSession(session: Session, envelope: MessageEnvelope): Promise<boolean> {
  // Acquire per-session mutex (FIFO queue if locked)
  const mutex = getOrCreateMutex(session.id);
  if (mutex.locked) {
    mutex.queue.push(envelope);
    return true; // Queued — will be delivered when mutex is released
  }
  mutex.locked = true;

  try {
    return await doDelivery(session, envelope);
  } finally {
    mutex.locked = false;
    // Drain the queue
    if (mutex.queue.length > 0) {
      const next = mutex.queue.shift()!;
      deliverToSession(session, next); // Recursive — processes queue in order
    }
  }
}

async function doDelivery(session: Session, envelope: MessageEnvelope): Promise<boolean> {
  // Safety check 1: Is the tmux session alive?
  if (!isTmuxSessionAlive(session.tmuxSession)) {
    return false; // Mark as queued, retry on session restart
  }

  // Safety check 2: Is the foreground process a known shell? (whitelist, not blocklist)
  // Any non-shell process (vim, Python input(), Node REPL, etc.) would consume injected text
  const fg = getForegroundProcess(session.tmuxSession);
  const ALLOWED_PROCESSES = ['bash', 'zsh', 'fish', 'sh', 'dash', 'claude'];
  if (!ALLOWED_PROCESSES.includes(fg)) {
    return false; // Defer — retry in 30 seconds
  }

  // Safety check 3: Is a human actively typing? (attached client with recent input)
  if (hasActiveHumanInput(session.tmuxSession)) {
    return false; // Defer — retry in 10 seconds (shorter, human typing is transient)
  }

  // Safety check 4: Context budget — estimate token usage
  const outputLines = getTmuxOutputLineCount(session.tmuxSession);
  const usePointer = outputLines > CONTEXT_BUDGET_THRESHOLD && envelope.message.body.length > 1024;

  // Safety check 5: Payload size — large payloads go to temp file
  const hasLargePayload = envelope.message.payload &&
    JSON.stringify(envelope.message.payload).length > PAYLOAD_INLINE_THRESHOLD;

  let formatted: string;
  if (usePointer) {
    formatted = formatPointerBlock(envelope.message);
  } else if (hasLargePayload) {
    const payloadPath = writePayloadToTempFile(envelope);
    formatted = formatInlineBlockWithPayloadRef(envelope.message, payloadPath);
  } else {
    formatted = formatInlineBlock(envelope.message);
  }

  // Safety check 6: Sanitize — strip any content mimicking message delimiters
  const sanitized = sanitizeMessageContent(formatted);

  try {
    execSync(`tmux send-keys -t ${shellEscape(session.tmuxSession)} ${shellEscape(sanitized)} Enter`);

    // Post-injection watchdog: verify session survives injection
    // send-keys success only means "written to tmux input buffer", not "session processed it"
    schedulePostInjectionWatchdog(session.tmuxSession, envelope.message.id, {
      checkAfterMs: 10_000,
      onCrash: () => {
        // Session died after injection — regress to queued for retry
        regressDeliveryPhase(envelope.message.id, 'delivered', 'queued',
          'post-injection-crash: session exited within watchdog window');
      },
    });

    return true; // Layer 2 ACK (tentative — watchdog may regress)
  } catch {
    return false; // Delivery failed
  }
}

function getForegroundProcess(tmuxSession: string): string {
  return execSync(
    `tmux list-panes -t ${shellEscape(tmuxSession)} -F "#{pane_current_command}"`
  ).toString().trim();
}

function hasActiveHumanInput(tmuxSession: string): boolean {
  // Check if any client is attached and has recent activity
  try {
    const clients = execSync(
      `tmux list-clients -t ${shellEscape(tmuxSession)} -F "#{client_activity}"`
    ).toString().trim();
    if (!clients) return false;
    // If client activity was within the last 2 seconds, human is likely typing
    const lastActivity = parseInt(clients.split('\n')[0], 10);
    return (Date.now() / 1000 - lastActivity) < 2;
  } catch {
    return false; // No clients attached — safe to inject
  }
}

/** Write large payloads to temp file, return path for reference in message */
function writePayloadToTempFile(envelope: MessageEnvelope): string {
  const payloadPath = path.join(os.tmpdir(), `instar-payload-${envelope.message.id}.json`);
  fs.writeFileSync(payloadPath, JSON.stringify(envelope.message.payload, null, 2));
  return payloadPath;
}
```

**Payload delivery**: Message bodies (max 4KB) are always delivered inline. Structured `payload` fields larger than 2KB are written to a temp file, and the inline message includes a reference:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[AGENT MESSAGE] from: dawn-portal/feedback-processor | priority: medium
type: request | id: msg_a1b2c3d4
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Feedback item FB-0847 reports a bug in session spawning logic.
Payload: /tmp/instar-payload-msg_a1b2c3d4.json (14.2KB)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```
```

### Mechanism 2: Server HTTP relay (cross-agent, cross-machine)

```typescript
async function relayEnvelope(targetUrl: string, envelope: MessageEnvelope): Promise<boolean> {
  // Add self to relay chain (before signing — relayChain is part of SignedPayload)
  envelope.transport.relayChain.push(localMachineId);

  // Determine relay type
  const crossMachine = isCrossMachine(targetUrl);
  const endpoint = crossMachine ? '/api/messages/relay-machine' : '/api/messages/relay-agent';

  // Sign if crossing machine boundary (covers full SignedPayload, not just message)
  if (crossMachine) {
    const signedPayload: SignedPayload = {
      message: envelope.message,
      relayChain: envelope.transport.relayChain,
      originServer: envelope.transport.originServer,
      nonce: envelope.transport.nonce,
      timestamp: envelope.transport.timestamp,
    };
    envelope.transport.signature = sign(canonicalJSON(signedPayload), signingKey);
    envelope.transport.signedBy = localMachineId;
  }

  const response = await fetch(`${targetUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': crossMachine
        ? getMachineHMAC(targetUrl)   // Machine-HMAC for cross-machine
        : getAgentToken(targetUrl),    // Bearer token for cross-agent same-machine
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(envelope),
  });
  return response.ok; // Layer 1 ACK
}
```

### Mechanism 3: File drop (offline fallback, same machine)

```typescript
function dropMessage(targetAgent: string, envelope: MessageEnvelope): void {
  const dropDir = path.join(os.homedir(), '.instar', 'messages', 'drop', targetAgent);
  fs.mkdirSync(dropDir, { recursive: true });
  // Atomic write: tmp + rename
  const tmpPath = path.join(dropDir, `${envelope.message.id}.tmp`);
  const finalPath = path.join(dropDir, `${envelope.message.id}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2));
  fs.renameSync(tmpPath, finalPath);
}
```

### Mechanism 4: Git sync (cross-machine offline fallback)

Messages that can't be delivered in real-time are written to `.instar/messages/outbound/{machineId}/` and synced via the existing git sync mechanism. See [Phase 4: Git-Sync Fallback](#git-sync-fallback-cross-machine-offline) for deduplication and conflict resolution rules.

### Future: First-Class Agent Runtime API (Phase 7+)

The tmux injection mechanism is pragmatic for Phase 1 but has inherent fragility (editor corruption, context pollution, interleaving). A future phase should introduce a proper agent runtime API:

- Sessions maintain a message queue accessible via a local socket or HTTP endpoint
- The Claude session's framework polls or subscribes to its message queue
- Messages are delivered as structured data, not injected text
- This decouples message delivery from terminal state entirely

This is a non-trivial architectural change (requires Claude Code support for agent-to-agent APIs) and is deferred to a future spec.

---

## Storage & Durability

### Storage Architecture

Messages use a **per-message file as source of truth** with a **JSONL index as derived data**:

```
~/.instar/messages/
  store/
    {messageId}.json          # Source of truth — one file per message envelope
  index/
    inbox.jsonl               # Derived index — rebuilt from store/ on startup
    outbox.jsonl              # Derived index — rebuilt from store/ on startup
  dead-letter/
    {messageId}.json          # Expired/failed messages (same format as store/)
  pending/
    {messageId}.json          # Messages awaiting delivery (symlinks to store/)
  threads/
    {threadId}.json           # Thread metadata
    archive/
      {threadId}.json         # Resolved/stale threads
  drop/                       # Cross-agent offline drops (HMAC-authenticated, perms 0700)
    {agentName}/
      {messageId}.json        # Must include transport.hmac for integrity
  outbound/                   # Cross-machine offline queue
    {machineId}/
      {messageId}.json
```

**Why per-message files + JSONL index:**
- Per-message files: No concurrency issues (write-once, append-only transitions). Each file is a self-contained envelope. Safe for concurrent readers/writers.
- JSONL index: Fast queries (list inbox, filter by type/priority). Rebuilt on startup from store/ directory. If corrupted, regeneration is lossless.
- This eliminates the JSONL corruption risk flagged in v1 review while maintaining query performance.

### File Locking

All writes use the existing `proper-lockfile` pattern from StateManager:

```typescript
const LOCK_OPTIONS = {
  stale: 10_000,
  retries: { retries: 5, factor: 2, minTimeout: 100 },
};

// Lock per-message file during delivery state updates
await lockfile.lock(messagePath, LOCK_OPTIONS);
try {
  const envelope = JSON.parse(fs.readFileSync(messagePath, 'utf-8'));
  envelope.delivery.phase = 'delivered';
  envelope.delivery.transitions.push({ from: 'received', to: 'delivered', at: new Date().toISOString() });
  // Atomic write
  fs.writeFileSync(messagePath + '.tmp', JSON.stringify(envelope, null, 2));
  fs.renameSync(messagePath + '.tmp', messagePath);
} finally {
  await lockfile.unlock(messagePath);
}
```

### Retention & Rotation

| Category | Retention Period | Action on Expiry |
|----------|-----------------|------------------|
| Active messages (store/) | Per-type (see Message Type Semantics table) | Move to dead-letter/ |
| Dead-letter messages | 30 days | Delete file |
| Thread metadata | 90 days after resolution | Delete file |
| JSONL indexes | Rotated when > 10MB | Archive to `index/archive/YYYY-MM-DD.jsonl.gz` |
| Session summaries | Deleted when session ends + 24 hours | Delete file |

**Cleanup job**: A lightweight periodic task (runs every hour) scans store/ and dead-letter/ for files past their retention period. This is a file-system-only operation — no LLM needed.

### Crash Recovery

On server startup:
1. Scan `store/` for all message envelopes
2. Rebuild `inbox.jsonl` and `outbox.jsonl` indexes from the per-message files
3. Check `pending/` for messages that were mid-delivery when the server crashed → re-queue for delivery
4. Check `drop/` for messages left by other agents while this agent was down:
   - Verify HMAC (same-machine) or Ed25519 signature (cross-machine) on each envelope
   - Valid envelopes → ingest into store/, delete source file
   - Invalid/corrupted envelopes → move to dead-letter/ with `failureReason: "drop-integrity-failure"`
5. Scan `drop/` and `outbound/` for files older than `2 × maxTTL` → delete with warning log
6. Log any orphaned or corrupted files to the security log

### Configurable Storage Path

The message store defaults to `~/.instar/messages/` (machine-wide, shared across agents on the same machine). This path is configurable in `messaging.json` for environments where `~/.instar/` is not appropriate (e.g., containerized deployments, custom data directories):

```json
{
  "storage": {
    "basePath": "~/.instar/messages",
    "retentionDays": { "active": 30, "deadLetter": 30 }
  }
}
```

---

## Noise & Loop Prevention

### Rate Limiting

| Scope | Limit | Window |
|-------|-------|--------|
| Per session (sending) | 20 messages | 5 minutes |
| Per session (receiving) | 30 messages | 5 minutes |
| Per agent (total) | 100 messages | 5 minutes |
| Per thread | 50 messages | Total lifetime |
| Broadcast messages | 5 | 5 minutes |
| Cross-machine relay | 30 messages | 5 minutes |
| Outbound triggered by inbound | 5 messages | 1 minute |

The last row is critical for prompt injection defense: if an inbound message causes the session to emit outbound `/msg send` commands, these are rate-limited separately and more aggressively.

### Loop Detection

**Relay chain tracking**: Every envelope carries `transport.relayChain` — the list of machine IDs it has passed through. If a machine sees itself in the chain, it drops the envelope and logs a loop event.

**Conversation depth limit**: Threads have a configurable max depth (default: 20 messages). After this, the thread is auto-resolved with a summary message.

**Echo prevention**: A session cannot send a message to itself. An agent cannot broadcast to itself (broadcast targets other agents or other sessions on the same agent).

**Cooldown after burst**: If a session hits its rate limit, it enters a 5-minute cooldown where only `critical` and `alert` messages are accepted.

### Circuit Breakers

Under extreme message volume (sustained rate limit hits across multiple agents), circuit breakers activate:

| Threshold | Action |
|-----------|--------|
| 3+ agents hit rate limit within 1 minute | Pause `low` priority messages for 5 minutes |
| 5+ agents hit rate limit within 1 minute | Pause `low` + `medium` for 10 minutes |
| Any agent exceeds 2x rate limit | Circuit OPEN for that agent — only `critical` messages for 15 minutes |
| Cross-machine relay errors > 50% | Circuit OPEN for that machine — queue all, no relay for 5 minutes |

Circuit breaker state is logged and visible in `/api/messages/stats`.

### Deduplication

Messages are deduplicated by `message.id`. If a message ID is already in the store (from retry or relay), the duplicate is discarded and only an ACK is returned.

### Priority-Based Throttling

Under load, lower-priority messages are deferred:
- `critical` + `alert`: always delivered immediately
- `high`: delivered if under 75% of rate limit
- `medium`: delivered if under 50% of rate limit
- `low`: delivered if under 25% of rate limit

---

## Security Model

### Authentication

| Boundary | Mechanism | Details |
|----------|-----------|---------|
| Same-agent (session → server) | Session ID validation | Server tracks which tmux sessions it manages; validates session ID on every `/msg` API call |
| Cross-agent same-machine | Per-agent auth tokens | 256-bit random tokens in `~/.instar/agent-tokens/{agentName}.token` (perms `0600`). Generated on `instar init`. Presented as `Authorization: Bearer {token}` |
| Cross-machine | Machine identity keypairs | Ed25519 signing + Machine-HMAC from Multi-Machine Spec. Envelope `transport.signature` verified on receipt. |

**Why not PID-based auth for cross-agent?** PID checks (kill -0) verify process existence but not identity. Any local process could claim to be any agent. Per-agent tokens stored with restrictive filesystem permissions provide a real authentication boundary for single-user machines. For multi-user machines, see Multi-Tenant Isolation below.

### Authorization

- **Same-owner agents**: Full messaging access (all message types)
- **Cross-owner agents**: Not supported in v1 (future: permission-based)
- **System messages**: Only the Instar server process can send `type: "system"` messages — validated by checking that the `from.session` is `"server"` AND the request originates from the server's own event loop (not an external HTTP call)

### Message Integrity

- Cross-machine messages are signed with the sending machine's Ed25519 key
- Signature covers the `SignedPayload` (see Signature Scope section): `message`, `relayChain`, `originServer`, `nonce`, and `timestamp` — not just the application message
- Same-machine drops are HMAC-authenticated using per-agent tokens (see Drop Directory Integrity)
- All payloads serialized with canonical JSON (JCS / RFC 8785) for cross-runtime determinism
- Signatures are verified on receipt before delivery — tampered messages are rejected and logged to SecurityLog
- Nonce uniqueness (via NonceStore) + per-transport timestamp tolerance prevent replay attacks
- The `delivery` field is NOT signed — it is mutable during transit

### Injection Prevention

Messages delivered to Claude sessions via tmux carry prompt injection risk. A malicious or compromised agent could craft a message body that manipulates the receiving session. Mitigations:

1. **Body size limits**: Message bodies truncated at 4KB, payloads at 16KB (configurable)
2. **Delimiter sanitization**: The server strips any content that mimics the message delimiter format (`━━━` patterns, `[AGENT MESSAGE]` headers) from message bodies before delivery
3. **Source identification**: The formatted block clearly identifies the sender — the session can reason about trust
4. **Outbound rate limiting**: Messages sent by a session in response to received messages are rate-limited separately (5/minute) to prevent amplification attacks
5. **Server-side validation**: All `/msg` commands are validated server-side. The session cannot forge its own sender identity, bypass rate limits, or send to unauthorized targets
6. **Sessions treat inter-agent messages as untrusted input** — documented in the spawned session prompt template and the `/msg` skill instructions

### Drop Directory Integrity

The `drop/` directory is a trust boundary — any local process with filesystem access can write files there. Without integrity checks, it becomes a vector for message forgery.

**Requirements:**
1. **HMAC on all dropped envelopes**: Same-machine drops include `HMAC-SHA256(senderAgentToken, canonicalJSON({message, originServer, nonce, timestamp}))` in the envelope's `transport.hmac` field. The HMAC covers routing-critical transport fields (not just the message body) to prevent metadata tampering. The receiver verifies using the sender's token from `~/.instar/agent-tokens/`.
2. **Cross-machine drops carry Ed25519 signatures**: Same as relay — signature verification is required regardless of delivery mechanism.
3. **Directory ownership enforcement**: On startup, the agent verifies that `drop/{ownAgentName}/` is owned by the process user and has permissions `0700`. If not, it logs a security warning and refuses to ingest until the directory is re-secured.
4. **Garbage collection**: The cleanup job (hourly) also scans `drop/` and `outbound/` directories. Files older than `2 × maxTTL` (default 48 hours) are deleted with a warning log. This prevents unbounded accumulation if a target agent is permanently removed.
5. **Ingest-and-delete**: After successful ingestion from `drop/`, the source file is deleted. Failed ingestions (bad HMAC, corrupted JSON) are moved to `dead-letter/` with a `failureReason: "drop-integrity-failure"`.

### No Privilege Escalation

- Messages cannot trigger session spawning above the sender's privilege level
- A `haiku` session cannot request an `opus` session be spawned
- Cross-agent requests inherit the LOWER of sender and receiver permission levels

### Multi-Tenant Isolation (Future)

Currently designed for single-owner machines. For future multi-user support:
- Per-user namespaced directories: `~/.instar/users/{userId}/messages/`
- Tenant ID in message metadata for cross-tenant filtering
- Agent tokens bound to owner identity, not just agent name
- This is a Phase 7+ concern — design hooks are in place but enforcement is not implemented in v1

---

## Observability & Debugging

### Metrics (via `/api/messages/stats`)

```json
{
  "volume": {
    "sent": { "total": 142, "last5min": 8, "last1hr": 47 },
    "received": { "total": 138, "last5min": 7, "last1hr": 45 },
    "deadLettered": { "total": 4, "last5min": 0, "last1hr": 1 }
  },
  "delivery": {
    "avgLatencyMs": { "layer1": 12, "layer2": 45, "layer3": 8200 },
    "p95LatencyMs": { "layer1": 35, "layer2": 120, "layer3": 25000 },
    "successRate": { "layer1": 0.98, "layer2": 0.95, "layer3": 0.87 }
  },
  "routing": {
    "sentinelCalls": { "total": 890, "last1hr": 42 },
    "sentinelFallbacks": { "total": 3, "last1hr": 0 },
    "misroutes": { "total": 2, "last1hr": 0 }
  },
  "rateLimiting": {
    "sessionsThrottled": 1,
    "circuitBreakers": { "open": 0, "recentTrips": 0 }
  },
  "threads": {
    "active": 3,
    "resolved": 47,
    "stale": 1
  }
}
```

### Debugging Workflow

**Tracing a message end-to-end:**

```bash
# 1. Find the message by ID
instar msg show msg_a1b2c3d4

# 2. See all delivery state transitions
instar msg trace msg_a1b2c3d4

# 3. If it's in dead-letter, see why
instar msg dead-letter --id msg_a1b2c3d4

# 4. If it was relayed cross-machine, see the relay chain
instar msg trace msg_a1b2c3d4 --relay-hops
```

**Dashboard integration** (future): The web dashboard can show:
- Real-time message feed (WebSocket subscription to message events)
- Thread visualization (who's talking to whom)
- Delivery pipeline status (messages at each layer)
- Circuit breaker state
- Sentinel health and misroute rate

### Alerting

| Event | Channel | Condition |
|-------|---------|-----------|
| Critical message expired | Telegram | Any `critical`/`alert` message reaches dead-letter |
| Persistent spawn denial | Telegram | 3+ spawn denials in 30 minutes |
| High misroute rate | Telegram | 3+ misroutes in 10 minutes |
| Circuit breaker opened | Log + Telegram | Any circuit breaker trips |
| Storage approaching limit | Log | Store directory > 1GB |

---

## CLI & API Reference

### CLI Commands

```bash
# Send a message to another agent/session
instar msg send <target-agent> "message body" [--type info] [--priority medium]

# Send to a specific session
instar msg send <target-agent> --session <session-id> "message body"

# Broadcast to all local agents
instar msg broadcast "message body" [--type alert] [--priority high]

# Check inbox
instar msg inbox [--unread] [--type query] [--from <agent>]

# View a specific message
instar msg show <message-id>

# Trace message delivery history
instar msg trace <message-id> [--relay-hops]

# View a thread
instar msg thread <thread-id>

# Reply to a message
instar msg reply <message-id> "response body"

# Acknowledge a message
instar msg ack <message-id>

# Browse dead-letter queue
instar msg dead-letter [--reason expired] [--since 24h]

# View messaging stats
instar msg stats

# View circuit breaker state
instar msg circuits
```

### In-Session Commands (Skill)

These are available to Claude sessions via the `/msg` skill:

```
/msg send <agent> <message>           # Send a message
/msg reply <message-id> <response>    # Reply to a received message
/msg ack <message-id>                 # Acknowledge receipt
/msg read <message-id>                # Read full message (for pointer-delivered messages)
/msg inbox                            # Check for pending messages
/msg thread <thread-id>               # View thread context
```

### REST API

```
POST /api/messages/send          # Send a message (returns envelope with message ID)
GET  /api/messages/inbox         # List inbox (filters: type, priority, unread, from, since)
GET  /api/messages/outbox        # List outbox (filters: type, delivery phase, to)
GET  /api/messages/:id           # Get a single message envelope
POST /api/messages/ack           # Acknowledge a message (Layer 3 — idempotent)
GET  /api/messages/thread/:id    # Get all messages in a thread
POST /api/messages/relay-agent   # Receive relayed envelope from local agent (Bearer token auth)
POST /api/messages/relay-machine # Receive relayed envelope from paired machine (Machine-HMAC + Ed25519 signature)
GET  /api/messages/stats         # Messaging metrics
POST /api/messages/spawn-request # Request session spawn for communication
GET  /api/messages/dead-letter   # Browse dead-lettered messages
DELETE /api/messages/:id         # Delete a message (admin only, audit logged)
```

---

## File Layout

```
~/.instar/
  messages/
    store/
      {messageId}.json            # Source of truth — one file per envelope
    index/
      inbox.jsonl                 # Derived index (rebuilt on startup)
      outbox.jsonl                # Derived index (rebuilt on startup)
      archive/
        YYYY-MM-DD.jsonl.gz       # Rotated index files
    dead-letter/
      {messageId}.json            # Expired/failed messages
    pending/
      {messageId}.json            # Symlinks to store/ for pending delivery
    threads/
      {threadId}.json             # Active thread metadata
      archive/
        {threadId}.json           # Resolved/stale threads
    drop/                         # Cross-agent offline drops (machine-wide)
      {agentName}/
        {messageId}.json
    outbound/                     # Cross-machine offline queue
      {machineId}/
        {messageId}.json

  agent-tokens/
    {agentName}.token             # Per-agent auth tokens (0600 perms)

.instar/                          # Per-agent (in project directory)
  sessions/
    {sessionId}/
      summary.json                # Haiku-maintained session summary
  config/
    messaging.json                # Agent-specific messaging config overrides
```

### Configuration (`messaging.json`)

```json
{
  "enabled": true,
  "schemaVersion": 1,
  "storage": {
    "basePath": "~/.instar/messages",
    "retentionDays": {
      "active": 30,
      "deadLetter": 30,
      "threads": 90,
      "summaries": 1
    },
    "maxStoreSizeMB": 1024,
    "indexRotationSizeMB": 10
  },
  "rateLimits": {
    "perSessionSend": { "count": 20, "windowMinutes": 5 },
    "perSessionReceive": { "count": 30, "windowMinutes": 5 },
    "perAgent": { "count": 100, "windowMinutes": 5 },
    "broadcast": { "count": 5, "windowMinutes": 5 },
    "inboundTriggeredOutbound": { "count": 5, "windowMinutes": 1 }
  },
  "circuitBreakers": {
    "agentOverloadThreshold": 2.0,
    "multiAgentTripCount": 3,
    "relayErrorThresholdPercent": 50,
    "openDurationMinutes": 15
  },
  "sentinel": {
    "enabled": true,
    "model": "haiku",
    "intervalMinutes": 3,
    "maxOutputTokens": 150,
    "misrouteFallbackThreshold": 3,
    "misrouteFallbackWindowMinutes": 10,
    "keywordFallbackDurationMinutes": 30
  },
  "delivery": {
    "tmuxInjection": true,
    "maxMessageBodyBytes": 4096,
    "maxPayloadBytes": 16384,
    "defaultTtlMinutes": 60,
    "maxRetryWindowMinutes": 240,
    "editorRetryIntervalSeconds": 30,
    "editorRetryMaxAttempts": 10,
    "contextBudgetThresholdLines": 5000
  },
  "threads": {
    "maxDepth": 20,
    "staleAfterMinutes": 30,
    "autoArchive": true
  },
  "spawn": {
    "enabled": true,
    "cooldownMinutes": 5,
    "maxSpawnedSessionDuration": 30,
    "maxDenialRetries": 3,
    "denialEscalationWindowMinutes": 30
  }
}
```

---

## Cost Model

### Haiku Sentinel

| Component | Per-Call Cost | Frequency | Monthly Cost (3 sessions) | Monthly Cost (30 sessions) |
|-----------|-------------|-----------|--------------------------|---------------------------|
| Sentinel summary | ~600 tokens ($0.00015) | Every 3 min when active | ~$3.24 | ~$32.40 |
| Routing decision | ~200 tokens ($0.00005) | Per "best" routed message | <$1 | <$5 |

**Optimization levers:**
- Increase interval to 5 minutes (40% reduction)
- Event-driven updates instead of polling (estimated 60% reduction)
- Batch multiple session summaries per call (estimated 30% reduction at scale)

### Storage

| Component | Per-Message | 1,000 messages/day | 10,000 messages/day |
|-----------|-------------|---------------------|---------------------|
| Envelope file | ~2KB | ~2MB/day | ~20MB/day |
| JSONL index entry | ~200B | ~200KB/day | ~2MB/day |
| With 30-day retention | — | ~66MB | ~660MB |

At the 10K messages/day scale, the 1GB storage limit in config would trigger an alert. This is the point to consider SQLite migration (see Migration Path).

---

## Testing Strategy

### Unit Tests

- Message/envelope serialization and schema validation
- Delivery state machine transitions (monotonic advancement)
- Rate limiter logic (per-session, per-agent, broadcast, inbound-triggered)
- Deduplication (inbox idempotency with UUID)
- Loop detection (relay chain self-detection)
- Session summary change detection (hash comparison)
- Thread lifecycle (creation, resolution, staleness, archival)
- Circuit breaker state transitions
- Keyword fallback routing accuracy
- Delimiter sanitization (injection prevention)
- JSONL index rebuild from per-message files

### Integration Tests

- Same-agent message delivery (send → safe tmux injection → ack)
- Cross-agent message delivery via per-agent token auth
- Editor safety check (message deferred when vim is running)
- Context budget pointer delivery (message delivered as pointer when near limit)
- Message persistence (crash recovery — messages survive server restart)
- JSONL index corruption recovery (rebuild from store/)
- Rate limiting under load (priority-based throttling)
- TTL expiration → dead-letter transition
- Spawn request flow (request → evaluate → spawn → deliver)
- Spawn denial → timeout → escalation flow

### E2E Tests

- Full conversation thread across two agents (send, reply, reply, resolve)
- Cross-machine relay (requires two servers, can use localhost with different ports)
- Offline fallback (kill target server, verify queuing, restart, verify delivery)
- Git-sync fallback (simulate offline machine, verify git delivery, verify dedup on reconnect)
- Session summary sentinel (verify summaries update when sessions are active)
- Intelligent routing (send to "best" session, verify correct session receives it)
- Sentinel failure → keyword fallback → recovery

### Chaos Tests

- Kill server mid-delivery — verify message recovery on restart
- Fill rate limit — verify priority-based throttling
- Spawn storm — verify cooldown prevents resource exhaustion
- Network partition between machines — verify git-sync fallback
- Corrupt JSONL index — verify transparent rebuild
- Concurrent message delivery to same session — verify no interleaving

### Rollback Tests

- Disable messaging mid-conversation — verify graceful degradation
- Downgrade schema version — verify rejection of newer envelopes
- Feature flag toggle — verify per-phase isolation

---

## Migration & Rollback

### v0 → v1 (This Spec)

No migration needed — this is a new capability. Existing agents gain messaging by updating Instar.

### Rollout Phases

1. **Phase 1** (Message primitives + envelope + storage): Ship first. Enables basic same-agent communication with safe delivery and durable storage.
2. **Phase 2** (Session summaries): Can ship independently. Useful even without messaging (dashboard, debugging).
3. **Phase 3** (ACK protocol): Ships with Phase 1 — the protocol is part of the primitive.
4. **Phase 4** (Cross-machine): Requires multi-machine pairing to be active. Builds on existing machine routes.
5. **Phase 5** (Session spawning): Ships after Phase 2 (needs summaries for routing decisions).
6. **Phase 6** (Threads): Ships after Phase 1 proves useful. Adds conversational depth.

### Feature Flags

Each phase is independently toggleable in `messaging.json`. Operators can enable messaging without enabling spawning, or enable local messaging without cross-machine relay.

### Rollback Strategy

Each phase can be rolled back independently:

| Phase | Rollback Action | Data Impact |
|-------|----------------|-------------|
| Phase 1 | Set `enabled: false` in messaging.json | Messages in store/ are preserved but not delivered. Resume by re-enabling. |
| Phase 2 | Set `sentinel.enabled: false` | Routing falls back to keyword matching. Summaries stop updating. |
| Phase 3 | N/A (ships with Phase 1) | ACK protocol is part of the message primitive |
| Phase 4 | Disable cross-machine routes | Messages queue locally; delivered when re-enabled |
| Phase 5 | Set `spawn.enabled: false` | Spawn requests rejected. Messages queue for manual session creation. |
| Phase 6 | Set `threads.enabled: false` (future flag) | New threads not created. Existing threads resolve normally. |

### Future: SQLite Migration (Phase 7+)

When message volume exceeds the file-based store's practical limits (~10K messages/day, ~1GB store), migrate to SQLite:

- Per-message files → SQLite rows with full-text search
- JSONL indexes → SQLite indexes (automatic)
- Dead-letter → SQLite table with TTL-based cleanup
- Migration tool: read all `.json` files, insert into SQLite, verify counts, archive originals

This is a transparent backend change — the API surface and delivery mechanisms remain identical.

---

## Resolved Questions (from v1/v2 Open Questions)

1. **Message retention policy**: ✅ Defined per-type retention periods (see Message Type Semantics). Cleanup job runs hourly. Drop/outbound GC added in v3.

2. **Dashboard integration**: Deferred to post-Phase 1. Design hooks in place (message events can be pushed via WebSocket).

3. **Human-in-the-loop**: For v1, agent-to-agent communication is fully autonomous. Critical/alert messages that expire are escalated to Telegram. Future: configurable human-approval gates for cross-agent requests.

4. **Message format evolution**: ✅ `schemaVersion` field in `MessageEnvelope`. Forward compatibility via ignoring unknown fields. Reject higher versions than supported.

5. **Encryption at rest**: For v1, filesystem permissions are sufficient (single-owner machines). Multi-tenant encryption is a Phase 7+ concern with the tenant isolation work.

6. **Multi-tenant isolation**: ✅ Design hooks documented (per-user namespaces, tenant ID). Enforcement deferred to Phase 7+.

7. **Observability**: ✅ Full metrics via `/api/messages/stats`. Alerting rules defined. CLI tracing tools specified.

8. **Skill vs hook**: ✅ `/msg` is a skill. Reasoning: richer validation, server-side security checks, anti-injection controls. See Phase 1: `/msg` Command Handling.

9. **Delivery state machine consistency** (v2→v3): ✅ `DeliveryPhase` type now includes `queued`. `BroadcastState` separated with `aggregate` field for `partial`/`complete` tracking. Full valid transitions table defined.

10. **Relay endpoint disambiguation** (v2→v3): ✅ Split into `/relay-agent` (Bearer token, same-machine) and `/relay-machine` (Machine-HMAC + Ed25519, cross-machine) with explicit auth matrix.

11. **Clock skew / timestamp tolerance** (v2→v3): ✅ Per-transport-type policies replace the blanket 30-second window. NonceStore specification added with generation, storage, retention, partitioning, and persistence rules.

12. **Signature scope** (v2→v3): ✅ Signatures now cover `SignedPayload` (message + relayChain + originServer + nonce + timestamp), not just the message body. Canonical JSON (JCS / RFC 8785) required for cross-runtime determinism.

13. **Drop directory integrity** (v2→v3): ✅ Same-machine drops require HMAC-SHA256. Directory ownership enforcement. GC policy for drop/ and outbound/. Ingest-and-delete with dead-letter for failures.

14. **Tmux injection safety** (v2→v3→v3.1): ✅ Per-session FIFO mutex, human-input collision detection (`hasActiveHumanInput`), large payload delivery via temp files with path reference. v3.1: switched from process blocklist to whitelist (only inject when shell is foreground), added post-injection crash watchdog (regress to `queued` if session dies within 10s), clarified `delivered` = "injected into tmux buffer" not "session processed it".

15. **Code snippet alignment** (v3→v3.1): ✅ Relay function now signs full `SignedPayload` (not just `message`), uses correct endpoints (`/relay-machine` vs `/relay-agent`), distinguishes auth types (Machine-HMAC vs Bearer token). Message flow diagram updated.

16. **Broadcast semantics** (v3→v3.1): ✅ Per-message `delivery.phase` no longer tracks broadcast aggregate progress. `broadcastState.aggregate` (`pending|partial|complete|failed`) is the exclusive mechanism for broadcast progress. Added `GET /api/messages/broadcast/{id}/status` endpoint. Eager aggregation for `critical` priority.

17. **Drop directory HMAC scope** (v3→v3.1): ✅ HMAC now covers `{message, originServer, nonce, timestamp}` — not just message body — preventing routing metadata tampering.
