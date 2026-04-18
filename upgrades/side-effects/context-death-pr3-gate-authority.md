# Side-Effects Review — Context-Death PR3 (gate authority + persistence + routes)

**Version / slug:** `context-death-pr3-gate-authority`
**Date:** `2026-04-18`
**Author:** `Echo (instar-developing agent)`
**Spec:** `docs/specs/context-death-pitfall-prevention.md` § (b), (d)
**Phase / PR sequence position:** PR3 of 8
**Second-pass reviewer:** **REQUIRED** — this PR introduces the actual decision-point (the only blocking authority in the whole spec). Phase 5 review will append below.

## Summary of the change

Lands the core decision-point the rest of the spec exists to feed. Three modules:

- **`src/core/UnjustifiedStopGate.ts`** (NEW) — the LLM authority. Enumerated rule set (9 ids total, frozen at module scope); decision/rule class coherence check; evidence pointer must match the hook-enumerated `evidence_metadata.artifacts` by exact path + SHA; free-text rationale logged only (never sent to agent); server-assembled reminder templates (no prompt-injection path to the agent); client-side hard `AbortController(2000ms)` buffering the 1800ms server budget; structural fail-open on timeout / malformed / invalidRule / invalidEvidence / llmUnavailable.
- **`src/core/StopGateDb.ts`** (NEW) — SQLite persistence. Six tables per spec § (d): `sessions`, `session_continue_counts`, `session_stuck_state`, `events` (decision log), `annotations` (operator review), `agent_eval_aggregate` (daily rollup). WAL journal; 0600 file perms; `:memory:` supported for tests.
- **`src/server/routes.ts`** (MOD) — four new routes under `/internal/stop-gate/*`:
  - `POST /internal/stop-gate/evaluate` — the hot path. Respects mode=off / kill-switch short-circuit → `allow`. Calls the authority, validates evidence, writes the event + rollup, returns `{eventId, decision, rule, reminder, latencyMs}`. Fail-open on every error path with a DegradationReporter event so guardian-pulse (PR0c consumer) surfaces it.
  - `GET /internal/stop-gate/log?tail=N` — read recent events.
  - `POST /internal/stop-gate/annotations` — operator verdict + rationale + dwell time.
  - `GET /internal/stop-gate/annotations/:eventId` — read annotations for an event.
- **`src/server/AgentServer.ts`** (MOD) — extended constructor options and `RouteContext` to carry `unjustifiedStopGate` and `stopGateDb` (both nullable — missing ⇒ route fail-opens with a clear failure kind).

Tests:

- **`tests/unit/UnjustifiedStopGate.test.ts`** (NEW) — 18 tests: rule-set constants sanity, class predicates, happy-path for all three decision types, structural defense enforcement (invented rule, decision/rule class mismatch, missing pointer, hallucinated plan_file, hallucinated plan_commit_sha, non-JSON response, invalid decision value), timeout fail-open, LLM-error fail-open, `assembleReminder` template behavior for every rule class.
- **`tests/unit/StopGateDb.test.ts`** (NEW) — 12 tests: schema + persistence round-trip; fail-open event shape; continue-count atomicity; stuck-state flag; session-start idempotency (first wins); aggregate rollup accumulation; annotation storage + ordering; SQL CHECK constraint rejection of invalid verdicts; `dayKeyFor` UTC correctness.

## Explicitly NOT in PR3 — deferred to PR3b (follow-up polish)

Per the scope triage: PR3 ships the **functional** gate — what's required to flip PR4 (shadow mode) and start collecting data. The operator tooling is a separate polish PR:

- **Stop-hook bash router** — the hook that actually calls `POST /internal/stop-gate/evaluate`. The spec's router pseudocode (§ (b)) is implementable as a shell extension to `.instar/hooks/instar/autonomous-stop-hook.sh`; defers to PR3b so the bash surface is reviewed in its own small artifact.
- **Dashboard tab** — the operator-facing view of the event log + inline annotation UI (`/dashboard/stop-gate`).
- **`instar gate review` CLI** — terminal annotation tool with the 15s-dwell constraint.

