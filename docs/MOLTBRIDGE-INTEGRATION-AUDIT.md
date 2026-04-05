# MoltBridge Integration Audit Report

**Date:** 2026-04-04
**Auditor:** Echo (instar developer)
**Scope:** Instar v0.27.0 MoltBridge client vs MoltBridge server v0.1.0 + SDK v0.1.5

---

## Executive Summary

The Threadline v0.27.0 work built a **MoltBridge client inside instar** (`src/moltbridge/MoltBridgeClient.ts`) that does NOT align with the actual MoltBridge server API. The client was built against a **spec** rather than the real server, and all tests are mocked — so the mismatches were never caught.

**Severity: HIGH** — If MoltBridge integration is enabled in production, every API call will fail due to path mismatches, authentication gaps, and payload incompatibilities.

Additionally, MoltBridge already ships a published SDK (`moltbridge@0.1.5`) that correctly wraps the real API with Ed25519 auth signing. The instar client reimplements this from scratch, poorly.

---

## 1. MoltBridge Server Health

| Check | Result |
|-------|--------|
| Server running | YES (port 3040) |
| Health endpoint | `{"status":"healthy","uptime":799452,"neo4j":{"connected":true}}` |
| Neo4j connected | YES |
| Last health check | Feb 23, 2026 04:08 UTC |
| Consecutive failures | 1 (from Feb 15) |
| Server version | 0.1.0 |

**The MoltBridge server is alive and healthy.** The single failure on Feb 15 appears resolved.

---

## 2. API Endpoint Mismatches

### 2.1 Registration

| Aspect | Instar Client Sends | MoltBridge Server Expects |
|--------|---------------------|--------------------------|
| **Path** | `POST /v1/agents/register` | `POST /register` |
| **Payload fields** | `canonicalId, publicKey, capabilities, displayName` | `agent_id, name, platform, pubkey, verification_token, omniscience_acknowledged, article22_consent, capabilities, clusters, a2a_endpoint` |
| **Auth** | None (unauthenticated) | None (public endpoint) |
| **Response shape** | Expects `{agentId, registered, needsCrossVerification, needsDeposit}` | Returns `{agent, consents_granted, disclosures_acknowledged}` |

**Mismatches:**
- **CRITICAL: Path prefix** — Server has no `/v1/` prefix. Every call to `/v1/agents/register` returns 404.
- **CRITICAL: Missing required fields** — Server requires `agent_id`, `name`, `platform`, `pubkey`, `verification_token`. Client sends `canonicalId`, `publicKey`, `displayName`. None of these field names match.
- **CRITICAL: Missing verification flow** — Server requires a proof-of-AI `verification_token` from `POST /verify` first. Client skips this entirely.
- **CRITICAL: Missing consent** — Server requires `omniscience_acknowledged: true` and `article22_consent: true`. Client doesn't send either.
- **Response shape mismatch** — Server returns an `agent` node object, not the flat `{registered, needsCrossVerification}` shape.

### 2.2 Discovery

| Aspect | Instar Client Sends | MoltBridge Server Expects |
|--------|---------------------|--------------------------|
| **Path** | `POST /v1/discover` | `POST /discover-capability` (or `POST /discover-broker`) |
| **Payload** | `{capability, limit}` | `{capabilities (array), min_trust_score, max_results}` |
| **Auth** | None | `MoltBridge-Ed25519` signature required |

**Mismatches:**
- **CRITICAL: Path** — `/v1/discover` doesn't exist. Server has `/discover-capability` and `/discover-broker`.
- **CRITICAL: No auth** — Server requires Ed25519 signed `Authorization` header. Client sends no auth at all.
- **Payload shape** — Server expects `capabilities` (array), client sends `capability` (string). Server uses `max_results`, client uses `limit`.

### 2.3 IQS (Trust Score) Query

