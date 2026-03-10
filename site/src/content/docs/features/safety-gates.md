---
title: Safety Gates
description: LLM-supervised safety for external operations.
---

When your agent calls external services (email, APIs, databases), an LLM-supervised safety gate evaluates each operation before it executes.

## How It Works

The external operation gate is a PreToolUse hook that intercepts MCP tool calls. Before any external operation executes, it:

1. **Classifies risk** -- Scores the operation on mutability, reversibility, and scope
2. **Checks trust level** -- Each service has a trust profile that evolves over time
3. **Decides** -- Allow, require confirmation, or block

## Risk Classification

| Factor | Low Risk | High Risk |
|--------|----------|-----------|
| Mutability | Read-only | Creates/modifies/deletes |
| Reversibility | Can be undone | Permanent |
| Scope | Single item | Bulk operation |

## Adaptive Trust

Trust levels evolve per service based on track record:

- **New services** start supervised -- every operation reviewed
- **Consistent success** earns increasing autonomy
- **Failures or incidents** reduce trust level
- Trust is earned per service, not globally

## Emergency Stop

Say "stop everything" and the MessageSentinel halts operations immediately, before normal routing processes the message.

## Automatic Installation

The safety gate hook is installed automatically for all MCP tool calls. No configuration needed.

## Related: Coherence Gate

Safety Gates protect against dangerous *actions*. The [Coherence Gate](/features/coherence-gate/) protects against dangerous *messages* -- reviewing every outbound response for tone issues, fabricated claims, information leakage, and value misalignment before the user sees it. Together, they form a complete safety layer: actions are gated before execution, messages are reviewed before delivery.

## Origin

Born from a real incident where an AI agent deleted a user's emails. Instar ensures your agent asks before doing anything it can't undo.
