# Side-Effects Review — Attention queue tone-gate wiring + guardian-pulse stable id

**Version / slug:** `attention-tone-gate-and-stable-id`
**Date:** `2026-05-06`
**Author:** `echo`
**Second-pass reviewer:** `pending — required (touches outbound-message block/allow surface)`

## Summary of the change

A user-reported bug: an instar agent ("Bob") created 7+ near-duplicate Telegram topics for the same recurring "git conflict auto-resolution" degradation event over Sat–Tue. Two layered fixes:

1. **Wire `POST /attention` through the existing `MessagingToneGate` authority.** Until now, `/attention` was the only outbound-message path that did NOT consult the gate — every other channel (telegram-reply, slack-reply, whatsapp, imessage) goes through `checkOutboundMessage`. Attention items reach the user as new Telegram topics with the title + summary as the body, so they are absolutely outbound user-facing messages and must pass the same authority. For `category=degradation|health|alert|health-alert` the route invokes the gate with `messageKind: 'health-alert'`, firing the existing B12 (jargon-laden internals), B13 (suppressed-by-self-heal), and B14 (no call-to-action) ruleset. For other categories the gate runs with `messageKind: 'reply'` — the standard ruleset still applies (B1–B7 prevent CLI/path/code leakage; B11 enforces target-style). When the gate blocks, the route returns 422 with the same shape `checkOutboundMessage` already returns elsewhere; `createAttentionItem` is not invoked, so no Telegram topic gets spawned.

2. **Skill recipe fix in `src/commands/init.ts`.** The `guardian-pulse` skill template instructed agents to POST attention items with `id = "degradation:${FEATURE}:${TIMESTAMP}"`. The timestamp made the id unique per detection, so each pulse spawned a new topic for the SAME recurring feature. Changed to `id = "degradation:${FEATURE}"` so repeated detections collapse onto the existing attention item via `createAttentionItem`'s strict-id check.

Files touched:

- `src/server/routes.ts` — `checkOutboundMessage` accepts new `messageKind` + `jargon` options; `POST /attention` invokes it; `JargonDetector` import added.
- `src/commands/init.ts` — guardian-pulse skill template id changed to stable form; explanatory note added.
- `tests/unit/attention-route-tone-gate.test.ts` — new (4 tests): pass/block/non-health/alias coverage for `/attention` POST.
- `tests/unit/guardian-pulse-skill-stable-id.test.ts` — new (1 test): regression guard against the timestamp suffix returning.

## Decision-point inventory

- `POST /attention` route handler (src/server/routes.ts) — **modify** — adds an outbound-message authority call before `createAttentionItem` so the existing tone-gate block/allow decision now applies to attention-queue topic creation.
- `checkOutboundMessage` helper (src/server/routes.ts) — **modify** — accepts `messageKind` + `jargon` options. Pass-through to existing `MessagingToneGate.review`, which is already an authority. No new decision power introduced — only a new entry point feeding the same authority.
- `installBuiltinSkills` → guardian-pulse template (src/commands/init.ts) — **modify** — changes the static instruction string the recipe gives agents. No runtime decision logic.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The gate is the existing `MessagingToneGate`; its over-block surface is unchanged. The new entry point preserves the gate's "favor false-negatives over false-positives" disposition — when a candidate is borderline, the gate passes. Specific scenarios examined:

- **A genuinely actionable health-alert with a yes/no question and no jargon.** Passes — B12/B13/B14 all require concrete failure conditions to fire.
- **A non-health attention item that contains a literal path or CLI command.** B1/B2/B5 fire as they would on any other route — this is the intended behavior, not over-block.
- **An attention item whose summary mentions a feature name that overlaps a jargon term** (e.g., title = "Cron job stuck" with `category=general`). `messageKind` defaults to `reply` for non-health categories, so the jargon signal isn't even gathered — the health-alert ruleset doesn't fire. No over-block.
- **A deliberately verbose health-alert summary including a yes/no CTA**. Passes B14; `description` text is appended to the candidate so longer descriptions don't accidentally bury the CTA below the body the gate sees.

The candidate text the gate sees is `[title, summary, description]` joined with double newlines — this matches the user-visible body Telegram will post on topic creation. No legitimate-input pathway is rejected here that would not be rejected on `telegram-reply`.

---

## 2. Under-block

**What failure modes does this still miss?**