| Aspect | Instar Client Sends | MoltBridge Server Expects |
|--------|---------------------|--------------------------|
| **Path** | `GET /v1/trust/{canonicalId}` | `POST /iqs/evaluate` |
| **Method** | GET | POST |
| **Payload** | None (path param only) | `{target_id, hops, requester_capabilities, target_capabilities, broker_success_count, broker_total_intros}` |
| **Auth** | None | `MoltBridge-Ed25519` signature required |
| **Response** | Expects `{iqsBand}` | Returns `{band, components, ...}` (full IQS evaluation) |

**Mismatches:**
- **CRITICAL: Path and method** — `GET /v1/trust/:id` doesn't exist. IQS is `POST /iqs/evaluate`.
- **CRITICAL: IQS is not a lookup** — MoltBridge doesn't store pre-computed trust scores per agent. IQS is evaluated on-demand with context parameters. The instar client treats it as a simple lookup.
- **CRITICAL: No auth**.
- **CRITICAL: Missing consent check** — Server requires `iqs_scoring` consent before evaluation.

### 2.4 Attestation

| Aspect | Instar Client Sends | MoltBridge Server Expects |
|--------|---------------------|--------------------------|
| **Path** | `POST /v1/attestations` | `POST /attest` |
| **Payload** | `{attestor, subject, capability, outcome, confidence, context}` | `{target_agent_id, attestation_type, capability_tag, confidence}` |
| **Auth** | None | `MoltBridge-Ed25519` signature required |

**Mismatches:**
- **CRITICAL: Path** — `/v1/attestations` doesn't exist. Server uses `/attest`.
- **CRITICAL: No auth**.
- **Payload shape** — Completely different field names. Server expects `target_agent_id` (not `subject`), `attestation_type` as enum `CAPABILITY|IDENTITY|INTERACTION` (not `outcome`), `capability_tag` (not `capability`).
- **Missing field** — Instar sends `outcome` and `context` which don't exist in the server's schema. Server's `attestation_type` is a different concept.

### 2.5 Status Query

| Aspect | Instar Client Sends | MoltBridge Server Expects |
|--------|---------------------|--------------------------|
| **Path** | `GET /v1/agents/{canonicalId}/status` | No equivalent endpoint |
| **Auth** | None | N/A |

**Mismatches:**
- **CRITICAL: Endpoint doesn't exist** — There is no per-agent status endpoint in MoltBridge. The closest is `GET /status` (localhost-only, returns network-wide stats) or `GET /payments/balance` (returns wallet balance).

---

## 3. Authentication Gap

**This is the most fundamental problem.** The MoltBridge server uses a custom Ed25519 signature scheme for all authenticated endpoints:

```
Authorization: MoltBridge-Ed25519 <agent_id>:<timestamp>:<signature>
```

Where signature covers: `${method}:${path}:${timestamp}:${SHA256(canonical_body)}`

**The instar MoltBridgeClient has ZERO authentication.** It sends bare `fetch()` calls with only `Content-Type: application/json`. Every authenticated endpoint (`/discover-capability`, `/attest`, `/iqs/evaluate`) will return 401 Unauthorized.

The published MoltBridge SDK (`moltbridge@0.1.5`) handles this correctly with its `Ed25519Signer` class. The instar client reimplements the HTTP layer from scratch but skips auth entirely.

---

## 4. SDK Alignment

### Published SDK (`moltbridge@0.1.5`) vs Instar Custom Client

| Feature | Published SDK | Instar Client |
|---------|--------------|---------------|
| Auth signing | Ed25519Signer class, auto-signs all requests | None |
| Registration | Sends correct fields (`agent_id, name, platform, pubkey, verification_token`) | Sends wrong fields (`canonicalId, publicKey`) |
| Verification | `mb.verify()` method for proof-of-AI | Not implemented |
| Discovery | `discoverCapability()` → `POST /discover-capability` | `discover()` → `POST /v1/discover` (wrong) |
| Attestation | `attest()` → `POST /attest` with correct fields | `submitAttestation()` → `POST /v1/attestations` (wrong) |
| IQS | `evaluateIqs()` → `POST /iqs/evaluate` with context params | `getIQSBand()` → `GET /v1/trust/:id` (wrong) |
| Retry logic | Exponential backoff (1s, 2s, 4s) | None |
| Error types | Typed `MoltBridgeError` from response | Generic `Error` |
| Consent | `grantConsent()`, `withdrawConsent()`, etc. | Not implemented |
| Payments | `balance()`, `deposit()`, etc. | Not implemented |
| Webhooks | `registerWebhook()`, `listWebhooks()` | Not implemented |
| Outcomes | `reportOutcome()` | Not implemented |
| Feedback | `reportBug()`, `requestFeature()`, etc. | Not implemented |