None of these are required for the gate to *function* — PR3's routes are enough for a cURL-driven annotation workflow and a manually-triggered hook probe. PR3b adds the polish that the enforce-flip criteria (PR5) eventually require.

## Decision-point inventory

**THIS IS THE DECISION POINT.** The whole spec converges here:

- The authority (`UnjustifiedStopGate.evaluate`) is the sole entity that can say `continue` — which the evaluate route turns into a Stop hook `decision: block` with the server-assembled reminder. Every other component in the spec is either a signal producer (detectors, sentinel, hot-path), a signal consumer (guardian-pulse), or plumbing (SQLite, hot-path state).
- The decision-point is structurally constrained:
  - Nine enumerated rule ids; citations outside the set are automatic fail-open.
  - Evidence pointer must be a verbatim match against server-collected artifacts.
  - Reminder text is template-filled by the server from validated pointer values. The authority cannot contribute free text to the agent's context window.
  - Fail-open on every failure mode (timeout, malformed, invalid rule, invalid evidence, LLM unavailable). The default is always `allow`.

No other decision points introduced in this PR. The evaluate route's routing is structural (kill-switch > mode-off > authority call > persistence > response) — no judgment calls in the routing logic itself.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- **Legitimate stops with context-preservation phrasing in the stop reason.** e.g. agent says "stopping to preserve context before the design question I need Justin to answer" — the authority evaluates, correctly cites `U_LEGIT_DESIGN_QUESTION`, returns `allow`. The reminder is empty; hook exits 0. Not over-blocked.
- **Legitimate stops without rich evidence.** e.g. agent genuinely hit an error and the stop reason says so — authority cites `U_LEGIT_ERROR`, allows. Not over-blocked.
- **Genuine completion.** Stop reason says work is done — authority cites `U_LEGIT_COMPLETION`. Not over-blocked.
- **Self-reference case.** Agent is working on stop-gate-related files — the `meta_self_reference_hint` is set by the self-reference pre-check; authority cites `U_META_SELF_REFERENCE` if the majority-canonical threshold fires. If not, it evaluates normally with the hint.

**Residual over-block risk:** authority falsely cites `U1/U2/U3` on a stop that was actually legitimate. The reminder gets emitted and the agent sees it. If the agent legitimately needed to stop, the reminder says "continue — re-read the plan" which is benign guidance the agent can ignore. Worst case: one wasted turn. This is acceptable per the spec's drift-correction threat model; catastrophic over-block doesn't exist because the reminder never does anything destructive.

## 2. Under-block

**What failure modes does this still miss?**

- **Authority fails open on any error.** Spec-designed: we'd rather fail-open and log than fail-closed and strand the agent.
- **Authority hallucinates a valid-looking rule+pointer for a legitimate stop.** The evidence_metadata check catches hallucinated paths/SHAs. But within the enumerated set, the authority could still pick `U_LEGIT_ERROR` when the agent was really doing a drift stop. That's the "LLM is wrong sometimes" failure mode; the spec accepts this via shadow-mode measurement + operator annotation.
- **Session adversarial stop-reason injection.** `untrusted_content` is passed as JSON with a system-instruction to treat it as data. An adversarial session could craft text that tries to flip the authority's decision. Per spec threat model: out of scope. Drift-correction accepts this.
- **Server restart mid-session.** In-memory continue-count and stuck-state ARE persisted in SQLite (spec § (d)); restart survives them. SessionStartTs persistence landed in PR0a as in-memory; PR3's SQLite schema has a `sessions` table the evaluate route can eventually populate via a `/internal/session/started-at` write from the SessionStart hook. Not wired in this PR; PR0a's in-memory fallback remains active.

## 3. Level-of-abstraction fit

- **Authority as a class** (not a function) because it needs per-instance config (timeouts, token budgets) and a provider dependency. Class instance is owned by `AgentServer`, passed through `RouteContext`.
- **DB as a class** because it holds prepared statements + PRAGMAs. One instance per server process.
- **Routes in the main `routes.ts`** — keeps all HTTP surface in one file per repo convention. Could split into `src/server/stopGateRoutes.ts`; I kept it inline because the existing `/internal/stop-gate/*` routes (from PR0a) are already there and splitting would fragment the surface.
- **Reminder template in the authority module** — tightly coupled to the rule set (same strings, same validation). Lives with the rules.

