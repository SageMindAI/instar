# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

`POST /internal/telegram-forward` no longer reports the backward-compat
`TelegramLifeline.versionMissing` event into the feedback pipeline as a
`[DEGRADATION]` signal. The condition (an upgraded but un-restarted lifeline
forwarding a Telegram message without the Stage-B `lifelineVersion` field) is
expected, accepted, and documented behaviour — emitting it as a critical
degradation was producing noisy regressions in cluster
`cmo7wswhj0000mgmdbw4j7dyd` every time any pre-Stage-B lifeline forwarded a
message.

The forward itself still succeeds via the documented backward-compat path;
the response, the inbound-message log, and the version-handshake logic for
lifelines that *do* send `lifelineVersion` are all unchanged. On the first
occurrence per server process, a one-shot `console.info` is emitted so the
operator-side observability signal is preserved without per-request log
spam.

The systemic work to give `DegradationReporter` a typed severity / category
field (so callers can mark events as ERROR vs COMPAT_SIGNAL at the reporter
layer rather than the call site) remains tracked under PROP-543 and is
deliberately out of scope for this release.

## What to Tell Your User

- **Quieter feedback signal**: I won't keep logging a critical-looking
  message every time my lifeline forwards a Telegram note before I've had a
  chance to restart it. The forward still works the same way; only the
  noisy critical report goes away.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Quieter pre-Stage-B lifeline forwards | Automatic on upgrade |

## Evidence

Reproduction (before fix):

1. Run a lifeline at v0.28.67 or later, then upgrade the server-side package
   without restarting the lifeline daemon.
2. Send a Telegram message that the lifeline forwards via
   `POST /internal/telegram-forward`.
3. The handler accepts the forward and emits a
   `[DEGRADATION] TelegramLifeline.versionMissing: …` feedback event,
   classified as critical by the Portal cluster intake.

After fix:

1. Same setup; same forward; same successful response.
2. On the first forward per server process, a single
   `[telegram-forward] Accepted pre-Stage-B lifeline forward …`
   `console.info` is emitted; subsequent forwards on the same process emit
   nothing.
3. No `TelegramLifeline.versionMissing` feedback events are submitted, so
   cluster `cmo7wswhj0000mgmdbw4j7dyd` does not auto-reopen on every
   forward.

`grep -rn versionMissing src/ tests/ test/ __tests__/` shows the symbol
appears only in `routes.ts` (the one-shot guard and the comment explaining
it). No test changed because the call site has no existing test coverage of
the reporter side-effect.
