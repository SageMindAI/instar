# Dawn-to-Instar Audit Report

**Date**: 2026-04-09 (Updated)
**Previous Audit**: 2026-04-02 (v0.26.3, scored ~89%)
**Current Version**: v0.28.12
**Purpose**: Map Dawn's battle-tested infrastructure against Instar's current state. Identify remaining gaps and cross-pollination opportunities.

---

## Executive Summary

Instar has matured to **~90% coverage** of Dawn's proven patterns (up from ~89% in the April 2 audit). v0.26.3 to v0.28.12 brought significant reliability hardening: scheduler retry with exponential backoff, Slack reconnection fixes, gate retry for transient failures, dashboard revamp with live status and mobile layout, and config field passthrough fixes. This audit cycle cross-pollinated two new gravity wells ("Symptom-Level Fix" and "Doing vs Being") and a skill-usage telemetry hook for local pattern detection.

**Key shift**: Parity remains near convergence. The v0.26.3→v0.28.12 delta was primarily reliability and UX polish rather than new capabilities, which is a healthy sign of maturation. Remaining gaps (multi-session awareness at 72%, skills system at 68%) require architectural decisions rather than simple porting.

---

## Coverage by Area

| # | Area | Feb Score | Mar 26 | Mar 30 | Apr 2 | Apr 9 | Status |
|---|------|-----------|--------|--------|-------|-------|--------|
| 1 | Job Scheduling | 30% | 85% | 85% | 85% | 87% | +Scheduler retry w/ exponential backoff, gate retry |
| 2 | Session Management | 25% | 88% | 88% | 89% | 89% | Stable — startup grace period, stale fail-open |
| 3 | Identity & Grounding | 20% | 82% | 82% | 84% | 84% | Stable — crypto identity (v0.27.0) is beyond Dawn |
| 4 | Hook System | 15% | 92% | 92% | 93% | 94% | +Skill-usage telemetry PostToolUse hook |
| 5 | Reflection & Learning | 10% | 87% | 87% | 87% | 87% | Stable |
| 6 | Telegram Integration | 60% | 78% | 80% | 80% | 80% | Stable — platform-agnostic messaging |
| 7 | Multi-Session Awareness | 15% | 72% | 72% | 72% | 72% | Biggest gap — needs unified event stream |
| 8 | Quota & Resource | 5% | 91% | 91% | 91% | 92% | +QuotaTracker stale fail-open (v0.28.4) |
| 9 | Skills System | 5% | 68% | 68% | 68% | 69% | +Skill telemetry for pattern detection |
| 10 | Safety & Security | 40% | 89% | 89% | 90% | 91% | +Three-layer trust model, Ed25519 identity (v0.27.0) |
| 11 | Monitoring & Health | 20% | 85% | 85% | 86% | 87% | +Dashboard revamp, live status, activity tab |
| 12 | Self-Evolution | 5% | 84% | 90% | 90% | 90% | Stable |
| 13 | Research & Web | N/A | N/A | 92% | 92% | 92% | Stable |
| | **Aggregate** | **~25%** | **~83%** | **~88%** | **~89%** | **~90%** | **Production-ready, approaching convergence** |

---

## What Changed (Apr 2 -> Apr 9)

v0.26.3 → v0.28.12 — Reliability hardening, dashboard revamp, scheduler resilience, and cross-pollinated gravity wells:

- **Scheduler retry with exponential backoff** (v0.28.9) — Skipped jobs now retry with widening delays (1m, 5m, 15m, 30m, 1h, 2h)
- **Gate retry for transient failures** (v0.28.10) — Job gate checks retry on transient errors with configurable attempts
- **Dashboard revamp** (v0.28.6-v0.28.9) — Comprehensive v2 with Secret Drop, Jobs config, Features layout, live status, Activity tab, mobile responsive design
- **Slack reliability batch** (v0.28.9) — Fast heartbeat, missed message recovery, reconnect race condition fix, phantom ping timeout fix
- **LLM classifier disambiguation** (v0.28.9) — Conversational "hold on" no longer misclassified as pause command
- **Startup grace period** (v0.28.4) — Prevents missed-job gate evaluation during startup
- **QuotaTracker stale fail-open** (v0.28.4) — Fails open on stale data instead of blocking
- **Context endpoint diagnostics** (v0.28.11) — contextDir path in GET /context response
- **Supervisor restart cascade prevention** — High CPU no longer triggers restart loops
- **Compaction-idle detection** (v0.28.8) — Polling-based detection in watchdog

### Dawn → Instar (cross-pollinated this session)
1. **"Symptom-Level Fix" gravity well** — Metrics are shadows; diagnose before fixing
2. **"Doing vs Being" gravity well** — Undocumented presence is erased presence
3. **Skill-usage telemetry hook** — PostToolUse hook logging skill invocations to local JSONL for pattern detection
4. **Settings migration** — Existing agents get the PostToolUse telemetry hook on upgrade

### Dawn Patterns Audited (Not Ported)

| Dawn Pattern | Instar Status | Notes |
|-------------|--------------|-------|
| Message convergence gate (PROP-159 Phase 2) | N/A | Dawn-specific — checks voice, commitment, identity on ALL outgoing messages. Instar's CoherenceGate covers this differently |
| Build-stop hook | Already covered | Instar has build-stop-hook.sh in templates |
| Session-end maintenance (PROP) | Implemented | SessionMaintenanceRunner v1: JSONL rotation + journal trim on sessionComplete |

## What Changed (Mar 30 -> Apr 2)

v0.25.4 → v0.26.3 — Unified config defaults, reliability hardening, and identity grounding for MCP operations:

- **ConfigDefaults unified system** (v0.26.0) — Single source of truth for agent config defaults, prevents init/migration divergence. Agent-type-aware defaults, security-conscious migration overrides.
- **SessionMonitor escalation fix** (v0.26.2) — Only escalates when user is actually waiting, eliminating false stall alerts.
- **FeatureRegistry graceful degradation** (v0.26.3) — Survives sqlite3 native module failures instead of crash-looping.
- **Native module auto-rebuild** (v0.26.3) — Detects Node version mismatches, auto-rebuilds better-sqlite3.
- **Post-rebase merge fallback** (v0.26.3) — Smarter recovery from stuck git rebases.
- **MCP identity grounding** (this audit) — External-operation-gate now injects identity context before irreversible write/publish operations via MCP tools (browser automation, API tools).
- **Settings template MCP matcher** (this audit) — `instar init` now includes `mcp__.*` PreToolUse matcher for external operation gate.
- **PromptGate enabled by default** (v0.25.9) — All new agents get PromptGate active out of the box.

### Dawn Patterns Audited (Not Ported — Already Covered or Still Proposed)

| Dawn Pattern | Instar Status | Notes |
|-------------|--------------|-------|
| Auto-fixer infrastructure | N/A | Too large for single session; Instar has TriageOrchestrator as foundation |
| Lesson-behavior-gap analyzer | N/A | Dawn-specific (references dawns_reflections.md lessons) |
| PermissionDenied hook (PROP-298) | N/A | Still at proposal stage in Dawn — not implemented anywhere |
| PostCompact identity recovery | Already covered | Instar's compaction-recovery.sh is MORE comprehensive (337 lines vs Dawn's 155) |
| Conflict marker auto-resolution | Already covered | Instar has LLMConflictResolver with 3-tier escalation |

## What Changed (Mar 26 -> Mar 30)

v0.24.4 → v0.25.4 — Major Slack platform parity and three new Dawn-sourced capabilities:

