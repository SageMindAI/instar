# Instar User-Agent Topology Specification

> Comprehensive mapping of all user-machine-agent deployment scenarios, with support status, UX design, and implementation gaps.

**Status**: Draft v1
**Author**: Dawn (with Justin's direction)
**Date**: 2026-03-01
**Related specs**: MULTI-MACHINE-SPEC.md, MULTI-USER-SETUP-SPEC.md

---

## Table of Contents

1. [Overview](#overview)
2. [Terminology](#terminology)
3. [Topology Variables](#topology-variables)
4. [Scenario Matrix](#scenario-matrix)
5. [Scenario Details](#scenario-details)
   - [Scenario 1: Single User, Single Machine, Global Agent](#scenario-1)
   - [Scenario 2: Single User, Two Machines, Global Agent](#scenario-2)
   - [Scenario 3: Single User, Single Machine, Repo Agent](#scenario-3)
   - [Scenario 4: Single User, Two Machines, Repo Agent](#scenario-4)
   - [Scenario 5: Multiple Users, Single Machine, Repo Agent](#scenario-5)
   - [Scenario 6: Multiple Users, Two Machines, Repo Agent](#scenario-6)
   - [Scenario 7: Multiple Users, Two Machines, Global Agent](#scenario-7)
   - [Scenario 8: Multiple Users, Single Machine, Global Agent](#scenario-8)
   - [Scenario 9: Cross-Machine User Access](#scenario-9)
6. [Multi-Machine Perspectives](#multi-machine-perspectives)
7. [User Identity Pipeline](#user-identity-pipeline)
8. [Implementation Gaps](#implementation-gaps)
9. [Phase Plan](#phase-plan)

---

## Overview

Instar agents can be deployed in many configurations: standalone or project-bound, single or multi-user, single or multi-machine. Each combination creates a distinct "topology" with its own UX, infrastructure requirements, and coordination needs.

This spec maps every realistic topology, documents what works today, identifies gaps, and defines the implementation path to full support.

### Why This Spec Exists

During a design review (2026-03-01), we identified that the multi-machine spec (MULTI-MACHINE-SPEC.md) assumes a single deployment topology: active/standby with one Telegram group. Real-world usage includes scenarios where:

- Multiple users talk to the same agent on the same machine
- Multiple users talk to the same agent on different machines, each through a different Telegram group
- A user can be a member of multiple Telegram groups (cross-machine access)
- Users may or may not care which machine is handling their messages

This spec addresses all of these scenarios comprehensively.

---

## Terminology

| Term | Definition |
|------|-----------|
| **Agent** | The logical entity — its personality, knowledge, jobs, relationships. Defined by the `.instar/` directory contents. |
| **Instance** | A running process of an agent on a specific machine. One agent can have multiple instances. |
| **Machine** | A physical or virtual computer running an Instar instance. Identified by a cryptographic keypair. |
| **Global agent** (standalone) | Agent installed at `~/.instar/agents/<name>/`. Not tied to a specific project repository. Created via `instar init --standalone`. |
| **Repo agent** (project-bound) | Agent installed inside a project at `<project>/.instar/`. Tied to a specific codebase. Created via `instar init`. |
| **Telegram group** | A Telegram supergroup with forum topics enabled. Each group has a unique `chatId`. |
| **Topic** | A thread within a Telegram forum group. Used for sessions, jobs, dashboards, etc. |
| **Awake** | The active instance — polls Telegram, runs jobs, writes state. |
| **Standby** | A passive instance — send-only Telegram, no scheduler, read-only state. |
| **Multi-active** | A proposed mode where multiple instances are awake simultaneously, each serving different Telegram groups. |

---

## Topology Variables

Every deployment is described by four independent axes:

### Axis 1: Installation Type

| Type | Location | Git sync | Config sharing |
|------|----------|----------|----------------|
| **Standalone (global)** | `~/.instar/agents/<name>/` | Optional git backup to private GitHub repo | `config.json` is gitignored — machine-local |
| **Project-bound (repo)** | `<project>/.instar/` | Via the project's existing git repo | `config.json` committed to repo — shared by default |

**Key difference for multi-machine**: Standalone agents gitignore `config.json`, so each machine naturally has its own messaging config (different `chatId`). Project-bound agents share `config.json` via git, so all machines get the same `chatId` unless explicitly overridden.

### Axis 2: Number of Users

| Count | Mechanism |
|-------|-----------|
| **Single** | One user in `users.json`. All messages assumed to be from this user. |
| **Multiple** | Multiple users in `users.json`. Each identified by Telegram user ID. |

### Axis 3: Number of Machines

| Count | Coordination |
|-------|-------------|
| **Single** | No coordination needed. Instance is always awake. |
| **Multiple (active/standby)** | One awake, rest standby. Heartbeat-based failover. Current model. |
| **Multiple (multi-active)** | All instances awake, each serving a different Telegram group. Proposed new model. |

### Axis 4: Telegram Topology

| Pattern | Description |
|---------|------------|
| **Single group** | One Telegram forum group. All users and all machines share it. |
| **Group per machine** | Each machine has its own Telegram forum group. Users know which machine they're messaging. |
| **Group per machine with cross-access** | Each machine has its own group, but users can be members of multiple groups. |

---

## Scenario Matrix

| # | Users | Machines | Install | TG Groups | Status | Key Gap |
|---|-------|----------|---------|-----------|--------|---------|
| 1 | 1 | 1 | Global | 1 | **Supported** | — |
| 2 | 1 | 2 | Global | 1 or 2 | **Supported** (active/standby) | Multi-active mode for 2 groups |
| 3 | 1 | 1 | Repo | 1 | **Supported** | — |
| 4 | 1 | 2 | Repo | 1 or 2 | **Supported** (active/standby) | Multi-active mode for 2 groups |
| 5 | 2+ | 1 | Repo | 1 | **Supported** | User identity in session bootstrap |
| 6 | 2+ | 2 | Repo | 2 | **Partial** | Multi-active coordinator + config override |
| 7 | 2+ | 2 | Global | 2 | **Partial** | Multi-active coordinator |
| 8 | 2+ | 1 | Global | 1 | **Supported** | User identity in session bootstrap |
| 9 | 2+ | 2+ | Any | 2+ | **Partial** | Cross-group user resolution |

---

## Scenario Details

<a name="scenario-1"></a>
### Scenario 1: Single User, Single Machine, Global Agent

**Status: FULLY SUPPORTED**

The simplest topology. One person installs an agent on their computer and talks to it through one Telegram group.

**Setup flow:**
1. User runs `npx instar` (or `instar init --standalone my-agent`)
2. Setup wizard creates the agent at `~/.instar/agents/my-agent/`
3. User provides Telegram bot token and group chatId (or wizard creates them)
4. Agent starts, polls Telegram, responds to messages

**Telegram topology:**
```
Telegram Group "My Agent"
  ├── Topic: Lifeline (always-on supervision)
  ├── Topic: Dashboard (status updates)
  ├── Topic: General (default conversation)
  └── Topic: <session-N> (auto-created per session)
```

**User experience:**
- User messages in any topic → agent responds in the same topic
- Sessions auto-create topics for isolation
- No coordination, no sync, no complexity

**What works:** Everything. This is the standard Instar use case.

---

<a name="scenario-2"></a>
### Scenario 2: Single User, Two Machines, Global Agent (Same Agent)

**Status: SUPPORTED (active/standby)**

One person has the same agent on two machines (e.g., work laptop and home desktop). The agent syncs state between machines via git backup.

**Setup flow:**
1. Machine A: `instar init --standalone my-agent` with cloud backup enabled
2. Machine B: `instar join <git-repo-url>` clones the agent
3. Both machines generate unique keypairs, register in machine registry
4. Heartbeat determines which is awake

**Sub-scenario 2a — Shared Telegram group (active/standby):**
```
Machine A (awake)  ─── polls ──→  Telegram Group
Machine B (standby) ── send-only ──→  Telegram Group
```
- One group, one bot. Only the awake machine polls.
- User messages go to whichever machine is awake.
- Failover: if Machine A's heartbeat expires (15 min), Machine B promotes to awake.
- **Status: SUPPORTED** — this is the existing multi-machine model.

**Sub-scenario 2b — Separate Telegram groups (multi-active):**
```
Machine A (awake)  ─── polls ──→  TG Group "Agent @ Work"
Machine B (awake)  ─── polls ──→  TG Group "Agent @ Home"
```
- Different groups, same bot token (bot is member of both) OR different bot tokens.
- Both machines can be awake simultaneously since there's no polling conflict.
- User chooses which group to message based on which machine they want.
- **Status: PARTIAL** — needs multi-active coordinator mode (see [Implementation Gaps](#implementation-gaps)).

**What syncs via git:** AGENT.md, USER.md, MEMORY.md, users.json, jobs.json, machine registry, hooks
**What stays local:** config.json (port, chatId, monitoring), state/, logs/

---

<a name="scenario-3"></a>
### Scenario 3: Single User, Single Machine, Repo Agent

**Status: FULLY SUPPORTED**

Agent lives inside a project repository. The standard development-assistant use case.

**Setup flow:**
1. Inside project directory: `instar init`
2. Agent configured in `.instar/` within the project
3. Agent understands the project's codebase, runs project-specific jobs

**Telegram topology:** Same as Scenario 1.

**What works:** Everything. This is the original Instar use case.

---

<a name="scenario-4"></a>
### Scenario 4: Single User, Two Machines, Repo Agent

**Status: SUPPORTED (active/standby)**

Same project repo on two machines (e.g., cloned on work and home computers). Agent state is part of the repo.

**Setup flow:**
1. Machine A: `instar init` in the project (already done)
2. Machine B: Clone the repo, run `instar pair` to register the machine
3. Multi-machine coordination activates

**Key difference from Scenario 2:** Config is committed to git (not gitignored), so both machines share the same `chatId` by default. This naturally fits the active/standby model with a shared Telegram group.

**For separate Telegram groups:** Would need a machine-local config override mechanism (e.g., `.instar/config.local.json` that is gitignored and merges over `config.json` at runtime). See [Implementation Gaps](#implementation-gaps).

**Sub-scenarios 4a (shared group) and 4b (separate groups):** Same as Scenario 2a/2b.

---

<a name="scenario-5"></a>
### Scenario 5: Multiple Users, Single Machine, Repo Agent

**Status: SUPPORTED (with identity pipeline gaps)**

Two or more people interact with one agent running on one machine, through a shared Telegram group.

**Setup flow:**
1. Primary user: `instar init` and configures the agent
2. Primary user adds additional users via setup wizard or `users.json`
3. Additional users are added to the Telegram group
4. Agent resolves each user by their Telegram user ID

**Telegram topology:**
```
Telegram Group "Team Agent"
  ├── Topic: Lifeline
  ├── Topic: Dashboard
  ├── Topic: General ← Justin and Adri both post here
  ├── Topic: Code Review ← Both users can post
  └── Topic: <session-N> ← Sessions may be user-specific or shared
```

**How user identification works:**
- Every Telegram message includes the sender's numeric user ID and first name
- The TelegramAdapter extracts this into message metadata (`telegramUserId`, `firstName`)
- For active sessions, messages are tagged: `[telegram:42 "General" from Justin]`
- The agent sees who sent each message regardless of which topic they post in

**User experience:**
- Multiple users can post in the same topic — works like Slack
- The agent addresses each user by name in responses
- Users can have different permissions (admin, user) and preferences (communication style, timezone)
- Sessions can be user-scoped or shared depending on how the agent manages them

**Known gaps (see [User Identity Pipeline](#user-identity-pipeline)):**
1. Session bootstrap messages lack sender name — first message in a new session doesn't identify who triggered it
2. TopicMemory (SQLite) stores `fromUser: boolean` not actual sender name — history replay loses identity
3. UserManager is not consulted during message routing — rich profile data (preferences, permissions) isn't injected into session context

---

<a name="scenario-6"></a>
### Scenario 6: Multiple Users, Two Machines, Repo Agent

**Status: PARTIAL — key gaps exist**

This is the "Luna scenario" — the motivating use case for this spec. Two users, two machines, each machine has its own Telegram group. The agent is project-bound (lives in a shared repo).

**Example:** Justin talks to Luna on his machine via TG Group A. Adriana talks to Luna on her machine via TG Group B. Luna knows about both users and maintains relationships with each.

**Setup flow:**
1. Machine A (Justin): `instar init` in the shared project repo
2. Machine B (Adriana): Clone the repo, `instar pair` to register
3. Each machine configures its own Telegram group (different `chatId`)
4. Both machines run as multi-active (not active/standby)
5. Agent state syncs via git (users.json, relationships, MEMORY.md)

**Telegram topology:**
```
Machine A (Justin's laptop):
  TG Group "Luna @ Justin's"
    ├── Topic: Lifeline
    ├── Topic: General ← Justin messages here
    └── Topic: <session-N>

Machine B (Adriana's laptop):
  TG Group "Luna @ Adriana's"
    ├── Topic: Lifeline
    ├── Topic: General ← Adriana messages here
    └── Topic: <session-N>
```

**What must work:**
- Both machines are awake simultaneously — no active/standby
- Each machine polls only its own Telegram group — no polling conflict
- Agent identity is shared: personality, knowledge, relationships are the same Luna
- State syncs via git: when Luna learns something on Machine A, Machine B eventually gets it
- User context: Machine A knows messages are from Justin; Machine B knows messages are from Adriana
- Jobs can run on either machine (or one designated machine) — no double-execution

**What's missing (must be built):**

1. **Multi-active coordinator mode**: The current `MultiMachineCoordinator` forces active/standby. Need a third mode (`multi-active`) where multiple machines are awake simultaneously. Each machine polls its own Telegram group, runs its own sessions, and writes state. The coordinator's role shifts from role-assignment to state-sync orchestration.

2. **Machine-local config override for repo agents**: For project-bound agents, `config.json` is committed to git. Both machines get the same `chatId`. Need a `.instar/config.local.json` (gitignored) that merges over `config.json` at runtime, allowing each machine to specify its own messaging config while sharing everything else.

3. **Job coordination in multi-active**: Both machines have the scheduler running. Need to prevent double-execution. Options:
   - Job affinity: each job assigned to a specific machine in `jobs.json`
   - Leader election: one machine is the "job leader" even if both are active for Telegram
   - Lock-based: jobs acquire a git-based or file-based lock before executing

4. **State merge strategy**: When both machines write state concurrently, git sync needs a merge strategy. Relationship data and MEMORY.md can have merge conflicts. Need either:
   - Field-level merge (already designed in MULTI-MACHINE-SPEC Phase 3)
   - Last-writer-wins with conflict detection and notification
   - Append-only formats (JSONL) where possible to avoid conflicts

5. **User identity pipeline fixes**: Same gaps as Scenario 5, but more critical because each machine primarily serves one user and needs to know who it's talking to from the first message.

---

<a name="scenario-7"></a>
### Scenario 7: Multiple Users, Two Machines, Global Agent

**Status: PARTIAL — same gaps as Scenario 6**

Same as Scenario 6 but with a standalone (global) agent instead of a project-bound one.

**Key difference:** Standalone agents with git backup already gitignore `config.json`. Each machine naturally has its own messaging config. This eliminates Gap #2 from Scenario 6 (no need for `config.local.json`).

**Setup flow:**
1. Machine A: `instar init --standalone luna` with cloud backup
2. Machine B: `instar join <git-repo-url>`
3. Each machine has its own `config.json` with its own `chatId`
4. Both machines run multi-active

**Remaining gaps:** Same as Scenario 6 minus the config override (#2): multi-active coordinator (#1), job coordination (#3), state merge (#4), user identity (#5).

---

<a name="scenario-8"></a>
### Scenario 8: Multiple Users, Single Machine, Global Agent

**Status: SUPPORTED (with identity pipeline gaps)**

Same as Scenario 5 but with a standalone agent. Multiple users, one machine, one Telegram group.

**What works:** Everything from Scenario 5 applies identically. The global vs repo distinction doesn't affect multi-user on a single machine.

**Same gaps as Scenario 5:** Session bootstrap identity, TopicMemory sender names, UserManager routing integration.

---

<a name="scenario-9"></a>
### Scenario 9: Cross-Machine User Access

**Status: SUPPORTED at the Telegram level**

A user is a member of multiple Telegram groups (across machines). For example, Justin is in both "Luna @ Justin's" and "Luna @ Adriana's" — he can talk to Luna on either machine.

**How it works:** When Justin messages in Adriana's Telegram group, the bot on Adriana's machine receives the message. The message includes Justin's Telegram user ID. The UserManager (once wired into routing) resolves Justin's profile from `users.json`. The session knows it's talking to Justin even though the message came through Adriana's group.

**UX:**
- Justin opens "Luna @ Adriana's" in Telegram
- Sends a message in any topic
- Luna on Adriana's machine responds, addressing Justin by name
- Luna's responses are contextual to Justin's relationship and preferences

**What works:**
- Telegram natively includes sender identity on every message
- `users.json` is shared via git — both machines know about both users
- Bot can be in multiple groups simultaneously

**What needs attention:**
- If Justin messages in Adriana's group, should that session's context include Justin's history from his own machine? This requires cross-machine relationship/memory sync (git handles this if sync is frequent enough).
- Topic naming: if both groups have a "General" topic, session isolation needs to account for which group the message came from (it does — `chatId` is part of the routing).

---

## Multi-Machine Perspectives

Two fundamentally different UX models for multi-machine deployments:

### Perspective A: Machine-Aware (Near-Term Target)

The user knows which machine they're talking to. Each machine has its own Telegram group. The user chooses which group to message.

```
┌─────────────────┐       ┌─────────────────┐
│  TG Group A     │       │  TG Group B     │
│  "Agent @ Work" │       │  "Agent @ Home" │
└────────┬────────┘       └────────┬────────┘
         │                         │
         ▼                         ▼
┌─────────────────┐       ┌─────────────────┐
│  Machine A      │       │  Machine B      │
│  (awake)        │◄─git─►│  (awake)        │
│  polls Group A  │ sync  │  polls Group B  │
└─────────────────┘       └─────────────────┘
```

**Advantages:**
- Simple — each machine is nearly independent
- No message routing infrastructure needed
- User has explicit control over which machine handles their work
- Natural fit for "work machine" / "home machine" / "partner's machine" patterns

**Disadvantages:**
- User must know which group to message
- If a machine is down, user must switch to the other group manually
- Agent state may lag between machines (git sync interval)

**Implementation effort:** LOW — mostly adding multi-active mode to the coordinator

### Perspective B: Machine-Abstracted (Future Vision)

The user doesn't know or care which machine handles their message. One Telegram group, infrastructure routes to the available machine.

```
┌─────────────────┐
│  TG Group       │
│  "My Agent"     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Message Relay  │
│  (routing layer)│
└───┬─────────┬───┘
    │         │
    ▼         ▼
┌────────┐ ┌────────┐
│ Mach A │ │ Mach B │
│(active)│ │(active)│
└────────┘ └────────┘
```

**Advantages:**
- Seamless UX — user just talks to "the agent"
- Automatic failover invisible to user
- Load distribution possible

**Disadvantages:**
- Requires a relay service (Telegram webhook → routing layer → machine)
- Needs session affinity (once a conversation starts on Machine A, keep it there)
- Real-time state sync required (not just periodic git)
- Significantly more complex infrastructure

**Implementation effort:** HIGH — new relay service, webhook mode, session affinity, real-time sync

**Recommendation:** Build Perspective A now. Design Perspective B's interfaces so migration is possible later. The relay layer could be added as an optional component without changing the core architecture.

---

## User Identity Pipeline

### Current State

```
Telegram Message
  ├── from.id (numeric user ID) ✅ extracted
  ├── from.first_name ✅ extracted
  └── from.username ✅ extracted
        │
        ▼
TelegramAdapter.processMessage()
  └── Message.metadata = { telegramUserId, firstName, username } ✅
        │
        ▼
messageToPipeline()
  └── PipelineMessage.sender = { telegramUserId, firstName, username } ✅
        │
        ├──► Existing session: injectTelegramMessage()
        │    └── Tagged: [telegram:42 "topic" from Justin] ✅
        │
        └──► New session: spawnSessionForTopic()
             └── Bootstrap: [telegram:42] message ❌ NO SENDER NAME
```

### Gaps

| Gap | Impact | Fix |
|-----|--------|-----|
| **Session bootstrap lacks sender** | New sessions don't know who triggered them | Include `from {firstName}` in bootstrap message tag |
| **TopicMemory drops sender names** | History replay says "User" not "Justin" | Add `senderName` column to SQLite schema; store on every message |
| **UserManager not in routing path** | Rich profile data (permissions, preferences, communication style) never reaches sessions | Call `UserManager.resolveFromMessage()` in the routing pipeline; inject profile context |
| **No user context in session prompt** | Agent can't adapt behavior per user | Build user context block from UserProfile and inject into session bootstrap |

### Target State

```
Telegram Message
        │
        ▼
TelegramAdapter.processMessage()
  └── Message with full metadata ✅
        │
        ▼
UserManager.resolveFromMessage()  ← NEW: called on every message
  └── Returns UserProfile { id, name, permissions, preferences, channels }
        │
        ▼
messageToPipeline()
  └── PipelineMessage with sender + resolved UserProfile
        │
        ├──► Existing session: injectTelegramMessage()
        │    └── Tagged: [telegram:42 "topic" from Justin] ✅ (unchanged)
        │
        └──► New session: spawnSessionForTopic()
             ├── Bootstrap: [telegram:42 from Justin] message ← FIXED
             ├── User context block injected into prompt ← NEW
             └── History with real sender names ← FIXED
```

---

## Implementation Gaps

Summary of all gaps across scenarios, deduplicated and prioritized.

### Gap 1: Multi-Active Coordinator Mode (Scenarios 2b, 4b, 6, 7)

**What:** The `MultiMachineCoordinator` enforces active/standby. When machines have separate Telegram groups, there's no polling conflict — both can be awake.

**Change:** Add a `coordinationMode` config option:
- `active-standby` (default, current behavior) — one awake, rest standby
- `multi-active` — all machines awake, each polls its own Telegram group

In `multi-active` mode:
- All machines run schedulers (with job coordination — see Gap 3)
- All machines poll their own Telegram group
- All machines write state (with sync — see Gap 4)
- Heartbeat still runs (for health monitoring, not role assignment)

**Files affected:** `MultiMachineCoordinator.ts`, `server.ts` (startup gating), `HeartbeatManager.ts`

### Gap 2: Machine-Local Config Override (Scenario 4b, 6)

**What:** For project-bound agents, `config.json` is shared via git. Need machine-specific overrides for messaging config.

**Change:** Support `.instar/config.local.json` (gitignored). At runtime, `loadConfig()` deep-merges `config.local.json` over `config.json`. This allows each machine to override `messaging[].config.chatId` while sharing everything else.

**Auto-setup:** When `instar pair` detects a different Telegram group is needed, it creates `config.local.json` with the machine's messaging config and adds it to `.gitignore`.

**Files affected:** `Config.ts` (`loadConfig()`), `init.ts` (gitignore template), `pair` command

### Gap 3: Job Coordination in Multi-Active (Scenarios 6, 7)

**What:** When both machines run schedulers, jobs would execute twice.

**Change:** Add `machineAffinity` field to job definitions:
```json
{
  "slug": "daily-summary",
  "machineAffinity": "any" | "<machineId>" | "primary"
}
```
- `any` (default for single-machine) — runs on any awake machine
- `<machineId>` — runs only on the specified machine
- `primary` — runs on the machine designated as primary in the registry

The scheduler checks affinity before executing. In `active-standby` mode, affinity is ignored (only the awake machine has a scheduler).

**Files affected:** `JobScheduler.ts`, `types.ts` (job schema), `jobs.json` template

### Gap 4: State Merge Strategy (Scenarios 6, 7)

**What:** When both machines write state concurrently, git sync can produce conflicts.

**Current design (MULTI-MACHINE-SPEC Phase 3):** Field-level merge for relationships, append-only for JSONL logs, last-writer-wins for simple state files.

**Additional needs for multi-active:**
- Sync frequency: increase from periodic to event-driven (sync after session completion, job completion, relationship update)
- Conflict notification: when a merge conflict occurs, notify both machines via Telegram
- MEMORY.md: append-only sections with per-machine markers, consolidated periodically by a job

**Files affected:** `GitSyncManager.ts`, `SyncOrchestrator.ts`

### Gap 5: User Identity in Sessions (Scenarios 5, 6, 7, 8)

**What:** Session bootstrap messages and history replay don't identify the sender.

**Changes:**
1. `spawnSessionForTopic()`: include `from {firstName}` in the bootstrap tag
2. `TopicMemory` SQLite schema: add `senderName TEXT` column
3. `TopicMemory.recordMessage()`: store sender name on every message
4. `TopicMemory.formatContextForSession()`: use actual sender names in history
5. `wireTelegramRouting()`: call `UserManager.resolveFromMessage()` and pass profile to session

**Files affected:** `server.ts`, `TopicMemory.ts`, `SessionManager.ts`, `UserManager.ts`

---

## Phase Plan

### Phase 1: User Identity Pipeline (Prerequisite for all multi-user scenarios)

**Scope:** Fix all five items in Gap 5.

**Scenarios unlocked:** 5, 8 become fully supported. 6, 7, 9 get better identity handling.

**Effort:** Small — wiring changes, one schema migration, no new systems.

### Phase 2: Machine-Local Config Override (Prerequisite for repo multi-machine)

**Scope:** Implement Gap 2 (`config.local.json` support).

**Scenarios unlocked:** 4b, 6 can have per-machine Telegram groups.

**Effort:** Small — one function change in `loadConfig()`, gitignore update.

### Phase 3: Multi-Active Coordinator (Core of multi-machine multi-user)

**Scope:** Implement Gap 1 (multi-active mode) and Gap 3 (job coordination).

**Scenarios unlocked:** 2b, 4b, 6, 7 with both machines fully active.

**Effort:** Medium — coordinator mode logic, scheduler affinity, testing.

### Phase 4: Enhanced State Sync (Robustness for multi-active)

**Scope:** Implement Gap 4 (event-driven sync, conflict handling).

**Scenarios unlocked:** All multi-machine scenarios become more robust.

**Effort:** Medium — sync triggers, conflict detection, notification wiring.

### Phase 5: Machine-Abstracted Routing (Future — Perspective B)

**Scope:** Message relay service, Telegram webhook mode, session affinity, real-time state sync.

**Scenarios unlocked:** Users can talk to "the agent" without knowing which machine handles their message.

**Effort:** Large — new infrastructure component, webhook integration, affinity routing.

**Deferred until:** Perspective A is production-proven and the UX gain of abstraction is validated by real usage.

---

## Open Questions

1. **Bot tokens for multi-active:** Should each machine's Telegram group use the same bot (added to multiple groups) or different bots? Same bot is simpler (one identity) but only if polling is per-group. Different bots mean different agent identities on Telegram.

2. **Relationship continuity:** When Justin talks to Luna on Machine A and then messages Luna on Machine B (via cross-access), should Machine B have the full conversation context from Machine A? Git sync gives eventual consistency, but the delay could cause disorienting UX.

3. **Job output routing:** When a job runs on Machine A, should its output be visible in Machine B's Telegram group? Currently, job output goes to a topic in the local machine's group.

4. **Session handoff:** If a user starts a conversation on Machine A and wants to continue on Machine B, is there a mechanism for session migration? Or does the user just start a new session on Machine B with shared relationship/memory context?

5. **Scaling beyond 2 machines:** The matrix covers 2 machines. Does the architecture generalize to N machines without changes? Multi-active with N machines means N Telegram groups, N schedulers (with affinity), and N-way git sync.