**Verdict:** The published SDK is a complete, correct client for MoltBridge. The instar custom client is a reimplementation that gets nearly everything wrong. **The instar client should be replaced with the published SDK.**

---

## 5. Trust/Identity Compatibility

### What instar v0.27.0 built:
- Canonical Ed25519 identity at `identity.json`
- Three-layer trust model (identity, trust, authorization)
- Trust decay, circuit breaker auto-downgrade
- Authorization scopes with time-bounded grants

### What MoltBridge already has:
- Ed25519 identity (agent registers pubkey, server verifies signatures)
- Trust scores computed from import + attestation + cross-verification
- IQS with band-based scoring and anti-oracle protection
- Consent framework (GDPR Article 17/20/22)

### Compatibility Assessment:

**Partially compatible, but needs bridging:**

1. **Key format** — Both use Ed25519, but instar stores raw bytes in `identity.json` while MoltBridge expects base64url-encoded pubkeys and uses the `MoltBridge-Ed25519` signing scheme. **Bridgeable** — the key material is compatible, just needs format conversion and signing logic.

2. **Agent ID** — Instar uses a `canonicalId` (SHA-256 of public key). MoltBridge uses a user-provided `agent_id` string validated by `isValidAgentId()`. These are different concepts. **The instar canonicalId could be used as the MoltBridge agent_id, but this needs explicit mapping.**

3. **Trust model** — Instar's three-layer trust model is local (computes trust based on local history + optional MoltBridge IQS advisory). MoltBridge's trust is graph-based (computed from attestations in Neo4j). **These are complementary, not competing.** Instar's local trust should consume MoltBridge's IQS as an advisory signal, which is the design intent — but the client can't actually fetch IQS because it calls the wrong endpoint.

4. **Attestation model** — Instar's `AttestationPayload` has `{attestor, subject, capability, outcome, confidence, context}`. MoltBridge's `/attest` expects `{target_agent_id, attestation_type, capability_tag, confidence}`. The field names and semantics differ significantly. `outcome` (success/partial/failure) ≠ `attestation_type` (CAPABILITY/IDENTITY/INTERACTION).

---

## 6. Controlled Vocabulary Mismatch

Instar defines 34 capability tags in `CAPABILITY_VOCABULARY`:
```
messaging, email, voice, translation, summarization, code-generation, code-review,
debugging, testing, deployment, data-analysis, data-collection, data-transformation,
visualization, web-research, document-analysis, fact-checking, literature-review,
writing, editing, design, image-generation, video, scheduling, monitoring, alerting,
automation, workflow, legal, financial, medical, scientific, engineering, coordination,
delegation, brokering, teaching
```

MoltBridge server validates capabilities via `validateCapabilities()` middleware — but its vocabulary may differ. The server uses `capabilities` as an array of strings stored in Neo4j, and validation is in the middleware. **These vocabularies need to be synchronized.**

---

## 7. Specific Remediation Steps

### Option A: Replace instar client with published SDK (RECOMMENDED)

1. **Add `moltbridge` as a dependency** in instar's `package.json`
2. **Replace `MoltBridgeClient.ts`** with a thin wrapper around the SDK:
   ```typescript
   import { MoltBridge } from 'moltbridge';
   ```
3. **Wire identity** — Feed instar's canonical Ed25519 key into the SDK's `Ed25519Signer`
4. **Add verification flow** — Before registration, call `mb.verify()` to get a proof-of-AI token
5. **Add consent handling** — Grant omniscience + article22 consent during registration
6. **Update routes.ts** — Adjust payloads to match SDK response shapes
7. **Update tests** — Mock against real API shapes, not imagined ones