## 4. Signal vs authority compliance

`docs/signal-vs-authority.md` — this PR IS the authority the principle describes. Detectors (regex signals from PR0a/PR0b, compaction probe, autonomousActive, continuePingIntent) feed the hot-path read; the authority consumes them and is the sole blocker. No other blocker introduced.

Structural checks — rule enumeration + evidence-pointer enumeration — are brittle *signals* that gate the authority's output, not independent authorities themselves. If they fail, the authority's output is REJECTED (fail-open), never *overridden* toward a different decision. This is the correct shape: brittle logic guarding authority output, not producing decisions.

## 5. Interactions

- **Kill-switch short-circuit** (PR0a state) precedes the authority call. `killSwitch=true` → `allow` without invoking the authority. Correct.
- **mode=off short-circuit** — same pattern. `mode='off'` → `allow`. Correct.
- **DegradationReporter** — every fail-open path calls `report()` with a distinct feature id (`unjustifiedStopGate.timeout` / `.malformed` / `.invalidRule` / etc.). Guardian-pulse (PR0c consumer) surfaces these per the daily digest.
- **Agent-eval aggregate** — rollup runs inline on each evaluate call. No separate rollup job; sufficient for drift-correction telemetry. If aggregate becomes hot, PR4/PR5 can extract to a periodic job.
- **Back-pressure** — 8 in-flight evals/machine isn't enforced in this PR. The spec calls for admission-control 503 on queue-shed (§ "Concurrency"); defers to PR3b alongside the hook router which is what drives concurrency.
- **Cold-start** — authority warm-up within 5s of listen: not in this PR. Defers to PR3b.

## 6. External surfaces

- New HTTP routes under `/internal/stop-gate/*`. Auth middleware applies. Tunnel-reachable like all internal routes (accepted under drift-correction threat model per spec).
- New exports: `UnjustifiedStopGate`, `assembleReminder`, rule constants, `StopGateDb`, types.
- SQLite file at `~/.instar/<agent>/server-data/stop-gate.db` — new side-effect on disk. 0600 perms. Not backed up by default per spec § P0.8.
- No changes to: session lifecycle, dispatch, outbound messaging, coherence, trust, or any existing gate.

## 7. Rollback cost

Moderate:

- Revert the commit.
- Existing `stop-gate.db` files stay on disk — agents who had the server running will have an orphaned SQLite file. Harmless (no code reads it after revert); can be deleted via `rm ~/.instar/*/server-data/stop-gate.db`.
- No other data migration needed.
- `RouteContext` additions are nullable; a revert cleanly removes them.

If only the authority's decisions are bad (false positives/negatives), the cheaper fix is to flip kill-switch: `curl -X POST /internal/stop-gate/kill-switch -d '{"value":true}'`. Takes ≤1s, routes immediately short-circuit to `allow`. No revert needed.

## Tests

- `tests/unit/UnjustifiedStopGate.test.ts` — 18 tests, all passing.
- `tests/unit/StopGateDb.test.ts` — 12 tests, all passing.
- `npm run lint` (tsc --noEmit) — clean.
- **Missing from this PR, scoped to PR3b:** integration test that spawns a test server with a fake IntelligenceProvider and drives the evaluate endpoint end-to-end via HTTP. Current route-level evidence is via the module tests + hand-review of the route handler.

## Phase 5 second-pass review

See appended review below (reviewer subagent output).

## Phase 5 Second-Pass Review

**Reviewer:** independent subagent (not the author)
**Reviewed at:** 2026-04-18
**Verdict:** CONCERN RAISED

