# Side-Effects Review — Outbound-route request-timeout extension + HTTP 408 ambiguous-outcome client handling

**Version / slug:** `outbound-timeout-408-ambiguous`
**Date:** `2026-04-16`
**Author:** Echo
**Second-pass reviewer:** required (touches outbound messaging) — to be completed in Phase 5

## Summary of the change

Fixes the duplicate-outbound-message bug live-reproduced across Echo (topic 6655) and Inspec (topic 72), and again during diagnosis (topic 6644, msg 6674). Two coordinated changes:

1. **`src/server/middleware.ts` + `src/server/AgentServer.ts`** — `requestTimeout(defaultMs, perPathOverrides)` gains a per-path-prefix override map. Outbound messaging routes (`/telegram/reply`, `/telegram/post-update`, `/slack/reply`, `/whatsapp/send`, `/imessage/reply`, `/imessage/validate-send`) now get a 120s budget; every other route keeps the 30s default. The tone gate (LLM call) plus third-party messaging API roundtrip can routinely take 30–90s, which was racing the middleware's 30s timer and firing 408 while the handler's async send completed.

2. **`src/templates/scripts/{telegram,slack,whatsapp}-reply.sh` + `src/commands/init.ts` + `src/core/PostUpdateMigrator.ts`** — All three reply scripts now treat HTTP 408 as an **ambiguous outcome**: exit 0 with a loud stderr warning rather than exit 1 with `Failed (HTTP 408)`. This removes the false-failure signal that was triggering agent regenerate-and-retry cycles on 408 responses whose underlying send actually succeeded. PostUpdateMigrator also gains a safe overwrite: if an existing agent's `telegram-reply.sh` matches the shipped-header marker AND lacks 408 handling, it's upgraded; custom scripts (no shipped marker) are preserved.

Decision points touched: **none added**. The change is a timeout-budget adjustment plus transport-layer idempotency. The `MessagingToneGate` remains the single authority for outbound block/allow; `OutboundDedupGate` remains a pure signal.

## Decision-point inventory

- `MessagingToneGate` — pass-through (unchanged)
- `OutboundDedupGate` — pass-through (unchanged)
- `requestTimeout` middleware — modify: add per-path override map; prior single-arg callers unaffected (default parameter preserved)
- `telegram-reply.sh` / `slack-reply.sh` / `whatsapp-reply.sh` HTTP-code handling — modify: add 408 branch that exits 0 with stderr warning (existing 200/422/5xx branches unchanged)
- `PostUpdateMigrator.migrateScripts` — modify: conditional overwrite for upgraded telegram-reply.sh (gated by shipped-header marker + absent 408 branch)
- `PostUpdateMigrator.getTelegramReplyScript` — refactor: now reads from canonical template file (same pattern as `getConvergenceCheck`), eliminating a silent divergence where the migrator's inlined copy was several versions behind the file template

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface added. The 120s outbound timeout is strictly *longer* than the previous 30s — if anything, legitimate long-running sends that were being hung up at 30s will now complete. There is no scenario where a request that would have been accepted under the old timeout is now rejected.

The 408 client-side handling shifts from "exit 1, retry suggested" to "exit 0, verify before retrying." This also does not block anything — it communicates ambiguity to the agent, which then has full latitude to verify in-conversation and retry if the verify shows no delivery.

---

## 2. Under-block

**What failure modes does this still miss?**

- **Outbound requests slower than 120s** still get 408. The client now handles 408 as ambiguous rather than as hard-failure, so the agent checks before retrying. Miss: if the agent has an unreliable conversation-check tool path, it might decide to retry without verifying, re-creating the duplicate. Mitigation is in the stderr warning ("Do NOT retry blindly — check the conversation to verify delivery before resending").
- **Genuine send failure that returns 408**. If the server responded with 408 because the handler's own send actually failed (e.g., Telegram API returned 4xx after 30s wait), the client will report ambiguous. The agent checks the conversation, sees no message, retries — one extra round-trip but not a duplicate. Acceptable.
- **Duplicate-generation from other causes** (TriageOrchestrator reinject false positives, context-exhaustion respawn, agent-side retry on non-408 errors) are not addressed here. Those are separate failure modes. This change targets the specific 408-driven class that reproduced on Echo and Inspec today.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes.