### Option B: Fix the custom client (NOT recommended, but documented)

If there's a reason to keep a custom client:

1. **Remove `/v1/` prefix** from all paths
2. **Implement Ed25519 auth signing** — Port the SDK's `Ed25519Signer` logic:
   ```
   Authorization: MoltBridge-Ed25519 <agent_id>:<timestamp>:<base64url(sign(method:path:timestamp:sha256(body)))>
   ```
3. **Fix registration** — Add verification flow, correct field names, add consent flags
4. **Fix discovery** — Use `/discover-capability`, pass `capabilities` array, add auth
5. **Fix IQS** — Change to `POST /iqs/evaluate` with context parameters, add auth
6. **Fix attestation** — Use `/attest`, correct field names, add auth
7. **Remove status endpoint** — It doesn't exist; use payment/balance or profile queries instead
8. **Add retry logic** — The SDK has exponential backoff; the custom client has none

### Option C: Update MoltBridge server to add v1 API routes (NOT recommended)

Adding a `/v1/` versioned API to MoltBridge that matches what instar expects would create maintenance burden and doesn't address the auth gap.

---

## 8. Impact Assessment

### What works today (with MoltBridge disabled):
- Local Threadline discovery (agent-to-agent on same machine) — works
- Relay-based discovery — works
- Three-layer trust model (local trust computation) — works
- Ed25519 identity — works
- Invitations — works
- 227 tests pass (all using mocks)

### What breaks if MoltBridge is enabled:
- Registration → 404 (wrong path)
- Discovery → 404 (wrong path)
- IQS query → 404 (wrong path + wrong method)
- Attestation → 404 (wrong path)
- Status → 404 (endpoint doesn't exist)
- Even if paths were correct → 401 (no auth)

### Risk: 
The circuit breaker will kick in after 3 failures and suppress errors for 5 minutes. This means the system will silently degrade — MoltBridge will appear "unavailable" rather than "misconfigured." Users won't get clear error messages about the real problem.

---

## 9. Test Coverage Gap

All 41 MoltBridge-related tests use `vi.stubGlobal('fetch', ...)` to mock HTTP responses. **Zero tests hit the real server.** The mocked responses match the spec'd (incorrect) response shapes, not the real server's shapes.

**Required:** Integration tests against `http://localhost:3040` that exercise the actual registration → discovery → attestation → IQS flow.

---

## 10. Summary of All Mismatches

| # | Category | Severity | Description |
|---|----------|----------|-------------|
| 1 | Path prefix | CRITICAL | All paths use `/v1/` prefix that doesn't exist on server |
| 2 | Registration path | CRITICAL | `/v1/agents/register` → should be `/register` |
| 3 | Registration fields | CRITICAL | Wrong field names (`canonicalId` → `agent_id`, etc.) |
| 4 | Registration flow | CRITICAL | Missing proof-of-AI verification step |
| 5 | Registration consent | CRITICAL | Missing omniscience + article22 consent |
| 6 | Discovery path | CRITICAL | `/v1/discover` → should be `/discover-capability` |
| 7 | Discovery payload | HIGH | `capability` (string) → `capabilities` (array) |
| 8 | IQS path + method | CRITICAL | `GET /v1/trust/:id` → should be `POST /iqs/evaluate` |
| 9 | IQS semantics | HIGH | Simple lookup vs contextual evaluation |
| 10 | Attestation path | CRITICAL | `/v1/attestations` → should be `/attest` |
| 11 | Attestation fields | HIGH | Completely different field names and semantics |
| 12 | Status endpoint | MEDIUM | `/v1/agents/:id/status` doesn't exist |
| 13 | Authentication | CRITICAL | No auth on any request; server requires Ed25519 signing |
| 14 | Error handling | MEDIUM | No retry logic, no typed errors |
| 15 | SDK duplication | LOW | Custom client reimplements published SDK poorly |
| 16 | Test fidelity | HIGH | All tests mock against wrong response shapes |

**CRITICAL issues: 8** | **HIGH issues: 4** | **MEDIUM issues: 2** | **LOW issues: 1**
