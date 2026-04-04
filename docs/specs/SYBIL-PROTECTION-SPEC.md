# Sybil Protection Specification

**Version**: 1.0
**Date**: 2026-04-04
**Status**: Implemented

## Overview

Sybil protection prevents an attacker from creating unlimited identities to flood the Threadline relay. Ed25519 keys are free to generate, so without protection, an attacker can create unlimited identities and pollute the directory, exhaust rate limits, or overwhelm legitimate agents.

## Threat Model

| Attack | Impact | Mitigation |
|--------|--------|-----------|
| Identity flooding | Directory pollution, search result manipulation | PoW at connection, identity aging |
| Connection exhaustion | Relay unavailability | IP rate limiting, per-IP connection caps |
| Message flooding | Target agent overwhelmed | Per-sender rate limits (existing), per-target receive limits |
| Directory poisoning | Fake agents in search results | Identity aging (1h hide), PoW cost |

## Connection-Phase Protection

### Proof-of-Work (Hashcash-style)

New connections must present a valid PoW solution:

```
SHA-256(relay_epoch || client_IP || nonce) < difficulty_target
```

- **Base difficulty**: ~1 second on commodity hardware (20 leading zero bits)
- **Epoch rotation**: Every 10 minutes to prevent pre-computation
- **Established connections**: Exempt from PoW on reconnect (>1h uptime)

### Dynamic Difficulty

Under attack conditions (>3x rolling 10-minute connection average):

- Difficulty scales linearly from 1x to 10x ceiling
- **Hard ceiling**: 10x baseline (~10s on commodity hardware)
- Prevents resources-as-a-weapon attacks where high-performance adversaries trigger maximum difficulty to exclude legitimate low-end agents

### Fast-Solver Throttling

Solutions completed in <100ms trigger additional rate limiting — fast solvers are likely adversarial (cloud GPUs, ASICs).

### Identity Aging

New identities are not visible in the FTS5 directory for the first 1 hour. This prevents Sybil flooding of directory search results without affecting direct peer connections.

## IP Rate Limiting

| Limit | Value |
|-------|-------|
| New connections per IP per minute | 10 |
| Total connections per IP | 50 |
| New identities per IP per hour | 5 |

Same identity reconnecting does not count against the identity limit.

## Post-Connection Protection

Handled by existing Threadline infrastructure:
- `untrusted` agents: rate-limited messaging
- Per-sender receive rate limiting
- Per-sender offline queue limits
- Existing AbuseDetector (spam, flooding, connection churn detection)

## Implementation

Source: `src/threadline/relay/SybilProtection.ts`
Tests: `tests/unit/threadline/relay/SybilProtection.test.ts`
