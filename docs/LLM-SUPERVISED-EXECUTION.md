# LLM-Supervised Execution Standard

> Nothing critical should run outside the purview of an LLM at some layer.

## The Problem

Programmatic tools are fast, cheap, and fragile. They break after dependency updates, schema changes, or environment drift — and nobody notices for days. Silent failures are the #1 operational risk for autonomous agents.

## The Three Tiers

| Tier | Name | Intelligence | Cost | Failure Mode |
|------|------|-------------|------|-------------|
| **0** | Raw Programmatic | None | Zero tokens | **Silent** — breaks go unnoticed |
| **1** | LLM-Supervised | Lightweight (Haiku) | ~5-10k tokens/run | **Observed** — failures detected and reported |
| **2** | Full Intelligent | Full (Sonnet/Opus) | 100-200k tokens/run | **Handled** — failures reasoned about and resolved |

## The Rule

**Every critical pipeline MUST be at minimum Tier 1.**

A pipeline is critical if ANY of these apply:
- It processes data that could be lost or corrupted
- It maintains system health (health checks, cleanup, reconciliation)
- It handles user-facing feedback or communication
- Its silent failure would cascade to other systems
- It runs on a schedule (anything automated is critical by default)

## The Pattern

Tier 1 supervision wraps existing programmatic tools with a lightweight LLM layer:

```
[Scheduler] → [Haiku Session] → [Python/Node Tools]
                    ↓
              Validates output
              Retries on failure
              Escalates if stuck
              Reports what happened
```

The LLM doesn't replace the tools — it supervises them. The tools do the work. The LLM makes sure the work actually happened correctly.

## How to Apply in Instar

### 1. Mark Jobs with Supervision Tier

In your `jobs.json`, add the `supervision` field:

```json
{
  "slug": "my-critical-job",
  "supervision": "tier1",
  "model": "haiku",
  "execute": {
    "type": "skill",
    "value": "my-supervised-skill"
  }
}
```

### 2. Build Tier 1 Skills

A Tier 1 skill follows this protocol:

1. **Call the tool** — run the programmatic command
2. **Validate the result** — check output for errors, expected structure, completeness
3. **Retry on failure** — one retry, then escalate
4. **Report** — log what happened (never stay silent)

```markdown
# Example Tier 1 Skill Template

## Phase 1: RUN
\`\`\`bash
python3 my-tool.py process
\`\`\`

**Validate:**
- Output is valid JSON
- Contains expected fields
- No error keywords ("Error", "failed", "exception")

**If validation fails:** Retry once. If still fails, escalate via Telegram.

## Phase 2: REPORT
Log a one-line summary of what happened.
```

### 3. Supervision Tier Guidelines

| Job Type | Recommended Tier | Model | Why |
|----------|-----------------|-------|-----|
| Data processing | Tier 1 | Haiku | Validate output structure, catch silent corruption |
| Health checks | Tier 1 | Haiku | Detect false-positive "healthy" reports |
| External API calls | Tier 1 | Haiku | Catch auth failures, rate limits, schema changes |
| Content generation | Tier 2 | Sonnet | Requires reasoning about quality |
| Public engagement | Tier 2 | Opus | Identity and voice matter |
| Dev utilities | Tier 0 | None | Interactive, non-critical |

## What Does NOT Need Tier 1

- One-off manual scripts run interactively
- Development utilities (linters, formatters)
- Scripts called exclusively from within LLM sessions (already supervised)
- Read-only informational queries with no side effects

## Cost Math

Tier 1 is cheap:

```
Haiku: ~$0.25/M input, ~$1.25/M output
Per run: ~5-10k tokens = ~$0.002-0.01
12 runs/day = ~$0.02-0.12/day
Monthly: ~$0.60-$3.60
```

Compare to the cost of a silent failure going unnoticed for 3 days.

## Anti-Patterns

- **"It's just a script"** — If it's scheduled, it's critical
- **Supervision that doesn't validate output** — Running a command and not checking the result is still Tier 0
- **Supervisor more expensive than the work** — Tier 1 uses Haiku, not Opus
- **Supervision added but not tested** — A supervisor that itself fails silently is worse than no supervision

## Origin

This standard was developed for the Dawn/Portal project after identifying a gap between raw programmatic execution (fast but brittle) and full intelligent sessions (capable but expensive). The insight: a lightweight LLM wrapper around existing tools eliminates silent failures at minimal cost.