The authority module itself (`UnjustifiedStopGate.ts`) is well-constructed — the enumerated rule set, class-coherence check, evidence-pointer verbatim-match against `evidence_metadata.artifacts`, and template-only reminder assembly are correctly implemented. Signal-vs-authority separation inside the module is clean (structural checks gate authority output via fail-open, never override toward a different decision). SQL is prepared-statements-only with no dynamic concatenation; `INSERT ... ON CONFLICT ... RETURNING` gives atomic continue-count increment. Fail-open paths in the authority are correctly wired (timeout / malformed / invalidRule / invalidEvidence / missingPointer / llmUnavailable all produce `AuthorityOutcome.ok=false`, route responds with `decision:'allow'`).

However, the **evaluate route composition** ships with three material gaps that drop defense-layer count below what the spec's signal-vs-authority table (§ "Signal-vs-authority compliance") and § (b) Outcomes require for a decision-point PR. These are NOT the deferred PR3b polish items (bash hook, dashboard tab, review CLI) — they are route-side structural defenses the spec enumerates as present in PR3's authority layer.

### Concerns

- **Severity:** **critical**
- **Finding:** `/internal/*` routes bypass bearer-token authentication entirely. `src/server/middleware.ts:74-83` short-circuits with `next()` on any localhost request — no Authorization header required. Includes `POST /internal/stop-gate/kill-switch` and `POST /internal/stop-gate/evaluate`.
- **Reasoning:** Spec P0.5 explicitly says `/internal/*` is "bearer-token authenticated using `.instar/config.json#authToken`" and that server must reject tunnel-originated requests via `X-Forwarded-For`. Under current code, any local process (including non-instar processes on a shared machine, or a misconfigured Cloudflare tunnel that terminates to localhost) can flip the kill-switch or submit arbitrary evaluate payloads. The drift-correction threat model does not cover "any local process," only "the session itself." This weakens the kill-switch's function as a rollback tool.
- **Recommendation:** Remove the localhost-early-return in `authMiddleware` for `/internal/*` paths. Localhost check should be additive (defense-in-depth) rather than replacing bearer auth. Also add the `X-Forwarded-For` rejection specified in spec P0.5.

- **Severity:** **major**
- **Finding:** Per-session continue ceiling (N=2 → `force_allow`) and stuck-state flag are NOT wired into the evaluate route. `incrementContinueCount` and `setStuck` exist in `StopGateDb` and are tested, but `src/server/routes.ts` evaluate handler never calls them. A `continue` decision is returned as-is regardless of how many prior continues this session has received.
- **Reasoning:** Spec § (b) Outcomes lines 314-317 and the signal-vs-authority table row "Per-session continue ceiling" call this out as a structural defense against runaway authority judgment. Without it, a mis-calibrated authority (e.g. Haiku returning `continue` on every turn) loops the session indefinitely; the server-SQLite ceiling is the designed brake. This is the only defense that catches "authority consistently wrong on the same session" — other mitigations (kill-switch, mode flip) require operator intervention.
- **Recommendation:** On authority `continue` outcome, call `db.incrementContinueCount(sessionId)`; if the new count > 2, override to `force_allow`, call `db.setStuck(sessionId)`, emit attention-queue entry, return `decision:'allow'` with `forceAllow:true` in the response and `null` reminder. Add a test covering: third continue in same session returns `allow`+`forceAllow:true` and writes stuck-state. This also closes the race question from your Phase 5 checklist item #7 — the SQLite atomic increment is already correct, it just isn't invoked.