- The timeout override lives in the HTTP middleware layer — the same layer that owns "how long do we wait for this class of request." Moving it into individual route handlers would fragment the knob across 5+ routes and invite drift.
- The 408 handling lives in the transport-layer client scripts — the same layer that translates HTTP semantics into shell exit codes for the agent. This is the place where "ambiguous" is a legitimate concept; the server itself cannot know the outcome differently from the HTTP status.
- The migration lives in `PostUpdateMigrator` — the established path for pushing template changes to existing agents.
- Reading the template from file (vs. inline string) in `PostUpdateMigrator.getTelegramReplyScript` follows the existing `getConvergenceCheck` pattern — same layer, same approach.

No higher-level gate exists that should own this. No lower-level primitive is being re-implemented.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] **No — this change has no block/allow surface.**

Narrative: The change is a **configuration knob** (route-specific timeout budget) plus a **transport-layer idempotency concern**. Per `signal-vs-authority.md`:

> When this principle does NOT apply: ... **Idempotency keys and dedup at the transport layer.** If a caller sends the same request twice with the same idempotency key, rejecting the second is not a judgment call — it's mechanics.

The 408-handling change is exactly this: mechanics of how a client interprets an ambiguous server response. No detector or authority is added, removed, or modified. `MessagingToneGate` remains the single outbound authority; `OutboundDedupGate`, `isJunkPayload`, and the paraphrase cross-check remain pure signals that feed it.

The requestTimeout override map is a path-prefix lookup — a data table, not a judgment call. It answers "how long is this kind of request allowed to run," which is a capacity parameter, not a block decision.

---

## 5. Interactions

**Shadowing / double-fire / races / feedback loops:**

- **Shadowing:** `requestTimeout` runs before all route handlers. The override path-match happens once, at the start of each request, before any handler executes. It does not shadow any check — it simply extends the budget for matched routes. The tone gate, dedup detector, and telegram send all run inside the same handler, already with the extended budget.
- **Double-fire:** The 408 stdout marker ("AMBIGUOUS (HTTP 408): outcome unknown") plus the stderr warning are distinct from the 200 success marker ("Sent N chars …"). No pipeline that greps either surface can misclassify one as the other.
- **Races:** The middleware's `timer`, `res.on('finish')`, `res.on('close')` behavior is unchanged — verified by the existing `request-timeout.test.ts` and `middleware-behavioral.test.ts` suites still passing. The per-path lookup is computed synchronously before the timer starts.
- **Feedback loops:** The previous bug was a feedback loop (408 → agent retry → duplicate → tone gate ambiguity on retry). This change breaks the loop by removing the 408-as-failure signal. No new feedback loop is introduced.
- **Migration overwrite:** The shipped-marker check prevents stomping custom user scripts. Verified by unit test `leaves a user-customized script untouched`. Idempotency verified by `leaves an already-migrated script untouched`.

---

## 6. External surfaces

- **Other agents:** New scaffolds (via `init.ts`) ship with the updated script. Existing agents get the fix on next `instar update` via `PostUpdateMigrator`. Custom scripts are preserved.
- **Other users of the install base:** On upgrade, every agent with an unmodified `telegram-reply.sh` receives the new version. The stderr/stdout format changes for 408 responses: new lines are distinct from the success path. Any external log-scraper that specifically filtered on `"Failed (HTTP 408)"` would miss the new 408 lines. There is no known external scraper depending on that exact string.
- **Third-party systems (Telegram/Slack/WhatsApp Bot APIs):** No behavior change. The same POSTs to the same endpoints; only the client-side reaction to server timeouts changes.
- **Persistent state:** No state changes. No migration of databases or ledgers. The PostUpdateMigrator overwrite writes a single file per agent on upgrade.
- **Timing/runtime conditions:** The 120s outbound budget is a best-effort fit — true p99 is hard to measure across the full install base. If a future agent configuration produces routinely >120s responses (e.g., very slow Anthropic API path), we may need to revisit. Tradeoff chosen: tolerate occasional 408s (now handled correctly by the client) over adopting a global unbounded timeout.

---

## 7. Rollback cost

- **Hot-fix release:** Pure code change. Revert both commits and ship as a patch. No persistent state, no user-visible regression during rollback window (agents just go back to occasionally double-sending, which is the pre-fix behavior, survivable).
- **Migration reversal:** PostUpdateMigrator rolls scripts forward only. If we need to roll back the scripts on a live agent, the user can manually restore the old version or re-run `npx instar update` after we revert the migrator's marker logic. Not urgent — the new scripts are strictly more robust than the old ones.
- **No data migration.** No schema changes.

