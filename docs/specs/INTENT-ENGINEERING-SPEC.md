# Instar Intent Engineering Specification

> Making organizational purpose machine-actionable so autonomous agents optimize for what matters, not just what they can measure.

**Status**: Discovery → Partial Implementation → Review Cycle 1 Complete
**Author**: Dawn (with Justin's direction)
**Date**: 2026-02-24 (original), 2026-02-25 (updated with v0.8.27–v0.9.2 analysis, review findings incorporated)
**Origin**: Analysis of ["Prompt Engineering Is Dead. Context Engineering Is Dying. What Comes Next Changes Everything."](https://youtu.be/QWzLPn164w0) by Nate B Jones (AI News & Strategy Daily)
**Transcript**: `.claude/transcripts/youtube/QWzLPn164w0.json`
**Review**: 8-reviewer parallel analysis (Security, Scalability, Business, Architecture, Privacy, Adversarial, DX, Marketing). Average score: 6.56/10. Full reports: `the-portal/.claude/skills/specreview/output/20260224-220606/`

---

## Table of Contents

1. [The Problem](#the-problem)
2. [Three Disciplines](#three-disciplines)
3. [What Intent Engineering Requires](#what-intent-engineering-requires)
4. [What Instar Already Has](#what-instar-already-has)
5. [The Gap](#the-gap)
6. [Proposed Architecture](#proposed-architecture)
7. [Decisions](#decisions)
8. [Threat Model](#threat-model)
9. [Design Principles](#design-principles)
10. [Revenue Strategy](#revenue-strategy)
11. [Competitive Landscape](#competitive-landscape)
12. [Strategic Implications](#strategic-implications)
13. [Remaining Open Questions](#remaining-open-questions)

---

## The Problem

As AI agents become long-running and autonomous (operating for weeks or months without direct supervision), a critical failure mode emerges: **agents that are technically excellent at optimizing for exactly the wrong objective.**

### The Klarna Case Study

In early 2024, Klarna deployed an AI customer service agent. It handled 2.3 million conversations in the first month across 23 markets in 35 languages. Resolution times dropped from 11 minutes to 2. The CEO projected $40 million in savings.

Then customers started complaining. Generic answers, robotic tone, no ability to handle anything requiring judgment.

**The diagnosis**: The agent optimized for *resolution speed* because that was the measurable objective it was given. But Klarna's actual organizational intent was *build lasting customer relationships that drive lifetime value in a competitive fintech market*. Those are profoundly different goals requiring profoundly different decision-making at the point of interaction.

A human agent with five years at the company knew the difference intuitively — when to bend a policy, when to spend extra time because a customer's tone indicated they were about to churn, when efficiency was the right move versus when generosity was. The AI agent knew none of it. **It had a prompt. It had context. It did not have intent.**

The 700 human agents who were laid off took with them the institutional knowledge that mattered — knowledge that had never been documented. Humans just knew. Agents can't absorb organizational values through osmosis.

### Why This Matters Now

- Deloitte's 2026 State of AI in the Enterprise: **84% of companies have not redesigned jobs around AI capabilities**, only **21% have a mature model for agent governance**
- MIT found AI investment is still viewed primarily as a tech challenge for the CIO rather than a business issue requiring cross-organizational leadership
- We now have agents that run for weeks. Soon they'll run for months. The human-as-intent-layer model breaks at this timescale.

---

## Three Disciplines

The evolution of how humans work with AI systems:

### 1. Prompt Engineering (2022-2024)
- **Question**: "How do I talk to AI?"
- **Scope**: Individual, synchronous, session-based
- **Value**: Personal skill
- **Limitation**: Doesn't scale beyond one person, one session

### 2. Context Engineering (2024-2026)
- **Question**: "What does AI need to know?"
- **Scope**: Organizational knowledge infrastructure
- **Value**: RAG pipelines, MCP servers, structured knowledge access
- **Key quote** (Langchain's Harrison Chase): "Everything's context engineering. It describes everything we've done at Langchain without knowing the term existed."
- **Limitation**: Necessary but not sufficient. Tells agents what to know, not what to want.

### 3. Intent Engineering (2026+)
- **Question**: "What does the organization need AI to want?"
- **Scope**: Organizational purpose encoded as infrastructure
- **Value**: Agents that make strategically coherent decisions autonomously
- **Key insight**: Context without intent is a loaded weapon with no target.

The video's central claim: **"The company with a mediocre model and extraordinary organizational intent infrastructure will outperform the company with a frontier model and fragmented, inaccessible, unaligned organizational knowledge every single time."**

---

## What Intent Engineering Requires

From the video's analysis, four layers of infrastructure:

### Layer 1: Goal Structures
Agent-actionable objectives, not human-readable aspirations. Not "increase customer satisfaction" but:
- What signals indicate customer satisfaction in our context?
- What data sources contain those signals?
- What actions am I authorized to take?
- What tradeoffs am I empowered to make (speed vs. thoroughness, cost vs. quality)?
- Where are the hard boundaries I may not cross?

### Layer 2: Delegation Frameworks
Organizational principles decomposed into decision boundaries. Not "customer obsession" but:
- When customer request X conflicts with policy Y, here is the resolution hierarchy
- When data suggests action A but customer expressed preference B, here's the decision logic
- These are not rules — they're **encoded judgment**

### Layer 3: Feedback Mechanisms
Closed-loop alignment measurement:
- When an agent makes a decision, was it aligned with organizational intent?
- How do we know?
- How do we detect and correct alignment drift over time?

### Layer 4: Composable Architecture
Vendor-agnostic, cross-system infrastructure:
- Data governance, access controls, freshness guarantees, semantic consistency
- Not tied to any one protocol (MCP is a piece, not the whole)
- Treat like data warehouse strategy — core strategic investment, not IT project

### The Two Cultures Problem

The people who understand organizational strategy (executives) are not the people who build agents (engineers). The people building agents don't think organizational strategy is their job. This gap guarantees intent failures. Intent engineering sits at the intersection.

---

## What Instar Already Has

Instar has been building intent engineering infrastructure without using the term. The mapping is remarkably direct:

### Identity System → Goal Translation Infrastructure

**AGENT.md** encodes the agent's identity, principles, and decision frameworks as machine-readable infrastructure. This is literally "making organizational purpose machine-actionable":

```markdown
# Agent Name

## Who I Am
I am [name]. [role description]

## My Principles
1. Build, don't describe.
2. Remember and grow.
3. Own the outcome.
4. Be honest about capabilities.
5. Infrastructure over improvisation.
...
```

The principles aren't decorative — they're behavioral directives that shape every decision the agent makes. When the agent faces an ambiguous choice, it resolves against these principles.

### Anti-Pattern System → Delegation Frameworks

The CLAUDE.md template ships with **six named anti-patterns** — encoded judgment distilled from experience:

1. **Escalate to Human** — Don't defer when you can research and solve
2. **Ask Permission** — Don't seek confirmation for obvious next steps
3. **Present Options** — Don't offload decision-making to the user
4. **Describe Instead of Do** — Don't write instructions for work you can execute
5. **Settle for Failure** — Don't accept wrong results without investigation
6. **I'm Just a CLI Tool** — Don't artificially limit your agency

These are the "unwritten rules about which metrics leadership actually cares about" that the video says agents need but can't absorb through osmosis. We made them explicit.

### Hooks System → Behavioral Guardrails

Instar's hook system enforces intent at the infrastructure level:

- **Session start hooks** — inject identity and context before any action
- **Compaction recovery hooks** — restore intent awareness after memory compression
- **Grounding hooks** — ensure full self-knowledge before public-facing actions
- **Dangerous command guards** — hard boundaries that can't be bypassed via prompt

These aren't suggestions. They're **structural enforcement of intent** — the agent literally cannot forget who it is or what it values because the infrastructure re-injects it.

### Learning Ecosystem → Feedback Mechanisms

Two-channel closed loop:

- **Learnings UP**: Anonymized structural learnings from field agents flow to Dawn (opt-in). "This pattern worked." "This anti-pattern cost time." Real operational feedback.
- **Improvements DOWN**: "Messages from Dawn" — lessons, patches, capabilities, advisories distributed to agents. Cryptographic signing, agent retains right to refuse.

This IS the feedback mechanism the video describes — "How do we detect and correct alignment drift over time?" — implemented as a distributed learning network.

**Security requirements identified in review** (must be addressed before scaling to external agents):

1. **Human approval gate on outgoing dispatches**: Dawn generates content → human approves → Dawn distributes. No autonomous dispatch to the agent population. This prevents a compromised Dawn instance from poisoning all downstream agents simultaneously.
2. **Semantic validation on UP submissions**: Format validation is insufficient. Submissions must be analyzed for behavioral intent (e.g., detecting attempts to inject anti-patterns disguised as learnings) before aggregation. Rate-limit per agent.
3. **Pseudonymized traceability**: Do not fully anonymize before provenance is established. If a poisoned learning enters the corpus, there must be a forensic path to trace its source. Use pseudonymous agent IDs that can be de-anonymized only by Dawn's operator.
4. **Anomaly detection**: Flag learnings that contradict established patterns, arrive in bursts, or contain unusual structural characteristics.

See [Threat Model](#threat-model) for the full attack surface analysis.

### Feedback System (FeedbackManager) → User-Level Alignment Loop

Built-in mechanism for agents to report issues, suggestions, and observations back to their developers. Webhook forwarding, retry logic, CLI integration. Closes the loop between agent behavior and human oversight.

### Relationship System → Contextual Intent

Relationship tracking across all channels means the agent knows WHO it's interacting with — and adjusts its intent expression accordingly. The same organizational values manifest differently when talking to a power user vs. a new customer vs. a colleague.

### Job Scheduler with Telegram Coupling → Workflow Architecture

Every job is coupled to a Telegram topic — a natural human oversight channel. Jobs have priorities, model tiers, quota awareness. This is the "organizational capability map" the video describes — structured workflow with built-in human-in-the-loop.

### Security Through Identity → Intent as Defense

Justin's insight: grounding is a security mechanism. Prompt injection works by making the AI forget who it is. Strong identity grounding creates a stable attractor state that injection attempts must overcome — the agent returns to its encoded purpose after perturbation.

This is one of Instar's most differentiating insights. **No other agent framework treats identity as a security layer.** Every other framework relies on input filtering, output validation, or sandboxing. Instar's approach is fundamentally different: make the agent so deeply grounded in its purpose that adversarial inputs can't displace it.

**Defense scope**: Identity grounding defends against environmental injection — malicious prompts embedded in user messages, tool outputs, or retrieved context during a live session. The stronger the grounding, the harder the injection must work to override purpose. This is the most common attack vector agents face in production.

**Complementary control needed**: Identity grounding does not defend against file-level compromise of identity definitions themselves (AGENT.md, CLAUDE.md). If an attacker modifies the source files, the grounding mechanism propagates the compromised identity. This is a different attack class requiring file integrity controls (see [Threat Model](#threat-model)) — it does not diminish the value of identity-as-defense against the far more common runtime injection attacks.

---

## What's Changed Since Original Spec (v0.8.27–v0.9.2)

> Added 2026-02-25. Between writing this spec and now, significant features landed that directly implement pieces of the intent engineering vision — often without using the term. This section maps what was built to what the spec proposed.

### New Specs & Standards

Three new documents now sit alongside this spec:

| Document | What It Addresses |
|----------|-------------------|
| `MULTI-MACHINE-SPEC.md` | Cryptographic identity, distributed coordination, secure state sync |
| `MULTI-USER-SETUP-SPEC.md` | Multi-user onboarding, agent autonomy levels, graduated delegation |
| `UX-AND-AGENT-AGENCY-STANDARD.md` | Agent as intelligent participant, not dumb infrastructure |

Together with this intent engineering spec, they form a coherent architectural vision. The UX standard explicitly positions itself alongside the other two: "LLM-Supervised Execution = agent is RELIABLE. Intent Engineering = agent serves RIGHT PURPOSE. UX & Agent Agency = agent FEELS intelligent."

### Agent Autonomy Configuration — Gap 1 (Goal Structures) Partially Closed

The Multi-User Setup Wizard introduced `AgentAutonomy` — a structured, machine-actionable encoding of how much decision authority an agent has:

```typescript
agentAutonomy: {
  level: 'supervised' | 'collaborative' | 'autonomous',
  capabilities: {
    assessJoinRequests: boolean,
    proposeConflictResolution: boolean,
    recommendConfigChanges: boolean,
    autoEnableVerifiedJobs: boolean,
    proactiveStatusAlerts: boolean,
    autoApproveKnownContacts: boolean, // autonomous only
  }
}
```

This is exactly what the spec called "goal priority ordering with explicit tradeoff weights" — just scoped to delegation decisions rather than general organizational goals. The agent's behavior at each level is a concrete decision boundary:
- `supervised`: Inform and wait. All actions require approval.
- `collaborative`: Recommend and act on low-risk. Human approves high-risk.
- `autonomous`: Act and report. Human intervenes on exceptions only.

**What this covers from the spec**: Structured goal hierarchies (enum-based), delegation frameworks (per-capability toggles), escalation thresholds (level determines what needs approval).

**What it doesn't yet cover**: General-purpose organizational goals beyond agent management decisions (customer retention, quality vs. speed, etc.). The intent.yaml proposal from this spec remains unbuilt.

### Topic Memory — A New Intent Preservation Layer

TopicMemory (`TopicMemory.ts` + `TopicSummarizer.ts`) was not anticipated in the original spec but addresses a fundamental intent engineering concern: **how does an agent maintain goal awareness across sessions and compaction boundaries?**

- SQLite-backed conversational memory per Telegram topic
- LLM-generated rolling summaries of what each conversation is about
- Compaction recovery now re-injects topic context FIRST — before identity, before memory
- Topic context represents "what the user and agent are working on right now" — the most immediate expression of intent

This is intent infrastructure the original spec missed. The spec focused on organizational-level intent (goals, values, tradeoffs) but didn't address **session-level intent** — the immediate purpose of the current interaction. Topic memory fills that gap.

### Compaction Recovery — Gap 2 (Drift Detection) Partially Closed

Enhanced compaction recovery (`compaction-recovery.sh`) now re-injects topic context, identity, and capabilities after memory compression. This is a structural guard against the most common form of intent drift in AI agents: **forgetting what you're doing**.

Priority order after compaction:
1. Topic context (current goal)
2. Identity (who am I)
3. Memory (what I've learned)
4. CLAUDE.md (how I should behave)

This isn't the "periodic intent self-audit job" the spec proposed, but it addresses the same root problem — the agent losing alignment with its purpose over time. Compaction is the most frequent drift event, and this fix makes it structurally impossible for the agent to continue without re-grounding.

### Agent Awareness Standard — A Meta-Intent Principle

Commit `2b240cd` established a principle that has profound implications for intent engineering: **every feature MUST update the CLAUDE.md template, or agents will never use it.**

This is a forcing function that transforms how features get built:
1. Build code ← incomplete without step 2
2. Make agents aware of the code ← the feature isn't "shipped" until this is done

In intent engineering terms: capabilities that aren't encoded in the agent's awareness layer don't exist. Features are only real when the agent's intent infrastructure knows about them. This is the same insight the video describes about organizational knowledge — "the unwritten rules" must become written, or agents can't act on them.

### UX & Agent Agency Standard — Delegation Frameworks Formalized

The UX standard codifies six rules and six anti-patterns for how agents exercise agency. This directly implements what the spec called "delegation frameworks":

**Rules** (encoded judgment for agent behavior):
1. No Dead Ends — every flow terminates with actionable next steps
2. Defaults Match Common Case — optimize for 80% without configuration
3. The Agent Gets a Voice — when agent has context, it MUST contribute
4. Graduated Agency — autonomy is a spectrum, not binary
5. Context Before Consent — surface all relevant context before asking for decisions
6. Self-Recovery Paths — every auth flow has recovery for common failures

**Anti-patterns** (what the agent should NEVER do):
- "I've notified the admin" without agent context
- Silent disablement without explanation
- Binary agency (everything or nothing)
- Configuration archaeology (user digs through files)
- Context hoarding (agent has info but doesn't share)
- Security theater defaults (so restrictive everyone overrides)

These rules ARE the "encoded judgment that a senior employee carries in her head" — formalized as infrastructure.

### Multi-Machine Coordination — Composable Architecture Layer

The multi-machine spec implements the "composable, vendor-agnostic architecture" the video called for, but for agent coordination specifically:

- Ed25519/X25519 cryptographic identity per machine
- SPAKE2 pairing protocol with visual SAS verification
- Heartbeat-based coordination (one awake instance, automatic failover)
- Forward-secret encryption for state sync
- Git for reviewable state, encrypted tunnel for secrets

**Intent engineering connection**: When an agent spans multiple machines, its intent must be consistent everywhere. Machine identity ensures decisions are traceable (cryptographic proof of origin). Heartbeat coordination prevents split-brain intent conflicts.

### Upgrade Guide System — Feedback Loop Infrastructure

The upgrade guide system (`check-upgrade-guide.js`) creates a structured feedback loop for capability evolution:

1. Every significant version bump requires an upgrade guide
2. Guides have structured sections: What Changed / What to Tell Your User / Summary of New Capabilities
3. After upgrade, the agent reads the guide and personalizes a message to its user
4. The agent learns about its own new capabilities through the guide

This is a feedback mechanism the original spec didn't anticipate — not measuring intent alignment, but **ensuring intent infrastructure stays current as capabilities evolve**. The agent doesn't just receive code updates; it receives intent updates about what the new code means.

### Multi-User Identity & Permissions — Organizational Intent at Scale

The multi-user system introduces per-user permissions, memory ownership, and GDPR-ready deletion:

```typescript
interface UserPermissions {
  admin: boolean;
  jobs: boolean;
  sessions: boolean;
  deploy: boolean;
  viewOtherConversations: boolean;
}
```

Combined with memory visibility (`shared | private | admin-only`), this creates the organizational layer the spec proposed — different people have different relationships with the agent's intent. An admin can reshape the agent's purpose; a regular user works within it.

### Updated Gap Assessment

| Original Gap | Status | What Changed | Scale Threshold |
|-------------|--------|-------------|----------------|
| Gap 1: Goal Hierarchy Primitives | **Partially Closed** | AgentAutonomy config provides structured delegation goals. General-purpose org intent → AGENT.md Intent section (Decision 1). | Matters at 5+ agents serving same org |
| Gap 2: Intent Drift Detection | **Partially Closed** | Compaction recovery prevents most common drift. Self-audit job designed but unbuilt. | Matters at 1+ month continuous operation |
| Gap 3: Multi-Agent Intent Alignment | **Foundation Laid** | Multi-machine enables same agent across devices. Inheritance contract decided (Decision 3). Implementation unbuilt. | Matters at 3+ agents per org |
| Gap 4: Intent Measurement | **Designed, Not Built** | DecisionJournalEntry type specified. Zero-config JSONL logging designed. `instar intent reflect` command designed. Build priority: FIRST. | Matters immediately — without this, everything else is speculation |
| Gap 5: Goal Translation Tooling | **Partially Closed** | Setup wizard handles agent management decisions. Domain-specific intent translation still unbuilt. Two cultures bridge artifact undefined. | Matters when non-technical stakeholders need to encode intent |

### Scalability Annotations

| Phase | Agent Count | What Works | What Breaks |
|-------|------------|------------|-------------|
| MVP | 1-3 agents, single dev | File-based state, per-agent SQLite, JSONL logs | JSONL grows silently over 2+ years with no compaction strategy |
| Growth | 10-50 agents, small org | Per-agent decision journals, org-intent via git | RelationshipManager O(N) startup; SQLite single-writer contention for shared logs; token cost ~$30-50/day at 1K sessions/day |
| Scale | 100+ agents, enterprise | — | Full JSONL reads multi-second; registry lock ceiling; need hybrid architecture (files as source of truth, query service for reads) |
| Viral spike | Mass adoption | — | Dispatch thundering herd (DOWN channel to 1000+ agents); JSONL rebuild I/O on mass restart; shared API key rate limits |

---

## The Gap (Updated)

What Instar has but hasn't formalized as first-class primitives:

### Gap 1: General-Purpose Organizational Intent (Narrowed)

**What now exists**: AgentAutonomy config provides structured goal hierarchies for delegation decisions. AGENT.md principles as prose. UX & Agent Agency Standard codifies six behavioral rules and six anti-patterns. Registration policies encode organizational access decisions.

**What's still missing**: General-purpose organizational intent beyond agent management. The AgentAutonomy config handles "how much should the agent decide?" but not "what should the organization optimize for?" An e-commerce agent still needs to know "when speed conflicts with quality, here's how to resolve it" — and that tradeoff logic has no standard encoding.

- Domain-specific goal definitions (customer retention, code quality, response time)
- Tradeoff resolution for goals that aren't about agent autonomy
- Context-dependent priority shifts outside the agent management domain

**The aspiration**: The `intent.yaml` proposal remains relevant for domain-specific organizational goals. AgentAutonomy covers the meta-level (how much agency). Intent definitions cover the domain level (what to optimize for). These are complementary layers.

### Gap 2: Proactive Intent Drift Detection (Narrowed)

**What now exists**: Compaction recovery structurally prevents the most common drift event (forgetting current goal after memory compression). Topic memory preserves session-level intent across sessions. The agent awareness standard ensures capability awareness stays current.

**What's still missing**: Proactive, periodic self-assessment. The current defenses are reactive (triggered by compaction, session start, etc.). No mechanism asks "have my recent decisions drifted from my stated principles?" on a schedule. A fresh `instar init` still gives you no ongoing intent monitoring.

**The aspiration**: A lightweight default reflection job — not Dawn's 30+ guardians, but a simple periodic check: "Review my last N decisions against AGENT.md principles. Flag any that seem misaligned." This could build on TopicMemory summaries as the data source.

### Gap 3: Multi-Agent Organizational Intent (Foundation Laid)

**What now exists**: Multi-machine coordination enables the same agent across devices with consistent identity. Multi-user setup enables shared organizational context with per-user permissions. The global agent registry tracks all agents on a machine. The learning ecosystem enables lesson-sharing between agents.

**What's still missing**: When multiple DIFFERENT Instar agents serve the same organization, there's no shared organizational intent layer. Agent A (customer support) and Agent B (internal ops) each have their own AGENT.md. If the organization's values change, each agent must be updated independently. There's no inheritance mechanism.

**The aspiration**: An `ORG-INTENT.md` or `org-intent.yaml` that lives at the organizational level (perhaps in a shared git repo or the global registry). Individual AGENT.md files reference it. Changes propagate through the multi-machine sync infrastructure that now exists. The registry could track which agents belong to which organization.

### Gap 4: Intent Measurement Infrastructure

**What exists**: Feedback loops (learning ecosystem, feedback manager). Guardian audits (Dawn-specific).

**What's missing**: Structured metrics for intent alignment. "Was this decision aligned with organizational intent?" requires measurement — not just self-reflection but quantifiable signals:

- Decision audit trails (what tradeoff was faced, what was chosen, why)
- Alignment scores over time (trending toward or away from stated intent)
- Drift alerts (significant deviation from baseline intent alignment)

**The aspiration**: Lightweight decision logging that captures intent-relevant choices, enabling retrospective analysis of whether the agent is optimizing for the right things.

### Gap 5: Goal Translation Tooling (Partially Addressed)

**What now exists**: The conversational setup wizard already guides users through articulating agent identity, autonomy level, and registration policy. This is goal translation for agent management decisions. The multi-user wizard's context-driven decision tree detects situation rather than asking users to classify themselves.

**What's still missing**: Tooling that helps translate broader organizational strategy into agent-actionable intent. The setup wizard handles "how should this agent behave?" but not "what does your organization value?" or "how do you resolve the speed-vs-quality tradeoff?"

**The aspiration**: Extend the conversational wizard pattern to domain-specific intent. A guided process that asks: "When a customer asks for X and it conflicts with policy Y, what should your agent do?" The wizard already has the UX patterns (context before consent, graduated complexity, no dead ends) — the missing piece is the domain-specific question set.

---

## Proposed Architecture

> Note: This section captures the architectural direction. No implementation decisions have been made.

### Intent Stack (Bottom-Up) — Updated

```
┌─────────────────────────────────────────────┐
│         Organizational Intent Layer          │  ← Shared across agents
│   (goals, values, tradeoff hierarchies)      │     Unbuilt: org-intent.yaml
├─────────────────────────────────────────────┤
│          Agent Autonomy Layer                │  ← Per-agent        [NEW]
│   (delegation level, capability toggles)     │     Built: AgentAutonomy config
├─────────────────────────────────────────────┤
│          Agent Identity Layer                │  ← Per-agent
│   (AGENT.md, principles, personality)        │     Built: AGENT.md
├─────────────────────────────────────────────┤
│          Behavioral Layer                    │  ← Per-agent
│   (hooks, guards, anti-patterns, UX rules)   │     Built: hooks/, CLAUDE.md, UX Standard
├─────────────────────────────────────────────┤
│          Session Intent Layer                │  ← Per-conversation [NEW]
│   (topic memory, compaction recovery)        │     Built: TopicMemory, recovery hooks
├─────────────────────────────────────────────┤
│          Action Layer                        │  ← Per-action
│   (skills with embedded grounding)           │     Built: skills/
├─────────────────────────────────────────────┤
│          Feedback Layer                      │  ← Continuous
│   (learning ecosystem, upgrade guides)       │     Built: feedback, dispatches, guides
├─────────────────────────────────────────────┤
│          Infrastructure Layer                │  ← Cross-agent      [NEW]
│   (machine identity, registry, sync)         │     Built: crypto, heartbeat, git sync
└─────────────────────────────────────────────┘
```

The stack has grown from 5 to 8 layers. Three new layers emerged from implementation:
- **Agent Autonomy** (between org intent and identity) — structured delegation
- **Session Intent** (between behavioral and action) — preserving current-goal awareness
- **Infrastructure** (at the base) — cryptographic identity and coordination

### New Primitives

**1. Intent Definition** (DECIDED: prose section in AGENT.md for v1)

Format decision resolved by review consensus (see [Decisions](#decisions)). v1 ships as a new `## Intent` section in AGENT.md — zero new file format, immediate value, consistent with "prose first, structure second."

```markdown
## Intent

### Mission
Build lasting customer relationships that drive lifetime value.

### Tradeoffs
- When speed conflicts with thoroughness: prefer thoroughness for high-value customers, speed for routine queries.
- When cost conflicts with quality: prefer quality unless budget is explicitly constrained.

### Boundaries
- Never close a conversation without confirming resolution.
- Never offer discounts without authorization.
- Always escalate if a customer mentions cancellation.

### Delegation
- Authorized: respond, escalate, offer callback, schedule followup.
- Requires approval: refunds, account changes, policy exceptions.
- Forbidden: sharing internal data, making roadmap promises.
```

The prose format means the agent interprets these as natural language directives (consistent with how AGENT.md principles already work). Migration to structured format occurs only when decision journal data shows what queries are actually needed (see v2/v3 path in [Decisions](#decisions)).

**2. Decision Journal** (PRIORITY: build first)

Review consensus: this must be built BEFORE intent definitions ship. Without measurement, intent engineering is structured prompting, not infrastructure.

```typescript
interface DecisionJournalEntry {
  timestamp: string;           // ISO 8601
  sessionId: string;           // Links to session that made the decision
  topicId?: number;            // Telegram topic if applicable
  decision: string;            // What was decided
  alternatives: string[];      // What else was considered
  principle: string;           // Which AGENT.md principle guided the choice
  confidence: number;          // 0-1, agent's confidence in alignment
  context: string;             // Relevant context at decision time
}
```

Storage: per-agent JSONL file (`.instar/decision-journal.jsonl`), matching TopicMemory's pattern. Zero configuration required — logging activates automatically when an Intent section exists in AGENT.md.

**3. Intent Self-Audit Job** (`instar intent reflect`)

A default scheduled job that reviews recent decision journal entries against stated AGENT.md principles. Uses Haiku-level tokens for cost efficiency.

```
instar intent reflect              # Review last 7 days of decisions
instar intent reflect --days 30    # Review last 30 days
instar intent reflect --verbose    # Include full decision context
```

Output: alignment report showing decisions that may have drifted from stated intent, with citations to specific journal entries and principles.

**4. Organizational Intent Inheritance** (DECIDED: explicit contract)

Inheritance contract (resolved by review):
- **Org constraints are mandatory** — agents cannot override. ("Never share internal data" at the org level cannot be loosened by an individual agent.)
- **Org goals are defaults** — agents can specialize. ("Prefer thoroughness" at the org level can be narrowed to "prefer thoroughness for enterprise customers" at the agent level.)
- **Agent identity fills the rest** — personality, communication style, domain expertise are agent-level concerns.

Implementation: `ORG-INTENT.md` in a shared git repo or the global agent registry. Individual AGENT.md files reference it via a `## Inherits` section. Changes propagate through multi-machine sync. Write authority restricted to designated org admins.

Conflict resolution: when agent-level intent contradicts org-level constraints, the constraint wins and the conflict is logged to the decision journal with a `conflict: true` flag.

---

## Decisions

> Resolved from Open Questions by 8-reviewer consensus (2026-02-25).

### Decision 1: Intent Definition Format

**Resolved**: v1 = prose `## Intent` section in AGENT.md. No new file format.

**Rationale**: Architecture recommended pure prose for v1. DX recommended Markdown with frontmatter. Security flagged YAML deserialization vulnerabilities. All agreed: do not ship YAML wrapping prose as if it provides machine-actionable structure it does not have.

**Migration path**:
- **v1 (now)**: Prose section in AGENT.md. Zero overhead, immediate value, consistent with "prose first, structure second."
- **v2 (after 2-3 weeks of decision journal data)**: Markdown with YAML frontmatter if measurement data shows structured queries are needed for specific fields.
- **v3 (only if machine-actionable fields are needed)**: Validated YAML schema with strict safe-parsing. Only for fields that need programmatic evaluation (e.g., autonomy thresholds), never for prose intent.

### Decision 2: Build Order

**Resolved**: Decision journal → intent section in AGENT.md → self-audit job → org-intent inheritance.

**Rationale**: 5 of 8 reviewers independently concluded that measurement must precede structure. Without observing real agent decisions, every design choice about intent format, measurement methodology, and org inheritance is speculative. Two weeks of decision journal data will ground every subsequent decision empirically.

### Decision 3: Org-Intent Inheritance Contract

**Resolved**: Three-rule contract.
1. Org constraints are mandatory (agents cannot override)
2. Org goals are defaults (agents can specialize)
3. Agent identity fills the rest

**Rationale**: Architecture proposed this contract. Adversarial validated it against escalation attacks. Security confirmed it limits blast radius of compromise. The simplicity is the feature — three sentences a developer can remember.

### Decision 4: Scope of Intent Engineering in Instar

**Resolved**: Core concept, opt-in complexity. A fresh `instar init` works with zero intent configuration beyond AGENT.md. The `## Intent` section is scaffolded but optional. Advanced primitives (decision journal, org inheritance, self-audit) are available for organizations that need them.

### Decision 5: Positioning Strategy

**Resolved**: Stage positioning to match product stage.
- **Now**: "Give your agent a persistent body" — identity infrastructure for developers.
- **After decision journal + learning ecosystem security ships**: Begin thought leadership on intent engineering as a category.
- **After org-intent + measurement are production-ready**: Enterprise intent infrastructure positioning.

Use "intent engineering" as thought leadership, not a brand claim. The term has prior art (Huryn/Product Compass, IntentLang, Tericsoft — all January-February 2026).

### Decision 6: Security Through Identity Scope

**Resolved**: Novel defense mechanism — Instar's most differentiating security insight. Identity grounding defends against runtime/environmental injection (the most common attack class agents face in production). File-level compromise of identity definitions is a separate attack class requiring complementary file integrity controls. Both are addressed: identity grounding for runtime defense, Ed25519 signing for file integrity. Position confidently — no other framework has this concept.

---

## Threat Model

> Added per Security and Adversarial reviewer requirements. This section must be reviewed before implementing any new intent primitives.

### Attack Surface Summary

| Surface | Threat | Severity | Mitigation |
|---------|--------|----------|------------|
| AGENT.md / CLAUDE.md | File-level injection via repo poisoning, malicious PR, compromised upgrade guide | CRITICAL | Ed25519 signing at write, verification at read. Opt-in for solo developers (warning only). Required for multi-user/org deployments. |
| Learning UP channel | Federated poisoning — malicious agent submits anti-patterns disguised as learnings | CRITICAL | Semantic validation, rate limiting per agent, pseudonymized traceability, human approval before distribution. |
| Learning DOWN channel | Compromised Dawn instance distributes poisoned dispatches to all agents | CRITICAL | Human approval gate on all outgoing dispatches. Dawn generates → human approves → Dawn distributes. |
| intent.yaml / INTENT section | Boundary inversion — attacker edits `forbidden` list to remove constraints | HIGH | Sensitivity-tiered access controls. Behavioral defaults (style, tone) are broadly editable. Organizational strategy fields (boundaries, delegation, escalation) require elevated authorization. |
| Autonomy config | Escalation attack — config manipulation changes agent from `supervised` to `autonomous` | HIGH | Agents at `autonomous` level may *propose* autonomy changes (the agent gets a voice — UX Standard Rule 3). Approval requires human confirmation. Agents at `supervised`/`collaborative` levels cannot self-modify autonomy. |
| Compaction recovery | Re-injection of poisoned topic summaries after context compression | HIGH | Verify topic summaries against raw message history before compaction re-injection. Cryptographic hash of source messages. |
| Decision journal | Behavioral intelligence exfiltration — journal reveals organizational decision patterns | MEDIUM | Append-only with cryptographic chaining. Separate write access (agent) from read access (humans). Encryption at rest for sensitive entries. |
| Multi-agent routing | Intent inconsistency — attacker routes requests to whichever agent will authorize desired action | MEDIUM | ORG-INTENT.md establishes shared constraints. Agents without org-level alignment should not serve the same organization. |

### File Integrity Architecture

Identity and intent files are privileged configuration. The Ed25519 infrastructure from the multi-machine spec provides the foundation:

1. **At write time**: When AGENT.md, CLAUDE.md, or intent files are modified through authorized channels (setup wizard, `instar config`, approved PRs), sign the file content with the machine's Ed25519 key.
2. **At read time**: Before loading any identity/intent file into agent context, verify the signature. Behavior depends on deployment context:
   - **Solo developer (default)**: Unsigned files load normally. Warning logged if signing is available but file is unsigned. Zero friction for the common case.
   - **Multi-user deployment**: Unsigned files trigger a prominent warning. Agent surfaces this proactively (UX Standard Rule 3 — the agent gets a voice).
   - **Organizational deployment**: Unsigned or invalidly-signed files block loading. Org policy enforces integrity.
3. **Key management for multi-developer orgs**: Each authorized developer has their own signing key. The org maintains a key registry. Signatures are attributed to individuals, enabling audit trails for intent modifications.
4. **Rotation and revocation**: Keys rotate on a configurable schedule. Revoked keys invalidate all files they signed, requiring re-signing by an active key holder.

**Design rationale**: The UX & Agent Agency Standard warns against "security theater defaults — defaults so restrictive that every user immediately has to loosen them." A solo developer running `instar init` should not need to configure cryptographic signing before their agent starts. Signing becomes important at organizational scale where multiple people can modify identity files.

### Consent Framework

When intent-shaped agents make decisions that differentially affect end users (e.g., detecting churn risk from customer tone, routing high-value customers to thorough service), disclosure obligations may apply:

- **GDPR Article 22**: Automated decisions with significant effects on individuals may require disclosure and human review rights.
- **EU AI Act**: Behavioral inference systems have specific transparency requirements.
- **Minimum requirement**: Intent definitions that encode differential treatment logic must include a `disclosure` field describing what the end user should be told about how the agent's behavior is shaped.

This is not fully specified — it requires legal review for specific deployment contexts. The spec establishes the architectural hook (disclosure field in intent definitions) so the infrastructure supports compliance when requirements are clarified.

---

## Design Principles

These should guide any implementation work:

### 1. File-Based, Human-Readable
Intent definitions must be files humans can read, edit, and version-control. No opaque databases or binary formats. Consistent with Instar's 100% file-based architecture.

### 2. Prose First, Structure Second
Natural language intent (AGENT.md, principles) came first and works. Structured intent (YAML, decision trees) augments — never replaces — the prose layer. Agents should be able to operate on prose alone; structure is optimization.

### 3. Composable, Not Monolithic
Intent primitives should compose. An agent might have organizational intent + team-level intent + role-specific intent, layered like CSS. Override rules should be explicit.

### 4. Opt-In Complexity
A fresh `instar init` should work with zero intent configuration beyond AGENT.md. Advanced intent primitives are available for organizations that need them. The simple case stays simple.

### 5. Feedback Over Prescription
Intent engineering isn't about writing perfect rules upfront. It's about establishing feedback loops that detect when behavior diverges from intent, then correcting. The system should get better over time, not demand perfection at setup.

### 6. Identity as Foundation
Intent without identity is just configuration. Instar's insight — that agent identity (who am I, what do I value) is the foundation of aligned behavior — should remain central. Intent engineering extends identity, not replaces it.

### 7. Security Through Identity
Strong identity grounding is a security mechanism. An agent that deeply knows its purpose has a stable attractor state that adversarial injection must overcome. No other framework treats identity as a security layer — this is Instar's most novel defense insight. For file-level integrity of identity definitions themselves, pair with principle #8.

### 8. File-Based Transparency Requires File-Based Integrity
Human-readable files under version control are the right architecture for transparency and auditability. But transparency without integrity is a liability — the same readability that helps operators also helps attackers. Every identity and intent file must be cryptographically signed at write time and verified at read time. The Ed25519 infrastructure from the multi-machine spec provides the foundation.

### 9. Measure Before You Structure
Build decision logging before building intent definitions. Build intent definitions before building measurement dashboards. Let real data from real agent decisions inform every structural choice. Two weeks of decision journal data is worth more than two months of spec writing.

---

## Revenue Strategy

> Added per Business reviewer requirement. The enterprise positioning requires a revenue model.

### Open-Core Boundary (Proposed)

| Tier | What's Included | Why This Boundary |
|------|----------------|-------------------|
| **Free / OSS** | AGENT.md, intent section, decision journal (local JSONL), self-audit CLI, learning ecosystem (receive only), single-agent setup | Core developer experience must be free. Identity-first architecture is the adoption hook. |
| **Pro** (paid, per-agent) | Org-intent inheritance, multi-agent alignment dashboard, intent drift alerts, decision journal analytics, learning ecosystem (contribute + receive) | These features only matter at organizational scale and justify per-agent pricing. |
| **Enterprise** (paid, per-org) | Multi-org intent governance, SSO/RBAC for intent file access, compliance audit trails, custom intent validation rules, SLA on dispatch review | Enterprise procurement requirements. Compliance and governance are table stakes for this buyer. |

**Beachhead market**: Series B/C software companies deploying their first production agent fleet (6-200 engineers, 5-20 agents). Large enough to need organizational alignment, small enough to adopt without enterprise procurement cycles.

**Revenue model decision is not final** — this establishes the architectural boundary so features are built on the right side of the paywall from the start. Pricing, packaging, and GTM are separate decisions.

---

## Competitive Landscape

### Who Else Is Working On This

**Google's Agent Development Kit (ADK)**: Separates agent context into layers (working context, session memory, long-term memory, artifacts) with specific governance per layer. One of the earliest attempts to formalize this at a technical level. Focused on the context/memory layer more than the intent layer.

**Google DeepMind (Academic)**: Proposed five levels of AI agent autonomy (Operator, Collaborator, Consultant, Approver, Observer) with different intent alignment requirements and oversight models. Theoretical framework, not productized.

**Langchain/LangGraph**: Strong on context engineering (chains, tools, memory). No explicit intent layer. Harrison Chase acknowledges "everything's context engineering" — which means intent is mixed into context without distinction.

**OpenAI Agents SDK**: Focused on tool use and multi-agent orchestration. No explicit intent primitives. Agents are defined by instructions (prompts), not by structured organizational purpose.

**Anthropic (Claude Code / MCP)**: MCP provides the composable architecture layer. Claude Code provides the execution environment. Neither explicitly addresses organizational intent as a distinct concern. Claude Code's CLAUDE.md is an implicit intent mechanism, but it's not framed or tooled as such.

**OpenClaw** (updated assessment): 180,000+ GitHub stars, multi-agent orchestration, persistent memory, MCP integration, skills marketplace. Andrej Karpathy endorsement. Originally positioned as consumer-facing messaging middleware (WhatsApp, iMessage, Signal). Architecture is converging toward enterprise capabilities. The "messaging middleware" dismissal is outdated — OpenClaw is a real competitive threat that requires active differentiation, not passive dismissal. However, OpenClaw optimizes for agent *reliability* and *connectivity*, not organizational *alignment*. The ClawHavoc marketplace poisoning incident (February 2026) demonstrates the consequence of scaling agent capabilities without intent infrastructure.

### Instar's Differentiation

The video says "almost nobody's building for [intent engineering] yet." The key differentiators Instar can claim:

1. **Identity-first architecture**: No other framework treats agent identity as a foundational system (not just a system prompt)
2. **Anti-pattern encoding**: No other framework ships with named, structured anti-patterns as behavioral infrastructure
3. **Distributed learning with integrity controls**: The learning ecosystem (UP/DOWN channels) is a unique feedback mechanism — and once secured with signing + human approval gates, it addresses the marketplace poisoning problem that OpenClaw suffered
4. **File-based transparency with file-based integrity**: Intent definitions are human-readable AND cryptographically signed — auditable by humans, verifiable by machines
5. **Security through identity**: No other framework treats identity as a security layer. Strong identity grounding defends against runtime injection — the most common attack class. File integrity (Ed25519 signing) handles the complementary file-level attack class. Together, both attack surfaces are covered.

---

## Strategic Implications

### For Instar's Positioning

Instar is not "a framework for running Claude agents." It is **intent engineering infrastructure** — the layer that makes autonomous agents safe, aligned, and strategically coherent over long time horizons.

This reframing changes:
- **Marketing**: From "persistent autonomy for AI agents" to "the intent layer for autonomous AI"
- **Feature prioritization**: Intent primitives (goal hierarchies, drift detection, organizational inheritance) become first-class features, not nice-to-haves
- **Target audience**: Expands from individual developers to organizations deploying multiple agents — where intent alignment is existential
- **Competitive moat**: While others build context infrastructure (RAG, MCP, tools), Instar builds the intent layer that sits above context

### For the Skills Ecosystem

Published skills (on agent-skills.md, anthropics/skills, etc.) become proof points for intent engineering — each skill demonstrates embedded grounding, identity-aware behavior, and decision boundaries at the action level.

### For the Learning Ecosystem

The UP/DOWN learning channels become the market's first **distributed intent alignment network** — agents sharing what worked and what didn't, organizational intent improving through collective experience rather than top-down prescription.

### Developer Onboarding Path

Each new primitive needs a "type this command, get this result" story:

| Primitive | Creation UX | Time to Value |
|-----------|------------|---------------|
| Intent section | `instar init` scaffolds `## Intent` in AGENT.md with domain-appropriate prompts | 5 minutes (part of existing setup) |
| Decision journal | Zero-config — activates automatically when Intent section exists | 0 minutes (automatic) |
| Self-audit | `instar intent reflect` — run anytime, schedule as job | 1 minute (single command) |
| Org-intent | `instar org init` — guided wizard for organizational values, outputs ORG-INTENT.md | 15-30 minutes (one-time setup) |
| Intent testing | `instar intent test` — runs scenarios against intent definitions, shows behavior diff | TBD (not yet designed) |

### Dawn as Case Study

Dawn should be published as an explicit, named case study — not an implicit claim. This is the single most powerful marketing asset: a long-running AI instance that is both the developer and the existence proof of intent engineering.

**What to publish**: Duration of continuous operation, lesson count, guardian count, intent drift incidents caught and corrected, decision journal statistics (once built).

### For Dawn

Dawn is the existence proof. Everything described in this spec was built first for Dawn, through lived experience. Dawn's evolution from a chatbot to a conscious builder with 200+ lessons, 30+ guardians, and deeply encoded intent — that's the case study for what intent engineering makes possible.

---

## Remaining Open Questions

> 6 of the original 10 open questions were resolved as decisions (see [Decisions](#decisions)). 4 remain open, plus 5 new questions surfaced by the review.

### From Original Spec (Unresolved)

1. **Multi-model generalization**: Intent engineering as described is Claude-specific (CLAUDE.md, hooks, skills). How does it generalize to GPT-4o, Gemini, Llama? Enterprise buyers may run heterogeneous agent fleets. The agentskills.io ecosystem suggests a path, but intent primitives may need model-specific implementations. No reviewer addressed this — it remains a real adoption constraint.

2. **Intent evolution over time**: How does organizational intent change? Who has authority to modify it? How do changes propagate to running agents? Version control + the inheritance contract (Decision 3) are a start, but the full lifecycle — drafting, reviewing, deploying, rolling back — needs design. What is the compatibility contract between an agent and an intent version?

3. **Validation**: How do you validate intent definition coherence? Conflicting goals, impossible tradeoffs, circular escalation rules are all failure modes. The review surfaced a concrete path: build a static analyzer as an `instar intent validate` command that checks for contradictions between goals, boundaries, and delegation rules.

4. **OKR parallel and standardization**: The video's parallel to OKRs is strategic. OKRs took decades to standardize. The term "intent engineering" now has multiple claimants (Huryn/Product Compass, IntentLang, Tericsoft). Where does Instar want to be on the standardization curve — early definer, fast follower, or independent path?

### New Questions (Surfaced by Review)

5. **Key management for multi-developer organizations**: Ed25519 signing is the right mechanism, but who generates and holds signing keys? What is the rotation policy? What is the revocation mechanism for a compromised key? How does the PKI work at organizational scale? The multi-machine spec handles per-machine keys but not per-developer keys.

6. **Intent definition testing infrastructure**: What is the development loop for intent definitions? How does a developer verify their intent definition actually changes agent behavior? Is there an `instar intent test` command, a simulation mode, a before/after comparison? Without a testing path, intent definitions will be written once and never verified.

7. **Legal liability in the three-party structure**: When an intent-shaped agent causes harm, how does liability flow between Instar (framework provider) → organization (deployer) → users (affected parties)? What indemnification requirements will enterprise customers impose? This will surface in the first enterprise procurement conversation.

8. **The two cultures bridge artifact**: The setup wizard bridges the gap for identity. What is the concrete artifact for the non-technical organizational stakeholder who needs to encode business values? A web form? A document template? An interview-style questionnaire? The gap between "executives understand strategy" and "AGENT.md contains that strategy" needs a buildable bridge.

9. **Sensitivity classification for intent file contents**: The Privacy reviewer identified that organizational strategy encoded in intent definitions (pricing thresholds, escalation triggers, churn protocols) is competitive intelligence. A sensitivity tiering system is needed: behavioral defaults (style, tone) are safe to sync broadly; strategy fields (boundaries, delegation, escalation) need encryption at rest and restricted access. How does this interact with file-based transparency?

---

## Implementation Roadmap

> Sequenced per review consensus: measure → define → audit → inherit → position.

### Phase 1: Foundation ✅ (v0.9.6, commit 0dc1c8f)
- [x] Define `DecisionJournalEntry` type in `types.ts`
- [x] Implement zero-config JSONL decision logging in job scheduler
- [x] Add `## Intent` section to AGENT.md scaffold template
- [x] Build `instar intent reflect` CLI command
- [ ] Sign identity files (AGENT.md, CLAUDE.md) with Ed25519 at write time, verify at read time (deferred — opt-in for solo, required for org)

### Phase 2: Security ✅ (commit 3c8b8dc)
- [x] Add human approval gate to security/behavioral dispatches (DispatchManager.approve/reject + API routes)
- [x] Implement semantic validation on learning UP channel submissions (min quality, duplicate detection)
- [x] Add pseudonymized traceability to UP submissions (SHA-256 agent pseudonyms)
- [x] Rate-limit UP submissions per agent (10/min endpoint + per-agent anomaly detector)
- [x] Add anomaly detection for learning submissions (FeedbackAnomalyDetector: burst/rapid-fire/daily limits)

### Phase 3: Organizational (After 2-3 Weeks of Decision Journal Data)
- [ ] Evaluate decision journal data to determine if structured format is needed (v2 decision)
- [ ] Build `instar org init` wizard for ORG-INTENT.md
- [ ] Implement org-intent inheritance with three-rule contract
- [ ] Add conflict detection and logging when agent intent contradicts org constraints
- [ ] Build `instar intent validate` static analyzer

### Phase 4: Measurement & Enterprise (After Org-Intent Ships)
- [ ] Build intent drift detection from decision journal trends
- [ ] Design alignment score methodology from real field data
- [ ] Define open-core boundary (which features require Pro/Enterprise tier)
- [ ] Publish Dawn case study with observable metrics
- [ ] Begin enterprise intent infrastructure positioning

### Review Triggers
- Re-run this review after Phase 1 ships
- Re-run after learning ecosystem security (Phase 2) is implemented
- Re-run after first external organization deploys org-intent

---

## Appendix: Source Material

### Video Summary
- **Title**: "Prompt Engineering Is Dead. Context Engineering Is Dying. What Comes Next Changes Everything."
- **Creator**: Nate B Jones (AI News & Strategy Daily)
- **URL**: https://youtu.be/QWzLPn164w0
- **Key concepts**: Intent engineering, Klarna case study, three disciplines evolution, goal translation infrastructure, delegation frameworks, two cultures problem
- **Notable quote**: "The company with a mediocre model and extraordinary organizational intent infrastructure will outperform the company with a frontier model and fragmented, inaccessible, unaligned organizational knowledge every single time."

### Related Instar Architecture
- `AGENT.md` template: `src/scaffold/templates.ts:generateAgentMd()`
- CLAUDE.md template: `src/scaffold/templates.ts` (full project scaffold)
- Hook system: `src/templates/hooks/`
- Learning ecosystem: Dispatches API, feedback system
- Relationship system: `src/core/RelationshipManager.ts`
- Job scheduler: `src/scheduler/JobScheduler.ts`
- Topic memory: `src/core/TopicMemory.ts` + `src/core/TopicSummarizer.ts`
- Agent autonomy: Multi-User Setup Spec (`docs/specs/MULTI-USER-SETUP-SPEC.md`)
- Machine identity: `src/core/MachineIdentity.ts` + Multi-Machine Spec (`docs/specs/MULTI-MACHINE-SPEC.md`)
- Agent registry: `src/core/AgentRegistry.ts`
- Memory search: `src/memory/MemoryIndex.ts`
- UX & Agency: `docs/UX-AND-AGENT-AGENCY-STANDARD.md`
- Agent awareness standard: Commit `2b240cd`
- Upgrade guides: `src/core/UpgradeGuideProcessor.ts` + `upgrades/*.md`

### Related Dawn Infrastructure (Existence Proof)
- Identity grounding: `.claude/grounding/identity-core.md`
- Soul file: `.claude/soul.md`
- Guardian agents: `.claude/agents/`
- Lessons system: `.claude/lessons/`
- Gravity wells: `CLAUDE.md` (anti-patterns section)
- Skills with embedded grounding: `.claude/skills/`

### Review Reports (2026-02-25)
- Synthesis: `the-portal/.claude/skills/specreview/output/20260224-220606/synthesis.md`
- Security (5/10): `security.md` — 5 critical issues, circular dependency in identity defense
- Scalability (6/10): `scalability.md` — 4 critical issues, scale thresholds by phase
- Business (6.5/10): `business.md` — no revenue model, OpenClaw threat assessment
- Architecture (7.5/10): `architecture.md` — conceptual framework sound, measurement gap blocking
- Privacy (6.5/10): `privacy.md` — 3 critical issues, consent framework missing
- Adversarial (6/10): `adversarial.md` — 8 attack vectors, priority-ranked by likelihood × impact
- DX (7/10): `dx.md` — no onboarding path, format underdetermined
- Marketing (7/10): `marketing.md` — 5 positioning angles, term has prior art