- **Severity:** **major**
- **Finding:** Server-side post-verifier structural checks (spec § (b) "Evidence pointer" lines 273-281) are absent. Spec enumerates 5 checks: (1) `plan_commit_sha` exists in local git object DB, (2) `plan_file` ctime unchanged since T0, (3) `incremental_commit_sha` is a descendant of `plan_commit_sha`, (4) `.git/HEAD` unchanged since T0, (5) at least one artifact is NOT `createdThisSession`. Only a weaker version of (5) is implicit in the "pointer-in-enumerated-set" check, and the rest are not implemented. The signal-vs-authority table lists "Evidence post-verifier" as a structural gate with `invalidEvidence` blocking authority.
- **Reasoning:** The spec frames these as best-effort, not adversarial-proof — but their absence means the ONLY anti-hallucination defense on `continue` decisions is "path string appears in the artifact array the same request supplied." A cold-cache / race-corrupted hook payload could carry stale artifacts and the authority could cite them; the spec's T0-anchored checks are the whole point of "server-verified." Under the drift threat model, these checks catch authority confusion, not attack — which is exactly what this PR exists to catch.
- **Recommendation:** Extract a `postVerifyEvidence(evidence, pointer): { ok: boolean; failure?: 'invalidEvidence'; detail?: string }` helper. Call it after `validateResponse` in the evaluate route; on failure, log with `invalidKind:'invalidEvidence'` and fail-open. Tests: synthesize an artifact set with a `plan_commit_sha` that doesn't exist in the git DB; assert invalidEvidence. If implementation cost is high, the minimum viable version is check (5) — reject `continue` if ALL artifacts are `createdThisSession:true`.

- **Severity:** **minor**
- **Finding:** `events` table has no CHECK constraint on `mode` or `decision` values (only `annotations.verdict` has one). `insertEvent` uses `INSERT OR REPLACE`, which silently overwrites on eventId collision rather than failing loudly.
- **Reasoning:** EventId is crypto.randomUUID so collision is effectively impossible in practice, but the surprising semantics (replace-on-collision) would mask a bug in event-id generation. Missing CHECK means a typo in the route handler could silently persist `decision:'blok'` without surfacing.
- **Recommendation:** Add `CHECK(mode IN ('off','shadow','enforce'))` and `CHECK(decision IS NULL OR decision IN ('continue','allow','escalate','force_allow'))` to the `events` DDL. Change `INSERT OR REPLACE` to plain `INSERT`; collision becomes a loud SQL error rather than silent data loss.

- **Severity:** **minor**
- **Finding:** `continue` decisions with rule `U1_DURABLE_ARTIFACT_CONTINUATION_SAFE` or `U3_RECENT_COMMIT_PROVES_INCREMENTAL` are accepted with only `plan_file` set — `plan_commit_sha` and `incremental_commit_sha` are treated as optional at validation (`UnjustifiedStopGate.ts:392-413` checks only if present). The assembleReminder template renders `<unknown>` in place of a missing SHA.
- **Reasoning:** Spec § (b) system prompt says "required for continue" for each pointer slot for U1/U3. Emitting a reminder saying "last commit `<unknown>` proves incremental progress" is a weak reminder that leaks validation slack to the agent. U2 is legitimately plan-file-only; U1/U3 should require their commit pointers.
- **Recommendation:** In `validateResponse`, when `rule === 'U1_DURABLE_ARTIFACT_CONTINUATION_SAFE'` require both `plan_commit_sha` and `incremental_commit_sha`; when `rule === 'U3_RECENT_COMMIT_PROVES_INCREMENTAL'` require `incremental_commit_sha`. Missing → `missingPointer`. Test each case.

