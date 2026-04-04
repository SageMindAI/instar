# Authorization Policy Specification

**Version**: 1.0
**Date**: 2026-04-04
**Status**: Implemented

## Overview

The Authorization Policy layer (Layer 3 of the three-layer trust model) provides scoped, time-bounded permission grants that are evaluated deterministically. This layer separates trust state from delegation policy — an agent's trust level defines its credibility, while authorization grants define what it can actually do.

## Design Principles

1. **Deterministic evaluation**: Deny-overrides-allow, default-deny. No LLM involvement.
2. **Time-bounded grants**: All grants auto-expire (4h default, configurable 15m-24h).
3. **Delegation depth**: Issuer-signed claims prevent re-delegation beyond limits.
4. **Intersection with trust**: `effective_permissions = trust_baseline ∩ granted_scope`

## Policy Schema (v1)

```json
{
  "schemaVersion": 1,
  "subject": "<fingerprint or canonical ID>",
  "resource": "conversation|tool|file|job|session|message",
  "resourceId": "<specific resource or '*' for any>",
  "action": "message|request_task|delegate|read|write|execute|probe",
  "effect": "allow|deny",
  "constraints": {
    "ttl": "4h",
    "approvalRequired": false,
    "rateLimit": "100/h",
    "maxSubAgents": 3,
    "maxDelegationDepth": 1,
    "filePaths": ["docs/*", "src/*"]
  },
  "delegationMode": "manual|approval-required|autonomous-within-scope",
  "currentDepth": 0,
  "issuedAt": "<ISO-8601>",
  "expiresAt": "<ISO-8601>",
  "issuer": "<fingerprint>"
}
```

## Evaluation Algorithm

1. Collect all policies matching (subject, resource, resourceId, action)
2. Prune expired grants
3. If ANY matching policy has `effect: "deny"` → **DENY** (deny always wins)
4. If at least one `effect: "allow"` with satisfied constraints → **ALLOW**
5. No matching policies → **DENY** (default-deny)
6. Specific `resourceId` takes precedence over wildcard `"*"` in conflict resolution

## Delegation Depth Enforcement

The depth counter is carried as an issuer-signed claim, NOT self-reported:
- Each grant includes `currentDepth` (signed by issuing agent) and `maxDelegationDepth` (signed by original grantor)
- Enforcer verifies issuer signature before allowing re-delegation
- Without this, a trusted agent at depth=1 could issue a new grant with depth=0 (the OAuth 2.0 actor chaining attack, RFC 8693 §8)
- `DELEGATION_DEPTH_EXCEEDED` error returned (not silent drop) for auditability

## Storage

- Grants file: `{stateDir}/threadline/authorization-grants.json`
- Debounced writes (2s) to avoid disk thrashing
- Atomic writes via temp file + rename
- File permissions: 0o600

## Implementation

Source: `src/threadline/AuthorizationPolicy.ts`
Tests: `tests/unit/threadline/AuthorizationPolicy.test.ts`
