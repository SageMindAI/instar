# Upgrade Guide — vNEXT (TelegramLifeline sends auth on /internal/* calls)

<!-- bump: patch -->

## What Changed

Fixes a critical regression introduced in 0.28.53: inbound Telegram messages from users were silently dropped on every agent after update. The 0.28.53 release tightened `/internal/*` routes to require bearer auth (previously localhost-only), but the matching client-side change in `TelegramLifeline` was missed — the lifeline continued to POST to `/internal/telegram-forward` and `/internal/telegram-callback` with only a `Content-Type` header, so every forward attempt returned 401 and the user's message never reached the session.

The fix is surgical: both internal fetches now include `Authorization: Bearer <authToken>` when the token is configured. No other behavior changes. The auth header is backwards-compatible — server versions that don't require auth on `/internal/*` simply ignore it.

**Affected surfaces:**
- `forwardToServer()` — inbound user messages from Telegram topics to their bound session
- `handleCallbackQuery()` — inline-button callbacks from dashboard-link messages

**Scope:** Every agent on v0.28.53 where inbound Telegram messages stopped reaching the session. Outbound (agent → user) was never affected because it goes direct to the Telegram Bot API, not through `/internal/*`.

## What to Tell Your User

Telegram messages from you to me were getting silently dropped on v0.28.53 — a security tightening landed without its matching client-side update, so every inbound message hit a 401 and never reached the session. This patch wires the auth header through the lifeline so the forward actually lands. After updating, send any new topic a quick test message to confirm the round-trip works.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| TelegramLifeline authenticates `/internal/*` forwards | automatic on update |

## Evidence

**Reproduction (pre-fix, v0.28.53):** Created a new Telegram topic, sent a message, observed the Telegram bot reply "Server is restarting — please try again in a moment." instead of the session responding. Server log showed the forward attempt hitting `/internal/telegram-forward` and returning 401 because no `Authorization` header was present. The middleware in `src/server/middleware.ts` requires bearer auth on `/internal/*` (introduced in commit `42cb9ee` as part of PR3's security hardening), but `src/lifeline/TelegramLifeline.ts` was building the fetch with only `{ 'Content-Type': 'application/json' }`.

**Post-fix behavior:** Both fetches now compute headers as `{ 'Content-Type': 'application/json', 'Authorization': 'Bearer <token>' }` when `projectConfig.authToken` is set. Request lands, middleware verifies the token, `/internal/telegram-forward` dispatches the message to the bound session as designed. Verified in the shadow-install on the echo agent — after patching `node_modules/instar/dist/lifeline/TelegramLifeline.js` with the same edit and restarting, inbound messages began reaching sessions again.

Unit tests are not in scope for this patch per the user's explicit "skip testing — I know it's working" instruction during an urgent-deploy request. A regression test asserting that `forwardToServer` includes the bearer header is tracked as a follow-up.

## Deployment Notes

- No operator action required on update. The fix activates on next server start after upgrade.
- Agents with `authToken` set (the standard configuration) will immediately recover inbound Telegram routing.
- Agents without an `authToken` configured are unaffected — they were already falling through on localhost-only semantics from older middleware.

## Rollback

Downgrading to 0.28.53 reintroduces the bug — inbound Telegram messages will again be dropped with 401. There is no state to migrate; the fix is purely client-side header construction.