- **Severity:** **minor**
- **Finding:** The self-reference exemption pre-check (spec § "Self-reference exemption" lines 286-298) is NOT in the evaluate route. The author's over-block analysis (§ 1) claims the `meta_self_reference_hint` is set by a pre-check, but no such pre-check exists in the shipped route.
- **Reasoning:** The spec places this pre-check BEFORE authority invocation, with a specific majority-of-modified-files rule that routes directly to `allow` with `rule: U_META_SELF_REFERENCE`. The authority CAN still cite `U_META_SELF_REFERENCE` on its own, which handles the case — so this is structural-fast-path-missing, not correctness-missing. Leaving it out means every self-reference stop pays the full LLM round-trip + latency budget. Tolerable for shadow mode; should land before enforce-flip.
- **Recommendation:** Either implement the pre-check in the evaluate route OR update the side-effects artifact § 1 to note the pre-check is deferred to PR3b alongside the hook router (the hook is a more natural home for it since it has the session's modified-path set already).

### Issue count

**1 critical, 3 major, 2 minor.**

The critical (auth bypass on `/internal/*`) must be fixed before this PR merges — it blows a hole in the kill-switch's premise that operator-only can toggle it. The two major findings (missing per-session ceiling + missing post-verifier) represent structural defenses the spec explicitly lists in the signal-vs-authority compliance table as present in this layer; shipping PR3 without them ships an under-defended decision-point even in shadow mode (the `force_allow` brake protects against the exact "authority mis-calibrated" failure the PR4 data-collection is meant to detect). Minor findings are cleanup.

The author's claim that "PR3's routes are enough for a cURL-driven annotation workflow" is accurate — but the spec's PR3 scope is not just "enough to collect data," it is "the authority + its structural guards." Data collection without the guards means the shadow-mode dataset doesn't reflect enforce-mode behavior, weakening PR4→PR5 signal.

**Recommendation to author:** address the critical and two majors in PR3 before flip-to-ready; minors can land in PR3b with the bash hook/dashboard/CLI polish.

---

## Author response (2026-04-18, iteration after review)

All four blockers addressed in-PR before commit. Code changes:

- **Critical — `/internal/*` auth bypass** → fixed in `src/server/middleware.ts`. Removed the localhost-only early-return for `/internal/*`; now localhost is a defense-in-depth *additive* check that runs FIRST, followed by the standard bearer-token validation. Also added `X-Forwarded-For` rejection per spec P0.5. New tests in `tests/unit/middleware-internal-auth.test.ts` (5 passing): missing Authorization → 401; wrong token → 403; correct token → 200; X-Forwarded-For → 403; `/health` remains public.
- **Major — per-session continue ceiling** → wired into `/internal/stop-gate/evaluate`. Before invoking the authority, the route reads `db.getContinueCount(sessionId)`; if the count ≥ CONTINUE_CEILING (constant = 2), it short-circuits to `decision: 'force_allow'` + `db.setStuck(sessionId)` + telemetry rollup + a response carrying `shortCircuit: 'continue-ceiling'`. The authority is never invoked in that case (no cost). On successful `continue` decisions, `db.incrementContinueCount(sessionId)` fires before the response, so the NEXT call hitting the ceiling force-allows. The increment is atomic via SQLite `ON CONFLICT ... RETURNING`.
- **Major — server-side post-verifier absent** → added `postVerifyEvidence(projectDir, evidence, pointer)` helper in `routes.ts`. Runs three of the five spec checks on `continue` decisions: (#1) `git cat-file -e <plan_commit_sha>` confirms the commit exists in the local object DB; (#3) `git merge-base --is-ancestor <plan> <incremental>` confirms the incremental is a descendant; (#5) at least one enumerated artifact is not `createdThisSession`. Checks #2 (ctime) and #4 (HEAD) need T0 state the hook router collects — deferred to PR3b alongside the bash router. On failure: event logged with `invalidKind: 'invalidEvidence'`, DegradationReporter emits `unjustifiedStopGate.postVerifier`, response is `{decision: 'allow', failOpen: 'invalidEvidence', postVerifyFailure}`. Fail-open, not fail-closed.
- **Minor — U1/U3 require SHAs** → `validateResponse` in `UnjustifiedStopGate.ts` now rejects `continue` with missing `plan_commit_sha` or `incremental_commit_sha` when the rule is U1 or U3 (`missingPointer` failure). U2 unchanged (plan-file-only is correct per its semantics).

Deferred for PR3b (reviewer acknowledged these are legitimate polish deferrals):
- CHECK constraints on `events.mode` / `events.decision` + `INSERT` (vs `INSERT OR REPLACE`) change. Cleanup of surprising semantics.
- Self-reference exemption pre-check — reviewer noted this is "structural-fast-path-missing, not correctness-missing" (the authority can still cite `U_META_SELF_REFERENCE` on its own). PR3b's hook router is the more natural home.

Tests: 62 passing in the PR3 surface (`UnjustifiedStopGate.test.ts`, `StopGateDb.test.ts`, `middleware.test.ts`, `middleware-internal-auth.test.ts`). Full lint + test suite clean.

**Updated verdict: blockers resolved; ready to ship.**