- **An agent that posts a long descriptive title that ITSELF is the jargon vehicle.** The gate sees the title; no special-casing required.
- **An agent that bypasses `/attention` entirely and calls `TelegramAdapter.createForumTopic` directly.** This was never gated and remains ungated — out of scope for this change. The Memory Rot Gates spec proposes a `MessageDispatch` boundary refactor that would close every direct call site; this fix is a targeted band-aid for the noisiest known path until that lands.
- **A genuinely new degradation event for a previously-known feature.** The skill recipe now produces the same id, so the second detection silently no-ops — the user does NOT get notified about the recurrence. Trade-off: chosen deliberately. The user's complaint was "none of these should have been created"; quiet recurrence is preferable to a new topic per recurrence. If recurrences need re-surfacing, that's a follow-up via an explicit `lastSeenAt` / occurrence counter on `AttentionItem` and an "append to existing topic" branch — not this fix.
- **`/attention` calls that supply `category` in mixed case or with whitespace.** The regex normalization is `^(degradation|health|health-alert|alert)$/i` — exact match (case-insensitive). Trailing whitespace, plurals, or aliases like "system-health" would default to `messageKind=reply`. Acceptable: the gate still runs the standard ruleset; only the health-alert-specific rules are skipped. If callers consistently use a non-matching alias we'll see it in the tone-gate-decision log and can extend the regex.
- **The gate fail-opens on LLM error/timeout.** Inherited from the existing gate behavior — not a regression. Fail-open is the existing system-wide policy and is documented in `MessagingToneGate.ts`.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The fix is at the route-handler layer where every other outbound-message gate already sits. The `MessagingToneGate` is the single existing authority for "should this user-facing text be sent" — feeding `/attention` into it is the layer-correct move. The alternative — putting the gate inside `TelegramAdapter.createAttentionItem` — would be lower-level, but `createAttentionItem` doesn't know about `messageKind` semantics or how to format a 422 response shape, and other adapters (Slack, WhatsApp) would need the same wiring. Doing it at the route handler keeps the authority single-locus.

The skill template fix is a documentation-layer change (the skill is a markdown recipe rendered to disk; agents read it). It belongs in `src/commands/init.ts` where the rest of the skill content already lives.

The fix does NOT preempt the planned `MessageDispatch` refactor in the Memory Rot Gates spec (`docs/specs/memory-rot-gates.md`) — that refactor would route ALL outbound message paths through one module, including `createAttentionItem` and the other direct-send paths. This fix is a route-level wiring that the future refactor will subsume cleanly: `MessageDispatch` will absorb the `checkOutboundMessage` call site without behavior change.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

The brittle pieces here are:
1. The `category ∈ {degradation, health, alert, health-alert}` regex that decides whether to invoke `messageKind='health-alert'`. This is a routing hint, not a block decision — it just toggles which ruleset the gate considers. The gate is the only thing with blocking power.
2. The `JargonDetector.detectJargon` call. `JargonDetector.ts` opens with "SIGNAL ONLY. This detector produces evidence; it does not block." Already-compliant; we're using it as designed — the detector populates `signals.jargon` and the gate decides.

Both pieces feed the existing `MessagingToneGate` as a SIGNAL. No new brittle authority is introduced. The 422 response that the route returns is sourced from `MessagingToneGate.review(...).pass === false` — i.e., the existing authority's decision, not a new one.

The skill recipe fix is a string change in a template — it has no decision logic at all and trivially complies.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** The new gate call runs BEFORE `createAttentionItem`. `createAttentionItem` already has a strict-id dedup (line 2845-2847) — that dedup is preserved unchanged. The two layer correctly: gate decides if the message is appropriate for the user; dedup decides if a same-id item is already known. They do not shadow each other.
- **Double-fire:** The gate is invoked on `/attention` POST and on the four direct messaging routes (telegram-reply, slack-reply, whatsapp, imessage). An attention item that gets created produces a Telegram message via `TelegramAdapter` internals — that downstream send does NOT re-invoke the gate (no double-fire). The DegradationReporter has its own `gateHealthAlert` for its DIRECT alert path (a different path that doesn't go through `/attention`). The new route-level gate does not interact with the reporter's internal gate.
- **Races:** The gate is a single LLM call before `createAttentionItem`. `createAttentionItem` is async and uses an in-memory `Map<id, AttentionItem>`. Two concurrent `/attention` POSTs with the same id could both pass the gate and both reach `createAttentionItem`; the second hits the strict-id check and returns the existing item without creating a duplicate topic. No new race; existing race-free behavior preserved.
- **Feedback loops:** The gate's decision log writes to stderr (existing behavior). The 422 response shape is unchanged from existing gate-blocked responses, so any caller-side retry logic that already handles 422 from telegram-reply will handle it the same way from /attention. No new feedback loop.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** Agents that POST to `/attention` may now receive 422 responses they didn't receive before. The 422 body shape (`{error, rule, issue, suggestion, latencyMs}`) matches the existing telegram-reply 422 shape, so any caller that already handles telegram-reply rejects can handle attention rejects identically. The guardian-pulse recipe in particular runs in a shell script that does not check HTTP status — it will silently swallow the 422, which is the desired behavior for noisy degradation events. Agents using `mark-reported` after `/attention` will still call mark-reported regardless of the attention POST status; the event stays out of the user's face whether the attention item created or got blocked.
- **Other users of the install base:** Behavioral change visible at the user's Telegram: fewer noise topics created. This IS the requested behavior. Existing topics created before this fix shipped are NOT cleaned up — that's a separate concern (the `/done` command per topic).
- **External systems:** No new Telegram API calls. Fewer `createForumTopic` calls when the gate blocks. No change to Slack/WhatsApp/iMessage paths.
- **Persistent state:** None. `attention-items.json` schema unchanged. The skill recipe fix only changes the rendered SKILL.md content for newly-installed agents (`migrateBuiltinSkills` is non-destructive and skips files that already exist) — existing agents will continue using the timestamped id until they reinstall the skill or get a destructive migration. The tone-gate at `/attention` is the primary defense and works regardless of skill version.
- **Timing / runtime:** Adds one Haiku-class LLM call per `/attention` POST (~500ms p50, ~3s p99). The existing `checkOutboundMessage` already absorbs this latency on every other outbound path; `/attention` is not user-facing latency-critical (agents calling it are background pulses, not interactive flows).

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure code revert. No data migration. No agent state repair.

- The route changes (the gate call and the `messageKind`/`jargon` options on `checkOutboundMessage`) revert cleanly — no callers outside this PR depend on the new options.
- The skill template change reverts cleanly. New agents installed during the rollout will have the stable-id template; reverting the change does not invalidate their existing SKILL.md.
- `attention-items.json` unchanged in shape, so no DB-style migration concerns.
- During the rollback window, agents that received 422 responses they don't know how to handle would not have been retrying anyway (the recipe doesn't); rollback simply lets the previous noisy behavior return.

