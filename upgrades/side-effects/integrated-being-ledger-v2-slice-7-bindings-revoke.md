# Side-Effects Review — Integrated-Being Ledger v2, Slice 7 (Bindings + revoke)

**Version / slug:** `integrated-being-ledger-v2-slice-7-bindings-revoke`
**Date:** `2026-04-17`
**Author:** Echo
**Second-pass reviewer:** required — revoke is a session kill (high-risk list: "session lifecycle: spawn, restart, kill, recovery").

## Summary

Slice 7 lands the session-binding visibility + revocation surface:

- `GET /shared-state/sessions` — returns the list of registered sessions in the summary form (no tokenHash, no plaintext). Powers the dashboard Bindings subtab.
- `POST /shared-state/sessions/:sid/revoke` — bearer-authed + `X-Instar-Request: 1` intent header. Marks the session revoked (token hash stays on disk until the next cleanup tick, but verify() now returns `ok=false, reason=revoked`). Emits a subsystem-asserted note entry `session binding revoked: <sid>` so the audit trail is preserved.
- Dashboard Bindings subtab on the Integrated-Being tab — lists sessions with registered-at / last-active / absolute-TTL / status columns, plus a Revoke button that prompts confirm and POSTs to the revoke endpoint.

User-resolve path via PIN-unlock is still deferred (it needs separate PIN infrastructure). For now, interactive resolve happens via the agent's session calling its own resolve endpoint — the dashboard is observability + binding-management only.

Files touched:

- `src/server/routes.ts` — two new endpoints (~90 LOC)
- `dashboard/index.html` — Bindings section HTML + loadBindings/revoke JS (~100 LOC)
- `tests/unit/sharedStateRoutesV2.test.ts` — 5 new tests covering list + revoke auth + 404 + malformed + audit-note

## Decision-point inventory

| Decision point | Change | Description |
|---|---|---|
| `/sessions` read auth | **add** | Bearer-token gate via existing middleware. Structural. |
| `/sessions/:sid/revoke` intent-header gate | **add** | Hard-invariant structural check: `X-Instar-Request: 1` required. Existing convention. |
| sessionId format gate | **add** | UUIDv4 regex. Structural. |

All structural. No judgment.

## 1. Over-block

- `X-Instar-Request: 1` header is strict — a well-formed request without it gets 403. Matches the convention used by backup triggers and config edits. Acceptable.
- Revocation on an already-revoked session: the underlying `registry.revoke()` is idempotent and returns `true` for a re-call — the endpoint thus returns 200 with `revoked: true` on duplicate calls. An audit note is written each time — which is a feature, not a bug (the audit trail preserves every revocation action).

## 2. Under-block

- A bearer-token holder can revoke ANY session. The session-bind privilege-separation gap called out in the spec's open architectural questions still applies — the bearer gate is shared with the session-write surface, so a compromised bearer token can both write-as-session AND revoke any session. Acceptable for v2 given the deferral; v2.1's privileged-channel isolation is where this truly closes.
- Revoked sessions' binding token files on disk are NOT immediately deleted — they're cleaned up on the next `purgeExpired()` sweep. An adversary with filesystem access could read the stale plaintext file before cleanup. Mitigation: file mode 0o600 (set in hook); adversary would need the same user as the server process. Not a new vector — same as any other binding file.

## 3. Level-of-abstraction fit

Endpoints live in routes.ts next to the other `/shared-state/*` routes. Revoke calls `registry.revoke()` (existing method from slice 1) and writes an audit note via the ledger. Dashboard reads raw sessions from the endpoint and renders client-side. All layers correctly placed.

## 4. Signal vs authority compliance

- [x] No — all new blockers are carved-out structural/auth. The revoke endpoint's X-Instar-Request check is the existing user-intent attestation convention, NOT judgment-shaped. Per signal-vs-authority doc §"When this principle does NOT apply": hard-invariant validators at the API boundary are allowed brittle blockers.

## 5. Interactions

- **Shadowing:** revocation causes all subsequent `verify()` calls for that session id to return `ok=false, reason=revoked` — session writes after revoke fail 401. Verified via slice-1 test `rejects revoked session`.
- **Double-fire:** re-revoking is idempotent but writes a new audit note each time. Intentional — the audit trail preserves duplicate actions.
- **Races:** revoke in parallel with an in-flight write: single-threaded event loop means the write's `verify()` call either happens before revoke (succeeds) or after (fails 401). No partial-write hazard.
- **Feedback loops:** the audit note is emitted with `subsystem-asserted` provenance via subsystem 'session-manager'. It is NOT a commitment, does NOT supersede a commitment, so no downstream sweeper or emitter fires on it.

## 6. External surfaces

- Dashboard users see a new Bindings subtab on the Integrated-Being tab when v2Enabled=true. v1 agents see nothing (the subtab hides when the endpoint returns 503).
- No external-system changes.

## 7. Rollback cost

- Pure code revert. The audit notes already written remain in the ledger (harmless). Revoked sessions stay revoked (their hash is still in the registry file). No migration.

## Conclusion

Slice 7 closes the session-visibility + revocation loop. Combined with slices 1-6, v2 is now feature-complete enough for a 7-day observation window behind v2Enabled=true. 143 tests pass; typecheck clean.

What's NOT in v2 and explicitly deferred to v2.1:

- Session-bind privilege separation (any bearer-holder can mint a token or revoke).
- Interactive-bind challenge-response (currently time-window attestation only).
- Formal status state machine.

What's NOT in v2 and tracked as "slice 8 — hardening" (not blocking observation):

- user-resolve via PIN-unlock (requires separate PIN-unlock infrastructure).
- scheduled-job subsystem-verify via polling (auto-resolve when referenced job finishes).
- Full NFKC + Unicode confusables dedup index.
- Trust-tier resolution + discrepancy emission.
- Per-agent-global write ceiling.

All five are documented pre-flip hardening; v2 ships without them and the dashboard/sweeper loop is functional. Ready for second-pass.

---

## Second-pass review

**Reviewer:** independent subagent (Phase 5).
**Verdict:** **CONCUR with two non-blocking observations.**

### Verification summary

- **Auth gates**: Bearer + `X-Instar-Request: 1` is the established convention for user-authoritative structural actions. Revoke's blast radius is genuinely lower than user-resolve (revoke is idempotent, non-state-shaping). PIN-unlock parity for revoke would be disproportionate.
- **Audit note**: provenance=subsystem-asserted, subsystem=session-manager. Test asserts explicitly. Note is kind='note' (not commitment) so no sweeper cascade.
- **Session id regex**: matches `LedgerSessionRegistry.SESSION_ID_RE`. Consistent.
- **revoke() idempotence**: unknown → false, already-revoked → true (no mutation), fresh → mutate + persist. Non-destructive of audit trail.
- **Error-path order**: registry state mutated first, audit note best-effort — correct, revocation is the safety action.

### Non-blocking observations

1. **DedupKey `Date.now()` collision window**: on a single-node event loop ms-granular is sufficient; truly same-ms double-POST would dedup-suppress one audit note — acceptable since the second revoke is idempotent anyway.

2. **CSRF surface**: the `X-Instar-Request` header is a custom non-safelisted header → forces CORS preflight on cross-origin attempts. Dashboard + endpoint share the bearer-auth gate. No new CSRF vector beyond the existing backup-trigger surface.

### Verdict

Ready to flip behind `v2Enabled=true` for the 7-day observation window — with the five "slice 8 hardening" items explicitly tracked.
