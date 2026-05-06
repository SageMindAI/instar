---
title: "Wire /attention through the existing tone-gate authority + stable-id skill recipe"
slug: "attention-tone-gate-and-stable-id"
author: "echo"
date: "2026-05-06"
status: "approved"
review-iterations: 1
review-convergence: "converged"
review-completed-at: "2026-05-06T15:20:00Z"
approved: true
approved-by: justin
approved-date: 2026-05-06
approval-context: "Telegram topic 8937 — Justin reported an instar agent (Bob) had spammed 7+ duplicate Telegram topics for one recurring 'git conflict auto-resolution' degradation event over 2026-05-02→05-05, said 'NONE of these should have been created. They are noise, and none of the messages in the topics are helpful to the user at all.' On clarifying scope I proposed wiring /attention through the existing tone gate + a stable-id skill recipe fix; Justin reinforced the three requirements (must require user attention/action, must contain everything needed to act, must be plain English) and replied 'please proceed' (2026-05-06 14:55 PT) — explicit approval to ship the change."
---

# Wire /attention through the existing tone-gate authority + stable-id skill recipe

## 1. Problem

A live instar agent ("Bob") created seven near-duplicate Telegram topics in four days for one recurring "git conflict auto-resolution disabled" degradation event. Each occurrence took the form `Server degraded | Priority: LOW Git conflicts may not auto-r...` — no call to action, jargon-laden category header, no explanation of impact in user-readable terms. The user said: "NONE of these should have been created. They are noise, and none of the messages in the topics are helpful to the user at all."

Two structural causes:

1. **`POST /attention` is the one outbound-message path NOT consulted by the existing `MessagingToneGate`.** Every other channel — `telegram-reply`, `slack-reply`, `whatsapp-send`, `imessage-send` — runs candidates through `checkOutboundMessage` before delivery. `/attention` does not, so attention items reach the user's Telegram as new topics without any quality check. The existing B12 (`HEALTH_ALERT_INTERNALS`), B13 (`HEALTH_ALERT_SUPPRESSED_BY_HEAL`), and B14 (`HEALTH_ALERT_NO_CTA`) rules are perfectly suited to what Justin is asking for — they encode "must contain user-readable info," "must require action (not silently self-healed)," and "must end with a yes/no the user can answer in one word." But they only fire when `messageKind === 'health-alert'`, and `/attention` never invokes the gate at all.

2. **The `guardian-pulse` skill template instructs agents to use `id = "degradation:${FEATURE}:${TIMESTAMP}"` when posting to `/attention`.** The timestamp varies per detection, so even with a stable `feature`, repeated detections of the same feature produce distinct IDs and bypass the existing strict-id dedup in `createAttentionItem`. Each pulse spawns a new topic.

## 2. Scope

In scope:

- **§3.** Extend `checkOutboundMessage` to accept an optional `messageKind` and an optional `jargon` flag (no behavior change for existing callers).
- **§4.** Wire `POST /attention` through `checkOutboundMessage`. For health-class categories (`degradation`, `health`, `health-alert`, `alert`), invoke with `messageKind: 'health-alert'` and populate the jargon signal so B12/B13/B14 can fire. For other categories, invoke with `messageKind: 'reply'` so the standard ruleset (B1–B7, B11) still applies.
- **§5.** Fix the `guardian-pulse` skill template to use a stable id `degradation:${FEATURE}` with no timestamp suffix. Add an explanatory note about WHY the id omits the timestamp so future maintainers don't accidentally reintroduce it.
- **§6.** Tests: a focused unit test of `POST /attention` exercising pass / block / non-health / alias paths, plus a regression test on the rendered skill template content.

Out of scope (explicitly):

- The broader `MessageDispatch` boundary refactor proposed in `docs/specs/memory-rot-gates.md`. That refactor will route every outbound path through one module — including `createAttentionItem`'s direct Telegram send and the other ungated paths. This change does NOT preempt that refactor: the new `checkOutboundMessage` call site at the route handler is exactly where `MessageDispatch.send()` would later sit when the refactor lands.
- A "fuzzy feature dedup" for `/attention` (matching on `(category, feature)` when callers use unstable IDs). Defer until we see whether the tone-gate authority alone closes the visible spam — the user's primary complaint is message quality, not topic count, and the tone gate addresses both at once.
- Cleanup of Bob's existing seven topics. Those persist on the user's Telegram; cheapest cleanup is `/done` per topic from Bob's side. Out of scope for this PR.
- Self-heal signal lookup at the route handler. The existing `DegradationReporter.gateHealthAlert` populates `selfHeal` from its own internal state; surfacing that to `/attention` callers requires either a new lookup API or pushing the signal into the POST body as a new optional field. Defer until we have a concrete need — B14 (no CTA) alone catches Bob's observed spam.