---

## Conclusion

Two targeted, narrowly scoped changes — one at the server-middleware layer, one at the transport-client layer — that together break the 408-driven duplicate-send feedback loop observed today across multiple agents. No new decision points, no new authorities, no new detectors. The signal-vs-authority architecture is preserved; this is mechanics.

The change is clear to ship pending second-pass review (Phase 5).

**Tests added: 27** (21 new, 6 migration — all green). All adjacent regression tests (middleware, request-timeout, messaging-tone-gate, outbound-dedup-gate, feedback-routes, migration-parity) stay green. `tsc --noEmit` clean.

**Evidence pointers**
- Server log showing 408 race: `/Users/justin/Documents/Projects/monroe-workspace/logs/server.log:2225` (`Cannot set headers after they are sent to the client` at 16:55:42.807 coincident with successful Telegram delivery of msg 1280 at 16:55:42.805).
- Claude session JSONL showing the retry path: `/Users/justin/.claude/projects/-Users-justin--instar-agents-echo/42479d7f-a0ad-4b45-bb33-3d18fa981a8b.jsonl`, lines 267–277: first attempt at 17:19:14 returns HTTP 408, Claude regenerates, second attempt blocked by tone gate, third attempt succeeds — message already present on Telegram as msg 6669 from the first attempt, duplicated by the third as msg 6670.
- 3-gram Jaccard between the two duplicate replies in Echo's topic: 0.398 (below the 0.7 `OutboundDedupGate` threshold, far below the 0.9 `B9` authority threshold). Detector could never have caught this — and should not, because the responses are not verbatim duplicates.

---

## Second-pass review (required)

**Reviewer:** instar-dev-independent-reviewer
**Independent read of the artifact: concern (resolved) → concur**

The independent reviewer raised four actionable concerns; all addressed in-place before this artifact was finalized:

1. **Slack and WhatsApp scripts were not covered by `PostUpdateMigrator.migrateScripts`.** Original migration only handled `telegram-reply.sh`, leaving Slack and WhatsApp agents stuck with the old exit-1-on-408 scripts. **Resolved:** added `migrateReplyScriptTo408()` helper and invoked it for both `slack-reply.sh` (in `.claude/scripts/`) and `whatsapp-reply.sh` (in `.instar/scripts/`), gated by file-presence + shipped-header marker. Six parallel migration tests added (`slack-reply.sh 408 migration`, `whatsapp-reply.sh 408 migration`) — all green.

2. **`init.ts` inlined scripts were not covered by `reply-scripts.test.ts`.** The test harness ran the canonical `src/templates/scripts/*.sh` files, not the 70-line inlined bash strings in `installTelegramRelay`/`installWhatsAppRelay`. **Resolved:** refactored both installers to use a new `loadRelayTemplate(filename, port)` helper that reads from `src/templates/scripts/`. This eliminates the divergence class entirely — scaffold-time and migration-time paths now both deliver the same canonical script. Structural tests added in `AgentServer-outbound-timeout.test.ts` to catch future reversion to inlined bash.

3. **No structural test that the 6 override paths in `AgentServer.ts` stayed wired.** A typo or merge-drop would have shipped silently. **Resolved:** added `AgentServer-outbound-timeout.test.ts` with one assertion per required prefix, plus a value-range check that the override is materially larger than the default (≥90s), plus a regression guard that the global default still reaches `requestTimeout`'s first arg.

4. **Dead code `startsWith(prefix + '?')` in the path matcher.** Express's `req.path` never includes the query string, so that branch was unreachable. **Resolved:** dropped the `?` clause, kept only `=== prefix` and `startsWith(prefix + '/')`. The `/foo` → not-matching-`/foo-bar` guarantee is preserved by the `/` suffix requirement.

5. **Shipped-marker false-positive on custom scripts that happen to include the verbatim 76-char header sentence.** Flagged for visibility, not resolution — collision requires deliberate copy. Accepted risk.

Final test count across the change surface: **171 tests green** (42 new/extended — middleware/requestTimeout overrides, reply-scripts 408/422/5xx/200 contract, PostUpdateMigrator for all three scripts, AgentServer structural guards). `tsc --noEmit` clean.

**Concur with the review's final state.** Change is clear to ship.