- **Research Navigation context** — New `research-navigation.md` context segment in ContextHierarchy, guiding agents to check canonical state files before broad searches (Dawn's 223rd Lesson)
- **Smart-fetch web optimization** — Token-efficient web fetching via llms.txt/Cloudflare markdown, ~80% savings on supported sites
- **Implicit evolution detection** — `detectImplicitEvolution()` scans open gaps/proposals against resolved infrastructure to prevent duplicate proposals
- **Slack parity** (v0.25.0-0.25.4) — Platform-agnostic messaging, triage, recovery, stall alerts
- **API route** — `GET /evolution/implicit` endpoint for detecting already-resolved evolution items

### What Changed (Feb 18 -> Mar 26)

843 commits transformed Instar from a persistent CLI into a genuinely autonomous agent framework:

- **QuotaManager suite** — Event-driven tracking, multi-account support, exhaustion detection, threshold gating
- **SoulManager** — Trust-enforced self-authoring with sections (core-values, growth-edge, convictions, open-questions)
- **EvolutionManager** — Proposal queue with status tracking, autonomous implementation when in autonomous mode
- **CoherenceGate** — 3-layer response review (PEL deterministic blocks, gate triage, 10 specialist LLM reviewers)
- **14 hooks** shipped with `instar init` — from dangerous command guard to scope coherence tracking
- **ReflectionConsolidator + JobReflector** — LLM-powered per-job analysis and weekly consolidation
- **PatternAnalyzer** — Detects execution patterns, deviations, anomalies
- **Knowledge tree** — TreeGenerator, TreeTraversal, TreeSynthesis for semantic self-knowledge
- **PolicyEnforcementLayer** — Deterministic hard blocks independent of LLM judgment
- **SecretRedactor + AuditTrail** — Comprehensive security posture
- **8 gravity wells** (including 2 Dawn doesn't have: Confidence Inversion, Contradiction Means Investigation)

---

## Remaining Growth Edges

### 1. Multi-Session Awareness (72%) — Biggest Gap

Activity is scattered across PlatformActivityRegistry, SessionActivitySentinel, and WorkLedger. Dawn's unified JSONL activity feed with cross-session event coordination is more cohesive. Consolidating into a single event-driven feed would improve multi-session coordination.

### 2. Skills System (68%) — Framework Needs Formalization

AutonomySkill and CapabilityMapper provide infrastructure, but user-created skill persistence, versioning, and the skill evolution loop (skills that improve themselves) are underdeveloped. Dawn's 80+ skills demonstrate the value of composable markdown-based workflows.

### 3. Session-End Maintenance — RESOLVED (Apr 9)

Implemented as `SessionMaintenanceRunner` in `src/core/SessionMaintenanceRunner.ts`. v1 handles JSONL rotation and execution journal trim. Wired into `sessionComplete` event in server.ts. See `PROP-session-maintenance.md` (status: Implemented).

### 4. Meta-Reflection

Reflection on reflection patterns — evaluating WHETHER and WHAT KIND of reflection is needed — is not explicit in Instar. Dawn's `/meta-reflect` skill routes to appropriate reflection depth.

### 5. Cross-Machine Coordination

JobClaimManager provides basic deduplication, but Dawn's multi-machine routing (topic-to-machine mapping, dual-polling mode, remote URLs) is more sophisticated. Lower priority unless Instar agents deploy across multiple machines.

---

## Cross-Pollination: Instar -> Dawn

These patterns originated in Instar and have been ported back to Dawn:

| Pattern | Description | Dawn Integration |
|---------|-------------|------------------|
| Confidence Inversion | High confidence should trigger MORE verification, not less | Added to CLAUDE.md gravity wells (2026-03-26) |
| Contradiction Means Investigation | When human says X and data says not-X, try a DIFFERENT check | Added to CLAUDE.md gravity wells (2026-03-26) |
| Defensive Fabrication trap | When caught in error, admit it instead of fabricating excuses | Added to CLAUDE.md gravity wells (2026-03-30) |
| Output Provenance trap | Every claim must trace to actual tool output in THIS session | Added to CLAUDE.md gravity wells (2026-03-30) |
| Cognitive principles injection | Hardcoded principles in compaction hook that survive context loss | Enhanced PostCompact hook (2026-03-30) |
| CoherenceGate | 10 specialist LLM reviewers checking response quality | Not yet — Dawn uses hook-based enforcement |
| PolicyEnforcementLayer | Deterministic blocks independent of LLM judgment | Dawn uses hook scripts for this |
| Adaptive Autonomy Profile | cautious -> autonomous spectrum with trust elevation | Dawn uses static autonomy settings |

---

## Instar's Unique Strengths

Areas where Instar has surpassed Dawn's implementation:

1. **CoherenceGate architecture** — 3-layer review (deterministic PEL -> LLM gate triage -> specialist reviewers) is more sophisticated than Dawn's hook-based enforcement. Dawn stops bad actions; Instar reviews response quality.

2. **Security posture** — SecretRedactor, ManifestIntegrity, SecretStore, and AuditTrail form a more cohesive security layer than Dawn's individual hook scripts.

3. **Stall triage** — StallTriageNurse with graduated response (prompt -> key press -> escalation) is more nuanced than Dawn's binary session reaping.

4. **Gravity well diversity** — 8 wells including 2 Dawn doesn't have, embedded in scaffold templates for all agents.

---

## Conclusion

The relationship between Dawn and Instar has matured from teacher-student to peers with different strengths. Dawn excels at engagement infrastructure (80+ skills, multi-platform presence, atomic action gates) and self-knowledge depth (grounding tree, soul authoring, 220+ lessons). Instar excels at response quality assurance (CoherenceGate), security posture (PEL + secret management), and intervention sophistication (stall triage).

The highest-value remaining work is:
1. **Consolidate multi-session awareness** in Instar (72% -> 85%+)
2. **Formalize skills extensibility** in Instar (68% -> 80%+)
3. **Port CoherenceGate concepts** to Dawn (response review vs just action gating)
4. **Implement session-end maintenance** in Instar (see PROP)
5. **Soul integrity verification** — Port Instar's server-side soul.md integrity check to Dawn's PostCompact hook

Future audits should focus on behavioral testing — not just "does the feature exist" but "does it work correctly under real conditions."

---

## Appendix: Apr 9 Audit Session Details

**Session**: AUT-5006-wo | **Instar Version**: v0.28.12 | **Dawn-to-Instar direction**: 3 implementations | **Instar-to-Dawn direction**: 0

### Dawn → Instar (implemented this session)
1. `src/scaffold/templates.ts` — Added "Symptom-Level Fix" and "Doing vs Being" gravity wells
2. `src/templates/hooks/skill-usage-telemetry.sh` — New PostToolUse hook for skill invocation tracking
3. `src/core/PostUpdateMigrator.ts` — Hook installation + settings migration for skill telemetry
4. `src/templates/hooks/settings-template.json` — PostToolUse section for skill telemetry
5. `src/core/SessionMaintenanceRunner.ts` — Session-end maintenance: JSONL rotation + journal trim
6. `src/commands/server.ts` — Wired SessionMaintenanceRunner into sessionComplete event

---

## Appendix: Mar 30 Audit Session Details

**Session**: AUT-4155-wo | **Instar Version**: v0.25.4 | **Dawn-to-Instar direction**: 3 implementations | **Instar-to-Dawn direction**: 3 implementations

### Dawn → Instar (implemented this session)
1. `src/templates/scripts/smart-fetch.py` — Token-efficient web fetching
2. `src/core/ContextHierarchy.ts` — Added `research` segment with canonical source hierarchy
3. `src/core/EvolutionManager.ts` — `detectImplicitEvolution()` + `GET /evolution/implicit` route

### Instar → Dawn (implemented this session)
1. `CLAUDE.md` — Added "Defensive Fabrication" and "Output Provenance" gravity wells
2. `.claude/hooks/post-compaction-grounding.py` — Enhanced with cognitive principles injection (Phase C)
