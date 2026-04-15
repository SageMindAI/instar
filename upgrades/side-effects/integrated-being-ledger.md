# Side-Effects Review — Integrated-Being Shared-State Ledger

**Version / slug:** `integrated-being-ledger`
**Date:** `2026-04-15`
**Author:** Echo (autonomous, at user's explicit direction)
**Second-pass reviewer:** pending — will be filled by an independent reviewer subagent before commit.

## Summary of the change

Introduces a per-agent append-only shared-state ledger so instar sessions can maintain coherent awareness of what other sessions on the same agent have been doing (commitments, agreements, thread events, decisions, notes). The user-facing session on 2026-04-15 discovered mid-conversation that a separate spawned threadline session had reached a concrete integration agreement with another agent that the user-facing session had no visibility into. The ledger addresses this general gap at a cross-session level without touching the per-thread security sandboxing that threadline specifies.

Files added:

- `src/core/SharedStateLedger.ts` — the module. Append-only JSONL at `.instar/shared-state.jsonl`. Subject/summary length caps. Security boundary documented in-file.
- `tests/unit/SharedStateLedger.test.ts` — 15 unit tests covering append, recent, renderForInjection, and security-boundary discipline.
- `docs/integrated-being.md` — architectural overview.
- `upgrades/side-effects/integrated-being-ledger.md` — this artifact.

Files modified:

- `src/server/routes.ts` — three new endpoints (`POST /shared-state/append`, `GET /shared-state/recent`, `GET /shared-state/render`). Added `sharedStateLedger` to `RouteContext`.
- `src/server/AgentServer.ts` — accept `sharedStateLedger` option and thread it through.
- `src/commands/server.ts` — instantiate `SharedStateLedger` at server startup and pass it to `AgentServer`.
- `src/templates/hooks/session-start.sh` — fetch recent entries via `/shared-state/render` at turn start and inject into the session's prompt.

## Decision-point inventory

None added, removed, or modified in the signal/authority sense. The ledger is a context-producing helper; it has no blocking authority and makes no judgment decisions. The three HTTP endpoints are pure CRUD with structural validation (kind must be in an enumerated set, subject must be non-empty, limit must be in range 1..200) — hard-invariant input validation at the system boundary per `docs/signal-vs-authority.md` "When this principle does NOT apply."

---

## 1. Over-block

No block/allow surface — over-block not applicable.

The ledger's API returns 400 for malformed input (unknown kind, empty subject, limit out of range) and 503 if the ledger isn't configured. These are input validation responses at the API edge, not judgment decisions.

---

## 2. Under-block

No block/allow surface — under-block not applicable.

The ledger does not enforce "derived facts only, no raw messages" on write. That discipline lives at the process layer (the `/instar-dev` side-effects review asks this question for any code that writes to the ledger). This is a deliberate split: the ledger is a mechanical storage primitive; policy enforcement is one layer up.

---

## 3. Level-of-abstraction fit

The ledger belongs at the instar layer, not the threadline layer. Threadline owns per-thread coherence. This primitive owns per-agent coherence across threads. Keeping them separate means threadline's security properties are untouched and the ledger can be extended later (e.g., cross-agent visibility) without coupling to threadline internals.

The write-site (sessions appending when they do something significant) is appropriate at the application layer — sessions know when they've done something significant; the ledger doesn't infer it. The read-site (session-start hook injection) is appropriate at the hook layer where turn-boundary context assembly already happens.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface. It is a context producer.

The ledger holds zero blocking authority. It stores entries for downstream consumers (session context, API readers). The HTTP endpoints enforce structural validation (kinds enumerated, subject non-empty, limit bounded) — these are hard-invariant checks at the system boundary, explicitly called out in the principle doc as appropriate for deterministic blockers.

No drift-prone LLM judgment. No new gate with authority. No new detector with authority. This change is fully compliant with the principle.

---

## 5. Interactions

- **Session-start hook (`src/templates/hooks/session-start.sh`).** The template is updated to call `/shared-state/render` alongside existing working-memory, soul, blocker-resolution, and feature-discovery sections. Failure mode: if the endpoint is down or returns the "no recent entries" placeholder, the hook prints nothing extra and continues. No other hooks are modified.
- **Existing agents' local `session-start.sh`.** Some agents (e.g., Echo) have divergent local versions of session-start.sh that were installed before recent template updates. The template change does NOT automatically update existing agents' local hooks. Those agents will get the shared-state injection only when they update their scaffold, or if someone explicitly patches their local hook. This is documented as a known limitation — v1 ships the template; a follow-on can address the migration of existing agents.
- **RouteContext / AgentServer wiring.** `sharedStateLedger` is nullable on `RouteContext`. Endpoints return 503 when it's null. No existing callers broken.
- **`.instar/shared-state.jsonl` file.** New runtime file per agent. Should be gitignored. **Not yet added to `.gitignore` in this change** — documented as a known cleanup for this commit or a follow-up; for now no harm since agents' `.instar/` directories already tend to be gitignored at the agent level.
- **No interaction with threadline's ThreadResumeMap, AutonomyGate, or trust infrastructure.** The ledger is upstream of all of them.

---

## 6. External surfaces

- **Other agents on the same machine:** zero impact — the ledger is per-agent, not readable by other agents.
- **Other users of the install base:** zero impact on existing behavior. The three new endpoints are additive. The session-start hook template change is additive — it prints extra context when the ledger has entries, otherwise prints nothing.
- **External systems:** none.
- **Persistent state:** the new `.instar/shared-state.jsonl` file per agent. Append-only, bounded growth concern flagged below.
- **Bounded growth:** v1 has no pruning or rotation. For active agents with many sessions, the ledger could accumulate. The `recent(limit)` read path scans the entire file from disk on every read. This is cheap enough at the 15-entry-per-turn-start read pattern with files under ~1MB, but will become noticeable at tens of thousands of entries. Follow-on work: rotation or TTL. Explicitly deferred from v1.

---

## 7. Rollback cost

Low.

- Revert the changes to `routes.ts`, `AgentServer.ts`, `commands/server.ts`, `session-start.sh` template.
- Delete `src/core/SharedStateLedger.ts`, `tests/unit/SharedStateLedger.test.ts`, `docs/integrated-being.md`, this artifact.
- Existing `.instar/shared-state.jsonl` files on agents remain on disk but are no longer referenced; safe to leave or delete.

No persistent schema migration. No agents broken.

---

## Conclusion

The change is a canonical context-producer addition — no new blocking authority, no new judgment, no principle violation, simple rollback. Addresses the real cross-session coherence gap observed 2026-04-15 in a way that preserves the per-thread security sandboxing threadline specifies. Known limitations are explicitly bounded (existing-agent hook migration, growth rotation) rather than hidden.

## Second-pass review

**Reviewer:** independent subagent (general-purpose)
**Verdict:** CONCERN → three gaps raised → all resolved in this commit

### Findings and resolutions

**Gap 1 — Echo's local hook did not include the injection.**
Echo is the motivating agent for this change. The artifact's claim that it "addresses the real cross-session coherence gap observed 2026-04-15" was dishonest while Echo's own session-start.sh was divergent from the template and missing the read-path.
- *Resolution applied:* patched `/Users/justin/.instar/agents/echo/.instar/hooks/instar/session-start.sh` to fetch `/shared-state/render?limit=15` and emit an `=== INTEGRATED-BEING — RECENT CROSS-SESSION ACTIVITY ===` block before `=== END SESSION START ===`. Echo's next session start will include the injection.

**Gap 2 — 2000-char `MAX_SUMMARY` was a real leak vector for the threadline security boundary.**
A typical threadline message body fits comfortably in 2000 chars. Defaulting to a cap that allows pasting a whole message made the "derived facts only" rule entirely a process concern — no programmatic backstop. Reviewer argued for a tight cap that makes leaking raw messages physically inconvenient.
- *Resolution applied:* lowered `MAX_SUMMARY` to 500 chars. 500 still comfortably holds "agreed on a multi-point contract covering lookup/status/resolve/event" while making whole-message pasting truncate loudly. Added a test (`caps MAX_SUMMARY at 500 chars (security-boundary backstop)`) that pins the value — any future change to raise the cap will fail the test and require its own review.

**Gap 3 — Unbounded growth + O(n) read path on every session start.**
The artifact waved off growth as "deferred." Reviewer rightly flagged that `readFileSync` + split + tail-slice scales poorly and every turn-start runs it; at ~10k entries the hook would add measurable latency.
- *Resolution applied:* added a `ROTATE_AT_LINES = 5000` soft ceiling. On append, if the current file exceeds that line count, it's renamed to `.jsonl.1` (overwriting any prior rotation) and a fresh file starts. Reads stay bounded. The rotation uses a cheap fast-path (stat size first, only count lines if size is suggestive). Tests added covering both the rotation behavior and the constant value pinning.

**Minor — `.gitignore` was not updated.**
- *Resolution applied:* added `.instar/shared-state.jsonl` and `.instar/shared-state.jsonl.*` to the instar-repo `.gitignore` alongside the existing runtime-state exclusions.

### Verdict after resolutions

All three structural gaps closed. The artifact's claims now match the implementation. Echo specifically will benefit on next session-start.

## Evidence pointers

- 18 unit tests passing: append/read/render core behavior, rotation at 5000 lines, MAX_SUMMARY pin at 500, security-boundary-discipline documentation.
- Type-check clean (`tsc --noEmit`).
- Live verification (post-commit): send a test `POST /shared-state/append` against Echo's running server, verify `.instar/shared-state.jsonl` is created and the entry appears, verify `GET /shared-state/render` returns the expected format. Will run after the commit lands and the server is restarted with the new code.