## 3. Change to `checkOutboundMessage`

Add two optional fields to the options bag:

- `messageKind?: 'reply' | 'health-alert' | 'unknown'` — passed through to `MessagingToneGate.review` unchanged. Defaults to undefined; the gate already defaults to `'reply'`.
- `jargon?: boolean` — when true, the helper invokes `detectJargon(text)` and attaches the result as `signals.jargon`. This matches the existing pattern in `DegradationReporter.gateHealthAlert`. The default is false to keep prompts focused for non-health calls.

Both fields are additive. All existing call sites continue to work without modification.

## 4. Wiring at `POST /attention`

The route currently delegates straight to `ctx.telegram.createAttentionItem`. Insert a `checkOutboundMessage` call between input validation and `createAttentionItem`:

- Build the candidate string from `[title, summary, description].filter(present).join('\n\n')` — this matches the user-visible body that `createAttentionItem` will format into the topic's first message.
- Determine `isHealthAlert` via case-insensitive exact match on category against `degradation|health|health-alert|alert`.
- Call `checkOutboundMessage(candidate, 'telegram', res, { messageKind: isHealthAlert ? 'health-alert' : 'reply', jargon: isHealthAlert })`.
- If the gate blocks, return immediately — `checkOutboundMessage` already wrote the 422 response. `createAttentionItem` is not invoked, so no topic gets spawned and no item gets persisted.

The 422 response shape is identical to the one telegram-reply / slack-reply / etc. already return; any caller that already handles tone-gate-blocked responses will handle this transparently.

## 5. Skill recipe fix

In `src/commands/init.ts` within the `guardian-pulse` skill template, change the POST body from `{"id": "degradation:${FEATURE}:${TIMESTAMP}", ...}` to `{"id": "degradation:${FEATURE}", ...}`. Add a short paragraph below the example explaining that the id deliberately omits the timestamp so repeated detections collapse onto the existing item.

`migrateBuiltinSkills` is non-destructive — it only writes `SKILL.md` files that don't already exist. So agents installed before this change will keep the timestamped id until they reinstall the skill or accept a destructive migration. The tone gate at `/attention` is the primary defense and works regardless of skill version.

## 6. Tests

- `tests/unit/attention-route-tone-gate.test.ts` — four cases:
  1. category=degradation + valid candidate → 201, gate invoked with `messageKind='health-alert'`, jargon signal populated.
  2. category=degradation + no-CTA candidate → 422 with `rule=B14_HEALTH_ALERT_NO_CTA`, `createAttentionItem` not invoked.
  3. category=general → gate invoked with `messageKind='reply'`, no jargon signal.
  4. category=health → treated as health-alert (alias coverage).
- `tests/unit/guardian-pulse-skill-stable-id.test.ts` — runs `installBuiltinSkills` to a temp dir, reads the rendered `guardian-pulse/SKILL.md`, asserts the timestamp suffix is gone and the stable form is present. This guards against accidental reintroduction of the timestamp.

## 7. Signal vs authority compliance

This change is fully compliant with `docs/signal-vs-authority.md`:

- The category regex is a routing hint that toggles which ruleset the existing authority considers. It is not a blocker — the gate decides.
- `JargonDetector.detectJargon` is documented signal-only and is consumed via `signals.jargon`, never used as an independent block.
- The only blocking decision in the new code path is `MessagingToneGate.review` — the existing single authority for outbound user-facing messages.
- No new authority is introduced. No brittle logic is given block power.

## 8. Rollback

Pure code revert. No data migration. `attention-items.json` schema unchanged. Existing skill installations continue to work whether the recipe is the old or new form. The tone gate fail-opens on LLM error, so production never sees a hard outage from this change.

## 9. Convergence note

Single-iteration internal convergence — proportional to the change size (~30 lines of code, defensive extension of an already-converged authority). The independent second-pass review by a separate reviewer agent (recorded in `upgrades/side-effects/attention-tone-gate-and-stable-id.md` § "Second-pass review") concurred without raising blocking concerns. Two minor observations (in-memory dedup volatility across restarts; no per-thread context fed to gate) were inspected and accepted: the first is mitigated by existing `attention-items.json` persistence, the second is correct-by-design (attention items create new topics, no prior thread context applies).
