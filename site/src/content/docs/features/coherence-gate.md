---
title: Coherence Gate
description: LLM-powered response review pipeline that catches quality issues before the user sees them.
---

Every outbound message your agent sends passes through the Coherence Gate -- a review pipeline that catches credential leaks, hallucinated URLs, wrong tone, and a dozen other failure modes before they reach the user. Think of it as a copy editor, fact-checker, and security scanner rolled into one, running in milliseconds.

## How It Works

The pipeline has three layers, each progressively more expensive. Most messages only hit the first two.

### Layer 1: Policy Enforcement (PEL)

Deterministic pattern matching. No LLM involved, no token cost, always active. The PEL scans every outbound message for:

- **Credentials** -- API keys, auth tokens, passwords, private keys
- **PII** -- Email addresses, phone numbers, IP addresses that shouldn't be exposed
- **Dangerous patterns** -- Bearer tokens, connection strings, secrets in code blocks

If the PEL catches something, the message is blocked immediately. No need to call an LLM to know that leaking a private key is bad.

### Layer 2: Gate Reviewer

A fast, lightweight LLM call that reads the message and decides: does this need full review? Most messages are straightforward -- a status update, a simple answer, a confirmation. The Gate Reviewer waves these through in a single cheap call.

When it detects something worth examining -- a long response, technical claims, URLs, capability assertions -- it escalates to Layer 3.

### Layer 3: Specialist Reviewers

Nine reviewers run in parallel, each focused on a specific failure mode. They only activate when the Gate Reviewer flags a message, so the cost stays low. A message that triggers full review gets checked by all nine simultaneously, adding minimal latency despite the thoroughness.

## The 9 Specialist Reviewers

| Reviewer | What It Catches |
|----------|----------------|
| **Tone** | Wrong register for the channel -- too formal for Telegram, too casual for email, robotic phrasing |
| **Accuracy** | Claims not grounded in tool output from the current session, hallucinated data points |
| **Leakage** | Sensitive information that slipped past the PEL -- internal paths, config details, architecture specifics the user shouldn't see |
| **Alignment** | Responses that drift from the agent's stated identity, principles, or mission |
| **URL Verification** | Fabricated URLs, domains that don't match tool output, plausible-looking links that were never returned by any tool |
| **Capability Claims** | "I can't do X" when the agent actually can, or "I'll do X" when no such capability exists |
| **Context Coherence** | Responses that ignore or contradict the conversation history, non-sequiturs, topic drift |
| **Settling Detection** | Premature conclusions, accepting empty results at face value, "not possible" without sufficient investigation |
| **Custom** | Your own review dimensions (see Custom Reviewers below) |

Each reviewer returns a pass/fail with an explanation. If any reviewer fails, the message is held for revision.

## Per-Channel Configuration

Different channels have different quality bars. A quick Telegram reply doesn't need the same scrutiny as a published report. Configure review intensity per channel:

```json
{
  "coherenceGate": {
    "channels": {
      "telegram": {
        "enabled": true,
        "pelOnly": false,
        "skipGate": false
      },
      "publish": {
        "enabled": true,
        "pelOnly": false,
        "fullReview": true
      }
    }
  }
}
```

Setting `fullReview: true` bypasses the Gate Reviewer and always runs all nine specialists. Useful for high-stakes channels where every message matters. Setting `pelOnly: true` runs only the deterministic layer -- fast and free, but no LLM review.

## Observe-Only Mode

Not ready to block messages? Run the gate in observe-only mode. It reviews everything but never holds a message -- instead, it logs what it would have caught. This lets you see the gate's judgment without disrupting your agent's workflow.

```json
{
  "coherenceGate": {
    "enabled": true,
    "mode": "observe"
  }
}
```

Review the logs, build confidence in the gate's decisions, then switch to `"mode": "enforce"` when you're ready.

## Custom Reviewers

The nine built-in reviewers cover the most common failure modes, but every agent has unique needs. Drop a reviewer definition into `.instar/reviewers/` and the gate picks it up automatically.

A custom reviewer is a JSON file that defines what to check and how to evaluate it:

```json
{
  "name": "legal-compliance",
  "description": "Ensure responses don't make promises or guarantees that could create liability",
  "prompt": "Review this message for language that could be interpreted as a legal guarantee, warranty, or binding commitment. Flag phrases like 'we guarantee', 'this will definitely', or 'you are entitled to'.",
  "severity": "block"
}
```

Custom reviewers run alongside the built-in nine during Layer 3. Set `severity` to `"block"` to hold messages that fail, or `"warn"` to log without blocking.

## Retry and Advancement

When a message fails review, the gate doesn't just reject it -- it feeds the failure reasons back to the agent for revision. The agent rewrites, and the revised message goes through the pipeline again.

To prevent infinite loops:
- **Three attempts maximum** -- after three failed revisions, the message is delivered with an internal flag noting the unresolved issues
- **Advancement on partial progress** -- if a revision fixes some issues but introduces new ones, the gate tracks net progress and advances if the trend is positive
- **PEL failures are non-negotiable** -- credential leaks and PII exposure are never advanced past, regardless of retry count

## Getting Started

Enable the Coherence Gate in your `.instar/config.json`:

```json
{
  "coherenceGate": {
    "enabled": true,
    "mode": "observe"
  }
}
```

Start in observe mode. Watch the logs for a few days. When you're satisfied with the gate's judgment, switch to enforce mode. That's it -- the gate handles everything else automatically.

## The Stop Hook

The Coherence Gate integrates with Claude Code's hook system automatically. When enabled, a PostToolUse hook intercepts outbound messages at the point of delivery -- after the agent has composed a response but before it reaches the user. The agent doesn't need to call the gate explicitly; every message routed through Instar's messaging layer passes through the pipeline by default.

This means the gate works whether your agent sends messages via Telegram, publishes to Telegraph, replies in a session, or uses any other delivery channel. One pipeline, every exit point.