Estimated rollback time: hot-fix release, < 5 minutes from decision to ship.

---

## Conclusion

The change closes the one outbound-message path (`/attention`) that wasn't already gated, using the existing authority and existing rules. It is signal-vs-authority compliant: brittle bits are routing hints and signal producers, never blockers. The skill recipe fix is a one-line content change with a regression test guarding the regression. Both layered together give defense-in-depth: even if a future agent ignores the recipe and uses unstable IDs, the gate catches the message-quality failure (no CTA, jargon, suppressed-by-self-heal). And even if the gate fail-opens on an LLM error, the stable-id recipe prevents same-feature spam via `createAttentionItem`'s strict-id dedup.

Clear to ship pending second-pass review (required — touches outbound-message block/allow surface).

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (instar-dev Phase 5 — outbound-message block/allow surface)
**Independent read of the artifact: CONCUR**

The reviewer independently read `signal-vs-authority.md`, the artifact, the source diff against main, and both new test files. Findings:

- **Signal vs authority audit clean.** `JargonDetector` is documented as signal-only and consumed via `signals.jargon`. The category regex is a routing hint that toggles which ruleset the gate considers, not a blocker. The only blocking decision is the LLM-backed `MessagingToneGate.review` call.
- **Tests genuinely exercise the claimed behavior.** Pass/block/non-health/alias paths each assert the recorded `messageKind` and verify `createAttentionItem` is NOT invoked on block.
- **Rollback claim verified.** `attention-items.json` schema unchanged. Skill template change is content-only.

Two minor observations the reviewer flagged but accepted:

1. **In-memory dedup volatility across restarts.** `attentionItems` is a `Map` rebuilt on server start. Across server restarts a fresh map could let `degradation:foo` spawn a new topic. Mitigation: the file is persisted to `attention-items.json` and loaded on init (existing behavior — see `loadAttentionItems` at TelegramAdapter.ts:3001), so cross-restart dedup IS preserved. The reviewer's concern is satisfied by existing persistence; documenting here for completeness.
2. **No topicId on attention POSTs → no recent-context history fed to the gate.** Acceptable: attention items create new topics, so there is no prior thread context applicable. The health-alert ruleset (B12/B13/B14) does not depend on per-thread history.

Conclusion: clear to ship.

---

## Evidence pointers

- New tests: `tests/unit/attention-route-tone-gate.test.ts` (4 tests), `tests/unit/guardian-pulse-skill-stable-id.test.ts` (1 test). All pass.
- Existing adjacent tests verified non-regressing: `tests/unit/MessagingToneGate.test.ts` (27), `tests/unit/messaging-tone-gate-health-alerts.test.ts` (8), `tests/unit/reply-scripts.test.ts` (15), `tests/unit/server.test.ts` (16) — all pass.
- Tone-gate decision log captured in test runs confirms `messageKind=health-alert` for `category=degradation` and `messageKind=reply` for `category=general`, with the correct rule fired (B14_HEALTH_ALERT_NO_CTA) when the mocked provider blocks a no-CTA degradation candidate.
- Original user report: Telegram screenshot showing 7+ duplicate "Server degraded / git conflict auto-resolution" topics from Bob agent over 2026-05-02 → 2026-05-05, all with no CTA and Priority: LOW headers — the exact pattern this fix structurally prevents.
